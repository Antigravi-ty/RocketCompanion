/**
 * replayTimelineStepPipeline.ts
 * Narrow-input pipeline for fractional-tick playback stepping, streamed frame appending,
 * touch timeline state synchronization, and diagnostic input assembly on ReplayTimelineController.
 */

import { REPLAY_TICK_RATE, type ReplaySignalEntry, type ReplayAudioCue } from './ReplayRingBuffer.ts';
import { SIM_OFFSETS } from '../physics/RocketSimConstants.ts';
import {
  applyStepFrameAndControlsToEngine,
  collectDispatchedEventsInWindow,
  type ReplaySessionState,
  type ReplayTimelineFrameEntry,
  type ReplayFrameCarControlEntry,
  type ReplayIncidentEntry,
  type ReplayInterpolatorPort,
  type ReplayPhysicsEnginePort,
} from './ReplayDirectorStatePipeline.ts';
import type { ReplayDirectorCameraSubController } from './ReplayDirectorCameraSubController.ts';
import {
  analyzeReplayTouchTimeline,
  type ReplayTouchAnalysisConfig,
  type ResolvedTouchLookahead,
} from './ReplayTouchTimelineAnalyzer.ts';
import type { SuffixDirectorTrajectoryPlan } from './ReplayDirectorTrajectoryPlanner.ts';
import type { ReplayDirectorDiagnosticInput } from './ReplayDirectorDiagnostics.ts';

export interface ReplayPlaybackStepResult {
  frame: Float32Array | null;
  prevFrame?: Float32Array | null;
  currFrame?: Float32Array | null;
  alpha?: number;
  frameIndex: number;
  totalFrames: number;
  progress: number;
  slowMoFactor?: number;
  activeTouchCarIndex?: number;
  isFinished: boolean;
  incidents: ReplayIncidentEntry[];
  signals?: ReplaySignalEntry[];
  audioEvents: ReplayAudioCue[];
}

export interface ExecuteReplayPlaybackStepInput {
  totalFrames: number;
  dtSeconds: number;
  interpolator: ReplayInterpolatorPort | null;
  applyToEngine: boolean;
  engine: ReplayPhysicsEnginePort | null;
  sessionState: ReplaySessionState;
  directorCamera: ReplayDirectorCameraSubController;
  getFrameEntryByIndex: (index: number) => ReplayTimelineFrameEntry | null;
  getFrameBufferByIndex: (index: number) => Float32Array | null;
  ensureSuffixCameraPlan: () => SuffixDirectorTrajectoryPlan | null;
  resolveTouchLookaheadForFrame: (frameIdx: number, fallbackScorerCarIndex: number) => ResolvedTouchLookahead;
  computeDramaticSlowMoFactor: (cursorFloat: number, options?: { ignoreScrubState?: boolean }) => number;
}

export interface BuildReplayDiagnosticInputParams {
  totalFrames: number;
  activeWindowCount: number;
  currentFrameIndex: number;
  progress: number;
  sessionState: ReplaySessionState;
  directorCamera: ReplayDirectorCameraSubController;
  getFrameEntryByIndex: (index: number) => ReplayTimelineFrameEntry | null;
  getFrameBufferByIndex: (index: number) => Float32Array | null;
  ensureSuffixCameraPlan: () => SuffixDirectorTrajectoryPlan | null;
  resolveTouchLookaheadForFrame: (frameIdx: number, fallbackScorerCarIndex: number) => ResolvedTouchLookahead;
  computeDramaticSlowMoFactor: (cursorFloat: number, options?: { ignoreScrubState?: boolean }) => number;
}

