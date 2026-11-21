import { ArenaRenderer } from './ArenaRenderer.ts';
import { BufferedFrameSource } from './FrameSource.ts';
import { InputController } from './InputController.ts';
import {
  FRAME_FLAG_BALL_CAM,
  FRAME_FLAG_BOOSTING,
  FRAME_FLAG_GROUNDED,
  FRAME_FLAG_HAS_FLIPPED,
  FRAME_FLAG_HAS_JUMPED,
  FRAME_FLAG_SUPERSONIC,
  createEmptyRenderFrame,
  decodeTelemetryBuffer,
  type RenderFrameData,
  type TelemetrySampleData,
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
} from './protocol.ts';

export interface Mvp1Diagnostics {
  ready: boolean;
  tick: number;
  teleportSeq: number;
  ballCam: boolean;
  boost: number;
  speedUu: number;
  camFov: number;
  leftDepthTicks: number;
  rightDepthTicks: number;
  lastJitterMs: number;
  leftRenderCount: number;
  rightRenderCount: number;
  lastTelemetry: TelemetrySampleData[];
}

declare global {
  interface Window {
    __RC_MVP1__?: {
      getStats: () => Mvp1Diagnostics;
      resetKickoff: () => void;
      toggleBallCam: () => void;
      requestTelemetry: () => void;
    };
  }
}

export class Mvp1App {
  private readonly worker: Worker;
  private readonly leftRenderer: ArenaRenderer;
  private readonly rightRenderer: ArenaRenderer;
  private readonly leftSource = new BufferedFrameSource();
  private readonly rightSource = new BufferedFrameSource();
  private readonly leftFrame: RenderFrameData = createEmptyRenderFrame();
  private readonly rightFrame: RenderFrameData = createEmptyRenderFrame();
  private readonly input: InputController;

  private readonly statusEl: HTMLElement;
  private readonly hudEl: HTMLElement;
  private readonly jitterTimers = new Set<ReturnType<typeof setTimeout>>();

  private ready = false;
  private frameCounter = 0;
  private lastJitterMs = 0;
  private lastHudUpdateMs = 0;
  private lastRafMs = 0;
  private rafId = 0;
  private leftRenderCount = 0;
  private rightRenderCount = 0;
  private lastLeftDepth = 0;
  private lastRightDepth = 0;
  private lastTelemetry: TelemetrySampleData[] = [];

  constructor(
    leftCanvas: HTMLCanvasElement,
    rightCanvas: HTMLCanvasElement,
    statusEl: HTMLElement,
    hudEl: HTMLElement
  ) {
    this.statusEl = statusEl;
    this.hudEl = hudEl;

    this.leftRenderer = new ArenaRenderer(leftCanvas);
    this.rightRenderer = new ArenaRenderer(rightCanvas);

    this.worker = new Worker(new URL('./SimCoreWorker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerOutboundMessage>) => this.handleWorkerMessage(e);
    this.worker.onerror = (e: ErrorEvent) => {
      this.statusEl.textContent = `Worker error: ${e.message}`;
      console.error('[Mvp1App] Worker error:', e);
    };

    this.input = new InputController({
      onControlsChange: (controls) => {
        this.postToWorker({ type: 'controls', input: controls });
      },
      onResetKickoff: () => {
        this.postToWorker({ type: 'resetKickoff' });
      },
      onExportTelemetry: () => {
        this.postToWorker({ type: 'requestTelemetry' });
      },
    });

    window.addEventListener('resize', this.handleResize);
    const aspect = this.leftRenderer.resize();
    this.rightRenderer.resize();
    this.postToWorker({ type: 'init', aspect });

    window.__RC_MVP1__ = {
      getStats: () => this.getDiagnostics(),
      resetKickoff: () => this.postToWorker({ type: 'resetKickoff' }),
      toggleBallCam: () => this.input.toggleBallCam(),
      requestTelemetry: () => this.postToWorker({ type: 'requestTelemetry' }),
    };
  }

  private postToWorker(msg: WorkerInboundMessage): void {
    this.worker.postMessage(msg);
  }

  private readonly handleResize = (): void => {
    const aspect = this.leftRenderer.resize();
    this.rightRenderer.resize();
    this.postToWorker({ type: 'setAspect', aspect });
  };

  private handleWorkerMessage(event: MessageEvent<WorkerOutboundMessage>): void {
    const msg = event.data;
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        this.statusEl.textContent = '120Hz WASM Core Active';
        this.input.attach();
        this.lastRafMs = performance.now();
        this.rafId = requestAnimationFrame(this.renderLoop);
        break;
      }
      case 'frame': {
        const rightCopy = msg.buffer.slice(0);
        this.leftSource.pushFrameBuffer(msg.buffer);

        this.frameCounter += 1;
        // Right canvas: simulate 60Hz (every 2nd frame) + 5..25ms random jitter.
        if (this.frameCounter % 2 === 0) {
          const jitterMs = 5 + Math.random() * 20;
          this.lastJitterMs = jitterMs;
          const timer = setTimeout(() => {
            this.jitterTimers.delete(timer);
            this.rightSource.pushFrameBuffer(rightCopy);
          }, jitterMs);
          this.jitterTimers.add(timer);
        }
        break;
      }
      case 'telemetry': {
        this.lastTelemetry = decodeTelemetryBuffer(msg.buffer);
        this.downloadTelemetryJson(this.lastTelemetry);
        break;
      }
      case 'error': {
        this.statusEl.textContent = `SimCore Error: ${msg.message}`;
        console.error('[Mvp1App] SimCore error:', msg.message);
        break;
      }
    }
  }

