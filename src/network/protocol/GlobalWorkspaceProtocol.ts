/**
 * src/network/protocol/GlobalWorkspaceProtocol.ts
 * Global State Broadcast Packet (separated from Match Real-time Data Packet).
 * Carries menu route, floating window open/minimized manifest (without screen coords,
 * notifications, or telemetry), telestrator permission, and replay pause heartbeat state.
 */

export type SpectateMode = 'spectate_state_only' | 'spectate_mirror';
export type TelestratorDrawPermission = 'host_only' | 'everyone';

export const PAUSE_HEARTBEAT_MIN_HZ = 1;
export const PAUSE_HEARTBEAT_MAX_HZ = 10;
export const DEFAULT_PAUSE_HEARTBEAT_HZ = 2;

export interface FloatingWindowSyncEntry {
  id: string;
  isOpen: boolean;
  isMinimized: boolean;
}

export interface GlobalWorkspaceBroadcastPayload {
  epoch: number;
  tick: number;
  menuRoute: string | null;
  openFloatingWindows: FloatingWindowSyncEntry[];
  telestratorPermission: TelestratorDrawPermission;
  playbackPaused: boolean;
  pausedAtTick: number;
  pauseHeartbeatHz: number;
}

export function clampPauseHeartbeatHz(hz: number): number {
  if (!Number.isFinite(hz)) return DEFAULT_PAUSE_HEARTBEAT_HZ;
  return Math.max(PAUSE_HEARTBEAT_MIN_HZ, Math.min(PAUSE_HEARTBEAT_MAX_HZ, Math.round(hz)));
}

export function getPauseHeartbeatIntervalMs(hz: number): number {
  return Math.round(1000 / clampPauseHeartbeatHz(hz));
}

export function sanitizeGlobalWorkspaceBroadcast(
  raw: Record<string, unknown> | Partial<GlobalWorkspaceBroadcastPayload> | null | undefined
): GlobalWorkspaceBroadcastPayload {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const windows: FloatingWindowSyncEntry[] = [];
  if (Array.isArray(src.openFloatingWindows)) {
    for (const item of src.openFloatingWindows) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!id) continue;
      windows.push({
        id,
        isOpen: Boolean(entry.isOpen),
        isMinimized: Boolean(entry.isMinimized),
      });
    }
  }

  return {
    epoch: typeof src.epoch === 'number' && Number.isFinite(src.epoch) ? src.epoch : 0,
    tick: typeof src.tick === 'number' && Number.isFinite(src.tick) ? src.tick : 0,
    menuRoute: typeof src.menuRoute === 'string' ? src.menuRoute : null,
    openFloatingWindows: windows,
    telestratorPermission:
      src.telestratorPermission === 'everyone' ? 'everyone' : 'host_only',
    playbackPaused: Boolean(src.playbackPaused),
    pausedAtTick:
      typeof src.pausedAtTick === 'number' && Number.isFinite(src.pausedAtTick)
        ? src.pausedAtTick
        : 0,
    pauseHeartbeatHz: clampPauseHeartbeatHz(
      typeof src.pauseHeartbeatHz === 'number' ? src.pauseHeartbeatHz : DEFAULT_PAUSE_HEARTBEAT_HZ
    ),
  };
}
