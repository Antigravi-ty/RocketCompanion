/**
 * SubsystemIsolationLabGoalReplayHelper.js
 * Bench 5: Goal Incident Event, Goal Replay Window Clamping & Podium Celebration Test Helper.
 *
 * Tests:
 * 1. Adjustable Pre-Goal Lookback Seconds (before the Goal Incident Event) and Post-Goal Window Seconds
 *    (after the Goal Incident Event, default 3.0s matching SIGNAL_GOAL_REPLAY_WILL_START).
 * 2. Kickoff Minimum Time Clamping Rule:
 *    effectiveStartFrame = Math.max(goalIncidentFrame - lookbackTicks, lastKickoffWillStartFrame)
 *    If a goal is scored shortly after KICKOFF_WILL_START (e.g. <5s), the replay window never rewinds
 *    past the most recent KICKOFF_WILL_START signal frame (follows the larger frame ID / shorter duration).
 * 3. Match Replay JSON Export from the active ReplayRingBuffer & WASM 256MB Replay Buffer.
 * 4. Post-Match Podium Celebration Showcase testing (Blue Wins / Orange Wins / Draw).
 */

import { MATCH_SIGNALS } from '../../../physics/RocketSimConstants.js';
import {
  ReplayRingBuffer,
  REPLAY_BUFFER_MODES,
} from '../../../replay/ReplayRingBuffer.js';
import { ReplayTimelineController } from '../../../replay/ReplayTimelineCore.js';
import {
  resolveGoalReplayWindowBounds,
  extractGoalReplayFrames,
} from '../../../replay/ReplayPlaybackState.js';
import { applyDirectorReplayCamera } from '../../../replay/ReplayDirectorCamera.js';
import { PodiumCelebrationController } from '../PodiumCelebrationController.js';
import { parkDevTestLabProbes } from './SubsystemIsolationLabProbesHelper.js';
import { useSubsystemIsolationLabStore } from '../../../ui-core/stores/subsystemIsolationLabStore';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.js';

function getAudio(runtime) {
  return runtime?.options?.gameAudio || gameAudio;
}

export function ensureGoalReplayTestBenchState(mode) {
  const r = mode.runtime;
  if (!mode.goalReplayRingBuffer) {
    mode.goalReplayRingBuffer = new ReplayRingBuffer({
      mode: REPLAY_BUFFER_MODES.COUNTDOWN_MATCH,
    });
  }
  if (!mode.goalReplayTimelineController) {
    mode.goalReplayTimelineController = new ReplayTimelineController({
      engine: r?.physics || null,
      ringBuffer: mode.goalReplayRingBuffer,
    });
  } else if (r?.physics && mode.goalReplayTimelineController.engine !== r.physics) {
    mode.goalReplayTimelineController.attach(r.physics, mode.goalReplayRingBuffer);
  }
  if (!mode.podiumController && r) {
    mode.podiumController = r.podiumController || new PodiumCelebrationController(r);
    r.podiumController = mode.podiumController;
  }
  if (r && !r.replayTimelineController) {
    r.replayTimelineController = mode.goalReplayTimelineController;
  }
}

