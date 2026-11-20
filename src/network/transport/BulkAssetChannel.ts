/**
 * src/network/transport/BulkAssetChannel.ts
 * Channel 4: Low-priority independent Reliable DataChannel ('game_bulk')
 * with deterministic chunking, FNV-1a fileHash verification, and bufferedAmount backpressure.
 */

import {
  BULK_FRAME_TYPES,
  computeBulkFileHash,
  decodeBulkAssetFrame,
  encodeBulkChunkFrame,
  encodeBulkControlFrame,
  formatBulkFileHashHex,
  type BulkAssetKind,
  type BulkAssetMetadata,
  type DecodedBulkChunkFrame,
  type GhostTrajectoryBulkMetadata,
  type ReplayFileBulkMetadata,
  type RewinderSliceBulkMetadata,
  type TrainingPackBulkMetadata,
} from '../protocol/BulkAssetProtocol.ts';

export const DEFAULT_BULK_CHUNK_BYTES = 16384;
export const DEFAULT_BULK_HIGH_WATER_BYTES = 262144;
export const DEFAULT_BULK_LOW_WATER_BYTES = 65536;
export const DEFAULT_MAX_CHUNKS_PER_PUMP = 8;

export interface BulkAssetTransportSink {
  sendFrame: (frame: Uint8Array) => boolean;
  getBufferedAmount: () => number;
  isReady: () => boolean;
}

export interface ReceivedBulkAsset<TMetadata = BulkAssetMetadata> {
  readonly transferId: number;
  readonly kind: BulkAssetKind;
  readonly payload: Uint8Array;
  readonly fileHash: number;
  readonly fileHashHex: string;
  readonly metadata: TMetadata | null;
}

export interface BulkTransferProgress {
  readonly direction: 'send' | 'receive';
  readonly transferId: number;
  readonly kind: BulkAssetKind;
  readonly completedChunks: number;
  readonly totalChunks: number;
  readonly bytesTransferred: number;
  readonly totalBytes: number;
}

export interface BulkTransferError {
  readonly transferId: number;
  readonly reason: 'hash_mismatch' | 'cancelled' | 'size_mismatch' | 'metadata_parse_error';
  readonly expectedHash?: number;
  readonly actualHash?: number;
}

export interface BulkAssetChannelOptions {
  chunkSizeBytes?: number;
  highWaterMarkBytes?: number;
  lowWaterMarkBytes?: number;
  maxChunksPerPump?: number;
  sink?: BulkAssetTransportSink | null;
}

export interface BulkAssetChannelStats {
  bytesSent: number;
  bytesReceived: number;
  chunksSent: number;
  chunksReceived: number;
  backpressurePauses: number;
  hashMismatches: number;
  completedTransfers: number;
}

interface OutgoingTransfer {
  readonly transferId: number;
  readonly kind: BulkAssetKind;
  readonly payload: Uint8Array;
  readonly totalBytes: number;
  readonly totalChunks: number;
  readonly fileHash: number;
  readonly metadataBytes: Uint8Array;
  nextChunkIndex: number;
  bytesSent: number;
  cancelled: boolean;
}

interface IncomingAssembly {
  readonly transferId: number;
  readonly kind: BulkAssetKind;
  readonly totalChunks: number;
  readonly totalBytes: number;
  readonly expectedFileHash: number;
  readonly chunks: (Uint8Array | null)[];
  receivedChunks: number;
  receivedBytes: number;
  metadata: BulkAssetMetadata | null;
}

export class BulkAssetChannel {
  private readonly chunkSizeBytes: number;
  private readonly highWaterMarkBytes: number;
  private readonly lowWaterMarkBytes: number;
  private readonly maxChunksPerPump: number;
  private readonly utf8Encoder = new TextEncoder();
  private readonly utf8Decoder = new TextDecoder();

  private sink: BulkAssetTransportSink | null;
  private nextTransferId = 1;
  private readonly outgoingQueue: OutgoingTransfer[] = [];
  private readonly awaitingAck = new Map<number, { fileHash: number }>();
  private readonly incomingAssemblies = new Map<number, IncomingAssembly>();
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  public onAssetReceived: ((asset: ReceivedBulkAsset) => void) | null = null;
  public onProgress: ((progress: BulkTransferProgress) => void) | null = null;
  public onTransferAcked:
    | ((event: { transferId: number; fileHash: number; fileHashHex: string }) => void)
    | null = null;
  public onTransferError: ((event: BulkTransferError) => void) | null = null;

