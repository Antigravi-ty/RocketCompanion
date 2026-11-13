import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { readCompositeGitHeadState, REPO_ROOT_DIR } from './git/gitHeadState.ts';

const POLL_INTERVAL_MS = 200;
const SETTLE_DELAY_MS = 150;
const FORCE_KILL_TIMEOUT_MS = 2500;

const extraArgs = process.argv.slice(2);
const isWindows = process.platform === 'win32';

let activeChild: ChildProcess | null = null;
let childExitWaiter: Promise<void> | null = null;
let isShuttingDown = false;
let isRestarting = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let baselineSignature = readCompositeGitHeadState(REPO_ROOT_DIR).signature;

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
      RC_DISABLE_VITE_GIT_RESTART: '1',
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
        `\n[tauri-dev-watch] tauri dev exited with code ${code ?? 'null'}. Waiting for next Git HEAD switch to retry...`
      );
    });
  });
}

async function restartForGitHeadChange(previousSig: string | null, nextSig: string): Promise<void> {
  if (isShuttingDown || isRestarting) return;
  isRestarting = true;
  baselineSignature = nextSig;

  console.log(
    `\n[tauri-dev-watch] Git HEAD switch detected:\n  prev: ${previousSig ?? 'none'}\n  next: ${nextSig}\n-> Restarting Tauri dev shell & Vite servers...`
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

function cleanupAndExit(exitCode: number): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearInterval(pollTimer);
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  stopActiveChild()
    .catch(() => {})
    .finally(() => {
      process.exit(exitCode);
    });
}

const pollTimer = setInterval(() => {
  if (isShuttingDown || isRestarting) return;
  const current = readCompositeGitHeadState(REPO_ROOT_DIR);
  if (current.locked || !current.signature) return;

  if (baselineSignature === null) {
    baselineSignature = current.signature;
    return;
  }

  if (current.signature !== baselineSignature && !settleTimer) {
    const previousSignature = baselineSignature;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (isShuttingDown || isRestarting) return;
      const settled = readCompositeGitHeadState(REPO_ROOT_DIR);
      if (settled.locked || !settled.signature || settled.signature === previousSignature) {
        return;
      }
      void restartForGitHeadChange(previousSignature, settled.signature);
    }, SETTLE_DELAY_MS);
    settleTimer.unref?.();
  }
}, POLL_INTERVAL_MS);

pollTimer.unref?.();

process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));

console.log(
  `[tauri-dev-watch] Supervising tauri dev (Git HEAD: ${baselineSignature ?? 'unknown'})...`
);
spawnTauriDev();
