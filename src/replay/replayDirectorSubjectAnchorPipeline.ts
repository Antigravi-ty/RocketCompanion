/**
 * replayDirectorSubjectAnchorPipeline.ts
 * Pure narrow-input pipeline for extracting and smoothing ball/car trajectories and building
 * per-frame Mandatory Next Scoring Player, Handoff Anticipation, Post-Touch Showcase, and
 * Opponent Interceptor subject anchors.
 */

import {
  SIM_OFFSETS,
  BALL_STATE_STRIDE,
  CAR_STATE_STRIDE,
  MAX_CARS,
} from '../physics/RocketSimConstants.ts';
import { REPLAY_DIRECTOR_CONFIG } from '../ui-core/config/replayDirectorConfig.ts';
import {
  resolveGoalExplosionFrameIndex,
  type ReplayTouchEvent,
  type GoalExplosionFrameInput,
} from './ReplayDirectorGazeSolver.ts';
import {
  clamp,
  smooth1DZeroPhase,
  computeBounceBridgedBallTrajectory,
  resolveBalancedLateralBias,
} from './replayDirectorElevationPipeline.ts';

const TICK_RATE = 120;

export interface BuildDirectorSubjectAnchorsOptions {
  scoringTeam?: number;
  scorerCarIndex?: number;
  goalLineFrameIdx?: number;
  touchEvents?: ReplayTouchEvent[];
  carTeamResolver?: (carIndex: number) => number;
  lateralBias?: number;
  initialSettledCarPos?: { carIndex?: number; x: number; y: number; z: number } | null;
}

export interface DirectorSubjectAnchorsResult {
  N: number;
  goalIdx: number;
  goalSignY: number;
  goalY: number;
  holdTicks: number;
  scorerCarIdx: number;
  lastScoreTouchFrame: number;
  openSideX: number;
  activeScoringTouches: ReplayTouchEvent[];
  oppTouches: ReplayTouchEvent[];
  bx: Float64Array;
  by: Float64Array;
  bz: Float64Array;
  sbx: Float64Array;
  sby: Float64Array;
  sbz: Float64Array;
  gazeEnvelopeZ: Float64Array;
  eyeEnvelopeZ: Float64Array;
  bouncePullbackUu: Float64Array;
  smScx: Float64Array;
  smScy: Float64Array;
  smScz: Float64Array;
  lastScorerX: Float64Array;
  lastScorerY: Float64Array;
  lastScorerZ: Float64Array;
  handoffArcWArr: Float64Array;
  handoffZLiftArr: Float64Array;
  oppChallengeWArr: Float64Array;
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
  ux: number;
  uy: number;
  wxAxis: number;
  wyAxis: number;
  resolvedLateralBias: number;
}

function getFrameSnap(item: GoalExplosionFrameInput): ArrayLike<number> | null {
  if (!item) return null;
  if ('snapshot' in item && item.snapshot) return item.snapshot;
  if ('length' in item && typeof item.length === 'number') return item;
  return null;
}

