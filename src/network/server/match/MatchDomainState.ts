/**
 * src/network/server/match/MatchDomainState.ts
 * Core score, match clock, phase state, and atomic state transitions for authoritative match sessions.
 */

import { MATCH_STATES, type MatchState, type RosterSnapshot } from './matchLoadoutAndSpawnPipeline.ts';
import {
  MatchRosterPolicyState,
  type MatchDomainStateOptions, type MatchSessionSnapshot, type FramePhaseGateAction,
} from './MatchRosterPolicyState.ts';

export type { MatchDomainStateOptions, MatchSessionSnapshot, FramePhaseGateAction };

export class MatchDomainState extends MatchRosterPolicyState {
  trainingDisableGoalReset = false;
  trainingUnlimitedBoost = true;
  trainingGoalReplayEnabled = false;
  trainingGoalCelebrationTicks = 150;
  trainingSeconds = 0;
  clockStarted = false;
  requireTouchToStartClock = true;
  kickoffWillStartAt = -1;
  kickoffStartedAtTick = -1;
  lastKickoffWillStartFrame = -1;
  goalBufferTicks = -1;
  willResumeUntilTick = -1;
  podiumDelayTicks = 0;
  pendingOvertimeAfterGoal = false;
  pendingMatchEndAfterGoal = false;
  pendingMatchWinner: number | null = null;

