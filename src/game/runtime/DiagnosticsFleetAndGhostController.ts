import {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET,
} from '../../network/diagnostics/DiagnosticsTestVehicles.ts';
import {
  ZERO_G_ANCHOR_MODES,
  configureZeroGVehiclePhysics,
  sampleDiagnosticFleetTelemetry,
  type DiagnosticVehicleSpec,
} from '../../network/diagnostics/ZeroGDiagnosticLab.ts';
import {
  DEFAULT_GHOST_OPACITY,
  type CarCollisionMaskEntry,
  type LobbyGhostCarCoordinator,
} from '../../network/server/LobbyGhostCarCoordinator.ts';
import type { MultiWorldGhostRenderer } from '../modes/MultiWorldGhostRenderer.ts';
import { configureClientLobbyDiagnosticProbes } from '../../network/client/NetworkTelemetryCollector.ts';
import {
  networkDiagnosticsStore,
  getNameTagRuntimeState,
  setNameTagRuntimeState,
  type NameTagCarEntry,
} from '../runtimeUiPort.ts';
import {
  LobbyGhostIsolationController,
  type LobbyGhostModeConfigResult,
  type LobbyGhostModeOptions,
  type NetworkDiagnosticsHostPort,
} from './LobbyGhostIsolationController.ts';

export type { LobbyGhostModeConfigResult, LobbyGhostModeOptions, NetworkDiagnosticsHostPort };

export interface DiagnosticFleetSpawnOptions {
  anchorMode?: string | null;
}

export function mergeDiagnosticProbeNameTagEntries(
  existingEntries: readonly NameTagCarEntry[] | null | undefined
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

export class DiagnosticsFleetAndGhostController {
  private readonly context: NetworkDiagnosticsHostPort;
  public readonly ghostIsolation: LobbyGhostIsolationController;
  public diagnosticsFleetController: DiagnosticsTestVehicleController | null = null;

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

  constructor(context: NetworkDiagnosticsHostPort) {
    this.context = context;
    const gi = new LobbyGhostIsolationController(context);
    this.ghostIsolation = gi;
    this.ensureMultiWorldGhostRenderer = () => gi.ensureMultiWorldGhostRenderer();
    this.ensureLobbyRemoteGhostWorld = () => gi.ensureLobbyRemoteGhostWorld();
    this.setLobbyGhostIsolationMode = (enabled = true, interactWithBall = false) =>
      gi.setLobbyGhostIsolationMode(enabled, interactWithBall);
    this.configureLobbyGhostMode = (enabled = true, optionsOrInteractWithBall = {}) =>
      gi.configureLobbyGhostMode(enabled, optionsOrInteractWithBall);
    this.applyCarGhostCollision = (
      carIndex: number,
      interactWithBall = false,
      interactWithCars = false,
      opacity = DEFAULT_GHOST_OPACITY
    ) => gi.applyCarGhostCollision(carIndex, interactWithBall, interactWithCars, opacity);
  }

  get lobbyGhostCoordinator(): LobbyGhostCarCoordinator {
    return this.ghostIsolation.lobbyGhostCoordinator;
  }

  get multiWorldGhostRenderer(): MultiWorldGhostRenderer | null {
    return this.ghostIsolation.multiWorldGhostRenderer;
  }

  set multiWorldGhostRenderer(renderer: MultiWorldGhostRenderer | null) {
    this.ghostIsolation.multiWorldGhostRenderer = renderer;
  }

  get lobbyGhostMode(): boolean {
    return this.ghostIsolation.lobbyGhostMode;
  }

  set lobbyGhostMode(enabled: boolean) {
    this.ghostIsolation.lobbyGhostMode = enabled;
  }

  public async spawnDiagnosticTestFleet(
    options: DiagnosticFleetSpawnOptions = {}
  ): Promise<DiagnosticsTestVehicleController | null> {
    if (this.context.isMatchPhaseBlockingDiagnosticsFleet()) return null;

    const anchorMode =
      options.anchorMode ||
      this.diagnosticsFleetController?.anchorMode ||
      ZERO_G_ANCHOR_MODES.Z_HOVER;

    const channel = this.context.getNetworkChannel();
    const authoritativeServer = this.context.getAuthoritativeServer();
    const physics = this.context.getPhysics();
    const arena = this.context.getArena();
    const reconciler = this.context.getNetworkReconciler();

    if (channel && !authoritativeServer) {
      channel.sendDiagnosticFleetToggle?.(true, anchorMode);
      return null;
    }

    if (!this.diagnosticsFleetController) {
      this.diagnosticsFleetController = new DiagnosticsTestVehicleController(
        [...DEFAULT_DIAGNOSTIC_FLEET],
        { anchorMode }
      );
    }
    this.diagnosticsFleetController.anchorMode = anchorMode;
    this.diagnosticsFleetController.enabled = true;

    for (const spec of DEFAULT_DIAGNOSTIC_FLEET) {
      if (arena) {
        arena.vehicleRegistry.ensureCar(spec.carIndex, spec.team, 'fennec');
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
    this.context.getInterpolator()?.sync?.();
    return this.diagnosticsFleetController;
  }

  public despawnDiagnosticTestFleet(): void {
    const physics = this.context.getPhysics();
    const authoritativeServer = this.context.getAuthoritativeServer();
    const arena = this.context.getArena();

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
    for (const spec of DEFAULT_DIAGNOSTIC_FLEET) {
      if (arena?.cars?.[spec.carIndex]) arena.cars[spec.carIndex].visible = false;
      arena?.resetCarBoosts?.(spec.carIndex);
      arena?.carDemolitions?.[spec.carIndex]?.stop?.();
    }
  }

  public async ensureClientLobbyDiagnosticProbes(): Promise<void> {
    const physics = this.context.getPhysics();
    const reconciler = this.context.getNetworkReconciler();
    const arena = this.context.getArena();

    if (physics) {
      const alreadySyncedProbes = Boolean(
        reconciler?.isTimelineSynchronized &&
        typeof physics.isCarSlotActive === 'function' &&
        physics.isCarSlotActive(6) &&
        physics.isCarSlotActive(7)
      );
      if (alreadySyncedProbes) {
        configureClientLobbyDiagnosticProbes(physics);
      } else {
        configureZeroGVehiclePhysics(physics, [...DEFAULT_DIAGNOSTIC_FLEET]);
      }
    }

    if (arena?.vehicleRegistry) {
      arena.vehicleRegistry.ensureCar(6, 0, 'fennec');
      arena.vehicleRegistry.ensureCar(7, 1, 'fennec');
      for (const definition of DEFAULT_DIAGNOSTIC_FLEET as readonly (DiagnosticVehicleSpec & {
        colorHex?: string;
      })[]) {
        const carIndex = definition.carIndex;
        const carMesh = arena.cars?.[carIndex];
        if (carMesh) {
          carMesh.visible = true;
          if (definition.colorHex) carMesh.setCustomBodyColor?.(definition.colorHex);
        }
        this.context.ensureFlipResetVisual(carIndex);
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

  public sampleDiagnosticFleetTelemetry(): ReturnType<typeof sampleDiagnosticFleetTelemetry> {
    const physics = this.context.getPhysics();
    if (!physics) return [];
    const authoritativeServer = this.context.getAuthoritativeServer();
    const reconciler = this.context.getNetworkReconciler();
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
