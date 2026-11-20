/**
 * scripts/env/reproPreflight.mjs
 *
 * Shared preflight & safe cleanup helpers for Headless Chrome E2E repro scripts
 * (repro:dev-broadcast-v2, repro:dev-broadcast-v3, repro:dev-extra-routes).
 *
 * - Verifies `public/` submodule is initialized (prevents CameraMicrokernel hash mismatch & 60s boot timeout).
 * - Verifies Chrome binary exists.
 * - Resolves or auto-generates the 3v3 `.rcreplay` fixture.
 * - Provides safe Chrome/userDataDir cleanup that never masks the real test error with ENOTEMPTY.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');
const DEFAULT_FIXTURE_PATH = '/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay';

export function resolveChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/local/lib/chrome-headless-shell/chrome-headless-shell',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function isPublicSubmoduleReady() {
  const publicDir = path.join(ROOT_DIR, 'public');
  if (!fs.existsSync(publicDir)) return false;
  try {
    const entries = fs.readdirSync(publicDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export function resolveOrGenerateReplayFixture(label = 'Repro') {
  const candidates = [
    process.env.RC_REPLAY_PATH,
    DEFAULT_FIXTURE_PATH,
    '/workspace/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
    path.resolve(ROOT_DIR, '../rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  console.log(`[${label}] 3v3 .rcreplay fixture not found; generating synthetic fixture...`);
  const generatorPath = path.join(ROOT_DIR, 'scripts/env/generateReplayFixture.ts');
  execFileSync(process.execPath, ['--experimental-strip-types', generatorPath, DEFAULT_FIXTURE_PATH], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  if (!fs.existsSync(DEFAULT_FIXTURE_PATH)) {
    throw new Error(
      `[${label}] Failed to generate replay fixture. Run: pnpm run env:setup`
    );
  }
  return DEFAULT_FIXTURE_PATH;
}

export function ensureReproEnvReady({ label = 'Repro', needReplayFixture = false } = {}) {
  const issues = [];

  if (!isPublicSubmoduleReady()) {
    issues.push(
      `Missing 'public/' git submodule assets (causes CameraMicrokernel SHA-256 mismatch and Host boot timeout).`
    );
  }

  const chromeBin = resolveChromeBinary();
  if (!chromeBin) {
    issues.push(
      `No Chrome/Chromium binary found (checked CHROME_BIN, /usr/bin/google-chrome, chromium, chrome-headless-shell).`
    );
  }

  if (issues.length > 0) {
    const msg = [
      `[${label}] Environment preflight failed:`,
      ...issues.map((i) => `  - ${i}`),
      ``,
      `Run the built-in setup / doctor command to fix automatically:`,
      `  pnpm run env:setup`,
      `  # or inspect details with:`,
      `  pnpm run env:doctor`,
    ].join('\n');
    throw new Error(msg);
  }

  const replayPath = needReplayFixture ? resolveOrGenerateReplayFixture(label) : null;
  return { chromeBin, replayPath };
}

export function attachCdpDiagnostics(cdp, label, maxEntries = 25) {
  const errors = [];
  if (!cdp?.ws) return errors;
  cdp.ws.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(String(evt.data));
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (errors.length < maxEntries) errors.push(`[console.error] ${text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const desc =
          msg.params?.exceptionDetails?.exception?.description ||
          msg.params?.exceptionDetails?.text ||
          'Unknown exception';
        if (errors.length < maxEntries) errors.push(`[exception] ${desc}`);
      }
    } catch {
      // Ignore malformed CDP events
    }
  });
  return errors;
}

export async function safeCleanupChrome({ chromeProc, userDataDir, server, hostCdp, clientCdp }) {
  try {
    hostCdp?.close();
  } catch {
    // Ignore
  }
  try {
    clientCdp?.close();
  } catch {
    // Ignore
  }
  if (chromeProc) {
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      // Ignore
    }
    await new Promise((resolve) => {
      if (chromeProc.exitCode !== null || chromeProc.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 1500);
      chromeProc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (server) {
    try {
      await server.close();
    } catch {
      // Ignore
    }
  }
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Never mask original test errors with ENOTEMPTY during temp dir cleanup
    }
  }
}
