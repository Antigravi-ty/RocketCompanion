/**
 * StaticTrainingArenaHelper.js
 * Physics staging, suspension settling (60-tick silent step), shot launch, Free-Cam trajectory test,
 * and visual ball spin for StaticTrainingPackMode.
 */

import * as THREE from 'three';
import { useStaticTrainingPackStore } from '../../../stores/staticTrainingPackStore';
import { hudStore } from '../../../stores/hudStore';

export const CAR_GROUND_MIN_Z = 17.05;
export const BALL_GROUND_MIN_Z = 93.15;
export const ARENA_MAX_X = 3980;
export const ARENA_MAX_Y = 5020;
export const ARENA_MAX_Z = 1950;

export function ensureStaticTrainingSinglePlayerCar(mode) {
  const r = mode.runtime;
  const sim = r?.physics;
  if (!sim) return;

  while (sim.numCars > 1 && typeof sim.removeCar === 'function') {
    sim.removeCar(sim.numCars - 1);
  }
  if (sim.numCars < 1 && typeof sim.addCar === 'function') {
    sim.addCar(0, r.selectedHitbox || 'octane');
  }
  r.playerCarIndex = 0;
  if (r.arena) {
    r.arena.playerCarIndex = 0;
    if (r.arena.cars) {
      if (r.arena.cars[0]) {
        r.arena.cars[0].visible = true;
        r.arena.setCarTeam?.(0, 0);
      }
      for (let i = 1; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) r.arena.cars[i].visible = false;
      }
    }
  }
}

export function computeEffectiveBallAngVel(ball) {
  if (!ball.randomAngularVelocity && Array.isArray(ball.angularVelocity)) {
    return [
      Number(ball.angularVelocity[0]) || 0,
      Number(ball.angularVelocity[1]) || 0,
      Number(ball.angularVelocity[2]) || 0,
    ];
  }
  const spd = Math.max(0, Number(ball.speed) || 0);
  const mag = Math.min(5.5, Math.max(2.2, (spd / 1200) * 3.2));
  const yaw = Number(ball.speedYaw) || 0;
  const pitch = Number(ball.speedPitch) || 0;
  return [
    Number((Math.sin(yaw * 1.7 + 0.6) * mag * 0.75).toFixed(3)),
    Number((-Math.cos(yaw * 1.3 - 0.4) * mag * 0.85).toFixed(3)),
    Number((Math.sin(pitch + yaw * 0.9) * mag * 0.65).toFixed(3)),
  ];
}

export function computeLaunchVelocity(speed, yaw, pitch) {
  const s = Math.max(0, Number(speed) || 0);
  if (s <= 0.001) return [0, 0, 0];
  const cp = Math.cos(pitch);
  return [
    Math.cos(yaw) * cp * s,
    Math.sin(yaw) * cp * s,
    Math.sin(pitch) * s,
  ];
}

/**
 * Applies the shot's initial car & ball state to the arena while keeping velocities at 0
 * until the shot actually launches. If car.snapToGround is enabled, runs 60 silent physics
 * ticks to settle the vehicle's suspension before placing the ball and starting replay recording.
 */
