/**
 * src/network/protocol/BulkAssetProtocol.ts
 * Channel 4 (Bulk / Asset) binary framing protocol:
 * - Self-describing chunk frames with 32-bit FNV-1a fileHash integrity check
 * - Control frames (COMPLETE_ACK, HASH_MISMATCH_NACK, CANCEL)
 * - Wave 1 typed metadata contracts for Rewinder slices, Ghost trajectories, Replay files, and Training packs
 */

export const BULK_FRAME_MAGIC = 0x424b; // 'BK'
export const BULK_PROTOCOL_VERSION = 1;
export const BULK_CHUNK_HEADER_BYTES = 28;
export const BULK_CONTROL_FRAME_BYTES = 13;

export const BULK_FRAME_TYPES = Object.freeze({
  CHUNK: 0x01,
  COMPLETE_ACK: 0x02,
  HASH_MISMATCH_NACK: 0x03,
  CANCEL: 0x04,
} as const);

export type BulkFrameType = (typeof BULK_FRAME_TYPES)[keyof typeof BULK_FRAME_TYPES];

export const BULK_ASSET_KINDS = Object.freeze({
  REWINDER_SLICE: 1,
  GHOST_TRAJECTORY: 2,
  REPLAY_FILE: 3,
  TRAINING_PACK: 4,
} as const);

export type BulkAssetKindCode = (typeof BULK_ASSET_KINDS)[keyof typeof BULK_ASSET_KINDS];

export type BulkAssetKind =
  | 'rewinder_slice'
  | 'ghost_trajectory'
  | 'replay_file'
  | 'training_pack';

export const BULK_ASSET_KIND_TO_CODE: Record<BulkAssetKind, BulkAssetKindCode> = {
  rewinder_slice: BULK_ASSET_KINDS.REWINDER_SLICE,
  ghost_trajectory: BULK_ASSET_KINDS.GHOST_TRAJECTORY,
  replay_file: BULK_ASSET_KINDS.REPLAY_FILE,
  training_pack: BULK_ASSET_KINDS.TRAINING_PACK,
};

export const BULK_CODE_TO_ASSET_KIND: Record<number, BulkAssetKind> = {
  [BULK_ASSET_KINDS.REWINDER_SLICE]: 'rewinder_slice',
  [BULK_ASSET_KINDS.GHOST_TRAJECTORY]: 'ghost_trajectory',
  [BULK_ASSET_KINDS.REPLAY_FILE]: 'replay_file',
  [BULK_ASSET_KINDS.TRAINING_PACK]: 'training_pack',
};

export interface RewinderSliceBulkMetadata {
  startFrame: number;
  endFrame: number;
  cursorFrame: number;
  targetFrame: number;
  frameCount: number;
  totalRewinderFrames: number;
  arenaPreset?: number;
}

export interface GhostTrajectoryBulkMetadata {
  carIndex: number;
  playerName: string;
  team: number;
  visualId?: string;
  colorHex?: string;
  startTick: number;
  endTick: number;
  tickCount: number;
  roleFlag: 'ghost';
}

export interface ReplayFileBulkMetadata {
  fileName: string;
  format: 'rcreplay' | 'rlrc';
  totalFrames: number;
  durationSeconds: number;
  arenaPreset?: number;
  schemaHash?: string;
}

export interface TrainingPackBulkMetadata {
  packId: string;
  packName: string;
  shotCount: number;
  schemaVersion: number;
}

export type BulkAssetMetadata =
  | RewinderSliceBulkMetadata
  | GhostTrajectoryBulkMetadata
  | ReplayFileBulkMetadata
  | TrainingPackBulkMetadata
  | Record<string, unknown>;

export interface BulkChunkEncodeParams {
  transferId: number;
  assetKind: BulkAssetKind;
  flags?: number;
  chunkIndex: number;
  totalChunks: number;
  totalBytes: number;
  fileHash: number;
  metadataBytes?: Uint8Array;
  payload: Uint8Array;
}

export interface DecodedBulkChunkFrame {
  readonly frameType: typeof BULK_FRAME_TYPES.CHUNK;
  readonly version: number;
  readonly transferId: number;
  readonly assetKind: BulkAssetKind;
  readonly flags: number;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly totalBytes: number;
  readonly fileHash: number;
  readonly metadataBytes: Uint8Array;
  readonly payload: Uint8Array;
}

export interface DecodedBulkControlFrame {
  readonly frameType:
    | typeof BULK_FRAME_TYPES.COMPLETE_ACK
    | typeof BULK_FRAME_TYPES.HASH_MISMATCH_NACK
    | typeof BULK_FRAME_TYPES.CANCEL;
  readonly version: number;
  readonly transferId: number;
  readonly fileHash: number;
  readonly reasonCode: number;
}

export type DecodedBulkFrame = DecodedBulkChunkFrame | DecodedBulkControlFrame;

/**
 * Deterministic 32-bit FNV-1a hash over a byte buffer.
 * Fast, synchronous, zero-dependency, suitable for browser, Worker, and Node.
 */
