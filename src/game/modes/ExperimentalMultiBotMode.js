/**
 * ExperimentalMultiBotMode.js
 * Exhibition & Experimental Multiple Bots Mode ('exp-multi-bots') powered by
 * Native SafeTensors RLBot policies and 448-float Compact State Goal Replay.
 */

import { BaseGameMode } from './BaseGameMode.js';
import {
  DEFAULT_CAR_CONTROLS,
  ensureExperimentalEngine,
  isExperimentalEngineReady,
} from '../../ai/experimental/ExperimentalBotAgent.js';
import { INCIDENT_EVENT_TYPES, MATCH_SIGNALS } from '../../physics/RocketSimConstants.js';
import {
  ReplayRingBuffer,
  REPLAY_BUFFER_MODES,
  COUNTDOWN_REPLAY_CAPACITY_TICKS,
} from '../../replay/ReplayRingBuffer.js';
import { ReplayTimelineController } from '../../replay/ReplayTimelineController.js';
import { PodiumCelebrationController } from './PodiumCelebrationController.js';
import {
  useExpMultiBotsStore,
  getExpColorSwatch,
} from '../../stores/expMultiBotsStore';
import { hudStore } from '../../stores/hudStore';
import { setNameTagRuntimeState } from '../../config/nameTagConfig.ts';
import {
  getExpModeAudio,
  getExpCarDisplayName,
  publishExpSpawnedCarsTelemetry,
  applyExpRosterAndStartMatch,
  resetExpMultiCarKickoffSpawns,
  beginExpKickoffCountdown,
  triggerExpSandboxAction,
} from './exp-multi-bots/ExpMultiBotRosterHelper.js';
import {
  POST_GOAL_CELEBRATION_TICKS,
  POST_GOAL_FREEZE_DELAY_TICKS,
  retainExpMatchReplayAndNotify,
  finishExpMultiBotMatch,
  beginExpMultiBotGoalReplay,
  completeExpPostGoalOrReplayTransition,
  stepExpMultiBotReplayUpdate,
} from './exp-multi-bots/ExpMultiBotReplayHelper.js';

export class ExperimentalMultiBotMode extends BaseGameMode {
  constructor(runtime) {
    super('exp-multi-bots', runtime);
    this.spawnedCars = [];
    this.activeCarsList = [];
    this.carControlsMap = new Map();
    this.humanPlayerCarIndex = -1;

    this.countdownTicks = 0;
    this.kickoffTick = 0;
    this.ticksSinceKickoff = 0;
    this.lastKickoffStartTick = 0;
    this.clockStarted = false;
    this.clockTickAccum = 0;
    this.remainingSec = 300;
    this.isOvertime = false;
    this.isMatchEnded = false;
    this.matchPhase = 'kickoff (3)';
    this.blueScore = 0;
    this.orangeScore = 0;
    this.goalResetTicks = 0;
    this.kickoffPermutationSeed = 0;
    this._nextReplaySignalId = 1;
    this._pendingFrameSignals = [];

    // 448-float Compact State Goal & Match Replay Ring Buffer (full match capacity @ 120Hz)
    this.replayRingBuffer = new ReplayRingBuffer({
      mode: REPLAY_BUFFER_MODES.COUNTDOWN_MATCH,
      capacityTicks: COUNTDOWN_REPLAY_CAPACITY_TICKS,
    });
    this.replayController = new ReplayTimelineController({
      engine: runtime?.physics || null,
      ringBuffer: this.replayRingBuffer,
    });
    this.podiumController = new PodiumCelebrationController(runtime);
    if (runtime && !runtime.podiumController) {
      runtime.podiumController = this.podiumController;
    }
    this.isReplayActive = false;
    this.replayCameraMode = 'director'; // 'director' | 'pov'
    this.pendingMatchEndAfterReplay = false;
    this.pendingMatchWinner = null;

    this._resetPlayTouchAndGoalState();

    this._keyDownHandler = null;
    useExpMultiBotsStore.getState().setRuntimeHandlers({
      onPreloadEngines: () => this._preloadNativeModels(),
    });
  }

