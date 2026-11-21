#!/usr/bin/env node
/**
 * scripts/env/doctor.mjs
 *
 * Built-in environment diagnostic for RocketCompanion (unit tests, radar, Headless WebGL E2E, optional Rust/Tauri).
 * Usage:
 *   pnpm run env:doctor
 *   node scripts/env/doctor.mjs [--require-rust]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { resolveChromeBinary, isPublicSubmoduleReady } from './reproPreflight.mjs';
import {
  autoRestoreTmpfs,
  DEFAULT_CACHE_ROOT,
  hasPopulatedNodeModules,
  inspectTmpfsState,
  printTmpfsDiagnostic,
} from './tmpfsGuard.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node scripts/env/doctor.mjs [--auto-restore] [--require-rust] [--help]

Options:
  --auto-restore   Restore tmpfs caches, pnpm, public/ submodule, node_modules, and .rcreplay
  --require-rust   Treat missing Rust/Cargo toolchain as a failure (and install if --auto-restore)
  --help, -h       Show this help (for full command list run: pnpm run env:help)`);
  process.exit(0);
}
const requireRust = process.argv.includes('--require-rust');
const autoRestore = process.argv.includes('--auto-restore');

function hasCommand(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function probeHeadlessWebGL(chromeBin) {
  const chromeRoot = path.join(DEFAULT_CACHE_ROOT, 'chrome-userdata');
  fs.mkdirSync(chromeRoot, { recursive: true });
  const userDataDir = path.join(chromeRoot, `doctor-${Date.now()}`);
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  try {
    const cdpPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP port timeout (12s)')), 12_000);
      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        const m = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited early (${code}): ${stderr.slice(-300)}`));
      });
    });

    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const page = targets.find((t) => t.type === 'page') || targets[0];
    if (!page?.webSocketDebuggerUrl) {
      throw new Error('No CDP page target found');
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebGL eval timeout')), 15_000);
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 1) {
          clearTimeout(timer);
          resolve(msg.result?.result?.value);
        }
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => {
              const c = document.createElement('canvas');
              const gl = c.getContext('webgl2') || c.getContext('webgl');
              if (!gl) return { ok: false };
              return {
                ok: true,
                version: gl.getParameter(gl.VERSION),
                renderer: gl.getParameter(gl.RENDERER),
                vendor: gl.getParameter(gl.VENDOR),
              };
            })()`,
            returnByValue: true,
          },
        })
      );
    });
    ws.close();
    return result;
  } finally {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Ignore
    }
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore
    }
  }
}

async function main() {
  if (autoRestore) {
    autoRestoreTmpfs(ROOT_DIR, { withRust: requireRust });
  }

  console.log('=== RocketCompanion Environment Doctor ===');
  let failures = 0;

  const check = (name, ok, detail, optional = false) => {
    const tag = ok ? 'OK  ' : optional ? 'WARN' : 'FAIL';
    console.log(`[${tag}] ${name}: ${detail}`);
    if (!ok && !optional) failures++;
  };

  const tmpfsReport = inspectTmpfsState(ROOT_DIR);

  check('Node.js', true, process.version);
  check(
    'pnpm',
    hasCommand('pnpm'),
    hasCommand('pnpm') ? 'installed' : 'missing (run: bash scripts/env/bootstrap.sh --pnpm-only)'
  );

  const nmOk = hasPopulatedNodeModules(ROOT_DIR);
  const nmLink = tmpfsReport.symlinks.find((s) => s.rel === 'node_modules');
  check(
    'node_modules',
    nmOk,
    nmOk
      ? nmLink?.status === 'ok'
        ? `present (tmpfs -> ${nmLink.linkTarget})`
        : 'present'
      : nmLink?.status === 'dangling'
        ? `DANGLING symlink -> ${nmLink.linkTarget} (/tmp was reset!)`
        : 'missing (run: pnpm run env:setup)'
  );

  check(
    'tmpfs sentinel',
    tmpfsReport.sentinelExists && !tmpfsReport.tmpfsResetDetected,
    tmpfsReport.tmpfsResetDetected
      ? 'RESET DETECTED (/tmp cleared; run: node scripts/env/doctor.mjs --auto-restore)'
      : tmpfsReport.sentinelExists
        ? `present (${tmpfsReport.sentinelPath})`
        : 'missing (run: node scripts/env/tmpfsGuard.mjs --ensure)',
    true
  );

  check(
    'OverlayFS footprint',
    tmpfsReport.overlayWithinBudget,
    `${tmpfsReport.currentOverlayMB ?? '?'} MB (baseline: ${tmpfsReport.baseline?.baselineMB ?? 'n/a'} MB, budget: <= ${tmpfsReport.overlayBudgetMB} MB)`,
    true
  );

  const pubOk = isPublicSubmoduleReady();
  check(
    'public/ submodule',
    pubOk,
    pubOk ? 'initialized' : 'NOT initialized (run: git submodule update --init --recursive)'
  );

  const chromeBin = resolveChromeBinary();
  check('Chrome binary', Boolean(chromeBin), chromeBin || 'not found');

  if (chromeBin) {
    try {
      const gl = await probeHeadlessWebGL(chromeBin);
      check(
        'Headless WebGL (SwiftShader)',
        Boolean(gl?.ok),
        gl?.ok ? `${gl.version} | ${gl.renderer}` : 'WebGL context creation returned null'
      );
    } catch (err) {
      check(
        'Headless WebGL (SwiftShader)',
        false,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const replayCandidates = [
    process.env.RC_REPLAY_PATH,
    '/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
    '/workspace/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
    path.resolve(ROOT_DIR, '../rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay'),
  ].filter(Boolean);
  const foundReplay = replayCandidates.find((p) => fs.existsSync(p));
  check(
    '3v3 .rcreplay fixture',
    Boolean(foundReplay),
    foundReplay || 'missing (run: pnpm run replay:generate-ducky or pnpm run env:setup)',
    true
  );

  const hasRust = hasCommand('cargo') && hasCommand('rustc');
  check(
    'Rust toolchain (cargo/rustc)',
    hasRust,
    hasRust
      ? 'installed'
      : 'missing (optional; needed only for Tauri C4 cargo check; install via: pnpm run env:setup:rust)',
    !requireRust
  );

  if (tmpfsReport.tmpfsResetDetected) {
    printTmpfsDiagnostic(tmpfsReport);
  }

  console.log('==========================================');
  if (failures > 0) {
    console.error(`\n[env:doctor] ${failures} required check(s) failed.`);
    console.error(`Run the one-click setup / auto-restore command to repair your environment:`);
    console.error(`  node scripts/env/doctor.mjs --auto-restore`);
    console.error(`  pnpm run env:setup`);
    console.error(`  # or if pnpm itself is not yet installed:`);
    console.error(`  bash scripts/env/bootstrap.sh`);
    process.exit(1);
  }
  console.log('[env:doctor] All required checks passed. Headless WebGL E2E is ready.');
}

main().catch((err) => {
  console.error('[env:doctor] Unexpected error:', err);
  process.exit(1);
});
