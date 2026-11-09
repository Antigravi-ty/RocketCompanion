/**
 * RLRCInterveneNonPovSyncPipeline.ts
 * Per-tick non-POV car synchronization and live physics step pipeline during RLRC intervention:
 * - Drives the 4 non-POV intervention modes ('disappear' | 'no-input' | 'follow-state' | 'bot-takeover')
 * - Dynamically adds/removes non-POV car entities as entityActive transitions occur
 */

import { patchWasmCarTransientState } from '../../../physics/CarTransientStateReconstructor.ts';
import { SIM_OFFSETS } from '../../../physics/RocketSimConstants.ts';
import type { ReplayAcknowledgedControlEntry } from '../../ReplayRingBuffer.ts';
import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCFrame120Hz,
  type RLRCInterveneLaunchConfig,
  type RLRCNonPovInterventionMode,
  type RLRCPlayerSlotMeta,
  type RLRCSynthesizedCarControls,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
import {
  DEFAULT_NEUTRAL_CAR_CONTROLS,
  clampCarPositionZForHitbox,
} from './RLRCInterveneFrameStateBuilder.ts';
import type { RLRCPrerollRingBufferPort } from './RLRCIntervenePrerollInjector.ts';
import {
  applySlotControls,
  applyTargetFrameToPhysicsAndArena,
  buildReconstructedCarTransientState,
  deactivateInterveneSlotEntity,
  ensureInterveneSlotEntityActive,
  writeCarRigidBodyState,
  type RLRCInterveneArenaPort,
  type RLRCInterveneBotDecisionPort,
  type RLRCIntervenePhysicsPort,
} from './RLRCInterveneTargetFrameApplier.ts';

export type * from './RLRCInterveneTargetFrameApplier.ts';

export function resetPhysicsAndInterpolatorForShotLaunch(params: {
  readonly targetFrame: RLRCFrame120Hz;
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly config: RLRCInterveneLaunchConfig;
  readonly sim: RLRCIntervenePhysicsPort | null | undefined;
  readonly arena: RLRCInterveneArenaPort | null | undefined;
  readonly slotActiveTracker: Uint8Array;
  readonly finalPrerollTick: number;
  readonly prevStepStateBuffer: Float32Array | null;
}): Float32Array | null {
  const { targetFrame, roster, config, sim, arena, slotActiveTracker, finalPrerollTick } = params;
  let prevBuf = params.prevStepStateBuffer;
  if (!sim) return prevBuf;

  applyTargetFrameToPhysicsAndArena({
    frame: targetFrame,
    roster,
    config,
    sim,
    arena,
    slotActiveTracker,
    rebuildMeshes: false,
  });
  sim.clearEvents?.();
  sim.resetGoalLatch?.();
  if (sim.state) {
    sim.state[SIM_OFFSETS.TICK] = finalPrerollTick;
    sim.state[SIM_OFFSETS.GOAL] = 0;
    if (!prevBuf || prevBuf.length !== sim.state.length) {
      prevBuf = new Float32Array(sim.state.length);
    }
    prevBuf.set(sim.state);
    arena?.syncInterpolatorToState?.(sim.state);
  }
  return prevBuf;
}

