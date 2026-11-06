/**
 * RocketSimPhysicsEngine.ts
 * Clean, modern wrapper for RocketSim WebAssembly simulation core (core.wasm).
 */

import { loadRocketSimWasmModule, type RocketSimWasmModule } from './RocketSimWasm.ts';
import {
  PLAYER_CAR_INDEX, BOT_CAR_INDEX, getTeamAssignment, getHitboxIndex,
  fetchArenaCollisionMeshes, initWasmCollisionMeshes,
} from './RocketSimMeshLoader.ts';
import {
  SIM_OFFSETS, BALL_STATE_STRIDE, CAR_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET, BOOST_PAD_STATE_STRIDE,
  NUM_BOOST_PADS, EVENT_TOTAL_BUFFER_BYTES, THROWBACK_GOAL_VOLUME_BOX,
} from './RocketSimConstants.ts';
import {
  readWasmMutatorConfig, writeWasmMutatorConfig,
  type ArenaMutatorConfig,
} from './mutatorConfigPipeline.ts';
import {
  computeFreeplayBallControlState,
  initWasmBallPrediction, updateWasmBallPrediction, updateWasmBallPredictionIncremental,
  updateWasmBallPredictionManual, getWasmBallPredictionBuffer, getWasmBallPredictionCount,
  getWasmBallPredictionStride, getWasmBallPredictionSlice, queryWasmBallStateForTime,
  type PredictedBallStateSlice,
} from './ballPredictionPipeline.ts';
import {
  CarStateView, BallStateView, ArenaHeaderView, BoostPadStateView, GameStateView,
} from './RocketSimStateViews.ts';
import { PhysicsEventReader } from './PhysicsEventReader.ts';
import {
  PhysicsEventDispatcher,
  type PhysicsEventDispatchCallback,
} from './PhysicsEventDispatcher.ts';
import {
  PhysicsPossessionTracker,
  type PossessionStatsSnapshot,
} from './PhysicsPossessionTracker.ts';
import {
  writeCarControls, applyBallState, applyCarState,
  ensureWasmSnapshotBuffer, saveWasmSnapshotState, saveCompactStateSnapshot, restoreWasmSnapshotState,
  setCarTeamInWasm, readArenaPads,
  type CarControlsInput, type BallStateObjectInput, type CarStateObjectInput,
  type RestoreSnapshotOptions, type ArenaBoostPadDescriptor, type NumericBufferLike,
} from './RocketSimSnapshotSerializer.ts';
import {
  getGoalVolumeBoxForPreset,
  registerGoalVolumeTunerApplier,
} from '../ui-core/config/goalVolumeTunerConfig';
import {
  getWasmReplayStateTrackBytes, getWasmReplayIncidentTrackBytes,
  getWasmReplaySignalTrackBytes, extractWasmReplayTracks,
  getWasmReplayFrameByOffset, getWasmReplayFrameByIndex, getWasmReplayControlsByIndex,
  type ExtractedWasmReplayTracks,
} from './wasmReplayTrackExtractor.ts';
import {
  syncGoalVolumeBoxToWasm, resolveGoalVolumeConfig, checkActiveGoalBarrier,
  checkPointOnGoalBarrier, evaluateBallScored, reloadArenaCollisionMeshes,
  applyGoalBarrierChunksToWasmArena,
  type GoalVolumeBoxConfig, type GoalVolumeResolvedConfig, type CarSpecEntry,
} from './goalBarrierVolumePipeline.ts';

export class RocketSimPhysicsEngine {
  public static cachedCollisionData: any = null;

  public module: RocketSimWasmModule | null = null;
  public isInitialized = false;
  public statePtr = 0;
  public stateLen = 0;
  public controlsPtr = 0;
  public eventBufferPtr = 0;
  public eventBufferSize = 0;
  public eventReader: PhysicsEventReader | null = null;
  public readonly eventDispatcher: PhysicsEventDispatcher;
  public readonly possessionTracker = new PhysicsPossessionTracker();
  public syntheticFallback: { reset?: () => void } | null = null;
  public stateView: Float32Array | null = null;
  public controlsView: Float32Array | null = null;
  public headerViewInstance: ArenaHeaderView | null = null;
  public gameStateViewInstance: GameStateView | null = null;
  public ballStateViewInstance: BallStateView | null = null;
  public carStateViewInstances: CarStateView[] = [];
  public boostPadStateViewInstances: BoostPadStateView[] = [];
  public wasmStatePtr = 0;
  public wasmStateSize = 0;
  public cachedSnapshotBuffer: Float32Array | null = null;
  public isUnlimitedBoost = false;
  public baseCollisionData: any = null;
  public goalBarrierChunks: unknown[] = [];
  public goalBarrierMeta: Record<string, any> | null = null;
  public arenaPreset = 0;
  public goalVolumeBox: GoalVolumeBoxConfig = getGoalVolumeBoxForPreset(false);
  public _carSpecs: Array<CarSpecEntry | null> = [];
  public floorNz = 0.8;
  public netNz = 0.05;
  public minDirDot = 0.0;
  public inputBufferCount?: number[];
  public ballStateWriteRevision = 0;

