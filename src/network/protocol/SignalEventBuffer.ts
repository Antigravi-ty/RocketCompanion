/**
 * src/network/protocol/SignalEventBuffer.ts
 * Authoritative Per-Session Reliable Signal Buffer & ACK Tracker.
 */

import { MATCH_SIGNALS, SIGNAL_NAMES } from './GlobalPayloadCodec.ts';

export const DEFAULT_SIGNAL_BUFFER_CAPACITY = 4096;
export const DEFAULT_SIGNAL_LIFETIME_TICKS = 360; // 3.0 seconds @ 120Hz fallback horizon
export const SIGNAL_WIRE_STRIDE = 15;

export interface SignalEventBufferOptions {
  capacity?: number;
  defaultLifetimeTicks?: number;
}

export interface SignalInput {
  signalId?: number;
  signalType: number;
  frameId?: number;
  param1?: number;
  param2?: number;
  expiresAtTick?: number | null;
}

export interface SignalBufferEntry {
  signalId: number;
  signalType: number;
  frameId: number;
  param1: number;
  param2: number;
  createdAtTick: number;
  expiresAtTick: number;
  isBroadcast: boolean;
  targetPeers: Set<string>;
  ackedPeers: Set<string>;
}

export interface PendingSessionSignal {
  signalId: number;
  signalType: number;
  name?: string;
  frameId: number;
  param1: number;
  param2: number;
}

export type DecodedSessionSignal = PendingSessionSignal;

function areAllRequiredPeersAcked(
  ackedPeers: ReadonlySet<string>,
  requiredPeers: ReadonlySet<string> | null,
  activeSet: ReadonlySet<string> | null = null
): boolean {
  if (!requiredPeers || requiredPeers.size === 0) return false;
  for (const peerId of requiredPeers) {
    if (activeSet && !activeSet.has(peerId)) continue;
    if (!ackedPeers.has(peerId)) return false;
  }
  return true;
}

export class SignalEventBuffer {
  capacity: number;
  defaultLifetimeTicks: number;
  entries = new Map<number, SignalBufferEntry>();
  nextSignalId = 0;

  constructor(options: SignalEventBufferOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_SIGNAL_BUFFER_CAPACITY;
    this.defaultLifetimeTicks = options.defaultLifetimeTicks ?? DEFAULT_SIGNAL_LIFETIME_TICKS;
  }

  resolveExpirationTick(
    signalType: number,
    frameId: number,
    param1 = 0,
    explicitExpiresAtTick: number | null = null
  ): number {
    if (typeof explicitExpiresAtTick === 'number' && explicitExpiresAtTick >= 0) {
      return explicitExpiresAtTick;
    }
    if (signalType === MATCH_SIGNALS.KICKOFF_WILL_START && param1 > frameId) {
      return param1;
    }
    return frameId + this.defaultLifetimeTicks;
  }

