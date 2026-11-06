/**
 * ReplayTakeoverSubController.ts
 * Stateful SubController for 3-2-1-GO pre-roll countdown, fractional scrub stepping,
 * intervention tick tracking, and unified live Freeplay takeover handoff.
 *
 * Shared by StandaloneReplayViewerController and FreeplayRewinderController.
 */

import {
  SIM_OFFSETS,
  INCIDENT_EVENT_TYPES,
  SYSTEM_CONTROL_SIGNALS,
} from '../physics/RocketSimConstants.ts';
import { reconstructAndRestoreReplayFrame } from '../physics/CarTransientStateReconstructor.ts';
import { gameAudio } from '../audio/GameAudioEngineFacade.ts';
import type { NormalizedReplayFrameSlot } from './ReplayCausalHybridEngine.ts';

export { SYSTEM_CONTROL_SIGNALS };

export interface ReplayTakeoverAudioPort {
  play?: (soundId: string, volume?: number, cooldownMs?: number) => void;
}

export interface ReplayTakeoverRuntimePort {
  physics?: {
    state: Float32Array;
    getHeaderView?: () => { tick?: number; tickCount?: number; numCars?: number } | null;
    getBallStateView?: () => { velX?: number; velY?: number; velZ?: number } | null;
    saveCompactState?: () => Float32Array | null;
    clearEvents?: () => void;
    resetGoalLatch?: () => void;
  } | null;
  interpolator?: {
    prevState: Float32Array;
    currState: Float32Array;
    alpha: number;
  } | null;
  simulationStage?: {
    resetActionStates?: () => void;
  } | null;
  authoritativeServer?: {
    sim?: {
      restoreState?: (snap: Float32Array) => void | Promise<void>;
    } | null;
    enterStateOnlyMode?: (snap: Float32Array | number[] | null, param1: number) => void;
    beginInterveneCountdown?: (seconds: number, snap: Float32Array | number[] | null) => void;
    resumePhysicsFromState?: (snap: Float32Array | number[] | null, param1: number) => void;
  } | null;
  networkReconciler?: {
    replayPlaybackMode?: boolean;
    syncTimeline?: (snap: Float32Array | number[] | null, tick: number, timestampMs?: number) => void;
  } | null;
  lastSystemControlSignal?: number;
  systemControlSignalHistory?: Array<{
    signalType: number;
    tick: number;
    param1: number;
    param2: number;
  }>;
  _clientGoalIncidentLatched?: boolean;
}

export interface ReplayTakeoverFreeplayModePort {
  goalAndTouch?: {
    goalIncidentTick?: number;
    goalResetTicks?: number;
    frozenGoalBallState?: unknown;
    prevBallVelX?: number;
    prevBallVelY?: number;
    prevBallVelZ?: number;
    lastKickoffStartTick?: number;
    lastTouchTick?: number;
  } | null;
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
}

export function emitSystemControlTransition(
  runtime: ReplayTakeoverRuntimePort | null | undefined,
  signalType: number,
  param1 = 0,
  param2 = 0,
  stateSnapshot?: Float32Array | number[] | null
): void {
  if (!runtime) return;
  const tick = Math.floor(runtime.physics?.getHeaderView?.()?.tickCount ?? 0);
  runtime.lastSystemControlSignal = signalType;
  if (!Array.isArray(runtime.systemControlSignalHistory)) {
    runtime.systemControlSignalHistory = [];
  }
  runtime.systemControlSignalHistory.push({
    signalType,
    tick,
    param1,
    param2,
  });
  if (runtime.systemControlSignalHistory.length > 64) {
    runtime.systemControlSignalHistory.shift();
  }

  const server = runtime.authoritativeServer;
  if (!server) return;
  const snap = stateSnapshot ?? runtime.physics?.saveCompactState?.() ?? null;
  if (signalType === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY) {
    server.enterStateOnlyMode?.(snap, param1);
  } else if (signalType === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME) {
    server.beginInterveneCountdown?.(param2 > 0 ? param2 : 3, snap);
  } else if (signalType === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME) {
    server.resumePhysicsFromState?.(snap, param1);
    if (snap && runtime.networkReconciler) {
      runtime.networkReconciler.syncTimeline?.(snap, param1);
    }
  }
}

export interface PrerollWindowBounds {
  minRequiredFrames: number;
  targetIdx: number;
  startIdx: number;
  remFrames: number;
  remSec: number;
  effectiveDownSec: number;
}

