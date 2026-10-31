/**
 * SubsystemIsolationLabGoalReplayScenarios.js
 * Scenario triggers, replay JSON exporter, and Podium celebration helpers for Developer Test Lab Bench 5.
 */

import { MATCH_SIGNALS } from '../../../physics/RocketSimConstants.js';
import { useSubsystemIsolationLabStore } from '../../../ui-core/stores/subsystemIsolationLabStore';
import { hudStore } from '../../../ui-core/stores/hudStore';
import {
  ensureGoalReplayTestBenchState,
  setupGoalReplayTestBench,
  triggerGoalIncidentInTestBench,
  beginGoalReplayPlaybackInTestBench,
  stopGoalReplayPlaybackInTestBench,
} from './SubsystemIsolationLabGoalReplayHelper.js';

export function exportReplayBufferAsJson(mode) {
  const r = mode.runtime;
  ensureGoalReplayTestBenchState(mode);

  const ringBuffer =
    r?.authoritativeServer?.matchAdmin?.replayBuffer ||
    mode.goalReplayRingBuffer;

  const framesCount = ringBuffer?.size || 0;
  const wasmFramesCount = r?.physics?.getReplayFrameCount?.() || 0;
  const store = useSubsystemIsolationLabStore.getState();

  const sampleFrames = [];
  const collectedSignals = [];
  if (ringBuffer && framesCount > 0) {
    const allFrames = ringBuffer.getRecentFrames(Math.min(framesCount, 1800));
    for (let i = 0; i < allFrames.length; i++) {
      const f = allFrames[i];
      if (!f) continue;
      if (Array.isArray(f.signals) && f.signals.length > 0) {
        for (const s of f.signals) {
          collectedSignals.push(s);
        }
      }
      const snap = f.snapshot;
      sampleFrames.push({
        tick: f.tick,
        ballPos: snap
          ? [
              Number((snap[4] || 0).toFixed(2)),
              Number((snap[5] || 0).toFixed(2)),
              Number((snap[6] || 0).toFixed(2)),
            ]
          : [0, 0, 0],
        car0Pos: snap
          ? [
              Number((snap[22] || 0).toFixed(2)),
              Number((snap[23] || 0).toFixed(2)),
              Number((snap[24] || 0).toFixed(2)),
            ]
          : [0, 0, 0],
      });
    }
  }

  const payload = {
    schema: 'RLCleanWASM.MatchReplayExport.v1',
    exportedAt: new Date().toISOString(),
    tickRate: 120,
    ringBufferFramesRecorded: framesCount,
    wasmReplayBufferFramesRecorded: wasmFramesCount,
    goalReplayConfig: {
      lookbackSeconds: store.goalReplayLookbackSec,
      postGoalSeconds: store.goalReplayPostGoalSec,
      lastKickoffWillStartFrameId: store.goalReplayLastKickoffFrameId,
      lastGoalIncidentFrameId: store.goalReplayIncidentFrameId,
      requestedStartFrameId: store.goalReplayRequestedStartFrameId,
      effectiveStartFrameId: store.goalReplayEffectiveStartFrameId,
      effectiveEndFrameId: store.goalReplayEffectiveEndFrameId,
      clampedByKickoff: store.goalReplayClampedByKickoff,
    },
    signals: collectedSignals,
    frames: sampleFrames,
  };

  if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rlcleanwasm-replay-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return payload;
}

export function enterPodiumInTestLab(mode, winningTeam = 0) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();

  ensureGoalReplayTestBenchState(mode);
  if (mode.goalReplayPhase === 'replaying') {
    mode.goalReplayTimelineController?.endReplaySession?.();
  }
  r.goalReplayCameraOverrideActive = false;

  while (r.physics.numCars < 2) {
    r.physics.addCar(r.physics.numCars % 2, 'octane');
  }
  r.arena?.ensureOpponent?.();
  if (r.arena?.cars) {
    if (r.arena.cars[0]) r.arena.cars[0].visible = true;
    if (r.arena.cars[1]) r.arena.cars[1].visible = true;
  }

  r.isBotMatch = true;
  mode.podiumController.enterPodium(winningTeam, 'DEV_TEST_PODIUM');
  mode.goalReplayPhase = 'podium';

  store.updateLiveTelemetry({
    goalReplayPhase: 'podium',
    podiumActive: true,
    podiumWinningTeam: winningTeam,
  });
  hudStore.getState().setMatchState({
    matchPhase: 'podium',
    winner: winningTeam === 1 ? 'ORANGE' : winningTeam === 2 ? 'DRAW' : 'BLUE',
  });
}

export function exitPodiumInTestLab(mode) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();

  if (mode.podiumController?.isActive) {
    mode.podiumController.exitPodium();
  }
  r.isBotMatch = false;
  mode.goalReplayPhase = 'live';

  r.physics.resetGoalLatch?.();
  r.physics.resetKickoff(0, false);
  r.interpolator?.sync?.();

  store.updateLiveTelemetry({
    goalReplayPhase: 'live',
    podiumActive: false,
  });
  hudStore.getState().setMatchState({
    matchPhase: 'playing',
  });
}

