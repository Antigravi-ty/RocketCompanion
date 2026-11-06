/**
 * runtimeUiPort.ts
 * Engine-owned dependency-inversion port for UI store telemetry, notifications,
 * active session hooks, and domain-partitioned GameRuntime -> UI bridge ports
 * (`cameraPort`, `matchPort`, `tunerPort`, `replayPort`).
 */

import { DEFAULT_NAME_TAG_CONFIG } from '../ui-core/config/nameTagConfig';
import type {
  AppStorePortState,
  BgmTrackEntryPort,
  ExperimentalMultiBotsStorePortState,
  FloatingStorePort,
  FloatingStoreSnapshotPort,
  HudStorePortState,
  HudTransientChannelPort,
  KickoffTrainingStorePortState,
  NameTagConfig,
  NameTagRuntimeStatePort,
  NameTagTelemetrySnapshot,
  NetworkDiagnosticsSnapshotPort,
  NetworkDiagnosticsStoreMethods,
  PacingTelemetryRecorderPort,
  PendingSubscriberEntry,
  QuickNotificationStorePortState,
  ReferenceOverlayStorePortState,
  ReplayTimelineControllerPort,
  ReplayViewerStorePortState,
  RewinderStorePortState,
  SpatialAudioStorePortState,
  StaticTrainingBallCamTunerStorePortState,
  StaticTrainingPackStorePortState,
  StaticTrainingShotItem,
  StoreBoundTarget,
  StoreListener,
  StoreProxy,
  SubsystemIsolationLabStorePortState,
} from './runtimeUiStorePortTypes.ts';

export type * from './runtimeUiStorePortTypes.ts';
export type * from './runtimeDomainPortTypes.ts';

function createStoreProxy<
  T extends object,
  M extends object = Record<string, never>,
>(initialFallback: Partial<T> = {}, extraMethods: M = {} as M): StoreProxy<T, M> {
  let boundStore: StoreBoundTarget<T> | null = null;
  const pendingSubscribers = new Set<PendingSubscriberEntry<T>>();
  const pendingMethodCalls: Array<[string, unknown[]]> = [];
  let fallbackState: Record<string, unknown> = {
    ...(initialFallback as Record<string, unknown>),
    registerRuntimeCallbacks(callbacks: unknown) {
      pendingMethodCalls.push(['registerRuntimeCallbacks', [callbacks]]);
    },
    setRuntimeHandlers(handlers: unknown) {
      pendingMethodCalls.push(['setRuntimeHandlers', [handlers]]);
    },
  };

  const proxyRecord: Record<string, unknown> = {
    ...extraMethods,
    _bind(store: unknown) {
      if (boundStore === store) return;
      boundStore = (store as StoreBoundTarget<T>) ?? null;
      if (boundStore && (typeof boundStore === 'object' || typeof boundStore === 'function')) {
        for (const [k, v] of Object.entries(boundStore)) {
          if (typeof v === 'function' && !(k in proxyRecord)) {
            proxyRecord[k] = (...args: unknown[]) => {
              const fn = boundStore?.[k];
              return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
            };
          }
        }
        for (const k of Object.keys(extraMethods)) {
          if (typeof boundStore[k] === 'function') {
            proxyRecord[k] = (...args: unknown[]) => {
              const fn = boundStore?.[k];
              return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
            };
          }
        }
        const liveState =
          typeof boundStore.getState === 'function'
            ? (boundStore.getState() as Record<string, unknown>)
            : typeof boundStore.getSnapshot === 'function'
              ? (boundStore.getSnapshot() as Record<string, unknown>)
              : null;
        if (liveState && pendingMethodCalls.length > 0) {
          for (const [methodName, args] of pendingMethodCalls.splice(0)) {
            const targetFn = liveState[methodName];
            if (typeof targetFn === 'function') {
              (targetFn as (...a: unknown[]) => unknown)(...args);
            }
          }
        }
        if (typeof boundStore.subscribe === 'function' && pendingSubscribers.size > 0) {
          for (const entry of pendingSubscribers) {
            entry.unsub = boundStore.subscribe(entry.listener);
            if (liveState !== null) {
              try {
                entry.listener(liveState as unknown as T, liveState as unknown as T);
              } catch {
                // Ignore listener sync errors during initial port binding
              }
            }
          }
          pendingSubscribers.clear();
        }
      }
    },
    getState(): T {
      if (!boundStore) return fallbackState as unknown as T;
      if (typeof boundStore.getState === 'function') return boundStore.getState();
      if (typeof boundStore.getSnapshot === 'function') return boundStore.getSnapshot();
      return fallbackState as unknown as T;
    },
    setState(
      partial: Partial<T> | Record<string, unknown> | ((state: T) => Partial<T> | Record<string, unknown>),
      replace?: boolean,
    ): T {
      if (boundStore && typeof boundStore.setState === 'function') {
        return boundStore.setState(partial, replace);
      }
      if (typeof partial === 'function') {
        fallbackState = { ...fallbackState, ...partial(fallbackState as unknown as T) };
      } else if (partial && typeof partial === 'object') {
        fallbackState = replace ? { ...partial } : { ...fallbackState, ...partial };
      }
      return fallbackState as unknown as T;
    },
    subscribe(listener: StoreListener<T>): () => boolean | void {
      if (typeof listener !== 'function') return () => false;
      if (boundStore && typeof boundStore.subscribe === 'function') {
        return boundStore.subscribe(listener);
      }
      const entry: PendingSubscriberEntry<T> = { listener, unsub: null };
      pendingSubscribers.add(entry);
      return () => {
        pendingSubscribers.delete(entry);
        return typeof entry.unsub === 'function' ? entry.unsub() : false;
      };
    },
    getSnapshot(): T {
      if (boundStore && typeof boundStore.getSnapshot === 'function') {
        return boundStore.getSnapshot();
      }
      return (boundStore && typeof boundStore.getState === 'function'
        ? boundStore.getState()
        : fallbackState) as unknown as T;
    },
  };
  return proxyRecord as unknown as StoreProxy<T, M>;
}

