/**
 * src/network/sync/ReplicationStateInterpolator.ts
 * Steady-state client interpolation bridge reusing RLRCHermiteSlerpMathPipeline
 * for smooth Hermite + SLERP rigid-body resampling and sparse frozen-frame hold.
 */

import {
  interpolateRigidBodyHermiteSlerp,
  vDist,
  type RLRCOrthonormalBasis,
} from '../../replay/rlrc/synthesis/RLRCHermiteSlerpMathPipeline.ts';
import type { RLRCRigidBodySample } from '../../replay/rlrc/RLRCReplayTypes.ts';
import { interpolateReplaySnapshots } from '../../replay/ReplayFrameInterpolator.ts';
import { SIM_OFFSETS } from '../../physics/RocketSimConstants.ts';
import { REPLICATION_MODES, type ReplicationMode } from '../protocol/ReplicationBusProtocol.ts';

export type { RLRCOrthonormalBasis, RLRCRigidBodySample };

export interface TimedRigidBodySnapshot {
  tick: number;
  timestampMs: number;
  body: RLRCRigidBodySample;
}

export interface ReplicationInterpolatorOptions {
  maxBufferSamples?: number;
  maxTeleportDistanceUu?: number;
  interpolationDelayMs?: number;
  maxSpeedUu?: number;
}

export class ReplicationStateInterpolator {
  private readonly entityBuffers = new Map<string, TimedRigidBodySnapshot[]>();
  private readonly maxBufferSamples: number;
  private readonly maxTeleportDistanceUu: number;
  private readonly interpolationDelayMs: number;
  private readonly maxSpeedUu: number;
  private replicationMode: ReplicationMode = REPLICATION_MODES.CONTINUOUS;

  constructor(options: ReplicationInterpolatorOptions = {}) {
    this.maxBufferSamples = options.maxBufferSamples ?? 16;
    this.maxTeleportDistanceUu = options.maxTeleportDistanceUu ?? 450;
    this.interpolationDelayMs = options.interpolationDelayMs ?? 25;
    this.maxSpeedUu = options.maxSpeedUu ?? 4500;
  }

  setReplicationMode(mode: ReplicationMode): void {
    this.replicationMode = mode;
  }

  getReplicationMode(): ReplicationMode {
    return this.replicationMode;
  }

  clearEntity(entityKey: string): void {
    this.entityBuffers.delete(entityKey);
  }

  clearAll(): void {
    this.entityBuffers.clear();
  }

  pushSample(entityKey: string, snapshot: TimedRigidBodySnapshot): void {
    let buffer = this.entityBuffers.get(entityKey);
    if (!buffer) {
      buffer = [];
      this.entityBuffers.set(entityKey, buffer);
    }
    const last = buffer[buffer.length - 1];
    if (last && snapshot.tick < last.tick) {
      buffer.length = 0;
    }
    buffer.push(snapshot);
    if (buffer.length > this.maxBufferSamples) {
      buffer.splice(0, buffer.length - this.maxBufferSamples);
    }
  }

  sampleEntity(entityKey: string, nowMs: number): RLRCRigidBodySample | null {
    const buffer = this.entityBuffers.get(entityKey);
    if (!buffer || buffer.length === 0) return null;
    if (this.replicationMode === REPLICATION_MODES.SPARSE || buffer.length === 1) {
      return buffer[buffer.length - 1].body;
    }

    const renderTimeMs = nowMs - this.interpolationDelayMs;
    if (renderTimeMs <= buffer[0].timestampMs) {
      return buffer[0].body;
    }
    const latest = buffer[buffer.length - 1];
    if (renderTimeMs >= latest.timestampMs) {
      return latest.body;
    }

    let s0 = buffer[0];
    let s1 = buffer[1];
    for (let i = 1; i < buffer.length; i++) {
      if (buffer[i].timestampMs >= renderTimeMs) {
        s0 = buffer[i - 1];
        s1 = buffer[i];
        break;
      }
    }

    const spanMs = s1.timestampMs - s0.timestampMs;
    if (spanMs <= 1e-3) {
      return s1.body;
    }
    if (vDist(s0.body.position, s1.body.position) > this.maxTeleportDistanceUu) {
      return s1.body;
    }

    const alpha = (renderTimeMs - s0.timestampMs) / spanMs;
    return interpolateRigidBodyHermiteSlerp(
      s0.body,
      s1.body,
      alpha,
      spanMs / 1000,
      'hermite-clamped',
      this.maxSpeedUu
    );
  }
}

