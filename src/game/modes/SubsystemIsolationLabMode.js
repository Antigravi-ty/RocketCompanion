/**
 * SubsystemIsolationLabMode.js
 * Standalone Developer Test Lab game mode ('dev-test-lab') providing isolated, mutually-exclusive test benches:
 * 1. Bench 1 ('probes'): 2-Car Predictive & Non-Predictive Probes (Strictly Inside Arena)
 * 2. Bench 2 ('dual-world'): Dual-World Same-Map Ghost Sandbox
 * 3. Bench 3 ('state-replay'): State Replay Scrubbing & Resume Sandbox (Hotkeys O / P / [ / ] / G)
 * 4. Bench 4 ('incident-match'): 1:30 (90s) Incident, Overtime, Countdown, Speed Multiplier & Possession Match
 * 5. Bench 5 ('goal-replay'): Goal Incident Event, Goal Replay Window Clamping & Podium Celebration
 * 6. Bench 6 ('kickoff-duel'): 4-Model Kickoff Duel Lab + Action & Channel Diagnostics
 */

import { BaseGameMode } from './BaseGameMode.js';
import { MultiWorldGhostRenderer } from './MultiWorldGhostRenderer.js';
import {
  PROBE_BOOST_SLOT,
  PROBE_QE_SLOT,
  setupDevTestLabProbes,
  updateDevTestLabProbeParameters,
  parkDevTestLabProbes,
  stepDevTestLabProbes,
} from './subsystem-isolation-lab/SubsystemIsolationLabProbesHelper.js';
import {
  bindDevTestLabReplayHotkeys,
  unbindDevTestLabReplayHotkeys,
  recordRewinderFrameAfterTick,
  startRewinderRecordingSession,
  pauseRewinderRecordingSession,
  beginRewinderScrubSession,
  pauseRewinderScrubSession,
  seekRewinderFrameToIndex,
  resumeRewinderFromCursorSession,
  importRewinderReplayFile,
  clearRewinderBufferSession,
  stepRewinderBeforePhysicsTick,
} from './subsystem-isolation-lab/SubsystemIsolationLabReplayHelper.js';
import { exportStateReplayFile } from '../../replay/ReplayFileExporter.js';
import {
  applyIncidentControlledCar,
  applyIncidentSpeedMultiplier,
  startIncidentMatchSession,
  handleIncidentControlModeSwitch,
  triggerIncidentSandboxAction,
  stepIncidentMatchTick,
} from './subsystem-isolation-lab/SubsystemIsolationLabIncidentMatchHelper.js';
import {
  ensureGoalReplayTestBenchState,
  setupGoalReplayTestBench,
  stepGoalReplayBenchBeforeTick,
  recordGoalReplayBenchAfterTick,
  updateGoalReplayBenchPresentation,
} from './subsystem-isolation-lab/SubsystemIsolationLabGoalReplayHelper.js';
import {
  triggerGoalReplayBenchScenario,
  enterPodiumInTestLab,
  exitPodiumInTestLab,
} from './subsystem-isolation-lab/SubsystemIsolationLabGoalReplayScenarios.js';
import {
  configureWorldCarsCount,
  resetSecondaryWorldSpawn,
  ensureGhostWorldEngines,
  syncDualWorldConfiguration,
  handleSwitchWorld,
  stepDualWorldGhostEngines,
  renderDualWorldGhostEngines,
} from './subsystem-isolation-lab/SubsystemIsolationLabDualWorldHelper.js';
import {
  setupKickoffDuelBench,
  startKickoffDuelEpisode,
  stepKickoffDuelBeforeTick,
} from './subsystem-isolation-lab/SubsystemIsolationLabKickoffDuelHelper.js';
import {
  runFullKickoffDuelMatrixBenchmark,
  exportKickoffDuelDiagnosticsData,
} from './subsystem-isolation-lab/SubsystemIsolationLabKickoffDuelBenchmark.js';
import {
  setupDemolishRespawnBench,
  triggerDemolishInBench,
  forceRespawnNowInBench,
  simulateDemolishSteerEdgeInBench,
  selectDemolishRespawnSlotDirect,
  applyDemolishRespawnConfigChange,
  stepDemolishRespawnBeforeTick,
} from './subsystem-isolation-lab/SubsystemIsolationLabDemolishRespawnHelper.js';
import { DEFAULT_CAR_CONTROLS } from '../../ai/experimental/ExperimentalBotAgent.js';
import { useSubsystemIsolationLabStore } from '../../ui-core/stores/subsystemIsolationLabStore';
import { useRewinderStore } from '../../ui-core/stores/rewinderStore';
import { hudStore } from '../../ui-core/stores/hudStore';

