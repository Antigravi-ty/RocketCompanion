/**
 * StaticTrainingPackMode.js
 * Game mode ('static-training-pack') powering Play & Edit sessions for Static Training Packs.
 *
 * Modularized into:
 * - static-training/StaticTrainingArenaHelper.js (staging, 60-tick suspension settle, shot launch)
 * - static-training/StaticTrainingReplayHelper.js (Goal Replay & 3s Shot Expiration Replay)
 * - static-training/StaticTrainingEditorHelper.js (4-submode 3D editor camera & WASD/mouse controls)
 */

import { BaseGameMode } from './BaseGameMode.js';
import { INCIDENT_EVENT_TYPES } from '../../physics/RocketSimConstants.js';
import {
  ReplayRingBuffer,
  REPLAY_BUFFER_MODES,
} from '../../replay/ReplayRingBuffer.js';
import { ReplayTimelineController } from '../../replay/ReplayTimelineController.js';
import { StaticTrainingVisuals } from './StaticTrainingVisuals.js';
import {
  useStaticTrainingPackStore,
  getActiveEditItemVariable,
} from '../../stores/staticTrainingPackStore';
import { useStaticTrainingBallCamTunerStore } from '../../stores/staticTrainingBallCamTunerStore';
import { setTemporaryBallOpacityOverride } from '../../config/ballVisualConfig.js';
import { hudStore } from '../../stores/hudStore';
import { gameAudio } from '../../audio/GameAudioEngineFacade.js';
import {
  BALL_GROUND_MIN_Z,
  ensureStaticTrainingSinglePlayerCar,
  applyStagedShotToArena,
  launchStaticTrainingShotNow,
  launchFreeCamTrajectoryPreview,
  spinBallMeshInPlace,
} from './static-training/StaticTrainingArenaHelper.js';
import {
  POST_GOAL_CELEBRATION_TICKS,
  POST_EXPIRE_CELEBRATION_TICKS,
  POST_GOAL_FREEZE_DELAY_TICKS,
  beginStaticTrainingReplaySession,
  completeStaticTrainingReplayAndAdvanceNextShot,
  stepStaticTrainingReplayUpdate,
} from './static-training/StaticTrainingReplayHelper.js';
import {
  applyEditSubModeCamera,
  updateEditorCameraAndContinuousInputs,
  bindStaticTrainingSessionEvents,
  unbindStaticTrainingSessionEvents,
} from './static-training/StaticTrainingEditorHelper.js';

export class StaticTrainingPackMode extends BaseGameMode {
  constructor(runtime) {
    super('static-training-pack', runtime);

    this.replayRingBuffer = new ReplayRingBuffer({
      mode: REPLAY_BUFFER_MODES.COUNTDOWN_MATCH,
      capacityTicks: 3600,
    });
    this.replayController = new ReplayTimelineController({
      engine: runtime?.physics || null,
      ringBuffer: this.replayRingBuffer,
    });

    this.visuals = null;
    this.isReplayActive = false;
    this.replayType = 'goal'; // 'goal' | 'expire'
    this.replayPendingType = 'goal';
    this.replayCameraMode = 'director';
    this.goalResetTicks = 0;
    this.lastKickoffStartTick = 0;

    // Play & Edit test session state
    this.isFreeCamTrajectoryTesting = false;
    this.isTestingSingleShot = false;
    this.playPhase = 'waiting-input'; // 'countdown' | 'waiting-input' | 'live' | 'goal' | 'replay'
    this.countdownTicksRemaining = 0;
    this.lastCountdownBeepSec = -1;
    this.remainingTimeoutTicks = 1200;
    this.lastTimeoutBeepSec = -1;
    this.isOvertimeWaitingGround = false;
    this.kickoffBallFrozen = false;
    this.hasBallMoved = false;
    this.stagedShot = null;
    this.effectiveBallAngVel = [0, 0, 0];
    this._lastAppliedEditBallOpacityOverride = undefined;

    // Edit session input state
    this.heldKeys = new Set();
    this.isLeftMouseDragging = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.ballSpeedZeroLatch = false;
    this._editorCamSpherical = { yaw: Math.PI * 0.5, pitch: -0.22 };

    this._keyDownHandler = null;
    this._keyUpHandler = null;
    this._mouseDownHandler = null;
    this._mouseMoveHandler = null;
    this._mouseUpHandler = null;
    this._contextMenuHandler = null;

    this._resetGoalTracking();
  }

