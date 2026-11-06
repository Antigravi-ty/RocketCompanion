/**
 * ReplayDirectorDiagnostics.ts
 * Pure narrow-input pipeline for Director Camera diagnostic snapshot generation
 * and deterministic 120Hz full-window camera trajectory simulation.
 */

import { REPLAY_TICK_RATE } from './ReplayRingBuffer.ts';
import { SIM_OFFSETS } from '../physics/RocketSimConstants.ts';
import { computeGoalReplayCameraPose, type DirectorCameraPose } from './ReplayDirectorCamera.ts';
import { decodeReplayDirectorTelemetryFromState } from './ReplayFrameInterpolator.ts';
import {
  REPLAY_DIRECTOR_CONFIG,
  DEFAULT_REPLAY_DIRECTOR_CONFIG,
} from '../ui-core/config/replayDirectorConfig.ts';
import {
  round3,
  round4,
  computeCameraAnglesFromPose,
  extractFrameEntities,
  type CameraAnglesFromPose,
  type ExtractedBallEntity,
  type ExtractedCarEntity,
} from './ReplayDirectorSceneAnalysis.ts';
import { wrapAngleDeltaDeg } from './replayDirectorElevationPipeline.ts';
import type { ReplayTouchEvent } from './ReplayDirectorGazeSolver.ts';
import {
  buildCurrentFrameDiagnosticSnapshot,
  computeViewAngleToPointDeg,
  resolveEmbeddedLookahead,
  type ReplayDirectorDiagnosticInput,
} from './replayDirectorSingleFramePipeline.ts';
import type {
  DirectorCameraState,
  DirectorSmoothnessSummary,
  DirectorAnomalyPeaks,
  ReplayCarRosterEntry,
} from './replayDirectorStateTypes.ts';

export {
  buildCurrentFrameDiagnosticSnapshot,
  type ReplayDirectorDiagnosticInput,
};

export interface DirectorDiagnosticPatternOptions {
  extraMetadata?: Record<string, unknown>;
  carEntries?: ReplayCarRosterEntry[];
}

export interface DirectorDiagnosticFrameLookahead {
  activeTouchCarIndex: number;
  nextTouchCarIndex: number;
  nextTouchBlend: number;
  nextTouchBallPos: [number, number, number] | null;
  interceptorCarIndex: number;
  interceptorBlend: number;
  postGoalElapsedSec: number;
  smoothedStrikerPos: [number, number, number];
  carSwitchBlend: number;
  lateralBias: number;
}

export interface DirectorDiagnosticFrameCameraPose {
  eyeUnreal: [number, number, number];
  targetUnreal: [number, number, number];
  eyeThreeJs: [number, number, number];
  targetThreeJs: [number, number, number];
  forwardUnreal: [number, number, number];
  distanceToTarget: number;
  yawDeg: number;
  pitchDeg: number;
  carViewAngleDeg: number;
  interceptorViewAngleDeg: number;
  ballViewAngleDeg: number;
  rawUndampedEyeUnreal: [number, number, number];
  rawUndampedTargetUnreal: [number, number, number];
  rawDistanceToTarget: number;
  rawYawDeg: number;
  rawPitchDeg: number;
  eyeStepUu: number;
  targetStepUu: number;
  yawStepDeg: number;
  pitchStepDeg: number;
  rawEyeStepUu: number;
  rawTargetStepUu: number;
  eyeAccelUu: number;
  targetAccelUu: number;
}

export interface DirectorDiagnosticFrameEntry {
  frameId: number;
  replayFrameIndex: number;
  timestampSec: number;
  progress: number;
  slowMoFactor: number;
  isSelectedCursorFrame: boolean;
  lookahead: DirectorDiagnosticFrameLookahead;
  cameraPose: DirectorDiagnosticFrameCameraPose;
  ball: ExtractedBallEntity;
  cars: ExtractedCarEntity[];
  incidents?: Array<Record<string, unknown>>;
}

export interface DirectorDiagnosticTouchTimelineEntry {
  replayFrameIndex: number;
  frameId: number;
  timestampSec: number;
  carIndex: number;
  team: number;
  ballPos: [number, number, number];
}

