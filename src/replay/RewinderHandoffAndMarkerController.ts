/**
 * RewinderHandoffAndMarkerController.ts
 * Stateful SubController for Freeplay Rewinder frame history recording, incident marker
 * capture, RCReplay file import/export, pre-roll countdown transitions, and live Free Play handoff.
 */

import { hudStore, useRewinderStore } from '../game/runtimeUiPort.ts';
import {
  parseRCReplayFile,
  exportStateReplayFile,
  MAX_REWINDER_FRAMES,
} from './ReplayFileExporter.ts';
import {
  executeLiveFreeplayHandoff,
  emitSystemControlTransition,
  type ReplayTakeoverSubController,
} from './ReplayTakeoverSubController.ts';
import { SYSTEM_CONTROL_SIGNALS } from '../physics/RocketSimConstants.ts';
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
import { DEFAULT_CAR_CONTROLS } from '../ai/experimental/experimentalMultiCarObsPipeline.ts';
import { dispatchReplayFrameEvents } from './ReplayFrameEventDispatcher.ts';
import { gameAudio } from '../audio/GameAudioEngineFacade.ts';

export type { RewinderFrameEntry, RewinderIncidentRecord };

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

export class RewinderHandoffAndMarkerController {
  private _pendingFrameIncidents: RewinderIncidentRecord[] = [];

  public clearPendingIncidents(): void {
    this._pendingFrameIncidents.length = 0;
  }

  public exitGoalOrReplayIfNeeded(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null,
  ): void {
    if (!runtime || !mode) return;
    const isReplayActive = Boolean(
      mode.directorPreview?.isReplayActive || mode.isGoalReplayActive?.()
    );
    const goalResetTicks =
      mode.goalAndTouch?.getEffectiveGoalResetTicks?.() ??
      mode.goalAndTouch?.goalResetTicks ??
      0;

    if (isReplayActive || goalResetTicks > 0 || runtime.match?.state?.phase !== 'playing') {
      mode.replayController?.endReplaySession?.();
      if (mode.directorPreview) mode.directorPreview.isReplayActive = false;
      if (mode.goalAndTouch) {
        Object.assign(mode.goalAndTouch, {
          goalResetTicks: 0,
          frozenGoalBallState: null,
          goalIncidentTick: -1,
        });
      }
      runtime.releaseGoalReplayCameraOverride?.();
      if (runtime.match?.state) runtime.match.state.phase = 'playing';
      hudStore.getState().setReplayState({ replayPaused: false, replayPersistent: false });
      hudStore.getState().setMatchState({
        matchPhase: 'playing',
        replayScorerName: null,
        replayScorerTeam: null,
        replayBallSpeedKph: null,
        replayAssistName: null,
      });
    }
  }

  public applyFrameAtCursor(
    runtime: FreeplayRewinderRuntimePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    cursor: number,
    smoothStep: boolean = false,
    restoreOptions: { preserveEngineTick?: boolean; overrideTick?: number } = { preserveEngineTick: true },
  ): RewinderFrameEntry | null {
    return applyRewinderFrameToPhysics({
      physics: runtime?.physics,
      interpolator: runtime?.interpolator,
      arena: runtime?.arena,
      rewinderFrames,
      rewinderCursor: cursor,
      smoothStep,
      restoreOptions,
    });
  }

  public applyFrameAndEmitStateOnly(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    frameIdx: number,
    disableBallControl = true,
  ): RewinderFrameEntry | null {
    if (disableBallControl) {
      this.exitGoalOrReplayIfNeeded(runtime, mode);
      if (runtime?.keyboard) runtime.keyboard.ballControlEnabled = false;
    }
    const entry = this.applyFrameAtCursor(runtime, rewinderFrames, frameIdx, false, {
      preserveEngineTick: true,
    });
    emitSystemControlTransition(
      runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      frameIdx,
      0,
      entry?.compactSnap || runtime?.physics?.saveCompactState?.(),
    );
    return entry;
  }

  public executeHandoffToLiveFreeplay(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    targetIdx: number,
    cursor: number,
  ): void {
    if (!runtime?.physics || rewinderFrames.length === 0) return;
    executeLiveFreeplayHandoff({
      runtime,
      freeplayMode: mode,
      targetIdx,
      fallbackLastTouchTick: 'minusOne',
      getHistorySlotAt: (idx: number) =>
        buildRewinderHistorySlotAt(rewinderFrames, idx, runtime.playerCarIndex ?? 0),
      onBeforeReconstruct: (liveTick: number) => {
        this.exitGoalOrReplayIfNeeded(runtime, mode);
        this.applyFrameAtCursor(runtime, rewinderFrames, cursor, false, { overrideTick: liveTick });
      },
      onAfterReconstruct: () => {
        if (runtime.keyboard) runtime.keyboard.ballControlEnabled = true;
        if (runtime.playerControls) {
          runtime.physics?.setControls?.(runtime.playerCarIndex || 0, runtime.playerControls);
        }
      },
    });
  }

