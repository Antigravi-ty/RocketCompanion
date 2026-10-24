/**
 * StandaloneReplayViewerController.js
 * Drives the standalone Replay Viewer floating window (accessible from Self-Training -> Replay Viewer).
 * Supports uploading compressed/uncompressed .rcreplay.gz / .rcreplay / .json files, loading the retained
 * last match replay buffer, Play (O) / Pause (P), Hold Rewind ([) / Hold Forward (]), timeline seek,
 * and Preroll Countdown + Resume From Here (G).
 */

import { SIM_OFFSETS, MAX_CARS } from '../physics/RocketSimConstants.js';
import { getRetainedMatchReplay, parseRCReplayFile } from './ReplayFileExporter.js';
import { dispatchReplayFrameEvents } from './ReplayTimelineController.js';
import { useReplayViewerStore } from '../stores/replayViewerStore';
import { floatingStore } from '../stores/floatingStore';
import { useAppStore } from '../stores/appStore';
import { hudStore } from '../stores/hudStore';
import { gameAudio } from '../audio/GameAudioEngineFacade.js';

export class StandaloneReplayViewerController {
  constructor(runtime) {
    this.runtime = runtime;
    this.frames = [];
    this.frameSlots = [];
    this.timelines = null;
    this.stateInputTimeline = null;
    this.incidentTimeline = null;
    this.signalTimeline = null;
    this.metadata = null;
    this.cursor = 0;
    this.targetFrame = 0;
    this._lastCountdownSecBeep = -1;
    this._lastDispatchedCursorFrame = -1;
    this._keyDownHandler = null;
    this._keyUpHandler = null;
  }

  attach() {
    useReplayViewerStore.getState().setRuntimeHandlers({
      onUploadReplayFile: (file) => this.handleUploadFile(file),
      onLoadRetainedMatchReplay: () => this.handleLoadRetainedMatchReplay(),
      onStartPlaying: () => this.startPlaying(),
      onPausePlaying: () => this.pausePlaying(),
      onSeekFrame: (frameIndex) => this.seekFrame(frameIndex),
      onPushBackwardStart: () => this.beginScrub('rewinding'),
      onPushBackwardStop: () => this.pauseScrub(),
      onPushForwardStart: () => this.beginScrub('forwarding'),
      onPushForwardStop: () => this.pauseScrub(),
      onResumeFromHere: () => this.resumeFromCursor(),
      onClearReplay: () => this.clearReplay(),
    });
    this._bindHotkeys();
  }

  detach() {
    this._unbindHotkeys();
  }

  get isActive() {
    const state = useReplayViewerStore.getState().viewerState;
    return state !== 'idle' && this.frames.length > 0;
  }

  _isViewerWindowOpen() {
    const snap = floatingStore.getSnapshot();
    const viewerWin = snap.windows.find((w) => w.id === 'replay-viewer-window' && !w.isMinimized);
    if (!viewerWin) return false;
    const hasRewinder = snap.windows.some((w) => w.id === 'rewinder-configurator');
    if (hasRewinder && this.frames.length === 0) return false;
    return true;
  }

  _bindHotkeys() {
    if (typeof window === 'undefined') return;
    this._unbindHotkeys();

    this._keyDownHandler = (evt) => {
      if (this.runtime?.match?.state?.mode !== 'freeplay') return;
      if (useAppStore.getState().isOpen) return;
      if (!this._isViewerWindowOpen()) return;
      const tag = evt.target?.tagName?.toUpperCase?.() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const noMods = !evt.ctrlKey && !evt.shiftKey && !evt.altKey && !evt.metaKey;
      if ((evt.code === 'KeyO' || evt.key === 'o' || evt.key === 'O') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.startPlaying();
        }
        return;
      }

      if ((evt.code === 'KeyP' || evt.key === 'p' || evt.key === 'P') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.pausePlaying();
        }
        return;
      }

      if ((evt.code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.resumeFromCursor();
        }
        return;
      }

      if (evt.code === 'BracketLeft' || evt.key === '[') {
        evt.preventDefault();
        if (!evt.repeat) this.beginScrub('rewinding');
        return;
      }

