import {
  RLRC_BOOST_PAD_COUNT, RLRC_FIXED_DT, RLRC_MAX_PLAYER_SLOTS, RLRC_STATE_BYTES_PER_FRAME,
  RLRC_STATE_FLOATS_PER_FRAME, RLRC_TICK_RATE, RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCBallFrameState120Hz, type RLRCBookmarkRecord, type RLRCCarFrameState120Hz, type RLRCFrame120Hz,
  type RLRCInterpolationMethod, type RLRCParserOutput, type RLRCQuat, type RLRCResamplerOutput,
  type RLRCRigidBodySample, type RLRCSourceEntityLifeSegment, type RLRCSourceNetworkFrame,
  type RLRCSynthesizedCarControls, type RLRCVec3,
} from '../RLRCReplayTypes.ts';
import { packCarControlsToTrack64 } from '../../container/RCReplayBinarySchema.ts';

export interface RLRCResamplerOptions {
  readonly method?: RLRCInterpolationMethod;
  readonly boostPadCooldownsByFrame120Hz?: readonly Float32Array[];
  readonly maxTeleportDistanceUu?: number;
}
export interface RLRCOrthonormalBasis { readonly fwd: RLRCVec3; readonly right: RLRCVec3; readonly up: RLRCVec3 }
export interface RLRCEntitySpan { readonly startNetIdx: number; readonly endNetIdx: number; readonly keyframeIndices: readonly number[] }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v)), lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const v3 = (x: number, y: number, z: number): RLRCVec3 => ({ x, y, z }), vAx = (fn: (k: 'x' | 'y' | 'z') => number): RLRCVec3 => v3(fn('x'), fn('y'), fn('z'));
const vLen = (a: RLRCVec3): number => Math.hypot(a.x, a.y, a.z), vAdd = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const vSub = (a: RLRCVec3, b: RLRCVec3): RLRCVec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z), vSc = (a: RLRCVec3, s: number): RLRCVec3 => v3(a.x * s, a.y * s, a.z * s);
const vDist = (a: RLRCVec3, b: RLRCVec3): number => vLen(vSub(a, b)), vLerp = (a: RLRCVec3, b: RLRCVec3, t: number): RLRCVec3 => vAx((k) => lerp(a[k], b[k], t));

const ID_Q: RLRCQuat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 }), Z_V: RLRCVec3 = Object.freeze(v3(0, 0, 0));
const SLEEP_RB: RLRCRigidBodySample = Object.freeze({ sleeping: true, position: Z_V, rotation: ID_Q, linearVelocity: Z_V, angularVelocity: Z_V });
const Z_CTRL: RLRCSynthesizedCarControls = Object.freeze({ throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false });
const Z_FLG = Object.freeze({ boostActive: false, jumpActive: false, doubleJumpActive: false, dodgeActive: false });

export function normalizeQuat(q: RLRCQuat): RLRCQuat {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return Number.isFinite(l) && l >= 1e-7 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : ID_Q;
}

export function slerpShortestArcQuat(q0: RLRCQuat, q1: RLRCQuat, alpha: number): RLRCQuat {
  const t = clamp(alpha, 0, 1), a = normalizeQuat(q0), b = normalizeQuat(q1);
  if (t <= 0) return a; if (t >= 1) return b;
  const raw = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w, sgn = raw < 0 ? -1 : 1, dot = Math.abs(raw);
  let s0 = 1 - t, s1 = t * sgn;
  if (dot <= 0.9995) {
    const th = Math.acos(clamp(dot, -1, 1)), sin = Math.sin(th);
    if (Math.abs(sin) < 1e-6) return a;
    const w1 = Math.sin(th * t) / sin;
    s0 = Math.cos(th * t) - dot * w1; s1 = w1 * sgn;
  }
  return normalizeQuat({ x: s0 * a.x + s1 * b.x, y: s0 * a.y + s1 * b.y, z: s0 * a.z + s1 * b.z, w: s0 * a.w + s1 * b.w });
}

export function quatToBasisVectors(r: RLRCQuat): RLRCOrthonormalBasis {
  const { x, y, z, w } = normalizeQuat(r), xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return { fwd: v3(1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy)), right: v3(2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx)), up: v3(2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)) };
}

