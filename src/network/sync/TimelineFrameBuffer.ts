/**
 * src/network/sync/TimelineFrameBuffer.ts
 * vNext Wave 1 (W1-02): Arrival-timeline frame buffer for spectate & replay streams.
 *
 * Design principles:
 * - Zero lookahead extrapolation and zero monotonic tick assumptions.
 * - 60Hz+ streams (inter-arrival <= passThroughThresholdMs) pass through directly.
 * - 15/30Hz streams interpolate between bracketing frames using client arrivalMs,
 *   making forward, slow-motion, pause, and rewind 100% symmetric.
 * - Monotonic txSeq guards against out-of-order/duplicate unreliable packets.
 */

import {
  CAR_STATE_STRIDE,
  GAME_STATE_BUFFER_FLOATS,
  SIM_OFFSETS,
} from '../../physics/RocketSimConstants.ts';
import type {
  DecodedVNextWorldFrame,
  VNextCameraPose,
  VNextPlaybackState,
} from '../protocol/VNextWorldFrameCodec.ts';
import { interpolateSnapshotPair } from './TimelineFrameMath.ts';

export type TimelinePlaybackState = VNextPlaybackState;

export type TimelineBufferMode = 'auto' | 'passthrough' | 'interpolate';

export type TimelineSampleMode = 'passthrough' | 'interpolated' | 'hold';

export type TimelineCameraPose = VNextCameraPose;

export interface TimelineFrameHeader {
  txSeq: number;
  tick: number;
  playbackState: TimelinePlaybackState;
  phase: string;
  clockSeconds: number;
  focusedCarIndex: number;
  discontinuity?: boolean;
  cameraPose?: TimelineCameraPose | null;
}

export interface TimelineFramePushMeta {
  txSeq?: number;
  tick?: number;
  playbackState?: TimelinePlaybackState;
  focusedCarIndex?: number;
  discontinuity?: boolean;
  arrivalMs?: number;
}

export interface TimelineFrameBufferOptions {
  capacity?: number;
  passThroughThresholdMs?: number;
  minInterpolationDelayMs?: number;
  maxInterpolationDelayMs?: number;
  jitterMarginMs?: number;
  maxTeleportDistanceUu?: number;
  mode?: TimelineBufferMode;
}

export interface TimelineSampleResult {
  snapshot: Float32Array;
  txSeq: number;
  serverTick: number;
  arrivalMs: number;
  alpha: number;
  mode: TimelineSampleMode;
  playbackState: TimelinePlaybackState;
  focusedCarIndex: number;
  interpolationDelayMs: number;
}

export interface TimelineFrameBufferStats {
  bufferedFrames: number;
  latestTxSeq: number;
  latestTick: number;
  avgIntervalMs: number;
  estimatedHz: number;
  activeMode: TimelineSampleMode;
  droppedOutOfOrder: number;
  teleportSnaps: number;
}

interface BufferedFrameSlot {
  snapshot: Float32Array;
  length: number;
  txSeq: number;
  tick: number;
  arrivalMs: number;
  playbackState: TimelinePlaybackState;
  focusedCarIndex: number;
  discontinuity: boolean;
}

