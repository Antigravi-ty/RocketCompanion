/**
 * ReplayDirectorCameraSubController.ts
 * Stateful sub-controller for Goal Replay Director Camera pose and smoothing lifecycle.
 */

import { REPLAY_TICK_RATE } from './ReplayRingBuffer.ts';
import { computeGoalReplayCameraPose } from './ReplayDirectorCamera.ts';
import { decodeReplayDirectorTelemetryFromState } from './ReplayFrameInterpolator.ts';
import { resolveGoalExplosionFrameIndex, type SuffixDirectorTrajectoryPlan } from './ReplayDirectorTrajectoryPlanner.ts';
import type { ReplayTouchEvent } from './ReplayDirectorGazeSolver.ts';
import type { ReplayTouchAnalysisResult } from './ReplayTouchTimelineAnalyzer.ts';
import {
  createInitialDirectorCameraState,
  type DirectorCameraPose,
  type DirectorCameraState,
  type ImportedDiagnosticPatternInput,
  type RefreshDirectorPoseInput,
  type ReplaySessionInitOptions,
  type ReplayTimelineFrameEntry,
  type StepDirectorCameraSyncInput,
  type StepDirectorCameraSyncResult,
} from './replayDirectorStateTypes.ts';

export class ReplayDirectorCameraSubController {
  public state: DirectorCameraState;

  constructor(initialState?: DirectorCameraState) {
    this.state = initialState || createInitialDirectorCameraState();
  }

  reset(useRecordedCsvPose = false, isPaused = false, isScrubbing = false): void {
    const d = this.state;
    d.initialized = false;
    d.useRecordedCsvPose = useRecordedCsvPose;
    d.recordedPose = null;
    d.isPaused = isPaused;
    d.isScrubbing = isScrubbing;
  }

  resetSmoothing(): void {
    this.state.initialized = false;
  }

  setPauseAndScrubState(isPaused: boolean, isScrubbing: boolean): void {
    this.state.isPaused = isPaused;
    this.state.isScrubbing = isScrubbing;
  }

  setSuffixCameraPlan(plan: SuffixDirectorTrajectoryPlan | null): void {
    this.state.suffixCameraPlan = plan;
    if (plan && typeof plan.lateralBias === 'number') {
      this.state.lateralBias = plan.lateralBias;
    }
  }

  onTimelineAnalyzed(res: ReplayTouchAnalysisResult): void {
    const d = this.state;
    d.touchEvents = res.touchEvents;
    d.reboundEvents = res.reboundEvents;
    d.lastScoringTouchFrameIdx = res.lastScoringTouchFrameIdx;
    d.goalLineFrameIdx = res.goalLineFrameIdx;
    d.scorerCarIndex = res.resolvedScorerCarIndex;
    d.activeTouchCarIndex = res.openingCarIndex;
    d.nextTouchCarIndex = -1;
    d.nextTouchBlend = 0;
    d.nextTouchBallPos = null;
    d.interceptorCarIndex = -1;
    d.interceptorBlend = 0;
    d.plannedPose = null;
    d.lateralBias = res.resolvedLateralBias;
    d.hasResolvedInitialLateralBias = true;
    d.postGoalElapsedSec = 0;
    d.initialSettledCarPos = res.initialSettledCarPos;
  }

  applyPostAnalysisOverrides(options: ReplaySessionInitOptions = {}): void {
    if (Array.isArray(options.touchEvents) && options.touchEvents.length > 0) {
      this.state.touchEvents = options.touchEvents.map((t: ReplayTouchEvent) => ({ ...t }));
    }
    if (typeof options.goalLineFrameIdx === 'number' && options.goalLineFrameIdx >= 0) {
      this.state.goalLineFrameIdx = options.goalLineFrameIdx;
    }
    if (typeof options.lateralBias === 'number' && options.lateralBias !== 0) {
      this.state.lateralBias = options.lateralBias;
      this.state.hasResolvedInitialLateralBias = true;
    }
  }

