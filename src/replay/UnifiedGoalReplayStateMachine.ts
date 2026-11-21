/**
 * src/replay/UnifiedGoalReplayStateMachine.ts
 * Wave 1 (W1-03) Shared GoalReplay state machine & cinematic camera pose output
 * used by both Match and Exhibition (exp-multi-bots).
 */

import {
  SIM_OFFSETS,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
} from '../physics/RocketSimConstants.ts';
import { DEFAULT_REPLAY_DIRECTOR_FOV_DEG } from '../ui-core/config/replayDirectorConfig.ts';
import {
  interpolateReplaySnapshots,
  encodeReplayDirectorTelemetryIntoState,
} from './ReplayFrameInterpolator.ts';
import { computeGoalReplayCameraPose } from './ReplayDirectorCamera.ts';
import { ReplayDirectorCameraSubController } from './ReplayDirectorCameraSubController.ts';
import { analyzeReplayTouchTimeline } from './ReplayTouchTimelineAnalyzer.ts';
import {
  ensureSuffixCameraPlan,
  resolveTouchLookaheadForFrame,
  computeDramaticSlowMoFactor,
} from './replayTouchLookaheadPipeline.ts';
import {
  createInitialReplaySessionState,
  type ReplaySessionState,
  type ReplayTimelineFrameEntry,
} from './replayDirectorStateTypes.ts';

export type GoalReplayPhase = 'idle' | 'active' | 'finished';
export type UnifiedGoalReplayCameraMode = 'director' | 'pov';

export interface GoalReplayCameraPoseOutput {
  mode: UnifiedGoalReplayCameraMode;
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovDeg: number;
  focusedCarIndex: number;
}

export interface GoalReplayStreamFrameOutput {
  phase: GoalReplayPhase;
  playbackState: 'playing' | 'paused';
  frameIndex: number;
  totalFrames: number;
  progress: number;
  slowMoFactor: number;
  scoringTeam: 0 | 1;
  scorerCarIndex: number;
  scorerName: string | null;
  assistName: string | null;
  ballSpeedKph: number | null;
  cameraPose: GoalReplayCameraPoseOutput;
  snapshot: Float32Array | null;
}

export interface BeginUnifiedGoalReplayParams {
  frames: ReplayTimelineFrameEntry[];
  scoringTeam: number;
  scorerCarIndex: number;
  scorerName?: string | null;
  assistName?: string | null;
  ballSpeedKph?: number | null;
  carTeamResolver?: (carIndex: number) => number;
  enableDramaticSlowMo?: boolean;
  cameraMode?: UnifiedGoalReplayCameraMode;
  povCarIndex?: number;
}

function computePovCameraPoseFromSnapshot(
  snap: ArrayLike<number> | null | undefined,
  carIndex: number
): GoalReplayCameraPoseOutput {
  const numCars = snap && snap.length > SIM_OFFSETS.NUM_CARS ? Math.floor(Number(snap[SIM_OFFSETS.NUM_CARS]) || 0) : 0;
  const clampedIdx = numCars > 0 ? Math.max(0, Math.min(numCars - 1, Math.round(carIndex))) : 0;
  const base = SIM_OFFSETS.CARS + clampedIdx * CAR_STATE_STRIDE;

  if (!snap || snap.length < base + CAR_STATE_STRIDE) {
    return {
      mode: 'pov',
      eye: [0, -300, 120],
      target: [0, 0, 90],
      up: [0, 0, 1],
      fovDeg: 110,
      focusedCarIndex: clampedIdx,
    };
  }

  const cx = Number(snap[base + CAR_STATE_OFFSETS.POS + 0]) || 0;
  const cy = Number(snap[base + CAR_STATE_OFFSETS.POS + 1]) || 0;
  const cz = Number(snap[base + CAR_STATE_OFFSETS.POS + 2]) || 0;
  const fx = Number(snap[base + CAR_STATE_OFFSETS.FWD + 0]) || 0;
  const fy = Number(snap[base + CAR_STATE_OFFSETS.FWD + 1]) || 1;
  const fz = Number(snap[base + CAR_STATE_OFFSETS.FWD + 2]) || 0;
  const fLen = Math.hypot(fx, fy, fz) || 1;
  const nfx = fx / fLen;
  const nfy = fy / fLen;
  const nfz = fz / fLen;

  const bx = Number(snap[SIM_OFFSETS.BALL + 0]) || 0;
  const by = Number(snap[SIM_OFFSETS.BALL + 1]) || 0;
  const bz = Number(snap[SIM_OFFSETS.BALL + 2]) || 93;

  return {
    mode: 'pov',
    eye: [cx - nfx * 280, cy - nfy * 280, cz - nfz * 280 + 110],
    target: [bx, by, bz],
    up: [0, 0, 1],
    fovDeg: 110,
    focusedCarIndex: clampedIdx,
  };
}

