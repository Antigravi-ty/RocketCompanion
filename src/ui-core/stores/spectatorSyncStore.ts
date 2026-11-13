import { create } from 'zustand';

export type SpectatorSyncMode = 'gameplay_only' | 'mirror_host_ui';
export type TelestratorDrawPermission = 'host_only' | 'all_peers';

export interface FloatingWindowSyncEntry {
  id: string;
  isOpen: boolean;
  isMinimized: boolean;
}

export interface GlobalUiStateSnapshot {
  epoch: number;
  activeMenuRoute: string;
  floatingWindows: FloatingWindowSyncEntry[];
  paused: boolean;
  pausedAtTick: number;
  telestratorPermission: TelestratorDrawPermission;
}

export interface LocalUiRestoreSnapshot {
  activeMenuRoute: string;
  windows: Record<string, { isOpen: boolean; isMinimized: boolean }>;
}

export interface SpectatorSyncStoreState {
  isSpectating: boolean;
  syncMode: SpectatorSyncMode;
  localControlsLocked: boolean;
  hostEpoch: number;
  hostActiveMenuRoute: string | null;
  hostFloatingWindows: FloatingWindowSyncEntry[];
  hostPaused: boolean;
  hostPausedAtTick: number;
  telestratorPermission: TelestratorDrawPermission;
  savedLocalSnapshot: LocalUiRestoreSnapshot | null;

  setSpectatingActive: (active: boolean) => void;
  setSyncMode: (
    mode: SpectatorSyncMode,
    captureLocal?: () => LocalUiRestoreSnapshot,
    restoreLocal?: (snap: LocalUiRestoreSnapshot) => void
  ) => void;
  applyHostGlobalUiState: (
    broadcast: GlobalUiStateSnapshot,
    applyMirrorToLocal?: (broadcast: GlobalUiStateSnapshot) => void
  ) => void;
  resetSpectatorSync: (restoreLocal?: (snap: LocalUiRestoreSnapshot) => void) => void;
}

export const useSpectatorSyncStore = create<SpectatorSyncStoreState>((set, get) => ({
  isSpectating: false,
  syncMode: 'gameplay_only',
  localControlsLocked: false,
  hostEpoch: 0,
  hostActiveMenuRoute: null,
  hostFloatingWindows: [],
  hostPaused: false,
  hostPausedAtTick: 0,
  telestratorPermission: 'host_only',
  savedLocalSnapshot: null,

  setSpectatingActive: (active) => {
    set({
      isSpectating: active,
      localControlsLocked: active && get().syncMode === 'mirror_host_ui',
    });
  },

  setSyncMode: (mode, captureLocal, restoreLocal) => {
    const prev = get();
    if (mode === prev.syncMode) return;

    if (mode === 'mirror_host_ui') {
      const captured = prev.savedLocalSnapshot ?? (captureLocal ? captureLocal() : null);
      set({
        syncMode: 'mirror_host_ui',
        localControlsLocked: prev.isSpectating,
        savedLocalSnapshot: captured,
      });
    } else {
      const snap = prev.savedLocalSnapshot;
      set({
        syncMode: 'gameplay_only',
        localControlsLocked: false,
        savedLocalSnapshot: null,
      });
      if (snap && restoreLocal) {
        restoreLocal(snap);
      }
    }
  },

  applyHostGlobalUiState: (broadcast, applyMirrorToLocal) => {
    const state = get();
    if (broadcast.epoch < state.hostEpoch) return;
    set({
      hostEpoch: broadcast.epoch,
      hostActiveMenuRoute: broadcast.activeMenuRoute,
      hostFloatingWindows: broadcast.floatingWindows.map((w) => ({
        id: w.id,
        isOpen: Boolean(w.isOpen),
        isMinimized: Boolean(w.isMinimized),
      })),
      hostPaused: Boolean(broadcast.paused),
      hostPausedAtTick: broadcast.pausedAtTick,
      telestratorPermission: broadcast.telestratorPermission ?? 'host_only',
    });
    if (state.isSpectating && state.syncMode === 'mirror_host_ui' && applyMirrorToLocal) {
      applyMirrorToLocal(broadcast);
    }
  },

  resetSpectatorSync: (restoreLocal) => {
    const snap = get().savedLocalSnapshot;
    set({
      isSpectating: false,
      syncMode: 'gameplay_only',
      localControlsLocked: false,
      hostEpoch: 0,
      hostActiveMenuRoute: null,
      hostFloatingWindows: [],
      hostPaused: false,
      hostPausedAtTick: 0,
      telestratorPermission: 'host_only',
      savedLocalSnapshot: null,
    });
    if (snap && restoreLocal) {
      restoreLocal(snap);
    }
  },
}));
