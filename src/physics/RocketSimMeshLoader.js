/**
 * RocketSimMeshLoader.js
 * Arena collision mesh loader and vehicle hitbox preset helpers for RocketSim WASM.
 */

import { validateAssetResponse, resolveAssetPath } from '../utils/AssetResponseValidator.js';
import { resolveHitboxIndex } from '../ui-core/config/vehicleConstants.js';

export const PLAYER_CAR_INDEX = 0;
export const BOT_CAR_INDEX = 1;
export const ARENA_MESH_MANIFEST_PATH = '/arenamesh/manifest.json';
export const THROWBACK_MESH_BASE_DIR = '/arenamesh/throwback_stadium';
export const THROWBACK_MESH_MANIFEST_PATH = '/arenamesh/throwback_stadium/manifest.json';

export function getTeamAssignment(_isFlatCar) {
  return { playerTeam: 0, botTeam: 1 };
}

/**
 * Resolves Rocket League hitbox preset indices for WASM bridge:
 * 0: Octane, 1: Dominus, 2: Plank (Batmobile), 3: Breakout, 4: Hybrid, 5: Merc, 6: Psyclops (Three-Wheeler)
 * @param {string|number} hitboxType
 * @returns {number}
 */
export function getHitboxIndex(hitboxType) {
  return resolveHitboxIndex(hitboxType);
}

export async function fetchArenaCollisionManifest(manifestPath = ARENA_MESH_MANIFEST_PATH) {
  const manifestUrl = resolveAssetPath(manifestPath);
  const manifestRes = await fetch(manifestUrl);
  const manifestCheck = validateAssetResponse(manifestRes, manifestUrl, 'json');
  if (!manifestCheck.ok) throw manifestCheck.error;
  return manifestRes.json();
}

export async function fetchArenaCollisionChunks(chunkFilenames, options = {}) {
  const { fetchBuffer = null, onChunkLoaded = null, baseDir = '/arenamesh' } = options;
  const total = chunkFilenames.length;
  let completed = 0;

  return Promise.all(
    chunkFilenames.map(async (chunkFile) => {
      const chunkPath = resolveAssetPath(`${baseDir}/${chunkFile}`);
      let arrayBuffer;
      if (typeof fetchBuffer === 'function') {
        arrayBuffer = await fetchBuffer(chunkPath);
      } else {
        const chunkRes = await fetch(chunkPath);
        const chunkCheck = validateAssetResponse(chunkRes, chunkPath, 'cmf');
        if (!chunkCheck.ok) throw chunkCheck.error;
        arrayBuffer = await chunkRes.arrayBuffer();
      }
      completed++;
      if (typeof onChunkLoaded === 'function') {
        onChunkLoaded(completed, total, chunkFile);
      }
      return new Uint8Array(arrayBuffer);
    })
  );
}

export async function fetchArenaCollisionMeshes(cachedCollisionData = null, options = {}) {
  if (cachedCollisionData) return cachedCollisionData;
  const manifestPath = options.manifestPath || ARENA_MESH_MANIFEST_PATH;
  const chunkFilenames = await fetchArenaCollisionManifest(manifestPath);
  return fetchArenaCollisionChunks(chunkFilenames, options);
}

export function initWasmCollisionMeshes(module, collisionData) {
  const totalBytes = collisionData.reduce((acc, chunk) => acc + chunk.length, 0);
  const dataPtr = module._malloc(totalBytes);
  const sizesPtr = module._malloc(collisionData.length * 4);

  let byteOffset = 0;
  collisionData.forEach((chunk, idx) => {
    module.HEAPU8.set(chunk, dataPtr + byteOffset);
    module.HEAP32[sizesPtr / 4 + idx] = chunk.length;
    byteOffset += chunk.length;
  });

  const initResult = module._physics_init(dataPtr, sizesPtr, collisionData.length);
  module._free(dataPtr);
  module._free(sizesPtr);

  if (initResult !== 1) {
    throw new Error('Physics initialization failed — check collision meshes');
  }
}
