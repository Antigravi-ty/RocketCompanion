/**
 * src/network/protocol/ReplicationBusProtocol.ts
 * Dual-mode Room Replication Bus protocol, activity hot-switch signaling,
 * dynamic packet section flags, and 16-byte sparse Ping-Pong binary codec.
 */

export const REPLICATION_MODES = Object.freeze({
  CONTINUOUS: 'continuous',
  SPARSE: 'sparse',
} as const);

export type ReplicationMode = (typeof REPLICATION_MODES)[keyof typeof REPLICATION_MODES];

export const ACTIVITY_IDS = Object.freeze({
  LOBBY: 'lobby',
  MATCH: 'match',
  FREEPLAY: 'freeplay',
  MULTIPLAYER_TRAINING: 'multiplayer_training',
  REPLAY: 'replay',
  SANDBOX: 'sandbox',
} as const);

export type ActivityId = (typeof ACTIVITY_IDS)[keyof typeof ACTIVITY_IDS] | string;

export type MultiplayerTrainingBoostPolicy =
  | 'limited'
  | 'limit_when_aerial'
  | 'unlimited'
  | 'custom';

export interface MultiplayerTrainingConfig {
  boostPolicy: MultiplayerTrainingBoostPolicy;
  perPlayerBoost?: Record<string, MultiplayerTrainingBoostPolicy>;
  ghostModeEnabled: boolean;
  hideScoreboard: boolean;
  goalReplayEnabled: boolean;
}

export type SpectatorSyncMode = 'gameplay_only' | 'mirror_host_ui';
export type TelestratorPermission = 'host_only' | 'all_peers';

export interface FloatingWindowSyncEntry {
  id: string;
  isOpen: boolean;
  isMinimized: boolean;
}

export interface GlobalUiStateBroadcast {
  epoch: number;
  activeMenuRoute: string;
  floatingWindows: FloatingWindowSyncEntry[];
  paused: boolean;
  pausedAtTick: number;
  telestratorPermission: TelestratorPermission;
}

export const REPLICATION_PACKET_FLAGS = Object.freeze({
  STATE_SNAPSHOT: 1 << 0,
  USER_INPUT: 1 << 1,
  CLOCK_AND_SCORE: 1 << 2,
  TELESTRATOR_SYNC: 1 << 3,
  CSR_SUMMARY: 1 << 4,
  SPARSE_FROZEN: 1 << 5,
  FOLLOW_HOST_CAMERA: 1 << 6,
  EDGE_LOCK_ACTION: 1 << 7,
});

export const ACTIVITY_DEFAULT_PACKET_FLAGS: Readonly<Record<string, number>> = Object.freeze({
  [ACTIVITY_IDS.LOBBY]:
    REPLICATION_PACKET_FLAGS.STATE_SNAPSHOT | REPLICATION_PACKET_FLAGS.USER_INPUT,
  [ACTIVITY_IDS.MATCH]:
    REPLICATION_PACKET_FLAGS.STATE_SNAPSHOT |
    REPLICATION_PACKET_FLAGS.USER_INPUT |
    REPLICATION_PACKET_FLAGS.CLOCK_AND_SCORE,
  [ACTIVITY_IDS.FREEPLAY]:
    REPLICATION_PACKET_FLAGS.STATE_SNAPSHOT | REPLICATION_PACKET_FLAGS.USER_INPUT,
  [ACTIVITY_IDS.MULTIPLAYER_TRAINING]:
    REPLICATION_PACKET_FLAGS.STATE_SNAPSHOT |
    REPLICATION_PACKET_FLAGS.USER_INPUT |
    REPLICATION_PACKET_FLAGS.CSR_SUMMARY,
  [ACTIVITY_IDS.REPLAY]:
    REPLICATION_PACKET_FLAGS.STATE_SNAPSHOT |
    REPLICATION_PACKET_FLAGS.TELESTRATOR_SYNC |
    REPLICATION_PACKET_FLAGS.FOLLOW_HOST_CAMERA,
  [ACTIVITY_IDS.SANDBOX]:
    REPLICATION_PACKET_FLAGS.STATE_SNAPSHOT |
    REPLICATION_PACKET_FLAGS.USER_INPUT |
    REPLICATION_PACKET_FLAGS.CSR_SUMMARY,
});

