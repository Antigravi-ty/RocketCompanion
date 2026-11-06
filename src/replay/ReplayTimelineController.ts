/**
 * ReplayTimelineController.ts
 * Worker-safe Unified 256MB WASM Native Replay Buffer & JS RingBuffer Timeline Scrubber
 * and Goal Replay Controller with integrated fractional-tick playback stepper.
 */

import { type ReplayRingBuffer } from './ReplayRingBuffer.ts';
import { REPLAY_PLAYBACK_SPEEDS } from './ReplayPlaybackState.ts';
import { applyReplayFrameToEngine } from './ReplayFrameInterpolator.ts';
import { ReplayDirectorCameraSubController } from './ReplayDirectorCameraSubController.ts';
import {
  createInitialReplaySessionState,
  buildTimelineReplaySessionInitState,
  buildRetainedReplaySessionState,
  buildClonedRetainedReplaySessionState,
  buildImportedDiagnosticPatternSessionState,
  type DirectorCameraPose,
  type DirectorCameraState,
  type ReplaySessionState,
  type ReplaySessionInitOptions,
  type ImportedDiagnosticPatternInput,
  type ImportedDiagnosticLoadOptions,
  type ReplayTimelineFrameEntry,
  type ReplayFrameCarControlEntry,
  type ReplayInterpolatorPort,
  type ReplayPhysicsEnginePort,
} from './ReplayDirectorStatePipeline.ts';
import {
  ensureSuffixCameraPlan,
  resolveTouchLookaheadForFrame,
  resolveFocusCarForFrame,
  computeDramaticSlowMoFactor,
  type ReplayTouchAnalysisConfig,
  type ResolvedTouchLookahead,
} from './ReplayTouchTimelineAnalyzer.ts';
import type { SuffixDirectorTrajectoryPlan } from './ReplayDirectorTrajectoryPlanner.ts';
import {
  getActiveReplayTimelineController,
  setActiveReplayTimelineController,
  notifyActiveReplayTimelineController,
  registerReplayDirectorDiagnosticExporter,
  markReplayTimelineControllerRetained,
} from '../game/runtimeUiPort.ts';
import {
  buildCurrentFrameDiagnosticSnapshot,
  evaluateDirectorDiagnosticPatternPayload,
  type ReplayDirectorDiagnosticInput,
  type DirectorDiagnosticPatternOptions,
} from './ReplayDirectorDiagnostics.ts';
import {
  buildDirectorDiagnosticPatternCsv,
  buildDirectorFrameWindowDiagnostic,
  type DirectorPatternSerializerOptions,
} from './ReplayDirectorPatternSerializer.ts';
import {
  exportReplayDirectorDiagnosticPattern,
  exportReplayDirectorReferenceKeyframe,
} from './ReplayDirectorExporter.ts';
import { parseDirectorDiagnosticInput } from './ReplayDirectorPatternParser.ts';
import {
  analyzeAndSyncReplayTouchTimelineState,
  appendStreamedReplayFrameToState,
  resetReplaySessionStateOnEnd,
  clearRetainedReplayState,
  executeReplayPlaybackStep,
  buildReplayDiagnosticInput,
  type ReplayPlaybackStepResult,
} from './replayTimelineStepPipeline.ts';

export type {
  ReplayTimelineFrameEntry,
  ReplaySessionState,
  DirectorCameraState,
  ReplayPlaybackStepResult,
};

registerReplayDirectorDiagnosticExporter(
  exportReplayDirectorDiagnosticPattern,
  parseDirectorDiagnosticInput,
  buildDirectorFrameWindowDiagnostic,
  exportReplayDirectorReferenceKeyframe
);

export interface ReplayTimelineControllerOptions {
  engine?: ReplayPhysicsEnginePort | null;
  ringBuffer?: ReplayRingBuffer | null;
}

export interface ReplayPreviewSessionStartOptions {
  loop?: boolean;
  startPaused?: boolean;
  restart?: boolean;
}

export class ReplayTimelineController {
  public engine: ReplayPhysicsEnginePort | null;
  public ringBuffer: ReplayRingBuffer | null;
  public sessionState: ReplaySessionState;
  public readonly directorCamera: ReplayDirectorCameraSubController;

  constructor(options: ReplayTimelineControllerOptions = {}) {
    this.engine = options.engine || null;
    this.ringBuffer = options.ringBuffer || null;
    this.sessionState = createInitialReplaySessionState();
    this.directorCamera = new ReplayDirectorCameraSubController();
  }

