/**
 * ThrowbackStadiumLoader.js
 * On-demand GLB loader for Throwback Stadium visual field and collision mesh overlay
 * (used by the Developer -> Under Development workspace).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { resolveAssetPath } from '../../utils/AssetResponseValidator.js';

export const THROWBACK_FIELD_GLB_URL = '/assets/arena/ThrowbackHockey_Field.glb';
export const THROWBACK_COLLISION_GLB_URL = '/assets/arena/ThrowbackStadium_Collision.glb';

export async function loadThrowbackStadiumField() {
  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(resolveAssetPath(THROWBACK_FIELD_GLB_URL));
    if (!gltf?.scene) return null;
    const stadium = gltf.scene;
    stadium.name = 'Stadium / Throwback Hockey Field';
    stadium.scale.setScalar(100);

    stadium.traverse((obj) => {
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
    return stadium;
  } catch (err) {
    console.error('[ThrowbackStadiumLoader] Failed to load ThrowbackHockey_Field.glb:', err);
    return null;
  }
}

export async function loadThrowbackCollisionOverlay() {
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

    collisionRoot.traverse((obj) => {
      if (obj.isMesh) {
        obj.material = wireMat;
        obj.castShadow = false;
        obj.receiveShadow = false;
        obj.renderOrder = 3;
      }
    });
    return collisionRoot;
  } catch (err) {
    console.error('[ThrowbackStadiumLoader] Failed to load ThrowbackStadium_Collision.glb:', err);
    return null;
  }
}
