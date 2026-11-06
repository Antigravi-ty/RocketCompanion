import type * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RuntimeBloomOcclusion } from './runtime/RuntimeBloomOcclusion.ts';
import { RuntimeBotCoordinator, type BotAgentLike } from './runtime/RuntimeBotCoordinator.ts';
import { RuntimeNetworkManager } from './runtime/RuntimeNetworkManager.ts';
import { RuntimeDOMEventManager } from './runtime/RuntimeDOMEventManager.ts';
import { RuntimeInputPoller } from './runtime/RuntimeInputPoller.ts';
import { RuntimeLoadoutCoordinator } from './runtime/RuntimeLoadoutCoordinator.ts';
import {
  createCorePhysicsBundle,
  createCoreSceneGraph,
  disposeCoreSceneGraph,
  type CorePhysicsBundle,
  type MountedGameUIHandle,
} from './runtime/RuntimeSceneBootstrap.ts';
import { createGameRuntimeDomainPorts } from './runtime/runtimeDomainPorts.ts';
import {
  determinismStore,
  networkDiagnosticsStore,
  toggleFloatingPreset,
  NETWORK_MONITOR_PRESET,
  DUAL_ARENA_DETERMINISM_HARNESS_PRESET,
  type GameRuntimeUiBridgePort,
  type GraphicsSettingsPort,
  type RuntimeCameraPort,
  type RuntimeMatchPort,
  type RuntimeReplayPort,
  type RuntimeTunerPort,
} from './runtimeUiPort.ts';
import { syncMaterialsToGame } from '../effects/ThemeMaterialPipeline.ts';
import type { CarControlsInput } from '../network/protocol/GlobalPayloadCodec.ts';
import { RenderClockScheduler } from './RenderClockScheduler.ts';
import { DEFAULT_TRAINING_SETTINGS } from '../ui-core/config/trainingDefaults';
import { FlipResetVisual } from '../effects/FlipResetVisual.ts';
import { PerformanceProfiler } from '../utils/PerformanceProfiler.ts';

import {
  FramePipeline,
  InputStage,
  GameplayModeStage,
  AudioStage,
  RenderStage,
} from './pipeline/FramePipeline.ts';
import { SimulationStage } from './pipeline/stages/SimulationStage.ts';
import { PresentationStage } from './pipeline/stages/PresentationStage.ts';
import { TelemetryStage } from './pipeline/stages/TelemetryStage.ts';

import { GameAudioSubsystem } from './subsystems/GameAudioSubsystem.ts';
import { GameCameraSubsystem } from './subsystems/GameCameraSubsystem.ts';
import { GameRenderSubsystem } from './subsystems/GameRenderSubsystem.ts';
import { GameModeManager } from './modes/GameModeManager.ts';
import type { RocketSimPhysicsEngine } from '../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../physics/PhysicsStateInterpolator.ts';
import type { RuntimeMatchState } from './runtime/RuntimeMatchState.ts';
import type { ArenaWorld } from '../entities/ArenaWorld.ts';
import type { EntityManager } from '../entities/EntityManager.ts';
import type { CameraManager } from '../camera/CameraManager.ts';
import type { BoostBloom } from '../effects/BoostBloom.ts';
import type { SupersonicSpeedLinesPass } from '../effects/SupersonicSpeedLinesPass.ts';
import type { BallTrajectoryPredictor } from '../entities/BallTrajectoryPredictor.ts';
import type { ReachabilityVisualizer } from '../entities/ReachabilityVisualizer.ts';
import type { KeyboardMouseController } from '../input/KeyboardMouseController.ts';
import type { GamepadController } from '../input/GamepadController.ts';
import type { MultiplayerSessionManager } from '../network/transport/MultiplayerSessionManager.ts';
import type { PodiumCelebrationController } from './modes/PodiumCelebrationController.ts';
import type { FreeplayRewinderController } from '../replay/FreeplayRewinderController.ts';
import type { StandaloneReplayViewerController } from '../replay/StandaloneReplayViewerController.ts';
import type { ReplayTimelineController } from '../replay/ReplayTimelineController.ts';
import type { AuthoritativeServerHost } from '../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../network/client/PredictionReconciler.ts';
import type { DeterminismHarness } from '../physics/DeterminismHarness.ts';
import type {
  MaterialsConfigLike,
  NetworkSessionChannelLike,
} from './runtime/onlineLobbyTransitionPipeline.ts';
import type { SignalAudioFacadeLike } from './runtime/RuntimeGoalReplaySignalSubController.ts';