export class SubsystemIsolationLabMode extends BaseGameMode {
  constructor(runtime) {
    super('dev-test-lab', runtime);
    this._tabSwitchEpoch = 0;
    this.probeState = null;

    this.ghostWorlds = []; // Array of { worldId, sim, prevState, currState }
    this.externalGhostWorlds = new Map(); // Arbitrary external world feeds (3rd+ world custom sync)
    this.ghostWorldsInitPromise = null;
    this.ghostVisuals = null;
    this._currentActiveWorldIdx = 0;

    this.rewinderFrames = [];
    this.rewinderCursor = 0;
    this.rewinderTargetFrame = 0;
    this.rewinderScrubAccumulator = 0;
    this._rewinderLastCountdownSecBeep = -1;
    this._keyDownHandler = null;
    this._keyUpHandler = null;

    this.botBlue = null;
    this.botOrange = null;
    this.botBlueControls = { ...DEFAULT_CAR_CONTROLS };
    this.botOrangeControls = { ...DEFAULT_CAR_CONTROLS };
    this.botBlueTickSkip = 0;
    this.botOrangeTickSkip = 0;
    this.botBlueDeciding = false;
    this.botOrangeDeciding = false;
    this.botDecisionEpoch = 0;
    this.incidentKickoffStep = 0;

    this.incidentCountdownTicks = 0;
    this.incidentTicksSinceKickoff = 0;
    this.incidentClockStarted = false;
    this.incidentClockTickAccum = 0;
    this.incidentRemainingSec = 90;
    this.incidentOvertime = false;
    this.incidentPhase = 'kickoff';
    this.incidentBlueScore = 0;
    this.incidentOrangeScore = 0;
    this.incidentPauseResumeTicks = 0;
    this.incidentGoalResetTicks = 0;
    this.incidentLatched10s = -1;

    this.goalReplayRingBuffer = null;
    this.goalReplayTimelineController = null;
    this.podiumController = null;
    this.goalReplayLastKickoffFrame = 0;
    this.goalReplayIncidentFrame = 0;
    this.goalReplayPostGoalCountdownTicks = 0;
    this.goalReplayScoringTeam = 0;
    this.goalReplayPhase = 'live';
    this.kickoffDuelRuntime = null;
  }

  _configureWorldCarsCount(sim, carsPerWorld = 1, worldIndex = 0, syncArenaVisuals = false, forceReset = false) {
    return configureWorldCarsCount(this, sim, carsPerWorld, worldIndex, syncArenaVisuals, forceReset);
  }

  _resetSecondaryWorldSpawn(sim, worldIndex = 1, carsPerWorld = 1) {
    return resetSecondaryWorldSpawn(this, sim, worldIndex, carsPerWorld);
  }

  async _ensureGhostWorldEngines(ghostEngineCount = 1, carsPerWorld = 1, forceReset = false) {
    return ensureGhostWorldEngines(this, ghostEngineCount, carsPerWorld, forceReset);
  }

  /**
   * Public API to inject or synchronize an arbitrary external Ghost World (3rd world, 4th world, etc.)
   * with up to 8 cars + 1 ball.
   */
  syncExternalGhostWorld(worldId, prevState, currState, options = {}) {
    if (!prevState || !currState) return;
    this.externalGhostWorlds.set(worldId, {
      worldId,
      prevState: prevState instanceof Float32Array ? prevState : new Float32Array(prevState),
      currState: currState instanceof Float32Array ? currState : new Float32Array(currState),
      options,
    });
  }

  _ensureSinglePlayerCarOnly(resetKickoffState = true) {
    const r = this.runtime;
    if (!r?.physics) return;
    parkDevTestLabProbes(r.physics, r.arena);
    this.probeState = null;
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
    this._applyProbeCameraTarget('player');
  }

