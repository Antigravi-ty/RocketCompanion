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
  type RosterSessionManagerPort, type MatchPlayerSlot,
} from './matchLoadoutAndSpawnPipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';
import type { MatchRosterSubController, RosterDataHandlerPort } from './MatchRosterSubController.ts';

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
    role?: string;
    entityId: number;
    rttMs?: number;
    updateRtt?: (rtt: number) => void;
  } | null | undefined;
}

export interface CommandQueueReplayBufferPort {
  size?: number;
  capacity?: number;
}

export interface ClientCommandPayload {
  commandId?: number;
  commandType: number;
  param1?: number;
  param2?: number;
  stateSnapshot?: Float32Array | number[] | null;
}

export type ClientReliableCommand = ClientCommandPayload;

export interface ControlPacketPayload {
  type?: string | number;
  playerName?: string;
  clientName?: string;
  role?: string;
  preferredTeam?: number | null;
  visualId?: string | number;
  carVisual?: string | number;
  hitboxId?: string | number | null;
  carHitbox?: string | number | null;
  colorSlot?: number | null;
  slotId?: number | null;
  blueColorSlot?: number | null;
  orangeColorSlot?: number | null;
  paintFinish?: string | number;
  boostVisual?: string | number;
  boostAudio?: string | number;
  anthemId?: string;
  commandId?: number;
  commandType?: number;
  param1?: number;
  param2?: number;
  ready?: boolean;
  matchSequence?: number;
  rtt?: number;
  sendTime?: number;
  stateSnapshot?: Float32Array | number[] | null;
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

  constructor(host: MatchCommandHostPort) {
    this.host = host;
  }

  getExpectedAckPeerIds(): Set<string> {
    const { domain } = this.host;
    const peers = new Set<string>();
    for (const [sid, p] of domain.players.entries()) {
      if (!p.isBot) peers.add(sid);
    }
    for (const sid of domain.spectators.keys()) peers.add(sid);
    return peers;
  }

  dispatchSignal(signalType: number, frameId: number, param1 = 0, param2 = 0): ActiveMatchSignal | null {
    const { domain, sessionManager, physicsManager, replayBuffer } = this.host;
    if (
      domain.shouldSuppressCountdownClockSignal() &&
      (signalType === MATCH_SIGNALS.TIME_ALERT_60S ||
        signalType === MATCH_SIGNALS.TIME_ALERT_30S ||
        signalType === MATCH_SIGNALS.COUNTDOWN_10S)
    ) {
      return null;
    }

    const sharedNext = Math.max(this.nextSignalId || 0, sessionManager?.signalBuffer?.nextSignalId || 0);
    this.nextSignalId = (sharedNext % 65535) + 1;
    if (sessionManager?.signalBuffer) sessionManager.signalBuffer.nextSignalId = this.nextSignalId;
    const isPersistentKickoff = signalType === MATCH_SIGNALS.KICKOFF_WILL_START;
    const signalObj: ActiveMatchSignal = {
      signalId: this.nextSignalId, signalType, frameId, param1, param2,
      ackedPeers: new Set<string>(), remainingRedundancy: isPersistentKickoff ? 480 : 180,
    };

    if (!NON_REPLAY_WIRE_SIGNALS.has(signalType)) {
      const wasmFrameIndex = physicsManager?.sim?.getReplayFrameCount?.() ?? replayBuffer?.size ?? 0;
      const logEntry: ReplaySignalLogEntry = {
        signalId: signalObj.signalId, signalType, frameId, param1, param2,
        frameIndex: wasmFrameIndex, recordedAt: Date.now(),
      };
      this.replaySignalLog.push(logEntry);
      const maxSignalLog = replayBuffer?.capacity || 18000;
      if (this.replaySignalLog.length > maxSignalLog) this.replaySignalLog.shift();
      if (Array.isArray(this.currentFrameSignals)) this.currentFrameSignals.push(logEntry);
      if (signalType >= 0x80 && typeof physicsManager?.sim?.pushSignalEvent === 'function') {
        const p1 = Number(param1 || 0) >>> 0;
        const p2 = Number(param2 || 0) >>> 0;
        physicsManager.sim.pushSignalEvent(
          signalType, frameId >>> 0, Number(param1 || 0), Number(param2 || 0),
          0, 0, 0, 0, p1 & 0xffff, (p1 >>> 16) & 0xffff, p2,
          signalObj.signalId >>> 0, 0, wasmFrameIndex >>> 0
        );
      }
    }

    const mapKey =
      signalType === MATCH_SIGNALS.COMMAND_ACK
        ? `ack_${param1}_${param2}`
        : ENTITY_SCOPED_SIGNALS.has(signalType)
          ? `sig_${signalType}_ent_${param1}`
          : signalType;
    this.activeSignals.set(mapKey, signalObj);
    return signalObj;
  }