export function stepNonPovCarsBeforePhysics(params: {
  readonly sim: RLRCIntervenePhysicsPort;
  readonly arena: RLRCInterveneArenaPort | null | undefined;
  readonly botPort: RLRCInterveneBotDecisionPort | null | undefined;
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly followFrame: RLRCFrame120Hz | null;
  readonly povSlotIndex: number;
  readonly nonPovMode: RLRCNonPovInterventionMode;
  readonly slotActiveTracker: Uint8Array;
  readonly latestControlSnapshot: Map<number, RLRCSynthesizedCarControls>;
  readonly dt: number;
}): void {
  const {
    sim,
    arena,
    botPort,
    roster,
    followFrame,
    povSlotIndex,
    nonPovMode,
    slotActiveTracker,
    latestControlSnapshot,
    dt,
  } = params;

  for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
    if (slot === povSlotIndex) continue;

    if (nonPovMode === 'disappear') {
      if (slotActiveTracker[slot] !== 0) {
        deactivateInterveneSlotEntity(sim, arena, slotActiveTracker, slot);
      }
      continue;
    }

    if (nonPovMode === 'no-input') {
      if (slotActiveTracker[slot] !== 0) {
        applySlotControls(sim, slot, DEFAULT_NEUTRAL_CAR_CONTROLS);
        latestControlSnapshot.set(slot, DEFAULT_NEUTRAL_CAR_CONTROLS);
      }
      continue;
    }

    const carFrame = followFrame?.cars[slot];
    const meta = roster.find((r) => r.slotIndex === slot);
    const team: RLRCTeamIndex = meta?.team ?? (slot < 3 ? 0 : 1);
    const hitboxId = meta?.hitboxId ?? 'hitbox-octane';

    if (nonPovMode === 'follow-state') {
      if (!carFrame) {
        if (slotActiveTracker[slot] !== 0) {
          applySlotControls(sim, slot, DEFAULT_NEUTRAL_CAR_CONTROLS);
          latestControlSnapshot.set(slot, DEFAULT_NEUTRAL_CAR_CONTROLS);
        }
        continue;
      }
      if (!carFrame.entityActive) {
        deactivateInterveneSlotEntity(sim, arena, slotActiveTracker, slot);
        continue;
      }
      ensureInterveneSlotEntityActive(sim, arena, slotActiveTracker, slot, team, hitboxId);
      const carControls = carFrame.controls || DEFAULT_NEUTRAL_CAR_CONTROLS;
      applySlotControls(sim, slot, carControls);
      latestControlSnapshot.set(slot, carControls);
      continue;
    }

    if (nonPovMode === 'bot-takeover') {
      if (slotActiveTracker[slot] === 0 && carFrame?.entityActive) {
        ensureInterveneSlotEntityActive(sim, arena, slotActiveTracker, slot, team, hitboxId);
      }
      if (slotActiveTracker[slot] !== 0) {
        const botControls =
          botPort?.decideControlsForSlot?.(slot, team, sim.state, dt) ??
          DEFAULT_NEUTRAL_CAR_CONTROLS;
        applySlotControls(sim, slot, botControls);
        latestControlSnapshot.set(slot, botControls);
      }
    }
  }
}

export function syncFollowStateNonPovAfterStep(params: {
  readonly sim: RLRCIntervenePhysicsPort;
  readonly arena: RLRCInterveneArenaPort | null | undefined;
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly nextFrame: RLRCFrame120Hz | null;
  readonly povSlotIndex: number;
  readonly slotActiveTracker: Uint8Array;
  readonly latestControlSnapshot?: Map<number, RLRCSynthesizedCarControls>;
}): void {
  const { sim, arena, roster, nextFrame, povSlotIndex, slotActiveTracker, latestControlSnapshot } =
    params;
  if (!nextFrame) return;

  for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
    if (slot === povSlotIndex) continue;
    const car = nextFrame.cars[slot];
    if (!car || !car.entityActive) {
      deactivateInterveneSlotEntity(sim, arena, slotActiveTracker, slot);
      continue;
    }
    const meta = roster.find((r) => r.slotIndex === slot);
    const team: RLRCTeamIndex = meta?.team ?? (slot < 3 ? 0 : 1);
    const hitboxId = meta?.hitboxId ?? 'hitbox-octane';
    ensureInterveneSlotEntityActive(sim, arena, slotActiveTracker, slot, team, hitboxId);
    const safePos = clampCarPositionZForHitbox(car.rigidBody.position, car.isOnGround, hitboxId);
    writeCarRigidBodyState(sim, slot, car, safePos);
    const carControls = car.controls || DEFAULT_NEUTRAL_CAR_CONTROLS;
    applySlotControls(sim, slot, carControls);
    latestControlSnapshot?.set(slot, carControls);
    patchWasmCarTransientState(sim, slot, buildReconstructedCarTransientState(car), false);
  }
}

export function collectLiveAcknowledgedControls(
  latestControlSnapshot: ReadonlyMap<number, RLRCSynthesizedCarControls>
): ReplayAcknowledgedControlEntry[] {
  const entries: ReplayAcknowledgedControlEntry[] = [];
  for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
    const carControls = latestControlSnapshot.get(slot) ?? DEFAULT_NEUTRAL_CAR_CONTROLS;
    entries.push({ carIndex: slot, controls: { ...carControls } });
  }
  return entries;
}

