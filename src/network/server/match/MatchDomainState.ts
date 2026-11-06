/**
 * src/network/server/match/MatchDomainState.ts
 * Explicit domain state container and atomic state/clock/score transition methods
 * for authoritative match sessions.
 */

import {
  MATCH_STATES,
  DEFAULT_MATCH_DURATION_SECONDS,
  DEFAULT_MAX_OVERTIME_SECONDS,
  type MatchState,
  type MatchPlayerSlot,
  type MatchSpectatorSlot,
  type DisconnectedPlayerSlot,
  type RosterSnapshot,
} from './matchLoadoutAndSpawnPipeline.ts';

export interface MatchDomainStateOptions {
  roomId?: string; password?: string; gameMode?: string; botFillMode?: string;
  botsLoadoutConfig?: any; isHost?: boolean; externalBotTunnels?: boolean;
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

export function resolveMaxPlayersForGameMode(gameMode: string): number {
  return gameMode === '1v1' ? 2 : gameMode === '2v2' ? 4 : 6;
}

export class MatchDomainState {
  roomId: string;
  password: string;
  gameMode: string;
  botFillMode: string;
  botsLoadoutConfig: any;
  isHost: boolean;
  externalBotTunnels: boolean;
  maxPlayers: number;
  autoStartWhenFull: boolean;
  skipReplayByDefault: boolean;

  state: MatchState = MATCH_STATES.LOBBY;
  matchTick = 0;
  clockDuration: number;
  clockSecondsRemaining: number;
  isOvertime = false;
  overtimeSeconds = 0;
  clockDirection: 'up' | 'down';
  maxOvertimeSeconds: number;
  blueScore = 0;
  orangeScore = 0;
  winner: number | null = null;
  winReason = 0;

  lobbyMode: boolean;
  isTrainingMode: boolean;
  trainingDisableGoalReset: boolean;
  trainingUnlimitedBoost: boolean;
  trainingGoalReplayEnabled: boolean;
  trainingGoalCelebrationTicks: number;
  lobbyPhysicsActive = false;
  stateOnlyMode = false;
  interveneTargetTick = -1;
  trainingSeconds = 0;
  clockStarted = false;
  requireTouchToStartClock: boolean;

  kickoffWillStartAt = -1;
  kickoffStartedAtTick = -1;
  lastKickoffWillStartFrame = -1;
  goalBufferTicks = -1;
  startCountdownTicks = -1;
  prepareTimeoutTicks = -1;
  willResumeUntilTick = -1;
  podiumDelayTicks = 0;
  pendingOvertimeAfterGoal = false;
  pendingMatchEndAfterGoal = false;
  pendingMatchWinner: number | null = null;

  readonly players = new Map<string, MatchPlayerSlot>();
  readonly spectators = new Map<string, MatchSpectatorSlot>();
  readonly disconnectedPlayerSlots = new Map<number, DisconnectedPlayerSlot>();

  constructor(options: MatchDomainStateOptions = {}) {
    this.roomId = options.roomId || `room_${Math.random().toString(36).slice(2, 8)}`;
    this.password = options.password || '';
    this.gameMode = options.gameMode || '3v3';
    this.botFillMode = options.botFillMode || 'no_bots';
    this.botsLoadoutConfig = options.botsLoadoutConfig || null;
    this.isHost = options.isHost ?? true;
    this.externalBotTunnels = Boolean(options.externalBotTunnels);
    this.lobbyMode = Boolean(options.lobbyMode);
    this.isTrainingMode = options.isTrainingMode ?? this.lobbyMode;
    this.trainingDisableGoalReset = Boolean(options.trainingDisableGoalReset);
    this.trainingUnlimitedBoost = options.trainingUnlimitedBoost ?? true;
    this.trainingGoalReplayEnabled = Boolean(options.trainingGoalReplayEnabled ?? false);
    this.trainingGoalCelebrationTicks = options.trainingGoalCelebrationTicks ?? 150;
    this.maxPlayers = resolveMaxPlayersForGameMode(this.gameMode);
    this.autoStartWhenFull = options.autoStartWhenFull ?? !this.lobbyMode;
    this.skipReplayByDefault =
      options.skipReplayByDefault !== undefined ? Boolean(options.skipReplayByDefault) : true;
    this.clockDuration =
      options.matchDurationSeconds ??
      options.durationSeconds ??
      options.clockDuration ??
      DEFAULT_MATCH_DURATION_SECONDS;
    this.clockSecondsRemaining = this.clockDuration;
    this.clockDirection = this.isTrainingMode ? 'up' : 'down';
    this.maxOvertimeSeconds = options.maxOvertimeSeconds ?? DEFAULT_MAX_OVERTIME_SECONDS;
    this.requireTouchToStartClock = options.requireTouchToStartClock ?? true;
  }

  resolveValidDuration(durationSeconds?: number | null, fallbackToDefault = false): void {
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      this.clockDuration = durationSeconds;
    } else if (fallbackToDefault && (!Number.isFinite(this.clockDuration) || this.clockDuration < 0)) {
      this.clockDuration = DEFAULT_MATCH_DURATION_SECONDS;
    }
  }

  beginPreparePhase(durationSeconds: number | null | undefined, timeoutTicks: number): void {
    this.resolveValidDuration(durationSeconds);
    this.state = MATCH_STATES.PREPARE;
    this.prepareTimeoutTicks = timeoutTicks;
  }

  beginCountdownPhase(countdownSeconds: number): boolean {
    if (this.state !== MATCH_STATES.LOBBY) return false;
    this.state = MATCH_STATES.COUNTDOWN;
    this.startCountdownTicks = Math.round(countdownSeconds * 120);
    return true;
  }

