/**
 * ScenarioTypes.ts
 * Declarative scenario script format, tick-scheduled action/assertion descriptors,
 * per-stage wall-clock timing distributions, keyframe GPU/shader telemetry,
 * SceneGraph vehicle rig geometry calibration probes, runtime error interception,
 * speed presets, and Golden 65f1538d diff report schemas.
 */

import type { CarControlsInput } from '../../network/protocol/InputPacketCodec.ts';

export type PipelineStageName =
  | 'InputStage' | 'SimulationStage' | 'GameplayModeStage' | 'PresentationStage'
  | 'AudioStage' | 'RenderStage' | 'TelemetryStage';

export type ScenarioSpeedPreset = '1x' | '10x' | '20x' | '50x' | 'max';

export interface ScenarioDriverRunOptions {
  speed?: ScenarioSpeedPreset | string | number;
  renderStrideOverride?: number; batchYieldTicksOverride?: number;
  failOnConsoleError?: boolean; includeGoldenDiff?: boolean;
}

export interface CapturedRuntimeErrorEntry {
  tick: number; virtualTimeMs: number;
  source: 'window.onerror' | 'unhandledrejection' | 'console.error';
  message: string; stack?: string;
  fileName?: string; lineNumber?: number; columnNumber?: number;
}

export interface RuntimeErrorInterceptionSummary {
  windowErrorCount: number; unhandledRejectionCount: number;
  consoleErrorCount: number; totalErrorCount: number;
  entries: CapturedRuntimeErrorEntry[];
}

export interface VehicleWheelGeometrySample {
  wheelIndex: number;
  steerPosition: [number, number, number];
  steerRotationY: number; spinRotationZ: number;
  specAnchor: [number, number, number];
}

export interface VehicleRigGeometryProbeSnapshot {
  carIndex: number; visualId: string; hitboxPresetId: string;
  carVisible: boolean; carPosition: [number, number, number];
  frontAxleX: number; rearAxleX: number; wheelbaseX: number;
  frontTrackWidthZ: number; rearTrackWidthZ: number;
  wheelHeightsY: [number, number, number, number];
  wheels: VehicleWheelGeometrySample[];
  wheelSpecs: Array<[number, number, number]>;
  boostOutlets: Array<[number, number, number]>;
  hitboxDimensions: [number, number, number] | null;
  hitboxOffset: [number, number, number] | null;
}

export interface GoldenFieldDiffItem {
  field: string; expected: unknown; actual: unknown;
  maxAbsDelta: number; passed: boolean;
}

export interface VehicleRigGoldenDiffReport {
  carIndex: number; visualId: string; goldenReferenceId: string;
  passed: boolean; maxCoordinateDeltaUu: number;
  mismatches: GoldenFieldDiffItem[];
  probe: VehicleRigGeometryProbeSnapshot;
}

export interface GoldenBaselineDiffSummary {
  referenceCommit: string; referenceUiCoreCommit: string;
  passed: boolean; staticDescriptorChecksPassed: boolean;
  staticDescriptorDiffs: GoldenFieldDiffItem[];
  vehicleRigDiffs: VehicleRigGoldenDiffReport[];
}

export interface BootstrapTaskTelemetry {
  stageIndex: number; stageTitle: string;
  step: number; totalSteps: number;
  taskId: string; taskName: string; durationMs: number;
  status: 'completed' | 'skipped' | 'error';
}

export interface BootstrapStageSummary {
  stageIndex: number; stageTitle: string;
  totalDurationMs: number; taskCount: number;
  tasks: BootstrapTaskTelemetry[];
}

export interface BootstrapTelemetrySnapshot {
  totalDurationMs: number; totalSteps: number;
  backgroundAssetsDurationMs: number;
  initialCompiledShaderPrograms: number;
  stages: BootstrapStageSummary[];
}

export interface StageTimingDistribution {
  stage: PipelineStageName | 'TotalFrame';
  sampleCount: number; meanMs: number;
  p50Ms: number; p95Ms: number; p99Ms: number;
  maxMs: number; maxTick: number; totalWallMs: number;
}

export interface KeyframeRenderSample {
  tick: number; virtualTimeMs: number;
  reason: string; phase: string; gameMode: string; cameraMode: string;
  renderStageWallMs: number; totalFrameWallMs: number;
  shaderProgramsBefore: number; shaderProgramsAfter: number; shaderProgramsDelta: number;
  glError: number; drawCalls: number; triangles: number; geometries: number; textures: number;
}

export interface HitchFrameAttribution {
  tick: number; virtualTimeMs: number; totalFrameWallMs: number;
  dominantStage: PipelineStageName; dominantStageWallMs: number;
  phase: string; cameraMode: string;
  didGpuRender: boolean; shaderProgramsDelta: number;
  stageBreakdownMs: Record<PipelineStageName, number>;
}

