/**
 * RLRCHermiteSlerpMathPipeline.ts
 * Pure quaternion SLERP, NetStream velocity calibration, Clamped Cubic Hermite
 * rigid-body interpolation, and binary Track 0 frame packing for RLRC replays.
 */

import { packCarControlsToTrack64 } from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_BOOST_PAD_COUNT,
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_BYTES_PER_FRAME,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCFrame120Hz,
  type RLRCInterpolationMethod,
  type RLRCQuat,
  type RLRCRigidBodySample,
  type RLRCSynthesizedCarControls,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export interface RLRCOrthonormalBasis {
  readonly fwd: RLRCVec3;
  readonly right: RLRCVec3;
  readonly up: RLRCVec3;
}

export const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const v3 = (x: number, y: number, z: number): RLRCVec3 => ({ x, y, z });
export const vAxis = (fn: (k: 'x' | 'y' | 'z') => number): RLRCVec3 =>
  v3(fn('x'), fn('y'), fn('z'));
export const vLen = (a: RLRCVec3): number => Math.hypot(a.x, a.y, a.z);
export const vAdd = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const vSub = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const vScale = (a: RLRCVec3, s: number): RLRCVec3 => v3(a.x * s, a.y * s, a.z * s);
export const vDist = (a: RLRCVec3, b: RLRCVec3): number => vLen(vSub(a, b));
export const vLerp = (a: RLRCVec3, b: RLRCVec3, t: number): RLRCVec3 =>
  vAxis((k) => lerp(a[k], b[k], t));

export const ID_QUAT: RLRCQuat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
export const ZERO_VEC: RLRCVec3 = Object.freeze(v3(0, 0, 0));
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
  const qd =
    a.rotation.x * b.rotation.x +
    a.rotation.y * b.rotation.y +
    a.rotation.z * b.rotation.z +
    a.rotation.w * b.rotation.w;
  return (
    a.sleeping === b.sleeping &&
    vDist(a.position, b.position) <= 1e-2 &&
    vDist(a.linearVelocity, b.linearVelocity) <= 1e-2 &&
    Math.abs(qd) > 0.99999
  );
}

export function normalizeQuat(q: RLRCQuat): RLRCQuat {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return Number.isFinite(l) && l >= 1e-7
    ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
    : ID_QUAT;
}

export function slerpShortestArcQuat(q0: RLRCQuat, q1: RLRCQuat, alpha: number): RLRCQuat {
  const t = clamp(alpha, 0, 1);
  const a = normalizeQuat(q0);
  const b = normalizeQuat(q1);
  if (t <= 0) return a;
  if (t >= 1) return b;
  const raw = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const sgn = raw < 0 ? -1 : 1;
  const dot = Math.abs(raw);
  let s0 = 1 - t;
  let s1 = t * sgn;
  if (dot <= 0.9995) {
    const th = Math.acos(clamp(dot, -1, 1));
    const sin = Math.sin(th);
    if (Math.abs(sin) < 1e-6) return a;
    const w1 = Math.sin(th * t) / sin;
    s0 = Math.cos(th * t) - dot * w1;
    s1 = w1 * sgn;
  }
  return normalizeQuat({
    x: s0 * a.x + s1 * b.x,
    y: s0 * a.y + s1 * b.y,
    z: s0 * a.z + s1 * b.z,
    w: s0 * a.w + s1 * b.w,
  });
}

export function quatToBasisVectors(rotation: RLRCQuat): RLRCOrthonormalBasis {
  const { x, y, z, w } = normalizeQuat(rotation);
  const xx = x * x,
    yy = y * y,
    zz = z * z;
  const xy = x * y,
    xz = x * z,
    yz = y * z;
  const wx = w * x,
    wy = w * y,
    wz = w * z;
  return {
    fwd: v3(1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy)),
    right: v3(2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx)),
    up: v3(2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)),
  };
}

export function calibrateNetStreamVel(v: RLRCVec3, secantSpeed: number): RLRCVec3 {
  const vs = vLen(v);
  return secantSpeed > 60 && vs > 2 && secantSpeed / vs > 5.0 && secantSpeed / vs < 16.0
    ? vScale(v, 10)
    : v;
}

export function sanitizeAngularVel(av: RLRCVec3): RLRCVec3 {
  return vLen(av) > 9.0 ? vScale(av, 0.1) : av;
}

