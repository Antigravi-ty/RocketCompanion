/**
 * ReplayTimelineCore.js
 * Pure worker-safe Unified 256MB WASM Native Replay Buffer & JS RingBuffer Timeline Scrubber
 * and Goal Replay Controller (zero DOM, WebAudio, or UI store dependencies).
 */

import { REPLAY_TICK_RATE, resolveReplayAudioCueForSignal } from './ReplayRingBuffer.js';
import {
  SIM_OFFSETS,
  CAR_STATE_STRIDE,
  MAX_CARS,
  PHYSICS_EVENT_TYPES,
  INCIDENT_EVENT_TYPES,
  MATCH_SIGNALS,
} from '../physics/RocketSimConstants.js';
import {
  REPLAY_PLAYBACK_SPEEDS,
  DEFAULT_GOAL_REPLAY_TICKS,
  DEFAULT_GOAL_LOOKBACK_SECONDS,
  DEFAULT_GOAL_POST_SECONDS,
  resolveGoalReplayWindowBounds,
  extractGoalReplayFrames,
} from './ReplayPlaybackState.js';
import {
  applyReplayFrameToEngine,
  decodeReplayDirectorTelemetryFromState,
} from './ReplayFrameInterpolator.js';
import {
  computeGoalReplayCameraPose,
  buildSuffixSafeDirectorTrajectory,
  resolveGoalExplosionFrameIndex,
} from './ReplayDirectorCamera.js';
import {
  REPLAY_DIRECTOR_CONFIG,
  getActiveReplayTimelineController,
  setActiveReplayTimelineController,
  notifyActiveReplayTimelineController,
  registerReplayDirectorDiagnosticExporter,
  markReplayTimelineControllerRetained,
} from '../ui-core/config/replayDirectorConfig.js';
import {
  buildCurrentFrameDiagnosticSnapshot,
  buildDirectorDiagnosticPatternPayload,
  buildDirectorDiagnosticPatternCsv,
  buildDirectorFrameWindowDiagnostic,
  exportReplayDirectorDiagnosticPattern,
  exportReplayDirectorReferenceKeyframe,
  parseDirectorDiagnosticInput,
} from './ReplayDirectorDiagnostics.js';

registerReplayDirectorDiagnosticExporter(
  exportReplayDirectorDiagnosticPattern,
  parseDirectorDiagnosticInput,
  buildDirectorFrameWindowDiagnostic,
  exportReplayDirectorReferenceKeyframe
);

export class ReplayTimelineController {
  /**
   * @param {object} [options={}]
   * @param {import('../physics/RocketSimPhysicsEngine.js').RocketSimPhysicsEngine|null} [options.engine]
   * @param {import('./ReplayRingBuffer.js').ReplayRingBuffer|null} [options.ringBuffer]
   */
  constructor(options = {}) {
    this.engine = options.engine || null;
    this.ringBuffer = options.ringBuffer || null;

    this.activeFrames = [];
    this.cursorFloat = 0;
    this.isPaused = false;
    this.isPersistent = false;
    this.playbackSpeed = 1.0;
    this.isScrubbing = false;
    this.scoringTeam = 0;
    this.scorerCarIndex = 0;
    this.carTeamResolver = null;
    this.isActive = false;
    this.isNetworkStreamed = false;
    this.expectedDurationTicks = DEFAULT_GOAL_REPLAY_TICKS;
    this._streamedFramesReceived = 0;
    this.hasRetainedReplay = false;
    this.retainedReplaySeq = 0;
    this.isImportedPreview = false;
    this.importedFileName = null;
    this.importedSummary = null;
    this.importedAnomalyPeaks = null;
    this.importedCarEntries = null;
    this._cachedSuffixCameraPlan = null;
    this._cachedSmoothnessSummary = null;
    this._cachedAnomalyPeaks = null;
    this.useRecordedCsvCamera = false;
    this.isLoopingPreview = false;

    this._lastDispatchedFrameIndex = -1;
    this.directorCameraState = {
      initialized: false,
      eyeX: 0,
      eyeY: 0,
      eyeZ: 0,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      lateralBias: 1.0,
      activeTouchCarIndex: 0,
      nextTouchCarIndex: -1,
      nextTouchBlend: 0,
      nextTouchBallPos: null,
      interceptorCarIndex: -1,
      interceptorBlend: 0,
      plannedPose: null,
      suffixCameraPlan: null,
      touchEvents: [],
      lastScoringTouchFrameIdx: -1,
      goalLineFrameIdx: -1,
      useRecordedCsvPose: false,
      recordedPose: null,
      isPaused: false,
      isScrubbing: false,
    };

    this._SmoothedEye = null;
    this._SmoothedTarget = null;
  }

  attach(engine, ringBuffer = null) {
    this.engine = engine || this.engine;
    if (ringBuffer) this.ringBuffer = ringBuffer;
    return this;
  }

  getTotalRecordedFrames() {
    if (this.ActiveWindowCount > 0) {
      return this.ActiveWindowCount;
    }
    const wasmCount = this.engine?.getReplayFrameCount?.() ?? 0;
    if (wasmCount > 0) return wasmCount;
    return this.ringBuffer?.size ?? 0;
  }

  get frames() {
    return this.activeFrames;
  }

  get ActiveWindowCount() {
    return Array.isArray(this.activeFrames) ? this.activeFrames.length : 0;
  }

  get currentFrameIndex() {
    const total = this.getTotalRecordedFrames();
    if (total <= 0) return 0;
    return Math.max(0, Math.min(total - 1, Math.floor(this.cursorFloat)));
  }

  get progress() {
    const total = this.getTotalRecordedFrames();
    if (total <= 1) return 0;
    return Math.max(0, Math.min(1, this.cursorFloat / (total - 1)));
  }