export const useAppStore = createStoreProxy<AppStorePortState>({
  isMenuOpen: false, isOpen: false, activeRoute: 'main-menu', matchMode: 'freeplay',
  cameraMode: 'ball', isFreeCam: false, freeCamFov: 110, touchMode: false,
  touchHeadlessMode: false, touchInputAgent: false,
  onlineSession: { role: 'none', status: 'idle', peers: [] },
});

export const useHudStore = createStoreProxy<HudStorePortState>({
  matchPhase: 'PLAYING', replayProgress: 0, scoreBlue: 0, scoreOrange: 0,
  localTeam: 0, boost: 33, speedKph: 0, setMatchState: () => {},
  setReplayState: () => {}, clearReplayState: () => {},
});
export const hudStore = useHudStore;

export const useSpatialAudioStore = createStoreProxy<SpatialAudioStorePortState>({
  selectedAnthem: 'MX_CelebrationStadium_Stingers_0001',
  randomAnthemScope: 'all', randomAnthemCategory: 'TrainStation',
  isGarageAnthemTabActive: false, previewingAnthemId: null, previewSource: null,
  activeGoalAnthemId: null, anthemLinearPhase: 0, anthemBlend: 0, isGoalReplaySkipped: false,
  bgmEnabled: false, bgmVolume: 75,
  bgmScenes: { freePlay: true, singlePlayerTraining: true, multiplayerTraining: false, match: false },
  realisticBgmEnabled: true, bgmCategorizedMode: true, bgmDeselectedVolumes: [],
  bgmDeselectedTrackNames: [], bgmTracks: [], bgmVolumes: [], bgmCurrentTrackId: null,
  bgmCurrentTrackTitle: null, bgmIsPlaying: false, bgmLinearPhase: 1, bgmBlend: 1, tunerConfig: {},
  setGoalReplaySkipped: () => {}, setActiveGoalAnthemId: () => {}, setPreviewingAnthemId: () => {},
  setAnthemTransitionState: () => {}, setBgmPlaybackState: () => {}, setBgmTransitionState: () => {},
});

export const useSubsystemIsolationLabStore = createStoreProxy<SubsystemIsolationLabStorePortState>({
  activePresetId: 'default', liveTelemetry: {}, updateLiveTelemetry: () => {},
});

export const useRewinderStore = createStoreProxy<RewinderStorePortState>({
  rewinderState: 'idle', currentFrameIndex: 0, totalFrames: 0,
});

