/**
 * ScenarioTypes.ts
 * Declarative scenario script format, tick-scheduled action/assertion descriptors,
 * per-stage timing distributions, keyframe GPU telemetry, rig probes, and Golden diff schemas.
 */

import type { CarControlsInput } from '../../network/protocol/InputPacketCodec.ts';
import type {
  KinematicPatch,
  ScenarioActiveModePort,
  ScenarioAuthoritativeServerPort,
  ScenarioHitboxMeshLike,
  ScenarioRuntimePort,
  ScenarioServerPlayerEntry,
  Vec3Obj,
  Vec3Tuple,
} from './ScenarioRuntimePorts.ts';

export type {
  KinematicPatch,
  ScenarioActiveModePort,
  ScenarioAuthoritativeServerPort,
  ScenarioHitboxMeshLike,
  ScenarioRuntimePort,
  ScenarioServerPlayerEntry,
  Vec3Obj,
  Vec3Tuple,
};

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

export interface ScenarioLoopbackSimulatorPort {
  readonly isActive?: boolean | (() => boolean);
  startSixCarLoopbackSession(durationSeconds?: number): Promise<void>;
  connectVirtualPeers?(specs: readonly VirtualPeerLoadoutSpec[]): Promise<void>;
  broadcastClientCommand?(commandType: number, param1?: number, param2?: number): void;
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
  setBallState(state: KinematicPatch): void;
  setCarState(carIndex: number, state: KinematicPatch): void;
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