export function triggerGoalReplayBenchScenario(mode, scenario) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();
  ensureGoalReplayTestBenchState(mode);

  switch (scenario) {
    case 'instant_kickoff_goal': {
      if (mode.goalReplayPhase === 'replaying') {
        stopGoalReplayPlaybackInTestBench(mode);
      }
      if (mode.podiumController?.isActive) {
        exitPodiumInTestLab(mode);
      }
      r.physics.resetGoalLatch?.();
      r.physics.resetKickoff(0, false);
      const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
      mode.goalReplayLastKickoffFrame = currentTick;
      mode.goalReplayRingBuffer.recordFrame(currentTick, r.physics.state, [
        {
          signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
          frameId: currentTick,
          param1: 0,
          param2: 0,
        },
      ]);
      r.physics.setCarState(0, {
        pos: [0, 4200, 17.05],
        vel: [0, 1800, 0],
        angVel: [0, 0, 0],
        rot: [0, Math.PI / 2, 0],
        boost: 100,
      });
      if (r.physics.numCars > 1) {
        r.physics.setCarState(1, {
          pos: [1600, 3200, 17.05],
          vel: [0, 0, 0],
          angVel: [0, 0, 0],
          rot: [0, -Math.PI / 2, 0],
          boost: 100,
        });
      }
      r.physics.setBallState({
        pos: [0, 4550, 110],
        vel: [0, 2100, 40],
        angVel: [0, 0, 0],
      });
      r.interpolator?.sync?.();
      store.updateLiveTelemetry({
        goalReplayPhase: 'live',
        goalReplayLastKickoffFrameId: currentTick,
        goalReplayCurrentFrameId: currentTick,
      });
      break;
    }

    case 'normal_play_goal': {
      if (mode.goalReplayPhase === 'replaying') {
        stopGoalReplayPlaybackInTestBench(mode);
      }
      if (mode.podiumController?.isActive) {
        exitPodiumInTestLab(mode);
      }
      r.physics.resetGoalLatch?.();
      const startTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
      const elapsedSinceKickoff = startTick - (mode.goalReplayLastKickoffFrame || 0);
      const neededTicks = Math.max(0, 720 - elapsedSinceKickoff);
      if (neededTicks > 0) {
        r.physics.setBallState({
          pos: [0, 0, 93.15],
          vel: [0, 620, 120],
          angVel: [0, 0, 0],
        });
        r.physics.setCarState(0, {
          pos: [0, -1800, 17.05],
          vel: [0, 950, 0],
          angVel: [0, 0, 0],
          rot: [0, Math.PI / 2, 0],
          boost: 100,
        });
        for (let i = 0; i < neededTicks; i++) {
          r.physics.setControls(0, {
            throttle: 1.0,
            steer: Math.sin(i * 0.03) * 0.15,
            pitch: 0,
            yaw: 0,
            roll: 0,
            jump: false,
            boost: i % 3 === 0,
            handbrake: false,
          });
          r.physics.step(1);
          const t = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
          mode.goalReplayRingBuffer.recordFrame(t, r.physics.state);
          r.physics.recordReplayFrame?.();
        }
      }
      r.physics.setCarState(0, {
        pos: [0, 4100, 17.05],
        vel: [0, 1600, 0],
        angVel: [0, 0, 0],
        rot: [0, Math.PI / 2, 0],
        boost: 100,
      });
      r.physics.setBallState({
        pos: [0, 4550, 120],
        vel: [0, 2100, 30],
        angVel: [0, 0, 0],
      });
      r.interpolator?.sync?.();
      break;
    }

    case 'trigger_goal_now': {
      triggerGoalIncidentInTestBench(mode, 0);
      break;
    }

    case 'emit_kickoff_signal': {
      const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
      mode.goalReplayLastKickoffFrame = currentTick;
      mode.goalReplayRingBuffer.recordFrame(currentTick, r.physics.state, [
        {
          signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
          frameId: currentTick,
          param1: 0,
          param2: 0,
        },
      ]);
      store.updateLiveTelemetry({
        goalReplayLastKickoffFrameId: currentTick,
        goalReplayCurrentFrameId: currentTick,
        goalReplayRecordedBufferCount: mode.goalReplayRingBuffer.size,
      });
      break;
    }

    case 'start_replay_now': {
      if (mode.goalReplayIncidentFrame <= 0) {
        mode.goalReplayIncidentFrame = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
      }
      beginGoalReplayPlaybackInTestBench(mode);
      break;
    }

    case 'stop_replay': {
      stopGoalReplayPlaybackInTestBench(mode);
      break;
    }

    case 'clear_replay_buffer': {
      setupGoalReplayTestBench(mode);
      break;
    }

    case 'export_replay_json': {
      exportReplayBufferAsJson(mode);
      break;
    }

    default:
      break;
  }
}