  constructor() {
    this.eventDispatcher = new PhysicsEventDispatcher(this);
    const weakThis = new WeakRef(this);
    registerGoalVolumeTunerApplier(() => {
      const self = weakThis.deref();
      if (!self) return;
      self.goalVolumeBox = getGoalVolumeBoxForPreset(self.arenaPreset === 1);
      self._syncGoalVolumeBoxToWasm();
    });
  }

  public get _ballTouchedFloorInLastStep(): boolean { return this.eventDispatcher.ballTouchedFloorInLastStep; }
  public set _ballTouchedFloorInLastStep(val: boolean) { this.eventDispatcher.ballTouchedFloorInLastStep = Boolean(val); }

  public get state(): Float32Array {
    const buffer = this.module!.HEAPF32.buffer;
    if (!this.stateView || this.stateView.buffer !== buffer) {
      this.stateView = new Float32Array(buffer, this.statePtr, this.stateLen);
    }
    return this.stateView;
  }

  public async init(options: Record<string, any> = {}): Promise<void> {
    if (options.collisionData) {
      RocketSimPhysicsEngine.cachedCollisionData = options.collisionData;
    }
    this.module = await loadRocketSimWasmModule(options);
    this.isInitialized = true;

    const collisionData = await fetchArenaCollisionMeshes(RocketSimPhysicsEngine.cachedCollisionData);
    RocketSimPhysicsEngine.cachedCollisionData = collisionData;
    this.baseCollisionData = collisionData;
    const effectiveChunks = this.goalBarrierChunks.length > 0
      ? [...collisionData, ...this.goalBarrierChunks]
      : collisionData;
    initWasmCollisionMeshes(this.module, effectiveChunks);

    if (this.module!._physics_createArena() !== 1) throw new Error('Arena creation failed');
    this._syncGoalVolumeBoxToWasm();
    this.initBallPrediction(5.0);
    this._carSpecs = [];

    this.statePtr = this.module!._physics_getStatePtr();
    this.stateLen = this.module!._physics_getStateSize();
    this.controlsPtr = this.module!._physics_getControlsPtr();

    if (typeof this.module!._physics_getEventBufferPtr === 'function') {
      this.eventBufferPtr = this.module!._physics_getEventBufferPtr();
      this.eventBufferSize = this.module!._physics_getEventBufferSize?.() ?? EVENT_TOTAL_BUFFER_BYTES;
      this.eventReader = new PhysicsEventReader(this.module as any, this.eventBufferPtr);
    } else {
      this.eventReader = null;
    }

    this.stateView = null;
    this.controlsView = null;
    this.initReplayBuffer();
    if (this.eventReader && this.module?.HEAPU8?.buffer) {
      this.eventReader.attach(this.module as any, this.eventBufferPtr);
    }
  }

  public getEventBufferPtr(): number { return this.eventBufferPtr || (this.module?._physics_getEventBufferPtr?.() ?? 0); }
  public getEventBufferSize(): number { return this.eventBufferSize || (this.module?._physics_getEventBufferSize?.() ?? EVENT_TOTAL_BUFFER_BYTES); }

  public clearEvents(): void {
    this.module?._physics_clearEvents?.();
    if (this.eventReader && this.module?.HEAPU8?.buffer && this.eventReader.buffer !== this.module.HEAPU8.buffer) {
      this.eventReader.attach(this.module as any, this.eventBufferPtr);
    }
    this.eventReader?.reset();
    this.syntheticFallback?.reset?.();
  }

  public setImpactThresholds(ballGround = 140.0, ballWall = 160.0, carBall = 50.0, cooldownTicks = 8): void {
    this.module?._physics_setImpactThresholds?.(ballGround, ballWall, carBall, cooldownTicks);
  }
  public setSurfaceTaxonomyThresholds(floorNz = 0.8, netNz = 0.05): void {
    this.floorNz = floorNz;
    this.netNz = netNz;
    this.module?._physics_setSurfaceTaxonomyThresholds?.(floorNz, netNz);
  }
  public setDirectionDotThreshold(minDirDot = 0.0): void {
    this.minDirDot = minDirDot;
    this.module?._physics_setDirectionDotThreshold?.(minDirDot);
  }
  public getSurfaceTaxonomyThresholds(): { floorNz: number; netNz: number } { return { floorNz: this.floorNz ?? 0.8, netNz: this.netNz ?? 0.05 }; }
  public getDirectionDotThreshold(): number { return this.minDirDot ?? 0.0; }

