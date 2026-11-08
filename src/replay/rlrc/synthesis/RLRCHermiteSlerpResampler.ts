/** RLRCHermiteSlerpResampler.ts - ZOH deduplication and 120Hz Hermite/SLERP resampler. */

import {
  RLRC_BOOST_PAD_COUNT,
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_BYTES_PER_FRAME,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_TICK_RATE,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCBallFrameState120Hz,
  type RLRCBookmarkRecord,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCInterpolationMethod,
  type RLRCParserOutput,
  type RLRCQuat,
  type RLRCResamplerOutput,
  type RLRCRigidBodySample,
  type RLRCSourceEntityLifeSegment,
  type RLRCSourceNetworkFrame,
  type RLRCSynthesizedCarControls,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';
import { packCarControlsToTrack64 } from '../../container/RCReplayBinarySchema.ts';

export interface RLRCResamplerOptions {
  readonly method?: RLRCInterpolationMethod;
  readonly boostPadCooldownsByFrame120Hz?: readonly Float32Array[];
  readonly maxTeleportDistanceUu?: number;
}

export interface RLRCOrthonormalBasis {
  readonly fwd: RLRCVec3;
  readonly right: RLRCVec3;
  readonly up: RLRCVec3;
}

export interface RLRCEntitySpan {
  readonly startNetIdx: number;
  readonly endNetIdx: number;
  readonly keyframeIndices: readonly number[];
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const v3 = (x: number, y: number, z: number): RLRCVec3 => ({ x, y, z });
const vAxis = (fn: (k: 'x' | 'y' | 'z') => number): RLRCVec3 => v3(fn('x'), fn('y'), fn('z'));
const vLen = (a: RLRCVec3): number => Math.hypot(a.x, a.y, a.z);
const vAdd = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const vSub = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const vScale = (a: RLRCVec3, s: number): RLRCVec3 => v3(a.x * s, a.y * s, a.z * s);
const vDist = (a: RLRCVec3, b: RLRCVec3): number => vLen(vSub(a, b));
const vLerp = (a: RLRCVec3, b: RLRCVec3, t: number): RLRCVec3 => vAxis((k) => lerp(a[k], b[k], t));

const ID_QUAT: RLRCQuat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const ZERO_VEC: RLRCVec3 = Object.freeze(v3(0, 0, 0));
const SLEEP_RB: RLRCRigidBodySample = Object.freeze({
  sleeping: true, position: ZERO_VEC, rotation: ID_QUAT, linearVelocity: ZERO_VEC, angularVelocity: ZERO_VEC,
});
const ZERO_CTRL: RLRCSynthesizedCarControls = Object.freeze({
  throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false,
});
const ZERO_FLAGS = Object.freeze({
  boostActive: false, jumpActive: false, doubleJumpActive: false, dodgeActive: false,
});

export function normalizeQuat(q: RLRCQuat): RLRCQuat {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return Number.isFinite(l) && l >= 1e-7 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : ID_QUAT;
}

export function slerpShortestArcQuat(q0: RLRCQuat, q1: RLRCQuat, alpha: number): RLRCQuat {
  const t = clamp(alpha, 0, 1), a = normalizeQuat(q0), b = normalizeQuat(q1);
  if (t <= 0) return a;
  if (t >= 1) return b;
  const raw = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w, sgn = raw < 0 ? -1 : 1, dot = Math.abs(raw);
  let s0 = 1 - t, s1 = t * sgn;
  if (dot <= 0.9995) {
    const th = Math.acos(clamp(dot, -1, 1)), sin = Math.sin(th);
    if (Math.abs(sin) < 1e-6) return a;
    const w1 = Math.sin(th * t) / sin;
    s0 = Math.cos(th * t) - dot * w1;
    s1 = w1 * sgn;
  }
  return normalizeQuat({ x: s0 * a.x + s1 * b.x, y: s0 * a.y + s1 * b.y, z: s0 * a.z + s1 * b.z, w: s0 * a.w + s1 * b.w });
}

export function quatToBasisVectors(rotation: RLRCQuat): RLRCOrthonormalBasis {
  const { x, y, z, w } = normalizeQuat(rotation);
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return {
    fwd: v3(1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy)),
    right: v3(2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx)),
    up: v3(2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)),
  };
}

