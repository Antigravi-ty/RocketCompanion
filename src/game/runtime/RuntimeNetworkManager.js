import { CLIENT_COMMAND_TYPES } from '../../network/protocol/GlobalPayloadCodec.js';
import { LobbyGhostCarCoordinator, DEFAULT_GHOST_OPACITY } from '../../network/server/LobbyGhostCarCoordinator.js';
import { MultiWorldGhostRenderer } from '../modes/MultiWorldGhostRenderer.js';
import {
  sampleDiagnosticFleetTelemetry as sampleDiagnosticsFleetTelemetry,
  DEFAULT_DIAGNOSTIC_FLEET
} from '../../network/diagnostics/DiagnosticsTestVehicles.js';
import { useAppStore } from '../../ui-core/stores/appStore';
import { bindReconcilerSignals } from './RuntimeReconcilerSignalHandler.js';
import {
  applyRuntimeRosterSnapshot,
  onRuntimeRemotePlayerConnected,
  removeRuntimeRemotePlayer,
  syncHostLobbyOngoingNotification,
  dismissHostLobbyOngoingNotification
} from './RuntimeOnlineRosterSync.js';
import {
  enableRuntimeNetworkPrediction,
  cleanupRuntimeOnlineSession,
  stopRuntimeOnlineServer,
  hostRuntimeOnlineServer,
  joinRuntimeOnlineServer,
  returnRuntimeOnlineMatchToLobby
} from './RuntimeOnlineSessionHelper.js';
import {
  getRuntimePhysicsRate,
  adjustRuntimePhysicsRate,
  setRuntimePhysicsRate,
  setRuntimePhysicsTickScale,
  resetRuntimePhysicsRate,
  dropRuntimePacketBurst,
  dumpRuntimeNextNetworkPacket,
  dumpRuntimeLatestNetworkPacket,
  adjustRuntimeSimulatedLatency,
  adjustRuntimeNetworkLatency,
  spawnRuntimeHeadlessCarEntity,
  enableRuntimeDeterminismHarness,
  spawnRuntimeDiagnosticTestFleet,
  despawnRuntimeDiagnosticTestFleet,
  toggleRuntimeDiagnosticTestFleet,
  setRuntimeDiagnosticObservationTarget,
  configureRuntimeLobbyGhostMode,
  applyRuntimeCarGhostCollision
} from './RuntimeNetworkDiagnosticsHelper.js';

export class RuntimeNetworkManager {
  constructor(runtime) {
    this.runtime = runtime;
    this.lobbyGhostCoordinator = new LobbyGhostCarCoordinator();
  }

  ensureMultiWorldGhostRenderer() {
    const r = this.runtime;
    if (!r.multiWorldGhostRenderer && r.arena) {
      r.multiWorldGhostRenderer = new MultiWorldGhostRenderer(r.arena);
    }
    return r.multiWorldGhostRenderer;
  }

  _bindReconcilerSignals(reconciler) {
    bindReconcilerSignals(this.runtime, reconciler);
  }

  setLobbyGhostMode(enabled = true, optionsOrInteractWithBall = {}) {
    const r = this.runtime;
    const cfg = configureRuntimeLobbyGhostMode(r, this.lobbyGhostCoordinator, enabled, optionsOrInteractWithBall);
    const ghostRenderer = this.ensureMultiWorldGhostRenderer();
    if (ghostRenderer) {
      ghostRenderer.setVisible(Boolean(enabled));
    }
    if (!enabled && r.arena?.cars) {
      const numCars = Math.min(r.physics?.numCars || 1, r.arena.cars.length);
      for (let i = 0; i < numCars; i++) {
        if (r.arena.cars[i]) {
          r.arena.cars[i].visible = true;
        }
      }
    }
    return cfg;
  }

  setCarGhostCollision(carIndex, interactWithBall = false, interactWithCars = false, opacity = DEFAULT_GHOST_OPACITY) {
    return applyRuntimeCarGhostCollision(this.runtime, this.lobbyGhostCoordinator, carIndex, interactWithBall, interactWithCars, opacity);
  }

