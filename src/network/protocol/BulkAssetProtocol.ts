/**
 * BulkAssetProtocol.ts
 * Wave 1 Channel 4 (Bulk / Asset Large-File Stream) binary wire protocol & temporary TS interfaces.
 * Physically isolated from Channels 1/2/3 to prevent Head-of-Line Blocking.
 */

export const BULK_FRAME_MAGIC = 0x424b; // 'BK'
export const BULK_HEADER_BYTES = 32;
export const BULK_DEFAULT_CHUNK_BYTES = 16 * 1024; // 16 KiB safe WebRTC DataChannel chunk

export const BULK_FRAME_TYPES = {
  MANIFEST: 1,
  CHUNK: 2,
  COMPLETE_ACK: 3,
  ABORT: 4,
} as const;

export type BulkFrameType = (typeof BULK_FRAME_TYPES)[keyof typeof BULK_FRAME_TYPES];

export const BULK_ASSET_KIND_CODES = {
  rewinder_slice: 1,
  ghost_trajectory: 2,
  replay_file: 3,
  training_pack: 4,
} as const;

export type BulkAssetKind = keyof typeof BULK_ASSET_KIND_CODES;

export const BULK_ABORT_REASONS = {
  CANCELLED: 1,
  HASH_MISMATCH: 2,
  TIMEOUT: 3,
  SIZE_LIMIT_EXCEEDED: 4,
  INVALID_FRAME: 5,
} as const;

export type BulkAbortReasonCode = (typeof BULK_ABORT_REASONS)[keyof typeof BULK_ABORT_REASONS];

export interface BulkFileHash64 {
  hi: number;
  lo: number;
  hex: string;
}

export interface BulkAssetManifestMeta {
  fileName?: string;
  mimeType?: string;
  roomId?: string;
  startFrame?: number;
  endFrame?: number;
  cursor?: number;
  tickRate?: number;
  frameCount?: number;
  carIndex?: number;
  durationSec?: number;
  extra?: Record<string, string | number | boolean>;
}

export interface DecodedBulkFrame {
  frameType: BulkFrameType;
  assetKind: BulkAssetKind;
  transferId: number;
  seqOrChunkIndex: number;
  totalBytes: number;
  fileHash: BulkFileHash64;
  chunkSizeOrReserved: number;
  body: Uint8Array;
  meta: BulkAssetManifestMeta | null;
}

export interface BulkAssetTransferProgress {
  transferId: number;
  direction: 'outbound' | 'inbound';
  assetKind: BulkAssetKind;
  completedChunks: number;
  totalChunks: number;
  transferredBytes: number;
  totalBytes: number;
  fileHashHex: string;
  bufferedAmountBytes: number;
  throttled: boolean;
}

export interface BulkAssetReceivedEvent {
  transferId: number;
  assetKind: BulkAssetKind;
  fileHashHex: string;
  totalBytes: number;
  payload: Uint8Array;
  meta: BulkAssetManifestMeta;
}

/**
 * Reserved Wave 1 payload descriptor for Ghost Car trajectory pre-distribution (Channel 4).
 */
export interface GhostTrajectoryBulkDescriptor {
  carIndex: number;
  playerName: string;
  tickRate: number;
  frameCount: number;
  trajectoryBytes: Uint8Array;
}

/**
 * Reserved Wave 1 payload descriptor for .rlrc / .rcreplay.gz pre-distribution (Channel 4).
 */
export interface ReplayFileBulkDescriptor {
  fileName: string;
  tickRate: number;
  frameCount: number;
  durationSec: number;
  compressedBytes: Uint8Array;
}

