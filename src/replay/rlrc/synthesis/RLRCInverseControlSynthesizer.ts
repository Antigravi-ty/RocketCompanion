/**
 * RLRCInverseControlSynthesizer.ts
 * Synthesizes 120Hz per-car control inputs (throttle, steer, pitch, yaw, roll,
 * jump, boost, handbrake) and refined component active flags (boostActive,
 * jumpActive, doubleJumpActive, dodgeActive) from 120Hz rigid-body states,
 * boost reserves, and replicated component flags for replay audio/VFX and takeover.
 */

import {
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  EXTENDED_STATE_OFFSETS,
  SIM_OFFSETS,
} from '../../../physics/RocketSimConstants.ts';
import { packCarControlsToTrack64 } from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_CONTROLS_BYTES_PER_FRAME,
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_BYTES_PER_FRAME,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCCarComponentActiveFlags,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
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

const GRAVITY_Z_UU = -650.0;
const BOOST_ACCEL_GROUND_UU = 991.666;
const BOOST_ACCEL_AIR_UU = 1058.333;
const THROTTLE_AIR_ACCEL_UU = 66.667;
const BRAKE_DECEL_GROUND_UU = 3500.0;
const COAST_DECEL_GROUND_UU = 525.0;

const AERIAL_TORQUE_ROLL = -36.07956616966136;
const AERIAL_TORQUE_PITCH = -12.1459978190807;
const AERIAL_TORQUE_YAW = 8.91962804287785;

const AERIAL_DAMPING_ROLL = -4.47166302201591;
const AERIAL_DAMPING_PITCH = -2.798194258050845;
const AERIAL_DAMPING_YAW = -1.886491900437232;

const JUMP_MIN_HOLD_FRAMES = 3;
const JUMP_MAX_HOLD_FRAMES = 24;
const DOUBLE_JUMP_PULSE_FRAMES = 18;
const DODGE_MAX_ACTIVE_FRAMES = 78;
const DODGE_MIN_ACTIVE_FRAMES = 18;
const SECOND_JUMP_BUTTON_PULSE_FRAMES = 6;
const FLIP_EXPIRATION_BASE_SECONDS = 1.25;
const MAX_PACKED_CAR_SLOTS = 8;

export const NEUTRAL_SYNTHESIZED_CONTROLS: RLRCSynthesizedCarControls = Object.freeze({
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
});

export const NEUTRAL_ACTIVE_FLAGS: RLRCCarComponentActiveFlags = Object.freeze({
  boostActive: false,
  jumpActive: false,
  doubleJumpActive: false,
  dodgeActive: false,
});