  /**
   * Completely tears down any active bench state, particles, audio loops, camera overrides,
   * match countdown locks, and ghost worlds before initializing or restarting a bench.
   */
  _resetLabArenaBaseline() {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    this._tabSwitchEpoch = (this._tabSwitchEpoch || 0) + 1;
    this.botDecisionEpoch++;

    if (this.podiumController?.isActive) {
      this.podiumController.exitPodium();
    }
    if (this.goalReplayTimelineController?.isActive) {
      this.goalReplayTimelineController.endReplaySession();
    }
    if (r) {
      r.isBotMatch = false;
      r.goalReplayCameraOverrideActive = false;
      if (r.keyboard) r.keyboard.ballControlEnabled = true;
      if (r.match?.state) {
        r.match.state.phase = 'playing';
        r.match.state.paused = false;
        r.match.state.countdown = 0;
      }
    }

    this.goalReplayPhase = 'live';
    this.goalReplayPostGoalCountdownTicks = 0;
    this.incidentPauseResumeTicks = 0;
    this.incidentGoalResetTicks = 0;
    this.incidentCountdownTicks = 0;
    this.incidentClockStarted = false;
    this.incidentTicksSinceKickoff = 0;
    this.incidentClockTickAccum = 0;
    this.incidentOvertime = false;
    this.incidentPhase = 'playing';
    this.kickoffDuelRuntime = null;

    if (this.ghostVisuals) {
      this.ghostVisuals.setVisible(false);
    }

    this.clearRewinderBuffer();

    r?.interpolator?.setTrainingPhysicsRate?.(120);
    r?.resetAudio?.();
    this._ensureSinglePlayerCarOnly(true);
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

  _ensureTabActive(tab) {
    const store = useSubsystemIsolationLabStore.getState();
    if (store.activeTab !== tab) {
      store.applyAndRestartLab(tab);
      return true;
    }
    return false;
  }

  onEnter() {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();


    const targetTab = store.selectedTab || store.activeTab || 'probes';
    useSubsystemIsolationLabStore.setState({
      activeTab: targetTab,
      selectedTab: targetTab,
      probesEnabled: targetTab === 'probes',
      dualWorldEnabled: targetTab === 'dual-world',
      incidentMatchActive: targetTab === 'incident-match',
      probeCameraTarget: 'player',
      rewinderState: 'idle',
      rewinderPrerollRemainingSec: 0,
      podiumActive: false,
      goalReplayPhase: 'live',
    });

    // Lazy-init MultiWorldGhostRenderer and GoalReplayTestBenchState only when their tabs are entered
    if (targetTab === 'dual-world' && !this.ghostVisuals && r.arena) {
      this.ghostVisuals = new MultiWorldGhostRenderer(r.arena);
    }
    if (targetTab === 'goal-replay') {
      ensureGoalReplayTestBenchState(this);
    }

    store.setRuntimeHandlers({
      onTabChange: (tab) => this._handleTabSwitch(tab),
      onProbesConfigChange: () => this._syncProbesConfiguration(false),
      onProbeCameraChange: (target) => {
        if (useSubsystemIsolationLabStore.getState().activeTab === 'probes') {
          this._applyProbeCameraTarget(target);
        }
      },
      onDualWorldConfigChange: () => this._syncDualWorldConfiguration(false),
      onSwitchWorld: (idx) => {
        this._ensureTabActive('dual-world');
        this._handleSwitchWorld(idx);
      },
      onRewinderStartRecording: () => {
        this.startRewinderRecording();
      },
      onRewinderStopRecording: () => this.stopRewinderRecording(),
      onRewinderPushBackwardStart: () => this.beginRewinderScrub('rewinding'),
      onRewinderPushBackwardStop: () => this.pauseRewinderScrub(),
      onRewinderPushForwardStart: () => this.beginRewinderScrub('forwarding'),
      onRewinderPushForwardStop: () => this.pauseRewinderScrub(),
      onRewinderResumeFromHere: () => this.resumeRewinderFromCursor(),
      onRewinderClearBuffer: () => this.clearRewinderBuffer(),
      onRewinderCancelToFreeplay: () => this.clearRewinderBuffer(),
      onRewinderExportReplay: () => this.exportRewinderReplay(),
      onRewinderImportReplay: (file) => this.importRewinderReplay(file),
      onRewinderSeekFrame: (idx) => this.seekRewinderFrame(idx),
      onStartIncidentMatch: (oppMode) => {
        if (!this._ensureTabActive('incident-match')) {
          this.startIncidentMatch(oppMode);
        }
      },
      onIncidentControlModeChange: (oppMode) => handleIncidentControlModeSwitch(this, oppMode),
      onIncidentControlledCarChange: (carIdx) => applyIncidentControlledCar(this, carIdx),
      onIncidentSpeedMultiplierChange: (mult) => applyIncidentSpeedMultiplier(this, mult),
      onTriggerIncidentAction: (action) => {
        this._ensureTabActive('incident-match');
        this.triggerIncidentAction(action);
      },
      onGoalReplayTriggerScenario: (scenario) => {
        this._ensureTabActive('goal-replay');
        triggerGoalReplayBenchScenario(this, scenario);
      },
      onGoalReplayTogglePause: () => {
        if (!this.goalReplayTimelineController) {
          console.warn('[SubsystemIsolationLabMode] Cannot toggle goal replay pause: goalReplayTimelineController is not initialized.');
          return;
        }
        const paused = this.goalReplayTimelineController.togglePause();
        useSubsystemIsolationLabStore.getState().updateLiveTelemetry({ goalReplayPaused: paused });
      },
      onGoalReplayCycleSpeed: () => {
        if (!this.goalReplayTimelineController) {
          console.warn('[SubsystemIsolationLabMode] Cannot cycle goal replay speed: goalReplayTimelineController is not initialized.');
          return;
        }
        const speed = this.goalReplayTimelineController.cyclePlaybackSpeed();
        useSubsystemIsolationLabStore.getState().updateLiveTelemetry({ goalReplaySpeed: speed });
      },
      onGoalReplaySeekNormalized: (progress01) => {
        if (!this.goalReplayTimelineController) {
          console.warn('[SubsystemIsolationLabMode] Cannot seek goal replay: goalReplayTimelineController is not initialized.');
          return;
        }
        this.goalReplayTimelineController.seekToNormalized(progress01, r.interpolator);
        useSubsystemIsolationLabStore.getState().updateLiveTelemetry({
          goalReplayPlaybackCursor: this.goalReplayTimelineController.currentFrameIndex,
          goalReplayPlaybackTotal: this.goalReplayTimelineController.getTotalRecordedFrames(),
        });
      },
      onEnterPodiumTest: (winningTeam) => {
        this._ensureTabActive('goal-replay');
        enterPodiumInTestLab(this, winningTeam);
      },
      onExitPodiumTest: () => exitPodiumInTestLab(this),
      onKickoffDuelRestart: (slotIdx) => {
        if (!this._ensureTabActive('kickoff-duel')) {
          startKickoffDuelEpisode(this, slotIdx);
        }
      },
      onKickoffDuelSpeedChange: (mult) => {
        if (useSubsystemIsolationLabStore.getState().activeTab === 'kickoff-duel') {
          const m = Math.max(100, Math.min(400, Number(mult) || 100));
          r.interpolator?.setTrainingPhysicsRate?.(Math.round(120 * (m / 100)));
        }
      },
      onKickoffDuelRunBenchmark: () => runFullKickoffDuelMatrixBenchmark(),
      onKickoffDuelExportDiagnostics: (format, scope) =>
        exportKickoffDuelDiagnosticsData(this, format, scope),
      onDemolishRespawnTriggerDemo: () => {
        this._ensureTabActive('demolish-respawn');
        triggerDemolishInBench(this);
      },
      onDemolishRespawnForceRespawn: () => {
        this._ensureTabActive('demolish-respawn');
        forceRespawnNowInBench(this);
      },
      onDemolishRespawnSimulateSteer: (direction) => {
        this._ensureTabActive('demolish-respawn');
        simulateDemolishSteerEdgeInBench(this, direction);
      },
      onDemolishRespawnSelectSlot: (slotIndex) => {
        this._ensureTabActive('demolish-respawn');
        selectDemolishRespawnSlotDirect(this, slotIndex);
      },
      onDemolishRespawnConfigChange: () => {
        if (useSubsystemIsolationLabStore.getState().activeTab === 'demolish-respawn') {
          applyDemolishRespawnConfigChange(this);
        }
      },
    });

    bindDevTestLabReplayHotkeys(this);
    if (r.keyboard) r.keyboard.ballControlEnabled = true;
    r.physics?.setUnlimitedBoost?.(true);
    this._handleTabSwitch(targetTab);
  }

  onLeave() {
    unbindDevTestLabReplayHotkeys(this);
    this._resetLabArenaBaseline();
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

  _handleTabSwitch(tab) {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();

    // Always tear down previous bench state & reset arena baseline cleanly
    this._resetLabArenaBaseline();

    if (tab === 'probes') {
      this._syncProbesConfiguration(true);
    } else if (tab === 'dual-world') {
      if (!this.ghostVisuals && r.arena) {
        this.ghostVisuals = new MultiWorldGhostRenderer(r.arena);
      }
      this._syncDualWorldConfiguration(true);
    } else if (tab === 'incident-match') {
      this.startIncidentMatch(store.incidentOpponentMode);
    } else if (tab === 'goal-replay') {
      ensureGoalReplayTestBenchState(this);
      setupGoalReplayTestBench(this);
    } else if (tab === 'kickoff-duel') {
      setupKickoffDuelBench(this);
    } else if (tab === 'demolish-respawn') {
      setupDemolishRespawnBench(this);
    }
  }

  _syncProbesConfiguration(forceRestart = false) {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    if (!r.physics) return;
    if (store.activeTab !== 'probes') return;

    if (store.probesEnabled) {
      if (!forceRestart && this.probeState && r.physics.numCars > PROBE_QE_SLOT) {
        updateDevTestLabProbeParameters(
          r.physics,
          this.probeState,
          store.probeBaseAltitudeZ,
          store.probePeakAltitudeZ,
          store.probeOffsetX,
          store.probeOffsetY,
          store.probeOffsetZ,
          r.arena
        );
      } else {
        this.probeState = setupDevTestLabProbes(
          r.physics,
          r.arena,
          store.probeBaseAltitudeZ,
          store.probePeakAltitudeZ,
          store.probeOffsetX,
          store.probeOffsetY,
          store.probeOffsetZ
        );
      }
      store.updateLiveTelemetry({
        probeBoostZ: this.probeState?.effectiveBaseZ ?? store.probeBaseAltitudeZ,
        probeBoostVz: 0,
        probeBoostPhase: 'CLIMB_TO_PEAK',
        probeBoostHoldTicks: 0,
        probeRollDir: 1,
      });
      r.interpolator?.sync?.();
    } else {
      parkDevTestLabProbes(r.physics, r.arena);
      this.probeState = null;
      if (store.probeCameraTarget !== 'player') this._applyProbeCameraTarget('player');
    }
  }

  _applyProbeCameraTarget(target) {
    const r = this.runtime;
    if (!r) return;
    r.playerCarIndex = target === 'boost_probe' ? PROBE_BOOST_SLOT : target === 'qe_probe' ? PROBE_QE_SLOT : 0;
    if (r.arena) r.arena.playerCarIndex = r.playerCarIndex;
  }

  _syncDualWorldConfiguration(forceRestart = false) {
    return syncDualWorldConfiguration(this, forceRestart);
  }

  _handleSwitchWorld() {
    return handleSwitchWorld(this);
  }

  startRewinderRecording() {
    startRewinderRecordingSession(this);
  }

  pauseRewinderRecording() {
    pauseRewinderRecordingSession(this);
  }

  stopRewinderRecording() {
    pauseRewinderRecordingSession(this);
  }

  beginRewinderScrub(direction = 'rewinding') {
    beginRewinderScrubSession(this, direction);
  }

  pauseRewinderScrub() {
    pauseRewinderScrubSession(this);
  }

  seekRewinderFrame(frameIndex) {
    seekRewinderFrameToIndex(this, frameIndex);
  }

  resumeRewinderFromCursor() {
    resumeRewinderFromCursorSession(this);
  }

  async exportRewinderReplay() {
    if (!this.rewinderFrames || this.rewinderFrames.length === 0) {
      console.warn('[SubsystemIsolationLabMode] Cannot export state replay: recorded frame buffer is empty (0 frames).');
      return false;
    }
    return exportStateReplayFile(this.rewinderFrames);
  }

  async importRewinderReplay(fileOrBuffer) {
    return importRewinderReplayFile(this, fileOrBuffer);
  }

  clearRewinderBuffer() {
    clearRewinderBufferSession(this);
  }

  cancelRewinderToFreeplay() {
    clearRewinderBufferSession(this);
  }

  async startIncidentMatch(opponentMode = 'stationary') {
    return startIncidentMatchSession(this, opponentMode);
  }

  triggerIncidentAction(action) {
    return triggerIncidentSandboxAction(this, action);
  }

  onBeforePhysicsTick() {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    const rewinderStore = useRewinderStore.getState();
    const activeTab = store.activeTab;

    if (this.podiumController?.isActive) {
      return false;
    }

    if (!stepRewinderBeforePhysicsTick(this, rewinderStore)) {
      return false;
    }

    if (activeTab === 'goal-replay') {
      return stepGoalReplayBenchBeforeTick(this, store);
    }

    if (activeTab === 'incident-match' && store.incidentMatchActive && this.incidentPauseResumeTicks > 0) {
      this.incidentPauseResumeTicks--;
      if (this.incidentPauseResumeTicks % 12 === 0) {
        this.incidentPhase = `will-resume (${(this.incidentPauseResumeTicks / 120).toFixed(1)}s)`;
        store.updateLiveTelemetry({ incidentPhase: this.incidentPhase });
      }
      if (this.incidentPauseResumeTicks === 0) {
        this.incidentPhase = this.incidentOvertime ? 'overtime' : 'playing';
        store.updateLiveTelemetry({ incidentPhase: this.incidentPhase });
      }
      return false;
    }

    if (activeTab === 'probes' && store.probesEnabled && r.physics) {
      if (!this.probeState) this._syncProbesConfiguration();
      const probeTelemetry = stepDevTestLabProbes(r.physics, this.probeState);
      if (probeTelemetry && this.probeState.tickCounter % 4 === 0) {
        store.updateLiveTelemetry({
          probeBoostZ: probeTelemetry.posZ,
          probeBoostVz: probeTelemetry.velZ,
          probeBoostPhase: probeTelemetry.phase,
          probeBoostHoldTicks: probeTelemetry.holdCounter,
          probeRollDir: probeTelemetry.rollDir,
        });
      }
    }

    if (activeTab === 'dual-world' && store.dualWorldEnabled) {
      stepDualWorldGhostEngines(this, store);
    }

    if (activeTab === 'incident-match' && store.incidentMatchActive && r.physics) {
      stepIncidentMatchTick(this, store);
    }

    if (activeTab === 'kickoff-duel' && r.physics) {
      return stepKickoffDuelBeforeTick(this, store);
    }

    if (activeTab === 'demolish-respawn' && r.physics) {
      return stepDemolishRespawnBeforeTick(this, store);
    }
    return true;
  }

  onAfterPhysicsTick() {
    const store = useSubsystemIsolationLabStore.getState();
    const rewinderStore = useRewinderStore.getState();
    recordRewinderFrameAfterTick(this, rewinderStore);
    recordGoalReplayBenchAfterTick(this, store);
  }

  update(context) {
    const { dt, playerCarView } = context;
    const store = useSubsystemIsolationLabStore.getState();
    const rewinderStore = useRewinderStore.getState();

    if (this.podiumController?.isActive || store.activeTab === 'goal-replay') {
      updateGoalReplayBenchPresentation(this, context, store);
    }

    if (store.activeTab === 'dual-world' && store.dualWorldEnabled && this.ghostVisuals) {
      renderDualWorldGhostEngines(this, dt, store);
    }
    if (playerCarView) {
      const r = this.runtime;
      const activeCarIdx = context.activeCar ?? r?.playerCarIndex ?? 0;
      const isRewinderScrubOrPreroll =
        rewinderStore.rewinderState === 'rewinding' ||
        rewinderStore.rewinderState === 'forwarding' ||
        rewinderStore.rewinderState === 'paused-scrub' ||
        rewinderStore.rewinderState === 'preroll-countdown';
      const defaultUnlimited =
        store.activeTab !== 'incident-match' && store.activeTab !== 'kickoff-duel';
      const unlimitedHud = isRewinderScrubOrPreroll
        ? false
        : (r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ?? defaultUnlimited);
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, unlimitedHud);
    }
  }

  onResetKickoff(seed = -1) {
    const r = this.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    const defaultUnlimited =
      store.activeTab !== 'incident-match' && store.activeTab !== 'kickoff-duel';
    r?.physics?.setUnlimitedBoost?.(defaultUnlimited);
    r?.physics?.resetKickoff?.(seed);
    r?.interpolator?.sync?.();
    r?.arena?.resetBallTrail?.();
    r?.camera?.resetView?.();
  }
}
