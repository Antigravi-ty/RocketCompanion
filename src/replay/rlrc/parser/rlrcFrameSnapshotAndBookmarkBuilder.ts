/**
 * rlrcFrameSnapshotAndBookmarkBuilder.ts
 * Pure pipeline functions for constructing 30Hz RLRC source network frames,
 * car state snapshots, and demolish bookmark records from tracked slot states.
 */

import {
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_TICK_RATE,
  type RLRCBookmarkRecord,
  type RLRCCarFrameState120Hz,
  type RLRCRigidBodySample,
  type RLRCSourceNetworkFrame,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
import {
  asRecord,
  DEFAULT_ACTIVE_FLAGS,
  DEFAULT_CAR_RB,
  extractActiveActorId,
  NEUTRAL_CONTROLS,
  RLRC_DEFAULT_SPAWN_BOOST,
  RLRC_FLIP_EXPIRATION_SECONDS,
  RLRC_SUPERSONIC_SPEED_UU_S,
} from './rlrcRigidBodyAttributePrimitives.ts';

export interface PlayerSlotTrackingState {
  carId: number;
  entityActive: boolean;
  spawnFrameIndex: number;
  rbUpdated: boolean;
  rigidBody: RLRCRigidBodySample;
  boostAmount: number;
  throttle: number;
  steer: number;
  handbrake: boolean;
  boostActive: boolean;
  jumpActive: boolean;
  doubleJumpActive: boolean;
  dodgeActive: boolean;
  lastJumpTimeSeconds: number;
  flippedInAir: boolean;
}

export function createInitialPlayerSlotTrackingStates(): PlayerSlotTrackingState[] {
  return Array.from({ length: RLRC_MAX_PLAYER_SLOTS }, (): PlayerSlotTrackingState => ({
    carId: -1,
    entityActive: false,
    spawnFrameIndex: -2,
    rbUpdated: false,
    rigidBody: DEFAULT_CAR_RB,
    boostAmount: RLRC_DEFAULT_SPAWN_BOOST,
    throttle: 0,
    steer: 0,
    handbrake: false,
    boostActive: false,
    jumpActive: false,
    doubleJumpActive: false,
    dodgeActive: false,
    lastJumpTimeSeconds: -1e9,
    flippedInAir: false,
  }));
}

export function deactivatePlayerSlotState(
  slotState: PlayerSlotTrackingState,
  clearCarId = false
): void {
  if (clearCarId) slotState.carId = -1;
  slotState.entityActive = false;
  slotState.rbUpdated = false;
  slotState.boostActive = false;
  slotState.jumpActive = false;
  slotState.doubleJumpActive = false;
  slotState.dodgeActive = false;
  slotState.handbrake = false;
  slotState.throttle = 0;
  slotState.steer = 0;
}

export function applyCarRigidBodySampleToSlot(params: {
  readonly slotState: PlayerSlotTrackingState;
  readonly slotIdx: number;
  readonly actorId: number;
  readonly frameIdx: number;
  readonly timeSeconds: number;
  readonly rbSample: RLRCRigidBodySample;
  readonly updatedRb: RLRCRigidBodySample;
  readonly networkFrames: RLRCSourceNetworkFrame[];
  readonly restingSamples: RLRCRigidBodySample[];
}): void {
  const {
    slotState,
    slotIdx,
    actorId,
    frameIdx,
    timeSeconds,
    rbSample,
    updatedRb,
    networkFrames,
    restingSamples,
  } = params;
  const pos = rbSample.position;
  const vel = rbSample.linearVelocity;
  const quat = rbSample.rotation;
  const upZ = 1 - 2 * (quat.x * quat.x + quat.y * quat.y);
  if (
    frameIdx === slotState.spawnFrameIndex + 1 &&
    networkFrames[frameIdx - 1]?.cars[slotIdx]?.entityActive &&
    Math.hypot(vel.x, vel.y, vel.z) < 50
  ) {
    (networkFrames[frameIdx - 1].cars as RLRCCarFrameState120Hz[])[slotIdx] = {
      ...networkFrames[frameIdx - 1].cars[slotIdx],
      rigidBody: updatedRb,
      rbUpdated: true,
    };
  }
  slotState.carId = actorId;
  slotState.entityActive = true;
  slotState.rbUpdated = true;
  slotState.spawnFrameIndex = -2;
  slotState.rigidBody = updatedRb;
  if (pos.z < 21.5 && Math.abs(vel.z) < 25 && upZ >= 0.7) {
    slotState.flippedInAir = false;
    slotState.lastJumpTimeSeconds = timeSeconds;
    if (
      Math.abs(pos.x) < 2500 &&
      Math.abs(pos.y) < 3500 &&
      pos.z > 14.5 &&
      pos.z < 20.5 &&
      Math.abs(vel.z) < 5 &&
      upZ > 0.98
    ) {
      restingSamples.push(rbSample);
    }
  }
}

export function buildDemolishBookmarkRecord(params: {
  readonly attrRecord: Record<string, unknown> | null;
  readonly actorId: number;
  readonly frameIdx: number;
  readonly timeSeconds: number;
  readonly startTimeSeconds: number;
  readonly isKeyframe: boolean;
  readonly lastDemolishSlot: number;
  readonly lastDemolishTime: number;
  readonly carPriById: ReadonlyMap<number, number>;
  readonly lastPriByCarId: ReadonlyMap<number, number>;
  readonly slotByPriId: ReadonlyMap<number, number>;
  readonly playerNameByPriId: ReadonlyMap<number, string>;
  readonly playerTeamByPriId: ReadonlyMap<number, RLRCTeamIndex>;
  readonly resolveSlotForCar: (carId: number) => number;
}): {
  readonly victimSlot: number;
  readonly bookmark: RLRCBookmarkRecord | null;
} {
  const {
    attrRecord,
    actorId,
    frameIdx,
    timeSeconds,
    startTimeSeconds,
    isKeyframe,
    lastDemolishSlot,
    lastDemolishTime,
    carPriById,
    lastPriByCarId,
    slotByPriId,
    playerNameByPriId,
    playerTeamByPriId,
    resolveSlotForCar,
  } = params;

  const demolishData = asRecord(attrRecord?.DemolishExtended ?? attrRecord?.Demolish) ?? attrRecord;
  const victimCar = demolishData ? extractActiveActorId(demolishData.victim) : actorId;
  const targetCarId = victimCar >= 0 ? victimCar : actorId;
  const victimPriId = carPriById.get(targetCarId) ?? lastPriByCarId.get(targetCarId) ?? -1;
  const directCarSlot = resolveSlotForCar(targetCarId);
  const victimSlot = directCarSlot >= 0 ? directCarSlot : (slotByPriId.get(victimPriId) ?? -1);

  if (
    isKeyframe ||
    (victimSlot === lastDemolishSlot && Math.abs(timeSeconds - lastDemolishTime) <= 0.5)
  ) {
    return { victimSlot, bookmark: null };
  }

  const attackerPriId = demolishData
    ? extractActiveActorId(demolishData.attacker_pri ?? demolishData.attacker)
    : -1;
  const attackerName = playerNameByPriId.get(attackerPriId) ?? 'Player';
  const victimName = playerNameByPriId.get(victimPriId) ?? `Slot ${Math.max(0, victimSlot)}`;

  return {
    victimSlot,
    bookmark: {
      kind: 'demolish',
      frameIndex120Hz: Math.max(0, Math.round((timeSeconds - startTimeSeconds) * RLRC_TICK_RATE)),
      sourceFrame30Hz: frameIdx,
      timeSeconds,
      label: `Demolish: ${attackerName} -> ${victimName}`,
      slotIndex: victimSlot,
      team: playerTeamByPriId.get(victimPriId) ?? -1,
    },
  };
}

export function buildSourceNetworkFrameSnapshot(params: {
  readonly frameIdx: number;
  readonly timeSeconds: number;
  readonly deltaSeconds: number;
  readonly secondsRemaining: number;
  readonly isOvertime: boolean;
  readonly roundCountdownNumber: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly ballActive: boolean;
  readonly ballRbUpdated: boolean;
  readonly ballActorId: number;
  readonly ballRigidBody: RLRCRigidBodySample;
  readonly slots: readonly PlayerSlotTrackingState[];
}): RLRCSourceNetworkFrame {
  const {
    frameIdx,
    timeSeconds,
    deltaSeconds,
    secondsRemaining,
    isOvertime,
    roundCountdownNumber,
    blueScore,
    orangeScore,
    ballActive,
    ballRbUpdated,
    ballActorId,
    ballRigidBody,
    slots,
  } = params;

  let carRbUpdatedMask = 0;
  const cars = slots.map((slotState, slotIndex): RLRCCarFrameState120Hz => {
    const rbUpdated = slotState.entityActive && slotState.rbUpdated;
    const rigidBody = slotState.entityActive
      ? { ...slotState.rigidBody, rbUpdated }
      : DEFAULT_CAR_RB;
    const quat = rigidBody.rotation;
    const vel = rigidBody.linearVelocity;
    if (rbUpdated) carRbUpdatedMask |= 1 << slotIndex;
    const isOnGround =
      slotState.entityActive &&
      rigidBody.position.z < 21.5 &&
      Math.abs(vel.z) < 25 &&
      1 - 2 * (quat.x * quat.x + quat.y * quat.y) >= 0.7;
    const elapsedSinceJump = isOnGround
      ? 0
      : Math.max(
          0,
          timeSeconds -
            (slotState.lastJumpTimeSeconds > -1e8 ? slotState.lastJumpTimeSeconds : timeSeconds)
        );
    return {
      slotIndex,
      entityActive: slotState.entityActive,
      rigidBody,
      rbUpdated,
      actorId: slotState.entityActive ? slotState.carId : -1,
      boostAmount: slotState.entityActive ? slotState.boostAmount : 0,
      isOnGround,
      isSupersonic:
        slotState.entityActive && Math.hypot(vel.x, vel.y, vel.z) >= RLRC_SUPERSONIC_SPEED_UU_S,
      hasFlipOrJump:
        slotState.entityActive &&
        (isOnGround ||
          (!slotState.flippedInAir && elapsedSinceJump <= RLRC_FLIP_EXPIRATION_SECONDS)),
      airTimeSinceJump: isOnGround ? 0 : Math.min(RLRC_FLIP_EXPIRATION_SECONDS, elapsedSinceJump),
      activeFlags: slotState.entityActive
        ? {
            boostActive: slotState.boostActive,
            jumpActive: slotState.jumpActive,
            doubleJumpActive: slotState.doubleJumpActive,
            dodgeActive: slotState.dodgeActive,
          }
        : DEFAULT_ACTIVE_FLAGS,
      controls: slotState.entityActive
        ? {
            throttle: slotState.throttle,
            steer: slotState.steer,
            pitch: 0,
            yaw: 0,
            roll: 0,
            jump: slotState.jumpActive || slotState.doubleJumpActive || slotState.dodgeActive,
            boost: slotState.boostActive,
            handbrake: slotState.handbrake,
          }
        : NEUTRAL_CONTROLS,
    };
  });

  const ballUpdated = ballActive && ballRbUpdated;
  const ballOut = { ...ballRigidBody, rbUpdated: ballUpdated };
  const activeBallActorId = ballActive ? ballActorId : -1;

  return {
    sourceFrame30Hz: frameIdx,
    timeSeconds,
    deltaSeconds,
    secondsRemaining,
    isOvertime,
    roundCountdownNumber,
    blueScore,
    orangeScore,
    ball: {
      entityActive: ballActive,
      rigidBody: ballOut,
      rbUpdated: ballUpdated,
      activeBallActorId,
      actorId: activeBallActorId,
    },
    cars,
    ballRbUpdated: ballUpdated,
    carRbUpdatedMask,
    rbUpdatedMask: carRbUpdatedMask | (ballUpdated ? 1 << RLRC_MAX_PLAYER_SLOTS : 0),
    activeBallActorId,
  };
}
