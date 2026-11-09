/**
 * RLRCBinaryContainerCodec.ts
 * Binary container encoder, decoder, and background Worker GZIP packer for 120Hz RLRC replay sessions.
 * Uses the unified RCREPLAY V2 multi-track binary container
 * (Track A: XOR-delta byte-transposed 1856B State+Controls, Track B: 64B Incidents, Track C: 64B Signals).
 */

import { serializeRCReplayBinaryContainer } from '../../container/RCReplayBinaryEncoder.ts';
import { isBinaryRCReplayContainer } from '../../container/RCReplayBinarySchema.ts';
import {
  packAndCompressReplayInBackground,
  type CompressedReplayWorkerResult,
} from '../../container/RCReplayCompressionWorkerClient.ts';
import {
  RLRC_BOOKMARK_RECORD_STRIDE_BYTES,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCBookmarkKind,
  type RLRCBookmarkRecord,
  type RLRCContainerPacket,
  type RLRCFrame120Hz,
  type RLRCResamplerOutput,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
import {
  extractRLRCTracksFromRCReplayV2Bytes,
  mapRLRCPacketToRCReplayV2Payload,
  type RLRCReplayV2ExportPayload,
} from './RLRCRCReplayV2PayloadPipeline.ts';
import {
  packRLRCFrameToTrack0Slot,
  resolveRLRCTrack0FrameByteOffset,
  unpackRLRCFrameFromTrack0Slot,
} from './RLRCTrack0FrameSlotPacker.ts';

export type { RLRCReplayV2ExportPayload };

const RLRC_BOOKMARK_LABEL_MAX_BYTES = 44;

const BOOKMARK_KIND_TO_CODE: Readonly<Record<RLRCBookmarkKind, number>> = Object.freeze({
  'user-mark': 1,
  goal: 2,
  kickoff: 3,
  demolish: 4,
  'ue-keyframe': 5,
});

const CODE_TO_BOOKMARK_KIND: Readonly<Record<number, RLRCBookmarkKind>> = Object.freeze({
  1: 'user-mark',
  2: 'goal',
  3: 'kickoff',
  4: 'demolish',
  5: 'ue-keyframe',
});

export interface DeserializedRLRCContainer extends RLRCContainerPacket {
  readonly frameCount120Hz: number;
  readonly frames120Hz: readonly RLRCFrame120Hz[];
}

export function isBinaryRLRCContainer(
  bytesOrBuffer: Uint8Array | ArrayBuffer | null | undefined
): boolean {
  return isBinaryRCReplayContainer(bytesOrBuffer);
}

export function getRLRCTrack0FrameByteOffset(frameIndex120Hz: number): number {
  return resolveRLRCTrack0FrameByteOffset(frameIndex120Hz);
}

export function encodeRLRCFramesToTrack0Bytes(frames120Hz: readonly RLRCFrame120Hz[]): Uint8Array {
  const trackBytes = new Uint8Array(frames120Hz.length * RLRC_TRACK0_FRAME_STRIDE_BYTES);
  for (let i = 0; i < frames120Hz.length; i++) {
    packRLRCFrameToTrack0Slot(frames120Hz[i], trackBytes, i * RLRC_TRACK0_FRAME_STRIDE_BYTES);
  }
  return trackBytes;
}

export function decodeRLRCFramesFromTrack0Bytes(
  stateInputTrackBytes: Uint8Array
): RLRCFrame120Hz[] {
  const frameCount120Hz = Math.floor(
    stateInputTrackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES
  );
  const frames120Hz: RLRCFrame120Hz[] = new Array(frameCount120Hz);
  for (let i = 0; i < frameCount120Hz; i++) {
    frames120Hz[i] = unpackRLRCFrameFromTrack0Slot(stateInputTrackBytes, i);
  }
  return frames120Hz;
}

export function encodeRLRCBookmarksToTrack1Bytes(
  bookmarks: readonly RLRCBookmarkRecord[]
): Uint8Array {
  const trackBytes = new Uint8Array(bookmarks.length * RLRC_BOOKMARK_RECORD_STRIDE_BYTES);
  const encoder = new TextEncoder();
  const dv = new DataView(trackBytes.buffer, trackBytes.byteOffset, trackBytes.byteLength);

  for (let i = 0; i < bookmarks.length; i++) {
    const bm = bookmarks[i];
    const base = i * RLRC_BOOKMARK_RECORD_STRIDE_BYTES;
    const labelBytes = encoder.encode(bm.label || '');
    const clampedLabelLen = Math.min(RLRC_BOOKMARK_LABEL_MAX_BYTES, labelBytes.byteLength);

    dv.setUint32(base + 0, Math.max(0, Math.trunc(bm.frameIndex120Hz)), true);
    dv.setUint32(base + 4, Math.max(0, Math.trunc(bm.sourceFrame30Hz)), true);
    dv.setFloat32(base + 8, bm.timeSeconds, true);
    dv.setUint8(base + 12, BOOKMARK_KIND_TO_CODE[bm.kind] ?? 1);
    dv.setInt8(base + 13, bm.slotIndex);
    dv.setInt8(base + 14, bm.team);
    dv.setUint8(base + 15, clampedLabelLen);
    trackBytes.set(labelBytes.subarray(0, clampedLabelLen), base + 16);
  }
  return trackBytes;
}

export function decodeRLRCBookmarksFromTrack1Bytes(
  bookmarkTrackBytes: Uint8Array
): RLRCBookmarkRecord[] {
  const count = Math.floor(bookmarkTrackBytes.byteLength / RLRC_BOOKMARK_RECORD_STRIDE_BYTES);
  const records: RLRCBookmarkRecord[] = new Array(count);
  const decoder = new TextDecoder();
  const dv = new DataView(
    bookmarkTrackBytes.buffer,
    bookmarkTrackBytes.byteOffset,
    bookmarkTrackBytes.byteLength
  );

  for (let i = 0; i < count; i++) {
    const base = i * RLRC_BOOKMARK_RECORD_STRIDE_BYTES;
    const kindCode = dv.getUint8(base + 12);
    const rawTeam = dv.getInt8(base + 14);
    const labelLen = Math.min(RLRC_BOOKMARK_LABEL_MAX_BYTES, dv.getUint8(base + 15));
    const team: RLRCTeamIndex | -1 = rawTeam === 0 || rawTeam === 1 ? rawTeam : -1;

    records[i] = {
      kind: CODE_TO_BOOKMARK_KIND[kindCode] ?? 'user-mark',
      frameIndex120Hz: dv.getUint32(base + 0, true),
      sourceFrame30Hz: dv.getUint32(base + 4, true),
      timeSeconds: dv.getFloat32(base + 8, true),
      slotIndex: dv.getInt8(base + 13),
      team,
      label: decoder.decode(bookmarkTrackBytes.subarray(base + 16, base + 16 + labelLen)),
    };
  }
  return records;
}

export function buildRLRCContainerPacket(source: RLRCResamplerOutput): RLRCContainerPacket {
  const stateInputTrackBytes =
    source.stateInputTrackBytes.byteLength ===
    source.frames120Hz.length * RLRC_TRACK0_FRAME_STRIDE_BYTES
      ? source.stateInputTrackBytes
      : encodeRLRCFramesToTrack0Bytes(source.frames120Hz);
  const bookmarkTrackBytes = encodeRLRCBookmarksToTrack1Bytes(source.bookmarks);
  return {
    header: source.header,
    roster: source.roster,
    bookmarks: source.bookmarks,
    stateInputTrackBytes,
    bookmarkTrackBytes,
  };
}

export function buildRCReplayV2PayloadFromRLRC(
  source: RLRCResamplerOutput | RLRCContainerPacket
): RLRCReplayV2ExportPayload {
  const packet: RLRCContainerPacket =
    'bookmarkTrackBytes' in source ? source : buildRLRCContainerPacket(source);
  return mapRLRCPacketToRCReplayV2Payload(packet);
}

export async function compressGzipStreamSafe(rawBytes: Uint8Array): Promise<ArrayBuffer> {
  if (typeof CompressionStream === 'undefined') {
    return rawBytes.buffer.slice(
      rawBytes.byteOffset,
      rawBytes.byteOffset + rawBytes.byteLength
    ) as ArrayBuffer;
  }
  const cs = new CompressionStream('gzip');
  if (typeof Blob !== 'undefined' && typeof Blob.prototype.stream === 'function') {
    const compressedStream = new Blob([rawBytes as BlobPart]).stream().pipeThrough(cs);
    return new Response(compressedStream).arrayBuffer();
  }
  const readPromise = new Response(cs.readable).arrayBuffer();
  const writer = cs.writable.getWriter();
  await writer.write(rawBytes as BufferSource);
  await writer.close();
  return readPromise;
}

export async function packAndCompressRLRCContainer(
  source: RLRCResamplerOutput | RLRCContainerPacket
): Promise<CompressedReplayWorkerResult> {
  return packAndCompressReplayInBackground(buildRCReplayV2PayloadFromRLRC(source));
}

export function serializeRLRCBinaryContainer(
  source: RLRCResamplerOutput | RLRCContainerPacket
): Uint8Array {
  return serializeRCReplayBinaryContainer(buildRCReplayV2PayloadFromRLRC(source));
}

export function deserializeRLRCBinaryContainer(
  bytesOrBuffer: Uint8Array | ArrayBuffer
): DeserializedRLRCContainer {
  const u8 = bytesOrBuffer instanceof Uint8Array ? bytesOrBuffer : new Uint8Array(bytesOrBuffer);
  if (!isBinaryRCReplayContainer(u8)) {
    throw new Error('Invalid RCREPLAY V2 binary container header.');
  }

  const extracted = extractRLRCTracksFromRCReplayV2Bytes(u8);
  const bookmarkTrackBytes = encodeRLRCBookmarksToTrack1Bytes(extracted.bookmarks);
  const frames120Hz = decodeRLRCFramesFromTrack0Bytes(extracted.stateInputTrackBytes);

  return {
    header: extracted.header,
    roster: extracted.roster,
    bookmarks: extracted.bookmarks,
    stateInputTrackBytes: extracted.stateInputTrackBytes,
    bookmarkTrackBytes,
    frameCount120Hz: frames120Hz.length,
    frames120Hz,
  };
}