export function setupGoalReplayTestBench(mode) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();

  ensureGoalReplayTestBenchState(mode);
  parkDevTestLabProbes(r.physics, r.arena);
  mode.probeState = null;
  if (mode.ghostVisuals) {
    mode.ghostVisuals.setVisible(false);
  }
  if (mode.podiumController?.isActive) {
    mode.podiumController.exitPodium();
  }
  r.goalReplayCameraOverrideActive = false;

  while (r.physics.numCars > 2 && typeof r.physics.removeCar === 'function') {
    r.physics.removeCar(r.physics.numCars - 1);
  }
  while (r.physics.numCars < 2) {
    r.physics.addCar(r.physics.numCars % 2, 'octane');
  }
  r.arena?.ensureOpponent?.();
  if (r.arena?.cars) {
    if (r.arena.cars[0]) {
      r.arena.cars[0].visible = true;
      r.arena.setCarTeam?.(0, 0);
    }
    if (r.arena.cars[1]) {
      r.arena.cars[1].visible = true;
      r.arena.setCarTeam?.(1, 1);
      r.physics.setCarState(1, {
        pos: [1400, 3200, 17.05],
        vel: [0, 0, 0],
        angVel: [0, 0, 0],
        rot: [0, -Math.PI / 2, 0],
        boost: 100,
      });
    }
    for (let i = 2; i < r.arena.cars.length; i++) {
      if (r.arena.cars[i]) r.arena.cars[i].visible = false;
    }
  }

  r.playerCarIndex = 0;
  if (r.arena) r.arena.playerCarIndex = 0;
  r.isBotMatch = false;
  r.physics.setUnlimitedBoost(true);
  r.physics.resetGoalLatch?.();
  r.physics.resetKickoff(0, false);
  r.physics.setCarState(1, {
    pos: [1400, 3200, 17.05],
    vel: [0, 0, 0],
    angVel: [0, 0, 0],
    rot: [0, -Math.PI / 2, 0],
    boost: 100,
  });
  r.physics.clearEvents?.();
  r.simulationStage?.resetActionStates?.();
  r.arena?.resetAllCarEffects?.();
  r.resetAudio?.();

  // Clear both JS ReplayRingBuffer and WASM 256MB Replay Buffer on new test session start
  mode.goalReplayRingBuffer.configureMode(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
  r.physics.clearReplayBuffer?.();
  mode.goalReplayTimelineController.endReplaySession();

  const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
  mode.goalReplayLastKickoffFrame = currentTick;
  mode.goalReplayIncidentFrame = 0;
  mode.goalReplayPostGoalCountdownTicks = 0;
  mode.goalReplayScoringTeam = 0;
  mode.goalReplayPhase = 'live';

  mode.goalReplayRingBuffer.recordFrame(currentTick, r.physics.state, [
    {
      signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
      frameId: currentTick,
      param1: 0,
      param2: 0,
    },
  ]);

  r.interpolator?.sync?.();

  store.updateLiveTelemetry({
    goalReplayPhase: 'live',
    goalReplayCurrentFrameId: currentTick,
    goalReplayLastKickoffFrameId: currentTick,
    goalReplayIncidentFrameId: 0,
    goalReplayRequestedStartFrameId: currentTick,
    goalReplayEffectiveStartFrameId: currentTick,
    goalReplayEffectiveEndFrameId: currentTick,
    goalReplayClampedByKickoff: false,
    goalReplayPlaybackCursor: 0,
    goalReplayPlaybackTotal: 1,
    goalReplayPaused: false,
    goalReplaySpeed: 1.0,
    goalReplayRecordedBufferCount: mode.goalReplayRingBuffer.size,
    podiumActive: false,
  });
}

export function triggerGoalIncidentInTestBench(mode, scoringTeam = 0) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();
  const audio = getAudio(r);

  const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
  mode.goalReplayIncidentFrame = currentTick;
  mode.goalReplayScoringTeam = scoringTeam;

  const postGoalSec = Number.isFinite(store.goalReplayPostGoalSec) ? store.goalReplayPostGoalSec : 3.0;
  const postGoalTicks = Math.max(0, Math.round(postGoalSec * 120));

  // Record SCORE_UPDATED and GOAL_REPLAY_WILL_START on the goal incident tick
  // (Notice: KICKOFF_WILL_START is NEVER pre-emitted here!)
  mode.goalReplayRingBuffer?.recordFrame(currentTick, r.physics.state, [
    {
      signalType: MATCH_SIGNALS.SCORE_UPDATED,
      frameId: currentTick,
      param1: scoringTeam === 0 ? 1 : 0,
      param2: scoringTeam === 1 ? 1 : 0,
    },
    {
      signalType: MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
      frameId: currentTick,
      param1: postGoalTicks,
      param2: scoringTeam,
    },
  ]);

  const bounds = resolveGoalReplayWindowBounds({
    goalIncidentTick: currentTick,
    lastKickoffWillStartTick: mode.goalReplayLastKickoffFrame,
    lookbackSeconds: store.goalReplayLookbackSec,
    postGoalSeconds: postGoalSec,
    ringBuffer: mode.goalReplayRingBuffer,
  });

  audio?.play?.('sfx_goal_poof', 1.0);

  if (postGoalTicks > 0) {
    mode.goalReplayPhase = 'post-goal-delay';
    mode.goalReplayPostGoalCountdownTicks = postGoalTicks;
  } else {
    beginGoalReplayPlaybackInTestBench(mode);
  }

  store.updateLiveTelemetry({
    goalReplayPhase: mode.goalReplayPhase,
    goalReplayCurrentFrameId: currentTick,
    goalReplayIncidentFrameId: currentTick,
    goalReplayRequestedStartFrameId: bounds.requestedStartFrame,
    goalReplayEffectiveStartFrameId: bounds.effectiveStartFrame,
    goalReplayEffectiveEndFrameId: bounds.effectiveEndFrame,
    goalReplayClampedByKickoff: bounds.clampedByKickoff,
    goalReplayRecordedBufferCount: mode.goalReplayRingBuffer?.size || 0,
  });
}

