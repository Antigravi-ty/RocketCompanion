import { create } from 'zustand';

export type ExpBotPolicyId = 'nexto' | 'necto' | 'heuristic';
export type ExpPlayerParticipation = 'none' | 'blue' | 'orange';
export type ExpSpeedMultiplier = 100 | 200 | 300 | 400;

export interface ExpColorSwatch {
  id: number;
  name: string;
  hex: string;
  preferredTeam: 0 | 1;
}

/**
 * Standard 6-color swatch palette matching CAR_COLOR_SLOTS in vehicleConstants.js.
 */
export const EXP_CAR_COLOR_PALETTE: readonly ExpColorSwatch[] = Object.freeze([
  { id: 3, name: 'Blue', hex: '#42a5f5', preferredTeam: 0 },
  { id: 1, name: 'Green', hex: '#66bb6a', preferredTeam: 0 },
  { id: 5, name: 'Purple', hex: '#ba68c8', preferredTeam: 0 },
  { id: 0, name: 'Red', hex: '#ff7043', preferredTeam: 1 },
  { id: 2, name: 'Yellow', hex: '#ffc107', preferredTeam: 1 },
  { id: 4, name: 'Pink', hex: '#fd6e9d', preferredTeam: 1 },
]);

export function getExpColorSwatch(colorSlot: number): ExpColorSwatch {
  return (
    EXP_CAR_COLOR_PALETTE.find((s) => s.id === colorSlot) ||
    EXP_CAR_COLOR_PALETTE[0]
  );
}

export interface ExpMultiBotSlotConfig {
  id: string;
  team: 0 | 1;
  isPlayer: boolean;
  botType: ExpBotPolicyId;
  colorSlot: number;
}

export interface ExpSpawnedCarInfo {
  carIndex: number;
  keyNumber: number; // 1..6 shortcut key
  team: 0 | 1;
  teamSlotIndex: number;
  isPlayer: boolean;
  botType: ExpBotPolicyId;
  colorSlot: number;
  colorHex: string;
  colorName: string;
  label: string;
}

const BLUE_DEFAULT_COLORS = [3, 1, 5];
const ORANGE_DEFAULT_COLORS = [0, 2, 4];

function pickUnusedColorSlot(
  blueSlots: ExpMultiBotSlotConfig[],
  orangeSlots: ExpMultiBotSlotConfig[],
  preferredTeam: 0 | 1
): number {
  const used = new Set<number>();
  blueSlots.forEach((s) => used.add(s.colorSlot));
  orangeSlots.forEach((s) => used.add(s.colorSlot));

  const preferredOrder =
    preferredTeam === 0
      ? [...BLUE_DEFAULT_COLORS, ...ORANGE_DEFAULT_COLORS]
      : [...ORANGE_DEFAULT_COLORS, ...BLUE_DEFAULT_COLORS];

  for (const c of preferredOrder) {
    if (!used.has(c)) return c;
  }
  return preferredOrder[0];
}

function normalizeTeamPlayerFlags(
  blueSlots: ExpMultiBotSlotConfig[],
  orangeSlots: ExpMultiBotSlotConfig[],
  participation: ExpPlayerParticipation
): { blueSlots: ExpMultiBotSlotConfig[]; orangeSlots: ExpMultiBotSlotConfig[] } {
  const nextBlue = blueSlots.map((slot, idx) => ({
    ...slot,
    team: 0 as const,
    isPlayer: participation === 'blue' && idx === 0,
  }));
  const nextOrange = orangeSlots.map((slot, idx) => ({
    ...slot,
    team: 1 as const,
    isPlayer: participation === 'orange' && idx === 0,
  }));
  return { blueSlots: nextBlue, orangeSlots: nextOrange };
}

