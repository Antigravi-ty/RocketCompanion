import type * as THREE from 'three';
import { normalizeVisualId } from '../../ui-core/config/vehicleConstants.ts';
import type { NameTagCarEntry } from '../../ui-core/config/nameTagConfig.ts';
import { DEFAULT_TEAM_COLORS } from './ArenaConstants.ts';
import type { CarLoadoutConfig } from './ArenaVehicleLoadoutManager.ts';
import type { VehicleVisualInput } from './arenaVehicleSlotPipeline.ts';
import type { VNextRosterManifest as CodecRosterManifest } from '../../network/protocol/VNextRosterManifestCodec.ts';

export type RosterCarRoleFlag = 'player' | 'bot' | 'ghost';

export interface RosterManifestCarEntry {
  readonly carIndex: number;
  readonly name: string;
  readonly team: 0 | 1;
  readonly visualId: string;
  readonly colorHex?: string | number | null;
  readonly paintFinish?: string | null;
  readonly decalId?: string | null;
  readonly boostVisual?: string | null;
  readonly boostAudio?: string | null;
  readonly isBot?: boolean;
  readonly roleFlag: RosterCarRoleFlag;
  readonly ghostOpacity?: number;
  readonly isLocalPlayer?: boolean;
}

export interface RosterManifest {
  readonly metadataHash: number;
  readonly cars: ReadonlyArray<RosterManifestCarEntry>;
  readonly mode?: string;
  readonly focusedCarIndex?: number;
}

export interface ApplyRosterManifestOptions {
  readonly force?: boolean;
  readonly hideMissingSlots?: boolean;
  readonly onUpdateNameTags?: (
    entries: NameTagCarEntry[],
    meta: { isMultiplayerOrMultiCarMode: boolean; focusedCarIndex?: number }
  ) => void;
}

export interface ApplyRosterManifestResult {
  readonly applied: boolean;
  readonly skippedByHash: boolean;
  readonly activeCarCount: number;
  readonly rebuiltSlots: number[];
  readonly ghostSlots: number[];
  readonly nameTagEntries: NameTagCarEntry[];
}

export interface RosterManifestVehicleRegistryPort {
  cars: Array<THREE.Group | null>;
  vehiclePresets: Array<string | null>;
  carColors: Array<number | null | undefined>;
  carLoaders: { teamColors?: number[] };
  loadout: {
    applySlotPaintOrColor(slot: number, fallbackTeamColor: number): void;
  };
  ensureCar(
    carIndex: number,
    teamIndex?: number | null,
    visualOrOptions?: VehicleVisualInput
  ): THREE.Group | null;
  setCarLoadout(carIndex: number, loadout?: CarLoadoutConfig | null): void;
  setCarGhostOpacity(carIndex: number, isGhost?: boolean, opacity?: number): boolean;
}

export interface RosterManifestArenaTarget {
  vehiclePreset: string;
  vehicleRegistry: RosterManifestVehicleRegistryPort;
  carRoleFlags: RosterCarRoleFlag[];
  lastRosterMetadataHash: number | null;
  markRenderTreeChanged?: () => void;
}

const DEFAULT_GHOST_OPACITY = 0.55;

