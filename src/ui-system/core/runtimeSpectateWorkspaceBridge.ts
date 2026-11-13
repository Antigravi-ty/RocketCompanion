import { useAppStore } from '../../ui-core/stores/appStore.ts';
import { floatingStore } from '../../ui-core/stores/floatingStore.ts';
import {
  useSpectateWorkspaceStore,
  type FloatingWindowSyncEntry,
} from '../../ui-core/stores/spectateWorkspaceStore.ts';
import {
  sanitizeGlobalWorkspaceBroadcast,
  type GlobalWorkspaceBroadcastPayload,
} from '../../network/protocol/GlobalWorkspaceProtocol.ts';

export function captureLocalWorkspaceState(): {
  menuRoute: string | null;
  windows: FloatingWindowSyncEntry[];
} {
  const app = useAppStore.getState();
  const snap = floatingStore.getSnapshot();
  return {
    menuRoute: app.isOpen ? app.activeRoute : null,
    windows: snap.windows.map((w) => ({
      id: w.id,
      isOpen: true,
      isMinimized: w.isMinimized,
    })),
  };
}

export function applyWorkspaceStateLocally(
  menuRoute: string | null,
  windows: FloatingWindowSyncEntry[]
): void {
  const app = useAppStore.getState();
  if (menuRoute) {
    app.openMenu(menuRoute as Parameters<typeof app.openMenu>[0]);
  } else if (app.isOpen) {
    app.closeMenu();
  }

  const currentSnap = floatingStore.getSnapshot();
  const currentById = new Map(currentSnap.windows.map((w) => [w.id, w]));
  const desiredOpenIds = new Set<string>();

  for (const entry of windows) {
    if (!entry.isOpen) continue;
    desiredOpenIds.add(entry.id);
    const existing = currentById.get(entry.id);
    if (existing) {
      // Preserve client's local (x, y) window coordinates; only sync open/minimized state.
      if (entry.isMinimized && !existing.isMinimized) {
        floatingStore.minimizeWindow(entry.id);
      } else if (!entry.isMinimized && existing.isMinimized) {
        floatingStore.restoreWindow(entry.id);
      }
    } else {
      floatingStore.spawnWindow({
        id: entry.id,
        title: entry.id,
        position: { x: 48 + desiredOpenIds.size * 24, y: 48 + desiredOpenIds.size * 24 },
        width: 340,
        height: 260,
        startMinimized: entry.isMinimized,
      });
    }
  }

  for (const existing of currentSnap.windows) {
    if (!desiredOpenIds.has(existing.id)) {
      floatingStore.closeWindow(existing.id);
    }
  }
}

export function applyIncomingWorkspaceBroadcast(raw: Record<string, unknown>): void {
  const sanitized = sanitizeGlobalWorkspaceBroadcast(raw);
  useSpectateWorkspaceStore
    .getState()
    .applyHostWorkspaceBroadcast(sanitized, applyWorkspaceStateLocally);
}

export function buildHostWorkspaceBroadcastPayload(meta?: {
  epoch?: number;
  tick?: number;
  playbackPaused?: boolean;
  pausedAtTick?: number;
  pauseHeartbeatHz?: number;
}): GlobalWorkspaceBroadcastPayload {
  const local = captureLocalWorkspaceState();
  const ws = useSpectateWorkspaceStore.getState();
  return sanitizeGlobalWorkspaceBroadcast({
    epoch: meta?.epoch ?? 0,
    tick: meta?.tick ?? 0,
    menuRoute: local.menuRoute,
    openFloatingWindows: local.windows,
    telestratorPermission: ws.telestratorPermission,
    playbackPaused: meta?.playbackPaused ?? ws.playbackPaused,
    pausedAtTick: meta?.pausedAtTick ?? ws.pausedAtTick,
    pauseHeartbeatHz: meta?.pauseHeartbeatHz ?? ws.pauseHeartbeatHz,
  });
}
