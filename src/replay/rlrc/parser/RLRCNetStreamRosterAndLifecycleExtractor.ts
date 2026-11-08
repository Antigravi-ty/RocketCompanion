/**
 * RLRCNetStreamRosterAndLifecycleExtractor.ts
 * Roster slot assignment (0..5), spectator filtering, loadout/camera resolution, and car entity lifecycle tracking.
 */

import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCHitboxId,
  type RLRCPlayerCameraSettings,
  type RLRCPlayerSlotMeta,
  type RLRCRigidBodySample,
  type RLRCSourceEntityLifeSegment,
  type RLRCTeamIndex,
  type RLRCVehicleLoadoutResolution,
  type RLRCVisualId,
} from '../RLRCReplayTypes.ts';

export type RLRCVehicleLoadoutResolverFn = (
  bodyProductId: number | null | undefined,
  restingSamples?: readonly RLRCRigidBodySample[] | null
) => RLRCVehicleLoadoutResolution;

export type RLRCDecodedNewActor = Readonly<Record<string, unknown>>;
export type RLRCDecodedUpdatedActor = Readonly<Record<string, unknown>>;

export interface RLRCDecodedNetworkFrameInput {
  readonly time: number; readonly delta?: number;
  readonly newActors?: readonly RLRCDecodedNewActor[]; readonly updatedActors?: readonly RLRCDecodedUpdatedActor[]; readonly deletedActors?: readonly number[];
  readonly new_actors?: readonly RLRCDecodedNewActor[]; readonly updated_actors?: readonly RLRCDecodedUpdatedActor[]; readonly deleted_actors?: readonly number[];
}

export interface RLRCFrameSlotLifecycleEntry {
  readonly slotIndex: number; readonly entityActive: boolean; readonly activeCarActorId: number; readonly priActorId: number;
}

export interface RLRCFrameLifecycleSnapshot {
  readonly sourceFrame30Hz: number; readonly timeSeconds: number; readonly deltaSeconds: number; readonly isKeyframe: boolean;
  readonly slots: readonly RLRCFrameSlotLifecycleEntry[]; readonly activeCarActorToSlot: ReadonlyMap<number, number>;
}

export interface RLRCRosterAndLifecycleExtractionInput {
  readonly objects: readonly string[]; readonly names?: readonly string[];
  readonly frames: readonly RLRCDecodedNetworkFrameInput[];
  readonly keyframeIndices30Hz?: ReadonlySet<number> | readonly number[];
  readonly loadoutResolver?: RLRCVehicleLoadoutResolverFn;
}

export interface RLRCRosterAndLifecycleExtractionResult {
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly spectators: readonly { readonly priActorId: number; readonly userName: string; readonly pawnType: number }[];
  readonly lifeSegments: readonly RLRCSourceEntityLifeSegment[];
  readonly frameLifecycles: readonly RLRCFrameLifecycleSnapshot[];
  readonly slotIndexByUserName: ReadonlyMap<string, number>;
  readonly slotIndexByPriActorId: ReadonlyMap<number, number>;
}

interface PriRec {
  readonly id: number; readonly f0: number; readonly name: string; readonly team: RLRCTeamIndex | -1;
  readonly pt: number; readonly spec: boolean; readonly b0: number; readonly b1: number;
  readonly cid: number; readonly cam?: RLRCPlayerCameraSettings;
  readonly cars: Set<number>; readonly samples: RLRCRigidBodySample[];
}

interface CarRec { readonly cid: number; readonly pid: number; readonly hide: boolean; readonly f0: number; readonly t0: number; }

