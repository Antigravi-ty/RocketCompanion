/**
 * ReplayDirectorStatePipeline.ts
 * Pure TypeScript pipeline for ReplaySessionState value transitions
 * and fractional-tick playback stepping.
 */

import { REPLAY_TICK_RATE, type ReplaySignalEntry, type ReplayAudioCue } from './ReplayRingBuffer.ts';
import { applyReplayFrameToEngine } from './ReplayFrameInterpolator.ts';
import { DEFAULT_GOAL_REPLAY_TICKS, extractGoalReplayFrames } from './ReplayPlaybackState.ts';
import type { ReplayDirectorCameraSubController } from './ReplayDirectorCameraSubController.ts';
import {
  analyzeAndSyncReplayTouchTimelineState,
  type ResolvedTouchLookahead,
} from './ReplayTouchTimelineAnalyzer.ts';
import type { SuffixDirectorTrajectoryPlan } from './ReplayDirectorTrajectoryPlanner.ts';
import type {
  ReplayCarRosterEntry, ReplayIncidentEntry, ReplayInterpolatorPort,
  ReplayPhysicsEnginePort, ReplaySessionInitOptions, ReplaySessionState,
  ReplayTimelineFrameEntry, RetainedReplaySnapshotCloneInput, TimelineReplaySessionInitInput,
} from './replayDirectorStateTypes.ts';

export type {
  DirectorCameraPose, DirectorCameraState, ImportedDiagnosticLoadOptions, ImportedDiagnosticPatternInput,
  RefreshDirectorPoseInput, ReplayCarRosterEntry, ReplayFrameCarControlEntry, ReplayIncidentEntry,
  ReplayInterpolatorPort, ReplayPhysicsEnginePort, ReplaySessionInitOptions, ReplaySessionState,
  ReplayTimelineFrameEntry, RetainedReplaySnapshotCloneInput, StepDirectorCameraSyncInput,
  StepDirectorCameraSyncResult, TimelineReplaySessionInitInput,
} from './replayDirectorStateTypes.ts';

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

export function applyStepFrameAndControlsToEngine(
  engine: ReplayPhysicsEnginePort,
  currFrame: Float32Array,
  prevFrame: Float32Array | null,
  alpha: number,
  interpolator: ReplayInterpolatorPort | null,
  currEntry: ReplayTimelineFrameEntry | null
): void {
  applyReplayFrameToEngine(engine, currFrame, interpolator, prevFrame, alpha);
  const controls = currEntry?.acknowledgedControls || currEntry?.controls || null;
  const setControlsFn =
    typeof engine.setControls === 'function' ? engine.setControls.bind(engine)
    : typeof engine.setCarControls === 'function' ? engine.setCarControls.bind(engine) : null;
  if (Array.isArray(controls) && setControlsFn) {
    for (let c = 0; c < controls.length; c++) {
      const ctrlEntry = controls[c];
      if (ctrlEntry) setControlsFn(c, ctrlEntry);
    }
  }
}

export function collectDispatchedEventsInWindow(
  getFrameEntryByIndex: (index: number) => ReplayTimelineFrameEntry | null,
  lastDispatchedFrameIndex: number,
  baseIdx: number
): { incidents: ReplayIncidentEntry[]; audioEvents: ReplayAudioCue[]; signals: ReplaySignalEntry[] } {
  const incidents: ReplayIncidentEntry[] = [];
  const audioEvents: ReplayAudioCue[] = [];
  const signals: ReplaySignalEntry[] = [];
  const startIdx = Math.max(0, lastDispatchedFrameIndex + 1, baseIdx - 10);
  for (let idx = startIdx; idx <= baseIdx; idx++) {
    const entry = getFrameEntryByIndex(idx);
    if (!entry) continue;
    if (Array.isArray(entry.incidents) && entry.incidents.length > 0) incidents.push(...entry.incidents);
    if (Array.isArray(entry.audioEvents) && entry.audioEvents.length > 0) audioEvents.push(...entry.audioEvents);
    if (Array.isArray(entry.signals) && entry.signals.length > 0) signals.push(...entry.signals);
  }
  return { incidents, audioEvents, signals };
}

