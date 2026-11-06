/**
 * src/network/server/match/MatchPhaseLifecycleSubController.ts
 * Stateful SubController owning the authoritative match phase state machine
 * (lobby, prepare barrier, countdown, kickoff, playing, goal scored, replay,
 * pause/resume, overtime, ended, podium), clock progression, and frame packet encoding.
 */

import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import { REPLAY_BUFFER_MODES } from '../../../replay/ReplayRingBuffer.ts';
import {
  MATCH_STATES,
  DEFAULT_MATCH_DURATION_SECONDS,
  KICKOFF_TOTAL_TICKS,
  type MatchState,
} from './matchLoadoutAndSpawnPipeline.ts';
import {
  emitRosterJoinAndLoadoutSignals,
  configureLobbyPhysicsArena,
  dispatchFlipResetIncidents,
  dispatchCountdownClockSecondSignals,
  resolvePossessionTieBreakWinner,
  evaluateGoalScoredOutcome,
  encodeMatchGlobalFramePacket,
  advancePlayingClockState,
} from './matchLifecyclePipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';
import type { MatchRosterSubController } from './MatchRosterSubController.ts';
import type { MatchCommandQueueSubController } from './MatchCommandQueueSubController.ts';
import type { MatchGoalReplaySubController } from './MatchGoalReplaySubController.ts';
import type { MatchSystemControlSubController } from './MatchSystemControlSubController.ts';

export interface MatchPhaseLifecycleHostPort {
  readonly domain: MatchDomainState;
  readonly roster: MatchRosterSubController;
  readonly commandQueue: MatchCommandQueueSubController;
  readonly goalReplay: MatchGoalReplaySubController;
  readonly systemControl?: MatchSystemControlSubController;
  readonly physicsManager: any;
  readonly sessionManager: any;
  readonly diagnosticsController: any;
  readonly replayBuffer: any;
  readonly onClearRetainedReplay: (() => void) | null;
  readonly onRetainCompletedReplay: ((data: Record<string, any>) => void) | null;
}

export class MatchPhaseLifecycleSubController {
  readonly host: MatchPhaseLifecycleHostPort;

  constructor(host: MatchPhaseLifecycleHostPort) {
    this.host = host;
  }

  get state(): MatchState {
    return this.host.domain.state;
  }
  set state(v: MatchState) {
    this.host.domain.state = v;
  }
  get matchTick(): number {
    return this.host.domain.matchTick;
  }
  set matchTick(v: number) {
    this.host.domain.matchTick = v;
  }
  get winner(): number | null {
    return this.host.domain.winner;
  }
  set winner(v: number | null) {
    this.host.domain.winner = v;
  }

  private prepareArenaForActiveMatch(): void {
    const { domain, physicsManager, diagnosticsController, roster } = this.host;
    domain.lobbyPhysicsActive = false;
    physicsManager?.inputBuffer?.setLobbyMode?.(false);
    if (diagnosticsController) {
      diagnosticsController.enabled = false;
      if (physicsManager) diagnosticsController.releasePhysics(physicsManager);
    }
    roster.applyBotFillPolicy();
    roster.syncRosterPhysicsEntities();
    physicsManager?.sim?.setUnlimitedBoost?.(false);
    physicsManager?.restoreSolidCollisions?.();
  }

  initiateMatchPrepare(durationSeconds: number | null = null, timeoutTicks = 240): void {
    const { domain, physicsManager, roster, commandQueue } = this.host;
    domain.beginPreparePhase(durationSeconds, timeoutTicks);
    this.prepareArenaForActiveMatch();
    commandQueue.matchSequence = ((commandQueue.matchSequence || 0) + 1) & 0xffff;
    domain.beginPreparePhase(durationSeconds, timeoutTicks);
    if (physicsManager) {
      physicsManager.resetKickoff(0);
      roster.applyRosterKickoffSpawns();
      physicsManager.setInputMask?.(true);
      domain.matchTick = physicsManager.currentTick;
    }

    let allBotsOrHostReady = true;
    for (const [sid, p] of domain.players.entries()) {
      p.arenaLoaded = Boolean(p.isBot || sid === 'host');
      if (!p.arenaLoaded) allBotsOrHostReady = false;
    }

    commandQueue.dispatchSignal(
      MATCH_SIGNALS.MATCH_PREPARE,
      domain.matchTick,
      commandQueue.matchSequence,
      domain.clockDuration
    );
    emitRosterJoinAndLoadoutSignals(commandQueue, domain.players.values(), domain.matchTick);
    if (allBotsOrHostReady) this.startMatch(domain.clockDuration);
  }

