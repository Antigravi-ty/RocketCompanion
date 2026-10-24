/**
 * DevTestLabReplayHelper.js
 * Bench 3 (State Replay Recording, Scrubbing, Pre-Roll Resume & Hotkeys O / P / [ / ] / G)
 * helper for DeveloperTestLabMode.
 */

import { useDevTestLabStore } from '../../../stores/devTestLabStore';
import { useAppStore } from '../../../stores/appStore';
import { floatingStore } from '../../../stores/floatingStore';
import { STATE_BUFFER_FLOATS } from '../../../physics/RocketSimConstants.js';
import {
  exportRetainedMatchReplayFile,
  parseRCReplayFile,
  RC_REPLAY_MAGIC,
} from '../../../replay/ReplayFileExporter.js';
import { DEFAULT_CAR_CONTROLS } from '../../../ai/experimental/ExperimentalBotAgent.js';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.js';

export const MAX_TAS_FRAMES = 18000; // 150 seconds @ 120Hz

export async function exportStateReplayFile(tasFrames, options = {}) {
  if (!Array.isArray(tasFrames) || tasFrames.length === 0) return false;
  const normalizedFrames = [];
  const normalizedSlots = [];
  for (let i = 0; i < tasFrames.length; i++) {
    const item = tasFrames[i];
    const src =
      item instanceof Float32Array
        ? item
        : item?.compactSnap instanceof Float32Array
        ? item.compactSnap
        : item?.renderState instanceof Float32Array
        ? item.renderState
        : null;
    const snap = new Float32Array(STATE_BUFFER_FLOATS);
    if (src) {
      snap.set(src.subarray(0, Math.min(src.length, STATE_BUFFER_FLOATS)));
    }
    normalizedFrames.push(snap);
    normalizedSlots.push({
      tick: Math.floor(snap[0] || i),
      snapshot: snap,
      controls: item?.controls || null,
      acknowledgedControls: item?.acknowledgedControls || null,
      incidents: Array.isArray(item?.incidents) ? item.incidents : [],
      signals: Array.isArray(item?.signals) ? item.signals : [],
    });
  }

  return exportRetainedMatchReplayFile({
    magic: RC_REPLAY_MAGIC,
    version: 2,
    stateFloats: STATE_BUFFER_FLOATS,
    tickRate: 120,
    frameCount: normalizedFrames.length,
    durationSec: Number((normalizedFrames.length / 120).toFixed(2)),
    winner: options.winner || 'draw',
    blueScore: options.blueScore ?? 0,
    orangeScore: options.orangeScore ?? 0,
    mode: 'state-replay',
    createdAtIso: new Date().toISOString(),
    frames: normalizedFrames,
    slots: normalizedSlots,
  });
}

function doesRewinderWindowExist() {
  return floatingStore
    .getSnapshot()
    .windows.some((w) => w.id === 'rewinder-configurator');
}

export function bindDevTestLabReplayHotkeys(mode) {
  if (typeof window === 'undefined') return;
  unbindDevTestLabReplayHotkeys(mode);

  mode._keyDownHandler = (evt) => {
    if (mode.runtime?.match?.state?.mode !== 'dev-test-lab') return;
    if (useAppStore.getState().isOpen) return;
    if (!doesRewinderWindowExist()) return;
    const tag = evt.target?.tagName?.toUpperCase?.() || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const noMods = !evt.ctrlKey && !evt.shiftKey && !evt.altKey && !evt.metaKey;
    if ((evt.code === 'KeyO' || evt.key === 'o' || evt.key === 'O') && noMods) {
      if (!evt.repeat) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        mode.startTasRecording();
      }
      return;
    }

    if ((evt.code === 'KeyP' || evt.key === 'p' || evt.key === 'P') && noMods) {
      if (!evt.repeat) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        mode.stopTasRecording();
      }
      return;
    }

    if ((evt.code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && noMods) {
      if (!evt.repeat) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        mode.resumeTasFromCursor();
      }
      return;
    }

    if (evt.code === 'BracketLeft' || evt.key === '[') {
      evt.preventDefault();
      if (!evt.repeat) mode.beginTasScrub('rewinding');
      return;
    }

    if (evt.code === 'BracketRight' || evt.key === ']') {
      evt.preventDefault();
      if (!evt.repeat) mode.beginTasScrub('forwarding');
    }
  };

  mode._keyUpHandler = (evt) => {
    if (mode.runtime?.match?.state?.mode !== 'dev-test-lab') return;
    if (!doesRewinderWindowExist()) return;
    if (evt.code === 'BracketLeft' || evt.key === '[' || evt.code === 'BracketRight' || evt.key === ']') {
      evt.preventDefault();
      mode.pauseTasScrub();
    }
  };

  window.addEventListener('keydown', mode._keyDownHandler, true);
  window.addEventListener('keyup', mode._keyUpHandler, true);
}

