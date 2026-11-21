#!/usr/bin/env node
/**
 * scripts/runVNextIssuesReproSuite.mjs
 *
 * Headless Chrome + WebGL + WASM E2E reproduction suite for vNext integration issues:
 *
 * 1. repro-1-broadcast-boost-jitter-vs-wheel-trail:
 *    Freeplay Developer Broadcasting at 60Hz triggers TimelineFrameBuffer passthrough mode
 *    (avgIntervalMs <= 22ms), causing step-hold-jump jitter on client car/ball/boost emitter
 *    while SupersonicWheelTrailSystem stays smooth via resolveCarStepTicks stationary freeze.
 * 2. repro-2-freeplay-goal-replay-team-anthem-camera:
 *    Freeplay Goal Replay in Dev Broadcasting lacks GoalReplayWillStart + anthemId broadcast,
 *    assigns Host/Client into opposing teams (carIdx % 2 / ballPosY), and diverges from
 *    Match UnifiedGoalReplayStateMachine + Cinematic Camera.
 * 3. repro-3-exhibition-broadcast-no-pause-and-goal-replay-stuck:
 *    Exhibition (exp-multi-bots) in Dev Broadcasting mode lacks pause handling and stalls/freezes
 *    during Goal Replay on Client.
 * 4. repro-4-replay-456-hud-swap-and-loadout-mismatch:
 *    Switching 1..6 in 3v3 Replay Viewer flips hudStore.localTeam (swapping scoreboard left/right
 *    on 4/5/6) and exhibits car color / visual model / hitbox mismatches against roster metadata.
 * 5. repro-5-camera-fps-dependence:
 *    CleanPovCameraKernel produces different camera pose trajectories at 30fps vs 120fps vs 240fps
 *    over identical car/ball motion because it integrates per-rAF variable dt instead of fixed 120Hz.
 * 6. repro-6-audio-background-foreground-latency:
 *    Background/hidden -> foreground transition in WebView/browser leaves AudioContext suspended
 *    or delayed across focusRecheckTimer + 50ms linearRamp + slotPool silence/re-init.
 */

import fs from 'node:fs';
import { createServer } from 'vite';
import { cleanupHeadlessChrome, launchHeadlessChrome } from './env/launchHeadlessChrome.mjs';
import { generateSynthetic3v3ReplayFixture } from './env/generateSyntheticReplayFixture.mjs';
import { createSoftTimeoutWatchdog } from './lib/softTimeoutWatchdog.mjs';

if (!process.env.RC_VITE_ROLE) {
  process.env.RC_VITE_ROLE = 'rc-http';
}

