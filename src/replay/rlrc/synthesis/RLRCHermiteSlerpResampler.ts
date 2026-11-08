/**
 * RLRCHermiteSlerpResampler.ts
 * Lifespan segment extraction, bracket search, bookmark alignment, and 120Hz timeline
 * resampling for RLRC replays.
 */

import {
  RLRC_BOOST_PAD_COUNT,
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_TICK_RATE,
  type RLRCBallFrameState120Hz,
  type RLRCBookmarkRecord,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCInterpolationMethod,
  type RLRCParserOutput,
  type RLRCResamplerOutput,
  type RLRCRigidBodySample,
  type RLRCSourceEntityLifeSegment,
  type RLRCSourceNetworkFrame,
} from '../RLRCReplayTypes.ts';
import {
  calibrateNetStreamVel,
  clamp,
  interpolateRigidBodyHermiteSlerp,
  isDupRb,
  isRest,
  lerp,
  packRLRCFramesToTrack0Bytes,
  SLEEP_RB,
  toRest,
  vAdd,
  vDist,
  vLen,
  vScale,
  vSub,
  ZERO_CTRL,
  ZERO_FLAGS,
  type RLRCOrthonormalBasis,
} from './RLRCHermiteSlerpMathPipeline.ts';

export type { RLRCOrthonormalBasis };

export interface RLRCResamplerOptions {
  readonly method?: RLRCInterpolationMethod;
  readonly boostPadCooldownsByFrame120Hz?: readonly Float32Array[];
  readonly maxTeleportDistanceUu?: number;
}

export interface RLRCEntitySpan {
  readonly startNetIdx: number;
  readonly endNetIdx: number;
  readonly keyframeIndices: readonly number[];
}

const getCar = (nf: RLRCSourceNetworkFrame, s: number): RLRCCarFrameState120Hz | undefined =>
  nf.cars[s]?.slotIndex === s ? nf.cars[s] : nf.cars.find((c) => c.slotIndex === s);

const getRb = (nf: RLRCSourceNetworkFrame, s: number | 'ball'): RLRCRigidBodySample =>
  s === 'ball' ? nf.ball.rigidBody : getCar(nf, s)?.rigidBody ?? SLEEP_RB;

function isRbUpd(nf: RLRCSourceNetworkFrame, s: number | 'ball'): boolean | undefined {
  const e = (s === 'ball' ? nf.ball : getCar(nf, s)) as { readonly rbUpdated?: boolean } | undefined;
  if (typeof e?.rbUpdated === 'boolean') return e.rbUpdated;
  const rb = getRb(nf, s) as { readonly rbUpdated?: boolean };
  if (typeof rb.rbUpdated === 'boolean') return rb.rbUpdated;
  const f = nf as {
    readonly ballRbUpdated?: boolean;
    readonly carRbUpdatedMask?: number;
    readonly rbUpdatedMask?: number;
    readonly rbUpdated?: number;
  };
  if (s === 'ball' && typeof f.ballRbUpdated === 'boolean') return f.ballRbUpdated;
  if (typeof s === 'number' && typeof f.carRbUpdatedMask === 'number') return ((f.carRbUpdatedMask >>> s) & 1) === 1;
  const m = typeof f.rbUpdatedMask === 'number' ? f.rbUpdatedMask : typeof f.rbUpdated === 'number' ? f.rbUpdated : undefined;
  return m !== undefined ? (((m >>> (s === 'ball' ? 6 : s)) & 1) === 1) : undefined;
}

function buildSpan(nfs: readonly RLRCSourceNetworkFrame[], raw: readonly number[], slot: number | 'ball'): RLRCEntitySpan {
  const kf: number[] = [];
  for (let r = 0; r < raw.length; r++) {
    const idx = raw[r];
    const p = kf[kf.length - 1];
    if (p === undefined) {
      kf.push(idx);
      continue;
    }
    const rbP = getRb(nfs[p], slot);
    const rbC = getRb(nfs[idx], slot);
    const dt = nfs[idx].timeSeconds - nfs[p].timeSeconds;
    if (dt <= 1e-5) {
      if (!isDupRb(rbP, rbC)) kf[kf.length - 1] = idx;
      continue;
    }
    if (!isDupRb(rbP, rbC)) {
      const prev = raw[r - 1];
      const hDt = nfs[prev].timeSeconds - nfs[p].timeSeconds;
      if (prev > p && hDt > 1e-5 && (isRest(rbP) || hDt >= 0.095 || isRbUpd(nfs[prev], slot) === true)) {
        kf.push(prev);
      }
      kf.push(idx);
    }
  }
  const end = raw[raw.length - 1];
  const last = kf[kf.length - 1];
  if (last !== undefined && end > last && nfs[end].timeSeconds > nfs[last].timeSeconds + 1e-5) {
    const rbL = getRb(nfs[last], slot);
    const hDt = nfs[end].timeSeconds - nfs[last].timeSeconds;
    if (isRest(rbL) || hDt >= 0.095 || isRbUpd(nfs[end], slot) === true) kf.push(end);
  }
  return { startNetIdx: raw[0], endNetIdx: end, keyframeIndices: kf };
}

