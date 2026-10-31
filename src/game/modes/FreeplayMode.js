import { BaseGameMode } from './BaseGameMode.js';
import {
  INCIDENT_EVENT_TYPES,
  MATCH_SIGNALS,
  SIM_OFFSETS,
  MAX_CARS,
  isIncidentEvent,
} from '../../physics/RocketSimConstants.js';
import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../replay/ReplayRingBuffer.js';
import { ReplayTimelineController } from '../../replay/ReplayTimelineCore.js';
import { extractGoalReplayFrames } from '../../replay/ReplayPlaybackState.js';
import { applyReplayFrameToEngine } from '../../replay/ReplayFrameInterpolator.js';
import { applyDirectorReplayCamera } from '../../replay/ReplayDirectorCamera.js';
import { dispatchReplayFrameEvents } from '../../replay/ReplayTimelineController.js';
import {
  parseDirectorDiagnosticPatternText,
  parseDirectorDiagnosticInput,
} from '../../replay/ReplayDirectorDiagnostics.js';
import {
  getActiveReplayTimelineController,
  getLatestRetainedReplayTimelineController,
  setActiveReplayTimelineController,
  registerReplayDirectorPreviewHandlers,
} from '../../ui-core/config/replayDirectorConfig.js';
import {
  getNameTagRuntimeState,
  setNameTagRuntimeState,
} from '../../ui-core/config/nameTagConfig.ts';
import { StandaloneReplayViewerController } from '../../replay/StandaloneReplayViewerController.js';
import { FreeplayRewinderController } from '../../replay/FreeplayRewinderController.js';
import { NameTagTunerArenaController } from './NameTagTunerArenaController.js';
import { hudStore } from '../../ui-core/stores/hudStore';
import { useAppStore } from '../../ui-core/stores/appStore';

const POST_GOAL_CELEBRATION_TICKS = 150; // 1.25s @ 120Hz before Goal Replay
const POST_GOAL_FREEZE_DELAY_TICKS = 30; // 0.25s ball flight into net before freeze
const MAX_GOAL_LOOKBACK_SECONDS = 10.0; // Max 10s before goal (1200 ticks @ 120Hz)
const SCORER_TOUCH_LOOKBACK_SECONDS = 7.0; // Max 7s before scorer's last touch (840 ticks @ 120Hz)

/**
 * FreeplayMode.js
 * Casual practice mode: supports 448-float Goal Replay with Director Camera,
 * Pause & Persistent (P key) timeline scrubbing, incident audio replay,
 * unlimited boost support, free ball controls, Standalone Replay Viewer, and Rewinder Configurator.
 */
export class FreeplayMode extends BaseGameMode {
  constructor(runtime) {
    super('freeplay', runtime);

    this.replayRingBuffer = new ReplayRingBuffer({
      mode: REPLAY_BUFFER_MODES.COUNTDOWN_MATCH,
      capacityTicks: 2400,
    });
    this.replayController = new ReplayTimelineController({
      engine: runtime?.physics || null,
      ringBuffer: this.replayRingBuffer,
    });
    this.standaloneReplayViewer = new StandaloneReplayViewerController(runtime, this);
    this.standaloneReplayViewer.attach();
    this.rewinderController = new FreeplayRewinderController(runtime, this);
    this.rewinderController.attach();
    this.nameTagTunerController = new NameTagTunerArenaController(runtime);
    this.nameTagTunerController.attach();

    this.isReplayActive = false;
    this.replayCameraMode = 'director'; // 'director' | 'pov'
    this.goalResetTicks = 0;
    this.lastKickoffStartTick = 0;
    this._previewSpawnedExtraCars = false;
    this._resetPlayTouchAndGoalState();
    this._registerDirectorPreviewHandlers();
    if (!getActiveReplayTimelineController()) {
      setActiveReplayTimelineController(this.replayController);
    }
  }

  _registerDirectorPreviewHandlers() {
    registerReplayDirectorPreviewHandlers({
      onImportPattern: (fileOrText, options = {}) =>
        this.importDirectorDiagnosticPattern(fileOrText, options),
      onStartPreview: (options = {}) => this.startDirectorPatternPreview(null, options),
      onExitPreview: () => this.exitDirectorPatternPreview(),
      onEnterReferenceFreeCam: (options = {}) =>
        this.enterDirectorReferenceFreeCamFromHere(options),
      onExitReferenceFreeCam: () => this.exitDirectorReferenceFreeCam(),
      onGetLiveCameraState: () => this.runtime?.camera?.getFreeCamStateSnapshot?.() || null,
    });
  }

  _resetPlayTouchAndGoalState() {
    this.lastTouchTick = -1;
    this.goalIncidentTick = -1;
    this.goalScoringTeam = 0;
    this.goalScorerCarIndex = 0;
    this.goalScorerName = 'Player';
    this.goalBallSpeedKph = null;
    this.frozenGoalBallState = null;
    this.prevBallVelX = 0;
    this.prevBallVelY = 0;
    this.prevBallVelZ = 0;
  }

