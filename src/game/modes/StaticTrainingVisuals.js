/**
 * StaticTrainingVisuals.js
 * 3D visual overlays for Static Training Pack Mode (Play & Edit):
 * - Car Speed Direction Arrow (visible during Play pre-launch & Edit Mode)
 * - Car Heading Arrow (visible during Edit Mode to distinguish nose heading from velocity direction)
 * - Ball Velocity Arrow & Kickoff-State Halo Ring
 * - Ground Drop-Lines, Target Rings & 3D Floating Canvas Sprite Annotations (for Free Camera inspection)
 */

import * as THREE from 'three';

function create3DArrowMesh(colorHex, headRadius = 22, headLength = 58, shaftRadius = 7) {
  const group = new THREE.Group();

  const mat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: false,
  });

  // Shaft aligned along +Y in local space (rotated to target direction)
  const shaftGeo = new THREE.CylinderGeometry(shaftRadius, shaftRadius, 1, 16);
  shaftGeo.translate(0, 0.5, 0);
  const shaftMesh = new THREE.Mesh(shaftGeo, mat);
  shaftMesh.renderOrder = 14;

  const headGeo = new THREE.ConeGeometry(headRadius, headLength, 20);
  headGeo.translate(0, headLength * 0.5, 0);
  const headMesh = new THREE.Mesh(headGeo, mat);
  headMesh.renderOrder = 14;

  group.add(shaftMesh);
  group.add(headMesh);
  group.userData = { shaftMesh, headMesh, mat, headLength };
  return group;
}

function update3DArrowMesh(arrowGroup, originThree, dirThree, totalLength, highlight = false) {
  if (!arrowGroup) return;
  const len = Math.max(80, totalLength);
  const { shaftMesh, headMesh, mat, headLength } = arrowGroup.userData;
  const shaftLen = Math.max(25, len - headLength);

  arrowGroup.position.copy(originThree);

  const normDir = dirThree.clone();
  if (normDir.lengthSq() < 1e-6) {
    normDir.set(0, 0, 1);
  } else {
    normDir.normalize();
  }

  const upAxis = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(upAxis, normDir);
  arrowGroup.quaternion.copy(quat);

  shaftMesh.scale.set(highlight ? 1.25 : 1.0, shaftLen, highlight ? 1.25 : 1.0);
  headMesh.position.set(0, shaftLen, 0);
  headMesh.scale.setScalar(highlight ? 1.2 : 1.0);
  mat.opacity = highlight ? 0.96 : 0.72;
}

export class StaticTrainingVisuals {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'static-training-pack-visuals';
    this.root.visible = false;

    // 1. Car Speed Direction Arrow (Amber/Orange: shown in Play pre-launch and Edit Mode)
    this.carSpeedArrow = create3DArrowMesh(0xf59e0b, 22, 60, 7.5);
    this.root.add(this.carSpeedArrow);

    // 2. Car Heading Arrow (Sky Blue: shown in Edit Mode so nose orientation vs velocity is clear)
    this.carHeadingArrow = create3DArrowMesh(0x38bdf8, 18, 48, 6);
    this.root.add(this.carHeadingArrow);

    // 3. Ball Launch Velocity Arrow (Emerald: shown in Edit Mode)
    this.ballSpeedArrow = create3DArrowMesh(0x10b981, 22, 60, 7.5);
    this.root.add(this.ballSpeedArrow);

    // 4. Ball Kickoff-State Suspension Halo Ring (Cyan ring around ball when kickoffState is active)
    const haloGeo = new THREE.RingGeometry(108, 124, 36);
    haloGeo.rotateX(-Math.PI / 2);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.ballKickoffHalo = new THREE.Mesh(haloGeo, haloMat);
    this.ballKickoffHalo.renderOrder = 14;
    this.root.add(this.ballKickoffHalo);

