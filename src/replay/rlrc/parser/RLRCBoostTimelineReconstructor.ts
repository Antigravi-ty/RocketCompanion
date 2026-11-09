/**
 * RLRCBoostTimelineReconstructor.ts
 * Reconstructs continuous 30Hz/120Hz per-slot boost timelines from sparse Rocket League
 * `.replay` NetStream `ReplicatedBoost` anchors, `ReplicatedActive` boost component edges
 * (33.3333%/s consumption rate), `grant_count` resets, and 34-pad pickup events.
 */

import {
 RLRC_MAX_PLAYER_SLOTS as MAX_SLOTS,
 type RLRCCarFrameState120Hz,
 type RLRCSourceNetworkFrame,
 type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export const RLRC_BOOST_CONSUMPTION_RATE_PER_SEC = 100 / 3;
export const RLRC_DEFAULT_INITIAL_BOOST = 33.333;
export const RLRC_BIG_PAD_GRANT_AMOUNT = 100;
export const RLRC_SMALL_PAD_GRANT_AMOUNT = 12;

const MAX_PAD_MATCH_SQ = 450 * 450, CAR_PAD_PROX_SQ = 280 * 280;

const PADS_XY: ReadonlyArray<readonly [number, number, boolean]> = [
 [-3584, 0, true], [3584, 0, true], [-3072, 4096, true], [3072, 4096, true], [-3072, -4096, true], [3072, -4096, true],
 [0, -4240, false], [-1792, -4184, false], [1792, -4184, false], [-940, -3308, false], [940, -3308, false], [0, -2816, false],
 [-3584, -2484, false], [3584, -2484, false], [-1788, -2300, false], [1788, -2300, false], [-2048, -1036, false], [0, -1024, false],
 [2048, -1036, false], [-1024, 0, false], [1024, 0, false], [-2048, 1036, false], [0, 1024, false], [2048, 1036, false],
 [-1788, 2300, false], [1788, 2300, false], [-3584, 2484, false], [3584, 2484, false], [0, 2816, false], [-940, 3308, false],
 [940, 3308, false], [-1792, 4184, false], [1792, 4184, false], [0, 4240, false],
];

export interface RLRCDecodedBoostAttribute {
 readonly boostAmount: number;
 readonly grantCount: number | null;
}

export interface RLRCDecodedPickupAttribute {
 readonly instigatorCarActorId: number;
 readonly pickedUp: boolean;
}

export interface RLRCMutableSlotComponentState {
 boost: number; bOn: boolean; jOn: boolean; dOn: boolean; dgOn: boolean; jT: number; flipped: boolean;
}

interface RLRCSlotFrameBoostSample {
 t: number; dt: number; on: boolean; carId: number; spawned: boolean; cdNum: number;
 bOn: boolean; anchor: number | null; grantChg: boolean; padGrant: number;
}

interface RLRCBoostAnchor {
 readonly fi: number; readonly boost: number; readonly grantChg: boolean;
}

const rec = (v: unknown): Record<string, unknown> | null =>
 typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function decodeReplicatedBoostAttribute(raw: unknown): RLRCDecodedBoostAttribute | null {
 const o = rec(raw), rp = rec(o?.ReplicatedBoost) ?? o;
 const b = typeof raw === 'number' ? raw : (rp?.boost_amount ?? rp?.boostAmount ?? o?.Byte);
 if (typeof b !== 'number' || !Number.isFinite(b)) return null;
 const boostAmount = (clamp(b, 0, 255) / 255) * 100, g = rp?.grant_count ?? rp?.grantCount;
 return { boostAmount, grantCount: typeof g === 'number' && Number.isFinite(g) ? Math.trunc(g) : null };
}

export function decodeReplicatedPickupAttribute(raw: unknown): RLRCDecodedPickupAttribute | null {
 const o = rec(raw), pk = rec(o?.PickupNew ?? o?.Pickup ?? o?.NewReplicatedPickupData ?? o?.ReplicatedPickupData) ?? o;
 if (!pk) return null;
 const pRaw = pk.pickedUp ?? pk.picked_up;
 let pickedUp = false;
 if (typeof pRaw === 'boolean') pickedUp = pRaw;
 else if (typeof pRaw === 'number' && Number.isFinite(pRaw)) pickedUp = (pRaw & 0xff) !== 0 && (pRaw & 0xff) !== 255;
 else return null;

 let instId = -1;
 const ir = pk.instigator ?? pk.instigator_id ?? pk.instigatorId, io = rec(ir);
 if (typeof ir === 'number' && Number.isFinite(ir)) instId = Math.trunc(ir);
 else if (io && io.active !== false && typeof io.actor === 'number') instId = Math.trunc(io.actor);
 return { instigatorCarActorId: instId, pickedUp };
}

export function applyComponentActiveFlag(slot: RLRCMutableSlotComponentState, compType: string, act: boolean, t: number): void {
 if (compType.includes('Boost')) slot.bOn = act;
 else if (compType.includes('DoubleJump')) { slot.dOn = act; if (act) slot.flipped = true; }
 else if (compType.includes('Dodge')) { slot.dgOn = act; if (act) slot.flipped = true; }
 else if (compType.includes('Jump')) { slot.jOn = act; if (act) slot.jT = t; }
}

export class RLRCBoostTimelineReconstructor {
 private readonly samples: RLRCSlotFrameBoostSample[][] = Array.from({ length: MAX_SLOTS }, () => []);
 private readonly lastGrant = new Int32Array(MAX_SLOTS).fill(-1);
 private readonly pendAnchor: Array<number | null> = new Array(MAX_SLOTS).fill(null);
 private readonly pendGrantChg: boolean[] = new Array(MAX_SLOTS).fill(false);
 private readonly pendPadGrant = new Float64Array(MAX_SLOTS);
 private readonly pendSpawn: boolean[] = new Array(MAX_SLOTS).fill(false);
 private readonly compCar = new Map<number, number>();
 private readonly compBoost = new Map<number, { decoded: RLRCDecodedBoostAttribute; fi: number }>();
 private readonly compAct = new Map<number, { act: boolean; fi: number }>();
 private readonly actorToPad = new Map<number, number>();
 private readonly padToActor = new Map<number, number>();
 private readonly boundPads = new Set<number>();

 public beginFrame(): void {
  this.pendAnchor.fill(null); this.pendGrantChg.fill(false); this.pendPadGrant.fill(0); this.pendSpawn.fill(false);
 }

 public deleteActor(id: number): void {
  this.compCar.delete(id); this.compBoost.delete(id); this.compAct.delete(id);
  const padIdx = this.actorToPad.get(id);
  if (padIdx !== undefined) {
   this.actorToPad.delete(id);
   if (this.padToActor.get(padIdx) === id) { this.padToActor.delete(padIdx); this.boundPads.delete(padIdx); }
  }
 }

 public bindComponentCar(
  compId: number, carId: number, fi: number, t: number, compType: string,
  cSlot: (cid: number) => number, slots: readonly RLRCMutableSlotComponentState[]
 ): void {
  if (carId < 0) {
   this.compCar.delete(compId);
   return;
  }
  this.compCar.set(compId, carId);
  const idx = cSlot(carId);
  if (idx < 0 || idx >= MAX_SLOTS) return;
  const cb = this.compBoost.get(compId);
  if (cb && fi - cb.fi <= 1) slots[idx].boost = this.recordBoostForSlot(idx, cb.decoded);
  const ca = this.compAct.get(compId);
  if (ca && fi - ca.fi <= 1) applyComponentActiveFlag(slots[idx], compType, ca.act, t);
 }

 public resolveOwnerCarId(actorId: number): number {
  return this.compCar.get(actorId) ?? actorId;
 }

 public onSlotCarSpawn(
  idx: number, carId: number, fi: number, t: number,
  slot: RLRCMutableSlotComponentState, aType: ReadonlyMap<number, string>
 ): void {
  if (idx < 0 || idx >= MAX_SLOTS) return;
  this.pendSpawn[idx] = true;
  this.lastGrant[idx] = -1;
  const direct = this.compBoost.get(carId);
  if (direct && fi - direct.fi <= 1) slot.boost = this.recordBoostForSlot(idx, direct.decoded);
  for (const [compId, vId] of this.compCar.entries()) {
   if (vId !== carId) continue;
   const cb = this.compBoost.get(compId);
   if (cb && fi - cb.fi <= 1) slot.boost = this.recordBoostForSlot(idx, cb.decoded);
   const ca = this.compAct.get(compId);
   if (ca && fi - ca.fi <= 1) applyComponentActiveFlag(slot, aType.get(compId) ?? '', ca.act, t);
  }
 }

 public recordBoostAttribute(actorId: number, raw: unknown, fi: number, idx: number): number | null {
  const decoded = decodeReplicatedBoostAttribute(raw);
  if (!decoded) return null;
  this.compBoost.set(actorId, { decoded, fi });
  return idx >= 0 ? this.recordBoostForSlot(idx, decoded) : null;
 }

 public recordActiveAttribute(
  actorId: number, compType: string, act: boolean, fi: number, t: number, idx: number, slot?: RLRCMutableSlotComponentState
 ): void {
  this.compAct.set(actorId, { act, fi });
  if (idx >= 0 && slot) applyComponentActiveFlag(slot, compType, act, t);
 }

 public recordBoostForSlot(idx: number, decoded: RLRCDecodedBoostAttribute): number {
  if (idx < 0 || idx >= MAX_SLOTS) return decoded.boostAmount;
  this.pendAnchor[idx] = decoded.boostAmount;
  if (decoded.grantCount !== null) {
   const prev = this.lastGrant[idx];
   if (prev >= 0 && decoded.grantCount !== prev) this.pendGrantChg[idx] = true;
   this.lastGrant[idx] = decoded.grantCount;
  }
  return decoded.boostAmount;
 }

 public recordPickupAttribute(
  pickupActorId: number, raw: unknown, cSlot: (carId: number) => number,
  slotPositions: ReadonlyArray<RLRCVec3 | null>, slotActive: ReadonlyArray<boolean>
 ): { slotIndex: number; grant: number } {
  const dec = decodeReplicatedPickupAttribute(raw);
  if (!dec) return { slotIndex: -1, grant: 0 };
  const instSlot = dec.instigatorCarActorId >= 0 ? cSlot(dec.instigatorCarActorId) : -1;
  let padIdx = this.actorToPad.get(pickupActorId) ?? -1;
  const instPos = instSlot >= 0 ? slotPositions[instSlot] : null;
  if (padIdx < 0 && instPos) padIdx = this.bindPad(pickupActorId, instPos.x, instPos.y);
  if (!dec.pickedUp) return { slotIndex: instSlot, grant: 0 };

  let targetSlot = instSlot;
  if (targetSlot < 0 && padIdx >= 0) {
   const pad = PADS_XY[padIdx];
   let bestSq = CAR_PAD_PROX_SQ;
   for (let s = 0; s < MAX_SLOTS; s++) {
    const pos = slotPositions[s];
    if (!slotActive[s] || !pos) continue;
    const dSq = (pos.x - pad[0]) ** 2 + (pos.y - pad[1]) ** 2;
    if (dSq < bestSq) { bestSq = dSq; targetSlot = s; }
   }
  }
  if (targetSlot < 0 || targetSlot >= MAX_SLOTS) return { slotIndex: -1, grant: 0 };
  if (padIdx < 0 && slotPositions[targetSlot]) {
   const p = slotPositions[targetSlot]!;
   padIdx = this.bindPad(pickupActorId, p.x, p.y);
  }
  const grant = padIdx >= 0 && PADS_XY[padIdx][2] ? RLRC_BIG_PAD_GRANT_AMOUNT : RLRC_SMALL_PAD_GRANT_AMOUNT;
  this.pendPadGrant[targetSlot] = Math.max(this.pendPadGrant[targetSlot], grant);
  return { slotIndex: targetSlot, grant };
 }

 public commitFrame(
  t: number, dt: number, cdNum: number,
  slots: ReadonlyArray<{ readonly on: boolean; readonly carId: number; readonly bOn: boolean }>
 ): void {
  for (let s = 0; s < MAX_SLOTS; s++) {
   const st = slots[s], on = Boolean(st?.on);
   this.samples[s].push({
    t, dt, on, carId: on ? (st?.carId ?? -1) : -1, spawned: this.pendSpawn[s], cdNum,
    bOn: on && Boolean(st?.bOn), anchor: on ? this.pendAnchor[s] : null,
    grantChg: on && this.pendGrantChg[s], padGrant: on ? this.pendPadGrant[s] : 0,
   });
  }
 }

 public applyReconstructedBoostToTimeline(nfs: RLRCSourceNetworkFrame[]): void {
  const n = nfs.length;
  if (!n) return;
  for (let s = 0; s < MAX_SLOTS; s++) {
   const timeline = this.reconstructSlot(this.samples[s], n);
   for (let fi = 0; fi < n; fi++) {
    const cars = nfs[fi].cars as RLRCCarFrameState120Hz[];
    const car = cars[s];
    if (!car) continue;
    const boostAmount = car.entityActive ? clamp(timeline[fi], 0, 100) : 0;
    if (Math.abs(car.boostAmount - boostAmount) > 1e-4) cars[s] = { ...car, boostAmount };
   }
  }
 }

 private bindPad(actorId: number, x: number, y: number): number {
  const ex = this.actorToPad.get(actorId);
  if (ex !== undefined) return ex;
  let bestUnb = -1, bestUnbSq = Number.POSITIVE_INFINITY, bestAll = 0, bestAllSq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PADS_XY.length; i++) {
   const dSq = (x - PADS_XY[i][0]) ** 2 + (y - PADS_XY[i][1]) ** 2;
   if (dSq < bestAllSq) { bestAllSq = dSq; bestAll = i; }
   if (!this.boundPads.has(i) && dSq < bestUnbSq) { bestUnbSq = dSq; bestUnb = i; }
  }
  const idx = bestUnb >= 0 && bestUnbSq <= MAX_PAD_MATCH_SQ ? bestUnb : bestAll;
  const prev = this.padToActor.get(idx);
  if (prev !== undefined && prev !== actorId) this.actorToPad.delete(prev);
  this.actorToPad.set(actorId, idx);
  this.padToActor.set(idx, actorId);
  this.boundPads.add(idx);
  return idx;
 }

 private reconstructSlot(sp: readonly RLRCSlotFrameBoostSample[], count: number): Float64Array {
  const out = new Float64Array(count), n = Math.min(sp.length, count);
  for (let fi = 0; fi < n; ) {
   if (!sp[fi].on) { out[fi++] = 0; continue; }
   const s0 = fi;
   let s1 = fi;
   while (s1 + 1 < n && sp[s1 + 1].on) {
    const nx = sp[s1 + 1], pr = sp[s1];
    if (nx.spawned || (nx.carId >= 0 && pr.carId >= 0 && nx.carId !== pr.carId) || (nx.cdNum > 0 && pr.cdNum === 0)) break;
    s1++;
   }
   this.reconstructSegment(sp, s0, s1, out);
   fi = s1 + 1;
  }
  return out;
 }

 private reconstructSegment(sp: readonly RLRCSlotFrameBoostSample[], s0: number, s1: number, out: Float64Array): void {
  const stepDt = (k: number): number => {
   const d = sp[k].t - sp[k - 1].t;
   return clamp(d > 1e-5 ? d : (sp[k].dt > 1e-5 ? sp[k].dt : 1 / 30), 1 / 240, 0.25);
  };
  const stepAct = (k: number): number => {
   const dt = stepDt(k);
   return sp[k].bOn ? dt : (sp[k - 1].bOn ? 0.5 * dt : 0);
  };

  const exp: RLRCBoostAnchor[] = [];
  for (let k = s0; k <= s1; k++) {
   if (sp[k].anchor !== null) exp.push({ fi: k, boost: sp[k].anchor!, grantChg: sp[k].grantChg });
  }

  let bInit = sp[s0].anchor ?? RLRC_DEFAULT_INITIAL_BOOST;
  if (sp[s0].anchor === null && exp.length > 0) {
   const fst = exp[0];
   let actSec = 0, pads = 0;
   for (let k = s0 + 1; k <= fst.fi; k++) { actSec += stepAct(k); pads += sp[k].padGrant; }
   if (pads === 0 && ((fst.fi - s0 <= 3 && actSec === 0) || (!sp[s0].spawned && s0 === 0 && sp[0].cdNum === 0 && !fst.grantChg))) {
    bInit = clamp(fst.boost + actSec * RLRC_BOOST_CONSUMPTION_RATE_PER_SEC, 0, 100);
   }
  }

  const anchors: RLRCBoostAnchor[] = exp.length > 0 && exp[0].fi === s0 ? exp : [{ fi: s0, boost: bInit, grantChg: false }, ...exp];
  out[s0] = anchors[0].boost;
  for (let m = 0; m + 1 < anchors.length; m++) {
   this.reconstructSpan(sp, anchors[m].fi, anchors[m + 1].fi, anchors[m].boost, anchors[m + 1].boost, anchors[m + 1].grantChg, stepDt, stepAct, out);
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

 private reconstructSpan(
  sp: readonly RLRCSlotFrameBoostSample[], a0: number, a1: number, b0: number, b1: number,
  grantChg: boolean, stepDt: (k: number) => number, stepAct: (k: number) => number, out: Float64Array
 ): void {
  if (a1 <= a0) { out[a1] = b1; return; }
  let actSec = 0, spanSec = 0, midPads = 0, bFwd = b0;
  for (let k = a0 + 1; k <= a1; k++) {
   const a = stepAct(k);
   actSec += a;
   spanSec += stepDt(k);
   bFwd = Math.max(0, bFwd - a * RLRC_BOOST_CONSUMPTION_RATE_PER_SEC);
   if (k < a1 && sp[k].padGrant > 0) { midPads += sp[k].padGrant; bFwd = Math.min(100, bFwd + sp[k].padGrant); }
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
     bCur -= actDrop * (stepAct(k) / actSec) + (remDrop > 0 && spanSec > 1e-5 ? remDrop * (stepDt(k) / spanSec) : 0);
     out[k] = clamp(bCur, b1, b0);
    }
    out[a1] = b1;
    return;
   }
   const win = Math.max(0.12, (drop / RLRC_BOOST_CONSUMPTION_RATE_PER_SEC) * 1.25);
   const tStart = Math.max(sp[a0].t, sp[a1].t - win);
   let rDur = 0, bCur = b0;
   for (let k = a0 + 1; k <= a1; k++) if (sp[k].t > tStart) rDur += stepDt(k);
   for (let k = a0 + 1; k < a1; k++) {
    if (sp[k].t > tStart && rDur > 1e-5) bCur -= drop * (stepDt(k) / rDur);
    out[k] = clamp(bCur, b1, b0);
   }
   out[a1] = b1;
   return;
  }

  if (!grantChg && midPads === 0 && b1 < 99.0 && (endPad === RLRC_SMALL_PAD_GRANT_AMOUNT || b1 > bFwd + 6.0)) {
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
}
