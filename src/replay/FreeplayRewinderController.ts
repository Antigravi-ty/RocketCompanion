/**
 * FreeplayRewinderController.ts
 * Drives the standalone Rewinder Configurator floating window ('rewinder-configurator') in Free Play.
 * Delegates 3-2-1-GO countdowns and scrub accumulators to ReplayTakeoverSubController,
 * and live Free Play handoff, incident markers, and frame buffer recording to RewinderHandoffAndMarkerController.
 */

import { useAppStore, useRewinderStore } from '../game/runtimeUiPort.ts';
import { ReplayTakeoverSubController } from './ReplayTakeoverSubController.ts';
import { ReplayHotkeySubController } from './ReplayHotkeySubController.ts';
import {
  RewinderHandoffAndMarkerController,
  exportRewinderReplay,
  type FreeplayRewinderRuntimePort,
  type FreeplayRewinderModePort,
  type RewinderFrameEntry,
  type RewinderIncidentRecord,
} from './RewinderHandoffAndMarkerController.ts';
import { gameAudio } from '../audio/GameAudioEngineFacade.ts';

export type { RewinderFrameEntry, FreeplayRewinderRuntimePort, FreeplayRewinderModePort };

const REWINDER_HOTKEY_CONFLICT_MSG =
  '[FreeplayRewinderController] Cannot bind Rewinder Configurator hotkeys (O/P/[/]/G): Replay Viewer window is already open and claimed the hotkeys first.';

export class FreeplayRewinderController {
  public runtime: FreeplayRewinderRuntimePort | null;
  public mode: FreeplayRewinderModePort | null;
  public rewinderFrames: RewinderFrameEntry[] = [];
  public timelines: Record<string, unknown> | null = null;
  public readonly takeoverSubController = new ReplayTakeoverSubController();
  public readonly hotkeySubController = new ReplayHotkeySubController();
  public readonly handoffAndMarkerController = new RewinderHandoffAndMarkerController();
  private _unsubscribeFloating: (() => void) | null = null;

  constructor(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null = null
  ) {
    this.runtime = runtime;
    this.mode = mode;
  }

  public get rewinderCursor(): number {
    return this.takeoverSubController.cursor;
  }
  public set rewinderCursor(v: number) {
    this.takeoverSubController.cursor = v;
  }
  public get rewinderTargetFrame(): number {
    return this.takeoverSubController.targetFrame;
  }
  public set rewinderTargetFrame(v: number) {
    this.takeoverSubController.targetFrame = v;
  }

