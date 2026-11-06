/**
 * PhysicsEventDispatcher.ts
 * Stateful SubController for physics event reading, goal-barrier hit classification,
 * and boost pad edge detection during WASM step execution for RocketSimPhysicsEngine.
 */

import {
  SIM_OFFSETS,
  MAX_CARS,
  CAR_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  NUM_BOOST_PADS,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  PHYSICS_EVENT_TYPES,
  INCIDENT_EVENT_TYPES,
  SURFACE_SUBTYPES,
} from './RocketSimConstants.ts';
import {
  readArenaPads,
  type ArenaBoostPadDescriptor,
} from './RocketSimSnapshotSerializer.ts';
import type { PhysicsEventReader, PhysicsEventRecord } from './PhysicsEventReader.ts';
import type { RocketSimWasmModule } from './RocketSimWasm.ts';
import type { BallStateView } from './RocketSimStateViews.ts';

export type PhysicsEventDispatchCallback = (event: PhysicsEventRecord) => void;

export interface PhysicsEventDispatcherHostPort {
  readonly module: RocketSimWasmModule | null;
  readonly eventReader: PhysicsEventReader | null;
  readonly eventBufferPtr: number;
  readonly state: Float32Array;
  readonly ballState: BallStateView;
  readonly numCars: number;
  readonly arenaPreset: number;
  isPointOnGoalBarrier(xUu: number, yUu: number, zUu: number): boolean;
  isCarSlotActive(carIndex: number): boolean;
  getCarBoostCollectable(carIndex?: number): boolean;
  pushSignalEvent(
    type: number,
    tick: number,
    x?: number,
    y?: number,
    z?: number,
    nx?: number,
    ny?: number,
    nz?: number,
    primaryId?: number,
    secondaryId?: number,
    subType?: number,
    flags?: number,
    customFloat?: number,
    customInt?: number
  ): void;
}

export class PhysicsEventDispatcher {
  private readonly engine: PhysicsEventDispatcherHostPort;
  private readonly preStepPadActive = new Uint8Array(NUM_BOOST_PADS);
  private readonly preStepPadCooldown = new Float32Array(NUM_BOOST_PADS);
  private cachedPads: ArenaBoostPadDescriptor[] | null = null;
  private cachedPadsPreset = -1;
  public ballTouchedFloorInLastStep = false;

  constructor(engine: PhysicsEventDispatcherHostPort) {
    this.engine = engine;
  }

  public resetFloorTouchLatch(): void {
    this.ballTouchedFloorInLastStep = false;
  }

  public readEvents(callback?: PhysicsEventDispatchCallback | null): number {
    const engine = this.engine;
    if (!engine.eventReader) return 0;

    if (engine.module && typeof engine.module._physics_getEventBufferPtr === 'function') {
      const heapBuffer = engine.module.HEAPU8.buffer;
      if (engine.eventReader.buffer !== heapBuffer) {
        engine.eventReader.attach(heapBuffer, engine.eventBufferPtr);
      }
    }

    const wrapCallback = (event: PhysicsEventRecord): void => {
      if (
        event.type === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT &&
        typeof engine.isPointOnGoalBarrier === 'function' &&
        engine.isPointOnGoalBarrier(event.x, event.y, event.z)
      ) {
        event.type = INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT;
        event.subType = SURFACE_SUBTYPES.GOALPOST;
        event.surfaceTag = SURFACE_SUBTYPES.GOALPOST;
        event.isGoalBarrierHit = true;
      } else {
        event.isGoalBarrierHit = false;
      }
      if (callback) callback(event);
    };

    if (engine.eventReader.strideWords === 12) {
      engine.eventReader.ballStateProvider = engine.ballState;
      return engine.eventReader.readEvents((event: PhysicsEventRecord) => {
        if (
          event.type === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT ||
          event.type === INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT
        ) {
          const threshold =
            event.surfaceTag === SURFACE_SUBTYPES.FLOOR || event.subType === 1 ? 140.0 : 160.0;
          if ((event.normalRelVel ?? 0) < threshold) return;
        }
        if (
          event.type === INCIDENT_EVENT_TYPES.BOOST_PICKUP ||
          event.type === PHYSICS_EVENT_TYPES.BOOST_PICKUP
        ) {
          const nCars = engine.numCars;
          if (
            engine.state &&
            nCars > 0 &&
            Number.isFinite(event.x) &&
            Number.isFinite(event.y) &&
            Number.isFinite(event.z)
          ) {
            let bestCarIdx = 0;
            let bestDistSq = Infinity;
            for (let i = 0; i < nCars; i++) {
              if (typeof engine.isCarSlotActive === 'function' && !engine.isCarSlotActive(i)) {
                continue;
              }
              const base = SIM_OFFSETS.CARS + i * CAR_STATE_STRIDE + CAR_STATE_OFFSETS.POS;
              const dx = engine.state[base] - event.x;
              const dy = engine.state[base + 1] - event.y;
              const dz = engine.state[base + 2] - event.z;
              const distSq = dx * dx + dy * dy + dz * dz;
              if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestCarIdx = i;
              }
            }
            event.carIndex = bestCarIdx;
          }
        }
        wrapCallback(event);
      });
    }

