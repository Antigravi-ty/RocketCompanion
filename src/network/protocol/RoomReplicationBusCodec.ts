/**
 * src/network/protocol/RoomReplicationBusCodec.ts
 * Binary wire codec for the Unified Room Replication Bus:
 * - Dual-mode frames (Continuous snapshot vs 16-byte Sparse Ping/Pong + STATE_PAUSED_ACK)
 * - ROOM_ACTIVITY_SWITCH hot-swap signaling
 * - ActivityModeFlags bandwidth pruning
 * - Compact 8-car RoomStatePod binary protocol
 */

export const REPLICATION_BUS_MODE = Object.freeze({
  CONTINUOUS: 0,
  SPARSE: 1,
} as const);

export type ReplicationBusMode = (typeof REPLICATION_BUS_MODE)[keyof typeof REPLICATION_BUS_MODE];

export const ROOM_ACTIVITY_ID = Object.freeze({
  FREEPLAY: 0,
  MATCH: 1,
  REPLAY: 2,
  SANDBOX: 3,
  TRAINING: 4,
} as const);

export type RoomActivityId = (typeof ROOM_ACTIVITY_ID)[keyof typeof ROOM_ACTIVITY_ID];

export const ACTIVITY_MODE_FLAGS = Object.freeze({
  INCLUDE_PHYSICS: 1 << 0,
  INCLUDE_SCORE_AND_CLOCK: 1 << 1,
  INCLUDE_TELESTRATOR: 1 << 2,
  INCLUDE_GOAL_REPLAY_SKIP_LOCK: 1 << 3,
  CSR_FOLLOW_HOST: 1 << 4,
  SPARSE_FROZEN: 1 << 5,
} as const);

export const BUS_FRAME_TYPE = Object.freeze({
  BUS_SNAPSHOT: 0x10,
  SPARSE_PING: 0x11,
  SPARSE_PONG: 0x12,
  STATE_PAUSED_ACK: 0x13,
  ROOM_ACTIVITY_SWITCH: 0x14,
} as const);

export const SPARSE_KEEPALIVE_BYTES = 16;
export const STATE_PAUSED_ACK_BYTES = 12;
export const MAX_ROOM_CARS = 8;
const ROOM_CAR_BINARY_STRIDE = 44; // u8 slot, u8 team, u8 boost, u8 flags, 10x f32 (pos3, quat4, vel3)
const BALL_BINARY_STRIDE = 36; // 9x f32 (pos3, vel3, angVel3)

export interface ActivityFlagOptions {
  csrFollowHost?: boolean;
  goalReplaySkipLock?: boolean;
  includeTelestrator?: boolean;
}

export function resolveActivityModeFlags(
  activityId: RoomActivityId,
  busMode: ReplicationBusMode,
  options: ActivityFlagOptions = {}
): number {
  let flags = ACTIVITY_MODE_FLAGS.INCLUDE_PHYSICS;
  if (activityId === ROOM_ACTIVITY_ID.MATCH) {
    flags |= ACTIVITY_MODE_FLAGS.INCLUDE_SCORE_AND_CLOCK;
  }
  if (
    options.includeTelestrator ??
    (activityId === ROOM_ACTIVITY_ID.REPLAY || activityId === ROOM_ACTIVITY_ID.SANDBOX)
  ) {
    flags |= ACTIVITY_MODE_FLAGS.INCLUDE_TELESTRATOR;
  }
  if (options.goalReplaySkipLock) {
    flags |= ACTIVITY_MODE_FLAGS.INCLUDE_GOAL_REPLAY_SKIP_LOCK;
  }
  if (options.csrFollowHost) {
    flags |= ACTIVITY_MODE_FLAGS.CSR_FOLLOW_HOST;
  }
  if (busMode === REPLICATION_BUS_MODE.SPARSE) {
    flags |= ACTIVITY_MODE_FLAGS.SPARSE_FROZEN;
  }
  return flags;
}

export interface SparseKeepaliveFrame {
  frameType: typeof BUS_FRAME_TYPE.SPARSE_PING | typeof BUS_FRAME_TYPE.SPARSE_PONG;
  busMode: ReplicationBusMode;
  modeFlags: number;
  seq: number;
  timestampMs: number;
}