export function beginGoalReplayPlaybackInTestBench(mode) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();
  ensureGoalReplayTestBenchState(mode);

  const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
  const incidentTick = mode.goalReplayIncidentFrame > 0 ? mode.goalReplayIncidentFrame : currentTick;

  const bounds = resolveGoalReplayWindowBounds({
    goalIncidentTick: incidentTick,
    lastKickoffWillStartTick: mode.goalReplayLastKickoffFrame,
    lookbackSeconds: store.goalReplayLookbackSec,
    postGoalSeconds: store.goalReplayPostGoalSec,
    ringBuffer: mode.goalReplayRingBuffer,
  });

  const extracted = extractGoalReplayFrames({
    ringBuffer: mode.goalReplayRingBuffer,
    engine: r.physics,
    goalIncidentTick: incidentTick,
    lastKickoffWillStartTick: mode.goalReplayLastKickoffFrame,
    lookbackSeconds: store.goalReplayLookbackSec,
    postGoalSeconds: store.goalReplayPostGoalSec,
  });

  const totalFrames = mode.goalReplayTimelineController.beginReplaySession({
    scoringTeam: mode.goalReplayScoringTeam || 0,
    frames: extracted,
  });

  mode.goalReplayPhase = 'replaying';
  mode.goalReplayPostGoalCountdownTicks = 0;
  r.goalReplayCameraOverrideActive = true;

  store.updateLiveTelemetry({
    goalReplayPhase: 'replaying',
    goalReplayRequestedStartFrameId: bounds.requestedStartFrame,
    goalReplayEffectiveStartFrameId: bounds.effectiveStartFrame,
    goalReplayEffectiveEndFrameId: bounds.effectiveEndFrame,
    goalReplayClampedByKickoff: bounds.clampedByKickoff,
    goalReplayPlaybackCursor: 0,
    goalReplayPlaybackTotal: totalFrames,
    goalReplayPaused: false,
    goalReplaySpeed: 1.0,
  });
}

export function stopGoalReplayPlaybackInTestBench(mode) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();

  mode.goalReplayTimelineController?.endReplaySession?.();
  r.goalReplayCameraOverrideActive = false;
  mode.goalReplayPhase = 'live';
  mode.goalReplayPostGoalCountdownTicks = 0;

  r.physics.resetGoalLatch?.();
  r.physics.resetKickoff(0, false);
  if (r.physics.numCars > 1) {
    r.physics.setCarState(1, {
      pos: [1400, 3200, 17.05],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      rot: [0, -Math.PI / 2, 0],
      boost: 100,
    });
  }

  const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
  mode.goalReplayLastKickoffFrame = currentTick;
  mode.goalReplayRingBuffer?.recordFrame(currentTick, r.physics.state, [
    {
      signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
      frameId: currentTick,
      param1: 0,
      param2: 0,
    },
  ]);
  r.interpolator?.sync?.();

  store.updateLiveTelemetry({
    goalReplayPhase: 'live',
    goalReplayCurrentFrameId: currentTick,
    goalReplayLastKickoffFrameId: currentTick,
    goalReplayPaused: false,
    goalReplayRecordedBufferCount: mode.goalReplayRingBuffer?.size || 0,
  });
}

