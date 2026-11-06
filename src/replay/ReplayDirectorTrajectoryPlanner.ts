/**
 * ReplayDirectorTrajectoryPlanner.ts
 * Offline full-trajectory Suffix Safe-Zone & Progressive Point Elimination planner
 * for Rocket League Goal Replay Director Camera.
 */

import { REPLAY_DIRECTOR_CONFIG } from '../ui-core/config/replayDirectorConfig';

import {
  clamp,
  smoothstep,
  smooth1DZeroPhase,
  computeAdaptiveDirectorEyeHeight,
  clampPositionInsideArena,
  resolveGoalExplosionFrameIndex,
  solveDirectorTrajectoryGazeAndPoses,
  type ReplayTouchEvent,
  type GoalExplosionFrameInput,
  type SolveDirectorTrajectoryGazeResult,
} from './ReplayDirectorGazeSolver.ts';
import {
  buildDirectorSubjectAnchors,
  type BuildDirectorSubjectAnchorsOptions,
} from './replayDirectorSubjectAnchorPipeline.ts';

export {
  clamp,
  smoothstep,
  computeAdaptiveDirectorEyeHeight,
  clampPositionInsideArena,
  resolveGoalExplosionFrameIndex,
};

export type SuffixDirectorTrajectoryPlan = SolveDirectorTrajectoryGazeResult;

export type BuildSuffixSafeDirectorTrajectoryOptions = BuildDirectorSubjectAnchorsOptions;

const TICK_RATE = 120;

/**
 * Builds the full-window Suffix Safe-Zone Backward-Planned Camera Trajectory across all frames [0 .. N-1].
 */