export function encodeSparseKeepaliveFrame(frame: SparseKeepaliveFrame): Uint8Array {
  const buf = new ArrayBuffer(SPARSE_KEEPALIVE_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, frame.frameType & 0xff);
  view.setUint8(1, frame.busMode & 0xff);
  view.setUint16(2, frame.modeFlags & 0xffff, false);
  view.setUint32(4, frame.seq >>> 0, false);
  view.setFloat64(8, frame.timestampMs, false);
  return new Uint8Array(buf);
}

export function decodeSparseKeepaliveFrame(
  input: ArrayBuffer | Uint8Array | DataView
): SparseKeepaliveFrame | null {
  const view = toDataView(input);
  if (!view || view.byteLength < SPARSE_KEEPALIVE_BYTES) return null;
  const frameType = view.getUint8(0);
  if (frameType !== BUS_FRAME_TYPE.SPARSE_PING && frameType !== BUS_FRAME_TYPE.SPARSE_PONG) {
    return null;
  }
  return {
    frameType,
    busMode: view.getUint8(1) === REPLICATION_BUS_MODE.SPARSE ? 1 : 0,
    modeFlags: view.getUint16(2, false),
    seq: view.getUint32(4, false),
    timestampMs: view.getFloat64(8, false),
  };
}

export interface StatePausedAckFrame {
  flags: number;
  seq: number;
  frozenTick: number;
  stateHash: number;
}

export function encodeStatePausedAckFrame(frame: StatePausedAckFrame): Uint8Array {
  const buf = new ArrayBuffer(STATE_PAUSED_ACK_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, BUS_FRAME_TYPE.STATE_PAUSED_ACK);
  view.setUint8(1, frame.flags & 0xff);
  view.setUint16(2, frame.seq & 0xffff, false);
  view.setInt32(4, frame.frozenTick | 0, false);
  view.setUint32(8, frame.stateHash >>> 0, false);
  return new Uint8Array(buf);
}

export function decodeStatePausedAckFrame(
  input: ArrayBuffer | Uint8Array | DataView
): StatePausedAckFrame | null {
  const view = toDataView(input);
  if (!view || view.byteLength < STATE_PAUSED_ACK_BYTES) return null;
  if (view.getUint8(0) !== BUS_FRAME_TYPE.STATE_PAUSED_ACK) return null;
  return {
    flags: view.getUint8(1),
    seq: view.getUint16(2, false),
    frozenTick: view.getInt32(4, false),
    stateHash: view.getUint32(8, false),
  };
}

export interface RoomActivitySwitchFrame {
  activityId: RoomActivityId;
  modeFlags: number;
  seed: number;
  authorityMask: number;
  seq: number;
  payloadJson?: string;
}

export function encodeRoomActivitySwitchFrame(frame: RoomActivitySwitchFrame): Uint8Array {
  const payloadBytes = frame.payloadJson ? new TextEncoder().encode(frame.payloadJson) : null;
  const payloadLen = payloadBytes ? Math.min(65535, payloadBytes.byteLength) : 0;
  const buf = new ArrayBuffer(18 + payloadLen);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  view.setUint8(0, BUS_FRAME_TYPE.ROOM_ACTIVITY_SWITCH);
  view.setUint8(1, frame.activityId & 0xff);
  view.setUint16(2, frame.modeFlags & 0xffff, false);
  view.setUint32(4, frame.seed >>> 0, false);
  view.setUint32(8, frame.authorityMask >>> 0, false);
  view.setUint32(12, frame.seq >>> 0, false);
  view.setUint16(16, payloadLen, false);
  if (payloadBytes && payloadLen > 0) {
    out.set(payloadBytes.subarray(0, payloadLen), 18);
  }
  return out;
}

export function decodeRoomActivitySwitchFrame(
  input: ArrayBuffer | Uint8Array | DataView
): RoomActivitySwitchFrame | null {
  const view = toDataView(input);
  if (!view || view.byteLength < 18) return null;
  if (view.getUint8(0) !== BUS_FRAME_TYPE.ROOM_ACTIVITY_SWITCH) return null;
  const payloadLen = view.getUint16(16, false);
  if (view.byteLength < 18 + payloadLen) return null;
  let payloadJson: string | undefined;
  if (payloadLen > 0) {
    const slice = new Uint8Array(view.buffer, view.byteOffset + 18, payloadLen);
    payloadJson = new TextDecoder().decode(slice);
  }
  return {
    activityId: view.getUint8(1) as RoomActivityId,
    modeFlags: view.getUint16(2, false),
    seed: view.getUint32(4, false),
    authorityMask: view.getUint32(8, false),
    seq: view.getUint32(12, false),
    payloadJson,
  };
}

