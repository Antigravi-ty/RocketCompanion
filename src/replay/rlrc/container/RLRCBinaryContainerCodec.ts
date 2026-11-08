/**
 * RLRCBinaryContainerCodec.ts
 * Compact binary container encoder and decoder for RLRC 120Hz replay packets
 * (Header JSON metadata + Track 0: 1856-byte 120Hz State+Controls stream + Track 1: 64-byte Bookmarks).
 */

import {
  RLRC_CONTAINER_MAGIC,
  RLRC_CONTAINER_VERSION,
  RLRC_TICK_RATE,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_CONTROLS_BYTES_PER_FRAME,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  RLRC_BOOKMARK_RECORD_STRIDE_BYTES,
  type RLRCBookmarkKind,
  type RLRCBookmarkRecord,
  type RLRCContainerPacket,
  type RLRCFrame120Hz,
  type RLRCPlayerSlotMeta,
  type RLRCReplayHeaderMeta,
  type RLRCResamplerOutput,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
import {
  packRLRCFrameToTrack0Slot,
  unpackRLRCFrameFromTrack0Slot,
  resolveRLRCTrack0FrameByteOffset,
} from './RLRCTrack0FrameSlotPacker.ts';

const RLRC_MAGIC_BYTES = new Uint8Array([0x52, 0x4c, 0x52, 0x43, 0x52, 0x45, 0x50, 0x31]);
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
  bytesOrBuffer: Uint8Array | ArrayBuffer | null | undefined,
): boolean {
  const u8 =
    bytesOrBuffer instanceof Uint8Array
      ? bytesOrBuffer
      : bytesOrBuffer instanceof ArrayBuffer
        ? new Uint8Array(bytesOrBuffer)
        : null;
  if (!u8 || u8.byteLength < 16) return false;
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== RLRC_MAGIC_BYTES[i]) return false;
  }
  return true;
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
  stateInputTrackBytes: Uint8Array,
): RLRCFrame120Hz[] {
  const frameCount120Hz = Math.floor(
    stateInputTrackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES,
  );
  const frames120Hz: RLRCFrame120Hz[] = new Array(frameCount120Hz);
  for (let i = 0; i < frameCount120Hz; i++) {
    frames120Hz[i] = unpackRLRCFrameFromTrack0Slot(stateInputTrackBytes, i);
  }
  return frames120Hz;
}

