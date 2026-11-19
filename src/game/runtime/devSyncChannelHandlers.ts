import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type {
  WorkspaceCameraSyncPayload,
  WorkspaceReplaySyncPayload,
} from '../../network/protocol/GlobalWorkspaceProtocol.ts';
import { sharedAuthorityCameraSyncTracker } from '../pipeline/stages/AuthorityCameraSyncTracker.ts';
import { isDevSyncClientInputAuthorityMode } from '../pipeline/stages/HostBroadcastPublisher.ts';
import {
  applyCameraSyncToPort,
  applyIncomingPauseStateSync,
  applyIncomingWorkspaceBroadcast,
  hudStore,
  setNameTagRuntimeState,
  useAppStore,
  useReplayViewerStore,
} from '../runtimeUiPort.ts';

export interface DevSyncSessionCoordinatorPort {
  networkReconciler?: {
    lobbyDualWorldMode?: boolean;
    hostLobbyMode?: boolean;
    setLobbyDualWorldMode?: (enabled: boolean) => void;
    setSpectateMirrorMode?: (enabled: boolean) => void;
    setReplayPlaybackMode?: (enabled: boolean) => void;
    setClientInputEnabled?: (enabled: boolean) => void;
    setAuthorityState?: (epoch: number, activePeerId: string) => void;
    sendPauseAck?: (params: {
      pauseSeq: number;
      paused: boolean;
      pausedAtTick: number;
      peerId?: string;
    }) => boolean;
  } | null;
  lobbyDualWorld?: {
    configureArenaLobbyFlags?: (isLobby: boolean, isHostLobby: boolean) => void;
  } | null;
}

export interface DevSyncDiagnosticsProbePort {
  setMultiWorldGhostVisible?: (visible: boolean) => void;
  configureLobbyGhostMode?: (enabled: boolean) => void;
}

export interface DevSyncChannelPort {
  peerId?: string | null;
  onGlobalWorkspaceBroadcast?: ((msg: Record<string, unknown>) => void) | null;
  onCameraStateSync?: ((msg: Record<string, unknown>) => void) | null;
  onPauseStateSync?: ((msg: Record<string, unknown>) => void) | null;
  sendPresencePing?: (payload?: Record<string, unknown>) => boolean;
}

