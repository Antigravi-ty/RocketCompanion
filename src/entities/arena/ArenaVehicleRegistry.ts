import * as THREE from 'three';
import { VehicleBoostEmitter } from '../vehicle/boost/vehicleBoostEmitter.ts';
import { DemolitionEffect } from '../DemolitionEffect.ts';
import { getWheelSpecsForVisual } from '../VehicleSuspensionSystem.ts';
import { HITBOX_PRESETS, normalizeVisualId } from '../../ui-core/config/vehiclePresets';
import {
  getVehicleDescriptor,
  hasVehicleDescriptor,
  vehicleTunerRuntimeFlags,
} from '../../ui-core/config/vehicleTunerConfig';
import { applyLiveVehicleDescriptorUpdate } from '../vehicle/customGlbCarModel.ts';
import type {
  ArenaHeaderView,
  CarStateView,
  NumericStateBuffer,
} from '../../physics/RocketSimStateViews.ts';
import { DEFAULT_TEAM_COLORS, OCTANE_BOOST_OUTLETS, OCTANE_HITBOX_PRESET } from './ArenaConstants.ts';
import { createCarHitboxWireframe } from './ArenaMath.ts';
import { buildVehicleModel, buildVehicleWheels, removeCarMeshes, createDefaultVehicleLoaders } from './VehicleFactory.ts';
import { applyVehiclePaint, type TraversableMaterialNode } from './VehiclePaint.ts';

export interface VehicleWheelRig { steer: THREE.Group; spin: THREE.Group; }
export type VehicleWheelSet = VehicleWheelRig[] & { threeWheels?: boolean };
export type WheelSpecTuple = [number, number, number];

export interface SuspensionUnitVisual {
  group?: THREE.Group; top?: THREE.Vector3; botZ?: number; spring?: THREE.Object3D;
  built?: number; bodyLen?: number; shaft?: THREE.Object3D; body?: THREE.Object3D;
  innerZ: number; armFore?: THREE.Object3D; foreRoot?: THREE.Object3D | THREE.Vector3;
  armAft?: THREE.Object3D; aftRoot?: THREE.Object3D | THREE.Vector3;
}

export interface VehicleVisualOptions { visual?: string; preset?: string; targetIndex?: number; }
export type VehicleVisualInput = string | VehicleVisualOptions;

export interface CarLoadoutConfig {
  visualId?: string | null; visual?: string | null; paintFinish?: string | null;
  colorHex?: string | number | null; boostVisual?: string | null; boostAudio?: string | null;
}

export interface CarControlInput {
  throttle?: number; steer?: number; pitch?: number; yaw?: number; roll?: number;
  jump?: boolean | number; boost?: boolean | number; handbrake?: boolean | number;
}
export type CarControlsResolver = (carIndex: number) => CarControlInput | null | undefined;

function disposeObjectGeometryAndMaterials(root: THREE.Object3D): void {
  root.traverse?.((node: TraversableMaterialNode) => {
    node.geometry?.dispose?.();
    if (node.material) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) m?.dispose?.();
    }
  });
}

