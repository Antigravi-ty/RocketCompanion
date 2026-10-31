/**
 * ReplayDirectorDiagnostics.js
 * Frame entity extraction, Director Camera diagnostic snapshot generation,
 * deterministic 120Hz full-window camera trajectory simulation, and JSON/CSV pattern export.
 */

import { REPLAY_TICK_RATE } from './ReplayRingBuffer.js';
import {
  SIM_OFFSETS,
  CAR_STATE_STRIDE,
  MAX_CARS,
  GAME_STATE_BUFFER_FLOATS,
  NUM_BOOST_PADS,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  INCIDENT_EVENT_TYPES,
  PHYSICS_EVENT_TYPES,
  MATCH_SIGNALS,
} from '../physics/RocketSimConstants.js';
import { resolveGoalReplayWindowBounds } from './ReplayPlaybackState.js';
import {
  computeGoalReplayCameraPose,
  resolveGoalExplosionFrameIndex,
} from './ReplayDirectorCamera.js';
import {
  decodeReplayDirectorTelemetryFromState,
  encodeReplayDirectorTelemetryIntoState,
} from './ReplayFrameInterpolator.js';
import {
  REPLAY_DIRECTOR_CONFIG,
  DEFAULT_REPLAY_DIRECTOR_CONFIG,
} from '../ui-core/config/replayDirectorConfig.js';
import { serializeRCReplayBinaryContainer } from './container/RCReplayBinaryEncoder.js';
import { deserializeRCReplayBinaryContainer } from './container/RCReplayBinaryDecoder.js';
import { isBinaryRCReplayContainer } from './container/RCReplayBinarySchema.js';
import { packAndCompressReplayInBackground } from './container/RCReplayCompressionWorkerClient.js';

export function round3(val) {
  return typeof val === 'number' && Number.isFinite(val) ? Number(val.toFixed(3)) : 0;
}

export function round4(val) {
  return typeof val === 'number' && Number.isFinite(val) ? Number(val.toFixed(4)) : 0;
}

export function computeCameraAnglesFromPose(pose) {
  const dx = (pose.targetX || 0) - (pose.eyeX || 0);
  const dy = (pose.targetY || 0) - (pose.eyeY || 0);
  const dz = (pose.targetZ || 0) - (pose.eyeZ || 0);
  const dist = Math.hypot(dx, dy, dz) || 1;
  const dirX = dx / dist;
  const dirY = dy / dist;
  const dirZ = dz / dist;
  const yawDeg = (Math.atan2(dirX, dirY) * 180) / Math.PI;
  const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, dirZ))) * 180) / Math.PI;
  return {
    distanceToTarget: round3(dist),
    forwardUnreal: [round4(dirX), round4(dirY), round4(dirZ)],
    yawDeg: round3(yawDeg),
    pitchDeg: round3(pitchDeg),
  };
}

export function extractFrameEntities(snap, carTeamResolver) {
  if (!snap || snap.length < SIM_OFFSETS.BALL + 18) {
    return {
      tick: 0,
      ball: { pos: [0, 0, 0], vel: [0, 0, 0], speedUu: 0, speedKph: 0 },
      cars: [],
    };
  }
  const tick = Math.round(snap[SIM_OFFSETS.TICK] || 0);
  const bx = snap[SIM_OFFSETS.BALL] || 0;
  const by = snap[SIM_OFFSETS.BALL + 1] || 0;
  const bz = snap[SIM_OFFSETS.BALL + 2] || 0;
  const bvx = snap[SIM_OFFSETS.BALL + 12] || 0;
  const bvy = snap[SIM_OFFSETS.BALL + 13] || 0;
  const bvz = snap[SIM_OFFSETS.BALL + 14] || 0;
  const bSpeed = Math.hypot(bvx, bvy, bvz);

  const numCars = Math.min(MAX_CARS, Math.max(0, Math.round(snap[SIM_OFFSETS.NUM_CARS] || 0)));
  const cars = [];
  for (let c = 0; c < numCars; c++) {
    const base = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
    if (snap.length < base + 25) break;
    const cx = snap[base] || 0;
    const cy = snap[base + 1] || 0;
    const cz = snap[base + 2] || 0;
    const fx = snap[base + 3] || 0;
    const fy = snap[base + 4] || 0;
    const fz = snap[base + 5] || 0;
    const ux = snap[base + 9] || 0;
    const uy = snap[base + 10] || 0;
    const uz = snap[base + 11] || 0;
    const vx = snap[base + 12] || 0;
    const vy = snap[base + 13] || 0;
    const vz = snap[base + 14] || 0;
    const speedUu = Math.hypot(vx, vy, vz);
    cars.push({
      carIndex: c,
      team: typeof carTeamResolver === 'function' ? carTeamResolver(c) : c % 2,
      pos: [round3(cx), round3(cy), round3(cz)],
      vel: [round3(vx), round3(vy), round3(vz)],
      fwd: [round4(fx), round4(fy), round4(fz)],
      up: [round4(ux), round4(uy), round4(uz)],
      speedUu: round3(speedUu),
      boost: round3(snap[base + 18] || 0),
      onGround: snap[base + 19] >= 0.5,
      supersonic: snap[base + 20] >= 0.5,
      demoed: snap[base + 21] > 0,
      isBoosting: snap[base + 23] >= 0.5,
      distToBall: round3(Math.hypot(cx - bx, cy - by, cz - bz)),
    });
  }

  return {
    tick,
    ball: {
      pos: [round3(bx), round3(by), round3(bz)],
      vel: [round3(bvx), round3(bvy), round3(bvz)],
      speedUu: round3(bSpeed),
      speedKph: Math.round(bSpeed * 0.036),
    },
    cars,
  };
}

/**
 * Builds a rich diagnostic snapshot of the current replay cursor frame,
 * including both the Replay Window Frame Index and Authoritative Simulation Tick (Frame ID),
 * live damped & raw Director Camera pose/orientation, 2-touch lookahead weights, and Ball/Car states.
 */
