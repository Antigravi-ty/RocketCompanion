/**
 * RLRCInverseControlKinematicsPipeline.ts
 * Frame-to-frame inverse control inference for boost, handbrake, component active flags,
 * and continuous analog controls (throttle, steer, pitch, yaw, roll) at 120Hz.
 */

import {
  RLRC_FIXED_DT,
  type RLRCCarComponentActiveFlags,
  type RLRCCarFrameState120Hz,
  type RLRCSynthesizedCarControls,
} from '../RLRCReplayTypes.ts';
import {
  AERIAL_DAMPING_PITCH,
  AERIAL_DAMPING_ROLL,
  AERIAL_DAMPING_YAW,
  AERIAL_TORQUE_PITCH,
  AERIAL_TORQUE_ROLL,
  AERIAL_TORQUE_YAW,
  applyDeadzone,
  BOOST_ACCEL_AIR_UU,
  BOOST_ACCEL_GROUND_UU,
  BRAKE_DECEL_GROUND_UU,
  clampUnit,
  COAST_DECEL_GROUND_UU,
  computeFrameKinematics,
  distVec3,
  evaluateGroundSteerCurvature,
  evaluateGroundThrottleMaxAccel,
  NEUTRAL_ACTIVE_FLAGS,
  NEUTRAL_SYNTHESIZED_CONTROLS,
  solveAerialAxisWithDamping,
  THROTTLE_AIR_ACCEL_UU,
  type FrameKinematicsSample,
} from './RLRCCarKinematicsMathPipeline.ts';

export interface RLRCControlSynthesisOptions {
  readonly dtSeconds?: number;
  readonly preferReplicatedGroundControls?: boolean;
  readonly smoothWindowRadius?: 0 | 1 | 2;
  readonly deadzone?: number;
}

export function inferBoostStateFromKinematics(
  prevCar: RLRCCarFrameState120Hz | null | undefined,
  currCar: RLRCCarFrameState120Hz,
  nextCar: RLRCCarFrameState120Hz | null | undefined,
  kin: FrameKinematicsSample,
  dt: number
): boolean {
  const hasReserve =
    currCar.boostAmount > 0.05 || Boolean(prevCar?.entityActive && prevCar.boostAmount > 0.15);
  if (!hasReserve) return false;
  if (currCar.activeFlags.boostActive || currCar.controls.boost) return true;

  if (!kin.teleported && prevCar?.entityActive) {
    const singleDrop = prevCar.boostAmount - currCar.boostAmount;
    const dropRate = singleDrop / Math.max(dt, 1e-4);
    if (singleDrop > 0 && singleDrop <= 6.0 && dropRate >= 8.5 && dropRate <= 120.0) return true;
  }
  if (
    !kin.teleported &&
    prevCar?.entityActive &&
    nextCar?.entityActive &&
    distVec3(nextCar.rigidBody.position, currCar.rigidBody.position) <= 360
  ) {
    const spanDrop = prevCar.boostAmount - nextCar.boostAmount;
    const spanRate = spanDrop / Math.max(2 * dt, 1e-4);
    if (spanDrop > 0 && spanDrop <= 10.0 && spanRate >= 8.5 && spanRate <= 120.0) return true;
  }
  if (currCar.isOnGround) {
    const maxDrive = evaluateGroundThrottleMaxAccel(Math.abs(kin.localForwardVel));
    return (
      currCar.boostAmount > 0.5 &&
      kin.localForwardVel > 100 &&
      kin.nonGravityForwardAccel > maxDrive + 520
    );
  }
  const kinDodgeImpulse =
    kin.angAccelMag > 18.0 &&
    kin.flipOmegaMag > 3.5 &&
    (kin.planarAccelMag > 1350 || kin.angAccelMag > 25.0);
  return (
    currCar.boostAmount > 0.5 &&
    !currCar.activeFlags.dodgeActive &&
    !kinDodgeImpulse &&
    kin.nonGravityForwardAccel > 560
  );
}

export function inferHandbrakeFromKinematics(
  prevCar: RLRCCarFrameState120Hz | null | undefined,
  currCar: RLRCCarFrameState120Hz,
  kin: FrameKinematicsSample,
  synthesizedRoll: number,
  framesSinceLanding = 999
): boolean {
  const repHandbrake = Boolean(currCar.controls.handbrake);
  if (!currCar.isOnGround) return repHandbrake && Math.abs(synthesizedRoll) > 0.22;
  if (repHandbrake) return true;

  if (kin.planarSpeed > 180) {
    const slipRatio = Math.abs(kin.localRightVel) / kin.planarSpeed;
    if (slipRatio > 0.22 && (Math.abs(kin.omegaYaw) > 0.85 || Math.abs(kin.localRightVel) > 155)) {
      return true;
    }
    if (
      (framesSinceLanding <= 12 || (prevCar?.entityActive && !prevCar.isOnGround)) &&
      kin.planarSpeed > 200 &&
      slipRatio > 0.16
    ) {
      return true;
    }
  }
  if (kin.planarSpeed > 140 && Math.abs(kin.omegaYaw) > 1.5) {
    const maxSteerYaw =
      evaluateGroundSteerCurvature(kin.planarSpeed) * Math.abs(kin.localForwardVel);
    if (Math.abs(kin.omegaYaw) > maxSteerYaw * 1.25 + 0.35) return true;
  }
  return false;
}

