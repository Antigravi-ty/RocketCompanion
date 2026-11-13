/**
 * src/network/protocol/TunnelProtocol.ts
 * Network protocol v2.1 version metadata, expanded packet type registry,
 * and 8-byte binary tunnel envelope codec shared by Rust UDP and WebRTC transports.
 */

export const NETWORK_PROTOCOL_VERSION = Object.freeze({
  major: 2,
  minor: 1,
} as const);

export const NETWORK_PROTOCOL_VERSION_TAG =
  `${NETWORK_PROTOCOL_VERSION.major}.${NETWORK_PROTOCOL_VERSION.minor}` as const;

export const TUNNEL_ENVELOPE_MAGIC = 0x5243;
export const TUNNEL_ENVELOPE_HEADER_BYTES = 8;

export const TUNNEL_PACKET_TYPES = Object.freeze({
  PHYSICS_SNAPSHOT: 0x01,
  USER_INPUT: 0x02,
  RELIABLE_CONTROL: 0x03,
  PING_PONG_16B: 0x04,
  TELESTRATOR_SYNC: 0x05,
  TUNNEL_HANDSHAKE: 0x10,
  TUNNEL_KEEPALIVE: 0x11,
  UPNP_ENDPOINT_ADVERTISE: 0x12,
  CSR_STATE_BROADCAST: 0x20,
  ROOM_ACTIVITY_SWITCH: 0x21,
  DIAGNOSTIC_TELEMETRY: 0x30,
  CUSTOM_EXTENSION: 0x7f,
} as const);

export type TunnelPacketType = (typeof TUNNEL_PACKET_TYPES)[keyof typeof TUNNEL_PACKET_TYPES];

export const TUNNEL_ENVELOPE_FLAGS = Object.freeze({
  NONE: 0,
  COMPRESSED: 1 << 0,
  RELIABLE: 1 << 1,
  ENCRYPTED: 1 << 2,
  UPNP_ASSISTED: 1 << 3,
} as const);

export interface TunnelEnvelopeHeader {
  major: number;
  minor: number;
  packetType: TunnelPacketType | number;
  flags: number;
  payloadLength: number;
}

export interface DecodedTunnelEnvelope {
  header: TunnelEnvelopeHeader;
  payload: Uint8Array;
}

export function encodeTunnelEnvelope(
  packetType: TunnelPacketType | number,
  payload: Uint8Array,
  flags: number = TUNNEL_ENVELOPE_FLAGS.NONE
): Uint8Array {
  const payloadLen = payload.byteLength & 0xffff;
  const out = new Uint8Array(TUNNEL_ENVELOPE_HEADER_BYTES + payloadLen);
  const view = new DataView(out.buffer);
  view.setUint16(0, TUNNEL_ENVELOPE_MAGIC, false);
  view.setUint8(2, NETWORK_PROTOCOL_VERSION.major);
  view.setUint8(3, NETWORK_PROTOCOL_VERSION.minor);
  view.setUint8(4, packetType & 0xff);
  view.setUint8(5, flags & 0xff);
  view.setUint16(6, payloadLen, false);
  if (payloadLen > 0) {
    out.set(payload.subarray(0, payloadLen), TUNNEL_ENVELOPE_HEADER_BYTES);
  }
  return out;
}

export function isTunnelEnvelope(data: unknown): data is Uint8Array | ArrayBuffer {
  const bytes =
    data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  if (!bytes || bytes.byteLength < TUNNEL_ENVELOPE_HEADER_BYTES) return false;
  return bytes[0] === 0x52 && bytes[1] === 0x43;
}

export function decodeTunnelEnvelope(
  input: Uint8Array | ArrayBuffer | DataView
): DecodedTunnelEnvelope | null {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

  if (bytes.byteLength < TUNNEL_ENVELOPE_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, false) !== TUNNEL_ENVELOPE_MAGIC) return null;

  const major = view.getUint8(2);
  const minor = view.getUint8(3);
  const packetType = view.getUint8(4);
  const flags = view.getUint8(5);
  const payloadLength = view.getUint16(6, false);
  if (bytes.byteLength < TUNNEL_ENVELOPE_HEADER_BYTES + payloadLength) {
    return null;
  }

  return {
    header: {
      major,
      minor,
      packetType,
      flags,
      payloadLength,
    },
    payload: bytes.subarray(
      TUNNEL_ENVELOPE_HEADER_BYTES,
      TUNNEL_ENVELOPE_HEADER_BYTES + payloadLength
    ),
  };
}

const bridgeTextEncoder = new TextEncoder();
const bridgeTextDecoder = new TextDecoder();

export function encodeBridgeFrame(peerId: string, payload: Uint8Array): Uint8Array {
  const idBytes = bridgeTextEncoder.encode(peerId);
  const idLen = Math.min(255, idBytes.byteLength);
  const out = new Uint8Array(1 + idLen + payload.byteLength);
  out[0] = idLen;
  if (idLen > 0) {
    out.set(idBytes.subarray(0, idLen), 1);
  }
  out.set(payload, 1 + idLen);
  return out;
}

export function decodeBridgeFrame(
  frame: Uint8Array | ArrayBuffer
): { peerId: string; payload: Uint8Array } | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < 1) return null;
  const idLen = bytes[0];
  if (bytes.byteLength < 1 + idLen) return null;
  const peerId = bridgeTextDecoder.decode(bytes.subarray(1, 1 + idLen));
  return {
    peerId,
    payload: bytes.subarray(1 + idLen),
  };
}