export function buildCurrentFrameDiagnosticSnapshot(ctrl) {
  const total = ctrl.ActiveWindowCount > 0 ? ctrl.ActiveWindowCount : ctrl.getTotalRecordedFrames();
  if (total <= 0) return null;
  const idx = Math.max(0, Math.min(total - 1, ctrl.currentFrameIndex));
  const entry = ctrl.getFrameEntryByIndex(idx);
  const snap = ctrl.getFrameBufferByIndex(idx);
  if (!snap) return null;

  const entities = extractFrameEntities(snap, ctrl.carTeamResolver);
  const frameId = entry?.tick ?? entities.tick ?? idx;
  const useCsvCam = Boolean(
    ctrl.isImportedPreview && ctrl.useRecordedCsvCamera && entry?.recordedCsvRow
  );
  const csvRow = entry?.recordedCsvRow || null;
  const suffixPlan = !useCsvCam ? ctrl.ensureSuffixCameraPlan?.() || null : null;
  const embedded = !suffixPlan ? decodeReplayDirectorTelemetryFromState(snap) : null;
  const progress =
    embedded && typeof embedded.progress === 'number' && total <= 1
      ? embedded.progress
      : total > 1
        ? idx / (total - 1)
        : 0;

  const lookahead = useCsvCam
    ? {
        primaryCarIndex: csvRow.active_touch_car_idx ?? (ctrl.scorerCarIndex ?? 0),
        nextCarIndex: csvRow.next_touch_car_idx ?? -1,
        nextTouchBlend: csvRow.next_touch_blend ?? 0,
        nextTouchBallPos: null,
        interceptorCarIndex: -1,
        interceptorBlend: 0,
        postGoalElapsedSec: 0,
      }
    : embedded
      ? {
          primaryCarIndex:
            embedded.activeTouchCarIndex >= 0
              ? embedded.activeTouchCarIndex
              : (ctrl.scorerCarIndex ?? 0),
          nextCarIndex: embedded.nextTouchCarIndex,
          nextTouchBlend: embedded.nextTouchBlend,
          nextTouchBallPos: embedded.nextTouchBallPos,
          interceptorCarIndex: embedded.interceptorCarIndex ?? -1,
          interceptorBlend: embedded.interceptorBlend ?? 0,
          postGoalElapsedSec: embedded.postGoalElapsedSec ?? 0,
        }
      : ctrl.resolveTouchLookaheadForFrame(
          idx,
          ctrl.directorCameraState.activeTouchCarIndex ?? ctrl.scorerCarIndex ?? 0
        );
  const slowMoFactor = useCsvCam
    ? (csvRow.slow_mo_factor ?? 1.0)
    : ctrl.computeDramaticSlowMoFactor(idx, { ignoreScrubState: true });

  const effectiveLateralBias = useCsvCam
    ? (csvRow.lateral_bias ?? 1.0)
    : suffixPlan && typeof suffixPlan.lateralBias === 'number'
      ? suffixPlan.lateralBias
      : embedded && typeof embedded.lateralBias === 'number' && embedded.lateralBias !== 0
        ? embedded.lateralBias
        : (ctrl.directorCameraState.lateralBias || 1.0);

  const rawPose = useCsvCam
    ? {
        eyeX: csvRow.raw_eye_x ?? csvRow.cam_eye_x ?? 0,
        eyeY: csvRow.raw_eye_y ?? csvRow.cam_eye_y ?? 0,
        eyeZ: csvRow.raw_eye_z ?? csvRow.cam_eye_z ?? 0,
        targetX: csvRow.raw_target_x ?? csvRow.cam_target_x ?? 0,
        targetY: csvRow.raw_target_y ?? csvRow.cam_target_y ?? 0,
        targetZ: csvRow.raw_target_z ?? csvRow.cam_target_z ?? 0,
      }
    : computeGoalReplayCameraPose(snap, ctrl.scoringTeam, {
        scorerCarIndex: ctrl.scorerCarIndex,
        progress,
        frameIndex: idx,
        suffixCameraPlan: suffixPlan,
        directorState: {
          ...ctrl.directorCameraState,
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

  let dampedPose = rawPose;
  if (useCsvCam) {
    dampedPose = {
      eyeX: csvRow.cam_eye_x ?? 0,
      eyeY: csvRow.cam_eye_y ?? 0,
      eyeZ: csvRow.cam_eye_z ?? 0,
      targetX: csvRow.cam_target_x ?? 0,
      targetY: csvRow.cam_target_y ?? 0,
      targetZ: csvRow.cam_target_z ?? 0,
    };
  } else if (suffixPlan && Array.isArray(suffixPlan.poses) && suffixPlan.poses[idx]) {
    dampedPose = computeGoalReplayCameraPose(snap, ctrl.scoringTeam, {
      scorerCarIndex: ctrl.scorerCarIndex,
      progress,
      frameIndex: idx,
      suffixCameraPlan: suffixPlan,
      dt: 1 / REPLAY_TICK_RATE,
      exactDt: true,
    });
  } else if (ctrl.directorCameraState.initialized) {
    dampedPose = {
      eyeX: ctrl.directorCameraState.eyeX,
      eyeY: ctrl.directorCameraState.eyeY,
      eyeZ: ctrl.directorCameraState.eyeZ,
      targetX: ctrl.directorCameraState.targetX,
      targetY: ctrl.directorCameraState.targetY,
      targetZ: ctrl.directorCameraState.targetZ,
    };
  } else {
    const tempState = {
      ...ctrl.directorCameraState,
      initialized: false,
      lateralBias: effectiveLateralBias,
    };
    const warmStart = Math.max(0, idx - 90);
    for (let i = warmStart; i <= idx; i++) {
      const s = ctrl.getFrameBufferByIndex(i);
      if (!s) continue;
      const emb = decodeReplayDirectorTelemetryFromState(s);
      const la = emb
        ? {
            primaryCarIndex:
              emb.activeTouchCarIndex >= 0 ? emb.activeTouchCarIndex : (ctrl.scorerCarIndex ?? 0),
            nextCarIndex: emb.nextTouchCarIndex,
            nextTouchBlend: emb.nextTouchBlend,
            nextTouchBallPos: emb.nextTouchBallPos,
            interceptorCarIndex: emb.interceptorCarIndex ?? -1,
            interceptorBlend: emb.interceptorBlend ?? 0,
            postGoalElapsedSec: emb.postGoalElapsedSec ?? 0,
          }
        : ctrl.resolveTouchLookaheadForFrame(
            i,
            tempState.activeTouchCarIndex ?? ctrl.scorerCarIndex ?? 0
          );
      tempState.activeTouchCarIndex = la.primaryCarIndex;
      tempState.nextTouchCarIndex = la.nextCarIndex;
      tempState.nextTouchBlend = la.nextTouchBlend;
      tempState.nextTouchBallPos = la.nextTouchBallPos;
      tempState.interceptorCarIndex = la.interceptorCarIndex ?? -1;
      tempState.interceptorBlend = la.interceptorBlend ?? 0;
      tempState.postGoalElapsedSec = la.postGoalElapsedSec ?? 0;
      dampedPose = computeGoalReplayCameraPose(s, ctrl.scoringTeam, {
        scorerCarIndex: ctrl.scorerCarIndex,
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
  const carViewAngleDeg = useCsvCam && typeof csvRow.car_view_angle_deg === 'number'
    ? round3(csvRow.car_view_angle_deg)
    : focusCar
      ? computeViewAngleToPointDeg(dampedPose, focusCar.pos)
      : 0;
  const interceptorViewAngleDeg = interceptorCar
    ? computeViewAngleToPointDeg(dampedPose, interceptorCar.pos)
    : 0;
  const ballViewAngleDeg = useCsvCam && typeof csvRow.ball_view_angle_deg === 'number'
    ? round3(csvRow.ball_view_angle_deg)
    : computeViewAngleToPointDeg(dampedPose, entities.ball.pos);

  return {
    frameId,
    replayFrameIndex: idx,
    totalReplayFrames: total,
    cursorFloat: round3(ctrl.cursorFloat),
    progress: round4(progress),
    timestampInReplaySec: round3(idx / REPLAY_TICK_RATE),
    slowMoFactor: round3(slowMoFactor),
    playbackSpeed: ctrl.playbackSpeed,
    isPaused: ctrl.isPaused,
    isPersistent: ctrl.isPersistent,
    isScrubbing: ctrl.isScrubbing,
    isActiveReplay: Boolean(ctrl.isActive),
    isRetainedLastReplay: !ctrl.isActive && ctrl.ActiveWindowCount > 0,
    isImportedPreview: Boolean(ctrl.isImportedPreview),
    importedFileName: ctrl.importedFileName || null,
    useRecordedCsvCamera: Boolean(ctrl.useRecordedCsvCamera),
    hasRecordedCsvCamera: Boolean(entry?.recordedCsvRow),
    importedSummary: ctrl._cachedSmoothnessSummary || ctrl.importedSummary || null,
    anomalyPeaks: ctrl._cachedAnomalyPeaks || ctrl.importedAnomalyPeaks || null,
    scoringTeam: ctrl.scoringTeam,
    scorerCarIndex: ctrl.scorerCarIndex,
    lookahead: {
      activeTouchCarIndex: lookahead.primaryCarIndex,
      nextTouchCarIndex: lookahead.nextCarIndex,
      nextTouchBlend: round4(lookahead.nextTouchBlend),
      nextTouchBallPos: lookahead.nextTouchBallPos
        ? [
            round3(lookahead.nextTouchBallPos.x),
            round3(lookahead.nextTouchBallPos.y),
            round3(lookahead.nextTouchBallPos.z),
          ]
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
      carViewAngleDeg,
      interceptorViewAngleDeg,
      ballViewAngleDeg,
      eyeStepUu: round3(csvRow?.eye_step_uu ?? 0),
      targetStepUu: round3(csvRow?.target_step_uu ?? 0),
      yawStepDeg: round4(csvRow?.yaw_step_deg ?? 0),
      pitchStepDeg: round4(csvRow?.pitch_step_deg ?? 0),
      rawUndampedEyeUnreal: [round3(rawPose.eyeX), round3(rawPose.eyeY), round3(rawPose.eyeZ)],
      rawUndampedTargetUnreal: [round3(rawPose.targetX), round3(rawPose.targetY), round3(rawPose.targetZ)],
      rawDistanceToTarget: rawAngles.distanceToTarget,
      rawYawDeg: rawAngles.yawDeg,
      rawPitchDeg: rawAngles.pitchDeg,
    },
    ball: entities.ball,
    cars: entities.cars,
    incidents: Array.isArray(entry?.incidents) ? entry.incidents : [],
    signals: Array.isArray(entry?.signals) ? entry.signals : [],
  };
}

function wrapAngleDeltaDeg(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function computeViewAngleToPointDeg(pose, pt) {
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

/**
 * Simulates the full Goal Replay Director camera trajectory deterministically at 120Hz
 * across all frames in the replay window for camera diagnostics.
 */
export function buildDirectorDiagnosticPatternPayload(ctrl, options = {}) {
  const total = ctrl.ActiveWindowCount > 0 ? ctrl.ActiveWindowCount : ctrl.getTotalRecordedFrames();
  if (total <= 0) return null;

  const firstEntry = ctrl.getFrameEntryByIndex(0);
  const lastEntry = ctrl.getFrameEntryByIndex(total - 1);
  const firstSnap = ctrl.getFrameBufferByIndex(0);
  const lastSnap = ctrl.getFrameBufferByIndex(total - 1);

  const startFrameId = firstEntry?.tick ?? Math.round(firstSnap?.[SIM_OFFSETS.TICK] || 0);
  const endFrameId = lastEntry?.tick ?? Math.round(lastSnap?.[SIM_OFFSETS.TICK] || (startFrameId + total - 1));

  const suffixPlan = ctrl.ensureSuffixCameraPlan?.() || null;

  const simDirectorState = {
    initialized: false,
    eyeX: 0,
    eyeY: 0,
    eyeZ: 0,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    lateralBias: suffixPlan?.lateralBias ?? ctrl.directorCameraState.lateralBias ?? 1.0,
    hasResolvedInitialLateralBias: Boolean(ctrl.directorCameraState.hasResolvedInitialLateralBias),
    activeTouchCarIndex: ctrl.directorCameraState.activeTouchCarIndex ?? ctrl.scorerCarIndex ?? 0,
    scorerCarIndex: ctrl.directorCameraState.scorerCarIndex ?? ctrl.scorerCarIndex ?? 0,
    nextTouchCarIndex: -1,
    nextTouchBlend: 0,
    nextTouchBallPos: null,
    interceptorCarIndex: -1,
    interceptorBlend: 0,
    suffixCameraPlan: suffixPlan,
    postGoalElapsedSec: 0,
    initialSettledCarPos: ctrl.directorCameraState.initialSettledCarPos
      ? { ...ctrl.directorCameraState.initialSettledCarPos }
      : null,
    touchEvents: Array.isArray(ctrl.directorCameraState.touchEvents)
      ? ctrl.directorCameraState.touchEvents.map((t) => ({ ...t }))
      : [],
    lastScoringTouchFrameIdx: ctrl.directorCameraState.lastScoringTouchFrameIdx ?? -1,
    goalLineFrameIdx: ctrl.directorCameraState.goalLineFrameIdx ?? -1,
  };

  const frames = [];
  let prevPose = null;
  let prevRawPose = null;
  let prevAngles = null;
  let prevEyeVel = null;
  let prevTargetVel = null;

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

  for (let idx = 0; idx < total; idx++) {
    const entry = ctrl.getFrameEntryByIndex(idx);
    const snap = ctrl.getFrameBufferByIndex(idx);
    if (!snap) continue;

    const entities = extractFrameEntities(snap, ctrl.carTeamResolver);
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
      ? {
          primaryCarIndex:
            embedded.activeTouchCarIndex >= 0
              ? embedded.activeTouchCarIndex
              : (simDirectorState.scorerCarIndex ?? ctrl.scorerCarIndex ?? 0),
          nextCarIndex: embedded.nextTouchCarIndex,
          nextTouchBlend: embedded.nextTouchBlend,
          nextTouchBallPos: embedded.nextTouchBallPos,
          interceptorCarIndex: embedded.interceptorCarIndex ?? -1,
          interceptorBlend: embedded.interceptorBlend ?? 0,
          postGoalElapsedSec: embedded.postGoalElapsedSec ?? 0,
        }
      : ctrl.resolveTouchLookaheadForFrame(
          idx,
          simDirectorState.activeTouchCarIndex ?? ctrl.scorerCarIndex ?? 0
        );
    simDirectorState.activeTouchCarIndex = lookahead.primaryCarIndex;
    simDirectorState.nextTouchCarIndex = lookahead.nextCarIndex;
    simDirectorState.nextTouchBlend = lookahead.nextTouchBlend;
    simDirectorState.nextTouchBallPos = lookahead.nextTouchBallPos;
    simDirectorState.interceptorCarIndex = lookahead.interceptorCarIndex ?? -1;
    simDirectorState.interceptorBlend = lookahead.interceptorBlend ?? 0;
    simDirectorState.postGoalElapsedSec = lookahead.postGoalElapsedSec ?? 0;
    simDirectorState.currentFrameIndex = idx;

    const slowMoFactor = ctrl.computeDramaticSlowMoFactor(idx, { ignoreScrubState: true });
    // Each replay frame step is exactly 1 simulation tick (1 / 120s) regardless of slow-mo display rate
    const effectiveDt = 1 / REPLAY_TICK_RATE;

    const dampedPose = computeGoalReplayCameraPose(snap, ctrl.scoringTeam, {
      scorerCarIndex: simDirectorState.scorerCarIndex ?? ctrl.scorerCarIndex,
      progress,
      frameIndex: idx,
      suffixCameraPlan: suffixPlan,
      directorState: simDirectorState,
      dt: effectiveDt,
      exactDt: true,
    });

    const rawPose = {
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
    } else if (idx >= goalIdx + 45) {
      if (carViewAngleDeg > maxPostGoalCarViewAngleDeg) maxPostGoalCarViewAngleDeg = carViewAngleDeg;
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
        rawPose.eyeZ - prevRawPose.eyeZ
      );
      rawTargetStepUu = Math.hypot(
        rawPose.targetX - prevRawPose.targetX,
        rawPose.targetY - prevRawPose.targetY,
        rawPose.targetZ - prevRawPose.targetZ
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
        anomalyPeaks.maxEyeStep = {
          valueUu: round3(eyeStepUu),
          replayFrameIndex: idx,
          frameId,
          timestampSec,
        };
      }
      if (targetStepUu > maxTargetStepUu) maxTargetStepUu = targetStepUu;
      if (rawEyeStepUu > maxRawEyeStepUu) maxRawEyeStepUu = rawEyeStepUu;
      if (rawTargetStepUu > maxRawTargetStepUu) maxRawTargetStepUu = rawTargetStepUu;
      if (eyeAccelUu > maxEyeAccelUu) {
        maxEyeAccelUu = eyeAccelUu;
        anomalyPeaks.maxEyeAccel = {
          valueUu: round3(eyeAccelUu),
          replayFrameIndex: idx,
          frameId,
          timestampSec,
        };
      }
      if (targetAccelUu > maxTargetAccelUu) maxTargetAccelUu = targetAccelUu;
      if (Math.abs(yawStepDeg) > maxYawStepDeg) {
        maxYawStepDeg = Math.abs(yawStepDeg);
        anomalyPeaks.maxYawStep = {
          valueDeg: round4(Math.abs(yawStepDeg)),
          replayFrameIndex: idx,
          frameId,
          timestampSec,
        };
      }
    }

    prevPose = { ...dampedPose };
    prevRawPose = { ...rawPose };
    prevAngles = { ...dampedAngles };

    frames.push({
      frameId,
      replayFrameIndex: idx,
      timestampSec,
      progress: round4(progress),
      slowMoFactor: round3(slowMoFactor),
      isSelectedCursorFrame: idx === ctrl.currentFrameIndex,
      lookahead: {
        activeTouchCarIndex: lookahead.primaryCarIndex,
        nextTouchCarIndex: lookahead.nextCarIndex,
        nextTouchBlend: round4(lookahead.nextTouchBlend),
        nextTouchBallPos: lookahead.nextTouchBallPos
          ? [
              round3(lookahead.nextTouchBallPos.x),
              round3(lookahead.nextTouchBallPos.y),
              round3(lookahead.nextTouchBallPos.z),
            ]
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
        forwardUnreal: dampedAngles.forwardUnreal,
        distanceToTarget: dampedAngles.distanceToTarget,
        yawDeg: dampedAngles.yawDeg,
        pitchDeg: dampedAngles.pitchDeg,
        carViewAngleDeg,
        interceptorViewAngleDeg,
        ballViewAngleDeg,
        rawUndampedEyeUnreal: [round3(rawPose.eyeX), round3(rawPose.eyeY), round3(rawPose.eyeZ)],
        rawUndampedTargetUnreal: [round3(rawPose.targetX), round3(rawPose.targetY), round3(rawPose.targetZ)],
        rawDistanceToTarget: rawAngles.distanceToTarget,
        rawYawDeg: rawAngles.yawDeg,
        rawPitchDeg: rawAngles.pitchDeg,
        eyeStepUu: round3(eyeStepUu),
        targetStepUu: round3(targetStepUu),
        yawStepDeg: round4(yawStepDeg),
        pitchStepDeg: round4(pitchStepDeg),
        rawEyeStepUu: round3(rawEyeStepUu),
        rawTargetStepUu: round3(rawTargetStepUu),
        eyeAccelUu: round3(eyeAccelUu),
        targetAccelUu: round3(targetAccelUu),
      },
      ball: entities.ball,
      cars: entities.cars,
      incidents: Array.isArray(entry?.incidents) && entry.incidents.length > 0 ? entry.incidents : undefined,
    });
  }

  const touchEventsWithFrameIds = (ctrl.directorCameraState.touchEvents || []).map((t) => {
    const fEntry = ctrl.getFrameEntryByIndex(t.frameIndex);
    return {
      replayFrameIndex: t.frameIndex,
      frameId: fEntry?.tick ?? t.tick ?? (startFrameId + t.frameIndex),
      timestampSec: round3(t.frameIndex / REPLAY_TICK_RATE),
      carIndex: t.carIndex,
      team: t.team,
      ballPos: [round3(t.ballX), round3(t.ballY), round3(t.ballZ)],
    };
  });

  const lastTouchIdx = ctrl.directorCameraState.lastScoringTouchFrameIdx ?? -1;
  const goalLineIdx = ctrl.directorCameraState.goalLineFrameIdx ?? -1;

  const trajectorySmoothnessSummary = {
    totalFrames: total,
    durationSec: round3(total / REPLAY_TICK_RATE),
    startFrameId,
    endFrameId,
    maxEyeStepUu: round3(maxEyeStepUu),
    maxTargetStepUu: round3(maxTargetStepUu),
    maxRawEyeStepUu: round3(maxRawEyeStepUu),
    maxRawTargetStepUu: round3(maxRawTargetStepUu),
    maxEyeAccelUu: round3(maxEyeAccelUu),
    maxTargetAccelUu: round3(maxTargetAccelUu),
    maxYawStepDeg: round4(maxYawStepDeg),
    totalYawPathDeg: round3(totalYawPathDeg),
    netYawSpanDeg: round3(maxYawAccumDeg - minYawAccumDeg),
    maxPreGoalCarViewAngleDeg: round3(maxPreGoalCarViewAngleDeg),
    maxPreGoalBallViewAngleDeg: round3(maxPreGoalBallViewAngleDeg),
    maxInterceptorViewAngleDeg: round3(maxInterceptorViewAngleDeg),
    maxPostGoalCarViewAngleDeg: round3(maxPostGoalCarViewAngleDeg),
  };

  ctrl._cachedSmoothnessSummary = trajectorySmoothnessSummary;
  ctrl._cachedAnomalyPeaks = anomalyPeaks;

  const currentSnapshot = buildCurrentFrameDiagnosticSnapshot(ctrl);

  return {
    schema: 'RocketCompanion.ReplayDirectorDiagnosticPattern.v1',
    exportedAt: new Date().toISOString(),
    coordinateConventions: {
      unreal: 'X right, Y forward (toward Orange goal +5120), Z up (Unreal Units)',
      threeJs: 'X right, Y up, Z forward',
    },
    replayMetadata: {
      tickRate: REPLAY_TICK_RATE,
      totalReplayFrames: total,
      durationSeconds: round3(total / REPLAY_TICK_RATE),
      startFrameId,
      endFrameId,
      scoringTeam: ctrl.scoringTeam,
      scoringTeamName: ctrl.scoringTeam === 0 ? 'BLUE' : 'ORANGE',
      scorerCarIndex: ctrl.scorerCarIndex,
      lastScoringTouchReplayFrameIndex: lastTouchIdx,
      lastScoringTouchFrameId:
        lastTouchIdx >= 0
          ? (ctrl.getFrameEntryByIndex(lastTouchIdx)?.tick ?? (startFrameId + lastTouchIdx))
          : -1,
      goalLineReplayFrameIndex: goalLineIdx,
      goalLineFrameId:
        goalLineIdx >= 0
          ? (ctrl.getFrameEntryByIndex(goalLineIdx)?.tick ?? (startFrameId + goalLineIdx))
          : -1,
      trajectorySmoothnessSummary,
      anomalyPeaks,
      playbackStateAtExport: {
        selectedReplayFrameIndex: ctrl.currentFrameIndex,
        selectedFrameId: currentSnapshot?.frameId ?? startFrameId,
        cursorFloat: round3(ctrl.cursorFloat),
        progress: round4(ctrl.progress),
        isPaused: ctrl.isPaused,
        isPersistent: ctrl.isPersistent,
        isScrubbing: ctrl.isScrubbing,
        playbackSpeed: ctrl.playbackSpeed,
      },
      ...(options.extraMetadata || {}),
    },
    directorConfig: { ...REPLAY_DIRECTOR_CONFIG },
    defaultDirectorConfig: { ...DEFAULT_REPLAY_DIRECTOR_CONFIG },
    touchTimeline: touchEventsWithFrameIds,
    selectedFrameDiagnostic: currentSnapshot,
    frames,
  };
}

/**
 * Builds a flat CSV string of the full replay window with `frame_id`, `replay_frame_index`,
 * camera eye/target/angles, lookahead weights, ball pos/vel, primary car pos/vel,
 * and per-frame step/acceleration smoothness metrics.
 */
export function buildDirectorDiagnosticPatternCsv(ctrl, options = {}) {
  const payload = buildDirectorDiagnosticPatternPayload(ctrl, options);
  if (!payload || !Array.isArray(payload.frames)) return '';

  const columns = [
    'frame_id',
    'replay_frame_index',
    'timestamp_sec',
    'progress',
    'is_selected_cursor',
    'slow_mo_factor',
    'active_touch_car_idx',
    'next_touch_car_idx',
    'next_touch_blend',
    'lateral_bias',
    'cam_eye_x',
    'cam_eye_y',
    'cam_eye_z',
    'cam_target_x',
    'cam_target_y',
    'cam_target_z',
    'cam_dist_to_target',
    'cam_yaw_deg',
    'cam_pitch_deg',
    'raw_eye_x',
    'raw_eye_y',
    'raw_eye_z',
    'raw_target_x',
    'raw_target_y',
    'raw_target_z',
    'ball_x',
    'ball_y',
    'ball_z',
    'ball_vx',
    'ball_vy',
    'ball_vz',
    'ball_speed_kph',
    'focus_car_x',
    'focus_car_y',
    'focus_car_z',
    'focus_car_vx',
    'focus_car_vy',
    'focus_car_vz',
    'focus_car_dist_to_ball',
    'eye_step_uu',
    'target_step_uu',
    'yaw_step_deg',
    'pitch_step_deg',
    'raw_eye_step_uu',
    'raw_target_step_uu',
    'eye_accel_uu',
    'target_accel_uu',
    'car_view_angle_deg',
    'ball_view_angle_deg',
  ];

  const lines = [columns.join(',')];
  for (const f of payload.frames) {
    const focusCar =
      f.cars.find((c) => c.carIndex === f.lookahead.activeTouchCarIndex) ||
      f.cars[0] ||
      null;
    const row = [
      f.frameId,
      f.replayFrameIndex,
      f.timestampSec,
      f.progress,
      f.isSelectedCursorFrame ? 1 : 0,
      f.slowMoFactor,
      f.lookahead.activeTouchCarIndex,
      f.lookahead.nextTouchCarIndex,
      f.lookahead.nextTouchBlend,
      f.lookahead.lateralBias,
      f.cameraPose.eyeUnreal[0],
      f.cameraPose.eyeUnreal[1],
      f.cameraPose.eyeUnreal[2],
      f.cameraPose.targetUnreal[0],
      f.cameraPose.targetUnreal[1],
      f.cameraPose.targetUnreal[2],
      f.cameraPose.distanceToTarget,
      f.cameraPose.yawDeg,
      f.cameraPose.pitchDeg,
      f.cameraPose.rawUndampedEyeUnreal[0],
      f.cameraPose.rawUndampedEyeUnreal[1],
      f.cameraPose.rawUndampedEyeUnreal[2],
      f.cameraPose.rawUndampedTargetUnreal[0],
      f.cameraPose.rawUndampedTargetUnreal[1],
      f.cameraPose.rawUndampedTargetUnreal[2],
      f.ball.pos[0],
      f.ball.pos[1],
      f.ball.pos[2],
      f.ball.vel[0],
      f.ball.vel[1],
      f.ball.vel[2],
      f.ball.speedKph,
      focusCar ? focusCar.pos[0] : 0,
      focusCar ? focusCar.pos[1] : 0,
      focusCar ? focusCar.pos[2] : 0,
      focusCar ? focusCar.vel[0] : 0,
      focusCar ? focusCar.vel[1] : 0,
      focusCar ? focusCar.vel[2] : 0,
      focusCar ? focusCar.distToBall : 0,
      f.cameraPose.eyeStepUu ?? 0,
      f.cameraPose.targetStepUu ?? 0,
      f.cameraPose.yawStepDeg ?? 0,
      f.cameraPose.pitchStepDeg ?? 0,
      f.cameraPose.rawEyeStepUu ?? 0,
      f.cameraPose.rawTargetStepUu ?? 0,
      f.cameraPose.eyeAccelUu ?? 0,
      f.cameraPose.targetAccelUu ?? 0,
      f.cameraPose.carViewAngleDeg ?? 0,
      f.cameraPose.ballViewAngleDeg ?? 0,
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function buildOrthonormalBasisFromVelocity(vx, vy, vz, fallbackDirX = 0, fallbackDirY = 1) {
  const speed = Math.hypot(vx, vy, vz);
  let fx = fallbackDirX;
  let fy = fallbackDirY;
  let fz = 0;
  if (speed > 25) {
    fx = vx / speed;
    fy = vy / speed;
    fz = vz / speed;
  } else {
    const fl = Math.hypot(fx, fy);
    if (fl > 1e-4) {
      fx /= fl;
      fy /= fl;
    } else {
      fx = 0;
      fy = 1;
    }
  }
  // In RocketSim's left-handed Unreal coordinate system (X right, Y forward, Z up):
  // right = (-fy, fx, 0) normalized, and up = fwd x right
  let rx = -fy;
  let ry = fx;
  let rz = 0;
  const rl = Math.hypot(rx, ry, rz);
  if (rl > 1e-4) {
    rx /= rl;
    ry /= rl;
  } else {
    rx = -1;
    ry = 0;
  }
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;
  return { fx, fy, fz, rx, ry, rz, ux, uy, uz };
}

const BALL_FIELD_OFFSETS = Object.freeze({
  POS_X: 0,
  POS_Y: 1,
  POS_Z: 2,
  VEL_X: 12,
  VEL_Y: 13,
  VEL_Z: 14,
});

const CAR_FIELD_OFFSETS = Object.freeze({
  POS_X: 0,
  POS_Y: 1,
  POS_Z: 2,
  FWD_X: 3,
  FWD_Y: 4,
  FWD_Z: 5,
  RIGHT_X: 6,
  RIGHT_Y: 7,
  RIGHT_Z: 8,
  UP_X: 9,
  UP_Y: 10,
  UP_Z: 11,
  VEL_X: 12,
  VEL_Y: 13,
  VEL_Z: 14,
  BOOST: 18,
  IS_ON_GROUND: 19,
  IS_SUPERSONIC: 20,
  IS_DEMOED: 21,
  HAS_FLIPPED_OR_DOUBLE_JUMPED: 22,
  IS_BOOSTING: 23,
});

function initBlankSnapshotBuffer(tick, numCars) {
  const buf = new Float32Array(GAME_STATE_BUFFER_FLOATS);
  buf[SIM_OFFSETS.TICK] = tick;
  buf[SIM_OFFSETS.GOAL] = 0;
  buf[SIM_OFFSETS.NUM_CARS] = numCars;
  buf[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;

  const bBase = SIM_OFFSETS.BALL;
  buf[bBase + 3] = 1;
  buf[bBase + 7] = 1;
  buf[bBase + 11] = 1;

  for (let c = 0; c < MAX_CARS; c++) {
    const base = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
    buf[base + CAR_FIELD_OFFSETS.POS_X] = -9999;
    buf[base + CAR_FIELD_OFFSETS.POS_Y] = -9999;
    buf[base + CAR_FIELD_OFFSETS.POS_Z] = -500;
    buf[base + CAR_FIELD_OFFSETS.FWD_X] = 0;
    buf[base + CAR_FIELD_OFFSETS.FWD_Y] = 1;
    buf[base + CAR_FIELD_OFFSETS.FWD_Z] = 0;
    buf[base + CAR_FIELD_OFFSETS.RIGHT_X] = -1;
    buf[base + CAR_FIELD_OFFSETS.RIGHT_Y] = 0;
    buf[base + CAR_FIELD_OFFSETS.RIGHT_Z] = 0;
    buf[base + CAR_FIELD_OFFSETS.UP_X] = 0;
    buf[base + CAR_FIELD_OFFSETS.UP_Y] = 0;
    buf[base + CAR_FIELD_OFFSETS.UP_Z] = 1;
  }

  for (let p = 0; p < NUM_BOOST_PADS; p++) {
    const padBase = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
    buf[padBase] = 1.0;
    buf[padBase + 1] = 0.0;
  }
  return buf;
}

/**
 * Builds a focused 31-frame window diagnostic JSON around the currently selected cursor Frame ID
 * (`[idx - windowRadius .. idx + windowRadius]`), bundling `directorConfig`, `anomalyPeaks`,
 * `touchTimeline`, and per-frame camera/ball/car kinematics for rapid AI or human diagnosis.
 */
export function buildDirectorFrameWindowDiagnostic(ctrl, windowRadius = 15) {
  if (!ctrl) return null;
  const payload = buildDirectorDiagnosticPatternPayload(ctrl);
  if (!payload || !Array.isArray(payload.frames) || payload.frames.length === 0) return null;

  const total = payload.frames.length;
  const centerIdx = Math.max(0, Math.min(total - 1, ctrl.currentFrameIndex));
  const radius = Math.max(1, Math.min(120, Math.round(windowRadius) || 15));
  const winStart = Math.max(0, centerIdx - radius);
  const winEnd = Math.min(total - 1, centerIdx + radius);
  const slice = payload.frames.slice(winStart, winEnd + 1);
  const centerFrame = payload.frames[centerIdx] || slice[0];

  return {
    schema: 'RocketCompanion.ReplayDirectorFrameWindowDiagnostic.v1',
    exportedAt: new Date().toISOString(),
    fileName: ctrl.importedFileName || null,
    selectedFrameId: centerFrame?.frameId ?? 0,
    selectedReplayFrameIndex: centerIdx,
    windowRadius: radius,
    windowBounds: {
      startReplayFrameIndex: winStart,
      endReplayFrameIndex: winEnd,
      startFrameId: slice[0]?.frameId ?? 0,
      endFrameId: slice[slice.length - 1]?.frameId ?? 0,
      frameCount: slice.length,
    },
    replayMetadata: payload.replayMetadata,
    directorConfig: payload.directorConfig,
    anomalyPeaks: payload.replayMetadata.anomalyPeaks,
    touchTimeline: payload.touchTimeline,
    selectedFrameDiagnostic: payload.selectedFrameDiagnostic,
    windowFrames: slice.map((f) => ({
      frameId: f.frameId,
      replayFrameIndex: f.replayFrameIndex,
      offsetFromSelected: f.replayFrameIndex - centerIdx,
      timestampSec: f.timestampSec,
      slowMoFactor: f.slowMoFactor,
      activeTouchCarIndex: f.lookahead.activeTouchCarIndex,
      nextTouchCarIndex: f.lookahead.nextTouchCarIndex,
      nextTouchBlend: f.lookahead.nextTouchBlend,
      carSwitchBlend: f.lookahead.carSwitchBlend,
      lateralBias: f.lookahead.lateralBias,
      dampedEye: f.cameraPose.eyeUnreal,
      dampedTarget: f.cameraPose.targetUnreal,
      rawEye: f.cameraPose.rawUndampedEyeUnreal,
      rawTarget: f.cameraPose.rawUndampedTargetUnreal,
      yawDeg: f.cameraPose.yawDeg,
      pitchDeg: f.cameraPose.pitchDeg,
      distanceToTarget: f.cameraPose.distanceToTarget,
      eyeStepUu: f.cameraPose.eyeStepUu,
      targetStepUu: f.cameraPose.targetStepUu,
      yawStepDeg: f.cameraPose.yawStepDeg,
      pitchStepDeg: f.cameraPose.pitchStepDeg,
      eyeAccelUu: f.cameraPose.eyeAccelUu,
      carViewAngleDeg: f.cameraPose.carViewAngleDeg,
      ballViewAngleDeg: f.cameraPose.ballViewAngleDeg,
      ball: f.ball,
      cars: f.cars,
    })),
  };
}

/**
 * Builds a V2 RCREPLAY binary container (`Uint8Array`) for the Goal Replay window,
 * embedding full 448-float physics snapshots for all 8 cars, 64-byte controls, incidents,
 * signals, plus `directorReplayMeta` (`directorConfig`, `carEntries`, `touchTimeline`,
 * `anomalyPeaks`, and `recordedDirectorFrames`).
 */
export function buildDirectorReplayContainerPayload(ctrl, options = {}) {
  const payload = buildDirectorDiagnosticPatternPayload(ctrl, options);
  if (!payload || !Array.isArray(payload.frames) || payload.frames.length === 0) return null;

  const recordedDirectorFrames = payload.frames.map((f) => {
    const focusCar =
      f.cars.find((c) => c.carIndex === f.lookahead.activeTouchCarIndex) ||
      f.cars[0] ||
      null;
    return {
      frame_id: f.frameId,
      replay_frame_index: f.replayFrameIndex,
      timestamp_sec: f.timestampSec,
      progress: f.progress,
      is_selected_cursor: f.isSelectedCursorFrame ? 1 : 0,
      slow_mo_factor: f.slowMoFactor,
      active_touch_car_idx: f.lookahead.activeTouchCarIndex,
      next_touch_car_idx: f.lookahead.nextTouchCarIndex,
      next_touch_blend: f.lookahead.nextTouchBlend,
      lateral_bias: f.lookahead.lateralBias,
      cam_eye_x: f.cameraPose.eyeUnreal[0],
      cam_eye_y: f.cameraPose.eyeUnreal[1],
      cam_eye_z: f.cameraPose.eyeUnreal[2],
      cam_target_x: f.cameraPose.targetUnreal[0],
      cam_target_y: f.cameraPose.targetUnreal[1],
      cam_target_z: f.cameraPose.targetUnreal[2],
      cam_dist_to_target: f.cameraPose.distanceToTarget,
      cam_yaw_deg: f.cameraPose.yawDeg,
      cam_pitch_deg: f.cameraPose.pitchDeg,
      raw_eye_x: f.cameraPose.rawUndampedEyeUnreal[0],
      raw_eye_y: f.cameraPose.rawUndampedEyeUnreal[1],
      raw_eye_z: f.cameraPose.rawUndampedEyeUnreal[2],
      raw_target_x: f.cameraPose.rawUndampedTargetUnreal[0],
      raw_target_y: f.cameraPose.rawUndampedTargetUnreal[1],
      raw_target_z: f.cameraPose.rawUndampedTargetUnreal[2],
      ball_x: f.ball.pos[0],
      ball_y: f.ball.pos[1],
      ball_z: f.ball.pos[2],
      ball_vx: f.ball.vel[0],
      ball_vy: f.ball.vel[1],
      ball_vz: f.ball.vel[2],
      ball_speed_kph: f.ball.speedKph,
      focus_car_x: focusCar ? focusCar.pos[0] : 0,
      focus_car_y: focusCar ? focusCar.pos[1] : 0,
      focus_car_z: focusCar ? focusCar.pos[2] : 17,
      focus_car_vx: focusCar ? focusCar.vel[0] : 0,
      focus_car_vy: focusCar ? focusCar.vel[1] : 0,
      focus_car_vz: focusCar ? focusCar.vel[2] : 0,
      focus_car_dist_to_ball: focusCar ? focusCar.distToBall : 0,
      eye_step_uu: f.cameraPose.eyeStepUu ?? 0,
      target_step_uu: f.cameraPose.targetStepUu ?? 0,
      yaw_step_deg: f.cameraPose.yawStepDeg ?? 0,
      pitch_step_deg: f.cameraPose.pitchStepDeg ?? 0,
      raw_eye_step_uu: f.cameraPose.rawEyeStepUu ?? 0,
      raw_target_step_uu: f.cameraPose.rawTargetStepUu ?? 0,
      eye_accel_uu: f.cameraPose.eyeAccelUu ?? 0,
      target_accel_uu: f.cameraPose.targetAccelUu ?? 0,
      car_view_angle_deg: f.cameraPose.carViewAngleDeg ?? 0,
      ball_view_angle_deg: f.cameraPose.ballViewAngleDeg ?? 0,
    };
  });

  const rawCarEntries =
    options.carEntries || ctrl.carEntries || ctrl.importedCarEntries || [];
  const carEntries = Array.isArray(rawCarEntries)
    ? rawCarEntries.map((c) => ({ ...c }))
    : [];

  const directorReplayMeta = {
    schema: 'RocketCompanion.GoalReplayDirectorContainer.v1',
    scoringTeam: ctrl.scoringTeam ?? 0,
    scorerCarIndex: ctrl.scorerCarIndex ?? 0,
    selectedReplayFrameIndex: ctrl.currentFrameIndex ?? 0,
    selectedFrameId: payload.selectedFrameDiagnostic?.frameId ?? 0,
    lateralBias: ctrl.directorCameraState?.lateralBias || 1.0,
    lastScoringTouchFrameIdx: ctrl.directorCameraState?.lastScoringTouchFrameIdx ?? -1,
    goalLineFrameIdx: ctrl.directorCameraState?.goalLineFrameIdx ?? -1,
    initialSettledCarPos: ctrl.directorCameraState?.initialSettledCarPos
      ? { ...ctrl.directorCameraState.initialSettledCarPos }
      : null,
    directorConfig: payload.directorConfig,
    carEntries,
    touchTimeline: payload.touchTimeline,
    trajectorySmoothnessSummary: payload.replayMetadata.trajectorySmoothnessSummary,
    anomalyPeaks: payload.replayMetadata.anomalyPeaks,
    recordedDirectorFrames,
  };

  return {
    mode: 'goal-replay',
    tickRate: REPLAY_TICK_RATE,
    winner: (ctrl.scoringTeam ?? 0) === 0 ? 'blue' : 'orange',
    slots: ctrl.activeFrames,
    roster: carEntries,
    directorReplayMeta,
    diagnosticPayload: payload,
  };
}

export function buildDirectorReplayContainerBytes(ctrl, options = {}) {
  const containerPayload = buildDirectorReplayContainerPayload(ctrl, options);
  if (!containerPayload) return null;
  const containerBytes = serializeRCReplayBinaryContainer(containerPayload);
  return {
    containerBytes,
    directorReplayMeta: containerPayload.directorReplayMeta,
    diagnosticPayload: containerPayload.diagnosticPayload,
  };
}

async function compressBytesGzip(u8) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    if (typeof Blob !== 'undefined' && typeof Blob.prototype.stream === 'function') {
      const compressedStream = new Blob([u8]).stream().pipeThrough(cs);
      const buf = await new Response(compressedStream).arrayBuffer();
      return new Uint8Array(buf);
    }
    const readPromise = new Response(cs.readable).arrayBuffer();
    const writer = cs.writable.getWriter();
    await writer.write(u8);
    await writer.close();
    const buf = await readPromise;
    return new Uint8Array(buf);
  }
  return u8;
}

async function decompressBytesIfGzip(bytesOrBuffer) {
  const u8 =
    bytesOrBuffer instanceof Uint8Array
      ? bytesOrBuffer
      : new Uint8Array(bytesOrBuffer);
  if (u8.byteLength >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      if (typeof Blob !== 'undefined' && typeof Blob.prototype.stream === 'function') {
        const decompressedStream = new Blob([u8]).stream().pipeThrough(ds);
        const buf = await new Response(decompressedStream).arrayBuffer();
        return new Uint8Array(buf);
      }
      const readPromise = new Response(ds.readable).arrayBuffer();
      const writer = ds.writable.getWriter();
      await writer.write(u8);
      await writer.close();
      const buf = await readPromise;
      return new Uint8Array(buf);
    }
  }
  return u8;
}

/**
 * Parses a decompressed V2 RCREPLAY / RCGR binary container (`Uint8Array`) into replay frames,
 * full multi-car 3D snapshots, and Director Camera telemetry.
 */
export function parseDirectorDiagnosticContainerBytes(
  bytesOrBuffer,
  fileName = 'imported.rcgr.gz'
) {
  const u8 =
    bytesOrBuffer instanceof Uint8Array
      ? bytesOrBuffer
      : new Uint8Array(bytesOrBuffer);
  if (!isBinaryRCReplayContainer(u8)) return null;

  const decoded = deserializeRCReplayBinaryContainer(u8);
  if (!decoded || !Array.isArray(decoded.frameSlots) || decoded.frameSlots.length === 0) {
    return null;
  }

  const dMeta = decoded.metadata?.directorReplayMeta || null;
  const recordedRows = Array.isArray(dMeta?.recordedDirectorFrames)
    ? dMeta.recordedDirectorFrames
    : null;

  const carEntries =
    Array.isArray(dMeta?.carEntries) && dMeta.carEntries.length > 0
      ? dMeta.carEntries
      : Array.isArray(decoded.metadata?.roster)
        ? decoded.metadata.roster
        : [];

  const rosterTeamMap = new Map();
  for (const c of carEntries) {
    if (typeof c?.carIndex === 'number' && typeof c?.team === 'number') {
      rosterTeamMap.set(c.carIndex, c.team);
    }
  }
  const resolveCarTeam = (carIdx) =>
    rosterTeamMap.has(carIdx) ? rosterTeamMap.get(carIdx) : carIdx % 2;

  let inferredScoringTeam =
    typeof dMeta?.scoringTeam === 'number'
      ? dMeta.scoringTeam
      : decoded.metadata?.winner === 'orange'
        ? 1
        : 0;
  let inferredScorerCarIndex =
    typeof dMeta?.scorerCarIndex === 'number' ? dMeta.scorerCarIndex : 0;

  let sourceFrameSlots = decoded.frameSlots;

  // When importing a full-match .rcreplay.gz container (no directorReplayMeta and not already a goal-replay slice),
  // automatically locate the latest goal and extract its Goal Replay window.
  if (!dMeta && decoded.metadata?.mode !== 'goal-replay' && decoded.frameSlots.length > 400) {
    let goalTick = -1;
    let hasExplicitScorer = false;

    const allIncidents = Array.isArray(decoded.timelines?.incidents)
      ? decoded.timelines.incidents
      : Array.isArray(decoded.incidents)
        ? decoded.incidents
        : decoded.frameSlots.flatMap((s) => (Array.isArray(s?.incidents) ? s.incidents : []));
    for (let i = allIncidents.length - 1; i >= 0; i--) {
      const inc = allIncidents[i];
      if (inc && inc.type === INCIDENT_EVENT_TYPES.GOAL_SCORED) {
        goalTick = typeof inc.tick === 'number' ? inc.tick : -1;
        if (typeof inc.team === 'number') {
          inferredScoringTeam = inc.team;
        }
        if (typeof inc.carIndex === 'number' && inc.carIndex >= 0) {
          inferredScorerCarIndex = inc.carIndex;
          hasExplicitScorer = true;
        }
        break;
      }
    }

    const allSignals = Array.isArray(decoded.timelines?.signals)
      ? decoded.timelines.signals
      : Array.isArray(decoded.signals)
        ? decoded.signals
        : decoded.frameSlots.flatMap((s) => (Array.isArray(s?.signals) ? s.signals : []));
    if (goalTick < 0) {
      for (let i = allSignals.length - 1; i >= 0; i--) {
        const sig = allSignals[i];
        if (
          sig &&
          (sig.signalType === MATCH_SIGNALS.GOAL_REPLAY_WILL_START ||
            sig.signalType === MATCH_SIGNALS.SCORE_UPDATED) &&
          typeof sig.frameId === 'number'
        ) {
          goalTick = sig.frameId;
          if (typeof sig.primaryId === 'number' && (sig.primaryId === 0 || sig.primaryId === 1)) {
            inferredScoringTeam = sig.primaryId;
          }
          if (typeof sig.secondaryId === 'number' && sig.secondaryId >= 0) {
            inferredScorerCarIndex = sig.secondaryId;
            hasExplicitScorer = true;
          }
          break;
        }
      }
    }

    if (goalTick < 0) {
      for (let i = decoded.frameSlots.length - 1; i >= 0; i--) {
        const snap = decoded.frameSlots[i]?.snapshot;
        if (!snap || snap.length <= 6) continue;
        if (Math.abs((snap[302] || 0) - 1337.5) <= 0.01) continue;
        const by = snap[5] || 0;
        const bx = snap[4] || 0;
        const bz = snap[6] || 0;
        if (Math.abs(by) >= 5120 && Math.abs(bx) < 893 && bz < 643) {
          inferredScoringTeam = by > 0 ? 0 : 1;
          let entryIdx = i;
          while (entryIdx > 0) {
            const prevSnap = decoded.frameSlots[entryIdx - 1]?.snapshot;
            if (!prevSnap || Math.abs(prevSnap[5] || 0) < 5120) break;
            entryIdx--;
          }
          goalTick = decoded.frameSlots[entryIdx]?.tick ?? -1;
          break;
        }
      }
    }

    if (goalTick >= 0) {
      let scorerTouchTick = -1;
      for (let i = allIncidents.length - 1; i >= 0; i--) {
        const inc = allIncidents[i];
        if (!inc) continue;
        const tTick = typeof inc.tick === 'number' ? inc.tick : -1;
        if (tTick < 0 || tTick > goalTick) continue;
        if (
          inc.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT ||
          inc.type === PHYSICS_EVENT_TYPES.CAR_BALL_HIT ||
          inc.type === 0x01
        ) {
          const hitCar = inc.carIndex ?? inc.primaryId ?? -1;
          const hitTeam =
            typeof inc.team === 'number'
              ? inc.team
              : hitCar >= 0
                ? resolveCarTeam(hitCar)
                : -1;
          if (hitTeam === inferredScoringTeam) {
            if (!hasExplicitScorer && hitCar >= 0) {
              inferredScorerCarIndex = hitCar;
              hasExplicitScorer = true;
            }
            if (hitCar === inferredScorerCarIndex || scorerTouchTick < 0) {
              scorerTouchTick = tTick;
              if (hitCar === inferredScorerCarIndex) break;
            }
          }
        }
      }

      let kickoffTick = -1;
      for (let i = allSignals.length - 1; i >= 0; i--) {
        const sig = allSignals[i];
        if (
          sig &&
          sig.signalType === MATCH_SIGNALS.KICKOFF_WILL_START &&
          typeof sig.frameId === 'number' &&
          sig.frameId <= goalTick
        ) {
          kickoffTick = sig.frameId;
          break;
        }
      }

      const newestTick =
        decoded.frameSlots[decoded.frameSlots.length - 1]?.tick ?? goalTick + 180;
      const postGoalTicks = Math.min(360, Math.max(60, newestTick - goalTick));
      const bounds = resolveGoalReplayWindowBounds({
        goalIncidentTick: goalTick,
        scorerTouchTick,
        lookbackSeconds: 10.0,
        touchLookbackSeconds: 7.0,
        postGoalTicks,
        lastKickoffWillStartTick: kickoffTick,
        signalLog: allSignals,
      });

      const extracted = decoded.frameSlots.filter((slot) => {
        if (!slot || typeof slot.tick !== 'number') return false;
        const snap = slot.snapshot;
        if (snap && snap.length > 302 && Math.abs((snap[302] || 0) - 1337.5) <= 0.01) {
          return false;
        }
        return slot.tick >= bounds.effectiveStartFrame && slot.tick <= bounds.effectiveEndFrame;
      });

      if (extracted.length > 0) {
        sourceFrameSlots = extracted;
      }
    }
  }

  const scoringTeam = inferredScoringTeam;
  const scorerCarIndex = inferredScorerCarIndex;
  const rawGoalLineFrameIdx =
    typeof dMeta?.goalLineFrameIdx === 'number' ? dMeta.goalLineFrameIdx : -1;
  const lastScoringTouchFrameIdx =
    typeof dMeta?.lastScoringTouchFrameIdx === 'number' ? dMeta.lastScoringTouchFrameIdx : -1;
  const selectedCursorIndex =
    typeof dMeta?.selectedReplayFrameIndex === 'number' ? dMeta.selectedReplayFrameIndex : 0;

  const activeFrames = sourceFrameSlots.map((slot, i) => ({
    ...slot,
    timestamp: i / REPLAY_TICK_RATE,
    recordedCsvRow: recordedRows && recordedRows[i] ? recordedRows[i] : null,
  }));

  const goalLineFrameIdx = resolveGoalExplosionFrameIndex(
    activeFrames,
    scoringTeam === 0 ? 1.0 : -1.0,
    rawGoalLineFrameIdx
  );

  const touchEvents = Array.isArray(dMeta?.touchTimeline)
    ? dMeta.touchTimeline.map((t) => ({
        frameIndex: t.replayFrameIndex ?? 0,
        tick: t.frameId ?? 0,
        carIndex: t.carIndex ?? 0,
        team: t.team ?? 0,
        ballX: t.ballPos?.[0] ?? 0,
        ballY: t.ballPos?.[1] ?? 0,
        ballZ: t.ballPos?.[2] ?? 0,
      }))
    : [];

  return {
    format: 'rcgr',
    fileName,
    activeFrames,
    scoringTeam,
    scorerCarIndex,
    selectedCursorIndex,
    lateralBias: dMeta?.lateralBias || 1.0,
    touchEvents,
    lastScoringTouchFrameIdx,
    goalLineFrameIdx,
    initialSettledCarPos: dMeta?.initialSettledCarPos || null,
    hasRecordedCsvRows: Boolean(recordedRows && recordedRows.length > 0),
    directorConfig: dMeta?.directorConfig || null,
    carEntries,
    anomalyPeaks: dMeta?.anomalyPeaks || null,
    summary: dMeta?.trajectorySmoothnessSummary || {
      totalFrames: activeFrames.length,
      durationSec: round3(activeFrames.length / REPLAY_TICK_RATE),
      startFrameId: activeFrames[0]?.tick ?? 0,
      endFrameId: activeFrames[activeFrames.length - 1]?.tick ?? 0,
      maxEyeStepUu: 0,
      maxTargetStepUu: 0,
      maxYawStepDeg: 0,
      maxEyeAccelUu: 0,
      maxPreGoalCarViewAngleDeg: 0,
      maxPreGoalBallViewAngleDeg: 0,
    },
  };
}

/**
 * Parses an exported Director Diagnostic Pattern CSV string into replay frames,
 * camera telemetry rows, and trajectory smoothness summary so historical CSV downloads
 * can be imported and previewed in the 3D Arena and Replay Director Tuner.
 */
export function parseDirectorDiagnosticPatternCsv(csvText, fileName = 'imported-pattern.csv') {
  if (typeof csvText !== 'string' || !csvText.trim()) return null;
  const rawLines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (rawLines.length < 2) return null;

  const headers = rawLines[0].split(',').map((h) => h.trim());
  if (!headers.includes('ball_x') || !headers.includes('cam_eye_x')) {
    return null;
  }

  const rows = [];
  for (let i = 1; i < rawLines.length; i++) {
    const parts = rawLines[i].split(',');
    if (parts.length < 15) continue;
    const row = {};
    for (let c = 0; c < headers.length; c++) {
      const val = Number(parts[c]);
      row[headers[c]] = Number.isFinite(val) ? val : 0;
    }
    rows.push(row);
  }
  if (rows.length === 0) return null;

  let maxCarIdx = 0;
  for (const r of rows) {
    const a = Math.max(0, Math.round(r.active_touch_car_idx ?? 0));
    const n = Math.round(r.next_touch_car_idx ?? -1);
    if (a > maxCarIdx) maxCarIdx = a;
    if (n > maxCarIdx) maxCarIdx = n;
  }
  const numCars = Math.min(MAX_CARS, Math.max(1, maxCarIdx + 1));

  // Build per-car position/velocity tracks across all frames with linear interpolation across car switches
  const carTracks = Array.from({ length: numCars }, () => new Array(rows.length).fill(null));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cIdx = Math.min(numCars - 1, Math.max(0, Math.round(r.active_touch_car_idx ?? 0)));
    carTracks[cIdx][i] = {
      x: r.focus_car_x ?? 0,
      y: r.focus_car_y ?? 0,
      z: r.focus_car_z ?? 17,
      vx: r.focus_car_vx ?? 0,
      vy: r.focus_car_vy ?? 0,
      vz: r.focus_car_vz ?? 0,
    };
  }

  for (let c = 0; c < numCars; c++) {
    const track = carTracks[c];
    let firstValid = -1;
    let lastValid = -1;
    for (let i = 0; i < track.length; i++) {
      if (track[i]) {
        if (firstValid < 0) firstValid = i;
        lastValid = i;
      }
    }
    if (firstValid < 0) continue;
    for (let i = 0; i < firstValid; i++) {
      const dt = (i - firstValid) / REPLAY_TICK_RATE;
      track[i] = {
        x: track[firstValid].x + track[firstValid].vx * dt,
        y: track[firstValid].y + track[firstValid].vy * dt,
        z: Math.max(17, track[firstValid].z + track[firstValid].vz * dt),
        vx: track[firstValid].vx,
        vy: track[firstValid].vy,
        vz: track[firstValid].vz,
      };
    }
    for (let i = lastValid + 1; i < track.length; i++) {
      const dt = (i - lastValid) / REPLAY_TICK_RATE;
      track[i] = {
        x: track[lastValid].x + track[lastValid].vx * dt,
        y: track[lastValid].y + track[lastValid].vy * dt,
        z: Math.max(17, track[lastValid].z + track[lastValid].vz * dt),
        vx: track[lastValid].vx,
        vy: track[lastValid].vy,
        vz: track[lastValid].vz,
      };
    }
    let segStart = firstValid;
    for (let i = firstValid + 1; i <= lastValid; i++) {
      if (track[i]) {
        if (i - segStart > 1) {
          const a = track[segStart];
          const b = track[i];
          const span = i - segStart;
          for (let k = segStart + 1; k < i; k++) {
            const t = (k - segStart) / span;
            track[k] = {
              x: a.x + (b.x - a.x) * t,
              y: a.y + (b.y - a.y) * t,
              z: a.z + (b.z - a.z) * t,
              vx: a.vx + (b.vx - a.vx) * t,
              vy: a.vy + (b.vy - a.vy) * t,
              vz: a.vz + (b.vz - a.vz) * t,
            };
          }
        }
        segStart = i;
      }
    }
  }

  const lastRow = rows[rows.length - 1];
  const scoringTeam = (lastRow.ball_y ?? 0) >= 0 ? 0 : 1;

  let goalLineFrameIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (Math.abs(rows[i].ball_y ?? 0) >= 5120) {
      goalLineFrameIdx = i;
      break;
    }
  }
  const scorerLookupIdx = goalLineFrameIdx >= 0 ? goalLineFrameIdx : rows.length - 1;
  const scorerCarIndex = Math.max(
    0,
    Math.round(rows[scorerLookupIdx]?.active_touch_car_idx ?? lastRow.active_touch_car_idx ?? 0)
  );

  // Detect touch timeline from velocity/distance minima and active_touch_car_idx transitions
  const touchEvents = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const dvx = (curr.ball_vx ?? 0) - (prev.ball_vx ?? 0);
    const dvy = (curr.ball_vy ?? 0) - (prev.ball_vy ?? 0);
    const dvz = (curr.ball_vz ?? 0) - (prev.ball_vz ?? 0);
    const dv = Math.hypot(dvx, dvy, dvz);
    const dist = curr.focus_car_dist_to_ball ?? 9999;
    const isCloseImpulse = dist < 330 && dv > 120;
    const isSwitch =
      Math.round(curr.active_touch_car_idx ?? 0) !== Math.round(prev.active_touch_car_idx ?? 0);
    if (isCloseImpulse || isSwitch) {
      const cIdx = Math.max(0, Math.round(curr.active_touch_car_idx ?? 0));
      const prevTouch = touchEvents[touchEvents.length - 1];
      if (!prevTouch || prevTouch.carIndex !== cIdx || i - prevTouch.frameIndex > 8) {
        touchEvents.push({
          frameIndex: i,
          tick: Math.round(curr.frame_id ?? i),
          carIndex: cIdx,
          team: cIdx % 2,
          ballX: curr.ball_x ?? 0,
          ballY: curr.ball_y ?? 0,
          ballZ: curr.ball_z ?? 0,
        });
      }
    }
  }

  let selectedCursorIndex = 0;
  let maxEyeStepUu = 0;
  let maxTargetStepUu = 0;
  let maxYawStepDeg = 0;
  let maxEyeAccelUu = 0;
  let maxPreGoalCarViewAngleDeg = 0;
  let maxPreGoalBallViewAngleDeg = 0;

  const firstFrameId = Math.round(rows[0]?.frame_id ?? 0);
  const anomalyPeaks = {
    maxEyeStep: { valueUu: 0, replayFrameIndex: 0, frameId: firstFrameId, timestampSec: 0 },
    maxYawStep: { valueDeg: 0, replayFrameIndex: 0, frameId: firstFrameId, timestampSec: 0 },
    maxEyeAccel: { valueUu: 0, replayFrameIndex: 0, frameId: firstFrameId, timestampSec: 0 },
    maxPreGoalCarViewAngle: { valueDeg: 0, replayFrameIndex: 0, frameId: firstFrameId, timestampSec: 0 },
    maxPreGoalBallViewAngle: { valueDeg: 0, replayFrameIndex: 0, frameId: firstFrameId, timestampSec: 0 },
  };

  const activeFrames = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tick = Math.round(r.frame_id ?? i);
    const ts = round3(i / REPLAY_TICK_RATE);
    if (Math.round(r.is_selected_cursor ?? 0) === 1) {
      selectedCursorIndex = i;
    }
    if ((r.eye_step_uu ?? 0) > maxEyeStepUu) {
      maxEyeStepUu = r.eye_step_uu;
      anomalyPeaks.maxEyeStep = { valueUu: round3(maxEyeStepUu), replayFrameIndex: i, frameId: tick, timestampSec: ts };
    }
    if ((r.target_step_uu ?? 0) > maxTargetStepUu) maxTargetStepUu = r.target_step_uu;
    if (Math.abs(r.yaw_step_deg ?? 0) > maxYawStepDeg) {
      maxYawStepDeg = Math.abs(r.yaw_step_deg);
      anomalyPeaks.maxYawStep = { valueDeg: round4(maxYawStepDeg), replayFrameIndex: i, frameId: tick, timestampSec: ts };
    }
    if ((r.eye_accel_uu ?? 0) > maxEyeAccelUu) {
      maxEyeAccelUu = r.eye_accel_uu;
      anomalyPeaks.maxEyeAccel = { valueUu: round3(maxEyeAccelUu), replayFrameIndex: i, frameId: tick, timestampSec: ts };
    }
    if (goalLineFrameIdx < 0 || i <= goalLineFrameIdx) {
      if ((r.car_view_angle_deg ?? 0) > maxPreGoalCarViewAngleDeg) {
        maxPreGoalCarViewAngleDeg = r.car_view_angle_deg;
        anomalyPeaks.maxPreGoalCarViewAngle = { valueDeg: round3(maxPreGoalCarViewAngleDeg), replayFrameIndex: i, frameId: tick, timestampSec: ts };
      }
      if ((r.ball_view_angle_deg ?? 0) > maxPreGoalBallViewAngleDeg) {
        maxPreGoalBallViewAngleDeg = r.ball_view_angle_deg;
        anomalyPeaks.maxPreGoalBallViewAngle = { valueDeg: round3(maxPreGoalBallViewAngleDeg), replayFrameIndex: i, frameId: tick, timestampSec: ts };
      }
    }

    const snap = initBlankSnapshotBuffer(tick, numCars);

    const bBase = SIM_OFFSETS.BALL;
    snap[bBase + BALL_FIELD_OFFSETS.POS_X] = r.ball_x ?? 0;
    snap[bBase + BALL_FIELD_OFFSETS.POS_Y] = r.ball_y ?? 0;
    snap[bBase + BALL_FIELD_OFFSETS.POS_Z] = r.ball_z ?? 93;
    snap[bBase + BALL_FIELD_OFFSETS.VEL_X] = r.ball_vx ?? 0;
    snap[bBase + BALL_FIELD_OFFSETS.VEL_Y] = r.ball_vy ?? 0;
    snap[bBase + BALL_FIELD_OFFSETS.VEL_Z] = r.ball_vz ?? 0;

    for (let c = 0; c < numCars; c++) {
      const ct = carTracks[c][i];
      if (!ct) continue;
      const cBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      snap[cBase + CAR_FIELD_OFFSETS.POS_X] = ct.x;
      snap[cBase + CAR_FIELD_OFFSETS.POS_Y] = ct.y;
      snap[cBase + CAR_FIELD_OFFSETS.POS_Z] = ct.z;
      snap[cBase + CAR_FIELD_OFFSETS.VEL_X] = ct.vx;
      snap[cBase + CAR_FIELD_OFFSETS.VEL_Y] = ct.vy;
      snap[cBase + CAR_FIELD_OFFSETS.VEL_Z] = ct.vz;

      const toBallX = (r.ball_x ?? 0) - ct.x;
      const toBallY = (r.ball_y ?? 0) - ct.y;
      const basis = buildOrthonormalBasisFromVelocity(ct.vx, ct.vy, ct.vz, toBallX, toBallY);
      snap[cBase + CAR_FIELD_OFFSETS.FWD_X] = basis.fx;
      snap[cBase + CAR_FIELD_OFFSETS.FWD_Y] = basis.fy;
      snap[cBase + CAR_FIELD_OFFSETS.FWD_Z] = basis.fz;
      snap[cBase + CAR_FIELD_OFFSETS.RIGHT_X] = basis.rx;
      snap[cBase + CAR_FIELD_OFFSETS.RIGHT_Y] = basis.ry;
      snap[cBase + CAR_FIELD_OFFSETS.RIGHT_Z] = basis.rz;
      snap[cBase + CAR_FIELD_OFFSETS.UP_X] = basis.ux;
      snap[cBase + CAR_FIELD_OFFSETS.UP_Y] = basis.uy;
      snap[cBase + CAR_FIELD_OFFSETS.UP_Z] = basis.uz;
      snap[cBase + CAR_FIELD_OFFSETS.BOOST] = 0.5;
      snap[cBase + CAR_FIELD_OFFSETS.IS_ON_GROUND] = ct.z <= 24 ? 1 : 0;
      snap[cBase + CAR_FIELD_OFFSETS.HAS_FLIPPED_OR_DOUBLE_JUMPED] = 0;
      snap[cBase + CAR_FIELD_OFFSETS.IS_DEMOED] = 0;
      snap[cBase + CAR_FIELD_OFFSETS.IS_BOOSTING] = Math.hypot(ct.vx, ct.vy, ct.vz) > 1400 ? 1 : 0;
      snap[cBase + CAR_FIELD_OFFSETS.IS_SUPERSONIC] = Math.hypot(ct.vx, ct.vy, ct.vz) > 2200 ? 1 : 0;
    }

    const postGoalElapsedSec =
      goalLineFrameIdx >= 0 && i > goalLineFrameIdx
        ? (i - goalLineFrameIdx) / REPLAY_TICK_RATE
        : 0;

    encodeReplayDirectorTelemetryIntoState(snap, {
      progress: r.progress ?? (rows.length > 1 ? i / (rows.length - 1) : 0),
      activeTouchCarIndex: Math.round(r.active_touch_car_idx ?? scorerCarIndex),
      nextTouchCarIndex: Math.round(r.next_touch_car_idx ?? -1),
      nextTouchBlend: r.next_touch_blend ?? 0,
      nextTouchBallPos: null,
      lateralBias: r.lateral_bias || 1.0,
      scorerCarIndex,
      postGoalElapsedSec,
    });

    const incidents = [];
    if (i === goalLineFrameIdx) {
      incidents.push({
        type: INCIDENT_EVENT_TYPES.GOAL_SCORED,
        team: scoringTeam,
        carIndex: scorerCarIndex,
      });
    }

    activeFrames.push({
      tick,
      timestamp: i / REPLAY_TICK_RATE,
      snapshot: snap,
      incidents,
      signals: [],
      recordedCsvRow: r,
    });
  }

  return {
    format: 'csv',
    fileName,
    activeFrames,
    scoringTeam,
    scorerCarIndex,
    selectedCursorIndex,
    lateralBias: rows[0]?.lateral_bias || 1.0,
    touchEvents,
    goalLineFrameIdx,
    hasRecordedCsvRows: true,
    anomalyPeaks,
    summary: {
      totalFrames: activeFrames.length,
      durationSec: round3(activeFrames.length / REPLAY_TICK_RATE),
      startFrameId: activeFrames[0]?.tick ?? 0,
      endFrameId: activeFrames[activeFrames.length - 1]?.tick ?? 0,
      maxEyeStepUu: round3(maxEyeStepUu),
      maxTargetStepUu: round3(maxTargetStepUu),
      maxYawStepDeg: round4(maxYawStepDeg),
      maxEyeAccelUu: round3(maxEyeAccelUu),
      maxPreGoalCarViewAngleDeg: round3(maxPreGoalCarViewAngleDeg),
      maxPreGoalBallViewAngleDeg: round3(maxPreGoalBallViewAngleDeg),
    },
  };
}

/**
 * Parses an exported Director Diagnostic Pattern JSON string into replay frames and telemetry.
 */
export function parseDirectorDiagnosticPatternJson(jsonText, fileName = 'imported-pattern.json') {
  let payload = null;
  try {
    payload = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
  } catch {
    return null;
  }
  if (!payload || !Array.isArray(payload.frames) || payload.frames.length === 0) return null;

  const meta = payload.replayMetadata || {};
  const scoringTeam = meta.scoringTeam ?? 0;
  const scorerCarIndex = meta.scorerCarIndex ?? 0;
  const goalLineFrameIdx = meta.goalLineReplayFrameIndex ?? -1;

  let maxCars = 1;
  for (const f of payload.frames) {
    if (Array.isArray(f.cars) && f.cars.length > maxCars) {
      maxCars = Math.min(MAX_CARS, f.cars.length);
    }
  }

  let selectedCursorIndex = meta.playbackStateAtExport?.selectedReplayFrameIndex ?? 0;
  const activeFrames = [];

  for (let i = 0; i < payload.frames.length; i++) {
    const f = payload.frames[i];
    if (f.isSelectedCursorFrame) selectedCursorIndex = i;
    const tick = Math.round(f.frameId ?? i);
    const snap = initBlankSnapshotBuffer(tick, maxCars);

    const bBase = SIM_OFFSETS.BALL;
    snap[bBase + BALL_FIELD_OFFSETS.POS_X] = f.ball?.pos?.[0] ?? 0;
    snap[bBase + BALL_FIELD_OFFSETS.POS_Y] = f.ball?.pos?.[1] ?? 0;
    snap[bBase + BALL_FIELD_OFFSETS.POS_Z] = f.ball?.pos?.[2] ?? 93;
    snap[bBase + BALL_FIELD_OFFSETS.VEL_X] = f.ball?.vel?.[0] ?? 0;
    snap[bBase + BALL_FIELD_OFFSETS.VEL_Y] = f.ball?.vel?.[1] ?? 0;
    snap[bBase + BALL_FIELD_OFFSETS.VEL_Z] = f.ball?.vel?.[2] ?? 0;

    if (Array.isArray(f.cars)) {
      for (const car of f.cars) {
        const c = car.carIndex ?? 0;
        if (c < 0 || c >= MAX_CARS) continue;
        const cBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
        snap[cBase + CAR_FIELD_OFFSETS.POS_X] = car.pos?.[0] ?? 0;
        snap[cBase + CAR_FIELD_OFFSETS.POS_Y] = car.pos?.[1] ?? 0;
        snap[cBase + CAR_FIELD_OFFSETS.POS_Z] = car.pos?.[2] ?? 17;
        snap[cBase + CAR_FIELD_OFFSETS.VEL_X] = car.vel?.[0] ?? 0;
        snap[cBase + CAR_FIELD_OFFSETS.VEL_Y] = car.vel?.[1] ?? 0;
        snap[cBase + CAR_FIELD_OFFSETS.VEL_Z] = car.vel?.[2] ?? 0;

        const fx = car.fwd?.[0] ?? 0;
        const fy = car.fwd?.[1] ?? 1;
        const fz = car.fwd?.[2] ?? 0;
        const ux = car.up?.[0] ?? 0;
        const uy = car.up?.[1] ?? 0;
        const uz = car.up?.[2] ?? 1;
        // Left-handed Unreal basis: right = up x fwd
        const rx = uy * fz - uz * fy;
        const ry = uz * fx - ux * fz;
        const rz = ux * fy - uy * fx;

        snap[cBase + CAR_FIELD_OFFSETS.FWD_X] = fx;
        snap[cBase + CAR_FIELD_OFFSETS.FWD_Y] = fy;
        snap[cBase + CAR_FIELD_OFFSETS.FWD_Z] = fz;
        snap[cBase + CAR_FIELD_OFFSETS.RIGHT_X] = rx;
        snap[cBase + CAR_FIELD_OFFSETS.RIGHT_Y] = ry;
        snap[cBase + CAR_FIELD_OFFSETS.RIGHT_Z] = rz;
        snap[cBase + CAR_FIELD_OFFSETS.UP_X] = ux;
        snap[cBase + CAR_FIELD_OFFSETS.UP_Y] = uy;
        snap[cBase + CAR_FIELD_OFFSETS.UP_Z] = uz;
        snap[cBase + CAR_FIELD_OFFSETS.BOOST] = car.boost ?? (car.boostPct ?? 50) / 100;
        snap[cBase + CAR_FIELD_OFFSETS.IS_ON_GROUND] = car.onGround ? 1 : 0;
        snap[cBase + CAR_FIELD_OFFSETS.IS_DEMOED] = car.demoed ? 1 : 0;
        snap[cBase + CAR_FIELD_OFFSETS.IS_BOOSTING] = car.isBoosting ? 1 : 0;
        snap[cBase + CAR_FIELD_OFFSETS.IS_SUPERSONIC] = car.supersonic ? 1 : 0;
      }
    }

    const la = f.lookahead || {};
    const cp = f.cameraPose || {};
    const focusCar =
      (Array.isArray(f.cars) && f.cars.find((c) => c.carIndex === la.activeTouchCarIndex)) ||
      f.cars?.[0] ||
      null;

    const recordedCsvRow = {
      frame_id: tick,
      replay_frame_index: i,
      timestamp_sec: f.timestampSec ?? i / REPLAY_TICK_RATE,
      progress: f.progress ?? (payload.frames.length > 1 ? i / (payload.frames.length - 1) : 0),
      is_selected_cursor: f.isSelectedCursorFrame ? 1 : 0,
      slow_mo_factor: f.slowMoFactor ?? 1.0,
      active_touch_car_idx: la.activeTouchCarIndex ?? scorerCarIndex,
      next_touch_car_idx: la.nextTouchCarIndex ?? -1,
      next_touch_blend: la.nextTouchBlend ?? 0,
      lateral_bias: la.lateralBias ?? 1.0,
      cam_eye_x: cp.eyeUnreal?.[0] ?? 0,
      cam_eye_y: cp.eyeUnreal?.[1] ?? 0,
      cam_eye_z: cp.eyeUnreal?.[2] ?? 0,
      cam_target_x: cp.targetUnreal?.[0] ?? 0,
      cam_target_y: cp.targetUnreal?.[1] ?? 0,
      cam_target_z: cp.targetUnreal?.[2] ?? 0,
      cam_dist_to_target: cp.distanceToTarget ?? 0,
      cam_yaw_deg: cp.yawDeg ?? 0,
      cam_pitch_deg: cp.pitchDeg ?? 0,
      raw_eye_x: cp.rawUndampedEyeUnreal?.[0] ?? cp.eyeUnreal?.[0] ?? 0,
      raw_eye_y: cp.rawUndampedEyeUnreal?.[1] ?? cp.eyeUnreal?.[1] ?? 0,
      raw_eye_z: cp.rawUndampedEyeUnreal?.[2] ?? cp.eyeUnreal?.[2] ?? 0,
      raw_target_x: cp.rawUndampedTargetUnreal?.[0] ?? cp.targetUnreal?.[0] ?? 0,
      raw_target_y: cp.rawUndampedTargetUnreal?.[1] ?? cp.targetUnreal?.[1] ?? 0,
      raw_target_z: cp.rawUndampedTargetUnreal?.[2] ?? cp.targetUnreal?.[2] ?? 0,
      ball_x: f.ball?.pos?.[0] ?? 0,
      ball_y: f.ball?.pos?.[1] ?? 0,
      ball_z: f.ball?.pos?.[2] ?? 93,
      ball_vx: f.ball?.vel?.[0] ?? 0,
      ball_vy: f.ball?.vel?.[1] ?? 0,
      ball_vz: f.ball?.vel?.[2] ?? 0,
      ball_speed_kph: f.ball?.speedKph ?? 0,
      focus_car_x: focusCar?.pos?.[0] ?? 0,
      focus_car_y: focusCar?.pos?.[1] ?? 0,
      focus_car_z: focusCar?.pos?.[2] ?? 17,
      focus_car_vx: focusCar?.vel?.[0] ?? 0,
      focus_car_vy: focusCar?.vel?.[1] ?? 0,
      focus_car_vz: focusCar?.vel?.[2] ?? 0,
      focus_car_dist_to_ball: focusCar?.distToBall ?? 0,
      eye_step_uu: cp.eyeStepUu ?? 0,
      target_step_uu: cp.targetStepUu ?? 0,
      yaw_step_deg: cp.yawStepDeg ?? 0,
      pitch_step_deg: cp.pitchStepDeg ?? 0,
      raw_eye_step_uu: cp.rawEyeStepUu ?? 0,
      raw_target_step_uu: cp.rawTargetStepUu ?? 0,
      eye_accel_uu: cp.eyeAccelUu ?? 0,
      target_accel_uu: cp.targetAccelUu ?? 0,
      car_view_angle_deg: cp.carViewAngleDeg ?? 0,
      ball_view_angle_deg: cp.ballViewAngleDeg ?? 0,
    };

    encodeReplayDirectorTelemetryIntoState(snap, {
      progress: recordedCsvRow.progress,
      activeTouchCarIndex: recordedCsvRow.active_touch_car_idx,
      nextTouchCarIndex: recordedCsvRow.next_touch_car_idx,
      nextTouchBlend: recordedCsvRow.next_touch_blend,
      nextTouchBallPos: Array.isArray(la.nextTouchBallPos)
        ? { x: la.nextTouchBallPos[0], y: la.nextTouchBallPos[1], z: la.nextTouchBallPos[2] }
        : null,
      lateralBias: recordedCsvRow.lateral_bias,
      scorerCarIndex,
      postGoalElapsedSec: la.postGoalElapsedSec ?? 0,
    });

    activeFrames.push({
      tick,
      timestamp: f.timestampSec ?? i / REPLAY_TICK_RATE,
      snapshot: snap,
      incidents: Array.isArray(f.incidents) ? f.incidents : [],
      signals: [],
      recordedCsvRow,
    });
  }

  const touchEvents = Array.isArray(payload.touchTimeline)
    ? payload.touchTimeline.map((t) => ({
        frameIndex: t.replayFrameIndex ?? 0,
        tick: t.frameId ?? 0,
        carIndex: t.carIndex ?? 0,
        team: t.team ?? 0,
        ballX: t.ballPos?.[0] ?? 0,
        ballY: t.ballPos?.[1] ?? 0,
        ballZ: t.ballPos?.[2] ?? 0,
      }))
    : [];

  const smooth = meta.trajectorySmoothnessSummary || {};
  return {
    format: 'json',
    fileName,
    activeFrames,
    scoringTeam,
    scorerCarIndex,
    selectedCursorIndex,
    lateralBias: payload.frames[0]?.lookahead?.lateralBias || 1.0,
    touchEvents,
    goalLineFrameIdx,
    hasRecordedCsvRows: true,
    directorConfig: payload.directorConfig || null,
    anomalyPeaks: meta.anomalyPeaks || null,
    summary: {
      totalFrames: activeFrames.length,
      durationSec: round3(activeFrames.length / REPLAY_TICK_RATE),
      startFrameId: activeFrames[0]?.tick ?? 0,
      endFrameId: activeFrames[activeFrames.length - 1]?.tick ?? 0,
      maxEyeStepUu: smooth.maxEyeStepUu ?? 0,
      maxTargetStepUu: smooth.maxTargetStepUu ?? 0,
      maxYawStepDeg: smooth.maxYawStepDeg ?? 0,
      maxEyeAccelUu: smooth.maxEyeAccelUu ?? 0,
      maxPreGoalCarViewAngleDeg: smooth.maxPreGoalCarViewAngleDeg ?? 0,
      maxPreGoalBallViewAngleDeg: smooth.maxPreGoalBallViewAngleDeg ?? 0,
    },
  };
}

/**
 * Auto-detects CSV vs JSON format and parses a Director Diagnostic Pattern text.
 */
export function parseDirectorDiagnosticPatternText(text, fileName = 'imported-pattern.csv') {
  if (text instanceof Uint8Array || text instanceof ArrayBuffer) {
    return parseDirectorDiagnosticContainerBytes(text, fileName);
  }
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    return parseDirectorDiagnosticPatternJson(trimmed, fileName);
  }
  return parseDirectorDiagnosticPatternCsv(trimmed, fileName);
}

/**
 * Universal async parser that accepts `.rcgr.gz`, `.rcreplay.gz`, raw binary `Uint8Array`/`ArrayBuffer`,
 * `File`/`Blob`, or legacy `.csv`/`.json` text.
 */
export async function parseDirectorDiagnosticInput(input, fileName = 'imported.rcgr.gz') {
  if (!input) return null;
  if (typeof input === 'string') {
    return parseDirectorDiagnosticPatternText(input, fileName);
  }
  let rawBytes = null;
  let resolvedName = fileName;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (typeof input.name === 'string' && input.name) {
      resolvedName = input.name;
    }
    const buf = await input.arrayBuffer();
    rawBytes = new Uint8Array(buf);
  } else if (input instanceof ArrayBuffer) {
    rawBytes = new Uint8Array(input);
  } else if (input instanceof Uint8Array) {
    rawBytes = input;
  } else if (typeof input === 'object' && Array.isArray(input.activeFrames)) {
    return input;
  }
  if (!rawBytes || rawBytes.byteLength === 0) return null;

  const decompressed = await decompressBytesIfGzip(rawBytes);
  if (isBinaryRCReplayContainer(decompressed)) {
    return parseDirectorDiagnosticContainerBytes(decompressed, resolvedName);
  }
  const text = new TextDecoder().decode(decompressed);
  return parseDirectorDiagnosticPatternText(text, resolvedName);
}

function triggerBrowserBlobDownload(blob, filename) {
  if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

/**
 * Exports the active or retained last Goal Replay Director Camera container (`.rcgr.gz` default, or legacy `csv`/`json`).
 */
export function exportReplayDirectorDiagnosticPattern(ctrl, format = 'rcgr', options = {}) {
  const totalFrames = ctrl
    ? (ctrl.ActiveWindowCount > 0 ? ctrl.ActiveWindowCount : ctrl.getTotalRecordedFrames())
    : 0;
  if (!ctrl || totalFrames <= 0) {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snap = ctrl.getCurrentFrameDiagnosticSnapshot();
  const frameTag = snap ? `frame-${snap.frameId}-idx-${snap.replayFrameIndex}` : 'replay';

  if (format === 'rcgr' || format === 'rcgr.gz') {
    const containerPayload = buildDirectorReplayContainerPayload(ctrl, options);
    if (!containerPayload) return null;
    const containerBytes = serializeRCReplayBinaryContainer(containerPayload);
    const filename = `goal-replay-${frameTag}-${stamp}.rcgr.gz`;

    if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
      packAndCompressReplayInBackground(containerPayload)
        .then((packedResult) => {
          const bytes = packedResult?.compressedBytes || packedResult?.buffer;
          if (!bytes) throw new Error('Empty compressed replay buffer');
          const blob = new Blob([bytes], { type: 'application/gzip' });
          triggerBrowserBlobDownload(blob, filename);
        })
        .catch(async () => {
          const gz = await compressBytesGzip(containerBytes);
          const blob = new Blob([gz], { type: 'application/gzip' });
          triggerBrowserBlobDownload(blob, filename);
        });
    }
    return {
      filename,
      containerBytes,
      directorReplayMeta: containerPayload.directorReplayMeta,
      payload: containerPayload.diagnosticPayload,
    };
  }

  if (format === 'csv') {
    const csv = ctrl.buildDirectorDiagnosticPatternCsv(options);
    if (!csv) return null;
    const filename = `replay-director-pattern-${frameTag}-${stamp}.csv`;
    if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      triggerBrowserBlobDownload(blob, filename);
    }
    return { filename, content: csv };
  }

  const payload = ctrl.buildDirectorDiagnosticPatternPayload(options);
  if (!payload) return null;
  const json = JSON.stringify(payload, null, 2);
  const filename = `replay-director-pattern-${frameTag}-${stamp}.json`;
  if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = new Blob([json], { type: 'application/json' });
    triggerBrowserBlobDownload(blob, filename);
  }
  return { filename, payload, content: json };
}

function projectPointToCameraScreenNdc(eyeUnreal, forwardUnreal, fovDeg = 80, aspect = 16 / 9, pointUnreal = [0, 0, 0]) {
  const vx = (pointUnreal[0] ?? 0) - (eyeUnreal[0] ?? 0);
  const vy = (pointUnreal[1] ?? 0) - (eyeUnreal[1] ?? 0);
  const vz = (pointUnreal[2] ?? 0) - (eyeUnreal[2] ?? 0);
  const distUu = Math.hypot(vx, vy, vz);

  let fx = forwardUnreal[0] ?? 0;
  let fy = forwardUnreal[1] ?? 1;
  let fz = forwardUnreal[2] ?? 0;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;

  // World Up in Unreal is (0, 0, 1). In left-handed Unreal (X right, Y forward, Z up):
  // cameraRight = normalize((-fy, fx, 0)) when upright, or cross(upWorld, forward) = (-fy, fx, 0)
  let rx = -fy;
  let ry = fx;
  let rz = 0;
  const rl = Math.hypot(rx, ry, rz);
  if (rl > 1e-4) {
    rx /= rl;
    ry /= rl;
  } else {
    rx = 1;
    ry = 0;
  }
  // cameraUp = cross(forward, right) in left-handed or orthonormal upward vector:
  // With forward = (fx, fy, fz) and right = (-fy/h, fx/h, 0), upward perpendicular is (-fx*fz/h, -fy*fz/h, h)
  const horiz = Math.hypot(fx, fy) || 1e-4;
  const ux = (-fx * fz) / horiz;
  const uy = (-fy * fz) / horiz;
  const uz = horiz;

  const camX = vx * rx + vy * ry + vz * rz;
  const camY = vx * ux + vy * uy + vz * uz;
  const camZ = vx * fx + vy * fy + vz * fz;

  const halfFovVRad = ((Math.max(10, Math.min(160, Number(fovDeg) || 80)) * 0.5) * Math.PI) / 180;
  const tanHalfFovV = Math.tan(halfFovVRad) || 1;
  const safeAspect = Math.max(0.25, Number(aspect) || 16 / 9);
  const tanHalfFovH = tanHalfFovV * safeAspect;
  const hFovDeg = ((Math.atan(tanHalfFovH) * 2) * 180) / Math.PI;

  const inFront = camZ > 1.0;
  const depthForProj = Math.max(1.0, Math.abs(camZ));
  const ndcX = camX / (depthForProj * tanHalfFovH);
  const ndcY = camY / (depthForProj * tanHalfFovV);
  const inFrustum = inFront && Math.abs(ndcX) <= 1.0 && Math.abs(ndcY) <= 1.0;
  const inSafeFrame85 = inFront && Math.abs(ndcX) <= 0.85 && Math.abs(ndcY) <= 0.85;

  const cosAngle = distUu > 1e-4 ? Math.max(-1, Math.min(1, camZ / distUu)) : 1;
  const viewAngleFromCenterDeg = (Math.acos(cosAngle) * 180) / Math.PI;
  const horizOffsetDeg = (Math.atan2(camX, depthForProj) * 180) / Math.PI;
  const vertOffsetDeg = (Math.atan2(camY, depthForProj) * 180) / Math.PI;

  return {
    distanceUu: round3(distUu),
    viewDepthZ: round3(camZ),
    inFront,
    inFrustum,
    inSafeFrame85,
    ndc: [round4(ndcX), round4(ndcY)],
    screenPct: [round3((ndcX * 0.5 + 0.5) * 100), round3((0.5 - ndcY * 0.5) * 100)],
    viewAngleFromCenterDeg: round3(viewAngleFromCenterDeg),
    horizOffsetDeg: round3(horizOffsetDeg),
    vertOffsetDeg: round3(vertOffsetDeg),
    hFovDeg: round3(hFovDeg),
    vFovDeg: round3(Number(fovDeg) || 80),
  };
}

function computeCameraSceneFramingAnalysis(eyeUnreal, forwardUnreal, fovDeg, aspect, snap, scoringTeam = 0) {
  const ballPos = snap?.ball?.pos || [0, 0, 93];
  const lookahead = snap?.lookahead || {};
  const cars = Array.isArray(snap?.cars) ? snap.cars : [];
  const focusCar =
    cars.find((c) => c.carIndex === lookahead.activeTouchCarIndex) ||
    cars[0] ||
    null;
  const nextCar =
    lookahead.nextTouchCarIndex >= 0
      ? cars.find((c) => c.carIndex === lookahead.nextTouchCarIndex) || null
      : null;

  const goalSignY = scoringTeam === 0 ? 1.0 : -1.0;
  const goalCenterPos = [0, goalSignY * 5120.0, 321.0];
  const anchorGoalY = goalSignY * 5420.0;

  // Goal corridor basis at current ball position (matches ReplayDirectorCamera.js)
  const toGoalX = 0.0 - ballPos[0];
  const toGoalY = goalSignY * Math.max(420.0, (anchorGoalY - ballPos[1]) * goalSignY);
  const dirNorm = Math.hypot(toGoalX, toGoalY) || 1.0;
  const ugX = toGoalX / dirNorm;
  const ugY = toGoalY / dirNorm;
  const usX = -ugY;
  const usY = ugX;

  const relBallX = eyeUnreal[0] - ballPos[0];
  const relBallY = eyeUnreal[1] - ballPos[1];
  const relBallZ = eyeUnreal[2] - ballPos[2];

  // Camera placement in the Ball -> Goal Corridor coordinate system:
  // backDistBehindBallUu > 0 means camera is behind the ball along the ball->goal line
  const backDistBehindBallUu = -(relBallX * ugX + relBallY * ugY);
  const signedLateralOffsetFromCorridorUu = relBallX * usX + relBallY * usY;
  const inferredLateralBias = signedLateralOffsetFromCorridorUu >= 0 ? 1.0 : -1.0;
  const lateralSideDistMagnitudeUu = Math.abs(signedLateralOffsetFromCorridorUu);

  let relFocusCar = null;
  let impliedRayCarWeight = null;
  let impliedRayBallWeight = null;

  const unitTo = (pt) => {
    const dx = pt[0] - eyeUnreal[0];
    const dy = pt[1] - eyeUnreal[1];
    const dz = pt[2] - eyeUnreal[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    return [dx / l, dy / l, dz / l, l];
  };

  const uBall = unitTo(ballPos);
  if (focusCar) {
    const cPos = focusCar.pos;
    const uCar = unitTo(cPos);
    const carBehindBallAlongCorridorUu = (ballPos[0] - cPos[0]) * ugX + (ballPos[1] - cPos[1]) * ugY;
    const carSideOfBallAlongCorridorUu = (cPos[0] - ballPos[0]) * usX + (cPos[1] - ballPos[1]) * usY;
    const backDistBehindFocusCarUu = -((eyeUnreal[0] - cPos[0]) * ugX + (eyeUnreal[1] - cPos[1]) * ugY);

    // Solve least-squares projection of camera forward onto the Car-Ball unit-ray arc
    const diffX = uCar[0] - uBall[0];
    const diffY = uCar[1] - uBall[1];
    const diffZ = uCar[2] - uBall[2];
    const diffSq = diffX * diffX + diffY * diffY + diffZ * diffZ;
    let rawCarWeight = 0.5;
    if (diffSq > 1e-5) {
      const fMinusBallX = forwardUnreal[0] - uBall[0];
      const fMinusBallY = forwardUnreal[1] - uBall[1];
      const fMinusBallZ = forwardUnreal[2] - uBall[2];
      rawCarWeight = (fMinusBallX * diffX + fMinusBallY * diffY + fMinusBallZ * diffZ) / diffSq;
    }
    impliedRayCarWeight = round4(Math.max(0, Math.min(1, rawCarWeight)));
    impliedRayBallWeight = round4(1 - impliedRayCarWeight);

    relFocusCar = {
      carIndex: focusCar.carIndex,
      team: focusCar.team,
      worldPosUnreal: focusCar.pos,
      distanceFromCameraUu: round3(uCar[3]),
      offsetFromCarUnreal: [
        round3(eyeUnreal[0] - cPos[0]),
        round3(eyeUnreal[1] - cPos[1]),
        round3(eyeUnreal[2] - cPos[2]),
      ],
      backDistBehindFocusCarAlongCorridorUu: round3(backDistBehindFocusCarUu),
      carBehindBallAlongCorridorUu: round3(carBehindBallAlongCorridorUu),
      carSideOfBallAlongCorridorUu: round3(carSideOfBallAlongCorridorUu),
      carToBallDistanceUu: focusCar.distToBall,
    };
  }

  const ballScreen = projectPointToCameraScreenNdc(eyeUnreal, forwardUnreal, fovDeg, aspect, ballPos);
  const focusCarScreen = focusCar
    ? projectPointToCameraScreenNdc(eyeUnreal, forwardUnreal, fovDeg, aspect, focusCar.pos)
    : null;
  const nextCarScreen = nextCar
    ? projectPointToCameraScreenNdc(eyeUnreal, forwardUnreal, fovDeg, aspect, nextCar.pos)
    : null;
  const goalCenterScreen = projectPointToCameraScreenNdc(
    eyeUnreal,
    forwardUnreal,
    fovDeg,
    aspect,
    goalCenterPos
  );

  const perCarVisibility = cars.map((c) => {
    const proj = projectPointToCameraScreenNdc(eyeUnreal, forwardUnreal, fovDeg, aspect, c.pos);
    const isNearOccluder =
      c.carIndex !== (focusCar?.carIndex ?? -1) &&
      proj.inFront &&
      proj.distanceUu < 480 &&
      proj.viewAngleFromCenterDeg < 18;
    return {
      carIndex: c.carIndex,
      team: c.team,
      isFocusCar: c.carIndex === (focusCar?.carIndex ?? -1),
      isNextTouchCar: c.carIndex === (lookahead.nextTouchCarIndex ?? -1),
      posUnreal: c.pos,
      velUnreal: c.vel,
      distToBallUu: c.distToBall,
      ...proj,
      isNearOccluder,
    };
  });

  const visibleCarIndices = perCarVisibility.filter((c) => c.inFrustum).map((c) => c.carIndex);
  const occludingCarIndices = perCarVisibility.filter((c) => c.isNearOccluder).map((c) => c.carIndex);

  return {
    corridorDecomposition: {
      corridorForwardUnitXY: [round4(ugX), round4(ugY)],
      corridorLateralUnitXY: [round4(usX), round4(usY)],
      backDistBehindBallUu: round3(backDistBehindBallUu),
      signedLateralOffsetFromCorridorUu: round3(signedLateralOffsetFromCorridorUu),
      lateralSideDistMagnitudeUu: round3(lateralSideDistMagnitudeUu),
      inferredLateralBias,
      heightAboveGroundUu: round3(eyeUnreal[2]),
      heightAboveBallUu: round3(relBallZ),
      distanceToGoalLineUu: round3(Math.abs(goalSignY * 5120.0 - eyeUnreal[1])),
      impliedRayCarWeight,
      impliedRayBallWeight,
    },
    relativeToBall: {
      worldPosUnreal: ballPos,
      distanceFromCameraUu: ballScreen.distanceUu,
      offsetFromBallUnreal: [round3(relBallX), round3(relBallY), round3(relBallZ)],
    },
    relativeToFocusCar: relFocusCar,
    screenComposition: {
      ball: ballScreen,
      focusCar: focusCarScreen,
      nextTouchCar: nextCarScreen,
      scoringGoalCenter: goalCenterScreen,
      visibleCarIndices,
      visibleCarCount: visibleCarIndices.length,
      occludingCarIndices,
    },
    allCarsScreenProjections: perCarVisibility,
  };
}

/**
 * Builds a standalone Reference Keyframe Guidance JSON payload at the current replay frame,
 * comparing the user's manually positioned Free Camera (Shift+F) pose + FOV against the
 * current Director Camera output, with full corridor decomposition, inverse ray weights,
 * screen-space NDC projections, and a ±15-frame local kinematic context window.
 */
export function buildDirectorReferenceKeyframePayload(ctrl, options = {}) {
  if (!ctrl) return null;
  const snap = buildCurrentFrameDiagnosticSnapshot(ctrl);
  if (!snap) return null;

  const liveCam = options.liveCameraState || null;
  const autoEyeUnreal = snap.cameraPose.dampedEyeUnreal;
  const autoTargetUnreal = snap.cameraPose.dampedTargetUnreal;
  const autoForwardUnreal = snap.cameraPose.forwardUnreal;
  const autoDist = snap.cameraPose.distanceToTarget || 1000.0;

  const refEyeUnreal = Array.isArray(liveCam?.eyeUnreal)
    ? liveCam.eyeUnreal.map((v) => round3(v))
    : [...autoEyeUnreal];
  const refForwardUnreal = Array.isArray(liveCam?.forwardUnreal)
    ? liveCam.forwardUnreal.map((v) => round4(v))
    : [...autoForwardUnreal];
  const refLookAtTargetUnreal = [
    round3(refEyeUnreal[0] + refForwardUnreal[0] * autoDist),
    round3(refEyeUnreal[1] + refForwardUnreal[1] * autoDist),
    round3(refEyeUnreal[2] + refForwardUnreal[2] * autoDist),
  ];
  const refYawDeg = round3((Math.atan2(refForwardUnreal[0], refForwardUnreal[1]) * 180) / Math.PI);
  const refPitchDeg = round3(
    (Math.asin(Math.max(-1, Math.min(1, refForwardUnreal[2]))) * 180) / Math.PI
  );
  const refFovDeg = round3(Number(options.fovDeg ?? liveCam?.fovDeg) || 80);
  const refAspect = round4(Number(liveCam?.aspect) || 16 / 9);

  const referenceAnalysis = computeCameraSceneFramingAnalysis(
    refEyeUnreal,
    refForwardUnreal,
    refFovDeg,
    refAspect,
    snap,
    ctrl.scoringTeam ?? 0
  );
  const autoCamAnalysis = computeCameraSceneFramingAnalysis(
    autoEyeUnreal,
    autoForwardUnreal,
    refFovDeg,
    refAspect,
    snap,
    ctrl.scoringTeam ?? 0
  );

  const eyeDeltaUnreal = [
    round3(refEyeUnreal[0] - autoEyeUnreal[0]),
    round3(refEyeUnreal[1] - autoEyeUnreal[1]),
    round3(refEyeUnreal[2] - autoEyeUnreal[2]),
  ];
  const eyeDeltaDistanceUu = round3(
    Math.hypot(eyeDeltaUnreal[0], eyeDeltaUnreal[1], eyeDeltaUnreal[2])
  );
  const yawDeltaDeg = round3(wrapAngleDeltaDeg(refYawDeg, snap.cameraPose.yawDeg));
  const pitchDeltaDeg = round3(refPitchDeg - snap.cameraPose.pitchDeg);

  const windowDiag = buildDirectorFrameWindowDiagnostic(ctrl, options.windowRadius ?? 15);

  return {
    schema: 'RocketCompanion.ReplayDirectorReferenceKeyframe.v1',
    exportedAt: new Date().toISOString(),
    sourceReplayFileName: ctrl.importedFileName || 'live-goal-replay',
    note:
      options.note ||
      'Standalone single-frame Director Camera guidance keyframe captured via Free Camera (Shift+F). Compare referenceCamera against currentDirectorAutoCam to see desired framing vs current algorithm output.',
    coordinateConventions: {
      unreal: 'X right, Y forward (toward Orange goal +5120), Z up (Unreal Units)',
      threeJs: 'X right, Y up, Z forward',
      screenNdc: 'X in [-1 left .. +1 right], Y in [-1 bottom .. +1 top], Z > 0 in front of camera',
    },
    frameContext: {
      frameId: snap.frameId,
      replayFrameIndex: snap.replayFrameIndex,
      totalReplayFrames: snap.totalReplayFrames,
      timestampInReplaySec: snap.timestampInReplaySec,
      progress: snap.progress,
      slowMoFactor: snap.slowMoFactor,
      scoringTeam: snap.scoringTeam,
      scoringTeamName: snap.scoringTeam === 0 ? 'BLUE' : 'ORANGE',
      scorerCarIndex: snap.scorerCarIndex,
      lookaheadState: snap.lookahead,
    },
    referenceCamera: {
      capturedFromFreeCam: Boolean(liveCam?.isFreeCam),
      fovDeg: refFovDeg,
      aspectRatio: refAspect,
      eyeUnreal: refEyeUnreal,
      lookAtTargetUnreal: refLookAtTargetUnreal,
      forwardUnreal: refForwardUnreal,
      eyeThreeJs: [refEyeUnreal[0], refEyeUnreal[2], refEyeUnreal[1]],
      lookAtTargetThreeJs: [
        refLookAtTargetUnreal[0],
        refLookAtTargetUnreal[2],
        refLookAtTargetUnreal[1],
      ],
      yawDeg: refYawDeg,
      pitchDeg: refPitchDeg,
      ...referenceAnalysis,
    },
    currentDirectorAutoCam: {
      eyeUnreal: autoEyeUnreal,
      lookAtTargetUnreal: autoTargetUnreal,
      forwardUnreal: autoForwardUnreal,
      rawUndampedEyeUnreal: snap.cameraPose.rawUndampedEyeUnreal,
      rawUndampedTargetUnreal: snap.cameraPose.rawUndampedTargetUnreal,
      yawDeg: snap.cameraPose.yawDeg,
      pitchDeg: snap.cameraPose.pitchDeg,
      distanceToTargetUu: snap.cameraPose.distanceToTarget,
      eyeStepUu: snap.cameraPose.eyeStepUu,
      yawStepDeg: snap.cameraPose.yawStepDeg,
      ...autoCamAnalysis,
    },
    deltaReferenceVsAutoCam: {
      eyeDeltaUnreal,
      eyeDeltaDistanceUu,
      yawDeltaDeg,
      pitchDeltaDeg,
      corridorBackDistDeltaUu: round3(
        referenceAnalysis.corridorDecomposition.backDistBehindBallUu -
          autoCamAnalysis.corridorDecomposition.backDistBehindBallUu
      ),
      corridorLateralOffsetDeltaUu: round3(
        referenceAnalysis.corridorDecomposition.signedLateralOffsetFromCorridorUu -
          autoCamAnalysis.corridorDecomposition.signedLateralOffsetFromCorridorUu
      ),
      heightDeltaUu: round3(refEyeUnreal[2] - autoEyeUnreal[2]),
      lateralBiasFlipped:
        referenceAnalysis.corridorDecomposition.inferredLateralBias !==
        autoCamAnalysis.corridorDecomposition.inferredLateralBias,
      impliedRayCarWeightDelta:
        referenceAnalysis.corridorDecomposition.impliedRayCarWeight !== null &&
        autoCamAnalysis.corridorDecomposition.impliedRayCarWeight !== null
          ? round4(
              referenceAnalysis.corridorDecomposition.impliedRayCarWeight -
                autoCamAnalysis.corridorDecomposition.impliedRayCarWeight
            )
          : null,
      ballViewAngleDeltaDeg: round3(
        referenceAnalysis.screenComposition.ball.viewAngleFromCenterDeg -
          autoCamAnalysis.screenComposition.ball.viewAngleFromCenterDeg
      ),
      focusCarViewAngleDeltaDeg:
        referenceAnalysis.screenComposition.focusCar && autoCamAnalysis.screenComposition.focusCar
          ? round3(
              referenceAnalysis.screenComposition.focusCar.viewAngleFromCenterDeg -
                autoCamAnalysis.screenComposition.focusCar.viewAngleFromCenterDeg
            )
          : null,
    },
    directorConfigAtCapture: { ...REPLAY_DIRECTOR_CONFIG },
    entitiesAtFrame: {
      ball: snap.ball,
      cars: snap.cars,
      incidents: snap.incidents,
    },
    touchTimeline: windowDiag?.touchTimeline || [],
    surroundingWindowFrames: windowDiag?.windowFrames || [],
  };
}

/**
 * Exports a standalone Reference Keyframe Guidance JSON file (`director-ref-keyframe-frame-<id>.json`)
 * and optionally copies it to the clipboard.
 */
export function exportReplayDirectorReferenceKeyframe(ctrl, options = {}) {
  const payload = buildDirectorReferenceKeyframePayload(ctrl, options);
  if (!payload) return null;
  const json = JSON.stringify(payload, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fId = payload.frameContext.frameId;
  const fIdx = payload.frameContext.replayFrameIndex;
  const filename = `director-ref-keyframe-frame-${fId}-idx-${fIdx}-${stamp}.json`;

  if (options.download !== false && typeof document !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = new Blob([json], { type: 'application/json' });
    triggerBrowserBlobDownload(blob, filename);
  }
  return { filename, payload, content: json };
}