export function bindDevSyncClientChannelHandlers(params: {
  channel: DevSyncChannelPort;
  authorId: string;
  camera: CameraManager | null | undefined;
  physics: RocketSimPhysicsEngine & { setCarTeam?: (carIndex: number, team: number) => void };
  arena?: { setCarTeam?: (carIndex: number, team: number) => void } | null;
  sessionCoordinator: DevSyncSessionCoordinatorPort;
  diagnosticsProbe: DevSyncDiagnosticsProbePort;
}): void {
  const { channel, authorId, camera, physics, arena, sessionCoordinator, diagnosticsProbe } =
    params;
  sharedAuthorityCameraSyncTracker.reset();

  channel.onCameraStateSync = (msg) => {
    const camSync = msg.cameraSync as WorkspaceCameraSyncPayload | undefined;
    const isLocalAuth = isDevSyncClientInputAuthorityMode(
      sessionCoordinator.networkReconciler as Parameters<
        typeof isDevSyncClientInputAuthorityMode
      >[0]
    );
    const allowIndependentCam = Boolean(
      useAppStore?.getState?.()?.onlineSession?.allowClientIndependentCamera
    );
    if (
      camera &&
      camSync &&
      sharedAuthorityCameraSyncTracker.shouldApplyIncomingCameraSync({
        cameraSync: camSync,
        isLocalAuthority: isLocalAuth,
        incomingEpoch: typeof msg.authorityEpoch === 'number' ? msg.authorityEpoch : 0,
        allowClientIndependentCamera: allowIndependentCam,
      })
    ) {
      applyCameraSyncToPort(camera, camSync);
      if (
        useAppStore?.getState?.()?.onlineSession?.activeRoomActivity === 'replay' &&
        !camSync.isFreeCam &&
        typeof camSync.focusedCarIndex === 'number'
      ) {
        useReplayViewerStore
          ?.getState?.()
          ?.updateLiveTelemetry?.({ activePovCarIndex: camSync.focusedCarIndex });
      }
    }
  };

  channel.onPauseStateSync = (msg) => {
    const sync = applyIncomingPauseStateSync(msg);
    if (sync && sessionCoordinator.networkReconciler?.sendPauseAck) {
      sessionCoordinator.networkReconciler.sendPauseAck({
        pauseSeq: Number(sync.pauseSeq) || 0,
        paused: Boolean(sync.paused),
        pausedAtTick: Number(sync.pausedAtTick) || 0,
        peerId: channel.peerId || authorId,
      });
    }
  };

  channel.onGlobalWorkspaceBroadcast = (msg) => {
    const payload = applyIncomingWorkspaceBroadcast(msg);
    const reconciler = sessionCoordinator.networkReconciler;
    if (reconciler && payload) {
      if (typeof payload.matchMode === 'string') {
        const isReplayMode = payload.matchMode === 'replay-viewer';
        reconciler.setReplayPlaybackMode?.(isReplayMode);
        if (!isReplayMode && !payload.playbackPaused) {
          physics?.setSimulationFrozen?.(false, 0, false);
        }
      }
      if (payload.followHostWorkspace) {
        reconciler.setSpectateMirrorMode?.(true);
        if (reconciler.lobbyDualWorldMode) {
          reconciler.setLobbyDualWorldMode?.(false);
        }
        reconciler.hostLobbyMode = false;
        sessionCoordinator.lobbyDualWorld?.configureArenaLobbyFlags?.(false, false);
        diagnosticsProbe.setMultiWorldGhostVisible?.(false);
        diagnosticsProbe.configureLobbyGhostMode?.(false);
      } else if (payload.followHostWorkspace === false) {
        reconciler.setSpectateMirrorMode?.(false);
      }
      if (typeof payload.clientInputEnabled === 'boolean') {
        reconciler.setClientInputEnabled?.(payload.clientInputEnabled);
        if (payload.clientInputEnabled) {
          physics?.setSimulationFrozen?.(false, 0, false);
        }
      }
      if (
        typeof payload.authorityEpoch === 'number' ||
        typeof payload.activeInputPeerId === 'string'
      ) {
        reconciler.setAuthorityState?.(
          typeof payload.authorityEpoch === 'number' ? payload.authorityEpoch : 0,
          typeof payload.activeInputPeerId === 'string' ? payload.activeInputPeerId : 'host'
        );
      }
    }

    const allowIndependentCam = Boolean(
      useAppStore?.getState?.()?.onlineSession?.allowClientIndependentCamera
    );
    const camSync = payload?.cameraSync as WorkspaceCameraSyncPayload | undefined;
    if (
      camSync &&
      camera &&
      sharedAuthorityCameraSyncTracker.shouldApplyIncomingCameraSync({
        cameraSync: camSync,
        isLocalAuthority: isDevSyncClientInputAuthorityMode(
          reconciler as Parameters<typeof isDevSyncClientInputAuthorityMode>[0]
        ),
        incomingEpoch:
          typeof payload?.authorityEpoch === 'number' ? payload.authorityEpoch : undefined,
        allowClientIndependentCamera: allowIndependentCam,
      })
    ) {
      applyCameraSyncToPort(camera, camSync);
      if (
        useAppStore?.getState?.()?.onlineSession?.activeRoomActivity === 'replay' &&
        !camSync.isFreeCam &&
        typeof camSync.focusedCarIndex === 'number'
      ) {
        useReplayViewerStore
          ?.getState?.()
          ?.updateLiveTelemetry?.({ activePovCarIndex: camSync.focusedCarIndex });
      }
    }
    const replaySync = (payload as { replaySync?: WorkspaceReplaySyncPayload } | null)?.replaySync;
    if (replaySync) {
      if (Array.isArray(replaySync.roster)) {
        for (const entry of replaySync.roster) {
          physics?.setCarTeam?.(entry.carIndex, entry.team);
          arena?.setCarTeam?.(entry.carIndex, entry.team);
        }
        if (replaySync.roster.length > 0) {
          const focusedIdx =
            typeof replaySync.focusedCarIndex === 'number' ? replaySync.focusedCarIndex : undefined;
          setNameTagRuntimeState({
            isMultiplayerOrMultiCarMode: replaySync.roster.length > 1,
            carEntries: replaySync.roster.map((entry) => ({
              carIndex: entry.carIndex,
              name: entry.name,
              username: entry.name,
              team: entry.team,
              isBot: Boolean(entry.isBot),
              isLocalPlayer: focusedIdx !== undefined ? entry.carIndex === focusedIdx : false,
            })),
          });
        }
      }
      useReplayViewerStore?.getState?.()?.updateLiveTelemetry?.({
        viewerState: replaySync.playbackState === 'paused' ? 'paused' : 'playing',
        ...(replaySync.fileName !== undefined ? { loadedFileName: replaySync.fileName } : {}),
        totalFrames: replaySync.totalFrames,
        cursorFrame: replaySync.currentFrame,
        ...(typeof replaySync.flowPct === 'number' ? { effectiveFlowPct: replaySync.flowPct } : {}),
        ...(!allowIndependentCam && typeof replaySync.focusedCarIndex === 'number'
          ? { activePovCarIndex: replaySync.focusedCarIndex }
          : {}),
        ...(replaySync.localTeam === 0 || replaySync.localTeam === 1
          ? { localTeam: replaySync.localTeam }
          : {}),
        ...(Array.isArray(replaySync.roster) ? { resolvedRoster: replaySync.roster } : {}),
      });
      const hudPatch: Record<string, unknown> = {};
      if (typeof replaySync.blueScore === 'number') hudPatch.blueScore = replaySync.blueScore;
      if (typeof replaySync.orangeScore === 'number') hudPatch.orangeScore = replaySync.orangeScore;
      if (typeof replaySync.remainingSeconds === 'number') {
        hudPatch.remainingSeconds = replaySync.remainingSeconds;
      }
      if (typeof replaySync.isOvertime === 'boolean') hudPatch.isOvertime = replaySync.isOvertime;
      if (typeof replaySync.overtimeSeconds === 'number') {
        hudPatch.overtimeSeconds = replaySync.overtimeSeconds;
      }
      if (typeof replaySync.matchPhase === 'string') hudPatch.matchPhase = replaySync.matchPhase;
      if (replaySync.localTeam === 0 || replaySync.localTeam === 1) {
        hudPatch.localTeam = replaySync.localTeam;
      }
      if (Object.keys(hudPatch).length > 0) {
        hudStore?.getState?.()?.setMatchState?.(hudPatch);
      }
    }
  };

  channel.sendPresencePing?.({ peerId: channel.peerId || authorId, readyForWorkspaceSync: true });
}
