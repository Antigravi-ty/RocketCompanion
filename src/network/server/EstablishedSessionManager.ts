import {
  GlobalPayloadCodec,
  PAYLOAD_FLAGS,
  MATCH_SIGNALS,
  type MatchSignalDescriptor,
} from '../protocol/GlobalPayloadCodec.ts';
import { SignalEventBuffer } from '../protocol/SignalEventBuffer.ts';
import {
  PeerSession,
  INPUT_STALE_NEUTRAL_TIMEOUT_MS,
  SESSION_DISCONNECT_TIMEOUT_MS,
  buildTailoredClientPacket,
  parseTailoredClientPacket,
  type PeerSessionOptions,
} from './PeerSession.ts';
import type { PhysicsEngineManager } from './PhysicsEngineManager.ts';
import type {
  PiggybackedSignalAck,
  PiggybackedClientCommand,
} from '../protocol/InputPacketCodec.ts';

export interface EstablishedSessionManagerOptions {
  staleInputTimeoutMs?: number;
  disconnectTimeoutMs?: number;
  signalBuffer?: SignalEventBuffer;
  signalBufferCapacity?: number;
  signalLifetimeTicks?: number;
  onSessionTimeoutRemove?: ((sessionId: string, session: PeerSession) => void) | null;
}

export class EstablishedSessionManager {
  physicsManager: PhysicsEngineManager | null;
  getTime: () => number;
  staleInputTimeoutMs: number;
  disconnectTimeoutMs: number;
  sessions: Map<string, PeerSession>;
  entitySessionMap: Map<number, string>;
  disconnectedSlotCache: Map<
    string,
    { entityId: number; playerName: string; disconnectedAt: number }
  >;
  signalBuffer: SignalEventBuffer;
  onSessionTimeoutRemove: ((sessionId: string, session: PeerSession) => void) | null;

  constructor(
    physicsManager: PhysicsEngineManager | null,
    timeProvider: () => number = () =>
      typeof performance !== 'undefined' ? performance.now() : Date.now(),
    options: EstablishedSessionManagerOptions = {}
  ) {
    this.physicsManager = physicsManager;
    this.getTime = timeProvider;

    this.staleInputTimeoutMs = options.staleInputTimeoutMs ?? INPUT_STALE_NEUTRAL_TIMEOUT_MS;
    this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? SESSION_DISCONNECT_TIMEOUT_MS;

    this.sessions = new Map();
    this.entitySessionMap = new Map();
    this.disconnectedSlotCache = new Map();

    this.signalBuffer =
      options.signalBuffer ||
      new SignalEventBuffer({
        capacity: options.signalBufferCapacity,
        defaultLifetimeTicks: options.signalLifetimeTicks,
      });

    this.onSessionTimeoutRemove = options.onSessionTimeoutRemove || null;
  }

  registerSession(sessionId: string, options: PeerSessionOptions = {}): PeerSession {
    const now = this.getTime();
    const playerId = options.playerId || sessionId;

    let resolvedEntityId = options.entityId ?? -1;
    if (resolvedEntityId < 0 && this.disconnectedSlotCache.has(playerId)) {
      const cached = this.disconnectedSlotCache.get(playerId)!;
      this.disconnectedSlotCache.delete(playerId);
      if (
        now - cached.disconnectedAt <= this.disconnectTimeoutMs &&
        !this.entitySessionMap.has(cached.entityId)
      ) {
        resolvedEntityId = cached.entityId;
      }
    }

    const session = new PeerSession(sessionId, {
      ...options,
      entityId: resolvedEntityId,
      playerId,
      connectedAt: now,
    });
    this.sessions.set(sessionId, session);

    if (session.entityId >= 0) {
      this.entitySessionMap.set(session.entityId, sessionId);
      if (
        !options.deferPhysicsRegistration &&
        typeof this.physicsManager?.registerCarEntity === 'function'
      ) {
        this.physicsManager.registerCarEntity(
          session.entityId,
          options.team ?? session.entityId % 2,
          options.hitboxId || options.visualId || 'octane'
        );
      } else if (typeof this.physicsManager?.inputBuffer?.registerCar === 'function') {
        this.physicsManager.inputBuffer.registerCar(session.entityId);
      }
      if (this.physicsManager?.inputBuffer?.setCarInputStale) {
        this.physicsManager.inputBuffer.setCarInputStale(session.entityId, false);
      }
    }
    return session;
  }

