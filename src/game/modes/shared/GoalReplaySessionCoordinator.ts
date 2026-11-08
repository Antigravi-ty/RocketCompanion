import { hudStore } from '../../runtimeUiPort.ts';
import {
  applyReplayFrameToEngine,
  type ReplayFrameEnginePort,
  type ReplayFrameInterpolatorStatePort,
} from '../../../replay/ReplayFrameInterpolator.ts';
import {
  applyDirectorReplayCamera,
  type DirectorCameraRuntimeState,
  type DirectorCameraTargetPort,
  type DirectorInterpolatorSnapshot,
} from '../../../replay/ReplayDirectorCamera.ts';
import {
  dispatchReplayFrameEvents,
  type DispatchReplayEventsOptions,
  type ReplayEventDispatcherRuntimePort,
  type ReplayStepEventsPayload,
} from '../../../replay/ReplayFrameEventDispatcher.ts';
import type { ReplayCarEntryRuntimePort } from '../../../replay/replayDirectorCarRosterPipeline.ts';
import type {
  ReplayInterpolatorPort,
  ReplayPhysicsEnginePort,
  ReplaySessionInitOptions,
  ReplaySessionState,
} from '../../../replay/ReplayDirectorStatePipeline.ts';
import type { ReplayPlaybackStepResult } from '../../../replay/ReplayTimelineController.ts';
import {
  applyGoalReplayCarAudioControls,
  bindGoalReplayHudStateAndCallbacks,
  evaluateGoalReplayCarContext,
  shouldEmitGoalReplayWillEndSignal,
  type GoalReplayCameraMode,
  type GoalReplayCarStateViewLike,
  type GoalReplayHudControllerPort,
  type GoalReplayHudRuntimePort,
  type GoalReplayHudSessionOptions as BaseGoalReplayHudSessionOptions,
} from './goalReplayHudPipeline.ts';

export type { GoalReplayCameraMode };

export interface GoalReplayCameraPort extends DirectorCameraTargetPort {
  setFocusedCarIndex?: (carIndex: number) => void;
  resetView?: () => void;
  getDirectorFov?: () => number;
  getFreeCamFov?: () => number;
  setFreeCamFov?: (fov: number) => void;
  setFreeCamPose?: (eyeThreeJs: number[], targetThreeJs: number[]) => void;
  up?: { set?: (x: number, y: number, z: number) => void } | null;
}

export interface GoalReplayInterpolatorPort
  extends ReplayInterpolatorPort,
    ReplayFrameInterpolatorStatePort {
  alpha: number;
  prevState: Float32Array;
  currState: Float32Array;
  sync?: (timestamp?: number) => void;
  getCurrCarStateView?: (carIndex: number) => GoalReplayCarStateViewLike | null | undefined;
}

export interface GoalReplayRuntimePort
  extends GoalReplayHudRuntimePort,
    ReplayEventDispatcherRuntimePort,
    ReplayCarEntryRuntimePort {
  physics?: (ReplayFrameEnginePort &
    ReplayPhysicsEnginePort &
    NonNullable<ReplayCarEntryRuntimePort['physics']> & {
      setCarHitbox?: (carIndex: number, hitboxId: string) => void;
    }) | null;
  interpolator?: GoalReplayInterpolatorPort | null;
  camera?: GoalReplayCameraPort | null;
  arena?: (NonNullable<ReplayCarEntryRuntimePort['arena']> & {
    playerCarIndex?: number;
    isGoalReplayActive?: boolean;
    cars?: Array<{ visible?: boolean } | null | undefined>;
    setCarLoadout?: (carIndex: number, loadout: Record<string, unknown>) => void;
  }) | null;
  ballTrajectoryPredictor?: {
    clear?: () => void;
    acquireTemporarySuppression?: (source?: string) => void;
    releaseTemporarySuppression?: (source?: string | null) => void;
    setSceneContext?: (ctx: { isGoalReplayActive?: boolean }) => void;
  } | null;
  match?: { state?: { phase?: string; scorer?: number | null; scorerCarIndex?: number | null } | null } | null;
  networkReconciler?: {
    localCarIndex?: number;
    replayPlaybackMode?: boolean;
    lastParsedPacket?: { stateSnapshot?: Float32Array | null } | null;
  } | null;
  reconciler?: { localCarIndex?: number } | null;
  playerCarIndex?: number;
  replayPovCarIndex?: number | null;
  acquireGoalReplayCameraOverride?: (source?: string) => void;
  releaseGoalReplayCameraOverride: (source?: string | null) => void;
  isGoalReplayCameraOverrideActive?: () => boolean;
}

