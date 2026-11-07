import * as THREE from 'three';
import { VehicleBoostEmitter } from '../vehicle/boost/vehicleBoostEmitter.ts';
import { DemolitionEffect } from '../DemolitionEffect.ts';
import { getWheelSpecsForVisual } from '../VehicleSuspensionSystem.ts';
import { normalizeVisualId } from '../../ui-core/config/vehiclePresets';
import { hasVehicleDescriptor } from '../../ui-core/config/vehicleTunerConfig';
import { DEFAULT_TEAM_COLORS, OCTANE_BOOST_OUTLETS } from './ArenaConstants.ts';
import { buildVehicleModel, buildVehicleWheels, removeCarMeshes, createDefaultVehicleLoaders } from './VehicleFactory.ts';
import { applyVehiclePaint } from './VehiclePaint.ts';
import {
  ArenaVehicleLoadoutManager,
  disposeObjectGeometryAndMaterials,
  type CarLoadoutConfig,
  type VehicleWheelRig,
  type VehicleWheelSet,
  type WheelSpecTuple,
} from './ArenaVehicleLoadoutManager.ts';

export type { CarLoadoutConfig, VehicleWheelRig, VehicleWheelSet, WheelSpecTuple };

export interface SuspensionUnitVisual {
  group?: THREE.Group; top?: THREE.Vector3; botZ?: number; spring?: THREE.Object3D;
  built?: number; bodyLen?: number; shaft?: THREE.Object3D; body?: THREE.Object3D;
  innerZ: number; armFore?: THREE.Object3D; foreRoot?: THREE.Object3D | THREE.Vector3;
  armAft?: THREE.Object3D; aftRoot?: THREE.Object3D | THREE.Vector3;
}

export interface VehicleVisualOptions { visual?: string; preset?: string; targetIndex?: number; }
export type VehicleVisualInput = string | VehicleVisualOptions;

export class ArenaVehicleRegistry {
  public scene: THREE.Scene;
  public onRenderTreeChanged?: () => void;
  public onEnsureOpponentSun?: () => void;
  public loadout: ArenaVehicleLoadoutManager;
  public cars: Array<THREE.Group | null>;
  public vehiclePresets: Array<string | null>;
  public carHitboxes: Array<THREE.LineSegments | THREE.Object3D | null>;
  public carHitboxesVisible: boolean;
  public allCarHitboxesVisible: boolean;
  public povCarIndex: number;
  public carSuspension: Array<SuspensionUnitVisual[] | null>;
  public carWheels: Array<VehicleWheelSet | null>;
  public carWheelSpecs: Array<WheelSpecTuple[] | null>;
  public wheelSpin: Array<number[]>;
  public carBoosts: Array<VehicleBoostEmitter[] | null>;
  public carDemolitions: Array<DemolitionEffect | null>;
  public carColors: Array<number | null | undefined>;
  public carPaintFinishes: Array<string | null>;
  public carBoostVisuals: Array<string | null>;
  public carBoostAudios: Array<string | null>;
  public carTeams?: number[];
  public customVehicleAssets: Map<string, unknown>;
  public carLoaders: ReturnType<typeof createDefaultVehicleLoaders>;

  constructor(arenaScene: THREE.Scene, onRenderTreeChanged?: () => void, onEnsureOpponentSun?: () => void) {
    this.scene = arenaScene;
    this.onRenderTreeChanged = onRenderTreeChanged;
    this.onEnsureOpponentSun = onEnsureOpponentSun;

    this.cars = [];
    this.vehiclePresets = [];
    this.carHitboxes = [];
    this.carHitboxesVisible = false;
    this.allCarHitboxesVisible = false;
    this.povCarIndex = 0;
    this.carSuspension = [];
    this.carWheels = [];
    this.carWheelSpecs = [];
    this.wheelSpin = [];
    this.carBoosts = [];
    this.carDemolitions = [];

    this.customVehicleAssets = new Map<string, unknown>();
    this.carLoaders = createDefaultVehicleLoaders();
    this.loadout = new ArenaVehicleLoadoutManager(this);
    this.carColors = this.loadout.carColors;
    this.carPaintFinishes = this.loadout.carPaintFinishes;
    this.carBoostVisuals = this.loadout.carBoostVisuals;
    this.carBoostAudios = this.loadout.carBoostAudios;
  }

  isCarHitboxVisibleForSlot(slot: number): boolean {
    return Boolean(
      this.allCarHitboxesVisible || (this.carHitboxesVisible && slot === this.povCarIndex)
    );
  }

  get assets(): Map<string, unknown> {
    return this.customVehicleAssets;
  }