  pushSignal(
    signalInput: SignalInput,
    activeSessionIds: Iterable<string> | null = null
  ): SignalBufferEntry {
    if (!signalInput || typeof signalInput.signalType !== 'number') {
      throw new Error('[SignalEventBuffer] pushSignal requires a valid numeric signalType');
    }

    if (
      signalInput.signalType === MATCH_SIGNALS.KICKOFF_WILL_START ||
      signalInput.signalType === MATCH_SIGNALS.KICKOFF_START
    ) {
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
      const existingAtId = this.entries.get(signalId & 0xffff);
      if (
        existingAtId &&
        (existingAtId.signalType !== (signalInput.signalType & 0xff) ||
          existingAtId.param1 !== (signalInput.param1 ?? 0) >>> 0 ||
          existingAtId.param2 !== (signalInput.param2 ?? 0) >>> 0)
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
      signalInput.expiresAtTick ?? null
    );

    const isBroadcast = !activeSessionIds;
    const targetPeers = activeSessionIds ? new Set(activeSessionIds) : new Set<string>();

    if (this.entries.size >= this.capacity && !this.entries.has(signalId)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }

    const entry: SignalBufferEntry = {
      signalId: signalId & 0xffff,
      signalType: signalInput.signalType & 0xff,
      frameId: frameId >>> 0,
      param1: param1 >>> 0,
      param2: param2 >>> 0,
      createdAtTick: frameId >>> 0,
      expiresAtTick,
      isBroadcast,
      targetPeers,
      ackedPeers: new Set<string>(),
    };

    this.entries.set(entry.signalId, entry);
    return entry;
  }

  ingestSignals(
    signals: Iterable<SignalInput> | null | undefined,
    activeSessionIds: Iterable<string> | null = null
  ): void {
    if (!signals) return;
    for (const s of signals) {
      if (!s || typeof s.signalType !== 'number') continue;
      const id = s.signalId || 0;
      if (id > 0 && this.entries.has(id)) {
        const existing = this.entries.get(id)!;
        const incomingType = (s.signalType || 0) & 0xff;
        const incomingP1 = (s.param1 ?? 0) >>> 0;
        const incomingP2 = (s.param2 ?? 0) >>> 0;
        if (
          existing.signalType === incomingType &&
          existing.param1 === incomingP1 &&
          existing.param2 === incomingP2
        ) {
          if (activeSessionIds && existing.isBroadcast) {
            for (const sid of activeSessionIds) existing.targetPeers.add(sid);
          }
          continue;
        }
      }
      const entry = this.pushSignal(s, activeSessionIds);
      entry.isBroadcast = true;
    }
  }

  acknowledgeSignals(
    sessionId: string,
    acks: Array<{ signalId?: number; signalType?: number }>,
    currentActiveSessionIds: Iterable<string> | null = null
  ): number {
    if (!sessionId || !Array.isArray(acks) || acks.length === 0) return 0;

    let newlyAcked = 0;
    const activeSet = currentActiveSessionIds ? new Set(currentActiveSessionIds) : null;

    for (let i = 0; i < acks.length; i++) {
      const ack = acks[i];
      if (!ack || typeof ack.signalId !== 'number') continue;

      const entry = this.entries.get(ack.signalId);
      if (!entry || (entry.signalType & 0xff) !== ((ack.signalType ?? 0) & 0xff)) continue;

      if (!entry.ackedPeers.has(sessionId)) {
        entry.ackedPeers.add(sessionId);
        newlyAcked++;
      }

      const requiredPeers = entry.targetPeers.size > 0 ? entry.targetPeers : activeSet;
      if (areAllRequiredPeersAcked(entry.ackedPeers, requiredPeers, activeSet)) {
        this.entries.delete(entry.signalId);
      }
    }

    return newlyAcked;
  }

  pruneExpired(
    currentServerTick: number,
    currentActiveSessionIds: Iterable<string> | null = null
  ): number {
    let removed = 0;
    const activeSet = currentActiveSessionIds ? new Set(currentActiveSessionIds) : null;

    for (const [signalId, entry] of this.entries.entries()) {
      const expired =
        typeof currentServerTick === 'number' && currentServerTick > entry.expiresAtTick;
      const requiredPeers = entry.targetPeers.size > 0 ? entry.targetPeers : activeSet;
      if (expired || areAllRequiredPeersAcked(entry.ackedPeers, requiredPeers, activeSet)) {
        this.entries.delete(signalId);
        removed++;
      }
    }

    return removed;
  }

  removeSession(sessionId: string): void {
    if (!sessionId) return;
    for (const [signalId, entry] of this.entries.entries()) {
      entry.ackedPeers.delete(sessionId);
      entry.targetPeers.delete(sessionId);
      if (areAllRequiredPeersAcked(entry.ackedPeers, entry.targetPeers)) {
        this.entries.delete(signalId);
      }
    }
  }

  retireSignal(signalId: number): void {
    if (signalId > 0) this.entries.delete(signalId);
  }

  retireByType(signalType: number): void {
    for (const [signalId, entry] of this.entries.entries()) {
      if (entry.signalType === signalType) this.entries.delete(signalId);
    }
  }

  getPendingSignalsForSession(
    sessionId: string,
    currentServerTick: number | null = null
  ): PendingSessionSignal[] {
    if (typeof currentServerTick === 'number') {
      this.pruneExpired(currentServerTick);
    }

    const pending: PendingSessionSignal[] = [];
    for (const entry of this.entries.values()) {
      if (typeof currentServerTick === 'number' && currentServerTick > entry.expiresAtTick) {
        continue;
      }
      if (sessionId && entry.ackedPeers.has(sessionId)) continue;
      if (sessionId && entry.targetPeers && !entry.targetPeers.has(sessionId)) {
        if (entry.isBroadcast) entry.targetPeers.add(sessionId);
        else continue;
      }
      pending.push({
        signalId: entry.signalId,
        signalType: entry.signalType,
        frameId: entry.frameId,
        param1: entry.param1,
        param2: entry.param2,
      });
      if (pending.length >= 255) break;
    }

    return pending;
  }

  static encodeSessionSignals(signals: PendingSessionSignal[] = []): Uint8Array {
    const count = Array.isArray(signals) ? Math.min(255, signals.length) : 0;
    const buffer = new ArrayBuffer(1 + count * SIGNAL_WIRE_STRIDE);
    const view = new DataView(buffer);
    view.setUint8(0, count);

    let offset = 1;
    for (let i = 0; i < count; i++) {
      const s = signals[i];
      view.setUint16(offset, (s.signalId || 0) & 0xffff, false);
      view.setUint8(offset + 2, (s.signalType || 0) & 0xff);
      view.setUint32(offset + 3, (s.frameId || 0) >>> 0, false);
      view.setUint32(offset + 7, (s.param1 || 0) >>> 0, false);
      view.setUint32(offset + 11, (s.param2 || 0) >>> 0, false);
      offset += SIGNAL_WIRE_STRIDE;
    }

    return new Uint8Array(buffer);
  }

  static decodeSessionSignals(
    bufferInput: DataView | Uint8Array | ArrayBuffer | null | undefined,
    byteOffset = 0
  ): { signals: PendingSessionSignal[]; bytesRead: number } {
    if (!bufferInput) return { signals: [], bytesRead: 0 };

    const view =
      bufferInput instanceof DataView
        ? bufferInput
        : bufferInput instanceof Uint8Array
          ? new DataView(bufferInput.buffer, bufferInput.byteOffset, bufferInput.byteLength)
          : bufferInput instanceof ArrayBuffer
            ? new DataView(bufferInput)
            : null;
    if (!view || view.byteLength < byteOffset + 1) return { signals: [], bytesRead: 0 };

    const count = view.getUint8(byteOffset);
    let offset = byteOffset + 1;
    const signals: PendingSessionSignal[] = [];

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
        param2,
      });
      offset += SIGNAL_WIRE_STRIDE;
    }

    return {
      signals,
      bytesRead: offset - byteOffset,
    };
  }

  clear(): void {
    if (this.entries.size > 0) this.entries.clear();
  }
}

export default SignalEventBuffer;
