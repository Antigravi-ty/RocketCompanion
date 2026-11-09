import type * as THREE from 'three';
import type { RuntimeBloomOcclusion } from './runtime/RuntimeBloomOcclusion.ts';
import type { RuntimeBotCoordinator, BotAgentLike } from './runtime/RuntimeBotCoordinator.ts';
import type { RuntimeNetworkManager } from './runtime/RuntimeNetworkManager.ts';
import type { RuntimeDOMEventManager } from './runtime/RuntimeDOMEventManager.ts';
import type { RuntimeInputPoller } from './runtime/RuntimeInputPoller.ts';
import type { RuntimeLoadoutCoordinator } from './runtime/RuntimeLoadoutCoordinator.ts';
import {
  createCorePhysicsBundle,
  createCoreSceneGraph,
  type CorePhysicsBundle,
  type MountedGameUIHandle,
  type SceneGraphBundle,
} from './runtime/RuntimeSceneBootstrap.ts';
import { buildRuntimeSceneGraphConfig } from './runtime/RuntimeSceneGraphConfigBuilder.ts';
import { createGameRuntimeDomainPorts } from './runtime/DiagnosticReplayBufferBridge.ts';
import {
  assembleRuntimeSubsystemsAndPipeline,
  destroyRuntimeSubsystems,
  type AudioSetupProgressFn,
  type BotSetupProgressFn,
  type DeterminismHarnessReadyHandler,
  type SessionReadyHandler,
  type ShaderSetupProgressFn,
  type ShowNetworkHudHandler,
} from './runtime/RuntimeSubsystemAssembler.ts';
import type {
  GameRuntimeUiBridgePort,
  GraphicsSettingsPort,
  RuntimeCameraPort,
  RuntimeMatchPort,
  RuntimeReplayPort,
  RuntimeTunerPort,
} from './runtimeUiPort.ts';
import type { CarControlsInput } from '../network/protocol/GlobalPayloadCodec.ts';
import { RenderClockScheduler } from './RenderClockScheduler.ts';
import { DEFAULT_TRAINING_SETTINGS } from '../ui-core/config/trainingDefaults.ts';
import { FlipResetVisual } from '../effects/FlipResetVisual.ts';
import { PerformanceProfiler } from '../utils/PerformanceProfiler.ts';
import type { FramePipeline } from './pipeline/FramePipeline.ts';
import type { SimulationStage } from './pipeline/stages/SimulationStage.ts';
import type { GameAudioSubsystem } from './subsystems/GameAudioSubsystem.ts';
import type { GameCameraSubsystem } from './subsystems/GameCameraSubsystem.ts';
import type { GameRenderSubsystem } from './subsystems/GameRenderSubsystem.ts';
import type { GameModeManager } from './modes/GameModeManager.ts';
import type { PodiumCelebrationController } from './modes/PodiumCelebrationController.ts';
import type { FreeplayRewinderController } from '../replay/FreeplayRewinderController.ts';
import type { StandaloneReplayViewerController } from '../replay/StandaloneReplayViewerController.ts';
import type { ReplayTimelineController } from '../replay/ReplayTimelineController.ts';
import type { MaterialsConfigLike } from './runtime/onlineLobbyTransitionPipeline.ts';
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
    throttle: 0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jump: false,
    boost: false,
    handbrake: false,
  };
  playerControls: CarControlsInput;
  playerThrottle = 0;
  lastKickoffCountdownSec = -1;

  openOverlays = new Set<string>();
  isCursorBrowsing = false;
  bloomOcclusion!: RuntimeBloomOcclusion;
  botCoordinator!: RuntimeBotCoordinator;
  inputPoller!: RuntimeInputPoller;
  networkManager!: RuntimeNetworkManager;
  domEventManager!: RuntimeDOMEventManager;
  loadoutCoordinator!: RuntimeLoadoutCoordinator;
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

  audioSubsystem!: GameAudioSubsystem;
  cameraSubsystem!: GameCameraSubsystem;
  renderSubsystem!: GameRenderSubsystem;
  modeManager!: GameModeManager;
  simulationStage!: SimulationStage;
  pipeline!: FramePipeline;

  readonly cameraPort: RuntimeCameraPort;
  readonly matchPort: RuntimeMatchPort;
  readonly tunerPort: RuntimeTunerPort;
  readonly replayPort: RuntimeReplayPort;

  readonly isGoalReplayCameraOverrideActive!: () => boolean;
  readonly acquireGoalReplayCameraOverride!: (source?: string) => void;
  readonly releaseGoalReplayCameraOverride!: (source?: string | null) => void;
  readonly setupAudio!: (progressFn?: AudioSetupProgressFn | null) => Promise<void>;
  readonly setupBot!: (progressFn?: BotSetupProgressFn | null) => Promise<void>;
  readonly setupShaders!: (progressFn?: ShaderSetupProgressFn | null) => Promise<void>;
  readonly pollInputs!: (commitPhysicsStep?: boolean) => boolean;
  readonly changePlayerVehicle!: (visualId: string, hitboxId?: string | null) => void;
  readonly setCarColor!: (carIndex: number, colorVal: number | string, broadcast?: boolean) => void;
  readonly syncPlayerMaterialsLoadout!: (materialsConfig?: MaterialsConfigLike | null) => void;
  readonly restoreLocalPlayerFreeplayLoadout!: (carIndex?: number) => void;
  readonly resetAudio!: () => void;
  readonly resetBotState!: () => void;
  readonly leaveBotMatch!: () => void;
  readonly onSessionReady!: SessionReadyHandler;
  readonly onShowNetworkHUD!: ShowNetworkHudHandler;
  readonly onDeterminismHarnessReady!: DeterminismHarnessReadyHandler;

  constructor(container?: HTMLElement | null, options: GameRuntimeOptions = {}) {
    this.container =
      container ||
      (typeof document !== 'undefined'
        ? (document.querySelector('#app') as HTMLElement | null)
        : null);
    this.options = options;
    this.playerControls = { ...this.neutralControls };
    this.trainingOptions = { ...DEFAULT_TRAINING_SETTINGS };

    Object.assign(this, assembleRuntimeSubsystemsAndPipeline(this));

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

  async setupPhysics(options: Record<string, unknown> = {}): Promise<CorePhysicsBundle> {
    const bundle = await createCorePhysicsBundle({
      options,
      onPhysicsRateChange: (nextRate) => {
        this.networkManager.diagnosticsProbe.physicsRate = nextRate;
      },
    });
    Object.assign(this, bundle, { bot: null });
    this.audioSubsystem.engineSynths = [];
    this.audioSubsystem.resetAudio();
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

  async setupScene(
    onProgress: ((progress: number, message?: string) => void) | null = null
  ): Promise<void> {
    Object.assign(this, await createCoreSceneGraph(buildRuntimeSceneGraphConfig(this, onProgress)));
    this.domEventManager.setupWindowEvents();
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
      (t) => this.pipeline.executeSimulationOnly(t)
    );
    if (this.activeGraphicsSettings) {
      this.clockScheduler.setFpsLimit(
        this.activeGraphicsSettings.limitFps ? (this.activeGraphicsSettings.maxFps ?? null) : null
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

  resetKickoff(seed = -1): void {
    this.inputPoller?.latchJumpSuppression?.();
    this.playerControls = { ...this.neutralControls };
    this.playerThrottle = 0;
    this.modeManager.onResetKickoff(seed);
  }

  destroy(): void {
    this.stop();
    destroyRuntimeSubsystems(this);
  }

  dispose(): void {
    this.destroy();
  }
}
