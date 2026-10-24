import { create } from 'zustand';
import {
  INITIAL_SOLO_RESULTS,
  PRECOMPUTED_MATRIX_RESULTS,
} from '../config/kickoffDuelConfig.js';

export type KickoffDuelModelId = 'ko_v2' | 'ko_v1' | 'nexto' | 'necto';
export type KickoffDuelChannelMode = 'keyboard_coupled' | 'ground_air_separated';

export interface KickoffDuelSoloResult {
  modelId: KickoffDuelModelId;
  shortName: string;
  hasOpponentObs: boolean;
  slotTicks: number[];
  avgTicks: number;
  avgSec: number;
}

export interface KickoffDuelSlotResult {
  slotIndex: number;
  slotCode: string;
  touchTick: number;
  touchSec: number;
  winner: 'BLUE' | 'ORANGE' | 'TIE' | 'NONE';
  blueDist: number;
  orangeDist: number;
  endBallX: number;
  endBallY: number;
  endBallVy: number;
  outcome: string;
}

export interface KickoffDuelPairResult {
  pairId: string;
  label: string;
  category: 'cross' | 'self';
  blue: KickoffDuelModelId;
  orange: KickoffDuelModelId;
  blueWins: number;
  orangeWins: number;
  ties: number;
  slots: KickoffDuelSlotResult[];
}

export interface KickoffDuelActionStepTrace {
  tick: number;
  timeSec: number;
  onGround: boolean;
  hasFlip: boolean;
  isFlipping: boolean;
  boostAmount: number;
  carPos: [number, number, number];
  carVel: [number, number, number];
  carSpeed: number;
  distToBall: number;
  discreteAct?: number[];
  keysLabel: string;
  controls: { throttle: number; steer: number; pitch: number; yaw: number; roll: number; jump: boolean; boost: boolean; handbrake: boolean };
  prevAct0: number;
}

export type DevTestLabTab = 'probes' | 'dual-world' | 'state-replay' | 'incident-match' | 'goal-replay' | 'kickoff-duel';
export type IncidentOpponentMode = 'stationary' | 'nexto';
export type IncidentControlledCar = 0 | 1;
export type IncidentSpeedMultiplier = 100 | 200 | 300 | 400 | 500;
export type ReplayFlowPreset = '100' | '50' | '25' | '75' | 'custom';
export type StateReplayRecorderState = 'idle' | 'recording' | 'stopped' | 'rewinding' | 'forwarding' | 'paused-scrub' | 'preroll-countdown';
export type RewinderRecorderState = StateReplayRecorderState;
export type RewinderFlowPreset = ReplayFlowPreset;
export type RewinderDownCounterSec = 0 | 1 | 2 | 3;
export type RewinderDownCounterOption = RewinderDownCounterSec;

export function resolveRewinderRateFromPreset(preset: ReplayFlowPreset, customPct: number): number {
  if (preset === '100' || preset === '75' || preset === '50' || preset === '25') return Number(preset);
  return Math.max(5, Math.min(200, Math.round(customPct)));
}

export interface DevTestLabState {
  activeTab: DevTestLabTab;
  selectedTab: DevTestLabTab;

  // Bench 1: Predictive & Non-Predictive Probes
  probesEnabled: boolean;
  probeOffsetX: number;
  probeOffsetY: number;
  probeOffsetZ: number;
  probeBaseAltitudeZ: number;
  probePeakAltitudeZ: number;
  probeHoldTolerance: number;
  probeHoldDurationTicks: number;
  probeBoostZ: number;
  probeBoostVz: number;
  probeBoostPhase: string;
  probeBoostHoldTicks: number;
  probeRollDir: number;
  probeCameraTarget: 'player' | 'boost_probe' | 'qe_probe';

  // Bench 2: Dual/Multi-World Same-Map Ghost Sandbox
  dualWorldEnabled: boolean;
  activeWorldIndex: number;
  ghostWorldCount: 2 | 3 | 4;
  ghostCarsPerWorld: number;
  ghostOpacity: number;
  syncOtherWorldBall: boolean;

