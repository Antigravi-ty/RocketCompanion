/**
 * src/network/server/match/matchLifecyclePipeline.ts
 * Pure data pipelines and narrow-interface helpers for match lifecycle transitions,
 * lobby physics arena configuration, incident/clock signal dispatch, and frame encoding.
 */

import { MATCH_SIGNALS, GlobalPayloadCodec } from '../../protocol/GlobalPayloadCodec.ts';
import { FLIP_RESET_SUBTYPES, isBallFlipResetEvent } from '../../../physics/RocketSimConstants.ts';
import { packLoadoutSignalParam2 } from '../../../ui-core/config/vehicleConstants';
import { releasePodiumLocksOnEngine } from '../../../replay/podiumFormationPipeline.ts';
import {
  MATCH_STATES,
  KICKOFF_TOTAL_TICKS,
  collectSessionUserRtt,
  type MatchPlayerSlot,
  type MatchState,
  type ActiveMatchSignal,
  type ReplaySignalLogEntry,
  type RosterSessionManagerPort,
} from './matchLoadoutAndSpawnPipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';

export interface SignalDispatcherPort {
  dispatchSignal(signalType: number, frameId: number, param1?: number, param2?: number): ActiveMatchSignal | unknown;
  retireSignalTypes?(signalTypes: number[], retireBuffer?: boolean): void;
}

export interface LifecyclePhysicsManagerPort {
  inputBuffer?: {
    setLobbyMode?: (enabled: boolean) => void;
    registerCar?: (entityId: number) => void;
  } | null;
  sim?: {
    setCarLinearFactorAndGravity?: (
      carIndex: number,
      lx: number,
      ly: number,
      lz: number,
      gravityScale: number
    ) => void;
    setUnlimitedBoost?: (enabled: boolean) => void;
    getBallStateView?: () => { velX: number; velY: number; velZ: number } | null;
    saveCompactState?: () => Float32Array;
    saveState?: () => Float32Array;
  } | null;
  isPaused?: boolean;
  resetBallToCenter?: () => void;
  unregisterCarEntity: (entityId: number) => void;
  registerCarEntity: (entityId: number, team: number, hitboxOrVisual: string) => void;
  setInputMask: (masked: boolean) => void;
  setLobbyGhostMode: (enabled: boolean, options: Record<string, unknown>) => void;
  getPossessionStats?: () => {
    bluePoints?: number;
    blueFrames?: number;
    orangePoints?: number;
    orangeFrames?: number;
    team?: number;
  } | null;
  isBallOnGround: () => boolean;
  resetGoalLatch?: () => void;
  getActiveCarMask?: () => number;
}

export interface LifecycleDiagnosticsPort {
  enabled: boolean;
  configurePhysics: (physicsManager: LifecyclePhysicsManagerPort) => void;
}

export interface LifecycleIncidentEntry {
  type?: number;
  subType?: number;
  carIndex?: number;
  primaryId?: number;
  resetWheelCount?: number;
  flags?: number;
  [key: string]: unknown;
}

export interface LifecyclePhysicsSnapshotPort {
  kickoffTouched?: boolean;
  stateSnapshot?: Float32Array | null;
  goalTeam?: number;
  scoringTeam?: number;
  scorerCarIndex?: number;
  scorerTouchTick?: number;
  isReplaySlice?: boolean;
  incidents?: LifecycleIncidentEntry[] | null;
  acknowledgedControls?: Array<{ carIndex: number; controls: Record<string, number | boolean> }> | null;
  activeCarMask?: number;
}

export interface LifecycleGoalReplayPort {
  lastScorerCarIndex?: number;
  goalReplayPostGoalSeconds?: number;
  recordGoalIncident: (
    matchTick: number,
    scoringTeam: number,
    scorerCarIndex: number,
    scorerTouchTick: number,
    ballSpeedKph: number
  ) => void;
}

export interface LifecycleReplayBufferPort {
  recordFrame: (
    tick: number,
    stateSnapshot: Float32Array | null | undefined,
    signals: ReplaySignalLogEntry[],
    reserved: null,
    incidents: LifecycleIncidentEntry[] | null | undefined,
    acknowledgedControls: unknown
  ) => void;
}

