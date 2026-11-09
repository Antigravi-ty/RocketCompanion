/**
 * RocketSimArenaBarrierController.ts
 * Stateful Sub-Controller managing arena initialization, preset switching, kickoff resets,
 * goal volume box synchronization, dynamic goal barrier collision mesh reloading, and scoring checks.
 */

import {
  loadRocketSimWasmModule,
  type RocketSimWasmModule,
  type RocketSimWasmModuleOptions,
} from './RocketSimWasm.ts';
import {
  PLAYER_CAR_INDEX,
  BOT_CAR_INDEX,
  getTeamAssignment,
  fetchArenaCollisionMeshes,
  initWasmCollisionMeshes,
} from './RocketSimMeshLoader.ts';
import {
  SIM_OFFSETS,
  EVENT_TOTAL_BUFFER_BYTES,
  THROWBACK_GOAL_VOLUME_BOX,
} from './RocketSimConstants.ts';
import { initWasmBallPrediction } from './ballPredictionPipeline.ts';
import { PhysicsEventReader } from './PhysicsEventReader.ts';
import {
  getGoalVolumeBoxForPreset,
  registerGoalVolumeTunerApplier,
} from '../ui-core/config/goalVolumeTunerConfig.ts';
import {
  syncGoalVolumeBoxToWasm,
  resolveGoalVolumeConfig,
  checkActiveGoalBarrier,
  checkPointOnGoalBarrier,
  evaluateBallScored,
  reloadArenaCollisionMeshes,
  applyGoalBarrierChunksToWasmArena,
  type GoalVolumeBoxConfig,
  type GoalVolumeResolvedConfig,
  type GoalBarrierMetadata,
  type CarSpecEntry,
} from './goalBarrierVolumePipeline.ts';

export type { GoalVolumeBoxConfig, GoalVolumeResolvedConfig, GoalBarrierMetadata, CarSpecEntry };

export interface ArenaEngineBootstrapOptions extends RocketSimWasmModuleOptions {
  collisionData?: Uint8Array[] | null;
}

export interface ArenaBarrierEngineTarget {
  module: RocketSimWasmModule | null;
  isInitialized: boolean;
  statePtr: number;
  stateLen: number;
  controlsPtr: number;
  eventBufferPtr: number;
  eventBufferSize: number;
  eventReader: PhysicsEventReader | null;
  stateView: Float32Array | null;
  controlsView: Float32Array | null;
  syntheticFallback: { reset?: () => void } | null;
  readonly state: Float32Array;
  readonly numCars: number;
  readonly isUnlimitedBoost: boolean;
  _carSpecs: Array<CarSpecEntry | null>;
  arenaPreset: number;
  ballStateWriteRevision: number;
  readonly eventDispatcher: { resetFloorTouchLatch(): void };
  readonly possessionTracker: {
    preserveBeforeKickoff(state: Float32Array | null, preserveScore: boolean): void;
    applyAccumulatedPossessionToState(
      mod: RocketSimWasmModule | null,
      state: Float32Array | null
    ): void;
  };
  getCachedCollisionData(): Uint8Array[] | null;
  setCachedCollisionData(data: Uint8Array[] | null): void;
  getCurrentTick(): number;
  addCar(team: number, hitboxType?: string | number): number;
  setCarThreeWheels(carIndex: number, enabled: boolean): boolean;
  setUnlimitedBoost(unlimited: boolean): void;
  saveState(): Float32Array;
  restoreState(buffer: Float32Array): boolean;
}

export class RocketSimArenaBarrierController {
  public arenaPreset = 0;
  public goalVolumeBox: GoalVolumeBoxConfig = getGoalVolumeBoxForPreset(false);
  public baseCollisionData: Uint8Array[] | null = null;
  public goalBarrierChunks: Uint8Array[] = [];
  public goalBarrierMeta: GoalBarrierMetadata | null = null;

  private readonly engine: ArenaBarrierEngineTarget;

  constructor(engine: ArenaBarrierEngineTarget) {
    this.engine = engine;
    const weakThis = new WeakRef(this);
    registerGoalVolumeTunerApplier(() => {
      const self = weakThis.deref();
      if (!self) return;
      self.goalVolumeBox = getGoalVolumeBoxForPreset(self.arenaPreset === 1);
      self.syncGoalVolumeBoxToWasm();
    });
  }