  _emitReplaySignal(signalType, param1 = 0, param2 = 0, explicitTick = null) {
    const sim = this.runtime?.physics;
    const currentTick =
      explicitTick !== null
        ? Math.floor(explicitTick)
        : Math.floor(sim?.getHeaderView?.()?.tickCount ?? 0);
    const sig = {
      signalId: this._nextReplaySignalId++,
      signalType,
      frameId: currentTick,
      param1,
      param2,
    };
    sim?.pushSignalEvent?.(sig.signalType, sig.frameId, sig.param1, sig.param2, sig.signalId);
    const slot = this.replayRingBuffer?.findFrameByTick?.(currentTick);
    if (slot) {
      this.replayRingBuffer.appendSignal(currentTick, sig);
    } else {
      this._pendingFrameSignals.push(sig);
    }
    return sig;
  }

  _resetPlayTouchAndGoalState() {
    this.lastTouchByTeam = { 0: null, 1: null };
    this.prevTouchByTeam = { 0: null, 1: null };
    this.goalIncidentTick = -1;
    this.goalScoringTeam = 0;
    this.goalScorerCarIndex = 0;
    this.goalScorerName = null;
    this.goalScorerTouchTick = -1;
    this.goalAssistName = null;
    this.goalBallSpeedKph = null;
    this.frozenGoalBallState = null;
    this.prevBallVelX = 0;
    this.prevBallVelY = 0;
    this.prevBallVelZ = 0;
  }

  onEnter() {
    const r = this.runtime;
    const store = useExpMultiBotsStore.getState();

    if (r) {
      r.podiumController = this.podiumController;
    }
    if (r?.physics && this.replayController.engine !== r.physics) {
      this.replayController.attach(r.physics, this.replayRingBuffer);
    }

    store.setRuntimeHandlers({
      onApplyRosterAndStart: () => this.applyRosterAndStartMatch(),
      onSelectCameraCar: (carIdx) => this._applyCameraCarIndex(carIdx),
      onSpeedMultiplierChange: (mult) => this._applySpeedMultiplier(mult),
      onUnlimitedBoostChange: (unlimited) => {
        r.physics?.setUnlimitedBoost?.(Boolean(unlimited));
      },
      onTriggerAction: (action) => this.triggerSandboxAction(action),
      onHotSwapSlotBotType: (team, slotIndex, botType) =>
        this._hotSwapSlotBotType(team, slotIndex, botType),
      onHotSwapSlotColor: () => this._syncCarColorsFromStore(),
      onPreloadEngines: () => this._preloadNativeModels(),
    });

    this._bindPovHotkeys();
    this._preloadNativeModels();
    this.applyRosterAndStartMatch();
  }