export const useReplayViewerStore = createStoreProxy<ReplayViewerStorePortState>({
  viewerState: 'idle', currentFrameIndex: 0, totalFrames: 0,
});

export const useExperimentalMultiBotsStore = createStoreProxy<ExperimentalMultiBotsStorePortState>({});
export const useStaticTrainingPackStore = createStoreProxy<StaticTrainingPackStorePortState>({
  liveTelemetry: {},
});
export const DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG = {
  fov: 110,
  distance: 330,
  height: 400,
  angle: -45,
  lateralOffset: 150,
  editBallOpacity: 0.7,
  enableEditOpacityOverride: true,
  expiredBallOpacity: 0.7,
  arrowOpacity: 0.78,
  shadowOpacity: 0.52,
  shadowScale: 1.18,
  haloScale: 95,
  coneRadius: 20,
  coneLength: 58,
  tipRadius: 2.5,
  shaftRadius: 7.0,
  arrowBaseLength: 155,
  arrowMaxExtraLength: 300,
  arrowHeightOffset: 32,
  arrowForwardOffset: 18,
};
export const useStaticTrainingBallCamTunerStore =
  createStoreProxy<StaticTrainingBallCamTunerStorePortState>(
    DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG,
  );
export const useKickoffTrainingStore = createStoreProxy<KickoffTrainingStorePortState>({});
export const useReferenceOverlayStore = createStoreProxy<ReferenceOverlayStorePortState>({});
export const useNameTagTunerStore = createStoreProxy<Record<string, unknown>>({});
export const useQuickNotificationStore = createStoreProxy<QuickNotificationStorePortState>({
  pushNotification: () => {}, dismissNotification: () => {},
});

export const networkDiagnosticsStore = createStoreProxy<
  NetworkDiagnosticsSnapshotPort,
  NetworkDiagnosticsStoreMethods
>(
  {},
  {
    setSession: () => {}, toggleBurstDrop: () => {}, setExtraLatency: () => {},
    setTestCarAudioEnabled: () => {}, setLobbyGhostMode: () => {},
    syncZeroGFleetState: () => {}, registerBridge: () => {}, updateDiagnosticBuffers: () => {},
  },
);

export const determinismStore = createStoreProxy<
  Record<string, unknown>,
  { setHarness(harness: unknown): void }
>({}, { setHarness: () => {} });

export const eventStreamStore = createStoreProxy<
  Record<string, unknown>,
  { addEvent(event: Record<string, unknown>): void }
>({}, { addEvent: () => {} });

export const reachabilityStore = createStoreProxy<
  Record<string, unknown>,
  { getConfig(): Record<string, unknown>; publishTelemetry(telemetry: unknown): void }
>({}, { getConfig: () => ({}), publishTelemetry: () => {} });

export const ballTrajectoryTunerStore = createStoreProxy<
  Record<string, unknown>,
  {
    publishTelemetry(telemetry: unknown): void;
    resetTelemetryCounters(): void;
    getNotifyAnomalyAlerts(): boolean;
    registerAnomalyHandlers(handlers: {
      exportJson: (includeAll?: boolean) => void;
      copyJson: (includeAll?: boolean) => Promise<boolean>;
      resetAndArmNext: () => void;
      clearSamples: () => void;
    } | null): void;
  }
>(
  {},
  {
    publishTelemetry: () => {},
    resetTelemetryCounters: () => {},
    getNotifyAnomalyAlerts: () => true,
    registerAnomalyHandlers: () => {},
  },
);

export const floatingStore: FloatingStorePort = {
  _bound: null,
  _pendingSubscribers: new Set(),
  _bind(store: unknown) {
    this._bound = (store as FloatingStorePort['_bound']) ?? null;
    if (this._bound && typeof this._bound.subscribe === 'function' && this._pendingSubscribers.size > 0) {
      for (const entry of this._pendingSubscribers) {
        entry.unsub = this._bound.subscribe(entry.listener);
      }
      this._pendingSubscribers.clear();
    }
  },
  getSnapshot() {
    return this._bound ? this._bound.getSnapshot() : { windows: [] };
  },
  subscribe(listener) {
    if (typeof listener !== 'function') return () => false;
    if (this._bound) return this._bound.subscribe(listener);
    const entry: PendingSubscriberEntry<FloatingStoreSnapshotPort> = { listener, unsub: null };
    this._pendingSubscribers.add(entry);
    return () => {
      this._pendingSubscribers.delete(entry);
      return typeof entry.unsub === 'function' ? entry.unsub() : false;
    };
  },
  openWindow(id: string) { return this._bound?.openWindow?.(id); },
  closeWindow(id: string) { return this._bound?.closeWindow?.(id); },
  toggleWindow(id: string) { return this._bound?.toggleWindow?.(id); },
};

