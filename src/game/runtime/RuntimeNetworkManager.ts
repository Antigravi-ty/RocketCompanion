import { CLIENT_COMMAND_TYPES } from '../../network/protocol/GlobalPayloadCodec.ts';
import {
  packLoadoutCommandParam1,
  packLoadoutCommandParam2,
} from '../../ui-core/config/vehicleConstants';
import { useAppStore } from '../runtimeUiPort.ts';
import { ReconcilerSignalCoordinator } from './ReconcilerSignalCoordinator.ts';
import {
  OnlineRosterSyncCoordinator,
  type OnlineRosterSnapshotPayload,
  type OnlineRosterSyncHostPort,
} from './OnlineRosterSyncCoordinator.ts';
import type {
  RuntimeSignalHostPort,
  SignalAudioFacadeLike,
} from './RuntimeGoalReplaySignalSubController.ts';
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
import type { LocalPlayerLoadoutSyncRequest } from './RuntimeLoadoutCoordinator.ts';
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

/**
 * Autonomous SubController owning OnlineSessionCoordinator, NetworkDiagnosticsProbe,
 * OnlineRosterSyncCoordinator, and ReconcilerSignalCoordinator through narrow typed host ports.
 */
export class RuntimeNetworkManager {
  readonly runtime: RuntimeNetworkHostPort;
  readonly diagnosticsProbe: NetworkDiagnosticsProbe;
  readonly sessionCoordinator: OnlineSessionCoordinator;
  readonly rosterSyncCoordinator: OnlineRosterSyncCoordinator;
  readonly signalCoordinator: ReconcilerSignalCoordinator;
  diagnosticDumpMaxFrames = 36000;
  diagnosticDumpPauseOnOverflow = true;

  constructor(runtime: RuntimeNetworkHostPort) {
    this.runtime = runtime;
    this.diagnosticsProbe = new NetworkDiagnosticsProbe(this.createDiagnosticsHostPort());
    this.sessionCoordinator = new OnlineSessionCoordinator(
      this.createSessionHostPort(),
      this.diagnosticsProbe,
    );
    this.rosterSyncCoordinator = new OnlineRosterSyncCoordinator(this.createRosterSyncHostPort());
    this.signalCoordinator = new ReconcilerSignalCoordinator(this.createSignalHostPort());
  }

  private createDiagnosticsHostPort(): NetworkDiagnosticsHostPort {
    return {
      getPhysics: () => this.runtime.physics,
      getArena: () => this.runtime.arena,
      getInterpolator: () => this.runtime.interpolator,
      getCamera: () => this.runtime.camera,
      getAuthoritativeServer: () => this.sessionCoordinator.authoritativeServer,
      getNetworkChannel: () => this.sessionCoordinator.networkChannel,
      getNetworkReconciler: () => this.sessionCoordinator.networkReconciler,
      getPlayerCarIndex: () => this.runtime.playerCarIndex ?? 0,
      isMatchPhaseBlockingDiagnosticsFleet: () => {
        const mode = this.runtime.match?.state?.mode;
        const phase = this.runtime.match?.state?.phase;
        return Boolean(mode === 'match' && phase && phase !== 'lobby' && phase !== 'freeplay');
      },
      ensureFlipResetVisual: (carIndex: number) => {
        this.runtime.getFlipResetVisual?.(carIndex);
      },
      notifyDeterminismHarnessReady: (harness, showHUD) => {
        this.runtime.onDeterminismHarnessReady?.(harness, showHUD);
      },
    };
  }

  private createSessionHostPort(): OnlineSessionCoordinatorHostPort {
    return {
      world: this.runtime,
      lifecycle: this.runtime,
      coordinators: {
        resetReconcilerSignalState: () => {
          this.signalCoordinator.resetSignalState();
        },
        bindReconcilerSignals: (reconciler: PredictionReconciler) => {
          this.signalCoordinator.bindReconcilerSignals(reconciler);
        },
        applyRosterSnapshot: async (roster: OnlineRosterSnapshotPayload | null) => {
          await this.rosterSyncCoordinator.applyRosterSnapshot(roster);
        },
        syncHostLobbyNotification: () => {
          this.rosterSyncCoordinator.syncHostLobbyOngoingNotification();
        },
      },
    };
  }

