/**
 * src/replay/container/RCReplayTimelineParser.js
 * Three-Timeline Replay Parser & Range Cursor Architecture for V2 RC Replays:
 *   - Timeline 1 (Track A): StateInputTimeline (120Hz 448-float State + 64B 8-car Input)
 *   - Timeline 2 (Track B): IncidentTimeline   (64B PhysicsEvent Stream with O(log N) range queries)
 *   - Timeline 3 (Track C): SignalTimeline     (64B Match Signal Stream with O(log N) range queries & HUD state evaluation)
 */

import {
  STATE_BUFFER_FLOATS,
  INCIDENT_EVENT_TYPES,
  MATCH_SIGNALS,
  isBallFlipResetEvent,
} from '../../physics/RocketSimConstants.js';
import { resolveReplayAudioCueForSignal } from '../ReplayRingBuffer.js';

export const INCIDENT_TYPE_LABELS = Object.freeze({
  [INCIDENT_EVENT_TYPES.CAR_BALL_HIT]: 'Car-Ball Hit',
  [INCIDENT_EVENT_TYPES.CAR_CAR_BUMP]: 'Car Bump',
  [INCIDENT_EVENT_TYPES.CAR_CAR_DEMO]: 'Demolition',
  [INCIDENT_EVENT_TYPES.BALL_WORLD_HIT]: 'Ball-World Hit',
  [INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT]: 'Goalpost/Crossbar',
  [INCIDENT_EVENT_TYPES.CAR_JUMP]: 'Jump',
  [INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP]: 'Double Jump',
  [INCIDENT_EVENT_TYPES.CAR_DODGE]: 'Dodge/Flip',
  [INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER]: 'Supersonic',
  [INCIDENT_EVENT_TYPES.BOOST_PICKUP]: 'Boost Pickup',
  [INCIDENT_EVENT_TYPES.BOOST_SPAWN]: 'Boost Spawn',
  [INCIDENT_EVENT_TYPES.CAR_BOOST_START]: 'Boost Start',
  [INCIDENT_EVENT_TYPES.CAR_BOOST_STOP]: 'Boost Stop',
  [INCIDENT_EVENT_TYPES.GOAL_SCORED]: 'Goal Scored',
  [INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED]: 'Flip Reset',
  [INCIDENT_EVENT_TYPES.BALL_STATE_CHANGE]: 'Ball State',
  [INCIDENT_EVENT_TYPES.POSSESSION_CHANGE]: 'Possession',
});

export const SIGNAL_TYPE_LABELS = Object.freeze({
  [MATCH_SIGNALS.MATCH_STARTED]: 'Match Started',
  [MATCH_SIGNALS.KICKOFF_WILL_START]: 'Kickoff Countdown',
  [MATCH_SIGNALS.KICKOFF_START]: 'Kickoff Go',
  [MATCH_SIGNALS.COUNTDOWN_TICK]: 'Countdown Tick',
  [MATCH_SIGNALS.SCORE_UPDATED]: 'Score Updated',
  [MATCH_SIGNALS.GOAL_REPLAY_WILL_START]: 'Goal Replay',
  [MATCH_SIGNALS.GOAL_REPLAY_START]: 'Goal Replay Start',
  [MATCH_SIGNALS.GOAL_REPLAY_WILL_END]: 'Goal Replay Ending',
  [MATCH_SIGNALS.GOAL_REPLAY_END]: 'Goal Replay End',
  [MATCH_SIGNALS.BALL_RESET]: 'Ball Reset',
  [MATCH_SIGNALS.ROUND_STARTED]: 'Round Started',
  [MATCH_SIGNALS.DEMOLITION]: 'Demolition',
  [MATCH_SIGNALS.FORFEIT_VOTE]: 'Forfeit Vote',
  [MATCH_SIGNALS.MATCH_PAUSED]: 'Match Paused',
  [MATCH_SIGNALS.COUNTDOWN_10S]: '10s Countdown',
  [MATCH_SIGNALS.OVERTIME_START]: 'Overtime Start',
  [MATCH_SIGNALS.MATCH_ENDED]: 'Match Ended',
  [MATCH_SIGNALS.PODIUM_START]: 'Podium Start',
  [MATCH_SIGNALS.TIME_ALERT_60S]: '60s Remaining',
  [MATCH_SIGNALS.TIME_ALERT_30S]: '30s Remaining',
  [MATCH_SIGNALS.CLOCK_UPDATED_SECONDS]: 'Clock Tick',
  [MATCH_SIGNALS.MATCH_RESUMED]: 'Match Resumed',
  [MATCH_SIGNALS.MATCH_WILL_RESUME]: 'Resume Countdown',
});

