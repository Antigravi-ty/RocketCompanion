/**
 * ExpMultiBotReplayHelper.js
 * Goal Replay, Match Replay Retention, and Podium End-of-Match transitions
 * for ExperimentalMultiBotsMode.
 */

import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.js';
import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.js';
import { applyDirectorReplayCamera } from '../../../replay/ReplayDirectorCamera.js';
import { dispatchReplayFrameEvents } from '../../../replay/ReplayTimelineController.js';
import { MATCH_SIGNALS } from '../../../physics/RocketSimConstants.js';
import { retainCompletedMatchReplayAndNotify } from '../../../replay/ReplayFileExporter.js';
import { useExperimentalMultiBotsStore } from '../../../ui-core/stores/experimentalMultiBotsStore';
import { hudStore } from '../../../ui-core/stores/hudStore';
import { getExpModeAudio, getExpCarDisplayName } from './ExperimentalMultiBotsRosterHelper.js';

export const POST_GOAL_CELEBRATION_TICKS = 180; // 1.5s @ 120Hz
export const POST_GOAL_FREEZE_DELAY_TICKS = 30; // 0.25s ball flight into net before freeze
export const MAX_GOAL_LOOKBACK_SECONDS = 10.0; // Max 10s before goal (1200 ticks @ 120Hz)
export const SCORER_TOUCH_LOOKBACK_SECONDS = 7.0; // Max 7s before scorer's last touch (840 ticks @ 120Hz)

export function retainExpMatchReplayAndNotify(mode, winnerTeam) {
  const simState = mode.runtime?.physics?.state || null;
  if ((!mode.replayRingBuffer || mode.replayRingBuffer.size === 0) && !simState) return;
  const blueCount = mode.spawnedCars.filter((c) => c.team === 0).length || 1;
  const orangeCount = mode.spawnedCars.filter((c) => c.team === 1).length || 1;
  const roster = Array.isArray(mode.spawnedCars)
    ? mode.spawnedCars.map((c) => ({
        carIndex: c.carIndex,
        team: c.team,
        name: c.name || getExpCarDisplayName(c, mode.spawnedCars),
        isPlayer: Boolean(c.isPlayer),
        botType: c.botType || null,
        visualId: c.visualId || 'octane',
        hitboxId: c.hitboxId || 'hitbox-octane',
        colorSlot: c.colorSlot ?? (c.team === 0 ? 3 : 0),
        colorHex: c.colorHex || null,
        paintFinish: c.paintFinish || 'metallic',
        boostVisual: c.boostVisual || 'cartoon',
        boostAudio: c.boostAudio || 'rush',
      }))
    : [];
  retainCompletedMatchReplayAndNotify({
    ringBuffer: mode.replayRingBuffer,
    fallbackState: simState,
    winnerTeam,
    blueScore: mode.blueScore,
    orangeScore: mode.orangeScore,
    gameMode: `${blueCount}v${orangeCount}`,
    durationSeconds: mode.configuredDuration ?? 300,
    roster,
    loadouts: roster,
  });
}

export function finishExpMultiBotMatch(mode, winnerTeam) {
  const r = mode.runtime;
  const store = useExperimentalMultiBotsStore.getState();
  const audio = getExpModeAudio(r);

  mode._emitReplaySignal?.(MATCH_SIGNALS.MATCH_ENDED, winnerTeam, 0);
  mode._emitReplaySignal?.(MATCH_SIGNALS.PODIUM_START, winnerTeam, 0);
  retainExpMatchReplayAndNotify(mode, winnerTeam);

  mode.isReplayActive = false;
  mode.isMatchEnded = true;
  mode.isOvertime = false;
  mode.goalResetTicks = 0;
  mode.pendingMatchEndAfterReplay = false;
  mode.matchPhase = winnerTeam === 0 ? 'MATCH END (BLUE WINS)' : 'MATCH END (ORANGE WINS)';

  if (r) {
    r.goalReplayCameraOverrideActive = false;
    r.podiumController = mode.podiumController;
  }

  if (r?.match?.state) {
    r.match.state.phase = 'podium';
    r.match.state.winner = winnerTeam;
  }

  audio?.play?.('endgame', 1.0);
  mode.podiumController?.enterPodium?.(winnerTeam, 'SCORE');

  store.updateLiveTelemetry({
    matchPhase: mode.matchPhase,
    isOvertime: false,
  });
  hudStore.getState().setMatchState({
    matchPhase: 'podium',
    isOvertime: false,
    winner: winnerTeam,
    winReason: 'SCORE',
  });
}