  public attach(): void {
    const rewinder = this;
    const store = useRewinderStore.getState();
    store.setRuntimeHandlers({
      ...store.runtimeHandlers,
      onRewinderStartRecording() {
        rewinder.startNewRecording();
      },
      onRewinderStopRecording() {
        rewinder.stopRecording();
      },
      onRewinderPushBackwardStart() {
        rewinder.beginScrub('rewinding');
      },
      onRewinderPushBackwardStop() {
        rewinder.pauseScrub();
      },
      onRewinderPushForwardStart() {
        rewinder.beginScrub('forwarding');
      },
      onRewinderPushForwardStop() {
        rewinder.pauseScrub();
      },
      onRewinderResumeFromHere() {
        rewinder.resumeFromCursor();
      },
      onRewinderClearBuffer() {
        rewinder.clearBuffer();
      },
      onRewinderCancelToFreeplay() {
        rewinder.clearBuffer();
      },
      onRewinderExportReplay() {
        return rewinder.exportReplay();
      },
      onRewinderImportReplay(file: File) {
        return rewinder.importReplay(file);
      },
      onRewinderSeekFrame(idx: number) {
        rewinder.seekFrame(idx);
      },
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

  private _ensureFreeplayMode(actionName: string): boolean {
    const currentMode = this.runtime?.match?.state?.mode || 'freeplay';
    const online = useAppStore.getState().onlineSession;
    const isOnlineActive = Boolean(
      online?.isHosting ||
      online?.signalingConnected ||
      online?.roomId ||
      this.runtime?.isBotMatch ||
      this.runtime?.botCoordinator?.isBotMatch
    );
    if (isOnlineActive || (currentMode !== 'freeplay' && currentMode !== 'dev-test-lab')) {
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
    (this.runtime?.options?.gameAudio || gameAudio)?.silenceAll?.();
  }

  public get isBlockingLivePhysics(): boolean {
    const st = useRewinderStore.getState().rewinderState;
    return (
      st === 'rewinding' ||
      st === 'forwarding' ||
      st === 'paused-scrub' ||
      st === 'preroll-countdown'
    );
  }

  private _bindHotkeys(): void {
    const rewinder = this;
    this.hotkeySubController.bindFreeplayRewinderHotkeys({
      getRuntime() {
        return rewinder.runtime;
      },
      getWindowStatus() {
        const st = useRewinderStore.getState();
        return {
          isWindowOpen: Boolean(st.rewinderWindowOpen),
          hasHotkeyPriority: Boolean(st.rewinderHasHotkeyPriority),
        };
      },
      conflictErrorMessage: REWINDER_HOTKEY_CONFLICT_MSG,
      commandTarget: rewinder,
    });
  }

  public applyFrameAtCursor(
    smoothStep: boolean = false,
    restoreOptions: { preserveEngineTick?: boolean; overrideTick?: number } = {
      preserveEngineTick: true,
    }
  ): RewinderFrameEntry | null {
    return this.handoffAndMarkerController.applyFrameAtCursor(
      this.runtime,
      this.rewinderFrames,
      this.rewinderCursor,
      smoothStep,
      restoreOptions
    );
  }

  public _returnToLivePlayFromScrub(): void {
    const idx = Math.max(
      0,
      Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor))
    );
    this.handoffAndMarkerController.executeHandoffToLiveFreeplay(
      this.runtime,
      this.mode,
      this.rewinderFrames,
      idx,
      this.rewinderCursor
    );
    useRewinderStore.getState().updateLiveTelemetry({
      rewinderState: this.rewinderFrames.length > 0 ? 'stopped' : 'idle',
      rewinderPrerollRemainingSec: 0,
    });
  }

  public startNewRecording(): void {
    if (!this._ensureFreeplayMode('startNewRecording')) return;
    const r = this.runtime;
    if (!r?.physics) return;

    this.handoffAndMarkerController.exitGoalOrReplayIfNeeded(r, this.mode);
    if (this.isBlockingLivePhysics && this.rewinderFrames.length > 0) {
      const idx = Math.max(
        0,
        Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor))
      );
      this.handoffAndMarkerController.executeHandoffToLiveFreeplay(
        r,
        this.mode,
        this.rewinderFrames,
        idx,
        this.rewinderCursor
      );
    }

    r.physics.clearEvents?.();
    r.physics.resetGoalLatch?.();
    r._clientGoalIncidentLatched = false;
    r.simulationStage?.resetActionStates?.();
    if (r.keyboard) r.keyboard.ballControlEnabled = true;

    this.rewinderFrames = [];
    this.takeoverSubController.reset(0, 0);
    this.handoffAndMarkerController.clearPendingIncidents();
    r.physics.clearReplayBuffer?.();

    useRewinderStore.getState().updateLiveTelemetry({
      rewinderState: 'recording',
      rewinderRecordedFrames: 0,
      rewinderCursorFrame: 0,
      rewinderTargetFrame: 0,
      rewinderPrerollRemainingSec: 0,
    });
  }

