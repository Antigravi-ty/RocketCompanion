import type { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import { getMaterialsConfig } from '../../ui-core/config/materialsConfig';
import {
  useAppStore,
  hudStore,
} from '../runtimeUiPort.ts';
import {
  dismissHostLobbyOngoingNotification,
  type OnlineRosterSnapshotPayload,
} from './OnlineRosterSyncCoordinator.ts';
import type { NetworkDiagnosticsProbe } from './NetworkDiagnosticsProbe.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import {
  OnlineLobbyDualWorldController,
  type OnlineLobbyWorldHostPort,
} from './OnlineLobbyDualWorldController.ts';
import { OnlineMatchReconcilerBinder } from './OnlineMatchReconcilerBinder.ts';
import {
  resolveClientJoinConfig,
  resolveHostSessionLaunchConfig,
  type HandshakeResponseMessage,
  type HostOnlineServerOptions,
  type JoinOnlineServerOptions,
  type NetworkSessionChannelLike,
} from './onlineLobbyTransitionPipeline.ts';

export type NetworkPredictionOptions = {
  redundantHistoryCount?: number;
  enableRedundantInputs?: boolean;
  useBitPacking?: boolean;
  forceFallback?: boolean;
};
export type ReturnToLobbyOptions = { fromServerRoster?: boolean };
export interface RosterUpdateMessage {
  state?: string;
  roster?: OnlineRosterSnapshotPayload | null;
}

export interface OnlineSessionWorldPort extends OnlineLobbyWorldHostPort {
  setCarColor(carIndex: number, hex: string, persistPreference?: boolean): void;
}

export interface OnlineSessionLifecyclePort {
  readonly match: RuntimeMatchState | null;
  readonly trainingOptions: { boostOption?: string; disableGoalReset?: boolean; [key: string]: unknown };
  readonly modeManager: { setMode?(modeName: string): void } | null;
  readonly domEventManager?: { syncPausedAndInputState(): void } | null;
  readonly podiumController: { exitPodium?(): void } | null;
  readonly replayTimelineController: { endReplaySession?(): void } | null;
  isBotMatch: boolean;
  resetKickoff?(): void;
  releaseGoalReplayCameraOverride(): void;
  onSessionReady?(reconciler: PredictionReconciler | null, channel: NetworkSessionChannelLike | null): void;
  onShowNetworkHUD?(): void;
}

export interface OnlineSessionCoordinatorsPort {
  resetReconcilerSignalState(): void;
  bindReconcilerSignals(reconciler: PredictionReconciler): void;
  applyRosterSnapshot(roster: OnlineRosterSnapshotPayload | null): Promise<void>;
  syncHostLobbyNotification(): void;
}

export interface OnlineSessionCoordinatorHostPort {
  readonly world: OnlineSessionWorldPort;
  readonly lifecycle: OnlineSessionLifecyclePort;
  readonly coordinators: OnlineSessionCoordinatorsPort;
}

export class OnlineSessionCoordinator {
  private readonly host: OnlineSessionCoordinatorHostPort;
  private readonly diagnosticsProbe: NetworkDiagnosticsProbe;
  public readonly lobbyDualWorld: OnlineLobbyDualWorldController;
  public readonly reconcilerBinder: OnlineMatchReconcilerBinder;
  authoritativeServer: AuthoritativeServerHost | null = null;
  networkChannel: NetworkSessionChannelLike | null = null;
  networkReconciler: PredictionReconciler | null = null;
  remotePeerCarMap: Map<string, number> = new Map();
  latestServerRosterState = 'lobby';
  telemetryNotified = false;
  clientReplayOverflowPaused = false;

  constructor(host: OnlineSessionCoordinatorHostPort, diagnosticsProbe: NetworkDiagnosticsProbe) {
    this.host = host;
    this.diagnosticsProbe = diagnosticsProbe;
    const { world, coordinators } = this.host;
    this.lobbyDualWorld = new OnlineLobbyDualWorldController(world);
    this.reconcilerBinder = new OnlineMatchReconcilerBinder({
      get physics() { return world.physics; },
      get interpolator() { return world.interpolator; },
      get camera() { return world.camera; },
      bindReconcilerSignals: (reconciler) => coordinators.bindReconcilerSignals(reconciler),
    });
  }