const scV10 = (v: RLRCVec3, sSpd: number): RLRCVec3 => {
  const vs = vLen(v); return sSpd > 60 && vs > 2 && sSpd / vs > 5.0 && sSpd / vs < 16.0 ? vSc(v, 10) : v;
};
const clTan = (vel: RLRCVec3, sec: RLRCVec3, maxS: number): RLRCVec3 => {
  const s = scV10(vel, vLen(sec)), maxD = 0.35 * vLen(sec) + 90, d = vSub(s, sec), dev = vLen(d);
  const t = vAdd(sec, dev > maxD && dev > 1e-5 ? vSc(d, maxD / dev) : d), spd = vLen(t);
  return spd > maxS && spd > 1e-5 ? vSc(t, maxS / spd) : t;
};
const sanAng = (av: RLRCVec3): RLRCVec3 => (vLen(av) > 9.0 ? vSc(av, 0.1) : av);

export function interpolateRigidBodyHermiteSlerp(
  s0: RLRCRigidBodySample, s1: RLRCRigidBodySample, alpha: number, dtSec: number,
  method: RLRCInterpolationMethod = 'hermite-clamped', maxSpd = 4500
): RLRCRigidBodySample {
  const tau = clamp(alpha, 0, 1);
  if (tau <= 0 || dtSec <= 1e-6) return s0; if (tau >= 1) return s1;
  if ((s0.sleeping && s1.sleeping) || isDup(s0, s1)) return { ...SLEEP_RB, sleeping: s0.sleeping && s1.sleeping, position: s0.position, rotation: s0.rotation };
  const dt = Math.max(RLRC_FIXED_DT, dtSec), p0 = s0.position, p1 = s1.position, sec = vSc(vSub(p1, p0), 1 / dt), secS = vLen(sec);
  const v0 = s0.sleeping ? Z_V : scV10(s0.linearVelocity, secS), v1 = s1.sleeping ? Z_V : scV10(s1.linearVelocity, secS);
  const rot = slerpShortestArcQuat(s0.rotation, s1.rotation, tau);
  const av = vLerp(s0.sleeping ? Z_V : sanAng(s0.angularVelocity), s1.sleeping ? Z_V : sanAng(s1.angularVelocity), tau), vL = vLerp(v0, v1, tau);
  if (method === 'linear') return { sleeping: false, position: vLerp(p0, p1, tau), rotation: rot, linearVelocity: sec, angularVelocity: av };
  const t0 = clTan(v0, sec, maxSpd), t1 = clTan(v1, sec, maxSpd), u2 = tau * tau, u3 = u2 * tau;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = (u3 - 2 * u2 + tau) * dt, h01 = -2 * u3 + 3 * u2, h11 = (u3 - u2) * dt;
  const dh00 = (6 * u2 - 6 * tau) / dt, dh10 = 3 * u2 - 4 * tau + 1, dh11 = 3 * u2 - 2 * tau, minZ = Math.min(p0.z, p1.z) < 25 ? Math.min(p0.z, p1.z) - 1.5 : -Infinity;
  return {
    sleeping: false, position: vAx((k) => Math.max(k === 'z' ? minZ : -Infinity, h00 * p0[k] + h10 * t0[k] + h01 * p1[k] + h11 * t1[k])),
    rotation: rot, linearVelocity: vAx((k) => 0.5 * (vL[k] + dh00 * (p0[k] - p1[k]) + dh10 * t0[k] + dh11 * t1[k])), angularVelocity: av,
  };
}

const getCar = (nf: RLRCSourceNetworkFrame, s: number): RLRCCarFrameState120Hz | undefined => nf.cars[s]?.slotIndex === s ? nf.cars[s] : nf.cars.find((c) => c.slotIndex === s);
const getRb = (nf: RLRCSourceNetworkFrame, s: number | 'ball'): RLRCRigidBodySample => (s === 'ball' ? nf.ball.rigidBody : getCar(nf, s)?.rigidBody ?? SLEEP_RB);
const isDup = (a: RLRCRigidBodySample, b: RLRCRigidBodySample): boolean => {
  const q = a.rotation, r = b.rotation;
  return a.sleeping === b.sleeping && vDist(a.position, b.position) <= 1e-2 && vDist(a.linearVelocity, b.linearVelocity) <= 1e-2 && Math.abs(q.x * r.x + q.y * r.y + q.z * r.z + q.w * r.w) > 0.99999;
};