  _analyzeReplayTouchTimeline(options = {}) {
    const frames = this.activeFrames;
    const total = Array.isArray(frames) ? frames.length : 0;
    const scoringTeam = this.scoringTeam ?? 0;
    const goalSignY = scoringTeam === 0 ? 1.0 : -1.0;
    const carTeamResolver =
      typeof options.carTeamResolver === 'function' ? options.carTeamResolver : (c) => c % 2;
    const fallbackScorer =
      typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0
        ? options.scorerCarIndex
        : 0;

    const touchEvents = [];
    const reboundEvents = [];
    let goalLineFrameIdx = -1;
    let sumPreGoalBallX = 0;
    let countPreGoalBallX = 0;
    let trajectorySideScore = 0;

    const pushTouchCandidate = (idx, tick, carIndex, team, ballX, ballY, ballZ) => {
      const prevTouch = touchEvents[touchEvents.length - 1];
      if (!prevTouch || prevTouch.carIndex !== carIndex || idx - prevTouch.frameIndex > 10) {
        touchEvents.push({
          frameIndex: idx,
          tick,
          carIndex,
          team,
          ballX,
          ballY,
          ballZ,
        });
      }
    };

    const pushReboundCandidate = (idx, tick, ballX, ballY, ballZ, normX = 0, normY = 0) => {
      const prevRebound = reboundEvents[reboundEvents.length - 1];
      if (!prevRebound || idx - prevRebound.frameIndex > 14) {
        reboundEvents.push({
          frameIndex: idx,
          tick,
          ballX,
          ballY,
          ballZ,
          normX,
          normY,
        });
      }
    };

    for (let idx = 0; idx < total; idx++) {
      const entry = frames[idx];
      if (!entry) continue;
      const snap = entry.snapshot;
      if (snap && snap.length > 6) {
        const ballX = snap[4] || 0;
        const ballY = snap[5] || 0;
        const bvx = snap.length > 17 ? (snap[16] || 0) : 0;
        const bvy = snap.length > 17 ? (snap[17] || 0) : 0;

        // If a previous candidate crossed 5100 (e.g. goalpost graze) and bounced back into the field (< 5020),
        // unlatch goalLineFrameIdx so the true scoring entry later in the window is captured.
        if (goalLineFrameIdx >= 0 && ballY * goalSignY < 5020) {
          goalLineFrameIdx = -1;
        }
        if (goalLineFrameIdx < 0) {
          const recencyWeight = 0.5 + 0.5 * (idx / Math.max(1, total - 1));
          sumPreGoalBallX += ballX * recencyWeight;
          countPreGoalBallX += recencyWeight;
          // Cross-product / lateral trajectory flow toward scoring goal
          const forwardWeight = Math.max(0.15, (bvy * goalSignY) / 1200.0);
          trajectorySideScore += (-ballX * 0.65 - bvx * 0.22) * forwardWeight * recencyWeight;
          if (ballY * goalSignY >= 5100) {
            goalLineFrameIdx = idx;
          }
        }
      }

      let recordedIncidentTouch = false;
      let recordedIncidentRebound = false;
      const evList = Array.isArray(entry.incidents) && entry.incidents.length > 0
        ? entry.incidents
        : (Array.isArray(entry.events) ? entry.events : []);
      if (evList.length > 0) {
        for (let j = 0; j < evList.length; j++) {
          const inc = evList[j];
          if (!inc) continue;
          if (
            inc.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT ||
            inc.type === PHYSICS_EVENT_TYPES.CAR_BALL_HIT ||
            inc.type === 0x01
          ) {
            const numCars = Math.min(
              MAX_CARS,
              Math.max(1, Math.round(snap?.[SIM_OFFSETS.NUM_CARS] || 1))
            );
            const rawCarIndex = inc.carIndex ?? inc.primaryId ?? -1;
            const carIndex = rawCarIndex >= 0 && rawCarIndex < numCars ? rawCarIndex : 0;
            if (rawCarIndex >= 0) {
              const team = carTeamResolver(carIndex);
              const ballX = snap && snap.length > 6 ? snap[4] : 0;
              const ballY = snap && snap.length > 6 ? snap[5] : 0;
              const ballZ = snap && snap.length > 6 ? snap[6] : 93;
              pushTouchCandidate(idx, entry.tick ?? idx, carIndex, team, ballX, ballY, ballZ);
              recordedIncidentTouch = true;
            }
          } else if (
            inc.type === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT ||
            inc.type === INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT ||
            inc.type === 0x04 ||
            inc.type === 0x05
          ) {
            const ballX = snap && snap.length > 6 ? snap[4] : (inc.posX ?? inc.x ?? 0);
            const ballY = snap && snap.length > 6 ? snap[5] : (inc.posY ?? inc.y ?? 0);
            const ballZ = snap && snap.length > 6 ? snap[6] : (inc.posZ ?? inc.z ?? 93);
            const nz = inc.normZ ?? inc.nz ?? 0;
            if (Math.abs(nz) < 0.75 && (goalLineFrameIdx < 0 || idx <= goalLineFrameIdx)) {
              pushReboundCandidate(
                idx,
                entry.tick ?? idx,
                ballX,
                ballY,
                ballZ,
                inc.normX ?? inc.nx ?? 0,
                inc.normY ?? inc.ny ?? 0
              );
              recordedIncidentRebound = true;
            }
          }
        }
      }

      // Kinematic fallback: detect car-ball hits & wall/backboard/post rebounds when ball velocity undergoes a sudden impulse
      if (
        idx > 1 &&
        (goalLineFrameIdx < 0 || idx <= goalLineFrameIdx + 4) &&
        snap &&
        snap.length >= 22
      ) {
        const prevSnap = frames[idx - 1]?.snapshot;
        if (prevSnap && prevSnap.length >= 22) {
          const dvx = (snap[16] || 0) - (prevSnap[16] || 0);
          const dvy = (snap[17] || 0) - (prevSnap[17] || 0);
          const dvz = (snap[18] || 0) - (prevSnap[18] || 0);
          const impulse = Math.hypot(dvx, dvy, dvz + 5.4);
          if (impulse > 180.0) {
            const ballX = snap[4] || 0;
            const ballY = snap[5] || 0;
            const ballZ = snap[6] || 93;
            const numCars = Math.min(MAX_CARS, Math.max(0, Math.round(snap[SIM_OFFSETS.NUM_CARS] || 0)));
            let bestCar = -1;
            let bestDist = 265.0;
            for (let c = 0; c < numCars; c++) {
              const cBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
              if (snap.length < cBase + 3) continue;
              const dist = Math.hypot(
                (snap[cBase] || 0) - ballX,
                (snap[cBase + 1] || 0) - ballY,
                (snap[cBase + 2] || 0) - ballZ
              );
              if (dist < bestDist) {
                bestDist = dist;
                bestCar = c;
              }
            }
            if (bestCar >= 0 && !recordedIncidentTouch) {
              const team = carTeamResolver(bestCar);
              pushTouchCandidate(idx, entry.tick ?? idx, bestCar, team, ballX, ballY, ballZ);
            } else if (
              bestCar < 0 &&
              !recordedIncidentRebound &&
              Math.hypot(dvx, dvy) > 240.0 &&
              (Math.abs(ballX) > 3820 || Math.abs(ballY) > 4820 || Math.abs(ballX) + Math.abs(ballY) > 7480)
            ) {
              const horizNorm = Math.hypot(dvx, dvy) || 1.0;
              pushReboundCandidate(idx, entry.tick ?? idx, ballX, ballY, ballZ, dvx / horizNorm, dvy / horizNorm);
            }
          }
        }
      }
    }

    // Do NOT force a fallback goalLineFrameIdx while live network streaming is still receiving pre-goal frames!
    if (goalLineFrameIdx < 0 && total > 0 && !this.isNetworkStreamed) {
      goalLineFrameIdx = Math.max(0, total - 360);
    }

    let lastScoringTouchFrameIdx = -1;
    let resolvedScorerCarIndex = fallbackScorer;
    const maxTouchSearchFrame = goalLineFrameIdx >= 0 ? goalLineFrameIdx + 12 : total;
    for (let i = touchEvents.length - 1; i >= 0; i--) {
      const t = touchEvents[i];
      if (
        t.frameIndex <= maxTouchSearchFrame &&
        (this.watchAllTouches || t.team === scoringTeam)
      ) {
        lastScoringTouchFrameIdx = t.frameIndex;
        resolvedScorerCarIndex = t.carIndex;
        break;
      }
    }
    if (lastScoringTouchFrameIdx < 0 && touchEvents.length > 0) {
      const lastT = touchEvents[touchEvents.length - 1];
      lastScoringTouchFrameIdx = lastT.frameIndex;
      resolvedScorerCarIndex = lastT.carIndex;
    }

    // Factor rebounds (wall/backboard/post bounces) into the camera side selection so the camera stands on the
    // inside of the rebound angle (watching the ball bounce off the wall/backboard toward the striker/goal).
    let reboundSideScore = 0;
    for (let i = 0; i < reboundEvents.length; i++) {
      const rb = reboundEvents[i];
      if (goalLineFrameIdx >= 0 && rb.frameIndex > goalLineFrameIdx) continue;
      // Place camera on the interior side opposite the wall/post where the rebound occurs
      reboundSideScore += (-rb.ballX * 0.9 + rb.normX * 450.0);
    }

    const meanBallX = countPreGoalBallX > 0 ? sumPreGoalBallX / countPreGoalBallX : 0;
    const combinedInteriorMetric =
      -meanBallX * 0.55 +
      (countPreGoalBallX > 0 ? trajectorySideScore / countPreGoalBallX : 0) * 0.30 +
      (reboundEvents.length > 0 ? reboundSideScore / reboundEvents.length : 0) * 0.45;
    const interiorSign = combinedInteriorMetric >= 0 ? 1.0 : -1.0;
    const resolvedLateralBias = (-goalSignY * interiorSign) >= 0 ? 1.0 : -1.0;

    const scoringTouches = touchEvents.filter((t) => t.team === scoringTeam);
    const candidateTouches = scoringTouches.length > 0 ? scoringTouches : touchEvents;
    const openingCarIndex =
      candidateTouches.length > 0 ? candidateTouches[0].carIndex : resolvedScorerCarIndex;

    let initialSettledCarPos = null;
    const maxCheckIdx = Math.min(total - 1, 3);
    for (let idx = 1; idx <= maxCheckIdx; idx++) {
      const prevSnap = frames[idx - 1]?.snapshot;
      const currSnap = frames[idx]?.snapshot;
      if (!prevSnap || !currSnap) continue;
      const numCars = Math.min(
        Math.round(prevSnap[SIM_OFFSETS.NUM_CARS] || 0),
        Math.round(currSnap[SIM_OFFSETS.NUM_CARS] || 0),
        MAX_CARS
      );
      if (openingCarIndex >= 0 && openingCarIndex < numCars) {
        const base = SIM_OFFSETS.CARS + openingCarIndex * CAR_STATE_STRIDE;
        const stepDist = Math.hypot(
          currSnap[base + 0] - prevSnap[base + 0],
          currSnap[base + 1] - prevSnap[base + 1],
          currSnap[base + 2] - prevSnap[base + 2]
        );
        if (stepDist > 180.0) {
          initialSettledCarPos = {
            carIndex: openingCarIndex,
            x: currSnap[base + 0],
            y: currSnap[base + 1],
            z: currSnap[base + 2],
          };
        }
      }
    }

    this.reboundEvents = reboundEvents;
    this.goalLineFrameIdx = goalLineFrameIdx;
    this.lateralBias = resolvedLateralBias;
    this.directorCameraState.touchEvents = touchEvents;
    this.directorCameraState.reboundEvents = reboundEvents;
    this.directorCameraState.lastScoringTouchFrameIdx = lastScoringTouchFrameIdx;
    this.directorCameraState.goalLineFrameIdx = goalLineFrameIdx;
    this.directorCameraState.scorerCarIndex = resolvedScorerCarIndex;
    this.directorCameraState.activeTouchCarIndex = openingCarIndex;
    this.directorCameraState.nextTouchCarIndex = -1;
    this.directorCameraState.nextTouchBlend = 0;
    this.directorCameraState.nextTouchBallPos = null;
    this.directorCameraState.interceptorCarIndex = -1;
    this.directorCameraState.interceptorBlend = 0;
    this.directorCameraState.plannedPose = null;
    this.directorCameraState.lateralBias = resolvedLateralBias;
    this.directorCameraState.hasResolvedInitialLateralBias = true;
    this.directorCameraState.postGoalElapsedSec = 0;
    this.directorCameraState.initialSettledCarPos = initialSettledCarPos;
    this._cachedSuffixCameraPlan = null;
  }

