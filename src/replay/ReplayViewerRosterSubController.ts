/**
 * ReplayViewerRosterSubController.ts
 * Pure replay roster extraction pipeline and stateful POV / loadout SubController
 * for StandaloneReplayViewerController.
 */

import { MAX_CARS } from '../physics/RocketSimConstants.ts';
import {
  normalizeVisualId,
  resolveVehicleHitboxId,
} from '../ui-core/config/vehicleConstants';
import { getMaterialsConfig } from '../ui-core/config/materialsConfig';
import { resolveBotFallbackColorForTeam } from '../ui-core/config/botsLoadoutConfig';
import {
  setNameTagRuntimeState,
  useSpatialAudioStore,
  useAppStore,
  hudStore,
} from '../game/runtimeUiPort.ts';
import { gameAudio } from '../audio/GameAudioEngineFacade.ts';
import {
  resolveReplayRosterData,
  type ReplayRosterEntry,
  type ReplayRosterMetaItem,
  type ReplayRosterSignalItem,
  type ReplayRosterMetadataLike,
  type ReplayRosterExtractionInput,
  type ReplayRosterResolutionResult,
} from './ReplayViewerRosterResolver.ts';

export type {
  ReplayRosterEntry,
  ReplayRosterMetaItem,
  ReplayRosterSignalItem,
  ReplayRosterMetadataLike,
  ReplayRosterExtractionInput,
  ReplayRosterResolutionResult,
};

export interface ReplayViewerRosterRuntimePort {
  playerCarIndex?: number;
  selectedPreset?: string;
  physics?: {
    numCars: number;
    isCarSlotActive?: (carIndex: number) => boolean;
    removeCar?: (carIndex: number) => void;
    addCarAtSlot?: (carIndex: number, team: number, hitboxId: string) => void;
    addCar?: (team: number, hitboxId: string) => void;
    setCarTeam?: (carIndex: number, team: number) => void;
    setCarHitbox?: (carIndex: number, hitboxId: string) => void;
  } | null;
  arena?: {
    playerCarIndex?: number;
    cars?: Array<{ visible?: boolean } | null | undefined>;
    ensureOpponent?: () => void;
    ensureCar?: (carIndex: number, team: number, visualId: string) => void;
    swapCarVisual?: (carIndex: number, visualId: string) => void;
    setCarTeam?: (carIndex: number, team: number) => void;
    setCarColor?: (carIndex: number, colorHex: string) => void;
    setCarLoadout?: (carIndex: number, loadout: Record<string, unknown>) => void;
  } | null;
  keyboard?: { ballControlEnabled?: boolean } | null;
  camera?: { resetView?: () => void } | null;
  flipResetVisual?: { dispose?: () => void } | null;
  getFlipResetVisual?: (carIndex: number) => { play?: () => void } | null;
  releaseGoalReplayCameraOverride?: () => void;
  options?: {
    gameAudio?: {
      setCarBoostAudioVariation?: (carIndex: number, boostAudio: string) => void;
      silenceAll?: () => void;
      play?: (cue: string, volume?: number) => void;
    } | null;
  } | null;
}

export interface ReplayViewerRosterModePort {
  directorPreview?: { isReplayActive?: boolean; goalScorerCarIndex?: number } | null;
  isGoalReplayActive?: () => boolean;
  setReplayCameraMode?: (mode: string) => void;
}

export class ReplayViewerRosterSubController {
  public resolvedRoster: ReplayRosterEntry[] = [];
  public slotKeyToCarIndex: Record<number, number> = {};
  public localTeam = 0;
  public activePovCarIndex = 0;
  public activePovSlotKey = 1;
  public activePovTeam = 0;
  public isTakenOverLoadoutApplied = false;
  public activeTakenOverAnthemId = 'none';

  clear(): void {
    this.resolvedRoster = [];
    this.slotKeyToCarIndex = {};
    this.localTeam = 0;
    this.activePovCarIndex = 0;
    this.activePovSlotKey = 1;
    this.activePovTeam = 0;
    this.isTakenOverLoadoutApplied = false;
    this.activeTakenOverAnthemId = 'none';
  }