      if (evt.code === 'BracketRight' || evt.key === ']') {
        evt.preventDefault();
        if (!evt.repeat) this.beginScrub('forwarding');
      }
    };

    this._keyUpHandler = (evt) => {
      if (this.runtime?.match?.state?.mode !== 'freeplay') return;
      if (!this._isViewerWindowOpen()) return;
      if (
        evt.code === 'BracketLeft' ||
        evt.key === '[' ||
        evt.code === 'BracketRight' ||
        evt.key === ']'
      ) {
        evt.preventDefault();
        this.pauseScrub();
      }
    };

    window.addEventListener('keydown', this._keyDownHandler, true);
    window.addEventListener('keyup', this._keyUpHandler, true);
  }

  _unbindHotkeys() {
    if (typeof window === 'undefined') return;
    if (this._keyDownHandler) {
      window.removeEventListener('keydown', this._keyDownHandler, true);
      this._keyDownHandler = null;
    }
    if (this._keyUpHandler) {
      window.removeEventListener('keyup', this._keyUpHandler, true);
      this._keyUpHandler = null;
    }
  }

  _syncArenaCarCountForFrame(frame) {
    const r = this.runtime;
    if (!r?.physics || !frame) return;
    const rawNum = Math.round(frame[SIM_OFFSETS.NUM_CARS] || 1);
    const numCars = Math.max(1, Math.min(MAX_CARS, rawNum));

    while (r.physics.numCars > numCars && typeof r.physics.removeCar === 'function') {
      r.physics.removeCar(r.physics.numCars - 1);
    }
    while (r.physics.numCars < numCars && typeof r.physics.addCar === 'function') {
      const idx = r.physics.numCars;
      const team = idx % 2;
      r.physics.addCar(team, 'default');
    }
    r.arena?.syncCarsCount?.(numCars);
  }

  _bindTimelines(timelines, metadata = null) {
    this.timelines = timelines || null;
    this.stateInputTimeline = timelines?.stateInputTimeline || timelines?.stateInput || null;
    this.incidentTimeline = timelines?.incidentTimeline || null;
    this.signalTimeline = timelines?.signalTimeline || null;
    this.metadata = metadata || null;
  }

  _buildTimelineStorePatch() {
    const stateTrackCount = this.stateInputTimeline?.count ?? this.frames.length;
    const incidentTrackCount =
      this.incidentTimeline?.count ??
      (Array.isArray(this.timelines?.incidents) ? this.timelines.incidents.length : 0);
    const recordedSignalCount =
      this.signalTimeline?.recordedCount ??
      (Array.isArray(this.timelines?.recordedSignals) ? this.timelines.recordedSignals.length : 0);
    const synthesizedSignalCount =
      this.signalTimeline?.synthesizedCount ??
      (Array.isArray(this.timelines?.synthesizedSignals)
        ? this.timelines.synthesizedSignals.length
        : 0);
    const signalTrackCount =
      this.signalTimeline?.count ??
      (Array.isArray(this.timelines?.signals) ? this.timelines.signals.length : 0);
    const incidentMarkers = this.incidentTimeline?.getTimelineMarkers?.(160) || [];
    const signalMarkers = this.signalTimeline?.getTimelineMarkers?.(120) || [];

    return {
      stateTrackCount,
      incidentTrackCount,
      signalTrackCount,
      recordedSignalCount,
      synthesizedSignalCount,
      incidentMarkers,
      signalMarkers,
    };
  }

  _applyFrameAtCursor(smoothStep = false, dispatchEvents = false) {
    const r = this.runtime;
    if (!r?.physics || this.frames.length === 0) return;
    const idx = Math.max(0, Math.min(this.frames.length - 1, Math.floor(this.cursor)));

    // 1. Track A (State + Input Timeline)
    const slot =
      this.stateInputTimeline?.getFrameAt?.(idx) ||
      this.frameSlots?.[idx] ||
      null;
    const snap = slot?.snapshot || this.frames[idx];
    if (!snap) return;

    this._syncArenaCarCountForFrame(snap);

    if (smoothStep && r.interpolator) {
      r.interpolator.prevState.set(r.interpolator.currState);
    }

    r.physics.restoreState(snap);

    const controls =
      slot?.acknowledgedControls ||
      slot?.controls ||
      this.stateInputTimeline?.getControlsAt?.(idx) ||
      snap?.controls;
    if (Array.isArray(controls) && typeof r.physics.setControls === 'function') {
      for (let c = 0; c < Math.min(controls.length, r.physics.numCars || MAX_CARS); c++) {
        if (controls[c]) {
          r.physics.setControls(c, controls[c]);
        }
      }
    }

    if (r.interpolator) {
      if (!smoothStep) {
        r.interpolator.prevState.set(r.physics.state);
        r.interpolator.alpha = 0;
      }
      r.interpolator.currState.set(r.physics.state);
    }

    // 2. Track B (Incident Timeline) & Track C (Signal Timeline)
    if (dispatchEvents) {
      if (idx > this._lastDispatchedCursorFrame) {
        const startIdx = Math.max(0, this._lastDispatchedCursorFrame + 1, idx - 8);
        let incidents = [];
        let signals = [];
        const audioEvents = [];

        if (this.incidentTimeline) {
          incidents = this.incidentTimeline.getEventsInFrameRange(startIdx, idx);
        } else {
          for (let f = startIdx; f <= idx; f++) {
            const fSlot = this.frameSlots?.[f] || this.frames?.[f];
            if (Array.isArray(fSlot?.incidents) && fSlot.incidents.length > 0) {
              incidents.push(...fSlot.incidents);
            }
          }
        }

        if (this.signalTimeline) {
          signals = this.signalTimeline.getEventsInFrameRange(startIdx, idx);
        } else {
          for (let f = startIdx; f <= idx; f++) {
            const fSlot = this.frameSlots?.[f] || this.frames?.[f];
            if (Array.isArray(fSlot?.signals) && fSlot.signals.length > 0) {
              signals.push(...fSlot.signals);
            }
            if (Array.isArray(fSlot?.audioEvents) && fSlot.audioEvents.length > 0) {
              audioEvents.push(...fSlot.audioEvents);
            }
          }
        }

        if (incidents.length > 0 || signals.length > 0 || audioEvents.length > 0) {
          dispatchReplayFrameEvents(
            {
              incidents,
              signals,
              audioEvents,
              syncHudFromSignals: true,
            },
            r
          );
        }
      }
      this._lastDispatchedCursorFrame = idx;
    } else {
      if (this.signalTimeline) {
        const evalState = this.signalTimeline.evaluateMatchStateAtFrame(idx, this.metadata || {});
        const hudPatch = {
          blueScore: evalState.blueScore,
          orangeScore: evalState.orangeScore,
        };
        if (evalState.remainingSeconds !== null) {
          hudPatch.remainingSeconds = evalState.remainingSeconds;
          hudPatch.isOvertime = evalState.isOvertime;
        }
        hudStore.getState().setMatchState(hudPatch);
      }
      this._lastDispatchedCursorFrame = idx;
    }
  }

  async handleUploadFile(file) {
    const store = useReplayViewerStore.getState();
    store.setErrorMessage(null);
    try {
      const result = await parseRCReplayFile(file);
      if (!result.frames || result.frames.length === 0) {
        throw new Error('Replay file contains 0 frames.');
      }
      this.frames = result.frames;
      this.frameSlots = result.frameSlots || [];
      this._bindTimelines(result.timelines, result.metadata);
      this.cursor = 0;
      this.targetFrame = Math.max(0, result.frames.length - 1);
      this._lastDispatchedCursorFrame = -1;
      this._applyFrameAtCursor(false, false);

      store.updateLiveTelemetry({
        viewerState: 'paused',
        loadedFileName: file.name,
        totalFrames: this.frames.length,
        cursorFrame: 0,
        targetFrame: this.targetFrame,
        prerollRemainingSec: 0,
        errorMessage: null,
        ...this._buildTimelineStorePatch(),
      });
    } catch (err) {
      console.error('[StandaloneReplayViewerController] Failed to parse uploaded replay file:', err);
      store.setErrorMessage(err?.message || 'Failed to parse replay file.');
    }
  }

  handleLoadRetainedMatchReplay() {
    const retained = getRetainedMatchReplay();
    const store = useReplayViewerStore.getState();
    if (!retained || !retained.frames || retained.frames.length === 0) {
      console.warn('[StandaloneReplayViewerController] Cannot load retained match replay: no recent match replay in memory.');
      store.setErrorMessage('No recent match replay in memory.');
      return;
    }
    this.frames = retained.frames.map((f) => {
      const clone = new Float32Array(f);
      if (f.tick !== undefined) clone.tick = f.tick;
      if (f.controls !== undefined) clone.controls = f.controls;
      if (f.incidents !== undefined) clone.incidents = f.incidents;
      if (f.signals !== undefined) clone.signals = f.signals;
      if (f.audioEvents !== undefined) clone.audioEvents = f.audioEvents;
      return clone;
    });
    this.frameSlots = Array.isArray(retained.frameSlots) ? retained.frameSlots : [];
    this._bindTimelines(retained.timelines, {
      mode: retained.mode,
      winner: retained.winner,
      blueScore: retained.blueScore,
      orangeScore: retained.orangeScore,
      winReason: retained.winReason,
    });
    this.cursor = 0;
    this.targetFrame = Math.max(0, this.frames.length - 1);
    this._lastDispatchedCursorFrame = -1;
    this._applyFrameAtCursor(false, false);

    store.updateLiveTelemetry({
      viewerState: 'paused',
      loadedFileName: `Last Match (${retained.blueScore}–${retained.orangeScore})`,
      totalFrames: this.frames.length,
      cursorFrame: 0,
      targetFrame: this.targetFrame,
      prerollRemainingSec: 0,
      errorMessage: null,
      ...this._buildTimelineStorePatch(),
    });
  }

  startPlaying() {
    if (this.frames.length === 0) {
      console.warn('[StandaloneReplayViewerController] Cannot start playing: no replay frames loaded.');
      return;
    }
    if (this.cursor >= this.frames.length - 1) {
      this.cursor = 0;
      this._lastDispatchedCursorFrame = -1;
    }
    this.targetFrame = Math.round(this.cursor);
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'playing',
      cursorFrame: Math.round(this.cursor),
      targetFrame: Math.round(this.cursor),
      prerollRemainingSec: 0,
    });
  }

  pausePlaying() {
    if (this.frames.length === 0) {
      console.warn('[StandaloneReplayViewerController] Cannot pause playing: no replay frames loaded.');
      return;
    }
    const clamped = Math.max(0, Math.min(this.frames.length - 1, Math.round(this.cursor)));
    this.cursor = clamped;
    this.targetFrame = clamped;
    this._applyFrameAtCursor(false, false);
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'paused',
      cursorFrame: clamped,
      targetFrame: clamped,
      prerollRemainingSec: 0,
    });
  }

  seekFrame(frameIndex) {
    if (this.frames.length === 0) {
      console.warn('[StandaloneReplayViewerController] Cannot seek frame: no replay frames loaded.');
      return;
    }
    const clamped = Math.max(0, Math.min(this.frames.length - 1, Math.round(frameIndex)));
    this.cursor = clamped;
    this.targetFrame = clamped;
    this._applyFrameAtCursor(false, false);
    const curState = useReplayViewerStore.getState().viewerState;
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: curState === 'playing' ? 'playing' : 'paused',
      cursorFrame: clamped,
      targetFrame: clamped,
    });
  }

  beginScrub(direction = 'rewinding') {
    if (this.frames.length === 0) {
      console.warn(`[StandaloneReplayViewerController] Cannot start ${direction}: no replay frames loaded.`);
      return;
    }
    this._lastCountdownSecBeep = -1;
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: direction,
      cursorFrame: Math.round(this.cursor),
      targetFrame: Math.round(this.cursor),
      prerollRemainingSec: 0,
    });
  }

  pauseScrub() {
    const store = useReplayViewerStore.getState();
    if (store.viewerState === 'rewinding' || store.viewerState === 'forwarding') {
      this.pausePlaying();
    }
  }

  resumeFromCursor() {
    const r = this.runtime;
    const store = useReplayViewerStore.getState();
    const downSec = store.downCounterSec ?? 3;
    const minRequiredFrames = downSec === 0 ? 120 : 240;
    if (!r?.physics) {
      console.warn('[StandaloneReplayViewerController] Cannot resume from cursor: physics engine is not initialized.');
      return;
    }
    if (this.frames.length < minRequiredFrames) {
      console.warn(
        `[StandaloneReplayViewerController] Cannot resume from cursor: loaded frames (${this.frames.length}) < minimum required frames (${minRequiredFrames}) for downCounter=${downSec}s.`
      );
      return;
    }

    const baseTarget = Math.max(minRequiredFrames - 1, Math.min(this.frames.length - 1, Math.round(this.cursor)));
    const lookbackFrames = (downSec === 0 ? 1 : downSec + 1) * 120;
    const startIdx = Math.max(0, baseTarget - lookbackFrames);

    this.targetFrame = baseTarget;
    this.cursor = startIdx;
    this._lastCountdownSecBeep = -1;
    this._lastDispatchedCursorFrame = startIdx;

    this._applyFrameAtCursor(false, false);
    r.simulationStage?.resetActionStates?.();

    const remFrames = Math.max(0, baseTarget - startIdx);
    const remSec = Math.ceil(remFrames / 120);
    const maxBeepSec = downSec === 0 ? 1 : downSec;
    if (remSec >= 1 && remSec <= maxBeepSec) {
      this._lastCountdownSecBeep = remSec;
      const audio = r?.options?.gameAudio || gameAudio;
      audio?.play?.('training_countdown', 1.0, 200);
    }

    store.updateLiveTelemetry({
      viewerState: 'preroll-countdown',
      cursorFrame: startIdx,
      targetFrame: baseTarget,
      prerollRemainingSec: Math.min(maxBeepSec, remSec),
    });
  }

  clearReplay() {
    this.frames = [];
    this.frameSlots = [];
    this._bindTimelines(null, null);
    this.cursor = 0;
    this.targetFrame = 0;
    this._lastCountdownSecBeep = -1;
    this._lastDispatchedCursorFrame = -1;
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'idle',
      loadedFileName: null,
      totalFrames: 0,
      cursorFrame: 0,
      targetFrame: 0,
      stateTrackCount: 0,
      incidentTrackCount: 0,
      signalTrackCount: 0,
      recordedSignalCount: 0,
      synthesizedSignalCount: 0,
      incidentMarkers: [],
      signalMarkers: [],
      prerollRemainingSec: 0,
      errorMessage: null,
    });
  }

  onBeforePhysicsTick() {
    const r = this.runtime;
    const store = useReplayViewerStore.getState();
    const state = store.viewerState;
    if (state === 'idle' || this.frames.length === 0) return true;

    if (state === 'preroll-countdown') {
      const targetIdx = Math.max(
        0,
        Math.min(this.frames.length - 1, Math.round(this.targetFrame))
      );
      const nextCursor = Math.min(targetIdx, Math.round(this.cursor) + 1);
      this.cursor = nextCursor;
      this._applyFrameAtCursor(true, true);

      const remFrames = Math.max(0, targetIdx - nextCursor);
      const downSec = store.downCounterSec ?? 3;
      const maxBeepSec = downSec === 0 ? 1 : downSec;
      const audio = r?.options?.gameAudio || gameAudio;

      if (remFrames <= 0) {
        this._applyFrameAtCursor(false, false);
        r.simulationStage?.resetActionStates?.();
        if (r.playerControls) {
          r.physics.setControls?.(r.playerCarIndex || 0, r.playerControls);
        }
        audio?.play?.('match_start_go', 1.0, 200);
        this._lastCountdownSecBeep = -1;
        store.updateLiveTelemetry({
          viewerState: 'idle',
          cursorFrame: targetIdx,
          targetFrame: targetIdx,
          prerollRemainingSec: 0,
        });
        return false;
      }

      const countdownSec = Math.ceil(remFrames / 120);
      if (
        countdownSec >= 1 &&
        countdownSec <= maxBeepSec &&
        countdownSec !== this._lastCountdownSecBeep
      ) {
        this._lastCountdownSecBeep = countdownSec;
        audio?.play?.('training_countdown', 1.0, 200);
      }

      if (remFrames % 6 === 0 || remFrames % 120 === 0) {
        store.updateLiveTelemetry({
          cursorFrame: nextCursor,
          prerollRemainingSec: Math.min(maxBeepSec, countdownSec),
        });
      }
      return false;
    }

    if (state === 'playing' || state === 'forwarding' || state === 'rewinding') {
      const stepPerTick = (store.effectiveFlowPct || 100) / 100;
      if (state === 'rewinding') {
        this.cursor = Math.max(0, this.cursor - stepPerTick);
      } else {
        this.cursor = Math.min(Math.max(0, this.frames.length - 1), this.cursor + stepPerTick);
      }
      const rounded = Math.round(this.cursor);
      this.targetFrame = rounded;
      this._applyFrameAtCursor(state === 'playing', state === 'playing' || state === 'forwarding');

      if (state === 'playing' && rounded >= this.frames.length - 1) {
        store.updateLiveTelemetry({
          viewerState: 'paused',
          cursorFrame: rounded,
          targetFrame: rounded,
        });
      } else if (rounded % 4 === 0) {
        store.updateLiveTelemetry({
          cursorFrame: rounded,
          targetFrame: rounded,
        });
      }
      return false;
    }

    if (state === 'paused') {
      return false;
    }

    return true;
  }
}
