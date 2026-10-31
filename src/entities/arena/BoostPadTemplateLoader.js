import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { resolveAssetPath } from '../../utils/AssetResponseValidator.js';

export const BOOST_PAD_ASSET_URLS = Object.freeze({
  smallBase: '/assets/arena/pads/BoostPad_Small_Base.glb',
  smallGlow: '/assets/arena/pads/BoostPad_Small_Glow.glb',
  largeBase: '/assets/arena/pads/BoostPad_Large_Base.glb',
  largeGlow: '/assets/arena/pads/BoostPad_Large_Glow.glb',
});

/**
 * Loads authentic GLTF/GLB models, supporting decoupled Base + Glow architecture
 * with discrete material slots for Top, Side, and Base surfaces.
 */
export async function loadBoostPadTemplates(system) {
  const loader = new GLTFLoader();
  const padPaths = {
    smallBase: [
      BOOST_PAD_ASSET_URLS.smallBase
    ],
    smallGlow: [
      BOOST_PAD_ASSET_URLS.smallGlow
    ],
    bigBase: [
      BOOST_PAD_ASSET_URLS.largeBase
    ],
    bigGlow: [
      BOOST_PAD_ASSET_URLS.largeGlow
    ]
  };

  const loadCandidate = async (candidates) => {
    for (const p of candidates) {
      try {
        const gltf = await loader.loadAsync(resolveAssetPath(p));
        if (gltf?.scene) return gltf.scene;
      } catch (err) {
        console.warn('[BoostPadSystem] Candidate pad GLB load skipped:', p, err?.message || err);
      }
    }
    return null;
  };

  try {
    const [smallBase, smallGlow, bigBase, bigGlow] = await Promise.all([
      loadCandidate(padPaths.smallBase),
      loadCandidate(padPaths.smallGlow),
      loadCandidate(padPaths.bigBase),
      loadCandidate(padPaths.bigGlow)
    ]);

    if (!smallBase || !smallGlow || !bigBase || !bigGlow) {
      console.warn('[BoostPadSystem] Decoupled pad GLBs missing, checking legacy containers');
      return null;
    }

    for (const model of [smallBase, smallGlow, bigBase, bigGlow]) {
      model.scale.setScalar(100);
    }

    let measuredPeakY = 6.6614;
    bigBase.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = true;
        if (child.name === 'BoostPad_Large') {
          child.geometry.computeBoundingBox();
          measuredPeakY = child.geometry.boundingBox.max.y * 100;
        }
      }
    });
    system.padPeakY = measuredPeakY;

    const orbGeo = new THREE.SphereGeometry(1, 32, 24);
    const orbMesh = new THREE.Mesh(orbGeo, system.sharedOrbMaterial);
    orbMesh.name = 'BoostFloatingOrb';
    orbMesh.scale.setScalar(system.tunerConfig.orbRadius);
    orbMesh.position.set(0, system.padPeakY + system.tunerConfig.orbHeightOffset, 0);

    const bigFull = new THREE.Group();
    bigFull.add(bigBase.clone(true), bigGlow.clone(true), orbMesh);

    const smallFull = new THREE.Group();
    smallFull.add(smallBase.clone(true), smallGlow.clone(true));

    system.padTemplates = {
      bigFull,
      bigBase,
      bigGlow,
      smallFull,
      smallBase,
      smallGlow
    };

    return system.padTemplates;
  } catch (err) {
    console.warn('[BoostPadSystem] Failed to load GLB pad templates:', err);
    return null;
  }
}

export function disposeBoostPadSystem(system) {
  system.collectAnimations.clear();
  for (const pad of system.pads) {
    if (pad.group?.parent) {
      pad.group.parent.remove(pad.group);
    }
    pad.full?.traverse?.(obj => {
      if (obj.geometry?.dispose) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m?.dispose?.());
        else obj.material.dispose?.();
      }
    });
    pad.base?.traverse?.(obj => {
      if (obj.geometry?.dispose) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m?.dispose?.());
        else obj.material.dispose?.();
      }
    });
    if (pad.glowMaterial?.dispose) pad.glowMaterial.dispose();
  }
  system.pads.length = 0;
  system.bigOrbs.length = 0;
  system.bigShadows.length = 0;
}
