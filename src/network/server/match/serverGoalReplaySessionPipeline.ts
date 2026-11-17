/**
 * src/network/server/match/serverGoalReplaySessionPipeline.ts
 * Pure server goal-replay session initialization and playback stepping pipeline.
 */

import {
  interpolateReplaySnapshots,
  encodeReplayDirectorTelemetryIntoState,
} from '../../../replay/ReplayFrameInterpolator.ts';
import type { ReplayDirectorCameraSubController } from '../../../replay/ReplayDirectorCameraSubController.ts';
import { analyzeReplayTouchTimeline } from '../../../replay/ReplayTouchTimelineAnalyzer.ts';
import {
  ensureSuffixCameraPlan,
  resolveTouchLookaheadForFrame,
  computeDramaticSlowMoFactor,
} from '../../../replay/replayTouchLookaheadPipeline.ts';
import type { SuffixDirectorTrajectoryPlan } from '../../../replay/ReplayDirectorTrajectoryPlanner.ts';
import type {
  DirectorCameraState,
  ReplaySessionState,
  ReplayTimelineFrameEntry,
} from '../../../replay/replayDirectorStateTypes.ts';
import { normalizeReplayDirectorCarEntry } from '../../../replay/replayDirectorCarRosterPipeline.ts';
import type { MatchPlayerSlot } from './matchLoadoutAndSpawnPipeline.ts';

export type ServerReplayTimelineState = ReplaySessionState;

function computeReplaySlowMo(
  s: ServerReplayTimelineState,
  d: DirectorCameraState,
  c: number
): number {
  return computeDramaticSlowMoFactor(
    {
      disableSlowMo: s.disableSlowMo,
      playbackSpeed: s.playbackSpeed,
      isScrubbing: s.isScrubbing,
      lastScoringTouchFrameIdx: d.lastScoringTouchFrameIdx ?? -1,
      goalLineFrameIdx: d.goalLineFrameIdx ?? -1,
    },
    c
  );
}

function syncReplaySuffixPlan(
  s: ServerReplayTimelineState,
  cam: ReplayDirectorCameraSubController
): SuffixDirectorTrajectoryPlan | null {
  const d = cam.state;
  const plan = ensureSuffixCameraPlan(s.activeFrames, {
    isNetworkStreamed: false,
    streamedFramesReceived: 0,
    expectedDurationTicks: s.expectedDurationTicks,
    cachedPlan: s.cachedSuffixCameraPlan,
    scoringTeam: s.scoringTeam,
    scorerCarIndex: d.scorerCarIndex ?? s.scorerCarIndex ?? 0,
    goalLineFrameIdx: d.goalLineFrameIdx ?? -1,
    touchEvents: d.touchEvents || [],
    carTeamResolver: s.carTeamResolver,
    lateralBias: d.lateralBias,
    initialSettledCarPos: d.initialSettledCarPos,
  });
  s.cachedSuffixCameraPlan = plan;
  cam.setSuffixCameraPlan(plan);
  return plan;
}