  public beginResumePreroll(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    takeoverSubController: ReplayTakeoverSubController,
  ): void {
    const store = useRewinderStore.getState();
    const downSec = store.rewinderDownCounterSec ?? 0;
    const minRequiredFrames = downSec === 0 ? 120 : 240;
    if (!runtime?.physics || rewinderFrames.length < minRequiredFrames) return;

    this.exitGoalOrReplayIfNeeded(runtime, mode);
    if (runtime.keyboard) runtime.keyboard.ballControlEnabled = false;

    if (store.rewinderState === 'recording') {
      const lastFrame = Math.max(0, rewinderFrames.length - 1);
      takeoverSubController.reset(lastFrame, lastFrame);
    }

    const baseTarget =
      store.rewinderState === 'preroll-countdown' || store.rewinderState === 'stopped'
        ? takeoverSubController.targetFrame || takeoverSubController.cursor
        : takeoverSubController.cursor;

    const audio = runtime.options?.gameAudio || gameAudio;
    const { targetIdx, startIdx, remSec } = takeoverSubController.beginPrerollCountdown(
      rewinderFrames.length,
      baseTarget,
      downSec,
      audio,
    );

    runtime.physics.setUnlimitedBoost?.(false);
    const entry = this.applyFrameAtCursor(runtime, rewinderFrames, startIdx, false, {
      preserveEngineTick: true,
    });
    runtime.simulationStage?.resetActionStates?.();
    emitSystemControlTransition(
      runtime,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      targetIdx,
      remSec,
      entry?.compactSnap || runtime.physics?.saveCompactState?.(),
    );

    store.updateLiveTelemetry({
      rewinderState: 'preroll-countdown',
      rewinderRecordedFrames: rewinderFrames.length,
      rewinderCursorFrame: startIdx,
      rewinderTargetFrame: targetIdx,
      rewinderPrerollRemainingSec: remSec,
    });
  }

  public stepPrerollCountdownTick(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    takeoverSubController: ReplayTakeoverSubController,
  ): boolean {
    const store = useRewinderStore.getState();
    return takeoverSubController.stepPrerollCountdown({
      totalFrames: rewinderFrames.length,
      downCounterSec: store.rewinderDownCounterSec ?? 0,
      displayedRemainingSec: store.rewinderPrerollRemainingSec ?? 0,
      audio: runtime?.options?.gameAudio || gameAudio,
      onApplyFrameAtCursor: (cursorIdx: number) => {
        const entry = this.applyFrameAtCursor(runtime, rewinderFrames, cursorIdx, true, {
          preserveEngineTick: true,
        });
        if (entry?.controls && runtime) {
          runtime.playerThrottle = Number(entry.controls.throttle ?? 0);
          runtime.playerControls = { ...entry.controls };
        }
        if (entry?.incidents?.length || entry?.signals?.length || entry?.audioEvents?.length) {
          dispatchReplayFrameEvents(
            {
              incidents: entry.incidents || [],
              signals: entry.signals || [],
              audioEvents: entry.audioEvents || [],
            },
            runtime,
          );
        }
      },
      onHandoffToLiveFreeplay: (targetIdx: number) => {
        runtime?.physics?.setUnlimitedBoost?.(false);
        this.executeHandoffToLiveFreeplay(
          runtime,
          mode,
          rewinderFrames,
          targetIdx,
          takeoverSubController.cursor,
        );
        store.updateLiveTelemetry({
          rewinderState: 'stopped',
          rewinderCursorFrame: targetIdx,
          rewinderTargetFrame: targetIdx,
          rewinderPrerollRemainingSec: 0,
        });
      },
      onUpdateCountdownTelemetry: (cursorFrame: number, remainingSec: number) =>
        store.updateLiveTelemetry({
          rewinderCursorFrame: cursorFrame,
          rewinderPrerollRemainingSec: remainingSec,
        }),
    });
  }

  public recordPhysicsEvent(
    rewinderFrames: RewinderFrameEntry[],
    event: RewinderIncidentRecord | null | undefined,
    runtime: FreeplayRewinderRuntimePort | null,
  ): void {
    if (!event || useRewinderStore.getState().rewinderState !== 'recording') return;
    recordPhysicsEventIntoRewinderFrames(
      rewinderFrames,
      this._pendingFrameIncidents,
      event,
      runtime?.physics?.getHeaderView?.()?.tickCount,
    );
  }