  public get directorCameraState(): DirectorCameraState {
    return this.directorCamera.state;
  }

  public set directorCameraState(val: DirectorCameraState) {
    this.directorCamera.state = val;
  }

  private _patchSessionState(patch: Partial<ReplaySessionState>): void {
    Object.assign(this.sessionState, patch);
  }

  attach(engine: ReplayPhysicsEnginePort | null, ringBuffer: ReplayRingBuffer | null = null): this {
    this.engine = engine || this.engine;
    if (ringBuffer) this.ringBuffer = ringBuffer;
    return this;
  }

  getTotalRecordedFrames(): number {
    if (this.ActiveWindowCount > 0) return this.ActiveWindowCount;
    const wasmCount = this.engine?.getReplayFrameCount?.() ?? 0;
    return wasmCount > 0 ? wasmCount : (this.ringBuffer?.size ?? 0);
  }

  get frames(): ReplayTimelineFrameEntry[] {
    return this.sessionState.activeFrames;
  }

  get ActiveWindowCount(): number {
    return Array.isArray(this.sessionState.activeFrames) ? this.sessionState.activeFrames.length : 0;
  }

  get currentFrameIndex(): number {
    const total = this.getTotalRecordedFrames();
    return total <= 0 ? 0 : Math.max(0, Math.min(total - 1, Math.floor(this.sessionState.cursorFloat)));
  }

  get progress(): number {
    const total = this.getTotalRecordedFrames();
    return total <= 1 ? 0 : Math.max(0, Math.min(1, this.sessionState.cursorFloat / (total - 1)));
  }

  invalidateCachedDirectorPlans(disableRecordedCsvCamera = false): void {
    const nextCsvCamera =
      disableRecordedCsvCamera && this.sessionState.isImportedPreview && this.sessionState.useRecordedCsvCamera
        ? false
        : this.sessionState.useRecordedCsvCamera;
    this._patchSessionState({
      useRecordedCsvCamera: nextCsvCamera,
      cachedSuffixCameraPlan: null,
      cachedSmoothnessSummary: null,
      cachedAnomalyPeaks: null,
    });
    this.refreshCurrentFrameDirectorPose();
  }

  setRecordedCsvCameraMode(useRecordedCsv: boolean): boolean {
    this._patchSessionState({
      useRecordedCsvCamera: Boolean(useRecordedCsv),
      cachedSmoothnessSummary: null,
      cachedAnomalyPeaks: null,
    });
    this.refreshCurrentFrameDirectorPose();
    notifyActiveReplayTimelineController();
    return this.sessionState.useRecordedCsvCamera;
  }

  _analyzeReplayTouchTimeline(options: ReplayTouchAnalysisConfig = {}): void {
    analyzeAndSyncReplayTouchTimelineState(this.sessionState, this.directorCamera, options);
  }

  ensureSuffixCameraPlan(): SuffixDirectorTrajectoryPlan | null {
    const dState = this.directorCamera.state;
    const plan = ensureSuffixCameraPlan(this.sessionState.activeFrames, {
      isNetworkStreamed: this.sessionState.isNetworkStreamed,
      streamedFramesReceived: this.sessionState.streamedFramesReceived,
      expectedDurationTicks: this.sessionState.expectedDurationTicks,
      cachedPlan: this.sessionState.cachedSuffixCameraPlan,
      scoringTeam: this.sessionState.scoringTeam,
      scorerCarIndex: dState.scorerCarIndex ?? this.sessionState.scorerCarIndex ?? 0,
      goalLineFrameIdx: dState.goalLineFrameIdx ?? -1,
      touchEvents: dState.touchEvents || [],
      carTeamResolver: this.sessionState.carTeamResolver,
      lateralBias: dState.lateralBias,
      initialSettledCarPos: dState.initialSettledCarPos,
    });
    this._patchSessionState({ cachedSuffixCameraPlan: plan });
    this.directorCamera.setSuffixCameraPlan(plan);
    return plan;
  }

  private _buildLookaheadInput() {
    const dState = this.directorCamera.state;
    return {
      suffixPlan: this.ensureSuffixCameraPlan(),
      goalLineFrameIdx: dState.goalLineFrameIdx ?? -1,
      scorerCarIndex: dState.scorerCarIndex ?? this.sessionState.scorerCarIndex ?? 0,
      touchEvents: dState.touchEvents || [],
      reboundEvents: dState.reboundEvents || [],
      scoringTeam: this.sessionState.scoringTeam,
      watchAllTouches: this.sessionState.watchAllTouches,
    };
  }

