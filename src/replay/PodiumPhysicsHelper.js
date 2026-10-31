/**
 * PodiumPhysicsHelper.js
 * Worker-pure Post-Match Podium formation placement and horizontal axis locking helpers.
 *
 * Uses C++ native `_physics_setCarLinearFactorAndGravity(carIndex, 0, 0, 1, 1)` to lock
 * X/Y translation on podium pedestals while preserving Z-axis jumping, boosting,
 * double-jumping, dodging, and full 3D aerial rotations.
 */

import {
  SIM_OFFSETS,
  CAR_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  MAX_CARS
} from '../physics/RocketSimConstants.js';

/**
 * Symmetrical V-formation podium spots near midfield facing the Podium Showcase camera (-Y).
 * Winners occupy the front row (indices 0..2), runners-up occupy the back flanking row (indices 3..5).
 */
export const PODIUM_FORMATION_SPOTS = Object.freeze([
  // Front Center (Winner MVP / Slot 0)
  { x: 0.0, y: -180.0, z: 17.05, yaw: -Math.PI * 0.5 },
  // Front Left (Winner Slot 1)
  { x: -210.0, y: -60.0, z: 17.05, yaw: -Math.PI * 0.42 },
  // Front Right (Winner Slot 2)
  { x: 210.0, y: -60.0, z: 17.05, yaw: -Math.PI * 0.58 },
  // Back Center-Left (Runner-up Slot 0)
  { x: -130.0, y: 180.0, z: 17.05, yaw: -Math.PI * 0.46 },
  // Back Center-Right (Runner-up Slot 1)
  { x: 130.0, y: 180.0, z: 17.05, yaw: -Math.PI * 0.54 },
  // Back Outer (Runner-up Slot 2)
  { x: 0.0, y: 310.0, z: 17.05, yaw: -Math.PI * 0.5 }
]);

export const PODIUM_CAMERA_POSE = Object.freeze({
  eyeX: 0.0,
  eyeY: -640.0,
  eyeZ: 115.0,
  targetX: 0.0,
  targetY: -40.0,
  targetZ: 55.0
});

/**
 * Places all active cars onto Podium Showcase pedestals, refills boost to 100,
 * parks the ball out of the podium view, and locks horizontal X/Y translation
 * via `engine.setCarLinearFactorAndGravity(carIndex, 0, 0, 1, 1)`.
 *
 * @param {import('../physics/RocketSimPhysicsEngine.js').RocketSimPhysicsEngine} engine
 * @param {number} [winningTeam=0] - 0: Blue, 1: Orange, 2: Draw
 * @returns {boolean}
 */