export interface DirectorDiagnosticPatternPayload {
  schema: string;
  exportedAt: string;
  coordinateConventions: {
    unreal: string;
    threeJs: string;
  };
  replayMetadata: {
    tickRate: number;
    totalReplayFrames: number;
    durationSeconds: number;
    startFrameId: number;
    endFrameId: number;
    scoringTeam: number;
    scoringTeamName: string;
    scorerCarIndex: number;
    lastScoringTouchReplayFrameIndex: number;
    lastScoringTouchFrameId: number;
    goalLineReplayFrameIndex: number;
    goalLineFrameId: number;
    trajectorySmoothnessSummary: DirectorSmoothnessSummary;
    anomalyPeaks: DirectorAnomalyPeaks;
    carEntries?: ReplayCarRosterEntry[];
    playbackStateAtExport: {
      selectedReplayFrameIndex: number;
      selectedFrameId: number;
      cursorFloat: number;
      progress: number;
      isPaused: boolean;
      isPersistent: boolean;
      isScrubbing: boolean;
      playbackSpeed: number;
    };
    [key: string]: unknown;
  };
  directorConfig: Record<string, unknown>;
  defaultDirectorConfig: Record<string, unknown>;
  touchTimeline: DirectorDiagnosticTouchTimelineEntry[];
  selectedFrameDiagnostic: ReturnType<typeof buildCurrentFrameDiagnosticSnapshot>;
  frames: DirectorDiagnosticFrameEntry[];
  [key: string]: unknown;
}

export interface DirectorDiagnosticPatternEvaluationResult {
  payload: DirectorDiagnosticPatternPayload;
  trajectorySmoothnessSummary: DirectorSmoothnessSummary;
  anomalyPeaks: DirectorAnomalyPeaks;
}

/**
 * Simulates the full Goal Replay Director camera trajectory deterministically at 120Hz
 * across all frames in the replay window for camera diagnostics.
 */
