/**
 * src/network/LobbyGhostCarCoordinator.js
 * Pure Worker-safe Coordinator for Lobby Ghost Car Broadphase Filtering
 * and Client Dual-World Warmup Snapshot Synthesis.
 *
 * Strictly zero DOM, Three.js, or UI-Store dependencies so it can execute
 * inside both Authoritative Web Workers and Client Runtime contexts.
 */

import {
  SIM_OFFSETS,
  BALL_STATE_STRIDE,
  CAR_STATE_STRIDE,
  MAX_CARS
} from '../../physics/RocketSimConstants.js';

export const DEFAULT_GHOST_OPACITY = 0.70;

export const LOBBY_COLLISION_MODES = Object.freeze({
  SOLID_COMPETITIVE: 'solid_competitive',
  GHOST_PASSTHROUGH: 'ghost_passthrough',
  HOST_ONLY_BALL: 'host_only_ball',
  DUAL_WORLD_ISOLATED: 'dual_world_isolated'
});

export const LOBBY_GHOST_MODES = LOBBY_COLLISION_MODES;

export class LobbyGhostCarCoordinator {
  /**
   * @param {object} [options={}]
   * @param {number} [options.hostCarIndex=0]
   * @param {number} [options.ghostOpacity=0.70]
   * @param {string} [options.mode='ghost_passthrough']
   * @param {boolean} [options.broadcastHostOnly=false]
   */
  constructor(options = {}) {
    this.hostCarIndex = options.hostCarIndex ?? 0;
    this.ghostOpacity = typeof options.ghostOpacity === 'number'
      ? Math.max(0.1, Math.min(1.0, options.ghostOpacity))
      : DEFAULT_GHOST_OPACITY;
    this.mode = options.mode || LOBBY_COLLISION_MODES.GHOST_PASSTHROUGH;
    this.lobbyModeActive = Boolean(options.lobbyModeActive);
    this.broadcastHostOnly = Boolean(options.broadcastHostOnly);

    /** @type {Map<number, { interactWithBall: boolean, interactWithCars: boolean, isGhost: boolean, opacity: number }>} */
    this.carMaskRegistry = new Map();
  }

  /**
   * Applies a specific car's collision mask to the underlying C++ WASM physics engine.
   * @param {object} sim - RocketSimPhysicsEngine instance
   * @param {number} carIndex
   * @param {boolean} [interactWithBall=true]
   * @param {boolean} [interactWithCars=true]
   * @param {number} [opacity]
   * @returns {{ carIndex: number, interactWithBall: boolean, interactWithCars: boolean, isGhost: boolean, opacity: number }}
   */
  applyCarCollisionMask(sim, carIndex, interactWithBall = true, interactWithCars = true, opacity = undefined) {
    const ballFlag = Boolean(interactWithBall);
    const carFlag = Boolean(interactWithCars);
    const isGhost = !ballFlag || !carFlag;
    const resolvedOpacity = typeof opacity === 'number'
      ? Math.max(0.1, Math.min(1.0, opacity))
      : (isGhost ? this.ghostOpacity : 1.0);

    const entry = {
      carIndex,
      interactWithBall: ballFlag,
      interactWithCars: carFlag,
      isGhost,
      opacity: resolvedOpacity
    };
    this.carMaskRegistry.set(carIndex, entry);

    if (sim && typeof sim.setCarCollisionMask === 'function') {
      sim.setCarCollisionMask(carIndex, ballFlag, carFlag);
    }
    return entry;
  }