  private teardownActiveReplayAndPodium(): void {
    const { lifecycle } = this.host;
    lifecycle.podiumController?.exitPodium?.();
    lifecycle.replayTimelineController?.endReplaySession?.();
    lifecycle.releaseGoalReplayCameraOverride();
  }

  private resetOnlineReplayRecording(initializeBuffer: boolean): void {
    const physics = this.host.world.physics;
    if (initializeBuffer) physics?.initReplayBuffer?.();
    physics?.clearReplayBuffer?.();
    physics?.setReplayRecordingActive?.(true);
    this.clientReplayOverflowPaused = false;
  }

  private syncStoreOnlineState(matchMode: string | null, sessionPatch?: Record<string, unknown>): void {
    const store = useAppStore?.getState?.();
    if (matchMode) store?.setMatchMode?.(matchMode);
    if (sessionPatch) store?.setOnlineSession?.(sessionPatch);
  }

  private createPredictionReconciler(
    localCarIndex: number,
    visualId: string,
    extraOptions: Record<string, unknown> = {},
    bindHardResync = true,
  ): PredictionReconciler {
    const reconciler = this.reconcilerBinder.createPredictionReconciler(
      this.networkChannel, localCarIndex, visualId, extraOptions, bindHardResync,
    );
    this.networkReconciler = reconciler;
    return reconciler;
  }

  private bindRosterUpdateHandler(isHost: boolean): void {
    if (!this.networkReconciler) return;
    const { lifecycle, coordinators } = this.host;
    this.networkReconciler.onRosterUpdate = async (msg: RosterUpdateMessage) => {
      if (msg?.state) this.latestServerRosterState = msg.state;
      if (msg?.state === 'lobby' && this.latestServerRosterState === 'lobby') {
        const matchState = lifecycle.match?.state;
        const needsReturn = isHost
          ? matchState?.mode === 'match' || matchState?.phase !== 'lobby'
          : matchState?.mode === 'match' || !this.networkReconciler?.lobbyDualWorldMode;
        if (needsReturn) await this.returnOnlineMatchToLobby({ fromServerRoster: true });
        else if (!isHost) await this.diagnosticsProbe.ensureClientLobbyDiagnosticProbes();
      }
      if (msg?.roster && (!msg?.state || msg.state === this.latestServerRosterState)) {
        await coordinators.applyRosterSnapshot(msg.roster);
      }
    };
  }

  private resetMatchStateToFreeplay(phase = 'freeplay'): void {
    const match = this.host.lifecycle.match;
    if (!match?.state) return;
    match.state = {
      ...match.state, mode: 'freeplay', paused: false, phase,
      overtime: false, winner: null, winReason: null, countdown: 0,
    };
  }

  private disposeActiveSessionTransports(preserveChannel: NetworkSessionChannelLike | null = null): void {
    this.networkChannel = this.reconcilerBinder.disposeSessionTransports(
      this.authoritativeServer,
      this.networkChannel,
      this.networkReconciler,
      preserveChannel,
    );
    this.authoritativeServer = null;
    this.networkReconciler = null;
  }

  async enableNetworkPrediction(showHUD = true, options: NetworkPredictionOptions = {}): Promise<PredictionReconciler | null> {
    const { world, lifecycle } = this.host;
    if (!this.networkReconciler) {
      const gameplay = useAppStore?.getState?.()?.gameplay;
      const disableGoalReset = Boolean(
        lifecycle.trainingOptions?.disableGoalReset ?? (gameplay?.goalRestart === false),
      );
      const loopback = await this.reconcilerBinder.bootstrapLoopbackPredictionServer(
        this.lobbyDualWorld.getLocalLoadout(), disableGoalReset, Boolean(options.forceFallback),
      );
      if (!loopback) return null;
      this.authoritativeServer = loopback.server;
      this.networkChannel = loopback.channel;
      this.resetOnlineReplayRecording(true);
      this.createPredictionReconciler(world.playerCarIndex ?? 0, loopback.visualId, { ...options }, false);
      this.reconcilerBinder.syncServerTimelineIfReady(this.authoritativeServer, this.networkReconciler, false);
      lifecycle.onSessionReady?.(this.networkReconciler, this.networkChannel);
    }
    if (showHUD) lifecycle.onShowNetworkHUD?.();
    return this.networkReconciler;
  }