export interface ReplayHandoffHistorySlot extends NormalizedReplayFrameSlot {
  incidents?: Array<{ type?: number; [key: string]: unknown }>;
  hadTouch?: boolean;
}

export interface LiveFreeplayHandoffParams {
  runtime: ReplayTakeoverRuntimePort | null | undefined;
  freeplayMode: ReplayTakeoverFreeplayModePort | null | undefined;
  targetIdx: number;
  fallbackLastTouchTick?: 'baseTick' | 'minusOne';
  getHistorySlotAt: (frameIndex: number) => ReplayHandoffHistorySlot | null;
  onBeforeReconstruct?: (liveTick: number) => void;
  onAfterReconstruct?: (liveTick: number) => void;
}

export interface TakeoverPrerollStepParams {
  totalFrames: number;
  downCounterSec: number;
  displayedRemainingSec: number;
  audio?: ReplayTakeoverAudioPort | null;
  onApplyFrameAtCursor: (cursorIndex: number) => void;
  onHandoffToLiveFreeplay: (targetIdx: number) => void;
  onUpdateCountdownTelemetry: (cursorFrame: number, remainingSec: number) => void;
}

export interface TakeoverScrubStepParams {
  direction: 'rewinding' | 'forwarding';
  totalFrames: number;
  effectiveFlowPct: number;
  throttleUiSync?: boolean;
  onApplyFrameAtCursor: (cursorIndex: number, isForwarding: boolean) => void;
  onUpdateScrubTelemetry: (cursorFrame: number) => void;
}

export interface TakeoverPlayStepParams {
  totalFrames: number;
  effectiveFlowPct: number;
  onApplyFrameAtCursor: (cursorIndex: number) => void;
  onPlaybackFinished: (finalFrame: number) => void;
  onUpdatePlayTelemetry: (cursorFrame: number) => void;
}

export function computePrerollWindowBounds(
  totalFrames: number,
  baseCursor: number,
  downCounterSec: number
): PrerollWindowBounds {
  const downSec = Number(downCounterSec) || 0;
  const minRequiredFrames = downSec === 0 ? 120 : 240;
  const targetIdx = Math.max(
    minRequiredFrames - 1,
    Math.min(totalFrames - 1, Math.round(baseCursor))
  );
  const lookbackFrames = (downSec === 0 ? 1 : downSec + 1) * 120;
  const startIdx = Math.max(0, targetIdx - lookbackFrames);
  const remFrames = Math.max(0, targetIdx - startIdx);
  const remSec = Math.max(1, Math.ceil(remFrames / 120));
  const effectiveDownSec = Math.max(1, downSec);
  return {
    minRequiredFrames,
    targetIdx,
    startIdx,
    remFrames,
    remSec,
    effectiveDownSec,
  };
}

