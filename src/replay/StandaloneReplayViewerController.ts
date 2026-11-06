/**
 * StandaloneReplayViewerController.ts
 * Drives the standalone Replay Viewer floating window (accessible from Self-Training -> Replay Viewer).
 * Delegates roster/POV/loadout state to ReplayViewerRosterSubController, causal hybrid physics
 * stepping to ReplayCausalHybridEngine, and 3-2-1-GO takeover countdowns to ReplayTakeoverSubController.
 */

import { getRetainedMatchReplay, parseRCReplayFile } from './ReplayFileExporter.ts';
import {
  ReplayViewerRosterSubController,
  type ReplayRosterExtractionInput,
  type ReplayRosterMetadataLike,
} from './ReplayViewerRosterSubController.ts';
import {
  getNormalizedReplayFrameSlot,
  ReplayCausalHybridEngine,
  type ReplayCausalTimelineSource,
  type NormalizedReplayFrameSlot,
  type ReplayFrameSlotLike,
} from './ReplayCausalHybridEngine.ts';
import {
  executeLiveFreeplayHandoff,
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
import { ReplayHotkeySubController } from './ReplayHotkeySubController.ts';
import { cloneRetainedMatchReplayPayload, type ReplayAnnotatedFloat32Frame } from './replayDataPayloadPipeline.ts';
import {
  useReplayViewerStore, quickNotification, pushOngoingNotification,
  completeOngoingNotification, dismissOngoingNotification,
} from '../game/runtimeUiPort.ts';
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
  public readonly causalHybridEngine = new ReplayCausalHybridEngine();
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
      this._isViewerWindowOpen();
    });
  }

  public detach(): void {
    this._unsubscribeFloating?.();
    this._unsubscribeFloating = null;
    this.hotkeySubController.unbind();
  }

  public getViewerState(): string { return useReplayViewerStore.getState().viewerState; }

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

  private _isViewerWindowOpen(): boolean {
    const st = useReplayViewerStore.getState();
    return this.hotkeySubController.checkWindowOpenAndPriority(
      { isWindowOpen: Boolean(st.isWindowOpen), hasHotkeyPriority: Boolean(st.hasHotkeyPriority) },
      VIEWER_HOTKEY_CONFLICT_MSG
    );
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

  private _buildRosterInput(frameOverride: Float32Array | null = null): ReplayRosterExtractionInput {
    return {
      metadata: this.metadata,
      recordedSignals: this.signalTimeline?.getRecordedSignals?.() || null,
      firstFrame: frameOverride || this.frames[0] || null,
    };
  }

  public _resolveReplayRosterAndApplyArena(): void {
    this.rosterSubController.resolveAndApplyToArena(this._buildRosterInput(), this.runtime);
  }

  public _restoreRecordedReplayLoadoutsIfNeeded(): void {
    this.rosterSubController.restoreRecordedLoadoutsIfNeeded(this.runtime);
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

  public _syncArenaCarCountForFrame(frame: Float32Array): void {
    this.scoreboardSynchronizer.syncArenaCarCountForFrame(
      this.runtime,
      this.rosterSubController.resolvedRoster.length,
      frame
    );
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

  private _buildTimelineStorePatch(): Record<string, unknown> {
    return this.scoreboardSynchronizer.buildTimelineStorePatch(this);
  }

  public _syncScoreboardAndClockAtFrame(idx: number): void {
    this.scoreboardSynchronizer.syncScoreboardAndClockAtFrame(
      this.signalTimeline,
      this.metadata,
      this.rosterSubController.activePovTeam,
      idx
    );
  }

  public _applyFrameAtCursor(
    smoothStep: boolean = false,
    dispatchEvents: boolean = false,
    restoreOptions: { preserveEngineTick?: boolean; overrideTick?: number } = { preserveEngineTick: true }
  ): void {
    this.scoreboardSynchronizer.applyFrameAtCursor(this, smoothStep, dispatchEvents, restoreOptions);
  }

  private _buildCausalDataSource(): ReplayCausalTimelineSource {
    return {
      frames: this.frames, frameSlots: this.frameSlots,
      stateInputTimeline: this.stateInputTimeline, incidentTimeline: this.incidentTimeline,
    };
  }

  public _getNormalizedFrameSlotAt(frameIndex: number): NormalizedReplayFrameSlot | null {
    return getNormalizedReplayFrameSlot(this._buildCausalDataSource(), frameIndex);
  }

  private _initCausalHybridSync(): void {
    this.causalHybridEngine.beginIntervention(this.rosterSubController.activePovCarIndex);
  }

  private _updateCausalHybridSyncBeforeStep(currentReplayFrameIndex: number): void {
    this.causalHybridEngine.stepBeforePhysics({
      source: this._buildCausalDataSource(),
      physics: this.runtime?.physics,
      currentReplayFrameIndex,
      activePovCarIndex: this.rosterSubController.activePovCarIndex,
      rosterCount: this.rosterSubController.resolvedRoster.length,
    });
  }

  public _prepareRuntimeForReplayViewer(): void {
    this.mode = this.scoreboardSynchronizer.prepareRuntimeForSession(
      this.runtime, this.mode, () => this._restoreRecordedReplayLoadoutsIfNeeded(),
    );
  }

  private _applyNonPovRecordedControlsAtFrame(frameIndex: number): void {
    this.causalHybridEngine.applyNonPovRecordedControls({
      source: this._buildCausalDataSource(),
      physics: this.runtime?.physics,
      frameIndex,
      activePovCarIndex: this.rosterSubController.activePovCarIndex,
      rosterCount: this.rosterSubController.resolvedRoster.length,
      neutralControls: this.runtime?.neutralControls || {},
    });
  }

  public _handoffToLiveFreeplay(targetIdx: number): void {
    const r = this.runtime;
    if (!r?.physics || this.frames.length === 0) return;
    const freeplayMode = this.mode || r.modeManager?.modes?.get?.('freeplay') || null;
    executeLiveFreeplayHandoff({
      runtime: r, freeplayMode, targetIdx, fallbackLastTouchTick: 'baseTick',
      getHistorySlotAt: (idx: number) => this._getNormalizedFrameSlotAt(idx),
      onBeforeReconstruct: (liveTick: number) => {
        this._applyUserLoadoutToTakenOverCar(this.rosterSubController.activePovCarIndex);
        this.takeoverSubController.beginIntervention(targetIdx);
        this._initCausalHybridSync();
        r.physics?.setUnlimitedBoost?.(false);
        this._applyFrameAtCursor(false, false, { overrideTick: liveTick });
      },
      onAfterReconstruct: () => {
        this.scoreboardSynchronizer.configureLiveFreeplayViewerHandoff(
          r,
          this.rosterSubController.resolvedRoster,
          this.rosterSubController.activePovCarIndex,
          this.rosterSubController.activePovTeam
        );
        this._applyNonPovRecordedControlsAtFrame(targetIdx + 1);
      },
    });
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
    this.causalHybridEngine.clear();
    this.frames = frames;
    this.frameSlots = frameSlots;
    this._bindTimelines(timelines, metadata);
    this._resolveReplayRosterAndApplyArena();
    this.takeoverSubController.reset(0, Math.max(0, this.frames.length - 1));
    this.scoreboardSynchronizer.lastDispatchedCursorFrame = -1;
    this._applyFrameAtCursor(false, false);
    emitSystemControlTransition(
      this.runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      0,
      0,
      this.runtime?.physics?.saveCompactState?.()
    );
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
      ...this._buildTimelineStorePatch(),
    });
  }

  public returnToReplay(): void {
    if (this.frames.length === 0) return;
    const r = this.runtime;
    this._prepareRuntimeForReplayViewer();
    const restoreIdx = this.takeoverSubController.seekToFrame(
      this.takeoverSubController.targetFrame || this.takeoverSubController.cursor || 0,
      this.frames.length
    );
    this.scoreboardSynchronizer.lastDispatchedCursorFrame = restoreIdx;
    this._applyFrameAtCursor(false, false);
    emitSystemControlTransition(
      r,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      restoreIdx,
      0,
      r?.physics?.saveCompactState?.()
    );
    this._silenceContinuousAudio();
    r?.camera?.resetView?.();

    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'paused', cursorFrame: restoreIdx, targetFrame: restoreIdx, prerollRemainingSec: 0,
    });
  }

  public async handleUploadFile(file: File | null | undefined): Promise<void> {
    if (!file) return;
    const store = useReplayViewerStore.getState();
    store.setErrorMessage(null);
    store.updateLiveTelemetry({ isLoadingReplay: true });
    const ongoingId = 'replay-viewer-load';
    pushOngoingNotification({
      id: ongoingId, content: `Loading replay "${file.name}"...`, icon: 'loader-2', isSpinningIcon: true,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await parseRCReplayFile(file);
      if (!result.frames || result.frames.length === 0) {
        throw new Error('Replay file contains 0 frames.');
      }
      this._initializeLoadedReplaySession(
        result.frames,
        result.frameSlots || [],
        (result.timelines as ReplayScoreboardTimelinesBundle) || null,
        (result.metadata as ReplayRosterMetadataLike) || null,
        file.name,
        true
      );
      completeOngoingNotification(ongoingId, {
        content: `Loaded replay "${file.name}" (${this.frames.length} frames).`,
        tone: 'info', duration: 2400,
      });
    } catch (err: unknown) {
      console.error('[StandaloneReplayViewerController] Failed to parse uploaded replay file:', err);
      const msg = err instanceof Error ? err.message : 'Failed to parse replay file.';
      dismissOngoingNotification(ongoingId);
      store.updateLiveTelemetry({ isLoadingReplay: false });
      store.setErrorMessage(msg);
      quickNotification.error(msg);
    }
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
    emitSystemControlTransition(
      this.runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      clamped,
      0,
      this.runtime?.physics?.saveCompactState?.()
    );
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
    emitSystemControlTransition(
      this.runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      clamped,
      0,
      this.runtime?.physics?.saveCompactState?.()
    );
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
    emitSystemControlTransition(
      this.runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      clamped,
      0,
      this.runtime?.physics?.saveCompactState?.()
    );
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
    emitSystemControlTransition(
      this.runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      nextIdx,
      0,
      this.runtime?.physics?.saveCompactState?.()
    );
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
    const r = this.runtime;
    const store = useReplayViewerStore.getState();
    const downSec = store.downCounterSec ?? 0;
    const minRequiredFrames = downSec === 0 ? 120 : 240;
    if (!r?.physics || this.frames.length < minRequiredFrames) return;

    this._prepareRuntimeForReplayViewer();
    const baseCursor =
      store.viewerState === 'intervening' || store.viewerState === 'preroll-countdown'
        ? this.takeoverSubController.targetFrame
        : Math.round(this.takeoverSubController.cursor);
    const audio = r?.options?.gameAudio || gameAudio;
    const { targetIdx, startIdx, remSec } = this.takeoverSubController.beginPrerollCountdown(
      this.frames.length, baseCursor, downSec, audio
    );
    this.scoreboardSynchronizer.lastDispatchedCursorFrame = startIdx;
    r.physics.setUnlimitedBoost?.(false);
    this._applyFrameAtCursor(false, false);
    r.simulationStage?.resetActionStates?.();
    emitSystemControlTransition(
      r,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      targetIdx,
      remSec,
      r.physics?.saveCompactState?.()
    );

    store.updateLiveTelemetry({
      viewerState: 'preroll-countdown', cursorFrame: startIdx, targetFrame: targetIdx, prerollRemainingSec: remSec,
    });
  }

  public clearReplay(): void {
    this._silenceContinuousAudio();
    this.frames = [];
    this.frameSlots = [];
    this.rosterSubController.clear();
    this.causalHybridEngine.clear();
    this.takeoverSubController.reset(0, 0);
    this._bindTimelines(null, null);
    this.scoreboardSynchronizer.reset();
    this.scoreboardSynchronizer.resetArenaAfterClear(this.runtime);
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'idle', loadedFileName: null, totalFrames: 0, cursorFrame: 0, targetFrame: 0,
      stateTrackCount: 0, incidentTrackCount: 0, signalTrackCount: 0, recordedSignalCount: 0,
      synthesizedSignalCount: 0, incidentMarkers: [], signalMarkers: [], prerollRemainingSec: 0,
      activePovCarIndex: 0, activePovSlotKey: 1, activePovTeam: 0, errorMessage: null,
    });
  }

  public onBeforePhysicsTick(): boolean {
    const r = this.runtime;
    const store = useReplayViewerStore.getState();
    const state = store.viewerState;
    if (state === 'idle' || this.frames.length === 0) return true;

    if (state === 'intervening') {
      if (r?.keyboard && r.keyboard.ballControlEnabled) r.keyboard.ballControlEnabled = false;
      if (r?.physics) {
        const replayFrameIdx = this.takeoverSubController.consumeInterventionReplayFrameIndex();
        this._updateCausalHybridSyncBeforeStep(replayFrameIdx);
        this._applyNonPovRecordedControlsAtFrame(replayFrameIdx + 1);
      }
      return true;
    }

    if (state === 'paused') return false;

    if (state === 'playing') {
      return this.takeoverSubController.stepPlaying({
        totalFrames: this.frames.length,
        effectiveFlowPct: store.effectiveFlowPct || 100,
        onApplyFrameAtCursor: (cursorIdx: number) => {
          this._applyFrameAtCursor(true, true, { preserveEngineTick: true });
          emitSystemControlTransition(
            r,
            SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
            cursorIdx,
            0,
            r?.physics?.saveCompactState?.()
          );
        },
        onPlaybackFinished: (finalFrame: number) => {
          this._silenceContinuousAudio();
          store.updateLiveTelemetry({ viewerState: 'paused', cursorFrame: finalFrame, targetFrame: finalFrame });
        },
        onUpdatePlayTelemetry: (cursorFrame: number) =>
          store.updateLiveTelemetry({ cursorFrame, targetFrame: cursorFrame }),
      });
    }
    if (state === 'rewinding' || state === 'forwarding') {
      return this.takeoverSubController.stepScrub({
        direction: state,
        totalFrames: this.frames.length,
        effectiveFlowPct: store.effectiveFlowPct || 100,
        throttleUiSync: true,
        onApplyFrameAtCursor: (cursorIdx: number, isForwarding: boolean) => {
          this._applyFrameAtCursor(false, isForwarding, { preserveEngineTick: true });
          emitSystemControlTransition(
            r,
            SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
            cursorIdx,
            0,
            r?.physics?.saveCompactState?.()
          );
        },
        onUpdateScrubTelemetry: (cursorFrame: number) =>
          store.updateLiveTelemetry({ cursorFrame, targetFrame: cursorFrame }),
      });
    }
    if (state === 'preroll-countdown') {
      return this.takeoverSubController.stepPrerollCountdown({
        totalFrames: this.frames.length,
        downCounterSec: store.downCounterSec ?? 0,
        displayedRemainingSec: store.prerollRemainingSec ?? 0,
        audio: r?.options?.gameAudio || gameAudio,
        onApplyFrameAtCursor: () => {
          this._applyFrameAtCursor(true, true, { preserveEngineTick: true });
          const snap = r?.physics?.saveCompactState?.();
          if (snap) void r?.authoritativeServer?.sim?.restoreState?.(snap);
        },
        onHandoffToLiveFreeplay: (targetIdx: number) => {
          this._handoffToLiveFreeplay(targetIdx);
          store.updateLiveTelemetry({
            viewerState: 'intervening', cursorFrame: targetIdx, targetFrame: targetIdx, prerollRemainingSec: 0,
          });
        },
        onUpdateCountdownTelemetry: (cursorFrame: number, remainingSec: number) =>
          store.updateLiveTelemetry({ cursorFrame, prerollRemainingSec: remainingSec }),
      });
    }

    return true;
  }
}