  public recordTickFrame(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null,
    rewinderFrames: RewinderFrameEntry[],
    takeoverSubController: ReplayTakeoverSubController,
  ): void {
    const store = useRewinderStore.getState();
    if (store.rewinderState !== 'recording' || !runtime?.physics) {
      this._pendingFrameIncidents.length = 0;
      return;
    }

    const compactSnap = runtime.physics.saveCompactState?.() ?? runtime.physics.state.slice();
    const currentTick = Math.floor(runtime.physics.getHeaderView?.()?.tickCount ?? 0);
    const incidents =
      this._pendingFrameIncidents.length > 0 ? this._pendingFrameIncidents.slice() : [];
    this._pendingFrameIncidents.length = 0;

    if (rewinderFrames.length >= MAX_REWINDER_FRAMES) {
      rewinderFrames.shift();
    }
    const lastTouchTick = mode?.goalAndTouch?.lastTouchTick ?? -1;
    rewinderFrames.push({
      compactSnap,
      renderState: compactSnap,
      controls: { ...(runtime.playerControls || DEFAULT_CAR_CONTROLS) },
      incidents,
      hadTouch: Boolean(mode && lastTouchTick === currentTick),
      lastTouchTick,
    });
    runtime.physics.recordReplayFrame?.();
    const lastIdx = rewinderFrames.length - 1;
    takeoverSubController.cursor = lastIdx;
    takeoverSubController.targetFrame = lastIdx;

    if (
      rewinderFrames.length % 6 === 0 ||
      rewinderFrames.length === 120 ||
      rewinderFrames.length === 240
    ) {
      store.updateLiveTelemetry({
        rewinderRecordedFrames: rewinderFrames.length,
        rewinderCursorFrame: lastIdx,
        rewinderTargetFrame: lastIdx,
      });
    }
  }

  public async exportReplay(
    rewinderFrames: RewinderFrameEntry[],
    mode: FreeplayRewinderModePort | null,
    runtime?: FreeplayRewinderRuntimePort | null,
  ): Promise<boolean> {
    if (rewinderFrames.length > 0) {
      return exportStateReplayFile(rewinderFrames);
    }
    const serverRing = (
      runtime as { authoritativeServer?: { hostReplayRingBuffer?: { getRecentFrames?(): Array<RewinderFrameEntry | null> } | null } | null } | null | undefined
    )?.authoritativeServer?.hostReplayRingBuffer;
    const ringFrames = serverRing?.getRecentFrames?.() ?? mode?.replayRingBuffer?.getRecentFrames?.();
    if (Array.isArray(ringFrames) && ringFrames.length > 0) {
      return exportStateReplayFile(
        ringFrames.filter((f): f is NonNullable<typeof f> => f !== null),
      );
    }
    return false;
  }

  public async importReplay(
    fileOrBuffer: unknown,
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null,
    takeoverSubController: ReplayTakeoverSubController,
  ): Promise<{ frames: RewinderFrameEntry[]; timelines: Record<string, unknown> | null } | null> {
    if (!runtime?.physics) return null;
    try {
      const parsed = await parseRCReplayFile(fileOrBuffer);
      if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) {
        throw new Error('No valid frames found in replay file.');
      }
      const timelines = parsed.timelines || null;
      const frames = buildRewinderFramesFromParsedReplay(parsed, runtime.neutralControls);
      const lastIdx = Math.max(0, frames.length - 1);
      takeoverSubController.reset(0, lastIdx);
      this.applyFrameAndEmitStateOnly(runtime, mode, frames, 0, true);
      runtime.simulationStage?.resetActionStates?.();

      useRewinderStore.getState().updateLiveTelemetry({
        rewinderState: 'paused-scrub',
        rewinderRecordedFrames: frames.length,
        rewinderCursorFrame: 0,
        rewinderTargetFrame: lastIdx,
        rewinderPrerollRemainingSec: 0,
      });
      return { frames, timelines };
    } catch (err) {
      console.error('[FreeplayRewinderController] Failed to import replay file:', err);
      return null;
    }
  }

  public resetArenaCarsIfAllowed(
    runtime: FreeplayRewinderRuntimePort | null,
    mode: FreeplayRewinderModePort | null,
    wasBlocking: boolean,
  ): boolean {
    return resetRewinderArenaCarsIfAllowed(runtime, mode, wasBlocking);
  }
}
