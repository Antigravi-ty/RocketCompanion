/**
 * FreeplayRewinderController.ts
 * Drives the standalone Rewinder Configurator floating window ('rewinder-configurator') in Free Play.
 * Delegates 3-2-1-GO countdowns, scrub accumulators, and live Free Play handoff to ReplayTakeoverSubController.
 */

import { useAppStore, useRewinderStore, hudStore } from '../game/runtimeUiPort.ts';
import {
  parseRCReplayFile,
  exportStateReplayFile,
  MAX_REWINDER_FRAMES,
} from './ReplayFileExporter.ts';
import {
  executeLiveFreeplayHandoff,
  emitSystemControlTransition,
  SYSTEM_CONTROL_SIGNALS,
  ReplayTakeoverSubController,
} from './ReplayTakeoverSubController.ts';
import {
  ReplayHotkeySubController,
} from './ReplayHotkeySubController.ts';
import {
  buildRewinderFramesFromParsedReplay,
  applyRewinderFrameToPhysics,
  buildRewinderHistorySlotAt,
  recordPhysicsEventIntoRewinderFrames,
  resetRewinderArenaCarsIfAllowed,
  type RewinderFrameEntry,
  type RewinderIncidentRecord,
  type RewinderRuntimePort,
  type RewinderModePort,
} from './replayDataPayloadPipeline.ts';
import { DEFAULT_CAR_CONTROLS } from '../ai/experimental/ExperimentalBotAgent.ts';
import { dispatchReplayFrameEvents } from './ReplayFrameEventDispatcher.ts';
import { gameAudio } from '../audio/GameAudioEngineFacade.ts';

export type { RewinderFrameEntry };

export interface FreeplayRewinderRuntimePort extends RewinderRuntimePort {
  isBotMatch?: boolean;
  botCoordinator?: { isBotMatch?: boolean } | null;
  audioSubsystem?: { resetAudio?: () => void } | null;
  options?: { gameAudio?: { silenceAll?: () => void; play?: (cue: string, volume?: number) => void } | null } | null;
  releaseGoalReplayCameraOverride?: () => void;
  keyboard?: { ballControlEnabled?: boolean } | null;
  playerCarIndex?: number;
  playerControls?: Record<string, unknown>;
  playerThrottle?: number;
  neutralControls?: Record<string, unknown>;
  _clientGoalIncidentLatched?: boolean;
  simulationStage?: { resetActionStates?: () => void } | null;
  [key: string]: unknown;
}

export interface FreeplayRewinderModePort extends RewinderModePort {
  directorPreview?: { isReplayActive?: boolean } | null;
  isGoalReplayActive?: () => boolean;
  goalAndTouch?: {
    getEffectiveGoalResetTicks?: () => number;
    goalResetTicks?: number;
    frozenGoalBallState?: unknown;
    goalIncidentTick?: number;
    lastTouchTick?: number;
  } | null;
  replayController?: { endReplaySession?: () => void } | null;
  replayRingBuffer?: {
    capacityTicks?: number;
    getRecentFrames?: () => Array<Float32Array | Record<string, unknown> | null>;
    clear?: () => void;
    recordFrame?: (
      tick: number,
      snap: Float32Array,
      options?: { acknowledgedControls?: ReadonlyArray<Record<string, unknown> | null | undefined> | null }
    ) => { snapshot?: Float32Array | null } | null;
    appendIncident?: (tick: number, incident: Record<string, unknown>) => void;
  } | null;
  lastTouchTick?: number;
}

const REWINDER_HOTKEY_CONFLICT_MSG =
  '[FreeplayRewinderController] Cannot bind Rewinder Configurator hotkeys (O/P/[/]/G): Replay Viewer window is already open and claimed the hotkeys first.';

export class FreeplayRewinderController {
  public runtime: FreeplayRewinderRuntimePort | null;
  public mode: FreeplayRewinderModePort | null;
  public rewinderFrames: RewinderFrameEntry[] = [];
  public timelines: Record<string, unknown> | null = null;
  public readonly takeoverSubController = new ReplayTakeoverSubController();
  public readonly hotkeySubController = new ReplayHotkeySubController();
  private _pendingFrameIncidents: RewinderIncidentRecord[] = [];
  private _unsubscribeFloating: (() => void) | null = null;

  constructor(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null = null,
  ) {
    this.runtime = runtime;
    this.mode = mode;
  }