export function beginExpMultiBotGoalReplay(mode) {
  const r = mode.runtime;
  const sim = r?.physics;
  const store = useExperimentalMultiBotsStore.getState();
  if (!sim || !mode.replayRingBuffer || mode.replayRingBuffer.size === 0) {
    completeExpPostGoalOrReplayTransition(mode);
    return;
  }

  const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
  const goalTick = mode.goalIncidentTick > 0 ? mode.goalIncidentTick : currentTick;
  const postGoalTicks = Math.max(0, currentTick - goalTick);
  mode._emitReplaySignal?.(
    MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
    mode.goalScoringTeam ?? 0,
    mode.goalScorerCarIndex ?? 0,
    currentTick
  );

  if (mode.replayController.engine !== sim) {
    mode.replayController.attach(sim, mode.replayRingBuffer);
  }

  const extractedFrames = extractGoalReplayFrames({
    ringBuffer: mode.replayRingBuffer,
    engine: null, // Strictly use 448-float ReplayRingBuffer
    goalIncidentTick: goalTick,
    scorerTouchTick: mode.goalScorerTouchTick,
    lookbackSeconds: MAX_GOAL_LOOKBACK_SECONDS,
    touchLookbackSeconds: SCORER_TOUCH_LOOKBACK_SECONDS,
    postGoalTicks,
    lastKickoffWillStartTick: mode.lastKickoffStartTick,
  });

  if (!Array.isArray(extractedFrames) || extractedFrames.length === 0) {
    completeExpPostGoalOrReplayTransition(mode);
    return;
  }

  const totalFrames = mode.replayController.beginReplaySession({
    scoringTeam: mode.goalScoringTeam,
    scorerCarIndex: mode.goalScorerCarIndex,
    carTeamResolver: (c) => {
      const entry = mode.spawnedCars.find((e) => e.carIndex === c);
      return entry ? entry.team : c % 2;
    },
    frames: extractedFrames,
  });

  if (Array.isArray(mode.spawnedCars) && mode.spawnedCars.length > 0) {
    mode.replayController.carEntries = mode.spawnedCars.map((c) => {
      const displayName = c.name || getExpCarDisplayName(c, mode.spawnedCars);
      return {
        carIndex: c.carIndex,
        name: displayName,
        username: displayName,
        team: c.team === 1 ? 1 : 0,
        isBot: !c.isPlayer,
        isLocalPlayer: Boolean(c.isPlayer),
      };
    });
  }

  mode.isReplayActive = true;
  mode.replayCameraMode = 'director';
  mode.replayPovCarIndex = mode.goalScorerCarIndex;
  mode.goalResetTicks = 0;
  mode.matchPhase = 'replay';

  if (r?.match?.state) {
    r.match.state.phase = 'replay';
  }

  mode._applyCameraCarIndex(mode.goalScorerCarIndex);
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

  store.updateLiveTelemetry({
    matchPhase: 'GOAL REPLAY',
    activeCameraCarIndex: mode.goalScorerCarIndex,
  });

  hudStore.getState().setMatchState({
    matchPhase: 'replay',
    choreographySignal: 'goal-replay-started',
    replayScorerName: mode.goalScorerName,
    replayScorerTeam: mode.goalScoringTeam,
    replayBallSpeedKph: mode.goalBallSpeedKph,
    replayAssistName: mode.goalAssistName,
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
    replayAssistName: mode.goalAssistName,
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
    onReplaySelectPovCar: (carIdx) => {
      if (!mode.replayController.isActive) return;
      if (typeof carIdx === 'number' && carIdx >= 0) {
        mode.replayCameraMode = 'pov';
        mode.replayPovCarIndex = carIdx;
        r.goalReplayCameraOverrideActive = false;
        mode._applyCameraCarIndex(carIdx);
        r.camera?.resetView?.();
        store.setActiveCameraCarIndex(carIdx);
        hudStore.getState().setReplayState({ replayCameraMode: 'pov' });
      } else {
        mode.replayCameraMode = 'director';
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
        hudStore.getState().setReplayState({ replayCameraMode: 'director' });
      }
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
        const povIdx =
          typeof mode.replayPovCarIndex === 'number'
            ? mode.replayPovCarIndex
            : mode.goalScorerCarIndex;
        mode._applyCameraCarIndex(povIdx);
        r.camera?.resetView?.();
      }
      hudStore.getState().setReplayState({ replayCameraMode: mode.replayCameraMode });
    },
  });
}