  async enableNetworkPrediction(showHUD = true, options = {}) {
    return enableRuntimeNetworkPrediction(this, showHUD, options);
  }

  cleanupOnlineSession() {
    cleanupRuntimeOnlineSession(this);
  }

  async stopOnlineServer() {
    return stopRuntimeOnlineServer(this);
  }

  async returnOnlineMatchToLobby(options = {}) {
    return returnRuntimeOnlineMatchToLobby(this, options);
  }

  async hostOnlineServer(options = {}) {
    return hostRuntimeOnlineServer(this, options);
  }

  async _applyRosterSnapshot(roster) {
    await applyRuntimeRosterSnapshot(this.runtime, roster);
  }

  async joinOnlineServer(options = {}) {
    return joinRuntimeOnlineServer(this, options);
  }

  async onRemotePlayerConnected(channel, remotePlayerName = 'Player 2', assignedCarIndex = null) {
    return onRuntimeRemotePlayerConnected(this.runtime, channel, remotePlayerName, assignedCarIndex);
  }

  forceStartOnlineMatch(durationSeconds = 300) {
    const r = this.runtime;
    dismissHostLobbyOngoingNotification();
    if (r.authoritativeServer) {
      this.despawnDiagnosticTestFleet();
      r.authoritativeServer.forceStartMatch(durationSeconds);
    } else if (r.networkReconciler) {
      r.networkReconciler.queueClientCommand(CLIENT_COMMAND_TYPES.CMD_READY_ACK, 1, durationSeconds);
    }
  }

  setOnlineGameMode(gameMode = '3v3', durationSeconds = null) {
    const r = this.runtime;
    const resolvedDuration = durationSeconds ?? useAppStore?.getState?.()?.onlineSession?.matchDurationSeconds ?? 300;
    if (r.authoritativeServer) {
      r.authoritativeServer.setGameMode(gameMode, resolvedDuration);
    }
    if (useAppStore && typeof useAppStore.getState === 'function') {
      useAppStore.getState().setOnlineSession({ gameMode });
    }
    syncHostLobbyOngoingNotification(r);
  }

  setOnlineMatchDuration(durationSeconds = 300) {
    const r = this.runtime;
    const cleanDuration = Math.max(0, Number(durationSeconds) || 0);
    const currentGameMode = useAppStore?.getState?.()?.onlineSession?.gameMode || '1v1';
    if (r.authoritativeServer) {
      r.authoritativeServer.setGameMode(currentGameMode, cleanDuration);
    }
    if (useAppStore && typeof useAppStore.getState === 'function') {
      useAppStore.getState().setOnlineSession({ matchDurationSeconds: cleanDuration });
    }
    syncHostLobbyOngoingNotification(r);
  }

  setOnlineBotFillMode(botFillMode = 'no_bots') {
    const r = this.runtime;
    if (r.authoritativeServer) {
      r.authoritativeServer.setBotFillMode?.(botFillMode);
    }
    if (useAppStore && typeof useAppStore.getState === 'function') {
      useAppStore.getState().setOnlineSession({ botFillMode });
    }
  }

  addOnlineBot(team = 1, botName = null) {
    const r = this.runtime;
    if (r.authoritativeServer) {
      r.authoritativeServer.addBotPlayer?.(team, botName);
    }
  }

  setClientReady(ready = true) {
    const r = this.runtime;
    if (r.networkReconciler) {
      r.networkReconciler.queueClientCommand(CLIENT_COMMAND_TYPES.CMD_READY_ACK, ready ? 1 : 0, 0);
    }
  }

  voteSkipReplay() {
    const r = this.runtime;
    if (r.networkReconciler) {
      r.networkReconciler.queueClientCommand(CLIENT_COMMAND_TYPES.CMD_VOTE_SKIP_REPLAY, 1, 0);
    }
  }

  voteRematch(ready = true) {
    const r = this.runtime;
    if (r.networkReconciler) {
      r.networkReconciler.queueClientCommand(CLIENT_COMMAND_TYPES.CMD_VOTE_REMATCH, ready ? 1 : 0, 0);
    }
  }

