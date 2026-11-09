import {
 RLRC_MAX_PLAYER_SLOTS as MAX_SLOTS, RLRC_TICK_RATE,
 type RLRCBallFrameState120Hz, type RLRCBasis3x3, type RLRCBookmarkRecord,
 type RLRCCarComponentActiveFlags, type RLRCCarFrameState120Hz,
 type RLRCNetStreamExtractorInput, type RLRCNetStreamExtractorOutput, type RLRCNetStreamRawFrame,
 type RLRCQuat, type RLRCRigidBodySample,
 type RLRCSourceNetworkFrame, type RLRCSynthesizedCarControls, type RLRCTeamIndex, type RLRCVec3,
} from '../RLRCReplayTypes.ts';
import {
 decodeReplicatedBoostAttribute,
 RLRC_BOOST_CONSUMPTION_RATE_PER_SEC,
 RLRCBoostTimelineReconstructor,
} from './RLRCBoostTimelineReconstructor.ts';

export type { RLRCBasis3x3, RLRCNetStreamExtractorInput, RLRCNetStreamExtractorOutput, RLRCNetStreamRawFrame };

const B_INIT = 33.333, BALL_Z = 93.15, SS_SPD = 2200, FLIP_EXP = 1.25;
export {
 B_INIT as RLRC_DEFAULT_SPAWN_BOOST,
 BALL_Z as RLRC_DEFAULT_BALL_REST_Z,
 SS_SPD as RLRC_SUPERSONIC_SPEED_UU_S,
 FLIP_EXP as RLRC_FLIP_EXPIRATION_SECONDS,
};
export const ZERO_VEC3: RLRCVec3 = { x: 0, y: 0, z: 0 }, IDENTITY_QUAT: RLRCQuat = { x: 0, y: 0, z: 0, w: 1 };
const DEF_CRB: RLRCRigidBodySample = {
 sleeping: true, position: ZERO_VEC3, rotation: IDENTITY_QUAT, linearVelocity: ZERO_VEC3, angularVelocity: ZERO_VEC3, rbUpdated: false,
};
export { DEF_CRB as DEFAULT_CAR_RB };
const DEF_BRB: RLRCRigidBodySample = { ...DEF_CRB, position: { x: 0, y: 0, z: BALL_Z } };
export { DEF_BRB as DEFAULT_BALL_RB };
export const DEFAULT_ACTIVE_FLAGS: RLRCCarComponentActiveFlags = {
 boostActive: false, jumpActive: false, doubleJumpActive: false, dodgeActive: false,
};
export const NEUTRAL_CONTROLS: RLRCSynthesizedCarControls = {
 throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false,
};

const fin = Number.isFinite, num = (v: unknown, fb = 0): number => (typeof v === 'number' && fin(v) ? v : fb);
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);
const { abs, hypot, max, min, trunc } = Math, clamp = (v: number, lo: number, hi: number): number => max(lo, min(hi, v));

export function extractVec3(raw: unknown, fb: RLRCVec3 = ZERO_VEC3): RLRCVec3 {
 const r = rec(raw);
 return r ? { x: num(r.x ?? r.X, fb.x), y: num(r.y ?? r.Y, fb.y), z: num(r.z ?? r.Z, fb.z) } : fb;
}

export function normalizeQuat(raw: unknown): RLRCQuat {
 const r = rec(raw);
 if (!r) return IDENTITY_QUAT;
 const x = num(r.x ?? r.X), y = num(r.y ?? r.Y), z = num(r.z ?? r.Z), w = num(r.w ?? r.W, 1), len = hypot(x, y, z, w);
 return len < 1e-6 ? IDENTITY_QUAT : { x: x / len, y: y / len, z: z / len, w: w / len };
}

export function quatToBasis3x3({ x, y, z, w }: RLRCQuat): RLRCBasis3x3 {
 const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
 return {
  fwd: { x: 1 - 2 * (yy + zz), y: 2 * (xy + wz), z: 2 * (xz - wy) },
  right: { x: 2 * (xy - wz), y: 1 - 2 * (xx + zz), z: 2 * (yz + wx) },
  up: { x: 2 * (xz + wy), y: 2 * (yz - wx), z: 1 - 2 * (xx + yy) },
 };
}

