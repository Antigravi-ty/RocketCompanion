/**
 * ScenarioRuntimePorts.ts
 * Structural port interfaces decoupling declarative scenario scripts and probes
 * from concrete GameRuntime, ArenaWorld, AuthoritativeServer, and ActiveMode classes.
 */

import type { CarControlsInput } from '../../network/protocol/InputPacketCodec.ts';

export type Vec3Tuple = [number, number, number];
export type Vec3Obj = { x: number; y: number; z: number };
export type KinematicPatch = { pos?: Vec3Tuple; vel?: Vec3Tuple; angVel?: Vec3Tuple; boost?: number };

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
    setReplayCameraMode?(m: string): void;
  } | null;
  standaloneReplayViewer?: {
    isActive?: boolean;
    hasLoadedReplay?: boolean;
    loadReplayFromBytes?(b: Uint8Array, name?: string): Promise<boolean> | boolean;
    handleLoadRetainedMatchReplay(): void;
    startPlayback?(): void;
    startPlaying(): void;
    beginInterventionPreRoll?(): void;
    selectPovCarSlot?(s: number): void;
    selectPovSlot?(s: number): void;
    rosterSubController?: {
      resolvedRoster: Array<{ slotKey: number; carIndex: number }>;
      activePovCarIndex: number;
    };
    takeoverSubController?: { cursor?: number; getViewerState?(): string };
  } | null;
  replayRingBuffer?: {
    capacityTicks?: number;
    mode?: string;
    appendSignal?(t: number, sig: { signalType: number; frameId: number; param1: number; param2: number }): void;
    getFrames?(): ReadonlyArray<{ signals?: ReadonlyArray<{ signalType?: number; type?: number }> }>;
  } | null;
  goalAndTouch?: {
    goalResetTicks?: number;
    getEffectiveGoalResetTicks?(): number;
  } | null;
  rewinderController?: {
    startNewRecording?(): void;
    stopRecording?(): void;
    seekFrame?(f: number): void;
    resumeFromCursor?(): void;
    _returnToLivePlayFromScrub?(): void;
  } | null;
}

export interface ScenarioServerPlayerEntry {
  sessionId: string;
  entityId: number;
  name: string;
  role: string;
  team: number;
  isBot?: boolean;
  botType?: string;
  visualId?: string;
  hitboxId?: string;
  colorSlot?: number;
  ready?: boolean;
  spawnSlot?: number;
}

export interface ScenarioAuthoritativeServerPort {
  active?: boolean;
  isWorker?: boolean;
  lastServerTick?: number;
  cachedSnapshot?: Float32Array;
  onRoomStateChange?(snapshot: unknown): void;
  requestFullReplayExport?(): Promise<{ frameCount?: number; frames?: unknown[] } | null>;
  lastRoomState?: {
    phase?: string;
    matchState?: string;
    gameMode?: string;
    botFillMode?: string;
    score?: { blue?: number; orange?: number };
    players?: ScenarioServerPlayerEntry[];
  } | null;
  botTunnelManager?: {
    botPeers?: Map<string, { sessionId: string; carIndex: number; team: number; botType: string; agent?: { isReady?: boolean } | null }>;
    registeredTunnels?: Map<string, { botType?: string }>;
  } | null;
  hostReplayRingBuffer?: {
    mode?: string;
    capacityTicks?: number;
    size?: number;
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
    removePlayerSession(sessionId: string): void;
    buildRosterSnapshot(): unknown;
    replayBuffer?: { capacity?: number; mode?: string; size?: number } | null;
    goalReplay?: { finishGoalReplay?(): void } | null;
    physicsManager?: {
      sim?: { getCarStateView?(carIndex: number): { posX: number; posY: number; posZ: number } | null } | null;
    } | null;
    domain?: {
      phase?: string;
      state?: string;
      gameMode?: string;
      botFillMode?: string;
      scoreBlue?: number;
      scoreOrange?: number;
      remainingSeconds?: number;
      clockStarted?: boolean;
      isOvertime?: boolean;
      pendingMatchEndAfterGoal?: boolean;
      winner?: number | null;
      isTrainingMode?: boolean;
      stateOnlyMode?: boolean;
      interveneTargetTick?: number;
      trainingDisableGoalReset?: boolean;
      players?: Map<string, ScenarioServerPlayerEntry>;
    } | null;
    roster: {
      players: Map<string, ScenarioServerPlayerEntry>;
      addBotPlayer?(team?: number, name?: string | null, visualId?: string | Record<string, unknown> | null, botType?: string): unknown;
      setBotFillMode?(mode: string, botType?: string): void;
      applyBotFillPolicy(): void;
      syncRosterPhysicsEntities(): void;
      applyRosterKickoffSpawns(): void;
    };
    trainingSession?: {
      activeCarSlots?: number[];
      maxExtraCars?: number;
      configureRuleset?(cfg?: Record<string, unknown>): void;
      spawnExtraCar?(opts?: Record<string, unknown>): { carIndex: number; evictedCarIndex: number | null };
      clearExtraCars?(): void;
    } | null;
    systemControl?: { isStateOnlyMode?: boolean; lastSystemControlSignal?: number } | null;
  } | null;
}