  resolveTouchLookaheadForFrame(frameIdx: number, fallbackScorerCarIndex = 0): ResolvedTouchLookahead {
    return resolveTouchLookaheadForFrame(this._buildLookaheadInput(), frameIdx, fallbackScorerCarIndex);
  }

  resolveFocusCarForFrame(frameIdx: number, fallbackScorerCarIndex = 0): number {
    return resolveFocusCarForFrame(this._buildLookaheadInput(), frameIdx, fallbackScorerCarIndex);
  }

  computeDramaticSlowMoFactor(cursorFloat: number, options: { ignoreScrubState?: boolean } = {}): number {
    const dState = this.directorCamera.state;
    return computeDramaticSlowMoFactor(
      {
        disableSlowMo: this.sessionState.disableSlowMo,
        playbackSpeed: this.sessionState.playbackSpeed,
        isScrubbing: this.sessionState.isScrubbing,
        lastScoringTouchFrameIdx: dState.lastScoringTouchFrameIdx ?? -1,
        goalLineFrameIdx: dState.goalLineFrameIdx ?? -1,
      },
      cursorFloat,
      options
    );
  }

  beginReplaySession(options: ReplaySessionInitOptions = {}): number {
    this.sessionState = buildTimelineReplaySessionInitState({
      ringBuffer: this.ringBuffer,
      engine: this.engine,
      options,
      currentRetainedReplaySeq: this.sessionState.retainedReplaySeq,
    });
    this.directorCamera.reset(
      this.sessionState.isImportedPreview && this.sessionState.useRecordedCsvCamera,
      false,
      false
    );

    this._analyzeReplayTouchTimeline(options);
    this.directorCamera.applyPostAnalysisOverrides(options);
    if (!this.sessionState.isNetworkStreamed && this.sessionState.activeFrames.length > 0) {
      this.ensureSuffixCameraPlan();
    }
    if (this.sessionState.hasRetainedReplay) markReplayTimelineControllerRetained(this);
    setActiveReplayTimelineController(this);
    return this.sessionState.activeFrames.length;
  }

  retainReplaySessionFrames(options: ReplaySessionInitOptions = {}): number {
    const nextState = buildRetainedReplaySessionState(this.sessionState, options);
    if (nextState.activeFrames.length === 0) return 0;
    this.sessionState = nextState;
    this.directorCamera.reset(false, this.sessionState.isPaused, this.sessionState.isScrubbing);

    this._analyzeReplayTouchTimeline(options);
    this.ensureSuffixCameraPlan();
    markReplayTimelineControllerRetained(this);
    setActiveReplayTimelineController(this);
    return this.sessionState.activeFrames.length;
  }

  copyRetainedReplayFrom(
    sourceCtrl:
      | {
          sessionState?: ReplaySessionState;
          directorCamera?: ReplayDirectorCameraSubController;
          directorCameraState?: DirectorCameraState;
        }
      | null
      | undefined
  ): number {
    const srcState = sourceCtrl?.sessionState;
    if (!sourceCtrl || sourceCtrl === this || !srcState || !Array.isArray(srcState.activeFrames) || srcState.activeFrames.length === 0) {
      return 0;
    }
    this.sessionState = buildClonedRetainedReplaySessionState({
      currentSessionState: this.sessionState,
      sourceSessionState: srcState,
    });
    this.directorCamera.cloneFrom(sourceCtrl.directorCamera?.state || sourceCtrl.directorCameraState);
    return this.sessionState.activeFrames.length;
  }

