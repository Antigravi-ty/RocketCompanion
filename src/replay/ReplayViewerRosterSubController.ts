/**
 * ReplayViewerRosterSubController.ts
 * Pure replay roster extraction pipeline and stateful POV / loadout SubController
 * for StandaloneReplayViewerController.
 */

import {
  SIM_OFFSETS,
  MAX_CARS,
  MATCH_SIGNALS,
} from '../physics/RocketSimConstants.ts';
import { assignTeamSlotKeys } from './container/RCReplayTimelineParser.ts';
import {
  unpackLoadoutSignalParam2,
  getCarColorSlotById,
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

export interface ReplayRosterEntry {
  carIndex: number;
  team: number;
  name: string | null;
  botType: string | null;
  isSelf: boolean;
  visualId: string;
  hitboxId: string;
  colorSlot: number;
  colorHex: string;
  paintFinish: string;
  boostVisual: string;
  boostAudio: string;
  anthemId: string;
  slotKey: number;
}

export interface ReplayRosterMetaItem {
  carIndex?: number; entityId?: number; team?: number | string;
  visualId?: string; hitboxId?: string; colorSlot?: number; colorHex?: string;
  paintFinish?: string; boostVisual?: string; boostAudio?: string; anthemId?: string;
  isPlayer?: boolean; isSelf?: boolean; isLocal?: boolean; isLocalPlayer?: boolean;
  name?: string | null; username?: string | null; botType?: string | null;
  [key: string]: unknown;
}

export interface ReplayRosterSignalItem {
  signalType?: number; param1?: number; param2?: number; [key: string]: unknown;
}

export interface ReplayRosterMetadataLike {
  roster?: ReplayRosterMetaItem[]; loadouts?: ReplayRosterMetaItem[]; [key: string]: unknown;
}

export interface ReplayRosterExtractionInput {
  firstFrame?: Float32Array | null;
  metadata?: ReplayRosterMetadataLike | null;
  recordedSignals?: ReplayRosterSignalItem[] | null;
}

export interface ReplayRosterResolutionResult {
  resolvedRoster: ReplayRosterEntry[];
  localTeam: number;
  slotKeyToCarIndex: Record<number, number>;
  activePovCarIndex: number;
  activePovSlotKey: number;
  activePovTeam: number;
}

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

export function extractActiveCarIndicesFromReplayFrame(
  input: ReplayRosterExtractionInput
): number[] {
  const { firstFrame, metadata, recordedSignals } = input;
  const indices = new Set<number>();

  if (Array.isArray(metadata?.roster)) {
    for (const r of metadata.roster) {
      const cIdx = typeof r?.carIndex === 'number' ? r.carIndex : r?.entityId;
      if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < MAX_CARS) {
        indices.add(cIdx);
      }
    }
  }

  if (Array.isArray(recordedSignals)) {
    for (const ev of recordedSignals) {
      if (
        ev.signalType === MATCH_SIGNALS.PLAYER_JOINED ||
        ev.signalType === MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED
      ) {
        const cIdx = Number(ev.param1);
        if (Number.isInteger(cIdx) && cIdx >= 0 && cIdx < MAX_CARS) {
          indices.add(cIdx);
        }
      }
    }
  }

  if (firstFrame) {
    for (let c = 0; c < MAX_CARS; c++) {
      const base = SIM_OFFSETS.CARS + c * 40;
      const fwdLen = Math.hypot(
        firstFrame[base + 3] || 0,
        firstFrame[base + 4] || 0,
        firstFrame[base + 5] || 0
      );
      if (fwdLen > 0.5) {
        indices.add(c);
      }
    }
    const rawNum = Math.max(
      1,
      Math.min(MAX_CARS, Math.round(firstFrame[SIM_OFFSETS.NUM_CARS] || 1))
    );
    if (indices.size < rawNum) {
      for (let c = 0; c < rawNum && indices.size < rawNum; c++) {
        indices.add(c);
      }
    }
  }

  if (indices.size === 0) {
    indices.add(0);
  }
  return Array.from(indices).sort((a, b) => a - b);
}

