/**
 * RLRCNetStreamRigidBodyAndBoostExtractor.ts
 * Extracts 30Hz ball and car rigid-body trajectories, boost amounts, active component flags,
 * demolish bookmarks, goal explosion frames, and resting ground samples from RLRC network frames.
 */

import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCBasis3x3,
  type RLRCBookmarkRecord,
  type RLRCNetStreamExtractorInput,
  type RLRCNetStreamExtractorOutput,
  type RLRCNetStreamRawFrame,
  type RLRCRigidBodySample,
  type RLRCSourceNetworkFrame,
} from '../RLRCReplayTypes.ts';
import { RLRCBallLifecycleExtractor } from './RLRCBallLifecycleExtractor.ts';
import { RLRC_BOOST_CONSUMPTION_RATE_PER_SEC } from './RLRCBoostSegmentSolverPipeline.ts';
import { RLRCBoostTimelineReconstructor } from './RLRCBoostTimelineReconstructor.ts';
import {
  applyCarRigidBodySampleToSlot,
  bindCarPawnToSlotState,
  buildDemolishBookmarkRecord,
  buildSourceNetworkFrameSnapshot,
  createInitialPlayerSlotTrackingStates,
  deactivatePlayerSlotState,
} from './rlrcFrameSnapshotAndBookmarkBuilder.ts';
import {
  asRecord,
  decodeReplicatedAxisByte,
  extractActiveActorId,
  extractRigidBodySample,
  extractVec3,
  isComponentActiveByte,
  RLRCNetStreamPriSlotTable,
  toFiniteNumber,
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
    const carRbById = new Map<number, RLRCRigidBodySample>();
    const carRbFrameById = new Map<number, number>();
    const priTable = new RLRCNetStreamPriSlotTable(input);
    const ball = new RLRCBallLifecycleExtractor();
    const boostRec = new RLRCBoostTimelineReconstructor();
    const slots = createInitialPlayerSlotTrackingStates();
    const restingBySlot = Array.from(
      { length: RLRC_MAX_PLAYER_SLOTS },
      (): RLRCRigidBodySample[] => []
    );

    const resolveSlotForCar = (carId: number): number => priTable.resolveSlotForCar(carId, slots);
    const deactivateSlotByCar = (carId: number, clearCarId = false): void => {
      for (const s of slots) if (s.carId === carId) deactivatePlayerSlotState(s, clearCarId);
    };

    const networkFrames: RLRCSourceNetworkFrame[] = [];
    const demolishBookmarks: RLRCBookmarkRecord[] = [];
    let secondsRemaining = 300;
    let isOvertime = false;
    let roundCountdownNumber = 0;
    let blueScore = 0;
    let orangeScore = 0;
    let lastDemolishTime = -1e9;
    let lastDemolishSlot = -1;
    const startTimeSeconds = input.frames.length > 0 ? input.frames[0].time : 0;

    for (let frameIdx = 0; frameIdx < input.frames.length; frameIdx++) {
      const frame = input.frames[frameIdx];
      const timeSeconds = toFiniteNumber(frame.time);
      const deltaSeconds = Math.max(0, Math.min(0.25, toFiniteNumber(frame.delta, 1 / 30)));
      const isKeyframe = input.keyframeIndices?.has(frameIdx) ?? false;

      ball.beginFrame();
      boostRec.beginFrame();
      for (const s of slots) {
        s.rbUpdated = false;
        if (s.entityActive && s.boostActive) {
          s.boostAmount = Math.max(
            0,
            s.boostAmount - RLRC_BOOST_CONSUMPTION_RATE_PER_SEC * deltaSeconds
          );
        }
      }

      for (const deletedId of frame.deleted_actors ?? []) {
        actorTypeById.delete(deletedId);
        priTable.carPriById.delete(deletedId);
        carRbById.delete(deletedId);
        carRbFrameById.delete(deletedId);
        boostRec.deleteActor(deletedId);
        deactivateSlotByCar(deletedId, true);
        ball.onActorDeleted(deletedId);
      }

      for (const newActor of frame.new_actors ?? []) {
        const objType = input.objects[newActor.object_id] ?? '';
        const actorId = newActor.actor_id;
        actorTypeById.set(actorId, objType);
        const initLoc = newActor.initial_trajectory?.location
          ? extractVec3(newActor.initial_trajectory.location)
          : undefined;
        ball.onActorSpawned(actorId, objType, initLoc, frameIdx, isKeyframe, frame.new_actors);
      }

      for (const updatedActor of frame.updated_actors ?? []) {
        const actorId = updatedActor.actor_id;
        const prop = input.objects[updatedActor.object_id] ?? '';
        const attr = updatedActor.attribute;
        const actorType = actorTypeById.get(actorId) ?? '';
        const attrRec = asRecord(attr);
        const ownerCarId = boostRec.resolveOwnerCarId(actorId);

        if (priTable.applyPriProperty(prop, actorId, attr, attrRec, actorTypeById)) {
          continue;
        }
        if (prop === 'Engine.TeamInfo:Score') {
          const scoreVal = Math.max(0, Math.trunc(toFiniteNumber(attrRec?.Int)));
          if (actorType.includes('Team0')) blueScore = scoreVal;
          else if (actorType.includes('Team1')) orangeScore = scoreVal;
        } else if (prop === 'Engine.Pawn:PlayerReplicationInfo') {
          const priId = extractActiveActorId(attr);
          if (priId < 0) {
            priTable.carPriById.delete(actorId);
            deactivateSlotByCar(actorId, true);
          } else {
            const slotIdx = priTable.bindCarPriAndResolveSlot(actorId, priId);
            if (
              slotIdx >= 0 &&
              bindCarPawnToSlotState({
                slotState: slots[slotIdx],
                actorId,
                frameIdx,
                isHidden: ball.isActorHidden(actorId),
                sameFrameRb:
                  carRbFrameById.get(actorId) === frameIdx ? carRbById.get(actorId) : undefined,
                initLoc: ball.getInitialLocation(actorId),
              })
            ) {
              boostRec.onSlotCarSpawn(
                slotIdx,
                actorId,
                frameIdx,
                timeSeconds,
                slots[slotIdx],
                actorTypeById
              );
            }
          }
        } else if (prop === 'Engine.Actor:bHidden') {
          const isHidden = ball.onActorHiddenChanged(actorId, actorType, attr);
          const slotIdx = resolveSlotForCar(actorId);
          if (actorType.includes('Car') && slotIdx >= 0 && slots[slotIdx].carId === actorId) {
            if (isHidden) deactivatePlayerSlotState(slots[slotIdx]);
            else slots[slotIdx].entityActive = true;
          }
        } else if (prop === 'TAGame.CarComponent_TA:Vehicle') {
          boostRec.bindComponentCar(
            actorId,
            extractActiveActorId(attr),
            frameIdx,
            timeSeconds,
            actorType,
            resolveSlotForCar,
            slots
          );
        } else if (prop.endsWith(':ReplicatedRBState')) {
          const rbSample = extractRigidBodySample(attr);
          if (!rbSample) continue;
          const updatedRb: RLRCRigidBodySample = { ...rbSample, rbUpdated: true };
          if (actorType.includes('Ball')) {
            ball.onBallRigidBodySample(actorId, rbSample, frameIdx, networkFrames);
          } else if (actorType.includes('Car')) {
            carRbById.set(actorId, updatedRb);
            carRbFrameById.set(actorId, frameIdx);
            const slotIdx = resolveSlotForCar(actorId);
            if (slotIdx >= 0 && !ball.isActorHidden(actorId)) {
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
        } else if (prop.includes(':ReplicatedBoost')) {
          const slotIdx = resolveSlotForCar(ownerCarId);
          const boostVal = boostRec.recordBoostAttribute(actorId, attr, frameIdx, slotIdx);
          if (boostVal !== null && slotIdx >= 0) slots[slotIdx].boostAmount = boostVal;
        } else if (prop.includes('ReplicatedPickupData')) {
          boostRec.recordPickupForTrackedSlots(actorId, attr, resolveSlotForCar, slots, carRbById);
        } else if (prop.endsWith(':ReplicatedThrottle')) {
          const v = decodeReplicatedAxisByte(attr);
          const slotIdx = resolveSlotForCar(actorId);
          if (v !== null && slotIdx >= 0) slots[slotIdx].throttle = v;
        } else if (prop.endsWith(':ReplicatedSteer')) {
          const v = decodeReplicatedAxisByte(attr);
          const slotIdx = resolveSlotForCar(actorId);
          if (v !== null && slotIdx >= 0) slots[slotIdx].steer = v;
        } else if (prop.endsWith(':bReplicatedHandbrake')) {
          const slotIdx = resolveSlotForCar(actorId);
          if (slotIdx >= 0) slots[slotIdx].handbrake = Boolean(attrRec?.Boolean);
        } else if (prop.endsWith(':ReplicatedActive')) {
          const isActive = isComponentActiveByte(attr);
          if (isActive !== null) {
            const slotIdx = resolveSlotForCar(ownerCarId);
            boostRec.recordActiveAttribute(
              actorId,
              actorType,
              isActive,
              frameIdx,
              timeSeconds,
              slotIdx,
              slotIdx >= 0 ? slots[slotIdx] : undefined
            );
          }
        } else if (prop.includes(':ReplicatedDemolish')) {
          const { victimSlot, bookmark } = buildDemolishBookmarkRecord({
            attrRecord: attrRec,
            actorId,
            frameIdx,
            timeSeconds,
            startTimeSeconds,
            isKeyframe,
            lastDemolishSlot,
            lastDemolishTime,
            carPriById: priTable.carPriById,
            lastPriByCarId: priTable.lastPriByCarId,
            slotByPriId: priTable.slotByPriId,
            playerNameByPriId: priTable.playerNameByPriId,
            playerTeamByPriId: priTable.playerTeamByPriId,
            resolveSlotForCar,
          });
          if (victimSlot >= 0) deactivatePlayerSlotState(slots[victimSlot]);
          if (bookmark) {
            demolishBookmarks.push(bookmark);
            lastDemolishTime = timeSeconds;
            lastDemolishSlot = victimSlot;
          }
        } else if (prop.includes(':ReplicatedExplosionData')) {
          ball.onBallExplosion(actorId, attr, frameIdx, isKeyframe);
        } else if (prop.endsWith(':SecondsRemaining') && !isKeyframe) {
          secondsRemaining = Math.max(
            0,
            Math.trunc(toFiniteNumber(attrRec?.Int, secondsRemaining))
          );
        } else if (prop.endsWith(':bOverTime')) {
          isOvertime = Boolean(attrRec?.Boolean ?? isOvertime);
        } else if (prop.endsWith(':ReplicatedRoundCountDownNumber') && !isKeyframe) {
          roundCountdownNumber = Math.max(0, Math.trunc(toFiniteNumber(attrRec?.Int)));
        }
      }

      boostRec.commitFrame(timeSeconds, deltaSeconds, roundCountdownNumber, slots);
      const ballSnap = ball.buildFrameBallState();
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
          ballActive: ballSnap.ball.entityActive,
          ballRbUpdated: ballSnap.ballRbUpdated,
          ballActorId: ballSnap.activeBallActorId,
          ballRigidBody: ballSnap.ball.rigidBody,
          slots,
        })
      );
    }

    boostRec.applyReconstructedBoostToTimeline(networkFrames);

    const restingSamplesBySlot = new Map<number, readonly RLRCRigidBodySample[]>();
    for (let i = 0; i < RLRC_MAX_PLAYER_SLOTS; i++) {
      if (restingBySlot[i].length > 0) restingSamplesBySlot.set(i, restingBySlot[i]);
    }

    return {
      networkFrames,
      demolishBookmarks,
      goalExplosionFrames: ball.getGoalExplosionFrames(),
      restingSamplesBySlot,
    };
  }
}

export const extractNetStreamRigidBodyAndBoostTimeline = (
  input: RLRCNetStreamExtractorInput
): RLRCNetStreamExtractorOutput => new RLRCNetStreamRigidBodyAndBoostExtractor().run(input);
