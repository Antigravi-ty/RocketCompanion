import type { RandomAnthemScope } from '../ui-core/config/anthemCatalogConfig';
import type {
  BgmSceneConfig,
  SpatialAudioTunerConfig,
} from '../ui-core/config/spatialAudioConfig';
import type {
  NameTagBoostBorderOverride,
  NameTagCarEntry,
  NameTagConfig,
  NameTagRuntimeState,
  NameTagTelemetrySnapshot,
} from '../ui-core/config/nameTagConfig';
import type {
  EditSubMode,
  StaticTrainingPackMetadata,
  StaticTrainingShotItem,
} from '../ui-core/config/staticTrainingPackTypes';
import type {
  DirectorCameraState,
  ReplaySessionState,
} from '../replay/replayDirectorStateTypes';

export type {
  NameTagBoostBorderOverride,
  NameTagCarEntry,
  NameTagConfig,
  NameTagRuntimeState,
  NameTagTelemetrySnapshot,
  EditSubMode,
  StaticTrainingPackMetadata,
  StaticTrainingShotItem,
};

export interface OnlinePeerEntryPort {
  peerId?: string;
  carIndex: number;
  name?: string;
  playerName?: string;
  isHost?: boolean;
  isBot?: boolean;
  team?: 'blue' | 'orange' | 'spectator' | number;
  role?: 'player' | 'spectator';
  vehiclePreset?: string;
  colorHex?: string;
  materialsConfig?: Record<string, unknown> | null;
  selectedAnthem?: string;
  isReady?: boolean;
  pingMs?: number;
  [key: string]: unknown;
}

export interface OnlineSessionPortState {
  role?: string;
  status?: string;
  isHosting?: boolean;
  roomId?: string;
  password?: string;
  playerName?: string;
  pairingCode?: string;
  activeRelayLabel?: string;
  pendingPairingRequests?: unknown[];
  signalingConnected?: boolean;
  peers?: OnlinePeerEntryPort[];
  connectedPeers?: OnlinePeerEntryPort[];
  roomType?: 'warmup' | 'match' | string;
  gameMode?: '1v1' | '2v2' | '3v3' | string;
  botFillMode?: 'no_bots' | 'auto_fill' | 'bots_vs_humans' | 'custom' | string;
  matchDurationSeconds?: number;
  isReady?: boolean;
  localRole?: 'player' | 'spectator' | string;
  localTeam?: 'blue' | 'orange' | 'spectator' | string;
  [key: string]: unknown;
}

export interface GraphicsSettingsPort {
  renderScale?: number;
  resolutionScale?: number;
  antialias?: boolean;
  shadows?: boolean;
  bloom?: boolean;
  showStadium?: boolean;
  limitFps?: boolean;
  maxFps?: number;
  pauseRenderingOnMenu?: boolean;
  menuPowerSave?: string;
}

export interface GameplaySettingsPort {
  unlimitedBoost?: boolean;
  goalRestart?: boolean;
  showCarHitbox?: boolean;
  showAllCarHitboxes?: boolean;
  ballCamIndicator?: boolean;
}

export interface AppStorePortState {
  isMenuOpen?: boolean;
  isOpen?: boolean;
  activeRoute?: string;
  activeOverlay?: string;
  matchMode?: string;
  activeCar?: string;
  cameraMode?: string;
  isFreeCam?: boolean;
  freeCamFov?: number;
  isLivePreviewCollapsed?: boolean;
  touchMode?: boolean;
  touchHeadlessMode?: boolean;
  touchInputAgent?: boolean | string;
  graphics?: GraphicsSettingsPort;
  gameplay?: GameplaySettingsPort;
  audio?: {
    continueAudioOnLostFocus?: boolean;
    muteWhenUnfocused?: boolean;
    [key: string]: unknown;
  };
  telemetry?: {
    alwaysShow?: boolean;
    pauseTelemetryInPowerSave?: boolean;
    [key: string]: unknown;
  };
  camera?: Record<string, unknown>;
  trajectory?: Record<string, unknown>;
  materials?: Record<string, unknown>;
  boostPadTuner?: Record<string, unknown>;
  driftwoodsTuner?: Record<string, unknown>;
  clockPacingMode?: string;
  clockPacingPriority?: string;
  inputBufferTarget?: number;
  inputBufferThreshold?: [number, number];
  customClockPacingParams?: Record<string, unknown>;
  onlineSession: OnlineSessionPortState;
  bridge?: Record<string, (...args: unknown[]) => unknown>;
  openMenu: (route?: string) => void;
  closeMenu: () => void;
  toggleMenu: () => void;
  goBack: () => void;
  setActiveOverlay?: (overlay: string) => void;
  setMatchMode: (mode: string) => void;
  setFreeCam: (enabled: boolean) => void;
  toggleFreeCam: () => void;
  setLivePreviewCollapsed: (collapsed: boolean) => void;
  setOnlineSession: (patch: Partial<OnlineSessionPortState> | Record<string, unknown>) => void;
  setBridge?: (bridge: Record<string, unknown>) => void;
  resolveEffectiveClockPacingParams?: (...args: unknown[]) => Record<string, unknown>;
  [key: string]: unknown;
}

