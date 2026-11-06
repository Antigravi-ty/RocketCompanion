import { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.ts';
import { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import { CLIENT_COMMAND_TYPES } from '../../network/protocol/GlobalPayloadCodec.ts';
import { packLoadoutCommandParam1, packLoadoutCommandParam2 } from '../../ui-core/config/vehicleConstants';
import { getMaterialsConfig } from '../../ui-core/config/materialsConfig';
import {
  useAppStore, hudStore, networkDiagnosticsStore,
  snapshotCurrentTelemetryPayload, notifyNetworkTelemetryExportAvailable,
} from '../runtimeUiPort.ts';
import { dismissHostLobbyOngoingNotification, type OnlineRosterSnapshotPayload } from './OnlineRosterSyncCoordinator.ts';
import type { NetworkDiagnosticsProbe } from './NetworkDiagnosticsProbe.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import {
  applyFreeplayTeamAndColorOnStop, ensureValidClientLobbyLocalCarPose, resetLobbyWorldPhysicsPose,
  resolveClientHandshakeTransition, resolveClientJoinConfig, resolveHandshakeTeamColorSlot,
  resolveHostSessionLaunchConfig, resolveLoadoutDefaults, resolveSessionClockPacingConfig,
  restoreOnlineLobbyParticipantAndArenaState,
  type HandshakeResponseMessage, type HostOnlineServerOptions, type JoinOnlineServerOptions,
  type LocalVehicleLoadoutState, type NetworkSessionChannelLike, type OnlineSessionHostPort,
} from './onlineLobbyTransitionPipeline.ts';

export type NetworkPredictionOptions = {
  redundantHistoryCount?: number;
  enableRedundantInputs?: boolean;
  useBitPacking?: boolean;
  forceFallback?: boolean;
};
export type ReturnToLobbyOptions = { fromServerRoster?: boolean };
export interface RosterUpdateMessage { state?: string; roster?: OnlineRosterSnapshotPayload | null; }

export interface OnlineSessionWorldPort {
  readonly physics: RocketSimPhysicsEngine | null;
  readonly arena: ArenaWorld | null;
  readonly interpolator: PhysicsStateInterpolator | null;
  readonly camera: CameraManager | null;
  readonly cameraSubsystem?: { cameraDynamics: object | null } | null;
  playerCarIndex: number;
  selectedPreset: string;
  selectedHitbox: string | null;
  selectedColorSlot: number | null;
  getFlipResetVisual?(carIndex: number): unknown;
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
  private readonly transitionPort: OnlineSessionHostPort;
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
    const { world } = this.host;
    this.transitionPort = {
      getPhysics: () => world.physics,
      getArena: () => world.arena,
      getPlayerCarIndex: () => world.playerCarIndex ?? 0,
      setPlayerCarIndex: (idx: number) => { world.playerCarIndex = idx; },
      getLocalVehicleLoadout: () => this.getLocalLoadout(),
      setSelectedColorSlot: (slot: number) => { world.selectedColorSlot = slot; },
    } as OnlineSessionHostPort;
  }

  private getLocalLoadout(): LocalVehicleLoadoutState {
    const { selectedPreset, selectedHitbox, selectedColorSlot } = this.host.world;
    return { selectedPreset, selectedHitbox, selectedColorSlot };
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

  private configureArenaLobbyFlags(isLobbyMode: boolean, isHostLobby: boolean, playerCarIndex?: number): void {
    const arena = this.host.world.arena;
    if (!arena) return;
    if (typeof playerCarIndex === 'number') arena.playerCarIndex = playerCarIndex;
    arena.isLobbyMode = isLobbyMode;
    arena.isHostLobby = isHostLobby;
  }

  private activateClientDualWorldLobby(): void {
    if (!this.networkReconciler) return;
    this.networkReconciler.hostLobbyMode = false;
    this.networkReconciler.setLobbyDualWorldMode?.(true);
    this.networkReconciler.setMatchTelemetryActive?.(true, true);
    this.diagnosticsProbe.ensureLobbyRemoteGhostWorld();
  }

  private hideNonZeroArenaCars(): void {
    const cars = this.host.world.arena?.cars;
    if (!cars) return;
    if (cars[0]) cars[0].visible = true;
    for (let i = 1; i < cars.length; i++) if (cars[i]) cars[i].visible = false;
  }

  private focusCameraOnCar(carIndex: number): void {
    const { world } = this.host;
    const targetCarMesh = world.arena?.cars?.[carIndex];
    if (!targetCarMesh || !world.arena) return;
    targetCarMesh.visible = true;
    world.getFlipResetVisual?.(carIndex);
    world.camera?.update?.(targetCarMesh, world.arena.ball, 0, world.cameraSubsystem?.cameraDynamics ?? {});
  }

  private configureClientLobbyLocalCar(carIndex: number, team: number, visualId: string, forceReset: boolean): void {
    const physics = this.host.world.physics;
    if (!physics) return;
    if (typeof physics.addCarAtSlot === 'function') physics.addCarAtSlot(carIndex, team, visualId);
    else if (physics.numCars <= carIndex) {
      while (physics.numCars <= carIndex) physics.addCar(physics.numCars % 2, visualId);
    } else physics.setCarHitbox?.(carIndex, visualId);
    this.isolateNonLocalLobbyCars(carIndex);
    physics.setCarTeam?.(carIndex, team);
    physics.setCarCollisionMask?.(carIndex, true, false);
    physics.setCarLinearFactorAndGravity?.(carIndex, 1, 1, 1, 1);
    ensureValidClientLobbyLocalCarPose(physics, carIndex, team, forceReset);
  }

  private applyInitialChannelLatency(channel: NetworkSessionChannelLike | null, asymmetric: boolean): void {
    if (!channel) return;
    const metrics = networkDiagnosticsStore?.getSnapshot?.()?.metrics;
    if (asymmetric) {
      const uplink = metrics?.extraUplinkMs ?? metrics?.extraLatencyMs ?? 0;
      const downlink = metrics?.extraDownlinkMs ?? metrics?.extraLatencyMs ?? 0;
      if (uplink > 0 || downlink > 0) {
        if (typeof channel.setAsymmetricLatency === 'function') channel.setAsymmetricLatency(uplink, downlink);
        else { channel.extraUplinkMs = uplink; channel.extraDownlinkMs = downlink; }
      }
      return;
    }
    const extraLatency = metrics?.extraLatencyMs ?? 0;
    if (extraLatency > 0) {
      if (typeof channel.setExtraLatency === 'function') channel.setExtraLatency(extraLatency);
      else channel.extraLatencyMs = extraLatency;
    }
  }

  private createPredictionReconciler(
    localCarIndex: number, visualId: string, extraOptions: Record<string, unknown> = {}, bindHardResync = true,
  ): PredictionReconciler {
    const { world, coordinators } = this.host;
    const pacing = resolveSessionClockPacingConfig();
    const reconciler = new PredictionReconciler(world.physics, this.networkChannel, {
      localCarIndex, interpolator: world.interpolator,
      redundantHistoryCount: (extraOptions.redundantHistoryCount as number) ?? 10,
      enableRedundantInputs: (extraOptions.enableRedundantInputs as boolean) ?? true,
      useBitPacking: (extraOptions.useBitPacking as boolean) ?? false,
      clockPacingMode: pacing.mode, clockPacingPriority: pacing.priority, clockPacingParams: pacing.params,
      inputBufferTarget: pacing.target, catchupThresholdOffset: pacing.threshold[0],
      skipThresholdOffset: pacing.threshold[1], ...extraOptions,
    });
    reconciler.setCarVisualPreset(localCarIndex, visualId);
    coordinators.bindReconcilerSignals(reconciler);
    if (bindHardResync) {
      reconciler.onHardResync = () => {
        world.interpolator?.sync?.(performance.now());
        const p = world.camera?.camera?.position;
        if (p && (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))) world.camera?.resetView?.();
      };
    }
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

  private syncServerTimelineIfReady(requireActiveCar: boolean): void {
    if (!this.authoritativeServer || !this.networkReconciler) return;
    const serverSnapshot = this.authoritativeServer.sim.saveCompactState();
    const serverTick = Math.floor(this.authoritativeServer.sim.getHeaderView().tickCount);
    if (!requireActiveCar || (serverSnapshot && serverSnapshot[2] >= 1)) {
      this.networkReconciler.syncTimeline(serverSnapshot, serverTick);
    }
  }

  private isolateNonLocalLobbyCars(localCarIndex: number): void {
    const { physics, arena } = this.host.world;
    for (let slotIndex = 0; slotIndex < 6; slotIndex++) {
      if (slotIndex !== localCarIndex) {
        if (physics?.isCarSlotActive?.(slotIndex)) physics.removeCar?.(slotIndex);
        if (arena?.cars?.[slotIndex]) arena.cars[slotIndex].visible = false;
      } else if (arena?.cars?.[slotIndex]) arena.cars[slotIndex].visible = true;
    }
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
    if (this.authoritativeServer) {
      try { this.authoritativeServer.destroy?.(); } catch (err) {
        console.warn('[OnlineSessionCoordinator] Error destroying authoritative server:', err);
      }
      this.authoritativeServer = null;
    }
    if (this.networkChannel && this.networkChannel !== preserveChannel) {
      try { this.networkChannel.destroy?.(); } catch (err) {
        console.warn('[OnlineSessionCoordinator] Error destroying network channel:', err);
      }
      this.networkChannel = null;
    }
    if (this.networkReconciler) {
      this.networkReconciler.setMatchTelemetryActive?.(false, false);
      this.networkReconciler = null;
    }
  }

  async enableNetworkPrediction(showHUD = true, options: NetworkPredictionOptions = {}): Promise<PredictionReconciler | null> {
    const { world, lifecycle } = this.host;
    if (!this.networkReconciler) {
      const ld = resolveLoadoutDefaults({}, this.getLocalLoadout(), getMaterialsConfig());
      const physics = world.physics;
      if (!physics) return null;
      const gameplay = useAppStore?.getState?.()?.gameplay;
      const disableGoalReset = Boolean(lifecycle.trainingOptions?.disableGoalReset ?? (gameplay?.goalRestart === false));
      const compactState = physics.saveCompactState();
      const trainingOptions = {
        unlimitedBoost: physics.isUnlimitedBoost,
        fifoDurationSeconds: 30,
        goalReplayEnabled: !disableGoalReset,
      };
      this.authoritativeServer = new AuthoritativeServerHost(null, {
        snapshotInterval: 1, forceFallback: Boolean(options.forceFallback),
        hostVisualId: ld.visualId, hostHitboxId: ld.hitboxId,
        hostPaintFinish: ld.paintFinish, hostBoostVisual: ld.boostVisual, hostBoostAudio: ld.boostAudio,
        initialState: Array.from(compactState), trainingOptions,
      });
      await this.authoritativeServer.init();
      this.networkChannel = this.authoritativeServer.channel as NetworkSessionChannelLike;
      this.applyInitialChannelLatency(this.networkChannel, true);
      this.authoritativeServer.sim.setUnlimitedBoost(physics.isUnlimitedBoost);
      this.authoritativeServer.configureTrainingRuleset?.(trainingOptions);
      this.authoritativeServer.sim.restoreState(compactState);
      this.resetOnlineReplayRecording(true);
      this.createPredictionReconciler(world.playerCarIndex ?? 0, ld.visualId, { ...options }, false);
      this.syncServerTimelineIfReady(false);
      lifecycle.onSessionReady?.(this.networkReconciler, this.networkChannel);
    }
    if (showHUD) lifecycle.onShowNetworkHUD?.();
    return this.networkReconciler;
  }

  cleanupOnlineSession(): void {
    const { world, lifecycle, coordinators } = this.host;
    const telemetryRecorder = this.networkReconciler?.telemetryCollector.recorder;
    if (telemetryRecorder && telemetryRecorder.count > 0) {
      const wasEvicted = Boolean(networkDiagnosticsStore?.getSnapshot?.()?.metrics?.disconnectEvicted);
      if (wasEvicted && !this.telemetryNotified) {
        this.telemetryNotified = true;
        notifyNetworkTelemetryExportAvailable('disconnected', telemetryRecorder);
      } else snapshotCurrentTelemetryPayload(telemetryRecorder);
    }
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
    this.configureArenaLobbyFlags(false, false, 0);
  }

  async stopOnlineServer(options: { rebindLoopback?: boolean } = {}): Promise<void> {
    const { world, lifecycle } = this.host;
    this.cleanupOnlineSession();
    const physics = world.physics;
    if (physics && physics.numCars > 1) physics.configureCars('default', false, 0);
    this.hideNonZeroArenaCars();
    applyFreeplayTeamAndColorOnStop(this.transitionPort);
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
    if (options.rebindLoopback === true) {
      await this.enableNetworkPrediction(false);
    }
  }

  async hostOnlineServer(options: HostOnlineServerOptions = {}): Promise<AuthoritativeServerHost | null> {
    const { world, lifecycle, coordinators } = this.host;
    if (this.authoritativeServer) await this.stopOnlineServer({ rebindLoopback: false });
    lifecycle.isBotMatch = false;
    this.remotePeerCarMap = new Map();
    const cfg = resolveHostSessionLaunchConfig(
      options, this.getLocalLoadout(), useAppStore?.getState?.()?.onlineSession, getMaterialsConfig(),
    );
    world.selectedColorSlot = cfg.hostColorSlot;
    this.diagnosticsProbe.setTestCarAudioEnabled(false, true);
    this.hideNonZeroArenaCars();
    const physics = world.physics;
    if (!physics) return null;
    if (physics.numCars > 1) {
      physics.configureCars('default', false, 0);
      physics.resetKickoff();
    }
    physics.setUnlimitedBoost(true);
    this.authoritativeServer = new AuthoritativeServerHost(null, {
      ...cfg.serverOptions, initialState: Array.from(physics.saveCompactState()),
    });
    await this.authoritativeServer.init();
    this.authoritativeServer.sim.setUnlimitedBoost(true);
    this.configureArenaLobbyFlags(cfg.isMatchLobby, cfg.isMatchLobby);
    if (cfg.isMatchLobby) this.diagnosticsProbe.configureLobbyGhostMode(true, { hostInteractsWithBall: true });
    else this.diagnosticsProbe.configureLobbyGhostMode(false);
    this.networkChannel = this.authoritativeServer.channel as NetworkSessionChannelLike;
    this.applyInitialChannelLatency(this.networkChannel, false);
    world.playerCarIndex = 0;
    this.resetOnlineReplayRecording(true);
    this.createPredictionReconciler(0, cfg.hostVisualId, {
      hostLobbyMode: cfg.isMatchLobby, isMatchTelemetryActive: true,
    });
    this.latestServerRosterState = cfg.isMatchLobby ? 'lobby' : 'match';
    this.bindRosterUpdateHandler(true);
    this.syncServerTimelineIfReady(cfg.isMatchLobby);
    const initialRoster = (
      this.authoritativeServer?.lastRoomState as { roster?: OnlineRosterSnapshotPayload } | null
    )?.roster;
    if (initialRoster) await coordinators.applyRosterSnapshot(initialRoster);
    if (cfg.isMatchLobby) {
      await this.diagnosticsProbe.spawnDiagnosticTestFleet();
      networkDiagnosticsStore?.syncZeroGFleetState?.(true);
    }
    this.syncServerTimelineIfReady(cfg.isMatchLobby);
    lifecycle.onSessionReady?.(this.networkReconciler, this.networkChannel);
    this.syncStoreOnlineState('online-warmup', cfg.onlineSessionPatch);
    coordinators.syncHostLobbyNotification();
    lifecycle.domEventManager?.syncPausedAndInputState?.();
    return this.authoritativeServer;
  }

  async joinOnlineServer(options: JoinOnlineServerOptions = {}): Promise<NetworkSessionChannelLike | null> {
    const { world, lifecycle, coordinators } = this.host;
    const channel = options.channel ?? null;
    const joinCfg = resolveClientJoinConfig(options, this.getLocalLoadout(), getMaterialsConfig());
    this.disposeActiveSessionTransports(channel);
    this.teardownActiveReplayAndPodium();
    coordinators.resetReconcilerSignalState();
    this.resetMatchStateToFreeplay('lobby');
    lifecycle.modeManager?.setMode?.('freeplay');
    lifecycle.isBotMatch = false;
    world.playerCarIndex = 1;
    this.networkChannel = channel;
    this.applyInitialChannelLatency(this.networkChannel, false);
    const physics = world.physics;
    physics?.setUnlimitedBoost?.(true);
    this.diagnosticsProbe.setTestCarAudioEnabled(true, true);
    await world.arena?.ensureOpponent?.();
    this.configureArenaLobbyFlags(true, false, 1);
    this.configureClientLobbyLocalCar(1, 1, joinCfg.localVisualId, true);
    physics?.setBallState?.({ pos: [0, 0, 93.15], vel: [0, 0, 0], angVel: [0, 0, 0] });
    await this.diagnosticsProbe.ensureClientLobbyDiagnosticProbes();
    this.focusCameraOnCar(1);
    world.interpolator?.sync?.(performance.now());
    this.resetOnlineReplayRecording(true);
    this.createPredictionReconciler(1, joinCfg.localVisualId, { isMatchTelemetryActive: true });
    this.activateClientDualWorldLobby();
    this.latestServerRosterState = 'lobby';
    this.bindRosterUpdateHandler(false);
    if (this.networkReconciler) {
      this.networkReconciler.onHandshakeResponse = (msg: HandshakeResponseMessage) =>
        this.handleClientHandshakeResponse(msg, joinCfg);
    }
    lifecycle.onSessionReady?.(this.networkReconciler, this.networkChannel);
    if (this.networkChannel) {
      this.networkChannel.onColorChange = (msg: { carIndex?: number; hex: string }) => {
        const currentPlayerIdx = world.playerCarIndex ?? 0;
        world.setCarColor(msg.carIndex ?? (currentPlayerIdx === 0 ? 1 : 0), msg.hex, false);
      };
      this.networkChannel.send?.(JSON.stringify(joinCfg.joinPayload));
    }
    this.syncStoreOnlineState('online-warmup', { isHosting: false, playerName: joinCfg.playerName, signalingConnected: true });
    lifecycle.domEventManager?.syncPausedAndInputState?.();
    return this.networkChannel;
  }

  private async handleClientHandshakeResponse(
    msg: HandshakeResponseMessage, joinCfg: ReturnType<typeof resolveClientJoinConfig>,
  ): Promise<void> {
    const { world, lifecycle, coordinators } = this.host;
    if (msg?.state) this.latestServerRosterState = msg.state;
    const transition = resolveClientHandshakeTransition(msg, useAppStore?.getState?.()?.onlineSession);
    const { physics, arena } = world;
    if (transition.assignedCarIndex !== null) {
      world.playerCarIndex = transition.assignedCarIndex;
      if (this.networkReconciler) this.networkReconciler.localCarIndex = transition.assignedCarIndex;
      if (arena) arena.playerCarIndex = transition.assignedCarIndex;
    }
    const activePlayerCarIndex = world.playerCarIndex ?? 0;
    if (transition.isLobbyOrWarmup) {
      physics?.setUnlimitedBoost?.(true);
      this.resetOnlineReplayRecording(false);
      this.configureArenaLobbyFlags(true, false);
      this.activateClientDualWorldLobby();
      if (arena?.ensureCar) await arena.ensureCar(activePlayerCarIndex, transition.localTeam, joinCfg.localVisualId);
      this.configureClientLobbyLocalCar(activePlayerCarIndex, transition.localTeam, joinCfg.localVisualId, false);
      if (msg?.state === 'lobby' || !msg?.state) await this.diagnosticsProbe.ensureClientLobbyDiagnosticProbes();
      world.interpolator?.sync?.(performance.now());
    } else if (transition.isMidMatchJoin) {
      physics?.setUnlimitedBoost?.(false);
      this.resetOnlineReplayRecording(false);
      this.configureArenaLobbyFlags(false, false);
      this.networkReconciler?.setLobbyDualWorldMode?.(false);
      this.networkReconciler?.setMatchTelemetryActive?.(true, true);
      this.diagnosticsProbe.configureLobbyGhostMode(false, { syncServerLobby: false });
      this.diagnosticsProbe.despawnDiagnosticTestFleet();
      networkDiagnosticsStore?.syncZeroGFleetState?.(false);
      const match = lifecycle.match;
      if (match?.state) {
        match.state = {
          ...match.state, mode: 'match', phase: transition.resolvedPhase,
          durationSeconds: transition.resolvedDuration, clockSeconds: transition.resolvedClock, score: transition.resolvedScore,
        };
      }
      lifecycle.modeManager?.setMode?.('match');
      const storeState = useAppStore?.getState?.();
      storeState?.setMatchMode?.('match');
      if (storeState?.activeOverlay === 'room-WaitingRoom') storeState.setActiveOverlay?.('none');
      hudStore?.getState?.()?.setMatchState?.({
        matchPhase: transition.resolvedPhase, clockSeconds: transition.resolvedClock, score: transition.resolvedScore,
      });
    }
    if (msg?.roster) await coordinators.applyRosterSnapshot(msg.roster);
    this.syncStoreOnlineState(null, transition.onlineSessionPatch);
    this.focusCameraOnCar(activePlayerCarIndex);
    const handshakeColor = resolveHandshakeTeamColorSlot(msg);
    world.selectedColorSlot = handshakeColor.colorSlot;
    if (handshakeColor.colorHex) arena?.setCarColor?.(activePlayerCarIndex, handshakeColor.colorHex);
    const ld = resolveLoadoutDefaults({
      visualId: joinCfg.localVisualId, hitboxId: joinCfg.localHitboxId, colorSlot: handshakeColor.colorSlot,
      paintFinish: joinCfg.localPaintFinish, boostVisual: joinCfg.localBoostVisual, boostAudio: joinCfg.localBoostAudio,
    }, this.getLocalLoadout(), getMaterialsConfig());
    this.networkReconciler?.queueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
      packLoadoutCommandParam1(ld.visualId, ld.hitboxId),
      packLoadoutCommandParam2(handshakeColor.colorSlot, ld.paintFinish, ld.boostVisual, ld.boostAudio),
    );
    if (transition.isMidMatchJoin) this.networkReconciler?.queueClientCommand(CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK, 1, 0);
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
    const { resolvedLocalCarIndex, localTeam } = await restoreOnlineLobbyParticipantAndArenaState(
      this.transitionPort, this.networkReconciler, isHost,
    );
    if (world.arena) {
      this.configureArenaLobbyFlags(true, isHost, resolvedLocalCarIndex);
      this.isolateNonLocalLobbyCars(resolvedLocalCarIndex);
    }
    this.networkReconciler?.resetTimelineState?.();
    if (isHost) {
      if (this.networkReconciler) this.networkReconciler.hostLobbyMode = true;
      resetLobbyWorldPhysicsPose(physics, 0, localTeam, true);
      if (!options.fromServerRoster) {
        this.authoritativeServer?.enterLobbyMode?.({ ghostCars: true, hostInteractsWithBall: true, enableDiagnosticsFleet: true });
      }
      this.networkReconciler?.setMatchTelemetryActive?.(true, true);
      this.diagnosticsProbe.configureLobbyGhostMode(true, { hostInteractsWithBall: true, syncServerLobby: !options.fromServerRoster });
      await this.diagnosticsProbe.spawnDiagnosticTestFleet();
      if (this.latestServerRosterState !== 'lobby' || matchState?.mode === 'match') return;
      networkDiagnosticsStore?.syncZeroGFleetState?.(true);
      coordinators.syncHostLobbyNotification();
    } else {
      resetLobbyWorldPhysicsPose(physics, resolvedLocalCarIndex, localTeam, false);
      this.activateClientDualWorldLobby();
      await this.diagnosticsProbe.ensureClientLobbyDiagnosticProbes();
      if (this.latestServerRosterState !== 'lobby' || matchState?.mode === 'match') return;
    }
    world.camera?.setFocusedCarIndex?.(resolvedLocalCarIndex);
    world.camera?.resetView?.();
    world.interpolator?.sync?.(performance.now());
    lifecycle.modeManager?.setMode?.('freeplay');
    this.syncStoreOnlineState('online-warmup');
    lifecycle.domEventManager?.syncPausedAndInputState?.();
  }
}