export function completeExpPostGoalOrReplayTransition(mode) {
  const r = mode.runtime;
  mode.replayController?.endReplaySession?.();
  mode.isReplayActive = false;
  if (r) {
    r.goalReplayCameraOverrideActive = false;
  }
  hudStore.getState().setReplayState({
    replayPaused: false,
    replayPersistent: false,
    onReplaySelectPovCar: null,
  });

  const restoreCamIdx =
    mode.humanPlayerCarIndex >= 0
      ? mode.humanPlayerCarIndex
      : Math.max(
          0,
          Math.min(
            mode.spawnedCars.length - 1,
            useExperimentalMultiBotsStore.getState().activeCameraCarIndex
          )
        );
  mode._applyCameraCarIndex(restoreCamIdx);

  if (mode.pendingMatchEndAfterReplay) {
    const winner = mode.pendingMatchWinner ?? (mode.blueScore >= mode.orangeScore ? 0 : 1);
    finishExpMultiBotMatch(mode, winner);
    return;
  }

  mode._resetMultiCarKickoffSpawns();
  mode._beginKickoffCountdown();
}

export function stepExpMultiBotReplayUpdate(mode, context, unlimited) {
  const r = mode.runtime;
  const dt = context.dt ?? 0.016;
  const stepRes = mode.replayController.stepPlayback(dt, r.interpolator, true);
  dispatchReplayFrameEvents(stepRes, r);

  const povCarIdx =
    mode.replayCameraMode === 'pov' && typeof mode.replayPovCarIndex === 'number'
      ? mode.replayPovCarIndex
      : mode.goalScorerCarIndex;
  mode._applyCameraCarIndex(povCarIdx);
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

  for (const entry of mode.spawnedCars) {
    const cv = r.interpolator?.getCurrCarStateView(entry.carIndex);
    if (cv) {
      const fwdSpeed = cv.velX * cv.fwdX + cv.velY * cv.fwdY + cv.velZ * cv.fwdZ;
      mode.carControlsMap.set(entry.carIndex, {
        throttle: Math.abs(fwdSpeed) > 25 ? (fwdSpeed > 0 ? 1 : -1) : 0,
        steer: 0,
        pitch: 0,
        yaw: 0,
        roll: 0,
        jump: Boolean(cv.isJumping),
        boost: Boolean(cv.isBoosting),
        handbrake: false,
      });
    }
  }

  const activeReplayCarView = r.interpolator?.getCurrCarStateView(povCarIdx);
  context.activeCar = povCarIdx;
  context.activeCarMesh = r.arena?.cars?.[povCarIdx];
  context.playerCarView = activeReplayCarView;
  context.isSupersonic = Boolean(activeReplayCarView?.isSupersonic && !activeReplayCarView?.isDemoed);
  context.curBoost = activeReplayCarView?.boost ?? 0;

  if (activeReplayCarView) {
    hudStore.getState().setBoost(activeReplayCarView.boost, activeReplayCarView.isBoosting, unlimited);
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
    completeExpPostGoalOrReplayTransition(mode);
  }
}