  public initBallPrediction(maxSeconds = 5.0): boolean { return initWasmBallPrediction(this.module, maxSeconds); }
  public updateBallPrediction(maxSeconds = 5.0): number { return updateWasmBallPrediction(this.module, maxSeconds); }
  public updateBallPredictionIncremental(maxSeconds = 5.0): number { return updateWasmBallPredictionIncremental(this.module, maxSeconds); }
  public updateBallPredictionManual(maxSeconds = 5.0, ticksSinceLastUpdate = 1): number {
    return updateWasmBallPredictionManual(this.module, maxSeconds, ticksSinceLastUpdate);
  }
  public getBallPrediction(): Float32Array | null { return getWasmBallPredictionBuffer(this.module); }
  public getBallPredictionCount(): number { return getWasmBallPredictionCount(this.module); }
  public getBallPredictionStride(): number { return getWasmBallPredictionStride(this.module); }
  public getBallPredictionSlice(stepIndex: number): PredictedBallStateSlice | null { return getWasmBallPredictionSlice(this.module, stepIndex); }
  public getBallStateForTime(predTime: number): PredictedBallStateSlice | null { return queryWasmBallStateForTime(this.module, predTime); }

  public isBallSleeping(): boolean {
    if (typeof this.module?._physics_isBallSleeping === 'function') return this.module._physics_isBallSleeping() !== 0;
    const bv = this.getBallStateView();
    return bv.velX === 0 && bv.velY === 0 && bv.velZ === 0;
  }

  public setSimulationFrozen(frozen: boolean, targetResumeTick = 0, maskInputs = false): void {
    this.module?._physics_setSimulationFrozen?.(frozen ? 1 : 0, targetResumeTick, maskInputs ? 1 : 0);
  }
  public setPossessionReportingEnabled(enabled: boolean): void {
    this.possessionTracker.setReportingEnabled(this.module, enabled);
  }
  public resetPossessionStats(): void {
    this.possessionTracker.resetPossessionStats(this.module, this.module ? this.state : null);
  }
  private _applyAccumulatedPossessionToState(): void {
    this.possessionTracker.applyAccumulatedPossessionToState(this.module, this.module ? this.state : null);
  }
  public getPossessionStats(): PossessionStatsSnapshot {
    return this.possessionTracker.getPossessionStats(this.module ? this.state : null);
  }

  public pushSignalEvent(type: number, tick: number, x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, primaryId = 0, secondaryId = 0, subType = 0, flags = 0, customFloat = 0, customInt = 0): void {
    this.module?._physics_pushSignalEvent?.(type, tick, x, y, z, nx, ny, nz, primaryId, secondaryId, subType, flags, customFloat, customInt);
  }

  public resetGoalLatch(): void { this.module?._physics_resetGoalLatch?.(); }
  public getPlayerInputBufferAmount(carIndex = 0): number { return this.inputBufferCount?.[carIndex] || 0; }
  public readEvents(callback?: PhysicsEventDispatchCallback): number { return this.eventDispatcher.readEvents(callback); }

  public addCar(team: number, hitboxType: string | number = 'octane'): number {
    const hitboxIdx = getHitboxIndex(hitboxType);
    const idx = this.module!._physics_addCar(team, hitboxIdx);
    if (idx >= 0) {
      this._carSpecs[idx] = { team: team ? 1 : 0, hitboxIndex: hitboxIdx, threeWheels: false };
    }
    return idx;
  }

  public addCarAtSlot(carIndex: number, team: number, hitboxType: string | number = 'octane'): number {
    const slot = Number(carIndex) | 0;
    if (slot < 0 || slot >= 8) return -1;
    const hitboxIdx = getHitboxIndex(hitboxType);
    if (this.isCarSlotActive(slot)) {
      const prevSpec = this._carSpecs[slot];
      const nextTeam = team ? 1 : 0;
      if (!prevSpec || prevSpec.team !== nextTeam) this.setCarTeam(slot, nextTeam);
      if (!prevSpec || prevSpec.hitboxIndex !== hitboxIdx) this.setCarHitbox(slot, hitboxType);
      this._carSpecs[slot] = { team: nextTeam, hitboxIndex: hitboxIdx, threeWheels: prevSpec?.threeWheels ?? false };
      return slot;
    }
    if (typeof this.module?._physics_addCarAtSlot === 'function') {
      const idx = this.module._physics_addCarAtSlot(slot, team, hitboxIdx);
      if (idx >= 0) this._carSpecs[idx] = { team: team ? 1 : 0, hitboxIndex: hitboxIdx, threeWheels: false };
      return idx;
    }
    return this.addCar(team, hitboxType);
  }

  public removeCar(carIndex: number): boolean {
    const slot = Number(carIndex) | 0;
    const ok = this.module?._physics_removeCar?.(slot) === 1;
    if (ok && slot >= 0 && slot < 8) this._carSpecs[slot] = null;
    return ok;
  }

