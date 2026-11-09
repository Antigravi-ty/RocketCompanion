/**
 * RLRCNetStreamPriAndCarLifecycleHelpers.ts
 * Pure attribute parsers, fallback loadout resolver, and final roster/segment/frame-lifecycle
 * consolidation helpers for RLRCNetStreamRosterAndLifecycleExtractor.
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
  readonly time: number;
  readonly delta?: number;
  readonly newActors?: readonly RLRCDecodedNewActor[];
  readonly updatedActors?: readonly RLRCDecodedUpdatedActor[];
  readonly deletedActors?: readonly number[];
  readonly new_actors?: readonly RLRCDecodedNewActor[];
  readonly updated_actors?: readonly RLRCDecodedUpdatedActor[];
  readonly deleted_actors?: readonly number[];
}

export interface RLRCFrameSlotLifecycleEntry {
  readonly slotIndex: number;
  readonly entityActive: boolean;
  readonly activeCarActorId: number;
  readonly priActorId: number;
}

export interface RLRCFrameLifecycleSnapshot {
  readonly sourceFrame30Hz: number;
  readonly timeSeconds: number;
  readonly deltaSeconds: number;
  readonly isKeyframe: boolean;
  readonly slots: readonly RLRCFrameSlotLifecycleEntry[];
  readonly activeCarActorToSlot: ReadonlyMap<number, number>;
}

export interface RLRCRosterAndLifecycleExtractionInput {
  readonly objects: readonly string[];
  readonly names?: readonly string[];
  readonly frames: readonly RLRCDecodedNetworkFrameInput[];
  readonly keyframeIndices30Hz?: ReadonlySet<number> | readonly number[];
  readonly loadoutResolver?: RLRCVehicleLoadoutResolverFn;
}

export interface RLRCRosterAndLifecycleExtractionResult {
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly spectators: readonly {
    readonly priActorId: number;
    readonly userName: string;
    readonly pawnType: number;
  }[];
  readonly lifeSegments: readonly RLRCSourceEntityLifeSegment[];
  readonly frameLifecycles: readonly RLRCFrameLifecycleSnapshot[];
  readonly slotIndexByUserName: ReadonlyMap<string, number>;
  readonly slotIndexByPriActorId: ReadonlyMap<number, number>;
}

export interface PriLifecycleRecord {
  readonly id: number;
  readonly f0: number;
  readonly name: string;
  readonly team: RLRCTeamIndex | -1;
  readonly pt: number;
  readonly spec: boolean;
  readonly b0: number;
  readonly b1: number;
  readonly cid: number;
  readonly cam?: RLRCPlayerCameraSettings;
  readonly cars: Set<number>;
  readonly samples: RLRCRigidBodySample[];
}

export interface CarLifecycleRecord {
  readonly cid: number;
  readonly pid: number;
  readonly hide: boolean;
  readonly f0: number;
  readonly t0: number;
}

type HitboxVisualPair = readonly [RLRCHitboxId, RLRCVisualId];

const OCT: HitboxVisualPair = ['hitbox-octane', 'fennec'];
const HYB: HitboxVisualPair = ['hitbox-hybrid', 'insidio'];
const DOM: HitboxVisualPair = ['hitbox-dominus', 'dominus'];
const BRK: HitboxVisualPair = ['hitbox-breakout', 'breakout-mini'];
const PLK: HitboxVisualPair = ['hitbox-plank', 'sentinel'];
const MRC: HitboxVisualPair = ['hitbox-merc', 'merc'];

const CATALOG = new Map<number, HitboxVisualPair>([
  [23, OCT],
  [4284, OCT],
  [7948, OCT],
  [12814, ['hitbox-octane', 'ryza']],
  [3582, HYB],
  [5480, HYB],
  [2298, HYB],
  [1623, HYB],
  [2070, HYB],
  [403, DOM],
  [1568, DOM],
  [12262, DOM],
  [22, BRK],
  [1894, BRK],
  [12658, BRK],
  [4268, PLK],
  [803, PLK],
  [30, MRC],
]);

const mkLo = (
  bodyProductId: number,
  p: HitboxVisualPair,
  resolvedBy: RLRCVehicleLoadoutResolution['resolvedBy']
): RLRCVehicleLoadoutResolution => ({
  bodyProductId,
  hitboxId: p[0],
  visualId: p[1],
  resolvedBy,
});

export function defaultResolveRosterLoadout(
  bodyId: number | null | undefined,
  samples?: readonly RLRCRigidBodySample[] | null
): RLRCVehicleLoadoutResolution {
  const id = typeof bodyId === 'number' && Number.isFinite(bodyId) ? Math.trunc(bodyId) : 0;
  const hit = CATALOG.get(id);
  if (hit) return mkLo(id, hit, 'catalog');
  if (samples && samples.length > 0) {
    const m = samples.length >>> 1;
    const z = samples.map((s) => s.position.z).sort((a, b) => a - b)[m];
    const fz = samples
      .map((s) => 2 * (s.rotation.x * s.rotation.z - s.rotation.w * s.rotation.y))
      .sort((a, b) => a - b)[m];
    const fb = 'kinematics-fallback' as const;
    if (fz > 0.002) return mkLo(id, MRC, fb);
    if (z > 18.5) return mkLo(id, PLK, fb);
    if (z > 18.0) return mkLo(id, BRK, fb);
    if (Math.abs(fz) > 0.013) return mkLo(id, DOM, fb);
  }
  return mkLo(id, OCT, 'default');
}

export function extractActiveActorIdFromAttr(v: Record<string, unknown>): number {
  const a = v.ActiveActor as Record<string, unknown> | undefined;
  const n = a && typeof a === 'object' && a.active !== false ? Number(a.actor) : -1;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : -1;
}

export function parseCameraSettingsAttr(
  v: Record<string, unknown>
): RLRCPlayerCameraSettings | undefined {
  const c = (v.CamSettings ?? v) as Record<string, unknown> | undefined;
  const fov = Number(c?.fov ?? c?.FOV ?? 110);
  return c && Number.isFinite(fov) && fov > 0
    ? {
        fov,
        height: Number(c.height ?? c.Height ?? 100) || 100,
        pitch: Number(c.angle ?? c.pitch ?? c.Pitch ?? -3) || -3,
        distance: Number(c.distance ?? c.Distance ?? 270) || 270,
        stiffness: Number(c.stiffness ?? c.Stiffness ?? 0.4) || 0.4,
        swivelSpeed: Number(c.swivel ?? c.swivelSpeed ?? c.SwivelSpeed ?? 5.0) || 5.0,
        transitionSpeed:
          Number(c.transition ?? c.transitionSpeed ?? c.TransitionSpeed ?? 1.2) || 1.2,
      }
    : undefined;
}

export function parseRestingRigidBodySampleAttr(
  v: Record<string, unknown>
): RLRCRigidBodySample | null {
  const rb = (v.RigidBody ?? v) as Record<string, unknown> | undefined;
  const loc = rb?.location as Record<string, unknown> | undefined;
  const rot = rb?.rotation as Record<string, unknown> | undefined;
  if (!rb || !loc || !rot) return null;
  const x = Number(loc.x ?? 0);
  const y = Number(loc.y ?? 0);
  const z = Number(loc.z ?? 0);
  if (Math.abs(x) > 2500 || Math.abs(y) > 3500 || z < 15.5 || z > 20.5) return null;
  const lin = (rb.linear_velocity ?? rb.linearVelocity) as Record<string, unknown> | undefined;
  const vz = lin ? Number(lin.z ?? 0) : 0;
  return Math.abs(vz) > 5.0
    ? null
    : {
        sleeping: Boolean(rb.sleeping),
        position: { x, y, z },
        rotation: {
          x: Number(rot.x ?? 0),
          y: Number(rot.y ?? 0),
          z: Number(rot.z ?? 0),
          w: Number(rot.w ?? 1),
        },
        linearVelocity: {
          x: lin ? Number(lin.x ?? 0) : 0,
          y: lin ? Number(lin.y ?? 0) : 0,
          z: vz,
        },
        angularVelocity: { x: 0, y: 0, z: 0 },
      };
}

export function consolidateRosterAndLifecycleResult(params: {
  readonly pris: ReadonlyMap<number, PriLifecycleRecord>;
  readonly rawSegs: readonly (readonly [number, number, number, number, number, number])[];
  readonly framePairs: readonly (readonly (readonly [number, number])[])[];
  readonly frames: readonly RLRCDecodedNetworkFrameInput[];
  readonly kfSet: ReadonlySet<number>;
  readonly resolve: RLRCVehicleLoadoutResolverFn;
}): RLRCRosterAndLifecycleExtractionResult {
  const { pris, rawSegs, framePairs, frames, kfSet, resolve } = params;

  const merged = new Map<string, PriLifecycleRecord>();
  const spectators: { priActorId: number; userName: string; pawnType: number }[] = [];
  for (const p of pris.values()) {
    const name = p.name.trim();
    if (!name) continue;
    const hasCar = p.cars.size > 0;
    const hasTeam = p.team === 0 || p.team === 1;
    if (!hasCar && (p.pt === 1 || p.pt === 3 || p.spec || !hasTeam)) {
      spectators.push({ priActorId: p.id, userName: name, pawnType: p.pt || 1 });
      continue;
    }
    const prev = merged.get(name);
    if (!prev) {
      merged.set(name, p);
    } else {
      for (const c of p.cars) prev.cars.add(c);
      for (const s of p.samples) {
        if (prev.samples.length < 64) prev.samples.push(s);
      }
      merged.set(name, {
        ...prev,
        team: prev.team === -1 && hasTeam ? p.team : prev.team,
        b0: prev.b0 || p.b0,
        b1: prev.b1 || p.b1,
        cam: prev.cam ?? p.cam,
      });
    }
  }

  const candidates = [...merged.values()]
    .sort(
      (a, b) => (a.cars.size > 0 ? 0 : 1) - (b.cars.size > 0 ? 0 : 1) || a.f0 - b.f0 || a.id - b.id
    )
    .slice(0, RLRC_MAX_PLAYER_SLOTS);

  const roster: RLRCPlayerSlotMeta[] = [];
  const byName = new Map<string, number>();
  const byPri = new Map<number, number>();
  for (let slotIndex = 0; slotIndex < candidates.length; slotIndex++) {
    const c = candidates[slotIndex];
    const team: RLRCTeamIndex = c.team === 1 ? 1 : 0;
    const lo = resolve(team === 0 ? c.b0 || c.b1 : c.b1 || c.b0, c.samples);
    const userName = c.name.trim();
    roster.push({
      slotIndex,
      userName,
      team,
      priActorId: c.id,
      bodyProductId: lo.bodyProductId,
      hitboxId: lo.hitboxId,
      visualId: lo.visualId,
      ...(c.cam ? { cameraSettings: c.cam } : {}),
    });
    byName.set(userName, slotIndex);
    byPri.set(c.id, slotIndex);
  }
  for (const p of pris.values()) {
    const s = byName.get(p.name.trim());
    if (s !== undefined) byPri.set(p.id, s);
  }

  const lifeSegments: RLRCSourceEntityLifeSegment[] = [];
  for (const [
    pid,
    carActorId,
    startFrame30Hz,
    endFrame30Hz,
    startTimeSeconds,
    endTimeSeconds,
  ] of rawSegs) {
    const slotIndex = byPri.get(pid);
    if (slotIndex !== undefined) {
      lifeSegments.push({
        slotIndex,
        carActorId,
        startFrame30Hz,
        endFrame30Hz,
        startTimeSeconds,
        endTimeSeconds,
      });
    }
  }
  lifeSegments.sort((a, b) => a.startFrame30Hz - b.startFrame30Hz || a.slotIndex - b.slotIndex);

  const frameLifecycles: RLRCFrameLifecycleSnapshot[] = new Array(frames.length);
  for (let fi = 0; fi < frames.length; fi++) {
    const fr = frames[fi];
    const cSlot = new Int32Array(roster.length).fill(-1);
    const pSlot = new Int32Array(roster.length).fill(-1);
    const map = new Map<number, number>();
    for (const [cid, pid] of framePairs[fi]) {
      const s = byPri.get(pid);
      if (s === undefined || s < 0 || s >= roster.length) continue;
      if (cSlot[s] < 0 || cid > cSlot[s]) {
        cSlot[s] = cid;
        pSlot[s] = pid;
      }
      map.set(cid, s);
    }
    const slots: RLRCFrameSlotLifecycleEntry[] = new Array(roster.length);
    for (let s = 0; s < roster.length; s++) {
      const id = cSlot[s];
      slots[s] = {
        slotIndex: s,
        entityActive: id >= 0,
        activeCarActorId: id,
        priActorId: id >= 0 ? pSlot[s] : roster[s].priActorId,
      };
    }
    frameLifecycles[fi] = {
      sourceFrame30Hz: fi,
      timeSeconds: Number(fr.time ?? 0),
      deltaSeconds: Number(fr.delta ?? 1 / 30),
      isKeyframe: kfSet.has(fi),
      slots,
      activeCarActorToSlot: map,
    };
  }

  return {
    roster,
    spectators,
    lifeSegments,
    frameLifecycles,
    slotIndexByUserName: byName,
    slotIndexByPriActorId: byPri,
  };
}
