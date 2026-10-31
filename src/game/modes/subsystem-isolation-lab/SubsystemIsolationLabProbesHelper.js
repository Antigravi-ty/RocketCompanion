/**
 * SubsystemIsolationLabProbesHelper.js
 * Implements the 2-vehicle predictive & non-predictive diagnostic probe state machine:
 *
 * 1. Car A (Slot 6 - Unpredictable Boost Altitude Loop):
 *    - Has standard gravity (gravityScale = 1.0), horizontal XY translation locked (fx=0, fy=0, fz=1).
 *    - Placed inside the arena at (-2500 + offsetX, -400 + offsetY, Z0 = baseZ + offsetZ).
 *    - Note on physics: A 100 UU boost climb (500 -> 600) followed by free-fall below 500 builds
 *      downward velocity Vz ≈ -445 uu/s, which requires ~290 UU of full-boost braking distance
 *      (since net upward boost accel is 991.67 - 650 = +341.67 uu/s²). Setting base altitude
 *      Z0 = 500 (peak Z1 = 600) keeps the recovery trough at Z ≈ 210 UU (well above the floor Z=17).
 *    - Phase 'CLIMB_TO_PEAK': Holds boost continuously until Z >= Z1, then releases boost.
 *    - Phase 'FALL_BELOW_BASE': Falls naturally under gravity until Z < Z0.
 *    - Phase 'RECOVER_AND_HOLD': Uses energy-based stopping altitude prediction
 *      (stoppingZ = Z + Vz² / (2*g) when rising) to settle into [Z0 - 10, Z0 + 10] with
 *      zero positive-feedback overshoot, holding steady for 1.0 second (120 ticks @ 120Hz)
 *      before repeating 'CLIMB_TO_PEAK'.
 *
 * 2. Car B (Slot 7 - Predictable 0G Q/E Roll):
 *    - Zero gravity (gravityScale = 0.0), XYZ translation locked (fx=0, fy=0, fz=0).
 *    - Placed inside the arena at (-2500 + offsetX, +400 + offsetY, 550 + offsetZ), alternating Q (+1.0) and E (-1.0) roll.
 */

export const PROBE_BOOST_SLOT = 6;
export const PROBE_QE_SLOT = 7;

export const DEFAULT_PROBE_ANCHOR_X = -2500;
export const DEFAULT_PROBE_BOOST_Y = -400;
export const DEFAULT_PROBE_QE_Y = 400;

export function createProbeControllerState(baseZ = 500, peakZ = 600, offsetX = 0, offsetY = 0, offsetZ = 0) {
  const effectiveBaseZ = (Number.isFinite(baseZ) ? baseZ : 500) + (Number.isFinite(offsetZ) ? offsetZ : 0);
  const effectivePeakZ = (Number.isFinite(peakZ) ? peakZ : 600) + (Number.isFinite(offsetZ) ? offsetZ : 0);
  return {
    phase: 'CLIMB_TO_PEAK', // 'CLIMB_TO_PEAK' | 'FALL_BELOW_BASE' | 'RECOVER_AND_HOLD'
    baseZ: Number.isFinite(baseZ) ? baseZ : 500,
    peakZ: Number.isFinite(peakZ) ? peakZ : 600,
    offsetX: Number.isFinite(offsetX) ? offsetX : 0,
    offsetY: Number.isFinite(offsetY) ? offsetY : 0,
    offsetZ: Number.isFinite(offsetZ) ? offsetZ : 0,
    effectiveBaseZ,
    effectivePeakZ,
    toleranceZ: 10,
    targetHoldTicks: 120, // 1.0s @ 120Hz
    holdCounter: 0,
    lastZ: effectiveBaseZ,
    lastVz: 0,
    rollDir: 1,
    tickCounter: 0,
  };
}

export function getProbeSpawnCoordinates(baseZ = 500, offsetX = 0, offsetY = 0, offsetZ = 0) {
  const ox = Number.isFinite(offsetX) ? offsetX : 0;
  const oy = Number.isFinite(offsetY) ? offsetY : 0;
  const oz = Number.isFinite(offsetZ) ? offsetZ : 0;
  const z0 = (Number.isFinite(baseZ) ? baseZ : 500) + oz;
  return {
    boostPos: {
      x: DEFAULT_PROBE_ANCHOR_X + ox,
      y: DEFAULT_PROBE_BOOST_Y + oy,
      z: z0,
    },
    qePos: {
      x: DEFAULT_PROBE_ANCHOR_X + ox,
      y: DEFAULT_PROBE_QE_Y + oy,
      z: z0 + 50,
    },
  };
}