export function evaluateDirectorDiagnosticPatternPayload(
  input: ReplayDirectorDiagnosticInput,
  options: DirectorDiagnosticPatternOptions = {},
): DirectorDiagnosticPatternEvaluationResult | null {
  const total = input.activeWindowCount > 0 ? input.activeWindowCount : input.totalFrames;
  if (total <= 0) return null;

  const firstEntry = input.getFrameEntryByIndex(0);
  const lastEntry = input.getFrameEntryByIndex(total - 1);
  const firstSnap = input.getFrameBufferByIndex(0);
  const lastSnap = input.getFrameBufferByIndex(total - 1);

  const startFrameId = firstEntry?.tick ?? Math.round(firstSnap?.[SIM_OFFSETS.TICK] || 0);
  const endFrameId = lastEntry?.tick ?? Math.round(lastSnap?.[SIM_OFFSETS.TICK] || (startFrameId + total - 1));
  const suffixPlan = input.ensureSuffixCameraPlan() || null;
  const dState = input.directorCameraState;

  const simDirectorState: DirectorCameraState = {
    initialized: false,
    eyeX: 0, eyeY: 0, eyeZ: 0,
    targetX: 0, targetY: 0, targetZ: 0,
    lateralBias: suffixPlan?.lateralBias ?? dState.lateralBias ?? 1.0,
    hasResolvedInitialLateralBias: Boolean(dState.hasResolvedInitialLateralBias),
    activeTouchCarIndex: dState.activeTouchCarIndex ?? input.scorerCarIndex ?? 0,
    scorerCarIndex: dState.scorerCarIndex ?? input.scorerCarIndex ?? 0,
    nextTouchCarIndex: -1,
    nextTouchBlend: 0,
    nextTouchBallPos: null,
    interceptorCarIndex: -1,
    interceptorBlend: 0,
    suffixCameraPlan: suffixPlan,
    postGoalElapsedSec: 0,
    initialSettledCarPos: dState.initialSettledCarPos ? { ...dState.initialSettledCarPos } : null,
    touchEvents: Array.isArray(dState.touchEvents)
      ? dState.touchEvents.map((t: ReplayTouchEvent) => ({ ...t }))
      : [],
    lastScoringTouchFrameIdx: dState.lastScoringTouchFrameIdx ?? -1,
    goalLineFrameIdx: dState.goalLineFrameIdx ?? -1,
  };

  const frames: DirectorDiagnosticFrameEntry[] = [];
  let prevPose: DirectorCameraPose | null = null;
  let prevRawPose: DirectorCameraPose | null = null;
  let prevAngles: CameraAnglesFromPose | null = null;
  let prevEyeVel: [number, number, number] | null = null;
  let prevTargetVel: [number, number, number] | null = null;

  let maxEyeStepUu = 0;
  let maxTargetStepUu = 0;
  let maxRawEyeStepUu = 0;
  let maxRawTargetStepUu = 0;
  let maxEyeAccelUu = 0;
  let maxTargetAccelUu = 0;
  let maxYawStepDeg = 0;
  let totalYawPathDeg = 0;
  let minYawAccumDeg = 0;
  let maxYawAccumDeg = 0;
  let yawAccumDeg = 0;
  let maxPreGoalCarViewAngleDeg = 0;
  let maxPreGoalBallViewAngleDeg = 0;
  let maxInterceptorViewAngleDeg = 0;
  let maxPostGoalCarViewAngleDeg = 0;

  const anomalyPeaks = {
    maxEyeStep: { valueUu: 0, replayFrameIndex: 0, frameId: startFrameId, timestampSec: 0 },
    maxYawStep: { valueDeg: 0, replayFrameIndex: 0, frameId: startFrameId, timestampSec: 0 },
    maxEyeAccel: { valueUu: 0, replayFrameIndex: 0, frameId: startFrameId, timestampSec: 0 },
    maxPreGoalCarViewAngle: { valueDeg: 0, replayFrameIndex: 0, frameId: startFrameId, timestampSec: 0 },
    maxPreGoalBallViewAngle: { valueDeg: 0, replayFrameIndex: 0, frameId: startFrameId, timestampSec: 0 },
  };

  const effectiveCarEntries =
    Array.isArray(options.carEntries) && options.carEntries.length > 0
      ? options.carEntries
      : Array.isArray(input.carEntries) && input.carEntries.length > 0
        ? input.carEntries
        : null;

  for (let idx = 0; idx < total; idx++) {
    const entry = input.getFrameEntryByIndex(idx);
    const snap = input.getFrameBufferByIndex(idx);
    if (!snap) continue;

    const entities = extractFrameEntities(snap, input.carTeamResolver ?? undefined, effectiveCarEntries);
    const frameId = entry?.tick ?? entities.tick ?? (startFrameId + idx);
    const embedded = !suffixPlan ? decodeReplayDirectorTelemetryFromState(snap) : null;
    const progress = total > 1 ? idx / (total - 1) : (embedded?.progress ?? 0);

    if (embedded && typeof embedded.lateralBias === 'number' && embedded.lateralBias !== 0) {
      simDirectorState.lateralBias = embedded.lateralBias;
      simDirectorState.hasResolvedInitialLateralBias = true;
    }
    if (embedded && typeof embedded.scorerCarIndex === 'number' && embedded.scorerCarIndex >= 0) {
      simDirectorState.scorerCarIndex = embedded.scorerCarIndex;
    }

    const lookahead = embedded
      ? resolveEmbeddedLookahead(embedded, simDirectorState.scorerCarIndex ?? input.scorerCarIndex ?? 0)
      : input.resolveTouchLookaheadForFrame(
          idx,
          simDirectorState.activeTouchCarIndex ?? input.scorerCarIndex ?? 0,
        );
    Object.assign(simDirectorState, {
      activeTouchCarIndex: lookahead.primaryCarIndex,
      nextTouchCarIndex: lookahead.nextCarIndex,
      nextTouchBlend: lookahead.nextTouchBlend,
      nextTouchBallPos: lookahead.nextTouchBallPos,
      interceptorCarIndex: lookahead.interceptorCarIndex ?? -1,
      interceptorBlend: lookahead.interceptorBlend ?? 0,
      postGoalElapsedSec: lookahead.postGoalElapsedSec ?? 0,
      currentFrameIndex: idx,
    });

    const slowMoFactor = input.computeDramaticSlowMoFactor(idx, { ignoreScrubState: true });
    const dampedPose = computeGoalReplayCameraPose(snap, input.scoringTeam, {
      scorerCarIndex: simDirectorState.scorerCarIndex ?? input.scorerCarIndex,
      progress,
      frameIndex: idx,
      suffixCameraPlan: suffixPlan,
      directorState: simDirectorState,
      dt: 1 / REPLAY_TICK_RATE,
      exactDt: true,
    });

    const rawPose: DirectorCameraPose = {
      eyeX: dampedPose.rawEyeX ?? dampedPose.eyeX,
      eyeY: dampedPose.rawEyeY ?? dampedPose.eyeY,
      eyeZ: dampedPose.rawEyeZ ?? dampedPose.eyeZ,
      targetX: dampedPose.rawTargetX ?? dampedPose.targetX,
      targetY: dampedPose.rawTargetY ?? dampedPose.targetY,
      targetZ: dampedPose.rawTargetZ ?? dampedPose.targetZ,
    };

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
    const effectiveCarPos =
      idx === 0 && simDirectorState.initialSettledCarPos
        ? [
            simDirectorState.initialSettledCarPos.x,
            simDirectorState.initialSettledCarPos.y,
            simDirectorState.initialSettledCarPos.z,
          ]
        : focusCar
          ? focusCar.pos
          : null;
    const carViewAngleDeg = effectiveCarPos ? computeViewAngleToPointDeg(dampedPose, effectiveCarPos) : 0;
    const interceptorViewAngleDeg = interceptorCar
      ? computeViewAngleToPointDeg(dampedPose, interceptorCar.pos)
      : 0;
    const ballViewAngleDeg = computeViewAngleToPointDeg(dampedPose, entities.ball.pos);

    const timestampSec = round3(idx / REPLAY_TICK_RATE);
    const goalIdx = simDirectorState.goalLineFrameIdx;
    if (goalIdx < 0 || idx <= goalIdx) {
      if (carViewAngleDeg > maxPreGoalCarViewAngleDeg) {
        maxPreGoalCarViewAngleDeg = carViewAngleDeg;
        anomalyPeaks.maxPreGoalCarViewAngle = {
          valueDeg: round3(carViewAngleDeg),
          replayFrameIndex: idx,
          frameId,
          timestampSec,
        };
      }
      if (ballViewAngleDeg > maxPreGoalBallViewAngleDeg) {
        maxPreGoalBallViewAngleDeg = ballViewAngleDeg;
        anomalyPeaks.maxPreGoalBallViewAngle = {
          valueDeg: round3(ballViewAngleDeg),
          replayFrameIndex: idx,
          frameId,
          timestampSec,
        };
      }
      if (
        (lookahead.interceptorBlend ?? 0) > 0.25 &&
        interceptorViewAngleDeg > maxInterceptorViewAngleDeg
      ) {
        maxInterceptorViewAngleDeg = interceptorViewAngleDeg;
      }
    } else if (idx >= goalIdx + 45 && carViewAngleDeg > maxPostGoalCarViewAngleDeg) {
      maxPostGoalCarViewAngleDeg = carViewAngleDeg;
    }

    let eyeStepUu = 0;
    let targetStepUu = 0;
    let rawEyeStepUu = 0;
    let rawTargetStepUu = 0;
    let yawStepDeg = 0;
    let pitchStepDeg = 0;
    let eyeAccelUu = 0;
    let targetAccelUu = 0;

    if (prevPose && prevRawPose && prevAngles) {
      const evX = dampedPose.eyeX - prevPose.eyeX;
      const evY = dampedPose.eyeY - prevPose.eyeY;
      const evZ = dampedPose.eyeZ - prevPose.eyeZ;
      const tvX = dampedPose.targetX - prevPose.targetX;
      const tvY = dampedPose.targetY - prevPose.targetY;
      const tvZ = dampedPose.targetZ - prevPose.targetZ;

      eyeStepUu = Math.hypot(evX, evY, evZ);
      targetStepUu = Math.hypot(tvX, tvY, tvZ);
      rawEyeStepUu = Math.hypot(
        rawPose.eyeX - prevRawPose.eyeX,
        rawPose.eyeY - prevRawPose.eyeY,
        rawPose.eyeZ - prevRawPose.eyeZ,
      );
      rawTargetStepUu = Math.hypot(
        rawPose.targetX - prevRawPose.targetX,
        rawPose.targetY - prevRawPose.targetY,
        rawPose.targetZ - prevRawPose.targetZ,
      );
      yawStepDeg = wrapAngleDeltaDeg(dampedAngles.yawDeg, prevAngles.yawDeg);
      pitchStepDeg = dampedAngles.pitchDeg - prevAngles.pitchDeg;
      totalYawPathDeg += Math.abs(yawStepDeg);
      yawAccumDeg += yawStepDeg;
      if (yawAccumDeg < minYawAccumDeg) minYawAccumDeg = yawAccumDeg;
      if (yawAccumDeg > maxYawAccumDeg) maxYawAccumDeg = yawAccumDeg;

      if (prevEyeVel && prevTargetVel) {
        eyeAccelUu = Math.hypot(evX - prevEyeVel[0], evY - prevEyeVel[1], evZ - prevEyeVel[2]);
        targetAccelUu = Math.hypot(tvX - prevTargetVel[0], tvY - prevTargetVel[1], tvZ - prevTargetVel[2]);
      }

      prevEyeVel = [evX, evY, evZ];
      prevTargetVel = [tvX, tvY, tvZ];

      if (eyeStepUu > maxEyeStepUu) {
        maxEyeStepUu = eyeStepUu;
        anomalyPeaks.maxEyeStep = { valueUu: round3(eyeStepUu), replayFrameIndex: idx, frameId, timestampSec };
      }
      if (targetStepUu > maxTargetStepUu) maxTargetStepUu = targetStepUu;
      if (rawEyeStepUu > maxRawEyeStepUu) maxRawEyeStepUu = rawEyeStepUu;
      if (rawTargetStepUu > maxRawTargetStepUu) maxRawTargetStepUu = rawTargetStepUu;
      if (eyeAccelUu > maxEyeAccelUu) {
        maxEyeAccelUu = eyeAccelUu;
        anomalyPeaks.maxEyeAccel = { valueUu: round3(eyeAccelUu), replayFrameIndex: idx, frameId, timestampSec };
      }
      if (targetAccelUu > maxTargetAccelUu) maxTargetAccelUu = targetAccelUu;
      if (Math.abs(yawStepDeg) > maxYawStepDeg) {
        maxYawStepDeg = Math.abs(yawStepDeg);
        anomalyPeaks.maxYawStep = { valueDeg: round4(Math.abs(yawStepDeg)), replayFrameIndex: idx, frameId, timestampSec };
      }
    }

    prevPose = { ...dampedPose };
    prevRawPose = { ...rawPose };
    prevAngles = { ...dampedAngles };

    frames.push({
      frameId, replayFrameIndex: idx, timestampSec,
      progress: round4(progress), slowMoFactor: round3(slowMoFactor),
      isSelectedCursorFrame: idx === input.currentFrameIndex,
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
        smoothedStrikerPos: [
          round3(simDirectorState.smoothedCarX ?? 0),
          round3(simDirectorState.smoothedCarY ?? 0),
          round3(simDirectorState.smoothedCarZ ?? 0),
        ],
        carSwitchBlend: round4(simDirectorState.carSwitchBlend ?? 1.0),
        lateralBias: simDirectorState.lateralBias || 1.0,
      },
      cameraPose: {
        eyeUnreal: [round3(dampedPose.eyeX), round3(dampedPose.eyeY), round3(dampedPose.eyeZ)],
        targetUnreal: [round3(dampedPose.targetX), round3(dampedPose.targetY), round3(dampedPose.targetZ)],
        eyeThreeJs: [round3(dampedPose.eyeX), round3(dampedPose.eyeZ), round3(dampedPose.eyeY)],
        targetThreeJs: [round3(dampedPose.targetX), round3(dampedPose.targetZ), round3(dampedPose.targetY)],
        forwardUnreal: dampedAngles.forwardUnreal, distanceToTarget: dampedAngles.distanceToTarget,
        yawDeg: dampedAngles.yawDeg, pitchDeg: dampedAngles.pitchDeg,
        carViewAngleDeg, interceptorViewAngleDeg, ballViewAngleDeg,
        rawUndampedEyeUnreal: [round3(rawPose.eyeX), round3(rawPose.eyeY), round3(rawPose.eyeZ)],
        rawUndampedTargetUnreal: [round3(rawPose.targetX), round3(rawPose.targetY), round3(rawPose.targetZ)],
        rawDistanceToTarget: rawAngles.distanceToTarget, rawYawDeg: rawAngles.yawDeg, rawPitchDeg: rawAngles.pitchDeg,
        eyeStepUu: round3(eyeStepUu), targetStepUu: round3(targetStepUu),
        yawStepDeg: round4(yawStepDeg), pitchStepDeg: round4(pitchStepDeg),
        rawEyeStepUu: round3(rawEyeStepUu), rawTargetStepUu: round3(rawTargetStepUu),
        eyeAccelUu: round3(eyeAccelUu), targetAccelUu: round3(targetAccelUu),
      },
      ball: entities.ball, cars: entities.cars,
      incidents: Array.isArray(entry?.incidents) && entry.incidents.length > 0 ? entry.incidents : undefined,
    });
  }

  const touchEventsWithFrameIds: DirectorDiagnosticTouchTimelineEntry[] = (dState.touchEvents || []).map((t: ReplayTouchEvent) => {
    const fEntry = input.getFrameEntryByIndex(t.frameIndex);
    return {
      replayFrameIndex: t.frameIndex,
      frameId: fEntry?.tick ?? t.tick ?? (startFrameId + t.frameIndex),
      timestampSec: round3(t.frameIndex / REPLAY_TICK_RATE),
      carIndex: t.carIndex, team: t.team,
      ballPos: [round3(t.ballX), round3(t.ballY), round3(t.ballZ)],
    };
  });

  const lastTouchIdx = dState.lastScoringTouchFrameIdx ?? -1;
  const goalLineIdx = dState.goalLineFrameIdx ?? -1;

  const trajectorySmoothnessSummary = {
    totalFrames: total, durationSec: round3(total / REPLAY_TICK_RATE),
    startFrameId, endFrameId,
    maxEyeStepUu: round3(maxEyeStepUu), maxTargetStepUu: round3(maxTargetStepUu),
    maxRawEyeStepUu: round3(maxRawEyeStepUu), maxRawTargetStepUu: round3(maxRawTargetStepUu),
    maxEyeAccelUu: round3(maxEyeAccelUu), maxTargetAccelUu: round3(maxTargetAccelUu),
    maxYawStepDeg: round4(maxYawStepDeg), totalYawPathDeg: round3(totalYawPathDeg),
    netYawSpanDeg: round3(maxYawAccumDeg - minYawAccumDeg),
    maxPreGoalCarViewAngleDeg: round3(maxPreGoalCarViewAngleDeg),
    maxPreGoalBallViewAngleDeg: round3(maxPreGoalBallViewAngleDeg),
    maxInterceptorViewAngleDeg: round3(maxInterceptorViewAngleDeg),
    maxPostGoalCarViewAngleDeg: round3(maxPostGoalCarViewAngleDeg),
  };

  const currentSnapshot = buildCurrentFrameDiagnosticSnapshot({
    ...input, cachedSmoothnessSummary: trajectorySmoothnessSummary, cachedAnomalyPeaks: anomalyPeaks,
  });

  const payload = {
    schema: 'RocketCompanion.ReplayDirectorDiagnosticPattern.v1',
    exportedAt: new Date().toISOString(),
    coordinateConventions: {
      unreal: 'X right, Y forward (toward Orange goal +5120), Z up (Unreal Units)',
      threeJs: 'X right, Y up, Z forward',
    },
    replayMetadata: {
      tickRate: REPLAY_TICK_RATE, totalReplayFrames: total,
      durationSeconds: round3(total / REPLAY_TICK_RATE), startFrameId, endFrameId,
      scoringTeam: input.scoringTeam, scoringTeamName: input.scoringTeam === 0 ? 'BLUE' : 'ORANGE',
      scorerCarIndex: input.scorerCarIndex,
      lastScoringTouchReplayFrameIndex: lastTouchIdx,
      lastScoringTouchFrameId:
        lastTouchIdx >= 0 ? (input.getFrameEntryByIndex(lastTouchIdx)?.tick ?? (startFrameId + lastTouchIdx)) : -1,
      goalLineReplayFrameIndex: goalLineIdx,
      goalLineFrameId:
        goalLineIdx >= 0 ? (input.getFrameEntryByIndex(goalLineIdx)?.tick ?? (startFrameId + goalLineIdx)) : -1,
      trajectorySmoothnessSummary, anomalyPeaks,
      playbackStateAtExport: {
        selectedReplayFrameIndex: input.currentFrameIndex,
        selectedFrameId: currentSnapshot?.frameId ?? startFrameId,
        cursorFloat: round3(input.cursorFloat), progress: round4(input.progress),
        isPaused: input.isPaused, isPersistent: input.isPersistent,
        isScrubbing: input.isScrubbing, playbackSpeed: input.playbackSpeed,
      },
      ...(effectiveCarEntries ? { carEntries: effectiveCarEntries } : {}),
      ...(options.extraMetadata || {}),
    },
    directorConfig: { ...REPLAY_DIRECTOR_CONFIG },
    defaultDirectorConfig: { ...DEFAULT_REPLAY_DIRECTOR_CONFIG },
    touchTimeline: touchEventsWithFrameIds,
    selectedFrameDiagnostic: currentSnapshot,
    frames,
  };

  return { payload, trajectorySmoothnessSummary, anomalyPeaks };
}