    // 5. Ground Drop-Lines & Ground Footprint Rings for Car and Ball (Edit Mode & Free Cam)
    const carRingGeo = new THREE.RingGeometry(68, 80, 32);
    carRingGeo.rotateX(-Math.PI / 2);
    this.carGroundRing = new THREE.Mesh(
      carRingGeo,
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      })
    );
    this.carGroundRing.renderOrder = 13;
    this.root.add(this.carGroundRing);

    const ballRingGeo = new THREE.RingGeometry(82, 96, 32);
    ballRingGeo.rotateX(-Math.PI / 2);
    this.ballGroundRing = new THREE.Mesh(
      ballRingGeo,
      new THREE.MeshBasicMaterial({
        color: 0x10b981,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      })
    );
    this.ballGroundRing.renderOrder = 13;
    this.root.add(this.ballGroundRing);

    const dropLineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    this.carDropLineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.carDropLine = new THREE.Line(this.carDropLineGeo, dropLineMat);
    this.carDropLine.renderOrder = 13;
    this.root.add(this.carDropLine);

    this.ballDropLineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.ballDropLine = new THREE.Line(this.ballDropLineGeo, dropLineMat);
    this.ballDropLine.renderOrder = 13;
    this.root.add(this.ballDropLine);

    if (this.scene) {
      this.scene.add(this.root);
    }
  }

  setVisible(visible) {
    if (this.root) {
      this.root.visible = Boolean(visible);
    }
  }

  /**
   * Direct update method invoked by StaticTrainingPackMode.update().
   * @param {object} shot - StaticTrainingShotItem
   * @param {string} editSubMode - 'car-heading' | 'car-speed' | 'ball-speed' | 'free-cam' | 'play'
   * @param {boolean} isPlayPreLaunch - true when in Play Mode pre-launch waiting/countdown state
   */
  update(shot, editSubMode = 'car-heading', isPlayPreLaunch = false) {
    this.updateFromShot(shot, {
      isEditMode: !isPlayPreLaunch && editSubMode !== 'play',
      editSubMode: editSubMode === 'play' ? 'car-heading' : editSubMode,
      showPlayArrows: Boolean(isPlayPreLaunch),
    });
  }

  /**
   * Updates all 3D arrows and ground footprint rings from the current shot item state.
   * @param {object} shot - StaticTrainingShotItem
   * @param {object} options - { isEditMode, editSubMode, showPlayArrows }
   */
  updateFromShot(shot, options = {}) {
    if (!shot || !this.root) {
      this.setVisible(false);
      return;
    }

    const {
      isEditMode = false,
      editSubMode = 'car-heading',
      showPlayArrows = false,
    } = options;

    if (!isEditMode && !showPlayArrows) {
      this.setVisible(false);
      return;
    }

    this.setVisible(true);

    const car = shot.car || {};
    const ball = shot.ball || {};
    const carLoc = car.location || car.pos || [0, -2400, 17.05];
    const ballLoc = ball.location || ball.pos || [0, 0, 93.15];

    // RocketSim (x, y, z) -> Three.js (x, z, y)
    const carPosThree = new THREE.Vector3(
      carLoc[0],
      carLoc[2] + 32,
      carLoc[1]
    );
    const ballPosThree = new THREE.Vector3(
      ballLoc[0],
      ballLoc[2],
      ballLoc[1]
    );

    // Car Heading direction vector in Three.js
    const chPitch = car.snapToGround ? 0 : Number(car.headingPitch) || 0;
    const chYaw = Number(car.headingYaw) || 0;
    const carHeadingDirThree = new THREE.Vector3(
      Math.cos(chPitch) * Math.cos(chYaw),
      Math.sin(chPitch),
      Math.cos(chPitch) * Math.sin(chYaw)
    );

    // Car Speed direction vector in Three.js
    const followsHeading = car.speedFollowsHeading !== false;
    const csPitch = followsHeading
      ? chPitch
      : Number(car.speedPitch ?? car.headingPitch) || 0;
    const csYaw = followsHeading
      ? chYaw
      : Number(car.speedYaw ?? car.headingYaw) || 0;
    const carSpeedDirThree = new THREE.Vector3(
      Math.cos(csPitch) * Math.cos(csYaw),
      Math.sin(csPitch),
      Math.cos(csPitch) * Math.sin(csYaw)
    );

    // Ball Speed direction vector in Three.js
    const bsPitch = Number(ball.speedPitch) || 0;
    const bsYaw = Number(ball.speedYaw) || 0;
    const ballSpeedDirThree = new THREE.Vector3(
      Math.cos(bsPitch) * Math.cos(bsYaw),
      Math.sin(bsPitch),
      Math.cos(bsPitch) * Math.sin(bsYaw)
    );

    // 1. Update Car Speed Direction Arrow
    const carSpeedVal = Number(car.speed) || 0;
    if (isEditMode) {
      this.carSpeedArrow.visible =
        carSpeedVal > 0 || editSubMode === 'car-speed' || editSubMode === 'free-cam';
      const arrowLen = 150 + (carSpeedVal / 2300) * 340;
      update3DArrowMesh(
        this.carSpeedArrow,
        carPosThree,
        carSpeedDirThree,
        arrowLen,
        editSubMode === 'car-speed' || (editSubMode === 'car-heading' && carSpeedVal > 0)
      );
    } else if (showPlayArrows) {
      // In Play Mode before player moves: always show Car Speed Direction arrow
      // (if speed > 0 use speed direction; if speed === 0 show heading arrow so direction is clear)
      this.carSpeedArrow.visible = true;
      const effectiveDir = carSpeedVal > 1 ? carSpeedDirThree : carHeadingDirThree;
      const arrowLen = carSpeedVal > 1 ? 160 + (carSpeedVal / 2300) * 320 : 175;
      update3DArrowMesh(this.carSpeedArrow, carPosThree, effectiveDir, arrowLen, true);
    } else {
      this.carSpeedArrow.visible = false;
    }

    // 2. Update Car Heading Arrow (Edit Mode only)
    if (isEditMode) {
      this.carHeadingArrow.visible = true;
      update3DArrowMesh(
        this.carHeadingArrow,
        carPosThree,
        carHeadingDirThree,
        195,
        editSubMode === 'car-heading'
      );
    } else {
      this.carHeadingArrow.visible = false;
    }

    // 3. Update Ball Speed Arrow & Kickoff Halo
    const ballSpeedVal = Number(ball.speed) || 0;
    if (isEditMode) {
      this.ballSpeedArrow.visible = !ball.kickoffState && (ballSpeedVal > 0 || editSubMode === 'ball-speed');
      const bLen = 160 + (ballSpeedVal / 4000) * 380;
      update3DArrowMesh(
        this.ballSpeedArrow,
        ballPosThree,
        ballSpeedDirThree,
        bLen,
        editSubMode === 'ball-speed'
      );
    } else {
      this.ballSpeedArrow.visible = false;
    }

    this.ballKickoffHalo.visible = Boolean(ball.kickoffState);
    if (this.ballKickoffHalo.visible) {
      this.ballKickoffHalo.position.copy(ballPosThree);
    }

    // 4. Update Ground Rings & Drop-Lines (Edit Mode)
    const showFootprints = Boolean(isEditMode);
    this.carGroundRing.visible = showFootprints;
    this.ballGroundRing.visible = showFootprints;
    this.carDropLine.visible = showFootprints;
    this.ballDropLine.visible = showFootprints;

    if (showFootprints) {
      this.carGroundRing.position.set(carLoc[0], 3, carLoc[1]);
      this.ballGroundRing.position.set(ballLoc[0], 3, ballLoc[1]);

      const carLinePos = this.carDropLineGeo.attributes.position;
      carLinePos.setXYZ(0, carLoc[0], 3, carLoc[1]);
      carLinePos.setXYZ(1, carLoc[0], carLoc[2], carLoc[1]);
      carLinePos.needsUpdate = true;

      const ballLinePos = this.ballDropLineGeo.attributes.position;
      ballLinePos.setXYZ(0, ballLoc[0], 3, ballLoc[1]);
      ballLinePos.setXYZ(1, ballLoc[0], ballLoc[2], ballLoc[1]);
      ballLinePos.needsUpdate = true;
    }
  }

  dispose() {
    if (this.root && this.scene) {
      this.scene.remove(this.root);
    }
  }
}
