/**
 * src/physics/DeterminismHarness.js
 * Dual-Arena Side-by-Side Determinism Verification Harness.
 * 
 * Runs two independent RocketSim physics engines simultaneously:
 * - Arena A (Ground Truth): Standard 120Hz continuous forward stepping.
 * - Arena B (Reconciliation): Applies identical inputs, but continuously triggers periodic
 *   or manual rollbacks (10-60 ticks) and resimulates via stepSilent() to catch up to present.
 * 
 * Compares Float-by-Float / Vector positions & velocities every frame to guarantee 100% bit-exact determinism.
 */

import { RocketSimPhysicsEngine } from './RocketSimPhysicsEngine.js';

export class DeterminismHarness {
  /**
   * @param {RocketSimPhysicsEngine} primarySim Arena A (Ground Truth)
   * @param {object} [options]
   */
  constructor(primarySim, options = {}) {
    this.simA = primarySim;
    this.simB = null;
    this.options = options;

    this.active = false;
    this.periodicRollback = true;
    this.rollbackInterval = 30; // Every 30 ticks (4 times per second at 120Hz)
    this.rollbackDepth = 15;    // Roll back 15 ticks (125ms)
    this.totalRollbacks = 0;
    this.historyCapacity = 2048;
    this.historyMask = this.historyCapacity - 1;

    // Ring buffer storing inputs: index -> { tick: number, controls: { [carIdx]: controls } }
    this.controlsHistory = new Array(this.historyCapacity);
    this.lastKnownControls = new Map();
    this.lastResetTick = 0;

    // Running verification metrics
    this.metrics = {
      tickA: 0,
      tickB: 0,
      totalRollbacks: 0,
      currentDepth: 0,
      lastRollbackDurationMs: 0,
      carDeltaPos: 0,
      carDeltaVel: 0,
      carDeltaAngVel: 0,
      ballDeltaPos: 0,
      maxDeltaPos: 0,
      maxDeltaVel: 0,
      maxDeltaBall: 0,
      isBitExact: true
    };

    this.onMetricsUpdated = null;
    this._metricsListeners = new Set();
    this._originalMethods = {};
  }

  addMetricsListener(fn) {
    if (typeof fn === 'function') {
      this._metricsListeners.add(fn);
      return () => this._metricsListeners.delete(fn);
    }
    return () => {};
  }

  notifyMetricsUpdated() {
    if (this.onMetricsUpdated) {
      try {
        this.onMetricsUpdated(this.metrics);
      } catch (err) {
        console.error('[DeterminismHarness] Error in onMetricsUpdated callback:', err);
      }
    }
    for (const listener of this._metricsListeners) {
      try {
        listener(this.metrics);
      } catch (err) {
        console.error('[DeterminismHarness] Error in metrics listener:', err);
      }
    }
  }

  /**
   * Initialize Arena B with fresh WASM module instance and mirror Arena A's car configuration
   */
  async init() {
    this.simB = new RocketSimPhysicsEngine();
    await this.simB.init({ freshInstance: true, isolated: true });

    // Sync cars with simA
    const numCarsA = this.simA.numCars;
    for (let i = 0; i < numCarsA; i++) {
      this.simB.addCar(0, 0);
    }

    // Bug 1 Fix: Synchronize unlimited boost setting from Arena A to Arena B
    this.simB.setUnlimitedBoost(this.simA.isUnlimitedBoost);

    // Clone initial state from A to B
    const stateA = this.simA.saveState();
    this.simB.restoreState(stateA);

    // Prime all snapshot slots in B
    for (let s = 0; s < 256; s++) {
      this.simB.saveStateSlot(s);
    }

    // Non-invasive method interception on simA
    this._interceptSimA();

    this.active = true;
    return this;
  }

  _interceptSimA() {
    // Intercept setControls
    this._originalMethods.setControls = this.simA.setControls.bind(this.simA);
    this.simA.setControls = (carIndex, controls) => {
      this._originalMethods.setControls(carIndex, controls);
      this.recordControls(carIndex, controls);
    };

    // Intercept step: Bug 5 Fix - Step step-by-step synchronously so Arena A and Arena B never desynchronize timestamps
    this._originalMethods.step = this.simA.step.bind(this.simA);
    this.simA.step = (ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        this._originalMethods.step(1);
        this.onPhysicsTickOneStep();
      }
      this.compareStates();
    };