export function initServerGoalReplaySession(p: {
  baseState: ServerReplayTimelineState;
  extracted: ReplayTimelineFrameEntry[];
  players: Map<string, MatchPlayerSlot>;
  scoringTeam: number;
  scorerCarIndex: number;
  prevRetainedSeq: number;
  enableDramaticReplaySlowMo: boolean;
  directorCamera: ReplayDirectorCameraSubController;
}): { sessionState: ServerReplayTimelineState; replayTicksRemaining: number } {
  const {
    baseState,
    extracted,
    players,
    scoringTeam,
    scorerCarIndex,
    prevRetainedSeq,
    enableDramaticReplaySlowMo,
    directorCamera,
  } = p;
  const carEntries = Array.from(players.values())
    .filter((c) => c && c.role !== 'spectator' && typeof c.entityId === 'number' && c.entityId >= 0)
    .sort((a, b) => a.entityId - b.entityId)
    .map((c) =>
      normalizeReplayDirectorCarEntry(
        {
          carIndex: c.entityId,
          name: c.name,
          username: c.name,
          team: c.team ?? c.entityId % 2,
          isBot: Boolean(c.isBot),
          isLocalPlayer: !c.isBot && c.entityId === 0,
          botType: c.botType || null,
          visualId: c.visualId,
          hitboxId: c.hitboxId,
          colorSlot: c.colorSlot,
          colorHex: c.colorHex,
          paintFinish: c.paintFinish,
          boostVisual: c.boostVisual,
          boostAudio: c.boostAudio,
          anthemId: c.anthemId,
        },
        c.entityId,
        c.team ?? c.entityId % 2
      )
    );
  const carTeamResolver = (idx: number) => {
    for (const c of players.values()) if (c.entityId === idx) return c.team ?? idx % 2;
    return idx % 2;
  };
  const sessionState: ServerReplayTimelineState = {
    ...baseState,
    activeFrames: extracted,
    expectedDurationTicks: extracted.length,
    scoringTeam,
    scorerCarIndex,
    carTeamResolver,
    hasRetainedReplay: true,
    retainedReplaySeq: prevRetainedSeq + 1,
    carEntries,
    isActive: true,
  };
  directorCamera.reset(false, false, false);
  directorCamera.onTimelineAnalyzed(
    analyzeReplayTouchTimeline(extracted, {
      scoringTeam,
      isNetworkStreamed: false,
      watchAllTouches: false,
      carTeamResolver,
      scorerCarIndex,
    })
  );
  syncReplaySuffixPlan(sessionState, directorCamera);

  let replayTicksRemaining = extracted.length;
  if (enableDramaticReplaySlowMo && extracted.length > 1) {
    let simCursor = 0,
      estTicks = 0;
    const maxIdx = extracted.length - 1;
    while (simCursor < maxIdx && estTicks < maxIdx * 3) {
      simCursor += Math.max(
        0.1,
        computeReplaySlowMo(sessionState, directorCamera.state, simCursor)
      );
      estTicks++;
    }
    replayTicksRemaining = Math.max(extracted.length, estTicks);
  }
  return { sessionState, replayTicksRemaining };
}

export function stepServerGoalReplaySession(p: {
  sessionState: ServerReplayTimelineState;
  directorCamera: ReplayDirectorCameraSubController;
  enableDramaticReplaySlowMo: boolean;
  replayInterpolatedBuffer: Float32Array | null;
}): { baseIdx: number; blendedSnap: Float32Array | null } {
  const {
    sessionState: s,
    directorCamera: cam,
    enableDramaticReplaySlowMo,
    replayInterpolatedBuffer,
  } = p;
  const frames = s.activeFrames,
    total = frames.length;
  const slowMo = enableDramaticReplaySlowMo
    ? computeReplaySlowMo(s, cam.state, s.cursorFloat)
    : 1.0;
  const nextCursor = Math.min(total - 1, s.cursorFloat + Math.max(0, s.playbackSpeed * slowMo));
  s.cursorFloat = nextCursor;
  const baseIdx = Math.max(0, Math.min(total - 1, Math.floor(nextCursor)));
  const nextIdx = Math.min(total - 1, baseIdx + 1);
  const alpha = Math.max(0, Math.min(1, nextCursor - baseIdx));

  const prevEntry = frames[baseIdx] || null,
    nextEntry = frames[nextIdx] || prevEntry;
  const prevSnap = prevEntry?.snapshot || null,
    currSnap = nextEntry?.snapshot || prevSnap;
  const suffixPlan = syncReplaySuffixPlan(s, cam),
    d = cam.state;

  const { resolvedScorerCarIndex } = cam.syncForPlaybackStep({
    baseIdx,
    nextIdx,
    alpha,
    useCsvPose: false,
    cursorFloat: nextCursor,
    isPaused: false,
    isScrubbing: false,
    prevEntry,
    nextEntry,
    currFrame: currSnap,
    suffixPlan,
    scorerCarIndex: s.scorerCarIndex,
    resolveTouchLookaheadForFrame: (idx, fb) =>
      resolveTouchLookaheadForFrame(
        {
          suffixPlan,
          goalLineFrameIdx: d.goalLineFrameIdx ?? -1,
          scorerCarIndex: d.scorerCarIndex ?? s.scorerCarIndex ?? 0,
          touchEvents: d.touchEvents || [],
          reboundEvents: d.reboundEvents || [],
          scoringTeam: s.scoringTeam,
          watchAllTouches: false,
        },
        idx,
        fb
      ),
  });
  s.scorerCarIndex = resolvedScorerCarIndex;

  let blendedSnap: Float32Array | null = null;
  if (currSnap) {
    blendedSnap = interpolateReplaySnapshots(
      prevSnap || currSnap,
      currSnap,
      alpha,
      replayInterpolatedBuffer || undefined
    );
    encodeReplayDirectorTelemetryIntoState(
      blendedSnap,
      d,
      total > 1 ? nextCursor / (total - 1) : 1
    );
  }
  if (nextCursor >= total - 1) s.isActive = false;
  return { baseIdx, blendedSnap };
}