function buildSpan(nfs: readonly RLRCSourceNetworkFrame[], raw: readonly number[], s: number | 'ball'): RLRCEntitySpan {
  const kf: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const idx = raw[i], p = kf[kf.length - 1];
    if (p === undefined) { kf.push(idx); continue; }
    if (nfs[idx].timeSeconds <= nfs[p].timeSeconds + 1e-5) continue;
    const pRb = getRb(nfs[p], s), cRb = getRb(nfs[idx], s), pr = raw[i - 1];
    if (!isDup(pRb, cRb)) {
      if (pr !== undefined && pr > p && (pRb.sleeping || vLen(pRb.linearVelocity) < 15 || idx - p > 4)) kf.push(pr);
      kf.push(idx);
    }
  }
  const last = raw[raw.length - 1];
  if (last !== undefined && kf[kf.length - 1] !== last && nfs[last].timeSeconds > nfs[kf[kf.length - 1]].timeSeconds + 1e-5) kf.push(last);
  return { startNetIdx: raw[0], endNetIdx: raw[raw.length - 1], keyframeIndices: kf };
}

export function extractEntityLifeSpans(nfs: readonly RLRCSourceNetworkFrame[], s: number | 'ball', segsAll: readonly RLRCSourceEntityLifeSegment[], maxTel = 900): RLRCEntitySpan[] {
  const segs = s === 'ball' ? [] : segsAll.filter((g) => g.slotIndex === s), spans: RLRCEntitySpan[] = [];
  let raw: number[] = [], curSeg = -1, lastUpd = -1;
  for (let i = 0; i < nfs.length; i++) {
    const nf = nfs[i];
    if (!(s === 'ball' ? nf.ball.entityActive : Boolean(getCar(nf, s)?.entityActive))) {
      if (raw.length) { spans.push(buildSpan(nfs, raw, s)); raw = []; }
      curSeg = lastUpd = -1; continue;
    }
    const si = segs.findIndex((g) => nf.sourceFrame30Hz >= g.startFrame30Hz && nf.sourceFrame30Hz <= g.endFrame30Hz);
    const segId = si >= 0 ? segs[si].carActorId * 100000 + si : -1, prev = raw.length ? raw[raw.length - 1] : -1;
    const ko = i > 0 && nf.roundCountdownNumber > 0 && nfs[i - 1].roundCountdownNumber === 0;
    let tel = false;
    if (prev >= 0) {
      const pNf = nfs[lastUpd >= 0 ? lastUpd : prev], pRb = getRb(pNf, s), cRb = getRb(nf, s), dt = Math.max(1 / 30, nf.timeSeconds - pNf.timeSeconds);
      const dist = vDist(cRb.position, pRb.position);
      tel = dist > maxTel && vDist(cRb.position, vAdd(pRb.position, vSc(scV10(pRb.linearVelocity, dist / dt), dt))) > maxTel;
    }
    if (prev >= 0 && ((segs.length > 0 && segId !== curSeg) || ko || tel)) { spans.push(buildSpan(nfs, raw, s)); raw = []; lastUpd = -1; }
    if (lastUpd < 0 || !isDup(getRb(nfs[lastUpd], s), getRb(nf, s))) lastUpd = i;
    raw.push(i); curSeg = segId;
  }
  if (raw.length) spans.push(buildSpan(nfs, raw, s));
  return spans;
}

function locateBracket(nfs: readonly RLRCSourceNetworkFrame[], spans: readonly RLRCEntitySpan[], t: number, cur: number, near: number) {
  let sp = spans.find((s) => t >= nfs[s.startNetIdx].timeSeconds - 1e-4 && t <= nfs[s.endNetIdx].timeSeconds + 1e-4);
  if (!sp) {
    const spP = spans.find((s) => s.endNetIdx === cur), spN = spans.find((s) => s.startNetIdx === cur + 1);
    if (spP && (spN || near === cur)) sp = spP; else if (spN && near === cur + 1) sp = spN;
  }
  const kf = sp?.keyframeIndices, last = kf ? kf[kf.length - 1] : -1;
  if (!kf || !kf.length) return null;
  if (kf.length === 1 || t <= nfs[kf[0]].timeSeconds) return { k0Idx: kf[0], k1Idx: kf[0], alpha: 0, dt: 0 };
  if (t >= nfs[last].timeSeconds) return { k0Idx: last, k1Idx: last, alpha: 0, dt: 0 };
  let lo = 0, hi = kf.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (nfs[kf[mid]].timeSeconds <= t) lo = mid; else hi = mid; }
  const k0Idx = kf[lo], k1Idx = kf[hi], t0 = nfs[k0Idx].timeSeconds, dt = nfs[k1Idx].timeSeconds - t0;
  return { k0Idx, k1Idx, alpha: dt > 1e-6 ? clamp((t - t0) / dt, 0, 1) : 0, dt };
}

