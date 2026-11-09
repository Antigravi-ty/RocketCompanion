/**
 * RocketSimPhysicsEngine.ts
 * Clean, modern wrapper for RocketSim WebAssembly simulation core (core.wasm).
 */

import type { RocketSimWasmModule, RocketSimWasmModuleOptions } from './RocketSimWasm.ts';
import { SIM_OFFSETS, BALL_STATE_STRIDE, CAR_STATE_STRIDE } from './RocketSimConstants.ts';
import {
  updateWasmBallPrediction,
  updateWasmBallPredictionIncremental,
  updateWasmBallPredictionManual,
  getWasmBallPredictionBuffer,
  getWasmBallPredictionCount,
  getWasmBallPredictionStride,
} from './ballPredictionPipeline.ts';
import {
  CarStateView,
  BallStateView,
  ArenaHeaderView,
  BoostPadStateView,
} from './RocketSimStateViews.ts';
import type { PhysicsEventReader } from './PhysicsEventReader.ts';
import {
  PhysicsEventDispatcher,
  type PhysicsEventDispatchCallback,
} from './PhysicsEventDispatcher.ts';
import {
  PhysicsPossessionTracker,
  type PossessionStatsSnapshot,
} from './PhysicsPossessionTracker.ts';
import {
  saveWasmSnapshotState,
  saveCompactStateSnapshot,
  restoreWasmSnapshotState,
  readArenaPads,
  type CarControlsInput,
  type BallStateObjectInput,
  type CarStateObjectInput,
  type RestoreSnapshotOptions,
  type ArenaBoostPadDescriptor,
  type NumericBufferLike,
} from './RocketSimSnapshotSerializer.ts';
import { writeCarControls, applyBallState, applyCarState } from './RocketSimEntityStateMutator.ts';
import {
  getWasmReplayIncidentTrackBytes,
  getWasmReplaySignalTrackBytes,
  extractWasmReplayTracks,
  getWasmReplayFrameByOffset,
  getWasmReplayFrameByIndex,
  getWasmReplayControlsByIndex,
  type ExtractedWasmReplayTracks,
} from './wasmReplayTrackExtractor.ts';
import {
  RocketSimArenaBarrierController,
  type CarSpecEntry,
  type GoalBarrierMetadata,
} from './RocketSimArenaBarrierController.ts';
import { RocketSimCarMutatorController } from './RocketSimCarMutatorController.ts';

export interface RocketSimEngineInitOptions extends RocketSimWasmModuleOptions {
  collisionData?: Uint8Array[] | null;
}

export class RocketSimPhysicsEngine {
  static cachedCollisionData: Uint8Array[] | null = null;
  module: RocketSimWasmModule | null = null;
  isInitialized = false;
  statePtr = 0;
  stateLen = 0;
  controlsPtr = 0;
  eventBufferPtr = 0;
  eventBufferSize = 0;
  eventReader: PhysicsEventReader | null = null;
  readonly eventDispatcher: PhysicsEventDispatcher;
  readonly possessionTracker = new PhysicsPossessionTracker();
  readonly arenaBarriers: RocketSimArenaBarrierController;
  readonly carMutators: RocketSimCarMutatorController;
  syntheticFallback: { reset?: () => void } | null = null;
  stateView: Float32Array | null = null;
  controlsView: Float32Array | null = null;
  headerViewInstance: ArenaHeaderView | null = null;
  ballStateViewInstance: BallStateView | null = null;
  carStateViewInstances: CarStateView[] = [];
  boostPadStateViewInstances: BoostPadStateView[] = [];
  wasmStatePtr = 0;
  wasmStateSize = 0;
  cachedSnapshotBuffer: Float32Array | null = null;
  isUnlimitedBoost = false;
  arenaPreset = 0;
  _carSpecs: Array<CarSpecEntry | null> = [];
  floorNz = 0.8;
  netNz = 0.05;
  minDirDot = 0.0;
  inputBufferCount?: number[];
  ballStateWriteRevision = 0;

  constructor() {
    this.eventDispatcher = new PhysicsEventDispatcher(this);
    this.arenaBarriers = new RocketSimArenaBarrierController(this);
    this.carMutators = new RocketSimCarMutatorController(this);
  }

  getCachedCollisionData(): Uint8Array[] | null {
    return RocketSimPhysicsEngine.cachedCollisionData;
  }
  setCachedCollisionData(d: Uint8Array[] | null): void {
    RocketSimPhysicsEngine.cachedCollisionData = d;
  }
  getCurrentTick(): number {
    return Math.floor(this.state?.[SIM_OFFSETS.TICK] || 0);
  }

