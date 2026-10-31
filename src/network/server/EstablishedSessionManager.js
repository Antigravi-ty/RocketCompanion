/**
 * src/network/EstablishedSessionManager.js
 * Established Peer Session Registry, Per-Session Signal Piggybacking,
 * Input Timeout Monitoring (1s Neutral Fallback & 30s Disconnect Eviction),
 * and Tailored Datagram Assembly.
 */

import { GlobalPayloadCodec, PAYLOAD_FLAGS, MATCH_SIGNALS } from '../protocol/GlobalPayloadCodec.js';
import { SignalEventBuffer } from '../protocol/SignalEventBuffer.js';
import {
  PeerSession,
  INPUT_STALE_NEUTRAL_TIMEOUT_MS,
  SESSION_DISCONNECT_TIMEOUT_MS,
  buildTailoredClientPacket,
  parseTailoredClientPacket
} from './PeerSession.js';

export class EstablishedSessionManager {
  /**
   * @param {import('./PhysicsEngineManager.js').PhysicsEngineManager} physicsManager
   * @param {() => number} [timeProvider] Monotonic or high-res time source
   * @param {object} [options]
   */
  constructor(
    physicsManager,
    timeProvider = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    options = {}
  ) {
    this.physicsManager = physicsManager;
    this.getTime = timeProvider;

    this.staleInputTimeoutMs = options.staleInputTimeoutMs ?? INPUT_STALE_NEUTRAL_TIMEOUT_MS;
    this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? SESSION_DISCONNECT_TIMEOUT_MS;

    this.sessions = new Map();
    this.entitySessionMap = new Map();
    this.disconnectedSlotCache = new Map(); // playerId -> { entityId, team, playerName, disconnectedAt }

    this.signalBuffer = options.signalBuffer || new SignalEventBuffer({
      capacity: options.signalBufferCapacity,
      defaultLifetimeTicks: options.signalLifetimeTicks
    });

    this.onSessionTimeoutRemove = options.onSessionTimeoutRemove || null;
  }

  registerSession(sessionId, options = {}) {
    const now = this.getTime();
    const playerId = options.playerId || sessionId;

    let resolvedEntityId = options.entityId ?? -1;
    if (resolvedEntityId < 0 && this.disconnectedSlotCache.has(playerId)) {
      const cached = this.disconnectedSlotCache.get(playerId);
      this.disconnectedSlotCache.delete(playerId);
      if (now - cached.disconnectedAt <= this.disconnectTimeoutMs && !this.entitySessionMap.has(cached.entityId)) {
        resolvedEntityId = cached.entityId;
      }
    }

    const session = new PeerSession(sessionId, {
      ...options,
      entityId: resolvedEntityId,
      playerId,
      connectedAt: now
    });
    this.sessions.set(sessionId, session);

    if (session.entityId >= 0) {
      this.entitySessionMap.set(session.entityId, sessionId);
      if (!options.deferPhysicsRegistration && typeof this.physicsManager?.registerCarEntity === 'function') {
        this.physicsManager.registerCarEntity(
          session.entityId,
          options.team ?? (session.entityId % 2),
          options.hitboxId || options.visualId || 'octane'
        );
      } else if (typeof this.physicsManager?.inputBuffer?.registerCar === 'function') {
        // In Lobby (deferPhysicsRegistration = true), register the slot in NetworkInputBuffer
        // so server-side inputBufferSize and RTT telemetry are tracked without stepping the car in physics.
        this.physicsManager.inputBuffer.registerCar(session.entityId);
      }
      if (this.physicsManager?.inputBuffer?.setCarInputStale) {
        this.physicsManager.inputBuffer.setCarInputStale(session.entityId, false);
      }
    }
    return session;
  }