  public stopRecording(): void {
    if (!this._ensureFreeplayMode('stopRecording')) return;
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'recording') {
      const lastFrame = Math.max(0, this.rewinderFrames.length - 1);
      this.takeoverSubController.reset(lastFrame, lastFrame);
      store.updateLiveTelemetry({
        rewinderState: 'stopped',
        rewinderRecordedFrames: this.rewinderFrames.length,
        rewinderCursorFrame: lastFrame,
        rewinderTargetFrame: lastFrame,
        rewinderPrerollRemainingSec: 0,
      });
    } else if (this.isBlockingLivePhysics) {
      this._returnToLivePlayFromScrub();
    }
  }

  public beginScrub(direction: 'rewinding' | 'forwarding' = 'rewinding'): void {
    if (!this._ensureFreeplayMode(`beginScrub(${direction})`) || this.rewinderFrames.length === 0)
      return;
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'recording') {
      const lastIdx = this.rewinderFrames.length - 1;
      this.takeoverSubController.reset(lastIdx, lastIdx);
    } else if (store.rewinderState === 'preroll-countdown') {
      this.rewinderCursor = this.rewinderTargetFrame;
    }

    const nextIdx = this.takeoverSubController.beginScrub(
      direction,
      this.rewinderFrames.length,
      store.rewinderEffectiveFlowPct || 100
    );
    this.handoffAndMarkerController.applyFrameAndEmitStateOnly(
      this.runtime,
      this.mode,
      this.rewinderFrames,
      nextIdx,
      true
    );
    store.updateLiveTelemetry({
      rewinderState: direction,
      rewinderRecordedFrames: this.rewinderFrames.length,
      rewinderCursorFrame: nextIdx,
      rewinderTargetFrame: nextIdx,
      rewinderPrerollRemainingSec: 0,
    });
  }

  public pauseScrub(): void {
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'rewinding' || store.rewinderState === 'forwarding') {
      const clamped = this.takeoverSubController.seekToFrame(
        this.rewinderCursor,
        this.rewinderFrames.length
      );
      this.handoffAndMarkerController.applyFrameAndEmitStateOnly(
        this.runtime,
        this.mode,
        this.rewinderFrames,
        clamped,
        false
      );
      this._silenceContinuousAudio();
      store.updateLiveTelemetry({
        rewinderState: 'paused-scrub',
        rewinderCursorFrame: clamped,
        rewinderTargetFrame: clamped,
      });
    }
  }

  public seekFrame(frameIndex: number): void {
    if (!this._ensureFreeplayMode('seekFrame') || this.rewinderFrames.length === 0) return;
    const clamped = this.takeoverSubController.seekToFrame(frameIndex, this.rewinderFrames.length);
    this.handoffAndMarkerController.applyFrameAndEmitStateOnly(
      this.runtime,
      this.mode,
      this.rewinderFrames,
      clamped,
      true
    );
    this._silenceContinuousAudio();
    useRewinderStore.getState().updateLiveTelemetry({
      rewinderState: 'paused-scrub',
      rewinderCursorFrame: clamped,
      rewinderTargetFrame: clamped,
      rewinderPrerollRemainingSec: 0,
    });
  }

  public resumeFromCursor(): void {
    if (!this._ensureFreeplayMode('resumeFromCursor')) return;
    this.handoffAndMarkerController.beginResumePreroll(
      this.runtime,
      this.mode,
      this.rewinderFrames,
      this.takeoverSubController
    );
  }

  public async exportReplay(): Promise<boolean> {
    return exportRewinderReplay(this.rewinderFrames, this.mode, this.runtime);
  }

  public async importReplay(fileOrBuffer: unknown): Promise<boolean> {
    if (!this._ensureFreeplayMode('importReplay')) return false;
    const loaded = await this.handoffAndMarkerController.importReplay(
      fileOrBuffer,
      this.runtime,
      this.mode,
      this.takeoverSubController
    );
    if (!loaded) return false;
    this.rewinderFrames = loaded.frames;
    this.timelines = loaded.timelines;
    return true;
  }

  public clearBuffer(): void {
    const r = this.runtime;
    const wasBlocking = this.isBlockingLivePhysics;
    this.rewinderFrames = [];
    this.timelines = null;
    this.takeoverSubController.reset(0, 0);
    this.handoffAndMarkerController.clearPendingIncidents();
    r?.physics?.clearReplayBuffer?.();
    const canResetArena = this.handoffAndMarkerController.resetArenaCarsIfAllowed(
      r,
      this.mode,
      wasBlocking
    );
    if (r?.keyboard) r.keyboard.ballControlEnabled = canResetArena;
    useRewinderStore.getState().updateLiveTelemetry({
      rewinderState: 'idle',
      rewinderRecordedFrames: 0,
      rewinderCursorFrame: 0,
      rewinderTargetFrame: 0,
      rewinderPrerollRemainingSec: 0,
    });
  }

  public onResetKickoff(): void {
    const r = this.runtime;
    const canResetArena = this.handoffAndMarkerController.resetArenaCarsIfAllowed(
      r,
      this.mode,
      false
    );
    if (this.isBlockingLivePhysics) {
      if (r?.keyboard) r.keyboard.ballControlEnabled = canResetArena;
      useRewinderStore.getState().updateLiveTelemetry({
        rewinderState: this.rewinderFrames.length > 0 ? 'stopped' : 'idle',
        rewinderPrerollRemainingSec: 0,
      });
    }
  }

  public onPhysicsEvent(event: RewinderIncidentRecord | null | undefined): void {
    this.handoffAndMarkerController.recordPhysicsEvent(this.rewinderFrames, event, this.runtime);
  }

  public onBeforePhysicsTick(): boolean {
    const store = useRewinderStore.getState();
    const state = store.rewinderState;
    if (
      state === 'idle' ||
      state === 'recording' ||
      state === 'stopped' ||
      this.rewinderFrames.length === 0
    ) {
      return true;
    }
    if (state === 'paused-scrub') return false;

    if (state === 'rewinding' || state === 'forwarding') {
      const outcome = this.takeoverSubController.stepScrub({
        direction: state,
        totalFrames: this.rewinderFrames.length,
        effectiveFlowPct: store.rewinderEffectiveFlowPct || 100,
      });
      if (outcome.appliedCursor !== null) {
        this.applyFrameAtCursor(false, { preserveEngineTick: true });
      }
      if (outcome.telemetryCursor !== null) {
        store.updateLiveTelemetry({
          rewinderCursorFrame: outcome.telemetryCursor,
          rewinderTargetFrame: outcome.telemetryCursor,
        });
      }
      return false;
    }
    if (state === 'preroll-countdown') {
      const handoff = this.handoffAndMarkerController;
      return handoff.stepPrerollCountdownTick(
        this.runtime,
        this.mode,
        this.rewinderFrames,
        this.takeoverSubController
      );
    }
    return true;
  }

  public onAfterPhysicsTick(): void {
    this.handoffAndMarkerController.recordTickFrame(
      this.runtime,
      this.mode,
      this.rewinderFrames,
      this.takeoverSubController
    );
  }
}
