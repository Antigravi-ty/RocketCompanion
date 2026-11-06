/**
 * src/network/server/match/MatchDomainState.ts
 * Explicit domain state container and atomic state/clock/score transition methods
 * for authoritative match sessions.
 */

import {
  MATCH_STATES, DEFAULT_MATCH_DURATION_SECONDS, DEFAULT_MAX_OVERTIME_SECONDS, buildRosterSnapshot,
  type MatchState, type MatchPlayerSlot, type MatchSpectatorSlot, type DisconnectedPlayerSlot,
  type RosterSnapshot, type RosterSessionManagerPort,
} from './matchLoadoutAndSpawnPipeline.ts';
import { buildPlayerHandshakePacketJson, buildSpectatorHandshakePacketJson } from './matchSessionRoleSwitchPipeline.ts';

export interface MatchDomainStateOptions {
  roomId?: string; password?: string; gameMode?: string; botFillMode?: string;
  botsLoadoutConfig?: Record<string, unknown> | null; isHost?: boolean; externalBotTunnels?: boolean;
  lobbyMode?: boolean; isTrainingMode?: boolean; trainingDisableGoalReset?: boolean;
  trainingUnlimitedBoost?: boolean; trainingGoalReplayEnabled?: boolean;
  trainingGoalCelebrationTicks?: number; autoStartWhenFull?: boolean;
  skipReplayByDefault?: boolean; matchDurationSeconds?: number;
  durationSeconds?: number; clockDuration?: number;
  maxOvertimeSeconds?: number; requireTouchToStartClock?: boolean;
}

export interface MatchSessionSnapshot {
  roomId: string; gameMode: string; botFillMode: string; state: MatchState;
  matchTick: number; clockDuration: number; clockSecondsRemaining: number;
  isOvertime: boolean; overtimeSeconds: number; blueScore: number; orangeScore: number;
  winner: number | null; winReason: number; lobbyPhysicsActive: boolean;
  stateOnlyMode?: boolean; interveneTargetTick?: number; roster: RosterSnapshot;
}

export type FramePhaseGateAction =
  | 'none' | 'ended_or_podium' | 'start_from_prepare' | 'encode_null'
  | 'initiate_prepare_from_countdown' | 'lobby' | 'resume_from_pause'
  | 'reset_training_play' | 'begin_goal_replay' | 'replay' | 'kickoff_started';

export function resolveMaxPlayersForGameMode(gameMode: string): number {
  return gameMode === '1v1' ? 2 : gameMode === '2v2' ? 4 : 6;
}

export class MatchDomainState {
  roomId: string; password: string; gameMode: string; botFillMode: string;
  botsLoadoutConfig: Record<string, unknown> | null; isHost: boolean;
  externalBotTunnels: boolean; maxPlayers: number; autoStartWhenFull: boolean; skipReplayByDefault: boolean;
  state: MatchState = MATCH_STATES.LOBBY; matchTick = 0;
  clockDuration: number; clockSecondsRemaining: number;
  isOvertime = false; overtimeSeconds = 0; clockDirection: 'up' | 'down'; maxOvertimeSeconds: number;
  blueScore = 0; orangeScore = 0; winner: number | null = null; winReason = 0;
  lobbyMode: boolean; isTrainingMode: boolean;
  trainingDisableGoalReset: boolean; trainingUnlimitedBoost: boolean;
  trainingGoalReplayEnabled: boolean; trainingGoalCelebrationTicks: number;
  lobbyPhysicsActive = false; stateOnlyMode = false; interveneTargetTick = -1; trainingSeconds = 0;
  clockStarted = false; requireTouchToStartClock: boolean;
  kickoffWillStartAt = -1; kickoffStartedAtTick = -1; lastKickoffWillStartFrame = -1;
  goalBufferTicks = -1; startCountdownTicks = -1; prepareTimeoutTicks = -1;
  willResumeUntilTick = -1; podiumDelayTicks = 0;
  pendingOvertimeAfterGoal = false; pendingMatchEndAfterGoal = false; pendingMatchWinner: number | null = null;
  readonly players = new Map<string, MatchPlayerSlot>();
  readonly spectators = new Map<string, MatchSpectatorSlot>();
  readonly disconnectedPlayerSlots = new Map<number, DisconnectedPlayerSlot>();

