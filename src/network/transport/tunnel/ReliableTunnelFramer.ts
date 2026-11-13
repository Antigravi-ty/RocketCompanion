/**
 * src/network/transport/tunnel/ReliableTunnelFramer.ts
 * Lightweight reliable chunking + ACK + retransmission layer for unreliable UDP P2P tunnels.
 * Ensures RELIABLE_CONTROL, TELESTRATOR_SYNC, STATE_PAUSED_ACK, and oversized (>1100B)
 * payloads are delivered intact and in-order without blocking unreliable state snapshots.
 */

export const RELIABLE_FRAME_MAGIC_DATA = 0x5246; // 'RF'
export const RELIABLE_FRAME_MAGIC_ACK = 0x5241; // 'RA'
export const RELIABLE_DATA_HEADER_BYTES = 10;
export const RELIABLE_ACK_BYTES = 6;
export const DEFAULT_MAX_CHUNK_BYTES = 1080;

interface PendingOutgoingChunk {
  msgId: number;
  chunkIdx: number;
  frame: Uint8Array;
  sentAtMs: number;
  retries: number;
}

interface IncomingAssembly {
  total: number;
  received: number;
  chunks: (Uint8Array | null)[];
  updatedAtMs: number;
}

export interface ReliableTunnelFramerOptions {
  maxChunkBytes?: number;
  retransmitIntervalMs?: number;
  maxRetries?: number;
  assemblyTimeoutMs?: number;
  sendRaw: (frame: Uint8Array) => boolean;
  onReliablePayload: (payload: Uint8Array) => void;
  nowMs?: () => number;
}

export class ReliableTunnelFramer {
  private nextMsgId = 1;
  private readonly maxChunkBytes: number;
  private readonly retransmitIntervalMs: number;
  private readonly maxRetries: number;
  private readonly assemblyTimeoutMs: number;
  private readonly sendRaw: (frame: Uint8Array) => boolean;
  private readonly onReliablePayload: (payload: Uint8Array) => void;
  private readonly nowMs: () => number;