    // Intercept setUnlimitedBoost: Bug 1 Fix - Keep boost options synchronized
    this._originalMethods.setUnlimitedBoost = this.simA.setUnlimitedBoost.bind(this.simA);
    this.simA.setUnlimitedBoost = (unlimited) => {
      this._originalMethods.setUnlimitedBoost(unlimited);
      if (this.simB) {
        this.simB.setUnlimitedBoost(unlimited);
      }
    };

    // Intercept resetKickoff: Bug 2 Fix - Synchronize kickoff resets and prevent rewinding into pre-kickoff state
    this._originalMethods.resetKickoff = this.simA.resetKickoff.bind(this.simA);
    this.simA.resetKickoff = (seed = -1) => {
      this._originalMethods.resetKickoff(seed);
      this.syncResetKickoff(seed);
    };

    // Intercept controlBall: Bug 2 Fix - Synchronize ball control resets
    this._originalMethods.controlBall = this.simA.controlBall.bind(this.simA);
    this.simA.controlBall = (carIndex, modeIndex) => {
      const res = this._originalMethods.controlBall(carIndex, modeIndex);
      this.syncControlBall(carIndex, modeIndex);
      return res;
    };

    // Intercept addCar
    this._originalMethods.addCar = this.simA.addCar.bind(this.simA);
    this.simA.addCar = (team, hitboxType) => {
      const carIdx = this._originalMethods.addCar(team, hitboxType);
      if (this.simB) {
        this.simB.addCar(team, hitboxType);
      }
      return carIdx;
    };

    if (typeof this.simA.setCarState === 'function') {
      this._originalMethods.setCarState = this.simA.setCarState.bind(this.simA);
      this.simA.setCarState = (carIndex, stateObj) => {
        const res = this._originalMethods.setCarState(carIndex, stateObj);
        if (this.simB && typeof this.simB.setCarState === 'function') {
          this.simB.setCarState(carIndex, stateObj);
          const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
          this.lastResetTick = currentTick;
          for (let s = 0; s < 256; s++) {
            this.simB.saveStateSlot(s);
          }
        }
        return res;
      };
    }

    if (typeof this.simA.setCarLinearFactorAndGravity === 'function') {
      this._originalMethods.setCarLinearFactorAndGravity = this.simA.setCarLinearFactorAndGravity.bind(this.simA);
      this.simA.setCarLinearFactorAndGravity = (carIndex, fx, fy, fz, gravityScale) => {
        const res = this._originalMethods.setCarLinearFactorAndGravity(carIndex, fx, fy, fz, gravityScale);
        if (this.simB && typeof this.simB.setCarLinearFactorAndGravity === 'function') {
          this.simB.setCarLinearFactorAndGravity(carIndex, fx, fy, fz, gravityScale);
        }
        return res;
      };
    }