export function synthesizeCarActiveFlagsBetweenFrames(
  prevCar: RLRCCarFrameState120Hz | null | undefined,
  currCar: RLRCCarFrameState120Hz,
  nextCar?: RLRCCarFrameState120Hz | null,
  options?: RLRCControlSynthesisOptions
): RLRCCarComponentActiveFlags {
  if (!currCar.entityActive) return NEUTRAL_ACTIVE_FLAGS;

  const dt = Math.max(1e-4, options?.dtSeconds ?? RLRC_FIXED_DT);
  const kin = computeFrameKinematics(prevCar, currCar, nextCar, dt);
  const boostActive = inferBoostStateFromKinematics(prevCar, currCar, nextCar, kin, dt);

  if (currCar.isOnGround) {
    const rawJumpRising =
      currCar.activeFlags.jumpActive && !(prevCar?.entityActive && prevCar.activeFlags.jumpActive);
    const liftingOffNext =
      Boolean(nextCar?.entityActive && !nextCar.isOnGround) &&
      kin.basis.up.z > 0.25 &&
      (kin.localUpVel > 130 || kin.nonGravityUpAccel > 550);
    return {
      boostActive,
      jumpActive: rawJumpRising || liftingOffNext,
      doubleJumpActive: false,
      dodgeActive: false,
    };
  }

  const airTime = Math.max(0, currCar.airTimeSinceJump);
  const prevGrounded = Boolean(prevCar?.entityActive && prevCar.isOnGround);
  const prevRawJump = Boolean(prevCar?.entityActive && prevCar.activeFlags.jumpActive);
  const prevRawDj = Boolean(prevCar?.entityActive && prevCar.activeFlags.doubleJumpActive);
  const prevRawDodge = Boolean(prevCar?.entityActive && prevCar.activeFlags.dodgeActive);

  const rawDodgeValid =
    currCar.activeFlags.dodgeActive && (!prevRawDodge || (!prevGrounded && airTime <= 0.72));
  const kinDodge =
    airTime >= 0.035 &&
    airTime <= 1.45 &&
    kin.angAccelMag > 18.0 &&
    kin.flipOmegaMag > 3.5 &&
    (kin.planarAccelMag > 1350 || kin.angAccelMag > 25.0);
  const dodgeActive = rawDodgeValid || kinDodge;

  const netUpImpulseAccel =
    kin.nonGravityUpAccel -
    (boostActive ? BOOST_ACCEL_AIR_UU * Math.max(0, kin.basis.forward.z) : 0);
  const rawDjValid =
    !dodgeActive &&
    currCar.activeFlags.doubleJumpActive &&
    (!prevRawDj || (!prevGrounded && airTime <= 0.35));
  const kinDj =
    !dodgeActive &&
    airTime >= 0.045 &&
    airTime <= 1.45 &&
    netUpImpulseAccel > 1050 &&
    kin.localUpVel > 150 &&
    kin.flipOmegaMag < 3.4;
  const doubleJumpActive = rawDjValid || kinDj;

  const rawJumpValid =
    currCar.activeFlags.jumpActive &&
    (!prevRawJump || (!prevGrounded && airTime <= 0.21) || (prevGrounded && kin.localUpVel > 90));
  const kinLiftoffJump =
    (prevGrounded && kin.basis.up.z > 0.25 && (kin.localUpVel > 135 || netUpImpulseAccel > 600)) ||
    (airTime > 0 && airTime <= 0.2 && netUpImpulseAccel > 550 && kin.localUpVel > 120);
  const jumpActive =
    !dodgeActive && !doubleJumpActive && airTime <= 0.22 && (rawJumpValid || kinLiftoffJump);

  return {
    boostActive: dodgeActive && !currCar.activeFlags.boostActive ? false : boostActive,
    jumpActive,
    doubleJumpActive,
    dodgeActive,
  };
}

