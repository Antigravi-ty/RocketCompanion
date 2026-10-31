/**
 * ReplayPlaybackState.js
 * Goal Replay time window resolution and chronological frame slice extraction
 * from either a ReplayRingBuffer or the 256MB C++ WASM Replay Buffer.
 */

import { MATCH_SIGNALS } from '../physics/RocketSimConstants.js';
import { REPLAY_TICK_RATE, resolveReplayAudioCueForSignal } from './ReplayRingBuffer.js';
import {
  unpackControls64ToCars,
  unpackIncidentTrackToEvents,
  unpackSignalTrackToEvents,
} from './container/RCReplayBinarySchema.js';

export const REPLAY_PLAYBACK_SPEEDS = Object.freeze([0.25, 0.5, 1.0, 2.0]);
export const DEFAULT_GOAL_REPLAY_TICKS = 360; // 3.0s @ 120Hz
export const DEFAULT_GOAL_LOOKBACK_SECONDS = 10.0; // Max 10.0s before goal incident (1200 ticks @ 120Hz)
export const DEFAULT_SCORER_TOUCH_LOOKBACK_SECONDS = 7.0; // Max 7.0s before scorer's last touch (840 ticks @ 120Hz)
export const DEFAULT_GOAL_POST_SECONDS = 3.0; // 3.0s after goal incident (360 ticks @ 120Hz)

function decodeWasmEventTrackMaps(engine) {
  const incidentsByFrame = new Map();
  const signalsByFrame = new Map();
  const incidentsByTick = new Map();
  const signalsByTick = new Map();

  if (!engine) {
    return { incidentsByFrame, signalsByFrame, incidentsByTick, signalsByTick };
  }

  const incidentBytes = engine.getReplayIncidentTrackBytes?.() || null;
  if (incidentBytes && incidentBytes.byteLength >= 64) {
    const incList = unpackIncidentTrackToEvents(incidentBytes);
    for (let i = 0; i < incList.length; i++) {
      const inc = incList[i];
      const fIdx = inc.frameIndex ?? -1;
      if (fIdx >= 0) {
        let arr = incidentsByFrame.get(fIdx);
        if (!arr) {
          arr = [];
          incidentsByFrame.set(fIdx, arr);
        }
        arr.push(inc);
      }
      const tick = inc.tick ?? -1;
      if (tick >= 0) {
        let tArr = incidentsByTick.get(tick);
        if (!tArr) {
          tArr = [];
          incidentsByTick.set(tick, tArr);
        }
        tArr.push(inc);
      }
    }
  }

  const signalBytes = engine.getReplaySignalTrackBytes?.() || null;
  if (signalBytes && signalBytes.byteLength >= 64) {
    const sigList = unpackSignalTrackToEvents(signalBytes);
    for (let i = 0; i < sigList.length; i++) {
      const sig = sigList[i];
      const fIdx = sig.frameIndex ?? -1;
      if (fIdx >= 0) {
        let arr = signalsByFrame.get(fIdx);
        if (!arr) {
          arr = [];
          signalsByFrame.set(fIdx, arr);
        }
        arr.push(sig);
      }
      const tick = sig.frameId ?? -1;
      if (tick >= 0) {
        let tArr = signalsByTick.get(tick);
        if (!tArr) {
          tArr = [];
          signalsByTick.set(tick, tArr);
        }
        tArr.push(sig);
      }
    }
  }

  return { incidentsByFrame, signalsByFrame, incidentsByTick, signalsByTick };
}

