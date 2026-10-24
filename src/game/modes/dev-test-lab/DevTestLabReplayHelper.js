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

export const MAX_REWINDER_FRAMES = 18000; // 150 seconds @ 120Hz

export async function exportStateReplayFile(rewinderFrames, options = {}) {
  if (!Array.isArray(rewinderFrames) || rewinderFrames.length === 0) return false;
  const normalizedFrames = [];
  const normalizedSlots = [];
  for (let i = 0; i < rewinderFrames.length; i++) {
    const item = rewinderFrames[i];
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
        mode.startRewinderRecording();
      }
      return;
    }

    if ((evt.code === 'KeyP' || evt.key === 'p' || evt.key === 'P') && noMods) {
      if (!evt.repeat) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        mode.stopRewinderRecording();
      }
      return;
    }

    if ((evt.code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && noMods) {
      if (!evt.repeat) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        mode.resumeRewinderFromCursor();
      }
      return;
    }

    if (evt.code === 'BracketLeft' || evt.key === '[') {
      evt.preventDefault();
      if (!evt.repeat) mode.beginRewinderScrub('rewinding');
      return;
    }

    if (evt.code === 'BracketRight' || evt.key === ']') {
      evt.preventDefault();
      if (!evt.repeat) mode.beginRewinderScrub('forwarding');
    }
  };

  mode._keyUpHandler = (evt) => {
    if (mode.runtime?.match?.state?.mode !== 'dev-test-lab') return;
    if (!doesRewinderWindowExist()) return;
    if (evt.code === 'BracketLeft' || evt.key === '[' || evt.code === 'BracketRight' || evt.key === ']') {
      evt.preventDefault();
      mode.pauseRewinderScrub();
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

export function applyRewinderFrameAtCursor(
  mode,
  smoothStep = false,
  restoreOptions = { preserveEngineTick: true }
) {
  const r = mode.runtime;
  if (!r?.physics || mode.rewinderFrames.length === 0) return;
  const idx = Math.max(0, Math.min(mode.rewinderFrames.length - 1, Math.floor(mode.rewinderCursor)));
  const entry = mode.rewinderFrames[idx];
  if (!entry) return;

  if (smoothStep && r.interpolator) {
    r.interpolator.prevState.set(r.interpolator.currState);
  }

  const compactSnap = entry.compactSnap || entry.renderState || entry.arenaSnap;
  if (compactSnap) {
    r.physics.restoreState(compactSnap, restoreOptions);
  }
  if (r.interpolator) {
    if (!smoothStep) {
      r.interpolator.prevState.set(r.physics.state);
      r.interpolator.alpha = 0;
    }
    r.interpolator.currState.set(r.physics.state);
  }
}

export function recordRewinderFrameAfterTick(mode, store) {
  const r = mode.runtime;
  if (store.rewinderState !== 'recording' || !r?.physics) return;
  if (mode.rewinderFrames.length < MAX_REWINDER_FRAMES) {
    const compactSnap = r.physics.saveCompactState();
    mode.rewinderFrames.push({
      compactSnap,
      renderState: compactSnap,
      controls: { ...r.playerControls },
    });
    r.physics.recordReplayFrame?.();
    mode.rewinderCursor = mode.rewinderFrames.length - 1;
    mode.rewinderTargetFrame = mode.rewinderCursor;
    if (mode.rewinderFrames.length % 6 === 0 || mode.rewinderFrames.length === 120 || mode.rewinderFrames.length === 240) {
      store.updateLiveTelemetry({
        rewinderRecordedFrames: mode.rewinderFrames.length,
        rewinderCursorFrame: mode.rewinderCursor,
        rewinderTargetFrame: mode.rewinderTargetFrame,
      });
    }
  } else {
    mode.stopRewinderRecording();
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

export function startRewinderRecordingSession(mode) {
  if (!ensureDevTestLabActive(mode, 'startRewinderRecordingSession')) return;
  const r = mode.runtime;
  if (!r?.physics) {
    console.warn('[DevTestLabReplayHelper] Cannot start recording: physics engine is not initialized.');
    return;
  }
  const store = useDevTestLabStore.getState();

  mode.rewinderFrames = [];
  mode.rewinderCursor = 0;
  mode.rewinderTargetFrame = 0;
  mode.rewinderScrubAccumulator = 0;
  mode._rewinderLastCountdownSecBeep = -1;
  r.physics.clearReplayBuffer?.();
  r.physics.clearEvents?.();
  r.physics.resetGoalLatch?.();
  r._clientGoalIncidentLatched = false;
  r.simulationStage?.resetActionStates?.();

  store.updateLiveTelemetry({
    rewinderState: 'recording',
    rewinderRecordedFrames: 0,
    rewinderCursorFrame: 0,
    rewinderTargetFrame: 0,
    rewinderPrerollRemainingSec: 0,
  });
}

export function pauseRewinderRecordingSession(mode) {
  if (!ensureDevTestLabActive(mode, 'pauseRewinderRecordingSession')) return;
  const store = useDevTestLabStore.getState();
  if (store.rewinderState === 'recording') {
    const lastFrame = Math.max(0, mode.rewinderFrames.length - 1);
    mode.rewinderCursor = lastFrame;
    mode.rewinderTargetFrame = lastFrame;
    store.updateLiveTelemetry({
      rewinderState: 'stopped',
      rewinderRecordedFrames: mode.rewinderFrames.length,
      rewinderCursorFrame: lastFrame,
      rewinderTargetFrame: lastFrame,
      rewinderPrerollRemainingSec: 0,
    });
  } else {
    console.warn(`[DevTestLabReplayHelper] Cannot stop recording: current state is "${store.rewinderState}".`);
  }
}

export function beginRewinderScrubSession(mode, direction = 'rewinding') {
  if (!ensureDevTestLabActive(mode, `beginRewinderScrubSession(${direction})`)) return;
  if (mode.rewinderFrames.length === 0) {
    console.warn(`[DevTestLabReplayHelper] Cannot start ${direction}: recorded frame buffer is empty (0 frames).`);
    return;
  }
  const store = useDevTestLabStore.getState();
  if (store.rewinderState === 'recording') {
    mode.rewinderCursor = mode.rewinderFrames.length - 1;
    mode.rewinderTargetFrame = mode.rewinderCursor;
  } else if (store.rewinderState === 'preroll-countdown') {
    mode.rewinderCursor = mode.rewinderTargetFrame;
  }
  mode.rewinderScrubAccumulator = 0;
  mode._rewinderLastCountdownSecBeep = -1;
  store.updateLiveTelemetry({
    rewinderState: direction,
    rewinderRecordedFrames: mode.rewinderFrames.length,
    rewinderCursorFrame: Math.round(mode.rewinderCursor),
    rewinderTargetFrame: Math.round(mode.rewinderCursor),
    rewinderPrerollRemainingSec: 0,
  });
}

export function pauseRewinderScrubSession(mode) {
  const store = useDevTestLabStore.getState();
  if (store.rewinderState === 'rewinding' || store.rewinderState === 'forwarding') {
    const clamped = Math.max(0, Math.min(mode.rewinderFrames.length - 1, Math.round(mode.rewinderCursor)));
    mode.rewinderCursor = clamped;
    mode.rewinderTargetFrame = clamped;
    store.updateLiveTelemetry({
      rewinderState: 'paused-scrub',
      rewinderCursorFrame: clamped,
      rewinderTargetFrame: clamped,
    });
  }
}

export function seekRewinderFrameToIndex(mode, frameIndex) {
  if (!ensureDevTestLabActive(mode, 'seekRewinderFrameToIndex')) return;
  if (!mode.rewinderFrames || mode.rewinderFrames.length === 0) {
    console.warn('[DevTestLabReplayHelper] Cannot seek frame: recorded frame buffer is empty (0 frames).');
    return;
  }
  const clamped = Math.max(0, Math.min(mode.rewinderFrames.length - 1, Math.round(frameIndex)));
  mode.rewinderCursor = clamped;
  mode.rewinderTargetFrame = clamped;
  mode.rewinderScrubAccumulator = 0;
  mode._rewinderLastCountdownSecBeep = -1;
  applyRewinderFrameAtCursor(mode, false);
  useDevTestLabStore.getState().updateLiveTelemetry({
    rewinderState: 'paused-scrub',
    rewinderCursorFrame: clamped,
    rewinderTargetFrame: clamped,
    rewinderPrerollRemainingSec: 0,
  });
}

export function resumeRewinderFromCursorSession(mode) {
  if (!ensureDevTestLabActive(mode, 'resumeRewinderFromCursorSession')) return;
  const r = mode.runtime;
  const store = useDevTestLabStore.getState();
  const downSec = store.rewinderDownCounterSec ?? 3;
  const minRequiredFrames = downSec === 0 ? 120 : 240;
  if (!r?.physics) {
    console.warn('[DevTestLabReplayHelper] Cannot resume from cursor: physics engine is not initialized.');
    return;
  }
  if (mode.rewinderFrames.length < minRequiredFrames) {
    console.warn(
      `[DevTestLabReplayHelper] Cannot resume from cursor: recorded frames (${mode.rewinderFrames.length}) < minimum required frames (${minRequiredFrames}) for downCounter=${downSec}s.`
    );
    return;
  }

  if (store.rewinderState === 'recording') {
    const lastFrame = Math.max(0, mode.rewinderFrames.length - 1);
    mode.rewinderCursor = lastFrame;
    mode.rewinderTargetFrame = lastFrame;
  }

  const baseTarget =
    store.rewinderState === 'preroll-countdown' || store.rewinderState === 'stopped'
      ? mode.rewinderTargetFrame || mode.rewinderCursor
      : mode.rewinderCursor;

  const targetIdx = Math.max(
    minRequiredFrames - 1,
    Math.min(mode.rewinderFrames.length - 1, Math.round(baseTarget))
  );
  const lookbackFrames = (downSec === 0 ? 1 : downSec + 1) * 120;
  const startIdx = Math.max(0, targetIdx - lookbackFrames);

  mode.rewinderTargetFrame = targetIdx;
  mode.rewinderCursor = startIdx;
  mode._rewinderLastCountdownSecBeep = -1;

  applyRewinderFrameAtCursor(mode, false);
  r.simulationStage?.resetActionStates?.();

  const remFrames = Math.max(0, targetIdx - startIdx);
  const remSec = Math.ceil(remFrames / 120);
  const audio = r?.options?.gameAudio || gameAudio;
  if (downSec === 0) {
    mode._rewinderLastCountdownSecBeep = 1;
    audio?.play?.('training_countdown', 1.0, 200);
  } else if (remSec >= 1 && remSec <= downSec) {
    mode._rewinderLastCountdownSecBeep = remSec;
    audio?.play?.('training_countdown', 1.0, 200);
  }

  store.updateLiveTelemetry({
    rewinderState: 'preroll-countdown',
    rewinderRecordedFrames: mode.rewinderFrames.length,
    rewinderCursorFrame: startIdx,
    rewinderTargetFrame: targetIdx,
    rewinderPrerollRemainingSec: downSec === 0 ? 1 : Math.min(downSec, remSec),
  });
}

export async function importRewinderReplayFile(mode, fileOrBuffer) {
  if (!ensureDevTestLabActive(mode, 'importRewinderReplayFile')) return false;
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
    mode.rewinderFrames = parsed.frames.map((snap, idx) => {
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
    mode.rewinderCursor = 0;
    mode.rewinderTargetFrame = Math.max(0, mode.rewinderFrames.length - 1);
    mode.rewinderScrubAccumulator = 0;
    mode._rewinderLastCountdownSecBeep = -1;

    applyRewinderFrameAtCursor(mode, false);
    r.simulationStage?.resetActionStates?.();

    useDevTestLabStore.getState().updateLiveTelemetry({
      rewinderState: 'stopped',
      rewinderRecordedFrames: mode.rewinderFrames.length,
      rewinderCursorFrame: 0,
      rewinderTargetFrame: Math.max(0, mode.rewinderFrames.length - 1),
      rewinderPrerollRemainingSec: 0,
    });
    return true;
  } catch (err) {
    console.error('[DevTestLabReplayHelper] Failed to import replay file:', err);
    return false;
  }
}

export function clearRewinderBufferSession(mode) {
  const r = mode.runtime;
  mode.rewinderFrames = [];
  mode.rewinderCursor = 0;
  mode.rewinderTargetFrame = 0;
  mode.rewinderScrubAccumulator = 0;
  mode._rewinderLastCountdownSecBeep = -1;
  r?.physics?.clearReplayBuffer?.();
  useDevTestLabStore.getState().updateLiveTelemetry({
    rewinderState: 'idle',
    rewinderRecordedFrames: 0,
    rewinderCursorFrame: 0,
    rewinderTargetFrame: 0,
    rewinderPrerollRemainingSec: 0,
  });
}

/**
 * Advances State Replay pre-roll countdown or scrubbing before each physics tick.
 * Returns false if live physics stepping should be suppressed on this tick, or true to step physics.
 */
export function stepRewinderBeforePhysicsTick(mode, store) {
  const r = mode.runtime;

  if (store.rewinderState === 'preroll-countdown') {
    const targetIdx = Math.max(
      0,
      Math.min(mode.rewinderFrames.length - 1, Math.round(mode.rewinderTargetFrame))
    );
    const nextCursor = Math.min(targetIdx, Math.round(mode.rewinderCursor) + 1);
    mode.rewinderCursor = nextCursor;
    applyRewinderFrameAtCursor(mode, true, { preserveEngineTick: true });

    const remFrames = Math.max(0, targetIdx - nextCursor);
    const downSec = store.rewinderDownCounterSec ?? 3;
    const maxBeepSec = downSec === 0 ? 1 : downSec;
    const audio = r?.options?.gameAudio || gameAudio;

    if (remFrames <= 0) {
      // Reached the release timestamp! Advance engine tick monotonically, reset action latches, play start sound, and release live user controls
      const prevEngineTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);
      const liveTick = Math.max(prevEngineTick + 16, targetIdx + 16);
      applyRewinderFrameAtCursor(mode, false, { overrideTick: liveTick });
      r.physics?.clearEvents?.();
      r.physics?.resetGoalLatch?.();
      r._clientGoalIncidentLatched = false;
      r.simulationStage?.resetActionStates?.();
      if (r.playerControls) {
        r.physics.setControls?.(r.playerCarIndex || 0, r.playerControls);
      }
      audio?.play?.('match_start_go', 1.0, 200);
      mode._rewinderLastCountdownSecBeep = -1;
      store.updateLiveTelemetry({
        rewinderState: 'stopped',
        rewinderCursorFrame: targetIdx,
        rewinderTargetFrame: targetIdx,
        rewinderPrerollRemainingSec: 0,
      });
      return false;
    }

    const countdownSec = Math.ceil(remFrames / 120);
    if (
      countdownSec >= 1 &&
      countdownSec <= maxBeepSec &&
      countdownSec !== mode._rewinderLastCountdownSecBeep
    ) {
      mode._rewinderLastCountdownSecBeep = countdownSec;
      audio?.play?.('training_countdown', 1.0, 200);
    }

    if (remFrames % 6 === 0 || remFrames % 120 === 0) {
      store.updateLiveTelemetry({
        rewinderCursorFrame: nextCursor,
        rewinderPrerollRemainingSec: Math.min(maxBeepSec, countdownSec),
      });
    }
    return false;
  }

  if (
    store.rewinderState === 'rewinding' ||
    store.rewinderState === 'forwarding' ||
    store.rewinderState === 'paused-scrub'
  ) {
    if (store.rewinderState === 'rewinding' || store.rewinderState === 'forwarding') {
      const stepPerTick = (store.rewinderEffectiveFlowPct || 100) / 100;
      mode.rewinderCursor =
        store.rewinderState === 'rewinding'
          ? Math.max(0, mode.rewinderCursor - stepPerTick)
          : Math.min(Math.max(0, mode.rewinderFrames.length - 1), mode.rewinderCursor + stepPerTick);
      mode.rewinderTargetFrame = Math.round(mode.rewinderCursor);
      applyRewinderFrameAtCursor(mode, false, { preserveEngineTick: true });
      store.updateLiveTelemetry({
        rewinderCursorFrame: mode.rewinderTargetFrame,
        rewinderTargetFrame: mode.rewinderTargetFrame,
      });
    }
    return false;
  }

  return true;
}