  checkArenaLoadedBarrier(): boolean {
    const { domain } = this.host;
    if (domain.state !== MATCH_STATES.PREPARE) return false;
    for (const p of domain.players.values()) {
      if (!p.isBot && !p.arenaLoaded) return false;
    }
    this.startMatch(domain.clockDuration);
    return true;
  }

  triggerStartCountdown(countdownSeconds = 3): void {
    this.host.domain.beginCountdownPhase(countdownSeconds);
  }

  forceStartMatch(durationSeconds: number | null = null): void {
    const { domain } = this.host;
    domain.resolveValidDuration(durationSeconds);
    let hasRemoteHuman = false;
    for (const [sid, p] of domain.players.entries()) {
      if (!p.isBot && sid !== 'host') {
        hasRemoteHuman = true;
        break;
      }
    }
    if (hasRemoteHuman && domain.state === MATCH_STATES.LOBBY) {
      this.initiateMatchPrepare(domain.clockDuration, 120);
    } else {
      this.startMatch(domain.clockDuration);
    }
  }

  startMatch(durationSeconds?: number | null): void {
    const {
      domain,
      physicsManager,
      replayBuffer,
      onClearRetainedReplay,
      roster,
      commandQueue,
      goalReplay,
    } = this.host;

    if (typeof onClearRetainedReplay === 'function') onClearRetainedReplay();
    domain.resetForMatchStart(durationSeconds);
    this.prepareArenaForActiveMatch();
    goalReplay.resetForMatchStart();
    commandQueue.resetForMatchStart();
    replayBuffer?.configureMode(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);

    if (physicsManager) {
      physicsManager.isPaused = false;
      physicsManager.applySignal(MATCH_SIGNALS.MATCH_STARTED);
      physicsManager.resetKickoff(0);
      roster.applyRosterKickoffSpawns();
      domain.matchTick = physicsManager.currentTick;
    }

    const modeCode = domain.gameMode === '1v1' ? 1 : domain.gameMode === '2v2' ? 2 : 3;
    commandQueue.dispatchSignal(MATCH_SIGNALS.MATCH_INITIALIZED, domain.matchTick, modeCode, domain.clockDuration);
    commandQueue.dispatchSignal(MATCH_SIGNALS.MATCH_STARTED, domain.matchTick, domain.clockSecondsRemaining, 0);
    emitRosterJoinAndLoadoutSignals(commandQueue, domain.players.values(), domain.matchTick);
    commandQueue.dispatchSignal(MATCH_SIGNALS.SCORE_UPDATED, domain.matchTick, domain.blueScore, domain.orangeScore);
    if (domain.isOvertime) {
      domain.pendingOvertimeAfterGoal = true;
      domain.isOvertime = false;
    }
    this.startKickoffSequence(KICKOFF_TOTAL_TICKS);
  }

  enterLobbyMode(options: Record<string, any> = {}): MatchState {
    const {
      domain,
      physicsManager,
      sessionManager,
      diagnosticsController,
      replayBuffer,
      roster,
      commandQueue,
    } = this.host;

    const lobbyPhysicsActive =
      options.lobbyPhysicsActive !== undefined ? Boolean(options.lobbyPhysicsActive) : true;
    domain.enterLobbyState(lobbyPhysicsActive);
    commandQueue.activeSignals.clear();
    sessionManager?.signalBuffer?.clear?.();
    replayBuffer?.configureMode(REPLAY_BUFFER_MODES.COUNTUP_FIFO);

    const prevApplying = roster.applyingBotFillPolicy;
    roster.applyingBotFillPolicy = true;
    try {
      for (const [sid, p] of Array.from(domain.players.entries())) {
        if (p.isBot && String(sid).startsWith('bot_fill_')) roster.removePlayerSession(sid);
      }
    } finally {
      roster.applyingBotFillPolicy = prevApplying;
    }

    configureLobbyPhysicsArena({
      physicsManager,
      sessionManager,
      diagnosticsController,
      players: domain.players,
      applyRosterKickoffSpawns: () => roster.applyRosterKickoffSpawns(),
      options,
    });
    roster.broadcastRosterUpdate();
    return domain.state;
  }

  resetTrainingPlay(): void {
    const { domain, physicsManager, roster, commandQueue, goalReplay } = this.host;
    domain.resetForTrainingPlay();
    goalReplay.replayTicksRemaining = -1;
    if (physicsManager) {
      roster.applyPendingHitboxSwaps();
      physicsManager.resetKickoff(0);
      roster.applyRosterKickoffSpawns();
      physicsManager.setInputMask(false);
      domain.matchTick = physicsManager.currentTick;
    }
    commandQueue.dispatchSignal(MATCH_SIGNALS.BALL_RESET, domain.matchTick, 0, 0);
  }