export interface HudStorePortState {
  matchPhase: string;
  replayProgress: number;
  replayFrameIndex?: number;
  replayTotalFrames?: number;
  replayPaused?: boolean;
  replayPersistent?: boolean;
  replaySpeed?: number;
  replayCameraMode?: string;
  replayScorerAnthemId?: string | null;
  choreographySignal?: string | null;
  scoreBlue: number;
  scoreOrange: number;
  blueScore?: number;
  orangeScore?: number;
  localTeam: number;
  boost: number;
  speedKph: number;
  onReplaySkip?: (() => void) | null;
  onReplayTogglePause?: (() => void) | null;
  setMatchState: (patch?: Record<string, unknown>) => void;
  setReplayState: (patch?: Record<string, unknown>) => void;
  clearReplayState: () => void;
  setChoreographySignal: (signal: string | null) => void;
  setBallCamActive: (active: boolean) => void;
  setOnToggleBallCam: (fn: (() => void) | null) => void;
  setCameraFocusState: (mode: string, carIndex?: number) => void;
  setBoost: (boost: number, isZeroG?: boolean, unlimited?: boolean) => void;
  setCarSpeed: (speedUuPerSec: number, speedKph?: number, isSupersonic?: boolean) => void;
  setHasFlip?: (
    hasFlip: boolean,
    flipStatus?: string,
    flipRemainingSeconds?: number,
    flipsRemaining?: number,
  ) => void;
  setDemoRespawnState: (isDemolished: boolean, remainingSeconds: number, durationSeconds?: number) => void;
  syncBindings: (bindings: Record<string, unknown>) => void;
  [key: string]: unknown;
}

export interface BgmTrackEntryPort {
  id: string;
  rawName: string;
  title: string;
  volume: string | null;
  trackNum: number | null;
  file: File;
  [key: string]: unknown;
}

export interface SpatialAudioStorePortState {
  selectedAnthem: string;
  randomAnthemScope: RandomAnthemScope;
  randomAnthemCategory: string;
  isGarageAnthemTabActive: boolean;
  previewingAnthemId: string | null;
  previewSource: string | null;
  activeGoalAnthemId: string | null;
  anthemLinearPhase: number;
  anthemBlend: number;
  isGoalReplaySkipped: boolean;
  bgmEnabled: boolean;
  bgmVolume: number;
  bgmScenes: BgmSceneConfig;
  realisticBgmEnabled: boolean;
  bgmCategorizedMode: boolean;
  bgmDeselectedVolumes: string[];
  bgmDeselectedTrackNames: string[];
  bgmTracks: BgmTrackEntryPort[];
  bgmVolumes: string[];
  bgmCurrentTrackId: string | null;
  bgmCurrentTrackTitle: string | null;
  bgmIsPlaying: boolean;
  bgmLinearPhase: number;
  bgmBlend: number;
  tunerConfig: Partial<SpatialAudioTunerConfig>;
  registerRuntimeCallbacks: (callbacks: Record<string, unknown>) => void;
  setGoalReplaySkipped: (skipped?: boolean) => void;
  setActiveGoalAnthemId: (id?: string | null) => void;
  setPreviewingAnthemId: (id?: string | null, source?: string | null) => void;
  setAnthemTransitionState: (linearPhase?: number, blend?: number) => void;
  setBgmPlaybackState: (patch?: Record<string, unknown>) => void;
  setBgmTransitionState: (linearPhase?: number, blend?: number) => void;
  [key: string]: unknown;
}

