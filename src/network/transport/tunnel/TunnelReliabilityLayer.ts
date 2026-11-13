/**
 * src/network/transport/tunnel/TunnelReliabilityLayer.ts
 * Lightweight MTU fragmentation + selective-retransmit reliability layer for raw UDP tunnels.
 * - Unreliable packets <= MTU: 2-byte header (zero ACK overhead, zero head-of-line blocking).
 * - Unreliable packets > MTU: fragmented by msgId + fragIdx/fragCount.
 * - Reliable packets (RELIABLE_CONTROL, TELESTRATOR_SYNC, etc.): sequence-numbered + ACKed + retransmitted.
 */

export type TunnelAppPayload = Uint8Array | ArrayBuffer | string;

const UDP_SAFE_CHUNK_BYTES = 1160;
const KIND_UNRELIABLE_SINGLE = 0x00;
const KIND_UNRELIABLE_FRAG = 0x01;
const KIND_RELIABLE_FRAG = 0x02;
const KIND_RELIABLE_ACK = 0x03;

const PAYLOAD_TAG_BINARY = 0x00;
const PAYLOAD_TAG_STRING = 0x01;

const RELIABLE_RTO_MS = 65;
const RELIABLE_MAX_RETRIES = 18;
const FRAG_GC_AGE_MS = 3000;
const DEDUP_WINDOW = 256;

interface PendingReliableTx {
  seq: number;
  frames: Uint8Array[];
  sentAtMs: number;
  retries: number;
}

interface FragmentAssembly {
  createdAtMs: number;
  isString: boolean;
  total: number;
  receivedCount: number;
  chunks: Array<Uint8Array | null>;
}

export class TunnelReliabilityLayer {
  private readonly sendRawDatagram: (datagram: Uint8Array) => boolean;
  private readonly deliverPayload: (payload: TunnelAppPayload) => void;
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();

