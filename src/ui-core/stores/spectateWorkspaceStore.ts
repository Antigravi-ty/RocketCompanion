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
  clientInputEnabled?: boolean;
  followHostWorkspace?: boolean;
  arenaPreset?: 'standard' | 'throwback';
}

export interface SpectateWorkspaceStoreState {
  isSpectating: boolean;
  spectateMode: SpectateMode;
  isReadOnlyLocked: boolean;
  telestratorPermission: TelestratorDrawPermission;
  clientInputEnabled: boolean;
  followHostWorkspace: boolean;
  arenaPreset: 'standard' | 'throwback';
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
  setClientInputEnabled: (enabled: boolean) => void;
  setFollowHostWorkspace: (follow: boolean) => void;
  setArenaPreset: (preset: 'standard' | 'throwback') => void;
  applyHostWorkspaceBroadcast: (
    payload: GlobalWorkspaceStateInput,
    applyWorkspaceState?: (menuRoute: string | null, windows: FloatingWindowSyncEntry[]) => void,
    captureLocalState?: () => { menuRoute: string | null; windows: FloatingWindowSyncEntry[] }
  ) => void;
}

export const useSpectateWorkspaceStore = create<SpectateWorkspaceStoreState>((set, get) => ({
  isSpectating: false,
  spectateMode: 'spectate_state_only',
  isReadOnlyLocked: false,
  telestratorPermission: 'host_only',
  clientInputEnabled: true,
  followHostWorkspace: false,
  arenaPreset: 'standard',
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

  setClientInputEnabled: (enabled) => {
    set({ clientInputEnabled: Boolean(enabled) });
  },

  setFollowHostWorkspace: (follow) => {
    set({ followHostWorkspace: Boolean(follow) });
  },

  setArenaPreset: (preset) => {
    set({ arenaPreset: preset === 'throwback' ? 'throwback' : 'standard' });
  },

  applyHostWorkspaceBroadcast: (payload, applyWorkspaceState, captureLocalState) => {
    const s = get();
    const nextWindows = payload.openFloatingWindows.map((w) => ({ ...w }));
    const nextClientInputEnabled =
      typeof payload.clientInputEnabled === 'boolean'
        ? payload.clientInputEnabled
        : s.clientInputEnabled;
    const nextFollowHostWorkspace =
      typeof payload.followHostWorkspace === 'boolean'
        ? payload.followHostWorkspace
        : s.followHostWorkspace;
    const nextArenaPreset =
      payload.arenaPreset === 'throwback'
        ? 'throwback'
        : payload.arenaPreset === 'standard'
          ? 'standard'
          : s.arenaPreset;

    if (nextFollowHostWorkspace) {
      const snapshot =
        s.localSnapshotBeforeMirror ?? (captureLocalState ? captureLocalState() : null);
      set({
        isSpectating: true,
        spectateMode: 'spectate_mirror',
        isReadOnlyLocked: true,
        localSnapshotBeforeMirror: snapshot,
        telestratorPermission: payload.telestratorPermission,
        clientInputEnabled: nextClientInputEnabled,
        followHostWorkspace: true,
        arenaPreset: nextArenaPreset,
        hostMenuRoute: payload.menuRoute,
        hostFloatingWindows: nextWindows,
        playbackPaused: payload.playbackPaused,
        pausedAtTick: payload.pausedAtTick,
        pauseHeartbeatHz: payload.pauseHeartbeatHz ?? s.pauseHeartbeatHz,
      });
      applyWorkspaceState?.(payload.menuRoute, nextWindows);
      return;
    }

    if (s.followHostWorkspace && !nextFollowHostWorkspace) {
      if (s.localSnapshotBeforeMirror && applyWorkspaceState) {
        applyWorkspaceState(
          s.localSnapshotBeforeMirror.menuRoute,
          s.localSnapshotBeforeMirror.windows
        );
      }
      set({
        isSpectating: false,
        spectateMode: 'spectate_state_only',
        isReadOnlyLocked: false,
        localSnapshotBeforeMirror: null,
        telestratorPermission: payload.telestratorPermission,
        clientInputEnabled: nextClientInputEnabled,
        followHostWorkspace: false,
        arenaPreset: nextArenaPreset,
        hostMenuRoute: payload.menuRoute,
        hostFloatingWindows: nextWindows,
        playbackPaused: payload.playbackPaused,
        pausedAtTick: payload.pausedAtTick,
        pauseHeartbeatHz: payload.pauseHeartbeatHz ?? s.pauseHeartbeatHz,
      });
      return;
    }

    set({
      telestratorPermission: payload.telestratorPermission,
      clientInputEnabled: nextClientInputEnabled,
      followHostWorkspace: nextFollowHostWorkspace,
      arenaPreset: nextArenaPreset,
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
