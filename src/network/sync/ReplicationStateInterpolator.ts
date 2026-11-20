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
import { BOOST_PAD_DISCRETE_FIELD_OFFSETS } from '../../replay/boostPadSnapshotInterpolationPipeline.ts';
import { interpolateReplaySnapshots } from '../../replay/ReplayFrameInterpolator.ts';
import { SIM_OFFSETS } from '../../physics/RocketSimConstants.ts';
import { REPLICATION_MODES, type ReplicationMode } from '../protocol/ReplicationBusProtocol.ts';
import {
  SPECTATE_MAX_DELAY_TICKS,
  SPECTATE_MAX_LOOKAHEAD_FRAMES,
  SPECTATE_MIN_DELAY_TICKS,
  SPECTATE_MIN_LOOKAHEAD_FRAMES,
  SPECTATE_STALL_TIMEOUT_MS,
  SPECTATE_TICK_MS,
  fillSpectateLookaheadWindow,
  findSpectateBracketFrames,
  isSpectateTeleportJump,
  upsertSpectateLookaheadFrame,
  type BufferedSpectateFrame,
  type SpectateCursorState,
} from './spectateLookaheadPipeline.ts';

export type { RLRCOrthonormalBasis, RLRCRigidBodySample, SpectateCursorState };

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
    return interpolateRigidBodyHermiteSlerp(s0.body, s1.body, alpha, spanMs / 1000, 'hermite-clamped', this.maxSpeedUu);
  }
}

export const SPECTATE_BOOST_PAD_DISCRETE_OFFSETS = Object.freeze({
  baseOffset: BOOST_PAD_DISCRETE_FIELD_OFFSETS.baseOffset,
  padCount: BOOST_PAD_DISCRETE_FIELD_OFFSETS.padCount,
  stride: BOOST_PAD_DISCRETE_FIELD_OFFSETS.stride,
  isActiveOffset: BOOST_PAD_DISCRETE_FIELD_OFFSETS.isActiveOffset,
  cooldownOffset: BOOST_PAD_DISCRETE_FIELD_OFFSETS.cooldownOffset,
  cooldownJumpThresholdSec: BOOST_PAD_DISCRETE_FIELD_OFFSETS.cooldownJumpThresholdSec,
});

export interface SpectateInterpolationBufferOptions {
  lookaheadWindowFrames?: number;
  stallTimeoutMs?: number;
}

export interface SpectateInterpolationSample {
  snapshot: Float32Array;
  renderTick: number;
  frameCursor: number;
  isDuplicateFrame: boolean;
  interpDelayTicks: number;
  jitterMs: number;
  alpha: number;
  wasInterpolated: boolean;
  cursorState: SpectateCursorState;
  isLookahead: boolean;
  lookaheadFramesAvailable: number;
}

export interface SpectateInterpolationStats {
  bufferedFrames: number;
  latestHostTick: number;
  renderTick: number;
  interpDelayTicks: number;
  jitterMs: number;
  interpolatedSamples: number;
  snappedSamples: number;
  duplicateSamples: number;
  cursorState: SpectateCursorState;
  lookaheadWindowFrames: number;
  lookaheadFramesAvailable: number;
  lookaheadSamples: number;
  stallCount: number;
}

const B = SIM_OFFSETS.BALL;
const C = SIM_OFFSETS.CARS;
const isSamePose = (a: Float32Array, b: Float32Array): boolean =>
  Math.abs(a[B] - b[B]) <= 1e-3 &&
  Math.abs(a[B + 1] - b[B + 1]) <= 1e-3 &&
  Math.abs(a[B + 2] - b[B + 2]) <= 1e-3 &&
  ((b[SIM_OFFSETS.NUM_CARS] || 0) < 0.5 ||
    (Math.abs(a[C] - b[C]) <= 1e-3 &&
      Math.abs(a[C + 1] - b[C + 1]) <= 1e-3 &&
      Math.abs(a[C + 2] - b[C + 2]) <= 1e-3));