  startKickoffSequence(countdownTicks = KICKOFF_TOTAL_TICKS): void {
    const { domain, physicsManager, roster, commandQueue, goalReplay } = this.host;
    goalReplay.replayTicksRemaining = -1;
    commandQueue.skipReplayVotes.clear();
    if (physicsManager) {
      roster.applyPendingHitboxSwaps();
      physicsManager.resetKickoff(0);
      roster.applyRosterKickoffSpawns();
      domain.matchTick = physicsManager.currentTick;
    }

    const { startedOvertime, kickoffWillStartAt } = domain.beginKickoffPhase(countdownTicks);
    if (startedOvertime) {
      commandQueue.retireSignalTypes(
        [
          MATCH_SIGNALS.TIME_ALERT_60S,
          MATCH_SIGNALS.TIME_ALERT_30S,
          MATCH_SIGNALS.COUNTDOWN_10S,
          MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
        ],
        true
      );
      commandQueue.dispatchSignal(MATCH_SIGNALS.OVERTIME_START, domain.matchTick, 0, 0);
    }

    commandQueue.dispatchSignal(
      MATCH_SIGNALS.KICKOFF_WILL_START,
      domain.matchTick,
      kickoffWillStartAt,
      domain.isOvertime ? 1 : 0
    );
    physicsManager?.applySignal(MATCH_SIGNALS.KICKOFF_WILL_START, {
      kickoffWillStartAt,
    });
  }

  setPaused(pause: boolean): void {
    const { domain, physicsManager, commandQueue } = this.host;
    if (domain.state !== MATCH_STATES.PLAYING && domain.state !== MATCH_STATES.PAUSED) return;
    domain.applyPauseState(pause);
    const sig = pause ? MATCH_SIGNALS.MATCH_PAUSED : MATCH_SIGNALS.MATCH_RESUMED;
    physicsManager?.applySignal(sig, { paused: pause });
    commandQueue.dispatchSignal(sig, domain.matchTick);
  }

  requestResumeWithCountdown(countdownSeconds = 5): void {
    const { domain, physicsManager, commandQueue } = this.host;
    if (domain.state !== MATCH_STATES.PAUSED) return;
    const resumeTicks = Math.max(1, Math.round(countdownSeconds * 120));
    const targetTick = domain.scheduleResumeAtTick(resumeTicks);
    physicsManager?.applySignal(MATCH_SIGNALS.MATCH_WILL_RESUME, {
      targetResumeTick: targetTick,
    });
    commandQueue.dispatchSignal(
      MATCH_SIGNALS.MATCH_WILL_RESUME,
      domain.matchTick,
      targetTick,
      countdownSeconds
    );
  }

  resolvePossessionWinner(): number {
    return resolvePossessionTieBreakWinner(this.host.physicsManager);
  }

  endMatch(forcedWinner: number | null = null, winReason = 0): void {
    const {
      domain,
      physicsManager,
      replayBuffer,
      onRetainCompletedReplay,
      roster,
      commandQueue,
    } = this.host;

    const winner = domain.recordMatchEnded(forcedWinner, winReason);
    physicsManager?.applySignal(MATCH_SIGNALS.MATCH_ENDED, { winner, winReason });
    commandQueue.retireSignalTypes(
      [
        MATCH_SIGNALS.KICKOFF_WILL_START,
        MATCH_SIGNALS.SCORE_UPDATED,
        MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
      ],
      true
    );
    commandQueue.dispatchSignal(MATCH_SIGNALS.MATCH_ENDED, domain.matchTick, winner, winReason);
    if (domain.isHost && typeof onRetainCompletedReplay === 'function' && replayBuffer && replayBuffer.size > 0) {
      const rosterMeta = roster.getMatchRosterMetadata();
      onRetainCompletedReplay({
        engine: physicsManager?.sim || null,
        ringBuffer: replayBuffer,
        signals: commandQueue.replaySignalLog,
        winnerTeam: winner,
        blueScore: domain.blueScore,
        orangeScore: domain.orangeScore,
        gameMode: domain.gameMode || '3v3',
        durationSeconds: domain.clockDuration,
        roster: rosterMeta,
        loadouts: rosterMeta,
      });
    }
  }