function lowerBoundByFrameIndex(events, targetFrame) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid].frameIndex ?? 0) < targetFrame) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function upperBoundByFrameIndex(events, targetFrame) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid].frameIndex ?? 0) <= targetFrame) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function lowerBoundByTick(events, targetTick) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid].tick ?? 0) < targetTick) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function upperBoundByTick(events, targetTick) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid].tick ?? 0) <= targetTick) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Timeline 1: Fixed-Stride 120Hz State (448 floats) + User Input (8-car controls) Timeline.
 */
export class StateInputTimeline {
  constructor({
    bytes,
    frameCount = 0,
    stride = 1856,
    stateBytes = 1792,
    tickRate = 120,
    frames = [],
    frameSlots = [],
  }) {
    this.bytes = bytes || new Uint8Array(0);
    this.frameCount = frameCount;
    this.stride = stride;
    this.stateBytes = stateBytes;
    this.tickRate = tickRate;
    this.frames = frames;
    this.frameSlots = frameSlots;
    this.startTick = frameCount > 0 ? frameSlots[0]?.tick ?? 0 : 0;
    this.endTick = frameCount > 0 ? frameSlots[frameCount - 1]?.tick ?? 0 : 0;
  }

  get count() {
    return this.frameCount;
  }

  getSnapshotAt(frameIndex) {
    if (this.frameCount <= 0) return null;
    const idx = Math.max(0, Math.min(this.frameCount - 1, Math.floor(frameIndex)));
    return this.frames[idx] || null;
  }

  getControlsAt(frameIndex) {
    if (this.frameCount <= 0) return [];
    const idx = Math.max(0, Math.min(this.frameCount - 1, Math.floor(frameIndex)));
    return this.frameSlots[idx]?.controls || this.frames[idx]?.controls || [];
  }

  getFrameAt(frameIndex) {
    if (this.frameCount <= 0) return null;
    const idx = Math.max(0, Math.min(this.frameCount - 1, Math.floor(frameIndex)));
    return this.frameSlots[idx] || null;
  }

  findFrameIndexByTick(targetTick) {
    if (this.frameCount <= 0) return 0;
    let lo = 0;
    let hi = this.frameCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midTick = this.frameSlots[mid]?.tick ?? mid;
      if (midTick === targetTick) return mid;
      if (midTick < targetTick) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(0, Math.min(this.frameCount - 1, lo));
  }
}

/**
 * Timeline 2: Chronological 64B PhysicsEvent (Incident) Timeline.
 */
