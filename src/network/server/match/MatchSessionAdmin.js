import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.js';
import { formatMatchTime } from '../../../utils/AssetResponseValidator.js';
import {
  encodeVisualIdIndex,
  encodeHitboxIdIndex,
  packLoadoutSignalParam2
} from '../../../ui-core/config/vehicleConstants.js';
import {
  MATCH_STATES, applyRosterKickoffSpawns, assignSessionPlayerSlot, removeSessionPlayerSlot,
  reclaimDisconnectedPlayerSlot, updatePlayerLoadout, switchPlayerRoleOrTeam, broadcastRosterUpdate
} from './MatchRosterCoordinator.js';
import {
  collectSessionUserRtt, evaluateControlPacket
} from './MatchControlPacketEvaluator.js';
import {
  getExpectedAckPeerIds, dispatchMatchSignal, handleClientSignalAcks, handleClientCommands,
  handleClientCommand, checkSkipReplayVotes, checkRematchReady, initiateMatchPrepare, checkArenaLoadedBarrier
} from './MatchCommandCoordinator.js';
import {
  ReplayRingBuffer, REPLAY_BUFFER_MODES
} from '../../../replay/ReplayRingBuffer.js';
import {
  DEFAULT_MATCH_DURATION_SECONDS, KICKOFF_TOTAL_TICKS,
  GOAL_CELEBRATION_TICKS, GOAL_REPLAY_DURATION_TICKS,
  DEFAULT_MAX_OVERTIME_SECONDS,
  applyPendingHitboxSwaps, resolvePossessionWinner,
  beginMatchGoalReplay, finishMatchGoalReplay,
  stepMatchSessionFrame, encodeMatchFramePacket
} from './MatchLifecycleStepRunner.js';
import {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET
} from '../../diagnostics/DiagnosticsTestVehicles.js';

export class MatchSessionAdmin {
  constructor(options = {}) {
    this.roomId = options.roomId || `room_${Math.random().toString(36).slice(2, 8)}`;
    this.password = options.password || '';
    this.gameMode = options.gameMode || '3v3';
    this.botFillMode = options.botFillMode || 'no_bots'; // 'no_bots' | 'auto_fill' | 'bots_vs_humans'
    this.isHost = options.isHost ?? true;
    this.externalBotTunnels = Boolean(options.externalBotTunnels);

    this.physicsManager = options.physicsManager;
    this.sessionManager = options.sessionManager;
    this.dataHandler = options.dataHandler || null;
    this.diagnosticsController = options.diagnosticsController || new DiagnosticsTestVehicleController(DEFAULT_DIAGNOSTIC_FLEET);
    this.onClearRetainedReplay = options.onClearRetainedReplay || null;
    this.onRetainCompletedReplay = options.onRetainCompletedReplay || null;

    this.lobbyMode = Boolean(options.lobbyMode);
    this.isTrainingMode = options.isTrainingMode ?? this.lobbyMode;

    this.maxPlayers = this.gameMode === '1v1' ? 2 : (this.gameMode === '2v2' ? 4 : 6);
    this.autoStartWhenFull = options.autoStartWhenFull ?? !this.lobbyMode;
    this.skipReplayByDefault = options.skipReplayByDefault !== undefined ? Boolean(options.skipReplayByDefault) : true;

    this.state = MATCH_STATES.LOBBY;
    this.matchTick = 0;
    this.clockDuration = options.matchDurationSeconds ?? options.durationSeconds ?? options.clockDuration ?? DEFAULT_MATCH_DURATION_SECONDS;
    this.clockSecondsRemaining = this.clockDuration;
    this.isOvertime = false;
    this.overtimeSeconds = 0;
    this.clockDirection = this.isTrainingMode ? 'up' : 'down';
    this.maxOvertimeSeconds = options.maxOvertimeSeconds ?? DEFAULT_MAX_OVERTIME_SECONDS;
    this.blueScore = 0;
    this.orangeScore = 0;
    this.winner = null;
    this.winReason = 0; // 0: score, 1: possession tie-break, 2: forfeit

    this.players = new Map();
    this.spectators = new Map();
    this.disconnectedPlayerSlots = new Map();
    this.activeSignals = new Map();
    this.replaySignalLog = [];
    this._currentFrameSignals = [];
    this.replayBuffer = new ReplayRingBuffer({
      mode: options.isTrainingMode ? REPLAY_BUFFER_MODES.COUNTUP_FIFO : REPLAY_BUFFER_MODES.COUNTDOWN_MATCH,
      capacityTicks: options.replayCapacityTicks
    });
    this.nextSignalId = 0;
    this.matchSequence = 0;

    this.processedClientCommands = new Map(); // sessionId -> Set<number>
    this.skipReplayVotes = new Set();
    this.rematchVotes = new Set();
    this.forfeitVotes = new Set();

    this.rttIntervalTicks = 600;
    this.lastRttBroadcastTick = -600;
    this.cachedAllUserRtt = null;

    this.kickoffWillStartAt = -1;
    this.kickoffStartedAtTick = -1;
    this.lastKickoffWillStartFrame = -1;
    this.lastGoalIncidentFrame = -1;
    this.goalReplayLookbackSeconds = options.goalReplayLookbackSeconds ?? 10.0;
    this.goalReplayPostGoalSeconds = options.goalReplayPostGoalSeconds ?? 3.0;
    this.clockStarted = false;
    this.requireTouchToStartClock = options.requireTouchToStartClock ?? true;
    this.goalBufferTicks = -1;
    this.replayTicksRemaining = -1;
    this.startCountdownTicks = -1;
    this.prepareTimeoutTicks = -1;
    this.willResumeUntilTick = -1;
    this.podiumDelayTicks = 0;
  }

