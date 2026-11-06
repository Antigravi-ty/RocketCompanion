import './runtimeEngineUiPort';
import { useAppStore } from '../../ui-core/stores/appStore';
import type { AppState } from '../../ui-core/stores/appStoreTypes';
import { perfTelemetryStore } from '../../ui-core/stores/perfTelemetryStore';
import { hudStore } from '../../ui-core/stores/hudStore';
import { floatingStore } from '../../ui-core/stores/floatingStore';
import { useRewinderStore } from '../../ui-core/stores/rewinderStore';
import { useReplayViewerStore } from '../../ui-core/stores/replayViewerStore';
import { loadInputBindings } from '../../ui-core/config/inputBindings';
import {
  getPreferredColorHex,
  getPreferredFreeplayTeam,
} from '../../ui-core/config/vehiclePresets';
import { createOnlineBridgeHandlers } from './runtimeOnlineBridgeHandlers';
import { createModeBridgeHandlers } from './runtimeModeBridgeHandlers';
import { createTunerBridgeHandlers, syncMaterialsToGame } from './runtimeTunerBridgeHandlers';
import { cameraDeterminismStore } from '../../ui-core/stores/cameraDeterminismStore';
import { getCameraDeterminismHarness } from '../../camera/CameraDeterminismHarness.ts';
import { useQuickNotificationStore } from '../../ui-core/stores/quickNotificationStore';
import type { QuickNotificationPushOptions as QuickNotificationInput } from '../../ui-core/stores/notificationTypes';
import { setPacingTelemetryNotificationHandler } from '../../ui-core/stores/pacingTelemetryExporter';
import { useGoalBarrierStore } from '../../ui-core/stores/goalBarrierStore';
import { buildGoalBarrierCmfChunks } from '../../ui-core/config/goalBarrierConfig';
import { syncRuntimeNetworkDiagnostics } from './runtimeNetworkDiagnosticsBridge';
import type {
  GameRuntimeUiBridgePort,
  GoalBarrierDecompositionPort,
} from '../../game/runtimeUiPort.ts';

let goalBarrierUnsubscribe: (() => void) | null = null;
let floatingFlagsUnsubscribe: (() => void) | null = null;
let modeScopeUnsubscribe: (() => void) | null = null;
let lastSyncedBarrierMeshKey = '';

function syncFloatingWindowFlags(): void {
  const snap = floatingStore.getSnapshot();
  const rewinderWin = snap.windows.find((w) => w.id === 'rewinder-configurator');
  const viewerWin = snap.windows.find((w) => w.id === 'replay-viewer');
  const rewinderIdx = rewinderWin ? snap.windows.indexOf(rewinderWin) : -1;
  const viewerIdx = viewerWin ? snap.windows.indexOf(viewerWin) : -1;
  const rewinderOpen = Boolean(rewinderWin);
  const viewerOpen = Boolean(viewerWin);
  const rewinderHasPriority = rewinderOpen && (!viewerOpen || rewinderIdx < viewerIdx);
  const viewerHasPriority = viewerOpen && (!rewinderOpen || viewerIdx < rewinderIdx);

  const rewinderState = useRewinderStore.getState();
  if (
    rewinderState.rewinderWindowOpen !== rewinderOpen ||
    rewinderState.rewinderHasHotkeyPriority !== rewinderHasPriority
  ) {
    useRewinderStore.setState({
      rewinderWindowOpen: rewinderOpen,
      rewinderHasHotkeyPriority: rewinderHasPriority,
    });
  }
  const rvState = useReplayViewerStore.getState();
  if (rvState.isWindowOpen !== viewerOpen || rvState.hasHotkeyPriority !== viewerHasPriority) {
    useReplayViewerStore.setState({
      isWindowOpen: viewerOpen,
      hasHotkeyPriority: viewerHasPriority,
    });
  }

  const replayDirectorTunerOpen = snap.windows.some((w) => w.id === 'replay-director-tuner');
  const hud = hudStore.getState();
  if (!replayDirectorTunerOpen && hud.matchPhase === 'replay' && hud.replayPaused) {
    hud.onReplayTogglePause?.();
  }
}

export function syncGoalBarrierToGame(
  runtimePort: GameRuntimeUiBridgePort | null | undefined,
): void {
  if (!runtimePort) return;
  const gbState = useGoalBarrierStore.getState();
  const { enabled, targetGoal, opacity, decomposition } = gbState;

  const rectsKey = enabled
    ? `${targetGoal}:${decomposition.mergedRects
        .map((r) => `${r.u0},${r.v0},${r.u1},${r.v1}`)
        .join(';')}`
    : 'disabled';

  const updatePhysicsChunks = rectsKey !== lastSyncedBarrierMeshKey;
  let chunks: unknown = null;
  if (updatePhysicsChunks) {
    lastSyncedBarrierMeshKey = rectsKey;
    chunks = buildGoalBarrierCmfChunks(decomposition, targetGoal, enabled);
  }

  runtimePort.tunerPort.syncGoalBarrier(
    decomposition as unknown as GoalBarrierDecompositionPort,
    targetGoal,
    enabled,
    opacity,
    chunks,
    updatePhysicsChunks,
  );
}

