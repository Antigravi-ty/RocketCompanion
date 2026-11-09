import { RuntimeBloomOcclusion } from './RuntimeBloomOcclusion.ts';
import { RuntimeBotCoordinator } from './RuntimeBotCoordinator.ts';
import { RuntimeNetworkManager } from './RuntimeNetworkManager.ts';
import { RuntimeDOMEventManager } from './RuntimeDOMEventManager.ts';
import { RuntimeInputPoller } from './RuntimeInputPoller.ts';
import { RuntimeLoadoutCoordinator } from './RuntimeLoadoutCoordinator.ts';
import {
  FramePipeline,
  InputStage,
  GameplayModeStage,
  AudioStage,
  RenderStage,
} from '../pipeline/FramePipeline.ts';
import { SimulationStage } from '../pipeline/stages/SimulationStage.ts';
import { PresentationStage } from '../pipeline/stages/PresentationStage.ts';
import { TelemetryStage } from '../pipeline/stages/TelemetryStage.ts';
import { GameAudioSubsystem } from '../subsystems/GameAudioSubsystem.ts';
import { GameCameraSubsystem } from '../subsystems/GameCameraSubsystem.ts';
import { GameRenderSubsystem } from '../subsystems/GameRenderSubsystem.ts';
import { GameModeManager } from '../modes/GameModeManager.ts';
import { disposeCoreSceneGraph } from './RuntimeSceneBootstrap.ts';
import {
  determinismStore,
  networkDiagnosticsStore,
  toggleFloatingPreset,
  NETWORK_MONITOR_PRESET,
  DUAL_ARENA_DETERMINISM_HARNESS_PRESET,
} from '../runtimeUiPort.ts';
import type {
  MaterialsConfigLike,
  NetworkSessionChannelLike,
} from './onlineLobbyTransitionPipeline.ts';

export type AudioSetupProgressFn = (loaded: number, total?: number, file?: string) => void;
export type BotSetupProgressFn = (completed?: number, total?: number, name?: string) => void;
export type ShaderSetupProgressFn = (progress: number, label?: string) => void;
export type SessionReadyHandler = (
  reconciler: RuntimeNetworkManager['sessionCoordinator']['networkReconciler'],
  channel: NetworkSessionChannelLike | null
) => void;
export type ShowNetworkHudHandler = () => void;
export type DeterminismHarnessReadyHandler = (
  harness: NonNullable<RuntimeNetworkManager['diagnosticsProbe']['determinismHarness']>,
  showHUD?: boolean
) => void;

export type RuntimeSubsystemHost = ConstructorParameters<typeof RuntimeBloomOcclusion>[0] &
  ConstructorParameters<typeof RuntimeBotCoordinator>[0] &
  ConstructorParameters<typeof RuntimeInputPoller>[0] &
  ConstructorParameters<typeof RuntimeNetworkManager>[0] &
  ConstructorParameters<typeof RuntimeDOMEventManager>[0] &
  ConstructorParameters<typeof RuntimeLoadoutCoordinator>[0] &
  ConstructorParameters<typeof GameAudioSubsystem>[0] &
  ConstructorParameters<typeof GameCameraSubsystem>[0] &
  ConstructorParameters<typeof GameRenderSubsystem>[0] &
  ConstructorParameters<typeof GameModeManager>[0] &
  ConstructorParameters<typeof SimulationStage>[0] &
  ConstructorParameters<typeof FramePipeline>[0] &
  ConstructorParameters<typeof InputStage>[0] &
  ConstructorParameters<typeof GameplayModeStage>[0] &
  ConstructorParameters<typeof PresentationStage>[0] &
  ConstructorParameters<typeof AudioStage>[0] &
  ConstructorParameters<typeof RenderStage>[0] &
  ConstructorParameters<typeof TelemetryStage>[0] &
  Parameters<typeof disposeCoreSceneGraph>[0];

export interface AssembledRuntimeSubsystems {
  bloomOcclusion: RuntimeBloomOcclusion;
  botCoordinator: RuntimeBotCoordinator;
  inputPoller: RuntimeInputPoller;
  networkManager: RuntimeNetworkManager;
  domEventManager: RuntimeDOMEventManager;
  loadoutCoordinator: RuntimeLoadoutCoordinator;
  audioSubsystem: GameAudioSubsystem;
  cameraSubsystem: GameCameraSubsystem;
  renderSubsystem: GameRenderSubsystem;
  modeManager: GameModeManager;
  simulationStage: SimulationStage;
  pipeline: FramePipeline;
  isGoalReplayCameraOverrideActive: () => boolean;
  acquireGoalReplayCameraOverride: (source?: string) => void;
  releaseGoalReplayCameraOverride: (source?: string | null) => void;
  setupAudio: (progressFn?: AudioSetupProgressFn | null) => Promise<void>;
  setupBot: (progressFn?: BotSetupProgressFn | null) => Promise<void>;
  setupShaders: (progressFn?: ShaderSetupProgressFn | null) => Promise<void>;
  pollInputs: (commitPhysicsStep?: boolean) => boolean;
  changePlayerVehicle: (visualId: string, hitboxId?: string | null) => void;
  setCarColor: (carIndex: number, colorVal: number | string, broadcast?: boolean) => void;
  syncPlayerMaterialsLoadout: (materialsConfig?: MaterialsConfigLike | null) => void;
  restoreLocalPlayerFreeplayLoadout: (carIndex?: number) => void;
  resetAudio: () => void;
  resetBotState: () => void;
  leaveBotMatch: () => void;
  onSessionReady: SessionReadyHandler;
  onShowNetworkHUD: ShowNetworkHudHandler;
  onDeterminismHarnessReady: DeterminismHarnessReadyHandler;
}