  onEnter() {
    const r = this.runtime;
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = !this.standaloneReplayViewer?.hasLoadedReplay;
    }
    if (r?.physics && this.replayController.engine !== r.physics) {
      this.replayController.attach(r.physics, this.replayRingBuffer);
    }
    this._registerDirectorPreviewHandlers();
    const latestRetainedCtrl =
      getLatestRetainedReplayTimelineController() || getActiveReplayTimelineController();
    if (
      latestRetainedCtrl &&
      latestRetainedCtrl !== this.replayController &&
      latestRetainedCtrl.ActiveWindowCount > 0 &&
      ((latestRetainedCtrl.retainedReplaySeq || 0) > (this.replayController.retainedReplaySeq || 0) ||
        this.replayController.ActiveWindowCount <= 0)
    ) {
      this.replayController.copyRetainedReplayFrom(latestRetainedCtrl);
    }
    setActiveReplayTimelineController(this.replayController);
    this.standaloneReplayViewer.runtime = r;
    this.standaloneReplayViewer.mode = this;
    this.standaloneReplayViewer.attach();
    this.rewinderController.runtime = r;
    this.rewinderController.mode = this;
    this.rewinderController.attach();
    this.nameTagTunerController.runtime = r;
    this.nameTagTunerController.attach();
    this.isReplayActive = false;
    this.goalResetTicks = 0;
    this.replayRingBuffer?.clear?.();
    this._resetPlayTouchAndGoalState();
    this.lastKickoffStartTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);
    const isLobbyPhase = Boolean(r?.arena?.isLobbyMode || r?.match?.state?.phase === 'lobby');
    const targetPhase = isLobbyPhase ? 'lobby' : 'playing';
    if (r?.match?.state) {
      r.match.state.phase = targetPhase;
    }
    hudStore.getState().setMatchState({
      matchPhase: targetPhase,
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
  }

  onLeave() {
    const r = this.runtime;
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }
    this.standaloneReplayViewer.detach();
    this.rewinderController.detach();
    this.nameTagTunerController.detach();
    this.replayController?.endReplaySession?.();
    this.replayRingBuffer?.clear?.();
    this.isReplayActive = false;
    this.goalResetTicks = 0;
    if (r) {
      r.goalReplayCameraOverrideActive = false;
    }
    hudStore.getState().setReplayState({
      replayPaused: false,
      replayPersistent: false,
    });
  }

  onPhysicsEvent(event) {
    if (
      !event ||
      !isIncidentEvent(event.type) ||
      this.isReplayActive ||
      this.standaloneReplayViewer?.isActive ||
      this.rewinderController?.isBlockingLivePhysics
    ) {
      return;
    }
    const currentTick = Math.floor(this.runtime?.physics?.getHeaderView?.()?.tickCount ?? 0);
    const eventTick = typeof event.tick === 'number' && event.tick > 0 ? event.tick : currentTick;

    if (this.replayRingBuffer) {
      this.replayRingBuffer.appendIncident(eventTick, event);
    }

    if (event.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || event.type === 0x01) {
      if (this.goalIncidentTick < 0 || eventTick <= this.goalIncidentTick) {
        this.lastTouchTick = Math.floor(eventTick);
      }
    }

    this.rewinderController?.onPhysicsEvent?.(event);
  }

  onBeforePhysicsTick() {
    this.nameTagTunerController?.onBeforePhysicsTick?.();
    if (this.rewinderController && !this.rewinderController.onBeforePhysicsTick()) {
      return false;
    }
    if (this.isReplayActive) return false;
    if (this.standaloneReplayViewer && !this.standaloneReplayViewer.onBeforePhysicsTick()) {
      return false;
    }
    return true;
  }

  onAfterPhysicsTick() {
    const r = this.runtime;
    const sim = r?.physics;
    if (
      !sim ||
      this.isReplayActive ||
      this.standaloneReplayViewer?.isActive ||
      this.rewinderController?.isBlockingLivePhysics
    ) {
      return;
    }

    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const bView = sim.getBallStateView();
    const cv = sim.getCarStateView(r.playerCarIndex ?? 0);

    // 1. Proximity + impulse touch detection during live play
    if (this.goalResetTicks === 0 && bView && cv && !cv.isDemoed) {
      const dvX = bView.velX - this.prevBallVelX;
      const dvY = bView.velY - this.prevBallVelY;
      const dvZ = bView.velZ - (this.prevBallVelZ - 650.0 / 120.0);
      const impulseMag = Math.hypot(dvX, dvY, dvZ);
      const dist = Math.hypot(cv.posX - bView.posX, cv.posY - bView.posY, cv.posZ - bView.posZ);

      if (dist <= 168.0 || (dist <= 198.0 && impulseMag > 25.0)) {
        this.lastTouchTick = currentTick;
      }

      this.prevBallVelX = bView.velX;
      this.prevBallVelY = bView.velY;
      this.prevBallVelZ = bView.velZ;
    }

    // 2. Post-goal 30-frame ball flight & freeze inside goal net
    if (
      this.goalResetTicks > 0 &&
      this.goalIncidentTick >= 0 &&
      currentTick >= this.goalIncidentTick + POST_GOAL_FREEZE_DELAY_TICKS
    ) {
      if (!this.frozenGoalBallState && typeof sim.getBallState === 'function') {
        const snapBall = new Float32Array(sim.getBallState());
        for (let i = 12; i < 18; i++) snapBall[i] = 0;
        this.frozenGoalBallState = snapBall;
      }
      if (this.frozenGoalBallState && typeof sim.setBallState === 'function') {
        sim.setBallState(this.frozenGoalBallState);
      }
    }

    // 3. Record 448-float compact snapshot + active cars' controls into ring buffer
    const numActiveCars = Math.min(MAX_CARS, Math.max(1, sim.numCars || 1));
    const acknowledgedControls = [];
    if (numActiveCars > 1 && sim.controlsView) {
      const view = sim.controlsView;
      for (let c = 0; c < numActiveCars; c++) {
        if (c === (r.playerCarIndex ?? 0)) {
          acknowledgedControls.push({
            carIndex: c,
            controls: { ...(r.playerControls || r.neutralControls) },
          });
        } else {
          const base = c * 8;
          acknowledgedControls.push({
            carIndex: c,
            controls: {
              throttle: view[base + 0] || 0,
              steer: view[base + 1] || 0,
              pitch: view[base + 2] || 0,
              yaw: view[base + 3] || 0,
              roll: view[base + 4] || 0,
              jump: view[base + 5] >= 0.5,
              boost: view[base + 6] >= 0.5,
              handbrake: view[base + 7] >= 0.5,
            },
          });
        }
      }
    } else {
      acknowledgedControls.push({
        carIndex: r.playerCarIndex ?? 0,
        controls: { ...(r.playerControls || r.neutralControls) },
      });
    }
    this.replayRingBuffer.recordFrame(currentTick, sim.state, {
      acknowledgedControls,
    });
    this.rewinderController?.onAfterPhysicsTick?.();

    // 4. Advance post-goal celebration countdown -> transition to Goal Replay
    if (this.goalResetTicks > 0) {
      this.goalResetTicks--;
      if (this.goalResetTicks <= 0) {
        this._beginGoalReplay();
      }
      return;
    }

    // 5. Check Goal Scored
    const isOnlineLobby = Boolean(
      r.arena?.isLobbyMode || r.networkReconciler?.lobbyDualWorldMode
    );
    if (r.trainingOptions?.disableGoalReset || isOnlineLobby) {
      if (isOnlineLobby && !r.authoritativeServer && r.networkReconciler?.lobbyDualWorldMode) {
        const clientLobbyGoal = Boolean(
          bView &&
          (typeof sim.isBallScored === 'function'
            ? sim.isBallScored(bView)
            : Math.abs(bView.posY) > 5120 + 91.25 && Math.abs(bView.posX) < 892.755 && bView.posZ < 642.775)
        );
        if (clientLobbyGoal) {
          sim.resetGoalLatch?.();
          sim.setBallState?.(new Float32Array([
            0, 0, 93,
            1, 0, 0,
            0, 1, 0,
            0, 0, 1,
            0, 0, 0,
            0, 0, 0
          ]));
        }
      } else {
        sim.resetGoalLatch?.();
      }
      return;
    }

    const goalScored = Boolean(
      bView &&
      (typeof sim.isBallScored === 'function'
        ? sim.isBallScored(bView)
        : Math.abs(bView.posY) > 5120 + 91.25 && Math.abs(bView.posX) < 892.755 && bView.posZ < 642.775)
    );

    if (goalScored) {
      const blueScored = bView.posY > 0;
      const scoringTeam = blueScored ? 0 : 1;
      const ballSpeedUu = Math.hypot(bView.velX, bView.velY, bView.velZ);
      const ballSpeedKph = Math.max(1, Math.round(ballSpeedUu * 0.036));

      this.goalIncidentTick = currentTick;
      this.goalScoringTeam = scoringTeam;
      this.goalScorerCarIndex = r.playerCarIndex ?? 0;
      const ntEntries = getNameTagRuntimeState()?.carEntries;
      const scorerEntry = Array.isArray(ntEntries)
        ? ntEntries.find((e) => e.carIndex === this.goalScorerCarIndex)
        : null;
      this.goalScorerName = scorerEntry?.name || scorerEntry?.username || 'Player';
      this.goalBallSpeedKph = ballSpeedKph;
      this.frozenGoalBallState = null;

      // Record GOAL_SCORED incident, SCORE_UPDATED signal, & audio cue into the replay ring buffer
      this.replayRingBuffer.appendIncident(currentTick, {
        type: INCIDENT_EVENT_TYPES.GOAL_SCORED,
        tick: currentTick,
        carIndex: this.goalScorerCarIndex,
        team: scoringTeam,
        posX: bView.posX,
        posY: bView.posY,
        posZ: bView.posZ,
        intensity: ballSpeedUu,
      });
      this.replayRingBuffer.appendSignal(currentTick, {
        signalType: MATCH_SIGNALS.SCORE_UPDATED,
        frameId: currentTick,
        param1: blueScored ? 1 : 0,
        param2: blueScored ? 0 : 1,
      });
      this.replayRingBuffer.appendAudioEvent(currentTick, {
        cueName: 'sfx_goal_poof',
        volume: 1.0,
      });

      const audio = r?.audioSubsystem?.audio || r?.audio;
      audio?.play?.('sfx_goal_poof', 1.0);

      this.goalResetTicks = POST_GOAL_CELEBRATION_TICKS;
      if (r?.match?.state) {
        r.match.state.phase = 'goal';
      }

      hudStore.getState().setMatchState({
        matchPhase: 'goal',
        replayScorerName: this.goalScorerName,
        replayScorerTeam: scoringTeam,
        replayBallSpeedKph: ballSpeedKph,
        replayAssistName: null,
      });
    }
  }

  _beginGoalReplay() {
    const r = this.runtime;
    const sim = r?.physics;
    if (!sim || !this.replayRingBuffer || this.replayRingBuffer.size === 0) {
      this._completePostGoalOrReplayTransition();
      return;
    }

    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const goalTick = this.goalIncidentTick > 0 ? this.goalIncidentTick : currentTick;
    const postGoalTicks = Math.max(0, currentTick - goalTick);

    if (this.replayController.engine !== sim) {
      this.replayController.attach(sim, this.replayRingBuffer);
    }

    const extractedFrames = extractGoalReplayFrames({
      ringBuffer: this.replayRingBuffer,
      engine: null, // Strictly use 448-float ReplayRingBuffer
      goalIncidentTick: goalTick,
      scorerTouchTick: this.lastTouchTick,
      lookbackSeconds: MAX_GOAL_LOOKBACK_SECONDS,
      touchLookbackSeconds: SCORER_TOUCH_LOOKBACK_SECONDS,
      postGoalTicks,
      lastKickoffWillStartTick: this.lastKickoffStartTick,
    });

    if (!Array.isArray(extractedFrames) || extractedFrames.length === 0) {
      this._completePostGoalOrReplayTransition();
      return;
    }

    const totalFrames = this.replayController.beginReplaySession({
      scoringTeam: this.goalScoringTeam,
      scorerCarIndex: this.goalScorerCarIndex,
      carTeamResolver: (carIdx) =>
        r?.arena?.carTeams?.[carIdx] ??
        (carIdx === this.goalScorerCarIndex ? this.goalScoringTeam : carIdx % 2),
      frames: extractedFrames,
    });

    this.isReplayActive = true;
    this.replayCameraMode = 'director';
    this.goalResetTicks = 0;

    if (r?.match?.state) {
      r.match.state.phase = 'replay';
    }
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }

    r.goalReplayCameraOverrideActive = true;

    const firstSnap = extractedFrames[0].snapshot;
    applyReplayFrameToEngine(sim, firstSnap, r.interpolator, firstSnap, 1.0);
    applyDirectorReplayCamera(
      r.camera,
      r.interpolator,
      0,
      this.goalScoringTeam,
      0.016,
      this.goalScorerCarIndex,
      this.replayController.directorCameraState
    );

    const ntState = getNameTagRuntimeState();
    if (!Array.isArray(ntState.carEntries) || ntState.carEntries.length === 0) {
      const scorerName = this.goalScorerName || 'Player';
      const defaultEntries = [
        {
          carIndex: 0,
          name: scorerName,
          username: scorerName,
          team: this.goalScoringTeam === 1 ? 1 : 0,
          isBot: false,
          isLocalPlayer: true,
        },
      ];
      setNameTagRuntimeState({ carEntries: defaultEntries });
      this.replayController.carEntries = defaultEntries;
    } else {
      this.replayController.carEntries = ntState.carEntries.map((c) => ({ ...c }));
    }

    this._bindReplayHudState(totalFrames);
  }

  _bindReplayHudState(totalFrames) {
    const r = this.runtime;
    hudStore.getState().setMatchState({
      matchPhase: 'replay',
      replayScorerName: this.goalScorerName,
      replayScorerTeam: this.goalScoringTeam,
      replayBallSpeedKph: this.goalBallSpeedKph,
      replayAssistName: null,
    });

    hudStore.getState().setReplayState({
      replayProgress: this.replayController.progress,
      replayFrameIndex: this.replayController.currentFrameIndex,
      replayTotalFrames: totalFrames,
      replayPaused: this.replayController.isPaused,
      replayPersistent: this.replayController.isPersistent,
      replayCameraMode: this.replayCameraMode,
      replaySpeed: this.replayController.playbackSpeed,
      replayScorerName: this.goalScorerName,
      replayScorerTeam: this.goalScoringTeam,
      replayBallSpeedKph: this.goalBallSpeedKph,
      replayAssistName: null,
      onReplaySeekNormalized: (norm) => {
        if (!this.replayController.isActive) return;
        this.replayController.isPersistent = true;
        this.replayController.seekToNormalized(norm, r.interpolator);
        if (this.replayCameraMode === 'director') {
          applyDirectorReplayCamera(
            r.camera,
            r.interpolator,
            this.replayController.progress,
            this.goalScoringTeam,
            0.016,
            this.goalScorerCarIndex,
            this.replayController.directorCameraState
          );
        }
        hudStore.getState().setReplayState({
          replayProgress: this.replayController.progress,
          replayFrameIndex: this.replayController.currentFrameIndex,
          replayPaused: this.replayController.isPaused,
          replayPersistent: true,
        });
      },
      onReplayTogglePause: () => {
        if (!this.replayController.isActive) return;
        const paused = this.replayController.togglePause();
        hudStore.getState().setReplayState({
          replayPaused: paused,
          replayPersistent: this.replayController.isPersistent,
        });
      },
      onReplayCycleSpeed: () => {
        if (!this.replayController.isActive) return;
        const speed = this.replayController.cyclePlaybackSpeed();
        hudStore.getState().setReplayState({ replaySpeed: speed });
      },
      onReplayToggleCameraMode: () => {
        if (!this.replayController.isActive) return;
        this.replayCameraMode = this.replayCameraMode === 'director' ? 'pov' : 'director';
        if (this.replayCameraMode === 'director') {
          r.goalReplayCameraOverrideActive = true;
          this.replayController.directorCameraState.initialized = false;
          applyDirectorReplayCamera(
            r.camera,
            r.interpolator,
            this.replayController.progress,
            this.goalScoringTeam,
            0.016,
            this.goalScorerCarIndex,
            this.replayController.directorCameraState
          );
        } else {
          r.goalReplayCameraOverrideActive = false;
          r.camera?.resetView?.();
        }
        hudStore.getState().setReplayState({ replayCameraMode: this.replayCameraMode });
      },
    });
  }

  async importDirectorDiagnosticPattern(fileOrInput, options = {}) {
    const parsed =
      fileOrInput && typeof fileOrInput === 'object' && Array.isArray(fileOrInput.activeFrames)
        ? fileOrInput
        : typeof fileOrInput === 'string'
          ? parseDirectorDiagnosticPatternText(fileOrInput, options.fileName)
          : await parseDirectorDiagnosticInput(fileOrInput, options.fileName);
    if (!parsed || !Array.isArray(parsed.activeFrames) || parsed.activeFrames.length === 0) {
      return null;
    }
    if (options.autoStartPreview !== false) {
      this.startDirectorPatternPreview(parsed, options);
    } else {
      this.replayController.loadImportedDiagnosticPattern(parsed, options);
    }
    return parsed;
  }

  startDirectorPatternPreview(parsedPattern = null, options = {}) {
    const r = this.runtime;
    if (!r) return false;

    const appState = useAppStore.getState();
    if (appState.isOpen) {
      appState.closeMenu();
    }

    const activeCtrl = getActiveReplayTimelineController();

    if (r.match?.state && r.match.state.mode !== 'freeplay') {
      r.match.state.mode = 'freeplay';
      r.match.state.phase = 'playing';
      appState.setMatchMode?.('freeplay');
      r.modeManager?.setMode?.('freeplay');
    }

    if (this.standaloneReplayViewer?.isActive) {
      this.standaloneReplayViewer.pausePlaying?.();
    }

    const sim = r.physics;
    if (sim && this.replayController.engine !== sim) {
      this.replayController.attach(sim, this.replayRingBuffer);
    }

    if (parsedPattern) {
      this.replayController.loadImportedDiagnosticPattern(parsedPattern, options);
    } else {
      const sourceCtrl = getLatestRetainedReplayTimelineController() || activeCtrl;
      if (
        sourceCtrl &&
        sourceCtrl !== this.replayController &&
        sourceCtrl.ActiveWindowCount > 0 &&
        ((sourceCtrl.retainedReplaySeq || 0) > (this.replayController.retainedReplaySeq || 0) ||
          this.replayController.ActiveWindowCount <= 0)
      ) {
        this.replayController.copyRetainedReplayFrom(sourceCtrl);
      }
    }

    const totalFrames = this.replayController.ActiveWindowCount;
    if (totalFrames <= 0) {
      return false;
    }

    const firstSnap = this.replayController.getFrameBufferByIndex(0);
    const numCars = Math.min(
      MAX_CARS,
      Math.max(1, Math.round(firstSnap?.[SIM_OFFSETS.NUM_CARS] || 1))
    );

    const importedEntries =
      this.replayController.importedCarEntries || this.replayController.carEntries;
    const effectiveCarEntries =
      Array.isArray(importedEntries) && importedEntries.length > 0
        ? importedEntries.map((c, idx) => {
            const label = c.name || c.username || `Car ${idx}`;
            const teamNum =
              c.team === 'orange' || c.team === 1
                ? 1
                : c.team === 'blue' || c.team === 0
                  ? 0
                  : idx % 2 === 0
                    ? 0
                    : 1;
            return {
              carIndex: typeof c.carIndex === 'number' ? c.carIndex : idx,
              name: label,
              username: label,
              team: teamNum,
              isBot: Boolean(c.isBot),
              isLocalPlayer: idx === (r.playerCarIndex ?? 0),
            };
          })
        : Array.from({ length: numCars }, (_, idx) => {
            const label = idx === 0 ? 'Player' : `Bot ${idx}`;
            return {
              carIndex: idx,
              name: label,
              username: label,
              team: idx % 2 === 0 ? 0 : 1,
              isBot: idx > 0,
              isLocalPlayer: idx === 0,
            };
          });

    if (numCars > 1) {
      if (sim) {
        while (sim.numCars > numCars && typeof sim.removeCar === 'function') {
          sim.removeCar(sim.numCars - 1);
        }
        while (sim.numCars < numCars && typeof sim.addCar === 'function') {
          const cIdx = sim.numCars;
          const entry = effectiveCarEntries.find((e) => e.carIndex === cIdx);
          sim.addCar(entry ? entry.team : cIdx % 2, 'octane');
        }
      }
      if (r.arena) {
        for (let cIdx = 0; cIdx < numCars; cIdx++) {
          const entry = effectiveCarEntries.find((e) => e.carIndex === cIdx);
          const team = entry ? entry.team : cIdx % 2;
          r.arena.ensureCar?.(cIdx, team, r.arena.carVisual || 'fennec');
        }
      }
      this._previewSpawnedExtraCars = true;
    }

    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: numCars > 1,
      carEntries: effectiveCarEntries,
    });
    this.replayController.carEntries = effectiveCarEntries;

    this.goalScoringTeam = this.replayController.scoringTeam ?? 0;
    this.goalScorerCarIndex = this.replayController.scorerCarIndex ?? 0;
    const scorerEntry = effectiveCarEntries.find((e) => e.carIndex === this.goalScorerCarIndex);
    this.goalScorerName = this.replayController.isImportedPreview
      ? scorerEntry?.name || scorerEntry?.username || 'RCGR Preview'
      : (this.goalScorerName || scorerEntry?.name || 'Player');
    this.goalBallSpeedKph = null;
    this.goalResetTicks = 0;
    this.isReplayActive = true;
    this.replayCameraMode = 'director';

    this.replayController.startPreviewSession({
      loop: true,
      startPaused: Boolean(options.startPaused),
      restart: Boolean(options.restart),
    });

    if (r.match?.state) {
      r.match.state.phase = 'replay';
    }
    if (r.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }
    r.goalReplayCameraOverrideActive = true;

    const curSnap =
      this.replayController.getFrameBufferByIndex(this.replayController.currentFrameIndex) ||
      firstSnap;
    if (curSnap && sim) {
      applyReplayFrameToEngine(sim, curSnap, r.interpolator, curSnap, 1.0);
    }
    applyDirectorReplayCamera(
      r.camera,
      r.interpolator,
      this.replayController.progress,
      this.goalScoringTeam,
      0.016,
      this.goalScorerCarIndex,
      this.replayController.directorCameraState
    );

    this._bindReplayHudState(totalFrames);
    return true;
  }

  /**
   * One-click "Reference Keyframe from Here":
   * Ensures 3D Arena preview is active and paused at the current frame,
   * initializes Free Camera (Shift+F) at the exact current Director Camera eye + lookAt target,
   * and synchronizes FOV so the user can fine-tune framing (WASD / I-M / Mouse Drag / FOV slider)
   * and export a standalone Reference Keyframe JSON.
   */
  enterDirectorReferenceFreeCamFromHere(options = {}) {
    const r = this.runtime;
    if (!r) return false;

    const activeCtrl = getActiveReplayTimelineController() || this.replayController;
    const savedCursorFloat = activeCtrl?.cursorFloat ?? this.replayController?.cursorFloat ?? 0;

    if (!this.isReplayActive || !this.replayController.isActive) {
      const started = this.startDirectorPatternPreview(null, {
        startPaused: true,
        restart: false,
      });
      if (!started) return false;
      this.replayController.seekToIndex(savedCursorFloat, r.interpolator);
    }

    this.replayController.setPaused(true);
    hudStore.getState().setReplayState({
      replayPaused: true,
      replayPersistent: true,
      replayProgress: this.replayController.progress,
      replayFrameIndex: this.replayController.currentFrameIndex,
    });

    const snap = this.replayController.getCurrentFrameDiagnosticSnapshot();
    const eyeThreeJs = snap?.cameraPose?.dampedEyeThreeJs || [0, 420, -3600];
    const targetThreeJs = snap?.cameraPose?.dampedTargetThreeJs || [0, 120, 0];

    const currentSharedFov = Number(r.camera?.camera?.fov) || Number(useAppStore.getState().freeCamFov) || 80;
    const desiredFov = Number(options.fov) || currentSharedFov;

    if (r.camera) {
      r.camera.setFreeCamFov?.(desiredFov);
      r.camera.setFreeCamPose?.(eyeThreeJs, targetThreeJs);
    }
    useAppStore.setState({ isFreeCam: true, freeCamFov: desiredFov });
    return true;
  }

  /**
   * Returns from Reference FreeCam back to the live Director Camera at the current paused frame.
   */
  exitDirectorReferenceFreeCam() {
    const r = this.runtime;
    useAppStore.getState().setFreeCam(false);
    if (this.isReplayActive && this.replayController.isActive && r) {
      r.goalReplayCameraOverrideActive = true;
      this.replayController.refreshCurrentFrameDirectorPose();
      applyDirectorReplayCamera(
        r.camera,
        r.interpolator,
        this.replayController.progress,
        this.goalScoringTeam,
        0.016,
        this.goalScorerCarIndex,
        this.replayController.directorCameraState
      );
    }
    return true;
  }

  exitDirectorPatternPreview() {
    if (!this.isReplayActive && !this.replayController?.isActive) {
      return false;
    }
    if (useAppStore.getState().isFreeCam) {
      useAppStore.getState().setFreeCam(false);
    }
    this._completePostGoalOrReplayTransition();
    return true;
  }

  _completePostGoalOrReplayTransition() {
    const r = this.runtime;
    this.replayController?.endReplaySession?.();
    this.isReplayActive = false;
    this.goalResetTicks = 0;

    if (
      this._previewSpawnedExtraCars &&
      !this.nameTagTunerController?.isActive &&
      !this.standaloneReplayViewer?.hasLoadedReplay
    ) {
      if (r?.physics) {
        while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
          r.physics.removeCar(r.physics.numCars - 1);
        }
      }
      if (r?.arena?.cars) {
        for (let i = 1; i < r.arena.cars.length; i++) {
          if (r.arena.cars[i]) {
            r.arena.cars[i].visible = false;
          }
        }
      }
      setNameTagRuntimeState({
        isMultiplayerOrMultiCarMode: false,
      });
      this._previewSpawnedExtraCars = false;
    }

    if (r) {
      r.goalReplayCameraOverrideActive = false;
      if (r.keyboard) {
        r.keyboard.ballControlEnabled =
          !this.nameTagTunerController?.isActive &&
          !this.standaloneReplayViewer?.hasLoadedReplay;
      }
      if (r.match?.state) {
        r.match.state.phase = 'playing';
      }
    }

    hudStore.getState().setReplayState({
      replayPaused: false,
      replayPersistent: false,
    });
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });

    this.onResetKickoff();
  }

  skipGoalReplay() {
    if (!this.isReplayActive && this.goalResetTicks <= 0) return;
    this.goalResetTicks = 0;
    this._completePostGoalOrReplayTransition();
  }

  update(context) {
    const r = this.runtime;
    const activeCarIdx = context.activeCar ?? r?.playerCarIndex ?? 0;
    const isScrubOrViewerActive =
      Boolean(this.standaloneReplayViewer?.isActive) ||
      Boolean(this.rewinderController?.isBlockingLivePhysics);
    const isUnlimited = isScrubOrViewerActive
      ? false
      : (r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ??
          Boolean(r?.physics?.isUnlimitedBoost ?? (r?.trainingOptions?.boostOption === 'unlimited')));

    if (this.isReplayActive && this.replayController.isActive) {
      const dt = context.dt ?? 0.016;
      const stepRes = this.replayController.stepPlayback(dt, r.interpolator, true);
      dispatchReplayFrameEvents(stepRes, r);

      if (this.replayCameraMode === 'director') {
        r.goalReplayCameraOverrideActive = true;
        applyDirectorReplayCamera(
          r.camera,
          r.interpolator,
          stepRes.progress,
          this.goalScoringTeam,
          dt,
          this.goalScorerCarIndex,
          this.replayController.directorCameraState
        );
      } else {
        r.goalReplayCameraOverrideActive = false;
      }

      const scorerCarView = r.interpolator?.getCurrCarStateView(this.goalScorerCarIndex);
      context.activeCar = this.goalScorerCarIndex;
      context.activeCarMesh = r.arena?.cars?.[this.goalScorerCarIndex];
      context.playerCarView = scorerCarView;
      context.isSupersonic = Boolean(scorerCarView?.isSupersonic && !scorerCarView?.isDemoed);
      context.curBoost = scorerCarView?.boost ?? 0;

      if (scorerCarView) {
        const fwdSpeed =
          scorerCarView.velX * scorerCarView.fwdX +
          scorerCarView.velY * scorerCarView.fwdY +
          scorerCarView.velZ * scorerCarView.fwdZ;
        r.playerThrottle = Math.abs(fwdSpeed) > 25 ? (fwdSpeed > 0 ? 1 : -1) : 0;
        r.playerControls = {
          ...(r.neutralControls || {}),
          throttle: r.playerThrottle,
          jump: Boolean(scorerCarView.isJumping),
          boost: Boolean(scorerCarView.isBoosting),
        };
        hudStore
          .getState()
          .setBoost(scorerCarView.boost, scorerCarView.isBoosting, isUnlimited);
      }

      const remainingFrames = Math.max(0, (stepRes.totalFrames || 0) - (stepRes.frameIndex || 0));
      if (
        !this.replayController.isPaused &&
        !this.replayController.isPersistent &&
        stepRes.totalFrames > 0 &&
        remainingFrames <= 78
      ) {
        hudStore.getState().setChoreographySignal('goal-replay-will-end');
      }

      hudStore.getState().setReplayState({
        replayProgress: stepRes.progress,
        replayFrameIndex: stepRes.frameIndex,
        replayTotalFrames: stepRes.totalFrames,
        replayPaused: this.replayController.isPaused,
        replayPersistent: this.replayController.isPersistent,
        replayCameraMode: this.replayCameraMode,
        replaySpeed: this.replayController.playbackSpeed,
      });

      if (
        stepRes.isFinished &&
        !this.replayController.isPaused &&
        !this.replayController.isPersistent
      ) {
        this._completePostGoalOrReplayTransition();
      }
      return;
    }

    if (this.isReplayActive && !this.replayController.isActive) {
      this._completePostGoalOrReplayTransition();
    } else if (r?.goalReplayCameraOverrideActive) {
      r.goalReplayCameraOverrideActive = false;
      r.camera?.resetView?.();
    }

    const { playerCarView } = context;
    if (playerCarView) {
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, isUnlimited);
    }
  }

  resetToCleanFreeplay() {
    const r = this.runtime;
    this.id = 'freeplay';

    if (this.standaloneReplayViewer?.hasLoadedReplay || this.standaloneReplayViewer?.isActive) {
      this.standaloneReplayViewer.clearReplay();
    }
    if (this.isReplayActive || this.replayController?.isActive) {
      this.exitDirectorPatternPreview();
    }
    if (this.nameTagTunerController?.isActive) {
      this.nameTagTunerController.exitTunerArena();
    }
    if (
      this.rewinderController &&
      (this.rewinderController.isBlockingLivePhysics ||
        (this.rewinderController.rewinderFrames?.length ?? 0) > 0)
    ) {
      this.rewinderController.clearBuffer();
    }

    if (r?.physics) {
      while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
        r.physics.removeCar(r.physics.numCars - 1);
      }
    }
    if (r?.arena?.cars) {
      if (r.arena.cars[0]) r.arena.cars[0].visible = true;
      for (let i = 1; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) {
          r.arena.cars[i].visible = false;
        }
        r.arena.resetCarBoosts?.(i);
        r.arena.carDemolitions?.[i]?.stop?.();
      }
    }
    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: false,
      carEntries: [],
    });
    this._previewSpawnedExtraCars = false;

    if (r) {
      r.playerCarIndex = 0;
      if (r.arena) {
        r.arena.playerCarIndex = 0;
      }
      r.goalReplayCameraOverrideActive = false;
      const playerTeam = r.teamAssignment?.playerTeam ?? 0;
      r.physics?.setCarTeam?.(0, playerTeam);
      r.arena?.setCarTeam?.(0, playerTeam);
      const appState = useAppStore?.getState?.();
      if (appState?.selectedCar) {
        r.changePlayerVehicle?.(appState.selectedCar);
      }
      if (appState?.carColor) {
        r.setCarColor?.(appState.carColor);
      }
      r.syncPlayerMaterialsLoadout?.();
      if (r.keyboard) {
        r.keyboard.ballControlEnabled = true;
      }
    }
  }

  onResetKickoff(seed = -1) {
    const r = this.runtime;
    if (this.isReplayActive) {
      this.replayController?.endReplaySession?.();
      this.isReplayActive = false;
      if (r) {
        r.goalReplayCameraOverrideActive = false;
      }
    }
    this.rewinderController?.onResetKickoff?.();
    this.goalResetTicks = 0;
    this._resetPlayTouchAndGoalState();
    r.ballTrajectoryPredictor?.clear?.();

    if (this.standaloneReplayViewer?.hasLoadedReplay) {
      const targetIdx = Math.max(
        0,
        Math.min(
          this.standaloneReplayViewer.frames.length - 1,
          Math.round(this.standaloneReplayViewer.targetFrame || this.standaloneReplayViewer.cursor || 0)
        )
      );
      if (!this.standaloneReplayViewer.isActive) {
        this.standaloneReplayViewer._handoffToLiveFreeplay(targetIdx);
      } else {
        this.standaloneReplayViewer._applyFrameAtCursor(false, false);
      }
      r.audioSubsystem?.resetAudio?.();
      r.interpolator?.sync?.();
      r.arena?.resetBallTrail?.();
      r.camera?.resetView?.();
      if (r?.match?.state) {
        r.match.state.phase = 'playing';
      }
      hudStore.getState().setMatchState({
        matchPhase: 'playing',
        replayScorerName: null,
        replayScorerTeam: null,
        replayBallSpeedKph: null,
        replayAssistName: null,
      });
      return;
    }

    const isTrainingUnlimited = r?.trainingOptions?.boostOption === 'unlimited';
    r?.physics?.setUnlimitedBoost?.(isTrainingUnlimited);
    if (this.nameTagTunerController?.isActive) {
      this.nameTagTunerController._spawnSixKickoffCars();
      this.nameTagTunerController._syncCarEntriesFromConfig();
    } else {
      r.physics?.resetKickoff?.(seed);
    }
    r.audioSubsystem?.resetAudio?.();
    r.interpolator?.sync?.();
    r.arena?.resetBallTrail?.();
    if (!this.nameTagTunerController?.isActive || !r.camera?.isFreeCam) {
      r.camera?.resetView?.();
    }
    this.lastKickoffStartTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);
    if (r?.match?.state) {
      r.match.state.phase = 'playing';
    }
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
  }
}