export function updateBoostVisuals(
  cars: Array<THREE.Group | null>,
  carBoosts: Array<VehicleBoostEmitter[] | null>,
  currState: NumericStateBuffer | null,
  throttle: number,
  delta: number,
  opponentThrottle = 0,
  activeVisuals = true,
  controls: CarControlInput | null | undefined = null,
  opponentControls: CarControlInput | null | undefined = null,
  playerCarIndex = 0,
  headerView: ArenaHeaderView | null = null,
  currCarView: CarStateView | null = null,
  carControlsResolver: CarControlsResolver | null = null
): void {
  const header = headerView?.attach(currState);
  const numCars = header ? header.numCars : cars.length;
  const localCarIdx = playerCarIndex ?? 0;
  const maxSlots = Math.max(cars?.length ?? 0, carBoosts?.length ?? 0);

  for (let carIndex = 0; carIndex < maxSlots; carIndex++) {
    const carGroup = cars[carIndex];
    if (!carGroup || carIndex >= numCars || !carGroup.visible) {
      if (carIndex >= numCars || !carGroup) {
        for (const emitter of carBoosts?.[carIndex] ?? []) {
          emitter?.resetVisual?.();
        }
        continue;
      }
    }
    const carView = currCarView?.attachCar(currState, carIndex);
    const isLocalCar = carIndex === localCarIdx;
    const carCtrl = typeof carControlsResolver === 'function'
      ? carControlsResolver(carIndex)
      : (carIndex === 0 ? controls : opponentControls);
    const forcePreview = isLocalCar && Boolean(vehicleTunerRuntimeFlags.forceBoostPreview);
    const isBoosting = activeVisuals && (
      forcePreview ||
      Boolean(carView && carView.isBoosting) ||
      Boolean(carCtrl?.boost && carView && carView.boost > 0)
    );
    const isAudibleActive = isLocalCar;
    const currentThrottle = isLocalCar ? throttle : (carCtrl?.throttle ?? opponentThrottle);
    for (const emitter of carBoosts[carIndex] ?? []) {
      emitter.setSpatial?.(!isAudibleActive);
      emitter.update?.(
        isBoosting,
        activeVisuals && (forcePreview || currentThrottle > 0.01),
        carGroup.visible,
        delta,
        activeVisuals
      );
    }
  }
}

export class ArenaVehicleRegistry {
  public scene: THREE.Scene;
  public onRenderTreeChanged?: () => void;
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

  constructor(arenaScene: THREE.Scene, onRenderTreeChanged?: () => void) {
    this.scene = arenaScene;
    this.onRenderTreeChanged = onRenderTreeChanged;

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
    this.carColors = [];
    this.carPaintFinishes = [];
    this.carBoostVisuals = [];
    this.carBoostAudios = [];

    this.customVehicleAssets = new Map<string, unknown>();
    this.carLoaders = createDefaultVehicleLoaders();
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
    if (this.carColors && this.carColors[slot] !== undefined && this.carColors[slot] !== null) {
      this.setCarColor(slot, this.carColors[slot]);
    } else if (this.carPaintFinishes?.[slot]) {
      applyVehiclePaint(carRoot, visual, teamColor, this.carPaintFinishes[slot]);
    }
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
    if (this.carColors && this.carColors[carIndex] !== undefined && this.carColors[carIndex] !== null) {
      this.setCarColor(carIndex, this.carColors[carIndex]);
    } else if (this.carPaintFinishes?.[carIndex]) {
      applyVehiclePaint(carRoot, resolvedVisual, teamColor, this.carPaintFinishes[carIndex]);
    }

    this.onRenderTreeChanged?.();
    return true;
  }

