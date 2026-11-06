/**
 * src/network/server/LobbyGhostCarCoordinator.ts
 * Pure Worker-safe Coordinator for Lobby Ghost Car Broadphase Filtering
 * and Client Dual-World Warmup Snapshot Synthesis.
 */

import {
  SIM_OFFSETS,
  BALL_STATE_STRIDE,
  CAR_STATE_STRIDE,
  MAX_CARS,
} from '../../physics/RocketSimConstants.ts';

export const DEFAULT_GHOST_OPACITY = 0.7;

export const LOBBY_COLLISION_MODES = Object.freeze({
  SOLID_COMPETITIVE: 'solid_competitive',
  GHOST_PASSTHROUGH: 'ghost_passthrough',
  HOST_ONLY_BALL: 'host_only_ball',
  DUAL_WORLD_ISOLATED: 'dual_world_isolated',
});

export interface CarCollisionMaskEntry {
  carIndex: number;
  interactWithBall: boolean;
  interactWithCars: boolean;
  isGhost: boolean;
  opacity: number;
}

export interface LobbyGhostCoordinatorOptions {
  hostCarIndex?: number;
  ghostOpacity?: number;
  mode?: string;
  lobbyModeActive?: boolean;
  broadcastHostOnly?: boolean;
}

export interface LobbyModeConfig extends LobbyGhostCoordinatorOptions {
  enabled?: boolean;
  interactWithBall?: boolean;
  interactWithCars?: boolean;
  hostInteractsWithBall?: boolean;
  localCarIndex?: number;
}

export type LobbyGhostConfigOptions = LobbyModeConfig;

export interface MergeDualWorldOptions {
  localCarIndex?: number;
  localSourceCarIndex?: number;
  hostCarIndex?: number;
  primaryBallSource?: 'host' | 'local';
  useLocalBall?: boolean;
  hostCarIndices?: number[];
}

export class LobbyGhostCarCoordinator {
  hostCarIndex: number;
  ghostOpacity: number;
  mode: string;
  lobbyModeActive: boolean;
  broadcastHostOnly: boolean;
  carMaskRegistry = new Map<number, CarCollisionMaskEntry>();

  constructor(options: LobbyGhostCoordinatorOptions = {}) {
    this.hostCarIndex = options.hostCarIndex ?? 0;
    this.ghostOpacity =
      typeof options.ghostOpacity === 'number'
        ? Math.max(0.1, Math.min(1.0, options.ghostOpacity))
        : DEFAULT_GHOST_OPACITY;
    this.mode = options.mode || LOBBY_COLLISION_MODES.GHOST_PASSTHROUGH;
    this.lobbyModeActive = Boolean(options.lobbyModeActive);
    this.broadcastHostOnly = Boolean(options.broadcastHostOnly);
  }

  applyCarCollisionMask(
    sim: any,
    carIndex: number,
    interactWithBall = true,
    interactWithCars = true,
    opacity?: number
  ): CarCollisionMaskEntry {
    const ballFlag = Boolean(interactWithBall);
    const carFlag = Boolean(interactWithCars);
    const isGhost = !ballFlag || !carFlag;
    const resolvedOpacity =
      typeof opacity === 'number'
        ? Math.max(0.1, Math.min(1.0, opacity))
        : isGhost
          ? this.ghostOpacity
          : 1.0;

    const entry: CarCollisionMaskEntry = {
      carIndex,
      interactWithBall: ballFlag,
      interactWithCars: carFlag,
      isGhost,
      opacity: resolvedOpacity,
    };
    this.carMaskRegistry.set(carIndex, entry);

    if (sim && typeof sim.setCarCollisionMask === 'function') {
      sim.setCarCollisionMask(carIndex, ballFlag, carFlag);
    }
    return entry;
  }

  configureLobbyMode(
    sim: any,
    activeCarIndices: Iterable<number> | null | undefined,
    config: LobbyModeConfig = {}
  ) {
    if (config.enabled !== undefined) {
      this.lobbyModeActive = Boolean(config.enabled);
    } else {
      this.lobbyModeActive = true;
    }
    if (config.mode) {
      this.mode = config.mode;
    }
    if (typeof config.hostCarIndex === 'number') {
      this.hostCarIndex = config.hostCarIndex;
    }
    if (typeof config.ghostOpacity === 'number') {
      this.ghostOpacity = Math.max(0.1, Math.min(1.0, config.ghostOpacity));
    }
    if (config.broadcastHostOnly !== undefined) {
      this.broadcastHostOnly = Boolean(config.broadcastHostOnly);
    }

    if (!this.lobbyModeActive) {
      return this.restoreSolidCollisions(sim, activeCarIndices);
    }

    const indices = activeCarIndices ? Array.from(activeCarIndices) : [];
    for (let i = 0; i < indices.length; i++) {
      const cIdx = indices[i];
      if (this.mode === LOBBY_COLLISION_MODES.HOST_ONLY_BALL) {
        const isHostCar = cIdx === this.hostCarIndex;
        this.applyCarCollisionMask(sim, cIdx, isHostCar, false);
      } else if (this.mode === LOBBY_COLLISION_MODES.GHOST_PASSTHROUGH) {
        const interactBall =
          config.interactWithBall !== undefined
            ? Boolean(config.interactWithBall)
            : cIdx === this.hostCarIndex && config.hostInteractsWithBall !== false;
        const interactCars = Boolean(config.interactWithCars);
        this.applyCarCollisionMask(sim, cIdx, interactBall, interactCars);
      } else if (this.mode === LOBBY_COLLISION_MODES.DUAL_WORLD_ISOLATED) {
        const isLocalWarmupCar =
          typeof config.localCarIndex === 'number'
            ? cIdx === config.localCarIndex
            : cIdx === this.hostCarIndex;
        this.applyCarCollisionMask(sim, cIdx, isLocalWarmupCar, false);
      } else {
        this.applyCarCollisionMask(sim, cIdx, true, true);
      }
    }

    return this.getSnapshotConfig();
  }

