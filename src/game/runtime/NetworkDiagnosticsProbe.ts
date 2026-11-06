import { DeterminismHarness } from '../../physics/DeterminismHarness.ts';
import {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET,
  ZERO_G_ANCHOR_MODES,
  configureZeroGVehiclePhysics,
  setLobbyGhostCarIsolation,
  sampleDiagnosticFleetTelemetry,
  type DiagnosticVehicleSpec,
} from '../../network/diagnostics/DiagnosticsTestVehicles.ts';
import {
  LobbyGhostCarCoordinator,
  DEFAULT_GHOST_OPACITY,
  type CarCollisionMaskEntry,
} from '../../network/server/LobbyGhostCarCoordinator.ts';
import { MultiWorldGhostRenderer } from '../modes/MultiWorldGhostRenderer.ts';
import { configureClientLobbyDiagnosticProbes } from '../../network/client/NetworkTelemetryCollector.ts';
import {
  networkDiagnosticsStore,
  getNameTagRuntimeState,
  setNameTagRuntimeState,
  type NameTagCarEntry,
} from '../runtimeUiPort.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type { NetworkSessionChannelLike } from './onlineLobbyTransitionPipeline.ts';

export interface PhysicsRateOptions {
  min?: number;
  max?: number;
  round?: boolean;
}

export interface LobbyGhostModeOptions {
  interactWithBall?: boolean;
  hostInteractsWithBall?: boolean;
  ghostOpacity?: number;
  syncServerLobby?: boolean;
  [key: string]: unknown;
}

export interface DiagnosticFleetSpawnOptions {
  anchorMode?: string | null;
}

export type { NameTagCarEntry };

export interface LobbyGhostModeConfigResult {
  enabled?: boolean;
  lobbyModeActive?: boolean;
  hostCarIndex?: number;
  broadcastHostOnly?: boolean;
  mode: string;
  ghostOpacity: number;
  cars: CarCollisionMaskEntry[];
}

/**
 * Narrow host adapter interface decoupling NetworkDiagnosticsProbe from GameRuntime internals.
 */
export interface NetworkDiagnosticsHostPort {
  getPhysics(): RocketSimPhysicsEngine | null;
  getArena(): ArenaWorld | null;
  getInterpolator(): PhysicsStateInterpolator | null;
  getCamera(): CameraManager | null;
  getAuthoritativeServer(): AuthoritativeServerHost | null;
  getNetworkChannel(): NetworkSessionChannelLike | null;
  getNetworkReconciler(): PredictionReconciler | null;
  getPlayerCarIndex(): number;
  isMatchPhaseBlockingDiagnosticsFleet(): boolean;
  ensureFlipResetVisual(carIndex: number): void;
  notifyDeterminismHarnessReady(harness: DeterminismHarness, showHUD: boolean): void;
}

/**
 * Pure calculation for clamped and rounded simulation tick rate.
 */
export function computeClampedPhysicsRate(rate: number, options: PhysicsRateOptions = {}): number {
  const minRate = Number.isFinite(options.min) ? Number(options.min) : 108;
  const maxRate = Number.isFinite(options.max) ? Number(options.max) : 132;
  const numericRate = Number(rate);
  const normalized = options.round ? Math.round(numericRate) : Math.round(numericRate * 100) / 100;
  return Math.max(minRate, Math.min(maxRate, normalized));
}

/**
 * Pure calculation for clamped extra artificial latency in milliseconds.
 */
export function computeAdjustedExtraLatencyMs(
  currentChannelExtraMs: number | undefined,
  storeExtraMs: number | undefined,
  deltaLatencyMs: number,
): number {
  const baseExtra =
    typeof currentChannelExtraMs === 'number' && Number.isFinite(currentChannelExtraMs)
      ? currentChannelExtraMs
      : typeof storeExtraMs === 'number' && Number.isFinite(storeExtraMs)
        ? storeExtraMs
        : 0;
  return Math.max(0, Math.min(500, Math.round(baseExtra + deltaLatencyMs)));
}

/**
 * Pure calculation of active car slot indices for lobby ghost collision configuration.
 */
