import type * as THREE from 'three';
import {
  globalPacingTelemetryRecorder,
  type GraphicsSettingsPort,
  type PacingTelemetryRecorderPort,
  type PerfTelemetrySamplerPort,
  type RuntimeReplayPort,
  type WasmReplayTracksPort,
} from '../runtimeUiPort.ts';
import { gameAudio } from '../../audio/GameAudioEngineFacade.ts';
import {
  retainCompletedMatchReplayAndNotify,
  exportRetainedMatchReplayFile,
} from '../../replay/ReplayFileExporter.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { KeyboardMouseController } from '../../input/KeyboardMouseController.ts';
import type { GamepadController } from '../../input/GamepadController.ts';
import type { BallTrajectoryPredictor } from '../../entities/BallTrajectoryPredictor.ts';
import type { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.ts';
import type { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import type { RuntimeNetworkManager } from './RuntimeNetworkManager.ts';
import type { RuntimeBotCoordinator } from './RuntimeBotCoordinator.ts';
import type { RuntimeDOMEventManager } from './RuntimeDOMEventManager.ts';
import type { MountedGameUIHandle } from './RuntimeSceneBootstrap.ts';
import type {
  MaterialsConfigLike,
  NetworkSessionChannelLike,
} from './onlineLobbyTransitionPipeline.ts';

interface StandaloneReplayViewerCarLoadoutPort {
  hasLoadedReplay?: boolean;
  isActive?: boolean;
  _applyUserLoadoutToTakenOverCar?(carIndex: number): void;
}

export interface FreeplayModeCleanupPort {
  nameTagTunerController?: { isActive?: boolean; exitTunerArena(): void } | null;
  directorPreview?: { isReplayActive?: boolean } | null;
  isGoalReplayActive?(): boolean;
  exitDirectorPatternPreview?(): void;
  rewinderController?: { isBlockingLivePhysics?: boolean; clearBuffer?(): void } | null;
  resetToCleanFreeplay?(): void;
}

export interface RuntimeDomainPortOwner {
  readonly physics: RocketSimPhysicsEngine | null;
  readonly interpolator: PhysicsStateInterpolator | null;
  readonly match: RuntimeMatchState | null;
  readonly arena: ArenaWorld | null;
  readonly camera: CameraManager | null;
  readonly renderer: THREE.WebGLRenderer | null;
  readonly profiler: unknown;
  readonly keyboard: KeyboardMouseController | null;
  readonly gamepad: GamepadController | null;
  readonly gameUI: MountedGameUIHandle | null;
  readonly ballTrajectoryPredictor: BallTrajectoryPredictor | null;
  readonly multiplayerSession: MultiplayerSessionManager | null;
  readonly replayTimelineController: ReplayTimelineController | null;
  readonly networkManager: RuntimeNetworkManager;
  readonly botCoordinator: RuntimeBotCoordinator;
  readonly domEventManager: RuntimeDOMEventManager;
  readonly modeManager: {
    activeMode?: {
      id?: string;
      onEnter?(): void;
      applyRosterAndStartMatch?(): Promise<void> | void;
      skipGoalReplay?(): void;
      standaloneReplayViewer?: StandaloneReplayViewerCarLoadoutPort;
    } | null;
    modes?: Map<string, unknown>;
    getActiveMode?(): {
      id?: string;
      onEnter?(): void;
      applyRosterAndStartMatch?(): Promise<void> | void;
      skipGoalReplay?(): void;
    } | null;
    setMode?(modeId: string): void;
  } | null;
  trainingOptions: {
    boostOption?: string;
    disableGoalReset?: boolean;
    showCarHitbox?: boolean;
    showAllCarHitboxes?: boolean;
    [key: string]: unknown;
  };
  readonly teamAssignment: { playerTeam: number; opponentTeam: number } | null;
  readonly playerCarIndex: number;
  readonly matchDurationSeconds: number;
  readonly selectedPreset: string;
  selectedHitbox: string | null;
  activeGraphicsSettings: GraphicsSettingsPort | null;
  bloomEnabled: boolean;
  changePlayerVehicle(visualId: string, hitboxId?: string | null): void;
  setCarColor(carIndex: number, colorVal: number | string, broadcast?: boolean): void;
  syncPlayerMaterialsLoadout(materialsConfig?: MaterialsConfigLike | null): void;
  restoreLocalPlayerFreeplayLoadout?(carIndex?: number): void;
  resetKickoff(seed?: number): void;
}

export function createRuntimePerfTelemetrySampler(
  owner: RuntimeDomainPortOwner,
): PerfTelemetrySamplerPort {
  return {
    getProfiler: () => owner.profiler,
    getRenderer: () => owner.renderer,
    getInterpolator: () => owner.interpolator,
    getPhysicsRate: () => owner.networkManager.diagnosticsProbe.getPhysicsRate(),
    getNetworkLatencyInfo: () => {
      const ch = owner.networkManager.sessionCoordinator.networkChannel as
        | (NetworkSessionChannelLike & { isLoopback?: boolean; measuredRttMs?: number })
        | null;
      const reconciler = owner.networkManager.sessionCoordinator.networkReconciler;
      if (!ch && !reconciler) {
        return {
          rttMs: 0, extraRttMs: 0, uplinkMs: 0, downlinkMs: 0,
          extraUplinkMs: 0, extraDownlinkMs: 0, baseLatency: 0, extraLatency: 0,
        };
      }
      if (reconciler && typeof reconciler._resolveLatencyBreakdown === 'function') {
        const b = reconciler._resolveLatencyBreakdown();
        return {
          rttMs: b.rttMs, extraRttMs: b.extraRttMs, uplinkMs: b.uplinkMs,
          downlinkMs: b.downlinkMs, extraUplinkMs: b.extraUplinkMs,
          extraDownlinkMs: b.extraDownlinkMs, baseLatency: b.rttMs, extraLatency: b.extraRttMs,
        };
      }
      const extraUplinkMs = Math.max(
        0, Math.round(Number(ch?.extraUplinkMs ?? ch?.extraLatencyMs ?? 0) || 0),
      );
      const extraDownlinkMs = Math.max(
        0, Math.round(Number(ch?.extraDownlinkMs ?? ch?.extraLatencyMs ?? 0) || 0),
      );
      const extraRttMs = extraUplinkMs + extraDownlinkMs;

      let rttMs = extraRttMs;
      if (!ch?.isLoopback) {
        if (typeof ch?.rttMs === 'number' && Number.isFinite(ch.rttMs) && ch.rttMs > 0) {
          rttMs = Math.round(ch.rttMs);
        } else if (
          typeof ch?.measuredRttMs === 'number' &&
          Number.isFinite(ch.measuredRttMs) &&
          ch.measuredRttMs > 0
        ) {
          rttMs = Math.round(ch.measuredRttMs);
        }
      }
      const baseRtt = Math.max(0, rttMs - extraRttMs);
      const baseUplink = Math.round(baseRtt * 0.5);
      const baseDownlink = Math.max(0, baseRtt - baseUplink);
      const uplinkMs = baseUplink + extraUplinkMs;
      const downlinkMs = baseDownlink + extraDownlinkMs;

      return {
        rttMs: uplinkMs + downlinkMs, extraRttMs, uplinkMs, downlinkMs,
        extraUplinkMs, extraDownlinkMs, baseLatency: uplinkMs + downlinkMs, extraLatency: extraRttMs,
      };
    },
  };
}

export function createRuntimeReplayPort(owner: RuntimeDomainPortOwner): RuntimeReplayPort {
  return {
    seekReplayNormalized: (progress01) => {
      const ctrl = owner.replayTimelineController;
      if (!ctrl) return null;
      ctrl.sessionState.isPersistent = true;
      ctrl.seekToNormalized(progress01, owner.interpolator);
      return {
        progress: ctrl.progress,
        frameIndex: ctrl.currentFrameIndex,
        totalFrames: ctrl.getTotalRecordedFrames(),
        isPaused: ctrl.sessionState.isPaused,
      };
    },
    toggleReplayPause: () => {
      const ctrl = owner.replayTimelineController;
      if (!ctrl) return null;
      return { isPaused: ctrl.togglePause(), isPersistent: ctrl.sessionState.isPersistent };
    },
    cycleReplaySpeed: () => {
      const ctrl = owner.replayTimelineController;
      return ctrl ? ctrl.cyclePlaybackSpeed() : null;
    },
    voteOrSkipReplay: () => {
      const modeName = owner.match?.state?.mode;
      if (
        modeName === 'exp-multi-bots' ||
        modeName === 'freeplay' ||
        modeName === 'replay-viewer' ||
        modeName === 'static-training-pack'
      ) {
        owner.modeManager?.getActiveMode?.()?.skipGoalReplay?.();
        return;
      }
      gameAudio?.stadiumSpatialEngine?.notifyGoalReplaySkipped?.();
      owner.networkManager.voteSkipReplay();
    },
    prepareForReplayViewerEntry: () => {
      const freeplayMode = owner.modeManager?.modes?.get?.('freeplay') as
        | FreeplayModeCleanupPort
        | undefined;
      if (freeplayMode?.nameTagTunerController?.isActive) {
        freeplayMode.nameTagTunerController.exitTunerArena();
      }
      if (
        freeplayMode?.directorPreview?.isReplayActive ||
        freeplayMode?.isGoalReplayActive?.()
      ) {
        freeplayMode.exitDirectorPatternPreview?.();
      }
      if (freeplayMode?.rewinderController?.isBlockingLivePhysics) {
        freeplayMode.rewinderController.clearBuffer?.();
      }
    },
    getDiagnosticSessionHandles: () => ({
      reconciler: owner.networkManager.sessionCoordinator.networkReconciler,
      channel: owner.networkManager.sessionCoordinator.networkChannel,
    }),
    getDiagnosticBufferContext: () => {
      const net = owner.networkManager;
      const session = net.sessionCoordinator;
      const isOnlineSession = Boolean(session.networkReconciler || session.authoritativeServer);
      const isLobby = Boolean(owner.arena?.isLobbyMode || owner.match?.state?.phase === 'lobby');
      const matchState = String(owner.match?.state?.phase || 'FREEPLAY');
      const isHosting = Boolean(session.authoritativeServer);
      const clientFrames = Number(owner.physics?.getReplayFrameCount?.() ?? 0);
      const clientRecordingActive = Boolean(owner.physics?.getReplayRecordingActive?.() ?? false);
      const clientOverflowPaused = Boolean(session.clientReplayOverflowPaused);
      const maxClientFrames = Number(net.diagnosticDumpMaxFrames) || 36000;
      const autoPauseOnOverflow =
        net.diagnosticDumpPauseOnOverflow !== undefined
          ? Boolean(net.diagnosticDumpPauseOnOverflow)
          : true;
      const recorder =
        (session.networkReconciler?.telemetryCollector.recorder as
          | PacingTelemetryRecorderPort
          | undefined) || globalPacingTelemetryRecorder;
      const serverFrames = Number(session.authoritativeServer?.hostReplayRingBuffer?.size ?? 0);
      const activeCarMask = Number(owner.physics?.getActiveCarMask?.() ?? 0);
      const rosterSnapshot = net.rosterSyncCoordinator.lastRosterSnapshot;
      const rosterList = Array.isArray(rosterSnapshot?.players) ? rosterSnapshot.players : [];

      return {
        isOnlineSession, isLobby, matchState, isHosting,
        localPlayerCarIndex: owner.playerCarIndex ?? 0,
        activeCarMask, clientFrames, clientRecordingActive, clientOverflowPaused,
        maxClientFrames, autoPauseOnOverflow, recorder, serverFrames,
        blueScore: owner.match?.state?.blueScore ?? 0,
        orangeScore: owner.match?.state?.orangeScore ?? 0,
        durationSeconds: owner.match?.state?.durationSeconds ?? 300,
        arenaPreset: owner.physics?.getArenaPreset?.() ?? 0,
        roster: rosterList,
      };
    },
    setDiagnosticMaxCapacity: (frames) => {
      owner.networkManager.diagnosticDumpMaxFrames = frames;
      const clientFrames = Number(owner.physics?.getReplayFrameCount?.() ?? 0);
      if (clientFrames < frames && owner.networkManager.sessionCoordinator.clientReplayOverflowPaused) {
        owner.networkManager.sessionCoordinator.clientReplayOverflowPaused = false;
        owner.physics?.setReplayRecordingActive?.(true);
      }
    },
    setDiagnosticAutoPauseOverflow: (enabled) => {
      owner.networkManager.diagnosticDumpPauseOnOverflow = Boolean(enabled);
    },
    setDiagnosticRecordingActive: (recordingActive) => {
      owner.networkManager.sessionCoordinator.clientReplayOverflowPaused = false;
      owner.physics?.setReplayRecordingActive?.(recordingActive);
    },
    clearDiagnosticBuffers: () => {
      const session = owner.networkManager.sessionCoordinator;
      session.clientReplayOverflowPaused = false;
      owner.physics?.clearReplayBuffer?.();
      if (session.networkReconciler || session.authoritativeServer) {
        owner.physics?.setReplayRecordingActive?.(true);
      }
      session.authoritativeServer?.hostReplayRingBuffer?.clear?.();
      session.networkReconciler?.resetStats();
      if (session.networkReconciler?.metrics) {
        session.networkReconciler.metrics.mispredictions = 0;
      }
      const recorder =
        (session.networkReconciler?.telemetryCollector.recorder as
          | PacingTelemetryRecorderPort
          | undefined) || globalPacingTelemetryRecorder;
      const pacing = session.networkReconciler?.pacingController;
      recorder?.reset?.({
        mode: pacing?.clockPacingMode || 'csts',
        priority: pacing?.clockPacingPriority || 'balanced',
        params: (pacing?.clockPacingParams as Record<string, unknown>) || {},
      });
    },
    extractClientReplayTracks: () => {
      const tracks = owner.physics?.extractWasmReplayTracks?.() as
        | WasmReplayTracksPort
        | undefined;
      return tracks && tracks.frameCount > 0 ? tracks : null;
    },
    extractServerReplaySlots: () => {
      const ringBuffer = owner.networkManager.sessionCoordinator.authoritativeServer?.hostReplayRingBuffer as
        | { getRecentFrames?(): Float32Array[] }
        | undefined;
      return ringBuffer?.getRecentFrames?.() || [];
    },
    retainAndExportStandaloneClientReplay: (isLobby) => {
      const clientFrames = Number(owner.physics?.getReplayFrameCount?.() ?? 0);
      const freeplayMode = owner.modeManager?.modes?.get?.('freeplay') as
        | { replayRingBuffer?: typeof owner.networkManager.sessionCoordinator.authoritativeServer extends { hostReplayRingBuffer: infer R } | null ? R : never }
        | undefined;
      const fallbackRingBuffer =
        owner.networkManager.sessionCoordinator.authoritativeServer?.hostReplayRingBuffer ||
        freeplayMode?.replayRingBuffer ||
        null;
      const ringFramesCount = Number(fallbackRingBuffer?.size ?? 0);
      if (!owner.physics || (clientFrames <= 0 && ringFramesCount <= 0)) return 0;
      const rosterSnapshot = owner.networkManager.rosterSyncCoordinator.lastRosterSnapshot;
      const rosterList = Array.isArray(rosterSnapshot?.players) ? rosterSnapshot.players : [];
      retainCompletedMatchReplayAndNotify({
        engine: clientFrames > 0 ? owner.physics : null,
        ringBuffer: clientFrames > 0 ? null : fallbackRingBuffer,
        mode: isLobby ? 'online-lobby-dump' : 'online-match-dump',
        blueScore: owner.match?.state?.blueScore ?? 0,
        orangeScore: owner.match?.state?.orangeScore ?? 0,
        durationSeconds: owner.match?.state?.durationSeconds ?? 30,
        arenaPreset: owner.physics?.getArenaPreset?.() ?? 0,
        roster: rosterList,
        loadouts: rosterList,
        suppressNotification: true,
      });
      exportRetainedMatchReplayFile();
      return clientFrames > 0 ? clientFrames : ringFramesCount;
    },
    toggleZeroGFleet: async (enabled, anchorMode) => {
      await owner.networkManager.diagnosticsProbe.toggleDiagnosticTestFleet(enabled, anchorMode);
    },
    setZeroGAnchorMode: async (anchorMode) => {
      await owner.networkManager.diagnosticsProbe.spawnDiagnosticTestFleet({ anchorMode });
    },
    sampleZeroGFleetTelemetry: () =>
      owner.networkManager.diagnosticsProbe.sampleDiagnosticFleetTelemetry(),
    setTestCarAudioEnabled: (enabled) => {
      owner.networkManager.diagnosticsProbe.setTestCarAudioEnabled(enabled);
    },
    setLobbyGhostModeEnabled: (enabled) => {
      owner.networkManager.diagnosticsProbe.configureLobbyGhostMode(enabled);
    },
    dumpNextPacket: () => {
      void owner.networkManager.diagnosticsProbe.dumpNextNetworkPacket();
    },
    dumpLatestPacket: () => {
      owner.networkManager.diagnosticsProbe.dumpLatestNetworkPacket(null);
    },
    triggerBurstDrop: (count) => {
      owner.networkManager.diagnosticsProbe.dropPacketBurst(count);
    },
  };
}
