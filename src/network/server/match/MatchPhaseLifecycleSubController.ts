/**
 * src/network/server/match/MatchPhaseLifecycleSubController.ts
 * Stateful SubController owning the authoritative match phase state machine
 * (lobby, prepare barrier, countdown, kickoff, playing, goal scored, replay,
 * pause/resume, overtime, ended, podium), clock progression, and frame packet encoding.
 */

import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import { REPLAY_BUFFER_MODES } from '../../../replay/ReplayRingBuffer.ts';
import {
  MATCH_STATES, DEFAULT_MATCH_DURATION_SECONDS, KICKOFF_TOTAL_TICKS,
  type MatchState, type RosterSessionManagerPort,
} from './matchLoadoutAndSpawnPipeline.ts';
import {
  emitRosterJoinAndLoadoutSignals, configureLobbyPhysicsArena, dispatchFlipResetIncidents,
  resolvePossessionTieBreakWinner, evaluateGoalScoredOutcome, encodeMatchGlobalFramePacket,
  advancePlayingClockState,
  type LifecyclePhysicsManagerPort, type LifecyclePhysicsSnapshotPort,
  type LifecycleDiagnosticsPort, type LifecycleReplayBufferPort,
} from './matchLifecyclePipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';
import type { MatchRosterSubController } from './MatchRosterSubController.ts';
import type { MatchCommandQueueSubController } from './MatchCommandQueueSubController.ts';
import type { MatchGoalReplaySubController } from './MatchGoalReplaySubController.ts';
import type { MatchSystemControlSubController } from './MatchSystemControlSubController.ts';

export type LobbyEnterOptions = Record<string, unknown>;

export interface PhaseLifecyclePhysicsSnapshotPort extends LifecyclePhysicsSnapshotPort {
  tick: number;
  goalScored?: boolean;
}

export interface PhaseLifecyclePhysicsManagerPort extends LifecyclePhysicsManagerPort {
  currentTick: number;
  isRecordingFullReplay?: boolean;
  inputBuffer?: {
    lobbyMode?: boolean;
    setLobbyMode: (enabled: boolean) => void;
    registerCar?: (entityId: number) => void;
  } | null;
  sim?: (NonNullable<LifecyclePhysicsManagerPort['sim']> & {
    setReplayRecordingActive?: (enabled: boolean) => void;
    restoreState?: (snapshot: Float32Array | number[]) => void;
    getHeaderView?: () => { tickCount?: number } | null;
  }) | null;
  restoreSolidCollisions?: () => void;
  resetKickoff: (mode: number) => void;
  applySignal: (signal: number | string, payload?: Record<string, unknown>) => void;
  stepAuthoritativeTick: () => PhaseLifecyclePhysicsSnapshotPort;
  resetBallToCenter: () => void;
}

export interface PhaseLifecycleSessionManagerPort extends RosterSessionManagerPort {
  sessions?: Map<string, unknown>;
  signalBuffer?: {
    entries?: Map<unknown, unknown>;
    clear?: () => void;
    pruneExpired: (tick: number, keys?: Iterable<string>) => void;
  } | null;
}

export interface PhaseLifecycleDiagnosticsPort extends LifecycleDiagnosticsPort {
  releasePhysics: (physicsManager: PhaseLifecyclePhysicsManagerPort) => void;
  applyToAuthority: (physicsManager: PhaseLifecyclePhysicsManagerPort, tick: number) => void;
}

export interface PhaseLifecycleReplayBufferPort extends LifecycleReplayBufferPort {
  size: number;
  configureMode: (mode: string, capacityTicks?: number | null) => void;
}

