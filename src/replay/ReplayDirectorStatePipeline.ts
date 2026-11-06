/**
 * ReplayDirectorStatePipeline.ts
 * Pure TypeScript pipeline for ReplaySessionState value transitions,
 * imported pattern team resolution, and engine step helpers.
 */

import { type ReplaySignalEntry, type ReplayAudioCue } from './ReplayRingBuffer.ts';
import { applyReplayFrameToEngine } from './ReplayFrameInterpolator.ts';
import { DEFAULT_GOAL_REPLAY_TICKS, extractGoalReplayFrames } from './ReplayPlaybackState.ts';
import {
  createInitialDirectorCameraState,
  createInitialReplaySessionState,
  type DirectorCameraPose,
  type DirectorCameraState,
  type ImportedDiagnosticLoadOptions,
  type ImportedDiagnosticPatternInput,
  type RefreshDirectorPoseInput,
  type ReplayCarRosterEntry,
  type ReplayFrameCarControlEntry,
  type ReplayIncidentEntry,
  type ReplayInterpolatorPort,
  type ReplayPhysicsEnginePort,
  type ReplaySessionInitOptions,
  type ReplaySessionState,
  type ReplayTimelineFrameEntry,
  type RetainedReplaySnapshotCloneInput,
  type StepDirectorCameraSyncInput,
  type StepDirectorCameraSyncResult,
  type TimelineReplaySessionInitInput,
} from './replayDirectorStateTypes.ts';

export {
  createInitialDirectorCameraState,
  createInitialReplaySessionState,
  type DirectorCameraPose,
  type DirectorCameraState,
  type ImportedDiagnosticLoadOptions,
  type ImportedDiagnosticPatternInput,
  type RefreshDirectorPoseInput,
  type ReplayCarRosterEntry,
  type ReplayFrameCarControlEntry,
  type ReplayIncidentEntry,
  type ReplayInterpolatorPort,
  type ReplayPhysicsEnginePort,
  type ReplaySessionInitOptions,
  type ReplaySessionState,
  type ReplayTimelineFrameEntry,
  type RetainedReplaySnapshotCloneInput,
  type StepDirectorCameraSyncInput,
  type StepDirectorCameraSyncResult,
  type TimelineReplaySessionInitInput,
};