function buildWasmFrameSlot(engine, wasmFrameIndex, view, eventMaps) {
  const snapshot = new Float32Array(view.length);
  snapshot.set(view);
  const tick = Math.floor(snapshot[0] || 0);
  const ctrlBytes = engine.getReplayControlsByIndex?.(wasmFrameIndex) || null;
  const acknowledgedControls = ctrlBytes ? unpackControls64ToCars(ctrlBytes, 0) : [];
  const incidents =
    eventMaps.incidentsByFrame.get(wasmFrameIndex) ||
    eventMaps.incidentsByTick.get(tick) ||
    [];
  const signals =
    eventMaps.signalsByFrame.get(wasmFrameIndex) ||
    eventMaps.signalsByTick.get(tick) ||
    [];
  const audioEvents = [];
  for (let s = 0; s < signals.length; s++) {
    const cue = resolveReplayAudioCueForSignal(signals[s], false);
    if (cue) {
      audioEvents.push(cue);
    }
  }
  return {
    tick,
    snapshot,
    acknowledgedControls,
    incidents,
    signals,
    audioEvents,
  };
}

/**
 * Computes the effective Goal Replay frame bounds [effectiveStartFrame, effectiveEndFrame]
 * around `goalIncidentTick`.
 *
 * Online / Exhibition Goal Replay Two-Timestamp Rule:
 * - Timestamp A: `goalIncidentTick - lookbackSeconds` (default 10s = 1200 ticks before goal)
 * - Timestamp B: `scorerTouchTick - touchLookbackSeconds` (default 7s = 840 ticks before scorer's last touch)
 * Whichever lookback duration is shorter (`Math.max(TimestampA, TimestampB)`) is selected,
 * then clamped to the most recent `KICKOFF_WILL_START` tick (`lastKickoffWillStartTick`).
 */
