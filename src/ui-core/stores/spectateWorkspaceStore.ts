import { create } from 'zustand';
import { useTelestratorStore } from './telestratorStore.ts';
import type { WorkspaceCameraSyncPayload } from '../../network/protocol/GlobalWorkspaceProtocol.ts';

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
  menuStateIncluded?: boolean;
  arenaPreset?: 'standard' | 'throwback';
  matchMode?: string;
  cameraSync?: WorkspaceCameraSyncPayload;
}

export interface SpectateWorkspaceStoreState {
  isSpectating: boolean;
  spectateMode: SpectateMode;
  isReadOnlyLocked: boolean;
  telestratorPermission: TelestratorDrawPermission;
  clientInputEnabled: boolean;
  followHostWorkspace: boolean;
  broadcastMenuState: boolean;
  followHostCamera: boolean;
  hostCameraSync: WorkspaceCameraSyncPayload | null;
  arenaPreset: 'standard' | 'throwback';
  hostMatchMode: string | null;
  hostMenuRoute: string | null;
  hostFloatingWindows: FloatingWindowSyncEntry[];
  playbackPaused: boolean;
  pausedAtTick: number;
  pauseHeartbeatHz: number;
  pauseSeq: number;
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
  setBroadcastMenuState: (includeMenu: boolean) => void;
  setFollowHostCamera: (follow: boolean) => void;
  setPlaybackState: (paused: boolean, pausedAtTick: number, pauseSeq?: number) => void;
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
  broadcastMenuState: true,
  followHostCamera: false,
  hostCameraSync: null,
  arenaPreset: 'standard',
  hostMatchMode: null,
  hostMenuRoute: null,
  hostFloatingWindows: [],
  playbackPaused: false,
  pausedAtTick: 0,
  pauseHeartbeatHz: 2,
  pauseSeq: 0,
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
    const next = permission === 'everyone' ? 'everyone' : 'host_only';
    set({ telestratorPermission: next });
    useTelestratorStore.getState().setAllowClientDrawing(next === 'everyone');
  },

  setClientInputEnabled: (enabled) => {
    set({ clientInputEnabled: Boolean(enabled) });
  },

  setFollowHostWorkspace: (follow) => {
    set({ followHostWorkspace: Boolean(follow) });
  },

  setBroadcastMenuState: (includeMenu) => {
    set({ broadcastMenuState: Boolean(includeMenu) });
  },

  setFollowHostCamera: (follow) => {
    set({ followHostCamera: Boolean(follow) });
  },

  setPlaybackState: (paused, pausedAtTick, pauseSeq) => {
    set((s) => ({
      playbackPaused: Boolean(paused),
      pausedAtTick: Number.isFinite(pausedAtTick) ? Math.max(0, Math.round(pausedAtTick)) : 0,
      pauseSeq:
        typeof pauseSeq === 'number' && Number.isFinite(pauseSeq)
          ? Math.max(0, Math.round(pauseSeq))
          : s.pauseSeq,
    }));
  },

  setArenaPreset: (preset) => {
    set({ arenaPreset: preset === 'throwback' ? 'throwback' : 'standard' });
  },

  applyHostWorkspaceBroadcast: (payload, applyWorkspaceState, captureLocalState) => {
    const s = get();
    const menuIncluded = payload.menuStateIncluded !== false;
    const nextWindows = menuIncluded
      ? payload.openFloatingWindows.map((w) => ({ ...w }))
      : s.hostFloatingWindows;
    const telestrator = useTelestratorStore.getState();
    telestrator.setIsCameraSynced(true);
    telestrator.setAllowClientDrawing(payload.telestratorPermission === 'everyone');
    const nextClientInputEnabled =
      typeof payload.clientInputEnabled === 'boolean'
        ? payload.clientInputEnabled
        : s.clientInputEnabled;
    const nextFollowHostWorkspace =
      typeof payload.followHostWorkspace === 'boolean'
        ? payload.followHostWorkspace
        : s.followHostWorkspace;
    const nextCameraSync = payload.cameraSync ?? s.hostCameraSync;
    const nextFollowHostCamera = payload.cameraSync
      ? Boolean(payload.cameraSync.followHostCamera)
      : s.followHostCamera;
    const nextArenaPreset =
      payload.arenaPreset === 'throwback'
        ? 'throwback'
        : payload.arenaPreset === 'standard'
          ? 'standard'
          : s.arenaPreset;
    const nextHostMatchMode =
      typeof payload.matchMode === 'string' && payload.matchMode
        ? payload.matchMode
        : s.hostMatchMode;

    if (nextFollowHostWorkspace) {
      const snapshot =
        s.localSnapshotBeforeMirror ?? (captureLocalState ? captureLocalState() : null);
      set({
        isSpectating: true,
        spectateMode: 'spectate_mirror',
        isReadOnlyLocked: menuIncluded,
        localSnapshotBeforeMirror: snapshot,
        telestratorPermission: payload.telestratorPermission,
        clientInputEnabled: nextClientInputEnabled,
        followHostWorkspace: true,
        followHostCamera: nextFollowHostCamera,
        hostCameraSync: nextCameraSync,
        arenaPreset: nextArenaPreset,
        hostMatchMode: nextHostMatchMode,
        hostMenuRoute: menuIncluded ? payload.menuRoute : s.hostMenuRoute,
        hostFloatingWindows: nextWindows,
        playbackPaused: payload.playbackPaused,
        pausedAtTick: payload.pausedAtTick,
        pauseHeartbeatHz: payload.pauseHeartbeatHz ?? s.pauseHeartbeatHz,
      });
      if (menuIncluded) {
        applyWorkspaceState?.(payload.menuRoute, nextWindows);
      }
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
        followHostCamera: nextFollowHostCamera,
        hostCameraSync: nextCameraSync,
        arenaPreset: nextArenaPreset,
        hostMatchMode: null,
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
      followHostCamera: nextFollowHostCamera,
      hostCameraSync: nextCameraSync,
      arenaPreset: nextArenaPreset,
      hostMatchMode: nextHostMatchMode,
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

if (typeof window !== 'undefined') {
  const e2eHost = (window as unknown as { __rcE2E?: Record<string, unknown> }).__rcE2E ?? {};
  e2eHost.getWorkspaceState = () => useSpectateWorkspaceStore.getState();
  (window as unknown as { __rcE2E?: Record<string, unknown> }).__rcE2E = e2eHost;
}