  get matchState() { return this.state; }
  set matchState(v) { this.state = v; }
  get hasFirstTouchOccurred() { return this.clockStarted; }
  set hasFirstTouchOccurred(v) { this.clockStarted = Boolean(v); }
  get overtimeSecondsElapsed() { return this.overtimeSeconds; }
  set overtimeSecondsElapsed(v) { this.overtimeSeconds = v; }

  assignPlayerSlot(sessionId, playerName = 'Player', role = 'player', preferredTeam = null, loadoutOptions = {}, colorSlot = null) {
    return assignSessionPlayerSlot(this, sessionId, playerName, role, preferredTeam, loadoutOptions, colorSlot);
  }

  removePlayerSession(sessionId) {
    removeSessionPlayerSlot(this, sessionId);
  }

  reclaimPlayerSession(sessionId, requestedEntityId = -1, preferredTeam = null) {
    return reclaimDisconnectedPlayerSlot(this, sessionId, requestedEntityId, preferredTeam);
  }

  updatePlayerLoadout(sessionId, visualIdOrIndex, colorSlot = null, hitboxIdOrIndex = null, extraLoadout = null) {
    return updatePlayerLoadout(this, sessionId, visualIdOrIndex, colorSlot, hitboxIdOrIndex, extraLoadout);
  }

  switchPlayerRoleOrTeam(sessionId, role, team) {
    return switchPlayerRoleOrTeam(this, sessionId, role, team);
  }

  getMatchRosterMetadata() {
    const roster = [];
    for (const p of this.players.values()) {
      roster.push({
        carIndex: p.entityId,
        entityId: p.entityId,
        sessionId: p.sessionId,
        name: p.name || `Car ${p.entityId}`,
        team: p.team ?? 0,
        role: p.role || 'player',
        isBot: Boolean(p.isBot),
        visualId: p.visualId || 'octane',
        visualIndex: p.visualIndex ?? encodeVisualIdIndex(p.visualId || 'octane'),
        hitboxId: p.hitboxId || 'hitbox-octane',
        hitboxIndex: p.hitboxIndex ?? encodeHitboxIdIndex(p.hitboxId || 'hitbox-octane'),
        colorSlot: p.colorSlot ?? (p.team === 0 ? 3 : 0),
        colorHex: p.colorHex || (p.team === 0 ? '#42a5f5' : '#ff7043'),
        paintFinish: p.paintFinish || 'metallic',
        boostVisual: p.boostVisual || 'cartoon',
        boostAudio: p.boostAudio || 'rush'
      });
    }
    return roster;
  }

