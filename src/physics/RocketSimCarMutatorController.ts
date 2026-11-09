/**
 * RocketSimCarMutatorController.ts
 * Stateful Sub-Controller managing per-car three-wheel mode, linear factor & gravity scale,
 * collision masks, unlimited boost, boost recharge rates, flip limits, and demo respawn timers.
 */

import type { RocketSimWasmModule } from './RocketSimWasm.ts';
import type { CarStateView } from './RocketSimStateViews.ts';
import type { CarSpecEntry } from './goalBarrierVolumePipeline.ts';
import { getHitboxIndex } from './RocketSimMeshLoader.ts';
import { computeFreeplayBallControlState } from './ballPredictionPipeline.ts';
import {
  setCarTeamInWasm,
  type RocketSimSnapshotMemoryViews,
  type BallStateObjectInput,
} from './RocketSimEntityStateMutator.ts';
import {
  readWasmMutatorConfig,
  writeWasmMutatorConfig,
  type ArenaMutatorConfig,
} from './mutatorConfigPipeline.ts';

export interface CarMutatorEngineHostPort extends RocketSimSnapshotMemoryViews {
  readonly module: RocketSimWasmModule | null;
  readonly numCars: number;
  readonly _carSpecs: Array<CarSpecEntry | null>;
  isUnlimitedBoost: boolean;
  getCarStateView(carIndex?: number): CarStateView;
  setBallState(ballState: BallStateObjectInput): boolean;
  getCurrentTick(): number;
}

export class RocketSimCarMutatorController {
  public isUnlimitedBoost = false;
  private readonly host: CarMutatorEngineHostPort;

  constructor(host: CarMutatorEngineHostPort) {
    this.host = host;
  }

  public controlBall(carIndex: number, mode: number | string): boolean {
    if (!this.host.module || !this.isCarSlotActive(carIndex)) return false;
    const cv = this.host.getCarStateView(carIndex);
    const target = computeFreeplayBallControlState(
      { posX: cv.posX, posY: cv.posY, posZ: cv.posZ, fwdX: cv.fwdX, fwdY: cv.fwdY, fwdZ: cv.fwdZ },
      mode
    );
    return target ? this.host.setBallState(target) : false;
  }

  public addCar(team: number, hitboxType: string | number = 'octane'): number {
    const hitboxIdx = getHitboxIndex(hitboxType);
    const isThreeWheels = hitboxIdx === 6;
    const idx = this.host.module!._physics_addCar(team, hitboxIdx);
    if (idx >= 0) {
      this.host._carSpecs[idx] = {
        team: team ? 1 : 0,
        hitboxIndex: hitboxIdx,
        threeWheels: isThreeWheels,
      };
      if (isThreeWheels) {
        this.setCarThreeWheels(idx, true);
      }
    }
    return idx;
  }

  public addCarAtSlot(
    carIndex: number,
    team: number,
    hitboxType: string | number = 'octane'
  ): number {
    const slot = Number(carIndex) | 0;
    if (slot < 0 || slot >= 8) return -1;
    const hitboxIdx = getHitboxIndex(hitboxType);
    const isThreeWheels = hitboxIdx === 6;
    if (this.isCarSlotActive(slot)) {
      const prevSpec = this.host._carSpecs[slot];
      const nextTeam = team ? 1 : 0;
      if (!prevSpec || prevSpec.team !== nextTeam) this.setCarTeam(slot, nextTeam);
      if (!prevSpec || prevSpec.hitboxIndex !== hitboxIdx) this.setCarHitbox(slot, hitboxType);
      this.host._carSpecs[slot] = {
        team: nextTeam,
        hitboxIndex: hitboxIdx,
        threeWheels: isThreeWheels || (prevSpec?.threeWheels ?? false),
      };
      return slot;
    }
    if (typeof this.host.module?._physics_addCarAtSlot === 'function') {
      const idx = this.host.module._physics_addCarAtSlot(slot, team, hitboxIdx);
      if (idx >= 0) {
        this.host._carSpecs[idx] = {
          team: team ? 1 : 0,
          hitboxIndex: hitboxIdx,
          threeWheels: isThreeWheels,
        };
        if (isThreeWheels) {
          this.setCarThreeWheels(idx, true);
        }
      }
      return idx;
    }
    return this.addCar(team, hitboxType);
  }