export function resolveLobbyGhostActiveCarIndices(
  enabled: boolean,
  numCars: number,
  isCarSlotActive?: ((slotIndex: number) => boolean) | null,
): number[] {
  const activeIndices: number[] = [];
  if (!enabled) {
    for (let slotIndex = 0; slotIndex < 8; slotIndex++) activeIndices.push(slotIndex);
    return activeIndices;
  }

  const boundedNumCars = Math.min(Math.max(1, numCars || 1), 8);
  for (let slotIndex = 0; slotIndex < 8; slotIndex++) {
    const slotActive =
      typeof isCarSlotActive === 'function'
        ? isCarSlotActive(slotIndex)
        : slotIndex < boundedNumCars;
    if (slotActive || slotIndex < boundedNumCars) {
      activeIndices.push(slotIndex);
    }
  }
  if (activeIndices.length === 0) activeIndices.push(0);
  return activeIndices;
}

/**
 * Pure transformation ensuring diagnostic probe vehicles (Car 6 Boost, Car 7 Roll) exist in name tag entries.
 */
export function mergeDiagnosticProbeNameTagEntries(
  existingEntries: readonly NameTagCarEntry[] | null | undefined,
): NameTagCarEntry[] {
  const mergedEntries: NameTagCarEntry[] = Array.isArray(existingEntries)
    ? [...existingEntries]
    : [];
  if (!mergedEntries.some((entry) => entry.carIndex === 6)) {
    mergedEntries.push({ carIndex: 6, name: 'Boost', team: 0 });
  }
  if (!mergedEntries.some((entry) => entry.carIndex === 7)) {
    mergedEntries.push({ carIndex: 7, name: 'Roll', team: 1 });
  }
  return mergedEntries;
}

/**
 * Sub-controller owning network diagnostics state, packet/latency impairment probes,
 * Zero-G diagnostic vehicle fleet, lobby ghost car isolation, and determinism harness lifecycle.
 */
export class NetworkDiagnosticsProbe {
  private readonly host: NetworkDiagnosticsHostPort;
  readonly lobbyGhostCoordinator: LobbyGhostCarCoordinator;
  multiWorldGhostRenderer: MultiWorldGhostRenderer | null = null;
  diagnosticsFleetController: DiagnosticsTestVehicleController | null = null;
  determinismHarness: DeterminismHarness | null = null;
  diagnosticObservationTarget = 0;
  lobbyGhostMode = false;
  testCarAudioEnabled = false;
  physicsRate = 120;

  constructor(host: NetworkDiagnosticsHostPort) {
    this.host = host;
    this.lobbyGhostCoordinator = new LobbyGhostCarCoordinator();
  }

  ensureMultiWorldGhostRenderer(): MultiWorldGhostRenderer | null {
    const arena = this.host.getArena();
    if (!this.multiWorldGhostRenderer && arena) {
      this.multiWorldGhostRenderer = new MultiWorldGhostRenderer(arena);
    }
    return this.multiWorldGhostRenderer;
  }

  ensureLobbyRemoteGhostWorld(): MultiWorldGhostRenderer | null {
    const ghostRenderer = this.ensureMultiWorldGhostRenderer();
    if (ghostRenderer) {
      ghostRenderer.ensureWorld('lobby-remote', {
        paletteIndex: 0,
        opacity: 0.55,
        showCar: true,
        showBall: true,
      });
      ghostRenderer.setVisible(true);
    }
    return ghostRenderer;
  }

  setMultiWorldGhostVisible(visible: boolean): void {
    this.multiWorldGhostRenderer?.setVisible(Boolean(visible));
  }

  setLobbyGhostIsolationMode(enabled = true, interactWithBall = false): boolean {
    const playerIdx = this.host.getPlayerCarIndex() ?? 0;
    const physics = this.host.getPhysics();
    const authoritativeServer = this.host.getAuthoritativeServer();
    this.lobbyGhostMode = Boolean(enabled);
    if (physics) setLobbyGhostCarIsolation(physics, playerIdx, enabled, interactWithBall);
    if (authoritativeServer) {
      setLobbyGhostCarIsolation(authoritativeServer, playerIdx, enabled, interactWithBall);
    }
    return this.lobbyGhostMode;
  }

