import { DEFAULT_CAR_CONTROLS } from '../../../ai/experimental/ExperimentalBotAgent.ts';
import type {
  LabArenaPort,
  LabPhysicsEnginePort,
  LabRuntimePort,
} from './LabTabTypes.ts';

export const PROBE_BOOST_SLOT = 6;
export const PROBE_QE_SLOT = 7;

export type ProbePhase =
  | 'CLIMB_TO_PEAK'
  | 'HOLD_AT_PEAK'
  | 'FALL_TO_BASE'
  | 'REBOUND_TO_PEAK'
  | string;

export interface ProbeControllerState {
  phase: ProbePhase;
  holdCounter: number;
  tickCounter: number;
  baseAltitudeZ: number;
  peakAltitudeZ: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  boostProbePosX: number;
  boostProbePosY: number;
  qeProbePosX: number;
  qeProbePosY: number;
  effectiveBaseZ: number;
  effectivePeakZ: number;
}

export interface ProbeTelemetrySnapshot {
  posZ: number;
  velZ: number;
  phase: ProbePhase;
  holdCounter: number;
  rollDir: number;
}

export interface ProbeStepResult {
  nextState: ProbeControllerState;
  telemetry: ProbeTelemetrySnapshot;
}

export function resetSinglePlayerLabBaseline(
  runtime: LabRuntimePort | null | undefined,
  resetKickoffState = true
): void {
  if (!runtime?.physics) return;

  while (
    runtime.physics.numCars > 1 &&
    typeof runtime.physics.removeCar === 'function'
  ) {
    runtime.physics.removeCar(runtime.physics.numCars - 1);
  }
  if (runtime.physics.numCars < 1 && typeof runtime.physics.addCar === 'function') {
    runtime.physics.addCar(0, 'octane');
  }
  runtime.physics.setCarLinearFactorAndGravity?.(0, 1, 1, 1, 1);
  runtime.physics.setCarCollisionMask?.(0, true, true);
  runtime.physics.setSimulationFrozen?.(false, 0, false);
  runtime.physics.setPossessionReportingEnabled?.(false);
  runtime.physics.setUnlimitedBoost?.(true);

  const neutral = runtime.neutralControls || DEFAULT_CAR_CONTROLS;
  for (let slot = 0; slot < 8; slot++) {
    runtime.physics.setControls?.(slot, neutral);
  }

  if (resetKickoffState) {
    runtime.physics.resetGoalLatch?.();
    runtime.physics.resetKickoff?.(0, false);
    runtime.physics.clearEvents?.();
  }

  if (runtime.arena?.cars) {
    if (runtime.arena.cars[0]) {
      runtime.arena.cars[0].visible = true;
      runtime.arena.setCarTeam?.(0, 0);
    }
    for (let i = 1; i < runtime.arena.cars.length; i++) {
      if (runtime.arena.cars[i]) runtime.arena.cars[i].visible = false;
    }
    runtime.arena.clearAllGhostOpacities?.();
  }
  runtime.arena?.resetAllCarEffects?.();
  if (Array.isArray(runtime.flipResetVisuals)) {
    for (const fx of runtime.flipResetVisuals) fx?.stopVisual?.();
  }
  runtime.boostBloom?.clear?.();
  runtime.ballTrajectoryPredictor?.clear?.();
  runtime.simulationStage?.resetActionStates?.();
  runtime.interpolator?.sync?.();

  runtime.playerCarIndex = 0;
  if (runtime.arena) runtime.arena.playerCarIndex = 0;
}

export function computeDevTestLabProbeSpawn(
  baseAltitudeZ = 400,
  peakAltitudeZ = 1550,
  offsetX = 0,
  offsetY = 0,
  offsetZ = 0
): ProbeControllerState {
  const ox = Number.isFinite(offsetX) ? offsetX : 0;
  const oy = Number.isFinite(offsetY) ? offsetY : 0;
  const oz = Number.isFinite(offsetZ) ? offsetZ : 0;
  const effectiveBaseZ = Math.max(80, Math.min(1850, baseAltitudeZ + oz));
  const effectivePeakZ = Math.max(
    effectiveBaseZ + 120,
    Math.min(1950, peakAltitudeZ + oz)
  );
  return {
    phase: 'CLIMB_TO_PEAK',
    holdCounter: 0,
    tickCounter: 0,
    baseAltitudeZ,
    peakAltitudeZ,
    offsetX: ox,
    offsetY: oy,
    offsetZ: oz,
    boostProbePosX: -1200 + ox,
    boostProbePosY: 0 + oy,
    qeProbePosX: 1200 + ox,
    qeProbePosY: 0 + oy,
    effectiveBaseZ,
    effectivePeakZ,
  };
}