export function buildDirectorSubjectAnchors(
  frames: ReadonlyArray<GoalExplosionFrameInput>,
  options: BuildDirectorSubjectAnchorsOptions = {}
): DirectorSubjectAnchorsResult | null {
  const N = Array.isArray(frames) ? frames.length : 0;
  if (N === 0) return null;

  const scoringTeam = options.scoringTeam ?? 0;
  const goalSignY = scoringTeam === 0 ? 1.0 : -1.0;
  const goalY = goalSignY * 5120.0;
  const fallbackScorer =
    typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0
      ? options.scorerCarIndex
      : 0;

  const firstSnap = getFrameSnap(frames[0]);
  const numCars = Math.min(
    MAX_CARS,
    Math.max(1, Math.round(firstSnap?.[SIM_OFFSETS.NUM_CARS] || 1))
  );

  const bx = new Float64Array(N);
  const by = new Float64Array(N);
  const bz = new Float64Array(N);
  const bvx = new Float64Array(N);
  const bvy = new Float64Array(N);
  const bvz = new Float64Array(N);

  const cx: Float64Array[] = Array.from({ length: numCars }, () => new Float64Array(N));
  const cy: Float64Array[] = Array.from({ length: numCars }, () => new Float64Array(N));
  const cz: Float64Array[] = Array.from({ length: numCars }, () => new Float64Array(N));

  let resolvedGoalIdx = resolveGoalExplosionFrameIndex(
    frames,
    goalSignY,
    typeof options.goalLineFrameIdx === 'number' ? options.goalLineFrameIdx : -1
  );

  for (let i = 0; i < N; i++) {
    const snap = getFrameSnap(frames[i]);
    if (!snap || snap.length < SIM_OFFSETS.BALL + BALL_STATE_STRIDE) continue;
    bx[i] = snap[SIM_OFFSETS.BALL] || 0;
    by[i] = snap[SIM_OFFSETS.BALL + 1] || 0;
    bz[i] = snap[SIM_OFFSETS.BALL + 2] || 93;
    bvx[i] = snap[SIM_OFFSETS.BALL + 12] || 0;
    bvy[i] = snap[SIM_OFFSETS.BALL + 13] || 0;
    bvz[i] = snap[SIM_OFFSETS.BALL + 14] || 0;

    for (let c = 0; c < numCars; c++) {
      const base = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      if (snap.length < base + 15) continue;
      cx[c][i] = snap[base] || 0;
      cy[c][i] = snap[base + 1] || 0;
      cz[c][i] = snap[base + 2] || 17;
    }
  }

  if (resolvedGoalIdx < 0) {
    resolvedGoalIdx = Math.max(0, N - 1);
  }
  const goalIdx = clamp(resolvedGoalIdx, 0, N - 1);

  // Eliminate any initial 1-3 frame spawn/kickoff teleports in car trajectories
  const settledCheckMax = Math.min(N - 1, 3);
  for (let c = 0; c < numCars; c++) {
    for (let idx = settledCheckMax; idx >= 1; idx--) {
      const step = Math.hypot(
        cx[c][idx] - cx[c][idx - 1],
        cy[c][idx] - cy[c][idx - 1],
        cz[c][idx] - cz[c][idx - 1]
      );
      if (step > 180.0) {
        for (let k = 0; k < idx; k++) {
          cx[c][k] = cx[c][idx];
          cy[c][k] = cy[c][idx];
          cz[c][k] = cz[c][idx];
        }
        break;
      }
    }
    cx[c] = smooth1DZeroPhase(cx[c], 0.22, 2);
    cy[c] = smooth1DZeroPhase(cy[c], 0.22, 2);
    cz[c] = smooth1DZeroPhase(cz[c], 0.18, 2);
  }

  const sbx = smooth1DZeroPhase(bx, 0.18, 2);
  const sby = smooth1DZeroPhase(by, 0.18, 2);
  const sbz = smooth1DZeroPhase(bz, 0.16, 2);
  const bounceEnv = computeBounceBridgedBallTrajectory(bz, bvz, goalIdx);
  const { gazeEnvelopeZ, eyeEnvelopeZ, bouncePullbackUu } = bounceEnv;

  // Separate touch events into Scoring-Team Touches vs Opponent Interceptions/Challenges
  const rawTouches: ReplayTouchEvent[] = Array.isArray(options.touchEvents)
    ? options.touchEvents
    : [];
  const touchTeamByCar = new Map<number, number>();
  for (let i = 0; i < rawTouches.length; i++) {
    const t = rawTouches[i];
    if (t && typeof t.carIndex === 'number' && typeof t.team === 'number') {
      touchTeamByCar.set(t.carIndex, t.team);
    }
  }
  const resolveCarTeam = (c: number): number => {
    if (typeof options.carTeamResolver === 'function') {
      return options.carTeamResolver(c);
    }
    const recorded = touchTeamByCar.get(c);
    return typeof recorded === 'number' ? recorded : c % 2;
  };

  const preGoalTouches = rawTouches.filter((t) => t && t.frameIndex <= goalIdx + 8);
  const scoringTouches = preGoalTouches.filter((t) => t.team === scoringTeam);
  const activeScoringTouches: ReplayTouchEvent[] =
    scoringTouches.length > 0
      ? scoringTouches
      : preGoalTouches.length > 0
        ? preGoalTouches
        : [
            {
              frameIndex: goalIdx,
              tick: goalIdx,
              carIndex: clamp(fallbackScorer, 0, numCars - 1),
              team: scoringTeam,
              ballX: bx[goalIdx],
              ballY: by[goalIdx],
              ballZ: bz[goalIdx],
            },
          ];

  const scorerCarIdx = clamp(
    activeScoringTouches[activeScoringTouches.length - 1]?.carIndex ?? fallbackScorer,
    0,
    numCars - 1
  );

  // Opponent interceptions: any opponent touch after the opening 12 frames (or close defensive save challenge)
  const oppTouches: ReplayTouchEvent[] = preGoalTouches
    .filter((t) => t.team !== scoringTeam && t.frameIndex > 12 && t.frameIndex <= goalIdx + 2)
    .map((t) => ({ ...t }));

  const firstScoreTouchFrame = Math.max(12, (activeScoringTouches[0]?.frameIndex ?? 0) - 30);
  for (let c = 0; c < numCars; c++) {
    if (resolveCarTeam(c) === scoringTeam) continue;
    let minD = 310.0;
    let bestF = -1;
    for (let i = firstScoreTouchFrame; i <= goalIdx; i++) {
      const d = Math.hypot(cx[c][i] - bx[i], cy[c][i] - by[i], cz[c][i] - bz[i]);
      if (d < minD) {
        minD = d;
        bestF = i;
      }
    }
    if (
      bestF >= 0 &&
      !oppTouches.some((ot) => ot.carIndex === c && Math.abs(ot.frameIndex - bestF) < 75)
    ) {
      oppTouches.push({
        frameIndex: bestF,
        tick: bestF,
        carIndex: c,
        team: resolveCarTeam(c),
        ballX: bx[bestF],
        ballY: by[bestF],
        ballZ: bz[bestF],
        isSaveAttempt: true,
      });
    }
  }
  oppTouches.sort((a, b) => a.frameIndex - b.frameIndex);

  const holdTicks = Math.round(
    clamp(REPLAY_DIRECTOR_CONFIG.touchHoldAfterSeconds ?? 0.20, 0.0, 1.2) * TICK_RATE
  );
  const lookaheadTicks = Math.max(
    45,
    Math.round(clamp(REPLAY_DIRECTOR_CONFIG.twoTouchLookaheadSeconds ?? 2.20, 0.4, 5.0) * TICK_RATE)
  );
  const anticipationWeight = clamp(
    REPLAY_DIRECTOR_CONFIG.twoTouchAnticipationWeight ?? 0.36,
    0.0,
    1.0
  );

  const interceptorPreTicks = Math.max(
    24,
    Math.round(
      clamp(REPLAY_DIRECTOR_CONFIG.interceptorLookaheadSeconds ?? 1.65, 0.2, 4.0) * TICK_RATE
    )
  );
  const interceptorPostTicks = Math.round(0.75 * TICK_RATE);
  const interceptorWeightCfg = clamp(
    REPLAY_DIRECTOR_CONFIG.interceptorFramingWeight ?? 0.72,
    0.0,
    1.0
  );

  const scx = new Float64Array(N);
  const scy = new Float64Array(N);
  const scz = new Float64Array(N);
  const handoffArcWArr = new Float64Array(N);
  const handoffZLiftArr = new Float64Array(N);
  const oppChallengeWArr = new Float64Array(N);
  const postShotBallFocus = new Float64Array(N);
  const activeScoreCar = new Int32Array(N);
  const nextScoreCar = new Int32Array(N);
  const nextTouchBlendArr = new Float64Array(N);
  const nextTouchBallX = new Float64Array(N);
  const nextTouchBallY = new Float64Array(N);
  const nextTouchBallZ = new Float64Array(N);
  const hasNextTouchBall = new Uint8Array(N);
  const carSwitchBlendArr = new Float64Array(N);

  const ocx = new Float64Array(N);
  const ocy = new Float64Array(N);
  const ocz = new Float64Array(N);
  const oppW = new Float64Array(N);
  const activeOppCar = new Int32Array(N);

  const lastScoreTouchFrame =
    activeScoringTouches[activeScoringTouches.length - 1]?.frameIndex ?? goalIdx;
  const postShotReleaseTicks = Math.max(24, Math.round(0.32 * TICK_RATE));

  const firstCarIdx = clamp(activeScoringTouches[0]?.carIndex ?? scorerCarIdx, 0, numCars - 1);

  for (let i = 0; i < N; i++) {
    // 1. Progressive Striker Handoff across scoring touches (freeze passer follow-through after release)
    const firstTouchF = activeScoringTouches[0]?.frameIndex ?? goalIdx;
    const firstRefF =
      activeScoringTouches.length > 1 && activeScoringTouches[1].carIndex !== firstCarIdx
        ? Math.min(i, firstTouchF + 16)
        : i;
    let wx = cx[firstCarIdx][firstRefF];
    let wy = cy[firstCarIdx][firstRefF];
    let wz = cz[firstCarIdx][firstRefF];
    let domCar = firstCarIdx;
    let swBlend = 1.0;
    let handoffArcW = 0.0;
    const handoffZLift = 0.0;

    for (let k = 0; k < activeScoringTouches.length - 1; k++) {
      const t0 = activeScoringTouches[k];
      const t1 = activeScoringTouches[k + 1];
      const c0 = clamp(t0.carIndex, 0, numCars - 1);
      const c1 = clamp(t1.carIndex, 0, numCars - 1);
      const gap = Math.max(36, t1.frameIndex - t0.frameIndex);

      // If passer c0 drives deeper toward the goal than receiver c1 (corner centering pass),
      // begin blending toward receiver c1's lane earlier so the camera never over-advances
      // into the corner and then reverses backward for c1.
      const c0DeeperAtPass =
        c1 !== c0
          ? Math.max(
              0.0,
              (cy[c0][t0.frameIndex] - cy[c1][t0.frameIndex]) * goalSignY
            )
          : 0.0;
      const earlyLead =
        c0DeeperAtPass > 450.0
          ? Math.min(140, Math.round(gap * 0.42))
          : Math.min(22, Math.round(gap * 0.16));
      const startF = c1 !== c0 ? t0.frameIndex - earlyLead : t0.frameIndex + 20;
      const spanF =
        c1 !== c0
          ? clamp(Math.round(gap * 0.72) + earlyLead, 85, 260)
          : clamp(Math.round(gap * 0.35), 40, 90);
      if (i >= startF) {
        const u = clamp((i - startF) / spanF, 0, 1);
        const s = u * u * (3 - 2 * u);
        const nextHasFurtherPass =
          k + 2 < activeScoringTouches.length &&
          activeScoringTouches[k + 2].carIndex !== c1;
        const c1RefF = nextHasFurtherPass ? Math.min(i, t1.frameIndex + 16) : i;
        wx = wx * (1 - s) + cx[c1][c1RefF] * s;
        wy = wy * (1 - s) + cy[c1][c1RefF] * s;
        wz = wz * (1 - s) + cz[c1][c1RefF] * s;
        if (s >= 0.5) domCar = c1;
        if (c1 !== c0 && u > 0 && u < 1) {
          swBlend = Math.min(swBlend, Math.abs(2 * s - 1));
        }
      }
      if (c1 !== c0) {
        const dtH = i - t0.frameIndex;
        if (dtH >= -25 && dtH <= 95) {
          const uArc = (dtH + 25) / 120;
          const bell = Math.sin(uArc * Math.PI);
          handoffArcW = Math.max(handoffArcW, 0.22 * bell * bell);
        }
      }
    }

    if (i <= goalIdx) {
      if (i > lastScoreTouchFrame + holdTicks) {
        const uRel = clamp(
          (i - (lastScoreTouchFrame + holdTicks)) / postShotReleaseTicks,
          0,
          1
        );
        postShotBallFocus[i] = 0.5 - 0.5 * Math.cos(uRel * Math.PI);
      } else {
        postShotBallFocus[i] = 0.0;
      }
    } else {
      postShotBallFocus[i] = 1.0;
      const postU = clamp((i - goalIdx) / 28, 0, 1);
      const postS = 0.5 - 0.5 * Math.cos(postU * Math.PI);
      wx = wx * (1 - postS) + cx[scorerCarIdx][i] * postS;
      wy = wy * (1 - postS) + cy[scorerCarIdx][i] * postS;
      wz = wz * (1 - postS) + cz[scorerCarIdx][i] * postS;
      domCar = scorerCarIdx;
    }

    scx[i] = wx;
    scy[i] = wy;
    scz[i] = wz;
    handoffArcWArr[i] = handoffArcW;
    handoffZLiftArr[i] = handoffZLift;
    activeScoreCar[i] = domCar;
    carSwitchBlendArr[i] = swBlend;

    // 2. Determine current touch index kCurr and look ahead to the SUBSEQUENT touch (kCurr + 1)
    // when approaching t_{kCurr}, so two-touch anticipation targets the next receiver!
    let kCurr = activeScoringTouches.length - 1;
    for (let j = 0; j < activeScoringTouches.length; j++) {
      if (i <= activeScoringTouches[j].frameIndex + holdTicks) {
        kCurr = j;
        break;
      }
    }
    const currTouch = activeScoringTouches[kCurr];
    const nextTouchCandidate =
      i >= currTouch.frameIndex - 65 && kCurr + 1 < activeScoringTouches.length
        ? activeScoringTouches[kCurr + 1]
        : currTouch;

    let nCar = -1;
    let nBlend = 0;
    let nbx = bx[i];
    let nby = by[i];
    let nbz = bz[i];
    let hasNb = 0;
    const dtNext = nextTouchCandidate.frameIndex - i;
    if (dtNext > 0 && dtNext <= lookaheadTicks) {
      const u = 1.0 - dtNext / lookaheadTicks;
      const s = 0.5 - 0.5 * Math.cos(clamp(u, 0, 1) * Math.PI);
      nCar = clamp(nextTouchCandidate.carIndex, 0, numCars - 1);
      nBlend = anticipationWeight * s * s;
      nbx = nextTouchCandidate.ballX ?? bx[nextTouchCandidate.frameIndex];
      nby = nextTouchCandidate.ballY ?? by[nextTouchCandidate.frameIndex];
      nbz = nextTouchCandidate.ballZ ?? bz[nextTouchCandidate.frameIndex];
      hasNb = 1;
    }
    nextScoreCar[i] = nCar;
    nextTouchBlendArr[i] = nBlend;
    nextTouchBallX[i] = nbx;
    nextTouchBallY[i] = nby;
    nextTouchBallZ[i] = nbz;
    hasNextTouchBall[i] = hasNb;

    // 3. Opponent challenge & interceptor framing weights (calmed to prevent 50/50 camera whips)
    let challengeW = 0;
    let sumOppW = 0;
    let sumOx = 0;
    let sumOy = 0;
    let sumOz = 0;
    let bestOppW = 0;
    let bestOppCar = -1;

    for (let j = 0; j < oppTouches.length; j++) {
      const ot = oppTouches[j];
      const cIdx = clamp(ot.carIndex, 0, numCars - 1);
      const absDt = Math.abs(i - ot.frameIndex);
      if (!ot.isSaveAttempt && absDt < 65) {
        const cw = 0.16 * (0.5 + 0.5 * Math.cos((absDt / 65) * Math.PI));
        challengeW = Math.max(challengeW, cw);
      }

      const dtTicks = ot.frameIndex - i;
      let w = 0;
      if (dtTicks >= 0 && dtTicks <= interceptorPreTicks) {
        const u = 1.0 - dtTicks / interceptorPreTicks;
        w = 0.5 - 0.5 * Math.cos(u * Math.PI);
      } else if (dtTicks < 0 && -dtTicks <= interceptorPostTicks) {
        const u = 1.0 - -dtTicks / interceptorPostTicks;
        w = 0.5 - 0.5 * Math.cos(u * Math.PI);
      }
      w *= (ot.isSaveAttempt ? 0.55 : 0.85) * interceptorWeightCfg;
      if (w > 1e-4) {
        sumOppW += w;
        sumOx += w * cx[cIdx][i];
        sumOy += w * cy[cIdx][i];
        sumOz += w * cz[cIdx][i];
        if (w > bestOppW) {
          bestOppW = w;
          bestOppCar = cIdx;
        }
      }
    }
    oppChallengeWArr[i] = challengeW;

    if (sumOppW > 1e-4 && i <= goalIdx + 12) {
      ocx[i] = sumOx / sumOppW;
      ocy[i] = sumOy / sumOppW;
      ocz[i] = sumOz / sumOppW;
      oppW[i] = Math.min(0.65, bestOppW);
      activeOppCar[i] = bestOppCar;
    } else {
      ocx[i] = bx[i];
      ocy[i] = by[i];
      ocz[i] = bz[i];
      oppW[i] = 0;
      activeOppCar[i] = -1;
    }
  }

  const smScx = smooth1DZeroPhase(scx, 0.11, 2);
  const smScy = smooth1DZeroPhase(scy, 0.11, 2);
  const smScz = smooth1DZeroPhase(scz, 0.12, 2);
  const smOcx = smooth1DZeroPhase(ocx, 0.16, 2);
  const smOcy = smooth1DZeroPhase(ocy, 0.16, 2);
  const smOcz = smooth1DZeroPhase(ocz, 0.16, 2);
  const smOppW = smooth1DZeroPhase(oppW, 0.12, 2);

  let sumStartX = 0;
  let sumStartY = 0;
  const startWindow = Math.min(goalIdx + 1, 90);
  for (let i = 0; i < startWindow; i++) {
    sumStartX += 0.5 * (sbx[i] + smScx[i]);
    sumStartY += 0.5 * (sby[i] + smScy[i]);
  }
  const startX = sumStartX / Math.max(1, startWindow);
  const startY = sumStartY / Math.max(1, startWindow);

  let ux = (0.0 - startX) * 0.36;
  let uy = goalY - startY;
  if (uy * goalSignY < 600.0) {
    uy = goalSignY * 1800.0;
  }
  const uNorm = Math.hypot(ux, uy) || 1.0;
  ux /= uNorm;
  uy /= uNorm;
  const wxAxis = -uy;
  const wyAxis = ux;

  const resolvedLateralBias = resolveBalancedLateralBias({
    goalIdx,
    lastScoreTouchFrame,
    holdTicks,
    wxAxis,
    wyAxis,
    sbx,
    sby,
    smScx,
    smScy,
  });

  let sumBallX = 0;
  for (let i = 0; i <= goalIdx; i++) {
    sumBallX += sbx[i];
  }
  const meanBallX = sumBallX / Math.max(1, goalIdx + 1);
  const openSideX = meanBallX >= 0 ? -1.0 : 1.0;

  return {
    N, goalIdx, goalSignY, goalY, holdTicks, scorerCarIdx, lastScoreTouchFrame, openSideX,
    activeScoringTouches, oppTouches,
    bx, by, bz, sbx, sby, sbz,
    gazeEnvelopeZ, eyeEnvelopeZ, bouncePullbackUu,
    smScx, smScy, smScz,
    lastScorerX: cx[scorerCarIdx], lastScorerY: cy[scorerCarIdx], lastScorerZ: cz[scorerCarIdx],
    handoffArcWArr, handoffZLiftArr, oppChallengeWArr,
    smOcx, smOcy, smOcz, smOppW, postShotBallFocus,
    activeScoreCar, nextScoreCar, nextTouchBlendArr, hasNextTouchBall,
    nextTouchBallX, nextTouchBallY, nextTouchBallZ,
    activeOppCar, carSwitchBlendArr,
    ux, uy, wxAxis, wyAxis, resolvedLateralBias,
  };
}