  public async initEngine(options: ArenaEngineBootstrapOptions = {}): Promise<void> {
    const eng = this.engine;
    if (options.collisionData) eng.setCachedCollisionData(options.collisionData);
    eng.module = await loadRocketSimWasmModule(options);
    eng.isInitialized = true;

    const collisionData = await fetchArenaCollisionMeshes(eng.getCachedCollisionData());
    eng.setCachedCollisionData(collisionData);
    initWasmCollisionMeshes(eng.module, this.getEffectiveCollisionChunks(collisionData));

    if (eng.module._physics_createArena() !== 1) throw new Error('Arena creation failed');
    this.syncGoalVolumeBoxToWasm();
    initWasmBallPrediction(eng.module, 5.0);
    eng._carSpecs = [];

    eng.statePtr = eng.module._physics_getStatePtr();
    eng.stateLen = eng.module._physics_getStateSize();
    eng.controlsPtr = eng.module._physics_getControlsPtr();

    if (typeof eng.module._physics_getEventBufferPtr === 'function') {
      eng.eventBufferPtr = eng.module._physics_getEventBufferPtr();
      eng.eventBufferSize = eng.module._physics_getEventBufferSize?.() ?? EVENT_TOTAL_BUFFER_BYTES;
      eng.eventReader = new PhysicsEventReader(eng.module, eng.eventBufferPtr);
    } else {
      eng.eventReader = null;
    }

    eng.stateView = null;
    eng.controlsView = null;
    eng.module._physics_initReplayBuffer?.();
    if (eng.eventReader && eng.module.HEAPU8?.buffer) {
      eng.eventReader.attach(eng.module, eng.eventBufferPtr);
    }
  }

  public clearEvents(): void {
    const eng = this.engine;
    eng.module?._physics_clearEvents?.();
    if (
      eng.eventReader &&
      eng.module?.HEAPU8?.buffer &&
      eng.eventReader.buffer !== eng.module.HEAPU8.buffer
    ) {
      eng.eventReader.attach(eng.module, eng.eventBufferPtr);
    }
    eng.eventReader?.reset();
    eng.syntheticFallback?.reset?.();
  }

  public configureCars(hitboxType: string | number, isMatch: boolean, defaultPlayerTeam = 0): void {
    const eng = this.engine;
    const { playerTeam, botTeam } = getTeamAssignment(hitboxType === 'flat');
    if (eng.module!._physics_createArena() !== 1) throw new Error('Arena creation failed');
    this.syncGoalVolumeBoxToWasm();
    initWasmBallPrediction(eng.module, 5.0);
    eng._carSpecs = [];
    this.clearEvents();
    if (eng.addCar(isMatch ? playerTeam : defaultPlayerTeam, hitboxType) !== PLAYER_CAR_INDEX) {
      throw new Error('Player creation failed');
    }
    if (isMatch && eng.addCar(botTeam, 'octane') !== BOT_CAR_INDEX) {
      throw new Error('Opponent creation failed');
    }
    this.resetKickoff();
  }

  public resetKickoff(seed = -1, preservePossessionScore = true): void {
    const eng = this.engine;
    eng.eventDispatcher.resetFloorTouchLatch();
    eng.ballStateWriteRevision = (eng.ballStateWriteRevision + 1) | 0;
    if (eng.controlsView) {
      if (eng.controlsView.buffer === eng.module?.HEAPF32?.buffer) eng.controlsView.fill(0);
      else eng.controlsView = null;
    }
    const state = eng.module ? eng.state : null;
    eng.possessionTracker.preserveBeforeKickoff(state, preservePossessionScore);
    eng.module!._physics_resetKickoff(seed);
    eng.possessionTracker.applyAccumulatedPossessionToState(
      eng.module,
      eng.module ? eng.state : null
    );
    this.clearEvents();
  }

  public resetKickoffAtSpawn(spawnIndex = 0, settleTicks = 30): boolean {
    const eng = this.engine;
    if (eng.controlsView) eng.controlsView.fill(0);
    const ok = eng.module?._physics_resetKickoffAtSpawn?.(spawnIndex, settleTicks) === 1;
    eng.ballStateWriteRevision = (eng.ballStateWriteRevision + 1) | 0;
    this.clearEvents();
    return ok;
  }

  public getEffectiveCollisionChunks(collisionData: Uint8Array[]): Uint8Array[] {
    this.baseCollisionData = collisionData;
    return this.goalBarrierChunks.length > 0
      ? [...collisionData, ...this.goalBarrierChunks]
      : collisionData;
  }

