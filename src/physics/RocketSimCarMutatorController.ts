/**
 * RocketSimCarMutatorController.ts
 * Self-contained domain module (Mode 2) managing per-car roster specs, three-wheel mode,
 * arena mutator config, and demo respawn timers without host penetration.
 */

import type { RocketSimWasmModule } from './RocketSimWasm.ts';
import type { CarStateView } from './RocketSimStateViews.ts';
import type { CarSpecEntry } from './goalBarrierVolumePipeline.ts';
import { getHitboxIndex } from './RocketSimMeshLoader.ts';
import {
  setCarTeamInWasm,
  type RocketSimSnapshotMemoryViews,
} from './RocketSimEntityStateMutator.ts';
import {
  readWasmMutatorConfig,
  writeWasmMutatorConfig,
  type ArenaMutatorConfig,
} from './mutatorConfigPipeline.ts';

export interface CarMutatorSimContext extends RocketSimSnapshotMemoryViews {
  readonly module: RocketSimWasmModule | null;
  readonly numCars: number;
  isUnlimitedBoost: boolean;
  getCarStateView(carIndex?: number): CarStateView;
  getCurrentTick(): number;
}

export class RocketSimCarMutatorController {
  public isUnlimitedBoost = false;
  public carSpecs: Array<CarSpecEntry | null> = [];
  private simCtx: CarMutatorSimContext | null = null;

  public bindSimContext(ctx: CarMutatorSimContext | null): void {
    this.simCtx = ctx;
  }

  private get mod(): RocketSimWasmModule | null {
    return this.simCtx?.module ?? null;
  }

  private _recordAddedCar(idx: number, team: number, hitboxIdx: number): number {
    if (idx >= 0) {
      const isThreeWheels = hitboxIdx === 6;
      this.carSpecs[idx] = {
        team: team ? 1 : 0,
        hitboxIndex: hitboxIdx,
        threeWheels: isThreeWheels,
      };
      if (isThreeWheels) this.setCarThreeWheels(idx, true);
    }
    return idx;
  }

  public addCar(team: number, hitboxType: string | number = 'octane'): number {
    const mod = this.mod;
    if (!mod) return -1;
    const hitboxIdx = getHitboxIndex(hitboxType);
    return this._recordAddedCar(mod._physics_addCar(team, hitboxIdx), team, hitboxIdx);
  }

  public addCarAtSlot(
    carIndex: number,
    team: number,
    hitboxType: string | number = 'octane'
  ): number {
    const slot = Number(carIndex) | 0;
    if (slot < 0 || slot >= 8) return -1;
    const hitboxIdx = getHitboxIndex(hitboxType);
    if (this.isCarSlotActive(slot)) {
      const prevSpec = this.carSpecs[slot];
      const nextTeam = team ? 1 : 0;
      if (!prevSpec || prevSpec.team !== nextTeam) this.setCarTeam(slot, nextTeam);
      if (!prevSpec || prevSpec.hitboxIndex !== hitboxIdx) this.setCarHitbox(slot, hitboxType);
      this.carSpecs[slot] = {
        team: nextTeam,
        hitboxIndex: hitboxIdx,
        threeWheels: hitboxIdx === 6 || (prevSpec?.threeWheels ?? false),
      };
      return slot;
    }
    if (typeof this.mod?._physics_addCarAtSlot === 'function') {
      return this._recordAddedCar(
        this.mod._physics_addCarAtSlot(slot, team, hitboxIdx),
        team,
        hitboxIdx
      );
    }
    return this.addCar(team, hitboxType);
  }

  public removeCar(carIndex: number): boolean {
    const slot = Number(carIndex) | 0;
    const ok = this.mod?._physics_removeCar?.(slot) === 1;
    if (ok && slot >= 0 && slot < 8) this.carSpecs[slot] = null;
    return ok;
  }

  public getActiveCarMask(): number {
    if (typeof this.mod?._physics_getActiveCarMask === 'function') {
      return this.mod._physics_getActiveCarMask() & 0xff;
    }
    let mask = 0;
    const n = Math.min(8, this.simCtx?.numCars || 0);
    for (let i = 0; i < n; i++) {
      if (this.carSpecs[i] !== null) mask |= 1 << i;
    }
    return mask;
  }

