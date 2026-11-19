#!/usr/bin/env node
/**
 * scripts/runDevBroadcastReproV2.mjs
 *
 * Headless Chrome E2E reproduction suite for Developer Broadcasting (Dev Sync Room)
 * & Replay Watch Together issues:
 *
 * 1. Freeplay Goal Scoring in Dev Sync Room:
 *    Scoring a goal in Freeplay fails to trigger Cinematic Goal Replay; ball gets stuck/dark
 *    because FreeplayGoalAndTouchSubController returns early when authoritativeServer exists.
 * 2. Replay Watch Together (3v3 .rcreplay) Client UI & Roster Names:
 *    Client receives state frames, but TelemetryStage._syncEdgeRosterHud() returns early
 *    when matchMode === 'freeplay' && !isReplayViewerLoaded, leaving Client with empty
 *    left/right 1-3 & 4-6 roster strips and unsynced scoreboard clock/scores.
 * 3. Camera / Spectated Player Switching (1-6) & Default Focus Mismatch:
 *    Client defaults to its own playerCarIndex instead of Host's focused car, and when Host
 *    switches focusedCarIndex (1..6), channel.onCameraStateSync does not update
 *    useSpectateWorkspaceStore.hostCameraSync, so GameCameraSubsystem overwrites it back.
 * 4. Exhibition 3v3 Kickoff Countdown 3-2-1 on Client:
 *    Client only triggers/plays "3" (or aborts immediately if tick > 360) and misses "2" & "1"
 *    because experimentalMultiBotsLifecyclePipeline emits remainingTicks as param1 while
 *    RuntimeKickoffSignalSubController treats param1 as an absolute targetFrame tick.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

if (!process.env.RC_VITE_ROLE) {
  process.env.RC_VITE_ROLE = 'rc-http';
}

const OUT_PATH = '/tmp/dev-broadcast-repro-v2.json';
const MAX_DURATION_MS = 260_000;

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
  console.log(`[DevBroadcastReproV2] Vite listening at ${baseUrl}`);

  const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const userDataDir = `/tmp/chrome-dev-broadcast-repro-v2-${Date.now()}`;
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
    console.error('[DevBroadcastReproV2] Watchdog timeout reached!');
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
    console.log(`[DevBroadcastReproV2] [${tag}] ${id}: ${title} -> ${JSON.stringify(detail)}`);
  };

  let hostCdp = null;
  let clientCdp = null;

  try {
    await waitFor(() => cdpPort, 'Chrome CDP port', 15_000);
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const hostTarget = targets.find((t) => t.type === 'page');
    hostCdp = new CdpClient(hostTarget.webSocketDebuggerUrl, 'host');
    await hostCdp.connect();
    await waitFor(
      () => hostCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Host boot',
      60_000
    );

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

    // Client joins Developer Sync Room (separate window so Chrome does not throttle rAF)
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
    await new Promise((r) => setTimeout(r, 800));

    // =========================================================================
    // REPRO 1: Freeplay Goal Scoring -> No Cinematic Goal Replay (Ball Stuck/Dark)
    // =========================================================================
    await clientCdp.eval(`(() => {
      window.__bug1ClientPhases = [];
      if (typeof window.__rcE2E.subscribeHudState === 'function') {
        window.__bug1ClientUnsub = window.__rcE2E.subscribeHudState((hs) => {
          if (hs?.matchPhase && !window.__bug1ClientPhases.includes(hs.matchPhase)) {
            window.__bug1ClientPhases.push(hs.matchPhase);
          }
        });
      }
    })()`);
    await hostCdp.eval(`(() => {
      const rt = window.__rcE2E.runtime;
      const phys = rt.physics;
      // Place ball right in front of Orange goal (+Y) moving fast into goal (+Y)
      phys.setBallState({
        pos: [0, 4850, 95],
        vel: [0, 2950, 40],
        angVel: [0, 0, 0],
      });
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    const repro1Mid = await hostCdp.eval(`(() => {
      const bv = window.__rcE2E.runtime.physics?.getBallStateView?.();
      return bv ? { posY: Math.round(bv.posY), velY: Math.round(bv.velY) } : null;
    })()`);
    await waitFor(
      async () => {
        const [hostReady, clientPhases] = await Promise.all([
          hostCdp.eval(
            `Boolean(window.__rcE2E.runtime.modeManager?.modes?.get?.('freeplay')?.isGoalReplayActive?.())`
          ),
          clientCdp.eval(`window.__bug1ClientPhases || []`),
        ]);
        return (
          hostReady &&
          Array.isArray(clientPhases) &&
          (clientPhases.includes('goal') || clientPhases.includes('replay'))
        );
      },
      'Host & Client enter Freeplay Goal Replay',
      6_000,
      150
    ).catch(() => {});

    const [repro1Snap, clientBug1Phases] = await Promise.all([
      hostCdp.eval(`(() => {
        const rt = window.__rcE2E.runtime;
        const fp = rt.modeManager?.modes?.get?.('freeplay');
        const bv = rt.physics?.getBallStateView?.();
        const hdr = rt.physics?.getHeaderView?.();
        return {
          matchMode: rt.match?.state?.mode ?? null,
          matchPhase: rt.match?.state?.phase ?? null,
          hasAuthServer: Boolean(rt.authoritativeServer),
          isGoalReplayActive: Boolean(fp?.isGoalReplayActive?.()),
          goalResetTicks: fp?.goalAndTouch?.goalResetTicks ?? -1,
          goalIncidentTick: fp?.goalAndTouch?.goalIncidentTick ?? -1,
          ballPosY: bv ? Math.round(bv.posY) : null,
          ballVelY: bv ? Math.round(bv.velY) : null,
          goalScoredFlag: hdr?.goalScoredFlag ?? 0,
        };
      })()`),
      clientCdp.eval(`(() => {
        if (window.__bug1ClientUnsub) window.__bug1ClientUnsub();
        return window.__bug1ClientPhases || [];
      })()`),
    ]);
    repro1Snap.midBall = repro1Mid;
    repro1Snap.clientPhases = clientBug1Phases;
    const clientSawGoalOrReplay =
      clientBug1Phases.includes('goal') || clientBug1Phases.includes('replay');
    const bug1Reproduced =
      (!repro1Snap.isGoalReplayActive && repro1Snap.goalResetTicks <= 0) ||
      !clientSawGoalOrReplay;
    record(
      'bug-1-freeplay-goal-replay',
      'Freeplay Goal Scoring Fails to Trigger Cinematic Goal Replay in Dev Sync Room',
      bug1Reproduced,
      repro1Snap
    );

    // =========================================================================
    // REPRO 2: Replay Watch Together (3v3 .rcreplay) -> Client Missing Roster Names, 1-3/4-6 Strips & Scoreboard
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
      rv.startPlaying();
    })()`);

    await clientCdp.send('Page.bringToFront');
    const readReplayUi = async (cdp, includeClientMeta) =>
      cdp.eval(`(() => {
        const app = window.__rcE2E.getAppState?.();
        const sbEl = document.querySelector('[data-alpha-id="Alpha:StepperScoreboardHUD"]');
        const cards = Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]')).filter(
          (el) => getComputedStyle(el).display !== 'none'
        );
        const cardNames = cards.map((el) => (el.textContent || '').trim()).filter(Boolean);
        return {
          ${
            includeClientMeta
              ? `matchMode: app?.matchMode ?? null,
                activeRoomActivity: app?.onlineSession?.activeRoomActivity ?? null,
                playerCarIndex: window.__rcE2E.runtime?.playerCarIndex ?? -1,`
              : ''
          }
          domScoreboard: Boolean(sbEl),
          scoreboardText: sbEl ? (sbEl.textContent || '').replace(/\\s+/g, ' ').trim() : null,
          domRosterCards: cards.length,
          cardNames,
          focusedCarIndex: window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1,
        };
      })()`);

    let hostRepUi = null;
    let clientRepUi = null;
    await waitFor(
      async () => {
        [hostRepUi, clientRepUi] = await Promise.all([
          readReplayUi(hostCdp, false),
          readReplayUi(clientCdp, true),
        ]);
        const isDefaultPlaceholder = (names) =>
          names.some((n) => n.includes('You (Octane_99)') || n.includes('Zen_Master_RL'));
        return (
          hostRepUi.domScoreboard &&
          clientRepUi.domScoreboard &&
          hostRepUi.domRosterCards === 6 &&
          clientRepUi.domRosterCards === 6 &&
          !isDefaultPlaceholder(hostRepUi.cardNames) &&
          !isDefaultPlaceholder(clientRepUi.cardNames) &&
          JSON.stringify(hostRepUi.cardNames) === JSON.stringify(clientRepUi.cardNames)
        );
      },
      'Host & Client replay HUD + 6 roster cards synced',
      8_000,
      150
    ).catch(() => {});
    if (!hostRepUi || !clientRepUi) {
      [hostRepUi, clientRepUi] = await Promise.all([
        readReplayUi(hostCdp, false),
        readReplayUi(clientCdp, true),
      ]);
    }

    const bug2Reproduced =
      hostRepUi.domRosterCards !== 6 ||
      clientRepUi.domRosterCards !== 6 ||
      clientRepUi.cardNames.length !== 6 ||
      JSON.stringify(hostRepUi.cardNames) !== JSON.stringify(clientRepUi.cardNames) ||
      !clientRepUi.domScoreboard ||
      hostRepUi.scoreboardText !== clientRepUi.scoreboardText;
    record(
      'bug-2-replay-ui-and-roster',
      'Replay Watch Together: Client Missing Roster Names, 1-6 Strips & Scoreboard Sync',
      bug2Reproduced,
      {
        host: hostRepUi,
        client: clientRepUi,
      }
    );

    // =========================================================================
    // REPRO 3: Camera / Spectated Player Switching (1-6) Not Synced to Client
    // =========================================================================
    await hostCdp.send('Page.bringToFront');
    await hostCdp.eval(`(() => {
      const rv = window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer;
      rv.selectPovSlot?.(3);
    })()`);
    await clientCdp.send('Page.bringToFront');
    await new Promise((r) => setTimeout(r, 600));

    const camSwitch1 = await Promise.all([
      hostCdp.eval(`window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1`),
      clientCdp.eval(`(() => {
        const ws = window.__rcE2E.getWorkspaceState?.();
        const cars = window.__rcE2E.runtime?.arena?.cars;
        return {
          focusedCarIndex: window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1,
          wsIsSpectating: Boolean(ws?.isSpectating),
          wsFollowHostCamera: Boolean(ws?.followHostCamera),
          wsFocusedCarIndex: ws?.hostCameraSync?.focusedCarIndex ?? null,
          car2Visible: Boolean(cars?.[2]?.visible),
          playerCarIndex: window.__rcE2E.runtime?.playerCarIndex ?? -1,
        };
      })()`),
    ]);

    // Client locally switches to car 4 while Host stays on slot 3 -> must NOT be pulled back
    await clientCdp.eval(`window.__rcE2E.getCamera()?.setFocusedCarIndex?.(4)`);
    await new Promise((r) => setTimeout(r, 450));
    const clientLocalHoldFocused = await clientCdp.eval(
      `window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1`
    );

    // Host switches to slot 6 -> Client must immediately follow Host's new focusedCarIndex
    await hostCdp.send('Page.bringToFront');
    await hostCdp.eval(`(() => {
      const rv = window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer;
      rv.selectPovSlot?.(6);
    })()`);
    await clientCdp.send('Page.bringToFront');
    await new Promise((r) => setTimeout(r, 600));
    const [hostAfterSwitch6, clientAfterHostSwitch6] = await Promise.all([
      hostCdp.eval(`window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1`),
      clientCdp.eval(`window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1`),
    ]);

    const bug3Reproduced =
      camSwitch1[0] !== camSwitch1[1].focusedCarIndex ||
      clientRepUi.focusedCarIndex !== hostRepUi.focusedCarIndex ||
      clientLocalHoldFocused !== 4 ||
      clientAfterHostSwitch6 !== hostAfterSwitch6 ||
      hostAfterSwitch6 === 4;
    record(
      'bug-3-camera-player-switch-sync',
      'Camera Player Switch (1-6) & Default Focus Not Persisted on Client',
      bug3Reproduced,
      {
        initialHostFocused: hostRepUi.focusedCarIndex,
        initialClientFocused: clientRepUi.focusedCarIndex,
        afterSwitchHostFocused: camSwitch1[0],
        afterSwitchClient: camSwitch1[1],
        clientLocalHoldFocused,
        hostAfterSwitch6,
        clientAfterHostSwitch6,
      }
    );

    // =========================================================================
    // REPRO 4: Exhibition 3v3 Countdown 3-2-1 on Client ("Only 3, Missing 2 and 1")
    // =========================================================================
    await hostCdp.send('Page.bringToFront');
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onReturnToFreeplay()`);
    await new Promise((r) => setTimeout(r, 400));

    // Install audio & match.state countdown spies on both Host and Client
    const installSpyExpr = `(() => {
      const rt = window.__rcE2E.runtime;
      window.__countdownLog = { audioPlays: [], matchStates: [], domCountdownTexts: [] };
      const audioTarget =
        window.__rcE2E?.gameAudio || rt.options?.gameAudio || rt.audio || rt.audioSubsystem?.audio;
      const origPlay = audioTarget?.play?.bind(audioTarget);
      if (origPlay && !audioTarget.__reproPatched) {
        audioTarget.__reproPatched = true;
        audioTarget.play = (key, ...rest) => {
          if (String(key).includes('countdown')) {
            window.__countdownLog.audioPlays.push({ key, t: Date.now() });
          }
          return origPlay(key, ...rest);
        };
      }
      if (!window.__reproHudUnsub && typeof window.__rcE2E.subscribeHudState === 'function') {
        let lastHudKey = null;
        window.__reproHudUnsub = window.__rcE2E.subscribeHudState((hs) => {
          const val = hs ? { phase: hs.matchPhase, cd: hs.kickoffCountdown } : null;
          const key = JSON.stringify(val);
          if (key !== lastHudKey && val) {
            lastHudKey = key;
            window.__countdownLog.matchStates.push(val);
          }
        });
      }
      if (!window.__reproHudPoll) {
        let lastVal = null;
        let lastDom = null;
        window.__reproHudPoll = setInterval(() => {
          const ms = window.__rcE2E.runtime?.match?.state;
          const val = ms ? { phase: ms.phase, cd: ms.countdown } : null;
          const key = JSON.stringify(val);
          if (key !== lastVal && val && !window.__reproHudUnsub) {
            lastVal = key;
            window.__countdownLog.matchStates.push(val);
          }
          const cdEl = document.querySelector('[data-alpha-id*="CenterUpper"]');
          const cdText = cdEl ? (cdEl.textContent || '').trim() : '';
          if (cdText && cdText !== lastDom) {
            lastDom = cdText;
            window.__countdownLog.domCountdownTexts.push(cdText);
          }
        }, 50);
      }
    })()`;
    await hostCdp.eval(installSpyExpr);
    await clientCdp.eval(installSpyExpr);

    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartMatch('necto', 90, 'standard')`);
    await waitFor(
      () =>
        clientCdp.eval(`(() => {
          const states = window.__countdownLog?.matchStates || [];
          const sawKickoff = states.some((s) => s.phase === 'kickoff');
          const last = states[states.length - 1];
          return sawKickoff && last?.phase === 'playing';
        })()`),
      'Client finishes 3-2-1-GO countdown',
      10_000,
      100
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    const [hostCd, clientCd] = await Promise.all([
      hostCdp.eval(`window.__countdownLog`),
      clientCdp.eval(`window.__countdownLog`),
    ]);

    const clientCountdownNums = clientCd.matchStates.map((v) => v.cd).filter((n) => n > 0);
    const has3 = clientCountdownNums.includes(3);
    const has2 = clientCountdownNums.includes(2);
    const has1 = clientCountdownNums.includes(1);
    const bug4Reproduced = !(has3 && has2 && has1) || clientCd.audioPlays.length < 3;
    record(
      'bug-4-exhibition-countdown-321',
      'Exhibition Countdown 3-2-1 Missing 2 & 1 on Client',
      bug4Reproduced,
      {
        hostCountdownAudioCount: hostCd.audioPlays.length,
        hostMatchStates: hostCd.matchStates,
        clientCountdownAudioCount: clientCd.audioPlays.length,
        clientMatchStates: clientCd.matchStates,
        clientDomCountdownTexts: clientCd.domCountdownTexts,
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
    console.log(
      `[DevBroadcastReproV2] Report written to ${OUT_PATH} (reproduced=${reproducedCount}/${results.length})`
    );
    if (reproducedCount === 0) {
      console.log('[DevBroadcastReproV2] All 4 bugs are now FIXED!');
    }
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
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[DevBroadcastReproV2] FAILED:', err);
  process.exit(1);
});
