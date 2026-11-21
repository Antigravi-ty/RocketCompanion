/**
 * src/network/protocol/MatchExhibitionRosterManifest.ts
 * Wave 1 (W1-03) Channel 2 RosterManifest contract and deterministic 32-bit metadataHash
 * builder shared between Match and Exhibition (exp-multi-bots).
 */

import { ACTIVITY_IDS, type ActivityId } from './ReplicationBusProtocol.ts';
import {
  computeRosterMetadataHash as computeVNextRosterMetadataHash,
  type VNextRosterManifest,
} from './VNextRosterManifestCodec.ts';

export type RosterRoleFlag = 'player' | 'bot' | 'ghost';

export interface RosterManifestEntry {
  carIndex: number;
  keyNumber: number;
  team: 0 | 1;
  teamSlotIndex: number;
  name: string;
  roleFlag: RosterRoleFlag;
  isBot: boolean;
  botType: string | null;
  visualId: string;
  hitboxId: string;
  colorSlot: number;
  colorHex: string;
  paintFinish: string;
  boostVisual: string;
  boostAudio: string;
  anthemId: string | null;
}

export interface MatchExhibitionRosterManifest {
  manifestVersion: number;
  metadataHash: number;
  activityId: ActivityId;
  mode: 'match' | 'exp-multi-bots';
  arenaPreset: string;
  matchDurationSeconds: number;
  telestratorAllowed: boolean;
  totalCars: number;
  entries: RosterManifestEntry[];
}

export interface ExhibitionCarInput {
  carIndex: number;
  keyNumber?: number;
  team: 0 | 1 | number;
  teamSlotIndex?: number;
  isPlayer?: boolean;
  roleFlag?: RosterRoleFlag;
  botType?: string | null;
  visualId?: string;
  hitboxId?: string;
  colorSlot?: number;
  colorHex?: string;
  paintFinish?: string;
  boostVisual?: string;
  boostAudio?: string;
  anthemId?: string | null;
  name?: string | null;
  label?: string | null;
}

export interface MatchPlayerSlotInput {
  entityId: number;
  carIndex?: number;
  team: number;
  spawnSlot?: number;
  name: string;
  role?: string;
  isBot: boolean;
  roleFlag?: RosterRoleFlag;
  botType?: string | null;
  visualId: string;
  hitboxId: string;
  colorSlot: number;
  colorHex: string;
  paintFinish: string;
  boostVisual: string;
  boostAudio: string;
  anthemId?: string | null;
}

export interface BuildRosterManifestOptions {
  manifestVersion?: number;
  arenaPreset?: string;
  matchDurationSeconds?: number;
  telestratorAllowed?: boolean;
}

function fnv1aUpdate(hash: number, text: string): number {
  let h = hash >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= 0x7c;
  return Math.imul(h, 0x01000193) >>> 0;
}

/**
 * Computes a deterministic 32-bit unsigned FNV-1a hash (4 bytes) over roster entries and mode context.
 * Any change to car count, team, name, roleFlag, visualId, colorHex, or mode context alters the hash.
 */
export function computeRosterMetadataHash(
  entries: ReadonlyArray<RosterManifestEntry>,
  context: {
    activityId: ActivityId;
    mode: string;
    arenaPreset: string;
    matchDurationSeconds: number;
    telestratorAllowed: boolean;
  }
): number {
  let h = 0x811c9dc5;
  h = fnv1aUpdate(h, String(context.activityId));
  h = fnv1aUpdate(h, String(context.mode));
  h = fnv1aUpdate(h, String(context.arenaPreset));
  h = fnv1aUpdate(h, String(Math.round(context.matchDurationSeconds)));
  h = fnv1aUpdate(h, context.telestratorAllowed ? '1' : '0');
  h = fnv1aUpdate(h, String(entries.length));

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    h = fnv1aUpdate(
      h,
      [
        e.carIndex,
        e.keyNumber,
        e.team,
        e.teamSlotIndex,
        e.name,
        e.roleFlag,
        e.isBot ? 1 : 0,
        e.botType ?? '',
        e.visualId,
        e.hitboxId,
        e.colorSlot,
        e.colorHex.toLowerCase(),
        e.paintFinish,
        e.boostVisual,
        e.boostAudio,
        e.anthemId ?? '',
      ].join(':')
    );
  }
  return h >>> 0;
}