export let DUAL_ARENA_DETERMINISM_HARNESS_PRESET: Record<string, unknown> = { id: 'dual-arena-harness' };
export let NETWORK_MONITOR_PRESET: Record<string, unknown> = { id: 'network-monitor' };
export let globalPacingTelemetryRecorder: PacingTelemetryRecorderPort | null = null;
export let globalHudTransientChannel: HudTransientChannelPort = {
  setRoster: () => {}, setMiniMap: () => {},
};
export let quickNotification: {
  info: (msg: string, opts?: Record<string, unknown>) => void;
  success: (msg: string, opts?: Record<string, unknown>) => void;
  warning: (msg: string, opts?: Record<string, unknown>) => void;
  error: (msg: string, opts?: Record<string, unknown>) => void;
} = { info: () => {}, success: () => {}, warning: () => {}, error: () => {} };

const _pendingHandlerRegistrations: {
  registerReplayDirectorDiagnosticExporter: [unknown, unknown, unknown, unknown] | null;
  registerReplayDirectorPreviewHandlers: Record<string, unknown> | null;
} = {
  registerReplayDirectorDiagnosticExporter: null,
  registerReplayDirectorPreviewHandlers: null,
};

type PortHandlerFn = (...args: unknown[]) => unknown;

const _handlers: Record<string, PortHandlerFn | null> = {
  markReplayTimelineControllerRetained: null,
  getLatestRetainedReplayTimelineController: null,
  notifyActiveReplayTimelineController: null,
  setActiveReplayTimelineController: null,
  getActiveReplayTimelineController: null,
  subscribeActiveReplayTimelineController: null,
  registerReplayDirectorDiagnosticExporter: null,
  registerReplayDirectorPreviewHandlers: null,
  getNameTagConfig: null,
  subscribeNameTagConfig: null,
  getNameTagRuntimeState: null,
  setNameTagRuntimeState: null,
  setNameTagTelemetrySnapshot: null,
  getNameTagTelemetrySnapshot: null,
  getActiveEditItemVariable: null,
  mutateActiveEditItemVariable: null,
  getFilteredBgmTracks: null,
  getExpColorSwatch: null,
  toggleFloatingPreset: null,
  snapshotCurrentTelemetryPayload: null,
  notifyNetworkTelemetryExportAvailable: null,
  pushQuickNotification: null,
  dismissQuickNotification: null,
  pushOngoingNotification: null,
  dismissOngoingNotification: null,
  completeOngoingNotification: null,
};

