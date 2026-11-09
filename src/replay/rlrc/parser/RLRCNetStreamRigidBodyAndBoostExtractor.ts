/**
 * RLRCNetStreamRigidBodyAndBoostExtractor.ts
 * Extracts 30Hz ball and car rigid-body trajectories, boost amounts, active component flags,
 * demolish bookmarks, goal explosion frames, and resting ground samples from RLRC network frames.
 */

import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCBallFrameState120Hz,
  type RLRCBasis3x3,
  type RLRCBookmarkRecord,
  type RLRCNetStreamExtractorInput,
  type RLRCNetStreamExtractorOutput,
  type RLRCNetStreamRawFrame,
  type RLRCRigidBodySample,
  type RLRCSourceNetworkFrame,
  type RLRCTeamIndex,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';
import {
  applyCarRigidBodySampleToSlot,
  buildDemolishBookmarkRecord,
  buildSourceNetworkFrameSnapshot,
  createInitialPlayerSlotTrackingStates,
  deactivatePlayerSlotState,
} from './rlrcFrameSnapshotAndBookmarkBuilder.ts';
import {
  asRecord,
  createSpawnBallRigidBody,
  decodeReplicatedAxisByte,
  DEFAULT_BALL_RB,
  DEFAULT_CAR_RB,
  extractActiveActorId,
  extractRigidBodySample,
  extractVec3,
  isComponentActiveByte,
  normalizeReplicatedBoostAmount,
  RLRC_DEFAULT_SPAWN_BOOST,
  toFiniteNumber,
  ZERO_VEC3,
} from './rlrcRigidBodyAttributePrimitives.ts';

export type {
  RLRCBasis3x3,
  RLRCNetStreamExtractorInput,
  RLRCNetStreamExtractorOutput,
  RLRCNetStreamRawFrame,
};