export const PLAYER_CAR_INDEX = 0;
export const BOT_CAR_INDEX = 1;

export interface GameRuntimeOptions {
  CameraControllerClass?: new (aspect: number) => CameraManager;
  gameUI?: MountedGameUIHandle | null;
  mountUI?: (container: HTMLElement, runtime: GameRuntimeUiBridgePort) => MountedGameUIHandle;
  gameAudio?: SignalAudioFacadeLike;
  [key: string]: unknown;
}

export interface TrainingOptionsState {
  boostOption?: string;
  disableGoalReset?: boolean;
  showCarHitbox?: boolean;
  showAllCarHitboxes?: boolean;
  [key: string]: unknown;
}

export class GameRuntime implements GameRuntimeUiBridgePort {
  container: HTMLElement | null;
  options: GameRuntimeOptions;

  physics: RocketSimPhysicsEngine | null = null;
  interpolator: PhysicsStateInterpolator | null = null;
  match: RuntimeMatchState | null = null;
  bot: BotAgentLike | null = null;
  arena: ArenaWorld | null = null;
  entityManager: EntityManager | null = null;
  camera: CameraManager | null = null;
  renderer: THREE.WebGLRenderer | null = null;
  composer: EffectComposer | null = null;
  boostBloom: BoostBloom | null = null;
  bloomEnabled = false;
  speedLinesPass: SupersonicSpeedLinesPass | null = null;
  applyVisualMaterialsConfig: unknown = null;
  flipResetVisuals = new Map<number, FlipResetVisual>();
  clockScheduler: RenderClockScheduler | null = null;

  keyboard: KeyboardMouseController | null = null;
  gamepad: GamepadController | null = null;
  gameUI: MountedGameUIHandle | null = null;
  profiler = new PerformanceProfiler();
  ballTrajectoryPredictor: BallTrajectoryPredictor | null = null;
  reachabilityVisualizer: ReachabilityVisualizer | null = null;
  multiplayerSession: MultiplayerSessionManager | null = null;

  playerCarIndex = PLAYER_CAR_INDEX;
  neutralControls: CarControlsInput = {
    throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false,
  };
  playerControls: CarControlsInput;
  playerThrottle = 0;
  lastKickoffCountdownSec = -1;

  openOverlays = new Set<string>();
  isCursorBrowsing = false;
  bloomOcclusion: RuntimeBloomOcclusion;
  botCoordinator: RuntimeBotCoordinator;
  inputPoller: RuntimeInputPoller;
  networkManager: RuntimeNetworkManager;
  domEventManager: RuntimeDOMEventManager;
  loadoutCoordinator: RuntimeLoadoutCoordinator;
  trainingOptions: TrainingOptionsState;

  lastBloomActive = true;
  lastTimestamp = performance.now();
  activeGraphicsSettings: GraphicsSettingsPort | null = null;
  running = false;

  replayPovCarIndex: number | null = null;
  podiumController: PodiumCelebrationController | null = null;
  rewinderController: FreeplayRewinderController | null = null;
  standaloneReplayController: StandaloneReplayViewerController | null = null;
  replayTimelineController: ReplayTimelineController | null = null;
  cursorHintButton: HTMLButtonElement | null = null;
  isPaused = false;
  isWindowMinimized = false;
  isWindowFocused = true;
  isPowerSavingActive = false;
  teamAssignment: { playerTeam: number; opponentTeam: number } | null = null;
  matchDurationSeconds = 300;
  _lastHudSlotCarMap: Record<number, number> | null = null;
  _clientGoalIncidentLatched = false;
  _localSkipReplayReady = false;