export interface GoalReplayTimelineControllerPort extends GoalReplayHudControllerPort {
  progress: number;
  currentFrameIndex: number;
  directorCameraState?: DirectorCameraRuntimeState | null;
  sessionState: Partial<ReplaySessionState> & {
    isActive?: boolean;
    scoringTeam?: number;
    scorerCarIndex?: number;
    isPaused?: boolean;
    isPersistent?: boolean;
    isScrubbing?: boolean;
    playbackSpeed?: number;
  };
  beginReplaySession: (options?: ReplaySessionInitOptions) => number;
  endReplaySession?: () => void;
  stepPlayback: (
    dtSeconds: number,
    interpolator?: ReplayInterpolatorPort | null,
    applyToEngine?: boolean
  ) => ReplayPlaybackStepResult;
}

export type GoalReplayHudSessionOptions = BaseGoalReplayHudSessionOptions<
  GoalReplayRuntimePort,
  GoalReplayTimelineControllerPort
>;

export interface GoalReplayFrameContextPort {
  dt?: number;
  activeCar?: number;
  activeCarMesh?: unknown;
  playerCarView?: GoalReplayCarStateViewLike | null;
  isSupersonic?: boolean;
  curBoost?: number;
}

export interface GoalReplayFrameStepOptions {
  runtime?: GoalReplayRuntimePort | null;
  replayController?: GoalReplayTimelineControllerPort | null;
  context?: GoalReplayFrameContextPort | null;
  source?: string;
  dt?: number;
  applyToEngine?: boolean;
  dispatchEvents?: boolean;
  eventDispatchOptions?: DispatchReplayEventsOptions;
  cameraMode?: GoalReplayCameraMode;
  scoringTeam?: number;
  scorerCarIndex?: number;
  povCarIndex?: number | null;
  isUnlimitedBoost?: boolean;
  syncActiveCarContext?: boolean;
  syncPlayerThrottleFromCarView?: boolean;
  syncCarAudioControls?: boolean;
  syncBoostToHud?: boolean;
  emitWillEndChoreography?: boolean;
  emitWillEndSignal?: boolean;
  syncHudProgress?: boolean;
  networkStreamSnapshot?: Float32Array | null;
  overrideProgress?: number | null;
  resolveEffectiveProgress?: (stepRes: ReplayPlaybackStepResult) => number;
  onStepAfterEvents?: (stepRes: ReplayPlaybackStepResult, povCarIdx: number) => void;
  onComplete?: (stepRes: ReplayPlaybackStepResult) => void;
}

export interface EndGoalReplaySessionOptions {
  source?: string | null;
  clearHud?: boolean;
  resetHudFlags?: boolean;
  restoreLocalCarFocus?: boolean;
  fallbackLocalCarIndex?: number;
  syncAfterEnd?: boolean;
}

export function applyGoalReplayCameraModeSelection(
  runtime: GoalReplayRuntimePort | null | undefined,
  cameraMode: GoalReplayCameraMode = 'director',
  source = 'goal-replay'
): void {
  if (!runtime) return;
  if (cameraMode === 'director') {
    runtime.acquireGoalReplayCameraOverride?.(source);
  } else {
    runtime.releaseGoalReplayCameraOverride?.(source);
  }
}

export function bindGoalReplayHudCallbacks(options: GoalReplayHudSessionOptions): void {
  const { runtime, replayController } = options;
  if (!replayController) return;
  const source = options.source || 'goal-replay';

  const refreshDirectorCamera = (scoringTeam: number, scorerCarIndex: number): void => {
    applyDirectorReplayCamera(
      runtime?.camera,
      runtime?.interpolator as DirectorInterpolatorSnapshot | null | undefined,
      replayController.progress,
      scoringTeam,
      0.016,
      scorerCarIndex,
      replayController.directorCameraState
    );
  };

  bindGoalReplayHudStateAndCallbacks(options, {
    onRefreshDirectorCamera: refreshDirectorCamera,
    onSelectCameraMode: (nextMode, povCarIdx, scoringTeam, scorerCarIndex) => {
      applyGoalReplayCameraModeSelection(runtime, nextMode, source);
      if (nextMode === 'director' || typeof povCarIdx !== 'number' || povCarIdx < 0) {
        if (runtime) runtime.replayPovCarIndex = null;
        if (replayController.directorCameraState) {
          replayController.directorCameraState.initialized = false;
        }
        refreshDirectorCamera(scoringTeam, scorerCarIndex);
      } else {
        if (runtime) runtime.replayPovCarIndex = povCarIdx;
        if (options.onApplyPovCarIndex) {
          options.onApplyPovCarIndex(povCarIdx);
        } else if (runtime) {
          runtime.playerCarIndex = povCarIdx;
          if (runtime.arena) runtime.arena.playerCarIndex = povCarIdx;
          runtime.camera?.setFocusedCarIndex?.(povCarIdx);
        }
        runtime?.camera?.resetView?.();
      }
    },
  });
}