export function emitRosterJoinAndLoadoutSignals(
  dispatcher: SignalDispatcherPort,
  players: Iterable<MatchPlayerSlot>,
  matchTick: number
): void {
  for (const p of players) {
    if (typeof p.entityId === 'number' && p.entityId >= 0) {
      dispatcher.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, matchTick, p.entityId, p.team ?? 0);
      dispatcher.dispatchSignal(
        MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
        matchTick,
        p.entityId,
        packLoadoutSignalParam2(
          p.visualIndex ?? p.visualId ?? 'octane',
          p.colorSlot ?? 0,
          p.hitboxIndex ?? p.hitboxId ?? 'hitbox-octane',
          {
            paintFinish: p.paintFinish || 'metallic',
            boostVisual: p.boostVisual || 'cartoon',
            boostAudio: p.boostAudio || 'rush',
          }
        )
      );
    }
  }
}

export function configureLobbyPhysicsArena(params: {
  physicsManager: LifecyclePhysicsManagerPort | null | undefined;
  sessionManager: RosterSessionManagerPort | null | undefined;
  diagnosticsController: LifecycleDiagnosticsPort | null | undefined;
  players: Map<string, MatchPlayerSlot>;
  applyRosterKickoffSpawns: () => void;
  options: Record<string, unknown>;
}): void {
  const { physicsManager, sessionManager, diagnosticsController, players, options } = params;
  if (!physicsManager) return;

  physicsManager.inputBuffer?.setLobbyMode?.(true);
  releasePodiumLocksOnEngine(physicsManager.sim as never);
  physicsManager.resetBallToCenter?.();
  const deferRemotePlayers = options.deferRemotePlayers !== false;

  for (const [sid, p] of players.entries()) {
    if (typeof p.entityId !== 'number' || p.entityId < 0) continue;
    const isRemoteLobbyPeer = deferRemotePlayers && sid !== 'host';
    if (p.isBot || isRemoteLobbyPeer) {
      physicsManager.unregisterCarEntity(p.entityId);
      if (!p.isBot && isRemoteLobbyPeer) {
        physicsManager.inputBuffer?.registerCar?.(p.entityId);
        const session = sessionManager?.getSession?.(sid);
        if (session) session.deferPhysicsRegistration = true;
      }
    } else {
      const session = sessionManager?.getSession?.(sid);
      if (session) session.deferPhysicsRegistration = false;
      physicsManager.registerCarEntity(
        p.entityId,
        p.team ?? p.entityId % 2,
        p.hitboxId || p.visualId || 'octane'
      );
      physicsManager.sim?.setCarLinearFactorAndGravity?.(p.entityId, 1, 1, 1, 1);
    }
  }

  params.applyRosterKickoffSpawns();
  physicsManager.setInputMask(false);
  physicsManager.isPaused = false;
  physicsManager.sim?.setUnlimitedBoost?.(true);
  physicsManager.setLobbyGhostMode(options.ghostCars !== false, {
    mode: options.mode || options.ghostMode || 'ghost_passthrough',
    hostCarIndex: options.hostCarIndex ?? 0,
    hostInteractsWithBall: options.hostInteractsWithBall ?? true,
    broadcastHostOnly: options.broadcastHostOnly ?? false,
    ghostOpacity: options.ghostOpacity ?? options.opacity ?? 0.7,
    ...options,
  });

  if (diagnosticsController && options.enableDiagnosticsFleet !== false) {
    diagnosticsController.enabled = true;
    diagnosticsController.configurePhysics(physicsManager);
  }
}

export function dispatchFlipResetIncidents(
  incidents: LifecycleIncidentEntry[] | null | undefined,
  matchTick: number,
  dispatcher: SignalDispatcherPort
): void {
  if (!Array.isArray(incidents) || incidents.length === 0) return;
  for (let i = 0; i < incidents.length; i++) {
    const inc = incidents[i];
    if (!inc || inc.type !== 0x0f || !isBallFlipResetEvent(inc as never)) continue;
    if ((inc.resetWheelCount ?? 0) <= 0 && ((inc.flags ?? 0) & 0xff00) === 0) continue;
    const carIdx =
      typeof inc.carIndex === 'number' && inc.carIndex >= 0 ? inc.carIndex : (inc.primaryId ?? 0);
    dispatcher.dispatchSignal(0x0f, matchTick, carIdx, inc.subType || FLIP_RESET_SUBTYPES.BALL);
  }
}

