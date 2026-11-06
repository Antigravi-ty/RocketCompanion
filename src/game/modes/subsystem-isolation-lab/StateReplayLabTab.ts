import { DEFAULT_CAR_CONTROLS } from '../../../ai/experimental/ExperimentalBotAgent.ts';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import {
  isGlobalHotkeyBlockedByUi,
  subscribeGlobalKeyDown,
  subscribeGlobalKeyUp,
} from '../../../input/hotkeyInputGuard.ts';
import {
  MAX_REWINDER_FRAMES,
  exportStateReplayFile,
  parseRCReplayFile,
} from '../../../replay/ReplayFileExporter.ts';
import {
  useRewinderStore,
  useSubsystemIsolationLabStore,
} from '../../runtimeUiPort.ts';
import type { LabTabContext, LabTabController } from './LabTabTypes.ts';

export interface RewinderFrameEntry {
  [key: string]: unknown;
  compactSnap: any;
  renderState: any;
  controls: Record<string, any>;
  acknowledgedControls?: any[];
  incidents?: any[];
  signals?: any[];
  audioEvents?: any[];
}

export interface PrerollCalculationOutput {
  startIdx: number;
  targetIdx: number;
  remFrames: number;
  remSec: number;
}

export function computeRewinderPrerollWindow(
  totalFrames: number,
  rawCursor: number,
  rawTargetFrame: number,
  downCounterSec: number,
  currentRewinderState: string
): PrerollCalculationOutput {
  const minRequiredFrames = downCounterSec === 0 ? 120 : 240;
  const lastFrame = Math.max(0, totalFrames - 1);

  const effectiveCursor = currentRewinderState === 'recording' ? lastFrame : rawCursor;
  const effectiveTarget = currentRewinderState === 'recording' ? lastFrame : rawTargetFrame;

  const baseTarget =
    currentRewinderState === 'preroll-countdown' || currentRewinderState === 'stopped'
      ? effectiveTarget || effectiveCursor
      : effectiveCursor;

  const targetIdx = Math.max(
    minRequiredFrames - 1,
    Math.min(lastFrame, Math.round(baseTarget))
  );
  const lookbackFrames = (downCounterSec === 0 ? 1 : downCounterSec + 1) * 120;
  const startIdx = Math.max(0, targetIdx - lookbackFrames);
  const remFrames = Math.max(0, targetIdx - startIdx);
  const remSec = Math.ceil(remFrames / 120);

  return {
    startIdx,
    targetIdx,
    remFrames,
    remSec,
  };
}

export class StateReplayLabTab implements LabTabController {
  readonly tabId = 'state-replay' as const;
  private ctx: LabTabContext | null = null;
  private rewinderFrames: RewinderFrameEntry[] = [];
  private rewinderCursor = 0;
  private rewinderTargetFrame = 0;
  private rewinderScrubAccumulator = 0;
  private rewinderLastCountdownSecBeep = -1;
  private keyDownHandler: ((evt: KeyboardEvent) => void) | null = null;
  private keyUpHandler: ((evt: KeyboardEvent) => void) | null = null;
  private unsubKeyDown: (() => void) | null = null;
  private unsubKeyUp: (() => void) | null = null;

  attachToHost(ctx: LabTabContext): void {
    this.ctx = ctx;
  }

  onActivate(ctx: LabTabContext): void {
    this.ctx = ctx;
  }

  onDeactivate(): void {
    this.clearBuffer();
  }

  private doesRewinderWindowExist(): boolean {
    return Boolean(useRewinderStore.getState().rewinderWindowOpen);
  }

  bindHotkeys(): void {
    if (typeof window === 'undefined') return;
    this.unbindHotkeys();

    this.keyDownHandler = (evt: KeyboardEvent) => {
      const runtime = this.ctx?.runtime;
      if (runtime?.match?.state?.mode !== 'dev-test-lab') return;
      if (isGlobalHotkeyBlockedByUi(evt, runtime)) return;
      if (!this.doesRewinderWindowExist()) return;

      const noMods = !evt.ctrlKey && !evt.shiftKey && !evt.altKey && !evt.metaKey;
      if ((evt.code === 'KeyO' || evt.key === 'o' || evt.key === 'O') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.startRecording();
        }
        return;
      }

      if ((evt.code === 'KeyP' || evt.key === 'p' || evt.key === 'P') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.pauseRecording();
        }
        return;
      }

