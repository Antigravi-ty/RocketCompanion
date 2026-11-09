/**
 * RLRCBoostSegmentSolverPipeline.ts
 * Pure mathematical solver for reconstructing continuous 30Hz per-slot boost curves
 * between sparse ReplicatedBoost anchors, boost active intervals, and pad pickups.
 */

import { RLRC_DEFAULT_SPAWN_BOOST } from './rlrcRigidBodyAttributePrimitives.ts';

export const RLRC_BOOST_CONSUMPTION_RATE_PER_SEC = 100 / 3;
export const RLRC_DEFAULT_INITIAL_BOOST = RLRC_DEFAULT_SPAWN_BOOST;
export const RLRC_BIG_PAD_GRANT_AMOUNT = 100;
export const RLRC_SMALL_PAD_GRANT_AMOUNT = 12;

export interface RLRCSlotFrameBoostSample {
  readonly t: number;
  readonly dt: number;
  readonly on: boolean;
  readonly carId: number;
  readonly spawned: boolean;
  readonly cdNum: number;
  readonly bOn: boolean;
  readonly anchor: number | null;
  readonly grantChg: boolean;
  readonly padGrant: number;
}

interface RLRCBoostAnchor {
  readonly fi: number;
  readonly boost: number;
  readonly grantChg: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function reconstructSlotBoostTimeline(
  sp: readonly RLRCSlotFrameBoostSample[],
  count: number
): Float64Array {
  const out = new Float64Array(count);
  const n = Math.min(sp.length, count);
  for (let fi = 0; fi < n;) {
    if (!sp[fi].on) {
      out[fi++] = 0;
      continue;
    }
    const s0 = fi;
    let s1 = fi;
    while (s1 + 1 < n && sp[s1 + 1].on) {
      const nx = sp[s1 + 1];
      const pr = sp[s1];
      if (
        nx.spawned ||
        (nx.carId >= 0 && pr.carId >= 0 && nx.carId !== pr.carId) ||
        (nx.cdNum > 0 && pr.cdNum === 0)
      ) {
        break;
      }
      s1++;
    }
    reconstructBoostSegment(sp, s0, s1, out);
    fi = s1 + 1;
  }
  return out;
}

function reconstructBoostSegment(
  sp: readonly RLRCSlotFrameBoostSample[],
  s0: number,
  s1: number,
  out: Float64Array
): void {
  const stepDt = (k: number): number => {
    const d = sp[k].t - sp[k - 1].t;
    return clamp(d > 1e-5 ? d : sp[k].dt > 1e-5 ? sp[k].dt : 1 / 30, 1 / 240, 0.25);
  };
  const stepAct = (k: number): number => {
    const dt = stepDt(k);
    return sp[k].bOn ? dt : sp[k - 1].bOn ? 0.5 * dt : 0;
  };

  const exp: RLRCBoostAnchor[] = [];
  for (let k = s0; k <= s1; k++) {
    if (sp[k].anchor !== null) {
      exp.push({ fi: k, boost: sp[k].anchor!, grantChg: sp[k].grantChg });
    }
  }

  let bInit = sp[s0].anchor ?? RLRC_DEFAULT_INITIAL_BOOST;
  if (sp[s0].anchor === null && exp.length > 0) {
    const fst = exp[0];
    let actSec = 0;
    let pads = 0;
    for (let k = s0 + 1; k <= fst.fi; k++) {
      actSec += stepAct(k);
      pads += sp[k].padGrant;
    }
    if (
      pads === 0 &&
      ((fst.fi - s0 <= 3 && actSec === 0) ||
        (!sp[s0].spawned && s0 === 0 && sp[0].cdNum === 0 && !fst.grantChg))
    ) {
      bInit = clamp(fst.boost + actSec * RLRC_BOOST_CONSUMPTION_RATE_PER_SEC, 0, 100);
    }
  }

  const anchors: RLRCBoostAnchor[] =
    exp.length > 0 && exp[0].fi === s0 ? exp : [{ fi: s0, boost: bInit, grantChg: false }, ...exp];
  out[s0] = anchors[0].boost;
  for (let m = 0; m + 1 < anchors.length; m++) {
    reconstructBoostSpan(
      sp,
      anchors[m].fi,
      anchors[m + 1].fi,
      anchors[m].boost,
      anchors[m + 1].boost,
      anchors[m + 1].grantChg,
      stepDt,
      stepAct,
      out
    );
  }

  const last = anchors[anchors.length - 1];
  let bCur = last.boost;
  out[last.fi] = bCur;
  for (let k = last.fi + 1; k <= s1; k++) {
    bCur = Math.max(0, bCur - stepAct(k) * RLRC_BOOST_CONSUMPTION_RATE_PER_SEC);
    if (sp[k].padGrant > 0) bCur = Math.min(100, bCur + sp[k].padGrant);
    out[k] = clamp(bCur, 0, 100);
  }
}

function reconstructBoostSpan(
  sp: readonly RLRCSlotFrameBoostSample[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  grantChg: boolean,
  stepDt: (k: number) => number,
  stepAct: (k: number) => number,
  out: Float64Array
): void {
  if (a1 <= a0) {
    out[a1] = b1;
    return;
  }
  let actSec = 0;
  let spanSec = 0;
  let midPads = 0;
  let bFwd = b0;
  for (let k = a0 + 1; k <= a1; k++) {
    const a = stepAct(k);
    actSec += a;
    spanSec += stepDt(k);
    bFwd = Math.max(0, bFwd - a * RLRC_BOOST_CONSUMPTION_RATE_PER_SEC);
    if (k < a1 && sp[k].padGrant > 0) {
      midPads += sp[k].padGrant;
      bFwd = Math.min(100, bFwd + sp[k].padGrant);
    }
    out[k] = clamp(bFwd, 0, 100);
  }
  const endPad = sp[a1].padGrant;

  if (!grantChg && midPads === 0 && endPad === 0 && b1 <= b0 + 0.5) {
    const drop = Math.max(0, b0 - b1);
    if (drop <= 1e-4) {
      for (let k = a0 + 1; k <= a1; k++) out[k] = b1;
      return;
    }
    if (actSec > 1e-5) {
      const nom = actSec * RLRC_BOOST_CONSUMPTION_RATE_PER_SEC;
      const actDrop = Math.min(drop, 2.2 * nom <= drop ? 1.8 * nom : drop);
      const remDrop = Math.max(0, drop - actDrop);
      let bCur = b0;
      for (let k = a0 + 1; k < a1; k++) {
        bCur -=
          actDrop * (stepAct(k) / actSec) +
          (remDrop > 0 && spanSec > 1e-5 ? remDrop * (stepDt(k) / spanSec) : 0);
        out[k] = clamp(bCur, b1, b0);
      }
      out[a1] = b1;
      return;
    }
    const win = Math.max(0.12, (drop / RLRC_BOOST_CONSUMPTION_RATE_PER_SEC) * 1.25);
    const tStart = Math.max(sp[a0].t, sp[a1].t - win);
    let rDur = 0;
    let bCur = b0;
    for (let k = a0 + 1; k <= a1; k++) if (sp[k].t > tStart) rDur += stepDt(k);
    for (let k = a0 + 1; k < a1; k++) {
      if (sp[k].t > tStart && rDur > 1e-5) bCur -= drop * (stepDt(k) / rDur);
      out[k] = clamp(bCur, b1, b0);
    }
    out[a1] = b1;
    return;
  }

  if (
    !grantChg &&
    midPads === 0 &&
    b1 < 99.0 &&
    (endPad === RLRC_SMALL_PAD_GRANT_AMOUNT || b1 > bFwd + 6.0)
  ) {
    const preTarget = Math.max(0, b1 - RLRC_SMALL_PAD_GRANT_AMOUNT);
    if (preTarget <= b0 + 0.5 && actSec > 1e-5) {
      const preDrop = Math.max(0, b0 - preTarget);
      if (preDrop <= 2.2 * actSec * RLRC_BOOST_CONSUMPTION_RATE_PER_SEC) {
        let bCur = b0;
        for (let k = a0 + 1; k < a1; k++) {
          bCur -= preDrop * (stepAct(k) / actSec);
          out[k] = clamp(bCur, preTarget, b0);
        }
      }
    }
  }
  out[a1] = b1;
}
