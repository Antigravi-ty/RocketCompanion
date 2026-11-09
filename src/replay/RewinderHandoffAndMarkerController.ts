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
  options?: {
    gameAudio?: { silenceAll?: () => void; play?: (cue: string, volume?: number) => void } | null;
  } | null;
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
      options?: {
        acknowledgedControls?: ReadonlyArray<Record<string, unknown> | null | undefined> | null;
      }
    ) => { snapshot?: Float32Array | null } | null;
    appendIncident?: (tick: number, incident: Record<string, unknown>) => void;
  } | null;
  lastTouchTick?: number;
}

export async function exportRewinderReplay(
  rewinderFrames: RewinderFrameEntry[],
  freeplayPort: FreeplayRewinderModePort | null,
  runtimePort?: FreeplayRewinderRuntimePort | null
): Promise<boolean> {
  if (rewinderFrames.length > 0) {
    return exportStateReplayFile(rewinderFrames);
  }
  const serverRing = (
    runtimePort as
      | {
          authoritativeServer?: {
            hostReplayRingBuffer?: {
              getRecentFrames?(): Array<RewinderFrameEntry | null>;
            } | null;
          } | null;
        }
      | null
      | undefined
  )?.authoritativeServer?.hostReplayRingBuffer;
  const ringFrames =
    serverRing?.getRecentFrames?.() ?? freeplayPort?.replayRingBuffer?.getRecentFrames?.();
  if (Array.isArray(ringFrames) && ringFrames.length > 0) {
    return exportStateReplayFile(ringFrames.filter((f): f is NonNullable<typeof f> => f !== null));
  }
  return false;
}

export class RewinderHandoffAndMarkerController {
  private _pendingFrameIncidents: RewinderIncidentRecord[] = [];

  public clearPendingIncidents(): void {
    this._pendingFrameIncidents.length = 0;
  }

