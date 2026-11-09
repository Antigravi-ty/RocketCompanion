/**
 * RLRCNetStreamRigidBodyAndBoostExtractor.ts
 * Extracts 30Hz ball and 6-slot vehicle rigid-body samples, component active flags,
 * demolish bookmarks, and continuous reconstructed boost amounts from decoded NetStream frames.
 */

import {
  RLRC_MAX_PLAYER_SLOTS as MAX_SLOTS,
  RLRC_TICK_RATE,
  type RLRCBallFrameState120Hz,
  type RLRCBasis3x3,
  type RLRCBookmarkRecord,
  type RLRCNetStreamExtractorInput,
  type RLRCNetStreamExtractorOutput,
  type RLRCNetStreamRawFrame,
  type RLRCRigidBodySample,
  type RLRCSourceNetworkFrame,
  type RLRCTeamIndex,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';
import { reconstructContinuousBoostTimeline30Hz } from './RLRCBoostTimelineReconstructor.ts';
import {
  applySlotRigidBodySampleUpdate,
  buildSourceFrameCars,
  createMutableSlotTrackers,
  decodeReplicatedAxisByte,
  DEFAULT_BALL_RB,
  DEFAULT_CAR_RB,
  extractActorIdFromAttr,
  extractRigidBodySample,
  extractVec3,
  isComponentActiveByte,
  normalizeReplicatedBoostAmount,
  numAttr,
  recAttr,
  resetMutableSlotTracker,
  RLRC_DEFAULT_SPAWN_BOOST,
  spawnBallRigidBody,
  ZERO_VEC3,
} from './RLRCNetStreamAttributeDecoders.ts';

export type {
  RLRCBasis3x3,
  RLRCNetStreamExtractorInput,
  RLRCNetStreamExtractorOutput,
  RLRCNetStreamRawFrame,
};

export class RLRCNetStreamRigidBodyAndBoostExtractor {
  public run(input: RLRCNetStreamExtractorInput): RLRCNetStreamExtractorOutput {
    const aType = new Map<number, string>();
    const cPri = new Map<number, number>();
    const lastPri = new Map<number, number>();
    const cHid = new Map<number, boolean>();
    const compCar = new Map<number, number>();
    const initLoc = new Map<number, RLRCVec3>();
    const bExp = new Set<number>();
    const cRb = new Map<number, RLRCRigidBodySample>();
    const cRbFi = new Map<number, number>();
    const pName = new Map<number, string>();
    const pTeam = new Map<number, RLRCTeamIndex>();
    const pSlot = new Map<number, number>();
    const nSlot = new Map<string, number>();

    const slots = createMutableSlotTrackers();
    const resting = Array.from({ length: MAX_SLOTS }, (): RLRCRigidBodySample[] => []);
    const boostAnchorsBySlot = Array.from({ length: MAX_SLOTS }, () => new Map<number, number>());
    const spawnFramesBySlot = Array.from({ length: MAX_SLOTS }, () => new Set<number>());

    for (const m of input.roster ?? []) {
      if (m.slotIndex >= 0 && m.slotIndex < MAX_SLOTS) {
        nSlot.set(m.userName, m.slotIndex);
        if (m.priActorId >= 0) {
          pSlot.set(m.priActorId, m.slotIndex);
          pName.set(m.priActorId, m.userName);
          pTeam.set(m.priActorId, m.team);
        }
      }
    }
    for (const [p, s] of input.slotByPriActorId?.entries() ?? []) {
      if (s >= 0 && s < MAX_SLOTS) pSlot.set(p, s);
    }

    const getSlot = (pid: number, hint?: string): number => {
      const h = pSlot.get(pid);
      if (h !== undefined) return h;
      const nm = hint ?? pName.get(pid);
      if (!nm) return -1;
      const bn = nSlot.get(nm);
      if (bn !== undefined) {
        pSlot.set(pid, bn);
        return bn;
      }
      if (nSlot.size >= MAX_SLOTS) return -1;
      const nx = nSlot.size;
      nSlot.set(nm, nx);
      pSlot.set(pid, nx);
      return nx;
    };

    const cSlot = (cid: number): number => {
      const p = cPri.get(cid);
      return p !== undefined && pSlot.has(p) ? pSlot.get(p)! : slots.findIndex((s) => s.carId === cid);
    };

    const off = (i: number, clr = false): void => resetMutableSlotTracker(slots[i], clr);
    const offByCar = (cid: number, clr = false): void => {
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].carId === cid) off(i, clr);
      }
    };

    const nfs: RLRCSourceNetworkFrame[] = [];
    const dems: RLRCBookmarkRecord[] = [];
    const goals: number[] = [];
    let bId = -1;
    let bAct = true;
    let bNeedsRb = false;
    let bSpawnFi = -1;
    let bRb = DEFAULT_BALL_RB;
    let secRem = 300;
    let ot = false;
    let cdNum = 0;
    let bSc = 0;
    let oSc = 0;
    let dT = -1e9;
    let dS = -1;
    const t0 = input.frames.length > 0 ? input.frames[0].time : 0;

    const sleepBall = (): void => {
      bAct = false;
      bNeedsRb = false;
      bRb = {
        ...bRb,
        sleeping: true,
        linearVelocity: ZERO_VEC3,
        angularVelocity: ZERO_VEC3,
        rbUpdated: false,
      };
    };

    for (let fi = 0; fi < input.frames.length; fi++) {
      const fr = input.frames[fi];
      const t = numAttr(fr.time);
      const dt = numAttr(fr.delta, 1 / 30);
      const isKf = input.keyframeIndices?.has(fi) ?? false;
      let bUpd = false;
      for (const s of slots) s.upd = false;

      for (const id of fr.deleted_actors ?? []) {
        aType.delete(id);
        cPri.delete(id);
        cHid.delete(id);
        compCar.delete(id);
        initLoc.delete(id);
        cRb.delete(id);
        cRbFi.delete(id);
        bExp.delete(id);
        offByCar(id, true);
        if (id === bId) {
          bId = -1;
          sleepBall();
        }
      }

      for (const na of fr.new_actors ?? []) {
        const otn = input.objects[na.object_id] ?? '';
        const aid = na.actor_id;
        aType.set(aid, otn);
        if (!isKf) {
          cHid.delete(aid);
          bExp.delete(aid);
        }
        if (na.initial_trajectory?.location) {
          initLoc.set(aid, extractVec3(na.initial_trajectory.location));
        }
        if (otn.includes('Archetypes.Ball.') && !bExp.has(aid) && !cHid.get(aid)) {
          if (
            !isKf ||
            bId < 0 ||
            !bAct ||
            (aid !== bId && !fr.new_actors?.some((x) => x.actor_id === bId))
          ) {
            bId = aid;
            bAct = true;
            bNeedsRb = true;
            bUpd = true;
            bSpawnFi = fi;
            bRb = spawnBallRigidBody(initLoc.get(aid));
          }
        }
      }

      for (const ua of fr.updated_actors ?? []) {
        const id = ua.actor_id;
        const p = input.objects[ua.object_id] ?? '';
        const a = ua.attribute;
        const at = aType.get(id) ?? '';
        const r = recAttr(a);
        const cid = compCar.get(id) ?? id;

        if (p.endsWith(':PlayerName')) {
          const v = r?.String;
          if (typeof v === 'string' && v) {
            pName.set(id, v);
            getSlot(id, v);
          }
        } else if (p.endsWith('PlayerReplicationInfo:Team')) {
          const tt = aType.get(extractActorIdFromAttr(a)) ?? '';
          if (tt.includes('Team0')) pTeam.set(id, 0);
          else if (tt.includes('Team1')) pTeam.set(id, 1);
        } else if (p === 'Engine.TeamInfo:Score') {
          const sc = Math.max(0, Math.trunc(numAttr(r?.Int)));
          if (at.includes('Team0')) bSc = sc;
          else if (at.includes('Team1')) oSc = sc;
        } else if (p === 'Engine.Pawn:PlayerReplicationInfo') {
          const pid = extractActorIdFromAttr(a);
          if (pid < 0) {
            cPri.delete(id);
            offByCar(id, true);
          } else {
            cPri.set(id, pid);
            lastPri.set(id, pid);
            const idx = getSlot(pid);
            if (idx >= 0) {
              const s = slots[idx];
              const isNew = s.carId !== id;
              const hid = Boolean(cHid.get(id));
              s.carId = id;
              s.on = !hid;
              if (isNew && !hid) {
                if (cRbFi.get(id) === fi && cRb.has(id)) {
                  s.rb = cRb.get(id)!;
                  s.spFi = -2;
                } else {
                  const il = initLoc.get(id);
                  if (il) s.rb = { ...DEFAULT_CAR_RB, position: il, rbUpdated: true };
                  s.spFi = fi;
                }
                s.upd = true;
                s.boost = RLRC_DEFAULT_SPAWN_BOOST;
                s.bOn = false;
                s.jOn = false;
                s.dOn = false;
                s.dgOn = false;
                s.flipped = false;
                spawnFramesBySlot[idx].add(fi);
              }
            }
          }
        } else if (p === 'Engine.Actor:bHidden') {
          const hid = Boolean(r?.Boolean);
          const idx = cSlot(id);
          cHid.set(id, hid);
          if (at.includes('Car') && idx >= 0 && slots[idx].carId === id) {
            if (hid) {
              off(idx);
            } else {
              if (!slots[idx].on) spawnFramesBySlot[idx].add(fi);
              slots[idx].on = true;
            }
          } else if (at.includes('Ball') && (id === bId || (!hid && bId < 0))) {
            bId = id;
            if (hid) sleepBall();
            else if (!bExp.has(id)) bAct = true;
          }
        } else if (p === 'TAGame.CarComponent_TA:Vehicle') {
          const vId = extractActorIdFromAttr(a);
          if (vId >= 0) compCar.set(id, vId);
        } else if (p.endsWith(':ReplicatedRBState')) {
          const rb = extractRigidBodySample(a);
          if (!rb) continue;
          const uRb: RLRCRigidBodySample = { ...rb, rbUpdated: true };
          if (at.includes('Ball') && !cHid.get(id) && !bExp.has(id) && (bId < 0 || id === bId || !bAct)) {
            if (
              bNeedsRb &&
              bId === id &&
              fi === bSpawnFi + 1 &&
              nfs[fi - 1]?.ball.entityActive &&
              Math.hypot(rb.linearVelocity.x, rb.linearVelocity.y, rb.linearVelocity.z) < 10
            ) {
              (nfs[fi - 1] as { ball: RLRCBallFrameState120Hz }).ball = {
                entityActive: true,
                rigidBody: uRb,
                rbUpdated: true,
                activeBallActorId: id,
                actorId: id,
              };
            }
            bId = id;
            bAct = true;
            bUpd = true;
            bNeedsRb = false;
            bRb = uRb;
          } else if (at.includes('Car')) {
            cRb.set(id, uRb);
            cRbFi.set(id, fi);
            const idx = cSlot(id);
            if (idx >= 0 && !cHid.get(id)) {
              applySlotRigidBodySampleUpdate({
                slot: slots[idx],
                slotIndex: idx,
                carActorId: id,
                frameIndex: fi,
                timeSeconds: t,
                rb,
                updatedRb: uRb,
                networkFrames: nfs,
                restingSamples: resting[idx],
              });
            }
          }
        } else if (p.includes(':ReplicatedBoost')) {
          const bv = normalizeReplicatedBoostAmount(a);
          const idx = cSlot(cid);
          if (bv !== null && idx >= 0) {
            slots[idx].boost = bv;
            boostAnchorsBySlot[idx].set(fi, bv);
          }
        } else if (p.endsWith(':ReplicatedThrottle')) {
          const th = decodeReplicatedAxisByte(a);
          const idx = cSlot(id);
          if (th !== null && idx >= 0) slots[idx].th = th;
        } else if (p.endsWith(':ReplicatedSteer')) {
          const st = decodeReplicatedAxisByte(a);
          const idx = cSlot(id);
          if (st !== null && idx >= 0) slots[idx].st = st;
        } else if (p.endsWith(':bReplicatedHandbrake')) {
          const idx = cSlot(id);
          if (idx >= 0) slots[idx].hb = Boolean(r?.Boolean);
        } else if (p.endsWith(':ReplicatedActive')) {
          const act = isComponentActiveByte(a);
          const idx = cSlot(cid);
          if (act !== null && idx >= 0) {
            const s = slots[idx];
            if (at.includes('Boost')) s.bOn = act;
            else if (at.includes('DoubleJump')) {
              s.dOn = act;
              if (act) s.flipped = true;
            } else if (at.includes('Dodge')) {
              s.dgOn = act;
              if (act) s.flipped = true;
            } else if (at.includes('Jump')) {
              s.jOn = act;
              if (act) s.jT = t;
            }
          }
        } else if (p.includes(':ReplicatedDemolish')) {
          const dem = recAttr(r?.DemolishExtended ?? r?.Demolish) ?? r;
          const vCar = dem ? extractActorIdFromAttr(dem.victim) : id;
          const tCar = vCar >= 0 ? vCar : id;
          const vPri = cPri.get(tCar) ?? lastPri.get(tCar) ?? -1;
          const vSlot = cSlot(tCar) >= 0 ? cSlot(tCar) : (pSlot.get(vPri) ?? -1);
          if (vSlot >= 0) off(vSlot);
          if (!isKf && (vSlot !== dS || Math.abs(t - dT) > 0.5)) {
            const att = pName.get(dem ? extractActorIdFromAttr(dem.attacker_pri ?? dem.attacker) : -1) ?? 'Player';
            const vic = pName.get(vPri) ?? `Slot ${Math.max(0, vSlot)}`;
            dems.push({
              kind: 'demolish',
              frameIndex120Hz: Math.max(0, Math.round((t - t0) * RLRC_TICK_RATE)),
              sourceFrame30Hz: fi,
              timeSeconds: t,
              label: `Demolish: ${att} -> ${vic}`,
              slotIndex: vSlot,
              team: pTeam.get(vPri) ?? -1,
            });
            dT = t;
            dS = vSlot;
          }
        } else if (p.includes(':ReplicatedExplosionData')) {
          bExp.add(id);
          if (id === bId || bId < 0) sleepBall();
          if (!isKf) goals.push(fi);
        } else if (p.endsWith(':SecondsRemaining') && !isKf) {
          secRem = Math.max(0, Math.trunc(numAttr(r?.Int, secRem)));
        } else if (p.endsWith(':bOverTime')) {
          ot = Boolean(r?.Boolean ?? ot);
        } else if (p.endsWith(':ReplicatedRoundCountDownNumber') && !isKf) {
          cdNum = Math.max(0, Math.trunc(numAttr(r?.Int)));
        }
      }

      const { cars, carRbUpdatedMask: cMask } = buildSourceFrameCars(slots, t);
      const bu = bAct && bUpd;
      const bOut = { ...bRb, rbUpdated: bu };
      const bAid = bAct ? bId : -1;
      nfs.push({
        sourceFrame30Hz: fi,
        timeSeconds: t,
        deltaSeconds: dt,
        secondsRemaining: secRem,
        isOvertime: ot,
        roundCountdownNumber: cdNum,
        blueScore: bSc,
        orangeScore: oSc,
        ball: {
          entityActive: bAct,
          rigidBody: bOut,
          rbUpdated: bu,
          activeBallActorId: bAid,
          actorId: bAid,
        },
        cars,
        ballRbUpdated: bu,
        carRbUpdatedMask: cMask,
        rbUpdatedMask: cMask | (bu ? 1 << MAX_SLOTS : 0),
        activeBallActorId: bAid,
      });
    }

    reconstructContinuousBoostTimeline30Hz(
      nfs,
      { anchorsBySlot: boostAnchorsBySlot, spawnFramesBySlot },
      input.boostPadEvents
    );

    const restMap = new Map<number, readonly RLRCRigidBodySample[]>();
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (resting[i].length > 0) restMap.set(i, resting[i]);
    }
    return {
      networkFrames: nfs,
      demolishBookmarks: dems,
      goalExplosionFrames: goals,
      restingSamplesBySlot: restMap,
    };
  }
}

export const extractNetStreamRigidBodyAndBoostTimeline = (
  input: RLRCNetStreamExtractorInput
): RLRCNetStreamExtractorOutput => new RLRCNetStreamRigidBodyAndBoostExtractor().run(input);
