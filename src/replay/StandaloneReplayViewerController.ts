/**
 * StandaloneReplayViewerController.ts
 * Drives the standalone Replay Viewer floating window (accessible from Self-Training -> Replay Viewer).
 * Delegates roster/POV/loadout state to ReplayViewerRosterSubController, causal hybrid physics
 * and Freeplay handoff to ReplayViewerCausalSyncController, and takeover countdowns to ReplayTakeoverSubController.
 */

import {
  getRetainedMatchReplay,
  parseUploadedReplayFileWithFeedback,
} from './ReplayFileExporter.ts';
import {
  ReplayViewerRosterSubController,
  type ReplayRosterMetadataLike,
} from './ReplayViewerRosterSubController.ts';
import type { ReplayFrameSlotLike } from './ReplayCausalHybridEngine.ts';
import {
  emitSystemControlTransition,
  SYSTEM_CONTROL_SIGNALS,
  ReplayTakeoverSubController,
} from './ReplayTakeoverSubController.ts';
import {
  ReplayScoreboardSynchronizer,
  type ReplayScoreboardRuntimePort,
  type ReplayScoreboardModePort,
  type ReplayScoreboardTimelinesBundle,
  type ReplayScoreboardStateInputTimelinePort,
  type ReplayScoreboardIncidentTimelinePort,
  type ReplayScoreboardSignalTimelinePort,
} from './ReplayScoreboardSynchronizer.ts';
import { ReplayViewerCausalSyncController } from './ReplayViewerCausalSyncController.ts';
import { ReplayHotkeySubController } from './ReplayHotkeySubController.ts';
import {
  cloneRetainedMatchReplayPayload,
  type ReplayAnnotatedFloat32Frame,
} from './replayDataPayloadPipeline.ts';
import { useReplayViewerStore } from '../game/runtimeUiPort.ts';
import { gameAudio } from '../audio/GameAudioEngineFacade.ts';

export type { ReplayAnnotatedFloat32Frame };

const VIEWER_HOTKEY_CONFLICT_MSG =
  '[StandaloneReplayViewerController] Cannot bind Replay Viewer hotkeys (O/P/[/]/G): Rewinder Configurator window is already open and claimed the hotkeys first.';

export class StandaloneReplayViewerController {
  public runtime: ReplayScoreboardRuntimePort | null;
  public mode: ReplayScoreboardModePort | null;
  public frames: ReplayAnnotatedFloat32Frame[] = [];
  public frameSlots: ReplayFrameSlotLike[] = [];
  public timelines: ReplayScoreboardTimelinesBundle | null = null;
  public stateInputTimeline: ReplayScoreboardStateInputTimelinePort | null = null;
  public incidentTimeline: ReplayScoreboardIncidentTimelinePort | null = null;
  public signalTimeline: ReplayScoreboardSignalTimelinePort | null = null;
  public metadata: ReplayRosterMetadataLike | null = null;
  public readonly rosterSubController = new ReplayViewerRosterSubController();
  public readonly causalSyncController = new ReplayViewerCausalSyncController();
  public readonly takeoverSubController = new ReplayTakeoverSubController();
  public readonly scoreboardSynchronizer = new ReplayScoreboardSynchronizer();
  public readonly hotkeySubController = new ReplayHotkeySubController();
  private _unsubscribeFloating: (() => void) | null = null;

  constructor(
    runtime: ReplayScoreboardRuntimePort | null,
    mode: ReplayScoreboardModePort | null = null,
  ) {
    this.runtime = runtime;
    this.mode = mode;
  }

