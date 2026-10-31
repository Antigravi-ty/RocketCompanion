/**
 * MultiWorldGhostRenderer.js
 * Renders an arbitrary number of parallel Ghost Worlds (World 2, World 3, ..., World N)
 * inside the primary Three.js arena scene without duplicating stadium geometry or colliding
 * with local physics.
 *
 * Capabilities:
 * - Supports N simultaneous Ghost Worlds indexed by arbitrary `worldId`.
 * - Each Ghost World dynamically renders up to MAX_CARS (8) vehicles (Slots 0..7) + 1 Ghost Ball.
 * - Intentionally omits any ball trajectory prediction line in Dual/Multi-World mode.
 * - Supports per-world color palettes, translucency opacity, and excluded car slot filtering.
 */

import * as THREE from 'three';
import { buildVehicleModel, buildVehicleWheels } from '../../entities/arena/VehicleFactory.js';
import { getWheelSpecsForVisual, updateCarSuspensionAndSteering } from '../../entities/VehicleSuspensionSystem.js';
import { unrealToThreeCoords } from '../../entities/arena/ArenaMath.js';
import { createGeodesicBallGeometry } from '../../entities/BallVisual.js';
import { CarStateView, BallStateView } from '../../physics/RocketSimStateViews.js';
import { SIM_OFFSETS, MAX_CARS } from '../../physics/RocketSimConstants.js';

export const GHOST_WORLD_PALETTES = Object.freeze([
  { mainHex: 0x38bdf8, emissiveHex: 0x0284c7, wireHex: 0x7dd3fc }, // World 1: Holographic Cyan
  { mainHex: 0xfb923c, emissiveHex: 0xea580c, wireHex: 0xfdba74 }, // World 2: Holographic Orange
  { mainHex: 0x34d399, emissiveHex: 0x059669, wireHex: 0x6ee7b7 }, // World 3: Holographic Emerald
  { mainHex: 0xa78bfa, emissiveHex: 0x7c3aed, wireHex: 0xc4b5fd }, // World 4: Holographic Violet
  { mainHex: 0xf43f5e, emissiveHex: 0xe11d48, wireHex: 0xfda4af }, // World 5: Holographic Rose
  { mainHex: 0xfbbf24, emissiveHex: 0xd97706, wireHex: 0xfde68a }, // World 6: Holographic Amber
  { mainHex: 0x818cf8, emissiveHex: 0x4f46e5, wireHex: 0xa5b4fc }, // World 7: Holographic Indigo
  { mainHex: 0xa3e635, emissiveHex: 0x65a30d, wireHex: 0xbef264 }, // World 8: Holographic Lime
]);

export class MultiWorldGhostRenderer {
  constructor(arena) {
    this.arena = arena;
    this.scene = arena?.scene || null;
    this.worlds = new Map();
    this.visible = false;
    this.showCar = true;
    this.showBall = true;
    this.defaultOpacity = 0.45;
    this.ghostPlacement = 'same';

    this._pA = new THREE.Vector3();
    this._pB = new THREE.Vector3();
    this._qA = new THREE.Quaternion();
    this._qB = new THREE.Quaternion();
    this._basisFwd = new THREE.Vector3();
    this._basisRight = new THREE.Vector3();
    this._basisUp = new THREE.Vector3();
    this._basisMat = new THREE.Matrix4();
  }

  _resolvePalette(worldIndex = 0, placement = 'same') {
    if (placement === 'opposite' && worldIndex === 0) {
      return GHOST_WORLD_PALETTES[1];
    }
    return GHOST_WORLD_PALETTES[Math.abs(worldIndex) % GHOST_WORLD_PALETTES.length];
  }