export interface RoomCarPodState {
  slot: number;
  team: number;
  boost: number;
  flags: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
  vel: [number, number, number];
}

export interface RoomBallPodState {
  pos: [number, number, number];
  vel: [number, number, number];
  angVel: [number, number, number];
}

export interface RoomStatePod {
  tick: number;
  activityId: RoomActivityId;
  modeFlags: number;
  activeCarMask: number;
  authorityMask: number;
  jumpSkipEdgeMask: number;
  scoreBlue?: number;
  scoreOrange?: number;
  clockSeconds?: number;
  ball?: RoomBallPodState;
  cars: RoomCarPodState[];
}

export function encodeRoomStatePod(pod: RoomStatePod): Uint8Array {
  const hasScore = (pod.modeFlags & ACTIVITY_MODE_FLAGS.INCLUDE_SCORE_AND_CLOCK) !== 0;
  const hasPhysics =
    (pod.modeFlags & ACTIVITY_MODE_FLAGS.INCLUDE_PHYSICS) !== 0 && Boolean(pod.ball);
  const cars = pod.cars.slice(0, MAX_ROOM_CARS);
  let activeMask = pod.activeCarMask & 0xff;
  if (activeMask === 0 && cars.length > 0) {
    for (let i = 0; i < cars.length; i++) {
      activeMask |= 1 << (cars[i].slot & 7);
    }
  }
  const activeCount = hasPhysics ? countBits8(activeMask) : 0;
  const totalBytes =
    10 +
    (hasScore ? 8 : 0) +
    (hasPhysics ? BALL_BINARY_STRIDE + activeCount * ROOM_CAR_BINARY_STRIDE : 0);

  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  view.setUint8(0, BUS_FRAME_TYPE.BUS_SNAPSHOT);
  view.setUint8(1, pod.activityId & 0xff);
  view.setUint16(2, pod.modeFlags & 0xffff, false);
  view.setInt32(4, pod.tick | 0, false);
  view.setUint8(8, activeMask);
  view.setUint8(9, ((pod.authorityMask & 0x0f) << 4) | (pod.jumpSkipEdgeMask & 0x0f));
  let offset = 10;

  if (hasScore) {
    view.setUint16(offset, (pod.scoreBlue ?? 0) & 0xffff, false);
    view.setUint16(offset + 2, (pod.scoreOrange ?? 0) & 0xffff, false);
    view.setFloat32(offset + 4, pod.clockSeconds ?? 0, false);
    offset += 8;
  }

  if (hasPhysics && pod.ball) {
    const b = pod.ball;
    view.setFloat32(offset, b.pos[0], false);
    view.setFloat32(offset + 4, b.pos[1], false);
    view.setFloat32(offset + 8, b.pos[2], false);
    view.setFloat32(offset + 12, b.vel[0], false);
    view.setFloat32(offset + 16, b.vel[1], false);
    view.setFloat32(offset + 20, b.vel[2], false);
    view.setFloat32(offset + 24, b.angVel[0], false);
    view.setFloat32(offset + 28, b.angVel[1], false);
    view.setFloat32(offset + 32, b.angVel[2], false);
    offset += BALL_BINARY_STRIDE;

    const bySlot = new Map<number, RoomCarPodState>();
    for (let i = 0; i < cars.length; i++) {
      bySlot.set(cars[i].slot & 7, cars[i]);
    }
    for (let slot = 0; slot < MAX_ROOM_CARS; slot++) {
      if ((activeMask & (1 << slot)) === 0) continue;
      const car = bySlot.get(slot);
      view.setUint8(offset, slot);
      view.setUint8(offset + 1, (car?.team ?? 0) & 0xff);
      view.setUint8(offset + 2, Math.max(0, Math.min(255, Math.round(car?.boost ?? 0))));
      view.setUint8(offset + 3, (car?.flags ?? 0) & 0xff);
      view.setFloat32(offset + 4, car?.pos[0] ?? 0, false);
      view.setFloat32(offset + 8, car?.pos[1] ?? 0, false);
      view.setFloat32(offset + 12, car?.pos[2] ?? 0, false);
      view.setFloat32(offset + 16, car?.quat[0] ?? 0, false);
      view.setFloat32(offset + 20, car?.quat[1] ?? 0, false);
      view.setFloat32(offset + 24, car?.quat[2] ?? 0, false);
      view.setFloat32(offset + 28, car?.quat[3] ?? 1, false);
      view.setFloat32(offset + 32, car?.vel[0] ?? 0, false);
      view.setFloat32(offset + 36, car?.vel[1] ?? 0, false);
      view.setFloat32(offset + 40, car?.vel[2] ?? 0, false);
      offset += ROOM_CAR_BINARY_STRIDE;
    }
  }

  return new Uint8Array(buf);
}

