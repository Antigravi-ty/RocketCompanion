import {
  RLRC_FIXED_DT,
  type RLRCCarComponentActiveFlags,
  type RLRCCarFrameState120Hz,
  type RLRCQuat,
  type RLRCSynthesizedCarControls,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export interface RLRCControlSynthesisOptions {
  readonly dtSeconds?: number;
  readonly preferReplicatedGroundControls?: boolean;
  readonly smoothWindowRadius?: 0 | 1 | 2;
  readonly deadzone?: number;
}

export interface RLRCLocalCarBasis {
  readonly forward: RLRCVec3;
  readonly right: RLRCVec3;
  readonly up: RLRCVec3;
}

export interface FrameKinematicsSample {
  readonly basis: RLRCLocalCarBasis;
  readonly localForwardVel: number;
  readonly localRightVel: number;
  readonly localUpVel: number;
  readonly planarSpeed: number;
  readonly nonGravityForwardAccel: number;
  readonly nonGravityUpAccel: number;
  readonly planarAccelMag: number;
  readonly omegaRoll: number;
  readonly omegaPitch: number;
  readonly omegaYaw: number;
  readonly flipOmegaMag: number;
  readonly alphaRoll: number;
  readonly alphaPitch: number;
  readonly alphaYaw: number;
  readonly angAccelMag: number;
  readonly teleported: boolean;
}

export const GRAVITY_Z_UU = -650.0;
export const BOOST_ACCEL_GROUND_UU = 991.666;
export const BOOST_ACCEL_AIR_UU = 1058.333;
export const THROTTLE_AIR_ACCEL_UU = 66.667;
export const BRAKE_DECEL_GROUND_UU = 3500.0;
export const COAST_DECEL_GROUND_UU = 525.0;

const AERIAL_TORQUE_ROLL = -36.07956616966136;
const AERIAL_TORQUE_PITCH = -12.1459978190807;
const AERIAL_TORQUE_YAW = 8.91962804287785;
const AERIAL_DAMPING_ROLL = -4.47166302201591;
const AERIAL_DAMPING_PITCH = -2.798194258050845;
const AERIAL_DAMPING_YAW = -1.886491900437232;

export const NEUTRAL_SYNTHESIZED_CONTROLS: RLRCSynthesizedCarControls = Object.freeze({
  throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false,
});

export const NEUTRAL_ACTIVE_FLAGS: RLRCCarComponentActiveFlags = Object.freeze({
  boostActive: false, jumpActive: false, doubleJumpActive: false, dodgeActive: false,
});

export const clampUnit = (v: number): number => (!Number.isFinite(v) ? 0 : v <= -1 ? -1 : v >= 1 ? 1 : v);
export const applyDeadzone = (v: number, dz: number): number => {
  const c = clampUnit(v);
  return Math.abs(c) < dz ? 0 : c;
};
export const dotVec3 = (a: RLRCVec3, b: RLRCVec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const distVec3 = (a: RLRCVec3, b: RLRCVec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function decodeReplicatedThrottleByte(byteValue: number | null | undefined): number {
  if (typeof byteValue !== 'number' || !Number.isFinite(byteValue)) return 0;
  const b = Math.max(0, Math.min(255, Math.round(byteValue)));
  return b === 128 ? 0 : clampUnit((b - 128) / 127);
}

export function decodeReplicatedSteerByte(byteValue: number | null | undefined): number {
  if (typeof byteValue !== 'number' || !Number.isFinite(byteValue)) return 0;
  const b = Math.max(0, Math.min(255, Math.round(byteValue)));
  return b === 128 ? 0 : clampUnit((b - 128) / 127);
}

export function decodeReplicatedActiveFlagByte(byteValue: number | null | undefined): boolean {
  if (typeof byteValue !== 'number' || !Number.isFinite(byteValue)) return false;
  return (Math.trunc(byteValue) & 1) === 1;
}

export function computeLocalCarBasisFromQuat(rotation: RLRCQuat): RLRCLocalCarBasis {
  const { x, y, z, w } = rotation;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return {
    forward: { x: 1 - 2 * (yy + zz), y: 2 * (xy + wz), z: 2 * (xz - wy) },
    right: { x: 2 * (xy - wz), y: 1 - 2 * (xx + zz), z: 2 * (yz + wx) },
    up: { x: 2 * (xz + wy), y: 2 * (yz - wx), z: 1 - 2 * (xx + yy) },
  };
}

export function evaluateGroundThrottleMaxAccel(forwardSpeedAbs: number): number {
  const s = Math.max(0, forwardSpeedAbs);
  if (s >= 1410) return 0;
  if (s >= 1400) return 160 * (1 - (s - 1400) / 10);
  return 1600 - (1440 * s) / 1400;
}

export function evaluateGroundSteerCurvature(speedAbs: number): number {
  const s = Math.max(0, speedAbs);
  if (s < 500) return 0.0069 - (s / 500) * (0.0069 - 0.00398);
  if (s < 1000) return 0.00398 - ((s - 500) / 500) * (0.00398 - 0.00235);
  if (s < 1500) return 0.00235 - ((s - 1000) / 500) * (0.00235 - 0.001375);
  if (s < 1750) return 0.001375 - ((s - 1500) / 250) * (0.001375 - 0.0011);
  if (s < 3000) return 0.0011 - ((s - 1750) / 1250) * (0.0011 - 0.00088);
  return 0.00088;
}

function solveAerialAxisWithDamping(angAccel: number, angVel: number, torqueScale: number, dampingScale: number): number {
  const netTorque = angAccel - dampingScale * angVel;
  const rawControl = netTorque / torqueScale;
  const denom = torqueScale - (rawControl >= 0 ? 1 : -1) * dampingScale * angVel;
  return Math.abs(denom) < Math.abs(torqueScale) * 0.35 ? clampUnit(rawControl) : clampUnit(netTorque / denom);
}

export function computeFrameKinematics(
  prevCar: RLRCCarFrameState120Hz | null | undefined,
  currCar: RLRCCarFrameState120Hz,
  nextCar: RLRCCarFrameState120Hz | null | undefined,
  dt: number
): FrameKinematicsSample {
  const pOk = Boolean(prevCar?.entityActive) && distVec3(prevCar!.rigidBody.position, currCar.rigidBody.position) <= 360;
  const nOk = Boolean(nextCar?.entityActive) && distVec3(nextCar!.rigidBody.position, currCar.rigidBody.position) <= 360;
  const teleported = Boolean(prevCar?.entityActive) && !pOk;
  const r0 = (pOk ? prevCar! : currCar).rigidBody;
  const r1 = (nOk ? nextCar! : currCar).rigidBody;
  const ticks = (pOk ? 1 : 0) + (nOk ? 1 : 0);
  const invDt = ticks > 0 ? 1 / (ticks * dt) : 0;

  const basis = computeLocalCarBasisFromQuat(currCar.rigidBody.rotation);
  const v = currCar.rigidBody.linearVelocity, w = currCar.rigidBody.angularVelocity;
  const aLin: RLRCVec3 = {
    x: (r1.linearVelocity.x - r0.linearVelocity.x) * invDt,
    y: (r1.linearVelocity.y - r0.linearVelocity.y) * invDt,
    z: (r1.linearVelocity.z - r0.linearVelocity.z) * invDt,
  };
  const aAng: RLRCVec3 = {
    x: (r1.angularVelocity.x - r0.angularVelocity.x) * invDt,
    y: (r1.angularVelocity.y - r0.angularVelocity.y) * invDt,
    z: (r1.angularVelocity.z - r0.angularVelocity.z) * invDt,
  };

  const localForwardVel = dotVec3(v, basis.forward);
  const localRightVel = dotVec3(v, basis.right);
  const localUpVel = dotVec3(v, basis.up);
  const planarSpeed = Math.hypot(localForwardVel, localRightVel);
  const nonGravityForwardAccel = dotVec3(aLin, basis.forward) - GRAVITY_Z_UU * basis.forward.z;
  const nonGravityUpAccel = dotVec3(aLin, basis.up) - GRAVITY_Z_UU * basis.up.z;
  const planarAccelMag = Math.hypot(aLin.x, aLin.y);

  const omegaRoll = dotVec3(w, basis.forward);
  const omegaPitch = dotVec3(w, basis.right);
  const omegaYaw = dotVec3(w, basis.up);
  const flipOmegaMag = Math.hypot(omegaPitch, omegaRoll, omegaYaw * 0.65);

  const alphaRoll = dotVec3(aAng, basis.forward);
  const alphaPitch = dotVec3(aAng, basis.right);
  const alphaYaw = dotVec3(aAng, basis.up);
  const angAccelMag = Math.hypot(alphaPitch, alphaRoll, alphaYaw);

  return {
    basis, localForwardVel, localRightVel, localUpVel, planarSpeed,
    nonGravityForwardAccel, nonGravityUpAccel, planarAccelMag,
    omegaRoll, omegaPitch, omegaYaw, flipOmegaMag,
    alphaRoll, alphaPitch, alphaYaw, angAccelMag, teleported,
  };
}

export function inferBoostStateFromKinematics(
  prevCar: RLRCCarFrameState120Hz | null | undefined,
  currCar: RLRCCarFrameState120Hz,
  nextCar: RLRCCarFrameState120Hz | null | undefined,
  kin: FrameKinematicsSample,
  dt: number
): boolean {
  const hasReserve = currCar.boostAmount > 0.05 || Boolean(prevCar?.entityActive && prevCar.boostAmount > 0.15);
  if (!hasReserve) return false;
  if (currCar.activeFlags.boostActive || currCar.controls.boost) return true;

  if (!kin.teleported && prevCar?.entityActive) {
    const singleDrop = prevCar.boostAmount - currCar.boostAmount;
    const dropRate = singleDrop / Math.max(dt, 1e-4);
    if (singleDrop > 0 && singleDrop <= 6.0 && dropRate >= 8.5 && dropRate <= 120.0) return true;
  }
  if (!kin.teleported && prevCar?.entityActive && nextCar?.entityActive && distVec3(nextCar.rigidBody.position, currCar.rigidBody.position) <= 360) {
    const spanDrop = prevCar.boostAmount - nextCar.boostAmount;
    const spanRate = spanDrop / Math.max(2 * dt, 1e-4);
    if (spanDrop > 0 && spanDrop <= 10.0 && spanRate >= 8.5 && spanRate <= 120.0) return true;
  }
  if (currCar.isOnGround) {
    const maxDrive = evaluateGroundThrottleMaxAccel(Math.abs(kin.localForwardVel));
    return currCar.boostAmount > 0.5 && kin.localForwardVel > 100 && kin.nonGravityForwardAccel > maxDrive + 520;
  }
  const kinDodgeImpulse = kin.angAccelMag > 18.0 && kin.flipOmegaMag > 3.5 && (kin.planarAccelMag > 1350 || kin.angAccelMag > 25.0);
  return currCar.boostAmount > 0.5 && !currCar.activeFlags.dodgeActive && !kinDodgeImpulse && kin.nonGravityForwardAccel > 560;
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
    if (slipRatio > 0.22 && (Math.abs(kin.omegaYaw) > 0.85 || Math.abs(kin.localRightVel) > 155)) return true;
    if ((framesSinceLanding <= 12 || (prevCar?.entityActive && !prevCar.isOnGround)) && kin.planarSpeed > 200 && slipRatio > 0.16) {
      return true;
    }
  }
  if (kin.planarSpeed > 140 && Math.abs(kin.omegaYaw) > 1.5) {
    const maxSteerYaw = evaluateGroundSteerCurvature(kin.planarSpeed) * Math.abs(kin.localForwardVel);
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
    const rawJumpRising = currCar.activeFlags.jumpActive && !(prevCar?.entityActive && prevCar.activeFlags.jumpActive);
    const liftingOffNext =
      Boolean(nextCar?.entityActive && !nextCar.isOnGround) &&
      kin.basis.up.z > 0.25 &&
      (kin.localUpVel > 130 || kin.nonGravityUpAccel > 550);
    return { boostActive, jumpActive: rawJumpRising || liftingOffNext, doubleJumpActive: false, dodgeActive: false };
  }

  const airTime = Math.max(0, currCar.airTimeSinceJump);
  const prevGrounded = Boolean(prevCar?.entityActive && prevCar.isOnGround);
  const prevRawJump = Boolean(prevCar?.entityActive && prevCar.activeFlags.jumpActive);
  const prevRawDj = Boolean(prevCar?.entityActive && prevCar.activeFlags.doubleJumpActive);
  const prevRawDodge = Boolean(prevCar?.entityActive && prevCar.activeFlags.dodgeActive);

  const rawDodgeValid = currCar.activeFlags.dodgeActive && (!prevRawDodge || (!prevGrounded && airTime <= 0.72));
  const kinDodge =
    airTime >= 0.035 && airTime <= 1.45 && kin.angAccelMag > 18.0 && kin.flipOmegaMag > 3.5 &&
    (kin.planarAccelMag > 1350 || kin.angAccelMag > 25.0);
  const dodgeActive = rawDodgeValid || kinDodge;

  const netUpImpulseAccel = kin.nonGravityUpAccel - (boostActive ? BOOST_ACCEL_AIR_UU * Math.max(0, kin.basis.forward.z) : 0);
  const rawDjValid = !dodgeActive && currCar.activeFlags.doubleJumpActive && (!prevRawDj || (!prevGrounded && airTime <= 0.35));
  const kinDj = !dodgeActive && airTime >= 0.045 && airTime <= 1.45 && netUpImpulseAccel > 1050 && kin.localUpVel > 150 && kin.flipOmegaMag < 3.4;
  const doubleJumpActive = rawDjValid || kinDj;

  const rawJumpValid =
    currCar.activeFlags.jumpActive && (!prevRawJump || (!prevGrounded && airTime <= 0.21) || (prevGrounded && kin.localUpVel > 90));
  const kinLiftoffJump =
    (prevGrounded && kin.basis.up.z > 0.25 && (kin.localUpVel > 135 || netUpImpulseAccel > 600)) ||
    (airTime > 0 && airTime <= 0.20 && netUpImpulseAccel > 550 && kin.localUpVel > 120);
  const jumpActive = !dodgeActive && !doubleJumpActive && airTime <= 0.22 && (rawJumpValid || kinLiftoffJump);

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
  const prevFlags = prevCar?.entityActive ? synthesizeCarActiveFlagsBetweenFrames(null, prevCar, currCar, options) : NEUTRAL_ACTIVE_FLAGS;
  const jump = flags.jumpActive || (flags.dodgeActive && !prevFlags.dodgeActive) || (flags.doubleJumpActive && !prevFlags.doubleJumpActive);

  let throttle = 0, steer = 0, pitch = 0, yaw = 0, roll = 0;

  if (currCar.isOnGround) {
    const netDriveAccel = kin.nonGravityForwardAccel - (boost ? BOOST_ACCEL_GROUND_UU : 0);
    if (preferReplicated && Math.abs(currCar.controls.throttle) > 0.01) throttle = clampUnit(currCar.controls.throttle);
    else if (boost) throttle = 1;
    else if (Math.abs(kin.localForwardVel) > 40 && kin.localForwardVel * netDriveAccel < 0 && Math.abs(netDriveAccel) > COAST_DECEL_GROUND_UU * 1.65) {
      throttle = -Math.sign(kin.localForwardVel) * Math.min(1, Math.abs(netDriveAccel) / BRAKE_DECEL_GROUND_UU);
    } else {
      const maxDriveAccel = evaluateGroundThrottleMaxAccel(Math.abs(kin.localForwardVel));
      if (maxDriveAccel > 60) throttle = applyDeadzone(netDriveAccel / maxDriveAccel, deadzone);
      else if (Math.abs(kin.localForwardVel) > 1380 && netDriveAccel > -200) throttle = Math.sign(kin.localForwardVel);
    }

    if (preferReplicated && Math.abs(currCar.controls.steer) > 0.01) steer = clampUnit(currCar.controls.steer);
    else if (Math.abs(kin.localForwardVel) > 25) {
      const expectedMaxYawRate = Math.max(0.15, evaluateGroundSteerCurvature(kin.planarSpeed) * Math.abs(kin.localForwardVel));
      steer = applyDeadzone((kin.omegaYaw * (kin.localForwardVel >= 0 ? 1 : -1)) / expectedMaxYawRate, deadzone);
    }
  } else {
    pitch = applyDeadzone(solveAerialAxisWithDamping(kin.alphaPitch, kin.omegaPitch, AERIAL_TORQUE_PITCH, AERIAL_DAMPING_PITCH), deadzone);
    yaw = applyDeadzone(solveAerialAxisWithDamping(kin.alphaYaw, kin.omegaYaw, AERIAL_TORQUE_YAW, AERIAL_DAMPING_YAW), deadzone);
    roll = applyDeadzone(solveAerialAxisWithDamping(kin.alphaRoll, kin.omegaRoll, AERIAL_TORQUE_ROLL, AERIAL_DAMPING_ROLL), deadzone);

    if (preferReplicated && Math.abs(currCar.controls.throttle) > 0.01) throttle = clampUnit(currCar.controls.throttle);
    else if (boost) throttle = 1;
    else throttle = applyDeadzone((kin.nonGravityForwardAccel - (boost ? BOOST_ACCEL_AIR_UU : 0)) / THROTTLE_AIR_ACCEL_UU, 0.15);

    steer = preferReplicated && Math.abs(currCar.controls.steer) > 0.01 ? clampUnit(currCar.controls.steer) : yaw;
  }

  return { throttle, steer, pitch, yaw, roll, jump, boost, handbrake: inferHandbrakeFromKinematics(prevCar, currCar, kin, roll) };
}
