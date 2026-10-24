/**
 * ReplayFrameInterpolator.js
 * Applies compact 448-float GameStateBufferPod replay frames
 * to RocketSimPhysicsEngine and PhysicsStateInterpolator, and computes Goal Replay camera pose.
 */

import {
  SIM_OFFSETS,
  BALL_STATE_STRIDE,
  CAR_STATE_STRIDE,
  MAX_CARS
} from '../physics/RocketSimConstants.js';

/**
 * Applies a compact 448-float GameStateBufferPod replay frame
 * directly to a RocketSimPhysicsEngine instance and optional PhysicsStateInterpolator.
 */
export function applyReplayFrameToEngine(engine, frameBuffer, interpolator = null, prevFrameBuffer = null, alpha = 1.0) {
  if (!engine || !frameBuffer || frameBuffer.length < 410) return false;

  const headerCars = Math.min(MAX_CARS, Math.max(0, Math.round(frameBuffer[SIM_OFFSETS.NUM_CARS] || 0)));
  while (engine.numCars < headerCars && typeof engine.addCar === 'function') {
    engine.addCar(engine.numCars % 2, 'octane');
  }
  if (typeof engine.restoreState === 'function') {
    engine.restoreState(frameBuffer);
  } else {
    if (typeof engine.setBallState === 'function') {
      engine.setBallState(frameBuffer.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE));
    }
    const numCars = Math.min(engine.numCars, headerCars || engine.numCars, MAX_CARS);
    for (let c = 0; c < numCars; c++) {
      const carOffset = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      if (typeof engine.setCarState === 'function') {
        engine.setCarState(c, frameBuffer.subarray(carOffset, carOffset + CAR_STATE_STRIDE));
      }
    }
    if (engine.state) {
      const copyLen = Math.min(frameBuffer.length, engine.state.length);
      engine.state.subarray(0, copyLen).set(frameBuffer.subarray(0, copyLen));
    }
  }

  if (interpolator) {
    const currLen = Math.min(interpolator.currState.length, engine.state.length);
    interpolator.currState.subarray(0, currLen).set(engine.state.subarray(0, currLen));
    if (prevFrameBuffer && prevFrameBuffer.length >= 410 && prevFrameBuffer.length <= 512) {
      const prevLen = Math.min(interpolator.prevState.length, prevFrameBuffer.length);
      interpolator.prevState.subarray(0, prevLen).set(prevFrameBuffer.subarray(0, prevLen));
      interpolator.alpha = Math.max(0, Math.min(1, alpha));
    } else {
      interpolator.prevState.subarray(0, currLen).set(engine.state.subarray(0, currLen));
      interpolator.alpha = 0;
    }
  }

  return true;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / ((edge1 - edge0) || 1), 0, 1);
  return t * t * (3 - 2 * t);
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

export const DEFAULT_REPLAY_DIRECTOR_CONFIG = Object.freeze({
  // 1. Pre-last-touch & goal-line dramatic slow-motion windows
  lastTouchSlowMoPreSeconds: 0.50,   // 0.50s before final scoring touch
  lastTouchSlowMoPostSeconds: 0.25,  // 0.25s after final scoring touch
  lastTouchSlowMoScale: 0.50,        // 50% playback speed at final touch impact
  goalLineSlowMoPreSeconds: 0.25,    // 0.25s before crossing the goal line
  goalLineSlowMoPostSeconds: 0.25,   // 0.25s after crossing the goal line
  goalLineSlowMoScale: 0.50,         // 50% playback speed at goal-line crossing

  // 2. Two-Touch Lookahead & Anticipation (encompassing 2 touches in one smooth sweep)
  touchHoldAfterSeconds: 0.20,       // Keep framing current striker for 0.20s after impact
  twoTouchLookaheadSeconds: 2.20,    // Look ahead up to 2.2s for the next scoring-team touch (T2)
  twoTouchAnticipationWeight: 0.36,  // How strongly the midpoint/corridor pre-leans toward T2 (0..0.6)

  // 3. Corridor & Two-Subject Framing distances (Unreal Units)
  corridorBackDistStart: 780.0,      // Base distance behind midpoint at start of replay
  corridorBackDistEnd: 600.0,        // Base distance behind midpoint near end of replay
  corridorSideDistBase: 550.0,       // Base lateral offset toward open field interior
  goalBoxShowcaseDist: 1250.0,       // Settle distance in front of the net
  carMidpointMaxWeight: 0.44,        // Max weight of striker car in Car-Ball midpoint (44% car + 56% ball)
  eyeDampingRate: 3.8,               // Camera translation smoothing rate (1/s)
  gazeDampingRate: 7.5,              // Camera lookAt pan/tilt smoothing rate (1/s)
  strikerSwitchDampingRate: 4.2      // Striker focus switch cross-fade rate (1/s) to prevent target step-jumps
});

