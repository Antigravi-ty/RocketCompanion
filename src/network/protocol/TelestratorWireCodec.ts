import { computeStrokeHash } from '../../entities/telestrator/telestratorStrokeGeometry.ts';
import type {
  TelestratorBrushTool,
  TelestratorColorId,
  TelestratorPoint,
  TelestratorStroke,
} from '../../entities/telestrator/telestratorTypes.ts';

const WIRE_MAGIC = 0x5243544c; // "RCTL"
const STROKE_HEADER_BYTES = 68;

export const TELESTRATOR_WIRE_MSG_TYPE = {
  STROKE_FULL: 1,
  STROKE_HASH_ACK: 2,
  STROKE_UNDO: 3,
  STROKE_CLEAR: 4,
} as const;

const TOOL_TO_BYTE: Record<TelestratorBrushTool, number> = {
  solid: 0,
  dashed: 1,
  arrow: 2,
};

const BYTE_TO_TOOL: readonly TelestratorBrushTool[] = ['solid', 'dashed', 'arrow'];

const COLOR_TO_BYTE: Record<TelestratorColorId, number> = {
  'dark-grey': 0,
  white: 1,
  red: 2,
  yellow: 3,
  'bright-green': 4,
  'dark-green': 5,
};

const BYTE_TO_COLOR: readonly TelestratorColorId[] = [
  'dark-grey',
  'white',
  'red',
  'yellow',
  'bright-green',
  'dark-green',
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeTelestratorStroke(stroke: TelestratorStroke): Uint8Array {
  const idBytes = textEncoder.encode(stroke.id);
  const authorBytes = textEncoder.encode(stroke.authorId);
  const pointCount = stroke.points.length;
  const headerSize = STROKE_HEADER_BYTES + idBytes.length + authorBytes.length;
  const payloadSize = pointCount * 6 * 4;
  const buffer = new ArrayBuffer(headerSize + payloadSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  let offset = 0;
  view.setUint32(offset, WIRE_MAGIC, true);
  offset += 4;
  view.setUint8(offset, TELESTRATOR_WIRE_MSG_TYPE.STROKE_FULL);
  offset += 1;
  view.setUint8(offset, TOOL_TO_BYTE[stroke.tool] ?? 0);
  offset += 1;
  view.setUint8(offset, COLOR_TO_BYTE[stroke.colorId] ?? 3);
  offset += 1;
  view.setUint8(offset, Math.round(Math.max(0, Math.min(1, stroke.opacity)) * 255));
  offset += 1;
  view.setFloat32(offset, stroke.widthRefPx, true);
  offset += 4;
  view.setInt32(offset, stroke.createdTick, true);
  offset += 4;
  view.setInt32(offset, stroke.fadeDurationTicks, true);
  offset += 4;
  view.setUint32(offset, stroke.hash >>> 0, true);
  offset += 4;
  view.setUint16(offset, pointCount, true);
  offset += 2;
  view.setUint16(offset, idBytes.length, true);
  offset += 2;
  view.setUint16(offset, authorBytes.length, true);
  offset += 2;
  view.setUint16(offset, 0, true);
  offset += 2;
  view.setFloat32(offset, stroke.arrowLengthRefPx, true);
  offset += 4;
  view.setFloat32(offset, stroke.arrowWidthRefPx, true);
  offset += 4;
  view.setFloat32(offset, stroke.camForward.x, true);
  offset += 4;
  view.setFloat32(offset, stroke.camForward.y, true);
  offset += 4;
  view.setFloat32(offset, stroke.camForward.z, true);
  offset += 4;
  view.setFloat32(offset, stroke.camPos.x, true);
  offset += 4;
  view.setFloat32(offset, stroke.camPos.y, true);
  offset += 4;
  view.setFloat32(offset, stroke.camPos.z, true);
  offset += 4;
  view.setFloat32(offset, stroke.camFovDeg, true);
  offset += 4;

  out.set(idBytes, offset);
  offset += idBytes.length;
  out.set(authorBytes, offset);
  offset += authorBytes.length;

  for (let i = 0; i < pointCount; i++) {
    const pt = stroke.points[i];
    view.setFloat32(offset, pt.x, true);
    view.setFloat32(offset + 4, pt.y, true);
    view.setFloat32(offset + 8, pt.z, true);
    view.setFloat32(offset + 12, pt.nx, true);
    view.setFloat32(offset + 16, pt.ny, true);
    view.setFloat32(offset + 20, pt.nz, true);
    offset += 24;
  }

  return out;
}

export function decodeTelestratorStroke(bytes: Uint8Array): TelestratorStroke | null {
  if (bytes.byteLength < STROKE_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== WIRE_MAGIC) return null;
  if (view.getUint8(4) !== TELESTRATOR_WIRE_MSG_TYPE.STROKE_FULL) return null;

  const tool = BYTE_TO_TOOL[view.getUint8(5)] ?? 'solid';
  const colorId = BYTE_TO_COLOR[view.getUint8(6)] ?? 'yellow';
  const opacity = view.getUint8(7) / 255;
  const widthRefPx = view.getFloat32(8, true);
  const createdTick = view.getInt32(12, true);
  const fadeDurationTicks = view.getInt32(16, true);
  const wireHash = view.getUint32(20, true);
  const pointCount = view.getUint16(24, true);
  const idLen = view.getUint16(26, true);
  const authorLen = view.getUint16(28, true);
  const arrowLengthRefPx = view.getFloat32(32, true);
  const arrowWidthRefPx = view.getFloat32(36, true);
  const camForward = {
    x: view.getFloat32(40, true),
    y: view.getFloat32(44, true),
    z: view.getFloat32(48, true),
  };
  const camPos = {
    x: view.getFloat32(52, true),
    y: view.getFloat32(56, true),
    z: view.getFloat32(60, true),
  };
  const camFovDeg = view.getFloat32(64, true);

  let offset = STROKE_HEADER_BYTES;
  const expectedSize = offset + idLen + authorLen + pointCount * 24;
  if (bytes.byteLength < expectedSize) return null;

  const id = textDecoder.decode(bytes.subarray(offset, offset + idLen));
  offset += idLen;
  const authorId = textDecoder.decode(bytes.subarray(offset, offset + authorLen));
  offset += authorLen;

  const points: TelestratorPoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    points.push({
      x: view.getFloat32(offset, true),
      y: view.getFloat32(offset + 4, true),
      z: view.getFloat32(offset + 8, true),
      nx: view.getFloat32(offset + 12, true),
      ny: view.getFloat32(offset + 16, true),
      nz: view.getFloat32(offset + 20, true),
    });
    offset += 24;
  }

  const computedHash = computeStrokeHash(tool, colorId, opacity, widthRefPx, points);
  return {
    id,
    authorId,
    tool,
    colorId,
    opacity,
    widthRefPx,
    arrowLengthRefPx,
    arrowWidthRefPx,
    camPos,
    camForward,
    camFovDeg,
    createdTick,
    fadeDurationTicks,
    points,
    hash: wireHash || computedHash,
  };
}

export interface TelestratorHashAck {
  strokeId: string;
  hash: number;
  matched: boolean;
}

export function encodeTelestratorHashAck(ack: TelestratorHashAck): Uint8Array {
  const idBytes = textEncoder.encode(ack.strokeId);
  const buffer = new ArrayBuffer(12 + idBytes.length);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  view.setUint32(0, WIRE_MAGIC, true);
  view.setUint8(4, TELESTRATOR_WIRE_MSG_TYPE.STROKE_HASH_ACK);
  view.setUint8(5, ack.matched ? 1 : 0);
  view.setUint16(6, idBytes.length, true);
  view.setUint32(8, ack.hash >>> 0, true);
  out.set(idBytes, 12);
  return out;
}

export function decodeTelestratorHashAck(bytes: Uint8Array): TelestratorHashAck | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== WIRE_MAGIC) return null;
  if (view.getUint8(4) !== TELESTRATOR_WIRE_MSG_TYPE.STROKE_HASH_ACK) return null;
  const matched = view.getUint8(5) === 1;
  const idLen = view.getUint16(6, true);
  const hash = view.getUint32(8, true);
  if (bytes.byteLength < 12 + idLen) return null;
  const strokeId = textDecoder.decode(bytes.subarray(12, 12 + idLen));
  return { strokeId, hash, matched };
}