export function resolveReplayRosterData(
  input: ReplayRosterExtractionInput
): ReplayRosterResolutionResult {
  const { firstFrame, metadata, recordedSignals } = input;
  const activeCarIndices = extractActiveCarIndicesFromReplayFrame(input);

  const rosterByCar = new Map<number, ReplayRosterMetaItem>();
  const rawRoster = Array.isArray(metadata?.roster)
    ? metadata.roster
    : Array.isArray(metadata?.loadouts)
      ? metadata.loadouts
      : [];

  for (const item of rawRoster) {
    if (!item || typeof item !== 'object') continue;
    const cIdx =
      typeof item.carIndex === 'number'
        ? item.carIndex
        : typeof item.entityId === 'number'
          ? item.entityId
          : -1;
    if (cIdx >= 0 && cIdx < MAX_CARS) {
      rosterByCar.set(cIdx, item);
    }
  }

  const joinedTeamByCar = new Map<number, number>();
  const signalLoadoutByCar = new Map<number, ReturnType<typeof unpackLoadoutSignalParam2>>();
  if (Array.isArray(recordedSignals)) {
    for (const ev of recordedSignals) {
      const cIdx = Number(ev.param1);
      if (!Number.isInteger(cIdx) || cIdx < 0 || cIdx >= MAX_CARS) continue;
      if (ev.signalType === MATCH_SIGNALS.PLAYER_JOINED) {
        joinedTeamByCar.set(cIdx, (Number(ev.param2) & 0xff) === 1 ? 1 : 0);
      } else if (ev.signalType === MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED) {
        signalLoadoutByCar.set(cIdx, unpackLoadoutSignalParam2(ev.param2 ?? 0));
      }
    }
  }

  const blueEntries: ReplayRosterEntry[] = [];
  const orangeEntries: ReplayRosterEntry[] = [];
  let detectedLocalTeam: number | null = null;

  for (const carIndex of activeCarIndices) {
    const metaItem = rosterByCar.get(carIndex) || null;
    const sigLoadout = signalLoadoutByCar.get(carIndex) || null;
    const base = SIM_OFFSETS.CARS + carIndex * 40;
    const initY = firstFrame ? firstFrame[base + 1] || 0 : 0;

    let team = 0;
    if (metaItem && (metaItem.team === 1 || metaItem.team === 'orange')) {
      team = 1;
    } else if (metaItem && (metaItem.team === 0 || metaItem.team === 'blue')) {
      team = 0;
    } else if (joinedTeamByCar.has(carIndex)) {
      team = joinedTeamByCar.get(carIndex) ?? 0;
    } else if (Math.abs(initY) > 50) {
      team = initY > 0 ? 1 : 0;
    } else {
      team = carIndex % 2;
    }

    const visualId = normalizeVisualId(metaItem?.visualId || sigLoadout?.visualId || 'fennec');
    const hitboxId =
      metaItem?.hitboxId || sigLoadout?.hitboxId || resolveVehicleHitboxId(visualId);
    const defaultColorSlot = team === 0 ? 3 : 0;
    const colorSlot =
      typeof metaItem?.colorSlot === 'number'
        ? metaItem.colorSlot
        : typeof sigLoadout?.colorSlot === 'number'
          ? sigLoadout.colorSlot
          : defaultColorSlot;
    const swatch = getCarColorSlotById(colorSlot);
    const colorHex = metaItem?.colorHex || swatch.hex;
    const paintFinish = metaItem?.paintFinish || sigLoadout?.paintFinish || 'metallic';
    const boostVisual = metaItem?.boostVisual || sigLoadout?.boostVisual || 'gold-rush';
    const boostAudio = metaItem?.boostAudio || sigLoadout?.boostAudio || 'rush';
    const anthemId = metaItem?.anthemId || 'none';
    const isSelf = Boolean(
      metaItem?.isPlayer || metaItem?.isSelf || metaItem?.isLocal || metaItem?.isLocalPlayer
    );
    if (isSelf && detectedLocalTeam === null) {
      detectedLocalTeam = team;
    }

    const entry: ReplayRosterEntry = {
      carIndex,
      team,
      name: metaItem?.name || metaItem?.username || null,
      botType: metaItem?.botType || null,
      isSelf,
      visualId,
      hitboxId,
      colorSlot,
      colorHex,
      paintFinish,
      boostVisual,
      boostAudio,
      anthemId,
      slotKey: 1,
    };

    if (team === 1) {
      orangeEntries.push(entry);
    } else {
      blueEntries.push(entry);
    }
  }

  const localTeam = detectedLocalTeam === 1 ? 1 : 0;
  const leftEntries = localTeam === 1 ? orangeEntries : blueEntries;
  const rightEntries = localTeam === 1 ? blueEntries : orangeEntries;
  const { leftSlotKeys, rightSlotKeys, slotKeyToCarIndex } = assignTeamSlotKeys(
    leftEntries,
    rightEntries
  );

  const allEntries = [...leftEntries, ...rightEntries];
  const botCounts: Record<string, number> = {};
  for (const e of allEntries) {
    if (e.botType) {
      const k = String(e.botType).toLowerCase();
      botCounts[k] = (botCounts[k] || 0) + 1;
    }
  }

  leftEntries.forEach((e, idx) => {
    e.slotKey = leftSlotKeys[idx] ?? idx + 1;
    if (!e.name) {
      if (e.botType) {
        const bt = String(e.botType);
        const cap = bt.charAt(0).toUpperCase() + bt.slice(1).toLowerCase();
        e.name = (botCounts[bt.toLowerCase()] || 0) > 1 ? `${cap} #${e.slotKey}` : cap;
      } else {
        e.name =
          allEntries.length === 1
            ? 'Player'
            : `${e.team === 1 ? 'Orange' : 'Blue'} #${e.slotKey}`;
      }
    }
  });

  rightEntries.forEach((e, idx) => {
    e.slotKey = rightSlotKeys[idx] ?? idx + 4;
    if (!e.name) {
      if (e.botType) {
        const bt = String(e.botType);
        const cap = bt.charAt(0).toUpperCase() + bt.slice(1).toLowerCase();
        e.name = (botCounts[bt.toLowerCase()] || 0) > 1 ? `${cap} #${e.slotKey}` : cap;
      } else {
        e.name = `${e.team === 1 ? 'Orange' : 'Blue'} #${e.slotKey}`;
      }
    }
  });

  const selfEntry = allEntries.find((e) => e.isSelf) || allEntries[0] || null;
  const activePovCarIndex = selfEntry ? selfEntry.carIndex : 0;
  const activePovSlotKey = selfEntry ? selfEntry.slotKey : 1;
  const activePovTeam = selfEntry?.team === 1 ? 1 : 0;

  return {
    resolvedRoster: allEntries,
    localTeam,
    slotKeyToCarIndex: slotKeyToCarIndex as Record<number, number>,
    activePovCarIndex,
    activePovSlotKey,
    activePovTeam,
  };
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
