/**
 * RLRCBoostPadSpatialCatalog.ts
 * Spatial catalog for the 34 standard arena boost pads (6 big + 28 small),
 * nearest-neighbor pickupActorId -> padIndex (0..33) bijective resolver,
 * and 4.0s / 10.0s cooldown state machine for 120Hz RLRC replay synthesis.
 */

import {
  BOOST_PAD_OFFSETS,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_TIMEOUT_BIG,
  BOOST_PAD_TIMEOUT_SMALL,
  NUM_BOOST_PADS,
  SIM_OFFSETS,
} from '../../../physics/RocketSimConstants.ts';
import {
  RLRC_BOOST_PAD_COUNT,
  type RLRCBoostPadPickupEvent,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export interface RLRCBoostPadSpec {
  readonly padIndex: number;
  readonly isBigPad: boolean;
  readonly cooldownSeconds: number;
  readonly boostGrantAmount: number;
  readonly position: RLRCVec3;
}

export interface RLRCBoostPadNearestMatch {
  readonly padIndex: number;
  readonly isBigPad: boolean;
  readonly distanceXY: number;
  readonly pad: RLRCBoostPadSpec;
}

export interface RLRCBoostPadPickupInput {
  readonly sourceFrame30Hz: number;
  readonly timeSeconds: number;
  readonly pickupActorId: number;
  readonly pickedUpByte: number | boolean;
  readonly instigatorSlotIndex?: number;
  readonly instigatorPosition?: { readonly x: number; readonly y: number; readonly z?: number } | null;
}

export const RLRC_BIG_BOOST_PAD_COUNT = 6;
export const RLRC_SMALL_BOOST_PAD_COUNT = 28;
export const RLRC_BIG_BOOST_COOLDOWN_SECONDS: number = BOOST_PAD_TIMEOUT_BIG;
export const RLRC_SMALL_BOOST_COOLDOWN_SECONDS: number = BOOST_PAD_TIMEOUT_SMALL;
export const RLRC_MAX_PICKUP_MATCH_DISTANCE_UU = 450.0;

const RAW_STANDARD_BOOST_PADS_34: ReadonlyArray<
  readonly [number, number, number, boolean]
> = Object.freeze([
  // 0..5: 6 Big Boost Pads (100 boost, 10.0s cooldown)
  [-3584, 0, 73, true],
  [3584, 0, 73, true],
  [-3072, 4096, 73, true],
  [3072, 4096, 73, true],
  [-3072, -4096, 73, true],
  [3072, -4096, 73, true],
  // 6..33: 28 Small Boost Pads (12 boost, 4.0s cooldown)
  [0, -4240, 70, false],
  [-1792, -4184, 70, false],
  [1792, -4184, 70, false],
  [-940, -3308, 70, false],
  [940, -3308, 70, false],
  [0, -2816, 70, false],
  [-3584, -2484, 70, false],
  [3584, -2484, 70, false],
  [-1788, -2300, 70, false],
  [1788, -2300, 70, false],
  [-2048, -1036, 70, false],
  [0, -1024, 70, false],
  [2048, -1036, 70, false],
  [-1024, 0, 70, false],
  [1024, 0, 70, false],
  [-2048, 1036, 70, false],
  [0, 1024, 70, false],
  [2048, 1036, 70, false],
  [-1788, 2300, 70, false],
  [1788, 2300, 70, false],
  [-3584, 2484, 70, false],
  [3584, 2484, 70, false],
  [0, 2816, 70, false],
  [-940, 3308, 70, false],
  [940, 3308, 70, false],
  [-1792, 4184, 70, false],
  [1792, 4184, 70, false],
  [0, 4240, 70, false],
]);

export const STANDARD_BOOST_PADS_34: readonly RLRCBoostPadSpec[] = Object.freeze(
  RAW_STANDARD_BOOST_PADS_34.map(([x, y, z, isBigPad], padIndex) =>
    Object.freeze({
      padIndex,
      isBigPad,
      cooldownSeconds: isBigPad ? RLRC_BIG_BOOST_COOLDOWN_SECONDS : RLRC_SMALL_BOOST_COOLDOWN_SECONDS,
      boostGrantAmount: isBigPad ? 100 : 12,
      position: Object.freeze({ x, y, z }),
    })
  )
);

export function isBigBoostPadIndex(padIndex: number): boolean {
  return padIndex >= 0 && padIndex < RLRC_BIG_BOOST_PAD_COUNT;
}

export function getBoostPadCooldownDuration(padIndex: number): number {
  return isBigBoostPadIndex(padIndex)
    ? RLRC_BIG_BOOST_COOLDOWN_SECONDS
    : RLRC_SMALL_BOOST_COOLDOWN_SECONDS;
}

export function getBoostPadSpec(padIndex: number): RLRCBoostPadSpec | null {
  if (padIndex < 0 || padIndex >= STANDARD_BOOST_PADS_34.length) {
    return null;
  }
  return STANDARD_BOOST_PADS_34[padIndex];
}

/**
 * Finds the nearest standard boost pad (0..33) to the given `(x, y)` coordinates.
 * Optionally excludes already-bound pad indices if an unbound pad lies within `RLRC_MAX_PICKUP_MATCH_DISTANCE_UU`.
 */
export function findNearestBoostPad(
  x: number,
  y: number,
  excludedPadIndices?: ReadonlySet<number> | null
): RLRCBoostPadNearestMatch {
  let bestUnboundIndex = -1;
  let bestUnboundDistSq = Number.POSITIVE_INFINITY;
  let bestOverallIndex = 0;
  let bestOverallDistSq = Number.POSITIVE_INFINITY;

  for (let i = 0; i < STANDARD_BOOST_PADS_34.length; i++) {
    const pad = STANDARD_BOOST_PADS_34[i];
    const dx = x - pad.position.x;
    const dy = y - pad.position.y;
    const distSq = dx * dx + dy * dy;

    if (distSq < bestOverallDistSq) {
      bestOverallDistSq = distSq;
      bestOverallIndex = i;
    }
    if (!excludedPadIndices || !excludedPadIndices.has(i)) {
      if (distSq < bestUnboundDistSq) {
        bestUnboundDistSq = distSq;
        bestUnboundIndex = i;
      }
    }
  }

  const maxDistSq = RLRC_MAX_PICKUP_MATCH_DISTANCE_UU * RLRC_MAX_PICKUP_MATCH_DISTANCE_UU;
  const chosenIndex =
    bestUnboundIndex >= 0 && bestUnboundDistSq <= maxDistSq
      ? bestUnboundIndex
      : bestOverallIndex;
  const chosenDistSq =
    chosenIndex === bestUnboundIndex ? bestUnboundDistSq : bestOverallDistSq;
  const chosenPad = STANDARD_BOOST_PADS_34[chosenIndex];

  return {
    padIndex: chosenIndex,
    isBigPad: chosenPad.isBigPad,
    distanceXY: Math.sqrt(chosenDistSq),
    pad: chosenPad,
  };
}

/**
 * Normalizes UE3 `NewReplicatedPickupData.picked_up` values into semantic pickup states:
 * - `255` (or `false`): `'respawned'` (available again)
 * - `1..254` (or `true`): `'picked-up'` (consumed and entering cooldown)
 */
export function classifyReplicatedPickupState(
  pickedUpByte: number | boolean
): 'picked-up' | 'respawned' | null {
  if (typeof pickedUpByte === 'boolean') {
    return pickedUpByte ? 'picked-up' : 'respawned';
  }
  if (!Number.isFinite(pickedUpByte)) {
    return null;
  }
  const normalized = pickedUpByte & 0xff;
  if (normalized === 255 || normalized === 0) {
    return 'respawned';
  }
  return 'picked-up';
}

/**
 * Stateful spatial resolver and cooldown state machine for the 34 boost pads.
 * Maintains the bijective `pickupActorId <-> padIndex (0..33)` mapping across a `.replay`
 * NetStream and tracks per-pad cooldown timers at 30Hz or 120Hz.
 */
export class RLRCBoostPadSpatialTracker {
  private readonly actorToPadMap = new Map<number, number>();
  private readonly padToActorMap = new Map<number, number>();
  private readonly boundPadIndices = new Set<number>();
  private readonly cooldowns = new Float32Array(RLRC_BOOST_PAD_COUNT);
  private readonly lastPickupTimeByPad = new Float64Array(RLRC_BOOST_PAD_COUNT).fill(
    Number.NEGATIVE_INFINITY
  );
  private readonly recordedEvents: RLRCBoostPadPickupEvent[] = [];

  public resetAllPads(
    sourceFrame30Hz = -1,
    timeSeconds = 0,
    recordKickoffResetEvent = false
  ): void {
    this.actorToPadMap.clear();
    this.padToActorMap.clear();
    this.boundPadIndices.clear();
    this.cooldowns.fill(0);
    this.lastPickupTimeByPad.fill(Number.NEGATIVE_INFINITY);

    if (recordKickoffResetEvent && sourceFrame30Hz >= 0) {
      this.recordedEvents.push({
        sourceFrame30Hz,
        timeSeconds,
        pickupActorId: -1,
        padIndex: -1,
        isBigPad: false,
        instigatorSlotIndex: -1,
        pickedUpState: 'kickoff-reset',
      });
    }
  }

  public clearRecordedEvents(): void {
    this.recordedEvents.length = 0;
  }

  public deletePickupActor(pickupActorId: number): void {
    const padIndex = this.actorToPadMap.get(pickupActorId);
    if (padIndex !== undefined) {
      this.actorToPadMap.delete(pickupActorId);
      if (this.padToActorMap.get(padIndex) === pickupActorId) {
        this.padToActorMap.delete(padIndex);
        this.boundPadIndices.delete(padIndex);
      }
    }
  }

  public getPadIndexForActor(pickupActorId: number): number {
    return this.actorToPadMap.get(pickupActorId) ?? -1;
  }

  public bindActorToNearestPad(pickupActorId: number, x: number, y: number): number {
    const existing = this.actorToPadMap.get(pickupActorId);
    if (existing !== undefined) {
      return existing;
    }

    const match = findNearestBoostPad(x, y, this.boundPadIndices);
    const padIndex = match.padIndex;
    const prevActor = this.padToActorMap.get(padIndex);
    if (prevActor !== undefined && prevActor !== pickupActorId) {
      this.actorToPadMap.delete(prevActor);
    }

    this.actorToPadMap.set(pickupActorId, padIndex);
    this.padToActorMap.set(padIndex, pickupActorId);
    this.boundPadIndices.add(padIndex);
    return padIndex;
  }

  public registerPickupEvent(input: RLRCBoostPadPickupInput): RLRCBoostPadPickupEvent | null {
    const state = classifyReplicatedPickupState(input.pickedUpByte);
    if (!state) {
      return null;
    }

    let padIndex = this.actorToPadMap.get(input.pickupActorId) ?? -1;
    if (padIndex < 0 && input.instigatorPosition) {
      padIndex = this.bindActorToNearestPad(
        input.pickupActorId,
        input.instigatorPosition.x,
        input.instigatorPosition.y
      );
    }
    if (padIndex < 0 || padIndex >= RLRC_BOOST_PAD_COUNT) {
      return null;
    }

    const padSpec = STANDARD_BOOST_PADS_34[padIndex];
    if (state === 'picked-up') {
      this.cooldowns[padIndex] = padSpec.cooldownSeconds;
      this.lastPickupTimeByPad[padIndex] = input.timeSeconds;
    } else {
      this.cooldowns[padIndex] = 0;
      this.lastPickupTimeByPad[padIndex] = Number.NEGATIVE_INFINITY;
    }

    const event: RLRCBoostPadPickupEvent = {
      sourceFrame30Hz: input.sourceFrame30Hz,
      timeSeconds: input.timeSeconds,
      pickupActorId: input.pickupActorId,
      padIndex,
      isBigPad: padSpec.isBigPad,
      instigatorSlotIndex: input.instigatorSlotIndex ?? -1,
      pickedUpState: state,
    };
    this.recordedEvents.push(event);
    return event;
  }

  public stepCooldowns(dtSeconds: number): Float32Array {
    if (dtSeconds > 0) {
      for (let i = 0; i < RLRC_BOOST_PAD_COUNT; i++) {
        const current = this.cooldowns[i];
        if (current > 0) {
          const nextVal = current - dtSeconds;
          this.cooldowns[i] = nextVal > 1e-5 ? nextVal : 0;
        }
      }
    }
    return this.cooldowns;
  }

  public getCooldownsSnapshot(out?: Float32Array): Float32Array {
    const dst = out && out.length >= RLRC_BOOST_PAD_COUNT ? out : new Float32Array(RLRC_BOOST_PAD_COUNT);
    for (let i = 0; i < RLRC_BOOST_PAD_COUNT; i++) {
      dst[i] = this.cooldowns[i];
    }
    return dst;
  }

  public getRecordedEvents(): readonly RLRCBoostPadPickupEvent[] {
    return this.recordedEvents;
  }
}

/**
 * Evaluates the exact 34 boost pad cooldowns (in seconds remaining) at any timestamp `timeSeconds`
 * from a chronological list of `RLRCBoostPadPickupEvent` records.
 */
export function evaluateBoostPadCooldownsAtTime(
  events: readonly RLRCBoostPadPickupEvent[],
  timeSeconds: number,
  out?: Float32Array
): Float32Array {
  const dst = out && out.length >= RLRC_BOOST_PAD_COUNT ? out : new Float32Array(RLRC_BOOST_PAD_COUNT);
  dst.fill(0);

  const lastPickTime = new Float64Array(RLRC_BOOST_PAD_COUNT).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.timeSeconds > timeSeconds + 1e-6) {
      break;
    }
    if (ev.pickedUpState === 'kickoff-reset') {
      lastPickTime.fill(Number.NEGATIVE_INFINITY);
      continue;
    }
    if (ev.padIndex < 0 || ev.padIndex >= RLRC_BOOST_PAD_COUNT) {
      continue;
    }
    if (ev.pickedUpState === 'picked-up') {
      lastPickTime[ev.padIndex] = ev.timeSeconds;
    } else if (ev.pickedUpState === 'respawned') {
      lastPickTime[ev.padIndex] = Number.NEGATIVE_INFINITY;
    }
  }

  for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
    const pickTime = lastPickTime[p];
    if (Number.isFinite(pickTime)) {
      const duration = getBoostPadCooldownDuration(p);
      const remaining = duration - Math.max(0, timeSeconds - pickTime);
      dst[p] = remaining > 1e-5 ? remaining : 0;
    }
  }

  return dst;
}

