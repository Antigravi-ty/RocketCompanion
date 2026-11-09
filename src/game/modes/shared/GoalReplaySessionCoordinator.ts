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
import { warmupArenaTrailsFromReplayWindow } from '../../../entities/vehicle/supersonic-trail/SupersonicWheelTrailReplaySync.ts';
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
  extends ReplayInterpolatorPort, ReplayFrameInterpolatorStatePort {
  alpha: number;
  prevState: Float32Array;
  currState: Float32Array;
  sync?: (timestamp?: number) => void;
  getCurrCarStateView?: (carIndex: number) => GoalReplayCarStateViewLike | null | undefined;
}
export interface GoalReplayRuntimePort
  extends GoalReplayHudRuntimePort, ReplayEventDispatcherRuntimePort, ReplayCarEntryRuntimePort {
  physics?:
    | (ReplayFrameEnginePort &
        ReplayPhysicsEnginePort &
        NonNullable<ReplayCarEntryRuntimePort['physics']> & {
          setCarHitbox?: (carIndex: number, hitboxId: string) => void;
        })
    | null;
  interpolator?: GoalReplayInterpolatorPort | null;
  camera?: GoalReplayCameraPort | null;
  arena?:
    | (NonNullable<ReplayCarEntryRuntimePort['arena']> & {
        playerCarIndex?: number;
        isGoalReplayActive?: boolean;
        cars?: Array<{ visible?: boolean } | null | undefined>;
        setCarLoadout?: (carIndex: number, loadout: Record<string, unknown>) => void;
        resetBallTrail?: () => void;
      })
    | null;
  ballTrajectoryPredictor?: {
    clear?: () => void;
    acquireTemporarySuppression?: (source?: string) => void;
    releaseTemporarySuppression?: (source?: string | null) => void;
    setSceneContext?: (ctx: { isGoalReplayActive?: boolean }) => void;
  } | null;
  match?: {
    state?: { phase?: string; scorer?: number | null; scorerCarIndex?: number | null } | null;
  } | null;
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
    _lastTrailWarmupCursor?: number;
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
  scenePort: GoalReplayRuntimePort | null | undefined,
  cameraMode: GoalReplayCameraMode = 'director',
  source = 'goal-replay'
): void {
  if (!scenePort) return;
  if (cameraMode === 'director') scenePort.acquireGoalReplayCameraOverride?.(source);
  else scenePort.releaseGoalReplayCameraOverride?.(source);
}
export function bindGoalReplayHudCallbacks(options: GoalReplayHudSessionOptions): void {
  const { runtime: scenePort, replayController } = options;
  if (!replayController) return;
  const source = options.source || 'goal-replay';
  const refreshDirectorCamera = (scoringTeam: number, scorerCarIndex: number): void => {
    applyDirectorReplayCamera(
      scenePort?.camera,
      scenePort?.interpolator as DirectorInterpolatorSnapshot | null | undefined,
      replayController.progress,
      scoringTeam,
      0.016,
      scorerCarIndex,
      replayController.directorCameraState
    );
  };
  const selectCameraMode = (
    nextMode: GoalReplayCameraMode,
    povCarIdx: number | null,
    scoringTeam: number,
    scorerCarIndex: number
  ): void => {
    applyGoalReplayCameraModeSelection(scenePort, nextMode, source);
    if (nextMode === 'director' || typeof povCarIdx !== 'number' || povCarIdx < 0) {
      if (scenePort) scenePort.replayPovCarIndex = null;
      if (replayController.directorCameraState)
        replayController.directorCameraState.initialized = false;
      refreshDirectorCamera(scoringTeam, scorerCarIndex);
    } else {
      if (scenePort) scenePort.replayPovCarIndex = povCarIdx;
      if (options.onApplyPovCarIndex) {
        options.onApplyPovCarIndex(povCarIdx);
      } else if (scenePort) {
        scenePort.playerCarIndex = povCarIdx;
        if (scenePort.arena) scenePort.arena.playerCarIndex = povCarIdx;
        scenePort.camera?.setFocusedCarIndex?.(povCarIdx);
      }
      scenePort?.camera?.resetView?.();
    }
  };
  bindGoalReplayHudStateAndCallbacks(options, {
    refreshDirectorCamera,
    selectCameraMode,
  });
}
export function beginGoalReplaySession(
  scenePort: GoalReplayRuntimePort | null | undefined,
  replayController: GoalReplayTimelineControllerPort | null | undefined,
  options: GoalReplayHudSessionOptions = {}
): void {
  const cameraMode = options.cameraMode || 'director',
    source = options.source || 'goal-replay';
  const scoringTeam =
    options.scoringTeam ?? options.scorerTeam ?? replayController?.sessionState?.scoringTeam ?? 0;
  const scorerCarIndex =
    options.scorerCarIndex ?? replayController?.sessionState?.scorerCarIndex ?? 0;
  scenePort?.ballTrajectoryPredictor?.acquireTemporarySuppression?.(source);
  scenePort?.arena?.resetBallTrail?.();
  applyGoalReplayCameraModeSelection(scenePort, cameraMode, source);
  if (options.initialSnapshot && scenePort?.physics) {
    applyReplayFrameToEngine(
      scenePort.physics,
      options.initialSnapshot,
      scenePort.interpolator ?? null,
      options.initialSnapshot,
      1.0
    );
    if (cameraMode === 'director') {
      applyDirectorReplayCamera(
        scenePort.camera,
        scenePort.interpolator,
        replayController?.progress ?? 0,
        scoringTeam,
        0.016,
        scorerCarIndex,
        replayController?.directorCameraState
      );
    }
  }
  if (options.syncHud !== false)
    bindGoalReplayHudCallbacks({ ...options, runtime: scenePort, replayController });
}
export function stepGoalReplaySessionFrame(
  options: GoalReplayFrameStepOptions
): ReplayPlaybackStepResult {
  const { runtime: scenePort, replayController, context } = options;
  if (!replayController) {
    return {
      frame: null,
      progress: 0,
      frameIndex: 0,
      totalFrames: 0,
      isFinished: false,
      incidents: [],
      audioEvents: [],
    };
  }
  const dt = options.dt ?? context?.dt ?? 0.016,
    source = options.source || 'goal-replay';
  const cameraMode: GoalReplayCameraMode = options.cameraMode || 'director';
  const s = replayController.sessionState;
  const scoringTeam = options.scoringTeam ?? s?.scoringTeam ?? 0;
  const scorerCarIndex = options.scorerCarIndex ?? s?.scorerCarIndex ?? 0;
  const povCarIdx =
    typeof options.povCarIndex === 'number' && options.povCarIndex >= 0
      ? options.povCarIndex
      : scorerCarIndex;
  scenePort?.ballTrajectoryPredictor?.acquireTemporarySuppression?.(source);
  const prevFrameIdx = replayController.currentFrameIndex;
  const stepRes = replayController.stepPlayback(
    dt,
    scenePort?.interpolator ?? null,
    options.applyToEngine ?? true
  );
  if (prevFrameIdx > 0 && replayController.currentFrameIndex === 0)
    scenePort?.arena?.resetBallTrail?.();
  const postState = replayController.sessionState ?? s;
  const curFloat = postState?.cursorFloat ?? stepRes.frameIndex;
  if (postState?.isPaused || postState?.isScrubbing) {
    if (
      typeof replayController.getFrameBufferByIndex === 'function' &&
      postState._lastTrailWarmupCursor !== curFloat
    ) {
      postState._lastTrailWarmupCursor = curFloat;
      warmupArenaTrailsFromReplayWindow(
        scenePort?.arena,
        (idx) => replayController.getFrameBufferByIndex?.(idx) ?? null,
        curFloat
      );
    }
  } else if (postState) {
    postState._lastTrailWarmupCursor = -1;
  }
  if (options.networkStreamSnapshot && scenePort?.physics) {
    applyReplayFrameToEngine(
      scenePort.physics,
      options.networkStreamSnapshot,
      scenePort.interpolator ?? null
    );
  }
  if (options.dispatchEvents !== false) {
    dispatchReplayFrameEvents(
      stepRes as unknown as ReplayStepEventsPayload,
      scenePort ?? null,
      options.eventDispatchOptions
    );
  }
  const effectiveProgress =
    typeof options.overrideProgress === 'number'
      ? options.overrideProgress
      : options.resolveEffectiveProgress
        ? options.resolveEffectiveProgress(stepRes)
        : stepRes.progress;
  applyGoalReplayCameraModeSelection(scenePort, cameraMode, source);
  if (cameraMode === 'director') {
    applyDirectorReplayCamera(
      scenePort?.camera,
      scenePort?.interpolator,
      effectiveProgress,
      scoringTeam,
      dt,
      scorerCarIndex,
      replayController.directorCameraState
    );
  } else if (scenePort && typeof options.povCarIndex === 'number' && options.povCarIndex >= 0) {
    scenePort.replayPovCarIndex = povCarIdx;
    scenePort.playerCarIndex = povCarIdx;
    if (scenePort.arena) scenePort.arena.playerCarIndex = povCarIdx;
  }
  options.onStepAfterEvents?.(stepRes, povCarIdx);
  if (options.syncActiveCarContext !== false && context) {
    const activeReplayCarView = scenePort?.interpolator?.getCurrCarStateView?.(povCarIdx);
    const activeCarMesh = scenePort?.arena?.cars?.[povCarIdx];
    const evalCar = evaluateGoalReplayCarContext(activeReplayCarView, activeCarMesh, povCarIdx);
    context.activeCar = evalCar.activeCar;
    context.activeCarMesh = evalCar.activeCarMesh;
    context.playerCarView = evalCar.playerCarView ?? null;
    context.isSupersonic = evalCar.isSupersonic;
    context.curBoost = evalCar.curBoost;
    if (activeReplayCarView) {
      if (options.syncPlayerThrottleFromCarView ?? options.syncCarAudioControls ?? false) {
        applyGoalReplayCarAudioControls(scenePort, evalCar);
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
  scenePort: GoalReplayRuntimePort | null | undefined,
  replayController: GoalReplayTimelineControllerPort | null | undefined,
  options: EndGoalReplaySessionOptions = {}
): void {
  const source = options.source || null;
  replayController?.endReplaySession?.();
  if (scenePort) {
    scenePort.releaseGoalReplayCameraOverride?.(source);
    scenePort.ballTrajectoryPredictor?.releaseTemporarySuppression?.(source);
    scenePort.ballTrajectoryPredictor?.setSceneContext?.({ isGoalReplayActive: false });
    if (scenePort.arena) {
      scenePort.arena.isGoalReplayActive = false;
      scenePort.arena.resetBallTrail?.();
    }
    scenePort.replayPovCarIndex = null;
    scenePort.camera?.up?.set?.(0, 1, 0);
    if (options.restoreLocalCarFocus) {
      const localCarIdx =
        typeof scenePort.networkReconciler?.localCarIndex === 'number' &&
        scenePort.networkReconciler.localCarIndex >= 0
          ? scenePort.networkReconciler.localCarIndex
          : typeof scenePort.reconciler?.localCarIndex === 'number' &&
              scenePort.reconciler.localCarIndex >= 0
            ? scenePort.reconciler.localCarIndex
            : (options.fallbackLocalCarIndex ?? scenePort.playerCarIndex ?? 0);
      scenePort.playerCarIndex = localCarIdx;
      if (scenePort.arena) scenePort.arena.playerCarIndex = localCarIdx;
      scenePort.camera?.setFocusedCarIndex?.(localCarIdx);
      if (options.syncAfterEnd) {
        scenePort.camera?.resetView?.();
        scenePort.interpolator?.sync?.();
      }
    }
  }
  const hud = hudStore.getState();
  if (options.clearHud === true) {
    if (typeof hud.clearReplayState === 'function') {
      hud.clearReplayState();
    } else {
      hud.setReplayState?.({
        replayProgress: 0,
        replayFrameIndex: 0,
        replayPaused: false,
        replayPersistent: false,
        replayCameraMode: 'director',
        replayScorerName: null,
        replayScorerTeam: null,
        replayScorerAnthemId: null,
        replayBallSpeedKph: null,
        replayAssistName: null,
        onReplaySeekNormalized: null,
        onReplayTogglePause: null,
        onReplayCycleSpeed: null,
        onReplayToggleCameraMode: null,
        onReplaySelectPovCar: null,
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