  private downloadTelemetryJson(samples: TelemetrySampleData[]): void {
    const payload = JSON.stringify(
      {
        schema: 'rc-mvp1-telemetry-v1',
        sampleCount: samples.length,
        samples,
      },
      null,
      2
    );
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rc-mvp1-telemetry-${this.leftFrame.tick}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private readonly renderLoop = (nowMs: number): void => {
    const dtSec = Math.min(0.05, Math.max(0.0001, (nowMs - this.lastRafMs) / 1000));
    this.lastRafMs = nowMs;

    const leftSample = this.leftSource.sample(nowMs, this.leftFrame);
    if (leftSample.valid) {
      this.leftRenderer.render(this.leftFrame, dtSec, leftSample.teleported);
      this.leftRenderCount += 1;
      this.lastLeftDepth = leftSample.bufferDepthTicks;
    }

    const rightSample = this.rightSource.sample(nowMs, this.rightFrame);
    if (rightSample.valid) {
      this.rightRenderer.render(this.rightFrame, dtSec, rightSample.teleported);
      this.rightRenderCount += 1;
      this.lastRightDepth = rightSample.bufferDepthTicks;
    }

    if (nowMs - this.lastHudUpdateMs >= 66) {
      this.lastHudUpdateMs = nowMs;
      this.updateHud();
    }

    this.rafId = requestAnimationFrame(this.renderLoop);
  };

  private getDiagnostics(): Mvp1Diagnostics {
    const f = this.leftFrame;
    const speedUu = Math.hypot(f.carVel[0], f.carVel[1], f.carVel[2]);
    return {
      ready: this.ready,
      tick: f.tick,
      teleportSeq: f.teleportSeq,
      ballCam: (f.flags & FRAME_FLAG_BALL_CAM) !== 0,
      boost: Math.round(f.carBoost),
      speedUu: Math.round(speedUu),
      camFov: Number(f.camFov.toFixed(1)),
      leftDepthTicks: Number(this.lastLeftDepth.toFixed(2)),
      rightDepthTicks: Number(this.lastRightDepth.toFixed(2)),
      lastJitterMs: Number(this.lastJitterMs.toFixed(1)),
      leftRenderCount: this.leftRenderCount,
      rightRenderCount: this.rightRenderCount,
      lastTelemetry: this.lastTelemetry,
    };
  }

  private updateHud(): void {
    const d = this.getDiagnostics();
    const f = this.leftFrame;
    const grounded = (f.flags & FRAME_FLAG_GROUNDED) !== 0 ? 'GND' : 'AIR';
    const boosting = (f.flags & FRAME_FLAG_BOOSTING) !== 0 ? 'BOOST' : '-';
    const supersonic = (f.flags & FRAME_FLAG_SUPERSONIC) !== 0 ? 'SUPER' : '-';
    const jumped = (f.flags & FRAME_FLAG_HAS_JUMPED) !== 0 ? 'JUMP' : '-';
    const flipped = (f.flags & FRAME_FLAG_HAS_FLIPPED) !== 0 ? 'FLIP' : '-';

    this.hudEl.textContent = [
      `Tick: ${d.tick} | TeleportSeq: ${d.teleportSeq} | Cam: ${d.ballCam ? 'BallCam' : 'CarCam'}`,
      `Boost: ${d.boost} | Speed: ${d.speedUu} uu/s | State: ${grounded} / ${boosting} / ${supersonic} / ${jumped} / ${flipped}`,
      `FOV: ${d.camFov} deg | L-Buf: ${d.leftDepthTicks}t | R-Buf: ${d.rightDepthTicks}t | Jitter: ${d.lastJitterMs}ms`,
    ].join('\n');
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    for (const timer of this.jitterTimers) {
      clearTimeout(timer);
    }
    this.jitterTimers.clear();
    window.removeEventListener('resize', this.handleResize);
    this.input.detach();
    this.worker.terminate();
    this.leftRenderer.dispose();
    this.rightRenderer.dispose();
  }
}

export function bootstrapMvp1(): void {
  const leftCanvas = document.getElementById('canvas-left') as HTMLCanvasElement | null;
  const rightCanvas = document.getElementById('canvas-right') as HTMLCanvasElement | null;
  const statusEl = document.getElementById('mvp1-status');
  const hudEl = document.getElementById('mvp1-hud');

  if (!leftCanvas || !rightCanvas || !statusEl || !hudEl) {
    throw new Error('MVP-1 DOM elements missing');
  }

  const app = new Mvp1App(leftCanvas, rightCanvas, statusEl, hudEl);

  document.getElementById('btn-reset')?.addEventListener('click', () => {
    window.__RC_MVP1__?.resetKickoff();
  });
  document.getElementById('btn-ballcam')?.addEventListener('click', () => {
    window.__RC_MVP1__?.toggleBallCam();
  });
  document.getElementById('btn-telemetry')?.addEventListener('click', () => {
    window.__RC_MVP1__?.requestTelemetry();
  });

  window.addEventListener('beforeunload', () => app.dispose());
}

if (document.getElementById('canvas-left')) {
  bootstrapMvp1();
}
