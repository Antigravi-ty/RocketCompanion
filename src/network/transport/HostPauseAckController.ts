/**
 * HostPauseAckController.ts
 * Reliable Pause/Resume ACK state machine for Dev Sync Room & Replay Watch Together.
 * States:
 *  - 'playing': physics snapshots stream normally (60/120 Hz).
 *  - 'awaitingPauseAck': Host paused, stops streaming physics snapshots, retries PAUSE_STATE_SYNC
 *    every 100ms per un-ACKed peerId (up to maxRetryMs = 5000ms).
 *  - 'pausedIdle': all peers ACKed (or timeout reached); 0 Hz physics state traffic,
 *    1-2 Hz lightweight presence_ping keepalive heartbeat.
 */

import {
  DEFAULT_PAUSE_HEARTBEAT_HZ,
  getPauseHeartbeatIntervalMs,
  type PauseStateAckPayload,
  type PauseStateSyncPayload,
  type PresencePingPayload,
} from '../protocol/GlobalWorkspaceProtocol.ts';

export type HostPauseAckState = 'playing' | 'awaitingPauseAck' | 'pausedIdle';

export interface HostPauseAckTickCallbacks {
  sendPauseStateSyncToPeer: (peerId: string, payload: PauseStateSyncPayload) => void;
  broadcastPresencePing: (payload: PresencePingPayload) => void;
  onPauseAckTimeout?: (unackedPeerIds: string[]) => void;
}

export class HostPauseAckController {
  state: HostPauseAckState = 'playing';
  pauseSeq = 0;
  paused = false;
  pausedAtTick = 0;
  snapshotHash: number | undefined = undefined;
  epoch = 0;
  heartbeatHz = DEFAULT_PAUSE_HEARTBEAT_HZ;
  retryIntervalMs = 100;
  maxRetryMs = 5000;

  readonly unackedPeers = new Set<string>();
  readonly ackedPeers = new Set<string>();
  readonly timedOutPeers = new Set<string>();

  private awaitingStartedAtMs = 0;
  private lastRetryAtMs = 0;
  private lastHeartbeatAtMs = 0;

  reset(): void {
    this.state = 'playing';
    this.pauseSeq = 0;
    this.paused = false;
    this.pausedAtTick = 0;
    this.snapshotHash = undefined;
    this.epoch = 0;
    this.unackedPeers.clear();
    this.ackedPeers.clear();
    this.timedOutPeers.clear();
    this.awaitingStartedAtMs = 0;
    this.lastRetryAtMs = 0;
    this.lastHeartbeatAtMs = 0;
  }

  shouldStreamPhysicsSnapshots(): boolean {
    return !this.paused;
  }

  getCurrentSyncPayload(): PauseStateSyncPayload {
    return {
      type: 'pause_state_sync',
      pauseSeq: this.pauseSeq,
      paused: this.paused,
      pausedAtTick: this.pausedAtTick,
      ...(this.snapshotHash !== undefined ? { snapshotHash: this.snapshotHash } : {}),
      ...(this.epoch > 0 ? { epoch: this.epoch } : {}),
    };
  }

  setPausedState(params: {
    paused: boolean;
    pausedAtTick: number;
    snapshotHash?: number;
    epoch?: number;
    heartbeatHz?: number;
    connectedPeerIds: readonly string[];
    nowMs?: number;
  }): PauseStateSyncPayload | null {
    const nowMs = params.nowMs ?? Date.now();
    const nextTick = Math.max(0, Math.round(params.pausedAtTick || 0));
    if (typeof params.heartbeatHz === 'number' && Number.isFinite(params.heartbeatHz)) {
      this.heartbeatHz = params.heartbeatHz;
    }
    if (typeof params.epoch === 'number' && Number.isFinite(params.epoch)) {
      this.epoch = Math.max(0, Math.round(params.epoch));
    }

    if (params.paused) {
      if (
        this.paused &&
        this.pausedAtTick === nextTick &&
        params.snapshotHash === this.snapshotHash
      ) {
        return null;
      }
      this.pauseSeq += 1;
      this.paused = true;
      this.pausedAtTick = nextTick;
      this.snapshotHash = params.snapshotHash;
      this.unackedPeers.clear();
      this.ackedPeers.clear();
      this.timedOutPeers.clear();
      for (const peerId of params.connectedPeerIds) {
        if (peerId) this.unackedPeers.add(peerId);
      }
      if (this.unackedPeers.size === 0) {
        this.state = 'pausedIdle';
        this.lastHeartbeatAtMs = nowMs;
      } else {
        this.state = 'awaitingPauseAck';
        this.awaitingStartedAtMs = nowMs;
        this.lastRetryAtMs = nowMs;
      }
      return this.getCurrentSyncPayload();
    }

    if (!this.paused) {
      return null;
    }
    this.pauseSeq += 1;
    this.paused = false;
    this.pausedAtTick = nextTick;
    this.snapshotHash = undefined;
    this.unackedPeers.clear();
    this.ackedPeers.clear();
    this.timedOutPeers.clear();
    this.state = 'playing';
    return this.getCurrentSyncPayload();
  }

