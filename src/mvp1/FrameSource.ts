import * as THREE from 'three';
import {
  copyRenderFrame,
  createEmptyRenderFrame,
  decodeRenderFrame,
  type RenderFrameData,
} from './protocol.ts';

const SIM_HZ = 120;
const TICK_MS = 1000 / SIM_HZ;
const BUFFER_TICKS = 2.0;
const MAX_QUEUE_LEN = 32;

export interface FrameSampleResult {
  valid: boolean;
  teleported: boolean;
  playheadTick: number;
  latestTick: number;
  bufferDepthTicks: number;
}

export interface FrameSource {
  pushFrameBuffer(buffer: ArrayBuffer): void;
  sample(nowMs: number, outFrame: RenderFrameData): FrameSampleResult;
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(
  out: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
  t: number
): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

const tmpQuatA = new THREE.Quaternion();
const tmpQuatB = new THREE.Quaternion();

function slerpQuat(
  out: [number, number, number, number],
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number
): void {
  tmpQuatA.set(a[0], a[1], a[2], a[3]);
  tmpQuatB.set(b[0], b[1], b[2], b[3]);
  tmpQuatA.slerp(tmpQuatB, t);
  out[0] = tmpQuatA.x;
  out[1] = tmpQuatA.y;
  out[2] = tmpQuatA.z;
  out[3] = tmpQuatA.w;
}

export class BufferedFrameSource implements FrameSource {
  private readonly queue: RenderFrameData[] = [];
  private readonly decodeScratch = createEmptyRenderFrame();
  private playheadTick = 0;
  private lastSampleMs = 0;
  private lastTeleportSeq = -1;
  private initialized = false;

  pushFrameBuffer(buffer: ArrayBuffer): void {
    if (!decodeRenderFrame(buffer, this.decodeScratch)) {
      return;
    }
    const frame = createEmptyRenderFrame();
    copyRenderFrame(frame, this.decodeScratch);

    if (this.queue.length > 0) {
      const tail = this.queue[this.queue.length - 1];
      if (frame.teleportSeq !== tail.teleportSeq) {
        this.queue.length = 0;
        this.queue.push(frame);
        this.playheadTick = frame.tick;
        return;
      }
      if (frame.tick <= tail.tick) {
        return;
      }
    }

    this.queue.push(frame);
    while (this.queue.length > MAX_QUEUE_LEN) {
      this.queue.shift();
    }
  }

  sample(nowMs: number, outFrame: RenderFrameData): FrameSampleResult {
    if (this.queue.length === 0) {
      return {
        valid: false,
        teleported: false,
        playheadTick: 0,
        latestTick: 0,
        bufferDepthTicks: 0,
      };
    }

    const latest = this.queue[this.queue.length - 1];
    const oldest = this.queue[0];

    let teleported = false;
    if (this.lastTeleportSeq !== -1 && latest.teleportSeq !== this.lastTeleportSeq) {
      teleported = true;
    }
    this.lastTeleportSeq = latest.teleportSeq;

    if (!this.initialized || teleported) {
      this.initialized = true;
      this.lastSampleMs = nowMs;
      this.playheadTick = Math.max(oldest.tick, latest.tick - BUFFER_TICKS);
      copyRenderFrame(outFrame, latest);
      return {
        valid: true,
        teleported,
        playheadTick: this.playheadTick,
        latestTick: latest.tick,
        bufferDepthTicks: latest.tick - this.playheadTick,
      };
    }

    const dtMs = Math.min(50, Math.max(0, nowMs - this.lastSampleMs));
    this.lastSampleMs = nowMs;

    const targetTick = Math.max(oldest.tick, latest.tick - BUFFER_TICKS);
    this.playheadTick += dtMs / TICK_MS;
    const drift = targetTick - this.playheadTick;
    if (Math.abs(drift) > 12) {
      this.playheadTick = targetTick;
    } else {
      this.playheadTick += drift * 0.08;
    }

    if (this.playheadTick < oldest.tick) {
      this.playheadTick = oldest.tick;
    } else if (this.playheadTick > latest.tick) {
      this.playheadTick = latest.tick;
    }

    let prev = oldest;
    let next = latest;
    for (let i = 0; i < this.queue.length - 1; i++) {
      const a = this.queue[i];
      const b = this.queue[i + 1];
      if (this.playheadTick >= a.tick && this.playheadTick <= b.tick) {
        prev = a;
        next = b;
        break;
      }
    }

    if (prev === next || prev.teleportSeq !== next.teleportSeq) {
      copyRenderFrame(outFrame, next);
    } else {
      const span = Math.max(1e-4, next.tick - prev.tick);
      const alpha = Math.min(1, Math.max(0, (this.playheadTick - prev.tick) / span));

      outFrame.tick = Math.round(lerpNum(prev.tick, next.tick, alpha));
      outFrame.teleportSeq = next.teleportSeq;
      outFrame.flags = alpha >= 0.5 ? next.flags : prev.flags;

      lerpVec3(outFrame.ballPos, prev.ballPos, next.ballPos, alpha);
      slerpQuat(outFrame.ballQuat, prev.ballQuat, next.ballQuat, alpha);
      lerpVec3(outFrame.ballVel, prev.ballVel, next.ballVel, alpha);

      lerpVec3(outFrame.carPos, prev.carPos, next.carPos, alpha);
      slerpQuat(outFrame.carQuat, prev.carQuat, next.carQuat, alpha);
      lerpVec3(outFrame.carVel, prev.carVel, next.carVel, alpha);
      outFrame.carBoost = lerpNum(prev.carBoost, next.carBoost, alpha);

      lerpVec3(outFrame.camPos, prev.camPos, next.camPos, alpha);
      slerpQuat(outFrame.camQuat, prev.camQuat, next.camQuat, alpha);
      outFrame.camFov = lerpNum(prev.camFov, next.camFov, alpha);

      outFrame.boostPadsLo = next.boostPadsLo;
      outFrame.boostPadsHi = next.boostPadsHi;
    }

    return {
      valid: true,
      teleported,
      playheadTick: this.playheadTick,
      latestTick: latest.tick,
      bufferDepthTicks: latest.tick - this.playheadTick,
    };
  }
}
