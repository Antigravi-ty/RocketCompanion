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
} from '../physics/RocketSimConstants.js';
import {
  computeGoalReplayCameraPose,
  REPLAY_DIRECTOR_CONFIG,
  DEFAULT_REPLAY_DIRECTOR_CONFIG,
} from './ReplayFrameInterpolator.js';

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
      onGround: snap[base + 19] === 1,
      supersonic: snap[base + 20] === 1,
      demoed: snap[base + 21] === 1,
      isBoosting: snap[base + 23] === 1,
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
  const total = ctrl.getTotalRecordedFrames();
  if (total <= 0) return null;
  const idx = ctrl.currentFrameIndex;
  const entry = ctrl.getFrameEntryByIndex(idx);
  const snap = ctrl.getFrameBufferByIndex(idx);
  if (!snap) return null;

  const entities = extractFrameEntities(snap, ctrl.carTeamResolver);
  const frameId = entry?.tick ?? entities.tick ?? idx;
  const progress = total > 1 ? idx / (total - 1) : 0;
  const lookahead = ctrl.resolveTouchLookaheadForFrame(
    idx,
    ctrl.directorCameraState.activeTouchCarIndex ?? ctrl.scorerCarIndex ?? 0
  );
  const slowMoFactor = ctrl.computeDramaticSlowMoFactor(idx, { ignoreScrubState: true });

  const rawPose = computeGoalReplayCameraPose(snap, ctrl.scoringTeam, {
    scorerCarIndex: ctrl.scorerCarIndex,
    progress,
    directorState: {
      ...ctrl.directorCameraState,
      activeTouchCarIndex: lookahead.primaryCarIndex,
      nextTouchCarIndex: lookahead.nextCarIndex,
      nextTouchBlend: lookahead.nextTouchBlend,
      nextTouchBallPos: lookahead.nextTouchBallPos,
    },
    dt: 1 / REPLAY_TICK_RATE,
    exactDt: true,
    skipDamping: true,
  });

  const dampedPose = ctrl.directorCameraState.initialized
    ? {
        eyeX: ctrl.directorCameraState.eyeX,
        eyeY: ctrl.directorCameraState.eyeY,
        eyeZ: ctrl.directorCameraState.eyeZ,
        targetX: ctrl.directorCameraState.targetX,
        targetY: ctrl.directorCameraState.targetY,
        targetZ: ctrl.directorCameraState.targetZ,
      }
    : rawPose;

  const dampedAngles = computeCameraAnglesFromPose(dampedPose);
  const rawAngles = computeCameraAnglesFromPose(rawPose);

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
      lateralBias: ctrl.directorCameraState.lateralBias || 1.0,
    },
    cameraPose: {
      dampedEyeUnreal: [round3(dampedPose.eyeX), round3(dampedPose.eyeY), round3(dampedPose.eyeZ)],
      dampedTargetUnreal: [round3(dampedPose.targetX), round3(dampedPose.targetY), round3(dampedPose.targetZ)],
      dampedEyeThreeJs: [round3(dampedPose.eyeX), round3(dampedPose.eyeZ), round3(dampedPose.eyeY)],
      dampedTargetThreeJs: [round3(dampedPose.targetX), round3(dampedPose.targetZ), round3(dampedPose.targetY)],
      ...dampedAngles,
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

/**
 * Simulates the full Goal Replay Director camera trajectory deterministically at 120Hz
 * across all frames in the replay window for camera diagnostics.
 */
export function buildDirectorDiagnosticPatternPayload(ctrl, options = {}) {
  const total = ctrl.getTotalRecordedFrames();
  if (total <= 0) return null;

  const currentSnapshot = buildCurrentFrameDiagnosticSnapshot(ctrl);
  const firstEntry = ctrl.getFrameEntryByIndex(0);
  const lastEntry = ctrl.getFrameEntryByIndex(total - 1);
  const firstSnap = ctrl.getFrameBufferByIndex(0);
  const lastSnap = ctrl.getFrameBufferByIndex(total - 1);

  const startFrameId = firstEntry?.tick ?? Math.round(firstSnap?.[SIM_OFFSETS.TICK] || 0);
  const endFrameId = lastEntry?.tick ?? Math.round(lastSnap?.[SIM_OFFSETS.TICK] || (startFrameId + total - 1));

  const simDirectorState = {
    initialized: false,
    eyeX: 0,
    eyeY: 0,
    eyeZ: 0,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    lateralBias: ctrl.directorCameraState.lateralBias || 1.0,
    hasResolvedInitialLateralBias: Boolean(ctrl.directorCameraState.hasResolvedInitialLateralBias),
    activeTouchCarIndex: ctrl.scorerCarIndex ?? 0,
    nextTouchCarIndex: -1,
    nextTouchBlend: 0,
    nextTouchBallPos: null,
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

  for (let idx = 0; idx < total; idx++) {
    const entry = ctrl.getFrameEntryByIndex(idx);
    const snap = ctrl.getFrameBufferByIndex(idx);
    if (!snap) continue;

    const entities = extractFrameEntities(snap, ctrl.carTeamResolver);
    const frameId = entry?.tick ?? entities.tick ?? (startFrameId + idx);
    const progress = total > 1 ? idx / (total - 1) : 0;

    const lookahead = ctrl.resolveTouchLookaheadForFrame(
      idx,
      simDirectorState.activeTouchCarIndex ?? ctrl.scorerCarIndex ?? 0
    );
    simDirectorState.activeTouchCarIndex = lookahead.primaryCarIndex;
    simDirectorState.nextTouchCarIndex = lookahead.nextCarIndex;
    simDirectorState.nextTouchBlend = lookahead.nextTouchBlend;
    simDirectorState.nextTouchBallPos = lookahead.nextTouchBallPos;

    const slowMoFactor = ctrl.computeDramaticSlowMoFactor(idx, { ignoreScrubState: true });
    // Each replay frame step is exactly 1 simulation tick (1 / 120s) regardless of slow-mo display rate
    const effectiveDt = 1 / REPLAY_TICK_RATE;

    const dampedPose = computeGoalReplayCameraPose(snap, ctrl.scoringTeam, {
      scorerCarIndex: ctrl.scorerCarIndex,
      progress,
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

      if (prevEyeVel && prevTargetVel) {
        eyeAccelUu = Math.hypot(evX - prevEyeVel[0], evY - prevEyeVel[1], evZ - prevEyeVel[2]);
        targetAccelUu = Math.hypot(tvX - prevTargetVel[0], tvY - prevTargetVel[1], tvZ - prevTargetVel[2]);
      }

      prevEyeVel = [evX, evY, evZ];
      prevTargetVel = [tvX, tvY, tvZ];

      if (eyeStepUu > maxEyeStepUu) maxEyeStepUu = eyeStepUu;
      if (targetStepUu > maxTargetStepUu) maxTargetStepUu = targetStepUu;
      if (rawEyeStepUu > maxRawEyeStepUu) maxRawEyeStepUu = rawEyeStepUu;
      if (rawTargetStepUu > maxRawTargetStepUu) maxRawTargetStepUu = rawTargetStepUu;
      if (eyeAccelUu > maxEyeAccelUu) maxEyeAccelUu = eyeAccelUu;
      if (targetAccelUu > maxTargetAccelUu) maxTargetAccelUu = targetAccelUu;
      if (Math.abs(yawStepDeg) > maxYawStepDeg) maxYawStepDeg = Math.abs(yawStepDeg);
    }

    prevPose = { ...dampedPose };
    prevRawPose = { ...rawPose };
    prevAngles = { ...dampedAngles };

    frames.push({
      frameId,
      replayFrameIndex: idx,
      timestampSec: round3(idx / REPLAY_TICK_RATE),
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
      trajectorySmoothnessSummary: {
        maxEyeStepUu: round3(maxEyeStepUu),
        maxTargetStepUu: round3(maxTargetStepUu),
        maxRawEyeStepUu: round3(maxRawEyeStepUu),
        maxRawTargetStepUu: round3(maxRawTargetStepUu),
        maxEyeAccelUu: round3(maxEyeAccelUu),
        maxTargetAccelUu: round3(maxTargetAccelUu),
        maxYawStepDeg: round4(maxYawStepDeg),
      },
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
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

/**
 * Exports the active Goal Replay Director Camera diagnostic pattern (JSON or CSV) via browser download.
 */
export function exportReplayDirectorDiagnosticPattern(ctrl, format = 'json', options = {}) {
  if (!ctrl || !ctrl.isActive || ctrl.getTotalRecordedFrames() <= 0) {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snap = ctrl.getCurrentFrameDiagnosticSnapshot();
  const frameTag = snap ? `frame-${snap.frameId}-idx-${snap.replayFrameIndex}` : 'replay';

  if (format === 'csv') {
    const csv = ctrl.buildDirectorDiagnosticPatternCsv(options);
    if (!csv) return null;
    const filename = `replay-director-pattern-${frameTag}-${stamp}.csv`;
    if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
    return { filename, content: csv };
  }

  const payload = ctrl.buildDirectorDiagnosticPatternPayload(options);
  if (!payload) return null;
  const json = JSON.stringify(payload, null, 2);
  const filename = `replay-director-pattern-${frameTag}-${stamp}.json`;
  if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  return { filename, payload, content: json };
}