export function dispatchCountdownClockSecondSignals(
  dispatcher: SignalDispatcherPort,
  matchTick: number,
  clockSecondsRemaining: number
): void {
  dispatcher.dispatchSignal(
    MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
    matchTick,
    clockSecondsRemaining,
    0
  );
  if (clockSecondsRemaining === 60) {
    dispatcher.dispatchSignal(MATCH_SIGNALS.TIME_ALERT_60S, matchTick, 60, 0);
  } else if (clockSecondsRemaining === 30) {
    dispatcher.dispatchSignal(MATCH_SIGNALS.TIME_ALERT_30S, matchTick, 30, 0);
  } else if (clockSecondsRemaining <= 10 && clockSecondsRemaining >= 1) {
    dispatcher.dispatchSignal(MATCH_SIGNALS.COUNTDOWN_10S, matchTick, clockSecondsRemaining, 0);
  }
}

export function resolvePossessionTieBreakWinner(
  physicsManager: LifecyclePhysicsManagerPort | null | undefined
): number {
  const stats = physicsManager?.getPossessionStats?.();
  if (stats) {
    const blueVal = stats.bluePoints ?? stats.blueFrames ?? 0;
    const orangeVal = stats.orangePoints ?? stats.orangeFrames ?? 0;
    if (blueVal > orangeVal) return 0;
    if (orangeVal > blueVal) return 1;
    if (stats.team === 1) return 0;
    if (stats.team === 2) return 1;
  }
  return 0;
}

export function advancePlayingClockState(params: {
  domain: MatchDomainState;
  physicsManager: LifecyclePhysicsManagerPort | null | undefined;
  physicsSnapshot: LifecyclePhysicsSnapshotPort | null | undefined;
  commandQueue: SignalDispatcherPort;
  onStartOvertimeKickoff: (countdownTicks: number) => void;
  onEndMatch: (forcedWinner: number | null, winReason: number) => void;
}): void {
  const { domain, physicsManager, physicsSnapshot, commandQueue } = params;
  if (domain.state === MATCH_STATES.PLAYING && !domain.clockStarted) {
    if (
      !physicsManager ||
      physicsSnapshot?.kickoffTouched ||
      (domain.kickoffStartedAtTick >= 0 && domain.matchTick - domain.kickoffStartedAtTick >= 600)
    ) {
      domain.clockStarted = true;
    }
  }

  if (domain.state === MATCH_STATES.PLAYING && domain.clockStarted && domain.matchTick % 120 === 0) {
    const step = domain.advanceClockTickSecond();
    if (step.mode === 'training') {
      commandQueue.dispatchSignal(
        MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
        domain.matchTick,
        step.seconds,
        2
      );
    } else if (step.mode === 'regulation') {
      dispatchCountdownClockSecondSignals(commandQueue, domain.matchTick, step.seconds);
    } else if (step.mode === 'overtime') {
      commandQueue.dispatchSignal(
        MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
        domain.matchTick,
        step.seconds,
        1
      );
      if (step.overtimeExpired) {
        params.onEndMatch(resolvePossessionTieBreakWinner(physicsManager), 1);
      }
    }
  }

  if (
    !domain.isTrainingMode &&
    domain.state === MATCH_STATES.PLAYING &&
    !domain.isOvertime &&
    domain.clockSecondsRemaining === 0 &&
    (physicsManager ? physicsManager.isBallOnGround() : true)
  ) {
    if (domain.blueScore === domain.orangeScore) {
      domain.pendingOvertimeAfterGoal = true;
      params.onStartOvertimeKickoff(KICKOFF_TOTAL_TICKS);
      const sim = physicsManager?.sim;
      if (physicsSnapshot && sim) {
        physicsSnapshot.stateSnapshot =
          typeof sim.saveCompactState === 'function'
            ? sim.saveCompactState()
            : typeof sim.saveState === 'function'
              ? sim.saveState()
              : physicsSnapshot.stateSnapshot;
      }
    } else {
      params.onEndMatch(null, 0);
    }
  }
}