export { syncMaterialsToGame };

export function attachGameRuntimeBridge(
  runtimePort: GameRuntimeUiBridgePort | null | undefined,
): void {
  if (!runtimePort) return;
  const { cameraPort, matchPort, tunerPort } = runtimePort;

  cameraDeterminismStore.setHarness(getCameraDeterminismHarness());
  syncRuntimeNetworkDiagnostics(runtimePort);
  setPacingTelemetryNotificationHandler((notification) => {
    useQuickNotificationStore
      .getState()
      .pushNotification(notification as unknown as QuickNotificationInput);
  });

  syncFloatingWindowFlags();
  if (floatingFlagsUnsubscribe) {
    floatingFlagsUnsubscribe();
  }
  floatingFlagsUnsubscribe = floatingStore.subscribe(syncFloatingWindowFlags);

  perfTelemetryStore.setSampler(tunerPort.createPerfTelemetrySampler());

  const appState = useAppStore.getState();
  matchPort.syncInitialClockPacing({
    clockPacingMode: appState.clockPacingMode,
    clockPacingPriority: appState.clockPacingPriority,
    inputBufferTarget: appState.inputBufferTarget,
    inputBufferThreshold: appState.inputBufferThreshold,
    customClockPacingParams: appState.customClockPacingParams as unknown as Record<
      string,
      unknown
    > | null,
  });

  const currentCar = tunerPort.getInitialVehiclePreset() || appState.activeCar;
  if (currentCar) {
    useAppStore.setState({ activeCar: currentCar as AppState['activeCar'] });
  }

  const currentMode = matchPort.getMatchMode();
  if (currentMode) {
    useAppStore.setState({ matchMode: currentMode as AppState['matchMode'] });
  }

  try {
    const targetHex = getPreferredColorHex();
    const freeplayTeam = getPreferredFreeplayTeam();
    tunerPort.syncInitialFreeplayTeamAndColor(targetHex, freeplayTeam);
  } catch (err) {
    console.warn('[mountGameUI] Failed to sync initial car color:', err);
  }

  const initialGraphics = useAppStore.getState().graphics;
  tunerPort.applyGraphicsSettings(initialGraphics);
  tunerPort.applyBoostPadTuner(
    useAppStore.getState().boostPadTuner as unknown as Record<string, unknown>,
  );
  tunerPort.applyDriftwoodsTuner(
    useAppStore.getState().driftwoodsTuner as unknown as Record<string, unknown>,
  );

  useAppStore.getState().setBridge({
    ...createModeBridgeHandlers(runtimePort),
    ...createOnlineBridgeHandlers(runtimePort),
    ...createTunerBridgeHandlers(runtimePort),
  });

  const initialCamera = useAppStore.getState().camera;
  cameraPort.applyPovSettings(initialCamera as unknown as Record<string, unknown>);

  const initialTrajectory = useAppStore.getState().trajectory;
  tunerPort.applyTrajectorySettings(initialTrajectory as unknown as Record<string, unknown>);

  const initialMaterials = useAppStore.getState().materials;
  syncMaterialsToGame(runtimePort, initialMaterials as unknown as Record<string, unknown>);

  const initialBindings = loadInputBindings();
  hudStore.getState().syncBindings(initialBindings);

  const initialGameplay = useAppStore.getState().gameplay;
  tunerPort.applyGameplaySettings(initialGameplay);

  lastSyncedBarrierMeshKey = '';
  syncGoalBarrierToGame(runtimePort);
  if (goalBarrierUnsubscribe) {
    goalBarrierUnsubscribe();
  }
  goalBarrierUnsubscribe = useGoalBarrierStore.subscribe(() => {
    syncGoalBarrierToGame(runtimePort);
  });

  if (modeScopeUnsubscribe) {
    modeScopeUnsubscribe();
  }
  let lastObservedMode = useAppStore.getState().matchMode;
  let lastObservedRoomId = useAppStore.getState().onlineSession?.roomId ?? '';
  modeScopeUnsubscribe = useAppStore.subscribe((state) => {
    const nextMode = state.matchMode;
    const nextRoomId = state.onlineSession?.roomId ?? '';
    if (nextMode !== lastObservedMode || nextRoomId !== lastObservedRoomId) {
      lastObservedMode = nextMode;
      lastObservedRoomId = nextRoomId;
      tunerPort.reconcileTrainingScopeForMode?.(nextMode);
    }
  });
}
