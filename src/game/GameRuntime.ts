import type * as THREE from 'three';
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
  type SceneGraphBundle,
} from './runtime/RuntimeSceneBootstrap.ts';
import { buildRuntimeSceneGraphConfig } from './runtime/RuntimePostprocessingAndSessionBootstrap.ts';
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
import type { PodiumCelebrationController } from './modes/PodiumCelebrationController.ts';
import type { FreeplayRewinderController } from '../replay/FreeplayRewinderController.ts';
import type { StandaloneReplayViewerController } from '../replay/StandaloneReplayViewerController.ts';
import type { ReplayTimelineController } from '../replay/ReplayTimelineController.ts';
import type {
  MaterialsConfigLike,
  NetworkSessionChannelLike,
} from './runtime/onlineLobbyTransitionPipeline.ts';
import type { SignalAudioFacadeLike } from './runtime/RuntimeGoalReplaySignalSubController.ts';

export const PLAYER_CAR_INDEX = 0;
export const BOT_CAR_INDEX = 1;

export interface GameRuntimeOptions {
  CameraControllerClass?: new (aspect: number) => SceneGraphBundle['camera'];
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

  physics: CorePhysicsBundle['physics'] | null = null;
  interpolator: CorePhysicsBundle['interpolator'] | null = null;
  match: CorePhysicsBundle['match'] | null = null;
  bot: BotAgentLike | null = null;
  arena: SceneGraphBundle['arena'] = null;
  entityManager: SceneGraphBundle['entityManager'] = null;
  camera: SceneGraphBundle['camera'] | null = null;
  renderer: THREE.WebGLRenderer | null = null;
  composer: SceneGraphBundle['composer'] = null;
  boostBloom: SceneGraphBundle['boostBloom'] = null;
  bloomEnabled = false;
  speedLinesPass: SceneGraphBundle['speedLinesPass'] = null;
  applyVisualMaterialsConfig: unknown = null;
  flipResetVisuals = new Map<number, FlipResetVisual>();
  clockScheduler: RenderClockScheduler | null = null;

  keyboard: SceneGraphBundle['keyboard'] | null = null;
  gamepad: SceneGraphBundle['gamepad'] | null = null;
  gameUI: MountedGameUIHandle | null = null;
  profiler = new PerformanceProfiler();
  ballTrajectoryPredictor: SceneGraphBundle['ballTrajectoryPredictor'] = null;
  reachabilityVisualizer: SceneGraphBundle['reachabilityVisualizer'] = null;
  multiplayerSession: SceneGraphBundle['multiplayerSession'] | null = null;

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
      container ||
      (typeof document !== 'undefined' ? (document.querySelector('#app') as HTMLElement | null) : null);
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

  get authoritativeServer() {
    return this.networkManager.sessionCoordinator.authoritativeServer;
  }
  get networkChannel() {
    return this.networkManager.sessionCoordinator.networkChannel;
  }
  get networkReconciler() {
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
    Object.assign(this, bundle, { bot: null });
    this.audioSubsystem.engineSynths = [];
    this.resetAudio();
    return bundle;
  }

  getFlipResetVisual(carIndex: number): FlipResetVisual | null {
    let visual = this.flipResetVisuals.get(carIndex) ?? null;
    const carRoot = this.arena?.cars?.[carIndex];
    if (!visual && carRoot) {
      visual = new FlipResetVisual(carRoot);
      this.flipResetVisuals.set(carIndex, visual);
    }
    return visual;
  }

  get flipResetVisual(): FlipResetVisual | null {
    return this.getFlipResetVisual(this.playerCarIndex);
  }

  bindInitialArenaAndMaterials(
    arena: NonNullable<SceneGraphBundle['arena']>,
    applyFn: SceneGraphBundle['applyVisualMaterialsConfig'],
  ): void {
    this.arena = arena;
    this.applyVisualMaterialsConfig = applyFn;
  }

  bindViewportRenderTargets(
    renderer: THREE.WebGLRenderer,
    camera: SceneGraphBundle['camera'],
    composer: NonNullable<SceneGraphBundle['composer']>,
    boostBloom: NonNullable<SceneGraphBundle['boostBloom']>,
    speedLinesPass: SceneGraphBundle['speedLinesPass'],
    gfx: Record<string, unknown>,
  ): void {
    Object.assign(this, {
      renderer, camera, composer, boostBloom, speedLinesPass,
      activeGraphicsSettings: gfx as GraphicsSettingsPort,
    });
  }

  async setupScene(onProgress: ((progress: number, message?: string) => void) | null = null): Promise<void> {
    Object.assign(this, await createCoreSceneGraph(buildRuntimeSceneGraphConfig(this, onProgress)));
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
    this.clockScheduler = new RenderClockScheduler(
      this.renderer?.getContext() ?? null,
      (t) => this.renderFrame(t),
      (t) => this.profiler?.displayFrame(t),
      (t) => this.stepSimulation(t),
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
    this.clockScheduler?.stop();
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

  onSessionReady(
    reconciler: RuntimeNetworkManager['sessionCoordinator']['networkReconciler'],
    channel: NetworkSessionChannelLike | null,
  ): void {
    networkDiagnosticsStore.setSession(reconciler, channel, this);
  }
  onShowNetworkHUD(): void {
    toggleFloatingPreset(NETWORK_MONITOR_PRESET);
  }
  onDeterminismHarnessReady(
    harness: NonNullable<RuntimeNetworkManager['diagnosticsProbe']['determinismHarness']>,
    showHUD = false,
  ): void {
    determinismStore.setHarness(harness);
    if (showHUD) toggleFloatingPreset(DUAL_ARENA_DETERMINISM_HARNESS_PRESET);
  }

  resetKickoff(seed = -1): void {
    this.inputPoller?.latchJumpSuppression?.();
    this.playerControls = { ...this.neutralControls };
    this.playerThrottle = 0;
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

    disposeCoreSceneGraph(this);
  }

  dispose(): void {
    this.destroy();
  }
}
