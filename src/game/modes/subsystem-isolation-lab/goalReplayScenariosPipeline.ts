import { MATCH_SIGNALS } from '../../../physics/RocketSimConstants.ts';
import type {
  ReplayRingBuffer,
  ReplaySignalEntry,
} from '../../../replay/ReplayRingBuffer.ts';
import type { LabPhysicsEnginePort } from './LabTabTypes.ts';

export type GoalReplayBenchScenario =
  | 'instant_kickoff_goal'
  | 'normal_play_goal'
  | 'trigger_goal_now'
  | 'emit_kickoff_signal'
  | 'start_replay_now'
  | 'stop_replay'
  | 'clear_replay_buffer'
  | 'export_replay_json'
  | string;

export interface GoalReplayStoreConfigSnapshot {
  goalReplayLookbackSec?: number;
  goalReplayPostGoalSec?: number;
  goalReplayLastKickoffFrameId?: number;
  goalReplayIncidentFrameId?: number;
  goalReplayRequestedStartFrameId?: number;
  goalReplayEffectiveStartFrameId?: number;
  goalReplayEffectiveEndFrameId?: number;
  goalReplayClampedByKickoff?: boolean;
}

export interface ReplayExportPayload {
  schema: string;
  exportedAt: string;
  tickRate: number;
  ringBufferFramesRecorded: number;
  wasmReplayBufferFramesRecorded: number;
  goalReplayConfig: {
    lookbackSeconds: number;
    postGoalSeconds: number;
    lastKickoffWillStartFrameId: number;
    lastGoalIncidentFrameId: number;
    requestedStartFrameId: number;
    effectiveStartFrameId: number;
    effectiveEndFrameId: number;
    clampedByKickoff: boolean;
  };
  signals: ReplaySignalEntry[];
  frames: Array<{
    tick: number;
    ballPos: [number, number, number];
    car0Pos: [number, number, number];
  }>;
}

export function buildMatchReplayExportPayload(
  ringBuffer: ReplayRingBuffer | null | undefined,
  wasmFramesCount: number,
  storeState: GoalReplayStoreConfigSnapshot,
  exportedAtIso = new Date().toISOString()
): ReplayExportPayload {
  const framesCount = ringBuffer?.size || 0;
  const sampleFrames: Array<{
    tick: number;
    ballPos: [number, number, number];
    car0Pos: [number, number, number];
  }> = [];
  const collectedSignals: ReplaySignalEntry[] = [];

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

  return {
    schema: 'RLCleanWASM.MatchReplayExport.v1',
    exportedAt: exportedAtIso,
    tickRate: 120,
    ringBufferFramesRecorded: framesCount,
    wasmReplayBufferFramesRecorded: wasmFramesCount,
    goalReplayConfig: {
      lookbackSeconds: storeState.goalReplayLookbackSec ?? 10,
      postGoalSeconds: storeState.goalReplayPostGoalSec ?? 3,
      lastKickoffWillStartFrameId: storeState.goalReplayLastKickoffFrameId ?? 0,
      lastGoalIncidentFrameId: storeState.goalReplayIncidentFrameId ?? 0,
      requestedStartFrameId: storeState.goalReplayRequestedStartFrameId ?? 0,
      effectiveStartFrameId: storeState.goalReplayEffectiveStartFrameId ?? 0,
      effectiveEndFrameId: storeState.goalReplayEffectiveEndFrameId ?? 0,
      clampedByKickoff: Boolean(storeState.goalReplayClampedByKickoff),
    },
    signals: collectedSignals,
    frames: sampleFrames,
  };
}

export function applyInstantKickoffGoalScenario(
  physics: LabPhysicsEnginePort,
  ringBuffer: ReplayRingBuffer | null | undefined
): number {
  physics.resetGoalLatch?.();
  physics.resetKickoff(0, false);
  const currentTick = Math.floor(physics.getHeaderView?.()?.tickCount || 0);
  ringBuffer?.recordFrame(currentTick, physics.state, [
    {
      signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
      frameId: currentTick,
      param1: 0,
      param2: 0,
    },
  ]);
  physics.setCarState(0, {
    pos: [0, 4200, 17.05],
    vel: [0, 1800, 0],
    angVel: [0, 0, 0],
    rot: [0, Math.PI / 2, 0],
    boost: 100,
  });
  if (physics.numCars > 1) {
    physics.setCarState(1, {
      pos: [1600, 3200, 17.05],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      rot: [0, -Math.PI / 2, 0],
      boost: 100,
    });
  }
  physics.setBallState({
    pos: [0, 4550, 110],
    vel: [0, 2100, 40],
    angVel: [0, 0, 0],
  });
  return currentTick;
}

export function applyNormalPlayGoalScenario(
  physics: LabPhysicsEnginePort,
  ringBuffer: ReplayRingBuffer | null | undefined,
  lastKickoffFrame: number
): void {
  physics.resetGoalLatch?.();
  const startTick = Math.floor(physics.getHeaderView?.()?.tickCount || 0);
  const elapsedSinceKickoff = startTick - (lastKickoffFrame || 0);
  const neededTicks = Math.max(0, 720 - elapsedSinceKickoff);
  if (neededTicks > 0) {
    physics.setBallState({
      pos: [0, 0, 93.15],
      vel: [0, 620, 120],
      angVel: [0, 0, 0],
    });
    physics.setCarState(0, {
      pos: [0, -1800, 17.05],
      vel: [0, 950, 0],
      angVel: [0, 0, 0],
      rot: [0, Math.PI / 2, 0],
      boost: 100,
    });
    for (let i = 0; i < neededTicks; i++) {
      physics.setControls(0, {
        throttle: 1.0,
        steer: Math.sin(i * 0.03) * 0.15,
        pitch: 0,
        yaw: 0,
        roll: 0,
        jump: false,
        boost: i % 3 === 0,
        handbrake: false,
      });
      physics.step(1);
      const t = Math.floor(physics.getHeaderView?.()?.tickCount || 0);
      ringBuffer?.recordFrame(t, physics.state);
      physics.recordReplayFrame?.();
    }
  }
  physics.setCarState(0, {
    pos: [0, 4100, 17.05],
    vel: [0, 1600, 0],
    angVel: [0, 0, 0],
    rot: [0, Math.PI / 2, 0],
    boost: 100,
  });
  physics.setBallState({
    pos: [0, 4550, 120],
    vel: [0, 2100, 30],
    angVel: [0, 0, 0],
  });
}