export function unbindDevTestLabReplayHotkeys(mode) {
  if (typeof window === 'undefined') return;
  if (mode._keyDownHandler) {
    window.removeEventListener('keydown', mode._keyDownHandler, true);
    mode._keyDownHandler = null;
  }
  if (mode._keyUpHandler) {
    window.removeEventListener('keyup', mode._keyUpHandler, true);
    mode._keyUpHandler = null;
  }
}

export function applyTasFrameAtCursor(mode, smoothStep = false) {
  const r = mode.runtime;
  if (!r?.physics || mode.tasFrames.length === 0) return;
  const idx = Math.max(0, Math.min(mode.tasFrames.length - 1, Math.floor(mode.tasCursor)));
  const entry = mode.tasFrames[idx];
  if (!entry) return;

  if (smoothStep && r.interpolator) {
    r.interpolator.prevState.set(r.interpolator.currState);
  }

  const compactSnap = entry.compactSnap || entry.renderState || entry.arenaSnap;
  if (compactSnap) {
    r.physics.restoreState(compactSnap);
  }
  if (r.interpolator) {
    if (!smoothStep) {
      r.interpolator.prevState.set(r.physics.state);
      r.interpolator.alpha = 0;
    }
    r.interpolator.currState.set(r.physics.state);
  }
}

export function recordTasFrameAfterTick(mode, store) {
  const r = mode.runtime;
  if (store.tasState !== 'recording' || !r?.physics) return;
  if (mode.tasFrames.length < MAX_TAS_FRAMES) {
    const compactSnap = r.physics.saveCompactState();
    mode.tasFrames.push({
      compactSnap,
      renderState: compactSnap,
      controls: { ...r.playerControls },
    });
    r.physics.recordReplayFrame?.();
    mode.tasCursor = mode.tasFrames.length - 1;
    mode.tasTargetFrame = mode.tasCursor;
    if (mode.tasFrames.length % 6 === 0 || mode.tasFrames.length === 120 || mode.tasFrames.length === 240) {
      store.updateLiveTelemetry({
        tasRecordedFrames: mode.tasFrames.length,
        tasCursorFrame: mode.tasCursor,
        tasTargetFrame: mode.tasTargetFrame,
      });
    }
  } else {
    mode.stopTasRecording();
  }
}

function ensureDevTestLabActive(mode, actionName) {
  const currentMode = mode?.runtime?.match?.state?.mode || 'dev-test-lab';
  if (currentMode !== 'dev-test-lab') {
    console.warn(
      `[DevTestLabReplayHelper] Cannot execute "${actionName}": active mode is "${currentMode}" (requires "dev-test-lab").`
    );
    return false;
  }
  return true;
}

export function startTasRecordingSession(mode) {
  if (!ensureDevTestLabActive(mode, 'startTasRecordingSession')) return;
  const r = mode.runtime;
  if (!r?.physics) {
    console.warn('[DevTestLabReplayHelper] Cannot start recording: physics engine is not initialized.');
    return;
  }
  const store = useDevTestLabStore.getState();

  mode.tasFrames = [];
  mode.tasCursor = 0;
  mode.tasTargetFrame = 0;
  mode.tasScrubAccumulator = 0;
  mode._tasLastCountdownSecBeep = -1;
  r.physics.clearReplayBuffer?.();
  r.physics.clearEvents?.();
  r.physics.resetGoalLatch?.();
  r._clientGoalIncidentLatched = false;
  r.simulationStage?.resetActionStates?.();

  store.updateLiveTelemetry({
    tasState: 'recording',
    tasRecordedFrames: 0,
    tasCursorFrame: 0,
    tasTargetFrame: 0,
    tasPrerollRemainingSec: 0,
  });
}

