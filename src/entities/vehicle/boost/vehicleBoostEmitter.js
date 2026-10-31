import { getMaterialsConfig } from '../../../ui-core/config/materialsConfig.js';
import { boostParticleRuntimeConfig } from '../../../ui-core/config/vehicleTunerConfig.js';
import {
  ARCADE_DRIVE_COUNT,
  ARCADE_TRAIL_COUNT,
  ARCADE_BOOST_COLOR_HEX,
} from './boostCurves.js';
import * as THREE from 'three';
import { ArcadeBoostParticleMesh } from './arcadeParticleMesh.js';
import {
  createArcadeBoostFlameConeGeometry,
  createArcadeBoostFlameConeMaterial,
  createNozzleFlash
} from './arcadeConeVisual.js';
import { RealisticBoostEmitter } from './realisticBoostEmitter.js';
import { ArcadeParticlePhysics } from './arcadeParticlePhysics.js';

export class VehicleBoostEmitter {
  setSpatial(isSpatial) {}

  constructor(scene, carRoot, nozzleLocal, isPrimary = true, isBot = false) {
    const { Group, Mesh, PointLight, Color, Vector3 } = THREE;

    this.scene = scene;
    this.car = carRoot;
    this.nozzleLocal = nozzleLocal.clone ? nozzleLocal.clone() : new Vector3(nozzleLocal.x, nozzleLocal.y, nozzleLocal.z);
    this.offset = this.nozzleLocal;
    this.cone = new Group();
    this.coneMaterials = [];
    this.drive = null;
    this.trail = null;
    this.nozzleFlash = null;
    this.light = null;

    this.theme = "gold-rush";
    this.boostVisualOverride = null;
    this.elapsed = 0;
    this.coneOpacity = 0;

    // Build cartoon drive puffs
    this.drive = new ArcadeBoostParticleMesh(ARCADE_DRIVE_COUNT, true, 5);
    this.drive.mesh.name = "cartoon-drive-puffs";
    this.drive.mesh.castShadow = false;
    this.drive.mesh.receiveShadow = false;
    this.drive.mesh.layers?.enable?.(1);
    this.drive.mesh.visible = false;
    carRoot.add(this.drive.mesh);

    // Build cartoon boost trail puffs
    this.trail = new ArcadeBoostParticleMesh(ARCADE_TRAIL_COUNT, false, 4);
    this.trail.mesh.name = "cartoon-boost-trail";
    this.trail.mesh.castShadow = false;
    this.trail.mesh.receiveShadow = false;
    this.trail.mesh.layers?.enable?.(1);
    this.trail.mesh.visible = false;
    scene.add(this.trail.mesh);

    this.physics = new ArcadeParticlePhysics(this.drive, this.trail, this.nozzleLocal);

    // Build cartoon flame cone
    this.cone.position.copy(this.nozzleLocal);
    this.cone.layers?.enable?.(1);
    this.cone.visible = false;
    this.cone.name = "boost-flame";
    carRoot.add(this.cone);

    const flameMat = createArcadeBoostFlameConeMaterial();
    const flameMesh = new Mesh(createArcadeBoostFlameConeGeometry(11), flameMat);
    flameMesh.name = "boost-flame-mesh";
    flameMesh.castShadow = false;
    flameMesh.receiveShadow = false;
    flameMesh.layers?.enable?.(1);
    flameMesh.frustumCulled = false;
    this.coneMaterials.push(flameMat);
    this.cone.add(flameMesh);

    // Build nozzle flash
    const flashPos = this.nozzleLocal.clone ? this.nozzleLocal.clone() : new Vector3(this.nozzleLocal.x, this.nozzleLocal.y, this.nozzleLocal.z);
    flashPos.x -= 2;
    this.nozzleFlash = createNozzleFlash(flashPos);
    this.nozzleFlash.name = "boost-nozzle-flash";
    this.nozzleFlash.castShadow = false;
    this.nozzleFlash.receiveShadow = false;
    this.nozzleFlash.layers?.enable?.(1);
    this.nozzleFlash.visible = false;
    carRoot.add(this.nozzleFlash);

    // Point Light (never casts shadows; attached only to player car 0 so dynamic bot/probe cars never alter NUM_POINT_LIGHTS)
    if (!isBot) {
      const flameColor = new Color(ARCADE_BOOST_COLOR_HEX);
      this.light = new PointLight(flameColor, 0, 300, 2);
      this.light.castShadow = false;
      const lightPos = this.nozzleLocal.clone ? this.nozzleLocal.clone() : new Vector3(this.nozzleLocal.x, this.nozzleLocal.y, this.nozzleLocal.z);
      lightPos.x -= 10;
      this.light.position.copy(lightPos);
      carRoot.add(this.light);
    }

    // Gold Rush branch
    this.goldRush = new RealisticBoostEmitter(scene, carRoot, this.nozzleLocal, this.light);

    this._scratchWorldNozzle = new Vector3();
  }