  public get rewinderCursor(): number { return this.takeoverSubController.cursor; }
  public set rewinderCursor(v: number) { this.takeoverSubController.cursor = v; }
  public get rewinderTargetFrame(): number { return this.takeoverSubController.targetFrame; }
  public set rewinderTargetFrame(v: number) { this.takeoverSubController.targetFrame = v; }

  public attach(): void {
    const store = useRewinderStore.getState();
    store.setRuntimeHandlers({
      ...store.runtimeHandlers,
      onRewinderStartRecording: () => this.startNewRecording(),
      onRewinderStopRecording: () => this.stopRecording(),
      onRewinderPushBackwardStart: () => this.beginScrub('rewinding'),
      onRewinderPushBackwardStop: () => this.pauseScrub(),
      onRewinderPushForwardStart: () => this.beginScrub('forwarding'),
      onRewinderPushForwardStop: () => this.pauseScrub(),
      onRewinderResumeFromHere: () => this.resumeFromCursor(),
      onRewinderClearBuffer: () => this.clearBuffer(),
      onRewinderCancelToFreeplay: () => this.clearBuffer(),
      onRewinderExportReplay: () => this.exportReplay(),
      onRewinderImportReplay: (file: File) => this.importReplay(file),
      onRewinderSeekFrame: (idx: number) => this.seekFrame(idx),
    });
    this._bindHotkeys();
    this._unsubscribeFloating?.();
    let wasWindowOpen = Boolean(useRewinderStore.getState().rewinderWindowOpen);
    this._unsubscribeFloating = useRewinderStore.subscribe(() => {
      const isNowOpen = Boolean(useRewinderStore.getState().rewinderWindowOpen);
      if (wasWindowOpen && !isNowOpen && this.isBlockingLivePhysics) {
        this._returnToLivePlayFromScrub();
      }
      wasWindowOpen = isNowOpen;
    });
  }

  public detach(): void {
    this._unsubscribeFloating?.();
    this._unsubscribeFloating = null;
    this.hotkeySubController.unbind();
  }

  private _doesRewinderWindowExist(): boolean {
    const st = useRewinderStore.getState();
    return this.hotkeySubController.checkWindowOpenAndPriority(
      {
        isWindowOpen: Boolean(st.rewinderWindowOpen),
        hasHotkeyPriority: Boolean(st.rewinderHasHotkeyPriority),
      },
      REWINDER_HOTKEY_CONFLICT_MSG
    );
  }

  private _ensureFreeplayMode(actionName: string): boolean {
    const currentMode = this.runtime?.match?.state?.mode || 'freeplay';
    const onlineSession = useAppStore.getState().onlineSession;
    const isOnlineActive = Boolean(
      onlineSession?.isHosting ||
        onlineSession?.signalingConnected ||
        onlineSession?.roomId ||
        this.runtime?.isBotMatch ||
        this.runtime?.botCoordinator?.isBotMatch
    );
    const isCompatibleSandboxMode =
      !isOnlineActive &&
      (currentMode === 'freeplay' || currentMode === 'dev-test-lab');
    if (!isCompatibleSandboxMode) {
      console.warn(
        `[FreeplayRewinderController] Cannot execute "${actionName}": active mode is "${currentMode}" (Rewinder Configurator requires offline "freeplay" or "dev-test-lab").`
      );
      return false;
    }
    return true;
  }

  public getRewinderState(): string {
    return useRewinderStore.getState().rewinderState;
  }

  private _silenceContinuousAudio(): void {
    this.runtime?.audioSubsystem?.resetAudio?.();
    const audio = this.runtime?.options?.gameAudio || gameAudio;
    audio?.silenceAll?.();
  }

  public get isBlockingLivePhysics(): boolean {
    const st = useRewinderStore.getState().rewinderState;
    return st === 'rewinding' || st === 'forwarding' || st === 'paused-scrub' || st === 'preroll-countdown';
  }

  private _bindHotkeys(): void {
    this.hotkeySubController.bindFreeplayRewinderHotkeys({
      getRuntime: () => this.runtime,
      getWindowStatus: () => {
        const st = useRewinderStore.getState();
        return {
          isWindowOpen: Boolean(st.rewinderWindowOpen),
          hasHotkeyPriority: Boolean(st.rewinderHasHotkeyPriority),
        };
      },
      conflictErrorMessage: REWINDER_HOTKEY_CONFLICT_MSG,
      onStartNewRecording: () => this.startNewRecording(),
      onStopRecording: () => this.stopRecording(),
      onResumeFromCursor: () => this.resumeFromCursor(),
      onBeginScrub: (direction) => this.beginScrub(direction),
      onPauseScrub: () => this.pauseScrub(),
    });
  }

