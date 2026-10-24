/**
 * ReplayTimelineController.js
 * Unified 256MB WASM Native Replay Buffer & JS RingBuffer Timeline Scrubber and Goal Replay Controller.
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
import { gameAudioEngine } from '../audio/GameAudioEngineFacade.js';
import { eventStreamStore } from '../stores/eventStreamStore';
import { hudStore } from '../stores/hudStore';
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
  computeGoalReplayCameraPose,
  clampPositionInsideArena,
  applyDirectorReplayCamera,
  REPLAY_DIRECTOR_CONFIG,
  DEFAULT_REPLAY_DIRECTOR_CONFIG,
  updateReplayDirectorConfig,
  resetReplayDirectorConfig,
  subscribeReplayDirectorConfig,
} from './ReplayFrameInterpolator.js';
import {
  buildCurrentFrameDiagnosticSnapshot,
  buildDirectorDiagnosticPatternPayload,
  buildDirectorDiagnosticPatternCsv,
  exportReplayDirectorDiagnosticPattern,
} from './ReplayDirectorDiagnostics.js';

export {
  REPLAY_PLAYBACK_SPEEDS,
  DEFAULT_GOAL_REPLAY_TICKS,
  DEFAULT_GOAL_LOOKBACK_SECONDS,
  DEFAULT_GOAL_POST_SECONDS,
  resolveGoalReplayWindowBounds,
  extractGoalReplayFrames,
  applyReplayFrameToEngine,
  computeGoalReplayCameraPose,
  clampPositionInsideArena,
  applyDirectorReplayCamera,
  REPLAY_DIRECTOR_CONFIG,
  DEFAULT_REPLAY_DIRECTOR_CONFIG,
  updateReplayDirectorConfig,
  resetReplayDirectorConfig,
  subscribeReplayDirectorConfig,
};

let _activeReplayController = null;
const _replaySessionListeners = new Set();

function notifyReplaySessionListeners() {
  for (const fn of _replaySessionListeners) {
    try {
      fn(_activeReplayController);
    } catch (err) {
      console.warn('[ReplayTimelineController] Replay session listener failed:', err);
    }
  }
}

export function getActiveReplayTimelineController() {
  return _activeReplayController;
}

export function subscribeActiveReplayTimelineController(listener) {
  if (typeof listener !== 'function') return () => {};
  _replaySessionListeners.add(listener);
  return () => _replaySessionListeners.delete(listener);
}

/**
 * Dispatches recorded physics incidents (Track B), authoritative signals (Track C),
 * and audio cues from a ReplayTimelineController or 3-Timeline Viewer step result.
 */
