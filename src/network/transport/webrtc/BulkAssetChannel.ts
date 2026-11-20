/**
 * BulkAssetChannel.ts
 * Channel 4 (Bulk / Asset Large-File Stream) reliable chunked transport with
 * 64-bit FNV-1a fileHash verification and RTCDataChannel bufferedAmount backpressure throttling.
 */

import {
  BULK_ABORT_REASONS,
  BULK_DEFAULT_CHUNK_BYTES,
  BULK_FRAME_TYPES,
  computeBulkFileHash64,
  decodeBulkFrame,
  encodeBulkFrame,
  isBulkAssetFrame,
  type BulkAbortReasonCode,
  type BulkAssetKind,
  type BulkAssetManifestMeta,
  type BulkAssetReceivedEvent,
  type BulkAssetTransferProgress,
  type BulkFileHash64,
  type DecodedBulkFrame,
  type GhostTrajectoryBulkDescriptor,
  type ReplayFileBulkDescriptor,
} from '../../protocol/BulkAssetProtocol.ts';
import {
  applyChunkToAssembly,
  createInboundAssembly,
  type InboundAssemblyState,
} from './bulkAssetAssemblyPipeline.ts';

export const BULK_DEFAULT_HIGH_WATER_MARK_BYTES = 256 * 1024;
export const BULK_DEFAULT_LOW_WATER_MARK_BYTES = 64 * 1024;
export const BULK_DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const BULK_DEFAULT_MAX_CHUNKS_PER_BURST = 8;

export interface BulkRawTransportPort {
  isOpen: () => boolean;
  sendBytes: (bytes: Uint8Array) => boolean;
  getBufferedAmount: () => number;
  setBufferedAmountLowThreshold?: (bytes: number) => void;
  onBufferedAmountLow?: (cb: (() => void) | null) => void;
}

export interface BulkAssetChannelOptions {
  chunkBytes?: number;
  highWaterMarkBytes?: number;
  lowWaterMarkBytes?: number;
  maxAssetBytes?: number;
  maxChunksPerBurst?: number;
  ackTimeoutMs?: number;
  backpressurePollMs?: number;
}

export interface BulkSendAssetOptions {
  assetKind: BulkAssetKind;
  payload: Uint8Array;
  meta?: BulkAssetManifestMeta;
  awaitAck?: boolean;
  chunkBytes?: number;
}

export interface BulkOutboundTransferResult {
  transferId: number;
  fileHashHex: string;
  totalBytes: number;
  totalChunks: number;
  acknowledged: boolean;
}

export interface BulkAssetTransferError {
  transferId: number;
  assetKind: BulkAssetKind;
  reasonCode: BulkAbortReasonCode;
  message: string;
}

interface OutboundTransferState {
  transferId: number;
  assetKind: BulkAssetKind;
  payload: Uint8Array;
  fileHash: BulkFileHash64;
  chunkBytes: number;
  totalChunks: number;
  nextChunkIndex: number;
  sentBytes: number;
  awaitAck: boolean;
  manifestSent: boolean;
  aborted: boolean;
  resolve: (res: BulkOutboundTransferResult) => void;
  reject: (err: Error) => void;
  ackTimer: ReturnType<typeof setTimeout> | null;
}

export class BulkAssetChannel {
  private readonly chunkBytes: number;
  private readonly highWaterMarkBytes: number;
  private readonly lowWaterMarkBytes: number;
  private readonly maxAssetBytes: number;
  private readonly maxChunksPerBurst: number;
  private readonly ackTimeoutMs: number;
  private readonly backpressurePollMs: number;