  restoreSolidCollisions(sim: any, activeCarIndices?: Iterable<number> | null) {
    this.lobbyModeActive = false;
    this.broadcastHostOnly = false;
    const indices = new Set<number>([
      ...(activeCarIndices ? Array.from(activeCarIndices) : []),
      ...this.carMaskRegistry.keys(),
    ]);
    for (const cIdx of indices) {
      this.applyCarCollisionMask(sim, cIdx, true, true, 1.0);
    }
    return this.getSnapshotConfig();
  }

  shouldMaskRemoteLobbyInput(carIndex: number): boolean {
    if (!this.lobbyModeActive || !this.broadcastHostOnly) return false;
    return carIndex !== this.hostCarIndex;
  }

  getCarGhostState(carIndex: number): CarCollisionMaskEntry {
    return (
      this.carMaskRegistry.get(carIndex) || {
        carIndex,
        interactWithBall: true,
        interactWithCars: true,
        isGhost: false,
        opacity: 1.0,
      }
    );
  }

  mergeDualWorldSnapshots(
    localWarmupSnapshot: Float32Array | null | undefined,
    remoteAuthoritativeSnapshot: Float32Array | null | undefined,
    options: MergeDualWorldOptions = {}
  ): Float32Array {
    if (!localWarmupSnapshot && !remoteAuthoritativeSnapshot) {
      return new Float32Array(448);
    }
    if (!remoteAuthoritativeSnapshot) {
      return new Float32Array(localWarmupSnapshot!);
    }
    if (!localWarmupSnapshot) {
      return new Float32Array(remoteAuthoritativeSnapshot);
    }

    const localCarIndex = options.localCarIndex ?? 1;
    const localSourceCarIndex = options.localSourceCarIndex ?? 0;
    const hostCarIndex = options.hostCarIndex ?? this.hostCarIndex ?? 0;
    const primaryBallSource = options.useLocalBall ? 'local' : options.primaryBallSource || 'host';

    const merged = new Float32Array(remoteAuthoritativeSnapshot);

    const requiredCars = Math.max(
      Math.round(merged[SIM_OFFSETS.NUM_CARS] || 1),
      hostCarIndex + 1,
      localCarIndex + 1
    );
    merged[SIM_OFFSETS.NUM_CARS] = Math.min(MAX_CARS, requiredCars);

    if (primaryBallSource === 'local') {
      merged.set(
        localWarmupSnapshot.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE),
        SIM_OFFSETS.BALL
      );
    }

    const srcCarStart = SIM_OFFSETS.CARS + localSourceCarIndex * CAR_STATE_STRIDE;
    const dstCarStart = SIM_OFFSETS.CARS + localCarIndex * CAR_STATE_STRIDE;
    if (
      srcCarStart + CAR_STATE_STRIDE <= localWarmupSnapshot.length &&
      dstCarStart + CAR_STATE_STRIDE <= merged.length
    ) {
      merged.set(
        localWarmupSnapshot.subarray(srcCarStart, srcCarStart + CAR_STATE_STRIDE),
        dstCarStart
      );
    }

    if (Array.isArray(options.hostCarIndices)) {
      for (const hIdx of options.hostCarIndices) {
        const hStart = SIM_OFFSETS.CARS + hIdx * CAR_STATE_STRIDE;
        if (hStart + CAR_STATE_STRIDE <= remoteAuthoritativeSnapshot.length) {
          merged.set(
            remoteAuthoritativeSnapshot.subarray(hStart, hStart + CAR_STATE_STRIDE),
            hStart
          );
        }
      }
    }

    return merged;
  }

  getSnapshotConfig() {
    const cars: CarCollisionMaskEntry[] = [];
    for (const entry of this.carMaskRegistry.values()) {
      cars.push({ ...entry });
    }
    return {
      lobbyModeActive: this.lobbyModeActive,
      mode: this.mode,
      hostCarIndex: this.hostCarIndex,
      ghostOpacity: this.ghostOpacity,
      broadcastHostOnly: this.broadcastHostOnly,
      cars,
    };
  }
}

export default LobbyGhostCarCoordinator;