export function beginGoalReplaySession(
  runtime: GoalReplayRuntimePort | null | undefined,
  replayController: GoalReplayTimelineControllerPort | null | undefined,
  options: GoalReplayHudSessionOptions = {}
): void {
  const cameraMode = options.cameraMode || 'director';
  const source = options.source || 'goal-replay';
  const scoringTeam =
    options.scoringTeam ?? options.scorerTeam ?? replayController?.sessionState?.scoringTeam ?? 0;
  const scorerCarIndex = options.scorerCarIndex ?? replayController?.sessionState?.scorerCarIndex ?? 0;

  runtime?.ballTrajectoryPredictor?.acquireTemporarySuppression?.(source);
  applyGoalReplayCameraModeSelection(runtime, cameraMode, source);

  if (options.initialSnapshot && runtime?.physics) {
    applyReplayFrameToEngine(
      runtime.physics,
      options.initialSnapshot,
      runtime.interpolator ?? null,
      options.initialSnapshot,
      1.0
    );
    if (cameraMode === 'director') {
      applyDirectorReplayCamera(
        runtime.camera,
        runtime.interpolator,
        replayController?.progress ?? 0,
        scoringTeam,
        0.016,
        scorerCarIndex,
        replayController?.directorCameraState
      );
    }
  }
  if (options.syncHud !== false) {
    bindGoalReplayHudCallbacks({ ...options, runtime, replayController });
  }
}

export function stepGoalReplaySessionFrame(
  options: GoalReplayFrameStepOptions
): ReplayPlaybackStepResult {
  const { runtime, replayController, context } = options;
  if (!replayController) {
    return { frame: null, progress: 0, frameIndex: 0, totalFrames: 0, isFinished: false, incidents: [], audioEvents: [] };
  }

  const dt = options.dt ?? context?.dt ?? 0.016;
  const source = options.source || 'goal-replay';
  const cameraMode: GoalReplayCameraMode = options.cameraMode || 'director';
  const s = replayController.sessionState;
  const scoringTeam = options.scoringTeam ?? s?.scoringTeam ?? 0;
  const scorerCarIndex = options.scorerCarIndex ?? s?.scorerCarIndex ?? 0;
  const povCarIdx =
    typeof options.povCarIndex === 'number' && options.povCarIndex >= 0
      ? options.povCarIndex
      : scorerCarIndex;

  runtime?.ballTrajectoryPredictor?.acquireTemporarySuppression?.(source);

  const stepRes = replayController.stepPlayback(
    dt,
    runtime?.interpolator ?? null,
    options.applyToEngine ?? true
  );

  if (options.networkStreamSnapshot && runtime?.physics) {
    applyReplayFrameToEngine(
      runtime.physics,
      options.networkStreamSnapshot,
      runtime.interpolator ?? null
    );
  }
  if (options.dispatchEvents !== false) {
    dispatchReplayFrameEvents(
      stepRes as unknown as ReplayStepEventsPayload,
      runtime ?? null,
      options.eventDispatchOptions
    );
  }

  const effectiveProgress =
    typeof options.overrideProgress === 'number'
      ? options.overrideProgress
      : options.resolveEffectiveProgress
        ? options.resolveEffectiveProgress(stepRes)
        : stepRes.progress;

  applyGoalReplayCameraModeSelection(runtime, cameraMode, source);
  if (cameraMode === 'director') {
    applyDirectorReplayCamera(
      runtime?.camera,
      runtime?.interpolator,
      effectiveProgress,
      scoringTeam,
      dt,
      scorerCarIndex,
      replayController.directorCameraState
    );
  } else if (runtime && typeof options.povCarIndex === 'number' && options.povCarIndex >= 0) {
    runtime.replayPovCarIndex = povCarIdx;
    runtime.playerCarIndex = povCarIdx;
    if (runtime.arena) runtime.arena.playerCarIndex = povCarIdx;
  }

  options.onStepAfterEvents?.(stepRes, povCarIdx);

  if (options.syncActiveCarContext !== false && context) {
    const activeReplayCarView = runtime?.interpolator?.getCurrCarStateView?.(povCarIdx);
    const activeCarMesh = runtime?.arena?.cars?.[povCarIdx];
    const evalCar = evaluateGoalReplayCarContext(activeReplayCarView, activeCarMesh, povCarIdx);
    context.activeCar = evalCar.activeCar;
    context.activeCarMesh = evalCar.activeCarMesh;
    context.playerCarView = evalCar.playerCarView ?? null;
    context.isSupersonic = evalCar.isSupersonic;
    context.curBoost = evalCar.curBoost;

    if (activeReplayCarView) {
      if (options.syncPlayerThrottleFromCarView ?? options.syncCarAudioControls ?? false) {
        applyGoalReplayCarAudioControls(runtime, evalCar);
      }
      if (options.syncBoostToHud !== false) {
        hudStore
          .getState()
          .setBoost(
            activeReplayCarView.boost,
            Boolean(activeReplayCarView.isBoosting),
            Boolean(options.isUnlimitedBoost)
          );
      }
    }
  }

  const postStepState = replayController.sessionState ?? s;
  const shouldEmitWillEnd = options.emitWillEndChoreography ?? options.emitWillEndSignal ?? true;
  if (
    shouldEmitWillEnd &&
    shouldEmitGoalReplayWillEndSignal(
      stepRes,
      Boolean(postStepState?.isPaused),
      Boolean(postStepState?.isPersistent)
    )
  ) {
    hudStore.getState().setChoreographySignal('goal-replay-will-end');
  }

  if (options.syncHudProgress !== false) {
    hudStore.getState().setReplayState({
      replayProgress: effectiveProgress,
      replayFrameIndex: stepRes.frameIndex,
      replayTotalFrames: stepRes.totalFrames,
      replayPaused: postStepState?.isPaused,
      replayPersistent: postStepState?.isPersistent,
      replayCameraMode: cameraMode,
      replaySpeed: postStepState?.playbackSpeed,
    });
  }
  if (stepRes.isFinished && !postStepState?.isPaused && !postStepState?.isPersistent) {
    options.onComplete?.(stepRes);
  }
  return stepRes;
}