  loadImportedDiagnosticPattern(
    parsedPattern: ImportedDiagnosticPatternInput | null | undefined,
    options: ImportedDiagnosticLoadOptions = {}
  ): number {
    if (!parsedPattern || !Array.isArray(parsedPattern.activeFrames) || parsedPattern.activeFrames.length === 0) {
      return 0;
    }
    const fields = buildImportedDiagnosticPatternSessionState(
      this.sessionState,
      parsedPattern,
      this.sessionState.carTeamResolver,
      options
    );
    this.sessionState = fields.sessionState;
    this._analyzeReplayTouchTimeline({
      scorerCarIndex: this.sessionState.scorerCarIndex,
      carTeamResolver: this.sessionState.carTeamResolver,
    });
    const goalLineFrameIdx = this.directorCamera.applyImportedPatternOverrides(
      parsedPattern,
      this.sessionState.activeFrames,
      this.sessionState.scoringTeam,
      this.sessionState.goalLineFrameIdx
    );
    this._patchSessionState({ goalLineFrameIdx });
    if (!this.sessionState.useRecordedCsvCamera || !parsedPattern.summary || !parsedPattern.anomalyPeaks) {
      this.ensureSuffixCameraPlan();
      this.buildDirectorDiagnosticPatternPayload();
    }
    this._patchSessionState({
      importedSummary: this.sessionState.useRecordedCsvCamera
        ? parsedPattern.summary || this.sessionState.cachedSmoothnessSummary
        : this.sessionState.cachedSmoothnessSummary || parsedPattern.summary || null,
      importedAnomalyPeaks: this.sessionState.useRecordedCsvCamera
        ? parsedPattern.anomalyPeaks || this.sessionState.cachedAnomalyPeaks
        : this.sessionState.cachedAnomalyPeaks || parsedPattern.anomalyPeaks || null,
      cursorFloat: fields.initialCursorFloat,
      lastDispatchedFrameIndex: -1,
    });
    this.refreshCurrentFrameDirectorPose();
    markReplayTimelineControllerRetained(this);
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
    return this.sessionState.activeFrames.length;
  }

  startPreviewSession(options: ReplayPreviewSessionStartOptions = {}): boolean {
    if (!Array.isArray(this.sessionState.activeFrames) || this.sessionState.activeFrames.length === 0) return false;
    const isPaused = Boolean(options.startPaused);
    const shouldResetCursor =
      Boolean(options.restart) || this.sessionState.cursorFloat >= this.sessionState.activeFrames.length - 1;
    this._patchSessionState({
      isActive: true,
      isPersistent: true,
      isLoopingPreview: options.loop !== false,
      isPaused,
      isScrubbing: false,
      lastDispatchedFrameIndex: -1,
      cursorFloat: shouldResetCursor ? 0 : this.sessionState.cursorFloat,
    });

    this.directorCamera.resetSmoothing();
    this.directorCamera.setPauseAndScrubState(isPaused, false);
    this.refreshCurrentFrameDirectorPose();
    const buf = this.getFrameBufferByIndex(this.currentFrameIndex);
    if (buf && this.engine) applyReplayFrameToEngine(this.engine, buf);
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
    return true;
  }

  refreshCurrentFrameDirectorPose(): DirectorCameraPose | null {
    return this.directorCamera.refreshPoseAtCursor({
      totalFrames: this.getTotalRecordedFrames(),
      cursorFloat: this.sessionState.cursorFloat,
      isPaused: this.sessionState.isPaused,
      isScrubbing: this.sessionState.isScrubbing,
      isImportedPreview: this.sessionState.isImportedPreview,
      useRecordedCsvCamera: this.sessionState.useRecordedCsvCamera,
      scoringTeam: this.sessionState.scoringTeam,
      scorerCarIndex: this.sessionState.scorerCarIndex,
      getFrameEntryByIndex: (idx) => this.getFrameEntryByIndex(idx),
      getFrameBufferByIndex: (idx) => this.getFrameBufferByIndex(idx),
      ensureSuffixCameraPlan: () => this.ensureSuffixCameraPlan(),
      resolveTouchLookaheadForFrame: (idx, fb) => this.resolveTouchLookaheadForFrame(idx, fb),
    });
  }

  appendStreamedReplayFrame(
    stateSnapshot: Float32Array | number[],
    serverTick = 0,
    acknowledgedControls: ReplayFrameCarControlEntry[] | null = null
  ): number {
    const count = appendStreamedReplayFrameToState(
      this.sessionState,
      this.directorCamera,
      stateSnapshot,
      serverTick,
      acknowledgedControls
    );
    if (count > 0) {
      markReplayTimelineControllerRetained(this);
      setActiveReplayTimelineController(this);
    }
    return count;
  }

  endReplaySession(): void {
    const hasRetained = resetReplaySessionStateOnEnd(this.sessionState, this.directorCamera);
    if (hasRetained) markReplayTimelineControllerRetained(this);
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
  }

  clearRetainedReplay(): void {
    clearRetainedReplayState(this.sessionState, this.directorCamera);
    if (getActiveReplayTimelineController() === this) notifyActiveReplayTimelineController();
  }