    return engine.eventReader.readEvents(wrapCallback);
  }

  public stepWithPadEdgeDetection(ticks: number = 1): void {
    const engine = this.engine;
    if (!engine?.module) return;

    const numSteps = Math.max(1, Math.floor(Number(ticks) || 1));
    const preActive = this.preStepPadActive;
    const preCooldown = this.preStepPadCooldown;

    for (let s = 0; s < numSteps; s++) {
      const preSt = engine.state;
      const hasPadSlice =
        preSt && preSt.length >= BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE;

      if (hasPadSlice) {
        for (let p = 0; p < NUM_BOOST_PADS; p++) {
          const base = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
          preActive[p] = preSt[base] >= 0.5 ? 1 : 0;
          preCooldown[p] = preSt[base + 1];
        }
      }

      const writeSeqBefore = engine.eventReader ? engine.eventReader.writeSeq : 0;
      engine.module._physics_step(1);

      const writeSeqAfter = engine.eventReader ? engine.eventReader.writeSeq : 0;
      const u32 = engine.eventReader?.u32View;
      const capacity = engine.eventReader?.capacity || 256;
      const stride = engine.eventReader?.strideWords || 16;
      const scanStart = Math.max(writeSeqBefore, writeSeqAfter - capacity);

      let floorHitThisTick = engine.module._physics_getBallOnGround?.() === 1;
      if (!floorHitThisTick && u32 && writeSeqAfter > scanStart) {
        for (let seq = scanStart; seq < writeSeqAfter; seq++) {
          const slot = seq % capacity;
          const wordOffset = 4 + slot * stride;
          const evType = u32[wordOffset];
          const subType = u32[wordOffset + 12];
          if (
            evType === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT &&
            subType === SURFACE_SUBTYPES.FLOOR
          ) {
            floorHitThisTick = true;
            break;
          }
        }
      }
      this.ballTouchedFloorInLastStep = Boolean(floorHitThisTick);

      const postSt = engine.state;
      if (!hasPadSlice || !postSt) continue;

      let hasCandidatePickup = false;
      for (let p = 0; p < NUM_BOOST_PADS; p++) {
        const base = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
        const isActive = postSt[base] >= 0.5;
        if (isActive) continue;
        const wasActive = preActive[p] === 1;
        const prevCd = preCooldown[p];
        const currCd = postSt[base + 1];
        if (wasActive || (prevCd > 0 && currCd > prevCd + 0.1)) {
          hasCandidatePickup = true;
          break;
        }
      }

      if (!hasCandidatePickup) continue;

      if (!this.cachedPads || this.cachedPadsPreset !== engine.arenaPreset) {
        this.cachedPads = readArenaPads(engine.module as any, engine as any);
        this.cachedPadsPreset = engine.arenaPreset;
      }
      const pads = this.cachedPads;
      const eventTick = Math.max(0, Math.floor(postSt[0] || 0) - 1) >>> 0;

      for (let p = 0; p < NUM_BOOST_PADS; p++) {
        const base = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
        const isActive = postSt[base] >= 0.5;
        if (isActive) continue;

        const wasActive = preActive[p] === 1;
        const prevCd = preCooldown[p];
        const currCd = postSt[base + 1];
        const normalPickup = wasActive && !isActive;
        const sameTickRespawnPickup =
          !wasActive && !isActive && prevCd > 0 && currCd > prevCd + 0.1;

        if (!normalPickup && !sameTickRespawnPickup) continue;

        let hasNativePickup = false;
        let hasNativeSpawn = false;
        if (u32 && writeSeqAfter > scanStart) {
          for (let seq = scanStart; seq < writeSeqAfter; seq++) {
            const slot = seq % capacity;
            const wordOffset = 4 + slot * stride;
            const evType = u32[wordOffset];
            const secId = (u32[wordOffset + 11] >>> 16) & 0xffff;
            if (secId === p) {
              if (evType === INCIDENT_EVENT_TYPES.BOOST_PICKUP) hasNativePickup = true;
              if (evType === INCIDENT_EVENT_TYPES.BOOST_SPAWN) hasNativeSpawn = true;
            }
          }
        }

        if (hasNativePickup && (!sameTickRespawnPickup || hasNativeSpawn)) continue;

        const padInfo = pads?.[p];
        const padX = padInfo?.pos?.[0] ?? 0;
        const padY = padInfo?.pos?.[1] ?? 0;
        const padZ = padInfo?.pos?.[2] ?? 70;
        const isBig = padInfo ? Boolean(padInfo.isBig) : p < 6;

        if (sameTickRespawnPickup && !hasNativeSpawn) {
          engine.pushSignalEvent(
            INCIDENT_EVENT_TYPES.BOOST_SPAWN,
            eventTick,
            padX,
            padY,
            padZ,
            0,
            0,
            0,
            0xffff,
            p,
            isBig ? 1 : 0,
            0,
            0,
            0
          );
        }

        if (!hasNativePickup) {
          let pickedCarIdx = 0xffff;
          let bestDistSq = Infinity;
          for (let c = 0; c < MAX_CARS; c++) {
            if (typeof engine.isCarSlotActive === 'function' && !engine.isCarSlotActive(c)) {
              continue;
            }
            if (
              typeof engine.getCarBoostCollectable === 'function' &&
              !engine.getCarBoostCollectable(c)
            ) {
              continue;
            }
            const carBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
            if (postSt[carBase + CAR_STATE_OFFSETS.DEMOED] > 0) continue;
            const dx = postSt[carBase + CAR_STATE_OFFSETS.POS] - padX;
            const dy = postSt[carBase + CAR_STATE_OFFSETS.POS + 1] - padY;
            const dz = postSt[carBase + CAR_STATE_OFFSETS.POS + 2] - padZ;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              pickedCarIdx = c;
            }
          }

          engine.pushSignalEvent(
            INCIDENT_EVENT_TYPES.BOOST_PICKUP,
            eventTick,
            padX,
            padY,
            padZ,
            0,
            0,
            0,
            pickedCarIdx,
            p,
            isBig ? 1 : 0,
            0,
            0,
            0
          );
        }
      }
    }
  }
}