  private dataChannel: RTCDataChannel | null = null;
  private customPort: BulkRawTransportPort | null = null;
  private nextTransferId = 1;
  private pumpScheduled = false;
  private backpressureWaitTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly outboundQueue: OutboundTransferState[] = [];
  private readonly pendingManifestMeta = new Map<number, BulkAssetManifestMeta>();
  private readonly awaitingAck = new Map<number, OutboundTransferState>();
  private readonly inboundAssemblies = new Map<number, InboundAssemblyState>();

  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  onProgress: ((progress: BulkAssetTransferProgress) => void) | null = null;
  onAssetReceived: ((event: BulkAssetReceivedEvent) => void) | null = null;
  onTransferError: ((err: BulkAssetTransferError) => void) | null = null;

  constructor(options: BulkAssetChannelOptions = {}) {
    this.chunkBytes = Math.max(512, options.chunkBytes ?? BULK_DEFAULT_CHUNK_BYTES);
    this.highWaterMarkBytes = options.highWaterMarkBytes ?? BULK_DEFAULT_HIGH_WATER_MARK_BYTES;
    this.lowWaterMarkBytes = Math.min(
      this.highWaterMarkBytes,
      options.lowWaterMarkBytes ?? BULK_DEFAULT_LOW_WATER_MARK_BYTES
    );
    this.maxAssetBytes = options.maxAssetBytes ?? BULK_DEFAULT_MAX_ASSET_BYTES;
    this.maxChunksPerBurst = Math.max(
      1,
      options.maxChunksPerBurst ?? BULK_DEFAULT_MAX_CHUNKS_PER_BURST
    );
    this.ackTimeoutMs = options.ackTimeoutMs ?? 15000;
    this.backpressurePollMs = options.backpressurePollMs ?? 16;
  }

  get isOpen(): boolean {
    if (this.customPort) return this.customPort.isOpen();
    return Boolean(this.dataChannel && this.dataChannel.readyState === 'open');
  }

  get bufferedAmount(): number {
    if (this.customPort) return this.customPort.getBufferedAmount();
    return this.dataChannel ? this.dataChannel.bufferedAmount : 0;
  }

  attachTransportPort(port: BulkRawTransportPort | null): void {
    this.customPort = port;
    if (port) {
      port.setBufferedAmountLowThreshold?.(this.lowWaterMarkBytes);
      port.onBufferedAmountLow?.(() => this.schedulePump());
    }
  }

  bindDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this.lowWaterMarkBytes;
    channel.onbufferedamountlow = () => this.schedulePump();
    channel.onopen = () => {
      this.onOpen?.();
      this.schedulePump();
    };
    channel.onclose = () => {
      this.onClose?.();
    };
    channel.onerror = (err) => {
      console.error('[BulkAssetChannel] DataChannel error:', err);
    };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      this.handleIncomingRaw(event.data);
    };
  }

  handleIncomingRaw(data: unknown): boolean {
    let bytes: Uint8Array | null = null;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    }
    if (!bytes || !isBulkAssetFrame(bytes)) {
      return false;
    }
    const frame = decodeBulkFrame(bytes);
    if (!frame) {
      return false;
    }

    switch (frame.frameType) {
      case BULK_FRAME_TYPES.MANIFEST:
        this.handleManifestFrame(frame);
        return true;
      case BULK_FRAME_TYPES.CHUNK:
        this.handleChunkFrame(frame);
        return true;
      case BULK_FRAME_TYPES.COMPLETE_ACK:
        this.handleCompleteAckFrame(frame);
        return true;
      case BULK_FRAME_TYPES.ABORT:
        this.handleAbortFrame(frame);
        return true;
      default:
        return false;
    }
  }

  sendAsset(options: BulkSendAssetOptions): Promise<BulkOutboundTransferResult> {
    const payload = options.payload;
    if (payload.byteLength > this.maxAssetBytes) {
      return Promise.reject(
        new Error(
          `[BulkAssetChannel] Asset size ${payload.byteLength} exceeds maxAssetBytes ${this.maxAssetBytes}`
        )
      );
    }
    const transferId = this.nextTransferId++ >>> 0;
    const chunkBytes = Math.max(512, options.chunkBytes ?? this.chunkBytes);
    const totalChunks = Math.max(1, Math.ceil(payload.byteLength / chunkBytes));
    const fileHash = computeBulkFileHash64(payload);
    const awaitAck = options.awaitAck ?? true;

    return new Promise<BulkOutboundTransferResult>((resolve, reject) => {
      const state: OutboundTransferState = {
        transferId,
        assetKind: options.assetKind,
        payload,
        fileHash,
        chunkBytes,
        totalChunks,
        nextChunkIndex: 0,
        sentBytes: 0,
        awaitAck,
        manifestSent: false,
        aborted: false,
        resolve,
        reject,
        ackTimer: null,
      };
      this.pendingManifestMeta.set(transferId, options.meta ?? {});
      this.outboundQueue.push(state);
      this.schedulePump();
    });
  }

  sendRewinderSlice(
    sliceBytes: Uint8Array,
    meta: BulkAssetManifestMeta,
    awaitAck = true
  ): Promise<BulkOutboundTransferResult> {
    return this.sendAsset({
      assetKind: 'rewinder_slice',
      payload: sliceBytes,
      meta,
      awaitAck,
    });
  }

  sendGhostTrajectory(
    descriptor: GhostTrajectoryBulkDescriptor,
    awaitAck = true
  ): Promise<BulkOutboundTransferResult> {
    return this.sendAsset({
      assetKind: 'ghost_trajectory',
      payload: descriptor.trajectoryBytes,
      meta: {
        carIndex: descriptor.carIndex,
        fileName: `${descriptor.playerName}-ghost.rcghost`,
        tickRate: descriptor.tickRate,
        frameCount: descriptor.frameCount,
      },
      awaitAck,
    });
  }

  sendReplayFile(
    descriptor: ReplayFileBulkDescriptor,
    awaitAck = true
  ): Promise<BulkOutboundTransferResult> {
    return this.sendAsset({
      assetKind: 'replay_file',
      payload: descriptor.compressedBytes,
      meta: {
        fileName: descriptor.fileName,
        tickRate: descriptor.tickRate,
        frameCount: descriptor.frameCount,
        durationSec: descriptor.durationSec,
      },
      awaitAck,
    });
  }

  abortTransfer(
    transferId: number,
    reasonCode: BulkAbortReasonCode = BULK_ABORT_REASONS.CANCELLED
  ): void {
    const qIdx = this.outboundQueue.findIndex((t) => t.transferId === transferId);
    if (qIdx >= 0) {
      const [item] = this.outboundQueue.splice(qIdx, 1);
      item.aborted = true;
      this.pendingManifestMeta.delete(transferId);
      this.sendAbortFrame(item.assetKind, transferId, reasonCode, item.fileHash);
      item.reject(new Error(`Bulk transfer ${transferId} aborted (reason=${reasonCode})`));
    }
    const ackItem = this.awaitingAck.get(transferId);
    if (ackItem) {
      this.awaitingAck.delete(transferId);
      if (ackItem.ackTimer) clearTimeout(ackItem.ackTimer);
      ackItem.aborted = true;
      this.sendAbortFrame(ackItem.assetKind, transferId, reasonCode, ackItem.fileHash);
      ackItem.reject(new Error(`Bulk transfer ${transferId} aborted (reason=${reasonCode})`));
    }
    this.inboundAssemblies.delete(transferId);
  }

  dispose(): void {
    if (this.backpressureWaitTimer) {
      clearTimeout(this.backpressureWaitTimer);
      this.backpressureWaitTimer = null;
    }
    while (this.outboundQueue.length > 0) {
      const item = this.outboundQueue.shift();
      if (item) {
        item.aborted = true;
        item.reject(new Error('BulkAssetChannel disposed'));
      }
    }
    for (const item of this.awaitingAck.values()) {
      if (item.ackTimer) clearTimeout(item.ackTimer);
      item.reject(new Error('BulkAssetChannel disposed'));
    }
    this.awaitingAck.clear();
    this.inboundAssemblies.clear();
    this.pendingManifestMeta.clear();
  }

  private sendRawBytes(bytes: Uint8Array): boolean {
    if (this.customPort) {
      if (!this.customPort.isOpen()) return false;
      return this.customPort.sendBytes(bytes);
    }
    const dc = this.dataChannel;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      dc.send(copy.buffer);
      return true;
    } catch {
      return false;
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.outboundQueue.length === 0) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pumpOutboundQueue();
    });
  }

  private pumpOutboundQueue(): void {
    if (!this.isOpen || this.outboundQueue.length === 0) {
      return;
    }

    let chunksSentThisBurst = 0;
    while (this.outboundQueue.length > 0 && chunksSentThisBurst < this.maxChunksPerBurst) {
      const buffered = this.bufferedAmount;
      if (buffered >= this.highWaterMarkBytes) {
        const current = this.outboundQueue[0];
        this.emitProgress(current, buffered, true);
        this.scheduleBackpressureRetry();
        return;
      }

      const current = this.outboundQueue[0];
      if (!current.manifestSent) {
        const meta = this.pendingManifestMeta.get(current.transferId) ?? {};
        const manifestFrame = encodeBulkFrame({
          frameType: BULK_FRAME_TYPES.MANIFEST,
          assetKind: current.assetKind,
          transferId: current.transferId,
          seqOrChunkIndex: current.totalChunks,
          totalBytes: current.payload.byteLength,
          fileHash: current.fileHash,
          chunkSizeOrReserved: current.chunkBytes,
          meta,
        });
        if (!this.sendRawBytes(manifestFrame)) {
          this.scheduleBackpressureRetry();
          return;
        }
        current.manifestSent = true;
        this.pendingManifestMeta.delete(current.transferId);
      }

      const idx = current.nextChunkIndex;
      const start = idx * current.chunkBytes;
      const end = Math.min(current.payload.byteLength, start + current.chunkBytes);
      const slice = current.payload.subarray(start, end);
      const chunkFrame = encodeBulkFrame({
        frameType: BULK_FRAME_TYPES.CHUNK,
        assetKind: current.assetKind,
        transferId: current.transferId,
        seqOrChunkIndex: idx,
        totalBytes: slice.byteLength,
        fileHash: current.fileHash,
        chunkSizeOrReserved: start,
        body: slice,
      });

      if (!this.sendRawBytes(chunkFrame)) {
        this.scheduleBackpressureRetry();
        return;
      }

      current.nextChunkIndex++;
      current.sentBytes += slice.byteLength;
      chunksSentThisBurst++;
      this.emitProgress(current, this.bufferedAmount, false);

      if (current.nextChunkIndex >= current.totalChunks) {
        this.outboundQueue.shift();
        this.finishOutboundSend(current);
      }
    }

    if (this.outboundQueue.length > 0) {
      this.scheduleBackpressureRetry();
    }
  }

  private scheduleBackpressureRetry(): void {
    if (this.backpressureWaitTimer) return;
    this.backpressureWaitTimer = setTimeout(() => {
      this.backpressureWaitTimer = null;
      this.pumpOutboundQueue();
    }, this.backpressurePollMs);
  }

  private finishOutboundSend(state: OutboundTransferState): void {
    if (!state.awaitAck) {
      state.resolve({
        transferId: state.transferId,
        fileHashHex: state.fileHash.hex,
        totalBytes: state.payload.byteLength,
        totalChunks: state.totalChunks,
        acknowledged: false,
      });
      return;
    }

    this.awaitingAck.set(state.transferId, state);
    state.ackTimer = setTimeout(() => {
      if (!this.awaitingAck.has(state.transferId)) return;
      this.awaitingAck.delete(state.transferId);
      const msg = `Bulk transfer ${state.transferId} timed out waiting for COMPLETE_ACK`;
      this.onTransferError?.({
        transferId: state.transferId,
        assetKind: state.assetKind,
        reasonCode: BULK_ABORT_REASONS.TIMEOUT,
        message: msg,
      });
      state.reject(new Error(msg));
    }, this.ackTimeoutMs);
  }

  private handleManifestFrame(frame: DecodedBulkFrame): void {
    const { state, abortFrame } = createInboundAssembly(frame, this.maxAssetBytes);
    if (abortFrame) {
      this.sendRawBytes(abortFrame);
      return;
    }
    if (state) {
      this.inboundAssemblies.set(frame.transferId, state);
    }
  }

  private handleChunkFrame(frame: DecodedBulkFrame): void {
    const assembly = this.inboundAssemblies.get(frame.transferId);
    if (!assembly) return;

    const outcome = applyChunkToAssembly(assembly, frame);
    if (outcome.kind === 'ignored') return;
    if (outcome.kind === 'accepted') {
      if (outcome.progress) this.onProgress?.(outcome.progress);
      return;
    }

    this.inboundAssemblies.delete(frame.transferId);
    if (outcome.kind === 'error') {
      this.sendRawBytes(outcome.abortFrame);
      this.onTransferError?.({
        transferId: frame.transferId,
        assetKind: frame.assetKind,
        reasonCode: outcome.reasonCode,
        message: outcome.message,
      });
      return;
    }

    this.sendRawBytes(outcome.ackFrame);
    this.onAssetReceived?.(outcome.event);
  }

  private handleCompleteAckFrame(frame: DecodedBulkFrame): void {
    const pending = this.awaitingAck.get(frame.transferId);
    if (!pending) return;
    this.awaitingAck.delete(frame.transferId);
    if (pending.ackTimer) clearTimeout(pending.ackTimer);

    if (frame.fileHash.hex !== pending.fileHash.hex) {
      pending.reject(
        new Error(
          `COMPLETE_ACK hash mismatch for transfer ${pending.transferId}: expected=${pending.fileHash.hex} ack=${frame.fileHash.hex}`
        )
      );
      return;
    }

    pending.resolve({
      transferId: pending.transferId,
      fileHashHex: pending.fileHash.hex,
      totalBytes: pending.payload.byteLength,
      totalChunks: pending.totalChunks,
      acknowledged: true,
    });
  }

  private handleAbortFrame(frame: DecodedBulkFrame): void {
    const reasonCode = frame.seqOrChunkIndex as BulkAbortReasonCode;
    const pending = this.awaitingAck.get(frame.transferId);
    if (pending) {
      this.awaitingAck.delete(frame.transferId);
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      const msg = `Remote aborted transfer ${frame.transferId} (reason=${reasonCode})`;
      this.onTransferError?.({
        transferId: frame.transferId,
        assetKind: frame.assetKind,
        reasonCode,
        message: msg,
      });
      pending.reject(new Error(msg));
    }
    this.inboundAssemblies.delete(frame.transferId);
  }

  private sendAbortFrame(
    assetKind: BulkAssetKind,
    transferId: number,
    reasonCode: BulkAbortReasonCode,
    fileHash: BulkFileHash64
  ): void {
    const frame = encodeBulkFrame({
      frameType: BULK_FRAME_TYPES.ABORT,
      assetKind,
      transferId,
      seqOrChunkIndex: reasonCode,
      totalBytes: 0,
      fileHash,
    });
    this.sendRawBytes(frame);
  }

  private emitProgress(
    state: OutboundTransferState,
    bufferedAmountBytes: number,
    throttled: boolean
  ): void {
    this.onProgress?.({
      transferId: state.transferId,
      direction: 'outbound',
      assetKind: state.assetKind,
      completedChunks: state.nextChunkIndex,
      totalChunks: state.totalChunks,
      transferredBytes: state.sentBytes,
      totalBytes: state.payload.byteLength,
      fileHashHex: state.fileHash.hex,
      bufferedAmountBytes,
      throttled,
    });
  }
}
