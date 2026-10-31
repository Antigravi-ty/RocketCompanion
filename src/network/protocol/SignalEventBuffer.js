/**
 * src/network/SignalEventBuffer.js
 * Authoritative Per-Session Reliable Signal Buffer & ACK Tracker.
 *
 * Architectural Specification:
 * 1. Decoupled from Shared GlobalPayload:
 *    - Shared GlobalPayload strictly carries stateless 120Hz Physics State & 5s RTT Tables.
 *    - Reliable Signals (0x80..0xBF) are stored in a high-capacity SignalEventBuffer (default 4096)
 *      and tailored per-client by EstablishedSessionManager.
 * 2. Dual Expiration Modes (Prevents Buffer Overflow & Redundant ACKs):
 *    - Mode A (Frame / Tick Expiration):
 *      Signals with a target frame horizon (e.g. KICKOFF_WILL_START at frame 480) or explicit
 *      expiresAtTick automatically expire as soon as authoritative serverTick > expiresAtTick
 *      (e.g. tick 481). Obsolete signals no longer require client ACKs.
 *      Signals without an explicit frame horizon expire after defaultMaxLifetimeTicks.
 *    - Mode B (All-Client ACK Early Retirement):
 *      Once all active sessions in the signal's target recipient set have acknowledged
 *      (matching both signalId AND signalType), the signal is retired immediately.
 * 3. Per-Session Binary Wire Framing:
 *    - Encodes and decodes per-session unacknowledged signals (15 bytes per signal:
 *      [signalId(2B BE)][signalType(1B)][frameId(4B BE)][param1(4B BE)][param2(4B BE)]).
 */

import { MATCH_SIGNALS, SIGNAL_NAMES } from './GlobalPayloadCodec.js';

export const DEFAULT_SIGNAL_BUFFER_CAPACITY = 4096;
export const DEFAULT_SIGNAL_LIFETIME_TICKS = 360; // 3.0 seconds @ 120Hz fallback horizon
export const SIGNAL_WIRE_STRIDE = 15;