export function encodeRLRCBookmarksToTrack1Bytes(
  bookmarks: readonly RLRCBookmarkRecord[],
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
  bookmarkTrackBytes: Uint8Array,
): RLRCBookmarkRecord[] {
  const count = Math.floor(bookmarkTrackBytes.byteLength / RLRC_BOOKMARK_RECORD_STRIDE_BYTES);
  const records: RLRCBookmarkRecord[] = new Array(count);
  const decoder = new TextDecoder();
  const dv = new DataView(
    bookmarkTrackBytes.buffer,
    bookmarkTrackBytes.byteOffset,
    bookmarkTrackBytes.byteLength,
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

export function serializeRLRCBinaryContainer(
  source: RLRCResamplerOutput | RLRCContainerPacket,
): Uint8Array {
  const packet: RLRCContainerPacket =
    'bookmarkTrackBytes' in source ? source : buildRLRCContainerPacket(source);
  const frameCount = Math.floor(
    packet.stateInputTrackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES,
  );
  const bookmarkCount = Math.floor(
    packet.bookmarkTrackBytes.byteLength / RLRC_BOOKMARK_RECORD_STRIDE_BYTES,
  );

  const buildEnvelope = (track0Offset: number, track1Offset: number) => ({
    magic: RLRC_CONTAINER_MAGIC,
    version: RLRC_CONTAINER_VERSION,
    tickRate: RLRC_TICK_RATE,
    header: packet.header,
    roster: packet.roster,
    tracks: {
      stateInput: {
        offset: track0Offset,
        byteLength: packet.stateInputTrackBytes.byteLength,
        count: frameCount,
        stride: RLRC_TRACK0_FRAME_STRIDE_BYTES,
        stateFloats: RLRC_STATE_FLOATS_PER_FRAME,
        controlsBytes: RLRC_CONTROLS_BYTES_PER_FRAME,
      },
      bookmarks: {
        offset: track1Offset,
        byteLength: packet.bookmarkTrackBytes.byteLength,
        count: bookmarkCount,
        stride: RLRC_BOOKMARK_RECORD_STRIDE_BYTES,
      },
    },
  });

  const encoder = new TextEncoder();
  const draftMetaBytes = encoder.encode(JSON.stringify(buildEnvelope(0, 0)));
  let track0Offset = (16 + draftMetaBytes.byteLength + 7) & ~7;
  let track1Offset = (track0Offset + packet.stateInputTrackBytes.byteLength + 7) & ~7;

  let finalMetaBytes = encoder.encode(JSON.stringify(buildEnvelope(track0Offset, track1Offset)));
  const alignedMetaEnd = (16 + finalMetaBytes.byteLength + 7) & ~7;
  if (alignedMetaEnd !== track0Offset) {
    track0Offset = alignedMetaEnd;
    track1Offset = (track0Offset + packet.stateInputTrackBytes.byteLength + 7) & ~7;
    finalMetaBytes = encoder.encode(JSON.stringify(buildEnvelope(track0Offset, track1Offset)));
  }

  const totalBytes = (track1Offset + packet.bookmarkTrackBytes.byteLength + 7) & ~7;
  const container = new Uint8Array(totalBytes);
  const dv = new DataView(container.buffer, container.byteOffset, container.byteLength);

  container.set(RLRC_MAGIC_BYTES, 0);
  dv.setUint32(8, RLRC_CONTAINER_VERSION, true);
  dv.setUint32(12, finalMetaBytes.byteLength, true);
  container.fill(0x20, 16, track0Offset);
  container.set(finalMetaBytes, 16);

  if (packet.stateInputTrackBytes.byteLength > 0) {
    container.set(packet.stateInputTrackBytes, track0Offset);
  }
  if (packet.bookmarkTrackBytes.byteLength > 0) {
    container.set(packet.bookmarkTrackBytes, track1Offset);
  }
  return container;
}

export function deserializeRLRCBinaryContainer(
  bytesOrBuffer: Uint8Array | ArrayBuffer,
): DeserializedRLRCContainer {
  const u8 =
    bytesOrBuffer instanceof Uint8Array ? bytesOrBuffer : new Uint8Array(bytesOrBuffer);
  if (!isBinaryRLRCContainer(u8)) {
    throw new Error('Invalid RLRCREP1 binary container header.');
  }

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(8, true);
  if (version !== RLRC_CONTAINER_VERSION) {
    throw new Error(`Unsupported RLRCREP1 container version: ${version}`);
  }
  const metaLength = dv.getUint32(12, true);
  if (16 + metaLength > u8.byteLength) {
    throw new Error('Corrupt RLRCREP1 metadata JSON length.');
  }

  const envelope = JSON.parse(
    new TextDecoder().decode(u8.subarray(16, 16 + metaLength)),
  ) as {
    header: RLRCReplayHeaderMeta;
    roster: readonly RLRCPlayerSlotMeta[];
    tracks: {
      stateInput: { offset: number; byteLength: number; count: number };
      bookmarks: { offset: number; byteLength: number; count: number };
    };
  };

  const t0 = envelope.tracks.stateInput;
  const t1 = envelope.tracks.bookmarks;
  const stateInputTrackBytes = u8.slice(t0.offset, t0.offset + t0.byteLength);
  const bookmarkTrackBytes = u8.slice(t1.offset, t1.offset + t1.byteLength);
  const bookmarks = decodeRLRCBookmarksFromTrack1Bytes(bookmarkTrackBytes);
  const frames120Hz = decodeRLRCFramesFromTrack0Bytes(stateInputTrackBytes);

  return {
    header: envelope.header,
    roster: envelope.roster,
    bookmarks,
    stateInputTrackBytes,
    bookmarkTrackBytes,
    frameCount120Hz: frames120Hz.length,
    frames120Hz,
  };
}