function clampTan(vel: RLRCVec3, sec: RLRCVec3, maxSpd: number): RLRCVec3 {
  const maxD = 1.5 * vLen(sec) + 320, d = vSub(vel, sec), dev = vLen(d);
  const t = vAdd(sec, dev > maxD && dev > 1e-5 ? vScale(d, maxD / dev) : d), spd = vLen(t);
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
  if (s0.sleeping && s1.sleeping) return { ...SLEEP_RB, position: s0.position, rotation: s0.rotation };

  const dt = Math.max(RLRC_FIXED_DT, dtSeconds), p0 = s0.position, p1 = s1.position;
  const v0 = s0.sleeping ? ZERO_VEC : s0.linearVelocity, v1 = s1.sleeping ? ZERO_VEC : s1.linearVelocity;
  const rotation = slerpShortestArcQuat(s0.rotation, s1.rotation, tau);
  const angularVelocity = vLerp(s0.sleeping ? ZERO_VEC : s0.angularVelocity, s1.sleeping ? ZERO_VEC : s1.angularVelocity, tau);
  const vLin = vLerp(v0, v1, tau);
  if (method === 'linear') return { sleeping: false, position: vLerp(p0, p1, tau), rotation, linearVelocity: vLin, angularVelocity };

  const sec = vScale(vSub(p1, p0), 1 / dt), t0 = clampTan(v0, sec, maxSpeedUu), t1 = clampTan(v1, sec, maxSpeedUu);
  const u2 = tau * tau, u3 = u2 * tau;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = (u3 - 2 * u2 + tau) * dt, h01 = -2 * u3 + 3 * u2, h11 = (u3 - u2) * dt;
  const dh00 = (6 * u2 - 6 * tau) / dt, dh10 = 3 * u2 - 4 * tau + 1, dh11 = 3 * u2 - 2 * tau;
  const minZ = Math.min(p0.z, p1.z) < 25 ? Math.min(p0.z, p1.z) - 1.5 : -Infinity;

  return {
    sleeping: false,
    position: vAxis((k) => Math.max(k === 'z' ? minZ : -Infinity, h00 * p0[k] + h10 * t0[k] + h01 * p1[k] + h11 * t1[k])),
    rotation,
    linearVelocity: vAxis((k) => 0.5 * (vLin[k] + dh00 * (p0[k] - p1[k]) + dh10 * t0[k] + dh11 * t1[k])),
    angularVelocity,
  };
}

const getCar = (nf: RLRCSourceNetworkFrame, s: number): RLRCCarFrameState120Hz | undefined =>
  nf.cars.find((c) => c.slotIndex === s) ?? nf.cars[s];
const getRb = (nf: RLRCSourceNetworkFrame, s: number | 'ball'): RLRCRigidBodySample =>
  s === 'ball' ? nf.ball.rigidBody : getCar(nf, s)?.rigidBody ?? SLEEP_RB;

function isDupRb(a: RLRCRigidBodySample, b: RLRCRigidBodySample): boolean {
  const qd = a.rotation.x * b.rotation.x + a.rotation.y * b.rotation.y + a.rotation.z * b.rotation.z + a.rotation.w * b.rotation.w;
  return a.sleeping === b.sleeping && vDist(a.position, b.position) <= 1e-2 && vDist(a.linearVelocity, b.linearVelocity) <= 1e-2 && Math.abs(qd) > 0.99999;
}

function buildSpan(nfs: readonly RLRCSourceNetworkFrame[], raw: readonly number[], slot: number | 'ball'): RLRCEntitySpan {
  const kf: number[] = [];
  for (const idx of raw) {
    const p = kf[kf.length - 1];
    if (p === undefined || (nfs[idx].timeSeconds > nfs[p].timeSeconds + 1e-5 && !isDupRb(getRb(nfs[p], slot), getRb(nfs[idx], slot)))) kf.push(idx);
  }
  return { startNetIdx: raw[0], endNetIdx: raw[raw.length - 1], keyframeIndices: kf };
}