/**
 * Centralized tunable parameters for the Goal Replay Director Camera & Slow-Motion.
 */
export const REPLAY_DIRECTOR_CONFIG = {
  ...DEFAULT_REPLAY_DIRECTOR_CONFIG
};

const directorConfigListeners = new Set();

export function updateReplayDirectorConfig(patch = {}) {
  if (!patch || typeof patch !== 'object') return REPLAY_DIRECTOR_CONFIG;
  for (const [key, val] of Object.entries(patch)) {
    if (key in REPLAY_DIRECTOR_CONFIG && typeof val === 'number' && Number.isFinite(val)) {
      REPLAY_DIRECTOR_CONFIG[key] = val;
    }
  }
  for (const fn of directorConfigListeners) {
    try {
      fn({ ...REPLAY_DIRECTOR_CONFIG });
    } catch (err) {
      console.warn('[ReplayFrameInterpolator] Director config listener failed:', err);
    }
  }
  return REPLAY_DIRECTOR_CONFIG;
}

export function resetReplayDirectorConfig() {
  Object.assign(REPLAY_DIRECTOR_CONFIG, DEFAULT_REPLAY_DIRECTOR_CONFIG);
  for (const fn of directorConfigListeners) {
    try {
      fn({ ...REPLAY_DIRECTOR_CONFIG });
    } catch (err) {
      console.warn('[ReplayFrameInterpolator] Director config reset listener failed:', err);
    }
  }
  return REPLAY_DIRECTOR_CONFIG;
}

export function subscribeReplayDirectorConfig(listener) {
  if (typeof listener !== 'function') return () => {};
  directorConfigListeners.add(listener);
  return () => directorConfigListeners.delete(listener);
}

export const REPLAY_DIRECTOR_MAGIC = 1337.5;
export const REPLAY_DIRECTOR_TELEMETRY_OFFSET = SIM_OFFSETS.CARS + 7 * CAR_STATE_STRIDE; // 302 (Slot 7, unused in 1v1/2v2/3v3)

/**
 * Embeds authoritative server-computed Two-Touch Lookahead anchors into unused car slot 7
 * of a 448-float GameStateBufferPod snapshot so client Director Camera can smoothly damp
 * across frames without needing the full replay buffer locally.
 */