export function buildSuffixSafeDirectorTrajectory(
  frames: ReadonlyArray<GoalExplosionFrameInput>,
  options: BuildSuffixSafeDirectorTrajectoryOptions = {}
): SuffixDirectorTrajectoryPlan | null {
  const anchors = buildDirectorSubjectAnchors(frames, options);
  if (!anchors) return null;

  const {
    N,
    goalIdx,
    goalSignY,
    goalY,
    scorerCarIdx,
    activeScoringTouches,
    oppTouches,
    bx,
    by,
    bz,
    sbx,
    sby,
    gazeEnvelopeZ,
    eyeEnvelopeZ,
    bouncePullbackUu,
    smScx,
    smScy,
    smScz,
    smOcx,
    smOcy,
    smOcz,
    smOppW,
    postShotBallFocus,
    activeScoreCar,
    nextScoreCar,
    nextTouchBlendArr,
    hasNextTouchBall,
    nextTouchBallX,
    nextTouchBallY,
    nextTouchBallZ,
    activeOppCar,
    carSwitchBlendArr,
    ux,
    uy,
    wxAxis,
    wyAxis,
    resolvedLateralBias,
  } = anchors;

  const backStart = clamp(REPLAY_DIRECTOR_CONFIG.corridorBackDistStart ?? 500.0, 240.0, 1600.0);
  const backEnd = clamp(REPLAY_DIRECTOR_CONFIG.corridorBackDistEnd ?? 400.0, 200.0, 1500.0);
  const sideBase = clamp(REPLAY_DIRECTOR_CONFIG.corridorSideDistBase ?? 760.0, 120.0, 1400.0);
  const showcaseDist = clamp(REPLAY_DIRECTOR_CONFIG.goalBoxShowcaseDist ?? 920.0, 420.0, 1800.0);
  const baseHeightUu = clamp(REPLAY_DIRECTOR_CONFIG.cameraBaseHeightUu ?? 195.0, 145.0, 520.0);
  const aerialSlope = clamp(REPLAY_DIRECTOR_CONFIG.cameraAerialHeightSlope ?? 0.36, 0.10, 0.85);
  const suffixDecay = clamp(REPLAY_DIRECTOR_CONFIG.suffixTimeDecayRate ?? 1.40, 0.25, 4.0);
  const smoothPasses = Math.round(clamp(REPLAY_DIRECTOR_CONFIG.trajectorySmoothPasses ?? 4, 1, 8));

  // Project active subjects { Ball(t), C_score(t), C_opp(t) } onto (U, W) and compute oblique side-rear requirements
  const reqRearU = new Float64Array(goalIdx + 1);
  const reqLatV = new Float64Array(goalIdx + 1);
  const reqEyeZ = new Float64Array(goalIdx + 1);

  for (let i = 0; i <= goalIdx; i++) {
    const prog = goalIdx > 0 ? i / goalIdx : 1.0;
    const bu = sbx[i] * ux + sby[i] * uy;
    const bv = sbx[i] * wxAxis + sby[i] * wyAxis;

    const su = smScx[i] * ux + smScy[i] * uy;
    const sv = smScx[i] * wxAxis + smScy[i] * wyAxis;

    const ou = smOcx[i] * ux + smOcy[i] * uy;
    const ov = smOcx[i] * wxAxis + smOcy[i] * wyAxis;
    const ow = smOppW[i];
    const scorerActiveShare = 1.0 - postShotBallFocus[i];

    // Rearmost subject along U among { Ball, Scoring Player, Opponent Interceptor }
    let minSubU = Math.min(bu, su);
    if (ow > 0.05) {
      const oppRearU = ou * ow + minSubU * (1.0 - ow);
      minSubU = Math.min(minSubU, oppRearU);
    }

    // Subject lateral spread so wide passes, side touches, or opponent interceptions widen camera pullback
    const maxLatV = Math.max(bv, sv, ow > 0.1 ? ov : bv);
    const minLatV = Math.min(bv, sv, ow > 0.1 ? ov : bv);
    const latSpread = maxLatV - minLatV;
    const activeCarBallLatSpread = Math.abs(sv - bv) * scorerActiveShare;
    const longSpread = Math.max(bu, su, ow > 0.1 ? ou : bu) - minSubU;

    // Overhead-biased active height from bounce-bridged envelope so eyeZ stays slightly above the ball
    const activeZ = Math.max(
      eyeEnvelopeZ[i],
      smScz[i] * scorerActiveShare,
      ow > 0.15 ? smOcz[i] : 0
    );
    const aerialBlend = smoothstep(220.0, 680.0, activeZ);
    const vertSpread = Math.abs(eyeEnvelopeZ[i] - smScz[i]) * scorerActiveShare;
    const aerialPullback =
      aerialBlend * 115.0 +
      Math.min(450.0, vertSpread) * 0.14 +
      bouncePullbackUu[i];

    // Moderate longitudinal distance behind minSubU, pulling back extra when car approaches from a wide side angle
    const trailBack =
      (backStart - prog * (backStart - backEnd)) * 0.72 +
      latSpread * 0.12 +
      activeCarBallLatSpread * 0.28 +
      Math.min(500.0, longSpread) * 0.06 +
      aerialPullback * 0.65;
    reqRearU[i] = minSubU - trailBack;

    // Oblique side-rear lateral offset: centers between car and ball during wide side approaches
    const centerV = bv * 0.52 + sv * (0.48 - 0.18 * ow) + ov * (0.18 * ow);
    const interiorSubV =
      Math.max(
        bv * resolvedLateralBias,
        sv * resolvedLateralBias,
        ow > 0.15 ? ov * resolvedLateralBias : -1e9
      ) * resolvedLateralBias;
    const wideApproachCenterBlend = smoothstep(350.0, 1400.0, activeCarBallLatSpread) * 0.35;
    const baseLatV =
      (0.50 + wideApproachCenterBlend) * centerV +
      (0.50 - wideApproachCenterBlend) * interiorSubV;
    const wallProx = smoothstep(2200.0, 3800.0, Math.max(Math.abs(sbx[i]), Math.abs(smScx[i])));
    const wallClimbClearance = wallProx * (180.0 + 200.0 * smoothstep(140.0, 820.0, activeZ));
    const sideOffset =
      (sideBase * (1.0 - 0.12 * prog) + wallClimbClearance + aerialPullback * 0.55) *
      resolvedLateralBias;
    reqLatV[i] = baseLatV + sideOffset;

    // Overhead Adaptive Camera Height: stays slightly above the bounce-bridged ball envelope
    // so the camera avoids looking upward, tapering smoothly inside the 2044 UU ceiling.
    reqEyeZ[i] = computeAdaptiveDirectorEyeHeight(activeZ, baseHeightUu, aerialSlope, latSpread);
  }

  // Suffix Safe-Zone Backward Deduction from T_goal down to 0 with a bounded longitudinal leash
  // so opening reverse/side touches never strand the camera anchor far away from the play.
  const goalMouthMaxU = 0.0 * ux + (goalY - goalSignY * Math.min(showcaseDist * 0.72, 740.0)) * uy;
  const safeSuffixU = new Float64Array(goalIdx + 1);
  safeSuffixU[goalIdx] = Math.min(reqRearU[goalIdx], goalMouthMaxU);

  const decayReleasePerTick = Math.max(0.15, (suffixDecay - 0.75) * 0.65);
  const maxSuffixLeashUu = 720.0;
  for (let i = goalIdx - 1; i >= 0; i--) {
    const targetU = Math.min(reqRearU[i], goalMouthMaxU);
    const backwardBound = safeSuffixU[i + 1] + decayReleasePerTick;
    safeSuffixU[i] = clamp(backwardBound, targetU - maxSuffixLeashUu, targetU);
  }

  // Blend Suffix Safe-Zone envelope with local requirement while staying strictly <= targetU
  const rawPreU = new Float64Array(goalIdx + 1);
  const blendLocal = clamp(0.16 * suffixDecay, 0.05, 0.38);
  for (let i = 0; i <= goalIdx; i++) {
    const targetU = Math.min(reqRearU[i], goalMouthMaxU);
    rawPreU[i] = safeSuffixU[i] * (1.0 - blendLocal) + targetU * blendLocal;
  }

  // Preserve full oblique lateral offset across the pre-goal window without pulling inward toward goal center
  const rawPreV = new Float64Array(goalIdx + 1);
  for (let i = 0; i <= goalIdx; i++) {
    rawPreV[i] = reqLatV[i];
  }

  const smoothPreU = smooth1DZeroPhase(rawPreU, 0.045, smoothPasses);
  const smoothPreV = smooth1DZeroPhase(rawPreV, 0.045, smoothPasses);
  const smoothPreZ = smooth1DZeroPhase(reqEyeZ, 0.14, 2);

  // Assemble full [0 .. N-1] eye trajectory (Pre-Goal Suffix Safe-Zone + Post-Goal Celebration Stretch)
  const fullEyeX = new Float64Array(N);
  const fullEyeY = new Float64Array(N);
  const fullEyeZ = new Float64Array(N);

  for (let i = 0; i <= goalIdx; i++) {
    const ex = smoothPreU[i] * ux + smoothPreV[i] * wxAxis;
    const ey = smoothPreU[i] * uy + smoothPreV[i] * wyAxis;
    const ez = smoothPreZ[i];
    const cl = clampPositionInsideArena(ex, ey, ez);
    fullEyeX[i] = cl.x;
    fullEyeY[i] = cl.y;
    fullEyeZ[i] = cl.z;
  }

  const goalEyeX = fullEyeX[goalIdx];
  const goalEyeY = fullEyeY[goalIdx];
  const goalEyeZ = fullEyeZ[goalIdx];
  const stretchDist = clamp(REPLAY_DIRECTOR_CONFIG.postGoalExplosionStretchDist ?? 780.0, 0.0, 2000.0);
  const stretchDur = Math.max(0.1, REPLAY_DIRECTOR_CONFIG.postGoalExplosionStretchDuration ?? 0.36);
  const followTransSec = Math.max(
    0.08,
    REPLAY_DIRECTOR_CONFIG.postGoalScorerFollowTransitionSec ?? 0.28
  );

  for (let i = goalIdx + 1; i < N; i++) {
    const postSec = (i - goalIdx) / TICK_RATE;
    const stretchU = clamp(postSec / stretchDur, 0, 1);
    const stretch = stretchU * stretchU * (3 - 2 * stretchU);
    const followW = smoothstep(0.0, followTransSec * 1.6, postSec);

    const sx = smScx[i];
    const sy = smScy[i];
    const sz = smScz[i];

    const postBackDist = 540.0 + stretch * (stretchDist * 0.65);
    const postSideOffset = wxAxis * (sideBase * 0.55 * resolvedLateralBias);
    const followX = clamp(sx * 0.72 + postSideOffset, -3200.0, 3200.0);
    const followY = Math.min(
      goalEyeY * goalSignY,
      (sy - goalSignY * postBackDist) * goalSignY
    ) * goalSignY;
    const followZ = clamp(goalEyeZ + stretch * 85.0 + Math.max(0, sz - 40.0) * 0.28, 165.0, 1840.0);

    const cl = clampPositionInsideArena(
      goalEyeX * (1 - followW) + followX * followW,
      goalEyeY * (1 - followW) + followY * followW,
      goalEyeZ * (1 - followW) + followZ * followW
    );
    fullEyeX[i] = cl.x;
    fullEyeY[i] = cl.y;
    fullEyeZ[i] = cl.z;
  }

  return solveDirectorTrajectoryGazeAndPoses({
    N,
    goalIdx,
    followTransSec,
    fullEyeX,
    fullEyeY,
    fullEyeZ,
    resolvedLateralBias,
    scorerCarIdx,
    activeScoringTouches,
    oppTouches,
    bx,
    by,
    bz,
    gazeBallZ: gazeEnvelopeZ,
    smScx,
    smScy,
    smScz,
    smOcx,
    smOcy,
    smOcz,
    smOppW,
    postShotBallFocus,
    activeScoreCar,
    nextScoreCar,
    nextTouchBlendArr,
    hasNextTouchBall,
    nextTouchBallX,
    nextTouchBallY,
    nextTouchBallZ,
    activeOppCar,
    carSwitchBlendArr,
  });
}