export class UnifiedGoalReplayStateMachine {
  public phase: GoalReplayPhase = 'idle';
  public cameraMode: UnifiedGoalReplayCameraMode = 'director';
  public povCarIndex = 0;
  public scorerName: string | null = null;
  public assistName: string | null = null;
  public ballSpeedKph: number | null = null;
  public enableDramaticSlowMo = true;

  public readonly directorCamera = new ReplayDirectorCameraSubController();
  public sessionState: ReplaySessionState = createInitialReplaySessionState();
  private interpolatedBuffer: Float32Array | null = null;
  private latestOutput: GoalReplayStreamFrameOutput | null = null;

  begin(params: BeginUnifiedGoalReplayParams): GoalReplayStreamFrameOutput | null {
    const { frames } = params;
    if (!Array.isArray(frames) || frames.length === 0) {
      this.phase = 'idle';
      this.latestOutput = null;
      return null;
    }

    const scoringTeam: 0 | 1 = params.scoringTeam === 1 ? 1 : 0;
    const scorerCarIndex = Math.max(0, Math.round(params.scorerCarIndex || 0));
    const carTeamResolver = params.carTeamResolver ?? ((idx: number) => idx % 2);

    this.enableDramaticSlowMo = params.enableDramaticSlowMo !== false;
    this.cameraMode = params.cameraMode ?? 'director';
    this.povCarIndex =
      typeof params.povCarIndex === 'number' && params.povCarIndex >= 0
        ? Math.round(params.povCarIndex)
        : scorerCarIndex;
    this.scorerName = params.scorerName ?? null;
    this.assistName = params.assistName ?? null;
    this.ballSpeedKph = typeof params.ballSpeedKph === 'number' ? params.ballSpeedKph : null;

    const prevSeq = this.sessionState.retainedReplaySeq;
    this.sessionState = {
      ...createInitialReplaySessionState(),
      activeFrames: frames,
      expectedDurationTicks: frames.length,
      scoringTeam,
      scorerCarIndex,
      carTeamResolver,
      hasRetainedReplay: true,
      retainedReplaySeq: prevSeq + 1,
      isActive: true,
      cursorFloat: 0,
      playbackSpeed: 1.0,
    };

    this.directorCamera.reset(false, false, false);
    this.directorCamera.onTimelineAnalyzed(
      analyzeReplayTouchTimeline(frames, {
        scoringTeam,
        isNetworkStreamed: false,
        watchAllTouches: false,
        carTeamResolver,
        scorerCarIndex,
      })
    );

    const d = this.directorCamera.state;
    const plan = ensureSuffixCameraPlan(frames, {
      isNetworkStreamed: false,
      streamedFramesReceived: 0,
      expectedDurationTicks: frames.length,
      cachedPlan: null,
      scoringTeam,
      scorerCarIndex: d.scorerCarIndex ?? scorerCarIndex,
      goalLineFrameIdx: d.goalLineFrameIdx ?? -1,
      touchEvents: d.touchEvents || [],
      carTeamResolver,
      lateralBias: d.lateralBias,
      initialSettledCarPos: d.initialSettledCarPos,
    });
    this.sessionState.cachedSuffixCameraPlan = plan;
    this.directorCamera.setSuffixCameraPlan(plan);

    this.phase = 'active';
    const firstSnap = frames[0]?.snapshot ?? null;
    const cameraPose = this.buildCameraPose(firstSnap, firstSnap, 0, 1.0, 0, 0.016);
    this.latestOutput = {
      phase: 'active',
      playbackState: 'playing',
      frameIndex: 0,
      totalFrames: frames.length,
      progress: 0,
      slowMoFactor: 1.0,
      scoringTeam,
      scorerCarIndex,
      scorerName: this.scorerName,
      assistName: this.assistName,
      ballSpeedKph: this.ballSpeedKph,
      cameraPose,
      snapshot: firstSnap,
    };
    return this.latestOutput;
  }

