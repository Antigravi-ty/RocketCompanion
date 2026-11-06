import { hudStore } from '../../runtimeUiPort.ts';

export type GoalReplayCameraMode = 'director' | 'pov';

export interface GoalReplayHudSessionOptions {
  runtime?: any;
  replayController?: any;
  source?: string;
  cameraMode?: GoalReplayCameraMode;
  totalFrames?: number;
  scoringTeam?: number;
  scorerCarIndex?: number;
  scorerName?: string | null;
  scorerTeam?: number | null;
  scorerAnthemId?: string | null;
  ballSpeedKph?: number | null;
  goalSpeedKph?: number | null;
  assistName?: string | null;
  skipTotal?: number;
  choreographySignal?: string | null;
  syncMatchPhase?: boolean;
  syncHud?: boolean;
  initialSnapshot?: Float32Array | null;
  getCameraMode?: () => GoalReplayCameraMode;
  setCameraMode?: (mode: GoalReplayCameraMode) => void;
  getScoringTeam?: () => number;
  getScorerCarIndex?: () => number;
  getPovCarIndex?: () => number | null;
  setPovCarIndex?: (carIdx: number | null) => void;
  onApplyPovCarIndex?: (carIdx: number) => void;
}

export interface GoalReplayHudCameraCallbacks {
  onRefreshDirectorCamera: (scoringTeam: number, scorerCarIndex: number) => void;
  onSelectCameraMode: (
    nextMode: GoalReplayCameraMode,
    povCarIdx: number | null,
    scoringTeam: number,
    scorerCarIndex: number
  ) => void;
}

export interface GoalReplayCarViewEvaluation {
  activeCar: number;
  activeCarMesh: unknown;
  playerCarView: any;
  isSupersonic: boolean;
  curBoost: number;
  playerThrottle: number;
  jump: boolean;
  boost: boolean;
}

export function evaluateGoalReplayCarContext(
  activeReplayCarView: any,
  activeCarMesh: unknown,
  povCarIdx: number
): GoalReplayCarViewEvaluation {
  const isSupersonic = Boolean(
    activeReplayCarView?.isSupersonic && !activeReplayCarView?.isDemoed
  );
  const curBoost = activeReplayCarView?.boost ?? 0;
  let playerThrottle = 0;
  let jump = false;
  let boost = false;

  if (activeReplayCarView) {
    const fwdSpeed =
      activeReplayCarView.velX * activeReplayCarView.fwdX +
      activeReplayCarView.velY * activeReplayCarView.fwdY +
      activeReplayCarView.velZ * activeReplayCarView.fwdZ;
    playerThrottle = Math.abs(fwdSpeed) > 25 ? (fwdSpeed > 0 ? 1 : -1) : 0;
    jump = Boolean(activeReplayCarView.isJumping);
    boost = Boolean(activeReplayCarView.isBoosting);
  }

  return {
    activeCar: povCarIdx,
    activeCarMesh,
    playerCarView: activeReplayCarView,
    isSupersonic,
    curBoost,
    playerThrottle,
    jump,
    boost,
  };
}

export function applyGoalReplayCarAudioControls(
  runtime: {
    playerThrottle?: number;
    playerControls?: Record<string, unknown>;
    neutralControls?: Record<string, unknown>;
  } | null | undefined,
  evaluation: GoalReplayCarViewEvaluation
): void {
  if (!runtime || !evaluation.playerCarView) return;
  runtime.playerThrottle = evaluation.playerThrottle;
  runtime.playerControls = {
    ...(runtime.neutralControls || {}),
    throttle: evaluation.playerThrottle,
    jump: evaluation.jump,
    boost: evaluation.boost,
  };
}

export function shouldEmitGoalReplayWillEndSignal(
  stepRes: { totalFrames?: number; frameIndex?: number },
  isPaused: boolean,
  isPersistent: boolean
): boolean {
  const totalFrames = stepRes.totalFrames || 0;
  const remainingFrames = Math.max(0, totalFrames - (stepRes.frameIndex || 0));
  return !isPaused && !isPersistent && totalFrames > 0 && remainingFrames <= 78;
}

