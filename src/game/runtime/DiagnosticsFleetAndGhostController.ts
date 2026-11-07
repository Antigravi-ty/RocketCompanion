import {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET,
} from '../../network/diagnostics/DiagnosticsTestVehicles.ts';
import {
  ZERO_G_ANCHOR_MODES,
  configureZeroGVehiclePhysics,
  setLobbyGhostCarIsolation,
  sampleDiagnosticFleetTelemetry,
  type DiagnosticVehicleSpec,
} from '../../network/diagnostics/ZeroGDiagnosticLab.ts';
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
import type { DeterminismHarness } from '../../physics/DeterminismHarness.ts';
import type { NetworkSessionChannelLike } from './onlineLobbyTransitionPipeline.ts';

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

export interface LobbyGhostModeConfigResult {
  enabled?: boolean;
  lobbyModeActive?: boolean;
  hostCarIndex?: number;
  broadcastHostOnly?: boolean;
  mode: string;
  ghostOpacity: number;
  cars: CarCollisionMaskEntry[];
}

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
 * Sub-controller owning Zero-G diagnostic vehicle fleet and multi-world/lobby ghost car isolation.
 */
export class DiagnosticsFleetAndGhostController {
  private readonly host: NetworkDiagnosticsHostPort;
  public readonly lobbyGhostCoordinator: LobbyGhostCarCoordinator;
  public multiWorldGhostRenderer: MultiWorldGhostRenderer | null = null;
  public diagnosticsFleetController: DiagnosticsTestVehicleController | null = null;
  public lobbyGhostMode = false;

  constructor(host: NetworkDiagnosticsHostPort) {
    this.host = host;
    this.lobbyGhostCoordinator = new LobbyGhostCarCoordinator();
  }

  public ensureMultiWorldGhostRenderer(): MultiWorldGhostRenderer | null {
    const arena = this.host.getArena();
    if (!this.multiWorldGhostRenderer && arena) {
      this.multiWorldGhostRenderer = new MultiWorldGhostRenderer(arena);
    }
    return this.multiWorldGhostRenderer;
  }

  public ensureLobbyRemoteGhostWorld(): MultiWorldGhostRenderer | null {
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

  public setLobbyGhostIsolationMode(enabled = true, interactWithBall = false): boolean {
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

  public configureLobbyGhostMode(
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
      arena?.vehicleRegistry.clearAllGhostOpacities();
    } else if (arena && Array.isArray(configResult?.cars)) {
      for (const entry of configResult.cars) {
        arena.vehicleRegistry.setCarGhostOpacity(entry.carIndex, entry.isGhost, entry.opacity);
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

  public applyCarGhostCollision(
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
    arena?.vehicleRegistry.setCarGhostOpacity(carIndex, entry.isGhost, entry.opacity);
    return entry;
  }

  public async spawnDiagnosticTestFleet(
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
    this.host.getInterpolator()?.sync?.();
    return this.diagnosticsFleetController;
  }

  public despawnDiagnosticTestFleet(): void {
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
    for (const spec of DEFAULT_DIAGNOSTIC_FLEET) {
      if (arena?.cars?.[spec.carIndex]) arena.cars[spec.carIndex].visible = false;
      arena?.resetCarBoosts?.(spec.carIndex);
      arena?.carDemolitions?.[spec.carIndex]?.stop?.();
    }
  }

  public async ensureClientLobbyDiagnosticProbes(): Promise<void> {
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

  public sampleDiagnosticFleetTelemetry(): ReturnType<typeof sampleDiagnosticFleetTelemetry> {
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