  isLobbyDualWorldActive(
    reconciler: PredictionReconciler | null = this.sessionCoordinator.networkReconciler,
  ): boolean {
    const r = this.runtime;
    return Boolean(
      reconciler?.lobbyDualWorldMode ||
        r.arena?.isLobbyMode ||
        (r.match?.state?.mode !== 'match' && r.match?.state?.phase === 'lobby'),
    );
  }

  private createRosterSyncHostPort(): OnlineRosterSyncHostPort {
    const self = this;
    return {
      world: this.runtime,
      session: {
        get authoritativeServer() {
          return self.sessionCoordinator.authoritativeServer;
        },
        get networkReconciler() {
          return self.sessionCoordinator.networkReconciler;
        },
        get remotePeerCarMap() {
          return self.sessionCoordinator.remotePeerCarMap;
        },
        isLobbyDualWorldActive: () => self.isLobbyDualWorldActive(),
      },
      diagnostics: {
        isDiagnosticFleetEnabled: () =>
          Boolean(self.diagnosticsProbe.diagnosticsFleetController?.enabled),
        spawnDiagnosticTestFleet: (options) =>
          self.diagnosticsProbe.spawnDiagnosticTestFleet(options),
        despawnDiagnosticTestFleet: () => self.diagnosticsProbe.despawnDiagnosticTestFleet(),
      },
    };
  }

  private createSignalHostPort(): RuntimeSignalHostPort {
    const r = this.runtime;
    const self = this;
    const overrides: SignalNetworkOverrides = {
      get authoritativeServer() {
        return self.sessionCoordinator.authoritativeServer;
      },
      get remotePeerCarMap() {
        return self.sessionCoordinator.remotePeerCarMap;
      },
      get clientReplayOverflowPaused() {
        return self.sessionCoordinator.clientReplayOverflowPaused;
      },
      set clientReplayOverflowPaused(val: boolean) {
        self.sessionCoordinator.clientReplayOverflowPaused = Boolean(val);
      },
      getLastRosterSnapshot: () => self.rosterSyncCoordinator.lastRosterSnapshot,
      getParticipantTeams: () => self.rosterSyncCoordinator.participantTeams,
      syncHostLobbyOngoingNotification: () =>
        self.rosterSyncCoordinator.syncHostLobbyOngoingNotification(),
      isLobbyDualWorldActive: (reconciler) => self.isLobbyDualWorldActive(reconciler),
      despawnDiagnosticTestFleet: () => self.diagnosticsProbe.despawnDiagnosticTestFleet(),
      setLobbyGhostMode: (enabled, options) => {
        self.diagnosticsProbe.configureLobbyGhostMode(enabled, options);
        return self.diagnosticsProbe.lobbyGhostMode;
      },
      setLatestServerRosterState: (state: string) => {
        self.sessionCoordinator.latestServerRosterState = state;
      },
      isNetworkTelemetryNotified: () => self.sessionCoordinator.telemetryNotified,
      markNetworkTelemetryNotified: (notified: boolean) => {
        self.sessionCoordinator.telemetryNotified = Boolean(notified);
      },
      resetBotKickoffStep: () => {
        if (r.botCoordinator) r.botCoordinator.botKickoffStep = 0;
      },
      latchJumpSuppression: () => r.inputPoller?.latchJumpSuppression?.(),
    };

    return new Proxy(r as unknown as RuntimeSignalHostPort, {
      get(_target, prop, _receiver) {
        if (prop in overrides) {
          return Reflect.get(overrides, prop, overrides);
        }
        const value = Reflect.get(r, prop, r);
        return typeof value === 'function' ? value.bind(r) : value;
      },
      set(_target, prop, value) {
        if (prop in overrides) {
          return Reflect.set(overrides, prop, value, overrides);
        }
        return Reflect.set(r, prop, value, r);
      },
    });
  }