  retireSignalTypes(signalTypes: number[], alsoRetireSessionBuffer = false): void {
    const signalBuffer = this.host.sessionManager?.signalBuffer;
    for (const sigType of signalTypes) {
      const prev = this.activeSignals.get(sigType);
      if (alsoRetireSessionBuffer && signalBuffer) {
        if (prev && typeof signalBuffer.retireSignal === 'function') signalBuffer.retireSignal(prev.signalId);
        if (typeof signalBuffer.retireByType === 'function') signalBuffer.retireByType(sigType);
      }
      this.activeSignals.delete(sigType);
    }
  }

  stepFrameSignalRedundancy(): void {
    for (const [sKey, sObj] of this.activeSignals.entries()) {
      if (sObj.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START) {
        if (typeof sObj.remainingRedundancy === 'number') {
          sObj.remainingRedundancy--;
          if (sObj.remainingRedundancy <= 0) this.activeSignals.delete(sKey);
        } else {
          this.activeSignals.delete(sKey);
        }
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
    const expectedPeers = this.getExpectedAckPeerIds();
    for (let i = 0; i < acks.length; i++) {
      const ack = acks[i];
      if (!ack || typeof ack.signalId !== 'number') continue;
      for (const [key, sObj] of this.activeSignals.entries()) {
        if (sObj.signalId === ack.signalId && (!ack.signalType || sObj.signalType === ack.signalType)) {
          sObj.ackedPeers.add(sessionId);
          if (sObj.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START) {
            let allAcked = expectedPeers.size > 0;
            for (const pid of expectedPeers) {
              if (!sObj.ackedPeers.has(pid)) {
                allAcked = false;
                break;
              }
            }
            if (allAcked) this.activeSignals.delete(key);
          }
        }
      }
    }
  }

  checkSkipReplayVotes(): void {
    const { domain, actions } = this.host;
    if (domain.state !== MATCH_STATES.REPLAY && domain.state !== MATCH_STATES.GOAL_SCORED) return;
    const { allHumansVoted, spectatorSkippedAllBotMatch } = domain.areAllHumansVoted(
      this.skipReplayVotes,
      true
    );
    if (allHumansVoted || spectatorSkippedAllBotMatch) {
      if (domain.state === MATCH_STATES.REPLAY) actions.finishGoalReplay();
      else if (domain.state === MATCH_STATES.GOAL_SCORED) {
        domain.clampGoalBufferTicksForSkip(35);
      }
    }
  }

  checkRematchReady(): void {
    const { domain, actions } = this.host;
    if (domain.state !== MATCH_STATES.ENDED && domain.state !== MATCH_STATES.PODIUM) return;
    if (domain.areAllHumansVoted(this.rematchVotes).allHumansVoted) {
      actions.startMatch(domain.clockDuration);
    }
  }

  recordSkipReplayInputEdge(
    sessionId: string,
    inputHistory: Array<{ jump?: boolean; controls?: { jump?: boolean } }>
  ): boolean {
    if (this.host.domain.state !== MATCH_STATES.REPLAY) return false;
    if (!Array.isArray(inputHistory) || inputHistory.length === 0) return false;
    if (this.skipReplayVotes.has(sessionId)) return true;
    for (let i = 0; i < inputHistory.length; i++) {
      const ctrl = inputHistory[i]?.controls || inputHistory[i];
      if (ctrl?.jump) {
        this.skipReplayVotes.add(sessionId);
        this.checkSkipReplayVotes();
        return true;
      }
    }
    return false;
  }

  handleClientCommand(sessionId: string, cmd: ClientCommandPayload, _session?: unknown): void {
    const { domain, roster, actions } = this.host;
    const commandId = cmd.commandId ?? 0;
    const commandType = cmd.commandType;
    const param1 = cmd.param1 ?? 0;
    const param2 = cmd.param2 ?? 0;

    if (commandId > 0) this.dispatchSignal(MATCH_SIGNALS.COMMAND_ACK, domain.matchTick, commandId, commandType);

    let seenSet = this.processedClientCommands.get(sessionId);
    if (!seenSet) {
      seenSet = new Set<number>();
      this.processedClientCommands.set(sessionId, seenSet);
    }
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
        if (domain.areAllHumanPlayersReadyInFullLobby()) {
          actions.initiateMatchPrepare();
        } else if (domain.state === MATCH_STATES.ENDED || domain.state === MATCH_STATES.PODIUM) {
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

      case CLIENT_COMMAND_TYPES.CMD_SWITCH_ROLE_TEAM: {
        const targetRole = param1 === 1 || param1 === 2 ? 'spectator' : 'player';
        const targetTeam = param2 === 1 ? 1 : 0;
        roster.switchPlayerRoleOrTeam(sessionId, targetRole, targetTeam);
        break;
      }

      case CLIENT_COMMAND_TYPES.CMD_VOTE_SKIP_REPLAY:
        if (param1 !== 0) { this.skipReplayVotes.add(sessionId); this.checkSkipReplayVotes(); }
        break;

      case CLIENT_COMMAND_TYPES.CMD_VOTE_REMATCH:
        if (param1 !== 0) this.rematchVotes.add(sessionId);
        else this.rematchVotes.delete(sessionId);
        this.checkRematchReady();
        break;

      case CLIENT_COMMAND_TYPES.CMD_REQUEST_PAUSE: {
        const wantPause = param1 !== 0;
        if (wantPause && domain.state === MATCH_STATES.PLAYING) actions.setPaused(true);
        else if (!wantPause && domain.state === MATCH_STATES.PAUSED) actions.requestResumeWithCountdown(5);
        break;
      }

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

      case CLIENT_COMMAND_TYPES.CMD_REJOIN_CLAIM: {
        const claimEntityId = typeof param1 === 'number' && param1 < 6 ? param1 : -1;
        const preferredTeam = param2 === 0 || param2 === 1 ? param2 : null;
        roster.reclaimPlayerSession(sessionId, claimEntityId, preferredTeam);
        break;
      }

      case CLIENT_COMMAND_TYPES.CMD_SYS_STATE_ONLY:
        actions.enterStateOnlyMode?.(cmd.stateSnapshot || null, param1 > 0 ? param1 : undefined);
        break;

      case CLIENT_COMMAND_TYPES.CMD_SYS_INTERVENE_COUNTDOWN:
        actions.beginInterveneCountdown?.(param1 > 0 ? param1 : 3, cmd.stateSnapshot || null);
        break;

      case CLIENT_COMMAND_TYPES.CMD_SYS_PHYSICS_RESUME:
        actions.resumePhysicsFromState?.(cmd.stateSnapshot || null, param1 > 0 ? param1 : undefined);
        break;

      default:
        break;
    }
  }

  handleClientCommands(sessionId: string, commands: ClientCommandPayload[] = []): void {
    if (!Array.isArray(commands) || commands.length === 0) return;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      if (!cmd || typeof cmd.commandType !== 'number') continue;
      this.handleClientCommand(sessionId, cmd);
    }
  }

  evaluateControlPacket(
    channelId: string,
    packetType: string | number,
    packetData: ControlPacketPayload | null | undefined
  ): unknown {
    if (!packetData) return null;
    const { domain, roster, dataHandler, physicsManager, sessionManager } = this.host;
    const type = packetData.type || packetType;

    if (type === 'join' || type === 'join_training' || type === 'token' || type === 'handshake_request') {
      const playerName = packetData.playerName || packetData.clientName || 'Player';
      const role = packetData.role || 'player';
      const preferredTeam = packetData.preferredTeam ?? null;
      const playerInfo = roster.assignPlayerSlot(channelId, playerName, role, preferredTeam, {
        visualId: packetData.visualId || packetData.carVisual || 'fennec',
        hitboxId: packetData.hitboxId || packetData.carHitbox || null,
        colorSlot: packetData.colorSlot, blueColorSlot: packetData.blueColorSlot,
        orangeColorSlot: packetData.orangeColorSlot, paintFinish: packetData.paintFinish,
        boostVisual: packetData.boostVisual, boostAudio: packetData.boostAudio,
        anthemId: packetData.anthemId,
      });

      if (dataHandler && playerInfo && 'visualId' in playerInfo) {
        const sim = physicsManager?.sim;
        const rawSnap = sim?.saveCompactState ? sim.saveCompactState() : sim?.saveState?.();
        const initialSnap = rawSnap ? Array.from<number>(rawSnap) : null;
        dataHandler.sendPacket(
          channelId,
          domain.buildRosterEnvelope(sessionManager).buildHandshakeJson(
            playerInfo as MatchPlayerSlot,
            initialSnap
          )
        );
      }
      return playerInfo;
    }

    if (type === 'color_change' || type === 'loadout_change') {
      if (
        packetData.visualId !== undefined || packetData.slotId !== undefined ||
        packetData.hitboxId !== undefined || packetData.paintFinish !== undefined ||
        packetData.boostVisual !== undefined || packetData.boostAudio !== undefined
      ) {
        roster.updatePlayerLoadout(
          channelId, packetData.visualId ?? 'fennec', packetData.slotId ?? null,
          packetData.hitboxId ?? null,
          {
            paintFinish: packetData.paintFinish,
            boostVisual: packetData.boostVisual,
            boostAudio: packetData.boostAudio,
          }
        );
      }
      if (dataHandler && typeof dataHandler.broadcast === 'function') {
        dataHandler.broadcast(JSON.stringify(packetData), (id: string) => id !== channelId);
      }
      return null;
    }

    if (type === 'client_command' && typeof packetData.commandType === 'number') {
      this.handleClientCommand(channelId, packetData as ClientCommandPayload);
      return null;
    }

    if (type === 'match_ready_ack') {
      this.handleClientCommand(channelId, {
        commandId: packetData.commandId ?? 0, commandType: CLIENT_COMMAND_TYPES.CMD_READY_ACK,
        param1: packetData.ready === false ? 0 : 1, param2: 0,
      });
      return null;
    }

    if (type === 'arena_loaded_ack') {
      this.handleClientCommand(channelId, {
        commandId: packetData.commandId ?? 0, commandType: CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK,
        param1: packetData.matchSequence ?? 0, param2: 0,
      });
      return null;
    }

    if (type === 'ping') {
      if (typeof packetData.rtt === 'number') {
        const session = sessionManager?.getSession?.(channelId);
        if (session) session.updateRtt?.(packetData.rtt);
      }
      if (dataHandler) {
        dataHandler.sendPacket(
          channelId,
          JSON.stringify({ type: 'pong', sendTime: packetData.sendTime || Date.now(), serverTime: Date.now() })
        );
      }
      return null;
    }

    if (type === 'leave') { roster.removePlayerSession(channelId); return null; }
    return null;
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