function isTrueTeleportJump(a: Float32Array, b: Float32Array, tickDelta: number): boolean {
  if (!isSpectateTeleportJump(a, b)) return false;
  if (tickDelta <= 12) return true;
  const maxDist = Math.max(900, tickDelta * 65);
  const dx = b[B] - a[B];
  const dy = b[B + 1] - a[B + 1];
  const dz = b[B + 2] - a[B + 2];
  return dx * dx + dy * dy + dz * dz > maxDist * maxDist;
}

export class SpectateInterpolationBuffer {
  private readonly frames: BufferedSpectateFrame[] = [];
  private readonly lookaheadFrames: BufferedSpectateFrame[] = [];
  private readonly maxFrames: number;
  private readonly lookaheadWindowFrames: number;
  private readonly stallTimeoutMs: number;
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
  private ticksPerFrameEstimate = 2;
  private cursorState: SpectateCursorState = 'empty';
  private hasReachedInitialLookahead = false;
  private hasExternalLookahead = false;
  private interpolatedSamples = 0;
  private snappedSamples = 0;
  private duplicateSamples = 0;
  private lookaheadSamples = 0;
  private stallCount = 0;
  private frameRevision = 0;
  private hasLastSampledCursor = false;
  private lastSampledFrameCursor = -1;
  private lastSampledRevision = -1;

  constructor(maxFrames = 360, options: SpectateInterpolationBufferOptions = {}) {
    this.maxFrames = Math.max(8, maxFrames);
    const req = Math.round(options.lookaheadWindowFrames ?? SPECTATE_MIN_LOOKAHEAD_FRAMES);
    this.lookaheadWindowFrames = Math.max(SPECTATE_MIN_LOOKAHEAD_FRAMES, Math.min(SPECTATE_MAX_LOOKAHEAD_FRAMES, req));
    this.stallTimeoutMs = Math.max(120, options.stallTimeoutMs ?? SPECTATE_STALL_TIMEOUT_MS);
  }

  reset(): void {
    this.frames.length = 0;
    this.lookaheadFrames.length = 0;
    this.latestHostTick = 0;
    this.renderTick = 0;
    this.hasInitializedRenderTick = false;
    this.lastSampleNowMs = 0;
    this.lastPushedTick = -1;
    this.lastPushedArrivalMs = 0;
    this.lastTickAdvanceMs = 0;
    this.jitterMs = 0;
    this.interpDelayTicks = SPECTATE_MIN_DELAY_TICKS;
    this.ticksPerFrameEstimate = 2;
    this.cursorState = 'empty';
    this.hasReachedInitialLookahead = false;
    this.hasExternalLookahead = false;
    this.hasLastSampledCursor = false;
    this.lastSampledFrameCursor = -1;
    this.lastSampledRevision = -1;
  }

  getCursorState(): SpectateCursorState { return this.cursorState; }
  getLookaheadWindowSize(): number { return this.lookaheadWindowFrames; }
  getLookaheadWindow(): readonly BufferedSpectateFrame[] { return this.lookaheadFrames; }
  hasLookaheadWindow(): boolean { return this.lookaheadFrames.length >= this.lookaheadWindowFrames; }

  getStats(): SpectateInterpolationStats {
    return {
      bufferedFrames: this.frames.length, latestHostTick: this.latestHostTick,
      renderTick: this.renderTick, interpDelayTicks: this.interpDelayTicks,
      jitterMs: Math.round(this.jitterMs * 10) / 10,
      interpolatedSamples: this.interpolatedSamples, snappedSamples: this.snappedSamples,
      duplicateSamples: this.duplicateSamples, cursorState: this.cursorState,
      lookaheadWindowFrames: this.lookaheadWindowFrames,
      lookaheadFramesAvailable: this.lookaheadFrames.length,
      lookaheadSamples: this.lookaheadSamples, stallCount: this.stallCount,
    };
  }

