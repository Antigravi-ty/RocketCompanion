import { useAppStore } from '../../ui-core/stores/appStore.ts';
import { PRESET_WINDOWS } from '../../ui-core/stores/devFloatingPresets.ts';
import { floatingStore } from '../../ui-core/stores/floatingStore.ts';
import {
  useSpectateWorkspaceStore,
  type FloatingWindowSyncEntry,
} from '../../ui-core/stores/spectateWorkspaceStore.ts';
import { useTelestratorStore } from '../../ui-core/stores/telestratorStore.ts';
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
      const preset = PRESET_WINDOWS.find((p) => p.id === entry.id);
      floatingStore.spawnWindow({
        ...(preset ?? {}),
        id: entry.id,
        title: preset?.title ?? entry.id,
        category: preset?.category,
        position: { x: 48 + desiredOpenIds.size * 24, y: 48 + desiredOpenIds.size * 24 },
        width: preset?.width ?? 340,
        height: preset?.height ?? 260,
        hideFooter: preset?.hideFooter ?? false,
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

export interface WorkspaceCameraPort {
  isFreeCam?: boolean;
  ballCam?: boolean;
  focusedCarIndex?: number;
  setFreeCam?: (enabled: boolean) => void;
  setFreeCamPose?: (
    position: [number, number, number],
    lookAtTarget?: [number, number, number]
  ) => void;
  setFocusedCarIndex?: (carIndex: number) => void;
  getFreeCamStateSnapshot?: () => {
    eyeThreeJs?: [number, number, number];
    targetThreeJs?: [number, number, number];
  } | null;
}

export function captureCameraSyncFromPort(
  camera: WorkspaceCameraPort | null | undefined,
  followHostCamera = true
): GlobalWorkspaceBroadcastPayload['cameraSync'] {
  if (!camera) return undefined;
  const isFreeCam = Boolean(camera.isFreeCam);
  const ballCam = typeof camera.ballCam === 'boolean' ? camera.ballCam : true;
  const focusedCarIndex =
    typeof camera.focusedCarIndex === 'number' && Number.isFinite(camera.focusedCarIndex)
      ? Math.max(0, Math.round(camera.focusedCarIndex))
      : 0;
  const freeSnap = isFreeCam ? camera.getFreeCamStateSnapshot?.() : null;
  return {
    followHostCamera,
    isFreeCam,
    ballCam,
    focusedCarIndex,
    ...(freeSnap?.eyeThreeJs ? { freeCamPosition: [...freeSnap.eyeThreeJs] as [number, number, number] } : {}),
    ...(freeSnap?.targetThreeJs ? { freeCamLookAt: [...freeSnap.targetThreeJs] as [number, number, number] } : {}),
  };
}

export function applyCameraSyncToPort(
  camera: WorkspaceCameraPort | null | undefined,
  cameraSync: GlobalWorkspaceBroadcastPayload['cameraSync']
): void {
  if (!camera || !cameraSync || !cameraSync.followHostCamera) return;
  if (cameraSync.isFreeCam) {
    if (cameraSync.freeCamPosition && cameraSync.freeCamLookAt && camera.setFreeCamPose) {
      camera.setFreeCamPose(cameraSync.freeCamPosition, cameraSync.freeCamLookAt);
    } else {
      camera.setFreeCam?.(true);
    }
    return;
  }
  camera.setFreeCam?.(false);
  camera.setFocusedCarIndex?.(cameraSync.focusedCarIndex);
  if (typeof camera.ballCam === 'boolean' || 'ballCam' in camera) {
    camera.ballCam = cameraSync.ballCam;
  }
}

export function resetSpectateWorkspaceOnLeave(): void {
  const ws = useSpectateWorkspaceStore.getState();
  ws.setSpectatingActive(false, undefined, applyWorkspaceStateLocally);
  ws.setFollowHostWorkspace(false);
  ws.setFollowHostCamera(false);
  ws.setPlaybackState(false, 0);
  ws.setClientInputEnabled(true);
  const telestrator = useTelestratorStore.getState();
  telestrator.setHostRole(true, 'local');
  telestrator.setAllowClientDrawing(false);
  telestrator.setAllowedClientIds([]);
}

export function syncClientInputEnabledUi(enabled: boolean): void {
  useSpectateWorkspaceStore.getState().setClientInputEnabled(enabled);
}

export function syncArenaPresetUi(preset: 'standard' | 'throwback'): void {
  useSpectateWorkspaceStore.getState().setArenaPreset(preset);
}

export function applyIncomingWorkspaceBroadcast(
  raw: Record<string, unknown>
): GlobalWorkspaceBroadcastPayload {
  const sanitized = sanitizeGlobalWorkspaceBroadcast(raw);
  useSpectateWorkspaceStore
    .getState()
    .applyHostWorkspaceBroadcast(
      sanitized,
      applyWorkspaceStateLocally,
      captureLocalWorkspaceState
    );
  const telestrator = useTelestratorStore.getState();
  telestrator.setHostRole(
    false,
    telestrator.localAuthorId === 'local' ? 'client' : telestrator.localAuthorId
  );
  telestrator.setIsCameraSynced(true);
  telestrator.setAllowClientDrawing(sanitized.telestratorPermission === 'everyone');
  if (sanitized.arenaPreset) {
    const app = useAppStore.getState();
    if (app.underDevelopment?.stadiumPreset !== sanitized.arenaPreset) {
      app.updateUnderDevelopment?.({ stadiumPreset: sanitized.arenaPreset });
    }
  }
  return sanitized;
}

export function buildHostWorkspaceBroadcastPayload(meta?: {
  epoch?: number;
  tick?: number;
  playbackPaused?: boolean;
  pausedAtTick?: number;
  pauseHeartbeatHz?: number;
  clientInputEnabled?: boolean;
  followHostWorkspace?: boolean;
  arenaPreset?: 'standard' | 'throwback';
  cameraSync?: GlobalWorkspaceBroadcastPayload['cameraSync'];
}): GlobalWorkspaceBroadcastPayload {
  const local = captureLocalWorkspaceState();
  const ws = useSpectateWorkspaceStore.getState();
  const app = useAppStore.getState();
  const currentArenaPreset =
    meta?.arenaPreset ??
    (app.underDevelopment?.stadiumPreset === 'throwback' ? 'throwback' : ws.arenaPreset);
  return sanitizeGlobalWorkspaceBroadcast({
    epoch: meta?.epoch ?? 0,
    tick: meta?.tick ?? 0,
    menuRoute: local.menuRoute,
    openFloatingWindows: local.windows,
    telestratorPermission: ws.telestratorPermission,
    playbackPaused: meta?.playbackPaused ?? ws.playbackPaused,
    pausedAtTick: meta?.pausedAtTick ?? ws.pausedAtTick,
    pauseHeartbeatHz: meta?.pauseHeartbeatHz ?? ws.pauseHeartbeatHz,
    clientInputEnabled: meta?.clientInputEnabled ?? ws.clientInputEnabled,
    followHostWorkspace: meta?.followHostWorkspace ?? ws.followHostWorkspace,
    arenaPreset: currentArenaPreset,
    ...(meta?.cameraSync ? { cameraSync: meta.cameraSync } : {}),
  });
}
