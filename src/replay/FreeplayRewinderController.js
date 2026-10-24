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
import { exportStateReplayFile, MAX_REWINDER_FRAMES } from '../game/modes/dev-test-lab/DevTestLabReplayHelper.js';
import { DEFAULT_CAR_CONTROLS } from '../ai/experimental/ExperimentalBotAgent.js';
import { gameAudio } from '../audio/GameAudioEngineFacade.js';

export class FreeplayRewinderController {
  constructor(runtime, mode) {
    this.runtime = runtime;
    this.mode = mode;
    this.rewinderFrames = [];
    this.timelines = null;
    this.rewinderCursor = 0;
    this.rewinderTargetFrame = 0;
    this.rewinderScrubAccumulator = 0;
    this._rewinderLastCountdownSecBeep = -1;
    this._pendingFrameIncidents = [];
    this._keyDownHandler = null;
    this._keyUpHandler = null;
    this._unsubscribeFloating = null;
  }

  attach() {
    const store = useDevTestLabStore.getState();
    store.setRuntimeHandlers({
      ...store.runtimeHandlers,
      onRewinderStartRecording: () => this.startNewRecording(),
      onRewinderStopRecording: () => this.stopRecording(),
      onRewinderPushBackwardStart: () => this.beginScrub('rewinding'),
      onRewinderPushBackwardStop: () => this.pauseScrub(),
      onRewinderPushForwardStart: () => this.beginScrub('forwarding'),
      onRewinderPushForwardStop: () => this.pauseScrub(),
      onRewinderResumeFromHere: () => this.resumeFromCursor(),
      onRewinderClearBuffer: () => this.clearBuffer(),
      onRewinderCancelToFreeplay: () => this.clearBuffer(),
      onRewinderExportReplay: () => this.exportReplay(),
      onRewinderImportReplay: (file) => this.importReplay(file),
      onRewinderSeekFrame: (idx) => this.seekFrame(idx),
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
    const st = useDevTestLabStore.getState().rewinderState;
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

  applyFrameAtCursor(smoothStep = false, restoreOptions = { preserveEngineTick: true }) {
    const r = this.runtime;
    if (!r?.physics || this.rewinderFrames.length === 0) return null;
    const idx = Math.max(0, Math.min(this.rewinderFrames.length - 1, Math.floor(this.rewinderCursor)));
    const entry = this.rewinderFrames[idx];
    if (!entry) return null;

    const compactSnap = entry.compactSnap || entry.renderState;
    if (!compactSnap) return null;

    this._syncArenaCarCountForFrame(compactSnap);

    if (smoothStep && r.interpolator) {
      r.interpolator.prevState.set(r.interpolator.currState);
    }

    r.physics.restoreState(compactSnap, restoreOptions);

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

    const sim = r.physics;
    const maxHistory = Math.min(targetIdx + 1, m?.replayRingBuffer?.capacityTicks || 2400);
    const firstIdx = Math.max(0, targetIdx + 1 - maxHistory);
    const historySpan = Math.max(0, targetIdx - firstIdx);
    const prevEngineTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const liveTick = Math.max(prevEngineTick + 16, historySpan + 16);

    const entry = this.applyFrameAtCursor(false, { overrideTick: liveTick });

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
      const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? liveTick);
      const bView = sim.getBallStateView?.();
      m.goalIncidentTick = -1;
      m.goalResetTicks = 0;
      m.frozenGoalBallState = null;
      m.prevBallVelX = bView?.velX ?? 0;
      m.prevBallVelY = bView?.velY ?? 0;
      m.prevBallVelZ = bView?.velZ ?? 0;

      if (m.replayRingBuffer) {
        m.replayRingBuffer.clear();
        const baseTick = currentTick - historySpan;
        let latestTouchTick = -1;

        for (let i = firstIdx; i <= targetIdx; i++) {
          const fEntry = this.rewinderFrames[i];
          const snap = fEntry?.compactSnap || fEntry?.renderState;
          if (!snap) continue;
          const syntheticTick = baseTick + (i - firstIdx);
          const recordedSlot = m.replayRingBuffer.recordFrame(syntheticTick, snap, {
            acknowledgedControls: fEntry.acknowledgedControls || (fEntry.controls ? [{ carIndex: r.playerCarIndex ?? 0, controls: { ...fEntry.controls } }] : []),
          });
          if (recordedSlot?.snapshot) {
            recordedSlot.snapshot[SIM_OFFSETS.TICK] = syntheticTick;
          }
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
    const idx = Math.max(0, Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor)));
    this._handoffToLiveFreeplay(idx);
    useDevTestLabStore.getState().updateLiveTelemetry({
      rewinderState: this.rewinderFrames.length > 0 ? 'stopped' : 'idle',
      rewinderPrerollRemainingSec: 0,
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
    if (this.isBlockingLivePhysics && this.rewinderFrames.length > 0) {
      const idx = Math.max(0, Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor)));
      this._handoffToLiveFreeplay(idx);
    }

    r.physics.clearEvents?.();
    r.physics.resetGoalLatch?.();
    r._clientGoalIncidentLatched = false;
    r.simulationStage?.resetActionStates?.();
    if (r.keyboard) {
      r.keyboard.ballControlEnabled = true;
    }

    this.rewinderFrames = [];
    this.rewinderCursor = 0;
    this.rewinderTargetFrame = 0;
    this.rewinderScrubAccumulator = 0;
    this._rewinderLastCountdownSecBeep = -1;
    this._pendingFrameIncidents = [];
    r.physics.clearReplayBuffer?.();

    useDevTestLabStore.getState().updateLiveTelemetry({
      rewinderState: 'recording',
      rewinderRecordedFrames: 0,
      rewinderCursorFrame: 0,
      rewinderTargetFrame: 0,
      rewinderPrerollRemainingSec: 0,
    });
  }

  stopRecording() {
    if (!this._ensureFreeplayMode('stopRecording')) return;
    const store = useDevTestLabStore.getState();
    if (store.rewinderState === 'recording') {
      const lastFrame = Math.max(0, this.rewinderFrames.length - 1);
      this.rewinderCursor = lastFrame;
      this.rewinderTargetFrame = lastFrame;
      store.updateLiveTelemetry({
        rewinderState: 'stopped',
        rewinderRecordedFrames: this.rewinderFrames.length,
        rewinderCursorFrame: lastFrame,
        rewinderTargetFrame: lastFrame,
        rewinderPrerollRemainingSec: 0,
      });
    } else if (this.isBlockingLivePhysics) {
      this._returnToLivePlayFromScrub();
    } else {
      console.warn(`[FreeplayRewinderController] Cannot stop recording: current state is "${store.rewinderState}".`);
    }
  }

  beginScrub(direction = 'rewinding') {
    if (!this._ensureFreeplayMode(`beginScrub(${direction})`)) return;
    if (this.rewinderFrames.length === 0) {
      console.warn(`[FreeplayRewinderController] Cannot start ${direction}: recorded frame buffer is empty (0 frames).`);
      return;
    }
    this._exitGoalOrReplayIfNeeded();
    const store = useDevTestLabStore.getState();
    if (store.rewinderState === 'recording') {
      this.rewinderCursor = this.rewinderFrames.length - 1;
      this.rewinderTargetFrame = this.rewinderCursor;
    } else if (store.rewinderState === 'preroll-countdown') {
      this.rewinderCursor = this.rewinderTargetFrame;
    }
    if (this.runtime?.keyboard) {
      this.runtime.keyboard.ballControlEnabled = false;
    }
    this.rewinderScrubAccumulator = 0;
    this._rewinderLastCountdownSecBeep = -1;
    store.updateLiveTelemetry({
      rewinderState: direction,
      rewinderRecordedFrames: this.rewinderFrames.length,
      rewinderCursorFrame: Math.round(this.rewinderCursor),
      rewinderTargetFrame: Math.round(this.rewinderCursor),
      rewinderPrerollRemainingSec: 0,
    });
  }

  pauseScrub() {
    const store = useDevTestLabStore.getState();
    if (store.rewinderState === 'rewinding' || store.rewinderState === 'forwarding') {
      const clamped = Math.max(0, Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor)));
      this.rewinderCursor = clamped;
      this.rewinderTargetFrame = clamped;
      this.applyFrameAtCursor(false, { preserveEngineTick: true });
      store.updateLiveTelemetry({
        rewinderState: 'paused-scrub',
        rewinderCursorFrame: clamped,
        rewinderTargetFrame: clamped,
      });
    }
  }

