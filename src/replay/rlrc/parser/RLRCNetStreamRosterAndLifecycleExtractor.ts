/**
 * RLRCNetStreamRosterAndLifecycleExtractor.ts
 * Roster slot assignment (0..5), spectator filtering, loadout/camera resolution, and car entity lifecycle tracking.
 */

import type { RLRCPlayerCameraSettings, RLRCTeamIndex } from '../RLRCReplayTypes.ts';
import {
  consolidateRosterAndLifecycleResult,
  defaultResolveRosterLoadout,
  extractActiveActorIdFromAttr,
  parseCameraSettingsAttr,
  parseRestingRigidBodySampleAttr,
  type CarLifecycleRecord,
  type PriLifecycleRecord,
  type RLRCDecodedNetworkFrameInput,
  type RLRCDecodedNewActor,
  type RLRCDecodedUpdatedActor,
  type RLRCFrameLifecycleSnapshot,
  type RLRCFrameSlotLifecycleEntry,
  type RLRCRosterAndLifecycleExtractionInput,
  type RLRCRosterAndLifecycleExtractionResult,
  type RLRCVehicleLoadoutResolverFn,
} from './RLRCNetStreamPriAndCarLifecycleHelpers.ts';

export type {
  RLRCDecodedNetworkFrameInput,
  RLRCDecodedNewActor,
  RLRCDecodedUpdatedActor,
  RLRCFrameLifecycleSnapshot,
  RLRCFrameSlotLifecycleEntry,
  RLRCRosterAndLifecycleExtractionInput,
  RLRCRosterAndLifecycleExtractionResult,
  RLRCVehicleLoadoutResolverFn,
};

export class RLRCNetStreamRosterAndLifecycleExtractor {
  private readonly resolveLoadout: RLRCVehicleLoadoutResolverFn;
  public constructor(loadoutResolver?: RLRCVehicleLoadoutResolverFn) {
    this.resolveLoadout = loadoutResolver ?? defaultResolveRosterLoadout;
  }