  selectedPreset = 'fennec';
  selectedHitbox: string | null = null;
  selectedColorSlot: number | null = null;
  _lastTouchStateActive?: boolean;

  audioSubsystem: GameAudioSubsystem;
  cameraSubsystem: GameCameraSubsystem;
  renderSubsystem: GameRenderSubsystem;
  modeManager: GameModeManager;
  simulationStage: SimulationStage;
  pipeline: FramePipeline;

  readonly cameraPort: RuntimeCameraPort;
  readonly matchPort: RuntimeMatchPort;
  readonly tunerPort: RuntimeTunerPort;
  readonly replayPort: RuntimeReplayPort;

  constructor(container?: HTMLElement | null, options: GameRuntimeOptions = {}) {
    this.container =
      container || (typeof document !== 'undefined' ? (document.querySelector('#app') as HTMLElement | null) : null);
    this.options = options;
    this.playerControls = { ...this.neutralControls };
    this.trainingOptions = { ...DEFAULT_TRAINING_SETTINGS };

    this.bloomOcclusion = new RuntimeBloomOcclusion(this);
    this.botCoordinator = new RuntimeBotCoordinator(this);
    this.inputPoller = new RuntimeInputPoller(this);
    this.networkManager = new RuntimeNetworkManager(this);
    this.domEventManager = new RuntimeDOMEventManager(this);
    this.loadoutCoordinator = new RuntimeLoadoutCoordinator(this);

    this.audioSubsystem = new GameAudioSubsystem(this);
    this.cameraSubsystem = new GameCameraSubsystem(this);
    this.renderSubsystem = new GameRenderSubsystem(this);
    this.modeManager = new GameModeManager(this);
    this.simulationStage = new SimulationStage(this);

    this.pipeline = new FramePipeline(this)
      .addStage(new InputStage(this))
      .addStage(this.simulationStage)
      .addStage(new GameplayModeStage(this))
      .addStage(new PresentationStage(this))
      .addStage(new AudioStage(this))
      .addStage(new RenderStage(this))
      .addStage(new TelemetryStage(this));

    const ports = createGameRuntimeDomainPorts(this);
    this.cameraPort = ports.cameraPort;
    this.matchPort = ports.matchPort;
    this.tunerPort = ports.tunerPort;
    this.replayPort = ports.replayPort;
  }

  get authoritativeServer(): AuthoritativeServerHost | null {
    return this.networkManager.sessionCoordinator.authoritativeServer;
  }
  get networkChannel(): NetworkSessionChannelLike | null {
    return this.networkManager.sessionCoordinator.networkChannel;
  }
  get networkReconciler(): PredictionReconciler | null {
    return this.networkManager.sessionCoordinator.networkReconciler;
  }
  get botControls(): CarControlsInput {
    return this.botCoordinator?.botControls ?? this.neutralControls;
  }
  set botControls(v: CarControlsInput) {
    this.botCoordinator.botControls = v;
  }
  get isBotPaused(): boolean {
    return this.botCoordinator.isBotPaused;
  }
  get isBotMatch(): boolean {
    return this.botCoordinator.isBotMatch;
  }
  set isBotMatch(v: boolean) {
    this.botCoordinator.isBotMatch = v;
  }
  get engineSynths() {
    return this.audioSubsystem?.engineSynths ?? [];
  }

  isGoalReplayCameraOverrideActive(): boolean {
    return this.cameraSubsystem.isGoalReplayCameraOverrideActive();
  }

  acquireGoalReplayCameraOverride(source = 'default'): void {
    this.cameraSubsystem.acquireGoalReplayCameraOverride(source);
  }

  releaseGoalReplayCameraOverride(source: string | null = null): void {
    this.cameraSubsystem.releaseGoalReplayCameraOverride(source);
  }