export function extractEntityLifeSpans(
  nfs: readonly RLRCSourceNetworkFrame[],
  slot: number | 'ball',
  segsAll: readonly RLRCSourceEntityLifeSegment[],
  maxTel = 450
): RLRCEntitySpan[] {
  const segs = slot === 'ball' ? [] : segsAll.filter((s) => s.slotIndex === slot);
  const spans: RLRCEntitySpan[] = [];
  let raw: number[] = [];
  let curSeg = -1;
  let lastRb = -1;

  for (let i = 0; i < nfs.length; i++) {
    const nf = nfs[i];
    if (!(slot === 'ball' ? nf.ball.entityActive : Boolean(getCar(nf, slot)?.entityActive))) {
      if (raw.length) {
        spans.push(buildSpan(nfs, raw, slot));
        raw = [];
      }
      curSeg = -1;
      lastRb = -1;
      continue;
    }
    const si = segs.findIndex((s) => nf.sourceFrame30Hz >= s.startFrame30Hz && nf.sourceFrame30Hz <= s.endFrame30Hz);
    const segId = si >= 0 ? segs[si].carActorId * 100000 + si : -1;
    const prev = raw.length ? raw[raw.length - 1] : -1;
    const ko = i > 0 && nf.roundCountdownNumber > 0 && nfs[i - 1].roundCountdownNumber === 0;
    const ref = lastRb >= 0 ? lastRb : prev;
    const cRb = getRb(nf, slot);
    let tel = false;
    let jmp = false;
    if (prev >= 0 && ref >= 0) {
      const rNf = nfs[ref];
      const rRb = getRb(rNf, slot);
      const dt = clamp(nf.timeSeconds - rNf.timeSeconds, nf.deltaSeconds || 1 / 30, 0.12);
      const dist = vDist(cRb.position, rRb.position);
      const secSpd = dist / Math.max(dt, 1e-4);
      const vR = calibrateNetStreamVel(rRb.linearVelocity, secSpd);
      const vC = calibrateNetStreamVel(cRb.linearVelocity, secSpd);
      const e0 = vDist(cRb.position, vAdd(rRb.position, vScale(vR, dt)));
      const e1 = vDist(rRb.position, vSub(cRb.position, vScale(vC, dt)));
      const e2 = vDist(cRb.position, vAdd(rRb.position, vScale(vAdd(vR, vC), 0.5 * dt)));
      const err = Math.min(e0, e1, e2);
      tel = dist > maxTel && err > maxTel;
      jmp = tel || (dist > 25 && err > 40);
    }
    if (prev >= 0 && ((segs.length > 0 && segId !== curSeg) || ko || tel)) {
      if (!jmp) {
        const rRb = getRb(nfs[ref], slot);
        const pRef = raw.indexOf(ref);
        if (pRef > 0 && ref < i && isDupRb(rRb, cRb) && !isRest(rRb)) {
          spans.push(buildSpan(nfs, raw.slice(0, pRef + 1), slot));
          raw = raw.slice(pRef);
        } else {
          raw.push(i);
          spans.push(buildSpan(nfs, raw, slot));
          raw = [];
        }
      } else {
        spans.push(buildSpan(nfs, raw, slot));
        raw = [];
      }
    }
    if (!raw.length || isRbUpd(nf, slot) === true || (ref >= 0 && !isDupRb(getRb(nfs[ref], slot), cRb))) {
      lastRb = i;
    }
    raw.push(i);
    curSeg = segId;
  }
  if (raw.length) spans.push(buildSpan(nfs, raw, slot));
  return spans;
}

