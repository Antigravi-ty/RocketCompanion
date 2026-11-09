import { hudStore } from '../../runtimeUiPort.ts';
import {
  applyReplayFrameToEngine,
  type ReplayFrameEnginePort,
  type ReplayFrameInterpolatorStatePort,
} from '../../../replay/ReplayFrameInterpolator.ts';
import {
  applyDirectorReplayCamera,
  type DirectorCameraTargetPort,
  type DirectorInterpolatorSnapshot,
} from '../../../replay/ReplayDirectorCamera.ts';
import type { ReplayInterpolatorPort } from '../../../replay/ReplayDirectorStatePipeline.ts';
import type { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import {
  warmupArenaTrailsFromReplayWindow,
  type ReplayTrailWarmupArenaPort,
} from '../../../entities/vehicle/supersonic-trail/SupersonicWheelTrailReplaySync.ts';

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
  cursorFloat?: number;
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
  getFrameBufferByIndex?: (index: number) => Float32Array | null;
  seekToNormalized: (norm: number, interpolator?: ReplayInterpolatorPort | null) => unknown;
  togglePause: () => boolean;
  cyclePlaybackSpeed: () => number;
}

export interface GoalReplayHudRuntimePort {
  interpolator?: ReplayInterpolatorPort | null;
  playerThrottle?: number;
  playerControls?: object | null;
  neutralControls?: object | null;
  arena?: (ReplayTrailWarmupArenaPort & { resetBallTrail?: () => void }) | null;
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
  refreshDirectorCamera(scoringTeam: number, scorerCarIndex: number): void;
  selectCameraMode(
    nextMode: GoalReplayCameraMode,
    povCarIdx: number | null,
    scoringTeam: number,
    scorerCarIndex: number
  ): void;
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
  v: GoalReplayCarStateViewLike | null | undefined,
  activeCarMesh: unknown,
  povCarIdx: number
): GoalReplayCarViewEvaluation {
  const isSupersonic = Boolean(v?.isSupersonic && !v?.isDemoed);
  const curBoost = v?.boost ?? 0;
  let playerThrottle = 0,
    jump = false,
    boost = false;
  if (v) {
    const fwdSpeed =
      (v.velX ?? 0) * (v.fwdX ?? 0) + (v.velY ?? 0) * (v.fwdY ?? 0) + (v.velZ ?? 0) * (v.fwdZ ?? 0);
    playerThrottle = Math.abs(fwdSpeed) > 25 ? (fwdSpeed > 0 ? 1 : -1) : 0;
    jump = Boolean(v.isJumping);
    boost = Boolean(v.isBoosting);
  }
  return {
    activeCar: povCarIdx,
    activeCarMesh,
    playerCarView: v,
    isSupersonic,
    curBoost,
    playerThrottle,
    jump,
    boost,
  };
}

export function applyGoalReplayCarAudioControls(
  audioTarget: GoalReplayHudRuntimePort | null | undefined,
  ev: GoalReplayCarViewEvaluation
): void {
  if (!audioTarget || !ev.playerCarView) return;
  audioTarget.playerThrottle = ev.playerThrottle;
  audioTarget.playerControls = {
    ...(audioTarget.neutralControls || {}),
    throttle: ev.playerThrottle,
    jump: ev.jump,
    boost: ev.boost,
  };
}

export function shouldEmitGoalReplayWillEndSignal(
  stepRes: { totalFrames?: number; frameIndex?: number },
  isPaused: boolean,
  isPersistent: boolean
): boolean {
  const total = stepRes.totalFrames || 0;
  return (
    !isPaused && !isPersistent && total > 0 && Math.max(0, total - (stepRes.frameIndex || 0)) <= 78
  );
}

export function bindGoalReplayHudStateAndCallbacks<
  TRuntime extends GoalReplayHudRuntimePort,
  TController extends GoalReplayHudControllerPort,
