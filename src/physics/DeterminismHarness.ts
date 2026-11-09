/**
 * src/physics/DeterminismHarness.ts
 * Dual-Arena Side-by-Side Determinism Verification Harness.
 *
 * Runs two independent RocketSim physics engines simultaneously:
 * - Arena A (Ground Truth): Standard 120Hz continuous forward stepping.
 * - Arena B (Reconciliation): Applies identical inputs, but continuously triggers periodic
 *   or manual rollbacks (10-60 ticks) and resimulates via stepSilent() to catch up to present.
 *
 * Compares Float-by-Float / Vector positions & velocities every frame to guarantee 100% bit-exact determinism.
 */

import { RocketSimPhysicsEngine } from './RocketSimPhysicsEngine.ts';
import type { CarControlsInput } from './RocketSimSnapshotSerializer.ts';

export interface DeterminismMetrics {
  tickA: number;
  tickB: number;
  totalRollbacks: number;
  currentDepth: number;
  lastRollbackDurationMs: number;
  carDeltaPos: number;
  carDeltaVel: number;
  carDeltaAngVel: number;
  ballDeltaPos: number;
  maxDeltaPos: number;
  maxDeltaVel: number;
  maxDeltaBall: number;
  isBitExact: boolean;
}

export interface DeterminismTickHistorySlot {
  tick: number;
  controls: Record<number, CarControlsInput>;
}

export class DeterminismHarness {
  simA: RocketSimPhysicsEngine;
  simB: RocketSimPhysicsEngine | null;
  options: Record<string, unknown>;
  active: boolean;
  periodicRollback: boolean;
  rollbackInterval: number;
  rollbackDepth: number;
  totalRollbacks: number;
  historyCapacity: number;
  historyMask: number;
  controlsHistory: Array<DeterminismTickHistorySlot | null | undefined>;
  lastKnownControls: Map<number, CarControlsInput>;
  lastResetTick: number;
  metrics: DeterminismMetrics;
  onMetricsUpdated: ((metrics: DeterminismMetrics) => void) | null;
  _metricsListeners: Set<(metrics: DeterminismMetrics) => void>;
  _originalMethods: Record<string, (...args: never[]) => unknown>;

  constructor(primarySim: RocketSimPhysicsEngine, options: Record<string, unknown> = {}) {
    this.simA = primarySim;
    this.simB = null;
    this.options = options;

    this.active = false;
    this.periodicRollback = true;
    this.rollbackInterval = 30; // Every 30 ticks (4 times per second at 120Hz)
    this.rollbackDepth = 15; // Roll back 15 ticks (125ms)
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
      isBitExact: true,
    };

