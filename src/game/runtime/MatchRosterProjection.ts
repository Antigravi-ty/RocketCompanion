import type { NameTagCameraMode } from '../../ui-core/config/nameTagConfig.ts';
import {
  getNameTagRuntimeState,
  hudStore,
  setNameTagRuntimeState,
  type NameTagCarEntry,
} from '../runtimeUiPort.ts';

export interface ProjectedRosterEntry {
  readonly carIndex: number;
  readonly name?: string | null;
  readonly username?: string | null;
  readonly team?: number;
  readonly isBot?: boolean;
  readonly isLocalPlayer?: boolean;
}

export interface MatchRosterPhysicsPort {
  setCarTeam?: (carIndex: number, team: number) => void;
}

export interface MatchRosterArenaPort {
  setCarTeam?: (carIndex: number, team: number) => void;
}

export interface ProjectMatchRosterParams {
  readonly roster: ReadonlyArray<ProjectedRosterEntry> | undefined;
  readonly focusedCarIndex?: number;
  readonly includeFocusedCarIndexInPatch?: boolean;
  readonly isMultiplayerOrMultiCarMode?: boolean;
  readonly physics?: MatchRosterPhysicsPort | null;
  readonly arena?: MatchRosterArenaPort | null;
  readonly localTeam?: number;
}

export function projectMatchRoster(params: ProjectMatchRosterParams): void {
  const {
    roster,
    focusedCarIndex,
    includeFocusedCarIndexInPatch = false,
    isMultiplayerOrMultiCarMode,
    physics,
    arena,
    localTeam,
  } = params;
  if (!Array.isArray(roster) || roster.length === 0) {
    if (typeof localTeam === 'number') {
      hudStore?.getState?.()?.setMatchState?.({ localTeam });
    }
    return;
  }

  for (const entry of roster) {
    if (typeof entry?.carIndex === 'number' && typeof entry?.team === 'number') {
      physics?.setCarTeam?.(entry.carIndex, entry.team);
      arena?.setCarTeam?.(entry.carIndex, entry.team);
    }
  }

  const focusedIdx = typeof focusedCarIndex === 'number' ? focusedCarIndex : undefined;
  const carEntries = roster.map((entry) => {
    const resolvedName = entry.name || `Car ${entry.carIndex + 1}`;
    return {
      carIndex: entry.carIndex,
      name: resolvedName,
      username: entry.username ?? resolvedName,
      team: entry.team === 1 ? 1 : 0,
      isBot: Boolean(entry.isBot),
      isLocalPlayer:
        typeof entry.isLocalPlayer === 'boolean'
          ? entry.isLocalPlayer
          : focusedIdx !== undefined
            ? entry.carIndex === focusedIdx
            : false,
    };
  });

  setNameTagRuntimeState({
    isMultiplayerOrMultiCarMode:
      typeof isMultiplayerOrMultiCarMode === 'boolean'
        ? isMultiplayerOrMultiCarMode
        : roster.length > 1,
    ...(includeFocusedCarIndexInPatch && focusedIdx !== undefined
      ? { focusedCarIndex: focusedIdx }
      : {}),
    carEntries,
  });

  if (typeof localTeam === 'number') {
    hudStore?.getState?.()?.setMatchState?.({ localTeam });
  }
}

export function projectRosterCarEntries(
  carEntries: ReadonlyArray<NameTagCarEntry | Record<string, unknown>>,
  options?: {
    readonly isMultiplayerOrMultiCarMode?: boolean;
    readonly focusedCarIndex?: number;
  }
): void {
  const patch: Record<string, unknown> = { carEntries: [...carEntries] };
  if (typeof options?.isMultiplayerOrMultiCarMode === 'boolean') {
    patch.isMultiplayerOrMultiCarMode = options.isMultiplayerOrMultiCarMode;
  }
  if (typeof options?.focusedCarIndex === 'number') {
    patch.focusedCarIndex = options.focusedCarIndex;
  }
  setNameTagRuntimeState(patch);
}

export function clearMatchRosterProjection(options?: {
  readonly isTunerArenaActive?: boolean;
  readonly activeCameraMode?: NameTagCameraMode;
  readonly focusedCarIndex?: number;
}): void {
  const patch: Record<string, unknown> = {
    isMultiplayerOrMultiCarMode: false,
    carEntries: [],
  };
  if (typeof options?.isTunerArenaActive === 'boolean') {
    patch.isTunerArenaActive = options.isTunerArenaActive;
  }
  if (options?.activeCameraMode !== undefined) {
    patch.activeCameraMode = options.activeCameraMode;
  }
  if (typeof options?.focusedCarIndex === 'number') {
    patch.focusedCarIndex = options.focusedCarIndex;
  }
  setNameTagRuntimeState(patch);
}

export function setMatchRosterMultiCarMode(isMultiplayerOrMultiCarMode: boolean): void {
  setNameTagRuntimeState({ isMultiplayerOrMultiCarMode });
}

export function patchProjectedCarEntry(
  carIndex: number,
  entryPatch: Record<string, unknown>
): void {
  const ntState = getNameTagRuntimeState();
  if (!Array.isArray(ntState?.carEntries) || ntState.carEntries.length === 0) return;
  setNameTagRuntimeState({
    carEntries: ntState.carEntries.map((c) =>
      c.carIndex === carIndex ? { ...c, ...entryPatch } : c
    ),
  });
}

export function mergeProjectedCarEntries(
  mergeEntries: (current: ReadonlyArray<NameTagCarEntry> | undefined) => NameTagCarEntry[],
  isMultiplayerOrMultiCarMode = true
): void {
  const currentNameTags = getNameTagRuntimeState?.();
  const updatedEntries = mergeEntries(currentNameTags?.carEntries);
  setNameTagRuntimeState?.({
    isMultiplayerOrMultiCarMode,
    carEntries: updatedEntries,
  });
}

export function projectNameTagCameraFocus(
  activeCameraMode: NameTagCameraMode | string,
  focusedCarIndex: number
): void {
  const nameTagRuntime = getNameTagRuntimeState();
  if (
    nameTagRuntime &&
    (nameTagRuntime.activeCameraMode !== activeCameraMode ||
      nameTagRuntime.focusedCarIndex !== focusedCarIndex)
  ) {
    setNameTagRuntimeState({
      activeCameraMode,
      focusedCarIndex,
    });
  }
}

export function bindNameTagTunerCallbacks(callbacks: {
  readonly onEnterTunerArena: () => void;
  readonly onExitTunerArena: () => void;
  readonly onReshuffleKickoffPositions: () => void;
  readonly onSelectPovCar: (carIndex: number) => void;
  readonly onFocusFreeCamOverview: () => void;
}): void {
  setNameTagRuntimeState(callbacks);
}

export function projectNameTagTunerState(state: {
  readonly isTunerArenaActive: boolean;
  readonly kickoffPermutationIndex: number;
  readonly activeCameraMode: NameTagCameraMode;
  readonly focusedCarIndex: number;
  readonly carEntries: NameTagCarEntry[];
}): void {
  setNameTagRuntimeState(state);
}