export function buildTimelineReplaySessionInitState(input: TimelineReplaySessionInitInput): ReplaySessionState {
  const { ringBuffer, engine, options = {}, currentRetainedReplaySeq } = input;
  const durationTicks = options.durationTicks ?? DEFAULT_GOAL_REPLAY_TICKS;
  const activeFrames: ReplayTimelineFrameEntry[] =
    Array.isArray(options.frames) && options.frames.length > 0
      ? options.frames
      : extractGoalReplayFrames({ ringBuffer, engine, durationTicks });
  const clonedCarEntries =
    Array.isArray(options.carEntries) && options.carEntries.length > 0
      ? options.carEntries.map((c: ReplayCarRosterEntry) => ({ ...c }))
      : null;

  return {
    activeFrames, cursorFloat: 0, isPaused: false, isPersistent: Boolean(options.isPersistent),
    playbackSpeed: 1.0, isScrubbing: false,
    scoringTeam: options.scoringTeam ?? 0,
    scorerCarIndex: typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0 ? options.scorerCarIndex : 0,
    carTeamResolver: typeof options.carTeamResolver === 'function' ? options.carTeamResolver : null,
    isActive: true, isNetworkStreamed: Boolean(options.isNetworkStreamed),
    expectedDurationTicks: Math.max(1, Math.floor(durationTicks)), streamedFramesReceived: 0,
    hasRetainedReplay: activeFrames.length > 0, retainedReplaySeq: currentRetainedReplaySeq,
    isImportedPreview: Boolean(options.isImportedPreview),
    importedFileName: options.importedFileName || null,
    importedSummary: options.importedSummary || null,
    importedAnomalyPeaks: options.importedAnomalyPeaks || null,
    importedCarEntries: null, carEntries: clonedCarEntries,
    cachedSuffixCameraPlan: null, cachedSmoothnessSummary: null, cachedAnomalyPeaks: null,
    useRecordedCsvCamera: Boolean(options.useRecordedCsvCamera),
    isLoopingPreview: Boolean(options.isLoopingPreview),
    disableSlowMo: Boolean(options.disableSlowMo),
    watchAllTouches: Boolean(options.watchAllTouches),
    goalLineFrameIdx: -1, reboundEvents: [], lateralBias: 1.0,
    lastDispatchedFrameIndex: -1, smoothedEye: null, smoothedTarget: null,
  };
}

export function buildRetainedReplaySessionState(
  currentState: ReplaySessionState,
  options: ReplaySessionInitOptions = {}
): ReplaySessionState {
  const frames: ReplayTimelineFrameEntry[] = Array.isArray(options.frames) ? options.frames : [];
  const clonedCarEntries =
    Array.isArray(options.carEntries) && options.carEntries.length > 0
      ? options.carEntries.map((c: ReplayCarRosterEntry) => ({ ...c }))
      : currentState.carEntries;

  return {
    ...currentState,
    activeFrames: frames, expectedDurationTicks: frames.length,
    scoringTeam: options.scoringTeam ?? 0,
    scorerCarIndex: typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0 ? options.scorerCarIndex : 0,
    carTeamResolver: typeof options.carTeamResolver === 'function' ? options.carTeamResolver : null,
    hasRetainedReplay: true, isImportedPreview: false, importedFileName: null,
    importedSummary: null, importedAnomalyPeaks: null, useRecordedCsvCamera: false,
    isNetworkStreamed: false, cursorFloat: 0, lastDispatchedFrameIndex: -1,
    cachedSuffixCameraPlan: null, cachedSmoothnessSummary: null, cachedAnomalyPeaks: null,
    carEntries: clonedCarEntries,
  };
}

export function buildClonedRetainedReplaySessionState(
  input: RetainedReplaySnapshotCloneInput
): ReplaySessionState {
  const { currentSessionState, sourceSessionState: src } = input;
  const srcEntries = src.importedCarEntries || src.carEntries;
  const importedCarEntries = Array.isArray(srcEntries)
    ? srcEntries.map((c: ReplayCarRosterEntry) => ({ ...c }))
    : null;

  return {
    ...currentSessionState,
    activeFrames: src.activeFrames.slice(), expectedDurationTicks: src.activeFrames.length,
    scoringTeam: src.scoringTeam ?? 0, scorerCarIndex: src.scorerCarIndex ?? 0,
    carTeamResolver: src.carTeamResolver || null, hasRetainedReplay: true,
    retainedReplaySeq: src.retainedReplaySeq || currentSessionState.retainedReplaySeq,
    isImportedPreview: Boolean(src.isImportedPreview),
    importedFileName: src.importedFileName || null,
    importedSummary: src.importedSummary || null,
    importedAnomalyPeaks: src.importedAnomalyPeaks || null,
    importedCarEntries,
    carEntries: Array.isArray(src.carEntries)
      ? src.carEntries.map((c: ReplayCarRosterEntry) => ({ ...c }))
      : importedCarEntries,
    useRecordedCsvCamera: Boolean(src.useRecordedCsvCamera),
    cursorFloat: Math.max(0, Math.min(src.activeFrames.length - 1, Math.floor(src.cursorFloat ?? 0))),
    cachedSuffixCameraPlan: src.cachedSuffixCameraPlan || null,
    cachedSmoothnessSummary: src.cachedSmoothnessSummary || null,
    cachedAnomalyPeaks: src.cachedAnomalyPeaks || null,
  };
}

