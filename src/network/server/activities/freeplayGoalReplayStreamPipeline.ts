/**
 * src/network/server/activities/freeplayGoalReplayStreamPipeline.ts
 * Pure Goal Replay frame extraction and authoritative Director/POV camera
 * pose computation for the vNext Freeplay Spectate Stream.
 */

import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.ts';
import type { ReplayRingBuffer } from '../../../replay/ReplayRingBuffer.ts';
import type { FreeplayCameraPose } from './freeplaySpectateTypes.ts';

export function extractFreeplayGoalReplaySnapshots(params: {
  ringBuffer: ReplayRingBuffer;
  replayType: 'goal' | 'expire';
  goalIncidentTick: number;
  lastTouchTick: number;
  lastKickoffTick: number;
  currentTick: number;
}): Float32Array[] {
  const { ringBuffer, replayType, goalIncidentTick, lastTouchTick, lastKickoffTick, currentTick } =
    params;
  const goalTick = goalIncidentTick > 0 ? goalIncidentTick : currentTick;
  const rawSlots =
    replayType === 'expire'
      ? ringBuffer.getFramesInTickRange(Math.max(lastKickoffTick, goalTick - 600), currentTick)
      : extractGoalReplayFrames({
          ringBuffer,
          engine: null,
          goalIncidentTick: goalTick,
          scorerTouchTick: lastTouchTick,
          lookbackSeconds: 10.0,
          touchLookbackSeconds: 7.0,
          postGoalTicks: Math.max(0, currentTick - goalTick),
          lastKickoffWillStartTick: lastKickoffTick,
        });
  return rawSlots
    .map((s) => s?.snapshot)
    .filter((snap): snap is Float32Array => Boolean(snap && snap.length >= 22))
    .map((snap) => new Float32Array(snap));
}

export function computeFreeplaySpectateCameraPose(params: {
  subMode: 'live' | 'goal_replay' | 'rewind';
  replayCameraMode: 'director' | 'pov';
  focusedCarIndex: number;
  ball: { posX: number; posY: number; posZ: number };
  cars: ReadonlyArray<{ posX: number; posY: number; posZ: number; carIndex: number }>;
}): FreeplayCameraPose | null {
  const { subMode, replayCameraMode, focusedCarIndex, ball, cars } = params;
  if (subMode !== 'goal_replay' && subMode !== 'rewind') return null;
  if (replayCameraMode === 'pov') {
    const target = cars.find((c) => c.carIndex === focusedCarIndex) ?? cars[0];
    if (!target) return null;
    return {
      posX: target.posX,
      posY: target.posY - 260,
      posZ: target.posZ + 110,
      lookAtX: ball.posX,
      lookAtY: ball.posY,
      lookAtZ: ball.posZ,
      fov: 110,
    };
  }
  return {
    posX: ball.posX * 0.65 + 1400,
    posY: ball.posY * 0.65 - 1200,
    posZ: Math.max(420, ball.posZ + 520),
    lookAtX: ball.posX,
    lookAtY: ball.posY,
    lookAtZ: ball.posZ,
    fov: 68,
  };
}
