/**
 * ReplayDirectorGazeSolver.ts
 * Math primitives, arena boundary clamping, goal explosion detection, and Minimax Unit-Ray Bisector Gaze
 * solver for ReplayDirectorTrajectoryPlanner.
 */

import { SIM_OFFSETS } from '../physics/RocketSimConstants.ts';
import { REPLAY_DIRECTOR_CONFIG } from '../ui-core/config/replayDirectorConfig';
import {
  clamp,
  smoothstep,
  wrapAngleDeltaDeg,
  smooth1DZeroPhase,
  computeAdaptiveDirectorEyeHeight,
  clampPositionInsideArena,
  clampNonUpwardDirectorRay,
} from './replayDirectorElevationPipeline.ts';

export {
  clamp,
  smoothstep,
  wrapAngleDeltaDeg,
  smooth1DZeroPhase,
  computeAdaptiveDirectorEyeHeight,
  clampPositionInsideArena,
  clampNonUpwardDirectorRay,
};

const TICK_RATE = 120;

export interface ReplayTouchEvent {
  frameIndex: number;
  tick: number;
  carIndex: number;
  team: number;
  ballX: number;
  ballY: number;
  ballZ: number;
  isSaveAttempt?: boolean;
}

export interface PlannedDirectorCameraPose {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  rawEyeX: number;
  rawEyeY: number;
  rawEyeZ: number;
  rawTargetX: number;
  rawTargetY: number;
  rawTargetZ: number;
  activeTouchCarIndex: number;
  nextTouchCarIndex: number;
  nextTouchBlend: number;
  nextTouchBallPos: { x: number; y: number; z: number } | null;
  interceptorCarIndex: number;
  interceptorBlend: number;
  postGoalElapsedSec: number;
  smoothedCarX: number;
  smoothedCarY: number;
  smoothedCarZ: number;
  carSwitchBlend: number;
  lateralBias: number;
}

export interface SolveDirectorTrajectoryGazeInput {
  N: number;
  goalIdx: number;
  followTransSec: number;
  fullEyeX: Float64Array;
  fullEyeY: Float64Array;
  fullEyeZ: Float64Array;
  eyeXArr?: Float64Array;
  eyeYArr?: Float64Array;
  eyeZArr?: Float64Array;
  rawEyeXArr?: Float64Array;
  rawEyeYArr?: Float64Array;
  rawEyeZArr?: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  bz: Float64Array;
  gazeBallZ?: Float64Array;
  smScx: Float64Array;
  smScy: Float64Array;
  smScz: Float64Array;
  smOcx: Float64Array;
  smOcy: Float64Array;
  smOcz: Float64Array;
  smOppW: Float64Array;
  postShotBallFocus: Float64Array;
  activeScoreCar: Int32Array;
  nextScoreCar: Int32Array;
  nextTouchBlendArr: Float64Array;
  hasNextTouchBall: Uint8Array;
  nextTouchBallX: Float64Array;
  nextTouchBallY: Float64Array;
  nextTouchBallZ: Float64Array;
  activeOppCar: Int32Array;
  carSwitchBlendArr: Float64Array;
  resolvedLateralBias: number;
  scorerCarIdx: number;
  activeScoringTouches: ReplayTouchEvent[];
  oppTouches: ReplayTouchEvent[];
}

export interface SolveDirectorTrajectoryGazeResult {
  poses: PlannedDirectorCameraPose[];
  totalYawPathDeg: number;
  netYawSpanDeg: number;
  lateralBias: number;
  goalLineFrameIdx: number;
  scorerCarIndex: number;
  scoringTouches: ReplayTouchEvent[];
  oppTouches: ReplayTouchEvent[];
}

export interface GoalExplosionFrameSlotLike {
  snapshot?: ArrayLike<number> | null;
  incidents?: Array<{ type?: number }> | null;
  events?: Array<{ type?: number }> | null;
  signals?: Array<{ type?: number; signalType?: number }> | null;
}

export type GoalExplosionFrameInput = GoalExplosionFrameSlotLike | ArrayLike<number> | null | undefined;

/**
 * Resolves the exact frame index where the ball explodes in the goal.
 */
