/**
 * src/network/sync/RoomReplicationBus.ts
 * Unified Room Replication Bus managing Continuous vs Sparse dual-mode replication,
 * 2Hz 16-byte Sparse Ping-Pong keepalive, STATE_PAUSED_ACK consensus,
 * ROOM_ACTIVITY_SWITCH hot-swapping, and GoalReplay jump edge-lock.
 */

import {
  BUS_FRAME_TYPE,
  REPLICATION_BUS_MODE,
  ROOM_ACTIVITY_ID,
  computeRoomStatePodHash,
  decodeRoomActivitySwitchFrame,
  decodeRoomStatePod,
  decodeSparseKeepaliveFrame,
  decodeStatePausedAckFrame,
  encodeRoomActivitySwitchFrame,
  encodeRoomStatePod,
  encodeSparseKeepaliveFrame,
  encodeStatePausedAckFrame,
  resolveActivityModeFlags,
  type ActivityFlagOptions,
  type ReplicationBusMode,
  type RoomActivityId,
  type RoomActivitySwitchFrame,
  type RoomStatePod,
  type SparseKeepaliveFrame,
  type StatePausedAckFrame,
} from '../protocol/RoomReplicationBusCodec.ts';

export interface ReplicationBusTransportPort {
  sendUnreliable: (payload: Uint8Array) => void;
  sendReliable: (payload: Uint8Array) => void;
}

export interface ReplicationBusHandlers {
  onSnapshot?: (pod: RoomStatePod) => void;
  onActivitySwitch?: (frame: RoomActivitySwitchFrame) => void;
  onStatePausedAck?: (peerId: string, frame: StatePausedAckFrame) => void;
  onKeepalive?: (frame: SparseKeepaliveFrame, rttMs: number | null) => void;
}

const SPARSE_PING_INTERVAL_MS = 500; // 2Hz keepalive in Sparse/Frozen mode

export class RoomReplicationBus {
  busMode: ReplicationBusMode = REPLICATION_BUS_MODE.CONTINUOUS;
  activityId: RoomActivityId = ROOM_ACTIVITY_ID.FREEPLAY;
  modeFlags: number;
  authorityMask = 0x01;
  frozenTick = -1;
  frozenStateHash = 0;

  private seq = 0;
  private lastSparsePingMs = 0;
  private jumpPrevMask = 0;
  private jumpSkipEdgeMask = 0;
  private readonly pausedAckedPeers = new Map<string, number>();
  private transport: ReplicationBusTransportPort | null = null;
  private handlers: ReplicationBusHandlers = {};

  constructor(initialActivity: RoomActivityId = ROOM_ACTIVITY_ID.FREEPLAY) {
    this.activityId = initialActivity;
    this.modeFlags = resolveActivityModeFlags(this.activityId, this.busMode);
  }

  bindTransport(transport: ReplicationBusTransportPort | null): void {
    this.transport = transport;
  }

  setHandlers(handlers: ReplicationBusHandlers): void {
    this.handlers = handlers;
  }

  updateModeFlags(options: ActivityFlagOptions = {}): number {
    this.modeFlags = resolveActivityModeFlags(this.activityId, this.busMode, options);
    return this.modeFlags;
  }

  switchActivity(
    activityId: RoomActivityId,
    seed: number,
    authorityMask: number,
    payloadJson?: string,
    options: ActivityFlagOptions = {}
  ): RoomActivitySwitchFrame {
    this.activityId = activityId;
    this.authorityMask = authorityMask & 0xff;
    this.busMode = REPLICATION_BUS_MODE.CONTINUOUS;
    this.pausedAckedPeers.clear();
    this.modeFlags = resolveActivityModeFlags(activityId, this.busMode, options);

    const frame: RoomActivitySwitchFrame = {
      activityId,
      modeFlags: this.modeFlags,
      seed: seed >>> 0,
      authorityMask: this.authorityMask,
      seq: ++this.seq,
      payloadJson,
    };
    this.transport?.sendReliable(encodeRoomActivitySwitchFrame(frame));
    return frame;
  }

  enterSparseFrozenMode(frozenPod: RoomStatePod, nowMs = performance.now()): void {
    this.busMode = REPLICATION_BUS_MODE.SPARSE;
    this.modeFlags = resolveActivityModeFlags(this.activityId, this.busMode, {
      csrFollowHost: (this.modeFlags & 0x10) !== 0,
    });
    const encoded = encodeRoomStatePod({
      ...frozenPod,
      activityId: this.activityId,
      modeFlags: this.modeFlags,
    });
    this.frozenTick = frozenPod.tick;
    this.frozenStateHash = computeRoomStatePodHash(encoded);
    this.pausedAckedPeers.clear();
    this.lastSparsePingMs = nowMs;
    this.transport?.sendReliable(encoded);
  }

  exitSparseMode(): void {
    this.busMode = REPLICATION_BUS_MODE.CONTINUOUS;
    this.frozenTick = -1;
    this.frozenStateHash = 0;
    this.pausedAckedPeers.clear();
    this.modeFlags = resolveActivityModeFlags(this.activityId, this.busMode);
  }