  constructor(options: MatchDomainStateOptions = {}) {
    this.roomId = options.roomId || `room_${Math.random().toString(36).slice(2, 8)}`;
    this.password = options.password || ''; this.gameMode = options.gameMode || '3v3';
    this.botFillMode = options.botFillMode || 'no_bots'; this.botsLoadoutConfig = options.botsLoadoutConfig || null;
    this.isHost = options.isHost ?? true; this.externalBotTunnels = Boolean(options.externalBotTunnels);
    this.lobbyMode = Boolean(options.lobbyMode); this.isTrainingMode = options.isTrainingMode ?? this.lobbyMode;
    this.trainingDisableGoalReset = Boolean(options.trainingDisableGoalReset);
    this.trainingUnlimitedBoost = options.trainingUnlimitedBoost ?? true;
    this.trainingGoalReplayEnabled = Boolean(options.trainingGoalReplayEnabled ?? false);
    this.trainingGoalCelebrationTicks = options.trainingGoalCelebrationTicks ?? 150;
    this.maxPlayers = resolveMaxPlayersForGameMode(this.gameMode);
    this.autoStartWhenFull = options.autoStartWhenFull ?? !this.lobbyMode;
    this.skipReplayByDefault = options.skipReplayByDefault !== undefined ? Boolean(options.skipReplayByDefault) : true;
    this.clockDuration = options.matchDurationSeconds ?? options.durationSeconds ?? options.clockDuration ?? DEFAULT_MATCH_DURATION_SECONDS;
    this.clockSecondsRemaining = this.clockDuration; this.clockDirection = this.isTrainingMode ? 'up' : 'down';
    this.maxOvertimeSeconds = options.maxOvertimeSeconds ?? DEFAULT_MAX_OVERTIME_SECONDS;
    this.requireTouchToStartClock = options.requireTouchToStartClock ?? true;
  }

  buildSessionSnapshot(roster: RosterSnapshot): MatchSessionSnapshot {
    return {
      roomId: this.roomId, gameMode: this.gameMode, botFillMode: this.botFillMode, state: this.state,
      matchTick: this.matchTick, clockDuration: this.clockDuration, clockSecondsRemaining: this.clockSecondsRemaining,
      isOvertime: this.isOvertime, overtimeSeconds: this.overtimeSeconds, blueScore: this.blueScore,
      orangeScore: this.orangeScore, winner: this.winner, winReason: this.winReason,
      lobbyPhysicsActive: Boolean(this.lobbyPhysicsActive), stateOnlyMode: Boolean(this.stateOnlyMode),
      interveneTargetTick: this.interveneTargetTick, roster,
    };
  }

  buildRosterEnvelope(sessionManager?: RosterSessionManagerPort | null): {
    roster: RosterSnapshot; rosterUpdateJson: string;
    buildHandshakeJson: (player: MatchPlayerSlot | null, initialSnapshot?: number[] | null) => string;
  } {
    const roster = buildRosterSnapshot({
      players: this.players, spectators: this.spectators, sessionManager, gameMode: this.gameMode,
      botFillMode: this.botFillMode, clockDuration: this.clockDuration,
      clockSecondsRemaining: this.clockSecondsRemaining, blueScore: this.blueScore, orangeScore: this.orangeScore,
    });
    const rosterUpdateJson = JSON.stringify({
      type: 'roster_update', roomId: this.roomId, gameMode: this.gameMode,
      botFillMode: this.botFillMode, durationSeconds: this.clockDuration, state: this.state, roster,
    });
    return {
      roster, rosterUpdateJson,
      buildHandshakeJson: (player, initialSnapshot) =>
        player
          ? buildPlayerHandshakePacketJson({
              player, roomId: this.roomId, gameMode: this.gameMode, botFillMode: this.botFillMode,
              clockDuration: this.clockDuration, clockSecondsRemaining: this.clockSecondsRemaining,
              blueScore: this.blueScore, orangeScore: this.orangeScore, matchTick: this.matchTick,
              state: this.state, roster, initialSnapshot,
            })
          : buildSpectatorHandshakePacketJson({
              roomId: this.roomId, gameMode: this.gameMode, matchTick: this.matchTick, state: this.state, roster,
            }),
    };
  }