export class SignalEventBuffer {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity=4096] Maximum buffered active signals before oldest eviction
   * @param {number} [options.defaultLifetimeTicks=360] Default tick TTL for signals without explicit target tick
   */
  constructor(options = {}) {
    this.capacity = options.capacity ?? DEFAULT_SIGNAL_BUFFER_CAPACITY;
    this.defaultLifetimeTicks = options.defaultLifetimeTicks ?? DEFAULT_SIGNAL_LIFETIME_TICKS;

    /**
     * Map<number, {
     *   signalId: number,
     *   signalType: number,
     *   frameId: number,
     *   param1: number,
     *   param2: number,
     *   createdAtTick: number,
     *   expiresAtTick: number,
     *   targetPeers: Set<string> | null,
     *   ackedPeers: Set<string>
     * }>
     */
    this.entries = new Map();
    this.nextSignalId = 0;
  }

  /**
   * Computes the expiration tick for a signal based on its semantics:
   * - For KICKOFF_WILL_START (0x81), param1 is the target kickoff tick (e.g. 480);
   *   once serverTick reaches 481 (serverTick > param1), the signal expires naturally.
   * - Explicit options.expiresAtTick overrides default calculation.
   * - Otherwise expires at frameId + defaultLifetimeTicks.
   *
   * @param {number} signalType
   * @param {number} frameId
   * @param {number} param1
   * @param {number} [explicitExpiresAtTick]
   * @returns {number}
   */
  resolveExpirationTick(signalType, frameId, param1 = 0, explicitExpiresAtTick = null) {
    if (typeof explicitExpiresAtTick === 'number' && explicitExpiresAtTick >= 0) {
      return explicitExpiresAtTick;
    }
    if (signalType === MATCH_SIGNALS.KICKOFF_WILL_START && param1 > frameId) {
      return param1;
    }
    return frameId + this.defaultLifetimeTicks;
  }

  /**
   * Enqueues a new authoritative signal into the buffer.
   *
   * @param {object} signalInput
   * @param {number} [signalInput.signalId] Optional pre-assigned signalId (1..65535)
   * @param {number} signalInput.signalType Signal code (0x80..0xBF)
   * @param {number} [signalInput.frameId=0] Authoritative server tick at emission
   * @param {number} [signalInput.param1=0]
   * @param {number} [signalInput.param2=0]
   * @param {number} [signalInput.expiresAtTick] Optional explicit expiration tick
   * @param {Iterable<string>|null} [activeSessionIds=null] Snapshot of current session IDs required to ACK
   * @returns {object} Stored signal entry
   */
  pushSignal(signalInput, activeSessionIds = null) {
    if (!signalInput || typeof signalInput.signalType !== 'number') {
      throw new Error('[SignalEventBuffer] pushSignal requires a valid numeric signalType');
    }

    // Supersede older signals of the same state-transition type if appropriate
    if (signalInput.signalType === MATCH_SIGNALS.KICKOFF_WILL_START) {
      this.retireByType(MATCH_SIGNALS.KICKOFF_WILL_START);
    } else if (signalInput.signalType === MATCH_SIGNALS.KICKOFF_START) {
      this.retireByType(MATCH_SIGNALS.KICKOFF_WILL_START);
    } else if (signalInput.signalType === MATCH_SIGNALS.COMMAND_ACK) {
      const targetCmdId = (signalInput.param1 ?? 0) >>> 0;
      const targetCmdType = (signalInput.param2 ?? 0) >>> 0;
      for (const existing of this.entries.values()) {
        if (
          existing.signalType === MATCH_SIGNALS.COMMAND_ACK &&
          existing.param1 === targetCmdId &&
          existing.param2 === targetCmdType
        ) {
          if (activeSessionIds) {
            for (const sid of activeSessionIds) {
              existing.targetPeers.add(sid);
              existing.ackedPeers.delete(sid);
            }
          }
          return existing;
        }
      }
    }

    let signalId = signalInput.signalId;
    if (typeof signalId !== 'number' || signalId <= 0) {
      this.nextSignalId = (this.nextSignalId % 65535) + 1;
      signalId = this.nextSignalId;
    } else {
      const existingAtId = this.entries.get(signalId & 0xFFFF);
      if (
        existingAtId &&
        (existingAtId.signalType !== (signalInput.signalType & 0xFF) ||
          existingAtId.param1 !== ((signalInput.param1 ?? 0) >>> 0) ||
          existingAtId.param2 !== ((signalInput.param2 ?? 0) >>> 0))
      ) {
        this.nextSignalId = (Math.max(this.nextSignalId, signalId) % 65535) + 1;
        signalId = this.nextSignalId;
      } else {
        this.nextSignalId = Math.max(this.nextSignalId, signalId);
      }
    }

    const frameId = signalInput.frameId ?? 0;
    const param1 = signalInput.param1 ?? 0;
    const param2 = signalInput.param2 ?? 0;
    const expiresAtTick = this.resolveExpirationTick(
      signalInput.signalType,
      frameId,
      param1,
      signalInput.expiresAtTick
    );

    const isBroadcast = !activeSessionIds;
    const targetPeers = activeSessionIds ? new Set(activeSessionIds) : new Set();

    // Enforce maximum capacity to prevent buffer overflow
    if (this.entries.size >= this.capacity && !this.entries.has(signalId)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    const entry = {
      signalId: signalId & 0xFFFF,
      signalType: signalInput.signalType & 0xFF,
      frameId: frameId >>> 0,
      param1: param1 >>> 0,
      param2: param2 >>> 0,
      createdAtTick: frameId >>> 0,
      expiresAtTick,
      isBroadcast,
      targetPeers,
      ackedPeers: new Set()
    };

    this.entries.set(entry.signalId, entry);
    return entry;
  }

  /**
   * Synchronizes signals emitted in MatchSessionAdmin into this buffer.
   * Safe to call every frame (idempotent by signalId + signalType + params).
   *
   * @param {Iterable<object>} signals
   * @param {Iterable<string>} [activeSessionIds]
   */
  ingestSignals(signals, activeSessionIds = null) {
    if (!signals) return;
    for (const s of signals) {
      if (!s || typeof s.signalType !== 'number') continue;
      const id = s.signalId || 0;
      if (id > 0 && this.entries.has(id)) {
        const existing = this.entries.get(id);
        const incomingType = (s.signalType || 0) & 0xFF;
        const incomingP1 = (s.param1 ?? 0) >>> 0;
        const incomingP2 = (s.param2 ?? 0) >>> 0;
        if (
          existing.signalType === incomingType &&
          existing.param1 === incomingP1 &&
          existing.param2 === incomingP2
        ) {
          if (activeSessionIds && existing.isBroadcast) {
            for (const sid of activeSessionIds) {
              existing.targetPeers.add(sid);
            }
          }
          continue;
        }
      }
      const entry = this.pushSignal(s, activeSessionIds);
      entry.isBroadcast = true;
    }
  }

  /**
   * Records client ACKs for a specific session.
   * Requires both signalId AND signalType to match to prevent false-positive confirmation.
   * Retires the signal immediately if all required sessions have acknowledged it (Mode B).
   *
   * @param {string} sessionId
   * @param {Array<{ signalId: number, signalType: number }>} acks
   * @param {Iterable<string>} [currentActiveSessionIds]
   * @returns {number} Number of newly acknowledged signals
   */
  acknowledgeSignals(sessionId, acks, currentActiveSessionIds = null) {
    if (!sessionId || !Array.isArray(acks) || acks.length === 0) return 0;

    let newlyAcked = 0;
    const activeSet = currentActiveSessionIds ? new Set(currentActiveSessionIds) : null;

    for (let i = 0; i < acks.length; i++) {
      const ack = acks[i];
      if (!ack || typeof ack.signalId !== 'number') continue;

      const entry = this.entries.get(ack.signalId);
      if (!entry) continue;

      // Strict dual-field verification: signalId + signalType must match
      if ((entry.signalType & 0xFF) !== (ack.signalType & 0xFF)) {
        continue;
      }

      if (!entry.ackedPeers.has(sessionId)) {
        entry.ackedPeers.add(sessionId);
        newlyAcked++;
      }

      // Check Mode B: All active target clients have acknowledged
      const requiredPeers = entry.targetPeers || activeSet;
      if (requiredPeers && requiredPeers.size > 0) {
        let allAcked = true;
        for (const reqPeerId of requiredPeers) {
          if (activeSet && !activeSet.has(reqPeerId)) {
            continue; // Disconnected peers don't block retirement
          }
          if (!entry.ackedPeers.has(reqPeerId)) {
            allAcked = false;
            break;
          }
        }
        if (allAcked) {
          this.entries.delete(entry.signalId);
        }
      }
    }

    return newlyAcked;
  }

  /**
   * Prunes signals that have naturally expired by authoritative serverTick (Mode A)
   * or whose target peers have all acknowledged / disconnected (Mode B).
   *
   * @param {number} currentServerTick
   * @param {Iterable<string>} [currentActiveSessionIds]
   * @returns {number} Number of expired/retired signals removed
   */
  pruneExpired(currentServerTick, currentActiveSessionIds = null) {
    let removed = 0;
    const activeSet = currentActiveSessionIds ? new Set(currentActiveSessionIds) : null;

    for (const [signalId, entry] of this.entries.entries()) {
      // Mode A: Natural frame horizon expiration (e.g., kickoffWillStartAt = 480, currentServerTick = 481)
      if (typeof currentServerTick === 'number' && currentServerTick > entry.expiresAtTick) {
        this.entries.delete(signalId);
        removed++;
        continue;
      }

      // Mode B: All remaining active sessions have acknowledged
      const requiredPeers = entry.targetPeers || activeSet;
      if (requiredPeers && requiredPeers.size > 0) {
        let hasUnackedActivePeer = false;
        for (const peerId of requiredPeers) {
          if (activeSet && !activeSet.has(peerId)) continue;
          if (!entry.ackedPeers.has(peerId)) {
            hasUnackedActivePeer = true;
            break;
          }
        }
        if (!hasUnackedActivePeer) {
          this.entries.delete(signalId);
          removed++;
        }
      }
    }

    return removed;
  }

  /**
   * Removes a disconnected session from all pending signal target sets
   * and retires any signal that no longer has unacknowledged peers.
   *
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    if (!sessionId) return;
    for (const [signalId, entry] of this.entries.entries()) {
      entry.ackedPeers.delete(sessionId);
      if (entry.targetPeers) {
        entry.targetPeers.delete(sessionId);
        if (entry.targetPeers.size > 0) {
          let allAcked = true;
          for (const peerId of entry.targetPeers) {
            if (!entry.ackedPeers.has(peerId)) {
              allAcked = false;
              break;
            }
          }
          if (allAcked) {
            this.entries.delete(signalId);
          }
        }
      }
    }
  }

  /**
   * Retires all buffered signals of a specific signalType.
   *
   * @param {number} signalType
   */
  retireByType(signalType) {
    for (const [signalId, entry] of this.entries.entries()) {
      if (entry.signalType === signalType) {
        this.entries.delete(signalId);
      }
    }
  }

  /**
   * Returns the list of unacknowledged, non-expired signals tailored for a specific sessionId.
   *
   * @param {string} sessionId
   * @param {number} [currentServerTick]
   * @returns {Array<{ signalId: number, signalType: number, frameId: number, param1: number, param2: number }>}
   */
  getPendingSignalsForSession(sessionId, currentServerTick = null) {
    if (typeof currentServerTick === 'number') {
      this.pruneExpired(currentServerTick);
    }

    const pending = [];
    for (const entry of this.entries.values()) {
      if (typeof currentServerTick === 'number' && currentServerTick > entry.expiresAtTick) {
        continue;
      }
      if (sessionId && entry.ackedPeers.has(sessionId)) {
        continue;
      }
      if (sessionId && entry.targetPeers && !entry.targetPeers.has(sessionId)) {
        if (entry.isBroadcast) {
          entry.targetPeers.add(sessionId);
        } else {
          continue;
        }
      }
      pending.push({
        signalId: entry.signalId,
        signalType: entry.signalType,
        frameId: entry.frameId,
        param1: entry.param1,
        param2: entry.param2
      });
      if (pending.length >= 255) break;
    }

    return pending;
  }

  /**
   * Encodes a list of per-session signals into binary wire format:
   * [0] count (uint8)
   * [1..1+count*15] N * [signalId(2B BE), signalType(1B), frameId(4B BE), param1(4B BE), param2(4B BE)]
   *
   * @param {Array<object>} signals
   * @returns {Uint8Array}
   */
  static encodeSessionSignals(signals = []) {
    const count = Array.isArray(signals) ? Math.min(255, signals.length) : 0;
    const buffer = new ArrayBuffer(1 + count * SIGNAL_WIRE_STRIDE);
    const view = new DataView(buffer);
    view.setUint8(0, count);

    let offset = 1;
    for (let i = 0; i < count; i++) {
      const s = signals[i];
      view.setUint16(offset, (s.signalId || 0) & 0xFFFF, false);
      view.setUint8(offset + 2, (s.signalType || 0) & 0xFF);
      view.setUint32(offset + 3, (s.frameId || 0) >>> 0, false);
      view.setUint32(offset + 7, (s.param1 || 0) >>> 0, false);
      view.setUint32(offset + 11, (s.param2 || 0) >>> 0, false);
      offset += SIGNAL_WIRE_STRIDE;
    }

    return new Uint8Array(buffer);
  }

  /**
   * Decodes per-session signals from a buffer slice at byteOffset.
   *
   * @param {Uint8Array|ArrayBuffer|DataView} bufferInput
   * @param {number} [byteOffset=0]
   * @returns {{ signals: Array<object>, bytesRead: number }}
   */
  static decodeSessionSignals(bufferInput, byteOffset = 0) {
    if (!bufferInput) return { signals: [], bytesRead: 0 };

    let view;
    if (bufferInput instanceof DataView) {
      view = bufferInput;
    } else if (bufferInput instanceof Uint8Array) {
      view = new DataView(bufferInput.buffer, bufferInput.byteOffset, bufferInput.byteLength);
    } else if (bufferInput instanceof ArrayBuffer) {
      view = new DataView(bufferInput);
    } else {
      return { signals: [], bytesRead: 0 };
    }

    if (view.byteLength < byteOffset + 1) {
      return { signals: [], bytesRead: 0 };
    }

    const count = view.getUint8(byteOffset);
    let offset = byteOffset + 1;
    const signals = [];

    for (let i = 0; i < count; i++) {
      if (view.byteLength < offset + SIGNAL_WIRE_STRIDE) break;
      const signalId = view.getUint16(offset, false);
      const signalType = view.getUint8(offset + 2);
      const frameId = view.getUint32(offset + 3, false);
      const param1 = view.getUint32(offset + 7, false);
      const param2 = view.getUint32(offset + 11, false);
      signals.push({
        signalId,
        signalType,
        name: SIGNAL_NAMES[signalType] || `SIGNAL_0x${signalType.toString(16).toUpperCase()}`,
        frameId,
        param1,
        param2
      });
      offset += SIGNAL_WIRE_STRIDE;
    }

    return {
      signals,
      bytesRead: offset - byteOffset
    };
  }

  clear() {
    this.entries.clear();
  }
}

export default SignalEventBuffer;