  refreshCustomVehicle(vehicleId?: string): void {
    const targetDescriptor = vehicleId ? getVehicleDescriptor(vehicleId) : null;

    for (let i = 0; i < this.cars.length; i++) {
      const carRoot = this.cars[i];
      if (!carRoot) continue;
      const preset = this.vehiclePresets[i];
      const teamIndex = this.carTeams?.[i] ?? (i % 2);
      const teamColor = this.carColors?.[i] ?? this.carLoaders.teamColors?.[teamIndex] ?? DEFAULT_TEAM_COLORS[teamIndex % 2];
      const carDesc = hasVehicleDescriptor(preset || '') ? getVehicleDescriptor(preset || '') : (preset === vehicleId ? targetDescriptor : null);
      const hasLoadedCustomAsset = Boolean(carDesc && this.customVehicleAssets.has(String(carDesc.id).toLowerCase()));

      if (carDesc && hasLoadedCustomAsset) {
        this.carWheelSpecs[i] = getWheelSpecsForVisual(preset) as WheelSpecTuple[];
        applyLiveVehicleDescriptorUpdate(
          carRoot,
          this.carHitboxes[i],
          this.carWheels[i],
          this.carBoosts[i],
          carDesc,
          teamColor,
          this.carPaintFinishes?.[i] || null
        );

        const oldHitbox = this.carHitboxes[i] as TraversableMaterialNode | null;
        if (oldHitbox) {
          carRoot.remove(oldHitbox);
          oldHitbox.geometry?.dispose?.();
          if (oldHitbox.material) {
            for (const m of Array.isArray(oldHitbox.material) ? oldHitbox.material : [oldHitbox.material]) {
              m?.dispose?.();
            }
          }
          const hbPreset = (HITBOX_PRESETS as Record<string, typeof OCTANE_HITBOX_PRESET>)[carDesc.hitboxPreset] || OCTANE_HITBOX_PRESET;
          const nextHitbox = createCarHitboxWireframe(hbPreset);
          nextHitbox.name = 'car-hitbox-wireframe';
          nextHitbox.visible = this.isCarHitboxVisibleForSlot(i);
          carRoot.add(nextHitbox);
          this.carHitboxes[i] = nextHitbox;
        }
      } else if (this.carWheels[i] && this.carLoaders.createProceduralSportWheel) {
        applyVehiclePaint(carRoot, preset, teamColor, this.carPaintFinishes?.[i] || null);
        const specs = this.carWheelSpecs[i] || (getWheelSpecsForVisual(preset) as WheelSpecTuple[]);
        const wheels = this.carWheels[i]!;
        for (let w = 0; w < wheels.length; w++) {
          const spinGroup = wheels[w]?.spin;
          if (!spinGroup) continue;
          while (spinGroup.children.length > 0) {
            const oldChild = spinGroup.children[0];
            spinGroup.remove(oldChild);
            disposeObjectGeometryAndMaterials(oldChild);
          }
          const r = specs?.[w]?.[2] || 13.5;
          spinGroup.add(this.carLoaders.createProceduralSportWheel(r, teamColor, w));
        }
      }
    }
    this.onRenderTreeChanged?.();
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
    if (!this.carColors) this.carColors = [];
    const num = typeof colorVal === 'string' ? parseInt(colorVal.replace('#', ''), 16) : colorVal;
    if (this.carColors[carIndex] === num) return;
    this.carColors[carIndex] = num;
    const carRoot = this.cars[carIndex];
    if (!carRoot) return;

    applyVehiclePaint(
      carRoot,
      this.vehiclePresets?.[carIndex],
      num,
      this.carPaintFinishes?.[carIndex] || null
    );
    this.onRenderTreeChanged?.();
  }

  setCarPaintFinish(carIndex: number, paintFinish: string | null): void {
    if (typeof carIndex !== 'number' || carIndex < 0) return;
    if (!this.carPaintFinishes) this.carPaintFinishes = [];
    const normalized =
      paintFinish === 'metallic' || paintFinish === 'matte' ? paintFinish : null;
    if (this.carPaintFinishes[carIndex] === normalized) return;
    this.carPaintFinishes[carIndex] = normalized;
    const carRoot = this.cars?.[carIndex];
    if (!carRoot) return;
    const teamIndex = this.carTeams?.[carIndex] ?? (carIndex % 2);
    const activeColor =
      this.carColors?.[carIndex] !== undefined && this.carColors?.[carIndex] !== null
        ? this.carColors[carIndex]
        : (this.carLoaders.teamColors?.[teamIndex] ?? DEFAULT_TEAM_COLORS[teamIndex % 2]);
    applyVehiclePaint(carRoot, this.vehiclePresets?.[carIndex], activeColor, normalized);
    this.onRenderTreeChanged?.();
  }

  setCarBoostVisual(carIndex: number, boostVisual: string | null): void {
    if (typeof carIndex !== 'number' || carIndex < 0) return;
    if (!this.carBoostVisuals) this.carBoostVisuals = [];
    const normalized =
      boostVisual === 'cartoon' || boostVisual === 'gold-rush' ? boostVisual : null;
    this.carBoostVisuals[carIndex] = normalized;
    const emitters = this.carBoosts?.[carIndex];
    if (Array.isArray(emitters)) {
      for (const emitter of emitters) {
        emitter?.setBoostVisual?.(normalized);
      }
    }
  }

