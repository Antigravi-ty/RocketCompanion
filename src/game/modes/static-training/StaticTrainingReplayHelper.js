/**
 * StaticTrainingReplayHelper.js
 * Goal Replay & Shot Expiration Replay session management for StaticTrainingPackMode.
 * - Both Goal and Expire give a 3.0s (360 ticks @ 120Hz) post-incident delay ("Goal Replay will start").
 * - Expire Replay looks back up to 10.0s (1200 ticks), disables all slow-motion, and watches all touches.
 */

import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.js';
import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.js';
import { applyDirectorReplayCamera } from '../../../replay/ReplayDirectorCamera.js';
import { dispatchReplayFrameEvents } from '../../../replay/ReplayTimelineController.js';
import { useStaticTrainingPackStore } from '../../../ui-core/stores/staticTrainingPackStore';
import { hudStore } from '../../../ui-core/stores/hudStore';

export const POST_GOAL_CELEBRATION_TICKS = 360; // 3.0s @ 120Hz
export const POST_EXPIRE_CELEBRATION_TICKS = 360; // 3.0s @ 120Hz
export const POST_GOAL_FREEZE_DELAY_TICKS = 30;
export const EXPIRE_REPLAY_LOOKBACK_TICKS = 1200; // Up to 10.0s @ 120Hz

export function beginStaticTrainingReplaySession(mode, type = 'goal') {
  const r = mode.runtime;
  const sim = r?.physics;
  if (!sim || !mode.replayRingBuffer || mode.replayRingBuffer.size === 0) {
    completeStaticTrainingReplayAndAdvanceNextShot(mode);
    return;
  }

  mode.replayType = type;
  const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);

  if (mode.replayController.engine !== sim) {
    mode.replayController.attach(sim, mode.replayRingBuffer);
  }

  let extractedFrames = [];
  if (type === 'expire') {
    const expireTick = mode.goalIncidentTick > 0 ? mode.goalIncidentTick : currentTick;
    const startTick = Math.max(
      mode.lastKickoffStartTick,
      expireTick - EXPIRE_REPLAY_LOOKBACK_TICKS
    );
    extractedFrames = mode.replayRingBuffer.getFramesInTickRange
      ? mode.replayRingBuffer.getFramesInTickRange(startTick, currentTick)
      : mode.replayRingBuffer.extractRange(startTick, currentTick);
  } else {
    const goalTick = mode.goalIncidentTick > 0 ? mode.goalIncidentTick : currentTick;
    const postGoalTicks = Math.max(0, currentTick - goalTick);
    extractedFrames = extractGoalReplayFrames({
      ringBuffer: mode.replayRingBuffer,
      engine: null,
      goalIncidentTick: goalTick,
      scorerTouchTick: mode.lastTouchTick,
      lookbackSeconds: 8.0,
      touchLookbackSeconds: 6.0,
      postGoalTicks,
      lastKickoffWillStartTick: mode.lastKickoffStartTick,
    });
  }

  if (!Array.isArray(extractedFrames) || extractedFrames.length === 0) {
    completeStaticTrainingReplayAndAdvanceNextShot(mode);
    return;
  }

  const totalFrames = mode.replayController.beginReplaySession({
    scoringTeam: mode.goalScoringTeam,
    scorerCarIndex: mode.goalScorerCarIndex,
    carTeamResolver: () => mode.goalScoringTeam,
    frames: extractedFrames,
    disableSlowMo: type === 'expire',
    watchAllTouches: type === 'expire',
  });

  mode.isReplayActive = true;
  mode.playPhase = 'replay';
  mode.replayCameraMode = 'director';
  mode.goalResetTicks = 0;

  if (r?.match?.state) {
    r.match.state.phase = 'replay';
  }
  r.goalReplayCameraOverrideActive = true;

  const firstSnap = extractedFrames[0].snapshot;
  applyReplayFrameToEngine(sim, firstSnap, r.interpolator, firstSnap, 1.0);
  applyDirectorReplayCamera(
    r.camera,
    r.interpolator,
    0,
    mode.goalScoringTeam,
    0.016,
    mode.goalScorerCarIndex,
    mode.replayController.directorCameraState
  );

  useStaticTrainingPackStore.getState().updateLiveTelemetry({
    isReplayActive: true,
    replayType: type,
    isOvertimeWaitGround: false,
  });

  hudStore.getState().setMatchState({
    matchPhase: 'replay',
    replayScorerName: mode.goalScorerName,
    replayScorerTeam: mode.goalScoringTeam,
    replayBallSpeedKph: mode.goalBallSpeedKph,
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
    replayScorerName: mode.goalScorerName,
    replayScorerTeam: mode.goalScoringTeam,
    replayBallSpeedKph: mode.goalBallSpeedKph,
    replayAssistName: null,
    onReplaySeekNormalized: (norm) => {
      if (!mode.replayController.isActive) return;
      mode.replayController.isPersistent = true;
      mode.replayController.seekToNormalized(norm, r.interpolator);
      if (mode.replayCameraMode === 'director') {
        applyDirectorReplayCamera(
          r.camera,
          r.interpolator,
          mode.replayController.progress,
          mode.goalScoringTeam,
          0.016,
          mode.goalScorerCarIndex,
          mode.replayController.directorCameraState
        );
      }
      hudStore.getState().setReplayState({
        replayProgress: mode.replayController.progress,
        replayFrameIndex: mode.replayController.currentFrameIndex,
        replayPaused: mode.replayController.isPaused,
        replayPersistent: true,
      });
    },
    onReplayTogglePause: () => {
      if (!mode.replayController.isActive) return;
      const paused = mode.replayController.togglePause();
      hudStore.getState().setReplayState({
        replayPaused: paused,
        replayPersistent: mode.replayController.isPersistent,
      });
    },
    onReplayCycleSpeed: () => {
      if (!mode.replayController.isActive) return;
      const speed = mode.replayController.cyclePlaybackSpeed();
      hudStore.getState().setReplayState({ replaySpeed: speed });
    },
    onReplayToggleCameraMode: () => {
      if (!mode.replayController.isActive) return;
      mode.replayCameraMode = mode.replayCameraMode === 'director' ? 'pov' : 'director';
      if (mode.replayCameraMode === 'director') {
        r.goalReplayCameraOverrideActive = true;
        mode.replayController.directorCameraState.initialized = false;
        applyDirectorReplayCamera(
          r.camera,
          r.interpolator,
          mode.replayController.progress,
          mode.goalScoringTeam,
          0.016,
          mode.goalScorerCarIndex,
          mode.replayController.directorCameraState
        );
      } else {
        r.goalReplayCameraOverrideActive = false;
        r.camera?.resetView?.();
      }
      hudStore.getState().setReplayState({ replayCameraMode: mode.replayCameraMode });
    },
  });
}