export function setupDevTestLabProbes(physics, arena, baseZ = 500, peakZ = 600, offsetX = 0, offsetY = 0, offsetZ = 0) {
  if (!physics) return null;
  const coords = getProbeSpawnCoordinates(baseZ, offsetX, offsetY, offsetZ);

  while (physics.numCars <= PROBE_QE_SLOT) {
    physics.addCar(physics.numCars % 2, 'octane');
  }

  // Park intermediate slots 1..5 in the underground inactive zone so ArenaWorldUpdater hides them
  for (let idx = 1; idx < PROBE_BOOST_SLOT; idx++) {
    physics.setCarLinearFactorAndGravity?.(idx, 0, 0, 0, 0);
    physics.setCarCollisionMask?.(idx, false, false);
    physics.setCarState?.(idx, {
      pos: [-5500, idx * 300, -500],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      boost: 0,
      isOnGround: false,
    });
    if (arena?.cars?.[idx]) {
      arena.cars[idx].visible = false;
    }
    arena?.resetCarBoosts?.(idx);
    arena?.carDemolitions?.[idx]?.stop?.();
  }

  // Ensure visual meshes exist in ArenaWorld for Slot 6 & Slot 7
  if (arena && typeof arena.ensureCar === 'function') {
    arena.ensureCar(PROBE_BOOST_SLOT, 1, 'fennec');
    arena.ensureCar(PROBE_QE_SLOT, 0, 'fennec');
    if (arena.cars[PROBE_BOOST_SLOT]) arena.cars[PROBE_BOOST_SLOT].visible = true;
    if (arena.cars[PROBE_QE_SLOT]) arena.cars[PROBE_QE_SLOT].visible = true;
    arena.resetCarBoosts?.(PROBE_BOOST_SLOT);
    arena.resetCarBoosts?.(PROBE_QE_SLOT);
  }

  // Car A (Slot 6): Pitched straight up (+Z nose) in mid-air so rocket boost pushes along +Z against gravity
  physics.setCarCollisionMask?.(PROBE_BOOST_SLOT, false, false);
  physics.setCarState?.(PROBE_BOOST_SLOT, {
    pos: [coords.boostPos.x, coords.boostPos.y, coords.boostPos.z],
    forward: [0, 0, 1],
    right: [0, 1, 0],
    up: [-1, 0, 0],
    vel: [0, 0, 0],
    angVel: [0, 0, 0],
    boost: 100,
    isOnGround: false,
  });
  physics.setCarLinearFactorAndGravity?.(PROBE_BOOST_SLOT, 0, 0, 1, 1.0);

  // Car B (Slot 7): 0G QE Roll probe facing forward in mid-air
  physics.setCarCollisionMask?.(PROBE_QE_SLOT, false, false);
  physics.setCarState?.(PROBE_QE_SLOT, {
    pos: [coords.qePos.x, coords.qePos.y, coords.qePos.z],
    forward: [1, 0, 0],
    right: [0, 1, 0],
    up: [0, 0, 1],
    vel: [0, 0, 0],
    angVel: [0, 0, 0],
    boost: 100,
    isOnGround: false,
  });
  physics.setCarLinearFactorAndGravity?.(PROBE_QE_SLOT, 0, 0, 0, 0.0);

  return createProbeControllerState(baseZ, peakZ, offsetX, offsetY, offsetZ);
}

/**
 * Updates probe controller targets and repositions probes without tearing down slots.
 */