  configureLobbyGhostMode(
    enabled = true,
    optionsOrInteractWithBall: boolean | LobbyGhostModeOptions = {},
  ): LobbyGhostModeConfigResult {
    const physics = this.host.getPhysics();
    const arena = this.host.getArena();
    const authoritativeServer = this.host.getAuthoritativeServer();

    const options: LobbyGhostModeOptions =
      typeof optionsOrInteractWithBall === 'boolean'
        ? {
            interactWithBall: optionsOrInteractWithBall,
            hostInteractsWithBall: optionsOrInteractWithBall,
          }
        : optionsOrInteractWithBall || {};
    const opacity = options.ghostOpacity ?? DEFAULT_GHOST_OPACITY;
    const hostInteractsWithBall = options.hostInteractsWithBall ?? true;

    const activeIndices = resolveLobbyGhostActiveCarIndices(
      Boolean(enabled),
      physics?.numCars || 1,
      typeof physics?.isCarSlotActive === 'function'
        ? (slotIndex: number) => physics.isCarSlotActive(slotIndex)
        : null,
    );

    this.lobbyGhostMode = Boolean(enabled);

    const configResult = this.lobbyGhostCoordinator.configureLobbyMode(physics, activeIndices, {
      ...options,
      enabled,
      hostInteractsWithBall,
      ghostOpacity: opacity,
    }) as LobbyGhostModeConfigResult;

    if (authoritativeServer && options.syncServerLobby !== false) {
      authoritativeServer.setLobbyMode?.(enabled, {
        ...options,
        hostInteractsWithBall,
        ghostOpacity: opacity,
      });
    }

    if (!enabled) {
      arena?.clearAllGhostOpacities?.();
    } else if (arena && Array.isArray(configResult?.cars)) {
      for (const entry of configResult.cars) {
        arena.setCarGhostOpacity?.(entry.carIndex, entry.isGhost, entry.opacity);
      }
    }

    this.ensureMultiWorldGhostRenderer()?.setVisible(Boolean(enabled));

    if (!enabled && arena?.cars) {
      const visibleCarCount = Math.min(physics?.numCars || 1, arena.cars.length);
      for (let carIndex = 0; carIndex < visibleCarCount; carIndex++) {
        if (arena.cars[carIndex]) arena.cars[carIndex].visible = true;
      }
    }

    return configResult;
  }

  applyCarGhostCollision(
    carIndex: number,
    interactWithBall = false,
    interactWithCars = false,
    opacity = DEFAULT_GHOST_OPACITY,
  ): CarCollisionMaskEntry {
    const physics = this.host.getPhysics();
    const authoritativeServer = this.host.getAuthoritativeServer();
    const arena = this.host.getArena();
    const entry = this.lobbyGhostCoordinator.applyCarCollisionMask(
      physics,
      carIndex,
      interactWithBall,
      interactWithCars,
      opacity,
    );
    authoritativeServer?.setGhostCarConfig?.(carIndex, interactWithBall, interactWithCars, opacity);
    arena?.setCarGhostOpacity?.(carIndex, entry.isGhost, entry.opacity);
    return entry;
  }

  getPhysicsRate(): number {
    return this.host.getInterpolator()?.physicsRate ?? this.physicsRate ?? 120;
  }

  setPhysicsRate(rate: number, options: PhysicsRateOptions = {}): number {
    const interpolator = this.host.getInterpolator();
    if (interpolator && typeof interpolator.setPhysicsRate === 'function') {
      const applied = interpolator.setPhysicsRate(rate, options);
      this.physicsRate = applied;
      return applied;
    }
    const clamped = computeClampedPhysicsRate(rate, options);
    this.physicsRate = clamped;
    return clamped;
  }

  adjustPhysicsRate(delta: number, options: PhysicsRateOptions = {}): number {
    const currentRate = this.getPhysicsRate();
    const deltaNum = Number(delta);
    if (!Number.isFinite(deltaNum)) return currentRate;
    return this.setPhysicsRate(currentRate + deltaNum, options);
  }