export function bindRuntimeUiPort(port: Record<string, unknown> = {}): void {
  const storeBindings: Array<[string, { _bind(s: unknown): void }]> = [
    ['useAppStore', useAppStore],
    ['useHudStore', useHudStore],
    ['hudStore', hudStore],
    ['useSpatialAudioStore', useSpatialAudioStore],
    ['useSubsystemIsolationLabStore', useSubsystemIsolationLabStore],
    ['useRewinderStore', useRewinderStore],
    ['useReplayViewerStore', useReplayViewerStore],
    ['useExperimentalMultiBotsStore', useExperimentalMultiBotsStore],
    ['useStaticTrainingPackStore', useStaticTrainingPackStore],
    ['useStaticTrainingBallCamTunerStore', useStaticTrainingBallCamTunerStore],
    ['useKickoffTrainingStore', useKickoffTrainingStore],
    ['useReferenceOverlayStore', useReferenceOverlayStore],
    ['useNameTagTunerStore', useNameTagTunerStore],
    ['useQuickNotificationStore', useQuickNotificationStore],
    ['networkDiagnosticsStore', networkDiagnosticsStore],
    ['determinismStore', determinismStore],
    ['eventStreamStore', eventStreamStore],
    ['reachabilityStore', reachabilityStore],
    ['ballTrajectoryTunerStore', ballTrajectoryTunerStore],
    ['floatingStore', floatingStore],
  ];
  for (const [key, target] of storeBindings) {
    if (port[key]) target._bind(port[key]);
  }
  if (port.DUAL_ARENA_DETERMINISM_HARNESS_PRESET) {
    DUAL_ARENA_DETERMINISM_HARNESS_PRESET = port.DUAL_ARENA_DETERMINISM_HARNESS_PRESET as Record<string, unknown>;
  }
  if (port.NETWORK_MONITOR_PRESET) {
    NETWORK_MONITOR_PRESET = port.NETWORK_MONITOR_PRESET as Record<string, unknown>;
  }
  if (port.globalPacingTelemetryRecorder) {
    globalPacingTelemetryRecorder = port.globalPacingTelemetryRecorder as PacingTelemetryRecorderPort;
  }
  if (port.globalHudTransientChannel) {
    globalHudTransientChannel = port.globalHudTransientChannel as HudTransientChannelPort;
  }
  if (port.quickNotification) {
    quickNotification = port.quickNotification as typeof quickNotification;
  }

  for (const key of Object.keys(_handlers)) {
    if (typeof port[key] === 'function') _handlers[key] = port[key] as PortHandlerFn;
  }

  if (
    _pendingHandlerRegistrations.registerReplayDirectorDiagnosticExporter &&
    typeof _handlers.registerReplayDirectorDiagnosticExporter === 'function'
  ) {
    _handlers.registerReplayDirectorDiagnosticExporter(
      ..._pendingHandlerRegistrations.registerReplayDirectorDiagnosticExporter,
    );
    _pendingHandlerRegistrations.registerReplayDirectorDiagnosticExporter = null;
  }
  if (
    _pendingHandlerRegistrations.registerReplayDirectorPreviewHandlers &&
    typeof _handlers.registerReplayDirectorPreviewHandlers === 'function'
  ) {
    _handlers.registerReplayDirectorPreviewHandlers(
      _pendingHandlerRegistrations.registerReplayDirectorPreviewHandlers,
    );
    _pendingHandlerRegistrations.registerReplayDirectorPreviewHandlers = null;
  }
}

export function markReplayTimelineControllerRetained(ctrl: unknown): number {
  return (_handlers.markReplayTimelineControllerRetained?.(ctrl) as number | undefined) ?? 0;
}
export function getLatestRetainedReplayTimelineController(): ReplayTimelineControllerPort | null {
  return (_handlers.getLatestRetainedReplayTimelineController?.() as ReplayTimelineControllerPort | null) ?? null;
}
export function notifyActiveReplayTimelineController(): void {
  _handlers.notifyActiveReplayTimelineController?.();
}
export function setActiveReplayTimelineController(ctrl: unknown): void {
  _handlers.setActiveReplayTimelineController?.(ctrl);
}
export function getActiveReplayTimelineController(): ReplayTimelineControllerPort | null {
  return (_handlers.getActiveReplayTimelineController?.() as ReplayTimelineControllerPort | null) ?? null;
}
export function subscribeActiveReplayTimelineController(
  listener: (...args: unknown[]) => void,
): () => boolean | void {
  return (
    (_handlers.subscribeActiveReplayTimelineController?.(listener) as (() => boolean | void) | undefined) ??
    (() => false)
  );
}

export function registerReplayDirectorDiagnosticExporter(
  exporterFn: unknown,
  parserFn: unknown = null,
  windowBuilderFn: unknown = null,
  referenceKeyframeExporterFn: unknown = null,
): void {
  if (typeof _handlers.registerReplayDirectorDiagnosticExporter === 'function') {
    _handlers.registerReplayDirectorDiagnosticExporter(
      exporterFn, parserFn, windowBuilderFn, referenceKeyframeExporterFn,
    );
  } else {
    _pendingHandlerRegistrations.registerReplayDirectorDiagnosticExporter = [
      exporterFn, parserFn, windowBuilderFn, referenceKeyframeExporterFn,
    ];
  }
}

