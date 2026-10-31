/**
 * RuntimeOnlineSessionHelper.js
 * Host and Client session lifecycle helpers (enableNetworkPrediction, hostOnlineServer,
 * joinOnlineServer, stopOnlineServer, cleanupOnlineSession) for RuntimeNetworkManager.
 */

import { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.js';
import { PredictionReconciler } from '../../network/client/PredictionReconciler.js';
import { CLIENT_COMMAND_TYPES } from '../../network/protocol/GlobalPayloadCodec.js';
import {
  packLoadoutCommandParam1,
  packLoadoutCommandParam2
} from '../../ui-core/config/vehicleConstants.js';
import { getMaterialsConfig } from '../../ui-core/config/materialsConfig.js';
import { useAppStore } from '../../ui-core/stores/appStore';
import { hudStore } from '../../ui-core/stores/hudStore';
import { resolveEffectiveClockPacingParams } from '../../ui-core/config/clockPacingConfig';
import { networkDiagnosticsStore } from '../../ui-core/stores/networkDiagnosticsStore';
import { resetRuntimeReconcilerSignalState } from './RuntimeReconcilerSignalHandler.js';
import {
  syncHostLobbyOngoingNotification,
  dismissHostLobbyOngoingNotification,
} from './RuntimeOnlineRosterSync.js';
import {
  snapshotCurrentTelemetryPayload,
  notifyNetworkTelemetryExportAvailable,
} from '../../ui-core/stores/pacingTelemetryExporter.js';
import {
  DEFAULT_DIAGNOSTIC_FLEET,
  configureZeroGVehiclePhysics,
} from '../../network/diagnostics/DiagnosticsTestVehicles.js';
import { configureClientLobbyDiagnosticProbes } from '../../network/client/ReconciliationTimelineHelper.js';
import {
  getNameTagRuntimeState,
  setNameTagRuntimeState,
} from '../../ui-core/config/nameTagConfig.ts';

async function ensureClientLobbyDiagnosticProbes(r) {
  if (r.physics) {
    const alreadySyncedProbes = Boolean(
      r.networkReconciler?.isTimelineSynchronized &&
      typeof r.physics.isCarSlotActive === 'function' &&
      r.physics.isCarSlotActive(6) &&
      r.physics.isCarSlotActive(7)
    );
    if (alreadySyncedProbes) {
      configureClientLobbyDiagnosticProbes(r.physics);
    } else {
      configureZeroGVehiclePhysics(r.physics, DEFAULT_DIAGNOSTIC_FLEET);
    }
  }
  if (r.arena && typeof r.arena.ensureCar === 'function') {
    await Promise.all([
      r.arena.ensureCar(6, 0, 'fennec'),
      r.arena.ensureCar(7, 1, 'fennec'),
    ]);
    for (const def of DEFAULT_DIAGNOSTIC_FLEET) {
      const idx = def.carIndex;
      const carMesh = r.arena.cars?.[idx];
      if (carMesh) {
        carMesh.visible = true;
        if (def.colorHex) {
          carMesh.setCustomBodyColor?.(def.colorHex);
        }
      }
      r.getFlipResetVisual?.(idx);
    }
  }
  try {
    const curNameTags = getNameTagRuntimeState?.();
    const existingEntries = Array.isArray(curNameTags?.carEntries)
      ? [...curNameTags.carEntries]
      : [];
    if (!existingEntries.some((e) => e.carIndex === 6)) {
      existingEntries.push({ carIndex: 6, name: 'Boost', team: 0 });
    }
    if (!existingEntries.some((e) => e.carIndex === 7)) {
      existingEntries.push({ carIndex: 7, name: 'Roll', team: 1 });
    }
    setNameTagRuntimeState?.({
      isMultiplayerOrMultiCarMode: true,
      carEntries: existingEntries,
    });
  } catch (_) {
    // Ignore name tag state update errors in headless environments
  }
  networkDiagnosticsStore?.syncZeroGFleetState?.(true);
}

function getStorePacingConfig() {
  const s = useAppStore?.getState?.();
  const mode = s?.clockPacingMode || 'legacy';
  const priority = s?.clockPacingPriority || 'balanced';
  const target = s?.inputBufferTarget ?? 3;
  const threshold = s?.inputBufferThreshold ?? [-2, 2];
  const custom = s?.customClockPacingParams;
  const params = typeof resolveEffectiveClockPacingParams === 'function' && custom
    ? resolveEffectiveClockPacingParams(mode, priority, target, threshold, custom)
    : null;
  return { mode, priority, target, threshold, params };
}

export async function enableRuntimeNetworkPrediction(manager, showHUD = true, options = {}) {
  const r = manager.runtime;
  if (!r.networkReconciler) {
    const hostVisualId = r.selectedPreset || 'fennec';
    const matCfg = getMaterialsConfig();
    r.authoritativeServer = new AuthoritativeServerHost(null, {
      snapshotInterval: 1,
      hostVisualId,
      hostHitboxId: r.selectedHitbox || null,
      hostPaintFinish: matCfg?.paintFinish || 'metallic',
      hostBoostVisual: matCfg?.boostVisual || 'gold-rush',
      hostBoostAudio: matCfg?.boostAudio || 'rush',
    });
    await r.authoritativeServer.init();
    r.networkChannel = r.authoritativeServer.channel;
    const snapMetrics = networkDiagnosticsStore?.getSnapshot?.()?.metrics;
    const initialExtraUplink = snapMetrics?.extraUplinkMs ?? snapMetrics?.extraLatencyMs ?? 0;
    const initialExtraDownlink = snapMetrics?.extraDownlinkMs ?? snapMetrics?.extraLatencyMs ?? 0;
    if ((initialExtraUplink > 0 || initialExtraDownlink > 0) && r.networkChannel) {
      if (typeof r.networkChannel.setAsymmetricLatency === 'function') {
        r.networkChannel.setAsymmetricLatency(initialExtraUplink, initialExtraDownlink);
      } else {
        r.networkChannel.extraUplinkMs = initialExtraUplink;
        r.networkChannel.extraDownlinkMs = initialExtraDownlink;
      }
    }

    r.authoritativeServer.sim.setUnlimitedBoost(r.physics.isUnlimitedBoost);
    r.authoritativeServer.sim.restoreState(r.physics.saveCompactState());

    const serverSnap = r.authoritativeServer.sim.saveCompactState();
    const serverTick = Math.floor(r.authoritativeServer.sim.getHeaderView().tickCount);

    const pacingCfg = getStorePacingConfig();
    r.networkReconciler = new PredictionReconciler(r.physics, r.networkChannel, {
      localCarIndex: r.playerCarIndex,
      redundantHistoryCount: options.redundantHistoryCount ?? 10,
      enableRedundantInputs: options.enableRedundantInputs ?? true,
      useBitPacking: options.useBitPacking ?? false,
      interpolator: r.interpolator,
      clockPacingMode: pacingCfg.mode,
      clockPacingPriority: pacingCfg.priority,
      clockPacingParams: pacingCfg.params,
      inputBufferTarget: pacingCfg.target,
      catchupThresholdOffset: pacingCfg.threshold[0],
      skipThresholdOffset: pacingCfg.threshold[1],
    });
    r.networkReconciler.setCarVisualPreset(r.playerCarIndex, hostVisualId);
    manager._bindReconcilerSignals(r.networkReconciler);
    r.networkReconciler.syncTimeline(serverSnap, serverTick);
    r.onSessionReady?.(r.networkReconciler, r.networkChannel);
  }
  if (showHUD) {
    r.onShowNetworkHUD?.();
  }
  return r.networkReconciler;
}

function ensureValidClientLobbyLocalCarPose(physics, carIndex, team = 1, forceReset = false) {
  if (!physics || typeof physics.setCarState !== 'function') return;
  const cv = typeof physics.getCarStateView === 'function' ? physics.getCarStateView(carIndex) : null;
  const isInvalidOrUnderground =
    forceReset ||
    !cv ||
    !Number.isFinite(cv.posX) ||
    !Number.isFinite(cv.posY) ||
    !Number.isFinite(cv.posZ) ||
    cv.posZ < 14.0 ||
    Math.abs(cv.posX) > 4050 ||
    Math.abs(cv.posY) > 5100 ||
    (Math.abs(cv.posX) < 1 && Math.abs(cv.posY) < 1 && cv.posZ < 16.0);

  if (isInvalidOrUnderground) {
    const isOrange = (team ?? (carIndex % 2)) === 1;
    const spawnX = isOrange ? 2048 : -2048;
    const spawnY = isOrange ? 2560 : -2560;
    const yaw = isOrange ? -0.75 * Math.PI : 0.25 * Math.PI;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    physics.setCarState(carIndex, {
      pos: [spawnX, spawnY, 17.0],
      forward: [cy, sy, 0],
      right: [-sy, cy, 0],
      up: [0, 0, 1],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      boost: 100,
      isOnGround: true,
      isDemoed: false,
      hasFlipOrJump: true,
      isBoosting: false,
      isFlipping: false,
    });
  }
}

export function cleanupRuntimeOnlineSession(manager) {
  const r = manager.runtime;
  if (r.networkReconciler?.telemetryRecorder?.count > 0) {
    const wasEvicted = Boolean(networkDiagnosticsStore?.getSnapshot?.()?.metrics?.disconnectEvicted);
    if (wasEvicted && !r._networkTelemetryNotified) {
      r._networkTelemetryNotified = true;
      notifyNetworkTelemetryExportAvailable('disconnected', r.networkReconciler.telemetryRecorder);
    } else {
      snapshotCurrentTelemetryPayload(r.networkReconciler.telemetryRecorder);
    }
  }
  r.isBotMatch = false;
  r.remotePeerCarMap?.clear?.();
  dismissHostLobbyOngoingNotification();
  r.podiumController?.exitPodium?.();
  r.replayTimelineController?.endReplaySession?.();
  r.goalReplayCameraOverrideActive = false;
  resetRuntimeReconcilerSignalState(r);
  manager.setLobbyGhostMode(false);
  if (r.multiWorldGhostRenderer) {
    r.multiWorldGhostRenderer.setVisible(false);
  }
  if (r.authoritativeServer) {
    try {
      r.authoritativeServer.destroy?.();
    } catch (err) {
      console.warn('[GameRuntime] Error destroying authoritative server:', err);
    }
    r.authoritativeServer = null;
  }
  if (r.networkChannel) {
    try {
      r.networkChannel.destroy?.();
    } catch (err) {
      console.warn('[GameRuntime] Error destroying network channel:', err);
    }
    r.networkChannel = null;
  }
  if (r.networkReconciler) {
    r.networkReconciler.setMatchTelemetryActive?.(false, false);
    r.networkReconciler = null;
  }
  networkDiagnosticsStore?.setSession?.(null, null, r);
  r.playerCarIndex = 0;
  if (r.arena) {
    r.arena.playerCarIndex = 0;
    r.arena.isLobbyMode = false;
    r.arena.isHostLobby = false;
  }
}

export async function stopRuntimeOnlineServer(manager) {
  const r = manager.runtime;
  manager.cleanupOnlineSession();
  if (r.arena?.cars) {
    if (r.arena.cars[0]) r.arena.cars[0].visible = true;
    for (let i = 1; i < r.arena.cars.length; i++) {
      if (r.arena.cars[i]) r.arena.cars[i].visible = false;
    }
  }
  if (r.physics && r.physics.numCars > 1) {
    r.physics.configureCars(r.selectedPreset || 'fennec', false, 0);
  }
  const unlimited = useAppStore?.getState?.()?.gameplay?.unlimitedBoost ?? (r.trainingOptions?.boostOption === 'unlimited');
  r.physics?.setUnlimitedBoost?.(unlimited);
  if (r.match?.state) {
    r.match.state.mode = 'freeplay';
    r.match.state.paused = false;
    r.match.state.phase = 'freeplay';
    r.match.state.overtime = false;
    r.match.state.winner = null;
    r.match.state.countdown = 0;
  }
  r.modeManager?.setMode?.('freeplay');
  r.resetKickoff();
  r.interpolator?.sync?.(performance.now());
  if (useAppStore && typeof useAppStore.getState === 'function') {
    useAppStore.getState().setMatchMode('freeplay');
    useAppStore.getState().setOnlineSession({
      isHosting: false,
      roomId: '',
      signalingConnected: false,
      connectedPeers: [],
      roomType: 'warmup',
      isReady: false,
    });
  }
  r.syncPausedAndInputState?.();
}

export async function hostRuntimeOnlineServer(manager, options = {}) {
  const r = manager.runtime;
  if (r.authoritativeServer) {
    console.warn('[GameRuntime] Authoritative server already running. Disposing prior instance before hosting.');
    await manager.stopOnlineServer();
  }
  r.isBotMatch = false;
  r.remotePeerCarMap = new Map();
  const uiOnline = useAppStore?.getState?.()?.onlineSession;
  const playerName =
    options.playerName && options.playerName !== 'Host'
      ? options.playerName
      : uiOnline?.playerName && uiOnline.playerName !== 'Host'
      ? uiOnline.playerName
      : `Player${Math.floor(1000 + Math.random() * 9000)}`;
  const hostVisualId = options.visualId || r.selectedPreset || 'fennec';
  const hostHitboxId = options.hitboxId || r.selectedHitbox || null;
  const hostColorSlot = options.colorSlot ?? (r.selectedColorSlot ?? 0);
  const matCfg = getMaterialsConfig();
  const hostPaintFinish = options.paintFinish || matCfg?.paintFinish || 'metallic';
  const hostBoostVisual = options.boostVisual || matCfg?.boostVisual || 'gold-rush';
  const hostBoostAudio = options.boostAudio || matCfg?.boostAudio || 'rush';
  const roomType = options.roomType || uiOnline?.roomType || 'match';
  const isMatchLobby = options.lobbyMode !== undefined ? Boolean(options.lobbyMode) : true;
  const gameMode = options.gameMode || uiOnline?.gameMode || '2v2';
  const botFillMode = options.botFillMode || uiOnline?.botFillMode || 'auto_fill';
  const durationSeconds = options.durationSeconds ?? uiOnline?.matchDurationSeconds ?? 300;

  r.testCarAudioEnabled = false;
  networkDiagnosticsStore?.setTestCarAudioEnabled?.(false);

  if (r.arena?.cars) {
    for (let i = 1; i < r.arena.cars.length; i++) {
      if (r.arena.cars[i]) r.arena.cars[i].visible = false;
    }
  }
  if (r.physics && r.physics.numCars > 1) {
    r.physics.configureCars('default', false, 0);
    r.physics.resetKickoff();
  }

  r.physics.setUnlimitedBoost(true);

  const initialSnapshot = r.physics.saveCompactState();
  r.authoritativeServer = new AuthoritativeServerHost(null, {
    snapshotInterval: 1,
    initialState: Array.from(initialSnapshot),
    hostPlayerName: playerName,
    hostVisualId,
    hostHitboxId,
    hostColorSlot,
    hostPaintFinish,
    hostBoostVisual,
    hostBoostAudio,
    gameMode,
    botFillMode,
    durationSeconds,
    lobbyMode: isMatchLobby,
    skipReplayByDefault: options.skipReplayByDefault !== undefined ? Boolean(options.skipReplayByDefault) : false,
    roomId: options.roomId || 'local_room',
  });
  await r.authoritativeServer.init();

  r.authoritativeServer.sim.setUnlimitedBoost(true);
  if (r.arena) {
    r.arena.isLobbyMode = isMatchLobby;
    r.arena.isHostLobby = isMatchLobby;
  }
  if (isMatchLobby) {
    manager.setLobbyGhostMode(true, { hostInteractsWithBall: true });
  } else {
    manager.setLobbyGhostMode(false);
  }

  const initialExtraLatency = networkDiagnosticsStore?.getSnapshot?.()?.metrics?.extraLatencyMs ?? 0;
  r.networkChannel = r.authoritativeServer.channel;
  if (initialExtraLatency > 0 && r.networkChannel) {
    if (typeof r.networkChannel.setExtraLatency === 'function') {
      r.networkChannel.setExtraLatency(initialExtraLatency);
    } else {
      r.networkChannel.extraLatencyMs = initialExtraLatency;
    }
  }
  r.playerCarIndex = 0;

  const pacingCfg = getStorePacingConfig();
  r.physics?.initReplayBuffer?.();
  r.physics?.clearReplayBuffer?.();
  r.physics?.setReplayRecordingActive?.(true);
  r.clientReplayOverflowPaused = false;
  r.networkReconciler = new PredictionReconciler(r.physics, r.networkChannel, {
    localCarIndex: 0,
    redundantHistoryCount: 10,
    enableRedundantInputs: true,
    useBitPacking: false,
    interpolator: r.interpolator,
    clockPacingMode: pacingCfg.mode,
    clockPacingPriority: pacingCfg.priority,
    clockPacingParams: pacingCfg.params,
    inputBufferTarget: pacingCfg.target,
    catchupThresholdOffset: pacingCfg.threshold[0],
    skipThresholdOffset: pacingCfg.threshold[1],
    isMatchTelemetryActive: true,
  });
  r.networkReconciler.setCarVisualPreset(0, hostVisualId);
  manager._bindReconcilerSignals(r.networkReconciler);
  r.networkReconciler.onHardResync = () => {
    if (r.interpolator) {
      r.interpolator.sync(performance.now());
    }
    const camPos = r.camera?.camera?.position;
    if (camPos && (!Number.isFinite(camPos.x) || !Number.isFinite(camPos.y) || !Number.isFinite(camPos.z))) {
      r.camera?.resetView?.();
    }
  };
  r._latestServerRosterState = isMatchLobby ? 'lobby' : 'match';
  r.networkReconciler.onRosterUpdate = async (msg) => {
    if (msg?.state) {
      r._latestServerRosterState = msg.state;
    }
    if (msg?.state === 'lobby' && r._latestServerRosterState === 'lobby' && (r.match?.state?.mode === 'match' || r.match?.state?.phase !== 'lobby')) {
      await returnRuntimeOnlineMatchToLobby(manager, { fromServerRoster: true });
    }
    if (msg?.roster && (!msg?.state || msg.state === r._latestServerRosterState)) {
      await manager._applyRosterSnapshot(msg.roster);
    }
  };
  if (r.authoritativeServer?.lastRoomState?.roster) {
    await manager._applyRosterSnapshot(r.authoritativeServer.lastRoomState.roster);
  }

  if (isMatchLobby) {
    await manager.spawnDiagnosticTestFleet();
    networkDiagnosticsStore?.syncZeroGFleetState?.(true);
  }

  const serverSnap = r.authoritativeServer.sim.saveCompactState();
  const serverTick = Math.floor(r.authoritativeServer.sim.getHeaderView().tickCount);
  if (!isMatchLobby || (serverSnap && serverSnap[2] >= 1)) {
    r.networkReconciler.syncTimeline(serverSnap, serverTick);
  }

  r.onSessionReady?.(r.networkReconciler, r.networkChannel);

  if (useAppStore && typeof useAppStore.getState === 'function') {
    useAppStore.getState().setMatchMode('online-warmup');
    useAppStore.getState().setOnlineSession({
      isHosting: true,
      roomId: options.roomId || 'local_room',
      playerName: playerName,
      signalingConnected: true,
      roomType,
      gameMode,
      botFillMode,
      matchDurationSeconds: durationSeconds,
    });
  }
  syncHostLobbyOngoingNotification(r);
  r.syncPausedAndInputState?.();

  return r.authoritativeServer;
}

export async function joinRuntimeOnlineServer(manager, options = {}) {
  const r = manager.runtime;
  const { channel, playerName = 'Player 2' } = options;
  const localVisualId = options.visualId || r.selectedPreset || 'fennec';
  const localHitboxId = options.hitboxId || r.selectedHitbox || null;
  const localColorSlot = options.colorSlot ?? (r.selectedColorSlot ?? 0);
  const matCfg = getMaterialsConfig();
  const localPaintFinish = options.paintFinish || matCfg?.paintFinish || 'metallic';
  const localBoostVisual = options.boostVisual || matCfg?.boostVisual || 'gold-rush';
  const localBoostAudio = options.boostAudio || matCfg?.boostAudio || 'rush';

  if (r.authoritativeServer) {
    try {
      r.authoritativeServer.destroy?.();
    } catch (_) {}
    r.authoritativeServer = null;
  }
  if (r.networkChannel && r.networkChannel !== channel) {
    try {
      r.networkChannel.destroy?.();
    } catch (_) {}
    r.networkChannel = null;
  }
  if (r.networkReconciler) {
    r.networkReconciler.setMatchTelemetryActive?.(false, false);
    r.networkReconciler = null;
  }
  r.podiumController?.exitPodium?.();
  r.replayTimelineController?.endReplaySession?.();
  r.goalReplayCameraOverrideActive = false;
  resetRuntimeReconcilerSignalState(r);
  if (r.match?.state) {
    r.match.state.mode = 'freeplay';
    r.match.state.paused = false;
    r.match.state.phase = 'freeplay';
    r.match.state.overtime = false;
    r.match.state.winner = null;
    r.match.state.countdown = 0;
  }
  r.modeManager?.setMode?.('freeplay');

  r.isBotMatch = false;
  r.playerCarIndex = 1;
  r.networkChannel = channel;
  const initialClientExtraLatency = networkDiagnosticsStore?.getSnapshot?.()?.metrics?.extraLatencyMs ?? 0;
  if (initialClientExtraLatency > 0 && r.networkChannel) {
    if (typeof r.networkChannel.setExtraLatency === 'function') {
      r.networkChannel.setExtraLatency(initialClientExtraLatency);
    } else {
      r.networkChannel.extraLatencyMs = initialClientExtraLatency;
    }
  }
  r.physics?.setUnlimitedBoost?.(true);

  r.testCarAudioEnabled = true;
  networkDiagnosticsStore?.setTestCarAudioEnabled?.(true);

  await r.arena?.ensureOpponent?.();
  if (r.arena) {
    r.arena.playerCarIndex = 1;
    r.arena.isLobbyMode = true;
    r.arena.isHostLobby = false;
    if (r.arena.cars[0]) {
      r.arena.cars[0].visible = false;
    }
    if (r.arena.cars[1]) {
      r.arena.cars[1].visible = true;
    }
  }
  if (typeof r.physics.addCarAtSlot === 'function') {
    r.physics.addCarAtSlot(1, 1, localVisualId);
    for (let c = 0; c < 6; c++) {
      if (c !== 1 && r.physics.isCarSlotActive?.(c)) {
        r.physics.removeCar(c);
      }
    }
  } else if (r.physics.numCars < 2) {
    r.physics.addCar(1, localVisualId);
  } else {
    r.physics.setCarHitbox(1, localVisualId);
  }
  r.physics.setCarTeam?.(1, 1);
  r.physics.setCarCollisionMask?.(1, true, false);
  r.physics.setCarLinearFactorAndGravity?.(1, 1, 1, 1, 1);
  r.physics.setBallState?.({ pos: [0, 0, 93.15], vel: [0, 0, 0], angVel: [0, 0, 0] });
  ensureValidClientLobbyLocalCarPose(r.physics, 1, 1, true);

  await ensureClientLobbyDiagnosticProbes(r);

  if (r.arena?.cars?.[1]) {
    r.getFlipResetVisual?.(1);
    r.camera.update(r.arena.cars[1], r.arena.ball, 0, r.cameraDynamics);
  }

  if (r.interpolator) {
    r.interpolator.sync(performance.now());
  }

  const clientPacingCfg = getStorePacingConfig();
  r.physics?.initReplayBuffer?.();
  r.physics?.clearReplayBuffer?.();
  r.physics?.setReplayRecordingActive?.(true);
  r.clientReplayOverflowPaused = false;
  r.networkReconciler = new PredictionReconciler(r.physics, r.networkChannel, {
    localCarIndex: 1,
    redundantHistoryCount: 10,
    enableRedundantInputs: true,
    useBitPacking: false,
    interpolator: r.interpolator,
    clockPacingMode: clientPacingCfg.mode,
    clockPacingPriority: clientPacingCfg.priority,
    clockPacingParams: clientPacingCfg.params,
    inputBufferTarget: clientPacingCfg.target,
    catchupThresholdOffset: clientPacingCfg.threshold[0],
    skipThresholdOffset: clientPacingCfg.threshold[1],
    isMatchTelemetryActive: true,
  });
  r.networkReconciler.setCarVisualPreset(1, localVisualId);
  r.networkReconciler.setLobbyDualWorldMode?.(true);
  const initialGhostRenderer = manager.ensureMultiWorldGhostRenderer();
  if (initialGhostRenderer) {
    initialGhostRenderer.ensureWorld('lobby-remote', {
      paletteIndex: 0,
      opacity: 0.55,
      showCar: true,
      showBall: true,
    });
    initialGhostRenderer.setVisible(true);
  }

  manager._bindReconcilerSignals(r.networkReconciler);
  r.networkReconciler.onHardResync = () => {
    if (r.interpolator) {
      r.interpolator.sync(performance.now());
    }
    const camPos = r.camera?.camera?.position;
    if (camPos && (!Number.isFinite(camPos.x) || !Number.isFinite(camPos.y) || !Number.isFinite(camPos.z))) {
      r.camera?.resetView?.();
    }
  };
  r._latestServerRosterState = 'lobby';
  if (r.match?.state) {
    r.match.state.mode = 'freeplay';
    r.match.state.phase = 'lobby';
  }
  r.networkReconciler.onRosterUpdate = async (msg) => {
    if (msg?.state) {
      r._latestServerRosterState = msg.state;
    }
    if (msg?.state === 'lobby' && r._latestServerRosterState === 'lobby') {
      if (
        r.match?.state?.mode === 'match' ||
        !r.networkReconciler?.lobbyDualWorldMode
      ) {
        await returnRuntimeOnlineMatchToLobby(manager, { fromServerRoster: true });
      } else {
        r.networkReconciler?.resetTimelineState?.();
        await ensureClientLobbyDiagnosticProbes(r);
      }
    }
    if (msg?.roster && (!msg?.state || msg.state === r._latestServerRosterState)) {
      await manager._applyRosterSnapshot(msg.roster);
    }
  };

  r.networkReconciler.onHandshakeResponse = async (msg) => {
    if (msg?.state) {
      r._latestServerRosterState = msg.state;
    }
    if (typeof msg.entityId === 'number' && msg.entityId >= 0) {
      r.playerCarIndex = msg.entityId;
      r.networkReconciler.localCarIndex = msg.entityId;
      if (r.arena) {
        r.arena.playerCarIndex = msg.entityId;
      }
    }
    if (msg.state === 'lobby' || msg.state === 'freeplay' || !msg.state) {
      r.physics?.setUnlimitedBoost?.(true);
      r.physics?.clearReplayBuffer?.();
      r.physics?.setReplayRecordingActive?.(true);
      r.clientReplayOverflowPaused = false;
      if (r.arena) {
        r.arena.isLobbyMode = true;
        r.arena.isHostLobby = false;
      }
      r.networkReconciler.setLobbyDualWorldMode?.(true);
      r.networkReconciler.setMatchTelemetryActive?.(true, true);
      const ghostRenderer = manager.ensureMultiWorldGhostRenderer();
      if (ghostRenderer) {
        ghostRenderer.ensureWorld('lobby-remote', {
          paletteIndex: 0,
          opacity: 0.55,
          showCar: true,
          showBall: true,
        });
        ghostRenderer.setVisible(true);
      }
      const localTeam = msg.team ?? (r.playerCarIndex % 2);
      if (typeof r.physics?.addCarAtSlot === 'function') {
        r.physics.addCarAtSlot(r.playerCarIndex, localTeam, localVisualId);
      } else {
        while (r.physics && r.physics.numCars <= r.playerCarIndex) {
          r.physics.addCar(r.physics.numCars % 2, localVisualId);
        }
      }
      if (r.arena?.ensureCar) {
        await r.arena.ensureCar(r.playerCarIndex, localTeam, localVisualId);
      }
      for (let c = 0; c < 6; c++) {
        const isLocal = c === r.playerCarIndex;
        if (!isLocal) {
          if (typeof r.physics?.isCarSlotActive === 'function' && r.physics.isCarSlotActive(c)) {
            r.physics.removeCar?.(c);
          }
          if (r.arena?.cars?.[c]) {
            r.arena.cars[c].visible = false;
          }
        } else {
          r.physics?.setCarCollisionMask?.(c, true, false);
          r.physics?.setCarLinearFactorAndGravity?.(c, 1, 1, 1, 1);
          ensureValidClientLobbyLocalCarPose(r.physics, c, localTeam, false);
          if (r.arena?.cars?.[c]) {
            r.arena.cars[c].visible = true;
          }
        }
      }
      if (msg.state === 'lobby' || !msg.state) {
        await ensureClientLobbyDiagnosticProbes(r);
      }
      r.interpolator?.sync?.(performance.now());
    } else if (msg.state === 'kickoff' || msg.state === 'playing' || msg.state === 'prepare') {
      r.physics?.setUnlimitedBoost?.(false);
      r.physics?.clearReplayBuffer?.();
      r.physics?.setReplayRecordingActive?.(true);
      r.clientReplayOverflowPaused = false;
      if (r.arena) {
        r.arena.isLobbyMode = false;
        r.arena.isHostLobby = false;
      }
      r.networkReconciler.setLobbyDualWorldMode?.(false);
      r.networkReconciler.setMatchTelemetryActive?.(true, true);
      manager.setLobbyGhostMode(false, { syncServerLobby: false });
      manager.despawnDiagnosticTestFleet();
      networkDiagnosticsStore?.syncZeroGFleetState?.(false);
    }
    if (msg.roster) {
      await manager._applyRosterSnapshot(msg.roster);
    }
    if (useAppStore && typeof useAppStore.getState === 'function') {
      useAppStore.getState().setOnlineSession({
        roomId: msg.roomId || useAppStore.getState().onlineSession?.roomId || 'online_room',
        gameMode: msg.gameMode || useAppStore.getState().onlineSession?.gameMode || '3v3',
        roomType: msg.state === 'lobby' || msg.state === 'prepare' || msg.state === 'kickoff' || msg.state === 'playing' ? 'match' : 'warmup',
      });
    }
    const targetCar = r.arena?.cars?.[r.playerCarIndex];
    if (targetCar) {
      targetCar.visible = true;
      r.getFlipResetVisual?.(r.playerCarIndex);
      r.camera?.update?.(targetCar, r.arena.ball, 0, r.cameraDynamics);
    }
    const curMats = getMaterialsConfig();
    r.networkReconciler.queueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
      packLoadoutCommandParam1(r.selectedPreset || localVisualId, r.selectedHitbox || localHitboxId || null),
      packLoadoutCommandParam2(
        r.selectedColorSlot ?? localColorSlot,
        curMats?.paintFinish || localPaintFinish,
        curMats?.boostVisual || localBoostVisual,
        curMats?.boostAudio || localBoostAudio
      )
    );
  };

  r.onSessionReady?.(r.networkReconciler, r.networkChannel);

  if (r.networkChannel) {
    r.networkChannel.onColorChange = (msg) => {
      const cIdx = msg.carIndex ?? (r.playerCarIndex === 0 ? 1 : 0);
      r.setCarColor(cIdx, msg.hex, false);
    };

    if (typeof r.networkChannel.send === 'function') {
      r.networkChannel.send(JSON.stringify({
        type: 'join',
        playerName: playerName,
        role: 'player',
        preferredTeam: typeof options.preferredTeam === 'number' ? options.preferredTeam : null,
        visualId: localVisualId,
        hitboxId: localHitboxId,
        colorSlot: localColorSlot,
        paintFinish: localPaintFinish,
        boostVisual: localBoostVisual,
        boostAudio: localBoostAudio,
      }));
    }
  }

  if (useAppStore && typeof useAppStore.getState === 'function') {
    useAppStore.getState().setMatchMode('online-warmup');
    useAppStore.getState().setOnlineSession({
      isHosting: false,
      playerName: playerName,
      signalingConnected: true,
    });
  }
  r.syncPausedAndInputState?.();

  return r.networkChannel;
}

