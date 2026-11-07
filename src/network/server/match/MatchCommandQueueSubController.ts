/**
 * src/network/server/match/MatchCommandQueueSubController.ts
 * Stateful SubController owning authoritative match signals, piggybacked ACK retirement,
 * reliable client command deduplication, voting (skip replay, rematch, forfeit),
 * and JSON control packet evaluation.
 */

import {
  MATCH_SIGNALS, SYSTEM_CONTROL_SIGNALS, CLIENT_COMMAND_TYPES,
} from '../../protocol/GlobalPayloadCodec.ts';
import {
  MATCH_STATES, collectSessionUserRtt,
  type ActiveMatchSignal, type ReplaySignalLogEntry, type UserRttSummary,
  type RosterSessionManagerPort,
} from './matchLoadoutAndSpawnPipeline.ts';
import {
  evaluateSessionControlPacket,
  type ClientCommandPayload, type ControlPacketPayload,
} from './matchSessionRoleSwitchPipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';
import type { MatchRosterSubController, RosterDataHandlerPort } from './MatchRosterSubController.ts';

export type { ClientCommandPayload, ControlPacketPayload };
export type ClientReliableCommand = ClientCommandPayload;

const ENTITY_SCOPED_SIGNALS = new Set<number>([
  MATCH_SIGNALS.PLAYER_JOINED, MATCH_SIGNALS.PLAYER_LEFT, MATCH_SIGNALS.PLAYER_SLOT_UPDATED,
  MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED, MATCH_SIGNALS.DEMOLITION, MATCH_SIGNALS.FLIP_RESET_GAINED,
]);

const NON_REPLAY_WIRE_SIGNALS = new Set<number>([
  MATCH_SIGNALS.CLOCK_UPDATED_SECONDS, MATCH_SIGNALS.COMMAND_ACK, MATCH_SIGNALS.FLIP_RESET_GAINED,
  SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
  SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
  SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
]);

export interface MatchCommandLifecycleActionsPort {
  initiateMatchPrepare(durationSeconds?: number | null, timeoutTicks?: number): void;
  checkArenaLoadedBarrier(): boolean;
  startMatch(durationSeconds?: number | null): void;
  finishGoalReplay(): void;
  setPaused(pause: boolean): void;
  requestResumeWithCountdown(countdownSeconds?: number): void;
  endMatch(forcedWinner?: number | null, winReason?: number): void;
  enterStateOnlyMode?(stateSnapshot?: Float32Array | number[] | null, cursorTick?: number): void;
  beginInterveneCountdown?(countdownSeconds?: number, stateSnapshot?: Float32Array | number[] | null): number;
  resumePhysicsFromState?(stateSnapshot?: Float32Array | number[] | null, resumeTick?: number): void;
}

export interface CommandQueuePhysicsPort {
  sim?: {
    getReplayFrameCount?: () => number;
    pushSignalEvent?: (...args: number[]) => void;
    saveCompactState?: () => Float32Array;
    saveState?: () => Float32Array;
  } | null;
}

export interface CommandQueueSessionPort extends RosterSessionManagerPort {
  signalBuffer?: {
    nextSignalId?: number;
    retireSignal?: (signalId: number) => void;
    retireByType?: (signalType: number) => void;
  } | null;
  getSession?: (sessionId: string) => {
    role?: string; entityId: number; rttMs?: number; updateRtt?: (rtt: number) => void;
  } | null | undefined;
}

export interface CommandQueueReplayBufferPort {
  size?: number; capacity?: number;
}

export interface MatchCommandHostPort {
  readonly domain: MatchDomainState;
  readonly roster: MatchRosterSubController;
  readonly actions: MatchCommandLifecycleActionsPort;
  readonly physicsManager: CommandQueuePhysicsPort | null | undefined;
  readonly sessionManager: CommandQueueSessionPort | null | undefined;
  readonly dataHandler: RosterDataHandlerPort | null | undefined;
  readonly replayBuffer: CommandQueueReplayBufferPort | null | undefined;
}

export class MatchCommandQueueSubController {
  readonly host: MatchCommandHostPort;
  activeSignals = new Map<string | number, ActiveMatchSignal>();
  replaySignalLog: ReplaySignalLogEntry[] = [];
  currentFrameSignals: ReplaySignalLogEntry[] = [];
  nextSignalId = 0;
  matchSequence = 0;
  processedClientCommands = new Map<string, Set<number>>();
  skipReplayVotes = new Set<string>();
  rematchVotes = new Set<string>();
  forfeitVotes = new Set<string>();
  rttIntervalTicks = 600;
  lastRttBroadcastTick = -600;
  cachedAllUserRtt: UserRttSummary | null = null;