  seekFrame(frameIndex) {
    if (!this._ensureFreeplayMode('seekFrame')) return;
    if (!this.rewinderFrames || this.rewinderFrames.length === 0) {
      console.warn('[FreeplayRewinderController] Cannot seek frame: recorded frame buffer is empty (0 frames).');
      return;
    }
    this._exitGoalOrReplayIfNeeded();
    if (this.runtime?.keyboard) {
      this.runtime.keyboard.ballControlEnabled = false;
    }
    const clamped = Math.max(0, Math.min(this.rewinderFrames.length - 1, Math.round(frameIndex)));
    this.rewinderCursor = clamped;
    this.rewinderTargetFrame = clamped;
    this.rewinderScrubAccumulator = 0;
    this._rewinderLastCountdownSecBeep = -1;
    this.applyFrameAtCursor(false, { preserveEngineTick: true });
    useDevTestLabStore.getState().updateLiveTelemetry({
      rewinderState: 'paused-scrub',
      rewinderCursorFrame: clamped,
      rewinderTargetFrame: clamped,
      rewinderPrerollRemainingSec: 0,
    });
  }

  resumeFromCursor() {
    if (!this._ensureFreeplayMode('resumeFromCursor')) return;
    const r = this.runtime;
    const store = useDevTestLabStore.getState();
    const downSec = store.rewinderDownCounterSec ?? 0;
    const minRequiredFrames = downSec === 0 ? 120 : 240;
    if (!r?.physics) {
      console.warn('[FreeplayRewinderController] Cannot resume from cursor: physics engine is not initialized.');
      return;
    }
    if (this.rewinderFrames.length < minRequiredFrames) {
      console.warn(
        `[FreeplayRewinderController] Cannot resume from cursor: recorded frames (${this.rewinderFrames.length}) < minimum required frames (${minRequiredFrames}) for downCounter=${downSec}s.`
      );
      return;
    }

    this._exitGoalOrReplayIfNeeded();
    if (r.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }

    if (store.rewinderState === 'recording') {
      const lastFrame = Math.max(0, this.rewinderFrames.length - 1);
      this.rewinderCursor = lastFrame;
      this.rewinderTargetFrame = lastFrame;
    }

    const baseTarget =
      store.rewinderState === 'preroll-countdown' || store.rewinderState === 'stopped'
        ? this.rewinderTargetFrame || this.rewinderCursor
        : this.rewinderCursor;

    const targetIdx = Math.max(
      minRequiredFrames - 1,
      Math.min(this.rewinderFrames.length - 1, Math.round(baseTarget))
    );
    const lookbackFrames = (downSec === 0 ? 1 : downSec + 1) * 120;
    const startIdx = Math.max(0, targetIdx - lookbackFrames);

    this.rewinderTargetFrame = targetIdx;
    this.rewinderCursor = startIdx;
    this._rewinderLastCountdownSecBeep = -1;

    this.applyFrameAtCursor(false, { preserveEngineTick: true });
    r.simulationStage?.resetActionStates?.();

    const remFrames = Math.max(0, targetIdx - startIdx);
    const remSec = Math.ceil(remFrames / 120);
    const audio = r?.options?.gameAudio || gameAudio;
    if (downSec === 0) {
      this._rewinderLastCountdownSecBeep = 1;
      audio?.play?.('training_countdown', 1.0, 200);
    } else if (remSec >= 1 && remSec <= downSec) {
      this._rewinderLastCountdownSecBeep = remSec;
      audio?.play?.('training_countdown', 1.0, 200);
    }

    store.updateLiveTelemetry({
      rewinderState: 'preroll-countdown',
      rewinderRecordedFrames: this.rewinderFrames.length,
      rewinderCursorFrame: startIdx,
      rewinderTargetFrame: targetIdx,
      rewinderPrerollRemainingSec: downSec === 0 ? 1 : Math.min(downSec, remSec),
    });
  }