  enterPodiumPhase(): void {
    const { domain, physicsManager, commandQueue } = this.host;
    if (domain.state !== MATCH_STATES.ENDED) return;
    const { winner, winReason } = domain.enterPodiumState();
    physicsManager?.applySignal(MATCH_SIGNALS.PODIUM_START, { winner, winReason });
    commandQueue.dispatchSignal(MATCH_SIGNALS.PODIUM_START, domain.matchTick, winner, winReason);
  }

  startTrainingMode(options: Record<string, any> = {}): void {
    const { domain, physicsManager, replayBuffer, commandQueue } = this.host;
    domain.configureTrainingStart(options);
    commandQueue.resetForTrainingStart();
    const capTicks =
      options.replayCapacityTicks || (options.fifoDurationSeconds ? Math.round(options.fifoDurationSeconds * 120) : null);
    replayBuffer?.configureMode(REPLAY_BUFFER_MODES.COUNTUP_FIFO, capTicks);
    if (physicsManager) {
      physicsManager.setInputMask(false);
      physicsManager.isPaused = false;
      physicsManager.isRecordingFullReplay = true;
      physicsManager.sim?.setReplayRecordingActive?.(true);
      if (options.unlimitedBoost !== undefined) {
        physicsManager.sim?.setUnlimitedBoost?.(Boolean(options.unlimitedBoost));
      }
      if (options.initialState) {
        physicsManager.sim?.restoreState?.(options.initialState);
      } else if (options.resetKickoff) {
        physicsManager.resetKickoff(0);
      }
      domain.matchTick = Math.floor(
        physicsManager.sim?.getHeaderView?.()?.tickCount ?? physicsManager.currentTick ?? 0
      );
    } else {
      domain.matchTick = 0;
    }
  }

  private handleGoalScoredInPlay(physicsSnapshot: any): void {
    const { domain, physicsManager, goalReplay, commandQueue } = this.host;
    const outcome = evaluateGoalScoredOutcome({
      physicsSnapshot,
      physicsManager,
      matchTick: domain.matchTick,
      isTrainingMode: domain.isTrainingMode,
      trainingDisableGoalReset: domain.trainingDisableGoalReset,
      trainingGoalReplayEnabled: domain.trainingGoalReplayEnabled,
      trainingGoalCelebrationTicks: domain.trainingGoalCelebrationTicks,
      isOvertime: domain.isOvertime,
      clockSecondsRemaining: domain.clockSecondsRemaining,
      blueScore: domain.blueScore,
      orangeScore: domain.orangeScore,
      skipReplayByDefault: domain.skipReplayByDefault,
      goalReplayController: goalReplay,
      commandController: commandQueue,
      pendingOvertimeAfterGoal: domain.pendingOvertimeAfterGoal,
      pendingMatchEndAfterGoal: domain.pendingMatchEndAfterGoal,
      pendingMatchWinner: domain.pendingMatchWinner,
    });
    if (outcome.ignoredGoal) return;
    domain.applyGoalScoredOutcome(outcome);
  }

  private stepEndedOrPodiumFrame(): Uint8Array {
    const { domain, physicsManager, sessionManager, commandQueue } = this.host;
    if (domain.state === MATCH_STATES.ENDED) {
      if (typeof domain.podiumDelayTicks === 'number' && domain.podiumDelayTicks > 0) {
        if (--domain.podiumDelayTicks <= 0) this.enterPodiumPhase();
      } else {
        this.enterPodiumPhase();
      }
    }
    let podiumSnapshot: any = null;
    if (physicsManager && !physicsManager.isPaused) {
      podiumSnapshot = physicsManager.stepAuthoritativeTick();
      domain.matchTick = podiumSnapshot.tick;
    } else {
      domain.matchTick++;
    }
    sessionManager?.signalBuffer?.pruneExpired(domain.matchTick, sessionManager.sessions?.keys?.());
    return podiumSnapshot ||
      commandQueue.activeSignals.size > 0 ||
      (sessionManager?.signalBuffer?.entries?.size || 0) > 0
      ? this.encodeFramePacket(podiumSnapshot)
      : new Uint8Array(0);
  }

  private stepLobbyFrame(): Uint8Array {
    const { domain, physicsManager, diagnosticsController, commandQueue } = this.host;
    if (domain.lobbyPhysicsActive && physicsManager) {
      if (physicsManager.inputBuffer && !physicsManager.inputBuffer.lobbyMode) {
        physicsManager.inputBuffer.setLobbyMode(true);
      }
      if (diagnosticsController?.enabled) {
        diagnosticsController.applyToAuthority(physicsManager, physicsManager.currentTick);
      }
      const lobbySnapshot = physicsManager.stepAuthoritativeTick();
      domain.matchTick = lobbySnapshot.tick;
      if (lobbySnapshot.goalScored) physicsManager.resetBallToCenter();
      return this.encodeFramePacket(lobbySnapshot);
    }
    return commandQueue.activeSignals.size > 0 ? this.encodeFramePacket(null) : new Uint8Array(0);
  }