export function parkDevTestLabProbes(
  physics: LabPhysicsEnginePort | null | undefined,
  arena?: LabArenaPort | null
): void {
  if (!physics) return;
  for (const slot of [PROBE_BOOST_SLOT, PROBE_QE_SLOT]) {
    if (physics.numCars > slot) {
      physics.setCarLinearFactorAndGravity?.(slot, 0, 0, 0, 0);
      physics.setCarCollisionMask?.(slot, false, false);
      physics.setCarState(slot, {
        pos: [slot === PROBE_BOOST_SLOT ? -9500 : 9500, 9500, -2000],
        vel: [0, 0, 0],
        angVel: [0, 0, 0],
        rot: [0, 0, 0],
        boost: 0,
      });
      physics.setControls(slot, DEFAULT_CAR_CONTROLS);
    }
    if (arena?.cars?.[slot]) {
      arena.cars[slot].visible = false;
      arena.resetCarBoosts?.(slot);
    }
  }
}

export function setupDevTestLabProbes(
  physics: LabPhysicsEnginePort | null | undefined,
  arena: LabArenaPort | null | undefined,
  baseAltitudeZ = 400,
  peakAltitudeZ = 1550,
  offsetX = 0,
  offsetY = 0,
  offsetZ = 0
): ProbeControllerState | null {
  if (!physics) return null;

  while (physics.numCars <= PROBE_QE_SLOT) {
    const slotIdx = physics.numCars;
    const team = slotIdx === PROBE_QE_SLOT ? 1 : 0;
    physics.addCar(team, 'octane');
  }
  physics.setCarTeam?.(PROBE_BOOST_SLOT, 0);
  physics.setCarTeam?.(PROBE_QE_SLOT, 1);

  if (arena) {
    for (let i = 1; i < PROBE_BOOST_SLOT; i++) {
      if (arena.cars[i]) arena.cars[i].visible = false;
      if (physics.numCars > i) {
        physics.setCarLinearFactorAndGravity?.(i, 0, 0, 0, 0);
        physics.setCarCollisionMask?.(i, false, false);
        physics.setCarState(i, {
          pos: [9000 + i * 200, 9000, -2000],
          vel: [0, 0, 0],
          angVel: [0, 0, 0],
          rot: [0, 0, 0],
          boost: 0,
        });
      }
    }
    arena.ensureCar?.(PROBE_BOOST_SLOT, 0, 'fennec');
    arena.ensureCar?.(PROBE_QE_SLOT, 1, 'fennec');
    if (arena.cars[PROBE_BOOST_SLOT]) arena.cars[PROBE_BOOST_SLOT].visible = true;
    if (arena.cars[PROBE_QE_SLOT]) arena.cars[PROBE_QE_SLOT].visible = true;
    arena.resetCarBoosts?.(PROBE_BOOST_SLOT);
    arena.resetCarBoosts?.(PROBE_QE_SLOT);
  }

  const probeState = computeDevTestLabProbeSpawn(
    baseAltitudeZ,
    peakAltitudeZ,
    offsetX,
    offsetY,
    offsetZ
  );

  physics.setCarCollisionMask?.(PROBE_BOOST_SLOT, false, false);
  physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 1, 1);
  physics.setCarState(PROBE_BOOST_SLOT, {
    pos: [
      probeState.boostProbePosX,
      probeState.boostProbePosY,
      probeState.effectiveBaseZ,
    ],
    vel: [0, 0, 0],
    angVel: [0, 0, 0],
    rot: [Math.PI / 2, 0, 0],
    boost: 100,
  });

  physics.setCarCollisionMask?.(PROBE_QE_SLOT, false, false);
  physics.setCarLinearFactorAndGravity?.(PROBE_QE_SLOT, 0, 0, 0, 0);
  physics.setCarState(PROBE_QE_SLOT, {
    pos: [probeState.qeProbePosX, probeState.qeProbePosY, 650 + probeState.offsetZ],
    vel: [0, 0, 0],
    angVel: [0, 0, 0],
    rot: [0, Math.PI / 2, 0],
    boost: 100,
  });

  return probeState;
}

export function updateDevTestLabProbeParameters(
  physics: LabPhysicsEnginePort | null | undefined,
  probeState: ProbeControllerState | null,
  baseAltitudeZ = 400,
  peakAltitudeZ = 1550,
  offsetX = 0,
  offsetY = 0,
  offsetZ = 0,
  arena: LabArenaPort | null = null
): ProbeControllerState | null {
  if (!physics) return null;
  if (!probeState || physics.numCars <= PROBE_QE_SLOT) {
    return setupDevTestLabProbes(
      physics,
      arena,
      baseAltitudeZ,
      peakAltitudeZ,
      offsetX,
      offsetY,
      offsetZ
    );
  }

  const updated = computeDevTestLabProbeSpawn(
    baseAltitudeZ,
    peakAltitudeZ,
    offsetX,
    offsetY,
    offsetZ
  );
  const nextState: ProbeControllerState = {
    ...probeState,
    baseAltitudeZ: updated.baseAltitudeZ,
    peakAltitudeZ: updated.peakAltitudeZ,
    offsetX: updated.offsetX,
    offsetY: updated.offsetY,
    offsetZ: updated.offsetZ,
    boostProbePosX: updated.boostProbePosX,
    boostProbePosY: updated.boostProbePosY,
    qeProbePosX: updated.qeProbePosX,
    qeProbePosY: updated.qeProbePosY,
    effectiveBaseZ: updated.effectiveBaseZ,
    effectivePeakZ: updated.effectivePeakZ,
  };

  const bCar = physics.getCarStateView(PROBE_BOOST_SLOT);
  const clampedBoostZ = Math.max(
    nextState.effectiveBaseZ,
    Math.min(
      nextState.effectivePeakZ,
      Number.isFinite(bCar?.posZ) ? bCar.posZ : nextState.effectiveBaseZ
    )
  );
  physics.setCarState(PROBE_BOOST_SLOT, {
    pos: [nextState.boostProbePosX, nextState.boostProbePosY, clampedBoostZ],
    vel: [0, 0, Number.isFinite(bCar?.velZ) ? bCar.velZ : 0],
    angVel: [0, 0, 0],
    rot: [Math.PI / 2, 0, 0],
    boost: 100,
  });

  const qCar = physics.getCarStateView(PROBE_QE_SLOT);
  physics.setCarState(PROBE_QE_SLOT, {
    pos: [nextState.qeProbePosX, nextState.qeProbePosY, 650 + nextState.offsetZ],
    vel: [0, 0, 0],
    angVel: [
      Number.isFinite(qCar?.angVelX) ? qCar.angVelX : 0,
      Number.isFinite(qCar?.angVelY) ? qCar.angVelY : 0,
      Number.isFinite(qCar?.angVelZ) ? qCar.angVelZ : 0,
    ],
    rot: [0, Math.PI / 2, 0],
    boost: 100,
  });

  return nextState;
}