  _syncEditBallOpacityOverride(force = false) {
    const r = this.runtime;
    const store = useStaticTrainingPackStore.getState();
    const isEditNonPlayable =
      store.sessionMode === 'edit' && !this.isTestingSingleShot && !this.isReplayActive;

    let desiredOverride = null;
    if (isEditNonPlayable) {
      const tuner = useStaticTrainingBallCamTunerStore.getState();
      desiredOverride = tuner.enableEditOpacityOverride ? tuner.editBallOpacity : null;
    }

    if (force || this._lastAppliedEditBallOpacityOverride !== desiredOverride) {
      this._lastAppliedEditBallOpacityOverride = desiredOverride;
      setTemporaryBallOpacityOverride(desiredOverride, r?.arena?.ball);
    }
  }

  _resetGoalTracking() {
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
      r.keyboard.ballControlEnabled = false;
    }
    if (r?.physics && this.replayController.engine !== r.physics) {
      this.replayController.attach(r.physics, this.replayRingBuffer);
    }
    if (!this.visuals && r?.arena?.scene) {
      this.visuals = new StaticTrainingVisuals(r.arena.scene);
    }

    ensureStaticTrainingSinglePlayerCar(this);
    bindStaticTrainingSessionEvents(this);
    this._bindStoreRuntimeHandlers();