export function resolveGoalReplayWindowBounds(options = {}) {
  const {
    goalIncidentTick = null,
    scorerTouchTick = -1,
    lookbackSeconds = DEFAULT_GOAL_LOOKBACK_SECONDS,
    touchLookbackSeconds = DEFAULT_SCORER_TOUCH_LOOKBACK_SECONDS,
    postGoalSeconds = DEFAULT_GOAL_POST_SECONDS,
    preGoalTicks = null,
    postGoalTicks = null,
    lastKickoffWillStartTick = -1,
    ringBuffer = null,
    signalLog = null
  } = options;

  const resolvedPreTicks = typeof preGoalTicks === 'number' && Number.isFinite(preGoalTicks)
    ? Math.round(preGoalTicks)
    : Math.round(Number(lookbackSeconds ?? DEFAULT_GOAL_LOOKBACK_SECONDS) * REPLAY_TICK_RATE);
  const resolvedTouchPreTicks = Math.round(
    Number(touchLookbackSeconds ?? DEFAULT_SCORER_TOUCH_LOOKBACK_SECONDS) * REPLAY_TICK_RATE
  );
  const resolvedPostTicks = typeof postGoalTicks === 'number' && Number.isFinite(postGoalTicks)
    ? Math.round(postGoalTicks)
    : Math.round(Number(postGoalSeconds ?? DEFAULT_GOAL_POST_SECONDS) * REPLAY_TICK_RATE);

  let resolvedGoalTick = typeof goalIncidentTick === 'number' && Number.isFinite(goalIncidentTick) && goalIncidentTick >= 0
    ? Math.floor(goalIncidentTick)
    : -1;

  if (resolvedGoalTick < 0 && Array.isArray(signalLog)) {
    for (let i = signalLog.length - 1; i >= 0; i--) {
      const sig = signalLog[i];
      if (
        sig &&
        (sig.signalType === MATCH_SIGNALS.GOAL_REPLAY_WILL_START || sig.signalType === MATCH_SIGNALS.SCORE_UPDATED) &&
        typeof sig.frameId === 'number'
      ) {
        resolvedGoalTick = sig.frameId;
        break;
      }
    }
  }

  if (resolvedGoalTick < 0 && ringBuffer && typeof ringBuffer.findLatestSignalTick === 'function') {
    resolvedGoalTick = ringBuffer.findLatestSignalTick(MATCH_SIGNALS.GOAL_REPLAY_WILL_START);
    if (resolvedGoalTick < 0) {
      resolvedGoalTick = ringBuffer.findLatestSignalTick(MATCH_SIGNALS.SCORE_UPDATED);
    }
  }

  if (resolvedGoalTick < 0) {
    const newestTick = ringBuffer?.getNewestFrame?.()?.tick ?? 0;
    resolvedGoalTick = Math.max(0, newestTick - Math.max(0, resolvedPostTicks));
  }

  let resolvedKickoffTick =
    typeof lastKickoffWillStartTick === 'number' &&
    Number.isFinite(lastKickoffWillStartTick) &&
    lastKickoffWillStartTick >= 0 &&
    lastKickoffWillStartTick <= resolvedGoalTick
      ? Math.floor(lastKickoffWillStartTick)
      : -1;

  if (Array.isArray(signalLog)) {
    for (let i = signalLog.length - 1; i >= 0; i--) {
      const sig = signalLog[i];
      if (
        sig &&
        sig.signalType === MATCH_SIGNALS.KICKOFF_WILL_START &&
        typeof sig.frameId === 'number' &&
        sig.frameId <= resolvedGoalTick
      ) {
        resolvedKickoffTick = Math.max(resolvedKickoffTick, sig.frameId);
        break;
      }
    }
  }

  if (ringBuffer && typeof ringBuffer.findLatestSignalTick === 'function') {
    const bufKickoffTick = ringBuffer.findLatestSignalTick(MATCH_SIGNALS.KICKOFF_WILL_START, resolvedGoalTick);
    if (bufKickoffTick >= 0) {
      resolvedKickoffTick = Math.max(resolvedKickoffTick, bufKickoffTick);
    }
  }

  const goalMaxStartFrame = resolvedGoalTick - resolvedPreTicks;
  const hasValidScorerTouch =
    typeof scorerTouchTick === 'number' &&
    Number.isFinite(scorerTouchTick) &&
    scorerTouchTick >= 0 &&
    scorerTouchTick <= resolvedGoalTick;
  const touchStartFrame = hasValidScorerTouch
    ? Math.floor(scorerTouchTick) - resolvedTouchPreTicks
    : goalMaxStartFrame;

  // Use whichever lookback window is shorter (the later start timestamp)
  const requestedStartFrame = hasValidScorerTouch
    ? Math.max(goalMaxStartFrame, touchStartFrame)
    : goalMaxStartFrame;

  const effectiveStartFrame = resolvedKickoffTick >= 0
    ? Math.max(requestedStartFrame, resolvedKickoffTick)
    : Math.max(0, requestedStartFrame);
  const effectiveEndFrame = resolvedGoalTick + resolvedPostTicks;
  const clampedByKickoff = resolvedKickoffTick >= 0 && resolvedKickoffTick > requestedStartFrame;

  return {
    goalIncidentFrame: resolvedGoalTick,
    scorerTouchFrame: hasValidScorerTouch ? Math.floor(scorerTouchTick) : -1,
    goalMaxStartFrame,
    touchStartFrame,
    requestedStartFrame,
    lastKickoffWillStartFrame: resolvedKickoffTick,
    effectiveStartFrame,
    effectiveEndFrame,
    preGoalTicks: resolvedGoalTick - requestedStartFrame,
    postGoalTicks: resolvedPostTicks,
    clampedByKickoff
  };
}

/**
 * Extracts a chronological slice of replay frames from either a ReplayRingBuffer
 * or the 256MB C++ WASM Replay Buffer (getReplayFrameByOffset).
 */