function locateBracket(
  nfs: readonly RLRCSourceNetworkFrame[],
  spans: readonly RLRCEntitySpan[],
  t: number,
  cur: number,
  near: number,
  slot: number | 'ball'
) {
  let sp =
    spans.find((s) => near >= s.startNetIdx && near <= s.endNetIdx && t >= nfs[s.startNetIdx].timeSeconds && t <= nfs[s.endNetIdx].timeSeconds) ??
    spans.find((s) => t >= nfs[s.startNetIdx].timeSeconds - 1e-4 && t <= nfs[s.endNetIdx].timeSeconds + 1e-4) ??
    spans.find((s) => near >= s.startNetIdx && near <= s.endNetIdx);
  if (!sp) {
    const spP = spans.find((s) => s.endNetIdx === cur);
    const spN = spans.find((s) => s.startNetIdx === cur + 1);
    if (spP && (spN || near === cur)) sp = spP;
    else if (spN && near === cur + 1) sp = spN;
  }
  if (!sp || !sp.keyframeIndices.length) return null;
  const kf = sp.keyframeIndices;
  const last = kf[kf.length - 1];
  if (kf.length === 1 || t <= nfs[kf[0]].timeSeconds) {
    return { k0Idx: kf[0], k1Idx: kf[0], alpha: 0, dt: 0, rest0: false, rest1: false };
  }
  if (t >= nfs[last].timeSeconds) {
    return { k0Idx: last, k1Idx: last, alpha: 0, dt: 0, rest0: false, rest1: false };
  }

  let lo = 0;
  let hi = kf.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (nfs[kf[mid]].timeSeconds <= t) lo = mid;
    else hi = mid;
  }
  const k0Idx = kf[lo];
  const k1Idx = kf[hi];
  const t0 = nfs[k0Idx].timeSeconds;
  const dt = nfs[k1Idx].timeSeconds - t0;
  const rb0 = getRb(nfs[k0Idx], slot);
  const rb1 = getRb(nfs[k1Idx], slot);
  return {
    k0Idx,
    k1Idx,
    alpha: dt > 1e-6 ? clamp((t - t0) / dt, 0, 1) : 0,
    dt,
    rest0: lo > 0 && isDupRb(getRb(nfs[kf[lo - 1]], slot), rb0),
    rest1: hi + 1 < kf.length && isDupRb(rb1, getRb(nfs[kf[hi + 1]], slot)),
  };
}

export function alignBookmarksTo120Hz(
  bms: readonly RLRCBookmarkRecord[],
  nfs: readonly RLRCSourceNetworkFrame[],
  frames: readonly RLRCFrame120Hz[],
  fps = 30
): RLRCBookmarkRecord[] {
  if (!frames.length) return [];
  const t0 = frames[0].timeSeconds;
  const maxIdx = frames.length - 1;
  const rFps = fps > 0 ? fps : 30;
  return bms.map((bm) => {
    let t = bm.timeSeconds;
    let best = nfs[0];
    for (const nf of nfs) {
      if (Math.abs(nf.sourceFrame30Hz - bm.sourceFrame30Hz) < Math.abs(best.sourceFrame30Hz - bm.sourceFrame30Hz)) {
        best = nf;
      }
    }
    if (best && (Math.abs(best.sourceFrame30Hz - bm.sourceFrame30Hz) <= 2 || !Number.isFinite(t) || t <= 0)) {
      t = best.timeSeconds;
    } else if (!Number.isFinite(t) || t <= 0) {
      t = t0 + bm.sourceFrame30Hz / rFps;
    }
    const idx = clamp(Math.round((t - t0) * RLRC_TICK_RATE), 0, maxIdx);
    return { ...bm, frameIndex120Hz: idx, timeSeconds: frames[idx].timeSeconds };
  });
}

