import { ArenaRenderer } from './ArenaRenderer.ts';
import { KeyboardInputReader } from './KeyboardInput.ts';

function ensureSplitScreenDom(): {
  hostCanvas: HTMLCanvasElement;
  clientCanvas: HTMLCanvasElement;
  statusEl: HTMLElement;
} {
  const existingHost = document.getElementById('canvas-host') as HTMLCanvasElement | null;
  const existingClient = document.getElementById('canvas-client') as HTMLCanvasElement | null;
  const existingStatus = document.getElementById('mvp1-status') as HTMLElement | null;
  if (existingHost && existingClient && existingStatus) {
    return {
      hostCanvas: existingHost,
      clientCanvas: existingClient,
      statusEl: existingStatus,
    };
  }

  document.body.innerHTML = `
    <div id="mvp1-bar" style="height:32px;line-height:32px;padding:0 12px;background:#0f172a;border-bottom:1px solid #1e293b;font-size:12px;color:#e2e8f0;font-family:monospace;">
      <span id="mvp1-status">Initializing rc_core.wasm...</span>
    </div>
    <div id="mvp1-split" style="display:flex;width:100%;height:calc(100vh - 32px);background:#0b1220;">
      <div style="position:relative;flex:1;height:100%;border-right:1px solid #1e293b;">
        <div style="position:absolute;top:8px;left:10px;padding:2px 8px;background:rgba(15,23,42,0.78);border:1px solid rgba(56,189,248,0.35);border-radius:4px;font-size:11px;color:#e2e8f0;pointer-events:none;z-index:2;">HOST (120Hz Direct ArrayBuffer)</div>
        <canvas id="canvas-host" style="display:block;width:100%;height:100%;"></canvas>
      </div>
      <div style="position:relative;flex:1;height:100%;">
        <div style="position:absolute;top:8px;left:10px;padding:2px 8px;background:rgba(15,23,42,0.78);border:1px solid rgba(56,189,248,0.35);border-radius:4px;font-size:11px;color:#e2e8f0;pointer-events:none;z-index:2;">CLIENT SIM (60Hz + 5~25ms Jitter)</div>
        <canvas id="canvas-client" style="display:block;width:100%;height:100%;"></canvas>
      </div>
    </div>
  `;

  return {
    hostCanvas: document.getElementById('canvas-host') as HTMLCanvasElement,
    clientCanvas: document.getElementById('canvas-client') as HTMLCanvasElement,
    statusEl: document.getElementById('mvp1-status') as HTMLElement,
  };
}

let started = false;

export function startMvp1SplitScreen(): void {
  if (started) return;
  started = true;

  const { hostCanvas, clientCanvas, statusEl } = ensureSplitScreenDom();
  const hostRenderer = new ArenaRenderer(hostCanvas, { interpDelayMs: 18 });
  const clientRenderer = new ArenaRenderer(clientCanvas, { interpDelayMs: 42 });

  let clientCap30Fps = false;
  let lastClientRenderMs = 0;
  let workerReady = false;
  let workerError: string | null = null;
  let frameParityCounter = 0;

  const worker = new Worker(new URL('./rcCoreWorker.ts', import.meta.url), {
    type: 'module',
  });

  const controlsBuffer = new Float32Array(9);
  const input = new KeyboardInputReader({
    onResetKickoff: () => {
      worker.postMessage({ type: 'reset', seed: -1 });
    },
    onToggleClient30Fps: () => {
      clientCap30Fps = !clientCap30Fps;
    },
  });

  worker.addEventListener('message', (evt: MessageEvent) => {
    const msg = evt.data as
      | { type: 'ready'; frameLen: number }
      | { type: 'frame'; buffer: ArrayBuffer }
      | { type: 'error'; message: string };

    if (msg.type === 'ready') {
      workerReady = true;
      return;
    }
    if (msg.type === 'error') {
      workerError = msg.message;
      statusEl.textContent = `ERROR: ${msg.message}`;
      return;
    }
    if (msg.type === 'frame') {
      const nowMs = performance.now();
      const hostCopy = msg.buffer.slice(0);
      hostRenderer.pushFrameBuffer(hostCopy, nowMs);

      frameParityCounter++;
      if (frameParityCounter % 2 === 0) {
        const jitterMs = 5 + Math.random() * 20;
        const clientCopy = msg.buffer;
        setTimeout(() => {
          clientRenderer.pushFrameBuffer(clientCopy, performance.now());
        }, jitterMs);
      }
    }
  });

  function animate(nowMs: number): void {
    const c = input.sample();
    controlsBuffer[0] = c.throttle;
    controlsBuffer[1] = c.steer;
    controlsBuffer[2] = c.pitch;
    controlsBuffer[3] = c.yaw;
    controlsBuffer[4] = c.roll;
    controlsBuffer[5] = c.jump ? 1 : 0;
    controlsBuffer[6] = c.boost ? 1 : 0;
    controlsBuffer[7] = c.handbrake ? 1 : 0;
    controlsBuffer[8] = c.ballCam ? 1 : 0;
    worker.postMessage({ type: 'controls', data: controlsBuffer });

    hostRenderer.render(nowMs);

    if (!clientCap30Fps || nowMs - lastClientRenderMs >= 33.3) {
      lastClientRenderMs = nowMs;
      clientRenderer.render(nowMs);
    }

    if (workerReady && !workerError) {
      const h = hostRenderer.getDebugSnapshot();
      const cl = clientRenderer.getDebugSnapshot();
      statusEl.textContent =
        `MVP-1 Rust Core | Tick: ${h.latestTick} | TeleportSeq: ${h.lastTeleportSeq} | ` +
        `BallCam[C]: ${c.ballCam ? 'ON' : 'OFF'} | ClientFPS[F]: ${clientCap30Fps ? '30fps Cap' : 'Uncapped'} | ` +
        `HostRx: ${h.receivedCount} | ClientRx(60Hz+Jitter): ${cl.receivedCount} | Reset[R]`;
    }

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);

  (window as unknown as Record<string, unknown>).__MVP1_DEBUG__ = {
    getState: () => ({
      workerReady,
      workerError,
      clientCap30Fps,
      host: hostRenderer.getDebugSnapshot(),
      client: clientRenderer.getDebugSnapshot(),
    }),
    triggerReset: () => {
      worker.postMessage({ type: 'reset', seed: 42 });
    },
    setControls: (partial: Partial<typeof controlsBuffer>) => {
      Object.assign(controlsBuffer, partial);
    },
    dispose: () => {
      input.dispose();
      worker.terminate();
    },
  };
}

if (document.getElementById('canvas-host')) {
  startMvp1SplitScreen();
}
