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
import { createSoftTimeoutWatchdog } from './lib/softTimeoutWatchdog.mjs';

if (!process.env.RC_VITE_ROLE) {
  process.env.RC_VITE_ROLE = 'rc-http';
}

const OUT_PATH = '/tmp/dev-sync-repro-report.json';
const CHECKPOINT_PATH =
  process.env.RC_REPRO_CHECKPOINT_FILE || '/tmp/dev-sync-repro-checkpoint.json';
const REPORT_ONLY = process.argv.includes('--report-only');
const RESUME_MODE =
  process.argv.includes('--resume') || process.env.RC_REPRO_RESUME === '1';
const FROM_ARG = process.argv.find((a) => a.startsWith('--from='));
const EXPLICIT_FROM = FROM_ARG
  ? Number(FROM_ARG.split('=')[1])
  : process.env.RC_REPRO_FROM
    ? Number(process.env.RC_REPRO_FROM)
    : null;

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

  send(method, params = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${this.label} ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
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

  const scenarios = [];
  const watchdog = createSoftTimeoutWatchdog({
    label: 'DevSyncRepro',
    exitCode: 1,
    onTimeout: async () => {
      try {
        const reproducedCount = scenarios.filter((s) => !s.passed).length;
        fs.writeFileSync(
          OUT_PATH,
          JSON.stringify(
            {
              passedAll: false,
              timedOut: true,
              reproducedBugs: reproducedCount,
              totalScenarios: scenarios.length,
              durationMs: Date.now() - startMs,
              scenarios,
            },
            null,
            2
          )
        );
      } catch {
        // Ignore
      }
      try {
        chromeProc.kill('SIGKILL');
      } catch {
        // Ignore
      }
      await server.close().catch(() => {});
    },
  });
  let fromScenario = EXPLICIT_FROM && EXPLICIT_FROM >= 1 ? EXPLICIT_FROM : 1;
  if ((RESUME_MODE || EXPLICIT_FROM) && fs.existsSync(CHECKPOINT_PATH)) {
    try {
      const ck = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
      const saved = Array.isArray(ck?.scenarios) ? ck.scenarios : [];
      const keepBefore = EXPLICIT_FROM ? EXPLICIT_FROM - 1 : saved.length;
      for (const item of saved.slice(0, keepBefore)) {
        scenarios.push(item);
      }
      if (!EXPLICIT_FROM) {
        fromScenario = scenarios.length + 1;
      }
      console.log(
        `[DevSyncRepro] Resuming from Scenario ${fromScenario} (loaded ${scenarios.length} checkpointed scenarios from ${CHECKPOINT_PATH})`
      );
    } catch {
      // Ignore corrupt checkpoint
    }
  }
  const recordScenario = (name, passed, detail) => {
    scenarios.push({ name, passed, detail });
    try {
      fs.writeFileSync(
        CHECKPOINT_PATH,
        JSON.stringify({ updatedAt: new Date().toISOString(), scenarios }, null, 2)
      );
    } catch {
      // Ignore checkpoint write errors
    }
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

    // Client 1 joins (separate window so Chrome does not throttle rAF)
    const { targetId: c1TargetId } = await hostCdp.send('Target.createTarget', {
      url: baseUrl,
      newWindow: true,
    });
    const c1Targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const c1Target = c1Targets.find((t) => t.id === c1TargetId);
    client1Cdp = new CdpClient(c1Target.webSocketDebuggerUrl, 'client1');
    await client1Cdp.connect();
    await waitFor(
      () => client1Cdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client1 boot',
      90_000
    );
    await client1Cdp.eval(
      `window.__rcE2E.getAppState().bridge.onJoinOnlineWarmup({ roomId: ${JSON.stringify(roomId)}, playerName: 'Client1' })`
    );
    await waitFor(
      () => client1Cdp.eval(`window.__rcE2E.getAppState().onlineSession?.isDevSyncRoom`),
      'Client1 joined',
      15_000
    );

    if (fromScenario <= 1) {
    // Scenario 1: Freeplay Live Driving Sync + Remote Input Overlay
    await hostCdp.send('Page.bringToFront');
    const fpBefore = await readSimSnapshot(hostCdp);
    await hostCdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys?.add) { kb.keys.add('KeyW'); kb.keys.add('ShiftLeft'); }
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    })()`);
    await new Promise((r) => setTimeout(r, 1000));
    const fpClientOverlay = await client1Cdp
      .eval(
        `(() => {
      return window.__rcE2E.getKeyboardInputOverlayTelemetry?.() ?? null;
    })()`
      )
      .catch(() => null);
    await hostCdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys?.delete) { kb.keys.delete('KeyW'); kb.keys.delete('ShiftLeft'); }
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
    })()`);
    await new Promise((r) => setTimeout(r, 450));
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
        fpClientOverlay,
        hostSnaps: fpHost.hardSnaps,
        clientSnaps: fpClient.hardSnaps,
      }
    );

    }

    if (fromScenario <= 2) {
    // Scenario 2: Exhibition 3v3 Spectating + 3-2-1 Countdown
    await client1Cdp.eval(`(() => {
      window.__exCdLog = [];
      let lastCd = null;
      if (typeof window.__rcE2E.subscribeHudState === 'function') {
        window.__exCdUnsub = window.__rcE2E.subscribeHudState((hs) => {
          const cd = hs?.matchPhase === 'kickoff' ? hs?.kickoffCountdown : 0;
          if (cd > 0 && cd !== lastCd) {
            lastCd = cd;
            window.__exCdLog.push(cd);
          }
          if (hs?.matchPhase === 'playing') {
            window.__exCdDone = true;
          }
        });
      } else {
        window.__exCdTimer = setInterval(() => {
          const ms = window.__rcE2E.runtime?.match?.state;
          const cd = ms?.phase === 'kickoff' ? ms.countdown : 0;
          if (cd > 0 && cd !== lastCd) {
            lastCd = cd;
            window.__exCdLog.push(cd);
          }
          if (ms?.phase === 'playing') {
            window.__exCdDone = true;
          }
        }, 50);
      }
    })()`);
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartMatch('necto', 90, 'standard')`);
    await waitFor(
      () => client1Cdp.eval(`Boolean(window.__exCdDone && (window.__exCdLog?.length || 0) >= 3)`),
      'Client1 completes 3-2-1 countdown',
      10_000,
      100
    ).catch(() => {});
    const clientCountdownNums = await client1Cdp.eval(`(() => {
      if (window.__exCdTimer) clearInterval(window.__exCdTimer);
      if (window.__exCdUnsub) window.__exCdUnsub();
      return window.__exCdLog || [];
    })()`);
    const exHost = await readSimSnapshot(hostCdp);
    const exClient = await readSimSnapshot(client1Cdp);
    const exHas321 = [3, 2, 1].every((n) => clientCountdownNums.includes(n));
    recordScenario(
      '2. Exhibition 3v3 Spectating & 3-2-1 Countdown',
      exHost.numCars === 6 && exClient.numCars === 6 && exHas321,
      {
        hostMode: exHost.matchMode,
        hostCars: exHost.numCars,
        clientMode: exClient.matchMode,
        clientCars: exClient.numCars,
        clientCountdownNums,
        hostSnaps: exHost.hardSnaps,
        clientSnaps: exClient.hardSnaps,
      }
    );

    }

    if (fromScenario <= 3) {
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
        const phys = window.__rcE2E.runtime.physics;
        const rv = window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer;
        for (let c = 0; c < 6; c++) {
          if (!phys.isCarSlotActive?.(c)) phys.addCarAtSlot?.(c, c % 2, 'octane');
        }
        const frames = [];
        for (let f = 0; f < 300; f++) {
          phys.step?.(1 / 120);
          const snap = new Float32Array(phys.saveCompactState?.() ?? phys.saveState?.());
          snap[0] = f + 1;
          snap[4] = (f - 150) * 10; // move ball X visibly across frames
          snap[5] = 0;
          snap[6] = 93;
          frames.push(snap);
        }
        rv.frames = frames;
        rv.hasLoadedReplay = true;
        rv.takeoverSubController.cursor = 0;
        rv.startPlaying();
      })()`);
    }
    await new Promise((r) => setTimeout(r, 800));
    const repHostPlay = await readSimSnapshot(hostCdp);
    const repClientPlay = await readSimSnapshot(client1Cdp);
    await hostCdp.eval(
      `window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer.pausePlaying()`
    );
    await waitFor(
      () =>
        hostCdp.eval(`(() => {
          const pac = window.__rcE2E.getMultiplayerSession?.()?.hostController?.pauseAckController;
          return Boolean(pac?.paused && pac?.unackedPeers?.size === 0);
        })()`),
      'Replay Pause ACK from Client1',
      5_000
    ).catch(() => {});
    const pauseAckState = await hostCdp.eval(`(() => {
      const pac = window.__rcE2E.getMultiplayerSession?.()?.hostController?.pauseAckController;
      return { paused: Boolean(pac?.paused), unacked: pac?.unackedPeers?.size ?? -1 };
    })()`);
    await hostCdp.eval(
      `window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer.seekFrame(240)`
    );
    await new Promise((r) => setTimeout(r, 200));
    await client1Cdp.send('Page.bringToFront');
    await new Promise((r) => setTimeout(r, 400));
    const repHostSeek = await readSimSnapshot(hostCdp);
    const repClientSeek = await readSimSnapshot(client1Cdp);
    await hostCdp.send('Page.bringToFront');
    await hostCdp.eval(
      `window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer.startPlaying()`
    );
    await new Promise((r) => setTimeout(r, 400));
    const repHostResume = await readSimSnapshot(hostCdp);
    const hasPauseAckProtocol = await client1Cdp.eval(
      `typeof window.__rcE2E.runtime?.networkReconciler?.sendPauseAck === 'function'`
    );
    const seekBallDist =
      repHostSeek.ballPos && repClientSeek.ballPos
        ? Math.round(
            Math.hypot(
              repHostSeek.ballPos[0] - repClientSeek.ballPos[0],
              repHostSeek.ballPos[1] - repClientSeek.ballPos[1],
              repHostSeek.ballPos[2] - repClientSeek.ballPos[2]
            )
          )
        : -1;
    let clientReplayDom = null;
    await waitFor(
      async () => {
        clientReplayDom = await client1Cdp.eval(`(() => {
          const sb = document.querySelector('[data-alpha-id*="StepperScoreboardHUD"]');
          const cards = Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]')).filter(
            (el) => getComputedStyle(el).display !== 'none'
          );
          const app = window.__rcE2E.getAppState?.();
          return {
            domScoreboard: Boolean(sb),
            domRosterCards: cards.length,
            matchMode: app?.matchMode ?? null,
            activeRoomActivity: app?.onlineSession?.activeRoomActivity ?? null,
          };
        })()`);
        return clientReplayDom.domScoreboard && clientReplayDom.domRosterCards >= 6;
      },
      'Client1 replay HUD + 6 roster cards',
      5_000,
      150
    ).catch(() => {});
    recordScenario(
      '3. Real 3v3 RCReplay Load & Playback + Pause ACK + Seek + Resume + HUD',
      repHostPlay.numCars === 6 &&
        repClientPlay.numCars === 6 &&
        repHostPlay.rvCursor > 0 &&
        pauseAckState.paused === true &&
        pauseAckState.unacked === 0 &&
        seekBallDist >= 0 &&
        seekBallDist < 100 &&
        repHostResume.rvCursor > repHostSeek.rvCursor &&
        hasPauseAckProtocol &&
        clientReplayDom.domScoreboard === true &&
        clientReplayDom.domRosterCards >= 6,
      {
        replaySource: replayPath ? path.basename(replayPath) : 'synthetic-300f-6car',
        hostCars: repHostPlay.numCars,
        clientCars: repClientPlay.numCars,
        cursorPlay: repHostPlay.rvCursor,
        cursorSeek: repHostSeek.rvCursor,
        cursorResume: repHostResume.rvCursor,
        pauseAckState,
        seekBallDist,
        hasPauseAckProtocol,
        clientReplayDom,
      }
    );

    }

    if (fromScenario <= 4) {
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
    } else if (fromScenario === 5) {
      await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartStaticTrainingPack()`);
      await new Promise((r) => setTimeout(r, 800));
    }

    // Scenario 5: Multi-Client (2 Clients) Broadcast
    const { targetId: c2TargetId } = await hostCdp.send('Target.createTarget', {
      url: baseUrl,
      newWindow: false,
    });
    const c2Targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const c2Target = c2Targets.find((t) => t.id === c2TargetId);
    client2Cdp = new CdpClient(c2Target.webSocketDebuggerUrl, 'client2');
    await client2Cdp.connect();
    await waitFor(
      () => client2Cdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client2 boot',
      90_000
    );
    await client2Cdp.eval(
      `window.__rcE2E.getAppState().bridge.onJoinOnlineWarmup({ roomId: ${JSON.stringify(roomId)}, playerName: 'Client2' })`
    );
    await waitFor(
      async () => {
        const s = await readSimSnapshot(client2Cdp);
        return s.matchMode === 'static-training-pack';
      },
      'Client2 workspace sync',
      5_000
    ).catch(() => {});
      const mcHost = await readSimSnapshot(hostCdp);
      const mcC2 = await readSimSnapshot(client2Cdp);
      if (fromScenario <= 5) {
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
      }

    if (fromScenario <= 6) {
    // Scenario 6: Client Input Handover
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onReturnToFreeplay()`);
    await new Promise((r) => setTimeout(r, 400));
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onSetClientInputEnabled?.(true)`);
    await waitFor(
      () =>
        client1Cdp.eval(`Boolean(window.__rcE2E.runtime?.networkReconciler?.clientInputEnabled)`),
      'Client1 input authority',
      5_000
    ).catch(() => {});
    const ciBefore = await readSimSnapshot(hostCdp);
    await client1Cdp.send('Page.bringToFront');
    await client1Cdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys?.add) { kb.keys.add('KeyW'); kb.keys.add('ShiftLeft'); }
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    await client1Cdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys?.delete) { kb.keys.delete('KeyW'); kb.keys.delete('ShiftLeft'); }
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
    })()`);
    await hostCdp.send('Page.bringToFront');
    await waitFor(
      async () => {
        const s = await readSimSnapshot(hostCdp);
        return (
          ciBefore.car0Pos &&
          s.car0Pos &&
          Math.hypot(s.car0Pos[0] - ciBefore.car0Pos[0], s.car0Pos[1] - ciBefore.car0Pos[1]) > 50
        );
      },
      'Host receives Client1 driving position',
      3_000
    ).catch(() => {});
    const ciHost = await readSimSnapshot(hostCdp);
    const ciClient = await readSimSnapshot(client1Cdp);
    const hostAuthDebug = await hostCdp.eval(`(() => {
      const ha = window.__rcE2E.getMultiplayerSession?.()?.hostController?.inputAuthority;
      return {
        activeInputPeerId: ha?.activeInputPeerId ?? null,
        authorityEpoch: ha?.authorityEpoch ?? -1,
        clientInputEnabled: Boolean(ha?.clientInputEnabled),
        hasLatestFrame: Boolean(ha?.latestFrame),
      };
    })()`);
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
      hostAuthDebug,
    });

    }

    if (fromScenario <= 7) {
    // Scenario 7: Dynamic Training Pack Shot & Reset Sync
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onSetClientInputEnabled?.(false)`);
    await hostCdp.eval(`(() => {
      const rt = window.__rcE2E.runtime;
      const app = window.__rcE2E.getAppState();
      app.setMatchMode?.('dynamic-training-pack');
      if (rt?.match?.state) rt.match.state.mode = 'dynamic-training-pack';
      rt?.modeManager?.setMode?.('dynamic-training-pack');
      const dyn = rt?.modeManager?.modes?.get?.('dynamic-training-pack');
      if (dyn) {
        const session = {
          id: 'e2e-dyn-sess',
          name: 'E2E Session',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sourceKind: 'replay-capture',
          sourceFrame120Hz: 0,
          prerollStartFrame120Hz: 0,
          originEndFrame120Hz: 0,
          interveneLocalFrameIndex: 0,
          durationSeconds: 1,
          tickRate: 120,
          defaultPovSlotIndex: 0,
          roster: [{ slotIndex: 0, team: 0, name: 'Player', presetId: 'octane' }],
          frames: [{
            timeSeconds: 0,
            ballPos: [350, -800, 120],
            ballRot: [0, 0, 0, 1],
            ballVel: [0, 0, 0],
            ballAngVel: [0, 0, 0],
            boostPadCooldowns: [],
            cars: [{
              slotIndex: 0,
              entityActive: true,
              pos: [-400, -1800, 17],
              rot: [0, 0, 0, 1],
              vel: [0, 0, 0],
              angVel: [0, 0, 0],
              boostAmount: 33,
              isOnGround: true,
              isSupersonic: false,
              hasFlipOrJump: true,
              airTimeSinceJump: 0,
              activeFlags: [false, false, false, false],
              controls: [0, 0, 0, 0, 0, false, false, false],
            }],
          }],
        };
        const shot = {
          id: 'e2e-dyn-shot',
          name: 'E2E Shot',
          sessionId: 'e2e-dyn-sess',
          povSlotIndex: 0,
          interveneOffsetFrames: 0,
          perCarTakeover: { 0: { mode: 'player' } },
          timeoutSeconds: 10,
        };
        dyn.startShot(shot, session);
      }
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    const dynHost = await readSimSnapshot(hostCdp);
    const dynC1 = await readSimSnapshot(client1Cdp);
    const dynC2 = await readSimSnapshot(client2Cdp);
    const dynDist1 =
      dynHost.car0Pos && dynC1.car0Pos
        ? Math.round(
            Math.hypot(dynHost.car0Pos[0] - dynC1.car0Pos[0], dynHost.car0Pos[1] - dynC1.car0Pos[1])
          )
        : -1;
    recordScenario(
      '7. Dynamic Training Pack Shot & Multi-Client Sync',
      dynHost.matchMode === 'dynamic-training-pack' &&
        dynC1.matchMode === 'dynamic-training-pack' &&
        dynC2.matchMode === 'dynamic-training-pack' &&
        dynDist1 >= 0 &&
        dynDist1 < 150,
      {
        hostMode: dynHost.matchMode,
        c1Mode: dynC1.matchMode,
        c2Mode: dynC2.matchMode,
        dynDist1,
      }
    );

    }

    if (fromScenario <= 8) {
    // Scenario 8: 1 Host + 2 Client Telestrator (0x05) Bidirectional Sync & Permission Gating
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onReturnToFreeplay()`);
    await new Promise((r) => setTimeout(r, 300));
    await hostCdp.eval(`(() => {
      window.__rcE2E.runtime?.telestratorOverlay?.telestrator?.clearAll?.();
      window.__rcE2E.getWorkspaceState?.().setTelestratorPermission?.('host_only');
      window.__rcE2E.getAppState().bridge.onBroadcastGlobalWorkspace?.({});
    })()`);
    await client1Cdp.eval(`window.__rcE2E.runtime?.telestratorOverlay?.telestrator?.clearAll?.()`);
    await client2Cdp.eval(`window.__rcE2E.runtime?.telestratorOverlay?.telestrator?.clearAll?.()`);
    await new Promise((r) => setTimeout(r, 300));
    const c1BlockedWhenHostOnly = await client1Cdp.eval(
      `!window.__rcE2E.getTelestratorState().allowClientDrawing`
    );
    await hostCdp.eval(`(() => {
      window.__rcE2E.getWorkspaceState?.().setTelestratorPermission?.('everyone');
      window.__rcE2E.getAppState().bridge.onBroadcastGlobalWorkspace?.({});
    })()`);
    await waitFor(
      () => client1Cdp.eval(`Boolean(window.__rcE2E.getTelestratorState().allowClientDrawing)`),
      'Client1 telestrator permission=everyone',
      5_000
    );
    await client1Cdp.send('Page.bringToFront');
    await client1Cdp.eval(`window.__rcE2E.getTelestratorState().setOverlayActive?.(true)`);
    await new Promise((r) => setTimeout(r, 200));
    await client1Cdp.eval(`window.__rcE2E.getTelestratorState().setDrawingEnabled?.(true)`);
    await client1Cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 640,
      y: 480,
      button: 'left',
      clickCount: 1,
    });
    await client1Cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 760,
      y: 480,
      button: 'left',
    });
    await new Promise((r) => setTimeout(r, 120));
    await client1Cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 760,
      y: 480,
      button: 'left',
      clickCount: 1,
    });
    await client1Cdp.eval(`(() => {
      const ts = window.__rcE2E.getTelestratorState();
      ts.setDrawingEnabled?.(false);
      ts.setOverlayActive?.(false);
    })()`);
    await hostCdp.send('Page.bringToFront');
    await waitFor(
      () =>
        Promise.all([
          hostCdp.eval(`(window.__rcE2E.getTelestratorState().strokeCount ?? 0) >= 1`),
          client2Cdp.eval(`(window.__rcE2E.getTelestratorState().strokeCount ?? 0) >= 1`),
        ]).then(([h, c2]) => h && c2),
      'Host & Client2 receive Client1 telestrator stroke',
      5_000
    ).catch(() => {});
    const c1Diag = await client1Cdp.eval(`({
      dump: window.__rcTelestratorDiag?.getDump?.()?.slice?.(-3) ?? window.__rcTelestratorDiag?.getDump?.() ?? null,
      probe: window.__rcTelestratorDiag?.probeAt?.(640, 480) ?? null,
    })`);
    const teleCounts = {
      host: await hostCdp.eval(`window.__rcE2E.getTelestratorState().strokeCount ?? 0`),
      c1: await client1Cdp.eval(`window.__rcE2E.getTelestratorState().strokeCount ?? 0`),
      c2: await client2Cdp.eval(`window.__rcE2E.getTelestratorState().strokeCount ?? 0`),
    };
    recordScenario(
      '8. 1 Host + 2 Client Telestrator (0x05) Sync & Gating',
      c1BlockedWhenHostOnly && teleCounts.host >= 1 && teleCounts.c1 >= 1 && teleCounts.c2 >= 1,
      { c1BlockedWhenHostOnly, teleCounts, c1Diag }
    );

    }

    if (fromScenario <= 9) {
    // Scenario 9: Edge-Triggered Authority Camera Sync & Non-Override + FPV 300ms Idle Handover
    await hostCdp.eval(`(() => {
      const cam = window.__rcE2E.getCamera();
      if (cam) cam.ballCam = true;
    })()`);
    await new Promise((r) => setTimeout(r, 200));
    await hostCdp.eval(`(() => {
      const cam = window.__rcE2E.getCamera();
      if (cam) cam.ballCam = false;
    })()`);
    await waitFor(
      () =>
        Promise.all([
          client1Cdp.eval(`window.__rcE2E.getCamera()?.ballCam === false`),
          client2Cdp.eval(`window.__rcE2E.getCamera()?.ballCam === false`),
        ]).then(([a, b]) => a && b),
      'Clients follow Host Car Cam switch',
      5_000
    ).catch(() => {});
    const c1AfterHostSwitch = await client1Cdp.eval(`window.__rcE2E.getCamera()?.ballCam`);
    await client1Cdp.eval(`(() => {
      const cam = window.__rcE2E.getCamera();
      if (cam) cam.ballCam = true;
    })()`);
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onBroadcastGlobalWorkspace?.({})`);
    await new Promise((r) => setTimeout(r, 300));
    const c1PreservedLocalCam = await client1Cdp.eval(
      `window.__rcE2E.getCamera()?.ballCam === true`
    );
    await hostCdp.eval(`(() => {
      const cam = window.__rcE2E.getCamera();
      if (cam) cam.ballCam = true;
    })()`);
    await waitFor(
      () => client2Cdp.eval(`window.__rcE2E.getCamera()?.ballCam === true`),
      'Client2 follows Host back to Ball Cam',
      5_000
    ).catch(() => {});
    const c2FollowedBack = await client2Cdp.eval(`window.__rcE2E.getCamera()?.ballCam === true`);

    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onSetClientInputEnabled?.(true)`);
    await new Promise((r) => setTimeout(r, 250));
    await hostCdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      kb?.keys?.add?.('KeyW');
    })()`);
    await new Promise((r) => setTimeout(r, 150));
    const authAfterPreempt = await hostCdp.eval(
      `window.__rcE2E.getMultiplayerSession?.()?.hostController?.inputAuthority?.activeInputPeerId`
    );
    await hostCdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      kb?.keys?.delete?.('KeyW');
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const authAfterIdle = await hostCdp.eval(
      `window.__rcE2E.getMultiplayerSession?.()?.hostController?.inputAuthority?.activeInputPeerId`
    );
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onSetClientInputEnabled?.(false)`);
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartMatch('necto', 90, 'standard')`);
    await waitFor(
      () => client2Cdp.eval(`Boolean(window.__rcE2E.runtime?.arena?.cars?.[2]?.visible)`),
      'Client2 6-car arena visible for camera focus switch',
      10_000
    ).catch(() => {});
    await hostCdp.eval(`(() => {
      const probe = window.__rcE2E.runtime?.networkManager?.diagnosticsProbe;
      if (probe) probe.diagnosticObservationTarget = 2;
      const cam = window.__rcE2E.getCamera();
      if (cam?.setFocusedCarIndex) cam.setFocusedCarIndex(2);
      else if (cam) cam.focusedCarIndex = 2;
    })()`);
    await waitFor(
      () => client2Cdp.eval(`window.__rcE2E.getCamera()?.focusedCarIndex === 2`),
      'Client2 follows Host focusedCarIndex=2',
      5_000
    ).catch(() => {});
    const c2FocusedAfterSwitch = await client2Cdp.eval(
      `window.__rcE2E.getCamera()?.focusedCarIndex ?? -1`
    );
    await hostCdp.eval(`(() => {
      const probe = window.__rcE2E.runtime?.networkManager?.diagnosticsProbe;
      if (probe) probe.diagnosticObservationTarget = 0;
      const cam = window.__rcE2E.getCamera();
      if (cam?.setFocusedCarIndex) cam.setFocusedCarIndex(0);
      else if (cam) cam.focusedCarIndex = 0;
    })()`);

    recordScenario(
      '9. Edge-Triggered Authority Camera Sync & FPV 300ms Idle Handover',
      c1AfterHostSwitch === false &&
        c1PreservedLocalCam === true &&
        c2FollowedBack === true &&
        c2FocusedAfterSwitch === 2 &&
        authAfterPreempt === 'host' &&
        authAfterIdle !== 'host',
      {
        c1AfterHostSwitch,
        c1PreservedLocalCam,
        c2FollowedBack,
        c2FocusedAfterSwitch,
        authAfterPreempt,
        authAfterIdle,
      }
    );
    }

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
    watchdog.dispose();
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