export interface CameraSmoothnessTelemetry {
  sampleCount: number; nanFrameCount: number;
  maxPositionStepDistance: number; p95PositionStepDistance: number;
  maxAngularStepDeg: number; p95AngularStepDeg: number;
  directorReplaySamples: number;
  directorReplayFirstFrameRenderMs: number | null;
  directorReplayFirstFrameShaderDelta: number | null;
}

export interface VirtualPeerLoadoutSpec {
  peerId: string; playerName: string; carIndex: number; team: 0 | 1;
  visualId: string; hitboxId: string; colorSlot: number;
  paintFinish: 'matte' | 'metallic';
  boostVisual: 'gold-rush' | 'cartoon';
  boostAudio: 'rush' | 'standard' | 'flamethrower' | 'plasma';
}

export interface MultiplayerLoopbackTelemetry {
  configuredCarCount: number; activePhysicalCars: number;
  visibleArenaCars: number; virtualPeersConnected: number;
  totalClientInputPacketsSent: number; totalClientInputBytesSent: number;
  totalServerFramePacketsReceived: number; totalServerFrameBytesReceived: number;
  totalSignalsDecoded: number; distinctSignalNames: string[];
  reconcilerCorrections: number; reconcilerSkippedCorrections: number;
  reconcilerHardSnaps: number; reconcilerMaxCorrectionDelta: number;
  loadoutsVerified: VirtualPeerLoadoutSpec[];
}

export interface ScenarioAssertionResult {
  tick: number; label: string; passed: boolean; detail: string;
}

export type Vec3Tuple = [number, number, number];
export type Vec3Obj = { x: number; y: number; z: number };
export type KinematicPatch = { pos?: Vec3Tuple; vel?: Vec3Tuple; angVel?: Vec3Tuple; boost?: number };

export interface ScenarioActiveModePort {
  isReplayActive?: boolean; replayCameraMode?: string; goalResetTicks?: number;
  isGoalReplayActive?(): boolean; setReplayCameraMode?(mode: string): void;
  skipGoalReplay?(): void; resetToCleanFreeplay?(): void;
  directorPreview?: { isReplayActive?: boolean; replayCameraMode?: string; setReplayCameraMode?(m: string): void } | null;
  standaloneReplayViewer?: {
    isActive?: boolean; hasLoadedReplay?: boolean;
    loadReplayFromBytes?(b: Uint8Array, name?: string): Promise<boolean> | boolean;
    handleLoadRetainedMatchReplay(): void; startPlayback?(): void; startPlaying(): void;
    beginInterventionPreRoll?(): void; selectPovCarSlot?(s: number): void; selectPovSlot?(s: number): void;
    rosterSubController?: { resolvedRoster: Array<{ slotKey: number; carIndex: number }>; activePovCarIndex: number };
    takeoverSubController?: { cursor?: number; getViewerState?(): string };
  } | null;
  replayRingBuffer?: {
    capacityTicks?: number; mode?: string;
    appendSignal?(t: number, sig: { signalType: number; frameId: number; param1: number; param2: number }): void;
    getFrames?(): ReadonlyArray<{ signals?: ReadonlyArray<{ signalType?: number; type?: number }> }>;
  } | null;
  goalAndTouch?: { goalResetTicks?: number; getEffectiveGoalResetTicks?(): number } | null;
  rewinderController?: {
    startNewRecording?(): void; stopRecording?(): void; seekFrame?(f: number): void;
    resumeFromCursor?(): void; _returnToLivePlayFromScrub?(): void;
  } | null;
}

export interface ScenarioServerPlayerEntry {
  sessionId: string; entityId: number; name: string; role: string; team: number;
  isBot?: boolean; botType?: string; visualId?: string; hitboxId?: string;
  colorSlot?: number; ready?: boolean; spawnSlot?: number;
}