  constructor(host: MatchCommandHostPort) { this.host = host; }

  getExpectedAckPeerIds(): Set<string> {
    const { domain } = this.host;
    const peers = new Set<string>();
    for (const [sid, p] of domain.players.entries()) if (!p.isBot) peers.add(sid);
    for (const sid of domain.spectators.keys()) peers.add(sid);
    return peers;
  }

  dispatchSignal(signalType: number, frameId: number, param1 = 0, param2 = 0): ActiveMatchSignal | null {
    const { domain, sessionManager: sm, physicsManager: pm, replayBuffer: rb } = this.host;
    if (
      domain.shouldSuppressCountdownClockSignal() &&
      (signalType === MATCH_SIGNALS.TIME_ALERT_60S ||
        signalType === MATCH_SIGNALS.TIME_ALERT_30S ||
        signalType === MATCH_SIGNALS.COUNTDOWN_10S)
    ) {
      return null;
    }

    this.nextSignalId = (Math.max(this.nextSignalId || 0, sm?.signalBuffer?.nextSignalId || 0) % 65535) + 1;
    if (sm?.signalBuffer) sm.signalBuffer.nextSignalId = this.nextSignalId;
    const signalObj: ActiveMatchSignal = {
      signalId: this.nextSignalId, signalType, frameId, param1, param2,
      ackedPeers: new Set<string>(),
      remainingRedundancy: signalType === MATCH_SIGNALS.KICKOFF_WILL_START ? 480 : 180,
    };

    if (!NON_REPLAY_WIRE_SIGNALS.has(signalType)) {
      const wasmIdx = pm?.sim?.getReplayFrameCount?.() ?? rb?.size ?? 0;
      const logEntry: ReplaySignalLogEntry = {
        signalId: signalObj.signalId, signalType, frameId, param1, param2, frameIndex: wasmIdx, recordedAt: Date.now(),
      };
      this.replaySignalLog.push(logEntry);
      if (this.replaySignalLog.length > (rb?.capacity || 18000)) this.replaySignalLog.shift();
      if (Array.isArray(this.currentFrameSignals)) this.currentFrameSignals.push(logEntry);
      if (signalType >= 0x80 && typeof pm?.sim?.pushSignalEvent === 'function') {
        const p1 = Number(param1 || 0) >>> 0, p2 = Number(param2 || 0) >>> 0;
        pm.sim.pushSignalEvent(
          signalType, frameId >>> 0, Number(param1 || 0), Number(param2 || 0),
          0, 0, 0, 0, p1 & 0xffff, (p1 >>> 16) & 0xffff, p2, signalObj.signalId >>> 0, 0, wasmIdx >>> 0
        );
      }
    }

    const mapKey =
      signalType === MATCH_SIGNALS.COMMAND_ACK ? `ack_${param1}_${param2}`
      : ENTITY_SCOPED_SIGNALS.has(signalType) ? `sig_${signalType}_ent_${param1}` : signalType;
    this.activeSignals.set(mapKey, signalObj);
    return signalObj;
  }

  retireSignalTypes(signalTypes: number[], alsoRetireSessionBuffer = false): void {
    const sb = this.host.sessionManager?.signalBuffer;
    for (const sigType of signalTypes) {
      const prev = this.activeSignals.get(sigType);
      if (alsoRetireSessionBuffer && sb) {
        if (prev) sb.retireSignal?.(prev.signalId);
        sb.retireByType?.(sigType);
      }
      this.activeSignals.delete(sigType);
    }
  }

  stepFrameSignalRedundancy(): void {
    for (const [sKey, sObj] of this.activeSignals.entries()) {
      if (sObj.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START) {
        if (typeof sObj.remainingRedundancy === 'number' && --sObj.remainingRedundancy > 0) continue;
        this.activeSignals.delete(sKey);
      }
    }
  }

  sampleRttIfDue(matchTick: number): UserRttSummary | null {
    if (matchTick - this.lastRttBroadcastTick >= this.rttIntervalTicks) {
      this.lastRttBroadcastTick = matchTick;
      return collectSessionUserRtt(this.host.sessionManager);
    }
    return null;
  }

