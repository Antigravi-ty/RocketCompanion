#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanupHeadlessChrome,
  isPublicSubmoduleReady,
  launchHeadlessChrome,
  resolveChromeBinary,
} from './launchHeadlessChrome.mjs';
import { DEFAULT_SYNTHETIC_REPLAY_PATH } from './generateSyntheticReplayFixture.mjs';
import {
  autoRestoreTmpfs,
  hasPopulatedNodeModules,
  inspectTmpfsState,
  printTmpfsDiagnostic,
} from './tmpfsGuard.mjs';

function checkCommand(cmd, args = ['--version']) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, version: out.split('\n')[0] };
  } catch {
    return { ok: false, version: null };
  }
}

async function probeHeadlessWebGL2(chromeBin) {
  if (!chromeBin) return { ok: false, detail: 'Chrome binary not found' };
  const { chromeProc, userDataDir, getCdpPort } = launchHeadlessChrome({
    url: 'about:blank',
    userDataDirPrefix: 'rc-env-probe',
  });
  try {
    const start = Date.now();
    while (!getCdpPort() && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const cdpPort = getCdpPort();
    if (!cdpPort) return { ok: false, detail: 'Chrome CDP port did not open' };
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) return { ok: false, detail: 'No CDP page target found' };
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const probe = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, detail: 'Eval timeout' }), 15_000);
      ws.addEventListener('message', (evt) => {
        const msg = JSON.parse(String(evt.data));
        if (msg.id === 1) {
          clearTimeout(timer);
          resolve(msg.result?.result?.value || { ok: false, detail: 'Empty eval result' });
        }
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); return { ok: Boolean(gl), renderer: gl ? gl.getParameter(gl.RENDERER) : null }; })()`,
            returnByValue: true,
          },
        })
      );
    });
    ws.close();
    return {
      ok: Boolean(probe?.ok),
      detail: probe?.ok ? `WebGL2 ready (${probe.renderer || 'SwiftShader'})` : probe?.detail || 'WebGL2 unavailable',
    };
  } catch (err) {
    return { ok: false, detail: err?.message || String(err) };
  } finally {
    await cleanupHeadlessChrome(chromeProc, userDataDir);
  }
}

async function main() {
  const cwd = process.cwd();
  const skipWebGLProbe = process.argv.includes('--quick');
  const autoRestore = process.argv.includes('--auto-restore');
  const withRust = process.argv.includes('--with-rust');

  if (autoRestore) {
    autoRestoreTmpfs(cwd, { withRust });
  }

  const tmpfsReport = inspectTmpfsState(cwd);
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  const pnpmRes = checkCommand('pnpm');
  const depsOk = hasPopulatedNodeModules(cwd);
  const submoduleOk = isPublicSubmoduleReady(cwd);
  const chromeBin = resolveChromeBinary();
  const replayExists = [
    process.env.RC_REPLAY_PATH,
    DEFAULT_SYNTHETIC_REPLAY_PATH,
    '/workspace/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
    path.resolve(cwd, '../rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay'),
  ]
    .filter(Boolean)
    .some((p) => fs.existsSync(p));
  const cargoBinDir = path.join(process.env.CARGO_HOME || path.join(process.env.HOME || '/root', '.cargo'), 'bin');
  const envWithCargo = { ...process.env, PATH: `${cargoBinDir}:${process.env.HOME || '/root'}/.cargo/bin:${process.env.PATH || ''}` };
  const checkCargoCmd = (cmd) => {
    try {
      const out = execFileSync(cmd, ['--version'], {
        encoding: 'utf8',
        env: envWithCargo,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return { ok: true, version: out.split('\n')[0] };
    } catch {
      return { ok: false, version: null };
    }
  };
  const cargoRes = checkCargoCmd('cargo');
  const rustcRes = checkCargoCmd('rustc');
  const ccRes = checkCommand('cc');
  const hasProxy = Boolean(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy);

  let webglRes = { ok: Boolean(chromeBin), detail: skipWebGLProbe ? 'skipped (--quick)' : 'not checked' };
  if (!skipWebGLProbe && chromeBin && depsOk && submoduleOk) {
    webglRes = await probeHeadlessWebGL2(chromeBin);
  }

  const rustReady = cargoRes.ok && rustcRes.ok && ccRes.ok;
  const overlayDetail = `${tmpfsReport.currentOverlayMB ?? '?'} MB (baseline: ${
    tmpfsReport.baseline?.baselineMB ?? 'n/a'
  } MB, budget: <= ${tmpfsReport.overlayBudgetMB} MB)`;
  const rows = [
    ['Node.js >= 20', nodeOk, `v${process.versions.node}`],
    ['pnpm', pnpmRes.ok, pnpmRes.version || 'missing'],
    ['node_modules', depsOk, depsOk ? (tmpfsReport.symlinks.find((s) => s.rel === 'node_modules')?.status === 'ok' ? 'installed (tmpfs)' : 'installed') : 'missing'],
    ['tmpfs sentinel', tmpfsReport.sentinelExists && !tmpfsReport.tmpfsResetDetected, tmpfsReport.tmpfsResetDetected ? 'RESET DETECTED' : tmpfsReport.sentinelExists ? tmpfsReport.sentinelPath : 'missing'],
    ['OverlayFS size', tmpfsReport.overlayWithinBudget, overlayDetail],
    ['public/ submodule', submoduleOk, submoduleOk ? 'initialized' : 'missing (camera.wasm not found)'],
    ['Chrome binary', Boolean(chromeBin), chromeBin || 'missing'],
    ['Headless WebGL2', webglRes.ok, webglRes.detail],
    ['3v3 .rcreplay fixture', replayExists, replayExists ? 'present' : 'missing (auto-generated by env:setup)'],
    ['Proxy bypass', true, hasProxy ? 'HTTP(S)_PROXY detected -> --no-proxy-server enabled' : 'no proxy'],
    [
      'Rust/Tauri (optional)',
      rustReady,
      rustReady
        ? `${cargoRes.version} + cc`
        : 'not installed (run "pnpm run env:setup:rust" for Tauri/C4)',
    ],
  ];

  console.log('=== RocketCompanion Environment Check ===');
  for (const [label, ok, detail] of rows) {
    console.log(`${ok ? '[OK]  ' : '[WARN]'} ${label.padEnd(24)} ${detail}`);
  }

  if (tmpfsReport.tmpfsResetDetected) {
    printTmpfsDiagnostic(tmpfsReport);
  }

  const criticalOk = nodeOk && pnpmRes.ok && depsOk && submoduleOk && Boolean(chromeBin) && (skipWebGLProbe || webglRes.ok);
  if (!criticalOk) {
    console.log('\nMissing required E2E/WebGL dependencies. Run:');
    console.log('  node scripts/env/checkEnv.mjs --auto-restore');
    console.log('  # or:');
    console.log('  pnpm run env:setup');
    process.exit(1);
  }
  if (!replayExists) {
    console.log('\nNote: 3v3 .rcreplay fixture is missing; run "pnpm run replay:generate-ducky" or "pnpm run env:setup" to generate it.');
  }
}

main().catch((err) => {
  console.error('[env:check] Failed:', err);
  process.exit(1);
});