  public getActiveCarMask(): number {
    if (typeof this.module?._physics_getActiveCarMask === 'function') {
      return this.module._physics_getActiveCarMask() & 0xff;
    }
    let mask = 0;
    const n = Math.min(8, this.numCars || 0);
    for (let i = 0; i < n; i++) {
      if (this._carSpecs[i] !== null) mask |= 1 << i;
    }
    return mask;
  }

  public isCarSlotActive(carIndex: number): boolean {
    const slot = Number(carIndex) | 0;
    if (slot < 0 || slot >= 8) return false;
    if (typeof this.module?._physics_isCarSlotActive === 'function') {
      return this.module._physics_isCarSlotActive(slot) === 1;
    }
    return (this.getActiveCarMask() & (1 << slot)) !== 0;
  }

  public getActiveCarCount(): number {
    if (typeof this.module?._physics_getActiveCarCount === 'function') {
      return this.module._physics_getActiveCarCount();
    }
    let m = this.getActiveCarMask();
    let c = 0;
    while (m) { c += m & 1; m >>= 1; }
    return c;
  }

  public setCarHitbox(carIndex: number, hitboxType: string | number): boolean {
    const hitboxIdx = getHitboxIndex(hitboxType);
    const ok = this.module?._physics_setCarHitbox?.(carIndex, hitboxIdx) === 1;
    if (ok && this._carSpecs[carIndex]) this._carSpecs[carIndex]!.hitboxIndex = hitboxIdx;
    return ok;
  }

  public setCarTeam(carIndex: number, team: number): boolean {
    const slot = Number(carIndex) | 0;
    const normalizedTeam = team ? 1 : 0;
    const spec = this._carSpecs[slot];
    if (spec && spec.team === normalizedTeam) return true;
    const hitboxIdx = spec?.hitboxIndex ?? 0;
    const ok = setCarTeamInWasm(this.module as any, slot, normalizedTeam, hitboxIdx, this);
    if (ok && slot >= 0 && slot < 8) {
      this._carSpecs[slot] = { team: normalizedTeam, hitboxIndex: hitboxIdx, threeWheels: spec?.threeWheels ?? false };
    }
    return ok;
  }

  public demolishCar(carIndex: number, respawnDelay = 3.0): boolean { return this.module?._physics_demolishCar?.(carIndex, respawnDelay) === 1; }
  public respawnCar(carIndex: number, seed = -1, boostAmount = 33.33): boolean {
    const effectiveSeed = (typeof seed === 'number' && seed >= 0)
      ? (seed | 0)
      : (((Math.floor(this.state?.[0] || 0) + ((carIndex | 0) + 1) * 17) & 0x7fffffff) | 0);
    return this.module?._physics_respawnCar?.(carIndex, effectiveSeed, boostAmount) === 1;
  }

  public getCarIsJumping(carIndex = 0): boolean {
    return typeof this.module?._physics_getCarIsJumping === 'function' ? this.module._physics_getCarIsJumping(carIndex) === 1 : this.getCarStateView(carIndex).isJumping;
  }
  public getCarAirTime(carIndex = 0): number {
    return typeof this.module?._physics_getCarAirTime === 'function' ? this.module._physics_getCarAirTime(carIndex) : this.getCarStateView(carIndex).airTime;
  }
  public getCarJumpTime(carIndex = 0): number {
    return typeof this.module?._physics_getCarJumpTime === 'function' ? this.module._physics_getCarJumpTime(carIndex) : this.getCarStateView(carIndex).jumpTime;
  }
  public getCarAirTimeSinceJump(carIndex = 0): number {
    return typeof this.module?._physics_getCarAirTimeSinceJump === 'function' ? this.module._physics_getCarAirTimeSinceJump(carIndex) : this.getCarStateView(carIndex).airTimeSinceJump;
  }
  public resetKickoffAtSpawn(spawnIndex = 0, settleTicks = 30): boolean {
    if (this.controlsView) this.controlsView.fill(0);
    const ok = this.module?._physics_resetKickoffAtSpawn?.(spawnIndex, settleTicks) === 1;
    this.ballStateWriteRevision = (this.ballStateWriteRevision + 1) | 0;
    this.clearEvents();
    return ok;
  }
  public setCarLinearFactorAndGravity(carIndex: number, fx = 1.0, fy = 1.0, fz = 1.0, gravityScale = 1.0): boolean {
    return this.module?._physics_setCarLinearFactorAndGravity?.(carIndex, fx, fy, fz, gravityScale) === 1;
  }
  public setCarCollisionMask(carIndex: number, interactWithBall = true, interactWithCars = true): boolean {
    return this.module?._physics_setCarCollisionMask?.(carIndex, interactWithBall ? 1 : 0, interactWithCars ? 1 : 0) === 1;
  }
  public setCarThreeWheels(carIndex = 0, enabled = true): boolean {
    const ok = this.module?._physics_setCarThreeWheels?.(carIndex, enabled ? 1 : 0) === 1;
    if (ok && this._carSpecs[carIndex]) this._carSpecs[carIndex]!.threeWheels = Boolean(enabled);
    return ok;
  }
  public getCarThreeWheels(carIndex = 0): boolean { return this.module?._physics_getCarThreeWheels?.(carIndex) === 1; }