  getFrameEntryByIndex(index: number): ReplayTimelineFrameEntry | null {
    if (this.ActiveWindowCount > 0) {
      return this.sessionState.activeFrames[Math.max(0, Math.min(this.ActiveWindowCount - 1, Math.floor(index)))] || null;
    }
    if (this.ringBuffer && this.ringBuffer.size > 0) {
      return this.ringBuffer.getFrameAt(Math.max(0, Math.min(this.ringBuffer.size - 1, Math.floor(index)))) || null;
    }
    return null;
  }

  getFrameBufferByIndex(index: number): Float32Array | null {
    if (this.ActiveWindowCount > 0) {
      return this.sessionState.activeFrames[Math.max(0, Math.min(this.ActiveWindowCount - 1, Math.floor(index)))]?.snapshot || null;
    }
    if (this.engine && typeof this.engine.getReplayFrameByIndex === 'function') {
      const wasmCount = this.engine.getReplayFrameCount?.() ?? 0;
      if (wasmCount > 0) return this.engine.getReplayFrameByIndex(Math.max(0, Math.min(wasmCount - 1, Math.floor(index))));
    }
    if (this.ringBuffer && this.ringBuffer.size > 0) {
      return this.ringBuffer.getFrameAt(Math.max(0, Math.min(this.ringBuffer.size - 1, Math.floor(index))))?.snapshot || null;
    }
    return null;
  }

  getFrameBufferByOffset(ticksAgo = 0): Float32Array | null {
    const safeOffset = Math.max(0, Math.floor(ticksAgo));
    if (this.ActiveWindowCount > 0) {
      return this.sessionState.activeFrames[Math.max(0, this.ActiveWindowCount - 1 - safeOffset)]?.snapshot || null;
    }
    if (this.engine && typeof this.engine.getReplayFrameByOffset === 'function') {
      const wasmFrame = this.engine.getReplayFrameByOffset(safeOffset);
      if (wasmFrame) return wasmFrame;
    }
    if (this.ringBuffer && this.ringBuffer.size > 0) return this.ringBuffer.getFrameByOffset(safeOffset)?.snapshot || null;
    return null;
  }

  seekToIndex(frameIndex: number, interpolator: ReplayInterpolatorPort | null = null): Float32Array | null {
    const total = this.getTotalRecordedFrames();
    if (total <= 0) return null;
    const clamped = Math.max(0, Math.min(total - 1, Number(frameIndex) || 0));
    const targetIdx = Math.floor(clamped);
    this._patchSessionState({
      cursorFloat: clamped,
      lastDispatchedFrameIndex: targetIdx,
      ...(this.sessionState.isActive ? { isScrubbing: true, isPersistent: true } : {}),
    });
    this.refreshCurrentFrameDirectorPose();

    const buf = this.getFrameBufferByIndex(targetIdx);
    if (this.sessionState.isActive && buf && this.engine) applyReplayFrameToEngine(this.engine, buf, interpolator);
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
    return buf;
  }

  seekByOffset(ticksAgo = 0, interpolator: ReplayInterpolatorPort | null = null): Float32Array | null {
    const total = this.getTotalRecordedFrames();
    return total <= 0
      ? null
      : this.seekToIndex(Math.max(0, Math.min(total - 1, total - 1 - Math.max(0, Math.floor(ticksAgo)))), interpolator);
  }

  seekToNormalized(progress01: number, interpolator: ReplayInterpolatorPort | null = null): Float32Array | null {
    const total = this.getTotalRecordedFrames();
    return total <= 0
      ? null
      : this.seekToIndex(Math.max(0, Math.min(1, Number(progress01) || 0)) * (total - 1), interpolator);
  }

  setPaused(paused: boolean): boolean {
    const isPaused = Boolean(paused);
    this._patchSessionState({
      isPaused,
      isPersistent: isPaused ? true : this.sessionState.isPersistent,
      isScrubbing: isPaused ? this.sessionState.isScrubbing : false,
    });
    this.directorCamera.setPauseAndScrubState(this.sessionState.isPaused, this.sessionState.isScrubbing);
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
    return this.sessionState.isPaused;
  }

  togglePause(): boolean {
    if (!this.sessionState.isPersistent) {
      this._patchSessionState({ isPersistent: true });
      return this.setPaused(true);
    }
    const total = this.getTotalRecordedFrames();
    if (this.sessionState.isPaused && total > 1 && this.sessionState.cursorFloat >= total - 1.05) {
      this._patchSessionState({
        cursorFloat: 0,
        lastDispatchedFrameIndex: -1,
      });
      this.directorCamera.resetSmoothing();
    }
    return this.setPaused(!this.sessionState.isPaused);
  }

