import * as THREE from 'three';
import { useAppStore } from '../../ui-core/stores/appStore';
import {
  syncMaterialsToGame,
  applyVisualMaterialsConfig
} from '../../effects/ThemeMaterialPipeline.js';
import { hudStore } from '../../ui-core/stores/hudStore';
import { pushQuickNotification, dismissQuickNotification } from '../../ui-core/stores/quickNotificationStore';
import { reachabilityStore } from '../../ui-core/stores/reachabilityStore';
import { BallTrajectoryPredictor } from '../../entities/BallTrajectoryPredictor.js';
import { ReachabilityVisualizer } from '../../entities/ReachabilityVisualizer.js';
import { CameraManager } from '../../camera/CameraManager.js';
import { RocketSimPhysicsEngine, getTeamAssignment } from '../../physics/RocketSimPhysicsEngine.js';
import { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.js';
import { RuntimeMatchState } from './RuntimeMatchState.js';
import { KeyboardMouseController } from '../../input/KeyboardMouseController.js';
import { GamepadController } from '../../input/GamepadController.js';
import { loadInputBindings } from '../../ui-core/config/InputBindings.js';
import { DEFAULT_GRAPHICS_SETTINGS } from '../../ui-core/config/trainingDefaults.js';
import { garageSettingsStore } from '../../ui-core/config/vehiclePresets.js';
import { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.js';
import { BoostBloom } from '../../effects/BoostBloom.js';
import { SupersonicSpeedLinesPass } from '../../effects/SupersonicSpeedLinesPass.js';
import {
  RenderPass,
  ShaderPass,
  OutputPass,
  EffectComposer,
  RoomEnvironment
} from '../../effects/PostprocessingPipeline.js';
import { ArenaWorld } from '../../entities/ArenaWorld.js';
import { EntityManager } from '../../entities/EntityManager.js';

export async function setupRuntimePhysics(runtime, options = {}) {
  const loadedSettings = garageSettingsStore.load();
  const selectedPreset = loadedSettings.vehiclePreset || loadedSettings.carVisual || 'fennec';
  runtime.selectedPreset = selectedPreset;
  runtime.teamAssignment = getTeamAssignment(false);

  runtime.physics = new RocketSimPhysicsEngine();
  await runtime.physics.init(options);
  runtime.playerCarIndex = runtime.physics.addCar(
    runtime.teamAssignment.playerTeam,
    selectedPreset
  );
  runtime.physics.resetKickoff();

  runtime.interpolator = new PhysicsStateInterpolator(runtime.physics);
  runtime.interpolator.onPhysicsRateChange = (nextRate) => {
    runtime.physicsRate = nextRate;
  };
  runtime.match = new RuntimeMatchState();
  runtime.bot = null;

  runtime.audioSubsystem.engineSynths = [];
  runtime.resetAudio();
}

export async function setupRuntimeScene(runtime, onProgress = null) {
  const loadedSettings = garageSettingsStore.load();
  const selectedPreset = runtime.selectedPreset || loadedSettings.vehiclePreset || loadedSettings.carVisual || 'fennec';
  runtime.teamAssignment = runtime.teamAssignment || getTeamAssignment(false);

  const isTouchHeadless = Boolean(useAppStore?.getState?.()?.touchHeadlessMode);

  const bindings = loadInputBindings();
  runtime.keyboard = new KeyboardMouseController(bindings);
  runtime.gamepad = new GamepadController(bindings);

  const onResetHandler = () => runtime.resetKickoff();
  runtime.keyboard.onReset = onResetHandler;
  runtime.gamepad.onReset = onResetHandler;

  if (!isTouchHeadless) {
    runtime.speedLinesPass = new SupersonicSpeedLinesPass();
    runtime.arena = new ArenaWorld(runtime.physics.ballRadius, selectedPreset);
    await runtime.arena.loadAllAssets(onProgress);
    runtime.entityManager = new EntityManager({ physics: runtime.physics, arena: runtime.arena });
    runtime.entityManager.spawnVehicle(0, { team: 0, visual: selectedPreset, isPlayer: true });
    runtime.arena.addPads(runtime.physics.getPads());

    runtime.applyVisualMaterialsConfig = applyVisualMaterialsConfig;
    syncMaterialsToGame(runtime, useAppStore.getState().materials);
  } else {
    runtime.arena = null;
    runtime.entityManager = null;
    runtime.speedLinesPass = null;
    if (typeof onProgress === 'function') {
      onProgress(1.0, 'Headless React-only mode (?touch=2) ready — Three.js disabled');
    }
  }

  const onBallControlHandler = actionId => {
    const activeMode = runtime.modeManager?.getActiveMode?.();
    if (runtime.match.state.mode === 'freeplay' && !activeMode?.nameTagTunerController?.isActive) {
      if (runtime.physics.controlBall(runtime.playerCarIndex, actionId)) {
        runtime.interpolator.syncBall();
        runtime.arena?.resetBallTrail?.();
      }
    }
  };
  runtime.keyboard.onBallControl = onBallControlHandler;
  runtime.gamepad.onBallControl = onBallControlHandler;

  runtime.keyboard.onKickoffSpawnSelect = (spawnIndex) => {
    if (runtime.match?.state?.mode === 'kickoff-training') {
      const mode = runtime.modeManager?.getActiveMode?.();
      if (mode && typeof mode.selectSpawn === 'function') {
        mode.selectSpawn(spawnIndex);
      }
    }
  };

  if (!isTouchHeadless) {
    runtime.getFlipResetVisual(runtime.playerCarIndex);
  }

  const aspect = typeof window !== 'undefined' ? window.innerWidth / window.innerHeight : 16 / 9;
  const CameraControllerClass = runtime.options.CameraControllerClass || CameraManager;
  runtime.camera = new CameraControllerClass(aspect);
  const freeCtrl = runtime.camera?.controllers?.get?.('free');
  if (freeCtrl) {
    freeCtrl.onFovChange = (newFov) => useAppStore.setState({ freeCamFov: newFov });
    freeCtrl.shouldSuppressRightClickDrag = () =>
      useAppStore.getState().matchMode === 'static-training-pack';
  }

  runtime.cursorHintButton = typeof document !== 'undefined' ? document.createElement('button') : null;
  if (runtime.cursorHintButton) {
    runtime.cursorHintButton.type = 'button';
    runtime.cursorHintButton.className = 'cursor-hint';
  }

  runtime.activeGraphicsSettings = { ...DEFAULT_GRAPHICS_SETTINGS };

  if (!isTouchHeadless) {
    runtime.ballTrajectoryPredictor = new BallTrajectoryPredictor(runtime.arena?.scene, {}, runtime.physics?.ballRadius || 91.25, runtime.physics);
    runtime.reachabilityVisualizer = new ReachabilityVisualizer(
      runtime.arena?.scene,
      runtime.physics,
      runtime.ballTrajectoryPredictor,
      {
        getConfig: () => reachabilityStore.getConfig(),
        onTelemetry: (telemetry) => reachabilityStore.publishTelemetry(telemetry),
      }
    );
  }

  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isDeterminismTest = urlParams && urlParams.get('test') === 'determinism';
  if (isDeterminismTest || (typeof window !== 'undefined' && window.__ENABLE_DETERMINISM_HARNESS__)) {
    runtime.enableDeterminismHarness(true).catch(err => console.error('[DeterminismHarness] Failed to activate:', err));
  }
  const isNetTest = urlParams && (urlParams.get('test') === 'prediction' || urlParams.get('test') === 'multiplayer');
  if (isNetTest || (typeof window !== 'undefined' && window.__ENABLE_NETWORK_PREDICTION__)) {
    runtime.enableNetworkPrediction(true).catch(err => console.error('[NetworkPrediction] Failed to activate:', err));
  }

  runtime.multiplayerSession = new MultiplayerSessionManager({
    onHostServer: async (opts) => {
      await runtime.hostOnlineServer(opts);
    },
    onStopServer: async () => {
      await runtime.stopOnlineServer();
    },
    onLeaveServer: async () => {
      await runtime.stopOnlineServer();
    },
    onJoinServer: async (opts) => {
      await runtime.joinOnlineServer(opts);
    },
    onPeerConnected: async (channel, name) => {
      return await runtime.onRemotePlayerConnected(channel, name);
    },
    onRemovePlayer: async (carIndex) => {
      await runtime.removeRemotePlayer(carIndex);
    },
    onColorSelect: (carIndex, slotId, hex) => {
      runtime.setCarColor(carIndex, hex);
    },
    onSessionStatusChange: (status) => {
      if (useAppStore && typeof useAppStore.getState === 'function') {
        useAppStore.getState().setOnlineSession?.(status);
      }
    },
    onPairingApprovalRequest: (req) => {
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
              runtime.multiplayerSession?.approvePendingPeer?.(req.peerId);
              dismissQuickNotification(notifId);
            },
          },
          {
            label: 'Decline',
            color: 'rose',
            onClick: () => {
              runtime.multiplayerSession?.declinePendingPeer?.(req.peerId);
              dismissQuickNotification(notifId);
            },
          },
        ],
      });
    },
  });

  runtime.selectedPreset = selectedPreset;

  if (runtime.container && typeof document !== 'undefined') {
    if (runtime.options?.gameUI) {
      runtime.gameUI = runtime.options.gameUI;
      runtime.gameUI.attachToRuntime?.(runtime);
    } else if (typeof runtime.options?.mountUI === 'function') {
      runtime.gameUI = runtime.options.mountUI(runtime.container, runtime);
    }
    const carBtn = runtime.container.querySelector('#car-button');
    if (carBtn) {
      carBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        runtime.gameUI?.openMenu('garage');
      };
    }
  }

  const onToggleBallCam = () => {
    if (typeof runtime.camera.handleAction === 'function') {
      runtime.camera.handleAction('ballCam');
    } else {
      runtime.camera.ballCam = !runtime.camera.ballCam;
    }
    hudStore.getState().setBallCamActive(runtime.camera.ballCam);
  };
  runtime.gamepad.onBallCamToggle = onToggleBallCam;
  runtime.keyboard.onBallCamToggle = onToggleBallCam;
  runtime.keyboard.onFreeCamToggle = () => useAppStore.getState().toggleFreeCam();
  hudStore.getState().setOnToggleBallCam(onToggleBallCam);
  hudStore.getState().setBallCamActive(runtime.camera.ballCam);
  hudStore.getState().syncBindings(bindings);

  if (!isTouchHeadless) {
    runtime.renderer = new THREE.WebGLRenderer({ antialias: true });
    const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const winHeight = typeof window !== 'undefined' ? window.innerHeight : 720;
    const devicePixelRatio = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio, 2) : 1;

    runtime.renderer.setSize(winWidth, winHeight);
    runtime.renderer.setPixelRatio(devicePixelRatio);
    if (runtime.renderer.shadowMap) {
      runtime.renderer.shadowMap.enabled = true;
      runtime.renderer.shadowMap.type = THREE.BasicShadowMap ?? THREE.PCFShadowMap ?? 0;
      runtime.renderer.shadowMap.autoUpdate = false;
    }
    runtime.renderer.toneMapping = THREE.ACESFilmicToneMapping || 4;
    runtime.renderer.toneMappingExposure = 1.15;

    const pmrem = new THREE.PMREMGenerator(runtime.renderer);
    const roomEnv = new RoomEnvironment();
    runtime.arena.scene.environment = pmrem.fromScene(roomEnv, 0.04).texture;
    runtime.arena.scene.environmentIntensity = 0.5;
    roomEnv.dispose();
    pmrem.dispose();

    if (runtime.container && runtime.renderer.domElement && runtime.renderer.domElement.parentNode !== runtime.container) {
      if (runtime.renderer.domElement.classList?.add) {
        runtime.renderer.domElement.classList.add('game-canvas');
      }
      runtime.container.appendChild(runtime.renderer.domElement);
    }

    runtime.boostBloom = new BoostBloom(runtime.renderer, winWidth, winHeight, runtime.renderer.getPixelRatio());
    runtime.composer = new EffectComposer(runtime.renderer);
    runtime.updateViewport();

    runtime.composer.addPass(new RenderPass(runtime.arena.scene, runtime.camera.camera));

    runtime.composer.addPass(
      new ShaderPass(
        new THREE.ShaderMaterial({
          uniforms: {
            baseTexture: { value: null },
            bloomTexture: { value: runtime.boostBloom.texture }
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
          `
        }),
        'baseTexture'
      )
    );
    runtime.composer.addPass(new OutputPass());
    runtime.composer.addPass(runtime.speedLinesPass.pass);

    runtime.bloomDarkMaterial = new THREE.MeshBasicMaterial({
      color: 0,
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide || 2
    });
  } else {
    runtime.renderer = null;
    runtime.boostBloom = null;
    runtime.composer = null;
    runtime.bloomDarkMaterial = null;
  }

  runtime.setupWindowEvents();
  if (isTouchHeadless) {
    useAppStore?.getState?.()?.openMenu?.('main-menu');
  }
}

export function destroyRuntimeInstance(runtime) {
  runtime.stop();
  runtime.domEventManager?.destroy?.();

  if (runtime.cursorHintButton && runtime.cursorHintButton.parentElement) {
    runtime.cursorHintButton.parentElement.removeChild(runtime.cursorHintButton);
    runtime.cursorHintButton = null;
  }

  if (runtime.keyboard) {
    runtime.keyboard.dispose?.();
    runtime.keyboard = null;
  }
  if (runtime.gamepad) {
    runtime.gamepad.dispose?.();
    runtime.gamepad = null;
  }

  runtime.audioSubsystem?.dispose?.();
  runtime.cameraSubsystem?.dispose?.();
  runtime.renderSubsystem?.dispose?.();

  if (runtime.camera) {
    runtime.camera.dispose?.();
    runtime.camera = null;
  }
  if (runtime.determinismHarness) {
    runtime.determinismHarness.destroy?.();
    runtime.determinismHarness = null;
  }
  runtime._onToggleNetworkHUD = null;
  if (runtime.authoritativeServer) {
    runtime.authoritativeServer.destroy?.();
    runtime.authoritativeServer = null;
  }
  if (runtime.networkReconciler) {
    runtime.networkReconciler = null;
  }
  if (runtime.multiplayerSession) {
    runtime.multiplayerSession.stopHosting?.();
    runtime.multiplayerSession.leaveSession?.();
    runtime.multiplayerSession = null;
  }
  if (runtime.ballTrajectoryPredictor) {
    runtime.ballTrajectoryPredictor.dispose?.();
    runtime.ballTrajectoryPredictor = null;
  }
  if (runtime.reachabilityVisualizer) {
    runtime.reachabilityVisualizer.dispose?.();
    runtime.reachabilityVisualizer = null;
  }
  if (runtime.gameUI) {
    runtime.gameUI.destroy?.();
    runtime.gameUI = null;
  }
  if (runtime.composer) {
    runtime.composer.dispose?.();
    runtime.composer = null;
  }
  if (runtime.boostBloom) {
    runtime.boostBloom.dispose?.();
    runtime.boostBloom = null;
  }
  if (runtime.speedLinesPass) {
    runtime.speedLinesPass.dispose?.();
    runtime.speedLinesPass = null;
  }
  if (runtime.renderer) {
    if (runtime.renderer.domElement && runtime.renderer.domElement.parentElement) {
      runtime.renderer.domElement.parentElement.removeChild(runtime.renderer.domElement);
    }
    runtime.renderer.dispose?.();
    runtime.renderer = null;
  }
  if (runtime.arena) {
    runtime.arena.dispose?.();
    runtime.arena = null;
  }
  if (runtime.physics) {
    runtime.physics.destroy?.();
    runtime.physics = null;
  }
}