  public removeCar(carIndex: number): boolean {
    const slot = Number(carIndex) | 0;
    const ok = this.host.module?._physics_removeCar?.(slot) === 1;
    if (ok && slot >= 0 && slot < 8) this.host._carSpecs[slot] = null;
    return ok;
  }

  public getActiveCarMask(): number {
    if (typeof this.host.module?._physics_getActiveCarMask === 'function') {
      return this.host.module._physics_getActiveCarMask() & 0xff;
    }
    let mask = 0;
    const n = Math.min(8, this.host.numCars || 0);
    for (let i = 0; i < n; i++) {
      if (this.host._carSpecs[i] !== null) mask |= 1 << i;
    }
    return mask;
  }

  public isCarSlotActive(carIndex: number): boolean {
    const slot = Number(carIndex) | 0;
    if (slot < 0 || slot >= 8) return false;
    if (typeof this.host.module?._physics_isCarSlotActive === 'function') {
      return this.host.module._physics_isCarSlotActive(slot) === 1;
    }
    return (this.getActiveCarMask() & (1 << slot)) !== 0;
  }

  public setCarHitbox(carIndex: number, hitboxType: string | number): boolean {
    const hitboxIdx = getHitboxIndex(hitboxType);
    const isThreeWheels = hitboxIdx === 6;
    const ok = this.host.module?._physics_setCarHitbox?.(carIndex, hitboxIdx) === 1;
    if (ok && this.host._carSpecs[carIndex]) {
      this.host._carSpecs[carIndex]!.hitboxIndex = hitboxIdx;
      this.host._carSpecs[carIndex]!.threeWheels = isThreeWheels;
    }
    this.setCarThreeWheels(carIndex, isThreeWheels);
    return ok;
  }

  public setCarTeam(carIndex: number, team: number): boolean {
    const slot = Number(carIndex) | 0;
    const normalizedTeam = team ? 1 : 0;
    const spec = this.host._carSpecs[slot];
    if (spec && spec.team === normalizedTeam) return true;
    const hitboxIdx = spec?.hitboxIndex ?? 0;
    const ok = setCarTeamInWasm(this.host.module, slot, normalizedTeam, hitboxIdx, this.host);
    if (ok && slot >= 0 && slot < 8) {
      this.host._carSpecs[slot] = {
        team: normalizedTeam,
        hitboxIndex: hitboxIdx,
        threeWheels: spec?.threeWheels ?? false,
      };
    }
    return ok;
  }

  public setArenaMutators({
    gravityZ = -650.0,
    boostAccelGround = -1.0,
    boostAccelAir = -1.0,
    ballMaxSpeed = -1.0,
    ballBounciness = -1.0,
  } = {}): boolean {
    return (
      this.host.module?._physics_setArenaMutators?.(
        gravityZ,
        boostAccelGround,
        boostAccelAir,
        ballMaxSpeed,
        ballBounciness
      ) === 1
    );
  }

  public getMutatorConfig(): ArenaMutatorConfig {
    return readWasmMutatorConfig(this.host.module);
  }

  public setMutatorConfig(config: Partial<ArenaMutatorConfig> | Float32Array): boolean {
    return writeWasmMutatorConfig(this.host.module, config);
  }

  public resetMutatorConfig(): boolean {
    return this.host.module?._physics_resetMutatorConfig?.() === 1;
  }

  public demolishCar(carIndex: number, respawnDelay = 3.0): boolean {
    return this.host.module?._physics_demolishCar?.(carIndex, respawnDelay) === 1;
  }