function clampTan(vel: RLRCVec3, sec: RLRCVec3, maxSpd: number): RLRCVec3 {
  const scaled = calibrateNetStreamVel(vel, vLen(sec));
  const maxD = 0.35 * vLen(sec) + 90;
  const d = vSub(scaled, sec);
  const dev = vLen(d);
  const t = vAdd(sec, dev > maxD && dev > 1e-5 ? vScale(d, maxD / dev) : d);
  const spd = vLen(t);
  return spd > maxSpd && spd > 1e-5 ? vScale(t, maxSpd / spd) : t;
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
  const r0 = isRest(s0);
  const r1 = isRest(s1);
  if ((s0.sleeping && s1.sleeping) || isDupRb(s0, s1)) {
    return {
      sleeping: s0.sleeping && s1.sleeping,
      position: s0.position,
      rotation: s0.rotation,
      linearVelocity: r0 ? ZERO_VEC : s0.linearVelocity,
      angularVelocity: r0 ? ZERO_VEC : sanitizeAngularVel(s0.angularVelocity),
    };
  }

  const dt = Math.max(RLRC_FIXED_DT, dtSeconds);
  const p0 = s0.position;
  const p1 = s1.position;
  const sec = vScale(vSub(p1, p0), 1 / dt);
  const secSpeed = vLen(sec);
  const v0 = r0 ? ZERO_VEC : calibrateNetStreamVel(s0.linearVelocity, secSpeed);
  const v1 = r1 ? ZERO_VEC : calibrateNetStreamVel(s1.linearVelocity, secSpeed);
  const rotation = slerpShortestArcQuat(s0.rotation, s1.rotation, tau);
  const angularVelocity = vLerp(
    r0 ? ZERO_VEC : sanitizeAngularVel(s0.angularVelocity),
    r1 ? ZERO_VEC : sanitizeAngularVel(s1.angularVelocity),
    tau
  );
  const vLin = vLerp(v0, v1, tau);
  if (method === 'linear') {
    return {
      sleeping: false,
      position: vLerp(p0, p1, tau),
      rotation,
      linearVelocity: sec,
      angularVelocity,
    };
  }

  const t0 = clampTan(v0, sec, maxSpeedUu);
  const t1 = clampTan(v1, sec, maxSpeedUu);
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
    position: vAxis((k) =>
      Math.max(k === 'z' ? minZ : -Infinity, h00 * p0[k] + h10 * t0[k] + h01 * p1[k] + h11 * t1[k])
    ),
    rotation,
    linearVelocity: vAxis(
      (k) => 0.5 * (vLin[k] + dh00 * (p0[k] - p1[k]) + dh10 * t0[k] + dh11 * t1[k])
    ),
    angularVelocity,
  };
}

function writeRb18(
  dst: Float32Array,
  base: number,
  { position: p, rotation: r, linearVelocity: v, angularVelocity: w }: RLRCRigidBodySample
): void {
  const { fwd: f, right: rt, up: u } = quatToBasisVectors(r);
  dst.set(
    [p.x, p.y, p.z, f.x, f.y, f.z, rt.x, rt.y, rt.z, u.x, u.y, u.z, v.x, v.y, v.z, w.x, w.y, w.z],
    base
  );
}

export function packRLRCFramesToTrack0Bytes(frames120Hz: readonly RLRCFrame120Hz[]): Uint8Array {
  const out = new Uint8Array(frames120Hz.length * RLRC_TRACK0_FRAME_STRIDE_BYTES);
  const f32 = new Float32Array(RLRC_STATE_FLOATS_PER_FRAME);
  const f32Bytes = new Uint8Array(f32.buffer, 0, RLRC_STATE_BYTES_PER_FRAME);

  for (let f = 0; f < frames120Hz.length; f++) {
    const fr = frames120Hz[f];
    const off = f * RLRC_TRACK0_FRAME_STRIDE_BYTES;
    f32.fill(0);
    f32[0] = fr.frameIndex120Hz;
    f32[2] = Math.min(RLRC_MAX_PLAYER_SLOTS, fr.cars.length);
    f32[3] = RLRC_BOOST_PAD_COUNT;
    writeRb18(f32, 4, fr.ball.rigidBody);
    const ctrlSlice = out.subarray(
      off + RLRC_STATE_BYTES_PER_FRAME,
      off + RLRC_TRACK0_FRAME_STRIDE_BYTES
    );

    for (let c = 0; c < fr.cars.length && c < RLRC_MAX_PLAYER_SLOTS; c++) {
      const car = fr.cars[c];
      const base = 22 + car.slotIndex * 40;
      const fl = car.activeFlags;
      writeRb18(f32, base, car.rigidBody);
      f32[base + 18] = car.boostAmount;
      f32[base + 39] = 1;
      f32[416 + car.slotIndex * 4] = fl.jumpActive ? 1 : 0;
      f32[419 + car.slotIndex * 4] = car.airTimeSinceJump;
      if (car.entityActive) {
        f32.set(
          [
            car.isOnGround ? 1 : 0,
            car.isSupersonic ? 1 : 0,
            0,
            car.hasFlipOrJump ? 1 : 0,
            fl.boostActive ? 1 : 0,
            fl.dodgeActive ? 1 : 0,
          ],
          base + 19
        );
        packCarControlsToTrack64(ctrlSlice, car.slotIndex, { ...car.controls });
      } else {
        f32[base + 21] = 1;
      }
    }
    for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
      const cd = fr.boostPadCooldowns[p] ?? 0;
      f32[342 + p * 2] = cd <= 0 ? 1 : 0;
      f32[343 + p * 2] = Math.max(0, cd);
    }
    f32[410] = fr.ball.rigidBody.sleeping ? 1 : 0;
    out.set(f32Bytes, off);
  }
  return out;
}