  setCustomVehicleAsset(vehicleId: string, asset: unknown): void {
    if (vehicleId && asset) {
      this.customVehicleAssets.set(String(vehicleId).toLowerCase(), asset);
    }
  }

  _ensureAsyncCustomAsset(visual: string, slot: number): void {
    const id = normalizeVisualId(visual);
    if (hasVehicleDescriptor(id) && !this.customVehicleAssets.has(id) && this.carLoaders.loadCustomGlbCarAsset) {
      this.carLoaders.loadCustomGlbCarAsset(id).then((asset: unknown) => {
        this.customVehicleAssets.set(id, asset);
        if (this.vehiclePresets[slot] === id) {
          this.swapCarVisual(slot, id);
        }
      }).catch((err: unknown) => console.warn(`Lazy "${id}" asset load failed:`, err));
    }
  }

  addCar(
    teamIndex = 0,
    visualOrOptions: VehicleVisualInput = 'fennec',
    targetIndex: number | null = null
  ): THREE.Group {
    let visual = 'fennec';
    let resolvedTargetIndex = targetIndex;
    if (visualOrOptions && typeof visualOrOptions === 'object') {
      visual = visualOrOptions.visual || visualOrOptions.preset || 'fennec';
      if (typeof visualOrOptions.targetIndex === 'number') {
        resolvedTargetIndex = visualOrOptions.targetIndex;
      }
    } else if (typeof visualOrOptions === 'string' && visualOrOptions.length > 0) {
      visual = visualOrOptions;
    }
    visual = normalizeVisualId(visual);

    const carRoot = new THREE.Group();
    const slot = (typeof resolvedTargetIndex === 'number' && resolvedTargetIndex >= 0)
      ? resolvedTargetIndex
      : this.cars.length;

    while (this.cars.length < slot) {
      const idx = this.cars.length;
      this.cars[idx] = null;
      this.vehiclePresets[idx] = null;
      this.carHitboxes[idx] = null;
      this.carWheels[idx] = null;
      this.carWheelSpecs[idx] = null;
      this.wheelSpin[idx] = [0, 0, 0, 0];
      this.carSuspension[idx] = [];
      this.carBoosts[idx] = null;
      this.carDemolitions[idx] = null;
    }

    if (this.cars[slot]) {
      this.removeCar(slot);
    }

    const isBot = slot !== 0;
    const resolvedTeam = typeof teamIndex === 'number' ? teamIndex : (slot % 2);
    const teamColor = this.carLoaders.teamColors?.[resolvedTeam] ?? DEFAULT_TEAM_COLORS[resolvedTeam % 2];

    this._ensureAsyncCustomAsset(visual, slot);

    const { carModel, carHitbox, boostOutlets } = buildVehicleModel(
      visual, teamColor, isBot, this.assets, this.carLoaders, this.isCarHitboxVisibleForSlot(slot)
    );
    carRoot.add(carModel, carHitbox);

    let wheelSpecs = getWheelSpecsForVisual(visual) as WheelSpecTuple[];
    if (!visual.startsWith('hitbox-') && !hasVehicleDescriptor(visual) && this.carLoaders.wheelSpecs?.game) {
      wheelSpecs = this.carLoaders.wheelSpecs.game as WheelSpecTuple[];
    }

    const wheels = buildVehicleWheels(
      carRoot, visual, teamColor, wheelSpecs, this.assets, this.carLoaders
    ) as VehicleWheelSet;
    const defaultOutlets = OCTANE_BOOST_OUTLETS.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const emitters = (boostOutlets || defaultOutlets).map(
      (pos: THREE.Vector3, p: number) => new VehicleBoostEmitter(this.scene, carRoot, pos, p === 0, isBot)
    );
    const activeBoostVisual = this.carBoostVisuals?.[slot] || null;
    if (activeBoostVisual) {
      for (const emitter of emitters) {
        emitter?.setBoostVisual?.(activeBoostVisual);
      }
    }

    const demoEffect = new DemolitionEffect();
    if (demoEffect.object) this.scene.add(demoEffect.object);

    if (!this.carTeams) this.carTeams = [];
    this.carTeams[slot] = resolvedTeam;
    this.carHitboxes[slot] = carHitbox;
    this.carWheels[slot] = wheels;
    this.carWheelSpecs[slot] = wheelSpecs;
    this.wheelSpin[slot] = [0, 0, 0, 0];
    this.carSuspension[slot] = [];
    this.carBoosts[slot] = emitters;
    this.carDemolitions[slot] = demoEffect;
    this.cars[slot] = carRoot;
    this.vehiclePresets[slot] = visual;

    this.scene.add(carRoot);
    this.loadout.applySlotPaintOrColor(slot, teamColor);
    this.onRenderTreeChanged?.();
    return carRoot;
  }

