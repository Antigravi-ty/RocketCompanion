/**
 * RuntimeNetworkDiagnosticsHelper.js
 * Pure network & physics diagnostics, packet-drop injection, latency/jitter/impairment simulation,
 * Zero-G 3-Car Benchmark Lab orchestration, Lobby Ghost Car isolation, and determinism harness helpers.
 */

import { DeterminismHarness } from '../../physics/DeterminismHarness.js';
import {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET,
  DIAGNOSTIC_VEHICLE_PROFILES,
  ZERO_G_ANCHOR_MODES,
  DIAGNOSTIC_OBSERVATION_TARGETS,
  computeDiagnosticVehicleControls,
  setLobbyGhostCarIsolation,
  sampleDiagnosticFleetTelemetry
} from '../../network/diagnostics/DiagnosticsTestVehicles.js';
import { DEFAULT_GHOST_OPACITY } from '../../network/server/LobbyGhostCarCoordinator.js';
import {
  NetworkStressSimulator,
  NETWORK_STRESS_PRESETS,
  NETWORK_STRESS_PRESET_LIST,
  CONNECTION_HEALTH_STATES,
  evaluateConnectionQuality
} from '../../ui-core/config/networkStressConfig.js';
import { networkDiagnosticsStore } from '../../ui-core/stores/networkDiagnosticsStore';

export {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET,
  DIAGNOSTIC_VEHICLE_PROFILES,
  ZERO_G_ANCHOR_MODES,
  DIAGNOSTIC_OBSERVATION_TARGETS,
  computeDiagnosticVehicleControls,
  setLobbyGhostCarIsolation,
  sampleDiagnosticFleetTelemetry,
  NetworkStressSimulator,
  NETWORK_STRESS_PRESETS,
  NETWORK_STRESS_PRESET_LIST,
  CONNECTION_HEALTH_STATES,
  evaluateConnectionQuality
};

export function getRuntimePhysicsRate(r) {
  return r.interpolator?.physicsRate ?? r.physicsRate ?? 120;
}

export function adjustRuntimePhysicsRate(r, delta, options = {}) {
  const currentRate = getRuntimePhysicsRate(r);
  const deltaNum = Number(delta);
  if (!Number.isFinite(deltaNum)) return currentRate;
  return setRuntimePhysicsRate(r, currentRate + deltaNum, options);
}

export function setRuntimePhysicsRate(r, rate, options = {}) {
  if (r.interpolator && typeof r.interpolator.setPhysicsRate === 'function') {
    const applied = r.interpolator.setPhysicsRate(rate, options);
    r.physicsRate = applied;
    return applied;
  }
  const min = Number.isFinite(options.min) ? options.min : 108;
  const max = Number.isFinite(options.max) ? options.max : 132;
  const normalized = options.round ? Math.round(Number(rate)) : Math.round(Number(rate) * 100) / 100;
  const clamped = Math.max(min, Math.min(max, normalized));
  r.physicsRate = clamped;
  return clamped;
}

export function setRuntimePhysicsTickScale(r, scale, options = {}) {
  const scaleNum = Number(scale);
  if (!Number.isFinite(scaleNum) || scaleNum <= 0) return getRuntimePhysicsRate(r);
  return setRuntimePhysicsRate(r, 120 * scaleNum, options);
}

export function resetRuntimePhysicsRate(r) {
  return setRuntimePhysicsRate(r, 120);
}

export function dropRuntimePacketBurst(r, count = null) {
  const pkts = count ?? 5;
  if (r.networkChannel) {
    r.networkChannel.forceDropNextInput?.(pkts);
  }
}

export function dumpRuntimeNextNetworkPacket(r) {
  if (r.networkReconciler?.triggerDumpNextPacket) {
    console.log(
      '%c[Network Packet Dump]%c Waiting for next incoming datagram...',
      'background:#1f6feb;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
      'color:#58a6ff'
    );
    return r.networkReconciler.triggerDumpNextPacket();
  }
  console.warn('[Network Packet Dump] No active network prediction reconciler.');
  return Promise.resolve(null);
}

