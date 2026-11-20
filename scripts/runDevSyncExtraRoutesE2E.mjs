#!/usr/bin/env node
/**
 * scripts/runDevSyncExtraRoutesE2E.mjs
 *
 * Headless Chrome + WebGL + WASM E2E suite for extra Dev Sync Room routes:
 * 1. Freeplay Goal Replay Skip: Host scores -> both enter Goal Replay -> Host skips -> both exit.
 * 2. Coach Handover + Reverse Spectating + Epoch Reclaim:
 *    clientInputEnabled=true -> epoch++ -> Client drives -> Host sees movement ->
 *    clientInputEnabled=false -> epoch++ -> Host reclaims control cleanly.
 * 3. Late-Join Replay Watch Together:
 *    Host loads 3v3 .rcreplay, starts playing, switches POV slot -> new Client2 joins mid-replay ->
 *    Client2 immediately aligns scoreboard, 6-car roster, team orientation & focusedCarIndex.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { createSoftTimeoutWatchdog } from './lib/softTimeoutWatchdog.mjs';

if (!process.env.RC_VITE_ROLE) {
  process.env.RC_VITE_ROLE = 'rc-http';
}

const OUT_PATH = '/tmp/dev-sync-extra-routes-e2e.json';

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

  send(method, params = {}, timeoutMs = 15_000) {
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
  console.log(`[DevSyncExtraRoutes] Vite listening at ${baseUrl}`);

  const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const userDataDir = `/tmp/chrome-dev-sync-extra-routes-${Date.now()}`;
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

  const results = [];
  let hostCdp = null;
  let client1Cdp = null;
  let client2Cdp = null;

  const watchdog = createSoftTimeoutWatchdog({
    label: 'DevSyncExtraRoutes',
    exitCode: 2,
    onTimeout: async () => {
      try {
        const failedCount = results.filter((r) => !r.passed).length;
        fs.writeFileSync(
          OUT_PATH,
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              timedOut: true,
              passedAll: false,
              failedCount,
              totalRoutes: results.length,
              results,
            },
            null,
            2
          )
        );
      } catch {
        // Ignore
      }
      hostCdp?.close();
      client1Cdp?.close();
      client2Cdp?.close();
      try {
        chromeProc.kill('SIGKILL');
      } catch {
        // Ignore
      }
      await server.close().catch(() => {});
    },
  });

  const record = (id, title, passed, detail) => {
    results.push({ id, title, passed, detail });
    const tag = passed ? 'PASS' : 'FAIL';
    watchdog.log(`[${tag}] ${id}: ${title} -> ${JSON.stringify(detail)}`);
  };

  try {
    await waitFor(() => cdpPort, 'Chrome CDP port', 15_000);
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const hostTarget = targets.find((t) => t.type === 'page');
    hostCdp = new CdpClient(hostTarget.webSocketDebuggerUrl, 'host');
    await hostCdp.connect();
    await waitFor(() => hostCdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`), 'Host boot', 60_000);

    // Host creates Dev Sync Room
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

    // Client1 joins
    const c1Target = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(baseUrl)}`,
      { method: 'PUT' }
    ).then((r) => r.json());
    const c1TargetId = c1Target.id;
    client1Cdp = new CdpClient(c1Target.webSocketDebuggerUrl, 'client1');
    await client1Cdp.connect();
    await waitFor(
      () => client1Cdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client1 boot',
      60_000
    );
    await client1Cdp.eval(
      `window.__rcE2E.getAppState().bridge.onJoinOnlineWarmup({ roomId: ${JSON.stringify(roomId)}, playerName: 'Client1' })`
    );
    await waitFor(
      () => client1Cdp.eval(`window.__rcE2E.getAppState().onlineSession?.isDevSyncRoom`),
      'Client1 joined',
      15_000
    );
    await client1Cdp.eval(`window.__rcE2E.getAppState().closeMenu?.()`);
    await new Promise((r) => setTimeout(r, 600));

    // =========================================================================
    // ROUTE 1: Freeplay Goal Replay Skip (Host skips -> both exit Goal Replay)
    // =========================================================================
    await client1Cdp.eval(`(() => {
      window.__skipTestClientPhases = [];
      if (typeof window.__rcE2E.subscribeHudState === 'function') {
        window.__skipTestUnsub = window.__rcE2E.subscribeHudState((hs) => {
          if (hs?.matchPhase && !window.__skipTestClientPhases.includes(hs.matchPhase)) {
            window.__skipTestClientPhases.push(hs.matchPhase);
          }
        });
      }
    })()`);
    await hostCdp.eval(`(() => {
      window.__rcE2E.runtime.physics.setBallState({
        pos: [0, 4850, 95],
        vel: [0, 2950, 40],
        angVel: [0, 0, 0],
      });
    })()`);
    await waitFor(
      async () => {
        const [hActive, cPhases] = await Promise.all([
          hostCdp.eval(
            `Boolean(window.__rcE2E.runtime.modeManager?.modes?.get?.('freeplay')?.isGoalReplayActive?.())`
          ),
          client1Cdp.eval(`window.__skipTestClientPhases || []`),
        ]);
        return hActive && (cPhases.includes('goal') || cPhases.includes('replay'));
      },
      'Host & Client1 enter Freeplay Goal Replay',
      8_000,
      150
    );
    await hostCdp.eval(
      `window.__rcE2E.runtime.modeManager.modes.get('freeplay').skipGoalReplay()`
    );
    await waitFor(
      async () => {
        const [hActive, cPhase] = await Promise.all([
          hostCdp.eval(
            `Boolean(window.__rcE2E.runtime.modeManager?.modes?.get?.('freeplay')?.isGoalReplayActive?.())`
          ),
          client1Cdp.eval(`window.__rcE2E.runtime?.match?.state?.phase ?? null`),
        ]);
        return !hActive && cPhase === 'playing';
      },
      'Host & Client1 exit Goal Replay after skip',
      5_000,
      100
    );
    const [skipHostActive, skipClientPhase, skipClientPhases] = await Promise.all([
      hostCdp.eval(
        `Boolean(window.__rcE2E.runtime.modeManager?.modes?.get?.('freeplay')?.isGoalReplayActive?.())`
      ),
      client1Cdp.eval(`window.__rcE2E.runtime?.match?.state?.phase ?? null`),
      client1Cdp.eval(`(() => { if (window.__skipTestUnsub) window.__skipTestUnsub(); return window.__skipTestClientPhases || []; })()`),
    ]);
    record(
      'extra-1-freeplay-goal-replay-skip',
      'Freeplay Goal Replay Skip Syncs Exit Across Host & Client',
      !skipHostActive && skipClientPhase === 'playing',
      { skipHostActive, skipClientPhase, skipClientPhases }
    );

    // =========================================================================
    // ROUTE 2: Coach Handover + Reverse Spectating + Epoch Fencing & Reclaim
    // =========================================================================
    const epochBefore = await hostCdp.eval(
      `window.__rcE2E.getMultiplayerSession?.()?.hostController?.inputAuthority?.authorityEpoch ?? 0`
    );
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onSetClientInputEnabled?.(true)`);
    await waitFor(
      () =>
        client1Cdp.eval(`Boolean(window.__rcE2E.runtime?.networkReconciler?.clientInputEnabled)`),
      'Client1 receives input authority',
      5_000
    );
    const epochHandover = await hostCdp.eval(
      `window.__rcE2E.getMultiplayerSession?.()?.hostController?.inputAuthority?.authorityEpoch ?? 0`
    );
    const carBeforeClientDrive = await hostCdp.eval(
      `(() => { const v = window.__rcE2E.runtime.physics.getCarStateView(0); return v ? [Math.round(v.posX), Math.round(v.posY)] : null; })()`
    );
    await client1Cdp.send('Page.bringToFront');
    await client1Cdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys?.add) { kb.keys.add('KeyW'); kb.keys.add('ShiftLeft'); }
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    await client1Cdp.eval(`(() => {
      const kb = window.__rcE2E.runtime.keyboard;
      if (kb?.keys?.delete) { kb.keys.delete('KeyW'); kb.keys.delete('ShiftLeft'); }
    })()`);
    await hostCdp.send('Page.bringToFront');
    await waitFor(
      async () => {
        const pos = await hostCdp.eval(
          `(() => { const v = window.__rcE2E.runtime.physics.getCarStateView(0); return v ? [Math.round(v.posX), Math.round(v.posY)] : null; })()`
        );
        return (
          carBeforeClientDrive &&
          pos &&
          Math.hypot(pos[0] - carBeforeClientDrive[0], pos[1] - carBeforeClientDrive[1]) > 50
        );
      },
      'Host spectates Client1 driving',
      4_000
    );
    const carAfterClientDrive = await hostCdp.eval(
      `(() => { const v = window.__rcE2E.runtime.physics.getCarStateView(0); return v ? [Math.round(v.posX), Math.round(v.posY)] : null; })()`
    );
    // Reclaim authority back to Host
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onSetClientInputEnabled?.(false)`);
    await waitFor(
      () =>
        client1Cdp.eval(
          `window.__rcE2E.runtime?.networkReconciler?.clientInputEnabled === false`
        ),
      'Client1 authority revoked',
      5_000
    );
    const epochReclaim = await hostCdp.eval(
      `window.__rcE2E.getMultiplayerSession?.()?.hostController?.inputAuthority?.authorityEpoch ?? 0`
    );
    const distClientDrove = Math.round(
      Math.hypot(
        carAfterClientDrive[0] - carBeforeClientDrive[0],
        carAfterClientDrive[1] - carBeforeClientDrive[1]
      )
    );
    record(
      'extra-2-coach-handover-epoch-reclaim',
      'Coach Handover + Reverse Spectating + Epoch Fencing & Reclaim',
      epochHandover > epochBefore && epochReclaim > epochHandover && distClientDrove > 50,
      { epochBefore, epochHandover, epochReclaim, distClientDrove }
    );

    // Close Client1 before launching Client2 for Late-Join so SwiftShader stays at 2 windows
    client1Cdp.close();
    client1Cdp = null;
    await hostCdp.send('Target.closeTarget', { targetId: c1TargetId }).catch(() => {});

    // =========================================================================
    // ROUTE 3: Late-Join Replay Watch Together
    // =========================================================================
    const replayPath = resolveReplayFilePath();
    if (!replayPath) {
      throw new Error(
        'Replay file not found at /tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay'
      );
    }
    await hostCdp.eval(`window.__rcE2E.getAppState().bridge.onStartReplayViewer()`);
    await new Promise((r) => setTimeout(r, 300));
    const b64 = fs.readFileSync(replayPath).toString('base64');
    await hostCdp.eval(`(async () => {
      const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const file = new File([bin], ${JSON.stringify(path.basename(replayPath))}, { type: 'application/octet-stream' });
      const rv = window.__rcE2E.runtime.modeManager.modes.get('freeplay').standaloneReplayViewer;
      await rv.handleUploadFile(file);
      rv.startPlaying();
      rv.selectPovSlot?.(3);
    })()`);
    await new Promise((r) => setTimeout(r, 600));
    const hostLateJoinSnap = await hostCdp.eval(`(() => {
      const sbEl = document.querySelector('[data-alpha-id="Alpha:StepperScoreboardHUD"]');
      const cards = Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]')).filter(
        (el) => getComputedStyle(el).display !== 'none'
      );
      return {
        domScoreboard: Boolean(sbEl),
        scoreboardText: sbEl ? (sbEl.textContent || '').replace(/\\s+/g, ' ').trim() : null,
        cardNames: cards.map((el) => (el.textContent || '').trim()).filter(Boolean),
        focusedCarIndex: window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1,
      };
    })()`);

    // Now Client2 late-joins while Host is already in Replay Watch Together
    const c2Target = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(baseUrl)}`,
      { method: 'PUT' }
    ).then((r) => r.json());
    client2Cdp = new CdpClient(c2Target.webSocketDebuggerUrl, 'client2');
    await client2Cdp.connect();
    await waitFor(
      () => client2Cdp.eval(`Boolean(window.__rcE2E?.runtime?.physics)`),
      'Client2 boot',
      60_000
    );
    await client2Cdp.eval(
      `window.__rcE2E.getAppState().bridge.onJoinOnlineWarmup({ roomId: ${JSON.stringify(roomId)}, playerName: 'LateJoinClient' })`
    );
    await waitFor(
      () => client2Cdp.eval(`window.__rcE2E.getAppState().onlineSession?.isDevSyncRoom`),
      'Client2 late-joined Dev Sync Room',
      15_000
    );
    await client2Cdp.eval(`window.__rcE2E.getAppState().closeMenu?.()`);
    await client2Cdp.send('Page.bringToFront');

    let hostLiveSnap = null;
    let c2Snap = null;
    const stripBoost = (names) => names.map((n) => n.replace(/\d+x$/, ''));
    await waitFor(
      async () => {
        [hostLiveSnap, c2Snap] = await Promise.all([
          hostCdp.eval(`(() => {
            const sbEl = document.querySelector('[data-alpha-id="Alpha:StepperScoreboardHUD"]');
            const cards = Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]')).filter(
              (el) => getComputedStyle(el).display !== 'none'
            );
            return {
              domScoreboard: Boolean(sbEl),
              scoreboardText: sbEl ? (sbEl.textContent || '').replace(/\\s+/g, ' ').trim() : null,
              cardNames: cards.map((el) => (el.textContent || '').trim()).filter(Boolean),
              focusedCarIndex: window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1,
            };
          })()`),
          client2Cdp.eval(`(() => {
            const app = window.__rcE2E.getAppState?.();
            const sbEl = document.querySelector('[data-alpha-id="Alpha:StepperScoreboardHUD"]');
            const cards = Array.from(document.querySelectorAll('[data-alpha-id*="EdgePlayerSlotCard"]')).filter(
              (el) => getComputedStyle(el).display !== 'none'
            );
            return {
              matchMode: app?.matchMode ?? null,
              activeRoomActivity: app?.onlineSession?.activeRoomActivity ?? null,
              domScoreboard: Boolean(sbEl),
              scoreboardText: sbEl ? (sbEl.textContent || '').replace(/\\s+/g, ' ').trim() : null,
              domRosterCards: cards.length,
              cardNames: cards.map((el) => (el.textContent || '').trim()).filter(Boolean),
              focusedCarIndex: window.__rcE2E.getCamera?.()?.focusedCarIndex ?? -1,
            };
          })()`),
        ]);
        return (
          c2Snap.matchMode === 'replay-viewer' &&
          c2Snap.activeRoomActivity === 'replay' &&
          c2Snap.domScoreboard &&
          c2Snap.domRosterCards === 6 &&
          JSON.stringify(stripBoost(c2Snap.cardNames)) ===
            JSON.stringify(stripBoost(hostLiveSnap.cardNames)) &&
          c2Snap.focusedCarIndex === hostLiveSnap.focusedCarIndex
        );
      },
      'Late-Join Client2 aligns Replay HUD, 6-card roster & focusedCarIndex',
      12_000,
      150
    ).catch(() => {});

    const lateJoinOk =
      c2Snap &&
      hostLiveSnap &&
      c2Snap.matchMode === 'replay-viewer' &&
      c2Snap.activeRoomActivity === 'replay' &&
      c2Snap.domScoreboard &&
      c2Snap.domRosterCards === 6 &&
      JSON.stringify(stripBoost(c2Snap.cardNames)) ===
        JSON.stringify(stripBoost(hostLiveSnap.cardNames)) &&
      c2Snap.focusedCarIndex === hostLiveSnap.focusedCarIndex;
    record(
      'extra-3-late-join-replay-watch-together',
      'Late-Join Client Immediately Aligns Replay HUD, 6-Car Roster & POV Focus',
      Boolean(lateJoinOk),
      { host: hostLiveSnap, lateJoinClient: c2Snap }
    );

    const failedCount = results.filter((r) => !r.passed).length;
    const report = {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      passedAll: failedCount === 0,
      failedCount,
      totalRoutes: results.length,
      results,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.log(
      `[DevSyncExtraRoutes] Report written to ${OUT_PATH} (passed=${results.length - failedCount}/${results.length})`
    );
    if (failedCount > 0) {
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
      // Ignore Chrome async lock file cleanup race
    }
  }
}

main().catch((err) => {
  console.error('[DevSyncExtraRoutes] FAILED:', err);
  process.exit(1);
});
