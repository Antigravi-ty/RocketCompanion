/**
 * ReplayDiagnosticPatternController.ts
 * Sub-controller and pure helpers for importing, evaluating, and serializing
 * Goal Replay Director diagnostic patterns, frame snapshots, and local frame windows.
 */

import {
  setActiveReplayTimelineController,
  notifyActiveReplayTimelineController,
  registerReplayDirectorDiagnosticExporter,
  markReplayTimelineControllerRetained,
} from '../game/runtimeUiPort.ts';
import {
  exportReplayDirectorDiagnosticPattern,
  exportReplayDirectorReferenceKeyframe,
} from './ReplayDirectorExporter.ts';
import { parseDirectorDiagnosticInput } from './ReplayDirectorPatternParser.ts';
import type { ReplayDirectorCameraSubController } from './ReplayDirectorCameraSubController.ts';
import {
  evaluateDirectorDiagnosticPatternPayload,
  type ReplayDirectorDiagnosticInput,
  type DirectorDiagnosticPatternOptions,
  type DirectorDiagnosticPatternPayload,
} from './ReplayDirectorDiagnostics.ts';
import { buildCurrentFrameDiagnosticSnapshot } from './replayDirectorSingleFramePipeline.ts';
import {
  resolveGoalExplosionFrameIndex,
  type ReplayTouchEvent,
} from './ReplayDirectorGazeSolver.ts';
import {
  buildDirectorDiagnosticPatternCsv,
  buildDirectorFrameWindowDiagnostic,
  type DirectorPatternSerializerOptions,
} from './ReplayDirectorPatternSerializer.ts';
import type { SuffixDirectorTrajectoryPlan } from './ReplayDirectorTrajectoryPlanner.ts';
import type {
  ReplayTouchAnalysisConfig,
  ResolvedTouchLookahead,
} from './ReplayTouchTimelineAnalyzer.ts';
import type {
  DirectorCameraState,
  ImportedDiagnosticLoadOptions,
  ImportedDiagnosticPatternInput,
  ReplayCarRosterEntry,
  ReplaySessionState,
  ReplayTimelineFrameEntry,
} from './replayDirectorStateTypes.ts';

export interface ReplayDiagnosticTimelinePort {
  sessionState: ReplaySessionState;
  readonly directorCamera: ReplayDirectorCameraSubController;
  directorCameraState: DirectorCameraState;
  readonly ActiveWindowCount: number;
  readonly currentFrameIndex: number;
  readonly progress: number;
  getTotalRecordedFrames(): number;
  getFrameEntryByIndex(index: number): ReplayTimelineFrameEntry | null;
  getFrameBufferByIndex(index: number): Float32Array | null;
  ensureSuffixCameraPlan(): SuffixDirectorTrajectoryPlan | null;
  resolveTouchLookaheadForFrame(
    frameIdx: number,
    fallbackScorerCarIndex?: number
  ): ResolvedTouchLookahead;
  computeDramaticSlowMoFactor(
    cursorFloat: number,
    options?: { ignoreScrubState?: boolean }
  ): number;
  refreshCurrentFrameDirectorPose(): unknown;
  _analyzeReplayTouchTimeline(options?: ReplayTouchAnalysisConfig): void;
}

export function buildImportedCarTeamResolver(
  importedCarEntries: ReplayCarRosterEntry[] | null | undefined
): ((carIndex: number) => number) | null {
  if (!Array.isArray(importedCarEntries) || importedCarEntries.length === 0) return null;
  const teamMap = new Map<number, number>();
  for (const c of importedCarEntries) {
    if (typeof c?.carIndex === 'number' && typeof c?.team === 'number')
      teamMap.set(c.carIndex, c.team);
  }
  return teamMap.size > 0 ? (cIdx: number) => teamMap.get(cIdx) ?? cIdx % 2 : null;
}