export function applyStagedShotToArena(mode, shot, isLiveEditUpdate = false) {
  const r = mode.runtime;
  const sim = r?.physics;
  if (!sim || !shot) return;

  mode.stagedShot = shot;
  const { car, ball } = shot;
  const carLoc = car.location || car.pos || [0, -2400, CAR_GROUND_MIN_Z];
  const ballLoc = ball.location || ball.pos || [0, 0, BALL_GROUND_MIN_Z];

  const neutral = r.neutralControls || {
    throttle: 0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jump: false,
    boost: false,
    handbrake: false,
  };
  sim.setControls?.(0, neutral);
  sim.resetGoalLatch?.();
  sim.clearEvents?.();

  const boostVal = car.unlimitedBoost
    ? 100
    : Math.max(0, Math.min(100, Number(car.initialBoost) || 0));
  sim.setUnlimitedBoost?.(Boolean(car.unlimitedBoost));

  const hasFlip = Boolean(car.snapToGround || car.hasFlip !== false);

  // 1. Place Car (and settle suspension for 60 frames if snapToGround is active)
  if (car.snapToGround) {
    // Park ball high up while settling car suspension
    sim.setBallState({
      pos: [0, 0, 1850],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
    });
    sim.setCarState(0, {
      pos: [carLoc[0], carLoc[1], Math.max(CAR_GROUND_MIN_Z + 4, 24)],
      rot: [0, car.headingYaw, 0],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      boost: boostVal,
      isOnGround: true,
      hasFlipOrJump: true,
    });
    if (!isLiveEditUpdate || !mode.isLeftMouseDragging) {
      sim.stepSilent?.(60);
    }
    // Lock horizontal X/Y and yaw after suspension settling
    const settledView = sim.getCarStateView?.(0);
    const settledZ = settledView ? Math.max(CAR_GROUND_MIN_Z, settledView.posZ) : CAR_GROUND_MIN_Z;
    sim.setCarState(0, {
      pos: [carLoc[0], carLoc[1], settledZ],
      rot: [0, car.headingYaw, 0],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      boost: boostVal,
      isOnGround: true,
      hasFlipOrJump: true,
    });
  } else {
    const isGroundAlt = carLoc[2] <= CAR_GROUND_MIN_Z + 1.5;
    sim.setCarState(0, {
      pos: [carLoc[0], carLoc[1], Math.max(CAR_GROUND_MIN_Z, carLoc[2])],
      rot: [car.headingPitch, car.headingYaw, car.airRoll],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      boost: boostVal,
      isOnGround: isGroundAlt,
      hasFlipOrJump: hasFlip,
    });
  }

  // 2. Place Ball stationary at its spawn location
  mode.effectiveBallAngVel = computeEffectiveBallAngVel(ball);
  mode.kickoffBallFrozen = Boolean(ball.kickoffState);
  mode.hasBallMoved = false;

  sim.setBallState({
    pos: [ballLoc[0], ballLoc[1], Math.max(BALL_GROUND_MIN_Z, ballLoc[2])],
    vel: [0, 0, 0],
    angVel: [0, 0, 0],
  });

  mode.lastKickoffStartTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
  r.simulationStage?.resetActionStates?.();
  r.interpolator?.sync?.();
  if (!isLiveEditUpdate) {
    r.arena?.resetBallTrail?.();
    r.audioSubsystem?.resetAudio?.();
    // Start recording into replayRingBuffer immediately after the 60-frame settle
    mode.replayRingBuffer?.clear?.();
    mode.replayRingBuffer?.recordFrame?.(mode.lastKickoffStartTick, sim.state);
  }

  // 3. Compute static preview trajectory for the ball's configured launch velocity
  const launchBallVel = ball.kickoffState
    ? [0, 0, 0]
    : computeLaunchVelocity(ball.speed, ball.speedYaw, ball.speedPitch);

  if (r.ballTrajectoryPredictor) {
    r.ballTrajectoryPredictor.forcePredictAnyMovement = true;
    r.ballTrajectoryPredictor.setStaticPreviewTrajectory(sim, {
      pos: [ballLoc[0], ballLoc[1], Math.max(BALL_GROUND_MIN_Z, ballLoc[2])],
      vel: launchBallVel,
      angVel: mode.effectiveBallAngVel,
      kickoffState: ball.kickoffState,
    });
  }

  hudStore.getState().setBoost(boostVal, false, Boolean(car.unlimitedBoost));
}

/**
 * Launches the shot when countdown finishes or player provides initial driving input.
 * Note: replayRingBuffer continues recording uninterrupted from entry (after 60-frame settle).
 */
export function launchStaticTrainingShotNow(mode) {
  const r = mode.runtime;
  const sim = r?.physics;
  const shot = mode.stagedShot;
  if (!sim || !shot) return;

  const { car, ball } = shot;
  const carLoc = car.location || car.pos || [0, -2400, CAR_GROUND_MIN_Z];
  const ballLoc = ball.location || ball.pos || [0, 0, BALL_GROUND_MIN_Z];

  const effSpeedYaw =
    car.speedFollowsHeading !== false ? car.headingYaw : (car.speedYaw ?? car.headingYaw);
  const effSpeedPitch =
    car.speedFollowsHeading !== false
      ? car.snapToGround
        ? 0
        : car.headingPitch
      : (car.speedPitch ?? car.headingPitch);
  const carVel = computeLaunchVelocity(car.speed, effSpeedYaw, effSpeedPitch);
  const boostVal = car.unlimitedBoost
    ? 100
    : Math.max(0, Math.min(100, Number(car.initialBoost) || 0));
  const currentCarView = sim.getCarStateView?.(0);
  const spawnZ = currentCarView ? currentCarView.posZ : Math.max(CAR_GROUND_MIN_Z, carLoc[2]);
  const isOnGround = Boolean(car.snapToGround || spawnZ <= CAR_GROUND_MIN_Z + 2);
  const hasFlip = Boolean(car.snapToGround || car.hasFlip !== false);

  sim.setCarState(0, {
    pos: [carLoc[0], carLoc[1], spawnZ],
    rot: car.snapToGround ? [0, car.headingYaw, 0] : [car.headingPitch, car.headingYaw, car.airRoll],
    vel: carVel,
    angVel: [0, 0, 0],
    boost: boostVal,
    isOnGround,
    hasFlipOrJump: hasFlip,
  });

  mode.effectiveBallAngVel = computeEffectiveBallAngVel(ball);
  if (ball.kickoffState) {
    mode.kickoffBallFrozen = true;
    mode.hasBallMoved = false;
    sim.setBallState({
      pos: [ballLoc[0], ballLoc[1], Math.max(BALL_GROUND_MIN_Z, ballLoc[2])],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
    });
  } else {
    mode.kickoffBallFrozen = false;
    mode.hasBallMoved =
      Number(ball.speed) > 0.5 || (ballLoc[2] || 0) > BALL_GROUND_MIN_Z + 5.5;
    const ballVel = computeLaunchVelocity(ball.speed, ball.speedYaw, ball.speedPitch);
    sim.setBallState({
      pos: [ballLoc[0], ballLoc[1], Math.max(BALL_GROUND_MIN_Z, ballLoc[2])],
      vel: ballVel,
      angVel: mode.effectiveBallAngVel,
    });
  }

  const innerBallMesh = r?.arena?.ball?.children?.[0];
  if (innerBallMesh) {
    innerBallMesh.quaternion.identity();
  }

  if (r.ballTrajectoryPredictor) {
    r.ballTrajectoryPredictor.clearStaticPreview?.();
    r.ballTrajectoryPredictor.forcePredictAnyMovement = true;
  }

  mode.playPhase = 'live';

  useStaticTrainingPackStore.getState().updateLiveTelemetry({
    activeCountdownSec: 0,
    isShotLaunched: true,
  });
}

