import {
  globalPacingTelemetryRecorder,
  type GameRuntimeUiBridgePort,
  type PacingTelemetryRecorderPort,
  type RuntimeReplayPort,
  type WasmReplayTracksPort,
} from '../runtimeUiPort.ts';
import { gameAudio } from '../../audio/GameAudioEngineFacade.ts';
import {
  retainCompletedMatchReplayAndNotify,
  exportRetainedMatchReplayFile,
} from '../../replay/ReplayFileExporter.ts';
import type {
  FreeplayModeCleanupPort,
  RuntimeDomainPortOwner,
} from './GoalBarrierRuntimeBridge.ts';
import { createRuntimeTunerPort } from './ArenaEnvironmentTunerBridge.ts';
import { createRuntimeCameraPort, createRuntimeMatchPort } from './OnlineMatchControlBridge.ts';

export function createRuntimeReplayPort(target: RuntimeDomainPortOwner): RuntimeReplayPort {
  return {
    seekReplayNormalized: (progress01) => {
      const timeline = target.replayTimelineController;
      if (!timeline) return null;
      timeline.sessionState.isPersistent = true;
      timeline.seekToNormalized(progress01, target.interpolator);
      return {
        progress: timeline.progress,
        frameIndex: timeline.currentFrameIndex,
        totalFrames: timeline.getTotalRecordedFrames(),
        isPaused: timeline.sessionState.isPaused,
      };
    },
    toggleReplayPause: () => {
      const timeline = target.replayTimelineController;
      if (!timeline) return null;
      return { isPaused: timeline.togglePause(), isPersistent: timeline.sessionState.isPersistent };
    },
    cycleReplaySpeed: () => {
      const timeline = target.replayTimelineController;
      return timeline ? timeline.cyclePlaybackSpeed() : null;
    },
    voteOrSkipReplay: () => {
      const modeName = target.match?.state?.mode;
      if (
        modeName === 'exp-multi-bots' ||
        modeName === 'freeplay' ||
        modeName === 'replay-viewer' ||
        modeName === 'static-training-pack'
      ) {
        target.modeManager?.getActiveMode?.()?.skipGoalReplay?.();
        return;
      }
      gameAudio?.stadiumSpatialEngine?.notifyGoalReplaySkipped?.();
      target.networkManager.voteSkipReplay();
    },
    prepareForReplayViewerEntry: () => {
      const freeplayMode = target.modeManager?.modes?.get?.('freeplay') as
        FreeplayModeCleanupPort | undefined;
      if (freeplayMode?.nameTagTunerController?.isActive) {
        freeplayMode.nameTagTunerController.exitTunerArena();
      }
      if (freeplayMode?.directorPreview?.isReplayActive || freeplayMode?.isGoalReplayActive?.()) {
        freeplayMode.exitDirectorPatternPreview?.();
      }
      if (freeplayMode?.rewinderController?.isBlockingLivePhysics) {
        freeplayMode.rewinderController.clearBuffer?.();
      }
    },
    getDiagnosticSessionHandles: () => ({
      reconciler: target.networkManager.sessionCoordinator.networkReconciler,
      channel: target.networkManager.sessionCoordinator.networkChannel,
    }),
    getDiagnosticBufferContext: () => {
      const net = target.networkManager;
      const session = net.sessionCoordinator;
      const isOnlineSession = Boolean(session.networkReconciler || session.authoritativeServer);
      const isLobby = Boolean(target.arena?.isLobbyMode || target.match?.state?.phase === 'lobby');
      const matchState = String(target.match?.state?.phase || 'FREEPLAY');
      const isHosting = Boolean(session.authoritativeServer);
      const clientFrames = Number(target.physics?.getReplayFrameCount?.() ?? 0);
      const clientRecordingActive = Boolean(target.physics?.getReplayRecordingActive?.() ?? false);
      const clientOverflowPaused = Boolean(session.clientReplayOverflowPaused);
      const maxClientFrames = Number(net.diagnosticDumpMaxFrames) || 36000;
      const autoPauseOnOverflow =
        net.diagnosticDumpPauseOnOverflow !== undefined
          ? Boolean(net.diagnosticDumpPauseOnOverflow)
          : true;
      const recorder =
        (session.networkReconciler?.telemetryCollector.recorder as
          PacingTelemetryRecorderPort | undefined) || globalPacingTelemetryRecorder;
      const serverFrames = Number(session.authoritativeServer?.hostReplayRingBuffer?.size ?? 0);
      const activeCarMask = Number(target.physics?.getActiveCarMask?.() ?? 0);
      const rosterSnapshot = net.rosterSyncCoordinator.lastRosterSnapshot;
      const rosterList = Array.isArray(rosterSnapshot?.players) ? rosterSnapshot.players : [];

      return {
        isOnlineSession,
        isLobby,
        matchState,
        isHosting,
        localPlayerCarIndex: target.playerCarIndex ?? 0,
        activeCarMask,
        clientFrames,
        clientRecordingActive,
        clientOverflowPaused,
        maxClientFrames,
        autoPauseOnOverflow,
        recorder,
        serverFrames,
        blueScore: target.match?.state?.blueScore ?? 0,
        orangeScore: target.match?.state?.orangeScore ?? 0,
        durationSeconds: target.match?.state?.durationSeconds ?? 300,
        arenaPreset: target.physics?.getArenaPreset?.() ?? 0,
        roster: rosterList,
      };
    },
    setDiagnosticMaxCapacity: (frames) => {
      target.networkManager.diagnosticDumpMaxFrames = frames;
      const clientFrames = Number(target.physics?.getReplayFrameCount?.() ?? 0);
      if (
        clientFrames < frames &&
        target.networkManager.sessionCoordinator.clientReplayOverflowPaused
      ) {
        target.networkManager.sessionCoordinator.clientReplayOverflowPaused = false;
        target.physics?.setReplayRecordingActive?.(true);
      }
    },
    setDiagnosticAutoPauseOverflow: (enabled) => {
      target.networkManager.diagnosticDumpPauseOnOverflow = Boolean(enabled);
    },
    setDiagnosticRecordingActive: (recordingActive) => {
      target.networkManager.sessionCoordinator.clientReplayOverflowPaused = false;
      target.physics?.setReplayRecordingActive?.(recordingActive);
    },
    clearDiagnosticBuffers: () => {
      const session = target.networkManager.sessionCoordinator;
      session.clientReplayOverflowPaused = false;
      target.physics?.clearReplayBuffer?.();
      if (session.networkReconciler || session.authoritativeServer) {
        target.physics?.setReplayRecordingActive?.(true);
      }
      session.authoritativeServer?.hostReplayRingBuffer?.clear?.();
      session.networkReconciler?.resetStats();
      if (session.networkReconciler?.metrics) {
        session.networkReconciler.metrics.mispredictions = 0;
      }
      const recorder =
        (session.networkReconciler?.telemetryCollector.recorder as
          PacingTelemetryRecorderPort | undefined) || globalPacingTelemetryRecorder;
      const pacing = session.networkReconciler?.pacingController;
      recorder?.reset?.({
        mode: pacing?.clockPacingMode || 'csts',
        priority: pacing?.clockPacingPriority || 'balanced',
        params: (pacing?.clockPacingParams as Record<string, unknown>) || {},
      });
    },
    extractClientReplayTracks: () => {
      const tracks = target.physics?.extractWasmReplayTracks?.() as
        WasmReplayTracksPort | undefined;
      return tracks && tracks.frameCount > 0 ? tracks : null;
    },
    extractServerReplaySlots: () => {
      const ringBuffer = target.networkManager.sessionCoordinator.authoritativeServer
        ?.hostReplayRingBuffer as { getRecentFrames?(): Float32Array[] } | undefined;
      return ringBuffer?.getRecentFrames?.() || [];
    },
    retainAndExportStandaloneClientReplay: (isLobby) => {
      const clientFrames = Number(target.physics?.getReplayFrameCount?.() ?? 0);
      const freeplayMode = target.modeManager?.modes?.get?.('freeplay') as
        | {
            replayRingBuffer?: typeof target.networkManager.sessionCoordinator.authoritativeServer extends {
              hostReplayRingBuffer: infer R;
            } | null
              ? R
              : never;
          }
        | undefined;
      const fallbackRingBuffer =
        target.networkManager.sessionCoordinator.authoritativeServer?.hostReplayRingBuffer ||
        freeplayMode?.replayRingBuffer ||
        null;
      const ringFramesCount = Number(fallbackRingBuffer?.size ?? 0);
      if (!target.physics || (clientFrames <= 0 && ringFramesCount <= 0)) return 0;
      const rosterSnapshot = target.networkManager.rosterSyncCoordinator.lastRosterSnapshot;
      const rosterList = Array.isArray(rosterSnapshot?.players) ? rosterSnapshot.players : [];
      retainCompletedMatchReplayAndNotify({
        engine: clientFrames > 0 ? target.physics : null,
        ringBuffer: clientFrames > 0 ? null : fallbackRingBuffer,
        mode: isLobby ? 'online-lobby-dump' : 'online-match-dump',
        blueScore: target.match?.state?.blueScore ?? 0,
        orangeScore: target.match?.state?.orangeScore ?? 0,
        durationSeconds: target.match?.state?.durationSeconds ?? 60,
        arenaPreset: target.physics?.getArenaPreset?.() ?? 0,
        roster: rosterList,
        loadouts: rosterList,
        suppressNotification: true,
      });
      exportRetainedMatchReplayFile();
      return clientFrames > 0 ? clientFrames : ringFramesCount;
    },
    toggleZeroGFleet: async (enabled, anchorMode) => {
      await target.networkManager.diagnosticsProbe.toggleDiagnosticTestFleet(enabled, anchorMode);
    },
    setZeroGAnchorMode: async (anchorMode) => {
      await target.networkManager.diagnosticsProbe.spawnDiagnosticTestFleet({ anchorMode });
    },
    sampleZeroGFleetTelemetry: () =>
      target.networkManager.diagnosticsProbe.sampleDiagnosticFleetTelemetry(),
    setTestCarAudioEnabled: (enabled) => {
      target.networkManager.diagnosticsProbe.setTestCarAudioEnabled(enabled);
    },
    setLobbyGhostModeEnabled: (enabled) => {
      target.networkManager.diagnosticsProbe.configureLobbyGhostMode(enabled);
    },
    dumpNextPacket: () => {
      void target.networkManager.diagnosticsProbe.dumpNextNetworkPacket();
    },
    dumpLatestPacket: () => {
      target.networkManager.diagnosticsProbe.dumpLatestNetworkPacket(null);
    },
    triggerBurstDrop: (count) => {
      target.networkManager.diagnosticsProbe.dropPacketBurst(count);
    },
  };
}

export function createGameRuntimeDomainPorts(
  target: RuntimeDomainPortOwner
): GameRuntimeUiBridgePort {
  return {
    cameraPort: createRuntimeCameraPort(target),
    matchPort: createRuntimeMatchPort(target),
    tunerPort: createRuntimeTunerPort(target),
    replayPort: createRuntimeReplayPort(target),
  };
}
