import * as THREE from 'three';
import { loadBallAsset } from '../BallVisual.ts';
import { loadDriftwoodsStadium } from '../stadium/driftwoods/DriftwoodsStadiumLoader.ts';
import { preloadThrowbackStadiumAssets } from '../stadium/ThrowbackStadiumLoader.ts';
import { preloadThrowbackCollisionMeshes } from '../../physics/RocketSimMeshLoader.ts';
import { getAllVehicleDescriptors, hasVehicleDescriptor } from '../../ui-core/config/vehicleTunerConfig';
import { BOT_CAR_INDEX } from './ArenaConstants.ts';
import type { ArenaVehicleRegistry } from './ArenaVehicleRegistry.ts';
import type { BoostPadSystem } from '../BoostPadSystem.ts';
import type { BoostPadTemplates } from './BoostPadTemplateLoader.ts';
import type { VehicleBoostEmitter } from '../vehicle/boost/vehicleBoostEmitter.ts';

export type { BoostPadTemplates };

export interface ArenaStadiumMeshesResult {
  driftwoodsStadium?: THREE.Group | null;
}

export async function loadBallAssetInto(ballGroup: THREE.Group): Promise<void> {
  try {
    const ballAsset = await loadBallAsset();
    ballGroup.add(ballAsset);
  } catch (err) {
    console.warn("Ball asset failed to load, keeping default procedural mesh:", err);
  }
}

export async function loadCarAndPadAssets(
  vehicleRegistry: ArenaVehicleRegistry,
  boostPadSystem: BoostPadSystem,
  activePreset = 'fennec'
): Promise<BoostPadTemplates | null> {
  const loaders = vehicleRegistry.carLoaders;
  const activeId = String(activePreset || 'fennec').toLowerCase();

  const vehicleLoadPromise = (async () => {
    if (loaders.loadCustomGlbCarAsset) {
      const descriptors = getAllVehicleDescriptors();
      const activeDescriptor =
        descriptors.find((d) => d.id.toLowerCase() === activeId) || descriptors[0] || null;
      if (activeDescriptor) {
        try {
          const asset = await loaders.loadCustomGlbCarAsset(activeDescriptor.id);
          vehicleRegistry.setCustomVehicleAsset?.(activeDescriptor.id, asset);
        } catch (e) {
          console.warn(`Active vehicle asset "${activeDescriptor.id}" failed to load:`, e);
        }
      }
    }

    if (Array.isArray(vehicleRegistry.cars)) {
      for (let i = 0; i < vehicleRegistry.cars.length; i++) {
        const preset = vehicleRegistry.vehiclePresets?.[i];
        if (vehicleRegistry.cars[i] && preset && hasVehicleDescriptor(preset)) {
          vehicleRegistry.swapCarVisual?.(i, preset);
        }
      }
    }
  })();

  const padLoadPromise = (async (): Promise<BoostPadTemplates | null> => {
    try {
      const glbTemplates = await boostPadSystem.loadTemplates();
      return glbTemplates || null;
    } catch (err) {
      console.warn("Authentic GLB boost pads failed to load:", err);
      return null;
    }
  })();

  const [, padTemplates] = await Promise.all([vehicleLoadPromise, padLoadPromise]);
  return padTemplates;
}

export interface ArenaAssetStepTask {
  label: string;
  run: () => Promise<unknown>;
}

export async function runParallelArenaAssetSteps(
  tasks: ReadonlyArray<ArenaAssetStepTask>,
  onProgress: ((progress: number, name: string) => void) | null = null
): Promise<void> {
  const total = tasks.length;
  if (total === 0) return;

  const pendingLabels = new Set<string>(tasks.map((t) => t.label));
  let completed = 0;

  if (typeof onProgress === 'function') {
    onProgress(0.05, `Streaming ${Array.from(pendingLabels).join(', ')}...`);
  }

  await Promise.all(
    tasks.map(async (task) => {
      await task.run();
      completed++;
      pendingLabels.delete(task.label);
      if (typeof onProgress === 'function') {
        const remaining = Array.from(pendingLabels);
        const detail =
          remaining.length > 0
            ? `Streaming ${remaining.join(' & ')} (${completed}/${total} ready)`
            : task.label;
        onProgress(completed / total, detail);
      }
    })
  );
}

export async function preloadRemainingVehicleAssets(
  vehicleRegistry: ArenaVehicleRegistry | null | undefined,
  onProgress: ((loaded: number, total: number, id: string) => void) | null = null
): Promise<void> {
  const loaders = vehicleRegistry?.carLoaders;
  if (!vehicleRegistry || !loaders?.loadCustomGlbCarAsset) return;
  const descriptors = getAllVehicleDescriptors();
  const total = descriptors.length;
  let loaded = 0;
  for (const desc of descriptors) {
    const id = desc.id.toLowerCase();
    if (!vehicleRegistry.customVehicleAssets?.has?.(id)) {
      await new Promise((r) => setTimeout(r, 8));
      try {
        const asset = await loaders.loadCustomGlbCarAsset(desc.id);
        vehicleRegistry.setCustomVehicleAsset?.(desc.id, asset);
      } catch (e) {
        console.warn(`Custom vehicle asset "${desc.id}" failed to load:`, e);
      }
    }
    loaded++;
    if (typeof onProgress === 'function') {
      onProgress(loaded, total, desc.id);
    }
  }
}

export async function prepareAllArenaWarmupAssets(
  ensureOpponentFn: () => Promise<void>,
  vehicleRegistry: ArenaVehicleRegistry,
  onProgress: ((loaded: number, total: number, label: string) => void) | null = null
): Promise<void> {
  let completed = 0;
  const total = 4;
  const report = (label: string) => {
    completed++;
    if (typeof onProgress === 'function') {
      onProgress(completed, total, label);
    }
  };
  await Promise.all([
    ensureOpponentFn().then(() => {
      if (vehicleRegistry.cars[BOT_CAR_INDEX]) {
        vehicleRegistry.cars[BOT_CAR_INDEX]!.visible = false;
      }
      report('Opponent Vehicle Rig');
    }),
    preloadRemainingVehicleAssets(vehicleRegistry).then(() => {
      report('Additional Vehicle GLB Models');
    }),
    Promise.all(
      vehicleRegistry.carBoosts.flatMap((list) =>
        Array.isArray(list) ? list.map((emitter: VehicleBoostEmitter) => emitter?.preload?.()) : []
      )
    ).then(() => {
      report('Boost Emitter Textures');
    }),
    Promise.all([
      preloadThrowbackStadiumAssets().catch((err) => {
        console.warn('[ArenaWorld] Throwback stadium GLB preload warning:', err);
      }),
      preloadThrowbackCollisionMeshes().catch((err) => {
        console.warn('[ArenaWorld] Throwback collision mesh preload warning:', err);
      }),
    ]).then(() => {
      report('Throwback Stadium & Collision Meshes');
    }),
  ]);
}

export async function loadArenaStadiumMeshes(): Promise<ArenaStadiumMeshesResult> {
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