  // Bench 3: State Replay Scrubbing & Recording Sandbox (O / P / [ / ])
  rewinderState: RewinderRecorderState;
  rewinderRecordedFrames: number;
  rewinderCursorFrame: number;
  rewinderTargetFrame: number;
  rewinderDownCounterSec: RewinderDownCounterSec;
  rewinderPrerollRemainingSec: number;
  rewinderMaxCapacityFrames: number;
  rewinderFlowPreset: RewinderFlowPreset;
  rewinderCustomFlowPct: number;
  rewinderEffectiveFlowPct: number;

  // Bench 4: 90s Incident & Overtime Match Sandbox
  incidentMatchActive: boolean;
  incidentOpponentMode: IncidentOpponentMode;
  incidentControlledCar: IncidentControlledCar;
  incidentSpeedMultiplier: IncidentSpeedMultiplier;
  incidentMatchDurationSec: number;
  incidentDisableGoalReplay: boolean;
  incidentKickoffTimeoutSec: number;
  incidentKickoffCountdownSec: number;
  incidentClockStarted: boolean;
  incidentTicksSinceKickoff: number;
  incidentPhase: string;
  incidentBlueScore: number;
  incidentOrangeScore: number;
  incidentRemainingSec: number;
  incidentOvertime: boolean;
  incidentPossessionTeam: number;
  incidentPossessionBluePts: number;
  incidentPossessionOrangePts: number;

  // Bench 5: Goal Incident Event & Goal Replay Test + Podium Celebration Test
  goalReplayLookbackSec: number;
  goalReplayPostGoalSec: number;
  goalReplayPhase: 'live' | 'post-goal-delay' | 'replaying' | 'podium';
  goalReplayCurrentFrameId: number;
  goalReplayLastKickoffFrameId: number;
  goalReplayIncidentFrameId: number;
  goalReplayRequestedStartFrameId: number;
  goalReplayEffectiveStartFrameId: number;
  goalReplayEffectiveEndFrameId: number;
  goalReplayClampedByKickoff: boolean;
  goalReplayPlaybackCursor: number;
  goalReplayPlaybackTotal: number;
  goalReplayPaused: boolean;
  goalReplaySpeed: number;
  goalReplayRecordedBufferCount: number;
  podiumActive: boolean;
  podiumWinningTeam: 0 | 1 | 2;

  // Bench 6: 4-Model Kickoff Duel Lab + Action & Channel Diagnostics
  kickoffDuelBlueModel: KickoffDuelModelId;
  kickoffDuelOrangeModel: KickoffDuelModelId;
  kickoffDuelSlotIndex: number; // 0: DR, 1: DL, 2: BR, 3: BL, 4: CT
  kickoffDuelCutoffDelaySec: number; // 0.0 | 0.5
  kickoffDuelAutoCycle: boolean;
  kickoffDuelAutoCycleAllPairs: boolean;
  kickoffDuelSpeedMultiplier: IncidentSpeedMultiplier;
  kickoffDuelKoV2UseOpponentObs: boolean;
  kickoffDuelNextoScripted: boolean;
  kickoffDuelChannelMode: KickoffDuelChannelMode;
  kickoffDuelPhase: string;
  kickoffDuelCurrentTick: number;
  kickoffDuelTouchTick: number;
  kickoffDuelTouchWinner: 'BLUE' | 'ORANGE' | 'TIE' | 'NONE';
  kickoffDuelInputsCutOff: boolean;
  kickoffDuelBlueDist: number;
  kickoffDuelOrangeDist: number;
  kickoffDuelBallPos: [number, number, number];
  kickoffDuelBallVel: [number, number, number];
  kickoffDuelBallSpeed: number;
  kickoffDuelBallOutcome: string;
  kickoffDuelBenchmarkRunning: boolean;
  kickoffDuelSoloResults: KickoffDuelSoloResult[];
  kickoffDuelMatrixResults: KickoffDuelPairResult[];
  kickoffDuelLiveBlueSteps: KickoffDuelActionStepTrace[];
  kickoffDuelLiveOrangeSteps: KickoffDuelActionStepTrace[];
  kickoffDuelDiagnosticRunning: boolean;
  kickoffDuelDiagnosticSummary: string;

