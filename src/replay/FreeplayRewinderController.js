/**
 * FreeplayRewinderController.js
 * Drives the standalone Rewinder Configurator floating window ('rewinder-configurator') in Free Play.
 * Supports New Recording (O), Stop Rec (P), Hold Rewind ([), Hold Forward (]), timeline seek,
 * Import/Export (.rcreplay.gz), and Down Counter (default 0 -> -1s) Pre-Roll Resume (G)
 * with seamless handoff back to live Free Play (full audio, touch tracking, and Director Camera Goal Replay).
 */

import { useDevTestLabStore } from '../stores/devTestLabStore';
import { floatingStore } from '../stores/floatingStore';
import { useAppStore } from '../stores/appStore';
import { hudStore } from '../stores/hudStore';
import { SIM_OFFSETS, MAX_CARS, INCIDENT_EVENT_TYPES } from '../physics/RocketSimConstants.js';
import { parseRCReplayFile } from './ReplayFileExporter.js';
import { dispatchReplayFrameEvents } from './ReplayTimelineController.js';
import { exportStateReplayFile, MAX_TAS_FRAMES } from '../game/modes/dev-test-lab/DevTestLabReplayHelper.js';
import { DEFAULT_CAR_CONTROLS } from '../ai/experimental/ExperimentalBotAgent.js';
import { gameAudio } from '../audio/GameAudioEngineFacade.js';

export class FreeplayRewinderController {
  constructor(runtime, mode) {
    this.runtime = runtime;
    this.mode = mode;
    this.tasFrames = [];
    this.timelines = null;
    this.tasCursor = 0;
    this.tasTargetFrame = 0;
    this.tasScrubAccumulator = 0;
    this._tasLastCountdownSecBeep = -1;
    this._pendingFrameIncidents = [];
    this._keyDownHandler = null;
    this._keyUpHandler = null;
    this._unsubscribeFloating = null;
  }

  attach() {
    const store = useDevTestLabStore.getState();
    store.setRuntimeHandlers({
      ...store.runtimeHandlers,
      onTasStartRecording: () => this.startNewRecording(),
      onTasStopRecording: () => this.stopRecording(),
      onTasPushBackwardStart: () => this.beginScrub('rewinding'),
      onTasPushBackwardStop: () => this.pauseScrub(),
      onTasPushForwardStart: () => this.beginScrub('forwarding'),
      onTasPushForwardStop: () => this.pauseScrub(),
      onTasResumeFromHere: () => this.resumeFromCursor(),
      onTasClearBuffer: () => this.clearBuffer(),
      onTasCancelToFreeplay: () => this.clearBuffer(),
      onTasExportReplay: () => this.exportReplay(),
      onTasImportReplay: (file) => this.importReplay(file),
      onTasSeekFrame: (idx) => this.seekFrame(idx),
    });
    this._bindHotkeys();

    if (this._unsubscribeFloating) {
      this._unsubscribeFloating();
    }
    this._unsubscribeFloating = floatingStore.subscribe(() => {
      if (!this._doesRewinderWindowExist() && this.isBlockingLivePhysics) {
        this._returnToLivePlayFromScrub();
      }
    });
  }

  detach() {
    if (this._unsubscribeFloating) {
      this._unsubscribeFloating();
      this._unsubscribeFloating = null;
    }
  }

  _doesRewinderWindowExist() {
    return floatingStore
      .getSnapshot()
      .windows.some((w) => w.id === 'rewinder-configurator');
  }

  _ensureFreeplayMode(actionName) {
    const currentMode = this.runtime?.match?.state?.mode || 'freeplay';
    if (currentMode !== 'freeplay') {
      console.warn(
        `[FreeplayRewinderController] Cannot execute "${actionName}": active mode is "${currentMode}" (Rewinder Configurator requires "freeplay" or "dev-test-lab").`
      );
      return false;
    }
    return true;
  }

