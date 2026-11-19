#!/usr/bin/env node
/**
 * scripts/runDevBroadcastReproV3.mjs
 *
 * Headless Chrome E2E reproduction suite for Developer Broadcasting (Dev Sync Room),
 * Replay Watch Together, Physics Lookahead Smoothness, Boost State Flicker, and
 * Memory Footprint / Close Retention.
 *
 * Scenarios:
 * 1. bug-1-goal-replay-client-no-motion:
 *    Client enters Goal Replay and exits cleanly, but during Goal Replay the ball/cars
 *    have no motion (or replayTimelineController has 0 frames) because Spectating and
 *    match cinematic Goal Replay are not wired together.
 * 2. bug-2-replay-watch-together-nametag-unsynced:
 *    Replay Watch Together syncs UI roster/scoreboard, but 3D in-world NameTags
 *    (nameTagTunerStore.carEntries / VehicleNameTagSystem) are not synced on Client.
 * 3. bug-3-broadcast-choppy-state-only-no-physics-lookahead:
 *    Client broadcast playback only applies state snapshots (no deterministic physics
 *    lookahead stepping from buffered frames), causing zero-delta frames / jitter.
 * 4. bug-4-boost-state-flicker-every-frame:
 *    Boost state (boost pads, car isBoosting / boost meter) flickers frame-by-frame
 *    during broadcast / replay watch together.
 * 5. bug-5-memory-footprint-and-close-retention:
 *    Measures post-boot memory, WebGL geometries/textures/programs, WASM linear memory,
 *    and post-dispose retained heap/DOM/WebGL resources.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

if (!process.env.RC_VITE_ROLE) {
  process.env.RC_VITE_ROLE = 'rc-http';
}

const OUT_PATH = '/tmp/dev-broadcast-repro-v3.json';
const MAX_DURATION_MS = 240_000;

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
    await this.send('Performance.enable');
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${this.label} timeout on ${method}`));
        }
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
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

async function waitFor(fn, label, timeoutMs = 30_000, intervalMs = 400) {
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

function resolveReplayFilePath() {
  const candidates = [
    process.env.RC_REPLAY_PATH,
    '/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
    '/workspace/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
    path.resolve(process.cwd(), '../rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function collectCdpMemorySample(cdp) {
  const runtimeStats = await cdp.eval(`(() => {
    const e2e = window.__rcE2E;
    const r = e2e?.runtime;
    const rendererInfo = r?.renderer?.info;
    const wasmMem = r?.physics?.wasmModule?.HEAPU8?.buffer?.byteLength ?? r?.physics?.module?.HEAPU8?.buffer?.byteLength ?? 0;
    const replayFrames = r?.physics?.getReplayFrameCount?.() ?? 0;
    const mem = performance.memory ? {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
    } : null;
    return {
      jsHeapUsedMB: mem ? Math.round((mem.usedJSHeapSize / (1024 * 1024)) * 10) / 10 : 0,
      jsHeapTotalMB: mem ? Math.round((mem.totalJSHeapSize / (1024 * 1024)) * 10) / 10 : 0,
      domNodes: document.getElementsByTagName('*').length,
      wasmMemoryBytes: wasmMem,
      replayBufferFrames: replayFrames,
      geometries: rendererInfo?.memory?.geometries ?? null,
      textures: rendererInfo?.memory?.textures ?? null,
      programs: rendererInfo?.programs?.length ?? null,
      isRunning: Boolean(r?.running),
    };
  })()`);
  return runtimeStats;
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
  console.error(`[DevBroadcastReproV3] Vite listening at ${baseUrl}`);

  const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const userDataDir = `/tmp/chrome-dev-broadcast-repro-v3-${Date.now()}`;
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
    console.error('[DevBroadcastReproV3] Watchdog timeout reached!');
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      // Ignore
    }
    process.exit(2);
  }, MAX_DURATION_MS);

  const results = [];
  const record = (id, title, reproduced, detail) => {
    results.push({ id, title, reproduced, detail });
    const tag = reproduced ? 'REPRODUCED_BUG' : 'PASS_FIXED';
    console.error(`[DevBroadcastReproV3] [${tag}] ${id}: ${title} -> ${JSON.stringify(detail)}`);
  };

  let hostCdp = null;
  let clientCdp = null;

  try {
    await waitFor(() => cdpPort, 'Chrome CDP port', 15_000);
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const hostTarget = targets.find((t) => t.type === 'page');
    hostCdp = new CdpClient(hostTarget.webSocketDebuggerUrl, 'host');
    await hostCdp.connect();
    console.error('[DevBroadcastReproV3] Waiting for Host boot...');
    await waitFor(
      () => hostCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Host boot',
      60_000
    );
    console.error('[DevBroadcastReproV3] Host booted, collecting memory sample...');
    const hostPostBootMem = await collectCdpMemorySample(hostCdp);
    console.error('[DevBroadcastReproV3] hostPostBootMem:', JSON.stringify(hostPostBootMem));

    // Host creates Developer Sync Room (defaults to Freeplay)
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
      'Host room creation',
      15_000
    );
    console.error('[DevBroadcastReproV3] Room created:', roomId);
    await hostCdp.eval(`window.__rcE2E.getAppState().closeMenu()`);

    // Open Client in separate window so Chrome does not throttle rAF
    console.error('[DevBroadcastReproV3] Creating Client target...');
    const { targetId: clientTargetId } = await hostCdp.send('Target.createTarget', {
      url: baseUrl,
      newWindow: true,
    });
    console.error('[DevBroadcastReproV3] Client target created:', clientTargetId);
    const allTargets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const clientTarget = allTargets.find((t) => t.id === clientTargetId);
    clientCdp = new CdpClient(clientTarget.webSocketDebuggerUrl, 'client');
    await clientCdp.connect();
    await hostCdp.eval(`window.__rcE2E.runtime.stop()`);
    console.error('[DevBroadcastReproV3] Waiting for Client boot...');
    await waitFor(
      () => clientCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client boot',
      90_000
    );
    await hostCdp.eval(`window.__rcE2E.runtime.start()`);
    console.error('[DevBroadcastReproV3] Client booted, joining room...');
    await clientCdp.eval(
      `window.__rcE2E.getAppState().bridge.onJoinOnlineWarmup({ roomId: ${JSON.stringify(roomId)}, playerName: 'ClientSpectator' })`
    );
    await waitFor(
      () => clientCdp.eval(`window.__rcE2E.getAppState().onlineSession?.isDevSyncRoom`),
      'Client joined Dev Sync Room',
      15_000
    );
    await clientCdp.eval(`window.__rcE2E.getAppState().closeMenu?.()`);
    await new Promise((r) => setTimeout(r, 1000));

    const clientPostBootMem = await collectCdpMemorySample(clientCdp);

    // =========================================================================
    // BUG 1: Goal Replay Client Has No Motion (Spectating <-> Goal Replay gap)
    // =========================================================================
    console.error('[DevBroadcastReproV3] Running Bug 1: Goal Replay Client Motion...');
    await hostCdp.eval(`(() => {
      const p = window.__rcE2E.getPhysics();
      p.setBallState({
        pos: [0, 4850, 95],
        vel: [0, 2950, 40],
        angVel: [0, 0, 0],
      });
    })()`);

    await waitFor(
      () =>
        hostCdp.eval(`(() => {
          const r = window.__rcE2E.runtime;
          const m = r.modeManager.getActiveMode();
          return r.match.state.phase === 'replay' || Boolean(m?.isGoalReplayActive?.());
        })()`),
      'Host Goal Replay start',
      15_000
    );
    console.error('[DevBroadcastReproV3] Bug 1: Host entered Goal Replay, waiting for Client...');

    await waitFor(
      () => clientCdp.eval(`window.__rcE2E.getHudState().matchPhase === 'replay'`),
      'Client Goal Replay start',
      15_000
    );

    // Sample Host & Client ball positions during Goal Replay over ~1.4s
    const hostReplaySamples = [];
    const clientReplaySamples = [];
    for (let i = 0; i < 12; i++) {
      const [hs, cs] = await Promise.all([
        hostCdp.eval(`(() => {
          const r = window.__rcE2E.runtime;
          const bv = r.physics.getBallStateView();
          const cv0 = r.physics.getCarStateView(0);
          return {
            x: bv.posX, y: bv.posY, z: bv.posZ,
            cx: cv0?.posX ?? 0, cy: cv0?.posY ?? 0,
            phase: r.match.state.phase,
            replayTick: r.replayTimelineController?.sessionState?.currentFrame ?? -1,
            replayFrames: r.replayTimelineController?.sessionState?.totalFrames ?? 0,
          };
        })()`),
        clientCdp.eval(`(() => {
          const r = window.__rcE2E.runtime;
          const bv = r.physics.getBallStateView();
          const ibv = r.interpolator?.getCurrBallStateView?.();
          const cv0 = r.physics.getCarStateView(0);
          const rec = r.multiplayerSession?.reconciler;
          return {
            x: bv.posX, y: bv.posY, z: bv.posZ,
            ix: ibv?.posX ?? bv.posX, iy: ibv?.posY ?? bv.posY, iz: ibv?.posZ ?? bv.posZ,
            cx: cv0?.posX ?? 0, cy: cv0?.posY ?? 0,
            phase: r.match.state.phase,
            hudPhase: window.__rcE2E.getHudState().matchPhase,
            replayPlaybackMode: Boolean(rec?.replayPlaybackMode),
            replayFrames: r.replayTimelineController?.sessionState?.totalFrames ?? 0,
            spectateBuffered: r.pipeline?.simulationStage?.spectateInterpolationBuffer?.getStats?.()?.bufferedFrames ?? -1,
          };
        })()`),
      ]);
      hostReplaySamples.push(hs);
      clientReplaySamples.push(cs);
      await new Promise((r) => setTimeout(r, 120));
    }

    const computeTravel = (samples, xk = 'x', yk = 'y', zk = 'z') => {
      let total = 0;
      for (let i = 1; i < samples.length; i++) {
        const dx = samples[i][xk] - samples[i - 1][xk];
        const dy = samples[i][yk] - samples[i - 1][yk];
        const dz = samples[i][zk] - samples[i - 1][zk];
        total += Math.hypot(dx, dy, dz);
      }
      return Math.round(total * 10) / 10;
    };

    const hostReplayBallTravel = computeTravel(hostReplaySamples);
    const clientReplayBallTravel = computeTravel(clientReplaySamples);
    const clientInterpBallTravel = computeTravel(clientReplaySamples, 'ix', 'iy', 'iz');
    const clientReplayFrames = Math.max(...clientReplaySamples.map((s) => s.replayFrames));
    const clientReplayPlaybackMode = clientReplaySamples.some((s) => s.replayPlaybackMode);

    // Trigger skipGoalReplay on Host after sampling so we also verify clean exit sync
    await hostCdp.eval(`window.__rcE2E.runtime.modeManager.getActiveMode()?.skipGoalReplay?.()`);
    await waitFor(
      () =>
        clientCdp.eval(`(() => {
          const hud = window.__rcE2E.getHudState();
          return hud.matchPhase !== 'replay' && hud.matchPhase !== 'goal';
        })()`),
      'Client Goal Replay exit',
      25_000
    );

    const bug1Reproduced =
      clientReplayFrames === 0 ||
      !clientReplayPlaybackMode ||
      (hostReplayBallTravel > 300 && (clientReplayBallTravel < 50 || clientInterpBallTravel < 50));

    record(
      'bug-1-goal-replay-client-no-motion',
      'Client Enters & Exits Goal Replay Without Motion (Spectating <-> Replay Unwired)',
      bug1Reproduced,
      {
        hostReplayBallTravel,
        clientReplayBallTravel,
        clientInterpBallTravel,
        clientReplayFrames,
        clientReplayPlaybackMode,
        firstClientSample: clientReplaySamples[0],
        lastClientSample: clientReplaySamples[clientReplaySamples.length - 1],
      }
    );

    // =========================================================================
    // BUG 2: Replay Watch Together (3v3) — UI Synced, 3D NameTags NOT Synced
    // =========================================================================
    console.error('[DevBroadcastReproV3] Running Bug 2: Replay Watch Together NameTags...');
    const replayPath = resolveReplayFilePath();
    if (replayPath) {
      const replayB64 = fs.readFileSync(replayPath).toString('base64');
      await hostCdp.eval(`(async () => {
        const b64 = ${JSON.stringify(replayB64)};
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], 'rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay', { type: 'application/octet-stream' });
        const freeplay = window.__rcE2E.runtime.modeManager.modes.get('freeplay');
        await freeplay.loadReplayFile(file);
      })()`);
      await waitFor(
        () =>
          hostCdp.eval(`(() => {
            const freeplay = window.__rcE2E.runtime.modeManager.modes.get('freeplay');
            const rlrc = freeplay?.rlrcReplaySession;
            return Boolean(rlrc?.hasLoadedReplay && rlrc?.isActive);
          })()`),
        'Host RLRC Replay loaded',
        20_000
      );
    } else {
      console.error(
        '[DevBroadcastReproV3] External .rcreplay unavailable; using synthetic 3v3 replay...'
      );
      await hostCdp.eval(`(() => {
        const app = window.__rcE2E.getAppState();
        app.bridge.onStartReplayViewer();
        const phys = window.__rcE2E.runtime.physics;
        const rv = window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer;
        for (let c = 0; c < 6; c++) {
          if (!phys.isCarSlotActive?.(c)) phys.addCarAtSlot?.(c, c < 3 ? 0 : 1, 'octane');
        }
        const frames = [];
        for (let f = 0; f < 300; f++) {
          phys.step?.(1 / 120);
          const snap = new Float32Array(phys.saveCompactState?.() ?? phys.saveState?.());
          snap[0] = f + 1;
          snap[4] = Math.sin(f * 0.1) * 1200;
          snap[5] = Math.cos(f * 0.1) * 1800;
          snap[6] = 120;
          snap[7] = 800;
          snap[8] = 1200;
          // Car 0 boosting periodically
          snap[22 + 22] = Math.max(0, 100 - (f % 60));
          snap[22 + 23] = f % 2 === 0 ? 1 : 0;
          frames.push(snap);
        }
        const metadata = {
          players: [
            { carIndex: 0, name: 'Player', team: 0, isBot: false },
            { carIndex: 1, name: 'Nexto #2', team: 0, isBot: true },
            { carIndex: 2, name: 'Nexto #3', team: 0, isBot: true },
            { carIndex: 3, name: 'Nexto #4', team: 1, isBot: true },
            { carIndex: 4, name: 'Nexto #5', team: 1, isBot: true },
            { carIndex: 5, name: 'Nexto #6', team: 1, isBot: true },
          ],
        };
        if (typeof rv._initializeLoadedReplaySession === 'function') {
          rv._initializeLoadedReplaySession(frames, [], null, metadata, 'synthetic-3v3.rcreplay', false);
        } else {
          rv.frames = frames;
          rv.hasLoadedReplay = true;
        }
        rv.startPlaying();
        window.__rcE2E.runtime.multiplayerSession?.broadcastGlobalWorkspace?.({
          activeRoomActivity: 'replay',
          replaySync: {
            fileName: 'synthetic-3v3.rcreplay',
            totalFrames: 300,
            currentFrame: 0,
            playbackState: 'playing',
            flowPct: 100,
            blueScore: 1,
            orangeScore: 0,
            remainingSeconds: 180,
            matchPhase: 'playing',
            roster: [
              { carIndex: 0, name: 'Player', team: 0, isBot: false },
              { carIndex: 1, name: 'Nexto #2', team: 0, isBot: true },
              { carIndex: 2, name: 'Nexto #3', team: 0, isBot: true },
              { carIndex: 3, name: 'Nexto #4', team: 1, isBot: true },
              { carIndex: 4, name: 'Nexto #5', team: 1, isBot: true },
              { carIndex: 5, name: 'Nexto #6', team: 1, isBot: true },
            ],
          },
        });
      })()`);
    }

    await waitFor(
      () =>
        clientCdp.eval(`(() => {
          const cards = Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]')).filter(
            (el) => getComputedStyle(el).display !== 'none'
          );
          return cards.length === 6;
        })()`),
      'Client Replay UI roster synced',
      15_000
    ).catch(async (err) => {
      const diag = await Promise.all([
        hostCdp.eval(`(() => ({
          mode: window.__rcE2E.runtime.match.state.mode,
          activity: window.__rcE2E.getAppState().onlineSession?.activeRoomActivity,
          rvHasLoaded: window.__rcE2E.runtime.modeManager.modes.get('freeplay')?.standaloneReplayViewer?.hasLoadedReplay,
          rvRosterLen: window.__rcE2E.runtime.modeManager.modes.get('freeplay')?.standaloneReplayViewer?.rosterSubController?.resolvedRoster?.length,
        }))()`),
        clientCdp.eval(`(() => ({
          mode: window.__rcE2E.runtime.match.state.mode,
          appMode: window.__rcE2E.getAppState().matchMode,
          activity: window.__rcE2E.getAppState().onlineSession?.activeRoomActivity,
          cards: Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]')).filter((el) => getComputedStyle(el).display !== 'none').length,
          hudRoster: window.__rcE2E.getHudState().roster?.length ?? null,
        }))()`),
      ]);
      console.error('[DevBroadcastReproV3] Bug 2 diag:', JSON.stringify(diag));
      throw err;
    });

    const [hostNameTags, clientReplayUiAndNameTags] = await Promise.all([
      hostCdp.eval(`(() => {
        const nt = window.__rcE2E.runtime.arena?.nameTagSystem;
        const lastEntries = nt?._lastCarEntries ?? null;
        const projected = nt?.projector?.lastProjected ?? null;
        return {
          modeName: window.__rcE2E.runtime.match.state.mode,
          hasNameTagSystem: Boolean(nt),
          lastEntriesCount: Array.isArray(lastEntries) ? lastEntries.length : 0,
          projectedCount: Array.isArray(projected) ? projected.length : 0,
          domCards: Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]'))
            .filter((el) => getComputedStyle(el).display !== 'none')
            .map((el) => el.textContent?.trim()),
        };
      })()`),
      clientCdp.eval(`(() => {
        const cards = Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]'))
          .filter((el) => getComputedStyle(el).display !== 'none')
          .map((el) => el.textContent?.trim());
        const nt = window.__rcE2E.runtime.arena?.nameTagSystem;
        const ntState = nt?._lastRuntimeState ?? null;
        const rvRoster = window.__rcE2E.getAppState()?.onlineSession?.activeRoomActivity;
        return {
          activeRoomActivity: rvRoster,
          uiRosterCardsCount: cards.length,
          uiRosterCards: cards,
          nameTagIsMultiCar: Boolean(ntState?.isMultiplayerOrMultiCarMode),
          nameTagCarEntriesCount: Array.isArray(ntState?.carEntries) ? ntState.carEntries.length : 0,
          nameTagCarNames: Array.isArray(ntState?.carEntries) ? ntState.carEntries.map(e => e.name || e.username) : [],
        };
      })()`),
    ]);

    // Also inspect nameTagTunerStore directly via runtimeUiPort / window if exposed, or via DOM/canvas probe
    const clientNameTagStoreDiag = await clientCdp.eval(`(() => {
      const r = window.__rcE2E.runtime;
      const arena = r.arena;
      const nt = arena?.nameTagSystem;
      // Trigger one update or read last frame state
      const labels = nt?.labels ?? nt?._labels ?? [];
      const activeLabels = [];
      if (Array.isArray(labels)) {
        for (let i = 0; i < labels.length; i++) {
          const l = labels[i];
          if (l && (l.visible || l.sprite?.visible)) {
            activeLabels.push({ index: i, text: l.lastText ?? l.name ?? l.text ?? null, visible: Boolean(l.visible ?? l.sprite?.visible) });
          }
        }
      }
      return {
        numCars: r.physics.getHeaderView().numCars,
        activeLabels,
      };
    })()`);

    const uiHasReplayNames = clientReplayUiAndNameTags.uiRosterCardsCount === 6;
    const nameTagsSynced =
      clientReplayUiAndNameTags.nameTagIsMultiCar &&
      clientReplayUiAndNameTags.nameTagCarEntriesCount === 6;

    const bug2Reproduced = uiHasReplayNames && !nameTagsSynced;
    record(
      'bug-2-replay-watch-together-nametag-unsynced',
      'Replay Watch Together Syncs UI Roster/Scoreboard But Not 3D NameTags on Client',
      bug2Reproduced,
      {
        host: hostNameTags,
        clientUiAndNameTags: clientReplayUiAndNameTags,
        clientNameTagLabels: clientNameTagStoreDiag,
      }
    );

    // =========================================================================
    // BUG 3 & BUG 4: Choppy State-Only Playback & Boost State Frame Flicker
    // =========================================================================
    console.error('[DevBroadcastReproV3] Running Bug 3 & Bug 4: Lookahead & Boost Flicker...');
    await hostCdp.eval(`(() => {
      const freeplay = window.__rcE2E.runtime.modeManager.modes.get('freeplay');
      if (freeplay?.rlrcReplaySession?.hasLoadedReplay) {
        freeplay.rlrcReplaySession.seekToFrame?.(1800);
        freeplay.rlrcReplaySession.setPaused?.(false);
      } else if (freeplay?.standaloneReplayViewer?.hasLoadedReplay) {
        freeplay.standaloneReplayViewer.seekFrame?.(30);
        freeplay.standaloneReplayViewer.startPlaying?.();
      }
    })()`);
    await new Promise((r) => setTimeout(r, 400));

    const combinedTrace = await clientCdp.eval(`(async () => {
      const r = window.__rcE2E.runtime;
      const samples = [];
      const padVisHistory = Array.from({ length: 34 }, () => []);
      const padActiveHistory = Array.from({ length: 34 }, () => []);
      const padCollectAnimHistory = [];
      const carBoostingHistory = Array.from({ length: 6 }, () => []);
      const carBoostAmtHistory = Array.from({ length: 6 }, () => []);
      const hudBoostHistory = [];
      const origStep = r.physics.step.bind(r.physics);
      let physicsStepCalls = 0;
      r.physics.step = (...args) => {
        physicsStepCalls++;
        return origStep(...args);
      };
      try {
        await new Promise((resolve) => {
          let count = 0;
          const onFrame = (ts) => {
            const bv = r.physics.getBallStateView();
            const ibv = r.interpolator?.getCurrBallStateView?.();
            const pbv = r.interpolator?.getPrevBallStateView?.();
            samples.push({
              ts: Math.round(ts * 10) / 10,
              tick: Math.floor(r.physics.getHeaderView().tickCount),
              bx: bv.posX, by: bv.posY, bz: bv.posZ,
              bvx: bv.velX, bvy: bv.velY, bvz: bv.velZ,
              alpha: r.interpolator?.alpha ?? -1,
              prevEqCurr: Boolean(pbv && ibv && Math.abs(pbv.posX - ibv.posX) < 1e-4 && Math.abs(pbv.posY - ibv.posY) < 1e-4),
            });
            const pads = r.arena?.boostPadSystem?.pads ?? [];
            padCollectAnimHistory.push(r.arena?.boostPadSystem?.collectAnimations?.size ?? 0);
            for (let i = 0; i < Math.min(34, pads.length); i++) {
              const p = pads[i];
              padVisHistory[i].push(p.full?.visible ? 1 : 0);
              const pv = r.physics.getBoostPadStateView(i);
              padActiveHistory[i].push(pv.isActive ? 1 : 0);
            }
            for (let c = 0; c < 6; c++) {
              const cv = r.physics.getCarStateView(c);
              carBoostingHistory[c].push(cv?.isBoosting ? 1 : 0);
              carBoostAmtHistory[c].push(Math.round((cv?.boost ?? 0) * 10) / 10);
            }
            hudBoostHistory.push(window.__rcE2E.getHudState().boostAmount ?? -1);
            count++;
            if (count >= 20) resolve();
            else requestAnimationFrame(onFrame);
          };
          requestAnimationFrame(onFrame);
        });
      } finally {
        r.physics.step = origStep;
      }

      const countRapidToggles = (arr) => {
        let toggles = 0;
        for (let i = 2; i < arr.length; i++) {
          if (arr[i] === arr[i - 2] && arr[i] !== arr[i - 1]) {
            toggles++;
          }
        }
        return toggles;
      };

      const padVisToggles = padVisHistory.map(countRapidToggles);
      const padActiveToggles = padActiveHistory.map(countRapidToggles);
      const carBoostingToggles = carBoostingHistory.map(countRapidToggles);
      const hudBoostToggles = countRapidToggles(hudBoostHistory);
      const hudBoostDropsToZero = hudBoostHistory.filter((v, idx) => idx > 0 && v === 0 && hudBoostHistory[idx - 1] > 5).length;

      return {
        physicsStepCalls,
        samples,
        boostTrace: {
          totalPadVisRapidToggles: padVisToggles.reduce((a, b) => a + b, 0),
          totalPadActiveRapidToggles: padActiveToggles.reduce((a, b) => a + b, 0),
          totalCarBoostingRapidToggles: carBoostingToggles.reduce((a, b) => a + b, 0),
          hudBoostRapidToggles: hudBoostToggles,
          hudBoostDropsToZero,
          maxCollectAnims: Math.max(0, ...padCollectAnimHistory),
          carBoostingTogglesByCar: carBoostingToggles,
          sampleCar0Boosting: carBoostingHistory[0].slice(0, 20),
          sampleCar0BoostAmt: carBoostAmtHistory[0].slice(0, 20),
          sampleHudBoost: hudBoostHistory.slice(0, 20),
        },
      };
    })()`);

    const clientMotionTrace = combinedTrace;
    let zeroDeltaFrames = 0;
    const deltas = [];
    for (let i = 1; i < clientMotionTrace.samples.length; i++) {
      const a = clientMotionTrace.samples[i - 1];
      const b = clientMotionTrace.samples[i];
      const d = Math.hypot(b.bx - a.bx, b.by - a.by, b.bz - a.bz);
      const speed = Math.hypot(b.bvx, b.bvy, b.bvz);
      if (d < 0.01 && speed > 100) {
        zeroDeltaFrames++;
      }
      if (d > 0.01) deltas.push(d);
    }
    deltas.sort((x, y) => x - y);
    const medianDelta = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 0;
    const maxDelta = deltas.length > 0 ? deltas[deltas.length - 1] : 0;
    const maxStepRatio = medianDelta > 0 ? Math.round((maxDelta / medianDelta) * 100) / 100 : 0;
    const prevEqCurrRatio =
      Math.round(
        (clientMotionTrace.samples.filter((s) => s.prevEqCurr).length /
          Math.max(1, clientMotionTrace.samples.length)) *
          100
      ) / 100;

    const bug3Reproduced =
      clientMotionTrace.physicsStepCalls === 0 &&
      (zeroDeltaFrames > 0 || maxStepRatio > 1.8 || prevEqCurrRatio > 0.8);

    record(
      'bug-3-broadcast-choppy-state-only-no-physics-lookahead',
      'Client Broadcast Playback Uses State-Only Snapshots Without Deterministic Physics Lookahead',
      bug3Reproduced,
      {
        physicsStepCalls: clientMotionTrace.physicsStepCalls,
        totalFramesSampled: clientMotionTrace.samples.length,
        zeroDeltaFrames,
        medianDeltaUu: Math.round(medianDelta * 100) / 100,
        maxDeltaUu: Math.round(maxDelta * 100) / 100,
        maxStepRatio,
        prevEqCurrRatio,
      }
    );

    const boostFlickerTrace = combinedTrace.boostTrace;

    // Also probe live Freeplay boosting (Host holding boost + inactive pad 0)
    await hostCdp.eval(`(() => {
      const app = window.__rcE2E.getAppState();
      const freeplay = window.__rcE2E.runtime.modeManager.modes.get('freeplay');
      freeplay?.standaloneReplayViewer?.pausePlaying?.();
      freeplay?.rlrcReplaySession?.setPaused?.(true);
      app.bridge?.onExitReplayViewer?.();
      const rt = window.__rcE2E.runtime;
      rt.playerControls.boost = true;
      rt.playerControls.throttle = 1;
      const p = rt.physics;
      const st = p.state;
      if (st) {
        st[22 + 22] = 100; // car 0 boost = 100
        st[342] = 0; // pad 0 inactive
        st[343] = 8.0; // pad 0 cooldown
        p.restoreState?.(st, { preserveEngineTick: true });
      }
    })()`);
    await new Promise((r) => setTimeout(r, 400));

    const liveBoostTrace = await clientCdp.eval(`(async () => {
      const r = window.__rcE2E.runtime;
      const car0Boosting = [];
      const car0BoostAmt = [];
      const pad0Active = [];
      const pad0Vis = [];
      const hudBoost = [];
      await new Promise((resolve) => {
        let count = 0;
        const onFrame = () => {
          const cv = r.physics.getCarStateView(0);
          const pv = r.physics.getBoostPadStateView(0);
          const pad0 = r.arena?.boostPadSystem?.pads?.[0];
          car0Boosting.push(cv?.isBoosting ? 1 : 0);
          car0BoostAmt.push(Math.round((cv?.boost ?? 0) * 10) / 10);
          pad0Active.push(pv?.isActive ? 1 : 0);
          pad0Vis.push(pad0?.full?.visible ? 1 : 0);
          hudBoost.push(window.__rcE2E.getHudState().boostAmount ?? -1);
          count++;
          if (count >= 20) resolve();
          else requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
      });
      const countToggles = (arr) => {
        let t = 0;
        for (let i = 2; i < arr.length; i++) {
          if (arr[i] === arr[i - 2] && arr[i] !== arr[i - 1]) t++;
        }
        return t;
      };
      return {
        car0BoostingToggles: countToggles(car0Boosting),
        pad0VisToggles: countToggles(pad0Vis),
        pad0ActiveToggles: countToggles(pad0Active),
        hudBoostToggles: countToggles(hudBoost),
        car0Boosting,
        car0BoostAmt,
        pad0Vis,
        hudBoost,
      };
    })()`);

    await hostCdp.eval(`(() => {
      const rt = window.__rcE2E.runtime;
      rt.playerControls.boost = false;
      rt.playerControls.throttle = 0;
    })()`);

    const totalBoostFlickers =
      boostFlickerTrace.totalPadVisRapidToggles +
      boostFlickerTrace.totalPadActiveRapidToggles +
      boostFlickerTrace.totalCarBoostingRapidToggles +
      boostFlickerTrace.hudBoostRapidToggles +
      liveBoostTrace.car0BoostingToggles +
      liveBoostTrace.pad0VisToggles +
      liveBoostTrace.pad0ActiveToggles +
      liveBoostTrace.hudBoostToggles;

    const bug4Reproduced = totalBoostFlickers > 0;
    record(
      'bug-4-boost-state-flicker-every-frame',
      'Boost State Rapidly Flickers Across Consecutive Frames on Client',
      bug4Reproduced,
      { ...boostFlickerTrace, liveBoostTrace }
    );

    // =========================================================================
    // BUG 5: High Memory Footprint & Retention After Close / Dispose
    // =========================================================================
    const clientActiveMem = await collectCdpMemorySample(clientCdp);
    await clientCdp.eval(`(() => {
      window.__rcE2E.runtime.dispose();
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    const clientPostDisposeMem = await collectCdpMemorySample(clientCdp);

    const heapRetentionRatio =
      clientActiveMem.jsHeapUsedMB > 0
        ? Math.round((clientPostDisposeMem.jsHeapUsedMB / clientActiveMem.jsHeapUsedMB) * 100) / 100
        : 0;
    const wasmRetainedAfterDisposeMB =
      Math.round((clientPostDisposeMem.wasmMemoryBytes / (1024 * 1024)) * 10) / 10;

    // Also verify Tauri CloseRequested behavior from src-tauri/src/lib.rs
    const tauriLibPath = path.resolve(process.cwd(), 'src-tauri/src/lib.rs');
    const tauriLibSrc = fs.existsSync(tauriLibPath) ? fs.readFileSync(tauriLibPath, 'utf8') : '';
    const tauriHidesWindowWithoutDispose =
      tauriLibSrc.includes('api.prevent_close()') && tauriLibSrc.includes('window.hide()');

    const bug5Reproduced =
      heapRetentionRatio > 0.6 || wasmRetainedAfterDisposeMB > 50 || tauriHidesWindowWithoutDispose;

    record(
      'bug-5-memory-footprint-and-close-retention',
      'High Memory Footprint & Retained Heap/WASM/WebGL Resources After Close/Dispose',
      bug5Reproduced,
      {
        hostPostBootMem,
        clientPostBootMem,
        clientActiveMem,
        clientPostDisposeMem,
        heapRetentionRatio,
        wasmRetainedAfterDisposeMB,
        tauriHidesWindowWithoutDispose,
      }
    );

    const reproducedCount = results.filter((r) => r.reproduced).length;
    const report = {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      reproducedCount,
      totalScenarios: results.length,
      results,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.error(
      `[DevBroadcastReproV3] Report written to ${OUT_PATH} (reproduced=${reproducedCount}/${results.length})`
    );
  } finally {
    clearTimeout(watchdog);
    hostCdp?.close();
    clientCdp?.close();
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      // Ignore
    }
    await server.close();
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Ignore lingering Chrome lock files on exit
    }
  }
}

main().catch((err) => {
  console.error('[DevBroadcastReproV3] FAILED:', err);
  process.exit(1);
});
