/**
 * StandaloneReplayViewerController.js
 * Drives the standalone Replay Viewer floating window (accessible from Self-Training -> Replay Viewer).
 * Supports uploading compressed/uncompressed .rcreplay.gz / .rcreplay / .json files, loading the retained
 * last match replay buffer, Play (O) / Pause (P), Hold Rewind ([) / Hold Forward (]), timeline seek,
 * and Preroll Countdown + Resume From Here (G).
 */

import {
  SIM_OFFSETS,
  MAX_CARS,
  CAR_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  BALL_STATE_STRIDE,
  INCIDENT_EVENT_TYPES,
  MATCH_SIGNALS,
} from '../physics/RocketSimConstants.js';
import {
  reconstructAndRestoreReplayFrame,
  reconstructCarTransientStateFromHistory,
  patchWasmCarTransientState,
} from '../physics/RocketSimSnapshotHelper.js';
import { getRetainedMatchReplay, parseRCReplayFile } from './ReplayFileExporter.js';
import { assignTeamSlotKeys } from './container/RCReplayTimelineParser.js';
import { dispatchReplayFrameEvents } from './ReplayTimelineController.js';
import {
  unpackLoadoutSignalParam2,
  getCarColorSlotById,
  normalizeVisualId,
  resolveVehicleHitboxId,
} from '../ui-core/config/vehicleConstants.js';
import { setNameTagRuntimeState } from '../ui-core/config/nameTagConfig.ts';
import { useReplayViewerStore } from '../ui-core/stores/replayViewerStore';
import { useAppStore } from '../ui-core/stores/appStore';
import { hudStore } from '../ui-core/stores/hudStore';
import { gameAudio } from '../audio/GameAudioEngineFacade.js';