/**
 * Launches both Car and Ball in-place during [T] trajectory test
 * without starting any countdown or timeout timer.
 */
export function launchFreeCamTrajectoryPreview(mode) {
  const r = mode.runtime;
  const sim = r?.physics;
  const shot = mode.stagedShot;
  if (!sim || !shot) return;

  applyStagedShotToArena(mode, shot, true);

  const { car, ball } = shot;
  const carLoc = car.location || car.pos || [0, -2400, CAR_GROUND_MIN_Z];
  const ballLoc = ball.location || ball.pos || [0, 0, BALL_GROUND_MIN_Z];
  const effSpeedYaw =
    car.speedFollowsHeading !== false ? car.headingYaw : (car.speedYaw ?? car.headingYaw);
  const effSpeedPitch =
    car.speedFollowsHeading !== false
      ? car.snapToGround
        ? 0
        : car.headingPitch
      : (car.speedPitch ?? car.headingPitch);
  const carVel = computeLaunchVelocity(car.speed, effSpeedYaw, effSpeedPitch);
  const boostVal = car.unlimitedBoost
    ? 100
    : Math.max(0, Math.min(100, Number(car.initialBoost) || 0));
  const currentCarView = sim.getCarStateView?.(0);
  const spawnZ = currentCarView ? currentCarView.posZ : Math.max(CAR_GROUND_MIN_Z, carLoc[2]);
  const isOnGround = Boolean(car.snapToGround || spawnZ <= CAR_GROUND_MIN_Z + 2);
  const hasFlip = Boolean(car.snapToGround || car.hasFlip !== false);

  sim.setCarState(0, {
    pos: [carLoc[0], carLoc[1], spawnZ],
    rot: car.snapToGround ? [0, car.headingYaw, 0] : [car.headingPitch, car.headingYaw, car.airRoll],
    vel: carVel,
    angVel: [0, 0, 0],
    boost: boostVal,
    isOnGround,
    hasFlipOrJump: hasFlip,
  });

  mode.effectiveBallAngVel = computeEffectiveBallAngVel(ball);
  if (ball.kickoffState) {
    mode.kickoffBallFrozen = true;
    sim.setBallState({
      pos: [ballLoc[0], ballLoc[1], Math.max(BALL_GROUND_MIN_Z, ballLoc[2])],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
    });
  } else {
    mode.kickoffBallFrozen = false;
    const ballVel = computeLaunchVelocity(ball.speed, ball.speedYaw, ball.speedPitch);
    sim.setBallState({
      pos: [ballLoc[0], ballLoc[1], Math.max(BALL_GROUND_MIN_Z, ballLoc[2])],
      vel: ballVel,
      angVel: mode.effectiveBallAngVel,
    });
  }

  const innerBallMesh = r?.arena?.ball?.children?.[0];
  if (innerBallMesh) {
    innerBallMesh.quaternion.identity();
  }

  if (r.ballTrajectoryPredictor) {
    r.ballTrajectoryPredictor.clearStaticPreview?.();
    r.ballTrajectoryPredictor.forcePredictAnyMovement = true;
  }
}

const _spinAxis = new THREE.Vector3();
const _spinDeltaQuat = new THREE.Quaternion();

export function spinBallMeshInPlace(mode, dt) {
  const r = mode.runtime;
  const ballGroup = r?.arena?.ball;
  if (!ballGroup || !mode.stagedShot) return;

  // Rotate inner Classic Ball mesh (children[0]) so PresentationStage's outer Group
  // physics quaternion interpolation does not overwrite the stationary visual spin.
  const targetMesh = ballGroup.children?.[0] || ballGroup;
  const [wx, wy, wz] = mode.effectiveBallAngVel || [0, 0, 0];
  const safeDt = Math.min(0.05, dt || 0.016);
  // RocketSim (wx, wy, wz) -> Three.js axis (wx, wz, wy)
  const angSpeed = Math.hypot(wx, wy, wz);
  if (angSpeed > 1e-4) {
    _spinAxis.set(wx / angSpeed, wz / angSpeed, wy / angSpeed);
    _spinDeltaQuat.setFromAxisAngle(_spinAxis, angSpeed * safeDt);
    targetMesh.quaternion.premultiply(_spinDeltaQuat);
  }
}