export function resolveGoalExplosionFrameIndex(
  frames: ReadonlyArray<GoalExplosionFrameInput>,
  goalSignY: number = 1.0,
  candidateIdx: number = -1
): number {
  const N = Array.isArray(frames) ? frames.length : 0;
  if (N === 0) return -1;

  let incidentGoalIdx = -1;
  let depth5210Idx = -1;
  let depth5120Idx = -1;
  let depth5100Idx = -1;

  const getSnap = (item: GoalExplosionFrameInput): ArrayLike<number> | null => {
    if (!item) return null;
    if ('snapshot' in item && item.snapshot) return item.snapshot;
    if ('length' in item && typeof item.length === 'number') return item;
    return null;
  };

  for (let i = 0; i < N; i++) {
    const entry = frames[i];
    if (!entry) continue;
    const snap = getSnap(entry);
    const ballY =
      snap && snap.length > SIM_OFFSETS.BALL + 1 ? (snap[SIM_OFFSETS.BALL + 1] || 0) : 0;
    const signedY = ballY * goalSignY;

    const slotEntry = 'snapshot' in entry || 'incidents' in entry || 'events' in entry || 'signals' in entry
      ? (entry as GoalExplosionFrameSlotLike)
      : null;

    const evList =
      slotEntry && Array.isArray(slotEntry.incidents) && slotEntry.incidents.length > 0
        ? slotEntry.incidents
        : slotEntry && Array.isArray(slotEntry.events)
          ? slotEntry.events
          : [];
    for (let j = 0; j < evList.length; j++) {
      const inc = evList[j];
      if (inc && (inc.type === 0x0e || inc.type === 14)) {
        incidentGoalIdx = i;
        break;
      }
    }
    if (incidentGoalIdx < 0 && slotEntry && Array.isArray(slotEntry.signals)) {
      for (let j = 0; j < slotEntry.signals.length; j++) {
        const sig = slotEntry.signals[j];
        if (sig && (sig.type === 0x91 || sig.type === 145)) {
          incidentGoalIdx = i;
          break;
        }
      }
    }

    if (depth5210Idx >= 0 && signedY < 5120.0) {
      depth5210Idx = -1;
    }
    if (depth5210Idx < 0 && signedY >= 5210.0) {
      depth5210Idx = i;
    }

    if (depth5120Idx >= 0 && signedY < 5040.0) {
      depth5120Idx = -1;
    }
    if (depth5120Idx < 0 && signedY >= 5120.0) {
      depth5120Idx = i;
    }

    if (depth5100Idx >= 0 && signedY < 5020.0) {
      depth5100Idx = -1;
    }
    if (depth5100Idx < 0 && signedY >= 5100.0) {
      depth5100Idx = i;
    }
  }

  const detectedIdx =
    incidentGoalIdx >= 0
      ? incidentGoalIdx
      : depth5210Idx >= 0
        ? depth5210Idx
        : depth5120Idx >= 0
          ? depth5120Idx
          : depth5100Idx;

  if (typeof candidateIdx === 'number' && candidateIdx >= 0 && candidateIdx < N) {
    if (detectedIdx >= 0 && candidateIdx < detectedIdx) {
      const candEntry = frames[candidateIdx];
      const candSnap = getSnap(candEntry);
      const candY =
        candSnap && candSnap.length > SIM_OFFSETS.BALL + 1
          ? (candSnap[SIM_OFFSETS.BALL + 1] || 0) * goalSignY
          : 0;
      if (candY < 5205.0) {
        return detectedIdx;
      }
    }
    return candidateIdx;
  }

  return detectedIdx;
}

/**
 * Solves causal eye damping, Minimax Unit-Ray Bisector Gaze over { Ball, Scoring Player, Opponent Interceptor },
 * yaw rotation budget smoothing (< 360°), and builds the per-frame Director Camera pose array.
 */