  onLeave() {
    const r = this.runtime;
    this._unbindPovHotkeys();

    this.podiumController?.exitPodium?.();
    this.replayController?.endReplaySession?.();
    this.replayRingBuffer?.clear?.();
    this.isReplayActive = false;
    if (r) {
      r.goalReplayCameraOverrideActive = false;
    }

    r.interpolator?.setTrainingPhysicsRate?.(120);
    if (r.physics) {
      while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
        r.physics.removeCar(r.physics.numCars - 1);
      }
      r.physics.setSimulationFrozen?.(false, 0, false);
      r.physics.setUnlimitedBoost?.(true);
    }
    if (r.arena?.cars) {
      for (let i = 1; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) r.arena.cars[i].visible = false;
      }
    }
    if (r) {
      r.playerCarIndex = 0;
      if (r.arena) r.arena.playerCarIndex = 0;
    }

    useExpMultiBotsStore.getState().updateLiveTelemetry({
      matchActive: false,
    });
  }

  async _preloadNativeModels() {
    await Promise.all([
      ensureExperimentalEngine('nexto'),
      ensureExperimentalEngine('necto'),
    ]);
    useExpMultiBotsStore.getState().updateLiveTelemetry({
      nextoLoaded: isExperimentalEngineReady('nexto'),
      nectoLoaded: isExperimentalEngineReady('necto'),
    });
  }

  _bindPovHotkeys() {
    this._unbindPovHotkeys();
    if (typeof window === 'undefined') return;

    this._keyDownHandler = (e) => {
      if (this.runtime?.match?.state?.mode !== 'exp-multi-bots') return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      let keyNum = -1;
      if (e.code >= 'Digit1' && e.code <= 'Digit6') {
        keyNum = Number(e.code.replace('Digit', ''));
      } else if (e.code >= 'Numpad1' && e.code <= 'Numpad6') {
        keyNum = Number(e.code.replace('Numpad', ''));
      }

      if (keyNum >= 1 && keyNum <= 6) {
        const store = useExpMultiBotsStore.getState();
        if (store.playerParticipation === 'none' && !this.isReplayActive) {
          const targetIdx = keyNum - 1;
          if (targetIdx >= 0 && targetIdx < this.spawnedCars.length) {
            e.preventDefault();
            store.setActiveCameraCarIndex(targetIdx);
          }
        }
      }
    };

    window.addEventListener('keydown', this._keyDownHandler);
  }

  _unbindPovHotkeys() {
    if (this._keyDownHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._keyDownHandler);
      this._keyDownHandler = null;
    }
  }

  _applySpeedMultiplier(multiplierPct = 100) {
    const r = this.runtime;
    if (!r?.interpolator) return;
    const mult = Math.max(100, Math.min(400, Number(multiplierPct) || 100));
    const targetRate = Math.round(120 * (mult / 100));
    r.interpolator.setTrainingPhysicsRate?.(targetRate);
  }

  _applyCameraCarIndex(carIdx = 0) {
    const r = this.runtime;
    if (!r) return;
    const maxIdx = Math.max(0, this.spawnedCars.length - 1);
    const clamped = Math.max(0, Math.min(maxIdx, Math.round(carIdx)));
    r.playerCarIndex = clamped;
    if (r.arena) {
      r.arena.playerCarIndex = clamped;
    }
  }

  _hotSwapSlotBotType(team, slotIndex, botType) {
    const entry = this.spawnedCars.find(
      (c) => c.team === team && c.teamSlotIndex === slotIndex
    );
    if (!entry) return;
    entry.botType = botType;
    entry.label = entry.isPlayer
      ? `P1 (${team === 0 ? 'Blue' : 'Orange'})`
      : `${botType.toUpperCase()} #${entry.keyNumber}`;
    if (entry.agent) {
      entry.agent.setBotType(botType);
    }
    this._publishSpawnedCarsTelemetry();
  }

  _syncCarColorsFromStore() {
    const r = this.runtime;
    const store = useExpMultiBotsStore.getState();
    for (const entry of this.spawnedCars) {
      const slotList = entry.team === 0 ? store.blueSlots : store.orangeSlots;
      const cfg = slotList[entry.teamSlotIndex];
      if (!cfg) continue;
      const swatch = getExpColorSwatch(cfg.colorSlot);
      entry.colorSlot = swatch.id;
      entry.colorHex = swatch.hex;
      entry.colorName = swatch.name;
      r.arena?.setCarColor?.(entry.carIndex, swatch.hex);
    }
    this._publishSpawnedCarsTelemetry();
  }

  _publishSpawnedCarsTelemetry() {
    publishExpSpawnedCarsTelemetry(this);
  }

  getCarControls(carIndex) {
    return this.carControlsMap.get(carIndex) || this.runtime?.neutralControls || DEFAULT_CAR_CONTROLS;
  }

  async applyRosterAndStartMatch() {
    return applyExpRosterAndStartMatch(this);
  }

  _resetMultiCarKickoffSpawns() {
    resetExpMultiCarKickoffSpawns(this);
  }

  _beginKickoffCountdown() {
    beginExpKickoffCountdown(this);
  }

  triggerSandboxAction(action) {
    triggerExpSandboxAction(this, action);
  }

  _recordCarBallTouch(carIndex, tick) {
    if (this.isReplayActive || this.isMatchEnded) return;
    if (this.goalIncidentTick >= 0 && tick > this.goalIncidentTick) return;
    const entry = this.spawnedCars[carIndex];
    if (!entry) return;

    const team = entry.team === 1 ? 1 : 0;
    const playerName = getExpCarDisplayName(entry, this.spawnedCars);
    const prevLast = this.lastTouchByTeam[team];

    if (prevLast && prevLast.carIndex !== carIndex) {
      this.prevTouchByTeam[team] = { ...prevLast };
    }

    this.lastTouchByTeam[team] = {
      carIndex,
      team,
      tick: Math.floor(tick),
      playerName,
    };
  }

  onPhysicsEvent(event) {
    if (!event || this.isReplayActive || this.isMatchEnded) return;
    const currentTick = Math.floor(this.runtime?.physics?.getHeaderView?.()?.tickCount ?? 0);
    const eventTick = typeof event.tick === 'number' && event.tick > 0 ? event.tick : currentTick;

    // Record every physics incident into the replay ring buffer so replay audio/VFX are accurate
    if (this.replayRingBuffer && this.countdownTicks <= 0) {
      this.replayRingBuffer.appendIncident(eventTick, event);
    }

    if (event.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || event.type === 0x01) {
      const carIndex = event.carIndex ?? event.primaryId ?? -1;
      if (carIndex >= 0 && carIndex < this.spawnedCars.length) {
        this._recordCarBallTouch(carIndex, eventTick);
      }
    }
  }

  _retainMatchReplayAndNotify(winnerTeam) {
    retainExpMatchReplayAndNotify(this, winnerTeam);
  }

  _finishMatch(winnerTeam) {
    finishExpMultiBotMatch(this, winnerTeam);
  }

  _beginGoalReplay() {
    beginExpMultiBotGoalReplay(this);
  }

  _completePostGoalOrReplayTransition() {
    completeExpPostGoalOrReplayTransition(this);
  }

  skipGoalReplay() {
    if (!this.isReplayActive && this.goalResetTicks <= 0) return;
    this.goalResetTicks = 0;
    completeExpPostGoalOrReplayTransition(this);
  }

  onBeforePhysicsTick() {
    const r = this.runtime;
    const sim = r?.physics;
    if (!sim || this.spawnedCars.length === 0) return true;
    if (this.isReplayActive || this.isMatchEnded) return false;

    const store = useExpMultiBotsStore.getState();
    const audio = getExpModeAudio(r);

    // 1. Handle 3-2-1-Go Kickoff Countdown Phase
    if (this.countdownTicks > 0) {
      for (const entry of this.spawnedCars) {
        sim.setControls(entry.carIndex, r.neutralControls);
        this.carControlsMap.set(entry.carIndex, r.neutralControls);
      }
      this.countdownTicks--;

      if (this.countdownTicks === 240) {
        this.matchPhase = 'kickoff (2)';
        this._emitReplaySignal(MATCH_SIGNALS.KICKOFF_WILL_START, 240, 2);
        audio?.play?.('match_countdown_321', 1.0);
        store.updateLiveTelemetry({ kickoffCountdownSec: 2, matchPhase: this.matchPhase });
        hudStore.getState().setMatchState({ matchPhase: 'kickoff', kickoffCountdown: 2 });
      } else if (this.countdownTicks === 120) {
        this.matchPhase = 'kickoff (1)';
        this._emitReplaySignal(MATCH_SIGNALS.KICKOFF_WILL_START, 120, 1);
        audio?.play?.('match_countdown_321', 1.0);
        store.updateLiveTelemetry({ kickoffCountdownSec: 1, matchPhase: this.matchPhase });
        hudStore.getState().setMatchState({ matchPhase: 'kickoff', kickoffCountdown: 1 });
      } else if (this.countdownTicks === 0) {
        this.matchPhase = this.isOvertime ? 'overtime' : 'playing';
        this.lastKickoffStartTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
        this._emitReplaySignal(MATCH_SIGNALS.KICKOFF_START, 0, 0);
        if (r?.match?.state) {
          r.match.state.phase = 'playing';
          r.match.state.countdown = 0;
        }
        audio?.play?.('match_start_go', 1.0);
        store.updateLiveTelemetry({ kickoffCountdownSec: 0, matchPhase: this.matchPhase });
        hudStore.getState().setMatchState({
          matchPhase: 'playing',
          kickoffCountdown: 0,
        });
      }
      return true;
    }

    // 2. Determine closest car per team to the ball for primary kickoff duty
    const bView = sim.getBallStateView();
    const closestCarPerTeam = { 0: -1, 1: -1 };
    const closestDistPerTeam = { 0: Infinity, 1: Infinity };
    for (const entry of this.spawnedCars) {
      const cv = sim.getCarStateView(entry.carIndex);
      if (!cv || cv.isDemoed) continue;
      const d = Math.hypot(cv.posX - bView.posX, cv.posY - bView.posY);
      if (d < closestDistPerTeam[entry.team]) {
        closestDistPerTeam[entry.team] = d;
        closestCarPerTeam[entry.team] = entry.carIndex;
      }
    }

    // 3. Step all cars (Human Player + Native Bots)
    const pads = sim.getPads();
    let totalInferenceMs = 0;

    for (const entry of this.spawnedCars) {
      const cIdx = entry.carIndex;

      if (entry.isPlayer) {
        const playerCtrl = r.playerControls || r.neutralControls;
        this.carControlsMap.set(cIdx, playerCtrl);
        sim.setControls(cIdx, playerCtrl);
        continue;
      }

      const bot = entry.agent;
      if (!bot) {
        sim.setControls(cIdx, r.neutralControls);
        continue;
      }

      const isPrimaryKickoffCar = closestCarPerTeam[entry.team] === cIdx;
      const ko = bot.getKickoffControls(sim.state, this.kickoffTick, isPrimaryKickoffCar);

      let ctrl;
      if (ko) {
        ctrl = ko;
        bot.overrideControls(ko);
      } else {
        if (bot.tickSkipCounter <= 0) {
          ctrl = bot.decideSync(sim.state, pads, this.activeCarsList);
          bot.tickSkipCounter = bot.tickSkip - 1;
          totalInferenceMs += bot.lastInferenceMs;
        } else {
          bot.tickSkipCounter--;
          ctrl = bot.action;
        }
      }

      this.carControlsMap.set(cIdx, ctrl);
      sim.setControls(cIdx, ctrl);
    }

    const camCarIdx = r.playerCarIndex;
    const camEntry = this.spawnedCars[camCarIdx];
    if (camEntry && !camEntry.isPlayer) {
      const botCtrl = this.carControlsMap.get(camCarIdx) || r.neutralControls;
      r.playerControls = botCtrl;
      r.playerThrottle = botCtrl.throttle ?? 0;
    }

    this.kickoffTick++;
    this._lastStepInferenceMs = totalInferenceMs;
    return true;
  }

  onAfterPhysicsTick() {
    const r = this.runtime;
    const sim = r?.physics;
    if (!sim || this.spawnedCars.length === 0 || this.isReplayActive || this.isMatchEnded) return;

    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const acknowledgedControls = [];
    for (let i = 0; i < this.spawnedCars.length; i++) {
      const cIdx = this.spawnedCars[i].carIndex;
      const ctrl = this.carControlsMap.get(cIdx) || r.neutralControls || DEFAULT_CAR_CONTROLS;
      acknowledgedControls.push({ carIndex: cIdx, controls: { ...ctrl } });
    }
    const pendingSignals =
      this._pendingFrameSignals.length > 0 ? this._pendingFrameSignals.slice() : [];
    this._pendingFrameSignals.length = 0;
    for (let s = 0; s < pendingSignals.length; s++) {
      pendingSignals[s].frameId = currentTick;
    }

    // Always record 448-float compact snapshot + 8-car controls + pending signals into ring buffer
    this.replayRingBuffer.recordFrame(currentTick, sim.state, {
      acknowledgedControls,
      signals: pendingSignals,
    });

    if (this.countdownTicks > 0) return;

    const store = useExpMultiBotsStore.getState();
    const audio = getExpModeAudio(r);
    const bView = sim.getBallStateView();

    // 1. Proximity + impulse touch detection during live play (supplements native CAR_BALL_HIT event)
    if (this.goalResetTicks === 0 && bView) {
      const dvX = bView.velX - this.prevBallVelX;
      const dvY = bView.velY - this.prevBallVelY;
      const dvZ = bView.velZ - (this.prevBallVelZ - 650.0 / 120.0);
      const impulseMag = Math.hypot(dvX, dvY, dvZ);

      let closestCarIdx = -1;
      let closestDist = Infinity;
      for (const entry of this.spawnedCars) {
        const cv = sim.getCarStateView(entry.carIndex);
        if (!cv || cv.isDemoed) continue;
        const dist = Math.hypot(cv.posX - bView.posX, cv.posY - bView.posY, cv.posZ - bView.posZ);
        if (dist < closestDist) {
          closestDist = dist;
          closestCarIdx = entry.carIndex;
        }
      }

      if (closestCarIdx >= 0 && (closestDist <= 168.0 || (closestDist <= 198.0 && impulseMag > 25.0))) {
        this._recordCarBallTouch(closestCarIdx, currentTick);
      }

      this.prevBallVelX = bView.velX;
      this.prevBallVelY = bView.velY;
      this.prevBallVelZ = bView.velZ;
    }

    // 2. Post-goal 30-frame ball flight & freeze inside goal net
    if (
      this.goalResetTicks > 0 &&
      this.goalIncidentTick >= 0 &&
      currentTick >= this.goalIncidentTick + POST_GOAL_FREEZE_DELAY_TICKS
    ) {
      if (!this.frozenGoalBallState && typeof sim.getBallState === 'function') {
        const snapBall = new Float32Array(sim.getBallState());
        for (let i = 12; i < 18; i++) snapBall[i] = 0;
        this.frozenGoalBallState = snapBall;
      }
      if (this.frozenGoalBallState && typeof sim.setBallState === 'function') {
        sim.setBallState(this.frozenGoalBallState);
      }
    }

    // 3. Advance post-goal celebration countdown -> transition to Replay or Kickoff
    if (this.goalResetTicks > 0) {
      this.goalResetTicks--;
      if (this.goalResetTicks <= 0) {
        if (!store.disableGoalReplay) {
          this._beginGoalReplay();
        } else {
          this._completePostGoalOrReplayTransition();
        }
      }
      return;
    }

    // 5. Check Goal Scored
    const goalScored =
      Math.abs(bView.posY) > 5120 && Math.abs(bView.posX) < 893 && bView.posZ < 643;
    if (goalScored) {
      const blueScored = bView.posY > 0;
      const scoringTeam = blueScored ? 0 : 1;
      this.blueScore += blueScored ? 1 : 0;
      this.orangeScore += blueScored ? 0 : 1;

      const ballSpeedUu = Math.hypot(bView.velX, bView.velY, bView.velZ);
      const ballSpeedKph = Math.max(1, Math.round(ballSpeedUu * 0.036));

      const lastTeamTouch = this.lastTouchByTeam[scoringTeam];
      const prevTeamTouch = this.prevTouchByTeam[scoringTeam];

      if (lastTeamTouch) {
        this.goalScorerCarIndex = lastTeamTouch.carIndex;
        this.goalScorerName = lastTeamTouch.playerName;
        this.goalScorerTouchTick = lastTeamTouch.tick;
      } else {
        const fallbackEntry =
          this.spawnedCars.find((c) => c.team === scoringTeam) || this.spawnedCars[0];
        this.goalScorerCarIndex = fallbackEntry ? fallbackEntry.carIndex : 0;
        this.goalScorerName = fallbackEntry
          ? getExpCarDisplayName(fallbackEntry, this.spawnedCars)
          : scoringTeam === 0
          ? 'Blue'
          : 'Orange';
        this.goalScorerTouchTick = -1;
      }

      this.goalAssistName =
        prevTeamTouch &&
        lastTeamTouch &&
        prevTeamTouch.carIndex !== lastTeamTouch.carIndex &&
        lastTeamTouch.tick - prevTeamTouch.tick <= 720
          ? prevTeamTouch.playerName
          : null;

      this.goalIncidentTick = currentTick;
      this.goalScoringTeam = scoringTeam;
      this.goalBallSpeedKph = ballSpeedKph;
      this.frozenGoalBallState = null;

      this.replayRingBuffer.appendIncident(currentTick, {
        type: INCIDENT_EVENT_TYPES.GOAL_SCORED,
        tick: currentTick,
        carIndex: this.goalScorerCarIndex,
        team: scoringTeam,
        posX: bView.posX,
        posY: bView.posY,
        posZ: bView.posZ,
        intensity: ballSpeedUu,
      });
      this._emitReplaySignal(MATCH_SIGNALS.SCORE_UPDATED, this.blueScore, this.orangeScore, currentTick);
      this.replayRingBuffer.appendAudioEvent(currentTick, {
        cueName: 'sfx_goal_poof',
        volume: 1.0,
      });

      audio?.play?.('sfx_goal_poof', 1.0);

      if (this.isOvertime || (this.remainingSec === 0 && this.blueScore !== this.orangeScore)) {
        this.pendingMatchEndAfterReplay = true;
        this.pendingMatchWinner = scoringTeam;
        this._emitReplaySignal(MATCH_SIGNALS.MATCH_ENDED, scoringTeam, 0, currentTick);
        this._emitReplaySignal(MATCH_SIGNALS.PODIUM_START, scoringTeam, 0, currentTick);
        this._retainMatchReplayAndNotify(scoringTeam);
      }

      this.goalResetTicks = store.disableGoalReplay ? 140 : POST_GOAL_CELEBRATION_TICKS;
      this.matchPhase = 'GOAL SCORED!';
      if (r?.match?.state) {
        r.match.state.phase = 'goal';
      }

      store.updateLiveTelemetry({
        blueScore: this.blueScore,
        orangeScore: this.orangeScore,
        matchPhase: this.matchPhase,
        isOvertime: this.isOvertime,
      });
      hudStore.getState().setMatchState({
        matchPhase: 'goal',
        blueScore: this.blueScore,
        orangeScore: this.orangeScore,
        replayScorerName: this.goalScorerName,
        replayScorerTeam: scoringTeam,
        replayBallSpeedKph: ballSpeedKph,
        replayAssistName: this.goalAssistName,
      });
      return;
    }

    // 6. Match Clock Progression
    const ballMoved =
      Math.abs(bView.posX) + Math.abs(bView.posY) > 2.0 ||
      Math.hypot(bView.velX, bView.velY) > 5.0;

    this.ticksSinceKickoff++;
    if (!this.clockStarted && (ballMoved || this.ticksSinceKickoff >= 600)) {
      this.clockStarted = true;
      this.clockTickAccum = 0;
    }

    const prevRemSec = this.remainingSec;
    if (this.clockStarted) {
      this.clockTickAccum++;
      if (this.clockTickAccum >= 120) {
        this.clockTickAccum -= 120;
        if (!this.isOvertime) {
          if (this.remainingSec > 0) {
            this.remainingSec--;
          }
          this._emitReplaySignal(MATCH_SIGNALS.CLOCK_UPDATED_SECONDS, this.remainingSec, 0, currentTick);
          if (this.remainingSec === 60) {
            this._emitReplaySignal(MATCH_SIGNALS.TIME_ALERT_60S, 60, 0, currentTick);
            audio?.play?.('match_60_seconds_left', 1.0, 10000);
          } else if (this.remainingSec === 30) {
            this._emitReplaySignal(MATCH_SIGNALS.TIME_ALERT_30S, 30, 0, currentTick);
            audio?.play?.('match_30_seconds_left', 1.0, 10000);
          } else if (this.remainingSec <= 10 && this.remainingSec >= 1) {
            this._emitReplaySignal(MATCH_SIGNALS.COUNTDOWN_10S, this.remainingSec, 0, currentTick);
            audio?.play?.('match_countdown_10s', 1.0);
          }
        } else {
          this.remainingSec++;
          this._emitReplaySignal(MATCH_SIGNALS.CLOCK_UPDATED_SECONDS, this.remainingSec, 1, currentTick);
        }
      }
    }

    // Zero-second regulation end check (waits for ball to touch ground or tied -> overtime)
    if (!this.isOvertime && this.clockStarted && this.remainingSec === 0) {
      const ballOnGround = Boolean(sim.ballOnGround || bView.posZ <= 108.0);
      if (ballOnGround) {
        if (this.blueScore === this.orangeScore) {
          this.isOvertime = true;
          this.matchPhase = 'overtime';
          this._emitReplaySignal(MATCH_SIGNALS.OVERTIME_START, 0, 0, currentTick);
          audio?.play?.('match_entering_overtime', 1.0, 10000);
          this._resetMultiCarKickoffSpawns();
          this._beginKickoffCountdown();
          return;
        } else {
          this._finishMatch(this.blueScore > this.orangeScore ? 0 : 1);
          return;
        }
      }
    }

    const totalInferenceMs = this._lastStepInferenceMs || 0;
    if (this.ticksSinceKickoff % 8 === 0 || this.remainingSec !== prevRemSec) {
      store.updateLiveTelemetry({
        remainingSec: this.remainingSec,
        isOvertime: this.isOvertime,
        matchPhase: this.matchPhase,
        lastTotalInferenceMs:
          totalInferenceMs > 0
            ? Number(totalInferenceMs.toFixed(3))
            : store.lastTotalInferenceMs,
        nextoLoaded: isExperimentalEngineReady('nexto'),
        nectoLoaded: isExperimentalEngineReady('necto'),
      });
      hudStore.getState().setMatchState({
        remainingSeconds: this.remainingSec,
        isOvertime: this.isOvertime,
        overtimeSeconds: this.isOvertime ? this.remainingSec : 0,
        matchPhase: 'playing',
      });
    }
  }

  update(context) {
    const r = this.runtime;
    const unlimited = useExpMultiBotsStore.getState().unlimitedBoost;

    if (this.isMatchEnded && this.podiumController?.isActive) {
      this.podiumController.update(context);
      this.podiumController.updateCamera(r.camera, context.dt ?? 0.016);
      return;
    }

    if (this.isReplayActive && this.replayController.isActive) {
      stepExpMultiBotReplayUpdate(this, context, unlimited);
      return;
    }

    const { playerCarView } = context;
    if (playerCarView) {
      hudStore
        .getState()
        .setBoost(playerCarView.boost, playerCarView.isBoosting, unlimited);
    }
  }

  onResetKickoff() {
    this.applyRosterAndStartMatch();
  }
}