  applyImportedPatternOverrides(
    parsedPattern: ImportedDiagnosticPatternInput,
    activeFrames: ReplayTimelineFrameEntry[],
    scoringTeam: number,
    currentGoalLineFrameIdx: number
  ): number {
    let resolvedGoalLineFrameIdx = currentGoalLineFrameIdx;
    if (Array.isArray(parsedPattern.touchEvents) && parsedPattern.touchEvents.length > 0) {
      this.state.touchEvents = parsedPattern.touchEvents.map((t: ReplayTouchEvent) => ({ ...t }));
    }
    if (typeof parsedPattern.lastScoringTouchFrameIdx === 'number' && parsedPattern.lastScoringTouchFrameIdx >= 0) {
      this.state.lastScoringTouchFrameIdx = parsedPattern.lastScoringTouchFrameIdx;
    }
    if (typeof parsedPattern.goalLineFrameIdx === 'number' && parsedPattern.goalLineFrameIdx >= 0) {
      resolvedGoalLineFrameIdx = resolveGoalExplosionFrameIndex(
        activeFrames,
        (scoringTeam ?? 0) === 0 ? 1.0 : -1.0,
        parsedPattern.goalLineFrameIdx
      );
      this.state.goalLineFrameIdx = resolvedGoalLineFrameIdx;
    }
    if (parsedPattern.initialSettledCarPos && typeof parsedPattern.initialSettledCarPos === 'object') {
      this.state.initialSettledCarPos = { ...parsedPattern.initialSettledCarPos };
    }
    if (typeof parsedPattern.lateralBias === 'number' && parsedPattern.lateralBias !== 0) {
      this.state.lateralBias = parsedPattern.lateralBias;
      this.state.hasResolvedInitialLateralBias = true;
    }
    return resolvedGoalLineFrameIdx;
  }

  preserveSmoothingAround(runTouchAnalysis: () => void): void {
    const d = this.state;
    const {
      initialized, eyeX, eyeY, eyeZ, targetX, targetY, targetZ,
      smoothedCarX, smoothedCarY, smoothedCarZ, carSwitchBlend,
      smoothedUgX, smoothedUgY, smoothedLateralBias,
    } = d;
    runTouchAnalysis();
    d.initialized = initialized;
    d.eyeX = eyeX; d.eyeY = eyeY; d.eyeZ = eyeZ;
    d.targetX = targetX; d.targetY = targetY; d.targetZ = targetZ;
    if (typeof smoothedCarX === 'number') {
      d.smoothedCarX = smoothedCarX;
      d.smoothedCarY = smoothedCarY;
      d.smoothedCarZ = smoothedCarZ;
      d.carSwitchBlend = carSwitchBlend;
    }
    if (typeof smoothedUgX === 'number') {
      d.smoothedUgX = smoothedUgX;
      d.smoothedUgY = smoothedUgY;
    }
    if (typeof smoothedLateralBias === 'number') {
      d.smoothedLateralBias = smoothedLateralBias;
    }
  }

  applyStreamedTelemetry(
    snap: Float32Array,
    isFollowingLiveStream: boolean,
    currentScorerCarIndex: number
  ): number {
    const d = this.state;
    let resolvedScorer = currentScorerCarIndex;
    const em = decodeReplayDirectorTelemetryFromState(snap);
    if (em) {
      if (typeof em.lateralBias === 'number' && em.lateralBias !== 0) {
        d.lateralBias = em.lateralBias;
        d.hasResolvedInitialLateralBias = true;
      }
      if (typeof em.scorerCarIndex === 'number' && em.scorerCarIndex >= 0) {
        d.scorerCarIndex = em.scorerCarIndex;
        resolvedScorer = em.scorerCarIndex;
      }
      if (isFollowingLiveStream) {
        d.activeTouchCarIndex = em.activeTouchCarIndex;
        d.nextTouchCarIndex = em.nextTouchCarIndex;
        d.nextTouchBlend = em.nextTouchBlend;
        d.nextTouchBallPos = em.nextTouchBallPos;
        d.interceptorCarIndex = em.interceptorCarIndex ?? -1;
        d.interceptorBlend = em.interceptorBlend ?? 0;
        d.postGoalElapsedSec = em.postGoalElapsedSec ?? 0;
        if (em.plannedPose) d.plannedPose = em.plannedPose;
      }
    }
    if ((d.postGoalElapsedSec ?? 0) <= 0) d.goalAnchorEyeY = undefined;
    return resolvedScorer;
  }