export function extractGoalReplayFrames(options = {}) {
  const {
    ringBuffer = null,
    engine = null,
    durationTicks = DEFAULT_GOAL_REPLAY_TICKS,
    goalIncidentTick = null,
    scorerTouchTick = -1,
    lookbackSeconds = undefined,
    touchLookbackSeconds = undefined,
    postGoalSeconds = undefined,
    preGoalTicks = null,
    postGoalTicks = null,
    lastKickoffWillStartTick = -1,
    signalLog = null
  } = options;

  const hasExplicitGoalWindow =
    goalIncidentTick !== null ||
    scorerTouchTick >= 0 ||
    lookbackSeconds !== undefined ||
    postGoalSeconds !== undefined ||
    preGoalTicks !== null ||
    postGoalTicks !== null ||
    (ringBuffer && typeof ringBuffer.findLatestSignalTick === 'function' && ringBuffer.findLatestSignalTick(MATCH_SIGNALS.GOAL_REPLAY_WILL_START) >= 0);

  if (hasExplicitGoalWindow) {
    const bounds = resolveGoalReplayWindowBounds({
      goalIncidentTick,
      scorerTouchTick,
      lookbackSeconds: lookbackSeconds ?? DEFAULT_GOAL_LOOKBACK_SECONDS,
      touchLookbackSeconds: touchLookbackSeconds ?? DEFAULT_SCORER_TOUCH_LOOKBACK_SECONDS,
      postGoalSeconds: postGoalSeconds ?? DEFAULT_GOAL_POST_SECONDS,
      preGoalTicks,
      postGoalTicks,
      lastKickoffWillStartTick,
      ringBuffer,
      signalLog
    });

    if (ringBuffer && ringBuffer.size > 0 && typeof ringBuffer.getFramesInTickRange === 'function') {
      const ranged = ringBuffer.getFramesInTickRange(bounds.effectiveStartFrame, bounds.effectiveEndFrame);
      if (ranged.length > 0) {
        return ranged;
      }
    }

    if (engine && typeof engine.getReplayFrameCount === 'function' && typeof engine.getReplayFrameByIndex === 'function') {
      const totalWasmFrames = engine.getReplayFrameCount();
      const eventMaps = decodeWasmEventTrackMaps(engine);
      const matched = [];
      for (let i = 0; i < totalWasmFrames; i++) {
        const view = engine.getReplayFrameByIndex(i);
        if (!view) continue;
        if (view.length > 302 && Math.abs((view[302] || 0) - 1337.5) <= 0.01) continue;
        const tick = Math.floor(view[0] || 0);
        if (tick >= bounds.effectiveStartFrame && tick <= bounds.effectiveEndFrame) {
          matched.push(buildWasmFrameSlot(engine, i, view, eventMaps));
        }
      }
      if (matched.length > 0) {
        return matched;
      }
    }
  }

  const maxTicks = Math.max(1, Math.floor(durationTicks));

  if (ringBuffer && ringBuffer.size > 0) {
    const recent = ringBuffer.getRecentFrames(maxTicks).filter(Boolean);
    if (recent.length > 0) {
      const newestTick = recent[recent.length - 1].tick;
      const koTick = typeof ringBuffer.findLatestSignalTick === 'function'
        ? ringBuffer.findLatestSignalTick(MATCH_SIGNALS.KICKOFF_WILL_START, newestTick)
        : -1;
      const effectiveKoTick = Math.max(koTick, lastKickoffWillStartTick ?? -1);
      if (effectiveKoTick >= 0) {
        const clamped = recent.filter((f) => f.tick >= effectiveKoTick);
        if (clamped.length > 0) return clamped;
      }
      return recent;
    }
  }

  if (engine && typeof engine.getReplayFrameCount === 'function' && typeof engine.getReplayFrameByOffset === 'function') {
    const totalWasmFrames = engine.getReplayFrameCount();
    const eventMaps = decodeWasmEventTrackMaps(engine);
    const count = Math.min(totalWasmFrames, maxTicks);
    const frames = [];
    for (let i = 0; i < count; i++) {
      const ticksAgo = count - 1 - i;
      const wasmIdx = Math.max(0, totalWasmFrames - 1 - ticksAgo);
      const view = engine.getReplayFrameByOffset(ticksAgo);
      if (view && !(view.length > 302 && Math.abs((view[302] || 0) - 1337.5) <= 0.01)) {
        frames.push(buildWasmFrameSlot(engine, wasmIdx, view, eventMaps));
      }
    }
    return frames;
  }

  return [];
}