  _buildGhostCarSlot(worldEntry, slotIndex, visual = 'fennec') {
    if (!this.arena?.scene) return null;
    this.scene = this.arena.scene;
    const reg = this.arena.vehicleRegistry;
    const palette = worldEntry.palette;

    const carRoot = new THREE.Group();
    carRoot.name = `ghost-world-${worldEntry.worldId}-car-${slotIndex}`;

    const { carModel, carHitbox } = buildVehicleModel(
      visual,
      palette.mainHex,
      true,
      reg?.assets || {},
      reg?.carLoaders || {},
      true
    );
    carRoot.add(carModel);
    if (carHitbox) {
      carHitbox.visible = true;
      carRoot.add(carHitbox);
    }

    let wheelSpecs = getWheelSpecsForVisual(visual);
    if (reg?.carLoaders?.wheelSpecs?.game) {
      wheelSpecs = reg.carLoaders.wheelSpecs.game;
    }
    const wheels = buildVehicleWheels(
      carRoot,
      visual,
      palette.mainHex,
      wheelSpecs,
      reg?.assets || {},
      reg?.carLoaders || {}
    );

    const materials = [];
    const lineMaterials = [];

    carRoot.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
        obj.renderOrder = 11;
        const mat = new THREE.MeshStandardMaterial({
          color: palette.mainHex,
          emissive: palette.emissiveHex,
          emissiveIntensity: 0.55,
          roughness: 0.25,
          metalness: 0.2,
          transparent: true,
          opacity: worldEntry.opacity,
          depthWrite: false,
        });
        obj.material = mat;
        materials.push(mat);
      } else if (obj.isLineSegments || obj.isLine) {
        obj.renderOrder = 12;
        const lmat = new THREE.LineBasicMaterial({
          color: palette.wireHex,
          transparent: true,
          opacity: Math.min(0.95, worldEntry.opacity + 0.2),
          depthWrite: false,
        });
        obj.material = lmat;
        lineMaterials.push(lmat);
      }
    });

    const coneGeo = new THREE.ConeGeometry(10, 48, 12, 1, true);
    coneGeo.rotateZ(Math.PI / 2);
    coneGeo.translate(-74, 14, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color: palette.mainHex,
      transparent: true,
      opacity: Math.min(0.9, worldEntry.opacity + 0.2),
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const boostPlume = new THREE.Mesh(coneGeo, coneMat);
    boostPlume.renderOrder = 12;
    boostPlume.visible = false;
    carRoot.add(boostPlume);

    carRoot.visible = false;
    this.scene.add(carRoot);

    const slotObj = {
      slotIndex,
      visual,
      root: carRoot,
      materials,
      lineMaterials,
      wheels,
      wheelSpecs,
      suspension: [],
      wheelSpin: [0, 0, 0, 0],
      boostPlume,
      prevCarView: new CarStateView(),
      currCarView: new CarStateView(),
    };

    worldEntry.cars[slotIndex] = slotObj;
    this.arena.onRenderTreeChanged?.();
    return slotObj;
  }

  ensureWorld(worldId = 'world-1', options = {}) {
    if (this.worlds.has(worldId)) {
      return this.worlds.get(worldId);
    }
    if (!this.arena?.scene) return null;
    this.scene = this.arena.scene;

    const worldIndex = typeof options.paletteIndex === 'number'
      ? options.paletteIndex
      : this.worlds.size;
    const palette = options.palette || this._resolvePalette(worldIndex, options.placement || this.ghostPlacement);
    const opacity = typeof options.opacity === 'number' ? options.opacity : this.defaultOpacity;

    const ballGeo = createGeodesicBallGeometry(palette.emissiveHex);
    const ballMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: palette.wireHex,
      emissive: palette.emissiveHex,
      emissiveIntensity: 0.45,
      roughness: 0.3,
      metalness: 0.15,
      transparent: true,
      opacity: opacity * 0.85,
      depthWrite: false,
    });
    const ballMesh = new THREE.Mesh(ballGeo, ballMat);
    ballMesh.name = `ghost-world-${worldId}-ball`;
    ballMesh.castShadow = false;
    ballMesh.receiveShadow = false;
    ballMesh.renderOrder = 11;
    ballMesh.visible = false;
    this.scene.add(ballMesh);

    const ringGeo = new THREE.RingGeometry(82, 96, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: palette.mainHex,
      transparent: true,
      opacity: opacity * 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ballRing = new THREE.Mesh(ringGeo, ringMat);
    ballRing.renderOrder = 11;
    ballRing.visible = false;
    this.scene.add(ballRing);

    const worldEntry = {
      worldId,
      worldIndex,
      palette,
      opacity,
      placement: options.placement || this.ghostPlacement,
      showCar: options.showCar !== undefined ? Boolean(options.showCar) : this.showCar,
      showBall: options.showBall !== undefined ? Boolean(options.showBall) : this.showBall,
      visible: this.visible,
      cars: new Array(MAX_CARS).fill(null),
      ballMesh,
      ballRing,
      prevBallView: new BallStateView(),
      currBallView: new BallStateView(),
    };

    this.worlds.set(worldId, worldEntry);
    // Pre-build slot 0 for immediate readiness
    this._buildGhostCarSlot(worldEntry, 0, options.visual || 'fennec');
    this.arena.onRenderTreeChanged?.();
    return worldEntry;
  }

  ensureBuilt() {
    return this.ensureWorld('world-1');
  }

  get ghostCarMaterials() {
    const mats = [];
    for (const w of this.worlds.values()) {
      for (const c of w.cars) {
        if (c?.materials) mats.push(...c.materials);
      }
    }
    return mats;
  }

  get ghostBallMesh() {
    return this.worlds.get('world-1')?.ballMesh || null;
  }

  setOpacity(opacity, worldId = null) {
    const clamped = Math.max(0.05, Math.min(0.95, Number(opacity) || 0.45));
    if (worldId === null) {
      this.defaultOpacity = clamped;
    }
    const targets = worldId !== null
      ? [this.worlds.get(worldId)].filter(Boolean)
      : Array.from(this.worlds.values());

    for (const w of targets) {
      w.opacity = clamped;
      for (const c of w.cars) {
        if (!c) continue;
        for (const mat of c.materials) {
          mat.opacity = clamped;
        }
        for (const lmat of c.lineMaterials) {
          lmat.opacity = Math.min(0.95, clamped + 0.2);
        }
        if (c.boostPlume?.material) {
          c.boostPlume.material.opacity = Math.min(0.9, clamped + 0.2);
        }
      }
      if (w.ballMesh?.material) {
        w.ballMesh.material.opacity = clamped * 0.85;
      }
      if (w.ballRing?.material) {
        w.ballRing.material.opacity = clamped * 0.85;
      }
    }
  }

  setGhostPlacement(placement = 'same', worldId = null) {
    const next = placement === 'opposite' ? 'opposite' : 'same';
    if (worldId === null) {
      this.ghostPlacement = next;
    }
    const targets = worldId !== null
      ? [this.worlds.get(worldId)].filter(Boolean)
      : Array.from(this.worlds.values());

    for (const w of targets) {
      w.placement = next;
      w.palette = this._resolvePalette(w.worldIndex, next);
      for (const c of w.cars) {
        if (!c) continue;
        for (const mat of c.materials) {
          mat.color.setHex(w.palette.mainHex);
          mat.emissive.setHex(w.palette.emissiveHex);
        }
        for (const lmat of c.lineMaterials) {
          lmat.color.setHex(w.palette.wireHex);
        }
        if (c.boostPlume?.material) {
          c.boostPlume.material.color.setHex(w.palette.mainHex);
        }
      }
      if (w.ballMesh?.material) {
        w.ballMesh.material.color.setHex(w.palette.wireHex);
        w.ballMesh.material.emissive.setHex(w.palette.emissiveHex);
      }
      if (w.ballRing?.material) {
        w.ballRing.material.color.setHex(w.palette.mainHex);
      }
    }
  }

  setEntityVisibility(showCar, showBall, worldId = null) {
    if (worldId === null) {
      this.showCar = Boolean(showCar);
      this.showBall = Boolean(showBall);
    }
    const targets = worldId !== null
      ? [this.worlds.get(worldId)].filter(Boolean)
      : Array.from(this.worlds.values());

    for (const w of targets) {
      w.showCar = Boolean(showCar);
      w.showBall = Boolean(showBall);
    }
    this.setVisible(this.visible, worldId);
  }

  setVisible(visible, worldId = null) {
    if (worldId === null) {
      this.visible = Boolean(visible);
    }
    const targets = worldId !== null
      ? [this.worlds.get(worldId)].filter(Boolean)
      : Array.from(this.worlds.values());

    for (const w of targets) {
      w.visible = Boolean(visible);
      if (!w.visible) {
        for (const c of w.cars) {
          if (c?.root) c.root.visible = false;
          if (c?.boostPlume) c.boostPlume.visible = false;
        }
        if (w.ballMesh) w.ballMesh.visible = false;
        if (w.ballRing) w.ballRing.visible = false;
      }
    }
  }

  _viewBasisToQuatSigned(targetQuat, view, xySign) {
    unrealToThreeCoords(this._basisFwd, view.fwdX * xySign, view.fwdY * xySign, view.fwdZ);
    unrealToThreeCoords(this._basisRight, view.rightX * xySign, view.rightY * xySign, view.rightZ);
    unrealToThreeCoords(this._basisUp, view.upX * xySign, view.upY * xySign, view.upZ);

    if (
      this._basisFwd.lengthSq() < 1e-6 ||
      this._basisUp.lengthSq() < 1e-6 ||
      this._basisRight.lengthSq() < 1e-6
    ) {
      targetQuat.set(0, 0, 0, 1);
      return targetQuat;
    }

    this._basisMat.makeBasis(this._basisFwd, this._basisUp, this._basisRight);
    targetQuat.setFromRotationMatrix(this._basisMat);
    targetQuat.normalize();
    return targetQuat;
  }

  _interpolateSignedTransform(targetMesh, prevView, currView, alpha, xySign) {
    unrealToThreeCoords(this._pA, prevView.posX * xySign, prevView.posY * xySign, prevView.posZ);
    unrealToThreeCoords(this._pB, currView.posX * xySign, currView.posY * xySign, currView.posZ);
    targetMesh.position.lerpVectors(this._pA, this._pB, alpha);

    this._viewBasisToQuatSigned(this._qA, prevView, xySign);
    this._viewBasisToQuatSigned(this._qB, currView, xySign);
    targetMesh.quaternion.slerpQuaternions(this._qA, this._qB, alpha);
  }

  /**
   * Updates a specific Ghost World (`worldId`) with up to 8 cars + 1 ball.
   *
   * @param {string|number} worldId
   * @param {Float32Array} prevState - 448-float GameStateBufferPod
   * @param {Float32Array} currState - 448-float GameStateBufferPod
   * @param {number} [alpha=1.0]
   * @param {number} [dt=0.016]
   * @param {object} [options={}]
   */
  updateWorld(worldId, prevState, currState, alpha = 1.0, dt = 0.016, options = {}) {
    if (!prevState || !currState) return;
    const worldEntry = this.ensureWorld(worldId, options);
    if (!worldEntry || !worldEntry.visible) return;

    const xySign = worldEntry.placement === 'opposite' ? -1.0 : 1.0;
    const rawNumCars = Math.round(currState[SIM_OFFSETS.NUM_CARS] || 1);
    const numCars = Math.min(MAX_CARS, Math.max(0, rawNumCars));
    const excludeSet = options.excludeCarIndices instanceof Set
      ? options.excludeCarIndices
      : (Array.isArray(options.excludeCarIndices) ? new Set(options.excludeCarIndices) : null);

    if (worldEntry.showCar) {
      for (let c = 0; c < MAX_CARS; c++) {
        if (c >= numCars || (excludeSet && excludeSet.has(c))) {
          if (worldEntry.cars[c]?.root) {
            worldEntry.cars[c].root.visible = false;
          }
          continue;
        }

        let slotObj = worldEntry.cars[c];
        if (!slotObj) {
          slotObj = this._buildGhostCarSlot(worldEntry, c, 'fennec');
        }
        if (!slotObj?.root) continue;

        const prevCar = slotObj.prevCarView.attachCar(prevState, c);
        const currCar = slotObj.currCarView.attachCar(currState, c);

        // Hide parked/inactive cars underground or zeroed sparse WASM slots
        const isZeroedSlot = (currCar.fwdX * currCar.fwdX + currCar.fwdY * currCar.fwdY + currCar.fwdZ * currCar.fwdZ) < 0.01;
        if (isZeroedSlot || currCar.posZ <= -200 || currCar.posX < -5000 || currCar.isDemoed) {
          slotObj.root.visible = false;
          continue;
        }

        slotObj.root.visible = true;
        this._interpolateSignedTransform(slotObj.root, prevCar, currCar, alpha, xySign);

        const ctrlForCar = typeof options.getCarControls === 'function'
          ? options.getCarControls(c)
          : (Array.isArray(options.carControls) ? options.carControls[c] : options.controls);

        updateCarSuspensionAndSteering(
          slotObj.wheels,
          slotObj.wheelSpecs,
          slotObj.suspension,
          slotObj.wheelSpin,
          currCar,
          slotObj.visual || 'fennec',
          dt,
          ctrlForCar?.throttle ?? 0
        );

        if (slotObj.boostPlume) {
          const boosting = Boolean(currCar.isBoosting && currCar.boost > 0);
          slotObj.boostPlume.visible = boosting;
          if (boosting) {
            const pulse = 0.85 + 0.3 * Math.sin(performance.now() * 0.04 + c);
            slotObj.boostPlume.scale.set(pulse, 1, pulse);
          }
        }
      }
    } else {
      for (let c = 0; c < MAX_CARS; c++) {
        if (worldEntry.cars[c]?.root) {
          worldEntry.cars[c].root.visible = false;
        }
      }
    }

    const showWorldBall = options.showBall !== undefined ? Boolean(options.showBall) : worldEntry.showBall;
    if (worldEntry.ballMesh && showWorldBall) {
      const prevBall = worldEntry.prevBallView.attach(prevState);
      const currBall = worldEntry.currBallView.attach(currState);
      worldEntry.ballMesh.visible = true;
      this._interpolateSignedTransform(worldEntry.ballMesh, prevBall, currBall, alpha, xySign);

      const ballSpeed = Math.hypot(currBall.velX, currBall.velY, currBall.velZ);
      if (worldEntry.ballMesh.material) {
        worldEntry.ballMesh.material.opacity = ballSpeed > 10
          ? Math.min(0.85, worldEntry.opacity * 0.9)
          : Math.max(0.15, worldEntry.opacity * 0.45);
      }

      if (worldEntry.ballRing) {
        const bp = worldEntry.ballMesh.position;
        worldEntry.ballRing.position.set(bp.x, 2.2, bp.z);
        worldEntry.ballRing.visible = ballSpeed > 10;
      }
    } else {
      if (worldEntry.ballMesh) worldEntry.ballMesh.visible = false;
      if (worldEntry.ballRing) worldEntry.ballRing.visible = false;
    }
  }

  /**
   * Default single-world update entry point (updates 'world-1').
   */
  update(prevState, currState, alpha = 1.0, dt = 0.016, ghostControls = null, showBall = undefined) {
    this.updateWorld('world-1', prevState, currState, alpha, dt, {
      controls: ghostControls,
      showBall,
    });
  }

  removeWorld(worldId) {
    const w = this.worlds.get(worldId);
    if (!w) return;
    if (this.scene) {
      for (const c of w.cars) {
        if (c?.root) this.scene.remove(c.root);
      }
      if (w.ballMesh) this.scene.remove(w.ballMesh);
      if (w.ballRing) this.scene.remove(w.ballRing);
    }
    this.worlds.delete(worldId);
  }

  dispose() {
    for (const worldId of Array.from(this.worlds.keys())) {
      this.removeWorld(worldId);
    }
  }
}

export default MultiWorldGhostRenderer;
