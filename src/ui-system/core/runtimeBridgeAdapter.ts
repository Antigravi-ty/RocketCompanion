import { useAppStore } from '../../ui-core/stores/appStore';
import { perfTelemetryStore } from '../../ui-core/stores/perfTelemetryStore';
import { hudStore } from '../../ui-core/stores/hudStore';
import { floatingStore } from '../../ui-core/stores/floatingStore';
import { useRewinderStore } from '../../ui-core/stores/rewinderStore';
import { useReplayViewerStore } from '../../ui-core/stores/replayViewerStore';
import { loadInputBindings } from '../../ui-core/config/InputBindings.js';
import { getPreferredColorHex } from '../../ui-core/config/uiConfig';
import { createOnlineBridgeHandlers } from './runtimeOnlineBridgeHandlers';
import { createModeBridgeHandlers } from './runtimeModeBridgeHandlers';
import { createTunerBridgeHandlers, syncMaterialsToGame } from './runtimeTunerBridgeHandlers';
import { cameraDeterminismStore } from '../../ui-core/stores/cameraDeterminismStore';
import { getCameraDeterminismHarness } from '../../camera/CameraDeterminismHarness.js';
import { useQuickNotificationStore } from '../../ui-core/stores/quickNotificationStore';
import { setPacingTelemetryNotificationHandler } from '../../ui-core/stores/pacingTelemetryExporter.js';
import { useGoalBarrierStore } from '../../ui-core/stores/goalBarrierStore';
import { buildGoalBarrierCmfChunks } from '../../ui-core/config/goalBarrierConfig';
import { syncRuntimeNetworkDiagnostics } from './runtimeNetworkDiagnosticsBridge';

let goalBarrierUnsubscribe: (() => void) | null = null;
let floatingFlagsUnsubscribe: (() => void) | null = null;
let lastSyncedBarrierMeshKey = '';

