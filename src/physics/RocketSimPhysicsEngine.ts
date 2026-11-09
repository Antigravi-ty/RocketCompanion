/**
 * RocketSimPhysicsEngine.ts
 * Clean, modern wrapper for RocketSim WebAssembly simulation core (core.wasm).
 */

import type { RocketSimWasmModule, RocketSimWasmModuleOptions } from './RocketSimWasm.ts';
import { SIM_OFFSETS, BALL_STATE_STRIDE, CAR_STATE_STRIDE } from './RocketSimConstants.ts';
import {
  updateWasmBallPrediction,
  updateWasmBallPredictionIncremental,
  getWasmBallPredictionBuffer,
  getWasmBallPredictionStride,
  computeFreeplayBallControlState,
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
import { checkPointOnGoalBarrier, evaluateBallScored } from './goalBarrierVolumePipeline.ts';
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
  readonly eventDispatcher = new PhysicsEventDispatcher();
  readonly possessionTracker = new PhysicsPossessionTracker();
  readonly arenaBarriers = new RocketSimArenaBarrierController();
  readonly carMutators = new RocketSimCarMutatorController();
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
  ballStateWriteRevision = 0;

  constructor() {
    const mutators = this.carMutators;
    mutators.bindSimContext(this);
  }

  get _carSpecs(): Array<CarSpecEntry | null> {
    return this.carMutators.carSpecs;
  }
  set _carSpecs(specs: Array<CarSpecEntry | null>) {
    this.carMutators.carSpecs = specs;
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
    this.carMutators.bindSimContext(this);
    await this.arenaBarriers.initEngine(this, opts);
  }
  clearEvents(): void {
    const barriers = this.arenaBarriers;
    barriers.clearEvents(this);
  }

  updateBallPrediction(s = 5.0): number {
    return updateWasmBallPrediction(this.module, s);
  }
  updateBallPredictionIncremental(s = 5.0): number {
    return updateWasmBallPredictionIncremental(this.module, s);
  }
  getBallPrediction(): Float32Array | null {
    return getWasmBallPredictionBuffer(this.module);
  }
  getBallPredictionStride(): number {
    return getWasmBallPredictionStride(this.module);
  }
  isBallSleeping(): boolean {
    const bv = this.getBallStateView();
    return this.arenaBarriers.isBallSleeping(bv, this.module);
  }

  setSimulationFrozen(frozen: boolean, resumeTick = 0, mask = false): void {
    this.module?._physics_setSimulationFrozen?.(frozen ? 1 : 0, resumeTick, mask ? 1 : 0);
  }
  setPossessionReportingEnabled(on: boolean): void {
    const tracker = this.possessionTracker;
    tracker.setReportingEnabled(this.module, on);
  }
  resetPossessionStats(): void {
    const state = this.module ? this.state : null;
    this.possessionTracker.resetPossessionStats(this.module, state);
  }
  getPossessionStats(): PossessionStatsSnapshot {
    const state = this.module ? this.state : null;
    return this.possessionTracker.getPossessionStats(state);
  }

  pushSignalEvent(...args: [number, number, ...number[]]): void {
    const fn = this.module?._physics_pushSignalEvent;
    if (typeof fn === 'function') {
      fn(
        args[0],
        args[1],
        args[2] ?? 0,
        args[3] ?? 0,
        args[4] ?? 0,
        args[5] ?? 0,
        args[6] ?? 0,
        args[7] ?? 0,
        args[8] ?? 0,
        args[9] ?? 0,
        args[10] ?? 0,
        args[11] ?? 0,
        args[12] ?? 0,
        args[13] ?? 0
      );
    }
  }

  resetGoalLatch(): void {
    this.module?._physics_resetGoalLatch?.();
  }
  readEvents(cb?: PhysicsEventDispatchCallback): number {
    const dispatcher = this.eventDispatcher;
    return dispatcher.readEvents(this, cb);
  }

  addCar(team: number, hb: string | number = 'octane'): number {
    const mutators = this.carMutators;
    return mutators.addCar(team, hb);
  }
  addCarAtSlot(i: number, team: number, hb: string | number = 'octane'): number {
    const mutators = this.carMutators;
    return mutators.addCarAtSlot(i, team, hb);
  }
  removeCar(i: number): boolean {
    const mutators = this.carMutators;
    return mutators.removeCar(i);
  }
  getActiveCarMask(): number {
    const mutators = this.carMutators;
    return mutators.getActiveCarMask();
  }
  isCarSlotActive(i: number): boolean {
    const mutators = this.carMutators;
    return mutators.isCarSlotActive(i);
  }
  setCarHitbox(i: number, hb: string | number): boolean {
    const mutators = this.carMutators;
    return mutators.setCarHitbox(i, hb);
  }
  setCarTeam(i: number, team: number): boolean {
    const mutators = this.carMutators;
    return mutators.setCarTeam(i, team);
  }
  demolishCar(i: number, delay = 3.0): boolean {
    return this.module?._physics_demolishCar?.(i, delay) === 1;
  }
  resetKickoffAtSpawn(spawn = 0, settle = 30): boolean {
    const barriers = this.arenaBarriers;
    return barriers.resetKickoffAtSpawn(this, spawn, settle);
  }

  setCarLinearFactorAndGravity(i: number, fx = 1.0, fy = 1.0, fz = 1.0, g = 1.0): boolean {
    return this.module?._physics_setCarLinearFactorAndGravity?.(i, fx, fy, fz, g) === 1;
  }
  setCarCollisionMask(i: number, ball = true, cars = true): boolean {
    return this.module?._physics_setCarCollisionMask?.(i, ball ? 1 : 0, cars ? 1 : 0) === 1;
  }
  setCarThreeWheels(i = 0, on = true): boolean {
    const mutators = this.carMutators;
    return mutators.setCarThreeWheels(i, on);
  }

  setArenaPreset(p = 0): void {
    this.arenaPreset = this.arenaBarriers.setArenaPreset(p, this.module);
  }
  getArenaPreset(): number {
    const barriers = this.arenaBarriers;
    return barriers.getArenaPreset(this.module);
  }
  isBallScored(bv = this.getBallStateView()): boolean {
    return evaluateBallScored(
      bv,
      this.getArenaPreset(),
      this.arenaBarriers.goalVolumeBox,
      this.arenaBarriers.goalBarrierMeta
    );
  }
  async reloadMeshes(p = '/arenamesh/manifest.json'): Promise<boolean> {
    return await this.arenaBarriers.reloadMeshes(this.module, p);
  }
  setGoalBarrierChunks(c: Uint8Array[] = [], m: GoalBarrierMetadata | null = null): boolean {
    const barriers = this.arenaBarriers;
    return barriers.setGoalBarrierChunks(this, c, m);
  }
  isPointOnGoalBarrier(x: number, y: number, z: number): boolean {
    return checkPointOnGoalBarrier(this.arenaBarriers.goalBarrierMeta, x, y, z);
  }
  setArenaMutators(opts?: Record<string, number>): boolean {
    const mutators = this.carMutators;
    return mutators.setArenaMutators(opts);
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
    const barriers = this.arenaBarriers;
    barriers.configureCars(this, hb, isMatch, team);
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
    const off = SIM_OFFSETS.BALL;
    return this.state.subarray(off, off + BALL_STATE_STRIDE);
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
    this.eventDispatcher.stepWithPadEdgeDetection(this, ticks);
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
    const barriers = this.arenaBarriers;
    barriers.resetKickoff(this, seed, preserveScore);
  }
  controlBall(i: number, mode: number | string): boolean {
    if (!this.module || !this.isCarSlotActive(i)) return false;
    const cv = this.getCarStateView(i);
    const target = computeFreeplayBallControlState(
      { posX: cv.posX, posY: cv.posY, posZ: cv.posZ, fwdX: cv.fwdX, fwdY: cv.fwdY, fwdZ: cv.fwdZ },
      mode
    );
    return target ? this.setBallState(target) : false;
  }

  setUnlimitedBoost(on: boolean): void {
    const flag = Boolean(on);
    this.isUnlimitedBoost = flag;
    this.carMutators.isUnlimitedBoost = flag;
    this.module?._physics_setUnlimitedBoost?.(flag ? 1 : 0);
  }
  getUnlimitedBoost(): boolean {
    return typeof this.module?._physics_getUnlimitedBoost === 'function'
      ? this.module._physics_getUnlimitedBoost() === 1
      : Boolean(this.isUnlimitedBoost);
  }
  setCarUnlimitedBoost(i: number, on: boolean): void {
    const flag = Boolean(on);
    this.module?._physics_setCarUnlimitedBoost?.(i, flag ? 1 : 0);
    if (i === 0) {
      this.isUnlimitedBoost = flag;
      this.carMutators.isUnlimitedBoost = flag;
    }
  }
  getCarUnlimitedBoost(i = 0): boolean {
    return typeof this.module?._physics_getCarUnlimitedBoost === 'function'
      ? this.module._physics_getCarUnlimitedBoost(i) === 1
      : Boolean(this.isUnlimitedBoost);
  }
  setCarBoostCollectable(i: number, on: boolean): void {
    this.module?._physics_setCarBoostCollectable?.(i, on ? 1 : 0);
  }
  getCarBoostCollectable(i = 0): boolean {
    return typeof this.module?._physics_getCarBoostCollectable === 'function'
      ? this.module._physics_getCarBoostCollectable(i) === 1
      : true;
  }
  setCarBoostRecharge(i: number, on: boolean, rate = 10.0, delay = 0.25): void {
    this.module?._physics_setCarBoostRecharge?.(i, on ? 1 : 0, Number(rate), Number(delay));
  }
  getCarBoostRechargeEnabled(i = 0): boolean {
    return (this.module?._physics_getCarBoostRechargeEnabled?.(i) ?? 0) === 1;
  }
  getCarBoostRechargePerSecond(i = 0): number {
    return this.module?._physics_getCarBoostRechargePerSecond?.(i) ?? 10.0;
  }
  getCarBoostRechargeDelay(i = 0): number {
    return this.module?._physics_getCarBoostRechargeDelay?.(i) ?? 0.25;
  }
  getCarMaxFlipCount(i = 0): number {
    return this.module?._physics_getCarMaxFlipCount?.(i) ?? 1;
  }

  pollGoal(): number {
    const flag = this.getHeaderView().goalScoredFlag;
    return this.arenaBarriers.pollGoal(flag, this.module);
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
    this.arenaBarriers.bindWasmModule(null);
    this.carMutators.bindSimContext(null);
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
