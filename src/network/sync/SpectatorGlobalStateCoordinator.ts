/**
 * src/network/sync/SpectatorGlobalStateCoordinator.ts
 * Coordinates split Match Real-time Data vs Global State Broadcast packets,
 * Replay Play/Pause ACK barriers, 1-10Hz sparse pause heartbeats, and Telestrator permissions.
 */

import type {
  FloatingWindowSyncEntry,
  GlobalUiStateBroadcast,
  StatePausedAckPayload,
  TelestratorPermission,
} from '../protocol/ReplicationBusProtocol.ts';

export const SPARSE_HEARTBEAT_MIN_HZ = 1;
export const SPARSE_HEARTBEAT_MAX_HZ = 10;
export const DEFAULT_SPARSE_HEARTBEAT_HZ = 2;

export function clampSparseHeartbeatHz(hz: number): number {
  if (!Number.isFinite(hz)) return DEFAULT_SPARSE_HEARTBEAT_HZ;
  return Math.max(SPARSE_HEARTBEAT_MIN_HZ, Math.min(SPARSE_HEARTBEAT_MAX_HZ, Math.round(hz)));
}

export class SpectatorGlobalStateCoordinator {
  private epoch = 0;
  private paused = false;
  private pausedAtTick = 0;
  private activeMenuRoute = 'main-menu';
  private telestratorPermission: TelestratorPermission = 'host_only';
  private readonly floatingWindows = new Map<string, FloatingWindowSyncEntry>();
  private readonly pausedAcks = new Map<string, StatePausedAckPayload>();
  private heartbeatHz = DEFAULT_SPARSE_HEARTBEAT_HZ;

  setEpoch(epoch: number): void {
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.pausedAcks.clear();
    }
  }

  setPausedState(paused: boolean, tick: number): void {
    this.paused = Boolean(paused);
    this.pausedAtTick = tick;
    if (!this.paused) {
      this.pausedAcks.clear();
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  setSparseHeartbeatHz(hz: number): void {
    this.heartbeatHz = clampSparseHeartbeatHz(hz);
  }

  getSparseHeartbeatIntervalMs(): number {
    return Math.round(1000 / this.heartbeatHz);
  }

  setTelestratorPermission(permission: TelestratorPermission): void {
    this.telestratorPermission = permission;
  }

  getTelestratorPermission(): TelestratorPermission {
    return this.telestratorPermission;
  }

  canPeerDrawTelestrator(isHost: boolean): boolean {
    if (isHost) return true;
    return this.telestratorPermission === 'all_peers';
  }

  setHostUiState(
    activeMenuRoute: string,
    windows: Array<{ id: string; isOpen: boolean; isMinimized: boolean }>
  ): void {
    this.activeMenuRoute = activeMenuRoute;
    this.floatingWindows.clear();
    for (const w of windows) {
      // Intentionally omit x/y coordinates, notifications, and telemetry
      this.floatingWindows.set(w.id, {
        id: w.id,
        isOpen: Boolean(w.isOpen),
        isMinimized: Boolean(w.isMinimized),
      });
    }
  }

  buildGlobalUiBroadcast(): GlobalUiStateBroadcast {
    return {
      epoch: this.epoch,
      activeMenuRoute: this.activeMenuRoute,
      floatingWindows: [...this.floatingWindows.values()].map((w) => ({ ...w })),
      paused: this.paused,
      pausedAtTick: this.pausedAtTick,
      telestratorPermission: this.telestratorPermission,
    };
  }

  recordPausedAck(ack: StatePausedAckPayload): boolean {
    if (ack.epoch !== this.epoch) return false;
    const key = ack.clientSessionId || 'anonymous';
    this.pausedAcks.set(key, { ...ack });
    return true;
  }

  getPausedAckCount(): number {
    return this.pausedAcks.size;
  }

  areAllPeersPausedAcked(expectedPeerIds: string[]): boolean {
    for (const id of expectedPeerIds) {
      if (!this.pausedAcks.has(id)) return false;
    }
    return true;
  }
}