export interface MatchPhaseLifecycleHostPort {
  readonly domain: MatchDomainState;
  readonly roster: MatchRosterSubController;
  readonly commandQueue: MatchCommandQueueSubController;
  readonly goalReplay: MatchGoalReplaySubController;
  readonly systemControl?: MatchSystemControlSubController;
  readonly physicsManager: PhaseLifecyclePhysicsManagerPort | null | undefined;
  readonly sessionManager: PhaseLifecycleSessionManagerPort | null | undefined;
  readonly diagnosticsController: PhaseLifecycleDiagnosticsPort | null | undefined;
  readonly replayBuffer: PhaseLifecycleReplayBufferPort | null | undefined;
  readonly onClearRetainedReplay: (() => void) | null;
  readonly onRetainCompletedReplay: ((data: Record<string, unknown>) => void) | null;
}

export class MatchPhaseLifecycleSubController {
  readonly host: MatchPhaseLifecycleHostPort;

  constructor(host: MatchPhaseLifecycleHostPort) {
    this.host = host;
  }

  get state(): MatchState { return this.host.domain.state; }
  set state(v: MatchState) { this.host.domain.state = v; }
  get matchTick(): number { return this.host.domain.matchTick; }
  set matchTick(v: number) { this.host.domain.matchTick = v; }
  get winner(): number | null { return this.host.domain.winner; }
  set winner(v: number | null) { this.host.domain.winner = v; }

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
    domain.beginPrepareOrCountdown('prepare', durationSeconds, timeoutTicks);
    this.prepareArenaForActiveMatch();
    commandQueue.matchSequence = ((commandQueue.matchSequence || 0) + 1) & 0xffff;
    if (physicsManager) {
      physicsManager.resetKickoff(0);
      roster.applyRosterKickoffSpawns();
      physicsManager.setInputMask?.(true);
    }
    const { allReady, clockDuration } = domain.beginPrepareOrCountdown(
      'prepare',
      durationSeconds,
      timeoutTicks,
      physicsManager?.currentTick
    );

