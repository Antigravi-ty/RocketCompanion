import { loadBallAsset } from '../BallVisual.js';
import { loadDriftwoodsStadium } from '../stadium/driftwoods/DriftwoodsStadiumLoader.js';
import { getAllVehicleDescriptors, hasVehicleDescriptor } from '../../ui-core/config/vehicleTunerConfig.js';

export async function loadBallAssetInto(ballGroup) {
  try {
    const ballAsset = await loadBallAsset();
    ballGroup.add(ballAsset);
  } catch (err) {
    console.warn("Ball asset failed to load, keeping default procedural mesh:", err);
  }
}

export async function loadCarAndPadAssets(vehicleRegistry, boostPadSystem, activePreset = 'fennec') {
  const loaders = vehicleRegistry.carLoaders;
  const activeId = String(activePreset || 'fennec').toLowerCase();
  if (loaders.loadCustomGlbCarAsset) {
    const descriptors = getAllVehicleDescriptors();
    const orderedDescriptors = [...descriptors].sort((a, b) => {
      const aActive = a.id.toLowerCase() === activeId ? 0 : 1;
      const bActive = b.id.toLowerCase() === activeId ? 0 : 1;
      return aActive - bActive;
    });
    await Promise.all(
      orderedDescriptors.map(async (desc) => {
        try {
          const asset = await loaders.loadCustomGlbCarAsset(desc.id);
          vehicleRegistry.setCustomVehicleAsset?.(desc.id, asset);
        } catch (e) {
          console.warn(`Custom vehicle asset "${desc.id}" failed to load:`, e);
        }
      })
    );
  }

  if (Array.isArray(vehicleRegistry.cars)) {
    for (let i = 0; i < vehicleRegistry.cars.length; i++) {
      const preset = vehicleRegistry.vehiclePresets?.[i];
      if (vehicleRegistry.cars[i] && hasVehicleDescriptor(preset)) {
        vehicleRegistry.swapCarVisual?.(i, preset);
      }
    }
  }

  let padTemplates = null;
  try {
    const glbTemplates = await boostPadSystem.loadTemplates();
    if (glbTemplates) padTemplates = glbTemplates;
  } catch (err) {
    console.warn("Authentic GLB boost pads failed to load:", err);
  }

  return padTemplates;
}

export async function preloadRemainingVehicleAssets(vehicleRegistry) {
  const loaders = vehicleRegistry?.carLoaders;
  if (!loaders?.loadCustomGlbCarAsset) return;
  for (const desc of getAllVehicleDescriptors()) {
    const id = desc.id.toLowerCase();
    if (vehicleRegistry.assets?.has?.(id)) continue;
    try {
      const asset = await loaders.loadCustomGlbCarAsset(desc.id);
      vehicleRegistry.setCustomVehicleAsset?.(desc.id, asset);
    } catch (e) {
      console.warn(`Custom vehicle asset "${desc.id}" failed to load:`, e);
    }
  }
}

export async function loadArenaStadiumMeshes() {
  try {
    const driftwoodsStadium = await loadDriftwoodsStadium().catch((err) => {
      console.warn("Driftwoods stadium load failed:", err);
      return null;
    });
    return { driftwoodsStadium };
  } catch (err) {
    console.warn("loadArena skipped:", err);
    return {};
  }
}