  /**
   * Builds and caches the full-window Suffix Safe-Zone Backward-Planned Camera Trajectory
   * whenever the full replay window (`activeFrames`) is available locally.
   */
  ensureSuffixCameraPlan() {
    if (this.isNetworkStreamed && this._streamedFramesReceived < (this.expectedDurationTicks || 9999)) {
      this._cachedSuffixCameraPlan = null;
      this.directorCameraState.suffixCameraPlan = null;
      return null;
    }
    const frames = this.activeFrames;
    if (!Array.isArray(frames) || frames.length === 0) {
      this._cachedSuffixCameraPlan = null;
      this.directorCameraState.suffixCameraPlan = null;
      return null;
    }
    if (
      this._cachedSuffixCameraPlan &&
      Array.isArray(this._cachedSuffixCameraPlan.poses) &&
      this._cachedSuffixCameraPlan.poses.length === frames.length
    ) {
      this.directorCameraState.suffixCameraPlan = this._cachedSuffixCameraPlan;
      return this._cachedSuffixCameraPlan;
    }
    const plan = buildSuffixSafeDirectorTrajectory(frames, {
      scoringTeam: this.scoringTeam ?? 0,
      scorerCarIndex: this.directorCameraState?.scorerCarIndex ?? this.scorerCarIndex ?? 0,
      goalLineFrameIdx: this.directorCameraState?.goalLineFrameIdx ?? -1,
      touchEvents: this.directorCameraState?.touchEvents || [],
      carTeamResolver: this.carTeamResolver,
      lateralBias: this.directorCameraState?.lateralBias,
      initialSettledCarPos: this.directorCameraState?.initialSettledCarPos,
    });
    this._cachedSuffixCameraPlan = plan;
    if (this.directorCameraState) {
      this.directorCameraState.suffixCameraPlan = plan;
      if (plan && typeof plan.lateralBias === 'number') {
        this.directorCameraState.lateralBias = plan.lateralBias;
      }
    }
    return plan;
  }

