/**
 * bulkAssetAssemblyPipeline.ts
 * Pure inbound chunk assembly, validation, and 64-bit fileHash verification
 * for Channel 4 (BulkAssetChannel).
 */

import {
  BULK_ABORT_REASONS,
  BULK_FRAME_TYPES,
  computeBulkFileHash64,
  encodeBulkFrame,
  type BulkAbortReasonCode,
  type BulkAssetKind,
  type BulkAssetManifestMeta,
  type BulkAssetReceivedEvent,
  type BulkAssetTransferProgress,
  type BulkFileHash64,
  type DecodedBulkFrame,
} from '../../protocol/BulkAssetProtocol.ts';

export interface InboundAssemblyState {
  transferId: number;
  assetKind: BulkAssetKind;
  totalBytes: number;
  totalChunks: number;
  fileHash: BulkFileHash64;
  meta: BulkAssetManifestMeta;
  chunks: Array<Uint8Array | null>;
  receivedChunks: number;
  receivedBytes: number;
}

export type InboundAssemblyOutcome =
  | { kind: 'accepted'; progress?: BulkAssetTransferProgress }
  | { kind: 'completed'; event: BulkAssetReceivedEvent; ackFrame: Uint8Array }
  | { kind: 'error'; reasonCode: BulkAbortReasonCode; message: string; abortFrame: Uint8Array }
  | { kind: 'ignored' };

export function createInboundAssembly(
  frame: DecodedBulkFrame,
  maxAssetBytes: number
): { state: InboundAssemblyState | null; abortFrame: Uint8Array | null } {
  if (frame.totalBytes > maxAssetBytes) {
    return {
      state: null,
      abortFrame: encodeBulkFrame({
        frameType: BULK_FRAME_TYPES.ABORT,
        assetKind: frame.assetKind,
        transferId: frame.transferId,
        seqOrChunkIndex: BULK_ABORT_REASONS.SIZE_LIMIT_EXCEEDED,
        totalBytes: 0,
        fileHash: frame.fileHash,
      }),
    };
  }
  const totalChunks = Math.max(1, frame.seqOrChunkIndex);
  return {
    state: {
      transferId: frame.transferId,
      assetKind: frame.assetKind,
      totalBytes: frame.totalBytes,
      totalChunks,
      fileHash: frame.fileHash,
      meta: frame.meta ?? {},
      chunks: new Array<Uint8Array | null>(totalChunks).fill(null),
      receivedChunks: 0,
      receivedBytes: 0,
    },
    abortFrame: null,
  };
}

export function applyChunkToAssembly(
  assembly: InboundAssemblyState,
  frame: DecodedBulkFrame
): InboundAssemblyOutcome {
  const idx = frame.seqOrChunkIndex;
  if (idx < 0 || idx >= assembly.totalChunks || assembly.chunks[idx] !== null) {
    return { kind: 'ignored' };
  }

  const copy = new Uint8Array(frame.body.byteLength);
  copy.set(frame.body);
  assembly.chunks[idx] = copy;
  assembly.receivedChunks++;
  assembly.receivedBytes += copy.byteLength;

  const progress: BulkAssetTransferProgress = {
    transferId: assembly.transferId,
    direction: 'inbound',
    assetKind: assembly.assetKind,
    completedChunks: assembly.receivedChunks,
    totalChunks: assembly.totalChunks,
    transferredBytes: assembly.receivedBytes,
    totalBytes: assembly.totalBytes,
    fileHashHex: assembly.fileHash.hex,
    bufferedAmountBytes: 0,
    throttled: false,
  };

  if (assembly.receivedChunks < assembly.totalChunks) {
    return { kind: 'accepted', progress };
  }

  const assembled = new Uint8Array(assembly.totalBytes);
  let offset = 0;
  for (let i = 0; i < assembly.totalChunks; i++) {
    const chunk = assembly.chunks[i];
    if (!chunk || offset + chunk.byteLength > assembled.byteLength) {
      return {
        kind: 'error',
        reasonCode: BULK_ABORT_REASONS.INVALID_FRAME,
        message: `Invalid chunk layout for transfer ${assembly.transferId}`,
        abortFrame: encodeBulkFrame({
          frameType: BULK_FRAME_TYPES.ABORT,
          assetKind: assembly.assetKind,
          transferId: assembly.transferId,
          seqOrChunkIndex: BULK_ABORT_REASONS.INVALID_FRAME,
          totalBytes: 0,
          fileHash: assembly.fileHash,
        }),
      };
    }
    assembled.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const actualHash = computeBulkFileHash64(assembled);
  if (actualHash.hex !== assembly.fileHash.hex) {
    return {
      kind: 'error',
      reasonCode: BULK_ABORT_REASONS.HASH_MISMATCH,
      message: `fileHash mismatch for transfer ${assembly.transferId}: expected=${assembly.fileHash.hex} actual=${actualHash.hex}`,
      abortFrame: encodeBulkFrame({
        frameType: BULK_FRAME_TYPES.ABORT,
        assetKind: assembly.assetKind,
        transferId: assembly.transferId,
        seqOrChunkIndex: BULK_ABORT_REASONS.HASH_MISMATCH,
        totalBytes: 0,
        fileHash: actualHash,
      }),
    };
  }

  const ackFrame = encodeBulkFrame({
    frameType: BULK_FRAME_TYPES.COMPLETE_ACK,
    assetKind: assembly.assetKind,
    transferId: assembly.transferId,
    seqOrChunkIndex: assembly.totalChunks,
    totalBytes: assembly.totalBytes,
    fileHash: actualHash,
  });

  return {
    kind: 'completed',
    ackFrame,
    event: {
      transferId: assembly.transferId,
      assetKind: assembly.assetKind,
      fileHashHex: actualHash.hex,
      totalBytes: assembly.totalBytes,
      payload: assembled,
      meta: assembly.meta,
    },
  };
}