export function analyzeAndSyncReplayTouchTimelineState(
  sessionState: ReplaySessionState,
  directorCamera: ReplayDirectorCameraSubController,
  options: ReplayTouchAnalysisConfig = {}
): void {
  const res = analyzeReplayTouchTimeline(sessionState.activeFrames, {
    scoringTeam: sessionState.scoringTeam,
    isNetworkStreamed: sessionState.isNetworkStreamed,
    watchAllTouches: sessionState.watchAllTouches,
    carTeamResolver: options.carTeamResolver ?? sessionState.carTeamResolver,
    scorerCarIndex: options.scorerCarIndex ?? sessionState.scorerCarIndex,
  });
  Object.assign(sessionState, {
    reboundEvents: res.reboundEvents,
    goalLineFrameIdx: res.goalLineFrameIdx,
    lateralBias: res.resolvedLateralBias,
    cachedSuffixCameraPlan: null,
  });

  directorCamera.onTimelineAnalyzed(res);
}

export function appendStreamedReplayFrameToState(
  sessionState: ReplaySessionState,
  directorCamera: ReplayDirectorCameraSubController,
  stateSnapshot: Float32Array | number[],
  serverTick = 0,
  acknowledgedControls: ReplayFrameCarControlEntry[] | null = null
): number {
  if (!stateSnapshot || stateSnapshot.length < 410) return 0;
  const snap = new Float32Array(stateSnapshot.length);
  snap.set(stateSnapshot);

  const nextFrames = sessionState.streamedFramesReceived === 0 ? [] : sessionState.activeFrames;
  const nextCount = sessionState.streamedFramesReceived + 1;

  const tick = Math.floor(snap[SIM_OFFSETS.TICK] || serverTick || nextCount);
  nextFrames.push({
    tick,
    snapshot: snap,
    acknowledgedControls: acknowledgedControls || null,
    incidents: [],
    signals: [],
    audioEvents: [],
  });
  Object.assign(sessionState, {
    activeFrames: nextFrames,
    streamedFramesReceived: nextCount,
    hasRetainedReplay: true,
  });

  directorCamera.preserveSmoothingAround(() => {
    analyzeAndSyncReplayTouchTimelineState(sessionState, directorCamera, {
      carTeamResolver: sessionState.carTeamResolver,
      scorerCarIndex: sessionState.scorerCarIndex,
    });
  });

  const isFollowingLive = !sessionState.isPaused && !sessionState.isScrubbing;
  const resolvedScorer = directorCamera.applyStreamedTelemetry(
    snap,
    isFollowingLive,
    sessionState.scorerCarIndex
  );

  Object.assign(sessionState, {
    scorerCarIndex: resolvedScorer,
    ...(isFollowingLive ? { cursorFloat: Math.max(0, sessionState.activeFrames.length - 1) } : {}),
  });
  return sessionState.activeFrames.length;
}

export function resetReplaySessionStateOnEnd(
  sessionState: ReplaySessionState,
  directorCamera: ReplayDirectorCameraSubController
): boolean {
  const hasRetained = Array.isArray(sessionState.activeFrames) && sessionState.activeFrames.length > 0;
  Object.assign(sessionState, {
    isActive: false,
    isPaused: false,
    isPersistent: false,
    isScrubbing: false,
    isLoopingPreview: false,
    disableSlowMo: false,
    isNetworkStreamed: false,
    hasRetainedReplay: hasRetained,
    lastDispatchedFrameIndex: -1,
    smoothedEye: null,
    smoothedTarget: null,
    cursorFloat: hasRetained
      ? Math.max(0, Math.min(sessionState.activeFrames.length - 1, Math.floor(sessionState.cursorFloat)))
      : 0,
  });
  directorCamera.resetSmoothing();
  directorCamera.setPauseAndScrubState(false, false);
  return hasRetained;
}

export function clearRetainedReplayState(
  sessionState: ReplaySessionState,
  directorCamera: ReplayDirectorCameraSubController
): void {
  Object.assign(sessionState, {
    activeFrames: [],
    hasRetainedReplay: false,
    retainedReplaySeq: 0,
    isImportedPreview: false,
    importedFileName: null,
    importedSummary: null,
    cachedSuffixCameraPlan: null,
    useRecordedCsvCamera: false,
    isLoopingPreview: false,
    streamedFramesReceived: 0,
    cursorFloat: 0,
  });

  directorCamera.clearRetained();
}