export interface ScenarioAuthoritativeServerPort {
  active?: boolean; isWorker?: boolean; lastServerTick?: number; cachedSnapshot?: Float32Array;
  lastRoomState?: {
    phase?: string; matchState?: string; gameMode?: string; botFillMode?: string;
    score?: { blue?: number; orange?: number }; players?: ScenarioServerPlayerEntry[];
  } | null;
  botTunnelManager?: {
    botPeers?: Map<string, { sessionId: string; carIndex: number; team: number; botType: string; agent?: { isReady?: boolean } | null }>;
  } | null;
  hostReplayRingBuffer?: {
    mode?: string; capacityTicks?: number; size?: number;
    getFrames?(): ReadonlyArray<{ tick: number; signals?: ReadonlyArray<{ signalType?: number; type?: number }> }>;
  } | null;
  enterStateOnlyMode?(snap: Float32Array | null, tick: number): void;
  beginInterveneCountdown?(seconds: number, snap: Float32Array | null): void;
  resumePhysicsFromState?(snap: Float32Array | null, tick: number): void;
  setGameMode?(gameMode: string, durationSeconds?: number | null): void;
  setBotFillMode?(botFillMode: string, botType?: string): void;
  addBotPlayer?(team?: number, botName?: string | null, visualId?: string | Record<string, unknown>, botType?: string): void;
  switchRoleTeam?(sessionId: string | null, role: string, team: number): void;
  initiateMatchPrepare?(durationSeconds?: number): void;
  forceStartMatch?(durationSeconds?: number): void;
  startMatch?(durationSeconds?: number): void;
  pauseMatch?(paused?: boolean): void;
  requestResumeWithCountdown?(countdownSeconds?: number): void;
  setSkipReplayByDefault?(enabled: boolean): void;
  setDisableGoalReset?(disabled: boolean): void;
  startTrainingMode?(opts?: Record<string, unknown>): void;
  configureTrainingRuleset?(opts?: Record<string, unknown>): void;
  fallbackSim?: {
    setBallState?(s: KinematicPatch): void;
    setCarState?(carIndex: number, s: KinematicPatch): void;
    saveCompactState?(): Float32Array;
  } | null;
  fallbackManager?: {
    domain?: {
      phase?: string; gameMode?: string; botFillMode?: string;
      scoreBlue?: number; scoreOrange?: number; remainingSeconds?: number;
      players?: Map<string, ScenarioServerPlayerEntry>;
    } | null;
    roster?: {
      players?: Map<string, ScenarioServerPlayerEntry>;
      addBotPlayer?(team?: number, name?: string | null, visualId?: string | Record<string, unknown> | null, botType?: string): unknown;
      setBotFillMode?(mode: string, botType?: string): void;
      applyBotFillPolicy?(): void;
    } | null;
    trainingSession?: {
      activeCarSlots?: number[]; maxExtraCars?: number;
      configureRuleset?(cfg?: Record<string, unknown>): void;
      spawnExtraCar?(opts?: Record<string, unknown>): { carIndex: number; evictedCarIndex: number | null };
      clearExtraCars?(): void;
    } | null;
    systemControl?: { isStateOnlyMode?: boolean; lastSystemControlSignal?: number } | null;
  } | null;
}

export interface ScenarioRuntimePort {
  running?: boolean; playerCarIndex?: number; lastSystemControlSignal?: number;
  resetKickoff?(seed?: number): void; isGoalReplayCameraOverrideActive?(): boolean; start?(): void;
  renderer?: {
    getContext?(): WebGLRenderingContext | WebGL2RenderingContext | null;
    info?: { programs?: unknown[]; render?: { calls?: number; triangles?: number }; memory?: { geometries?: number; textures?: number } };
  } | null;
  camera?: { mode?: string; camera?: { position?: Vec3Obj; quaternion?: Vec3Obj & { w: number } } } | null;
  keyboard?: { read?(): CarControlsInput } | null;
  inputStage?: { update?(ctx: unknown): void } | null;
  simulationStage?: {
    update?(ctx: unknown): void;
    getCarActionState?(carIdx: number): { boostLatched?: boolean; hasSingleJumped?: boolean; hasAirJumped?: boolean };
  } | null;
  gameplayModeStage?: { update?(ctx: unknown): void } | null;
  presentationStage?: { update?(ctx: unknown): void } | null;
  audioStage?: { update?(ctx: unknown): void } | null;
  renderSubsystem?: { update?(ctx: unknown): void } | null;
  telemetryStage?: { update?(ctx: unknown): void } | null;
  interpolator?: { sync?(nowMs: number): void } | null;
  arena?: {
    cars?: Array<({ visible: boolean; position?: Vec3Obj } & Record<string, unknown>) | null>;
    vehiclePresets?: Array<string | null>;
    carWheels?: Array<Array<{ steer?: { position?: Vec3Obj; rotation?: { y: number } }; spin?: { rotation?: { z: number } } }> | null>;
    carWheelSpecs?: Array<Array<Vec3Tuple> | null>;
    carHitboxes?: Array<{ position?: Vec3Obj; geometry?: { parameters?: { width?: number; height?: number; depth?: number } } } | null>;
    vehicleRegistry?: {
      carWheelSpecs?: Array<Array<Vec3Tuple> | null>;
      carHitboxes?: Array<{ position?: Vec3Obj; geometry?: { parameters?: { width?: number; height?: number; depth?: number } } } | null>;
    } | null;
    carBoosts?: Array<Array<{
      nozzleLocal?: Vec3Obj; offset?: Vec3Obj;
      physics?: { driveParticlesActive?: boolean; trailParticlesActive?: boolean };
      goldRush?: { driveParticlesActive?: boolean; trailParticlesActive?: boolean };
    }>>;
  } | null;
  authoritativeServer?: ScenarioAuthoritativeServerPort | null;
  networkReconciler?: { correctionCount?: number; skippedCorrectionCount?: number; hardSnapCount?: number; maxCorrectionDelta?: number } | null;
  networkManager?: {
    startOnlineServer?(opts?: Record<string, unknown>): Promise<unknown>;
    stopOnlineServer?(opts?: Record<string, unknown>): Promise<void> | void;
    forceStartOnlineMatch?(durationSeconds?: number): void;
    setOnlineGameMode?(gameMode?: string, durationSeconds?: number | null): void;
    setOnlineBotFillMode?(botFillMode?: string, botType?: string): void;
    addOnlineBot?(team?: number | null, botName?: string | null, visualId?: string | null, botType?: string): void;
    setClientReady?(ready?: boolean): void;
    voteSkipReplay?(): void;
    sessionCoordinator?: {
      stopOnlineServer?(opts?: { rebindLoopback?: boolean }): Promise<void> | void;
      enableNetworkPrediction?(enabled: boolean, opts?: { forceFallback?: boolean }): Promise<unknown> | unknown;
    } | null;
  } | null;
  modeManager: { setActiveMode(mode: string): void; getActiveMode(): ScenarioActiveModePort };
  match?: { state?: { phase?: string; mode?: string; blueScore?: number; orangeScore?: number; score?: { blue?: number; orange?: number } } | null } | null;
  physics?: {
    numCars: number; addCar?(team: number, preset: string): number | void;
    resetKickoff?(seed?: number): void; setControls?(carIndex: number, controls: Partial<CarControlsInput>): void;
    step?(ticks?: number): void;
    getCarStateView?(carIndex: number): {
      posX: number; posY: number; posZ: number; velX: number; velY: number; velZ: number;
      boost: number; isOnGround: boolean | number; isJumping?: boolean | number;
    } | null;
    setBallState?(s: KinematicPatch): void; setCarState?(carIndex: number, s: KinematicPatch): void;
    saveCompactState?(): Float32Array;
  } | null;
}