  setCameraMode(mode: UnifiedGoalReplayCameraMode, povCarIndex?: number): void {
    this.cameraMode = mode;
    if (typeof povCarIndex === 'number' && povCarIndex >= 0) {
      this.povCarIndex = Math.round(povCarIndex);
    }
  }

  setPaused(paused: boolean): void {
    this.sessionState.isPaused = Boolean(paused);
    if (this.latestOutput) {
      this.latestOutput = {
        ...this.latestOutput,
        playbackState: this.sessionState.isPaused ? 'paused' : 'playing',
      };
    }
  }

  step(dt = 1 / 120): GoalReplayStreamFrameOutput | null {
    const s = this.sessionState;
    const frames = s.activeFrames;
    if (this.phase !== 'active' || !s.isActive || frames.length === 0) {
      return this.latestOutput;
    }

    const total = frames.length;
    const d = this.directorCamera.state;
    const slowMo = this.enableDramaticSlowMo
      ? computeDramaticSlowMoFactor(
          {
            disableSlowMo: s.disableSlowMo,
            playbackSpeed: s.playbackSpeed,
            isScrubbing: s.isScrubbing,
            lastScoringTouchFrameIdx: d.lastScoringTouchFrameIdx ?? -1,
            goalLineFrameIdx: d.goalLineFrameIdx ?? -1,
          },
          s.cursorFloat
        )
      : 1.0;

    if (!s.isPaused) {
      const stepScale = dt > 0 ? dt * 120 : 1.0;
      s.cursorFloat = Math.min(
        total - 1,
        s.cursorFloat + Math.max(0, s.playbackSpeed * slowMo * stepScale)
      );
    }

    const baseIdx = Math.max(0, Math.min(total - 1, Math.floor(s.cursorFloat)));
    const nextIdx = Math.min(total - 1, baseIdx + 1);
    const alpha = Math.max(0, Math.min(1, s.cursorFloat - baseIdx));
    const progress = total > 1 ? s.cursorFloat / (total - 1) : 1;

    const prevEntry = frames[baseIdx] ?? null;
    const nextEntry = frames[nextIdx] ?? prevEntry;
    const prevSnap = prevEntry?.snapshot ?? null;
    const currSnap = nextEntry?.snapshot ?? prevSnap;

    const suffixPlan = ensureSuffixCameraPlan(frames, {
      isNetworkStreamed: false,
      streamedFramesReceived: 0,
      expectedDurationTicks: s.expectedDurationTicks,
      cachedPlan: s.cachedSuffixCameraPlan,
      scoringTeam: s.scoringTeam,
      scorerCarIndex: d.scorerCarIndex ?? s.scorerCarIndex ?? 0,
      goalLineFrameIdx: d.goalLineFrameIdx ?? -1,
      touchEvents: d.touchEvents || [],
      carTeamResolver: s.carTeamResolver,
      lateralBias: d.lateralBias,
      initialSettledCarPos: d.initialSettledCarPos,
    });
    s.cachedSuffixCameraPlan = suffixPlan;
    this.directorCamera.setSuffixCameraPlan(suffixPlan);

    const { resolvedScorerCarIndex } = this.directorCamera.syncForPlaybackStep({
      baseIdx,
      nextIdx,
      alpha,
      useCsvPose: false,
      cursorFloat: s.cursorFloat,
      isPaused: s.isPaused,
      isScrubbing: s.isScrubbing,
      prevEntry,
      nextEntry,
      currFrame: currSnap,
      suffixPlan,
      scorerCarIndex: s.scorerCarIndex,
      resolveTouchLookaheadForFrame: (idx, fb) =>
        resolveTouchLookaheadForFrame(
          {
            suffixPlan,
            goalLineFrameIdx: d.goalLineFrameIdx ?? -1,
            scorerCarIndex: d.scorerCarIndex ?? s.scorerCarIndex ?? 0,
            touchEvents: d.touchEvents || [],
            reboundEvents: d.reboundEvents || [],
            scoringTeam: s.scoringTeam,
            watchAllTouches: false,
          },
          idx,
          fb
        ),
    });
    s.scorerCarIndex = resolvedScorerCarIndex;

    let blendedSnap: Float32Array | null = null;
    if (currSnap) {
      blendedSnap = interpolateReplaySnapshots(
        prevSnap || currSnap,
        currSnap,
        alpha,
        this.interpolatedBuffer ?? undefined
      );
      this.interpolatedBuffer = blendedSnap;
      encodeReplayDirectorTelemetryIntoState(blendedSnap, d, progress);
    }

    const cameraPose = this.buildCameraPose(
      blendedSnap ?? currSnap,
      prevSnap,
      alpha,
      progress,
      baseIdx,
      dt
    );

    const isFinished = s.cursorFloat >= total - 1 && !s.isPaused;
    if (isFinished) {
      s.isActive = false;
      this.phase = 'finished';
    }

    this.latestOutput = {
      phase: this.phase,
      playbackState: s.isPaused ? 'paused' : 'playing',
      frameIndex: baseIdx,
      totalFrames: total,
      progress,
      slowMoFactor: slowMo,
      scoringTeam: s.scoringTeam === 1 ? 1 : 0,
      scorerCarIndex: s.scorerCarIndex,
      scorerName: this.scorerName,
      assistName: this.assistName,
      ballSpeedKph: this.ballSpeedKph,
      cameraPose,
      snapshot: blendedSnap,
    };
    return this.latestOutput;
  }