export function executeReplayPlaybackStep(
  input: ExecuteReplayPlaybackStepInput
): ReplayPlaybackStepResult {
  const {
    totalFrames: total,
    dtSeconds,
    interpolator,
    applyToEngine,
    engine,
    sessionState,
    directorCamera,
    getFrameEntryByIndex,
    getFrameBufferByIndex,
    ensureSuffixCameraPlan,
    resolveTouchLookaheadForFrame,
    computeDramaticSlowMoFactor,
  } = input;

  if (!sessionState.isPaused && sessionState.isScrubbing) {
    Object.assign(sessionState, { isScrubbing: false });
  }

  const isFollowingLiveStream =
    sessionState.isNetworkStreamed &&
    sessionState.streamedFramesReceived > 0 &&
    !sessionState.isPaused &&
    !sessionState.isScrubbing &&
    Math.abs(sessionState.playbackSpeed - 1.0) <= 0.01;

  const currentEntry = getFrameEntryByIndex(Math.floor(sessionState.cursorFloat));
  const useCsvPose = Boolean(
    sessionState.isImportedPreview &&
      sessionState.useRecordedCsvCamera &&
      currentEntry?.recordedCsvRow
  );

  const slowMoFactor = useCsvPose
    ? Math.max(0.25, Math.min(1.0, currentEntry?.recordedCsvRow?.slow_mo_factor ?? 1.0))
    : computeDramaticSlowMoFactor(sessionState.cursorFloat);

  let nextCursorFloat = sessionState.cursorFloat;
  if (isFollowingLiveStream) {
    nextCursorFloat = Math.max(0, total - 1);
  } else if (!sessionState.isPaused) {
    nextCursorFloat = Math.min(
      total - 1,
      sessionState.cursorFloat +
        Math.max(0, dtSeconds * REPLAY_TICK_RATE * sessionState.playbackSpeed * slowMoFactor)
    );
  }
  Object.assign(sessionState, { cursorFloat: nextCursorFloat });

  const baseIdx = Math.max(0, Math.min(total - 1, Math.floor(sessionState.cursorFloat)));
  const nextIdx = Math.min(total - 1, baseIdx + 1);
  const alpha = Math.max(0, Math.min(1, sessionState.cursorFloat - baseIdx));

  const prevEntry = getFrameEntryByIndex(baseIdx);
  const nextEntry = getFrameEntryByIndex(nextIdx) || prevEntry;
  const prevFrame = getFrameBufferByIndex(baseIdx);
  const currFrame = getFrameBufferByIndex(nextIdx) || prevFrame;
  const suffixPlan = !useCsvPose ? ensureSuffixCameraPlan() : null;

  const { embeddedTelemetry: embedded, resolvedScorerCarIndex } =
    directorCamera.syncForPlaybackStep({
      baseIdx,
      nextIdx,
      alpha,
      useCsvPose,
      cursorFloat: sessionState.cursorFloat,
      isPaused: sessionState.isPaused,
      isScrubbing: sessionState.isScrubbing,
      prevEntry,
      nextEntry,
      currFrame,
      suffixPlan,
      scorerCarIndex: sessionState.scorerCarIndex,
      resolveTouchLookaheadForFrame: (idx, fallbackScorer) =>
        resolveTouchLookaheadForFrame(idx, fallbackScorer),
    });
  Object.assign(sessionState, { scorerCarIndex: resolvedScorerCarIndex });

  if (
    (applyToEngine ||
      sessionState.isScrubbing ||
      sessionState.isPaused ||
      sessionState.playbackSpeed !== 1.0) &&
    currFrame &&
    engine
  ) {
    applyStepFrameAndControlsToEngine(
      engine,
      currFrame,
      prevFrame,
      alpha,
      interpolator,
      prevEntry
    );
  }

  let incidents: ReplayIncidentEntry[] = [];
  let audioEvents: ReplayAudioCue[] = [];
  let signals: ReplaySignalEntry[] = [];
  if (!sessionState.isPaused && baseIdx > sessionState.lastDispatchedFrameIndex) {
    const dispatched = collectDispatchedEventsInWindow(
      (idx) => getFrameEntryByIndex(idx),
      sessionState.lastDispatchedFrameIndex,
      baseIdx
    );
    incidents = dispatched.incidents;
    audioEvents = dispatched.audioEvents;
    signals = dispatched.signals;
    Object.assign(sessionState, { lastDispatchedFrameIndex: baseIdx });
  }

  let isFinished = sessionState.cursorFloat >= total - 1;
  if (
    isFinished &&
    sessionState.isLoopingPreview &&
    !sessionState.isPaused &&
    !sessionState.isScrubbing &&
    total > 1
  ) {
    Object.assign(sessionState, {
      cursorFloat: 0,
      lastDispatchedFrameIndex: -1,
    });
    directorCamera.resetSmoothing();
    isFinished = false;
  } else if (isFinished && sessionState.isPersistent && !sessionState.isPaused) {
    Object.assign(sessionState, { isPaused: true });
    directorCamera.setPauseAndScrubState(true, sessionState.isScrubbing);
  }

  const effectiveProgress =
    embedded && typeof embedded.progress === 'number' && embedded.progress > 0
      ? embedded.progress
      : isFollowingLiveStream && sessionState.expectedDurationTicks > 1
        ? Math.min(
            1,
            sessionState.cursorFloat / Math.max(1, sessionState.expectedDurationTicks - 1)
          )
        : total > 1
          ? sessionState.cursorFloat / (total - 1)
          : 1;

  return {
    frame: currFrame,
    prevFrame,
    currFrame,
    alpha,
    frameIndex: baseIdx,
    totalFrames: total,
    progress: effectiveProgress,
    slowMoFactor,
    activeTouchCarIndex: directorCamera.state.activeTouchCarIndex,
    isFinished,
    incidents,
    signals,
    audioEvents,
  };
}