  cleanupOnlineSession(): void {
    const { world, lifecycle, coordinators } = this.host;
    this.telemetryNotified = this.reconcilerBinder.exportSessionTelemetryOnCleanup(
      this.networkReconciler,
      this.telemetryNotified,
    );
    lifecycle.isBotMatch = false;
    this.remotePeerCarMap?.clear?.();
    dismissHostLobbyOngoingNotification();
    this.teardownActiveReplayAndPodium();
    coordinators.resetReconcilerSignalState();
    this.diagnosticsProbe.configureLobbyGhostMode(false);
    this.diagnosticsProbe.setMultiWorldGhostVisible(false);
    this.disposeActiveSessionTransports();
    lifecycle.onSessionReady?.(null, null);
    world.playerCarIndex = 0;
    this.lobbyDualWorld.configureArenaLobbyFlags(false, false, 0);
  }

  async stopOnlineServer(options: { rebindLoopback?: boolean } = {}): Promise<void> {
    const { world, lifecycle } = this.host;
    this.cleanupOnlineSession();
    const physics = world.physics;
    if (physics && physics.numCars > 1) physics.configureCars('default', false, 0);
    this.lobbyDualWorld.hideNonZeroArenaCars();
    this.lobbyDualWorld.applyFreeplayTeamAndColorOnStop();
    const unlimitedBoost =
      useAppStore?.getState?.()?.gameplay?.unlimitedBoost ?? (lifecycle.trainingOptions?.boostOption === 'unlimited');
    physics?.setUnlimitedBoost?.(unlimitedBoost);
    this.resetMatchStateToFreeplay('freeplay');
    lifecycle.modeManager?.setMode?.('freeplay');
    lifecycle.resetKickoff?.();
    world.interpolator?.sync?.(performance.now());
    this.syncStoreOnlineState('freeplay', {
      isHosting: false, roomId: '', signalingConnected: false,
      connectedPeers: [], roomType: 'warmup', isReady: false,
    });
    lifecycle.domEventManager?.syncPausedAndInputState?.();
    if (options.rebindLoopback === true) await this.enableNetworkPrediction(false);
  }

  async hostOnlineServer(options: HostOnlineServerOptions = {}): Promise<AuthoritativeServerHost | null> {
    const { world, lifecycle, coordinators } = this.host;
    if (this.authoritativeServer) await this.stopOnlineServer({ rebindLoopback: false });
    lifecycle.isBotMatch = false;
    this.remotePeerCarMap = new Map();
    const cfg = resolveHostSessionLaunchConfig(
      options, this.lobbyDualWorld.getLocalLoadout(), useAppStore?.getState?.()?.onlineSession, getMaterialsConfig(),
    );
    world.selectedColorSlot = cfg.hostColorSlot;
    world.playerCarIndex = 0;
    this.diagnosticsProbe.setTestCarAudioEnabled(false, true);
    this.lobbyDualWorld.hideNonZeroArenaCars();
    this.resetOnlineReplayRecording(true);
    const bootstrapped = await this.reconcilerBinder.bootstrapHostAuthoritativeServer(
      cfg.serverOptions, cfg.hostVisualId, cfg.isMatchLobby,
    );
    if (!bootstrapped) return null;
    this.authoritativeServer = bootstrapped.server;
    this.networkChannel = bootstrapped.channel;
    this.networkReconciler = bootstrapped.reconciler;
    this.latestServerRosterState = cfg.isMatchLobby ? 'lobby' : 'match';
    this.bindRosterUpdateHandler(true);
    await this.lobbyDualWorld.activateHostLobbyGhostAndFleet(
      cfg.isMatchLobby,
      this.authoritativeServer,
      this.diagnosticsProbe,
      (roster) => coordinators.applyRosterSnapshot(roster),
    );
    this.reconcilerBinder.syncServerTimelineIfReady(this.authoritativeServer, this.networkReconciler, cfg.isMatchLobby);
    lifecycle.onSessionReady?.(this.networkReconciler, this.networkChannel);
    this.syncStoreOnlineState('online-warmup', cfg.onlineSessionPatch);
    coordinators.syncHostLobbyNotification();
    lifecycle.domEventManager?.syncPausedAndInputState?.();
    return this.authoritativeServer;
  }