export interface SubsystemIsolationLabStorePortState {
  activePresetId: string;
  activeTab: string;
  selectedTab: string;
  probesEnabled: boolean;
  probeOffsetX: number;
  probeOffsetY: number;
  probeOffsetZ: number;
  probeBaseAltitudeZ: number;
  probePeakAltitudeZ: number;
  probeCameraTarget: string;
  dualWorldEnabled: boolean;
  ghostWorldCount: number;
  ghostCarsPerWorld: number;
  ghostOpacity: number;
  incidentMatchActive: boolean;
  incidentOpponentMode: string;
  incidentControlledCar: number;
  incidentSpeedMultiplier: number;
  incidentDisableGoalReplay: boolean;
  goalReplayLookbackSec: number;
  goalReplayPostGoalSec: number;
  kickoffDuelBlueModel: string;
  kickoffDuelOrangeModel: string;
  kickoffDuelSlotIndex: number;
  kickoffDuelCutoffDelaySec: number;
  kickoffDuelAutoCycle: boolean;
  kickoffDuelAutoCycleAllPairs: boolean;
  kickoffDuelSpeedMultiplier: number;
  kickoffDuelNextoScripted: boolean;
  kickoffDuelChannelMode: string;
  kickoffDuelTouchTick: number;
  kickoffDuelTouchWinner: string;
  kickoffDuelBenchmarkRunning: boolean;
  kickoffDuelDiagnosticRunning: boolean;
  kickoffDuelLiveBlueSteps: unknown[];
  kickoffDuelLiveOrangeSteps: unknown[];
  demolishRespawnTeam: number;
  demolishRespawnVisualId: string;
  demolishRespawnFreezeTimer: boolean;
  demolishRespawnAutoHoldDemo: boolean;
  demolishRespawnTimerDurationSec: number;
  demolishRespawnSelectedSlot: number;
  demolishRespawnObstacleEnabled: boolean;
  demolishRespawnObstacleSlot: number;
  liveTelemetry: Record<string, unknown>;
  applyAndRestartLab: (tab?: string) => void;
  updateLiveTelemetry: (patch?: Record<string, unknown>) => void;
  setRuntimeHandlers: (handlers: Record<string, unknown>) => void;
  [key: string]: unknown;
}

export interface RewinderStorePortState {
  rewinderState: string;
  currentFrameIndex: number;
  totalFrames: number;
  rewinderDownCounterSec: number;
  rewinderPrerollRemainingSec: number;
  rewinderEffectiveFlowPct: number;
  rewinderWindowOpen: boolean;
  rewinderHasHotkeyPriority: boolean;
  runtimeHandlers: Record<string, (...args: unknown[]) => unknown>;
  updateLiveTelemetry: (patch?: Record<string, unknown>) => void;
  setRuntimeHandlers: (handlers: Record<string, unknown>) => void;
  [key: string]: unknown;
}

export interface ReplayViewerStorePortState {
  viewerState: string;
  currentFrameIndex: number;
  totalFrames: number;
  loadedFileName: string | null;
  downCounterSec: number;
  prerollRemainingSec: number;
  effectiveFlowPct: number;
  isWindowOpen: boolean;
  hasHotkeyPriority: boolean;
  setErrorMessage: (msg: string | null) => void;
  updateLiveTelemetry: (patch?: Record<string, unknown>) => void;
  setRuntimeHandlers: (handlers: Record<string, unknown>) => void;
  [key: string]: unknown;
}

export interface ExpMultiBotsSlotPort {
  isPlayer: boolean;
  botType: string;
  colorSlot: number;
  vehicleId?: string;
  [key: string]: unknown;
}

export interface ExperimentalMultiBotsStorePortState {
  playerParticipation: 'none' | 'blue' | 'orange';
  blueSlots: ExpMultiBotsSlotPort[];
  orangeSlots: ExpMultiBotsSlotPort[];
  activeBotpackShowcaseModel: string | null;
  isExhibitionMode: boolean;
  exhibitionTeamSize: 'solo' | 'double' | 'standard';
  activeCameraCarIndex: number;
  matchDurationSec: number;
  speedMultiplier: number;
  unlimitedBoost: boolean;
  disableGoalReplay: boolean;
  lastTotalInferenceMs: number;
  setIsExhibitionMode: (isExhibition: boolean) => void;
  setActiveCameraCarIndex: (carIndex: number) => void;
  syncExhibitionFromColorPrefs: (triggerRuntime?: boolean) => void;
  updateLiveTelemetry: (patch?: Record<string, unknown>) => void;
  setRuntimeHandlers: (handlers: Record<string, unknown>) => void;
  [key: string]: unknown;
}