/**
 * Sweeps a sorted `RLRCBoostPadPickupEvent` timeline in O(N_frames + N_events) time
 * to synthesize 120Hz `Float32Array(34)` boost pad cooldown snapshots for every frame.
 */
export function buildBoostPadCooldownTimeline120Hz(
  events: readonly RLRCBoostPadPickupEvent[],
  frameTimestampsSeconds: ArrayLike<number>
): Float32Array[] {
  const frameCount = frameTimestampsSeconds.length;
  const result: Float32Array[] = new Array(frameCount);
  const lastPickTime = new Float64Array(RLRC_BOOST_PAD_COUNT).fill(Number.NEGATIVE_INFINITY);
  let eventCursor = 0;

  for (let f = 0; f < frameCount; f++) {
    const frameTime = frameTimestampsSeconds[f];
    while (eventCursor < events.length && events[eventCursor].timeSeconds <= frameTime + 1e-6) {
      const ev = events[eventCursor++];
      if (ev.pickedUpState === 'kickoff-reset') {
        lastPickTime.fill(Number.NEGATIVE_INFINITY);
      } else if (ev.padIndex >= 0 && ev.padIndex < RLRC_BOOST_PAD_COUNT) {
        if (ev.pickedUpState === 'picked-up') {
          lastPickTime[ev.padIndex] = ev.timeSeconds;
        } else if (ev.pickedUpState === 'respawned') {
          lastPickTime[ev.padIndex] = Number.NEGATIVE_INFINITY;
        }
      }
    }

    const frameCooldowns = new Float32Array(RLRC_BOOST_PAD_COUNT);
    for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
      const pickTime = lastPickTime[p];
      if (Number.isFinite(pickTime)) {
        const duration = getBoostPadCooldownDuration(p);
        const remaining = duration - Math.max(0, frameTime - pickTime);
        frameCooldowns[p] = remaining > 1e-5 ? remaining : 0;
      }
    }
    result[f] = frameCooldowns;
  }

  return result;
}