export function encodeReplayDirectorTelemetryIntoState(targetBuffer, directorState, progress = 0) {
  if (!targetBuffer || targetBuffer.length < REPLAY_DIRECTOR_TELEMETRY_OFFSET + 10 || !directorState) {
    return targetBuffer;
  }
  const numCars = Math.round(targetBuffer[SIM_OFFSETS.NUM_CARS] || 0);
  if (numCars > 7) return targetBuffer;

  const base = REPLAY_DIRECTOR_TELEMETRY_OFFSET;
  targetBuffer[base] = REPLAY_DIRECTOR_MAGIC;
  targetBuffer[base + 1] = typeof directorState.activeTouchCarIndex === 'number' ? directorState.activeTouchCarIndex : -1;
  targetBuffer[base + 2] = typeof directorState.nextTouchCarIndex === 'number' ? directorState.nextTouchCarIndex : -1;
  targetBuffer[base + 3] = typeof directorState.nextTouchBlend === 'number' ? directorState.nextTouchBlend : 0;
  if (directorState.nextTouchBallPos) {
    targetBuffer[base + 4] = directorState.nextTouchBallPos.x || 0;
    targetBuffer[base + 5] = directorState.nextTouchBallPos.y || 0;
    targetBuffer[base + 6] = directorState.nextTouchBallPos.z || 0;
    targetBuffer[base + 7] = 1.0;
  } else {
    targetBuffer[base + 4] = 0;
    targetBuffer[base + 5] = 0;
    targetBuffer[base + 6] = 0;
    targetBuffer[base + 7] = 0.0;
  }
  targetBuffer[base + 8] = typeof progress === 'number' && Number.isFinite(progress) ? progress : 0;
  return targetBuffer;
}

/**
 * Extracts authoritative server-computed Two-Touch Lookahead anchors from a 448-float snapshot
 * if present.
 */
export function decodeReplayDirectorTelemetryFromState(stateBuffer) {
  if (!stateBuffer || stateBuffer.length < REPLAY_DIRECTOR_TELEMETRY_OFFSET + 10) return null;
  const numCars = Math.round(stateBuffer[SIM_OFFSETS.NUM_CARS] || 0);
  if (numCars > 7) return null;
  const base = REPLAY_DIRECTOR_TELEMETRY_OFFSET;
  if (Math.abs(stateBuffer[base] - REPLAY_DIRECTOR_MAGIC) > 0.01) return null;

  const hasNextPos = stateBuffer[base + 7] > 0.5;
  return {
    activeTouchCarIndex: Math.round(stateBuffer[base + 1]),
    nextTouchCarIndex: Math.round(stateBuffer[base + 2]),
    nextTouchBlend: clamp(stateBuffer[base + 3] || 0, 0, 1),
    nextTouchBallPos: hasNextPos
      ? { x: stateBuffer[base + 4], y: stateBuffer[base + 5], z: stateBuffer[base + 6] }
      : null,
    progress: clamp(stateBuffer[base + 8] || 0, 0, 1),
  };
}

/**
 * Linearly interpolates continuous physical quantities (ball & car positions, velocities,
 * forward/up vectors) between two 448-float snapshots for server-side dramatic slow-motion streaming.
 */
export function interpolateReplaySnapshots(prevSnap, currSnap, alpha = 1.0, outBuffer = null) {
  if (!currSnap) return null;
  const out = outBuffer && outBuffer.length >= currSnap.length
    ? outBuffer
    : new Float32Array(currSnap.length);
  out.set(currSnap);
  const t = clamp(alpha, 0, 1);
  if (!prevSnap || prevSnap.length < currSnap.length || t >= 0.999) {
    return out;
  }
  const lerpIdx = (idx) => {
    out[idx] = prevSnap[idx] + (currSnap[idx] - prevSnap[idx]) * t;
  };
  // Interpolate Ball pos (0..2), forward/right/up basis (3..11), vel (12..14), angVel (15..17)
  for (let i = 0; i < 18; i++) {
    lerpIdx(SIM_OFFSETS.BALL + i);
  }
  const numCars = Math.min(MAX_CARS, Math.max(0, Math.round(currSnap[SIM_OFFSETS.NUM_CARS] || 0)));
  for (let c = 0; c < numCars; c++) {
    const base = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
    for (let i = 0; i < 18; i++) {
      lerpIdx(base + i);
    }
  }
  return out;
}

