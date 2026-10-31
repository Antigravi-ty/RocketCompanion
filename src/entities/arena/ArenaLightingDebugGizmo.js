/**
 * ArenaLightingDebugGizmo.js
 * 3D light-source ray, sun position sphere, and sky-dome direction beacon visualizer
 * for ArenaLightingManager.
 */

import * as THREE from 'three';

export function ensureLightingDebugGizmoGroup(lighting) {
  if (lighting.debugGroup) return lighting.debugGroup;

  const group = new THREE.Group();
  group.name = 'ArenaLightingDebugGizmo';
  group.frustumCulled = false;

  const depthTest = Boolean(lighting.shadowConfig.lightGizmoDepthTest);

  const sunLineGeo = new THREE.BufferGeometry();
  sunLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const sunLineMat = new THREE.LineBasicMaterial({
    color: 0xffdd33,
    transparent: true,
    opacity: 0.95,
    depthTest,
    depthWrite: false,
  });
  lighting.sunRayLine = new THREE.Line(sunLineGeo, sunLineMat);
  lighting.sunRayLine.frustumCulled = false;
  lighting.sunRayLine.renderOrder = 999;

  const sunSphereGeo = new THREE.SphereGeometry(140, 16, 12);
  const sunSphereMat = new THREE.MeshBasicMaterial({
    color: 0xffe047,
    transparent: true,
    opacity: 0.95,
    depthTest,
    depthWrite: false,
  });
  lighting.sunMarkerSphere = new THREE.Mesh(sunSphereGeo, sunSphereMat);
  lighting.sunMarkerSphere.renderOrder = 1000;

  const sunRingGeo = new THREE.RingGeometry(210, 260, 32);
  const sunRingMat = new THREE.MeshBasicMaterial({
    color: 0xff8800,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthTest,
    depthWrite: false,
  });
  lighting.sunMarkerRing = new THREE.Mesh(sunRingGeo, sunRingMat);
  lighting.sunMarkerRing.renderOrder = 1000;
  lighting.sunMarkerSphere.add(lighting.sunMarkerRing);

  const skyBeaconGeo = new THREE.RingGeometry(420, 560, 32);
  const skyBeaconMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthTest,
    depthWrite: false,
  });
  lighting.skyDomeBeaconRing = new THREE.Mesh(skyBeaconGeo, skyBeaconMat);
  lighting.skyDomeBeaconRing.renderOrder = 998;

  const keyLineGeo = new THREE.BufferGeometry();
  keyLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const keyLineMat = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.85,
    depthTest,
    depthWrite: false,
  });
  lighting.keyLightRayLine = new THREE.Line(keyLineGeo, keyLineMat);
  lighting.keyLightRayLine.frustumCulled = false;
  lighting.keyLightRayLine.renderOrder = 998;

  const keySphereGeo = new THREE.SphereGeometry(95, 12, 10);
  const keySphereMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.9,
    depthTest,
    depthWrite: false,
  });
  lighting.keyLightMarkerSphere = new THREE.Mesh(keySphereGeo, keySphereMat);
  lighting.keyLightMarkerSphere.renderOrder = 999;

  group.add(
    lighting.sunRayLine,
    lighting.sunMarkerSphere,
    lighting.skyDomeBeaconRing,
    lighting.keyLightRayLine,
    lighting.keyLightMarkerSphere
  );

  lighting.debugGroup = group;
  lighting.scene.add(group);
  return group;
}

export function updateLightingDebugGizmoDepthTest(lighting) {
  if (!lighting.debugGroup) return;
  const depthTest = Boolean(lighting.shadowConfig.lightGizmoDepthTest);
  lighting.debugGroup.traverse((child) => {
    if (child.material) {
      child.material.depthTest = depthTest;
      child.material.needsUpdate = true;
    }
  });
}

export function updateLightingDebugVisuals(lighting, cars, ball, camera = null) {
  const showSun = Boolean(lighting.shadowConfig.showLightGizmo);
  const showKey = Boolean(lighting.shadowConfig.showKeyLightGizmo);
  if (!showSun && !showKey) {
    if (lighting.debugGroup) lighting.debugGroup.visible = false;
    return;
  }

  const group = ensureLightingDebugGizmoGroup(lighting);
  group.visible = true;

  const originMode = lighting.shadowConfig.lightRayOrigin || 'car';
  const origin = lighting._rayOriginPos.set(0, 20, 0);
  if (originMode === 'camera' && camera?.position) {
    origin.copy(camera.position);
    if (typeof camera.getWorldDirection === 'function') {
      camera.getWorldDirection(lighting._camForward);
      lighting._camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      origin.addScaledVector(lighting._camForward, 85).addScaledVector(lighting._camUp, -28);
    } else {
      origin.y -= 25;
    }
  } else if (originMode === 'ball' && ball?.position) {
    origin.copy(ball.position);
  } else if (originMode === 'car' && cars?.[0]?.position) {
    origin.copy(cars[0].position);
    origin.y += 35;
  }

  lighting.sunRayLine.visible = showSun;
  lighting.sunMarkerSphere.visible = showSun;
  lighting.skyDomeBeaconRing.visible = showSun;

  if (showSun) {
    const sunPos = lighting.carSun.position;
    const farSkyPosX = origin.x + lighting._shadowDir.x * 18000;
    const farSkyPosY = origin.y + lighting._shadowDir.y * 18000;
    const farSkyPosZ = origin.z + lighting._shadowDir.z * 18000;

    const posAttr = lighting.sunRayLine.geometry.getAttribute('position');
    posAttr.setXYZ(0, origin.x, origin.y, origin.z);
    posAttr.setXYZ(1, sunPos.x, sunPos.y, sunPos.z);
    posAttr.setXYZ(2, farSkyPosX, farSkyPosY, farSkyPosZ);
    posAttr.needsUpdate = true;
    lighting.sunRayLine.geometry.computeBoundingSphere();

    lighting.sunMarkerSphere.position.copy(sunPos);
    if (camera?.position) {
      lighting.sunMarkerRing.lookAt(camera.position);
    }

    lighting.skyDomeBeaconRing.position.set(farSkyPosX, farSkyPosY, farSkyPosZ);
    lighting.skyDomeBeaconRing.lookAt(origin);
  }

  lighting.keyLightRayLine.visible = showKey;
  lighting.keyLightMarkerSphere.visible = showKey;
  if (showKey && lighting.keyLight) {
    const keyPos = lighting.keyLight.position;
    const keyAttr = lighting.keyLightRayLine.geometry.getAttribute('position');
    keyAttr.setXYZ(0, origin.x, origin.y, origin.z);
    keyAttr.setXYZ(1, keyPos.x, keyPos.y, keyPos.z);
    keyAttr.needsUpdate = true;
    lighting.keyLightRayLine.geometry.computeBoundingSphere();
    lighting.keyLightMarkerSphere.position.copy(keyPos);
  }
}
