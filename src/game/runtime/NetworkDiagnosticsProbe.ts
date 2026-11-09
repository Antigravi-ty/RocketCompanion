import { DeterminismHarness } from '../../physics/DeterminismHarness.ts';
import type { DiagnosticsTestVehicleController } from '../../network/diagnostics/DiagnosticsTestVehicles.ts';
import type { sampleDiagnosticFleetTelemetry } from '../../network/diagnostics/ZeroGDiagnosticLab.ts';
import {
  DEFAULT_GHOST_OPACITY,
  type CarCollisionMaskEntry,
  type LobbyGhostCarCoordinator,
} from '../../network/server/LobbyGhostCarCoordinator.ts';
import type { MultiWorldGhostRenderer } from '../modes/MultiWorldGhostRenderer.ts';
import { networkDiagnosticsStore, type NameTagCarEntry } from '../runtimeUiPort.ts';
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

export function computeClampedPhysicsRate(rate: number, options: PhysicsRateOptions = {}): number {
  const minRate = Number.isFinite(options.min) ? Number(options.min) : 108;
  const maxRate = Number.isFinite(options.max) ? Number(options.max) : 132;
  const numericRate = Number(rate);
  const normalized = options.round ? Math.round(numericRate) : Math.round(numericRate * 100) / 100;
  return Math.max(minRate, Math.min(maxRate, normalized));
}

export function computeAdjustedExtraLatencyMs(
  currentChannelExtraMs: number | undefined,
  storeExtraMs: number | undefined,
  deltaLatencyMs: number
): number {
  const baseExtra =
    typeof currentChannelExtraMs === 'number' && Number.isFinite(currentChannelExtraMs)
      ? currentChannelExtraMs
      : typeof storeExtraMs === 'number' && Number.isFinite(storeExtraMs)
        ? storeExtraMs
        : 0;
  return Math.max(0, Math.min(500, Math.round(baseExtra + deltaLatencyMs)));
}

export class NetworkDiagnosticsProbe {
  private readonly context: NetworkDiagnosticsHostPort;
  public readonly fleetAndGhost: DiagnosticsFleetAndGhostController;
  determinismHarness: DeterminismHarness | null = null;
  diagnosticObservationTarget = 0;
  testCarAudioEnabled = false;
  physicsRate = 120;

  readonly ensureMultiWorldGhostRenderer: () => MultiWorldGhostRenderer | null;
  readonly ensureLobbyRemoteGhostWorld: () => MultiWorldGhostRenderer | null;
  readonly setLobbyGhostIsolationMode: (enabled?: boolean, interactWithBall?: boolean) => boolean;
  readonly configureLobbyGhostMode: (
    enabled?: boolean,
    optionsOrInteractWithBall?: boolean | LobbyGhostModeOptions
  ) => LobbyGhostModeConfigResult;
  readonly applyCarGhostCollision: (
    carIndex: number,
    interactWithBall?: boolean,
    interactWithCars?: boolean,
    opacity?: number
  ) => CarCollisionMaskEntry;
  readonly spawnDiagnosticTestFleet: (
    options?: DiagnosticFleetSpawnOptions
  ) => Promise<DiagnosticsTestVehicleController | null>;
  readonly ensureClientLobbyDiagnosticProbes: () => Promise<void>;
  readonly sampleDiagnosticFleetTelemetry: () => ReturnType<typeof sampleDiagnosticFleetTelemetry>;