export function pauseTasRecordingSession(mode) {
  if (!ensureDevTestLabActive(mode, 'pauseTasRecordingSession')) return;
  const store = useDevTestLabStore.getState();
  if (store.tasState === 'recording') {
    const lastFrame = Math.max(0, mode.tasFrames.length - 1);
    mode.tasCursor = lastFrame;
    mode.tasTargetFrame = lastFrame;
    store.updateLiveTelemetry({
      tasState: 'stopped',
      tasRecordedFrames: mode.tasFrames.length,
      tasCursorFrame: lastFrame,
      tasTargetFrame: lastFrame,
      tasPrerollRemainingSec: 0,
    });
  } else {
    console.warn(`[DevTestLabReplayHelper] Cannot stop recording: current state is "${store.tasState}".`);
  }
}

export function beginTasScrubSession(mode, direction = 'rewinding') {
  if (!ensureDevTestLabActive(mode, `beginTasScrubSession(${direction})`)) return;
  if (mode.tasFrames.length === 0) {
    console.warn(`[DevTestLabReplayHelper] Cannot start ${direction}: recorded frame buffer is empty (0 frames).`);
    return;
  }
  const store = useDevTestLabStore.getState();
  if (store.tasState === 'recording') {
    mode.tasCursor = mode.tasFrames.length - 1;
    mode.tasTargetFrame = mode.tasCursor;
  } else if (store.tasState === 'preroll-countdown') {
    mode.tasCursor = mode.tasTargetFrame;
  }
  mode.tasScrubAccumulator = 0;
  mode._tasLastCountdownSecBeep = -1;
  store.updateLiveTelemetry({
    tasState: direction,
    tasRecordedFrames: mode.tasFrames.length,
    tasCursorFrame: Math.round(mode.tasCursor),
    tasTargetFrame: Math.round(mode.tasCursor),
    tasPrerollRemainingSec: 0,
  });
}

export function pauseTasScrubSession(mode) {
  const store = useDevTestLabStore.getState();
  if (store.tasState === 'rewinding' || store.tasState === 'forwarding') {
    const clamped = Math.max(0, Math.min(mode.tasFrames.length - 1, Math.round(mode.tasCursor)));
    mode.tasCursor = clamped;
    mode.tasTargetFrame = clamped;
    store.updateLiveTelemetry({
      tasState: 'paused-scrub',
      tasCursorFrame: clamped,
      tasTargetFrame: clamped,
    });
  }
}

export function seekTasFrameToIndex(mode, frameIndex) {
  if (!ensureDevTestLabActive(mode, 'seekTasFrameToIndex')) return;
  if (!mode.tasFrames || mode.tasFrames.length === 0) {
    console.warn('[DevTestLabReplayHelper] Cannot seek frame: recorded frame buffer is empty (0 frames).');
    return;
  }
  const clamped = Math.max(0, Math.min(mode.tasFrames.length - 1, Math.round(frameIndex)));
  mode.tasCursor = clamped;
  mode.tasTargetFrame = clamped;
  mode.tasScrubAccumulator = 0;
  mode._tasLastCountdownSecBeep = -1;
  applyTasFrameAtCursor(mode, false);
  useDevTestLabStore.getState().updateLiveTelemetry({
    tasState: 'paused-scrub',
    tasCursorFrame: clamped,
    tasTargetFrame: clamped,
    tasPrerollRemainingSec: 0,
  });
}