export interface ActiveStaticTrainingPackBundlePort {
  uuid: string;
  title: string;
  description: string;
  itemCount: number;
  metadata: StaticTrainingPackMetadata;
  items: StaticTrainingShotItem[];
}

export interface StaticTrainingPackStorePortState {
  initialized: boolean;
  sessionMode: 'browse' | 'play' | 'edit';
  activePack: ActiveStaticTrainingPackBundlePort | null;
  activeItems: StaticTrainingShotItem[];
  currentShotIndex: number;
  isEditingItem: boolean;
  editSubMode: EditSubMode;
  downCounterEnabled: boolean;
  downCounterValue: number;
  remainingTimeoutSec: number;
  replayType: string;
  liveTelemetry: { replayType?: string | null; [key: string]: unknown };
  initStore: () => Promise<void>;
  nextShot: () => void;
  prevShot: () => void;
  cycleEditSubMode: (dir?: number) => void;
  enterItemEditMode: (shotIndex?: number) => void;
  setTestingSingleShot: (testing: boolean) => void;
  setFreeCamTrajectoryTesting: (testing: boolean) => void;
  updateLiveTelemetry: (patch?: Record<string, unknown>) => void;
  setRuntimeHandlers: (handlers: Record<string, unknown>) => void;
  [key: string]: unknown;
}

export interface StaticTrainingBallCamTunerStorePortState {
  distance: number;
  height: number;
  angle: number;
  lateralOffset: number;
  editBallOpacity: number;
  enableEditOpacityOverride: boolean;
  switchLateralSide: () => void;
  [key: string]: unknown;
}

export interface KickoffTrainingStorePortState {
  subMode: 'instant' | 'easy-learning' | 'realistic';
  spawnIndex: number;
  effectivePhysicsRate: number;
  realisticWaitTicks: number;
  ghostPlacement: 'same' | 'opposite';
  ghostModeEnabled: boolean;
  showGhostCar: boolean;
  showGhostBall: boolean;
  resetToEntryDefaults: () => void;
  updateLiveState: (patch?: Record<string, unknown>) => void;
  setRuntimeHandlers: (handlers: Record<string, unknown>) => void;
  [key: string]: unknown;
}

export interface ReferenceOverlayStorePortState {
  enabled: boolean;
  cameraLookPreset: string;
  cameraLookStrength: number;
  cameraLookHorizontalStrength: number;
  cameraLookVerticalStrength: number;
  cameraLookXOverride: number;
  cameraLookYOverride: number;
  rearViewOverride: boolean;
  [key: string]: unknown;
}

export interface QuickNotificationTaskItemPort {
  id: string;
  [key: string]: unknown;
}

export interface QuickNotificationStorePortState {
  ongoingTasks: QuickNotificationTaskItemPort[];
  pushNotification: (config?: Record<string, unknown>) => string | void;
  dismissNotification: (id?: string) => void;
  pushOngoingNotification: (config?: Record<string, unknown>) => string;
  updateOngoingNotification: (
    idOrUpdates: string | Record<string, unknown>,
    updates?: Record<string, unknown>,
  ) => void;
  dismissOngoingNotification: (id?: string) => void;
  completeOngoingNotification: (id?: string, summary?: unknown) => void;
  [key: string]: unknown;
}

export interface NetworkDiagnosticsMetricsPort {
  extraLatencyMs?: number;
  extraUplinkMs?: number;
  extraDownlinkMs?: number;
  adjustStepMs?: number;
  disconnectEvicted?: boolean;
  corrections?: number;
  mispredictions?: number;
  lastErrorUu?: number;
  maxErrorUu?: number;
  rttMs?: number;
  jitterMs?: number;
  inputBufferDepth?: number;
  [key: string]: unknown;
}

export interface NetworkDiagnosticsSnapshotPort {
  metrics?: NetworkDiagnosticsMetricsPort;
  [key: string]: unknown;
}