  // Actions
  setSelectedTab: (tab: DevTestLabTab) => void;
  applyAndRestartLab: (tab?: DevTestLabTab) => void;
  setActiveTab: (tab: DevTestLabTab) => void;
  setProbesEnabled: (enabled: boolean) => void;
  setProbeOffsets: (offsetX: number, offsetY: number, offsetZ: number) => void;
  setProbeOffsetX: (offsetX: number) => void;
  setProbeOffsetY: (offsetY: number) => void;
  setProbeOffsetZ: (offsetZ: number) => void;
  setProbeAltitudes: (baseZ: number, peakZ: number) => void;
  setProbeBaseAltitudeZ: (baseZ: number) => void;
  setProbePeakAltitudeZ: (peakZ: number) => void;
  resetProbeParameters: () => void;
  setProbeCameraTarget: (target: 'player' | 'boost_probe' | 'qe_probe') => void;
  setDualWorldEnabled: (enabled: boolean) => void;
  switchActiveWorld: () => void;
  setActiveWorldIndex: (idx: number) => void;
  setGhostWorldCount: (count: 2 | 3 | 4) => void;
  setGhostCarsPerWorld: (carsCount: number) => void;
  setGhostOpacity: (opacity: number) => void;
  setRewinderFlowPreset: (preset: RewinderFlowPreset) => void;
  setRewinderCustomFlowPct: (pct: number) => void;
  setRewinderDownCounterSec: (sec: RewinderDownCounterSec) => void;
  setIncidentOpponentMode: (mode: IncidentOpponentMode) => void;
  setIncidentControlledCar: (carIdx: IncidentControlledCar) => void;
  switchIncidentControlledCar: () => void;
  setIncidentSpeedMultiplier: (mult: IncidentSpeedMultiplier) => void;
  setIncidentDisableGoalReplay: (disable: boolean) => void;
  setGoalReplayLookbackSec: (sec: number) => void;
  setGoalReplayPostGoalSec: (sec: number) => void;
  setKickoffDuelModels: (blue: KickoffDuelModelId, orange: KickoffDuelModelId) => void;
  setKickoffDuelSlotIndex: (slotIndex: number) => void;
  setKickoffDuelCutoffDelaySec: (sec: number) => void;
  setKickoffDuelAutoCycle: (enabled: boolean) => void;
  setKickoffDuelAutoCycleAllPairs: (enabled: boolean) => void;
  setKickoffDuelSpeedMultiplier: (mult: IncidentSpeedMultiplier) => void;
  setKickoffDuelKoV2UseOpponentObs: (enabled: boolean) => void;
  setKickoffDuelNextoScripted: (enabled: boolean) => void;
  setKickoffDuelChannelMode: (mode: KickoffDuelChannelMode) => void;
  restartKickoffDuel: () => void;
  runKickoffDuelBenchmark: () => void;
  exportKickoffDuelDiagnostics: (format: 'json' | 'csv', scope: 'live' | 'all_models_all_slots') => void;
  updateLiveTelemetry: (patch: Partial<DevTestLabState>) => void;