export function resumeTasFromCursorSession(mode) {
  if (!ensureDevTestLabActive(mode, 'resumeTasFromCursorSession')) return;
  const r = mode.runtime;
  const store = useDevTestLabStore.getState();
  const downSec = store.tasDownCounterSec ?? 3;
  const minRequiredFrames = downSec === 0 ? 120 : 240;
  if (!r?.physics) {
    console.warn('[DevTestLabReplayHelper] Cannot resume from cursor: physics engine is not initialized.');
    return;
  }
  if (mode.tasFrames.length < minRequiredFrames) {
    console.warn(
      `[DevTestLabReplayHelper] Cannot resume from cursor: recorded frames (${mode.tasFrames.length}) < minimum required frames (${minRequiredFrames}) for downCounter=${downSec}s.`
    );
    return;
  }

  if (store.tasState === 'recording') {
    const lastFrame = Math.max(0, mode.tasFrames.length - 1);
    mode.tasCursor = lastFrame;
    mode.tasTargetFrame = lastFrame;
  }

  const baseTarget =
    store.tasState === 'preroll-countdown' || store.tasState === 'stopped'
      ? mode.tasTargetFrame || mode.tasCursor
      : mode.tasCursor;

  const targetIdx = Math.max(
    minRequiredFrames - 1,
    Math.min(mode.tasFrames.length - 1, Math.round(baseTarget))
  );
  const lookbackFrames = (downSec === 0 ? 1 : downSec + 1) * 120;
  const startIdx = Math.max(0, targetIdx - lookbackFrames);

  mode.tasTargetFrame = targetIdx;
  mode.tasCursor = startIdx;
  mode._tasLastCountdownSecBeep = -1;

  applyTasFrameAtCursor(mode, false);
  r.simulationStage?.resetActionStates?.();

  const remFrames = Math.max(0, targetIdx - startIdx);
  const remSec = Math.ceil(remFrames / 120);
  const audio = r?.options?.gameAudio || gameAudio;
  if (downSec === 0) {
    mode._tasLastCountdownSecBeep = 1;
    audio?.play?.('training_countdown', 1.0, 200);
  } else if (remSec >= 1 && remSec <= downSec) {
    mode._tasLastCountdownSecBeep = remSec;
    audio?.play?.('training_countdown', 1.0, 200);
  }

  store.updateLiveTelemetry({
    tasState: 'preroll-countdown',
    tasRecordedFrames: mode.tasFrames.length,
    tasCursorFrame: startIdx,
    tasTargetFrame: targetIdx,
    tasPrerollRemainingSec: downSec === 0 ? 1 : Math.min(downSec, remSec),
  });
}

export async function importTasReplayFile(mode, fileOrBuffer) {
  if (!ensureDevTestLabActive(mode, 'importTasReplayFile')) return false;
  const r = mode.runtime;
  if (!r?.physics) {
    console.warn('[DevTestLabReplayHelper] Cannot import replay: physics engine is not initialized.');
    return false;
  }
  try {
    const parsed = await parseRCReplayFile(fileOrBuffer);
    if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) {
      throw new Error('No valid frames found in replay file.');
    }
    mode._ensureSinglePlayerCarOnly(false);
    mode.tasFrames = parsed.frames.map((snap, idx) => {
      const slot = parsed.frameSlots?.[idx] || null;
      const car0Ctrl =
        slot?.acknowledgedControls?.[0] ||
        snap?.controls?.[0] ||
        r.neutralControls ||
        DEFAULT_CAR_CONTROLS;
      return {
        compactSnap: snap,
        renderState: snap,
        controls: { ...car0Ctrl },
        acknowledgedControls: slot?.acknowledgedControls || snap?.controls || [{ ...car0Ctrl }],
        incidents: slot?.incidents || snap?.incidents || [],
        signals: slot?.signals || snap?.signals || [],
        audioEvents: slot?.audioEvents || snap?.audioEvents || [],
      };
    });
    mode.tasCursor = 0;
    mode.tasTargetFrame = Math.max(0, mode.tasFrames.length - 1);
    mode.tasScrubAccumulator = 0;
    mode._tasLastCountdownSecBeep = -1;

    applyTasFrameAtCursor(mode, false);
    r.simulationStage?.resetActionStates?.();

    useDevTestLabStore.getState().updateLiveTelemetry({
      tasState: 'stopped',
      tasRecordedFrames: mode.tasFrames.length,
      tasCursorFrame: 0,
      tasTargetFrame: Math.max(0, mode.tasFrames.length - 1),
      tasPrerollRemainingSec: 0,
    });
    return true;
  } catch (err) {
    console.error('[DevTestLabReplayHelper] Failed to import replay file:', err);
    return false;
  }
}