      if ((evt.code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.resumeFromCursor();
        }
        return;
      }

      if (evt.code === 'BracketLeft' || evt.key === '[') {
        evt.preventDefault();
        if (!evt.repeat) this.beginScrub('rewinding');
        return;
      }

      if (evt.code === 'BracketRight' || evt.key === ']') {
        evt.preventDefault();
        if (!evt.repeat) this.beginScrub('forwarding');
      }
    };

    this.keyUpHandler = (evt: KeyboardEvent) => {
      const runtime = this.ctx?.runtime;
      if (runtime?.match?.state?.mode !== 'dev-test-lab') return;
      if (!this.doesRewinderWindowExist()) return;
      if (
        evt.code === 'BracketLeft' ||
        evt.key === '[' ||
        evt.code === 'BracketRight' ||
        evt.key === ']'
      ) {
        evt.preventDefault();
        this.pauseScrub();
      }
    };

    this.unsubKeyDown = subscribeGlobalKeyDown(this.keyDownHandler, true);
    this.unsubKeyUp = subscribeGlobalKeyUp(this.keyUpHandler, true);
  }

  unbindHotkeys(): void {
    this.unsubKeyDown?.();
    this.unsubKeyDown = null;
    this.keyDownHandler = null;
    this.unsubKeyUp?.();
    this.unsubKeyUp = null;
    this.keyUpHandler = null;
  }

  isScrubOrPrerollActive(): boolean {
    const state = useRewinderStore.getState().rewinderState;
    return (
      state === 'rewinding' ||
      state === 'forwarding' ||
      state === 'paused-scrub' ||
      state === 'preroll-countdown'
    );
  }

  private ensureDevTestLabActive(actionName: string): boolean {
    const currentMode = this.ctx?.runtime?.match?.state?.mode || 'dev-test-lab';
    if (currentMode !== 'dev-test-lab') {
      console.warn(
        `[StateReplayLabTab] Cannot execute "${actionName}": active mode is "${currentMode}" (requires "dev-test-lab").`
      );
      return false;
    }
    return true;
  }

  private updateStoresTelemetry(patch: Record<string, any>): void {
    useRewinderStore.getState().updateLiveTelemetry(patch);
    useSubsystemIsolationLabStore.getState().updateLiveTelemetry(patch);
  }

  private applyFrameAtCursor(
    smoothStep = false,
    restoreOptions: Record<string, any> = { preserveEngineTick: true }
  ): void {
    const r = this.ctx?.runtime;
    if (!r?.physics || this.rewinderFrames.length === 0) return;
    const idx = Math.max(
      0,
      Math.min(this.rewinderFrames.length - 1, Math.floor(this.rewinderCursor))
    );
    const entry = this.rewinderFrames[idx];
    if (!entry) return;

    if (smoothStep && r.interpolator) {
      r.interpolator.prevState.set(r.interpolator.currState);
    }

    const compactSnap = entry.compactSnap || entry.renderState || (entry as any).arenaSnap;
    if (compactSnap) {
      r.physics.restoreState(compactSnap, restoreOptions);
    }
    if (r.interpolator) {
      if (!smoothStep) {
        r.interpolator.prevState.set(r.physics.state);
        r.interpolator.alpha = 0;
      }
      r.interpolator.currState.set(r.physics.state);
    }
  }

  startRecording(): void {
    if (!this.ensureDevTestLabActive('startRewinderRecordingSession')) return;
    const r = this.ctx?.runtime;
    if (!r?.physics) {
      console.warn(
        '[StateReplayLabTab] Cannot start recording: physics engine is not initialized.'
      );
      return;
    }

    this.rewinderFrames = [];
    this.rewinderCursor = 0;
    this.rewinderTargetFrame = 0;
    this.rewinderScrubAccumulator = 0;
    this.rewinderLastCountdownSecBeep = -1;
    r.physics.clearReplayBuffer?.();
    r.physics.clearEvents?.();
    r.physics.resetGoalLatch?.();
    r._clientGoalIncidentLatched = false;
    r.simulationStage?.resetActionStates?.();

    this.updateStoresTelemetry({
      rewinderState: 'recording',
      rewinderRecordedFrames: 0,
      rewinderCursorFrame: 0,
      rewinderTargetFrame: 0,
      rewinderPrerollRemainingSec: 0,
    });
  }

  pauseRecording(): void {
    if (!this.ensureDevTestLabActive('pauseRewinderRecordingSession')) return;
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'recording') {
      const lastFrame = Math.max(0, this.rewinderFrames.length - 1);
      this.rewinderCursor = lastFrame;
      this.rewinderTargetFrame = lastFrame;
      this.updateStoresTelemetry({
        rewinderState: 'stopped',
        rewinderRecordedFrames: this.rewinderFrames.length,
        rewinderCursorFrame: lastFrame,
        rewinderTargetFrame: lastFrame,
        rewinderPrerollRemainingSec: 0,
      });
    } else {
      console.warn(
        `[StateReplayLabTab] Cannot stop recording: current state is "${store.rewinderState}".`
      );
    }
  }

  beginScrub(direction: 'rewinding' | 'forwarding' = 'rewinding'): void {
    if (!this.ensureDevTestLabActive(`beginRewinderScrubSession(${direction})`)) return;
    if (this.rewinderFrames.length === 0) {
      console.warn(
        `[StateReplayLabTab] Cannot start ${direction}: recorded frame buffer is empty (0 frames).`
      );
      return;
    }
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'recording') {
      this.rewinderCursor = this.rewinderFrames.length - 1;
      this.rewinderTargetFrame = this.rewinderCursor;
    } else if (store.rewinderState === 'preroll-countdown') {
      this.rewinderCursor = this.rewinderTargetFrame;
    }
    this.rewinderScrubAccumulator = 0;
    this.rewinderLastCountdownSecBeep = -1;
    this.updateStoresTelemetry({
      rewinderState: direction,
      rewinderRecordedFrames: this.rewinderFrames.length,
      rewinderCursorFrame: Math.round(this.rewinderCursor),
      rewinderTargetFrame: Math.round(this.rewinderCursor),
      rewinderPrerollRemainingSec: 0,
    });
  }

  pauseScrub(): void {
    const store = useRewinderStore.getState();
    if (store.rewinderState === 'rewinding' || store.rewinderState === 'forwarding') {
      const clamped = Math.max(
        0,
        Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor))
      );
      this.rewinderCursor = clamped;
      this.rewinderTargetFrame = clamped;
      this.updateStoresTelemetry({
        rewinderState: 'paused-scrub',
        rewinderCursorFrame: clamped,
        rewinderTargetFrame: clamped,
      });
    }
  }

  seekFrame(frameIndex: number): void {
    if (!this.ensureDevTestLabActive('seekRewinderFrameToIndex')) return;
    if (!this.rewinderFrames || this.rewinderFrames.length === 0) {
      console.warn(
        '[StateReplayLabTab] Cannot seek frame: recorded frame buffer is empty (0 frames).'
      );
      return;
    }
    const clamped = Math.max(
      0,
      Math.min(this.rewinderFrames.length - 1, Math.round(frameIndex))
    );
    this.rewinderCursor = clamped;
    this.rewinderTargetFrame = clamped;
    this.rewinderScrubAccumulator = 0;
    this.rewinderLastCountdownSecBeep = -1;
    this.applyFrameAtCursor(false);
    this.updateStoresTelemetry({
      rewinderState: 'paused-scrub',
      rewinderCursorFrame: clamped,
      rewinderTargetFrame: clamped,
      rewinderPrerollRemainingSec: 0,
    });
  }

  resumeFromCursor(): void {
    if (!this.ensureDevTestLabActive('resumeRewinderFromCursorSession')) return;
    const r = this.ctx?.runtime;
    const store = useRewinderStore.getState();
    const downSec = store.rewinderDownCounterSec ?? 3;
    const minRequiredFrames = downSec === 0 ? 120 : 240;
    if (!r?.physics) {
      console.warn(
        '[StateReplayLabTab] Cannot resume from cursor: physics engine is not initialized.'
      );
      return;
    }
    if (this.rewinderFrames.length < minRequiredFrames) {
      console.warn(
        `[StateReplayLabTab] Cannot resume from cursor: recorded frames (${this.rewinderFrames.length}) < minimum required frames (${minRequiredFrames}) for downCounter=${downSec}s.`
      );
      return;
    }

    const calc = computeRewinderPrerollWindow(
      this.rewinderFrames.length,
      this.rewinderCursor,
      this.rewinderTargetFrame,
      downSec,
      store.rewinderState
    );

    this.rewinderTargetFrame = calc.targetIdx;
    this.rewinderCursor = calc.startIdx;
    this.rewinderLastCountdownSecBeep = -1;

    r.physics.setUnlimitedBoost?.(false);
    this.applyFrameAtCursor(false);
    r.simulationStage?.resetActionStates?.();

    const audio = r?.options?.gameAudio || gameAudio;
    if (downSec === 0) {
      this.rewinderLastCountdownSecBeep = 1;
      audio?.play?.('training_countdown', 1.0, 200);
    } else if (calc.remSec >= 1 && calc.remSec <= downSec) {
      this.rewinderLastCountdownSecBeep = calc.remSec;
      audio?.play?.('training_countdown', 1.0, 200);
    }

    this.updateStoresTelemetry({
      rewinderState: 'preroll-countdown',
      rewinderRecordedFrames: this.rewinderFrames.length,
      rewinderCursorFrame: calc.startIdx,
      rewinderTargetFrame: calc.targetIdx,
      rewinderPrerollRemainingSec: Math.max(1, calc.remSec),
    });
  }

  async exportReplay(): Promise<boolean> {
    if (!this.rewinderFrames || this.rewinderFrames.length === 0) {
      console.warn(
        '[StateReplayLabTab] Cannot export state replay: recorded frame buffer is empty (0 frames).'
      );
      return false;
    }
    return Boolean(await exportStateReplayFile(this.rewinderFrames));
  }

  async importReplay(fileOrBuffer: any): Promise<boolean> {
    if (!this.ensureDevTestLabActive('importRewinderReplayFile')) return false;
    const r = this.ctx?.runtime;
    if (!r?.physics) {
      console.warn(
        '[StateReplayLabTab] Cannot import replay: physics engine is not initialized.'
      );
      return false;
    }
    try {
      const parsed = await parseRCReplayFile(fileOrBuffer);
      if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) {
        throw new Error('No valid frames found in replay file.');
      }
      this.ctx?.ensureSinglePlayerCarOnly(false);
      this.rewinderFrames = parsed.frames.map((snap: any, idx: number) => {
        const slot = parsed.frameSlots?.[idx] || null;
        const car0Ctrl =
          slot?.acknowledgedControls?.[0] ||
          snap?.controls?.[0] ||
          r.neutralControls ||
          DEFAULT_CAR_CONTROLS;
        return {
          compactSnap: snap,
          renderState: snap,
          controls: { ...car0Ctrl },
          acknowledgedControls: slot?.acknowledgedControls || snap?.controls || [{ ...car0Ctrl }],
          incidents: slot?.incidents || snap?.incidents || [],
          signals: slot?.signals || snap?.signals || [],
          audioEvents: slot?.audioEvents || snap?.audioEvents || [],
        };
      });
      this.rewinderCursor = 0;
      this.rewinderTargetFrame = Math.max(0, this.rewinderFrames.length - 1);
      this.rewinderScrubAccumulator = 0;
      this.rewinderLastCountdownSecBeep = -1;

      this.applyFrameAtCursor(false);
      r.simulationStage?.resetActionStates?.();

      this.updateStoresTelemetry({
        rewinderState: 'stopped',
        rewinderRecordedFrames: this.rewinderFrames.length,
        rewinderCursorFrame: 0,
        rewinderTargetFrame: Math.max(0, this.rewinderFrames.length - 1),
        rewinderPrerollRemainingSec: 0,
      });
      return true;
    } catch (err) {
      console.error('[StateReplayLabTab] Failed to import replay file:', err);
      return false;
    }
  }

  clearBuffer(): void {
    const r = this.ctx?.runtime;
    this.rewinderFrames = [];
    this.rewinderCursor = 0;
    this.rewinderTargetFrame = 0;
    this.rewinderScrubAccumulator = 0;
    this.rewinderLastCountdownSecBeep = -1;
    r?.physics?.clearReplayBuffer?.();
    this.updateStoresTelemetry({
      rewinderState: 'idle',
      rewinderRecordedFrames: 0,
      rewinderCursorFrame: 0,
      rewinderTargetFrame: 0,
      rewinderPrerollRemainingSec: 0,
    });
  }

  recordFrameAfterTick(): void {
    const r = this.ctx?.runtime;
    const store = useRewinderStore.getState();
    if (store.rewinderState !== 'recording' || !r?.physics) return;
    if (this.rewinderFrames.length < MAX_REWINDER_FRAMES) {
      const compactSnap = r.physics.saveCompactState();
      this.rewinderFrames.push({
        compactSnap,
        renderState: compactSnap,
        controls: { ...r.playerControls },
      });
      r.physics.recordReplayFrame?.();
      this.rewinderCursor = this.rewinderFrames.length - 1;
      this.rewinderTargetFrame = this.rewinderCursor;
      if (
        this.rewinderFrames.length % 6 === 0 ||
        this.rewinderFrames.length === 120 ||
        this.rewinderFrames.length === 240
      ) {
        this.updateStoresTelemetry({
          rewinderRecordedFrames: this.rewinderFrames.length,
          rewinderCursorFrame: this.rewinderCursor,
          rewinderTargetFrame: this.rewinderTargetFrame,
        });
      }
    } else {
      this.pauseRecording();
    }
  }

  stepBeforePhysicsTick(): boolean {
    const r = this.ctx?.runtime;
    const store = useRewinderStore.getState();

    if (store.rewinderState === 'preroll-countdown') {
      const targetIdx = Math.max(
        0,
        Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderTargetFrame))
      );
      const nextCursor = Math.min(targetIdx, Math.round(this.rewinderCursor) + 1);
      this.rewinderCursor = nextCursor;
      this.applyFrameAtCursor(true, { preserveEngineTick: true });

      const remFrames = Math.max(0, targetIdx - nextCursor);
      const downSec = store.rewinderDownCounterSec ?? 3;
      const maxBeepSec = downSec === 0 ? 1 : downSec;
      const audio = r?.options?.gameAudio || gameAudio;

      if (remFrames <= 0) {
        const prevEngineTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);
        const liveTick = Math.max(prevEngineTick + 16, targetIdx + 16);
        r?.physics?.setUnlimitedBoost?.(false);
        this.applyFrameAtCursor(false, { overrideTick: liveTick });
        r?.physics?.clearEvents?.();
        r?.physics?.resetGoalLatch?.();
        if (r) r._clientGoalIncidentLatched = false;
        r?.simulationStage?.resetActionStates?.();
        if (r?.playerControls) {
          r.physics.setControls?.(r.playerCarIndex || 0, r.playerControls);
        }
        audio?.play?.('match_start_go', 1.0, 200);
        this.rewinderLastCountdownSecBeep = -1;
        this.updateStoresTelemetry({
          rewinderState: 'stopped',
          rewinderCursorFrame: targetIdx,
          rewinderTargetFrame: targetIdx,
          rewinderPrerollRemainingSec: 0,
        });
        return false;
      }

      const countdownSec = Math.max(1, Math.ceil(remFrames / 120));
      if (
        countdownSec >= 1 &&
        countdownSec <= maxBeepSec &&
        countdownSec !== this.rewinderLastCountdownSecBeep
      ) {
        this.rewinderLastCountdownSecBeep = countdownSec;
        audio?.play?.('training_countdown', 1.0, 200);
      }

      if (
        remFrames % 6 === 0 ||
        remFrames % 120 === 0 ||
        countdownSec !== store.rewinderPrerollRemainingSec
      ) {
        this.updateStoresTelemetry({
          rewinderCursorFrame: nextCursor,
          rewinderPrerollRemainingSec: countdownSec,
        });
      }
      return false;
    }

    if (
      store.rewinderState === 'rewinding' ||
      store.rewinderState === 'forwarding' ||
      store.rewinderState === 'paused-scrub'
    ) {
      if (store.rewinderState === 'rewinding' || store.rewinderState === 'forwarding') {
        const stepPerTick = (store.rewinderEffectiveFlowPct || 100) / 100;
        this.rewinderCursor =
          store.rewinderState === 'rewinding'
            ? Math.max(0, this.rewinderCursor - stepPerTick)
            : Math.min(
                Math.max(0, this.rewinderFrames.length - 1),
                this.rewinderCursor + stepPerTick
              );
        this.rewinderTargetFrame = Math.round(this.rewinderCursor);
        this.applyFrameAtCursor(false, { preserveEngineTick: true });
        this.updateStoresTelemetry({
          rewinderCursorFrame: this.rewinderTargetFrame,
          rewinderTargetFrame: this.rewinderTargetFrame,
        });
      }
      return false;
    }

    return true;
  }

  onPhysicsTick(_dt: number): boolean {
    return true;
  }
}
