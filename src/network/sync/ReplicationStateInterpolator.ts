/**
 * src/network/sync/ReplicationStateInterpolator.ts
 * Clean replication state interpolator & empty-shell spectate frame buffer.
 * Legacy lookahead extrapolation, monotonic tick assumptions, and reverse-delay
 * cursor drift have been stripped for vNext TimelineFrameBuffer integration.
 */

import {
  interpolateRigidBodyHermiteSlerp,
  vDist,
  type RLRCOrthonormalBasis,
} from '../../replay/rlrc/synthesis/RLRCHermiteSlerpMathPipeline.ts';
import type { RLRCRigidBodySample } from '../../replay/rlrc/RLRCReplayTypes.ts';
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

export interface SpectateInterpolationBufferOptions {
  maxFrames?: number;
}

export interface SpectateInterpolationSample {
  snapshot: Float32Array;
  serverTick: number;
  arrivalMs: number;
}

export interface SpectateInterpolationStats {
  bufferedFrames: number;
  latestTick: number;
}

/**
 * Clean empty-shell pass-through frame buffer for spectate/replay streams.
 * Holds the latest authoritative snapshot with no lookahead extrapolation
 * and no monotonic tick assumptions (safe for rewind, pause, and seek).
 */
export class SpectateInterpolationBuffer {
  private latestSnapshot: Float32Array | null = null;
  private latestTick = 0;
  private latestArrivalMs = 0;

  constructor(_maxFrames = 16, _options: SpectateInterpolationBufferOptions = {}) {}

  reset(): void {
    this.latestSnapshot = null;
    this.latestTick = 0;
    this.latestArrivalMs = 0;
  }

  getStats(): SpectateInterpolationStats {
    return {
      bufferedFrames: this.latestSnapshot ? 1 : 0,
      latestTick: this.latestTick,
    };
  }

  pushFrame(snapshot: Float32Array, serverTick = 0, nowMs = performance.now()): void {
    if (!snapshot || snapshot.length < SIM_OFFSETS.CARS) return;
    const rawTick = Number(snapshot[SIM_OFFSETS.TICK]);
    const tick =
      Number.isFinite(rawTick) && rawTick > 0
        ? Math.round(rawTick)
        : Math.max(0, Math.round(serverTick || 0));
    const numCars = Math.max(0, Math.round(snapshot[SIM_OFFSETS.NUM_CARS] || 0));
    if (snapshot.length < SIM_OFFSETS.CARS + numCars * 40) return;

    this.latestSnapshot = new Float32Array(snapshot);
    this.latestTick = tick;
    this.latestArrivalMs = nowMs;
  }

  sample(_nowMs = performance.now()): SpectateInterpolationSample | null {
    if (!this.latestSnapshot) return null;
    return {
      snapshot: this.latestSnapshot,
      serverTick: this.latestTick,
      arrivalMs: this.latestArrivalMs,
    };
  }
}