export class IncidentTimeline {
  constructor({ bytes, events = [], byFrameMap = new Map(), frameCount = 0 }) {
    this.bytes = bytes || new Uint8Array(0);
    this.events = events
      .slice()
      .sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0) || (a.tick ?? 0) - (b.tick ?? 0));
    this.byFrameMap = byFrameMap;
    this.frameCount = frameCount;
  }

  get count() {
    return this.events.length;
  }

  getEventsAtFrame(frameIndex) {
    return this.byFrameMap.get(Math.floor(frameIndex)) || [];
  }

  getEventsInFrameRange(startFrameInclusive, endFrameInclusive) {
    if (this.events.length === 0) return [];
    const loFrame = Math.min(startFrameInclusive, endFrameInclusive);
    const hiFrame = Math.max(startFrameInclusive, endFrameInclusive);
    const startIdx = lowerBoundByFrameIndex(this.events, loFrame);
    const endIdx = upperBoundByFrameIndex(this.events, hiFrame);
    if (startIdx >= endIdx) return [];
    return this.events.slice(startIdx, endIdx);
  }

  getEventsInTickRange(startTickInclusive, endTickInclusive) {
    if (this.events.length === 0) return [];
    const loTick = Math.min(startTickInclusive, endTickInclusive);
    const hiTick = Math.max(startTickInclusive, endTickInclusive);
    const startIdx = lowerBoundByTick(this.events, loTick);
    const endIdx = upperBoundByTick(this.events, hiTick);
    if (startIdx >= endIdx) return [];
    return this.events.slice(startIdx, endIdx);
  }

  getEventCountsByType() {
    const counts = {};
    for (let i = 0; i < this.events.length; i++) {
      const t = this.events[i]?.type ?? 0;
      counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }

  getTimelineMarkers(maxMarkers = 160) {
    if (this.events.length === 0) return [];
    // Prioritize high-significance gameplay incidents for visual timeline ticks
    const highPriority = new Set([
      INCIDENT_EVENT_TYPES.GOAL_SCORED,
      INCIDENT_EVENT_TYPES.CAR_CAR_DEMO,
      INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED,
      INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT,
      INCIDENT_EVENT_TYPES.CAR_BALL_HIT,
      INCIDENT_EVENT_TYPES.CAR_CAR_BUMP,
    ]);

    const filtered = [];
    const seenFrameType = new Set();
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      if (!ev || !highPriority.has(ev.type)) continue;
      if (ev.type === INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED && !isBallFlipResetEvent(ev)) {
        continue;
      }
      const key = `${ev.frameIndex}:${ev.type}`;
      if (seenFrameType.has(key)) continue;
      seenFrameType.add(key);
      filtered.push({
        frameIndex: ev.frameIndex ?? 0,
        tick: ev.tick ?? 0,
        type: ev.type,
        carIndex: ev.carIndex ?? 0,
        team: ev.team ?? 0,
        label: INCIDENT_TYPE_LABELS[ev.type] || `Incident 0x${ev.type.toString(16)}`,
      });
    }

    if (filtered.length <= maxMarkers) return filtered;
    const step = filtered.length / maxMarkers;
    const sampled = [];
    for (let i = 0; i < maxMarkers; i++) {
      sampled.push(filtered[Math.floor(i * step)]);
    }
    return sampled;
  }
}

/**
 * Computes the starting 1-based HUD/POV slot key (1..6) for the Right team
 * given L players on the Left team and R players on the Right team (max 6 total):
 * - Prioritizes starting at 4 (3v3 -> 1,2,3 vs 4,5,6; 1v3 -> 1 vs 4,5,6; 1v1 -> 1 vs 4).
 * - If 4 is occupied by the Left team (L >= 4), shifts forward to L + 1 (4v1 -> 1..4 vs 5; 5v1 -> 1..5 vs 6).
 * - If the Right team has > 3 players (R > 3), shifts backward from 4 to (7 - R) so keys never exceed 6
 *   (1v4 -> 1 vs 3,4,5,6; 2v4 -> 1,2 vs 3,4,5,6; 1v5 -> 1 vs 2,3,4,5,6).
 */
export function computeRightTeamStartSlotKey(leftCount, rightCount) {
  const L = Math.max(0, Math.min(6, Math.floor(leftCount || 0)));
  const R = Math.max(0, Math.min(6, Math.floor(rightCount || 0)));
  if (R <= 0) return Math.max(4, L + 1);
  return Math.max(L + 1, Math.min(4, 7 - R));
}

