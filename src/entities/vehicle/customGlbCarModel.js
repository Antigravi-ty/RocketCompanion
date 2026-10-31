import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  FENNEC_DESCRIPTOR,
  getVehicleDescriptor,
  vehicleTunerRuntimeFlags,
  getVehicleTunerRuntimeFlags,
  setVehicleTunerRuntimeFlags,
  DEFAULT_WHEEL_MODIFIER_CONFIG,
  wheelModifierRuntimeConfig,
  getWheelModifierConfig,
  setWheelModifierConfig,
  recomputeDescriptorBoostOutlets,
} from '../../ui-core/config/vehicleTunerConfig.js';
import {
  createCarPaintMaterial,
} from './vehiclePaintMaterial.js';
import {
  createMultiThemeMaterial,
  createCelShadedToonMaterial,
  registerThemeSubtree
} from '../../effects/ThemeMaterialPipeline.js';
import { getMaterialsConfig } from '../../ui-core/config/materialsConfig.js';
import { resolveAssetPath } from '../../utils/AssetResponseValidator.js';

const cachedCustomAssets = new Map();

import {
  buildCustomToonRampTexture
} from './vehicleTunerState.js';

import {
  createProceduralSportWheel,
  updateVehicleBrakeLamps
} from './vehicleWheelsAndLamps.js';

/**
 * Splits a single geometry primitive containing both front (X >= 0) and rear (X < 0)
 * lamp triangles into two separate BufferGeometries.
 */
function splitLampGeometryByX(geometry) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return null;

  const normAttr = geometry.getAttribute('normal');
  const uvAttr = geometry.getAttribute('uv');
  const indexAttr = geometry.index;

  const frontIndices = [];
  const rearIndices = [];

  const getX = (vertIdx) => (
    posAttr.getX ? posAttr.getX(vertIdx) : posAttr.array[vertIdx * 3]
  );

  if (indexAttr) {
    const count = indexAttr.count;
    for (let i = 0; i < count; i += 3) {
      const a = indexAttr.getX ? indexAttr.getX(i) : indexAttr.array[i];
      const b = indexAttr.getX ? indexAttr.getX(i + 1) : indexAttr.array[i + 1];
      const c = indexAttr.getX ? indexAttr.getX(i + 2) : indexAttr.array[i + 2];
      const cx = (getX(a) + getX(b) + getX(c)) / 3;
      if (cx >= 0) {
        frontIndices.push(a, b, c);
      } else {
        rearIndices.push(a, b, c);
      }
    }
  } else {
    const count = posAttr.count;
    for (let i = 0; i < count; i += 3) {
      const cx = (getX(i) + getX(i + 1) + getX(i + 2)) / 3;
      if (cx >= 0) {
        frontIndices.push(i, i + 1, i + 2);
      } else {
        rearIndices.push(i, i + 1, i + 2);
      }
    }
  }

  const buildSubGeometry = (indices) => {
    if (indices.length === 0) return null;
    const subGeom = new THREE.BufferGeometry();
    const posOut = new Float32Array(indices.length * 3);
    const normOut = normAttr ? new Float32Array(indices.length * 3) : null;
    const uvOut = uvAttr ? new Float32Array(indices.length * 2) : null;

    for (let i = 0; i < indices.length; i++) {
      const vIdx = indices[i];
      posOut[i * 3] = posAttr.getX ? posAttr.getX(vIdx) : posAttr.array[vIdx * 3];
      posOut[i * 3 + 1] = posAttr.getY ? posAttr.getY(vIdx) : posAttr.array[vIdx * 3 + 1];
      posOut[i * 3 + 2] = posAttr.getZ ? posAttr.getZ(vIdx) : posAttr.array[vIdx * 3 + 2];

      if (normOut && normAttr) {
        normOut[i * 3] = normAttr.getX ? normAttr.getX(vIdx) : normAttr.array[vIdx * 3];
        normOut[i * 3 + 1] = normAttr.getY ? normAttr.getY(vIdx) : normAttr.array[vIdx * 3 + 1];
        normOut[i * 3 + 2] = normAttr.getZ ? normAttr.getZ(vIdx) : normAttr.array[vIdx * 3 + 2];
      }
      if (uvOut && uvAttr) {
        uvOut[i * 2] = uvAttr.getX ? uvAttr.getX(vIdx) : uvAttr.array[vIdx * 2];
        uvOut[i * 2 + 1] = uvAttr.getY ? uvAttr.getY(vIdx) : uvAttr.array[vIdx * 2 + 1];
      }
    }

    subGeom.setAttribute('position', new THREE.BufferAttribute(posOut, 3));
    if (normOut) {
      subGeom.setAttribute('normal', new THREE.BufferAttribute(normOut, 3));
    } else {
      subGeom.computeVertexNormals?.();
    }
    if (uvOut) {
      subGeom.setAttribute('uv', new THREE.BufferAttribute(uvOut, 2));
    }
    subGeom.computeBoundingBox?.();
    subGeom.computeBoundingSphere?.();
    return subGeom;
  };

  return {
    frontGeometry: buildSubGeometry(frontIndices),
    rearGeometry: buildSubGeometry(rearIndices)
  };
}