export function applyPodiumFormationToEngine(engine, winningTeam = 0, carTeamResolver = null) {
  if (!engine) return false;

  const numCars = Math.min(engine.numCars || 0, MAX_CARS);
  if (numCars <= 0) return false;

  // Park ball far behind the camera so it does not obstruct the podium showcase
  if (typeof engine.setBallState === 'function') {
    const parkedBall = new Float32Array([
      0.0, -3200.0, 93.15,
      1.0, 0.0, 0.0,
      0.0, 1.0, 0.0,
      0.0, 0.0, 1.0,
      0.0, 0.0, 0.0,
      0.0, 0.0, 0.0
    ]);
    engine.setBallState(parkedBall);
  }

  let winnerCursor = 0;
  let runnerUpCursor = 3;
  const assignedSpots = new Map();

  for (let c = 0; c < numCars; c++) {
    const carTeam = typeof carTeamResolver === 'function' ? carTeamResolver(c) : (c % 2);
    const isWinnerCar = winningTeam === 2 || carTeam === winningTeam;
    const spotIdx = isWinnerCar
      ? Math.min(2, winnerCursor++)
      : Math.min(PODIUM_FORMATION_SPOTS.length - 1, runnerUpCursor++);
    const spot = PODIUM_FORMATION_SPOTS[spotIdx] || PODIUM_FORMATION_SPOTS[0];
    assignedSpots.set(c, spot);

    const cosYaw = Math.cos(spot.yaw);
    const sinYaw = Math.sin(spot.yaw);

    // Right-handed basis in Unreal coordinates (X right, Y forward, Z up)
    const carState = new Float32Array(CAR_STATE_STRIDE);
    carState[CAR_STATE_OFFSETS.POS] = spot.x;
    carState[CAR_STATE_OFFSETS.POS + 1] = spot.y;
    carState[CAR_STATE_OFFSETS.POS + 2] = spot.z;

    // Forward vector
    carState[CAR_STATE_OFFSETS.FWD] = cosYaw;
    carState[CAR_STATE_OFFSETS.FWD + 1] = sinYaw;
    carState[CAR_STATE_OFFSETS.FWD + 2] = 0.0;

    // Right vector
    carState[CAR_STATE_OFFSETS.RIGHT] = -sinYaw;
    carState[CAR_STATE_OFFSETS.RIGHT + 1] = cosYaw;
    carState[CAR_STATE_OFFSETS.RIGHT + 2] = 0.0;

    // Up vector
    carState[CAR_STATE_OFFSETS.UP] = 0.0;
    carState[CAR_STATE_OFFSETS.UP + 1] = 0.0;
    carState[CAR_STATE_OFFSETS.UP + 2] = 1.0;

    // Zero linear & angular velocities, full boost, grounded
    carState[CAR_STATE_OFFSETS.BOOST] = 100.0;
    carState[CAR_STATE_OFFSETS.ON_GROUND] = 1.0;
    carState[CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = 1.0;

    if (typeof engine.setCarState === 'function') {
      engine.setCarState(c, carState);
    }
    if (typeof engine.setCarLinearFactorAndGravity === 'function') {
      // Lock horizontal X/Y translation on podium pedestals while preserving Z-axis jumping and aerial spins
      engine.setCarLinearFactorAndGravity(c, 0.0, 0.0, 1.0, 1.0);
    }
  }

  engine._podiumCarSpots = assignedSpots;

  if (typeof engine.setUnlimitedBoost === 'function') {
    engine.setUnlimitedBoost(true);
  }
  if (typeof engine.setSimulationFrozen === 'function') {
    engine.setSimulationFrozen(false, 0, false);
  }

  return true;
}

/**
 * Restores normal 3D translation and gravity (`1, 1, 1, 1`) on all cars when leaving the podium.
 *
 * @param {import('../physics/RocketSimPhysicsEngine.js').RocketSimPhysicsEngine} engine
 */
export function releasePodiumLocksOnEngine(engine) {
  if (!engine) return;
  if (typeof engine.setCarLinearFactorAndGravity === 'function') {
    const numCars = Math.min(engine.numCars || 0, MAX_CARS);
    for (let c = 0; c < numCars; c++) {
      engine.setCarLinearFactorAndGravity(c, 1.0, 1.0, 1.0, 1.0);
    }
  }
  if (engine.state) {
    const numCars = Math.min(engine.numCars || 0, MAX_CARS);
    for (let c = 0; c < numCars; c++) {
      const base = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      if (base + CAR_STATE_STRIDE <= engine.state.length) {
        engine.state[base + CAR_STATE_OFFSETS.VEL] = 0;
        engine.state[base + CAR_STATE_OFFSETS.VEL + 1] = 0;
        engine.state[base + CAR_STATE_OFFSETS.VEL + 2] = 0;
        engine.state[base + CAR_STATE_OFFSETS.ANG_VEL] = 0;
        engine.state[base + CAR_STATE_OFFSETS.ANG_VEL + 1] = 0;
        engine.state[base + CAR_STATE_OFFSETS.ANG_VEL + 2] = 0;
        engine.state[base + CAR_STATE_OFFSETS.IS_JUMPING] = 0;
        engine.state[base + CAR_STATE_OFFSETS.IS_FLIPPING] = 0;
        engine.state[base + CAR_STATE_OFFSETS.IS_BOOSTING] = 0;
        engine.state[base + CAR_STATE_OFFSETS.IS_SUPERSONIC] = 0;
      }
    }
  }
  engine._podiumCarSpots = null;
}