export function extractEntityLifeSpans(nfs: readonly RLRCSourceNetworkFrame[], slot: number | 'ball', segsAll: readonly RLRCSourceEntityLifeSegment[], maxTel = 450): RLRCEntitySpan[] {
  const segs = slot === 'ball' ? [] : segsAll.filter((s) => s.slotIndex === slot);
  const spans: RLRCEntitySpan[] = [];
  let raw: number[] = [], curSeg = -1;

  for (let i = 0; i < nfs.length; i++) {
    const nf = nfs[i];
    if (!(slot === 'ball' ? nf.ball.entityActive : Boolean(getCar(nf, slot)?.entityActive))) {
      if (raw.length) { spans.push(buildSpan(nfs, raw, slot)); raw = []; }
      curSeg = -1;
      continue;
    }
    const si = segs.findIndex((s) => nf.sourceFrame30Hz >= s.startFrame30Hz && nf.sourceFrame30Hz <= s.endFrame30Hz);
    const segId = si >= 0 ? segs[si].carActorId * 100000 + si : -1, prev = raw.length ? raw[raw.length - 1] : -1;
    const kickoff = i > 0 && nf.roundCountdownNumber > 0 && nfs[i - 1].roundCountdownNumber === 0;
    let tel = false;
    if (prev >= 0) {
      const pNf = nfs[prev], pRb = getRb(pNf, slot), cRb = getRb(nf, slot), dt = Math.max(0, nf.timeSeconds - pNf.timeSeconds);
      tel = vDist(cRb.position, pRb.position) > maxTel && vDist(cRb.position, vAdd(pRb.position, vScale(pRb.linearVelocity, dt))) > maxTel;
    }
    if (prev >= 0 && ((segs.length > 0 && segId !== curSeg) || kickoff || tel)) {
      spans.push(buildSpan(nfs, raw, slot));
      raw = [];
    }
    raw.push(i);
    curSeg = segId;
  }
  if (raw.length) spans.push(buildSpan(nfs, raw, slot));
  return spans;
}

function locateBracket(nfs: readonly RLRCSourceNetworkFrame[], spans: readonly RLRCEntitySpan[], t: number, near: number) {
  const sp = spans.find((s) => near >= s.startNetIdx && near <= s.endNetIdx && t >= nfs[s.startNetIdx].timeSeconds - 1e-4 && t <= nfs[s.endNetIdx].timeSeconds + 1e-4);
  if (!sp || !sp.keyframeIndices.length) return null;
  const kf = sp.keyframeIndices, last = kf[kf.length - 1];
  if (kf.length === 1 || t <= nfs[kf[0]].timeSeconds) return { k0Idx: kf[0], k1Idx: kf[0], alpha: 0, dt: 0 };
  if (t >= nfs[last].timeSeconds) return { k0Idx: last, k1Idx: last, alpha: 0, dt: 0 };

  let lo = 0, hi = kf.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (nfs[kf[mid]].timeSeconds <= t) lo = mid;
    else hi = mid;
  }
  const k0Idx = kf[lo], k1Idx = kf[hi], t0 = nfs[k0Idx].timeSeconds, dt = nfs[k1Idx].timeSeconds - t0;
  return { k0Idx, k1Idx, alpha: dt > 1e-6 ? clamp((t - t0) / dt, 0, 1) : 0, dt };
}