  public readonly stats: BulkAssetChannelStats = {
    bytesSent: 0,
    bytesReceived: 0,
    chunksSent: 0,
    chunksReceived: 0,
    backpressurePauses: 0,
    hashMismatches: 0,
    completedTransfers: 0,
  };

  constructor(options: BulkAssetChannelOptions = {}) {
    this.chunkSizeBytes = Math.max(256, options.chunkSizeBytes ?? DEFAULT_BULK_CHUNK_BYTES);
    this.highWaterMarkBytes = Math.max(
      this.chunkSizeBytes,
      options.highWaterMarkBytes ?? DEFAULT_BULK_HIGH_WATER_BYTES
    );
    this.lowWaterMarkBytes = Math.min(
      this.highWaterMarkBytes,
      Math.max(0, options.lowWaterMarkBytes ?? DEFAULT_BULK_LOW_WATER_BYTES)
    );
    this.maxChunksPerPump = Math.max(1, options.maxChunksPerPump ?? DEFAULT_MAX_CHUNKS_PER_PUMP);
    this.sink = options.sink ?? null;
  }

  setTransportSink(sink: BulkAssetTransportSink | null): void {
    this.sink = sink;
    if (sink?.isReady()) {
      this.pumpOutgoingQueue();
    }
  }

  bindDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    try {
      dc.bufferedAmountLowThreshold = this.lowWaterMarkBytes;
    } catch {
      // Ignore if environment mock does not support bufferedAmountLowThreshold
    }
    dc.onbufferedamountlow = () => {
      this.notifyBufferedAmountLow();
    };
    this.setTransportSink({
      sendFrame: (frame) => {
        if (dc.readyState !== 'open') return false;
        dc.send(frame as unknown as ArrayBuffer);
        return true;
      },
      getBufferedAmount: () => dc.bufferedAmount,
      isReady: () => dc.readyState === 'open',
    });
  }

  notifyBufferedAmountLow(): void {
    this.pumpOutgoingQueue();
  }

  getPendingOutgoingCount(): number {
    return this.outgoingQueue.length;
  }

  isBackpressured(): boolean {
    if (!this.sink) return false;
    return this.sink.getBufferedAmount() >= this.highWaterMarkBytes;
  }

  sendAsset(
    kind: BulkAssetKind,
    payload: Uint8Array,
    metadata: BulkAssetMetadata | null = null
  ): number {
    const transferId = this.nextTransferId++ >>> 0;
    const fileHash = computeBulkFileHash(payload);
    const metadataBytes = metadata ? this.utf8Encoder.encode(JSON.stringify(metadata)) : new Uint8Array(0);
    const totalChunks = Math.max(1, Math.ceil(payload.byteLength / this.chunkSizeBytes));

    this.outgoingQueue.push({
      transferId,
      kind,
      payload,
      totalBytes: payload.byteLength,
      totalChunks,
      fileHash,
      metadataBytes,
      nextChunkIndex: 0,
      bytesSent: 0,
      cancelled: false,
    });

    this.pumpOutgoingQueue();
    return transferId;
  }

  sendRewinderSlice(payload: Uint8Array, metadata: RewinderSliceBulkMetadata): number {
    return this.sendAsset('rewinder_slice', payload, metadata);
  }

  sendGhostTrajectory(payload: Uint8Array, metadata: GhostTrajectoryBulkMetadata): number {
    return this.sendAsset('ghost_trajectory', payload, metadata);
  }

  sendReplayFile(payload: Uint8Array, metadata: ReplayFileBulkMetadata): number {
    return this.sendAsset('replay_file', payload, metadata);
  }

  sendTrainingPack(payload: Uint8Array, metadata: TrainingPackBulkMetadata): number {
    return this.sendAsset('training_pack', payload, metadata);
  }

  cancelTransfer(transferId: number): boolean {
    const idx = this.outgoingQueue.findIndex((t) => t.transferId === transferId);
    if (idx !== -1) {
      const [removed] = this.outgoingQueue.splice(idx, 1);
      removed.cancelled = true;
      if (this.sink?.isReady()) {
        this.sink.sendFrame(encodeBulkControlFrame(BULK_FRAME_TYPES.CANCEL, transferId, removed.fileHash));
      }
      this.onTransferError?.({ transferId, reason: 'cancelled' });
      return true;
    }
    if (this.incomingAssemblies.delete(transferId)) {
      this.onTransferError?.({ transferId, reason: 'cancelled' });
      return true;
    }
    return false;
  }

  pumpOutgoingQueue(): number {
    this.clearPumpTimer();
    if (!this.sink || !this.sink.isReady() || this.outgoingQueue.length === 0) {
      return 0;
    }

    let chunksDispatched = 0;
    while (this.outgoingQueue.length > 0 && chunksDispatched < this.maxChunksPerPump) {
      if (this.sink.getBufferedAmount() >= this.highWaterMarkBytes) {
        this.stats.backpressurePauses++;
        this.schedulePumpRetry();
        break;
      }

      const current = this.outgoingQueue[0];
      if (current.cancelled) {
        this.outgoingQueue.shift();
        continue;
      }

      const start = current.nextChunkIndex * this.chunkSizeBytes;
      const end = Math.min(current.totalBytes, start + this.chunkSizeBytes);
      const chunkPayload = current.payload.subarray(start, end);
      const frame = encodeBulkChunkFrame({
        transferId: current.transferId,
        assetKind: current.kind,
        chunkIndex: current.nextChunkIndex,
        totalChunks: current.totalChunks,
        totalBytes: current.totalBytes,
        fileHash: current.fileHash,
        metadataBytes: current.nextChunkIndex === 0 ? current.metadataBytes : undefined,
        payload: chunkPayload,
      });

      if (!this.sink.sendFrame(frame)) {
        this.schedulePumpRetry();
        break;
      }

      chunksDispatched++;
      this.stats.chunksSent++;
      this.stats.bytesSent += chunkPayload.byteLength;
      current.nextChunkIndex++;
      current.bytesSent += chunkPayload.byteLength;

      this.onProgress?.({
        direction: 'send',
        transferId: current.transferId,
        kind: current.kind,
        completedChunks: current.nextChunkIndex,
        totalChunks: current.totalChunks,
        bytesTransferred: current.bytesSent,
        totalBytes: current.totalBytes,
      });

      if (current.nextChunkIndex >= current.totalChunks) {
        this.awaitingAck.set(current.transferId, { fileHash: current.fileHash });
        this.outgoingQueue.shift();
      }
    }

    if (this.outgoingQueue.length > 0 && !this.pumpTimer) {
      this.schedulePumpRetry();
    }
    return chunksDispatched;
  }

  handleIncomingFrame(raw: Uint8Array | ArrayBuffer | DataView): boolean {
    const decoded = decodeBulkAssetFrame(raw);
    if (!decoded) return false;

    if (decoded.frameType === BULK_FRAME_TYPES.COMPLETE_ACK) {
      this.awaitingAck.delete(decoded.transferId);
      this.stats.completedTransfers++;
      this.onTransferAcked?.({
        transferId: decoded.transferId,
        fileHash: decoded.fileHash,
        fileHashHex: formatBulkFileHashHex(decoded.fileHash),
      });
      return true;
    }

    if (decoded.frameType === BULK_FRAME_TYPES.HASH_MISMATCH_NACK) {
      const pending = this.awaitingAck.get(decoded.transferId);
      this.awaitingAck.delete(decoded.transferId);
      this.stats.hashMismatches++;
      this.onTransferError?.({
        transferId: decoded.transferId,
        reason: 'hash_mismatch',
        expectedHash: pending?.fileHash,
        actualHash: decoded.fileHash,
      });
      return true;
    }

    if (decoded.frameType === BULK_FRAME_TYPES.CANCEL) {
      this.incomingAssemblies.delete(decoded.transferId);
      this.onTransferError?.({ transferId: decoded.transferId, reason: 'cancelled' });
      return true;
    }

    if (decoded.frameType === BULK_FRAME_TYPES.CHUNK) {
      return this.handleIncomingChunk(decoded);
    }
    return false;
  }

  dispose(): void {
    this.clearPumpTimer();
    this.outgoingQueue.length = 0;
    this.incomingAssemblies.clear();
    this.awaitingAck.clear();
  }

  private handleIncomingChunk(chunk: DecodedBulkChunkFrame): boolean {
    if (chunk.totalChunks === 0 || chunk.chunkIndex >= chunk.totalChunks) {
      return false;
    }

    let assembly = this.incomingAssemblies.get(chunk.transferId);
    if (!assembly) {
      let metadata: BulkAssetMetadata | null = null;
      if (chunk.metadataBytes.byteLength > 0) {
        try {
          metadata = JSON.parse(this.utf8Decoder.decode(chunk.metadataBytes)) as BulkAssetMetadata;
        } catch {
          this.onTransferError?.({ transferId: chunk.transferId, reason: 'metadata_parse_error' });
          return false;
        }
      }
      assembly = {
        transferId: chunk.transferId,
        kind: chunk.assetKind,
        totalChunks: chunk.totalChunks,
        totalBytes: chunk.totalBytes,
        expectedFileHash: chunk.fileHash,
        chunks: new Array<Uint8Array | null>(chunk.totalChunks).fill(null),
        receivedChunks: 0,
        receivedBytes: 0,
        metadata,
      };
      this.incomingAssemblies.set(chunk.transferId, assembly);
    }

    if (assembly.chunks[chunk.chunkIndex] === null) {
      assembly.chunks[chunk.chunkIndex] = new Uint8Array(chunk.payload);
      assembly.receivedChunks++;
      assembly.receivedBytes += chunk.payload.byteLength;
      this.stats.chunksReceived++;
      this.stats.bytesReceived += chunk.payload.byteLength;

      this.onProgress?.({
        direction: 'receive',
        transferId: assembly.transferId,
        kind: assembly.kind,
        completedChunks: assembly.receivedChunks,
        totalChunks: assembly.totalChunks,
        bytesTransferred: assembly.receivedBytes,
        totalBytes: assembly.totalBytes,
      });
    }

    if (assembly.receivedChunks === assembly.totalChunks) {
      this.finalizeAssembly(assembly);
    }
    return true;
  }

  private finalizeAssembly(assembly: IncomingAssembly): void {
    this.incomingAssemblies.delete(assembly.transferId);

    if (assembly.receivedBytes !== assembly.totalBytes) {
      this.sink?.sendFrame(
        encodeBulkControlFrame(
          BULK_FRAME_TYPES.HASH_MISMATCH_NACK,
          assembly.transferId,
          assembly.expectedFileHash,
          1
        )
      );
      this.onTransferError?.({ transferId: assembly.transferId, reason: 'size_mismatch' });
      return;
    }

    const assembled = new Uint8Array(assembly.totalBytes);
    let offset = 0;
    for (const part of assembly.chunks) {
      if (!part) continue;
      assembled.set(part, offset);
      offset += part.byteLength;
    }

    const actualHash = computeBulkFileHash(assembled);
    if (actualHash !== assembly.expectedFileHash) {
      this.stats.hashMismatches++;
      this.sink?.sendFrame(
        encodeBulkControlFrame(BULK_FRAME_TYPES.HASH_MISMATCH_NACK, assembly.transferId, actualHash, 2)
      );
      this.onTransferError?.({
        transferId: assembly.transferId,
        reason: 'hash_mismatch',
        expectedHash: assembly.expectedFileHash,
        actualHash,
      });
      return;
    }

    this.stats.completedTransfers++;
    this.sink?.sendFrame(
      encodeBulkControlFrame(BULK_FRAME_TYPES.COMPLETE_ACK, assembly.transferId, actualHash, 0)
    );
    this.onAssetReceived?.({
      transferId: assembly.transferId,
      kind: assembly.kind,
      payload: assembled,
      fileHash: actualHash,
      fileHashHex: formatBulkFileHashHex(actualHash),
      metadata: assembly.metadata,
    });
  }

  private schedulePumpRetry(): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pumpOutgoingQueue();
    }, 16);
  }

  private clearPumpTimer(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
  }
}