  private nextMsgId = 1;
  private nextReliableSeq = 1;
  private readonly pendingReliable = new Map<number, PendingReliableTx>();
  private readonly unreliableAssemblies = new Map<number, FragmentAssembly>();
  private readonly reliableAssemblies = new Map<number, FragmentAssembly>();
  private readonly recentReliableSeqs = new Set<number>();
  private readonly recentReliableQueue: number[] = [];
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    sendRawDatagram: (datagram: Uint8Array) => boolean,
    deliverPayload: (payload: TunnelAppPayload) => void
  ) {
    this.sendRawDatagram = sendRawDatagram;
    this.deliverPayload = deliverPayload;
  }

  send(payload: TunnelAppPayload, reliable: boolean): boolean {
    if (this.closed) return false;
    const isString = typeof payload === 'string';
    const rawBytes = isString
      ? this.textEncoder.encode(payload)
      : payload instanceof Uint8Array
        ? payload
        : new Uint8Array(payload);

    if (!reliable) {
      return this.sendUnreliable(rawBytes, isString);
    }
    return this.sendReliable(rawBytes, isString);
  }

  private sendUnreliable(bytes: Uint8Array, isString: boolean): boolean {
    const tag = isString ? PAYLOAD_TAG_STRING : PAYLOAD_TAG_BINARY;
    if (bytes.byteLength <= UDP_SAFE_CHUNK_BYTES) {
      const frame = new Uint8Array(2 + bytes.byteLength);
      frame[0] = KIND_UNRELIABLE_SINGLE;
      frame[1] = tag;
      frame.set(bytes, 2);
      return this.sendRawDatagram(frame);
    }

    const msgId = this.nextMsgId++ & 0xffff;
    const total = Math.ceil(bytes.byteLength / UDP_SAFE_CHUNK_BYTES);
    if (total > 255) return false;

    let allSent = true;
    for (let i = 0; i < total; i++) {
      const start = i * UDP_SAFE_CHUNK_BYTES;
      const chunk = bytes.subarray(start, Math.min(start + UDP_SAFE_CHUNK_BYTES, bytes.byteLength));
      const frame = new Uint8Array(6 + chunk.byteLength);
      const view = new DataView(frame.buffer);
      frame[0] = KIND_UNRELIABLE_FRAG;
      frame[1] = tag;
      view.setUint16(2, msgId, false);
      frame[4] = i;
      frame[5] = total;
      frame.set(chunk, 6);
      if (!this.sendRawDatagram(frame)) allSent = false;
    }
    return allSent;
  }

  private sendReliable(bytes: Uint8Array, isString: boolean): boolean {
    const tag = isString ? PAYLOAD_TAG_STRING : PAYLOAD_TAG_BINARY;
    const seq = this.nextReliableSeq++ >>> 0;
    const total = Math.max(1, Math.ceil(bytes.byteLength / UDP_SAFE_CHUNK_BYTES));
    if (total > 255) return false;

    const frames: Uint8Array[] = [];
    for (let i = 0; i < total; i++) {
      const start = i * UDP_SAFE_CHUNK_BYTES;
      const chunk = bytes.subarray(start, Math.min(start + UDP_SAFE_CHUNK_BYTES, bytes.byteLength));
      const frame = new Uint8Array(8 + chunk.byteLength);
      const view = new DataView(frame.buffer);
      frame[0] = KIND_RELIABLE_FRAG;
      frame[1] = tag;
      view.setUint32(2, seq, false);
      frame[6] = i;
      frame[7] = total;
      frame.set(chunk, 8);
      frames.push(frame);
      this.sendRawDatagram(frame);
    }

    this.pendingReliable.set(seq, {
      seq,
      frames,
      sentAtMs: Date.now(),
      retries: 0,
    });
    this.ensureRetryTimer();
    return true;
  }

  private ensureRetryTimer(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setInterval(() => {
      const now = Date.now();
      for (const [seq, entry] of this.pendingReliable) {
        if (now - entry.sentAtMs < RELIABLE_RTO_MS) continue;
        if (entry.retries >= RELIABLE_MAX_RETRIES) {
          this.pendingReliable.delete(seq);
          continue;
        }
        entry.retries += 1;
        entry.sentAtMs = now;
        for (const frame of entry.frames) {
          this.sendRawDatagram(frame);
        }
      }
      this.gcAssemblies(now);
      if (this.pendingReliable.size === 0 && this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    }, 30);
  }

  private gcAssemblies(now: number): void {
    for (const [id, entry] of this.unreliableAssemblies) {
      if (now - entry.createdAtMs > FRAG_GC_AGE_MS) this.unreliableAssemblies.delete(id);
    }
    for (const [seq, entry] of this.reliableAssemblies) {
      if (now - entry.createdAtMs > FRAG_GC_AGE_MS) this.reliableAssemblies.delete(seq);
    }
  }

  handleInboundDatagram(datagram: Uint8Array): void {
    if (this.closed || datagram.byteLength < 2) return;
    const kind = datagram[0];
    const tag = datagram[1];
    const isString = tag === PAYLOAD_TAG_STRING;

    if (kind === KIND_UNRELIABLE_SINGLE) {
      this.emitAssembled(datagram.subarray(2), isString);
      return;
    }

    if (kind === KIND_UNRELIABLE_FRAG && datagram.byteLength >= 6) {
      const view = new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength);
      const msgId = view.getUint16(2, false);
      const idx = datagram[4];
      const total = datagram[5];
      this.ingestFragment(
        this.unreliableAssemblies,
        msgId,
        idx,
        total,
        isString,
        datagram.subarray(6)
      );
      return;
    }

    if (kind === KIND_RELIABLE_FRAG && datagram.byteLength >= 8) {
      const view = new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength);
      const seq = view.getUint32(2, false);
      const idx = datagram[6];
      const total = datagram[7];
      this.sendAck(seq);
      if (this.recentReliableSeqs.has(seq)) return;

      const completed = this.ingestFragment(
        this.reliableAssemblies,
        seq,
        idx,
        total,
        isString,
        datagram.subarray(8)
      );
      if (completed) {
        this.markReliableSeqSeen(seq);
      }
      return;
    }

    if (kind === KIND_RELIABLE_ACK && datagram.byteLength >= 6) {
      const view = new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength);
      const ackSeq = view.getUint32(2, false);
      this.pendingReliable.delete(ackSeq);
    }
  }

  private sendAck(seq: number): void {
    const ack = new Uint8Array(6);
    ack[0] = KIND_RELIABLE_ACK;
    ack[1] = 0;
    new DataView(ack.buffer).setUint32(2, seq, false);
    this.sendRawDatagram(ack);
  }

  private markReliableSeqSeen(seq: number): void {
    this.recentReliableSeqs.add(seq);
    this.recentReliableQueue.push(seq);
    if (this.recentReliableQueue.length > DEDUP_WINDOW) {
      const oldest = this.recentReliableQueue.shift();
      if (oldest !== undefined) this.recentReliableSeqs.delete(oldest);
    }
  }

  private ingestFragment(
    map: Map<number, FragmentAssembly>,
    id: number,
    idx: number,
    total: number,
    isString: boolean,
    chunk: Uint8Array
  ): boolean {
    if (total === 0 || idx >= total) return false;
    if (total === 1) {
      this.emitAssembled(chunk, isString);
      return true;
    }
    let entry = map.get(id);
    if (!entry) {
      entry = {
        createdAtMs: Date.now(),
        isString,
        total,
        receivedCount: 0,
        chunks: new Array<Uint8Array | null>(total).fill(null),
      };
      map.set(id, entry);
    }
    if (entry.chunks[idx] === null) {
      entry.chunks[idx] = chunk.slice();
      entry.receivedCount += 1;
    }
    if (entry.receivedCount < entry.total) return false;

    map.delete(id);
    let totalLen = 0;
    for (const c of entry.chunks) {
      if (c) totalLen += c.byteLength;
    }
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of entry.chunks) {
      if (c) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
    }
    this.emitAssembled(merged, entry.isString);
    return true;
  }

  private emitAssembled(bytes: Uint8Array, isString: boolean): void {
    if (isString) {
      this.deliverPayload(this.textDecoder.decode(bytes));
    } else {
      this.deliverPayload(bytes);
    }
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingReliable.clear();
    this.unreliableAssemblies.clear();
    this.reliableAssemblies.clear();
    this.recentReliableSeqs.clear();
    this.recentReliableQueue.length = 0;
  }
}