export interface NetworkDiagnosticsStoreMethods {
  setSession(reconciler: unknown, channel?: unknown, runtime?: unknown): void;
  toggleBurstDrop(): void;
  setExtraLatency?(latencyMs: number): void;
  setTestCarAudioEnabled?(enabled: boolean): void;
  setLobbyGhostMode?(enabled: boolean): void;
  syncZeroGFleetState(enabled: boolean): void;
  registerBridge?(bridge: Record<string, unknown>): void;
  updateDiagnosticBuffers?(snapshot: Record<string, unknown>): void;
}

export type NameTagRuntimeCarEntryPort = NameTagCarEntry & {
  username?: string;
  isLocalPlayer?: boolean;
};

export type NameTagRuntimeStatePort = Omit<NameTagRuntimeState, 'carEntries'> & {
  carEntries: NameTagRuntimeCarEntryPort[];
};

export interface ReplayTimelineControllerPort {
  ActiveWindowCount: number;
  sessionState?: Partial<ReplaySessionState>;
  directorCameraState?: DirectorCameraState;
  progress?: number;
  currentFrameIndex?: number;
  getTotalRecordedFrames?: () => number;
  togglePause?: () => boolean;
  cyclePlaybackSpeed?: () => number;
  seekToNormalized?: (progress01: number, interpolator?: unknown) => void;
  replanDirectorCameraTrajectory?: () => void;
  applyFrameToEngine?: (frameIndex: number, interpolator?: unknown) => void;
  getFrameBufferByIndex?: (frameIndex: number) => Float32Array | null;
  getFrameEntryByIndex?: (frameIndex: number) => unknown;
}

export type StoreListener<T = Record<string, unknown>> = (state: T, prevState: T) => void;

export interface StoreBoundTarget<T> {
  getState?: () => T;
  getSnapshot?: () => T;
  setState?: (
    partial: Partial<T> | Record<string, unknown> | ((state: T) => Partial<T> | Record<string, unknown>),
    replace?: boolean,
  ) => T;
  subscribe?: (listener: StoreListener<T>) => () => boolean | void;
  [key: string]: unknown;
}

export type StoreProxy<T extends object, M extends object = Record<string, never>> = {
  _bind(store: unknown): void;
  getState(): T;
  setState(
    partial: Partial<T> | Record<string, unknown> | ((state: T) => Partial<T> | Record<string, unknown>),
    replace?: boolean,
  ): T;
  subscribe(listener: StoreListener<T>): () => boolean | void;
  getSnapshot(): T;
} & M;

export interface PendingSubscriberEntry<T> {
  listener: StoreListener<T>;
  unsub: (() => boolean | void) | null;
}

export interface FloatingWindowEntryPort {
  id: string;
  minimized?: boolean;
  [key: string]: unknown;
}

export interface FloatingStoreSnapshotPort {
  windows: FloatingWindowEntryPort[];
  activeFlight?: { preset?: { id?: string } } | null;
  [key: string]: unknown;
}

export interface FloatingStorePort {
  _bound: {
    getSnapshot(): FloatingStoreSnapshotPort;
    subscribe(listener: StoreListener<FloatingStoreSnapshotPort>): () => boolean | void;
    openWindow?(id: string): unknown;
    closeWindow?(id: string): unknown;
    toggleWindow?(id: string): unknown;
    spawnWindow?(preset: Record<string, unknown>): unknown;
    setOpacity?(opacity: number): void;
    triggerBatchMinimize?(minimize?: boolean): void;
  } | null;
  _pendingSubscribers: Set<PendingSubscriberEntry<FloatingStoreSnapshotPort>>;
  _bind(store: unknown): void;
  getSnapshot(): FloatingStoreSnapshotPort;
  subscribe(listener: StoreListener<FloatingStoreSnapshotPort>): () => boolean | void;
  openWindow(id: string): unknown;
  closeWindow(id: string): unknown;
  toggleWindow(id: string): unknown;
}

export interface PacingTelemetryRecorderPort {
  count: number;
  reset?(config?: Record<string, unknown>): void;
  recordTick?(sample: Record<string, unknown>): void;
  getSummaryStats?(): {
    starvationCount?: number;
    hardResyncCount?: number;
    [key: string]: unknown;
  };
  toMetadataObject?(): Record<string, unknown>;
  toCsvString?(): string;
  [key: string]: unknown;
}

export interface HudTransientChannelPort {
  setRoster(patch: Record<string, unknown>): void;
  setMiniMap?(patch: unknown): void;
  [key: string]: unknown;
}

