import { ReconcilerSignalCoordinator } from './ReconcilerSignalCoordinator.ts';
import {
  OnlineRosterSyncCoordinator,
  type OnlineRosterSnapshotPayload,
  type OnlineRosterSyncHostPort,
} from './OnlineRosterSyncCoordinator.ts';
import type { RuntimeSignalHostPort } from './RuntimeGoalReplaySignalSubController.ts';
import {
  NetworkDiagnosticsProbe,
  type NetworkDiagnosticsHostPort,
} from './NetworkDiagnosticsProbe.ts';
import {
  OnlineSessionCoordinator,
  type OnlineSessionCoordinatorHostPort,
  type OnlineSessionLifecyclePort,
  type OnlineSessionWorldPort,
} from './OnlineSessionCoordinator.ts';
import type { SignalAudioFacadeLike } from './RuntimeGoalReplaySignalSubController.ts';
import type { EntityManager } from '../../entities/EntityManager.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import type { PodiumCelebrationController } from '../modes/PodiumCelebrationController.ts';
import type { SimulationStage } from '../pipeline/stages/SimulationStage.ts';
import type { GameAudioSubsystem } from '../subsystems/GameAudioSubsystem.ts';
import type { DeterminismHarness } from '../../physics/DeterminismHarness.ts';
import type { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.ts';

export interface RuntimeNetworkHostPort extends OnlineSessionWorldPort, OnlineSessionLifecyclePort {
  readonly entityManager: EntityManager | null;
  readonly multiplayerSession: MultiplayerSessionManager | null;
  readonly modeManager: {
    setMode?(modeName: string): void;
    getActiveMode?(): { id?: string; onPhysicsEvent?(event: Record<string, unknown>): void } | null;
  } | null;
  readonly replayTimelineController: ReplayTimelineController | null;
  readonly podiumController: PodiumCelebrationController | null;
  readonly simulationStage: SimulationStage | null;
  readonly audioSubsystem: GameAudioSubsystem | null;
  readonly flipResetVisuals: Map<number, { stopVisual(): void; play?(): void }>;
  readonly options: { gameAudio?: SignalAudioFacadeLike; [key: string]: unknown } | null;
  _clientGoalIncidentLatched: boolean;
  _localSkipReplayReady: boolean;
  readonly botCoordinator?: { botKickoffStep: number } | null;
  readonly inputPoller?: { latchJumpSuppression?(): void } | null;
  getFlipResetVisual?(carIndex: number): { play(): void; stopVisual(): void } | null;
  resetAudio?(): void;
  isGoalReplayCameraOverrideActive(): boolean;
  acquireGoalReplayCameraOverride?(source?: string): void;
  releaseGoalReplayCameraOverride(source?: string | null): void;
  replayPovCarIndex?: number | null;
  onDeterminismHarnessReady?(harness: DeterminismHarness, showHUD: boolean): void;
}

export interface RuntimeNetworkManagerLike {
  readonly sessionCoordinator: OnlineSessionCoordinator;
  readonly rosterSyncCoordinator: OnlineRosterSyncCoordinator;
  readonly signalCoordinator: ReconcilerSignalCoordinator;
  isLobbyDualWorldActive(reconciler?: PredictionReconciler | null): boolean;
}

type SignalNetworkOverrides = Pick<
  RuntimeSignalHostPort,
  | 'authoritativeServer'
  | 'remotePeerCarMap'
  | 'clientReplayOverflowPaused'
  | 'getLastRosterSnapshot'
  | 'getParticipantTeams'
  | 'syncHostLobbyOngoingNotification'
  | 'isLobbyDualWorldActive'
  | 'despawnDiagnosticTestFleet'
  | 'setLobbyGhostMode'
  | 'setLatestServerRosterState'
  | 'isNetworkTelemetryNotified'
  | 'markNetworkTelemetryNotified'
  | 'resetBotKickoffStep'
  | 'latchJumpSuppression'
>;

export interface AssembledNetworkCoordinators {
  diagnosticsProbe: NetworkDiagnosticsProbe;
  sessionCoordinator: OnlineSessionCoordinator;
  rosterSyncCoordinator: OnlineRosterSyncCoordinator;
  signalCoordinator: ReconcilerSignalCoordinator;
}

export function assembleNetworkCoordinators(
  manager: RuntimeNetworkManagerLike,
  ctx: RuntimeNetworkHostPort
): AssembledNetworkCoordinators {
  const diagnosticsHostPort: NetworkDiagnosticsHostPort = {
    getPhysics: () => ctx.physics,
    getArena: () => ctx.arena,
    getInterpolator: () => ctx.interpolator,
    getCamera: () => ctx.camera,
    getAuthoritativeServer: () => manager.sessionCoordinator.authoritativeServer,
    getNetworkChannel: () => manager.sessionCoordinator.networkChannel,
    getNetworkReconciler: () => manager.sessionCoordinator.networkReconciler,
    getPlayerCarIndex: () => ctx.playerCarIndex ?? 0,
    isMatchPhaseBlockingDiagnosticsFleet: () => {
      const matchMode = ctx.match?.state?.mode;
      const phase = ctx.match?.state?.phase;
      return Boolean(matchMode === 'match' && phase && phase !== 'lobby' && phase !== 'freeplay');
    },
    ensureFlipResetVisual: (carIndex: number) => {
      ctx.getFlipResetVisual?.(carIndex);
    },
    notifyDeterminismHarnessReady: (harness, showHUD) => {
      ctx.onDeterminismHarnessReady?.(harness, showHUD);
    },
  };

  const diagnosticsProbe = new NetworkDiagnosticsProbe(diagnosticsHostPort);

  const sessionHostPort: OnlineSessionCoordinatorHostPort = {
    world: ctx,
    lifecycle: ctx,
    coordinators: {
      resetReconcilerSignalState: () => {
        manager.signalCoordinator.resetSignalState();
      },
      bindReconcilerSignals: (reconciler: PredictionReconciler) => {
        manager.signalCoordinator.bindReconcilerSignals(reconciler);
      },
      applyRosterSnapshot: async (roster: OnlineRosterSnapshotPayload | null) => {
        await manager.rosterSyncCoordinator.applyRosterSnapshot(roster);
      },
      syncHostLobbyNotification: () => {
        manager.rosterSyncCoordinator.syncHostLobbyOngoingNotification();
      },
    },
  };

  const sessionCoordinator = new OnlineSessionCoordinator(sessionHostPort, diagnosticsProbe);

  const rosterSyncHostPort: OnlineRosterSyncHostPort = {
    world: ctx,
    session: {
      get authoritativeServer() {
        return sessionCoordinator.authoritativeServer;
      },
      get networkReconciler() {
        return sessionCoordinator.networkReconciler;
      },
      get remotePeerCarMap() {
        return sessionCoordinator.remotePeerCarMap;
      },
      isLobbyDualWorldActive: () => manager.isLobbyDualWorldActive(),
    },
    diagnostics: {
      isDiagnosticFleetEnabled: () => Boolean(diagnosticsProbe.diagnosticsFleetController?.enabled),
      spawnDiagnosticTestFleet: (options) => diagnosticsProbe.spawnDiagnosticTestFleet(options),
      despawnDiagnosticTestFleet: () => diagnosticsProbe.despawnDiagnosticTestFleet(),
    },
  };

  const rosterSyncCoordinator = new OnlineRosterSyncCoordinator(rosterSyncHostPort);

  const overrides: SignalNetworkOverrides = {
    get authoritativeServer() {
      return sessionCoordinator.authoritativeServer;
    },
    get remotePeerCarMap() {
      return sessionCoordinator.remotePeerCarMap;
    },
    get clientReplayOverflowPaused() {
      return sessionCoordinator.clientReplayOverflowPaused;
    },
    set clientReplayOverflowPaused(val: boolean) {
      sessionCoordinator.clientReplayOverflowPaused = Boolean(val);
    },
    getLastRosterSnapshot: () => rosterSyncCoordinator.lastRosterSnapshot,
    getParticipantTeams: () => rosterSyncCoordinator.participantTeams,
    syncHostLobbyOngoingNotification: () =>
      rosterSyncCoordinator.syncHostLobbyOngoingNotification(),
    isLobbyDualWorldActive: (reconciler) => manager.isLobbyDualWorldActive(reconciler),
    despawnDiagnosticTestFleet: () => diagnosticsProbe.despawnDiagnosticTestFleet(),
    setLobbyGhostMode: (enabled, options) => {
      diagnosticsProbe.configureLobbyGhostMode(enabled, options);
      return diagnosticsProbe.lobbyGhostMode;
    },
    setLatestServerRosterState: (state: string) => {
      sessionCoordinator.latestServerRosterState = state;
    },
    isNetworkTelemetryNotified: () => sessionCoordinator.telemetryNotified,
    markNetworkTelemetryNotified: (notified: boolean) => {
      sessionCoordinator.telemetryNotified = Boolean(notified);
    },
    resetBotKickoffStep: () => {
      if (ctx.botCoordinator) ctx.botCoordinator.botKickoffStep = 0;
    },
    latchJumpSuppression: () => ctx.inputPoller?.latchJumpSuppression?.(),
  };

  const signalHostPort = new Proxy(ctx as unknown as RuntimeSignalHostPort, {
    get(_target, prop) {
      if (prop in overrides) {
        return Reflect.get(overrides, prop, overrides);
      }
      const value = Reflect.get(ctx, prop, ctx);
      return typeof value === 'function' ? value.bind(ctx) : value;
    },
    set(_target, prop, value) {
      if (prop in overrides) {
        return Reflect.set(overrides, prop, value, overrides);
      }
      return Reflect.set(ctx, prop, value, ctx);
    },
  });

  const signalCoordinator = new ReconcilerSignalCoordinator(signalHostPort);

  return {
    diagnosticsProbe,
    sessionCoordinator,
    rosterSyncCoordinator,
    signalCoordinator,
  };
}