export function endGoalReplaySession(
  runtime: GoalReplayRuntimePort | null | undefined,
  replayController: GoalReplayTimelineControllerPort | null | undefined,
  options: EndGoalReplaySessionOptions = {}
): void {
  const source = options.source || null;
  replayController?.endReplaySession?.();
  if (runtime) {
    runtime.releaseGoalReplayCameraOverride?.(source);
    runtime.ballTrajectoryPredictor?.releaseTemporarySuppression?.(source);
    runtime.ballTrajectoryPredictor?.setSceneContext?.({ isGoalReplayActive: false });
    if (runtime.arena) {
      runtime.arena.isGoalReplayActive = false;
    }
    runtime.replayPovCarIndex = null;
    runtime.camera?.up?.set?.(0, 1, 0);
    if (options.restoreLocalCarFocus) {
      const localCarIdx =
        typeof runtime.networkReconciler?.localCarIndex === 'number' &&
        runtime.networkReconciler.localCarIndex >= 0
          ? runtime.networkReconciler.localCarIndex
          : typeof runtime.reconciler?.localCarIndex === 'number' &&
              runtime.reconciler.localCarIndex >= 0
            ? runtime.reconciler.localCarIndex
            : (options.fallbackLocalCarIndex ?? runtime.playerCarIndex ?? 0);
      runtime.playerCarIndex = localCarIdx;
      if (runtime.arena) runtime.arena.playerCarIndex = localCarIdx;
      runtime.camera?.setFocusedCarIndex?.(localCarIdx);
      if (options.syncAfterEnd) {
        runtime.camera?.resetView?.();
        runtime.interpolator?.sync?.();
      }
    }
  }
  const hud = hudStore.getState();
  if (options.clearHud === true) {
    if (typeof hud.clearReplayState === 'function') {
      hud.clearReplayState();
    } else {
      hud.setReplayState?.({
        replayProgress: 0, replayFrameIndex: 0, replayPaused: false, replayPersistent: false,
        replayCameraMode: 'director', replayScorerName: null, replayScorerTeam: null,
        replayScorerAnthemId: null, replayBallSpeedKph: null, replayAssistName: null,
        onReplaySeekNormalized: null, onReplayTogglePause: null, onReplayCycleSpeed: null,
        onReplayToggleCameraMode: null, onReplaySelectPovCar: null,
      });
    }
  } else if (options.resetHudFlags !== false) {
    hud.setReplayState?.({
      replayPaused: false,
      replayPersistent: false,
      replayCameraMode: 'director',
      onReplaySelectPovCar: null,
    });
  }
}