  publishSnapshot(pod: RoomStatePod): Uint8Array {
    const encoded = encodeRoomStatePod({
      ...pod,
      activityId: this.activityId,
      modeFlags: this.modeFlags,
      jumpSkipEdgeMask: this.jumpSkipEdgeMask,
    });
    if (this.busMode === REPLICATION_BUS_MODE.CONTINUOUS) {
      this.transport?.sendUnreliable(encoded);
    } else {
      this.frozenTick = pod.tick;
      this.frozenStateHash = computeRoomStatePodHash(encoded);
      this.transport?.sendReliable(encoded);
    }
    return encoded;
  }

  tickKeepalive(nowMs = performance.now()): boolean {
    if (this.busMode !== REPLICATION_BUS_MODE.SPARSE) return false;
    if (nowMs - this.lastSparsePingMs < SPARSE_PING_INTERVAL_MS) return false;
    this.lastSparsePingMs = nowMs;
    const ping = encodeSparseKeepaliveFrame({
      frameType: BUS_FRAME_TYPE.SPARSE_PING,
      busMode: this.busMode,
      modeFlags: this.modeFlags,
      seq: ++this.seq,
      timestampMs: nowMs,
    });
    this.transport?.sendUnreliable(ping);
    return true;
  }

  updateJumpSkipEdgeLock(carSlot: number, jumpPressed: boolean): number {
    const bit = 1 << (carSlot & 7);
    const prevPressed = (this.jumpPrevMask & bit) !== 0;
    if (jumpPressed && !prevPressed) {
      this.jumpSkipEdgeMask ^= bit;
    }
    if (jumpPressed) {
      this.jumpPrevMask |= bit;
    } else {
      this.jumpPrevMask &= ~bit;
    }
    return this.jumpSkipEdgeMask;
  }

  areAllPeersPausedAcked(requiredPeerIds: ReadonlyArray<string>): boolean {
    if (requiredPeerIds.length === 0) return true;
    for (let i = 0; i < requiredPeerIds.length; i++) {
      if (this.pausedAckedPeers.get(requiredPeerIds[i]) !== this.frozenTick) {
        return false;
      }
    }
    return true;
  }

  handleInboundBytes(peerId: string, bytes: Uint8Array, nowMs = performance.now()): boolean {
    if (bytes.byteLength === 0) return false;
    const frameType = bytes[0];
    if (frameType === BUS_FRAME_TYPE.BUS_SNAPSHOT) {
      const pod = decodeRoomStatePod(bytes);
      if (!pod) return false;
      this.activityId = pod.activityId;
      this.modeFlags = pod.modeFlags;
      if ((pod.modeFlags & 0x20) !== 0) {
        this.busMode = REPLICATION_BUS_MODE.SPARSE;
        this.frozenTick = pod.tick;
        this.frozenStateHash = computeRoomStatePodHash(bytes);
        this.transport?.sendReliable(
          encodeStatePausedAckFrame({
            flags: pod.modeFlags & 0xff,
            seq: ++this.seq,
            frozenTick: pod.tick,
            stateHash: this.frozenStateHash,
          })
        );
      } else {
        this.busMode = REPLICATION_BUS_MODE.CONTINUOUS;
      }
      this.handlers.onSnapshot?.(pod);
      return true;
    }

    if (frameType === BUS_FRAME_TYPE.SPARSE_PING) {
      const ping = decodeSparseKeepaliveFrame(bytes);
      if (!ping) return false;
      this.transport?.sendUnreliable(
        encodeSparseKeepaliveFrame({
          frameType: BUS_FRAME_TYPE.SPARSE_PONG,
          busMode: this.busMode,
          modeFlags: this.modeFlags,
          seq: ping.seq,
          timestampMs: ping.timestampMs,
        })
      );
      this.handlers.onKeepalive?.(ping, null);
      return true;
    }

    if (frameType === BUS_FRAME_TYPE.SPARSE_PONG) {
      const pong = decodeSparseKeepaliveFrame(bytes);
      if (!pong) return false;
      const rttMs = Math.max(0, nowMs - pong.timestampMs);
      this.handlers.onKeepalive?.(pong, rttMs);
      return true;
    }

    if (frameType === BUS_FRAME_TYPE.STATE_PAUSED_ACK) {
      const ack = decodeStatePausedAckFrame(bytes);
      if (!ack) return false;
      this.pausedAckedPeers.set(peerId, ack.frozenTick);
      this.handlers.onStatePausedAck?.(peerId, ack);
      return true;
    }

    if (frameType === BUS_FRAME_TYPE.ROOM_ACTIVITY_SWITCH) {
      const sw = decodeRoomActivitySwitchFrame(bytes);
      if (!sw) return false;
      this.activityId = sw.activityId;
      this.modeFlags = sw.modeFlags;
      this.authorityMask = sw.authorityMask;
      this.busMode =
        (sw.modeFlags & 0x20) !== 0 ? REPLICATION_BUS_MODE.SPARSE : REPLICATION_BUS_MODE.CONTINUOUS;
      this.handlers.onActivitySwitch?.(sw);
      return true;
    }

    return false;
  }
}
