/**
 * rewinderBulkSliceCodec.ts
 * Binary serialization/deserialization for FreeplayRewinderController historical slices
 * ("Intervene From Here" snapshots & frame ranges) transmitted over Channel 4 (BulkAssetChannel).
 */

import type { RewinderFrameEntry } from './replayDataPayloadPipeline.ts';

export const REWINDER_SLICE_MAGIC = 0x5257534c; // 'RWSL'
export const REWINDER_SLICE_VERSION = 1;
const SLICE_HEADER_BYTES = 24;

export interface RewinderSliceMetadata {
  roomId?: string;
  tickRate?: number;
  targetFrame?: number;
  interveneFromHere?: boolean;
}

export interface DecodedRewinderSlice {
  startFrame: number;
  cursor: number;
  interveneFromHere: boolean;
  meta: RewinderSliceMetadata;
  frames: RewinderFrameEntry[];
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function encodeRewinderSliceBytes(params: {
  frames: ReadonlyArray<RewinderFrameEntry>;
  startFrame?: number;
  endFrame?: number;
  cursor?: number;
  interveneFromHere?: boolean;
  meta?: RewinderSliceMetadata;
}): Uint8Array {
  const total = params.frames.length;
  const start = Math.max(0, Math.min(total, params.startFrame ?? 0));
  const end = Math.max(start, Math.min(total, params.endFrame ?? total));
  const slice = params.frames.slice(start, end);
  const cursor = params.cursor ?? Math.max(0, slice.length - 1);
  const interveneFromHere = Boolean(params.interveneFromHere);

  const metaBytes = utf8Encoder.encode(JSON.stringify(params.meta ?? {}));
  const encodedFrames: Array<{
    compactBytes: Uint8Array;
    renderBytes: Uint8Array;
    hadTouch: number;
    lastTouchTick: number;
    extrasBytes: Uint8Array;
  }> = [];

  let bodyByteLength = 0;
  for (let i = 0; i < slice.length; i++) {
    const entry = slice[i];
    const compact = entry.compactSnap;
    const render = entry.renderState;
    const compactBytes = new Uint8Array(compact.buffer, compact.byteOffset, compact.byteLength);
    const renderBytes = new Uint8Array(render.buffer, render.byteOffset, render.byteLength);
    const extrasBytes = utf8Encoder.encode(
      JSON.stringify({
        controls: entry.controls ?? {},
        acknowledgedControls: entry.acknowledgedControls ?? [],
        incidents: entry.incidents ?? [],
        signals: entry.signals ?? [],
        audioEvents: entry.audioEvents ?? [],
      })
    );
    encodedFrames.push({
      compactBytes,
      renderBytes,
      hadTouch: entry.hadTouch ? 1 : 0,
      lastTouchTick: entry.lastTouchTick ?? -1,
      extrasBytes,
    });
    bodyByteLength +=
      2 + compactBytes.byteLength + 2 + renderBytes.byteLength + 1 + 4 + 4 + extrasBytes.byteLength;
  }

  const out = new Uint8Array(SLICE_HEADER_BYTES + metaBytes.byteLength + bodyByteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  view.setUint32(0, REWINDER_SLICE_MAGIC, false);
  view.setUint16(4, REWINDER_SLICE_VERSION, false);
  view.setUint16(6, interveneFromHere ? 1 : 0, false);
  view.setUint32(8, start >>> 0, false);
  view.setUint32(12, slice.length >>> 0, false);
  view.setFloat32(16, cursor, false);
  view.setUint32(20, metaBytes.byteLength >>> 0, false);

  let offset = SLICE_HEADER_BYTES;
  out.set(metaBytes, offset);
  offset += metaBytes.byteLength;

  for (let i = 0; i < encodedFrames.length; i++) {
    const f = encodedFrames[i];
    const compactFloats = f.compactBytes.byteLength / 4;
    const renderFloats = f.renderBytes.byteLength / 4;
    view.setUint16(offset, compactFloats, false);
    offset += 2;
    out.set(f.compactBytes, offset);
    offset += f.compactBytes.byteLength;

    view.setUint16(offset, renderFloats, false);
    offset += 2;
    out.set(f.renderBytes, offset);
    offset += f.renderBytes.byteLength;

    view.setUint8(offset, f.hadTouch);
    offset += 1;
    view.setInt32(offset, f.lastTouchTick | 0, false);
    offset += 4;
    view.setUint32(offset, f.extrasBytes.byteLength >>> 0, false);
    offset += 4;
    out.set(f.extrasBytes, offset);
    offset += f.extrasBytes.byteLength;
  }

  return out;
}

export function decodeRewinderSliceBytes(data: Uint8Array): DecodedRewinderSlice | null {
  if (data.byteLength < SLICE_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, false);
  const version = view.getUint16(4, false);
  if (magic !== REWINDER_SLICE_MAGIC || version !== REWINDER_SLICE_VERSION) {
    return null;
  }

  const flags = view.getUint16(6, false);
  const interveneFromHere = (flags & 1) !== 0;
  const startFrame = view.getUint32(8, false);
  const frameCount = view.getUint32(12, false);
  const cursor = view.getFloat32(16, false);
  const metaLen = view.getUint32(20, false);

  let offset = SLICE_HEADER_BYTES;
  if (offset + metaLen > data.byteLength) {
    return null;
  }

  let meta: RewinderSliceMetadata = {};
  if (metaLen > 0) {
    try {
      const parsed = JSON.parse(
        utf8Decoder.decode(data.subarray(offset, offset + metaLen))
      ) as unknown;
      if (parsed && typeof parsed === 'object') {
        meta = parsed as RewinderSliceMetadata;
      }
    } catch {
      return null;
    }
  }
  offset += metaLen;

  const frames: RewinderFrameEntry[] = [];
  for (let i = 0; i < frameCount; i++) {
    if (offset + 2 > data.byteLength) return null;
    const compactFloats = view.getUint16(offset, false);
    offset += 2;
    const compactBytesLen = compactFloats * 4;
    if (offset + compactBytesLen + 2 > data.byteLength) return null;
    const compactSnap = new Float32Array(compactFloats);
    new Uint8Array(compactSnap.buffer).set(data.subarray(offset, offset + compactBytesLen));
    offset += compactBytesLen;

    const renderFloats = view.getUint16(offset, false);
    offset += 2;
    const renderBytesLen = renderFloats * 4;
    if (offset + renderBytesLen + 9 > data.byteLength) return null;
    const renderState = new Float32Array(renderFloats);
    new Uint8Array(renderState.buffer).set(data.subarray(offset, offset + renderBytesLen));
    offset += renderBytesLen;

    const hadTouch = view.getUint8(offset) !== 0;
    offset += 1;
    const lastTouchTick = view.getInt32(offset, false);
    offset += 4;
    const extrasLen = view.getUint32(offset, false);
    offset += 4;
    if (offset + extrasLen > data.byteLength) return null;

    let extras: Partial<RewinderFrameEntry> = {};
    if (extrasLen > 0) {
      try {
        const parsed = JSON.parse(
          utf8Decoder.decode(data.subarray(offset, offset + extrasLen))
        ) as unknown;
        if (parsed && typeof parsed === 'object') {
          extras = parsed as Partial<RewinderFrameEntry>;
        }
      } catch {
        return null;
      }
    }
    offset += extrasLen;

    frames.push({
      compactSnap,
      renderState,
      controls: extras.controls ?? {},
      acknowledgedControls: extras.acknowledgedControls ?? [],
      incidents: extras.incidents ?? [],
      signals: extras.signals ?? [],
      audioEvents: extras.audioEvents ?? [],
      hadTouch,
      lastTouchTick,
    });
  }

  return {
    startFrame,
    cursor,
    interveneFromHere,
    meta,
    frames,
  };
}
