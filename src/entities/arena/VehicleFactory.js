/**
 * VehicleFactory.js
 * Instantiates vehicle body meshes, whitebox fallback models,
 * hitbox debug wireframes, and wheel attachment hierarchies.
 */

import * as THREE from 'three';
import { HITBOX_PRESETS, createWhiteboxCarModel } from '../../config/vehiclePresets.js';
import { getVehicleDescriptor, hasVehicleDescriptor } from '../vehicle/vehicleDescriptors.js';
import {
  OCTANE_BOOST_OUTLETS,
  OCTANE_HITBOX_PRESET
} from './ArenaConstants.js';
import { createCarHitboxWireframe } from './ArenaMath.js';

/**
 * Builds vehicle 3D mesh model, hitbox wireframe, and boost outlet vectors.
 */
export function buildVehicleModel(visual, teamColor, isBot, assets, loaders, carHitboxesVisible) {
  const isHitbox = visual.startsWith("hitbox-");
  const isCustomGlb = hasVehicleDescriptor(visual);

  let carModel = null;
  let carHitbox = null;
  let boostOutlets = null;

  if (isHitbox) {
    let preset = HITBOX_PRESETS[visual];
    if (!preset) {
      console.warn(`[VehicleFactory] Unrecognized hitbox preset "${visual}"; falling back to "hitbox-octane".`);
      preset = HITBOX_PRESETS["hitbox-octane"];
    }
    try {
      carModel = createWhiteboxCarModel(visual, teamColor);
    } catch (err) {
      console.error('[VehicleFactory] Failed to instantiate car model:', err, { visual, teamColor });
      carModel = new THREE.Group();
    }
    carModel.name = "car-body-mesh";
    carHitbox = createCarHitboxWireframe(preset);
    carHitbox.name = "car-hitbox-wireframe";
    carHitbox.visible = carHitboxesVisible;
    boostOutlets = OCTANE_BOOST_OUTLETS.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    return { carModel, carHitbox, boostOutlets };
  }

  if (isCustomGlb) {
    const descriptor = getVehicleDescriptor(visual);
    const hitboxPreset = HITBOX_PRESETS[descriptor?.hitboxPreset] || OCTANE_HITBOX_PRESET;
    const customAsset = assets instanceof Map ? assets.get(visual) : assets?.[visual];
    if (customAsset && loaders.createCustomGlbCarModel) {
      carModel = loaders.createCustomGlbCarModel(visual, customAsset, teamColor);
    } else {
      console.warn(
        `[VehicleFactory] Custom GLB asset or loader unavailable for "${visual}"; falling back to whitebox model "${descriptor?.hitboxPreset || 'hitbox-octane'}".`
      );
      try {
        carModel = createWhiteboxCarModel(descriptor?.hitboxPreset || "hitbox-octane", teamColor);
      } catch (err) {
        console.warn(`[VehicleFactory] Failed to create whitebox fallback for "${visual}"; using empty Group:`, err);
        carModel = new THREE.Group();
      }
    }
    carModel.name = "car-body-mesh";
    carHitbox = createCarHitboxWireframe(hitboxPreset);
    carHitbox.name = "car-hitbox-wireframe";
    carHitbox.visible = carHitboxesVisible;
    const rawOutlets = descriptor?.boostOutlets || OCTANE_BOOST_OUTLETS;
    boostOutlets = rawOutlets.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    return { carModel, carHitbox, boostOutlets };
  }

  console.warn(`[VehicleFactory] Visual preset "${visual}" has no custom GLB descriptor; falling back to "hitbox-octane" whitebox model.`);
  try {
    carModel = createWhiteboxCarModel("hitbox-octane", teamColor);
  } catch (err) {
    console.error('[VehicleFactory] Failed to instantiate fallback model:', err, { teamColor });
    carModel = new THREE.Group();
  }
  carHitbox = createCarHitboxWireframe(OCTANE_HITBOX_PRESET);
  boostOutlets = OCTANE_BOOST_OUTLETS.map(([x, y, z]) => new THREE.Vector3(x, y, z));

  carModel.name = "car-body-mesh";
  carHitbox.name = "car-hitbox-wireframe";
  carHitbox.visible = carHitboxesVisible;
  return { carModel, carHitbox, boostOutlets };
}