export function clearTasBufferSession(mode) {
  const r = mode.runtime;
  mode.tasFrames = [];
  mode.tasCursor = 0;
  mode.tasTargetFrame = 0;
  mode.tasScrubAccumulator = 0;
  mode._tasLastCountdownSecBeep = -1;
  r?.physics?.clearReplayBuffer?.();
  useDevTestLabStore.getState().updateLiveTelemetry({
    tasState: 'idle',
    tasRecordedFrames: 0,
    tasCursorFrame: 0,
    tasTargetFrame: 0,
    tasPrerollRemainingSec: 0,
  });
}

/**
 * Advances State Replay pre-roll countdown or scrubbing before each physics tick.
 * Returns false if live physics stepping should be suppressed on this tick, or true to step physics.
 */
export function stepTasBeforePhysicsTick(mode, store) {
  const r = mode.runtime;

  if (store.tasState === 'preroll-countdown') {
    const targetIdx = Math.max(
      0,
      Math.min(mode.tasFrames.length - 1, Math.round(mode.tasTargetFrame))
    );
    const nextCursor = Math.min(targetIdx, Math.round(mode.tasCursor) + 1);
    mode.tasCursor = nextCursor;
    applyTasFrameAtCursor(mode, true);

    const remFrames = Math.max(0, targetIdx - nextCursor);
    const downSec = store.tasDownCounterSec ?? 3;
    const maxBeepSec = downSec === 0 ? 1 : downSec;
    const audio = r?.options?.gameAudio || gameAudio;

    if (remFrames <= 0) {
      // Reached the release timestamp! Push state, reset action latches, play start sound, and release live user controls
      applyTasFrameAtCursor(mode, false);
      r.simulationStage?.resetActionStates?.();
      if (r.playerControls) {
        r.physics.setControls?.(r.playerCarIndex || 0, r.playerControls);
      }
      audio?.play?.('match_start_go', 1.0, 200);
      mode._tasLastCountdownSecBeep = -1;
      store.updateLiveTelemetry({
        tasState: 'stopped',
        tasCursorFrame: targetIdx,
        tasTargetFrame: targetIdx,
        tasPrerollRemainingSec: 0,
      });
      return false;
    }

    const countdownSec = Math.ceil(remFrames / 120);
    if (
      countdownSec >= 1 &&
      countdownSec <= maxBeepSec &&
      countdownSec !== mode._tasLastCountdownSecBeep
    ) {
      mode._tasLastCountdownSecBeep = countdownSec;
      audio?.play?.('training_countdown', 1.0, 200);
    }

    if (remFrames % 6 === 0 || remFrames % 120 === 0) {
      store.updateLiveTelemetry({
        tasCursorFrame: nextCursor,
        tasPrerollRemainingSec: Math.min(maxBeepSec, countdownSec),
      });
    }
    return false;
  }

  if (
    store.tasState === 'rewinding' ||
    store.tasState === 'forwarding' ||
    store.tasState === 'paused-scrub'
  ) {
    if (store.tasState === 'rewinding' || store.tasState === 'forwarding') {
      const stepPerTick = (store.tasEffectiveFlowPct || 100) / 100;
      mode.tasCursor =
        store.tasState === 'rewinding'
          ? Math.max(0, mode.tasCursor - stepPerTick)
          : Math.min(Math.max(0, mode.tasFrames.length - 1), mode.tasCursor + stepPerTick);
      mode.tasTargetFrame = Math.round(mode.tasCursor);
      applyTasFrameAtCursor(mode, false);
      store.updateLiveTelemetry({
        tasCursorFrame: mode.tasTargetFrame,
        tasTargetFrame: mode.tasTargetFrame,
      });
    }
    return false;
  }

  return true;
}