export function extractRigidBodySample(raw: unknown): RLRCRigidBodySample | null {
 const o = rec(raw), rb = rec(o?.RigidBody) ?? o, loc = rb?.location ?? rb?.position ?? rb?.pos;
 if (!rb || !loc) return null;
 const sl = Boolean(rb.sleeping ?? rb.bSleeping), lv = rb.linear_velocity ?? rb.linearVelocity, av = rb.angular_velocity ?? rb.angularVelocity;
 return {
  sleeping: sl, position: extractVec3(loc), rotation: normalizeQuat(rb.rotation ?? rb.quat),
  linearVelocity: sl || !lv ? ZERO_VEC3 : extractVec3(lv), angularVelocity: sl || !av ? ZERO_VEC3 : extractVec3(av),
 };
}

export const normalizeReplicatedBoostAmount = (raw: unknown): number | null =>
 decodeReplicatedBoostAttribute(raw)?.boostAmount ?? null;

export const decodeReplicatedAxisByte = (raw: unknown): number | null => {
 const b = typeof raw === 'number' ? raw : num(rec(raw)?.Byte, Number.NaN);
 return !fin(b) ? null : b === 128 ? 0 : clamp((clamp(b, 0, 255) - 128) / 127, -1, 1);
};

export const isComponentActiveByte = (raw: unknown): boolean | null => {
 const b = typeof raw === 'number' ? raw : num(rec(raw)?.Byte, Number.NaN);
 return fin(b) ? (trunc(b) & 1) === 1 : null;
};

const actId = (raw: unknown): number => {
 const o = rec(raw), aa = rec(o?.ActiveActor) ?? o;
 return !aa || aa.active === false ? -1 : trunc(num(aa.actor, -1));
};

const spawnBallRb = (il?: RLRCVec3): RLRCRigidBodySample => ({
 ...DEF_BRB,
 position: !il || (abs(il.x) < 2 && abs(il.y) < 2 && abs(il.z - 93) < 2.5)
  ? DEF_BRB.position
  : { x: il.x, y: il.y, z: il.z > 0 ? il.z : BALL_Z },
 rbUpdated: true,
});

