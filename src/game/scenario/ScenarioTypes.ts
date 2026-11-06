/**
 * ScenarioTypes.ts
 * Declarative scenario script format, tick-scheduled action/assertion descriptors,
 * per-stage wall-clock timing distributions, keyframe GPU/shader telemetry,
 * and baseline report schemas for Phase 1 calibration.
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

export interface ScenarioStepContext {
  readonly tick: number;
  readonly virtualTimeMs: number;
  readonly runtime: any;
  readonly loopbackSimulator: any;
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
  assertions: ScenarioAssertionResult[];
}

export interface BaselineSuiteTelemetryReport {
  schemaVersion: '1.0.0';
  generatedAtIso: string;
  gitCommitShort?: string;
  userAgent: string;
  webglRenderer: string;
  webglVendor: string;
  bootstrap: BootstrapTelemetrySnapshot;
  scenarios: ScenarioRunReport[];
  overallPassed: boolean;
}