export async function returnRuntimeOnlineMatchToLobby(manager, options = {}) {
  const r = manager.runtime;
  if (!r) return;
  if (options.fromServerRoster && r._latestServerRosterState && r._latestServerRosterState !== 'lobby') {
    return;
  }
  r._latestServerRosterState = 'lobby';
  const isHost = Boolean(r.authoritativeServer);

  r.replayTimelineController?.endReplaySession?.();
  r.goalReplayCameraOverrideActive = false;
  r.podiumController?.exitPodium?.();
  r.physics?.resetGoalLatch?.();
  r.physics?.clearReplayBuffer?.();
  r.physics?.setReplayRecordingActive?.(true);
  r.clientReplayOverflowPaused = false;
  r.physics?.setSimulationFrozen?.(false);
  r.physics?.setUnlimitedBoost?.(true);

  if (r.match?.state) {
    r.match.state.mode = 'freeplay';
    r.match.state.phase = 'lobby';
    r.match.state.paused = false;
    r.match.state.winner = null;
    r.match.state.winReason = null;
    r.match.state.countdown = 0;
  }
  hudStore?.getState?.()?.setMatchState?.({
    matchPhase: 'lobby',
    kickoffCountdown: 0,
    winner: null,
    winReason: null,
  });

  if (r.arena) {
    r.arena.isLobbyMode = true;
    r.arena.isHostLobby = isHost;
    for (let c = 0; c < 6; c++) {
      const isLocal = c === r.playerCarIndex;
      if (!isLocal) {
        if (typeof r.physics?.isCarSlotActive === 'function' && r.physics.isCarSlotActive(c)) {
          r.physics.removeCar?.(c);
        }
        if (r.arena.cars?.[c]) {
          r.arena.cars[c].visible = false;
        }
      } else if (r.arena.cars?.[c]) {
        r.arena.cars[c].visible = true;
      }
    }
  }

  r.networkReconciler?.resetTimelineState?.();

  if (isHost) {
    if (!options.fromServerRoster) {
      r.authoritativeServer.enterLobbyMode?.({
        ghostCars: true,
        hostInteractsWithBall: true,
        enableDiagnosticsFleet: true,
      });
    }
    r.networkReconciler?.setMatchTelemetryActive?.(true, true);
    manager.setLobbyGhostMode(true, {
      hostInteractsWithBall: true,
      syncServerLobby: !options.fromServerRoster,
    });
    await manager.spawnDiagnosticTestFleet();
    if (r._latestServerRosterState !== 'lobby' || r.match?.state?.mode === 'match') {
      return;
    }
    networkDiagnosticsStore?.syncZeroGFleetState?.(true);
    syncHostLobbyOngoingNotification(r);
  } else {
    r.networkReconciler?.setLobbyDualWorldMode?.(true);
    r.networkReconciler?.setMatchTelemetryActive?.(true, true);
    const ghostRenderer = manager.ensureMultiWorldGhostRenderer();
    if (ghostRenderer) {
      ghostRenderer.ensureWorld('lobby-remote', {
        paletteIndex: 0,
        opacity: 0.55,
        showCar: true,
        showBall: true,
      });
      ghostRenderer.setVisible(true);
    }
    await ensureClientLobbyDiagnosticProbes(r);
    if (r._latestServerRosterState !== 'lobby' || r.match?.state?.mode === 'match') {
      return;
    }
  }

  r.modeManager?.setMode?.('freeplay');
  if (useAppStore && typeof useAppStore.getState === 'function') {
    useAppStore.getState().setMatchMode('online-warmup');
  }
  r.syncPausedAndInputState?.();
}