  resolveAndApplyToArena(
    input: ReplayRosterExtractionInput,
    runtime: ReplayViewerRosterRuntimePort | null,
  ): void {
    const resolved = resolveReplayRosterData(input);
    this.resolvedRoster = resolved.resolvedRoster;
    this.localTeam = resolved.localTeam;
    this.slotKeyToCarIndex = resolved.slotKeyToCarIndex;
    this.activePovCarIndex = resolved.activePovCarIndex;
    this.activePovSlotKey = resolved.activePovSlotKey;
    this.activePovTeam = resolved.activePovTeam;

    if (runtime?.physics) {
      const activeSet = new Set(this.resolvedRoster.map((e) => e.carIndex));
      for (let c = MAX_CARS - 1; c >= 0; c--) {
        if (!activeSet.has(c) && runtime.physics.isCarSlotActive?.(c)) {
          runtime.physics.removeCar?.(c);
        }
      }
      for (const e of this.resolvedRoster) {
        if (typeof runtime.physics.addCarAtSlot === 'function') {
          runtime.physics.addCarAtSlot(e.carIndex, e.team, e.hitboxId);
        } else {
          while (
            runtime.physics.numCars <= e.carIndex &&
            typeof runtime.physics.addCar === 'function'
          ) {
            runtime.physics.addCar(e.team, e.hitboxId);
          }
          runtime.physics.setCarTeam?.(e.carIndex, e.team);
        }
      }
    }

    this.applyRecordedLoadoutsToArena(runtime);
  }