export function synthesizeCarControlsBetweenFrames(
  prevCar: RLRCCarFrameState120Hz | null | undefined,
  currCar: RLRCCarFrameState120Hz,
  nextCar?: RLRCCarFrameState120Hz | null,
  options?: RLRCControlSynthesisOptions
): RLRCSynthesizedCarControls {
  if (!currCar.entityActive) return NEUTRAL_SYNTHESIZED_CONTROLS;

  const dt = Math.max(1e-4, options?.dtSeconds ?? RLRC_FIXED_DT);
  const preferReplicated = options?.preferReplicatedGroundControls ?? true;
  const deadzone = options?.deadzone ?? 0.04;

  const kin = computeFrameKinematics(prevCar, currCar, nextCar, dt);
  const flags = synthesizeCarActiveFlagsBetweenFrames(prevCar, currCar, nextCar, options);
  const boost = flags.boostActive;
  const prevFlags = prevCar?.entityActive
    ? synthesizeCarActiveFlagsBetweenFrames(null, prevCar, currCar, options)
    : NEUTRAL_ACTIVE_FLAGS;
  const jump =
    flags.jumpActive ||
    (flags.dodgeActive && !prevFlags.dodgeActive) ||
    (flags.doubleJumpActive && !prevFlags.doubleJumpActive);

  let throttle = 0;
  let steer = 0;
  let pitch = 0;
  let yaw = 0;
  let roll = 0;

  if (currCar.isOnGround) {
    const netDriveAccel = kin.nonGravityForwardAccel - (boost ? BOOST_ACCEL_GROUND_UU : 0);
    if (preferReplicated && Math.abs(currCar.controls.throttle) > 0.01) {
      throttle = clampUnit(currCar.controls.throttle);
    } else if (boost) {
      throttle = 1;
    } else if (
      Math.abs(kin.localForwardVel) > 40 &&
      kin.localForwardVel * netDriveAccel < 0 &&
      Math.abs(netDriveAccel) > COAST_DECEL_GROUND_UU * 1.65
    ) {
      throttle =
        -Math.sign(kin.localForwardVel) *
        Math.min(1, Math.abs(netDriveAccel) / BRAKE_DECEL_GROUND_UU);
    } else {
      const maxDriveAccel = evaluateGroundThrottleMaxAccel(Math.abs(kin.localForwardVel));
      if (maxDriveAccel > 60) {
        throttle = applyDeadzone(netDriveAccel / maxDriveAccel, deadzone);
      } else if (Math.abs(kin.localForwardVel) > 1380 && netDriveAccel > -200) {
        throttle = Math.sign(kin.localForwardVel);
      }
    }

    if (preferReplicated && Math.abs(currCar.controls.steer) > 0.01) {
      steer = clampUnit(currCar.controls.steer);
    } else if (Math.abs(kin.localForwardVel) > 25) {
      const expectedMaxYawRate = Math.max(
        0.15,
        evaluateGroundSteerCurvature(kin.planarSpeed) * Math.abs(kin.localForwardVel)
      );
      steer = applyDeadzone(
        (kin.omegaYaw * (kin.localForwardVel >= 0 ? 1 : -1)) / expectedMaxYawRate,
        deadzone
      );
    }
  } else {
    pitch = applyDeadzone(
      solveAerialAxisWithDamping(
        kin.alphaPitch,
        kin.omegaPitch,
        AERIAL_TORQUE_PITCH,
        AERIAL_DAMPING_PITCH
      ),
      deadzone
    );
    yaw = applyDeadzone(
      solveAerialAxisWithDamping(kin.alphaYaw, kin.omegaYaw, AERIAL_TORQUE_YAW, AERIAL_DAMPING_YAW),
      deadzone
    );
    roll = applyDeadzone(
      solveAerialAxisWithDamping(
        kin.alphaRoll,
        kin.omegaRoll,
        AERIAL_TORQUE_ROLL,
        AERIAL_DAMPING_ROLL
      ),
      deadzone
    );

    if (preferReplicated && Math.abs(currCar.controls.throttle) > 0.01) {
      throttle = clampUnit(currCar.controls.throttle);
    } else if (boost) {
      throttle = 1;
    } else {
      throttle = applyDeadzone(
        (kin.nonGravityForwardAccel - (boost ? BOOST_ACCEL_AIR_UU : 0)) / THROTTLE_AIR_ACCEL_UU,
        0.15
      );
    }

    steer =
      preferReplicated && Math.abs(currCar.controls.steer) > 0.01
        ? clampUnit(currCar.controls.steer)
        : yaw;
  }

  return {
    throttle,
    steer,
    pitch,
    yaw,
    roll,
    jump,
    boost,
    handbrake: inferHandbrakeFromKinematics(prevCar, currCar, kin, roll),
  };
}