export function stepDevTestLabProbes(
  physics: LabPhysicsEnginePort | null | undefined,
  probeState: ProbeControllerState | null
): ProbeStepResult | null {
  if (!physics || !probeState || physics.numCars <= PROBE_QE_SLOT) return null;

  let phase = probeState.phase;
  let holdCounter = probeState.holdCounter;
  const tickCounter = probeState.tickCounter + 1;

  const bCar = physics.getCarStateView(PROBE_BOOST_SLOT);
  const posZ = bCar.posZ;
  const velZ = bCar.velZ;
  const baseZ = probeState.effectiveBaseZ ?? probeState.baseAltitudeZ;
  const peakZ = probeState.effectivePeakZ ?? probeState.peakAltitudeZ;
  const probeX = probeState.boostProbePosX ?? -1200;
  const probeY = probeState.boostProbePosY ?? 0;

  let boostActive = false;

  if (phase === 'CLIMB_TO_PEAK') {
    if (posZ >= peakZ) {
      phase = 'HOLD_AT_PEAK';
      holdCounter = 120;
      physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 0, 0);
      physics.setCarState(PROBE_BOOST_SLOT, {
        pos: [probeX, probeY, peakZ],
        vel: [0, 0, 0],
        angVel: [0, 0, 0],
        rot: [Math.PI / 2, 0, 0],
        boost: 100,
      });
      boostActive = false;
    } else {
      physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 1, 1);
      boostActive = true;
    }
  } else if (phase === 'HOLD_AT_PEAK') {
    holdCounter--;
    physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 0, 0);
    physics.setCarState(PROBE_BOOST_SLOT, {
      pos: [probeX, probeY, peakZ],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      rot: [Math.PI / 2, 0, 0],
      boost: 100,
    });
    boostActive = false;
    if (holdCounter <= 0) {
      phase = 'FALL_TO_BASE';
      physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 1, 1);
    }
  } else if (phase === 'FALL_TO_BASE') {
    physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 1, 1);
    boostActive = false;
    if (posZ <= baseZ) {
      phase = 'REBOUND_TO_PEAK';
      boostActive = true;
    }
  } else if (phase === 'REBOUND_TO_PEAK') {
    physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 1, 1);
    boostActive = true;
    if (posZ >= peakZ) {
      phase = 'HOLD_AT_PEAK';
      holdCounter = 120;
      physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 0, 0);
      physics.setCarState(PROBE_BOOST_SLOT, {
        pos: [probeX, probeY, peakZ],
        vel: [0, 0, 0],
        angVel: [0, 0, 0],
        rot: [Math.PI / 2, 0, 0],
        boost: 100,
      });
      boostActive = false;
    }
  }

  physics.setControls(PROBE_BOOST_SLOT, {
    ...DEFAULT_CAR_CONTROLS,
    boost: boostActive,
  });

  const cycleTick = tickCounter % 360;
  let rollDir = 0;
  if (cycleTick < 150) {
    rollDir = 1;
  } else if (cycleTick >= 180 && cycleTick < 330) {
    rollDir = -1;
  }

  physics.setCarLinearFactorAndGravity?.(PROBE_QE_SLOT, 0, 0, 0, 0);
  physics.setControls(PROBE_QE_SLOT, {
    ...DEFAULT_CAR_CONTROLS,
    roll: rollDir,
    boost: false,
  });

  const nextState: ProbeControllerState = {
    ...probeState,
    phase,
    holdCounter,
    tickCounter,
  };

  return {
    nextState,
    telemetry: {
      posZ: Number(posZ.toFixed(1)),
      velZ: Number(velZ.toFixed(1)),
      phase,
      holdCounter,
      rollDir,
    },
  };
}