  /**
   * Resolves Contact-Driven Subject Anchors (Mandatory Next Scoring Player + Opponent Interceptor)
   * and Suffix Safe-Zone planned pose at `frameIdx`.
   */
  resolveTouchLookaheadForFrame(frameIdx, fallbackScorerCarIndex = 0) {
    const plan = this.ensureSuffixCameraPlan();
    if (plan && Array.isArray(plan.poses) && plan.poses.length > 0) {
      const idx = Math.max(0, Math.min(plan.poses.length - 1, Math.floor(frameIdx)));
      const p = plan.poses[idx];
      return {
        primaryCarIndex: p.activeTouchCarIndex,
        nextCarIndex: p.nextTouchCarIndex,
        nextTouchBlend: p.nextTouchBlend,
        nextTouchBallPos: p.nextTouchBallPos,
        interceptorCarIndex: p.interceptorCarIndex ?? -1,
        interceptorBlend: p.interceptorBlend ?? 0,
        plannedPose: p,
        postGoalElapsedSec: p.postGoalElapsedSec ?? 0,
      };
    }

    const state = this.directorCameraState;
    const goalLineFrameIdx = state?.goalLineFrameIdx ?? -1;
    const postGoalElapsedSec =
      goalLineFrameIdx >= 0 && frameIdx > goalLineFrameIdx
        ? (frameIdx - goalLineFrameIdx) / REPLAY_TICK_RATE
        : 0;
    const resolvedScorerCarIndex =
      typeof state?.scorerCarIndex === 'number' && state.scorerCarIndex >= 0
        ? state.scorerCarIndex
        : fallbackScorerCarIndex;

    const touches = state?.touchEvents;
    const rebounds = state?.reboundEvents || [];
    if ((!Array.isArray(touches) || touches.length === 0) && rebounds.length === 0) {
      return {
        primaryCarIndex: resolvedScorerCarIndex,
        nextCarIndex: -1,
        nextTouchBlend: 0,
        nextTouchBallPos: null,
        interceptorCarIndex: -1,
        interceptorBlend: 0,
        plannedPose: null,
        postGoalElapsedSec,
      };
    }

    const scoringTeam = this.scoringTeam ?? 0;
    const holdTicks = Math.round((REPLAY_DIRECTOR_CONFIG.touchHoldAfterSeconds ?? 0.2) * REPLAY_TICK_RATE);
    const lookaheadTicks = Math.max(
      60,
      Math.round((REPLAY_DIRECTOR_CONFIG.twoTouchLookaheadSeconds ?? 2.2) * REPLAY_TICK_RATE)
    );
    const releaseTicks = Math.max(48, holdTicks + 36);
    const anticipationWeight = REPLAY_DIRECTOR_CONFIG.twoTouchAnticipationWeight ?? 0.36;

    const safeTouches = Array.isArray(touches) ? touches : [];
    const scoringTouches = this.watchAllTouches
      ? safeTouches
      : safeTouches.filter((t) => t.team === scoringTeam);
    const candidateTouches = scoringTouches.length > 0 ? scoringTouches : safeTouches;

    let primaryIdx = -1;
    for (let i = 0; i < candidateTouches.length; i++) {
      if (frameIdx <= candidateTouches[i].frameIndex + holdTicks) {
        primaryIdx = i;
        break;
      }
    }

    const lastTouch = candidateTouches[candidateTouches.length - 1];
    const primaryTouch = primaryIdx >= 0 ? candidateTouches[primaryIdx] : lastTouch;
    const primaryCarIndex =
      postGoalElapsedSec > 0
        ? resolvedScorerCarIndex
        : primaryTouch
          ? primaryTouch.carIndex
          : resolvedScorerCarIndex;

    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let bestW = 0;
    let nextCarIndex = -1;

    for (let i = 0; i < candidateTouches.length; i++) {
      const t = candidateTouches[i];
      if (i === 0 && t.frameIndex <= 18) continue;

      const dt = t.frameIndex - frameIdx;
      if (dt > lookaheadTicks || dt < -releaseTicks) continue;

      let w = 0;
      if (dt >= 0) {
        const u = 1.0 - dt / lookaheadTicks;
        const s = 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, u)) * Math.PI);
        w = s * s;
      } else {
        const u = 1.0 - (-dt) / releaseTicks;
        const s = 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, u)) * Math.PI);
        w = s * s;
      }

      if (w > 1e-5) {
        sumW += w;
        sumX += w * t.ballX;
        sumY += w * t.ballY;
        sumZ += w * t.ballZ;
        if (w > bestW) {
          bestW = w;
          nextCarIndex = t.carIndex;
        }
      }
    }

    const oppTouches = safeTouches.filter((t) => t.team !== scoringTeam && t.frameIndex > 12);
    const interceptorPreTicks = Math.round(
      (REPLAY_DIRECTOR_CONFIG.interceptorLookaheadSeconds ?? 1.65) * REPLAY_TICK_RATE
    );
    const interceptorPostTicks = Math.round(0.75 * REPLAY_TICK_RATE);
    let bestOppW = 0;
    let interceptorCarIndex = -1;
    for (let i = 0; i < oppTouches.length; i++) {
      const ot = oppTouches[i];
      const dt = ot.frameIndex - frameIdx;
      let w = 0;
      if (dt >= 0 && dt <= interceptorPreTicks) {
        const u = 1.0 - dt / interceptorPreTicks;
        w = 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, u)) * Math.PI);
      } else if (dt < 0 && -dt <= interceptorPostTicks) {
        const u = 1.0 - (-dt) / interceptorPostTicks;
        w = 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, u)) * Math.PI);
      }
      w *= REPLAY_DIRECTOR_CONFIG.interceptorFramingWeight ?? 0.72;
      if (w > bestOppW) {
        bestOppW = w;
        interceptorCarIndex = ot.carIndex;
      }
    }

    if (sumW <= 1e-4) {
      return {
        primaryCarIndex,
        nextCarIndex: -1,
        nextTouchBlend: 0,
        nextTouchBallPos: null,
        interceptorCarIndex,
        interceptorBlend: bestOppW,
        plannedPose: null,
        postGoalElapsedSec,
      };
    }

    const effectiveW = sumW / (1.0 + 0.35 * sumW);
    const postGoalFade = postGoalElapsedSec > 0 ? Math.max(0, 1.0 - postGoalElapsedSec / 0.25) : 1.0;
    const nextTouchBlend = anticipationWeight * effectiveW * postGoalFade;

    return {
      primaryCarIndex,
      nextCarIndex,
      nextTouchBlend,
      nextTouchBallPos: {
        x: sumX / sumW,
        y: sumY / sumW,
        z: sumZ / sumW,
      },
      interceptorCarIndex,
      interceptorBlend: bestOppW,
      plannedPose: null,
      postGoalElapsedSec,
    };
  }

  resolveFocusCarForFrame(frameIdx, fallbackScorerCarIndex = 0) {
    return this.resolveTouchLookaheadForFrame(frameIdx, fallbackScorerCarIndex).primaryCarIndex;
  }

  /**
   * Computes automatic RL-style dramatic slow-motion factor:
   * - Final scoring touch: [-0.50s (-60 ticks) .. +0.25s (+30 ticks)] held at 50% (0.50x)
   * - Goal-line crossing:  [-0.25s (-30 ticks) .. +0.25s (+30 ticks)] held at 50% (0.50x)
   */
  computeDramaticSlowMoFactor(cursorFloat, options = {}) {
    const ignoreScrubState = Boolean(options?.ignoreScrubState);
    if (
      this.disableSlowMo ||
      (!ignoreScrubState && (Math.abs(this.playbackSpeed - 1.0) > 0.01 || this.isScrubbing))
    ) {
      return 1.0;
    }
    const state = this.directorCameraState;
    const rampTicks = 12;
    let factor = 1.0;

    const evalPlateauWindow = (dist, preTicks, postTicks, minScale) => {
      if (dist < -(preTicks + rampTicks) || dist > postTicks + rampTicks) {
        return 1.0;
      }
      if (dist >= -preTicks && dist <= postTicks) {
        return minScale;
      }
      const outside = dist < -preTicks ? (-preTicks - dist) : (dist - postTicks);
      const t = Math.max(0, Math.min(1, outside / rampTicks));
      const ease = 0.5 - 0.5 * Math.cos(t * Math.PI);
      return minScale + (1.0 - minScale) * ease;
    };

    const touchIdx = state?.lastScoringTouchFrameIdx ?? -1;
    if (touchIdx >= 0) {
      const preTouchTicks = Math.max(1, Math.round((REPLAY_DIRECTOR_CONFIG.lastTouchSlowMoPreSeconds ?? 0.50) * REPLAY_TICK_RATE));
      const postTouchTicks = Math.max(1, Math.round((REPLAY_DIRECTOR_CONFIG.lastTouchSlowMoPostSeconds ?? 0.25) * REPLAY_TICK_RATE));
      const minTouchScale = REPLAY_DIRECTOR_CONFIG.lastTouchSlowMoScale ?? 0.50;
      factor = Math.min(
        factor,
        evalPlateauWindow(cursorFloat - touchIdx, preTouchTicks, postTouchTicks, minTouchScale)
      );
    }

    const goalIdx = state?.goalLineFrameIdx ?? -1;
    if (goalIdx > 0) {
      const preGoalTicks = Math.max(1, Math.round((REPLAY_DIRECTOR_CONFIG.goalLineSlowMoPreSeconds ?? 0.25) * REPLAY_TICK_RATE));
      const postGoalTicks = Math.max(1, Math.round((REPLAY_DIRECTOR_CONFIG.goalLineSlowMoPostSeconds ?? 0.25) * REPLAY_TICK_RATE));
      const minGoalScale = REPLAY_DIRECTOR_CONFIG.goalLineSlowMoScale ?? 0.50;
      factor = Math.min(
        factor,
        evalPlateauWindow(cursorFloat - goalIdx, preGoalTicks, postGoalTicks, minGoalScale)
      );
    }

    return Math.max(0.25, Math.min(1.0, factor));
  }

  beginReplaySession(options = {}) {
    const durationTicks = options.durationTicks ?? DEFAULT_GOAL_REPLAY_TICKS;
    this.expectedDurationTicks = Math.max(1, Math.floor(durationTicks));
    this.isNetworkStreamed = Boolean(options.isNetworkStreamed);
    this._streamedFramesReceived = 0;
    this.scoringTeam = options.scoringTeam ?? 0;
    this.scorerCarIndex =
      typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0
        ? options.scorerCarIndex
        : 0;
    this.carTeamResolver =
      typeof options.carTeamResolver === 'function' ? options.carTeamResolver : null;
    this.disableSlowMo = Boolean(options.disableSlowMo);
    this.watchAllTouches = Boolean(options.watchAllTouches);
    this.isImportedPreview = Boolean(options.isImportedPreview);
    this.importedFileName = options.importedFileName || null;
    this.importedSummary = options.importedSummary || null;
    this.useRecordedCsvCamera = Boolean(options.useRecordedCsvCamera);
    this.isLoopingPreview = Boolean(options.isLoopingPreview);
    this.activeFrames =
      Array.isArray(options.frames) && options.frames.length > 0
        ? options.frames
        : extractGoalReplayFrames({
            ringBuffer: this.ringBuffer,
            engine: this.engine,
            durationTicks,
          });
    this.hasRetainedReplay = this.activeFrames.length > 0;
    this.cursorFloat = 0;
    this.isPaused = false;
    this.isPersistent = Boolean(options.isPersistent);
    this.isScrubbing = false;
    this.playbackSpeed = 1.0;
    this.isActive = true;
    this._lastDispatchedFrameIndex = -1;
    this.directorCameraState.initialized = false;
    this.directorCameraState.useRecordedCsvPose = this.isImportedPreview && this.useRecordedCsvCamera;
    this.directorCameraState.recordedPose = null;
    this.directorCameraState.isPaused = false;
    this.directorCameraState.isScrubbing = false;
    this._analyzeReplayTouchTimeline(options);
    if (Array.isArray(options.touchEvents) && options.touchEvents.length > 0) {
      this.directorCameraState.touchEvents = options.touchEvents.map((t) => ({ ...t }));
    }
    if (typeof options.goalLineFrameIdx === 'number' && options.goalLineFrameIdx >= 0) {
      this.directorCameraState.goalLineFrameIdx = options.goalLineFrameIdx;
    }
    if (typeof options.lateralBias === 'number' && options.lateralBias !== 0) {
      this.directorCameraState.lateralBias = options.lateralBias;
      this.directorCameraState.hasResolvedInitialLateralBias = true;
    }
    if (Array.isArray(options.carEntries) && options.carEntries.length > 0) {
      this.carEntries = options.carEntries.map((c) => ({ ...c }));
    }
    this._SmoothedEye = null;
    this._SmoothedTarget = null;
    this._cachedSuffixCameraPlan = null;
    this._cachedSmoothnessSummary = null;
    this._cachedAnomalyPeaks = null;
    if (!this.isNetworkStreamed && this.activeFrames.length > 0) {
      this.ensureSuffixCameraPlan();
      buildDirectorDiagnosticPatternPayload(this);
    }
    if (this.hasRetainedReplay) {
      markReplayTimelineControllerRetained(this);
    }
    setActiveReplayTimelineController(this);
    return this.activeFrames.length;
  }

  /**
   * Retains a goal replay window in this controller's buffer without entering active playback mode
   * (used when Goal Replay is disabled or when exiting a match during post-goal celebration).
   */
  retainReplaySessionFrames(options = {}) {
    const frames = Array.isArray(options.frames) ? options.frames : [];
    if (frames.length === 0) return 0;
    this.activeFrames = frames;
    this.expectedDurationTicks = frames.length;
    this.scoringTeam = options.scoringTeam ?? 0;
    this.scorerCarIndex =
      typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0
        ? options.scorerCarIndex
        : 0;
    this.carTeamResolver =
      typeof options.carTeamResolver === 'function' ? options.carTeamResolver : null;
    if (Array.isArray(options.carEntries) && options.carEntries.length > 0) {
      this.carEntries = options.carEntries.map((c) => ({ ...c }));
    }
    this.hasRetainedReplay = true;
    this.isImportedPreview = false;
    this.importedFileName = null;
    this.importedSummary = null;
    this.importedAnomalyPeaks = null;
    this.useRecordedCsvCamera = false;
    this.isNetworkStreamed = false;
    this.cursorFloat = 0;
    this._lastDispatchedFrameIndex = -1;
    this.directorCameraState.initialized = false;
    this.directorCameraState.useRecordedCsvPose = false;
    this.directorCameraState.recordedPose = null;
    this._analyzeReplayTouchTimeline(options);
    this._cachedSuffixCameraPlan = null;
    this._cachedSmoothnessSummary = null;
    this._cachedAnomalyPeaks = null;
    this.ensureSuffixCameraPlan();
    buildDirectorDiagnosticPatternPayload(this);
    markReplayTimelineControllerRetained(this);
    setActiveReplayTimelineController(this);
    return this.activeFrames.length;
  }

  /**
   * Copies the retained replay window, car roster, and computed Director Camera state from another controller.
   */
  copyRetainedReplayFrom(sourceCtrl) {
    if (
      !sourceCtrl ||
      sourceCtrl === this ||
      !Array.isArray(sourceCtrl.activeFrames) ||
      sourceCtrl.activeFrames.length === 0
    ) {
      return 0;
    }
    this.activeFrames = sourceCtrl.activeFrames.slice();
    this.expectedDurationTicks = sourceCtrl.activeFrames.length;
    this.scoringTeam = sourceCtrl.scoringTeam ?? 0;
    this.scorerCarIndex = sourceCtrl.scorerCarIndex ?? 0;
    this.carTeamResolver = sourceCtrl.carTeamResolver || null;
    this.hasRetainedReplay = true;
    this.retainedReplaySeq = sourceCtrl.retainedReplaySeq || this.retainedReplaySeq;
    this.isImportedPreview = Boolean(sourceCtrl.isImportedPreview);
    this.importedFileName = sourceCtrl.importedFileName || null;
    this.importedSummary = sourceCtrl.importedSummary || null;
    this.importedAnomalyPeaks = sourceCtrl.importedAnomalyPeaks || null;
    this.importedCarEntries = Array.isArray(sourceCtrl.importedCarEntries)
      ? sourceCtrl.importedCarEntries.map((c) => ({ ...c }))
      : Array.isArray(sourceCtrl.carEntries)
        ? sourceCtrl.carEntries.map((c) => ({ ...c }))
        : null;
    this.carEntries = Array.isArray(sourceCtrl.carEntries)
      ? sourceCtrl.carEntries.map((c) => ({ ...c }))
      : this.importedCarEntries;
    this.useRecordedCsvCamera = Boolean(sourceCtrl.useRecordedCsvCamera);
    this.cursorFloat = Math.max(
      0,
      Math.min(this.activeFrames.length - 1, Math.floor(sourceCtrl.cursorFloat ?? 0))
    );
    if (sourceCtrl.directorCameraState) {
      this.directorCameraState = {
        ...this.directorCameraState,
        ...sourceCtrl.directorCameraState,
        touchEvents: Array.isArray(sourceCtrl.directorCameraState.touchEvents)
          ? sourceCtrl.directorCameraState.touchEvents.map((t) => ({ ...t }))
          : [],
      };
    }
    this._cachedSuffixCameraPlan = sourceCtrl._cachedSuffixCameraPlan || null;
    this._cachedSmoothnessSummary = sourceCtrl._cachedSmoothnessSummary || null;
    this._cachedAnomalyPeaks = sourceCtrl._cachedAnomalyPeaks || null;
    return this.activeFrames.length;
  }

  /**
   * Loads a parsed `.rcgr.gz`, `.rcreplay.gz`, CSV, or JSON Director Diagnostic Pattern into the controller
   * so it can be inspected, scrubbed, tuned, or previewed in the 3D Arena.
   */
  loadImportedDiagnosticPattern(parsedPattern, options = {}) {
    if (!parsedPattern || !Array.isArray(parsedPattern.activeFrames) || parsedPattern.activeFrames.length === 0) {
      return 0;
    }
    this.activeFrames = parsedPattern.activeFrames;
    this.expectedDurationTicks = parsedPattern.activeFrames.length;
    this.scoringTeam = parsedPattern.scoringTeam ?? 0;
    this.scorerCarIndex = parsedPattern.scorerCarIndex ?? 0;
    this.hasRetainedReplay = true;
    this.isImportedPreview = true;
    this.importedFileName = parsedPattern.fileName || options.fileName || 'imported.rcgr.gz';
    this.importedCarEntries = Array.isArray(parsedPattern.carEntries) ? parsedPattern.carEntries : null;
    if (Array.isArray(this.importedCarEntries) && this.importedCarEntries.length > 0) {
      const teamMap = new Map();
      for (const c of this.importedCarEntries) {
        if (typeof c.carIndex === 'number' && typeof c.team === 'number') {
          teamMap.set(c.carIndex, c.team);
        }
      }
      if (teamMap.size > 0) {
        this.carTeamResolver = (cIdx) => (teamMap.has(cIdx) ? teamMap.get(cIdx) : cIdx % 2);
      }
    }
    this._cachedSuffixCameraPlan = null;
    this._cachedSmoothnessSummary = null;
    this._cachedAnomalyPeaks = null;
    const hasRecordedRows = Boolean(
      parsedPattern.hasRecordedCsvRows ||
        parsedPattern.activeFrames.some((f) => Boolean(f?.recordedCsvRow))
    );
    this.useRecordedCsvCamera =
      typeof options.useRecordedCsvCamera === 'boolean'
        ? options.useRecordedCsvCamera && hasRecordedRows
        : false;
    this.isNetworkStreamed = false;
    this._streamedFramesReceived = 0;

    this._analyzeReplayTouchTimeline({
      scorerCarIndex: this.scorerCarIndex,
      carTeamResolver: this.carTeamResolver,
    });
    if (Array.isArray(parsedPattern.touchEvents) && parsedPattern.touchEvents.length > 0) {
      this.directorCameraState.touchEvents = parsedPattern.touchEvents.map((t) => ({ ...t }));
    }
    if (typeof parsedPattern.lastScoringTouchFrameIdx === 'number' && parsedPattern.lastScoringTouchFrameIdx >= 0) {
      this.directorCameraState.lastScoringTouchFrameIdx = parsedPattern.lastScoringTouchFrameIdx;
    }
    if (typeof parsedPattern.goalLineFrameIdx === 'number' && parsedPattern.goalLineFrameIdx >= 0) {
      const resolvedGoalIdx = resolveGoalExplosionFrameIndex(
        this.activeFrames,
        (this.scoringTeam ?? 0) === 0 ? 1.0 : -1.0,
        parsedPattern.goalLineFrameIdx
      );
      this.goalLineFrameIdx = resolvedGoalIdx;
      this.directorCameraState.goalLineFrameIdx = resolvedGoalIdx;
    }
    if (parsedPattern.initialSettledCarPos && typeof parsedPattern.initialSettledCarPos === 'object') {
      this.directorCameraState.initialSettledCarPos = { ...parsedPattern.initialSettledCarPos };
    }
    if (typeof parsedPattern.lateralBias === 'number' && parsedPattern.lateralBias !== 0) {
      this.directorCameraState.lateralBias = parsedPattern.lateralBias;
      this.directorCameraState.hasResolvedInitialLateralBias = true;
    }

    if (!this.useRecordedCsvCamera || !parsedPattern.summary || !parsedPattern.anomalyPeaks) {
      this.ensureSuffixCameraPlan();
      buildDirectorDiagnosticPatternPayload(this);
    }
    this.importedSummary = this.useRecordedCsvCamera
      ? (parsedPattern.summary || this._cachedSmoothnessSummary)
      : (this._cachedSmoothnessSummary || parsedPattern.summary);
    this.importedAnomalyPeaks = this.useRecordedCsvCamera
      ? (parsedPattern.anomalyPeaks || this._cachedAnomalyPeaks)
      : (this._cachedAnomalyPeaks || parsedPattern.anomalyPeaks);

    const startIdx = Math.max(
      0,
      Math.min(this.activeFrames.length - 1, parsedPattern.selectedCursorIndex ?? 0)
    );
    this.cursorFloat = options.startFromBeginning ? 0 : startIdx;
    this._lastDispatchedFrameIndex = -1;
    this.refreshCurrentFrameDirectorPose();
    markReplayTimelineControllerRetained(this);
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
    return this.activeFrames.length;
  }

  /**
   * Starts or resumes interactive 3D Arena preview of the currently loaded replay or imported CSV pattern.
   */
  startPreviewSession(options = {}) {
    if (!Array.isArray(this.activeFrames) || this.activeFrames.length === 0) {
      return false;
    }
    this.isActive = true;
    this.isPersistent = true;
    this.isLoopingPreview = options.loop !== false;
    this.isPaused = Boolean(options.startPaused);
    this.isScrubbing = false;
    if (options.restart || this.cursorFloat >= this.activeFrames.length - 1) {
      this.cursorFloat = 0;
    }
    this._lastDispatchedFrameIndex = -1;
    this.directorCameraState.initialized = false;
    this.directorCameraState.isPaused = this.isPaused;
    this.directorCameraState.isScrubbing = false;
    this.refreshCurrentFrameDirectorPose();
    const buf = this.getFrameBufferByIndex(this.currentFrameIndex);
    if (buf && this.engine) {
      applyReplayFrameToEngine(this.engine, buf);
    }
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
    return true;
  }

  /**
   * Deterministically recomputes `directorCameraState` at `currentFrameIndex` when the user
   * scrubs, pauses, or adjusts `REPLAY_DIRECTOR_CONFIG` sliders in the tuner.
   */
  refreshCurrentFrameDirectorPose() {
    const total = this.getTotalRecordedFrames();
    if (total <= 0 || !this.directorCameraState) return null;
    const targetIdx = Math.max(0, Math.min(total - 1, Math.floor(this.cursorFloat)));
    const entry = this.getFrameEntryByIndex(targetIdx);
    const useCsvPose = Boolean(
      this.isImportedPreview && this.useRecordedCsvCamera && entry?.recordedCsvRow
    );
    this.directorCameraState.useRecordedCsvPose = useCsvPose;
    this.directorCameraState.isPaused = this.isPaused;
    this.directorCameraState.isScrubbing = this.isScrubbing;

    if (useCsvPose) {
      const r = entry.recordedCsvRow;
      this.directorCameraState.recordedPose = {
        eyeX: r.cam_eye_x ?? 0,
        eyeY: r.cam_eye_y ?? 0,
        eyeZ: r.cam_eye_z ?? 0,
        targetX: r.cam_target_x ?? 0,
        targetY: r.cam_target_y ?? 0,
        targetZ: r.cam_target_z ?? 0,
      };
      this.directorCameraState.eyeX = this.directorCameraState.recordedPose.eyeX;
      this.directorCameraState.eyeY = this.directorCameraState.recordedPose.eyeY;
      this.directorCameraState.eyeZ = this.directorCameraState.recordedPose.eyeZ;
      this.directorCameraState.targetX = this.directorCameraState.recordedPose.targetX;
      this.directorCameraState.targetY = this.directorCameraState.recordedPose.targetY;
      this.directorCameraState.targetZ = this.directorCameraState.recordedPose.targetZ;
      this.directorCameraState.initialized = true;
      return this.directorCameraState.recordedPose;
    }

    this.directorCameraState.recordedPose = null;
    const suffixPlan = this.ensureSuffixCameraPlan();
    if (suffixPlan && Array.isArray(suffixPlan.poses) && suffixPlan.poses.length > 0) {
      const s = this.getFrameBufferByIndex(targetIdx);
      const nextIdx = Math.min(total - 1, targetIdx + 1);
      const nextS = this.getFrameBufferByIndex(nextIdx) || s;
      const alpha = Math.max(0, Math.min(1, this.cursorFloat - targetIdx));
      this.directorCameraState.currentFrameIndex = this.cursorFloat;
      const p0 = suffixPlan.poses[targetIdx];
      this.directorCameraState.plannedPose = p0;
      return computeGoalReplayCameraPose(nextS || s, this.scoringTeam, {
        prevStateBuffer: s,
        alpha,
        scorerCarIndex: this.scorerCarIndex,
        progress: total > 1 ? this.cursorFloat / (total - 1) : 0,
        frameIndex: this.cursorFloat,
        suffixCameraPlan: suffixPlan,
        directorState: this.directorCameraState,
        dt: 1 / REPLAY_TICK_RATE,
        exactDt: true,
      });
    }

    const warmStart = Math.max(0, targetIdx - 90);
    this.directorCameraState.initialized = false;
    let lastPose = null;
    for (let i = warmStart; i <= targetIdx; i++) {
      const s = this.getFrameBufferByIndex(i);
      if (!s) continue;
      const embedded = decodeReplayDirectorTelemetryFromState(s);
      const la = embedded
        ? {
            primaryCarIndex:
              embedded.activeTouchCarIndex >= 0
                ? embedded.activeTouchCarIndex
                : (this.scorerCarIndex ?? 0),
            nextCarIndex: embedded.nextTouchCarIndex,
            nextTouchBlend: embedded.nextTouchBlend,
            nextTouchBallPos: embedded.nextTouchBallPos,
            interceptorCarIndex: embedded.interceptorCarIndex ?? -1,
            interceptorBlend: embedded.interceptorBlend ?? 0,
            plannedPose: embedded.plannedPose ?? null,
            postGoalElapsedSec: embedded.postGoalElapsedSec ?? 0,
          }
        : this.resolveTouchLookaheadForFrame(
            i,
            this.directorCameraState.activeTouchCarIndex ?? this.scorerCarIndex ?? 0
          );
      this.directorCameraState.activeTouchCarIndex = la.primaryCarIndex;
      this.directorCameraState.nextTouchCarIndex = la.nextCarIndex;
      this.directorCameraState.nextTouchBlend = la.nextTouchBlend;
      this.directorCameraState.nextTouchBallPos = la.nextTouchBallPos;
      this.directorCameraState.interceptorCarIndex = la.interceptorCarIndex ?? -1;
      this.directorCameraState.interceptorBlend = la.interceptorBlend ?? 0;
      this.directorCameraState.plannedPose = la.plannedPose ?? null;
      this.directorCameraState.postGoalElapsedSec = la.postGoalElapsedSec ?? 0;
      lastPose = computeGoalReplayCameraPose(s, this.scoringTeam, {
        scorerCarIndex: this.scorerCarIndex,
        progress: total > 1 ? i / (total - 1) : 0,
        frameIndex: i,
        directorState: this.directorCameraState,
        dt: 1 / REPLAY_TICK_RATE,
        exactDt: true,
      });
    }
    return lastPose;
  }

  appendStreamedReplayFrame(stateSnapshot, serverTick = 0, acknowledgedControls = null) {
    if (!stateSnapshot || stateSnapshot.length < 410) return 0;
    const snap = new Float32Array(stateSnapshot.length);
    snap.set(stateSnapshot);

    if (this._streamedFramesReceived === 0) {
      this.activeFrames = [];
    }
    this._streamedFramesReceived++;

    const tick = Math.floor(snap[SIM_OFFSETS.TICK] || serverTick || this._streamedFramesReceived);
    this.activeFrames.push({
      tick,
      snapshot: snap,
      acknowledgedControls: acknowledgedControls || null,
      incidents: [],
      signals: [],
      audioEvents: [],
    });
    this.hasRetainedReplay = true;

    const prevEyeX = this.directorCameraState.eyeX;
    const prevEyeY = this.directorCameraState.eyeY;
    const prevEyeZ = this.directorCameraState.eyeZ;
    const prevTargetX = this.directorCameraState.targetX;
    const prevTargetY = this.directorCameraState.targetY;
    const prevTargetZ = this.directorCameraState.targetZ;
    const prevInit = this.directorCameraState.initialized;
    const prevSmoothedCarX = this.directorCameraState.smoothedCarX;
    const prevSmoothedCarY = this.directorCameraState.smoothedCarY;
    const prevSmoothedCarZ = this.directorCameraState.smoothedCarZ;
    const prevCarSwitchBlend = this.directorCameraState.carSwitchBlend;
    const prevSmoothedUgX = this.directorCameraState.smoothedUgX;
    const prevSmoothedUgY = this.directorCameraState.smoothedUgY;
    const prevSmoothedLateralBias = this.directorCameraState.smoothedLateralBias;

    this._analyzeReplayTouchTimeline({
      carTeamResolver: this.carTeamResolver,
      scorerCarIndex: this.scorerCarIndex,
    });

    this.directorCameraState.initialized = prevInit;
    this.directorCameraState.eyeX = prevEyeX;
    this.directorCameraState.eyeY = prevEyeY;
    this.directorCameraState.eyeZ = prevEyeZ;
    this.directorCameraState.targetX = prevTargetX;
    this.directorCameraState.targetY = prevTargetY;
    this.directorCameraState.targetZ = prevTargetZ;
    if (typeof prevSmoothedCarX === 'number') {
      this.directorCameraState.smoothedCarX = prevSmoothedCarX;
      this.directorCameraState.smoothedCarY = prevSmoothedCarY;
      this.directorCameraState.smoothedCarZ = prevSmoothedCarZ;
      this.directorCameraState.carSwitchBlend = prevCarSwitchBlend;
    }
    if (typeof prevSmoothedUgX === 'number') {
      this.directorCameraState.smoothedUgX = prevSmoothedUgX;
      this.directorCameraState.smoothedUgY = prevSmoothedUgY;
    }
    if (typeof prevSmoothedLateralBias === 'number') {
      this.directorCameraState.smoothedLateralBias = prevSmoothedLateralBias;
    }

    const embedded = decodeReplayDirectorTelemetryFromState(snap);
    if (embedded) {
      if (typeof embedded.lateralBias === 'number' && embedded.lateralBias !== 0) {
        this.directorCameraState.lateralBias = embedded.lateralBias;
        this.directorCameraState.hasResolvedInitialLateralBias = true;
      }
      if (typeof embedded.scorerCarIndex === 'number' && embedded.scorerCarIndex >= 0) {
        this.directorCameraState.scorerCarIndex = embedded.scorerCarIndex;
        this.scorerCarIndex = embedded.scorerCarIndex;
      }
      if (!this.isPaused && !this.isScrubbing) {
        this.directorCameraState.activeTouchCarIndex = embedded.activeTouchCarIndex;
        this.directorCameraState.nextTouchCarIndex = embedded.nextTouchCarIndex;
        this.directorCameraState.nextTouchBlend = embedded.nextTouchBlend;
        this.directorCameraState.nextTouchBallPos = embedded.nextTouchBallPos;
        this.directorCameraState.postGoalElapsedSec = embedded.postGoalElapsedSec ?? 0;
      }
    }

    if ((this.directorCameraState.postGoalElapsedSec ?? 0) <= 0) {
      this.directorCameraState.goalAnchorEyeY = undefined;
    }

    if (!this.isPaused && !this.isScrubbing) {
      this.cursorFloat = Math.max(0, this.activeFrames.length - 1);
    }
    markReplayTimelineControllerRetained(this);
    setActiveReplayTimelineController(this);
    return this.activeFrames.length;
  }

  endReplaySession() {
    this.isActive = false;
    this.isPaused = false;
    this.isPersistent = false;
    this.isScrubbing = false;
    this.isLoopingPreview = false;
    this.disableSlowMo = false;
    this.isNetworkStreamed = false;
    this.hasRetainedReplay = Array.isArray(this.activeFrames) && this.activeFrames.length > 0;
    if (this.hasRetainedReplay) {
      this.cursorFloat = Math.max(0, Math.min(this.activeFrames.length - 1, Math.floor(this.cursorFloat)));
      markReplayTimelineControllerRetained(this);
    } else {
      this.cursorFloat = 0;
    }
    this._lastDispatchedFrameIndex = -1;
    this.directorCameraState.initialized = false;
    this.directorCameraState.isPaused = false;
    this.directorCameraState.isScrubbing = false;
    this._SmoothedEye = null;
    this._SmoothedTarget = null;
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
  }

  clearRetainedReplay() {
    this.activeFrames = [];
    this.hasRetainedReplay = false;
    this.retainedReplaySeq = 0;
    this.isImportedPreview = false;
    this.importedFileName = null;
    this.importedSummary = null;
    this._cachedSuffixCameraPlan = null;
    this.useRecordedCsvCamera = false;
    this.isLoopingPreview = false;
    this._streamedFramesReceived = 0;
    this.cursorFloat = 0;
    this.directorCameraState.initialized = false;
    this.directorCameraState.useRecordedCsvPose = false;
    this.directorCameraState.recordedPose = null;
    this.directorCameraState.suffixCameraPlan = null;
    this.directorCameraState.plannedPose = null;
    this.directorCameraState.touchEvents = [];
    if (getActiveReplayTimelineController() === this) {
      notifyActiveReplayTimelineController();
    }
  }

  getFrameEntryByIndex(index) {
    if (this.ActiveWindowCount > 0) {
      const clamped = Math.max(0, Math.min(this.ActiveWindowCount - 1, Math.floor(index)));
      return this.activeFrames[clamped] || null;
    }
    if (this.ringBuffer && this.ringBuffer.size > 0) {
      const clamped = Math.max(0, Math.min(this.ringBuffer.size - 1, Math.floor(index)));
      return this.ringBuffer.getFrameAt(clamped) || null;
    }
    return null;
  }

  getFrameBufferByIndex(index) {
    if (this.ActiveWindowCount > 0) {
      const clamped = Math.max(0, Math.min(this.ActiveWindowCount - 1, Math.floor(index)));
      return this.activeFrames[clamped]?.snapshot || null;
    }
    if (this.engine && typeof this.engine.getReplayFrameByIndex === 'function') {
      const wasmCount = this.engine.getReplayFrameCount?.() ?? 0;
      if (wasmCount > 0) {
        const clamped = Math.max(0, Math.min(wasmCount - 1, Math.floor(index)));
        return this.engine.getReplayFrameByIndex(clamped);
      }
    }
    if (this.ringBuffer && this.ringBuffer.size > 0) {
      const clamped = Math.max(0, Math.min(this.ringBuffer.size - 1, Math.floor(index)));
      return this.ringBuffer.getFrameAt(clamped)?.snapshot || null;
    }
    return null;
  }

  getFrameBufferByOffset(ticksAgo = 0) {
    const safeOffset = Math.max(0, Math.floor(ticksAgo));
    if (this.ActiveWindowCount > 0) {
      const idx = Math.max(0, this.ActiveWindowCount - 1 - safeOffset);
      return this.activeFrames[idx]?.snapshot || null;
    }
    if (this.engine && typeof this.engine.getReplayFrameByOffset === 'function') {
      const wasmFrame = this.engine.getReplayFrameByOffset(safeOffset);
      if (wasmFrame) return wasmFrame;
    }
    if (this.ringBuffer && this.ringBuffer.size > 0) {
      return this.ringBuffer.getFrameByOffset(safeOffset)?.snapshot || null;
    }
    return null;
  }

  seekToIndex(frameIndex, interpolator = null) {
    const total = this.getTotalRecordedFrames();
    if (total <= 0) return null;
    const clamped = Math.max(0, Math.min(total - 1, Number(frameIndex) || 0));
    this.cursorFloat = clamped;
    if (this.isActive) {
      this.isScrubbing = true;
      this.isPersistent = true;
    }
    const targetIdx = Math.floor(clamped);
    this._lastDispatchedFrameIndex = targetIdx;

    this.refreshCurrentFrameDirectorPose();

    const buf = this.getFrameBufferByIndex(targetIdx);
    if (this.isActive && buf && this.engine) {
      applyReplayFrameToEngine(this.engine, buf, interpolator);
    }
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
    return buf;
  }

  seekByOffset(ticksAgo = 0, interpolator = null) {
    const total = this.getTotalRecordedFrames();
    if (total <= 0) return null;
    const targetIdx = Math.max(0, Math.min(total - 1, total - 1 - Math.max(0, Math.floor(ticksAgo))));
    return this.seekToIndex(targetIdx, interpolator);
  }

  seekToNormalized(progress01, interpolator = null) {
    const total = this.getTotalRecordedFrames();
    if (total <= 0) return null;
    const p = Math.max(0, Math.min(1, Number(progress01) || 0));
    return this.seekToIndex(p * (total - 1), interpolator);
  }

  setPaused(paused) {
    this.isPaused = Boolean(paused);
    if (this.isPaused) {
      this.isPersistent = true;
    } else {
      this.isScrubbing = false;
    }
    if (this.directorCameraState) {
      this.directorCameraState.isPaused = this.isPaused;
      this.directorCameraState.isScrubbing = this.isScrubbing;
    }
    setActiveReplayTimelineController(this);
    notifyActiveReplayTimelineController();
    return this.isPaused;
  }

  togglePause() {
    if (!this.isPersistent) {
      this.isPersistent = true;
      return this.setPaused(true);
    }
    const total = this.getTotalRecordedFrames();
    if (this.isPaused && total > 1 && this.cursorFloat >= total - 1.05) {
      this.cursorFloat = 0;
      this._lastDispatchedFrameIndex = -1;
      this.directorCameraState.initialized = false;
    }
    return this.setPaused(!this.isPaused);
  }

  setPlaybackSpeed(speed) {
    const num = Number(speed);
    if (Number.isFinite(num) && num > 0) {
      this.playbackSpeed = Math.max(0.1, Math.min(4.0, num));
    }
    notifyActiveReplayTimelineController();
    return this.playbackSpeed;
  }

  cyclePlaybackSpeed() {
    const idx = REPLAY_PLAYBACK_SPEEDS.findIndex((s) => Math.abs(s - this.playbackSpeed) < 0.01);
    const nextIdx = (idx + 1) % REPLAY_PLAYBACK_SPEEDS.length;
    this.playbackSpeed = REPLAY_PLAYBACK_SPEEDS[nextIdx];
    notifyActiveReplayTimelineController();
    return this.playbackSpeed;
  }

  stepPlayback(dtSeconds, interpolator = null, applyToEngine = false) {
    const total = this.getTotalRecordedFrames();
    if (total <= 0) {
      return {
        frame: null,
        frameIndex: 0,
        totalFrames: 0,
        progress: 0,
        isFinished: true,
        incidents: [],
        audioEvents: [],
      };
    }

    setActiveReplayTimelineController(this);
    if (!this.isPaused && this.isScrubbing) {
      this.isScrubbing = false;
    }
    this.directorCameraState.isPaused = this.isPaused;
    this.directorCameraState.isScrubbing = this.isScrubbing;

    const isFollowingLiveStream =
      this.isNetworkStreamed &&
      this._streamedFramesReceived > 0 &&
      !this.isPaused &&
      !this.isScrubbing &&
      Math.abs(this.playbackSpeed - 1.0) <= 0.01;

    const currentEntry = this.getFrameEntryByIndex(Math.floor(this.cursorFloat));
    const useCsvPose = Boolean(
      this.isImportedPreview && this.useRecordedCsvCamera && currentEntry?.recordedCsvRow
    );
    this.directorCameraState.useRecordedCsvPose = useCsvPose;

    const slowMoFactor = useCsvPose
      ? Math.max(0.25, Math.min(1.0, currentEntry.recordedCsvRow.slow_mo_factor ?? 1.0))
      : this.computeDramaticSlowMoFactor(this.cursorFloat);

    if (isFollowingLiveStream) {
      this.cursorFloat = Math.max(0, total - 1);
    } else if (!this.isPaused) {
      const advanceTicks = Math.max(0, dtSeconds * REPLAY_TICK_RATE * this.playbackSpeed * slowMoFactor);
      this.cursorFloat = Math.min(total - 1, this.cursorFloat + advanceTicks);
    }

    const baseIdx = Math.max(0, Math.min(total - 1, Math.floor(this.cursorFloat)));
    const nextIdx = Math.min(total - 1, baseIdx + 1);
    const alpha = Math.max(0, Math.min(1, this.cursorFloat - baseIdx));
    this.directorCameraState.currentFrameIndex = this.cursorFloat;

    const prevEntry = this.getFrameEntryByIndex(baseIdx);
    const nextEntry = this.getFrameEntryByIndex(nextIdx) || prevEntry;
    const prevFrame = this.getFrameBufferByIndex(baseIdx);
    const currFrame = this.getFrameBufferByIndex(nextIdx) || prevFrame;
    const suffixPlan = !useCsvPose ? this.ensureSuffixCameraPlan() : null;
    const embedded = !suffixPlan && currFrame ? decodeReplayDirectorTelemetryFromState(currFrame) : null;

    if (useCsvPose && prevEntry?.recordedCsvRow) {
      const r0 = prevEntry.recordedCsvRow;
      const r1 = nextEntry?.recordedCsvRow || r0;
      const lerp = (a, b) => a + (b - a) * alpha;
      this.directorCameraState.recordedPose = {
        eyeX: lerp(r0.cam_eye_x ?? 0, r1.cam_eye_x ?? 0),
        eyeY: lerp(r0.cam_eye_y ?? 0, r1.cam_eye_y ?? 0),
        eyeZ: lerp(r0.cam_eye_z ?? 0, r1.cam_eye_z ?? 0),
        targetX: lerp(r0.cam_target_x ?? 0, r1.cam_target_x ?? 0),
        targetY: lerp(r0.cam_target_y ?? 0, r1.cam_target_y ?? 0),
        targetZ: lerp(r0.cam_target_z ?? 0, r1.cam_target_z ?? 0),
      };
    } else {
      this.directorCameraState.recordedPose = null;
    }

    if (!useCsvPose && suffixPlan && Array.isArray(suffixPlan.poses) && suffixPlan.poses.length > 0) {
      const p0 = suffixPlan.poses[baseIdx];
      const p1 = suffixPlan.poses[nextIdx] || p0;
      const lerp = (a, b) => a + (b - a) * alpha;
      this.directorCameraState.activeTouchCarIndex = p0.activeTouchCarIndex;
      this.directorCameraState.nextTouchCarIndex = p0.nextTouchCarIndex;
      this.directorCameraState.nextTouchBlend = lerp(p0.nextTouchBlend, p1.nextTouchBlend);
      this.directorCameraState.nextTouchBallPos = p0.nextTouchBallPos;
      this.directorCameraState.interceptorCarIndex = p0.interceptorCarIndex ?? -1;
      this.directorCameraState.interceptorBlend = lerp(
        p0.interceptorBlend ?? 0,
        p1.interceptorBlend ?? 0
      );
      this.directorCameraState.postGoalElapsedSec = lerp(
        p0.postGoalElapsedSec ?? 0,
        p1.postGoalElapsedSec ?? 0
      );
      this.directorCameraState.lateralBias = p0.lateralBias;
      this.directorCameraState.plannedPose = {
        eyeX: lerp(p0.eyeX, p1.eyeX),
        eyeY: lerp(p0.eyeY, p1.eyeY),
        eyeZ: lerp(p0.eyeZ, p1.eyeZ),
        targetX: lerp(p0.targetX, p1.targetX),
        targetY: lerp(p0.targetY, p1.targetY),
        targetZ: lerp(p0.targetZ, p1.targetZ),
        rawEyeX: lerp(p0.rawEyeX, p1.rawEyeX),
        rawEyeY: lerp(p0.rawEyeY, p1.rawEyeY),
        rawEyeZ: lerp(p0.rawEyeZ, p1.rawEyeZ),
        rawTargetX: lerp(p0.rawTargetX, p1.rawTargetX),
        rawTargetY: lerp(p0.rawTargetY, p1.rawTargetY),
        rawTargetZ: lerp(p0.rawTargetZ, p1.rawTargetZ),
      };
    } else if (!useCsvPose && embedded) {
      this.directorCameraState.activeTouchCarIndex =
        embedded.activeTouchCarIndex >= 0
          ? embedded.activeTouchCarIndex
          : (this.scorerCarIndex ?? 0);
      this.directorCameraState.nextTouchCarIndex = embedded.nextTouchCarIndex;
      this.directorCameraState.nextTouchBlend = embedded.nextTouchBlend;
      this.directorCameraState.nextTouchBallPos = embedded.nextTouchBallPos;
      this.directorCameraState.interceptorCarIndex = embedded.interceptorCarIndex ?? -1;
      this.directorCameraState.interceptorBlend = embedded.interceptorBlend ?? 0;
      this.directorCameraState.plannedPose = embedded.plannedPose ?? null;
      this.directorCameraState.postGoalElapsedSec = embedded.postGoalElapsedSec ?? 0;
      if (typeof embedded.lateralBias === 'number' && embedded.lateralBias !== 0) {
        this.directorCameraState.lateralBias = embedded.lateralBias;
        this.directorCameraState.hasResolvedInitialLateralBias = true;
      }
      if (typeof embedded.scorerCarIndex === 'number' && embedded.scorerCarIndex >= 0) {
        this.directorCameraState.scorerCarIndex = embedded.scorerCarIndex;
        this.scorerCarIndex = embedded.scorerCarIndex;
      }
    } else {
      const lookahead = this.resolveTouchLookaheadForFrame(
        baseIdx,
        this.directorCameraState.activeTouchCarIndex ?? 0
      );
      this.directorCameraState.activeTouchCarIndex = lookahead.primaryCarIndex;
      this.directorCameraState.nextTouchCarIndex = lookahead.nextCarIndex;
      this.directorCameraState.nextTouchBlend = lookahead.nextTouchBlend;
      this.directorCameraState.nextTouchBallPos = lookahead.nextTouchBallPos;
      this.directorCameraState.interceptorCarIndex = lookahead.interceptorCarIndex ?? -1;
      this.directorCameraState.interceptorBlend = lookahead.interceptorBlend ?? 0;
      this.directorCameraState.plannedPose = lookahead.plannedPose ?? null;
      this.directorCameraState.postGoalElapsedSec = lookahead.postGoalElapsedSec ?? 0;
    }

    if (
      (applyToEngine || this.isScrubbing || this.isPaused || this.playbackSpeed !== 1.0) &&
      currFrame &&
      this.engine
    ) {
      applyReplayFrameToEngine(this.engine, currFrame, interpolator, prevFrame, alpha);
      const currEntry = this.getFrameEntryByIndex(baseIdx);
      const controls = currEntry?.acknowledgedControls || currFrame?.controls;
      const setControlsFn =
        typeof this.engine.setControls === 'function'
          ? this.engine.setControls.bind(this.engine)
          : typeof this.engine.setCarControls === 'function'
            ? this.engine.setCarControls.bind(this.engine)
            : null;
      if (Array.isArray(controls) && setControlsFn) {
        for (let c = 0; c < controls.length; c++) {
          if (controls[c]) {
            setControlsFn(c, controls[c]);
          }
        }
      }
    }

    const incidents = [];
    const audioEvents = [];
    const signals = [];
    if (!this.isPaused && baseIdx > this._lastDispatchedFrameIndex) {
      const startIdx = Math.max(0, this._lastDispatchedFrameIndex + 1, baseIdx - 10);
      for (let idx = startIdx; idx <= baseIdx; idx++) {
        const entry = this.getFrameEntryByIndex(idx);
        if (!entry) continue;
        if (Array.isArray(entry.incidents) && entry.incidents.length > 0) {
          for (let j = 0; j < entry.incidents.length; j++) {
            incidents.push(entry.incidents[j]);
          }
        }
        if (Array.isArray(entry.audioEvents) && entry.audioEvents.length > 0) {
          for (let j = 0; j < entry.audioEvents.length; j++) {
            audioEvents.push(entry.audioEvents[j]);
          }
        }
        if (Array.isArray(entry.signals) && entry.signals.length > 0) {
          for (let j = 0; j < entry.signals.length; j++) {
            signals.push(entry.signals[j]);
          }
        }
      }
      this._lastDispatchedFrameIndex = baseIdx;
    }

    let isFinished = this.cursorFloat >= total - 1;
    if (isFinished && this.isLoopingPreview && !this.isPaused && !this.isScrubbing && total > 1) {
      this.cursorFloat = 0;
      this._lastDispatchedFrameIndex = -1;
      this.directorCameraState.initialized = false;
      isFinished = false;
    } else if (isFinished && this.isPersistent && !this.isPaused) {
      this.isPaused = true;
      this.directorCameraState.isPaused = true;
    }

    const effectiveProgress =
      embedded && typeof embedded.progress === 'number' && embedded.progress > 0
        ? embedded.progress
        : isFollowingLiveStream && this.expectedDurationTicks > 1
          ? Math.min(1, this.cursorFloat / Math.max(1, this.expectedDurationTicks - 1))
          : total > 1
            ? this.cursorFloat / (total - 1)
            : 1;

    return {
      frame: currFrame,
      prevFrame,
      currFrame,
      alpha,
      frameIndex: baseIdx,
      totalFrames: total,
      progress: effectiveProgress,
      slowMoFactor,
      activeTouchCarIndex: this.directorCameraState.activeTouchCarIndex,
      isFinished,
      incidents,
      signals,
      audioEvents,
    };
  }

  getCurrentFrameDiagnosticSnapshot() {
    return buildCurrentFrameDiagnosticSnapshot(this);
  }

  buildDirectorDiagnosticPatternPayload(options = {}) {
    return buildDirectorDiagnosticPatternPayload(this, options);
  }

  buildDirectorDiagnosticPatternCsv(options = {}) {
    return buildDirectorDiagnosticPatternCsv(this, options);
  }

  buildDirectorFrameWindowDiagnostic(windowRadius = 15) {
    return buildDirectorFrameWindowDiagnostic(this, windowRadius);
  }
}


export default ReplayTimelineController;