  async exportReplay() {
    if (!this.rewinderFrames || this.rewinderFrames.length === 0) {
      console.warn('[FreeplayRewinderController] Cannot export replay: recorded frame buffer is empty (0 frames).');
      return false;
    }
    return exportStateReplayFile(this.rewinderFrames);
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

      this.rewinderFrames = parsed.frames.map((snap, idx) => {
        const slot = stateInputTimeline?.getFrameAt?.(idx) || parsed.frameSlots?.[idx] || null;
        const ackControls = slot?.acknowledgedControls || slot?.controls || snap?.controls || [];
        const car0Ctrl =
          ackControls[0]?.controls ||
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
      this.rewinderCursor = 0;
      this.rewinderTargetFrame = Math.max(0, this.rewinderFrames.length - 1);
      this.rewinderScrubAccumulator = 0;
      this._rewinderLastCountdownSecBeep = -1;

      if (r.keyboard) {
        r.keyboard.ballControlEnabled = false;
      }
      this.applyFrameAtCursor(false, { preserveEngineTick: true });
      r.simulationStage?.resetActionStates?.();

      useDevTestLabStore.getState().updateLiveTelemetry({
        rewinderState: 'paused-scrub',
        rewinderRecordedFrames: this.rewinderFrames.length,
        rewinderCursorFrame: 0,
        rewinderTargetFrame: Math.max(0, this.rewinderFrames.length - 1),
        rewinderPrerollRemainingSec: 0,
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
      const idx = Math.max(0, Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderCursor)));
      this._handoffToLiveFreeplay(idx);
    }
    this.rewinderFrames = [];
    this.timelines = null;
    this.rewinderCursor = 0;
    this.rewinderTargetFrame = 0;
    this.rewinderScrubAccumulator = 0;
    this._rewinderLastCountdownSecBeep = -1;
    this._pendingFrameIncidents = [];
    r?.physics?.clearReplayBuffer?.();
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = true;
    }
    useDevTestLabStore.getState().updateLiveTelemetry({
      rewinderState: 'idle',
      rewinderRecordedFrames: 0,
      rewinderCursorFrame: 0,
      rewinderTargetFrame: 0,
      rewinderPrerollRemainingSec: 0,
    });
  }