export interface RoomActivitySwitchPayload {
  activityId: ActivityId;
  epoch: number;
  seed?: number;
  replicationMode?: ReplicationMode;
  packetFlags?: number;
  authorityMask?: Record<string, string>;
  stateSummary?: Record<string, unknown> | null;
  followHostEnabled?: boolean;
}

export interface StatePausedAckPayload {
  epoch: number;
  pausedAtTick: number;
  clientSessionId?: string;
  checksum?: number;
}

export interface CsrStateBroadcastPayload {
  epoch: number;
  activityId: ActivityId;
  tick: number;
  followHostEnabled: boolean;
  spectatorSyncMode?: SpectatorSyncMode;
  cameraMode?: string;
  globalUiState?: GlobalUiStateBroadcast;
  uiSummary?: Record<string, unknown>;
}

export const PING_PONG_16B_MAGIC = 0x52;
export const PING_PONG_16B_SIZE = 16;
export const PING_PONG_KIND_PING = 1;
export const PING_PONG_KIND_PONG = 2;

export interface SparsePingPong16BFrame {
  kind: typeof PING_PONG_KIND_PING | typeof PING_PONG_KIND_PONG;
  epoch: number;
  seq: number;
  timestampMs: number;
  ackTick: number;
}

export function encodeSparsePingPong16B(frame: SparsePingPong16BFrame): Uint8Array {
  const buf = new Uint8Array(PING_PONG_16B_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint8(0, PING_PONG_16B_MAGIC);
  view.setUint8(1, frame.kind);
  view.setUint16(2, frame.epoch & 0xffff, true);
  view.setUint32(4, frame.seq >>> 0, true);
  view.setFloat32(8, frame.timestampMs, true);
  view.setUint32(12, frame.ackTick >>> 0, true);
  return buf;
}

export function isSparsePingPong16B(data: unknown): data is Uint8Array | ArrayBuffer {
  if (data instanceof Uint8Array) {
    return (
      data.byteLength === PING_PONG_16B_SIZE &&
      data[0] === PING_PONG_16B_MAGIC &&
      (data[1] === PING_PONG_KIND_PING || data[1] === PING_PONG_KIND_PONG)
    );
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength !== PING_PONG_16B_SIZE) return false;
    const u8 = new Uint8Array(data);
    return (
      u8[0] === PING_PONG_16B_MAGIC &&
      (u8[1] === PING_PONG_KIND_PING || u8[1] === PING_PONG_KIND_PONG)
    );
  }
  return false;
}

export function decodeSparsePingPong16B(
  data: Uint8Array | ArrayBuffer
): SparsePingPong16BFrame | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!isSparsePingPong16B(u8)) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const kind = view.getUint8(1) as typeof PING_PONG_KIND_PING | typeof PING_PONG_KIND_PONG;
  return {
    kind,
    epoch: view.getUint16(2, true),
    seq: view.getUint32(4, true),
    timestampMs: view.getFloat32(8, true),
    ackTick: view.getUint32(12, true),
  };
}

export function resolvePacketFlagsForActivity(
  activityId: ActivityId,
  replicationMode: ReplicationMode,
  followHostEnabled = false
): number {
  let flags =
    ACTIVITY_DEFAULT_PACKET_FLAGS[activityId] ??
    REPLICATION_PACKET_FLAGS.STATE_SNAPSHOT | REPLICATION_PACKET_FLAGS.USER_INPUT;
  if (replicationMode === REPLICATION_MODES.SPARSE) {
    flags |= REPLICATION_PACKET_FLAGS.SPARSE_FROZEN;
  }
  if (followHostEnabled) {
    flags |= REPLICATION_PACKET_FLAGS.FOLLOW_HOST_CAMERA | REPLICATION_PACKET_FLAGS.CSR_SUMMARY;
  }
  return flags;
}
