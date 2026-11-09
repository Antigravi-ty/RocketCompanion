/**
 * RLRCIntervenePrerollInjector.ts
 * 4-second (480 frames @ 120Hz) pre-roll history and incident injection into ReplayRingBuffer
 * for RLRC intervention takeover.
 */

import {
  SIM_OFFSETS,
  GAME_STATE_BUFFER_FLOATS,
  INCIDENT_EVENT_TYPES,
} from '../../../physics/RocketSimConstants.ts';
import type {
  ReplayAcknowledgedControlEntry,
  ReplayRecordedIncident,
} from '../../ReplayRingBuffer.ts';
import {
  RLRC_FIXED_DT,
  RLRC_PREROLL_HISTORY_FRAMES,
  type RLRCBookmarkRecord,
  type RLRCFrame120Hz,
} from '../RLRCReplayTypes.ts';
import {
  buildFrameAcknowledgedControls,
  packRLRCFrameToGameStateBuffer,
  type RLRCPovFrameOverride,
} from './RLRCInterveneFrameStateBuilder.ts';

export interface RLRCPrerollRingBufferPort {
  clear?: () => void;
  recordFrame?: (
    tick: number,
    stateSnapshot: Float32Array,
    options?: {
      acknowledgedControls?: ReadonlyArray<
        ReplayAcknowledgedControlEntry | null | undefined
      > | null;
    }
  ) => { snapshot?: Float32Array | null } | null;
  appendIncident?: (tick: number, incident: ReplayRecordedIncident) => boolean | void;
}

export interface RLRCGoalAndTouchTrackerPort {
  goalIncidentTick?: number;
  goalResetTicks?: number;
  frozenGoalBallState?: unknown;
  prevBallVelX?: number;
  prevBallVelY?: number;
  prevBallVelZ?: number;
  lastKickoffStartTick?: number;
  lastTouchTick?: number;
}

export interface RLRCPrerollRingBufferInjectParams {
  readonly frames120Hz: readonly RLRCFrame120Hz[];
  readonly bookmarks?: readonly RLRCBookmarkRecord[];
  readonly targetFrame120Hz: number;
  readonly maxPrerollFrames?: number;
  readonly povOverride?: RLRCPovFrameOverride;
  readonly ringBuffer: RLRCPrerollRingBufferPort | null | undefined;
  readonly goalAndTouch?: RLRCGoalAndTouchTrackerPort | null;
}

export interface RLRCPrerollInjectionResult {
  readonly startFrame120Hz: number;
  readonly targetFrame120Hz: number;
  readonly recordedFrameCount: number;
  readonly baseTick: number;
  readonly finalPrerollTick: number;
  readonly nextLiveTick: number;
  readonly latestTouchTick: number;
}

export function findKickoffClampStartFrame120Hz(
  frames120Hz: readonly RLRCFrame120Hz[],
  bookmarks: readonly RLRCBookmarkRecord[] | undefined,
  targetFrame120Hz: number
): number {
  const maxIdx = Math.max(0, frames120Hz.length - 1);
  const clampedTarget = Math.max(0, Math.min(maxIdx, Math.round(targetFrame120Hz)));
  let floorFrame = 0;

  if (Array.isArray(bookmarks)) {
    for (let i = 0; i < bookmarks.length; i++) {
      const bm = bookmarks[i];
      if (!bm || bm.frameIndex120Hz > clampedTarget) continue;
      if ((bm.kind === 'kickoff' || bm.kind === 'goal') && bm.frameIndex120Hz > floorFrame) {
        floorFrame = bm.frameIndex120Hz;
      }
    }
  }

  const searchMin = Math.max(floorFrame, clampedTarget - RLRC_PREROLL_HISTORY_FRAMES);
  for (let f = clampedTarget; f > searchMin; f--) {
    const cur = frames120Hz[f];
    const prev = frames120Hz[f - 1];
    if (!cur || !prev) continue;
    const dx = cur.ball.rigidBody.position.x - prev.ball.rigidBody.position.x;
    const dy = cur.ball.rigidBody.position.y - prev.ball.rigidBody.position.y;
    if (dx * dx + dy * dy > 1600 * 1600) return f;
  }
  return floorFrame;
}