export interface ExpMultiBotsState {
  // Roster & Player Configuration
  playerParticipation: ExpPlayerParticipation; // 'none' (Spectate Bots), 'blue', or 'orange'
  blueSlots: ExpMultiBotSlotConfig[]; // Up to 3 slots on Team Blue (0)
  orangeSlots: ExpMultiBotSlotConfig[]; // Up to 3 slots on Team Orange (1)

  // Camera & Match Settings
  isExhibitionMode: boolean;
  exhibitionTeamSize: 'solo' | 'double' | 'standard';
  exhibitionBotId: ExpBotPolicyId;
  activeCameraCarIndex: number; // 0..5 (switched via keys 1..6 when no player or spectating)
  matchDurationSec: number;
  speedMultiplier: ExpSpeedMultiplier;
  unlimitedBoost: boolean;
  disableGoalReplay: boolean;

  // Live Match & Telemetry State
  matchActive: boolean;
  matchPhase: string;
  kickoffCountdownSec: number;
  blueScore: number;
  orangeScore: number;
  remainingSec: number;
  isOvertime: boolean;
  nextoLoaded: boolean;
  nectoLoaded: boolean;
  lastTotalInferenceMs: number;
  spawnedCars: ExpSpawnedCarInfo[];

  // Actions
  setIsExhibitionMode: (isExhibition: boolean) => void;
  configureExhibitionMatch: (
    botId: ExpBotPolicyId,
    durationSec?: number,
    teamSize?: 'solo' | 'double' | 'standard'
  ) => void;
  setPlayerParticipation: (participation: ExpPlayerParticipation) => void;
  addBotToTeam: (team: 0 | 1, botType?: ExpBotPolicyId) => void;
  removeSlotFromTeam: (team: 0 | 1, slotIndex: number) => void;
  setSlotBotType: (team: 0 | 1, slotIndex: number, botType: ExpBotPolicyId) => void;
  setSlotColor: (team: 0 | 1, slotIndex: number, colorSlot: number) => void;
  applyPresetRoster: (
    preset: '1v1-player' | '2v2-player' | '3v3-player' | '1v1-bots' | '2v2-bots' | '3v3-bots'
  ) => void;
  setMatchDurationSec: (sec: number) => void;
  setActiveCameraCarIndex: (carIndex: number) => void;
  setSpeedMultiplier: (mult: ExpSpeedMultiplier) => void;
  setUnlimitedBoost: (unlimited: boolean) => void;
  setDisableGoalReplay: (disable: boolean) => void;
  startOrApplyMatch: () => void;
  triggerSandboxAction: (
    action: 'reset_kickoff' | 'score_blue' | 'score_orange' | 'force_overtime' | 'end_match'
  ) => void;
  preloadEngines?: () => void;
  updateLiveTelemetry: (patch: Partial<ExpMultiBotsState>) => void;

  // Runtime Bridge Handlers
  runtimeHandlers: {
    onApplyRosterAndStart?: () => void;
    onSelectCameraCar?: (carIndex: number) => void;
    onSpeedMultiplierChange?: (mult: ExpSpeedMultiplier) => void;
    onUnlimitedBoostChange?: (unlimited: boolean) => void;
    onTriggerAction?: (
      action: 'reset_kickoff' | 'score_blue' | 'score_orange' | 'force_overtime' | 'end_match'
    ) => void;
    onHotSwapSlotBotType?: (team: 0 | 1, slotIndex: number, botType: ExpBotPolicyId) => void;
    onHotSwapSlotColor?: (team: 0 | 1, slotIndex: number, colorSlot: number) => void;
    onPreloadEngines?: () => void;
  };
  setRuntimeHandlers: (handlers: Partial<ExpMultiBotsState['runtimeHandlers']>) => void;
}

