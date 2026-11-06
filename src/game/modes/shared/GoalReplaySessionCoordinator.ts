import { hudStore } from '../../runtimeUiPort.ts';
import {
  applyReplayFrameToEngine,
  decodeReplayDirectorTelemetryFromState,
} from '../../../replay/ReplayFrameInterpolator.ts';
import { applyDirectorReplayCamera } from '../../../replay/ReplayDirectorCamera.ts';
import { dispatchReplayFrameEvents } from '../../../replay/ReplayFrameEventDispatcher.ts';
import { captureRuntimeReplayCarEntries } from '../../../replay/replayDirectorCarRosterPipeline.ts';
import {
  applyGoalReplayCarAudioControls,
  bindGoalReplayHudStateAndCallbacks,
  evaluateGoalReplayCarContext,
  shouldEmitGoalReplayWillEndSignal,
  type GoalReplayCameraMode,
  type GoalReplayHudSessionOptions,
} from './goalReplayHudPipeline.ts';

export type { GoalReplayCameraMode, GoalReplayHudSessionOptions };

export interface GoalReplayFrameStepOptions {
  runtime?: any;
  replayController?: any;
  context?: any;
  source?: string;
  dt?: number;
  applyToEngine?: boolean;
  dispatchEvents?: boolean;
  eventDispatchOptions?: Record<string, unknown>;
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
  resolveEffectiveProgress?: (stepRes: any) => number;
  onStepAfterEvents?: (stepRes: any, povCarIdx: number) => void;
  onComplete?: (stepRes: any) => void;
}

export interface EndGoalReplaySessionOptions {
  source?: string | null;
  clearHud?: boolean;
  resetHudFlags?: boolean;
}

