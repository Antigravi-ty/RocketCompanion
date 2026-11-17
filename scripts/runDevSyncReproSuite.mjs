#!/usr/bin/env node
/**
 * scripts/runDevSyncReproSuite.mjs
 * Linux Headless Chrome reproduction suite for Developer Sync Room (Pure CSR) bugs.
 *
 * Reproduces real-world flows not covered by synthetic E2E injection:
 * 1. Freeplay live driving sync (Host drives car -> Client spectates).
 * 2. Exhibition 3v3 spectating (Host starts Exhibition -> Host & Client car counts + state).
 * 3. Real 3v3 .RCReplay load, playback & pause/ACK (Host loads .RCReplay -> car counts + convergence).
 * 4. Static Training Pack sync (Host enters static-training-pack -> Client shot pose sync).
 * 5. Multi-client broadcast (Host + 2 Clients in same Dev Sync Room).
 * 6. Client input handover (clientInputEnabled=true -> Client drives -> Host & Client sync).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

if (!process.env.RC_VITE_ROLE) {
  process.env.RC_VITE_ROLE = 'rc-http';
}

const OUT_PATH = '/tmp/dev-sync-repro-report.json';
const REPORT_ONLY = process.argv.includes('--report-only');
const MAX_DURATION_MS = 180_000;

class CdpClient {
  constructor(wsUrl, label) {
    this.label = label;
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
      }
    });
  }

  async connect() {
    await this.readyPromise;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
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
    `Timeout waiting for ${label} after ${timeoutMs}ms${lastErr ? ` (${lastErr.message})` : ''}`
  );
}

async function readSimSnapshot(cdp) {
  return cdp.eval(`(() => {
    const e2e = window.__rcE2E;
    const rt = e2e?.runtime;
    const phys = rt?.physics;
    const app = e2e?.getAppState?.();
    const rec = rt?.networkReconciler;
    const bv = phys?.getBallStateView?.();
    const c0 = phys?.getCarStateView?.(0);
    const rv = rt?.modeManager?.modes?.get?.('freeplay')?.standaloneReplayViewer;
    return {
      matchMode: app?.matchMode ?? null,
      activeRoomActivity: app?.onlineSession?.activeRoomActivity ?? null,
      connectedPeersCount: app?.onlineSession?.connectedPeers?.length ?? 0,
      numCars: phys?.numCars ?? 0,
      activeCarMask: phys?.getActiveCarMask?.() ?? 0,
      ballPos: bv ? [Math.round(bv.posX), Math.round(bv.posY), Math.round(bv.posZ)] : null,
      car0Pos: c0 ? [Math.round(c0.posX), Math.round(c0.posY), Math.round(c0.posZ)] : null,
      tick: Math.floor(phys?.getHeaderView?.()?.tickCount ?? 0),
      replayPlaybackMode: Boolean(rec?.replayPlaybackMode),
      spectateMirrorMode: Boolean(rec?.spectateMirrorMode),
      clientInputEnabled: Boolean(rec?.clientInputEnabled),
      hardSnaps: rec?.hardSnapCount ?? 0,
      corrections: rec?.totalCorrections ?? 0,
      rvLoaded: Boolean(rv?.hasLoadedReplay),
      rvFrames: rv?.frames?.length ?? 0,
      rvCursor: Math.round(rv?.takeoverSubController?.cursor ?? -1),
      wsPlaybackPaused: Boolean(e2e?.getWorkspaceState?.()?.playbackPaused),
      wsPausedAtTick: e2e?.getWorkspaceState?.()?.pausedAtTick ?? 0,
    };
  })()`);
}

function resolveReplayFilePath() {
  const candidates = [
    process.env.RC_REPLAY_PATH,
    '/workspace/rc-replay-3v3-0-1-2026-11-17T05-00-24.RCReplay',
    path.resolve(process.cwd(), '../rc-replay-3v3-0-1-2026-11-17T05-00-24.RCReplay'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const startMs = Date.now();
  const server = await createServer({
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  const baseUrl = `http://127.0.0.1:${port}/?skipShaderPrewarm=1`;
  console.log(`[DevSyncRepro] Vite listening at ${baseUrl}`);

  const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const userDataDir = `/tmp/chrome-dev-sync-repro-${Date.now()}`;
  const chromeProc = spawn(
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
    const m = chunk.toString('utf8').match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) cdpPort = Number(m[1]);
  });

  const watchdog = setTimeout(() => {
    console.error('[DevSyncRepro] Watchdog timeout reached!');
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      // Ignore
    }
    process.exit(1);
  }, MAX_DURATION_MS);

  const scenarios = [];
  const recordScenario = (name, passed, detail) => {
    scenarios.push({ name, passed, detail });
    const tag = passed ? 'PASS' : 'REPRODUCED_BUG';
    console.log(`[DevSyncRepro] [${tag}] ${name}: ${JSON.stringify(detail)}`);
  };

  let hostCdp = null;
  let client1Cdp = null;
  let client2Cdp = null;

  try {
    await waitFor(() => cdpPort, 'Chrome CDP port', 15_000);
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const hostTarget = targets.find((t) => t.type === 'page');
    hostCdp = new CdpClient(hostTarget.webSocketDebuggerUrl, 'host');
    await hostCdp.connect();
    await waitFor(
      () => hostCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Host boot',
      45_000
    );

    // Host creates Developer Sync Room
    await hostCdp.eval(`window.__rcE2E.getAppState().openMenu('dev-under-development')`);
    await new Promise((r) => setTimeout(r, 300));
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((b) => /Create Developer Sync Room/i.test(b.textContent || ''))?.click();
    })()`);
    const roomId = await waitFor(
      () =>
        hostCdp.eval(
          `window.__rcE2E.getAppState().onlineSession?.isHosting && window.__rcE2E.getAppState().onlineSession?.roomId`
        ),
      'Host roomId',
      15_000
    );
    await hostCdp.eval(`window.__rcE2E.getAppState().closeMenu()`);

    // Client 1 joins
    const c1Target = await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(baseUrl)}`, {
        method: 'PUT',
      })
    ).json();
    client1Cdp = new CdpClient(c1Target.webSocketDebuggerUrl, 'client1');
    await client1Cdp.connect();
    await waitFor(
      () => client1Cdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client1 boot',
      45_000
    );
    await client1Cdp.eval(
      `window.__rcE2E.getAppState().bridge.onJoinOnlineWarmup({ roomId: ${JSON.stringify(roomId)}, playerName: 'Client1' })`
    );
    await waitFor(
      () => client1Cdp.eval(`window.__rcE2E.getAppState().onlineSession?.isDevSyncRoom`),
      'Client1 joined',
      15_000
    );

    // Scenario 1: Freeplay Live Driving Sync
    await hostCdp.send('Page.bringToFront');
    const fpBefore = await readSimSnapshot(hostCdp);
    await hostCdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys) { kb.keys['KeyW'] = true; kb.keys['ShiftLeft'] = true; }
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    })()`);
    await new Promise((r) => setTimeout(r, 1000));
    await hostCdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys) { kb.keys['KeyW'] = false; kb.keys['ShiftLeft'] = false; }
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    const fpHost = await readSimSnapshot(hostCdp);
    const fpClient = await readSimSnapshot(client1Cdp);
    const hostMoved =
      fpBefore.car0Pos &&
      fpHost.car0Pos &&
      Math.hypot(fpHost.car0Pos[0] - fpBefore.car0Pos[0], fpHost.car0Pos[1] - fpBefore.car0Pos[1]) >
        100;
    const fpDist =
      fpHost.car0Pos && fpClient.car0Pos
        ? Math.round(
            Math.hypot(
              fpHost.car0Pos[0] - fpClient.car0Pos[0],
              fpHost.car0Pos[1] - fpClient.car0Pos[1],
              fpHost.car0Pos[2] - fpClient.car0Pos[2]
            )
          )
        : -1;
    recordScenario(
      '1. Freeplay Live Driving Sync',
      Boolean(hostMoved && fpDist >= 0 && fpDist < 250),
      {
        hostMoved,
        hostCar0: fpHost.car0Pos,
        clientCar0: fpClient.car0Pos,
        dist: fpDist,
        hostSnaps: fpHost.hardSnaps,
        clientSnaps: fpClient.hardSnaps,
      }
    );

    // Scenario 2: Exhibition 3v3 Spectating
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartMatch('necto', 90, 'standard')`);
    await new Promise((r) => setTimeout(r, 2500));
    const exHost = await readSimSnapshot(hostCdp);
    const exClient = await readSimSnapshot(client1Cdp);
    recordScenario('2. Exhibition 3v3 Spectating', exHost.numCars === 6 && exClient.numCars === 6, {
      hostMode: exHost.matchMode,
      hostCars: exHost.numCars,
      clientMode: exClient.matchMode,
      clientCars: exClient.numCars,
      hostSnaps: exHost.hardSnaps,
      clientSnaps: exClient.hardSnaps,
    });

    // Scenario 3: Real 3v3 .RCReplay Load, Playback & Pause/ACK
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onReturnToFreeplay()`);
    await new Promise((r) => setTimeout(r, 400));
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartReplayViewer()`);
    await new Promise((r) => setTimeout(r, 400));

    const replayPath = resolveReplayFilePath();
    if (replayPath) {
      const b64 = fs.readFileSync(replayPath).toString('base64');
      await hostCdp.eval(`(async () => {
        const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
        const file = new File([bin], ${JSON.stringify(path.basename(replayPath))}, { type: 'application/octet-stream' });
        const rv = window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer;
        await rv.handleUploadFile(file);
        rv.startPlaying();
      })()`);
    } else {
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
    }
    await new Promise((r) => setTimeout(r, 1200));
    const repHost = await readSimSnapshot(hostCdp);
    const repClient = await readSimSnapshot(client1Cdp);
    const hasPauseAckProtocol = await client1Cdp.eval(
      `typeof window.__rcE2E.runtime?.networkReconciler?.sendPauseAck === 'function'`
    );
    const replayBallDist =
      repHost.ballPos && repClient.ballPos
        ? Math.round(
            Math.hypot(
              repHost.ballPos[0] - repClient.ballPos[0],
              repHost.ballPos[1] - repClient.ballPos[1],
              repHost.ballPos[2] - repClient.ballPos[2]
            )
          )
        : -1;
    recordScenario(
      '3. Real 3v3 RCReplay Load & Playback + Pause ACK',
      repHost.numCars === 6 && repClient.numCars === 6 && hasPauseAckProtocol,
      {
        replaySource: replayPath ? path.basename(replayPath) : 'synthetic-6car',
        hostCars: repHost.numCars,
        clientCars: repClient.numCars,
        hostCursor: repHost.rvCursor,
        hostBall: repHost.ballPos,
        clientBall: repClient.ballPos,
        ballDist: replayBallDist,
        hasPauseAckProtocol,
      }
    );

    // Scenario 4: Static Training Pack Sync
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onReturnToFreeplay()`);
    await new Promise((r) => setTimeout(r, 400));
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartStaticTrainingPack()`);
    await new Promise((r) => setTimeout(r, 1000));
    const trHost = await readSimSnapshot(hostCdp);
    const trClient = await readSimSnapshot(client1Cdp);
    const trCarDist =
      trHost.car0Pos && trClient.car0Pos
        ? Math.round(
            Math.hypot(
              trHost.car0Pos[0] - trClient.car0Pos[0],
              trHost.car0Pos[1] - trClient.car0Pos[1],
              trHost.car0Pos[2] - trClient.car0Pos[2]
            )
          )
        : -1;
    recordScenario(
      '4. Static Training Pack Pose Sync',
      trHost.matchMode === 'static-training-pack' && trCarDist >= 0 && trCarDist < 150,
      {
        hostMode: trHost.matchMode,
        hostCar0: trHost.car0Pos,
        clientMode: trClient.matchMode,
        clientCar0: trClient.car0Pos,
        carDist: trCarDist,
      }
    );

    // Scenario 5: Multi-Client (2 Clients) Broadcast
    const c2Target = await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(baseUrl)}`, {
        method: 'PUT',
      })
    ).json();
    client2Cdp = new CdpClient(c2Target.webSocketDebuggerUrl, 'client2');
    await client2Cdp.connect();
    await waitFor(
      () => client2Cdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client2 boot',
      45_000
    );
    await client2Cdp.eval(
      `window.__rcE2E.getAppState().bridge.onJoinOnlineWarmup({ roomId: ${JSON.stringify(roomId)}, playerName: 'Client2' })`
    );
    await new Promise((r) => setTimeout(r, 1500));
    const mcHost = await readSimSnapshot(hostCdp);
    const mcC2 = await readSimSnapshot(client2Cdp);
    recordScenario(
      '5. Multi-Client (2+ Clients) Dev Sync Room',
      mcHost.connectedPeersCount >= 2 && mcC2.matchMode === mcHost.matchMode,
      {
        hostConnectedPeers: mcHost.connectedPeersCount,
        hostMode: mcHost.matchMode,
        client2Mode: mcC2.matchMode,
        client2Car0: mcC2.car0Pos,
      }
    );

    // Scenario 6: Client Input Handover
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onReturnToFreeplay()`);
    await new Promise((r) => setTimeout(r, 400));
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onSetClientInputEnabled?.(true)`);
    await new Promise((r) => setTimeout(r, 400));
    const ciBefore = await readSimSnapshot(hostCdp);
    await client1Cdp.send('Page.bringToFront');
    await client1Cdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys) { kb.keys['KeyW'] = true; }
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    await client1Cdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys) { kb.keys['KeyW'] = false; }
    })()`);
    const ciHost = await readSimSnapshot(hostCdp);
    const ciClient = await readSimSnapshot(client1Cdp);
    const clientMovedHost =
      ciBefore.car0Pos &&
      ciHost.car0Pos &&
      Math.hypot(ciHost.car0Pos[0] - ciBefore.car0Pos[0], ciHost.car0Pos[1] - ciBefore.car0Pos[1]) >
        50;
    recordScenario('6. Client Input Handover (clientInputEnabled=true)', Boolean(clientMovedHost), {
      clientInputEnabledOnClient: ciClient.clientInputEnabled,
      hostCar0Before: ciBefore.car0Pos,
      hostCar0After: ciHost.car0Pos,
      clientCar0After: ciClient.car0Pos,
    });

    const reproducedCount = scenarios.filter((s) => !s.passed).length;
    const report = {
      passedAll: reproducedCount === 0,
      reproducedBugs: reproducedCount,
      totalScenarios: scenarios.length,
      durationMs: Date.now() - startMs,
      scenarios,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.log(
      `[DevSyncRepro] Report written to ${OUT_PATH} (passed=${scenarios.length - reproducedCount}/${scenarios.length}, reproducedBugs=${reproducedCount})`
    );
    if (!REPORT_ONLY && reproducedCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(watchdog);
    hostCdp?.close();
    client1Cdp?.close();
    client2Cdp?.close();
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      // Ignore
    }
    await server.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Ignore transient Chrome shutdown file locks
    }
  }
}

main().catch((err) => {
  console.error('[DevSyncRepro] FAILED:', err);
  process.exit(1);
});