  private _exitGoalOrReplayIfNeeded(): void {
    const r = this.runtime;
    const m = this.mode;
    if (!r || !m) return;

    const isReplayActive = Boolean(
      m.directorPreview?.isReplayActive || m.isGoalReplayActive?.()
    );
    const goalResetTicks = m.goalAndTouch?.getEffectiveGoalResetTicks?.() ?? m.goalAndTouch?.goalResetTicks ?? 0;

    if (isReplayActive || goalResetTicks > 0 || r.match?.state?.phase !== 'playing') {
      m.replayController?.endReplaySession?.();
      if (m.directorPreview) {
        m.directorPreview.isReplayActive = false;
      }
      if (m.goalAndTouch) {
        m.goalAndTouch.goalResetTicks = 0;
        m.goalAndTouch.frozenGoalBallState = null;
        m.goalAndTouch.goalIncidentTick = -1;
      }
      r.releaseGoalReplayCameraOverride?.();
      if (r.match?.state) r.match.state.phase = 'playing';
      hudStore.getState().setReplayState({ replayPaused: false, replayPersistent: false });
      hudStore.getState().setMatchState({
        matchPhase: 'playing', replayScorerName: null, replayScorerTeam: null,
        replayBallSpeedKph: null, replayAssistName: null,
      });
    }
  }

  public applyFrameAtCursor(
    smoothStep: boolean = false,
    restoreOptions: { preserveEngineTick?: boolean; overrideTick?: number } = { preserveEngineTick: true }
  ): RewinderFrameEntry | null {
    return applyRewinderFrameToPhysics({
      physics: this.runtime?.physics,
      interpolator: this.runtime?.interpolator,
      arena: this.runtime?.arena,
      rewinderFrames: this.rewinderFrames,
      rewinderCursor: this.rewinderCursor,
      smoothStep,
      restoreOptions,
    });
  }

  private _handoffToLiveFreeplay(targetIdx: number): void {
    const r = this.runtime;
    if (!r?.physics || this.rewinderFrames.length === 0) return;
    executeLiveFreeplayHandoff({
      runtime: r,
      freeplayMode: this.mode,
      targetIdx,
      fallbackLastTouchTick: 'minusOne',
      getHistorySlotAt: (idx: number) =>
        buildRewinderHistorySlotAt(this.rewinderFrames, idx, r.playerCarIndex ?? 0),
      onBeforeReconstruct: (liveTick: number) => {
        this._exitGoalOrReplayIfNeeded();
        this.applyFrameAtCursor(false, { overrideTick: liveTick });
      },
      onAfterReconstruct: () => {
        if (r.keyboard) r.keyboard.ballControlEnabled = true;
        if (r.playerControls) r.physics?.setControls?.(r.playerCarIndex || 0, r.playerControls);
      },
    });
  }