  private advancePlayingClockAndRegulationEnd(physicsSnapshot: any): void {
    const { domain, physicsManager, commandQueue } = this.host;
    advancePlayingClockState({
      domain,
      physicsManager,
      physicsSnapshot,
      commandQueue,
      onStartOvertimeKickoff: (ticks) => this.startKickoffSequence(ticks),
      onEndMatch: (winner, reason) => this.endMatch(winner, reason),
    });
  }

  stepFrame(): Uint8Array {
    const { domain, physicsManager, commandQueue, goalReplay, systemControl } = this.host;

    const stateOnlyPacket = systemControl?.stepStateOnlyFrameIfActive?.();
    if (stateOnlyPacket) {
      return stateOnlyPacket;
    }
    if (domain.state === MATCH_STATES.ENDED || domain.state === MATCH_STATES.PODIUM) {
      return this.stepEndedOrPodiumFrame();
    }
    if (domain.state === MATCH_STATES.PREPARE) {
      domain.matchTick = physicsManager ? physicsManager.currentTick : domain.matchTick + 1;
      if (--domain.prepareTimeoutTicks <= 0) {
        this.startMatch(domain.clockDuration);
      } else {
        return this.encodeFramePacket(null);
      }
    }
    if (domain.state === MATCH_STATES.COUNTDOWN) {
      domain.matchTick = physicsManager ? physicsManager.currentTick : domain.matchTick + 1;
      if (--domain.startCountdownTicks <= 0) {
        this.initiateMatchPrepare(domain.clockDuration, 120);
      }
      return this.encodeFramePacket(null);
    }
    if (domain.state === MATCH_STATES.LOBBY) return this.stepLobbyFrame();
    if (domain.state === MATCH_STATES.PAUSED && domain.willResumeUntilTick > 0) {
      if (++domain.matchTick >= domain.willResumeUntilTick) this.setPaused(false);
      return this.encodeFramePacket(null);
    }
    if (domain.state === MATCH_STATES.GOAL_SCORED && --domain.goalBufferTicks <= 0) {
      if (domain.isTrainingMode && !domain.trainingGoalReplayEnabled) this.resetTrainingPlay();
      else goalReplay.beginGoalReplay();
    }
    if (domain.state === MATCH_STATES.REPLAY) {
      const replayStep = goalReplay.stepReplayTick();
      if (!replayStep.finished) return this.encodeFramePacket(replayStep.replayPhysicsSnapshot);
    }

    let physicsSnapshot: any = null;
    if (physicsManager) {
      goalReplay.stepServerFilledBots();
      physicsSnapshot = physicsManager.stepAuthoritativeTick();
      domain.matchTick = physicsSnapshot.tick;
      dispatchFlipResetIncidents(physicsSnapshot.incidents, domain.matchTick, commandQueue);
      if (physicsSnapshot.goalScored && domain.state === MATCH_STATES.PLAYING) {
        this.handleGoalScoredInPlay(physicsSnapshot);
      }
    } else {
      domain.matchTick++;
    }

    if (
      domain.state === MATCH_STATES.KICKOFF &&
      domain.matchTick >= domain.kickoffWillStartAt &&
      domain.kickoffWillStartAt > 0
    ) {
      domain.completeKickoffToPlaying();
      commandQueue.activeSignals.delete(MATCH_SIGNALS.KICKOFF_WILL_START);
      commandQueue.dispatchSignal(MATCH_SIGNALS.KICKOFF_START, domain.matchTick);
      physicsManager?.applySignal(MATCH_SIGNALS.KICKOFF_START);
    }

    this.advancePlayingClockAndRegulationEnd(physicsSnapshot);
    return this.encodeFramePacket(physicsSnapshot);
  }

  encodeFramePacket(physicsSnapshot: any): Uint8Array {
    const { domain, physicsManager, sessionManager, replayBuffer, commandQueue } = this.host;
    return encodeMatchGlobalFramePacket({
      state: domain.state,
      matchTick: domain.matchTick,
      physicsSnapshot,
      physicsManager,
      sessionManager,
      replayBuffer,
      commandController: commandQueue,
    });
  }
}
