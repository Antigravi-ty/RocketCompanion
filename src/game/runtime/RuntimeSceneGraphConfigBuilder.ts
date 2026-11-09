import type * as THREE from 'three';
import {
  syncMaterialsToGame,
  type applyVisualMaterialsConfig,
} from '../../effects/ThemeMaterialPipeline.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { BoostBloom } from '../../effects/BoostBloom.ts';
import type { SupersonicSpeedLinesPass } from '../../effects/SupersonicSpeedLinesPass.ts';
import type { EffectComposer } from '../../effects/PostprocessingPipeline.ts';
import type { NetworkSessionChannelLike } from './onlineLobbyTransitionPipeline.ts';
import type {
  HostRoomSettings,
  JoinRoomSettings,
  MountedGameUIHandle,
  RuntimeSceneCallbackHost,
  SceneGraphFactoryConfig,
  SceneGraphRuntimeCallbacks,
} from './RuntimePostprocessingAndSessionBootstrap.ts';

function executeFreeplayBallControlAction(
  target: RuntimeSceneCallbackHost,
  actionId: string
): void {
  const activeMode = target.modeManager?.getActiveMode?.() as {
    nameTagTunerController?: { isActive?: boolean };
  } | null;
  const modeName = target.match?.state.mode;
  if (
    (modeName === 'freeplay' || modeName === 'online-warmup') &&
    !activeMode?.nameTagTunerController?.isActive &&
    target.physics?.controlBall(target.playerCarIndex, actionId)
  ) {
    if (target.authoritativeServer) {
      target.authoritativeServer.sim?.controlBall?.(target.playerCarIndex, actionId);
      const snap =
        typeof target.physics.saveCompactState === 'function'
          ? target.physics.saveCompactState()
          : target.physics.saveState();
      target.authoritativeServer.sim?.restoreState?.(snap);
      const curTick = Math.floor(target.physics.getHeaderView?.()?.tickCount ?? 0);
      target.networkReconciler?.syncTimeline?.(snap, curTick);
    }
    target.interpolator?.syncBall();
    target.arena?.resetBallTrail?.();
    target.ballTrajectoryPredictor?.notifyBallStateReset?.();
  }
}

export function buildRuntimeSceneGraphConfig(
  target: RuntimeSceneCallbackHost,
  onProgress: ((progress: number, message?: string) => void) | null = null
): SceneGraphFactoryConfig {
  if (!target.physics || !target.interpolator) {
    throw new Error('[GameRuntime] setupPhysics must complete before setupScene.');
  }

  const handleResetKickoff = () => {
    target.resetKickoff();
  };
  const handleBallControl = (actionId: string) => {
    executeFreeplayBallControlAction(target, actionId);
  };
  const handleKickoffSpawnSelect = (spawnIndex: number) => {
    if (target.match?.state?.mode === 'kickoff-training') {
      const activeMode = target.modeManager?.getActiveMode?.() as {
        selectSpawn?(idx: number): void;
      } | null;
      activeMode?.selectSpawn?.(spawnIndex);
    }
  };
  const handleEnsurePlayerFlipResetVisual = (carIndex: number) => {
    target.getFlipResetVisual(carIndex);
  };
  const handleSyncInitialMaterials = (
    arena: ArenaWorld,
    applyFn: typeof applyVisualMaterialsConfig,
    materials: Record<string, unknown> | undefined
  ) => {
    target.arena = arena;
    target.applyVisualMaterialsConfig = applyFn;
    syncMaterialsToGame(target as unknown as Parameters<typeof syncMaterialsToGame>[0], materials);
  };
  const handleUpdateViewport = (
    renderer: THREE.WebGLRenderer,
    camera: CameraManager,
    composer: EffectComposer,
    boostBloom: BoostBloom,
    speedLinesPass: SupersonicSpeedLinesPass | null,
    gfx: Record<string, unknown>
  ) => {
    Object.assign(target, {
      renderer,
      camera,
      composer,
      boostBloom,
      speedLinesPass,
      activeGraphicsSettings: gfx,
    });
    target.domEventManager.updateViewport();
  };
  const handleEnableDeterminismHarness = (autoOpenPanel: boolean) =>
    target.networkManager.diagnosticsProbe.enableDeterminismHarness(autoOpenPanel);
  const handleEnableNetworkPrediction = (enabled: boolean) =>
    target.networkManager.sessionCoordinator.enableNetworkPrediction(enabled);
  const handleHostOnlineServer = (opts: HostRoomSettings) =>
    target.networkManager.sessionCoordinator.hostOnlineServer(opts);
  const handleStopOnlineServer = () => target.networkManager.sessionCoordinator.stopOnlineServer();
  const handleJoinOnlineServer = (opts: JoinRoomSettings) =>
    target.networkManager.sessionCoordinator.joinOnlineServer(opts);
  const handleRemotePlayerConnected = async (channel: NetworkSessionChannelLike, name: string) =>
    (await target.networkManager.rosterSyncCoordinator.onRemotePlayerConnected(channel, name)) ??
    -1;
  const handleRemoveRemotePlayer = (carIndex: number) =>
    target.networkManager.rosterSyncCoordinator.removeRemotePlayer(carIndex);
  const handleSetCarColor = (carIndex: number, hex: string) => {
    target.setCarColor(carIndex, hex);
  };
  const handleMountOrAttachGameUI = (container: HTMLElement): MountedGameUIHandle | null => {
    if (target.options?.gameUI) {
      target.options.gameUI.attachToRuntime?.(target);
      return target.options.gameUI;
    }
    if (typeof target.options?.mountUI === 'function') {
      return target.options.mountUI(container, target);
    }
    return null;
  };
  const handleDisposeHeadlessBloomOcclusion = () => {
    target.bloomOcclusion?.dispose?.();
  };

  const callbacks: SceneGraphRuntimeCallbacks = {
    onResetKickoff: handleResetKickoff,
    onBallControl: handleBallControl,
    onKickoffSpawnSelect: handleKickoffSpawnSelect,
    onEnsurePlayerFlipResetVisual: handleEnsurePlayerFlipResetVisual,
    onSyncInitialMaterials: handleSyncInitialMaterials,
    onUpdateViewport: handleUpdateViewport,
    onEnableDeterminismHarness: handleEnableDeterminismHarness,
    onEnableNetworkPrediction: handleEnableNetworkPrediction,
    onHostOnlineServer: handleHostOnlineServer,
    onStopOnlineServer: handleStopOnlineServer,
    onJoinOnlineServer: handleJoinOnlineServer,
    onRemotePlayerConnected: handleRemotePlayerConnected,
    onRemoveRemotePlayer: handleRemoveRemotePlayer,
    onSetCarColor: handleSetCarColor,
    onMountOrAttachGameUI: handleMountOrAttachGameUI,
    onDisposeHeadlessBloomOcclusion: handleDisposeHeadlessBloomOcclusion,
  };

  return {
    container: target.container,
    physics: target.physics,
    interpolator: target.interpolator,
    selectedPreset: target.selectedPreset,
    teamAssignment: target.teamAssignment,
    playerCarIndex: target.playerCarIndex,
    options: target.options,
    onProgress,
    callbacks,
  };
}