    this.onMetricsUpdated = null;
    this._metricsListeners = new Set();
    this._originalMethods = {};
  }

  private _patchMetrics(patch: Partial<DeterminismMetrics>): void {
    Object.assign(this.metrics, patch);
  }

  addMetricsListener(fn: (metrics: DeterminismMetrics) => void): () => void {
    if (typeof fn === 'function') {
      this._metricsListeners.add(fn);
      return () => this._metricsListeners.delete(fn);
    }
    return () => {};
  }

  notifyMetricsUpdated(): void {
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
  async init(): Promise<this> {
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

  _interceptSimA(): void {
    const origSetControls = this.simA.setControls.bind(this.simA);
    this._originalMethods.setControls = origSetControls as (...args: never[]) => unknown;
    this.simA.setControls = (carIndex, controls) => {
      origSetControls(carIndex, controls);
      this.recordControls(carIndex, controls);
    };

    const origStep = this.simA.step.bind(this.simA);
    this._originalMethods.step = origStep as (...args: never[]) => unknown;
    this.simA.step = (ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        origStep(1);
        this.onPhysicsTickOneStep();
      }
      this.compareStates();
    };

    const origSetUnlimitedBoost = this.simA.setUnlimitedBoost.bind(this.simA);
    this._originalMethods.setUnlimitedBoost = origSetUnlimitedBoost as (
      ...args: never[]
    ) => unknown;
    this.simA.setUnlimitedBoost = (unlimited) => {
      origSetUnlimitedBoost(unlimited);
      if (this.simB) {
        this.simB.setUnlimitedBoost(unlimited);
      }
    };

    const origResetKickoff = this.simA.resetKickoff.bind(this.simA);
    this._originalMethods.resetKickoff = origResetKickoff as (...args: never[]) => unknown;
    this.simA.resetKickoff = (seed = -1) => {
      origResetKickoff(seed);
      this.syncResetKickoff(seed);
    };

    const origControlBall = this.simA.controlBall.bind(this.simA);
    this._originalMethods.controlBall = origControlBall as (...args: never[]) => unknown;
    this.simA.controlBall = (carIndex, modeIndex) => {
      const res = origControlBall(carIndex, modeIndex);
      this.syncControlBall(carIndex, modeIndex);
      return res;
    };

    const origAddCar = this.simA.addCar.bind(this.simA);
    this._originalMethods.addCar = origAddCar as (...args: never[]) => unknown;
    this.simA.addCar = (team, hitboxType) => {
      const carIdx = origAddCar(team, hitboxType);
      if (this.simB) {
        this.simB.addCar(team, hitboxType);
      }
      return carIdx;
    };

    if (typeof this.simA.setCarState === 'function') {
      const origSetCarState = this.simA.setCarState.bind(this.simA);
      this._originalMethods.setCarState = origSetCarState as (...args: never[]) => unknown;
      this.simA.setCarState = (carIndex, stateObj) => {
        const res = origSetCarState(carIndex, stateObj);
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
      const origSetLinear = this.simA.setCarLinearFactorAndGravity.bind(this.simA);
      this._originalMethods.setCarLinearFactorAndGravity = origSetLinear as (
        ...args: never[]
      ) => unknown;
      this.simA.setCarLinearFactorAndGravity = (carIndex, fx, fy, fz, gravityScale) => {
        const res = origSetLinear(carIndex, fx, fy, fz, gravityScale);
        if (this.simB && typeof this.simB.setCarLinearFactorAndGravity === 'function') {
          this.simB.setCarLinearFactorAndGravity(carIndex, fx, fy, fz, gravityScale);
        }
        return res;
      };
    }

    if (typeof this.simA.setCarCollisionMask === 'function') {
      const origSetCollision = this.simA.setCarCollisionMask.bind(this.simA);
      this._originalMethods.setCarCollisionMask = origSetCollision as (...args: never[]) => unknown;
      this.simA.setCarCollisionMask = (carIndex, interactWithBall, interactWithCars) => {
        const res = origSetCollision(carIndex, interactWithBall, interactWithCars);
        if (this.simB && typeof this.simB.setCarCollisionMask === 'function') {
          this.simB.setCarCollisionMask(carIndex, interactWithBall, interactWithCars);
        }
        return res;
      };
    }
  }

  setRollbackDepth(depth: number): void {
    this.rollbackDepth = Math.max(1, Math.min(240, Math.floor(Number(depth) || 15)));
  }

  setRollbackInterval(interval: number): void {
    this.rollbackInterval = Math.max(1, Math.min(600, Math.floor(Number(interval) || 30)));
  }

  recordControls(carIndex: number, controls: CarControlsInput): void {
    if (!this.active) return;
    this.lastKnownControls.set(carIndex, { ...controls });

    const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
    const slot = currentTick & this.historyMask;
    if (!this.controlsHistory[slot] || this.controlsHistory[slot]!.tick !== currentTick) {
      this.controlsHistory[slot] = { tick: currentTick, controls: {} };
    }
    this.controlsHistory[slot]!.controls[carIndex] = { ...controls };
  }

  _ensureTickControls(tick: number): Record<number, CarControlsInput> {
    const slot = tick & this.historyMask;
    if (!this.controlsHistory[slot] || this.controlsHistory[slot]!.tick !== tick) {
      const controlsMap: Record<number, CarControlsInput> = {};
      for (const [cIdx, ctrl] of this.lastKnownControls.entries()) {
        controlsMap[cIdx] = { ...ctrl };
      }
      this.controlsHistory[slot] = { tick, controls: controlsMap };
    }
    return this.controlsHistory[slot]!.controls;
  }

  onPhysicsTickOneStep(): void {
    if (!this.active || !this.simB) return;

    const preTick = Math.floor(this.simB.getHeaderView().tickCount);
    const controlsMap = this._ensureTickControls(preTick);

    for (const [carIdxStr, ctrl] of Object.entries(controlsMap)) {
      this.simB.setControls(Number(carIdxStr), ctrl);
    }

    this.simB.saveStateSlot(preTick % 256);
    this.simB.step(1);

    const postTick = preTick + 1;
    if (
      this.periodicRollback &&
      postTick > this.rollbackDepth &&
      postTick % this.rollbackInterval === 0
    ) {
      this.executeRollback(this.rollbackDepth);
    }
  }

  executeRollback(depth = 15): void {
    if (!this.active || !this.simB) return;

    const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
    const minAllowedTick = this.lastResetTick;
    const targetRollbackTick = Math.max(minAllowedTick, currentTick - Math.min(depth, 250));
    const actualDepth = currentTick - targetRollbackTick;
    if (actualDepth <= 0) return;

    const rollbackTick = targetRollbackTick;
    const startTime = performance.now();

    this.simB.restoreStateSlot(rollbackTick % 256);

    for (let t = rollbackTick; t < currentTick; t++) {
      const slot = t & this.historyMask;
      const entry = this.controlsHistory[slot];
      const controlsMap = entry && entry.tick === t ? entry.controls : {};
      for (const [carIdxStr, ctrl] of Object.entries(controlsMap)) {
        this.simB.setControls(Number(carIdxStr), ctrl);
      }
      this.simB.stepSilent(1);
    }

    const duration = performance.now() - startTime;
    this.totalRollbacks++;
    this._patchMetrics({
      totalRollbacks: this.totalRollbacks,
      currentDepth: actualDepth,
      lastRollbackDurationMs: duration,
    });
    this.compareStates();
  }

  triggerManualRollback(depth = this.rollbackDepth): void {
    this.executeRollback(depth);
    this.compareStates();
  }

  syncResetKickoff(seed = -1): void {
    if (!this.active || !this.simB) return;
    const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
    this.lastResetTick = currentTick;

    this.simB.resetKickoff(seed);
    const stateA = this.simA.saveState();
    this.simB.restoreState(stateA);

    for (let s = 0; s < 256; s++) {
      this.simB.saveStateSlot(s);
    }

    for (let i = 0; i < this.historyCapacity; i++) {
      const entry = this.controlsHistory[i];
      if (entry && entry.tick < currentTick) {
        this.controlsHistory[i] = null;
      }
    }

    this.compareStates();
  }

  syncControlBall(carIndex: number, modeIndex: number | string): void {
    if (!this.active || !this.simB) return;
    const currentTick = Math.floor(this.simA.getHeaderView().tickCount);
    this.lastResetTick = currentTick;

    this.simB.controlBall(carIndex, modeIndex);
    const stateA = this.simA.saveState();
    this.simB.restoreState(stateA);

    for (let s = 0; s < 256; s++) {
      this.simB.saveStateSlot(s);
    }

    for (let i = 0; i < this.historyCapacity; i++) {
      const entry = this.controlsHistory[i];
      if (entry && entry.tick < currentTick) {
        this.controlsHistory[i] = null;
      }
    }

    this.compareStates();
  }

  compareStates(): void {
    if (!this.active || !this.simB) return;

    const tickA = Math.floor(this.simA.getHeaderView().tickCount);
    const tickB = Math.floor(this.simB.getHeaderView().tickCount);

    let carDeltaPos = 0;
    let carDeltaVel = 0;
    let carDeltaAngVel = 0;

    const count = Math.min(this.simA.numCars || 0, this.simB.numCars || 0);
    for (let c = 0; c < count; c++) {
      const carA = this.simA.getCarStateView(c);
      const carB = this.simB.getCarStateView(c);

      const dPos = Math.hypot(carA.posX - carB.posX, carA.posY - carB.posY, carA.posZ - carB.posZ);
      const dVel = Math.hypot(carA.velX - carB.velX, carA.velY - carB.velY, carA.velZ - carB.velZ);
      const dAng = Math.hypot(
        carA.angVelX - carB.angVelX,
        carA.angVelY - carB.angVelY,
        carA.angVelZ - carB.angVelZ
      );
      if (dPos > carDeltaPos) carDeltaPos = dPos;
      if (dVel > carDeltaVel) carDeltaVel = dVel;
      if (dAng > carDeltaAngVel) carDeltaAngVel = dAng;
    }

    const ballA = this.simA.getBallStateView();
    const ballB = this.simB.getBallStateView();
    const ballDeltaPos = Math.hypot(
      ballA.posX - ballB.posX,
      ballA.posY - ballB.posY,
      ballA.posZ - ballB.posZ
    );

    this._patchMetrics({
      tickA,
      tickB,
      carDeltaPos,
      carDeltaVel,
      carDeltaAngVel,
      ballDeltaPos,
      maxDeltaPos: Math.max(this.metrics.maxDeltaPos, carDeltaPos),
      maxDeltaVel: Math.max(this.metrics.maxDeltaVel, carDeltaVel),
      maxDeltaBall: Math.max(this.metrics.maxDeltaBall, ballDeltaPos),
      isBitExact: carDeltaPos === 0 && ballDeltaPos === 0,
    });

    this.notifyMetricsUpdated();
  }

  resetStats(): void {
    this.totalRollbacks = 0;
    this._patchMetrics({
      totalRollbacks: 0,
      maxDeltaPos: 0,
      maxDeltaVel: 0,
      maxDeltaBall: 0,
      isBitExact: true,
    });
    this.notifyMetricsUpdated();
  }

  resetMaxDeltas(): void {
    this._patchMetrics({
      maxDeltaPos: 0,
      maxDeltaVel: 0,
      maxDeltaBall: 0,
      isBitExact: this.metrics.carDeltaPos === 0 && this.metrics.ballDeltaPos === 0,
    });
    this.notifyMetricsUpdated();
  }

  destroy(): void {
    this.active = false;
    const simTarget = this.simA as unknown as Record<string, unknown>;
    for (const [key, origFn] of Object.entries(this._originalMethods)) {
      simTarget[key] = origFn;
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