  async setupPhysics(options: Record<string, unknown> = {}): Promise<CorePhysicsBundle> {
    const bundle = await createCorePhysicsBundle({
      options,
      onPhysicsRateChange: (nextRate) => {
        this.networkManager.diagnosticsProbe.physicsRate = nextRate;
      },
    });
    this.selectedPreset = bundle.selectedPreset;
    this.teamAssignment = bundle.teamAssignment;
    this.physics = bundle.physics;
    this.playerCarIndex = bundle.playerCarIndex;
    this.interpolator = bundle.interpolator;
    this.match = bundle.match;
    this.bot = null;
    this.audioSubsystem.engineSynths = [];
    this.resetAudio();
    return bundle;
  }

  getFlipResetVisual(carIndex: number): FlipResetVisual | null {
    if (this.flipResetVisuals.has(carIndex)) {
      return this.flipResetVisuals.get(carIndex) || null;
    }
    const carRoot = this.arena?.cars?.[carIndex];
    if (carRoot) {
      const visual = new FlipResetVisual(carRoot);
      this.flipResetVisuals.set(carIndex, visual);
      return visual;
    }
    return null;
  }

  get flipResetVisual(): FlipResetVisual | null {
    return this.getFlipResetVisual(this.playerCarIndex);
  }

  async setupScene(onProgress: ((progress: number, message?: string) => void) | null = null): Promise<void> {
    if (!this.physics || !this.interpolator) {
      throw new Error('[GameRuntime] setupPhysics must complete before setupScene.');
    }
    const bundle = await createCoreSceneGraph({
      container: this.container,
      physics: this.physics,
      interpolator: this.interpolator,
      selectedPreset: this.selectedPreset,
      teamAssignment: this.teamAssignment,
      playerCarIndex: this.playerCarIndex,
      options: this.options,
      onProgress,
      callbacks: {
        onResetKickoff: () => this.resetKickoff(),
        onBallControl: (actionId) => {
          const activeMode = this.modeManager?.getActiveMode?.() as {
            nameTagTunerController?: { isActive?: boolean };
          } | null;
          const modeName = this.match?.state.mode;
          if (
            (modeName === 'freeplay' || modeName === 'online-warmup') &&
            !activeMode?.nameTagTunerController?.isActive &&
            this.physics?.controlBall(this.playerCarIndex, actionId)
          ) {
            if (this.authoritativeServer) {
              this.authoritativeServer.sim?.controlBall?.(this.playerCarIndex, actionId);
              const snap =
                typeof this.physics.saveCompactState === 'function'
                  ? this.physics.saveCompactState()
                  : this.physics.saveState();
              this.authoritativeServer.sim?.restoreState?.(snap);
              const curTick = Math.floor(this.physics.getHeaderView?.()?.tickCount ?? 0);
              this.networkReconciler?.syncTimeline?.(snap, curTick);
            }
            this.interpolator?.syncBall();
            this.arena?.resetBallTrail?.();
            this.ballTrajectoryPredictor?.notifyBallStateReset?.();
          }
        },
        onKickoffSpawnSelect: (spawnIndex) => {
          if (this.match?.state?.mode === 'kickoff-training') {
            const mode = this.modeManager?.getActiveMode?.() as { selectSpawn?(idx: number): void } | null;
            mode?.selectSpawn?.(spawnIndex);
          }
        },
        onEnsurePlayerFlipResetVisual: (carIndex) => {
          this.getFlipResetVisual(carIndex);
        },
        onSyncInitialMaterials: (arena, applyFn, materials) => {
          this.arena = arena;
          this.applyVisualMaterialsConfig = applyFn;
          syncMaterialsToGame(this, materials);
        },
        onUpdateViewport: (renderer, camera, composer, boostBloom, speedLinesPass, gfx) => {
          this.renderer = renderer;
          this.camera = camera;
          this.composer = composer;
          this.boostBloom = boostBloom;
          this.speedLinesPass = speedLinesPass;
          this.activeGraphicsSettings = gfx as GraphicsSettingsPort;
          this.domEventManager.updateViewport();
        },
        onEnableDeterminismHarness: (autoOpenPanel) =>
          this.networkManager.diagnosticsProbe.enableDeterminismHarness(autoOpenPanel),
        onEnableNetworkPrediction: (enabled) =>
          this.networkManager.sessionCoordinator.enableNetworkPrediction(enabled),
        onHostOnlineServer: (opts) => this.networkManager.sessionCoordinator.hostOnlineServer(opts),
        onStopOnlineServer: () => this.networkManager.sessionCoordinator.stopOnlineServer(),
        onJoinOnlineServer: (opts) => this.networkManager.sessionCoordinator.joinOnlineServer(opts),
        onRemotePlayerConnected: async (channel, name) =>
          (await this.networkManager.rosterSyncCoordinator.onRemotePlayerConnected(channel, name)) ?? -1,
        onRemoveRemotePlayer: (carIndex) => this.networkManager.rosterSyncCoordinator.removeRemotePlayer(carIndex),
        onSetCarColor: (carIndex, hex) => this.setCarColor(carIndex, hex),
        onMountOrAttachGameUI: (container) => {
          if (this.options?.gameUI) {
            this.options.gameUI.attachToRuntime?.(this);
            return this.options.gameUI;
          }
          if (typeof this.options?.mountUI === 'function') {
            return this.options.mountUI(container, this);
          }
          return null;
        },
        onDisposeHeadlessBloomOcclusion: () => {
          this.bloomOcclusion?.dispose?.();
        },
      },
    });

    this.selectedPreset = bundle.selectedPreset;
    this.teamAssignment = bundle.teamAssignment;
    this.keyboard = bundle.keyboard;
    this.gamepad = bundle.gamepad;
    this.arena = bundle.arena;
    this.entityManager = bundle.entityManager;
    this.speedLinesPass = bundle.speedLinesPass;
    this.applyVisualMaterialsConfig = bundle.applyVisualMaterialsConfig;
    this.camera = bundle.camera;
    this.cursorHintButton = bundle.cursorHintButton;
    this.activeGraphicsSettings = bundle.activeGraphicsSettings as GraphicsSettingsPort;
    this.ballTrajectoryPredictor = bundle.ballTrajectoryPredictor;
    this.reachabilityVisualizer = bundle.reachabilityVisualizer;
    this.multiplayerSession = bundle.multiplayerSession;
    this.gameUI = bundle.gameUI;
    this.renderer = bundle.renderer;
    this.boostBloom = bundle.boostBloom;
    this.composer = bundle.composer;

    this.domEventManager.setupWindowEvents();
  }