export function completeStaticTrainingReplayAndAdvanceNextShot(mode) {
  const r = mode.runtime;
  mode.replayController?.endReplaySession?.();
  mode.isReplayActive = false;
  mode.goalResetTicks = 0;

  if (r) {
    r.goalReplayCameraOverrideActive = false;
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

  // If testing a single shot via [G] in Edit Mode, stay on this single shot
  if (mode.isTestingSingleShot) {
    mode.reloadCurrentShot();
    return;
  }

  // Otherwise advance to next shot (wrapping from last to first)
  useStaticTrainingPackStore.getState().nextShot();
}

export function stepStaticTrainingReplayUpdate(mode, context, dt) {
  const r = mode.runtime;
  mode.visuals?.setVisible(false);
  const stepRes = mode.replayController.stepPlayback(dt, r.interpolator, true);
  dispatchReplayFrameEvents(stepRes, r);

  if (mode.replayCameraMode === 'director') {
    r.goalReplayCameraOverrideActive = true;
    applyDirectorReplayCamera(
      r.camera,
      r.interpolator,
      stepRes.progress,
      mode.goalScoringTeam,
      dt,
      mode.goalScorerCarIndex,
      mode.replayController.directorCameraState
    );
  } else {
    r.goalReplayCameraOverrideActive = false;
  }

  const scorerCarView = r.interpolator?.getCurrCarStateView(0);
  context.activeCar = 0;
  context.activeCarMesh = r.arena?.cars?.[0];
  context.playerCarView = scorerCarView;
  context.isSupersonic = Boolean(scorerCarView?.isSupersonic && !scorerCarView?.isDemoed);
  context.curBoost = scorerCarView?.boost ?? 0;

  if (scorerCarView) {
    hudStore.getState().setBoost(
      scorerCarView.boost,
      scorerCarView.isBoosting,
      Boolean(mode.stagedShot?.car?.unlimitedBoost)
    );
  }

  const remainingFrames = Math.max(0, (stepRes.totalFrames || 0) - (stepRes.frameIndex || 0));
  if (
    !mode.replayController.isPaused &&
    !mode.replayController.isPersistent &&
    stepRes.totalFrames > 0 &&
    remainingFrames <= 78
  ) {
    hudStore.getState().setChoreographySignal('goal-replay-will-end');
  }

  hudStore.getState().setReplayState({
    replayProgress: stepRes.progress,
    replayFrameIndex: stepRes.frameIndex,
    replayTotalFrames: stepRes.totalFrames,
    replayPaused: mode.replayController.isPaused,
    replayPersistent: mode.replayController.isPersistent,
    replayCameraMode: mode.replayCameraMode,
    replaySpeed: mode.replayController.playbackSpeed,
  });

  if (
    stepRes.isFinished &&
    !mode.replayController.isPaused &&
    !mode.replayController.isPersistent
  ) {
    completeStaticTrainingReplayAndAdvanceNextShot(mode);
  }
}
