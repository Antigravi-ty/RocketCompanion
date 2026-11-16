import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { ensureGitHooks } from './git/ensureGitHooks.ts';
import {
  ensureCacheDir,
  getCheckoutEventPath,
  isCheckoutLockActive,
  readGitCheckoutEvent,
  type GitCheckoutEvent,
} from './git/gitCheckoutSignal.ts';
import { readCompositeGitHeadState, REPO_ROOT_DIR } from './git/gitHeadState.ts';

const SETTLE_DELAY_MS = 1000;
const SETTLE_MAX_WAIT_MS = 3000;
const FALLBACK_POLL_MS = 500;
const FORCE_KILL_TIMEOUT_MS = 2500;

const workerScriptPath = resolve(REPO_ROOT_DIR, 'scripts/devWorker.ts');
const isTauriWatchActive = process.env.RC_TAURI_WATCH_ACTIVE === '1';

let activeWorker: ChildProcess | null = null;
let workerExitWaiter: Promise<void> | null = null;
let isShuttingDown = false;
let isRestarting = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleStartAt = 0;
let pendingReason = '';
let pendingTauriChanged = false;
let baselineSignature = readCompositeGitHeadState(REPO_ROOT_DIR).signature;
let lastSeenEventId = readGitCheckoutEvent(REPO_ROOT_DIR)?.eventId ?? '';

function notifyWorkerSettling(): void {
  if (activeWorker?.connected) {
    try {
      activeWorker.send({ type: 'rc:checkout-settling' });
    } catch {
      // Ignore IPC send errors
    }
  }
}

async function stopActiveWorker(): Promise<void> {
  const child = activeWorker;
  const waiter = workerExitWaiter;
  if (!child || !waiter) return;

  try {
    child.kill('SIGTERM');
  } catch {
    // Process already exited
  }

  const forceTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Process already exited
    }
  }, FORCE_KILL_TIMEOUT_MS);
  forceTimer.unref?.();

  await waiter;
  clearTimeout(forceTimer);
}

function spawnWorker(): void {
  if (isShuttingDown) return;

  const child = spawn(process.execPath, ['--experimental-strip-types', workerScriptPath], {
    cwd: REPO_ROOT_DIR,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      RC_DEV_SUPERVISOR: '1',
    },
  });

  child.on('message', (msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'rc:checkout-done') {
      const ev = (msg as { event?: GitCheckoutEvent | null }).event ?? null;
      if (ev?.eventId) {
        lastSeenEventId = ev.eventId;
      }
      scheduleRestart('post-checkout-http', Boolean(ev?.tauriChanged));
    }
  });

  activeWorker = child;
  workerExitWaiter = new Promise<void>((resolveExit) => {
    child.once('exit', (code, signal) => {
      if (activeWorker === child) {
        activeWorker = null;
        workerExitWaiter = null;
      }
      resolveExit();

      if (isShuttingDown || isRestarting) {
        return;
      }

      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') {
        cleanupAndExit(0);
        return;
      }

      console.error(
        `\n[dev-supervisor] Worker exited unexpectedly (code ${code ?? 'null'}). Waiting for next Git checkout to retry...`
      );
    });
  });
}

async function restartWorker(reason: string): Promise<void> {
  if (isShuttingDown || isRestarting) return;
  isRestarting = true;

  const nextSig = readCompositeGitHeadState(REPO_ROOT_DIR).signature;
  console.log(
    `\n[dev-supervisor] Restarting 4-port Vite worker (${reason}, HEAD: ${nextSig ?? 'unknown'})...`
  );
  baselineSignature = nextSig;

  try {
    await stopActiveWorker();
  } finally {
    isRestarting = false;
  }

  if (!isShuttingDown) {
    spawnWorker();
  }
}

function scheduleRestart(reason: string, tauriChanged: boolean): void {
  if (isShuttingDown || isRestarting) return;

  if (!settleTimer) {
    settleStartAt = Date.now();
  } else {
    clearTimeout(settleTimer);
  }

  pendingReason = reason;
  pendingTauriChanged = pendingTauriChanged || tauriChanged;
  notifyWorkerSettling();

  if (isTauriWatchActive && pendingTauriChanged) {
    settleTimer = null;
    console.log(
      `\n[dev-supervisor] Native src-tauri/ changes detected (${reason}); deferring full restart to tauri-dev-watch.`
    );
    return;
  }

  const elapsed = Date.now() - settleStartAt;
  const remainingCap = Math.max(0, SETTLE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(SETTLE_DELAY_MS, remainingCap);

  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (isShuttingDown || isRestarting) return;

    if (isCheckoutLockActive(REPO_ROOT_DIR) && Date.now() - settleStartAt < SETTLE_MAX_WAIT_MS) {
      scheduleRestart(pendingReason, pendingTauriChanged);
      return;
    }

    const finalReason = pendingReason;
    pendingReason = '';
    pendingTauriChanged = false;
    void restartWorker(finalReason);
  }, delay);
  settleTimer.unref?.();
}

function checkSignals(): void {
  if (isShuttingDown || isRestarting) return;

  const event = readGitCheckoutEvent(REPO_ROOT_DIR);
  if (event && event.eventId !== lastSeenEventId) {
    lastSeenEventId = event.eventId;
    scheduleRestart(`hook:${event.hook}`, event.tauriChanged);
    return;
  }

  const current = readCompositeGitHeadState(REPO_ROOT_DIR);
  if (current.locked) {
    notifyWorkerSettling();
    return;
  }
  if (!current.signature) return;

  if (baselineSignature === null) {
    baselineSignature = current.signature;
    return;
  }

  if (current.signature !== baselineSignature && !settleTimer) {
    scheduleRestart('head-state-change', false);
  }
}

const cacheDir = ensureCacheDir(REPO_ROOT_DIR);
const eventFilePath = getCheckoutEventPath(REPO_ROOT_DIR);
let cacheWatcher: fs.FSWatcher | null = null;
try {
  cacheWatcher = fs.watch(cacheDir, (_eventType, filename) => {
    if (!filename || filename === 'git-checkout-event.json' || eventFilePath.endsWith(filename)) {
      checkSignals();
    }
  });
} catch {
  // Fallback poll remains active
}

const pollTimer = setInterval(checkSignals, FALLBACK_POLL_MS);
pollTimer.unref?.();

function cleanupAndExit(exitCode: number): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearInterval(pollTimer);
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  try {
    cacheWatcher?.close();
  } catch {
    // Ignore watcher close errors
  }
  stopActiveWorker()
    .catch(() => {})
    .finally(() => {
      process.exit(exitCode);
    });
}

process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));

ensureGitHooks(REPO_ROOT_DIR);
spawnWorker();