  constructor(context: NetworkDiagnosticsHostPort) {
    this.context = context;
    const fg = new DiagnosticsFleetAndGhostController(context);
    this.fleetAndGhost = fg;
    this.ensureMultiWorldGhostRenderer = () => fg.ensureMultiWorldGhostRenderer();
    this.ensureLobbyRemoteGhostWorld = () => fg.ensureLobbyRemoteGhostWorld();
    this.setLobbyGhostIsolationMode = (enabled = true, interactWithBall = false) =>
      fg.setLobbyGhostIsolationMode(enabled, interactWithBall);
    this.configureLobbyGhostMode = (enabled = true, optionsOrInteractWithBall = {}) =>
      fg.configureLobbyGhostMode(enabled, optionsOrInteractWithBall);
    this.applyCarGhostCollision = (
      carIndex: number,
      interactWithBall = false,
      interactWithCars = false,
      opacity = DEFAULT_GHOST_OPACITY
    ) => fg.applyCarGhostCollision(carIndex, interactWithBall, interactWithCars, opacity);
    this.spawnDiagnosticTestFleet = (options = {}) => fg.spawnDiagnosticTestFleet(options);
    this.ensureClientLobbyDiagnosticProbes = () => fg.ensureClientLobbyDiagnosticProbes();
    this.sampleDiagnosticFleetTelemetry = () => fg.sampleDiagnosticFleetTelemetry();
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

  set diagnosticsFleetController(controller: DiagnosticsTestVehicleController | null) {
    this.fleetAndGhost.diagnosticsFleetController = controller;
  }

  get lobbyGhostMode(): boolean {
    return this.fleetAndGhost.lobbyGhostMode;
  }

  set lobbyGhostMode(enabled: boolean) {
    this.fleetAndGhost.lobbyGhostMode = enabled;
  }

  setMultiWorldGhostVisible(visible: boolean): void {
    this.fleetAndGhost.multiWorldGhostRenderer?.setVisible(Boolean(visible));
  }

  getPhysicsRate(): number {
    return this.context.getInterpolator()?.physicsRate ?? this.physicsRate ?? 120;
  }

  setPhysicsRate(rate: number, options: PhysicsRateOptions = {}): number {
    const interpolator = this.context.getInterpolator();
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
    this.context.getNetworkChannel()?.forceDropNextInput?.(count ?? 5);
  }

  dumpNextNetworkPacket(): Promise<unknown> {
    const reconciler = this.context.getNetworkReconciler();
    if (reconciler?.controlMessenger) {
      console.log(
        '%c[Network Packet Dump]%c Waiting for next incoming datagram...',
        'background:#1f6feb;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        'color:#58a6ff'
      );
      return reconciler.controlMessenger.triggerDumpNextPacket();
    }
    console.warn('[Network Packet Dump] No active network prediction reconciler.');
    return Promise.resolve(null);
  }

  dumpLatestNetworkPacket(packet: Uint8Array | ArrayBuffer | null = null): unknown {
    const reconciler = this.context.getNetworkReconciler();
    if (reconciler?.dumpPacket) return reconciler.dumpPacket(packet);
    console.warn('[Network Packet Dump] No active network prediction reconciler.');
    return null;
  }

  adjustNetworkLatency(deltaLatencyMs: number): number {
    const channel = this.context.getNetworkChannel();
    const reconciler = this.context.getNetworkReconciler();
    const storeExtra = networkDiagnosticsStore?.getSnapshot?.()?.metrics?.extraLatencyMs;
    const newLatency = computeAdjustedExtraLatencyMs(
      channel?.extraLatencyMs,
      storeExtra,
      deltaLatencyMs
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
    const arena = this.context.getArena();
    const physics = this.context.getPhysics();
    const authoritativeServer = this.context.getAuthoritativeServer();
    const reconciler = this.context.getNetworkReconciler();

    await arena?.vehicleRegistry.ensureOpponent();
    if (arena?.cars?.[1]) arena.cars[1].visible = true;
    if (physics && physics.numCars < 2) physics.addCar(1, 'default');
    if (authoritativeServer) authoritativeServer.ensureCar(1, 1);
    if (authoritativeServer && reconciler) {
      const snapshot = authoritativeServer.sim.saveCompactState();
      const serverTick = Math.floor(authoritativeServer.sim.getHeaderView().tickCount);
      reconciler.syncTimeline(snapshot, serverTick);
    }
    this.context.getInterpolator()?.sync?.();
  }

  async enableDeterminismHarness(showHUD = true): Promise<DeterminismHarness | null> {
    const physics = this.context.getPhysics();
    if (!physics) return null;
    if (!this.determinismHarness) {
      this.determinismHarness = new DeterminismHarness(physics);
      await this.determinismHarness.init();
    }
    this.context.notifyDeterminismHarnessReady(this.determinismHarness, showHUD);
    return this.determinismHarness;
  }

  despawnDiagnosticTestFleet(): void {
    this.diagnosticObservationTarget = 0;
    this.fleetAndGhost.despawnDiagnosticTestFleet();
  }

  async toggleDiagnosticTestFleet(
    forceEnabled: boolean | null = null,
    anchorMode: string | null = null
  ): Promise<DiagnosticsTestVehicleController | null> {
    const nextEnabled =
      forceEnabled !== null
        ? Boolean(forceEnabled)
        : !Boolean(this.diagnosticsFleetController?.enabled);
    if (nextEnabled) return this.spawnDiagnosticTestFleet({ anchorMode });
    const channel = this.context.getNetworkChannel();
    const authoritativeServer = this.context.getAuthoritativeServer();
    const arena = this.context.getArena();
    if (channel && !authoritativeServer && arena?.isLobbyMode) {
      channel.sendDiagnosticFleetToggle?.(false, null);
    }
    this.despawnDiagnosticTestFleet();
    return null;
  }

  setDiagnosticObservationTarget(targetCarIndex = 0): number {
    const clampedIndex = Math.max(0, Math.min(7, Math.floor(Number(targetCarIndex) || 0)));
    this.diagnosticObservationTarget = clampedIndex;
    const camera = this.context.getCamera();
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
}