export function dumpRuntimeLatestNetworkPacket(r, packet = null) {
  if (r.networkReconciler?.dumpPacket) {
    return r.networkReconciler.dumpPacket(packet);
  }
  console.warn('[Network Packet Dump] No active network prediction reconciler.');
  return null;
}

export function adjustRuntimeNetworkLatency(r, deltaLatencyMs) {
  const storeExtra = networkDiagnosticsStore?.getSnapshot?.()?.metrics?.extraLatencyMs;
  const currentExtraLatency = typeof r.networkChannel?.extraLatencyMs === 'number' && Number.isFinite(r.networkChannel.extraLatencyMs)
    ? r.networkChannel.extraLatencyMs
    : (typeof storeExtra === 'number' && Number.isFinite(storeExtra) ? storeExtra : 0);
  const newLatency = Math.max(0, Math.min(500, Math.round(currentExtraLatency + deltaLatencyMs)));

  if (networkDiagnosticsStore?.setExtraLatency) {
    networkDiagnosticsStore.setExtraLatency(newLatency);
  }
  if (r.networkChannel) {
    if (typeof r.networkChannel.setExtraLatency === 'function') {
      r.networkChannel.setExtraLatency(newLatency);
    } else {
      r.networkChannel.extraLatencyMs = newLatency;
    }
  }
  if (r.networkReconciler) {
    const effectiveRtt = typeof r.networkReconciler._resolveEffectiveRtt === 'function'
      ? r.networkReconciler._resolveEffectiveRtt()
      : (r.networkChannel?.rttMs ?? (newLatency * 2));
    r.networkReconciler.leadTicks = r.networkReconciler.calculateLeadTicks(effectiveRtt);
    r.networkReconciler.metrics.leadTicks = r.networkReconciler.leadTicks;
    r.networkReconciler.metrics.rttMs = effectiveRtt;
    r.networkReconciler.notifyMetricsUpdated?.();
  }
}

export function adjustRuntimeSimulatedLatency(r, direction, stepMs) {
  const configuredStep = stepMs ?? networkDiagnosticsStore?.getSnapshot?.()?.metrics?.adjustStepMs ?? 50;
  adjustRuntimeNetworkLatency(r, direction * configuredStep);
}

export async function spawnRuntimeHeadlessCarEntity(r) {
  await r.arena?.ensureOpponent?.();
  if (r.arena?.cars?.[1]) {
    r.arena.cars[1].visible = true;
  }

  if (r.physics.numCars < 2) {
    r.physics.addCar(1, 'default');
  }

  if (r.authoritativeServer) {
    r.authoritativeServer.ensureCar(1, 1);
  }

  if (r.authoritativeServer && r.networkReconciler) {
    const snap = r.authoritativeServer.sim.saveCompactState();
    const sTick = Math.floor(r.authoritativeServer.sim.getHeaderView().tickCount);
    r.networkReconciler.syncTimeline(snap, sTick);
  }
  if (r.interpolator) {
    r.interpolator.sync();
  }
}

export async function enableRuntimeDeterminismHarness(r, showHUD = true) {
  if (!r.determinismHarness) {
    r.determinismHarness = new DeterminismHarness(r.physics);
    await r.determinismHarness.init();
  }
  r.onDeterminismHarnessReady?.(r.determinismHarness, showHUD);
  return r.determinismHarness;
}

/**
 * Spawns and activates the 2 in-arena Network Quality Diagnostic vehicles
 * (Car 6: Gravity Boost Loop Probe at X=-2500, Y=-400, Z=500; Car 7: 0G QE Roll Probe at X=-2500, Y=400, Z=550).
 */