export function alignBookmarksTo120Hz(bms: readonly RLRCBookmarkRecord[], nfs: readonly RLRCSourceNetworkFrame[], frames: readonly RLRCFrame120Hz[], fps = 30): RLRCBookmarkRecord[] {
  if (!frames.length) return [];
  const t0 = frames[0].timeSeconds, maxIdx = frames.length - 1, rFps = fps > 0 ? fps : 30;
  return bms.map((bm) => {
    let t = bm.timeSeconds, best = nfs[0];
    for (const nf of nfs) if (Math.abs(nf.sourceFrame30Hz - bm.sourceFrame30Hz) < Math.abs(best.sourceFrame30Hz - bm.sourceFrame30Hz)) best = nf;
    if (best && (Math.abs(best.sourceFrame30Hz - bm.sourceFrame30Hz) <= 2 || !Number.isFinite(t) || t <= 0)) t = best.timeSeconds;
    else if (!Number.isFinite(t) || t <= 0) t = t0 + bm.sourceFrame30Hz / rFps;
    const idx = clamp(Math.round((t - t0) * RLRC_TICK_RATE), 0, maxIdx);
    return { ...bm, frameIndex120Hz: idx, timeSeconds: frames[idx].timeSeconds };
  });
}

function writeRb18(dst: Float32Array, base: number, { position: p, rotation: r, linearVelocity: v, angularVelocity: w }: RLRCRigidBodySample): void {
  const { fwd: f, right: rt, up: u } = quatToBasisVectors(r);
  dst.set([p.x, p.y, p.z, f.x, f.y, f.z, rt.x, rt.y, rt.z, u.x, u.y, u.z, v.x, v.y, v.z, w.x, w.y, w.z], base);
}