export function dispatchReplayFrameEvents(stepRes, runtime = null) {
  if (!stepRes) return;
  const camera = runtime?.camera || null;
  let sawGoalIncident = false;

  // 1. Track B: Physics Incidents -> Audio Engine + Event Stream Store + Visual FX
  if (Array.isArray(stepRes.incidents) && stepRes.incidents.length > 0) {
    for (let i = 0; i < stepRes.incidents.length; i++) {
      const evt = stepRes.incidents[i];
      if (!evt) continue;
      if (
        evt.type === PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED ||
        evt.type === INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED
      ) {
        const targetCarIdx = typeof evt.carIndex === 'number' && evt.carIndex >= 0 ? evt.carIndex : 0;
        runtime?.getFlipResetVisual?.(targetCarIdx)?.play?.();
      }
      if (evt.type === INCIDENT_EVENT_TYPES.GOAL_SCORED) {
        sawGoalIncident = true;
      }
      try {
        eventStreamStore?.addEvent?.(evt);
      } catch (err) {
        console.warn('[ReplayTimelineController] Failed to push replay incident to eventStreamStore:', err);
      }
      gameAudioEngine?.handleEvent?.(evt, camera);
    }
  }

  // 2. Track C: Signals + Audio Cues (deduplicated per step)
  const playedCueKeys = new Set();
  const isCountUp = Boolean(stepRes.isCountUp);

  if (Array.isArray(stepRes.audioEvents) && stepRes.audioEvents.length > 0) {
    for (let i = 0; i < stepRes.audioEvents.length; i++) {
      const cue = stepRes.audioEvents[i];
      const cueKey = cue?.cueId || cue?.cueName;
      if (cueKey && !playedCueKeys.has(cueKey)) {
        playedCueKeys.add(cueKey);
        gameAudioEngine?.play?.(cueKey, cue?.volume ?? 1.0);
      }
    }
  }

  if (Array.isArray(stepRes.signals) && stepRes.signals.length > 0) {
    for (let i = 0; i < stepRes.signals.length; i++) {
      const sig = stepRes.signals[i];
      if (!sig) continue;
      const cue = resolveReplayAudioCueForSignal(sig, isCountUp);
      const cueKey = cue?.cueId || cue?.cueName;
      if (cueKey && !playedCueKeys.has(cueKey)) {
        playedCueKeys.add(cueKey);
        gameAudioEngine?.play?.(cueKey, cue?.volume ?? 1.0);
      }

      if (stepRes.syncHudFromSignals) {
        if (sig.signalType === MATCH_SIGNALS.SCORE_UPDATED) {
          hudStore.getState().setMatchState({
            blueScore: sig.param1 ?? 0,
            orangeScore: sig.param2 ?? 0,
          });
        } else if (
          sig.signalType === MATCH_SIGNALS.CLOCK_UPDATED_SECONDS ||
          sig.signalType === MATCH_SIGNALS.COUNTDOWN_10S ||
          sig.signalType === MATCH_SIGNALS.TIME_ALERT_60S ||
          sig.signalType === MATCH_SIGNALS.TIME_ALERT_30S
        ) {
          hudStore.getState().setMatchState({
            remainingSeconds: sig.param1 ?? 0,
            isOvertime: sig.signalType === MATCH_SIGNALS.CLOCK_UPDATED_SECONDS && sig.param2 === 1,
          });
        }
      }
    }
  }

  if (sawGoalIncident && !playedCueKeys.has('sfx_goal_poof')) {
    playedCueKeys.add('sfx_goal_poof');
    gameAudioEngine?.play?.('sfx_goal_poof', 1.0);
  }
}

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
      touchEvents: [],
      lastScoringTouchFrameIdx: -1,
      goalLineFrameIdx: -1,
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
    const carTeamResolver =
      typeof options.carTeamResolver === 'function' ? options.carTeamResolver : (c) => c % 2;
    const fallbackScorer =
      typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0
        ? options.scorerCarIndex
        : 0;

    const touchEvents = [];
    let goalLineFrameIdx = -1;
    let sumPreGoalBallX = 0;
    let countPreGoalBallX = 0;

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

    for (let idx = 0; idx < total; idx++) {
      const entry = frames[idx];
      if (!entry) continue;
      const snap = entry.snapshot;
      if (snap && snap.length > 6) {
        const ballX = snap[4] || 0;
        const ballY = snap[5] || 0;
        if (goalLineFrameIdx < 0) {
          sumPreGoalBallX += ballX;
          countPreGoalBallX++;
          if (Math.abs(ballY) >= 5100) {
            goalLineFrameIdx = idx;
          }
        }
      }

      let recordedIncidentTouch = false;
      if (Array.isArray(entry.incidents) && entry.incidents.length > 0) {
        for (let j = 0; j < entry.incidents.length; j++) {
          const inc = entry.incidents[j];
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
          }
        }
      }

      // Kinematic fallback: detect car-ball hits when ball velocity undergoes a sudden impulse
      // while a car is within contact proximity (< 260 UU) and before goal-line crossing.
      if (
        !recordedIncidentTouch &&
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
          // Subtract expected gravity dvz (~ -650 / 120 = -5.4 UU/tick)
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
            if (bestCar >= 0) {
              const team = carTeamResolver(bestCar);
              pushTouchCandidate(idx, entry.tick ?? idx, bestCar, team, ballX, ballY, ballZ);
            }
          }
        }
      }
    }

    if (goalLineFrameIdx < 0 && total > 0) {
      goalLineFrameIdx = Math.max(0, total - 360);
    }

    let lastScoringTouchFrameIdx = -1;
    let resolvedScorerCarIndex = fallbackScorer;
    for (let i = touchEvents.length - 1; i >= 0; i--) {
      const t = touchEvents[i];
      if (t.frameIndex <= goalLineFrameIdx + 12 && t.team === scoringTeam) {
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

    // Resolve a consistent replay-wide lateralBias from the dominant pre-goal ball side
    const meanBallX = countPreGoalBallX > 0 ? sumPreGoalBallX / countPreGoalBallX : 0;
    const goalSignY = scoringTeam === 0 ? 1.0 : -1.0;
    // Perpendicular vector usX ≈ -ugY ≈ -goalSignY; interior side is opposite sign of meanBallX
    const interiorSign = meanBallX <= 0 ? 1.0 : -1.0;
    const resolvedLateralBias = (-goalSignY * interiorSign) >= 0 ? 1.0 : -1.0;

    const scoringTouches = touchEvents.filter((t) => t.team === scoringTeam);
    const candidateTouches = scoringTouches.length > 0 ? scoringTouches : touchEvents;
    const openingCarIndex =
      candidateTouches.length > 0 ? candidateTouches[0].carIndex : resolvedScorerCarIndex;

    // Detect 1-tick kickoff spawn reset teleports in the first 3 frames so idx=0 starts at the settled spawn position
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

    this.directorCameraState.touchEvents = touchEvents;
    this.directorCameraState.lastScoringTouchFrameIdx = lastScoringTouchFrameIdx;
    this.directorCameraState.goalLineFrameIdx = goalLineFrameIdx;
    this.directorCameraState.scorerCarIndex = resolvedScorerCarIndex;
    this.directorCameraState.activeTouchCarIndex = openingCarIndex;
    this.directorCameraState.nextTouchCarIndex = -1;
    this.directorCameraState.nextTouchBlend = 0;
    this.directorCameraState.nextTouchBallPos = null;
    this.directorCameraState.lateralBias = resolvedLateralBias;
    this.directorCameraState.hasResolvedInitialLateralBias = true;
    this.directorCameraState.postGoalElapsedSec = 0;
    this.directorCameraState.initialSettledCarPos = initialSettledCarPos;
  }

  /**
   * Resolves a C1-continuous Multi-Touch Lookahead plan at `frameIdx`:
   * Uses smooth raised-cosine bell windows over all upcoming touches so `nextTouchBlend`
   * and `nextTouchBallPos` never step-jump or cliff-drop to zero on a single frame.
   */
  resolveTouchLookaheadForFrame(frameIdx, fallbackScorerCarIndex = 0) {
    const state = this.directorCameraState;
    const goalLineFrameIdx = state?.goalLineFrameIdx ?? -1;
    const postGoalElapsedSec =
      goalLineFrameIdx > 0 && frameIdx > goalLineFrameIdx
        ? (frameIdx - goalLineFrameIdx) / REPLAY_TICK_RATE
        : 0;
    const resolvedScorerCarIndex =
      typeof state?.scorerCarIndex === 'number' && state.scorerCarIndex >= 0
        ? state.scorerCarIndex
        : fallbackScorerCarIndex;

    const touches = state?.touchEvents;
    if (!Array.isArray(touches) || touches.length === 0) {
      return {
        primaryCarIndex: resolvedScorerCarIndex,
        nextCarIndex: -1,
        nextTouchBlend: 0,
        nextTouchBallPos: null,
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

    const scoringTouches = touches.filter((t) => t.team === scoringTeam);
    const candidateTouches = scoringTouches.length > 0 ? scoringTouches : touches;

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
      // Skip touches that are neither future touches nor the initial opening touch (> 18 ticks into replay)
      if (i === 0 && t.frameIndex <= 18) continue;

      const dt = t.frameIndex - frameIdx;
      if (dt > lookaheadTicks || dt < -releaseTicks) continue;

      let w = 0;
      if (dt >= 0) {
        // Smooth raised-cosine rise as the ball approaches touch `t`
        const u = 1.0 - dt / lookaheadTicks;
        const s = 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, u)) * Math.PI);
        w = s * s;
      } else {
        // Smooth raised-cosine decay after touch `t` so lookahead never cliff-drops at t + holdTicks
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

    if (sumW <= 1e-4) {
      return {
        primaryCarIndex,
        nextCarIndex: -1,
        nextTouchBlend: 0,
        nextTouchBallPos: null,
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
    this.scoringTeam = options.scoringTeam ?? 0;
    this.scorerCarIndex =
      typeof options.scorerCarIndex === 'number' && options.scorerCarIndex >= 0
        ? options.scorerCarIndex
        : 0;
    this.carTeamResolver =
      typeof options.carTeamResolver === 'function' ? options.carTeamResolver : null;
    this.disableSlowMo = Boolean(options.disableSlowMo);
    this.activeFrames =
      Array.isArray(options.frames) && options.frames.length > 0
        ? options.frames
        : extractGoalReplayFrames({
            ringBuffer: this.ringBuffer,
            engine: this.engine,
            durationTicks,
          });
    this.cursorFloat = 0;
    this.isPaused = false;
    this.isPersistent = false;
    this.isScrubbing = false;
    this.playbackSpeed = 1.0;
    this.isActive = true;
    this._lastDispatchedFrameIndex = -1;
    this.directorCameraState.initialized = false;
    this._analyzeReplayTouchTimeline(options);
    this._SmoothedEye = null;
    this._SmoothedTarget = null;
    _activeReplayController = this;
    notifyReplaySessionListeners();
    return this.activeFrames.length;
  }

  endReplaySession() {
    this.isActive = false;
    this.isPaused = false;
    this.isPersistent = false;
    this.isScrubbing = false;
    this.disableSlowMo = false;
    this.activeFrames = [];
    this.cursorFloat = 0;
    this._lastDispatchedFrameIndex = -1;
    this.directorCameraState.initialized = false;
    this.directorCameraState.touchEvents = [];
    this._SmoothedEye = null;
    this._SmoothedTarget = null;
    if (_activeReplayController === this) {
      notifyReplaySessionListeners();
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
    this.isScrubbing = true;
    this.isPersistent = true;
    const targetIdx = Math.floor(clamped);
    this._lastDispatchedFrameIndex = targetIdx;

    // Deterministically warm-up Director Camera state up to targetIdx so scrubbing/seeking
    // lands on the exact damped trajectory pose without post-seek drift.
    if (this.directorCameraState) {
      const warmStart = Math.max(0, targetIdx - 90);
      this.directorCameraState.initialized = false;
      for (let i = warmStart; i <= targetIdx; i++) {
        const s = this.getFrameBufferByIndex(i);
        if (!s) continue;
        const la = this.resolveTouchLookaheadForFrame(
          i,
          this.directorCameraState.activeTouchCarIndex ?? this.scorerCarIndex ?? 0
        );
        this.directorCameraState.activeTouchCarIndex = la.primaryCarIndex;
        this.directorCameraState.nextTouchCarIndex = la.nextCarIndex;
        this.directorCameraState.nextTouchBlend = la.nextTouchBlend;
        this.directorCameraState.nextTouchBallPos = la.nextTouchBallPos;
        this.directorCameraState.postGoalElapsedSec = la.postGoalElapsedSec ?? 0;
        computeGoalReplayCameraPose(s, this.scoringTeam, {
          scorerCarIndex: this.scorerCarIndex,
          progress: total > 1 ? i / (total - 1) : 0,
          directorState: this.directorCameraState,
          dt: 1 / REPLAY_TICK_RATE,
          exactDt: true,
        });
      }
    }

    const buf = this.getFrameBufferByIndex(targetIdx);
    if (buf && this.engine) {
      applyReplayFrameToEngine(this.engine, buf, interpolator);
    }
    _activeReplayController = this;
    notifyReplaySessionListeners();
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
    _activeReplayController = this;
    notifyReplaySessionListeners();
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
    notifyReplaySessionListeners();
    return this.playbackSpeed;
  }

  cyclePlaybackSpeed() {
    const idx = REPLAY_PLAYBACK_SPEEDS.findIndex((s) => Math.abs(s - this.playbackSpeed) < 0.01);
    const nextIdx = (idx + 1) % REPLAY_PLAYBACK_SPEEDS.length;
    this.playbackSpeed = REPLAY_PLAYBACK_SPEEDS[nextIdx];
    notifyReplaySessionListeners();
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

    _activeReplayController = this;
    if (!this.isPaused && this.isScrubbing) {
      this.isScrubbing = false;
    }
    const slowMoFactor = this.computeDramaticSlowMoFactor(this.cursorFloat);
    if (!this.isPaused) {
      const advanceTicks = Math.max(0, dtSeconds * REPLAY_TICK_RATE * this.playbackSpeed * slowMoFactor);
      this.cursorFloat = Math.min(total - 1, this.cursorFloat + advanceTicks);
    }

    const baseIdx = Math.max(0, Math.min(total - 1, Math.floor(this.cursorFloat)));
    const nextIdx = Math.min(total - 1, baseIdx + 1);
    const alpha = Math.max(0, Math.min(1, this.cursorFloat - baseIdx));

    const lookahead = this.resolveTouchLookaheadForFrame(
      baseIdx,
      this.directorCameraState.activeTouchCarIndex ?? 0
    );
    this.directorCameraState.activeTouchCarIndex = lookahead.primaryCarIndex;
    this.directorCameraState.nextTouchCarIndex = lookahead.nextCarIndex;
    this.directorCameraState.nextTouchBlend = lookahead.nextTouchBlend;
    this.directorCameraState.nextTouchBallPos = lookahead.nextTouchBallPos;
    this.directorCameraState.postGoalElapsedSec = lookahead.postGoalElapsedSec ?? 0;

    const prevFrame = this.getFrameBufferByIndex(baseIdx);
    const currFrame = this.getFrameBufferByIndex(nextIdx) || prevFrame;

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

    const isFinished = this.cursorFloat >= total - 1;
    if (isFinished && this.isPersistent && !this.isPaused) {
      this.isPaused = true;
    }

    return {
      frame: currFrame,
      prevFrame,
      currFrame,
      alpha,
      frameIndex: baseIdx,
      totalFrames: total,
      progress: total > 1 ? this.cursorFloat / (total - 1) : 1,
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
}

/**
 * Exports the active Goal Replay Director Camera diagnostic pattern (JSON or CSV) via browser download.
 */
export function exportActiveReplayDirectorDiagnosticPattern(format = 'json', options = {}) {
  const ctrl = options.controller || _activeReplayController;
  return exportReplayDirectorDiagnosticPattern(ctrl, format, options);
}

export default ReplayTimelineController;
