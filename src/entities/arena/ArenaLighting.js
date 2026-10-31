/**
 * ArenaLighting.js
 * Directional sunlight rigs, hemisphere environmental lighting,
 * texel-snapped dynamic shadow frustum tracking for vehicles and the ball,
 * and 3D light-source ray/gizmo visualization.
 */

import * as THREE from 'three';
import {
  DEFAULT_SUN_OFFSET_X,
  DEFAULT_SUN_OFFSET_Y,
  DEFAULT_SUN_OFFSET_Z,
  DEFAULT_SUN_DISTANCE,
  DEFAULT_SUN_AZIMUTH_DEG,
  DEFAULT_SUN_ELEVATION_DEG,
  shadowRuntimeConfig,
  normalizeShadowLightingPatch,
} from '../../ui-core/config/atmosphereFxConfig.js';

import {
  ensureLightingDebugGizmoGroup,
  updateLightingDebugGizmoDepthTest,
  updateLightingDebugVisuals,
} from './ArenaLightingDebugGizmo.js';

export class ArenaLightingManager {
  constructor(scene) {
    this.scene = scene;
    this.shadowFocus = new THREE.Vector3();
    this.shadowConfig = { ...shadowRuntimeConfig };
    this._numCars = 1;

    this.carSunTarget = new THREE.Group();
    this.ballSunTarget = new THREE.Group();
    this.opponentSunTarget = new THREE.Group();
    this.opponentSun = null;

    this.carSun = this.makeSubjectSun(this.carSunTarget, 260);
    this.ballSun = this.makeSubjectSun(this.ballSunTarget, 190);
    this.scene.add(this.carSunTarget, this.ballSunTarget, this.carSun, this.ballSun);

    this.hemiLight = new THREE.HemisphereLight(13164543, 2569000, 1.0);
    this.scene.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight(8956671, 0.5);
    this.keyLight.position.set(-2000, 2000, -2000);
    this.scene.add(this.keyLight);

    this._sunOffset = new THREE.Vector3(
      this.shadowConfig.sunOffsetX ?? DEFAULT_SUN_OFFSET_X,
      this.shadowConfig.sunOffsetY ?? DEFAULT_SUN_OFFSET_Y,
      this.shadowConfig.sunOffsetZ ?? DEFAULT_SUN_OFFSET_Z
    );
    this._shadowDir = this._sunOffset.clone().normalize();
    this._shadowX = new THREE.Vector3();
    this._shadowY = new THREE.Vector3();
    this._recomputeShadowBasis();

    this.debugGroup = null;
    this._rayOriginPos = new THREE.Vector3();
    this._camForward = new THREE.Vector3();
    this._camUp = new THREE.Vector3();

    this._applyLightRigMode();
    this._applyEnvironmentalLights();
  }