  refreshPoseAtCursor(input: RefreshDirectorPoseInput): DirectorCameraPose | null {
    const {
      totalFrames: total, cursorFloat, isPaused, isScrubbing, isImportedPreview,
      useRecordedCsvCamera, scoringTeam, scorerCarIndex,
      getFrameEntryByIndex, getFrameBufferByIndex, ensureSuffixCameraPlan, resolveTouchLookaheadForFrame,
    } = input;
    const d = this.state;
    if (total <= 0 || !d) return null;
    const targetIdx = Math.max(0, Math.min(total - 1, Math.floor(cursorFloat)));
    const entry = getFrameEntryByIndex(targetIdx);
    const useCsvPose = Boolean(isImportedPreview && useRecordedCsvCamera && entry?.recordedCsvRow);
    d.useRecordedCsvPose = useCsvPose;
    d.isPaused = isPaused;
    d.isScrubbing = isScrubbing;

    if (useCsvPose && entry?.recordedCsvRow) {
      const r = entry.recordedCsvRow;
      const recordedPose: DirectorCameraPose = {
        eyeX: r.cam_eye_x ?? 0, eyeY: r.cam_eye_y ?? 0, eyeZ: r.cam_eye_z ?? 0,
        targetX: r.cam_target_x ?? 0, targetY: r.cam_target_y ?? 0, targetZ: r.cam_target_z ?? 0,
      };
      d.recordedPose = recordedPose;
      d.eyeX = recordedPose.eyeX; d.eyeY = recordedPose.eyeY; d.eyeZ = recordedPose.eyeZ;
      d.targetX = recordedPose.targetX; d.targetY = recordedPose.targetY; d.targetZ = recordedPose.targetZ;
      d.initialized = true;
      return recordedPose;
    }

    d.recordedPose = null;
    const suffixPlan = ensureSuffixCameraPlan();
    if (suffixPlan && Array.isArray(suffixPlan.poses) && suffixPlan.poses.length > 0) {
      const s = getFrameBufferByIndex(targetIdx);
      const nextS = getFrameBufferByIndex(Math.min(total - 1, targetIdx + 1)) || s;
      d.currentFrameIndex = cursorFloat;
      d.plannedPose = suffixPlan.poses[targetIdx] || null;
      return computeGoalReplayCameraPose(nextS || s, scoringTeam, {
        prevStateBuffer: s,
        alpha: Math.max(0, Math.min(1, cursorFloat - targetIdx)),
        scorerCarIndex,
        progress: total > 1 ? cursorFloat / (total - 1) : 0,
        frameIndex: cursorFloat,
        suffixCameraPlan: suffixPlan,
        directorState: d,
        dt: 1 / REPLAY_TICK_RATE,
        exactDt: true,
      });
    }

    d.initialized = false;
    let lastPose: DirectorCameraPose | null = null;
    for (let i = Math.max(0, targetIdx - 90); i <= targetIdx; i++) {
      const s = getFrameBufferByIndex(i);
      if (!s) continue;
      const em = decodeReplayDirectorTelemetryFromState(s);
      const la = em
        ? {
            primaryCarIndex: em.activeTouchCarIndex >= 0 ? em.activeTouchCarIndex : (scorerCarIndex ?? 0),
            nextCarIndex: em.nextTouchCarIndex,
            nextTouchBlend: em.nextTouchBlend,
            nextTouchBallPos: em.nextTouchBallPos,
            interceptorCarIndex: em.interceptorCarIndex ?? -1,
            interceptorBlend: em.interceptorBlend ?? 0,
            plannedPose: em.plannedPose ?? null,
            postGoalElapsedSec: em.postGoalElapsedSec ?? 0,
          }
        : resolveTouchLookaheadForFrame(i, d.activeTouchCarIndex ?? scorerCarIndex ?? 0);
      d.activeTouchCarIndex = la.primaryCarIndex;
      d.nextTouchCarIndex = la.nextCarIndex;
      d.nextTouchBlend = la.nextTouchBlend;
      d.nextTouchBallPos = la.nextTouchBallPos;
      d.interceptorCarIndex = la.interceptorCarIndex ?? -1;
      d.interceptorBlend = la.interceptorBlend ?? 0;
      d.plannedPose = la.plannedPose ?? null;
      d.postGoalElapsedSec = la.postGoalElapsedSec ?? 0;
      lastPose = computeGoalReplayCameraPose(s, scoringTeam, {
        scorerCarIndex,
        progress: total > 1 ? i / (total - 1) : 0,
        frameIndex: i,
        directorState: d,
        dt: 1 / REPLAY_TICK_RATE,
        exactDt: true,
      });
    }
    return lastPose;
  }