export function decodeRoomStatePod(
  input: ArrayBuffer | Uint8Array | DataView
): RoomStatePod | null {
  const view = toDataView(input);
  if (!view || view.byteLength < 10) return null;
  if (view.getUint8(0) !== BUS_FRAME_TYPE.BUS_SNAPSHOT) return null;

  const activityId = view.getUint8(1) as RoomActivityId;
  const modeFlags = view.getUint16(2, false);
  const tick = view.getInt32(4, false);
  const activeCarMask = view.getUint8(8);
  const packedMasks = view.getUint8(9);
  const authorityMask = (packedMasks >> 4) & 0x0f;
  const jumpSkipEdgeMask = packedMasks & 0x0f;
  let offset = 10;

  let scoreBlue: number | undefined;
  let scoreOrange: number | undefined;
  let clockSeconds: number | undefined;
  if ((modeFlags & ACTIVITY_MODE_FLAGS.INCLUDE_SCORE_AND_CLOCK) !== 0) {
    if (view.byteLength < offset + 8) return null;
    scoreBlue = view.getUint16(offset, false);
    scoreOrange = view.getUint16(offset + 2, false);
    clockSeconds = view.getFloat32(offset + 4, false);
    offset += 8;
  }

  let ball: RoomBallPodState | undefined;
  const cars: RoomCarPodState[] = [];
  if (
    (modeFlags & ACTIVITY_MODE_FLAGS.INCLUDE_PHYSICS) !== 0 &&
    view.byteLength >= offset + BALL_BINARY_STRIDE
  ) {
    ball = {
      pos: [
        view.getFloat32(offset, false),
        view.getFloat32(offset + 4, false),
        view.getFloat32(offset + 8, false),
      ],
      vel: [
        view.getFloat32(offset + 12, false),
        view.getFloat32(offset + 16, false),
        view.getFloat32(offset + 20, false),
      ],
      angVel: [
        view.getFloat32(offset + 24, false),
        view.getFloat32(offset + 28, false),
        view.getFloat32(offset + 32, false),
      ],
    };
    offset += BALL_BINARY_STRIDE;

    const activeCount = countBits8(activeCarMask);
    if (view.byteLength < offset + activeCount * ROOM_CAR_BINARY_STRIDE) return null;
    for (let i = 0; i < activeCount; i++) {
      cars.push({
        slot: view.getUint8(offset),
        team: view.getUint8(offset + 1),
        boost: view.getUint8(offset + 2),
        flags: view.getUint8(offset + 3),
        pos: [
          view.getFloat32(offset + 4, false),
          view.getFloat32(offset + 8, false),
          view.getFloat32(offset + 12, false),
        ],
        quat: [
          view.getFloat32(offset + 16, false),
          view.getFloat32(offset + 20, false),
          view.getFloat32(offset + 24, false),
          view.getFloat32(offset + 28, false),
        ],
        vel: [
          view.getFloat32(offset + 32, false),
          view.getFloat32(offset + 36, false),
          view.getFloat32(offset + 40, false),
        ],
      });
      offset += ROOM_CAR_BINARY_STRIDE;
    }
  }

  return {
    tick,
    activityId,
    modeFlags,
    activeCarMask,
    authorityMask,
    jumpSkipEdgeMask,
    scoreBlue,
    scoreOrange,
    clockSeconds,
    ball,
    cars,
  };
}

export function computeRoomStatePodHash(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function countBits8(mask: number): number {
  let m = mask & 0xff;
  let count = 0;
  while (m !== 0) {
    count += m & 1;
    m >>= 1;
  }
  return count;
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