  get state(): Float32Array {
    const buf = this.module!.HEAPF32.buffer;
    if (!this.stateView || this.stateView.buffer !== buf) {
      this.stateView = new Float32Array(buf, this.statePtr, this.stateLen);
    }
    return this.stateView;
  }

  async init(opts: RocketSimEngineInitOptions = {}): Promise<void> {
    await this.arenaBarriers.initEngine(opts);
  }
  clearEvents(): void {
    this.arenaBarriers.clearEvents();
  }

  updateBallPrediction(s = 5.0): number {
    return updateWasmBallPrediction(this.module, s);
  }
  updateBallPredictionIncremental(s = 5.0): number {
    return updateWasmBallPredictionIncremental(this.module, s);
  }
  updateBallPredictionManual(s = 5.0, ticks = 1): number {
    return updateWasmBallPredictionManual(this.module, s, ticks);
  }
  getBallPrediction(): Float32Array | null {
    return getWasmBallPredictionBuffer(this.module);
  }
  getBallPredictionCount(): number {
    return getWasmBallPredictionCount(this.module);
  }
  getBallPredictionStride(): number {
    return getWasmBallPredictionStride(this.module);
  }
  isBallSleeping(): boolean {
    return this.arenaBarriers.isBallSleeping(this.getBallStateView());
  }

  setSimulationFrozen(frozen: boolean, resumeTick = 0, mask = false): void {
    this.module?._physics_setSimulationFrozen?.(frozen ? 1 : 0, resumeTick, mask ? 1 : 0);
  }
  setPossessionReportingEnabled(on: boolean): void {
    this.possessionTracker.setReportingEnabled(this.module, on);
  }
  resetPossessionStats(): void {
    this.possessionTracker.resetPossessionStats(this.module, this.module ? this.state : null);
  }
  getPossessionStats(): PossessionStatsSnapshot {
    return this.possessionTracker.getPossessionStats(this.module ? this.state : null);
  }

  pushSignalEvent(
    t: number,
    tick: number,
    x = 0,
    y = 0,
    z = 0,
    nx = 0,
    ny = 0,
    nz = 0,
    pId = 0,
    sId = 0,
    sub = 0,
    flg = 0,
    cf = 0,
    ci = 0
  ): void {
    this.module?._physics_pushSignalEvent?.(
      t,
      tick,
      x,
      y,
      z,
      nx,
      ny,
      nz,
      pId,
      sId,
      sub,
      flg,
      cf,
      ci
    );
  }

  resetGoalLatch(): void {
    this.module?._physics_resetGoalLatch?.();
  }
  readEvents(cb?: PhysicsEventDispatchCallback): number {
    return this.eventDispatcher.readEvents(cb);
  }

  addCar(team: number, hb: string | number = 'octane'): number {
    return this.carMutators.addCar(team, hb);
  }
  addCarAtSlot(i: number, team: number, hb: string | number = 'octane'): number {
    return this.carMutators.addCarAtSlot(i, team, hb);
  }
  removeCar(i: number): boolean {
    return this.carMutators.removeCar(i);
  }
  getActiveCarMask(): number {
    return this.carMutators.getActiveCarMask();
  }
  isCarSlotActive(i: number): boolean {
    return this.carMutators.isCarSlotActive(i);
  }
  setCarHitbox(i: number, hb: string | number): boolean {
    return this.carMutators.setCarHitbox(i, hb);
  }
  setCarTeam(i: number, team: number): boolean {
    return this.carMutators.setCarTeam(i, team);
  }
  demolishCar(i: number, delay = 3.0): boolean {
    return this.carMutators.demolishCar(i, delay);
  }
  resetKickoffAtSpawn(spawn = 0, settle = 30): boolean {
    return this.arenaBarriers.resetKickoffAtSpawn(spawn, settle);
  }

  setCarLinearFactorAndGravity(i: number, fx = 1.0, fy = 1.0, fz = 1.0, g = 1.0): boolean {
    return this.carMutators.setCarLinearFactorAndGravity(i, fx, fy, fz, g);
  }
  setCarCollisionMask(i: number, ball = true, cars = true): boolean {
    return this.carMutators.setCarCollisionMask(i, ball, cars);
  }
  setCarThreeWheels(i = 0, on = true): boolean {
    return this.carMutators.setCarThreeWheels(i, on);
  }