  ensureCar(
    carIndex: number,
    teamIndex: number | null = null,
    visualOrOptions: VehicleVisualInput = 'fennec'
  ): THREE.Group | null {
    if (typeof carIndex !== 'number' || carIndex < 0) return null;
    const resolvedTeam = typeof teamIndex === 'number' ? teamIndex : (this.carTeams?.[carIndex] ?? (carIndex % 2));
    let visual = 'fennec';
    if (visualOrOptions && typeof visualOrOptions === 'object') {
      visual = visualOrOptions.visual || visualOrOptions.preset || this.vehiclePresets?.[carIndex] || 'fennec';
    } else if (typeof visualOrOptions === 'string' && visualOrOptions.length > 0) {
      visual = visualOrOptions;
    } else if (this.vehiclePresets?.[carIndex]) {
      visual = this.vehiclePresets[carIndex]!;
    }
    visual = normalizeVisualId(visual);

    if (!this.cars[carIndex]) {
      this.addCar(resolvedTeam, visual, carIndex);
    } else {
      if (this.vehiclePresets[carIndex] !== visual) {
        this.swapCarVisual(carIndex, visual);
      }
      if (typeof teamIndex === 'number') {
        this.setCarTeam(carIndex, teamIndex);
      }
    }
    if (this.cars[carIndex]) {
      this.cars[carIndex]!.visible = true;
    }
    return this.cars[carIndex];
  }

  setCarTeam(carIndex: number, teamIndex: number): void {
    if (typeof carIndex !== 'number' || carIndex < 0) return;
    if (!this.carTeams) this.carTeams = [];
    const prevTeam = this.carTeams[carIndex];
    this.carTeams[carIndex] = teamIndex;
    if (prevTeam === teamIndex) return;
    const teamColor = this.carLoaders.teamColors?.[teamIndex] ?? DEFAULT_TEAM_COLORS[teamIndex % 2];
    if (this.cars?.[carIndex] && (this.carColors?.[carIndex] === undefined || this.carColors?.[carIndex] === null)) {
      applyVehiclePaint(this.cars[carIndex], this.vehiclePresets?.[carIndex], teamColor, this.carPaintFinishes?.[carIndex] || null);
      this.onRenderTreeChanged?.();
    }
  }

  swapCarVisual(carIndex: number, newVisual: VehicleVisualInput): boolean {
    if (!this.cars || carIndex < 0 || carIndex >= this.cars.length) return false;
    const carRoot = this.cars[carIndex];
    if (!carRoot) return false;
    const rawVisual = (newVisual && typeof newVisual === 'object')
      ? (newVisual.visual || newVisual.preset || 'fennec')
      : String(newVisual || 'fennec');
    const resolvedVisual = normalizeVisualId(rawVisual);

    const isBot = carIndex !== 0;
    const teamIndex = this.carTeams?.[carIndex] ?? (carIndex % 2);
    const activeCustomColor = this.carColors?.[carIndex];
    const teamColor = (activeCustomColor !== undefined && activeCustomColor !== null)
      ? activeCustomColor
      : (this.carLoaders.teamColors?.[teamIndex] ?? DEFAULT_TEAM_COLORS[teamIndex % 2]);

    this._ensureAsyncCustomAsset(resolvedVisual, carIndex);

    removeCarMeshes(carRoot, true);

    const { carModel, carHitbox, boostOutlets } = buildVehicleModel(
      resolvedVisual, teamColor, isBot, this.assets, this.carLoaders, this.isCarHitboxVisibleForSlot(carIndex)
    );
    carRoot.add(carModel, carHitbox);
    this.carHitboxes[carIndex] = carHitbox;

    let wheelSpecs = getWheelSpecsForVisual(resolvedVisual) as WheelSpecTuple[];
    if (!resolvedVisual.startsWith('hitbox-') && !hasVehicleDescriptor(resolvedVisual) && this.carLoaders.wheelSpecs?.game) {
      wheelSpecs = this.carLoaders.wheelSpecs.game as WheelSpecTuple[];
    }
    this.carWheelSpecs[carIndex] = wheelSpecs;
    this.carWheels[carIndex] = buildVehicleWheels(
      carRoot, resolvedVisual, teamColor, wheelSpecs, this.assets, this.carLoaders
    ) as VehicleWheelSet;

    const emitterList = this.carBoosts[carIndex];
    if (emitterList && boostOutlets) {
      for (let p = 0; p < emitterList.length && p < boostOutlets.length; p++) {
        const outlet = boostOutlets[p];
        emitterList[p]?.setNozzleOffset(outlet.x, outlet.y, outlet.z);
      }
    }

    this.vehiclePresets[carIndex] = resolvedVisual;
    this.loadout.applySlotPaintOrColor(carIndex, teamColor);

    this.onRenderTreeChanged?.();
    return true;
  }