  setPhysicsTickScale(scale: number, options: PhysicsRateOptions = {}): number {
    const scaleNum = Number(scale);
    if (!Number.isFinite(scaleNum) || scaleNum <= 0) return this.getPhysicsRate();
    return this.setPhysicsRate(120 * scaleNum, options);
  }

  resetPhysicsRate(): number {
    return this.setPhysicsRate(120);
  }

  dropPacketBurst(count: number | null = null): void {
    this.host.getNetworkChannel()?.forceDropNextInput?.(count ?? 5);
  }

  dumpNextNetworkPacket(): Promise<unknown> {
    const reconciler = this.host.getNetworkReconciler();
    if (reconciler?.triggerDumpNextPacket) {
      console.log(
        '%c[Network Packet Dump]%c Waiting for next incoming datagram...',
        'background:#1f6feb;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        'color:#58a6ff',
      );
      return reconciler.triggerDumpNextPacket();
    }
    console.warn('[Network Packet Dump] No active network prediction reconciler.');
    return Promise.resolve(null);
  }

  dumpLatestNetworkPacket(packet: Uint8Array | ArrayBuffer | null = null): unknown {
    const reconciler = this.host.getNetworkReconciler();
    if (reconciler?.dumpPacket) return reconciler.dumpPacket(packet);
    console.warn('[Network Packet Dump] No active network prediction reconciler.');
    return null;
  }

  adjustNetworkLatency(deltaLatencyMs: number): number {
    const channel = this.host.getNetworkChannel();
    const reconciler = this.host.getNetworkReconciler();
    const storeExtra = networkDiagnosticsStore?.getSnapshot?.()?.metrics?.extraLatencyMs;
    const newLatency = computeAdjustedExtraLatencyMs(
      channel?.extraLatencyMs,
      storeExtra,
      deltaLatencyMs,
    );

    networkDiagnosticsStore?.setExtraLatency?.(newLatency);
    if (channel) {
      if (typeof channel.setExtraLatency === 'function') {
        channel.setExtraLatency(newLatency);
      } else {
        channel.extraLatencyMs = newLatency;
      }
    }
    if (reconciler) {
      const effectiveRtt =
        typeof reconciler._resolveEffectiveRtt === 'function'
          ? reconciler._resolveEffectiveRtt()
          : (channel?.rttMs ?? newLatency * 2);
      reconciler.leadTicks = reconciler.calculateLeadTicks(effectiveRtt);
      reconciler.metrics.leadTicks = reconciler.leadTicks;
      reconciler.metrics.rttMs = effectiveRtt;
      reconciler.notifyMetricsUpdated?.();
    }
    return newLatency;
  }

  adjustSimulatedLatency(direction: number, stepMs?: number): number {
    const configuredStep =
      stepMs ?? networkDiagnosticsStore?.getSnapshot?.()?.metrics?.adjustStepMs ?? 50;
    return this.adjustNetworkLatency(direction * configuredStep);
  }

  async spawnHeadlessCarEntity(): Promise<void> {
    const arena = this.host.getArena();
    const physics = this.host.getPhysics();
    const authoritativeServer = this.host.getAuthoritativeServer();
    const reconciler = this.host.getNetworkReconciler();

    await arena?.ensureOpponent?.();
    if (arena?.cars?.[1]) arena.cars[1].visible = true;
    if (physics && physics.numCars < 2) physics.addCar(1, 'default');
    if (authoritativeServer) authoritativeServer.ensureCar(1, 1);
    if (authoritativeServer && reconciler) {
      const snapshot = authoritativeServer.sim.saveCompactState();
      const serverTick = Math.floor(authoritativeServer.sim.getHeaderView().tickCount);
      reconciler.syncTimeline(snapshot, serverTick);
    }
    this.host.getInterpolator()?.sync?.();
  }

  async enableDeterminismHarness(showHUD = true): Promise<DeterminismHarness | null> {
    const physics = this.host.getPhysics();
    if (!physics) return null;
    if (!this.determinismHarness) {
      this.determinismHarness = new DeterminismHarness(physics);
      await this.determinismHarness.init();
    }
    this.host.notifyDeterminismHarnessReady(this.determinismHarness, showHUD);
    return this.determinismHarness;
  }