  public respawnCar(carIndex: number, seed = -1, boostAmount = 33.33): boolean {
    const effectiveSeed =
      typeof seed === 'number' && seed >= 0
        ? seed | 0
        : ((this.host.getCurrentTick() + ((carIndex | 0) + 1) * 17) & 0x7fffffff) | 0;
    return this.host.module?._physics_respawnCar?.(carIndex, effectiveSeed, boostAmount) === 1;
  }

  public getCarIsJumping(carIndex = 0): boolean {
    const mod = this.host.module;
    return typeof mod?._physics_getCarIsJumping === 'function'
      ? mod._physics_getCarIsJumping(carIndex) === 1
      : this.host.getCarStateView(carIndex).isJumping;
  }

  public getCarAirTime(carIndex = 0): number {
    const mod = this.host.module;
    return typeof mod?._physics_getCarAirTime === 'function'
      ? mod._physics_getCarAirTime(carIndex)
      : this.host.getCarStateView(carIndex).airTime;
  }

  public getCarJumpTime(carIndex = 0): number {
    const mod = this.host.module;
    return typeof mod?._physics_getCarJumpTime === 'function'
      ? mod._physics_getCarJumpTime(carIndex)
      : this.host.getCarStateView(carIndex).jumpTime;
  }

  public getCarAirTimeSinceJump(carIndex = 0): number {
    const mod = this.host.module;
    return typeof mod?._physics_getCarAirTimeSinceJump === 'function'
      ? mod._physics_getCarAirTimeSinceJump(carIndex)
      : this.host.getCarStateView(carIndex).airTimeSinceJump;
  }

  public setCarLinearFactorAndGravity(
    carIndex: number,
    fx = 1.0,
    fy = 1.0,
    fz = 1.0,
    gravityScale = 1.0
  ): boolean {
    return (
      this.host.module?._physics_setCarLinearFactorAndGravity?.(
        carIndex,
        fx,
        fy,
        fz,
        gravityScale
      ) === 1
    );
  }

  public setCarCollisionMask(
    carIndex: number,
    interactWithBall = true,
    interactWithCars = true
  ): boolean {
    return (
      this.host.module?._physics_setCarCollisionMask?.(
        carIndex,
        interactWithBall ? 1 : 0,
        interactWithCars ? 1 : 0
      ) === 1
    );
  }

  public setCarThreeWheels(carIndex = 0, enabled = true): boolean {
    const ok = this.host.module?._physics_setCarThreeWheels?.(carIndex, enabled ? 1 : 0) === 1;
    if (ok && this.host._carSpecs[carIndex]) {
      this.host._carSpecs[carIndex]!.threeWheels = Boolean(enabled);
    }
    return ok;
  }

  public getCarThreeWheels(carIndex = 0): boolean {
    return this.host.module?._physics_getCarThreeWheels?.(carIndex) === 1;
  }

  public setUnlimitedBoost(unlimited: boolean): void {
    const flag = Boolean(unlimited);
    this.isUnlimitedBoost = flag;
    this.host.isUnlimitedBoost = flag;
    this.host.module?._physics_setUnlimitedBoost?.(flag ? 1 : 0);
  }

  public getUnlimitedBoost(): boolean {
    const mod = this.host.module;
    return typeof mod?._physics_getUnlimitedBoost === 'function'
      ? mod._physics_getUnlimitedBoost() === 1
      : Boolean(this.isUnlimitedBoost);
  }

  public setCarUnlimitedBoost(carIndex: number, unlimited: boolean): void {
    const flag = Boolean(unlimited);
    this.host.module?._physics_setCarUnlimitedBoost?.(carIndex, flag ? 1 : 0);
    if (carIndex === 0) {
      this.isUnlimitedBoost = flag;
      this.host.isUnlimitedBoost = flag;
    }
  }

  public getCarUnlimitedBoost(carIndex = 0): boolean {
    const mod = this.host.module;
    return typeof mod?._physics_getCarUnlimitedBoost === 'function'
      ? mod._physics_getCarUnlimitedBoost(carIndex) === 1
      : Boolean(this.isUnlimitedBoost);
  }