  unregisterSession(sessionId, cacheForRejoin = true) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.entityId >= 0) {
      if (cacheForRejoin) {
        this.disconnectedSlotCache.set(session.playerId || sessionId, {
          entityId: session.entityId,
          playerName: session.playerName,
          disconnectedAt: this.getTime()
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

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getSessionByEntityId(entityId) {
    const sessionId = this.entitySessionMap.get(entityId);
    return sessionId ? (this.sessions.get(sessionId) || null) : null;
  }

  recordClientTimestamp(sessionId, clientTimestamp, hasValidInput = true) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const now = this.getTime();
    session._recordClientPacket(clientTimestamp, now, hasValidInput);
    if (hasValidInput && session.entityId >= 0 && this.physicsManager?.inputBuffer?.setCarInputStale) {
      this.physicsManager.inputBuffer.setCarInputStale(session.entityId, false);
    }
    return true;
  }

  _getHumanAckSessionIds() {
    const ids = [];
    for (const sid of this.sessions.keys()) {
      if (sid === 'bot' || String(sid || '').startsWith('bot_')) continue;
      ids.push(sid);
    }
    return ids;
  }

  enqueueSignal(signalObj) {
    return this.signalBuffer.pushSignal(signalObj, this._getHumanAckSessionIds());
  }

  recordClientSignalAcks(sessionId, acks) {
    if (!sessionId || !Array.isArray(acks) || acks.length === 0) return 0;
    const session = this.sessions.get(sessionId);
    if (session) {
      for (let i = 0; i < acks.length; i++) {
        if (acks[i]?.signalId > 0) {
          session.acknowledgedSignalIds.add(acks[i].signalId);
        }
      }
    }
    return this.signalBuffer.acknowledgeSignals(sessionId, acks, this._getHumanAckSessionIds());
  }

  ingestClientCommands(sessionId, commands, currentTick = 0) {
    if (!sessionId || !Array.isArray(commands) || commands.length === 0) return [];
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const freshCommands = [];
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      if (!cmd || typeof cmd.commandId !== 'number' || cmd.commandId <= 0) continue;

      if (!session.processedCommandIds.has(cmd.commandId)) {
        session.processedCommandIds.add(cmd.commandId);
        if (session.processedCommandIds.size > 256) {
          const oldest = session.processedCommandIds.values().next().value;
          session.processedCommandIds.delete(oldest);
        }
        session.lastAckedCommandId = Math.max(session.lastAckedCommandId, cmd.commandId);
        freshCommands.push(cmd);
      }

      this.signalBuffer.pushSignal({
        signalType: MATCH_SIGNALS.COMMAND_ACK,
        frameId: currentTick,
        param1: cmd.commandId,
        param2: cmd.commandType
      }, [sessionId]);
    }

    return freshCommands;
  }

  evaluateSessionTimeouts(nowMs = this.getTime(), onEvictCallback = null) {
    const staleSessions = [];
    const evictedSessions = [];

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

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  extractSignalsFromGlobalPayload(globalPayloadBytes) {
    if (!globalPayloadBytes || globalPayloadBytes.length === 0) {
      return { statelessPayloadBytes: globalPayloadBytes, serverTick: null };
    }

    const flagByte = globalPayloadBytes[0];
    const hasSignalsInGlobal = Boolean(flagByte & PAYLOAD_FLAGS.SIGNAL);
    const humanAckSessionIds = this._getHumanAckSessionIds();

    if (!hasSignalsInGlobal) {
      let serverTick = null;
      if ((flagByte & PAYLOAD_FLAGS.PHYSICS) && globalPayloadBytes.length >= 5) {
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
      physics: decoded.physics,
      signals: [],
      allUserRtt: decoded.allUserRtt
    });

    return { statelessPayloadBytes, serverTick };
  }

  buildClientPacket(sessionId, globalPayloadBytes, options = {}) {
    return buildTailoredClientPacket(this, sessionId, globalPayloadBytes, options);
  }

  static parseClientPacket(rawPacket) {
    return parseTailoredClientPacket(rawPacket);
  }

  destroy() {
    this.sessions.clear();
    this.entitySessionMap.clear();
    this.disconnectedSlotCache.clear();
    this.signalBuffer.clear();
    this.physicsManager = null;
  }
}