/**
 * Builds wheels (steer and spin groups) for the car hierarchy.
 */
export function buildVehicleWheels(carRoot, visual, teamColor, wheelSpecs, assets, loaders) {
  const isHitbox = visual.startsWith("hitbox-");
  const isCustomGlb = hasVehicleDescriptor(visual);
  const wheels = [];

  if (isHitbox || !isCustomGlb) {
    if (!loaders.createProceduralSportWheel) {
      console.warn(`[VehicleFactory] createProceduralSportWheel loader unavailable for "${visual}"; falling back to cylinder wheel geometry.`);
    }
    const wheelGeom = new THREE.CylinderGeometry(13.5, 13.5, 9, 16);
    wheelGeom.rotateX(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 2171169, roughness: 0.9, metalness: 0.1 });
    for (let i = 0; i < 4; i++) {
      const [specX, specZ, specRadius] = wheelSpecs[i] || [0, 0, 13.5];
      const steerGroup = new THREE.Group();
      steerGroup.name = "car-wheel-steer";
      steerGroup.position.set(specX, -6.0, specZ);
      const spinGroup = new THREE.Group();
      if (loaders.createProceduralSportWheel) {
        spinGroup.add(loaders.createProceduralSportWheel(specRadius || 13.5, teamColor, i));
      } else {
        const wm = new THREE.Mesh(wheelGeom, wheelMat);
        wm.castShadow = true;
        spinGroup.add(wm);
      }
      steerGroup.add(spinGroup);
      carRoot.add(steerGroup);
      wheels.push({ steer: steerGroup, spin: spinGroup });
    }
    return wheels;
  }

  const descriptor = getVehicleDescriptor(visual);
  if (!loaders.createProceduralSportWheel) {
    console.warn(`[VehicleFactory] createProceduralSportWheel loader unavailable for custom vehicle "${visual}"; using empty wheel groups.`);
  }

  for (let i = 0; i < wheelSpecs.length; i++) {
    const [specX, specZ, specRadius] = wheelSpecs[i];
    const steerGroup = new THREE.Group();
    steerGroup.name = "car-wheel-steer";
    const restY = descriptor?.suspensionHeights?.[i] ?? (specRadius - 17);
    steerGroup.position.set(specX, restY, specZ);
    const spinGroup = new THREE.Group();

    let wheelMesh;
    if (loaders.createProceduralSportWheel) {
      wheelMesh = loaders.createProceduralSportWheel(specRadius || 13.5, teamColor, i);
    } else {
      wheelMesh = new THREE.Group();
    }

    spinGroup.add(wheelMesh);
    steerGroup.add(spinGroup);
    carRoot.add(steerGroup);
    wheels.push({ steer: steerGroup, spin: spinGroup });
  }

  return wheels;
}

/**
 * Removes and disposes previous vehicle body and hitbox meshes.
 */
export function removeCarMeshes(carRoot, removeWheels = false) {
  const toRemove = [];
  for (const child of carRoot.children) {
    if (
      child.name === "car-body-mesh" ||
      child.name === "car-hitbox-wireframe" ||
      child.name === "car-hitbox" ||
      child.name?.startsWith("whitebox-") ||
      (removeWheels && child.name === "car-wheel-steer")
    ) {
      toRemove.push(child);
    }
  }
  for (const child of toRemove) {
    carRoot.remove(child);
    child.traverse?.(node => {
      if (node.geometry) node.geometry.dispose?.();
      if (node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach(m => m?.dispose?.());
      }
    });
  }
}