  async spawnDiagnosticTestFleet(
    options: DiagnosticFleetSpawnOptions = {},
  ): Promise<DiagnosticsTestVehicleController | null> {
    if (this.host.isMatchPhaseBlockingDiagnosticsFleet()) return null;

    const anchorMode =
      options.anchorMode ||
      this.diagnosticsFleetController?.anchorMode ||
      ZERO_G_ANCHOR_MODES.Z_HOVER;

    const channel = this.host.getNetworkChannel();
    const authoritativeServer = this.host.getAuthoritativeServer();
    const physics = this.host.getPhysics();
    const arena = this.host.getArena();
    const reconciler = this.host.getNetworkReconciler();

    if (channel && !authoritativeServer) {
      channel.sendDiagnosticFleetToggle?.(true, anchorMode);
      return null;
    }

    if (!this.diagnosticsFleetController) {
      this.diagnosticsFleetController = new DiagnosticsTestVehicleController(
        [...DEFAULT_DIAGNOSTIC_FLEET],
        { anchorMode },
      );
    }
    this.diagnosticsFleetController.anchorMode = anchorMode;
    this.diagnosticsFleetController.enabled = true;

    for (const spec of DEFAULT_DIAGNOSTIC_FLEET) {
      if (arena?.ensureCar) {
        arena.ensureCar(spec.carIndex, spec.team, 'fennec');
        if (arena.cars[spec.carIndex]) arena.cars[spec.carIndex].visible = true;
      } else if (arena) {
        while (arena.cars.length <= spec.carIndex) arena.addCar(spec.team, 'fennec');
        if (arena.cars[spec.carIndex]) arena.cars[spec.carIndex].visible = true;
      }
    }

    if (physics) this.diagnosticsFleetController.configurePhysics(physics, anchorMode);
    if (authoritativeServer) {
      if (!authoritativeServer.isWorker) {
        this.diagnosticsFleetController.configurePhysics(authoritativeServer, anchorMode);
      }
      authoritativeServer.configureDiagnosticFleet?.(true, anchorMode);
    }
    if (authoritativeServer && reconciler && !authoritativeServer.isWorker) {
      const snapshot = authoritativeServer.sim.saveCompactState();
      const serverTick = Math.floor(authoritativeServer.sim.getHeaderView().tickCount);
      reconciler.syncTimeline(snapshot, serverTick);
    }
    this.host.getInterpolator()?.sync?.();
    return this.diagnosticsFleetController;
  }

  despawnDiagnosticTestFleet(): void {
    const physics = this.host.getPhysics();
    const authoritativeServer = this.host.getAuthoritativeServer();
    const arena = this.host.getArena();

    if (this.diagnosticsFleetController) {
      this.diagnosticsFleetController.enabled = false;
      if (physics) this.diagnosticsFleetController.releasePhysics(physics);
    } else if (physics) {
      const temporaryController = new DiagnosticsTestVehicleController([
        ...DEFAULT_DIAGNOSTIC_FLEET,
      ]);
      temporaryController.releasePhysics(physics);
    }
    if (authoritativeServer && arena?.isLobbyMode) {
      if (!authoritativeServer.isWorker && this.diagnosticsFleetController) {
        this.diagnosticsFleetController.releasePhysics(authoritativeServer);
      }
      authoritativeServer.configureDiagnosticFleet?.(false);
    }
    this.diagnosticObservationTarget = 0;
    for (const spec of DEFAULT_DIAGNOSTIC_FLEET) {
      if (arena?.cars?.[spec.carIndex]) arena.cars[spec.carIndex].visible = false;
      arena?.resetCarBoosts?.(spec.carIndex);
      arena?.carDemolitions?.[spec.carIndex]?.stop?.();
    }
  }