  public setArenaPreset(presetIndex = 0): void {
    this.arenaPreset = presetIndex === 1 ? 1 : 0;
    this.goalVolumeBox = getGoalVolumeBoxForPreset(this.arenaPreset === 1);
    this.module?._physics_setArenaPreset?.(this.arenaPreset);
    this._syncGoalVolumeBoxToWasm();
  }
  public getArenaPreset(): number { return this.module?._physics_getArenaPreset?.() ?? this.arenaPreset ?? 0; }
  public _syncGoalVolumeBoxToWasm(): void { syncGoalVolumeBoxToWasm(this.module, this.arenaPreset, this.goalVolumeBox); }
  public getGoalVolumeConfig(): GoalVolumeResolvedConfig { return resolveGoalVolumeConfig(this.getArenaPreset(), this.goalVolumeBox); }
  public isBallScored(ballView = this.getBallStateView()): boolean {
    return evaluateBallScored(ballView, this.getArenaPreset(), this.goalVolumeBox, this.goalBarrierMeta);
  }

  public async reloadMeshes(manifestPath = '/arenamesh/manifest.json'): Promise<boolean> {
    const collisionData = await reloadArenaCollisionMeshes(this.module, this.goalBarrierChunks, manifestPath);
    if (!collisionData) return false;
    this.baseCollisionData = collisionData;
    return true;
  }

  public setGoalBarrierChunks(barrierChunks: unknown[] = [], barrierMeta: Record<string, any> | null = null): boolean {
    const nextChunks = Array.isArray(barrierChunks) ? barrierChunks : [];
    const hadChunks = this.goalBarrierChunks.length > 0;
    this.goalBarrierChunks = nextChunks;
    this.goalBarrierMeta = barrierMeta;
    if (!hadChunks && nextChunks.length === 0) return true;
    const baseData = this.baseCollisionData || RocketSimPhysicsEngine.cachedCollisionData;
    if (!this.module || !this.isInitialized || !baseData || baseData.length === 0) return false;
    const currentTick = Math.floor(this.getHeaderView?.()?.tickCount ?? 0);
    const savedSpecs = this._carSpecs.map((spec) => (spec ? { ...spec } : null));
    const savedNumCars = Math.max(savedSpecs.length, this.numCars || 0);
    const savedUnlimited = this.isUnlimitedBoost;
    const savedPreset = this.getArenaPreset();
    const snap = this.saveState();
    this.setArenaPreset(savedPreset);
    if (!applyGoalBarrierChunksToWasmArena(this.module, baseData, this.goalBarrierChunks, this.arenaPreset, this.goalVolumeBox)) return false;
    this.initBallPrediction(5.0);
    this._carSpecs = [];
    for (let i = 0; i < savedNumCars; i++) {
      const spec = savedSpecs[i] || { team: i % 2, hitboxIndex: 0, threeWheels: false };
      this.addCar(spec.team, spec.hitboxIndex);
      if (spec.threeWheels) this.setCarThreeWheels(i, true);
    }
    this.setUnlimitedBoost(savedUnlimited);
    if (snap) this.restoreState(snap);
    if (currentTick > 0) this.state[SIM_OFFSETS.TICK] = currentTick;
    this.stateView = null;
    this.controlsView = null;
    return true;
  }
  public isPointOnGoalBarrier(xUu: number, yUu: number, zUu: number): boolean {
    return checkPointOnGoalBarrier(this.goalBarrierMeta, xUu, yUu, zUu);
  }
  public hasActiveGoalBarrier(yUu = 0): boolean {
    return checkActiveGoalBarrier(this.goalBarrierMeta, yUu);
  }

  public setGoalVolumeBox(
    enabled = true,
    halfWidthX = THROWBACK_GOAL_VOLUME_BOX.halfWidthX,
    minY = THROWBACK_GOAL_VOLUME_BOX.minY,
    maxY = THROWBACK_GOAL_VOLUME_BOX.maxY,
    maxZ = THROWBACK_GOAL_VOLUME_BOX.maxZ
  ): void {
    this.goalVolumeBox = { enabled: Boolean(enabled), halfWidthX, minY, maxY, minZ: 0.0, maxZ };
    this.module?._physics_setGoalVolumeBox?.(enabled ? 1 : 0, halfWidthX, minY, maxY, maxZ);
  }