export interface GoalScoredResolutionResult {
  scoringTeam: number;
  celebrationTicks: number;
  ignoredGoal?: boolean;
  blueScore: number;
  orangeScore: number;
  pendingOvertimeAfterGoal: boolean;
  pendingMatchEndAfterGoal: boolean;
  pendingMatchWinner: number | null;
}

export function evaluateGoalScoredOutcome(params: {
  physicsSnapshot: LifecyclePhysicsSnapshotPort;
  physicsManager: LifecyclePhysicsManagerPort | null | undefined;
  matchTick: number;
  isTrainingMode: boolean;
  trainingDisableGoalReset?: boolean;
  trainingGoalReplayEnabled?: boolean;
  trainingGoalCelebrationTicks?: number;
  isOvertime: boolean;
  clockSecondsRemaining: number;
  blueScore: number;
  orangeScore: number;
  skipReplayByDefault: boolean;
  goalReplayController: LifecycleGoalReplayPort;
  commandController: SignalDispatcherPort;
  pendingOvertimeAfterGoal: boolean;
  pendingMatchEndAfterGoal: boolean;
  pendingMatchWinner: number | null;
}): GoalScoredResolutionResult {
  const {
    physicsSnapshot,
    physicsManager,
    matchTick,
    isTrainingMode,
    trainingDisableGoalReset = false,
    trainingGoalReplayEnabled,
    trainingGoalCelebrationTicks,
    isOvertime,
    clockSecondsRemaining,
    skipReplayByDefault,
    goalReplayController,
    commandController,
  } = params;

  let { blueScore, orangeScore, pendingOvertimeAfterGoal, pendingMatchEndAfterGoal, pendingMatchWinner } =
    params;

  const scoringTeam = physicsSnapshot.goalTeam ?? physicsSnapshot.scoringTeam ?? 0;
  if (isTrainingMode && trainingDisableGoalReset) {
    physicsManager?.resetGoalLatch?.();
    return {
      scoringTeam,
      celebrationTicks: 0,
      ignoredGoal: true,
      blueScore,
      orangeScore,
      pendingOvertimeAfterGoal,
      pendingMatchEndAfterGoal,
      pendingMatchWinner,
    };
  }

  const bv = physicsManager?.sim?.getBallStateView?.();
  const ballSpeedKph = bv
    ? Math.max(1, Math.round(Math.hypot(bv.velX, bv.velY, bv.velZ) * 0.036))
    : 100;
  goalReplayController.recordGoalIncident(
    matchTick,
    scoringTeam,
    physicsSnapshot.scorerCarIndex ?? 0,
    physicsSnapshot.scorerTouchTick ?? -1,
    ballSpeedKph
  );
  commandController.retireSignalTypes?.([
    MATCH_SIGNALS.KICKOFF_WILL_START,
    MATCH_SIGNALS.KICKOFF_START,
    MATCH_SIGNALS.TIME_ALERT_60S,
    MATCH_SIGNALS.TIME_ALERT_30S,
    MATCH_SIGNALS.COUNTDOWN_10S,
  ]);

  if (isTrainingMode) {
    physicsManager?.setInputMask(false);
    const celebrationTicks = Math.max(1, Math.round(trainingGoalCelebrationTicks ?? 150));
    if (trainingGoalReplayEnabled) {
      if (scoringTeam === 0) blueScore++;
      else orangeScore++;
      commandController.dispatchSignal(MATCH_SIGNALS.SCORE_UPDATED, matchTick, blueScore, orangeScore);
      const goalMetaParam1 =
        (scoringTeam & 0x1) |
        (((goalReplayController.lastScorerCarIndex ?? 0) & 0xff) << 8) |
        ((ballSpeedKph & 0xffff) << 16);
      commandController.dispatchSignal(
        MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
        matchTick,
        goalMetaParam1,
        matchTick + celebrationTicks
      );
    }
    return {
      scoringTeam,
      celebrationTicks,
      blueScore,
      orangeScore,
      pendingOvertimeAfterGoal,
      pendingMatchEndAfterGoal,
      pendingMatchWinner,
    };
  }

  const celebrationTicks = Math.max(
    1,
    Math.round((goalReplayController.goalReplayPostGoalSeconds ?? 3.0) * 120)
  );
  if (scoringTeam === 0) blueScore++;
  else orangeScore++;
  commandController.dispatchSignal(MATCH_SIGNALS.SCORE_UPDATED, matchTick, blueScore, orangeScore);
  if (!skipReplayByDefault) {
    const goalMetaParam1 =
      (scoringTeam & 0x1) |
      (((goalReplayController.lastScorerCarIndex ?? 0) & 0xff) << 8) |
      ((ballSpeedKph & 0xffff) << 16);
    commandController.dispatchSignal(
      MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
      matchTick,
      goalMetaParam1,
      matchTick + celebrationTicks
    );
  }

  if (isOvertime) {
    pendingMatchEndAfterGoal = true;
    pendingMatchWinner = scoringTeam;
  } else if (clockSecondsRemaining === 0) {
    if (blueScore === orangeScore) {
      pendingOvertimeAfterGoal = true;
    } else {
      pendingMatchEndAfterGoal = true;
      pendingMatchWinner = blueScore > orangeScore ? 0 : 1;
    }
  }

  return {
    scoringTeam,
    celebrationTicks,
    blueScore,
    orangeScore,
    pendingOvertimeAfterGoal,
    pendingMatchEndAfterGoal,
    pendingMatchWinner,
  };
}