const OUT_PATH = '/tmp/vnext-issues-repro-suite.json';

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
    if (res?.exceptionDetails) {
      const errText =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        'CDP Runtime.evaluate exception';
      throw new Error(`[CDP ${this.label}] ${errText}`);
    }
    return res?.result?.value;
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
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${label} after ${timeoutMs}ms`);
}

function resolveReplayFilePath() {
  const candidates = [
    process.env.RC_REPLAY_FILE,
    '/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
    '/workspace/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return generateSynthetic3v3ReplayFixture('/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay');
}

async function main() {
  const port = 5175;
  const server = await createServer({
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  const baseUrl = `http://127.0.0.1:${port}/?skipShaderPrewarm=1`;
  console.log(`[VNextIssuesRepro] Vite listening at ${baseUrl}`);

  const { chromeProc, userDataDir, getCdpPort } = launchHeadlessChrome({
    url: baseUrl,
    userDataDirPrefix: 'chrome-vnext-issues-repro',
  });

  const results = [];
  let hostCdp = null;
  let clientCdp = null;

  const watchdog = createSoftTimeoutWatchdog({
    label: 'VNextIssuesRepro',
    exitCode: 2,
    onTimeout: async () => {
      try {
        const partial = {
          timestamp: new Date().toISOString(),
          suite: 'VNextIssuesRepro',
          timedOut: true,
          reproducedCount: results.filter((r) => r.reproduced).length,
          totalCount: results.length,
          results,
        };
        fs.writeFileSync(OUT_PATH, JSON.stringify(partial, null, 2));
      } catch {
        // Ignore
      }
      hostCdp?.close();
      clientCdp?.close();
      await cleanupHeadlessChrome(chromeProc, userDataDir);
      await server.close().catch(() => {});
    },
  });

  const record = (id, title, reproduced, detail) => {
    results.push({ id, title, reproduced, detail });
    const tag = reproduced ? 'REPRODUCED_BUG' : 'PASS_FIXED';
    watchdog.log(`[${tag}] ${id}: ${title} -> ${JSON.stringify(detail)}`);
  };

  try {
    const cdpPort = await waitFor(() => getCdpPort(), 'Chrome CDP port', 15_000);
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const hostTarget = targets.find((t) => t.type === 'page');
    hostCdp = new CdpClient(hostTarget.webSocketDebuggerUrl, 'host');
    await hostCdp.connect();
    await waitFor(
      () => hostCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Host boot',
      60_000
    );

    // =========================================================================
    // REPRO 5: Camera FPS Dependence (30fps vs 120fps vs 240fps)
    // =========================================================================
    const camFpsDetail = await hostCdp.eval(`(async () => {
      const { CleanPovCameraKernel } = await import('/src/camera/CleanPovCameraKernel.ts');
      function runAtFps(fps) {
        const k = new CleanPovCameraKernel();
        k.resetView();
        const v = k.getViewArray();
        const dt = 1 / fps;
        const steps = Math.round(1.0 * fps);
        for (let i = 0; i < steps; i++) {
          const t = (i + 1) * dt;
          const vx = 1400;
          const vy = 350 * Math.sin(t * 4);
          const vz = 400 * Math.cos(t * 2);
          v[0] = dt;
          v[1] = 0; // ballCam = false
          v[2] = vx * t;
          v[3] = 17 + 120 * Math.max(0, Math.sin(t * 3));
          v[4] = 400 * Math.sin(t * 2);
          v[5] = 0; v[6] = 0; v[7] = 0; v[8] = 1;
          v[9] = v[2] + 800; v[10] = 250; v[11] = -300;
          v[12] = 1;
          v[13] = v[3] <= 20 ? 1 : 0;
          v[14] = 0; v[15] = 1; v[16] = 0;
          v[17] = vx; v[18] = vy; v[19] = vz;
          v[20] = 1; // supersonic
          v[21] = 110; v[22] = 270; v[23] = 100; v[24] = -4; v[25] = 0.45; v[26] = 1.0;
          v[27] = 16 / 9;
          k.stepView(v);
        }
        return {
          posX: k.finalCameraPosX,
          posY: k.finalCameraPosY,
          posZ: k.finalCameraPosZ,
          fov: k.blendedPose.fov,
        };
      }
      const r30 = runAtFps(30);
      const r120 = runAtFps(120);
      const r240 = runAtFps(240);
      const dist = (a, b) => Math.hypot(a.posX - b.posX, a.posY - b.posY, a.posZ - b.posZ);
      return {
        deltaPos30vs120: Math.round(dist(r30, r120) * 1000) / 1000,
        deltaPos240vs120: Math.round(dist(r240, r120) * 1000) / 1000,
        deltaFov30vs120: Math.round(Math.abs(r30.fov - r120.fov) * 1000) / 1000,
      };
    })()`);
    record(
      'repro-5-camera-fps-dependence',
      'CleanPovCameraKernel diverges across 30/120/240fps due to variable-dt Euler integration',
      camFpsDetail.deltaPos30vs120 > 1.0 || camFpsDetail.deltaPos240vs120 > 0.25,
      camFpsDetail
    );

    // =========================================================================
    // REPRO 6: Audio Background -> Foreground Latency / Lifecycle
    // =========================================================================
    const audioLatDetail = await hostCdp.eval(`(async () => {
      const { getAudioContext, getAudioLifecycleEvents } = await import('/src/audio/audioContext.ts');
      const ctx = getAudioContext();
      if (!ctx) return { error: 'no AudioContext' };
      try { if (ctx.state === 'suspended') await ctx.resume(); } catch {}
      const stateBefore = ctx.state;
      const t0Ctx = ctx.currentTime;
      const t0Perf = performance.now();
      window.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 400));
      const tResumeStart = performance.now();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new CustomEvent('rc-tauri-window-shown'));
      await new Promise((r) => setTimeout(r, 150));
      const t1Ctx = ctx.currentTime;
      const t1Perf = performance.now();
      const events = getAudioLifecycleEvents?.() ?? [];
      return {
        stateBefore,
        stateAfter: ctx.state,
        wallElapsedMs: Math.round(t1Perf - t0Perf),
        ctxElapsedMs: Math.round((t1Ctx - t0Ctx) * 1000),
        driftMs: Math.round((t1Perf - t0Perf) - (t1Ctx - t0Ctx) * 1000),
        resumeWindowMs: Math.round(performance.now() - tResumeStart),
        recentLifecycleEvents: events.slice(-6).map((e) => e.event || e.type || String(e)),
      };
    })()`);
    record(
      'repro-6-audio-background-foreground-latency',
      'AudioContext background/foreground cycle focus/ramp/resume latency probe',
      Math.abs(audioLatDetail.driftMs ?? 0) > 25 || audioLatDetail.stateAfter !== 'running',
      audioLatDetail
    );

    // =========================================================================
    // Setup Host + Client Developer Sync Room for Repro 1, 2, 3
    // =========================================================================
    watchdog.log('Opening dev-under-development menu...');
    await hostCdp.eval(`window.__rcE2E.getAppState().openMenu('dev-under-development')`);
    await new Promise((r) => setTimeout(r, 300));
    await hostCdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      btns.find((b) => /Create Developer Sync Room/i.test(b.textContent || ''))?.click();
    })()`);
    watchdog.log('Waiting for Host roomId...');
    const roomId = await waitFor(
      () =>
        hostCdp.eval(
          `window.__rcE2E.getAppState().onlineSession?.isHosting && window.__rcE2E.getAppState().onlineSession?.roomId`
        ),
      'Host roomId',
      15_000
    );
    watchdog.log('Host roomId=' + roomId);
    await hostCdp.eval(`window.__rcE2E.getAppState().closeMenu()`);

    const { targetId: c1TargetId } = await hostCdp.send('Target.createTarget', {
      url: baseUrl,
      newWindow: true,
    });
    const allTargets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const c1Target = allTargets.find((t) => t.id === c1TargetId);
    clientCdp = new CdpClient(c1Target.webSocketDebuggerUrl, 'client');
    await clientCdp.connect();
    watchdog.log('Waiting for Client boot...');
    await waitFor(
      () => clientCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client boot',
      60_000
    );
    watchdog.log('Client booted, joining room...');
    await clientCdp.eval(
      `window.__rcE2E.getAppState().bridge.onJoinOnlineWarmup({ roomId: ${JSON.stringify(roomId)}, playerName: 'ClientSpectator' })`
    );
    await waitFor(
      () => clientCdp.eval(`window.__rcE2E.getAppState().onlineSession?.isDevSyncRoom`),
      'Client joined Dev Sync Room',
      15_000
    );
    await clientCdp.eval(`window.__rcE2E.getAppState().closeMenu?.()`);
    await new Promise((r) => setTimeout(r, 600));
    watchdog.log('Dev Sync Room Host + Client connected.');

    // =========================================================================
    // REPRO 1: Freeplay Broadcast Boost Jitter vs Wheel Supersonic Trail
    // =========================================================================
    await hostCdp.send('Page.bringToFront');
    await hostCdp.eval(`(() => {
      const rt = window.__rcE2E.runtime;
      const st = rt.physics.saveCompactState();
      const cOff = 22;
      st[cOff + 0] = 0; st[cOff + 1] = -2000; st[cOff + 2] = 17;
      st[cOff + 3] = 0; st[cOff + 4] = 2250; st[cOff + 5] = 0;
      st[cOff + 17] = 100;
      st[cOff + 18] = 1;
      rt.physics.restoreCompactState(st, { preserveEngineTick: true });
      if (rt.playerControls) {
        rt.playerControls.throttle = 1;
        rt.playerControls.boost = true;
      }
    })()`);

    await clientCdp.send('Page.bringToFront');
    const jitterStats = await clientCdp.eval(`(async () => {
      const rt = window.__rcE2E.runtime;
      const simStage = rt.pipeline?.stages?.find?.((s) => s.spectateInterpolationBuffer);
      const buf = simStage?.spectateInterpolationBuffer;
      const deltas = [];
      let prevX = null, prevY = null;
      let zeroDeltaFrames = 0;
      let jumpFrames = 0;
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const mesh = rt.arena?.cars?.[0];
        if (mesh) {
          const x = mesh.position.x;
          const y = mesh.position.y;
          if (prevX !== null) {
            const d = Math.hypot(x - prevX, y - prevY);
            deltas.push(Math.round(d * 100) / 100);
            if (d < 0.01) zeroDeltaFrames++;
            else if (d > 25) jumpFrames++;
          }
          prevX = x;
          prevY = y;
        }
      }
      const stats = buf?.timeline?.getStats?.() ?? buf?.getStats?.() ?? null;
      return {
        bufferMode: stats?.activeMode ?? null,
        avgIntervalMs: stats?.avgIntervalMs ?? null,
        zeroDeltaFrames,
        jumpFrames,
        sampleDeltas: deltas.slice(0, 15),
      };
    })()`);
    await hostCdp.eval(`(() => {
      const rt = window.__rcE2E.runtime;
      if (rt.playerControls) { rt.playerControls.throttle = 0; rt.playerControls.boost = false; }
    })()`);
    record(
      'repro-1-broadcast-boost-jitter-vs-wheel-trail',
      'Client spectate uses passthrough mode at 60Hz causing step-hold-jump jitter on car/boost while wheel trail freezes on zero-delta frames',
      jitterStats.bufferMode === 'passthrough' || jitterStats.zeroDeltaFrames > 0,
      jitterStats
    );

    // =========================================================================
    // REPRO 2: Freeplay Goal Replay Team Assignment & Anthem Broadcast
    // =========================================================================
    await hostCdp.send('Page.bringToFront');
    await hostCdp.eval(`(() => {
      window.__rcE2E.runtime.physics.setBallState({
        pos: [0, 1500, 95],
        vel: [0, 2000, 200],
        angVel: [0, 0, 0],
      });
    })()`);
    await waitFor(
      () =>
        hostCdp.eval(
          `Boolean(window.__rcE2E.runtime.modeManager?.modes?.get?.('freeplay')?.isGoalReplayActive?.())`
        ),
      'Host enters Freeplay Goal Replay',
      40_000
    );
    await clientCdp.send('Page.bringToFront');
    await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.runtime.match?.state?.phase === 'replay' || window.__rcE2E.getHudState?.()?.matchPhase === 'replay'`
        ),
      'Client enters Freeplay Goal Replay',
      20_000
    );
    const fpGoalReplayDetail = await clientCdp.eval(`(() => {
      const rt = window.__rcE2E.runtime;
      const hud = window.__rcE2E.getHudState?.() ?? {};
      const hostTeam = 0;
      const clientTeam = hud.localTeam ?? null;
      const carTeams = rt.arena?.carTeams ? Array.from(rt.arena.carTeams).slice(0, rt.physics?.numCars || 1) : [];
      return {
        matchPhase: rt.match?.state?.phase ?? null,
        hudScorerTeam: hud.replayScorerTeam ?? null,
        hudAnthemId: hud.replayScorerAnthemId ?? null,
        hudLocalTeam: clientTeam,
        carTeams,
        hasGoalReplayOverride: Boolean(rt.isGoalReplayCameraOverrideActive?.()),
        hostTeam,
      };
    })()`);
    await hostCdp.send('Page.bringToFront');
    await hostCdp.eval(`window.__rcE2E.runtime.modeManager?.getActiveMode?.()?.skipGoalReplay?.()`);
    await new Promise((r) => setTimeout(r, 400));
    record(
      'repro-2-freeplay-goal-replay-team-anthem-camera',
      'Freeplay Goal Replay lacks broadcast anthemId and/or has team/camera divergence',
      !fpGoalReplayDetail.hudAnthemId || fpGoalReplayDetail.hudAnthemId === 'none',
      fpGoalReplayDetail
    );

    // =========================================================================
    // REPRO 3: Exhibition Broadcasting Mode (No Pause + Goal Replay Stuck)
    // =========================================================================
    await hostCdp.send('Page.bringToFront');
    await hostCdp.eval(`(async () => {
      const rt = window.__rcE2E.runtime;
      window.__rcE2E.getAppState().setMatchMode('exp-multi-bots');
      rt.match.state.mode = 'exp-multi-bots';
      rt.modeManager.setMode('exp-multi-bots');
      const exp = rt.modeManager.getActiveMode();
      await exp.applyRosterAndStartMatch();
    })()`);
    await new Promise((r) => setTimeout(r, 800));

    // Check pause in Exhibition broadcasting
    const expPauseDetail = await hostCdp.eval(`(() => {
      const rt = window.__rcE2E.runtime;
      const exp = rt.modeManager.getActiveMode();
      const hasPauseMethod = typeof exp?.togglePause === 'function' || typeof exp?.setPaused === 'function';
      return {
        mode: rt.match?.state?.mode ?? null,
        hasPauseMethod,
        matchPaused: Boolean(rt.match?.state?.paused),
      };
    })()`);

    // Trigger goal in Exhibition and observe Client during Goal Replay
    await hostCdp.eval(`(() => {
      const rt = window.__rcE2E.runtime;
      const exp = rt.modeManager.getActiveMode();
      if (exp?.lifecycleController) {
        exp.lifecycleController.countdownTicks = 0;
      }
      rt.physics.setBallState({
        pos: [0, 1500, 95],
        vel: [0, 2000, 200],
        angVel: [0, 0, 0],
      });
    })()`);

    await waitFor(
      () =>
        hostCdp.eval(
          `Boolean(window.__rcE2E.runtime.modeManager?.modes?.get?.('exp-multi-bots')?.isGoalReplayActive?.())`
        ),
      'Host enters Exhibition Goal Replay',
      40_000
    ).catch(() => false);

    await clientCdp.send('Page.bringToFront');
    const clientEnteredExpReplay = await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.runtime.match?.state?.phase === 'replay' || window.__rcE2E.getHudState?.()?.matchPhase === 'replay'`
        ),
      'Client enters Exhibition Goal Replay',
      15_000
    ).catch(() => false);

    let expReplaySamples = { uniqueBallPositions: 0, sampleCount: 0, clientEnteredExpReplay };
    if (clientEnteredExpReplay) {
      expReplaySamples = await clientCdp.eval(`(async () => {
        const rt = window.__rcE2E.runtime;
        const pts = [];
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          const bv = rt.physics.getBallStateView();
          pts.push(bv.posX.toFixed(1) + ',' + bv.posY.toFixed(1) + ',' + bv.posZ.toFixed(1));
        }
        return {
          clientEnteredExpReplay: true,
          sampleCount: pts.length,
          uniqueBallPositions: new Set(pts).size,
        };
      })()`);
    }

    record(
      'repro-3-exhibition-broadcast-no-pause-and-goal-replay-stuck',
      'Exhibition broadcasting mode lacks pause support and stalls/freezes during Goal Replay on Client',
      !expPauseDetail.hasPauseMethod || expReplaySamples.uniqueBallPositions <= 2,
      { expPauseDetail, expReplaySamples }
    );

    // =========================================================================
    // REPRO 4: Replay 4/5/6 HUD Left/Right Swap + 1..6 Color/Model/Hitbox Mismatch
    // =========================================================================
    clientCdp?.close();
    clientCdp = null;
    await hostCdp.send('Target.closeTarget', { targetId: c1TargetId }).catch(() => {});
    await hostCdp.send('Page.bringToFront');
    await hostCdp.send('Page.navigate', { url: baseUrl });
    await new Promise((r) => setTimeout(r, 800));
    await waitFor(
      () => hostCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Replay4 reload boot',
      60_000
    );

    const replayPath = resolveReplayFilePath();
    const replayBase64 = fs.readFileSync(replayPath).toString('base64');
    await hostCdp.eval(`(async () => {
      const b64 = ${JSON.stringify(replayBase64)};
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const rt = window.__rcE2E.runtime;
      const rv = rt.modeManager?.modes?.get?.('freeplay')?.standaloneReplayViewer;
      await rv.handleUploadFile(new File([bin], 'fixture-3v3.rcreplay', { type: 'application/octet-stream' }));
      rv.seekFrame?.(120);
      rv.startPlaying?.();
    })()`);
    await waitFor(
      () =>
        hostCdp.eval(
          `Boolean(window.__rcE2E.runtime.modeManager?.modes?.get?.('freeplay')?.standaloneReplayViewer?.hasLoadedReplay)`
        ),
      'Standalone Replay loaded',
      20_000
    );
    await new Promise((r) => setTimeout(r, 400));

    const replaySlots = await hostCdp.eval(`(async () => {
      const rt = window.__rcE2E.runtime;
      const fp = rt.modeManager.modes.get('freeplay');
      const rv = fp.standaloneReplayViewer;
      const rosterSub = rv.rosterSubController;
      const rosterEntries = rosterSub?.resolvedRoster ?? [];
      const snapshots = [];
      for (const slot of [1, 2, 3, 4, 5, 6]) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit' + slot, key: String(slot), bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        const hud = window.__rcE2E.getHudState?.() ?? {};
        const carIdx = rt.playerCarIndex;
        const expected = rosterEntries.find((e) => e.slotKey === slot) || null;
        snapshots.push({
          slot,
          carIdx,
          hudLocalTeam: hud.localTeam,
          arenaVisual: rt.arena?.vehiclePresets?.[carIdx] ?? null,
          expectedVisual: expected?.visualId ?? null,
          arenaColor: rt.arena?.carColors?.[carIdx] ?? null,
          expectedColor: expected?.colorHex ?? null,
          expectedHitbox: expected?.hitboxId ?? null,
        });
      }
      return { rosterCount: rosterEntries.length, snapshots };
    })()`);

    const teamsSeen = new Set(replaySlots.snapshots.map((s) => s.hudLocalTeam));
    const hudSwappedOn456 = teamsSeen.size > 1;
    const visualMismatches = replaySlots.snapshots.filter(
      (s) => s.expectedVisual && s.arenaVisual && s.expectedVisual !== s.arenaVisual
    ).length;
    record(
      'repro-4-replay-456-hud-swap-and-loadout-mismatch',
      'Replay 1..6 POV switching flips hudStore.localTeam on 4/5/6 and/or mismatches car visuals/colors/hitboxes',
      hudSwappedOn456 || visualMismatches > 0,
      { hudSwappedOn456, visualMismatches, snapshots: replaySlots.snapshots }
    );

    const summary = {
      timestamp: new Date().toISOString(),
      suite: 'VNextIssuesRepro',
      reproducedCount: results.filter((r) => r.reproduced).length,
      totalCount: results.length,
      results,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
    watchdog.log(`Summary written to ${OUT_PATH}`);
    watchdog.log(`Reproduced ${summary.reproducedCount}/${summary.totalCount} issues.`);
  } finally {
    watchdog.dispose();
    hostCdp?.close();
    clientCdp?.close();
    await cleanupHeadlessChrome(chromeProc, userDataDir);
    await server.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[VNextIssuesRepro] Fatal error:', err);
  process.exit(1);
});
