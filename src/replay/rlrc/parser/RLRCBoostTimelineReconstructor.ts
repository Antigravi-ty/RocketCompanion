/**
 * RLRCBoostTimelineReconstructor.ts
 * Reconstructs continuous 30Hz/120Hz per-slot boost timelines from sparse Rocket League
 * `.replay` NetStream `ReplicatedBoost` anchors, `ReplicatedActive` boost component edges
 * (33.3333%/s consumption rate), `grant_count` resets, and 34-pad pickup events.
 */

import { RAW_STANDARD_BOOST_PADS_34 } from '../catalog/RLRCBoostPadLocationsTable.ts';
import {
  RLRC_MAX_PLAYER_SLOTS as MAX_SLOTS,
  type RLRCCarFrameState120Hz,
  type RLRCRigidBodySample,
  type RLRCSourceNetworkFrame,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';
import {
  reconstructSlotBoostTimeline,
  RLRC_BIG_PAD_GRANT_AMOUNT,
  RLRC_SMALL_PAD_GRANT_AMOUNT,
  type RLRCSlotFrameBoostSample,
} from './RLRCBoostSegmentSolverPipeline.ts';
import type { PlayerSlotTrackingState } from './rlrcFrameSnapshotAndBookmarkBuilder.ts';
import {
  decodeReplicatedBoostAttribute,
  decodeReplicatedPickupAttribute,
  type RLRCDecodedBoostAttribute,
  type RLRCDecodedPickupAttribute,
} from './rlrcRigidBodyAttributePrimitives.ts';

export type { RLRCDecodedBoostAttribute, RLRCDecodedPickupAttribute };

const MAX_PAD_MATCH_SQ = 450 * 450;
const CAR_PAD_PROX_SQ = 280 * 280;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function applyComponentActiveFlag(
  slot: PlayerSlotTrackingState,
  compType: string,
  act: boolean,
  t: number
): void {
  if (compType.includes('Boost')) slot.boostActive = act;
  else if (compType.includes('DoubleJump')) {
    slot.doubleJumpActive = act;
    if (act) slot.flippedInAir = true;
  } else if (compType.includes('Dodge')) {
    slot.dodgeActive = act;
    if (act) slot.flippedInAir = true;
  } else if (compType.includes('Jump')) {
    slot.jumpActive = act;
    if (act) slot.lastJumpTimeSeconds = t;
  }
}

export class RLRCBoostTimelineReconstructor {
  private readonly samples: RLRCSlotFrameBoostSample[][] = Array.from(
    { length: MAX_SLOTS },
    () => []
  );
  private readonly lastGrant = new Int32Array(MAX_SLOTS).fill(-1);
  private readonly pendAnchor: Array<number | null> = new Array(MAX_SLOTS).fill(null);
  private readonly pendGrantChg: boolean[] = new Array(MAX_SLOTS).fill(false);
  private readonly pendPadGrant = new Float64Array(MAX_SLOTS);
  private readonly pendSpawn: boolean[] = new Array(MAX_SLOTS).fill(false);
  private readonly compCar = new Map<number, number>();
  private readonly compBoost = new Map<
    number,
    { decoded: RLRCDecodedBoostAttribute; fi: number }
  >();
  private readonly compAct = new Map<number, { act: boolean; fi: number }>();
  private readonly actorToPad = new Map<number, number>();
  private readonly padToActor = new Map<number, number>();
  private readonly boundPads = new Set<number>();

  public beginFrame(): void {
    this.pendAnchor.fill(null);
    this.pendGrantChg.fill(false);
    this.pendPadGrant.fill(0);
    this.pendSpawn.fill(false);
  }

  public deleteActor(id: number): void {
    this.compCar.delete(id);
    this.compBoost.delete(id);
    this.compAct.delete(id);
    const padIdx = this.actorToPad.get(id);
    if (padIdx !== undefined) {
      this.actorToPad.delete(id);
      if (this.padToActor.get(padIdx) === id) {
        this.padToActor.delete(padIdx);
        this.boundPads.delete(padIdx);
      }
    }
  }

  public bindComponentCar(
    compId: number,
    carId: number,
    fi: number,
    t: number,
    compType: string,
    cSlot: (cid: number) => number,
    slots: readonly PlayerSlotTrackingState[]
  ): void {
    if (carId < 0) {
      this.compCar.delete(compId);
      return;
    }
    this.compCar.set(compId, carId);
    const idx = cSlot(carId);
    if (idx < 0 || idx >= MAX_SLOTS) return;
    const cb = this.compBoost.get(compId);
    if (cb && fi - cb.fi <= 1) slots[idx].boostAmount = this.recordBoostForSlot(idx, cb.decoded);
    const ca = this.compAct.get(compId);
    if (ca && fi - ca.fi <= 1) applyComponentActiveFlag(slots[idx], compType, ca.act, t);
  }

  public resolveOwnerCarId(actorId: number): number {
    return this.compCar.get(actorId) ?? actorId;
  }

  public onSlotCarSpawn(
    idx: number,
    carId: number,
    fi: number,
    t: number,
    slot: PlayerSlotTrackingState,
    aType: ReadonlyMap<number, string>
  ): void {
    if (idx < 0 || idx >= MAX_SLOTS) return;
    this.pendSpawn[idx] = true;
    this.lastGrant[idx] = -1;
    const direct = this.compBoost.get(carId);
    if (direct && fi - direct.fi <= 1) {
      slot.boostAmount = this.recordBoostForSlot(idx, direct.decoded);
    }
    for (const [compId, vId] of this.compCar.entries()) {
      if (vId !== carId) continue;
      const cb = this.compBoost.get(compId);
      if (cb && fi - cb.fi <= 1) slot.boostAmount = this.recordBoostForSlot(idx, cb.decoded);
      const ca = this.compAct.get(compId);
      if (ca && fi - ca.fi <= 1) applyComponentActiveFlag(slot, aType.get(compId) ?? '', ca.act, t);
    }
  }

  public recordBoostAttribute(
    actorId: number,
    raw: unknown,
    fi: number,
    idx: number
  ): number | null {
    const decoded = decodeReplicatedBoostAttribute(raw);
    if (!decoded) return null;
    this.compBoost.set(actorId, { decoded, fi });
    return idx >= 0 ? this.recordBoostForSlot(idx, decoded) : null;
  }

  public recordActiveAttribute(
    actorId: number,
    compType: string,
    act: boolean,
    fi: number,
    t: number,
    idx: number,
    slot?: PlayerSlotTrackingState
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

  public recordPickupForTrackedSlots(
    pickupActorId: number,
    raw: unknown,
    cSlot: (carId: number) => number,
    slots: readonly PlayerSlotTrackingState[],
    carRigidBodyById: ReadonlyMap<number, RLRCRigidBodySample>
  ): void {
    const slotPos = slots.map((s) =>
      s.entityActive ? (carRigidBodyById.get(s.carId)?.position ?? s.rigidBody.position) : null
    );
    const slotAct = slots.map((s) => s.entityActive);
    const { slotIndex, grant } = this.recordPickupAttribute(
      pickupActorId,
      raw,
      cSlot,
      slotPos,
      slotAct
    );
    if (grant > 0 && slotIndex >= 0) {
      slots[slotIndex].boostAmount = Math.min(100, slots[slotIndex].boostAmount + grant);
    }
  }

  public recordPickupAttribute(
    pickupActorId: number,
    raw: unknown,
    cSlot: (carId: number) => number,
    slotPositions: ReadonlyArray<RLRCVec3 | null>,
    slotActive: ReadonlyArray<boolean>
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
      const pad = RAW_STANDARD_BOOST_PADS_34[padIdx];
      let bestSq = CAR_PAD_PROX_SQ;
      for (let s = 0; s < MAX_SLOTS; s++) {
        const pos = slotPositions[s];
        if (!slotActive[s] || !pos) continue;
        const dSq = (pos.x - pad[0]) ** 2 + (pos.y - pad[1]) ** 2;
        if (dSq < bestSq) {
          bestSq = dSq;
          targetSlot = s;
        }
      }
    }
    if (targetSlot < 0 || targetSlot >= MAX_SLOTS) return { slotIndex: -1, grant: 0 };
    if (padIdx < 0 && slotPositions[targetSlot]) {
      const p = slotPositions[targetSlot]!;
      padIdx = this.bindPad(pickupActorId, p.x, p.y);
    }
    const grant =
      padIdx >= 0 && RAW_STANDARD_BOOST_PADS_34[padIdx][3]
        ? RLRC_BIG_PAD_GRANT_AMOUNT
        : RLRC_SMALL_PAD_GRANT_AMOUNT;
    this.pendPadGrant[targetSlot] = Math.max(this.pendPadGrant[targetSlot], grant);
    return { slotIndex: targetSlot, grant };
  }

  public commitFrame(
    t: number,
    dt: number,
    cdNum: number,
    slots: readonly PlayerSlotTrackingState[]
  ): void {
    for (let s = 0; s < MAX_SLOTS; s++) {
      const st = slots[s];
      const on = Boolean(st?.entityActive);
      this.samples[s].push({
        t,
        dt,
        on,
        carId: on ? (st?.carId ?? -1) : -1,
        spawned: this.pendSpawn[s],
        cdNum,
        bOn: on && Boolean(st?.boostActive),
        anchor: on ? this.pendAnchor[s] : null,
        grantChg: on && this.pendGrantChg[s],
        padGrant: on ? this.pendPadGrant[s] : 0,
      });
    }
  }

  public applyReconstructedBoostToTimeline(nfs: RLRCSourceNetworkFrame[]): void {
    const n = nfs.length;
    if (!n) return;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const timeline = reconstructSlotBoostTimeline(this.samples[s], n);
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
    let bestUnb = -1;
    let bestUnbSq = Number.POSITIVE_INFINITY;
    let bestAll = 0;
    let bestAllSq = Number.POSITIVE_INFINITY;
    for (let i = 0; i < RAW_STANDARD_BOOST_PADS_34.length; i++) {
      const pad = RAW_STANDARD_BOOST_PADS_34[i];
      const dSq = (x - pad[0]) ** 2 + (y - pad[1]) ** 2;
      if (dSq < bestAllSq) {
        bestAllSq = dSq;
        bestAll = i;
      }
      if (!this.boundPads.has(i) && dSq < bestUnbSq) {
        bestUnbSq = dSq;
        bestUnb = i;
      }
    }
    const idx = bestUnb >= 0 && bestUnbSq <= MAX_PAD_MATCH_SQ ? bestUnb : bestAll;
    const prev = this.padToActor.get(idx);
    if (prev !== undefined && prev !== actorId) this.actorToPad.delete(prev);
    this.actorToPad.set(actorId, idx);
    this.padToActor.set(idx, actorId);
    this.boundPads.add(idx);
    return idx;
  }
}