export function assignTeamSlotKeys(leftEntries = [], rightEntries = []) {
  const L = Math.min(5, leftEntries.length);
  const R = Math.min(5, rightEntries.length);
  const rightStartKey = computeRightTeamStartSlotKey(L, R);
  const leftSlotKeys = [];
  const rightSlotKeys = [];
  const slotKeyToCarIndex = {};
  const carIndexToSlotKey = {};

  for (let i = 0; i < L; i++) {
    const slotKey = Math.min(6, i + 1);
    leftSlotKeys.push(slotKey);
    const entry = leftEntries[i];
    if (entry && typeof entry.carIndex === 'number') {
      slotKeyToCarIndex[slotKey] = entry.carIndex;
      carIndexToSlotKey[entry.carIndex] = slotKey;
    }
  }

  for (let j = 0; j < R; j++) {
    const slotKey = Math.min(6, rightStartKey + j);
    rightSlotKeys.push(slotKey);
    const entry = rightEntries[j];
    if (entry && typeof entry.carIndex === 'number') {
      slotKeyToCarIndex[slotKey] = entry.carIndex;
      carIndexToSlotKey[entry.carIndex] = slotKey;
    }
  }

  return {
    rightStartKey,
    leftSlotKeys,
    rightSlotKeys,
    slotKeyToCarIndex,
    carIndexToSlotKey,
  };
}

/**
 * Timeline 3: Chronological 64B Authoritative Match Signal Timeline.
 */