export function executeLiveFreeplayHandoff(params: LiveFreeplayHandoffParams): number {
  const {
    runtime: r,
    freeplayMode,
    targetIdx,
    fallbackLastTouchTick = 'baseTick',
    getHistorySlotAt,
    onBeforeReconstruct,
    onAfterReconstruct,
  } = params;
  const sim = r?.physics;
  if (!sim || !r) return 0;

  const maxHistory = Math.min(
    targetIdx + 1,
    freeplayMode?.replayRingBuffer?.capacityTicks || 3600
  );
  const firstIdx = Math.max(0, targetIdx + 1 - maxHistory);
  const historySpan = Math.max(0, targetIdx - firstIdx);
  const prevEngineTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
  const liveTick = Math.max(prevEngineTick + 16, historySpan + 16);

  onBeforeReconstruct?.(liveTick);

  reconstructAndRestoreReplayFrame(
    sim,
    (f: number) => getHistorySlotAt(f),
    targetIdx,
    { overrideTick: liveTick }
  );

  if (r.interpolator) {
    r.interpolator.prevState.set(sim.state);
    r.interpolator.currState.set(sim.state);
    r.interpolator.alpha = 0;
  }

  sim.clearEvents?.();
  sim.resetGoalLatch?.();
  r._clientGoalIncidentLatched = false;
  r.simulationStage?.resetActionStates?.();

  onAfterReconstruct?.(liveTick);

  const resumedSnap =
    typeof sim.saveCompactState === 'function' ? sim.saveCompactState() : null;
  emitSystemControlTransition(
    r,
    SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
    liveTick,
    1,
    resumedSnap
  );
  if (r.networkReconciler) {
    r.networkReconciler.replayPlaybackMode = false;
    if (resumedSnap) {
      r.networkReconciler.syncTimeline?.(resumedSnap, liveTick, performance.now());
    }
  }

  if (freeplayMode) {
    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? liveTick);
    const bView = sim.getBallStateView?.();
    const goalAndTouch = freeplayMode.goalAndTouch;
    if (goalAndTouch) {
      Object.assign(goalAndTouch, {
        goalIncidentTick: -1,
        goalResetTicks: 0,
        frozenGoalBallState: null,
        prevBallVelX: bView?.velX ?? 0,
        prevBallVelY: bView?.velY ?? 0,
        prevBallVelZ: bView?.velZ ?? 0,
      });
    }

    if (freeplayMode.replayRingBuffer) {
      freeplayMode.replayRingBuffer.clear?.();
      const baseTick = currentTick - historySpan;
      let latestTouchTick = -1;

      for (let i = firstIdx; i <= targetIdx; i++) {
        const slot = getHistorySlotAt(i);
        const snap = slot?.snapshot;
        if (!snap) continue;
        const syntheticTick = baseTick + (i - firstIdx);
        const recordedSlot = freeplayMode.replayRingBuffer.recordFrame?.(syntheticTick, snap, {
          acknowledgedControls: slot.controls || [],
        });
        if (recordedSlot?.snapshot) {
          recordedSlot.snapshot[SIM_OFFSETS.TICK] = syntheticTick;
        }
        const frameIncidents = slot.incidents || [];
        for (const inc of frameIncidents) {
          freeplayMode.replayRingBuffer.appendIncident?.(syntheticTick, {
            ...inc,
            tick: syntheticTick,
          });
          if (inc.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || inc.type === 0x01) {
            latestTouchTick = syntheticTick;
          }
        }
        if (slot.hadTouch) {
          latestTouchTick = syntheticTick;
        }
      }

      if (goalAndTouch) {
        Object.assign(goalAndTouch, {
          lastKickoffStartTick: baseTick,
          lastTouchTick:
            latestTouchTick >= 0
              ? latestTouchTick
              : fallbackLastTouchTick === 'baseTick'
                ? baseTick
                : -1,
        });
      }
    }
  }

  return liveTick;
}

export class ReplayTakeoverSubController {
  public cursor = 0;
  public targetFrame = 0;
  public scrubAccumulator = 0;
  public lastCountdownSecBeep = -1;
  public interveneStartFrame = 0;
  public interveneElapsedTicks = 0;
  public uiSyncTick = 0;

  reset(initialCursor = 0, initialTargetFrame = 0): void {
    this.cursor = initialCursor;
    this.targetFrame = initialTargetFrame;
    this.scrubAccumulator = 0;
    this.lastCountdownSecBeep = -1;
    this.interveneStartFrame = 0;
    this.interveneElapsedTicks = 0;
    this.uiSyncTick = 0;
  }

  seekToFrame(frameIndex: number, totalFrames: number): number {
    const maxIdx = Math.max(0, totalFrames - 1);
    const clamped = Math.max(0, Math.min(maxIdx, Math.round(frameIndex)));
    this.cursor = clamped;
    this.targetFrame = clamped;
    this.scrubAccumulator = 0;
    this.lastCountdownSecBeep = -1;
    return clamped;
  }

  beginScrub(
    direction: 'rewinding' | 'forwarding',
    totalFrames: number,
    effectiveFlowPct: number,
    baseCursor = this.cursor
  ): number {
    const flowPct = effectiveFlowPct || 100;
    const initialStep = Math.max(1, Math.round(flowPct / 100));
    const maxIdx = Math.max(0, totalFrames - 1);
    const curIdx = Math.max(0, Math.min(maxIdx, Math.round(baseCursor)));
    const nextIdx =
      direction === 'rewinding'
        ? Math.max(0, curIdx - initialStep)
        : Math.min(maxIdx, curIdx + initialStep);

    this.cursor = nextIdx;
    this.targetFrame = nextIdx;
    this.scrubAccumulator = 0;
    this.lastCountdownSecBeep = -1;
    return nextIdx;
  }

  beginPrerollCountdown(
    totalFrames: number,
    baseCursor: number,
    downCounterSec: number,
    audio: ReplayTakeoverAudioPort | null = gameAudio
  ): PrerollWindowBounds {
    const bounds = computePrerollWindowBounds(totalFrames, baseCursor, downCounterSec);
    this.targetFrame = bounds.targetIdx;
    this.cursor = bounds.startIdx;
    this.scrubAccumulator = 0;
    this.lastCountdownSecBeep = -1;

    if (bounds.remSec <= bounds.effectiveDownSec) {
      this.lastCountdownSecBeep = bounds.remSec;
      audio?.play?.('training_countdown', 1.0, 200);
    }
    return bounds;
  }