type Pair = readonly [RLRCHitboxId, RLRCVisualId];
const OCT: Pair = ['hitbox-octane', 'fennec'], HYB: Pair = ['hitbox-hybrid', 'insidio'], DOM: Pair = ['hitbox-dominus', 'dominus'];
const BRK: Pair = ['hitbox-breakout', 'breakout-mini'], PLK: Pair = ['hitbox-plank', 'sentinel'], MRC: Pair = ['hitbox-merc', 'merc'];
const CATALOG = new Map<number, Pair>([
  [23, OCT], [4284, OCT], [7948, OCT], [12814, ['hitbox-octane', 'ryza']],
  [3582, HYB], [5480, HYB], [2298, HYB], [1623, HYB], [2070, HYB],
  [403, DOM], [1568, DOM], [12262, DOM], [22, BRK], [1894, BRK], [12658, BRK], [4268, PLK], [803, PLK], [30, MRC],
]);

const mkLo = (bodyProductId: number, p: Pair, resolvedBy: RLRCVehicleLoadoutResolution['resolvedBy']): RLRCVehicleLoadoutResolution => ({
  bodyProductId, hitboxId: p[0], visualId: p[1], resolvedBy,
});

function defaultResolveLoadout(bodyId: number | null | undefined, samples?: readonly RLRCRigidBodySample[] | null): RLRCVehicleLoadoutResolution {
  const id = typeof bodyId === 'number' && Number.isFinite(bodyId) ? Math.trunc(bodyId) : 0, hit = CATALOG.get(id);
  if (hit) return mkLo(id, hit, 'catalog');
  if (samples && samples.length > 0) {
    const m = samples.length >>> 1;
    const z = samples.map((s) => s.position.z).sort((a, b) => a - b)[m];
    const fz = samples.map((s) => 2 * (s.rotation.x * s.rotation.z - s.rotation.w * s.rotation.y)).sort((a, b) => a - b)[m];
    const fb = 'kinematics-fallback' as const;
    if (fz > 0.002) return mkLo(id, MRC, fb);
    if (z > 18.5) return mkLo(id, PLK, fb);
    if (z > 18.0) return mkLo(id, BRK, fb);
    if (Math.abs(fz) > 0.013) return mkLo(id, DOM, fb);
  }
  return mkLo(id, OCT, 'default');
}

function actId(v: Record<string, unknown>): number {
  const a = v.ActiveActor as Record<string, unknown> | undefined;
  const n = a && typeof a === 'object' && a.active !== false ? Number(a.actor) : -1;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : -1;
}

function parseCam(v: Record<string, unknown>): RLRCPlayerCameraSettings | undefined {
  const c = (v.CamSettings ?? v) as Record<string, unknown> | undefined, fov = Number(c?.fov ?? c?.FOV ?? 110);
  return c && Number.isFinite(fov) && fov > 0 ? {
    fov, height: Number(c.height ?? c.Height ?? 100) || 100, pitch: Number(c.angle ?? c.pitch ?? c.Pitch ?? -3) || -3,
    distance: Number(c.distance ?? c.Distance ?? 270) || 270, stiffness: Number(c.stiffness ?? c.Stiffness ?? 0.4) || 0.4,
    swivelSpeed: Number(c.swivel ?? c.swivelSpeed ?? c.SwivelSpeed ?? 5.0) || 5.0,
    transitionSpeed: Number(c.transition ?? c.transitionSpeed ?? c.TransitionSpeed ?? 1.2) || 1.2,
  } : undefined;
}