  setPlaybackSpeed(speed: number): number {
    const num = Number(speed);
    if (Number.isFinite(num) && num > 0) {
      this._patchSessionState({ playbackSpeed: Math.max(0.1, Math.min(4.0, num)) });
    }
    notifyActiveReplayTimelineController();
    return this.sessionState.playbackSpeed;
  }

  cyclePlaybackSpeed(): number {
    const idx = REPLAY_PLAYBACK_SPEEDS.findIndex((s: number) => Math.abs(s - this.sessionState.playbackSpeed) < 0.01);
    this._patchSessionState({
      playbackSpeed: REPLAY_PLAYBACK_SPEEDS[(idx + 1) % REPLAY_PLAYBACK_SPEEDS.length],
    });
    notifyActiveReplayTimelineController();
    return this.sessionState.playbackSpeed;
  }

  stepPlayback(
    dtSeconds: number,
    interpolator: ReplayInterpolatorPort | null = null,
    applyToEngine = false
  ): ReplayPlaybackStepResult {
    const total = this.getTotalRecordedFrames();
    if (total <= 0) {
      return { frame: null, frameIndex: 0, totalFrames: 0, progress: 0, isFinished: true, incidents: [], audioEvents: [] };
    }
    setActiveReplayTimelineController(this);
    return executeReplayPlaybackStep({
      totalFrames: total,
      dtSeconds,
      interpolator,
      applyToEngine,
      engine: this.engine,
      sessionState: this.sessionState,
      directorCamera: this.directorCamera,
      getFrameEntryByIndex: (idx) => this.getFrameEntryByIndex(idx),
      getFrameBufferByIndex: (idx) => this.getFrameBufferByIndex(idx),
      ensureSuffixCameraPlan: () => this.ensureSuffixCameraPlan(),
      resolveTouchLookaheadForFrame: (idx, fb) => this.resolveTouchLookaheadForFrame(idx, fb),
      computeDramaticSlowMoFactor: (cursor, opts) => this.computeDramaticSlowMoFactor(cursor, opts),
    });
  }

  private _buildDiagnosticInput(): ReplayDirectorDiagnosticInput {
    return buildReplayDiagnosticInput({
      totalFrames: this.getTotalRecordedFrames(),
      activeWindowCount: this.ActiveWindowCount,
      currentFrameIndex: this.currentFrameIndex,
      progress: this.progress,
      sessionState: this.sessionState,
      directorCamera: this.directorCamera,
      getFrameEntryByIndex: (idx) => this.getFrameEntryByIndex(idx),
      getFrameBufferByIndex: (idx) => this.getFrameBufferByIndex(idx),
      ensureSuffixCameraPlan: () => this.ensureSuffixCameraPlan(),
      resolveTouchLookaheadForFrame: (idx, fb) => this.resolveTouchLookaheadForFrame(idx, fb),
      computeDramaticSlowMoFactor: (cursor, opts) => this.computeDramaticSlowMoFactor(cursor, opts),
    });
  }

  getCurrentFrameDiagnosticSnapshot(): ReturnType<typeof buildCurrentFrameDiagnosticSnapshot> {
    if (
      !this.sessionState.isNetworkStreamed &&
      this.sessionState.activeFrames.length > 0 &&
      !this.sessionState.cachedSmoothnessSummary
    ) {
      this.buildDirectorDiagnosticPatternPayload();
    }
    return buildCurrentFrameDiagnosticSnapshot(this._buildDiagnosticInput());
  }

  buildDirectorDiagnosticPatternPayload(
    options: DirectorDiagnosticPatternOptions = {}
  ): ReturnType<typeof evaluateDirectorDiagnosticPatternPayload> extends { payload: infer P } | null ? P | null : never {
    const res = evaluateDirectorDiagnosticPatternPayload(this._buildDiagnosticInput(), options);
    if (!res) return null;
    this._patchSessionState({
      cachedSmoothnessSummary: res.trajectorySmoothnessSummary,
      cachedAnomalyPeaks: res.anomalyPeaks,
    });
    return res.payload;
  }

  buildDirectorDiagnosticPatternCsv(options: DirectorPatternSerializerOptions = {}): string {
    return buildDirectorDiagnosticPatternCsv(this, options);
  }

  buildDirectorFrameWindowDiagnostic(windowRadius = 15): ReturnType<typeof buildDirectorFrameWindowDiagnostic> {
    return buildDirectorFrameWindowDiagnostic(this, windowRadius);
  }
}

export default ReplayTimelineController;