  resetForMatchStart(durationSeconds?: number | null): void {
    this.isTrainingMode = false;
    this.state = MATCH_STATES.KICKOFF;
    this.matchTick = 0;
    this.resolveValidDuration(durationSeconds, true);
    this.clockSecondsRemaining = this.clockDuration;
    this.isOvertime = this.clockDuration === 0;
    this.overtimeSeconds = 0;
    this.clockDirection = this.isOvertime ? 'up' : 'down';
    this.blueScore = 0;
    this.orangeScore = 0;
    this.winner = null;
    this.winReason = 0;
    this.lastKickoffWillStartFrame = -1;
    this.pendingMatchEndAfterGoal = false;
    this.pendingMatchWinner = null;
    this.pendingOvertimeAfterGoal = false;
    this.disconnectedPlayerSlots.clear();
  }

  enterLobbyState(lobbyPhysicsActive: boolean): void {
    this.lobbyMode = true;
    this.isTrainingMode = true;
    this.clockDirection = 'up';
    this.state = MATCH_STATES.LOBBY;
    this.winner = null;
    this.winReason = 0;
    this.lobbyPhysicsActive = lobbyPhysicsActive;
  }

  resetForTrainingPlay(): void {
    this.state = MATCH_STATES.PLAYING;
    this.goalBufferTicks = -1;
    this.kickoffWillStartAt = -1;
  }

  beginKickoffPhase(countdownTicks: number): { startedOvertime: boolean; kickoffWillStartAt: number } {
    this.state = MATCH_STATES.KICKOFF;
    this.goalBufferTicks = -1;
    this.clockStarted = !this.requireTouchToStartClock;
    this.kickoffStartedAtTick = -1;
    const startedOvertime =
      this.pendingOvertimeAfterGoal ||
      (!this.isTrainingMode && !this.isOvertime && this.clockSecondsRemaining === 0 && this.blueScore === this.orangeScore);
    if (startedOvertime) {
      this.pendingOvertimeAfterGoal = false;
      this.isOvertime = true;
      this.clockDirection = 'up';
      this.overtimeSeconds = 0;
    }
    this.lastKickoffWillStartFrame = this.matchTick;
    this.kickoffWillStartAt = this.matchTick + countdownTicks;
    return { startedOvertime, kickoffWillStartAt: this.kickoffWillStartAt };
  }

  completeKickoffToPlaying(): void {
    this.state = MATCH_STATES.PLAYING;
    this.kickoffStartedAtTick = this.matchTick;
    this.kickoffWillStartAt = -1;
  }

  applyPauseState(pause: boolean): void {
    this.state = pause ? MATCH_STATES.PAUSED : MATCH_STATES.PLAYING;
    this.willResumeUntilTick = -1;
  }

  scheduleResumeAtTick(resumeTicks: number): number {
    return (this.willResumeUntilTick = this.matchTick + resumeTicks);
  }

  recordMatchEnded(forcedWinner: number | null, winReason: number): number {
    this.state = MATCH_STATES.ENDED;
    this.podiumDelayTicks = 360;
    const winner =
      forcedWinner !== null && forcedWinner !== undefined
        ? forcedWinner
        : this.blueScore > this.orangeScore ? 0 : this.orangeScore > this.blueScore ? 1 : 2;
    this.winner = winner;
    this.winReason = winReason;
    return winner;
  }

  enterPodiumState(): { winner: number; winReason: number } {
    this.state = MATCH_STATES.PODIUM;
    this.podiumDelayTicks = 0;
    return { winner: typeof this.winner === 'number' ? this.winner : 0, winReason: this.winReason ?? 0 };
  }

  configureTrainingStart(options: Record<string, any>): void {
    this.isTrainingMode = true;
    this.stateOnlyMode = false;
    this.interveneTargetTick = -1;
    this.lobbyPhysicsActive = false;
    this.goalBufferTicks = -1;
    if (options.disableGoalReset !== undefined) this.trainingDisableGoalReset = Boolean(options.disableGoalReset);
    if (options.unlimitedBoost !== undefined) this.trainingUnlimitedBoost = Boolean(options.unlimitedBoost);
    if (options.goalReplayEnabled !== undefined) this.trainingGoalReplayEnabled = Boolean(options.goalReplayEnabled);
    if (typeof options.goalCelebrationTicks === 'number' && options.goalCelebrationTicks > 0) {
      this.trainingGoalCelebrationTicks = Math.round(options.goalCelebrationTicks);
    }
    if (options.skipReplayByDefault !== undefined) this.skipReplayByDefault = Boolean(options.skipReplayByDefault);
    this.clockDirection = 'up';
    this.state = MATCH_STATES.PLAYING;
    this.trainingSeconds = 0;
    this.clockSecondsRemaining = 0;
    this.clockStarted = true;
  }

  applyGoalScoredOutcome(outcome: {
    celebrationTicks: number;
    blueScore: number;
    orangeScore: number;
    pendingOvertimeAfterGoal: boolean;
    pendingMatchEndAfterGoal: boolean;
    pendingMatchWinner: number | null;
  }): void {
    this.state = MATCH_STATES.GOAL_SCORED;
    this.goalBufferTicks = outcome.celebrationTicks;
    this.blueScore = outcome.blueScore;
    this.orangeScore = outcome.orangeScore;
    this.pendingOvertimeAfterGoal = outcome.pendingOvertimeAfterGoal;
    this.pendingMatchEndAfterGoal = outcome.pendingMatchEndAfterGoal;
    this.pendingMatchWinner = outcome.pendingMatchWinner;
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
    this.pendingMatchEndAfterGoal = false;
    this.pendingMatchWinner = null;
    return res;
  }

  clampGoalBufferTicksForSkip(maxTicks: number): void {
    if (this.goalBufferTicks > maxTicks) this.goalBufferTicks = maxTicks;
  }
}
