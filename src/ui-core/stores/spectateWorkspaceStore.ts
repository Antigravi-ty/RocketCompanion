import { create } from 'zustand';

export type SpectateMode = 'spectate_state_only' | 'spectate_mirror';
export type TelestratorDrawPermission = 'host_only' | 'everyone';

export interface FloatingWindowSyncEntry {
  id: string;
  isOpen: boolean;
  isMinimized: boolean;
}

export interface GlobalWorkspaceStateInput {
  epoch?: number;
  tick?: number;
  menuRoute: string | null;
  openFloatingWindows: FloatingWindowSyncEntry[];
  telestratorPermission: TelestratorDrawPermission;
  playbackPaused: boolean;
  pausedAtTick: number;
  pauseHeartbeatHz?: number;
}

export interface SpectateWorkspaceStoreState {
  isSpectating: boolean;
  spectateMode: SpectateMode;
  isReadOnlyLocked: boolean;
  telestratorPermission: TelestratorDrawPermission;
  hostMenuRoute: string | null;
  hostFloatingWindows: FloatingWindowSyncEntry[];
  playbackPaused: boolean;
  pausedAtTick: number;
  pauseHeartbeatHz: number;
  localSnapshotBeforeMirror: {
    menuRoute: string | null;
    windows: FloatingWindowSyncEntry[];
  } | null;

  setSpectatingActive: (
    active: boolean,
    captureLocalState?: () => { menuRoute: string | null; windows: FloatingWindowSyncEntry[] },
    applyWorkspaceState?: (menuRoute: string | null, windows: FloatingWindowSyncEntry[]) => void
  ) => void;
  setSpectateMode: (
    mode: SpectateMode,
    captureLocalState?: () => { menuRoute: string | null; windows: FloatingWindowSyncEntry[] },
    applyWorkspaceState?: (menuRoute: string | null, windows: FloatingWindowSyncEntry[]) => void
  ) => void;
  setTelestratorPermission: (permission: TelestratorDrawPermission) => void;
  applyHostWorkspaceBroadcast: (
    payload: GlobalWorkspaceStateInput,
    applyWorkspaceState?: (menuRoute: string | null, windows: FloatingWindowSyncEntry[]) => void
  ) => void;
}

export const useSpectateWorkspaceStore = create<SpectateWorkspaceStoreState>((set, get) => ({
  isSpectating: false,
  spectateMode: 'spectate_state_only',
  isReadOnlyLocked: false,
  telestratorPermission: 'host_only',
  hostMenuRoute: null,
  hostFloatingWindows: [],
  playbackPaused: false,
  pausedAtTick: 0,
  pauseHeartbeatHz: 2,
  localSnapshotBeforeMirror: null,

  setSpectatingActive: (active, captureLocalState, applyWorkspaceState) => {
    const s = get();
    if (!active) {
      if (s.localSnapshotBeforeMirror && applyWorkspaceState) {
        applyWorkspaceState(
          s.localSnapshotBeforeMirror.menuRoute,
          s.localSnapshotBeforeMirror.windows
        );
      }
      set({
        isSpectating: false,
        isReadOnlyLocked: false,
        localSnapshotBeforeMirror: null,
      });
      return;
    }

    const shouldLock = s.spectateMode === 'spectate_mirror';
    let snapshot = s.localSnapshotBeforeMirror;
    if (shouldLock && !snapshot && captureLocalState) {
      snapshot = captureLocalState();
    }
    set({
      isSpectating: true,
      isReadOnlyLocked: shouldLock,
      localSnapshotBeforeMirror: snapshot,
    });
    if (shouldLock && applyWorkspaceState) {
      applyWorkspaceState(s.hostMenuRoute, s.hostFloatingWindows);
    }
  },

  setSpectateMode: (mode, captureLocalState, applyWorkspaceState) => {
    const s = get();
    if (mode === 'spectate_mirror') {
      const snapshot =
        s.localSnapshotBeforeMirror ?? (captureLocalState ? captureLocalState() : null);
      const shouldLock = s.isSpectating;
      set({
        spectateMode: mode,
        isReadOnlyLocked: shouldLock,
        localSnapshotBeforeMirror: snapshot,
      });
      if (shouldLock && applyWorkspaceState) {
        applyWorkspaceState(s.hostMenuRoute, s.hostFloatingWindows);
      }
    } else {
      if (s.localSnapshotBeforeMirror && applyWorkspaceState) {
        applyWorkspaceState(
          s.localSnapshotBeforeMirror.menuRoute,
          s.localSnapshotBeforeMirror.windows
        );
      }
      set({
        spectateMode: mode,
        isReadOnlyLocked: false,
        localSnapshotBeforeMirror: null,
      });
    }
  },

  setTelestratorPermission: (permission) => {
    set({ telestratorPermission: permission === 'everyone' ? 'everyone' : 'host_only' });
  },

  applyHostWorkspaceBroadcast: (payload, applyWorkspaceState) => {
    const s = get();
    const nextWindows = payload.openFloatingWindows.map((w) => ({ ...w }));
    set({
      telestratorPermission: payload.telestratorPermission,
      hostMenuRoute: payload.menuRoute,
      hostFloatingWindows: nextWindows,
      playbackPaused: payload.playbackPaused,
      pausedAtTick: payload.pausedAtTick,
      pauseHeartbeatHz: payload.pauseHeartbeatHz ?? s.pauseHeartbeatHz,
    });
    if (s.isSpectating && s.spectateMode === 'spectate_mirror' && applyWorkspaceState) {
      applyWorkspaceState(payload.menuRoute, nextWindows);
    }
  },
}));
