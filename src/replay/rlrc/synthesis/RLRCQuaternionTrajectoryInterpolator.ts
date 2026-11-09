/**
 * RLRCQuaternionTrajectoryInterpolator.ts
 * Angular-velocity-aware cubic Bezier/Hermite quaternion trajectory interpolation
 * (De Casteljau SLERP on SO(3)), shortest-arc SLERP, and NetStream angular velocity
 * secant calibration for 120Hz RLRC replay resampling.
 */

import type { RLRCQuat, RLRCVec3 } from '../RLRCReplayTypes.ts';

export interface RLRCOrthonormalBasis {
  readonly fwd: RLRCVec3;
  readonly right: RLRCVec3;
  readonly up: RLRCVec3;
}

export const IDENTITY_QUAT: RLRCQuat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
export const ZERO_ANGULAR_VEC: RLRCVec3 = Object.freeze({ x: 0, y: 0, z: 0 });

const clampUnitScalar = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const vecLength = (v: RLRCVec3): number => Math.hypot(v.x, v.y, v.z);

const vecScale = (v: RLRCVec3, scale: number): RLRCVec3 => ({
  x: v.x * scale,
  y: v.y * scale,
  z: v.z * scale,
});

const vecAdd = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

const vecSub = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

const vecLerp = (a: RLRCVec3, b: RLRCVec3, alpha: number): RLRCVec3 => ({
  x: a.x + (b.x - a.x) * alpha,
  y: a.y + (b.y - a.y) * alpha,
  z: a.z + (b.z - a.z) * alpha,
});

export function normalizeQuat(q: RLRCQuat): RLRCQuat {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return Number.isFinite(length) && length >= 1e-7
    ? { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length }
    : IDENTITY_QUAT;
}

export function conjugateQuat(q: RLRCQuat): RLRCQuat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function multiplyQuat(a: RLRCQuat, b: RLRCQuat): RLRCQuat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function dotQuat(a: RLRCQuat, b: RLRCQuat): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