export function encodeMatchGlobalFramePacket(params: {
  state: MatchState;
  matchTick: number;
  physicsSnapshot: LifecyclePhysicsSnapshotPort | null | undefined;
  physicsManager: LifecyclePhysicsManagerPort | null | undefined;
  sessionManager: RosterSessionManagerPort | null | undefined;
  replayBuffer: LifecycleReplayBufferPort | null | undefined;
  commandController: {
    currentFrameSignals: ReplaySignalLogEntry[];
    activeSignals: Map<string | number, ActiveMatchSignal>;
    lastRttBroadcastTick: number;
    rttIntervalTicks: number;
  };
}): Uint8Array {
  const {
    state,
    matchTick,
    physicsSnapshot,
    physicsManager,
    sessionManager,
    replayBuffer,
    commandController,
  } = params;

  const isReplayOrPaused =
    state === MATCH_STATES.REPLAY ||
    Boolean(physicsSnapshot?.isReplaySlice) ||
    (state === MATCH_STATES.PAUSED && commandController.currentFrameSignals.length === 0);

  if (
    replayBuffer &&
    !isReplayOrPaused &&
    (physicsSnapshot || commandController.currentFrameSignals.length > 0)
  ) {
    replayBuffer.recordFrame(
      matchTick,
      physicsSnapshot ? physicsSnapshot.stateSnapshot : null,
      commandController.currentFrameSignals,
      null,
      physicsSnapshot ? physicsSnapshot.incidents : null,
      physicsSnapshot ? physicsSnapshot.acknowledgedControls : null
    );
    commandController.currentFrameSignals.length = 0;
  } else if (commandController.currentFrameSignals.length > 0) {
    commandController.currentFrameSignals.length = 0;
  }

  let allUserRttData: ReturnType<typeof collectSessionUserRtt> | null = null;
  if (
    matchTick - commandController.lastRttBroadcastTick >=
    commandController.rttIntervalTicks
  ) {
    commandController.lastRttBroadcastTick = matchTick;
    allUserRttData = collectSessionUserRtt(sessionManager);
  }

  const signalsList = Array.from(commandController.activeSignals.values());

  const globalPayloadBytes = GlobalPayloadCodec.encode({
    physics: physicsSnapshot
      ? {
          tick: matchTick,
          activeCarMask:
            physicsSnapshot.activeCarMask ?? physicsManager?.getActiveCarMask?.(),
          stateSnapshot: physicsSnapshot.stateSnapshot || new Float32Array(0),
          acknowledgedControls: physicsSnapshot.acknowledgedControls || undefined,
        }
      : null,
    signals: signalsList,
    allUserRtt: allUserRttData,
  });

  for (const [sKey, sObj] of commandController.activeSignals.entries()) {
    if (sObj.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START) {
      if (typeof sObj.remainingRedundancy === 'number') {
        sObj.remainingRedundancy--;
        if (sObj.remainingRedundancy <= 0) {
          commandController.activeSignals.delete(sKey);
        }
      } else {
        commandController.activeSignals.delete(sKey);
      }
    }
  }

  return globalPayloadBytes;
}
