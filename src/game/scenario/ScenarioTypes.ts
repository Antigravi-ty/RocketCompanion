/**
 * ScenarioTypes.ts
 * Declarative scenario script format, tick-scheduled action/assertion descriptors,
 * per-stage wall-clock timing distributions, keyframe GPU/shader telemetry,
 * SceneGraph vehicle rig geometry calibration probes, runtime error interception,
 * speed presets, and Golden 65f1538d diff report schemas.
 */

import type { CarControlsInput } from '../../network/protocol/InputPacketCodec.ts';

export type PipelineStageName =
  | 'InputStage'
  | 'SimulationStage'
  | 'GameplayModeStage'
  | 'PresentationStage'
  | 'AudioStage'
  | 'RenderStage'
  | 'TelemetryStage';

export type ScenarioSpeedPreset = '1x' | '10x' | '20x' | '50x' | 'max';

export interface ScenarioDriverRunOptions {
  speed?: ScenarioSpeedPreset | string | number;
  renderStrideOverride?: number;
  batchYieldTicksOverride?: number;
  failOnConsoleError?: boolean;
  includeGoldenDiff?: boolean;
}

export interface CapturedRuntimeErrorEntry {
  tick: number;
  virtualTimeMs: number;
  source: 'window.onerror' | 'unhandledrejection' | 'console.error';
  message: string;
  stack?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface RuntimeErrorInterceptionSummary {
  windowErrorCount: number;
  unhandledRejectionCount: number;
  consoleErrorCount: number;
  totalErrorCount: number;
  entries: CapturedRuntimeErrorEntry[];
}

export interface VehicleWheelGeometrySample {
  wheelIndex: number;
  steerPosition: [number, number, number];
  steerRotationY: number;
  spinRotationZ: number;
  specAnchor: [number, number, number];
}

export interface VehicleRigGeometryProbeSnapshot {
  carIndex: number;
  visualId: string;
  hitboxPresetId: string;
  carVisible: boolean;
  carPosition: [number, number, number];
  frontAxleX: number;
  rearAxleX: number;
  wheelbaseX: number;
  frontTrackWidthZ: number;
  rearTrackWidthZ: number;
  wheelHeightsY: [number, number, number, number];
  wheels: VehicleWheelGeometrySample[];
  wheelSpecs: Array<[number, number, number]>;
  boostOutlets: Array<[number, number, number]>;
  hitboxDimensions: [number, number, number] | null;
  hitboxOffset: [number, number, number] | null;
}

export interface GoldenFieldDiffItem {
  field: string;
  expected: unknown;
  actual: unknown;
  maxAbsDelta: number;
  passed: boolean;
}

export interface VehicleRigGoldenDiffReport {
  carIndex: number;
  visualId: string;
  goldenReferenceId: string;
  passed: boolean;
  maxCoordinateDeltaUu: number;
  mismatches: GoldenFieldDiffItem[];
  probe: VehicleRigGeometryProbeSnapshot;
}

export interface GoldenBaselineDiffSummary {
  referenceCommit: string;
  referenceUiCoreCommit: string;
  passed: boolean;
  staticDescriptorChecksPassed: boolean;
  staticDescriptorDiffs: GoldenFieldDiffItem[];
  vehicleRigDiffs: VehicleRigGoldenDiffReport[];
}

export interface BootstrapTaskTelemetry {
  stageIndex: number;
  stageTitle: string;
  step: number;
  totalSteps: number;
  taskId: string;
  taskName: string;
  durationMs: number;
  status: 'completed' | 'skipped' | 'error';
}

export interface BootstrapStageSummary {
  stageIndex: number;
  stageTitle: string;
  totalDurationMs: number;
  taskCount: number;
  tasks: BootstrapTaskTelemetry[];
}

export interface BootstrapTelemetrySnapshot {
  totalDurationMs: number;
  totalSteps: number;
  backgroundAssetsDurationMs: number;
  initialCompiledShaderPrograms: number;
  stages: BootstrapStageSummary[];
}

export interface StageTimingDistribution {
  stage: PipelineStageName | 'TotalFrame';
  sampleCount: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  maxTick: number;
  totalWallMs: number;
}

export interface KeyframeRenderSample {
  tick: number;
  virtualTimeMs: number;
  reason: string;
  phase: string;
  gameMode: string;
  cameraMode: string;
  renderStageWallMs: number;
  totalFrameWallMs: number;
  shaderProgramsBefore: number;
  shaderProgramsAfter: number;
  shaderProgramsDelta: number;
  glError: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

export interface HitchFrameAttribution {
  tick: number;
  virtualTimeMs: number;
  totalFrameWallMs: number;
  dominantStage: PipelineStageName;
  dominantStageWallMs: number;
  phase: string;
  cameraMode: string;
  didGpuRender: boolean;
  shaderProgramsDelta: number;
  stageBreakdownMs: Record<PipelineStageName, number>;
}

export interface CameraSmoothnessTelemetry {
  sampleCount: number;
  nanFrameCount: number;
  maxPositionStepDistance: number;
  p95PositionStepDistance: number;
  maxAngularStepDeg: number;
  p95AngularStepDeg: number;
  directorReplaySamples: number;
  directorReplayFirstFrameRenderMs: number | null;
  directorReplayFirstFrameShaderDelta: number | null;
}

export interface VirtualPeerLoadoutSpec {
  peerId: string;
  playerName: string;
  carIndex: number;
  team: 0 | 1;
  visualId: string;
  hitboxId: string;
  colorSlot: number;
  paintFinish: 'matte' | 'metallic';
  boostVisual: 'gold-rush' | 'cartoon';
  boostAudio: 'rush' | 'standard' | 'flamethrower' | 'plasma';
}

export interface MultiplayerLoopbackTelemetry {
  configuredCarCount: number;
  activePhysicalCars: number;
  visibleArenaCars: number;
  virtualPeersConnected: number;
  totalClientInputPacketsSent: number;
  totalClientInputBytesSent: number;
  totalServerFramePacketsReceived: number;
  totalServerFrameBytesReceived: number;
  totalSignalsDecoded: number;
  distinctSignalNames: string[];
  reconcilerCorrections: number;
  reconcilerSkippedCorrections: number;
  reconcilerHardSnaps: number;
  reconcilerMaxCorrectionDelta: number;
  loadoutsVerified: VirtualPeerLoadoutSpec[];
}

export interface ScenarioAssertionResult {
  tick: number;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ScenarioActiveModePort {
  isReplayActive?: boolean;
  replayCameraMode?: string;
  goalResetTicks?: number;
  isGoalReplayActive?(): boolean;
  setReplayCameraMode?(mode: string): void;
  skipGoalReplay?(): void;
  resetToCleanFreeplay?(): void;
  directorPreview?: {
    isReplayActive?: boolean;
    replayCameraMode?: string;
    setReplayCameraMode?(mode: string): void;
  } | null;
  standaloneReplayViewer?: {
    isActive?: boolean;
    hasLoadedReplay?: boolean;
    loadReplayFromBytes?(bytes: Uint8Array, fileName?: string): Promise<boolean> | boolean;
    handleLoadRetainedMatchReplay(): void;
    startPlayback?(): void;
    startPlaying(): void;
    beginInterventionPreRoll?(): void;
    selectPovCarSlot?(slotKey: number): void;
    selectPovSlot?(slotKey: number): void;
    rosterSubController?: {
      resolvedRoster: Array<{ slotKey: number; carIndex: number }>;
      activePovCarIndex: number;
    };
    takeoverSubController?: {
      cursor?: number;
      getViewerState?(): string;
    };
  } | null;
  replayRingBuffer?: {
    capacityTicks?: number;
    mode?: string;
    appendSignal?(
      tick: number,
      sig: { signalType: number; frameId: number; param1: number; param2: number },
    ): void;
    getFrames?(): ReadonlyArray<{
      signals?: ReadonlyArray<{ signalType?: number; type?: number }>;
    }>;
  } | null;
  goalAndTouch?: {
    goalResetTicks?: number;
    getEffectiveGoalResetTicks?(): number;
  } | null;
  rewinderController?: {
    startNewRecording?(): void;
    stopRecording?(): void;
    seekFrame?(frame: number): void;
    resumeFromCursor?(): void;
    _returnToLivePlayFromScrub?(): void;
  } | null;
}

export interface ScenarioRuntimePort {
  playerCarIndex?: number;
  arena?: {
    cars?: Array<({ visible: boolean; position?: { x: number; y: number; z: number } } & Record<string, unknown>) | null>;
    vehiclePresets?: Array<string | null>;
    carWheels?: Array<Array<{
      steer?: { position?: { x: number; y: number; z: number }; rotation?: { y: number } };
      spin?: { rotation?: { z: number } };
    }> | null>;
    carWheelSpecs?: Array<Array<[number, number, number]> | null>;
    carHitboxes?: Array<{
      position?: { x: number; y: number; z: number };
      geometry?: { parameters?: { width?: number; height?: number; depth?: number } };
    } | null>;
    vehicleRegistry?: {
      carWheelSpecs?: Array<Array<[number, number, number]> | null>;
      carHitboxes?: Array<{
        position?: { x: number; y: number; z: number };
        geometry?: { parameters?: { width?: number; height?: number; depth?: number } };
      } | null>;
    } | null;
    carBoosts?: Array<Array<{
      nozzleLocal?: { x: number; y: number; z: number };
      offset?: { x: number; y: number; z: number };
      physics?: { driveParticlesActive?: boolean; trailParticlesActive?: boolean };
      goldRush?: { driveParticlesActive?: boolean; trailParticlesActive?: boolean };
    }>>;
  } | null;
  simulationStage?: {
    getCarActionState?(carIdx: number): {
      boostLatched?: boolean;
      hasSingleJumped?: boolean;
      hasAirJumped?: boolean;
    };
  } | null;
  authoritativeServer?: {
    enterStateOnlyMode?(snap: Float32Array | null, tick: number): void;
    beginInterveneCountdown?(seconds: number, snap: Float32Array | null): void;
    resumePhysicsFromState?(snap: Float32Array | null, tick: number): void;
    fallbackManager?: {
      systemControl?: {
        isStateOnlyMode?: boolean;
        lastSystemControlSignal?: number;
      } | null;
    } | null;
  } | null;
  networkReconciler?: object | null;
  networkManager?: {
    sessionCoordinator?: {
      stopOnlineServer?(opts?: { rebindLoopback?: boolean }): Promise<void> | void;
      enableNetworkPrediction?(
        enabled: boolean,
        opts?: { forceFallback?: boolean },
      ): Promise<unknown> | unknown;
    } | null;
  } | null;
  modeManager: {
    setActiveMode(mode: string): void;
    getActiveMode(): ScenarioActiveModePort;
  };
  match?: {
    state?: {
      phase?: string;
      mode?: string;
      blueScore?: number;
      score?: { blue?: number; orange?: number };
    } | null;
  } | null;
  physics?: {
    numCars: number;
    addCar?(team: number, preset: string): number | void;
    resetKickoff?(seed?: number): void;
    setControls?(carIndex: number, controls: Partial<CarControlsInput>): void;
    step?(ticks?: number): void;
    getCarStateView?(carIndex: number): {
      posX: number;
      posY: number;
      posZ: number;
      velX: number;
      velY: number;
      velZ: number;
      boost: number;
      isOnGround: boolean | number;
      isJumping?: boolean | number;
    } | null;
    saveCompactState?(): Float32Array;
  } | null;
  lastSystemControlSignal?: number;
  resetKickoff?(seed?: number): void;
  isGoalReplayCameraOverrideActive?(): boolean;
}

export interface ScenarioLoopbackSimulatorPort {
  startSixCarLoopbackSession(durationSeconds?: number): Promise<void>;
  triggerForceStartMatch(durationSeconds?: number): void;
  collectTelemetry(): MultiplayerLoopbackTelemetry;
  stop(): Promise<void> | void;
}

export interface ScenarioStepContext {
  readonly tick: number;
  readonly virtualTimeMs: number;
  readonly runtime: ScenarioRuntimePort;
  readonly loopbackSimulator: ScenarioLoopbackSimulatorPort;
  setLocalCarControls(controls: Partial<CarControlsInput> | null): void;
  setBallState(state: {
    pos?: [number, number, number];
    vel?: [number, number, number];
    angVel?: [number, number, number];
  }): void;
  setCarState(
    carIndex: number,
    state: {
      pos?: [number, number, number];
      vel?: [number, number, number];
      angVel?: [number, number, number];
      boost?: number;
    },
  ): void;
  captureVehicleRigProbe(carIndex?: number): VehicleRigGeometryProbeSnapshot | null;
  diffVehicleRigAgainstGolden(carIndex?: number, toleranceUu?: number): VehicleRigGoldenDiffReport | null;
  markKeyframe(reason: string): void;
  recordAssertion(label: string, passed: boolean, detail: string): void;
}

export interface ScenarioTickStep {
  tick: number;
  description: string;
  forceKeyframeRender?: boolean;
  keyframeReason?: string;
  action?: (ctx: ScenarioStepContext) => void | Promise<void>;
}

export interface ScenarioScript {
  id: string;
  title: string;
  description: string;
  totalTicks: number;
  renderStride: number;
  batchYieldTicks?: number;
  forceRenderOnKeyframes?: boolean;
  setup?: (ctx: ScenarioStepContext) => void | Promise<void>;
  perTick?: (ctx: ScenarioStepContext) => void;
  teardown?: (ctx: ScenarioStepContext) => void | Promise<void>;
  steps: ScenarioTickStep[];
}

export interface ScenarioRunReport {
  scenarioId: string;
  title: string;
  description: string;
  passed: boolean;
  configuredSpeedPreset: string;
  totalTicks: number;
  simulatedDurationSeconds: number;
  wallClockDurationMs: number;
  effectiveTickRateHz: number;
  speedupFactorVsRealtime: number;
  renderedFramesCount: number;
  skippedRenderFramesCount: number;
  stageTimings: Record<PipelineStageName | 'TotalFrame', StageTimingDistribution>;
  topHitchFrames: HitchFrameAttribution[];
  keyframeRenders: KeyframeRenderSample[];
  cameraSmoothness: CameraSmoothnessTelemetry;
  multiplayerLoopback: MultiplayerLoopbackTelemetry | null;
  runtimeErrors: RuntimeErrorInterceptionSummary;
  vehicleRigProbes: VehicleRigGeometryProbeSnapshot[];
  goldenDiff: GoldenBaselineDiffSummary | null;
  assertions: ScenarioAssertionResult[];
}

export interface BaselineSuiteTelemetryReport {
  schemaVersion: '1.0.0' | '1.1.0';
  generatedAtIso: string;
  gitCommitShort?: string;
  configuredSpeedPreset: string;
  userAgent: string;
  webglRenderer: string;
  webglVendor: string;
  bootstrap: BootstrapTelemetrySnapshot;
  goldenBaselineDiff: GoldenBaselineDiffSummary | null;
  scenarios: ScenarioRunReport[];
  overallPassed: boolean;
}
