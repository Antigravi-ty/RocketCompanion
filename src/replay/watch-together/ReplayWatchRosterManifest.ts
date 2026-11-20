/**
 * ReplayWatchRosterManifest.ts
 * Deterministic 1~6 car RosterManifest builder & 4-byte metadataHash computation
 * for Replay Watch Together (W1-05).
 */

import { REPLAY_TICK_RATE } from '../ReplayRingBuffer.ts';
import {
  resolveReplayRosterData,
  type ReplayRosterEntry,
  type ReplayRosterExtractionInput,
} from '../ReplayViewerRosterResolver.ts';
import type {
  ReplayWatchCarManifestEntry,
  ReplayWatchRoleFlag,
  ReplayWatchRosterManifest,
} from './ReplayWatchTogetherTypes.ts';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MAX_WATCH_CARS = 6;

function fnv1aUpdateString(hash: number, value: string): number {
  let h = hash >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i) & 0xff;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  h ^= 0xff;
  return Math.imul(h, FNV_PRIME) >>> 0;
}

function fnv1aUpdateInt(hash: number, value: number): number {
  let h = hash >>> 0;
  const v = Math.trunc(value) >>> 0;
  for (let shift = 0; shift < 32; shift += 8) {
    h ^= (v >>> shift) & 0xff;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

export function formatMetadataHashHex(hash: number): string {
  return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function computeReplayMetadataHash(
  manifest: Omit<ReplayWatchRosterManifest, 'metadataHash'>
): number {
  let h = FNV_OFFSET_BASIS;
  h = fnv1aUpdateString(h, manifest.replayId);
  h = fnv1aUpdateInt(h, manifest.totalFrames);
  h = fnv1aUpdateInt(h, manifest.tickRateHz);
  h = fnv1aUpdateInt(h, manifest.arenaPreset);
  h = fnv1aUpdateString(h, manifest.telestratorPermission);
  h = fnv1aUpdateInt(h, manifest.cars.length);

  for (let i = 0; i < manifest.cars.length; i++) {
    const car = manifest.cars[i];
    h = fnv1aUpdateInt(h, car.carIndex);
    h = fnv1aUpdateInt(h, car.slotKey);
    h = fnv1aUpdateInt(h, car.team);
    h = fnv1aUpdateString(h, car.roleFlag);
    h = fnv1aUpdateInt(h, car.isBot ? 1 : 0);
    h = fnv1aUpdateString(h, car.name);
    h = fnv1aUpdateString(h, car.visualId);
    h = fnv1aUpdateString(h, car.hitboxId);
    h = fnv1aUpdateInt(h, car.colorSlot);
    h = fnv1aUpdateString(h, car.colorHex);
    h = fnv1aUpdateString(h, car.paintFinish);
    h = fnv1aUpdateString(h, car.boostVisual);
    h = fnv1aUpdateString(h, car.boostAudio);
    h = fnv1aUpdateString(h, car.decalId);
  }
  return h >>> 0;
}

export interface BuildReplayWatchManifestInput {
  readonly replayId: string;
  readonly totalFrames: number;
  readonly tickRateHz?: number;
  readonly arenaPreset?: number;
  readonly telestratorPermission?: 'host_only' | 'everyone';
  readonly resolvedRoster?: readonly ReplayRosterEntry[];
  readonly extractionInput?: ReplayRosterExtractionInput;
  readonly roleOverrides?: Readonly<Record<number, ReplayWatchRoleFlag>>;
  readonly decalOverrides?: Readonly<Record<number, string>>;
}

function normalizeCarManifestEntry(
  entry: ReplayRosterEntry,
  roleOverrides?: Readonly<Record<number, ReplayWatchRoleFlag>>,
  decalOverrides?: Readonly<Record<number, string>>
): ReplayWatchCarManifestEntry {
  const carIndex = Math.max(0, Math.min(MAX_WATCH_CARS - 1, Math.trunc(entry.carIndex)));
  const team: 0 | 1 = entry.team === 1 ? 1 : 0;
  const isBot = Boolean(entry.botType) && !entry.isSelf;
  const roleFlag: ReplayWatchRoleFlag =
    roleOverrides?.[carIndex] ?? (isBot ? 'bot' : 'player');
  const slotKey =
    Number.isInteger(entry.slotKey) && entry.slotKey >= 1 && entry.slotKey <= MAX_WATCH_CARS
      ? entry.slotKey
      : carIndex + 1;

  return {
    carIndex,
    slotKey,
    name: (entry.name && entry.name.trim()) || `Car ${carIndex + 1}`,
    team,
    roleFlag,
    isBot,
    visualId: entry.visualId || 'octane',
    hitboxId: entry.hitboxId || 'octane',
    colorSlot: Number.isFinite(entry.colorSlot) ? Math.trunc(entry.colorSlot) : team === 1 ? 0 : 3,
    colorHex: entry.colorHex || (team === 1 ? '#ff7a2b' : '#2b8cff'),
    paintFinish: entry.paintFinish || 'metallic',
    boostVisual: entry.boostVisual || 'gold-rush',
    boostAudio: entry.boostAudio || 'rush',
    decalId: decalOverrides?.[carIndex] || 'none',
  };
}

export function buildReplayWatchRosterManifest(
  input: BuildReplayWatchManifestInput
): ReplayWatchRosterManifest {
  const sourceEntries =
    input.resolvedRoster && input.resolvedRoster.length > 0
      ? input.resolvedRoster
      : resolveReplayRosterData(input.extractionInput || {}).resolvedRoster;

  const deduped = new Map<number, ReplayWatchCarManifestEntry>();
  for (let i = 0; i < sourceEntries.length; i++) {
    const normalized = normalizeCarManifestEntry(
      sourceEntries[i],
      input.roleOverrides,
      input.decalOverrides
    );
    if (!deduped.has(normalized.carIndex)) {
      deduped.set(normalized.carIndex, normalized);
    }
  }

  const cars = Array.from(deduped.values())
    .sort((a, b) => a.carIndex - b.carIndex)
    .slice(0, MAX_WATCH_CARS);

  const base: Omit<ReplayWatchRosterManifest, 'metadataHash'> = {
    replayId: input.replayId || 'replay-session',
    totalFrames: Math.max(0, Math.trunc(input.totalFrames)),
    tickRateHz:
      typeof input.tickRateHz === 'number' && input.tickRateHz > 0
        ? input.tickRateHz
        : REPLAY_TICK_RATE,
    arenaPreset: typeof input.arenaPreset === 'number' ? Math.trunc(input.arenaPreset) : 0,
    telestratorPermission:
      input.telestratorPermission === 'everyone' ? 'everyone' : 'host_only',
    cars,
  };

  return {
    ...base,
    metadataHash: computeReplayMetadataHash(base),
  };
}

export function resolveCarEntryFromManifest(
  manifest: ReplayWatchRosterManifest | null,
  carIndex: number
): ReplayWatchCarManifestEntry | null {
  if (!manifest || carIndex < 0) return null;
  for (let i = 0; i < manifest.cars.length; i++) {
    if (manifest.cars[i].carIndex === carIndex) {
      return manifest.cars[i];
    }
  }
  return null;
}