  onResetKickoff() {
    const store = useDevTestLabStore.getState();
    if (this.isBlockingLivePhysics) {
      if (this.runtime?.keyboard) {
        this.runtime.keyboard.ballControlEnabled = true;
      }
      store.updateLiveTelemetry({
        rewinderState: this.rewinderFrames.length > 0 ? 'stopped' : 'idle',
        rewinderPrerollRemainingSec: 0,
      });
    }
  }

  onPhysicsEvent(event) {
    if (!event) return;
    const store = useDevTestLabStore.getState();
    if (store.rewinderState !== 'recording') return;

    // In SimulationStage, readEvents() runs after onAfterPhysicsTick() for the same physics step.
    // Attach the incident directly to the most recently recorded frame when available.
    if (this.rewinderFrames.length > 0) {
      const latestFrame = this.rewinderFrames[this.rewinderFrames.length - 1];
      if (!Array.isArray(latestFrame.incidents)) {
        latestFrame.incidents = [];
      }
      latestFrame.incidents.push({ ...event });
      if (event.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || event.type === 0x01) {
        latestFrame.hadTouch = true;
        const tick = Math.floor(
          this.runtime?.physics?.getHeaderView?.()?.tickCount ??
            event.tick ??
            latestFrame.compactSnap?.[0] ??
            0
        );
        latestFrame.lastTouchTick = tick;
      }
    } else {
      this._pendingFrameIncidents.push({ ...event });
    }
  }