export function detectBallTouchIncidentBetweenFrames(
  prevFrame: RLRCFrame120Hz | null | undefined,
  currFrame: RLRCFrame120Hz,
  tick: number
): ReplayRecordedIncident | null {
  if (!prevFrame) return null;
  const v0 = prevFrame.ball.rigidBody.linearVelocity;
  const v1 = currFrame.ball.rigidBody.linearVelocity;
  const impulse = Math.hypot(v1.x - v0.x, v1.y - v0.y, v1.z - v0.z + 650 * RLRC_FIXED_DT);
  if (impulse < 180) return null;

  const bPos = currFrame.ball.rigidBody.position;
  let bestSlot = -1;
  let bestDistSq = 285 * 285;
  for (let slot = 0; slot < currFrame.cars.length; slot++) {
    const car = currFrame.cars[slot];
    if (!car || !car.entityActive) continue;
    const cPos = car.rigidBody.position;
    const dSq = (cPos.x - bPos.x) ** 2 + (cPos.y - bPos.y) ** 2 + (cPos.z - bPos.z) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestSlot = slot;
    }
  }
  if (bestSlot < 0) return null;
  return {
    type: INCIDENT_EVENT_TYPES.CAR_BALL_HIT,
    tick,
    carIndex: bestSlot,
    posX: bPos.x,
    posY: bPos.y,
    posZ: bPos.z,
  };
}

export function injectPrerollHistoryIntoRingBuffer(
  params: RLRCPrerollRingBufferInjectParams
): RLRCPrerollInjectionResult {
  const {
    frames120Hz,
    bookmarks,
    targetFrame120Hz,
    maxPrerollFrames = RLRC_PREROLL_HISTORY_FRAMES,
    povOverride,
    ringBuffer,
    goalAndTouch,
  } = params;

  const maxIdx = Math.max(0, frames120Hz.length - 1);
  const clampedTarget = Math.max(0, Math.min(maxIdx, Math.round(targetFrame120Hz)));
  const kickoffFloor = findKickoffClampStartFrame120Hz(frames120Hz, bookmarks, clampedTarget);
  const startFrame120Hz = Math.max(kickoffFloor, clampedTarget - Math.max(0, maxPrerollFrames));
  const baseTick = 1;
  let latestTouchTick = baseTick;
  let recordedFrameCount = 0;

  ringBuffer?.clear?.();
  const scratchSnapshot = new Float32Array(GAME_STATE_BUFFER_FLOATS);

  for (let f = startFrame120Hz; f <= clampedTarget; f++) {
    const frame = frames120Hz[f];
    if (!frame) continue;
    const tick = baseTick + recordedFrameCount++;
    packRLRCFrameToGameStateBuffer(frame, tick, scratchSnapshot, povOverride);
    const slot = ringBuffer?.recordFrame?.(tick, scratchSnapshot, {
      acknowledgedControls: buildFrameAcknowledgedControls(frame),
    });
    if (slot?.snapshot) slot.snapshot[SIM_OFFSETS.TICK] = tick;

    const touchIncident = detectBallTouchIncidentBetweenFrames(
      f > startFrame120Hz ? frames120Hz[f - 1] : null,
      frame,
      tick
    );
    if (touchIncident) {
      ringBuffer?.appendIncident?.(tick, touchIncident);
      latestTouchTick = tick;
    }
  }

  const finalPrerollTick = Math.max(baseTick, baseTick + recordedFrameCount - 1);
  const targetFrame = frames120Hz[clampedTarget];
  if (goalAndTouch && targetFrame) {
    const bVel = targetFrame.ball.rigidBody.linearVelocity;
    Object.assign(goalAndTouch, {
      goalIncidentTick: -1,
      goalResetTicks: 0,
      frozenGoalBallState: null,
      prevBallVelX: bVel.x,
      prevBallVelY: bVel.y,
      prevBallVelZ: bVel.z,
      lastKickoffStartTick: baseTick,
      lastTouchTick: latestTouchTick,
    });
  }

  return {
    startFrame120Hz,
    targetFrame120Hz: clampedTarget,
    recordedFrameCount,
    baseTick,
    finalPrerollTick,
    nextLiveTick: finalPrerollTick + 1,
    latestTouchTick,
  };
}
