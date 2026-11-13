/**
 * src/network/sync/TelestratorSyncChannel.ts
 * Reliable telestrator stroke synchronization with FNV-1a hash ACK verification,
 * automatic retransmission on hash mismatch/timeout, and Undo/Clear dispatch.
 */

import {
  TELESTRATOR_FRAME_TYPE,
  computeTelestratorStrokeHash,
  decodeTelestratorAckFrame,
  decodeTelestratorCommandFrame,
  decodeTelestratorStrokeFrame,
  encodeTelestratorAckFrame,
  encodeTelestratorCommandFrame,
  encodeTelestratorStrokeFrame,
  type TelestratorCommandFrame,
  type TelestratorStrokePayload,
} from '../protocol/TelestratorFrameCodec.ts';

export interface TelestratorReliableTransportPort {
  sendReliable: (payload: Uint8Array) => void;
}

export interface PendingStrokeEntry {
  stroke: TelestratorStrokePayload;
  encoded: Uint8Array;
  lastSentMs: number;
  attempts: number;
}

export interface TelestratorSyncHandlers {
  onStrokeReceived?: (stroke: TelestratorStrokePayload) => void;
  onUndoReceived?: (cmd: TelestratorCommandFrame) => void;
  onClearReceived?: (cmd: TelestratorCommandFrame) => void;
  onStrokeAcked?: (strokeId: number) => void;
}

const STROKE_RETRANSMIT_TIMEOUT_MS = 400;
const MAX_STROKE_RETRANSMITS = 5;

export class TelestratorSyncChannel {
  private readonly pendingOutbound = new Map<number, PendingStrokeEntry>();
  private transport: TelestratorReliableTransportPort | null = null;
  private handlers: TelestratorSyncHandlers = {};

  bindTransport(transport: TelestratorReliableTransportPort | null): void {
    this.transport = transport;
  }

  setHandlers(handlers: TelestratorSyncHandlers): void {
    this.handlers = handlers;
  }

  sendStroke(
    strokeInput: Omit<TelestratorStrokePayload, 'fnv1aHash'>,
    nowMs = performance.now()
  ): TelestratorStrokePayload {
    const fnv1aHash = computeTelestratorStrokeHash(
      strokeInput.points,
      strokeInput.style,
      strokeInput.colorIndex,
      strokeInput.opacityPct,
      strokeInput.widthPx
    );
    const stroke: TelestratorStrokePayload = { ...strokeInput, fnv1aHash };
    const encoded = encodeTelestratorStrokeFrame(stroke);
    this.pendingOutbound.set(stroke.strokeId, {
      stroke,
      encoded,
      lastSentMs: nowMs,
      attempts: 1,
    });
    this.transport?.sendReliable(encoded);
    return stroke;
  }

  sendUndo(authorPeerSlot: number, targetStrokeId: number): void {
    this.pendingOutbound.delete(targetStrokeId);
    this.transport?.sendReliable(
      encodeTelestratorCommandFrame({
        frameType: TELESTRATOR_FRAME_TYPE.STROKE_UNDO,
        authorPeerSlot,
        targetStrokeId,
      })
    );
  }

  sendClear(authorPeerSlot: number): void {
    this.pendingOutbound.clear();
    this.transport?.sendReliable(
      encodeTelestratorCommandFrame({
        frameType: TELESTRATOR_FRAME_TYPE.STROKE_CLEAR,
        authorPeerSlot,
        targetStrokeId: 0,
      })
    );
  }

  tickRetransmissions(nowMs = performance.now()): number {
    let resentCount = 0;
    for (const [strokeId, entry] of this.pendingOutbound.entries()) {
      if (nowMs - entry.lastSentMs < STROKE_RETRANSMIT_TIMEOUT_MS) continue;
      if (entry.attempts >= MAX_STROKE_RETRANSMITS) {
        this.pendingOutbound.delete(strokeId);
        continue;
      }
      entry.lastSentMs = nowMs;
      entry.attempts += 1;
      this.transport?.sendReliable(entry.encoded);
      resentCount += 1;
    }
    return resentCount;
  }

  getPendingCount(): number {
    return this.pendingOutbound.size;
  }

  handleInboundBytes(bytes: Uint8Array, nowMs = performance.now()): boolean {
    if (bytes.byteLength === 0) return false;
    const frameType = bytes[0];

    if (frameType === TELESTRATOR_FRAME_TYPE.STROKE_COMMIT) {
      const stroke = decodeTelestratorStrokeFrame(bytes);
      if (!stroke) return false;
      const computed = computeTelestratorStrokeHash(
        stroke.points,
        stroke.style,
        stroke.colorIndex,
        stroke.opacityPct,
        stroke.widthPx
      );
      const accepted = computed === stroke.fnv1aHash;
      this.transport?.sendReliable(
        encodeTelestratorAckFrame({
          strokeId: stroke.strokeId,
          fnv1aHash: computed,
          accepted,
        })
      );
      if (accepted) {
        this.handlers.onStrokeReceived?.(stroke);
      }
      return true;
    }

    if (frameType === TELESTRATOR_FRAME_TYPE.STROKE_ACK) {
      const ack = decodeTelestratorAckFrame(bytes);
      if (!ack) return false;
      const pending = this.pendingOutbound.get(ack.strokeId);
      if (!pending) return true;
      if (ack.accepted && ack.fnv1aHash === pending.stroke.fnv1aHash) {
        this.pendingOutbound.delete(ack.strokeId);
        this.handlers.onStrokeAcked?.(ack.strokeId);
      } else {
        // Hash mismatch or NACK: immediately retransmit full stroke payload
        pending.lastSentMs = nowMs;
        pending.attempts += 1;
        this.transport?.sendReliable(pending.encoded);
      }
      return true;
    }

    if (frameType === TELESTRATOR_FRAME_TYPE.STROKE_UNDO) {
      const cmd = decodeTelestratorCommandFrame(bytes);
      if (!cmd) return false;
      this.handlers.onUndoReceived?.(cmd);
      return true;
    }

    if (frameType === TELESTRATOR_FRAME_TYPE.STROKE_CLEAR) {
      const cmd = decodeTelestratorCommandFrame(bytes);
      if (!cmd) return false;
      this.handlers.onClearReceived?.(cmd);
      return true;
    }

    return false;
  }
}