export function applyGoalReplayCameraModeSelection(
  runtime: any,
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
      runtime?.interpolator,
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
        if (runtime) {
          runtime.replayPovCarIndex = null;
        }
        if (replayController.directorCameraState) {
          replayController.directorCameraState.initialized = false;
        }
        refreshDirectorCamera(scoringTeam, scorerCarIndex);
      } else {
        if (runtime) {
          runtime.replayPovCarIndex = povCarIdx;
        }
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
  runtime: any,
  replayController: any,
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
      runtime.interpolator,
      options.initialSnapshot as any,
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

export function stepGoalReplaySessionFrame(options: GoalReplayFrameStepOptions): any {
  const { runtime, replayController, context } = options;
  if (!replayController) {
    return { progress: 0, frameIndex: 0, totalFrames: 0, isFinished: false };
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

  // Suppress Ball Trajectory Prediction across the entire Goal Replay session
  // regardless of whether cameraMode is 'director' or 'pov'.
  runtime?.ballTrajectoryPredictor?.acquireTemporarySuppression?.(source);

  const stepRes = replayController.stepPlayback(
    dt,
    runtime?.interpolator,
    options.applyToEngine ?? true
  );

  if (options.networkStreamSnapshot && runtime?.physics) {
    applyReplayFrameToEngine(
      runtime.physics,
      options.networkStreamSnapshot,
      runtime.interpolator
    );
  }

  if (options.dispatchEvents !== false) {
    dispatchReplayFrameEvents(stepRes, runtime, options.eventDispatchOptions as any);
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
    context.playerCarView = evalCar.playerCarView;
    context.isSupersonic = evalCar.isSupersonic;
    context.curBoost = evalCar.curBoost;

    if (activeReplayCarView) {
      const shouldSyncThrottle =
        options.syncPlayerThrottleFromCarView ?? options.syncCarAudioControls ?? false;
      if (shouldSyncThrottle) {
        applyGoalReplayCarAudioControls(runtime, evalCar);
      }
      if (options.syncBoostToHud !== false) {
        hudStore
          .getState()
          .setBoost(
            activeReplayCarView.boost,
            activeReplayCarView.isBoosting,
            Boolean(options.isUnlimitedBoost)
          );
      }
    }
  }

  const shouldEmitWillEnd = options.emitWillEndChoreography ?? options.emitWillEndSignal ?? true;
  if (
    shouldEmitWillEnd &&
    shouldEmitGoalReplayWillEndSignal(
      stepRes,
      Boolean(s?.isPaused),
      Boolean(s?.isPersistent)
    )
  ) {
    hudStore.getState().setChoreographySignal('goal-replay-will-end');
  }

  if (options.syncHudProgress !== false) {
    hudStore.getState().setReplayState({
      replayProgress: effectiveProgress,
      replayFrameIndex: stepRes.frameIndex,
      replayTotalFrames: stepRes.totalFrames,
      replayPaused: s?.isPaused,
      replayPersistent: s?.isPersistent,
      replayCameraMode: cameraMode,
      replaySpeed: s?.playbackSpeed,
    });
  }

  if (
    stepRes.isFinished &&
    !s?.isPaused &&
    !s?.isPersistent
  ) {
    options.onComplete?.(stepRes);
  }

  return stepRes;
}

export function endGoalReplaySession(
  runtime: any,
  replayController: any,
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

export function stepNetworkStreamedGoalReplayFrame(params: {
  runtime: any;
  replayController: any;
  context: any;
  source?: string;
  isUnlimitedBoost: boolean;
  getCameraMode: () => GoalReplayCameraMode;
  setCameraMode: (mode: GoalReplayCameraMode) => void;
  getScoringTeam: () => number;
  setScoringTeam?: (team: number) => void;
  getScorerCarIndex: () => number;
  setScorerCarIndex?: (carIndex: number) => void;
}): void {
  const {
    runtime: r,
    replayController,
    context,
    source = 'freeplay-goal-replay',
    isUnlimitedBoost,
    getCameraMode,
    setCameraMode,
    getScoringTeam,
    setScoringTeam,
    getScorerCarIndex,
    setScorerCarIndex,
  } = params;
  if (!replayController.sessionState?.isActive) {
    const scoringTeam = r?.match?.state?.scorer ?? 0;
    const scorerCarIndex = r?.match?.state?.scorerCarIndex ?? 0;
    const carEntries = captureRuntimeReplayCarEntries(r, {
      defaultTeam: scoringTeam,
    });
    const totalFrames = replayController.beginReplaySession({
      scoringTeam,
      scorerCarIndex,
      carEntries,
      isNetworkStreamed: true,
    });
    setScoringTeam?.(scoringTeam);
    setScorerCarIndex?.(scorerCarIndex);
    setCameraMode('director');
    beginGoalReplaySession(r, replayController, {
      cameraMode: 'director',
      source,
      syncHud: true,
      totalFrames,
      getCameraMode,
      setCameraMode,
      getScoringTeam,
      getScorerCarIndex,
      getPovCarIndex: () => r?.replayPovCarIndex ?? null,
      setPovCarIndex: (carIdx) => {
        if (r) r.replayPovCarIndex = carIdx;
      },
    });
  }
  if (typeof r?.replayPovCarIndex === 'number' && r.replayPovCarIndex >= 0) {
    setCameraMode('pov');
  } else if (
    r?.isGoalReplayCameraOverrideActive?.() &&
    getCameraMode() === 'pov' &&
    r.replayPovCarIndex === null
  ) {
    setCameraMode('director');
  }
  const cameraMode = getCameraMode() || 'director';
  const s = replayController.sessionState;
  const isCustomScrubbing = Boolean(
    s?.isScrubbing ||
      s?.isPaused ||
      Math.abs((s?.playbackSpeed ?? 1.0) - 1.0) > 0.01
  );
  const networkStreamSnapshot = !isCustomScrubbing
    ? (r?.networkReconciler?.lastParsedPacket?.stateSnapshot ?? null)
    : null;
  const embedded = networkStreamSnapshot
    ? decodeReplayDirectorTelemetryFromState(networkStreamSnapshot)
    : null;
  const scorerCarIdx = s?.scorerCarIndex ?? getScorerCarIndex();
  stepGoalReplaySessionFrame({
    runtime: r,
    replayController,
    context,
    dt: context?.dt ?? 1 / 120,
    source,
    cameraMode,
    scoringTeam: s?.scoringTeam ?? getScoringTeam(),
    scorerCarIndex: scorerCarIdx,
    povCarIndex:
      cameraMode === 'pov'
        ? (typeof r?.replayPovCarIndex === 'number' && r.replayPovCarIndex >= 0
            ? r.replayPovCarIndex
            : scorerCarIdx)
        : null,
    applyToEngine: isCustomScrubbing,
    dispatchEvents: false,
    syncCarAudioControls: true,
    syncBoostToHud: true,
    emitWillEndSignal: false,
    syncHudProgress: true,
    isUnlimitedBoost,
    networkStreamSnapshot,
    overrideProgress:
      embedded && typeof embedded.progress === 'number' ? embedded.progress : null,
  });
}
