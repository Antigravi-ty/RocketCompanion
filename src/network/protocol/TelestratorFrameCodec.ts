/**
 * src/network/protocol/TelestratorWireCodec.ts
 * Compact binary wire codec for 3D telestrator strokes, FNV-1a hash verification,
 * and reliable ACK/Undo/Clear reconciliation frames.
 */

export const TELESTRATOR_FRAME_TYPE = Object.freeze({
  STROKE_COMMIT: 0x20,
  STROKE_ACK: 0x21,
  STROKE_UNDO: 0x22,
  STROKE_CLEAR: 0x23,
} as const);

export const TELESTRATOR_STROKE_STYLE = Object.freeze({
  SOLID: 0,
  DASHED: 1,
  ARROW: 2,
} as const);

export type TelestratorStrokeStyle =
  (typeof TELESTRATOR_STROKE_STYLE)[keyof typeof TELESTRATOR_STROKE_STYLE];

export interface TelestratorStrokePayload {
  strokeId: number;
  authorPeerSlot: number;
  replayTick: number;
  style: TelestratorStrokeStyle;
  colorIndex: number;
  opacityPct: number;
  widthPx: number;
  points: Float32Array; // packed [x0, y0, z0, x1, y1, z1, ...]
  fnv1aHash: number;
}

export interface TelestratorStrokeAckFrame {
  strokeId: number;
  fnv1aHash: number;
  accepted: boolean;
}

export interface TelestratorCommandFrame {
  frameType: typeof TELESTRATOR_FRAME_TYPE.STROKE_UNDO | typeof TELESTRATOR_FRAME_TYPE.STROKE_CLEAR;
  authorPeerSlot: number;
  targetStrokeId: number;
}

export function computeTelestratorStrokeHash(
  points: Float32Array,
  style: number,
  colorIndex: number,
  opacityPct: number,
  widthPx: number
): number {
  let hash = 0x811c9dc5;
  const mixByte = (b: number): void => {
    hash ^= b & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  mixByte(style);
  mixByte(colorIndex);
  mixByte(opacityPct);
  mixByte(Math.round(widthPx));
  const raw = new Uint8Array(points.buffer, points.byteOffset, points.byteLength);
  for (let i = 0; i < raw.byteLength; i++) {
    mixByte(raw[i]);
  }
  return hash >>> 0;
}

export function encodeTelestratorStrokeFrame(stroke: TelestratorStrokePayload): Uint8Array {
  const pointCount = Math.min(2048, Math.floor(stroke.points.length / 3));
  const totalBytes = 20 + pointCount * 12;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);

  view.setUint8(0, TELESTRATOR_FRAME_TYPE.STROKE_COMMIT);
  view.setUint8(1, stroke.authorPeerSlot & 0xff);
  view.setUint8(2, ((stroke.style & 0x0f) << 4) | (stroke.colorIndex & 0x0f));
  view.setUint8(3, Math.max(0, Math.min(100, Math.round(stroke.opacityPct))));
  view.setUint32(4, stroke.strokeId >>> 0, false);
  view.setInt32(8, stroke.replayTick | 0, false);
  view.setUint16(12, Math.max(1, Math.min(65535, Math.round(stroke.widthPx * 10))), false);
  view.setUint16(14, pointCount, false);
  view.setUint32(16, stroke.fnv1aHash >>> 0, false);

  let offset = 20;
  for (let i = 0; i < pointCount * 3; i++) {
    view.setFloat32(offset, stroke.points[i], false);
    offset += 4;
  }
  return new Uint8Array(buf);
}

export function decodeTelestratorStrokeFrame(
  input: ArrayBuffer | Uint8Array | DataView
): TelestratorStrokePayload | null {
  const view = toDataView(input);
  if (!view || view.byteLength < 20) return null;
  if (view.getUint8(0) !== TELESTRATOR_FRAME_TYPE.STROKE_COMMIT) return null;

  const authorPeerSlot = view.getUint8(1);
  const packedStyleColor = view.getUint8(2);
  const style = ((packedStyleColor >> 4) & 0x0f) as TelestratorStrokeStyle;
  const colorIndex = packedStyleColor & 0x0f;
  const opacityPct = view.getUint8(3);
  const strokeId = view.getUint32(4, false);
  const replayTick = view.getInt32(8, false);
  const widthPx = view.getUint16(12, false) / 10;
  const pointCount = view.getUint16(14, false);
  const fnv1aHash = view.getUint32(16, false);

  if (view.byteLength < 20 + pointCount * 12) return null;
  const points = new Float32Array(pointCount * 3);
  let offset = 20;
  for (let i = 0; i < points.length; i++) {
    points[i] = view.getFloat32(offset, false);
    offset += 4;
  }

  return {
    strokeId,
    authorPeerSlot,
    replayTick,
    style,
    colorIndex,
    opacityPct,
    widthPx,
    points,
    fnv1aHash,
  };
}

export function encodeTelestratorAckFrame(ack: TelestratorStrokeAckFrame): Uint8Array {
  const buf = new ArrayBuffer(10);
  const view = new DataView(buf);
  view.setUint8(0, TELESTRATOR_FRAME_TYPE.STROKE_ACK);
  view.setUint8(1, ack.accepted ? 1 : 0);
  view.setUint32(2, ack.strokeId >>> 0, false);
  view.setUint32(6, ack.fnv1aHash >>> 0, false);
  return new Uint8Array(buf);
}

export function decodeTelestratorAckFrame(
  input: ArrayBuffer | Uint8Array | DataView
): TelestratorStrokeAckFrame | null {
  const view = toDataView(input);
  if (!view || view.byteLength < 10) return null;
  if (view.getUint8(0) !== TELESTRATOR_FRAME_TYPE.STROKE_ACK) return null;
  return {
    accepted: view.getUint8(1) === 1,
    strokeId: view.getUint32(2, false),
    fnv1aHash: view.getUint32(6, false),
  };
}

export function encodeTelestratorCommandFrame(cmd: TelestratorCommandFrame): Uint8Array {
  const buf = new ArrayBuffer(6);
  const view = new DataView(buf);
  view.setUint8(0, cmd.frameType);
  view.setUint8(1, cmd.authorPeerSlot & 0xff);
  view.setUint32(2, cmd.targetStrokeId >>> 0, false);
  return new Uint8Array(buf);
}

export function decodeTelestratorCommandFrame(
  input: ArrayBuffer | Uint8Array | DataView
): TelestratorCommandFrame | null {
  const view = toDataView(input);
  if (!view || view.byteLength < 6) return null;
  const frameType = view.getUint8(0);
  if (
    frameType !== TELESTRATOR_FRAME_TYPE.STROKE_UNDO &&
    frameType !== TELESTRATOR_FRAME_TYPE.STROKE_CLEAR
  ) {
    return null;
  }
  return {
    frameType,
    authorPeerSlot: view.getUint8(1),
    targetStrokeId: view.getUint32(2, false),
  };
}

function toDataView(
  input: ArrayBuffer | Uint8Array | DataView | null | undefined
): DataView | null {
  if (!input) return null;
  if (input instanceof DataView) return input;
  if (input instanceof Uint8Array)
    return new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new DataView(input);
  return null;
}