export function registerReplayDirectorPreviewHandlers(handlers: Record<string, unknown> = {}): void {
  if (typeof _handlers.registerReplayDirectorPreviewHandlers === 'function') {
    _handlers.registerReplayDirectorPreviewHandlers(handlers);
  } else {
    _pendingHandlerRegistrations.registerReplayDirectorPreviewHandlers = handlers;
  }
}

export function getNameTagConfig(): NameTagConfig {
  return (_handlers.getNameTagConfig?.() as NameTagConfig | undefined) ?? DEFAULT_NAME_TAG_CONFIG;
}

export function subscribeNameTagConfig(listener: () => void): () => void {
  return (
    (_handlers.subscribeNameTagConfig?.(listener) as (() => void) | undefined) ??
    (() => {})
  );
}

export function getNameTagRuntimeState(): NameTagRuntimeStatePort {
  return (
    (_handlers.getNameTagRuntimeState?.() as NameTagRuntimeStatePort | undefined) ?? {
      isTunerArenaActive: false, isMultiplayerOrMultiCarMode: false, kickoffPermutationIndex: 0,
      activeCameraMode: 'pov', focusedCarIndex: 0, selectedCalibrationCarIndex: 0, carEntries: [],
      boostBorderOverride: null, onEnterTunerArena: null, onExitTunerArena: null,
      onReshuffleKickoffPositions: null, onSelectPovCar: null, onFocusFreeCamOverview: null,
    }
  );
}

export function setNameTagRuntimeState(
  patch: Partial<NameTagRuntimeStatePort> | Record<string, unknown>,
): unknown {
  return _handlers.setNameTagRuntimeState?.(patch);
}
export function setNameTagTelemetrySnapshot(snapshot: NameTagTelemetrySnapshot | Record<string, unknown>): void {
  _handlers.setNameTagTelemetrySnapshot?.(snapshot);
}
export function getNameTagTelemetrySnapshot(): NameTagTelemetrySnapshot | null {
  return (_handlers.getNameTagTelemetrySnapshot?.() as NameTagTelemetrySnapshot | null) ?? null;
}
export function getActiveEditItemVariable(): StaticTrainingShotItem | null {
  return (_handlers.getActiveEditItemVariable?.() as StaticTrainingShotItem | null) ?? null;
}
export function mutateActiveEditItemVariable(...args: unknown[]): StaticTrainingShotItem | null {
  return (_handlers.mutateActiveEditItemVariable?.(...args) as StaticTrainingShotItem | null) ?? null;
}
export function getFilteredBgmTracks(state?: unknown): BgmTrackEntryPort[] {
  return (_handlers.getFilteredBgmTracks?.(state) as BgmTrackEntryPort[] | undefined) ?? [];
}
export function getExpColorSwatch(
  slot: number,
): { id: number; hex: string; name: string; [key: string]: unknown } {
  return (
    (_handlers.getExpColorSwatch?.(slot) as
      | { id: number; hex: string; name: string; [key: string]: unknown }
      | undefined) ?? { id: slot, hex: '#38bdf8', name: 'Blue' }
  );
}
export function toggleFloatingPreset(preset: unknown): unknown {
  return _handlers.toggleFloatingPreset?.(preset);
}
export function snapshotCurrentTelemetryPayload(...args: unknown[]): Record<string, unknown> | null {
  return (_handlers.snapshotCurrentTelemetryPayload?.(...args) as Record<string, unknown> | null) ?? null;
}
export function notifyNetworkTelemetryExportAvailable(...args: unknown[]): unknown {
  return _handlers.notifyNetworkTelemetryExportAvailable?.(...args);
}
export function pushQuickNotification(config: Record<string, unknown>): unknown {
  return _handlers.pushQuickNotification?.(config);
}
export function dismissQuickNotification(id: string): unknown {
  return _handlers.dismissQuickNotification?.(id);
}
export function pushOngoingNotification(config: Record<string, unknown>): unknown {
  return _handlers.pushOngoingNotification?.(config);
}
export function dismissOngoingNotification(id: string): unknown {
  return _handlers.dismissOngoingNotification?.(id);
}
export function completeOngoingNotification(...args: unknown[]): unknown {
  return _handlers.completeOngoingNotification?.(...args);
}
