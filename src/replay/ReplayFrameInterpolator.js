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
    engine.restoreState(frameBuffer, { preserveEngineTick: true });
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
  corridorBackDistStart: 760.0,      // Base distance behind rearmost subject at start of replay
  corridorBackDistEnd: 640.0,        // Base distance behind rearmost subject near end of replay
  corridorSideDistBase: 520.0,       // Base lateral offset toward open field interior
  goalBoxShowcaseDist: 1150.0,       // Settle distance in front of the net
  carMidpointMaxWeight: 0.48,        // Angular ray weight on striker car pre-goal (bisects Car & Ball)
  postGoalExplosionStretchDist: 780.0,     // Fast backward pull-back distance on goal explosion (UU)
  postGoalExplosionStretchDuration: 0.36,  // Duration of fast backward pull-back stretch (seconds)
  postGoalScorerFollowTransitionSec: 0.28, // Transition time to lock 100% onto scorer car post-goal (seconds)
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
  targetBuffer[base + 9] = typeof directorState.postGoalElapsedSec === 'number' ? directorState.postGoalElapsedSec : 0;
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
    postGoalElapsedSec: Math.max(0, stateBuffer[base + 9] || 0),
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
 * Pre-Goal Phase (Two-Subject Rearmost Corridor + Unit-Ray Bisector Framing):
 * - Positions the camera eye behind the smooth rearmost longitudinal point of (Striker Car, Ball)
 *   along the Ball -> Goal attack corridor so the camera NEVER lands between the car and the ball
 *   with its back turned to the striker, even when the striker approaches from 4000+ UU away.
 * - Aims the camera gaze along the weighted unit-ray angular bisector between the Striker Car
 *   and the Ball (+ 2-touch lookahead), guaranteeing that both the Striker Car and the Ball stay
 *   within ~18 deg of screen center throughout the entire pre-goal sequence.
 *
 * Post-Goal Phase (Goal Explosion Fast Pull-Back Stretch + Scorer Follow):
 * - Upon goal-line crossing, triggers a fast C1 backward pull-back stretch away from the goal
 *   explosion while dropping ball focus to 0 and locking camera follow & gaze onto the scorer car.
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
    if (typeof embeddedTelemetry.postGoalElapsedSec === 'number') {
      directorState.postGoalElapsedSec = embeddedTelemetry.postGoalElapsedSec;
    }
  }
  const dt = options.exactDt
    ? Math.max(1e-4, Number(options.dt) || 1 / 120)
    : clamp(options.dt ?? 0.016, 0.001, 0.1);
  const skipDamping = Boolean(options.skipDamping);

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
  const rawCarVelX = hasFocusCar ? (lerpBuf(carBase + 12) || 0) : 0;
  const rawCarVelY = hasFocusCar ? (lerpBuf(carBase + 13) || 0) : 0;
  const rawCarVelZ = hasFocusCar ? (lerpBuf(carBase + 14) || 0) : 0;

  // Smooth ball & car velocity feedforward and car position (absorbing kickoff-reset teleports or car switches)
  let ffBallVelX = ballVelX;
  let ffBallVelY = ballVelY;
  let ffBallVelZ = ballVelZ;
  let ffCarVelX = rawCarVelX;
  let ffCarVelY = rawCarVelY;
  let ffCarVelZ = rawCarVelZ;
  let carX = rawCarX;
  let carY = rawCarY;
  let carZ = rawCarZ;

  if (directorState) {
    if (!directorState.initialized || typeof directorState.smoothedCarX !== 'number') {
      const settled = directorState.initialSettledCarPos;
      const initCarX = settled && typeof settled.x === 'number' ? settled.x : rawCarX;
      const initCarY = settled && typeof settled.y === 'number' ? settled.y : rawCarY;
      const initCarZ = settled && typeof settled.z === 'number' ? settled.z : rawCarZ;
      if (!skipDamping) {
        directorState.smoothedCarX = initCarX;
        directorState.smoothedCarY = initCarY;
        directorState.smoothedCarZ = initCarZ;
        directorState.smoothedCarVelX = rawCarVelX;
        directorState.smoothedCarVelY = rawCarVelY;
        directorState.smoothedCarVelZ = rawCarVelZ;
        directorState.smoothedBallVelX = ballVelX;
        directorState.smoothedBallVelY = ballVelY;
        directorState.smoothedBallVelZ = ballVelZ;
        directorState.lastTrackedCarIndex = preferredCarIdx;
        directorState.carSwitchBlend = 1.0;
      }
      carX = directorState.smoothedCarX ?? initCarX;
      carY = directorState.smoothedCarY ?? initCarY;
      carZ = directorState.smoothedCarZ ?? initCarZ;
      ffCarVelX = directorState.smoothedCarVelX ?? rawCarVelX;
      ffCarVelY = directorState.smoothedCarVelY ?? rawCarVelY;
      ffCarVelZ = directorState.smoothedCarVelZ ?? rawCarVelZ;
      ffBallVelX = directorState.smoothedBallVelX ?? ballVelX;
      ffBallVelY = directorState.smoothedBallVelY ?? ballVelY;
      ffBallVelZ = directorState.smoothedBallVelZ ?? ballVelZ;
    } else {
      const velAlpha = 1.0 - Math.exp(-dt * 9.0);
      const nextBvx = directorState.smoothedBallVelX + (ballVelX - directorState.smoothedBallVelX) * velAlpha;
      const nextBvy = directorState.smoothedBallVelY + (ballVelY - directorState.smoothedBallVelY) * velAlpha;
      const nextBvz = directorState.smoothedBallVelZ + (ballVelZ - directorState.smoothedBallVelZ) * velAlpha;
      const nextCvx = (directorState.smoothedCarVelX ?? rawCarVelX) + (rawCarVelX - (directorState.smoothedCarVelX ?? rawCarVelX)) * velAlpha;
      const nextCvy = (directorState.smoothedCarVelY ?? rawCarVelY) + (rawCarVelY - (directorState.smoothedCarVelY ?? rawCarVelY)) * velAlpha;
      const nextCvz = (directorState.smoothedCarVelZ ?? rawCarVelZ) + (rawCarVelZ - (directorState.smoothedCarVelZ ?? rawCarVelZ)) * velAlpha;

      let lastTracked = directorState.lastTrackedCarIndex;
      let switchBlend = directorState.carSwitchBlend ?? 1.0;
      if (lastTracked !== preferredCarIdx) {
        lastTracked = preferredCarIdx;
        switchBlend = 0.0;
      }
      const switchRate = Math.max(0.5, REPLAY_DIRECTOR_CONFIG.strikerSwitchDampingRate ?? 4.2);
      const trackRate = switchBlend < 0.995 ? switchRate : 14.0;
      const carAlpha = 1.0 - Math.exp(-dt * trackRate);
      if (switchBlend < 0.995) {
        switchBlend = Math.min(1.0, switchBlend + dt * switchRate * 0.65);
      }
      const nextCarX = directorState.smoothedCarX + (rawCarX - directorState.smoothedCarX) * carAlpha;
      const nextCarY = directorState.smoothedCarY + (rawCarY - directorState.smoothedCarY) * carAlpha;
      const nextCarZ = directorState.smoothedCarZ + (rawCarZ - directorState.smoothedCarZ) * carAlpha;

      if (!skipDamping) {
        directorState.lastTrackedCarIndex = lastTracked;
        directorState.carSwitchBlend = switchBlend;
        directorState.smoothedCarX = nextCarX;
        directorState.smoothedCarY = nextCarY;
        directorState.smoothedCarZ = nextCarZ;
        directorState.smoothedCarVelX = nextCvx;
        directorState.smoothedCarVelY = nextCvy;
        directorState.smoothedCarVelZ = nextCvz;
        directorState.smoothedBallVelX = nextBvx;
        directorState.smoothedBallVelY = nextBvy;
        directorState.smoothedBallVelZ = nextBvz;
      }
      carX = nextCarX;
      carY = nextCarY;
      carZ = nextCarZ;
      ffCarVelX = nextCvx;
      ffCarVelY = nextCvy;
      ffCarVelZ = nextCvz;
      ffBallVelX = nextBvx;
      ffBallVelY = nextBvy;
      ffBallVelZ = nextBvz;
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

  let lookaheadX = ballX;
  let lookaheadY = ballY;
  let lookaheadZ = ballZ;
  if (nextTouchBlend > 1e-4) {
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

  // Direction unit vector from ball to back of target net (5420 UU so toGoalY never flips sign at the 5120 goal line)
  const anchorGoalY = goalSignY * 5420.0;
  const toGoalX = 0.0 - ballX;
  const toGoalY = goalSignY * Math.max(420.0, (anchorGoalY - ballY) * goalSignY);
  const dirNorm = Math.hypot(toGoalX, toGoalY) || 1.0;
  const ugX = toGoalX / dirNorm;
  const ugY = toGoalY / dirNorm;

  // Perpendicular lateral unit vector in XY plane
  const usX = -ugY;
  const usY = ugX;

  const carToBallDist = Math.hypot(ballX - carX, ballY - carY, ballZ - carZ);
  const lookaheadToBallDist = nextTouchBlend > 1e-4
    ? Math.hypot(lookaheadX - ballX, lookaheadY - ballY, lookaheadZ - ballZ)
    : 0.0;

  // Pick a consistent lateral vantage side that places the camera toward the open interior of the arena
  let lateralBias = 1.0;
  if (directorState) {
    if (directorState.hasResolvedInitialLateralBias && (directorState.lateralBias === 1.0 || directorState.lateralBias === -1.0)) {
      lateralBias = directorState.lateralBias;
    } else if (!directorState.initialized) {
      if (Math.abs(ballX) > 220.0) {
        lateralBias = usX * (-ballX) >= 0 ? 1.0 : -1.0;
      } else if (Math.abs(carX - ballX) > 100.0) {
        lateralBias = (carX - ballX) * usX >= 0 ? 1.0 : -1.0;
      } else {
        lateralBias = directorState.lateralBias || 1.0;
      }
      if (!skipDamping) {
        directorState.lateralBias = lateralBias;
        directorState.hasResolvedInitialLateralBias = true;
      }
    } else {
      lateralBias = directorState.lateralBias || 1.0;
    }
  } else {
    lateralBias = Math.abs(ballX) > 220.0 ? (usX * (-ballX) >= 0 ? 1.0 : -1.0) : 1.0;
  }

  const progress = clamp(options.progress ?? 0.5, 0, 1);

  // Determine post-goal elapsed time (seconds after goalLineFrameIdx / goal explosion)
  let postGoalSec = 0.0;
  if (directorState && typeof directorState.postGoalElapsedSec === 'number') {
    postGoalSec = Math.max(0.0, directorState.postGoalElapsedSec);
  } else if (Math.abs(ballY) >= 5100.0 || (directorState && (directorState.postGoalTimer ?? 0) > 0)) {
    if (directorState && !skipDamping) {
      directorState.postGoalTimer = (directorState.postGoalTimer ?? 0) + dt;
      postGoalSec = directorState.postGoalTimer;
    } else if (directorState) {
      postGoalSec = directorState.postGoalTimer ?? 0;
    }
  } else if (directorState && !skipDamping) {
    directorState.postGoalTimer = 0.0;
  }

  const stretchDur = Math.max(0.1, REPLAY_DIRECTOR_CONFIG.postGoalExplosionStretchDuration ?? 0.36);
  const followTransSec = Math.max(0.08, REPLAY_DIRECTOR_CONFIG.postGoalScorerFollowTransitionSec ?? 0.28);
  const postStretchU = clamp(postGoalSec / stretchDur, 0.0, 1.0);
  const postStretch = postStretchU * postStretchU * (3.0 - 2.0 * postStretchU);
  const postFollowWeight = smoothstep(0.0, followTransSec, postGoalSec);

  // 1. Pre-Goal Rearmost Corridor Anchor:
  // Always place the pre-goal camera behind the smooth longitudinal minimum of (Striker Car, Ball)
  // along `ug` so the camera NEVER lands between the car and the ball with its back to the striker.
  const effBallX = ballX * (1.0 - nextTouchBlend * 0.55) + lookaheadX * (nextTouchBlend * 0.55);
  const effBallY = ballY * (1.0 - nextTouchBlend * 0.55) + lookaheadY * (nextTouchBlend * 0.55);
  const effBallZ = ballZ * (1.0 - nextTouchBlend * 0.55) + lookaheadZ * (nextTouchBlend * 0.55);

  const carBehindBall = (effBallX - carX) * ugX + (effBallY - carY) * ugY;
  const carSideOfBall = (carX - effBallX) * usX + (carY - effBallY) * usY;
  const deltaRear = 0.5 * (carBehindBall + Math.hypot(carBehindBall, 160.0));
  const rearCarWeight = hasFocusCar ? smoothstep(-200.0, 350.0, carBehindBall) : 0.0;

  const rearAnchorX = effBallX - ugX * deltaRear + usX * (carSideOfBall * rearCarWeight * 0.82);
  const rearAnchorY = effBallY - ugY * deltaRear + usY * (carSideOfBall * rearCarWeight * 0.82);
  const rearAnchorZ = effBallZ * (1.0 - 0.65 * rearCarWeight) + carZ * (0.65 * rearCarWeight);

  const backStart = REPLAY_DIRECTOR_CONFIG.corridorBackDistStart ?? 760.0;
  const backEnd = REPLAY_DIRECTOR_CONFIG.corridorBackDistEnd ?? 640.0;
  const sideBase = REPLAY_DIRECTOR_CONFIG.corridorSideDistBase ?? 520.0;
  const showcaseDist = REPLAY_DIRECTOR_CONFIG.goalBoxShowcaseDist ?? 1150.0;

  const effectiveSpan = Math.max(
    Math.min(1400.0, carToBallDist),
    Math.min(1600.0, lookaheadToBallDist) * 0.85
  );
  const trailBackDist = (backStart - progress * (backStart - backEnd)) + effectiveSpan * 0.12;
  const trailSideDist = sideBase + Math.sin(progress * Math.PI) * 80.0 + effectiveSpan * 0.08;

  let preEyeX = rearAnchorX - ugX * trailBackDist + usX * (trailSideDist * lateralBias);
  let preEyeY = rearAnchorY - ugY * trailBackDist + usY * (trailSideDist * lateralBias);
  const preEyeZ = clamp(250.0 + rearAnchorZ * 0.52 + effectiveSpan * 0.05, 220.0, 920.0);

  // Softly brake preEyeY in front of the goal mouth so the pre-goal camera never enters the net
  const maxGoalFrontY = goalY - goalSignY * showcaseDist;
  const frontDiffY = (preEyeY - maxGoalFrontY) * goalSignY;
  const brakedDeltaY = 0.5 * (frontDiffY + Math.hypot(frontDiffY, 140.0));
  preEyeY -= goalSignY * brakedDeltaY;

  if (directorState && !skipDamping && (postGoalSec <= 0.0 || typeof directorState.goalAnchorEyeY !== 'number')) {
    directorState.goalAnchorEyeX = preEyeX;
    directorState.goalAnchorEyeY = preEyeY;
    directorState.goalAnchorEyeZ = preEyeZ;
  }

  // 2. Post-Goal Fast Backward Explosion Stretch + Scorer Follow ("往后一个快速的拉伸，跟随进球者，不再focus到球"):
  // Anchors to the scorer car while rapidly pulling backward away from the goal explosion along -goalSignY.
  const stretchDist = REPLAY_DIRECTOR_CONFIG.postGoalExplosionStretchDist ?? 780.0;
  const postBackDist = 780.0 + postStretch * stretchDist;
  const interiorPullX = -clamp(carX * 0.28, -480.0, 480.0) + (-goalSignY * lateralBias) * 440.0;
  const postEyeX = carX + interiorPullX;
  const carFollowEyeY = carY - goalSignY * postBackDist;
  const anchorEyeY = directorState?.goalAnchorEyeY ?? preEyeY;
  const explosionPullY = anchorEyeY - goalSignY * (postStretch * (stretchDist * 0.92));
  const diffPostY = (explosionPullY - carFollowEyeY) * goalSignY;
  const smoothMinPostY = 0.5 * (diffPostY - Math.hypot(diffPostY, 180.0));
  const postEyeY = carFollowEyeY + goalSignY * smoothMinPostY;
  const postEyeZ = clamp(260.0 + carZ * 0.52 + postStretch * 175.0, 230.0, 960.0);

  const rawEyeX = preEyeX * (1.0 - postFollowWeight) + postEyeX * postFollowWeight;
  const rawEyeY = preEyeY * (1.0 - postFollowWeight) + postEyeY * postFollowWeight;
  const rawEyeZ = preEyeZ * (1.0 - postFollowWeight) + postEyeZ * postFollowWeight;

  const clampedEye = clampPositionInsideArena(rawEyeX, rawEyeY, rawEyeZ);

  // 3. AutoCam Gaze Target:
  // - Pre-goal: Unit-ray angular bisector between Striker Car and Ball (+ lookahead) so BOTH are guaranteed inside frustum.
  // - Post-goal: Transitions 100% onto the Scorer Car (ball focus weight drops to 0).
  const scorerTargetX = carX + ffCarVelX * 0.035;
  const scorerTargetY = carY + ffCarVelY * 0.035;
  const scorerTargetZ = clamp(carZ + 36.0 + ffCarVelZ * 0.022, 90.0, 1650.0);

  const ballTargetX = effBallX + ffBallVelX * 0.032;
  const ballTargetY = effBallY * 0.92 + goalY * 0.08 + ffBallVelY * 0.032;
  const ballTargetZ = clamp(effBallZ + 20.0 + ffBallVelZ * 0.022, 90.0, 1650.0);

  const vcX = scorerTargetX - clampedEye.x;
  const vcY = scorerTargetY - clampedEye.y;
  const vcZ = scorerTargetZ - clampedEye.z;
  const dc = Math.hypot(vcX, vcY, vcZ) || 1.0;
  const ucX = vcX / dc;
  const ucY = vcY / dc;
  const ucZ = vcZ / dc;

  const vbX = ballTargetX - clampedEye.x;
  const vbY = ballTargetY - clampedEye.y;
  const vbZ = ballTargetZ - clampedEye.z;
  const db = Math.hypot(vbX, vbY, vbZ) || 1.0;
  const ubX = vbX / db;
  const ubY = vbY / db;
  const ubZ = vbZ / db;

  const baseCarRayWeight = hasFocusCar
    ? clamp(REPLAY_DIRECTOR_CONFIG.carMidpointMaxWeight ?? 0.48, 0.25, 0.75)
    : 0.0;
  const rayCarWeight = hasFocusCar
    ? baseCarRayWeight + (1.0 - baseCarRayWeight) * postFollowWeight
    : 0.0;
  const rayBallWeight = 1.0 - rayCarWeight;

  const mixDirX = ucX * rayCarWeight + ubX * rayBallWeight;
  const mixDirY = ucY * rayCarWeight + ubY * rayBallWeight;
  const mixDirZ = ucZ * rayCarWeight + ubZ * rayBallWeight;
  const mixNorm = Math.hypot(mixDirX, mixDirY, mixDirZ) || 1.0;
  const targetDist = Math.pow(dc, rayCarWeight) * Math.pow(db, rayBallWeight);

  const rawTargetX = clampedEye.x + (mixDirX / mixNorm) * targetDist;
  const rawTargetY = clampedEye.y + (mixDirY / mixNorm) * targetDist;
  const rawTargetZ = clamp(clampedEye.z + (mixDirZ / mixNorm) * targetDist, 90.0, 1650.0);

  // 4. Damped camera progression (Critically-damped 2-stage cascade, accelerated during post-goal explosion stretch)
  if (directorState && !skipDamping) {
    const jumpDist = directorState.initialized
      ? Math.hypot(
          clampedEye.x - directorState.eyeX,
          clampedEye.y - directorState.eyeY,
          clampedEye.z - directorState.eyeZ
        )
      : Infinity;

    if (!directorState.initialized || jumpDist > 4200.0) {
      directorState.preEyeX = clampedEye.x;
      directorState.preEyeY = clampedEye.y;
      directorState.preEyeZ = clampedEye.z;
      directorState.preTargetX = rawTargetX;
      directorState.preTargetY = rawTargetY;
      directorState.preTargetZ = rawTargetZ;
      directorState.eyeX = clampedEye.x;
      directorState.eyeY = clampedEye.y;
      directorState.eyeZ = clampedEye.z;
      directorState.targetX = rawTargetX;
      directorState.targetY = rawTargetY;
      directorState.targetZ = rawTargetZ;
      directorState.initialized = true;
    } else {
      const baseEyeRate = REPLAY_DIRECTOR_CONFIG.eyeDampingRate ?? 3.8;
      const baseGazeRate = REPLAY_DIRECTOR_CONFIG.gazeDampingRate ?? 7.5;
      const eyeRate = baseEyeRate + postStretch * 4.5;
      const gazeRate = baseGazeRate + postStretch * 5.0;
      const preAlpha = 1.0 - Math.exp(-dt * 14.0);
      const eyeAlpha = 1.0 - Math.exp(-dt * eyeRate);
      const targetAlpha = 1.0 - Math.exp(-dt * gazeRate);

      directorState.preEyeX = (directorState.preEyeX ?? directorState.eyeX) + (clampedEye.x - (directorState.preEyeX ?? directorState.eyeX)) * preAlpha;
      directorState.preEyeY = (directorState.preEyeY ?? directorState.eyeY) + (clampedEye.y - (directorState.preEyeY ?? directorState.eyeY)) * preAlpha;
      directorState.preEyeZ = (directorState.preEyeZ ?? directorState.eyeZ) + (clampedEye.z - (directorState.preEyeZ ?? directorState.eyeZ)) * preAlpha;

      directorState.preTargetX = (directorState.preTargetX ?? directorState.targetX) + (rawTargetX - (directorState.preTargetX ?? directorState.targetX)) * preAlpha;
      directorState.preTargetY = (directorState.preTargetY ?? directorState.targetY) + (rawTargetY - (directorState.preTargetY ?? directorState.targetY)) * preAlpha;
      directorState.preTargetZ = (directorState.preTargetZ ?? directorState.targetZ) + (rawTargetZ - (directorState.preTargetZ ?? directorState.targetZ)) * preAlpha;

      directorState.eyeX += (directorState.preEyeX - directorState.eyeX) * eyeAlpha;
      directorState.eyeY += (directorState.preEyeY - directorState.eyeY) * eyeAlpha;
      directorState.eyeZ += (directorState.preEyeZ - directorState.eyeZ) * eyeAlpha;
      directorState.targetX += (directorState.preTargetX - directorState.targetX) * targetAlpha;
      directorState.targetY += (directorState.preTargetY - directorState.targetY) * targetAlpha;
      directorState.targetZ += (directorState.preTargetZ - directorState.targetZ) * targetAlpha;
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

  const isReplayFrozen = Boolean(stepOrInterpolator?.isPaused || stepOrInterpolator?.isScrubbing);
  const pose = computeGoalReplayCameraPose(currFrame, scoringTeam, {
    prevStateBuffer: prevFrame || currFrame,
    alpha,
    scorerCarIndex,
    progress,
    directorState,
    dt: isReplayFrozen ? 0.0 : dt,
    exactDt: isReplayFrozen,
  });

  // Unreal (X, Y, Z) -> Three.js (X, Z, Y)
  cam.position.set(pose.eyeX, pose.eyeZ, pose.eyeY);
  cam.lookAt(pose.targetX, pose.targetZ, pose.targetY);
}