  beginIntervention(targetIdx: number): void {
    this.cursor = targetIdx;
    this.interveneStartFrame = targetIdx;
    this.interveneElapsedTicks = 0;
  }

  consumeInterventionReplayFrameIndex(): number {
    const currentReplayFrameIdx = this.interveneStartFrame + this.interveneElapsedTicks;
    this.interveneElapsedTicks += 1;
    return currentReplayFrameIdx;
  }

  stepPrerollCountdown(params: TakeoverPrerollStepParams): boolean {
    const {
      totalFrames,
      downCounterSec,
      displayedRemainingSec,
      audio = gameAudio,
      onApplyFrameAtCursor,
      onHandoffToLiveFreeplay,
      onUpdateCountdownTelemetry,
    } = params;

    const targetIdx = Math.max(0, Math.min(totalFrames - 1, Math.round(this.targetFrame)));
    const nextCursor = Math.min(targetIdx, Math.round(this.cursor) + 1);
    this.cursor = nextCursor;
    onApplyFrameAtCursor(nextCursor);

    const remFrames = Math.max(0, targetIdx - nextCursor);
    const effectiveDownSec = Math.max(1, downCounterSec ?? 0);

    if (remFrames <= 0) {
      this.lastCountdownSecBeep = -1;
      onHandoffToLiveFreeplay(targetIdx);
      audio?.play?.('match_start_go', 1.0, 200);
      return false;
    }

    const countdownSec = Math.max(1, Math.ceil(remFrames / 120));
    if (
      countdownSec >= 1 &&
      countdownSec <= effectiveDownSec &&
      countdownSec !== this.lastCountdownSecBeep
    ) {
      this.lastCountdownSecBeep = countdownSec;
      audio?.play?.('training_countdown', 1.0, 200);
    }

    if (
      remFrames % 6 === 0 ||
      remFrames % 120 === 0 ||
      countdownSec !== displayedRemainingSec
    ) {
      onUpdateCountdownTelemetry(nextCursor, countdownSec);
    }
    return false;
  }

  stepScrub(params: TakeoverScrubStepParams): boolean {
    const {
      direction,
      totalFrames,
      effectiveFlowPct,
      throttleUiSync = false,
      onApplyFrameAtCursor,
      onUpdateScrubTelemetry,
    } = params;

    const stepPerTick = (effectiveFlowPct || 100) / 100;
    const signedStep = direction === 'rewinding' ? -stepPerTick : stepPerTick;
    this.scrubAccumulator += signedStep;
    const wholeSteps = Math.trunc(this.scrubAccumulator);
    if (wholeSteps !== 0) {
      this.scrubAccumulator -= wholeSteps;
      const maxIdx = Math.max(0, totalFrames - 1);
      const nextIdx = Math.max(0, Math.min(maxIdx, Math.round(this.cursor) + wholeSteps));
      this.cursor = nextIdx;
      this.targetFrame = nextIdx;
      onApplyFrameAtCursor(nextIdx, direction === 'forwarding');

      if (throttleUiSync) {
        this.uiSyncTick = (this.uiSyncTick + 1) & 3;
        if (this.uiSyncTick === 0 || Math.abs(wholeSteps) === 1) {
          onUpdateScrubTelemetry(nextIdx);
        }
      } else {
        onUpdateScrubTelemetry(nextIdx);
      }
    }
    return false;
  }

  stepPlaying(params: TakeoverPlayStepParams): boolean {
    const {
      totalFrames,
      effectiveFlowPct,
      onApplyFrameAtCursor,
      onPlaybackFinished,
      onUpdatePlayTelemetry,
    } = params;

    const maxIdx = Math.max(0, totalFrames - 1);
    const stepPerTick = (effectiveFlowPct || 100) / 100;
    this.cursor = Math.min(maxIdx, this.cursor + stepPerTick);
    const rounded = Math.round(this.cursor);
    this.targetFrame = rounded;
    onApplyFrameAtCursor(rounded);

    this.uiSyncTick = (this.uiSyncTick + 1) & 3;
    if (rounded >= maxIdx) {
      onPlaybackFinished(rounded);
    } else if (this.uiSyncTick === 0) {
      onUpdatePlayTelemetry(rounded);
    }
    return false;
  }
}