export function stepGoalReplayBenchBeforeTick(mode, store) {
  const r = mode.runtime;
  const sim = r?.physics;
  if (!sim) return true;

  ensureGoalReplayTestBenchState(mode);

  if (mode.podiumController?.isActive) {
    return false;
  }

  if (mode.goalReplayPhase === 'replaying') {
    return false;
  }

  if (mode.goalReplayPhase === 'live') {
    const bView = sim.getBallStateView();
    const goalScored = typeof sim.isBallScored === 'function'
      ? sim.isBallScored(bView)
      : (Math.abs(bView.posY) > 5120 + 91.25 && Math.abs(bView.posX) < 892.755 && bView.posZ < 642.775);
    if (goalScored) {
      const scoringTeam = bView.posY > 0 ? 0 : 1;
      triggerGoalIncidentInTestBench(mode, scoringTeam);
    }
  } else if (mode.goalReplayPhase === 'post-goal-delay') {
    if (mode.goalReplayPostGoalCountdownTicks > 0) {
      mode.goalReplayPostGoalCountdownTicks--;
      if (mode.goalReplayPostGoalCountdownTicks <= 0) {
        beginGoalReplayPlaybackInTestBench(mode);
        return false;
      }
    }
  }

  return true;
}

export function recordGoalReplayBenchAfterTick(mode, store) {
  const r = mode.runtime;
  const sim = r?.physics;
  if (!sim || store.activeTab !== 'goal-replay') return;
  if (mode.goalReplayPhase !== 'live' && mode.goalReplayPhase !== 'post-goal-delay') return;

  const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount || 0);
  mode.goalReplayRingBuffer?.recordFrame(currentTick, sim.state);
  sim.recordReplayFrame?.();

  if (currentTick % 6 === 0) {
    const incidentRef = mode.goalReplayIncidentFrame > 0 ? mode.goalReplayIncidentFrame : currentTick;
    const bounds = resolveGoalReplayWindowBounds({
      goalIncidentTick: incidentRef,
      lastKickoffWillStartTick: mode.goalReplayLastKickoffFrame,
      lookbackSeconds: store.goalReplayLookbackSec,
      postGoalSeconds: store.goalReplayPostGoalSec,
      ringBuffer: mode.goalReplayRingBuffer,
    });

    store.updateLiveTelemetry({
      goalReplayCurrentFrameId: currentTick,
      goalReplayLastKickoffFrameId: mode.goalReplayLastKickoffFrame || 0,
      goalReplayRequestedStartFrameId: bounds.requestedStartFrame,
      goalReplayEffectiveStartFrameId: bounds.effectiveStartFrame,
      goalReplayEffectiveEndFrameId: bounds.effectiveEndFrame,
      goalReplayClampedByKickoff: bounds.clampedByKickoff,
      goalReplayRecordedBufferCount: mode.goalReplayRingBuffer?.size || 0,
    });
  }
}

export function updateGoalReplayBenchPresentation(mode, context, store) {
  const r = mode.runtime;
  const dt = context?.dt ?? 0.016;

  if (mode.podiumController?.isActive) {
    mode.podiumController.update(context);
    mode.podiumController.updateCamera(r.camera, dt);
    return;
  }

  if (store.activeTab !== 'goal-replay') return;

  if (mode.goalReplayPhase === 'replaying' && mode.goalReplayTimelineController?.isActive) {
    const stepRes = mode.goalReplayTimelineController.stepPlayback(dt, r.interpolator, true);
    dispatchReplayFrameEvents(stepRes, r, { isGoalReplay: true });
    applyDirectorReplayCamera(
      r.camera,
      r.interpolator,
      stepRes.progress,
      mode.goalReplayScoringTeam || 0,
      dt,
      0,
      mode.goalReplayTimelineController.directorCameraState
    );

    store.updateLiveTelemetry({
      goalReplayPlaybackCursor: stepRes.frameIndex,
      goalReplayPlaybackTotal: stepRes.totalFrames,
      goalReplayPaused: mode.goalReplayTimelineController.isPaused,
      goalReplaySpeed: mode.goalReplayTimelineController.playbackSpeed,
    });

    if (stepRes.isFinished && !mode.goalReplayTimelineController.isPaused) {
      // Loop replay in Dev Test Lab so developer can inspect the window repeatedly until clicking Exit
      getAudio(r)?.resetIncidentDebounceState?.();
      mode.goalReplayTimelineController.seekToIndex(0, r.interpolator);
      mode.goalReplayTimelineController.isScrubbing = false;
      mode.goalReplayTimelineController.directorCameraState.initialized = false;
    }
  }
}