  public attach(): void {
    useReplayViewerStore.getState().setRuntimeHandlers({
      onUploadReplayFile: (file: File) => this.handleUploadFile(file),
      onLoadRetainedMatchReplay: () => this.handleLoadRetainedMatchReplay(),
      onStartPlaying: () => this.startPlaying(),
      onPausePlaying: () => this.pausePlaying(),
      onSeekFrame: (frameIndex: number) => this.seekFrame(frameIndex),
      onPushBackwardStart: () => this.beginScrub('rewinding'),
      onPushBackwardStop: () => this.pauseScrub(),
      onPushForwardStart: () => this.beginScrub('forwarding'),
      onPushForwardStop: () => this.pauseScrub(),
      onResumeFromHere: () => this.resumeFromCursor(),
      onReturnToReplay: () => this.returnToReplay(),
      onSelectPovSlot: (slotKey: number) => this.selectPovSlot(slotKey),
      onClearReplay: () => this.clearReplay(),
    });
    this._bindHotkeys();
    this._unsubscribeFloating?.();
    this._unsubscribeFloating = useReplayViewerStore.subscribe(() => {
      const st = useReplayViewerStore.getState();
      this.hotkeySubController.checkWindowOpenAndPriority(
        { isWindowOpen: Boolean(st.isWindowOpen), hasHotkeyPriority: Boolean(st.hasHotkeyPriority) },
        VIEWER_HOTKEY_CONFLICT_MSG
      );
    });
  }

  public detach(): void {
    this._unsubscribeFloating?.();
    this._unsubscribeFloating = null;
    this.hotkeySubController.unbind();
  }

  public getViewerState(): string {
    return useReplayViewerStore.getState().viewerState;
  }

  public _silenceContinuousAudio(): void {
    this.runtime?.audioSubsystem?.resetAudio?.();
    const audio = this.runtime?.options?.gameAudio || gameAudio;
    audio?.silenceAll?.();
  }

  public get hasLoadedReplay(): boolean {
    const state = useReplayViewerStore.getState().viewerState;
    return state !== 'idle' && this.frames.length > 0;
  }

  public get isActive(): boolean {
    const state = useReplayViewerStore.getState().viewerState;
    return state !== 'idle' && state !== 'intervening' && this.frames.length > 0;
  }

  private _bindHotkeys(): void {
    this.hotkeySubController.bindReplayViewerHotkeys({
      getRuntime: () => this.runtime,
      hasLoadedReplay: () => this.hasLoadedReplay,
      hasFrames: () => this.frames.length > 0,
      getWindowStatus: () => {
        const st = useReplayViewerStore.getState();
        return { isWindowOpen: Boolean(st.isWindowOpen), hasHotkeyPriority: Boolean(st.hasHotkeyPriority) };
      },
      conflictErrorMessage: VIEWER_HOTKEY_CONFLICT_MSG,
      onSelectPovSlot: (slotKey: number) => this.selectPovSlot(slotKey),
      onStartPlaying: () => this.startPlaying(),
      onPausePlaying: () => this.pausePlaying(),
      onResumeFromCursor: () => this.resumeFromCursor(),
      onBeginScrub: (direction) => this.beginScrub(direction),
      onPauseScrub: () => this.pauseScrub(),
    });
  }

  public _applyUserLoadoutToTakenOverCar(
    carIndex: number = this.rosterSubController.activePovCarIndex
  ): void {
    this.rosterSubController.applyUserLoadoutToTakenOverCar(this.runtime, carIndex);
  }

  public selectPovSlot(slotKey: number): void {
    if (!this.hasLoadedReplay) return;
    const r = this.runtime;
    const freeplayMode = this.mode || r?.modeManager?.modes?.get?.('freeplay') || null;
    const wasIntervening = useReplayViewerStore.getState().viewerState === 'intervening';
    const result = this.rosterSubController.selectPovSlot(slotKey, r, freeplayMode, wasIntervening);
    if (result) useReplayViewerStore.getState().updateLiveTelemetry(result);
  }

  private _bindTimelines(
    timelines: ReplayScoreboardTimelinesBundle | null,
    metadata: ReplayRosterMetadataLike | null = null,
  ): void {
    this.timelines = timelines || null;
    this.stateInputTimeline = timelines?.stateInputTimeline || timelines?.stateInput || null;
    this.incidentTimeline = timelines?.incidentTimeline || null;
    this.signalTimeline = timelines?.signalTimeline || null;
    this.metadata = metadata || null;
  }

  public _applyFrameAtCursor(
    smoothStep: boolean = false,
    dispatchEvents: boolean = false,
    restoreOptions: { preserveEngineTick?: boolean; overrideTick?: number } = { preserveEngineTick: true }
  ): void {
    this.scoreboardSynchronizer.applyFrameAtCursor(this, smoothStep, dispatchEvents, restoreOptions);
  }