  refreshCustomVehicle(vehicleId?: string): void {
    this.loadout.refreshCustomVehicle(vehicleId);
  }

  removeCar(carIndex: number): boolean {
    if (!this.cars || carIndex < 0 || carIndex >= this.cars.length) return false;
    const carRoot = this.cars[carIndex];
    if (carRoot) {
      this.scene.remove(carRoot);
      disposeObjectGeometryAndMaterials(carRoot);
    }

    if (this.carDemolitions?.[carIndex]) {
      const demo = this.carDemolitions[carIndex]!;
      if (demo.object) this.scene.remove(demo.object);
      demo.dispose?.();
    }
    if (this.carBoosts?.[carIndex]) {
      for (const emitter of this.carBoosts[carIndex]!) {
        emitter.dispose?.();
      }
    }

    this.cars[carIndex] = null;
    this.vehiclePresets[carIndex] = null;
    this.carHitboxes[carIndex] = null;
    this.carSuspension[carIndex] = null;
    this.carWheels[carIndex] = null;
    this.carWheelSpecs[carIndex] = null;
    this.carBoosts[carIndex] = null;
    this.carDemolitions[carIndex] = null;

    this.onRenderTreeChanged?.();
    return true;
  }

  setCarColor(carIndex: number, colorVal: string | number | null | undefined): void {
    this.loadout.setCarColor(carIndex, colorVal);
  }

  setCarPaintFinish(carIndex: number, paintFinish: string | null): void {
    this.loadout.setCarPaintFinish(carIndex, paintFinish);
  }

  setCarBoostVisual(carIndex: number, boostVisual: string | null): void {
    this.loadout.setCarBoostVisual(carIndex, boostVisual);
  }

  setCarLoadout(carIndex: number, loadout: CarLoadoutConfig | null | undefined = {}): void {
    this.loadout.setCarLoadout(carIndex, loadout);
  }

  setCarHitboxesVisible(
    povVisible: boolean,
    allVisible: boolean = this.allCarHitboxesVisible,
    povCarIndex: number = this.povCarIndex
  ): void {
    this.carHitboxesVisible = Boolean(povVisible);
    this.allCarHitboxesVisible = Boolean(allVisible);
    this.syncCarHitboxesVisibility(povCarIndex);
  }

  syncCarHitboxesVisibility(povCarIndex: number = this.povCarIndex): void {
    this.povCarIndex = typeof povCarIndex === 'number' && povCarIndex >= 0 ? povCarIndex : 0;
    for (let i = 0; i < this.carHitboxes.length; i++) {
      const hitboxMesh = this.carHitboxes[i];
      if (hitboxMesh) {
        hitboxMesh.visible = this.isCarHitboxVisibleForSlot(i);
      }
    }
  }

  setCarGhostOpacity(carIndex: number, isGhost = true, opacity = 0.7): boolean {
    return this.loadout.setCarGhostOpacity(carIndex, isGhost, opacity);
  }

  clearAllGhostOpacities(): void {
    this.loadout.clearAllGhostOpacities();
  }

  resetCarBoosts(carIndex: number | null = null): void {
    this.loadout.resetCarBoosts(carIndex);
  }

  resetAllCarEffects(): void {
    this.loadout.resetCarBoosts();
    for (const demo of this.carDemolitions ?? []) {
      if (demo) {
        demo.wasDemolished = null;
        demo.stop?.();
      }
    }
  }

  async ensureOpponent(ensureOpponentSunFn?: () => void, defaultVisual = 'fennec'): Promise<void> {
    if (!this.cars[1]) {
      const id = String(defaultVisual || 'fennec').toLowerCase();
      if (hasVehicleDescriptor(id) && !this.customVehicleAssets.has(id) && this.carLoaders.loadCustomGlbCarAsset) {
        try {
          this.customVehicleAssets.set(id, await this.carLoaders.loadCustomGlbCarAsset(id));
        } catch (err) {
          console.warn(`Opponent "${id}" asset load skipped:`, err);
        }
      }
      (ensureOpponentSunFn ?? this.onEnsureOpponentSun)?.();
      this.addCar(1, id, 1);
    }
  }

  hasActiveBoostBloom(): boolean {
    return this.loadout.hasActiveBoostBloom();
  }

  dispose(): void {
    for (const carList of this.carBoosts) {
      if (Array.isArray(carList)) {
        for (const emitter of carList) emitter?.dispose?.();
      }
    }
    for (const car of this.cars) {
      if (car) {
        disposeObjectGeometryAndMaterials(car);
      }
    }
  }
}