export function alignBookmarksTo120Hz(bms: readonly RLRCBookmarkRecord[], nfs: readonly RLRCSourceNetworkFrame[], frames: readonly RLRCFrame120Hz[], fps = 30): RLRCBookmarkRecord[] {
  if (!frames.length) return [];
  const t0 = frames[0].timeSeconds, maxI = frames.length - 1, rF = fps > 0 ? fps : 30;
  return bms.map((bm) => {
    let t = bm.timeSeconds, b = nfs[0];
    for (const nf of nfs) if (Math.abs(nf.sourceFrame30Hz - bm.sourceFrame30Hz) < Math.abs(b.sourceFrame30Hz - bm.sourceFrame30Hz)) b = nf;
    if (b && (Math.abs(b.sourceFrame30Hz - bm.sourceFrame30Hz) <= 2 || !Number.isFinite(t) || t <= 0)) t = b.timeSeconds;
    else if (!Number.isFinite(t) || t <= 0) t = t0 + bm.sourceFrame30Hz / rF;
    const i = clamp(Math.round((t - t0) * RLRC_TICK_RATE), 0, maxI);
    return { ...bm, frameIndex120Hz: i, timeSeconds: frames[i].timeSeconds };
  });
}

const wrRb18 = (dst: Float32Array, b: number, { position: p, rotation: r, linearVelocity: v, angularVelocity: w }: RLRCRigidBodySample): void => {
  const { fwd: f, right: rt, up: u } = quatToBasisVectors(r);
  dst.set([p.x, p.y, p.z, f.x, f.y, f.z, rt.x, rt.y, rt.z, u.x, u.y, u.z, v.x, v.y, v.z, w.x, w.y, w.z], b);
};

export function packRLRCFramesToTrack0Bytes(frames: readonly RLRCFrame120Hz[]): Uint8Array {
  const out = new Uint8Array(frames.length * RLRC_TRACK0_FRAME_STRIDE_BYTES);
  const f32 = new Float32Array(RLRC_STATE_FLOATS_PER_FRAME), f32B = new Uint8Array(f32.buffer, 0, RLRC_STATE_BYTES_PER_FRAME);
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f], off = f * RLRC_TRACK0_FRAME_STRIDE_BYTES, ctrl = out.subarray(off + RLRC_STATE_BYTES_PER_FRAME, off + RLRC_TRACK0_FRAME_STRIDE_BYTES);
    f32.fill(0); f32[0] = fr.frameIndex120Hz; f32[2] = Math.min(RLRC_MAX_PLAYER_SLOTS, fr.cars.length); f32[3] = RLRC_BOOST_PAD_COUNT;
    wrRb18(f32, 4, fr.ball.rigidBody);
    for (let c = 0; c < fr.cars.length && c < RLRC_MAX_PLAYER_SLOTS; c++) {
      const car = fr.cars[c], s = car.slotIndex, b = 22 + s * 40, fl = car.activeFlags;
      wrRb18(f32, b, car.rigidBody); f32[b + 18] = car.boostAmount; f32[b + 39] = 1;
      f32[416 + s * 4] = fl.jumpActive ? 1 : 0; f32[419 + s * 4] = car.airTimeSinceJump;
      if (car.entityActive) {
        f32.set([car.isOnGround ? 1 : 0, car.isSupersonic ? 1 : 0, 0, car.hasFlipOrJump ? 1 : 0, fl.boostActive ? 1 : 0, fl.dodgeActive ? 1 : 0], b + 19);
        packCarControlsToTrack64(ctrl, s, { ...car.controls });
      } else f32[b + 21] = 1;
    }
    for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
      const cd = fr.boostPadCooldowns[p] ?? 0; f32[342 + p * 2] = cd <= 0 ? 1 : 0; f32[343 + p * 2] = Math.max(0, cd);
    }
    f32[410] = fr.ball.rigidBody.sleeping ? 1 : 0;
    out.set(f32B, off);
  }
  return out;
}