export function solveDirectorTrajectoryGazeAndPoses({
  N,
  goalIdx,
  followTransSec,
  fullEyeX,
  fullEyeY,
  fullEyeZ,
  eyeXArr: preEyeXArr,
  eyeYArr: preEyeYArr,
  eyeZArr: preEyeZArr,
  rawEyeXArr: preRawEyeXArr,
  rawEyeYArr: preRawEyeYArr,
  rawEyeZArr: preRawEyeZArr,
  bx,
  by,
  bz,
  gazeBallZ,
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
  resolvedLateralBias,
  scorerCarIdx,
  activeScoringTouches,
  oppTouches,
}: SolveDirectorTrajectoryGazeInput): SolveDirectorTrajectoryGazeResult {
  // Smooth eye across the goal-line transition so post-goal pullback has zero acceleration spike
  const rawEyeXArr = preRawEyeXArr || smooth1DZeroPhase(fullEyeX, 0.14, 2);
  const rawEyeYArr = preRawEyeYArr || smooth1DZeroPhase(fullEyeY, 0.14, 2);
  const rawEyeZArr = preRawEyeZArr || smooth1DZeroPhase(fullEyeZ, 0.14, 2);

  const eyeRate = clamp(REPLAY_DIRECTOR_CONFIG.eyeDampingRate ?? 5.2, 0.8, 25.0);
  const eyeAlpha = 1.0 - Math.exp(-(1 / TICK_RATE) * (eyeRate * 2.4));

  // Apply causal eye damping governed by eyeDampingRate on top of the planned trajectory
  let eyeXArr = preEyeXArr;
  let eyeYArr = preEyeYArr;
  let eyeZArr = preEyeZArr;
  if (!eyeXArr || !eyeYArr || !eyeZArr) {
    eyeXArr = new Float64Array(N);
    eyeYArr = new Float64Array(N);
    eyeZArr = new Float64Array(N);
    eyeXArr[0] = rawEyeXArr[0];
    eyeYArr[0] = rawEyeYArr[0];
    eyeZArr[0] = rawEyeZArr[0];
    for (let i = 1; i < N; i++) {
      const cl = clampPositionInsideArena(
        eyeXArr[i - 1] + (rawEyeXArr[i] - eyeXArr[i - 1]) * eyeAlpha,
        eyeYArr[i - 1] + (rawEyeYArr[i] - eyeYArr[i - 1]) * eyeAlpha,
        eyeZArr[i - 1] + (rawEyeZArr[i] - eyeZArr[i - 1]) * eyeAlpha
      );
      eyeXArr[i] = cl.x;
      eyeYArr[i] = cl.y;
      eyeZArr[i] = cl.z;
    }
  }

  // Phase-match the bounce-bridged ball gaze Z with the same smoothing and causal filter as eyeZArr
  // so vertical velocity changes during climbs/descents never induce pitch lag oscillations.
  const baseGazeBallZ = smooth1DZeroPhase(smooth1DZeroPhase(gazeBallZ || bz, 0.14, 2), 0.14, 2);
  const dampedGazeBallZ = new Float64Array(N);
  if (N > 0) {
    dampedGazeBallZ[0] = baseGazeBallZ[0];
    for (let i = 1; i < N; i++) {
      dampedGazeBallZ[i] =
        dampedGazeBallZ[i - 1] + (baseGazeBallZ[i] - dampedGazeBallZ[i - 1]) * eyeAlpha;
    }
  }

  // Minimax Unit-Ray Bisector Gaze over { Ball(t), Mandatory Next Scoring Player C_score(t), Opponent Interceptor C_opp(t) }
  const baseCarWeight = clamp(REPLAY_DIRECTOR_CONFIG.carMidpointMaxWeight ?? 0.46, 0.15, 0.80);
  const rawDirX = new Float64Array(N);
  const rawDirY = new Float64Array(N);
  const rawDirZ = new Float64Array(N);
  const rawDistArr = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    const ex = eyeXArr[i];
    const ey = eyeYArr[i];
    const ez = eyeZArr[i];

    // Bounce-smoothed, non-upward ball ray (stays level pitch <= 0° even on ceiling balls)
    const vbx = bx[i] - ex;
    const vby = by[i] - ey;
    const targetBallZ = clamp(dampedGazeBallZ[i], 75.0, 1960.0);
    const vbz = Math.min(0.0, targetBallZ - ez);
    const db = Math.hypot(vbx, vby, vbz) || 1.0;
    const ubx = vbx / db;
    const uby = vby / db;
    const ubz = vbz / db;

    // Mandatory scoring player ray (non-upward)
    const vsx = smScx[i] - ex;
    const vsy = smScy[i] - ey;
    const vsz = Math.min(0.0, clamp(smScz[i] + 24.0, 75.0, 1840.0) - ez);
    const ds = Math.hypot(vsx, vsy, vsz) || 1.0;
    const usx = vsx / ds;
    const usy = vsy / ds;
    const usz = vsz / ds;

    // Opponent interceptor ray (when active, non-upward)
    const ow = smOppW[i];
    const vox = smOcx[i] - ex;
    const voy = smOcy[i] - ey;
    const voz = Math.min(0.0, clamp(smOcz[i] + 24.0, 75.0, 1840.0) - ez);
    const doDist = Math.hypot(vox, voy, voz) || 1.0;
    const uox = vox / doDist;
    const uoy = voy / doDist;
    const uoz = voz / doDist;

    // Combine scoring player ray and opponent interceptor ray into composite car ray
    const scorerActiveShare = i <= goalIdx ? 1.0 - postShotBallFocus[i] : 1.0;
    const oppShare =
      i <= goalIdx
        ? scorerActiveShare > 1e-3
          ? (ow * 0.42) / Math.max(0.25, scorerActiveShare + ow * 0.42)
          : clamp(ow * 0.65, 0, 1)
        : 0.0;
    let ucx = usx * (1 - oppShare) + uox * oppShare;
    let ucy = usy * (1 - oppShare) + uoy * oppShare;
    let ucz = usz * (1 - oppShare) + uoz * oppShare;
    const ucNorm = Math.hypot(ucx, ucy, ucz) || 1.0;
    ucx /= ucNorm;
    ucy /= ucNorm;
    ucz /= ucNorm;

    const postSec = i > goalIdx ? (i - goalIdx) / TICK_RATE : 0.0;
    const postFollow = smoothstep(0.0, followTransSec * 1.4, postSec);

    // Angular separation between Ball ray and Car ray
    const dotBC = clamp(ubx * ucx + uby * ucy + ubz * ucz, -1.0, 1.0);
    const angleBC = (Math.acos(dotBC) * 180.0) / Math.PI;
    const activePreCarShare = Math.max(scorerActiveShare, ow * 0.55);
    const rawPreCarW = baseCarWeight * activePreCarShare;
    const maxAllowedPreCarW = 14.0 / Math.max(14.0, angleBC);
    const preCarW = Math.min(rawPreCarW, maxAllowedPreCarW);
    const carRayW = preCarW * (1.0 - postFollow) + 0.88 * postFollow;
    const ballRayW = 1.0 - carRayW;

    const mx = ubx * ballRayW + ucx * carRayW;
    const my = uby * ballRayW + ucy * carRayW;
    const mz = ubz * ballRayW + ucz * carRayW;
    const [clampedMx, clampedMy, clampedMz] = clampNonUpwardDirectorRay(mx, my, mz, 0.0);

    rawDirX[i] = clampedMx;
    rawDirY[i] = clampedMy;
    rawDirZ[i] = clampedMz;
    rawDistArr[i] = Math.pow(db, ballRayW) * Math.pow(ds, carRayW);
  }

  // Smooth gaze unit vector and enforce strict total yaw rotation budget (< 360°)
  const gazeRate = clamp(REPLAY_DIRECTOR_CONFIG.gazeDampingRate ?? 8.5, 1.0, 30.0);
  const baseGazeAlpha = clamp(gazeRate / 70.0, 0.04, 0.28);
  const pitchGazeAlpha = clamp(baseGazeAlpha * 0.52, 0.028, 0.085);
  const maxYawBudget = clamp(REPLAY_DIRECTOR_CONFIG.maxTotalYawBudgetDeg ?? 320.0, 90.0, 355.0);

  let smDirX = smooth1DZeroPhase(rawDirX, baseGazeAlpha, 2);
  let smDirY = smooth1DZeroPhase(rawDirY, baseGazeAlpha, 2);
  let smDirZ = smooth1DZeroPhase(rawDirZ, pitchGazeAlpha, 4);
  const smDist = smooth1DZeroPhase(rawDistArr, 0.14, 2);

  const computeTotalYawPath = (dxArr: Float64Array, dyArr: Float64Array) => {
    let sumYaw = 0;
    let prevYaw = (Math.atan2(dxArr[0], dyArr[0]) * 180.0) / Math.PI;
    let minY = prevYaw;
    let maxY = prevYaw;
    let accYaw = prevYaw;
    for (let i = 1; i < N; i++) {
      const y = (Math.atan2(dxArr[i], dyArr[i]) * 180.0) / Math.PI;
      const d = wrapAngleDeltaDeg(y, prevYaw);
      sumYaw += Math.abs(d);
      accYaw += d;
      if (accYaw < minY) minY = accYaw;
      if (accYaw > maxY) maxY = accYaw;
      prevYaw = y;
    }
    return { totalYawPathDeg: sumYaw, netYawSpanDeg: maxY - minY };
  };

  let yawStats = computeTotalYawPath(smDirX, smDirY);
  let extraSmoothIter = 0;
  while (yawStats.totalYawPathDeg > maxYawBudget && extraSmoothIter < 6) {
    smDirX = smooth1DZeroPhase(smDirX, 0.08, 2);
    smDirY = smooth1DZeroPhase(smDirY, 0.08, 2);
    smDirZ = smooth1DZeroPhase(smDirZ, 0.06, 2);
    yawStats = computeTotalYawPath(smDirX, smDirY);
    extraSmoothIter++;
  }

  const poses: PlannedDirectorCameraPose[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const [rDx, rDy, rDz] = clampNonUpwardDirectorRay(rawDirX[i], rawDirY[i], rawDirZ[i], 0.0);
    const rDist = rawDistArr[i];
    const rtx = rawEyeXArr[i] + rDx * rDist;
    const rty = rawEyeYArr[i] + rDy * rDist;
    const rtz = clamp(rawEyeZArr[i] + rDz * rDist, 75.0, 1980.0);

    const [sDx, sDy, sDz] = clampNonUpwardDirectorRay(smDirX[i], smDirY[i], smDirZ[i], 0.0);
    const dist = smDist[i];
    const tx = eyeXArr[i] + sDx * dist;
    const ty = eyeYArr[i] + sDy * dist;
    const tz = clamp(eyeZArr[i] + sDz * dist, 75.0, 1980.0);

    poses[i] = {
      eyeX: eyeXArr[i],
      eyeY: eyeYArr[i],
      eyeZ: eyeZArr[i],
      targetX: tx,
      targetY: ty,
      targetZ: tz,
      rawEyeX: rawEyeXArr[i],
      rawEyeY: rawEyeYArr[i],
      rawEyeZ: rawEyeZArr[i],
      rawTargetX: rtx,
      rawTargetY: rty,
      rawTargetZ: rtz,
      activeTouchCarIndex: activeScoreCar[i],
      nextTouchCarIndex: nextScoreCar[i],
      nextTouchBlend: nextTouchBlendArr[i],
      nextTouchBallPos: hasNextTouchBall[i]
        ? { x: nextTouchBallX[i], y: nextTouchBallY[i], z: nextTouchBallZ[i] }
        : null,
      interceptorCarIndex: activeOppCar[i],
      interceptorBlend: smOppW[i],
      postGoalElapsedSec: i > goalIdx ? (i - goalIdx) / TICK_RATE : 0,
      smoothedCarX: smScx[i],
      smoothedCarY: smScy[i],
      smoothedCarZ: smScz[i],
      carSwitchBlend: carSwitchBlendArr[i],
      lateralBias: resolvedLateralBias,
    };
  }

  return {
    poses,
    totalYawPathDeg: yawStats.totalYawPathDeg,
    netYawSpanDeg: yawStats.netYawSpanDeg,
    lateralBias: resolvedLateralBias,
    goalLineFrameIdx: goalIdx,
    scorerCarIndex: scorerCarIdx,
    scoringTouches: activeScoringTouches,
    oppTouches,
  };
}

