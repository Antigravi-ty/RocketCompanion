#!/usr/bin/env node
/**
 * scripts/runDevBroadcastReproV3.mjs
 *
 * Headless Chrome + WebGL + WASM E2E reproduction suite for Dev Sync Room & Replay Watch Together:
 *
 * 1. bug-1-goal-replay-client-static-no-dynamics:
 *    Client enters Goal Replay (matchPhase === 'replay' & director override),
 *    but ball/car motion is frozen (no dynamics) until Goal Replay exits and resyncs.
 * 2. bug-2-replay-nametag-and-team-desync:
 *    Replay Watch Together (3v3 .rcreplay) syncs UI roster strips, but Client 3D NameTags
 *    and arena.carTeams remain unsynced.
 * 3. bug-3-replay-choppy-motion-no-physics-lookahead:
 *    Client spectate/replay playback freezes physics tickCount and repeats identical ball
 *    positions across consecutive rAF frames followed by large single-frame teleports,
 *    lacking deterministic physics lookahead (>= 5 frames buffer).
 * 4. bug-4-boostpad-model-flicker:
 *    Client BoostPad models (pad.full.visible) flicker/toggle repeatedly across consecutive
 *    frames due to cooldown jumps re-triggering collect animations.
 * 5. bug-5-high-memory-and-unreleased-on-exit:
 *    High baseline WASM+JS memory at boot, and WASM/JS/Three.js geometry allocations from
 *    loading .rcreplay are not released after exiting back to Freeplay (plus Tauri window
 *    CloseRequested hides instead of closing).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import {
  cleanupHeadlessChrome,
  launchHeadlessChrome,
} from './env/launchHeadlessChrome.mjs';
import { generateSynthetic3v3ReplayFixture } from './env/generateSyntheticReplayFixture.mjs';
import { createSoftTimeoutWatchdog } from './lib/softTimeoutWatchdog.mjs';

if (!process.env.RC_VITE_ROLE) {
  process.env.RC_VITE_ROLE = 'rc-http';
}

const OUT_PATH = '/tmp/dev-broadcast-repro-v3.json';

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
    await this.send('HeapProfiler.enable');
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

async function sampleMemory(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await new Promise((r) => setTimeout(r, 200));
  return cdp.eval(`(() => {
    const pm = performance.memory;
    const rt = window.__rcE2E.runtime;
    const wasmMB = Math.round((rt.physics?.module?.HEAPU8?.byteLength ?? 0) / 1048576);
    const rv = rt.modeManager?.modes?.get?.('freeplay')?.standaloneReplayViewer;
    const rvFrames = rv?.frames?.length ?? rv?.session?.frames?.length ?? 0;
    const info = rt.renderer?.info?.memory ?? null;
    return {
      jsUsedMB: pm ? Math.round(pm.usedJSHeapSize / 1048576) : null,
      jsTotalMB: pm ? Math.round(pm.totalJSHeapSize / 1048576) : null,
      wasmMB,
      rvFrames,
      geometries: info?.geometries ?? null,
      textures: info?.textures ?? null,
    };
  })()`);
}

async function main() {
  const port = 5174;
  const server = await createServer({
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  const baseUrl = `http://127.0.0.1:${port}/?skipShaderPrewarm=1`;
  console.log(`[DevBroadcastReproV3] Vite listening at ${baseUrl}`);

  const { chromeProc, userDataDir, getCdpPort } = launchHeadlessChrome({
    url: baseUrl,
    userDataDirPrefix: 'chrome-dev-broadcast-repro-v3',
  });

  const results = [];
  let hostCdp = null;
  let clientCdp = null;

  const watchdog = createSoftTimeoutWatchdog({
    label: 'DevBroadcastReproV3',
    exitCode: 2,
    onTimeout: async () => {
      try {
        const partial = {
          timestamp: new Date().toISOString(),
          suite: 'DevBroadcastReproV3',
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

    const bootMem = await sampleMemory(hostCdp);

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
      'Host roomId',
      15_000
    );
    await hostCdp.eval(`window.__rcE2E.getAppState().closeMenu()`);

    // Client joins Developer Sync Room
    const { targetId: c1TargetId } = await hostCdp.send('Target.createTarget', {
      url: baseUrl,
      newWindow: true,
    });
    const allTargets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const c1Target = allTargets.find((t) => t.id === c1TargetId);
    clientCdp = new CdpClient(c1Target.webSocketDebuggerUrl, 'client');
    await clientCdp.connect();
    await waitFor(
      () => clientCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client boot',
      60_000
    );
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

    // =========================================================================
    // REPRO 1: Goal Replay enters on Client, but has no dynamics (static)
    // =========================================================================
    await clientCdp.eval(`(() => {
      window.__rcBug1Samples = [];
      window.__rcBug1Sampling = true;
      function sampleTick() {
        const rt = window.__rcE2E?.runtime;
        if (rt) {
          const phase = rt.match?.state?.phase ?? null;
          const hudPhase = window.__rcE2E.getHudState?.()?.matchPhase ?? null;
          if (phase === 'replay' || hudPhase === 'replay') {
            const bv = rt.physics.getBallStateView();
            const simStage = rt.pipeline?.stages?.find?.((s) => s.spectateInterpolationBuffer);
            window.__rcBug1Samples.push({
              phase,
              hudPhase,
              camMode: rt.arena?.cameraMode ?? null,
              override: Boolean(rt.isGoalReplayCameraOverrideActive?.()),
              bx: Math.round(bv.posX * 10) / 10,
              by: Math.round(bv.posY * 10) / 10,
              bz: Math.round(bv.posZ * 10) / 10,
              bufFrames: simStage?.spectateInterpolationBuffer?.getStats?.()?.bufferedFrames ?? -1,
            });
          }
        }
        if (window.__rcBug1Sampling) requestAnimationFrame(sampleTick);
      }
      requestAnimationFrame(sampleTick);
    })()`);

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
      20_000
    );
    await waitFor(
      () =>
        clientCdp.eval(
          `window.__rcE2E.runtime.match?.state?.phase === 'replay' || window.__rcE2E.getHudState?.()?.matchPhase === 'replay'`
        ),
      'Client enters Goal Replay',
      10_000
    ).catch(() => {});
    await waitFor(
      () =>
        hostCdp.eval(
          `!window.__rcE2E.runtime.modeManager?.modes?.get?.('freeplay')?.isGoalReplayActive?.()`
        ),
      'Host exits Freeplay Goal Replay',
      30_000
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    const replaySamples = await clientCdp.eval(`(() => {
      window.__rcBug1Sampling = false;
      const arr = Array.isArray(window.__rcBug1Samples) ? window.__rcBug1Samples : [];
      return arr.filter((s) => s.phase === 'replay' || s.hudPhase === 'replay');
    })()`);

    const distinctBallPositions = new Set(
      replaySamples.map((s) => `${s.bx},${s.by},${s.bz}`)
    ).size;
    const enteredReplay = replaySamples.length > 0;
    const bug1Reproduced = !enteredReplay || distinctBallPositions <= 2;
    record(
      'bug-1-goal-replay-client-static-no-dynamics',
      'Client Enters Goal Replay Without Ball/Car Dynamics',
      bug1Reproduced,
      { enteredReplay, distinctBallPositions, sampleCount: replaySamples.length, replaySamples: replaySamples.slice(0, 12) }
    );

    // =========================================================================
    // REPRO 2, 3, 4: Replay Watch Together (NameTags, Choppy Motion, BoostPad Flicker)
    // =========================================================================
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onReturnToFreeplay()`);
    await new Promise((r) => setTimeout(r, 300));
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartReplayViewer()`);
    await new Promise((r) => setTimeout(r, 300));

    const replayPath = resolveReplayFilePath();
    if (!replayPath) {
      throw new Error(
        'Replay file not found at /tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay'
      );
    }
    const b64 = fs.readFileSync(replayPath).toString('base64');
    await hostCdp.eval(`(async () => {
      const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const file = new File([bin], ${JSON.stringify(path.basename(replayPath))}, { type: 'application/octet-stream' });
      const rv = window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer;
      await rv.handleUploadFile(file);
      rv.seekFrame?.(120);
      rv.startPlaying();
    })()`);
    await new Promise((r) => setTimeout(r, 2500));
    await clientCdp.send('Page.bringToFront');
    await waitFor(
      () =>
        clientCdp.eval(`(() => {
          const rt = window.__rcE2E.runtime;
          const nts = rt.arena?.nameTagSystem;
          return (
            rt.physics?.getHeaderView?.()?.numCars === 6 &&
            (nts?._visibleCards2D?.length ?? 0) > 0
          );
        })()`),
      'Client NameTags rendered',
      10_000,
      100
    ).catch(() => {});
    await clientCdp.eval(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);

    const readTeamsAndTags = (cdp) =>
      cdp.eval(`(() => {
        const rt = window.__rcE2E.runtime;
        const nts = rt.arena?.nameTagSystem;
        const cam = window.__rcE2E.getCamera?.() || rt.camera;
        const ntState = window.__rcE2E.getNameTagState?.();
        const carEntries = Array.isArray(ntState?.carEntries)
          ? [...ntState.carEntries]
              .map((e) => ({
                carIndex: e.carIndex,
                name: e.name || '',
                team: e.team === 1 ? 1 : 0,
              }))
              .sort((a, b) => a.carIndex - b.carIndex)
          : [];
        const tags = [
          ...(nts?._visibleCards2D || []),
          ...(nts?._offscreenIndicators2D || []),
        ].map((c) => ({ carIndex: c.carIndex, displayText: c.displayText }));
        return {
          numCars: rt.physics.getHeaderView().numCars,
          arenaCarTeams: (rt.arena?.carTeams || []).slice(0, 6),
          carEntries,
          tagsCount: tags.length,
          cam: {
            focusedCarIndex: cam?.focusedCarIndex ?? null,
            ballCam: typeof cam?.ballCam === 'boolean' ? cam.ballCam : null,
            isFreeCam: Boolean(cam?.isFreeCam),
          },
        };
      })()`);

    const [hostTeamsAndTags, clientTeamsAndTags] = await Promise.all([
      readTeamsAndTags(hostCdp),
      readTeamsAndTags(clientCdp),
    ]);

    const carEntryMismatches = [];
    for (let i = 0; i < 6; i++) {
      const hEntry = hostTeamsAndTags.carEntries.find((e) => e.carIndex === i) ?? null;
      const cEntry = clientTeamsAndTags.carEntries.find((e) => e.carIndex === i) ?? null;
      if (
        !hEntry ||
        !cEntry ||
        hEntry.name !== cEntry.name ||
        hEntry.team !== cEntry.team
      ) {
        carEntryMismatches.push({ carIndex: i, host: hEntry, client: cEntry });
      }
    }
    const teamMismatch =
      JSON.stringify(hostTeamsAndTags.arenaCarTeams) !==
        JSON.stringify(clientTeamsAndTags.arenaCarTeams) ||
      JSON.stringify(clientTeamsAndTags.arenaCarTeams) !== JSON.stringify([0, 0, 0, 1, 1, 1]);

    // Edge-triggered camera sync verification:
    // 1. Host switches focusedCarIndex -> 2, ballCam -> false => Client must follow
    await hostCdp.eval(`(() => {
      const cam = window.__rcE2E.getCamera();
      cam.setFocusedCarIndex(2);
      cam.ballCam = false;
    })()`);
    const clientAfterHostEdge1 = await waitFor(
      async () => {
        const c = await readTeamsAndTags(clientCdp);
        return c.cam.focusedCarIndex === 2 && c.cam.ballCam === false ? c.cam : null;
      },
      'Client edge-triggered camera sync (car 2, ballCam=false)',
      5_000,
      100
    ).catch(() => null);

    // 2. Client locally switches focusedCarIndex -> 4 while Host stays idle => Client stays on 4
    await clientCdp.eval(`window.__rcE2E.getCamera().setFocusedCarIndex(4)`);
    await new Promise((r) => setTimeout(r, 1200));
    const clientAfterLocalSwitch = (await readTeamsAndTags(clientCdp)).cam;

    // 3. Host switches focusedCarIndex -> 5, ballCam -> true => Client snaps to Host
    await hostCdp.eval(`(() => {
      const cam = window.__rcE2E.getCamera();
      cam.setFocusedCarIndex(5);
      cam.ballCam = true;
    })()`);
    const clientAfterHostEdge2 = await waitFor(
      async () => {
        const c = await readTeamsAndTags(clientCdp);
        return c.cam.focusedCarIndex === 5 && c.cam.ballCam === true ? c.cam : null;
      },
      'Client edge-triggered camera sync (car 5, ballCam=true)',
      5_000,
      100
    ).catch(() => null);

    // Restore Host camera to car 0
    await hostCdp.eval(`window.__rcE2E.getCamera().setFocusedCarIndex(0)`);

    const edgeSyncOk =
      Boolean(clientAfterHostEdge1) &&
      clientAfterLocalSwitch.focusedCarIndex === 4 &&
      Boolean(clientAfterHostEdge2);

    const bug2Reproduced =
      teamMismatch ||
      hostTeamsAndTags.carEntries.length !== 6 ||
      clientTeamsAndTags.carEntries.length !== 6 ||
      carEntryMismatches.length > 0 ||
      clientTeamsAndTags.tagsCount === 0 ||
      !edgeSyncOk;
    record(
      'bug-2-replay-nametag-and-team-desync',
      'Replay Watch Together: Client NameTags & arena.carTeams Not Synced',
      bug2Reproduced,
      {
        host: hostTeamsAndTags,
        client: clientTeamsAndTags,
        teamMismatch,
        carEntryMismatches,
        edgeSync: {
          edgeSyncOk,
          clientAfterHostEdge1,
          clientAfterLocalSwitch,
          clientAfterHostEdge2,
        },
      }
    );

    await clientCdp.send('Page.bringToFront');
    const motionAndPads = await clientCdp.eval(`(async () => {
      const rt = window.__rcE2E.runtime;
      const pads = rt.arena?.boostPadSystem?.pads || [];
      const prevVis = pads.map((p) => Boolean(p.full?.visible));
      const padFlips = new Array(pads.length).fill(0);
      const samples = [];
      for (let f = 0; f < 30; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        const bv = rt.physics.getBallStateView();
        let flipsThisFrame = 0;
        for (let i = 0; i < pads.length; i++) {
          const vis = Boolean(pads[i].full?.visible);
          if (vis !== prevVis[i]) {
            padFlips[i]++;
            flipsThisFrame++;
            prevVis[i] = vis;
          }
        }
        samples.push({
          tick: Math.round(rt.physics.getHeaderView().tickCount),
          bx: Math.round(bv.posX * 10) / 10,
          by: Math.round(bv.posY * 10) / 10,
          bz: Math.round(bv.posZ * 10) / 10,
          flipsThisFrame,
        });
      }
      return { samples, padFlips };
    })()`);

    let frozenBallFrames = 0;
    let maxBallStepUu = 0;
    const distinctTicks = new Set(motionAndPads.samples.map((s) => s.tick)).size;
    for (let i = 1; i < motionAndPads.samples.length; i++) {
      const prev = motionAndPads.samples[i - 1];
      const curr = motionAndPads.samples[i];
      const dist = Math.hypot(curr.bx - prev.bx, curr.by - prev.by, curr.bz - prev.bz);
      if (dist < 0.01) frozenBallFrames++;
      if (dist > maxBallStepUu) maxBallStepUu = Math.round(dist * 10) / 10;
    }
    const bug3Reproduced = distinctTicks <= 1 || (frozenBallFrames >= 3 && maxBallStepUu > 200);
    record(
      'bug-3-replay-choppy-motion-no-physics-lookahead',
      'Client Spectate/Replay Motion Freezes & Teleports Without Deterministic Physics Lookahead',
      bug3Reproduced,
      {
        distinctTicks,
        frozenBallFrames,
        maxBallStepUu,
        sampleSlice: motionAndPads.samples.slice(0, 12),
      }
    );

    const totalPadFlips = motionAndPads.padFlips.reduce((a, b) => a + b, 0);
    const maxSinglePadFlips = Math.max(...motionAndPads.padFlips);
    const bug4Reproduced = maxSinglePadFlips >= 2 || totalPadFlips >= 8;
    record(
      'bug-4-boostpad-model-flicker',
      'Client BoostPad Models Flicker Violently Across Consecutive Frames',
      bug4Reproduced,
      { totalPadFlips, maxSinglePadFlips, padFlips: motionAndPads.padFlips }
    );

    // =========================================================================
    // REPRO 5: High Memory Footprint & Unreleased Memory After Replay Exit
    // =========================================================================
    const loadedMem = await sampleMemory(hostCdp);
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onReturnToFreeplay()`);
    await new Promise((r) => setTimeout(r, 500));
    const afterExitMem = await sampleMemory(hostCdp);

    const tauriLibRs = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/lib.rs'),
      'utf8'
    );
    const tauriCloseHidesWindow =
      tauriLibRs.includes('WindowEvent::CloseRequested') &&
      tauriLibRs.includes('api.prevent_close()') &&
      tauriLibRs.includes('window.hide()');

    const retainedWasmMB = (afterExitMem.wasmMB ?? 0) - (bootMem.wasmMB ?? 0);
    const retainedJsMB = (afterExitMem.jsUsedMB ?? 0) - (bootMem.jsUsedMB ?? 0);
    const retainedGeometries = (afterExitMem.geometries ?? 0) - (bootMem.geometries ?? 0);
    const bug5Reproduced =
      (bootMem.wasmMB ?? 0) >= 256 ||
      retainedWasmMB > 0 ||
      retainedGeometries > 0 ||
      tauriCloseHidesWindow;
    record(
      'bug-5-high-memory-and-unreleased-on-exit',
      'High Baseline WASM/JS Memory & Unreleased Resources on Exit/Close',
      bug5Reproduced,
      {
        bootMem,
        loadedMem,
        afterExitMem,
        retainedWasmMB,
        retainedJsMB,
        retainedGeometries,
        tauriCloseHidesWindow,
      }
    );

    const reproducedCount = results.filter((r) => r.reproduced).length;
    const report = {
      timestamp: new Date().toISOString(),
      suite: 'DevBroadcastReproV3',
      reproducedCount,
      totalCount: results.length,
      results,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.log(
      `[DevBroadcastReproV3] Report written to ${OUT_PATH} (reproduced=${reproducedCount}/${results.length})`
    );
  } finally {
    watchdog.dispose();
    hostCdp?.close();
    clientCdp?.close();
    await cleanupHeadlessChrome(chromeProc, userDataDir);
    await server.close();
  }
}

main().catch((err) => {
  console.error('[DevBroadcastReproV3] FAILED:', err);
  process.exit(1);
});
