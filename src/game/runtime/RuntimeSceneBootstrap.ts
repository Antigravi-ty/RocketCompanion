import * as THREE from 'three';
import {
  useAppStore,
  hudStore,
  pushQuickNotification,
  dismissQuickNotification,
  reachabilityStore,
  ballTrajectoryTunerStore,
  notifyNetworkTelemetryExportAvailable,
} from '../runtimeUiPort.ts';
import {
  applyVisualMaterialsConfig,
} from '../../effects/ThemeMaterialPipeline.ts';
import { BallTrajectoryPredictor } from '../../entities/BallTrajectoryPredictor.ts';
import { bindBallTrajectoryAnomalyUiBridge } from '../../entities/trajectory/BallTrajectoryAnomalyRecorder.ts';
import { ReachabilityVisualizer } from '../../entities/ReachabilityVisualizer.ts';
import { CameraManager } from '../../camera/CameraManager.ts';
import { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import { getTeamAssignment } from '../../physics/RocketSimMeshLoader.ts';
import { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import { RuntimeMatchState } from './RuntimeMatchState.ts';
import { KeyboardMouseController } from '../../input/KeyboardMouseController.ts';
import { GamepadController } from '../../input/GamepadController.ts';
import { loadInputBindings } from '../../ui-core/config/inputBindings';
import { DEFAULT_GRAPHICS_SETTINGS } from '../../ui-core/config/trainingDefaults';
import { CAR_COLOR_SLOTS } from '../../ui-core/config/vehicleConstants';
import {
  garageSettingsStore,
  getPreferredColorSlot,
  getPreferredFreeplayTeam,
  loadStoredPlayerName,
} from '../../ui-core/config/vehiclePresets';
import { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.ts';
import type {
  HostOnlineServerOptions,
  JoinOnlineServerOptions,
  NetworkSessionChannelLike,
} from './onlineLobbyTransitionPipeline.ts';
import { BoostBloom } from '../../effects/BoostBloom.ts';
import { SupersonicSpeedLinesPass } from '../../effects/SupersonicSpeedLinesPass.ts';
import {
  RenderPass,
  ShaderPass,
  OutputPass,
} from '../../effects/PostprocessingPasses.ts';
import { EffectComposer } from '../../effects/PostprocessingPipeline.ts';
import { RoomEnvironment } from '../../effects/RoomEnvironment.ts';
import { ArenaWorld } from '../../entities/ArenaWorld.ts';
import { EntityManager } from '../../entities/EntityManager.ts';

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

export interface PhysicsBootstrapConfig {
  options?: Record<string, unknown>;
  onPhysicsRateChange?: (nextRate: number) => void;
}

export interface CorePhysicsBundle {
  physics: RocketSimPhysicsEngine;
  interpolator: PhysicsStateInterpolator;
  match: RuntimeMatchState;
  selectedPreset: string;
  teamAssignment: TeamAssignmentPair;
  playerCarIndex: number;
}

export interface SceneGraphRuntimeCallbacks {
  onResetKickoff(): void;
  onBallControl(actionId: string): void;
  onKickoffSpawnSelect(spawnIndex: number): void;
  onEnsurePlayerFlipResetVisual(carIndex: number): void;
  onSyncInitialMaterials(
    arena: ArenaWorld,
    applyFn: typeof applyVisualMaterialsConfig,
    materials: Record<string, unknown> | undefined,
  ): void;
  onUpdateViewport(
    renderer: THREE.WebGLRenderer,
    camera: CameraManager,
    composer: EffectComposer,
    boostBloom: BoostBloom,
    speedLinesPass: SupersonicSpeedLinesPass | null,
    activeGraphicsSettings: Record<string, unknown>,
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

export interface SceneGraphBundle {
  selectedPreset: string;
  teamAssignment: TeamAssignmentPair;
  keyboard: KeyboardMouseController;
  gamepad: GamepadController;
  arena: ArenaWorld | null;
  entityManager: EntityManager | null;
  speedLinesPass: SupersonicSpeedLinesPass | null;
  applyVisualMaterialsConfig: typeof applyVisualMaterialsConfig | null;
  camera: CameraManager;
  cursorHintButton: HTMLButtonElement | null;
  activeGraphicsSettings: Record<string, unknown>;
  ballTrajectoryPredictor: BallTrajectoryPredictor | null;
  reachabilityVisualizer: ReachabilityVisualizer | null;
  multiplayerSession: MultiplayerSessionManager;
  gameUI: MountedGameUIHandle | null;
  renderer: THREE.WebGLRenderer | null;
  boostBloom: BoostBloom | null;
  composer: EffectComposer | null;
  isTouchHeadless: boolean;
}

export interface DisposableSceneGraphResources {
  cursorHintButton: HTMLButtonElement | null;
  keyboard: KeyboardMouseController | null;
  gamepad: GamepadController | null;
  camera: CameraManager | null;
  multiplayerSession: MultiplayerSessionManager | null;
  ballTrajectoryPredictor: BallTrajectoryPredictor | null;
  reachabilityVisualizer: ReachabilityVisualizer | null;
  gameUI: MountedGameUIHandle | null;
  composer: EffectComposer | null;
  boostBloom: BoostBloom | null;
  speedLinesPass: SupersonicSpeedLinesPass | null;
  renderer: THREE.WebGLRenderer | null;
  arena: ArenaWorld | null;
  physics: RocketSimPhysicsEngine | null;
}

/**
 * Pure factory creating the 120Hz WASM physics engine, state interpolator,
 * match state container, and initial freeplay car slot.
 */
export async function createCorePhysicsBundle(
  config: PhysicsBootstrapConfig = {},
): Promise<CorePhysicsBundle> {
  const loadedSettings = garageSettingsStore.load() as {
    vehiclePreset?: string;
    carVisual?: string;
  };
  const selectedPreset =
    loadedSettings.vehiclePreset || loadedSettings.carVisual || 'fennec';
  const freeplayTeam = getPreferredFreeplayTeam();
  const teamAssignment = getTeamAssignment(freeplayTeam === 1);

  const physics = new RocketSimPhysicsEngine();
  await physics.init(config.options ?? {});
  const playerCarIndex = physics.addCar(
    teamAssignment.playerTeam,
    selectedPreset,
  );
  physics.resetKickoff();

  const interpolator = new PhysicsStateInterpolator(physics);
  if (config.onPhysicsRateChange) {
    interpolator.onPhysicsRateChange = config.onPhysicsRateChange;
  }
  const match = new RuntimeMatchState();

  return {
    physics,
    interpolator,
    match,
    selectedPreset,
    teamAssignment,
    playerCarIndex,
  };
}

/**
 * Pure factory building the 3D scene graph, input controllers, postprocessing pipeline,
 * trajectory/reachability visualizers, and multiplayer session coordinator.
 * Returns a strongly-typed SceneGraphBundle assigned by GameRuntime.
 */
export async function createCoreSceneGraph(
  config: SceneGraphFactoryConfig,
): Promise<SceneGraphBundle> {
  const {
    container,
    physics,
    selectedPreset: presetOverride,
    teamAssignment: existingTeams,
    playerCarIndex,
    options,
    onProgress = null,
    callbacks,
  } = config;

  const loadedSettings = garageSettingsStore.load() as {
    vehiclePreset?: string;
    carVisual?: string;
  };
  const selectedPreset =
    presetOverride ||
    loadedSettings.vehiclePreset ||
    loadedSettings.carVisual ||
    'fennec';
  const freeplayTeam = getPreferredFreeplayTeam();
  const teamAssignment: TeamAssignmentPair =
    existingTeams || getTeamAssignment(freeplayTeam === 1);
  teamAssignment.playerTeam = freeplayTeam;
  teamAssignment.opponentTeam = freeplayTeam === 0 ? 1 : 0;
  hudStore.getState().setMatchState({ localTeam: freeplayTeam });

  const isTouchHeadless = Boolean(useAppStore?.getState?.()?.touchHeadlessMode);

  const bindings = loadInputBindings();
  const keyboard = new KeyboardMouseController(bindings);
  const gamepad = new GamepadController(bindings);

  const onResetHandler = () => callbacks.onResetKickoff();
  keyboard.onReset = onResetHandler;
  gamepad.onReset = onResetHandler;

  let arena: ArenaWorld | null = null;
  let entityManager: EntityManager | null = null;
  let speedLinesPass: SupersonicSpeedLinesPass | null = null;
  let resolvedApplyVisualMaterials: typeof applyVisualMaterialsConfig | null = null;

  if (!isTouchHeadless) {
    speedLinesPass = new SupersonicSpeedLinesPass();
    arena = new ArenaWorld(physics.ballRadius, selectedPreset);
    await arena.loadAllAssets(onProgress);
    entityManager = new EntityManager({
      physics,
      arena,
    });
    entityManager.spawnVehicle(0, {
      team: freeplayTeam,
      visual: selectedPreset,
      isPlayer: true,
    });
    await arena.ensureOpponent();
    if (arena.cars[1]) {
      arena.cars[1].visible = false;
    }
    arena.addPads(physics.getPads());

    resolvedApplyVisualMaterials = applyVisualMaterialsConfig;
    callbacks.onSyncInitialMaterials(
      arena,
      applyVisualMaterialsConfig,
      useAppStore.getState().materials,
    );
  } else if (typeof onProgress === 'function') {
    onProgress(1.0, 'Headless React-only mode (?touch=2) ready — Three.js disabled');
  }

  const onBallControlHandler = (actionId: string) => {
    callbacks.onBallControl(actionId);
  };
  keyboard.onBallControl = onBallControlHandler;
  gamepad.onBallControl = onBallControlHandler;

  keyboard.onKickoffSpawnSelect = (spawnIndex: number) => {
    callbacks.onKickoffSpawnSelect(spawnIndex);
  };

  if (!isTouchHeadless) {
    callbacks.onEnsurePlayerFlipResetVisual(playerCarIndex);
  }

  const aspect =
    typeof window !== 'undefined' ? window.innerWidth / window.innerHeight : 16 / 9;
  const CameraControllerClass = options.CameraControllerClass || CameraManager;
  const camera = new CameraControllerClass(aspect);
  const freeCtrl = camera?.controllers?.get?.('free') as
    | {
        onFovChange?: (fov: number) => void;
        shouldSuppressRightClickDrag?: () => boolean;
      }
    | undefined;
  if (freeCtrl) {
    freeCtrl.onFovChange = (newFov: number) =>
      useAppStore.setState({ freeCamFov: newFov });
    freeCtrl.shouldSuppressRightClickDrag = () =>
      useAppStore.getState().matchMode === 'static-training-pack';
  }

  const cursorHintButton =
    typeof document !== 'undefined' ? document.createElement('button') : null;
  if (cursorHintButton) {
    cursorHintButton.type = 'button';
    cursorHintButton.className = 'cursor-hint';
  }

  const activeGraphicsSettings: Record<string, unknown> = {
    ...DEFAULT_GRAPHICS_SETTINGS,
  };

  let ballTrajectoryPredictor: BallTrajectoryPredictor | null = null;
  let reachabilityVisualizer: ReachabilityVisualizer | null = null;

  if (!isTouchHeadless && arena) {
    ballTrajectoryPredictor = new BallTrajectoryPredictor(
      arena.scene,
      {},
      physics?.ballRadius || 91.25,
      physics,
      (telemetry) => ballTrajectoryTunerStore.publishTelemetry(telemetry),
    );
    bindBallTrajectoryAnomalyUiBridge(
      ballTrajectoryPredictor.anomalyRecorder,
      ballTrajectoryTunerStore,
      pushQuickNotification,
      dismissQuickNotification,
    );
    reachabilityVisualizer = new ReachabilityVisualizer(
      arena.scene,
      physics,
      ballTrajectoryPredictor,
      {
        getConfig: () => reachabilityStore.getConfig(),
        onTelemetry: (telemetry: unknown) => reachabilityStore.publishTelemetry(telemetry),
      },
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

  let gameUI: MountedGameUIHandle | null = null;
  if (container && typeof document !== 'undefined') {
    gameUI = callbacks.onMountOrAttachGameUI(container);
    const carBtn = container.querySelector('#car-button') as HTMLElement | null;
    if (carBtn) {
      carBtn.onclick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        gameUI?.openMenu('garage');
      };
    }
  }

  const onToggleBallCam = () => {
    if (typeof camera.handleAction === 'function') {
      camera.handleAction('ballCam');
    } else {
      camera.ballCam = !camera.ballCam;
    }
    hudStore.getState().setBallCamActive(camera.ballCam);
  };
  gamepad.onBallCamToggle = onToggleBallCam;
  keyboard.onBallCamToggle = onToggleBallCam;
  keyboard.onFreeCamToggle = () => useAppStore.getState().toggleFreeCam();
  hudStore.getState().setOnToggleBallCam(onToggleBallCam);
  hudStore.getState().setBallCamActive(camera.ballCam);
  hudStore.getState().syncBindings(bindings);

  let renderer: THREE.WebGLRenderer | null = null;
  let boostBloom: BoostBloom | null = null;
  let composer: EffectComposer | null = null;

  if (!isTouchHeadless && arena && speedLinesPass) {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const winHeight = typeof window !== 'undefined' ? window.innerHeight : 720;
    const devicePixelRatio =
      typeof window !== 'undefined' ? Math.min(window.devicePixelRatio, 2) : 1;

    renderer.setSize(winWidth, winHeight);
    renderer.setPixelRatio(devicePixelRatio);
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.BasicShadowMap ?? THREE.PCFShadowMap ?? 0;
      renderer.shadowMap.autoUpdate = false;
    }
    renderer.toneMapping = THREE.ACESFilmicToneMapping || 4;
    renderer.toneMappingExposure = 1.15;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    arena.scene.environment = pmrem.fromScene(roomEnv, 0.04).texture;
    arena.scene.environmentIntensity = 0.5;
    roomEnv.dispose();
    pmrem.dispose();

    if (
      container &&
      renderer.domElement &&
      renderer.domElement.parentNode !== container
    ) {
      if (renderer.domElement.classList?.add) {
        renderer.domElement.classList.add('game-canvas');
      }
      container.appendChild(renderer.domElement);
    }

    boostBloom = new BoostBloom(
      renderer,
      winWidth,
      winHeight,
      renderer.getPixelRatio(),
    );
    composer = new EffectComposer(renderer);
    callbacks.onUpdateViewport(
      renderer,
      camera,
      composer,
      boostBloom,
      speedLinesPass,
      activeGraphicsSettings,
    );

    composer.addPass(new RenderPass(arena.scene, camera.camera));

    composer.addPass(
      new ShaderPass(
        new THREE.ShaderMaterial({
          uniforms: {
            baseTexture: { value: null },
            bloomTexture: { value: boostBloom.texture },
          },
          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform sampler2D baseTexture;
            uniform sampler2D bloomTexture;
            varying vec2 vUv;
            void main() {
              vec4 base = texture2D(baseTexture, vUv);
              vec3 glow = texture2D(bloomTexture, vUv).rgb;
              gl_FragColor = vec4(base.rgb + glow, base.a);
            }
          `,
        }),
        'baseTexture',
      ),
    );
    composer.addPass(new OutputPass());
    composer.addPass(speedLinesPass.pass);
  } else {
    callbacks.onDisposeHeadlessBloomOcclusion();
  }

  return {
    selectedPreset,
    teamAssignment,
    keyboard,
    gamepad,
    arena,
    entityManager,
    speedLinesPass,
    applyVisualMaterialsConfig: resolvedApplyVisualMaterials,
    camera,
    cursorHintButton,
    activeGraphicsSettings,
    ballTrajectoryPredictor,
    reachabilityVisualizer,
    multiplayerSession,
    gameUI,
    renderer,
    boostBloom,
    composer,
    isTouchHeadless,
  };
}

/**
 * Pure teardown helper disposing scene graph, input, UI, and physics resources.
 */
export function disposeCoreSceneGraph(
  resources: DisposableSceneGraphResources,
): void {
  if (resources.cursorHintButton && resources.cursorHintButton.parentElement) {
    resources.cursorHintButton.parentElement.removeChild(resources.cursorHintButton);
  }

  resources.keyboard?.dispose?.();
  resources.gamepad?.dispose?.();
  resources.camera?.dispose?.();

  if (resources.multiplayerSession) {
    resources.multiplayerSession.stopHosting?.();
    resources.multiplayerSession.leaveSession?.();
  }

  resources.ballTrajectoryPredictor?.dispose?.();
  resources.reachabilityVisualizer?.dispose?.();
  resources.gameUI?.destroy?.();
  resources.composer?.dispose?.();
  resources.boostBloom?.dispose?.();
  resources.speedLinesPass?.dispose?.();

  if (resources.renderer) {
    if (resources.renderer.domElement && resources.renderer.domElement.parentElement) {
      resources.renderer.domElement.parentElement.removeChild(resources.renderer.domElement);
    }
    resources.renderer.dispose?.();
  }

  resources.arena?.dispose?.();
  resources.physics?.destroy?.();
}