  async toggleDiagnosticTestFleet(
    forceEnabled: boolean | null = null,
    anchorMode: string | null = null,
  ): Promise<DiagnosticsTestVehicleController | null> {
    const nextEnabled =
      forceEnabled !== null
        ? Boolean(forceEnabled)
        : !Boolean(this.diagnosticsFleetController?.enabled);
    if (nextEnabled) return this.spawnDiagnosticTestFleet({ anchorMode });
    const channel = this.host.getNetworkChannel();
    const authoritativeServer = this.host.getAuthoritativeServer();
    const arena = this.host.getArena();
    if (channel && !authoritativeServer && arena?.isLobbyMode) {
      channel.sendDiagnosticFleetToggle?.(false, null);
    }
    this.despawnDiagnosticTestFleet();
    return null;
  }

  async ensureClientLobbyDiagnosticProbes(): Promise<void> {
    const physics = this.host.getPhysics();
    const reconciler = this.host.getNetworkReconciler();
    const arena = this.host.getArena();

    if (physics) {
      const alreadySyncedProbes = Boolean(
        reconciler?.isTimelineSynchronized &&
          typeof physics.isCarSlotActive === 'function' &&
          physics.isCarSlotActive(6) &&
          physics.isCarSlotActive(7),
      );
      if (alreadySyncedProbes) {
        configureClientLobbyDiagnosticProbes(physics);
      } else {
        configureZeroGVehiclePhysics(physics, [...DEFAULT_DIAGNOSTIC_FLEET]);
      }
    }

    if (arena && typeof arena.ensureCar === 'function') {
      await Promise.all([arena.ensureCar(6, 0, 'fennec'), arena.ensureCar(7, 1, 'fennec')]);
      for (const definition of DEFAULT_DIAGNOSTIC_FLEET as readonly (DiagnosticVehicleSpec & {
        colorHex?: string;
      })[]) {
        const carIndex = definition.carIndex;
        const carMesh = arena.cars?.[carIndex];
        if (carMesh) {
          carMesh.visible = true;
          if (definition.colorHex) carMesh.setCustomBodyColor?.(definition.colorHex);
        }
        this.host.ensureFlipResetVisual(carIndex);
      }
    }

    try {
      const currentNameTags = getNameTagRuntimeState?.();
      const updatedEntries = mergeDiagnosticProbeNameTagEntries(currentNameTags?.carEntries);
      setNameTagRuntimeState?.({
        isMultiplayerOrMultiCarMode: true,
        carEntries: updatedEntries,
      });
    } catch {
      // Ignore name tag state update errors in headless environments
    }

    networkDiagnosticsStore?.syncZeroGFleetState?.(true);
  }

  setDiagnosticObservationTarget(targetCarIndex = 0): number {
    const clampedIndex = Math.max(0, Math.min(7, Math.floor(Number(targetCarIndex) || 0)));
    this.diagnosticObservationTarget = clampedIndex;
    const camera = this.host.getCamera();
    if (clampedIndex > 0 && camera) camera.ballCam = false;
    return clampedIndex;
  }

  setTestCarAudioEnabled(enabled = false, syncStore = false): boolean {
    this.testCarAudioEnabled = Boolean(enabled);
    if (syncStore) networkDiagnosticsStore?.setTestCarAudioEnabled?.(this.testCarAudioEnabled);
    return this.testCarAudioEnabled;
  }

  toggleTestCarAudio(forceEnabled: boolean | null = null): boolean {
    const nextEnabled =
      forceEnabled !== null ? Boolean(forceEnabled) : !Boolean(this.testCarAudioEnabled);
    this.testCarAudioEnabled = nextEnabled;
    return nextEnabled;
  }

  sampleDiagnosticFleetTelemetry(): ReturnType<typeof sampleDiagnosticFleetTelemetry> {
    const physics = this.host.getPhysics();
    if (!physics) return [];
    const authoritativeServer = this.host.getAuthoritativeServer();
    const reconciler = this.host.getNetworkReconciler();
    const serverStateBuffer =
      authoritativeServer?.fallbackSim?.state ||
      (authoritativeServer?.isWorker ? authoritativeServer?.cachedSnapshot : null) ||
      reconciler?.lastParsedPacket?.stateSnapshot ||
      null;
    return sampleDiagnosticFleetTelemetry(physics, serverStateBuffer, [
      ...DEFAULT_DIAGNOSTIC_FLEET,
    ]);
  }
}