export function buildExhibitionRosterManifest(
  spawnedCars: ReadonlyArray<ExhibitionCarInput>,
  options: BuildRosterManifestOptions = {}
): MatchExhibitionRosterManifest {
  const arenaPreset = options.arenaPreset ?? 'dfh_stadium';
  const matchDurationSeconds = options.matchDurationSeconds ?? 300;
  const telestratorAllowed = options.telestratorAllowed ?? true;

  const entries: RosterManifestEntry[] = spawnedCars
    .slice(0, 6)
    .map((c, idx) => {
      const carIndex = typeof c.carIndex === 'number' ? c.carIndex : idx;
      const team: 0 | 1 = c.team === 1 ? 1 : 0;
      const isBot = c.roleFlag ? c.roleFlag === 'bot' : !c.isPlayer;
      const roleFlag: RosterRoleFlag = c.roleFlag ?? (c.isPlayer ? 'player' : 'bot');
      const fallbackName = c.isPlayer ? 'Player' : `Bot ${carIndex + 1}`;
      return {
        carIndex,
        keyNumber: c.keyNumber ?? carIndex + 1,
        team,
        teamSlotIndex: c.teamSlotIndex ?? Math.floor(carIndex / 2),
        name: String(c.name || c.label || fallbackName),
        roleFlag,
        isBot,
        botType: isBot ? (c.botType ?? 'necto') : null,
        visualId: String(c.visualId || 'fennec'),
        hitboxId: String(c.hitboxId || 'octane'),
        colorSlot: typeof c.colorSlot === 'number' ? c.colorSlot : team === 0 ? 3 : 10,
        colorHex: String(c.colorHex || (team === 0 ? '#1b76ff' : '#ff6b1a')),
        paintFinish: String(c.paintFinish || 'metallic'),
        boostVisual: String(c.boostVisual || 'standard'),
        boostAudio: String(c.boostAudio || 'standard'),
        anthemId: c.anthemId ?? null,
      };
    })
    .sort((a, b) => a.carIndex - b.carIndex);

  const metadataHash = computeRosterMetadataHash(entries, {
    activityId: ACTIVITY_IDS.EXHIBITION,
    mode: 'exp-multi-bots',
    arenaPreset,
    matchDurationSeconds,
    telestratorAllowed,
  });

  return {
    manifestVersion: options.manifestVersion ?? 1,
    metadataHash,
    activityId: ACTIVITY_IDS.EXHIBITION,
    mode: 'exp-multi-bots',
    arenaPreset,
    matchDurationSeconds,
    telestratorAllowed,
    totalCars: entries.length,
    entries,
  };
}

export function buildMatchRosterManifest(
  players: Iterable<MatchPlayerSlotInput>,
  options: BuildRosterManifestOptions = {}
): MatchExhibitionRosterManifest {
  const arenaPreset = options.arenaPreset ?? 'dfh_stadium';
  const matchDurationSeconds = options.matchDurationSeconds ?? 300;
  const telestratorAllowed = options.telestratorAllowed ?? true;

  const activeSlots = Array.from(players)
    .filter((p) => p && p.role !== 'spectator' && typeof p.entityId === 'number' && p.entityId >= 0)
    .sort((a, b) => a.entityId - b.entityId)
    .slice(0, 6);

  const entries: RosterManifestEntry[] = activeSlots.map((p, idx) => {
    const team: 0 | 1 = p.team === 1 ? 1 : 0;
    const roleFlag: RosterRoleFlag = p.roleFlag ?? (p.isBot ? 'bot' : 'player');
    return {
      carIndex: p.entityId,
      keyNumber: p.entityId + 1,
      team,
      teamSlotIndex: typeof p.spawnSlot === 'number' ? p.spawnSlot : idx,
      name: String(p.name || `Car ${p.entityId + 1}`),
      roleFlag,
      isBot: Boolean(p.isBot),
      botType: p.isBot ? (p.botType ?? 'nexto') : null,
      visualId: String(p.visualId || 'fennec'),
      hitboxId: String(p.hitboxId || 'octane'),
      colorSlot: typeof p.colorSlot === 'number' ? p.colorSlot : team === 0 ? 3 : 10,
      colorHex: String(p.colorHex || (team === 0 ? '#1b76ff' : '#ff6b1a')),
      paintFinish: String(p.paintFinish || 'metallic'),
      boostVisual: String(p.boostVisual || 'standard'),
      boostAudio: String(p.boostAudio || 'standard'),
      anthemId: p.anthemId ?? null,
    };
  });

  const metadataHash = computeRosterMetadataHash(entries, {
    activityId: ACTIVITY_IDS.MATCH,
    mode: 'match',
    arenaPreset,
    matchDurationSeconds,
    telestratorAllowed,
  });

  return {
    manifestVersion: options.manifestVersion ?? 1,
    metadataHash,
    activityId: ACTIVITY_IDS.MATCH,
    mode: 'match',
    arenaPreset,
    matchDurationSeconds,
    telestratorAllowed,
    totalCars: entries.length,
    entries,
  };
}

export function toVNextRosterManifest(
  manifest: MatchExhibitionRosterManifest,
  replayTotalFrames = 0
): VNextRosterManifest {
  const base = {
    manifestVersion: manifest.manifestVersion,
    activityId: String(manifest.activityId),
    arenaPreset: manifest.arenaPreset,
    matchDurationSeconds: manifest.matchDurationSeconds,
    replayTotalFrames,
    telestratorAllowed: manifest.telestratorAllowed,
    entries: manifest.entries.map((e) => ({
      carIndex: e.carIndex,
      slotKey: e.keyNumber,
      team: e.team,
      teamSlotIndex: e.teamSlotIndex,
      name: e.name,
      roleFlag: e.roleFlag,
      isBot: e.isBot,
      botType: e.botType,
      visualId: e.visualId,
      hitboxId: e.hitboxId,
      colorSlot: e.colorSlot,
      colorHex: e.colorHex,
      paintFinish: e.paintFinish,
      decalId: 'default',
      boostVisual: e.boostVisual,
      boostAudio: e.boostAudio,
      anthemId: e.anthemId,
      ghostOpacity: e.roleFlag === 'ghost' ? 0.5 : 1.0,
    })),
    trainingMeta: null,
  };
  return {
    ...base,
    metadataHash: computeVNextRosterMetadataHash(base),
  };
}