export function bindGoalReplayHudStateAndCallbacks(
  options: GoalReplayHudSessionOptions,
  cameraCallbacks: GoalReplayHudCameraCallbacks
): void {
  const { replayController, runtime } = options;
  if (!replayController) return;

  const resolveScoringTeam = (): number =>
    options.getScoringTeam
      ? options.getScoringTeam()
      : (options.scoringTeam ?? options.scorerTeam ?? replayController.sessionState?.scoringTeam ?? 0);
  const resolveScorerCarIndex = (): number =>
    options.getScorerCarIndex
      ? options.getScorerCarIndex()
      : (options.scorerCarIndex ?? replayController.sessionState?.scorerCarIndex ?? 0);

  const scoringTeam = resolveScoringTeam();
  const scorerCarIndex = resolveScorerCarIndex();
  const scorerName = options.scorerName ?? null;
  const scorerAnthemId = options.scorerAnthemId ?? null;
  const ballSpeedKph = options.ballSpeedKph ?? options.goalSpeedKph ?? null;
  const assistName = options.assistName ?? null;
  const totalFrames = options.totalFrames ?? replayController.getTotalRecordedFrames?.() ?? 0;

  let internalCameraMode: GoalReplayCameraMode = options.cameraMode || 'director';
  let internalPovCarIndex: number | null = scorerCarIndex;

  const getCameraMode = (): GoalReplayCameraMode =>
    options.getCameraMode ? options.getCameraMode() : internalCameraMode;
  const setCameraMode = (nextMode: GoalReplayCameraMode): void => {
    internalCameraMode = nextMode;
    options.setCameraMode?.(nextMode);
  };
  const getPovCarIndex = (): number => {
    const val = options.getPovCarIndex ? options.getPovCarIndex() : internalPovCarIndex;
    return typeof val === 'number' && val >= 0 ? val : resolveScorerCarIndex();
  };
  const setPovCarIndex = (carIdx: number | null): void => {
    internalPovCarIndex = carIdx;
    options.setPovCarIndex?.(carIdx);
  };

  if (options.syncMatchPhase !== false) {
    hudStore.getState().setMatchState({
      matchPhase: 'replay',
      ...(options.choreographySignal
        ? { choreographySignal: options.choreographySignal as any }
        : {}),
      replayScorerName: scorerName,
      replayScorerTeam: scoringTeam,
      replayScorerAnthemId: scorerAnthemId,
      replayBallSpeedKph: ballSpeedKph,
      replayAssistName: assistName,
    });
  }

  hudStore.getState().setReplayState({
    isReplay: true,
    replayProgress: replayController.progress ?? 0,
    replayFrameIndex: replayController.currentFrameIndex ?? 0,
    replayTotalFrames: totalFrames,
    replayDuration: replayController.sessionState?.durationSeconds || 0,
    replayCurrentTime: 0,
    replayFocalSpeedKph: 0,
    replayFocalCarIndex: replayController.sessionState?.focalCarIndex ?? scorerCarIndex,
    replaySkipCount: 0,
    replaySkipTotal: options.skipTotal ?? 1,
    replayPaused: Boolean(replayController.sessionState?.isPaused),
    replayPersistent: Boolean(replayController.sessionState?.isPersistent),
    replayGoalMarkerRatio: replayController.sessionState?.goalMarkerRatio ?? 0.85,
    replayCameraMode: getCameraMode(),
    replaySpeed: replayController.sessionState?.playbackSpeed ?? 1.0,
    replayScorerName: scorerName,
    replayScorerTeam: scoringTeam,
    replayScorerAnthemId: scorerAnthemId,
    replayBallSpeedKph: ballSpeedKph,
    replayGoalSpeedKph: ballSpeedKph ?? 0,
    replayAssistName: assistName,
    onReplaySeekNormalized: (norm: number) => {
      if (!replayController.sessionState?.isActive) return;
      replayController.sessionState.isPersistent = true;
      replayController.seekToNormalized(norm, runtime?.interpolator);
      if (getCameraMode() === 'director') {
        cameraCallbacks.onRefreshDirectorCamera(resolveScoringTeam(), resolveScorerCarIndex());
      }
      hudStore.getState().setReplayState({
        replayProgress: replayController.progress,
        replayFrameIndex: replayController.currentFrameIndex,
        replayPaused: replayController.sessionState.isPaused,
        replayPersistent: true,
      });
    },
    onReplayTogglePause: () => {
      if (!replayController.sessionState?.isActive) return;
      const paused = replayController.togglePause();
      hudStore.getState().setReplayState({
        replayPaused: paused,
        replayPersistent: replayController.sessionState.isPersistent,
      });
    },
    onReplayCycleSpeed: () => {
      if (!replayController.sessionState?.isActive) return;
      const speed = replayController.cyclePlaybackSpeed();
      hudStore.getState().setReplayState({ replaySpeed: speed });
    },
    onReplaySelectPovCar: (carIdx: number | null) => {
      if (!replayController.sessionState?.isActive) return;
      if (typeof carIdx === 'number' && carIdx >= 0) {
        setCameraMode('pov');
        setPovCarIndex(carIdx);
        cameraCallbacks.onSelectCameraMode(
          'pov',
          carIdx,
          resolveScoringTeam(),
          resolveScorerCarIndex()
        );
        hudStore.getState().setReplayState({ replayCameraMode: 'pov' });
      } else {
        setCameraMode('director');
        setPovCarIndex(null);
        cameraCallbacks.onSelectCameraMode(
          'director',
          null,
          resolveScoringTeam(),
          resolveScorerCarIndex()
        );
        hudStore.getState().setReplayState({ replayCameraMode: 'director' });
      }
    },
    onReplayToggleCameraMode: () => {
      if (!replayController.sessionState?.isActive) return;
      const nextMode: GoalReplayCameraMode = getCameraMode() === 'director' ? 'pov' : 'director';
      setCameraMode(nextMode);
      if (nextMode === 'director') {
        cameraCallbacks.onSelectCameraMode(
          'director',
          null,
          resolveScoringTeam(),
          resolveScorerCarIndex()
        );
      } else {
        const targetIdx = getPovCarIndex();
        setPovCarIndex(targetIdx);
        cameraCallbacks.onSelectCameraMode(
          'pov',
          targetIdx,
          resolveScoringTeam(),
          resolveScorerCarIndex()
        );
      }
      hudStore.getState().setReplayState({ replayCameraMode: nextMode });
    },
  });
}
