import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { ensureGitHooks } from './git/ensureGitHooks.ts';
import {
  ensureCacheDir,
  getCheckoutEventPath,
  isCheckoutLockActive,
  readGitCheckoutEvent,
} from './git/gitCheckoutSignal.ts';
import { readCompositeGitHeadState, REPO_ROOT_DIR } from './git/gitHeadState.ts';

const FALLBACK_POLL_MS = 500;
const SETTLE_DELAY_MS = 1000;
const SETTLE_MAX_WAIT_MS = 3000;
const FORCE_KILL_TIMEOUT_MS = 2500;

const extraArgs = process.argv.slice(2);
const isWindows = process.platform === 'win32';

let activeChild: ChildProcess | null = null;
let childExitWaiter: Promise<void> | null = null;
let isShuttingDown = false;
let isRestarting = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleStartAt = 0;
let baselineSignature = readCompositeGitHeadState(REPO_ROOT_DIR).signature;
let baselineHeadSha = readHeadSha();
let lastSeenEventId = readGitCheckoutEvent(REPO_ROOT_DIR)?.eventId ?? '';

function readHeadSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function didTauriChangeSince(prevSha: string, nextSha: string): boolean {
  if (!prevSha || !nextSha || prevSha === nextSha) return false;
  try {
    execFileSync('git', ['diff', '--quiet', prevSha, nextSha, '--', 'src-tauri/'], {
      cwd: REPO_ROOT_DIR,
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

function resolveTauriCommand(): { command: string; args: string[] } {
  const localBin = resolve(REPO_ROOT_DIR, 'node_modules/.bin', isWindows ? 'tauri.cmd' : 'tauri');
  if (fs.existsSync(localBin)) {
    return { command: localBin, args: ['dev', ...extraArgs] };
  }
  return { command: isWindows ? 'pnpm.cmd' : 'pnpm', args: ['exec', 'tauri', 'dev', ...extraArgs] };
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited
    }
  }
}

async function stopActiveChild(): Promise<void> {
  const child = activeChild;
  const waiter = childExitWaiter;
  if (!child || !waiter) return;

  killProcessTree(child, 'SIGTERM');
  const forceTimer = setTimeout(() => {
    killProcessTree(child, 'SIGKILL');
  }, FORCE_KILL_TIMEOUT_MS);
  forceTimer.unref?.();

  await waiter;
  clearTimeout(forceTimer);
}

function spawnTauriDev(): void {
  if (isShuttingDown) return;

  const { command, args } = resolveTauriCommand();
  const child = spawn(command, args, {
    cwd: REPO_ROOT_DIR,
    stdio: 'inherit',
    detached: !isWindows,
    env: {
      ...process.env,
      RC_TAURI_WATCH_ACTIVE: '1',
    },
  });

  activeChild = child;
  childExitWaiter = new Promise<void>((resolveExit) => {
    child.once('exit', (code, signal) => {
      if (activeChild === child) {
        activeChild = null;
        childExitWaiter = null;
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
        `\n[tauri-dev-watch] tauri dev exited with code ${code ?? 'null'}. Waiting for next Git checkout to retry...`
      );
    });
  });
}

async function restartForTauriChange(previousSig: string | null, nextSig: string): Promise<void> {
  if (isShuttingDown || isRestarting) return;
  isRestarting = true;
  baselineSignature = nextSig;
  baselineHeadSha = readHeadSha();

  console.log(
    `\n[tauri-dev-watch] Native src-tauri/ change detected:\n  prev: ${previousSig ?? 'none'}\n  next: ${nextSig}\n-> Restarting Tauri dev shell & Vite servers...`
  );

  try {
    await stopActiveChild();
  } finally {
    isRestarting = false;
  }

  if (!isShuttingDown) {
    spawnTauriDev();
  }
}

function scheduleTauriRestart(previousSig: string | null): void {
  if (isShuttingDown || isRestarting) return;

  if (!settleTimer) {
    settleStartAt = Date.now();
  } else {
    clearTimeout(settleTimer);
  }

  const elapsed = Date.now() - settleStartAt;
  const remainingCap = Math.max(0, SETTLE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(SETTLE_DELAY_MS, remainingCap);

  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (isShuttingDown || isRestarting) return;

    if (isCheckoutLockActive(REPO_ROOT_DIR) && Date.now() - settleStartAt < SETTLE_MAX_WAIT_MS) {
      scheduleTauriRestart(previousSig);
      return;
    }

    const settled = readCompositeGitHeadState(REPO_ROOT_DIR);
    if (!settled.signature) return;
    void restartForTauriChange(previousSig, settled.signature);
  }, delay);
  settleTimer.unref?.();
}

function checkCheckoutSignals(): void {
  if (isShuttingDown || isRestarting) return;

  const event = readGitCheckoutEvent(REPO_ROOT_DIR);
  if (event && event.eventId !== lastSeenEventId) {
    lastSeenEventId = event.eventId;
    const prevSig = baselineSignature;
    const currentSig = readCompositeGitHeadState(REPO_ROOT_DIR).signature;
    if (event.tauriChanged) {
      scheduleTauriRestart(prevSig);
    } else {
      baselineSignature = currentSig ?? baselineSignature;
      baselineHeadSha = event.nextHead || readHeadSha();
      console.log(
        `\n[tauri-dev-watch] Frontend-only checkout (${event.hook}); keeping Tauri shell alive while Vite servers restart.`
      );
    }
    return;
  }

  const current = readCompositeGitHeadState(REPO_ROOT_DIR);
  if (current.locked || !current.signature) return;

  if (baselineSignature === null) {
    baselineSignature = current.signature;
    baselineHeadSha = readHeadSha();
    return;
  }

  if (current.signature !== baselineSignature && !settleTimer) {
    const nextSha = readHeadSha();
    const tauriChanged = didTauriChangeSince(baselineHeadSha, nextSha);
    if (tauriChanged) {
      scheduleTauriRestart(baselineSignature);
    } else {
      baselineSignature = current.signature;
      baselineHeadSha = nextSha;
      console.log(
        '\n[tauri-dev-watch] Frontend-only HEAD change detected; keeping Tauri shell alive while Vite servers restart.'
      );
    }
  }
}

const cacheDir = ensureCacheDir(REPO_ROOT_DIR);
const eventFilePath = getCheckoutEventPath(REPO_ROOT_DIR);
let cacheWatcher: fs.FSWatcher | null = null;
try {
  cacheWatcher = fs.watch(cacheDir, (_eventType, filename) => {
    if (!filename || filename === 'git-checkout-event.json' || eventFilePath.endsWith(filename)) {
      checkCheckoutSignals();
    }
  });
} catch {
  // Fallback poll remains active
}

const pollTimer = setInterval(checkCheckoutSignals, FALLBACK_POLL_MS);
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
  stopActiveChild()
    .catch(() => {})
    .finally(() => {
      process.exit(exitCode);
    });
}

process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));

ensureGitHooks(REPO_ROOT_DIR);
console.log(
  `[tauri-dev-watch] Supervising tauri dev (Git HEAD: ${baselineSignature ?? 'unknown'})...`
);
spawnTauriDev();