  _syncNozzlePositions() {
    const nx = this.nozzleLocal.x;
    const ny = this.nozzleLocal.y;
    const nz = this.nozzleLocal.z;
    if (this.cone) {
      this.cone.position.set(nx, ny, nz);
    }
    if (this.nozzleFlash) {
      this.nozzleFlash.position.set(nx - 2, ny, nz);
    }
    if (this.light) {
      this.light.position.set(nx - 10, ny, nz);
    }
    this.goldRush?._syncNozzlePositions?.();
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
    this.goldRush?.setNozzleOffset?.(this.nozzleLocal);
  }

  setBoostVisual(theme) {
    this.boostVisualOverride = (theme === "cartoon" || theme === "gold-rush") ? theme : null;
  }

  get bloomActive() {
    if (!boostParticleRuntimeConfig.bloomEnabled) return false;
    if (this.theme === "gold-rush") {
      return this.goldRush.bloomActive;
    }
    return this.coneOpacity > 0.002 || this.physics.driveParticlesActive || this.physics.trailParticlesActive;
  }

  async preload() {
    await Promise.all([
      this.goldRush?.preload?.()
    ]);
  }

  disposeAudio() {}

  update(boosting, driving, visible, dt, isFocused = true) {
    const { MathUtils } = THREE;
    this._syncNozzlePositions();
    const isBoosting = boosting && visible;
    const isDriving = driving && !boosting && visible;
    this.elapsed += dt;

    let currentTheme = this.boostVisualOverride || "gold-rush";
    if (!this.boostVisualOverride) {
      try {
        const mats = getMaterialsConfig();
        if (mats?.boostVisual) {
          currentTheme = mats.boostVisual;
        }
      } catch (err) {
        console.warn('[VehicleBoostEmitter] Error accessing materials configuration for boostVisual:', err);
      }
    }

    if (this.theme !== currentTheme) {
      this.resetVisual();
      this.theme = currentTheme;
    }

    if (currentTheme === "gold-rush") {
      this.goldRush.update(boosting, driving, visible, dt);
      return;
    }

    if (this.light) {
      this.light.color.setHex?.(ARCADE_BOOST_COLOR_HEX);
    }

    const dampSpeed = isBoosting ? 28 : 16;
    this.coneOpacity = MathUtils.damp(this.coneOpacity, isBoosting ? 1 : 0, dampSpeed, dt);
    this.cone.visible = this.coneOpacity > 0.002;

    for (const mat of this.coneMaterials) {
      if (mat.uniforms) {
        mat.uniforms.time.value = this.elapsed;
        mat.uniforms.opacity.value = this.coneOpacity;
      }
    }

    if (this.nozzleFlash) {
      this.nozzleFlash.visible = this.cone.visible;
      if (this.nozzleFlash.material?.uniforms?.intensity) {
        this.nozzleFlash.material.uniforms.intensity.value = this.coneOpacity;
      }
    }

    if (this.light) {
      this.light.intensity = boostParticleRuntimeConfig.pointLightEnabled
        ? this.coneOpacity * (380 + 25 * Math.sin(this.elapsed * 24))
        : 0;
    }

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
      this._scratchWorldNozzle.copy(this.nozzleLocal);
      this.car.localToWorld?.(this._scratchWorldNozzle);
      this.physics.spawnTrailByDistance(this._scratchWorldNozzle, dt);
    } else {
      if (this.car && this.physics.currentNozzle) {
        this.car.updateMatrixWorld?.();
        this._scratchWorldNozzle.copy(this.nozzleLocal);
        this.car.localToWorld?.(this._scratchWorldNozzle);
        this.physics.currentNozzle.copy(this._scratchWorldNozzle);
      }
      this.physics.hasPreviousNozzle = false;
      this.physics.spawnRemainder = 0;
      this.physics.shortSpawnRemainder = 0;
      this.physics.longSpawnRemainder = 0;
    }

    if (this.physics.driveParticlesActive) {
      const active = this.physics.updateDrive(dt);
      this.drive.mesh.visible = active;
      this.drive.markDirty();
    }

    if (this.physics.trailParticlesActive) {
      const active = this.physics.updateTrail(dt);
      this.trail.mesh.visible = active;
      this.trail.markDirty();
    }
  }

  resetVisual() {
    this.physics.reset();
    this.goldRush?.reset?.();
    this.coneOpacity = 0;
    this.cone.visible = false;
    if (this.nozzleFlash) this.nozzleFlash.visible = false;
    if (this.light) this.light.intensity = 0;
  }

  reset() {
    this.resetVisual();
  }

  dispose() {
    this.resetVisual();
    this.goldRush?.dispose?.();
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
    if (this.nozzleFlash) {
      this.nozzleFlash.parent?.remove?.(this.nozzleFlash);
      this.car?.remove?.(this.nozzleFlash);
      this.nozzleFlash.geometry?.dispose?.();
      this.nozzleFlash.material?.dispose?.();
    }
    if (this.light) {
      this.light.parent?.remove?.(this.light);
      this.car?.remove?.(this.light);
    }
  }
}