export function buildImportedDiagnosticPatternSessionState(
  currentState: ReplaySessionState,
  parsedPattern: ImportedDiagnosticPatternInput,
  fallbackCarTeamResolver: ((carIndex: number) => number) | null,
  options: ImportedDiagnosticLoadOptions = {}
): { sessionState: ReplaySessionState; initialCursorFloat: number } {
  const importedCarEntries = Array.isArray(parsedPattern.carEntries)
    ? parsedPattern.carEntries
    : null;
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

export function applyImportedPatternOverridesToDirectorState(
  state: DirectorCameraState,
  parsedPattern: ImportedDiagnosticPatternInput,
  activeFrames: ReplayTimelineFrameEntry[],
  scoringTeam: number,
  currentGoalLineFrameIdx: number
): number {
  let resolvedGoalLineFrameIdx = currentGoalLineFrameIdx;
  if (Array.isArray(parsedPattern.touchEvents) && parsedPattern.touchEvents.length > 0) {
    state.touchEvents = parsedPattern.touchEvents.map((t: ReplayTouchEvent) => ({ ...t }));
  }
  if (
    typeof parsedPattern.lastScoringTouchFrameIdx === 'number' &&
    parsedPattern.lastScoringTouchFrameIdx >= 0
  ) {
    state.lastScoringTouchFrameIdx = parsedPattern.lastScoringTouchFrameIdx;
  }
  if (typeof parsedPattern.goalLineFrameIdx === 'number' && parsedPattern.goalLineFrameIdx >= 0) {
    resolvedGoalLineFrameIdx = resolveGoalExplosionFrameIndex(
      activeFrames,
      (scoringTeam ?? 0) === 0 ? 1.0 : -1.0,
      parsedPattern.goalLineFrameIdx
    );
    state.goalLineFrameIdx = resolvedGoalLineFrameIdx;
  }
  if (
    parsedPattern.initialSettledCarPos &&
    typeof parsedPattern.initialSettledCarPos === 'object'
  ) {
    state.initialSettledCarPos = { ...parsedPattern.initialSettledCarPos };
  }
  if (typeof parsedPattern.lateralBias === 'number' && parsedPattern.lateralBias !== 0) {
    state.lateralBias = parsedPattern.lateralBias;
    state.hasResolvedInitialLateralBias = true;
  }
  return resolvedGoalLineFrameIdx;
}

export function buildReplayDiagnosticInput(
  timeline: ReplayDiagnosticTimelinePort,
  s: ReplaySessionState
): ReplayDirectorDiagnosticInput {
  return {
    totalFrames: timeline.getTotalRecordedFrames(),
    activeWindowCount: timeline.ActiveWindowCount,
    currentFrameIndex: timeline.currentFrameIndex,
    cursorFloat: s.cursorFloat,
    progress: timeline.progress,
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
    carEntries: s.importedCarEntries || s.carEntries || null,
    directorCameraState: timeline.directorCamera.state,
    getFrameEntryByIndex: (idx) => timeline.getFrameEntryByIndex(idx),
    getFrameBufferByIndex: (idx) => timeline.getFrameBufferByIndex(idx),
    ensureSuffixCameraPlan: () => timeline.ensureSuffixCameraPlan(),
    resolveTouchLookaheadForFrame: (idx, fb) => timeline.resolveTouchLookaheadForFrame(idx, fb),
    computeDramaticSlowMoFactor: (cursor, opts) =>
      timeline.computeDramaticSlowMoFactor(cursor, opts),
  };
}

registerReplayDirectorDiagnosticExporter(
  exportReplayDirectorDiagnosticPattern,
  parseDirectorDiagnosticInput,
  buildDirectorFrameWindowDiagnostic,
  exportReplayDirectorReferenceKeyframe
);

export function getCurrentFrameDiagnosticSnapshotForTimeline(
  timeline: ReplayDiagnosticTimelinePort
): ReturnType<typeof buildCurrentFrameDiagnosticSnapshot> {
  const s = timeline.sessionState;
  if (!s.isNetworkStreamed && s.activeFrames.length > 0 && !s.cachedSmoothnessSummary) {
    buildDirectorDiagnosticPatternPayloadForTimeline(timeline);
  }
  return buildCurrentFrameDiagnosticSnapshot(buildReplayDiagnosticInput(timeline, s));
}

export function buildDirectorDiagnosticPatternPayloadForTimeline(
  timeline: ReplayDiagnosticTimelinePort,
  options: DirectorDiagnosticPatternOptions = {}
): DirectorDiagnosticPatternPayload | null {
  const res = evaluateDirectorDiagnosticPatternPayload(
    buildReplayDiagnosticInput(timeline, timeline.sessionState),
    options
  );
  if (!res) return null;
  Object.assign(timeline.sessionState, {
    cachedSmoothnessSummary: res.trajectorySmoothnessSummary,
    cachedAnomalyPeaks: res.anomalyPeaks,
  });
  return res.payload;
}

export function buildDirectorDiagnosticPatternCsvForTimeline(
  timeline: ReplayDiagnosticTimelinePort,
  options: DirectorPatternSerializerOptions = {}
): string {
  return buildDirectorDiagnosticPatternCsv(
    {
      currentFrameIndex: timeline.currentFrameIndex,
      sessionState: timeline.sessionState,
      directorCameraState: timeline.directorCameraState,
      buildDirectorDiagnosticPatternPayload: (opts) =>
        buildDirectorDiagnosticPatternPayloadForTimeline(timeline, opts),
    },
    options
  );
}

export function buildDirectorFrameWindowDiagnosticForTimeline(
  timeline: ReplayDiagnosticTimelinePort,
  windowRadius = 15
): ReturnType<typeof buildDirectorFrameWindowDiagnostic> {
  return buildDirectorFrameWindowDiagnostic(
    {
      currentFrameIndex: timeline.currentFrameIndex,
      sessionState: timeline.sessionState,
      directorCameraState: timeline.directorCameraState,
      buildDirectorDiagnosticPatternPayload: (opts) =>
        buildDirectorDiagnosticPatternPayloadForTimeline(timeline, opts),
    },
    windowRadius
  );
}

export function loadImportedDiagnosticPatternForTimeline(
  timeline: ReplayDiagnosticTimelinePort,
  parsedPattern: ImportedDiagnosticPatternInput | null | undefined,
  options: ImportedDiagnosticLoadOptions = {}
): number {
  if (
    !parsedPattern ||
    !Array.isArray(parsedPattern.activeFrames) ||
    parsedPattern.activeFrames.length === 0
  ) {
    return 0;
  }
  const fields = buildImportedDiagnosticPatternSessionState(
    timeline.sessionState,
    parsedPattern,
    timeline.sessionState.carTeamResolver,
    options
  );
  const s = Object.assign(timeline.sessionState, fields.sessionState);

  timeline._analyzeReplayTouchTimeline({
    scorerCarIndex: s.scorerCarIndex,
    carTeamResolver: s.carTeamResolver,
  });

  const goalLineFrameIdx = applyImportedPatternOverridesToDirectorState(
    timeline.directorCamera.state,
    parsedPattern,
    s.activeFrames,
    s.scoringTeam,
    s.goalLineFrameIdx
  );
  s.goalLineFrameIdx = goalLineFrameIdx;

  if (!s.useRecordedCsvCamera || !parsedPattern.summary || !parsedPattern.anomalyPeaks) {
    timeline.ensureSuffixCameraPlan();
    buildDirectorDiagnosticPatternPayloadForTimeline(timeline);
  }

  Object.assign(s, {
    importedSummary: s.useRecordedCsvCamera
      ? parsedPattern.summary || s.cachedSmoothnessSummary
      : s.cachedSmoothnessSummary || parsedPattern.summary || null,
    importedAnomalyPeaks: s.useRecordedCsvCamera
      ? parsedPattern.anomalyPeaks || s.cachedAnomalyPeaks
      : s.cachedAnomalyPeaks || parsedPattern.anomalyPeaks || null,
    cursorFloat: fields.initialCursorFloat,
    lastDispatchedFrameIndex: -1,
  });

  timeline.refreshCurrentFrameDirectorPose();
  markReplayTimelineControllerRetained(timeline);
  setActiveReplayTimelineController(timeline);
  notifyActiveReplayTimelineController();
  return s.activeFrames.length;
}
