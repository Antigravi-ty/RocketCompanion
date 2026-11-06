import { bindRuntimeUiPort } from '../../game/runtimeUiPort.ts';
import { useAppStore } from '../../ui-core/stores/appStore';
import { hudStore, useHudStore } from '../../ui-core/stores/hudStore';
import {
  useSpatialAudioStore,
  getFilteredBgmTracks,
} from '../../ui-core/stores/spatialAudioStore';
import { useSubsystemIsolationLabStore } from '../../ui-core/stores/subsystemIsolationLabStore';
import { useRewinderStore } from '../../ui-core/stores/rewinderStore';
import { useReplayViewerStore } from '../../ui-core/stores/replayViewerStore';
import { networkDiagnosticsStore } from '../../ui-core/stores/networkDiagnosticsStore';
import { determinismStore } from '../../ui-core/stores/determinismStore';
import { eventStreamStore } from '../../ui-core/stores/eventStreamStore';
import { reachabilityStore } from '../../ui-core/stores/reachabilityStore';
import { ballTrajectoryTunerStore } from '../../ui-core/stores/ballTrajectoryTunerStore';
import {
  useStaticTrainingPackStore,
  getActiveEditItemVariable,
  mutateActiveEditItemVariable,
} from '../../ui-core/stores/staticTrainingPackStore';
import { useStaticTrainingBallCamTunerStore } from '../../ui-core/stores/staticTrainingBallCamTunerStore';
import { useKickoffTrainingStore } from '../../ui-core/stores/kickoffTrainingStore';
import { useReferenceOverlayStore } from '../../ui-core/stores/referenceOverlayStore';
import { useExperimentalMultiBotsStore } from '../../ui-core/stores/experimentalMultiBotsStore';
import { getExpColorSwatch } from '../../ui-core/stores/experimentalMultiBotsRosterUtils';
import {
  useQuickNotificationStore,
  quickNotification,
  pushQuickNotification,
  dismissQuickNotification,
  pushOngoingNotification,
  dismissOngoingNotification,
  completeOngoingNotification,
} from '../../ui-core/stores/quickNotificationStore';
import {
  useNameTagTunerStore,
  getNameTagConfig,
  subscribeNameTagConfig,
  getNameTagRuntimeState,
  setNameTagRuntimeState,
  setNameTagTelemetrySnapshot,
  getNameTagTelemetrySnapshot,
} from '../../ui-core/stores/nameTagTunerStore';
import {
  floatingStore,
  toggleFloatingPreset,
} from '../../ui-core/stores/floatingStore';
import { NETWORK_MONITOR_PRESET } from '../../ui-core/stores/floatingPresets';
import { DUAL_ARENA_DETERMINISM_HARNESS_PRESET } from '../../ui-core/stores/devFloatingPresets';
import {
  snapshotCurrentTelemetryPayload,
  notifyNetworkTelemetryExportAvailable,
} from '../../ui-core/stores/pacingTelemetryExporter';
import { globalPacingTelemetryRecorder } from '../../ui-core/stores/pacingTelemetryRecorder';
import { globalHudTransientChannel } from '../../ui-core/stores/hudTransientChannel';
import {
  markReplayTimelineControllerRetained,
  getLatestRetainedReplayTimelineController,
  notifyActiveReplayTimelineController,
  setActiveReplayTimelineController,
  getActiveReplayTimelineController,
  subscribeActiveReplayTimelineController,
  registerReplayDirectorDiagnosticExporter,
  registerReplayDirectorPreviewHandlers,
} from '../../ui-core/stores/replayDirectorStore';

let initialized = false;

export function ensureRuntimeEngineUiPortBound(): void {
  if (initialized) return;
  initialized = true;
  bindRuntimeUiPort({
    useAppStore,
    useHudStore,
    hudStore,
    useSpatialAudioStore,
    useSubsystemIsolationLabStore,
    useRewinderStore,
    useReplayViewerStore,
    useExperimentalMultiBotsStore,
    useStaticTrainingPackStore,
    useStaticTrainingBallCamTunerStore,
    useKickoffTrainingStore,
    useReferenceOverlayStore,
    useNameTagTunerStore,
    useQuickNotificationStore,
    networkDiagnosticsStore,
    determinismStore,
    eventStreamStore,
    reachabilityStore,
    ballTrajectoryTunerStore,
    floatingStore,
    DUAL_ARENA_DETERMINISM_HARNESS_PRESET,
    NETWORK_MONITOR_PRESET,
    globalPacingTelemetryRecorder,
    globalHudTransientChannel,
    quickNotification,
    markReplayTimelineControllerRetained,
    getLatestRetainedReplayTimelineController,
    notifyActiveReplayTimelineController,
    setActiveReplayTimelineController,
    getActiveReplayTimelineController,
    subscribeActiveReplayTimelineController,
    registerReplayDirectorDiagnosticExporter,
    registerReplayDirectorPreviewHandlers,
    getNameTagConfig,
    subscribeNameTagConfig,
    getNameTagRuntimeState,
    setNameTagRuntimeState,
    setNameTagTelemetrySnapshot,
    getNameTagTelemetrySnapshot,
    getActiveEditItemVariable,
    mutateActiveEditItemVariable,
    getFilteredBgmTracks,
    getExpColorSwatch,
    toggleFloatingPreset,
    snapshotCurrentTelemetryPayload,
    notifyNetworkTelemetryExportAvailable,
    pushQuickNotification,
    dismissQuickNotification,
    pushOngoingNotification,
    dismissOngoingNotification,
    completeOngoingNotification,
  });
}

ensureRuntimeEngineUiPortBound();
