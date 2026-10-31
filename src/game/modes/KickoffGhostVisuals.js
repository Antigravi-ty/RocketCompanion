/**
 * KickoffGhostVisuals.js
 * Renders the isolated PPO AI Ghost Car, Ghost Ball, and Ghost Ball Trajectory inside the primary
 * Three.js arena scene without duplicating any stadium geometry or colliding with the player.
 */

import * as THREE from 'three';
import { buildVehicleModel, buildVehicleWheels } from '../../entities/arena/VehicleFactory.js';
import { getWheelSpecsForVisual, updateCarSuspensionAndSteering } from '../../entities/VehicleSuspensionSystem.js';
import { unrealToThreeCoords, interpolatePhysicsTransform } from '../../entities/arena/ArenaMath.js';
import { createGeodesicBallGeometry } from '../../entities/BallVisual.js';
import { SpeedTrail } from '../../entities/SpeedTrail.js';
import { CarStateView, BallStateView } from '../../physics/RocketSimStateViews.js';

const GHOST_CYAN_HEX = 0x38bdf8;
const GHOST_EMISSIVE_HEX = 0x0284c7;
const GHOST_OPPOSITE_HEX = 0xfb923c;
const GHOST_OPPOSITE_EMISSIVE_HEX = 0xea580c;
const MAX_TRAJECTORY_POINTS = 240;

export class KickoffGhostVisuals {
  constructor(arena) {
    this.arena = arena;
    this.scene = arena?.scene || null;

    this.ghostCarRoot = null;
    this.ghostCarMaterials = [];
    this.ghostCarLineMaterials = [];
    this.ghostCarWheels = [];
    this.ghostCarWheelSpecs = [];
    this.ghostCarSuspension = [];
    this.ghostWheelSpin = [0, 0, 0, 0];
    this.ghostBoostPlume = null;

    this.ghostBallMesh = null;
    this.ghostBallRing = null;
    this.ghostBallTrail = null;
    this.ghostTrajectoryLine = null;
    this.ghostTrajectoryPositions = new Float32Array(MAX_TRAJECTORY_POINTS * 3);
    this.ghostTrajectoryCount = 0;
    this.rawBallTrajectoryPoints = [];

    this.ghostPlacement = 'same'; // 'same' (default) | 'opposite'
    this.showCar = true;
    this.showBall = true;
    this.visible = false;

    this._prevCarView = new CarStateView();
    this._currCarView = new CarStateView();
    this._prevBallView = new BallStateView();
    this._currBallView = new BallStateView();

    this._pA = new THREE.Vector3();
    this._pB = new THREE.Vector3();
    this._qA = new THREE.Quaternion();
    this._qB = new THREE.Quaternion();
    this._velVec = new THREE.Vector3();
    this._basisFwd = new THREE.Vector3();
    this._basisRight = new THREE.Vector3();
    this._basisUp = new THREE.Vector3();
    this._basisMat = new THREE.Matrix4();
  }

