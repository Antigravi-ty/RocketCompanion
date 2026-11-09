/**
 * ArenaLighting.ts
 * Directional sunlight rigs, hemisphere environmental lighting,
 * texel-snapped dynamic shadow frustum tracking around the active POV camera,
 * and 3D light-source ray/gizmo visualization.
 */

import * as THREE from 'three';
import {
  DEFAULT_SUN_OFFSET_X,
  DEFAULT_SUN_OFFSET_Y,
  DEFAULT_SUN_OFFSET_Z,
  shadowRuntimeConfig,
  normalizeShadowLightingPatch,
  type ShadowConfig,
} from '../../ui-core/config/atmosphereFxConfig.ts';

import { ArenaLightingDebugGizmo } from './ArenaLightingDebugGizmo.ts';
import { ArenaBlobShadowSystem } from './ArenaBlobShadowSystem.ts';

export interface ShadowSceneCameraContext {
  isPovCamera?: boolean;
  cameraMode?: string;
  focusedCarIndex?: number;
}

export class ArenaLightingManager {
  public _numCars: number;
  public _shadowDir: THREE.Vector3;
  public _shadowX: THREE.Vector3;
  public _shadowY: THREE.Vector3;
  public _sunOffset: THREE.Vector3;
  public ballSun: THREE.DirectionalLight;
  public ballSunTarget: THREE.Group;
  public blobShadows: ArenaBlobShadowSystem;
  public carSun: THREE.DirectionalLight;
  public carSunTarget: THREE.Group;
  public debugGizmo: ArenaLightingDebugGizmo;
  public hemiLight: THREE.HemisphereLight;
  public keyLight: THREE.DirectionalLight;
  public opponentSun: THREE.DirectionalLight | null;
  public opponentSunTarget: THREE.Group;
  public scene: THREE.Scene;
  public shadowConfig: ShadowConfig;
  public shadowFocus: THREE.Vector3;
  public isPovShadowActive: boolean;
  private readonly _refUpY = new THREE.Vector3(0, 1, 0);
  private readonly _refUpX = new THREE.Vector3(1, 0, 0);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.shadowFocus = new THREE.Vector3();
    this.shadowConfig = { ...shadowRuntimeConfig };
    this._numCars = 1;
    this.isPovShadowActive = true;

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

    this.debugGizmo = new ArenaLightingDebugGizmo(this.scene);
    this.blobShadows = new ArenaBlobShadowSystem(this.scene);