  applyRosterPolicyConfig(options?: { gameMode?: string; durationSeconds?: number | null; botFillMode?: string }): {
    shouldApplyBotFill: boolean; shouldAutoStartLobby: boolean; lobbyMode: boolean;
    isTrainingMode: boolean; lobbyPhysicsActive: boolean; canHotSwapNow: boolean; kickoffBoostAmount: number;
  } {
    if (options?.gameMode === '1v1' || options?.gameMode === '2v2' || options?.gameMode === '3v3') {
      this.gameMode = options.gameMode; this.maxPlayers = resolveMaxPlayersForGameMode(options.gameMode);
    }
    if (typeof options?.durationSeconds === 'number' && Number.isFinite(options.durationSeconds) && options.durationSeconds >= 0) {
      this.clockDuration = options.durationSeconds;
      if (this.state === MATCH_STATES.LOBBY) this.clockSecondsRemaining = options.durationSeconds;
    }
    if (options?.botFillMode && ['no_bots', 'auto_fill', 'bots_vs_humans', 'custom'].includes(options.botFillMode)) {
      this.botFillMode = options.botFillMode;
    }
    const shouldApplyBotFill =
      this.state !== MATCH_STATES.LOBBY &&
      (options?.botFillMode !== undefined || this.botFillMode === 'auto_fill' || this.botFillMode === 'bots_vs_humans');
    return {
      shouldApplyBotFill,
      shouldAutoStartLobby: Boolean(this.autoStartWhenFull && this.players.size >= this.maxPlayers && this.state === MATCH_STATES.LOBBY),
      lobbyMode: this.lobbyMode, isTrainingMode: this.isTrainingMode, lobbyPhysicsActive: this.lobbyPhysicsActive,
      canHotSwapNow:
        this.state === MATCH_STATES.LOBBY || this.state === MATCH_STATES.PREPARE ||
        this.state === MATCH_STATES.KICKOFF || this.isTrainingMode,
      kickoffBoostAmount: this.state === MATCH_STATES.LOBBY || this.isTrainingMode ? 100.0 : 33.33,
    };
  }