  // Runtime handlers
  runtimeHandlers: {
    onTabChange?: (tab: DevTestLabTab) => void;
    onProbesConfigChange?: () => void;
    onProbeCameraChange?: (target: 'player' | 'boost_probe' | 'qe_probe') => void;
    onDualWorldConfigChange?: () => void;
    onSwitchWorld?: (idx: number) => void;
    onRewinderStartRecording?: () => void;
    onRewinderStopRecording?: () => void;
    onRewinderPushBackwardStart?: () => void;
    onRewinderPushBackwardStop?: () => void;
    onRewinderPushForwardStart?: () => void;
    onRewinderPushForwardStop?: () => void;
    onRewinderResumeFromHere?: () => void;
    onRewinderClearBuffer?: () => void;
    onRewinderCancelToFreeplay?: () => void;
    onRewinderExportReplay?: () => Promise<boolean | void> | boolean | void;
    onRewinderImportReplay?: (file: File) => Promise<boolean | void> | boolean | void;
    onRewinderSeekFrame?: (frameIndex: number) => void;
    onStartIncidentMatch?: (opponentMode: IncidentOpponentMode) => void;
    onIncidentControlModeChange?: (opponentMode: IncidentOpponentMode) => void;
    onIncidentControlledCarChange?: (carIdx: IncidentControlledCar) => void;
    onIncidentSpeedMultiplierChange?: (mult: IncidentSpeedMultiplier) => void;
    onTriggerIncidentAction?: (
      action: 'score_blue' | 'score_orange' | 'force_overtime' | 'pause_5s' | 'add_possession_blue' | 'reset_kickoff' | 'podium_blue' | 'podium_orange' | 'podium_draw' | 'exit_podium'
    ) => void;
    onGoalReplayTriggerScenario?: (
      scenario: 'instant_kickoff_goal' | 'normal_play_goal' | 'trigger_goal_now' | 'emit_kickoff_signal' | 'start_replay_now' | 'stop_replay' | 'clear_replay_buffer' | 'export_replay_json'
    ) => void;
    onGoalReplayTogglePause?: () => void;
    onGoalReplayCycleSpeed?: () => void;
    onGoalReplaySeekNormalized?: (progress01: number) => void;
    onEnterPodiumTest?: (winningTeam: 0 | 1 | 2) => void;
    onExitPodiumTest?: () => void;
    onKickoffDuelRestart?: (slotIndex?: number) => void;
    onKickoffDuelSpeedChange?: (mult: IncidentSpeedMultiplier) => void;
    onKickoffDuelRunBenchmark?: () => void;
    onKickoffDuelExportDiagnostics?: (format: 'json' | 'csv', scope: 'live' | 'all_models_all_slots') => void;
  };
  setRuntimeHandlers: (handlers: Partial<DevTestLabState['runtimeHandlers']>) => void;
}