    this._applyLightRigMode();
    this._applyEnvironmentalLights();
  }

  _recomputeShadowBasis(): void {
    const ox = Number(this.shadowConfig.sunOffsetX) ?? DEFAULT_SUN_OFFSET_X;
    const oy = Math.max(50, Number(this.shadowConfig.sunOffsetY) ?? DEFAULT_SUN_OFFSET_Y);
    const oz = Number(this.shadowConfig.sunOffsetZ) ?? DEFAULT_SUN_OFFSET_Z;
    this._sunOffset.set(ox, oy, oz);
    if (this._sunOffset.lengthSq() < 1) {
      this._sunOffset.set(DEFAULT_SUN_OFFSET_X, DEFAULT_SUN_OFFSET_Y, DEFAULT_SUN_OFFSET_Z);
    }
    this._shadowDir.copy(this._sunOffset).normalize();
    const refUp = Math.abs(this._shadowDir.y) < 0.99 ? this._refUpY : this._refUpX;
    this._shadowX.copy(refUp).cross(this._shadowDir).normalize();
    this._shadowY.crossVectors(this._shadowDir, this._shadowX).normalize();
  }

  _applyEnvironmentalLights(): void {
    const c = this.shadowConfig;
    const sunHex = c.sunColor || '#ffffff';
    const sunSuns = [this.carSun, this.ballSun, this.opponentSun].filter(
      (s): s is THREE.DirectionalLight => Boolean(s)
    );
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
            : (Number(c.keyLightAzimuthDeg) ?? -135);
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

  _ensureDebugGizmoGroup(): THREE.Group {
    return this.debugGizmo.ensureGroup(Boolean(this.shadowConfig.lightGizmoDepthTest));
  }

  _updateDebugGizmoDepthTest(): void {
    this.debugGizmo.updateDepthTest(Boolean(this.shadowConfig.lightGizmoDepthTest));
  }

  updateLightDebugVisuals(
    cars: Array<THREE.Object3D | null>,
    ball: THREE.Object3D | null,
    camera: THREE.Camera | null = null,
    focusedCarIndex = 0
  ): void {
    this.debugGizmo.update(
      this.shadowConfig,
      this.carSun.position,
      this._shadowDir,
      this.keyLight,
      cars,
      ball,
      camera,
      focusedCarIndex
    );
  }

  makeSubjectSun(targetGroup: THREE.Object3D, frustumSize = 260): THREE.DirectionalLight {
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

  ensureOpponentSun(): THREE.DirectionalLight {
    if (!this.opponentSun) {
      this.opponentSun = this.makeSubjectSun(this.opponentSunTarget, 260);
      this.opponentSun.visible = false;
      this.scene.add(this.opponentSun, this.opponentSunTarget);
      this._applyLightRigMode();
      this._applyEnvironmentalLights();
    }
    return this.opponentSun;
  }

  _setSunFrustum(sun: THREE.DirectionalLight, frustumSize: number): void {
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

  public shouldRenderShadowMap(): boolean {
    return this.shadowConfig.mode !== 'off' && this.isPovShadowActive;
  }

  _applyLightRigMode(): void {
    const { mode, singleSunFrustumRadius, mapSize, shadowBias } = this.shadowConfig;
    const baseSunIntensity = Math.max(0, Number(this.shadowConfig.sunIntensity) ?? 1.0);
    const suns = [this.carSun, this.ballSun, this.opponentSun].filter(
      (s): s is THREE.DirectionalLight => Boolean(s)
    );

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

    const effectiveMode = !this.isPovShadowActive && mode !== 'off' ? 'off' : mode;

    if (effectiveMode === 'off') {
      this.carSun.visible = true;
      this.carSun.castShadow = false;
      this.carSun.intensity = baseSunIntensity;
      this.ballSun.visible = false;
      this.ballSun.castShadow = false;
      if (this.opponentSun) {
        this.opponentSun.visible = false;
        this.opponentSun.castShadow = false;
      }
    } else if (effectiveMode === 'single-sun') {
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

  updateShadowConfig(
    patch: Partial<ShadowConfig> = {},
    renderer: THREE.WebGLRenderer | null = null
  ): void {
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
      let targetType: THREE.ShadowMapType = THREE.PCFShadowMap;
      if (this.shadowConfig.sharpness === 'sharp') {
        targetType = THREE.BasicShadowMap;
      } else if (this.shadowConfig.sharpness === 'soft') {
        targetType = THREE.PCFSoftShadowMap;
      }
      if (renderer.shadowMap.type !== targetType || prevSharpness !== this.shadowConfig.sharpness) {
        renderer.shadowMap.type = targetType;
        this.scene?.traverse?.(
          (
            node: THREE.Object3D & {
              isMesh?: boolean;
              material?: THREE.Material | THREE.Material[];
            }
          ) => {
            if (node.isMesh && node.material) {
              const mats = Array.isArray(node.material) ? node.material : [node.material];
              for (const m of mats) {
                if (m) m.needsUpdate = true;
              }
            }
          }
        );
      }
      if (this.shouldRenderShadowMap()) {
        renderer.shadowMap.needsUpdate = true;
      }
    }
  }

  updateSubjectShadow(
    sun: THREE.DirectionalLight,
    targetGroup: THREE.Object3D,
    worldPos: THREE.Vector3,
    frustumSize = 260
  ): void {
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

  private _resolvePovActive(cameraContext?: ShadowSceneCameraContext | null): boolean {
    if (!cameraContext) return true;
    if (typeof cameraContext.isPovCamera === 'boolean') {
      return cameraContext.isPovCamera;
    }
    if (typeof cameraContext.cameraMode === 'string') {
      return (
        cameraContext.cameraMode === 'pov' ||
        cameraContext.cameraMode === 'wasmPov' ||
        cameraContext.cameraMode === 'rearView'
      );
    }
    return true;
  }

  updateShadows(
    cars: Array<THREE.Object3D | null>,
    ball: THREE.Object3D | null,
    camera: THREE.Camera | null = null,
    cameraContext: ShadowSceneCameraContext | null = null
  ): void {
    const nextPovActive = this._resolvePovActive(cameraContext);
    if (this.isPovShadowActive !== nextPovActive) {
      this.isPovShadowActive = nextPovActive;
      this._applyLightRigMode();
    }

    const focusedCarIndex =
      typeof cameraContext?.focusedCarIndex === 'number' && cameraContext.focusedCarIndex >= 0
        ? cameraContext.focusedCarIndex
        : 0;
    const focusedCar = cars?.[focusedCarIndex] ?? cars?.[0] ?? null;
    const { mode, singleSunFrustumRadius } = this.shadowConfig;

    // Shadow ROI follows the camera position directly instead of checking which car is the local user
    const roiFocusPos = camera?.position || focusedCar?.position || ball?.position;

    if (mode === 'off' || !this.isPovShadowActive) {
      if (roiFocusPos) {
        this.shadowFocus.copy(roiFocusPos);
        this.carSunTarget.position.copy(this.shadowFocus);
        this.carSun.position.copy(this.shadowFocus).add(this._sunOffset);
        this.carSunTarget.updateMatrixWorld?.();
      }
      this.blobShadows.update(cars, ball, this);
      this.updateLightDebugVisuals(cars, ball, camera, focusedCarIndex);
      return;
    }

    if (mode === 'single-sun') {
      if (roiFocusPos) {
        this.updateSubjectShadow(
          this.carSun,
          this.carSunTarget,
          roiFocusPos,
          singleSunFrustumRadius
        );
      }
      this.blobShadows.update(cars, ball, this);
      this.updateLightDebugVisuals(cars, ball, camera, focusedCarIndex);
      return;
    }

    const primaryPos = focusedCar?.position || roiFocusPos;
    if (primaryPos) {
      this.updateSubjectShadow(this.carSun, this.carSunTarget, primaryPos, 260);
    }
    if (this.opponentSun && this.opponentSun.visible) {
      const secondaryCarIndex = focusedCarIndex === 0 ? 1 : 0;
      const secondaryCar = cars?.[secondaryCarIndex];
      if (secondaryCar?.visible) {
        this.updateSubjectShadow(
          this.opponentSun,
          this.opponentSunTarget,
          secondaryCar.position,
          260
        );
      }
    }
    if (ball) {
      this.updateSubjectShadow(this.ballSun, this.ballSunTarget, ball.position, 190);
    }
    this.blobShadows.update(cars, ball, this);
    this.updateLightDebugVisuals(cars, ball, camera, focusedCarIndex);
  }

  updateSunIntensities(numCars: number): void {
    this._numCars = numCars;
    if (this.shadowConfig.mode !== 'multi' || !this.isPovShadowActive) return;
    const baseSunIntensity = Math.max(0, Number(this.shadowConfig.sunIntensity) ?? 2.0);
    if (this.opponentSun) {
      this.opponentSun.visible = numCars > 1;
      const splitIntensity = this.opponentSun.visible ? baseSunIntensity / 3 : baseSunIntensity / 2;
      this.carSun.intensity = this.ballSun.intensity = splitIntensity;
      this.opponentSun.intensity = baseSunIntensity / 3;
    }
  }

  dispose(): void {
    this.carSun?.dispose?.();
    this.ballSun?.dispose?.();
    this.opponentSun?.dispose?.();
    this.keyLight?.dispose?.();
    this.hemiLight?.dispose?.();
    this.blobShadows.dispose();
    this.debugGizmo.dispose();
  }
}