    const store = useStaticTrainingPackStore.getState();
    if (!store.initialized) {
      store.initStore().then(() => {
        if (this.runtime?.match?.state?.mode === 'static-training-pack') {
          this.reloadCurrentShot();
        }
      });
    } else {
      this.reloadCurrentShot();
    }
  }

  onLeave() {
    const r = this.runtime;
    unbindStaticTrainingSessionEvents(this);
    this.heldKeys.clear();
    this.isLeftMouseDragging = false;
    this._lastAppliedEditBallOpacityOverride = null;
    setTemporaryBallOpacityOverride(null, r?.arena?.ball);

    if (this.isReplayActive) {
      this.replayController?.endReplaySession?.();
      this.isReplayActive = false;
    }
    this.replayRingBuffer?.clear?.();
    this.visuals?.setVisible(false);

    if (r) {
      r.goalReplayCameraOverrideActive = false;
      if (r.ballTrajectoryPredictor) {
        r.ballTrajectoryPredictor.forcePredictAnyMovement = false;
        r.ballTrajectoryPredictor.clearStaticPreview?.();
        r.ballTrajectoryPredictor.clear?.();
      }
      if (r.camera?.isFreeCam) {
        r.camera.setFreeCam(false);
      }
      if (r.keyboard) {
        r.keyboard.ballControlEnabled = true;
      }
      const innerBallMesh = r.arena?.ball?.children?.[0];
      if (innerBallMesh) {
        innerBallMesh.quaternion.identity();
      }
    }

    hudStore.getState().setReplayState({
      replayPaused: false,
      replayPersistent: false,
    });
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      kickoffCountdown: 0,
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
  }

  _bindStoreRuntimeHandlers() {
    useStaticTrainingPackStore.getState().setRuntimeHandlers({
      onShotChanged: () => {
        this.isFreeCamTrajectoryTesting = false;
        this.isTestingSingleShot = false;
        const s = useStaticTrainingPackStore.getState();
        s.setFreeCamTrajectoryTesting(false);
        s.setTestingSingleShot(false);
        this.reloadCurrentShot();
      },
      onSessionModeChanged: () => {
        this.isFreeCamTrajectoryTesting = false;
        this.isTestingSingleShot = false;
        const s = useStaticTrainingPackStore.getState();
        s.setFreeCamTrajectoryTesting(false);
        s.setTestingSingleShot(false);
        this.reloadCurrentShot();
      },
      onEditSubModeChanged: (subMode) => {
        if (this.isFreeCamTrajectoryTesting) {
          this.stopFreeCamTrajectoryTest();
        }
        applyEditSubModeCamera(this, subMode);
      },
      onEditVariableMutated: (item) => {
        if (this.isFreeCamTrajectoryTesting) {
          this.isFreeCamTrajectoryTesting = false;
          useStaticTrainingPackStore.getState().setFreeCamTrajectoryTesting(false);
        }
        applyStagedShotToArena(this, item, true);
      },
      onResetShotRequested: () => this.reloadCurrentShot(),
    });
  }

  toggleFreeCamTrajectoryTest() {
    if (this.isFreeCamTrajectoryTesting) {
      this.stopFreeCamTrajectoryTest();
      return;
    }
    if (this.isTestingSingleShot) {
      this.isTestingSingleShot = false;
      useStaticTrainingPackStore.getState().setTestingSingleShot(false);
    }
    this.isFreeCamTrajectoryTesting = true;
    useStaticTrainingPackStore.getState().setFreeCamTrajectoryTesting(true);
    launchFreeCamTrajectoryPreview(this);
  }

  stopFreeCamTrajectoryTest() {
    if (!this.isFreeCamTrajectoryTesting) return;
    this.isFreeCamTrajectoryTesting = false;
    useStaticTrainingPackStore.getState().setFreeCamTrajectoryTesting(false);
    const shot = this._getCurrentShotConfig();
    if (shot) {
      applyStagedShotToArena(this, shot, true);
    }
  }

  toggleSingleShotTest() {
    const store = useStaticTrainingPackStore.getState();
    if (this.isTestingSingleShot) {
      this.isTestingSingleShot = false;
      store.setTestingSingleShot(false);
      this.reloadCurrentShot();
    } else {
      if (this.isFreeCamTrajectoryTesting) {
        this.isFreeCamTrajectoryTesting = false;
        store.setFreeCamTrajectoryTesting(false);
      }
      this.isTestingSingleShot = true;
      store.setTestingSingleShot(true);
      this.reloadCurrentShot();
    }
  }

  _getCurrentShotConfig() {
    const store = useStaticTrainingPackStore.getState();
    if (store.sessionMode === 'edit' && store.isEditingItem) {
      const editVar = getActiveEditItemVariable();
      if (editVar) return editVar;
    }
    const pack = store.activePack;
    if (!pack || !Array.isArray(pack.items) || pack.items.length === 0) {
      return null;
    }
    const idx = Math.max(0, Math.min(pack.items.length - 1, store.currentShotIndex));
    return pack.items[idx] || pack.items[0];
  }

  reloadCurrentShot() {
    const r = this.runtime;
    if (!r?.physics) return;

    if (this.isReplayActive) {
      this.replayController?.endReplaySession?.();
      this.isReplayActive = false;
    }
    this.isFreeCamTrajectoryTesting = false;
    this.goalResetTicks = 0;
    this.replayPendingType = 'goal';
    this.isOvertimeWaitingGround = false;
    this.lastTimeoutBeepSec = -1;
    this.hasBallMoved = false;
    this._resetGoalTracking();
    this.replayRingBuffer?.clear?.();
    r.goalReplayCameraOverrideActive = false;

    const store = useStaticTrainingPackStore.getState();
    store.setFreeCamTrajectoryTesting(false);
    this._syncEditBallOpacityOverride(true);
    const shot = this._getCurrentShotConfig();
    if (!shot) return;

    this.stagedShot = shot;
    applyStagedShotToArena(this, shot, false);

    const timeoutSec = Math.max(1, Math.min(60, Number(shot.timeoutSeconds) || 10));
    this.remainingTimeoutTicks = Math.round(timeoutSec * 120);

    const isPlayableSession = store.sessionMode === 'play' || this.isTestingSingleShot;

    if (!isPlayableSession) {
      this.playPhase = 'waiting-input';
      this.countdownTicksRemaining = 0;
      applyEditSubModeCamera(this, store.editSubMode);
      store.updateLiveTelemetry({
        remainingTimeoutSec: timeoutSec,
        activeCountdownSec: 0,
        isShotLaunched: false,
        isOvertimeWaitGround: false,
        isReplayActive: false,
        replayType: null,
      });
    } else {
      if (r.camera?.isFreeCam) {
        r.camera.setFreeCam(false);
      }
      r.camera.ballCam = true;
      r.camera?.resetView?.();

      if (store.downCounterEnabled) {
        const downSec = store.downCounterValue || 1;
        this.playPhase = 'countdown';
        this.countdownTicksRemaining = (downSec + 1) * 120;
        this.lastCountdownBeepSec = -1;
      } else {
        this.playPhase = 'waiting-input';
        this.countdownTicksRemaining = 0;
        this.lastCountdownBeepSec = -1;
      }

      store.updateLiveTelemetry({
        remainingTimeoutSec: timeoutSec,
        activeCountdownSec: store.downCounterEnabled ? store.downCounterValue : 0,
        isShotLaunched: false,
        isOvertimeWaitGround: false,
        isReplayActive: false,
        replayType: null,
      });
    }

    if (r.match?.state) {
      r.match.state.phase = 'playing';
    }
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      kickoffCountdown: 0,
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

  _hasPlayerDrivingInput(ctrl) {
    if (!ctrl) return false;
    return (
      Math.abs(ctrl.throttle || 0) > 0.05 ||
      Math.abs(ctrl.steer || 0) > 0.05 ||
      Math.abs(ctrl.pitch || 0) > 0.05 ||
      Math.abs(ctrl.yaw || 0) > 0.05 ||
      Math.abs(ctrl.roll || 0) > 0.05 ||
      Boolean(ctrl.jump) ||
      Boolean(ctrl.boost) ||
      Boolean(ctrl.handbrake)
    );
  }

  onPhysicsEvent(event) {
    if (!event || this.isReplayActive) return;
    const currentTick = Math.floor(this.runtime?.physics?.getHeaderView?.()?.tickCount ?? 0);
    const eventTick = typeof event.tick === 'number' && event.tick > 0 ? event.tick : currentTick;

    if (this.replayRingBuffer && this.playPhase === 'live') {
      this.replayRingBuffer.appendIncident(eventTick, event);
    }

    if (event.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || event.type === 0x01) {
      this.kickoffBallFrozen = false;
      this.hasBallMoved = true;
      if (this.goalIncidentTick < 0 || eventTick <= this.goalIncidentTick) {
        this.lastTouchTick = Math.floor(eventTick);
      }
    }
  }

  onBeforePhysicsTick() {
    const r = this.runtime;
    const sim = r?.physics;
    if (!sim || this.isReplayActive || r.isPaused) return false;

    const store = useStaticTrainingPackStore.getState();

    // Edit Mode: only step physics during Free-Cam [T] trajectory test or [G] single-shot test
    if (store.sessionMode === 'edit' && !this.isTestingSingleShot) {
      if (this.isFreeCamTrajectoryTesting) {
        sim.setControls?.(0, {
          throttle: 0,
          steer: 0,
          pitch: 0,
          yaw: 0,
          roll: 0,
          jump: false,
          boost: false,
          handbrake: false,
        });
        if (this.kickoffBallFrozen && this.stagedShot) {
          const bLoc = this.stagedShot.ball.location || this.stagedShot.ball.pos || [0, 0, BALL_GROUND_MIN_Z];
          const cv = sim.getCarStateView?.(0);
          if (cv) {
            const dist = Math.hypot(cv.posX - bLoc[0], cv.posY - bLoc[1], cv.posZ - bLoc[2]);
            if (dist <= 182.0) {
              this.kickoffBallFrozen = false;
            } else {
              sim.setBallState({
                pos: [bLoc[0], bLoc[1], Math.max(BALL_GROUND_MIN_Z, bLoc[2])],
                vel: [0, 0, 0],
                angVel: [0, 0, 0],
              });
            }
          }
        }
        return true;
      }
      return false;
    }

    // Play Mode (or [G] single-shot test): Down Counter pre-roll
    if (this.playPhase === 'countdown') {
      this.countdownTicksRemaining = Math.max(0, this.countdownTicksRemaining - 1);
      const downSec = store.downCounterValue || 1;
      const audio = r?.options?.gameAudio || r?.audioSubsystem?.audio || r?.audio || gameAudio;

      if (this.countdownTicksRemaining <= 0) {
        audio?.play?.('match_start_go', 1.0, 180);
        this.lastCountdownBeepSec = -1;
        launchStaticTrainingShotNow(this);
        if (r.playerControls) {
          sim.setControls?.(0, r.playerControls);
        }
        return true;
      }

      const remSec = Math.ceil(this.countdownTicksRemaining / 120);
      if (remSec >= 1 && remSec <= downSec && remSec !== this.lastCountdownBeepSec) {
        this.lastCountdownBeepSec = remSec;
        audio?.play?.('training_countdown', 1.0, 180);
      }
      if (this.countdownTicksRemaining % 12 === 0) {
        store.updateLiveTelemetry({
          activeCountdownSec: Math.min(downSec, remSec),
        });
      }
      return false;
    }

    // Play Mode: Waiting for initial user driving input (when Down Counter is OFF)
    if (this.playPhase === 'waiting-input') {
      if (this._hasPlayerDrivingInput(r.playerControls)) {
        launchStaticTrainingShotNow(this);
        sim.setControls?.(0, r.playerControls);
        return true;
      }
      return false;
    }

    // Release kickoffState ball if car gets within contact proximity before step
    if (this.kickoffBallFrozen && this.stagedShot) {
      const bLoc = this.stagedShot.ball.location || this.stagedShot.ball.pos || [0, 0, BALL_GROUND_MIN_Z];
      const cv = sim.getCarStateView?.(0);
      if (cv) {
        const dist = Math.hypot(cv.posX - bLoc[0], cv.posY - bLoc[1], cv.posZ - bLoc[2]);
        if (dist <= 182.0) {
          this.kickoffBallFrozen = false;
          this.hasBallMoved = true;
        } else {
          sim.setBallState({
            pos: [bLoc[0], bLoc[1], Math.max(BALL_GROUND_MIN_Z, bLoc[2])],
            vel: [0, 0, 0],
            angVel: [0, 0, 0],
          });
        }
      }
    }

    return true;
  }

  onAfterPhysicsTick() {
    const r = this.runtime;
    const sim = r?.physics;
    if (!sim || this.isReplayActive) return;

    const store = useStaticTrainingPackStore.getState();
    if (store.sessionMode === 'edit' && this.isFreeCamTrajectoryTesting) {
      // During Free-Cam [T] trajectory preview, no timer or goal/expire triggers run
      return;
    }
    if (store.sessionMode !== 'play' && !this.isTestingSingleShot) return;
    if (this.playPhase !== 'live' && this.playPhase !== 'goal') return;

    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const bView = sim.getBallStateView?.();
    const cv = sim.getCarStateView?.(0);

    // Maintain kickoffState stationary mid-air lock until touched
    if (this.kickoffBallFrozen && this.stagedShot && bView && cv) {
      const bLoc = this.stagedShot.ball.location || this.stagedShot.ball.pos || [0, 0, BALL_GROUND_MIN_Z];
      const dist = Math.hypot(cv.posX - bLoc[0], cv.posY - bLoc[1], cv.posZ - bLoc[2]);
      const speedMag = Math.hypot(bView.velX, bView.velY, bView.velZ);
      if (dist <= 175.0 || speedMag > 35.0) {
        this.kickoffBallFrozen = false;
        this.hasBallMoved = true;
        this.lastTouchTick = currentTick;
      } else {
        sim.setBallState({
          pos: [bLoc[0], bLoc[1], Math.max(BALL_GROUND_MIN_Z, bLoc[2])],
          vel: [0, 0, 0],
          angVel: [0, 0, 0],
        });
      }
    }

    // Track car-ball touch
    if (this.goalResetTicks === 0 && bView && cv && !cv.isDemoed) {
      const dvX = bView.velX - this.prevBallVelX;
      const dvY = bView.velY - this.prevBallVelY;
      const dvZ = bView.velZ - (this.prevBallVelZ - 650.0 / 120.0);
      const impulseMag = Math.hypot(dvX, dvY, dvZ);
      const dist = Math.hypot(cv.posX - bView.posX, cv.posY - bView.posY, cv.posZ - bView.posZ);

      if (dist <= 168.0 || (dist <= 198.0 && impulseMag > 25.0)) {
        this.lastTouchTick = currentTick;
        this.kickoffBallFrozen = false;
        this.hasBallMoved = true;
      }

      this.prevBallVelX = bView.velX;
      this.prevBallVelY = bView.velY;
      this.prevBallVelZ = bView.velZ;
    }

    if (!this.kickoffBallFrozen && bView) {
      const ballSpeedNow = Math.hypot(bView.velX, bView.velY, bView.velZ);
      if (ballSpeedNow > 8.0 || this.lastTouchTick >= 0) {
        this.hasBallMoved = true;
      }
    }

    // Freeze ball in net after goal delay (only for actual goals, not shot expiration)
    if (
      this.goalResetTicks > 0 &&
      this.replayPendingType === 'goal' &&
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

    // Record compact snapshot into ring buffer continuously
    this.replayRingBuffer.recordFrame(currentTick, sim.state);

    // Advance post-goal or post-expire 3-second countdown -> Replay
    if (this.goalResetTicks > 0) {
      this.goalResetTicks--;
      if (this.goalResetTicks <= 0) {
        beginStaticTrainingReplaySession(this, this.replayPendingType || 'goal');
      }
      return;
    }

    // 1. Check Goal Scored
    const hasBarrierOnGoal = Boolean(bView && sim.hasActiveGoalBarrier?.(bView.posY));
    const goalYThreshold = hasBarrierOnGoal ? 5120 + 88 : 5120;
    const goalScored =
      bView &&
      Math.abs(bView.posY) > goalYThreshold &&
      Math.abs(bView.posX) < 893 &&
      bView.posZ < 643;

    const audio = r?.options?.gameAudio || r?.audioSubsystem?.audio || r?.audio || gameAudio;

    if (goalScored) {
      const blueScored = bView.posY > 0;
      const scoringTeam = blueScored ? 0 : 1;
      const ballSpeedUu = Math.hypot(bView.velX, bView.velY, bView.velZ);
      const ballSpeedKph = Math.max(1, Math.round(ballSpeedUu * 0.036));

      this.goalIncidentTick = currentTick;
      this.goalScoringTeam = scoringTeam;
      this.goalScorerCarIndex = 0;
      this.goalScorerName = 'Player';
      this.goalBallSpeedKph = ballSpeedKph;
      this.frozenGoalBallState = null;
      this.playPhase = 'goal';
      this.replayPendingType = 'goal';

      this.replayRingBuffer.appendIncident(currentTick, {
        type: INCIDENT_EVENT_TYPES.GOAL_SCORED,
        tick: currentTick,
        carIndex: 0,
        team: scoringTeam,
        posX: bView.posX,
        posY: bView.posY,
        posZ: bView.posZ,
        intensity: ballSpeedUu,
      });
      this.replayRingBuffer.appendAudioEvent(currentTick, {
        cueId: 'sfx_goal_poof',
        cueName: 'sfx_goal_poof',
        volume: 1.0,
      });

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
      return;
    }

    // 2. Advance Shot Timeout (with 4, 3, 2, 1s practice countdown audio) & Overtime Ground Check
    if (this.remainingTimeoutTicks > 0) {
      this.remainingTimeoutTicks--;
      if (this.remainingTimeoutTicks > 0) {
        const remSecCeil = Math.ceil(this.remainingTimeoutTicks / 120);
        if (remSecCeil >= 1 && remSecCeil <= 4 && remSecCeil !== this.lastTimeoutBeepSec) {
          this.lastTimeoutBeepSec = remSecCeil;
          audio?.play?.('training_countdown', 1.0, 180);
          this.replayRingBuffer.appendAudioEvent(currentTick, {
            cueId: 'training_countdown',
            cueName: 'training_countdown',
            volume: 1.0,
          });
        }
      }
      if (this.remainingTimeoutTicks % 12 === 0 || this.remainingTimeoutTicks === 0) {
        store.updateLiveTelemetry({
          remainingTimeoutSec: Number((this.remainingTimeoutTicks / 120).toFixed(1)),
        });
      }
    }

    if (this.remainingTimeoutTicks <= 0 && bView) {
      const ballSpeed = Math.hypot(bView.velX, bView.velY, bView.velZ);
      const isBallTouchingGround =
        bView.posZ <= BALL_GROUND_MIN_Z + 5.5 ||
        Boolean(sim.getBallOnGround?.());
      const isBallUntouched = Boolean(
        this.kickoffBallFrozen || (!this.hasBallMoved && this.lastTouchTick < 0)
      );

      if (isBallUntouched || isBallTouchingGround) {
        this.isOvertimeWaitingGround = false;
        this.goalIncidentTick = currentTick;
        this.goalScoringTeam = bView.posY >= 0 ? 0 : 1;
        this.goalScorerCarIndex = 0;
        this.goalScorerName = 'SHOT EXPIRED';
        this.goalBallSpeedKph = Math.round(ballSpeed * 0.036);
        this.frozenGoalBallState = null;
        this.playPhase = 'goal';
        this.replayPendingType = 'expire';

        this.replayRingBuffer.appendAudioEvent(currentTick, {
          cueId: 'training_ball_expire',
          cueName: 'training_ball_expire',
          volume: 1.0,
        });
        audio?.play?.('training_ball_expire', 1.0, 250);

        this.goalResetTicks = POST_EXPIRE_CELEBRATION_TICKS;
        if (r?.match?.state) {
          r.match.state.phase = 'goal';
        }

        hudStore.getState().setMatchState({
          matchPhase: 'goal',
          replayScorerName: this.goalScorerName,
          replayScorerTeam: this.goalScoringTeam,
          replayBallSpeedKph: this.goalBallSpeedKph,
          replayAssistName: null,
        });
      } else if (!this.isOvertimeWaitingGround) {
        this.isOvertimeWaitingGround = true;
        store.updateLiveTelemetry({ isOvertimeWaitGround: true });
      }
    }
  }

  skipGoalReplay() {
    if (!this.isReplayActive && this.goalResetTicks <= 0) return;
    this.goalResetTicks = 0;
    completeStaticTrainingReplayAndAdvanceNextShot(this);
  }

  update(context) {
    const dt = context.dt ?? 0.016;
    const store = useStaticTrainingPackStore.getState();
    this._syncEditBallOpacityOverride();

    // 1. Handle active Goal / Expire Replay
    if (this.isReplayActive && this.replayController.isActive) {
      stepStaticTrainingReplayUpdate(this, context, dt);
      return;
    }

    // 2. Edit Mode continuous movement + visual spin (unless in [G] single-shot playable test)
    if (store.sessionMode === 'edit' && !this.isTestingSingleShot) {
      updateEditorCameraAndContinuousInputs(this, dt);
      if (!this.isFreeCamTrajectoryTesting) {
        spinBallMeshInPlace(this, dt);
      }
      const shot = this._getCurrentShotConfig();
      if (this.visuals && shot) {
        this.visuals.update(shot, store.editSubMode, false);
      }
      return;
    }

    // 3. Play Mode (or [G] single-shot test) pre-launch & live visual updates
    const isPreLaunch = this.playPhase === 'countdown' || this.playPhase === 'waiting-input';
    if (isPreLaunch) {
      spinBallMeshInPlace(this, dt);
    }

    if (this.visuals && this.stagedShot) {
      if (isPreLaunch) {
        this.visuals.update(this.stagedShot, 'play', true);
      } else {
        this.visuals.setVisible(false);
      }
    }

    const { playerCarView } = context;
    if (playerCarView) {
      hudStore.getState().setBoost(
        playerCarView.boost,
        playerCarView.isBoosting,
        Boolean(this.stagedShot?.car?.unlimitedBoost)
      );
    }
  }

  onResetKickoff() {
    this.reloadCurrentShot();
  }
}
