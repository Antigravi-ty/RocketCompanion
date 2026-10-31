import { getMaterialsConfig } from '../../../ui-core/config/materialsConfig.js';
import { boostParticleRuntimeConfig } from '../../../ui-core/config/vehicleTunerConfig.js';
import {
  REALISTIC_DRIVE_COUNT,
  REALISTIC_TRAIL_COUNT,
} from './boostCurves.js';
import * as THREE from 'three';
import { RealisticBoostParticleMesh } from './realisticParticleMesh.js';
import {
  loadGoldenBoostTextures,
  createRealisticBoostConeGeometry,
  createRealisticBoostConeMaterial
} from './realisticConeVisual.js';
import { createBoostFlare } from './arcadeConeVisual.js';
import { RealisticParticlePhysics } from './realisticParticlePhysics.js';

/**
 * Gold Rush Boost Emitter (plume.webp, turbulence.webp, sparks.webp)
 */
export class RealisticBoostEmitter {
  constructor(scene, carRoot, nozzleLocal, pointLight) {
    const { Group, Mesh, Vector3 } = THREE;

    this.scene = scene;
    this.car = carRoot;
    this.nozzleLocal = nozzleLocal?.isVector3
      ? nozzleLocal
      : (nozzleLocal?.clone ? nozzleLocal.clone() : new Vector3(nozzleLocal?.x ?? 0, nozzleLocal?.y ?? 0, nozzleLocal?.z ?? 0));
    this.offset = this.nozzleLocal;
    this.cone = new Group();
    this.coneMaterials = [];
    this.drive = null;
    this.trail = null;
    this.lensFlare = null;
    this.light = pointLight;

    this.elapsed = 0;
    this.coneOpacity = 0;

    const { textures, water, particleSheet } = loadGoldenBoostTextures();

    this.drive = new RealisticBoostParticleMesh(REALISTIC_DRIVE_COUNT, textures, 5);
    this.drive.mesh.castShadow = false;
    this.drive.mesh.receiveShadow = false;
    this.drive.mesh.layers?.enable?.(1);
    this.drive.mesh.visible = false;
    carRoot.add(this.drive.mesh);

    this.trail = new RealisticBoostParticleMesh(REALISTIC_TRAIL_COUNT, textures, 4);
    this.trail.mesh.castShadow = false;
    this.trail.mesh.receiveShadow = false;
    this.trail.mesh.layers?.enable?.(1);
    this.trail.mesh.visible = false;
    scene.add(this.trail.mesh);

    this.physics = new RealisticParticlePhysics(this.drive, this.trail, this.nozzleLocal);

    this.cone.name = "gold-rush-boost-flame";
    this.drive.mesh.name = "gold-rush-drive-puffs";
    this.trail.mesh.name = "gold-rush-boost-trail";
    this.cone.position.copy(this.nozzleLocal);
    this.cone.layers?.enable?.(1);
    this.cone.visible = false;
    carRoot.add(this.cone);

    const addConeLayer = (radius, length, layerIdx) => {
      const mat = createRealisticBoostConeMaterial(water, particleSheet, layerIdx);
      const mesh = new Mesh(createRealisticBoostConeGeometry(radius, length, 28, 18), mat);
      mesh.name = `gold-rush-cone-${layerIdx}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.layers?.enable?.(1);
      mesh.frustumCulled = false;
      this.coneMaterials.push(mat);
      this.cone.add(mesh);
    };

    addConeLayer(3.4, 24, 1);
    addConeLayer(7.2, 48, 0);

    const flarePos = this.nozzleLocal.clone ? this.nozzleLocal.clone() : new Vector3(this.nozzleLocal.x, this.nozzleLocal.y, this.nozzleLocal.z);
    flarePos.x -= 2;
    this.lensFlare = createBoostFlare(flarePos);
    this.lensFlare.name = "gold-rush-flare";
    this.lensFlare.castShadow = false;
    this.lensFlare.receiveShadow = false;
    this.lensFlare.layers?.enable?.(1);
    this.lensFlare.visible = false;
    carRoot.add(this.lensFlare);

    this._scratchA = new Vector3();
  }

  _syncNozzlePositions() {
    const nx = this.nozzleLocal.x;
    const ny = this.nozzleLocal.y;
    const nz = this.nozzleLocal.z;
    if (this.cone) {
      this.cone.position.set(nx, ny, nz);
    }
    if (this.lensFlare) {
      this.lensFlare.position.set(nx - 2, ny, nz);
    }
    if (this.light) {
      this.light.position.set(nx - 10, ny, nz);
    }
  }

  setNozzleOffset(xOrVec, y, z) {
    if (xOrVec && typeof xOrVec === 'object') {
      if (Array.isArray(xOrVec)) {
        this.nozzleLocal.set(Number(xOrVec[0]) || 0, Number(xOrVec[1]) || 0, Number(xOrVec[2]) || 0);
      } else if (xOrVec !== this.nozzleLocal) {
        this.nozzleLocal.set(Number(xOrVec.x) || 0, Number(xOrVec.y) || 0, Number(xOrVec.z) || 0);
      }
    } else if (typeof xOrVec === 'number') {
      this.nozzleLocal.set(xOrVec, Number(y) || 0, Number(z) || 0);
    }
    this._syncNozzlePositions();
    if (this.physics) {
      this.physics.hasPreviousNozzle = false;
    }
  }

  get bloomActive() {
    if (!boostParticleRuntimeConfig.bloomEnabled) return false;
    return this.coneOpacity > 0.002 || this.physics.driveParticlesActive || this.physics.trailParticlesActive;
  }

  async preload() {
    await loadGoldenBoostTextures().ready;
  }

  update(boosting, driving, visible, dt) {
    const { MathUtils } = THREE;
    this._syncNozzlePositions();
    const isBoosting = boosting && visible;
    const isDriving = driving && !boosting && visible;
    this.elapsed += dt;

    const dampSpeed = isBoosting ? 28 : 16;
    this.coneOpacity = MathUtils.damp(this.coneOpacity, isBoosting ? 1 : 0, dampSpeed, dt);
    this.cone.visible = this.coneOpacity > 0.002;

    let flameMode = 0;
    let plumeScale = 1.0;
    try {
      const mats = getMaterialsConfig();
      flameMode = mats?.boostFlameLuminance === 'dynamic' ? 1 : 0;
      const plumeMode = mats?.boostPlumeLuminance || 'balanced';
      if (plumeMode === 'min') plumeScale = 0.35;
      else if (plumeMode === 'dynamic') plumeScale = Math.max(0.4, Math.min(1.8, this.coneOpacity * 1.5 + 0.3));
      else if (plumeMode === 'hdr') plumeScale = 2.4;
      else plumeScale = 1.0;
    } catch (err) {
      console.warn('[VehicleBoostEmitter] Error accessing materials configuration for plume luminance:', err);
    }

    for (const mat of this.coneMaterials) {
      if (mat.uniforms) {
        mat.uniforms.time.value = this.elapsed;
        mat.uniforms.opacity.value = this.coneOpacity;
        if (mat.uniforms.luminanceMode) {
          mat.uniforms.luminanceMode.value = flameMode;
        }
      }
    }

    if (this.lensFlare) {
      this.lensFlare.visible = this.cone.visible;
      if (this.lensFlare.material?.uniforms?.intensity) {
        const flareMul = flameMode === 0 ? 0.4 : 1.0;
        this.lensFlare.material.uniforms.intensity.value = this.coneOpacity * flareMul;
      }
    }

    if (this.light) {
      this.light.color.setRGB?.(1, 0.6689812541, 0.08848005533);
      const lightBase = flameMode === 0 ? 1000 : 2500;
      const flicker = flameMode === 0 ? 80 : 280;
      this.light.intensity = boostParticleRuntimeConfig.pointLightEnabled
        ? this.coneOpacity * (lightBase + flicker * Math.sin(this.elapsed * 37))
        : 0;
    }

    this.trail?.setPlumeLuminance?.(plumeScale);
    this.drive?.setPlumeLuminance?.(plumeScale);

    if (isDriving && boostParticleRuntimeConfig.drivePuffsEnabled) {
      this.physics.spawnDrive(dt);
    } else {
      this.physics.driveSpawnAccumulator = 0;
    }

    const canSpawnTrail = boostParticleRuntimeConfig.dualStreamEnabled
      ? ((boostParticleRuntimeConfig.shortTrailSpawnMultiplier ?? 1.0) > 0.01 || (boostParticleRuntimeConfig.longTrailSpawnMultiplier ?? 0.1) > 0.01)
      : ((boostParticleRuntimeConfig.trailSpawnMultiplier ?? 1.0) > 0.01);

    if (isBoosting && canSpawnTrail) {
      this.car.updateMatrixWorld?.();
      this._scratchA.copy(this.nozzleLocal);
      this.car.localToWorld?.(this._scratchA);
      this.physics.spawnTrailByDistance(this._scratchA, dt);
    } else {
      if (this.car && this.physics.currentNozzle) {
        this.car.updateMatrixWorld?.();
        this._scratchA.copy(this.nozzleLocal);
        this.car.localToWorld?.(this._scratchA);
        this.physics.currentNozzle.copy(this._scratchA);
      }
      this.physics.hasPreviousNozzle = false;
      this.physics.spawnRemainder = 0;
      this.physics.shortSpawnRemainder = 0;
      this.physics.longSpawnRemainder = 0;
    }

    if (this.physics.driveParticlesActive) {
      const active = this.physics.updateDrive(dt);
      this.drive.mesh.visible = active;
      this.drive.setTime(this.elapsed);
      this.drive.markDirty();
    }

    if (this.physics.trailParticlesActive) {
      const active = this.physics.updateTrail(dt);
      this.trail.mesh.visible = active;
      this.trail.setTime(this.elapsed);
      this.trail.markDirty();
    }
  }

  reset() {
    this.physics.reset();
    this.coneOpacity = 0;
    this.cone.visible = false;
    if (this.lensFlare) this.lensFlare.visible = false;
    if (this.light) this.light.intensity = 0;
  }

  dispose() {
    this.reset();
    if (this.trail?.mesh) {
      this.trail.mesh.parent?.remove?.(this.trail.mesh);
      this.scene?.remove?.(this.trail.mesh);
      this.trail.mesh.geometry?.dispose?.();
      this.trail.mesh.material?.dispose?.();
    }
    if (this.drive?.mesh) {
      this.drive.mesh.parent?.remove?.(this.drive.mesh);
      this.car?.remove?.(this.drive.mesh);
      this.drive.mesh.geometry?.dispose?.();
      this.drive.mesh.material?.dispose?.();
    }
    if (this.cone) {
      this.cone.parent?.remove?.(this.cone);
      this.car?.remove?.(this.cone);
      this.cone.traverse?.((node) => {
        node.geometry?.dispose?.();
        node.material?.dispose?.();
      });
    }
    if (this.lensFlare) {
      this.lensFlare.parent?.remove?.(this.lensFlare);
      this.car?.remove?.(this.lensFlare);
      this.lensFlare.geometry?.dispose?.();
      this.lensFlare.material?.dispose?.();
    }
  }
}