  public extract(
    input: RLRCRosterAndLifecycleExtractionInput
  ): RLRCRosterAndLifecycleExtractionResult {
    const { objects, frames } = input;
    const resolve = input.loadoutResolver ?? this.resolveLoadout;
    const kfSet: ReadonlySet<number> =
      input.keyframeIndices30Hz instanceof Set
        ? input.keyframeIndices30Hz
        : new Set(input.keyframeIndices30Hz ?? []);
    const types = new Map<number, string>();
    const teams = new Map<number, RLRCTeamIndex>();
    const pris = new Map<number, PriLifecycleRecord>();
    const cams = new Map<number, RLRCPlayerCameraSettings>();
    const priByCam = new Map<number, number>();
    const cars = new Map<number, CarLifecycleRecord>();
    const rawSegs: (readonly [number, number, number, number, number, number])[] = [];
    const framePairs: (readonly [number, number])[][] = new Array(frames.length);

    const getPri = (id: number, fi: number): PriLifecycleRecord => {
      let p = pris.get(id);
      if (!p) {
        p = {
          id,
          f0: fi,
          name: '',
          team: -1,
          pt: 0,
          spec: false,
          b0: 0,
          b1: 0,
          cid: -1,
          cars: new Set(),
          samples: [],
        };
        pris.set(id, p);
      }
      return p;
    };
    const closeRaw = (c: CarLifecycleRecord, f1: number, t1: number): void => {
      if (c.pid >= 0 && f1 >= c.f0) rawSegs.push([c.pid, c.cid, c.f0, f1, c.t0, t1]);
    };

    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi];
      const t = Number(fr.time ?? 0);
      const pFi = Math.max(0, fi - 1);
      const pT = fi > 0 ? Number(frames[pFi].time ?? t) : t;
      for (const da of fr.deletedActors ?? fr.deleted_actors ?? []) {
        const c = cars.get(da);
        if (c) {
          if (c.pid >= 0 && !c.hide) closeRaw(c, pFi, pT);
          cars.delete(da);
        }
        types.delete(da);
      }
      for (const na of fr.newActors ?? fr.new_actors ?? []) {
        const aid = Number(na.actorId ?? na.actor_id ?? -1);
        const oid = Number(na.objectId ?? na.object_id ?? -1);
        if (aid < 0 || types.has(aid)) continue;
        const ot = typeof na.objectName === 'string' ? na.objectName : (objects[oid] ?? '');
        types.set(aid, ot);
        if (ot.endsWith('Teams.Team0') || ot.endsWith('.Team0')) teams.set(aid, 0);
        else if (ot.endsWith('Teams.Team1') || ot.endsWith('.Team1')) teams.set(aid, 1);
        else if (ot.includes('PRI_TA')) getPri(aid, fi);
        else if (ot.includes('Car_Default')) {
          cars.set(aid, { cid: aid, pid: -1, hide: false, f0: fi, t0: t });
        }
      }
      for (const ua of fr.updatedActors ?? fr.updated_actors ?? []) {
        const aid = Number(ua.actorId ?? ua.actor_id ?? -1);
        const oid = Number(ua.objectId ?? ua.object_id ?? -1);
        const prop = typeof ua.propertyName === 'string' ? ua.propertyName : (objects[oid] ?? '');
        const key = prop.slice(prop.indexOf(':') + 1);
        const val = (ua.attribute ?? {}) as Record<string, unknown>;
        const ot = types.get(aid) ?? '';

        if (ot.includes('PRI_TA')) {
          const p = getPri(aid, fi);
          if (key === 'PlayerName' && typeof val.String === 'string') {
            pris.set(aid, { ...p, name: val.String });
          } else if (key === 'Team') {
            const tm = teams.get(extractActiveActorIdFromAttr(val));
            if (tm === 0 || tm === 1) pris.set(aid, { ...p, team: tm });
          } else if (key === 'PawnType' && typeof val.Byte === 'number') {
            pris.set(aid, { ...p, pt: val.Byte });
          } else if (
            (key === 'bIsSpectator' || key === 'bOnlySpectator') &&
            typeof val.Boolean === 'boolean'
          ) {
            pris.set(aid, { ...p, spec: p.spec || val.Boolean });
          } else if (key === 'ClientLoadouts') {
            const tl = val.TeamLoadout as Record<string, Record<string, unknown>> | undefined;
            if (tl) {
              pris.set(aid, {
                ...p,
                b0: typeof tl.blue?.body === 'number' ? tl.blue.body : p.b0,
                b1: typeof tl.orange?.body === 'number' ? tl.orange.body : p.b1,
              });
            }
          } else if (key === 'PersistentCamera') {
            const cid = extractActiveActorIdFromAttr(val);
            if (cid >= 0) {
              priByCam.set(cid, aid);
              pris.set(aid, { ...p, cid });
            }
          }
        } else if (ot.includes('CameraSettingsActor_TA')) {
          if (key === 'ProfileSettings') {
            const c = parseCameraSettingsAttr(val);
            if (c) cams.set(aid, c);
          } else if (key === 'PRI') {
            const pid = extractActiveActorIdFromAttr(val);
            if (pid >= 0) priByCam.set(aid, pid);
          }
        } else if (ot.includes('Car_Default')) {
          const prev = cars.get(aid);
          if (!prev) continue;
          const wasAct = prev.pid >= 0 && !prev.hide;
          let pid = prev.pid;
          let hide = prev.hide;
          if (key === 'PlayerReplicationInfo') {
            pid = extractActiveActorIdFromAttr(val);
            if (pid >= 0) getPri(pid, fi).cars.add(aid);
          } else if (key === 'bHidden' && typeof val.Boolean === 'boolean') {
            hide = val.Boolean;
          } else if (key === 'ReplicatedRBState' && !hide && pid >= 0) {
            const prof = pris.get(pid);
            if (prof && prof.samples.length < 64) {
              const s = parseRestingRigidBodySampleAttr(val);
              if (s) prof.samples.push(s);
            }
          }
          const nowAct = pid >= 0 && !hide;
          let f0 = prev.f0;
          let t0 = prev.t0;
          if (wasAct && !nowAct) {
            closeRaw(prev, pFi, pT);
          } else if (!wasAct && nowAct) {
            f0 = fi;
            t0 = t;
          } else if (wasAct && nowAct && prev.pid !== pid) {
            closeRaw(prev, pFi, pT);
            f0 = fi;
            t0 = t;
          }
          cars.set(aid, { cid: aid, pid, hide, f0, t0 });
        }
      }

      const pairs: (readonly [number, number])[] = [];
      for (const c of cars.values()) {
        if (c.pid >= 0 && !c.hide) pairs.push([c.cid, c.pid]);
      }
      framePairs[fi] = pairs;
    }

    if (frames.length > 0) {
      const lFi = frames.length - 1;
      const lT = Number(frames[lFi].time ?? 0);
      for (const c of cars.values()) {
        if (c.pid >= 0 && !c.hide) closeRaw(c, lFi, lT);
      }
    }
    for (const [cid, cam] of cams.entries()) {
      const pid = priByCam.get(cid);
      const p = pid !== undefined ? pris.get(pid) : undefined;
      if (p && !p.cam) pris.set(p.id, { ...p, cam });
    }
    for (const [pid, p] of pris.entries()) {
      if (!p.cam && p.cid >= 0 && cams.has(p.cid)) {
        pris.set(pid, { ...p, cam: cams.get(p.cid) });
      }
    }

    return consolidateRosterAndLifecycleResult({
      pris,
      rawSegs,
      framePairs,
      frames,
      kfSet,
      resolve,
    });
  }
}

export function extractRLRCNetStreamRosterAndLifecycle(
  input: RLRCRosterAndLifecycleExtractionInput
): RLRCRosterAndLifecycleExtractionResult {
  return new RLRCNetStreamRosterAndLifecycleExtractor(input.loadoutResolver).extract(input);
}
