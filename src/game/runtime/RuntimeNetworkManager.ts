import { CLIENT_COMMAND_TYPES } from '../../network/protocol/GlobalPayloadCodec.ts';
import { useAppStore } from '../runtimeUiPort.ts';
import { ReconcilerSignalCoordinator } from './ReconcilerSignalCoordinator.ts';
import {
  OnlineRosterSyncCoordinator,
  type OnlineRosterSnapshotPayload,
  type OnlineRosterSyncHostPort,
} from './OnlineRosterSyncCoordinator.ts';
import type { RuntimeSignalHostPort, SignalAudioFacadeLike } from './RuntimeGoalReplaySignalSubController.ts';
import {
  NetworkDiagnosticsProbe,
  type NetworkDiagnosticsHostPort,
} from './NetworkDiagnosticsProbe.ts';
import { OnlineSessionCoordinator } from './OnlineSessionCoordinator.ts';
import type {
  NetworkSessionChannelLike,
  OnlineSessionHostPort,
} from './onlineLobbyTransitionPipeline.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { EntityManager } from '../../entities/EntityManager.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import type { PodiumCelebrationController } from '../modes/PodiumCelebrationController.ts';
import type { SimulationStage } from '../pipeline/stages/SimulationStage.ts';
import type { GameAudioSubsystem } from '../subsystems/GameAudioSubsystem.ts';
import type { DeterminismHarness } from '../../physics/DeterminismHarness.ts';
import type { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.ts';

export interface RuntimeNetworkHostPort {
  readonly arena: ArenaWorld | null;
  readonly physics: RocketSimPhysicsEngine | null;
  readonly entityManager: EntityManager | null;
  readonly interpolator: PhysicsStateInterpolator | null;
  readonly camera: CameraManager | null;
  readonly match: RuntimeMatchState | null;
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
  readonly trainingOptions: { boostOption?: string; [key: string]: unknown };
  playerCarIndex: number;
  isBotMatch: boolean;
  selectedPreset: string;
  selectedHitbox: string | null;
  selectedColorSlot: number | null;
  _clientGoalIncidentLatched: boolean;
  _localSkipReplayReady: boolean;
  readonly botCoordinator?: { botKickoffStep: number } | null;
  readonly domEventManager?: { syncPausedAndInputState(): void } | null;
  readonly cameraSubsystem?: { cameraDynamics: object | null } | null;
  readonly inputPoller?: { latchJumpSuppression?(): void } | null;
  getFlipResetVisual?(carIndex: number): { play(): void; stopVisual(): void } | null;
  resetKickoff?(): void;
  resetAudio?(): void;
  setCarColor(carIndex: number, hex: string, persistPreference?: boolean): void;
  isGoalReplayCameraOverrideActive(): boolean;
  acquireGoalReplayCameraOverride(source?: string): void;
  releaseGoalReplayCameraOverride(source?: string | null): void;
  replayPovCarIndex?: number | null;
  onDeterminismHarnessReady?(harness: DeterminismHarness, showHUD: boolean): void;
  onSessionReady?(
    reconciler: PredictionReconciler | null,
    channel: NetworkSessionChannelLike | null,
  ): void;
  onShowNetworkHUD?(): void;
}

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

  private createSessionHostPort(): OnlineSessionHostPort {
    return {
      getPhysics: () => this.runtime.physics,
      getArena: () => this.runtime.arena,
      getInterpolator: () => this.runtime.interpolator,
      getCamera: () => this.runtime.camera,
      getCameraDynamics: () => this.runtime.cameraSubsystem?.cameraDynamics ?? null,
      getPlayerCarIndex: () => this.runtime.playerCarIndex ?? 0,
      setPlayerCarIndex: (carIndex: number) => { this.runtime.playerCarIndex = carIndex; },
      setIsBotMatch: (isBotMatch: boolean) => { this.runtime.isBotMatch = Boolean(isBotMatch); },
      getLocalVehicleLoadout: () => ({
        selectedPreset: this.runtime.selectedPreset,
        selectedHitbox: this.runtime.selectedHitbox,
        selectedColorSlot: this.runtime.selectedColorSlot,
      }),
      setSelectedColorSlot: (slot: number) => { this.runtime.selectedColorSlot = slot; },
      getDefaultFreeplayUnlimitedBoost: () =>
        this.runtime.trainingOptions?.boostOption === 'unlimited',
      getDisableGoalReset: () => Boolean(this.runtime.trainingOptions?.disableGoalReset),
      getMatchState: () => this.runtime.match?.state ?? null,
      setActiveGameMode: (modeId: string) => { this.runtime.modeManager?.setMode?.(modeId); },
      resetKickoff: () => { this.runtime.resetKickoff?.(); },
      syncPausedAndInputState: () => { this.runtime.domEventManager?.syncPausedAndInputState?.(); },
      teardownActiveReplayAndPodium: () => {
        this.runtime.podiumController?.exitPodium?.();
        this.runtime.replayTimelineController?.endReplaySession?.();
        this.runtime.releaseGoalReplayCameraOverride?.();
      },
      resetReconcilerSignalState: () => { this.signalCoordinator.resetSignalState(); },
      bindReconcilerSignals: (reconciler: PredictionReconciler) => {
        this.signalCoordinator.bindReconcilerSignals(reconciler);
      },
      applyRosterSnapshot: async (roster: OnlineRosterSnapshotPayload | null) => {
        await this.rosterSyncCoordinator.applyRosterSnapshot(roster);
      },
      ensureFlipResetVisual: (carIndex: number) => { this.runtime.getFlipResetVisual?.(carIndex); },
      applyRemoteCarColor: (carIndex: number, hex: string) => {
        this.runtime.setCarColor?.(carIndex, hex, false);
      },
      notifySessionReady: (reconciler, channel) => {
        this.runtime.onSessionReady?.(reconciler, channel);
      },
      notifyShowNetworkHUD: () => { this.runtime.onShowNetworkHUD?.(); },
      syncHostLobbyNotification: () => {
        this.rosterSyncCoordinator.syncHostLobbyOngoingNotification();
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
    const r = this.runtime;
    const self = this;
    return {
      get authoritativeServer() { return self.sessionCoordinator.authoritativeServer; },
      get isBotMatch() { return r.isBotMatch; },
      get arena() { return r.arena; },
      get match() { return r.match; },
      get networkReconciler() { return self.sessionCoordinator.networkReconciler; },
      get multiplayerSession() { return r.multiplayerSession; },
      get physics() { return r.physics; },
      get entityManager() { return r.entityManager; },
      get interpolator() { return r.interpolator; },
      get options() { return r.options ?? {}; },
      get flipResetVisuals() { return r.flipResetVisuals; },
      get remotePeerCarMap() { return self.sessionCoordinator.remotePeerCarMap; },
      get playerCarIndex() { return r.playerCarIndex; },
      get selectedColorSlot() { return r.selectedColorSlot; },
      set selectedColorSlot(val: number | null) { r.selectedColorSlot = val; },
      isLobbyDualWorldActive: () => self.isLobbyDualWorldActive(),
      isDiagnosticFleetEnabled: () => Boolean(self.diagnosticsProbe.diagnosticsFleetController?.enabled),
      spawnDiagnosticTestFleet: (options) => self.diagnosticsProbe.spawnDiagnosticTestFleet(options),
      despawnDiagnosticTestFleet: () => self.diagnosticsProbe.despawnDiagnosticTestFleet(),
      setCarColor: (carIndex: number, hexColor: string, persistPreference = true) =>
        r.setCarColor(carIndex, hexColor, persistPreference),
    };
  }

  private createSignalHostPort(): RuntimeSignalHostPort {
    const r = this.runtime;
    const self = this;
    return {
      get arena() { return r.arena; },
      get physics() { return r.physics; },
      get entityManager() { return r.entityManager; },
      get options() { return r.options; },
      get flipResetVisuals() { return r.flipResetVisuals; },
      get match() { return r.match; },
      get modeManager() { return r.modeManager; },
      get replayTimelineController() { return r.replayTimelineController; },
      get podiumController() { return r.podiumController; },
      get camera() { return r.camera; },
      get interpolator() { return r.interpolator; },
      get simulationStage() { return r.simulationStage; },
      get audioSubsystem() { return r.audioSubsystem; },
      get authoritativeServer() { return self.sessionCoordinator.authoritativeServer; },
      get remotePeerCarMap() { return self.sessionCoordinator.remotePeerCarMap; },
      get playerCarIndex() { return r.playerCarIndex; },
      set playerCarIndex(val: number) { r.playerCarIndex = val; },
      get selectedColorSlot() { return r.selectedColorSlot; },
      set selectedColorSlot(val: number | null) { r.selectedColorSlot = val; },
      get clientReplayOverflowPaused() { return self.sessionCoordinator.clientReplayOverflowPaused; },
      set clientReplayOverflowPaused(val: boolean) { self.sessionCoordinator.clientReplayOverflowPaused = Boolean(val); },
      get _clientGoalIncidentLatched() { return r._clientGoalIncidentLatched; },
      set _clientGoalIncidentLatched(val: boolean) { r._clientGoalIncidentLatched = Boolean(val); },
      get _localSkipReplayReady() { return r._localSkipReplayReady; },
      set _localSkipReplayReady(val: boolean) { r._localSkipReplayReady = Boolean(val); },
      getLastRosterSnapshot: () => self.rosterSyncCoordinator.lastRosterSnapshot,
      getParticipantTeams: () => self.rosterSyncCoordinator.participantTeams,
      syncHostLobbyOngoingNotification: () =>
        self.rosterSyncCoordinator.syncHostLobbyOngoingNotification(),
      isLobbyDualWorldActive: (reconciler) =>
        self.isLobbyDualWorldActive(reconciler),
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
      isGoalReplayCameraOverrideActive: () => r.isGoalReplayCameraOverrideActive(),
      acquireGoalReplayCameraOverride: (source = 'default') =>
        r.acquireGoalReplayCameraOverride(source),
      releaseGoalReplayCameraOverride: (source = null) => r.releaseGoalReplayCameraOverride(source),
      get replayPovCarIndex() { return r.replayPovCarIndex ?? null; },
      set replayPovCarIndex(val: number | null) { r.replayPovCarIndex = val; },
      getFlipResetVisual: (carIdx: number) => r.getFlipResetVisual?.(carIdx) ?? null,
      resetAudio: () => r.resetAudio?.(),
      latchJumpSuppression: () => r.inputPoller?.latchJumpSuppression?.(),
      setCarColor: (carIndex: number, hexColor: string, persistPreference = true) =>
        r.setCarColor(carIndex, hexColor, persistPreference),
    };
  }

  forceStartOnlineMatch(durationSeconds = 300): void {
    this.rosterSyncCoordinator.dismissHostLobbyOngoingNotification();
    const server = this.sessionCoordinator.authoritativeServer;
    const reconciler = this.sessionCoordinator.networkReconciler;
    if (server) {
      this.diagnosticsProbe.despawnDiagnosticTestFleet();
      server.forceStartMatch(durationSeconds);
    } else if (reconciler) {
      reconciler.queueClientCommand(CLIENT_COMMAND_TYPES.CMD_READY_ACK, 1, durationSeconds);
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
    this.sessionCoordinator.networkReconciler?.queueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_READY_ACK,
      ready ? 1 : 0,
      0,
    );
  }

  voteSkipReplay(): void {
    this.sessionCoordinator.networkReconciler?.queueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_VOTE_SKIP_REPLAY,
      1,
      0,
    );
  }

  voteRematch(ready = true): void {
    this.sessionCoordinator.networkReconciler?.queueClientCommand(
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
      reconciler.queueClientCommand(CLIENT_COMMAND_TYPES.CMD_SWITCH_ROLE_TEAM, roleCode, team);
    }
  }
}
