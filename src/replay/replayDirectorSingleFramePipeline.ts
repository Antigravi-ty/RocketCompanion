/**
 * replayDirectorSingleFramePipeline.ts
 * Pure narrow-input pipeline for current-frame Director Camera diagnostic snapshot evaluation.
 */

import { REPLAY_TICK_RATE } from './ReplayRingBuffer.ts';
import {
   computeGoalReplayCameraPose,
  type DirectorCameraPose,
} from './ReplayDirectorCamera.ts';
import {
  decodeReplayDirectorTelemetryFromState,
  type EmbeddedReplayDirectorTelemetry,
} from './ReplayFrameInterpolator.ts';
import {
  round3,
  round4,
  computeCameraAnglesFromPose,
  extractFrameEntities,
} from './ReplayDirectorSceneAnalysis.ts';
import type {
  DirectorCameraState,
  DirectorSmoothnessSummary,
  DirectorAnomalyPeaks,
  ReplayActiveFrameEntry,
} from './replayDirectorStateTypes.ts';
import type { SuffixDirectorTrajectoryPlan } from './ReplayDirectorTrajectoryPlanner.ts';
import type { ResolvedTouchLookahead } from './ReplayTouchTimelineAnalyzer.ts';

export interface ReplayDirectorDiagnosticInput {
  totalFrames: number;
  activeWindowCount: number;
  currentFrameIndex: number;
  cursorFloat: number;
  progress: number;
  playbackSpeed: number;
  isPaused: boolean;
  isPersistent: boolean;
  isScrubbing: boolean;
  isActive: boolean;
  isImportedPreview: boolean;
  importedFileName: string | null;
  useRecordedCsvCamera: boolean;
  cachedSmoothnessSummary: DirectorSmoothnessSummary | null;
  importedSummary: DirectorSmoothnessSummary | null;
  cachedAnomalyPeaks: DirectorAnomalyPeaks | null;
  importedAnomalyPeaks: DirectorAnomalyPeaks | null;
  scoringTeam: number;
  scorerCarIndex: number;
  carTeamResolver: ((carIndex: number) => number) | null;
  directorCameraState: DirectorCameraState;
  getFrameEntryByIndex: (index: number) => ReplayActiveFrameEntry | null;
  getFrameBufferByIndex: (index: number) => Float32Array | null;
  ensureSuffixCameraPlan: () => SuffixDirectorTrajectoryPlan | null;
  resolveTouchLookaheadForFrame: (frameIdx: number, fallbackScorerCarIndex: number) => ResolvedTouchLookahead;
  computeDramaticSlowMoFactor: (cursorFloat: number, options?: { ignoreScrubState?: boolean }) => number;
}

export function resolveEmbeddedLookahead(
  embedded: EmbeddedReplayDirectorTelemetry,
  fallbackScorerCarIndex: number,
): ResolvedTouchLookahead {
  return {
    primaryCarIndex:
      embedded.activeTouchCarIndex >= 0 ? embedded.activeTouchCarIndex : fallbackScorerCarIndex,
    nextCarIndex: embedded.nextTouchCarIndex,
    nextTouchBlend: embedded.nextTouchBlend,
    nextTouchBallPos: embedded.nextTouchBallPos,
    interceptorCarIndex: embedded.interceptorCarIndex ?? -1,
    interceptorBlend: embedded.interceptorBlend ?? 0,
    postGoalElapsedSec: embedded.postGoalElapsedSec ?? 0,
    plannedPose: null,
  };
}

export function computeViewAngleToPointDeg(
  pose: { eyeX: number; eyeY: number; eyeZ: number; targetX: number; targetY: number; targetZ: number } | null | undefined,
  pt: ArrayLike<number> | null | undefined,
): number {
  if (!pose || !pt) return 0;
  const fx = pose.targetX - pose.eyeX;
  const fy = pose.targetY - pose.eyeY;
  const fz = pose.targetZ - pose.eyeZ;
  const fl = Math.hypot(fx, fy, fz);
  const vx = pt[0] - pose.eyeX;
  const vy = pt[1] - pose.eyeY;
  const vz = pt[2] - pose.eyeZ;
  const vl = Math.hypot(vx, vy, vz);
  if (fl < 1e-4 || vl < 1e-4) return 0;
  const dot = Math.max(-1, Math.min(1, (fx * vx + fy * vy + fz * vz) / (fl * vl)));
  return round3((Math.acos(dot) * 180) / Math.PI);
}