  pushLookaheadFrame(snapshot: Float32Array, tick: number, nowMs = performance.now()): void {
    if (upsertSpectateLookaheadFrame(this.lookaheadFrames, snapshot, tick, this.latestHostTick, nowMs)) {
      this.hasExternalLookahead = true;
      this.frameRevision++;
    }
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

    const frames = this.frames;
    if (frames.length > 0) {
      const last = frames[frames.length - 1];
      const lastNumCars = Math.round(last.snapshot[SIM_OFFSETS.NUM_CARS] || 0);
      if (numCars === lastNumCars && tick === last.tick && isSamePose(last.snapshot, snapshot)) {
        return;
      }
      if (
        numCars !== lastNumCars ||
        tick < last.tick - 12 ||
        isTrueTeleportJump(last.snapshot, snapshot, Math.max(0, tick - last.tick))
      ) {
        this.reset();
      }
    }

    if (this.lastPushedArrivalMs > 0 && tick > this.lastPushedTick) {
      const tickDelta = tick - this.lastPushedTick;
      if (tickDelta >= 1 && tickDelta <= 8) {
        this.ticksPerFrameEstimate = tickDelta;
      }
      const expectedDeltaMs = tickDelta * SPECTATE_TICK_MS;
      const actualDeltaMs = nowMs - this.lastPushedArrivalMs;
      if (expectedDeltaMs > 0 && expectedDeltaMs < 500 && actualDeltaMs > 0 && actualDeltaMs < 500) {
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
    const len = frames.length;
    if (len === 0 || tick > frames[len - 1].tick) {
      frames.push({ tick, arrivalMs: nowMs, snapshot: copy });
    } else if (tick === frames[len - 1].tick) {
      frames[len - 1] = { tick, arrivalMs: nowMs, snapshot: copy };
    } else {
      let inserted = false;
      for (let i = len - 1; i >= 0; i--) {
        if (frames[i].tick === tick) {
          frames[i] = { tick, arrivalMs: nowMs, snapshot: copy };
          inserted = true;
          break;
        }
        if (frames[i].tick < tick) {
          frames.splice(i + 1, 0, { tick, arrivalMs: nowMs, snapshot: copy });
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        frames.unshift({ tick, arrivalMs: nowMs, snapshot: copy });
      }
    }

    if (frames.length > this.maxFrames) {
      frames.splice(0, frames.length - this.maxFrames);
    }

    this.frameRevision++;
    this.latestHostTick = frames[frames.length - 1].tick;
    this.lookaheadFrames.length = 0;
    this.hasExternalLookahead = false;
    if (frames.length >= this.lookaheadWindowFrames) {
      this.hasReachedInitialLookahead = true;
    }
    this.cursorState = frames.length < 2 ? 'buffering' : 'tracking';
  }

  private setCursorState(nextState: SpectateCursorState): void {
    if (nextState === 'stalled' && this.cursorState !== 'stalled') this.stallCount++;
    this.cursorState = nextState;
  }

  private buildSample(
    snapshot: Float32Array,
    renderTick: number,
    frameCursor: number,
    alpha: number,
    wasInterpolated: boolean,
    isLookahead: boolean
  ): SpectateInterpolationSample {
    const isDuplicateFrame =
      this.hasLastSampledCursor &&
      Math.abs(frameCursor - this.lastSampledFrameCursor) < 1e-6 &&
      (wasInterpolated || this.frameRevision === this.lastSampledRevision);
    this.hasLastSampledCursor = true;
    this.lastSampledFrameCursor = frameCursor;
    this.lastSampledRevision = this.frameRevision;
    if (isDuplicateFrame) this.duplicateSamples++;
    if (isLookahead) this.lookaheadSamples++;
    return {
      snapshot, renderTick, frameCursor, isDuplicateFrame,
      interpDelayTicks: this.interpDelayTicks, jitterMs: this.jitterMs,
      alpha, wasInterpolated, cursorState: this.cursorState,
      isLookahead, lookaheadFramesAvailable: this.lookaheadFrames.length,
    };
  }

  sample(nowMs = performance.now()): SpectateInterpolationSample | null {
    const frames = this.frames;
    const la = this.lookaheadFrames;
    const len = frames.length;
    if (len === 0) {
      this.setCursorState('empty');
      return null;
    }

    if (len === 1) {
      const f = frames[0];
      this.renderTick = f.tick;
      this.lastSampleNowMs = nowMs;
      this.hasInitializedRenderTick = true;
      this.setCursorState('buffering');
      this.snappedSamples++;
      return this.buildSample(f.snapshot, f.tick, f.tick, 1, false, false);
    }

    const oldestTick = frames[0].tick;
    const newestTick = frames[len - 1].tick;
    const sinceAdvanceMs = nowMs - this.lastTickAdvanceMs;
    const isHostAdvancing = sinceAdvanceMs <= 120;
    const isWithinStallWindow = sinceAdvanceMs <= this.stallTimeoutMs;

    if (isWithinStallWindow || this.hasExternalLookahead) {
      fillSpectateLookaheadWindow(frames, la, this.lookaheadWindowFrames, this.ticksPerFrameEstimate, nowMs);
    }

    const lookaheadMaxTick = la.length > 0 ? la[la.length - 1].tick : newestTick;
    const maxRenderTick =
      isWithinStallWindow || this.hasExternalLookahead
        ? lookaheadMaxTick
        : Math.max(newestTick, Math.min(lookaheadMaxTick, this.renderTick));
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
    if (Math.abs(drift) > 600) {
      this.renderTick = targetTick;
    } else if (Math.abs(drift) > 24) {
      this.renderTick += Math.sign(drift) * Math.min(Math.abs(drift), 6);
    } else if (this.renderTick <= newestTick && Math.abs(drift) > 0.25) {
      this.renderTick += drift * 0.1;
    }
    this.renderTick = Math.max(oldestTick, Math.min(maxRenderTick, this.renderTick));

    const isLookahead = this.renderTick > newestTick + 1e-4;
    if (!isWithinStallWindow && this.renderTick >= maxRenderTick - 1e-4) {
      this.setCursorState('stalled');
    } else if (isLookahead) {
      this.setCursorState('lookahead');
    } else if (len < this.lookaheadWindowFrames && !this.hasReachedInitialLookahead) {
      this.setCursorState('buffering');
    } else {
      this.setCursorState('tracking');
    }

    if (this.renderTick <= oldestTick) {
      this.snappedSamples++;
      return this.buildSample(frames[0].snapshot, oldestTick, oldestTick, 0, false, false);
    }
    if (this.renderTick >= maxRenderTick) {
      const tail = isLookahead && la.length > 0 ? la[la.length - 1] : frames[len - 1];
      this.snappedSamples++;
      return this.buildSample(tail.snapshot, tail.tick, tail.tick, 1, false, isLookahead);
    }

    const bracket = findSpectateBracketFrames(frames, la, this.renderTick);
    if (!bracket) {
      this.snappedSamples++;
      return this.buildSample(frames[len - 1].snapshot, newestTick, newestTick, 1, false, false);
    }

    const { s0, s1 } = bracket;
    const span = s1.tick - s0.tick;
    if (span <= 0 || isTrueTeleportJump(s0.snapshot, s1.snapshot, span)) {
      this.snappedSamples++;
      return this.buildSample(s1.snapshot, s1.tick, s1.tick, 1, false, isLookahead);
    }

    const alpha = Math.max(0, Math.min(1, (this.renderTick - s0.tick) / span));
    const interpolated = interpolateReplaySnapshots(s0.snapshot, s1.snapshot, alpha, this.scratchOut);
    if (!interpolated) {
      this.snappedSamples++;
      return this.buildSample(s1.snapshot, s1.tick, s1.tick, 1, false, isLookahead);
    }

    this.scratchOut = interpolated;
    this.interpolatedSamples++;
    return this.buildSample(interpolated, this.renderTick, this.renderTick, alpha, true, isLookahead);
  }
}