  private _returnToLivePlayFromScrub(): void {
    const idx = Math.max(0, Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor)));
    this._handoffToLiveFreeplay(idx);
    useRewinderStore.getState().updateLiveTelemetry({
      rewinderState: this.rewinderFrames.length > 0 ? 'stopped' : 'idle',
      rewinderPrerollRemainingSec: 0,
    });
  }

  public startNewRecording(): void {
    if (!this._ensureFreeplayMode('startNewRecording')) return;
    const r = this.runtime;
    if (!r?.physics) return;

    this._exitGoalOrReplayIfNeeded();
    if (this.isBlockingLivePhysics && this.rewinderFrames.length > 0) {
      const idx = Math.max(0, Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor)));
      this._handoffToLiveFreeplay(idx);
    }

    r.physics.clearEvents?.();
    r.physics.resetGoalLatch?.();
    r._clientGoalIncidentLatched = false;
    r.simulationStage?.resetActionStates?.();
    if (r.keyboard) r.keyboard.ballControlEnabled = true;

    this.rewinderFrames = [];
    this.takeoverSubController.reset(0, 0);
    this._pendingFrameIncidents = [];
    r.physics.clearReplayBuffer?.();

    useRewinderStore.getState().updateLiveTelemetry({
      rewinderState: 'recording', rewinderRecordedFrames: 0, rewinderCursorFrame: 0,
      rewinderTargetFrame: 0, rewinderPrerollRemainingSec: 0,
    });
  }

  public stopRecording(): void {
    if (!this._ensureFreeplayMode('stopRecording')) return;
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'recording') {
      const lastFrame = Math.max(0, this.rewinderFrames.length - 1);
      this.takeoverSubController.reset(lastFrame, lastFrame);
      store.updateLiveTelemetry({
        rewinderState: 'stopped', rewinderRecordedFrames: this.rewinderFrames.length,
        rewinderCursorFrame: lastFrame, rewinderTargetFrame: lastFrame, rewinderPrerollRemainingSec: 0,
      });
    } else if (this.isBlockingLivePhysics) {
      this._returnToLivePlayFromScrub();
    }
  }

  public beginScrub(direction: 'rewinding' | 'forwarding' = 'rewinding'): void {
    if (!this._ensureFreeplayMode(`beginScrub(${direction})`)) return;
    if (this.rewinderFrames.length === 0) return;
    this._exitGoalOrReplayIfNeeded();
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'recording') {
      const lastIdx = this.rewinderFrames.length - 1;
      this.takeoverSubController.reset(lastIdx, lastIdx);
    } else if (store.rewinderState === 'preroll-countdown') {
      this.rewinderCursor = this.rewinderTargetFrame;
    }
    if (this.runtime?.keyboard) this.runtime.keyboard.ballControlEnabled = false;

    const nextIdx = this.takeoverSubController.beginScrub(
      direction,
      this.rewinderFrames.length,
      store.rewinderEffectiveFlowPct || 100
    );
    const entry = this.applyFrameAtCursor(false, { preserveEngineTick: true });
    emitSystemControlTransition(
      this.runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      nextIdx,
      0,
      entry?.compactSnap || this.runtime?.physics?.saveCompactState?.()
    );
    store.updateLiveTelemetry({
      rewinderState: direction, rewinderRecordedFrames: this.rewinderFrames.length,
      rewinderCursorFrame: nextIdx, rewinderTargetFrame: nextIdx, rewinderPrerollRemainingSec: 0,
    });
  }

  public pauseScrub(): void {
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'rewinding' || store.rewinderState === 'forwarding') {
      const clamped = this.takeoverSubController.seekToFrame(this.rewinderCursor, this.rewinderFrames.length);
      const entry = this.applyFrameAtCursor(false, { preserveEngineTick: true });
      emitSystemControlTransition(
        this.runtime,
        SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
        clamped,
        0,
        entry?.compactSnap || this.runtime?.physics?.saveCompactState?.()
      );
      this._silenceContinuousAudio();
      store.updateLiveTelemetry({
        rewinderState: 'paused-scrub', rewinderCursorFrame: clamped, rewinderTargetFrame: clamped,
      });
    }
  }

  public seekFrame(frameIndex: number): void {
    if (!this._ensureFreeplayMode('seekFrame')) return;
    if (!this.rewinderFrames || this.rewinderFrames.length === 0) return;
    this._exitGoalOrReplayIfNeeded();
    if (this.runtime?.keyboard) this.runtime.keyboard.ballControlEnabled = false;
    const clamped = this.takeoverSubController.seekToFrame(frameIndex, this.rewinderFrames.length);
    const entry = this.applyFrameAtCursor(false, { preserveEngineTick: true });
    emitSystemControlTransition(
      this.runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      clamped,
      0,
      entry?.compactSnap || this.runtime?.physics?.saveCompactState?.()
    );
    this._silenceContinuousAudio();
    useRewinderStore.getState().updateLiveTelemetry({
      rewinderState: 'paused-scrub', rewinderCursorFrame: clamped,
      rewinderTargetFrame: clamped, rewinderPrerollRemainingSec: 0,
    });
  }

  public resumeFromCursor(): void {
    if (!this._ensureFreeplayMode('resumeFromCursor')) return;
    const r = this.runtime;
    const store = useRewinderStore.getState();
    const downSec = store.rewinderDownCounterSec ?? 0;
    const minRequiredFrames = downSec === 0 ? 120 : 240;
    if (!r?.physics || this.rewinderFrames.length < minRequiredFrames) return;

    this._exitGoalOrReplayIfNeeded();
    if (r.keyboard) r.keyboard.ballControlEnabled = false;

    if (store.rewinderState === 'recording') {
      const lastFrame = Math.max(0, this.rewinderFrames.length - 1);
      this.takeoverSubController.reset(lastFrame, lastFrame);
    }

    const baseTarget =
      store.rewinderState === 'preroll-countdown' || store.rewinderState === 'stopped'
        ? this.rewinderTargetFrame || this.rewinderCursor
        : this.rewinderCursor;

    const audio = r?.options?.gameAudio || gameAudio;
    const { targetIdx, startIdx, remSec } = this.takeoverSubController.beginPrerollCountdown(
      this.rewinderFrames.length,
      baseTarget,
      downSec,
      audio
    );

    r.physics.setUnlimitedBoost?.(false);
    const entry = this.applyFrameAtCursor(false, { preserveEngineTick: true });
    r.simulationStage?.resetActionStates?.();
    emitSystemControlTransition(
      r,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      targetIdx,
      remSec,
      entry?.compactSnap || r.physics?.saveCompactState?.()
    );

    store.updateLiveTelemetry({
      rewinderState: 'preroll-countdown', rewinderRecordedFrames: this.rewinderFrames.length,
      rewinderCursorFrame: startIdx, rewinderTargetFrame: targetIdx, rewinderPrerollRemainingSec: remSec,
    });
  }

  public async exportReplay(): Promise<boolean> {
    if (this.rewinderFrames && this.rewinderFrames.length > 0) {
      return exportStateReplayFile(this.rewinderFrames);
    }
    const ringFrames = this.mode?.replayRingBuffer?.getRecentFrames?.();
    if (Array.isArray(ringFrames) && ringFrames.length > 0) {
      return exportStateReplayFile(
        ringFrames.filter((f): f is NonNullable<typeof f> => f !== null)
      );
    }
    return false;
  }

  public async importReplay(fileOrBuffer: unknown): Promise<boolean> {
    if (!this._ensureFreeplayMode('importReplay')) return false;
    const r = this.runtime;
    if (!r?.physics) return false;
    try {
      const parsed = await parseRCReplayFile(fileOrBuffer);
      if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) {
        throw new Error('No valid frames found in replay file.');
      }
      this._exitGoalOrReplayIfNeeded();
      this.timelines = parsed.timelines || null;
      this.rewinderFrames = buildRewinderFramesFromParsedReplay(parsed, r.neutralControls);
      const lastIdx = Math.max(0, this.rewinderFrames.length - 1);
      this.takeoverSubController.reset(0, lastIdx);

      if (r.keyboard) r.keyboard.ballControlEnabled = false;
      const entry = this.applyFrameAtCursor(false, { preserveEngineTick: true });
      r.simulationStage?.resetActionStates?.();
      emitSystemControlTransition(
        r,
        SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
        0,
        0,
        entry?.compactSnap || r.physics?.saveCompactState?.()
      );

      useRewinderStore.getState().updateLiveTelemetry({
        rewinderState: 'paused-scrub', rewinderRecordedFrames: this.rewinderFrames.length,
        rewinderCursorFrame: 0, rewinderTargetFrame: lastIdx, rewinderPrerollRemainingSec: 0,
      });
      return true;
    } catch (err) {
      console.error('[FreeplayRewinderController] Failed to import replay file:', err);
      return false;
    }
  }

  public clearBuffer(): void {
    const r = this.runtime;
    const wasBlocking = this.isBlockingLivePhysics;
    this.rewinderFrames = [];
    this.timelines = null;
    this.takeoverSubController.reset(0, 0);
    this._pendingFrameIncidents = [];
    r?.physics?.clearReplayBuffer?.();
    const canResetArena = resetRewinderArenaCarsIfAllowed(r, this.mode, wasBlocking);
    if (r?.keyboard) r.keyboard.ballControlEnabled = canResetArena;
    useRewinderStore.getState().updateLiveTelemetry({
      rewinderState: 'idle', rewinderRecordedFrames: 0, rewinderCursorFrame: 0,
      rewinderTargetFrame: 0, rewinderPrerollRemainingSec: 0,
    });
  }

  public onResetKickoff(): void {
    const r = this.runtime;
    const store = useRewinderStore.getState();
    const canResetArena = resetRewinderArenaCarsIfAllowed(r, this.mode, false);
    if (this.isBlockingLivePhysics) {
      if (r?.keyboard) r.keyboard.ballControlEnabled = canResetArena;
      store.updateLiveTelemetry({
        rewinderState: this.rewinderFrames.length > 0 ? 'stopped' : 'idle',
        rewinderPrerollRemainingSec: 0,
      });
    }
  }

  public onPhysicsEvent(event: RewinderIncidentRecord | null | undefined): void {
    if (!event || useRewinderStore.getState().rewinderState !== 'recording') return;
    recordPhysicsEventIntoRewinderFrames(
      this.rewinderFrames,
      this._pendingFrameIncidents,
      event,
      this.runtime?.physics?.getHeaderView?.()?.tickCount
    );
  }

  public onBeforePhysicsTick(): boolean {
    const r = this.runtime;
    const store = useRewinderStore.getState();
    const state = store.rewinderState;
    if (state === 'idle' || state === 'recording' || state === 'stopped' || this.rewinderFrames.length === 0) {
      return true;
    }
    if (state === 'paused-scrub') return false;

    if (state === 'rewinding' || state === 'forwarding') {
      return this.takeoverSubController.stepScrub({
        direction: state,
        totalFrames: this.rewinderFrames.length,
        effectiveFlowPct: store.rewinderEffectiveFlowPct || 100,
        onApplyFrameAtCursor: () => this.applyFrameAtCursor(false, { preserveEngineTick: true }),
        onUpdateScrubTelemetry: (cursorFrame: number) =>
          store.updateLiveTelemetry({ rewinderCursorFrame: cursorFrame, rewinderTargetFrame: cursorFrame }),
      });
    }
    if (state === 'preroll-countdown') {
      return this.takeoverSubController.stepPrerollCountdown({
        totalFrames: this.rewinderFrames.length,
        downCounterSec: store.rewinderDownCounterSec ?? 0,
        displayedRemainingSec: store.rewinderPrerollRemainingSec ?? 0,
        audio: r?.options?.gameAudio || gameAudio,
        onApplyFrameAtCursor: () => {
          const entry = this.applyFrameAtCursor(true, { preserveEngineTick: true });
          if (entry?.controls && r) {
            r.playerThrottle = Number(entry.controls.throttle ?? 0);
            r.playerControls = { ...entry.controls };
          }
          if (entry?.incidents?.length || entry?.signals?.length || entry?.audioEvents?.length) {
            dispatchReplayFrameEvents(
              { incidents: entry.incidents || [], signals: entry.signals || [], audioEvents: entry.audioEvents || [] },
              r,
            );
          }
        },
        onHandoffToLiveFreeplay: (targetIdx: number) => {
          r?.physics?.setUnlimitedBoost?.(false);
          this._handoffToLiveFreeplay(targetIdx);
          store.updateLiveTelemetry({
            rewinderState: 'stopped', rewinderCursorFrame: targetIdx,
            rewinderTargetFrame: targetIdx, rewinderPrerollRemainingSec: 0,
          });
        },
        onUpdateCountdownTelemetry: (cursorFrame: number, remainingSec: number) =>
          store.updateLiveTelemetry({ rewinderCursorFrame: cursorFrame, rewinderPrerollRemainingSec: remainingSec }),
      });
    }
    return true;
  }

  public onAfterPhysicsTick(): void {
    const r = this.runtime;
    const store = useRewinderStore.getState();
    if (store.rewinderState !== 'recording' || !r?.physics) {
      this._pendingFrameIncidents.length = 0;
      return;
    }

    const compactSnap = r.physics.saveCompactState?.() ?? r.physics.state.slice();
    const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount ?? 0);
    const incidents = this._pendingFrameIncidents.length > 0 ? this._pendingFrameIncidents.slice() : [];
    this._pendingFrameIncidents.length = 0;

    if (this.rewinderFrames.length >= MAX_REWINDER_FRAMES) {
      this.rewinderFrames.shift();
    }
    const lastTouchTick = this.mode?.goalAndTouch?.lastTouchTick ?? -1;
    this.rewinderFrames.push({
      compactSnap,
      renderState: compactSnap,
      controls: { ...(r.playerControls || DEFAULT_CAR_CONTROLS) },
      incidents,
      hadTouch: Boolean(this.mode && lastTouchTick === currentTick),
      lastTouchTick,
    });
    r.physics.recordReplayFrame?.();
    const lastIdx = this.rewinderFrames.length - 1;
    this.rewinderCursor = lastIdx;
    this.rewinderTargetFrame = lastIdx;

    if (this.rewinderFrames.length % 6 === 0 || this.rewinderFrames.length === 120 || this.rewinderFrames.length === 240) {
      store.updateLiveTelemetry({
        rewinderRecordedFrames: this.rewinderFrames.length,
        rewinderCursorFrame: this.rewinderCursor,
        rewinderTargetFrame: this.rewinderTargetFrame,
      });
    }
  }
}