  public setArenaMutators({ gravityZ = -650.0, boostAccelGround = -1.0, boostAccelAir = -1.0, ballMaxSpeed = -1.0, ballBounciness = -1.0 } = {}): boolean {
    return this.module?._physics_setArenaMutators?.(gravityZ, boostAccelGround, boostAccelAir, ballMaxSpeed, ballBounciness) === 1;
  }
  public getMutatorConfig(): ArenaMutatorConfig { return readWasmMutatorConfig(this.module); }
  public setMutatorConfig(config: Partial<ArenaMutatorConfig> | Float32Array): boolean { return writeWasmMutatorConfig(this.module, config); }
  public resetMutatorConfig(): boolean { return this.module?._physics_resetMutatorConfig?.() === 1; }

  public initReplayBuffer(): void { this.module?._physics_initReplayBuffer?.(); }
  public clearReplayBuffer(): void { this.module?._physics_clearReplayBuffer?.(); }
  public recordReplayFrame(): void { this.module?._physics_recordReplayFrame?.(); }
  public getReplayFrameCount(): number { return this.module?._physics_getReplayFrameCount?.() ?? 0; }
  public setReplayRecordingActive(active = true): void { this.module?._physics_setReplayRecordingActive?.(active ? 1 : 0); }
  public getReplayRecordingActive(): boolean { return (this.module?._physics_getReplayRecordingActive?.() ?? 1) === 1; }
  public getReplayStateStride(): number { return this.module?._physics_getReplayStateStride?.() ?? 1856; }
  public getReplayIncidentCount(): number { return this.module?._physics_getReplayIncidentCount?.() ?? 0; }
  public getReplaySignalCount(): number { return this.module?._physics_getReplaySignalCount?.() ?? 0; }

  public getReplayFrameByOffset(ticksAgo = 0): Float32Array | null {
    return getWasmReplayFrameByOffset(this.module, this.stateLen, ticksAgo);
  }
  public getReplayFrameByIndex(frameIndex = 0): Float32Array | null {
    return getWasmReplayFrameByIndex(this.module, this.stateLen, frameIndex);
  }
  public getReplayControlsByIndex(frameIndex = 0): Uint8Array | null {
    return getWasmReplayControlsByIndex(this.module, frameIndex);
  }

  public getReplayStateTrackBytes(): Uint8Array { return getWasmReplayStateTrackBytes(this.module, this.getReplayFrameCount(), this.getReplayStateStride()); }
  public getReplayIncidentTrackBytes(): Uint8Array { return getWasmReplayIncidentTrackBytes(this.module, this.getReplayIncidentCount()); }
  public getReplaySignalTrackBytes(): Uint8Array { return getWasmReplaySignalTrackBytes(this.module, this.getReplaySignalCount()); }
  public extractWasmReplayTracks(): ExtractedWasmReplayTracks {
    return extractWasmReplayTracks(this.module, this.getReplayFrameCount(), this.getReplayStateStride(), this.getReplayIncidentCount(), this.getReplaySignalCount());
  }

  public configureCars(hitboxType: string | number, isMatch: boolean, defaultPlayerTeam = 0): void {
    const { playerTeam, botTeam } = getTeamAssignment(hitboxType === 'flat');
    if (this.module!._physics_createArena() !== 1) throw new Error('Arena creation failed');
    this._syncGoalVolumeBoxToWasm();
    this.initBallPrediction(5.0);
    this._carSpecs = [];
    this.clearEvents();
    if (this.addCar(isMatch ? playerTeam : defaultPlayerTeam, hitboxType) !== PLAYER_CAR_INDEX) throw new Error('Player creation failed');
    if (isMatch && this.addCar(botTeam, 'octane') !== BOT_CAR_INDEX) throw new Error('Opponent creation failed');
    this.resetKickoff();
  }

  public setControls(carIndex: number, controls: CarControlsInput): void { writeCarControls(this.module as any, this, carIndex, controls); }
  public setCarControls(carIndex: number, controls: CarControlsInput): void { writeCarControls(this.module as any, this, carIndex, controls); }

  public getHeaderView(): ArenaHeaderView {
    if (!this.headerViewInstance) this.headerViewInstance = new ArenaHeaderView();
    return this.headerViewInstance.attach(this.state);
  }

  public get numCars(): number { return this.state ? this.getHeaderView().numCars : 0; }
  public get ballState(): BallStateView { return this.getBallStateView(); }

