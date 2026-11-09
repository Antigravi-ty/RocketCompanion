import { BaseGameMode } from './BaseGameMode.ts';
import type { FrameContext } from '../pipeline/FramePipeline.ts';
import type { GhostWorldUpdateOptions } from './MultiWorldGhostRenderer.ts';
import { hudStore, useRewinderStore, useSubsystemIsolationLabStore } from '../runtimeUiPort.ts';
import type {
  IsolationLabTabId,
  LabFrameUpdateContext,
  LabRuntimePort,
  LabTabContext,
  LabTabController,
} from './subsystem-isolation-lab/LabTabTypes.ts';
import { type ProbeCameraTarget, ProbesLabTab } from './subsystem-isolation-lab/ProbesLabTab.ts';
import { resetSinglePlayerLabBaseline } from './subsystem-isolation-lab/probeKinematicsPipeline.ts';
import { MultiGhostLabTab } from './subsystem-isolation-lab/MultiGhostLabTab.ts';
import { StateReplayLabTab } from './subsystem-isolation-lab/StateReplayLabTab.ts';
import {
  type IncidentOpponentMode,
  type IncidentSandboxAction,
  NinetySecMatchLabTab,
} from './subsystem-isolation-lab/NinetySecMatchLabTab.ts';
import { GoalReplayLabTab } from './subsystem-isolation-lab/GoalReplayLabTab.ts';
import type { GoalReplayBenchScenario } from './subsystem-isolation-lab/goalReplayScenariosPipeline.ts';
import { KickoffDuelLabTab } from './subsystem-isolation-lab/KickoffDuelLabTab.ts';
import { DemolishRespawnLabTab } from './subsystem-isolation-lab/DemolishRespawnLabTab.ts';

export class SubsystemIsolationLabMode extends BaseGameMode {
  declare runtime: LabRuntimePort;
  private tabSwitchEpoch = 0;
  private activeTabCtrl: LabTabController | null = null;

  private readonly probesTab = new ProbesLabTab();
  private readonly multiGhostTab = new MultiGhostLabTab();
  private readonly stateReplayTab = new StateReplayLabTab();
  private readonly ninetySecMatchTab = new NinetySecMatchLabTab();
  private readonly goalReplayTab = new GoalReplayLabTab();
  private readonly kickoffDuelTab = new KickoffDuelLabTab();
  private readonly demolishRespawnTab = new DemolishRespawnLabTab();

  private readonly tabControllers = new Map<IsolationLabTabId, LabTabController>();
  private readonly tabContext: LabTabContext;

  constructor(runtime: LabRuntimePort) {
    super('dev-test-lab', runtime);

    this.tabControllers.set('probes', this.probesTab);
    this.tabControllers.set('multi-ghost', this.multiGhostTab);
    this.tabControllers.set('state-replay', this.stateReplayTab);
    this.tabControllers.set('90s-match', this.ninetySecMatchTab);
    this.tabControllers.set('goal-replay', this.goalReplayTab);
    this.tabControllers.set('kickoff-duel', this.kickoffDuelTab);
    this.tabControllers.set('demolish-respawn', this.demolishRespawnTab);

    this.tabContext = {
      get runtime() {
        return runtime;
      },
      getSwitchEpoch: () => this.tabSwitchEpoch,
      ensureSinglePlayerCarOnly: (resetKickoffState = true) =>
        this.ensureSinglePlayerCarOnly(resetKickoffState),
      enterPodiumShowcase: (winningTeam = 0) => this.goalReplayTab.enterPodiumShowcase(winningTeam),
      exitPodiumShowcase: () => this.goalReplayTab.exitPodiumShowcase(),
      isPodiumActive: () => this.goalReplayTab.isPodiumActive(),
    };

    this.stateReplayTab.attachToHost(this.tabContext);
    this.goalReplayTab.attachToHost(this.tabContext);
  }

  syncExternalGhostWorld(
    worldId: string,
    prevState: Float32Array | number[],
    currState: Float32Array | number[],
    options: GhostWorldUpdateOptions = {}
  ): void {
    this.multiGhostTab.syncExternalGhostWorld(worldId, prevState, currState, options);
  }

  private ensureSinglePlayerCarOnly(resetKickoffState = true): void {
    resetSinglePlayerLabBaseline(this.runtime, resetKickoffState);
  }