export function assembleRuntimeSubsystemsAndPipeline(
  target: RuntimeSubsystemHost
): AssembledRuntimeSubsystems {
  const bloomOcclusion = new RuntimeBloomOcclusion(target);
  const botCoordinator = new RuntimeBotCoordinator(target);
  const inputPoller = new RuntimeInputPoller(target);
  const networkManager = new RuntimeNetworkManager(target);
  const domEventManager = new RuntimeDOMEventManager(target);
  const loadoutCoordinator = new RuntimeLoadoutCoordinator(target);

  const audioSubsystem = new GameAudioSubsystem(target);
  const cameraSubsystem = new GameCameraSubsystem(target);
  const renderSubsystem = new GameRenderSubsystem(target);
  const modeManager = new GameModeManager(target);
  const simulationStage = new SimulationStage(target);

  const pipeline = new FramePipeline(target)
    .addStage(new InputStage(target))
    .addStage(simulationStage)
    .addStage(new GameplayModeStage(target))
    .addStage(new PresentationStage(target))
    .addStage(new AudioStage(target))
    .addStage(new RenderStage(target))
    .addStage(new TelemetryStage(target));

  return {
    bloomOcclusion,
    botCoordinator,
    inputPoller,
    networkManager,
    domEventManager,
    loadoutCoordinator,
    audioSubsystem,
    cameraSubsystem,
    renderSubsystem,
    modeManager,
    simulationStage,
    pipeline,
    isGoalReplayCameraOverrideActive: () => cameraSubsystem.isGoalReplayCameraOverrideActive(),
    acquireGoalReplayCameraOverride: (source = 'default') => {
      cameraSubsystem.acquireGoalReplayCameraOverride(source);
    },
    releaseGoalReplayCameraOverride: (source: string | null = null) => {
      cameraSubsystem.releaseGoalReplayCameraOverride(source);
    },
    setupAudio: (progressFn = null) => audioSubsystem.setupAudio(progressFn),
    setupBot: (progressFn = null) => botCoordinator.setupBot(progressFn),
    setupShaders: (progressFn = null) => bloomOcclusion.setupShaders(progressFn),
    pollInputs: (commitPhysicsStep = true) => inputPoller.pollInputs(commitPhysicsStep),
    changePlayerVehicle: (visualId: string, hitboxId: string | null = null) => {
      loadoutCoordinator.changePlayerVehicle(visualId, hitboxId);
    },
    setCarColor: (carIndex: number, colorVal: number | string, broadcast = true) => {
      loadoutCoordinator.setCarColor(carIndex, colorVal, broadcast);
    },
    syncPlayerMaterialsLoadout: (materialsConfig: MaterialsConfigLike | null = null) => {
      loadoutCoordinator.syncPlayerMaterialsLoadout(materialsConfig);
    },
    restoreLocalPlayerFreeplayLoadout: (carIndex = 0) => {
      loadoutCoordinator.restoreLocalPlayerFreeplayLoadout(carIndex);
    },
    resetAudio: () => {
      audioSubsystem.resetAudio();
    },
    resetBotState: () => {
      botCoordinator.resetBotState();
    },
    leaveBotMatch: () => {
      botCoordinator.leaveBotMatch();
    },
    onSessionReady(reconciler, channel) {
      networkDiagnosticsStore.setSession(reconciler, channel, target);
    },
    onShowNetworkHUD() {
      toggleFloatingPreset(NETWORK_MONITOR_PRESET);
    },
    onDeterminismHarnessReady(harness, showHUD = false) {
      determinismStore.setHarness(harness);
      if (showHUD) toggleFloatingPreset(DUAL_ARENA_DETERMINISM_HARNESS_PRESET);
    },
  };
}

export function destroyRuntimeSubsystems(
  target: RuntimeSubsystemHost & AssembledRuntimeSubsystems
): void {
  target.domEventManager?.destroy?.();
  target.audioSubsystem?.dispose?.();
  target.cameraSubsystem?.dispose?.();
  target.renderSubsystem?.dispose?.();
  target.bloomOcclusion?.dispose?.();
  target.networkManager.diagnosticsProbe.determinismHarness?.destroy?.();
  target.networkManager.sessionCoordinator.authoritativeServer?.destroy?.();
  target.networkManager.sessionCoordinator.authoritativeServer = null;
  target.networkManager.sessionCoordinator.networkReconciler = null;
  disposeCoreSceneGraph(target);
}