export interface ScenarioHitboxMeshLike {
  position?: Vec3Obj;
  geometry?: { parameters?: { width?: number; height?: number; depth?: number } };
}

export interface ScenarioRuntimePort {
  running?: boolean;
  playerCarIndex?: number;
  lastSystemControlSignal?: number;
  resetKickoff?(seed?: number): void;
  isGoalReplayCameraOverrideActive?(): boolean;
  start?(): void;
  replayTimelineController?: { setCameraMode?(mode: string): void } | null;
  podiumController?: { isActive?: boolean } | null;
  renderer?: {
    getContext?(): WebGLRenderingContext | WebGL2RenderingContext | null;
    info?: {
      programs?: unknown[];
      render?: { calls?: number; triangles?: number };
      memory?: { geometries?: number; textures?: number };
    };
  } | null;
  camera?: {
    mode?: string;
    currentMode?: string;
    isFreeCam?: boolean;
    isEditorOverrideActive?: boolean;
    camera?: { position?: Vec3Obj; quaternion?: Vec3Obj & { w: number } };
  } | null;
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
    carHitboxes?: Array<ScenarioHitboxMeshLike | null>;
    vehicleRegistry?: {
      carWheelSpecs?: Array<Array<Vec3Tuple> | null>;
      carHitboxes?: Array<ScenarioHitboxMeshLike | null>;
    } | null;
    carBoosts?: Array<Array<{
      nozzleLocal?: Vec3Obj;
      offset?: Vec3Obj;
      physics?: { driveParticlesActive?: boolean; trailParticlesActive?: boolean };
      goldRush?: { driveParticlesActive?: boolean; trailParticlesActive?: boolean };
    }>>;
  } | null;
  authoritativeServer?: ScenarioAuthoritativeServerPort | null;
  networkReconciler?: {
    correctionCount?: number;
    skippedCorrectionCount?: number;
    hardSnapCount?: number;
    maxCorrectionDelta?: number;
  } | null;
  networkManager?: {
    isLobbyDualWorldActive?(): boolean;
    startOnlineServer?(opts?: Record<string, unknown>): Promise<unknown>;
    stopOnlineServer?(opts?: Record<string, unknown>): Promise<void> | void;
    forceStartOnlineMatch?(durationSeconds?: number): void;
    setOnlineGameMode?(gameMode?: string, durationSeconds?: number | null): void;
    setOnlineBotFillMode?(botFillMode?: string, botType?: string): void;
    addOnlineBot?(team?: number | null, botName?: string | null, visualId?: string | null, botType?: string): void;
    setClientReady?(ready?: boolean): void;
    voteSkipReplay?(): void;
    diagnosticsProbe?: {
      diagnosticsFleetController?: { enabled?: boolean } | null;
      spawnDiagnosticTestFleet?(): Promise<{ enabled?: boolean } | null>;
      sampleDiagnosticFleetTelemetry?(): { enabled?: boolean; car6?: { active?: boolean }; car7?: { active?: boolean } } | null;
      despawnDiagnosticTestFleet?(): void;
      dumpLatestNetworkPacket?(): unknown;
    } | null;
    sessionCoordinator?: {
      hostOnlineServer?(opts?: Record<string, unknown>): Promise<unknown>;
      stopOnlineServer?(opts?: { rebindLoopback?: boolean }): Promise<void> | void;
      enableNetworkPrediction?(enabled: boolean, opts?: { forceFallback?: boolean }): Promise<unknown> | unknown;
    } | null;
  } | null;
  modeManager: { setActiveMode(mode: string): void; getActiveMode(): ScenarioActiveModePort };
  match?: {
    state?: {
      phase?: string;
      mode?: string;
      isOvertime?: boolean;
      blueScore?: number;
      orangeScore?: number;
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
    setBallState?(s: KinematicPatch): void;
    setCarState?(carIndex: number, s: KinematicPatch): void;
    saveCompactState?(): Float32Array;
  } | null;
}
