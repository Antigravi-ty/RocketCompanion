/**
 * VehiclePaint.js
 * Vehicle paint color updates for whitebox test chassis and authentic car bodies.
 */

import {
  createCarPaintMaterial,
  applyVehicleMaterials
} from '../vehicle/vehiclePaintMaterial.js';
import {
  applyCustomGlbVehicleMaterials
} from '../vehicle/customGlbCarModel.js';
import {
  hasVehicleDescriptor,
  GLOBAL_VEHICLE_SURFACE_MATERIALS
} from '../../ui-core/config/vehicleTunerConfig.js';
import { normalizeVisualId } from '../../ui-core/config/vehicleConstants.js';

export function applyVehiclePaint(carRoot, rawPreset, colorVal, paintFinish = null) {
  if (!carRoot) return;
  const preset = rawPreset ? normalizeVisualId(rawPreset) : rawPreset;

  const num = typeof colorVal === "string" ? parseInt(colorVal.replace("#", ""), 16) : colorVal;
  const finishPreset = paintFinish === "metallic"
    ? { metalness: 0.70, roughness: 0.45 }
    : paintFinish === "matte"
    ? { metalness: 0.50, roughness: 0.85 }
    : null;

  let isWhitebox =
    preset?.startsWith("hitbox-") ||
    carRoot.name?.startsWith("whitebox-") ||
    carRoot.children?.some(c => c.name?.startsWith("whitebox-"));

  if (!isWhitebox) {
    carRoot.traverse(node => {
      if (node.isMesh && node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        if (mats.some(m => m?.name === "whitebox-rear")) isWhitebox = true;
      }
    });
  }

  if (isWhitebox) {
    const bodySlot = GLOBAL_VEHICLE_SURFACE_MATERIALS?.body;
    const metalness = finishPreset?.metalness ?? bodySlot?.metalness ?? 0.7;
    const roughness = finishPreset?.roughness ?? bodySlot?.roughness ?? 0.45;
    carRoot.traverse(node => {
      if (node.isMesh && node.material) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach(material => {
          if (material && material.name === "paint") {
            if (num !== undefined && num !== null) material.color?.set?.(num);
            if (bodySlot || finishPreset) {
              material.metalness = metalness;
              material.roughness = roughness;
              material.needsUpdate = true;
            }
          } else if (material && material.name === "whitebox-rear" && (bodySlot || finishPreset)) {
            material.metalness = metalness;
            material.roughness = roughness;
            material.needsUpdate = true;
          }
        });
      }
    });
    return;
  }

  if (hasVehicleDescriptor(preset)) {
    const bodyMesh = carRoot.children?.find(c => c.name === "car-body-mesh") || carRoot;
    applyCustomGlbVehicleMaterials(bodyMesh, preset, num, paintFinish);
    const palette = createCarPaintMaterial(num, undefined);
    if (finishPreset && palette?.body) {
      palette.body.metalness = finishPreset.metalness;
      palette.body.roughness = finishPreset.roughness;
      palette.body.needsUpdate = true;
    }
    for (const child of carRoot.children || []) {
      if (child.name === "car-wheel-steer") {
        applyVehicleMaterials(child, palette);
      }
    }
    return;
  }

  const palette = createCarPaintMaterial(num, undefined);
  if (finishPreset && palette?.body) {
    palette.body.metalness = finishPreset.metalness;
    palette.body.roughness = finishPreset.roughness;
    palette.body.needsUpdate = true;
  }
  applyVehicleMaterials(carRoot, palette);
}
