/**
 * ArenaVehicleRegistry.js
 * Vehicle entity lifecycle management: state storage, in-place visual swapping,
 * paint customization, and opponent instantiation.
 */

import * as THREE from 'three';
import { VehicleBoostEmitter } from '../vehicle/boost/vehicleBoostEmitter.js';
import { DemolitionEffect } from '../DemolitionEffect.js';
import { getWheelSpecsForVisual } from '../VehicleSuspensionSystem.js';
import { HITBOX_PRESETS, normalizeVisualId } from '../../ui-core/config/vehiclePresets.js';
import { getVehicleDescriptor, hasVehicleDescriptor } from '../../ui-core/config/vehicleTunerConfig.js';
import { applyLiveVehicleDescriptorUpdate } from '../vehicle/customGlbCarModel.js';
import { DEFAULT_TEAM_COLORS, OCTANE_BOOST_OUTLETS, OCTANE_HITBOX_PRESET, BOT_CAR_INDEX } from './ArenaConstants.js';
import { createCarHitboxWireframe } from './ArenaMath.js';
import { buildVehicleModel, buildVehicleWheels, removeCarMeshes } from './VehicleFactory.js';
import { applyVehiclePaint } from './VehiclePaint.js';
import { createDefaultVehicleLoaders } from './VehicleLoaders.js';

export class ArenaVehicleRegistry {
  constructor(arenaScene, onRenderTreeChanged) {
    this.scene = arenaScene;
    this.onRenderTreeChanged = onRenderTreeChanged;

    this.cars = [];
    this.vehiclePresets = [];
    this.carHitboxes = [];
    this.carHitboxesVisible = true;
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

    // Preloaded custom GLB vehicle assets keyed by descriptor ID
    this.customVehicleAssets = new Map();

    this.carLoaders = createDefaultVehicleLoaders();
  }

  get assets() {
    return this.customVehicleAssets;
  }

  setCustomVehicleAsset(vehicleId, asset) {
    if (vehicleId && asset) {
      this.customVehicleAssets.set(String(vehicleId).toLowerCase(), asset);
    }
  }

  _ensureAsyncCustomAsset(visual, slot) {
    const id = normalizeVisualId(visual);
    if (hasVehicleDescriptor(id) && !this.customVehicleAssets.has(id) && this.carLoaders.loadCustomGlbCarAsset) {
      this.carLoaders.loadCustomGlbCarAsset(id).then((asset) => {
        this.customVehicleAssets.set(id, asset);
        if (this.vehiclePresets[slot] === id) {
          this.swapCarVisual(slot, id);
        }
      }).catch((err) => console.warn(`Lazy "${id}" asset load failed:`, err));
    }
  }

