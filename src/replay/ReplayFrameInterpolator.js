/**
 * ReplayFrameInterpolator.js
 * Applies compact 448-float GameStateBufferPod replay frames
 * to RocketSimPhysicsEngine and PhysicsStateInterpolator, and interpolates snapshots.
 */

import {
  SIM_OFFSETS,
  BALL_STATE_STRIDE,
  CAR_STATE_STRIDE,
  MAX_CARS,
} from '../physics/RocketSimConstants.js';

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

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

  if (
    engine.state &&
    headerCars <= 7 &&
    frameBuffer.length >= REPLAY_DIRECTOR_TELEMETRY_OFFSET + 10 &&
    engine.state.length >= REPLAY_DIRECTOR_TELEMETRY_OFFSET + 10 &&
    Math.abs(frameBuffer[REPLAY_DIRECTOR_TELEMETRY_OFFSET] - REPLAY_DIRECTOR_MAGIC) <= 0.01
  ) {
    const telemetryLen = Math.min(
      28,
      frameBuffer.length - REPLAY_DIRECTOR_TELEMETRY_OFFSET,
      engine.state.length - REPLAY_DIRECTOR_TELEMETRY_OFFSET
    );
    engine.state
      .subarray(REPLAY_DIRECTOR_TELEMETRY_OFFSET, REPLAY_DIRECTOR_TELEMETRY_OFFSET + telemetryLen)
      .set(frameBuffer.subarray(REPLAY_DIRECTOR_TELEMETRY_OFFSET, REPLAY_DIRECTOR_TELEMETRY_OFFSET + telemetryLen));
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

export const REPLAY_DIRECTOR_MAGIC = 1337.5;
export const REPLAY_DIRECTOR_TELEMETRY_OFFSET = SIM_OFFSETS.CARS + 7 * CAR_STATE_STRIDE; // 302 (Slot 7, unused in 1v1/2v2/3v3)

/**
 * Embeds authoritative server-computed Suffix Safe-Zone trajectory & Contact/Interceptor anchors
 * into unused car slot 7 of a 448-float GameStateBufferPod snapshot so client Director Camera
 * can smoothly follow the planned pose without needing the full replay buffer locally.
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
  const resolvedProgress =
    typeof directorState.progress === 'number' && Number.isFinite(directorState.progress)
      ? directorState.progress
      : typeof progress === 'number' && Number.isFinite(progress)
        ? progress
        : 0;
  targetBuffer[base + 8] = resolvedProgress;
  targetBuffer[base + 9] = typeof directorState.postGoalElapsedSec === 'number' ? directorState.postGoalElapsedSec : 0;
  if (targetBuffer.length >= base + 12) {
    targetBuffer[base + 10] =
      typeof directorState.lateralBias === 'number' && directorState.lateralBias !== 0
        ? directorState.lateralBias
        : 0;
    targetBuffer[base + 11] =
      typeof directorState.scorerCarIndex === 'number' ? directorState.scorerCarIndex : -1;
  }
  if (targetBuffer.length >= base + 27) {
    targetBuffer[base + 12] =
      typeof directorState.interceptorCarIndex === 'number' ? directorState.interceptorCarIndex : -1;
    targetBuffer[base + 13] =
      typeof directorState.interceptorBlend === 'number' ? directorState.interceptorBlend : 0;
    const pp = directorState.plannedPose;
    if (pp && typeof pp.eyeX === 'number' && Number.isFinite(pp.eyeX)) {
      targetBuffer[base + 14] = 1.0;
      targetBuffer[base + 15] = pp.eyeX || 0;
      targetBuffer[base + 16] = pp.eyeY || 0;
      targetBuffer[base + 17] = pp.eyeZ || 0;
      targetBuffer[base + 18] = pp.targetX || 0;
      targetBuffer[base + 19] = pp.targetY || 0;
      targetBuffer[base + 20] = pp.targetZ || 0;
      targetBuffer[base + 21] = pp.rawEyeX ?? pp.eyeX ?? 0;
      targetBuffer[base + 22] = pp.rawEyeY ?? pp.eyeY ?? 0;
      targetBuffer[base + 23] = pp.rawEyeZ ?? pp.eyeZ ?? 0;
      targetBuffer[base + 24] = pp.rawTargetX ?? pp.targetX ?? 0;
      targetBuffer[base + 25] = pp.rawTargetY ?? pp.targetY ?? 0;
      targetBuffer[base + 26] = pp.rawTargetZ ?? pp.targetZ ?? 0;
    } else {
      targetBuffer[base + 14] = 0.0;
    }
  }
  return targetBuffer;
}

/**
 * Extracts authoritative server-computed Suffix Safe-Zone & Contact/Interceptor anchors from a 448-float snapshot
 * if present.
 */
export function decodeReplayDirectorTelemetryFromState(stateBuffer) {
  if (!stateBuffer || stateBuffer.length < REPLAY_DIRECTOR_TELEMETRY_OFFSET + 10) return null;
  const numCars = Math.round(stateBuffer[SIM_OFFSETS.NUM_CARS] || 0);
  if (numCars > 7) return null;
  const base = REPLAY_DIRECTOR_TELEMETRY_OFFSET;
  if (Math.abs(stateBuffer[base] - REPLAY_DIRECTOR_MAGIC) > 0.01) return null;

  const hasNextPos = stateBuffer[base + 7] > 0.5;
  const hasExtended = stateBuffer.length >= base + 12;
  const rawLateralBias = hasExtended ? stateBuffer[base + 10] : 0;
  const rawScorerCarIdx = hasExtended ? Math.round(stateBuffer[base + 11]) : -1;
  const hasInterceptorAndPose = stateBuffer.length >= base + 27;
  const interceptorCarIndex = hasInterceptorAndPose ? Math.round(stateBuffer[base + 12]) : -1;
  const interceptorBlend = hasInterceptorAndPose ? clamp(stateBuffer[base + 13] || 0, 0, 1) : 0;
  const hasPlannedPose = hasInterceptorAndPose && stateBuffer[base + 14] > 0.5;
  const plannedPose = hasPlannedPose
    ? {
        eyeX: stateBuffer[base + 15],
        eyeY: stateBuffer[base + 16],
        eyeZ: stateBuffer[base + 17],
        targetX: stateBuffer[base + 18],
        targetY: stateBuffer[base + 19],
        targetZ: stateBuffer[base + 20],
        rawEyeX: stateBuffer[base + 21],
        rawEyeY: stateBuffer[base + 22],
        rawEyeZ: stateBuffer[base + 23],
        rawTargetX: stateBuffer[base + 24],
        rawTargetY: stateBuffer[base + 25],
        rawTargetZ: stateBuffer[base + 26],
      }
    : null;

  return {
    activeTouchCarIndex: Math.round(stateBuffer[base + 1]),
    nextTouchCarIndex: Math.round(stateBuffer[base + 2]),
    nextTouchBlend: clamp(stateBuffer[base + 3] || 0, 0, 1),
    nextTouchBallPos: hasNextPos
      ? { x: stateBuffer[base + 4], y: stateBuffer[base + 5], z: stateBuffer[base + 6] }
      : null,
    progress: clamp(stateBuffer[base + 8] || 0, 0, 1),
    postGoalElapsedSec: Math.max(0, stateBuffer[base + 9] || 0),
    lateralBias: Math.abs(rawLateralBias) > 0.1 ? (rawLateralBias > 0 ? 1.0 : -1.0) : null,
    scorerCarIndex: rawScorerCarIdx >= 0 ? rawScorerCarIdx : -1,
    interceptorCarIndex: interceptorCarIndex >= 0 ? interceptorCarIndex : -1,
    interceptorBlend,
    plannedPose,
  };
}

/**
 * Linearly interpolates continuous physical quantities (ball & car positions, velocities,
 * forward/up vectors, and embedded planned camera poses) between two 448-float snapshots
 * for server-side dramatic slow-motion streaming.
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
  const tBase = REPLAY_DIRECTOR_TELEMETRY_OFFSET;
  if (
    numCars <= 7 &&
    currSnap.length >= tBase + 27 &&
    prevSnap.length >= tBase + 27 &&
    Math.abs(currSnap[tBase] - REPLAY_DIRECTOR_MAGIC) <= 0.01 &&
    Math.abs(prevSnap[tBase] - REPLAY_DIRECTOR_MAGIC) <= 0.01 &&
    currSnap[tBase + 14] > 0.5 &&
    prevSnap[tBase + 14] > 0.5
  ) {
    lerpIdx(tBase + 3);
    lerpIdx(tBase + 8);
    lerpIdx(tBase + 9);
    lerpIdx(tBase + 13);
    for (let k = 15; k <= 26; k++) {
      lerpIdx(tBase + k);
    }
  }
  return out;
}