  applyRecordedLoadoutsToArena(runtime: ReplayViewerRosterRuntimePort | null): void {
    const allEntries = this.resolvedRoster;
    if (allEntries.length === 0) return;
    const audio = runtime?.options?.gameAudio || gameAudio;

    if (runtime?.physics) {
      for (const e of allEntries) {
        runtime.physics.setCarTeam?.(e.carIndex, e.team);
        runtime.physics.setCarHitbox?.(e.carIndex, e.hitboxId);
      }
    }

    if (runtime?.arena) {
      if (allEntries.length > 1) {
        runtime.arena.ensureOpponent?.();
      }
      const activeSet = new Set(allEntries.map((e) => e.carIndex));
      for (const e of allEntries) {
        runtime.arena.ensureCar?.(e.carIndex, e.team, e.visualId);
        runtime.arena.setCarTeam?.(e.carIndex, e.team);
        runtime.arena.setCarColor?.(e.carIndex, e.colorHex);
        runtime.arena.setCarLoadout?.(e.carIndex, {
          name: e.name,
          colorHex: e.colorHex,
          paintFinish: e.paintFinish,
          boostVisual: e.boostVisual,
          boostAudio: e.boostAudio,
        });
        audio?.setCarBoostAudioVariation?.(e.carIndex, e.boostAudio);
        if (runtime.arena.cars?.[e.carIndex]) {
          runtime.arena.cars[e.carIndex]!.visible = true;
        }
      }
      if (Array.isArray(runtime.arena.cars)) {
        for (let c = 0; c < runtime.arena.cars.length; c++) {
          if (!activeSet.has(c) && runtime.arena.cars[c]) {
            runtime.arena.cars[c]!.visible = false;
          }
        }
      }
    }

    if (runtime) {
      runtime.playerCarIndex = this.activePovCarIndex;
      if (runtime.arena) {
        runtime.arena.playerCarIndex = this.activePovCarIndex;
      }
      if (runtime.keyboard) {
        runtime.keyboard.ballControlEnabled = false;
      }
    }

    this.isTakenOverLoadoutApplied = false;

    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: allEntries.length > 1,
      carEntries: allEntries.map((e) => ({
        carIndex: e.carIndex,
        name: e.name,
        username: e.name,
        team: e.team,
        isBot: !e.isSelf,
        isLocalPlayer: e.carIndex === this.activePovCarIndex,
      })),
    });
    hudStore.getState().setMatchState({ localTeam: this.activePovTeam });
  }

  restoreRecordedLoadoutsIfNeeded(runtime: ReplayViewerRosterRuntimePort | null): void {
    if (this.isTakenOverLoadoutApplied && this.resolvedRoster.length > 0) {
      this.applyRecordedLoadoutsToArena(runtime);
    }
  }

  applyUserLoadoutToTakenOverCar(
    runtime: ReplayViewerRosterRuntimePort | null,
    carIndex = this.activePovCarIndex,
  ): void {
    if (!runtime) return;
    const povIdx = Number.isInteger(carIndex) ? carIndex : 0;
    const povEntry = this.resolvedRoster.find((e) => e.carIndex === povIdx) || null;
    const povTeam = povEntry
      ? povEntry.team === 1
        ? 1
        : 0
      : this.activePovTeam === 1
        ? 1
        : 0;
    this.activePovTeam = povTeam;

    const appState = useAppStore.getState?.() || null;
    const userVisualId = normalizeVisualId(
      appState?.activeCar || runtime.selectedPreset || 'fennec'
    );
    const userHitboxId = resolveVehicleHitboxId(userVisualId);

    const usedTeammateColorSlots = new Set<number>();
    for (const e of this.resolvedRoster) {
      if (e.carIndex !== povIdx && e.team === povTeam && typeof e.colorSlot === 'number') {
        usedTeammateColorSlots.add(e.colorSlot);
      }
    }
    const userColor = resolveBotFallbackColorForTeam(povTeam, usedTeammateColorSlots);
    const matCfg = getMaterialsConfig();
    const paintFinish = matCfg?.paintFinish || 'metallic';
    const boostVisual = matCfg?.boostVisual || 'cartoon';
    const boostAudio = matCfg?.boostAudio || 'standard';
    const userAnthemId = useSpatialAudioStore.getState?.()?.selectedAnthem || 'random';

    runtime.physics?.setCarTeam?.(povIdx, povTeam);
    runtime.physics?.setCarHitbox?.(povIdx, userHitboxId);

    if (runtime.arena) {
      runtime.arena.ensureCar?.(povIdx, povTeam, userVisualId);
      runtime.arena.setCarTeam?.(povIdx, povTeam);
      runtime.arena.setCarColor?.(povIdx, userColor.colorHex);
      runtime.arena.setCarLoadout?.(povIdx, {
        name: povEntry?.name || 'Player',
        colorHex: userColor.colorHex,
        paintFinish,
        boostVisual,
        boostAudio,
      });
      if (runtime.arena.cars?.[povIdx]) {
        runtime.flipResetVisual?.dispose?.();
        try {
          runtime.getFlipResetVisual?.(povIdx);
        } catch {
          // Ignore visual re-init failure
        }
      }
    }

    const audio = runtime.options?.gameAudio || gameAudio;
    audio?.setCarBoostAudioVariation?.(povIdx, boostAudio);

    this.isTakenOverLoadoutApplied = true;
    this.activeTakenOverAnthemId = userAnthemId;

    if (this.resolvedRoster.length > 0) {
      setNameTagRuntimeState({
        isMultiplayerOrMultiCarMode: this.resolvedRoster.length > 1,
        carEntries: this.resolvedRoster.map((e) => ({
          carIndex: e.carIndex,
          name: e.name,
          username: e.name,
          team: e.carIndex === povIdx ? povTeam : e.team,
          isBot: e.carIndex === povIdx ? false : !e.isSelf,
          isLocalPlayer: e.carIndex === povIdx,
        })),
      });
    }
    hudStore.getState().setMatchState({ localTeam: povTeam });
  }

  selectPovSlot(
    slotKey: number,
    runtime: ReplayViewerRosterRuntimePort | null,
    freeplayMode: ReplayViewerRosterModePort | null,
    wasIntervening: boolean
  ): { activePovCarIndex: number; activePovSlotKey: number; activePovTeam: number } | null {
    const key = Number(slotKey);
    const entry =
      this.resolvedRoster.find((e) => e.slotKey === key) ||
      (typeof this.slotKeyToCarIndex?.[key] === 'number'
        ? this.resolvedRoster.find((e) => e.carIndex === this.slotKeyToCarIndex[key])
        : null);
    if (!entry) return null;

    if (wasIntervening && this.isTakenOverLoadoutApplied) {
      this.applyRecordedLoadoutsToArena(runtime);
    }

    this.activePovCarIndex = entry.carIndex;
    this.activePovSlotKey = entry.slotKey;
    this.activePovTeam = entry.team === 1 ? 1 : 0;

    if (runtime) {
      runtime.playerCarIndex = entry.carIndex;
      if (runtime.arena) {
        runtime.arena.playerCarIndex = entry.carIndex;
      }
      if (freeplayMode?.directorPreview?.isReplayActive || freeplayMode?.isGoalReplayActive?.()) {
        if (freeplayMode.directorPreview) {
          freeplayMode.directorPreview.goalScorerCarIndex = entry.carIndex;
        }
        freeplayMode.setReplayCameraMode?.('pov');
        runtime.releaseGoalReplayCameraOverride?.();
        hudStore.getState().setReplayState({ replayCameraMode: 'pov' });
      }
      runtime.camera?.resetView?.();
    }

    if (wasIntervening) {
      this.applyUserLoadoutToTakenOverCar(runtime, this.activePovCarIndex);
    } else if (this.resolvedRoster.length > 0) {
      setNameTagRuntimeState({
        isMultiplayerOrMultiCarMode: this.resolvedRoster.length > 1,
        carEntries: this.resolvedRoster.map((e) => ({
          carIndex: e.carIndex,
          name: e.name,
          username: e.name,
          team: e.team,
          isBot: !e.isSelf,
          isLocalPlayer: e.carIndex === this.activePovCarIndex,
        })),
      });
      hudStore.getState().setMatchState({ localTeam: this.activePovTeam });
    }

    return {
      activePovCarIndex: this.activePovCarIndex,
      activePovSlotKey: this.activePovSlotKey,
      activePovTeam: this.activePovTeam,
    };
  }
}