export async function spawnRuntimeDiagnosticTestFleet(r, options = {}) {
  const mode = r.match?.state?.mode;
  const phase = r.match?.state?.phase;
  if (mode === 'match' && phase && phase !== 'lobby' && phase !== 'freeplay') {
    return null;
  }

  const anchorMode = options.anchorMode || r.diagnosticsFleetController?.anchorMode || ZERO_G_ANCHOR_MODES.Z_HOVER;

  // If running as client connected to remote host, delegate command to host authority
  if (r.networkChannel && !r.authoritativeServer) {
    if (typeof r.networkChannel.sendDiagnosticFleetToggle === 'function') {
      r.networkChannel.sendDiagnosticFleetToggle(true, anchorMode);
    }
    return null;
  }

  if (!r.diagnosticsFleetController) {
    r.diagnosticsFleetController = new DiagnosticsTestVehicleController(DEFAULT_DIAGNOSTIC_FLEET, { anchorMode });
  }
  r.diagnosticsFleetController.anchorMode = anchorMode;
  r.diagnosticsFleetController.enabled = true;

  for (const spec of DEFAULT_DIAGNOSTIC_FLEET) {
    if (r.arena?.ensureCar) {
      r.arena.ensureCar(spec.carIndex, spec.team, 'fennec');
      if (r.arena.cars[spec.carIndex]) {
        r.arena.cars[spec.carIndex].visible = true;
      }
    } else if (r.arena) {
      while (r.arena.cars.length <= spec.carIndex) {
        r.arena.addCar(spec.team, 'fennec');
      }
      if (r.arena.cars[spec.carIndex]) {
        r.arena.cars[spec.carIndex].visible = true;
      }
    }
  }

  if (r.physics) {
    r.diagnosticsFleetController.configurePhysics(r.physics, anchorMode);
  }

  if (r.authoritativeServer) {
    if (!r.authoritativeServer.isWorker) {
      r.diagnosticsFleetController.configurePhysics(r.authoritativeServer, anchorMode);
    }
    r.authoritativeServer.configureDiagnosticFleet?.(true, anchorMode);
  }

  if (r.authoritativeServer && r.networkReconciler && !r.authoritativeServer.isWorker) {
    const snap = r.authoritativeServer.sim.saveCompactState();
    const sTick = Math.floor(r.authoritativeServer.sim.getHeaderView().tickCount);
    r.networkReconciler.syncTimeline(snap, sTick);
  }
  if (r.interpolator) {
    r.interpolator.sync();
  }
  return r.diagnosticsFleetController;
}

/**
 * Deactivates the externalized Zero-G diagnostic fleet and parks diagnostic vehicle slots.
 */
export function despawnRuntimeDiagnosticTestFleet(r) {
  if (r.diagnosticsFleetController) {
    r.diagnosticsFleetController.enabled = false;
    if (r.physics) {
      r.diagnosticsFleetController.releasePhysics(r.physics);
    }
  } else if (r.physics) {
    const tempCtrl = new DiagnosticsTestVehicleController(DEFAULT_DIAGNOSTIC_FLEET);
    tempCtrl.releasePhysics(r.physics);
  }
  if (r.authoritativeServer && r.arena?.isLobbyMode) {
    if (!r.authoritativeServer.isWorker && r.diagnosticsFleetController) {
      r.diagnosticsFleetController.releasePhysics(r.authoritativeServer);
    }
    r.authoritativeServer.configureDiagnosticFleet?.(false);
  }
  r.diagnosticObservationTarget = 0;
  for (const spec of DEFAULT_DIAGNOSTIC_FLEET) {
    if (r.arena?.cars?.[spec.carIndex]) {
      r.arena.cars[spec.carIndex].visible = false;
    }
    r.arena?.resetCarBoosts?.(spec.carIndex);
    r.arena?.carDemolitions?.[spec.carIndex]?.stop?.();
  }
}