export interface ScenarioLoopbackSimulatorPort {
  readonly isActive?: boolean;
  startSixCarLoopbackSession(durationSeconds?: number): Promise<void>;
  connectVirtualPeers?(specs: readonly VirtualPeerLoadoutSpec[]): Promise<void>;
  broadcastClientCommand?(commandType: number, param1?: number, param2?: number): void;
  triggerForceStartMatch(durationSeconds?: number): void;
  collectTelemetry(): MultiplayerLoopbackTelemetry;
  stop(): Promise<void> | void;
}

export interface ScenarioStepContext {
  readonly tick: number; readonly virtualTimeMs: number;
  readonly runtime: ScenarioRuntimePort; readonly loopbackSimulator: ScenarioLoopbackSimulatorPort;
  setLocalCarControls(controls: Partial<CarControlsInput> | null): void;
  setBallState(state: KinematicPatch): void;
  setCarState(carIndex: number, state: KinematicPatch): void;
  captureVehicleRigProbe(carIndex?: number): VehicleRigGeometryProbeSnapshot | null;
  diffVehicleRigAgainstGolden(carIndex?: number, toleranceUu?: number): VehicleRigGoldenDiffReport | null;
  markKeyframe(reason: string): void;
  recordAssertion(label: string, passed: boolean, detail: string): void;
}

export interface ScenarioTickStep {
  tick: number; description: string;
  forceKeyframeRender?: boolean; keyframeReason?: string;
  action?: (ctx: ScenarioStepContext) => void | Promise<void>;
}

export interface ScenarioScript {
  id: string; title: string; description: string;
  totalTicks: number; renderStride: number;
  batchYieldTicks?: number; forceRenderOnKeyframes?: boolean;
  setup?: (ctx: ScenarioStepContext) => void | Promise<void>;
  perTick?: (ctx: ScenarioStepContext) => void;
  teardown?: (ctx: ScenarioStepContext) => void | Promise<void>;
  steps: ScenarioTickStep[];
}

export interface ScenarioRunReport {
  scenarioId: string; title: string; description: string;
  passed: boolean; configuredSpeedPreset: string;
  totalTicks: number; simulatedDurationSeconds: number;
  wallClockDurationMs: number; effectiveTickRateHz: number;
  speedupFactorVsRealtime: number;
  renderedFramesCount: number; skippedRenderFramesCount: number;
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
  generatedAtIso: string; gitCommitShort?: string;
  configuredSpeedPreset: string; userAgent: string;
  webglRenderer: string; webglVendor: string;
  bootstrap: BootstrapTelemetrySnapshot;
  goldenBaselineDiff: GoldenBaselineDiffSummary | null;
  scenarios: ScenarioRunReport[];
  overallPassed: boolean;
}
