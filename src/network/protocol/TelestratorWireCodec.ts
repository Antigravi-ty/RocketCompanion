import { computeStrokeHash } from '../../entities/telestrator/telestratorStrokeMath.ts';
import type {
  TelestratorBrushTool,
  TelestratorColorId,
  TelestratorPoint,
  TelestratorPresetIndex,
  TelestratorStroke,
} from '../../entities/telestrator/telestratorTypes.ts';

const WIRE_MAGIC = 0x5243544c; // "RCTL"
const STROKE_HEADER_BYTES = 72;
const BYTES_PER_POINT = 8; // 3x Int16 pos (6B) + 2x Int8 oct normal (2B)

export const TELESTRATOR_WIRE_MSG_TYPE = {
  STROKE_COMMIT: 1,
  STROKE_HASH_ACK: 2,
  STROKE_UNDO: 3,
  STROKE_CLEAR: 4,
  STROKE_DRAFT: 5,
  HOST_PERMISSION_SYNC: 6,
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

function clampInt16(val: number): number {
  const rounded = Math.round(val);
  return rounded < -32767 ? -32767 : rounded > 32767 ? 32767 : rounded;
}

function encodeOctNormal(nx: number, ny: number, nz: number): [number, number] {
  const sum = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
  let ox = nx / sum;
  let oy = ny / sum;
  if (nz < 0) {
    const prevX = ox;
    ox = (1 - Math.abs(oy)) * (ox >= 0 ? 1 : -1);
    oy = (1 - Math.abs(prevX)) * (oy >= 0 ? 1 : -1);
  }
  return [
    Math.max(-127, Math.min(127, Math.round(ox * 127))),
    Math.max(-127, Math.min(127, Math.round(oy * 127))),
  ];
}

function decodeOctNormal(qx: number, qy: number): [number, number, number] {
  let x = qx / 127;
  let y = qy / 127;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const prevX = x;
    x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    y = (1 - Math.abs(prevX)) * (y >= 0 ? 1 : -1);
  }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

export function encodeTelestratorStroke(
  stroke: TelestratorStroke,
  isDraft = false
): Uint8Array {
  const idBytes = textEncoder.encode(stroke.id);
  const authorBytes = textEncoder.encode(stroke.authorId);
  const pointCount = stroke.points.length;
  const headerSize = STROKE_HEADER_BYTES + idBytes.length + authorBytes.length;
  const payloadSize = pointCount * BYTES_PER_POINT;
  const buffer = new ArrayBuffer(headerSize + payloadSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  let offset = 0;
  view.setUint32(offset, WIRE_MAGIC, true);
  offset += 4;
  view.setUint8(
    offset,
    isDraft ? TELESTRATOR_WIRE_MSG_TYPE.STROKE_DRAFT : TELESTRATOR_WIRE_MSG_TYPE.STROKE_COMMIT
  );
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
  view.setUint8(offset, stroke.presetIndex & 0x03);
  offset += 1;
  view.setUint8(offset, 0);
  offset += 1;
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
  view.setUint32(offset, stroke.strokeSeq >>> 0, true);
  offset += 4;

  out.set(idBytes, offset);
  offset += idBytes.length;
  out.set(authorBytes, offset);
  offset += authorBytes.length;

  for (let i = 0; i < pointCount; i++) {
    const pt = stroke.points[i];
    view.setInt16(offset, clampInt16(pt.x), true);
    view.setInt16(offset + 2, clampInt16(pt.y), true);
    view.setInt16(offset + 4, clampInt16(pt.z), true);
    const [qx, qy] = encodeOctNormal(pt.nx, pt.ny, pt.nz);
    view.setInt8(offset + 6, qx);
    view.setInt8(offset + 7, qy);
    offset += BYTES_PER_POINT;
  }

  return out;
}

export function decodeTelestratorStroke(
  bytes: Uint8Array
): { stroke: TelestratorStroke; isDraft: boolean } | null {
  if (bytes.byteLength < STROKE_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== WIRE_MAGIC) return null;
  const msgType = view.getUint8(4);
  if (
    msgType !== TELESTRATOR_WIRE_MSG_TYPE.STROKE_COMMIT &&
    msgType !== TELESTRATOR_WIRE_MSG_TYPE.STROKE_DRAFT
  ) {
    return null;
  }

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
  const rawPreset = view.getUint8(30);
  const presetIndex: TelestratorPresetIndex = rawPreset === 1 ? 1 : rawPreset === 2 ? 2 : 0;
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
  const strokeSeq = view.getUint32(68, true);

  let offset = STROKE_HEADER_BYTES;
  const expectedSize = offset + idLen + authorLen + pointCount * BYTES_PER_POINT;
  if (bytes.byteLength < expectedSize) return null;

  const id = textDecoder.decode(bytes.subarray(offset, offset + idLen));
  offset += idLen;
  const authorId = textDecoder.decode(bytes.subarray(offset, offset + authorLen));
  offset += authorLen;

  const points: TelestratorPoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    const [nx, ny, nz] = decodeOctNormal(view.getInt8(offset + 6), view.getInt8(offset + 7));
    points.push({
      x: view.getInt16(offset, true),
      y: view.getInt16(offset + 2, true),
      z: view.getInt16(offset + 4, true),
      nx,
      ny,
      nz,
    });
    offset += BYTES_PER_POINT;
  }

  const computedHash = computeStrokeHash(
    tool,
    colorId,
    presetIndex,
    opacity,
    widthRefPx,
    arrowLengthRefPx,
    arrowWidthRefPx,
    points
  );
  return {
    isDraft: msgType === TELESTRATOR_WIRE_MSG_TYPE.STROKE_DRAFT,
    stroke: {
      id,
      authorId,
      strokeSeq,
      tool,
      colorId,
      presetIndex,
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
    },
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

export interface TelestratorHostPermissionSync {
  allowClientDrawing: boolean;
  strokesVisible: boolean;
  allowedClientIds: string[];
}

export function encodeHostPermissionSync(sync: TelestratorHostPermissionSync): Uint8Array {
  const jsonBytes = textEncoder.encode(JSON.stringify(sync.allowedClientIds));
  const buffer = new ArrayBuffer(10 + jsonBytes.length);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  view.setUint32(0, WIRE_MAGIC, true);
  view.setUint8(4, TELESTRATOR_WIRE_MSG_TYPE.HOST_PERMISSION_SYNC);
  view.setUint8(5, sync.allowClientDrawing ? 1 : 0);
  view.setUint8(6, sync.strokesVisible ? 1 : 0);
  view.setUint8(7, 0);
  view.setUint16(8, jsonBytes.length, true);
  out.set(jsonBytes, 10);
  return out;
}

export function decodeHostPermissionSync(
  bytes: Uint8Array
): TelestratorHostPermissionSync | null {
  if (bytes.byteLength < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== WIRE_MAGIC) return null;
  if (view.getUint8(4) !== TELESTRATOR_WIRE_MSG_TYPE.HOST_PERMISSION_SYNC) return null;
  const allowClientDrawing = view.getUint8(5) === 1;
  const strokesVisible = view.getUint8(6) === 1;
  const jsonLen = view.getUint16(8, true);
  if (bytes.byteLength < 10 + jsonLen) return null;
  try {
    const parsed = JSON.parse(textDecoder.decode(bytes.subarray(10, 10 + jsonLen)));
    const allowedClientIds = Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
    return { allowClientDrawing, strokesVisible, allowedClientIds };
  } catch {
    return null;
  }
}