  public setCarBoostCollectable(carIndex: number, collectable: boolean): void {
    this.host.module?._physics_setCarBoostCollectable?.(carIndex, collectable ? 1 : 0);
  }

  public getCarBoostCollectable(carIndex = 0): boolean {
    const mod = this.host.module;
    return typeof mod?._physics_getCarBoostCollectable === 'function'
      ? mod._physics_getCarBoostCollectable(carIndex) === 1
      : true;
  }

  public setCarBoostRecharge(
    carIndex: number,
    enabled: boolean,
    rechargePerSecond = 10.0,
    rechargeDelay = 0.25
  ): void {
    this.host.module?._physics_setCarBoostRecharge?.(
      carIndex,
      enabled ? 1 : 0,
      Number(rechargePerSecond),
      Number(rechargeDelay)
    );
  }

  public getCarBoostRechargeEnabled(carIndex = 0): boolean {
    return (this.host.module?._physics_getCarBoostRechargeEnabled?.(carIndex) ?? 0) === 1;
  }

  public getCarBoostRechargePerSecond(carIndex = 0): number {
    return this.host.module?._physics_getCarBoostRechargePerSecond?.(carIndex) ?? 10.0;
  }

  public getCarBoostRechargeDelay(carIndex = 0): number {
    return this.host.module?._physics_getCarBoostRechargeDelay?.(carIndex) ?? 0.25;
  }

  public setCarMaxFlipCount(carIndex = 0, maxFlipCount = 1): boolean {
    return (
      (this.host.module?._physics_setCarMaxFlipCount?.(carIndex, Math.trunc(maxFlipCount)) ?? 0) ===
      1
    );
  }

  public getCarMaxFlipCount(carIndex = 0): number {
    return this.host.module?._physics_getCarMaxFlipCount?.(carIndex) ?? 1;
  }

  public getCarMutatorSummary(carIndex = 0) {
    return {
      unlimitedBoost: this.getCarUnlimitedBoost(carIndex),
      boostCollectable: this.getCarBoostCollectable(carIndex),
      rechargeEnabled: this.getCarBoostRechargeEnabled(carIndex),
      rechargePerSecond: this.getCarBoostRechargePerSecond(carIndex),
      rechargeDelay: this.getCarBoostRechargeDelay(carIndex),
      maxFlipCount: this.getCarMaxFlipCount(carIndex),
    };
  }

  public setCarFlipTimerMode(carIndex = 0, mode = 0): boolean {
    return (this.host.module?._physics_setCarFlipTimerMode?.(carIndex, mode ? 1 : 0) ?? 0) === 1;
  }

  public getCarFlipTimerMode(carIndex = 0): number {
    return this.host.module?._physics_getCarFlipTimerMode?.(carIndex) ?? 0;
  }

  public setCarDemoSpawnSelection(carIndex = 0, slotIndex = -1): boolean {
    return (
      (this.host.module?._physics_setCarDemoSpawnSelection?.(carIndex, Math.trunc(slotIndex)) ??
        0) === 1
    );
  }

  public getCarDemoSpawnSelection(carIndex = 0): number {
    return (
      this.host.module?._physics_getCarDemoSpawnSelection?.(carIndex) ??
      this.host.getCarStateView(carIndex).demoSpawnSelection
    );
  }

  public getCarDemoRespawnTimer(carIndex = 0): number {
    return (
      this.host.module?._physics_getCarDemoRespawnTimer?.(carIndex) ??
      this.host.getCarStateView(carIndex).demoRespawnTimer
    );
  }

  public getCarFlipsRemaining(carIndex = 0): number {
    return (
      this.host.module?._physics_getCarFlipsRemaining?.(carIndex) ??
      this.host.getCarStateView(carIndex).flipsRemaining
    );
  }

  public getCarFlipWindowTimer(carIndex = 0): number {
    return (
      this.host.module?._physics_getCarFlipWindowTimer?.(carIndex) ??
      this.host.getCarStateView(carIndex).flipRemainingSeconds
    );
  }
}
