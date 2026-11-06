import {
  getActiveReplayTimelineController,
  getLatestRetainedReplayTimelineController,
  hudStore,
  setNameTagRuntimeState,
  useAppStore,
} from '../../runtimeUiPort.ts';
import { SIM_OFFSETS, MAX_CARS } from '../../../physics/RocketSimConstants.ts';
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
import type { ReplayRingBuffer } from '../../../replay/ReplayRingBuffer.ts';
import type {
  ReplayInterpolatorPort,
  ReplayPhysicsEnginePort,
  ReplaySessionState,
} from '../../../replay/ReplayDirectorStatePipeline.ts';
import type { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import { DEFAULT_REPLAY_DIRECTOR_FOV_DEG } from '../../../ui-core/config/replayDirectorConfig.ts';

export type GoalReplayCameraMode = 'director' | 'pov';

export interface GoalReplayCarStateViewLike {
  velX?: number;
  velY?: number;
  velZ?: number;
  fwdX?: number;
  fwdY?: number;
  fwdZ?: number;
  boost: number;
  isBoosting: boolean | number;
  isJumping?: boolean | number;
  isSupersonic?: boolean | number;
  isDemoed?: boolean | number;
}

export interface GoalReplayHudSessionStateLike {
  isActive?: boolean;
  scoringTeam?: number;
  scorerCarIndex?: number;
  durationSeconds?: number;
  focalCarIndex?: number;
  isPaused?: boolean;
  isPersistent?: boolean;
  goalMarkerRatio?: number;
  playbackSpeed?: number;
}

export interface GoalReplayHudControllerPort {
  progress?: number;
  currentFrameIndex?: number;
  sessionState?: GoalReplayHudSessionStateLike | null;
  getTotalRecordedFrames?: () => number;
  seekToNormalized: (norm: number, interpolator?: ReplayInterpolatorPort | null) => unknown;
  togglePause: () => boolean;
  cyclePlaybackSpeed: () => number;
}

export interface GoalReplayHudRuntimePort {
  interpolator?: ReplayInterpolatorPort | null;
  playerThrottle?: number;
  playerControls?: object | null;
  neutralControls?: object | null;
}

export interface GoalReplayHudSessionOptions<
  TRuntime = GoalReplayHudRuntimePort,
  TController = GoalReplayHudControllerPort,
> {
  runtime?: TRuntime | null;
  replayController?: TController | null;
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
  playerCarView: GoalReplayCarStateViewLike | null | undefined;
  isSupersonic: boolean;
  curBoost: number;
  playerThrottle: number;
  jump: boolean;
  boost: boolean;
}

export function evaluateGoalReplayCarContext(
  activeReplayCarView: GoalReplayCarStateViewLike | null | undefined,
  activeCarMesh: unknown,
  povCarIdx: number
): GoalReplayCarViewEvaluation {
  const isSupersonic = Boolean(activeReplayCarView?.isSupersonic && !activeReplayCarView?.isDemoed);
  const curBoost = activeReplayCarView?.boost ?? 0;
  let playerThrottle = 0;
  let jump = false;
  let boost = false;
  if (activeReplayCarView) {
    const fwdSpeed =
      (activeReplayCarView.velX ?? 0) * (activeReplayCarView.fwdX ?? 0) +
      (activeReplayCarView.velY ?? 0) * (activeReplayCarView.fwdY ?? 0) +
      (activeReplayCarView.velZ ?? 0) * (activeReplayCarView.fwdZ ?? 0);
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
  runtime: GoalReplayHudRuntimePort | null | undefined,
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

export function bindGoalReplayHudStateAndCallbacks<
  TRuntime extends GoalReplayHudRuntimePort,
  TController extends GoalReplayHudControllerPort,
>(
  options: GoalReplayHudSessionOptions<TRuntime, TController>,
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
      ...(options.choreographySignal ? { choreographySignal: options.choreographySignal } : {}),
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
      const nextMode: GoalReplayCameraMode = typeof carIdx === 'number' && carIdx >= 0 ? 'pov' : 'director';
      const nextPov = nextMode === 'pov' ? carIdx : null;
      setCameraMode(nextMode);
      setPovCarIndex(nextPov);
      cameraCallbacks.onSelectCameraMode(nextMode, nextPov, resolveScoringTeam(), resolveScorerCarIndex());
      hudStore.getState().setReplayState({ replayCameraMode: nextMode });
    },
    onReplayToggleCameraMode: () => {
      if (!replayController.sessionState?.isActive) return;
      const nextMode: GoalReplayCameraMode = getCameraMode() === 'director' ? 'pov' : 'director';
      const nextPov = nextMode === 'director' ? null : getPovCarIndex();
      setCameraMode(nextMode);
      if (nextMode === 'pov') setPovCarIndex(nextPov);
      cameraCallbacks.onSelectCameraMode(nextMode, nextPov, resolveScoringTeam(), resolveScorerCarIndex());
      hudStore.getState().setReplayState({ replayCameraMode: nextMode });
    },
  });
}