  unregisterSession(sessionId: string, cacheForRejoin = true): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.entityId >= 0) {
      if (cacheForRejoin) {
        this.disconnectedSlotCache.set(session.playerId || sessionId, {
          entityId: session.entityId,
          playerName: session.playerName,
          disconnectedAt: this.getTime(),
        });
      }
      this.entitySessionMap.delete(session.entityId);
      if (this.physicsManager) {
        this.physicsManager.unregisterCarEntity(session.entityId);
      }
    }

    this.signalBuffer.removeSession(sessionId);
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): PeerSession | null {
    return this.sessions.get(sessionId) || null;
  }

  getSessionByEntityId(entityId: number): PeerSession | null {
    const sessionId = this.entitySessionMap.get(entityId);
    return sessionId ? this.sessions.get(sessionId) || null : null;
  }

  recordClientTimestamp(sessionId: string, clientTimestamp: number, hasValidInput = true): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const now = this.getTime();
    session._recordClientPacket(clientTimestamp, now, hasValidInput);
    if (
      hasValidInput &&
      session.entityId >= 0 &&
      this.physicsManager?.inputBuffer?.setCarInputStale
    ) {
      this.physicsManager.inputBuffer.setCarInputStale(session.entityId, false);
    }
    return true;
  }

  _getHumanAckSessionIds(): string[] {
    const ids: string[] = [];
    for (const sid of this.sessions.keys()) {
      if (sid === 'bot' || String(sid || '').startsWith('bot_')) continue;
      ids.push(sid);
    }
    return ids;
  }

  enqueueSignal(signalObj: MatchSignalDescriptor): any {
    return this.signalBuffer.pushSignal(signalObj, this._getHumanAckSessionIds());
  }

  recordClientSignalAcks(sessionId: string, acks: PiggybackedSignalAck[]): number {
    if (!sessionId || !Array.isArray(acks) || acks.length === 0) return 0;
    const session = this.sessions.get(sessionId);
    if (session) {
      for (let i = 0; i < acks.length; i++) {
        const sigId = acks[i]?.signalId ?? 0;
        if (sigId > 0) {
          session.acknowledgedSignalIds.add(sigId);
        }
      }
    }
    return this.signalBuffer.acknowledgeSignals(sessionId, acks, this._getHumanAckSessionIds());
  }

  ingestClientCommands(
    sessionId: string,
    commands: PiggybackedClientCommand[],
    currentTick = 0
  ): PiggybackedClientCommand[] {
    if (!sessionId || !Array.isArray(commands) || commands.length === 0) return [];
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const freshCommands: PiggybackedClientCommand[] = [];
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      if (!cmd || typeof cmd.commandId !== 'number' || cmd.commandId <= 0) continue;

      if (!session.processedCommandIds.has(cmd.commandId)) {
        session.processedCommandIds.add(cmd.commandId);
        if (session.processedCommandIds.size > 256) {
          const oldest = session.processedCommandIds.values().next().value;
          if (oldest !== undefined) session.processedCommandIds.delete(oldest);
        }
        session.lastAckedCommandId = Math.max(session.lastAckedCommandId, cmd.commandId);
        freshCommands.push(cmd);
      }

      this.signalBuffer.pushSignal(
        {
          signalType: MATCH_SIGNALS.COMMAND_ACK,
          frameId: currentTick,
          param1: cmd.commandId,
          param2: cmd.commandType,
        },
        [sessionId]
      );
    }

    return freshCommands;
  }

  evaluateSessionTimeouts(
    nowMs = this.getTime(),
    onEvictCallback: ((sessionId: string, session: PeerSession) => void) | null = null
  ): { staleSessions: string[]; evictedSessions: string[] } {
    const staleSessions: string[] = [];
    const evictedSessions: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.role === 'spectator' || session.entityId < 0) continue;
      const isBotSession = sessionId === 'bot' || String(sessionId).startsWith('bot_');
      if (isBotSession) continue;

      const lastInputTime = session.lastValidInputTime;
      if (lastInputTime <= 0) continue;

      const elapsedMs = nowMs - lastInputTime;

      if (
        this.disconnectTimeoutMs > 0 &&
        elapsedMs >= this.disconnectTimeoutMs &&
        sessionId !== 'host'
      ) {
        evictedSessions.push(sessionId);
        const evictHandler = onEvictCallback || this.onSessionTimeoutRemove;
        if (typeof evictHandler === 'function') {
          evictHandler(sessionId, session);
        } else {
          this.unregisterSession(sessionId, true);
        }
        continue;
      }

      if (this.staleInputTimeoutMs > 0 && elapsedMs >= this.staleInputTimeoutMs) {
        if (!session.isInputStale) {
          session.isInputStale = true;
          if (this.physicsManager?.inputBuffer?.setCarInputStale) {
            this.physicsManager.inputBuffer.setCarInputStale(session.entityId, true);
          }
          if (this.physicsManager?.lastAcknowledgedControls) {
            this.physicsManager.lastAcknowledgedControls.delete(session.entityId);
          }
        }
        staleSessions.push(sessionId);
      }
    }

    return { staleSessions, evictedSessions };
  }

  getAllSessions(): PeerSession[] {
    return Array.from(this.sessions.values());
  }

  extractSignalsFromGlobalPayload(globalPayloadBytes: Uint8Array): {
    statelessPayloadBytes: Uint8Array;
    serverTick: number | null;
  } {
    if (!globalPayloadBytes || globalPayloadBytes.length === 0) {
      return { statelessPayloadBytes: globalPayloadBytes, serverTick: null };
    }

    const flagByte = globalPayloadBytes[0];
    const hasSignalsInGlobal = Boolean(flagByte & PAYLOAD_FLAGS.SIGNAL);
    const humanAckSessionIds = this._getHumanAckSessionIds();

    if (!hasSignalsInGlobal) {
      let serverTick: number | null = null;
      if (flagByte & PAYLOAD_FLAGS.PHYSICS && globalPayloadBytes.length >= 5) {
        const view = new DataView(
          globalPayloadBytes.buffer,
          globalPayloadBytes.byteOffset,
          globalPayloadBytes.byteLength
        );
        serverTick = view.getUint32(1, false);
      }
      if (serverTick !== null) {
        this.signalBuffer.pruneExpired(serverTick, humanAckSessionIds);
      }
      return { statelessPayloadBytes: globalPayloadBytes, serverTick };
    }

    const decoded = GlobalPayloadCodec.decode(globalPayloadBytes);
    if (!decoded) {
      return { statelessPayloadBytes: globalPayloadBytes, serverTick: null };
    }

    const serverTick = decoded.physics?.tick ?? this.physicsManager?.currentTick ?? null;

    if (decoded.signals && decoded.signals.length > 0) {
      this.signalBuffer.ingestSignals(decoded.signals, humanAckSessionIds);
    }
    if (serverTick !== null) {
      this.signalBuffer.pruneExpired(serverTick, humanAckSessionIds);
    }

    const statelessPayloadBytes = GlobalPayloadCodec.encode({
      physics: decoded.physics ?? undefined,
      signals: [],
      allUserRtt: decoded.allUserRtt ?? undefined,
    });

    return { statelessPayloadBytes, serverTick };
  }

  buildClientPacket(
    sessionId: string,
    globalPayloadBytes: Uint8Array,
    options: { alreadyStripped?: boolean; serverTick?: number | null } = {}
  ): Uint8Array {
    return buildTailoredClientPacket(this, sessionId, globalPayloadBytes, options);
  }

  static parseClientPacket(rawPacket: Uint8Array | ArrayBuffer) {
    return parseTailoredClientPacket(rawPacket);
  }

  destroy(): void {
    this.sessions.clear();
    this.entitySessionMap.clear();
    this.disconnectedSlotCache.clear();
    this.signalBuffer.clear();
    this.physicsManager = null;
  }
}