export function resampleRLRCReplayTo120Hz(parsed: RLRCParserOutput, opts: RLRCResamplerOptions = {}): RLRCResamplerOutput {
  const method = opts.method ?? 'hermite-clamped';
  const maxTel = opts.maxTeleportDistanceUu ?? 450;
  const nfs = parsed.networkFrames;
  const slots = Math.min(RLRC_MAX_PLAYER_SLOTS, Math.max(parsed.roster.length, nfs[0]?.cars.length ?? 0));
  if (!nfs.length) {
    return {
      header: { ...parsed.header, frameCount120Hz: 0, durationSeconds: 0 },
      roster: parsed.roster,
      bookmarks: [],
      frames120Hz: [],
      stateInputTrackBytes: new Uint8Array(0),
    };
  }

  const t0 = nfs[0].timeSeconds;
  const tEnd = nfs[nfs.length - 1].timeSeconds;
  const dur = Math.max(0, tEnd - t0);
  const count = Math.max(1, Math.round(dur * RLRC_TICK_RATE) + 1);
  const bSpans = extractEntityLifeSpans(nfs, 'ball', parsed.lifeSegments, maxTel);
  const cSpans = Array.from({ length: slots }, (_, s) => extractEntityLifeSpans(nfs, s, parsed.lifeSegments, maxTel));
  const frames120Hz: RLRCFrame120Hz[] = new Array(count);

  for (let f = 0, cur = 0; f < count; f++) {
    const t = Math.min(tEnd, t0 + f * RLRC_FIXED_DT);
    while (cur + 1 < nfs.length && nfs[cur + 1].timeSeconds <= t) cur++;
    const nxt = nfs[cur + 1] ?? nfs[cur];
    const near = Math.abs(nxt.timeSeconds - t) < Math.abs(t - nfs[cur].timeSeconds) ? cur + 1 : cur;
    const ref = nfs[near];
    const bb = locateBracket(nfs, bSpans, t, cur, near, 'ball');
    const b0 = bb ? nfs[bb.k0Idx].ball.rigidBody : ref.ball.rigidBody;
    const b1 = bb ? nfs[bb.k1Idx].ball.rigidBody : ref.ball.rigidBody;
    const ball: RLRCBallFrameState120Hz = bb
      ? { entityActive: true, rigidBody: interpolateRigidBodyHermiteSlerp(bb.rest0 ? toRest(b0) : b0, bb.rest1 ? toRest(b1) : b1, bb.alpha, bb.dt, method, 4500) }
      : { entityActive: false, rigidBody: ref.ball.rigidBody };

    const cars: RLRCCarFrameState120Hz[] = new Array(slots);
    for (let s = 0; s < slots; s++) {
      const rCar = getCar(ref, s);
      const cb = locateBracket(nfs, cSpans[s], t, cur, near, s);
      if (cb && rCar) {
        const c0 = getCar(nfs[cb.k0Idx], s) ?? rCar;
        const c1 = getCar(nfs[cb.k1Idx], s) ?? rCar;
        const nCar = cb.alpha < 0.5 ? c0 : c1;
        const rb = interpolateRigidBodyHermiteSlerp(
          cb.rest0 ? toRest(c0.rigidBody) : c0.rigidBody,
          cb.rest1 ? toRest(c1.rigidBody) : c1.rigidBody,
          cb.alpha,
          cb.dt,
          method,
          2300
        );
        cars[s] = {
          slotIndex: s,
          entityActive: true,
          rigidBody: rb,
          boostAmount: clamp(lerp(c0.boostAmount, c1.boostAmount, cb.alpha), 0, 100),
          isOnGround: rb.position.z <= 20.5 || nCar.isOnGround,
          isSupersonic: vLen(rb.linearVelocity) >= 2200 || nCar.isSupersonic,
          hasFlipOrJump: nCar.hasFlipOrJump,
          airTimeSinceJump: lerp(c0.airTimeSinceJump, c1.airTimeSinceJump, cb.alpha),
          activeFlags: rCar.activeFlags,
          controls: rCar.controls,
        };
      } else {
        cars[s] = {
          slotIndex: s,
          entityActive: false,
          rigidBody: rCar ? rCar.rigidBody : SLEEP_RB,
          boostAmount: 0,
          isOnGround: false,
          isSupersonic: false,
          hasFlipOrJump: false,
          airTimeSinceJump: 0,
          activeFlags: ZERO_FLAGS,
          controls: ZERO_CTRL,
        };
      }
    }

    const pads = opts.boostPadCooldownsByFrame120Hz?.[f];
    const boostPadCooldowns =
      pads && pads.length >= RLRC_BOOST_PAD_COUNT ? pads.slice(0, RLRC_BOOST_PAD_COUNT) : new Float32Array(RLRC_BOOST_PAD_COUNT);
    const { sourceFrame30Hz, secondsRemaining, isOvertime, roundCountdownNumber, blueScore, orangeScore } = ref;
    frames120Hz[f] = {
      frameIndex120Hz: f,
      sourceFrame30Hz,
      timeSeconds: t,
      secondsRemaining,
      isOvertime,
      roundCountdownNumber,
      blueScore,
      orangeScore,
      ball,
      cars,
      boostPadCooldowns,
    };
  }

  return {
    header: { ...parsed.header, frameCount120Hz: count, durationSeconds: dur },
    roster: parsed.roster,
    bookmarks: alignBookmarksTo120Hz(parsed.bookmarks, nfs, frames120Hz, parsed.header.recordFps),
    frames120Hz,
    stateInputTrackBytes: packRLRCFramesToTrack0Bytes(frames120Hz),
  };
}