export function applyRosterManifestToArena(
  arena: RosterManifestArenaTarget | null | undefined,
  manifest: RosterManifest | null | undefined,
  options: ApplyRosterManifestOptions = {}
): ApplyRosterManifestResult {
  if (!arena || !manifest || !Array.isArray(manifest.cars)) {
    return {
      applied: false,
      skippedByHash: false,
      activeCarCount: 0,
      rebuiltSlots: [],
      ghostSlots: [],
      nameTagEntries: [],
    };
  }

  const hasValidHash =
    typeof manifest.metadataHash === 'number' && Number.isFinite(manifest.metadataHash);
  if (!options.force && hasValidHash && arena.lastRosterMetadataHash === manifest.metadataHash) {
    return {
      applied: false,
      skippedByHash: true,
      activeCarCount: manifest.cars.length,
      rebuiltSlots: [],
      ghostSlots: [],
      nameTagEntries: [],
    };
  }

  const registry = arena.vehicleRegistry;
  const activeSlots = new Set<number>();
  const rebuiltSlots: number[] = [];
  const ghostSlots: number[] = [];
  const nameTagEntries: NameTagCarEntry[] = [];

  for (const entry of manifest.cars) {
    if (!entry || typeof entry.carIndex !== 'number' || entry.carIndex < 0 || entry.carIndex >= 8) {
      continue;
    }

    const carIndex = Math.trunc(entry.carIndex);
    activeSlots.add(carIndex);

    const team: 0 | 1 = entry.team === 1 ? 1 : 0;
    const visualId = normalizeVisualId(entry.visualId || arena.vehiclePreset || 'fennec');
    const hadCar = Boolean(registry.cars[carIndex]);
    const prevVisual = registry.vehiclePresets[carIndex];

    const carRoot = registry.ensureCar(carIndex, team, visualId);
    if (!hadCar || prevVisual !== visualId) {
      rebuiltSlots.push(carIndex);
    }

    const roleFlag: RosterCarRoleFlag =
      entry.roleFlag === 'ghost' || entry.roleFlag === 'bot'
        ? entry.roleFlag
        : entry.isBot
          ? 'bot'
          : 'player';
    const isBot = Boolean(entry.isBot ?? roleFlag === 'bot');

    const hasCustomColor =
      entry.colorHex !== undefined && entry.colorHex !== null && entry.colorHex !== '';
    if (!hasCustomColor) {
      registry.carColors[carIndex] = null;
      const fallbackTeamColor =
        registry.carLoaders.teamColors?.[team] ?? DEFAULT_TEAM_COLORS[team % 2];
      registry.loadout.applySlotPaintOrColor(carIndex, fallbackTeamColor);
    }

    registry.setCarLoadout(carIndex, {
      ...(hasCustomColor ? { colorHex: entry.colorHex } : {}),
      ...(entry.paintFinish !== undefined ? { paintFinish: entry.paintFinish } : {}),
      ...(entry.boostVisual !== undefined ? { boostVisual: entry.boostVisual } : {}),
      ...(entry.boostAudio !== undefined ? { boostAudio: entry.boostAudio } : {}),
      isBot,
    });

    arena.carRoleFlags[carIndex] = roleFlag;
    if (carRoot) {
      carRoot.visible = true;
      carRoot.userData.roleFlag = roleFlag;
      carRoot.userData.isGhost = roleFlag === 'ghost';
      if (entry.decalId !== undefined) {
        carRoot.userData.decalId = entry.decalId;
      }
    }

    if (roleFlag === 'ghost') {
      const opacity =
        typeof entry.ghostOpacity === 'number' && Number.isFinite(entry.ghostOpacity)
          ? entry.ghostOpacity
          : DEFAULT_GHOST_OPACITY;
      registry.setCarGhostOpacity(carIndex, true, opacity);
      ghostSlots.push(carIndex);
    } else {
      registry.setCarGhostOpacity(carIndex, false, 1.0);
    }

    nameTagEntries.push({
      carIndex,
      name: entry.name || `Player ${carIndex + 1}`,
      team,
    });
  }

  if (options.hideMissingSlots !== false) {
    for (let i = 0; i < registry.cars.length; i++) {
      if (activeSlots.has(i)) continue;
      const carRoot = registry.cars[i];
      if (carRoot) {
        carRoot.visible = false;
        carRoot.userData.isGhost = false;
        carRoot.userData.roleFlag = 'player';
      }
      arena.carRoleFlags[i] = 'player';
    }
  }

  options.onUpdateNameTags?.(nameTagEntries, {
    isMultiplayerOrMultiCarMode: nameTagEntries.length > 1,
    focusedCarIndex: manifest.focusedCarIndex,
  });

  arena.lastRosterMetadataHash = hasValidHash ? manifest.metadataHash : null;
  arena.markRenderTreeChanged?.();

  return {
    applied: true,
    skippedByHash: false,
    activeCarCount: activeSlots.size,
    rebuiltSlots,
    ghostSlots,
    nameTagEntries,
  };
}

export function fromVNextRosterManifest(
  manifest: CodecRosterManifest,
  focusedCarIndex?: number
): RosterManifest {
  return {
    metadataHash: manifest.metadataHash,
    mode: manifest.activityId,
    focusedCarIndex,
    cars: manifest.entries.map((e) => ({
      carIndex: e.carIndex,
      name: e.name,
      team: e.team,
      visualId: e.visualId,
      colorHex: e.colorHex,
      paintFinish: e.paintFinish,
      decalId: e.decalId,
      boostVisual: e.boostVisual,
      boostAudio: e.boostAudio,
      isBot: e.isBot,
      roleFlag: e.roleFlag,
      ghostOpacity: e.ghostOpacity,
    })),
  };
}