export function negateQuat(q: RLRCQuat): RLRCQuat {
  return { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
}

export function expRotationVectorToQuat(rotationVector: RLRCVec3): RLRCQuat {
  const angle = vecLength(rotationVector);
  if (!Number.isFinite(angle) || angle < 1e-7) {
    return normalizeQuat({
      x: 0.5 * (Number.isFinite(rotationVector.x) ? rotationVector.x : 0),
      y: 0.5 * (Number.isFinite(rotationVector.y) ? rotationVector.y : 0),
      z: 0.5 * (Number.isFinite(rotationVector.z) ? rotationVector.z : 0),
      w: 1,
    });
  }
  const halfAngle = 0.5 * angle;
  const sinScale = Math.sin(halfAngle) / angle;
  return normalizeQuat({
    x: rotationVector.x * sinScale,
    y: rotationVector.y * sinScale,
    z: rotationVector.z * sinScale,
    w: Math.cos(halfAngle),
  });
}

export function logQuatToRotationVector(q: RLRCQuat): RLRCVec3 {
  const unit = normalizeQuat(q.w < 0 ? negateQuat(q) : q);
  const sinHalf = Math.hypot(unit.x, unit.y, unit.z);
  if (sinHalf < 1e-7) {
    return { x: 2 * unit.x, y: 2 * unit.y, z: 2 * unit.z };
  }
  const halfAngle = Math.atan2(sinHalf, clampUnitScalar(unit.w, -1, 1));
  const scale = (2 * halfAngle) / sinHalf;
  return {
    x: unit.x * scale,
    y: unit.y * scale,
    z: unit.z * scale,
  };
}

export function integrateQuatWorldAngularVelocity(
  q: RLRCQuat,
  worldOmega: RLRCVec3,
  dtSeconds: number
): RLRCQuat {
  const deltaQuat = expRotationVectorToQuat(vecScale(worldOmega, dtSeconds));
  return normalizeQuat(multiplyQuat(deltaQuat, q));
}

export function slerpShortestArcQuat(q0: RLRCQuat, q1: RLRCQuat, alpha: number): RLRCQuat {
  const t = clampUnitScalar(alpha, 0, 1);
  const a = normalizeQuat(q0);
  const b = normalizeQuat(q1);
  if (t <= 0) return a;
  if (t >= 1) return b;
  const rawDot = dotQuat(a, b);
  const sign = rawDot < 0 ? -1 : 1;
  const absDot = Math.abs(rawDot);
  let weight0 = 1 - t;
  let weight1 = t * sign;
  if (absDot <= 0.9995) {
    const theta = Math.acos(clampUnitScalar(absDot, -1, 1));
    const sinTheta = Math.sin(theta);
    if (Math.abs(sinTheta) < 1e-6) return a;
    const ratio1 = Math.sin(theta * t) / sinTheta;
    weight0 = Math.cos(theta * t) - absDot * ratio1;
    weight1 = ratio1 * sign;
  }
  return normalizeQuat({
    x: weight0 * a.x + weight1 * b.x,
    y: weight0 * a.y + weight1 * b.y,
    z: weight0 * a.z + weight1 * b.z,
    w: weight0 * a.w + weight1 * b.w,
  });
}

export function quatToBasisVectors(rotation: RLRCQuat): RLRCOrthonormalBasis {
  const { x, y, z, w } = normalizeQuat(rotation);
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return {
    fwd: { x: 1 - 2 * (yy + zz), y: 2 * (xy + wz), z: 2 * (xz - wy) },
    right: { x: 2 * (xy - wz), y: 1 - 2 * (xx + zz), z: 2 * (yz + wx) },
    up: { x: 2 * (xz + wy), y: 2 * (yz - wx), z: 1 - 2 * (xx + yy) },
  };
}

export function extractSecantWorldAngularVelocity(
  q0: RLRCQuat,
  q1: RLRCQuat,
  dtSeconds: number
): RLRCVec3 {
  if (dtSeconds <= 1e-6) return ZERO_ANGULAR_VEC;
  const a = normalizeQuat(q0);
  const b = normalizeQuat(q1);
  const deltaQuat = multiplyQuat(b, conjugateQuat(a));
  const rotationVector = logQuatToRotationVector(deltaQuat);
  return vecScale(rotationVector, 1 / dtSeconds);
}

export function calibrateAngularVelocitySample(
  rawOmega: RLRCVec3,
  secantOmega: RLRCVec3,
  maxOmegaRadPerSec = 9.0
): RLRCVec3 {
  const rawMag = vecLength(rawOmega);
  if (!Number.isFinite(rawMag) || rawMag <= 1e-6) return ZERO_ANGULAR_VEC;
  const secMag = vecLength(secantOmega);
  let calibrated = rawOmega;
  if (rawMag > 9.0) {
    const tenth = vecScale(rawOmega, 0.1);
    const errRaw = vecLength(vecSub(rawOmega, secantOmega));
    const errTenth = vecLength(vecSub(tenth, secantOmega));
    calibrated = errTenth <= errRaw || rawMag > maxOmegaRadPerSec * 1.5 ? tenth : rawOmega;
  } else if (secMag > 0.8 && rawMag > 0.08 && secMag / rawMag > 5.5 && secMag / rawMag < 15.0) {
    const tenX = vecScale(rawOmega, 10.0);
    if (vecLength(vecSub(tenX, secantOmega)) < vecLength(vecSub(rawOmega, secantOmega))) {
      calibrated = tenX;
    }
  }
  const calMag = vecLength(calibrated);
  return calMag > maxOmegaRadPerSec && calMag > 1e-6
    ? vecScale(calibrated, maxOmegaRadPerSec / calMag)
    : calibrated;
}

function clampAngularTangent(
  omega: RLRCVec3,
  secantOmega: RLRCVec3,
  maxOmegaRadPerSec: number
): RLRCVec3 {
  const secMag = vecLength(secantOmega);
  const maxDeviation = 0.65 * secMag + 2.5;
  const diff = vecSub(omega, secantOmega);
  const devMag = vecLength(diff);
  const clamped = vecAdd(
    secantOmega,
    devMag > maxDeviation && devMag > 1e-6 ? vecScale(diff, maxDeviation / devMag) : diff
  );
  const clampedMag = vecLength(clamped);
  return clampedMag > maxOmegaRadPerSec && clampedMag > 1e-6
    ? vecScale(clamped, maxOmegaRadPerSec / clampedMag)
    : clamped;
}

export interface RLRCQuaternionTrajectorySample {
  readonly rotation: RLRCQuat;
  readonly angularVelocity: RLRCVec3;
}

export function interpolateQuaternionHermiteTrajectory(
  q0Raw: RLRCQuat,
  omega0Raw: RLRCVec3,
  q1Raw: RLRCQuat,
  omega1Raw: RLRCVec3,
  alpha: number,
  dtSeconds: number,
  maxOmegaRadPerSec = 8.5
): RLRCQuaternionTrajectorySample {
  const tau = clampUnitScalar(alpha, 0, 1);
  const q0 = normalizeQuat(q0Raw);
  const q1 = normalizeQuat(q1Raw);
  const secantOmega = extractSecantWorldAngularVelocity(q0, q1, dtSeconds);
  const w0Cal = calibrateAngularVelocitySample(omega0Raw, secantOmega, maxOmegaRadPerSec);
  const w1Cal = calibrateAngularVelocitySample(omega1Raw, secantOmega, maxOmegaRadPerSec);

  if (tau <= 0 || dtSeconds <= 1e-6) {
    return { rotation: q0, angularVelocity: w0Cal };
  }
  if (tau >= 1) {
    return { rotation: q1, angularVelocity: w1Cal };
  }

  const w0 = clampAngularTangent(w0Cal, secantOmega, maxOmegaRadPerSec);
  const w1 = clampAngularTangent(w1Cal, secantOmega, maxOmegaRadPerSec);
  const meanOmega = vecScale(vecAdd(w0, w1), 0.5);

  const predictedEnd = integrateQuatWorldAngularVelocity(q0, meanOmega, dtSeconds);
  const rawDot = dotQuat(q0, q1);
  const predDot = dotQuat(predictedEnd, q1);
  const usePredHemisphere = vecLength(meanOmega) * dtSeconds > 0.25 && Math.abs(rawDot) < 0.7;
  const q1Aligned = (usePredHemisphere ? predDot < 0 : rawDot < 0) ? negateQuat(q1) : q1;

  const ctrl0 = q0;
  const ctrl1 = integrateQuatWorldAngularVelocity(q0, w0, dtSeconds / 3);
  const ctrl2 = integrateQuatWorldAngularVelocity(q1Aligned, w1, -dtSeconds / 3);
  const ctrl3 = q1Aligned;

  const lvl10 = slerpShortestArcQuat(ctrl0, ctrl1, tau);
  const lvl11 = slerpShortestArcQuat(ctrl1, ctrl2, tau);
  const lvl12 = slerpShortestArcQuat(ctrl2, ctrl3, tau);
  const lvl20 = slerpShortestArcQuat(lvl10, lvl11, tau);
  const lvl21 = slerpShortestArcQuat(lvl11, lvl12, tau);
  const rotation = slerpShortestArcQuat(lvl20, lvl21, tau);

  const linearOmega = vecLerp(w0, w1, tau);
  const tangentStep = multiplyQuat(lvl21, conjugateQuat(lvl20));
  const bezierOmega = vecScale(logQuatToRotationVector(tangentStep), 3 / dtSeconds);
  const blendedOmega = vecLerp(linearOmega, bezierOmega, 0.5);
  const blendedMag = vecLength(blendedOmega);
  const angularVelocity =
    blendedMag > maxOmegaRadPerSec && blendedMag > 1e-6
      ? vecScale(blendedOmega, maxOmegaRadPerSec / blendedMag)
      : blendedOmega;

  return { rotation, angularVelocity };
}