  private _prepareRuntimeForReplayViewer(): void {
    this.mode = this.causalSyncController.prepareRuntimeForSession(
      this.runtime,
      this.mode,
      () => this.rosterSubController.restoreRecordedLoadoutsIfNeeded(this.runtime),
    );
  }

  private _emitStateTransition(frameIdx: number): void {
    emitSystemControlTransition(
      this.runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      frameIdx,
      0,
      this.runtime?.physics?.saveCompactState?.()
    );
  }

  public _handoffToLiveFreeplay(targetIdx: number): void {
    this.causalSyncController.executeHandoffToLiveFreeplay(this, targetIdx);
  }

  private _initializeLoadedReplaySession(
    frames: ReplayAnnotatedFloat32Frame[],
    frameSlots: ReplayFrameSlotLike[],
    timelines: ReplayScoreboardTimelinesBundle | null,
    metadata: ReplayRosterMetadataLike | null,
    loadedFileName: string,
    resetCameraView: boolean
  ): void {
    this._prepareRuntimeForReplayViewer();
    this.causalSyncController.clear();
    this.frames = frames;
    this.frameSlots = frameSlots;
    this._bindTimelines(timelines, metadata);
    this.rosterSubController.resolveAndApplyToArena(
      {
        metadata: this.metadata,
        recordedSignals: this.signalTimeline?.getRecordedSignals?.() || null,
        firstFrame: this.frames[0] || null,
      },
      this.runtime,
    );
    this.takeoverSubController.reset(0, Math.max(0, this.frames.length - 1));
    this.scoreboardSynchronizer.lastDispatchedCursorFrame = -1;
    this._applyFrameAtCursor(false, false);
    this._emitStateTransition(0);
    this._silenceContinuousAudio();
    if (resetCameraView) this.runtime?.camera?.resetView?.();

    useReplayViewerStore.getState().updateLiveTelemetry({
      isLoadingReplay: false,
      viewerState: 'paused',
      loadedFileName,
      totalFrames: this.frames.length,
      cursorFrame: 0,
      targetFrame: this.takeoverSubController.targetFrame,
      prerollRemainingSec: 0,
      errorMessage: null,
      ...this.scoreboardSynchronizer.buildTimelineStorePatch(this),
    });
  }