  public isCarSlotActive(carIndex: number): boolean {
    const slot = Number(carIndex) | 0;
    if (slot < 0 || slot >= 8) return false;
    if (typeof this.mod?._physics_isCarSlotActive === 'function') {
      return this.mod._physics_isCarSlotActive(slot) === 1;
    }
    return (this.getActiveCarMask() & (1 << slot)) !== 0;
  }

  public setCarHitbox(carIndex: number, hitboxType: string | number): boolean {
    const hitboxIdx = getHitboxIndex(hitboxType);
    const isThreeWheels = hitboxIdx === 6;
    const ok = this.mod?._physics_setCarHitbox?.(carIndex, hitboxIdx) === 1;
    if (ok && this.carSpecs[carIndex]) {
      this.carSpecs[carIndex]!.hitboxIndex = hitboxIdx;
      this.carSpecs[carIndex]!.threeWheels = isThreeWheels;
    }
    this.setCarThreeWheels(carIndex, isThreeWheels);
    return ok;
  }

  public setCarTeam(carIndex: number, team: number): boolean {
    const ctx = this.simCtx;
    if (!ctx) return false;
    const slot = Number(carIndex) | 0;
    const normalizedTeam = team ? 1 : 0;
    const spec = this.carSpecs[slot];
    if (spec && spec.team === normalizedTeam) return true;
    const hitboxIdx = spec?.hitboxIndex ?? 0;
    const ok = setCarTeamInWasm(ctx.module, slot, normalizedTeam, hitboxIdx, ctx);
    if (ok && slot >= 0 && slot < 8) {
      this.carSpecs[slot] = {
        team: normalizedTeam,
        hitboxIndex: hitboxIdx,
        threeWheels: spec?.threeWheels ?? false,
      };
    }
    return ok;
  }

  public setCarThreeWheels(carIndex = 0, enabled = true): boolean {
    const ok = this.mod?._physics_setCarThreeWheels?.(carIndex, enabled ? 1 : 0) === 1;
    if (ok && this.carSpecs[carIndex]) {
      this.carSpecs[carIndex]!.threeWheels = Boolean(enabled);
    }
    return ok;
  }

  public getCarThreeWheels(carIndex = 0): boolean {
    return this.mod?._physics_getCarThreeWheels?.(carIndex) === 1;
  }

  public setArenaMutators({
    gravityZ = -650.0,
    boostAccelGround = -1.0,
    boostAccelAir = -1.0,
    ballMaxSpeed = -1.0,
    ballBounciness = -1.0,
  } = {}): boolean {
    return (
      this.mod?._physics_setArenaMutators?.(
        gravityZ,
        boostAccelGround,
        boostAccelAir,
        ballMaxSpeed,
        ballBounciness
      ) === 1
    );
  }

  public getMutatorConfig(): ArenaMutatorConfig {
    return readWasmMutatorConfig(this.mod);
  }
  public setMutatorConfig(config: Partial<ArenaMutatorConfig> | Float32Array): boolean {
    return writeWasmMutatorConfig(this.mod, config);
  }
  public resetMutatorConfig(): boolean {
    return this.mod?._physics_resetMutatorConfig?.() === 1;
  }

  public respawnCar(carIndex: number, seed = -1, boostAmount = 33.33): boolean {
    const ctx = this.simCtx;
    if (!ctx?.module) return false;
    const effectiveSeed =
      typeof seed === 'number' && seed >= 0
        ? seed | 0
        : ((ctx.getCurrentTick() + ((carIndex | 0) + 1) * 17) & 0x7fffffff) | 0;
    return ctx.module._physics_respawnCar?.(carIndex, effectiveSeed, boostAmount) === 1;
  }

  public setCarDemoSpawnSelection(carIndex = 0, slotIndex = -1): boolean {
    return (
      (this.mod?._physics_setCarDemoSpawnSelection?.(carIndex, Math.trunc(slotIndex)) ?? 0) === 1
    );
  }

  public getCarDemoSpawnSelection(carIndex = 0): number {
    return (
      this.mod?._physics_getCarDemoSpawnSelection?.(carIndex) ??
      this.simCtx?.getCarStateView(carIndex).demoSpawnSelection ??
      -1
    );
  }

  public getCarDemoRespawnTimer(carIndex = 0): number {
    return (
      this.mod?._physics_getCarDemoRespawnTimer?.(carIndex) ??
      this.simCtx?.getCarStateView(carIndex).demoRespawnTimer ??
      0
    );
  }
}
