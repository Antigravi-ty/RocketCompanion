import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { WorkspaceCameraSyncPayload } from '../../network/protocol/GlobalWorkspaceProtocol.ts';
import { sharedAuthorityCameraSyncTracker } from '../pipeline/stages/AuthorityCameraSyncTracker.ts';
import { isDevSyncClientInputAuthorityMode } from '../pipeline/stages/HostBroadcastPublisher.ts';
import {
  applyCameraSyncToPort,
  applyIncomingPauseStateSync,
  applyIncomingWorkspaceBroadcast,
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
  physics: RocketSimPhysicsEngine;
  sessionCoordinator: DevSyncSessionCoordinatorPort;
  diagnosticsProbe: DevSyncDiagnosticsProbePort;
}): void {
  const { channel, authorId, camera, physics, sessionCoordinator, diagnosticsProbe } = params;
  sharedAuthorityCameraSyncTracker.reset();

  channel.onCameraStateSync = (msg) => {
    const camSync = msg.cameraSync as WorkspaceCameraSyncPayload | undefined;
    const isLocalAuth = isDevSyncClientInputAuthorityMode(
      sessionCoordinator.networkReconciler as Parameters<
        typeof isDevSyncClientInputAuthorityMode
      >[0]
    );
    if (
      camera &&
      camSync &&
      sharedAuthorityCameraSyncTracker.shouldApplyIncomingCameraSync({
        cameraSync: camSync,
        isLocalAuthority: isLocalAuth,
        incomingEpoch: typeof msg.authorityEpoch === 'number' ? msg.authorityEpoch : 0,
      })
    ) {
      applyCameraSyncToPort(camera, camSync);
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
      })
    ) {
      applyCameraSyncToPort(camera, camSync);
    }
  };

  channel.sendPresencePing?.({ peerId: channel.peerId || authorId, readyForWorkspaceSync: true });
}