const DEFAULT_PASS_THROUGH_THRESHOLD_MS = 22;
const DEFAULT_MIN_INTERP_DELAY_MS = 25;
const DEFAULT_MAX_INTERP_DELAY_MS = 120;
const DEFAULT_JITTER_MARGIN_MS = 8;
const DEFAULT_MAX_TELEPORT_UU = 450;
const MAX_CADENCE_GAP_MS = 250;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export class TimelineFrameBuffer {
  private readonly capacity: number;
  private readonly slots: BufferedFrameSlot[];
  private readonly outputSnapshot: Float32Array;
  private readonly passThroughThresholdMs: number;
  private readonly minInterpolationDelayMs: number;
  private readonly maxInterpolationDelayMs: number;
  private readonly jitterMarginMs: number;
  private readonly maxTeleportDistSq: number;
  private mode: TimelineBufferMode;

  private head = 0;
  private count = 0;
  private latestTxSeq = 0;
  private latestArrivalMs = -1;
  private avgIntervalMs = 16.6667;
  private hasCadenceSample = false;
  private lastSampleMode: TimelineSampleMode = 'hold';
  private droppedOutOfOrder = 0;
  private teleportSnaps = 0;

  constructor(options: TimelineFrameBufferOptions = {}) {
    this.capacity = Math.max(4, Math.round(options.capacity ?? 32));
    this.passThroughThresholdMs =
      options.passThroughThresholdMs ?? DEFAULT_PASS_THROUGH_THRESHOLD_MS;
    this.minInterpolationDelayMs = options.minInterpolationDelayMs ?? DEFAULT_MIN_INTERP_DELAY_MS;
    this.maxInterpolationDelayMs = options.maxInterpolationDelayMs ?? DEFAULT_MAX_INTERP_DELAY_MS;
    this.jitterMarginMs = options.jitterMarginMs ?? DEFAULT_JITTER_MARGIN_MS;
    const maxTeleport = options.maxTeleportDistanceUu ?? DEFAULT_MAX_TELEPORT_UU;
    this.maxTeleportDistSq = maxTeleport * maxTeleport;
    this.mode = options.mode ?? 'auto';

    this.outputSnapshot = new Float32Array(GAME_STATE_BUFFER_FLOATS);
    this.slots = new Array<BufferedFrameSlot>(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.slots[i] = {
        snapshot: new Float32Array(GAME_STATE_BUFFER_FLOATS),
        length: GAME_STATE_BUFFER_FLOATS,
        txSeq: 0,
        tick: 0,
        arrivalMs: 0,
        playbackState: 'playing',
        focusedCarIndex: 0,
        discontinuity: false,
      };
    }
  }

  setMode(mode: TimelineBufferMode): void {
    this.mode = mode;
  }

  getMode(): TimelineBufferMode {
    return this.mode;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.latestTxSeq = 0;
    this.latestArrivalMs = -1;
    this.avgIntervalMs = 16.6667;
    this.hasCadenceSample = false;
    this.lastSampleMode = 'hold';
    this.droppedOutOfOrder = 0;
    this.teleportSnaps = 0;
  }

  pushFrame(
    snapshot: Float32Array,
    metaOrTick: number | TimelineFramePushMeta = 0,
    nowMs = performance.now()
  ): boolean {
    if (!snapshot || snapshot.length < SIM_OFFSETS.CARS) return false;
    const numCars = Math.max(0, Math.round(snapshot[SIM_OFFSETS.NUM_CARS] || 0));
    if (snapshot.length < SIM_OFFSETS.CARS + numCars * CAR_STATE_STRIDE) {
      return false;
    }

    const isMeta = typeof metaOrTick === 'object' && metaOrTick !== null;
    const txSeq = isMeta ? Math.max(0, Math.round(metaOrTick.txSeq ?? 0)) : 0;
    const hintTick = isMeta ? (metaOrTick.tick ?? 0) : metaOrTick;
    const arrivalMs = isMeta && metaOrTick.arrivalMs !== undefined ? metaOrTick.arrivalMs : nowMs;
    const playbackState: TimelinePlaybackState =
      isMeta && metaOrTick.playbackState ? metaOrTick.playbackState : 'playing';
    const focusedCarIndex =
      isMeta && metaOrTick.focusedCarIndex !== undefined ? metaOrTick.focusedCarIndex : 0;
    const discontinuity = isMeta ? Boolean(metaOrTick.discontinuity) : false;

    if (txSeq > 0 && txSeq <= this.latestTxSeq) {
      this.droppedOutOfOrder++;
      return false;
    }
    if (txSeq > 0) {
      this.latestTxSeq = txSeq;
    }

    const rawTick = Number(snapshot[SIM_OFFSETS.TICK]);
    const tick =
      Number.isFinite(rawTick) && rawTick > 0
        ? Math.round(rawTick)
        : Math.max(0, Math.round(hintTick || 0));

    if (this.latestArrivalMs >= 0) {
      const dt = arrivalMs - this.latestArrivalMs;
      if (dt > 0 && dt <= MAX_CADENCE_GAP_MS) {
        this.avgIntervalMs = this.hasCadenceSample ? this.avgIntervalMs * 0.75 + dt * 0.25 : dt;
        this.hasCadenceSample = true;
      }
    }
    this.latestArrivalMs = arrivalMs;

    const writeIdx =
      this.count < this.capacity ? (this.head + this.count) % this.capacity : this.head;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }

    const slot = this.slots[writeIdx];
    const copyLen = Math.min(snapshot.length, GAME_STATE_BUFFER_FLOATS);
    slot.snapshot.set(snapshot.subarray(0, copyLen));
    slot.length = copyLen;
    slot.txSeq = txSeq;
    slot.tick = tick;
    slot.arrivalMs = arrivalMs;
    slot.playbackState = playbackState;
    slot.focusedCarIndex = focusedCarIndex;
    slot.discontinuity = discontinuity;
    return true;
  }

  private getSlotAt(offset: number): BufferedFrameSlot {
    return this.slots[(this.head + offset) % this.capacity];
  }

  private computeInterpolationDelayMs(): number {
    return clamp(
      this.avgIntervalMs + this.jitterMarginMs,
      this.minInterpolationDelayMs,
      this.maxInterpolationDelayMs
    );
  }

  private isPassThroughActive(): boolean {
    if (this.mode === 'passthrough') return true;
    if (this.mode === 'interpolate') return false;
    return this.avgIntervalMs <= this.passThroughThresholdMs;
  }

  private buildHoldResult(
    slot: BufferedFrameSlot,
    alpha: number,
    delayMs: number
  ): TimelineSampleResult {
    this.lastSampleMode = 'hold';
    return {
      snapshot: slot.snapshot.subarray(0, slot.length),
      txSeq: slot.txSeq,
      serverTick: slot.tick,
      arrivalMs: slot.arrivalMs,
      alpha,
      mode: 'hold',
      playbackState: slot.playbackState,
      focusedCarIndex: slot.focusedCarIndex,
      interpolationDelayMs: delayMs,
    };
  }

  sample(nowMs = performance.now()): TimelineSampleResult | null {
    if (this.count === 0) return null;

    const latest = this.getSlotAt(this.count - 1);
    const delayMs = this.computeInterpolationDelayMs();

    if (this.count === 1) {
      return this.buildHoldResult(latest, 1, 0);
    }

    if (this.isPassThroughActive()) {
      this.lastSampleMode = 'passthrough';
      return {
        snapshot: latest.snapshot.subarray(0, latest.length),
        txSeq: latest.txSeq,
        serverTick: latest.tick,
        arrivalMs: latest.arrivalMs,
        alpha: 1,
        mode: 'passthrough',
        playbackState: latest.playbackState,
        focusedCarIndex: latest.focusedCarIndex,
        interpolationDelayMs: 0,
      };
    }

    const renderTimeMs = nowMs - delayMs;
    const oldest = this.getSlotAt(0);
    if (renderTimeMs <= oldest.arrivalMs) {
      return this.buildHoldResult(oldest, 0, delayMs);
    }

    if (renderTimeMs >= latest.arrivalMs) {
      return this.buildHoldResult(latest, 1, delayMs);
    }

    let slotA = oldest;
    let slotB = this.getSlotAt(1);
    for (let i = 1; i < this.count; i++) {
      const candidate = this.getSlotAt(i);
      if (candidate.arrivalMs >= renderTimeMs) {
        slotA = this.getSlotAt(i - 1);
        slotB = candidate;
        break;
      }
    }

    if (slotB.discontinuity) {
      return this.buildHoldResult(slotB, 1, delayMs);
    }

    const spanMs = slotB.arrivalMs - slotA.arrivalMs;
    if (spanMs <= 1e-3) {
      return this.buildHoldResult(slotB, 1, delayMs);
    }

    const alpha = clamp((renderTimeMs - slotA.arrivalMs) / spanMs, 0, 1);
    const snapped = interpolateSnapshotPair(
      slotA.snapshot,
      slotB.snapshot,
      alpha,
      this.outputSnapshot,
      this.maxTeleportDistSq
    );
    if (snapped) {
      this.teleportSnaps++;
    }

    this.lastSampleMode = 'interpolated';
    const outLen = Math.min(slotB.length, GAME_STATE_BUFFER_FLOATS);
    const pickB = alpha >= 0.5 ? slotB : slotA;
    return {
      snapshot: this.outputSnapshot.subarray(0, outLen),
      txSeq: pickB.txSeq,
      serverTick: Math.round(this.outputSnapshot[SIM_OFFSETS.TICK]),
      arrivalMs: renderTimeMs,
      alpha,
      mode: 'interpolated',
      playbackState: pickB.playbackState,
      focusedCarIndex: pickB.focusedCarIndex,
      interpolationDelayMs: delayMs,
    };
  }

  getStats(): TimelineFrameBufferStats {
    const latest = this.count > 0 ? this.getSlotAt(this.count - 1) : null;
    const hz = this.avgIntervalMs > 0 ? 1000 / this.avgIntervalMs : 0;
    return {
      bufferedFrames: this.count,
      latestTxSeq: this.latestTxSeq,
      latestTick: latest ? latest.tick : 0,
      avgIntervalMs: Math.round(this.avgIntervalMs * 100) / 100,
      estimatedHz: Math.round(hz * 10) / 10,
      activeMode: this.lastSampleMode,
      droppedOutOfOrder: this.droppedOutOfOrder,
      teleportSnaps: this.teleportSnaps,
    };
  }
}