function parseSample(v: Record<string, unknown>): RLRCRigidBodySample | null {
  const rb = (v.RigidBody ?? v) as Record<string, unknown> | undefined;
  const loc = rb?.location as Record<string, unknown> | undefined, rot = rb?.rotation as Record<string, unknown> | undefined;
  if (!rb || !loc || !rot) return null;
  const x = Number(loc.x ?? 0), y = Number(loc.y ?? 0), z = Number(loc.z ?? 0);
  if (Math.abs(x) > 2500 || Math.abs(y) > 3500 || z < 15.5 || z > 20.5) return null;
  const lin = (rb.linear_velocity ?? rb.linearVelocity) as Record<string, unknown> | undefined, vz = lin ? Number(lin.z ?? 0) : 0;
  return Math.abs(vz) > 5.0 ? null : {
    sleeping: Boolean(rb.sleeping), position: { x, y, z },
    rotation: { x: Number(rot.x ?? 0), y: Number(rot.y ?? 0), z: Number(rot.z ?? 0), w: Number(rot.w ?? 1) },
    linearVelocity: { x: lin ? Number(lin.x ?? 0) : 0, y: lin ? Number(lin.y ?? 0) : 0, z: vz },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
}

export class RLRCNetStreamRosterAndLifecycleExtractor {
  private readonly resolveLoadout: RLRCVehicleLoadoutResolverFn;
  public constructor(loadoutResolver?: RLRCVehicleLoadoutResolverFn) { this.resolveLoadout = loadoutResolver ?? defaultResolveLoadout; }

  public extract(input: RLRCRosterAndLifecycleExtractionInput): RLRCRosterAndLifecycleExtractionResult {
    const { objects, frames } = input, resolve = input.loadoutResolver ?? this.resolveLoadout;
    const kfSet: ReadonlySet<number> = input.keyframeIndices30Hz instanceof Set ? input.keyframeIndices30Hz : new Set(input.keyframeIndices30Hz ?? []);
    const types = new Map<number, string>(), teams = new Map<number, RLRCTeamIndex>();
    const pris = new Map<number, PriRec>(), cams = new Map<number, RLRCPlayerCameraSettings>(), priByCam = new Map<number, number>();
    const cars = new Map<number, CarRec>(), rawSegs: (readonly [number, number, number, number, number, number])[] = [];
    const framePairs: (readonly [number, number])[][] = new Array(frames.length);

    const getPri = (id: number, fi: number): PriRec => {
      let p = pris.get(id);
      if (!p) { p = { id, f0: fi, name: '', team: -1, pt: 0, spec: false, b0: 0, b1: 0, cid: -1, cars: new Set(), samples: [] }; pris.set(id, p); }
      return p;
    };
    const closeRaw = (c: CarRec, f1: number, t1: number): void => { if (c.pid >= 0 && f1 >= c.f0) rawSegs.push([c.pid, c.cid, c.f0, f1, c.t0, t1]); };

    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi], t = Number(fr.time ?? 0), pFi = Math.max(0, fi - 1), pT = fi > 0 ? Number(frames[pFi].time ?? t) : t;
      for (const da of fr.deletedActors ?? fr.deleted_actors ?? []) {
        const c = cars.get(da);
        if (c) { if (c.pid >= 0 && !c.hide) closeRaw(c, pFi, pT); cars.delete(da); }
        types.delete(da);
      }
      for (const na of fr.newActors ?? fr.new_actors ?? []) {
        const aid = Number(na.actorId ?? na.actor_id ?? -1), oid = Number(na.objectId ?? na.object_id ?? -1);
        if (aid < 0 || types.has(aid)) continue;
        const ot = typeof na.objectName === 'string' ? na.objectName : objects[oid] ?? '';
        types.set(aid, ot);
        if (ot.endsWith('Teams.Team0') || ot.endsWith('.Team0')) teams.set(aid, 0);
        else if (ot.endsWith('Teams.Team1') || ot.endsWith('.Team1')) teams.set(aid, 1);
        else if (ot.includes('PRI_TA')) getPri(aid, fi);
        else if (ot.includes('Car_Default')) cars.set(aid, { cid: aid, pid: -1, hide: false, f0: fi, t0: t });
      }
      for (const ua of fr.updatedActors ?? fr.updated_actors ?? []) {
        const aid = Number(ua.actorId ?? ua.actor_id ?? -1), oid = Number(ua.objectId ?? ua.object_id ?? -1);
        const prop = typeof ua.propertyName === 'string' ? ua.propertyName : objects[oid] ?? '';
        const key = prop.slice(prop.indexOf(':') + 1);
        const val = (ua.attribute ?? {}) as Record<string, unknown>, ot = types.get(aid) ?? '';

        if (ot.includes('PRI_TA')) {
          const p = getPri(aid, fi);
          if (key === 'PlayerName' && typeof val.String === 'string') pris.set(aid, { ...p, name: val.String });
          else if (key === 'Team') { const tm = teams.get(actId(val)); if (tm === 0 || tm === 1) pris.set(aid, { ...p, team: tm }); }
          else if (key === 'PawnType' && typeof val.Byte === 'number') pris.set(aid, { ...p, pt: val.Byte });
          else if ((key === 'bIsSpectator' || key === 'bOnlySpectator') && typeof val.Boolean === 'boolean') pris.set(aid, { ...p, spec: p.spec || val.Boolean });
          else if (key === 'ClientLoadouts') {
            const tl = val.TeamLoadout as Record<string, Record<string, unknown>> | undefined;
            if (tl) pris.set(aid, { ...p, b0: typeof tl.blue?.body === 'number' ? tl.blue.body : p.b0, b1: typeof tl.orange?.body === 'number' ? tl.orange.body : p.b1 });
          } else if (key === 'PersistentCamera') {
            const cid = actId(val); if (cid >= 0) { priByCam.set(cid, aid); pris.set(aid, { ...p, cid }); }
          }
        } else if (ot.includes('CameraSettingsActor_TA')) {
          if (key === 'ProfileSettings') { const c = parseCam(val); if (c) cams.set(aid, c); }
          else if (key === 'PRI') { const pid = actId(val); if (pid >= 0) priByCam.set(aid, pid); }
        } else if (ot.includes('Car_Default')) {
          const prev = cars.get(aid); if (!prev) continue;
          const wasAct = prev.pid >= 0 && !prev.hide;
          let pid = prev.pid, hide = prev.hide;
          if (key === 'PlayerReplicationInfo') { pid = actId(val); if (pid >= 0) getPri(pid, fi).cars.add(aid); }
          else if (key === 'bHidden' && typeof val.Boolean === 'boolean') hide = val.Boolean;
          else if (key === 'ReplicatedRBState' && !hide && pid >= 0) {
            const prof = pris.get(pid); if (prof && prof.samples.length < 64) { const s = parseSample(val); if (s) prof.samples.push(s); }
          }
          const nowAct = pid >= 0 && !hide;
          let f0 = prev.f0, t0 = prev.t0;
          if (wasAct && !nowAct) closeRaw(prev, pFi, pT);
          else if (!wasAct && nowAct) { f0 = fi; t0 = t; }
          else if (wasAct && nowAct && prev.pid !== pid) { closeRaw(prev, pFi, pT); f0 = fi; t0 = t; }
          cars.set(aid, { cid: aid, pid, hide, f0, t0 });
        }
      }
      const pairs: (readonly [number, number])[] = [];
      for (const c of cars.values()) if (c.pid >= 0 && !c.hide) pairs.push([c.cid, c.pid]);
      framePairs[fi] = pairs;
    }

    if (frames.length > 0) {
      const lFi = frames.length - 1, lT = Number(frames[lFi].time ?? 0);
      for (const c of cars.values()) if (c.pid >= 0 && !c.hide) closeRaw(c, lFi, lT);
    }
    for (const [cid, cam] of cams.entries()) {
      const pid = priByCam.get(cid), p = pid !== undefined ? pris.get(pid) : undefined;
      if (p && !p.cam) pris.set(p.id, { ...p, cam });
    }
    for (const [pid, p] of pris.entries()) if (!p.cam && p.cid >= 0 && cams.has(p.cid)) pris.set(pid, { ...p, cam: cams.get(p.cid) });

    const merged = new Map<string, PriRec>(), spectators: { priActorId: number; userName: string; pawnType: number }[] = [];
    for (const p of pris.values()) {
      const name = p.name.trim(); if (!name) continue;
      const hasCar = p.cars.size > 0, hasTeam = p.team === 0 || p.team === 1;
      if (!hasCar && (p.pt === 1 || p.pt === 3 || p.spec || !hasTeam)) { spectators.push({ priActorId: p.id, userName: name, pawnType: p.pt || 1 }); continue; }
      const prev = merged.get(name);
      if (!prev) merged.set(name, p);
      else {
        for (const c of p.cars) prev.cars.add(c);
        for (const s of p.samples) if (prev.samples.length < 64) prev.samples.push(s);
        merged.set(name, { ...prev, team: prev.team === -1 && hasTeam ? p.team : prev.team, b0: prev.b0 || p.b0, b1: prev.b1 || p.b1, cam: prev.cam ?? p.cam });
      }
    }

    const candidates = [...merged.values()]
      .sort((a, b) => ((a.cars.size > 0 ? 0 : 1) - (b.cars.size > 0 ? 0 : 1)) || (a.f0 - b.f0) || (a.id - b.id))
      .slice(0, RLRC_MAX_PLAYER_SLOTS);

    const roster: RLRCPlayerSlotMeta[] = [], byName = new Map<string, number>(), byPri = new Map<number, number>();
    for (let slotIndex = 0; slotIndex < candidates.length; slotIndex++) {
      const c = candidates[slotIndex], team: RLRCTeamIndex = c.team === 1 ? 1 : 0;
      const lo = resolve(team === 0 ? c.b0 || c.b1 : c.b1 || c.b0, c.samples), userName = c.name.trim();
      roster.push({ slotIndex, userName, team, priActorId: c.id, bodyProductId: lo.bodyProductId, hitboxId: lo.hitboxId, visualId: lo.visualId, ...(c.cam ? { cameraSettings: c.cam } : {}) });
      byName.set(userName, slotIndex);
      byPri.set(c.id, slotIndex);
    }
    for (const p of pris.values()) { const s = byName.get(p.name.trim()); if (s !== undefined) byPri.set(p.id, s); }

    const lifeSegments: RLRCSourceEntityLifeSegment[] = [];
    for (const [pid, carActorId, startFrame30Hz, endFrame30Hz, startTimeSeconds, endTimeSeconds] of rawSegs) {
      const slotIndex = byPri.get(pid);
      if (slotIndex !== undefined) lifeSegments.push({ slotIndex, carActorId, startFrame30Hz, endFrame30Hz, startTimeSeconds, endTimeSeconds });
    }
    lifeSegments.sort((a, b) => (a.startFrame30Hz - b.startFrame30Hz) || (a.slotIndex - b.slotIndex));

    const frameLifecycles: RLRCFrameLifecycleSnapshot[] = new Array(frames.length);
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi], cSlot = new Int32Array(roster.length).fill(-1), pSlot = new Int32Array(roster.length).fill(-1), map = new Map<number, number>();
      for (const [cid, pid] of framePairs[fi]) {
        const s = byPri.get(pid);
        if (s === undefined || s < 0 || s >= roster.length) continue;
        if (cSlot[s] < 0 || cid > cSlot[s]) { cSlot[s] = cid; pSlot[s] = pid; }
        map.set(cid, s);
      }
      const slots: RLRCFrameSlotLifecycleEntry[] = new Array(roster.length);
      for (let s = 0; s < roster.length; s++) {
        const id = cSlot[s];
        slots[s] = { slotIndex: s, entityActive: id >= 0, activeCarActorId: id, priActorId: id >= 0 ? pSlot[s] : roster[s].priActorId };
      }
      frameLifecycles[fi] = { sourceFrame30Hz: fi, timeSeconds: Number(fr.time ?? 0), deltaSeconds: Number(fr.delta ?? 0), isKeyframe: kfSet.has(fi), slots, activeCarActorToSlot: map };
    }
    return { roster, spectators, lifeSegments, frameLifecycles, slotIndexByUserName: byName, slotIndexByPriActorId: byPri };
  }
}

export function extractRLRCNetStreamRosterAndLifecycle(input: RLRCRosterAndLifecycleExtractionInput): RLRCRosterAndLifecycleExtractionResult {
  return new RLRCNetStreamRosterAndLifecycleExtractor(input.loadoutResolver).extract(input);
}