  syncLocalPlayerLoadout(request: LocalPlayerLoadoutSyncRequest): void {
    const playerCarIndex = this.runtime.playerCarIndex ?? 0;
    const server = this.sessionCoordinator.authoritativeServer;
    const reconciler = this.sessionCoordinator.networkReconciler;
    const channel = this.sessionCoordinator.networkChannel;

    if (request.updateVisualPreset && reconciler) {
      reconciler.setCarVisualPreset?.(playerCarIndex, request.visualId);
    }

    if (request.carIndex === playerCarIndex) {
      server?.setLoadout?.(
        'host',
        request.visualId,
        request.colorSlotId,
        request.hitboxId,
        {
          paintFinish: request.paintFinish,
          boostVisual: request.boostVisual,
          boostAudio: request.boostAudio,
        },
      );
      reconciler?.controlMessenger.enqueueClientCommand(
        CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
        packLoadoutCommandParam1(request.visualId, request.hitboxId),
        packLoadoutCommandParam2(
          request.colorSlotId,
          request.paintFinish,
          request.boostVisual,
          request.boostAudio,
        ),
      );
    }

    if (request.broadcastColorHex && channel?.sendColorChange) {
      try {
        channel.sendColorChange(request.colorSlotId, request.broadcastColorHex, request.carIndex);
      } catch (err) {
        console.error('[GameRuntime] Failed to broadcast color change over network channel:', err);
      }
    }
  }

  forceStartOnlineMatch(durationSeconds = 300): void {
    this.rosterSyncCoordinator.dismissHostLobbyOngoingNotification();
    const server = this.sessionCoordinator.authoritativeServer;
    const reconciler = this.sessionCoordinator.networkReconciler;
    if (server) {
      this.diagnosticsProbe.despawnDiagnosticTestFleet();
      server.forceStartMatch(durationSeconds);
    } else if (reconciler) {
      reconciler.controlMessenger.enqueueClientCommand(CLIENT_COMMAND_TYPES.CMD_READY_ACK, 1, durationSeconds);
    }
  }

  setOnlineGameMode(gameMode = '3v3', durationSeconds: number | null = null): void {
    const resolvedDuration =
      durationSeconds ?? useAppStore?.getState?.()?.onlineSession?.matchDurationSeconds ?? 300;
    this.sessionCoordinator.authoritativeServer?.setGameMode(gameMode, resolvedDuration);
    useAppStore?.getState?.()?.setOnlineSession({ gameMode });
    this.rosterSyncCoordinator.syncHostLobbyOngoingNotification();
  }

  setOnlineMatchDuration(durationSeconds = 300): void {
    const cleanDuration = Math.max(0, Number(durationSeconds) || 0);
    const currentGameMode = useAppStore?.getState?.()?.onlineSession?.gameMode || '1v1';
    this.sessionCoordinator.authoritativeServer?.setGameMode(currentGameMode, cleanDuration);
    useAppStore?.getState?.()?.setOnlineSession({ matchDurationSeconds: cleanDuration });
    this.rosterSyncCoordinator.syncHostLobbyOngoingNotification();
  }

  setOnlineBotFillMode(botFillMode = 'no_bots'): void {
    this.sessionCoordinator.authoritativeServer?.setBotFillMode?.(botFillMode);
    useAppStore?.getState?.()?.setOnlineSession({ botFillMode });
  }

  addOnlineBot(team: number | null = 1, botName: string | null = null): void {
    this.sessionCoordinator.authoritativeServer?.addBotPlayer?.(team ?? 1, botName);
  }

  setClientReady(ready = true): void {
    this.sessionCoordinator.networkReconciler?.controlMessenger.enqueueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_READY_ACK,
      ready ? 1 : 0,
      0,
    );
  }

  voteSkipReplay(): void {
    this.sessionCoordinator.networkReconciler?.controlMessenger.enqueueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_VOTE_SKIP_REPLAY,
      1,
      0,
    );
  }

  voteRematch(ready = true): void {
    this.sessionCoordinator.networkReconciler?.controlMessenger.enqueueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_VOTE_REMATCH,
      ready ? 1 : 0,
      0,
    );
  }

  switchOnlineRoleOrTeam(role = 'player', team = 0): void {
    const roleCode = role === 'spectator' ? 2 : 0;
    const server = this.sessionCoordinator.authoritativeServer;
    const reconciler = this.sessionCoordinator.networkReconciler;
    if (server) {
      server.switchRoleTeam('host', role, team);
    } else if (reconciler) {
      reconciler.controlMessenger.enqueueClientCommand(CLIENT_COMMAND_TYPES.CMD_SWITCH_ROLE_TEAM, roleCode, team);
    }
  }
}