  async setupAudio(onProgress: ((loaded: number, total?: number, file?: string) => void) | null = null): Promise<void> {
    return this.audioSubsystem.setupAudio(onProgress);
  }

  async setupBot(onProgress: ((completed?: number, total?: number, name?: string) => void) | null = null): Promise<void> {
    return this.botCoordinator.setupBot(onProgress);
  }

  async setupShaders(onProgress: ((progress: number, label?: string) => void) | null = null): Promise<void> {
    return this.bloomOcclusion.setupShaders(onProgress);
  }

  ignite(): void {
    this.boostBloom?.clear?.();
    if (this.renderer?.shadowMap) this.renderer.shadowMap.needsUpdate = true;
    this.composer?.render?.(0);
    this.lastTimestamp = performance.now();
    this.interpolator?.sync(this.lastTimestamp);
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const glContext = this.renderer ? this.renderer.getContext() : null;
    this.clockScheduler = new RenderClockScheduler(
      glContext,
      (timestamp) => this.renderFrame(timestamp),
      (timestamp) => this.profiler && this.profiler.displayFrame(timestamp),
      (timestamp) => this.stepSimulation(timestamp),
    );
    if (this.activeGraphicsSettings) {
      this.clockScheduler.setFpsLimit(
        this.activeGraphicsSettings.limitFps ? (this.activeGraphicsSettings.maxFps ?? null) : null,
      );
    }
    this.domEventManager.updateInteractionState();
    this.clockScheduler.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.clockScheduler) this.clockScheduler.stop();
  }

  renderFrame(timestamp = performance.now()): boolean {
    return this.pipeline.execute(timestamp);
  }

  stepSimulation(timestamp = performance.now()): void {
    this.pipeline.executeSimulationOnly(timestamp);
  }

  triggerGameAudioEvents(goalScored: boolean, curBoost: number, isSupersonic: boolean, curr: Float32Array): void {
    return this.audioSubsystem.triggerGameAudioEvents(goalScored, curBoost, isSupersonic, curr);
  }

  pollInputs(commitPhysicsStep = true): boolean {
    return this.inputPoller.pollInputs(commitPhysicsStep);
  }

  changePlayerVehicle(visualId: string, hitboxId: string | null = null): void {
    this.loadoutCoordinator.changePlayerVehicle(visualId, hitboxId);
  }

  setCarColor(carIndex: number, colorVal: number | string, broadcast = true): void {
    this.loadoutCoordinator.setCarColor(carIndex, colorVal, broadcast);
  }

  syncPlayerMaterialsLoadout(materialsConfig: MaterialsConfigLike | null = null): void {
    this.loadoutCoordinator.syncPlayerMaterialsLoadout(materialsConfig);
  }

  restoreLocalPlayerFreeplayLoadout(carIndex = 0): void {
    this.loadoutCoordinator.restoreLocalPlayerFreeplayLoadout(carIndex);
  }

  onSessionReady(reconciler: PredictionReconciler | null, channel: NetworkSessionChannelLike | null): void {
    networkDiagnosticsStore.setSession(reconciler, channel, this);
  }

  onShowNetworkHUD(): void {
    toggleFloatingPreset(NETWORK_MONITOR_PRESET);
  }

  onDeterminismHarnessReady(harness: DeterminismHarness, showHUD = false): void {
    determinismStore.setHarness(harness);
    if (showHUD) toggleFloatingPreset(DUAL_ARENA_DETERMINISM_HARNESS_PRESET);
  }

  resetKickoff(seed = -1): void {
    this.modeManager.onResetKickoff(seed);
  }

  resetAudio(): void {
    return this.audioSubsystem.resetAudio();
  }

  resetBotState(): void {
    return this.botCoordinator.resetBotState();
  }

  leaveBotMatch(): void {
    return this.botCoordinator.leaveBotMatch();
  }

  destroy(): void {
    this.stop();
    this.domEventManager?.destroy?.();
    this.audioSubsystem?.dispose?.();
    this.cameraSubsystem?.dispose?.();
    this.renderSubsystem?.dispose?.();
    this.bloomOcclusion?.dispose?.();
    this.networkManager.diagnosticsProbe.determinismHarness?.destroy?.();
    this.networkManager.sessionCoordinator.authoritativeServer?.destroy?.();
    this.networkManager.sessionCoordinator.authoritativeServer = null;
    this.networkManager.sessionCoordinator.networkReconciler = null;

    disposeCoreSceneGraph({
      cursorHintButton: this.cursorHintButton,
      keyboard: this.keyboard,
      gamepad: this.gamepad,
      camera: this.camera,
      multiplayerSession: this.multiplayerSession,
      ballTrajectoryPredictor: this.ballTrajectoryPredictor,
      reachabilityVisualizer: this.reachabilityVisualizer,
      gameUI: this.gameUI,
      composer: this.composer,
      boostBloom: this.boostBloom,
      speedLinesPass: this.speedLinesPass,
      renderer: this.renderer,
      arena: this.arena,
      physics: this.physics,
    });

    this.cursorHintButton = null;
    this.keyboard = null;
    this.gamepad = null;
    this.camera = null;
    this.multiplayerSession = null;
    this.ballTrajectoryPredictor = null;
    this.reachabilityVisualizer = null;
    this.gameUI = null;
    this.composer = null;
    this.boostBloom = null;
    this.speedLinesPass = null;
    this.renderer = null;
    this.arena = null;
    this.physics = null;
  }

  dispose(): void {
    this.destroy();
  }
}