const CODE_TO_ASSET_KIND: Record<number, BulkAssetKind> = {
  1: 'rewinder_slice',
  2: 'ghost_trajectory',
  3: 'replay_file',
  4: 'training_pack',
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Computes a deterministic 64-bit FNV-1a hash (split into hi/lo Uint32 + 16-char hex).
 */
export function computeBulkFileHash64(data: Uint8Array): BulkFileHash64 {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask64 = 0xffffffffffffffffn;
  for (let i = 0; i < data.byteLength; i++) {
    hash ^= BigInt(data[i]);
    hash = (hash * prime) & mask64;
  }
  const hi = Number((hash >> 32n) & 0xffffffffn) >>> 0;
  const lo = Number(hash & 0xffffffffn) >>> 0;
  const hex = `${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
  return { hi, lo, hex };
}

export function isBulkAssetFrame(data: unknown): data is Uint8Array {
  if (!(data instanceof Uint8Array) || data.byteLength < BULK_HEADER_BYTES) {
    return false;
  }
  return data[0] === 0x42 && data[1] === 0x4b;
}

export function encodeBulkFrame(params: {
  frameType: BulkFrameType;
  assetKind: BulkAssetKind;
  transferId: number;
  seqOrChunkIndex: number;
  totalBytes: number;
  fileHash: BulkFileHash64;
  chunkSizeOrReserved?: number;
  body?: Uint8Array;
  meta?: BulkAssetManifestMeta | null;
}): Uint8Array {
  let bodyBytes = params.body;
  if (!bodyBytes && params.frameType === BULK_FRAME_TYPES.MANIFEST && params.meta) {
    bodyBytes = utf8Encoder.encode(JSON.stringify(params.meta));
  }
  const bodyLen = bodyBytes ? bodyBytes.byteLength : 0;
  const frame = new Uint8Array(BULK_HEADER_BYTES + bodyLen);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  view.setUint16(0, BULK_FRAME_MAGIC, false);
  view.setUint8(2, params.frameType);
  view.setUint8(3, BULK_ASSET_KIND_CODES[params.assetKind]);
  view.setUint32(4, params.transferId >>> 0, false);
  view.setUint32(8, params.seqOrChunkIndex >>> 0, false);
  view.setUint32(12, params.totalBytes >>> 0, false);
  view.setUint32(16, params.fileHash.hi >>> 0, false);
  view.setUint32(20, params.fileHash.lo >>> 0, false);
  view.setUint32(24, (params.chunkSizeOrReserved ?? 0) >>> 0, false);
  view.setUint32(28, bodyLen >>> 0, false);

  if (bodyBytes && bodyLen > 0) {
    frame.set(bodyBytes, BULK_HEADER_BYTES);
  }
  return frame;
}

export function decodeBulkFrame(data: Uint8Array): DecodedBulkFrame | null {
  if (!isBulkAssetFrame(data)) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const frameType = view.getUint8(2) as BulkFrameType;
  const kindCode = view.getUint8(3);
  const assetKind = CODE_TO_ASSET_KIND[kindCode];
  if (!assetKind) {
    return null;
  }
  const transferId = view.getUint32(4, false);
  const seqOrChunkIndex = view.getUint32(8, false);
  const totalBytes = view.getUint32(12, false);
  const hi = view.getUint32(16, false);
  const lo = view.getUint32(20, false);
  const chunkSizeOrReserved = view.getUint32(24, false);
  const bodyLen = view.getUint32(28, false);

  if (BULK_HEADER_BYTES + bodyLen > data.byteLength) {
    return null;
  }

  const body = data.subarray(BULK_HEADER_BYTES, BULK_HEADER_BYTES + bodyLen);
  let meta: BulkAssetManifestMeta | null = null;
  if (frameType === BULK_FRAME_TYPES.MANIFEST && bodyLen > 0) {
    try {
      const parsed = JSON.parse(utf8Decoder.decode(body)) as unknown;
      if (parsed && typeof parsed === 'object') {
        meta = parsed as BulkAssetManifestMeta;
      }
    } catch {
      return null;
    }
  }

  const hex = `${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
  return {
    frameType,
    assetKind,
    transferId,
    seqOrChunkIndex,
    totalBytes,
    fileHash: { hi, lo, hex },
    chunkSizeOrReserved,
    body,
    meta,
  };
}