  ensureBuilt() {
    if (this.ghostCarRoot || !this.arena?.scene) return;
    this.scene = this.arena.scene;
    const reg = this.arena.vehicleRegistry;
    const visual = 'fennec';

    // 1. Build Ghost Car Hierarchy
    this.ghostCarRoot = new THREE.Group();
    this.ghostCarRoot.name = 'kickoff-ghost-car';

    const { carModel, carHitbox } = buildVehicleModel(
      visual,
      GHOST_CYAN_HEX,
      true,
      reg?.assets || {},
      reg?.carLoaders || {},
      true
    );
    this.ghostCarRoot.add(carModel);
    if (carHitbox) {
      carHitbox.visible = true;
      this.ghostCarRoot.add(carHitbox);
    }

    let wheelSpecs = getWheelSpecsForVisual(visual);
    if (reg?.carLoaders?.wheelSpecs?.game) {
      wheelSpecs = reg.carLoaders.wheelSpecs.game;
    }
    this.ghostCarWheelSpecs = wheelSpecs;
    this.ghostCarWheels = buildVehicleWheels(
      this.ghostCarRoot,
      visual,
      GHOST_CYAN_HEX,
      wheelSpecs,
      reg?.assets || {},
      reg?.carLoaders || {}
    );

    this.ghostCarMaterials = [];
    this.ghostCarLineMaterials = [];

    // Apply translucent holographic shader/material styling to all meshes in ghostCarRoot
    this.ghostCarRoot.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
        obj.renderOrder = 11;
        const mat = new THREE.MeshStandardMaterial({
          color: GHOST_CYAN_HEX,
          emissive: GHOST_EMISSIVE_HEX,
          emissiveIntensity: 0.55,
          roughness: 0.25,
          metalness: 0.2,
          transparent: true,
          opacity: 0.44,
          depthWrite: false,
        });
        obj.material = mat;
        this.ghostCarMaterials.push(mat);
      } else if (obj.isLineSegments || obj.isLine) {
        obj.renderOrder = 12;
        const lmat = new THREE.LineBasicMaterial({
          color: 0x7dd3fc,
          transparent: true,
          opacity: 0.65,
          depthWrite: false,
        });
        obj.material = lmat;
        this.ghostCarLineMaterials.push(lmat);
      }
    });

    // Simple glowing boost cone at rear of ghost car
    const coneGeo = new THREE.ConeGeometry(10, 48, 12, 1, true);
    coneGeo.rotateZ(Math.PI / 2);
    coneGeo.translate(-74, 14, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color: GHOST_CYAN_HEX,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ghostBoostPlume = new THREE.Mesh(coneGeo, coneMat);
    this.ghostBoostPlume.renderOrder = 12;
    this.ghostBoostPlume.visible = false;
    this.ghostCarRoot.add(this.ghostBoostPlume);

    this.scene.add(this.ghostCarRoot);

    // 2. Build Ghost Ball & Trajectory Ribbon
    const ballGeo = createGeodesicBallGeometry(GHOST_EMISSIVE_HEX);
    const ballMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0x7dd3fc,
      emissive: GHOST_EMISSIVE_HEX,
      emissiveIntensity: 0.45,
      roughness: 0.3,
      metalness: 0.15,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    this.ghostBallMesh = new THREE.Mesh(ballGeo, ballMat);
    this.ghostBallMesh.name = 'kickoff-ghost-ball';
    this.ghostBallMesh.castShadow = false;
    this.ghostBallMesh.receiveShadow = false;
    this.ghostBallMesh.renderOrder = 11;
    this.scene.add(this.ghostBallMesh);

    const ringGeo = new THREE.RingGeometry(82, 96, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: GHOST_CYAN_HEX,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ghostBallRing = new THREE.Mesh(ringGeo, ringMat);
    this.ghostBallRing.renderOrder = 11;
    this.scene.add(this.ghostBallRing);

    this.ghostBallTrail = new SpeedTrail();
    if (this.ghostBallTrail.material?.uniforms?.uColor) {
      this.ghostBallTrail.material.uniforms.uColor.value.setHex(GHOST_CYAN_HEX);
    }
    this.scene.add(this.ghostBallTrail.object);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.ghostTrajectoryPositions, 3));
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({
      color: GHOST_CYAN_HEX,
      transparent: true,
      opacity: 0.72,
      depthTest: true,
      depthWrite: false,
    });
    this.ghostTrajectoryLine = new THREE.Line(lineGeo, lineMat);
    this.ghostTrajectoryLine.renderOrder = 0.05;
    this.ghostTrajectoryLine.frustumCulled = false;
    this.ghostTrajectoryLine.userData = { bloomOccluder: false };
    this.scene.add(this.ghostTrajectoryLine);

    this._applyPlacementTint();
    this.setVisible(this.visible);
    this.arena.onRenderTreeChanged?.();
  }

  _applyPlacementTint() {
    const isOpposite = this.ghostPlacement === 'opposite';
    const mainHex = isOpposite ? GHOST_OPPOSITE_HEX : GHOST_CYAN_HEX;
    const emissiveHex = isOpposite ? GHOST_OPPOSITE_EMISSIVE_HEX : GHOST_EMISSIVE_HEX;
    const wireHex = isOpposite ? 0xfdba74 : 0x7dd3fc;

    for (const mat of this.ghostCarMaterials) {
      mat.color.setHex(mainHex);
      mat.emissive.setHex(emissiveHex);
    }
    for (const lmat of this.ghostCarLineMaterials) {
      lmat.color.setHex(wireHex);
    }
    if (this.ghostBoostPlume?.material) {
      this.ghostBoostPlume.material.color.setHex(mainHex);
    }
    if (this.ghostBallMesh?.material) {
      this.ghostBallMesh.material.color.setHex(wireHex);
      this.ghostBallMesh.material.emissive.setHex(emissiveHex);
    }
    if (this.ghostBallRing?.material) {
      this.ghostBallRing.material.color.setHex(mainHex);
    }
    if (this.ghostBallTrail?.material?.uniforms?.uColor) {
      this.ghostBallTrail.material.uniforms.uColor.value.setHex(mainHex);
    }
    if (this.ghostTrajectoryLine?.material) {
      this.ghostTrajectoryLine.material.color.setHex(mainHex);
    }
  }

  setGhostPlacement(placement = 'same') {
    const next = placement === 'opposite' ? 'opposite' : 'same';
    if (this.ghostPlacement === next) return;
    this.ghostPlacement = next;
    this._applyPlacementTint();
    this.ghostBallTrail?.reset?.();
    this._rebuildTrajectoryBuffer();
  }

  setVisible(visible) {
    this.visible = !!visible;
    const carVis = this.visible && this.showCar;
    const ballVis = this.visible && this.showBall;

    if (this.ghostCarRoot) this.ghostCarRoot.visible = carVis;
    if (this.ghostBallMesh) this.ghostBallMesh.visible = ballVis;
    if (this.ghostBallRing) this.ghostBallRing.visible = ballVis;
    if (this.ghostBallTrail?.object) this.ghostBallTrail.object.visible = ballVis;
    if (this.ghostTrajectoryLine) this.ghostTrajectoryLine.visible = ballVis;
  }

  setEntityVisibility(showCar, showBall) {
    this.showCar = !!showCar;
    this.showBall = !!showBall;
    this.setVisible(this.visible);
  }

  resetTrail() {
    this.ghostBallTrail?.reset?.();
    this.ghostTrajectoryCount = 0;
    this.rawBallTrajectoryPoints = [];
    if (this.ghostTrajectoryLine?.geometry) {
      this.ghostTrajectoryLine.geometry.setDrawRange(0, 0);
    }
  }

  _rebuildTrajectoryBuffer() {
    if (!this.ghostTrajectoryLine) return;
    const xySign = this.ghostPlacement === 'opposite' ? -1.0 : 1.0;
    const count = Math.min(this.rawBallTrajectoryPoints.length, MAX_TRAJECTORY_POINTS);
    for (let i = 0; i < count; i++) {
      const pt = this.rawBallTrajectoryPoints[i];
      unrealToThreeCoords(this._pA, pt[0] * xySign, pt[1] * xySign, pt[2]);
      const idx = i * 3;
      this.ghostTrajectoryPositions[idx] = this._pA.x;
      this.ghostTrajectoryPositions[idx + 1] = this._pA.y;
      this.ghostTrajectoryPositions[idx + 2] = this._pA.z;
    }
    this.ghostTrajectoryCount = count;
    const attr = this.ghostTrajectoryLine.geometry.getAttribute('position');
    if (attr) attr.needsUpdate = true;
    this.ghostTrajectoryLine.geometry.setDrawRange(0, this.ghostTrajectoryCount);
  }

  recordBallTrajectoryPoint(ballStateView) {
    if (!this.ghostTrajectoryLine || !ballStateView) return;
    const speed = Math.hypot(ballStateView.velX, ballStateView.velY, ballStateView.velZ);
    if (speed < 5.0) return;

    if (this.ghostTrajectoryCount >= MAX_TRAJECTORY_POINTS) return;
    const xySign = this.ghostPlacement === 'opposite' ? -1.0 : 1.0;
    unrealToThreeCoords(
      this._pA,
      ballStateView.posX * xySign,
      ballStateView.posY * xySign,
      ballStateView.posZ
    );

    const idx = this.ghostTrajectoryCount * 3;
    if (this.ghostTrajectoryCount > 0) {
      const prevIdx = (this.ghostTrajectoryCount - 1) * 3;
      const dx = this._pA.x - this.ghostTrajectoryPositions[prevIdx];
      const dy = this._pA.y - this.ghostTrajectoryPositions[prevIdx + 1];
      const dz = this._pA.z - this.ghostTrajectoryPositions[prevIdx + 2];
      if (dx * dx + dy * dy + dz * dz < 900) return; // min 30uu spacing
    }

    this.rawBallTrajectoryPoints.push([
      ballStateView.posX,
      ballStateView.posY,
      ballStateView.posZ,
    ]);
    this.ghostTrajectoryPositions[idx] = this._pA.x;
    this.ghostTrajectoryPositions[idx + 1] = this._pA.y;
    this.ghostTrajectoryPositions[idx + 2] = this._pA.z;
    this.ghostTrajectoryCount++;

    const attr = this.ghostTrajectoryLine.geometry.getAttribute('position');
    if (attr) attr.needsUpdate = true;
    this.ghostTrajectoryLine.geometry.setDrawRange(0, this.ghostTrajectoryCount);
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

  update(prevState, currState, alpha, dt, ghostControls) {
    this.ensureBuilt();
    if (!this.visible || !prevState || !currState) return;

    const xySign = this.ghostPlacement === 'opposite' ? -1.0 : 1.0;
    const prevCar = this._prevCarView.attachCar(prevState, 0);
    const currCar = this._currCarView.attachCar(currState, 0);
    const prevBall = this._prevBallView.attach(prevState);
    const currBall = this._currBallView.attach(currState);

    if (this.ghostCarRoot && this.showCar) {
      this._interpolateSignedTransform(
        this.ghostCarRoot,
        prevCar,
        currCar,
        alpha,
        xySign
      );

      updateCarSuspensionAndSteering(
        this.ghostCarWheels,
        this.ghostCarWheelSpecs,
        this.ghostCarSuspension,
        this.ghostWheelSpin,
        currCar,
        'fennec',
        dt,
        ghostControls?.throttle ?? 0
      );

      if (this.ghostBoostPlume) {
        const boosting = currCar.isBoosting && currCar.boost > 0;
        this.ghostBoostPlume.visible = boosting;
        if (boosting) {
          const pulse = 0.85 + 0.3 * Math.sin(performance.now() * 0.04);
          this.ghostBoostPlume.scale.set(pulse, 1, pulse);
        }
      }
    }

    if (this.ghostBallMesh && this.showBall) {
      this._interpolateSignedTransform(
        this.ghostBallMesh,
        prevBall,
        currBall,
        alpha,
        xySign
      );

      const ballSpeed = Math.hypot(currBall.velX, currBall.velY, currBall.velZ);
      // Lower ghost ball opacity while sitting stationary inside the main ball at (0,0),
      // then brighten as soon as the ghost car hits it so its flight trajectory stands out clearly.
      if (this.ghostBallMesh.material) {
        this.ghostBallMesh.material.opacity = ballSpeed > 10 ? 0.52 : 0.16;
      }

      if (this.ghostBallRing) {
        const bp = this.ghostBallMesh.position;
        this.ghostBallRing.position.set(bp.x, 2.2, bp.z);
        this.ghostBallRing.visible = this.showBall && ballSpeed > 10;
      }

      unrealToThreeCoords(
        this._velVec,
        currBall.velX * xySign,
        currBall.velY * xySign,
        currBall.velZ
      );
      this.ghostBallTrail?.update(this.ghostBallMesh.position, this._velVec, dt);
    }
  }

  dispose() {
    if (this.scene) {
      if (this.ghostCarRoot) this.scene.remove(this.ghostCarRoot);
      if (this.ghostBallMesh) this.scene.remove(this.ghostBallMesh);
      if (this.ghostBallRing) this.scene.remove(this.ghostBallRing);
      if (this.ghostBallTrail?.object) this.scene.remove(this.ghostBallTrail.object);
      if (this.ghostTrajectoryLine) this.scene.remove(this.ghostTrajectoryLine);
    }
  }
}
