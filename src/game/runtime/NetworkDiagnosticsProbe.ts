import { DeterminismHarness } from '../../physics/DeterminismHarness.ts';
import type {
  DiagnosticsTestVehicleController,
} from '../../network/diagnostics/DiagnosticsTestVehicles.ts';
import type { sampleDiagnosticFleetTelemetry } from '../../network/diagnostics/ZeroGDiagnosticLab.ts';
import {
  DEFAULT_GHOST_OPACITY,
  type CarCollisionMaskEntry,
  type LobbyGhostCarCoordinator,
} from '../../network/server/LobbyGhostCarCoordinator.ts';
import type { MultiWorldGhostRenderer } from '../modes/MultiWorldGhostRenderer.ts';
import {
  networkDiagnosticsStore,
  type NameTagCarEntry,
} from '../runtimeUiPort.ts';
import {
  DiagnosticsFleetAndGhostController,
  type DiagnosticFleetSpawnOptions,
  type LobbyGhostModeConfigResult,
  type LobbyGhostModeOptions,
  type NetworkDiagnosticsHostPort,
} from './DiagnosticsFleetAndGhostController.ts';

export interface PhysicsRateOptions {
  min?: number;
  max?: number;
  round?: boolean;
}

export type {
  DiagnosticFleetSpawnOptions,
  LobbyGhostModeConfigResult,
  LobbyGhostModeOptions,
  NameTagCarEntry,
  NetworkDiagnosticsHostPort,
};

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
 * Sub-controller owning network diagnostics state, packet/latency impairment probes,
 * determinism harness lifecycle, and delegating Zero-G fleet & ghost isolation to DiagnosticsFleetAndGhostController.
 */
export class NetworkDiagnosticsProbe {
  private readonly host: NetworkDiagnosticsHostPort;
  public readonly fleetAndGhost: DiagnosticsFleetAndGhostController;
  determinismHarness: DeterminismHarness | null = null;
  diagnosticObservationTarget = 0;
  testCarAudioEnabled = false;
  physicsRate = 120;

  constructor(host: NetworkDiagnosticsHostPort) {
    this.host = host;
    this.fleetAndGhost = new DiagnosticsFleetAndGhostController(host);
  }

  get lobbyGhostCoordinator(): LobbyGhostCarCoordinator {
    return this.fleetAndGhost.lobbyGhostCoordinator;
  }

  get multiWorldGhostRenderer(): MultiWorldGhostRenderer | null {
    return this.fleetAndGhost.multiWorldGhostRenderer;
  }

  set multiWorldGhostRenderer(renderer: MultiWorldGhostRenderer | null) {
    this.fleetAndGhost.multiWorldGhostRenderer = renderer;
  }

  get diagnosticsFleetController(): DiagnosticsTestVehicleController | null {
    return this.fleetAndGhost.diagnosticsFleetController;
  }

  set diagnosticsFleetController(ctrl: DiagnosticsTestVehicleController | null) {
    this.fleetAndGhost.diagnosticsFleetController = ctrl;
  }

  get lobbyGhostMode(): boolean {
    return this.fleetAndGhost.lobbyGhostMode;
  }

  set lobbyGhostMode(enabled: boolean) {
    this.fleetAndGhost.lobbyGhostMode = enabled;
  }

  ensureMultiWorldGhostRenderer(): MultiWorldGhostRenderer | null {
    return this.fleetAndGhost.ensureMultiWorldGhostRenderer();
  }

  ensureLobbyRemoteGhostWorld(): MultiWorldGhostRenderer | null {
    return this.fleetAndGhost.ensureLobbyRemoteGhostWorld();
  }

  setMultiWorldGhostVisible(visible: boolean): void {
    this.fleetAndGhost.multiWorldGhostRenderer?.setVisible(Boolean(visible));
  }

  setLobbyGhostIsolationMode(enabled = true, interactWithBall = false): boolean {
    return this.fleetAndGhost.setLobbyGhostIsolationMode(enabled, interactWithBall);
  }

  configureLobbyGhostMode(
    enabled = true,
    optionsOrInteractWithBall: boolean | LobbyGhostModeOptions = {},
  ): LobbyGhostModeConfigResult {
    return this.fleetAndGhost.configureLobbyGhostMode(enabled, optionsOrInteractWithBall);
  }

  applyCarGhostCollision(
    carIndex: number,
    interactWithBall = false,
    interactWithCars = false,
    opacity = DEFAULT_GHOST_OPACITY,
  ): CarCollisionMaskEntry {
    return this.fleetAndGhost.applyCarGhostCollision(
      carIndex,
      interactWithBall,
      interactWithCars,
      opacity,
    );
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
    if (reconciler?.controlMessenger) {
      console.log(
        '%c[Network Packet Dump]%c Waiting for next incoming datagram...',
        'background:#1f6feb;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        'color:#58a6ff',
      );
      return reconciler.controlMessenger.triggerDumpNextPacket();
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

    await arena?.vehicleRegistry.ensureOpponent();
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
    return this.fleetAndGhost.spawnDiagnosticTestFleet(options);
  }

  despawnDiagnosticTestFleet(): void {
    this.diagnosticObservationTarget = 0;
    this.fleetAndGhost.despawnDiagnosticTestFleet();
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
    await this.fleetAndGhost.ensureClientLobbyDiagnosticProbes();
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
    return this.fleetAndGhost.sampleDiagnosticFleetTelemetry();
  }
}