export function buildCurrentFrameDiagnosticSnapshot(input: ReplayDirectorDiagnosticInput) {
  const total = input.activeWindowCount > 0 ? input.activeWindowCount : input.totalFrames;
  if (total <= 0) return null;
  const idx = Math.max(0, Math.min(total - 1, input.currentFrameIndex));
  const entry = input.getFrameEntryByIndex(idx);
  const snap = input.getFrameBufferByIndex(idx);
  if (!snap) return null;

  const entities = extractFrameEntities(snap, input.carTeamResolver ?? undefined);
  const frameId = entry?.tick ?? entities.tick ?? idx;
  const csvRow = entry?.recordedCsvRow || null;
  const useCsvCam = Boolean(
    input.isImportedPreview && input.useRecordedCsvCamera && csvRow,
  );
  const suffixPlan = !useCsvCam ? input.ensureSuffixCameraPlan() || null : null;
  const embedded = !suffixPlan ? decodeReplayDirectorTelemetryFromState(snap) : null;
  const progress =
    embedded && typeof embedded.progress === 'number' && total <= 1
      ? embedded.progress
      : total > 1
        ? idx / (total - 1)
        : 0;

  const lookahead = useCsvCam && csvRow
    ? {
        primaryCarIndex: csvRow.active_touch_car_idx ?? (input.scorerCarIndex ?? 0),
        nextCarIndex: csvRow.next_touch_car_idx ?? -1,
        nextTouchBlend: csvRow.next_touch_blend ?? 0,
        nextTouchBallPos: null,
        interceptorCarIndex: -1,
        interceptorBlend: 0,
        postGoalElapsedSec: 0,
      }
    : embedded
      ? resolveEmbeddedLookahead(embedded, input.scorerCarIndex ?? 0)
      : input.resolveTouchLookaheadForFrame(
          idx,
          input.directorCameraState.activeTouchCarIndex ?? input.scorerCarIndex ?? 0,
        );
  const slowMoFactor = useCsvCam && csvRow
    ? (csvRow.slow_mo_factor ?? 1.0)
    : input.computeDramaticSlowMoFactor(idx, { ignoreScrubState: true });

  const effectiveLateralBias = useCsvCam && csvRow
    ? (csvRow.lateral_bias ?? 1.0)
    : suffixPlan && typeof suffixPlan.lateralBias === 'number'
      ? suffixPlan.lateralBias
      : embedded && typeof embedded.lateralBias === 'number' && embedded.lateralBias !== 0
        ? embedded.lateralBias
        : (input.directorCameraState.lateralBias || 1.0);

  const rawPose: DirectorCameraPose = useCsvCam && csvRow
    ? {
        eyeX: csvRow.raw_eye_x ?? csvRow.cam_eye_x ?? 0,
        eyeY: csvRow.raw_eye_y ?? csvRow.cam_eye_y ?? 0,
        eyeZ: csvRow.raw_eye_z ?? csvRow.cam_eye_z ?? 0,
        targetX: csvRow.raw_target_x ?? csvRow.cam_target_x ?? 0,
        targetY: csvRow.raw_target_y ?? csvRow.cam_target_y ?? 0,
        targetZ: csvRow.raw_target_z ?? csvRow.cam_target_z ?? 0,
      }
    : computeGoalReplayCameraPose(snap, input.scoringTeam, {
        scorerCarIndex: input.scorerCarIndex,
        progress,
        frameIndex: idx,
        suffixCameraPlan: suffixPlan,
        directorState: {
          ...input.directorCameraState,
          suffixCameraPlan: suffixPlan,
          lateralBias: effectiveLateralBias,
          activeTouchCarIndex: lookahead.primaryCarIndex,
          nextTouchCarIndex: lookahead.nextCarIndex,
          nextTouchBlend: lookahead.nextTouchBlend,
          nextTouchBallPos: lookahead.nextTouchBallPos,
          interceptorCarIndex: lookahead.interceptorCarIndex ?? -1,
          interceptorBlend: lookahead.interceptorBlend ?? 0,
          postGoalElapsedSec: lookahead.postGoalElapsedSec ?? 0,
        },
        dt: 1 / REPLAY_TICK_RATE,
        exactDt: true,
        skipDamping: true,
      });

  let dampedPose: DirectorCameraPose = rawPose;
  if (useCsvCam && csvRow) {
    dampedPose = {
      eyeX: csvRow.cam_eye_x ?? 0,
      eyeY: csvRow.cam_eye_y ?? 0,
      eyeZ: csvRow.cam_eye_z ?? 0,
      targetX: csvRow.cam_target_x ?? 0,
      targetY: csvRow.cam_target_y ?? 0,
      targetZ: csvRow.cam_target_z ?? 0,
    };
  } else if (suffixPlan && Array.isArray(suffixPlan.poses) && suffixPlan.poses[idx]) {
    dampedPose = computeGoalReplayCameraPose(snap, input.scoringTeam, {
      scorerCarIndex: input.scorerCarIndex,
      progress,
      frameIndex: idx,
      suffixCameraPlan: suffixPlan,
      dt: 1 / REPLAY_TICK_RATE,
      exactDt: true,
    });
  } else if (input.directorCameraState.initialized) {
    dampedPose = {
      eyeX: input.directorCameraState.eyeX,
      eyeY: input.directorCameraState.eyeY,
      eyeZ: input.directorCameraState.eyeZ,
      targetX: input.directorCameraState.targetX,
      targetY: input.directorCameraState.targetY,
      targetZ: input.directorCameraState.targetZ,
    };
  } else {
    const tempState: DirectorCameraState = {
      ...input.directorCameraState,
      initialized: false,
      lateralBias: effectiveLateralBias,
    };
    const warmStart = Math.max(0, idx - 90);
    for (let i = warmStart; i <= idx; i++) {
      const s = input.getFrameBufferByIndex(i);
      if (!s) continue;
      const emb = decodeReplayDirectorTelemetryFromState(s);
      const la = emb
        ? resolveEmbeddedLookahead(emb, input.scorerCarIndex ?? 0)
        : input.resolveTouchLookaheadForFrame(
            i,
            tempState.activeTouchCarIndex ?? input.scorerCarIndex ?? 0,
          );
      Object.assign(tempState, {
        activeTouchCarIndex: la.primaryCarIndex,
        nextTouchCarIndex: la.nextCarIndex,
        nextTouchBlend: la.nextTouchBlend,
        nextTouchBallPos: la.nextTouchBallPos,
        interceptorCarIndex: la.interceptorCarIndex ?? -1,
        interceptorBlend: la.interceptorBlend ?? 0,
        postGoalElapsedSec: la.postGoalElapsedSec ?? 0,
      });
      dampedPose = computeGoalReplayCameraPose(s, input.scoringTeam, {
        scorerCarIndex: input.scorerCarIndex,
        progress: total > 1 ? i / (total - 1) : 0,
        frameIndex: i,
        directorState: tempState,
        dt: 1 / REPLAY_TICK_RATE,
        exactDt: true,
      });
    }
  }

  const dampedAngles = computeCameraAnglesFromPose(dampedPose);
  const rawAngles = computeCameraAnglesFromPose(rawPose);

  const focusCar =
    entities.cars.find((c) => c.carIndex === lookahead.primaryCarIndex) ||
    entities.cars[0] ||
    null;
  const interceptorCar =
    typeof lookahead.interceptorCarIndex === 'number' && lookahead.interceptorCarIndex >= 0
      ? entities.cars.find((c) => c.carIndex === lookahead.interceptorCarIndex) || null
      : null;
  const carViewAngleDeg = useCsvCam && csvRow && typeof csvRow.car_view_angle_deg === 'number'
    ? round3(csvRow.car_view_angle_deg)
    : focusCar
      ? computeViewAngleToPointDeg(dampedPose, focusCar.pos)
      : 0;
  const interceptorViewAngleDeg = interceptorCar
    ? computeViewAngleToPointDeg(dampedPose, interceptorCar.pos)
    : 0;
  const ballViewAngleDeg = useCsvCam && csvRow && typeof csvRow.ball_view_angle_deg === 'number'
    ? round3(csvRow.ball_view_angle_deg)
    : computeViewAngleToPointDeg(dampedPose, entities.ball.pos);

  return {
    frameId, replayFrameIndex: idx, totalReplayFrames: total,
    cursorFloat: round3(input.cursorFloat), progress: round4(progress),
    timestampInReplaySec: round3(idx / REPLAY_TICK_RATE), slowMoFactor: round3(slowMoFactor),
    playbackSpeed: input.playbackSpeed, isPaused: input.isPaused,
    isPersistent: input.isPersistent, isScrubbing: input.isScrubbing,
    isActiveReplay: Boolean(input.isActive),
    isRetainedLastReplay: !input.isActive && input.activeWindowCount > 0,
    isImportedPreview: Boolean(input.isImportedPreview),
    importedFileName: input.importedFileName || null,
    useRecordedCsvCamera: Boolean(input.useRecordedCsvCamera),
    hasRecordedCsvCamera: Boolean(entry?.recordedCsvRow),
    importedSummary: input.cachedSmoothnessSummary || input.importedSummary || null,
    anomalyPeaks: input.cachedAnomalyPeaks || input.importedAnomalyPeaks || null,
    scoringTeam: input.scoringTeam, scorerCarIndex: input.scorerCarIndex,
    lookahead: {
      activeTouchCarIndex: lookahead.primaryCarIndex,
      nextTouchCarIndex: lookahead.nextCarIndex,
      nextTouchBlend: round4(lookahead.nextTouchBlend),
      nextTouchBallPos: lookahead.nextTouchBallPos
        ? [round3(lookahead.nextTouchBallPos.x), round3(lookahead.nextTouchBallPos.y), round3(lookahead.nextTouchBallPos.z)]
        : null,
      interceptorCarIndex: lookahead.interceptorCarIndex ?? -1,
      interceptorBlend: round4(lookahead.interceptorBlend ?? 0),
      postGoalElapsedSec: round3(lookahead.postGoalElapsedSec ?? 0),
      lateralBias: effectiveLateralBias,
    },
    cameraPose: {
      dampedEyeUnreal: [round3(dampedPose.eyeX), round3(dampedPose.eyeY), round3(dampedPose.eyeZ)],
      dampedTargetUnreal: [round3(dampedPose.targetX), round3(dampedPose.targetY), round3(dampedPose.targetZ)],
      dampedEyeThreeJs: [round3(dampedPose.eyeX), round3(dampedPose.eyeZ), round3(dampedPose.eyeY)],
      dampedTargetThreeJs: [round3(dampedPose.targetX), round3(dampedPose.targetZ), round3(dampedPose.targetY)],
      ...dampedAngles,
      carViewAngleDeg, interceptorViewAngleDeg, ballViewAngleDeg,
      eyeStepUu: round3(csvRow?.eye_step_uu ?? 0), targetStepUu: round3(csvRow?.target_step_uu ?? 0),
      yawStepDeg: round4(csvRow?.yaw_step_deg ?? 0), pitchStepDeg: round4(csvRow?.pitch_step_deg ?? 0),
      rawUndampedEyeUnreal: [round3(rawPose.eyeX), round3(rawPose.eyeY), round3(rawPose.eyeZ)],
      rawUndampedTargetUnreal: [round3(rawPose.targetX), round3(rawPose.targetY), round3(rawPose.targetZ)],
      rawDistanceToTarget: rawAngles.distanceToTarget, rawYawDeg: rawAngles.yawDeg, rawPitchDeg: rawAngles.pitchDeg,
    },
    ball: entities.ball, cars: entities.cars,
    incidents: Array.isArray(entry?.incidents) ? entry.incidents : [],
    signals: Array.isArray(entry?.signals) ? entry.signals : [],
  };
}

export type CurrentFrameDiagnosticSnapshot = NonNullable<ReturnType<typeof buildCurrentFrameDiagnosticSnapshot>>;