  /**
   * Configures Lobby Ghost Car mode across all registered cars in the simulation.
   * @param {object} sim - RocketSimPhysicsEngine instance
   * @param {Iterable<number>} activeCarIndices
   * @param {object} [config={}]
   */
  configureLobbyMode(sim, activeCarIndices, config = {}) {
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
        const interactBall = config.interactWithBall !== undefined
          ? Boolean(config.interactWithBall)
          : (cIdx === this.hostCarIndex && (config.hostInteractsWithBall !== false));
        const interactCars = Boolean(config.interactWithCars);
        this.applyCarCollisionMask(sim, cIdx, interactBall, interactCars);
      } else if (this.mode === LOBBY_COLLISION_MODES.DUAL_WORLD_ISOLATED) {
        const isLocalWarmupCar = typeof config.localCarIndex === 'number'
          ? cIdx === config.localCarIndex
          : cIdx === this.hostCarIndex;
        this.applyCarCollisionMask(sim, cIdx, isLocalWarmupCar, false);
      } else {
        this.applyCarCollisionMask(sim, cIdx, true, true);
      }
    }

    return this.getSnapshotConfig();
  }

  /**
   * Restores standard competitive solid collisions (ball = true, cars = true) for all cars.
   * Invoked automatically when transitioning from LOBBY into PREPARE / KICKOFF / PLAYING.
   * @param {object} sim - RocketSimPhysicsEngine instance
   * @param {Iterable<number>} activeCarIndices
   */
  restoreSolidCollisions(sim, activeCarIndices) {
    this.lobbyModeActive = false;
    this.broadcastHostOnly = false;
    const indices = new Set([
      ...(activeCarIndices ? Array.from(activeCarIndices) : []),
      ...this.carMaskRegistry.keys()
    ]);
    for (const cIdx of indices) {
      this.applyCarCollisionMask(sim, cIdx, true, true, 1.0);
    }
    return this.getSnapshotConfig();
  }

  /**
   * Returns whether a given car's input should be masked on the authoritative server
   * during Lobby mode (e.g. when Lobby only broadcasts Host's driving).
   * @param {number} carIndex
   * @returns {boolean}
   */
  shouldMaskRemoteLobbyInput(carIndex) {
    if (!this.lobbyModeActive || !this.broadcastHostOnly) return false;
    return carIndex !== this.hostCarIndex;
  }

  /**
   * Returns current collision & opacity descriptor for a car index.
   * @param {number} carIndex
   */
  getCarGhostState(carIndex) {
    return this.carMaskRegistry.get(carIndex) || {
      carIndex,
      interactWithBall: true,
      interactWithCars: true,
      isGhost: false,
      opacity: 1.0
    };
  }

  /**
   * Synthesizes a combined 448-float compact arena state snapshot for Client Dual-World Lobby Warmup.
   * Places the Client's locally simulated warmup car (and optionally local ball) alongside
   * the Host's authoritative car & ball stream so both render in the same 3D arena
   * without any physics cross-contamination.
   *
   * @param {Float32Array} localWarmupSnapshot - State buffer from client's isolated warmup sim
   * @param {Float32Array} remoteAuthoritativeSnapshot - State buffer from Host broadcast
   * @param {object} [options={}]
   * @param {number} [options.localCarIndex=1] - Car slot driven locally by the client
   * @param {number} [options.localSourceCarIndex=0] - Car slot in localWarmupSnapshot
   * @param {number} [options.hostCarIndex=0] - Host car slot in remoteAuthoritativeSnapshot
   * @param {'host'|'local'} [options.primaryBallSource='host'] - Which ball occupies the primary ball slot
   * @returns {Float32Array} Synthesized snapshot buffer
   */
  mergeDualWorldSnapshots(localWarmupSnapshot, remoteAuthoritativeSnapshot, options = {}) {
    if (!localWarmupSnapshot && !remoteAuthoritativeSnapshot) {
      return new Float32Array(448);
    }
    if (!remoteAuthoritativeSnapshot) {
      return new Float32Array(localWarmupSnapshot);
    }
    if (!localWarmupSnapshot) {
      return new Float32Array(remoteAuthoritativeSnapshot);
    }

    const localCarIndex = options.localCarIndex ?? 1;
    const localSourceCarIndex = options.localSourceCarIndex ?? 0;
    const hostCarIndex = options.hostCarIndex ?? this.hostCarIndex ?? 0;
    const primaryBallSource = options.useLocalBall
      ? 'local'
      : (options.primaryBallSource || 'host');

    const merged = new Float32Array(remoteAuthoritativeSnapshot);

    // Ensure NUM_CARS in header covers both hostCarIndex and localCarIndex
    const requiredCars = Math.max(
      Math.round(merged[SIM_OFFSETS.NUM_CARS] || 1),
      hostCarIndex + 1,
      localCarIndex + 1
    );
    merged[SIM_OFFSETS.NUM_CARS] = Math.min(MAX_CARS, requiredCars);

    // If local ball is selected as primary, copy ball state (floats 4..21) from localWarmupSnapshot
    if (primaryBallSource === 'local') {
      merged.set(
        localWarmupSnapshot.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE),
        SIM_OFFSETS.BALL
      );
    }

    // Copy local player's warmup car state into localCarIndex slot of merged snapshot
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

    // Also overlay any explicitly specified hostCarIndices from remoteAuthoritativeSnapshot
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
    const cars = [];
    for (const entry of this.carMaskRegistry.values()) {
      cars.push({ ...entry });
    }
    return {
      lobbyModeActive: this.lobbyModeActive,
      mode: this.mode,
      hostCarIndex: this.hostCarIndex,
      ghostOpacity: this.ghostOpacity,
      broadcastHostOnly: this.broadcastHostOnly,
      cars
    };
  }
}

export default LobbyGhostCarCoordinator;