export function computeBulkFileHash(data: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.byteLength; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function formatBulkFileHashHex(hash: number): string {
  return `0x${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function isBulkAssetFrame(data: unknown): data is Uint8Array | ArrayBuffer {
  const bytes = toUint8Array(data);
  if (!bytes || bytes.byteLength < BULK_CONTROL_FRAME_BYTES) return false;
  return bytes[0] === 0x42 && bytes[1] === 0x4b;
}

export function encodeBulkChunkFrame(params: BulkChunkEncodeParams): Uint8Array {
  const metaLen = params.metadataBytes?.byteLength ?? 0;
  const payloadLen = params.payload.byteLength;
  const out = new Uint8Array(BULK_CHUNK_HEADER_BYTES + metaLen + payloadLen);
  const view = new DataView(out.buffer);

  view.setUint16(0, BULK_FRAME_MAGIC, false);
  view.setUint8(2, BULK_PROTOCOL_VERSION);
  view.setUint8(3, BULK_FRAME_TYPES.CHUNK);
  view.setUint32(4, params.transferId >>> 0, false);
  view.setUint8(8, BULK_ASSET_KIND_TO_CODE[params.assetKind]);
  view.setUint8(9, (params.flags ?? 0) & 0xff);
  view.setUint32(10, params.chunkIndex >>> 0, false);
  view.setUint32(14, params.totalChunks >>> 0, false);
  view.setUint32(18, params.totalBytes >>> 0, false);
  view.setUint32(22, params.fileHash >>> 0, false);
  view.setUint16(26, metaLen & 0xffff, false);

  if (metaLen > 0 && params.metadataBytes) {
    out.set(params.metadataBytes, BULK_CHUNK_HEADER_BYTES);
  }
  if (payloadLen > 0) {
    out.set(params.payload, BULK_CHUNK_HEADER_BYTES + metaLen);
  }
  return out;
}

export function encodeBulkControlFrame(
  frameType:
    | typeof BULK_FRAME_TYPES.COMPLETE_ACK
    | typeof BULK_FRAME_TYPES.HASH_MISMATCH_NACK
    | typeof BULK_FRAME_TYPES.CANCEL,
  transferId: number,
  fileHash: number,
  reasonCode = 0
): Uint8Array {
  const out = new Uint8Array(BULK_CONTROL_FRAME_BYTES);
  const view = new DataView(out.buffer);
  view.setUint16(0, BULK_FRAME_MAGIC, false);
  view.setUint8(2, BULK_PROTOCOL_VERSION);
  view.setUint8(3, frameType);
  view.setUint32(4, transferId >>> 0, false);
  view.setUint32(8, fileHash >>> 0, false);
  view.setUint8(12, reasonCode & 0xff);
  return out;
}

export function decodeBulkAssetFrame(
  input: Uint8Array | ArrayBuffer | DataView
): DecodedBulkFrame | null {
  const bytes = toUint8Array(input);
  if (!bytes || bytes.byteLength < BULK_CONTROL_FRAME_BYTES) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, false) !== BULK_FRAME_MAGIC) return null;

  const version = view.getUint8(2);
  if (version !== BULK_PROTOCOL_VERSION) return null;

  const frameType = view.getUint8(3);
  const transferId = view.getUint32(4, false);

  if (
    frameType === BULK_FRAME_TYPES.COMPLETE_ACK ||
    frameType === BULK_FRAME_TYPES.HASH_MISMATCH_NACK ||
    frameType === BULK_FRAME_TYPES.CANCEL
  ) {
    const fileHash = view.getUint32(8, false);
    const reasonCode = view.getUint8(12);
    return {
      frameType,
      version,
      transferId,
      fileHash,
      reasonCode,
    };
  }

  if (frameType !== BULK_FRAME_TYPES.CHUNK || bytes.byteLength < BULK_CHUNK_HEADER_BYTES) {
    return null;
  }

  const assetKindCode = view.getUint8(8);
  const assetKind = BULK_CODE_TO_ASSET_KIND[assetKindCode];
  if (!assetKind) return null;

  const flags = view.getUint8(9);
  const chunkIndex = view.getUint32(10, false);
  const totalChunks = view.getUint32(14, false);
  const totalBytes = view.getUint32(18, false);
  const fileHash = view.getUint32(22, false);
  const metadataLength = view.getUint16(26, false);

  const payloadOffset = BULK_CHUNK_HEADER_BYTES + metadataLength;
  if (payloadOffset > bytes.byteLength) return null;

  return {
    frameType: BULK_FRAME_TYPES.CHUNK,
    version,
    transferId,
    assetKind,
    flags,
    chunkIndex,
    totalChunks,
    totalBytes,
    fileHash,
    metadataBytes: bytes.subarray(BULK_CHUNK_HEADER_BYTES, payloadOffset),
    payload: bytes.subarray(payloadOffset),
  };
}