  handleClientSignalAcks(sessionId: string, acks: Array<{ signalId: number; signalType?: number }> = []): void {
    if (!Array.isArray(acks) || acks.length === 0) return;
    const expected = this.getExpectedAckPeerIds();
    for (let i = 0; i < acks.length; i++) {
      const ack = acks[i];
      if (!ack || typeof ack.signalId !== 'number') continue;
      for (const [key, sObj] of this.activeSignals.entries()) {
        if (sObj.signalId === ack.signalId && (!ack.signalType || sObj.signalType === ack.signalType)) {
          sObj.ackedPeers.add(sessionId);
          if (sObj.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START && expected.size > 0) {
            let allAcked = true;
            for (const pid of expected) if (!sObj.ackedPeers.has(pid)) { allAcked = false; break; }
            if (allAcked) this.activeSignals.delete(key);
          }
        }
      }
    }
  }

  checkSkipReplayVotes(): void {
    const { domain, actions } = this.host;
    if (domain.state !== MATCH_STATES.REPLAY && domain.state !== MATCH_STATES.GOAL_SCORED) return;
    const { allHumansVoted, spectatorSkippedAllBotMatch } = domain.areAllHumansVoted(this.skipReplayVotes, true);
    if (allHumansVoted || spectatorSkippedAllBotMatch) {
      if (domain.state === MATCH_STATES.REPLAY) actions.finishGoalReplay();
      else domain.clampGoalBufferTicksForSkip(35);
    }
  }

  checkRematchReady(): void {
    const { domain, actions } = this.host;
    if (domain.state !== MATCH_STATES.ENDED && domain.state !== MATCH_STATES.PODIUM) return;
    if (domain.areAllHumansVoted(this.rematchVotes).allHumansVoted) actions.startMatch(domain.clockDuration);
  }

  recordSkipReplayInputEdge(
    sessionId: string, inputHistory: Array<{ jump?: boolean; controls?: { jump?: boolean } }>
  ): boolean {
    if (this.host.domain.state !== MATCH_STATES.REPLAY || !Array.isArray(inputHistory) || inputHistory.length === 0) return false;
    if (this.skipReplayVotes.has(sessionId)) return true;
    for (let i = 0; i < inputHistory.length; i++) {
      const ctrl = inputHistory[i]?.controls || inputHistory[i];
      if (ctrl?.jump) { this.skipReplayVotes.add(sessionId); this.checkSkipReplayVotes(); return true; }
    }
    return false;
  }