  setArenaPreset(p = 0): void {
    this.arenaBarriers.setArenaPreset(p);
  }
  getArenaPreset(): number {
    return this.arenaBarriers.getArenaPreset();
  }
  isBallScored(bv = this.getBallStateView()): boolean {
    return this.arenaBarriers.isBallScored(bv);
  }
  async reloadMeshes(p = '/arenamesh/manifest.json'): Promise<boolean> {
    return this.arenaBarriers.reloadMeshes(p);
  }
  setGoalBarrierChunks(c: Uint8Array[] = [], m: GoalBarrierMetadata | null = null): boolean {
    return this.arenaBarriers.setGoalBarrierChunks(c, m);
  }
  isPointOnGoalBarrier(x: number, y: number, z: number): boolean {
    return this.arenaBarriers.isPointOnGoalBarrier(x, y, z);
  }
  setArenaMutators(opts?: {
    gravityZ?: number;
    boostAccelGround?: number;
    boostAccelAir?: number;
    ballMaxSpeed?: number;
    ballBounciness?: number;
  }): boolean {
    return this.carMutators.setArenaMutators(opts);
  }

  initReplayBuffer(): void {
    this.module?._physics_initReplayBuffer?.();
  }
  clearReplayBuffer(): void {
    this.module?._physics_clearReplayBuffer?.();
  }
  recordReplayFrame(): void {
    this.module?._physics_recordReplayFrame?.();
  }
  getReplayFrameCount(): number {
    return this.module?._physics_getReplayFrameCount?.() ?? 0;
  }
  setReplayRecordingActive(on = true): void {
    this.module?._physics_setReplayRecordingActive?.(on ? 1 : 0);
  }
  getReplayRecordingActive(): boolean {
    return (this.module?._physics_getReplayRecordingActive?.() ?? 1) === 1;
  }
  getReplayFrameByOffset(ago = 0): Float32Array | null {
    return getWasmReplayFrameByOffset(this.module, this.stateLen, ago);
  }
  getReplayFrameByIndex(idx = 0): Float32Array | null {
    return getWasmReplayFrameByIndex(this.module, this.stateLen, idx);
  }
  getReplayControlsByIndex(idx = 0): Uint8Array | null {
    return getWasmReplayControlsByIndex(this.module, idx);
  }
  getReplayIncidentTrackBytes(): Uint8Array {
    return getWasmReplayIncidentTrackBytes(this.module);
  }
  getReplaySignalTrackBytes(): Uint8Array {
    return getWasmReplaySignalTrackBytes(this.module);
  }
  extractWasmReplayTracks(): ExtractedWasmReplayTracks {
    return extractWasmReplayTracks(this.module);
  }

  configureCars(hb: string | number, isMatch: boolean, team = 0): void {
    this.arenaBarriers.configureCars(hb, isMatch, team);
  }
  setControls(i: number, c: CarControlsInput): void {
    writeCarControls(this.module!, this, i, c);
  }
  setCarControls(i: number, c: CarControlsInput): void {
    writeCarControls(this.module!, this, i, c);
  }

