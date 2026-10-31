/**
 * src/network/PeerSession.js
 * Peer Session entity and Tailored Client Datagram wire framing codec.
 */

import { GlobalPayloadCodec } from '../protocol/GlobalPayloadCodec.js';
import { SignalEventBuffer } from '../protocol/SignalEventBuffer.js';

export const CLIENT_HEADER_SIZE = 17; // 8 + 8 + 1 bytes
export const HEADER_SESSION_SIGNAL_FLAG = 0x80; // Bit 7 of byte 16 indicates per-session signal block
export const INPUT_STALE_NEUTRAL_TIMEOUT_MS = 1000; // 1.0s without valid input -> switch to neutral controls
export const SESSION_DISCONNECT_TIMEOUT_MS = 30000; // 30.0s without valid input -> evict entity

export class PeerSession {
  /**
   * @param {string} sessionId Unique peer identifier / channel id
   * @param {object} [options]
   * @param {string} [options.role='player'] 'player' | 'spectator'
   * @param {number} [options.entityId=-1] Car index 0..5 or -1 for spectator
   * @param {string} [options.playerName='Player']
   * @param {number} [options.connectedAt=0]
   */
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId;
    this.role = options.role || 'player';
    this.entityId = options.entityId ?? -1;
    this.playerName = options.playerName || 'Player';
    this.playerId = options.playerId || sessionId;

    const initialNow = options.connectedAt ?? 0;
    this._latestClientTimestamp = 0;
    this._latestServerReceiptTime = initialNow;
    this._lastValidInputTime = initialNow;

    this.rttMs = 0;
    this.jitterMs = 0;
    this.lastEchoedServerTimestamp = 0;

    this.acknowledgedSignalIds = new Set();
    this.processedCommandIds = new Set();
    this.lastAckedCommandId = 0;
    this.isInputStale = false;
  }

  get latestClientTimestamp() {
    return this._latestClientTimestamp;
  }

  get latestServerReceiptTime() {
    return this._latestServerReceiptTime;
  }

  get lastValidInputTime() {
    return this._lastValidInputTime;
  }

  /**
   * Package-private update method: strictly called only by EstablishedSessionManager
   * @internal
   */
  _recordClientPacket(clientTs, serverNowMs, hasValidInput = true) {
    this._latestClientTimestamp = clientTs;
    this._latestServerReceiptTime = serverNowMs;
    if (hasValidInput) {
      this._lastValidInputTime = serverNowMs;
      this.isInputStale = false;
    }
  }

  updateRtt(measuredRtt) {
    if (this.rttMs === 0) {
      this.rttMs = measuredRtt;
    } else {
      this.rttMs = (this.rttMs * 0.8) + (measuredRtt * 0.2);
    }
  }
}

export function buildTailoredClientPacket(manager, sessionId, globalPayloadBytes, options = {}) {
  const session = manager.sessions.get(sessionId);
  const serverTs = manager.getTime();
  let clientTs = 0;
  if (session && session.latestClientTimestamp > 0) {
    const serverHoldMs = session.latestServerReceiptTime > 0
      ? Math.max(0, serverTs - session.latestServerReceiptTime)
      : 0;
    clientTs = session.latestClientTimestamp + serverHoldMs;
  }

  let bufferSize = 0;
  if (session && session.entityId >= 0 && manager.physicsManager) {
    bufferSize = manager.physicsManager.getInputBufferSize(session.entityId);
  }
  bufferSize = Math.max(-64, Math.min(63, Math.round(bufferSize)));

  let statelessBytes = globalPayloadBytes;
  let currentTick = options.serverTick ?? (manager.physicsManager ? manager.physicsManager.currentTick : null);

  if (!options.alreadyStripped && globalPayloadBytes && globalPayloadBytes.length > 0) {
    const extracted = manager.extractSignalsFromGlobalPayload(globalPayloadBytes);
    statelessBytes = extracted.statelessPayloadBytes;
    if (extracted.serverTick !== null) {
      currentTick = extracted.serverTick;
    }
  }

  const pendingSignals = manager.signalBuffer.getPendingSignalsForSession(sessionId, currentTick);
  const hasSessionSignals = pendingSignals.length > 0;
  const sessionSignalsBytes = hasSessionSignals
    ? SignalEventBuffer.encodeSessionSignals(pendingSignals)
    : null;

  const sigBytesLen = sessionSignalsBytes ? sessionSignalsBytes.length : 0;
  const payloadLen = statelessBytes ? statelessBytes.length : 0;
  const totalLen = CLIENT_HEADER_SIZE + sigBytesLen + payloadLen;

  const buffer = new ArrayBuffer(totalLen);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  view.setFloat64(0, clientTs, false);
  view.setFloat64(8, serverTs, false);
  const signed7Bit = bufferSize & 0x7F;
  const headerByte16 = hasSessionSignals
    ? (signed7Bit | HEADER_SESSION_SIGNAL_FLAG)
    : signed7Bit;
  view.setUint8(16, headerByte16);

  let offset = CLIENT_HEADER_SIZE;
  if (sigBytesLen > 0) {
    uint8.set(sessionSignalsBytes, offset);
    offset += sigBytesLen;
  }

  if (payloadLen > 0) {
    uint8.set(statelessBytes, offset);
  }

  return uint8;
}

export function parseTailoredClientPacket(rawPacket) {
  if (!rawPacket) return null;
  const bytes = rawPacket instanceof Uint8Array ? rawPacket : new Uint8Array(rawPacket);
  if (bytes.length < CLIENT_HEADER_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const clientTimestamp = view.getFloat64(0, false);
  const serverTimestamp = view.getFloat64(8, false);
  const rawByte16 = view.getUint8(16);
  const hasSessionSignals = Boolean(rawByte16 & HEADER_SESSION_SIGNAL_FLAG);
  const raw7 = rawByte16 & 0x7F;
  const inputBufferSize = raw7 >= 64 ? raw7 - 128 : raw7;

  let offset = CLIENT_HEADER_SIZE;
  let sessionSignals = [];

  if (hasSessionSignals && bytes.length > offset) {
    const decodedSigs = SignalEventBuffer.decodeSessionSignals(bytes, offset);
    sessionSignals = decodedSigs.signals;
    offset += decodedSigs.bytesRead;
  }

  let globalPayloadSlice = bytes.subarray(offset);

  if (sessionSignals.length > 0) {
    if (globalPayloadSlice.length > 0) {
      const decodedGlobal = GlobalPayloadCodec.decode(globalPayloadSlice);
      if (decodedGlobal) {
        const mergedSignals = [...sessionSignals, ...(decodedGlobal.signals || [])];
        globalPayloadSlice = GlobalPayloadCodec.encode({
          physics: decodedGlobal.physics,
          signals: mergedSignals,
          allUserRtt: decodedGlobal.allUserRtt
        });
      }
    } else {
      globalPayloadSlice = GlobalPayloadCodec.encode({
        physics: null,
        signals: sessionSignals,
        allUserRtt: null
      });
    }
  }

  return {
    clientTimestamp,
    serverTimestamp,
    inputBufferSize,
    sessionSignals,
    globalPayloadSlice
  };
}