export class SignalTimeline {
  constructor({
    bytes,
    recordedEvents = [],
    synthesizedEvents = [],
    byFrameMap = new Map(),
    frameCount = 0,
    isCountUp = false,
    stateInputTimeline = null,
    incidentTimeline = null,
  }) {
    this.bytes = bytes || new Uint8Array(0);
    this.recordedEvents = recordedEvents
      .slice()
      .sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0) || (a.tick ?? 0) - (b.tick ?? 0));
    this.synthesizedEvents = synthesizedEvents
      .slice()
      .sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0) || (a.tick ?? 0) - (b.tick ?? 0));
    this.events =
      this.recordedEvents.length > 0 ? this.recordedEvents : this.synthesizedEvents;
    this.byFrameMap = byFrameMap;
    this.frameCount = frameCount;
    this.isCountUp = isCountUp;
    this.stateInputTimeline = stateInputTimeline || null;
    this.incidentTimeline = incidentTimeline || null;
    this._kickoffClockStartCache = new Map();
  }

  get recordedCount() {
    return this.recordedEvents.length;
  }

  get synthesizedCount() {
    return this.recordedEvents.length > 0 ? 0 : this.synthesizedEvents.length;
  }

  get count() {
    return this.events.length;
  }

  getEventsAtFrame(frameIndex) {
    return this.byFrameMap.get(Math.floor(frameIndex)) || [];
  }

  getEventsInFrameRange(startFrameInclusive, endFrameInclusive) {
    if (this.events.length === 0) return [];
    const loFrame = Math.min(startFrameInclusive, endFrameInclusive);
    const hiFrame = Math.max(startFrameInclusive, endFrameInclusive);
    const startIdx = lowerBoundByFrameIndex(this.events, loFrame);
    const endIdx = upperBoundByFrameIndex(this.events, hiFrame);
    if (startIdx >= endIdx) return [];
    return this.events.slice(startIdx, endIdx);
  }

  getAudioCuesInFrameRange(startFrameInclusive, endFrameInclusive, isCountUpOverride = null) {
    const sigs = this.getEventsInFrameRange(startFrameInclusive, endFrameInclusive);
    if (sigs.length === 0) return [];
    const countUp = isCountUpOverride !== null ? isCountUpOverride : this.isCountUp;
    const cues = [];
    for (let i = 0; i < sigs.length; i++) {
      const cue = resolveReplayAudioCueForSignal(sigs[i], countUp);
      if (cue) cues.push(cue);
    }
    return cues;
  }

  /**
   * Resolves the exact frame after a kickoff GO (`kickoffGoFrame`) when the 5-minute match clock
   * begins ticking: either on the first ball touch / ball movement OR after 5 seconds (600 ticks @ 120Hz)
   * of no ball touch.
   */
  _resolveClockStartFrameAfterKickoff(kickoffGoFrame) {
    const goFrame = Math.max(0, Math.floor(kickoffGoFrame));
    if (this._kickoffClockStartCache.has(goFrame)) {
      return this._kickoffClockStartCache.get(goFrame);
    }

    const maxWaitFrame = goFrame + 600; // 5.0s @ 120Hz
    let clockStartFrame = maxWaitFrame;

    if (this.incidentTimeline) {
      const incs = this.incidentTimeline.getEventsInFrameRange(goFrame, maxWaitFrame);
      for (let i = 0; i < incs.length; i++) {
        const ev = incs[i];
        if (ev && ev.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT) {
          const fIdx = Math.max(goFrame, ev.frameIndex ?? goFrame);
          if (fIdx < clockStartFrame) {
            clockStartFrame = fIdx;
          }
          break;
        }
      }
    }

    if (this.stateInputTimeline && this.stateInputTimeline.count > goFrame) {
      const baseSnap = this.stateInputTimeline.getSnapshotAt(goFrame);
      const baseX = baseSnap ? baseSnap[4] : 0;
      const baseY = baseSnap ? baseSnap[5] : 0;
      const searchEnd = Math.min(this.stateInputTimeline.count - 1, clockStartFrame);
      for (let f = goFrame; f <= searchEnd; f++) {
        const snap = this.stateInputTimeline.getSnapshotAt(f);
        if (!snap) continue;
        const bx = snap[4] - baseX;
        const by = snap[5] - baseY;
        const vx = snap[16];
        const vy = snap[17];
        if (bx * bx + by * by > 16.0 || vx * vx + vy * vy > 400.0) {
          clockStartFrame = f;
          break;
        }
      }
    }

    this._kickoffClockStartCache.set(goFrame, clockStartFrame);
    return clockStartFrame;
  }

  evaluateMatchStateAtFrame(frameIndex, matchInfo = {}) {
    let blueScore = 0;
    let orangeScore = 0;
    let initialDuration =
      typeof matchInfo.durationSeconds === 'number' && matchInfo.durationSeconds >= 0
        ? matchInfo.durationSeconds
        : 300;

    // Also inspect initial MATCH_INITIALIZED / MATCH_STARTED signals in case durationSeconds was encoded there
    for (let i = 0; i < Math.min(16, this.events.length); i++) {
      const s = this.events[i];
      if (!s) continue;
      if (
        (s.signalType === MATCH_SIGNALS.MATCH_INITIALIZED ||
          s.signalType === MATCH_SIGNALS.MATCH_STARTED) &&
        typeof s.param1 === 'number' &&
        s.param1 > 0
      ) {
        initialDuration = s.param1;
        break;
      }
    }

    let remainingSeconds = initialDuration;
    let overtimeSeconds = 0;
    let isOvertime = initialDuration === 0;
    let clockDirection = isOvertime ? 'up' : 'down';
    let matchPhase = 'playing';
    let kickoffCountdown = 0;
    let kickoffWillStartFrame = null;
    let clockActiveSinceFrame = null;

    const hasExplicitKickoffSignals = this.events.some(
      (s) =>
        s &&
        (s.signalType === MATCH_SIGNALS.KICKOFF_START ||
          s.signalType === MATCH_SIGNALS.KICKOFF_WILL_START)
    );

    const advanceClockToFrame = (targetFrame) => {
      if (clockActiveSinceFrame === null) return;
      const tFrame = Math.floor(targetFrame);
      if (tFrame < clockActiveSinceFrame) return;
      const deltaFrames = Math.max(0, tFrame - clockActiveSinceFrame);
      const elapsedSec = Math.floor(deltaFrames / 120);
      if (elapsedSec > 0) {
        if (isOvertime || clockDirection === 'up') {
          overtimeSeconds += elapsedSec;
          remainingSeconds = 0;
        } else {
          remainingSeconds = Math.max(0, remainingSeconds - elapsedSec);
        }
        clockActiveSinceFrame += elapsedSec * 120;
      }
    };

    const clampedFrame = Math.max(0, Math.floor(frameIndex));
    const sigsUpToFrame = this.getEventsInFrameRange(0, clampedFrame);

    if (!hasExplicitKickoffSignals && this.events.length === 0) {
      clockActiveSinceFrame = this._resolveClockStartFrameAfterKickoff(0);
    }

    for (let i = 0; i < sigsUpToFrame.length; i++) {
      const sig = sigsUpToFrame[i];
      if (!sig) continue;
      const sigFrame = sig.frameIndex ?? 0;
      switch (sig.signalType) {
        case MATCH_SIGNALS.MATCH_INITIALIZED:
        case MATCH_SIGNALS.MATCH_STARTED: {
          if (typeof sig.param1 === 'number' && sig.param1 > 0) {
            remainingSeconds = sig.param1;
            isOvertime = false;
            clockDirection = 'down';
          } else if (sig.param1 === 0 && matchInfo.durationSeconds === 0) {
            remainingSeconds = 0;
            isOvertime = true;
            clockDirection = 'up';
          }
          overtimeSeconds = 0;
          clockActiveSinceFrame = hasExplicitKickoffSignals
            ? null
            : this._resolveClockStartFrameAfterKickoff(sigFrame);
          break;
        }
        case MATCH_SIGNALS.KICKOFF_WILL_START:
          advanceClockToFrame(sigFrame);
          clockActiveSinceFrame = null;
          kickoffWillStartFrame = sigFrame;
          matchPhase = 'kickoff';
          break;
        case MATCH_SIGNALS.KICKOFF_START:
          kickoffWillStartFrame = null;
          kickoffCountdown = 0;
          clockActiveSinceFrame = this._resolveClockStartFrameAfterKickoff(sigFrame);
          matchPhase = isOvertime ? 'overtime' : 'playing';
          break;
        case MATCH_SIGNALS.SCORE_UPDATED:
          advanceClockToFrame(sigFrame);
          clockActiveSinceFrame = null;
          kickoffWillStartFrame = null;
          kickoffCountdown = 0;
          blueScore = sig.param1 ?? blueScore;
          orangeScore = sig.param2 ?? orangeScore;
          matchPhase = 'goal';
          break;
        case MATCH_SIGNALS.GOAL_REPLAY_WILL_START:
        case MATCH_SIGNALS.GOAL_REPLAY_START:
          advanceClockToFrame(sigFrame);
          clockActiveSinceFrame = null;
          kickoffWillStartFrame = null;
          kickoffCountdown = 0;
          matchPhase = 'replay';
          break;
        case MATCH_SIGNALS.CLOCK_UPDATED_SECONDS:
          if (sig.param2 === 1) {
            isOvertime = true;
            clockDirection = 'up';
            overtimeSeconds = sig.param1 ?? overtimeSeconds;
            remainingSeconds = 0;
          } else {
            remainingSeconds = sig.param1 ?? remainingSeconds;
          }
          clockActiveSinceFrame = sigFrame;
          break;
        case MATCH_SIGNALS.COUNTDOWN_10S:
        case MATCH_SIGNALS.TIME_ALERT_60S:
        case MATCH_SIGNALS.TIME_ALERT_30S:
          if (!isOvertime && clockDirection === 'down') {
            remainingSeconds = sig.param1 ?? remainingSeconds;
            clockActiveSinceFrame = sigFrame;
          }
          break;
        case MATCH_SIGNALS.OVERTIME_START:
          isOvertime = true;
          clockDirection = 'up';
          remainingSeconds = 0;
          overtimeSeconds = 0;
          clockActiveSinceFrame = null;
          matchPhase = 'overtime';
          break;
        case MATCH_SIGNALS.MATCH_ENDED:
        case MATCH_SIGNALS.PODIUM_START:
          advanceClockToFrame(sigFrame);
          clockActiveSinceFrame = null;
          kickoffWillStartFrame = null;
          kickoffCountdown = 0;
          matchPhase = 'podium';
          break;
        default:
          break;
      }
    }

    if (matchPhase === 'kickoff' && kickoffWillStartFrame !== null) {
      const remTicks = Math.max(0, kickoffWillStartFrame + 360 - clampedFrame);
      kickoffCountdown = Math.min(3, Math.ceil(remTicks / 120));
    }

    advanceClockToFrame(clampedFrame);

    return {
      blueScore,
      orangeScore,
      remainingSeconds: isOvertime ? overtimeSeconds : remainingSeconds,
      overtimeSeconds,
      isOvertime,
      clockDirection,
      matchPhase,
      kickoffCountdown,
      finalBlueScore: matchInfo.blueScore ?? blueScore,
      finalOrangeScore: matchInfo.orangeScore ?? orangeScore,
    };
  }

  getTimelineMarkers(maxMarkers = 120) {
    if (this.events.length === 0) return [];
    const ignoredSignals = new Set([
      MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
      MATCH_SIGNALS.COMMAND_ACK,
      MATCH_SIGNALS.PLAYER_JOINED,
      MATCH_SIGNALS.PLAYER_LEFT,
      MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
      MATCH_SIGNALS.PLAYER_SLOT_UPDATED,
      MATCH_SIGNALS.MATCH_CREATED,
      MATCH_SIGNALS.MATCH_INITIALIZED,
      MATCH_SIGNALS.MATCH_PREPARE,
      MATCH_SIGNALS.MATCH_DESTROYED,
    ]);
    const markers = [];
    for (let i = 0; i < this.events.length; i++) {
      const sig = this.events[i];
      if (!sig) continue;
      if (ignoredSignals.has(sig.signalType)) {
        continue;
      }
      markers.push({
        frameIndex: sig.frameIndex ?? 0,
        tick: sig.tick ?? sig.frameId ?? 0,
        type: sig.signalType,
        param1: sig.param1 ?? 0,
        param2: sig.param2 ?? 0,
        synthesized: Boolean(sig.synthesized),
        label:
          SIGNAL_TYPE_LABELS[sig.signalType] ||
          `Signal 0x${(sig.signalType || 0).toString(16)}`,
      });
    }
    if (markers.length <= maxMarkers) return markers;
    const step = markers.length / maxMarkers;
    const sampled = [];
    for (let i = 0; i < maxMarkers; i++) {
      sampled.push(markers[Math.floor(i * step)]);
    }
    return sampled;
  }
}