  setGameMode(gameMode, durationSeconds = null) {
    if (gameMode === '1v1' || gameMode === '2v2' || gameMode === '3v3') {
      this.gameMode = gameMode;
      this.maxPlayers = gameMode === '1v1' ? 2 : (this.gameMode === '2v2' ? 4 : 6);
    }
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      this.clockDuration = durationSeconds;
      if (this.state === MATCH_STATES.LOBBY) {
        this.clockSecondsRemaining = durationSeconds;
      }
    }
    if (this.state !== MATCH_STATES.LOBBY && (this.botFillMode === 'auto_fill' || this.botFillMode === 'bots_vs_humans')) {
      this.applyBotFillPolicy();
    }
  }

  setBotFillMode(botFillMode = 'no_bots') {
    const valid = ['no_bots', 'auto_fill', 'bots_vs_humans', 'custom'];
    if (valid.includes(botFillMode)) {
      this.botFillMode = botFillMode;
    }
    if (this.state !== MATCH_STATES.LOBBY) {
      this.applyBotFillPolicy();
    }
  }

  addBotPlayer(preferredTeam = 1, botName = null, visualId = 'octane') {
    if (this.players.size >= 6) return null;
    let botIdx = 1;
    while (this.players.has(`bot_${botIdx}`)) {
      botIdx++;
    }
    const sid = `bot_${botIdx}`;
    const resolvedName = botName || `Nexto #${botIdx}`;
    return this.assignPlayerSlot(sid, resolvedName, 'player', preferredTeam, visualId);
  }

  applyBotFillPolicy() {
    if (this._applyingBotFillPolicy) return;
    this._applyingBotFillPolicy = true;
    try {
      const maxPerTeam = Math.max(1, Math.floor(this.maxPlayers / 2));
      if (this.botFillMode === 'no_bots') {
        for (const [sid, p] of Array.from(this.players.entries())) {
          if (p.isBot && sid !== 'bot') {
            this.removePlayerSession(sid);
          }
        }
        return;
      }

      if (this.botFillMode === 'custom') {
        return;
      }

      // Remove previously auto-filled bots before recomputing team balance
      for (const [sid, p] of Array.from(this.players.entries())) {
        if (p.isBot && String(sid).startsWith('bot_fill_')) {
          this.removePlayerSession(sid);
        }
      }

      if (this.botFillMode === 'bots_vs_humans') {
        // Place all humans on Team 0 (Blue) up to maxPerTeam, and fill Team 1 (Orange) with Nexto Bots
        for (const [sid, p] of Array.from(this.players.entries())) {
          if (!p.isBot && p.team !== 0) {
            this.switchPlayerRoleOrTeam(sid, 'player', 0);
          }
        }
        let orangeCount = 0;
        for (const p of this.players.values()) {
          if (p.team === 1) orangeCount++;
        }
        let fillSeq = 1;
        while (orangeCount < maxPerTeam && this.players.size < this.maxPlayers) {
          const sid = `bot_fill_${fillSeq}`;
          this.assignPlayerSlot(sid, `Nexto #${fillSeq}`, 'player', 1, 'octane');
          fillSeq++;
          orangeCount++;
        }
        return;
      }

      if (this.botFillMode === 'auto_fill') {
        let blueCount = 0;
        let orangeCount = 0;
        for (const p of this.players.values()) {
          if (p.team === 0) blueCount++;
          else if (p.team === 1) orangeCount++;
        }
        let fillSeq = 1;
        while (blueCount < maxPerTeam && this.players.size < this.maxPlayers) {
          const sid = `bot_fill_${fillSeq}`;
          this.assignPlayerSlot(sid, `Nexto #${fillSeq}`, 'player', 0, 'octane');
          fillSeq++;
          blueCount++;
        }
        while (orangeCount < maxPerTeam && this.players.size < this.maxPlayers) {
          const sid = `bot_fill_${fillSeq}`;
          this.assignPlayerSlot(sid, `Nexto #${fillSeq}`, 'player', 1, 'octane');
          fillSeq++;
          orangeCount++;
        }
      }
    } finally {
      this._applyingBotFillPolicy = false;
    }
    broadcastRosterUpdate(this);
  }

  syncRosterPhysicsEntities() {
    if (!this.physicsManager) return;
    const rosterEntityIds = new Set();
    for (const p of this.players.values()) {
      if (typeof p.entityId !== 'number' || p.entityId < 0) continue;
      rosterEntityIds.add(p.entityId);
      this.physicsManager.registerCarEntity(
        p.entityId,
        p.team ?? (p.entityId % 2),
        p.hitboxId || p.visualId || 'octane'
      );
      this.physicsManager.applySignal('HOTSWAP_HITBOX', {
        carIndex: p.entityId,
        hitboxType: p.hitboxId || p.visualId || 'octane'
      });
    }

    if (!this.lobbyPhysicsActive) {
      for (const activeIdx of Array.from(this.physicsManager.activeCarIndices)) {
        if (!rosterEntityIds.has(activeIdx)) {
          this.physicsManager.unregisterCarEntity(activeIdx);
        }
      }
      const sim = this.physicsManager.sim;
      if (sim && typeof sim.removeCar === 'function') {
        for (let slot = 0; slot < 8; slot++) {
          const isActive = typeof sim.isCarSlotActive === 'function'
            ? sim.isCarSlotActive(slot)
            : false;
          if (isActive && !rosterEntityIds.has(slot)) {
            this.physicsManager.unregisterCarEntity(slot);
          }
        }
      }
    }
  }

  initiateMatchPrepare(durationSeconds = null, timeoutTicks = 240) {
    this.lobbyPhysicsActive = false;
    this.physicsManager?.inputBuffer?.setLobbyMode?.(false);
    if (this.diagnosticsController) {
      this.diagnosticsController.enabled = false;
      if (this.physicsManager) {
        this.diagnosticsController.releasePhysics(this.physicsManager);
      }
    }
    this.state = MATCH_STATES.PREPARE;
    this.applyBotFillPolicy();
    this.syncRosterPhysicsEntities();
    this.physicsManager?.sim?.setUnlimitedBoost?.(false);
    this.physicsManager?.restoreSolidCollisions?.();
    initiateMatchPrepare(this, durationSeconds, timeoutTicks);
  }

  checkArenaLoadedBarrier() {
    return checkArenaLoadedBarrier(this);
  }

  triggerStartCountdown(countdownSeconds = 3) {
    if (this.state !== MATCH_STATES.LOBBY) return;
    this.state = MATCH_STATES.COUNTDOWN;
    this.startCountdownTicks = Math.round(countdownSeconds * 120);
  }

  forceStartMatch(durationSeconds = null) {
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      this.clockDuration = durationSeconds;
    }
    let hasRemoteHuman = false;
    for (const [sid, p] of this.players.entries()) {
      if (!p.isBot && sid !== 'host') {
        hasRemoteHuman = true;
        break;
      }
    }
    if (hasRemoteHuman && this.state === MATCH_STATES.LOBBY) {
      this.initiateMatchPrepare(this.clockDuration, 120);
    } else {
      this.startMatch(this.clockDuration);
    }
  }

  startMatch(durationSeconds) {
    if (typeof this.onClearRetainedReplay === 'function') {
      this.onClearRetainedReplay();
    }
    this.isTrainingMode = false;
    this.lobbyPhysicsActive = false;
    this.physicsManager?.inputBuffer?.setLobbyMode?.(false);
    if (this.diagnosticsController) {
      this.diagnosticsController.enabled = false;
      if (this.physicsManager) {
        this.diagnosticsController.releasePhysics(this.physicsManager);
      }
    }
    this.state = MATCH_STATES.KICKOFF;
    this.applyBotFillPolicy();
    this.syncRosterPhysicsEntities();
    this.matchTick = 0;
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      this.clockDuration = durationSeconds;
    } else if (typeof this.clockDuration !== 'number' || !Number.isFinite(this.clockDuration) || this.clockDuration < 0) {
      this.clockDuration = DEFAULT_MATCH_DURATION_SECONDS;
    }
    this.clockSecondsRemaining = this.clockDuration;
    this.isOvertime = this.clockDuration === 0;
    this.overtimeSeconds = 0;
    this.clockDirection = this.isOvertime ? 'up' : 'down';
    this.blueScore = 0;
    this.orangeScore = 0;
    this.winner = null;
    this.winReason = 0;
    this.lastKickoffWillStartFrame = -1;
    this.lastGoalIncidentFrame = -1;
    this.replaySignalLog = [];
    this._currentFrameSignals = [];
    this.replayBuffer?.configureMode(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    this.activeSignals.clear();
    this.skipReplayVotes.clear();
    this.rematchVotes.clear();
    this.forfeitVotes.clear();
    this.disconnectedPlayerSlots.clear();

    if (this.physicsManager) {
      this.physicsManager.isPaused = false;
      this.physicsManager.sim?.setUnlimitedBoost?.(false);
      this.physicsManager.restoreSolidCollisions?.();
      this.physicsManager.applySignal(MATCH_SIGNALS.MATCH_STARTED);
      this.physicsManager.resetKickoff(0);
      this.applyRosterKickoffSpawns();
      this.matchTick = this.physicsManager.currentTick;
    }

    const modeCode = this.gameMode === '1v1' ? 1 : (this.gameMode === '2v2' ? 2 : 3);
    this.dispatchSignal(MATCH_SIGNALS.MATCH_INITIALIZED, this.matchTick, modeCode, this.clockDuration);
    this.dispatchSignal(MATCH_SIGNALS.MATCH_STARTED, this.matchTick, this.clockSecondsRemaining, 0);
    for (const p of this.players.values()) {
      if (typeof p.entityId === 'number' && p.entityId >= 0) {
        this.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, this.matchTick, p.entityId, p.team ?? 0);
        this.dispatchSignal(
          MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
          this.matchTick,
          p.entityId,
          packLoadoutSignalParam2(p.visualIndex ?? p.visualId ?? 'octane', p.colorSlot ?? 0, p.hitboxIndex ?? p.hitboxId ?? 'hitbox-octane', {
            paintFinish: p.paintFinish || 'metallic',
            boostVisual: p.boostVisual || 'cartoon',
            boostAudio: p.boostAudio || 'rush'
          })
        );
      }
    }
    this.dispatchSignal(MATCH_SIGNALS.SCORE_UPDATED, this.matchTick, this.blueScore, this.orangeScore);
    if (this.isOvertime) {
      this.pendingOvertimeAfterGoal = true;
      this.isOvertime = false;
    }

    this.startKickoffSequence(KICKOFF_TOTAL_TICKS);
  }

  enterLobbyMode(options = {}) {
    this.lobbyMode = true;
    this.isTrainingMode = true;
    this.clockDirection = 'up';
    this.state = MATCH_STATES.LOBBY;
    this.winner = null;
    this.winReason = 0;
    this.activeSignals.clear();
    if (this.sessionManager?.signalBuffer?.clear) {
      this.sessionManager.signalBuffer.clear();
    }
    this.lobbyPhysicsActive = options.lobbyPhysicsActive !== undefined ? Boolean(options.lobbyPhysicsActive) : true;
    this.replayBuffer?.configureMode(REPLAY_BUFFER_MODES.COUNTUP_FIFO);
    const prevApplying = this._applyingBotFillPolicy;
    this._applyingBotFillPolicy = true;
    try {
      for (const [sid, p] of Array.from(this.players.entries())) {
        if (p.isBot && String(sid).startsWith('bot_fill_')) {
          this.removePlayerSession(sid);
        }
      }
    } finally {
      this._applyingBotFillPolicy = prevApplying;
    }
    if (this.physicsManager) {
      this.physicsManager.inputBuffer?.setLobbyMode?.(true);
      for (const [sid, p] of this.players.entries()) {
        if (p.isBot && typeof p.entityId === 'number' && p.entityId >= 0) {
          this.physicsManager.unregisterCarEntity(p.entityId);
        } else if (!p.isBot && typeof p.entityId === 'number' && p.entityId >= 0) {
          this.physicsManager.registerCarEntity(
            p.entityId,
            p.team ?? (p.entityId % 2),
            p.hitboxId || p.visualId || 'octane'
          );
        }
      }
      this.applyRosterKickoffSpawns();
      this.physicsManager.setInputMask(false);
      this.physicsManager.isPaused = false;
      this.physicsManager.sim?.setUnlimitedBoost?.(true);
      this.physicsManager.setLobbyGhostMode(options.ghostCars !== false, {
        mode: options.mode || options.ghostMode || 'ghost_passthrough',
        hostCarIndex: options.hostCarIndex ?? 0,
        hostInteractsWithBall: options.hostInteractsWithBall ?? true,
        broadcastHostOnly: options.broadcastHostOnly ?? false,
        ghostOpacity: options.ghostOpacity ?? options.opacity ?? 0.70,
        ...options
      });
      if (this.diagnosticsController && options.enableDiagnosticsFleet !== false) {
        this.diagnosticsController.enabled = true;
        this.diagnosticsController.configurePhysics(this.physicsManager);
      }
    }
    broadcastRosterUpdate(this);
    return this.state;
  }

  setGhostCarConfig(carIndex, interactWithBall = false, interactWithCars = false, opacity = undefined) {
    return this.physicsManager?.setCarCollisionMask?.(carIndex, interactWithBall, interactWithCars, opacity) || null;
  }

  getCarCollisionConfig(carIndex) {
    return this.physicsManager?.lobbyGhostCoordinator?.getCarGhostState?.(carIndex) || {
      carIndex,
      interactWithBall: true,
      interactWithCars: true,
      isGhost: false,
      opacity: 1.0
    };
  }

  _applyPendingHitboxSwaps() {
    applyPendingHitboxSwaps(this);
  }

  applyRosterKickoffSpawns() {
    applyRosterKickoffSpawns(this);
  }

  resetTrainingPlay() {
    this.state = MATCH_STATES.PLAYING;
    this.goalBufferTicks = -1;
    this.replayTicksRemaining = -1;
    this.kickoffWillStartAt = -1;

    if (this.physicsManager) {
      this._applyPendingHitboxSwaps();
      this.physicsManager.resetKickoff(0);
      this.applyRosterKickoffSpawns();
      this.physicsManager.setInputMask(false);
      this.matchTick = this.physicsManager.currentTick;
    }

    this.dispatchSignal(MATCH_SIGNALS.BALL_RESET, this.matchTick, 0, 0);
  }

  startKickoffSequence(countdownTicks = KICKOFF_TOTAL_TICKS) {
    this.state = MATCH_STATES.KICKOFF;
    this.goalBufferTicks = -1;
    this.replayTicksRemaining = -1;
    this.skipReplayVotes.clear();
    this.clockStarted = !this.requireTouchToStartClock;
    this.kickoffStartedAtTick = -1;

    if (this.physicsManager) {
      this._applyPendingHitboxSwaps();
      this.physicsManager.resetKickoff(0);
      this.applyRosterKickoffSpawns();
      this.matchTick = this.physicsManager.currentTick;
    }

    if (
      this.pendingOvertimeAfterGoal ||
      (!this.isTrainingMode &&
        !this.isOvertime &&
        this.clockSecondsRemaining === 0 &&
        this.blueScore === this.orangeScore)
    ) {
      this.pendingOvertimeAfterGoal = false;
      this.isOvertime = true;
      this.clockDirection = 'up';
      this.overtimeSeconds = 0;
      const staleClockSignalTypes = [
        MATCH_SIGNALS.TIME_ALERT_60S,
        MATCH_SIGNALS.TIME_ALERT_30S,
        MATCH_SIGNALS.COUNTDOWN_10S,
        MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
      ];
      for (const sigType of staleClockSignalTypes) {
        const prev = this.activeSignals.get(sigType);
        if (prev && this.sessionManager?.signalBuffer) {
          this.sessionManager.signalBuffer.retireSignal(prev.signalId);
        }
        this.activeSignals.delete(sigType);
      }
      this.dispatchSignal(MATCH_SIGNALS.OVERTIME_START, this.matchTick, 0, 0);
    }

    this.lastKickoffWillStartFrame = this.matchTick;
    this.kickoffWillStartAt = this.matchTick + countdownTicks;
    this.dispatchSignal(
      MATCH_SIGNALS.KICKOFF_WILL_START,
      this.matchTick,
      this.kickoffWillStartAt,
      this.isOvertime ? 1 : 0
    );

    if (this.physicsManager) {
      this.physicsManager.applySignal(MATCH_SIGNALS.KICKOFF_WILL_START, {
        kickoffWillStartAt: this.kickoffWillStartAt
      });
    }
  }

  getExpectedAckPeerIds() {
    return getExpectedAckPeerIds(this);
  }

  dispatchSignal(signalType, frameId, param1 = 0, param2 = 0) {
    return dispatchMatchSignal(this, signalType, frameId, param1, param2);
  }

  handleClientSignalAcks(sessionId, acks = []) {
    handleClientSignalAcks(this, sessionId, acks);
  }

  handleClientCommands(sessionId, commands = []) {
    handleClientCommands(this, sessionId, commands);
  }

  handleClientCommand(sessionId, cmd) {
    handleClientCommand(this, sessionId, cmd);
  }

  _checkSkipReplayVotes() {
    checkSkipReplayVotes(this);
  }

  _checkRematchReady() {
    checkRematchReady(this);
  }

  setPaused(pause) {
    if (this.state !== MATCH_STATES.PLAYING && this.state !== MATCH_STATES.PAUSED) return;
    this.state = pause ? MATCH_STATES.PAUSED : MATCH_STATES.PLAYING;
    this.willResumeUntilTick = -1;
    if (this.physicsManager) {
      this.physicsManager.applySignal(
        pause ? MATCH_SIGNALS.MATCH_PAUSED : MATCH_SIGNALS.MATCH_RESUMED,
        { paused: pause }
      );
    }
    this.dispatchSignal(
      pause ? MATCH_SIGNALS.MATCH_PAUSED : MATCH_SIGNALS.MATCH_RESUMED,
      this.matchTick
    );
  }

  requestResumeWithCountdown(countdownSeconds = 5) {
    if (this.state !== MATCH_STATES.PAUSED) return;
    const resumeTicks = Math.max(1, Math.round(countdownSeconds * 120));
    this.willResumeUntilTick = this.matchTick + resumeTicks;
    if (this.physicsManager) {
      this.physicsManager.applySignal(MATCH_SIGNALS.MATCH_WILL_RESUME, {
        targetResumeTick: this.willResumeUntilTick
      });
    }
    this.dispatchSignal(MATCH_SIGNALS.MATCH_WILL_RESUME, this.matchTick, this.willResumeUntilTick, countdownSeconds);
  }

  beginGoalReplay() {
    beginMatchGoalReplay(this, GOAL_REPLAY_DURATION_TICKS);
  }

  finishGoalReplay() {
    finishMatchGoalReplay(this, KICKOFF_TOTAL_TICKS);
  }

  recordSkipReplayInputEdge(sessionId, inputHistory) {
    if (this.state !== MATCH_STATES.REPLAY) return false;
    if (!Array.isArray(inputHistory) || inputHistory.length === 0) return false;
    if (this.skipReplayVotes.has(sessionId)) return true;
    for (let i = 0; i < inputHistory.length; i++) {
      const ctrl = inputHistory[i]?.controls || inputHistory[i];
      if (ctrl?.jump) {
        this.skipReplayVotes.add(sessionId);
        checkSkipReplayVotes(this);
        return true;
      }
    }
    return false;
  }

  resolvePossessionWinner() {
    return resolvePossessionWinner(this);
  }

  endMatch(forcedWinner = null, winReason = 0) {
    this.state = MATCH_STATES.ENDED;
    this.podiumDelayTicks = 360;
    let winner = forcedWinner;
    if (winner === null || winner === undefined) {
      winner = this.blueScore > this.orangeScore ? 0 : (this.orangeScore > this.blueScore ? 1 : 2);
    }
    this.winner = winner;
    this.winReason = winReason;
    if (this.physicsManager) {
      this.physicsManager.applySignal(MATCH_SIGNALS.MATCH_ENDED, { winner, winReason });
    }
    this.activeSignals.delete(MATCH_SIGNALS.KICKOFF_WILL_START);
    this.activeSignals.delete(MATCH_SIGNALS.SCORE_UPDATED);
    this.activeSignals.delete(MATCH_SIGNALS.GOAL_REPLAY_WILL_START);
    if (this.sessionManager?.signalBuffer?.retireByType) {
      this.sessionManager.signalBuffer.retireByType(MATCH_SIGNALS.KICKOFF_WILL_START);
      this.sessionManager.signalBuffer.retireByType(MATCH_SIGNALS.SCORE_UPDATED);
      this.sessionManager.signalBuffer.retireByType(MATCH_SIGNALS.GOAL_REPLAY_WILL_START);
    }
    this.dispatchSignal(MATCH_SIGNALS.MATCH_ENDED, this.matchTick, winner, winReason);
    if (
      this.isHost &&
      typeof this.onRetainCompletedReplay === 'function' &&
      this.replayBuffer &&
      this.replayBuffer.size > 0
    ) {
      const rosterMeta = this.getMatchRosterMetadata();
      this.onRetainCompletedReplay({
        engine: this.physicsManager?.sim || null,
        ringBuffer: this.replayBuffer,
        signals: this.replaySignalLog,
        winnerTeam: winner,
        blueScore: this.blueScore,
        orangeScore: this.orangeScore,
        gameMode: this.gameMode || '3v3',
        durationSeconds: this.clockDuration,
        roster: rosterMeta,
        loadouts: rosterMeta,
      });
    }
  }

  enterPodiumPhase() {
    if (this.state !== MATCH_STATES.ENDED) return;
    this.state = MATCH_STATES.PODIUM;
    this.podiumDelayTicks = 0;
    const winner = this.winner ?? 0;
    const winReason = this.winReason ?? 0;
    if (this.physicsManager) {
      this.physicsManager.applySignal(MATCH_SIGNALS.PODIUM_START, { winner, winReason });
    }
    this.dispatchSignal(MATCH_SIGNALS.PODIUM_START, this.matchTick, winner, winReason);
  }

  stepFrame() {
    return stepMatchSessionFrame(this, {
      GOAL_CELEBRATION_TICKS,
      KICKOFF_TOTAL_TICKS
    });
  }

  _encodeFramePacket(physicsSnapshot) {
    return encodeMatchFramePacket(this, physicsSnapshot);
  }

  collectAllUserRtt() {
    return collectSessionUserRtt(this.sessionManager);
  }

  startTrainingMode() {
    this.isTrainingMode = true;
    this.clockDirection = 'up';
    this.state = MATCH_STATES.PLAYING;
    this.matchTick = 0;
    this.trainingSeconds = 0;
    this.clockSecondsRemaining = 0;
    this.clockStarted = true;
    this.replaySignalLog = [];
    this._currentFrameSignals = [];
    this.replayBuffer?.configureMode(REPLAY_BUFFER_MODES.COUNTUP_FIFO);
    this.activeSignals.clear();

    if (this.physicsManager) {
      this.physicsManager.setInputMask(false);
      this.physicsManager.isPaused = false;
    }
  }

  evaluateUnknownPacket(channelId, packetType, packetData) {
    return evaluateControlPacket(this, channelId, packetType, packetData);
  }

  destroy() {
    this.dispatchSignal(MATCH_SIGNALS.MATCH_DESTROYED, this.matchTick, 0, 0);
    if (this.dataHandler && typeof this.dataHandler.dispatchFrameToSessions === 'function') {
      try {
        const finalBytes = this._encodeFramePacket(null);
        if (finalBytes && finalBytes.length > 0) {
          this.dataHandler.dispatchFrameToSessions(finalBytes);
        }
      } catch (err) {
        console.warn('[MatchSessionAdmin] Failed to flush MATCH_DESTROYED packet on destroy:', err);
      }
    }
    this.players.clear();
    this.spectators.clear();
    this.disconnectedPlayerSlots.clear();
    this.activeSignals.clear();
    this.processedClientCommands.clear();
    this.skipReplayVotes.clear();
    this.rematchVotes.clear();
    this.forfeitVotes.clear();
    this.replaySignalLog = [];
    this._currentFrameSignals = [];
    this.replayBuffer?.clear();
  }
}

