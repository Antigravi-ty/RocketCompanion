/**
 * RLRCHermiteSlerpMathPipeline.ts
 * NetStream linear velocity calibration and Clamped Cubic Hermite rigid-body trajectory
 * interpolation (paired with RLRCQuaternionTrajectoryInterpolator) for RLRC replays.
 */

import {
  RLRC_FIXED_DT,
  type RLRCInterpolationMethod,
  type RLRCQuat,
  type RLRCRigidBodySample,
  type RLRCSynthesizedCarControls,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';
import {
  calibrateAngularVelocitySample,
  dotQuat,
  IDENTITY_QUAT,
  interpolateQuaternionHermiteTrajectory,
  slerpShortestArcQuat,
  ZERO_ANGULAR_VEC,
  type RLRCOrthonormalBasis,
} from './RLRCQuaternionTrajectoryInterpolator.ts';

export type { RLRCOrthonormalBasis };

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const v3 = (x: number, y: number, z: number): RLRCVec3 => ({ x, y, z });
export const vAxis = (fn: (axis: 'x' | 'y' | 'z') => number): RLRCVec3 =>
  v3(fn('x'), fn('y'), fn('z'));
export const vLen = (a: RLRCVec3): number => Math.hypot(a.x, a.y, a.z);
export const vAdd = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const vSub = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const vScale = (a: RLRCVec3, scale: number): RLRCVec3 =>
  v3(a.x * scale, a.y * scale, a.z * scale);
export const vDist = (a: RLRCVec3, b: RLRCVec3): number => vLen(vSub(a, b));
export const vLerp = (a: RLRCVec3, b: RLRCVec3, t: number): RLRCVec3 =>
  vAxis((axis) => lerp(a[axis], b[axis], t));

export const ID_QUAT: RLRCQuat = IDENTITY_QUAT;
export const ZERO_VEC: RLRCVec3 = ZERO_ANGULAR_VEC;
export const SLEEP_RB: RLRCRigidBodySample = Object.freeze({
  sleeping: true,
  position: ZERO_VEC,
  rotation: ID_QUAT,
  linearVelocity: ZERO_VEC,
  angularVelocity: ZERO_VEC,
});
export const ZERO_CTRL: RLRCSynthesizedCarControls = Object.freeze({
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
});
export const ZERO_FLAGS = Object.freeze({
  boostActive: false,
  jumpActive: false,
  doubleJumpActive: false,
  dodgeActive: false,
});

export function isRest(rb: RLRCRigidBodySample): boolean {
  return rb.sleeping || (vLen(rb.linearVelocity) <= 15 && vLen(rb.angularVelocity) <= 0.2);
}

export function toRest(rb: RLRCRigidBodySample): RLRCRigidBodySample {
  return rb.sleeping
    ? rb
    : { ...rb, sleeping: true, linearVelocity: ZERO_VEC, angularVelocity: ZERO_VEC };
}

export function isDupRb(a: RLRCRigidBodySample, b: RLRCRigidBodySample): boolean {
  const quatDot = dotQuat(a.rotation, b.rotation);
  return (
    a.sleeping === b.sleeping &&
    vDist(a.position, b.position) <= 1e-2 &&
    vDist(a.linearVelocity, b.linearVelocity) <= 1e-2 &&
    Math.abs(quatDot) > 0.99999
  );
}

export function calibrateNetStreamVel(vel: RLRCVec3, secantSpeed: number): RLRCVec3 {
  const speed = vLen(vel);
  return secantSpeed > 60 && speed > 2 && secantSpeed / speed > 5.0 && secantSpeed / speed < 16.0
    ? vScale(vel, 10)
    : vel;
}

export function sanitizeAngularVel(angularVelocity: RLRCVec3): RLRCVec3 {
  return calibrateAngularVelocitySample(angularVelocity, angularVelocity, 8.5);
}

function clampLinearTangent(vel: RLRCVec3, secantVel: RLRCVec3, maxSpeedUu: number): RLRCVec3 {
  const secantSpeed = vLen(secantVel);
  const scaled = calibrateNetStreamVel(vel, secantSpeed);
  const maxDeviation = 0.35 * secantSpeed + 90;
  const diff = vSub(scaled, secantVel);
  const devMag = vLen(diff);
  const tangent = vAdd(
    secantVel,
    devMag > maxDeviation && devMag > 1e-5 ? vScale(diff, maxDeviation / devMag) : diff
  );
  const speed = vLen(tangent);
  return speed > maxSpeedUu && speed > 1e-5 ? vScale(tangent, maxSpeedUu / speed) : tangent;
}

export function interpolateRigidBodyHermiteSlerp(
  s0: RLRCRigidBodySample,
  s1: RLRCRigidBodySample,
  alpha: number,
  dtSeconds: number,
  method: RLRCInterpolationMethod = 'hermite-clamped',
  maxSpeedUu = 4500
): RLRCRigidBodySample {
  const tau = clamp(alpha, 0, 1);
  if (tau <= 0 || dtSeconds <= 1e-6) return s0;
  if (tau >= 1) return s1;

  const rest0 = isRest(s0);
  const rest1 = isRest(s1);
  const maxOmegaRadPerSec = maxSpeedUu <= 2500 ? 7.5 : 8.5;

  if ((s0.sleeping && s1.sleeping) || isDupRb(s0, s1)) {
    return {
      sleeping: s0.sleeping && s1.sleeping,
      position: s0.position,
      rotation: s0.rotation,
      linearVelocity: rest0 ? ZERO_VEC : s0.linearVelocity,
      angularVelocity: rest0 ? ZERO_VEC : sanitizeAngularVel(s0.angularVelocity),
    };
  }

  const dt = Math.max(RLRC_FIXED_DT, dtSeconds);
  const p0 = s0.position;
  const p1 = s1.position;
  const secantVel = vScale(vSub(p1, p0), 1 / dt);
  const secantSpeed = vLen(secantVel);
  const v0 = rest0 ? ZERO_VEC : calibrateNetStreamVel(s0.linearVelocity, secantSpeed);
  const v1 = rest1 ? ZERO_VEC : calibrateNetStreamVel(s1.linearVelocity, secantSpeed);
  const rawOmega0 = rest0 ? ZERO_VEC : s0.angularVelocity;
  const rawOmega1 = rest1 ? ZERO_VEC : s1.angularVelocity;

  if (method === 'linear') {
    const rotation = slerpShortestArcQuat(s0.rotation, s1.rotation, tau);
    const angularVelocity = vLerp(
      sanitizeAngularVel(rawOmega0),
      sanitizeAngularVel(rawOmega1),
      tau
    );
    return {
      sleeping: false,
      position: vLerp(p0, p1, tau),
      rotation,
      linearVelocity: secantVel,
      angularVelocity,
    };
  }

  const { rotation, angularVelocity } = interpolateQuaternionHermiteTrajectory(
    s0.rotation,
    rawOmega0,
    s1.rotation,
    rawOmega1,
    tau,
    dt,
    maxOmegaRadPerSec
  );

  const vLinearBlend = vLerp(v0, v1, tau);
  const t0 = clampLinearTangent(v0, secantVel, maxSpeedUu);
  const t1 = clampLinearTangent(v1, secantVel, maxSpeedUu);
  const u2 = tau * tau;
  const u3 = u2 * tau;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = (u3 - 2 * u2 + tau) * dt;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = (u3 - u2) * dt;
  const dh00 = (6 * u2 - 6 * tau) / dt;
  const dh10 = 3 * u2 - 4 * tau + 1;
  const dh11 = 3 * u2 - 2 * tau;
  const minZ = Math.min(p0.z, p1.z) < 25 ? Math.min(p0.z, p1.z) - 1.5 : -Infinity;

  return {
    sleeping: false,
    position: vAxis((axis) =>
      Math.max(
        axis === 'z' ? minZ : -Infinity,
        h00 * p0[axis] + h10 * t0[axis] + h01 * p1[axis] + h11 * t1[axis]
      )
    ),
    rotation,
    linearVelocity: vAxis(
      (axis) =>
        0.5 *
        (vLinearBlend[axis] + dh00 * (p0[axis] - p1[axis]) + dh10 * t0[axis] + dh11 * t1[axis])
    ),
    angularVelocity,
  };
}