export function resampleRLRCReplayTo120Hz(p: RLRCParserOutput, opts: RLRCResamplerOptions = {}): RLRCResamplerOutput {
  const m = opts.method ?? 'hermite-clamped', maxT = opts.maxTeleportDistanceUu ?? 900, nfs = p.networkFrames;
  const slots = Math.min(RLRC_MAX_PLAYER_SLOTS, Math.max(p.roster.length, nfs[0]?.cars.length ?? 0));
  if (!nfs.length) return { header: { ...p.header, frameCount120Hz: 0, durationSeconds: 0 }, roster: p.roster, bookmarks: [], frames120Hz: [], stateInputTrackBytes: new Uint8Array(0) };
  const t0 = nfs[0].timeSeconds, tEnd = nfs[nfs.length - 1].timeSeconds, dur = Math.max(0, tEnd - t0), n = Math.max(1, Math.round(dur * RLRC_TICK_RATE) + 1);
  const bSp = extractEntityLifeSpans(nfs, 'ball', p.lifeSegments, maxT), cSp = Array.from({ length: slots }, (_, s) => extractEntityLifeSpans(nfs, s, p.lifeSegments, maxT));
  const zPads = new Float32Array(RLRC_BOOST_PAD_COUNT), frames: RLRCFrame120Hz[] = new Array(n);
  for (let f = 0, cur = 0; f < n; f++) {
    const t = Math.min(tEnd, t0 + f * RLRC_FIXED_DT);
    while (cur + 1 < nfs.length && nfs[cur + 1].timeSeconds <= t) cur++;
    const nxt = nfs[cur + 1] ?? nfs[cur], near = Math.abs(nxt.timeSeconds - t) < Math.abs(t - nfs[cur].timeSeconds) ? cur + 1 : cur, ref = nfs[near];
    const bb = locateBracket(nfs, bSp, t, cur, near);
    const ball: RLRCBallFrameState120Hz = bb
      ? { entityActive: true, rigidBody: interpolateRigidBodyHermiteSlerp(nfs[bb.k0Idx].ball.rigidBody, nfs[bb.k1Idx].ball.rigidBody, bb.alpha, bb.dt, m, 4500) }
      : { entityActive: false, rigidBody: ref.ball.rigidBody };
    const cars = Array.from({ length: slots }, (_, s): RLRCCarFrameState120Hz => {
      const rC = getCar(ref, s), cb = locateBracket(nfs, cSp[s], t, cur, near);
      if (!cb || !rC) return { slotIndex: s, entityActive: false, rigidBody: rC ? rC.rigidBody : SLEEP_RB, boostAmount: 0, isOnGround: false, isSupersonic: false, hasFlipOrJump: false, airTimeSinceJump: 0, activeFlags: Z_FLG, controls: Z_CTRL };
      const c0 = getCar(nfs[cb.k0Idx], s) ?? rC, c1 = getCar(nfs[cb.k1Idx], s) ?? rC, nC = cb.alpha < 0.5 ? c0 : c1;
      const rb = interpolateRigidBodyHermiteSlerp(c0.rigidBody, c1.rigidBody, cb.alpha, cb.dt, m, 2300);
      return {
        slotIndex: s, entityActive: true, rigidBody: rb, boostAmount: clamp(lerp(c0.boostAmount, c1.boostAmount, cb.alpha), 0, 100),
        isOnGround: rb.position.z <= 20.5 || nC.isOnGround, isSupersonic: vLen(rb.linearVelocity) >= 2200 || nC.isSupersonic,
        hasFlipOrJump: nC.hasFlipOrJump, airTimeSinceJump: lerp(c0.airTimeSinceJump, c1.airTimeSinceJump, cb.alpha), activeFlags: rC.activeFlags, controls: rC.controls,
      };
    });
    const pd = opts.boostPadCooldownsByFrame120Hz?.[f], boostPadCooldowns = pd && pd.length >= RLRC_BOOST_PAD_COUNT ? pd.slice(0, RLRC_BOOST_PAD_COUNT) : zPads;
    frames[f] = { ...ref, frameIndex120Hz: f, timeSeconds: t, ball, cars, boostPadCooldowns };
  }
  return {
    header: { ...p.header, frameCount120Hz: n, durationSeconds: dur }, roster: p.roster,
    bookmarks: alignBookmarksTo120Hz(p.bookmarks, nfs, frames, p.header.recordFps), frames120Hz: frames, stateInputTrackBytes: packRLRCFramesToTrack0Bytes(frames),
  };
}