  get isBlockingLivePhysics() {
    const st = useDevTestLabStore.getState().tasState;
    return (
      st === 'rewinding' ||
      st === 'forwarding' ||
      st === 'paused-scrub' ||
      st === 'preroll-countdown'
    );
  }

  _bindHotkeys() {
    if (typeof window === 'undefined') return;
    this._unbindHotkeys();

    this._keyDownHandler = (evt) => {
      if (useAppStore.getState().isOpen) return;
      if (!this._doesRewinderWindowExist()) return;
      const tag = evt.target?.tagName?.toUpperCase?.() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const noMods = !evt.ctrlKey && !evt.shiftKey && !evt.altKey && !evt.metaKey;
      const isRecordKey = (evt.code === 'KeyO' || evt.key === 'o' || evt.key === 'O') && noMods;
      const isStopKey = (evt.code === 'KeyP' || evt.key === 'p' || evt.key === 'P') && noMods;
      const isResumeKey = (evt.code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && noMods;
      const isRewindKey = evt.code === 'BracketLeft' || evt.key === '[';
      const isForwardKey = evt.code === 'BracketRight' || evt.key === ']';

      if (!isRecordKey && !isStopKey && !isResumeKey && !isRewindKey && !isForwardKey) {
        return;
      }

      const currentMode = this.runtime?.match?.state?.mode || 'freeplay';
      if (currentMode === 'dev-test-lab') return;
      if (currentMode !== 'freeplay') {
        if (!evt.repeat) {
          console.warn(
            `[FreeplayRewinderController] Ignoring Rewinder hotkey "${evt.key}" because active mode "${currentMode}" does not support Rewinder Configurator (requires "freeplay" or "dev-test-lab").`
          );
        }
        return;
      }

      if (isRecordKey) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.startNewRecording();
        }
        return;
      }

      if (isStopKey) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.stopRecording();
        }
        return;
      }

      if (isResumeKey) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          this.resumeFromCursor();
        }
        return;
      }

      if (isRewindKey) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        if (!evt.repeat) this.beginScrub('rewinding');
        return;
      }

      if (isForwardKey) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        if (!evt.repeat) this.beginScrub('forwarding');
      }
    };

    this._keyUpHandler = (evt) => {
      if (this.runtime?.match?.state?.mode !== 'freeplay') return;
      if (!this._doesRewinderWindowExist()) return;
      if (
        evt.code === 'BracketLeft' ||
        evt.key === '[' ||
        evt.code === 'BracketRight' ||
        evt.key === ']'
      ) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
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

  _exitGoalOrReplayIfNeeded() {
    const r = this.runtime;
    const m = this.mode;
    if (!r || !m) return;

    if (m.isReplayActive || m.goalResetTicks > 0 || r.match?.state?.phase !== 'playing') {
      m.replayController?.endReplaySession?.();
      m.isReplayActive = false;
      m.goalResetTicks = 0;
      m.frozenGoalBallState = null;
      m.goalIncidentTick = -1;
      r.goalReplayCameraOverrideActive = false;
      if (r.match?.state) {
        r.match.state.phase = 'playing';
      }
      hudStore.getState().setReplayState({
        replayPaused: false,
        replayPersistent: false,
      });
      hudStore.getState().setMatchState({
        matchPhase: 'playing',
        replayScorerName: null,
        replayScorerTeam: null,
        replayBallSpeedKph: null,
        replayAssistName: null,
      });
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
      r.physics.addCar(team, 'octane');
    }
    r.arena?.syncCarsCount?.(numCars);
  }

  applyFrameAtCursor(smoothStep = false) {
    const r = this.runtime;
    if (!r?.physics || this.tasFrames.length === 0) return null;
    const idx = Math.max(0, Math.min(this.tasFrames.length - 1, Math.floor(this.tasCursor)));
    const entry = this.tasFrames[idx];
    if (!entry) return null;

    const compactSnap = entry.compactSnap || entry.renderState;
    if (!compactSnap) return null;

    this._syncArenaCarCountForFrame(compactSnap);

    if (smoothStep && r.interpolator) {
      r.interpolator.prevState.set(r.interpolator.currState);
    }

    r.physics.restoreState(compactSnap);

    if (r.interpolator) {
      if (!smoothStep) {
        r.interpolator.prevState.set(r.physics.state);
        r.interpolator.alpha = 0;
      }
      r.interpolator.currState.set(r.physics.state);
    }
    return entry;
  }

  _handoffToLiveFreeplay(targetIdx) {
    const r = this.runtime;
    const m = this.mode;
    if (!r?.physics) return;

    this._exitGoalOrReplayIfNeeded();
    const entry = this.applyFrameAtCursor(false);

    r.physics.clearEvents?.();
    r.physics.resetGoalLatch?.();
    r._clientGoalIncidentLatched = false;
    r.simulationStage?.resetActionStates?.();

    if (r.keyboard) {
      r.keyboard.ballControlEnabled = true;
    }
    if (r.playerControls) {
      r.physics.setControls?.(r.playerCarIndex || 0, r.playerControls);
    }

    if (m) {
      const sim = r.physics;
      const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
      const bView = sim.getBallStateView?.();
      m.goalIncidentTick = -1;
      m.goalResetTicks = 0;
      m.frozenGoalBallState = null;
      m.prevBallVelX = bView?.velX ?? 0;
      m.prevBallVelY = bView?.velY ?? 0;
      m.prevBallVelZ = bView?.velZ ?? 0;

      if (m.replayRingBuffer) {
        m.replayRingBuffer.clear();
        const maxHistory = Math.min(targetIdx + 1, m.replayRingBuffer.capacityTicks || 2400);
        const firstIdx = Math.max(0, targetIdx + 1 - maxHistory);
        const baseTick = currentTick - (targetIdx - firstIdx);
        let latestTouchTick = -1;

        for (let i = firstIdx; i <= targetIdx; i++) {
          const fEntry = this.tasFrames[i];
          const snap = fEntry?.compactSnap || fEntry?.renderState;
          if (!snap) continue;
          const syntheticTick = baseTick + (i - firstIdx);
          m.replayRingBuffer.recordFrame(syntheticTick, snap);
          if (Array.isArray(fEntry.incidents)) {
            for (const inc of fEntry.incidents) {
              m.replayRingBuffer.appendIncident(syntheticTick, {
                ...inc,
                tick: syntheticTick,
              });
              if (inc.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || inc.type === 0x01) {
                latestTouchTick = syntheticTick;
              }
            }
          }
          if (fEntry.hadTouch) {
            latestTouchTick = syntheticTick;
          }
        }

        m.lastKickoffStartTick = baseTick;
        m.lastTouchTick = latestTouchTick >= 0 ? latestTouchTick : (entry?.lastTouchTick ?? -1);
      }
    }
  }

  _returnToLivePlayFromScrub() {
    const idx = Math.max(0, Math.min(this.tasFrames.length - 1, Math.round(this.tasCursor)));
    this._handoffToLiveFreeplay(idx);
    useDevTestLabStore.getState().updateLiveTelemetry({
      tasState: this.tasFrames.length > 0 ? 'stopped' : 'idle',
      tasPrerollRemainingSec: 0,
    });
  }

  startNewRecording() {
    if (!this._ensureFreeplayMode('startNewRecording')) return;
    const r = this.runtime;
    if (!r?.physics) {
      console.warn('[FreeplayRewinderController] Cannot start recording: physics engine is not initialized.');
      return;
    }

    this._exitGoalOrReplayIfNeeded();
    if (this.isBlockingLivePhysics && this.tasFrames.length > 0) {
      this.applyFrameAtCursor(false);
    }

    r.physics.clearEvents?.();
    r.physics.resetGoalLatch?.();
    r._clientGoalIncidentLatched = false;
    r.simulationStage?.resetActionStates?.();
    if (r.keyboard) {
      r.keyboard.ballControlEnabled = true;
    }

    this.tasFrames = [];
    this.tasCursor = 0;
    this.tasTargetFrame = 0;
    this.tasScrubAccumulator = 0;
    this._tasLastCountdownSecBeep = -1;
    this._pendingFrameIncidents = [];
    r.physics.clearReplayBuffer?.();

    useDevTestLabStore.getState().updateLiveTelemetry({
      tasState: 'recording',
      tasRecordedFrames: 0,
      tasCursorFrame: 0,
      tasTargetFrame: 0,
      tasPrerollRemainingSec: 0,
    });
  }

  stopRecording() {
    if (!this._ensureFreeplayMode('stopRecording')) return;
    const store = useDevTestLabStore.getState();
    if (store.tasState === 'recording') {
      const lastFrame = Math.max(0, this.tasFrames.length - 1);
      this.tasCursor = lastFrame;
      this.tasTargetFrame = lastFrame;
      store.updateLiveTelemetry({
        tasState: 'stopped',
        tasRecordedFrames: this.tasFrames.length,
        tasCursorFrame: lastFrame,
        tasTargetFrame: lastFrame,
        tasPrerollRemainingSec: 0,
      });
    } else if (this.isBlockingLivePhysics) {
      this._returnToLivePlayFromScrub();
    } else {
      console.warn(`[FreeplayRewinderController] Cannot stop recording: current state is "${store.tasState}".`);
    }
  }

  beginScrub(direction = 'rewinding') {
    if (!this._ensureFreeplayMode(`beginScrub(${direction})`)) return;
    if (this.tasFrames.length === 0) {
      console.warn(`[FreeplayRewinderController] Cannot start ${direction}: recorded frame buffer is empty (0 frames).`);
      return;
    }
    this._exitGoalOrReplayIfNeeded();
    const store = useDevTestLabStore.getState();
    if (store.tasState === 'recording') {
      this.tasCursor = this.tasFrames.length - 1;
      this.tasTargetFrame = this.tasCursor;
    } else if (store.tasState === 'preroll-countdown') {
      this.tasCursor = this.tasTargetFrame;
    }
    if (this.runtime?.keyboard) {
      this.runtime.keyboard.ballControlEnabled = false;
    }
    this.tasScrubAccumulator = 0;
    this._tasLastCountdownSecBeep = -1;
    store.updateLiveTelemetry({
      tasState: direction,
      tasRecordedFrames: this.tasFrames.length,
      tasCursorFrame: Math.round(this.tasCursor),
      tasTargetFrame: Math.round(this.tasCursor),
      tasPrerollRemainingSec: 0,
    });
  }

  pauseScrub() {
    const store = useDevTestLabStore.getState();
    if (store.tasState === 'rewinding' || store.tasState === 'forwarding') {
      const clamped = Math.max(0, Math.min(this.tasFrames.length - 1, Math.round(this.tasCursor)));
      this.tasCursor = clamped;
      this.tasTargetFrame = clamped;
      this.applyFrameAtCursor(false);
      store.updateLiveTelemetry({
        tasState: 'paused-scrub',
        tasCursorFrame: clamped,
        tasTargetFrame: clamped,
      });
    }
  }

  seekFrame(frameIndex) {
    if (!this._ensureFreeplayMode('seekFrame')) return;
    if (!this.tasFrames || this.tasFrames.length === 0) {
      console.warn('[FreeplayRewinderController] Cannot seek frame: recorded frame buffer is empty (0 frames).');
      return;
    }
    this._exitGoalOrReplayIfNeeded();
    if (this.runtime?.keyboard) {
      this.runtime.keyboard.ballControlEnabled = false;
    }
    const clamped = Math.max(0, Math.min(this.tasFrames.length - 1, Math.round(frameIndex)));
    this.tasCursor = clamped;
    this.tasTargetFrame = clamped;
    this.tasScrubAccumulator = 0;
    this._tasLastCountdownSecBeep = -1;
    this.applyFrameAtCursor(false);
    useDevTestLabStore.getState().updateLiveTelemetry({
      tasState: 'paused-scrub',
      tasCursorFrame: clamped,
      tasTargetFrame: clamped,
      tasPrerollRemainingSec: 0,
    });
  }

  resumeFromCursor() {
    if (!this._ensureFreeplayMode('resumeFromCursor')) return;
    const r = this.runtime;
    const store = useDevTestLabStore.getState();
    const downSec = store.tasDownCounterSec ?? 0;
    const minRequiredFrames = downSec === 0 ? 120 : 240;
    if (!r?.physics) {
      console.warn('[FreeplayRewinderController] Cannot resume from cursor: physics engine is not initialized.');
      return;
    }
    if (this.tasFrames.length < minRequiredFrames) {
      console.warn(
        `[FreeplayRewinderController] Cannot resume from cursor: recorded frames (${this.tasFrames.length}) < minimum required frames (${minRequiredFrames}) for downCounter=${downSec}s.`
      );
      return;
    }

    this._exitGoalOrReplayIfNeeded();
    if (r.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }

    if (store.tasState === 'recording') {
      const lastFrame = Math.max(0, this.tasFrames.length - 1);
      this.tasCursor = lastFrame;
      this.tasTargetFrame = lastFrame;
    }

    const baseTarget =
      store.tasState === 'preroll-countdown' || store.tasState === 'stopped'
        ? this.tasTargetFrame || this.tasCursor
        : this.tasCursor;

    const targetIdx = Math.max(
      minRequiredFrames - 1,
      Math.min(this.tasFrames.length - 1, Math.round(baseTarget))
    );
    const lookbackFrames = (downSec === 0 ? 1 : downSec + 1) * 120;
    const startIdx = Math.max(0, targetIdx - lookbackFrames);

    this.tasTargetFrame = targetIdx;
    this.tasCursor = startIdx;
    this._tasLastCountdownSecBeep = -1;

    this.applyFrameAtCursor(false);
    r.simulationStage?.resetActionStates?.();

    const remFrames = Math.max(0, targetIdx - startIdx);
    const remSec = Math.ceil(remFrames / 120);
    const audio = r?.options?.gameAudio || gameAudio;
    if (downSec === 0) {
      this._tasLastCountdownSecBeep = 1;
      audio?.play?.('training_countdown', 1.0, 200);
    } else if (remSec >= 1 && remSec <= downSec) {
      this._tasLastCountdownSecBeep = remSec;
      audio?.play?.('training_countdown', 1.0, 200);
    }

    store.updateLiveTelemetry({
      tasState: 'preroll-countdown',
      tasRecordedFrames: this.tasFrames.length,
      tasCursorFrame: startIdx,
      tasTargetFrame: targetIdx,
      tasPrerollRemainingSec: downSec === 0 ? 1 : Math.min(downSec, remSec),
    });
  }

  async exportReplay() {
    if (!this.tasFrames || this.tasFrames.length === 0) {
      console.warn('[FreeplayRewinderController] Cannot export replay: recorded frame buffer is empty (0 frames).');
      return false;
    }
    return exportStateReplayFile(this.tasFrames);
  }

  async importReplay(fileOrBuffer) {
    if (!this._ensureFreeplayMode('importReplay')) return false;
    const r = this.runtime;
    if (!r?.physics) {
      console.warn('[FreeplayRewinderController] Cannot import replay: physics engine is not initialized.');
      return false;
    }
    try {
      const parsed = await parseRCReplayFile(fileOrBuffer);
      if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) {
        throw new Error('No valid frames found in replay file.');
      }
      this._exitGoalOrReplayIfNeeded();
      this.timelines = parsed.timelines || null;
      const stateInputTimeline = parsed.timelines?.stateInputTimeline || null;
      const incidentTimeline = parsed.timelines?.incidentTimeline || null;
      const signalTimeline = parsed.timelines?.signalTimeline || null;

      this.tasFrames = parsed.frames.map((snap, idx) => {
        const slot = stateInputTimeline?.getFrameAt?.(idx) || parsed.frameSlots?.[idx] || null;
        const ackControls = slot?.acknowledgedControls || slot?.controls || snap?.controls || [];
        const car0Ctrl =
          ackControls[0] ||
          r.neutralControls ||
          DEFAULT_CAR_CONTROLS;
        const frameIncidents =
          incidentTimeline?.getEventsAtFrame?.(idx) ||
          slot?.incidents ||
          snap?.incidents ||
          [];
        const frameSignals =
          signalTimeline?.getEventsAtFrame?.(idx) ||
          slot?.signals ||
          snap?.signals ||
          [];
        const frameAudioEvents = slot?.audioEvents || snap?.audioEvents || [];
        const hadTouch = frameIncidents.some(
          (inc) => inc?.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || inc?.type === 0x01
        );
        return {
          compactSnap: snap,
          renderState: snap,
          controls: { ...car0Ctrl },
          acknowledgedControls: ackControls,
          incidents: frameIncidents,
          signals: frameSignals,
          audioEvents: frameAudioEvents,
          hadTouch,
          lastTouchTick: hadTouch ? Math.floor(snap[0] || idx) : -1,
        };
      });
      this.tasCursor = 0;
      this.tasTargetFrame = Math.max(0, this.tasFrames.length - 1);
      this.tasScrubAccumulator = 0;
      this._tasLastCountdownSecBeep = -1;

      if (r.keyboard) {
        r.keyboard.ballControlEnabled = false;
      }
      this.applyFrameAtCursor(false);
      r.simulationStage?.resetActionStates?.();

      useDevTestLabStore.getState().updateLiveTelemetry({
        tasState: 'paused-scrub',
        tasRecordedFrames: this.tasFrames.length,
        tasCursorFrame: 0,
        tasTargetFrame: Math.max(0, this.tasFrames.length - 1),
        tasPrerollRemainingSec: 0,
      });
      return true;
    } catch (err) {
      console.error('[FreeplayRewinderController] Failed to import replay file:', err);
      return false;
    }
  }

  clearBuffer() {
    const r = this.runtime;
    if (this.isBlockingLivePhysics) {
      const idx = Math.max(0, Math.min(this.tasFrames.length - 1, Math.round(this.tasCursor)));
      this._handoffToLiveFreeplay(idx);
    }
    this.tasFrames = [];
    this.timelines = null;
    this.tasCursor = 0;
    this.tasTargetFrame = 0;
    this.tasScrubAccumulator = 0;
    this._tasLastCountdownSecBeep = -1;
    this._pendingFrameIncidents = [];
    r?.physics?.clearReplayBuffer?.();
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = true;
    }
    useDevTestLabStore.getState().updateLiveTelemetry({
      tasState: 'idle',
      tasRecordedFrames: 0,
      tasCursorFrame: 0,
      tasTargetFrame: 0,
      tasPrerollRemainingSec: 0,
    });
  }

  onResetKickoff() {
    const store = useDevTestLabStore.getState();
    if (this.isBlockingLivePhysics) {
      if (this.runtime?.keyboard) {
        this.runtime.keyboard.ballControlEnabled = true;
      }
      store.updateLiveTelemetry({
        tasState: this.tasFrames.length > 0 ? 'stopped' : 'idle',
        tasPrerollRemainingSec: 0,
      });
    }
  }

  onPhysicsEvent(event) {
    if (!event) return;
    const store = useDevTestLabStore.getState();
    if (store.tasState !== 'recording') return;
    this._pendingFrameIncidents.push({ ...event });
  }

  onBeforePhysicsTick() {
    const r = this.runtime;
    const store = useDevTestLabStore.getState();

    if (store.tasState === 'preroll-countdown') {
      const targetIdx = Math.max(
        0,
        Math.min(this.tasFrames.length - 1, Math.round(this.tasTargetFrame))
      );
      const nextCursor = Math.min(targetIdx, Math.round(this.tasCursor) + 1);
      this.tasCursor = nextCursor;
      const entry = this.applyFrameAtCursor(true);

      if (entry?.controls && r) {
        r.playerThrottle = entry.controls.throttle ?? 0;
        r.playerControls = { ...entry.controls };
      }
      if (
        (Array.isArray(entry?.incidents) && entry.incidents.length > 0) ||
        (Array.isArray(entry?.signals) && entry.signals.length > 0) ||
        (Array.isArray(entry?.audioEvents) && entry.audioEvents.length > 0)
      ) {
        dispatchReplayFrameEvents(
          {
            incidents: entry.incidents || [],
            signals: entry.signals || [],
            audioEvents: entry.audioEvents || [],
          },
          r
        );
      }

      const remFrames = Math.max(0, targetIdx - nextCursor);
      const downSec = store.tasDownCounterSec ?? 0;
      const maxBeepSec = downSec === 0 ? 1 : downSec;
      const audio = r?.options?.gameAudio || gameAudio;

      if (remFrames <= 0) {
        this._handoffToLiveFreeplay(targetIdx);
        audio?.play?.('match_start_go', 1.0, 200);
        this._tasLastCountdownSecBeep = -1;
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
        countdownSec !== this._tasLastCountdownSecBeep
      ) {
        this._tasLastCountdownSecBeep = countdownSec;
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
        this.tasCursor =
          store.tasState === 'rewinding'
            ? Math.max(0, this.tasCursor - stepPerTick)
            : Math.min(Math.max(0, this.tasFrames.length - 1), this.tasCursor + stepPerTick);
        this.tasTargetFrame = Math.round(this.tasCursor);
        this.applyFrameAtCursor(false);
        store.updateLiveTelemetry({
          tasCursorFrame: this.tasTargetFrame,
          tasTargetFrame: this.tasTargetFrame,
        });
      }
      return false;
    }

    return true;
  }

  onAfterPhysicsTick() {
    const r = this.runtime;
    const store = useDevTestLabStore.getState();
    if (store.tasState !== 'recording' || !r?.physics) {
      this._pendingFrameIncidents.length = 0;
      return;
    }

    if (this.tasFrames.length < MAX_TAS_FRAMES) {
      const compactSnap = r.physics.saveCompactState();
      const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount ?? 0);
      const hadTouch = Boolean(this.mode && this.mode.lastTouchTick === currentTick);
      const incidents =
        this._pendingFrameIncidents.length > 0 ? this._pendingFrameIncidents.slice() : [];
      this._pendingFrameIncidents.length = 0;

      this.tasFrames.push({
        compactSnap,
        renderState: compactSnap,
        controls: { ...(r.playerControls || DEFAULT_CAR_CONTROLS) },
        incidents,
        hadTouch,
        lastTouchTick: this.mode?.lastTouchTick ?? -1,
      });
      r.physics.recordReplayFrame?.();
      this.tasCursor = this.tasFrames.length - 1;
      this.tasTargetFrame = this.tasCursor;

      if (this.tasFrames.length % 6 === 0 || this.tasFrames.length === 120 || this.tasFrames.length === 240) {
        store.updateLiveTelemetry({
          tasRecordedFrames: this.tasFrames.length,
          tasCursorFrame: this.tasCursor,
          tasTargetFrame: this.tasTargetFrame,
        });
      }
    } else {
      this._pendingFrameIncidents.length = 0;
      this.stopRecording();
    }
  }
}