  end(): void {
    this.sessionState.isActive = false;
    this.phase = 'idle';
    if (this.latestOutput) {
      this.latestOutput = {
        ...this.latestOutput,
        phase: 'idle',
      };
    }
  }

  getLatestOutput(): GoalReplayStreamFrameOutput | null {
    return this.latestOutput;
  }

  private buildCameraPose(
    currSnap: Float32Array | null,
    prevSnap: Float32Array | null,
    alpha: number,
    progress: number,
    frameIndex: number,
    dt: number
  ): GoalReplayCameraPoseOutput {
    if (this.cameraMode === 'pov') {
      return computePovCameraPoseFromSnapshot(currSnap, this.povCarIndex);
    }
    const pose = computeGoalReplayCameraPose(currSnap, this.sessionState.scoringTeam, {
      prevStateBuffer: prevSnap,
      alpha,
      directorState: this.directorCamera.state,
      suffixCameraPlan: this.sessionState.cachedSuffixCameraPlan,
      frameIndex,
      progress,
      dt,
      scorerCarIndex: this.sessionState.scorerCarIndex,
    });
    return {
      mode: 'director',
      eye: [pose.eyeX, pose.eyeY, pose.eyeZ],
      target: [pose.targetX, pose.targetY, pose.targetZ],
      up: [0, 0, 1],
      fovDeg: DEFAULT_REPLAY_DIRECTOR_FOV_DEG,
      focusedCarIndex: this.sessionState.scorerCarIndex,
    };
  }
}