  _recomputeShadowBasis() {
    const ox = Number(this.shadowConfig.sunOffsetX) ?? DEFAULT_SUN_OFFSET_X;
    const oy = Math.max(50, Number(this.shadowConfig.sunOffsetY) ?? DEFAULT_SUN_OFFSET_Y);
    const oz = Number(this.shadowConfig.sunOffsetZ) ?? DEFAULT_SUN_OFFSET_Z;
    this._sunOffset.set(ox, oy, oz);
    if (this._sunOffset.lengthSq() < 1) {
      this._sunOffset.set(DEFAULT_SUN_OFFSET_X, DEFAULT_SUN_OFFSET_Y, DEFAULT_SUN_OFFSET_Z);
    }
    this._shadowDir.copy(this._sunOffset).normalize();
    const refUp = Math.abs(this._shadowDir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this._shadowX.copy(refUp).cross(this._shadowDir).normalize();
    this._shadowY.crossVectors(this._shadowDir, this._shadowX).normalize();
  }

  _applyEnvironmentalLights() {
    const c = this.shadowConfig;
    const sunHex = c.sunColor || '#ffffff';
    const sunSuns = [this.carSun, this.ballSun, this.opponentSun].filter(Boolean);
    for (const s of sunSuns) {
      s.color.set(sunHex);
    }

    if (this.keyLight) {
      this.keyLight.visible = c.keyLightEnabled !== false;
      this.keyLight.color.set(c.keyLightColor || '#88aadf');
      this.keyLight.intensity = Math.max(0, Number(c.keyLightIntensity) ?? 0.5);

      const mode = c.keyLightMode || 'fixed';
      if (mode === 'fixed') {
        this.keyLight.position.set(-2000, 2000, -2000);
      } else {
        const azDeg =
          mode === 'opposite-sun'
            ? (Number(c.sunAzimuthDeg) || 0) + 180
            : Number(c.keyLightAzimuthDeg) ?? -135;
        const elDeg = Math.max(5, Math.min(85, Number(c.keyLightElevationDeg) ?? 35.3));
        const azRad = (azDeg * Math.PI) / 180;
        const elRad = (elDeg * Math.PI) / 180;
        const dist = 3464;
        const cosEl = Math.cos(elRad);
        this.keyLight.position.set(
          dist * cosEl * Math.cos(azRad),
          dist * Math.sin(elRad),
          dist * cosEl * Math.sin(azRad)
        );
      }
    }

    if (this.hemiLight) {
      this.hemiLight.visible = c.hemiLightEnabled !== false;
      this.hemiLight.color.set(c.hemiSkyColor || '#c8e0ff');
      this.hemiLight.groundColor.set(c.hemiGroundColor || '#2732c8');
      this.hemiLight.intensity = Math.max(0, Number(c.hemiIntensity) ?? 1.0);
    }
  }

  _ensureDebugGizmoGroup() {
    return ensureLightingDebugGizmoGroup(this);
  }

  _updateDebugGizmoDepthTest() {
    updateLightingDebugGizmoDepthTest(this);
  }

  updateLightDebugVisuals(cars, ball, camera = null) {
    updateLightingDebugVisuals(this, cars, ball, camera);
  }

  makeSubjectSun(targetGroup, frustumSize) {
    const sun = new THREE.DirectionalLight(16777215, 1);
    sun.position.set(DEFAULT_SUN_OFFSET_X, DEFAULT_SUN_OFFSET_Y, DEFAULT_SUN_OFFSET_Z);
    sun.castShadow = true;
    sun.target = targetGroup;
    sun.shadow.mapSize.set(this.shadowConfig.mapSize, this.shadowConfig.mapSize);
    sun.shadow.bias = this.shadowConfig.shadowBias;
    sun.shadow.camera.left = -frustumSize;
    sun.shadow.camera.right = frustumSize;
    sun.shadow.camera.top = frustumSize;
    sun.shadow.camera.bottom = -frustumSize;
    sun.shadow.camera.near = 100;
    sun.shadow.camera.far = 16000;
    return sun;
  }

  ensureOpponentSun() {
    if (!this.opponentSun) {
      this.opponentSun = this.makeSubjectSun(this.opponentSunTarget, 260);
      this.opponentSun.visible = false;
      this.scene.add(this.opponentSun, this.opponentSunTarget);
      this._applyLightRigMode();
      this._applyEnvironmentalLights();
    }
    return this.opponentSun;
  }

  _setSunFrustum(sun, frustumSize) {
    if (!sun?.shadow?.camera) return;
    const cam = sun.shadow.camera;
    if (cam.right !== frustumSize) {
      cam.left = -frustumSize;
      cam.right = frustumSize;
      cam.top = frustumSize;
      cam.bottom = -frustumSize;
      cam.updateProjectionMatrix?.();
    }
  }

  _applyLightRigMode() {
    const { mode, singleSunFrustumRadius, mapSize, shadowBias } = this.shadowConfig;
    const baseSunIntensity = Math.max(0, Number(this.shadowConfig.sunIntensity) ?? 1.0);
    const suns = [this.carSun, this.ballSun, this.opponentSun].filter(Boolean);

    for (const s of suns) {
      s.shadow.bias = shadowBias;
      if (s.shadow.mapSize.x !== mapSize || s.shadow.mapSize.y !== mapSize) {
        s.shadow.mapSize.set(mapSize, mapSize);
        if (s.shadow.map) {
          s.shadow.map.dispose();
          s.shadow.map = null;
        }
      }
    }

    if (mode === 'off') {
      this.carSun.visible = true;
      this.carSun.castShadow = false;
      this.carSun.intensity = baseSunIntensity;
      this.ballSun.visible = false;
      this.ballSun.castShadow = false;
      if (this.opponentSun) {
        this.opponentSun.visible = false;
        this.opponentSun.castShadow = false;
      }
    } else if (mode === 'single-sun') {
      this.carSun.visible = true;
      this.carSun.castShadow = true;
      this.carSun.intensity = baseSunIntensity;
      this._setSunFrustum(this.carSun, singleSunFrustumRadius);
      this.ballSun.visible = false;
      this.ballSun.castShadow = false;
      if (this.opponentSun) {
        this.opponentSun.visible = false;
        this.opponentSun.castShadow = false;
      }
    } else {
      // 'multi' (3 subject-following shadow lights)
      this.carSun.visible = true;
      this.carSun.castShadow = true;
      this._setSunFrustum(this.carSun, 260);
      this.ballSun.visible = true;
      this.ballSun.castShadow = true;
      this._setSunFrustum(this.ballSun, 190);
      if (this.opponentSun) {
        this.opponentSun.castShadow = true;
        this._setSunFrustum(this.opponentSun, 260);
      }
      this.updateSunIntensities(this._numCars);
    }
  }

  updateShadowConfig(patch = {}, renderer = null) {
    const prevSharpness = this.shadowConfig.sharpness;
    const prevDepthTest = this.shadowConfig.lightGizmoDepthTest;
    const nextConfig = normalizeShadowLightingPatch(this.shadowConfig, patch);
    Object.assign(this.shadowConfig, nextConfig);
    Object.assign(shadowRuntimeConfig, this.shadowConfig);

    this._recomputeShadowBasis();
    this._applyLightRigMode();
    this._applyEnvironmentalLights();
    this.carSun.position.copy(this.shadowFocus).add(this._sunOffset);

    if (prevDepthTest !== this.shadowConfig.lightGizmoDepthTest) {
      this._updateDebugGizmoDepthTest();
    }

    if (renderer?.shadowMap) {
      renderer.shadowMap.enabled = this.shadowConfig.mode !== 'off';
      let targetType = THREE.PCFShadowMap;
      if (this.shadowConfig.sharpness === 'sharp') {
        targetType = THREE.BasicShadowMap;
      } else if (this.shadowConfig.sharpness === 'soft') {
        targetType = THREE.PCFSoftShadowMap;
      }
      if (renderer.shadowMap.type !== targetType || prevSharpness !== this.shadowConfig.sharpness) {
        renderer.shadowMap.type = targetType;
        this.scene?.traverse?.((node) => {
          if (node.isMesh && node.material) {
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            for (const m of mats) {
              if (m) m.needsUpdate = true;
            }
          }
        });
      }
      renderer.shadowMap.needsUpdate = true;
    }
  }

  updateSubjectShadow(sun, targetGroup, worldPos, frustumSize = 260) {
    const mapSize = this.shadowConfig.mapSize || 1024;
    const texelSize = (frustumSize * 2) / mapSize;
    const snappedX = Math.round(worldPos.dot(this._shadowX) / texelSize) * texelSize;
    const snappedY = Math.round(worldPos.dot(this._shadowY) / texelSize) * texelSize;
    const depthZ = worldPos.dot(this._shadowDir);

    this.shadowFocus
      .copy(this._shadowX)
      .multiplyScalar(snappedX)
      .addScaledVector(this._shadowY, snappedY)
      .addScaledVector(this._shadowDir, depthZ);

    targetGroup.position.copy(this.shadowFocus);
    sun.position.copy(this.shadowFocus).add(this._sunOffset);
    targetGroup.updateMatrixWorld?.();
  }

  updateShadows(cars, ball, camera = null) {
    const { mode, singleSunFrustumRadius } = this.shadowConfig;
    const focusPos = cars[0]?.position || ball?.position;

    if (mode === 'off') {
      if (focusPos) {
        this.shadowFocus.copy(focusPos);
        this.carSunTarget.position.copy(this.shadowFocus);
        this.carSun.position.copy(this.shadowFocus).add(this._sunOffset);
      }
      this.updateLightDebugVisuals(cars, ball, camera);
      return;
    }

    if (mode === 'single-sun') {
      if (focusPos) {
        this.updateSubjectShadow(this.carSun, this.carSunTarget, focusPos, singleSunFrustumRadius);
      }
      this.updateLightDebugVisuals(cars, ball, camera);
      return;
    }

    if (cars[0]) {
      this.updateSubjectShadow(this.carSun, this.carSunTarget, cars[0].position, 260);
    }
    if (this.opponentSun && this.opponentSun.visible && cars[1]?.visible) {
      this.updateSubjectShadow(this.opponentSun, this.opponentSunTarget, cars[1].position, 260);
    }
    if (ball) {
      this.updateSubjectShadow(this.ballSun, this.ballSunTarget, ball.position, 190);
    }
    this.updateLightDebugVisuals(cars, ball, camera);
  }

  updateSunIntensities(numCars) {
    this._numCars = numCars;
    if (this.shadowConfig.mode !== 'multi') return;
    const baseSunIntensity = Math.max(0, Number(this.shadowConfig.sunIntensity) ?? 2.0);
    if (this.opponentSun) {
      this.opponentSun.visible = numCars > 1;
      const splitIntensity = this.opponentSun.visible ? baseSunIntensity / 3 : baseSunIntensity / 2;
      this.carSun.intensity = this.ballSun.intensity = splitIntensity;
      this.opponentSun.intensity = baseSunIntensity / 3;
    }
  }

  dispose() {
    this.carSun?.dispose?.();
    this.ballSun?.dispose?.();
    this.opponentSun?.dispose?.();
    this.keyLight?.dispose?.();
    this.hemiLight?.dispose?.();
    if (this.debugGroup) {
      this.debugGroup.traverse((n) => {
        n.geometry?.dispose?.();
        n.material?.dispose?.();
      });
      this.scene?.remove?.(this.debugGroup);
      this.debugGroup = null;
    }
  }
}