  private resetLabArenaBaseline(): void {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    this.tabSwitchEpoch++;

    if (this.activeTabCtrl) {
      this.activeTabCtrl.onDeactivate();
      this.activeTabCtrl = null;
    }
    this.goalReplayTab.exitPodiumShowcase();
    this.stateReplayTab.clearBuffer();

    if (r) {
      r.isBotMatch = false;
      r.releaseGoalReplayCameraOverride?.();
      if (r.keyboard) r.keyboard.ballControlEnabled = true;
      if (r.match?.state) {
        r.match.state.phase = 'playing';
        r.match.state.paused = false;
        r.match.state.countdown = 0;
      }
    }

    r?.interpolator?.setTrainingPhysicsRate?.(120);
    r?.resetAudio?.();
    this.ensureSinglePlayerCarOnly(true);
    r?.camera?.resetView?.();

    store.updateLiveTelemetry({
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

    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      kickoffCountdown: 0,
      isOvertime: false,
      overtimeSeconds: 0,
      winner: null,
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
    hudStore.getState().setReplayState({
      replayPaused: false,
      replayPersistent: false,
    });
  }

  private ensureTabActive(tab: IsolationLabTabId): boolean {
    const store = useSubsystemIsolationLabStore.getState();
    if (store.activeTab !== tab) {
      store.applyAndRestartLab(tab);
      return true;
    }
    return false;
  }

  private bindStoreHandlers(): void {
    const stateReplay = this.stateReplayTab;
    const handleStartRecording = () => stateReplay.startRecording();
    const handleStopRecording = () => stateReplay.pauseRecording();
    const handlePushBackwardStart = () => stateReplay.beginScrub('rewinding');
    const handlePushForwardStart = () => stateReplay.beginScrub('forwarding');
    const handlePauseScrub = () => stateReplay.pauseScrub();
    const handleResumeFromCursor = () => stateReplay.resumeFromCursor();
    const handleClearBuffer = () => stateReplay.clearBuffer();
    const handleExportReplay = () => stateReplay.exportReplay();
    const handleImportReplay = (file: File | Blob | ArrayBuffer | Uint8Array) =>
      stateReplay.importReplay(file);
    const handleSeekFrame = (idx: number) => stateReplay.seekFrame(idx);

    const rewinderHandlers = {
      onRewinderStartRecording: handleStartRecording,
      onRewinderStopRecording: handleStopRecording,
      onRewinderPushBackwardStart: handlePushBackwardStart,
      onRewinderPushBackwardStop: handlePauseScrub,
      onRewinderPushForwardStart: handlePushForwardStart,
      onRewinderPushForwardStop: handlePauseScrub,
      onRewinderResumeFromHere: handleResumeFromCursor,
      onRewinderClearBuffer: handleClearBuffer,
      onRewinderCancelToFreeplay: handleClearBuffer,
      onRewinderExportReplay: handleExportReplay,
      onRewinderImportReplay: handleImportReplay,
      onRewinderSeekFrame: handleSeekFrame,
    };

    useRewinderStore.getState().setRuntimeHandlers(rewinderHandlers);

    const handleTabChange = (tab: IsolationLabTabId) => this.handleTabSwitch(tab);
    const handleProbesConfigChange = () => this.probesTab.syncConfiguration(false);
    const handleProbeCameraChange = (target: ProbeCameraTarget) => {
      if (useSubsystemIsolationLabStore.getState().activeTab === 'probes') {
        this.probesTab.applyCameraTarget(target);
      }
    };
    const handleDualWorldConfigChange = () => this.multiGhostTab.syncDualWorldConfiguration(false);
    const handleSwitchWorld = () => {
      this.ensureTabActive('multi-ghost');
      this.multiGhostTab.handleSwitchWorld();
    };
    const handleStartIncidentMatch = (oppMode: IncidentOpponentMode) => {
      if (!this.ensureTabActive('90s-match')) {
        void this.ninetySecMatchTab.startMatchSession(oppMode);
      }
    };
    const handleIncidentControlModeChange = (oppMode: IncidentOpponentMode) =>
      this.ninetySecMatchTab.handleControlModeSwitch(oppMode);
    const handleIncidentControlledCarChange = (carIdx: number) =>
      this.ninetySecMatchTab.applyControlledCar(carIdx);
    const handleIncidentSpeedMultiplierChange = (mult: number) =>
      this.ninetySecMatchTab.applySpeedMultiplier(mult);
    const handleTriggerIncidentAction = (action: IncidentSandboxAction) => {
      this.ensureTabActive('90s-match');
      this.ninetySecMatchTab.triggerSandboxAction(action);
    };
    const handleGoalReplayTriggerScenario = (scenario: GoalReplayBenchScenario) => {
      this.ensureTabActive('goal-replay');
      this.goalReplayTab.triggerScenario(scenario);
    };
    const handleGoalReplayTogglePause = () => this.goalReplayTab.togglePause();
    const handleGoalReplayCycleSpeed = () => this.goalReplayTab.cycleSpeed();
    const handleGoalReplaySeekNormalized = (progress01: number) =>
      this.goalReplayTab.seekNormalized(progress01);
    const handleEnterPodiumTest = (winningTeam: number) => {
      this.ensureTabActive('goal-replay');
      this.goalReplayTab.enterPodiumShowcase(winningTeam);
    };
    const handleExitPodiumTest = () => this.goalReplayTab.exitPodiumShowcase();
    const handleKickoffDuelRestart = (slotIdx?: number) => {
      if (!this.ensureTabActive('kickoff-duel')) {
        this.kickoffDuelTab.startEpisode(slotIdx ?? null);
      }
    };
    const handleKickoffDuelSpeedChange = (mult: number) => {
      if (useSubsystemIsolationLabStore.getState().activeTab === 'kickoff-duel') {
        this.kickoffDuelTab.applySpeedMultiplier(mult);
      }
    };
    const handleKickoffDuelRunBenchmark = () => this.kickoffDuelTab.runMatrixBenchmark();
    const handleKickoffDuelExportDiagnostics = (format: string, scope: string) =>
      this.kickoffDuelTab.exportDiagnostics(format, scope);
    const handleDemolishTriggerDemo = () => {
      this.ensureTabActive('demolish-respawn');
      this.demolishRespawnTab.triggerDemolish();
    };
    const handleDemolishForceRespawn = () => {
      this.ensureTabActive('demolish-respawn');
      this.demolishRespawnTab.forceRespawnNow();
    };
    const handleDemolishSimulateSteer = (direction: string) => {
      this.ensureTabActive('demolish-respawn');
      this.demolishRespawnTab.simulateSteerEdge(direction);
    };
    const handleDemolishSelectSlot = (slotIndex: number) => {
      this.ensureTabActive('demolish-respawn');
      this.demolishRespawnTab.selectSlotDirect(slotIndex);
    };
    const handleDemolishConfigChange = () => {
      if (useSubsystemIsolationLabStore.getState().activeTab === 'demolish-respawn') {
        this.demolishRespawnTab.applyConfigChange();
      }
    };

    useSubsystemIsolationLabStore.getState().setRuntimeHandlers({
      onTabChange: handleTabChange,
      onProbesConfigChange: handleProbesConfigChange,
      onProbeCameraChange: handleProbeCameraChange,
      onDualWorldConfigChange: handleDualWorldConfigChange,
      onSwitchWorld: handleSwitchWorld,
      ...rewinderHandlers,
      onStartIncidentMatch: handleStartIncidentMatch,
      onIncidentControlModeChange: handleIncidentControlModeChange,
      onIncidentControlledCarChange: handleIncidentControlledCarChange,
      onIncidentSpeedMultiplierChange: handleIncidentSpeedMultiplierChange,
      onTriggerIncidentAction: handleTriggerIncidentAction,
      onGoalReplayTriggerScenario: handleGoalReplayTriggerScenario,
      onGoalReplayTogglePause: handleGoalReplayTogglePause,
      onGoalReplayCycleSpeed: handleGoalReplayCycleSpeed,
      onGoalReplaySeekNormalized: handleGoalReplaySeekNormalized,
      onEnterPodiumTest: handleEnterPodiumTest,
      onExitPodiumTest: handleExitPodiumTest,
      onKickoffDuelRestart: handleKickoffDuelRestart,
      onKickoffDuelSpeedChange: handleKickoffDuelSpeedChange,
      onKickoffDuelRunBenchmark: handleKickoffDuelRunBenchmark,
      onKickoffDuelExportDiagnostics: handleKickoffDuelExportDiagnostics,
      onDemolishRespawnTriggerDemo: handleDemolishTriggerDemo,
      onDemolishRespawnForceRespawn: handleDemolishForceRespawn,
      onDemolishRespawnSimulateSteer: handleDemolishSimulateSteer,
      onDemolishRespawnSelectSlot: handleDemolishSelectSlot,
      onDemolishRespawnConfigChange: handleDemolishConfigChange,
    });
  }

  onEnter(): void {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();

    const targetTab: IsolationLabTabId =
      (store.selectedTab as IsolationLabTabId) ||
      (store.activeTab as IsolationLabTabId) ||
      'probes';

    useSubsystemIsolationLabStore.setState({
      activeTab: targetTab,
      selectedTab: targetTab,
      probesEnabled: targetTab === 'probes',
      dualWorldEnabled: targetTab === 'multi-ghost',
      incidentMatchActive: targetTab === '90s-match',
      probeCameraTarget: 'player',
      rewinderState: 'idle',
      rewinderPrerollRemainingSec: 0,
      podiumActive: false,
      goalReplayPhase: 'live',
    });

    this.bindStoreHandlers();
    this.stateReplayTab.bindHotkeys();
    if (r?.keyboard) r.keyboard.ballControlEnabled = true;
    r?.physics?.setUnlimitedBoost?.(true);
    this.handleTabSwitch(targetTab);
  }

  onLeave(): void {
    this.stateReplayTab.unbindHotkeys();
    this.resetLabArenaBaseline();
    useSubsystemIsolationLabStore.getState().updateLiveTelemetry({
      rewinderState: 'idle',
      rewinderPrerollRemainingSec: 0,
      incidentMatchActive: false,
      dualWorldEnabled: false,
      probesEnabled: false,
      probeCameraTarget: 'player',
      podiumActive: false,
      goalReplayPhase: 'live',
    });
    (this.runtime?.modeManager ?? this.runtime?.gameModeManager)?.modes
      ?.get?.('freeplay')
      ?.rewinderController?.attach?.();
  }

  private handleTabSwitch(tab: IsolationLabTabId): void {
    this.resetLabArenaBaseline();
    const nextController = this.tabControllers.get(tab) ?? null;
    this.activeTabCtrl = nextController;
    this.activeTabCtrl?.onActivate(this.tabContext);
  }

  onBeforePhysicsTick(): boolean {
    if (this.goalReplayTab.isPodiumActive()) {
      return false;
    }

    if (!this.stateReplayTab.stepBeforePhysicsTick()) {
      return false;
    }

    const result = this.activeTabCtrl?.onPhysicsTick(1 / 120);
    return result !== false;
  }

  onAfterPhysicsTick(): void {
    this.stateReplayTab.recordFrameAfterTick();
    this.activeTabCtrl?.onAfterPhysicsTick?.();
  }

  update(context: FrameContext): void {
    const ctx = context as unknown as LabFrameUpdateContext;
    const { playerCarView } = ctx;
    const store = useSubsystemIsolationLabStore.getState();

    if (this.goalReplayTab.isPodiumActive() && this.activeTabCtrl !== this.goalReplayTab) {
      this.goalReplayTab.updatePresentation(ctx);
    }
    this.activeTabCtrl?.onRenderFrame?.(ctx);

    if (playerCarView) {
      const r = this.runtime;
      const activeCarIdx = ctx.activeCar ?? ctx.activeCarIndex ?? 0;
      const isRewinderScrubOrPreroll = this.stateReplayTab.isScrubOrPrerollActive();
      const defaultUnlimited =
        store.activeTab !== '90s-match' && store.activeTab !== 'kickoff-duel';
      const unlimitedHud = isRewinderScrubOrPreroll
        ? false
        : (r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ?? defaultUnlimited);
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, unlimitedHud);
    }
  }

  onResetKickoff(seed = -1): void {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    const defaultUnlimited = store.activeTab !== '90s-match' && store.activeTab !== 'kickoff-duel';
    r?.physics?.setUnlimitedBoost?.(defaultUnlimited);
    r?.physics?.resetKickoff?.(seed);
    r?.interpolator?.sync?.();
    r?.arena?.resetBallTrail?.();
    r?.camera?.resetView?.();
  }
}
