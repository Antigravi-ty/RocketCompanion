import type * as THREE from 'three';
import {
  useAppStore,
  pushQuickNotification,
  dismissQuickNotification,
  reachabilityStore,
  ballTrajectoryTunerStore,
  notifyNetworkTelemetryExportAvailable,
} from '../runtimeUiPort.ts';
import { BallTrajectoryPredictor } from '../../entities/BallTrajectoryPredictor.ts';
import { bindBallTrajectoryAnomalyUiBridge } from '../../entities/trajectory/BallTrajectoryAnomalySnapshotBuilder.ts';
import { ReachabilityVisualizer } from '../../entities/ReachabilityVisualizer.ts';
import { CAR_COLOR_SLOTS } from '../../ui-core/config/vehicleConstants.ts';
import {
  getPreferredColorSlot,
  loadStoredPlayerName,
} from '../../ui-core/config/vehiclePresets.ts';
import { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.ts';
import type {
  HostOnlineServerOptions,
  JoinOnlineServerOptions,
  NetworkSessionChannelLike,
} from './onlineLobbyTransitionPipeline.ts';
import type { BoostBloom } from '../../effects/BoostBloom.ts';
import type { SupersonicSpeedLinesPass } from '../../effects/SupersonicSpeedLinesPass.ts';
import type { EffectComposer } from '../../effects/PostprocessingPipeline.ts';
import {
  syncMaterialsToGame,
  type applyVisualMaterialsConfig,
} from '../../effects/ThemeMaterialPipeline.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';

export type HostRoomSettings = HostOnlineServerOptions & Record<string, unknown>;
export type JoinRoomSettings = JoinOnlineServerOptions & Record<string, unknown>;

export interface PairingApprovalRequest {
  peerId: string;
  peerName: string;
  pairingCode: string;
}

export type SessionStatusSnapshot = Record<string, unknown>;

declare global {
  interface Window {
    __ENABLE_DETERMINISM_HARNESS__?: boolean;
    __ENABLE_NETWORK_PREDICTION__?: boolean;
  }
}

export interface TeamAssignmentPair {
  playerTeam: number;
  opponentTeam: number;
}

export interface MountedGameUIHandle {
  openMenu(route?: string): void;
  closeMenu(): void;
  toggleMenu(): void;
  attachToRuntime?(runtime: unknown): void;
  syncVisualMaterials?(): void;
  destroy(): void;
}

export interface RuntimeSceneOptions {
  CameraControllerClass?: new (aspect: number) => CameraManager;
  gameUI?: MountedGameUIHandle | null;
  mountUI?: (container: HTMLElement, runtime: unknown) => MountedGameUIHandle;
  [key: string]: unknown;
}

export interface SceneGraphRuntimeCallbacks {
  onResetKickoff(): void;
  onBallControl(actionId: string): void;
  onKickoffSpawnSelect(spawnIndex: number): void;
  onEnsurePlayerFlipResetVisual(carIndex: number): void;
  onSyncInitialMaterials(
    arena: ArenaWorld,
    applyFn: typeof applyVisualMaterialsConfig,
    materials: Record<string, unknown> | undefined
  ): void;
  onUpdateViewport(
    renderer: THREE.WebGLRenderer,
    camera: CameraManager,
    composer: EffectComposer,
    boostBloom: BoostBloom,
    speedLinesPass: SupersonicSpeedLinesPass | null,
    activeGraphicsSettings: Record<string, unknown>
  ): void;
  onEnableDeterminismHarness(autoOpenPanel: boolean): Promise<unknown>;
  onEnableNetworkPrediction(enabled: boolean): Promise<unknown>;
  onHostOnlineServer(opts: HostRoomSettings): Promise<unknown>;
  onStopOnlineServer(): Promise<void>;
  onJoinOnlineServer(opts: JoinRoomSettings): Promise<unknown>;
  onRemotePlayerConnected(channel: NetworkSessionChannelLike, name: string): Promise<number>;
  onRemoveRemotePlayer(carIndex: number): Promise<void>;
  onSetCarColor(carIndex: number, hex: string): void;
  onMountOrAttachGameUI(container: HTMLElement): MountedGameUIHandle | null;
  onDisposeHeadlessBloomOcclusion(): void;
}

export interface SceneGraphFactoryConfig {
  container: HTMLElement | null;
  physics: RocketSimPhysicsEngine;
  interpolator: PhysicsStateInterpolator;
  selectedPreset?: string | null;
  teamAssignment?: TeamAssignmentPair | null;
  playerCarIndex: number;
  options: RuntimeSceneOptions;
  onProgress?: ((progress: number, message?: string) => void) | null;
  callbacks: SceneGraphRuntimeCallbacks;
}

export interface RuntimeSceneCallbackHost {
  container: HTMLElement | null;
  selectedPreset: string;
  teamAssignment: TeamAssignmentPair | null;
  playerCarIndex: number;
  physics: RocketSimPhysicsEngine | null;
  interpolator: PhysicsStateInterpolator | null;
  arena: ArenaWorld | null;
  ballTrajectoryPredictor: BallTrajectoryPredictor | null;
  authoritativeServer: AuthoritativeServerHost | null;
  networkReconciler: PredictionReconciler | null;
  match: { state: { mode?: string } } | null;
  modeManager: { getActiveMode?(): unknown };
  options: RuntimeSceneOptions;
  bloomOcclusion: { dispose?(): void };
  domEventManager: { updateViewport(): void };
  networkManager: {
    diagnosticsProbe: { enableDeterminismHarness(autoOpenPanel: boolean): Promise<unknown> };
    sessionCoordinator: {
      enableNetworkPrediction(enabled: boolean): Promise<unknown>;
      hostOnlineServer(opts: HostRoomSettings): Promise<unknown>;
      stopOnlineServer(): Promise<void>;
      joinOnlineServer(opts: JoinRoomSettings): Promise<unknown>;
    };
    rosterSyncCoordinator: {
      onRemotePlayerConnected(
        channel: NetworkSessionChannelLike,
        name: string
      ): Promise<number | null | undefined>;
      removeRemotePlayer(carIndex: number): Promise<void>;
    };
  };
  resetKickoff(seed?: number): void;
  getFlipResetVisual(carIndex: number): unknown;
  setCarColor(carIndex: number, hex: string): void;
  bindInitialArenaAndMaterials(arena: ArenaWorld, applyFn: typeof applyVisualMaterialsConfig): void;
  bindViewportRenderTargets(
    renderer: THREE.WebGLRenderer,
    camera: CameraManager,
    composer: EffectComposer,
    boostBloom: BoostBloom,
    speedLinesPass: SupersonicSpeedLinesPass | null,
    activeGraphicsSettings: Record<string, unknown>
  ): void;
}

export function buildRuntimeSceneGraphConfig(
  host: RuntimeSceneCallbackHost,
  onProgress: ((progress: number, message?: string) => void) | null = null
): SceneGraphFactoryConfig {
  if (!host.physics || !host.interpolator) {
    throw new Error('[GameRuntime] setupPhysics must complete before setupScene.');
  }
  return {
    container: host.container,
    physics: host.physics,
    interpolator: host.interpolator,
    selectedPreset: host.selectedPreset,
    teamAssignment: host.teamAssignment,
    playerCarIndex: host.playerCarIndex,
    options: host.options,
    onProgress,
    callbacks: {
      onResetKickoff: () => host.resetKickoff(),
      onBallControl: (actionId) => {
        const activeMode = host.modeManager?.getActiveMode?.() as {
          nameTagTunerController?: { isActive?: boolean };
        } | null;
        const modeName = host.match?.state.mode;
        if (
          (modeName === 'freeplay' || modeName === 'online-warmup') &&
          !activeMode?.nameTagTunerController?.isActive &&
          host.physics?.controlBall(host.playerCarIndex, actionId)
        ) {
          if (host.authoritativeServer) {
            host.authoritativeServer.sim?.controlBall?.(host.playerCarIndex, actionId);
            const snap =
              typeof host.physics.saveCompactState === 'function'
                ? host.physics.saveCompactState()
                : host.physics.saveState();
            host.authoritativeServer.sim?.restoreState?.(snap);
            const curTick = Math.floor(host.physics.getHeaderView?.()?.tickCount ?? 0);
            host.networkReconciler?.syncTimeline?.(snap, curTick);
          }
          host.interpolator?.syncBall();
          host.arena?.resetBallTrail?.();
          host.ballTrajectoryPredictor?.notifyBallStateReset?.();
        }
      },
      onKickoffSpawnSelect: (spawnIndex) => {
        if (host.match?.state?.mode === 'kickoff-training') {
          const mode = host.modeManager?.getActiveMode?.() as {
            selectSpawn?(idx: number): void;
          } | null;
          mode?.selectSpawn?.(spawnIndex);
        }
      },
      onEnsurePlayerFlipResetVisual: (carIndex) => {
        host.getFlipResetVisual(carIndex);
      },
      onSyncInitialMaterials: (arena, applyFn, materials) => {
        host.bindInitialArenaAndMaterials(arena, applyFn);
        syncMaterialsToGame(
          host as unknown as Parameters<typeof syncMaterialsToGame>[0],
          materials
        );
      },
      onUpdateViewport: (renderer, camera, composer, boostBloom, speedLinesPass, gfx) => {
        host.bindViewportRenderTargets(renderer, camera, composer, boostBloom, speedLinesPass, gfx);
        host.domEventManager.updateViewport();
      },
      onEnableDeterminismHarness: (autoOpenPanel) =>
        host.networkManager.diagnosticsProbe.enableDeterminismHarness(autoOpenPanel),
      onEnableNetworkPrediction: (enabled) =>
        host.networkManager.sessionCoordinator.enableNetworkPrediction(enabled),
      onHostOnlineServer: (opts) => host.networkManager.sessionCoordinator.hostOnlineServer(opts),
      onStopOnlineServer: () => host.networkManager.sessionCoordinator.stopOnlineServer(),
      onJoinOnlineServer: (opts) => host.networkManager.sessionCoordinator.joinOnlineServer(opts),
      onRemotePlayerConnected: async (channel, name) =>
        (await host.networkManager.rosterSyncCoordinator.onRemotePlayerConnected(channel, name)) ??
        -1,
      onRemoveRemotePlayer: (carIndex) =>
        host.networkManager.rosterSyncCoordinator.removeRemotePlayer(carIndex),
      onSetCarColor: (carIndex, hex) => host.setCarColor(carIndex, hex),
      onMountOrAttachGameUI: (container) => {
        if (host.options?.gameUI) {
          host.options.gameUI.attachToRuntime?.(host);
          return host.options.gameUI;
        }
        if (typeof host.options?.mountUI === 'function') {
          return host.options.mountUI(container, host);
        }
        return null;
      },
      onDisposeHeadlessBloomOcclusion: () => {
        host.bloomOcclusion?.dispose?.();
      },
    },
  };
}

export interface VisualizersAndSessionBundle {
  ballTrajectoryPredictor: BallTrajectoryPredictor | null;
  reachabilityVisualizer: ReachabilityVisualizer | null;
  multiplayerSession: MultiplayerSessionManager;
}

export function createSceneVisualizersAndMultiplayerSession(params: {
  isTouchHeadless: boolean;
  arena: ArenaWorld | null;
  physics: RocketSimPhysicsEngine;
  callbacks: SceneGraphRuntimeCallbacks;
}): VisualizersAndSessionBundle {
  const { isTouchHeadless, arena, physics, callbacks } = params;
  let ballTrajectoryPredictor: BallTrajectoryPredictor | null = null;
  let reachabilityVisualizer: ReachabilityVisualizer | null = null;

  if (!isTouchHeadless && arena) {
    ballTrajectoryPredictor = new BallTrajectoryPredictor(
      arena.scene,
      {},
      physics?.ballRadius || 91.25,
      physics,
      (telemetry) => ballTrajectoryTunerStore.publishTelemetry(telemetry)
    );
    bindBallTrajectoryAnomalyUiBridge(
      ballTrajectoryPredictor.anomalyRecorder,
      ballTrajectoryTunerStore,
      pushQuickNotification,
      dismissQuickNotification
    );
    reachabilityVisualizer = new ReachabilityVisualizer(
      arena.scene,
      physics,
      ballTrajectoryPredictor,
      {
        getConfig: () => reachabilityStore.getConfig(),
        onTelemetry: (telemetry: unknown) => reachabilityStore.publishTelemetry(telemetry),
      }
    );
  }

  const urlParams =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isDeterminismTest = urlParams && urlParams.get('test') === 'determinism';
  if (
    isDeterminismTest ||
    (typeof window !== 'undefined' && window.__ENABLE_DETERMINISM_HARNESS__)
  ) {
    callbacks
      .onEnableDeterminismHarness(true)
      .catch((err: unknown) => console.error('[DeterminismHarness] Failed to activate:', err));
  }
  const isNetTest =
    urlParams &&
    (urlParams.get('test') === 'prediction' || urlParams.get('test') === 'multiplayer');
  if (isNetTest || (typeof window !== 'undefined' && window.__ENABLE_NETWORK_PREDICTION__)) {
    callbacks
      .onEnableNetworkPrediction(true)
      .catch((err: unknown) => console.error('[NetworkPrediction] Failed to activate:', err));
  }

  let multiplayerSession: MultiplayerSessionManager | null = null;
  multiplayerSession = new MultiplayerSessionManager({
    resolvePlayerName: () => loadStoredPlayerName().substring(0, 16),
    resolveTeamColor: (assignedTeam) => {
      const teamSlot = assignedTeam === 0 || assignedTeam === 1 ? assignedTeam : null;
      const idx = getPreferredColorSlot(null, teamSlot);
      if (idx >= 0 && idx < CAR_COLOR_SLOTS.length) {
        return { slot: idx, hex: CAR_COLOR_SLOTS[idx].hex };
      }
      return null;
    },
    onUnexpectedDisconnect: () => {
      notifyNetworkTelemetryExportAvailable('disconnected');
    },
    onHostServer: async (opts: HostRoomSettings) => {
      await callbacks.onHostOnlineServer(opts);
    },
    onStopServer: async () => {
      await callbacks.onStopOnlineServer();
    },
    onLeaveServer: async () => {
      await callbacks.onStopOnlineServer();
    },
    onJoinServer: async (opts: JoinRoomSettings) => {
      await callbacks.onJoinOnlineServer(opts);
    },
    onPeerConnected: async (channel: NetworkSessionChannelLike, name: string) => {
      return await callbacks.onRemotePlayerConnected(channel, name);
    },
    onRemovePlayer: async (carIndex: number) => {
      await callbacks.onRemoveRemotePlayer(carIndex);
    },
    onColorSelect: (carIndex: number, _slotId: number, hex: string) => {
      callbacks.onSetCarColor(carIndex, hex);
    },
    onSessionStatusChange: (status: SessionStatusSnapshot) => {
      if (useAppStore && typeof useAppStore.getState === 'function') {
        useAppStore.getState().setOnlineSession?.(status as unknown as Record<string, unknown>);
      }
    },
    onPairingApprovalRequest: (req: PairingApprovalRequest) => {
      const notifId = `pair-req-${req.peerId}`;
      pushQuickNotification({
        id: notifId,
        type: 'persistent',
        tone: 'warning',
        icon: 'shield-alert',
        duration: 0,
        content: `Join Request: "${req.peerName}" — Pair Code [${req.pairingCode}]`,
        buttons: [
          {
            label: 'Accept',
            color: 'emerald',
            onClick: () => {
              multiplayerSession?.approvePendingPeer?.(req.peerId);
              dismissQuickNotification(notifId);
            },
          },
          {
            label: 'Decline',
            color: 'rose',
            onClick: () => {
              multiplayerSession?.declinePendingPeer?.(req.peerId);
              dismissQuickNotification(notifId);
            },
          },
        ],
      });
    },
  });

  return {
    ballTrajectoryPredictor,
    reachabilityVisualizer,
    multiplayerSession,
  };
}