interface FrameKinematicsSample {
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

const clampUnit = (v: number): number => (!Number.isFinite(v) ? 0 : v <= -1 ? -1 : v >= 1 ? 1 : v);
const applyDeadzone = (v: number, dz: number): number => {
  const c = clampUnit(v);
  return Math.abs(c) < dz ? 0 : c;
};
const dotVec3 = (a: RLRCVec3, b: RLRCVec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const distVec3 = (a: RLRCVec3, b: RLRCVec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

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
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
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

function solveAerialAxisWithDamping(
  angularAccel: number,
  angularVel: number,
  torqueScale: number,
  dampingScale: number
): number {
  const netTorque = angularAccel - dampingScale * angularVel;
  const rawControl = netTorque / torqueScale;
  const sign = rawControl >= 0 ? 1 : -1;
  const denom = torqueScale - sign * dampingScale * angularVel;
  if (Math.abs(denom) < Math.abs(torqueScale) * 0.35) return clampUnit(rawControl);
  return clampUnit(netTorque / denom);
}

function computeFrameKinematics(
  prevCar: RLRCCarFrameState120Hz | null | undefined,
  currCar: RLRCCarFrameState120Hz,
  nextCar: RLRCCarFrameState120Hz | null | undefined,
  dt: number
): FrameKinematicsSample {
  const prevValid = Boolean(prevCar?.entityActive) && distVec3(prevCar!.rigidBody.position, currCar.rigidBody.position) <= 360;
  const nextValid = Boolean(nextCar?.entityActive) && distVec3(nextCar!.rigidBody.position, currCar.rigidBody.position) <= 360;
  const teleported = Boolean(prevCar?.entityActive) && !prevValid;
  const refStart = prevValid ? prevCar! : currCar;
  const refEnd = nextValid ? nextCar! : currCar;
  const spanTicks = (prevValid ? 1 : 0) + (nextValid ? 1 : 0);
  const invSpanDt = spanTicks > 0 ? 1 / (spanTicks * dt) : 0;

  const basis = computeLocalCarBasisFromQuat(currCar.rigidBody.rotation);
  const linVel = currCar.rigidBody.linearVelocity;
  const angVel = currCar.rigidBody.angularVelocity;
  const linAccel: RLRCVec3 = {
    x: (refEnd.rigidBody.linearVelocity.x - refStart.rigidBody.linearVelocity.x) * invSpanDt,
    y: (refEnd.rigidBody.linearVelocity.y - refStart.rigidBody.linearVelocity.y) * invSpanDt,
    z: (refEnd.rigidBody.linearVelocity.z - refStart.rigidBody.linearVelocity.z) * invSpanDt,
  };
  const angAccel: RLRCVec3 = {
    x: (refEnd.rigidBody.angularVelocity.x - refStart.rigidBody.angularVelocity.x) * invSpanDt,
    y: (refEnd.rigidBody.angularVelocity.y - refStart.rigidBody.angularVelocity.y) * invSpanDt,
    z: (refEnd.rigidBody.angularVelocity.z - refStart.rigidBody.angularVelocity.z) * invSpanDt,
  };

  const localForwardVel = dotVec3(linVel, basis.forward);
  const localRightVel = dotVec3(linVel, basis.right);
  const localUpVel = dotVec3(linVel, basis.up);
  const planarSpeed = Math.hypot(localForwardVel, localRightVel);
  const nonGravityForwardAccel = dotVec3(linAccel, basis.forward) - GRAVITY_Z_UU * basis.forward.z;
  const nonGravityUpAccel = dotVec3(linAccel, basis.up) - GRAVITY_Z_UU * basis.up.z;
  const planarAccelMag = Math.hypot(linAccel.x, linAccel.y);

  const omegaRoll = dotVec3(angVel, basis.forward);
  const omegaPitch = dotVec3(angVel, basis.right);
  const omegaYaw = dotVec3(angVel, basis.up);
  const flipOmegaMag = Math.hypot(omegaPitch, omegaRoll, omegaYaw * 0.65);

  const alphaRoll = dotVec3(angAccel, basis.forward);
  const alphaPitch = dotVec3(angAccel, basis.right);
  const alphaYaw = dotVec3(angAccel, basis.up);
  const angAccelMag = Math.hypot(alphaPitch, alphaRoll, alphaYaw);

  return {
    basis, localForwardVel, localRightVel, localUpVel, planarSpeed,
    nonGravityForwardAccel, nonGravityUpAccel, planarAccelMag,
    omegaRoll, omegaPitch, omegaYaw, flipOmegaMag,
    alphaRoll, alphaPitch, alphaYaw, angAccelMag, teleported,
  };
}

function inferBoostStateFromKinematics(
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

function inferHandbrakeFromKinematics(
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
  const secondJumpEdge = (flags.dodgeActive && !prevFlags.dodgeActive) || (flags.doubleJumpActive && !prevFlags.doubleJumpActive);
  const jump = flags.jumpActive || secondJumpEdge;

  let throttle = 0, steer = 0, pitch = 0, yaw = 0, roll = 0;

  if (currCar.isOnGround) {
    const netDriveAccel = kin.nonGravityForwardAccel - (boost ? BOOST_ACCEL_GROUND_UU : 0);
    const hasRepThrottle = preferReplicated && Math.abs(currCar.controls.throttle) > 0.01;
    const hasRepSteer = preferReplicated && Math.abs(currCar.controls.steer) > 0.01;

    if (hasRepThrottle) throttle = clampUnit(currCar.controls.throttle);
    else if (boost) throttle = 1;
    else if (Math.abs(kin.localForwardVel) > 40 && kin.localForwardVel * netDriveAccel < 0 && Math.abs(netDriveAccel) > COAST_DECEL_GROUND_UU * 1.65) {
      throttle = -Math.sign(kin.localForwardVel) * Math.min(1, Math.abs(netDriveAccel) / BRAKE_DECEL_GROUND_UU);
    } else {
      const maxDriveAccel = evaluateGroundThrottleMaxAccel(Math.abs(kin.localForwardVel));
      if (maxDriveAccel > 60) throttle = applyDeadzone(netDriveAccel / maxDriveAccel, deadzone);
      else if (Math.abs(kin.localForwardVel) > 1380 && netDriveAccel > -200) throttle = Math.sign(kin.localForwardVel);
    }

    if (hasRepSteer) steer = clampUnit(currCar.controls.steer);
    else if (Math.abs(kin.localForwardVel) > 25) {
      const curvature = evaluateGroundSteerCurvature(kin.planarSpeed);
      const expectedMaxYawRate = Math.max(0.15, curvature * Math.abs(kin.localForwardVel));
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

  const handbrake = inferHandbrakeFromKinematics(prevCar, currCar, kin, roll);
  return { throttle, steer, pitch, yaw, roll, jump, boost, handbrake };
}

function debounceBooleanTrack(
  flags: boolean[],
  activeByFrame: readonly boolean[],
  preserveExplicitPulse: readonly boolean[],
  maxGapFill = 2,
  minKinematicRun = 1
): void {
  const n = flags.length;
  for (let i = 1; i + 1 < n; i++) {
    if (!activeByFrame[i]) continue;
    if (!flags[i] && flags[i - 1] && flags[i + 1]) flags[i] = true;
    else if (maxGapFill >= 2 && i + 2 < n && !flags[i] && !flags[i + 1] && flags[i - 1] && flags[i + 2] && activeByFrame[i + 1]) {
      flags[i] = true;
      flags[i + 1] = true;
    }
  }
  if (minKinematicRun <= 1) {
    for (let i = 1; i + 1 < n; i++) {
      if (flags[i] && !flags[i - 1] && !flags[i + 1] && !preserveExplicitPulse[i]) flags[i] = false;
    }
    return;
  }
  let f = 0;
  while (f < n) {
    if (!flags[f]) { f++; continue; }
    let end = f, hasExplicit = false;
    while (end < n && flags[end]) {
      if (preserveExplicitPulse[end]) hasExplicit = true;
      end++;
    }
    if (!hasExplicit && end - f < minKinematicRun) {
      for (let k = f; k < end; k++) flags[k] = false;
    }
    f = end;
  }
}

function synthesizeSlotTimeline120Hz(
  frames: readonly RLRCFrame120Hz[],
  slot: number,
  options?: RLRCControlSynthesisOptions
) {
  const frameCount = frames.length;
  const dt = Math.max(1e-4, options?.dtSeconds ?? RLRC_FIXED_DT);
  const smoothRadius: 0 | 1 | 2 = options?.smoothWindowRadius ?? 1;

  const activeByFrame = new Array<boolean>(frameCount).fill(false);
  const kinByFrame = new Array<FrameKinematicsSample | null>(frameCount).fill(null);
  const baseControls = new Array<RLRCSynthesizedCarControls>(frameCount).fill(NEUTRAL_SYNTHESIZED_CONTROLS);
  const boostTrack = new Array<boolean>(frameCount).fill(false);
  const repBoostPulse = new Array<boolean>(frameCount).fill(false);
  const handbrakeTrack = new Array<boolean>(frameCount).fill(false);
  const repHandbrakePulse = new Array<boolean>(frameCount).fill(false);

  let framesSinceLanding = 999;
  for (let f = 0; f < frameCount; f++) {
    const currCar = frames[f].cars[slot];
    if (!currCar || !currCar.entityActive) { framesSinceLanding = 999; continue; }
    const prevCar = f > 0 ? frames[f - 1].cars[slot] : null;
    const nextCar = f + 1 < frameCount ? frames[f + 1].cars[slot] : null;
    activeByFrame[f] = true;

    const kin = computeFrameKinematics(prevCar, currCar, nextCar, dt);
    kinByFrame[f] = kin;
    if (kin.teleported) framesSinceLanding = 999;
    else if (currCar.isOnGround) framesSinceLanding = prevCar?.entityActive && !prevCar.isOnGround ? 0 : framesSinceLanding + 1;
    else framesSinceLanding = 999;

    const ctrl = synthesizeCarControlsBetweenFrames(prevCar, currCar, nextCar, options);
    baseControls[f] = ctrl;

    let boostOn = inferBoostStateFromKinematics(prevCar, currCar, nextCar, kin, dt);
    const fB0 = Math.max(0, f - 2), fB1 = Math.min(frameCount - 1, f + 2);
    const cB0 = frames[fB0].cars[slot], cB1 = frames[fB1].cars[slot];
    const windowDrainRate = cB0?.entityActive && cB1?.entityActive && fB1 > fB0 ? (cB0.boostAmount - cB1.boostAmount) / ((fB1 - fB0) * dt) : 0;
    const hasExplicitBoostOrDrain =
      Boolean(currCar.activeFlags.boostActive && currCar.boostAmount > 0.05) ||
      (windowDrainRate >= 8.5 && windowDrainRate <= 120.0 && cB0.boostAmount - cB1.boostAmount <= 12.0);

    if (boostOn && currCar.activeFlags.boostActive && currCar.boostAmount < 99.5) {
      const fLo = Math.max(0, f - 18), fHi = Math.min(frameCount - 1, f + 18);
      const cLo = frames[fLo].cars[slot], cHi = frames[fHi].cars[slot];
      if (fHi - fLo >= 24 && cLo?.entityActive && cHi?.entityActive && Math.abs(cLo.boostAmount - cHi.boostAmount) < 0.05 && kin.nonGravityForwardAccel < 220) {
        boostOn = false;
      }
    }
    boostTrack[f] = boostOn;
    repBoostPulse[f] = hasExplicitBoostOrDrain;
    handbrakeTrack[f] = inferHandbrakeFromKinematics(prevCar, currCar, kin, ctrl.roll, framesSinceLanding);
    repHandbrakePulse[f] = Boolean(currCar.controls.handbrake);
  }

  debounceBooleanTrack(boostTrack, activeByFrame, repBoostPulse, 2, 5);
  debounceBooleanTrack(handbrakeTrack, activeByFrame, repHandbrakePulse, 2, 2);

  const jumpActiveTrack = new Array<boolean>(frameCount).fill(false);
  const doubleJumpActiveTrack = new Array<boolean>(frameCount).fill(false);
  const dodgeActiveTrack = new Array<boolean>(frameCount).fill(false);
  const jumpButtonTrack = new Array<boolean>(frameCount).fill(false);
  const hasFlipTrack = new Array<boolean>(frameCount).fill(false);
  const airTimeTrack = new Array<number>(frameCount).fill(0);

  let groundedRawJumpStreak = 0, rawJumpLatched = false, rawDjLatched = false, rawDodgeLatched = false;
  let jumpHoldFramesRemaining = 0, jumpHoldTotalFrames = 0, djPulseFramesRemaining = 0;
  let dodgeFramesRemaining = 0, dodgeElapsedFrames = 0, secondJumpButtonFramesRemaining = 0;
  let usedSecondJumpInAir = false, airFramesCount = 0, jumpedFromGroundInAir = false;

  for (let f = 0; f < frameCount; f++) {
    const currCar = frames[f].cars[slot], kin = kinByFrame[f];
    if (!currCar || !currCar.entityActive || !kin) {
      groundedRawJumpStreak = 0; rawJumpLatched = rawDjLatched = rawDodgeLatched = false;
      jumpHoldFramesRemaining = jumpHoldTotalFrames = djPulseFramesRemaining = dodgeFramesRemaining = dodgeElapsedFrames = secondJumpButtonFramesRemaining = 0;
      usedSecondJumpInAir = jumpedFromGroundInAir = false; airFramesCount = 0;
      continue;
    }
    if (kin.teleported || frames[f].roundCountdownNumber > 0) {
      jumpHoldFramesRemaining = jumpHoldTotalFrames = djPulseFramesRemaining = dodgeFramesRemaining = dodgeElapsedFrames = secondJumpButtonFramesRemaining = 0;
      usedSecondJumpInAir = jumpedFromGroundInAir = false; airFramesCount = 0;
    }

    const rawFlags = currCar.activeFlags;
    if (!rawFlags.jumpActive) rawJumpLatched = false;
    if (!rawFlags.doubleJumpActive) rawDjLatched = false;
    if (!rawFlags.dodgeActive) rawDodgeLatched = false;

    const rawJumpRising = rawFlags.jumpActive && !rawJumpLatched;
    const rawDjRising = rawFlags.doubleJumpActive && !rawDjLatched;
    const rawDodgeRising = rawFlags.dodgeActive && !rawDodgeLatched;
    const prevCar = f > 0 ? frames[f - 1].cars[slot] : null;
    const wasOnGround = Boolean(prevCar?.entityActive && prevCar.isOnGround);

    if (currCar.isOnGround) {
      groundedRawJumpStreak = rawFlags.jumpActive ? groundedRawJumpStreak + 1 : 0;
      djPulseFramesRemaining = dodgeFramesRemaining = dodgeElapsedFrames = secondJumpButtonFramesRemaining = 0;
      usedSecondJumpInAir = jumpedFromGroundInAir = false; airFramesCount = 0;

      let liftsOffSoon = false;
      for (let k = 1; k <= 4 && f + k < frameCount; k++) {
        const futCar = frames[f + k].cars[slot], futKin = kinByFrame[f + k];
        if (!futCar?.entityActive || !futKin || futKin.teleported) break;
        if (!futCar.isOnGround && (futKin.localUpVel > 130 || futKin.nonGravityUpAccel > 500)) { liftsOffSoon = true; break; }
      }
      if (rawJumpRising && liftsOffSoon && kin.basis.up.z > 0.25) {
        rawJumpLatched = true; jumpHoldFramesRemaining = JUMP_MAX_HOLD_FRAMES; jumpHoldTotalFrames = 1;
        jumpedFromGroundInAir = true; jumpActiveTrack[f] = true; jumpButtonTrack[f] = true;
      } else if (jumpHoldFramesRemaining > 0 && jumpHoldTotalFrames <= 3 && liftsOffSoon) {
        jumpHoldFramesRemaining--; jumpHoldTotalFrames++; jumpActiveTrack[f] = true; jumpButtonTrack[f] = true;
      } else {
        jumpHoldFramesRemaining = jumpHoldTotalFrames = 0;
        if (groundedRawJumpStreak > 6 && rawFlags.jumpActive) rawJumpLatched = true;
      }
      hasFlipTrack[f] = true; airTimeTrack[f] = 0;
      continue;
    }

    airFramesCount++;
    const airTimeSec = airFramesCount * dt;
    if (wasOnGround && jumpHoldTotalFrames === 0) {
      let peakUpVel = kin.localUpVel;
      for (let k = 1; k <= 4 && f + k < frameCount; k++) {
        const futKin = kinByFrame[f + k], futCar = frames[f + k].cars[slot];
        if (!futCar?.entityActive || !futKin || futKin.teleported || futCar.isOnGround) break;
        if (futKin.localUpVel > peakUpVel) peakUpVel = futKin.localUpVel;
      }
      const unstuckRepJump = rawFlags.jumpActive && groundedRawJumpStreak <= 6;
      const kinematicLiftoff = kin.basis.up.z > 0.25 && peakUpVel > 145 && (kin.localUpVel > 110 || kin.nonGravityUpAccel > 520);
      if (unstuckRepJump || kinematicLiftoff) {
        rawJumpLatched = rawFlags.jumpActive; jumpHoldFramesRemaining = JUMP_MAX_HOLD_FRAMES;
        jumpHoldTotalFrames = 0; jumpedFromGroundInAir = true;
      }
    } else if (rawJumpRising && airFramesCount <= 8 && jumpHoldTotalFrames === 0 && !usedSecondJumpInAir) {
      rawJumpLatched = true; jumpHoldFramesRemaining = Math.max(JUMP_MIN_HOLD_FRAMES, JUMP_MAX_HOLD_FRAMES - airFramesCount);
      jumpHoldTotalFrames = 0; jumpedFromGroundInAir = true;
    }

    const ballState = frames[f].ball;
    const nearBall = ballState.entityActive && distVec3(currCar.rigidBody.position, ballState.rigidBody.position) < 205;
    const flipWindowLimit = FLIP_EXPIRATION_BASE_SECONDS + Math.min(0.2, jumpHoldTotalFrames * dt) + 0.05;
    const withinFlipWindow = !jumpedFromGroundInAir || airTimeSec <= flipWindowLimit;

    let triggerDodge = false, triggerDoubleJump = false;
    if (airFramesCount >= 3 && dodgeFramesRemaining === 0 && djPulseFramesRemaining === 0) {
      if (rawDodgeRising) { triggerDodge = true; rawDodgeLatched = true; }
      else if (rawDjRising) { triggerDoubleJump = true; rawDjLatched = true; }
      else if (!usedSecondJumpInAir && withinFlipWindow && !nearBall) {
        let peakFlipOmega = kin.flipOmegaMag, sumFlipOmega = 0, lookCount = 0;
        for (let k = 1; k <= 8 && f + k < frameCount; k++) {
          const futCar = frames[f + k].cars[slot], futKin = kinByFrame[f + k];
          if (!futCar?.entityActive || !futKin || futKin.teleported || futCar.isOnGround) break;
          if (futKin.flipOmegaMag > peakFlipOmega) peakFlipOmega = futKin.flipOmegaMag;
          sumFlipOmega += futKin.flipOmegaMag; lookCount++;
        }
        const meanFlipOmega = lookCount > 0 ? sumFlipOmega / lookCount : kin.flipOmegaMag;
        const prevVz = prevCar?.entityActive ? prevCar.rigidBody.linearVelocity.z : 0;
        const vzDamped = Math.abs(prevVz) > 130 && Math.abs(currCar.rigidBody.linearVelocity.z) < Math.abs(prevVz) * 0.82;

        if (airFramesCount >= 4 && kin.angAccelMag > 18.0 && peakFlipOmega >= 3.7 && meanFlipOmega >= 2.6 && (kin.planarAccelMag > 1350 || vzDamped || kin.angAccelMag > 26.0)) {
          triggerDodge = true; rawDodgeLatched = rawFlags.dodgeActive;
        } else if (airFramesCount >= 5 && jumpHoldFramesRemaining <= 16) {
          const boostUp = boostTrack[f] ? BOOST_ACCEL_AIR_UU * Math.max(0, kin.basis.forward.z) : 0;
          const netUpAccel = kin.nonGravityUpAccel - boostUp;
          const fPrev = Math.max(0, f - 1), fNext = Math.min(frameCount - 1, f + 3);
          const kinPrev = kinByFrame[fPrev], kinNext = kinByFrame[fNext];
          const spanSec = Math.max(dt, (fNext - fPrev) * dt);
          const upGain = kinPrev && kinNext ? kinNext.localUpVel - kinPrev.localUpVel - (GRAVITY_Z_UU * kin.basis.up.z + boostUp) * spanSec : 0;
          if (netUpAccel > 1050 && upGain > 155 && peakFlipOmega < 3.4) {
            triggerDoubleJump = true; rawDjLatched = rawFlags.doubleJumpActive;
          }
        }
      }
    }

    if (triggerDodge) {
      jumpHoldFramesRemaining = 0; dodgeFramesRemaining = DODGE_MAX_ACTIVE_FRAMES; dodgeElapsedFrames = 0;
      secondJumpButtonFramesRemaining = SECOND_JUMP_BUTTON_PULSE_FRAMES; usedSecondJumpInAir = true;
      if (f > 0) jumpButtonTrack[f - 1] = false;
    } else if (triggerDoubleJump) {
      jumpHoldFramesRemaining = 0; djPulseFramesRemaining = DOUBLE_JUMP_PULSE_FRAMES;
      secondJumpButtonFramesRemaining = SECOND_JUMP_BUTTON_PULSE_FRAMES; usedSecondJumpInAir = true;
      if (f > 0) jumpButtonTrack[f - 1] = false;
    }

    if (dodgeFramesRemaining > 0) {
      dodgeElapsedFrames++; dodgeFramesRemaining--; dodgeActiveTrack[f] = true;
      if (!repBoostPulse[f]) boostTrack[f] = false;
      if (dodgeElapsedFrames >= DODGE_MIN_ACTIVE_FRAMES && kin.flipOmegaMag < 1.0 && !rawFlags.dodgeActive) dodgeFramesRemaining = 0;
    } else if (djPulseFramesRemaining > 0) {
      djPulseFramesRemaining--; doubleJumpActiveTrack[f] = true;
    } else if (jumpHoldFramesRemaining > 0) {
      jumpHoldTotalFrames++; jumpHoldFramesRemaining--;
      const netUpHoldAccel = kin.nonGravityUpAccel - (boostTrack[f] ? BOOST_ACCEL_AIR_UU * Math.max(0, kin.basis.forward.z) : 0);
      const stillHolding = jumpHoldTotalFrames <= JUMP_MIN_HOLD_FRAMES || (rawFlags.jumpActive && groundedRawJumpStreak <= 6) || netUpHoldAccel > 450;
      if (stillHolding) { jumpActiveTrack[f] = true; jumpButtonTrack[f] = true; }
      else jumpHoldFramesRemaining = 0;
    }

    if (secondJumpButtonFramesRemaining > 0) { secondJumpButtonFramesRemaining--; jumpButtonTrack[f] = true; }
    airTimeTrack[f] = Math.min(FLIP_EXPIRATION_BASE_SECONDS, airTimeSec);
    hasFlipTrack[f] = !usedSecondJumpInAir && withinFlipWindow;
  }

  debounceBooleanTrack(boostTrack, activeByFrame, repBoostPulse, 2, 5);
  for (let f = 0; f < frameCount; f++) {
    if (!activeByFrame[f]) continue;
    const c = baseControls[f];
    baseControls[f] = { throttle: c.throttle, steer: c.steer, pitch: c.pitch, yaw: c.yaw, roll: c.roll, jump: jumpButtonTrack[f], boost: boostTrack[f], handbrake: handbrakeTrack[f] };
  }

  const smoothedControls = smoothSlotControlsWindow(baseControls, activeByFrame, smoothRadius);
  const activeFlags: RLRCCarComponentActiveFlags[] = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    activeFlags[f] = !activeByFrame[f]
      ? NEUTRAL_ACTIVE_FLAGS
      : { boostActive: boostTrack[f], jumpActive: jumpActiveTrack[f], doubleJumpActive: doubleJumpActiveTrack[f], dodgeActive: dodgeActiveTrack[f] };
  }
  return { controls: smoothedControls, activeFlags, hasFlipOrJump: hasFlipTrack, airTimeSinceJump: airTimeTrack };
}

function smoothSlotControlsWindow(
  rawByFrame: readonly RLRCSynthesizedCarControls[],
  activeByFrame: readonly boolean[],
  radius: 0 | 1 | 2
): RLRCSynthesizedCarControls[] {
  if (radius === 0 || rawByFrame.length <= 2) return [...rawByFrame];
  const count = rawByFrame.length;
  const result: RLRCSynthesizedCarControls[] = new Array(count);

  for (let i = 0; i < count; i++) {
    if (!activeByFrame[i]) { result[i] = NEUTRAL_SYNTHESIZED_CONTROLS; continue; }
    let sThr = 0, sStr = 0, sPit = 0, sYaw = 0, sRol = 0, wSum = 0;
    for (let d = -radius; d <= radius; d++) {
      const idx = i + d;
      if (idx < 0 || idx >= count || !activeByFrame[idx]) continue;
      const w = radius + 1 - Math.abs(d), c = rawByFrame[idx];
      sThr += c.throttle * w; sStr += c.steer * w; sPit += c.pitch * w; sYaw += c.yaw * w; sRol += c.roll * w; wSum += w;
    }
    const base = rawByFrame[i];
    result[i] = wSum <= 0 ? base : {
      throttle: clampUnit(sThr / wSum), steer: clampUnit(sStr / wSum), pitch: clampUnit(sPit / wSum),
      yaw: clampUnit(sYaw / wSum), roll: clampUnit(sRol / wSum), jump: base.jump, boost: base.boost, handbrake: base.handbrake,
    };
  }
  return result;
}

export function synthesizeControlsForTimeline120Hz(
  frames: readonly RLRCFrame120Hz[],
  options?: RLRCControlSynthesisOptions
): RLRCFrame120Hz[] {
  const frameCount = frames.length;
  if (frameCount === 0) return [];
  const slotTimelines = Array.from({ length: RLRC_MAX_PLAYER_SLOTS }, (_, slot) =>
    synthesizeSlotTimeline120Hz(frames, slot, options)
  );
  return frames.map((srcFrame, f) => ({
    ...srcFrame,
    cars: srcFrame.cars.map((car, idx) => {
      if (!car.entityActive) return { ...car, activeFlags: NEUTRAL_ACTIVE_FLAGS, controls: NEUTRAL_SYNTHESIZED_CONTROLS };
      const slot = car.slotIndex >= 0 && car.slotIndex < RLRC_MAX_PLAYER_SLOTS ? car.slotIndex : idx;
      if (slot < 0 || slot >= RLRC_MAX_PLAYER_SLOTS) return { ...car, activeFlags: NEUTRAL_ACTIVE_FLAGS, controls: NEUTRAL_SYNTHESIZED_CONTROLS };
      const tl = slotTimelines[slot];
      return {
        ...car,
        hasFlipOrJump: tl.hasFlipOrJump[f],
        airTimeSinceJump: tl.airTimeSinceJump[f],
        activeFlags: tl.activeFlags[f],
        controls: tl.controls[f],
      };
    }),
  }));
}

export function packRLRCFrameControlsTo64Bytes(
  cars: readonly RLRCCarFrameState120Hz[],
  targetU8?: Uint8Array,
  byteOffset = 0
): Uint8Array {
  const out =
    targetU8 && targetU8.byteLength >= byteOffset + RLRC_CONTROLS_BYTES_PER_FRAME
      ? targetU8.subarray(byteOffset, byteOffset + RLRC_CONTROLS_BYTES_PER_FRAME)
      : new Uint8Array(RLRC_CONTROLS_BYTES_PER_FRAME);
  out.fill(0);
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    if (!car || !car.entityActive) continue;
    const carIndex = car.slotIndex >= 0 && car.slotIndex < MAX_PACKED_CAR_SLOTS ? car.slotIndex : i;
    if (carIndex >= 0 && carIndex < MAX_PACKED_CAR_SLOTS) packCarControlsToTrack64(out, carIndex, { ...car.controls });
  }
  return out;
}

export function writeSynthesizedControlsToTrack0Buffer(
  frames: readonly RLRCFrame120Hz[],
  stateInputTrackBytes: Uint8Array
): void {
  const maxFrames = Math.min(frames.length, Math.floor(stateInputTrackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES));
  for (let f = 0; f < maxFrames; f++) {
    const frameByteOffset = f * RLRC_TRACK0_FRAME_STRIDE_BYTES;
    const dstF32 = new Float32Array(
      stateInputTrackBytes.buffer,
      stateInputTrackBytes.byteOffset + frameByteOffset,
      RLRC_STATE_FLOATS_PER_FRAME
    );
    const cars = frames[f].cars;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) continue;
      const slot = car.slotIndex >= 0 && car.slotIndex < RLRC_MAX_PLAYER_SLOTS ? car.slotIndex : i;
      if (slot < 0 || slot >= RLRC_MAX_PLAYER_SLOTS) continue;

      const carBase = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
      const jumpAirBase = EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_BASE + slot * EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_STRIDE;
      if (car.entityActive) {
        const fl = car.activeFlags;
        dstF32[carBase + CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = car.hasFlipOrJump ? 1 : 0;
        dstF32[carBase + CAR_STATE_OFFSETS.IS_BOOSTING] = fl.boostActive || car.controls.boost ? 1 : 0;
        dstF32[carBase + CAR_STATE_OFFSETS.IS_FLIPPING] = fl.dodgeActive || fl.doubleJumpActive ? 1 : 0;
        dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_IS_JUMPING_OFFSET] = fl.jumpActive ? 1 : 0;
        dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_OFFSET] = fl.doubleJumpActive ? 1 : 0;
        dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_JUMP_TIME_OFFSET] = fl.dodgeActive ? 1 : 0;
        dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_SINCE_JUMP_OFFSET] = car.airTimeSinceJump;
      } else {
        dstF32[carBase + CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = 0;
        dstF32[carBase + CAR_STATE_OFFSETS.IS_BOOSTING] = 0;
        dstF32[carBase + CAR_STATE_OFFSETS.IS_FLIPPING] = 0;
        dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_IS_JUMPING_OFFSET] = 0;
        dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_OFFSET] = 0;
        dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_JUMP_TIME_OFFSET] = 0;
        dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_SINCE_JUMP_OFFSET] = 0;
      }
    }
    packRLRCFrameControlsTo64Bytes(cars, stateInputTrackBytes, frameByteOffset + RLRC_STATE_BYTES_PER_FRAME);
  }
}