function syncFloatingWindowFlags() {
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

export function syncGoalBarrierToGame(gameRuntime: any) {
  if (!gameRuntime) return;
  const gbState = useGoalBarrierStore.getState();
  const { enabled, targetGoal, opacity, decomposition } = gbState;

  gameRuntime.arena?.updateGoalBarrier?.(decomposition, targetGoal, enabled, opacity);

  const rectsKey = enabled
    ? `${targetGoal}:${decomposition.mergedRects
        .map((r) => `${r.u0},${r.v0},${r.u1},${r.v1}`)
        .join(';')}`
    : 'disabled';

  if (rectsKey !== lastSyncedBarrierMeshKey && gameRuntime.physics?.setGoalBarrierChunks) {
    lastSyncedBarrierMeshKey = rectsKey;
    const chunks = buildGoalBarrierCmfChunks(decomposition, targetGoal, enabled);
    gameRuntime.physics.setGoalBarrierChunks(chunks, {
      enabled: enabled && decomposition.mergedRects.length > 0,
      targetGoal,
      rects: decomposition.mergedRects,
    });
    gameRuntime.interpolator?.sync?.();
  }
}

export { syncMaterialsToGame };

export function attachGameRuntimeBridge(gameRuntime: any) {
  if (!gameRuntime) return;

  cameraDeterminismStore.setHarness(getCameraDeterminismHarness());
  syncRuntimeNetworkDiagnostics(gameRuntime);
  setPacingTelemetryNotificationHandler((notification: any) => {
    useQuickNotificationStore.getState().pushNotification(notification);
  });

  syncFloatingWindowFlags();
  if (floatingFlagsUnsubscribe) {
    floatingFlagsUnsubscribe();
  }
  floatingFlagsUnsubscribe = floatingStore.subscribe(syncFloatingWindowFlags);

  perfTelemetryStore.setSampler({
    getProfiler: () => gameRuntime.profiler,
    getRenderer: () => gameRuntime.renderer,
    getInterpolator: () => gameRuntime.interpolator,
    getPhysicsRate: () => gameRuntime.interpolator?.physicsRate ?? gameRuntime.physicsRate ?? 120,
    getNetworkLatencyInfo: () => {
      const ch = gameRuntime.networkChannel;
      const reconciler = gameRuntime.networkReconciler;
      if (!ch && !reconciler) {
        return {
          rttMs: 0,
          extraRttMs: 0,
          uplinkMs: 0,
          downlinkMs: 0,
          extraUplinkMs: 0,
          extraDownlinkMs: 0,
          baseLatency: 0,
          extraLatency: 0,
        };
      }
      if (reconciler && typeof reconciler._resolveLatencyBreakdown === 'function') {
        const b = reconciler._resolveLatencyBreakdown();
        return {
          rttMs: b.rttMs,
          extraRttMs: b.extraRttMs,
          uplinkMs: b.uplinkMs,
          downlinkMs: b.downlinkMs,
          extraUplinkMs: b.extraUplinkMs,
          extraDownlinkMs: b.extraDownlinkMs,
          baseLatency: b.rttMs,
          extraLatency: b.extraRttMs,
        };
      }
      const extraUplinkMs = Math.max(0, Math.round(Number(ch?.extraUplinkMs ?? ch?.extraLatencyMs ?? 0) || 0));
      const extraDownlinkMs = Math.max(0, Math.round(Number(ch?.extraDownlinkMs ?? ch?.extraLatencyMs ?? 0) || 0));
      const extraRttMs = extraUplinkMs + extraDownlinkMs;

      let rttMs = extraRttMs;
      if (!ch?.isLoopback) {
        if (typeof ch?.rttMs === 'number' && Number.isFinite(ch.rttMs) && ch.rttMs > 0) {
          rttMs = Math.round(ch.rttMs);
        } else if (typeof ch?.measuredRttMs === 'number' && Number.isFinite(ch.measuredRttMs) && ch.measuredRttMs > 0) {
          rttMs = Math.round(ch.measuredRttMs);
        }
      }
      const baseRtt = Math.max(0, rttMs - extraRttMs);
      const baseUplink = Math.round(baseRtt * 0.5);
      const baseDownlink = Math.max(0, baseRtt - baseUplink);
      const uplinkMs = baseUplink + extraUplinkMs;
      const downlinkMs = baseDownlink + extraDownlinkMs;

      return {
        rttMs: uplinkMs + downlinkMs,
        extraRttMs,
        uplinkMs,
        downlinkMs,
        extraUplinkMs,
        extraDownlinkMs,
        baseLatency: uplinkMs + downlinkMs,
        extraLatency: extraRttMs,
      };
    },
  });

  if (gameRuntime.networkReconciler) {
    const state = useAppStore.getState();
    gameRuntime.networkReconciler.setClockPacingMode?.(state.clockPacingMode);
    gameRuntime.networkReconciler.setClockPacingPriority?.(state.clockPacingPriority);
    gameRuntime.networkReconciler.setInputBufferTarget?.(state.inputBufferTarget);
    if (Array.isArray(state.inputBufferThreshold)) {
      gameRuntime.networkReconciler.setInputBufferThresholds?.(
        state.inputBufferThreshold[0],
        state.inputBufferThreshold[1]
      );
    }
    const effectiveParams = useAppStore.getState().customClockPacingParams;
    if (effectiveParams) {
      const { resolveEffectiveClockPacingParams } = useAppStore.getState() as any;
      if (typeof resolveEffectiveClockPacingParams === 'function') {
        gameRuntime.networkReconciler.setClockPacingParams?.(
          resolveEffectiveClockPacingParams(
            state.clockPacingMode,
            state.clockPacingPriority,
            state.inputBufferTarget,
            state.inputBufferThreshold,
            state.customClockPacingParams
          )
        );
      }
    }
  }

  const currentCar =
    gameRuntime.garageSettingsStore?.get()?.vehiclePreset ||
    gameRuntime.display?.vehiclePreset ||
    useAppStore.getState().activeCar;

  if (currentCar) {
    useAppStore.setState({ activeCar: currentCar });
  }

  if (gameRuntime.match?.state?.mode) {
    useAppStore.setState({ matchMode: gameRuntime.match.state.mode });
  }

  try {
    const targetHex = getPreferredColorHex();
    if (targetHex && typeof gameRuntime.setCarColor === 'function') {
      gameRuntime.setCarColor(gameRuntime.playerCarIndex ?? 0, targetHex);
    }
  } catch (err) {
    console.warn('[mountGameUI] Failed to sync initial car color:', err);
  }

  const initialGraphics = useAppStore.getState().graphics;
  gameRuntime.activeGraphicsSettings = initialGraphics;
  if (typeof gameRuntime.updateViewport === 'function') {
    gameRuntime.updateViewport(initialGraphics);
  }
  if (gameRuntime.arena) {
    gameRuntime.arena.setStadiumVisible?.(initialGraphics.showStadium);
  }
  if (typeof gameRuntime.syncPausedAndInputState === 'function') {
    gameRuntime.syncPausedAndInputState(initialGraphics);
  } else if (gameRuntime.clockScheduler) {
    gameRuntime.clockScheduler.setFpsLimit(initialGraphics.limitFps ? initialGraphics.maxFps : null);
  }
  if (gameRuntime.arena?.updateBoostPadTuner) {
    gameRuntime.arena.updateBoostPadTuner(useAppStore.getState().boostPadTuner);
  }
  if (gameRuntime.arena?.updateDriftwoodsTuner) {
    gameRuntime.arena.updateDriftwoodsTuner(useAppStore.getState().driftwoodsTuner);
  }

  useAppStore.getState().setBridge({
    ...createModeBridgeHandlers(gameRuntime),
    ...createOnlineBridgeHandlers(gameRuntime),
    ...createTunerBridgeHandlers(gameRuntime),
  });

  const initialCamera = useAppStore.getState().camera;
  if (gameRuntime.camera && gameRuntime.camera.settings) {
    Object.assign(gameRuntime.camera.settings, initialCamera);
    if (gameRuntime.camera._sharedCamera) {
      gameRuntime.camera._sharedCamera.fov = initialCamera.fov;
      if (typeof gameRuntime.camera._sharedCamera.updateProjectionMatrix === 'function') {
        gameRuntime.camera._sharedCamera.updateProjectionMatrix();
      }
    }
  }

  const initialTrajectory = useAppStore.getState().trajectory;
  if (gameRuntime.ballTrajectoryPredictor?.updateSettings) {
    gameRuntime.ballTrajectoryPredictor.updateSettings(initialTrajectory);
  } else if (gameRuntime.ballTrajectoryPredictor?.settings) {
    Object.assign(gameRuntime.ballTrajectoryPredictor.settings, initialTrajectory);
  }

  const initialMaterials = useAppStore.getState().materials;
  syncMaterialsToGame(gameRuntime, initialMaterials);

  const initialBindings = loadInputBindings();
  hudStore.getState().syncBindings(initialBindings);

  const initialGameplay = useAppStore.getState().gameplay;
  if (gameRuntime.trainingOptions) {
    gameRuntime.trainingOptions.boostOption = initialGameplay.unlimitedBoost
      ? 'unlimited'
      : 'standard';
    gameRuntime.trainingOptions.disableGoalReset = !initialGameplay.goalRestart;
    gameRuntime.trainingOptions.showCarHitbox = initialGameplay.showCarHitbox;
  }
  if (gameRuntime.physics) {
    gameRuntime.physics.setUnlimitedBoost?.(initialGameplay.unlimitedBoost);
  }
  if (gameRuntime.arena) {
    gameRuntime.arena.setCarHitboxesVisible?.(initialGameplay.showCarHitbox);
  }

  lastSyncedBarrierMeshKey = '';
  syncGoalBarrierToGame(gameRuntime);
  if (goalBarrierUnsubscribe) {
    goalBarrierUnsubscribe();
  }
  goalBarrierUnsubscribe = useGoalBarrierStore.subscribe(() => {
    syncGoalBarrierToGame(gameRuntime);
  });
}