  public exitGoalOrReplayIfNeeded(
    runtimePort: FreeplayRewinderRuntimePort | null,
    freeplayPort: FreeplayRewinderModePort | null
  ): void {
    if (!runtimePort || !freeplayPort) return;
    const isReplayActive = Boolean(
      freeplayPort.directorPreview?.isReplayActive || freeplayPort.isGoalReplayActive?.()
    );
    const goalResetTicks =
      freeplayPort.goalAndTouch?.getEffectiveGoalResetTicks?.() ??
      freeplayPort.goalAndTouch?.goalResetTicks ??
      0;

    if (isReplayActive || goalResetTicks > 0 || runtimePort.match?.state?.phase !== 'playing') {
      freeplayPort.replayController?.endReplaySession?.();
      if (freeplayPort.directorPreview) freeplayPort.directorPreview.isReplayActive = false;
      if (freeplayPort.goalAndTouch) {
        Object.assign(freeplayPort.goalAndTouch, {
          goalResetTicks: 0,
          frozenGoalBallState: null,
          goalIncidentTick: -1,
        });
      }
      runtimePort.releaseGoalReplayCameraOverride?.();
      if (runtimePort.match?.state) runtimePort.match.state.phase = 'playing';
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
    runtimePort: FreeplayRewinderRuntimePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    cursor: number,
    smoothStep: boolean = false,
    restoreOptions: { preserveEngineTick?: boolean; overrideTick?: number } = {
      preserveEngineTick: true,
    }
  ): RewinderFrameEntry | null {
    return applyRewinderFrameToPhysics({
      physics: runtimePort?.physics,
      interpolator: runtimePort?.interpolator,
      arena: runtimePort?.arena,
      rewinderFrames,
      rewinderCursor: cursor,
      smoothStep,
      restoreOptions,
    });
  }

  public applyFrameAndEmitStateOnly(
    runtimePort: FreeplayRewinderRuntimePort | null,
    freeplayPort: FreeplayRewinderModePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    frameIdx: number,
    disableBallControl = true
  ): RewinderFrameEntry | null {
    if (disableBallControl) {
      this.exitGoalOrReplayIfNeeded(runtimePort, freeplayPort);
      if (runtimePort?.keyboard) runtimePort.keyboard.ballControlEnabled = false;
    }
    const entry = this.applyFrameAtCursor(runtimePort, rewinderFrames, frameIdx, false, {
      preserveEngineTick: true,
    });
    emitSystemControlTransition(
      runtimePort,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      frameIdx,
      0,
      entry?.compactSnap || runtimePort?.physics?.saveCompactState?.()
    );
    return entry;
  }

  public executeHandoffToLiveFreeplay(
    runtimePort: FreeplayRewinderRuntimePort | null,
    freeplayPort: FreeplayRewinderModePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    targetIdx: number,
    cursor: number
  ): void {
    if (!runtimePort?.physics || rewinderFrames.length === 0) return;
    const self = this;
    executeLiveFreeplayHandoff({
      runtime: runtimePort,
      freeplayMode: freeplayPort,
      targetIdx,
      fallbackLastTouchTick: 'minusOne',
      getHistorySlotAt(idx: number) {
        return buildRewinderHistorySlotAt(rewinderFrames, idx, runtimePort.playerCarIndex ?? 0);
      },
      beforeReconstruct(liveTick: number) {
        self.exitGoalOrReplayIfNeeded(runtimePort, freeplayPort);
        self.applyFrameAtCursor(runtimePort, rewinderFrames, cursor, false, {
          overrideTick: liveTick,
        });
      },
      afterReconstruct() {
        if (runtimePort.keyboard) runtimePort.keyboard.ballControlEnabled = true;
        if (runtimePort.playerControls) {
          runtimePort.physics?.setControls?.(
            runtimePort.playerCarIndex || 0,
            runtimePort.playerControls
          );
        }
      },
    });
  }

  public beginResumePreroll(
    runtimePort: FreeplayRewinderRuntimePort | null,
    freeplayPort: FreeplayRewinderModePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    takeoverSubController: ReplayTakeoverSubController
  ): void {
    const store = useRewinderStore.getState();
    const downSec = store.rewinderDownCounterSec ?? 0;
    const minRequiredFrames = downSec === 0 ? 120 : 240;
    if (!runtimePort?.physics || rewinderFrames.length < minRequiredFrames) return;

    this.exitGoalOrReplayIfNeeded(runtimePort, freeplayPort);
    if (runtimePort.keyboard) runtimePort.keyboard.ballControlEnabled = false;

    if (store.rewinderState === 'recording') {
      const lastFrame = Math.max(0, rewinderFrames.length - 1);
      takeoverSubController.reset(lastFrame, lastFrame);
    }

    const baseTarget =
      store.rewinderState === 'preroll-countdown' || store.rewinderState === 'stopped'
        ? takeoverSubController.targetFrame || takeoverSubController.cursor
        : takeoverSubController.cursor;

    const audio = runtimePort.options?.gameAudio || gameAudio;
    const { targetIdx, startIdx, remSec } = takeoverSubController.beginPrerollCountdown(
      rewinderFrames.length,
      baseTarget,
      downSec,
      audio
    );

    runtimePort.physics.setUnlimitedBoost?.(false);
    const entry = this.applyFrameAtCursor(runtimePort, rewinderFrames, startIdx, false, {
      preserveEngineTick: true,
    });
    runtimePort.simulationStage?.resetActionStates?.();
    emitSystemControlTransition(
      runtimePort,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      targetIdx,
      remSec,
      entry?.compactSnap || runtimePort.physics?.saveCompactState?.()
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
    runtimePort: FreeplayRewinderRuntimePort | null,
    freeplayPort: FreeplayRewinderModePort | null,
    rewinderFrames: ReadonlyArray<RewinderFrameEntry>,
    takeoverSubController: ReplayTakeoverSubController
  ): boolean {
    const store = useRewinderStore.getState();
    const outcome = takeoverSubController.stepPrerollCountdown({
      totalFrames: rewinderFrames.length,
      downCounterSec: store.rewinderDownCounterSec ?? 0,
      displayedRemainingSec: store.rewinderPrerollRemainingSec ?? 0,
      audio: runtimePort?.options?.gameAudio || gameAudio,
    });

    const entry = this.applyFrameAtCursor(
      runtimePort,
      rewinderFrames,
      outcome.appliedCursor,
      true,
      {
        preserveEngineTick: true,
      }
    );
    if (entry?.controls && runtimePort) {
      runtimePort.playerThrottle = Number(entry.controls.throttle ?? 0);
      runtimePort.playerControls = { ...entry.controls };
    }
    if (entry?.incidents?.length || entry?.signals?.length || entry?.audioEvents?.length) {
      dispatchReplayFrameEvents(
        {
          incidents: entry.incidents || [],
          signals: entry.signals || [],
          audioEvents: entry.audioEvents || [],
        },
        runtimePort
      );
    }

    if (outcome.handoffTargetIdx !== null) {
      runtimePort?.physics?.setUnlimitedBoost?.(false);
      this.executeHandoffToLiveFreeplay(
        runtimePort,
        freeplayPort,
        rewinderFrames,
        outcome.handoffTargetIdx,
        takeoverSubController.cursor
      );
      store.updateLiveTelemetry({
        rewinderState: 'stopped',
        rewinderCursorFrame: outcome.handoffTargetIdx,
        rewinderTargetFrame: outcome.handoffTargetIdx,
        rewinderPrerollRemainingSec: 0,
      });
    } else if (outcome.telemetryUpdate) {
      store.updateLiveTelemetry({
        rewinderCursorFrame: outcome.telemetryUpdate.cursorFrame,
        rewinderPrerollRemainingSec: outcome.telemetryUpdate.remainingSec,
      });
    }
    return false;
  }

  public recordPhysicsEvent(
    rewinderFrames: RewinderFrameEntry[],
    event: RewinderIncidentRecord | null | undefined,
    runtimePort: FreeplayRewinderRuntimePort | null
  ): void {
    if (!event || useRewinderStore.getState().rewinderState !== 'recording') return;
    recordPhysicsEventIntoRewinderFrames(
      rewinderFrames,
      this._pendingFrameIncidents,
      event,
      runtimePort?.physics?.getHeaderView?.()?.tickCount
    );
  }

  public recordTickFrame(
    runtimePort: FreeplayRewinderRuntimePort | null,
    freeplayPort: FreeplayRewinderModePort | null,
    rewinderFrames: RewinderFrameEntry[],
    takeoverSubController: ReplayTakeoverSubController
  ): void {
    const store = useRewinderStore.getState();
    const physics = runtimePort?.physics;
    if (store.rewinderState !== 'recording' || !runtimePort || !physics) {
      this._pendingFrameIncidents.length = 0;
      return;
    }

    const compactSnap = physics.saveCompactState?.() ?? physics.state.slice();
    const currentTick = Math.floor(physics.getHeaderView?.()?.tickCount ?? 0);
    const incidents =
      this._pendingFrameIncidents.length > 0 ? this._pendingFrameIncidents.slice() : [];
    this._pendingFrameIncidents.length = 0;

    if (rewinderFrames.length >= MAX_REWINDER_FRAMES) {
      rewinderFrames.shift();
    }
    const lastTouchTick = freeplayPort?.goalAndTouch?.lastTouchTick ?? -1;
    rewinderFrames.push({
      compactSnap,
      renderState: compactSnap,
      controls: { ...(runtimePort.playerControls || DEFAULT_CAR_CONTROLS) },
      incidents,
      hadTouch: Boolean(freeplayPort && lastTouchTick === currentTick),
      lastTouchTick,
    });
    physics.recordReplayFrame?.();
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
    freeplayPort: FreeplayRewinderModePort | null,
    runtimePort?: FreeplayRewinderRuntimePort | null
  ): Promise<boolean> {
    return exportRewinderReplay(rewinderFrames, freeplayPort, runtimePort);
  }

  public async importReplay(
    fileOrBuffer: unknown,
    runtimePort: FreeplayRewinderRuntimePort | null,
    freeplayPort: FreeplayRewinderModePort | null,
    takeoverSubController: ReplayTakeoverSubController
  ): Promise<{ frames: RewinderFrameEntry[]; timelines: Record<string, unknown> | null } | null> {
    if (!runtimePort?.physics) return null;
    try {
      const parsed = await parseRCReplayFile(fileOrBuffer);
      if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) {
        throw new Error('No valid frames found in replay file.');
      }
      const timelines = parsed.timelines || null;
      const frames = buildRewinderFramesFromParsedReplay(parsed, runtimePort.neutralControls);
      const lastIdx = Math.max(0, frames.length - 1);
      takeoverSubController.reset(0, lastIdx);
      this.applyFrameAndEmitStateOnly(runtimePort, freeplayPort, frames, 0, true);
      runtimePort.simulationStage?.resetActionStates?.();

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
    runtimePort: FreeplayRewinderRuntimePort | null,
    freeplayPort: FreeplayRewinderModePort | null,
    wasBlocking: boolean
  ): boolean {
    return resetRewinderArenaCarsIfAllowed(runtimePort, freeplayPort, wasBlocking);
  }
}
