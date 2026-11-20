/**
 * src/replay/rewinderBulkSliceCodec.ts
 * Compact binary codec for FreeplayRewinderController history slices sent over Channel 4 (BulkAssetChannel).
 */

import type { RewinderSliceBulkMetadata } from '../network/protocol/BulkAssetProtocol.ts';
import type { RewinderFrameEntry } from './replayDataPayloadPipeline.ts';

export const REWINDER_SLICE_MAGIC = 0x5257; // 'RW'
export const REWINDER_SLICE_VERSION = 1;
const REWINDER_SLICE_HEADER_BYTES = 20;

export interface EncodeRewinderSliceOptions {
  startFrame?: number;
  endFrame?: number;
  cursorFrame?: number;
  targetFrame?: number;
  arenaPreset?: number;
}

export interface EncodedRewinderSlice {
  readonly payload: Uint8Array;
  readonly metadata: RewinderSliceBulkMetadata;
}

export interface DecodedRewinderSlice {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly cursorFrame: number;
  readonly targetFrame: number;
  readonly frames: RewinderFrameEntry[];
}

interface SerializedFrameAux {
  controls: RewinderFrameEntry['controls'];
  acknowledgedControls?: RewinderFrameEntry['acknowledgedControls'];
  incidents: RewinderFrameEntry['incidents'];
  signals?: RewinderFrameEntry['signals'];
  audioEvents?: RewinderFrameEntry['audioEvents'];
  hadTouch: boolean;
  lastTouchTick: number;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function encodeRewinderSlice(
  frames: readonly RewinderFrameEntry[],
  options: EncodeRewinderSliceOptions = {}
): EncodedRewinderSlice {
  const total = frames.length;
  const startFrame = Math.max(0, Math.min(total, options.startFrame ?? 0));
  const endFrame = Math.max(startFrame, Math.min(total, options.endFrame ?? total));
  const slice = frames.slice(startFrame, endFrame);
  const cursorFrame = Math.max(0, Math.min(Math.max(0, slice.length - 1), (options.cursorFrame ?? startFrame) - startFrame));
  const targetFrame = Math.max(0, Math.min(Math.max(0, slice.length - 1), (options.targetFrame ?? startFrame) - startFrame));

  const encodedParts: Array<{
    compactBytes: Uint8Array;
    renderBytes: Uint8Array;
    auxBytes: Uint8Array;
  }> = [];

  let totalBytes = REWINDER_SLICE_HEADER_BYTES;
  for (const frame of slice) {
    const compactBytes = new Uint8Array(
      frame.compactSnap.buffer,
      frame.compactSnap.byteOffset,
      frame.compactSnap.byteLength
    );
    const renderBytes = new Uint8Array(
      frame.renderState.buffer,
      frame.renderState.byteOffset,
      frame.renderState.byteLength
    );
    const aux: SerializedFrameAux = {
      controls: frame.controls ?? {},
      acknowledgedControls: frame.acknowledgedControls,
      incidents: frame.incidents ?? [],
      signals: frame.signals,
      audioEvents: frame.audioEvents,
      hadTouch: Boolean(frame.hadTouch),
      lastTouchTick: Number(frame.lastTouchTick ?? -1),
    };
    const auxBytes = utf8Encoder.encode(JSON.stringify(aux));
    encodedParts.push({ compactBytes, renderBytes, auxBytes });
    totalBytes += 12 + compactBytes.byteLength + renderBytes.byteLength + auxBytes.byteLength;
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  view.setUint16(0, REWINDER_SLICE_MAGIC, false);
  view.setUint16(2, REWINDER_SLICE_VERSION, false);
  view.setUint32(4, startFrame >>> 0, false);
  view.setUint32(8, endFrame >>> 0, false);
  view.setUint32(12, cursorFrame >>> 0, false);
  view.setUint32(16, slice.length >>> 0, false);

  let offset = REWINDER_SLICE_HEADER_BYTES;
  for (const part of encodedParts) {
    view.setUint32(offset, part.compactBytes.byteLength >>> 0, false);
    view.setUint32(offset + 4, part.renderBytes.byteLength >>> 0, false);
    view.setUint32(offset + 8, part.auxBytes.byteLength >>> 0, false);
    offset += 12;

    out.set(part.compactBytes, offset);
    offset += part.compactBytes.byteLength;
    out.set(part.renderBytes, offset);
    offset += part.renderBytes.byteLength;
    out.set(part.auxBytes, offset);
    offset += part.auxBytes.byteLength;
  }

  return {
    payload: out,
    metadata: {
      startFrame,
      endFrame,
      cursorFrame,
      targetFrame,
      frameCount: slice.length,
      totalRewinderFrames: total,
      arenaPreset: options.arenaPreset,
    },
  };
}

export function decodeRewinderSlice(payload: Uint8Array): DecodedRewinderSlice | null {
  if (payload.byteLength < REWINDER_SLICE_HEADER_BYTES) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint16(0, false) !== REWINDER_SLICE_MAGIC) return null;
  if (view.getUint16(2, false) !== REWINDER_SLICE_VERSION) return null;

  const startFrame = view.getUint32(4, false);
  const endFrame = view.getUint32(8, false);
  const cursorFrame = view.getUint32(12, false);
  const frameCount = view.getUint32(16, false);

  const frames: RewinderFrameEntry[] = [];
  let offset = REWINDER_SLICE_HEADER_BYTES;

  for (let i = 0; i < frameCount; i++) {
    if (offset + 12 > payload.byteLength) return null;
    const compactLen = view.getUint32(offset, false);
    const renderLen = view.getUint32(offset + 4, false);
    const auxLen = view.getUint32(offset + 8, false);
    offset += 12;

    if (offset + compactLen + renderLen + auxLen > payload.byteLength) return null;
    const compactSlice = payload.slice(offset, offset + compactLen);
    offset += compactLen;
    const renderSlice = payload.slice(offset, offset + renderLen);
    offset += renderLen;
    const auxSlice = payload.subarray(offset, offset + auxLen);
    offset += auxLen;

    let aux: SerializedFrameAux;
    try {
      aux = JSON.parse(utf8Decoder.decode(auxSlice)) as SerializedFrameAux;
    } catch {
      return null;
    }

    frames.push({
      compactSnap: new Float32Array(compactSlice.buffer),
      renderState: new Float32Array(renderSlice.buffer),
      controls: aux.controls ?? {},
      acknowledgedControls: aux.acknowledgedControls,
      incidents: aux.incidents ?? [],
      signals: aux.signals,
      audioEvents: aux.audioEvents,
      hadTouch: Boolean(aux.hadTouch),
      lastTouchTick: Number(aux.lastTouchTick ?? -1),
    });
  }

  return {
    startFrame,
    endFrame,
    cursorFrame,
    targetFrame: cursorFrame,
    frames,
  };
}