  constructor(opts: MatchDomainStateOptions = {}) {
    super(opts);
    this.trainingDisableGoalReset = Boolean(opts.trainingDisableGoalReset);
    this.trainingUnlimitedBoost = opts.trainingUnlimitedBoost ?? true;
    this.trainingGoalReplayEnabled = Boolean(opts.trainingGoalReplayEnabled ?? false);
    this.trainingGoalCelebrationTicks = opts.trainingGoalCelebrationTicks ?? 150;
    this.requireTouchToStartClock = opts.requireTouchToStartClock ?? true;
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

  shouldSuppressCountdownClockSignal(): boolean {
    return Boolean(this.isOvertime || this.clockDirection === 'up');
  }

  resetForMatchStart(sec?: number | null) {
    this.resolveValidDuration(sec, true);
    const d = this.clockDuration;
    Object.assign(this, {
      isTrainingMode: false, state: MATCH_STATES.KICKOFF, matchTick: 0, clockSecondsRemaining: d,
      isOvertime: false, overtimeSeconds: 0, clockDirection: d === 0 ? 'up' : 'down',
      blueScore: 0, orangeScore: 0, winner: null, winReason: 0, lastKickoffWillStartFrame: -1,
      kickoffWillStartAt: -1, kickoffStartedAtTick: -1, goalBufferTicks: -1,
      willResumeUntilTick: -1, podiumDelayTicks: 0, clockStarted: false,
      pendingMatchEndAfterGoal: false, pendingMatchWinner: null, pendingOvertimeAfterGoal: d === 0,
    });
    this.disconnectedPlayerSlots.clear();
    return {
      modeCode: this.gameMode === '1v1' ? 1 : this.gameMode === '2v2' ? 2 : 3,
      clockDuration: d, clockSecondsRemaining: d, blueScore: 0, orangeScore: 0,
    };
  }

  applyLobbyOrTrainingTransition(mode: 'lobby' | 'training_reset' | 'training_start', o: Record<string, unknown> = {}): MatchState {
    if (mode === 'lobby') {
      Object.assign(this, {
        lobbyMode: true, isTrainingMode: true, clockDirection: 'up', state: MATCH_STATES.LOBBY,
        winner: null, winReason: 0, lobbyPhysicsActive: o.lobbyPhysicsActive !== undefined ? Boolean(o.lobbyPhysicsActive) : true,
      });
    } else if (mode === 'training_reset') {
      this.state = MATCH_STATES.PLAYING;
      this.goalBufferTicks = this.kickoffWillStartAt = -1;
    } else {
      Object.assign(this, {
        isTrainingMode: true, stateOnlyMode: false, interveneTargetTick: -1, lobbyPhysicsActive: false,
        goalBufferTicks: -1, clockDirection: 'up', state: MATCH_STATES.PLAYING, trainingSeconds: 0,
        clockSecondsRemaining: 0, clockStarted: true,
      });
      this.applyTrainingRulesetOptions({
        disableGoalReset: o.disableGoalReset as boolean | undefined,
        unlimitedBoost: o.unlimitedBoost as boolean | undefined,
        goalReplayEnabled: o.goalReplayEnabled as boolean | undefined,
        celebrationTicks: o.goalCelebrationTicks as number | undefined,
      });
      if (o.skipReplayByDefault !== undefined) this.skipReplayByDefault = Boolean(o.skipReplayByDefault);
    }
    return this.state;
  }

  beginKickoffPhase(ticks: number) {
    this.state = MATCH_STATES.KICKOFF;
    this.goalBufferTicks = this.kickoffStartedAtTick = -1;
    this.clockStarted = !this.requireTouchToStartClock;
    const ot =
      this.pendingOvertimeAfterGoal ||
      (!this.isTrainingMode && !this.isOvertime && this.clockSecondsRemaining === 0 && this.blueScore === this.orangeScore);
    if (ot) Object.assign(this, { pendingOvertimeAfterGoal: false, isOvertime: true, clockDirection: 'up', overtimeSeconds: 0 });
    this.lastKickoffWillStartFrame = this.matchTick;
    this.kickoffWillStartAt = this.matchTick + ticks;
    return { startedOvertime: ot, kickoffWillStartAt: this.kickoffWillStartAt, isOvertime: this.isOvertime };
  }

  completeKickoffToPlaying(): void {
    if (this.state === MATCH_STATES.KICKOFF) this.state = MATCH_STATES.PLAYING;
    this.kickoffStartedAtTick = this.matchTick;
    this.kickoffWillStartAt = -1;
  }

  applyPauseOrResume(pause: boolean | null, sec = 5) {
    if (pause === null) {
      if (this.state !== MATCH_STATES.PAUSED) return { changed: false, targetResumeTick: -1 };
      return { changed: true, targetResumeTick: (this.willResumeUntilTick = this.matchTick + Math.max(1, Math.round(sec * 120))) };
    }
    if (this.state !== MATCH_STATES.PLAYING && this.state !== MATCH_STATES.PAUSED) return { changed: false, targetResumeTick: -1 };
    this.state = pause ? MATCH_STATES.PAUSED : MATCH_STATES.PLAYING;
    this.willResumeUntilTick = -1;
    return { changed: true, targetResumeTick: -1 };
  }

  recordMatchEndedOrPodium(
    act: 'end' | 'podium', forcedWinner: number | null = null, winReason = 0,
    deps?: { engine: unknown; ringBuffer: { size: number } | null | undefined; signals: unknown; roster: unknown }
  ) {
    if (act === 'podium') {
      if (this.state !== MATCH_STATES.ENDED) return { changed: false, winner: 0, winReason: 0, retentionPayload: null };
      this.state = MATCH_STATES.PODIUM;
      this.podiumDelayTicks = 0;
      return { changed: true, winner: typeof this.winner === 'number' ? this.winner : 0, winReason: this.winReason ?? 0, retentionPayload: null };
    }
    const winner = forcedWinner ?? (this.blueScore > this.orangeScore ? 0 : this.orangeScore > this.blueScore ? 1 : 2);
    Object.assign(this, { state: MATCH_STATES.ENDED, podiumDelayTicks: 360, winner, winReason });
    const retentionPayload = this.isHost && deps?.ringBuffer && deps.ringBuffer.size > 0
      ? {
          engine: deps.engine || null, ringBuffer: deps.ringBuffer, signals: deps.signals,
          winnerTeam: winner, blueScore: this.blueScore, orangeScore: this.orangeScore,
          gameMode: this.gameMode || '3v3', durationSeconds: this.clockDuration,
          roster: deps.roster, loadouts: deps.roster,
        }
      : null;
    return { changed: true, winner, winReason, retentionPayload };
  }

  applyGoalScoredOutcome(o: {
    celebrationTicks: number; blueScore: number; orangeScore: number;
    pendingOvertimeAfterGoal: boolean; pendingMatchEndAfterGoal: boolean; pendingMatchWinner: number | null;
  }): void {
    Object.assign(this, {
      state: MATCH_STATES.GOAL_SCORED, goalBufferTicks: o.celebrationTicks,
      blueScore: o.blueScore, orangeScore: o.orangeScore,
      pendingOvertimeAfterGoal: o.pendingOvertimeAfterGoal,
      pendingMatchEndAfterGoal: o.pendingMatchEndAfterGoal,
      pendingMatchWinner: o.pendingMatchWinner,
    });
  }

  stepFramePhaseGate(p: 'pre' | 'post' | 'ended_podium_tick', pt?: number, hasPhys = true): { action: FramePhaseGateAction; clockDuration: number } {
    const dur = this.clockDuration, st = this.state;
    const ret = (action: FramePhaseGateAction) => ({ action, clockDuration: dur });
    if (p === 'ended_podium_tick') return ret(st === MATCH_STATES.ENDED && !(this.podiumDelayTicks > 0 && --this.podiumDelayTicks > 0) ? 'ended_or_podium' : 'none');
    if (p === 'post') {
      if (hasPhys && typeof pt === 'number') this.matchTick = pt;
      else if (!hasPhys) this.matchTick++;
      if (st === MATCH_STATES.KICKOFF && this.matchTick >= this.kickoffWillStartAt && this.kickoffWillStartAt > 0) {
        this.completeKickoffToPlaying(); return ret('kickoff_started');
      }
      return ret('none');
    }
    if (st === MATCH_STATES.ENDED || st === MATCH_STATES.PODIUM) return ret('ended_or_podium');
    if (st === MATCH_STATES.PREPARE || st === MATCH_STATES.COUNTDOWN) {
      this.matchTick = typeof pt === 'number' ? pt : this.matchTick + 1;
      return st === MATCH_STATES.PREPARE
        ? ret(--this.prepareTimeoutTicks <= 0 ? 'start_from_prepare' : 'encode_null')
        : ret(--this.startCountdownTicks <= 0 ? 'initiate_prepare_from_countdown' : 'encode_null');
    }
    if (st === MATCH_STATES.LOBBY) return ret('lobby');
    if (st === MATCH_STATES.PAUSED && this.willResumeUntilTick > 0) return ret(++this.matchTick >= this.willResumeUntilTick ? 'resume_from_pause' : 'encode_null');
    if (st === MATCH_STATES.GOAL_SCORED && --this.goalBufferTicks <= 0) return ret(this.isTrainingMode && !this.trainingGoalReplayEnabled ? 'reset_training_play' : 'begin_goal_replay');
    return ret(st === MATCH_STATES.REPLAY ? 'replay' : 'none');
  }

  advanceClockTickSecond(): { mode: 'none' | 'training' | 'regulation' | 'overtime'; seconds: number; overtimeExpired: boolean } {
    if (this.isTrainingMode) {
      this.clockDirection = 'up';
      return { mode: 'training', seconds: (this.trainingSeconds = (this.trainingSeconds || 0) + 1), overtimeExpired: false };
    }
    if (!this.isOvertime && this.clockDirection !== 'up') {
      this.clockDirection = 'down';
      return this.clockSecondsRemaining > 0 ? { mode: 'regulation', seconds: --this.clockSecondsRemaining, overtimeExpired: false } : { mode: 'none', seconds: 0, overtimeExpired: false };
    }
    this.clockDirection = 'up';
    const seconds = ++this.overtimeSeconds;
    return { mode: 'overtime', seconds, overtimeExpired: this.maxOvertimeSeconds > 0 && seconds >= this.maxOvertimeSeconds };
  }

  consumePendingMatchEndAfterGoal() {
    const r = { shouldEnd: Boolean(this.pendingMatchEndAfterGoal), winner: this.pendingMatchWinner };
    this.pendingMatchEndAfterGoal = false; this.pendingMatchWinner = null;
    return r;
  }

  clampGoalBufferTicksForSkip(max: number): void { if (this.goalBufferTicks > max) this.goalBufferTicks = max; }

  applyTrainingRulesetOptions(o: { disableGoalReset?: boolean; goalReplayEnabled?: boolean; celebrationTicks?: number; unlimitedBoost?: boolean }): void {
    if (o.disableGoalReset !== undefined) this.trainingDisableGoalReset = Boolean(o.disableGoalReset);
    if (o.goalReplayEnabled !== undefined) this.trainingGoalReplayEnabled = Boolean(o.goalReplayEnabled);
    if (typeof o.celebrationTicks === 'number' && o.celebrationTicks > 0) this.trainingGoalCelebrationTicks = Math.round(o.celebrationTicks);
    if (o.unlimitedBoost !== undefined) this.trainingUnlimitedBoost = Boolean(o.unlimitedBoost);
  }

  applySystemControlState(mode: 'state_only' | 'intervene' | 'resume', tick?: number): number {
    if (mode === 'state_only') {
      this.stateOnlyMode = true; this.interveneTargetTick = -1;
      if (typeof tick === 'number' && tick >= 0) this.matchTick = tick;
      return this.matchTick;
    }
    if (mode === 'intervene') {
      this.stateOnlyMode = true;
      return (this.interveneTargetTick = this.matchTick + (tick ?? 0));
    }
    this.stateOnlyMode = false; this.interveneTargetTick = -1;
    if (this.state === MATCH_STATES.PAUSED || this.state === MATCH_STATES.REPLAY) this.state = MATCH_STATES.PLAYING;
    if (typeof tick === 'number' && tick >= 0) this.matchTick = tick;
    return this.matchTick;
  }
}