  onBeforePhysicsTick() {
    const r = this.runtime;
    const store = useDevTestLabStore.getState();

    if (store.rewinderState === 'preroll-countdown') {
      const targetIdx = Math.max(
        0,
        Math.min(this.rewinderFrames.length - 1, Math.round(this.rewinderTargetFrame))
      );
      const nextCursor = Math.min(targetIdx, Math.round(this.rewinderCursor) + 1);
      this.rewinderCursor = nextCursor;
      const entry = this.applyFrameAtCursor(true, { preserveEngineTick: true });

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
      const downSec = store.rewinderDownCounterSec ?? 0;
      const maxBeepSec = downSec === 0 ? 1 : downSec;
      const audio = r?.options?.gameAudio || gameAudio;

      if (remFrames <= 0) {
        this._handoffToLiveFreeplay(targetIdx);
        audio?.play?.('match_start_go', 1.0, 200);
        this._rewinderLastCountdownSecBeep = -1;
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
        countdownSec !== this._rewinderLastCountdownSecBeep
      ) {
        this._rewinderLastCountdownSecBeep = countdownSec;
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
        this.rewinderCursor =
          store.rewinderState === 'rewinding'
            ? Math.max(0, this.rewinderCursor - stepPerTick)
            : Math.min(Math.max(0, this.rewinderFrames.length - 1), this.rewinderCursor + stepPerTick);
        this.rewinderTargetFrame = Math.round(this.rewinderCursor);
        this.applyFrameAtCursor(false, { preserveEngineTick: true });
        store.updateLiveTelemetry({
          rewinderCursorFrame: this.rewinderTargetFrame,
          rewinderTargetFrame: this.rewinderTargetFrame,
        });
      }
      return false;
    }

    return true;
  }

  onAfterPhysicsTick() {
    const r = this.runtime;
    const store = useDevTestLabStore.getState();
    if (store.rewinderState !== 'recording' || !r?.physics) {
      this._pendingFrameIncidents.length = 0;
      return;
    }

    if (this.rewinderFrames.length < MAX_REWINDER_FRAMES) {
      const compactSnap = r.physics.saveCompactState();
      const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount ?? 0);
      const hadTouch = Boolean(this.mode && this.mode.lastTouchTick === currentTick);
      const incidents =
        this._pendingFrameIncidents.length > 0 ? this._pendingFrameIncidents.slice() : [];
      this._pendingFrameIncidents.length = 0;

      this.rewinderFrames.push({
        compactSnap,
        renderState: compactSnap,
        controls: { ...(r.playerControls || DEFAULT_CAR_CONTROLS) },
        incidents,
        hadTouch,
        lastTouchTick: this.mode?.lastTouchTick ?? -1,
      });
      r.physics.recordReplayFrame?.();
      this.rewinderCursor = this.rewinderFrames.length - 1;
      this.rewinderTargetFrame = this.rewinderCursor;

      if (this.rewinderFrames.length % 6 === 0 || this.rewinderFrames.length === 120 || this.rewinderFrames.length === 240) {
        store.updateLiveTelemetry({
          rewinderRecordedFrames: this.rewinderFrames.length,
          rewinderCursorFrame: this.rewinderCursor,
          rewinderTargetFrame: this.rewinderTargetFrame,
        });
      }
    } else {
      this._pendingFrameIncidents.length = 0;
      this.stopRecording();
    }
  }
}