export function resetReplaySessionStateOnEnd(
  sessionState: ReplaySessionState,
  directorCamera: ReplayDirectorCameraSubController
): boolean {
  const wasNetworkStreamed = Boolean(sessionState.isNetworkStreamed);
  const hasRetained = Array.isArray(sessionState.activeFrames) && sessionState.activeFrames.length > 0;
  Object.assign(sessionState, {
    isActive: false, isPaused: false, isPersistent: false, isScrubbing: false,
    isLoopingPreview: false, disableSlowMo: false, isNetworkStreamed: false,
    hasRetainedReplay: hasRetained, lastDispatchedFrameIndex: -1,
    smoothedEye: null, smoothedTarget: null,
    cursorFloat: hasRetained
      ? Math.max(0, Math.min(sessionState.activeFrames.length - 1, Math.floor(sessionState.cursorFloat)))
      : 0,
  });
  if (hasRetained && wasNetworkStreamed) {
    analyzeAndSyncReplayTouchTimelineState(sessionState, directorCamera, {
      carTeamResolver: sessionState.carTeamResolver,
      scorerCarIndex: sessionState.scorerCarIndex,
    });
  }
  directorCamera.resetSmoothing();
  directorCamera.setPauseAndScrubState(false, false);
  return hasRetained;
}

export function clearRetainedReplayState(
  sessionState: ReplaySessionState,
  directorCamera: ReplayDirectorCameraSubController
): void {
  Object.assign(sessionState, {
    activeFrames: [], hasRetainedReplay: false, retainedReplaySeq: 0,
    isImportedPreview: false, importedFileName: null, importedSummary: null,
    cachedSuffixCameraPlan: null, useRecordedCsvCamera: false, isLoopingPreview: false,
    streamedFramesReceived: 0, cursorFloat: 0,
  });
  directorCamera.clearRetained();
}

export function executeReplayPlaybackStep(input: ExecuteReplayPlaybackStepInput): ReplayPlaybackStepResult {
  const {
    totalFrames: total, dtSeconds, interpolator, applyToEngine, engine, sessionState, directorCamera,
    getFrameEntryByIndex, getFrameBufferByIndex, ensureSuffixCameraPlan,
    resolveTouchLookaheadForFrame, computeDramaticSlowMoFactor,
  } = input;

  if (!sessionState.isPaused && sessionState.isScrubbing) {
    Object.assign(sessionState, { isScrubbing: false });
  }

  const isFollowingLiveStream =
    sessionState.isNetworkStreamed && sessionState.streamedFramesReceived > 0 &&
    !sessionState.isPaused && !sessionState.isScrubbing && Math.abs(sessionState.playbackSpeed - 1.0) <= 0.01;

  const currentEntry = getFrameEntryByIndex(Math.floor(sessionState.cursorFloat));
  const useCsvPose = Boolean(
    sessionState.isImportedPreview && sessionState.useRecordedCsvCamera && currentEntry?.recordedCsvRow
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
      sessionState.cursorFloat + Math.max(0, dtSeconds * REPLAY_TICK_RATE * sessionState.playbackSpeed * slowMoFactor)
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

  const { embeddedTelemetry: embedded, resolvedScorerCarIndex } = directorCamera.syncForPlaybackStep({
    baseIdx, nextIdx, alpha, useCsvPose,
    cursorFloat: sessionState.cursorFloat,
    isPaused: sessionState.isPaused,
    isScrubbing: sessionState.isScrubbing,
    prevEntry, nextEntry, currFrame, suffixPlan,
    scorerCarIndex: sessionState.scorerCarIndex,
    resolveTouchLookaheadForFrame: (idx, fb) => resolveTouchLookaheadForFrame(idx, fb),
  });
  Object.assign(sessionState, { scorerCarIndex: resolvedScorerCarIndex });

  if (
    (applyToEngine || sessionState.isScrubbing || sessionState.isPaused || sessionState.playbackSpeed !== 1.0) &&
    currFrame && engine
  ) {
    applyStepFrameAndControlsToEngine(engine, currFrame, prevFrame, alpha, interpolator, prevEntry);
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
  if (isFinished && sessionState.isLoopingPreview && !sessionState.isPaused && !sessionState.isScrubbing && total > 1) {
    Object.assign(sessionState, { cursorFloat: 0, lastDispatchedFrameIndex: -1 });
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
        ? Math.min(1, sessionState.cursorFloat / Math.max(1, sessionState.expectedDurationTicks - 1))
        : total > 1 ? sessionState.cursorFloat / (total - 1) : 1;

  return {
    frame: currFrame, prevFrame, currFrame, alpha,
    frameIndex: baseIdx, totalFrames: total, progress: effectiveProgress,
    slowMoFactor, activeTouchCarIndex: directorCamera.state.activeTouchCarIndex,
    isFinished, incidents, signals, audioEvents,
  };
}