export function updateDevTestLabProbeParameters(
  physics,
  probeState,
  baseZ = 500,
  peakZ = 600,
  offsetX = 0,
  offsetY = 0,
  offsetZ = 0,
  arena = null
) {
  if (!physics || !probeState) return;
  probeState.baseZ = Number.isFinite(baseZ) ? baseZ : 500;
  probeState.peakZ = Number.isFinite(peakZ) ? peakZ : 600;
  probeState.offsetX = Number.isFinite(offsetX) ? offsetX : 0;
  probeState.offsetY = Number.isFinite(offsetY) ? offsetY : 0;
  probeState.offsetZ = Number.isFinite(offsetZ) ? offsetZ : 0;
  probeState.effectiveBaseZ = probeState.baseZ + probeState.offsetZ;
  probeState.effectivePeakZ = probeState.peakZ + probeState.offsetZ;

  const coords = getProbeSpawnCoordinates(
    probeState.baseZ,
    probeState.offsetX,
    probeState.offsetY,
    probeState.offsetZ
  );

  if (physics.numCars > PROBE_BOOST_SLOT) {
    physics.setCarState?.(PROBE_BOOST_SLOT, {
      pos: [coords.boostPos.x, coords.boostPos.y, coords.boostPos.z],
      forward: [0, 0, 1],
      right: [0, 1, 0],
      up: [-1, 0, 0],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      boost: 100,
      isOnGround: false,
    });
    probeState.phase = 'CLIMB_TO_PEAK';
    probeState.holdCounter = 0;
    probeState.lastZ = coords.boostPos.z;
    probeState.lastVz = 0;
    arena?.resetCarBoosts?.(PROBE_BOOST_SLOT);
  }

  if (physics.numCars > PROBE_QE_SLOT) {
    const qeView = physics.getCarStateView?.(PROBE_QE_SLOT);
    physics.setCarState?.(PROBE_QE_SLOT, {
      pos: [coords.qePos.x, coords.qePos.y, coords.qePos.z],
      forward: qeView ? [qeView.fwdX, qeView.fwdY, qeView.fwdZ] : [1, 0, 0],
      right: qeView ? [qeView.rightX, qeView.rightY, qeView.rightZ] : [0, 1, 0],
      up: qeView ? [qeView.upX, qeView.upY, qeView.upZ] : [0, 0, 1],
      vel: [0, 0, 0],
      angVel: qeView ? [qeView.angVelX, qeView.angVelY, qeView.angVelZ] : [0, 0, 0],
      boost: 100,
      isOnGround: false,
    });
    arena?.resetCarBoosts?.(PROBE_QE_SLOT);
  }
}

/**
 * Completely removes all probe/filler cars (Slots 1..7) from the WASM physics engine,
 * resets their world-space boost trail particles, and hides their Three.js meshes
 * so they never linger or respawn on kickoff.
 */
export function parkDevTestLabProbes(physics, arena) {
  if (!physics) return;
  for (let slot = 1; slot < 8; slot++) {
    if (slot < physics.numCars) {
      physics.setCarLinearFactorAndGravity?.(slot, 1, 1, 1, 1);
      physics.setCarCollisionMask?.(slot, true, true);
      physics.setControls?.(slot, {
        throttle: 0,
        steer: 0,
        pitch: 0,
        yaw: 0,
        roll: 0,
        jump: false,
        boost: false,
        handbrake: false,
      });
    }
    if (arena?.cars?.[slot]) {
      arena.cars[slot].visible = false;
    }
    arena?.resetCarBoosts?.(slot);
    arena?.carDemolitions?.[slot]?.stop?.();
  }
  while (physics.numCars > 1) {
    physics.removeCar(physics.numCars - 1);
  }
}