export class RLRCNetStreamRigidBodyAndBoostExtractor {
 public run(input: RLRCNetStreamExtractorInput): RLRCNetStreamExtractorOutput {
  const imap = <V>() => new Map<number, V>();
  const aType = imap<string>(), cPri = imap<number>(), lastPri = imap<number>(), cHid = imap<boolean>(), initLoc = imap<RLRCVec3>();
  const bExp = new Set<number>(), cRb = imap<RLRCRigidBodySample>(), cRbFi = imap<number>();
  const pName = imap<string>(), pTeam = imap<RLRCTeamIndex>(), pSlot = imap<number>(), nSlot = new Map<string, number>();
  const boostRec = new RLRCBoostTimelineReconstructor();
  const slots = Array.from({ length: MAX_SLOTS }, () => ({
   carId: -1, on: false, spFi: -2, upd: false, rb: DEF_CRB, boost: B_INIT,
   th: 0, st: 0, hb: false, bOn: false, jOn: false, dOn: false, dgOn: false, jT: -1e9, flipped: false,
  }));
  const resting = Array.from({ length: MAX_SLOTS }, (): RLRCRigidBodySample[] => []);

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
  for (const [p, s] of input.slotByPriActorId?.entries() ?? []) if (s >= 0 && s < MAX_SLOTS) pSlot.set(p, s);

  const getSlot = (pid: number, hint?: string): number => {
   const h = pSlot.get(pid);
   if (h !== undefined) return h;
   const nm = hint ?? pName.get(pid);
   if (!nm) return -1;
   const bn = nSlot.get(nm);
   if (bn !== undefined) { pSlot.set(pid, bn); return bn; }
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
  const off = (i: number, clr = false): void => {
   const s = slots[i];
   if (clr) s.carId = -1;
   s.on = s.upd = s.bOn = s.jOn = s.dOn = s.dgOn = s.hb = false;
   s.th = s.st = 0;
  };
  const offByCar = (cid: number, clr = false): void => {
   for (const [i, s] of slots.entries()) if (s.carId === cid) off(i, clr);
  };

  const nfs: RLRCSourceNetworkFrame[] = [], dems: RLRCBookmarkRecord[] = [], goals: number[] = [];
  let bId = -1, bAct = true, bNeedsRb = false, bSpawnFi = -1, bRb = DEF_BRB;
  let secRem = 300, ot = false, cdNum = 0, bSc = 0, oSc = 0, dT = -1e9, dS = -1;
  const t0 = input.frames.length > 0 ? input.frames[0].time : 0;
  const sleepBall = (): void => {
   bAct = bNeedsRb = false;
   bRb = { ...bRb, sleeping: true, linearVelocity: ZERO_VEC3, angularVelocity: ZERO_VEC3, rbUpdated: false };
  };

  for (let fi = 0; fi < input.frames.length; fi++) {
   const fr = input.frames[fi], t = num(fr.time), dt = clamp(num(fr.delta, 1 / 30), 0, 0.25);
   const isKf = input.keyframeIndices?.has(fi) ?? false;
   let bUpd = false;
   boostRec.beginFrame();
   for (const s of slots) {
    s.upd = false;
    if (s.on && s.bOn) s.boost = max(0, s.boost - RLRC_BOOST_CONSUMPTION_RATE_PER_SEC * dt);
   }

   for (const id of fr.deleted_actors ?? []) {
    aType.delete(id); cPri.delete(id); cHid.delete(id); initLoc.delete(id); cRb.delete(id); cRbFi.delete(id); bExp.delete(id);
    boostRec.deleteActor(id); offByCar(id, true);
    if (id === bId) { bId = -1; sleepBall(); }
   }
   for (const na of fr.new_actors ?? []) {
    const otn = input.objects[na.object_id] ?? '', aid = na.actor_id;
    aType.set(aid, otn);
    if (!isKf) { cHid.delete(aid); bExp.delete(aid); }
    if (na.initial_trajectory?.location) initLoc.set(aid, extractVec3(na.initial_trajectory.location));
    if (otn.includes('Archetypes.Ball.') && !bExp.has(aid) && !cHid.get(aid)) {
     if (!isKf || bId < 0 || !bAct || (aid !== bId && !fr.new_actors?.some((x) => x.actor_id === bId))) {
      bId = aid; bAct = bNeedsRb = bUpd = true; bSpawnFi = fi; bRb = spawnBallRb(initLoc.get(aid));
     }
    }
   }

   for (const ua of fr.updated_actors ?? []) {
    const id = ua.actor_id, p = input.objects[ua.object_id] ?? '', a = ua.attribute, at = aType.get(id) ?? '', r = rec(a);
    const cid = boostRec.resolveOwnerCarId(id);
    if (p.endsWith(':PlayerName')) {
     const v = r?.String;
     if (typeof v === 'string' && v) { pName.set(id, v); getSlot(id, v); }
    } else if (p.endsWith('PlayerReplicationInfo:Team')) {
     const tt = aType.get(actId(a)) ?? '';
     if (tt.includes('Team0')) pTeam.set(id, 0); else if (tt.includes('Team1')) pTeam.set(id, 1);
    } else if (p === 'Engine.TeamInfo:Score') {
     const sc = max(0, trunc(num(r?.Int)));
     if (at.includes('Team0')) bSc = sc; else if (at.includes('Team1')) oSc = sc;
    } else if (p === 'Engine.Pawn:PlayerReplicationInfo') {
     const pid = actId(a);
     if (pid < 0) { cPri.delete(id); offByCar(id, true); }
     else {
      cPri.set(id, pid); lastPri.set(id, pid);
      const idx = getSlot(pid);
      if (idx >= 0) {
       const s = slots[idx], isNew = s.carId !== id, hid = Boolean(cHid.get(id));
       s.carId = id; s.on = !hid;
       if (isNew && !hid) {
        if (cRbFi.get(id) === fi && cRb.has(id)) { s.rb = cRb.get(id)!; s.spFi = -2; }
        else { const il = initLoc.get(id); if (il) s.rb = { ...DEF_CRB, position: il, rbUpdated: true }; s.spFi = fi; }
        s.upd = true; s.boost = B_INIT; s.bOn = s.jOn = s.dOn = s.dgOn = s.flipped = false;
        boostRec.onSlotCarSpawn(idx, id, fi, t, s, aType);
       }
      }
     }
    } else if (p === 'Engine.Actor:bHidden') {
     const hid = Boolean(r?.Boolean), idx = cSlot(id);
     cHid.set(id, hid);
     if (at.includes('Car') && idx >= 0 && slots[idx].carId === id) { if (hid) off(idx); else slots[idx].on = true; }
     else if (at.includes('Ball') && (id === bId || (!hid && bId < 0))) { bId = id; if (hid) sleepBall(); else if (!bExp.has(id)) bAct = true; }
    } else if (p === 'TAGame.CarComponent_TA:Vehicle') {
     boostRec.bindComponentCar(id, actId(a), fi, t, at, cSlot, slots);
    } else if (p.endsWith(':ReplicatedRBState')) {
     const rb = extractRigidBodySample(a);
     if (!rb) continue;
     const uRb: RLRCRigidBodySample = { ...rb, rbUpdated: true };
     if (at.includes('Ball') && !cHid.get(id) && !bExp.has(id) && (bId < 0 || id === bId || !bAct)) {
      if (bNeedsRb && bId === id && fi === bSpawnFi + 1 && nfs[fi - 1]?.ball.entityActive && hypot(rb.linearVelocity.x, rb.linearVelocity.y, rb.linearVelocity.z) < 10) {
       (nfs[fi - 1] as { ball: RLRCBallFrameState120Hz }).ball = { entityActive: true, rigidBody: uRb, rbUpdated: true, activeBallActorId: id, actorId: id };
      }
      bId = id; bAct = bUpd = true; bNeedsRb = false; bRb = uRb;
     } else if (at.includes('Car')) {
      cRb.set(id, uRb); cRbFi.set(id, fi);
      const idx = cSlot(id);
      if (idx >= 0 && !cHid.get(id)) {
       const s = slots[idx], pos = rb.position, vel = rb.linearVelocity, q = rb.rotation, upZ = 1 - 2 * (q.x * q.x + q.y * q.y);
       if (fi === s.spFi + 1 && nfs[fi - 1]?.cars[idx]?.entityActive && hypot(vel.x, vel.y, vel.z) < 50) {
        (nfs[fi - 1].cars as RLRCCarFrameState120Hz[])[idx] = { ...nfs[fi - 1].cars[idx], rigidBody: uRb, rbUpdated: true };
       }
       s.carId = id; s.on = s.upd = true; s.spFi = -2; s.rb = uRb;
       if (pos.z < 21.5 && abs(vel.z) < 25 && upZ >= 0.7) {
        s.flipped = false; s.jT = t;
        if (abs(pos.x) < 2500 && abs(pos.y) < 3500 && pos.z > 14.5 && pos.z < 20.5 && abs(vel.z) < 5 && upZ > 0.98) resting[idx].push(rb);
       }
      }
     }
    } else if (p.includes(':ReplicatedBoost')) {
     const idx = cSlot(cid), bv = boostRec.recordBoostAttribute(id, a, fi, idx);
     if (bv !== null && idx >= 0) slots[idx].boost = bv;
    } else if (p.includes('ReplicatedPickupData')) {
     const slotPos = slots.map((s) => (s.on ? (cRb.get(s.carId)?.position ?? s.rb.position) : null));
     const slotAct = slots.map((s) => s.on);
     const { slotIndex, grant } = boostRec.recordPickupAttribute(id, a, cSlot, slotPos, slotAct);
     if (grant > 0 && slotIndex >= 0) slots[slotIndex].boost = min(100, slots[slotIndex].boost + grant);
    } else if (p.endsWith(':ReplicatedThrottle')) {
     const th = decodeReplicatedAxisByte(a), idx = cSlot(id);
     if (th !== null && idx >= 0) slots[idx].th = th;
    } else if (p.endsWith(':ReplicatedSteer')) {
     const st = decodeReplicatedAxisByte(a), idx = cSlot(id);
     if (st !== null && idx >= 0) slots[idx].st = st;
    } else if (p.endsWith(':bReplicatedHandbrake')) {
     const idx = cSlot(id);
     if (idx >= 0) slots[idx].hb = Boolean(r?.Boolean);
    } else if (p.endsWith(':ReplicatedActive')) {
     const act = isComponentActiveByte(a);
     if (act !== null) {
      const idx = cSlot(cid);
      boostRec.recordActiveAttribute(id, at, act, fi, t, idx, idx >= 0 ? slots[idx] : undefined);
     }
    } else if (p.includes(':ReplicatedDemolish')) {
     const dem = rec(r?.DemolishExtended ?? r?.Demolish) ?? r, vCar = dem ? actId(dem.victim) : id, tCar = vCar >= 0 ? vCar : id;
     const vPri = cPri.get(tCar) ?? lastPri.get(tCar) ?? -1, vSlot = cSlot(tCar) >= 0 ? cSlot(tCar) : (pSlot.get(vPri) ?? -1);
     if (vSlot >= 0) off(vSlot);
     if (!isKf && (vSlot !== dS || abs(t - dT) > 0.5)) {
      const att = pName.get(dem ? actId(dem.attacker_pri ?? dem.attacker) : -1) ?? 'Player', vic = pName.get(vPri) ?? `Slot ${max(0, vSlot)}`;
      dems.push({
       kind: 'demolish', frameIndex120Hz: max(0, Math.round((t - t0) * RLRC_TICK_RATE)),
       sourceFrame30Hz: fi, timeSeconds: t, label: `Demolish: ${att} -> ${vic}`, slotIndex: vSlot, team: pTeam.get(vPri) ?? -1,
      });
      dT = t; dS = vSlot;
     }
    } else if (p.includes(':ReplicatedExplosionData')) {
     bExp.add(id);
     if (id === bId || bId < 0) sleepBall();
     if (!isKf) goals.push(fi);
    } else if (p.endsWith(':SecondsRemaining') && !isKf) secRem = max(0, trunc(num(r?.Int, secRem)));
    else if (p.endsWith(':bOverTime')) ot = Boolean(r?.Boolean ?? ot);
    else if (p.endsWith(':ReplicatedRoundCountDownNumber') && !isKf) cdNum = max(0, trunc(num(r?.Int)));
   }

   boostRec.commitFrame(t, dt, cdNum, slots);

   let cMask = 0;
   const cars = slots.map((s, slotIndex): RLRCCarFrameState120Hz => {
    const u = s.on && s.upd, rb = s.on ? { ...s.rb, rbUpdated: u } : DEF_CRB, q = rb.rotation, v = rb.linearVelocity;
    if (u) cMask |= 1 << slotIndex;
    const onGnd = s.on && rb.position.z < 21.5 && abs(v.z) < 25 && 1 - 2 * (q.x * q.x + q.y * q.y) >= 0.7;
    const el = onGnd ? 0 : max(0, t - (s.jT > -1e8 ? s.jT : t));
    return {
     slotIndex, entityActive: s.on, rigidBody: rb, rbUpdated: u, actorId: s.on ? s.carId : -1, boostAmount: s.on ? s.boost : 0,
     isOnGround: onGnd, isSupersonic: s.on && hypot(v.x, v.y, v.z) >= SS_SPD,
     hasFlipOrJump: s.on && (onGnd || (!s.flipped && el <= FLIP_EXP)),
     airTimeSinceJump: onGnd ? 0 : min(FLIP_EXP, el),
     activeFlags: s.on ? { boostActive: s.bOn, jumpActive: s.jOn, doubleJumpActive: s.dOn, dodgeActive: s.dgOn } : DEFAULT_ACTIVE_FLAGS,
     controls: s.on ? { throttle: s.th, steer: s.st, pitch: 0, yaw: 0, roll: 0, jump: s.jOn || s.dOn || s.dgOn, boost: s.bOn, handbrake: s.hb } : NEUTRAL_CONTROLS,
    };
   });
   const bu = bAct && bUpd, bOut = { ...bRb, rbUpdated: bu }, bAid = bAct ? bId : -1;
   nfs.push({
    sourceFrame30Hz: fi, timeSeconds: t, deltaSeconds: dt, secondsRemaining: secRem, isOvertime: ot, roundCountdownNumber: cdNum,
    blueScore: bSc, orangeScore: oSc, ball: { entityActive: bAct, rigidBody: bOut, rbUpdated: bu, activeBallActorId: bAid, actorId: bAid },
    cars, ballRbUpdated: bu, carRbUpdatedMask: cMask, rbUpdatedMask: cMask | (bu ? 1 << MAX_SLOTS : 0), activeBallActorId: bAid,
   });
  }

  boostRec.applyReconstructedBoostToTimeline(nfs);

  const restMap = new Map<number, readonly RLRCRigidBodySample[]>();
  for (let i = 0; i < MAX_SLOTS; i++) if (resting[i].length > 0) restMap.set(i, resting[i]);
  return { networkFrames: nfs, demolishBookmarks: dems, goalExplosionFrames: goals, restingSamplesBySlot: restMap };
 }
}

export const extractNetStreamRigidBodyAndBoostTimeline = (input: RLRCNetStreamExtractorInput): RLRCNetStreamExtractorOutput =>
 new RLRCNetStreamRigidBodyAndBoostExtractor().run(input);