export function buildReplayDiagnosticInput(
  params: BuildReplayDiagnosticInputParams
): ReplayDirectorDiagnosticInput {
  const s = params.sessionState;
  return {
    totalFrames: params.totalFrames,
    activeWindowCount: params.activeWindowCount,
    currentFrameIndex: params.currentFrameIndex,
    cursorFloat: s.cursorFloat,
    progress: params.progress,
    playbackSpeed: s.playbackSpeed,
    isPaused: s.isPaused,
    isPersistent: s.isPersistent,
    isScrubbing: s.isScrubbing,
    isActive: s.isActive,
    isImportedPreview: s.isImportedPreview,
    importedFileName: s.importedFileName,
    useRecordedCsvCamera: s.useRecordedCsvCamera,
    cachedSmoothnessSummary: s.cachedSmoothnessSummary,
    importedSummary: s.importedSummary,
    cachedAnomalyPeaks: s.cachedAnomalyPeaks,
    importedAnomalyPeaks: s.importedAnomalyPeaks,
    scoringTeam: s.scoringTeam,
    scorerCarIndex: s.scorerCarIndex,
    carTeamResolver: s.carTeamResolver,
    directorCameraState: params.directorCamera.state,
    getFrameEntryByIndex: params.getFrameEntryByIndex,
    getFrameBufferByIndex: params.getFrameBufferByIndex,
    ensureSuffixCameraPlan: params.ensureSuffixCameraPlan,
    resolveTouchLookaheadForFrame: params.resolveTouchLookaheadForFrame,
    computeDramaticSlowMoFactor: params.computeDramaticSlowMoFactor,
  };
}