  syncForPlaybackStep(input: StepDirectorCameraSyncInput): StepDirectorCameraSyncResult {
    const {
      baseIdx, nextIdx, alpha, useCsvPose, cursorFloat, isPaused, isScrubbing,
      prevEntry, nextEntry, currFrame, suffixPlan, scorerCarIndex, resolveTouchLookaheadForFrame,
    } = input;
    const d = this.state;
    d.isPaused = isPaused;
    d.isScrubbing = isScrubbing;
    d.useRecordedCsvPose = useCsvPose;
    d.currentFrameIndex = cursorFloat;
    let resolvedScorerCarIndex = scorerCarIndex;
    const em = !suffixPlan && currFrame ? decodeReplayDirectorTelemetryFromState(currFrame) : null;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;

    if (useCsvPose && prevEntry?.recordedCsvRow) {
      const r0 = prevEntry.recordedCsvRow;
      const r1 = nextEntry?.recordedCsvRow || r0;
      d.recordedPose = {
        eyeX: lerp(r0.cam_eye_x ?? 0, r1.cam_eye_x ?? 0),
        eyeY: lerp(r0.cam_eye_y ?? 0, r1.cam_eye_y ?? 0),
        eyeZ: lerp(r0.cam_eye_z ?? 0, r1.cam_eye_z ?? 0),
        targetX: lerp(r0.cam_target_x ?? 0, r1.cam_target_x ?? 0),
        targetY: lerp(r0.cam_target_y ?? 0, r1.cam_target_y ?? 0),
        targetZ: lerp(r0.cam_target_z ?? 0, r1.cam_target_z ?? 0),
      };
    } else {
      d.recordedPose = null;
    }

    if (!useCsvPose && suffixPlan && Array.isArray(suffixPlan.poses) && suffixPlan.poses.length > 0) {
      const p0 = suffixPlan.poses[baseIdx];
      const p1 = suffixPlan.poses[nextIdx] || p0;
      d.activeTouchCarIndex = p0.activeTouchCarIndex;
      d.nextTouchCarIndex = p0.nextTouchCarIndex;
      d.nextTouchBlend = lerp(p0.nextTouchBlend, p1.nextTouchBlend);
      d.nextTouchBallPos = p0.nextTouchBallPos;
      d.interceptorCarIndex = p0.interceptorCarIndex ?? -1;
      d.interceptorBlend = lerp(p0.interceptorBlend ?? 0, p1.interceptorBlend ?? 0);
      d.postGoalElapsedSec = lerp(p0.postGoalElapsedSec ?? 0, p1.postGoalElapsedSec ?? 0);
      d.lateralBias = p0.lateralBias;
      d.plannedPose = {
        eyeX: lerp(p0.eyeX, p1.eyeX), eyeY: lerp(p0.eyeY, p1.eyeY), eyeZ: lerp(p0.eyeZ, p1.eyeZ),
        targetX: lerp(p0.targetX, p1.targetX), targetY: lerp(p0.targetY, p1.targetY), targetZ: lerp(p0.targetZ, p1.targetZ),
        rawEyeX: lerp(p0.rawEyeX, p1.rawEyeX), rawEyeY: lerp(p0.rawEyeY, p1.rawEyeY), rawEyeZ: lerp(p0.rawEyeZ, p1.rawEyeZ),
        rawTargetX: lerp(p0.rawTargetX, p1.rawTargetX), rawTargetY: lerp(p0.rawTargetY, p1.rawTargetY), rawTargetZ: lerp(p0.rawTargetZ, p1.rawTargetZ),
      };
    } else if (!useCsvPose && em) {
      d.activeTouchCarIndex = em.activeTouchCarIndex >= 0 ? em.activeTouchCarIndex : (scorerCarIndex ?? 0);
      d.nextTouchCarIndex = em.nextTouchCarIndex;
      d.nextTouchBlend = em.nextTouchBlend;
      d.nextTouchBallPos = em.nextTouchBallPos;
      d.interceptorCarIndex = em.interceptorCarIndex ?? -1;
      d.interceptorBlend = em.interceptorBlend ?? 0;
      d.plannedPose = em.plannedPose ?? null;
      d.postGoalElapsedSec = em.postGoalElapsedSec ?? 0;
      if (typeof em.lateralBias === 'number' && em.lateralBias !== 0) {
        d.lateralBias = em.lateralBias;
        d.hasResolvedInitialLateralBias = true;
      }
      if (typeof em.scorerCarIndex === 'number' && em.scorerCarIndex >= 0) {
        d.scorerCarIndex = em.scorerCarIndex;
        resolvedScorerCarIndex = em.scorerCarIndex;
      }
    } else {
      const la = resolveTouchLookaheadForFrame(baseIdx, d.activeTouchCarIndex ?? 0);
      d.activeTouchCarIndex = la.primaryCarIndex;
      d.nextTouchCarIndex = la.nextCarIndex;
      d.nextTouchBlend = la.nextTouchBlend;
      d.nextTouchBallPos = la.nextTouchBallPos;
      d.interceptorCarIndex = la.interceptorCarIndex ?? -1;
      d.interceptorBlend = la.interceptorBlend ?? 0;
      d.plannedPose = la.plannedPose ?? null;
      d.postGoalElapsedSec = la.postGoalElapsedSec ?? 0;
    }

    return { embeddedTelemetry: em, resolvedScorerCarIndex };
  }

  clearRetained(): void {
    const d = this.state;
    d.initialized = false;
    d.useRecordedCsvPose = false;
    d.recordedPose = null;
    d.suffixCameraPlan = null;
    d.plannedPose = null;
    d.touchEvents = [];
  }

  cloneFrom(sourceState: Partial<DirectorCameraState> | null | undefined): void {
    if (!sourceState) return;
    this.state = {
      ...this.state,
      ...sourceState,
      touchEvents: Array.isArray(sourceState.touchEvents)
        ? sourceState.touchEvents.map((t: ReplayTouchEvent) => ({ ...t }))
        : [],
    };
  }
}