export function stepDevTestLabProbes(physics, probeState) {
  if (!physics || !probeState || physics.numCars <= PROBE_QE_SLOT) return null;

  const coords = getProbeSpawnCoordinates(
    probeState.baseZ,
    probeState.offsetX,
    probeState.offsetY,
    probeState.offsetZ
  );
  const boostView = physics.getCarStateView(PROBE_BOOST_SLOT);
  const qeView = physics.getCarStateView(PROBE_QE_SLOT);
  if (!boostView || !qeView) return null;

  probeState.tickCounter++;
  const curZ = boostView.posZ;
  const curVz = boostView.velZ;
  probeState.lastZ = curZ;
  probeState.lastVz = curVz;

  // Keep fuel full
  boostView.boost = 100;
  qeView.boost = 100;

  // If Car 6's nose ever tilts away from straight up (+Z) or XY drifts, re-align its XY/orientation while preserving Z & Vz
  if (
    boostView.fwdZ < 0.995 ||
    Math.abs(boostView.posX - coords.boostPos.x) > 5 ||
    Math.abs(boostView.posY - coords.boostPos.y) > 5
  ) {
    physics.setCarState?.(PROBE_BOOST_SLOT, {
      pos: [coords.boostPos.x, coords.boostPos.y, curZ],
      forward: [0, 0, 1],
      right: [0, 1, 0],
      up: [-1, 0, 0],
      vel: [0, 0, curVz],
      angVel: [0, 0, 0],
      boost: 100,
      isOnGround: false,
    });
  }

  // Keep Car 7 anchored at its offset XYZ coordinate
  if (
    Math.abs(qeView.posX - coords.qePos.x) > 5 ||
    Math.abs(qeView.posY - coords.qePos.y) > 5 ||
    Math.abs(qeView.posZ - coords.qePos.z) > 5
  ) {
    physics.setCarState?.(PROBE_QE_SLOT, {
      pos: [coords.qePos.x, coords.qePos.y, coords.qePos.z],
      forward: [qeView.fwdX, qeView.fwdY, qeView.fwdZ],
      right: [qeView.rightX, qeView.rightY, qeView.rightZ],
      up: [qeView.upX, qeView.upY, qeView.upZ],
      vel: [0, 0, 0],
      angVel: [qeView.angVelX, qeView.angVelY, qeView.angVelZ],
      boost: 100,
      isOnGround: false,
    });
  }

  let shouldBoost = false;
  const z0 = probeState.baseZ + probeState.offsetZ;
  const z1 = probeState.peakZ + probeState.offsetZ;
  const tol = probeState.toleranceZ; // 10

  if (probeState.phase === 'CLIMB_TO_PEAK') {
    // 1. Continuously hold boost from baseZ (z0) until reaching peakZ (z1)
    if (curZ < z1) {
      shouldBoost = true;
    } else {
      shouldBoost = false;
      probeState.phase = 'FALL_BELOW_BASE';
      probeState.holdCounter = 0;
    }
  } else if (probeState.phase === 'FALL_BELOW_BASE') {
    // 2. Release boost and fall naturally under gravity until dropping below baseZ (z0)
    shouldBoost = false;
    if (curZ < z0) {
      probeState.phase = 'RECOVER_AND_HOLD';
      probeState.holdCounter = 0;
      shouldBoost = true;
    }
  } else if (probeState.phase === 'RECOVER_AND_HOLD') {
    // 3. Recover to baseZ (z0) and pulse-tap boost to hold within z0 ± 10 for 1.0s (120 ticks).
    // Energy-based stopping altitude: if we cut boost while rising (curVz > 0), gravity (650 uu/s²)
    // brings the car to rest at apexZ = curZ + curVz² / (2 * 650).
    // Cutting boost as soon as apexZ >= z0 guarantees the car decelerates to Vz = 0 right at z0
    // with zero positive-feedback overshoot!
    if (curVz > 0) {
      const coastApexZ = curZ + (curVz * curVz) / (2 * 650.0);
      shouldBoost = coastApexZ < z0;
    } else {
      // Falling or stationary: boost if below or predicted to drop below z0
      const predictedZ = curZ + curVz * 0.08;
      shouldBoost = predictedZ < z0;
    }

    if (Math.abs(curZ - z0) <= tol && Math.abs(curVz) <= 45) {
      probeState.holdCounter++;
      if (probeState.holdCounter >= probeState.targetHoldTicks) {
        // 1.0s stable hold achieved -> re-anchor cleanly at Z=z0, Vz=0 and start next climb cycle
        physics.setCarState?.(PROBE_BOOST_SLOT, {
          pos: [coords.boostPos.x, coords.boostPos.y, z0],
          forward: [0, 0, 1],
          right: [0, 1, 0],
          up: [-1, 0, 0],
          vel: [0, 0, 0],
          angVel: [0, 0, 0],
          boost: 100,
          isOnGround: false,
        });
        probeState.phase = 'CLIMB_TO_PEAK';
        probeState.holdCounter = 0;
        shouldBoost = true;
      }
    } else if (Math.abs(curZ - z0) > tol * 1.5) {
      probeState.holdCounter = 0;
    }
  }

  // Only reset on NaN / Infinity (do NOT apply artificial altitude bounds so developers can test any custom altitude)
  if (!Number.isFinite(curZ)) {
    physics.setCarState?.(PROBE_BOOST_SLOT, {
      pos: [coords.boostPos.x, coords.boostPos.y, z0],
      forward: [0, 0, 1],
      right: [0, 1, 0],
      up: [-1, 0, 0],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      boost: 100,
      isOnGround: false,
    });
    probeState.phase = 'CLIMB_TO_PEAK';
    probeState.holdCounter = 0;
  }

  const boostControls = {
    throttle: shouldBoost ? 1.0 : 0.0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jump: false,
    boost: shouldBoost,
    handbrake: false,
  };
  physics.setControls(PROBE_BOOST_SLOT, boostControls);

  // Car B (Slot 7): Q/E Roll reversal every 240 ticks (2.0s)
  const rollDir = Math.floor(probeState.tickCounter / 240) % 2 === 0 ? 1.0 : -1.0;
  probeState.rollDir = rollDir;
  const qeControls = {
    throttle: 0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: rollDir,
    jump: false,
    boost: false,
    handbrake: false,
  };
  physics.setControls(PROBE_QE_SLOT, qeControls);

  return {
    boostControls,
    qeControls,
    posX: boostView.posX,
    posY: boostView.posY,
    posZ: curZ,
    velZ: curVz,
    phase: probeState.phase,
    holdCounter: probeState.holdCounter,
    rollDir,
  };
}