export const useExpMultiBotsStore = create<ExpMultiBotsState>((set, get) => ({
  playerParticipation: 'blue',
  blueSlots: [
    { id: 'blue-0', team: 0, isPlayer: true, botType: 'necto', colorSlot: 3 },
  ],
  orangeSlots: [
    { id: 'orange-0', team: 1, isPlayer: false, botType: 'necto', colorSlot: 0 },
  ],

  isExhibitionMode: false,
  exhibitionTeamSize: 'solo',
  exhibitionBotId: 'necto',
  activeCameraCarIndex: 0,
  matchDurationSec: 300,
  speedMultiplier: 100,
  unlimitedBoost: false,
  disableGoalReplay: false,

  matchActive: false,
  matchPhase: 'kickoff (3)',
  kickoffCountdownSec: 3,
  blueScore: 0,
  orangeScore: 0,
  remainingSec: 300,
  isOvertime: false,
  nextoLoaded: false,
  nectoLoaded: false,
  lastTotalInferenceMs: 0,
  spawnedCars: [],

  runtimeHandlers: new Proxy({} as ExpMultiBotsState['runtimeHandlers'], {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val;
      }
      if (typeof prop === 'string' && prop.startsWith('on')) {
        return (..._args: unknown[]) => {
          console.warn(
            `[expMultiBotsStore] Runtime handler "${prop}" was invoked before ExperimentalMultiBotMode registered its handlers.`
          );
        };
      }
      return val;
    },
  }),
  setRuntimeHandlers: (handlers) =>
    set((s) => {
      const merged = { ...s.runtimeHandlers, ...handlers };
      return {
        runtimeHandlers: new Proxy(merged, {
          get(target, prop, receiver) {
            const val = Reflect.get(target, prop, receiver);
            if (typeof val === 'function') {
              return val;
            }
            if (typeof prop === 'string' && prop.startsWith('on')) {
              return (..._args: unknown[]) => {
                console.warn(
                  `[expMultiBotsStore] Runtime handler "${prop}" is not registered in the current mode.`
                );
              };
            }
            return val;
          },
        }),
      };
    }),

  setIsExhibitionMode: (isExhibitionMode) => set({ isExhibitionMode }),

  configureExhibitionMatch: (botId, durationSec = 300, teamSize = 'solo') => {
    const resolvedBotId: ExpBotPolicyId = botId === 'nexto' ? 'nexto' : 'necto';
    const resolvedDuration = Math.max(30, Math.min(900, Math.round(Number(durationSec) || 300)));
    const countPerTeam = teamSize === 'standard' ? 3 : teamSize === 'double' ? 2 : 1;

    const blueSlots: ExpMultiBotSlotConfig[] = Array.from({ length: countPerTeam }, (_, i) => ({
      id: `blue-${i}`,
      team: 0 as const,
      isPlayer: i === 0,
      botType: resolvedBotId,
      colorSlot: BLUE_DEFAULT_COLORS[i],
    }));

    const orangeSlots: ExpMultiBotSlotConfig[] = Array.from(
      { length: countPerTeam },
      (_, i) => ({
        id: `orange-${i}`,
        team: 1 as const,
        isPlayer: false,
        botType: resolvedBotId,
        colorSlot: ORANGE_DEFAULT_COLORS[i],
      })
    );

    set({
      isExhibitionMode: true,
      exhibitionTeamSize: teamSize,
      exhibitionBotId: resolvedBotId,
      playerParticipation: 'blue',
      blueSlots,
      orangeSlots,
      activeCameraCarIndex: 0,
      matchDurationSec: resolvedDuration,
      remainingSec: resolvedDuration,
      speedMultiplier: 100,
      unlimitedBoost: false,
      disableGoalReplay: false,
    });
  },

  setPlayerParticipation: (playerParticipation) => {
    const state = get();
    let blue = [...state.blueSlots];
    let orange = [...state.orangeSlots];

    if (playerParticipation === 'blue' && blue.length === 0) {
      blue = [
        {
          id: `blue-${Date.now()}`,
          team: 0,
          isPlayer: true,
          botType: 'nexto',
          colorSlot: pickUnusedColorSlot(blue, orange, 0),
        },
      ];
    } else if (playerParticipation === 'orange' && orange.length === 0) {
      orange = [
        {
          id: `orange-${Date.now()}`,
          team: 1,
          isPlayer: true,
          botType: 'nexto',
          colorSlot: pickUnusedColorSlot(blue, orange, 1),
        },
      ];
    }

    const normalized = normalizeTeamPlayerFlags(blue, orange, playerParticipation);
    const defaultCameraIdx =
      playerParticipation === 'orange' ? normalized.blueSlots.length : 0;

    set({
      playerParticipation,
      blueSlots: normalized.blueSlots,
      orangeSlots: normalized.orangeSlots,
      activeCameraCarIndex: defaultCameraIdx,
    });
  },

  addBotToTeam: (team, botType = 'nexto') => {
    const state = get();
    const targetList = team === 0 ? state.blueSlots : state.orangeSlots;
    if (targetList.length >= 3) return;

    const newColor = pickUnusedColorSlot(state.blueSlots, state.orangeSlots, team);
    const newSlot: ExpMultiBotSlotConfig = {
      id: `${team === 0 ? 'blue' : 'orange'}-${Date.now()}-${targetList.length}`,
      team,
      isPlayer: false,
      botType,
      colorSlot: newColor,
    };

    const nextBlue = team === 0 ? [...state.blueSlots, newSlot] : [...state.blueSlots];
    const nextOrange = team === 1 ? [...state.orangeSlots, newSlot] : [...state.orangeSlots];
    const normalized = normalizeTeamPlayerFlags(
      nextBlue,
      nextOrange,
      state.playerParticipation
    );

    set({
      blueSlots: normalized.blueSlots,
      orangeSlots: normalized.orangeSlots,
    });
  },

  removeSlotFromTeam: (team, slotIndex) => {
    const state = get();
    const targetList = team === 0 ? state.blueSlots : state.orangeSlots;
    const otherList = team === 0 ? state.orangeSlots : state.blueSlots;

    // Keep at least 1 car in the arena
    if (targetList.length + otherList.length <= 1) return;
    if (slotIndex < 0 || slotIndex >= targetList.length) return;

    const removedSlot = targetList[slotIndex];
    let nextParticipation = state.playerParticipation;
    if (removedSlot.isPlayer) {
      nextParticipation = 'none';
    }

    const updatedTarget = targetList.filter((_, idx) => idx !== slotIndex);
    const nextBlue = team === 0 ? updatedTarget : [...state.blueSlots];
    const nextOrange = team === 1 ? updatedTarget : [...state.orangeSlots];
    const normalized = normalizeTeamPlayerFlags(nextBlue, nextOrange, nextParticipation);
    const totalCars = normalized.blueSlots.length + normalized.orangeSlots.length;

    set({
      playerParticipation: nextParticipation,
      blueSlots: normalized.blueSlots,
      orangeSlots: normalized.orangeSlots,
      activeCameraCarIndex: Math.min(state.activeCameraCarIndex, Math.max(0, totalCars - 1)),
    });
  },

  setSlotBotType: (team, slotIndex, botType) => {
    const state = get();
    const updateFn = (list: ExpMultiBotSlotConfig[]) =>
      list.map((slot, idx) => (idx === slotIndex ? { ...slot, botType } : slot));

    if (team === 0) {
      set({ blueSlots: updateFn(state.blueSlots) });
    } else {
      set({ orangeSlots: updateFn(state.orangeSlots) });
    }
    get().runtimeHandlers.onHotSwapSlotBotType?.(team, slotIndex, botType);
  },

  setSlotColor: (team, slotIndex, colorSlot) => {
    const state = get();
    const currentList = team === 0 ? state.blueSlots : state.orangeSlots;
    const prevColor = currentList[slotIndex]?.colorSlot ?? 0;
    if (prevColor === colorSlot) return;

    // Swap color with any other slot currently using colorSlot so all 6 slots remain unique
    const swapIfMatching = (slot: ExpMultiBotSlotConfig) =>
      slot.colorSlot === colorSlot ? { ...slot, colorSlot: prevColor } : slot;

    const nextBlue = state.blueSlots.map((slot, idx) =>
      team === 0 && idx === slotIndex ? { ...slot, colorSlot } : swapIfMatching(slot)
    );
    const nextOrange = state.orangeSlots.map((slot, idx) =>
      team === 1 && idx === slotIndex ? { ...slot, colorSlot } : swapIfMatching(slot)
    );

    set({ blueSlots: nextBlue, orangeSlots: nextOrange });
    get().runtimeHandlers.onHotSwapSlotColor?.(team, slotIndex, colorSlot);
  },

  applyPresetRoster: (preset) => {
    let participation: ExpPlayerParticipation = 'none';
    let countPerTeam = 3;

    if (preset === '1v1-player') {
      participation = 'blue';
      countPerTeam = 1;
    } else if (preset === '2v2-player') {
      participation = 'blue';
      countPerTeam = 2;
    } else if (preset === '3v3-player') {
      participation = 'blue';
      countPerTeam = 3;
    } else if (preset === '1v1-bots') {
      participation = 'none';
      countPerTeam = 1;
    } else if (preset === '2v2-bots') {
      participation = 'none';
      countPerTeam = 2;
    } else {
      participation = 'none';
      countPerTeam = 3;
    }

    const botPattern: ExpBotPolicyId[] = ['nexto', 'necto', 'nexto'];
    const blueSlots: ExpMultiBotSlotConfig[] = Array.from({ length: countPerTeam }, (_, i) => ({
      id: `blue-${i}`,
      team: 0 as const,
      isPlayer: participation === 'blue' && i === 0,
      botType: botPattern[i % botPattern.length],
      colorSlot: BLUE_DEFAULT_COLORS[i],
    }));

    const orangeSlots: ExpMultiBotSlotConfig[] = Array.from(
      { length: countPerTeam },
      (_, i) => ({
        id: `orange-${i}`,
        team: 1 as const,
        isPlayer: false,
        botType: botPattern[i % botPattern.length],
        colorSlot: ORANGE_DEFAULT_COLORS[i],
      })
    );

    set({
      playerParticipation: participation,
      blueSlots,
      orangeSlots,
      activeCameraCarIndex: 0,
    });
  },

  setMatchDurationSec: (sec) => {
    const clamped = Math.max(0, Math.min(900, Math.round(Number(sec) || 0)));
    set({ matchDurationSec: clamped });
  },

  setActiveCameraCarIndex: (carIndex) => {
    const state = get();
    const maxCars = Math.max(1, state.spawnedCars.length || state.blueSlots.length + state.orangeSlots.length);
    const clamped = Math.max(0, Math.min(maxCars - 1, carIndex));
    set({ activeCameraCarIndex: clamped });
    get().runtimeHandlers.onSelectCameraCar?.(clamped);
  },

  setSpeedMultiplier: (speedMultiplier) => {
    set({ speedMultiplier });
    get().runtimeHandlers.onSpeedMultiplierChange?.(speedMultiplier);
  },

  setUnlimitedBoost: (unlimitedBoost) => {
    set({ unlimitedBoost });
    get().runtimeHandlers.onUnlimitedBoostChange?.(unlimitedBoost);
  },

  setDisableGoalReplay: (disableGoalReplay) => {
    set({ disableGoalReplay });
  },

  startOrApplyMatch: () => {
    get().runtimeHandlers.onApplyRosterAndStart?.();
  },

  triggerSandboxAction: (action) => {
    get().runtimeHandlers.onTriggerAction?.(action);
  },

  preloadEngines: () => {
    get().runtimeHandlers.onPreloadEngines?.();
  },

  updateLiveTelemetry: (patch) => set((s) => ({ ...s, ...patch })),
}));