export async function toggleRuntimeDiagnosticTestFleet(r, forceEnabled = null, anchorMode = null) {
  const nextEnabled = forceEnabled !== null
    ? Boolean(forceEnabled)
    : !Boolean(r.diagnosticsFleetController?.enabled);
  if (nextEnabled) {
    return spawnRuntimeDiagnosticTestFleet(r, { anchorMode });
  }
  if (r.networkChannel && !r.authoritativeServer && r.arena?.isLobbyMode) {
    r.networkChannel.sendDiagnosticFleetToggle?.(false, null);
  }
  despawnRuntimeDiagnosticTestFleet(r);
  return null;
}

export function setRuntimeDiagnosticObservationTarget(r, targetCarIndex = 0) {
  const idx = Math.max(0, Math.min(7, Math.floor(Number(targetCarIndex) || 0)));
  r.diagnosticObservationTarget = idx;
  if (idx > 0 && r.camera) {
    r.camera.ballCam = false;
  }
  return idx;
}

export function setRuntimeLobbyGhostMode(r, enabled = true, interactWithBall = false) {
  const playerIdx = r.playerCarIndex ?? 0;
  r.lobbyGhostModeEnabled = Boolean(enabled);
  if (r.physics) {
    setLobbyGhostCarIsolation(r.physics, playerIdx, enabled, interactWithBall);
  }
  if (r.authoritativeServer) {
    setLobbyGhostCarIsolation(r.authoritativeServer, playerIdx, enabled, interactWithBall);
  }
  return r.lobbyGhostModeEnabled;
}

export function configureRuntimeLobbyGhostMode(r, lobbyGhostCoordinator, enabled = true, optionsOrInteractWithBall = {}) {
  const options = typeof optionsOrInteractWithBall === 'boolean'
    ? { interactWithBall: optionsOrInteractWithBall, hostInteractsWithBall: optionsOrInteractWithBall }
    : (optionsOrInteractWithBall || {});
  const opacity = options.ghostOpacity ?? DEFAULT_GHOST_OPACITY;
  const hostInteractsWithBall = options.hostInteractsWithBall ?? true;
  const activeIndices = [];
  if (!enabled) {
    for (let i = 0; i < 8; i++) activeIndices.push(i);
  } else {
    const numCars = Math.min(r.physics?.numCars || 1, 8);
    for (let i = 0; i < 8; i++) {
      const isSlotActive = typeof r.physics?.isCarSlotActive === 'function'
        ? r.physics.isCarSlotActive(i)
        : i < numCars;
      if (isSlotActive || i < numCars) {
        activeIndices.push(i);
      }
    }
    if (activeIndices.length === 0) activeIndices.push(0);
  }

  r.lobbyGhostMode = Boolean(enabled);
  r.lobbyGhostModeEnabled = Boolean(enabled);

  const cfg = lobbyGhostCoordinator.configureLobbyMode(r.physics, activeIndices, {
    ...options,
    enabled,
    hostInteractsWithBall,
    ghostOpacity: opacity
  });

  if (r.authoritativeServer && options.syncServerLobby !== false) {
    r.authoritativeServer.setLobbyMode?.(enabled, {
      ...options,
      hostInteractsWithBall,
      ghostOpacity: opacity
    });
  }

  if (!enabled) {
    r.arena?.clearAllGhostOpacities?.();
  } else if (r.arena) {
    for (const entry of cfg.cars) {
      r.arena.setCarGhostOpacity?.(entry.carIndex, entry.isGhost, entry.opacity);
    }
  }
  return cfg;
}

export function applyRuntimeCarGhostCollision(r, lobbyGhostCoordinator, carIndex, interactWithBall = false, interactWithCars = false, opacity = DEFAULT_GHOST_OPACITY) {
  const entry = lobbyGhostCoordinator.applyCarCollisionMask(
    r.physics,
    carIndex,
    interactWithBall,
    interactWithCars,
    opacity
  );
  r.authoritativeServer?.setGhostCarConfig?.(carIndex, interactWithBall, interactWithCars, opacity);
  r.arena?.setCarGhostOpacity?.(carIndex, entry.isGhost, entry.opacity);
  return entry;
}
