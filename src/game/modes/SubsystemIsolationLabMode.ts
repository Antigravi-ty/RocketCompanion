import { BaseGameMode } from './BaseGameMode.ts';
import type { FrameContext } from '../pipeline/FramePipeline.ts';
import { DEFAULT_CAR_CONTROLS } from '../../ai/experimental/ExperimentalBotAgent.ts';
import {
  hudStore,
  useRewinderStore,
  useSubsystemIsolationLabStore,
} from '../runtimeUiPort.ts';
import type {
  IsolationLabTabId,
  LabTabContext,
  LabTabController,
} from './subsystem-isolation-lab/LabTabTypes.ts';
import {
  type ProbeCameraTarget,
  ProbesLabTab,
} from './subsystem-isolation-lab/ProbesLabTab.ts';
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

  constructor(runtime: any) {
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
      enterPodiumShowcase: (winningTeam = 0) =>
        this.goalReplayTab.enterPodiumShowcase(winningTeam),
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
    options: Record<string, any> = {}
  ): void {
    this.multiGhostTab.syncExternalGhostWorld(worldId, prevState, currState, options);
  }

  private ensureSinglePlayerCarOnly(resetKickoffState = true): void {
    const r = this.runtime;
    if (!r?.physics) return;

    while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
      r.physics.removeCar(r.physics.numCars - 1);
    }
    if (r.physics.numCars < 1 && typeof r.physics.addCar === 'function') {
      r.physics.addCar(0, 'octane');
    }
    r.physics.setCarLinearFactorAndGravity?.(0, 1, 1, 1, 1);
    r.physics.setCarCollisionMask?.(0, true, true);
    r.physics.setSimulationFrozen?.(false, 0, false);
    r.physics.setPossessionReportingEnabled?.(false);
    r.physics.setUnlimitedBoost?.(true);

    const neutral = r.neutralControls || DEFAULT_CAR_CONTROLS;
    for (let slot = 0; slot < 8; slot++) {
      r.physics.setControls?.(slot, neutral);
    }

    if (resetKickoffState) {
      r.physics.resetGoalLatch?.();
      r.physics.resetKickoff?.(0, false);
      r.physics.clearEvents?.();
    }

    if (r.arena?.cars) {
      if (r.arena.cars[0]) {
        r.arena.cars[0].visible = true;
        r.arena.setCarTeam?.(0, 0);
      }
      for (let i = 1; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) r.arena.cars[i].visible = false;
      }
      r.arena.clearAllGhostOpacities?.();
    }
    r.arena?.resetAllCarEffects?.();
    if (Array.isArray(r.flipResetVisuals)) {
      for (const fx of r.flipResetVisuals) fx?.stopVisual?.();
    }
    r.boostBloom?.clear?.();
    r.ballTrajectoryPredictor?.clear?.();
    r.simulationStage?.resetActionStates?.();
    r.interpolator?.sync?.();

    r.playerCarIndex = 0;
    if (r.arena) r.arena.playerCarIndex = 0;
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
    const rewinderHandlers = {
      onRewinderStartRecording: () => this.stateReplayTab.startRecording(),
      onRewinderStopRecording: () => this.stateReplayTab.pauseRecording(),
      onRewinderPushBackwardStart: () => this.stateReplayTab.beginScrub('rewinding'),
      onRewinderPushBackwardStop: () => this.stateReplayTab.pauseScrub(),
      onRewinderPushForwardStart: () => this.stateReplayTab.beginScrub('forwarding'),
      onRewinderPushForwardStop: () => this.stateReplayTab.pauseScrub(),
      onRewinderResumeFromHere: () => this.stateReplayTab.resumeFromCursor(),
      onRewinderClearBuffer: () => this.stateReplayTab.clearBuffer(),
      onRewinderCancelToFreeplay: () => this.stateReplayTab.clearBuffer(),
      onRewinderExportReplay: () => this.stateReplayTab.exportReplay(),
      onRewinderImportReplay: (file: any) => this.stateReplayTab.importReplay(file),
      onRewinderSeekFrame: (idx: number) => this.stateReplayTab.seekFrame(idx),
    };

    useRewinderStore.getState().setRuntimeHandlers(rewinderHandlers);

    useSubsystemIsolationLabStore.getState().setRuntimeHandlers({
      onTabChange: (tab: IsolationLabTabId) => this.handleTabSwitch(tab),
      onProbesConfigChange: () => this.probesTab.syncConfiguration(false),
      onProbeCameraChange: (target: ProbeCameraTarget) => {
        if (useSubsystemIsolationLabStore.getState().activeTab === 'probes') {
          this.probesTab.applyCameraTarget(target);
        }
      },
      onDualWorldConfigChange: () => this.multiGhostTab.syncDualWorldConfiguration(false),
      onSwitchWorld: () => {
        this.ensureTabActive('multi-ghost');
        this.multiGhostTab.handleSwitchWorld();
      },
      ...rewinderHandlers,
      onStartIncidentMatch: (oppMode: IncidentOpponentMode) => {
        if (!this.ensureTabActive('90s-match')) {
          void this.ninetySecMatchTab.startMatchSession(oppMode);
        }
      },
      onIncidentControlModeChange: (oppMode: IncidentOpponentMode) =>
        this.ninetySecMatchTab.handleControlModeSwitch(oppMode),
      onIncidentControlledCarChange: (carIdx: number) =>
        this.ninetySecMatchTab.applyControlledCar(carIdx),
      onIncidentSpeedMultiplierChange: (mult: number) =>
        this.ninetySecMatchTab.applySpeedMultiplier(mult),
      onTriggerIncidentAction: (action: IncidentSandboxAction) => {
        this.ensureTabActive('90s-match');
        this.ninetySecMatchTab.triggerSandboxAction(action);
      },
      onGoalReplayTriggerScenario: (scenario: GoalReplayBenchScenario) => {
        this.ensureTabActive('goal-replay');
        this.goalReplayTab.triggerScenario(scenario);
      },
      onGoalReplayTogglePause: () => this.goalReplayTab.togglePause(),
      onGoalReplayCycleSpeed: () => this.goalReplayTab.cycleSpeed(),
      onGoalReplaySeekNormalized: (progress01: number) =>
        this.goalReplayTab.seekNormalized(progress01),
      onEnterPodiumTest: (winningTeam: number) => {
        this.ensureTabActive('goal-replay');
        this.goalReplayTab.enterPodiumShowcase(winningTeam);
      },
      onExitPodiumTest: () => this.goalReplayTab.exitPodiumShowcase(),
      onKickoffDuelRestart: (slotIdx?: number) => {
        if (!this.ensureTabActive('kickoff-duel')) {
          this.kickoffDuelTab.startEpisode(slotIdx ?? null);
        }
      },
      onKickoffDuelSpeedChange: (mult: number) => {
        if (useSubsystemIsolationLabStore.getState().activeTab === 'kickoff-duel') {
          this.kickoffDuelTab.applySpeedMultiplier(mult);
        }
      },
      onKickoffDuelRunBenchmark: () => this.kickoffDuelTab.runMatrixBenchmark(),
      onKickoffDuelExportDiagnostics: (format: string, scope: string) =>
        this.kickoffDuelTab.exportDiagnostics(format, scope),
      onDemolishRespawnTriggerDemo: () => {
        this.ensureTabActive('demolish-respawn');
        this.demolishRespawnTab.triggerDemolish();
      },
      onDemolishRespawnForceRespawn: () => {
        this.ensureTabActive('demolish-respawn');
        this.demolishRespawnTab.forceRespawnNow();
      },
      onDemolishRespawnSimulateSteer: (direction: string) => {
        this.ensureTabActive('demolish-respawn');
        this.demolishRespawnTab.simulateSteerEdge(direction);
      },
      onDemolishRespawnSelectSlot: (slotIndex: number) => {
        this.ensureTabActive('demolish-respawn');
        this.demolishRespawnTab.selectSlotDirect(slotIndex);
      },
      onDemolishRespawnConfigChange: () => {
        if (
          useSubsystemIsolationLabStore.getState().activeTab === 'demolish-respawn'
        ) {
          this.demolishRespawnTab.applyConfigChange();
        }
      },
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
    const ctx = context as any;
    const { playerCarView } = ctx;
    const store = useSubsystemIsolationLabStore.getState();

    if (this.goalReplayTab.isPodiumActive() && this.activeTabCtrl !== this.goalReplayTab) {
      this.goalReplayTab.updatePresentation(ctx);
    }
    this.activeTabCtrl?.onRenderFrame?.(ctx);

    if (playerCarView) {
      const r = this.runtime;
      const activeCarIdx = ctx.activeCar ?? r?.playerCarIndex ?? 0;
      const isRewinderScrubOrPreroll = this.stateReplayTab.isScrubOrPrerollActive();
      const defaultUnlimited =
        store.activeTab !== '90s-match' && store.activeTab !== 'kickoff-duel';
      const unlimitedHud = isRewinderScrubOrPreroll
        ? false
        : (r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ?? defaultUnlimited);
      hudStore
        .getState()
        .setBoost(playerCarView.boost, playerCarView.isBoosting, unlimitedHud);
    }
  }

  onResetKickoff(seed = -1): void {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    const defaultUnlimited =
      store.activeTab !== '90s-match' && store.activeTab !== 'kickoff-duel';
    r?.physics?.setUnlimitedBoost?.(defaultUnlimited);
    r?.physics?.resetKickoff?.(seed);
    r?.interpolator?.sync?.();
    r?.arena?.resetBallTrail?.();
    r?.camera?.resetView?.();
  }
}