    commandQueue.dispatchSignal(
      MATCH_SIGNALS.MATCH_PREPARE, domain.matchTick, commandQueue.matchSequence, clockDuration
    );
    emitRosterJoinAndLoadoutSignals(commandQueue, roster.players.values(), domain.matchTick);
    if (allReady) this.startMatch(clockDuration);
  }

  checkArenaLoadedBarrier(): boolean {
    const { allReady, clockDuration } = this.host.domain.beginPrepareOrCountdown('check_barrier');
    if (!allReady) return false;
    this.startMatch(clockDuration);
    return true;
  }

  triggerStartCountdown(countdownSeconds = 3): void {
    this.host.domain.beginPrepareOrCountdown('countdown', countdownSeconds);
  }

  forceStartMatch(durationSeconds: number | null = null): void {
    const { allReady, clockDuration } = this.host.domain.beginPrepareOrCountdown(
      'check_force_prepare',
      durationSeconds
    );
    if (allReady) {
      this.initiateMatchPrepare(clockDuration, 120);
    } else {
      this.startMatch(clockDuration);
    }
  }

  startMatch(durationSeconds?: number | null): void {
    const { domain, physicsManager, replayBuffer, onClearRetainedReplay, roster, commandQueue, goalReplay } = this.host;

    if (typeof onClearRetainedReplay === 'function') onClearRetainedReplay();
    const {
      modeCode,
      clockDuration,
      clockSecondsRemaining,
      blueScore,
      orangeScore,
    } = domain.resetForMatchStart(durationSeconds);
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

    commandQueue.dispatchSignal(MATCH_SIGNALS.MATCH_INITIALIZED, domain.matchTick, modeCode, clockDuration);
    commandQueue.dispatchSignal(MATCH_SIGNALS.MATCH_STARTED, domain.matchTick, clockSecondsRemaining, 0);
    emitRosterJoinAndLoadoutSignals(commandQueue, roster.players.values(), domain.matchTick);
    commandQueue.dispatchSignal(MATCH_SIGNALS.SCORE_UPDATED, domain.matchTick, blueScore, orangeScore);
    this.startKickoffSequence(KICKOFF_TOTAL_TICKS);
  }

  enterLobbyMode(options: Record<string, unknown> = {}): MatchState {
    const { domain, physicsManager, sessionManager, diagnosticsController, replayBuffer, roster, commandQueue } = this.host;

    const nextState = domain.applyLobbyOrTrainingTransition('lobby', options);
    commandQueue.activeSignals.clear();
    sessionManager?.signalBuffer?.clear?.();
    replayBuffer?.configureMode(REPLAY_BUFFER_MODES.COUNTUP_FIFO);

    const prevApplying = roster.applyingBotFillPolicy;
    roster.applyingBotFillPolicy = true;
    try {
      for (const [sid, p] of Array.from(roster.players.entries())) {
        if (p.isBot && String(sid).startsWith('bot_fill_')) roster.removePlayerSession(sid);
      }
    } finally {
      roster.applyingBotFillPolicy = prevApplying;
    }

    configureLobbyPhysicsArena({
      physicsManager,
      sessionManager,
      diagnosticsController,
      players: roster.players,
      applyRosterKickoffSpawns: () => roster.applyRosterKickoffSpawns(),
      options,
    });
    roster.broadcastRosterUpdate();
    return nextState;
  }

  resetTrainingPlay(): void {
    const { domain, physicsManager, roster, commandQueue, goalReplay } = this.host;
    domain.applyLobbyOrTrainingTransition('training_reset');
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

    const { startedOvertime, kickoffWillStartAt, isOvertime } = domain.beginKickoffPhase(countdownTicks);
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
      isOvertime ? 1 : 0
    );
    physicsManager?.applySignal(MATCH_SIGNALS.KICKOFF_WILL_START, {
      kickoffWillStartAt,
    });
  }

  setPaused(pause: boolean): void {
    const { domain, physicsManager, commandQueue } = this.host;
    if (!domain.applyPauseOrResume(pause).changed) return;
    const sig = pause ? MATCH_SIGNALS.MATCH_PAUSED : MATCH_SIGNALS.MATCH_RESUMED;
    physicsManager?.applySignal(sig, { paused: pause });
    commandQueue.dispatchSignal(sig, domain.matchTick);
  }

  requestResumeWithCountdown(countdownSeconds = 5): void {
    const { domain, physicsManager, commandQueue } = this.host;
    const { changed, targetResumeTick } = domain.applyPauseOrResume(null, countdownSeconds);
    if (!changed) return;
    physicsManager?.applySignal(MATCH_SIGNALS.MATCH_WILL_RESUME, {
      targetResumeTick,
    });
    commandQueue.dispatchSignal(
      MATCH_SIGNALS.MATCH_WILL_RESUME,
      domain.matchTick,
      targetResumeTick,
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

    const { winner, retentionPayload } = domain.recordMatchEndedOrPodium(
      'end',
      forcedWinner,
      winReason,
      {
        engine: physicsManager?.sim || null,
        ringBuffer: replayBuffer,
        signals: commandQueue.replaySignalLog,
        roster: roster.getMatchRosterMetadata(),
      }
    );
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
    if (typeof onRetainCompletedReplay === 'function' && retentionPayload) {
      onRetainCompletedReplay(retentionPayload);
    }
  }

  enterPodiumPhase(): void {
    const { domain, physicsManager, commandQueue } = this.host;
    const { changed, winner, winReason } = domain.recordMatchEndedOrPodium('podium');
    if (!changed) return;
    physicsManager?.applySignal(MATCH_SIGNALS.PODIUM_START, { winner, winReason });
    commandQueue.dispatchSignal(MATCH_SIGNALS.PODIUM_START, domain.matchTick, winner, winReason);
  }

  startTrainingMode(options: Record<string, unknown> = {}): void {
    const { domain, physicsManager, replayBuffer, commandQueue } = this.host;
    domain.applyLobbyOrTrainingTransition('training_start', options);
    commandQueue.resetForTrainingStart();
    const capTicks =
      typeof options.replayCapacityTicks === 'number'
        ? options.replayCapacityTicks
        : typeof options.fifoDurationSeconds === 'number'
          ? Math.round(options.fifoDurationSeconds * 120)
          : null;
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
        physicsManager.sim?.restoreState?.(options.initialState as Float32Array | number[]);
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

  private handleGoalScoredInPlay(physicsSnapshot: LifecyclePhysicsSnapshotPort): void {
    const { domain, physicsManager, goalReplay, commandQueue } = this.host;
    const outcome = evaluateGoalScoredOutcome({
      ...domain,
      physicsSnapshot,
      physicsManager,
      goalReplayController: goalReplay,
      commandController: commandQueue,
    });
    if (outcome.ignoredGoal) return;
    domain.applyGoalScoredOutcome(outcome);
  }

  private stepEndedOrPodiumFrame(): Uint8Array {
    const { domain, physicsManager, sessionManager, commandQueue } = this.host;
    if (domain.stepFramePhaseGate('ended_podium_tick').action === 'ended_or_podium') {
      this.enterPodiumPhase();
    }
    let podiumSnapshot: PhaseLifecyclePhysicsSnapshotPort | null = null;
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

  private advancePlayingClockAndRegulationEnd(
    physicsSnapshot: LifecyclePhysicsSnapshotPort | null
  ): void {
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
    const preGate = domain.stepFramePhaseGate('pre', physicsManager?.currentTick);
    switch (preGate.action) {
      case 'ended_or_podium':
        return this.stepEndedOrPodiumFrame();
      case 'start_from_prepare':
        this.startMatch(preGate.clockDuration);
        break;
      case 'initiate_prepare_from_countdown':
        this.initiateMatchPrepare(preGate.clockDuration, 120);
        return this.encodeFramePacket(null);
      case 'encode_null':
        return this.encodeFramePacket(null);
      case 'lobby':
        return this.stepLobbyFrame();
      case 'resume_from_pause':
        this.setPaused(false);
        return this.encodeFramePacket(null);
      case 'reset_training_play':
        this.resetTrainingPlay();
        break;
      case 'begin_goal_replay':
        goalReplay.beginGoalReplay();
        break;
      case 'replay': {
        const replayStep = goalReplay.stepReplayTick();
        if (!replayStep.finished) return this.encodeFramePacket(replayStep.replayPhysicsSnapshot);
        break;
      }
      default:
        break;
    }

    let physicsSnapshot: PhaseLifecyclePhysicsSnapshotPort | null = null;
    if (physicsManager) {
      goalReplay.stepServerFilledBots();
      physicsSnapshot = physicsManager.stepAuthoritativeTick();
      domain.matchTick = physicsSnapshot.tick;
      dispatchFlipResetIncidents(physicsSnapshot.incidents, domain.matchTick, commandQueue);
      if (physicsSnapshot.goalScored && domain.state === MATCH_STATES.PLAYING) {
        this.handleGoalScoredInPlay(physicsSnapshot);
      }
    }

    const postGate = domain.stepFramePhaseGate('post', physicsSnapshot?.tick, Boolean(physicsManager));
    if (postGate.action === 'kickoff_started') {
      commandQueue.activeSignals.delete(MATCH_SIGNALS.KICKOFF_WILL_START);
      commandQueue.dispatchSignal(MATCH_SIGNALS.KICKOFF_START, domain.matchTick);
      physicsManager?.applySignal(MATCH_SIGNALS.KICKOFF_START);
    }

    this.advancePlayingClockAndRegulationEnd(physicsSnapshot);
    return this.encodeFramePacket(physicsSnapshot);
  }

  encodeFramePacket(physicsSnapshot: LifecyclePhysicsSnapshotPort | null): Uint8Array {
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