  public setArenaPreset(presetIndex = 0): void {
    this.arenaPreset = presetIndex === 1 ? 1 : 0;
    this.engine.arenaPreset = this.arenaPreset;
    this.goalVolumeBox = getGoalVolumeBoxForPreset(this.arenaPreset === 1);
    this.engine.module?._physics_setArenaPreset?.(this.arenaPreset);
    this.syncGoalVolumeBoxToWasm();
  }

  public getArenaPreset(): number {
    const mod = this.engine.module as { _physics_getArenaPreset?: () => number } | null;
    return mod?._physics_getArenaPreset?.() ?? this.arenaPreset ?? 0;
  }

  public syncGoalVolumeBoxToWasm(): void {
    syncGoalVolumeBoxToWasm(this.engine.module, this.arenaPreset, this.goalVolumeBox);
  }

  public getGoalVolumeConfig(): GoalVolumeResolvedConfig {
    return resolveGoalVolumeConfig(this.getArenaPreset(), this.goalVolumeBox);
  }

  public isBallScored(
    ballView: { posX: number; posY: number; posZ: number } | null | undefined
  ): boolean {
    return evaluateBallScored(
      ballView,
      this.getArenaPreset(),
      this.goalVolumeBox,
      this.goalBarrierMeta
    );
  }

  public async reloadMeshes(manifestPath = '/arenamesh/manifest.json'): Promise<boolean> {
    const collisionData = await reloadArenaCollisionMeshes(
      this.engine.module,
      this.goalBarrierChunks,
      manifestPath
    );
    if (!collisionData) return false;
    this.baseCollisionData = collisionData;
    return true;
  }

  public setGoalBarrierChunks(
    barrierChunks: Uint8Array[] = [],
    barrierMeta: GoalBarrierMetadata | null = null
  ): boolean {
    const nextChunks = Array.isArray(barrierChunks) ? barrierChunks : [];
    const hadChunks = this.goalBarrierChunks.length > 0;
    this.goalBarrierChunks = nextChunks;
    this.goalBarrierMeta = barrierMeta;
    if (!hadChunks && nextChunks.length === 0) return true;

    const eng = this.engine;
    const baseData = this.baseCollisionData || eng.getCachedCollisionData();
    if (!eng.module || !eng.isInitialized || !baseData || baseData.length === 0) {
      return false;
    }

    const currentTick = eng.getCurrentTick();
    const savedSpecs = eng._carSpecs.map((spec) => (spec ? { ...spec } : null));
    const savedNumCars = Math.max(savedSpecs.length, eng.numCars || 0);
    const savedUnlimited = eng.isUnlimitedBoost;
    const savedPreset = this.getArenaPreset();
    const snap = eng.saveState();

    this.setArenaPreset(savedPreset);
    if (
      !applyGoalBarrierChunksToWasmArena(
        eng.module,
        baseData,
        this.goalBarrierChunks,
        this.arenaPreset,
        this.goalVolumeBox
      )
    ) {
      return false;
    }

    initWasmBallPrediction(eng.module, 5.0);
    eng._carSpecs = [];
    for (let i = 0; i < savedNumCars; i++) {
      const spec = savedSpecs[i] || { team: i % 2, hitboxIndex: 0, threeWheels: false };
      eng.addCar(spec.team, spec.hitboxIndex);
      if (spec.threeWheels) eng.setCarThreeWheels(i, true);
    }
    eng.setUnlimitedBoost(savedUnlimited);
    if (currentTick > 0) eng.state[SIM_OFFSETS.TICK] = currentTick;
    eng.stateView = null;
    eng.controlsView = null;

    if (snap) eng.restoreState(snap);
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
    this.engine.module?._physics_setGoalVolumeBox?.(enabled ? 1 : 0, halfWidthX, minY, maxY, maxZ);
  }

  public isBallSleeping(bv: { velX: number; velY: number; velZ: number }): boolean {
    const mod = this.engine.module;
    if (typeof mod?._physics_isBallSleeping === 'function')
      return mod._physics_isBallSleeping() !== 0;
    return bv.velX === 0 && bv.velY === 0 && bv.velZ === 0;
  }

  public pollGoal(goalScoredFlag: number): number {
    if (goalScoredFlag !== 0) this.engine.module!._physics_clearGoalFlag();
    return goalScoredFlag;
  }
}