  handleClientCommand(sessionId: string, cmd: ClientCommandPayload, _session?: unknown): void {
    const { domain, roster, actions } = this.host;
    const commandId = cmd.commandId ?? 0, commandType = cmd.commandType;
    const param1 = cmd.param1 ?? 0, param2 = cmd.param2 ?? 0;

    if (commandId > 0) this.dispatchSignal(MATCH_SIGNALS.COMMAND_ACK, domain.matchTick, commandId, commandType);

    let seenSet = this.processedClientCommands.get(sessionId);
    if (!seenSet) { seenSet = new Set<number>(); this.processedClientCommands.set(sessionId, seenSet); }
    if (commandId > 0 && seenSet.has(commandId)) return;
    if (commandId > 0) {
      seenSet.add(commandId);
      if (seenSet.size > 256) {
        const first = seenSet.values().next().value;
        if (first !== undefined) seenSet.delete(first);
      }
    }

    switch (commandType) {
      case CLIENT_COMMAND_TYPES.CMD_READY_ACK: {
        const player = domain.players.get(sessionId);
        if (player) { player.ready = param1 !== 0; roster.broadcastRosterUpdate(); }
        if (domain.areAllHumanPlayersReadyInFullLobby()) actions.initiateMatchPrepare();
        else if (domain.state === MATCH_STATES.ENDED || domain.state === MATCH_STATES.PODIUM) {
          if (param1 !== 0) { this.rematchVotes.add(sessionId); this.checkRematchReady(); }
          else this.rematchVotes.delete(sessionId);
        }
        break;
      }
      case CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK: {
        const player = domain.players.get(sessionId);
        if (player) { player.arenaLoaded = true; roster.broadcastRosterUpdate(); }
        actions.checkArenaLoadedBarrier();
        break;
      }
      case CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT:
        roster.updatePlayerLoadout(sessionId, param1, param2);
        break;
      case CLIENT_COMMAND_TYPES.CMD_SWITCH_ROLE_TEAM:
        roster.switchPlayerRoleOrTeam(sessionId, param1 === 1 || param1 === 2 ? 'spectator' : 'player', param2 === 1 ? 1 : 0);
        break;
      case CLIENT_COMMAND_TYPES.CMD_VOTE_SKIP_REPLAY:
        if (param1 !== 0) { this.skipReplayVotes.add(sessionId); this.checkSkipReplayVotes(); }
        break;
      case CLIENT_COMMAND_TYPES.CMD_VOTE_REMATCH:
        if (param1 !== 0) this.rematchVotes.add(sessionId);
        else this.rematchVotes.delete(sessionId);
        this.checkRematchReady();
        break;
      case CLIENT_COMMAND_TYPES.CMD_REQUEST_PAUSE:
        if (param1 !== 0 && domain.state === MATCH_STATES.PLAYING) actions.setPaused(true);
        else if (param1 === 0 && domain.state === MATCH_STATES.PAUSED) actions.requestResumeWithCountdown(5);
        break;
      case CLIENT_COMMAND_TYPES.CMD_VOTE_FORFEIT: {
        const player = domain.players.get(sessionId);
        if (player && (domain.state === MATCH_STATES.PLAYING || domain.state === MATCH_STATES.KICKOFF)) {
          this.forfeitVotes.add(sessionId);
          const winningTeam = player.team === 0 ? 1 : 0;
          this.dispatchSignal(MATCH_SIGNALS.FORFEIT_VOTE, domain.matchTick, player.entityId, winningTeam);
          actions.endMatch(winningTeam, 2);
        }
        break;
      }
      case CLIENT_COMMAND_TYPES.CMD_REJOIN_CLAIM:
        roster.reclaimPlayerSession(
          sessionId, typeof param1 === 'number' && param1 < 6 ? param1 : -1,
          param2 === 0 || param2 === 1 ? param2 : null
        );
        break;
      case CLIENT_COMMAND_TYPES.CMD_SYS_STATE_ONLY:
        actions.enterStateOnlyMode?.(cmd.stateSnapshot || null, param1 > 0 ? param1 : undefined);
        break;
      case CLIENT_COMMAND_TYPES.CMD_SYS_INTERVENE_COUNTDOWN:
        actions.beginInterveneCountdown?.(param1 > 0 ? param1 : 3, cmd.stateSnapshot || null);
        break;
      case CLIENT_COMMAND_TYPES.CMD_SYS_PHYSICS_RESUME:
        actions.resumePhysicsFromState?.(cmd.stateSnapshot || null, param1 > 0 ? param1 : undefined);
        break;
      default: break;
    }
  }

  handleClientCommands(sessionId: string, commands: ClientCommandPayload[] = []): void {
    if (!Array.isArray(commands) || commands.length === 0) return;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      if (cmd && typeof cmd.commandType === 'number') this.handleClientCommand(sessionId, cmd);
    }
  }

  evaluateControlPacket(
    channelId: string, packetType: string | number, packetData: ControlPacketPayload | null | undefined
  ): unknown {
    const { domain, roster, dataHandler, physicsManager, sessionManager } = this.host;
    return evaluateSessionControlPacket({
      channelId, packetType, packetData, roster, dataHandler,
      sim: physicsManager?.sim, sessionManager,
      buildHandshakeJson: (p, snap) => domain.buildRosterEnvelope(sessionManager).buildHandshakeJson(p, snap),
      handleClientCommand: (cid, cmd) => this.handleClientCommand(cid, cmd),
    });
  }

  removeSessionVotes(sessionId: string): void {
    this.skipReplayVotes.delete(sessionId);
    this.rematchVotes.delete(sessionId);
  }

  resetForMatchStart(): void {
    this.replaySignalLog = [];
    this.currentFrameSignals = [];
    this.activeSignals.clear();
    this.skipReplayVotes.clear();
    this.rematchVotes.clear();
    this.forfeitVotes.clear();
  }

  resetForTrainingStart(): void {
    this.replaySignalLog = [];
    this.currentFrameSignals = [];
    this.activeSignals.clear();
  }

  clear(): void {
    this.activeSignals.clear();
    this.processedClientCommands.clear();
    this.skipReplayVotes.clear();
    this.rematchVotes.clear();
    this.forfeitVotes.clear();
    this.replaySignalLog = [];
    this.currentFrameSignals = [];
  }
}