export function buildImportedCarTeamResolver(
  importedCarEntries: ReplayCarRosterEntry[] | null | undefined
): ((carIndex: number) => number) | null {
  if (!Array.isArray(importedCarEntries) || importedCarEntries.length === 0) return null;
  const teamMap = new Map<number, number>();
  for (const c of importedCarEntries) {
    if (typeof c?.carIndex === 'number' && typeof c?.team === 'number') teamMap.set(c.carIndex, c.team);
  }
  return teamMap.size > 0 ? (cIdx: number) => teamMap.get(cIdx) ?? cIdx % 2 : null;
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
    activeFrames,
    cursorFloat: 0,
    isPaused: false,
    isPersistent: Boolean(options.isPersistent),
    playbackSpeed: 1.0,
    isScrubbing: false,
    scoringTeam: options.scoringTeam ?? 0,
    scorerCarIndex: typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0 ? options.scorerCarIndex : 0,
    carTeamResolver: typeof options.carTeamResolver === 'function' ? options.carTeamResolver : null,
    isActive: true,
    isNetworkStreamed: Boolean(options.isNetworkStreamed),
    expectedDurationTicks: Math.max(1, Math.floor(durationTicks)),
    streamedFramesReceived: 0,
    hasRetainedReplay: activeFrames.length > 0,
    retainedReplaySeq: currentRetainedReplaySeq,
    isImportedPreview: Boolean(options.isImportedPreview),
    importedFileName: options.importedFileName || null,
    importedSummary: options.importedSummary || null,
    importedAnomalyPeaks: options.importedAnomalyPeaks || null,
    importedCarEntries: null,
    carEntries: clonedCarEntries,
    cachedSuffixCameraPlan: null,
    cachedSmoothnessSummary: null,
    cachedAnomalyPeaks: null,
    useRecordedCsvCamera: Boolean(options.useRecordedCsvCamera),
    isLoopingPreview: Boolean(options.isLoopingPreview),
    disableSlowMo: Boolean(options.disableSlowMo),
    watchAllTouches: Boolean(options.watchAllTouches),
    goalLineFrameIdx: -1,
    reboundEvents: [],
    lateralBias: 1.0,
    lastDispatchedFrameIndex: -1,
    smoothedEye: null,
    smoothedTarget: null,
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
    activeFrames: frames,
    expectedDurationTicks: frames.length,
    scoringTeam: options.scoringTeam ?? 0,
    scorerCarIndex: typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0 ? options.scorerCarIndex : 0,
    carTeamResolver: typeof options.carTeamResolver === 'function' ? options.carTeamResolver : null,
    hasRetainedReplay: true,
    isImportedPreview: false,
    importedFileName: null,
    importedSummary: null,
    importedAnomalyPeaks: null,
    useRecordedCsvCamera: false,
    isNetworkStreamed: false,
    cursorFloat: 0,
    lastDispatchedFrameIndex: -1,
    cachedSuffixCameraPlan: null,
    cachedSmoothnessSummary: null,
    cachedAnomalyPeaks: null,
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
    activeFrames: src.activeFrames.slice(),
    expectedDurationTicks: src.activeFrames.length,
    scoringTeam: src.scoringTeam ?? 0,
    scorerCarIndex: src.scorerCarIndex ?? 0,
    carTeamResolver: src.carTeamResolver || null,
    hasRetainedReplay: true,
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

export function buildImportedDiagnosticPatternSessionState(
  currentState: ReplaySessionState,
  parsedPattern: ImportedDiagnosticPatternInput,
  fallbackCarTeamResolver: ((carIndex: number) => number) | null,
  options: ImportedDiagnosticLoadOptions = {}
): { sessionState: ReplaySessionState; initialCursorFloat: number } {
  const importedCarEntries = Array.isArray(parsedPattern.carEntries) ? parsedPattern.carEntries : null;
  const resolvedTeamResolver = buildImportedCarTeamResolver(importedCarEntries);
  const hasRecordedRows = Boolean(
    parsedPattern.hasRecordedCsvRows ||
      parsedPattern.activeFrames.some((f: ReplayTimelineFrameEntry) => Boolean(f?.recordedCsvRow))
  );
  const useRecordedCsvCamera =
    typeof options.useRecordedCsvCamera === 'boolean'
      ? options.useRecordedCsvCamera && hasRecordedRows
      : false;
  const startIdx = Math.max(
    0,
    Math.min(parsedPattern.activeFrames.length - 1, parsedPattern.selectedCursorIndex ?? 0)
  );
  return {
    sessionState: {
      ...currentState,
      activeFrames: parsedPattern.activeFrames,
      expectedDurationTicks: parsedPattern.activeFrames.length,
      scoringTeam: parsedPattern.scoringTeam ?? 0,
      scorerCarIndex: parsedPattern.scorerCarIndex ?? 0,
      hasRetainedReplay: true,
      isImportedPreview: true,
      importedFileName: parsedPattern.fileName || options.fileName || 'imported.rcgr.gz',
      importedCarEntries,
      carEntries: importedCarEntries,
      carTeamResolver: resolvedTeamResolver || fallbackCarTeamResolver,
      cachedSuffixCameraPlan: null,
      cachedSmoothnessSummary: null,
      cachedAnomalyPeaks: null,
      useRecordedCsvCamera,
      isNetworkStreamed: false,
      streamedFramesReceived: 0,
    },
    initialCursorFloat: options.startFromBeginning ? 0 : startIdx,
  };
}