/**
 * Writes the 34 boost pad `(isActive, cooldown)` pairs into a 448-float `GameStateBuffer`
 * at `BOOST_PAD_STATES_OFFSET` (floats 342..409) and updates `SIM_OFFSETS.NUM_PADS`.
 */
export function applyBoostPadCooldownsToSimStateBuffer(
  out: Float32Array,
  cooldowns: ArrayLike<number>
): void {
  if (out.length < BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE) {
    return;
  }
  out[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;
  for (let i = 0; i < NUM_BOOST_PADS; i++) {
    const rawCooldown = i < cooldowns.length ? Number(cooldowns[i]) : 0;
    const cooldown = Number.isFinite(rawCooldown) && rawCooldown > 1e-5 ? rawCooldown : 0;
    const base = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
    out[base + BOOST_PAD_OFFSETS.IS_ACTIVE] = cooldown === 0 ? 1.0 : 0.0;
    out[base + BOOST_PAD_OFFSETS.COOLDOWN] = cooldown;
  }
}

/**
 * Extracts the 34 boost pad remaining cooldown seconds from a 448-float `GameStateBuffer`.
 */
export function extractBoostPadCooldownsFromSimStateBuffer(
  stateBuffer: ArrayLike<number>,
  out?: Float32Array
): Float32Array {
  const dst = out && out.length >= RLRC_BOOST_PAD_COUNT ? out : new Float32Array(RLRC_BOOST_PAD_COUNT);
  if (stateBuffer.length < BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE) {
    dst.fill(0);
    return dst;
  }
  for (let i = 0; i < RLRC_BOOST_PAD_COUNT; i++) {
    const base = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
    const isActive = stateBuffer[base + BOOST_PAD_OFFSETS.IS_ACTIVE] > 0.5;
    const rawCooldown = stateBuffer[base + BOOST_PAD_OFFSETS.COOLDOWN];
    dst[i] = isActive ? 0 : Math.max(0, Number(rawCooldown) || 0);
  }
  return dst;
}