    if (typeof this.simA.setCarCollisionMask === 'function') {
      this._originalMethods.setCarCollisionMask = this.simA.setCarCollisionMask.bind(this.simA);
      this.simA.setCarCollisionMask = (carIndex, interactWithBall, interactWithCars) => {
        const res = this._originalMethods.setCarCollisionMask(carIndex, interactWithBall, interactWithCars);
        if (this.simB && typeof this.simB.setCarCollisionMask === 'function') {
          this.simB.setCarCollisionMask(carIndex, interactWithBall, interactWithCars);
        }
        return res;
      };
    }
  }

  setRollbackDepth(depth) {
    this.rollbackDepth = Math.max(1, Math.min(240, Math.floor(Number(depth) || 15)));
  }

  setRollbackInterval(interval) {
    this.rollbackInterval = Math.max(1, Math.min(600, Math.floor(Number(interval) || 30)));
  }

  /**
   * Called right before physics ticks are advanced
   * @param {number} carIndex
   * @param {object} controls
   */
  recordControls(carIndex, controls) {
    if (!this.active) return;
    this.lastKnownControls.set(carIndex, { ...controls });

    const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
    const slot = currentTick & this.historyMask;
    if (!this.controlsHistory[slot] || this.controlsHistory[slot].tick !== currentTick) {
      this.controlsHistory[slot] = { tick: currentTick, controls: {} };
    }
    this.controlsHistory[slot].controls[carIndex] = { ...controls };
  }

  /**
   * Ensure that the controls entry for a given tick is properly populated with continuous inputs (Bug 3 & 4 Fix)
   * @param {number} tick
   * @returns {object} Map of carIndex -> controls
   * @private
   */
  _ensureTickControls(tick) {
    const slot = tick & this.historyMask;
    if (!this.controlsHistory[slot] || this.controlsHistory[slot].tick !== tick) {
      const controlsMap = {};
      for (const [cIdx, ctrl] of this.lastKnownControls.entries()) {
        controlsMap[cIdx] = { ...ctrl };
      }
      this.controlsHistory[slot] = { tick, controls: controlsMap };
    }
    return this.controlsHistory[slot].controls;
  }

  /**
   * Advance Arena B synchronously with Arena A for exactly one step (Bug 5 Fix)
   */
  onPhysicsTickOneStep() {
    if (!this.active || !this.simB) return;

    const preTick = Math.floor(this.simB.getHeaderView().tickCount);
    const controlsMap = this._ensureTickControls(preTick);

    // Apply controls to Arena B
    for (const [carIdxStr, ctrl] of Object.entries(controlsMap)) {
      this.simB.setControls(Number(carIdxStr), ctrl);
    }

    // Save state in B before advancing
    this.simB.saveStateSlot(preTick % 256);

    // Step B forward by 1
    this.simB.step(1);

    const postTick = preTick + 1;
    // Periodic rollback trigger
    if (this.periodicRollback && postTick > this.rollbackDepth && postTick % this.rollbackInterval === 0) {
      this.executeRollback(this.rollbackDepth);
    }
  }

  /**
   * Trigger an explicit rollback on Arena B and resimulate back to present
   * @param {number} [depth=15] Number of ticks to rewind
   */
  executeRollback(depth = 15) {
    if (!this.active || !this.simB) return;

    const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
    // Bug 2 Fix: Never roll back across a reset boundary
    const minAllowedTick = this.lastResetTick;
    const targetRollbackTick = Math.max(minAllowedTick, currentTick - Math.min(depth, 250));
    const actualDepth = currentTick - targetRollbackTick;
    if (actualDepth <= 0) return;

    const rollbackTick = targetRollbackTick;
    const startTime = performance.now();

    // 1. Roll back Arena B to snapshot slot
    this.simB.restoreStateSlot(rollbackTick % 256);

    // 2. Resimulate forward silently with historical inputs (Bug 4 Fix: verify slot.tick matches t)
    for (let t = rollbackTick; t < currentTick; t++) {
      const slot = t & this.historyMask;
      const entry = this.controlsHistory[slot];
      const controlsMap = (entry && entry.tick === t) ? entry.controls : {};
      for (const [carIdxStr, ctrl] of Object.entries(controlsMap)) {
        this.simB.setControls(Number(carIdxStr), ctrl);
      }
      this.simB.stepSilent(1);
    }

    const duration = performance.now() - startTime;
    this.totalRollbacks++;
    this.metrics.totalRollbacks = this.totalRollbacks;
    this.metrics.currentDepth = actualDepth;
    this.metrics.lastRollbackDurationMs = duration;
    this.compareStates();
  }

  /**
   * Public API to explicitly trigger a rollback
   * @param {number} [depth] Number of ticks to rewind
   */
  triggerManualRollback(depth = this.rollbackDepth) {
    this.executeRollback(depth);
    this.compareStates();
  }

  /**
   * Synchronize kickoff or ball resets from Arena A to Arena B (Bug 2 Fix)
   * @param {number} [seed=-1]
   */
  syncResetKickoff(seed = -1) {
    if (!this.active || !this.simB) return;
    const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
    this.lastResetTick = currentTick;

    this.simB.resetKickoff(seed);
    const stateA = this.simA.saveState();
    this.simB.restoreState(stateA);

    // Overwrite all snapshot slots with post-reset state so rollbacks cannot travel into pre-reset state
    for (let s = 0; s < 256; s++) {
      this.simB.saveStateSlot(s);
    }

    // Invalidate stale historical controls prior to this reset
    for (let i = 0; i < this.historyCapacity; i++) {
      if (this.controlsHistory[i] && this.controlsHistory[i].tick < currentTick) {
        this.controlsHistory[i] = null;
      }
    }

    this.compareStates();
  }

  /**
   * Synchronize ball control mode from Arena A to Arena B (Bug 2 Fix)
   * @param {number} carIndex
   * @param {number} modeIndex
   */
  syncControlBall(carIndex, modeIndex) {
    if (!this.active || !this.simB) return;
    const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
    this.lastResetTick = currentTick;

    this.simB.controlBall(carIndex, modeIndex);
    const stateA = this.simA.saveState();
    this.simB.restoreState(stateA);

    // Overwrite all snapshot slots with post-reset state
    for (let s = 0; s < 256; s++) {
      this.simB.saveStateSlot(s);
    }

    for (let i = 0; i < this.historyCapacity; i++) {
      if (this.controlsHistory[i] && this.controlsHistory[i].tick < currentTick) {
        this.controlsHistory[i] = null;
      }
    }

    this.compareStates();
  }

  /**
   * Compare Arena A and Arena B states across all active vehicles and ball
   */
  compareStates() {
    if (!this.active || !this.simB) return;

    const tickA = Math.floor(this.simA.getHeaderView().tickCount);
    const tickB = Math.floor(this.simB.getHeaderView().tickCount);

    this.metrics.tickA = tickA;
    this.metrics.tickB = tickB;

    let carDeltaPos = 0;
    let carDeltaVel = 0;
    let carDeltaAngVel = 0;
    let ballDeltaPos = 0;

    const count = Math.min(this.simA.numCars || 0, this.simB.numCars || 0);
    for (let c = 0; c < count; c++) {
      const carA = this.simA.getCarStateView(c);
      const carB = this.simB.getCarStateView(c);

      const dPos = Math.hypot(carA.posX - carB.posX, carA.posY - carB.posY, carA.posZ - carB.posZ);
      const dVel = Math.hypot(carA.velX - carB.velX, carA.velY - carB.velY, carA.velZ - carB.velZ);
      const dAng = Math.hypot(carA.angVelX - carB.angVelX, carA.angVelY - carB.angVelY, carA.angVelZ - carB.angVelZ);
      if (dPos > carDeltaPos) carDeltaPos = dPos;
      if (dVel > carDeltaVel) carDeltaVel = dVel;
      if (dAng > carDeltaAngVel) carDeltaAngVel = dAng;
    }

    // Compare Ball
    const ballA = this.simA.getBallStateView();
    const ballB = this.simB.getBallStateView();
    ballDeltaPos = Math.hypot(ballA.posX - ballB.posX, ballA.posY - ballB.posY, ballA.posZ - ballB.posZ);

    this.metrics.carDeltaPos = carDeltaPos;
    this.metrics.carDeltaVel = carDeltaVel;
    this.metrics.carDeltaAngVel = carDeltaAngVel;
    this.metrics.ballDeltaPos = ballDeltaPos;

    if (carDeltaPos > this.metrics.maxDeltaPos) this.metrics.maxDeltaPos = carDeltaPos;
    if (carDeltaVel > this.metrics.maxDeltaVel) this.metrics.maxDeltaVel = carDeltaVel;
    if (ballDeltaPos > this.metrics.maxDeltaBall) this.metrics.maxDeltaBall = ballDeltaPos;

    this.metrics.isBitExact = (carDeltaPos === 0 && ballDeltaPos === 0);

    this.notifyMetricsUpdated();
  }

  /**
   * Reset stats counters
   */
  resetStats() {
    this.totalRollbacks = 0;
    this.metrics.totalRollbacks = 0;
    this.metrics.maxDeltaPos = 0;
    this.metrics.maxDeltaVel = 0;
    this.metrics.maxDeltaBall = 0;
    this.metrics.isBitExact = true;
    this.notifyMetricsUpdated();
  }

  resetMaxDeltas() {
    this.metrics.maxDeltaPos = 0;
    this.metrics.maxDeltaVel = 0;
    this.metrics.maxDeltaBall = 0;
    this.metrics.isBitExact = (this.metrics.carDeltaPos === 0 && this.metrics.ballDeltaPos === 0);
    this.notifyMetricsUpdated();
  }

  destroy() {
    this.active = false;
    // Restore original methods on simA
    for (const [key, origFn] of Object.entries(this._originalMethods)) {
      this.simA[key] = origFn;
    }
    this._originalMethods = {};

    if (this.simB) {
      this.simB.destroy();
      this.simB = null;
    }
    this.controlsHistory = [];
    this.lastKnownControls.clear();
  }
}

export default DeterminismHarness;