  public returnToReplay(): void {
    if (this.frames.length === 0) return;
    this._prepareRuntimeForReplayViewer();
    const restoreIdx = this.takeoverSubController.seekToFrame(
      this.takeoverSubController.targetFrame || this.takeoverSubController.cursor || 0,
      this.frames.length
    );
    this.scoreboardSynchronizer.lastDispatchedCursorFrame = restoreIdx;
    this._applyFrameAtCursor(false, false);
    this._emitStateTransition(restoreIdx);
    this._silenceContinuousAudio();
    this.runtime?.camera?.resetView?.();

    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'paused', cursorFrame: restoreIdx, targetFrame: restoreIdx, prerollRemainingSec: 0,
    });
  }

  public async handleUploadFile(file: File | null | undefined): Promise<void> {
    if (!file) return;
    await parseUploadedReplayFileWithFeedback(file, (result) => {
      this._initializeLoadedReplaySession(
        result.frames,
        result.frameSlots || [],
        (result.timelines as ReplayScoreboardTimelinesBundle) || null,
        (result.metadata as ReplayRosterMetadataLike) || null,
        file.name,
        true
      );
    });
  }

  public handleLoadRetainedMatchReplay(): void {
    const retained = getRetainedMatchReplay();
    const store = useReplayViewerStore.getState();
    if (!retained || !retained.frames || retained.frames.length === 0) {
      console.warn('[StandaloneReplayViewerController] Cannot load retained match replay: no recent match replay in memory.');
      store.setErrorMessage('No recent match replay in memory.');
      return;
    }
    const cloned = cloneRetainedMatchReplayPayload(retained);
    this._initializeLoadedReplaySession(
      cloned.frames, cloned.frameSlots, cloned.timelines, cloned.metadata, cloned.loadedFileName, false
    );
  }

  public startPlaying(): void {
    if (this.frames.length === 0) return;
    if (useReplayViewerStore.getState().viewerState === 'intervening') {
      this.returnToReplay();
    } else {
      this._prepareRuntimeForReplayViewer();
    }
    if (this.takeoverSubController.cursor >= this.frames.length - 1) {
      this.takeoverSubController.cursor = 0;
      this.scoreboardSynchronizer.lastDispatchedCursorFrame = -1;
    }
    const clamped = this.takeoverSubController.seekToFrame(
      this.takeoverSubController.cursor,
      this.frames.length
    );
    this._emitStateTransition(clamped);
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'playing', cursorFrame: clamped, targetFrame: clamped, prerollRemainingSec: 0,
    });
  }

  public pausePlaying(): void {
    if (this.frames.length === 0) return;
    this._prepareRuntimeForReplayViewer();
    const clamped = this.takeoverSubController.seekToFrame(
      this.takeoverSubController.cursor,
      this.frames.length
    );
    this._applyFrameAtCursor(false, false);
    this._emitStateTransition(clamped);
    this._silenceContinuousAudio();
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'paused', cursorFrame: clamped, targetFrame: clamped, prerollRemainingSec: 0,
    });
  }

  public seekFrame(frameIndex: number): void {
    if (this.frames.length === 0) return;
    this._prepareRuntimeForReplayViewer();
    const clamped = this.takeoverSubController.seekToFrame(frameIndex, this.frames.length);
    this._applyFrameAtCursor(false, false);
    this._emitStateTransition(clamped);
    const curState = useReplayViewerStore.getState().viewerState;
    const nextState = curState === 'playing' ? 'playing' : 'paused';
    if (nextState === 'paused') this._silenceContinuousAudio();
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: nextState, cursorFrame: clamped, targetFrame: clamped,
    });
  }

  public beginScrub(direction: 'rewinding' | 'forwarding' = 'rewinding'): void {
    if (this.frames.length === 0) return;
    if (useReplayViewerStore.getState().viewerState === 'intervening') {
      this.returnToReplay();
    } else {
      this._prepareRuntimeForReplayViewer();
    }
    const store = useReplayViewerStore.getState();
    const nextIdx = this.takeoverSubController.beginScrub(
      direction, this.frames.length, store.effectiveFlowPct || 100
    );
    this._applyFrameAtCursor(false, direction === 'forwarding', { preserveEngineTick: true });
    this._emitStateTransition(nextIdx);
    store.updateLiveTelemetry({
      viewerState: direction, cursorFrame: nextIdx, targetFrame: nextIdx, prerollRemainingSec: 0,
    });
  }

  public pauseScrub(): void {
    const store = useReplayViewerStore.getState();
    if (store.viewerState === 'rewinding' || store.viewerState === 'forwarding') {
      this.pausePlaying();
    }
  }

  public resumeFromCursor(): void {
    this.causalSyncController.beginPrerollFromCursor(
      this,
      () => this._prepareRuntimeForReplayViewer(),
      (startIdx: number) => {
        this.scoreboardSynchronizer.lastDispatchedCursorFrame = startIdx;
      },
    );
  }

  public clearReplay(): void {
    this._silenceContinuousAudio();
    this.frames = [];
    this.frameSlots = [];
    this.rosterSubController.clear();
    this.causalSyncController.clear();
    this.takeoverSubController.reset(0, 0);
    this._bindTimelines(null, null);
    this.scoreboardSynchronizer.reset();
    this.causalSyncController.resetArenaAfterClear(this.runtime);
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'idle', loadedFileName: null, totalFrames: 0, cursorFrame: 0, targetFrame: 0,
      stateTrackCount: 0, incidentTrackCount: 0, signalTrackCount: 0, recordedSignalCount: 0,
      synthesizedSignalCount: 0, incidentMarkers: [], signalMarkers: [], prerollRemainingSec: 0,
      activePovCarIndex: 0, activePovSlotKey: 1, activePovTeam: 0, errorMessage: null,
    });
  }

  public onBeforePhysicsTick(): boolean {
    return this.causalSyncController.stepBeforePhysicsTick(this);
  }
}