export function syncAndAttachReplayTimelineController(
  replayController: ReplayTimelineController,
  engine: ReplayPhysicsEnginePort | null | undefined,
  ringBuffer: ReplayRingBuffer | null = null,
  copyRetainedFromActive = true
): number {
  if (engine && replayController.engine !== engine) {
    replayController.attach(engine, ringBuffer);
  }
  if (copyRetainedFromActive) {
    const sourceCtrl = getLatestRetainedReplayTimelineController() || getActiveReplayTimelineController();
    if (
      sourceCtrl &&
      sourceCtrl !== replayController &&
      sourceCtrl.ActiveWindowCount > 0 &&
      ((sourceCtrl.sessionState?.retainedReplaySeq || 0) > (replayController.sessionState.retainedReplaySeq || 0) ||
        replayController.ActiveWindowCount <= 0)
    ) {
      replayController.copyRetainedReplayFrom(sourceCtrl as unknown as ReplayTimelineController);
    }
  }
  return replayController.ActiveWindowCount;
}

export function applyReplayControllerFrameAndDirectorCamera(
  runtime: {
    physics?: ReplayFrameEnginePort | null;
    interpolator?: (ReplayFrameInterpolatorStatePort & DirectorInterpolatorSnapshot) | null;
    camera?: DirectorCameraTargetPort | null;
  } | null | undefined,
  replayController: ReplayTimelineController,
  scoringTeam: number,
  scorerCarIndex: number,
  options: { snapshot?: Float32Array | null; progress?: number; refreshDirectorPose?: boolean } = {}
): void {
  if (options.refreshDirectorPose) replayController.refreshCurrentFrameDirectorPose();
  const snap =
    options.snapshot !== undefined
      ? options.snapshot
      : replayController.getFrameBufferByIndex(replayController.currentFrameIndex);
  if (snap && runtime?.physics) {
    applyReplayFrameToEngine(runtime.physics, snap, runtime.interpolator ?? null, snap, 1.0);
  }
  applyDirectorReplayCamera(
    runtime?.camera,
    runtime?.interpolator,
    options.progress ?? replayController.progress,
    scoringTeam,
    0.016,
    scorerCarIndex,
    replayController.directorCameraState
  );
}

export function pauseReplayAndEnterReferenceFreeCam(
  runtime: {
    interpolator?: ReplayInterpolatorPort | null;
    camera?: {
      getDirectorFov?: () => number;
      getFreeCamFov?: () => number;
      setFreeCamFov?: (fov: number) => void;
      setFreeCamPose?: (eyeThreeJs: number[], targetThreeJs: number[]) => void;
    } | null;
  } | null | undefined,
  replayController: ReplayTimelineController,
  options: { seekCursorFloat?: number | null; fov?: number } = {}
): boolean {
  if (!runtime) return false;
  if (typeof options.seekCursorFloat === 'number') {
    replayController.seekToIndex(options.seekCursorFloat, runtime.interpolator ?? null);
  }
  replayController.setPaused(true);
  hudStore.getState().setReplayState({
    replayPaused: true,
    replayPersistent: true,
    replayProgress: replayController.progress,
    replayFrameIndex: replayController.currentFrameIndex,
  });
  const snap = replayController.getCurrentFrameDiagnosticSnapshot();
  const eyeThreeJs = snap?.cameraPose?.dampedEyeThreeJs || [0, 420, -3600];
  const targetThreeJs = snap?.cameraPose?.dampedTargetThreeJs || [0, 120, 0];
  const currentSharedFov =
    Number(runtime.camera?.getDirectorFov?.()) ||
    Number(runtime.camera?.getFreeCamFov?.()) ||
    Number(useAppStore.getState().freeCamFov) ||
    DEFAULT_REPLAY_DIRECTOR_FOV_DEG;
  const desiredFov = Number(options.fov) || currentSharedFov;
  runtime.camera?.setFreeCamFov?.(desiredFov);
  runtime.camera?.setFreeCamPose?.(eyeThreeJs, targetThreeJs);
  useAppStore.setState({ isFreeCam: true, freeCamFov: desiredFov });
  return true;
}