export class StandaloneReplayViewerController {
  constructor(runtime, mode = null) {
    this.runtime = runtime;
    this.mode = mode;
    this.frames = [];
    this.frameSlots = [];
    this.timelines = null;
    this.stateInputTimeline = null;
    this.incidentTimeline = null;
    this.signalTimeline = null;
    this.metadata = null;
    this.resolvedRoster = [];
    this.slotKeyToCarIndex = {};
    this.localTeam = 0;
    this.activePovCarIndex = 0;
    this.activePovSlotKey = 1;
    this.activePovTeam = 0;
    this.cursor = 0;
    this.targetFrame = 0;
    this._scrubAccumulator = 0;
    this._interveneStartFrame = 0;
    this._interveneElapsedTicks = 0;
    this.enableCausalHybridSync = true;
    this._causalFreeCarSet = new Set();
    this._causalBallFree = false;
    this._causalReleaseFrame = -1;
    this._lastCountdownSecBeep = -1;
    this._lastDispatchedCursorFrame = -1;
    this._keyDownHandler = null;
    this._keyUpHandler = null;
    this._unsubscribeFloating = null;
    this._loggedHotkeyConflict = false;
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
      onReturnToReplay: () => this.returnToReplay(),
      onSelectPovSlot: (slotKey) => this.selectPovSlot(slotKey),
      onClearReplay: () => this.clearReplay(),
    });
    this._bindHotkeys();
    if (this._unsubscribeFloating) {
      this._unsubscribeFloating();
    }
    this._unsubscribeFloating = useReplayViewerStore.subscribe(() => {
      this._isViewerWindowOpen();
    });
  }

  detach() {
    if (this._unsubscribeFloating) {
      this._unsubscribeFloating();
      this._unsubscribeFloating = null;
    }
    this._unbindHotkeys();
  }

  getViewerState() {
    return useReplayViewerStore.getState().viewerState;
  }

  _silenceContinuousAudio() {
    this.runtime?.audioSubsystem?.resetAudio?.();
    const audio = this.runtime?.options?.gameAudio || gameAudio;
    audio?.silenceAll?.();
  }

  get hasLoadedReplay() {
    const state = useReplayViewerStore.getState().viewerState;
    return state !== 'idle' && this.frames.length > 0;
  }

  get isActive() {
    const state = useReplayViewerStore.getState().viewerState;
    return state !== 'idle' && state !== 'intervening' && this.frames.length > 0;
  }

  _isViewerWindowOpen() {
    const st = useReplayViewerStore.getState();
    if (!st.isWindowOpen) {
      this._loggedHotkeyConflict = false;
      return false;
    }
    if (!st.hasHotkeyPriority) {
      if (!this._loggedHotkeyConflict) {
        this._loggedHotkeyConflict = true;
        console.error(
          '[StandaloneReplayViewerController] Cannot bind Replay Viewer hotkeys (O/P/[/]/G): Rewinder Configurator window is already open and claimed the hotkeys first.'
        );
      }
      return false;
    }
    this._loggedHotkeyConflict = false;
    return true;
  }

  _bindHotkeys() {
    if (typeof window === 'undefined') return;
    this._unbindHotkeys();

    this._keyDownHandler = (evt) => {
      const activeMode = this.runtime?.match?.state?.mode;
      if (activeMode !== 'freeplay' && activeMode !== 'replay-viewer') return;
      if (useAppStore.getState().isOpen) return;
      const tag = evt.target?.tagName?.toUpperCase?.() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const noMods = !evt.ctrlKey && !evt.shiftKey && !evt.altKey && !evt.metaKey;

      // When a replay is loaded in Replay Viewer, 1..6 switch POV (and block Freeplay ball control 1..4)
      if (this.hasLoadedReplay && noMods) {
        let keyNum = -1;
        if (evt.code >= 'Digit1' && evt.code <= 'Digit6') {
          keyNum = Number(evt.code.replace('Digit', ''));
        } else if (evt.code >= 'Numpad1' && evt.code <= 'Numpad6') {
          keyNum = Number(evt.code.replace('Numpad', ''));
        }
        if (keyNum >= 1 && keyNum <= 6) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          if (!evt.repeat) {
            this.selectPovSlot(keyNum);
          }
          return;
        }
      }

      if (!this._isViewerWindowOpen()) return;
      if (this.frames.length === 0) return;

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
      const activeMode = this.runtime?.match?.state?.mode;
      if (activeMode !== 'freeplay' && activeMode !== 'replay-viewer') return;
      if (!this._isViewerWindowOpen()) return;
      if (this.frames.length === 0) return;
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

  _extractActiveCarIndicesFromFrame(frame) {
    const indices = new Set();
    if (Array.isArray(this.metadata?.roster)) {
      for (const r of this.metadata.roster) {
        const cIdx = typeof r?.carIndex === 'number' ? r.carIndex : r?.entityId;
        if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < MAX_CARS) {
          indices.add(cIdx);
        }
      }
    }
    if (Array.isArray(this.signalTimeline?.recordedEvents)) {
      for (const ev of this.signalTimeline.recordedEvents) {
        if (
          ev.signalType === MATCH_SIGNALS.PLAYER_JOINED ||
          ev.signalType === MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED
        ) {
          const cIdx = Number(ev.param1);
          if (Number.isInteger(cIdx) && cIdx >= 0 && cIdx < MAX_CARS) {
            indices.add(cIdx);
          }
        }
      }
    }
    if (frame) {
      for (let c = 0; c < MAX_CARS; c++) {
        const base = SIM_OFFSETS.CARS + c * 40;
        const fwdLen = Math.hypot(
          frame[base + 3] || 0,
          frame[base + 4] || 0,
          frame[base + 5] || 0
        );
        if (fwdLen > 0.5) {
          indices.add(c);
        }
      }
      const rawNum = Math.max(1, Math.min(MAX_CARS, Math.round(frame[SIM_OFFSETS.NUM_CARS] || 1)));
      if (indices.size < rawNum) {
        for (let c = 0; c < rawNum && indices.size < rawNum; c++) {
          indices.add(c);
        }
      }
    }
    if (indices.size === 0) {
      indices.add(0);
    }
    return Array.from(indices).sort((a, b) => a - b);
  }

  _resolveReplayRosterAndApplyArena() {
    const r = this.runtime;
    const firstFrame =
      this.stateInputTimeline?.getFrameAt?.(0)?.snapshot ||
      this.frameSlots?.[0]?.snapshot ||
      this.frames[0] ||
      null;
    const activeCarIndices = this._extractActiveCarIndicesFromFrame(firstFrame);

    const rosterByCar = new Map();
    const rawRoster = Array.isArray(this.metadata?.roster)
      ? this.metadata.roster
      : Array.isArray(this.metadata?.loadouts)
      ? this.metadata.loadouts
      : [];
    for (const item of rawRoster) {
      if (!item || typeof item !== 'object') continue;
      const cIdx =
        typeof item.carIndex === 'number'
          ? item.carIndex
          : typeof item.entityId === 'number'
          ? item.entityId
          : -1;
      if (cIdx >= 0 && cIdx < MAX_CARS) {
        rosterByCar.set(cIdx, item);
      }
    }

    const joinedTeamByCar = new Map();
    const signalLoadoutByCar = new Map();
    if (Array.isArray(this.signalTimeline?.recordedEvents)) {
      for (const ev of this.signalTimeline.recordedEvents) {
        const cIdx = Number(ev.param1);
        if (!Number.isInteger(cIdx) || cIdx < 0 || cIdx >= MAX_CARS) continue;
        if (ev.signalType === MATCH_SIGNALS.PLAYER_JOINED) {
          joinedTeamByCar.set(cIdx, (Number(ev.param2) & 0xff) === 1 ? 1 : 0);
        } else if (ev.signalType === MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED) {
          signalLoadoutByCar.set(cIdx, unpackLoadoutSignalParam2(ev.param2));
        }
      }
    }

    const blueEntries = [];
    const orangeEntries = [];
    let detectedLocalTeam = null;

    for (const carIndex of activeCarIndices) {
      const metaItem = rosterByCar.get(carIndex) || null;
      const sigLoadout = signalLoadoutByCar.get(carIndex) || null;
      const base = SIM_OFFSETS.CARS + carIndex * 40;
      const initY = firstFrame ? firstFrame[base + 1] || 0 : 0;

      let team = 0;
      if (metaItem && (metaItem.team === 1 || metaItem.team === 'orange')) {
        team = 1;
      } else if (metaItem && (metaItem.team === 0 || metaItem.team === 'blue')) {
        team = 0;
      } else if (joinedTeamByCar.has(carIndex)) {
        team = joinedTeamByCar.get(carIndex);
      } else if (Math.abs(initY) > 50) {
        team = initY > 0 ? 1 : 0;
      } else {
        team = carIndex % 2;
      }

      const visualId = normalizeVisualId(
        metaItem?.visualId || sigLoadout?.visualId || 'fennec'
      );
      const hitboxId =
        metaItem?.hitboxId || sigLoadout?.hitboxId || resolveVehicleHitboxId(visualId);
      const defaultColorSlot = team === 0 ? 3 : 0;
      const colorSlot =
        typeof metaItem?.colorSlot === 'number'
          ? metaItem.colorSlot
          : typeof sigLoadout?.colorSlot === 'number'
          ? sigLoadout.colorSlot
          : defaultColorSlot;
      const swatch = getCarColorSlotById(colorSlot);
      const colorHex = metaItem?.colorHex || swatch.hex;
      const paintFinish = metaItem?.paintFinish || sigLoadout?.paintFinish || 'metallic';
      const boostVisual = metaItem?.boostVisual || sigLoadout?.boostVisual || 'gold-rush';
      const boostAudio = metaItem?.boostAudio || sigLoadout?.boostAudio || 'rush';
      const isSelf = Boolean(
        metaItem?.isPlayer || metaItem?.isSelf || metaItem?.isLocal || metaItem?.isLocalPlayer
      );
      if (isSelf && detectedLocalTeam === null) {
        detectedLocalTeam = team;
      }

      const entry = {
        carIndex,
        team,
        name: metaItem?.name || metaItem?.username || null,
        botType: metaItem?.botType || null,
        isSelf,
        visualId,
        hitboxId,
        colorSlot,
        colorHex,
        paintFinish,
        boostVisual,
        boostAudio,
        slotKey: 1,
      };
      if (team === 1) {
        orangeEntries.push(entry);
      } else {
        blueEntries.push(entry);
      }
    }

    this.localTeam = detectedLocalTeam === 1 ? 1 : 0;
    const leftEntries = this.localTeam === 1 ? orangeEntries : blueEntries;
    const rightEntries = this.localTeam === 1 ? blueEntries : orangeEntries;
    const { leftSlotKeys, rightSlotKeys, slotKeyToCarIndex } = assignTeamSlotKeys(
      leftEntries,
      rightEntries
    );
    this.slotKeyToCarIndex = slotKeyToCarIndex;

    const allEntries = [...leftEntries, ...rightEntries];
    const botCounts = {};
    for (const e of allEntries) {
      if (e.botType) {
        const k = String(e.botType).toLowerCase();
        botCounts[k] = (botCounts[k] || 0) + 1;
      }
    }

    leftEntries.forEach((e, idx) => {
      e.slotKey = leftSlotKeys[idx] ?? idx + 1;
      if (!e.name) {
        if (e.botType) {
          const bt = String(e.botType);
          const cap = bt.charAt(0).toUpperCase() + bt.slice(1).toLowerCase();
          e.name = (botCounts[bt.toLowerCase()] || 0) > 1 ? `${cap} #${e.slotKey}` : cap;
        } else {
          e.name = allEntries.length === 1 ? 'Player' : `${e.team === 1 ? 'Orange' : 'Blue'} #${e.slotKey}`;
        }
      }
    });

    rightEntries.forEach((e, idx) => {
      e.slotKey = rightSlotKeys[idx] ?? idx + 4;
      if (!e.name) {
        if (e.botType) {
          const bt = String(e.botType);
          const cap = bt.charAt(0).toUpperCase() + bt.slice(1).toLowerCase();
          e.name = (botCounts[bt.toLowerCase()] || 0) > 1 ? `${cap} #${e.slotKey}` : cap;
        } else {
          e.name = `${e.team === 1 ? 'Orange' : 'Blue'} #${e.slotKey}`;
        }
      }
    });

    this.resolvedRoster = allEntries;

    // Pick initial POV car (prefer isSelf, otherwise slot 1 / first car)
    const selfEntry = allEntries.find((e) => e.isSelf) || allEntries[0] || null;
    this.activePovCarIndex = selfEntry ? selfEntry.carIndex : 0;
    this.activePovSlotKey = selfEntry ? selfEntry.slotKey : 1;
    this.activePovTeam = selfEntry?.team === 1 ? 1 : 0;

    if (r?.physics) {
      const activeSet = new Set(allEntries.map((e) => e.carIndex));
      for (let c = MAX_CARS - 1; c >= 0; c--) {
        if (!activeSet.has(c) && r.physics.isCarSlotActive?.(c)) {
          r.physics.removeCar?.(c);
        }
      }
      for (const e of allEntries) {
        if (typeof r.physics.addCarAtSlot === 'function') {
          r.physics.addCarAtSlot(e.carIndex, e.team, e.hitboxId);
        } else {
          while (r.physics.numCars <= e.carIndex && typeof r.physics.addCar === 'function') {
            r.physics.addCar(e.team, e.hitboxId);
          }
          r.physics.setCarTeam?.(e.carIndex, e.team);
        }
      }
    }

    if (r?.arena) {
      if (allEntries.length > 1) {
        r.arena.ensureOpponent?.();
      }
      const activeSet = new Set(allEntries.map((e) => e.carIndex));
      for (const e of allEntries) {
        r.arena.ensureCar?.(e.carIndex, e.team, e.visualId);
        r.arena.swapCarVisual?.(e.carIndex, e.visualId);
        r.arena.setCarTeam?.(e.carIndex, e.team);
        r.arena.setCarColor?.(e.carIndex, e.colorHex);
        r.arena.setCarLoadout?.(e.carIndex, {
          name: e.name,
          colorHex: e.colorHex,
          paintFinish: e.paintFinish,
          boostVisual: e.boostVisual,
          boostAudio: e.boostAudio,
        });
        if (r.arena.cars?.[e.carIndex]) {
          r.arena.cars[e.carIndex].visible = true;
        }
      }
      if (Array.isArray(r.arena.cars)) {
        for (let c = 0; c < r.arena.cars.length; c++) {
          if (!activeSet.has(c) && r.arena.cars[c]) {
            r.arena.cars[c].visible = false;
          }
        }
      }
    }

    if (r) {
      r.playerCarIndex = this.activePovCarIndex;
      if (r.arena) {
        r.arena.playerCarIndex = this.activePovCarIndex;
      }
      if (r.keyboard) {
        r.keyboard.ballControlEnabled = false;
      }
    }

    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: allEntries.length > 1,
      carEntries: allEntries.map((e) => ({
        carIndex: e.carIndex,
        name: e.name,
        username: e.name,
        team: e.team,
        isBot: !e.isSelf,
        isLocalPlayer: e.carIndex === this.activePovCarIndex,
      })),
    });
  }

  selectPovSlot(slotKey) {
    if (!this.hasLoadedReplay) return;
    const key = Number(slotKey);
    const entry =
      this.resolvedRoster.find((e) => e.slotKey === key) ||
      (typeof this.slotKeyToCarIndex?.[key] === 'number'
        ? this.resolvedRoster.find((e) => e.carIndex === this.slotKeyToCarIndex[key])
        : null);
    if (!entry) return;

    this.activePovCarIndex = entry.carIndex;
    this.activePovSlotKey = entry.slotKey;
    this.activePovTeam = entry.team === 1 ? 1 : 0;

    const r = this.runtime;
    if (r) {
      r.playerCarIndex = entry.carIndex;
      if (r.arena) {
        r.arena.playerCarIndex = entry.carIndex;
      }
      const freeplayMode = this.mode || r.modeManager?.modes?.get?.('freeplay') || null;
      if (freeplayMode?.isReplayActive) {
        freeplayMode.replayCameraMode = 'pov';
        freeplayMode.goalScorerCarIndex = entry.carIndex;
        r.goalReplayCameraOverrideActive = false;
        hudStore.getState().setReplayState({ replayCameraMode: 'pov' });
      }
      r.camera?.resetView?.();
    }

    if (this.resolvedRoster.length > 0) {
      setNameTagRuntimeState({
        isMultiplayerOrMultiCarMode: this.resolvedRoster.length > 1,
        carEntries: this.resolvedRoster.map((e) => ({
          carIndex: e.carIndex,
          name: e.name,
          username: e.name,
          team: e.team,
          isBot: !e.isSelf,
          isLocalPlayer: e.carIndex === this.activePovCarIndex,
        })),
      });
    }

    useReplayViewerStore.getState().updateLiveTelemetry({
      activePovCarIndex: this.activePovCarIndex,
      activePovSlotKey: this.activePovSlotKey,
      activePovTeam: this.activePovTeam,
    });
  }

  _syncArenaCarCountForFrame(frame) {
    const r = this.runtime;
    if (!r?.physics || !frame) return;
    if (this.resolvedRoster.length > 0) {
      return;
    }
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
      activePovCarIndex: this.activePovCarIndex,
      activePovSlotKey: this.activePovSlotKey,
      activePovTeam: this.activePovTeam,
    };
  }

  _syncScoreboardAndClockAtFrame(idx) {
    if (!this.signalTimeline) return;
    const evalState = this.signalTimeline.evaluateMatchStateAtFrame(idx, this.metadata || {});
    const hudPatch = {
      localTeam: this.localTeam,
      blueScore: evalState.blueScore,
      orangeScore: evalState.orangeScore,
      matchPhase: evalState.matchPhase || 'playing',
      kickoffCountdown: evalState.kickoffCountdown || 0,
    };
    if (evalState.remainingSeconds !== null) {
      hudPatch.remainingSeconds = evalState.remainingSeconds;
      hudPatch.isOvertime = evalState.isOvertime;
      hudPatch.overtimeSeconds = evalState.overtimeSeconds || 0;
    }
    hudStore.getState().setMatchState(hudPatch);
  }

  _applyFrameAtCursor(
    smoothStep = false,
    dispatchEvents = false,
    restoreOptions = { preserveEngineTick: true }
  ) {
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

    if (r.playerCarIndex !== this.activePovCarIndex) {
      r.playerCarIndex = this.activePovCarIndex;
      if (r.arena) {
        r.arena.playerCarIndex = this.activePovCarIndex;
      }
    }
    if (r.keyboard && r.keyboard.ballControlEnabled) {
      r.keyboard.ballControlEnabled = false;
    }

    if (smoothStep && r.interpolator) {
      r.interpolator.prevState.set(r.interpolator.currState);
    }

    r.physics.restoreState(snap, restoreOptions);

    for (const e of this.resolvedRoster) {
      r.physics.setCarTeam?.(e.carIndex, e.team);
    }

    const controls =
      slot?.acknowledgedControls ||
      slot?.controls ||
      this.stateInputTimeline?.getControlsAt?.(idx) ||
      snap?.controls;
    if (Array.isArray(controls) && typeof r.physics.setControls === 'function') {
      for (let c = 0; c < Math.min(controls.length, MAX_CARS); c++) {
        const item = controls[c];
        if (!item) continue;
        const targetCarIdx = typeof item.carIndex === 'number' ? item.carIndex : c;
        const ctrlPayload = item.controls || item;
        if (ctrlPayload) {
          r.physics.setControls(targetCarIdx, ctrlPayload);
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
      this._syncScoreboardAndClockAtFrame(idx);
      this._lastDispatchedCursorFrame = idx;
    } else {
      this._syncScoreboardAndClockAtFrame(idx);
      this._lastDispatchedCursorFrame = idx;
    }
  }

  _getNormalizedFrameSlotAt(frameIndex) {
    if (this.frames.length === 0) return null;
    const fIdx = Math.max(0, Math.min(this.frames.length - 1, Math.floor(frameIndex)));
    const slot =
      this.stateInputTimeline?.getFrameAt?.(fIdx) ||
      this.frameSlots?.[fIdx] ||
      null;
    const snapshot = slot?.snapshot || this.frames[fIdx];
    if (!snapshot) return null;
    const controls =
      slot?.acknowledgedControls ||
      slot?.controls ||
      this.stateInputTimeline?.getControlsAt?.(fIdx) ||
      snapshot?.controls ||
      [];
    return { snapshot, controls };
  }

  _isNonPovTouchAtFrame(frameIndex) {
    if (frameIndex <= 0 || frameIndex >= this.frames.length) return false;
    const slot =
      this.stateInputTimeline?.getFrameAt?.(frameIndex) ||
      this.frameSlots?.[frameIndex] ||
      null;
    const snap = slot?.snapshot || this.frames[frameIndex];
    const incidents =
      this.incidentTimeline?.getEventsAtFrame?.(frameIndex) ||
      slot?.incidents ||
      snap?.incidents ||
      [];
    for (const inc of incidents) {
      if (
        (inc?.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || inc?.type === 0x01) &&
        inc?.carIndex !== this.activePovCarIndex
      ) {
        return true;
      }
    }
    const prevSnap =
      this.stateInputTimeline?.getFrameAt?.(frameIndex - 1)?.snapshot ||
      this.frameSlots?.[frameIndex - 1]?.snapshot ||
      this.frames[frameIndex - 1];
    if (snap && prevSnap) {
      const bOff = SIM_OFFSETS.BALL;
      const dvx = (snap[bOff + 12] || 0) - (prevSnap[bOff + 12] || 0);
      const dvy = (snap[bOff + 13] || 0) - (prevSnap[bOff + 13] || 0);
      const dvz = (snap[bOff + 14] || 0) - ((prevSnap[bOff + 14] || 0) - 650.0 / 120.0);
      const dvMag = Math.hypot(dvx, dvy, dvz);
      if (dvMag > 120.0) {
        const bx = snap[bOff] || 0;
        const by = snap[bOff + 1] || 0;
        const bz = snap[bOff + 2] || 0;
        if (bz > 115.0 && Math.abs(bx) < 3950.0 && Math.abs(by) < 4980.0 && bz < 1920.0) {
          const numCars = Math.min(
            MAX_CARS,
            Math.max(1, Math.round(snap[SIM_OFFSETS.NUM_CARS] || 1))
          );
          for (let c = 0; c < numCars; c++) {
            if (c === this.activePovCarIndex) continue;
            const cBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
            const dist = Math.hypot(
              (snap[cBase] || 0) - bx,
              (snap[cBase + 1] || 0) - by,
              (snap[cBase + 2] || 0) - bz
            );
            if (dist < 220.0) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  _hasAnyNonPovTouchAfterFrame(frameIndex) {
    for (let f = frameIndex + 1; f < this.frames.length; f++) {
      if (this._isNonPovTouchAtFrame(f)) return true;
    }
    return false;
  }

  _initCausalHybridSync(_startFrameIndex) {
    this._causalFreeCarSet = new Set([this.activePovCarIndex]);
    this._causalBallFree = false;
    this._causalTouchSeparationTicks = 0;
  }

  _updateCausalHybridSyncBeforeStep(currentReplayFrameIndex) {
    const r = this.runtime;
    const sim = r?.physics;
    if (!this.enableCausalHybridSync || !sim || currentReplayFrameIndex >= this.frames.length) {
      return;
    }

    const slot = this._getNormalizedFrameSlotAt(currentReplayFrameIndex);
    const snap = slot?.snapshot;
    if (!snap) return;

    const totalCars = Math.min(
      MAX_CARS,
      Math.max(sim.numCars || 1, this.resolvedRoster.length, Math.round(snap[SIM_OFFSETS.NUM_CARS] || 1))
    );

    // 1. Check causal proximity between free entities (POV car, free cars, or free ball) and anchored entities
    const CAR_CAR_CAUSAL_RADIUS = 240.0;
    const CAR_BALL_CAUSAL_RADIUS = 240.0;
    const st = sim.state;

    let changed = true;
    while (changed) {
      changed = false;
      for (const freeCarIdx of Array.from(this._causalFreeCarSet)) {
        const fcBase = SIM_OFFSETS.CARS + freeCarIdx * CAR_STATE_STRIDE;
        const fcx = st[fcBase] || 0;
        const fcy = st[fcBase + 1] || 0;
        const fcz = st[fcBase + 2] || 0;

        if (!this._causalBallFree) {
          const bOff = SIM_OFFSETS.BALL;
          const bx = st[bOff] || 0;
          const by = st[bOff + 1] || 0;
          const bz = st[bOff + 2] || 0;
          if (Math.hypot(fcx - bx, fcy - by, fcz - bz) <= CAR_BALL_CAUSAL_RADIUS) {
            this._causalBallFree = true;
            changed = true;
          }
        }

        for (let c = 0; c < totalCars; c++) {
          if (this._causalFreeCarSet.has(c)) continue;
          if (typeof sim.isCarSlotActive === 'function' && !sim.isCarSlotActive(c)) continue;
          const cBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
          const cx = st[cBase] || 0;
          const cy = st[cBase + 1] || 0;
          const cz = st[cBase + 2] || 0;
          if (Math.hypot(fcx - cx, fcy - cy, fcz - cz) <= CAR_CAR_CAUSAL_RADIUS) {
            this._causalFreeCarSet.add(c);
            changed = true;
          }
        }
      }

      if (this._causalBallFree) {
        // Ball was perturbed by POV/free car -> release any car within causal radius of the perturbed ball
        const bOff = SIM_OFFSETS.BALL;
        const bx = st[bOff] || 0;
        const by = st[bOff + 1] || 0;
        const bz = st[bOff + 2] || 0;
        for (let c = 0; c < totalCars; c++) {
          if (this._causalFreeCarSet.has(c)) continue;
          if (typeof sim.isCarSlotActive === 'function' && !sim.isCarSlotActive(c)) continue;
          const cBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
          const cx = st[cBase] || 0;
          const cy = st[cBase + 1] || 0;
          const cz = st[cBase + 2] || 0;
          if (Math.hypot(bx - cx, by - cy, bz - cz) <= CAR_BALL_CAUSAL_RADIUS) {
            this._causalFreeCarSet.add(c);
            changed = true;
          }
        }
      }
    }

    // 2. Sync unperturbed ball and non-POV cars to exact replay snapshot before stepping currentReplayFrameIndex -> +1
    if (!this._causalBallFree) {
      if (this._causalTouchSeparationTicks > 0) {
        this._causalTouchSeparationTicks--;
      } else {
        const bOff = SIM_OFFSETS.BALL;
        sim.setBallState?.(snap.subarray(bOff, bOff + BALL_STATE_STRIDE));
      }
      // If step currentReplayFrameIndex -> currentReplayFrameIndex + 1 is a non-POV touch,
      // let Bullet/RocketSim step the collision natively for 2 separation ticks afterward
      // (or release the ball into free flight if no further non-POV touches remain).
      if (this._isNonPovTouchAtFrame(currentReplayFrameIndex + 1)) {
        if (!this._hasAnyNonPovTouchAfterFrame(currentReplayFrameIndex + 1)) {
          this._causalTouchSeparationTicks = 999999;
        } else {
          this._causalTouchSeparationTicks = 2;
        }
      }
    }

    const getSlotFn = (f) => this._getNormalizedFrameSlotAt(f);
    for (let c = 0; c < totalCars; c++) {
      if (this._causalFreeCarSet.has(c)) continue;
      if (typeof sim.isCarSlotActive === 'function' && !sim.isCarSlotActive(c)) continue;
      const cBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      sim.setCarState?.(c, snap.subarray(cBase, cBase + CAR_STATE_STRIDE));
      const rec = reconstructCarTransientStateFromHistory(getSlotFn, currentReplayFrameIndex, c, 300);
      if (rec) {
        patchWasmCarTransientState(sim, c, rec, false);
      }
    }
  }

  _prepareRuntimeForReplayViewer() {
    const r = this.runtime;
    if (!r) return;

    if (
      r.match?.state &&
      r.match.state.mode !== 'freeplay' &&
      r.match.state.mode !== 'replay-viewer'
    ) {
      if (typeof r.switchToFreeplay === 'function') {
        r.switchToFreeplay();
      } else if (typeof r.leaveBotMatch === 'function' && r.match.state.mode === 'match') {
        r.leaveBotMatch();
      }
    }

    if (r.match?.state) {
      r.match.state.mode = 'replay-viewer';
      r.match.state.phase = 'playing';
      r.match.state.paused = false;
    }
    useAppStore.getState().setMatchMode?.('replay-viewer');
    r.modeManager?.setMode?.('replay-viewer');

    const freeplayMode =
      this.mode ||
      r.modeManager?.modes?.get?.('replay-viewer') ||
      r.modeManager?.modes?.get?.('freeplay') ||
      (r.modeManager?.activeMode?.id === 'freeplay' ||
      r.modeManager?.activeMode?.id === 'replay-viewer'
        ? r.modeManager.activeMode
        : null);
    if (freeplayMode) {
      this.mode = freeplayMode;
      if (freeplayMode.isReplayActive || r.match?.state?.phase === 'replay') {
        freeplayMode.replayController?.endReplaySession?.();
        freeplayMode.isReplayActive = false;
        hudStore.getState().setReplayState({
          replayPaused: false,
          replayPersistent: false,
        });
        hudStore.setState({
          isGoalReplay: false,
          goalReplayScorerName: '',
          goalReplayScoringTeam: 0,
          goalReplaySpeedKph: 0,
          goalReplayProgress: 0,
          goalReplayDurationSec: 0,
          goalReplayElapsedSec: 0,
        });
      }
      freeplayMode.goalResetTicks = 0;
      freeplayMode.goalIncidentTick = -1;
      freeplayMode.frozenGoalBallState = null;

      if (freeplayMode.rewinderController?.isBlockingLivePhysics) {
        if (typeof freeplayMode.rewinderController.exitRewindMode === 'function') {
          freeplayMode.rewinderController.exitRewindMode();
        } else {
          freeplayMode.rewinderController.stopRecording?.();
        }
      }
    }

    r.goalReplayCameraOverrideActive = false;
    r._clientGoalIncidentLatched = false;
    if (r.match?.state && r.match.state.phase !== 'playing') {
      r.match.state.phase = 'playing';
    }
  }

  _applyNonPovRecordedControlsAtFrame(frameIndex) {
    const r = this.runtime;
    if (!r?.physics || typeof r.physics.setControls !== 'function' || this.frames.length === 0) {
      return;
    }
    const fIdx = Math.max(0, Math.min(this.frames.length - 1, Math.floor(frameIndex)));
    const slot =
      this.stateInputTimeline?.getFrameAt?.(fIdx) ||
      this.frameSlots?.[fIdx] ||
      null;
    const snap = slot?.snapshot || this.frames[fIdx];
    const controls =
      slot?.acknowledgedControls ||
      slot?.controls ||
      this.stateInputTimeline?.getControlsAt?.(fIdx) ||
      snap?.controls;

    const appliedCars = new Set();
    if (Array.isArray(controls) && frameIndex < this.frames.length) {
      for (let c = 0; c < Math.min(controls.length, MAX_CARS); c++) {
        const item = controls[c];
        if (!item) continue;
        const targetCarIdx = typeof item.carIndex === 'number' ? item.carIndex : c;
        if (targetCarIdx === this.activePovCarIndex) continue;
        const ctrlPayload = item.controls || item;
        if (ctrlPayload) {
          r.physics.setControls(targetCarIdx, ctrlPayload);
          appliedCars.add(targetCarIdx);
        }
      }
    }

    const totalCars = Math.min(MAX_CARS, Math.max(r.physics.numCars || 1, this.resolvedRoster.length));
    for (let c = 0; c < totalCars; c++) {
      if (c !== this.activePovCarIndex && !appliedCars.has(c)) {
        r.physics.setControls(c, r.neutralControls);
      }
    }
  }

  _handoffToLiveFreeplay(targetIdx) {
    const r = this.runtime;
    if (!r?.physics) return;
    const sim = r.physics;
    const freeplayMode = this.mode || r.modeManager?.modes?.get?.('freeplay') || null;
    const maxHistory = Math.min(
      targetIdx + 1,
      freeplayMode?.replayRingBuffer?.capacityTicks || 2400
    );
    const firstIdx = Math.max(0, targetIdx + 1 - maxHistory);
    const historySpan = Math.max(0, targetIdx - firstIdx);
    const prevEngineTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const liveTick = Math.max(prevEngineTick + 16, historySpan + 16);

    this.cursor = targetIdx;
    this._interveneStartFrame = targetIdx;
    this._interveneElapsedTicks = 0;
    this._initCausalHybridSync(targetIdx);
    sim.setUnlimitedBoost?.(false);
    this._applyFrameAtCursor(false, false, { overrideTick: liveTick });
    reconstructAndRestoreReplayFrame(
      sim,
      (f) => this._getNormalizedFrameSlotAt(f),
      targetIdx,
      { overrideTick: liveTick }
    );
    for (const e of this.resolvedRoster) {
      sim.setCarTeam?.(e.carIndex, e.team);
    }
    if (r.interpolator) {
      r.interpolator.prevState.set(sim.state);
      r.interpolator.currState.set(sim.state);
      r.interpolator.alpha = 0;
    }

    r.playerCarIndex = this.activePovCarIndex;
    if (r.arena) {
      r.arena.playerCarIndex = this.activePovCarIndex;
    }

    sim.clearEvents?.();
    sim.resetGoalLatch?.();
    r._clientGoalIncidentLatched = false;
    r.simulationStage?.resetActionStates?.();
    if (r.keyboard) {
      // Keep Freeplay 1..4 ball control disabled while Replay Viewer has a replay loaded
      r.keyboard.ballControlEnabled = false;
    }

    sim.setControls?.(this.activePovCarIndex, r.playerControls || r.neutralControls);
    // In recorded frameSlots, slot[f + 1].controls drives the step from snapshot[f] -> snapshot[f + 1]
    this._applyNonPovRecordedControlsAtFrame(targetIdx + 1);

    if (freeplayMode) {
      const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? liveTick);
      const bView = sim.getBallStateView?.();
      freeplayMode.goalIncidentTick = -1;
      freeplayMode.goalResetTicks = 0;
      freeplayMode.frozenGoalBallState = null;
      freeplayMode.prevBallVelX = bView?.velX ?? 0;
      freeplayMode.prevBallVelY = bView?.velY ?? 0;
      freeplayMode.prevBallVelZ = bView?.velZ ?? 0;

      if (freeplayMode.replayRingBuffer) {
        freeplayMode.replayRingBuffer.clear();
        const baseTick = currentTick - historySpan;
        let latestTouchTick = -1;

        for (let i = firstIdx; i <= targetIdx; i++) {
          const slot =
            this.stateInputTimeline?.getFrameAt?.(i) ||
            this.frameSlots?.[i] ||
            null;
          const snap = slot?.snapshot || this.frames[i];
          if (!snap) continue;
          const syntheticTick = baseTick + (i - firstIdx);
          const frameControls =
            slot?.acknowledgedControls ||
            slot?.controls ||
            this.stateInputTimeline?.getControlsAt?.(i) ||
            snap?.controls ||
            [];
          const recordedSlot = freeplayMode.replayRingBuffer.recordFrame(syntheticTick, snap, {
            acknowledgedControls: frameControls,
          });
          if (recordedSlot?.snapshot) {
            recordedSlot.snapshot[SIM_OFFSETS.TICK] = syntheticTick;
          }
          const frameIncidents =
            this.incidentTimeline?.getEventsAtFrame?.(i) ||
            slot?.incidents ||
            snap?.incidents ||
            [];
          for (const inc of frameIncidents) {
            freeplayMode.replayRingBuffer.appendIncident(syntheticTick, {
              ...inc,
              tick: syntheticTick,
            });
            if (inc.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || inc.type === 0x01) {
              latestTouchTick = syntheticTick;
            }
          }
        }

        freeplayMode.lastKickoffStartTick = baseTick;
        freeplayMode.lastTouchTick = latestTouchTick >= 0 ? latestTouchTick : baseTick;
      }
    }
  }

  returnToReplay() {
    if (this.frames.length === 0) return;
    const r = this.runtime;
    this._prepareRuntimeForReplayViewer();

    const restoreIdx = Math.max(
      0,
      Math.min(this.frames.length - 1, Math.round(this.targetFrame || this.cursor || 0))
    );
    this.cursor = restoreIdx;
    this.targetFrame = restoreIdx;
    this._scrubAccumulator = 0;
    this._lastCountdownSecBeep = -1;
    this._lastDispatchedCursorFrame = restoreIdx;
    this._applyFrameAtCursor(false, false);
    this._silenceContinuousAudio();
    r?.camera?.resetView?.();

    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: 'paused',
      cursorFrame: restoreIdx,
      targetFrame: restoreIdx,
      prerollRemainingSec: 0,
    });
  }

  async handleUploadFile(file) {
    if (!file) return;
    const store = useReplayViewerStore.getState();
    store.setErrorMessage(null);
    try {
      const result = await parseRCReplayFile(file);
      if (!result.frames || result.frames.length === 0) {
        throw new Error('Replay file contains 0 frames.');
      }
      this._prepareRuntimeForReplayViewer();
      this._interveneStartFrame = 0;
      this._interveneElapsedTicks = 0;
      this._causalFreeCarSet.clear();
      this._causalBallFree = false;
      this._causalTouchSeparationTicks = 0;
      this.frames = result.frames;
      this.frameSlots = result.frameSlots || [];
      this._bindTimelines(result.timelines, result.metadata);
      this._resolveReplayRosterAndApplyArena();
      this.cursor = 0;
      this.targetFrame = Math.max(0, result.frames.length - 1);
      this._scrubAccumulator = 0;
      this._lastCountdownSecBeep = -1;
      this._lastDispatchedCursorFrame = -1;
      this._applyFrameAtCursor(false, false);
      this._silenceContinuousAudio();
      this.runtime?.camera?.resetView?.();

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
      quickNotification.success(
        `Loaded replay "${file.name}" (${this.frames.length} frames).`
      );
    } catch (err) {
      console.error('[StandaloneReplayViewerController] Failed to parse uploaded replay file:', err);
      const msg = err?.message || 'Failed to parse replay file.';
      store.setErrorMessage(msg);
      quickNotification.error(msg);
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
    this._prepareRuntimeForReplayViewer();
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
    const retainedMeta = {
      ...(retained.metadata && typeof retained.metadata === 'object' ? retained.metadata : {}),
      mode: retained.mode,
      arenaPreset: retained.arenaPreset,
      durationSeconds: retained.durationSeconds,
      winner: retained.winner,
      blueScore: retained.blueScore,
      orangeScore: retained.orangeScore,
      winReason: retained.winReason,
      roster: retained.roster || retained.metadata?.roster || null,
      loadouts: retained.loadouts || retained.metadata?.loadouts || null,
    };
    this._bindTimelines(retained.timelines, retainedMeta);
    this._resolveReplayRosterAndApplyArena();
    this.cursor = 0;
    this.targetFrame = Math.max(0, this.frames.length - 1);
    this._scrubAccumulator = 0;
    this._lastCountdownSecBeep = -1;
    this._lastDispatchedCursorFrame = -1;
    this._applyFrameAtCursor(false, false);
    this._silenceContinuousAudio();

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
    if (useReplayViewerStore.getState().viewerState === 'intervening') {
      this.returnToReplay();
    } else {
      this._prepareRuntimeForReplayViewer();
    }
    if (this.cursor >= this.frames.length - 1) {
      this.cursor = 0;
      this._lastDispatchedCursorFrame = -1;
    }
    this.targetFrame = Math.round(this.cursor);
    this._scrubAccumulator = 0;
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
    this._prepareRuntimeForReplayViewer();
    const clamped = Math.max(0, Math.min(this.frames.length - 1, Math.round(this.cursor)));
    this.cursor = clamped;
    this.targetFrame = clamped;
    this._scrubAccumulator = 0;
    this._applyFrameAtCursor(false, false);
    this._silenceContinuousAudio();
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
    this._prepareRuntimeForReplayViewer();
    const clamped = Math.max(0, Math.min(this.frames.length - 1, Math.round(frameIndex)));
    this.cursor = clamped;
    this.targetFrame = clamped;
    this._scrubAccumulator = 0;
    this._applyFrameAtCursor(false, false);
    const curState = useReplayViewerStore.getState().viewerState;
    const nextState = curState === 'playing' ? 'playing' : 'paused';
    if (nextState === 'paused') {
      this._silenceContinuousAudio();
    }
    useReplayViewerStore.getState().updateLiveTelemetry({
      viewerState: nextState,
      cursorFrame: clamped,
      targetFrame: clamped,
    });
  }

  beginScrub(direction = 'rewinding') {
    if (this.frames.length === 0) {
      console.warn(`[StandaloneReplayViewerController] Cannot start ${direction}: no replay frames loaded.`);
      return;
    }
    if (useReplayViewerStore.getState().viewerState === 'intervening') {
      this.returnToReplay();
    } else {
      this._prepareRuntimeForReplayViewer();
    }
    const store = useReplayViewerStore.getState();
    const flowPct = store.effectiveFlowPct || 100;
    const initialStep = Math.max(1, Math.round(flowPct / 100));
    const maxIdx = Math.max(0, this.frames.length - 1);
    const curIdx = Math.max(0, Math.min(maxIdx, Math.round(this.cursor)));
    const nextIdx =
      direction === 'rewinding'
        ? Math.max(0, curIdx - initialStep)
        : Math.min(maxIdx, curIdx + initialStep);

    this.cursor = nextIdx;
    this.targetFrame = nextIdx;
    this._scrubAccumulator = 0;
    this._lastCountdownSecBeep = -1;
    this._applyFrameAtCursor(false, direction === 'forwarding', {
      preserveEngineTick: true,
    });
    store.updateLiveTelemetry({
      viewerState: direction,
      cursorFrame: nextIdx,
      targetFrame: nextIdx,
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
    const downSec = store.downCounterSec ?? 0;
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

    this._prepareRuntimeForReplayViewer();

    const baseCursor =
      store.viewerState === 'intervening' || store.viewerState === 'preroll-countdown'
        ? this.targetFrame
        : Math.round(this.cursor);
    const baseTarget = Math.max(
      minRequiredFrames - 1,
      Math.min(this.frames.length - 1, baseCursor)
    );
    const lookbackFrames = (downSec === 0 ? 1 : downSec + 1) * 120;
    const startIdx = Math.max(0, baseTarget - lookbackFrames);

    this.targetFrame = baseTarget;
    this.cursor = startIdx;
    this._scrubAccumulator = 0;
    this._lastCountdownSecBeep = -1;
    this._lastDispatchedCursorFrame = startIdx;

    r.physics.setUnlimitedBoost?.(false);
    this._applyFrameAtCursor(false, false);
    r.simulationStage?.resetActionStates?.();

    const remFrames = Math.max(0, baseTarget - startIdx);
    const remSec = Math.ceil(remFrames / 120);
    const visibleCountdownSec = downSec > 0 && remSec >= 1 && remSec <= downSec ? remSec : 0;
    if (visibleCountdownSec >= 1) {
      this._lastCountdownSecBeep = visibleCountdownSec;
      const audio = r?.options?.gameAudio || gameAudio;
      audio?.play?.('training_countdown', 1.0, 200);
    }

    store.updateLiveTelemetry({
      viewerState: 'preroll-countdown',
      cursorFrame: startIdx,
      targetFrame: baseTarget,
      prerollRemainingSec: visibleCountdownSec,
    });
  }

  clearReplay() {
    const r = this.runtime;
    this._silenceContinuousAudio();
    this.frames = [];
    this.frameSlots = [];
    this.resolvedRoster = [];
    this.slotKeyToCarIndex = {};
    this._causalFreeCarSet.clear();
    this.localTeam = 0;
    this.activePovCarIndex = 0;
    this.activePovSlotKey = 1;
    this.activePovTeam = 0;
    this._bindTimelines(null, null);
    this.cursor = 0;
    this.targetFrame = 0;
    this._scrubAccumulator = 0;
    this._interveneStartFrame = 0;
    this._interveneElapsedTicks = 0;
    this._lastCountdownSecBeep = -1;
    this._lastDispatchedCursorFrame = -1;
    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: false,
      carEntries: [],
    });
    if (r) {
      r.playerCarIndex = 0;
      if (r.arena) {
        r.arena.playerCarIndex = 0;
        if (r.arena.cars) {
          if (r.arena.cars[0]) r.arena.cars[0].visible = true;
          for (let i = 1; i < r.arena.cars.length; i++) {
            if (r.arena.cars[i]) {
              r.arena.cars[i].visible = false;
            }
            r.arena.resetCarBoosts?.(i);
            r.arena.carDemolitions?.[i]?.stop?.();
          }
        }
      }
      if (r.physics) {
        while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
          r.physics.removeCar(r.physics.numCars - 1);
        }
        const playerTeam = r.teamAssignment?.playerTeam ?? 0;
        r.physics.setCarTeam?.(0, playerTeam);
        r.arena?.setCarTeam?.(0, playerTeam);
      }
      const appState = useAppStore?.getState?.();
      if (appState?.selectedCar) {
        r.changePlayerVehicle?.(appState.selectedCar);
      }
      if (appState?.carColor) {
        r.setCarColor?.(appState.carColor);
      }
      r.syncPlayerMaterialsLoadout?.();
      if (r.keyboard) {
        r.keyboard.ballControlEnabled = r.match?.state?.mode === 'freeplay';
      }
    }
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
      activePovCarIndex: 0,
      activePovSlotKey: 1,
      activePovTeam: 0,
      errorMessage: null,
    });
  }

  onBeforePhysicsTick() {
    const r = this.runtime;
    const store = useReplayViewerStore.getState();
    const state = store.viewerState;
    if (state === 'idle' || this.frames.length === 0) return true;

    if (state === 'intervening') {
      if (r?.keyboard && r.keyboard.ballControlEnabled) {
        r.keyboard.ballControlEnabled = false;
      }
      if (r?.physics) {
        const currentReplayFrameIdx =
          (this._interveneStartFrame || 0) + (this._interveneElapsedTicks || 0);
        this._interveneElapsedTicks = (this._interveneElapsedTicks || 0) + 1;
        this._updateCausalHybridSyncBeforeStep(currentReplayFrameIdx);
        // Step from snapshot[currentReplayFrameIdx] -> snapshot[currentReplayFrameIdx + 1]
        // uses controls recorded in frameSlot[currentReplayFrameIdx + 1]
        this._applyNonPovRecordedControlsAtFrame(currentReplayFrameIdx + 1);
      }
      return true;
    }

    if (state === 'preroll-countdown') {
      const targetIdx = Math.max(
        0,
        Math.min(this.frames.length - 1, Math.round(this.targetFrame))
      );
      const nextCursor = Math.min(targetIdx, Math.round(this.cursor) + 1);
      this.cursor = nextCursor;
      this._applyFrameAtCursor(true, true, { preserveEngineTick: true });

      const remFrames = Math.max(0, targetIdx - nextCursor);
      const downSec = store.downCounterSec ?? 0;
      const audio = r?.options?.gameAudio || gameAudio;

      if (remFrames <= 0) {
        this._handoffToLiveFreeplay(targetIdx);
        audio?.play?.('match_start_go', 1.0, 200);
        this._lastCountdownSecBeep = -1;
        store.updateLiveTelemetry({
          viewerState: 'intervening',
          cursorFrame: targetIdx,
          targetFrame: targetIdx,
          prerollRemainingSec: 0,
        });
        return false;
      }

      const countdownSec = Math.ceil(remFrames / 120);
      const visibleCountdownSec =
        downSec > 0 && countdownSec >= 1 && countdownSec <= downSec ? countdownSec : 0;
      if (
        visibleCountdownSec >= 1 &&
        visibleCountdownSec !== this._lastCountdownSecBeep
      ) {
        this._lastCountdownSecBeep = visibleCountdownSec;
        audio?.play?.('training_countdown', 1.0, 200);
      }

      if (
        remFrames % 6 === 0 ||
        remFrames % 120 === 0 ||
        visibleCountdownSec !== store.prerollRemainingSec
      ) {
        store.updateLiveTelemetry({
          cursorFrame: nextCursor,
          prerollRemainingSec: visibleCountdownSec,
        });
      }
      return false;
    }

    if (state === 'forwarding' || state === 'rewinding') {
      const stepPerTick = (store.effectiveFlowPct || 100) / 100;
      const signedStep = state === 'rewinding' ? -stepPerTick : stepPerTick;
      this._scrubAccumulator = (this._scrubAccumulator || 0) + signedStep;
      const wholeSteps = Math.trunc(this._scrubAccumulator);
      if (wholeSteps !== 0) {
        this._scrubAccumulator -= wholeSteps;
        const maxIdx = Math.max(0, this.frames.length - 1);
        const nextIdx = Math.max(0, Math.min(maxIdx, Math.round(this.cursor) + wholeSteps));
        this.cursor = nextIdx;
        this.targetFrame = nextIdx;
        this._applyFrameAtCursor(false, state === 'forwarding', {
          preserveEngineTick: true,
        });
        this._uiSyncTick = ((this._uiSyncTick || 0) + 1) & 3;
        if (this._uiSyncTick === 0 || Math.abs(wholeSteps) === 1) {
          store.updateLiveTelemetry({
            cursorFrame: nextIdx,
            targetFrame: nextIdx,
          });
        }
      }
      return false;
    }

    if (state === 'playing') {
      const stepPerTick = (store.effectiveFlowPct || 100) / 100;
      this.cursor = Math.min(Math.max(0, this.frames.length - 1), this.cursor + stepPerTick);
      const rounded = Math.round(this.cursor);
      this.targetFrame = rounded;
      this._applyFrameAtCursor(true, true, { preserveEngineTick: true });

      this._uiSyncTick = ((this._uiSyncTick || 0) + 1) & 3;
      if (rounded >= this.frames.length - 1) {
        this._silenceContinuousAudio();
        store.updateLiveTelemetry({
          viewerState: 'paused',
          cursorFrame: rounded,
          targetFrame: rounded,
        });
      } else if (this._uiSyncTick === 0) {
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
