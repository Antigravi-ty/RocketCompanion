/**
 * ThrowbackStadiumLoader.ts
 * On-demand GLB loader for Throwback Stadium visual field and collision mesh overlay
 * (used by the Developer -> Under Development workspace).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { resolveAssetPath } from '../../utils/AssetResponseValidator.ts';

export const THROWBACK_FIELD_GLB_URL = '/assets/arena/ThrowbackHockey_Field.glb';
export const THROWBACK_COLLISION_GLB_URL = '/assets/arena/ThrowbackStadium_Collision.glb';

let cachedFieldTemplate: THREE.Group | null = null;
let cachedFieldPromise: Promise<THREE.Group | null> | null = null;
let cachedCollisionTemplate: THREE.Group | null = null;
let cachedCollisionPromise: Promise<THREE.Group | null> | null = null;

export async function loadThrowbackStadiumField(): Promise<THREE.Group | null> {
  if (cachedFieldTemplate) {
    return cachedFieldTemplate.clone(true);
  }
  if (!cachedFieldPromise) {
    cachedFieldPromise = (async () => {
      const loader = new GLTFLoader();
      try {
        const gltf = await loader.loadAsync(resolveAssetPath(THROWBACK_FIELD_GLB_URL));
        if (!gltf?.scene) return null;
        const stadium = gltf.scene;
        stadium.name = 'Stadium / Throwback Hockey Field';
        stadium.scale.setScalar(100);

        stadium.traverse((obj: any) => {
          if (obj.name && obj.name.startsWith('BoostPad')) {
            obj.visible = false;
          }
          if (obj.isMesh) {
            if (obj.name && obj.name.startsWith('BoostPad')) {
              obj.visible = false;
            }
            obj.castShadow = false;
            obj.receiveShadow = true;
          }
        });
        cachedFieldTemplate = stadium;
        return stadium;
      } catch (err) {
        console.error('[ThrowbackStadiumLoader] Failed to load ThrowbackHockey_Field.glb:', err);
        return null;
      } finally {
        cachedFieldPromise = null;
      }
    })();
  }

  const template = await cachedFieldPromise;
  return template ? template.clone(true) : null;
}

export async function loadThrowbackCollisionOverlay(): Promise<THREE.Group | null> {
  if (cachedCollisionTemplate) {
    return cachedCollisionTemplate.clone(true);
  }
  if (!cachedCollisionPromise) {
    cachedCollisionPromise = (async () => {
      const loader = new GLTFLoader();
      try {
        const gltf = await loader.loadAsync(resolveAssetPath(THROWBACK_COLLISION_GLB_URL));
        if (!gltf?.scene) return null;
        const collisionRoot = gltf.scene;
        collisionRoot.name = 'Stadium / Throwback Collision Overlay';
        collisionRoot.scale.setScalar(100);

        const wireMat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          wireframe: true,
          transparent: true,
          opacity: 0.35,
          depthWrite: false
        });

        collisionRoot.traverse((obj: any) => {
          if (obj.isMesh) {
            obj.material = wireMat;
            obj.castShadow = false;
            obj.receiveShadow = false;
            obj.renderOrder = 3;
          }
        });
        cachedCollisionTemplate = collisionRoot;
        return collisionRoot;
      } catch (err) {
        console.error('[ThrowbackStadiumLoader] Failed to load ThrowbackStadium_Collision.glb:', err);
        return null;
      } finally {
        cachedCollisionPromise = null;
      }
    })();
  }

  const template = await cachedCollisionPromise;
  return template ? template.clone(true) : null;
}

export async function preloadThrowbackStadiumAssets(): Promise<void> {
  await Promise.all([
    loadThrowbackStadiumField(),
    loadThrowbackCollisionOverlay(),
  ]);
}