  setCarLoadout(carIndex: number, loadout: CarLoadoutConfig | null | undefined = {}): void {
    if (typeof carIndex !== 'number' || carIndex < 0 || !loadout) return;
    if (loadout.visualId || loadout.visual) {
      const targetVisual = (loadout.visualId || loadout.visual)!;
      if (this.cars?.[carIndex] && this.vehiclePresets?.[carIndex] !== targetVisual) {
        this.swapCarVisual(carIndex, targetVisual);
      }
    }
    if (loadout.paintFinish !== undefined) {
      this.setCarPaintFinish(carIndex, loadout.paintFinish);
    }
    if (loadout.colorHex !== undefined && loadout.colorHex !== null) {
      this.setCarColor(carIndex, loadout.colorHex);
    }
    if (loadout.boostVisual !== undefined) {
      this.setCarBoostVisual(carIndex, loadout.boostVisual);
    }
    if (loadout.boostAudio !== undefined) {
      if (!this.carBoostAudios) this.carBoostAudios = [];
      this.carBoostAudios[carIndex] = loadout.boostAudio || null;
    }
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
    const carRoot = this.cars?.[carIndex];
    if (!carRoot) return false;
    const clampedOpacity = Math.max(0.1, Math.min(1.0, opacity));
    carRoot.traverse?.((node: TraversableMaterialNode) => {
      if (!node?.material) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (!mat) continue;
        if (mat.userData === undefined) mat.userData = {};
        if (mat.userData._origTransparent === undefined) {
          mat.userData._origTransparent = Boolean(mat.transparent);
          mat.userData._origOpacity = typeof mat.opacity === 'number' ? mat.opacity : 1.0;
        }
        if (isGhost && clampedOpacity < 1.0) {
          mat.transparent = true;
          mat.opacity = clampedOpacity;
        } else {
          mat.transparent = Boolean(mat.userData._origTransparent);
          mat.opacity = Number(mat.userData._origOpacity);
        }
        mat.needsUpdate = true;
      }
    });
    this.onRenderTreeChanged?.();
    return true;
  }

  clearAllGhostOpacities(): void {
    for (let i = 0; i < this.cars.length; i++) {
      if (this.cars[i]) this.setCarGhostOpacity(i, false, 1.0);
    }
  }

  resetCarBoosts(carIndex: number | null = null): void {
    if (typeof carIndex === 'number') {
      const list = this.carBoosts?.[carIndex];
      if (Array.isArray(list)) {
        for (const emitter of list) emitter?.resetVisual?.();
      }
      return;
    }
    if (!Array.isArray(this.carBoosts)) return;
    for (const list of this.carBoosts) {
      if (Array.isArray(list)) {
        for (const emitter of list) emitter?.resetVisual?.();
      }
    }
  }

  resetAllCarEffects(): void {
    this.resetCarBoosts();
    if (Array.isArray(this.carDemolitions)) {
      for (const demo of this.carDemolitions) {
        if (demo) {
          demo.wasDemolished = null;
          demo.stop?.();
        }
      }
    }
  }

  async ensureOpponent(ensureOpponentSunFn?: () => void, defaultVisual = 'fennec'): Promise<void> {
    if (!this.cars[1]) {
      const id = String(defaultVisual || 'fennec').toLowerCase();
      if (hasVehicleDescriptor(id) && !this.customVehicleAssets.has(id) && this.carLoaders.loadCustomGlbCarAsset) {
        try {
          const asset = await this.carLoaders.loadCustomGlbCarAsset(id);
          this.customVehicleAssets.set(id, asset);
        } catch (err) {
          console.warn(`Opponent "${id}" asset load skipped:`, err);
        }
      }
      ensureOpponentSunFn?.();
      this.addCar(1, id, 1);
    }
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