  updatePlayerSlot(sessionId: string, patch: Partial<MatchPlayerSlot>): MatchPlayerSlot | null {
    const existing = this.players.get(sessionId);
    if (!existing) return null;
    const record = existing as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) record[k] = v;
    return existing;
  }

  shouldSuppressCountdownClockSignal(): boolean { return Boolean(this.isOvertime || this.clockDirection === 'up'); }

  areAllHumanPlayersReadyInFullLobby(): boolean {
    if (this.state !== MATCH_STATES.LOBBY || this.players.size < this.maxPlayers) return false;
    for (const p of this.players.values()) if (!p.isBot && !p.ready) return false;
    return true;
  }

  areAllHumansVoted(voteSet: Set<string>, excludeSpectators = false): {
    allHumansVoted: boolean; spectatorSkippedAllBotMatch: boolean;
  } {
    let humanCount = 0, votedCount = 0;
    for (const [sid, p] of this.players.entries()) {
      if (!p.isBot && (!excludeSpectators || p.role !== 'spectator')) {
        humanCount++;
        if (voteSet.has(sid)) votedCount++;
      }
    }
    return {
      allHumansVoted: humanCount > 0 && votedCount >= humanCount,
      spectatorSkippedAllBotMatch: humanCount === 0 && voteSet.size > 0,
    };
  }

  resolveValidDuration(durationSeconds?: number | null, fallbackToDefault = false): void {
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      this.clockDuration = durationSeconds;
    } else if (fallbackToDefault && (!Number.isFinite(this.clockDuration) || this.clockDuration < 0)) {
      this.clockDuration = DEFAULT_MATCH_DURATION_SECONDS;
    }
  }

  beginPreparePhase(durationSeconds: number | null | undefined, timeoutTicks: number): void {
    this.resolveValidDuration(durationSeconds); this.state = MATCH_STATES.PREPARE; this.prepareTimeoutTicks = timeoutTicks;
  }

  beginCountdownPhase(countdownSeconds: number): boolean {
    if (this.state !== MATCH_STATES.LOBBY) return false;
    this.state = MATCH_STATES.COUNTDOWN; this.startCountdownTicks = Math.round(countdownSeconds * 120); return true;
  }

  beginPrepareOrCountdown(
    action: 'prepare' | 'countdown' | 'check_barrier' | 'check_force_prepare',
    value: number | null = null, timeoutTicks = 240, currentTick?: number
  ): { allReady: boolean; clockDuration: number } {
    if (action === 'countdown') return { allReady: this.beginCountdownPhase(value ?? 3), clockDuration: this.clockDuration };
    if (action === 'check_barrier') {
      if (this.state !== MATCH_STATES.PREPARE) return { allReady: false, clockDuration: this.clockDuration };
      for (const p of this.players.values()) if (!p.isBot && !p.arenaLoaded) return { allReady: false, clockDuration: this.clockDuration };
      return { allReady: true, clockDuration: this.clockDuration };
    }
    if (action === 'check_force_prepare') {
      this.resolveValidDuration(value);
      let hasRemoteHuman = false;
      for (const [sid, p] of this.players.entries()) if (!p.isBot && sid !== 'host') { hasRemoteHuman = true; break; }
      return { allReady: hasRemoteHuman && this.state === MATCH_STATES.LOBBY, clockDuration: this.clockDuration };
    }
    this.beginPreparePhase(value, timeoutTicks);
    if (typeof currentTick === 'number') this.matchTick = currentTick;
    let allReady = true;
    for (const [sid, p] of this.players.entries()) {
      p.arenaLoaded = Boolean(p.isBot || sid === 'host');
      if (!p.arenaLoaded) allReady = false;
    }
    return { allReady, clockDuration: this.clockDuration };
  }

  resetForMatchStart(durationSeconds?: number | null): {
    modeCode: number; clockDuration: number; clockSecondsRemaining: number; blueScore: number; orangeScore: number;
  } {
    this.isTrainingMode = false; this.state = MATCH_STATES.KICKOFF; this.matchTick = 0;
    this.resolveValidDuration(durationSeconds, true);
    this.clockSecondsRemaining = this.clockDuration; this.isOvertime = false; this.overtimeSeconds = 0;
    this.clockDirection = this.clockDuration === 0 ? 'up' : 'down';
    this.blueScore = 0; this.orangeScore = 0; this.winner = null; this.winReason = 0;
    this.lastKickoffWillStartFrame = -1; this.pendingMatchEndAfterGoal = false;
    this.pendingMatchWinner = null; this.pendingOvertimeAfterGoal = this.clockDuration === 0;
    this.disconnectedPlayerSlots.clear();
    return {
      modeCode: this.gameMode === '1v1' ? 1 : this.gameMode === '2v2' ? 2 : 3,
      clockDuration: this.clockDuration, clockSecondsRemaining: this.clockSecondsRemaining,
      blueScore: this.blueScore, orangeScore: this.orangeScore,
    };
  }

  enterLobbyState(lobbyPhysicsActive: boolean): void {
    this.lobbyMode = true; this.isTrainingMode = true; this.clockDirection = 'up';
    this.state = MATCH_STATES.LOBBY; this.winner = null; this.winReason = 0; this.lobbyPhysicsActive = lobbyPhysicsActive;
  }

  resetForTrainingPlay(): void { this.state = MATCH_STATES.PLAYING; this.goalBufferTicks = -1; this.kickoffWillStartAt = -1; }

  configureTrainingStart(options: Record<string, unknown>): void {
    this.isTrainingMode = true; this.stateOnlyMode = false;
    this.interveneTargetTick = -1; this.lobbyPhysicsActive = false; this.goalBufferTicks = -1;
    if (options.disableGoalReset !== undefined) this.trainingDisableGoalReset = Boolean(options.disableGoalReset);
    if (options.unlimitedBoost !== undefined) this.trainingUnlimitedBoost = Boolean(options.unlimitedBoost);
    if (options.goalReplayEnabled !== undefined) this.trainingGoalReplayEnabled = Boolean(options.goalReplayEnabled);
    if (typeof options.goalCelebrationTicks === 'number' && options.goalCelebrationTicks > 0) {
      this.trainingGoalCelebrationTicks = Math.round(options.goalCelebrationTicks);
    }
    if (options.skipReplayByDefault !== undefined) this.skipReplayByDefault = Boolean(options.skipReplayByDefault);
    this.clockDirection = 'up'; this.state = MATCH_STATES.PLAYING;
    this.trainingSeconds = 0; this.clockSecondsRemaining = 0; this.clockStarted = true;
  }

  applyLobbyOrTrainingTransition(
    mode: 'lobby' | 'training_reset' | 'training_start', options: Record<string, unknown> = {}
  ): MatchState {
    if (mode === 'lobby') this.enterLobbyState(options.lobbyPhysicsActive !== undefined ? Boolean(options.lobbyPhysicsActive) : true);
    else if (mode === 'training_reset') this.resetForTrainingPlay();
    else this.configureTrainingStart(options);
    return this.state;
  }

  beginKickoffPhase(countdownTicks: number): { startedOvertime: boolean; kickoffWillStartAt: number; isOvertime: boolean } {
    this.state = MATCH_STATES.KICKOFF; this.goalBufferTicks = -1;
    this.clockStarted = !this.requireTouchToStartClock; this.kickoffStartedAtTick = -1;
    const startedOvertime =
      this.pendingOvertimeAfterGoal ||
      (!this.isTrainingMode && !this.isOvertime && this.clockSecondsRemaining === 0 && this.blueScore === this.orangeScore);
    if (startedOvertime) {
      this.pendingOvertimeAfterGoal = false; this.isOvertime = true;
      this.clockDirection = 'up'; this.overtimeSeconds = 0;
    }
    this.lastKickoffWillStartFrame = this.matchTick; this.kickoffWillStartAt = this.matchTick + countdownTicks;
    return { startedOvertime, kickoffWillStartAt: this.kickoffWillStartAt, isOvertime: this.isOvertime };
  }

  completeKickoffToPlaying(): void {
    this.state = MATCH_STATES.KICKOFF === this.state ? MATCH_STATES.PLAYING : this.state;
    this.kickoffStartedAtTick = this.matchTick; this.kickoffWillStartAt = -1;
  }

  applyPauseOrResume(pause: boolean | null, countdownSeconds = 5): { changed: boolean; targetResumeTick: number } {
    if (pause === null) {
      if (this.state !== MATCH_STATES.PAUSED) return { changed: false, targetResumeTick: -1 };
      this.willResumeUntilTick = this.matchTick + Math.max(1, Math.round(countdownSeconds * 120));
      return { changed: true, targetResumeTick: this.willResumeUntilTick };
    }
    if (this.state !== MATCH_STATES.PLAYING && this.state !== MATCH_STATES.PAUSED) return { changed: false, targetResumeTick: -1 };
    this.state = pause ? MATCH_STATES.PAUSED : MATCH_STATES.PLAYING; this.willResumeUntilTick = -1;
    return { changed: true, targetResumeTick: -1 };
  }

  recordMatchEndedOrPodium(
    action: 'end' | 'podium', forcedWinner: number | null = null, winReason = 0,
    retentionDeps?: { engine: unknown; ringBuffer: { size: number } | null | undefined; signals: unknown; roster: unknown }
  ): { changed: boolean; winner: number; winReason: number; retentionPayload: Record<string, unknown> | null } {
    if (action === 'podium') {
      if (this.state !== MATCH_STATES.ENDED) return { changed: false, winner: 0, winReason: 0, retentionPayload: null };
      this.state = MATCH_STATES.PODIUM; this.podiumDelayTicks = 0;
      return { changed: true, winner: typeof this.winner === 'number' ? this.winner : 0, winReason: this.winReason ?? 0, retentionPayload: null };
    }
    this.state = MATCH_STATES.ENDED; this.podiumDelayTicks = 360;
    const winner = forcedWinner !== null && forcedWinner !== undefined ? forcedWinner : this.blueScore > this.orangeScore ? 0 : this.orangeScore > this.blueScore ? 1 : 2;
    this.winner = winner; this.winReason = winReason;
    const retentionPayload =
      this.isHost && retentionDeps?.ringBuffer && retentionDeps.ringBuffer.size > 0
        ? {
            engine: retentionDeps.engine || null, ringBuffer: retentionDeps.ringBuffer,
            signals: retentionDeps.signals, winnerTeam: winner, blueScore: this.blueScore,
            orangeScore: this.orangeScore, gameMode: this.gameMode || '3v3',
            durationSeconds: this.clockDuration, roster: retentionDeps.roster, loadouts: retentionDeps.roster,
          }
        : null;
    return { changed: true, winner, winReason, retentionPayload };
  }

  applyGoalScoredOutcome(outcome: {
    celebrationTicks: number; blueScore: number; orangeScore: number;
    pendingOvertimeAfterGoal: boolean; pendingMatchEndAfterGoal: boolean; pendingMatchWinner: number | null;
  }): void {
    this.state = MATCH_STATES.GOAL_SCORED; this.goalBufferTicks = outcome.celebrationTicks;
    this.blueScore = outcome.blueScore; this.orangeScore = outcome.orangeScore;
    this.pendingOvertimeAfterGoal = outcome.pendingOvertimeAfterGoal;
    this.pendingMatchEndAfterGoal = outcome.pendingMatchEndAfterGoal;
    this.pendingMatchWinner = outcome.pendingMatchWinner;
  }

  stepFramePhaseGate(
    phase: 'pre' | 'post' | 'ended_podium_tick', currentPhysicsTick?: number, hasPhysics = true
  ): { action: FramePhaseGateAction; clockDuration: number } {
    if (phase === 'ended_podium_tick') {
      const enterPodium =
        this.state === MATCH_STATES.ENDED &&
        !(typeof this.podiumDelayTicks === 'number' && this.podiumDelayTicks > 0 && --this.podiumDelayTicks > 0);
      return { action: enterPodium ? 'ended_or_podium' : 'none', clockDuration: this.clockDuration };
    }
    if (phase === 'post') {
      if (hasPhysics && typeof currentPhysicsTick === 'number') this.matchTick = currentPhysicsTick;
      else if (!hasPhysics) this.matchTick++;
      if (this.state === MATCH_STATES.KICKOFF && this.matchTick >= this.kickoffWillStartAt && this.kickoffWillStartAt > 0) {
        this.completeKickoffToPlaying();
        return { action: 'kickoff_started', clockDuration: this.clockDuration };
      }
      return { action: 'none', clockDuration: this.clockDuration };
    }
    if (this.state === MATCH_STATES.ENDED || this.state === MATCH_STATES.PODIUM) {
      return { action: 'ended_or_podium', clockDuration: this.clockDuration };
    }
    if (this.state === MATCH_STATES.PREPARE) {
      this.matchTick = typeof currentPhysicsTick === 'number' ? currentPhysicsTick : this.matchTick + 1;
      return { action: --this.prepareTimeoutTicks <= 0 ? 'start_from_prepare' : 'encode_null', clockDuration: this.clockDuration };
    }
    if (this.state === MATCH_STATES.COUNTDOWN) {
      this.matchTick = typeof currentPhysicsTick === 'number' ? currentPhysicsTick : this.matchTick + 1;
      return { action: --this.startCountdownTicks <= 0 ? 'initiate_prepare_from_countdown' : 'encode_null', clockDuration: this.clockDuration };
    }
    if (this.state === MATCH_STATES.LOBBY) return { action: 'lobby', clockDuration: this.clockDuration };
    if (this.state === MATCH_STATES.PAUSED && this.willResumeUntilTick > 0) {
      return { action: ++this.matchTick >= this.willResumeUntilTick ? 'resume_from_pause' : 'encode_null', clockDuration: this.clockDuration };
    }
    if (this.state === MATCH_STATES.GOAL_SCORED && --this.goalBufferTicks <= 0) {
      return { action: this.isTrainingMode && !this.trainingGoalReplayEnabled ? 'reset_training_play' : 'begin_goal_replay', clockDuration: this.clockDuration };
    }
    if (this.state === MATCH_STATES.REPLAY) return { action: 'replay', clockDuration: this.clockDuration };
    return { action: 'none', clockDuration: this.clockDuration };
  }

  advanceClockTickSecond(): { mode: 'none' | 'training' | 'regulation' | 'overtime'; seconds: number; overtimeExpired: boolean } {
    if (this.isTrainingMode) {
      this.clockDirection = 'up';
      return { mode: 'training', seconds: (this.trainingSeconds = (this.trainingSeconds || 0) + 1), overtimeExpired: false };
    }
    if (!this.isOvertime && this.clockDirection !== 'up') {
      this.clockDirection = 'down';
      return this.clockSecondsRemaining > 0
        ? { mode: 'regulation', seconds: --this.clockSecondsRemaining, overtimeExpired: false }
        : { mode: 'none', seconds: 0, overtimeExpired: false };
    }
    this.clockDirection = 'up';
    const seconds = ++this.overtimeSeconds;
    return { mode: 'overtime', seconds, overtimeExpired: this.maxOvertimeSeconds > 0 && seconds >= this.maxOvertimeSeconds };
  }

  consumePendingMatchEndAfterGoal(): { shouldEnd: boolean; winner: number | null } {
    const res = { shouldEnd: Boolean(this.pendingMatchEndAfterGoal), winner: this.pendingMatchWinner };
    this.pendingMatchEndAfterGoal = false; this.pendingMatchWinner = null;
    return res;
  }

  clampGoalBufferTicksForSkip(maxTicks: number): void {
    if (this.goalBufferTicks > maxTicks) this.goalBufferTicks = maxTicks;
  }

  applyTrainingRulesetOptions(options: {
    disableGoalReset?: boolean; goalReplayEnabled?: boolean; celebrationTicks?: number; unlimitedBoost?: boolean;
  }): void {
    if (options.disableGoalReset !== undefined) this.trainingDisableGoalReset = Boolean(options.disableGoalReset);
    if (options.goalReplayEnabled !== undefined) this.trainingGoalReplayEnabled = Boolean(options.goalReplayEnabled);
    if (typeof options.celebrationTicks === 'number' && options.celebrationTicks > 0) {
      this.trainingGoalCelebrationTicks = Math.round(options.celebrationTicks);
    }
    if (options.unlimitedBoost !== undefined) this.trainingUnlimitedBoost = Boolean(options.unlimitedBoost);
  }

  applySystemControlState(mode: 'state_only' | 'intervene' | 'resume', tick?: number): number {
    if (mode === 'state_only') {
      this.stateOnlyMode = true; this.interveneTargetTick = -1;
      if (typeof tick === 'number' && tick >= 0) this.matchTick = tick;
      return this.matchTick;
    }
    if (mode === 'intervene') {
      this.stateOnlyMode = true; this.interveneTargetTick = this.matchTick + (tick ?? 0);
      return this.interveneTargetTick;
    }
    this.stateOnlyMode = false; this.interveneTargetTick = -1;
    if (this.state === MATCH_STATES.PAUSED || this.state === MATCH_STATES.REPLAY) this.state = MATCH_STATES.PLAYING;
    if (typeof tick === 'number' && tick >= 0) this.matchTick = tick;
    return this.matchTick;
  }
}