  async joinOnlineServer(options: JoinOnlineServerOptions = {}): Promise<NetworkSessionChannelLike | null> {
    const { world, lifecycle, coordinators } = this.host;
    const channel = options.channel ?? null;
    const joinCfg = resolveClientJoinConfig(options, this.lobbyDualWorld.getLocalLoadout(), getMaterialsConfig());
    this.disposeActiveSessionTransports(channel);
    this.teardownActiveReplayAndPodium();
    coordinators.resetReconcilerSignalState();
    this.resetMatchStateToFreeplay('lobby');
    lifecycle.modeManager?.setMode?.('freeplay');
    lifecycle.isBotMatch = false;
    this.networkChannel = channel;
    this.reconcilerBinder.applyInitialChannelLatency(this.networkChannel, false);
    await this.lobbyDualWorld.prepareClientJoinLobbyWorld(joinCfg.localVisualId, this.diagnosticsProbe);
    this.resetOnlineReplayRecording(true);
    this.createPredictionReconciler(1, joinCfg.localVisualId, { isMatchTelemetryActive: true });
    this.lobbyDualWorld.activateClientDualWorld(this.networkReconciler, this.diagnosticsProbe);
    this.latestServerRosterState = 'lobby';
    this.bindRosterUpdateHandler(false);
    if (this.networkReconciler) {
      this.networkReconciler.onHandshakeResponse = (msg: HandshakeResponseMessage) =>
        this.reconcilerBinder.handleClientHandshakeResponse({
          msg,
          joinCfg,
          world,
          reconciler: this.networkReconciler,
          lobbyDualWorld: this.lobbyDualWorld,
          diagnosticsProbe: this.diagnosticsProbe,
          match: lifecycle.match,
          modeManager: lifecycle.modeManager,
          applyRosterSnapshot: (roster) => coordinators.applyRosterSnapshot(roster),
          onResetReplayRecording: () => this.resetOnlineReplayRecording(false),
          onUpdateRosterState: (state) => { this.latestServerRosterState = state; },
        });
    }
    lifecycle.onSessionReady?.(this.networkReconciler, this.networkChannel);
    if (this.networkChannel) {
      this.networkChannel.onColorChange = (msg: { carIndex?: number; hex: string }) => {
        const currentPlayerIdx = world.playerCarIndex ?? 0;
        world.setCarColor(msg.carIndex ?? (currentPlayerIdx === 0 ? 1 : 0), msg.hex, false);
      };
      this.networkChannel.send?.(JSON.stringify(joinCfg.joinPayload));
    }
    this.syncStoreOnlineState('online-warmup', {
      isHosting: false, playerName: joinCfg.playerName, signalingConnected: true,
    });
    lifecycle.domEventManager?.syncPausedAndInputState?.();
    return this.networkChannel;
  }

  async returnOnlineMatchToLobby(options: ReturnToLobbyOptions = {}): Promise<void> {
    if (options.fromServerRoster && this.latestServerRosterState && this.latestServerRosterState !== 'lobby') return;
    this.latestServerRosterState = 'lobby';
    const isHost = Boolean(this.authoritativeServer);
    const { world, lifecycle, coordinators } = this.host;
    this.teardownActiveReplayAndPodium();
    const physics = world.physics;
    physics?.resetGoalLatch?.();
    this.resetOnlineReplayRecording(false);
    physics?.setSimulationFrozen?.(false);
    physics?.setUnlimitedBoost?.(true);
    this.resetMatchStateToFreeplay('lobby');
    const matchState = lifecycle.match?.state;
    hudStore?.getState?.()?.setMatchState?.({ matchPhase: 'lobby', kickoffCountdown: 0, winner: null, winReason: null });
    const { resolvedLocalCarIndex, localTeam } = await this.lobbyDualWorld.restoreParticipantAndArenaState(
      this.networkReconciler, isHost,
    );
    const completed = await this.lobbyDualWorld.finalizeLobbyReturnWorldAndProbes({
      isHost, localCarIndex: resolvedLocalCarIndex, localTeam, fromServerRoster: options.fromServerRoster,
      reconciler: this.networkReconciler, authoritativeServer: this.authoritativeServer,
      diagnosticsProbe: this.diagnosticsProbe,
      isStillInLobby: () => this.latestServerRosterState === 'lobby' && matchState?.mode !== 'match',
      syncHostLobbyNotification: () => coordinators.syncHostLobbyNotification(),
    });
    if (!completed) return;
    lifecycle.modeManager?.setMode?.('freeplay');
    this.syncStoreOnlineState('online-warmup');
    lifecycle.domEventManager?.syncPausedAndInputState?.();
  }
}
