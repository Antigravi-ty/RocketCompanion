import { BaseGameMode } from './BaseGameMode.js';
import { INCIDENT_EVENT_TYPES, MATCH_SIGNALS } from '../../physics/RocketSimConstants.js';
import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../replay/ReplayRingBuffer.js';
import {
  ReplayTimelineController,
  extractGoalReplayFrames,
  applyReplayFrameToEngine,
  applyDirectorReplayCamera,
  dispatchReplayFrameEvents,
} from '../../replay/ReplayTimelineController.js';
import { StandaloneReplayViewerController } from '../../replay/StandaloneReplayViewerController.js';
import { FreeplayRewinderController } from '../../replay/FreeplayRewinderController.js';
import { hudStore } from '../../stores/hudStore';

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
    this.standaloneReplayViewer = new StandaloneReplayViewerController(runtime);
    this.standaloneReplayViewer.attach();
    this.rewinderController = new FreeplayRewinderController(runtime, this);
    this.rewinderController.attach();

    this.isReplayActive = false;
    this.replayCameraMode = 'director'; // 'director' | 'pov'
    this.goalResetTicks = 0;
    this.lastKickoffStartTick = 0;
    this._resetPlayTouchAndGoalState();
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
      r.keyboard.ballControlEnabled = true;
    }
    if (r?.physics && this.replayController.engine !== r.physics) {
      this.replayController.attach(r.physics, this.replayRingBuffer);
    }
    this.standaloneReplayViewer.runtime = r;
    this.standaloneReplayViewer.attach();
    this.rewinderController.runtime = r;
    this.rewinderController.mode = this;
    this.rewinderController.attach();
    this.isReplayActive = false;
    this.goalResetTicks = 0;
    this.replayRingBuffer?.clear?.();
    this._resetPlayTouchAndGoalState();
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

  onLeave() {
    const r = this.runtime;
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }
    this.standaloneReplayViewer.detach();
    this.rewinderController.detach();
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

    // 3. Record 448-float compact snapshot + player controls into ring buffer
    this.replayRingBuffer.recordFrame(currentTick, sim.state, {
      acknowledgedControls: [
        {
          carIndex: r.playerCarIndex ?? 0,
          controls: { ...(r.playerControls || r.neutralControls) },
        },
      ],
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
    if (r.trainingOptions?.disableGoalReset) return;

    const hasBarrierOnGoal = Boolean(bView && sim.hasActiveGoalBarrier?.(bView.posY));
    const goalYThreshold = hasBarrierOnGoal ? 5120 + 88 : 5120;
    const goalScored =
      bView &&
      Math.abs(bView.posY) > goalYThreshold &&
      Math.abs(bView.posX) < 893 &&
      bView.posZ < 643;

    if (goalScored) {
      const blueScored = bView.posY > 0;
      const scoringTeam = blueScored ? 0 : 1;
      const ballSpeedUu = Math.hypot(bView.velX, bView.velY, bView.velZ);
      const ballSpeedKph = Math.max(1, Math.round(ballSpeedUu * 0.036));

      this.goalIncidentTick = currentTick;
      this.goalScoringTeam = scoringTeam;
      this.goalScorerCarIndex = r.playerCarIndex ?? 0;
      this.goalScorerName = 'Player';
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
      carTeamResolver: () => this.goalScoringTeam,
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

    hudStore.getState().setMatchState({
      matchPhase: 'replay',
      replayScorerName: this.goalScorerName,
      replayScorerTeam: this.goalScoringTeam,
      replayBallSpeedKph: this.goalBallSpeedKph,
      replayAssistName: null,
    });

    hudStore.getState().setReplayState({
      replayProgress: 0,
      replayFrameIndex: 0,
      replayTotalFrames: totalFrames,
      replayPaused: false,
      replayPersistent: false,
      replayCameraMode: 'director',
      replaySpeed: 1.0,
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

  _completePostGoalOrReplayTransition() {
    const r = this.runtime;
    this.replayController?.endReplaySession?.();
    this.isReplayActive = false;
    this.goalResetTicks = 0;

    if (r) {
      r.goalReplayCameraOverrideActive = false;
      if (r.keyboard) {
        r.keyboard.ballControlEnabled = true;
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
    const isUnlimited = r.trainingOptions?.boostOption === 'unlimited';

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

    const { playerCarView } = context;
    if (playerCarView) {
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, isUnlimited);
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
    r.physics?.resetKickoff?.(seed);
    r.audioSubsystem?.resetAudio?.();
    r.interpolator?.sync?.();
    r.arena?.resetBallTrail?.();
    r.camera?.resetView?.();
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
