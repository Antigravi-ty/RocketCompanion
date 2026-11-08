/**
 * RLRCInverseControlSynthesizer.ts
 * Synthesizes 120Hz per-car control inputs (throttle, steer, pitch, yaw, roll,
 * jump, boost, handbrake) from adjacent 120Hz rigid-body states, boost reserves,
 * and replicated component flags for controller HUD display and takeover handoff.
 */

import { packCarControlsToTrack64 } from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_CONTROLS_BYTES_PER_FRAME,
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_BYTES_PER_FRAME,
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

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v <= -1 ? -1 : v >= 1 ? 1 : v;
}

function applyDeadzone(v: number, deadzone: number): number {
  const c = clampUnit(v);
  return Math.abs(c) < deadzone ? 0 : c;
}

function dotVec3(a: RLRCVec3, b: RLRCVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

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

function inferBoostState(
  prevCar: RLRCCarFrameState120Hz | null,
  currCar: RLRCCarFrameState120Hz,
  nonGravityForwardAccel: number,
  dt: number
): boolean {
  if (currCar.activeFlags.boostActive || currCar.controls.boost) return true;
  if (prevCar && prevCar.entityActive && currCar.boostAmount > 0) {
    const dropRate = (prevCar.boostAmount - currCar.boostAmount) / Math.max(dt, 1e-4);
    if (dropRate > 8.0) return true;
  }
  return !currCar.isOnGround && currCar.boostAmount > 0.5 && nonGravityForwardAccel > 520;
}

function inferJumpState(
  prevCar: RLRCCarFrameState120Hz | null,
  currCar: RLRCCarFrameState120Hz,
  localUpVel: number,
  nonGravityUpAccel: number
): boolean {
  const flags: RLRCCarComponentActiveFlags = currCar.activeFlags;
  if (flags.jumpActive || flags.doubleJumpActive || flags.dodgeActive || currCar.controls.jump) {
    return true;
  }
  if (!prevCar || !prevCar.entityActive) return false;
  if (prevCar.isOnGround && !currCar.isOnGround && localUpVel > 180) return true;
  return !currCar.isOnGround && nonGravityUpAccel > 900 && currCar.airTimeSinceJump < 0.25;
}

/**
 * Synthesizes a single car's control state at `currCar` using kinematics differences
 * from `prevCar` (and optional `nextCar` for centered differences).
 */
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

  const refStart = prevCar && prevCar.entityActive ? prevCar : currCar;
  const refEnd = nextCar && nextCar.entityActive ? nextCar : currCar;
  const spanTicks =
    (prevCar && prevCar.entityActive ? 1 : 0) + (nextCar && nextCar.entityActive ? 1 : 0);
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

  const nonGravityForwardAccel = dotVec3(linAccel, basis.forward) - GRAVITY_Z_UU * basis.forward.z;
  const nonGravityUpAccel = dotVec3(linAccel, basis.up) - GRAVITY_Z_UU * basis.up.z;

  const omegaRoll = dotVec3(angVel, basis.forward);
  const omegaPitch = dotVec3(angVel, basis.right);
  const omegaYaw = dotVec3(angVel, basis.up);

  const alphaRoll = dotVec3(angAccel, basis.forward);
  const alphaPitch = dotVec3(angAccel, basis.right);
  const alphaYaw = dotVec3(angAccel, basis.up);

  const boost = inferBoostState(prevCar ?? null, currCar, nonGravityForwardAccel, dt);
  const jump = inferJumpState(prevCar ?? null, currCar, localUpVel, nonGravityUpAccel);

  let throttle = 0, steer = 0, pitch = 0, yaw = 0, roll = 0;
  let handbrake = Boolean(currCar.controls.handbrake);

  if (currCar.isOnGround) {
    const netDriveAccel = nonGravityForwardAccel - (boost ? BOOST_ACCEL_GROUND_UU : 0);
    const hasRepThrottle = preferReplicated && Math.abs(currCar.controls.throttle) > 0.01;
    const hasRepSteer = preferReplicated && Math.abs(currCar.controls.steer) > 0.01;

    if (hasRepThrottle) {
      throttle = clampUnit(currCar.controls.throttle);
    } else if (boost) {
      throttle = 1;
    } else if (
      Math.abs(localForwardVel) > 40 &&
      localForwardVel * netDriveAccel < 0 &&
      Math.abs(netDriveAccel) > COAST_DECEL_GROUND_UU * 1.65
    ) {
      throttle = -Math.sign(localForwardVel) * Math.min(1, Math.abs(netDriveAccel) / BRAKE_DECEL_GROUND_UU);
    } else {
      const maxDriveAccel = evaluateGroundThrottleMaxAccel(Math.abs(localForwardVel));
      if (maxDriveAccel > 60) {
        throttle = applyDeadzone(netDriveAccel / maxDriveAccel, deadzone);
      } else if (Math.abs(localForwardVel) > 1380 && netDriveAccel > -200) {
        throttle = Math.sign(localForwardVel);
      }
    }

    const planarSpeed = Math.hypot(localForwardVel, localRightVel);
    if (hasRepSteer) {
      steer = clampUnit(currCar.controls.steer);
    } else if (Math.abs(localForwardVel) > 25) {
      const curvature = evaluateGroundSteerCurvature(planarSpeed);
      const expectedMaxYawRate = Math.max(0.15, curvature * Math.abs(localForwardVel));
      const directionSign = localForwardVel >= 0 ? 1 : -1;
      steer = applyDeadzone((omegaYaw * directionSign) / expectedMaxYawRate, deadzone);
    }

    if (!handbrake && planarSpeed > 220) {
      const slipRatio = Math.abs(localRightVel) / planarSpeed;
      if (slipRatio > 0.28 && (Math.abs(omegaYaw) > 1.15 || Math.abs(localRightVel) > 200)) {
        handbrake = true;
      }
    }
  } else {
    pitch = applyDeadzone(
      solveAerialAxisWithDamping(alphaPitch, omegaPitch, AERIAL_TORQUE_PITCH, AERIAL_DAMPING_PITCH),
      deadzone
    );
    yaw = applyDeadzone(
      solveAerialAxisWithDamping(alphaYaw, omegaYaw, AERIAL_TORQUE_YAW, AERIAL_DAMPING_YAW),
      deadzone
    );
    roll = applyDeadzone(
      solveAerialAxisWithDamping(alphaRoll, omegaRoll, AERIAL_TORQUE_ROLL, AERIAL_DAMPING_ROLL),
      deadzone
    );

    if (preferReplicated && Math.abs(currCar.controls.throttle) > 0.01) {
      throttle = clampUnit(currCar.controls.throttle);
    } else if (boost) {
      throttle = 1;
    } else {
      const airDriveAccel = nonGravityForwardAccel - (boost ? BOOST_ACCEL_AIR_UU : 0);
      throttle = applyDeadzone(airDriveAccel / THROTTLE_AIR_ACCEL_UU, 0.15);
    }

    steer =
      preferReplicated && Math.abs(currCar.controls.steer) > 0.01
        ? clampUnit(currCar.controls.steer)
        : yaw;
  }

  return { throttle, steer, pitch, yaw, roll, jump, boost, handbrake };
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
    if (!activeByFrame[i]) {
      result[i] = NEUTRAL_SYNTHESIZED_CONTROLS;
      continue;
    }
    let sThr = 0, sStr = 0, sPit = 0, sYaw = 0, sRol = 0, wSum = 0;
    for (let d = -radius; d <= radius; d++) {
      const idx = i + d;
      if (idx < 0 || idx >= count || !activeByFrame[idx]) continue;
      const w = radius + 1 - Math.abs(d);
      const c = rawByFrame[idx];
      sThr += c.throttle * w;
      sStr += c.steer * w;
      sPit += c.pitch * w;
      sYaw += c.yaw * w;
      sRol += c.roll * w;
      wSum += w;
    }
    const base = rawByFrame[i];
    result[i] =
      wSum <= 0
        ? base
        : {
            throttle: clampUnit(sThr / wSum),
            steer: clampUnit(sStr / wSum),
            pitch: clampUnit(sPit / wSum),
            yaw: clampUnit(sYaw / wSum),
            roll: clampUnit(sRol / wSum),
            jump: base.jump,
            boost: base.boost,
            handbrake: base.handbrake,
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

  const smoothRadius: 0 | 1 | 2 = options?.smoothWindowRadius ?? 1;
  const synthesizedBySlot: RLRCSynthesizedCarControls[][] = Array.from(
    { length: RLRC_MAX_PLAYER_SLOTS },
    () => new Array<RLRCSynthesizedCarControls>(frameCount).fill(NEUTRAL_SYNTHESIZED_CONTROLS)
  );
  const activeBySlot: boolean[][] = Array.from(
    { length: RLRC_MAX_PLAYER_SLOTS },
    () => new Array<boolean>(frameCount).fill(false)
  );

  for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
    for (let f = 0; f < frameCount; f++) {
      const currCar = frames[f].cars[slot];
      if (!currCar || !currCar.entityActive) continue;
      const prevCar = f > 0 ? frames[f - 1].cars[slot] : null;
      const nextCar = f + 1 < frameCount ? frames[f + 1].cars[slot] : null;
      activeBySlot[slot][f] = true;
      synthesizedBySlot[slot][f] = synthesizeCarControlsBetweenFrames(prevCar, currCar, nextCar, options);
    }
    synthesizedBySlot[slot] = smoothSlotControlsWindow(
      synthesizedBySlot[slot],
      activeBySlot[slot],
      smoothRadius
    );
  }

  return frames.map((srcFrame, f) => ({
    ...srcFrame,
    cars: srcFrame.cars.map((car, idx) => {
      const slot = car.slotIndex >= 0 && car.slotIndex < RLRC_MAX_PLAYER_SLOTS ? car.slotIndex : idx;
      const controls =
        slot >= 0 && slot < RLRC_MAX_PLAYER_SLOTS ? synthesizedBySlot[slot][f] : NEUTRAL_SYNTHESIZED_CONTROLS;
      return { ...car, controls };
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
    if (carIndex >= 0 && carIndex < MAX_PACKED_CAR_SLOTS) {
      packCarControlsToTrack64(out, carIndex, { ...car.controls });
    }
  }
  return out;
}

export function writeSynthesizedControlsToTrack0Buffer(
  frames: readonly RLRCFrame120Hz[],
  stateInputTrackBytes: Uint8Array
): void {
  const maxFrames = Math.min(
    frames.length,
    Math.floor(stateInputTrackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES)
  );
  for (let f = 0; f < maxFrames; f++) {
    const controlOffset = f * RLRC_TRACK0_FRAME_STRIDE_BYTES + RLRC_STATE_BYTES_PER_FRAME;
    packRLRCFrameControlsTo64Bytes(frames[f].cars, stateInputTrackBytes, controlOffset);
  }
}