/**
 * Synthesizes fallback Track C signals from Track B GOAL_SCORED incidents and matchInfo
 * when a replay container was recorded with 0 explicit Track C signals (e.g. legacy exp-multi-bots replays).
 */
export function synthesizeFallbackSignalsFromIncidents(incidents, frameSlots, matchInfo = {}) {
  const frameCount = Array.isArray(frameSlots) ? frameSlots.length : 0;
  if (frameCount <= 0) return [];

  const synthesized = [];
  let nextSignalId = 1;
  const durationSeconds =
    typeof matchInfo.durationSeconds === 'number' && matchInfo.durationSeconds >= 0
      ? matchInfo.durationSeconds
      : 300;

  // 1. Match Start signal at frame 0
  synthesized.push({
    signalId: nextSignalId++,
    signalType: MATCH_SIGNALS.MATCH_STARTED,
    type: MATCH_SIGNALS.MATCH_STARTED,
    frameId: frameSlots[0]?.tick ?? 0,
    tick: frameSlots[0]?.tick ?? 0,
    param1: durationSeconds,
    param2: 0,
    frameIndex: 0,
    synthesized: true,
  });

  // Detect initial kickoff GO (either frame 360 if ball is stationary for first 3s, or frame 0)
  let initialKickoffGoFrame = 0;
  if (frameCount > 360) {
    const snap0 = frameSlots[0]?.snapshot;
    const snap350 = frameSlots[350]?.snapshot;
    if (
      snap0 &&
      snap350 &&
      Math.hypot(snap0[4], snap0[5]) < 5 &&
      Math.hypot(snap350[4], snap350[5]) < 5 &&
      Math.hypot(snap350[22 + 12], snap350[22 + 13]) < 10
    ) {
      synthesized.push({
        signalId: nextSignalId++,
        signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
        type: MATCH_SIGNALS.KICKOFF_WILL_START,
        frameId: frameSlots[0]?.tick ?? 0,
        tick: frameSlots[0]?.tick ?? 0,
        param1: 360,
        param2: 3,
        frameIndex: 0,
        synthesized: true,
      });
      initialKickoffGoFrame = 360;
    }
  }
  synthesized.push({
    signalId: nextSignalId++,
    signalType: MATCH_SIGNALS.KICKOFF_START,
    type: MATCH_SIGNALS.KICKOFF_START,
    frameId: frameSlots[initialKickoffGoFrame]?.tick ?? initialKickoffGoFrame,
    tick: frameSlots[initialKickoffGoFrame]?.tick ?? initialKickoffGoFrame,
    param1: 0,
    param2: 0,
    frameIndex: initialKickoffGoFrame,
    synthesized: true,
  });

  // 2. Scan Track B for GOAL_SCORED incidents (deduplicated per goal celebration window)
  let runningBlue = 0;
  let runningOrange = 0;
  let lastGoalFrame = -240;

  for (let i = 0; i < incidents.length; i++) {
    const inc = incidents[i];
    if (!inc || inc.type !== INCIDENT_EVENT_TYPES.GOAL_SCORED) continue;
    const fIdx = Math.max(0, Math.min(frameCount - 1, inc.frameIndex ?? 0));
    if (fIdx - lastGoalFrame < 60) continue; // Deduplicate dual WASM + mode GOAL_SCORED on same frame
    lastGoalFrame = fIdx;

    const scoringTeam = inc.team === 1 || (inc.y ?? inc.posY ?? 0) < 0 ? 1 : 0;
    if (scoringTeam === 0) runningBlue++;
    else runningOrange++;

    synthesized.push({
      signalId: nextSignalId++,
      signalType: MATCH_SIGNALS.SCORE_UPDATED,
      type: MATCH_SIGNALS.SCORE_UPDATED,
      frameId: inc.tick ?? frameSlots[fIdx]?.tick ?? fIdx,
      tick: inc.tick ?? frameSlots[fIdx]?.tick ?? fIdx,
      param1: runningBlue,
      param2: runningOrange,
      frameIndex: fIdx,
      synthesized: true,
    });

    // Scan forward after goal celebration for next kickoff reset (ball returns to center (0,0))
    for (let k = fIdx + 30; k < frameCount; k++) {
      const snap = frameSlots[k]?.snapshot;
      if (snap && Math.hypot(snap[4], snap[5]) < 5.0 && Math.hypot(snap[16], snap[17]) < 5.0) {
        synthesized.push({
          signalId: nextSignalId++,
          signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
          type: MATCH_SIGNALS.KICKOFF_WILL_START,
          frameId: frameSlots[k]?.tick ?? k,
          tick: frameSlots[k]?.tick ?? k,
          param1: 360,
          param2: 3,
          frameIndex: k,
          synthesized: true,
        });
        const goIdx = Math.min(frameCount - 1, k + 360);
        synthesized.push({
          signalId: nextSignalId++,
          signalType: MATCH_SIGNALS.KICKOFF_START,
          type: MATCH_SIGNALS.KICKOFF_START,
          frameId: frameSlots[goIdx]?.tick ?? goIdx,
          tick: frameSlots[goIdx]?.tick ?? goIdx,
          param1: 0,
          param2: 0,
          frameIndex: goIdx,
          synthesized: true,
        });
        break;
      }
    }
  }

  // 3. Match End signal at final frame if matchInfo has a score or non-freeplay mode
  if (frameCount > 1 && matchInfo.mode !== 'freeplay' && matchInfo.mode !== 'training') {
    const lastIdx = frameCount - 1;
    const winnerCode =
      matchInfo.winner === 'blue' ? 0 : matchInfo.winner === 'orange' ? 1 : 2;
    synthesized.push({
      signalId: nextSignalId++,
      signalType: MATCH_SIGNALS.MATCH_ENDED,
      type: MATCH_SIGNALS.MATCH_ENDED,
      frameId: frameSlots[lastIdx]?.tick ?? lastIdx,
      tick: frameSlots[lastIdx]?.tick ?? lastIdx,
      param1: winnerCode,
      param2: matchInfo.winReason ?? 0,
      frameIndex: lastIdx,
      synthesized: true,
    });
  }

  return synthesized;
}