/**
 * Computes pure-math 3D Rocket League AutoCam placement
 * (Unreal Units: X right, Y forward toward Orange goal, Z up).
 *
 * Uses a Two-Touch Lookahead Corridor AutoCam model:
 * - Identifies both the current/upcoming touch car (T1) and the next anticipated touch (T2)
 *   from `directorState` (`activeTouchCarIndex`, `nextTouchCarIndex`, `nextTouchBallPos`).
 * - Smoothly cross-fades the tracked striker anchor (`smoothedCarX/Y/Z`) whenever `activeTouchCarIndex`
 *   switches between cars so the midpoint target and standoff radius never step-jump.
 * - Aims the camera gaze and corridor anchor at the composite centroid of:
 *   [Ball + Primary Striker (T1) + Next Anticipated Striker/Touch (T2)],
 *   so passing plays or multi-touch dribbles are encompassed in a single smooth camera arc
 *   without jerky re-aiming between touches.
 * - Dynamically pulls back the camera based on the bounding span of (Ball + T1 + T2) so all
 *   active participants stay framed inside the viewport.
 */
export function computeGoalReplayCameraPose(stateBuffer, scoringTeam = 0, options = {}) {
  if (!stateBuffer || stateBuffer.length < SIM_OFFSETS.BALL + BALL_STATE_STRIDE) {
    return { eyeX: 0, eyeY: -3600, eyeZ: 420, targetX: 0, targetY: 0, targetZ: 120 };
  }

  const prevBuf =
    options.prevStateBuffer && options.prevStateBuffer.length >= SIM_OFFSETS.BALL + BALL_STATE_STRIDE
      ? options.prevStateBuffer
      : stateBuffer;
  const alpha = typeof options.alpha === 'number' && Number.isFinite(options.alpha)
    ? clamp(options.alpha, 0, 1)
    : 1.0;

  const lerpBuf = (offset) => prevBuf[offset] + (stateBuffer[offset] - prevBuf[offset]) * alpha;

  const ballX = lerpBuf(SIM_OFFSETS.BALL);
  const ballY = lerpBuf(SIM_OFFSETS.BALL + 1);
  const ballZ = lerpBuf(SIM_OFFSETS.BALL + 2);
  const ballVelX = lerpBuf(SIM_OFFSETS.BALL + 12) || 0;
  const ballVelY = lerpBuf(SIM_OFFSETS.BALL + 13) || 0;
  const ballVelZ = lerpBuf(SIM_OFFSETS.BALL + 14) || 0;

  const directorState = options.directorState || null;
  const embeddedTelemetry = decodeReplayDirectorTelemetryFromState(stateBuffer);
  if (directorState && embeddedTelemetry) {
    directorState.activeTouchCarIndex = embeddedTelemetry.activeTouchCarIndex;
    directorState.nextTouchCarIndex = embeddedTelemetry.nextTouchCarIndex;
    directorState.nextTouchBlend = embeddedTelemetry.nextTouchBlend;
    directorState.nextTouchBallPos = embeddedTelemetry.nextTouchBallPos;
  }
  const dt = clamp(options.dt ?? 0.016, 0.001, 0.1);

  const headerCars = Math.min(MAX_CARS, Math.max(0, Math.round(stateBuffer[SIM_OFFSETS.NUM_CARS] || 0)));
  const preferredCarIdx =
    typeof directorState?.activeTouchCarIndex === 'number' &&
    directorState.activeTouchCarIndex >= 0 &&
    directorState.activeTouchCarIndex < headerCars
      ? directorState.activeTouchCarIndex
      : (typeof options.scorerCarIndex === 'number' &&
         options.scorerCarIndex >= 0 &&
         options.scorerCarIndex < headerCars
          ? options.scorerCarIndex
          : 0);

  const carBase = SIM_OFFSETS.CARS + preferredCarIdx * CAR_STATE_STRIDE;
  const hasFocusCar = headerCars > 0 && stateBuffer.length >= carBase + 15;

  const rawCarX = hasFocusCar ? lerpBuf(carBase) : ballX;
  const rawCarY = hasFocusCar ? lerpBuf(carBase + 1) : ballY;
  const rawCarZ = hasFocusCar ? lerpBuf(carBase + 2) : ballZ;

  // Smooth striker focus position across car index changes to prevent sudden target/standoff jumps
  let carX = rawCarX;
  let carY = rawCarY;
  let carZ = rawCarZ;
  if (directorState) {
    if (!directorState.initialized || typeof directorState.smoothedCarX !== 'number') {
      directorState.smoothedCarX = rawCarX;
      directorState.smoothedCarY = rawCarY;
      directorState.smoothedCarZ = rawCarZ;
      directorState.lastTrackedCarIndex = preferredCarIdx;
      directorState.carSwitchBlend = 1.0;
    } else {
      if (directorState.lastTrackedCarIndex !== preferredCarIdx) {
        directorState.lastTrackedCarIndex = preferredCarIdx;
        directorState.carSwitchBlend = 0.0;
      }
      const switchRate = Math.max(0.5, REPLAY_DIRECTOR_CONFIG.strikerSwitchDampingRate ?? 4.2);
      if ((directorState.carSwitchBlend ?? 1.0) < 0.995) {
        const carAlpha = 1.0 - Math.exp(-dt * switchRate);
        directorState.carSwitchBlend = Math.min(1.0, (directorState.carSwitchBlend ?? 0) + dt * switchRate * 0.65);
        directorState.smoothedCarX += (rawCarX - directorState.smoothedCarX) * carAlpha;
        directorState.smoothedCarY += (rawCarY - directorState.smoothedCarY) * carAlpha;
        directorState.smoothedCarZ += (rawCarZ - directorState.smoothedCarZ) * carAlpha;
      } else {
        directorState.smoothedCarX = rawCarX;
        directorState.smoothedCarY = rawCarY;
        directorState.smoothedCarZ = rawCarZ;
      }
      carX = directorState.smoothedCarX;
      carY = directorState.smoothedCarY;
      carZ = directorState.smoothedCarZ;
    }
  }

  // Optional 2nd lookahead touch (T2: either a teammate receiving a pass or the next touch point of a solo play)
  const nextCarIdx =
    typeof directorState?.nextTouchCarIndex === 'number' &&
    directorState.nextTouchCarIndex >= 0 &&
    directorState.nextTouchCarIndex < headerCars
      ? directorState.nextTouchCarIndex
      : -1;
  const nextCarBase = nextCarIdx >= 0 ? SIM_OFFSETS.CARS + nextCarIdx * CAR_STATE_STRIDE : -1;
  const hasNextCar = nextCarBase >= 0 && stateBuffer.length >= nextCarBase + 15;
  const nextTouchBallPos = directorState?.nextTouchBallPos || null;
  const nextTouchBlend = clamp(directorState?.nextTouchBlend ?? 0, 0, 0.55);

  // If T2 is a different car (passing play), blend toward T2 car's live position + T2 impact point;
  // if T2 is the same car (double-touch / dribble), blend toward T2's upcoming impact point.
  let lookaheadX = ballX;
  let lookaheadY = ballY;
  let lookaheadZ = ballZ;
  if (nextTouchBlend > 0.01) {
    if (hasNextCar && nextCarIdx !== preferredCarIdx) {
      const nCarX = lerpBuf(nextCarBase);
      const nCarY = lerpBuf(nextCarBase + 1);
      const nCarZ = lerpBuf(nextCarBase + 2);
      lookaheadX = nextTouchBallPos ? (nCarX * 0.55 + nextTouchBallPos.x * 0.45) : nCarX;
      lookaheadY = nextTouchBallPos ? (nCarY * 0.55 + nextTouchBallPos.y * 0.45) : nCarY;
      lookaheadZ = nextTouchBallPos ? (nCarZ * 0.55 + nextTouchBallPos.z * 0.45) : nCarZ;
    } else if (nextTouchBallPos) {
      lookaheadX = nextTouchBallPos.x;
      lookaheadY = nextTouchBallPos.y;
      lookaheadZ = nextTouchBallPos.z;
    }
  }

  const goalSignY = scoringTeam === 0 ? 1.0 : scoringTeam === 1 ? -1.0 : (ballY >= 0 ? 1.0 : -1.0);
  const goalY = goalSignY * 5120.0;
  const goalZ = 310.0;

  // Direction unit vector from ball to target goal center
  const toGoalX = 0.0 - ballX;
  const toGoalY = goalY - ballY;
  const distToGoal = Math.hypot(toGoalX, toGoalY) || 1.0;
  const ugX = toGoalX / distToGoal;
  const ugY = toGoalY / distToGoal;

  // Perpendicular lateral unit vector in XY plane
  const usX = -ugY;
  const usY = ugX;

  const carToBallDist = Math.hypot(ballX - carX, ballY - carY, ballZ - carZ);
  const lookaheadToBallDist = nextTouchBlend > 0.01
    ? Math.hypot(lookaheadX - ballX, lookaheadY - ballY, lookaheadZ - ballZ)
    : 0.0;

  // Pick a consistent lateral vantage side that places the camera toward the open interior of the arena
  let lateralBias = 1.0;
  if (directorState) {
    if (!directorState.initialized) {
      if (Math.abs(ballX) > 220.0) {
        lateralBias = usX * (-ballX) >= 0 ? 1.0 : -1.0;
      } else if (Math.abs(carX - ballX) > 100.0) {
        lateralBias = (carX - ballX) * usX >= 0 ? 1.0 : -1.0;
      } else {
        lateralBias = 1.0;
      }
      directorState.lateralBias = lateralBias;
    } else {
      lateralBias = directorState.lateralBias || 1.0;
    }
  } else {
    lateralBias = Math.abs(ballX) > 220.0 ? (usX * (-ballX) >= 0 ? 1.0 : -1.0) : 1.0;
  }

  const progress = clamp(options.progress ?? 0.5, 0, 1);

  // Goal-box settle weight: 0 in backfield/midfield, 1 when ball is inside the final 550 UU of the net
  const goalSettleWeight = smoothstep(1850.0, 550.0, distToGoal);

  // Primary striker framing weight (up to 44% when within ~2500 UU of ball)
  const carFramingFactor = hasFocusCar
    ? (1.0 - smoothstep(650.0, 2500.0, carToBallDist)) * (1.0 - goalSettleWeight * 0.7)
    : 0.0;
  const maxCarWeight = REPLAY_DIRECTOR_CONFIG.carMidpointMaxWeight ?? 0.44;
  const carMidWeight = carFramingFactor * maxCarWeight * (1.0 - nextTouchBlend * 0.45);
  const nextMidWeight = nextTouchBlend * (1.0 - goalSettleWeight * 0.75);
  const ballMidWeight = Math.max(0.0, 1.0 - carMidWeight - nextMidWeight);

  // Composite two-touch midpoint (Ball + T1 Striker + T2 Anticipated Touch)
  const midX = ballX * ballMidWeight + carX * carMidWeight + lookaheadX * nextMidWeight;
  const midY = ballY * ballMidWeight + carY * carMidWeight + lookaheadY * nextMidWeight;
  const midZ = ballZ * ballMidWeight + carZ * carMidWeight + lookaheadZ * nextMidWeight;

  // Dynamic frustum pull-back: encompass BOTH the current striker-ball span AND the upcoming 2nd touch span
  const primarySpan = clamp(carToBallDist, 0.0, 1800.0) * carFramingFactor;
  const twoTouchSpan = clamp(lookaheadToBallDist, 0.0, 2200.0) * nextMidWeight;
  const effectiveSpan = Math.max(primarySpan, twoTouchSpan * 0.85);
  const extraPullBack = effectiveSpan * 0.36;
  const extraSidePull = effectiveSpan * 0.26;

  // 1. Corridor Trail Pose (Frames the 2-touch composite midpoint along the Ball -> Goal corridor)
  const backStart = REPLAY_DIRECTOR_CONFIG.corridorBackDistStart ?? 780.0;
  const backEnd = REPLAY_DIRECTOR_CONFIG.corridorBackDistEnd ?? 600.0;
  const sideBase = REPLAY_DIRECTOR_CONFIG.corridorSideDistBase ?? 550.0;

  const trailBackDist = (backStart - progress * (backStart - backEnd)) + extraPullBack;
  const trailSideDist = sideBase + Math.sin(progress * Math.PI) * 100.0 + extraSidePull;
  const trailEyeX = midX - ugX * trailBackDist + usX * (trailSideDist * lateralBias);
  const trailEyeY = midY - ugY * trailBackDist + usY * (trailSideDist * lateralBias);
  const trailEyeZ = clamp(250.0 + midZ * 0.52 + effectiveSpan * 0.08, 220.0, 940.0);

  // 2. Goal-Box Showcase Pose (Brakes and settles ~1250 UU in front of the net as the ball arrives)
  // Uses a continuous netSideBlend aligned with the established corridor lateral side so goal-box X never flips abruptly
  const showcaseDist = REPLAY_DIRECTOR_CONFIG.goalBoxShowcaseDist ?? 1250.0;
  const corridorSideX = usX * lateralBias >= 0 ? 1.0 : -1.0;
  const ballSideX = clamp(-ballX / 420.0, -1.0, 1.0);
  const netSideBlend = clamp(corridorSideX * 0.65 + ballSideX * 0.35, -1.0, 1.0);
  const goalBoxEyeX = clamp(ballX * 0.32 + netSideBlend * 640.0, -1950.0, 1950.0);
  const goalBoxEyeY = goalY - goalSignY * showcaseDist;
  const goalBoxEyeZ = clamp(290.0 + ballZ * 0.35, 250.0, 680.0);

  let rawEyeX = trailEyeX * (1.0 - goalSettleWeight) + goalBoxEyeX * goalSettleWeight;
  let rawEyeY = trailEyeY * (1.0 - goalSettleWeight) + goalBoxEyeY * goalSettleWeight;
  const rawEyeZ = trailEyeZ * (1.0 - goalSettleWeight) + goalBoxEyeZ * goalSettleWeight;

  // Keep a minimum horizontal standoff radius from BOTH the ball and the active touch car
  const dxBall = rawEyeX - ballX;
  const dyBall = rawEyeY - ballY;
  const horizDistToBall = Math.hypot(dxBall, dyBall);
  if (horizDistToBall < 440.0) {
    if (horizDistToBall > 1e-3) {
      const push = 440.0 / horizDistToBall;
      rawEyeX = ballX + dxBall * push;
      rawEyeY = ballY + dyBall * push;
    } else {
      rawEyeX = ballX + usX * lateralBias * 440.0;
      rawEyeY = ballY + usY * lateralBias * 440.0;
    }
  }

  if (hasFocusCar && carFramingFactor > 0.15) {
    const dxCar = rawEyeX - carX;
    const dyCar = rawEyeY - carY;
    const horizDistToCar = Math.hypot(dxCar, dyCar);
    if (horizDistToCar < 360.0 && horizDistToCar > 1e-3) {
      const pushCar = 360.0 / horizDistToCar;
      rawEyeX = carX + dxCar * pushCar;
      rawEyeY = carY + dyCar * pushCar;
    }
  }

  const clampedEye = clampPositionInsideArena(rawEyeX, rawEyeY, rawEyeZ);

  // 3. AutoCam Gaze Target (Aims at the 2-Touch Composite Midpoint, then into the net)
  const carFocusWeight = carMidWeight * 0.95;
  const nextFocusWeight = nextMidWeight * 0.85;
  const goalFocusWeight = 0.06 + goalSettleWeight * 0.18;
  const ballFocusWeight = Math.max(0.0, 1.0 - carFocusWeight - nextFocusWeight - goalFocusWeight);

  const rawTargetX =
    ballX * ballFocusWeight +
    carX * carFocusWeight +
    lookaheadX * nextFocusWeight +
    0.0 * goalFocusWeight +
    ballVelX * 0.035;
  const rawTargetY =
    ballY * ballFocusWeight +
    carY * carFocusWeight +
    lookaheadY * nextFocusWeight +
    goalY * goalFocusWeight +
    ballVelY * 0.035;
  const rawTargetZ = clamp(
    (ballZ + 18.0) * ballFocusWeight +
    (carZ + 32.0) * carFocusWeight +
    (lookaheadZ + 24.0) * nextFocusWeight +
    goalZ * goalFocusWeight +
    ballVelZ * 0.025,
    90.0,
    1650.0
  );

  // 4. Damped camera progression
  if (directorState) {
    const jumpDist = directorState.initialized
      ? Math.hypot(
          clampedEye.x - directorState.eyeX,
          clampedEye.y - directorState.eyeY,
          clampedEye.z - directorState.eyeZ
        )
      : Infinity;

    if (!directorState.initialized || jumpDist > 4200.0) {
      directorState.eyeX = clampedEye.x;
      directorState.eyeY = clampedEye.y;
      directorState.eyeZ = clampedEye.z;
      directorState.targetX = rawTargetX;
      directorState.targetY = rawTargetY;
      directorState.targetZ = rawTargetZ;
      directorState.initialized = true;
    } else {
      const eyeRate = REPLAY_DIRECTOR_CONFIG.eyeDampingRate ?? 3.8;
      const gazeRate = REPLAY_DIRECTOR_CONFIG.gazeDampingRate ?? 7.5;
      const eyeAlpha = 1.0 - Math.exp(-dt * eyeRate);
      const targetAlpha = 1.0 - Math.exp(-dt * gazeRate);
      directorState.eyeX += (clampedEye.x - directorState.eyeX) * eyeAlpha;
      directorState.eyeY += (clampedEye.y - directorState.eyeY) * eyeAlpha;
      directorState.eyeZ += (clampedEye.z - directorState.eyeZ) * eyeAlpha;
      directorState.targetX += (rawTargetX - directorState.targetX) * targetAlpha;
      directorState.targetY += (rawTargetY - directorState.targetY) * targetAlpha;
      directorState.targetZ += (rawTargetZ - directorState.targetZ) * targetAlpha;
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
      targetZ: directorState.targetZ
    };
  }

  return {
    eyeX: clampedEye.x,
    eyeY: clampedEye.y,
    eyeZ: clampedEye.z,
    targetX: rawTargetX,
    targetY: rawTargetY,
    targetZ: rawTargetZ
  };
}

/**
 * Applies the Rocket League AutoCam Director pose to the active Three.js camera.
 * Supports both:
 *  - 4-arg object signature: (cameraManager, stepResOrInterpolator, optionsObj, dt)
 *  - 7-arg positional signature: (cameraManager, interpolator, progress, scoringTeam, dt, scorerCarIndex, directorState)
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
  let directorState = null;
  let dt = 0.016;

  if (typeof optionsOrProgress === 'number') {
    // 7-argument positional call: (camera, interpolator, progress, scoringTeam, dt, scorerCarIndex, directorState)
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
  } else {
    // 4-argument object call: (camera, stepRes, options, dt)
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
  }

  if (!currFrame) return;

  const pose = computeGoalReplayCameraPose(currFrame, scoringTeam, {
    prevStateBuffer: prevFrame || currFrame,
    alpha,
    scorerCarIndex,
    progress,
    directorState,
    dt
  });

  // Unreal (X, Y, Z) -> Three.js (X, Z, Y)
  cam.position.set(pose.eyeX, pose.eyeZ, pose.eyeY);
  cam.lookAt(pose.targetX, pose.targetZ, pose.targetY);
}