interface BufferedSpectateFrame {
  tick: number;
  arrivalMs: number;
  snapshot: Float32Array;
}

export interface SpectateInterpolationSample {
  snapshot: Float32Array;
  renderTick: number;
  interpDelayTicks: number;
  jitterMs: number;
  alpha: number;
  wasInterpolated: boolean;
}

export interface SpectateInterpolationStats {
  bufferedFrames: number;
  latestHostTick: number;
  renderTick: number;
  interpDelayTicks: number;
  jitterMs: number;
  interpolatedSamples: number;
  snappedSamples: number;
}

const SPECTATE_TICK_MS = 1000 / 120;
const SPECTATE_MIN_DELAY_TICKS = 2;
const SPECTATE_MAX_DELAY_TICKS = 10;
const SPECTATE_TELEPORT_DIST_SQ = 900 * 900;

function isSpectateTeleportJump(a: Float32Array, b: Float32Array): boolean {
  const bdx = b[SIM_OFFSETS.BALL] - a[SIM_OFFSETS.BALL];
  const bdy = b[SIM_OFFSETS.BALL + 1] - a[SIM_OFFSETS.BALL + 1];
  const bdz = b[SIM_OFFSETS.BALL + 2] - a[SIM_OFFSETS.BALL + 2];
  if (bdx * bdx + bdy * bdy + bdz * bdz > SPECTATE_TELEPORT_DIST_SQ) return true;

  const numCars = Math.round(b[SIM_OFFSETS.NUM_CARS] || 0);
  if (numCars > 0) {
    const cdx = b[SIM_OFFSETS.CARS] - a[SIM_OFFSETS.CARS];
    const cdy = b[SIM_OFFSETS.CARS + 1] - a[SIM_OFFSETS.CARS + 1];
    const cdz = b[SIM_OFFSETS.CARS + 2] - a[SIM_OFFSETS.CARS + 2];
    if (cdx * cdx + cdy * cdy + cdz * cdz > SPECTATE_TELEPORT_DIST_SQ) return true;
  }
  return false;
}

export class SpectateInterpolationBuffer {
  private readonly frames: BufferedSpectateFrame[] = [];
  private readonly maxFrames: number;
  private scratchOut: Float32Array | null = null;
  private latestHostTick = 0;
  private renderTick = 0;
  private hasInitializedRenderTick = false;
  private lastSampleNowMs = 0;
  private lastPushedTick = -1;
  private lastPushedArrivalMs = 0;
  private lastTickAdvanceMs = 0;
  private jitterMs = 0;
  private interpDelayTicks = SPECTATE_MIN_DELAY_TICKS;
  private interpolatedSamples = 0;
  private snappedSamples = 0;

  constructor(maxFrames = 64) {
    this.maxFrames = Math.max(8, maxFrames);
  }

  reset(): void {
    this.frames.length = 0;
    this.latestHostTick = 0;
    this.renderTick = 0;
    this.hasInitializedRenderTick = false;
    this.lastSampleNowMs = 0;
    this.lastPushedTick = -1;
    this.lastPushedArrivalMs = 0;
    this.lastTickAdvanceMs = 0;
    this.jitterMs = 0;
    this.interpDelayTicks = SPECTATE_MIN_DELAY_TICKS;
  }