/**
 * Normalizes a loaded GLTF scene for custom vehicles:
 * - Preserves original material slot names on every Mesh.
 * - Automatically splits combined `lamps` / `lamps.001` meshes into `FrontBulb` and `BackBulb`.
 */
function normalizeCustomVehicleScene(scene, vehicleId) {
  const rawBox = new THREE.Box3().setFromObject(scene);
  const rawSize = new THREE.Vector3();
  rawBox.getSize(rawSize);
  if (rawSize.length() > 0 && rawSize.length() < 10) {
    const scaledGeometries = new Set();
    scene.traverse?.((node) => {
      if (node.isMesh && node.geometry && !scaledGeometries.has(node.geometry)) {
        scaledGeometries.add(node.geometry);
        node.geometry.scale(100, 100, 100);
        node.geometry.computeBoundingBox?.();
        node.geometry.computeBoundingSphere?.();
      }
    });
  }

  const meshesToSplit = [];
  scene.traverse?.((node) => {
    if (!node.isMesh) return;
    const matName = Array.isArray(node.material)
      ? (node.material[0]?.name || '')
      : (node.material?.name || '');
    node.userData.originalMaterialName = matName;
    node.userData.vehicleId = vehicleId;

    const lowerMat = matName.toLowerCase();
    if (matName === 'lamps.001' || (lowerMat.includes('lamp') && lowerMat !== 'frontbulb' && lowerMat !== 'backbulb')) {
      meshesToSplit.push(node);
    }
  });

  for (const lampMesh of meshesToSplit) {
    const split = splitLampGeometryByX(lampMesh.geometry);
    if (!split) continue;
    const parent = lampMesh.parent || scene;

    if (split.frontGeometry) {
      const frontMat = new THREE.MeshBasicMaterial({ name: 'FrontBulb', toneMapped: false });
      const frontMesh = new THREE.Mesh(split.frontGeometry, frontMat);
      frontMesh.name = `${vehicleId}-front-lamps`;
      frontMesh.userData.originalMaterialName = 'FrontBulb';
      frontMesh.userData.vehicleId = vehicleId;
      frontMesh.position.copy(lampMesh.position);
      frontMesh.quaternion.copy(lampMesh.quaternion);
      frontMesh.scale.copy(lampMesh.scale);
      parent.add(frontMesh);
    }

    if (split.rearGeometry) {
      const rearMat = new THREE.MeshBasicMaterial({ name: 'BackBulb', toneMapped: false });
      const rearMesh = new THREE.Mesh(split.rearGeometry, rearMat);
      rearMesh.name = `${vehicleId}-tail-lamps`;
      rearMesh.userData.originalMaterialName = 'BackBulb';
      rearMesh.userData.vehicleId = vehicleId;
      rearMesh.position.copy(lampMesh.position);
      rearMesh.quaternion.copy(lampMesh.quaternion);
      rearMesh.scale.copy(lampMesh.scale);
      parent.add(rearMesh);
    }

    parent.remove(lampMesh);
  }

  return scene;
}

/**
 * Loads a custom GLB vehicle asset registered in vehicleDescriptors.
 */
export async function loadCustomGlbCarAsset(vehicleId) {
  const id = String(vehicleId || '').toLowerCase();
  if (cachedCustomAssets.has(id)) {
    return cachedCustomAssets.get(id);
  }
  const descriptor = getVehicleDescriptor(id);
  if (!descriptor || !descriptor.modelUrl) {
    throw new Error(`Unknown custom GLB vehicle descriptor for "${vehicleId}"`);
  }

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(resolveAssetPath(descriptor.modelUrl));
  gltf.scene.updateMatrixWorld?.(true);
  normalizeCustomVehicleScene(gltf.scene, id);

  const asset = {
    id,
    scene: gltf.scene
  };
  cachedCustomAssets.set(id, asset);
  return asset;
}

import { applyCustomGlbVehicleMaterials } from './customGlbVehicleMaterials.js';
export { applyCustomGlbVehicleMaterials };

/**
 * Updates boost nozzle gizmo positions on a custom vehicle model.
 */
export function syncCustomVehicleNozzleGizmos(carModelRoot, descriptor) {
  if (!carModelRoot || !descriptor) return;
  let gizmoGroup = carModelRoot.getObjectByName?.('boost-nozzle-gizmos');
  if (!gizmoGroup) {
    gizmoGroup = new THREE.Group();
    gizmoGroup.name = 'boost-nozzle-gizmos';
    const sphereGeom = new THREE.SphereGeometry(2.2, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      wireframe: true,
      toneMapped: false,
      depthTest: false
    });
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(sphereGeom, sphereMat);
      m.name = 'boost-nozzle-gizmo';
      m.renderOrder = 120;
      gizmoGroup.add(m);
    }
    carModelRoot.add(gizmoGroup);
  }

  gizmoGroup.visible = Boolean(vehicleTunerRuntimeFlags.showNozzleGizmos);
  const outlets = descriptor.boostOutlets || [];
  for (let i = 0; i < gizmoGroup.children.length; i++) {
    const child = gizmoGroup.children[i];
    const coord = outlets[i];
    if (coord) {
      child.position.set(coord[0], coord[1], coord[2]);
      child.visible = Boolean(vehicleTunerRuntimeFlags.showNozzleGizmos);
    } else {
      child.visible = false;
    }
  }
}