export const useDevTestLabStore = create<DevTestLabState>((set, get) => ({
  activeTab: 'probes',
  selectedTab: 'probes',

  probesEnabled: true,
  probeOffsetX: 0,
  probeOffsetY: 0,
  probeOffsetZ: 0,
  probeBaseAltitudeZ: 500,
  probePeakAltitudeZ: 600,
  probeHoldTolerance: 10,
  probeHoldDurationTicks: 120,
  probeBoostZ: 500,
  probeBoostVz: 0,
  probeBoostPhase: 'CLIMB_TO_PEAK',
  probeBoostHoldTicks: 0,
  probeRollDir: 1,
  probeCameraTarget: 'player',

  dualWorldEnabled: false,
  activeWorldIndex: 0,
  ghostWorldCount: 2,
  ghostCarsPerWorld: 1,
  ghostOpacity: 0.45,
  syncOtherWorldBall: true,

  rewinderState: 'idle',
  rewinderRecordedFrames: 0,
  rewinderCursorFrame: 0,
  rewinderTargetFrame: 0,
  rewinderDownCounterSec: 0,
  rewinderPrerollRemainingSec: 0,
  rewinderMaxCapacityFrames: 18000,
  rewinderFlowPreset: '100',
  rewinderCustomFlowPct: 50,
  rewinderEffectiveFlowPct: 100,

  incidentMatchActive: false,
  incidentOpponentMode: 'stationary',
  incidentControlledCar: 0,
  incidentSpeedMultiplier: 100,
  incidentMatchDurationSec: 90,
  incidentDisableGoalReplay: true,
  incidentKickoffTimeoutSec: 5,
  incidentKickoffCountdownSec: 0,
  incidentClockStarted: false,
  incidentTicksSinceKickoff: 0,
  incidentPhase: 'playing',
  incidentBlueScore: 0,
  incidentOrangeScore: 0,
  incidentRemainingSec: 90,
  incidentOvertime: false,
  incidentPossessionTeam: 0,
  incidentPossessionBluePts: 0,
  incidentPossessionOrangePts: 0,

  goalReplayLookbackSec: 5.0,
  goalReplayPostGoalSec: 3.0,
  goalReplayPhase: 'live',
  goalReplayCurrentFrameId: 0,
  goalReplayLastKickoffFrameId: 0,
  goalReplayIncidentFrameId: 0,
  goalReplayRequestedStartFrameId: 0,
  goalReplayEffectiveStartFrameId: 0,
  goalReplayEffectiveEndFrameId: 0,
  goalReplayClampedByKickoff: false,
  goalReplayPlaybackCursor: 0,
  goalReplayPlaybackTotal: 0,
  goalReplayPaused: false,
  goalReplaySpeed: 1.0,
  goalReplayRecordedBufferCount: 0,
  podiumActive: false,
  podiumWinningTeam: 0,

  kickoffDuelBlueModel: 'ko_v2',
  kickoffDuelOrangeModel: 'ko_v1',
  kickoffDuelSlotIndex: 0,
  kickoffDuelCutoffDelaySec: 0.5,
  kickoffDuelAutoCycle: true,
  kickoffDuelAutoCycleAllPairs: false,
  kickoffDuelSpeedMultiplier: 100,
  kickoffDuelKoV2UseOpponentObs: false,
  kickoffDuelNextoScripted: false,
  kickoffDuelChannelMode: 'keyboard_coupled',
  kickoffDuelPhase: 'approaching',
  kickoffDuelCurrentTick: 0,
  kickoffDuelTouchTick: -1,
  kickoffDuelTouchWinner: 'NONE',
  kickoffDuelInputsCutOff: false,
  kickoffDuelBlueDist: 3200,
  kickoffDuelOrangeDist: 3200,
  kickoffDuelBallPos: [0, 0, 93],
  kickoffDuelBallVel: [0, 0, 0],
  kickoffDuelBallSpeed: 0,
  kickoffDuelBallOutcome: 'Approaching Ball...',
  kickoffDuelBenchmarkRunning: false,
  kickoffDuelSoloResults: INITIAL_SOLO_RESULTS as KickoffDuelSoloResult[],
  kickoffDuelMatrixResults: PRECOMPUTED_MATRIX_RESULTS as KickoffDuelPairResult[],
  kickoffDuelLiveBlueSteps: [],
  kickoffDuelLiveOrangeSteps: [],
  kickoffDuelDiagnosticRunning: false,
  kickoffDuelDiagnosticSummary: '',

  runtimeHandlers: new Proxy({} as DevTestLabState['runtimeHandlers'], {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val;
      }
      if (typeof prop === 'string' && prop.startsWith('on')) {
        return (..._args: unknown[]) => {
          console.warn(
            `[devTestLabStore] Runtime handler "${prop}" was invoked before DeveloperTestLabMode or FreeplayRewinderController registered it.`
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
                  `[devTestLabStore] Runtime handler "${prop}" is not registered in the current mode.`
                );
              };
            }
            return val;
          },
        }),
      };
    }),

  setSelectedTab: (selectedTab) => {
    set({ selectedTab });
  },

  applyAndRestartLab: (targetTab) => {
    const activeTab = targetTab ?? get().selectedTab;
    set({
      activeTab,
      selectedTab: activeTab,
      probesEnabled: activeTab === 'probes',
      dualWorldEnabled: activeTab === 'dual-world',
      activeWorldIndex: 0,
      incidentMatchActive: activeTab === 'incident-match',
      probeCameraTarget: 'player',
      rewinderState: 'idle',
      rewinderRecordedFrames: 0,
      rewinderCursorFrame: 0,
      rewinderTargetFrame: 0,
      rewinderPrerollRemainingSec: 0,
      podiumActive: false,
      goalReplayPhase: 'live',
      goalReplayPaused: false,
    });
    get().runtimeHandlers.onTabChange?.(activeTab);
  },

  setActiveTab: (activeTab) => {
    get().applyAndRestartLab(activeTab);
  },

  setProbesEnabled: (probesEnabled) => {
    set({ probesEnabled });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  setProbeOffsets: (probeOffsetX, probeOffsetY, probeOffsetZ) => {
    set({ probeOffsetX, probeOffsetY, probeOffsetZ });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  setProbeOffsetX: (probeOffsetX) => {
    set({ probeOffsetX });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  setProbeOffsetY: (probeOffsetY) => {
    set({ probeOffsetY });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  setProbeOffsetZ: (probeOffsetZ) => {
    set({ probeOffsetZ });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  setProbeAltitudes: (probeBaseAltitudeZ, probePeakAltitudeZ) => {
    set({ probeBaseAltitudeZ, probePeakAltitudeZ });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  setProbeBaseAltitudeZ: (probeBaseAltitudeZ) => {
    set({ probeBaseAltitudeZ });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  setProbePeakAltitudeZ: (probePeakAltitudeZ) => {
    set({ probePeakAltitudeZ });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  resetProbeParameters: () => {
    set({
      probeOffsetX: 0,
      probeOffsetY: 0,
      probeOffsetZ: 0,
      probeBaseAltitudeZ: 500,
      probePeakAltitudeZ: 600,
    });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbesConfigChange?.();
    }
  },
  setProbeCameraTarget: (probeCameraTarget) => {
    set({ probeCameraTarget });
    if (get().activeTab === 'probes') {
      get().runtimeHandlers.onProbeCameraChange?.(probeCameraTarget);
    }
  },

  setDualWorldEnabled: (dualWorldEnabled) => {
    set({ dualWorldEnabled });
    if (get().activeTab === 'dual-world') {
      get().runtimeHandlers.onDualWorldConfigChange?.();
    }
  },
  switchActiveWorld: () => {
    const count = get().ghostWorldCount || 2;
    const next = (get().activeWorldIndex + 1) % count;
    set({ activeWorldIndex: next });
    get().runtimeHandlers.onSwitchWorld?.(next);
  },
  setActiveWorldIndex: (activeWorldIndex) => {
    set({ activeWorldIndex });
    get().runtimeHandlers.onSwitchWorld?.(activeWorldIndex);
  },
  setGhostWorldCount: (ghostWorldCount) => {
    const clampedCount = (ghostWorldCount === 3 || ghostWorldCount === 4) ? ghostWorldCount : 2;
    const nextActive = get().activeWorldIndex >= clampedCount ? 0 : get().activeWorldIndex;
    set({ ghostWorldCount: clampedCount, activeWorldIndex: nextActive });
    if (get().activeTab === 'dual-world') {
      get().runtimeHandlers.onDualWorldConfigChange?.();
    }
  },
  setGhostCarsPerWorld: (carsCount) => {
    const clampedCars = Math.max(1, Math.min(8, Math.round(carsCount)));
    set({ ghostCarsPerWorld: clampedCars });
    if (get().activeTab === 'dual-world') {
      get().runtimeHandlers.onDualWorldConfigChange?.();
    }
  },
  setGhostOpacity: (ghostOpacity) => {
    const clamped = Math.max(0.1, Math.min(0.95, Number(ghostOpacity.toFixed(2))));
    set({ ghostOpacity: clamped });
    if (get().activeTab === 'dual-world') {
      get().runtimeHandlers.onDualWorldConfigChange?.();
    }
  },

  setRewinderFlowPreset: (rewinderFlowPreset) => {
    const eff = resolveRewinderRateFromPreset(rewinderFlowPreset, get().rewinderCustomFlowPct);
    set({ rewinderFlowPreset, rewinderEffectiveFlowPct: eff });
  },
  setRewinderCustomFlowPct: (pct) => {
    const clamped = Math.max(5, Math.min(200, Math.round(pct)));
    const eff = get().rewinderFlowPreset === 'custom' ? clamped : get().rewinderEffectiveFlowPct;
    set({ rewinderCustomFlowPct: clamped, rewinderEffectiveFlowPct: eff });
  },
  setRewinderDownCounterSec: (rewinderDownCounterSec) => {
    const clamped: RewinderDownCounterSec =
      rewinderDownCounterSec === 0 ? 0 : rewinderDownCounterSec === 1 ? 1 : rewinderDownCounterSec === 2 ? 2 : 3;
    set({ rewinderDownCounterSec: clamped });
  },

  setIncidentOpponentMode: (incidentOpponentMode) => {
    set({ incidentOpponentMode });
    if (get().activeTab === 'incident-match') {
      const h = get().runtimeHandlers;
      if (h.onIncidentControlModeChange) {
        h.onIncidentControlModeChange(incidentOpponentMode);
      } else {
        h.onStartIncidentMatch?.(incidentOpponentMode);
      }
    }
  },
  setIncidentControlledCar: (incidentControlledCar) => {
    set({ incidentControlledCar });
    if (get().activeTab === 'incident-match') {
      get().runtimeHandlers.onIncidentControlledCarChange?.(incidentControlledCar);
    }
  },
  switchIncidentControlledCar: () => {
    const next: IncidentControlledCar = get().incidentControlledCar === 0 ? 1 : 0;
    set({ incidentControlledCar: next });
    if (get().activeTab === 'incident-match') {
      get().runtimeHandlers.onIncidentControlledCarChange?.(next);
    }
  },
  setIncidentSpeedMultiplier: (incidentSpeedMultiplier) => {
    set({ incidentSpeedMultiplier });
    if (get().activeTab === 'incident-match') {
      get().runtimeHandlers.onIncidentSpeedMultiplierChange?.(incidentSpeedMultiplier);
    }
  },
  setIncidentDisableGoalReplay: (incidentDisableGoalReplay) => {
    set({ incidentDisableGoalReplay });
  },

  setGoalReplayLookbackSec: (goalReplayLookbackSec) => {
    set({ goalReplayLookbackSec });
  },
  setGoalReplayPostGoalSec: (goalReplayPostGoalSec) => {
    set({ goalReplayPostGoalSec });
  },

  setKickoffDuelModels: (kickoffDuelBlueModel, kickoffDuelOrangeModel) => {
    set({ kickoffDuelBlueModel, kickoffDuelOrangeModel });
    if (get().activeTab === 'kickoff-duel') {
      get().runtimeHandlers.onKickoffDuelRestart?.(get().kickoffDuelSlotIndex);
    }
  },
  setKickoffDuelSlotIndex: (slotIndex) => {
    const clamped = ((slotIndex % 5) + 5) % 5;
    set({ kickoffDuelSlotIndex: clamped });
    if (get().activeTab === 'kickoff-duel') {
      get().runtimeHandlers.onKickoffDuelRestart?.(clamped);
    }
  },
  setKickoffDuelCutoffDelaySec: (kickoffDuelCutoffDelaySec) => {
    set({ kickoffDuelCutoffDelaySec });
  },
  setKickoffDuelAutoCycle: (kickoffDuelAutoCycle) => {
    set({ kickoffDuelAutoCycle });
  },
  setKickoffDuelAutoCycleAllPairs: (kickoffDuelAutoCycleAllPairs) => {
    set({ kickoffDuelAutoCycleAllPairs });
  },
  setKickoffDuelSpeedMultiplier: (kickoffDuelSpeedMultiplier) => {
    set({ kickoffDuelSpeedMultiplier });
    if (get().activeTab === 'kickoff-duel') {
      get().runtimeHandlers.onKickoffDuelSpeedChange?.(kickoffDuelSpeedMultiplier);
    }
  },
  setKickoffDuelKoV2UseOpponentObs: (kickoffDuelKoV2UseOpponentObs) => {
    set({ kickoffDuelKoV2UseOpponentObs });
    if (get().activeTab === 'kickoff-duel') {
      get().runtimeHandlers.onKickoffDuelRestart?.(get().kickoffDuelSlotIndex);
    }
  },
  setKickoffDuelNextoScripted: (kickoffDuelNextoScripted) => {
    set({ kickoffDuelNextoScripted });
    if (get().activeTab === 'kickoff-duel') {
      get().runtimeHandlers.onKickoffDuelRestart?.(get().kickoffDuelSlotIndex);
    }
  },
  setKickoffDuelChannelMode: (kickoffDuelChannelMode) => {
    set({ kickoffDuelChannelMode });
    if (get().activeTab === 'kickoff-duel') {
      get().runtimeHandlers.onKickoffDuelRestart?.(get().kickoffDuelSlotIndex);
    }
  },
  restartKickoffDuel: () => {
    get().runtimeHandlers.onKickoffDuelRestart?.(get().kickoffDuelSlotIndex);
  },
  runKickoffDuelBenchmark: () => {
    get().runtimeHandlers.onKickoffDuelRunBenchmark?.();
  },
  exportKickoffDuelDiagnostics: (format, scope) => {
    get().runtimeHandlers.onKickoffDuelExportDiagnostics?.(format, scope);
  },

  updateLiveTelemetry: (patch) => set((s) => ({ ...s, ...patch })),
}));
