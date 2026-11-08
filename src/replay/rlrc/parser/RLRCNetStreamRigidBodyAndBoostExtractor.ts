// RLRCNetStreamRigidBodyAndBoostExtractor.ts
// Extracts per-frame ball/car ReplicatedRBState, boost, flags, and demolish/explosion events.

import {
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_TICK_RATE,
  type RLRCBookmarkRecord,
  type RLRCCarComponentActiveFlags,
  type RLRCCarFrameState120Hz,
  type RLRCPlayerSlotMeta,
  type RLRCQuat,
  type RLRCRigidBodySample,
  type RLRCSourceNetworkFrame,
  type RLRCSynthesizedCarControls,
  type RLRCTeamIndex,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export const RLRC_DEFAULT_SPAWN_BOOST = 33.333;
export const RLRC_DEFAULT_BALL_REST_Z = 92.75;
export const RLRC_SUPERSONIC_SPEED_UU_S = 2200.0;
export const RLRC_FLIP_EXPIRATION_SECONDS = 1.25;

export interface RLRCBasis3x3 {
  readonly fwd: RLRCVec3;
  readonly right: RLRCVec3;
  readonly up: RLRCVec3;
}

export interface RLRCNetStreamRawFrame {
  readonly time: number;
  readonly delta: number;
  readonly new_actors?: readonly { readonly actor_id: number; readonly object_id: number }[];
  readonly deleted_actors?: readonly number[];
  readonly updated_actors?: readonly {
    readonly actor_id: number;
    readonly object_id: number;
    readonly attribute?: Record<string, unknown> | null;
  }[];
}

export interface RLRCNetStreamExtractorInput {
  readonly frames: readonly RLRCNetStreamRawFrame[];
  readonly objects: readonly string[];
  readonly names?: readonly string[];
  readonly keyframeIndices?: ReadonlySet<number>;
  readonly roster?: readonly RLRCPlayerSlotMeta[];
  readonly slotByPriActorId?: ReadonlyMap<number, number>;
}

export interface RLRCNetStreamExtractorOutput {
  readonly networkFrames: readonly RLRCSourceNetworkFrame[];
  readonly demolishBookmarks: readonly RLRCBookmarkRecord[];
  readonly goalExplosionFrames: readonly number[];
  readonly restingSamplesBySlot: ReadonlyMap<number, readonly RLRCRigidBodySample[]>;
}

export const ZERO_VEC3: RLRCVec3 = { x: 0, y: 0, z: 0 };
export const IDENTITY_QUAT: RLRCQuat = { x: 0, y: 0, z: 0, w: 1 };
export const DEFAULT_BALL_RB: RLRCRigidBodySample = {
  sleeping: true, position: { x: 0, y: 0, z: RLRC_DEFAULT_BALL_REST_Z },
  rotation: IDENTITY_QUAT, linearVelocity: ZERO_VEC3, angularVelocity: ZERO_VEC3,
};
export const DEFAULT_CAR_RB: RLRCRigidBodySample = {
  sleeping: true, position: ZERO_VEC3, rotation: IDENTITY_QUAT, linearVelocity: ZERO_VEC3, angularVelocity: ZERO_VEC3,
};
export const DEFAULT_ACTIVE_FLAGS: RLRCCarComponentActiveFlags = {
  boostActive: false, jumpActive: false, doubleJumpActive: false, dodgeActive: false,
};
export const NEUTRAL_CONTROLS: RLRCSynthesizedCarControls = {
  throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false,
};

const num = (v: unknown, fb = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function extractVec3(raw: unknown, fb: RLRCVec3 = ZERO_VEC3): RLRCVec3 {
  const r = rec(raw);
  return r ? { x: num(r.x ?? r.X, fb.x), y: num(r.y ?? r.Y, fb.y), z: num(r.z ?? r.Z, fb.z) } : fb;
}

export function normalizeQuat(raw: unknown): RLRCQuat {
  const r = rec(raw);
  if (!r) return IDENTITY_QUAT;
  const x = num(r.x ?? r.X), y = num(r.y ?? r.Y), z = num(r.z ?? r.Z), w = num(r.w ?? r.W, 1);
  const len = Math.hypot(x, y, z, w);
  return len < 1e-6 ? IDENTITY_QUAT : { x: x / len, y: y / len, z: z / len, w: w / len };
}

export function quatToBasis3x3(rot: RLRCQuat): RLRCBasis3x3 {
  const { x, y, z, w } = rot;
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
    linearVelocity: sl || !lv ? ZERO_VEC3 : extractVec3(lv),
    angularVelocity: sl || !av ? ZERO_VEC3 : extractVec3(av),
  };
}

export function normalizeReplicatedBoostAmount(raw: unknown): number | null {
  const o = rec(raw), rp = rec(o?.ReplicatedBoost) ?? o;
  const b = typeof raw === 'number' ? raw : rp?.boost_amount ?? rp?.boostAmount ?? o?.Byte;
  return typeof b === 'number' && Number.isFinite(b) ? (clamp(b, 0, 255) / 255) * 100 : null;
}

export function decodeReplicatedAxisByte(raw: unknown): number | null {
  const b = typeof raw === 'number' ? raw : num(rec(raw)?.Byte, Number.NaN);
  if (!Number.isFinite(b)) return null;
  return b === 128 ? 0 : clamp((clamp(b, 0, 255) - 128) / 127, -1, 1);
}

export function isComponentActiveByte(raw: unknown): boolean | null {
  const b = typeof raw === 'number' ? raw : num(rec(raw)?.Byte, Number.NaN);
  return Number.isFinite(b) ? (Math.trunc(b) & 1) === 1 : null;
}

const actId = (raw: unknown): number => {
  const o = rec(raw), aa = rec(o?.ActiveActor) ?? o;
  return !aa || aa.active === false ? -1 : Math.trunc(num(aa.actor, -1));
};

export class RLRCNetStreamRigidBodyAndBoostExtractor {
  public run(input: RLRCNetStreamExtractorInput): RLRCNetStreamExtractorOutput {
    const aType = new Map<number, string>(), cPri = new Map<number, number>(), lastPri = new Map<number, number>();
    const cHid = new Map<number, boolean>(), compCar = new Map<number, number>();
    const pName = new Map<number, string>(), pTeam = new Map<number, RLRCTeamIndex>();
    const nSlot = new Map<string, number>(), pSlot = new Map<number, number>();
    const slots = Array.from({ length: RLRC_MAX_PLAYER_SLOTS }, () => ({
      carId: -1, on: false, rb: DEFAULT_CAR_RB, boost: RLRC_DEFAULT_SPAWN_BOOST,
      th: 0, st: 0, hb: false, bOn: false, jOn: false, dOn: false, dgOn: false, jT: -1e9, flipped: false,
    }));
    const resting = Array.from({ length: RLRC_MAX_PLAYER_SLOTS }, (): RLRCRigidBodySample[] => []);

    for (const m of input.roster ?? []) {
      if (m.slotIndex >= 0 && m.slotIndex < RLRC_MAX_PLAYER_SLOTS) {
        nSlot.set(m.userName, m.slotIndex);
        if (m.priActorId >= 0) {
          pSlot.set(m.priActorId, m.slotIndex); pName.set(m.priActorId, m.userName); pTeam.set(m.priActorId, m.team);
        }
      }
    }
    for (const [p, s] of input.slotByPriActorId?.entries() ?? []) if (s >= 0 && s < RLRC_MAX_PLAYER_SLOTS) pSlot.set(p, s);

    const getSlot = (pid: number, hint?: string): number => {
      const h = pSlot.get(pid);
      if (h !== undefined) return h;
      const nm = hint ?? pName.get(pid);
      if (!nm) return -1;
      const bn = nSlot.get(nm);
      if (bn !== undefined) { pSlot.set(pid, bn); return bn; }
      if (nSlot.size >= RLRC_MAX_PLAYER_SLOTS) return -1;
      const nx = nSlot.size;
      nSlot.set(nm, nx); pSlot.set(pid, nx);
      return nx;
    };

    const cSlot = (cid: number): number => {
      const p = cPri.get(cid);
      return p !== undefined && pSlot.has(p) ? pSlot.get(p)! : slots.findIndex((s) => s.carId === cid);
    };

    const off = (i: number, clr = false): void => {
      const s = slots[i];
      if (clr) s.carId = -1;
      s.on = s.bOn = s.jOn = s.dOn = s.dgOn = s.hb = false; s.th = s.st = 0;
    };
    const offByCar = (cid: number, clr = false): void => {
      for (const [i, s] of slots.entries()) if (s.carId === cid) off(i, clr);
    };

    const networkFrames: RLRCSourceNetworkFrame[] = [];
    const demolishBookmarks: RLRCBookmarkRecord[] = [];
    const goalExplosionFrames: number[] = [];
    let ballActive = true, ballRb: RLRCRigidBodySample = DEFAULT_BALL_RB;
    let secondsRemaining = 300, isOvertime = false, roundCountdownNumber = 0;
    let blueScore = 0, orangeScore = 0, lastDemoT = -1e9, lastDemoS = -1;
    const t0 = input.frames.length > 0 ? input.frames[0].time : 0;

    for (let fi = 0; fi < input.frames.length; fi++) {
      const fr = input.frames[fi], t = num(fr.time), dt = num(fr.delta, 1 / 30), isKf = input.keyframeIndices?.has(fi) ?? false;
      for (const id of fr.deleted_actors ?? []) {
        aType.delete(id); cPri.delete(id); cHid.delete(id); compCar.delete(id); offByCar(id, true);
      }
      for (const na of fr.new_actors ?? []) {
        const ot = input.objects[na.object_id] ?? '';
        aType.set(na.actor_id, ot);
        if (ot.includes('Archetypes.Ball.')) ballActive = true;
      }

      for (const ua of fr.updated_actors ?? []) {
        const id = ua.actor_id, p = input.objects[ua.object_id] ?? '', a = ua.attribute, at = aType.get(id) ?? '';
        const r = rec(a), cid = compCar.get(id) ?? id;
        if (p.endsWith(':PlayerName')) {
          const v = r?.String;
          if (typeof v === 'string' && v.length > 0) { pName.set(id, v); getSlot(id, v); }
        } else if (p.endsWith('PlayerReplicationInfo:Team')) {
          const tt = aType.get(actId(a)) ?? '';
          if (tt.includes('Team0')) pTeam.set(id, 0);
          else if (tt.includes('Team1')) pTeam.set(id, 1);
        } else if (p === 'Engine.TeamInfo:Score') {
          const sc = Math.max(0, Math.trunc(num(r?.Int)));
          if (at.includes('Team0')) blueScore = sc;
          else if (at.includes('Team1')) orangeScore = sc;
        } else if (p === 'Engine.Pawn:PlayerReplicationInfo') {
          const pid = actId(a);
          if (pid < 0) {
            cPri.delete(id); offByCar(id, true);
          } else {
            cPri.set(id, pid); lastPri.set(id, pid);
            const idx = getSlot(pid);
            if (idx >= 0) {
              const s = slots[idx], isNew = s.carId !== id, hid = cHid.get(id) ?? false;
              s.carId = id; s.on = !hid;
              if (isNew && !hid) { s.boost = RLRC_DEFAULT_SPAWN_BOOST; s.bOn = s.jOn = s.dOn = s.dgOn = s.flipped = false; }
            }
          }
        } else if (p === 'Engine.Actor:bHidden' && at.includes('Car')) {
          const hid = Boolean(r?.Boolean ?? false), idx = cSlot(id);
          cHid.set(id, hid);
          if (idx >= 0 && slots[idx].carId === id) { if (hid) off(idx); else slots[idx].on = true; }
        } else if (p === 'TAGame.CarComponent_TA:Vehicle') {
          const vId = actId(a);
          if (vId >= 0) compCar.set(id, vId);
        } else if (p.endsWith(':ReplicatedRBState')) {
          const rb = extractRigidBodySample(a);
          if (rb && at.includes('Ball')) {
            ballActive = true; ballRb = rb;
          } else if (rb && at.includes('Car')) {
            const idx = cSlot(id);
            if (idx >= 0 && !(cHid.get(id) ?? false)) {
              const s = slots[idx], pos = rb.position, vel = rb.linearVelocity, q = rb.rotation;
              s.carId = id; s.on = true; s.rb = rb;
              const upZ = 1 - 2 * (q.x * q.x + q.y * q.y);
              if (pos.z < 21.5 && Math.abs(vel.z) < 25 && upZ >= 0.7) {
                s.flipped = false; s.jT = t;
                if (Math.abs(pos.x) < 2500 && Math.abs(pos.y) < 3500 && pos.z > 14.5 && pos.z < 20.5 && Math.abs(vel.z) < 5 && upZ > 0.98) {
                  resting[idx].push(rb);
                }
              }
            }
          }
        } else if (p.includes(':ReplicatedBoost')) {
          const bv = normalizeReplicatedBoostAmount(a), idx = cSlot(cid);
          if (bv !== null && idx >= 0) slots[idx].boost = bv;
        } else if (p.endsWith(':ReplicatedThrottle')) {
          const th = decodeReplicatedAxisByte(a), idx = cSlot(id);
          if (th !== null && idx >= 0) slots[idx].th = th;
        } else if (p.endsWith(':ReplicatedSteer')) {
          const st = decodeReplicatedAxisByte(a), idx = cSlot(id);
          if (st !== null && idx >= 0) slots[idx].st = st;
        } else if (p.endsWith(':bReplicatedHandbrake')) {
          const idx = cSlot(id);
          if (idx >= 0) slots[idx].hb = Boolean(r?.Boolean ?? false);
        } else if (p.endsWith(':ReplicatedActive')) {
          const act = isComponentActiveByte(a), idx = cSlot(cid);
          if (act !== null && idx >= 0) {
            const s = slots[idx];
            if (at.includes('Boost')) s.bOn = act;
            else if (at.includes('DoubleJump')) { s.dOn = act; if (act) s.flipped = true; }
            else if (at.includes('Dodge')) { s.dgOn = act; if (act) s.flipped = true; }
            else if (at.includes('Jump')) { s.jOn = act; if (act) s.jT = t; }
          }
        } else if (p.includes(':ReplicatedDemolish')) {
          const dem = rec(r?.DemolishExtended ?? r?.Demolish) ?? r;
          const vCar = dem ? actId(dem.victim) : id, tCar = vCar >= 0 ? vCar : id;
          const vPri = cPri.get(tCar) ?? lastPri.get(tCar) ?? -1;
          const vSlot = cSlot(tCar) >= 0 ? cSlot(tCar) : (pSlot.get(vPri) ?? -1);
          if (vSlot >= 0) off(vSlot);
          if (!isKf && (vSlot !== lastDemoS || Math.abs(t - lastDemoT) > 0.5)) {
            const att = pName.get(dem ? actId(dem.attacker_pri ?? dem.attacker) : -1) ?? 'Player';
            const vic = pName.get(vPri) ?? `Slot ${Math.max(0, vSlot)}`;
            demolishBookmarks.push({
              kind: 'demolish', frameIndex120Hz: Math.max(0, Math.round((t - t0) * RLRC_TICK_RATE)),
              sourceFrame30Hz: fi, timeSeconds: t, label: `Demolish: ${att} -> ${vic}`,
              slotIndex: vSlot, team: pTeam.get(vPri) ?? -1,
            });
            lastDemoT = t; lastDemoS = vSlot;
          }
        } else if (p.includes(':ReplicatedExplosionData') && !isKf) {
          goalExplosionFrames.push(fi); ballActive = false;
          ballRb = { ...ballRb, sleeping: true, linearVelocity: ZERO_VEC3, angularVelocity: ZERO_VEC3 };
        } else if (p.endsWith(':SecondsRemaining') && !isKf) {
          secondsRemaining = Math.max(0, Math.trunc(num(r?.Int, secondsRemaining)));
        } else if (p.endsWith(':bOverTime')) {
          isOvertime = Boolean(r?.Boolean ?? isOvertime);
        } else if (p.endsWith(':ReplicatedRoundCountDownNumber') && !isKf) {
          roundCountdownNumber = Math.max(0, Math.trunc(num(r?.Int)));
        }
      }

      const cars = slots.map((s, slotIndex): RLRCCarFrameState120Hz => {
        const rb = s.on ? s.rb : DEFAULT_CAR_RB, q = rb.rotation, v = rb.linearVelocity;
        const onGnd = s.on && rb.position.z < 21.5 && Math.abs(v.z) < 25 && 1 - 2 * (q.x * q.x + q.y * q.y) >= 0.7;
        const el = onGnd ? 0 : Math.max(0, t - (s.jT > -1e8 ? s.jT : t));
        return {
          slotIndex, entityActive: s.on, rigidBody: rb, boostAmount: s.on ? s.boost : 0,
          isOnGround: onGnd, isSupersonic: s.on && Math.hypot(v.x, v.y, v.z) >= RLRC_SUPERSONIC_SPEED_UU_S,
          hasFlipOrJump: s.on && (onGnd || (!s.flipped && el <= RLRC_FLIP_EXPIRATION_SECONDS)),
          airTimeSinceJump: onGnd ? 0 : Math.min(RLRC_FLIP_EXPIRATION_SECONDS, el),
          activeFlags: s.on
            ? { boostActive: s.bOn, jumpActive: s.jOn, doubleJumpActive: s.dOn, dodgeActive: s.dgOn }
            : DEFAULT_ACTIVE_FLAGS,
          controls: s.on
            ? { throttle: s.th, steer: s.st, pitch: 0, yaw: 0, roll: 0, jump: s.jOn || s.dOn || s.dgOn, boost: s.bOn, handbrake: s.hb }
            : NEUTRAL_CONTROLS,
        };
      });

      networkFrames.push({
        sourceFrame30Hz: fi, timeSeconds: t, deltaSeconds: dt,
        secondsRemaining, isOvertime, roundCountdownNumber, blueScore, orangeScore,
        ball: { entityActive: ballActive, rigidBody: ballRb }, cars,
      });
    }

    const restingSamplesBySlot = new Map<number, readonly RLRCRigidBodySample[]>();
    for (let i = 0; i < RLRC_MAX_PLAYER_SLOTS; i++) if (resting[i].length > 0) restingSamplesBySlot.set(i, resting[i]);
    return { networkFrames, demolishBookmarks, goalExplosionFrames, restingSamplesBySlot };
  }
}

export function extractNetStreamRigidBodyAndBoostTimeline(
  input: RLRCNetStreamExtractorInput
): RLRCNetStreamExtractorOutput {
  return new RLRCNetStreamRigidBodyAndBoostExtractor().run(input);
}