/**
 * Instantiates a Fennec or Insidio 3D model hierarchy with alignment transforms and materials.
 */
export function createCustomGlbCarModel(vehicleId, asset, teamColor) {
  const descriptor = getVehicleDescriptor(vehicleId) || FENNEC_DESCRIPTOR;
  const root = new THREE.Group();
  root.name = descriptor.id;
  root.userData.vehicleId = descriptor.id;

  const shell = new THREE.Group();
  shell.name = `${descriptor.id}-shell`;

  const align = descriptor.alignment || { scale: 1, scaleX: 1, scaleY: 1, scaleZ: 1, centerOffset: [0, 0, 0] };
  const s = align.scale ?? 1;
  shell.scale.set(
    s * (align.scaleX ?? 1),
    s * (align.scaleY ?? 1),
    s * (align.scaleZ ?? 1)
  );
  const [ox = 0, oy = 0, oz = 0] = align.centerOffset || [0, 0, 0];
  shell.position.set(ox, oy, oz);

  if (asset && asset.scene) {
    const clonedScene = asset.scene.clone(true);
    // Preserve userData across clone
    const srcMeshes = [];
    const dstMeshes = [];
    asset.scene.traverse?.((n) => { if (n.isMesh) srcMeshes.push(n); });
    clonedScene.traverse?.((n) => { if (n.isMesh) dstMeshes.push(n); });
    for (let i = 0; i < dstMeshes.length && i < srcMeshes.length; i++) {
      dstMeshes[i].userData = { ...srcMeshes[i].userData };
    }
    shell.add(clonedScene);
  }

  root.add(shell);
  recomputeDescriptorBoostOutlets(descriptor);
  syncCustomVehicleNozzleGizmos(root, descriptor);
  applyCustomGlbVehicleMaterials(root, descriptor.id, teamColor);
  return root;
}

/**
 * Live-updates an instantiated carRoot in the Arena when parameters are tweaked in the Floating Window.
 */
export function applyLiveVehicleDescriptorUpdate(carRoot, carHitbox, carWheels, carBoosts, descriptor, teamColor, paintFinish = null) {
  if (!carRoot || !descriptor) return;

  const bodyMesh = carRoot.children?.find((c) => c.name === 'car-body-mesh');
  const resolvedColor = teamColor ?? bodyMesh?.userData?.teamColor ?? 0x42a5f5;
  if (bodyMesh) {
    const shell = bodyMesh.getObjectByName?.(`${descriptor.id}-shell`) || bodyMesh.children?.[0];
    if (shell && descriptor.alignment) {
      const s = descriptor.alignment.scale ?? 1;
      shell.scale.set(
        s * (descriptor.alignment.scaleX ?? 1),
        s * (descriptor.alignment.scaleY ?? 1),
        s * (descriptor.alignment.scaleZ ?? 1)
      );
      const [ox = 0, oy = 0, oz = 0] = descriptor.alignment.centerOffset || [0, 0, 0];
      shell.position.set(ox, oy, oz);
    }
    recomputeDescriptorBoostOutlets(descriptor);
    syncCustomVehicleNozzleGizmos(bodyMesh, descriptor);
    applyCustomGlbVehicleMaterials(bodyMesh, descriptor.id, resolvedColor, paintFinish);
  }

  if (Array.isArray(carBoosts) && Array.isArray(descriptor.boostOutlets)) {
    for (let i = 0; i < carBoosts.length && i < descriptor.boostOutlets.length; i++) {
      const [bx, by, bz] = descriptor.boostOutlets[i];
      if (carBoosts[i]?.setNozzleOffset) {
        carBoosts[i].setNozzleOffset(bx, by, bz);
      } else if (carBoosts[i]?.offset) {
        carBoosts[i].offset.set(bx, by, bz);
      }
    }
  }

  if (Array.isArray(carWheels) && Array.isArray(descriptor.wheelAnchors)) {
    const extraY = Number(wheelModifierRuntimeConfig.verticalOffsetY) || 0;
    for (let i = 0; i < carWheels.length && i < descriptor.wheelAnchors.length; i++) {
      const [wx, wz, wr] = descriptor.wheelAnchors[i];
      const restY = (descriptor.suspensionHeights?.[i] ?? (wr - 17)) + extraY;
      if (carWheels[i]?.steer) {
        carWheels[i].steer.position.set(wx, restY, wz);
      }
      if (carWheels[i]?.spin) {
        const spinGroup = carWheels[i].spin;
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
        spinGroup.add(createProceduralSportWheel(wr || 13.5, resolvedColor, i));
      }
    }
  }
}