  private readonly pendingOutgoing = new Map<string, PendingOutgoingChunk>();
  private readonly incomingAssemblies = new Map<number, IncomingAssembly>();
  private readonly seenMsgIds = new Set<number>();
  private readonly seenOrder: number[] = [];
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ReliableTunnelFramerOptions) {
    this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    this.retransmitIntervalMs = options.retransmitIntervalMs ?? 45;
    this.maxRetries = options.maxRetries ?? 12;
    this.assemblyTimeoutMs = options.assemblyTimeoutMs ?? 5000;
    this.sendRaw = options.sendRaw;
    this.onReliablePayload = options.onReliablePayload;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  static isReliableFrame(data: Uint8Array): boolean {
    if (data.byteLength < RELIABLE_ACK_BYTES) return false;
    const magic = (data[0] << 8) | data[1];
    return magic === RELIABLE_FRAME_MAGIC_DATA || magic === RELIABLE_FRAME_MAGIC_ACK;
  }

  sendReliable(payload: Uint8Array): boolean {
    const msgId = this.nextMsgId++ >>> 0;
    const totalChunks = Math.max(1, Math.ceil(payload.byteLength / this.maxChunkBytes));
    const now = this.nowMs();
    let allSent = true;

    for (let idx = 0; idx < totalChunks; idx++) {
      const start = idx * this.maxChunkBytes;
      const end = Math.min(payload.byteLength, start + this.maxChunkBytes);
      const slice = payload.subarray(start, end);
      const frame = new Uint8Array(RELIABLE_DATA_HEADER_BYTES + slice.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint16(0, RELIABLE_FRAME_MAGIC_DATA, false);
      view.setUint32(2, msgId, false);
      view.setUint16(6, idx, false);
      view.setUint16(8, totalChunks, false);
      frame.set(slice, RELIABLE_DATA_HEADER_BYTES);

      const key = `${msgId}:${idx}`;
      this.pendingOutgoing.set(key, {
        msgId,
        chunkIdx: idx,
        frame,
        sentAtMs: now,
        retries: 0,
      });

      if (!this.sendRaw(frame)) {
        allSent = false;
      }
    }

    this.ensureRetryTimer();
    return allSent;
  }

  handleIncomingFrame(frame: Uint8Array): boolean {
    if (frame.byteLength < RELIABLE_ACK_BYTES) return false;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const magic = view.getUint16(0, false);

    if (magic === RELIABLE_FRAME_MAGIC_ACK) {
      const msgId = view.getUint32(2, false);
      const chunkIdx = view.getUint16(6, false);
      this.pendingOutgoing.delete(`${msgId}:${chunkIdx}`);
      if (this.pendingOutgoing.size === 0) {
        this.stopRetryTimer();
      }
      return true;
    }

    if (magic !== RELIABLE_FRAME_MAGIC_DATA || frame.byteLength < RELIABLE_DATA_HEADER_BYTES) {
      return false;
    }

    const msgId = view.getUint32(2, false);
    const chunkIdx = view.getUint16(6, false);
    const totalChunks = view.getUint16(8, false);
    if (totalChunks === 0 || chunkIdx >= totalChunks) return true;

    this.sendAck(msgId, chunkIdx);

    if (this.seenMsgIds.has(msgId)) {
      return true;
    }

    const chunkPayload = frame.subarray(RELIABLE_DATA_HEADER_BYTES);
    if (totalChunks === 1) {
      this.markSeen(msgId);
      this.onReliablePayload(chunkPayload);
      return true;
    }

    let assembly = this.incomingAssemblies.get(msgId);
    if (!assembly) {
      assembly = {
        total: totalChunks,
        received: 0,
        chunks: new Array<Uint8Array | null>(totalChunks).fill(null),
        updatedAtMs: this.nowMs(),
      };
      this.incomingAssemblies.set(msgId, assembly);
    }

    if (assembly.chunks[chunkIdx] === null) {
      assembly.chunks[chunkIdx] = new Uint8Array(chunkPayload);
      assembly.received += 1;
      assembly.updatedAtMs = this.nowMs();
    }

    if (assembly.received === assembly.total) {
      this.incomingAssemblies.delete(msgId);
      this.markSeen(msgId);
      let totalBytes = 0;
      for (const c of assembly.chunks) {
        totalBytes += c ? c.byteLength : 0;
      }
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of assembly.chunks) {
        if (c) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
      }
      this.onReliablePayload(merged);
    }

    return true;
  }

  tickRetransmit(): void {
    const now = this.nowMs();
    for (const [key, item] of this.pendingOutgoing.entries()) {
      if (now - item.sentAtMs < this.retransmitIntervalMs) continue;
      if (item.retries >= this.maxRetries) {
        this.pendingOutgoing.delete(key);
        continue;
      }
      item.retries += 1;
      item.sentAtMs = now;
      this.sendRaw(item.frame);
    }

    for (const [msgId, assembly] of this.incomingAssemblies.entries()) {
      if (now - assembly.updatedAtMs > this.assemblyTimeoutMs) {
        this.incomingAssemblies.delete(msgId);
      }
    }

    if (this.pendingOutgoing.size === 0) {
      this.stopRetryTimer();
    }
  }

  getPendingCount(): number {
    return this.pendingOutgoing.size;
  }

  dispose(): void {
    this.stopRetryTimer();
    this.pendingOutgoing.clear();
    this.incomingAssemblies.clear();
    this.seenMsgIds.clear();
    this.seenOrder.length = 0;
  }

  private sendAck(msgId: number, chunkIdx: number): void {
    const ack = new Uint8Array(8);
    const view = new DataView(ack.buffer);
    view.setUint16(0, RELIABLE_FRAME_MAGIC_ACK, false);
    view.setUint32(2, msgId, false);
    view.setUint16(6, chunkIdx, false);
    this.sendRaw(ack);
  }

  private markSeen(msgId: number): void {
    this.seenMsgIds.add(msgId);
    this.seenOrder.push(msgId);
    if (this.seenOrder.length > 512) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) {
        this.seenMsgIds.delete(oldest);
      }
    }
  }

  private ensureRetryTimer(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setInterval(() => this.tickRetransmit(), this.retransmitIntervalMs);
  }

  private stopRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