  addCar(teamIndex = 0, visualOrOptions = "fennec", targetIndex = null) {
    let visual = "fennec";
    let resolvedTargetIndex = targetIndex;
    if (visualOrOptions && typeof visualOrOptions === "object") {
      visual = visualOrOptions.visual || visualOrOptions.preset || "fennec";
      if (typeof visualOrOptions.targetIndex === "number") {
        resolvedTargetIndex = visualOrOptions.targetIndex;
      }
    } else if (typeof visualOrOptions === "string" && visualOrOptions.length > 0) {
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
      visual, teamColor, isBot, this.assets, this.carLoaders, this.carHitboxesVisible
    );
    carRoot.add(carModel, carHitbox);

    let wheelSpecs = getWheelSpecsForVisual(visual);
    if (!visual.startsWith("hitbox-") && !hasVehicleDescriptor(visual) && this.carLoaders.wheelSpecs?.game) {
      wheelSpecs = this.carLoaders.wheelSpecs.game;
    }

    const wheels = buildVehicleWheels(carRoot, visual, teamColor, wheelSpecs, this.assets, this.carLoaders);
    const defaultOutlets = OCTANE_BOOST_OUTLETS.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const emitters = (boostOutlets || defaultOutlets).map((pos, p) => new VehicleBoostEmitter(this.scene, carRoot, pos, p === 0, isBot));
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

  ensureCar(carIndex, teamIndex = null, visualOrOptions = "fennec") {
    if (typeof carIndex !== 'number' || carIndex < 0) return null;
    const resolvedTeam = typeof teamIndex === 'number' ? teamIndex : (this.carTeams?.[carIndex] ?? (carIndex % 2));
    let visual = "fennec";
    if (visualOrOptions && typeof visualOrOptions === "object") {
      visual = visualOrOptions.visual || visualOrOptions.preset || this.vehiclePresets?.[carIndex] || "fennec";
    } else if (typeof visualOrOptions === "string" && visualOrOptions.length > 0) {
      visual = visualOrOptions;
    } else if (this.vehiclePresets?.[carIndex]) {
      visual = this.vehiclePresets[carIndex];
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
      this.cars[carIndex].visible = true;
    }
    return this.cars[carIndex];
  }

  setCarTeam(carIndex, teamIndex) {
    if (typeof carIndex !== 'number' || carIndex < 0) return;
    if (!this.carTeams) this.carTeams = [];
    this.carTeams[carIndex] = teamIndex;
    const teamColor = this.carLoaders.teamColors?.[teamIndex] ?? DEFAULT_TEAM_COLORS[teamIndex % 2];
    if (this.cars?.[carIndex] && (this.carColors?.[carIndex] === undefined || this.carColors?.[carIndex] === null)) {
      applyVehiclePaint(this.cars[carIndex], this.vehiclePresets?.[carIndex], teamColor, this.carPaintFinishes?.[carIndex] || null);
      this.onRenderTreeChanged?.();
    }
  }

  swapCarVisual(carIndex, newVisual) {
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
      resolvedVisual, teamColor, isBot, this.assets, this.carLoaders, this.carHitboxesVisible
    );
    carRoot.add(carModel, carHitbox);
    this.carHitboxes[carIndex] = carHitbox;

    let wheelSpecs = getWheelSpecsForVisual(resolvedVisual);
    if (!resolvedVisual.startsWith("hitbox-") && !hasVehicleDescriptor(resolvedVisual) && this.carLoaders.wheelSpecs?.game) {
      wheelSpecs = this.carLoaders.wheelSpecs.game;
    }
    this.carWheelSpecs[carIndex] = wheelSpecs;
    this.carWheels[carIndex] = buildVehicleWheels(carRoot, resolvedVisual, teamColor, wheelSpecs, this.assets, this.carLoaders);

    const emitterList = this.carBoosts[carIndex];
    if (emitterList && boostOutlets) {
      for (let p = 0; p < emitterList.length && p < boostOutlets.length; p++) {
        if (emitterList[p]?.setNozzleOffset) {
          emitterList[p].setNozzleOffset(boostOutlets[p]);
        } else if (emitterList[p]?.offset) {
          emitterList[p].offset.copy(boostOutlets[p]);
        }
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

  refreshCustomVehicle(vehicleId) {
    const targetDescriptor = vehicleId ? getVehicleDescriptor(vehicleId) : null;

    for (let i = 0; i < this.cars.length; i++) {
      const carRoot = this.cars[i];
      if (!carRoot) continue;
      const preset = this.vehiclePresets[i];
      const teamIndex = this.carTeams?.[i] ?? (i % 2);
      const teamColor = this.carColors?.[i] ?? this.carLoaders.teamColors?.[teamIndex] ?? DEFAULT_TEAM_COLORS[teamIndex % 2];
      const carDesc = hasVehicleDescriptor(preset) ? getVehicleDescriptor(preset) : (preset === vehicleId ? targetDescriptor : null);
      const hasLoadedCustomAsset = Boolean(carDesc && this.customVehicleAssets.has(String(carDesc.id).toLowerCase()));

      if (carDesc && hasLoadedCustomAsset) {
        this.carWheelSpecs[i] = getWheelSpecsForVisual(preset);
        applyLiveVehicleDescriptorUpdate(
          carRoot,
          this.carHitboxes[i],
          this.carWheels[i],
          this.carBoosts[i],
          carDesc,
          teamColor,
          this.carPaintFinishes?.[i] || null
        );

        if (this.carHitboxes[i]) {
          const oldHitbox = this.carHitboxes[i];
          const wasVisible = oldHitbox.visible;
          carRoot.remove(oldHitbox);
          oldHitbox.geometry?.dispose?.();
          oldHitbox.material?.dispose?.();
          const hbPreset = HITBOX_PRESETS[carDesc.hitboxPreset] || OCTANE_HITBOX_PRESET;
          const nextHitbox = createCarHitboxWireframe(hbPreset);
          nextHitbox.name = "car-hitbox-wireframe";
          nextHitbox.visible = wasVisible;
          carRoot.add(nextHitbox);
          this.carHitboxes[i] = nextHitbox;
        }
      } else if (this.carWheels[i] && this.carLoaders.createProceduralSportWheel) {
        applyVehiclePaint(carRoot, preset, teamColor, this.carPaintFinishes?.[i] || null);
        // Also refresh wheel meshes on non-matching cars when global Wheel Modifier is tweaked
        const specs = this.carWheelSpecs[i] || getWheelSpecsForVisual(preset);
        for (let w = 0; w < this.carWheels[i].length; w++) {
          const spinGroup = this.carWheels[i][w]?.spin;
          if (!spinGroup) continue;
          while (spinGroup.children.length > 0) {
            const oldChild = spinGroup.children[0];
            spinGroup.remove(oldChild);
            oldChild.traverse?.((n) => {
              n.geometry?.dispose?.();
              if (n.material) {
                const mats = Array.isArray(n.material) ? n.material : [n.material];
                mats.forEach((m) => m?.dispose?.());
              }
            });
          }
          const r = specs?.[w]?.[2] || 13.5;
          spinGroup.add(this.carLoaders.createProceduralSportWheel(r, teamColor, w));
        }
      }
    }
    this.onRenderTreeChanged?.();
  }

  removeCar(carIndex) {
    if (!this.cars || carIndex < 0 || carIndex >= this.cars.length) return false;
    const carRoot = this.cars[carIndex];
    if (carRoot) {
      this.scene.remove(carRoot);
      carRoot.traverse(node => {
        if (node.geometry) node.geometry.dispose?.();
        if (node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          mats.forEach(m => m?.dispose?.());
        }
      });
    }

    if (this.carDemolitions?.[carIndex]) {
      const demo = this.carDemolitions[carIndex];
      if (demo.object) this.scene.remove(demo.object);
      demo.dispose?.();
    }
    if (this.carBoosts?.[carIndex]) {
      this.carBoosts[carIndex].forEach(emitter => emitter.dispose?.());
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

  setCarColor(carIndex, colorVal) {
    if (!this.carColors) this.carColors = [];
    const num = typeof colorVal === "string" ? parseInt(colorVal.replace("#", ""), 16) : colorVal;
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

  setCarPaintFinish(carIndex, paintFinish) {
    if (typeof carIndex !== "number" || carIndex < 0) return;
    if (!this.carPaintFinishes) this.carPaintFinishes = [];
    const normalized =
      paintFinish === "metallic" || paintFinish === "matte" ? paintFinish : null;
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

  setCarBoostVisual(carIndex, boostVisual) {
    if (typeof carIndex !== "number" || carIndex < 0) return;
    if (!this.carBoostVisuals) this.carBoostVisuals = [];
    const normalized =
      boostVisual === "cartoon" || boostVisual === "gold-rush" ? boostVisual : null;
    this.carBoostVisuals[carIndex] = normalized;
    const emitters = this.carBoosts?.[carIndex];
    if (Array.isArray(emitters)) {
      for (const emitter of emitters) {
        emitter?.setBoostVisual?.(normalized);
      }
    }
  }

  setCarLoadout(carIndex, loadout = {}) {
    if (typeof carIndex !== "number" || carIndex < 0 || !loadout) return;
    if (loadout.visualId || loadout.visual) {
      const targetVisual = loadout.visualId || loadout.visual;
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

  setCarHitboxesVisible(visible) {
    this.carHitboxesVisible = visible;
    for (const hitboxMesh of this.carHitboxes) {
      if (hitboxMesh) hitboxMesh.visible = visible;
    }
  }

  setCarGhostOpacity(carIndex, isGhost = true, opacity = 0.70) {
    const carRoot = this.cars?.[carIndex];
    if (!carRoot) return false;
    const clampedOpacity = Math.max(0.1, Math.min(1.0, opacity));
    carRoot.traverse?.((node) => {
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
          mat.transparent = mat.userData._origTransparent;
          mat.opacity = mat.userData._origOpacity;
        }
        mat.needsUpdate = true;
      }
    });
    this.onRenderTreeChanged?.();
    return true;
  }

  clearAllGhostOpacities() {
    for (let i = 0; i < this.cars.length; i++) {
      if (this.cars[i]) this.setCarGhostOpacity(i, false, 1.0);
    }
  }

  resetCarBoosts(carIndex = null) {
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

  resetAllCarEffects() {
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

  async ensureOpponent(ensureOpponentSunFn, defaultVisual = "fennec") {
    if (!this.cars[1]) {
      const id = String(defaultVisual || "fennec").toLowerCase();
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

  dispose() {
    for (const carList of this.carBoosts) {
      if (Array.isArray(carList)) {
        for (const emitter of carList) emitter?.dispose?.();
      }
    }
    for (const car of this.cars) {
      if (car) {
        car.traverse?.(obj => {
          if (obj.geometry?.dispose) obj.geometry.dispose();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => m?.dispose?.());
          }
        });
      }
    }
  }
}