  getStats(): SpectateInterpolationStats {
    return {
      bufferedFrames: this.frames.length,
      latestHostTick: this.latestHostTick,
      renderTick: this.renderTick,
      interpDelayTicks: this.interpDelayTicks,
      jitterMs: Math.round(this.jitterMs * 10) / 10,
      interpolatedSamples: this.interpolatedSamples,
      snappedSamples: this.snappedSamples,
    };
  }

  pushFrame(snapshot: Float32Array, serverTick: number, nowMs = performance.now()): void {
    if (!snapshot || snapshot.length < SIM_OFFSETS.CARS) return;

    const rawTick = Number(snapshot[SIM_OFFSETS.TICK]);
    const tick =
      Number.isFinite(rawTick) && rawTick > 0
        ? Math.round(rawTick)
        : Math.max(0, Math.round(serverTick || 0));
    const numCars = Math.max(0, Math.round(snapshot[SIM_OFFSETS.NUM_CARS] || 0));
    if (snapshot.length < SIM_OFFSETS.CARS + numCars * 40) return;

    if (this.frames.length > 0) {
      const last = this.frames[this.frames.length - 1];
      const lastNumCars = Math.round(last.snapshot[SIM_OFFSETS.NUM_CARS] || 0);
      if (
        numCars !== lastNumCars ||
        tick < last.tick - 12 ||
        isSpectateTeleportJump(last.snapshot, snapshot)
      ) {
        this.reset();
      }
    }

    if (this.lastPushedArrivalMs > 0 && tick > this.lastPushedTick) {
      const expectedDeltaMs = (tick - this.lastPushedTick) * SPECTATE_TICK_MS;
      const actualDeltaMs = nowMs - this.lastPushedArrivalMs;
      if (
        expectedDeltaMs > 0 &&
        expectedDeltaMs < 500 &&
        actualDeltaMs >= 0 &&
        actualDeltaMs < 500
      ) {
        const jitterSample = Math.abs(actualDeltaMs - expectedDeltaMs);
        this.jitterMs = this.jitterMs + (jitterSample - this.jitterMs) * 0.125;
      }
    }
    if (tick > this.lastPushedTick || this.lastTickAdvanceMs === 0) {
      this.lastTickAdvanceMs = nowMs;
    }
    this.lastPushedTick = tick;
    this.lastPushedArrivalMs = nowMs;

    const rawDelay = Math.ceil((this.jitterMs * 2 + SPECTATE_TICK_MS) / SPECTATE_TICK_MS);
    this.interpDelayTicks = Math.max(
      SPECTATE_MIN_DELAY_TICKS,
      Math.min(SPECTATE_MAX_DELAY_TICKS, rawDelay)
    );

    const copy = new Float32Array(snapshot);
    const len = this.frames.length;
    if (len === 0 || tick > this.frames[len - 1].tick) {
      this.frames.push({ tick, arrivalMs: nowMs, snapshot: copy });
    } else if (tick === this.frames[len - 1].tick) {
      this.frames[len - 1] = { tick, arrivalMs: nowMs, snapshot: copy };
    } else {
      let inserted = false;
      for (let i = len - 1; i >= 0; i--) {
        if (this.frames[i].tick === tick) {
          this.frames[i] = { tick, arrivalMs: nowMs, snapshot: copy };
          inserted = true;
          break;
        }
        if (this.frames[i].tick < tick) {
          this.frames.splice(i + 1, 0, { tick, arrivalMs: nowMs, snapshot: copy });
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        this.frames.unshift({ tick, arrivalMs: nowMs, snapshot: copy });
      }
    }

    if (this.frames.length > this.maxFrames) {
      this.frames.splice(0, this.frames.length - this.maxFrames);
    }

    this.latestHostTick = this.frames[this.frames.length - 1].tick;
  }

  sample(nowMs = performance.now()): SpectateInterpolationSample | null {
    const len = this.frames.length;
    if (len === 0) return null;

    if (len === 1) {
      const f = this.frames[0];
      this.renderTick = f.tick;
      this.lastSampleNowMs = nowMs;
      this.hasInitializedRenderTick = true;
      this.snappedSamples++;
      return {
        snapshot: f.snapshot,
        renderTick: f.tick,
        interpDelayTicks: this.interpDelayTicks,
        jitterMs: this.jitterMs,
        alpha: 1,
        wasInterpolated: false,
      };
    }

    const oldestTick = this.frames[0].tick;
    const newestTick = this.frames[len - 1].tick;
    const isHostAdvancing = nowMs - this.lastTickAdvanceMs <= 120;
    const targetTick = isHostAdvancing
      ? Math.max(oldestTick, newestTick - this.interpDelayTicks)
      : newestTick;

    if (!this.hasInitializedRenderTick) {
      this.renderTick = targetTick;
      this.lastSampleNowMs = nowMs;
      this.hasInitializedRenderTick = true;
    }

    const dtMs =
      this.lastSampleNowMs > 0 ? Math.max(0, Math.min(100, nowMs - this.lastSampleNowMs)) : 0;
    this.lastSampleNowMs = nowMs;

    this.renderTick += dtMs / SPECTATE_TICK_MS;
    const drift = targetTick - this.renderTick;
    if (Math.abs(drift) > 24) {
      this.renderTick = targetTick;
    } else if (Math.abs(drift) > 0.25) {
      this.renderTick += drift * 0.1;
    }
    this.renderTick = Math.max(oldestTick, Math.min(newestTick, this.renderTick));

    if (this.renderTick <= oldestTick) {
      this.snappedSamples++;
      return {
        snapshot: this.frames[0].snapshot,
        renderTick: oldestTick,
        interpDelayTicks: this.interpDelayTicks,
        jitterMs: this.jitterMs,
        alpha: 0,
        wasInterpolated: false,
      };
    }
    if (this.renderTick >= newestTick) {
      this.snappedSamples++;
      return {
        snapshot: this.frames[len - 1].snapshot,
        renderTick: newestTick,
        interpDelayTicks: this.interpDelayTicks,
        jitterMs: this.jitterMs,
        alpha: 1,
        wasInterpolated: false,
      };
    }

    let s0 = this.frames[0];
    let s1 = this.frames[1];
    for (let i = 1; i < len; i++) {
      if (this.frames[i].tick >= this.renderTick) {
        s0 = this.frames[i - 1];
        s1 = this.frames[i];
        break;
      }
    }

    const span = s1.tick - s0.tick;
    if (span <= 0 || isSpectateTeleportJump(s0.snapshot, s1.snapshot)) {
      this.snappedSamples++;
      return {
        snapshot: s1.snapshot,
        renderTick: s1.tick,
        interpDelayTicks: this.interpDelayTicks,
        jitterMs: this.jitterMs,
        alpha: 1,
        wasInterpolated: false,
      };
    }

    const alpha = Math.max(0, Math.min(1, (this.renderTick - s0.tick) / span));
    const interpolated = interpolateReplaySnapshots(
      s0.snapshot,
      s1.snapshot,
      alpha,
      this.scratchOut
    );
    if (!interpolated) {
      this.snappedSamples++;
      return {
        snapshot: s1.snapshot,
        renderTick: s1.tick,
        interpDelayTicks: this.interpDelayTicks,
        jitterMs: this.jitterMs,
        alpha: 1,
        wasInterpolated: false,
      };
    }

    this.scratchOut = interpolated;
    this.interpolatedSamples++;
    return {
      snapshot: interpolated,
      renderTick: this.renderTick,
      interpDelayTicks: this.interpDelayTicks,
      jitterMs: this.jitterMs,
      alpha,
      wasInterpolated: true,
    };
  }
}