  public getBallStateView(): BallStateView {
    if (!this.ballStateViewInstance) this.ballStateViewInstance = new BallStateView();
    return this.ballStateViewInstance.attach(this.state);
  }
  public getBallState(): Float32Array { return this.state.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE); }
  public setBallState(ballState: number | ArrayLike<number> | BallStateObjectInput | null | undefined): boolean {
    this._ballTouchedFloorInLastStep = false;
    this.ballStateWriteRevision = (this.ballStateWriteRevision + 1) | 0;
    return applyBallState(this.module as any, this, ballState);
  }

  public getCarStateView(carIndex = 0): CarStateView {
    if (!this.carStateViewInstances[carIndex]) this.carStateViewInstances[carIndex] = new CarStateView();
    return this.carStateViewInstances[carIndex].attachCar(this.state, carIndex);
  }
  public getBoostPadStateView(padIndex = 0): BoostPadStateView {
    if (!this.boostPadStateViewInstances[padIndex]) this.boostPadStateViewInstances[padIndex] = new BoostPadStateView();
    return this.boostPadStateViewInstances[padIndex].attach(this.state, padIndex);
  }
  public getPadStateView(padIndex = 0): BoostPadStateView { return this.getBoostPadStateView(padIndex); }
  public getGameStateView(): GameStateView {
    if (!this.gameStateViewInstance) this.gameStateViewInstance = new GameStateView();
    return this.gameStateViewInstance.attach(this.state);
  }

  public getCarState(carIndex: number): Float32Array {
    const offset = SIM_OFFSETS.CARS + carIndex * CAR_STATE_STRIDE;
    return this.state.subarray(offset, offset + CAR_STATE_STRIDE);
  }
  public setCarState(carIndex: number, carState: number | ArrayLike<number> | CarStateObjectInput | null | undefined): boolean {
    return applyCarState(this.module as any, this, carIndex, carState);
  }
  public getCarConfig(hitboxTypeOrIndex: string | number = 'default'): unknown {
    const idx = getHitboxIndex(hitboxTypeOrIndex);
    return this.module?._physics_getCarConfig?.(idx) ?? null;
  }
  public getPadStates(): Float32Array {
    return this.state.subarray(BOOST_PAD_STATES_OFFSET, BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE);
  }

  public step(ticks = 1): void {
    this.eventDispatcher.stepWithPadEdgeDetection(ticks);
    this._applyAccumulatedPossessionToState();
  }
  public stepSilent(ticks = 1): void {
    this._ballTouchedFloorInLastStep = false;
    this.module!._physics_stepSilent(ticks);
  }
  public saveStateSlot(slot: number): boolean { return this.module!._physics_saveStateSlot(slot) === 1; }
  public restoreStateSlot(slot: number): boolean {
    this._ballTouchedFloorInLastStep = false;
    this.ballStateWriteRevision = (this.ballStateWriteRevision + 1) | 0;
    return this.module!._physics_restoreStateSlot(slot) === 1;
  }
  public getStateSnapshotSize(): number { return this.module!._physics_getStateSnapshotSize(); }
  public _ensureStateBuffer(size: number): void { ensureWasmSnapshotBuffer(this.module as any, this, size); }
  public saveState(targetBuffer: Float32Array | null = null): Float32Array { return saveWasmSnapshotState(this.module as any, this, targetBuffer); }
  public saveCompactState(targetBuffer: Float32Array | null = null): Float32Array { return saveCompactStateSnapshot(this, targetBuffer); }
  public restoreState(buffer: NumericBufferLike | null | undefined, options: RestoreSnapshotOptions = {}): boolean {
    this._ballTouchedFloorInLastStep = false;
    this.ballStateWriteRevision = (this.ballStateWriteRevision + 1) | 0;
    return restoreWasmSnapshotState(this.module as any, this, buffer, options);
  }
  public restoreCompactState(buffer: NumericBufferLike | null | undefined, options: RestoreSnapshotOptions = {}): boolean {
    this._ballTouchedFloorInLastStep = false;
    this.ballStateWriteRevision = (this.ballStateWriteRevision + 1) | 0;
    return restoreWasmSnapshotState(this.module as any, this, buffer, options);
  }

  public resetKickoff(seed = -1, preservePossessionScore = true): void {
    this._ballTouchedFloorInLastStep = false;
    this.ballStateWriteRevision = (this.ballStateWriteRevision + 1) | 0;
    if (this.controlsView) {
      if (this.controlsView.buffer === this.module?.HEAPF32?.buffer) {
        this.controlsView.fill(0);
      } else {
        this.controlsView = null;
      }
    }
    this.possessionTracker.preserveBeforeKickoff(this.module ? this.state : null, preservePossessionScore);
    this.module!._physics_resetKickoff(seed);
    this._applyAccumulatedPossessionToState();
    this.clearEvents();
  }

  public controlBall(carIndex: number, mode: number | string): boolean {
    if (!this.module || !this.isCarSlotActive(carIndex)) return false;
    const cv = this.getCarStateView(carIndex);
    const targetBall = computeFreeplayBallControlState(
      { posX: cv.posX, posY: cv.posY, posZ: cv.posZ, fwdX: cv.fwdX, fwdY: cv.fwdY, fwdZ: cv.fwdZ },
      mode
    );
    return targetBall ? this.setBallState(targetBall) : false;
  }

  public setUnlimitedBoost(unlimited: boolean): void {
    this.isUnlimitedBoost = !!unlimited;
    this.module!._physics_setUnlimitedBoost(unlimited ? 1 : 0);
  }
  public getUnlimitedBoost(): boolean {
    return typeof this.module?._physics_getUnlimitedBoost === 'function' ? this.module._physics_getUnlimitedBoost() === 1 : Boolean(this.isUnlimitedBoost);
  }
  public setCarUnlimitedBoost(carIndex: number, unlimited: boolean): void {
    this.module?._physics_setCarUnlimitedBoost?.(carIndex, unlimited ? 1 : 0);
    if (carIndex === 0) this.isUnlimitedBoost = !!unlimited;
  }
  public getCarUnlimitedBoost(carIndex = 0): boolean {
    return typeof this.module?._physics_getCarUnlimitedBoost === 'function' ? this.module._physics_getCarUnlimitedBoost(carIndex) === 1 : Boolean(this.isUnlimitedBoost);
  }
  public setCarBoostCollectable(carIndex: number, collectable: boolean): void { this.module?._physics_setCarBoostCollectable?.(carIndex, collectable ? 1 : 0); }
  public getCarBoostCollectable(carIndex = 0): boolean {
    return typeof this.module?._physics_getCarBoostCollectable === 'function' ? this.module._physics_getCarBoostCollectable(carIndex) === 1 : true;
  }
  public setCarBoostRecharge(carIndex: number, enabled: boolean, rechargePerSecond = 10.0, rechargeDelay = 0.25): void {
    this.module?._physics_setCarBoostRecharge?.(carIndex, enabled ? 1 : 0, Number(rechargePerSecond), Number(rechargeDelay));
  }
  public getCarBoostRechargeEnabled(carIndex = 0): boolean { return (this.module?._physics_getCarBoostRechargeEnabled?.(carIndex) ?? 0) === 1; }
  public getCarBoostRechargePerSecond(carIndex = 0): number { return this.module?._physics_getCarBoostRechargePerSecond?.(carIndex) ?? 10.0; }
  public getCarBoostRechargeDelay(carIndex = 0): number { return this.module?._physics_getCarBoostRechargeDelay?.(carIndex) ?? 0.25; }
  public setCarMaxFlipCount(carIndex = 0, maxFlipCount = 1): boolean { return (this.module?._physics_setCarMaxFlipCount?.(carIndex, Math.trunc(maxFlipCount)) ?? 0) === 1; }
  public getCarMaxFlipCount(carIndex = 0): number { return this.module?._physics_getCarMaxFlipCount?.(carIndex) ?? 1; }
  public setCarFlipTimerMode(carIndex = 0, mode = 0): boolean { return (this.module?._physics_setCarFlipTimerMode?.(carIndex, mode ? 1 : 0) ?? 0) === 1; }
  public getCarFlipTimerMode(carIndex = 0): number { return this.module?._physics_getCarFlipTimerMode?.(carIndex) ?? 0; }
  public setCarDemoSpawnSelection(carIndex = 0, slotIndex = -1): boolean { return (this.module?._physics_setCarDemoSpawnSelection?.(carIndex, Math.trunc(slotIndex)) ?? 0) === 1; }
  public getCarDemoSpawnSelection(carIndex = 0): number { return this.module?._physics_getCarDemoSpawnSelection?.(carIndex) ?? this.getCarStateView(carIndex).demoSpawnSelection; }
  public getCarDemoRespawnTimer(carIndex = 0): number { return this.module?._physics_getCarDemoRespawnTimer?.(carIndex) ?? this.getCarStateView(carIndex).demoRespawnTimer; }
  public getCarFlipsRemaining(carIndex = 0): number { return this.module?._physics_getCarFlipsRemaining?.(carIndex) ?? this.getCarStateView(carIndex).flipsRemaining; }
  public getCarFlipWindowTimer(carIndex = 0): number { return this.module?._physics_getCarFlipWindowTimer?.(carIndex) ?? this.getCarStateView(carIndex).flipRemainingSeconds; }

  public pollGoal(): number {
    const goalFlag = this.getHeaderView().goalScoredFlag;
    if (goalFlag !== 0) this.module!._physics_clearGoalFlag();
    return goalFlag;
  }

  public get ballRadius(): number { return this.module!._physics_getBallRadius(); }
  public get ballOnGround(): boolean { return this.module!._physics_getBallOnGround() === 1 || Boolean(this._ballTouchedFloorInLastStep); }
  public getBallOnGround(): boolean { return this.ballOnGround; }
  public getPads(): ArenaBoostPadDescriptor[] { return readArenaPads(this.module as any, this); }

  public destroy(): void {
    if (this.wasmStatePtr && this.module && typeof this.module._free === 'function') {
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
    this.gameStateViewInstance = null;
    this.ballStateViewInstance = null;
    this.carStateViewInstances = [];
    this.boostPadStateViewInstances = [];
  }
}

export default RocketSimPhysicsEngine;