  switchOnlineRoleOrTeam(role = 'player', team = 0) {
    const r = this.runtime;
    const roleCode = role === 'spectator' ? 2 : 0;
    if (r.authoritativeServer) {
      r.authoritativeServer.switchRoleTeam('host', role, team);
    } else if (r.networkReconciler) {
      r.networkReconciler.queueClientCommand(CLIENT_COMMAND_TYPES.CMD_SWITCH_ROLE_TEAM, roleCode, team);
    }
  }

  async removeRemotePlayer(carIndex) { await removeRuntimeRemotePlayer(this.runtime, carIndex); }
  getPhysicsRate() { return getRuntimePhysicsRate(this.runtime); }
  adjustPhysicsRate(delta, options) { return adjustRuntimePhysicsRate(this.runtime, delta, options); }
  setPhysicsRate(rate, options) { return setRuntimePhysicsRate(this.runtime, rate, options); }
  setPhysicsTickScale(scale, options) { return setRuntimePhysicsTickScale(this.runtime, scale, options); }
  resetPhysicsRate() { return resetRuntimePhysicsRate(this.runtime); }
  dropPacketBurst(count = null) { dropRuntimePacketBurst(this.runtime, count); }
  dropSinglePacket() { this.dropPacketBurst(1); }
  dumpNextNetworkPacket() { return dumpRuntimeNextNetworkPacket(this.runtime); }
  dumpLatestNetworkPacket(packet = null) { return dumpRuntimeLatestNetworkPacket(this.runtime, packet); }
  adjustSimulatedLatency(direction, stepMs) { adjustRuntimeSimulatedLatency(this.runtime, direction, stepMs); }
  adjustNetworkLatency(deltaLatencyMs) { adjustRuntimeNetworkLatency(this.runtime, deltaLatencyMs); }
  adjustNetworkRtt(deltaMs) { this.adjustNetworkLatency(Math.round(deltaMs * 0.5)); }

  async spawnHeadlessCarEntity() {
    await spawnRuntimeHeadlessCarEntity(this.runtime);
  }

  async spawnDiagnosticTestFleet(options = {}) {
    return spawnRuntimeDiagnosticTestFleet(this.runtime, options);
  }

  despawnDiagnosticTestFleet() {
    return despawnRuntimeDiagnosticTestFleet(this.runtime);
  }

  async toggleDiagnosticTestFleet(forceEnabled = null, anchorMode = null) {
    return toggleRuntimeDiagnosticTestFleet(this.runtime, forceEnabled, anchorMode);
  }

  setDiagnosticObservationTarget(targetCarIndex = 0) {
    return setRuntimeDiagnosticObservationTarget(this.runtime, targetCarIndex);
  }

  setTestCarAudioEnabled(enabled = false) {
    this.runtime.testCarAudioEnabled = Boolean(enabled);
    return this.runtime.testCarAudioEnabled;
  }

  toggleTestCarAudio(forceEnabled = null) {
    const next = forceEnabled !== null ? Boolean(forceEnabled) : !Boolean(this.runtime.testCarAudioEnabled);
    this.runtime.testCarAudioEnabled = next;
    return next;
  }

  sampleDiagnosticFleetTelemetry() {
    if (!this.runtime?.physics) return [];
    const serverStateBuf =
      this.runtime.authoritativeServer?.fallbackSim?.state ||
      (this.runtime.authoritativeServer?.isWorker ? this.runtime.authoritativeServer?.cachedSnapshot : null) ||
      this.runtime.networkReconciler?.lastParsedPacket?.stateSnapshot ||
      null;
    return sampleDiagnosticsFleetTelemetry(this.runtime.physics, serverStateBuf, DEFAULT_DIAGNOSTIC_FLEET);
  }

  async enableDeterminismHarness(showHUD = true) {
    return enableRuntimeDeterminismHarness(this.runtime, showHUD);
  }
}