  getHeaderView(): ArenaHeaderView {
    return (this.headerViewInstance ??= new ArenaHeaderView()).attach(this.state);
  }
  get numCars(): number {
    return this.state ? this.getHeaderView().numCars : 0;
  }
  get ballState(): BallStateView {
    return this.getBallStateView();
  }
  getBallStateView(): BallStateView {
    return (this.ballStateViewInstance ??= new BallStateView()).attach(this.state);
  }
  getBallState(): Float32Array {
    return this.state.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE);
  }
  getCarStateView(i = 0): CarStateView {
    return (this.carStateViewInstances[i] ??= new CarStateView()).attachCar(this.state, i);
  }
  getBoostPadStateView(i = 0): BoostPadStateView {
    return (this.boostPadStateViewInstances[i] ??= new BoostPadStateView()).attach(this.state, i);
  }
  getCarState(i: number): Float32Array {
    const off = SIM_OFFSETS.CARS + i * CAR_STATE_STRIDE;
    return this.state.subarray(off, off + CAR_STATE_STRIDE);
  }
  setCarState(
    i: number,
    cs: number | ArrayLike<number> | CarStateObjectInput | null | undefined
  ): boolean {
    return applyCarState(this.module, this, i, cs);
  }

  private _markBallWrite(): void {
    this.eventDispatcher.resetFloorTouchLatch();
    this.ballStateWriteRevision = (this.ballStateWriteRevision + 1) | 0;
  }
  setBallState(bs: number | ArrayLike<number> | BallStateObjectInput | null | undefined): boolean {
    this._markBallWrite();
    return applyBallState(this.module, this, bs);
  }

  step(ticks = 1): void {
    this.eventDispatcher.stepWithPadEdgeDetection(ticks);
    this.possessionTracker.applyAccumulatedPossessionToState(
      this.module,
      this.module ? this.state : null
    );
  }
  stepSilent(ticks = 1): void {
    this.eventDispatcher.resetFloorTouchLatch();
    this.module!._physics_stepSilent(ticks);
  }
  saveStateSlot(slot: number): boolean {
    return this.module!._physics_saveStateSlot(slot) === 1;
  }
  restoreStateSlot(slot: number): boolean {
    this._markBallWrite();
    return this.module!._physics_restoreStateSlot(slot) === 1;
  }
  getStateSnapshotSize(): number {
    return this.module!._physics_getStateSnapshotSize();
  }
  saveState(buf: Float32Array | null = null): Float32Array {
    return saveWasmSnapshotState(this.module!, this, buf);
  }
  saveCompactState(buf: Float32Array | null = null): Float32Array {
    return saveCompactStateSnapshot(this, buf);
  }
  restoreState(
    buf: NumericBufferLike | null | undefined,
    opts: RestoreSnapshotOptions = {}
  ): boolean {
    this._markBallWrite();
    return restoreWasmSnapshotState(this.module!, this, buf, opts);
  }
  restoreCompactState(
    buf: NumericBufferLike | null | undefined,
    opts: RestoreSnapshotOptions = {}
  ): boolean {
    return this.restoreState(buf, opts);
  }

  resetKickoff(seed = -1, preserveScore = true): void {
    this.arenaBarriers.resetKickoff(seed, preserveScore);
  }
  controlBall(i: number, mode: number | string): boolean {
    return this.carMutators.controlBall(i, mode);
  }

  setUnlimitedBoost(on: boolean): void {
    this.carMutators.setUnlimitedBoost(on);
  }
  getUnlimitedBoost(): boolean {
    return this.carMutators.getUnlimitedBoost();
  }
  setCarUnlimitedBoost(i: number, on: boolean): void {
    this.carMutators.setCarUnlimitedBoost(i, on);
  }
  getCarUnlimitedBoost(i = 0): boolean {
    return this.carMutators.getCarUnlimitedBoost(i);
  }
  setCarBoostCollectable(i: number, on: boolean): void {
    this.carMutators.setCarBoostCollectable(i, on);
  }
  getCarBoostCollectable(i = 0): boolean {
    return this.carMutators.getCarBoostCollectable(i);
  }
  setCarBoostRecharge(i: number, on: boolean, rate = 10.0, delay = 0.25): void {
    this.carMutators.setCarBoostRecharge(i, on, rate, delay);
  }
  getCarBoostRechargeEnabled(i = 0): boolean {
    return this.carMutators.getCarBoostRechargeEnabled(i);
  }
  getCarBoostRechargePerSecond(i = 0): number {
    return this.carMutators.getCarBoostRechargePerSecond(i);
  }
  getCarBoostRechargeDelay(i = 0): number {
    return this.carMutators.getCarBoostRechargeDelay(i);
  }
  getCarMaxFlipCount(i = 0): number {
    return this.carMutators.getCarMaxFlipCount(i);
  }

  pollGoal(): number {
    return this.arenaBarriers.pollGoal(this.getHeaderView().goalScoredFlag);
  }
  get ballRadius(): number {
    return this.module!._physics_getBallRadius();
  }
  get ballOnGround(): boolean {
    return (
      this.module!._physics_getBallOnGround() === 1 ||
      Boolean(this.eventDispatcher.ballTouchedFloorInLastStep)
    );
  }
  getBallOnGround(): boolean {
    return this.ballOnGround;
  }
  getPads(): ArenaBoostPadDescriptor[] {
    return readArenaPads(this.module!, this);
  }

  destroy(): void {
    if (this.wasmStatePtr && this.module?._free) {
      this.module._free(this.wasmStatePtr);
      this.wasmStatePtr = 0;
      this.wasmStateSize = 0;
      this.cachedSnapshotBuffer = null;
    }
    this.module = null;
    this.stateView = null;
    this.controlsView = null;
    this.eventReader = null;
    this.headerViewInstance = null;
    this.ballStateViewInstance = null;
    this.carStateViewInstances = [];
    this.boostPadStateViewInstances = [];
  }
}

export default RocketSimPhysicsEngine;
