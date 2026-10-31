/**
 * DriftwoodsStadiumLoader.js
 * Loads the Driftwoods stadium 3D GLB scene and aligns ground UV coordinates.
 */

import {
  LinearFilter,
  LinearMipmapLinearFilter,
  MirroredRepeatWrapping,
  NoColorSpace,
  TextureLoader
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { resolveAssetPath } from '../../../utils/AssetResponseValidator.js';

export const DRIFTWOODS_GLB_URL = '/assets/arena/driftwoods.glb';
export const DRIFTWOODS_Q1_GROUND_TEXTURE_URL = '/assets/arena/ground_q1_7gray_2048x3000.webp';

/**
 * Loads the Q1 7-layer grayscale ground mask texture (2048x3000).
 * Configured with flipY = false so top-left (u=0, v=0) maps to (X=0, Y=0)
 * and bottom-right (u=1, v=1) maps to (X=4096 UU, Y=6000 UU), with MirroredRepeatWrapping.
 */
export async function loadDriftwoodsQ1GroundTexture() {
  const texLoader = new TextureLoader();
  try {
    const tex = await texLoader.loadAsync(resolveAssetPath(DRIFTWOODS_Q1_GROUND_TEXTURE_URL));
    tex.name = 'Ground_Q1_7Gray_2048x3000';
    tex.flipY = false;
    tex.colorSpace = NoColorSpace;
    tex.wrapS = MirroredRepeatWrapping;
    tex.wrapT = MirroredRepeatWrapping;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  } catch (err) {
    console.warn(`[DriftwoodsStadiumLoader] Failed to load Q1 7-gray ground texture:`, err);
    return null;
  }
}

/**
 * Loads the Driftwoods stadium GLB model.
 */
export async function loadDriftwoodsStadium() {
  const loader = new GLTFLoader();
  let gltf = null;
  const candidatePaths = [
    DRIFTWOODS_GLB_URL
  ];

  const q1TexturePromise = loadDriftwoodsQ1GroundTexture();

  for (const path of candidatePaths) {
    try {
      gltf = await loader.loadAsync(resolveAssetPath(path));
      if (gltf?.scene) break;
    } catch (err) {
      console.warn(`[DriftwoodsStadiumLoader] Failed to load Driftwoods arena GLTF from "${path}":`, err);
    }
  }

  if (!gltf?.scene) {
    console.error('[DriftwoodsStadiumLoader] All Driftwoods arena candidate paths failed to load:', candidatePaths);
    return null;
  }

  const q1GroundTexture = await q1TexturePromise;

  const stadium = gltf.scene;
  stadium.name = 'Stadium / Driftwoods Arena';
  stadium.scale.setScalar(100);
  if (q1GroundTexture) {
    stadium.userData.q1GroundTexture = q1GroundTexture;
  }

  stadium.traverse((obj) => {
    if (obj.name === 'BoostPads_Combined_Base') {
      obj.visible = false;
    }
    if (obj.isMesh) {
      if (obj.name === 'BoostPads_Combined_Base') {
        obj.visible = false;
      }
      obj.castShadow = false;
      obj.receiveShadow = true;
      obj.frustumCulled = false;
      if (obj.name === 'Woods_Field_Ground') {
        alignWoodsFieldGroundTexture(obj);
        if (q1GroundTexture) {
          obj.userData.q1GroundTexture = q1GroundTexture;
        }
      } else if (obj.name === 'Woods_Field_Walls_Hexes') {
        normalizeWoodsFieldHexNormals(obj);
      }
    }
  });

  return stadium;
}

/**
 * Normalizes Woods_Field_Walls_Hexes vertex normals so every hexagon ribbon bar
 * faces smoothly inward toward the arena interior spine. The raw GLB has 8,776
 * vertices with sideways ribbon-edge or outward-facing normals, which caused
 * Lambert/Standard directional lighting and view-angle calculations to drop to 0
 * when the car or camera flew into the air.
 */
export function normalizeWoodsFieldHexNormals(mesh) {
  const pos = mesh?.geometry?.attributes?.position;
  const norm = mesh?.geometry?.attributes?.normal;
  if (!pos || !norm) return;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    // Arena interior spine in local GLB coordinates (1 unit = 100 UU)
    const targetX = 0.0;
    const targetY = Math.min(y, 10.0);
    const targetZ = Math.max(-35.0, Math.min(35.0, z));

    let nx = targetX - x;
    let ny = targetY - y;
    let nz = targetZ - z;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-5) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0.0;
      ny = -1.0;
      nz = 0.0;
    }
    norm.setXYZ(i, nx, ny, nz);
  }
  norm.needsUpdate = true;
}

/**
 * Automatically inspects and aligns Woods_Field_Ground texture mapping.
 */
export function alignWoodsFieldGroundTexture(mesh) {
  if (!mesh?.geometry?.attributes?.position || !mesh?.geometry?.attributes?.uv) return;
  const pos = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;

  const lineUMin = 0.192871;
  const lineUMax = 0.806640;
  const lineVMin = 0.082113;
  const lineVMax = 0.915665;

  let minX = Infinity, maxX = -Infinity;
  let minU = Infinity, maxU = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let minV = Infinity, maxV = -Infinity;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const u = uv.getX(i);
    const v = uv.getY(i);

    if (y < 0.05) {
      if (x < minX) { minX = x; minU = u; }
      if (x > maxX) { maxX = x; maxU = u; }
      if (Math.abs(x) < 8.95) {
        if (z < minZ) { minZ = z; minV = v; }
        if (z > maxZ) { maxZ = z; maxV = v; }
      }
    }
  }

  if (Math.abs(minU - lineUMin) < 0.005 && Math.abs(maxU - lineUMax) < 0.005) {
    return;
  }

  const repeatX = (lineUMax - lineUMin) / (maxU - minU);
  const offsetX = lineUMin - minU * repeatX;
  const repeatY = (lineVMax - lineVMin) / (maxV - minV);
  const offsetY = lineVMin - minV * repeatY;

  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * repeatX + offsetX, uv.getY(i) * repeatY + offsetY);
  }
  uv.needsUpdate = true;
}