  handlePauseAck(ack: PauseStateAckPayload, nowMs = Date.now()): boolean {
    if (!this.paused || ack.pauseSeq !== this.pauseSeq) {
      return false;
    }
    const peerId = ack.peerId || '';
    if (peerId) {
      this.unackedPeers.delete(peerId);
      this.ackedPeers.add(peerId);
    }
    if (this.state === 'awaitingPauseAck' && this.unackedPeers.size === 0) {
      this.state = 'pausedIdle';
      this.lastHeartbeatAtMs = nowMs;
    }
    return true;
  }

  onPeerConnected(peerId: string, nowMs = Date.now()): PauseStateSyncPayload | null {
    if (!this.paused || !peerId) return null;
    if (!this.ackedPeers.has(peerId)) {
      this.unackedPeers.add(peerId);
      if (this.state === 'pausedIdle') {
        this.state = 'awaitingPauseAck';
        this.awaitingStartedAtMs = nowMs;
        this.lastRetryAtMs = nowMs;
      }
    }
    return this.getCurrentSyncPayload();
  }

  onPeerDisconnected(peerId: string, nowMs = Date.now()): void {
    if (!peerId) return;
    this.unackedPeers.delete(peerId);
    this.ackedPeers.delete(peerId);
    this.timedOutPeers.delete(peerId);
    if (this.state === 'awaitingPauseAck' && this.unackedPeers.size === 0) {
      this.state = 'pausedIdle';
      this.lastHeartbeatAtMs = nowMs;
    }
  }

  tick(nowMs: number, callbacks: HostPauseAckTickCallbacks): void {
    if (this.state === 'awaitingPauseAck') {
      if (this.unackedPeers.size === 0) {
        this.state = 'pausedIdle';
        this.lastHeartbeatAtMs = nowMs;
        return;
      }
      if (nowMs - this.awaitingStartedAtMs >= this.maxRetryMs) {
        const timedOut = Array.from(this.unackedPeers);
        for (const id of timedOut) {
          this.timedOutPeers.add(id);
        }
        this.unackedPeers.clear();
        this.state = 'pausedIdle';
        this.lastHeartbeatAtMs = nowMs;
        callbacks.onPauseAckTimeout?.(timedOut);
        return;
      }
      if (nowMs - this.lastRetryAtMs >= this.retryIntervalMs) {
        this.lastRetryAtMs = nowMs;
        const payload = this.getCurrentSyncPayload();
        for (const peerId of this.unackedPeers) {
          callbacks.sendPauseStateSyncToPeer(peerId, payload);
        }
      }
      return;
    }

    if (this.state === 'pausedIdle') {
      const intervalMs = getPauseHeartbeatIntervalMs(this.heartbeatHz);
      if (nowMs - this.lastHeartbeatAtMs >= intervalMs) {
        this.lastHeartbeatAtMs = nowMs;
        callbacks.broadcastPresencePing({
          type: 'presence_ping',
          pauseSeq: this.pauseSeq,
          paused: true,
          pausedAtTick: this.pausedAtTick,
          ...(this.epoch > 0 ? { epoch: this.epoch } : {}),
        });
      }
    }
  }
}