export function prepareIntervenePrePhysicsControls(params: {
  readonly sim: RLRCIntervenePhysicsPort;
  readonly arena: RLRCInterveneArenaPort | null | undefined;
  readonly botPort: RLRCInterveneBotDecisionPort | null | undefined;
  readonly frames: readonly RLRCFrame120Hz[];
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly followIdx: number;
  readonly povSlotIndex: number;
  readonly nonPovMode: RLRCNonPovInterventionMode;
  readonly playerControls: RLRCSynthesizedCarControls;
  readonly liveInterventionTick: number;
  readonly dt: number;
  readonly slotActiveTracker: Uint8Array;
  readonly latestControlSnapshot: Map<number, RLRCSynthesizedCarControls>;
}): void {
  const {
    sim,
    arena,
    botPort,
    frames,
    roster,
    followIdx,
    povSlotIndex,
    nonPovMode,
    playerControls,
    liveInterventionTick,
    dt,
    slotActiveTracker,
    latestControlSnapshot,
  } = params;

  latestControlSnapshot.clear();
  applySlotControls(sim, povSlotIndex, playerControls);
  latestControlSnapshot.set(povSlotIndex, playerControls);

  const followFrame = followIdx >= 0 && followIdx < frames.length ? frames[followIdx] : null;
  if (nonPovMode === 'follow-state') {
    syncFollowStateNonPovAfterStep({
      sim,
      arena,
      roster,
      nextFrame: followFrame,
      povSlotIndex,
      slotActiveTracker,
      latestControlSnapshot,
    });
  } else {
    stepNonPovCarsBeforePhysics({
      sim,
      arena,
      botPort,
      roster,
      followFrame,
      povSlotIndex,
      nonPovMode,
      slotActiveTracker,
      latestControlSnapshot,
      dt,
    });
  }

  if (sim.state) {
    sim.state[SIM_OFFSETS.TICK] = Math.max(0, liveInterventionTick - 1);
  }
}

export function executeIntervenePhysicsStepTick(params: {
  readonly sim: RLRCIntervenePhysicsPort;
  readonly arena: RLRCInterveneArenaPort | null | undefined;
  readonly botPort: RLRCInterveneBotDecisionPort | null | undefined;
  readonly ringBuffer: RLRCPrerollRingBufferPort | null | undefined;
  readonly frames: readonly RLRCFrame120Hz[];
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly followIdx: number;
  readonly povSlotIndex: number;
  readonly nonPovMode: RLRCNonPovInterventionMode;
  readonly playerControls: RLRCSynthesizedCarControls;
  readonly recordedTick: number;
  readonly dt: number;
  readonly slotActiveTracker: Uint8Array;
  readonly latestControlSnapshot: Map<number, RLRCSynthesizedCarControls>;
  readonly prevStepStateBuffer: Float32Array | null;
}): Float32Array | null {
  const {
    sim,
    arena,
    botPort,
    ringBuffer,
    frames,
    roster,
    followIdx,
    povSlotIndex,
    nonPovMode,
    playerControls,
    recordedTick,
    dt,
    slotActiveTracker,
    latestControlSnapshot,
  } = params;
  let prevBuf = params.prevStepStateBuffer;

  if (sim.state) {
    if (!prevBuf || prevBuf.length !== sim.state.length) {
      prevBuf = new Float32Array(sim.state.length);
    }
    prevBuf.set(sim.state);
  }

  latestControlSnapshot.clear();
  applySlotControls(sim, povSlotIndex, playerControls);
  latestControlSnapshot.set(povSlotIndex, playerControls);

  stepNonPovCarsBeforePhysics({
    sim,
    arena,
    botPort,
    roster,
    followFrame: followIdx >= 0 && followIdx < frames.length ? frames[followIdx] : null,
    povSlotIndex,
    nonPovMode,
    slotActiveTracker,
    latestControlSnapshot,
    dt,
  });

  sim.step?.(1);

  if (nonPovMode === 'follow-state') {
    const nextIdx = followIdx + 1;
    syncFollowStateNonPovAfterStep({
      sim,
      arena,
      roster,
      nextFrame: nextIdx >= 0 && nextIdx < frames.length ? frames[nextIdx] : null,
      povSlotIndex,
      slotActiveTracker,
      latestControlSnapshot,
    });
  }

  if (sim.state) {
    sim.state[SIM_OFFSETS.TICK] = recordedTick;
    if (arena?.interpolator) {
      arena.interpolator.prevState.set(prevBuf ?? arena.interpolator.currState);
      arena.interpolator.currState.set(sim.state);
    } else {
      arena?.syncInterpolatorToState?.(sim.state, prevBuf ?? undefined);
    }
    const acknowledgedControls = collectLiveAcknowledgedControls(latestControlSnapshot);
    const slot = ringBuffer?.recordFrame?.(recordedTick, sim.state, { acknowledgedControls });
    if (slot?.snapshot) slot.snapshot[SIM_OFFSETS.TICK] = recordedTick;
  }

  return prevBuf;
}