>(
  options: GoalReplayHudSessionOptions<TRuntime, TController>,
  cameraCallbacks: GoalReplayHudCameraCallbacks
): void {
  const { replayController, runtime: scenePort } = options;
  if (!replayController) return;
  const resolveScoringTeam = (): number =>
    options.getScoringTeam
      ? options.getScoringTeam()
      : (options.scoringTeam ??
        options.scorerTeam ??
        replayController.sessionState?.scoringTeam ??
        0);
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

  const handleSeekNormalized = (norm: number): void => {
    if (!replayController.sessionState?.isActive) return;
    replayController.sessionState.isPersistent = true;
    replayController.seekToNormalized(norm, scenePort?.interpolator);
    scenePort?.arena?.resetBallTrail?.();
    warmupArenaTrailsFromReplayWindow(
      scenePort?.arena,
      (idx) => replayController.getFrameBufferByIndex?.(idx) ?? null,
      replayController.sessionState?.cursorFloat ?? replayController.currentFrameIndex ?? 0
    );
    if (getCameraMode() === 'director') {
      cameraCallbacks.refreshDirectorCamera(resolveScoringTeam(), resolveScorerCarIndex());
    }
    hudStore.getState().setReplayState({
      replayProgress: replayController.progress,
      replayFrameIndex: replayController.currentFrameIndex,
      replayPaused: replayController.sessionState.isPaused,
      replayPersistent: true,
    });
  };

  const handleTogglePause = (): void => {
    if (!replayController.sessionState?.isActive) return;
    const paused = replayController.togglePause();
    hudStore.getState().setReplayState({
      replayPaused: paused,
      replayPersistent: replayController.sessionState.isPersistent,
    });
  };

  const handleCycleSpeed = (): void => {
    if (!replayController.sessionState?.isActive) return;
    hudStore.getState().setReplayState({ replaySpeed: replayController.cyclePlaybackSpeed() });
  };

  const handleSelectPovCar = (carIdx: number | null): void => {
    if (!replayController.sessionState?.isActive) return;
    const nextMode: GoalReplayCameraMode =
      typeof carIdx === 'number' && carIdx >= 0 ? 'pov' : 'director';
    const nextPov = nextMode === 'pov' ? carIdx : null;
    setCameraMode(nextMode);
    setPovCarIndex(nextPov);
    cameraCallbacks.selectCameraMode(
      nextMode,
      nextPov,
      resolveScoringTeam(),
      resolveScorerCarIndex()
    );
    hudStore.getState().setReplayState({ replayCameraMode: nextMode });
  };

  const handleToggleCameraMode = (): void => {
    if (!replayController.sessionState?.isActive) return;
    const nextMode: GoalReplayCameraMode = getCameraMode() === 'director' ? 'pov' : 'director';
    const nextPov = nextMode === 'director' ? null : getPovCarIndex();
    setCameraMode(nextMode);
    if (nextMode === 'pov') setPovCarIndex(nextPov);
    cameraCallbacks.selectCameraMode(
      nextMode,
      nextPov,
      resolveScoringTeam(),
      resolveScorerCarIndex()
    );
    hudStore.getState().setReplayState({ replayCameraMode: nextMode });
  };

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
    onReplaySeekNormalized: handleSeekNormalized,
    onReplayTogglePause: handleTogglePause,
    onReplayCycleSpeed: handleCycleSpeed,
    onReplaySelectPovCar: handleSelectPovCar,
    onReplayToggleCameraMode: handleToggleCameraMode,
  });
}

export function applyReplayControllerFrameAndDirectorCamera(
  scenePort:
    | {
        physics?: ReplayFrameEnginePort | null;
        interpolator?: (ReplayFrameInterpolatorStatePort & DirectorInterpolatorSnapshot) | null;
        camera?: DirectorCameraTargetPort | null;
        arena?: (ReplayTrailWarmupArenaPort & { resetBallTrail?: () => void }) | null;
      }
    | null
    | undefined,
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
  if (snap && scenePort?.physics) {
    applyReplayFrameToEngine(scenePort.physics, snap, scenePort.interpolator ?? null, snap, 1.0);
  }
  scenePort?.arena?.resetBallTrail?.();
  warmupArenaTrailsFromReplayWindow(
    scenePort?.arena,
    (idx) => replayController.getFrameBufferByIndex(idx),
    replayController.sessionState?.cursorFloat ?? replayController.currentFrameIndex
  );
  applyDirectorReplayCamera(
    scenePort?.camera,
    scenePort?.interpolator,
    options.progress ?? replayController.progress,
    scoringTeam,
    0.016,
    scorerCarIndex,
    replayController.directorCameraState
  );
}
