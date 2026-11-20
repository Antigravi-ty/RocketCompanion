#!/usr/bin/env node
/**
 * scripts/runDevRoomSyncE2E.mjs
 * Step 5: Real multi-tab Linux Headless Chrome E2E verification for Developer Sync Room (Pure CSR).
 *
 * Flow covered (no ?reproRole= suffix on either tab):
 * 1. Host Dev UI -> Create Developer Sync Room -> DevRoomSyncFloatingWindow
 * 2. Plain Client UI -> Join Room via Room Code -> P2P/BroadcastChannel connect
 * 3. Pure CSR Sync All (workspace mirror, clientInputEnabled=false, arenaPreset sync)
 * 4. Dual-End Input Gating (zeroed when false, preserved when toggled true)
 * 5. Telestrator (0x05) real-time stroke sync & clear with everyone permission
 * 6. Replay Watch Together (Pure CSR frame injection, pause/tick & camera sync)
 * 7. Custom Training Pack (metadata sync + Reset Shot)
 * 8. Room Match Auto-Pull (auto-assign connected P2P peers, clientInputEnabled=true)
 *
 * Hard assertions:
 * - runtime_error === 0
 * - poseAnomalies === 0
 * - stuckInGoal === false
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'vite';
import { createSoftTimeoutWatchdog } from './lib/softTimeoutWatchdog.mjs';

if (!process.env.RC_VITE_ROLE) {
  process.env.RC_VITE_ROLE = 'rc-http';
}

const OUT_PATH = '/tmp/dev-room-sync-e2e-report.json';

class CdpClient {
  constructor(wsUrl, label, onRuntimeError) {
    this.label = label;
    this.onRuntimeError = onRuntimeError;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.readyPromise = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (err) => reject(err));
    });
    this.ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`CDP ${label} error: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params?.exceptionDetails;
        const text =
          details?.exception?.description || details?.text || 'Unknown Runtime.exceptionThrown';
        this.onRuntimeError(this.label, `Runtime.exceptionThrown: ${text}`);
      } else if (msg.method === 'Log.entryAdded') {
        const entry = msg.params?.entry;
        if (
          entry?.level === 'error' &&
          !String(entry?.url || '').includes('site.webmanifest') &&
          !String(entry?.text || '').includes('Manifest:')
        ) {
          this.onRuntimeError(this.label, `Log.error: ${entry.text}`);
        }
      }
    });
  }

  async connect() {
    await this.readyPromise;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        'Eval exception';
      throw new Error(`[${this.label}] eval failed: ${desc}`);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Ignore
    }
  }
}

async function waitFor(fn, label, timeoutMs = 30_000, intervalMs = 150) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timeout waiting for ${label} after ${timeoutMs}ms${lastErr ? ` (lastErr: ${lastErr.message})` : ''}`
  );
}

async function installInPageErrorTrap(cdp) {
  await cdp.eval(`(() => {
    window.__e2eErrors = [];
    window.addEventListener('error', (e) => {
      window.__e2eErrors.push('window.error: ' + (e.message || String(e)));
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.__e2eErrors.push('unhandledrejection: ' + String(e.reason));
    });
    const origErr = console.error.bind(console);
    console.error = (...args) => {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (/Uncaught|TypeError|ReferenceError|RangeError|WebGL: CONTEXT_LOST/i.test(text)) {
        window.__e2eErrors.push('console.error: ' + text.slice(0, 240));
      }
      origErr(...args);
    };
  })()`);
}

async function inspectPoseAndGoalHealth(cdp, role) {
  return cdp.eval(`(() => {
    const e2e = window.__rcE2E;
    const rt = e2e?.runtime;
    const physics = rt?.physics;
    if (!physics) return { ok: false, reason: 'no physics' };
    const anomalies = [];
    const mask = typeof physics.getActiveCarMask === 'function' ? physics.getActiveCarMask() : 1;
    const cars = [];
    for (let i = 0; i < 8; i++) {
      if ((mask & (1 << i)) === 0) continue;
      const cv = typeof physics.getCarStateView === 'function' ? physics.getCarStateView(i) : null;
      if (!cv) continue;
      const px = cv.posX;
      const py = cv.posY;
      const pz = cv.posZ;
      const finite = Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz);
      if (!finite) {
        anomalies.push('${role}:car#' + i + ':non_finite_pos');
      }
      if (Math.abs(px) > 6000 || Math.abs(py) > 7000 || pz < -200 || pz > 4000) {
        anomalies.push('${role}:car#' + i + ':out_of_bounds:' + JSON.stringify([px, py, pz]));
      }
      cars.push({ idx: i, pos: [Math.round(px), Math.round(py), Math.round(pz)] });
    }
    if (cars.length === 0) {
      anomalies.push('${role}:no_active_cars');
    }
    const bv = typeof physics.getBallStateView === 'function' ? physics.getBallStateView() : null;
    const bx = bv ? bv.posX : NaN;
    const by = bv ? bv.posY : NaN;
    const bz = bv ? bv.posZ : NaN;
    if (!bv || !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) {
      anomalies.push('${role}:ball:non_finite_pos');
    }
    const stuckInGoal = Boolean(bv && Math.abs(by) > 5140);
    return {
      ok: true,
      anomalies,
      stuckInGoal,
      ballPos: bv ? [Math.round(bx), Math.round(by), Math.round(bz)] : null,
      cars,
    };
  })()`);
}

async function main() {
  const startMs = Date.now();
  const runtimeErrors = [];
  const onRuntimeError = (role, msg) => {
    runtimeErrors.push({ role, msg, elapsedMs: Date.now() - startMs });
    console.error(`[RuntimeError][${role}] ${msg}`);
  };

  const server = await createServer({
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  const protocol = server.config.server.https ? 'https' : 'http';
  const baseUrl = `${protocol}://127.0.0.1:${port}/?skipShaderPrewarm=1`;

  console.log(`[DevRoomSyncE2E] Vite listening at ${baseUrl}`);

  const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const userDataDir = `/tmp/chrome-dev-sync-e2e-${Date.now()}`;
  const chromeProc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-proxy-server',
      '--remote-debugging-port=0',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-popup-blocking',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,720',
      baseUrl,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let cdpPort = null;
  chromeProc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    const m = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) cdpPort = Number(m[1]);
  });

  let hostCdp = null;
  let clientCdp = null;
  const stageResults = {};

  const watchdog = createSoftTimeoutWatchdog({
    label: 'DevRoomSyncE2E',
    exitCode: 1,
    onTimeout: async () => {
      try {
        fs.writeFileSync(
          OUT_PATH,
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              timedOut: true,
              stageResults,
            },
            null,
            2
          )
        );
      } catch {
        // Ignore
      }
      hostCdp?.close();
      clientCdp?.close();
      try {
        chromeProc.kill('SIGKILL');
      } catch {
        // Ignore
      }
      await server.close().catch(() => {});
    },
  });

  try {
    await waitFor(() => cdpPort !== null, 'Chrome CDP port', 15_000, 100);
    const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
    const hostTarget = targets.find((t) => t.type === 'page');
    if (!hostTarget?.webSocketDebuggerUrl) {
      throw new Error('Could not find Host page target in CDP /json/list');
    }

    hostCdp = new CdpClient(hostTarget.webSocketDebuggerUrl, 'host', onRuntimeError);
    await hostCdp.connect();
    await installInPageErrorTrap(hostCdp);

    try {
      await waitFor(
        () =>
          hostCdp.eval(
            `Boolean(window.__rcE2E?.runtime?.physics && window.__rcE2E?.getAppState?.()?.bridge?.onHostOnlineWarmup)`
          ),
        'Host runtime bootstrap',
        30_000,
        200
      );
    } catch (err) {
      const diag = await hostCdp
        .eval(
          `({ readyState: document.readyState, href: location.href, e2eKeys: Object.keys(window.__rcE2E || {}), hasPhysics: Boolean(window.__rcE2E?.runtime?.physics), body: (document.body?.innerText || '').slice(0, 400) })`
        )
        .catch((e) => ({ evalErr: String(e) }));
      console.error('[DevRoomSyncE2E] Host bootstrap diag:', JSON.stringify(diag));
      throw err;
    }
    console.log('[DevRoomSyncE2E] Host runtime ready.');

    // Stage 1: Host Dev UI -> Create Developer Sync Room
    await hostCdp.eval(`(() => {
      const app = window.__rcE2E.getAppState();
      app.openMenu?.();
      app.navigate?.('dev-under-development');
    })()`);

    await waitFor(
      () =>
        hostCdp.eval(`(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find((b) => b.textContent && b.textContent.includes('Create Developer Sync Room'));
          if (!btn) return false;
          btn.click();
          return true;
        })()`),
      'Host Create Developer Sync Room button click',
      10_000,
      150
    );

    const hostRoomInfo = await waitFor(
      () =>
        hostCdp.eval(`(() => {
          const s = window.__rcE2E.getAppState().onlineSession;
          if (!s?.isHosting || !s?.roomId) return null;
          const hasWin = document.body.innerText.includes('Developer Sync Room');
          if (!hasWin) return null;
          return { roomId: s.roomId, activeActivity: s.activeRoomActivity };
        })()`),
      'Host room hosting + DevRoomSyncFloatingWindow',
      15_000,
      150
    );
    stageResults.hostCreateRoom = hostRoomInfo;
    console.log(`[DevRoomSyncE2E] Stage 1 PASS: Host created room ${hostRoomInfo.roomId}`);

    // Stage 2: Plain Client UI (no ?reproRole suffix) -> Join Room via Room Code
    const clientTarget = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(baseUrl)}`,
      { method: 'PUT' }
    ).then((r) => r.json());
    if (!clientTarget?.webSocketDebuggerUrl) {
      throw new Error('Failed to open Client tab via CDP');
    }
    clientCdp = new CdpClient(clientTarget.webSocketDebuggerUrl, 'client', onRuntimeError);
    await clientCdp.connect();
    await installInPageErrorTrap(clientCdp);

    await waitFor(
      () =>
        clientCdp.eval(
          `Boolean(window.__rcE2E?.runtime?.physics && window.__rcE2E?.getAppState?.()?.bridge?.onJoinOnlineWarmup)`
        ),
      'Client runtime bootstrap',
      30_000,
      200
    );
    console.log('[DevRoomSyncE2E] Client runtime ready (plain URL, no reproRole suffix).');

    await clientCdp.eval(`(() => {
      const app = window.__rcE2E.getAppState();
      app.openMenu?.();
      app.navigate?.('join-room');
    })()`);

    await waitFor(
      () =>
        clientCdp.eval(`(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          const codeInput = inputs.find((inp) =>
            (inp.placeholder || '').toLowerCase().includes('room') ||
            (inp.placeholder || '').toLowerCase().includes('code') ||
            inp.maxLength === 12 || inp.maxLength === 8 || inp.maxLength === 6
          ) || inputs[1] || inputs[0];
          if (!codeInput) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(codeInput, ${JSON.stringify(hostRoomInfo.roomId)});
          codeInput.dispatchEvent(new Event('input', { bubbles: true }));
          codeInput.dispatchEvent(new Event('change', { bubbles: true }));
          const btns = Array.from(document.querySelectorAll('button'));
          const joinBtn = btns.find((b) => /join/i.test(b.textContent || '') && !b.disabled);
          if (!joinBtn) return false;
          joinBtn.click();
          return true;
        })()`),
      'Client Join Room UI form submit',
      15_000,
      200
    );

    try {
      await waitFor(
        async () => {
          const hPeers = await hostCdp.eval(
            `window.__rcE2E.getAppState().onlineSession?.connectedPeers?.length ?? 0`
          );
          const cConn = await clientCdp.eval(
            `(window.__rcE2E.getAppState().onlineSession?.connectedPeers?.length ?? 0) >= 1 && Boolean(window.__rcE2E.runtime?.networkReconciler)`
          );
          return hPeers >= 1 && cConn;
        },
        'Host & Client P2P/BroadcastChannel connection',
        20_000,
        200
      );
    } catch (err) {
      const hDiag = await hostCdp
        .eval(`window.__rcE2E.getAppState().onlineSession`)
        .catch(() => null);
      const cDiag = await clientCdp
        .eval(
          `({ onlineSession: window.__rcE2E.getAppState().onlineSession, body: (document.body?.innerText || '').slice(0, 500) })`
        )
        .catch(() => null);
      console.error('[DevRoomSyncE2E] Stage 2 diag host:', JSON.stringify(hDiag));
      console.error('[DevRoomSyncE2E] Stage 2 diag client:', JSON.stringify(cDiag));
      throw err;
    }
    const freeplaySpectateSync = await waitFor(
      async () => {
        const h = await hostCdp.eval(`({
          numCars: window.__rcE2E.runtime?.physics?.numCars,
          playerCarIndex: window.__rcE2E.runtime?.playerCarIndex,
        })`);
        const c = await clientCdp.eval(`({
          numCars: window.__rcE2E.runtime?.physics?.numCars,
          playerCarIndex: window.__rcE2E.runtime?.playerCarIndex,
          focusedCarIndex: window.__rcE2E.runtime?.camera?.focusedCarIndex,
          isDevSyncRoom: window.__rcE2E.getAppState()?.onlineSession?.isDevSyncRoom,
        })`);
        if (
          h.numCars === 1 &&
          c.numCars === 1 &&
          c.playerCarIndex === 0 &&
          c.focusedCarIndex === 0 &&
          c.isDevSyncRoom === true
        ) {
          return { host: h, client: c };
        }
        return null;
      },
      'Freeplay spectate-only sync (1 car on both ends, client camera on car 0)',
      10_000,
      150
    );
    stageResults.clientJoinRoom = {
      connected: true,
      roomId: hostRoomInfo.roomId,
      ...freeplaySpectateSync,
    };
    console.log('[DevRoomSyncE2E] Stage 2 PASS: Client joined room via plain UI.');

    // Stage 3: Pure CSR Sync All (workspace mirror + clientInputEnabled=false + arenaPreset sync)
    // Trigger an explicit broadcast from DevRoomSyncFloatingWindow "Broadcast Sync Now"
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find((x) => (x.textContent || '').includes('Broadcast Sync Now'));
      b?.click();
    })()`);

    let csrState;
    try {
      csrState = await waitFor(
        () =>
          clientCdp.eval(`(() => {
            const ws = window.__rcE2E.getWorkspaceState();
            const rec = window.__rcE2E.runtime?.networkReconciler;
            if (!ws?.isSpectating || ws.spectateMode !== 'spectate_mirror') return null;
            if (ws.clientInputEnabled !== false || rec?.clientInputEnabled !== false) return null;
            if (rec?.lobbyDualWorldMode !== false) return null;
            return {
              isSpectating: ws.isSpectating,
              spectateMode: ws.spectateMode,
              clientInputEnabled: ws.clientInputEnabled,
              followHostWorkspace: ws.followHostWorkspace,
              arenaPreset: ws.arenaPreset,
              lobbyDualWorldMode: rec?.lobbyDualWorldMode,
            };
          })()`),
        'Client Pure CSR spectate_mirror state & lobbyDualWorldMode=false',
        10_000,
        150
      );
    } catch (err) {
      const diag = await clientCdp
        .eval(
          `({ ws: window.__rcE2E.getWorkspaceState(), recInput: window.__rcE2E.runtime?.networkReconciler?.clientInputEnabled, lobbyDual: window.__rcE2E.runtime?.networkReconciler?.lobbyDualWorldMode, hasChHandler: Boolean(window.__rcE2E.runtime?.networkChannel?.onGlobalWorkspaceBroadcast) })`
        )
        .catch(() => null);
      console.error('[DevRoomSyncE2E] Stage 3 diag client:', JSON.stringify(diag));
      throw err;
    }

    // Verify Host & Client ballPos actually converge in Pure CSR
    const csrBallSync = await waitFor(
      async () => {
        const hb = await hostCdp.eval(`(() => {
          const b = window.__rcE2E.runtime?.physics?.getBallStateView?.();
          return b ? [b.posX, b.posY, b.posZ] : null;
        })()`);
        const cb = await clientCdp.eval(`(() => {
          const b = window.__rcE2E.runtime?.physics?.getBallStateView?.();
          return b ? [b.posX, b.posY, b.posZ] : null;
        })()`);
        if (!hb || !cb) return null;
        const dist = Math.hypot(hb[0] - cb[0], hb[1] - cb[1], hb[2] - cb[2]);
        return dist < 50 ? { dist, hostBall: hb, clientBall: cb } : null;
      },
      'Host & Client Pure CSR ballPos convergence',
      10_000,
      150
    );
    csrState.ballSyncDist = Math.round(csrBallSync.dist * 100) / 100;

    // Test Arena Preset Sync via DevRoomSyncFloatingWindow buttons
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((x) => (x.textContent || '').trim().toLowerCase() === 'throwback')?.click();
    })()`);
    await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.getWorkspaceState()?.arenaPreset === 'throwback' && window.__rcE2E.getAppState()?.underDevelopment?.stadiumPreset === 'throwback'`
        ),
      'Client arenaPreset sync to throwback',
      8_000,
      150
    );
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((x) => (x.textContent || '').trim().toLowerCase() === 'standard')?.click();
    })()`);
    await waitFor(
      () => clientCdp.eval(`window.__rcE2E.getWorkspaceState()?.arenaPreset === 'standard'`),
      'Client arenaPreset sync back to standard',
      8_000,
      150
    );
    stageResults.pureCsrSyncAll = csrState;
    console.log('[DevRoomSyncE2E] Stage 3 PASS: Pure CSR Sync All & ArenaPreset verified.');

    // Stage 4: Dual-End Input Gating
    const gatedInputSample = await clientCdp.eval(`(() => {
      const rec = window.__rcE2E.runtime.networkReconciler;
      const carIdx = window.__rcE2E.runtime.playerCarIndex ?? 1;
      const tick = Math.floor(rec.sim.getHeaderView().tickCount);
      const entry = rec.historyBuffer.getEntry(tick);
      if (entry && entry.controlsByCar) delete entry.controlsByCar[carIdx];
      return rec.sampleAndPredictInput(carIdx, {
        throttle: 1, steer: 0.5, pitch: 0, yaw: 0, roll: 0,
        jump: true, boost: true, handbrake: false,
      });
    })()`);
    if (gatedInputSample.throttle !== 0 || gatedInputSample.boost !== false) {
      throw new Error(`Input gating failed when disabled: ${JSON.stringify(gatedInputSample)}`);
    }

    // Toggle Allow Client Driving Input ON via Host DevRoomSyncFloatingWindow
    await hostCdp.eval(`(() => {
      const app = window.__rcE2E.getAppState();
      app.bridge.onSetClientInputEnabled?.(true);
    })()`);
    await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.getWorkspaceState()?.clientInputEnabled === true && window.__rcE2E.runtime?.networkReconciler?.clientInputEnabled === true`
        ),
      'Client input enabled propagation',
      8_000,
      150
    );
    const unlockedInputSample = await clientCdp.eval(`(() => {
      const rec = window.__rcE2E.runtime.networkReconciler;
      const carIdx = window.__rcE2E.runtime.playerCarIndex ?? 1;
      const tick = Math.floor(rec.sim.getHeaderView().tickCount);
      const entry = rec.historyBuffer.getEntry(tick);
      if (entry && entry.controlsByCar) delete entry.controlsByCar[carIdx];
      return rec.sampleAndPredictInput(carIdx, {
        throttle: 1, steer: 0.5, pitch: 0, yaw: 0, roll: 0,
        jump: true, boost: true, handbrake: false,
      });
    })()`);
    if (unlockedInputSample.throttle !== 1 || unlockedInputSample.boost !== true) {
      throw new Error(`Input unlock failed when enabled: ${JSON.stringify(unlockedInputSample)}`);
    }
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onSetClientInputEnabled?.(false)`);
    await waitFor(
      () =>
        clientCdp.eval(`window.__rcE2E.runtime?.networkReconciler?.clientInputEnabled === false`),
      'Client input re-gated propagation',
      8_000,
      150
    );
    stageResults.inputGating = { gatedOk: true, unlockedOk: true };
    console.log('[DevRoomSyncE2E] Stage 4 PASS: Dual-End Input Gating verified.');

    // Stage 5: Telestrator (0x05) Full-Link Sync
    await hostCdp.eval(`(() => {
      const ws = window.__rcE2E.getWorkspaceState();
      ws.setTelestratorPermission('everyone');
      window.__rcE2E.getAppState().bridge.onBroadcastGlobalWorkspace?.({
        telestratorPermission: 'everyone',
      });
    })()`);
    await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.getTelestratorState()?.allowClientDrawing === true && window.__rcE2E.getTelestratorState()?.isCameraSynced === true`
        ),
      'Client telestrator everyone permission + isCameraSynced',
      8_000,
      150
    );

    // Close menus so canvas receives pointer events, and activate Telestrator drawing mode on both tabs
    await hostCdp.eval(`(() => {
      window.__rcE2E.getAppState().closeMenu?.();
      window.__rcE2E.getTelestratorState().setOverlayActive(true);
    })()`);
    await clientCdp.eval(`(() => {
      window.__rcE2E.getAppState().closeMenu?.();
      window.__rcE2E.getTelestratorState().setOverlayActive(true);
    })()`);
    await new Promise((r) => setTimeout(r, 200));
    await hostCdp.eval(`window.__rcE2E.getTelestratorState().setDrawingEnabled(true)`);
    await clientCdp.eval(`window.__rcE2E.getTelestratorState().setDrawingEnabled(true)`);
    await new Promise((r) => setTimeout(r, 100));

    // Host draws a stroke via real CDP mouse events on an unobstructed area of the 3D arena canvas
    await hostCdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 960,
      y: 440,
      button: 'left',
      clickCount: 1,
    });
    await hostCdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 1020,
      y: 460,
      button: 'left',
    });
    await new Promise((r) => setTimeout(r, 80));
    await hostCdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 1080,
      y: 480,
      button: 'left',
    });
    await new Promise((r) => setTimeout(r, 80));
    await hostCdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 1080,
      y: 480,
      button: 'left',
      clickCount: 1,
    });

    let hostStrokesAfterDraw;
    try {
      hostStrokesAfterDraw = await waitFor(
        () =>
          hostCdp.eval(`(() => {
            const n = window.__rcE2E.getTelestratorState()?.strokeCount ?? 0;
            return n >= 1 ? n : null;
          })()`),
        'Host telestrator stroke commit',
        8_000,
        150
      );
    } catch (err) {
      const diag = await hostCdp
        .eval(
          `({ state: window.__rcE2E.getTelestratorState(), ptrDiag: window.__rcE2E.runtime.telestratorOverlay.getPointerDiagnostics() })`
        )
        .catch(() => null);
      console.error('[DevRoomSyncE2E] Stage 5 host diag:', JSON.stringify(diag));
      throw err;
    }
    const clientStrokesAfterHostDraw = await waitFor(
      () =>
        clientCdp.eval(`(() => {
          const n = window.__rcE2E.getTelestratorState()?.strokeCount ?? 0;
          return n >= 1 ? n : null;
        })()`),
      'Client received Host telestrator stroke via 0x05',
      8_000,
      150
    );

    // Client draws a stroke via real CDP mouse events -> Host receives it via 0x05
    await clientCdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 540,
      y: 440,
      button: 'left',
      clickCount: 1,
    });
    await clientCdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 500,
      y: 460,
      button: 'left',
    });
    await new Promise((r) => setTimeout(r, 80));
    await clientCdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 500,
      y: 460,
      button: 'left',
      clickCount: 1,
    });

    const hostStrokesAfterClientDraw = await waitFor(
      () =>
        hostCdp.eval(`(() => {
          const n = window.__rcE2E.getTelestratorState()?.strokeCount ?? 0;
          return n >= 2 ? n : null;
        })()`),
      'Host received Client telestrator stroke via 0x05',
      8_000,
      150
    );

    // Host clears all strokes (two-step: 1st clears own & arms purge, 2nd clears all) -> verify both Host and Client clear
    await hostCdp.eval(`(() => {
      const ts = window.__rcE2E.getTelestratorState();
      ts.triggerClear();
      ts.triggerClear();
    })()`);
    await waitFor(
      async () => {
        const h = await hostCdp.eval(`window.__rcE2E.getTelestratorState()?.strokeCount ?? -1`);
        const c = await clientCdp.eval(`window.__rcE2E.getTelestratorState()?.strokeCount ?? -1`);
        return h === 0 && c === 0;
      },
      'Host & Client telestrator clear sync',
      8_000,
      150
    );

    // Deactivate telestrator mode
    await hostCdp.eval(`(() => {
      const ts = window.__rcE2E.getTelestratorState();
      ts.setDrawingEnabled(false);
      ts.setOverlayActive(false);
    })()`);
    await clientCdp.eval(`(() => {
      const ts = window.__rcE2E.getTelestratorState();
      ts.setDrawingEnabled(false);
      ts.setOverlayActive(false);
    })()`);

    stageResults.telestrator = {
      permissionSynced: true,
      hostStrokesAfterDraw,
      clientStrokesAfterHostDraw,
      hostStrokesAfterClientDraw,
    };
    console.log(
      `[DevRoomSyncE2E] Stage 5 PASS: Telestrator (0x05) bidirectional sync verified (host=${hostStrokesAfterClientDraw}, client=${clientStrokesAfterHostDraw}).`
    );

    // Stage 6: Replay Watch Together (Pure CSR + Camera Sync)
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((x) => (x.textContent || '').trim() === 'Replay')?.click();
    })()`);
    await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.getAppState().onlineSession?.activeRoomActivity === 'replay' && window.__rcE2E.runtime?.networkReconciler?.replayPlaybackMode === true`
        ),
      'Client Replay activity & CSR replayPlaybackMode',
      10_000,
      150
    );
    // Inject a Replay state frame via authoritativeServer.enterStateOnlyMode & broadcast pause/cameraSync
    await hostCdp.eval(`(() => {
      const server = window.__rcE2E.runtime.authoritativeServer;
      const phys = window.__rcE2E.runtime.physics;
      phys.setBallState?.({ pos: [120, -350, 240], vel: [0, 0, 0], angVel: [0, 0, 0] });
      const snap = phys.saveCompactState?.() ?? phys.saveState?.();
      server?.enterStateOnlyMode?.(snap, 420);
      window.__rcE2E.getAppState().bridge.onBroadcastGlobalWorkspace?.({
        playbackPaused: true,
        pausedAtTick: 420,
        cameraSync: { followHostCamera: true, ballCam: true, focusedCarIndex: 0 },
      });
    })()`);
    const replayClientState = await waitFor(
      () =>
        clientCdp.eval(`(() => {
          const ws = window.__rcE2E.getWorkspaceState();
          const b = window.__rcE2E.runtime?.physics?.getBallStateView?.();
          if (!ws?.playbackPaused || ws.pausedAtTick !== 420) return null;
          if (!ws.followHostCamera || ws.hostCameraSync?.ballCam !== true) return null;
          if (!b) return null;
          const dist = Math.hypot(b.posX - 120, b.posY - (-350), b.posZ - 240);
          return dist < 50 ? { dist: Math.round(dist * 100) / 100, ballPos: [Math.round(b.posX), Math.round(b.posY), Math.round(b.posZ)] } : null;
        })()`),
      'Client Replay pause/tick, cameraSync & ballPos convergence',
      10_000,
      150
    );
    // Verify 6-car (3v3) Replay snapshot preserves all 6 cars on both Host and Client
    await hostCdp.eval(`(() => {
      const server = window.__rcE2E.runtime.authoritativeServer;
      const phys = window.__rcE2E.runtime.physics;
      for (let c = 0; c < 6; c++) {
        if (!phys.isCarSlotActive?.(c)) phys.addCarAtSlot?.(c, c % 2, 'octane');
      }
      phys.step?.(1 / 120);
      const snap6 = phys.saveCompactState?.() ?? phys.saveState?.();
      server?.enterStateOnlyMode?.(snap6, 500);
    })()`);
    const sixCarReplayState = await waitFor(
      async () => {
        const hCars = await hostCdp.eval(`window.__rcE2E.runtime?.physics?.numCars`);
        const cCars = await clientCdp.eval(`window.__rcE2E.runtime?.physics?.numCars`);
        return hCars === 6 && cCars === 6 ? { hostCars: hCars, clientCars: cCars } : null;
      },
      '6-car (3v3) Replay sync on Host and Client',
      10_000,
      150
    );
    stageResults.replayWatchTogether = {
      synced: true,
      pausedAtTick: 420,
      ...replayClientState,
      ...sixCarReplayState,
    };
    console.log('[DevRoomSyncE2E] Stage 6 PASS: Replay Watch Together verified.');

    // Stage 7: Custom Training Pack (metadata sync + Reset Shot)
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((x) => (x.textContent || '').trim() === 'Training')?.click();
    })()`);
    await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.getAppState().onlineSession?.activeRoomActivity === 'multiplayer_training'`
        ),
      'Client Training activity sync',
      10_000,
      150
    );
    const prevResetSeq = await clientCdp.eval(
      `window.__rcE2E.getAppState().onlineSession?.trainingPackSummary?.shotResetSeq ?? 0`
    );
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((x) => (x.textContent || '').trim() === 'Reset Shot')?.click();
    })()`);
    await waitFor(
      () =>
        clientCdp.eval(
          `(window.__rcE2E.getAppState().onlineSession?.trainingPackSummary?.shotResetSeq ?? 0) > ${prevResetSeq}`
        ),
      'Client training_shot_reset propagation',
      8_000,
      150
    );
    stageResults.customTrainingPack = { synced: true, resetSeqIncremented: true };
    console.log('[DevRoomSyncE2E] Stage 7 PASS: Custom Training Pack & Reset Shot verified.');

    // Stage 8: Room Match Auto-Pull
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((x) => (x.textContent || '').trim() === 'Match')?.click();
    })()`);
    await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.getAppState().onlineSession?.activeRoomActivity === 'match' && window.__rcE2E.runtime?.networkReconciler?.clientInputEnabled === true && window.__rcE2E.runtime?.networkReconciler?.replayPlaybackMode === false`
        ),
      'Client Room Match Auto-Pull + clientInputEnabled=true',
      12_000,
      150
    );
    const matchBallSync = await waitFor(
      async () => {
        const hb = await hostCdp.eval(`(() => {
          const b = window.__rcE2E.runtime?.physics?.getBallStateView?.();
          return b ? [b.posX, b.posY, b.posZ] : null;
        })()`);
        const cb = await clientCdp.eval(`(() => {
          const b = window.__rcE2E.runtime?.physics?.getBallStateView?.();
          return b ? [b.posX, b.posY, b.posZ] : null;
        })()`);
        if (!hb || !cb) return null;
        const dist = Math.hypot(hb[0] - cb[0], hb[1] - cb[1], hb[2] - cb[2]);
        return dist < 50 ? { dist: Math.round(dist * 100) / 100 } : null;
      },
      'Host & Client Match ballPos convergence',
      10_000,
      150
    );
    stageResults.roomMatchAutoPull = { synced: true, ...matchBallSync };
    console.log('[DevRoomSyncE2E] Stage 8 PASS: Room Match Auto-Pull verified.');

    // Stage 9: Reverse Transitions (Match -> Replay -> Freeplay/Lobby -> Leave Room)
    await hostCdp.eval(`(() => {
      const grids = Array.from(document.querySelectorAll('.grid-cols-4'));
      for (const g of grids) {
        const b = Array.from(g.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'Replay');
        if (b) { b.click(); return; }
      }
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((x) => (x.textContent || '').trim() === 'Replay')?.click();
    })()`);
    try {
      await waitFor(
        () =>
          clientCdp.eval(
            `window.__rcE2E.getAppState().onlineSession?.activeRoomActivity === 'replay' && window.__rcE2E.runtime?.networkReconciler?.replayPlaybackMode === true && window.__rcE2E.getAppState().matchMode !== 'match'`
          ),
        'Client Match -> Replay reverse transition',
        10_000,
        150
      );
    } catch (err) {
      const hDiag = await hostCdp
        .eval(
          `({ active: window.__rcE2E.getAppState().onlineSession?.activeRoomActivity, btns: Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(Boolean) })`
        )
        .catch(() => null);
      const cDiag = await clientCdp
        .eval(
          `({ active: window.__rcE2E.getAppState().onlineSession?.activeRoomActivity, replayMode: window.__rcE2E.runtime?.networkReconciler?.replayPlaybackMode, matchMode: window.__rcE2E.getAppState().matchMode })`
        )
        .catch(() => null);
      console.error('[DevRoomSyncE2E] Stage 9 diag host:', JSON.stringify(hDiag));
      console.error('[DevRoomSyncE2E] Stage 9 diag client:', JSON.stringify(cDiag));
      throw err;
    }
    await hostCdp.eval(`(() => {
      const grids = Array.from(document.querySelectorAll('.grid-cols-4'));
      for (const g of grids) {
        const b = Array.from(g.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'Freeplay');
        if (b) { b.click(); return; }
      }
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((x) => (x.textContent || '').trim() === 'Freeplay')?.click();
    })()`);
    try {
      await waitFor(
        () =>
          clientCdp.eval(
            `window.__rcE2E.getAppState().onlineSession?.activeRoomActivity === 'freeplay' && window.__rcE2E.runtime?.networkReconciler?.replayPlaybackMode === false`
          ),
        'Client Replay -> Freeplay (Lobby) reverse transition',
        10_000,
        150
      );
    } catch (err) {
      const hDiag = await hostCdp
        .eval(`window.__rcE2E.getAppState().onlineSession?.activeRoomActivity`)
        .catch(() => null);
      const cDiag = await clientCdp
        .eval(
          `({ active: window.__rcE2E.getAppState().onlineSession?.activeRoomActivity, replayMode: window.__rcE2E.runtime?.networkReconciler?.replayPlaybackMode, matchMode: window.__rcE2E.getAppState().matchMode })`
        )
        .catch(() => null);
      console.error('[DevRoomSyncE2E] Stage 9b diag host:', JSON.stringify(hDiag));
      console.error('[DevRoomSyncE2E] Stage 9b diag client:', JSON.stringify(cDiag));
      throw err;
    }
    await clientCdp.eval(`window.__rcE2E.getAppState().bridge.onLeaveOnlineServer?.()`);
    await waitFor(
      () =>
        clientCdp.eval(`(() => {
          const ws = window.__rcE2E.getWorkspaceState();
          return ws?.isSpectating === false && ws?.spectateMode === 'spectate_state_only' && ws?.clientInputEnabled === true;
        })()`),
      'Client Leave Room restores local workspace state',
      10_000,
      150
    );
    stageResults.reverseTransitionsAndLeave = { synced: true };
    console.log('[DevRoomSyncE2E] Stage 9 PASS: Reverse Transitions & Leave Room verified.');

    // Final Hard Assertions: runtime_error === 0, poseAnomalies === 0, stuckInGoal === false
    const hostPageErrors = await hostCdp.eval(`window.__e2eErrors || []`);
    const clientPageErrors = await clientCdp.eval(`window.__e2eErrors || []`);
    for (const e of hostPageErrors) onRuntimeError('host', e);
    for (const e of clientPageErrors) onRuntimeError('client', e);

    const hostHealth = await inspectPoseAndGoalHealth(hostCdp, 'host');
    const clientHealth = await inspectPoseAndGoalHealth(clientCdp, 'client');
    const poseAnomalies = [...(hostHealth.anomalies || []), ...(clientHealth.anomalies || [])];
    const stuckInGoal = Boolean(hostHealth.stuckInGoal || clientHealth.stuckInGoal);

    const report = {
      generatedAtIso: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      runtime_error: runtimeErrors.length,
      runtimeErrors,
      poseAnomalies: poseAnomalies.length,
      poseAnomalyDetails: poseAnomalies,
      stuckInGoal,
      hostHealth,
      clientHealth,
      stageResults,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[DevRoomSyncE2E] Report written to ${OUT_PATH}`);

    if (runtimeErrors.length > 0 || poseAnomalies.length > 0 || stuckInGoal) {
      throw new Error(
        `Hard assertion failed: runtime_error=${runtimeErrors.length}, poseAnomalies=${poseAnomalies.length}, stuckInGoal=${stuckInGoal}`
      );
    }

    console.log(
      `[DevRoomSyncE2E] ALL E2E CHECKS PASSED in ${report.durationMs}ms (runtime_error=0, poseAnomalies=0, stuckInGoal=false)`
    );
  } finally {
    watchdog.dispose();
    hostCdp?.close();
    clientCdp?.close();
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      // Ignore
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    await server.close();
  }
}

main().catch((err) => {
  console.error('[DevRoomSyncE2E] FAILED:', err);
  process.exit(1);
});
