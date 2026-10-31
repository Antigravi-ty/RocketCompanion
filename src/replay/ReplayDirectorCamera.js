/**
 * ReplayDirectorCamera.js
 * Pure-math 3D Rocket League AutoCam placement using:
 * 1. Full-Trajectory Suffix Safe-Zone & Progressive Point Elimination (S(0) ⊆ S(1) ⊆ ... ⊆ S(T_goal))
 * 2. Backward-Planned Single-Sweep Trajectory Deduction from final free space S(T_goal)
 * 3. Contact-Driven Subject Anchors (Mandatory Next Scoring Player + Opponent Interceptor Path Inclusion)
 * 4. Low Camera Height Preference & Strict Total Yaw Rotation Bound (< 360°)
 */

import {
  SIM_OFFSETS,
  BALL_STATE_STRIDE,
  CAR_STATE_STRIDE,
  MAX_CARS,
} from '../physics/RocketSimConstants.js';
import { REPLAY_DIRECTOR_CONFIG } from '../ui-core/config/replayDirectorConfig.js';
import { decodeReplayDirectorTelemetryFromState } from './ReplayFrameInterpolator.js';

const TICK_RATE = 120;

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / ((edge1 - edge0) || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function wrapAngleDeltaDeg(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Zero-phase forward-backward exponential smoothing filter on a 1D Float64Array.
 */
function smooth1DZeroPhase(arr, alpha, passes = 2) {
  const n = arr.length;
  if (n <= 1) return new Float64Array(arr);
  let cur = new Float64Array(arr);
  const nxt = new Float64Array(n);
  const a = clamp(alpha, 0.005, 0.99);
  for (let p = 0; p < passes; p++) {
    nxt[0] = cur[0];
    for (let i = 1; i < n; i++) {
      nxt[i] = nxt[i - 1] + (cur[i] - nxt[i - 1]) * a;
    }
    cur[n - 1] = nxt[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      cur[i] = cur[i + 1] + (nxt[i] - cur[i + 1]) * a;
    }
  }
  return cur;
}

/**
 * Computes adaptive Director Camera elevation (Z in Unreal Units):
 * - Ground & low plays (activeZ <= 240 UU): stays low (~195-260 UU) for high visual impact.
 * - Wall climbs & air dribbles (activeZ > 240 UU): smoothly transitions into an aerial tracking
 *   regime that rises with the action so the viewer never cranes their neck at extreme upward angles.
 * - Ceiling shots & high backboard plays (activeZ > 1420 UU): smoothly tapers below the 2044 UU
 *   arena ceiling (capped at 1760 UU) so the camera never exits the stadium roof while keeping a
 *   clear, comfortable slightly-level view of ceiling touches and drops.
 */
function computeAdaptiveDirectorEyeHeight(activeZ, baseHeightUu = 195.0, aerialSlope = 0.36, latSpread = 0.0) {
  const groundZ = baseHeightUu + Math.max(0.0, activeZ - 45.0) * aerialSlope + latSpread * 0.015;
  const aerialBlend = smoothstep(220.0, 640.0, activeZ);
  const aerialTrackGain = clamp(0.86 + (aerialSlope - 0.36) * 0.45, 0.52, 0.98);
  const aerialOffset = (baseHeightUu - 195.0) * 0.55 - 28.0;
  const midAerialZ = activeZ * aerialTrackGain + aerialOffset + latSpread * 0.015;
  const ceilingBlend = smoothstep(1420.0, 1960.0, activeZ);
  const ceilingSafeZ = 1480.0 + (activeZ - 1420.0) * 0.42;
  const highZ = midAerialZ * (1.0 - ceilingBlend) + Math.min(midAerialZ, ceilingSafeZ) * ceilingBlend;
  return clamp(groundZ * (1.0 - aerialBlend) + highZ * aerialBlend, 150.0, 1760.0);
}

/**
 * Clamps a 3D point in Unreal coordinates (X right, Y forward, Z up) strictly inside
 * the octagonal RocketSim stadium interior so the Director Camera never exits the arena.
 */
export function clampPositionInsideArena(rawX, rawY, rawZ) {
  let x = clamp(rawX, -3720.0, 3720.0);
  let y = clamp(rawY, -4780.0, 4780.0);
  const z = clamp(rawZ, 145.0, 1820.0);

  // Enforce 45-degree stadium corner chamfers (|X| + |Y| <= 7450)
  const manhattan = Math.abs(x) + Math.abs(y);
  if (manhattan > 7450.0) {
    const scale = 7450.0 / manhattan;
    x *= scale;
    y *= scale;
  }

  return { x, y, z };
}

/**
 * Resolves the exact frame index where the ball explodes in the goal.
 * Prioritizes:
 * 1. Explicit GOAL_SCORED (0x0e) incident or SCORE_UPDATED (0x91) signal on a frame.
 * 2. RocketSim goal explosion depth crossing (ballY * goalSignY >= 5210.0, unlatching if < 5120.0).
 * 3. Fallback crossing of 5120.0 / 5100.0 only if the ball never reaches 5210.0 in the clip.
 */
export function resolveGoalExplosionFrameIndex(frames, goalSignY = 1.0, candidateIdx = -1) {
  const N = Array.isArray(frames) ? frames.length : 0;
  if (N === 0) return -1;

  let incidentGoalIdx = -1;
  let depth5210Idx = -1;
  let depth5120Idx = -1;
  let depth5100Idx = -1;

  for (let i = 0; i < N; i++) {
    const entry = frames[i];
    if (!entry) continue;
    const snap = entry.snapshot || entry;
    const ballY =
      snap && snap.length > SIM_OFFSETS.BALL + 1 ? (snap[SIM_OFFSETS.BALL + 1] || 0) : 0;
    const signedY = ballY * goalSignY;

    const evList =
      Array.isArray(entry.incidents) && entry.incidents.length > 0
        ? entry.incidents
        : Array.isArray(entry.events)
          ? entry.events
          : [];
    for (let j = 0; j < evList.length; j++) {
      const inc = evList[j];
      if (inc && (inc.type === 0x0e || inc.type === 14)) {
        incidentGoalIdx = i;
        break;
      }
    }
    if (incidentGoalIdx < 0 && Array.isArray(entry.signals)) {
      for (let j = 0; j < entry.signals.length; j++) {
        const sig = entry.signals[j];
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
      const candSnap = candEntry?.snapshot || candEntry;
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
 * Builds the full-window Suffix Safe-Zone Backward-Planned Camera Trajectory across all frames [0 .. N-1].
 *
 * Algorithm:
 * - Extracts full trajectories of Ball and all Cars across [0 .. N-1].
 * - Identifies Contact-Driven Subject Anchors:
 *   1. Mandatory next scoring-team touch player C_score(t) (with smooth cosine handoff between teammates).
 *   2. Opponent interceptor / challenger C_opp(t) whenever an opponent intercepts or challenges the ball
 *      before the goal, so the viewer clearly sees why the opponent's interception failed.
 * - Computes at each pre-goal frame t the safe camera region behind the rearmost active subject in
 *   { Ball(t), C_score(t), C_opp(t) } aligned with the sightline toward the play/goal.
 * - Propagates the Suffix Safe-Zone backward from T_goal to 0: as time t advances forward, past points
 *   (τ < t) are eliminated, monotonically expanding the safe zone S(t) toward the final free space S(T_goal)
 *   and producing a single smooth forward-sweeping camera trajectory with low elevation and < 360° total yaw rotation.
 */
export function buildSuffixSafeDirectorTrajectory(frames, options = {}) {
  const N = Array.isArray(frames) ? frames.length : 0;
  if (N === 0) return null;

  const scoringTeam = options.scoringTeam ?? 0;
  const goalSignY = scoringTeam === 0 ? 1.0 : -1.0;
  const goalY = goalSignY * 5120.0;
  const carTeamResolver =
    typeof options.carTeamResolver === 'function' ? options.carTeamResolver : (c) => c % 2;
  const fallbackScorer =
    typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0
      ? options.scorerCarIndex
      : 0;

  const firstSnap = frames[0]?.snapshot || frames[0];
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

  const cx = Array.from({ length: numCars }, () => new Float64Array(N));
  const cy = Array.from({ length: numCars }, () => new Float64Array(N));
  const cz = Array.from({ length: numCars }, () => new Float64Array(N));
  const cvx = Array.from({ length: numCars }, () => new Float64Array(N));
  const cvy = Array.from({ length: numCars }, () => new Float64Array(N));
  const cvz = Array.from({ length: numCars }, () => new Float64Array(N));

  let resolvedGoalIdx = resolveGoalExplosionFrameIndex(
    frames,
    goalSignY,
    typeof options.goalLineFrameIdx === 'number' ? options.goalLineFrameIdx : -1
  );

  for (let i = 0; i < N; i++) {
    const snap = frames[i]?.snapshot || frames[i];
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
      cvx[c][i] = snap[base + 12] || 0;
      cvy[c][i] = snap[base + 13] || 0;
      cvz[c][i] = snap[base + 14] || 0;
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
    cx[c] = smooth1DZeroPhase(cx[c], 0.24, 2);
    cy[c] = smooth1DZeroPhase(cy[c], 0.24, 2);
    cz[c] = smooth1DZeroPhase(cz[c], 0.20, 2);
  }

  const sbx = smooth1DZeroPhase(bx, 0.20, 2);
  const sby = smooth1DZeroPhase(by, 0.20, 2);
  const sbz = smooth1DZeroPhase(bz, 0.16, 2);

  // Separate touch events into Scoring-Team Touches vs Opponent Interceptions/Challenges
  const rawTouches = Array.isArray(options.touchEvents) ? options.touchEvents : [];
  const preGoalTouches = rawTouches.filter((t) => t && t.frameIndex <= goalIdx + 8);
  const scoringTouches = preGoalTouches.filter((t) => t.team === scoringTeam);
  const activeScoringTouches =
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
  const oppTouches = preGoalTouches
    .filter((t) => t.team !== scoringTeam && t.frameIndex > 12 && t.frameIndex <= goalIdx + 2)
    .map((t) => ({ ...t }));

  const firstScoreTouchFrame = Math.max(12, (activeScoringTouches[0]?.frameIndex ?? 0) - 30);
  for (let c = 0; c < numCars; c++) {
    if (carTeamResolver(c) === scoringTeam) continue;
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
        team: carTeamResolver(c),
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
  const switchRate = clamp(REPLAY_DIRECTOR_CONFIG.strikerSwitchDampingRate ?? 4.2, 0.5, 16.0);
  const transitionHalfWidth = Math.max(12, Math.round((1.8 / switchRate) * TICK_RATE));

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

  // Build per-frame Mandatory Scoring Player Anchor C_score(t) and Opponent Interceptor Anchor C_opp(t)
  const scx = new Float64Array(N);
  const scy = new Float64Array(N);
  const scz = new Float64Array(N);
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

  for (let i = 0; i < N; i++) {
    // 1. Mandatory Next Scoring Player C_score(t)
    let k = activeScoringTouches.length - 1;
    for (let j = 0; j < activeScoringTouches.length; j++) {
      if (i <= activeScoringTouches[j].frameIndex + holdTicks) {
        k = j;
        break;
      }
    }
    const currT = activeScoringTouches[k];
    const c0 = clamp(currT.carIndex, 0, numCars - 1);
    let wx = cx[c0][i];
    let wy = cy[c0][i];
    let wz = cz[c0][i];
    let domCar = c0;
    let swBlend = 1.0;

    if (k < activeScoringTouches.length - 1) {
      const nextT = activeScoringTouches[k + 1];
      const c1 = clamp(nextT.carIndex, 0, numCars - 1);
      const handoffCenter = currT.frameIndex + holdTicks;
      if (c1 !== c0 && i >= handoffCenter - transitionHalfWidth) {
        const u = clamp(
          (i - (handoffCenter - transitionHalfWidth)) / (2 * transitionHalfWidth),
          0,
          1
        );
        const s = 0.5 - 0.5 * Math.cos(u * Math.PI);
        wx = cx[c0][i] * (1 - s) + cx[c1][i] * s;
        wy = cy[c0][i] * (1 - s) + cy[c1][i] * s;
        wz = cz[c0][i] * (1 - s) + cz[c1][i] * s;
        domCar = s >= 0.5 ? c1 : c0;
        swBlend = Math.abs(2 * s - 1);
      }
    }

    // After the final scoring touch (i > lastScoreTouchFrame + holdTicks) and BEFORE the ball explodes (i <= goalIdx),
    // release focus from the scorer toward the ball so the camera watches the ball travel into the goal rather than
    // staring at the scorer driving away before the goal explosion.
    if (i <= goalIdx) {
      if (i > lastScoreTouchFrame + holdTicks) {
        const uRel = clamp(
          (i - (lastScoreTouchFrame + holdTicks)) / postShotReleaseTicks,
          0,
          1
        );
        const relS = 0.5 - 0.5 * Math.cos(uRel * Math.PI);
        postShotBallFocus[i] = relS;
        wx = wx * (1.0 - relS) + bx[i] * relS;
        wy = wy * (1.0 - relS) + by[i] * relS;
        wz = wz * (1.0 - relS) + bz[i] * relS;
      } else {
        postShotBallFocus[i] = 0.0;
      }
    } else {
      // Once the ball has exploded in the goal (i > goalIdx), smoothly transition focus onto the scorer!
      postShotBallFocus[i] = 0.0;
      const preGoalRel = postShotBallFocus[goalIdx] || 0.0;
      const baseWx = wx * (1.0 - preGoalRel) + bx[goalIdx] * preGoalRel;
      const baseWy = wy * (1.0 - preGoalRel) + by[goalIdx] * preGoalRel;
      const baseWz = wz * (1.0 - preGoalRel) + bz[goalIdx] * preGoalRel;
      const postU = clamp((i - goalIdx) / 28, 0, 1);
      const postS = 0.5 - 0.5 * Math.cos(postU * Math.PI);
      wx = baseWx * (1 - postS) + cx[scorerCarIdx][i] * postS;
      wy = baseWy * (1 - postS) + cy[scorerCarIdx][i] * postS;
      wz = baseWz * (1 - postS) + cz[scorerCarIdx][i] * postS;
      domCar = scorerCarIdx;
    }

    scx[i] = wx;
    scy[i] = wy;
    scz[i] = wz;
    activeScoreCar[i] = domCar;
    carSwitchBlendArr[i] = swBlend;

    // Next-touch lookahead metadata for telemetry/diagnostics
    let nCar = -1;
    let nBlend = 0;
    let nbx = bx[i];
    let nby = by[i];
    let nbz = bz[i];
    let hasNb = 0;
    for (let j = 0; j < activeScoringTouches.length; j++) {
      const st = activeScoringTouches[j];
      const dtTicks = st.frameIndex - i;
      if (dtTicks > 0 && dtTicks <= lookaheadTicks) {
        const u = 1.0 - dtTicks / lookaheadTicks;
        const s = 0.5 - 0.5 * Math.cos(clamp(u, 0, 1) * Math.PI);
        nCar = clamp(st.carIndex, 0, numCars - 1);
        nBlend = anticipationWeight * s * s;
        nbx = st.ballX ?? bx[st.frameIndex];
        nby = st.ballY ?? by[st.frameIndex];
        nbz = st.ballZ ?? bz[st.frameIndex];
        hasNb = 1;
        break;
      }
    }
    nextScoreCar[i] = nCar;
    nextTouchBlendArr[i] = nBlend;
    nextTouchBallX[i] = nbx;
    nextTouchBallY[i] = nby;
    nextTouchBallZ[i] = nbz;
    hasNextTouchBall[i] = hasNb;

    // 2. Opponent Interceptor Anchor C_opp(t)
    let sumOppW = 0;
    let sumOx = 0;
    let sumOy = 0;
    let sumOz = 0;
    let bestOppW = 0;
    let bestOppCar = -1;

    for (let j = 0; j < oppTouches.length; j++) {
      const ot = oppTouches[j];
      const cIdx = clamp(ot.carIndex, 0, numCars - 1);
      const dtTicks = ot.frameIndex - i;
      let w = 0;
      if (dtTicks >= 0 && dtTicks <= interceptorPreTicks) {
        const u = 1.0 - dtTicks / interceptorPreTicks;
        w = 0.5 - 0.5 * Math.cos(u * Math.PI);
      } else if (dtTicks < 0 && -dtTicks <= interceptorPostTicks) {
        const u = 1.0 - -dtTicks / interceptorPostTicks;
        w = 0.5 - 0.5 * Math.cos(u * Math.PI);
      }
      w *= (ot.isSaveAttempt ? 0.65 : 1.0) * interceptorWeightCfg;
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

    if (sumOppW > 1e-4 && i <= goalIdx + 12) {
      ocx[i] = sumOx / sumOppW;
      ocy[i] = sumOy / sumOppW;
      ocz[i] = sumOz / sumOppW;
      oppW[i] = Math.min(0.85, bestOppW);
      activeOppCar[i] = bestOppCar;
    } else {
      ocx[i] = bx[i];
      ocy[i] = by[i];
      ocz[i] = bz[i];
      oppW[i] = 0;
      activeOppCar[i] = -1;
    }
  }

  const smScx = smooth1DZeroPhase(scx, 0.14, 2);
  const smScy = smooth1DZeroPhase(scy, 0.14, 2);
  const smScz = smooth1DZeroPhase(scz, 0.14, 2);
  const smOcx = smooth1DZeroPhase(ocx, 0.16, 2);
  const smOcy = smooth1DZeroPhase(ocy, 0.16, 2);
  const smOcz = smooth1DZeroPhase(ocz, 0.16, 2);
  const smOppW = smooth1DZeroPhase(oppW, 0.12, 2);

  // Establish global sweep axis U = (ux, uy) from opening play centroid toward goal mouth (0, goalY)
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
  // Right unit perpendicular W = (-uy, ux)
  const wxAxis = -uy;
  const wyAxis = ux;

  // Determine interior arena side bias (always place camera toward the open stadium interior X = 0)
  let sumBallX = 0;
  for (let i = 0; i <= goalIdx; i++) {
    sumBallX += sbx[i];
  }
  const meanBallX = sumBallX / Math.max(1, goalIdx + 1);
  const interiorXDir = meanBallX >= 0 ? -1.0 : 1.0;
  const resolvedLateralBias = interiorXDir * wxAxis >= 0 ? 1.0 : -1.0;

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

    // Rearmost subject along U among { Ball, Scoring Player, Opponent Interceptor }
    let minSubU = Math.min(bu, su);
    if (ow > 0.05) {
      const oppRearU = ou * ow + minSubU * (1.0 - ow);
      minSubU = Math.min(minSubU, oppRearU);
    }

    // Subject lateral spread so wide passes or opponent interceptions slightly widen the camera distance
    const maxLatV = Math.max(bv, sv, ow > 0.1 ? ov : bv);
    const minLatV = Math.min(bv, sv, ow > 0.1 ? ov : bv);
    const latSpread = maxLatV - minLatV;
    const longSpread = Math.max(bu, su, ow > 0.1 ? ou : bu) - minSubU;

    const activeZ =
      Math.max(sbz[i], smScz[i], ow > 0.15 ? smOcz[i] : 0) * 0.65 +
      (sbz[i] * 0.55 + smScz[i] * 0.45) * 0.35;
    const aerialBlend = smoothstep(220.0, 680.0, activeZ);
    const vertSpread = Math.abs(sbz[i] - smScz[i]);
    const aerialPullback = aerialBlend * 115.0 + Math.min(450.0, vertSpread) * 0.14;

    // Moderate longitudinal distance behind minSubU so the side-rear oblique offset achieves a 45-60 deg (~60 deg) viewing angle
    const trailBack =
      (backStart - prog * (backStart - backEnd)) * 0.72 +
      latSpread * 0.12 +
      Math.min(500.0, longSpread) * 0.06 +
      aerialPullback * 0.65;
    reqRearU[i] = minSubU - trailBack;

    // Oblique 45-60 deg (~55-60 deg) side-rear lateral offset toward the open arena interior
    // (never subtracting dirV * trailBack against resolvedLateralBias, avoiding tail-chasing behind the car)
    const centerV = bv * 0.52 + sv * (0.48 - 0.18 * ow) + ov * (0.18 * ow);
    const interiorSubV =
      Math.max(
        bv * resolvedLateralBias,
        sv * resolvedLateralBias,
        ow > 0.15 ? ov * resolvedLateralBias : -1e9
      ) * resolvedLateralBias;
    const baseLatV = 0.50 * centerV + 0.50 * interiorSubV;
    const wallProx = smoothstep(2200.0, 3800.0, Math.max(Math.abs(sbx[i]), Math.abs(smScx[i])));
    const wallClimbClearance = wallProx * (180.0 + 200.0 * smoothstep(140.0, 820.0, activeZ));
    const sideOffset =
      (sideBase * (1.0 - 0.12 * prog) + wallClimbClearance + aerialPullback * 0.55) *
      resolvedLateralBias;
    reqLatV[i] = baseLatV + sideOffset;

    // Adaptive Multi-Stage Camera Height:
    // Low (~195-245 UU) on ground plays, rising smoothly with wall climbs & air dribbles so the viewer
    // never cranes their neck, and tapering below the 2044 UU roof on ceiling shots.
    reqEyeZ[i] = computeAdaptiveDirectorEyeHeight(activeZ, baseHeightUu, aerialSlope, latSpread);
  }

  // Suffix Safe-Zone Backward Deduction from T_goal down to 0:
  // At t = goalIdx, only the final goal-mouth point remains, so S(T_goal) is largest.
  // Moving backward τ = goalIdx - 1 .. 0, each point constrains the safe zone:
  //   safeSuffixU[i] = min_{τ ∈ [i, goalIdx]} reqRearU[τ]
  // Moving forward t = 0 .. goalIdx, past points (τ < t) are eliminated (剔除), so safeSuffixU[t]
  // is strictly behind reqRearU[t] at every frame AND monotonically advances forward without ever backing up!
  const goalMouthMaxU = 0.0 * ux + (goalY - goalSignY * Math.min(showcaseDist * 0.72, 740.0)) * uy;
  const safeSuffixU = new Float64Array(goalIdx + 1);
  safeSuffixU[goalIdx] = Math.min(reqRearU[goalIdx], goalMouthMaxU);

  const decayReleasePerTick = Math.max(0.0, (suffixDecay - 1.0) * 0.45);
  for (let i = goalIdx - 1; i >= 0; i--) {
    const targetU = Math.min(reqRearU[i], goalMouthMaxU);
    safeSuffixU[i] = Math.min(targetU, safeSuffixU[i + 1] + decayReleasePerTick);
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
  const smoothPreZ = smooth1DZeroPhase(reqEyeZ, 0.060, Math.max(2, smoothPasses - 1));

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
    const followZ = clamp(goalEyeZ + stretch * 85.0 + Math.max(0, sz - 40.0) * 0.28, 165.0, 1760.0);

    const cl = clampPositionInsideArena(
      goalEyeX * (1 - followW) + followX * followW,
      goalEyeY * (1 - followW) + followY * followW,
      goalEyeZ * (1 - followW) + followZ * followW
    );
    fullEyeX[i] = cl.x;
    fullEyeY[i] = cl.y;
    fullEyeZ[i] = cl.z;
  }

  // Smooth eye across the goal-line transition so post-goal pullback has zero acceleration spike
  const rawEyeXArr = smooth1DZeroPhase(fullEyeX, 0.14, 2);
  const rawEyeYArr = smooth1DZeroPhase(fullEyeY, 0.14, 2);
  const rawEyeZArr = smooth1DZeroPhase(fullEyeZ, 0.14, 2);

  // Apply causal eye damping governed by eyeDampingRate on top of the planned trajectory
  const eyeRate = clamp(REPLAY_DIRECTOR_CONFIG.eyeDampingRate ?? 5.2, 0.8, 25.0);
  const eyeAlpha = 1.0 - Math.exp(-(1 / TICK_RATE) * (eyeRate * 2.4));
  const eyeXArr = new Float64Array(N);
  const eyeYArr = new Float64Array(N);
  const eyeZArr = new Float64Array(N);
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

    // Exact ball ray
    const vbx = bx[i] - ex;
    const vby = by[i] - ey;
    const vbz = clamp(bz[i] + 16.0, 75.0, 1980.0) - ez;
    const db = Math.hypot(vbx, vby, vbz) || 1.0;
    const ubx = vbx / db;
    const uby = vby / db;
    const ubz = vbz / db;

    // Mandatory scoring player ray
    const vsx = smScx[i] - ex;
    const vsy = smScy[i] - ey;
    const vsz = clamp(smScz[i] + 28.0, 75.0, 1980.0) - ez;
    const ds = Math.hypot(vsx, vsy, vsz) || 1.0;
    const usx = vsx / ds;
    const usy = vsy / ds;
    const usz = vsz / ds;

    // Opponent interceptor ray (when active)
    const ow = smOppW[i];
    const vox = smOcx[i] - ex;
    const voy = smOcy[i] - ey;
    const voz = clamp(smOcz[i] + 28.0, 75.0, 1980.0) - ez;
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
    // Before goal explosion (i <= goalIdx), release scorer weight after final touch and cap carRayW so the ball
    // never leaves the central field of view. Only focus on the scorer after the ball explodes (i > goalIdx).
    const activePreCarShare = Math.max(scorerActiveShare, ow * 0.55);
    const rawPreCarW = baseCarWeight * activePreCarShare;
    const maxAllowedPreCarW = 14.0 / Math.max(14.0, angleBC);
    const preCarW = Math.min(rawPreCarW, maxAllowedPreCarW);
    const carRayW = preCarW * (1.0 - postFollow) + 0.88 * postFollow;
    const ballRayW = 1.0 - carRayW;

    let mx = ubx * ballRayW + ucx * carRayW;
    let my = uby * ballRayW + ucy * carRayW;
    let mz = ubz * ballRayW + ucz * carRayW;
    const mNorm = Math.hypot(mx, my, mz) || 1.0;
    mx /= mNorm;
    my /= mNorm;
    mz /= mNorm;

    rawDirX[i] = mx;
    rawDirY[i] = my;
    rawDirZ[i] = mz;
    rawDistArr[i] = Math.pow(db, ballRayW) * Math.pow(ds, carRayW);
  }

  // Smooth gaze unit vector and enforce strict total yaw rotation budget (< 360°)
  const gazeRate = clamp(REPLAY_DIRECTOR_CONFIG.gazeDampingRate ?? 8.5, 1.0, 30.0);
  const baseGazeAlpha = clamp(gazeRate / 70.0, 0.04, 0.28);
  const maxYawBudget = clamp(REPLAY_DIRECTOR_CONFIG.maxTotalYawBudgetDeg ?? 320.0, 90.0, 355.0);

  let smDirX = smooth1DZeroPhase(rawDirX, baseGazeAlpha, 2);
  let smDirY = smooth1DZeroPhase(rawDirY, baseGazeAlpha, 2);
  let smDirZ = smooth1DZeroPhase(rawDirZ, baseGazeAlpha, 2);
  const smDist = smooth1DZeroPhase(rawDistArr, 0.14, 2);

  const computeTotalYawPath = (dxArr, dyArr) => {
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
    smDirZ = smooth1DZeroPhase(smDirZ, 0.08, 2);
    yawStats = computeTotalYawPath(smDirX, smDirY);
    extraSmoothIter++;
  }

  const poses = new Array(N);
  for (let i = 0; i < N; i++) {
    const rNorm = Math.hypot(rawDirX[i], rawDirY[i], rawDirZ[i]) || 1.0;
    const rDist = rawDistArr[i];
    const rtx = rawEyeXArr[i] + (rawDirX[i] / rNorm) * rDist;
    const rty = rawEyeYArr[i] + (rawDirY[i] / rNorm) * rDist;
    const rtz = clamp(rawEyeZArr[i] + (rawDirZ[i] / rNorm) * rDist, 75.0, 1980.0);

    const dNorm = Math.hypot(smDirX[i], smDirY[i], smDirZ[i]) || 1.0;
    const dist = smDist[i];
    const tx = eyeXArr[i] + (smDirX[i] / dNorm) * dist;
    const ty = eyeYArr[i] + (smDirY[i] / dNorm) * dist;
    const tz = clamp(eyeZArr[i] + (smDirZ[i] / dNorm) * dist, 75.0, 1980.0);

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

function interpolatePlannedPose(p0, p1, alpha, skipDamping = false) {
  if (!p0) return null;
  if (!p1 || alpha <= 1e-5) {
    return skipDamping
      ? {
          eyeX: p0.rawEyeX ?? p0.eyeX,
          eyeY: p0.rawEyeY ?? p0.eyeY,
          eyeZ: p0.rawEyeZ ?? p0.eyeZ,
          targetX: p0.rawTargetX ?? p0.targetX,
          targetY: p0.rawTargetY ?? p0.targetY,
          targetZ: p0.rawTargetZ ?? p0.targetZ,
          rawEyeX: p0.rawEyeX ?? p0.eyeX,
          rawEyeY: p0.rawEyeY ?? p0.eyeY,
          rawEyeZ: p0.rawEyeZ ?? p0.eyeZ,
          rawTargetX: p0.rawTargetX ?? p0.targetX,
          rawTargetY: p0.rawTargetY ?? p0.targetY,
          rawTargetZ: p0.rawTargetZ ?? p0.targetZ,
        }
      : {
          eyeX: p0.eyeX,
          eyeY: p0.eyeY,
          eyeZ: p0.eyeZ,
          targetX: p0.targetX,
          targetY: p0.targetY,
          targetZ: p0.targetZ,
          rawEyeX: p0.rawEyeX ?? p0.eyeX,
          rawEyeY: p0.rawEyeY ?? p0.eyeY,
          rawEyeZ: p0.rawEyeZ ?? p0.eyeZ,
          rawTargetX: p0.rawTargetX ?? p0.targetX,
          rawTargetY: p0.rawTargetY ?? p0.targetY,
          rawTargetZ: p0.rawTargetZ ?? p0.targetZ,
        };
  }
  const t = clamp(alpha, 0, 1);
  const lerp = (a, b) => a + (b - a) * t;
  const rawEye = clampPositionInsideArena(
    lerp(p0.rawEyeX ?? p0.eyeX, p1.rawEyeX ?? p1.eyeX),
    lerp(p0.rawEyeY ?? p0.eyeY, p1.rawEyeY ?? p1.eyeY),
    lerp(p0.rawEyeZ ?? p0.eyeZ, p1.rawEyeZ ?? p1.eyeZ)
  );
  const rawTargetX = lerp(p0.rawTargetX ?? p0.targetX, p1.rawTargetX ?? p1.targetX);
  const rawTargetY = lerp(p0.rawTargetY ?? p0.targetY, p1.rawTargetY ?? p1.targetY);
  const rawTargetZ = lerp(p0.rawTargetZ ?? p0.targetZ, p1.rawTargetZ ?? p1.targetZ);

  if (skipDamping) {
    return {
      eyeX: rawEye.x,
      eyeY: rawEye.y,
      eyeZ: rawEye.z,
      targetX: rawTargetX,
      targetY: rawTargetY,
      targetZ: rawTargetZ,
      rawEyeX: rawEye.x,
      rawEyeY: rawEye.y,
      rawEyeZ: rawEye.z,
      rawTargetX,
      rawTargetY,
      rawTargetZ,
    };
  }

  const eye = clampPositionInsideArena(
    lerp(p0.eyeX, p1.eyeX),
    lerp(p0.eyeY, p1.eyeY),
    lerp(p0.eyeZ, p1.eyeZ)
  );
  return {
    eyeX: eye.x,
    eyeY: eye.y,
    eyeZ: eye.z,
    targetX: lerp(p0.targetX, p1.targetX),
    targetY: lerp(p0.targetY, p1.targetY),
    targetZ: lerp(p0.targetZ, p1.targetZ),
    rawEyeX: rawEye.x,
    rawEyeY: rawEye.y,
    rawEyeZ: rawEye.z,
    rawTargetX,
    rawTargetY,
    rawTargetZ,
  };
}

/**
 * Computes pure-math 3D Rocket League AutoCam placement
 * (Unreal Units: X right, Y forward toward Orange goal, Z up).
 * Uses the preplanned Suffix Safe-Zone Backward Trajectory when available (or embedded in stateBuffer),
 * and falls back to sightline-aligned low-height forward-monotonic framing for streaming single frames.
 */
export function computeGoalReplayCameraPose(stateBuffer, scoringTeam = 0, options = {}) {
  if (!stateBuffer || stateBuffer.length < SIM_OFFSETS.BALL + BALL_STATE_STRIDE) {
    return { eyeX: 0, eyeY: -3600, eyeZ: 210, targetX: 0, targetY: 0, targetZ: 120 };
  }

  const prevBuf =
    options.prevStateBuffer && options.prevStateBuffer.length >= SIM_OFFSETS.BALL + BALL_STATE_STRIDE
      ? options.prevStateBuffer
      : stateBuffer;
  const alpha =
    typeof options.alpha === 'number' && Number.isFinite(options.alpha)
      ? clamp(options.alpha, 0, 1)
      : 1.0;
  const skipDamping = Boolean(options.skipDamping);
  const directorState = options.directorState || null;

  // 1. Check for full-window Suffix Safe-Zone trajectory plan on directorState or options
  const suffixPlan = options.suffixCameraPlan || directorState?.suffixCameraPlan || null;
  if (suffixPlan && Array.isArray(suffixPlan.poses) && suffixPlan.poses.length > 0) {
    const poses = suffixPlan.poses;
    const total = poses.length;
    let exactIdx =
      typeof options.frameIndex === 'number' && Number.isFinite(options.frameIndex)
        ? options.frameIndex
        : typeof directorState?.currentFrameIndex === 'number'
          ? directorState.currentFrameIndex
          : clamp(options.progress ?? 0, 0, 1) * Math.max(0, total - 1);
    exactIdx = clamp(exactIdx, 0, Math.max(0, total - 1));
    const baseIdx = Math.floor(exactIdx);
    const nextIdx = Math.min(total - 1, baseIdx + 1);
    const frac = exactIdx > baseIdx ? exactIdx - baseIdx : alpha < 1.0 ? alpha : 0.0;
    const p0 = poses[baseIdx];
    const p1 = poses[nextIdx] || p0;
    const pose = interpolatePlannedPose(p0, p1, frac, skipDamping);

    if (directorState && !skipDamping && pose) {
      directorState.eyeX = pose.eyeX;
      directorState.eyeY = pose.eyeY;
      directorState.eyeZ = pose.eyeZ;
      directorState.targetX = pose.targetX;
      directorState.targetY = pose.targetY;
      directorState.targetZ = pose.targetZ;
      directorState.activeTouchCarIndex = p0.activeTouchCarIndex;
      directorState.nextTouchCarIndex = p0.nextTouchCarIndex;
      directorState.nextTouchBlend = p0.nextTouchBlend;
      directorState.nextTouchBallPos = p0.nextTouchBallPos;
      directorState.interceptorCarIndex = p0.interceptorCarIndex;
      directorState.interceptorBlend = p0.interceptorBlend;
      directorState.postGoalElapsedSec = p0.postGoalElapsedSec;
      directorState.smoothedCarX = p0.smoothedCarX;
      directorState.smoothedCarY = p0.smoothedCarY;
      directorState.smoothedCarZ = p0.smoothedCarZ;
      directorState.carSwitchBlend = p0.carSwitchBlend;
      directorState.lateralBias = p0.lateralBias;
      directorState.initialized = true;
    }
    return pose;
  }

  // 2. Check for server-embedded planned pose in stateBuffer (Car Slot 7 telemetry)
  const embeddedTelemetry = decodeReplayDirectorTelemetryFromState(stateBuffer);
  if (directorState && embeddedTelemetry) {
    directorState.activeTouchCarIndex = embeddedTelemetry.activeTouchCarIndex;
    directorState.nextTouchCarIndex = embeddedTelemetry.nextTouchCarIndex;
    directorState.nextTouchBlend = embeddedTelemetry.nextTouchBlend;
    directorState.nextTouchBallPos = embeddedTelemetry.nextTouchBallPos;
    if (typeof embeddedTelemetry.interceptorCarIndex === 'number') {
      directorState.interceptorCarIndex = embeddedTelemetry.interceptorCarIndex;
      directorState.interceptorBlend = embeddedTelemetry.interceptorBlend ?? 0;
    }
    if (typeof embeddedTelemetry.postGoalElapsedSec === 'number') {
      directorState.postGoalElapsedSec = embeddedTelemetry.postGoalElapsedSec;
    }
    if (typeof embeddedTelemetry.lateralBias === 'number' && embeddedTelemetry.lateralBias !== 0) {
      directorState.lateralBias = embeddedTelemetry.lateralBias;
      directorState.hasResolvedInitialLateralBias = true;
    }
    if (typeof embeddedTelemetry.scorerCarIndex === 'number' && embeddedTelemetry.scorerCarIndex >= 0) {
      directorState.scorerCarIndex = embeddedTelemetry.scorerCarIndex;
    }
  }

  if (embeddedTelemetry?.plannedPose) {
    const prevEmbedded =
      prevBuf !== stateBuffer ? decodeReplayDirectorTelemetryFromState(prevBuf) : null;
    const p0 = prevEmbedded?.plannedPose || embeddedTelemetry.plannedPose;
    const p1 = embeddedTelemetry.plannedPose;
    const pose = interpolatePlannedPose(p0, p1, prevEmbedded?.plannedPose ? alpha : 0.0, skipDamping);
    if (directorState && !skipDamping && pose) {
      directorState.eyeX = pose.eyeX;
      directorState.eyeY = pose.eyeY;
      directorState.eyeZ = pose.eyeZ;
      directorState.targetX = pose.targetX;
      directorState.targetY = pose.targetY;
      directorState.targetZ = pose.targetZ;
      directorState.initialized = true;
    }
    return pose;
  }

  // 3. Causal streaming fallback ( sightline-aligned low-height forward-monotonic framing )
  const lerpBuf = (offset) => prevBuf[offset] + (stateBuffer[offset] - prevBuf[offset]) * alpha;
  const ballX = lerpBuf(SIM_OFFSETS.BALL);
  const ballY = lerpBuf(SIM_OFFSETS.BALL + 1);
  const ballZ = lerpBuf(SIM_OFFSETS.BALL + 2);

  const dt = options.exactDt
    ? Math.max(1e-4, Number(options.dt) || 1 / 120)
    : clamp(options.dt ?? 0.016, 0.001, 0.1);

  const headerCars = Math.min(
    MAX_CARS,
    Math.max(0, Math.round(stateBuffer[SIM_OFFSETS.NUM_CARS] || 0))
  );
  const preferredCarIdx =
    typeof directorState?.activeTouchCarIndex === 'number' &&
    directorState.activeTouchCarIndex >= 0 &&
    directorState.activeTouchCarIndex < headerCars
      ? directorState.activeTouchCarIndex
      : typeof options.scorerCarIndex === 'number' &&
          options.scorerCarIndex >= 0 &&
          options.scorerCarIndex < headerCars
        ? options.scorerCarIndex
        : 0;

  const carBase = SIM_OFFSETS.CARS + preferredCarIdx * CAR_STATE_STRIDE;
  const hasFocusCar = headerCars > 0 && stateBuffer.length >= carBase + 15;
  const rawCarX = hasFocusCar ? lerpBuf(carBase) : ballX;
  const rawCarY = hasFocusCar ? lerpBuf(carBase + 1) : ballY;
  const rawCarZ = hasFocusCar ? lerpBuf(carBase + 2) : ballZ;

  let carX = rawCarX;
  let carY = rawCarY;
  let carZ = rawCarZ;
  if (directorState) {
    if (!directorState.initialized || typeof directorState.smoothedCarX !== 'number') {
      const settled = directorState.initialSettledCarPos;
      carX = settled && typeof settled.x === 'number' ? settled.x : rawCarX;
      carY = settled && typeof settled.y === 'number' ? settled.y : rawCarY;
      carZ = settled && typeof settled.z === 'number' ? settled.z : rawCarZ;
      if (!skipDamping) {
        directorState.smoothedCarX = carX;
        directorState.smoothedCarY = carY;
        directorState.smoothedCarZ = carZ;
      }
    } else {
      const carAlpha = 1.0 - Math.exp(-dt * 8.0);
      carX = directorState.smoothedCarX + (rawCarX - directorState.smoothedCarX) * carAlpha;
      carY = directorState.smoothedCarY + (rawCarY - directorState.smoothedCarY) * carAlpha;
      carZ = directorState.smoothedCarZ + (rawCarZ - directorState.smoothedCarZ) * carAlpha;
      if (!skipDamping) {
        directorState.smoothedCarX = carX;
        directorState.smoothedCarY = carY;
        directorState.smoothedCarZ = carZ;
      }
    }
  }

  const oppCarIdx =
    typeof directorState?.interceptorCarIndex === 'number' &&
    directorState.interceptorCarIndex >= 0 &&
    directorState.interceptorCarIndex < headerCars
      ? directorState.interceptorCarIndex
      : -1;
  const oppBlend = clamp(directorState?.interceptorBlend ?? 0, 0, 0.85);
  const oppBase = oppCarIdx >= 0 ? SIM_OFFSETS.CARS + oppCarIdx * CAR_STATE_STRIDE : -1;
  const hasOppCar = oppBase >= 0 && stateBuffer.length >= oppBase + 15 && oppBlend > 1e-3;
  const oppX = hasOppCar ? lerpBuf(oppBase) : ballX;
  const oppY = hasOppCar ? lerpBuf(oppBase + 1) : ballY;
  const oppZ = hasOppCar ? lerpBuf(oppBase + 2) : ballZ;

  const goalSignY = scoringTeam === 0 ? 1.0 : scoringTeam === 1 ? -1.0 : ballY >= 0 ? 1.0 : -1.0;
  const goalY = goalSignY * 5120.0;

  const postGoalSec = Math.max(0.0, Number(directorState?.postGoalElapsedSec) || 0.0);
  const followTransSec = Math.max(
    0.08,
    REPLAY_DIRECTOR_CONFIG.postGoalScorerFollowTransitionSec ?? 0.28
  );
  const postFollow = smoothstep(0.0, followTransSec * 1.4, postGoalSec);
  const distCarBall = Math.hypot(carX - ballX, carY - ballY, carZ - ballZ);
  const preGoalCarProximityW =
    postGoalSec > 0 ? 1.0 : 1.0 - smoothstep(650.0, 1850.0, distCarBall);
  const preAnchorCarW = (0.45 - 0.15 * oppBlend) * preGoalCarProximityW;
  const preAnchorBallW = 1.0 - preAnchorCarW - 0.15 * oppBlend;

  // Strictly forward-oriented sightline toward the scoring goal (never flips 180°)
  const anchorX = ballX * preAnchorBallW + carX * preAnchorCarW + oppX * (0.15 * oppBlend);
  const anchorY = ballY * preAnchorBallW + carY * preAnchorCarW + oppY * (0.15 * oppBlend);
  const toGoalX = (0.0 - anchorX) * 0.55;
  const toGoalY = goalSignY * Math.max(950.0, (goalY - anchorY) * goalSignY);
  const dirNorm = Math.hypot(toGoalX, toGoalY) || 1.0;
  const ugX = toGoalX / dirNorm;
  const ugY = toGoalY / dirNorm;
  const usX = -ugY;
  const usY = ugX;

  const lateralBias = directorState?.lateralBias || 1.0;
  const progress = clamp(options.progress ?? 0.5, 0, 1);

  const backStart = REPLAY_DIRECTOR_CONFIG.corridorBackDistStart ?? 500.0;
  const backEnd = REPLAY_DIRECTOR_CONFIG.corridorBackDistEnd ?? 400.0;
  const sideBase = REPLAY_DIRECTOR_CONFIG.corridorSideDistBase ?? 760.0;
  const baseHeightUu = REPLAY_DIRECTOR_CONFIG.cameraBaseHeightUu ?? 195.0;
  const aerialSlope = REPLAY_DIRECTOR_CONFIG.cameraAerialHeightSlope ?? 0.36;

  const activeZ =
    Math.max(
      ballZ,
      carZ * preGoalCarProximityW + ballZ * (1.0 - preGoalCarProximityW),
      hasOppCar ? oppZ : 0
    ) *
      0.65 +
    (ballZ * 0.55 + carZ * 0.45) * 0.35;
  const aerialBlend = smoothstep(220.0, 680.0, activeZ);
  const vertSpread = Math.abs(ballZ - carZ) * preGoalCarProximityW;
  const aerialPullback = aerialBlend * 115.0 + Math.min(450.0, vertSpread) * 0.14;

  const carBehind = Math.max(0.0, (ballX - carX) * ugX + (ballY - carY) * ugY) * preGoalCarProximityW;
  const oppBehind = hasOppCar
    ? Math.max(0.0, (ballX - oppX) * ugX + (ballY - oppY) * ugY) * oppBlend
    : 0.0;
  const rearDelta = Math.max(carBehind, oppBehind);

  const trailBackDist =
    (backStart - progress * (backStart - backEnd)) * 0.72 +
    Math.min(500.0, rearDelta) +
    aerialPullback * 0.65;
  const wallProx = smoothstep(2200.0, 3800.0, Math.max(Math.abs(ballX), Math.abs(carX)));
  const wallClimbClearance = wallProx * (180.0 + 200.0 * smoothstep(140.0, 820.0, activeZ));
  const trailSideDist =
    (sideBase * (1.0 - 0.12 * progress) + wallClimbClearance + aerialPullback * 0.55) * lateralBias;

  const rawEyeX = anchorX - ugX * trailBackDist + usX * trailSideDist;
  const rawEyeY = anchorY - ugY * trailBackDist + usY * trailSideDist;
  const rawEyeZ = computeAdaptiveDirectorEyeHeight(activeZ, baseHeightUu, aerialSlope, 0.0);

  const clampedEye = clampPositionInsideArena(rawEyeX, rawEyeY, rawEyeZ);

  const vbx = ballX - clampedEye.x;
  const vby = ballY - clampedEye.y;
  const vbz = clamp(ballZ + 18.0, 80.0, 1980.0) - clampedEye.z;
  const db = Math.hypot(vbx, vby, vbz) || 1.0;

  const vcx = carX - clampedEye.x;
  const vcy = carY - clampedEye.y;
  const vcz = clamp(carZ + 28.0, 80.0, 1980.0) - clampedEye.z;
  const dc = Math.hypot(vcx, vcy, vcz) || 1.0;

  const dotBC = clamp((vbx * vcx + vby * vcy + vbz * vcz) / (db * dc), -1.0, 1.0);
  const angleBC = (Math.acos(dotBC) * 180.0) / Math.PI;
  const basePreCarW =
    clamp(REPLAY_DIRECTOR_CONFIG.carMidpointMaxWeight ?? 0.46, 0.2, 0.75) * preGoalCarProximityW;
  const preCarW = Math.min(basePreCarW, 14.0 / Math.max(14.0, angleBC));
  const carRayW = preCarW * (1.0 - postFollow) + 0.88 * postFollow;
  const ballRayW = 1.0 - carRayW;
  const mixX = (vbx / db) * ballRayW + (vcx / dc) * carRayW;
  const mixY = (vby / db) * ballRayW + (vcy / dc) * carRayW;
  const mixZ = (vbz / db) * ballRayW + (vcz / dc) * carRayW;
  const mixNorm = Math.hypot(mixX, mixY, mixZ) || 1.0;
  const targetDist = Math.pow(db, ballRayW) * Math.pow(dc, carRayW);

  const rawTargetX = clampedEye.x + (mixX / mixNorm) * targetDist;
  const rawTargetY = clampedEye.y + (mixY / mixNorm) * targetDist;
  const rawTargetZ = clamp(clampedEye.z + (mixZ / mixNorm) * targetDist, 80.0, 1980.0);

  if (directorState && !skipDamping) {
    if (!directorState.initialized) {
      directorState.eyeX = clampedEye.x;
      directorState.eyeY = clampedEye.y;
      directorState.eyeZ = clampedEye.z;
      directorState.targetX = rawTargetX;
      directorState.targetY = rawTargetY;
      directorState.targetZ = rawTargetZ;
      directorState.initialized = true;
    } else {
      const eyeAlpha = 1.0 - Math.exp(-dt * (REPLAY_DIRECTOR_CONFIG.eyeDampingRate ?? 5.2));
      const gazeAlpha = 1.0 - Math.exp(-dt * (REPLAY_DIRECTOR_CONFIG.gazeDampingRate ?? 8.5));
      directorState.eyeX += (clampedEye.x - directorState.eyeX) * eyeAlpha;
      directorState.eyeY += (clampedEye.y - directorState.eyeY) * eyeAlpha;
      directorState.eyeZ += (clampedEye.z - directorState.eyeZ) * eyeAlpha;
      directorState.targetX += (rawTargetX - directorState.targetX) * gazeAlpha;
      directorState.targetY += (rawTargetY - directorState.targetY) * gazeAlpha;
      directorState.targetZ += (rawTargetZ - directorState.targetZ) * gazeAlpha;
    }
    const finalClamped = clampPositionInsideArena(
      directorState.eyeX,
      directorState.eyeY,
      directorState.eyeZ
    );
    return {
      eyeX: finalClamped.x,
      eyeY: finalClamped.y,
      eyeZ: finalClamped.z,
      targetX: directorState.targetX,
      targetY: directorState.targetY,
      targetZ: directorState.targetZ,
      rawEyeX: clampedEye.x,
      rawEyeY: clampedEye.y,
      rawEyeZ: clampedEye.z,
      rawTargetX,
      rawTargetY,
      rawTargetZ,
    };
  }

  return {
    eyeX: clampedEye.x,
    eyeY: clampedEye.y,
    eyeZ: clampedEye.z,
    targetX: rawTargetX,
    targetY: rawTargetY,
    targetZ: rawTargetZ,
    rawEyeX: clampedEye.x,
    rawEyeY: clampedEye.y,
    rawEyeZ: clampedEye.z,
    rawTargetX,
    rawTargetY,
    rawTargetZ,
  };
}

/**
 * Applies the Rocket League AutoCam Director pose to the active Three.js camera.
 * Note: Unreal (X right, Y forward, Z up) maps to Three.js (X right, Y up, Z forward).
 */
export function applyDirectorReplayCamera(
  cameraManager,
  stepOrInterpolator,
  optionsOrProgress = {},
  dtOrScoringTeam = 0.016,
  maybeDt = 0.016,
  maybeScorerCarIndex = 0,
  maybeDirectorState = null
) {
  const cam = cameraManager?.camera;
  if (!cam || cameraManager?.isFreeCam) return;

  let currFrame = null;
  let prevFrame = null;
  let alpha = 1.0;
  let scoringTeam = 0;
  let scorerCarIndex = 0;
  let progress = 0.5;
  let frameIndex = undefined;
  let directorState = null;
  let dt = 0.016;

  if (typeof optionsOrProgress === 'number') {
    progress = optionsOrProgress;
    scoringTeam = typeof dtOrScoringTeam === 'number' ? dtOrScoringTeam : 0;
    dt = typeof maybeDt === 'number' ? maybeDt : 0.016;
    scorerCarIndex = typeof maybeScorerCarIndex === 'number' ? maybeScorerCarIndex : 0;
    directorState = maybeDirectorState || null;

    currFrame =
      stepOrInterpolator?.currState ||
      stepOrInterpolator?.currFrame ||
      stepOrInterpolator?.frame ||
      stepOrInterpolator?.sim?.state ||
      null;
    prevFrame =
      stepOrInterpolator?.prevState ||
      stepOrInterpolator?.prevFrame ||
      currFrame;
    alpha = typeof stepOrInterpolator?.alpha === 'number' ? stepOrInterpolator.alpha : 1.0;
    if (typeof stepOrInterpolator?.frameIndex === 'number') {
      frameIndex = stepOrInterpolator.frameIndex + alpha;
    }
  } else {
    const options = optionsOrProgress || {};
    dt = typeof dtOrScoringTeam === 'number' ? dtOrScoringTeam : 0.016;
    scoringTeam = options.scoringTeam ?? 0;
    scorerCarIndex = options.scorerCarIndex ?? 0;
    progress = stepOrInterpolator?.progress ?? options.progress ?? 0.5;
    directorState = options.directorState || null;

    currFrame =
      stepOrInterpolator?.currFrame ||
      stepOrInterpolator?.frame ||
      stepOrInterpolator?.currState ||
      options.fallbackBuffer ||
      null;
    prevFrame =
      stepOrInterpolator?.prevFrame ||
      stepOrInterpolator?.prevState ||
      currFrame;
    alpha = typeof stepOrInterpolator?.alpha === 'number' ? stepOrInterpolator.alpha : 1.0;
    if (typeof stepOrInterpolator?.frameIndex === 'number') {
      frameIndex = stepOrInterpolator.frameIndex + alpha;
    } else if (typeof options.frameIndex === 'number') {
      frameIndex = options.frameIndex;
    }
  }

  if (!currFrame) return;

  if (directorState?.useRecordedCsvPose && directorState?.recordedPose) {
    const rec = directorState.recordedPose;
    directorState.eyeX = rec.eyeX;
    directorState.eyeY = rec.y ?? rec.eyeY;
    directorState.eyeZ = rec.eyeZ;
    directorState.targetX = rec.targetX;
    directorState.targetY = rec.targetY;
    directorState.targetZ = rec.targetZ;
    directorState.initialized = true;
    cam.position.set(rec.eyeX, rec.eyeZ, rec.eyeY);
    cam.lookAt(rec.targetX, rec.targetZ, rec.targetY);
    return;
  }

  const isReplayFrozen = Boolean(
    stepOrInterpolator?.isPaused ||
    stepOrInterpolator?.isScrubbing ||
    directorState?.isPaused ||
    directorState?.isScrubbing
  );

  if (isReplayFrozen && directorState?.initialized) {
    cam.position.set(directorState.eyeX, directorState.eyeZ, directorState.eyeY);
    cam.lookAt(
      directorState.targetX,
      directorState.targetZ,
      directorState.targetZ !== undefined ? directorState.targetY : 0
    );
    return;
  }

  const pose = computeGoalReplayCameraPose(currFrame, scoringTeam, {
    prevStateBuffer: prevFrame || currFrame,
    alpha,
    scorerCarIndex,
    progress,
    frameIndex,
    directorState,
    dt: isReplayFrozen ? 0.0 : dt,
    exactDt: isReplayFrozen,
  });

  cam.position.set(pose.eyeX, pose.eyeZ, pose.eyeY);
  cam.lookAt(pose.targetX, pose.targetZ, pose.targetY);
}