export function packRLRCFramesToTrack0Bytes(frames120Hz: readonly RLRCFrame120Hz[]): Uint8Array {
  const out = new Uint8Array(frames120Hz.length * RLRC_TRACK0_FRAME_STRIDE_BYTES);
  const f32 = new Float32Array(RLRC_STATE_FLOATS_PER_FRAME), f32Bytes = new Uint8Array(f32.buffer, 0, RLRC_STATE_BYTES_PER_FRAME);

  for (let f = 0; f < frames120Hz.length; f++) {
    const fr = frames120Hz[f], off = f * RLRC_TRACK0_FRAME_STRIDE_BYTES;
    f32.fill(0);
    f32[0] = fr.frameIndex120Hz;
    f32[2] = Math.min(RLRC_MAX_PLAYER_SLOTS, fr.cars.length);
    f32[3] = RLRC_BOOST_PAD_COUNT;
    writeRb18(f32, 4, fr.ball.rigidBody);
    const ctrlSlice = out.subarray(off + RLRC_STATE_BYTES_PER_FRAME, off + RLRC_TRACK0_FRAME_STRIDE_BYTES);

    for (let c = 0; c < fr.cars.length && c < RLRC_MAX_PLAYER_SLOTS; c++) {
      const car = fr.cars[c], base = 22 + car.slotIndex * 40, fl = car.activeFlags;
      writeRb18(f32, base, car.rigidBody);
      f32[base + 18] = car.boostAmount;
      f32[base + 39] = 1;
      f32[416 + car.slotIndex * 4] = fl.jumpActive ? 1 : 0;
      f32[419 + car.slotIndex * 4] = car.airTimeSinceJump;
      if (car.entityActive) {
        f32.set([car.isOnGround ? 1 : 0, car.isSupersonic ? 1 : 0, 0, car.hasFlipOrJump ? 1 : 0, fl.boostActive ? 1 : 0, fl.dodgeActive ? 1 : 0], base + 19);
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

export function resampleRLRCReplayTo120Hz(parsed: RLRCParserOutput, opts: RLRCResamplerOptions = {}): RLRCResamplerOutput {
  const method = opts.method ?? 'hermite-clamped', maxTel = opts.maxTeleportDistanceUu ?? 450, nfs = parsed.networkFrames;
  const slots = Math.min(RLRC_MAX_PLAYER_SLOTS, Math.max(parsed.roster.length, nfs[0]?.cars.length ?? 0));
  if (!nfs.length) {
    return { header: { ...parsed.header, frameCount120Hz: 0, durationSeconds: 0 }, roster: parsed.roster, bookmarks: [], frames120Hz: [], stateInputTrackBytes: new Uint8Array(0) };
  }

  const t0 = nfs[0].timeSeconds, tEnd = nfs[nfs.length - 1].timeSeconds, dur = Math.max(0, tEnd - t0);
  const count = Math.max(1, Math.round(dur * RLRC_TICK_RATE) + 1);
  const bSpans = extractEntityLifeSpans(nfs, 'ball', parsed.lifeSegments, maxTel);
  const cSpans = Array.from({ length: slots }, (_, s) => extractEntityLifeSpans(nfs, s, parsed.lifeSegments, maxTel));
  const frames120Hz: RLRCFrame120Hz[] = new Array(count);
  let cur = 0;

  for (let f = 0; f < count; f++) {
    const t = Math.min(tEnd, t0 + f * RLRC_FIXED_DT);
    while (cur + 1 < nfs.length && nfs[cur + 1].timeSeconds <= t) cur++;
    const nxt = nfs[cur + 1] ?? nfs[cur], near = Math.abs(nxt.timeSeconds - t) < Math.abs(t - nfs[cur].timeSeconds) ? cur + 1 : cur;
    const ref = nfs[near], bb = locateBracket(nfs, bSpans, t, near);
    const ball: RLRCBallFrameState120Hz = bb
      ? { entityActive: true, rigidBody: interpolateRigidBodyHermiteSlerp(nfs[bb.k0Idx].ball.rigidBody, nfs[bb.k1Idx].ball.rigidBody, bb.alpha, bb.dt, method, 4500) }
      : { entityActive: false, rigidBody: ref.ball.rigidBody };

    const cars: RLRCCarFrameState120Hz[] = new Array(slots);
    for (let s = 0; s < slots; s++) {
      const rCar = getCar(ref, s), cb = locateBracket(nfs, cSpans[s], t, near);
      if (cb && rCar) {
        const c0 = getCar(nfs[cb.k0Idx], s) ?? rCar, c1 = getCar(nfs[cb.k1Idx], s) ?? rCar, nCar = cb.alpha < 0.5 ? c0 : c1;
        const rb = interpolateRigidBodyHermiteSlerp(c0.rigidBody, c1.rigidBody, cb.alpha, cb.dt, method, 2300);
        cars[s] = {
          slotIndex: s, entityActive: true, rigidBody: rb,
          boostAmount: clamp(lerp(c0.boostAmount, c1.boostAmount, cb.alpha), 0, 100),
          isOnGround: rb.position.z <= 20.5 || nCar.isOnGround,
          isSupersonic: vLen(rb.linearVelocity) >= 2200 || nCar.isSupersonic,
          hasFlipOrJump: nCar.hasFlipOrJump,
          airTimeSinceJump: lerp(c0.airTimeSinceJump, c1.airTimeSinceJump, cb.alpha),
          activeFlags: rCar.activeFlags, controls: rCar.controls,
        };
      } else {
        cars[s] = { slotIndex: s, entityActive: false, rigidBody: rCar ? rCar.rigidBody : SLEEP_RB, boostAmount: 0, isOnGround: false, isSupersonic: false, hasFlipOrJump: false, airTimeSinceJump: 0, activeFlags: ZERO_FLAGS, controls: ZERO_CTRL };
      }
    }

    const pads = opts.boostPadCooldownsByFrame120Hz?.[f];
    const boostPadCooldowns = pads && pads.length >= RLRC_BOOST_PAD_COUNT ? pads.slice(0, RLRC_BOOST_PAD_COUNT) : new Float32Array(RLRC_BOOST_PAD_COUNT);
    const { sourceFrame30Hz, secondsRemaining, isOvertime, roundCountdownNumber, blueScore, orangeScore } = ref;
    frames120Hz[f] = { frameIndex120Hz: f, sourceFrame30Hz, timeSeconds: t, secondsRemaining, isOvertime, roundCountdownNumber, blueScore, orangeScore, ball, cars, boostPadCooldowns };
  }

  return {
    header: { ...parsed.header, frameCount120Hz: count, durationSeconds: dur },
    roster: parsed.roster,
    bookmarks: alignBookmarksTo120Hz(parsed.bookmarks, nfs, frames120Hz, parsed.header.recordFps),
    frames120Hz,
    stateInputTrackBytes: packRLRCFramesToTrack0Bytes(frames120Hz),
  };
}