export class RLRCNetStreamRigidBodyAndBoostExtractor {
  public run(input: RLRCNetStreamExtractorInput): RLRCNetStreamExtractorOutput {
    const actorTypeById = new Map<number, string>();
    const carPriById = new Map<number, number>();
    const lastPriByCarId = new Map<number, number>();
    const actorHiddenById = new Map<number, boolean>();
    const componentVehicleById = new Map<number, number>();
    const initialLocationById = new Map<number, RLRCVec3>();
    const explodedBallIds = new Set<number>();
    const carRigidBodyById = new Map<number, RLRCRigidBodySample>();
    const carRigidBodyFrameById = new Map<number, number>();
    const playerNameByPriId = new Map<number, string>();
    const playerTeamByPriId = new Map<number, RLRCTeamIndex>();
    const slotByPriId = new Map<number, number>();
    const slotByPlayerName = new Map<string, number>();

    const slots = createInitialPlayerSlotTrackingStates();
    const restingBySlot = Array.from(
      { length: RLRC_MAX_PLAYER_SLOTS },
      (): RLRCRigidBodySample[] => []
    );

    for (const member of input.roster ?? []) {
      if (member.slotIndex >= 0 && member.slotIndex < RLRC_MAX_PLAYER_SLOTS) {
        slotByPlayerName.set(member.userName, member.slotIndex);
        if (member.priActorId >= 0) {
          slotByPriId.set(member.priActorId, member.slotIndex);
          playerNameByPriId.set(member.priActorId, member.userName);
          playerTeamByPriId.set(member.priActorId, member.team);
        }
      }
    }
    for (const [priId, slotIdx] of input.slotByPriActorId?.entries() ?? []) {
      if (slotIdx >= 0 && slotIdx < RLRC_MAX_PLAYER_SLOTS) {
        slotByPriId.set(priId, slotIdx);
      }
    }

    const resolveSlotForPri = (priId: number, nameHint?: string): number => {
      const existingSlot = slotByPriId.get(priId);
      if (existingSlot !== undefined) return existingSlot;
      const playerName = nameHint ?? playerNameByPriId.get(priId);
      if (!playerName) return -1;
      const byNameSlot = slotByPlayerName.get(playerName);
      if (byNameSlot !== undefined) {
        slotByPriId.set(priId, byNameSlot);
        return byNameSlot;
      }
      if (slotByPlayerName.size >= RLRC_MAX_PLAYER_SLOTS) return -1;
      const nextSlot = slotByPlayerName.size;
      slotByPlayerName.set(playerName, nextSlot);
      slotByPriId.set(priId, nextSlot);
      return nextSlot;
    };

    const resolveSlotForCar = (carActorId: number): number => {
      const priId = carPriById.get(carActorId);
      if (priId !== undefined && slotByPriId.has(priId)) {
        return slotByPriId.get(priId)!;
      }
      return slots.findIndex((slotState) => slotState.carId === carActorId);
    };

    const deactivateSlotByCar = (carActorId: number, clearCarId = false): void => {
      for (const slotState of slots) {
        if (slotState.carId === carActorId) {
          deactivatePlayerSlotState(slotState, clearCarId);
        }
      }
    };

    const networkFrames: RLRCSourceNetworkFrame[] = [];
    const demolishBookmarks: RLRCBookmarkRecord[] = [];
    const goalExplosionFrames: number[] = [];

    let ballActorId = -1;
    let ballActive = true;
    let ballNeedsInitialRb = false;
    let ballSpawnFrameIndex = -1;
    let ballRigidBody = DEFAULT_BALL_RB;
    let secondsRemaining = 300;
    let isOvertime = false;
    let roundCountdownNumber = 0;
    let blueScore = 0;
    let orangeScore = 0;
    let lastDemolishTime = -1e9;
    let lastDemolishSlot = -1;
    const startTimeSeconds = input.frames.length > 0 ? input.frames[0].time : 0;

    const putBallToSleep = (): void => {
      ballActive = false;
      ballNeedsInitialRb = false;
      ballRigidBody = {
        ...ballRigidBody,
        sleeping: true,
        linearVelocity: ZERO_VEC3,
        angularVelocity: ZERO_VEC3,
        rbUpdated: false,
      };
    };

    for (let frameIdx = 0; frameIdx < input.frames.length; frameIdx++) {
      const frame = input.frames[frameIdx];
      const timeSeconds = toFiniteNumber(frame.time);
      const deltaSeconds = toFiniteNumber(frame.delta, 1 / 30);
      const isKeyframe = input.keyframeIndices?.has(frameIdx) ?? false;
      let ballRbUpdated = false;
      for (const slotState of slots) {
        slotState.rbUpdated = false;
      }

      for (const deletedId of frame.deleted_actors ?? []) {
        actorTypeById.delete(deletedId);
        carPriById.delete(deletedId);
        actorHiddenById.delete(deletedId);
        componentVehicleById.delete(deletedId);
        initialLocationById.delete(deletedId);
        carRigidBodyById.delete(deletedId);
        carRigidBodyFrameById.delete(deletedId);
        explodedBallIds.delete(deletedId);
        deactivateSlotByCar(deletedId, true);
        if (deletedId === ballActorId) {
          ballActorId = -1;
          putBallToSleep();
        }
      }

      for (const newActor of frame.new_actors ?? []) {
        const objectTypeName = input.objects[newActor.object_id] ?? '';
        const actorId = newActor.actor_id;
        actorTypeById.set(actorId, objectTypeName);
        if (!isKeyframe) {
          actorHiddenById.delete(actorId);
          explodedBallIds.delete(actorId);
        }
        if (newActor.initial_trajectory?.location) {
          initialLocationById.set(actorId, extractVec3(newActor.initial_trajectory.location));
        }
        if (
          objectTypeName.includes('Archetypes.Ball.') &&
          !explodedBallIds.has(actorId) &&
          !actorHiddenById.get(actorId)
        ) {
          const shouldAdoptBall =
            !isKeyframe ||
            ballActorId < 0 ||
            !ballActive ||
            (actorId !== ballActorId &&
              !frame.new_actors?.some((entry) => entry.actor_id === ballActorId));
          if (shouldAdoptBall) {
            ballActorId = actorId;
            ballActive = true;
            ballNeedsInitialRb = true;
            ballRbUpdated = true;
            ballSpawnFrameIndex = frameIdx;
            ballRigidBody = createSpawnBallRigidBody(initialLocationById.get(actorId));
          }
        }
      }

      for (const updatedActor of frame.updated_actors ?? []) {
        const actorId = updatedActor.actor_id;
        const propName = input.objects[updatedActor.object_id] ?? '';
        const attr = updatedActor.attribute;
        const actorType = actorTypeById.get(actorId) ?? '';
        const attrRecord = asRecord(attr);
        const ownerCarId = componentVehicleById.get(actorId) ?? actorId;

        if (propName.endsWith(':PlayerName')) {
          const nameValue = attrRecord?.String;
          if (typeof nameValue === 'string' && nameValue) {
            playerNameByPriId.set(actorId, nameValue);
            resolveSlotForPri(actorId, nameValue);
          }
        } else if (propName.endsWith('PlayerReplicationInfo:Team')) {
          const teamType = actorTypeById.get(extractActiveActorId(attr)) ?? '';
          if (teamType.includes('Team0')) playerTeamByPriId.set(actorId, 0);
          else if (teamType.includes('Team1')) playerTeamByPriId.set(actorId, 1);
        } else if (propName === 'Engine.TeamInfo:Score') {
          const scoreVal = Math.max(0, Math.trunc(toFiniteNumber(attrRecord?.Int)));
          if (actorType.includes('Team0')) blueScore = scoreVal;
          else if (actorType.includes('Team1')) orangeScore = scoreVal;
        } else if (propName === 'Engine.Pawn:PlayerReplicationInfo') {
          const priId = extractActiveActorId(attr);
          if (priId < 0) {
            carPriById.delete(actorId);
            deactivateSlotByCar(actorId, true);
          } else {
            carPriById.set(actorId, priId);
            lastPriByCarId.set(actorId, priId);
            const slotIdx = resolveSlotForPri(priId);
            if (slotIdx >= 0) {
              const slotState = slots[slotIdx];
              const isNewCarBinding = slotState.carId !== actorId;
              const isHidden = Boolean(actorHiddenById.get(actorId));
              slotState.carId = actorId;
              slotState.entityActive = !isHidden;
              if (isNewCarBinding && !isHidden) {
                if (
                  carRigidBodyFrameById.get(actorId) === frameIdx &&
                  carRigidBodyById.has(actorId)
                ) {
                  slotState.rigidBody = carRigidBodyById.get(actorId)!;
                  slotState.spawnFrameIndex = -2;
                } else {
                  const initLoc = initialLocationById.get(actorId);
                  if (initLoc) {
                    slotState.rigidBody = {
                      ...DEFAULT_CAR_RB,
                      position: initLoc,
                      rbUpdated: true,
                    };
                  }
                  slotState.spawnFrameIndex = frameIdx;
                }
                slotState.rbUpdated = true;
                slotState.boostAmount = RLRC_DEFAULT_SPAWN_BOOST;
                slotState.boostActive = false;
                slotState.jumpActive = false;
                slotState.doubleJumpActive = false;
                slotState.dodgeActive = false;
                slotState.flippedInAir = false;
              }
            }
          }
        } else if (propName === 'Engine.Actor:bHidden') {
          const isHidden = Boolean(attrRecord?.Boolean);
          const slotIdx = resolveSlotForCar(actorId);
          actorHiddenById.set(actorId, isHidden);
          if (actorType.includes('Car') && slotIdx >= 0 && slots[slotIdx].carId === actorId) {
            if (isHidden) deactivatePlayerSlotState(slots[slotIdx]);
            else slots[slotIdx].entityActive = true;
          } else if (
            actorType.includes('Ball') &&
            (actorId === ballActorId || (!isHidden && ballActorId < 0))
          ) {
            ballActorId = actorId;
            if (isHidden) putBallToSleep();
            else if (!explodedBallIds.has(actorId)) ballActive = true;
          }
        } else if (propName === 'TAGame.CarComponent_TA:Vehicle') {
          const vehicleActorId = extractActiveActorId(attr);
          if (vehicleActorId >= 0) componentVehicleById.set(actorId, vehicleActorId);
        } else if (propName.endsWith(':ReplicatedRBState')) {
          const rbSample = extractRigidBodySample(attr);
          if (!rbSample) continue;
          const updatedRb: RLRCRigidBodySample = { ...rbSample, rbUpdated: true };
          if (
            actorType.includes('Ball') &&
            !actorHiddenById.get(actorId) &&
            !explodedBallIds.has(actorId) &&
            (ballActorId < 0 || actorId === ballActorId || !ballActive)
          ) {
            const ballSpeed = Math.hypot(
              rbSample.linearVelocity.x,
              rbSample.linearVelocity.y,
              rbSample.linearVelocity.z
            );
            if (
              ballNeedsInitialRb &&
              ballActorId === actorId &&
              frameIdx === ballSpawnFrameIndex + 1 &&
              networkFrames[frameIdx - 1]?.ball.entityActive &&
              ballSpeed < 10
            ) {
              (networkFrames[frameIdx - 1] as { ball: RLRCBallFrameState120Hz }).ball = {
                entityActive: true,
                rigidBody: updatedRb,
                rbUpdated: true,
                activeBallActorId: actorId,
                actorId,
              };
            }
            ballActorId = actorId;
            ballActive = true;
            ballRbUpdated = true;
            ballNeedsInitialRb = false;
            ballRigidBody = updatedRb;
          } else if (actorType.includes('Car')) {
            carRigidBodyById.set(actorId, updatedRb);
            carRigidBodyFrameById.set(actorId, frameIdx);
            const slotIdx = resolveSlotForCar(actorId);
            if (slotIdx >= 0 && !actorHiddenById.get(actorId)) {
              applyCarRigidBodySampleToSlot({
                slotState: slots[slotIdx],
                slotIdx,
                actorId,
                frameIdx,
                timeSeconds,
                rbSample,
                updatedRb,
                networkFrames,
                restingSamples: restingBySlot[slotIdx],
              });
            }
          }
        } else if (propName.includes(':ReplicatedBoost')) {
          const boostVal = normalizeReplicatedBoostAmount(attr);
          const slotIdx = resolveSlotForCar(ownerCarId);
          if (boostVal !== null && slotIdx >= 0) slots[slotIdx].boostAmount = boostVal;
        } else if (propName.endsWith(':ReplicatedThrottle')) {
          const throttleVal = decodeReplicatedAxisByte(attr);
          const slotIdx = resolveSlotForCar(actorId);
          if (throttleVal !== null && slotIdx >= 0) slots[slotIdx].throttle = throttleVal;
        } else if (propName.endsWith(':ReplicatedSteer')) {
          const steerVal = decodeReplicatedAxisByte(attr);
          const slotIdx = resolveSlotForCar(actorId);
          if (steerVal !== null && slotIdx >= 0) slots[slotIdx].steer = steerVal;
        } else if (propName.endsWith(':bReplicatedHandbrake')) {
          const slotIdx = resolveSlotForCar(actorId);
          if (slotIdx >= 0) slots[slotIdx].handbrake = Boolean(attrRecord?.Boolean);
        } else if (propName.endsWith(':ReplicatedActive')) {
          const isActive = isComponentActiveByte(attr);
          const slotIdx = resolveSlotForCar(ownerCarId);
          if (isActive !== null && slotIdx >= 0) {
            const slotState = slots[slotIdx];
            if (actorType.includes('Boost')) slotState.boostActive = isActive;
            else if (actorType.includes('DoubleJump')) {
              slotState.doubleJumpActive = isActive;
              if (isActive) slotState.flippedInAir = true;
            } else if (actorType.includes('Dodge')) {
              slotState.dodgeActive = isActive;
              if (isActive) slotState.flippedInAir = true;
            } else if (actorType.includes('Jump')) {
              slotState.jumpActive = isActive;
              if (isActive) slotState.lastJumpTimeSeconds = timeSeconds;
            }
          }
        } else if (propName.includes(':ReplicatedDemolish')) {
          const { victimSlot, bookmark } = buildDemolishBookmarkRecord({
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
          });
          if (victimSlot >= 0) deactivatePlayerSlotState(slots[victimSlot]);
          if (bookmark) {
            demolishBookmarks.push(bookmark);
            lastDemolishTime = timeSeconds;
            lastDemolishSlot = victimSlot;
          }
        } else if (propName.includes(':ReplicatedExplosionData')) {
          explodedBallIds.add(actorId);
          if (actorId === ballActorId || ballActorId < 0) putBallToSleep();
          if (!isKeyframe) goalExplosionFrames.push(frameIdx);
        } else if (propName.endsWith(':SecondsRemaining') && !isKeyframe) {
          secondsRemaining = Math.max(
            0,
            Math.trunc(toFiniteNumber(attrRecord?.Int, secondsRemaining))
          );
        } else if (propName.endsWith(':bOverTime')) {
          isOvertime = Boolean(attrRecord?.Boolean ?? isOvertime);
        } else if (propName.endsWith(':ReplicatedRoundCountDownNumber') && !isKeyframe) {
          roundCountdownNumber = Math.max(0, Math.trunc(toFiniteNumber(attrRecord?.Int)));
        }
      }

      networkFrames.push(
        buildSourceNetworkFrameSnapshot({
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
        })
      );
    }

    const restingSamplesBySlot = new Map<number, readonly RLRCRigidBodySample[]>();
    for (let i = 0; i < RLRC_MAX_PLAYER_SLOTS; i++) {
      if (restingBySlot[i].length > 0) {
        restingSamplesBySlot.set(i, restingBySlot[i]);
      }
    }

    return {
      networkFrames,
      demolishBookmarks,
      goalExplosionFrames,
      restingSamplesBySlot,
    };
  }
}

export const extractNetStreamRigidBodyAndBoostTimeline = (
  input: RLRCNetStreamExtractorInput
): RLRCNetStreamExtractorOutput => new RLRCNetStreamRigidBodyAndBoostExtractor().run(input);
