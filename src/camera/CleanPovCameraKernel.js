/**
 * CleanPovCameraKernel.js
 * Native JavaScript implementation of the Rocket League POV & Ball-Cam camera state machine.
 * Reconstructed from the standalone POV camera microkernel (camera.wasm) with full semantic naming.
 *
 * Implements:
 * - Quaternion-to-basis extraction (carUp, carRight, carForward) in Three.js Y-up coordinates
 * - 16-bit Unreal Rotator (UROT16: 65536 units = 2*PI rad) angular quantization & shortest-arc interpolation
 * - 3D exponential spring filters with maximum lag clamping for focus point, height offset, and camera distance
 * - Surface normal exponential smoothing and slope-compensated Ground Car-Cam pitch/yaw dual-rate blending
 * - Velocity-aligned Air Car-Cam tracking with reverse-motion pitch damping
 * - Ball-Cam elevation-adjusted focus and high-pitch angle scaling
 * - Quadratic ease-out transition blending when toggling between Ball-Cam and Car-Cam
 * - Asymmetric attack/release swivel (LookX / LookY) smoothing and aspect-corrected vertical FOV
 */

import {
  UROT_PER_RAD,
  UROT_PER_RAD_F32,
  DEG_TO_RAD,
  RAD_TO_DEG,
  HALF_PI,
  MAX_SWIVEL_PITCH_RAD,
  VIEW_BUFFER_FLOATS,
  saturateInt32,
  extendInt16,
  quantizeAngleRadiansToUrot16,
  radiansToRoundedUrotInt,
  interpolateUrot16Angle,
  wrapRadiansPi,
  createSpringFilter,
  createCameraPoseSnapshot,
  copyCameraPoseSnapshot,
  stepSpringFilter3D,
  computeAirCarCamRotation,
  computeGroundCarCamRotation,
} from './cleanPovCameraMath.js';

export class CleanPovCameraKernel {
  constructor() {
    this.viewBuffer = new Float64Array(VIEW_BUFFER_FLOATS);
    this.resetView();
  }

  resetView() {
    this.settings = {
      fov: 110.0,
      distance: 270.0,
      height: 100.0,
      angleDeg: -3.0,
      stiffness: 0.35,
      transitionSpeed: 1.0
    };

    this.requestedBallCam = true;
    this.activeBallCam = true;

    this.focusSpring = createSpringFilter(6.32, 0.0);
    this.heightSpring = createSpringFilter(2.03, 0.0);
    this.distanceSpring = createSpringFilter(4.14, 0.0);

    this.snapOrientationNextStep = true;
    this.prevGroundedState = true;
    this.isGroundedState = true;
    this.groundBlendWeight = 1.0;

    this.smoothedNormalX = 0.0;
    this.smoothedNormalY = 1.0;
    this.smoothedNormalZ = 0.0;

    this.primaryPose = createCameraPoseSnapshot();
    this.blendedPose = createCameraPoseSnapshot();
    this.transitionFromPose = createCameraPoseSnapshot();
    this.transitionToPose = createCameraPoseSnapshot();
    this.groundCandidatePose = createCameraPoseSnapshot();
    this.airCandidatePose = createCameraPoseSnapshot();
    this.workingPose = createCameraPoseSnapshot();

    this.finalCameraPosX = 0.0;
    this.finalCameraPosY = 0.0;
    this.finalCameraPosZ = 0.0;

    this.isInitialized = false;
    this.transitionRemainingTime = 0.0;
    this.transitionTotalDuration = 0.5;

    this.swivelYawOffset = 0.0;
    this.swivelPitchOffset = 0.0;

    this.transitionDelta = {
      focusX: 0,
      focusY: 0,
      focusZ: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      distance: 0,
      fov: 0
    };

    this.prevCarPosX = 0.0;
    this.prevCarPosY = 0.0;
    this.prevCarPosZ = 0.0;
    this.hasPrevCarPos = false;

    this.carVelX = 0.0;
    this.carVelY = 0.0;
    this.carVelZ = 0.0;

    this.surfaceNormalX = 0.0;
    this.surfaceNormalY = 1.0;
    this.surfaceNormalZ = 0.0;

    this.isSupersonic = false;

    this.carForwardX = 0.0;
    this.carForwardY = 0.0;
    this.carForwardZ = 0.0;

    this.carRightX = 0.0;
    this.carRightY = 0.0;
    this.carRightZ = 0.0;

    this.carUpX = 0.0;
    this.carUpY = 0.0;
    this.carUpZ = 0.0;

    this.scratchVecA = { x: 0, y: 0, z: 0 };
    this.scratchVecB = { x: 0, y: 0, z: 0 };
    this.scratchTarget = { x: 0, y: 0, z: 0 };
    this.scratchProjected = { x: 0, y: 0, z: 0 };
    this.scratchCarPos = { x: 0, y: 0, z: 0 };
    this.scratchBallPos = { x: 0, y: 0, z: 0 };
    this.scratchEulerA = { pitch: 0, yaw: 0, roll: 0 };
    this.scratchEulerB = { pitch: 0, yaw: 0, roll: 0 };
    this.scratchEulerC = { pitch: 0, yaw: 0, roll: 0 };

    this.viewBuffer.fill(0);
  }

  _stepSpringFilter(spring, dt) {
    stepSpringFilter3D(this, spring, dt);
  }

  _computeAirCarCamRotation(pose) {
    computeAirCarCamRotation(this, pose);
  }

  _computeGroundCarCamRotation(dt, pose) {
    computeGroundCarCamRotation(this, dt, pose);
  }

  _stepCameraPose(isBallCam, carPos, ballPos, dt, pose) {
    let groundTransitionRate;
    if (this.isGroundedState !== this.prevGroundedState) {
      this.prevGroundedState = this.isGroundedState;
      if (!this.isGroundedState) {
        groundTransitionRate = -4.0;
      } else {
        this.smoothedNormalX = this.surfaceNormalX;
        this.smoothedNormalY = this.surfaceNormalY;
        this.smoothedNormalZ = this.surfaceNormalZ;
        groundTransitionRate = 2.0;
      }
    } else {
      groundTransitionRate = this.isGroundedState ? 2.0 : -4.0;
    }

    const nextGroundWeight = Math.fround(
      Math.fround(this.groundBlendWeight) + Math.fround(groundTransitionRate * Math.fround(dt))
    );
    this.groundBlendWeight = Math.max(0.0, Math.min(1.0, nextGroundWeight));

    let heightOffsetX = 0.0;
    let heightOffsetY = 0.0;
    let heightOffsetZ = 0.0;
    let focusLagLimit = 100.0;

    if (isBallCam) {
      this.heightSpring.initialized = true;
      this.heightSpring.posZ = 0.0;
      this.heightSpring.posX = 0.0;
      this.heightSpring.posY = this.settings.height;
      heightOffsetY = this.settings.height;
      focusLagLimit = 0.001;
    } else {
      if (this.groundBlendWeight >= 1.0) {
        const h = this.settings.height;
        this.scratchTarget.z = this.carUpZ * h;
        this.scratchTarget.y = this.carUpY * h;
        this.scratchTarget.x = this.carUpX * h;
      } else {
        this.scratchTarget.z = 0.0;
        this.scratchTarget.y = this.settings.height;
        this.scratchTarget.x = 0.0;
      }
      this._stepSpringFilter(this.heightSpring, dt);
      heightOffsetZ = this.heightSpring.posZ;
      heightOffsetY = this.heightSpring.posY;
      heightOffsetX = this.heightSpring.posX;
      focusLagLimit = 100.0;
    }

    this.scratchTarget.x = carPos.x + heightOffsetX;
    this.scratchTarget.y = carPos.y + heightOffsetY;
    this.scratchTarget.z = carPos.z + heightOffsetZ;
    this.focusSpring.maxLagDistance = focusLagLimit;
    this._stepSpringFilter(this.focusSpring, dt);

    const prevYaw = pose.yaw;
    const prevPitch = pose.pitch;
    const sinPrevPitch = Math.fround(Math.sin(prevPitch));
    const cosPrevPitch = Math.fround(Math.cos(prevPitch));
    const cosPrevYaw = Math.fround(Math.cos(prevYaw));
    const sinPrevYaw = Math.fround(Math.sin(prevYaw));

    const prevDirY = sinPrevPitch;
    const prevDirZ = Math.fround(cosPrevPitch * cosPrevYaw);
    const prevDirX = Math.fround(cosPrevPitch * sinPrevYaw);
    this.scratchVecA.x = prevDirX;
    this.scratchVecA.y = prevDirY;
    this.scratchVecA.z = prevDirZ;

    const relSpringZ = Math.fround(this.focusSpring.posZ - pose.cameraPosZ);
    const relSpringY = Math.fround(this.focusSpring.posY - pose.cameraPosY);
    const relSpringX = Math.fround(this.focusSpring.posX - pose.cameraPosX);
    const dotSpring = Math.fround(
      Math.fround(
        Math.fround(prevDirY * relSpringY) + Math.fround(prevDirX * relSpringX)
      ) + Math.fround(prevDirZ * relSpringZ)
    );
    const perpSpringZ = Math.fround(relSpringZ - Math.fround(prevDirZ * dotSpring));
    const perpSpringY = Math.fround(relSpringY - Math.fround(prevDirY * dotSpring));
    const perpSpringX = Math.fround(relSpringX - Math.fround(prevDirX * dotSpring));

    const targetFocusX = this.scratchTarget.x;
    const targetFocusY = this.scratchTarget.y;
    const targetFocusZ = this.scratchTarget.z;
    const relTargetX = Math.fround(targetFocusX - pose.cameraPosX);
    const relTargetY = Math.fround(targetFocusY - pose.cameraPosY);
    const relTargetZ = Math.fround(targetFocusZ - pose.cameraPosZ);

    const dotTarget = Math.fround(
      Math.fround(
        Math.fround(prevDirY * relTargetY) + Math.fround(prevDirX * relTargetX)
      ) + Math.fround(prevDirZ * relTargetZ)
    );

    const projOffsetZ = Math.fround(perpSpringZ + Math.fround(prevDirZ * dotTarget));
    const projOffsetY = Math.fround(perpSpringY + Math.fround(prevDirY * dotTarget));
    const projOffsetX = Math.fround(perpSpringX + Math.fround(prevDirX * dotTarget));
    this.scratchVecB.x = projOffsetX;
    this.scratchVecB.y = projOffsetY;
    this.scratchVecB.z = projOffsetZ;

    const baseFocusZ = Math.fround(pose.cameraPosZ + projOffsetZ);
    const baseFocusY = Math.fround(pose.cameraPosY + projOffsetY);
    const baseFocusX = Math.fround(pose.cameraPosX + projOffsetX);
    this.scratchProjected.x = baseFocusX;
    this.scratchProjected.y = baseFocusY;
    this.scratchProjected.z = baseFocusZ;

    const stiffnessF32 = Math.fround(this.settings.stiffness);
    pose.focusY = Math.fround(Math.fround(Math.fround(targetFocusY - baseFocusY) * stiffnessF32) + baseFocusY);
    pose.focusZ = Math.fround(Math.fround(Math.fround(targetFocusZ - baseFocusZ) * stiffnessF32) + baseFocusZ);
    pose.focusX = Math.fround(Math.fround(Math.fround(targetFocusX - baseFocusX) * stiffnessF32) + baseFocusX);

    if (isBallCam) {
      const toBallX = ballPos.x - pose.focusX;
      const toBallY = ballPos.y - pose.focusY;
      const toBallZ = ballPos.z - pose.focusZ;
      const elevToBall = quantizeAngleRadiansToUrot16(Math.atan2(toBallY, Math.hypot(toBallX, toBallZ)));
      pose.focusY += Math.abs(elevToBall * UROT_PER_RAD) * 0.005;

      const lookBallX = ballPos.x - pose.focusX;
      const lookBallY = ballPos.y - pose.focusY;
      const lookBallZ = ballPos.z - pose.focusZ;
      this.scratchVecA.x = lookBallX;
      this.scratchVecA.y = lookBallY;
      this.scratchVecA.z = lookBallZ;

      let yawUnits = 16384.0;
      const horizBallDist = Math.hypot(lookBallX, lookBallZ);
      if (horizBallDist > 1e-9) {
        const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(lookBallZ, lookBallX)) * UROT_PER_RAD_F32)));
        yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
      }
      this.scratchEulerA.roll = 0.0;
      const ballYaw = yawUnits / UROT_PER_RAD;
      this.scratchEulerA.yaw = ballYaw;

      const rawBallPitch = quantizeAngleRadiansToUrot16(Math.atan2(lookBallY, horizBallDist));
      const baseAnglePitch = quantizeAngleRadiansToUrot16(this.settings.angleDeg * DEG_TO_RAD);
      const highAngleFactor = Math.max(0.0, Math.min(1.0, (Math.abs(rawBallPitch * UROT_PER_RAD) - 4000.0) / 4000.0));
      const ballPitch = quantizeAngleRadiansToUrot16(
        (rawBallPitch - baseAnglePitch) * 0.8 * highAngleFactor + baseAnglePitch
      );
      this.scratchEulerA.pitch = ballPitch;

      if (this.snapOrientationNextStep) {
        pose.roll = this.scratchEulerA.roll;
        pose.yaw = this.scratchEulerA.yaw;
        pose.pitch = this.scratchEulerA.pitch;
      } else {
        const ballCamAlpha = 1.0 - Math.exp(dt * -8.59);
        pose.roll = wrapRadiansPi(pose.roll + wrapRadiansPi(0.0 - pose.roll) * ballCamAlpha);
        pose.yaw = wrapRadiansPi(pose.yaw + wrapRadiansPi(ballYaw - pose.yaw) * ballCamAlpha);
        pose.pitch = wrapRadiansPi(pose.pitch + wrapRadiansPi(ballPitch - pose.pitch) * ballCamAlpha);
      }
    } else if (this.groundBlendWeight >= 1.0) {
      this._computeGroundCarCamRotation(dt, pose);
    } else if (this.groundBlendWeight <= 0.0) {
      this._computeAirCarCamRotation(pose);
    } else {
      copyCameraPoseSnapshot(this.groundCandidatePose, pose);
      copyCameraPoseSnapshot(this.airCandidatePose, pose);
      this._computeGroundCarCamRotation(dt, this.groundCandidatePose);
      this._computeAirCarCamRotation(this.airCandidatePose);

      const w = this.groundBlendWeight;
      const wF32 = Math.fround(w);
      pose.focusX = this.airCandidatePose.focusX + (this.groundCandidatePose.focusX - this.airCandidatePose.focusX) * w;
      pose.focusY = this.airCandidatePose.focusY + (this.groundCandidatePose.focusY - this.airCandidatePose.focusY) * w;
      pose.focusZ = this.airCandidatePose.focusZ + (this.groundCandidatePose.focusZ - this.airCandidatePose.focusZ) * w;

      pose.pitch = interpolateUrot16Angle(this.airCandidatePose.pitch, this.groundCandidatePose.pitch, wF32);
      pose.yaw = interpolateUrot16Angle(this.airCandidatePose.yaw, this.groundCandidatePose.yaw, wF32);
      pose.roll = interpolateUrot16Angle(this.airCandidatePose.roll, this.groundCandidatePose.roll, wF32);

      pose.distance = this.airCandidatePose.distance + (this.groundCandidatePose.distance - this.airCandidatePose.distance) * w;
      pose.fov = this.airCandidatePose.fov + (this.groundCandidatePose.fov - this.airCandidatePose.fov) * w;

      const cosP = Math.fround(Math.cos(pose.pitch));
      const sinP = Math.fround(Math.sin(pose.pitch));
      const dirZ = Math.fround(cosP * Math.fround(Math.cos(pose.yaw)));
      const dirY = sinP;
      const dirX = Math.fround(cosP * Math.fround(Math.sin(pose.yaw)));
      this.scratchVecA.x = dirX;
      this.scratchVecA.y = dirY;
      this.scratchVecA.z = dirZ;

      const distF32 = Math.fround(pose.distance);
      pose.cameraPosZ = Math.fround(pose.focusZ - Math.fround(dirZ * distF32));
      pose.cameraPosX = Math.fround(pose.focusX - Math.fround(dirX * distF32));
      const rawCamY = Math.fround(pose.focusY - Math.fround(distF32 * dirY));
      pose.cameraPosY = rawCamY < 10.0 ? 10.0 : rawCamY;
    }

    const sinPitch = Math.fround(Math.sin(pose.pitch));
    const cosPitch = Math.fround(Math.cos(pose.pitch));
    const cosYaw = Math.fround(Math.cos(pose.yaw));
    const sinYaw = Math.fround(Math.sin(pose.yaw));
    const dirY = sinPitch;
    const dirZ = Math.fround(cosPitch * cosYaw);
    const dirX = Math.fround(cosPitch * sinYaw);
    this.scratchVecA.x = dirX;
    this.scratchVecA.y = dirY;
    this.scratchVecA.z = dirZ;

    const forwardSpeed = this.carVelZ * dirZ + (this.carVelX * dirX + this.carVelY * dirY);
    const speedStretch = (1.0 - this.settings.stiffness) * (forwardSpeed * 0.05);
    this.scratchTarget.x = this.settings.distance + (speedStretch < -50.0 ? -50.0 : speedStretch);
    this.scratchTarget.y = 0.0;
    this.scratchTarget.z = 0.0;

    this._stepSpringFilter(this.distanceSpring, dt);
    const currentDistF32 = Math.fround(this.distanceSpring.posX);
    pose.distance = currentDistF32;

    let targetFov = this.settings.fov;
    let fovRate;
    if (this.isSupersonic) {
      targetFov += 10.0;
      fovRate = 40.0;
    } else {
      const carSpeed = Math.sqrt(
        this.carVelZ * this.carVelZ + this.carVelX * this.carVelX + this.carVelY * this.carVelY
      );
      targetFov += (carSpeed / 2300.0) * 5.0;
      fovRate = 25.0;
    }

    if (this.snapOrientationNextStep) {
      pose.fov = targetFov;
    } else {
      const maxFovDelta = dt * fovRate;
      const fovDiff = targetFov - pose.fov;
      if (Math.abs(fovDiff) <= maxFovDelta) {
        pose.fov = targetFov;
      } else {
        pose.fov += fovDiff < 0.0 ? -maxFovDelta : maxFovDelta;
      }
    }

    if (!isBallCam && this.groundBlendWeight > 0.0) {
      const rightTilt = Math.atan2(this.carRightY, Math.hypot(this.carRightX, this.carRightZ));
      pose.roll = quantizeAngleRadiansToUrot16(this.groundBlendWeight * (rightTilt * -0.1));
    }

    const finalSinP = Math.fround(Math.sin(pose.pitch));
    const finalCosP = Math.fround(Math.cos(pose.pitch));
    const finalCosY = Math.fround(Math.cos(pose.yaw));
    const finalSinY = Math.fround(Math.sin(pose.yaw));
    const finalDirY = finalSinP;
    const finalDirZ = Math.fround(finalCosP * finalCosY);
    const finalDirX = Math.fround(finalCosP * finalSinY);

    pose.cameraPosZ = Math.fround(pose.focusZ - Math.fround(finalDirZ * currentDistF32));
    pose.cameraPosX = Math.fround(pose.focusX - Math.fround(finalDirX * currentDistF32));
    const finalCamY = Math.fround(pose.focusY - Math.fround(currentDistF32 * finalDirY));
    pose.cameraPosY = finalCamY < 10.0 ? 10.0 : finalCamY;

    this.snapOrientationNextStep = false;
  }

  stepView(inputView) {
    if (inputView) {
      this.viewBuffer.set(inputView, 0);
    }
    const v = this.viewBuffer;

    if (
      !Number.isFinite(this.focusSpring.posX) ||
      !Number.isFinite(this.focusSpring.posY) ||
      !Number.isFinite(this.focusSpring.posZ) ||
      !Number.isFinite(this.primaryPose.cameraPosX) ||
      !Number.isFinite(this.primaryPose.cameraPosY) ||
      !Number.isFinite(this.primaryPose.cameraPosZ) ||
      !Number.isFinite(this.primaryPose.yaw) ||
      !Number.isFinite(this.primaryPose.pitch)
    ) {
      const savedView = new Float64Array(v);
      this.resetView();
      this.viewBuffer.set(savedView, 0);
    }

    const rawDt = Number.isFinite(v[0]) ? v[0] : 0.0;
    const ballCamInput = Number.isFinite(v[1]) ? v[1] : 1.0;
    const carPos = this.scratchCarPos;
    carPos.x = Number.isFinite(v[2]) ? v[2] : (Number.isFinite(this.prevCarPosX) ? this.prevCarPosX : 0.0);
    carPos.y = Number.isFinite(v[3]) ? v[3] : (Number.isFinite(this.prevCarPosY) ? this.prevCarPosY : 17.0);
    carPos.z = Number.isFinite(v[4]) ? v[4] : (Number.isFinite(this.prevCarPosZ) ? this.prevCarPosZ : 0.0);
    const rawQx = v[5];
    const rawQy = v[6];
    const rawQz = v[7];
    const rawQw = v[8];
    const quatFinite =
      Number.isFinite(rawQx) &&
      Number.isFinite(rawQy) &&
      Number.isFinite(rawQz) &&
      Number.isFinite(rawQw) &&
      (rawQx * rawQx + rawQy * rawQy + rawQz * rawQz + rawQw * rawQw) > 1e-8;
    const qx = quatFinite ? rawQx : 0.0;
    const qy = quatFinite ? rawQy : 0.0;
    const qz = quatFinite ? rawQz : 0.0;
    const qw = quatFinite ? rawQw : 1.0;
    const ballPos = this.scratchBallPos;
    ballPos.x = Number.isFinite(v[9]) ? v[9] : 0.0;
    ballPos.y = Number.isFinite(v[10]) ? v[10] : 93.15;
    ballPos.z = Number.isFinite(v[11]) ? v[11] : 0.0;
    const flags = saturateInt32(v[12]);
    const onGroundInput = Number.isFinite(v[13]) ? v[13] : 1.0;
    let normalX = Number.isFinite(v[14]) ? v[14] : 0.0;
    let normalY = Number.isFinite(v[15]) ? v[15] : 1.0;
    let normalZ = Number.isFinite(v[16]) ? v[16] : 0.0;
    let velX = Number.isFinite(v[17]) ? v[17] : 0.0;
    let velY = Number.isFinite(v[18]) ? v[18] : 0.0;
    let velZ = Number.isFinite(v[19]) ? v[19] : 0.0;
    const supersonicInput = Number.isFinite(v[20]) ? v[20] : 0.0;

    this.settings.fov = Number.isFinite(v[21]) && v[21] > 10 ? v[21] : 110.0;
    this.settings.distance = Number.isFinite(v[22]) ? v[22] : 270.0;
    this.settings.height = Number.isFinite(v[23]) ? v[23] : 100.0;
    this.settings.angleDeg = Number.isFinite(v[24]) ? v[24] : -3.0;
    this.settings.stiffness = Number.isFinite(v[25]) ? v[25] : 0.35;
    this.settings.transitionSpeed = Number.isFinite(v[26]) ? v[26] : 1.0;

    const aspectInput = Number.isFinite(v[27]) && v[27] > 0 ? v[27] : (16 / 9);
    const lookXInput = Number.isFinite(v[28]) ? v[28] : 0.0;
    const lookYInput = Number.isFinite(v[29]) ? v[29] : 0.0;
    const swivelSpeedInput = Number.isFinite(v[30]) ? v[30] : 4.0;
    const invertSwivelInput = Number.isFinite(v[31]) ? v[31] : 0.0;

    const upX = 2.0 * (qx * qy - qw * qz);
    const upY = qw * qw - qx * qx + qy * qy - qz * qz;
    const upZ = 2.0 * (qy * qz + qw * qx);
    const upLenSq = upZ * upZ + upX * upX + upY * upY;
    const invUpLen = upLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(upLenSq);
    this.carUpX = upX * invUpLen;
    this.carUpY = upY * invUpLen;
    this.carUpZ = upZ * invUpLen;

    const rightX = 2.0 * (qx * qz + qw * qy);
    const rightY = 2.0 * (qy * qz - qw * qx);
    const rightZ = qw * qw - qx * qx - qy * qy + qz * qz;
    const rightLenSq = rightZ * rightZ + rightX * rightX + rightY * rightY;
    const invRightLen = rightLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(rightLenSq);
    this.carRightX = rightX * invRightLen;
    this.carRightY = rightY * invRightLen;
    this.carRightZ = rightZ * invRightLen;

    const fwdX = qw * qw + qx * qx - qy * qy - qz * qz;
    const fwdY = 2.0 * (qx * qy + qw * qz);
    const fwdZ = 2.0 * (qx * qz - qw * qy);
    const fwdLenSq = fwdZ * fwdZ + fwdX * fwdX + fwdY * fwdY;
    const invFwdLen = fwdLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(fwdLenSq);
    this.carForwardX = fwdX * invFwdLen;
    this.carForwardY = fwdY * invFwdLen;
    this.carForwardZ = fwdZ * invFwdLen;

    const clampedDt = rawDt < 0.05 ? rawDt : 0.05;
    const hasPositiveDt = clampedDt > 0.0;
    const dt = hasPositiveDt ? clampedDt : 0.0;

    const hasVelocityFlag = (flags & 4) !== 0;
    const hasNormalFlag = (flags & 2) !== 0;
    const hasGroundFlag = (flags & 1) !== 0;
    const hasSupersonicFlag = (flags & 8) !== 0;

    let didTeleport = false;
    if (this.hasPrevCarPos) {
      const dx = this.prevCarPosX - carPos.x;
      const dy = this.prevCarPosY - carPos.y;
      const dz = this.prevCarPosZ - carPos.z;
      didTeleport = Math.sqrt(dz * dz + dx * dx + dy * dy) > 1000.0;
    }

    if (hasVelocityFlag) {
      this.carVelX = velX;
      this.carVelY = velY;
      this.carVelZ = velZ;
    } else if (!didTeleport && hasPositiveDt && this.hasPrevCarPos) {
      const invDt = 1.0 / dt;
      this.carVelZ = (carPos.z - this.prevCarPosZ) * invDt;
      this.carVelY = (carPos.y - this.prevCarPosY) * invDt;
      this.carVelX = (carPos.x - this.prevCarPosX) * invDt;
      velX = this.carVelX;
      velY = this.carVelY;
      velZ = this.carVelZ;
    } else {
      this.carVelX = 0.0;
      this.carVelY = 0.0;
      this.carVelZ = 0.0;
      velX = 0.0;
      velY = 0.0;
      velZ = 0.0;
    }

    this.hasPrevCarPos = true;
    this.prevCarPosX = carPos.x;
    this.prevCarPosY = carPos.y;
    this.prevCarPosZ = carPos.z;

    const isGrounded = hasGroundFlag
      ? onGroundInput !== 0.0
      : (carPos.y < 40.0 && this.carUpY > 0.45);
    this.isGroundedState = isGrounded;

    if (!hasNormalFlag) {
      const isFlatFloor = isGrounded && carPos.y < 60.0 && this.carUpY > 0.7;
      normalX = isFlatFloor ? 0.0 : this.carUpX;
      normalY = isFlatFloor ? 1.0 : this.carUpY;
      normalZ = isFlatFloor ? 0.0 : this.carUpZ;
    }

    const normalMagSq = normalZ * normalZ + normalX * normalX + normalY * normalY;
    const isDegenerateNormal = normalMagSq < 1e-8;
    const safeNX = isDegenerateNormal ? 0.0 : normalX;
    const safeNY = isDegenerateNormal ? 1.0 : normalY;
    const safeNZ = isDegenerateNormal ? 0.0 : normalZ;
    const safeNLenSq = safeNZ * safeNZ + safeNX * safeNX + safeNY * safeNY;
    const invSafeNLen = safeNLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(safeNLenSq);
    this.surfaceNormalX = safeNX * invSafeNLen;
    this.surfaceNormalY = safeNY * invSafeNLen;
    this.surfaceNormalZ = safeNZ * invSafeNLen;

    const wantBallCam = ballCamInput !== 0.0;
    if (hasSupersonicFlag) {
      this.isSupersonic = supersonicInput !== 0.0;
    } else {
      this.isSupersonic = Math.sqrt(velZ * velZ + velX * velX + velY * velY) >= 2200.0;
    }

    const prevRequestedBallCam = this.requestedBallCam;
    this.requestedBallCam = wantBallCam;

    if (didTeleport && this.isInitialized) {
      this.focusSpring.initialized = false;
    }

    if (!this.isInitialized) {
      let yawUnits = 16384.0;
      const fwdHoriz = Math.hypot(this.carForwardX, this.carForwardZ);
      if (fwdHoriz > 1e-9) {
        const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(this.carForwardZ, this.carForwardX)) * UROT_PER_RAD_F32)));
        yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
      }
      const initYaw = yawUnits / UROT_PER_RAD;
      const fwdPitch = quantizeAngleRadiansToUrot16(Math.atan2(this.carForwardY, fwdHoriz));
      const settingPitch = quantizeAngleRadiansToUrot16(this.settings.angleDeg * DEG_TO_RAD);
      const initPitch = quantizeAngleRadiansToUrot16(fwdPitch + settingPitch);

      this.primaryPose.fov = this.settings.fov;
      this.primaryPose.distance = this.settings.distance;
      this.primaryPose.roll = 0.0;
      this.primaryPose.yaw = initYaw;
      this.primaryPose.pitch = initPitch;
      this.primaryPose.focusZ = carPos.z + this.carUpZ * this.settings.height;
      this.primaryPose.focusY = carPos.y + this.carUpY * this.settings.height;
      this.primaryPose.focusX = carPos.x + this.carUpX * this.settings.height;

      const sinP = Math.fround(Math.sin(initPitch));
      const cosP = Math.fround(Math.cos(initPitch));
      const dirZ = Math.fround(cosP * Math.fround(Math.cos(initYaw)));
      const dirX = Math.fround(cosP * Math.fround(Math.sin(initYaw)));
      const distF32 = Math.fround(this.settings.distance);

      this.primaryPose.cameraPosZ = Math.fround(this.primaryPose.focusZ - Math.fround(dirZ * distF32));
      this.primaryPose.cameraPosX = Math.fround(this.primaryPose.focusX - Math.fround(dirX * distF32));
      const rawCamY = Math.fround(this.primaryPose.focusY - Math.fround(distF32 * sinP));
      this.primaryPose.cameraPosY = rawCamY < 10.0 ? 10.0 : rawCamY;

      copyCameraPoseSnapshot(this.blendedPose, this.primaryPose);

      this.smoothedNormalX = this.surfaceNormalX;
      this.smoothedNormalY = this.surfaceNormalY;
      this.smoothedNormalZ = this.surfaceNormalZ;
      this.groundBlendWeight = isGrounded ? 1.0 : 0.0;
      this.prevGroundedState = isGrounded;
      this.activeBallCam = wantBallCam;
      this.snapOrientationNextStep = true;
      this.distanceSpring.initialized = false;
      this.heightSpring.initialized = false;
      this.focusSpring.initialized = false;

      this._stepCameraPose(wantBallCam, carPos, ballPos, dt, this.primaryPose);
      copyCameraPoseSnapshot(this.blendedPose, this.primaryPose);
      this.isInitialized = true;
      this.transitionRemainingTime = 0.0;
    } else if (wantBallCam !== prevRequestedBallCam) {
      copyCameraPoseSnapshot(this.transitionFromPose, this.primaryPose);
      this._stepCameraPose(this.activeBallCam, carPos, ballPos, dt, this.transitionFromPose);

      this.snapOrientationNextStep = true;
      this.activeBallCam = this.requestedBallCam;
      this.prevGroundedState = this.isGroundedState;
      this.smoothedNormalX = this.surfaceNormalX;
      this.smoothedNormalY = this.surfaceNormalY;
      this.smoothedNormalZ = this.surfaceNormalZ;
      this.groundBlendWeight = this.isGroundedState ? 1.0 : 0.0;
      this.distanceSpring.initialized = false;
      this.heightSpring.initialized = false;
      this.focusSpring.initialized = false;

      copyCameraPoseSnapshot(this.transitionToPose, this.primaryPose);
      this._stepCameraPose(this.activeBallCam, carPos, ballPos, dt, this.transitionToPose);
      copyCameraPoseSnapshot(this.primaryPose, this.transitionToPose);

      this.transitionDelta.focusX = this.transitionFromPose.focusX - this.transitionToPose.focusX;
      this.transitionDelta.focusY = this.transitionFromPose.focusY - this.transitionToPose.focusY;
      this.transitionDelta.focusZ = this.transitionFromPose.focusZ - this.transitionToPose.focusZ;
      this.transitionDelta.pitch = wrapRadiansPi(this.transitionFromPose.pitch - this.transitionToPose.pitch);
      this.transitionDelta.yaw = wrapRadiansPi(this.transitionFromPose.yaw - this.transitionToPose.yaw);
      this.transitionDelta.roll = wrapRadiansPi(this.transitionFromPose.roll - this.transitionToPose.roll);
      this.transitionDelta.distance = this.transitionFromPose.distance - this.transitionToPose.distance;
      this.transitionDelta.fov = this.transitionFromPose.fov - this.transitionToPose.fov;

      const clampedSpeed = Math.max(0.1, Math.min(10.0, this.settings.transitionSpeed));
      const duration = 0.5 / clampedSpeed;
      this.transitionTotalDuration = duration;
      this.transitionRemainingTime = duration;
      copyCameraPoseSnapshot(this.blendedPose, this.transitionToPose);

      if (duration > 0.0) {
        const ratio = Math.max(0.0, Math.min(1.0, duration / duration));
        const weight = ratio * ratio;
        this.blendedPose.focusX += this.transitionDelta.focusX * weight;
        this.blendedPose.focusY += this.transitionDelta.focusY * weight;
        this.blendedPose.focusZ += this.transitionDelta.focusZ * weight;
        this.blendedPose.distance += this.transitionDelta.distance * weight;
        this.blendedPose.fov += this.transitionDelta.fov * weight;
        this.blendedPose.pitch = wrapRadiansPi(this.blendedPose.pitch + this.transitionDelta.pitch * weight);
        this.blendedPose.yaw = wrapRadiansPi(this.blendedPose.yaw + this.transitionDelta.yaw * weight);
        this.blendedPose.roll = wrapRadiansPi(this.blendedPose.roll + this.transitionDelta.roll * weight);
      }
    } else {
      copyCameraPoseSnapshot(this.workingPose, this.primaryPose);
      this._stepCameraPose(this.activeBallCam, carPos, ballPos, dt, this.workingPose);
      copyCameraPoseSnapshot(this.primaryPose, this.workingPose);
      copyCameraPoseSnapshot(this.blendedPose, this.workingPose);

      if (this.transitionRemainingTime > 0.0) {
        const ratio = Math.max(0.0, Math.min(1.0, this.transitionRemainingTime / this.transitionTotalDuration));
        const weight = ratio * ratio;
        this.blendedPose.focusX += this.transitionDelta.focusX * weight;
        this.blendedPose.focusY += this.transitionDelta.focusY * weight;
        this.blendedPose.focusZ += this.transitionDelta.focusZ * weight;
        this.blendedPose.pitch = wrapRadiansPi(this.blendedPose.pitch + this.transitionDelta.pitch * weight);
        this.blendedPose.yaw = wrapRadiansPi(this.blendedPose.yaw + this.transitionDelta.yaw * weight);
        this.blendedPose.roll = wrapRadiansPi(this.blendedPose.roll + this.transitionDelta.roll * weight);
        this.blendedPose.distance += this.transitionDelta.distance * weight;
        this.blendedPose.fov += this.transitionDelta.fov * weight;
      }
      this.transitionRemainingTime = Math.max(0.0, this.transitionRemainingTime - dt);
    }

    let swivelYaw = this.swivelYawOffset;
    let swivelPitch = this.swivelPitchOffset;
    if (dt > 0.0) {
      const dtF32 = Math.fround(dt);
      const safeSwivelSpeed = Number.isFinite(swivelSpeedInput)
        ? Math.max(1.0, Math.min(10.0, swivelSpeedInput))
        : 4.0;
      const fastSwivelRate = safeSwivelSpeed * 3.0;

      const currPitchUrot = radiansToRoundedUrotInt(swivelPitch);
      const safeLookY = Number.isFinite(lookYInput)
        ? Math.max(-1.0, Math.min(1.0, lookYInput))
        : 0.0;
      const signedLookY = invertSwivelInput !== 0.0 ? safeLookY : -safeLookY;
      const targetPitchUrot = saturateInt32(
        Math.trunc(Math.fround(Math.fround(signedLookY * 1.0471975511965976) * UROT_PER_RAD_F32))
      );
      const pitchRate = Math.abs(targetPitchUrot) < Math.abs(currPitchUrot) ? fastSwivelRate : safeSwivelSpeed;
      const pitchAlpha = Math.min(1.0, Math.fround(dtF32 * Math.fround(pitchRate)));
      const nextPitchUrot = saturateInt32(
        Math.fround(currPitchUrot + Math.fround((targetPitchUrot - currPitchUrot) * pitchAlpha))
      );
      swivelPitch = nextPitchUrot / UROT_PER_RAD;

      const currYawUrot = radiansToRoundedUrotInt(swivelYaw);
      const safeLookX = Number.isFinite(lookXInput)
        ? Math.max(-1.0, Math.min(1.0, lookXInput))
        : 0.0;
      const targetYawUrot = saturateInt32(
        Math.trunc(Math.fround(Math.fround(safeLookX * -2.2689280275926285) * UROT_PER_RAD_F32))
      );
      const yawRate = Math.abs(targetYawUrot) < Math.abs(currYawUrot) ? fastSwivelRate : safeSwivelSpeed;
      const yawAlpha = Math.min(1.0, Math.fround(dtF32 * Math.fround(yawRate)));
      const nextYawUrot = saturateInt32(
        Math.fround(currYawUrot + Math.fround((targetYawUrot - currYawUrot) * yawAlpha))
      );
      swivelYaw = nextYawUrot / UROT_PER_RAD;
    }

    this.swivelPitchOffset = swivelPitch;
    this.swivelYawOffset = swivelYaw;

    let finalYaw = this.blendedPose.yaw;
    let finalPitch = this.blendedPose.pitch;
    if (swivelYaw !== 0.0 || swivelPitch !== 0.0) {
      finalYaw = wrapRadiansPi(finalYaw + swivelYaw);
      finalPitch = Math.max(-MAX_SWIVEL_PITCH_RAD, Math.min(MAX_SWIVEL_PITCH_RAD, finalPitch + swivelPitch));
      this.blendedPose.yaw = finalYaw;
      this.blendedPose.pitch = finalPitch;
    }

    const sinFinalPitch = Math.fround(Math.sin(finalPitch));
    const cosFinalPitch = Math.fround(Math.cos(finalPitch));
    const dirY = sinFinalPitch;
    const dirZ = Math.fround(Math.fround(Math.cos(finalYaw)) * cosFinalPitch);
    const dirX = Math.fround(Math.fround(Math.sin(finalYaw)) * cosFinalPitch);

    const finalDistF32 = Math.fround(this.blendedPose.distance);
    const camPosZ = Math.fround(this.blendedPose.focusZ - Math.fround(dirZ * finalDistF32));
    const camPosX = Math.fround(this.blendedPose.focusX - Math.fround(dirX * finalDistF32));
    const rawCamY = Math.fround(this.blendedPose.focusY - Math.fround(sinFinalPitch * finalDistF32));
    const camPosY = rawCamY < 10.0 ? 10.0 : rawCamY;

    this.finalCameraPosX = camPosX;
    this.finalCameraPosY = camPosY;
    this.finalCameraPosZ = camPosZ;

    let outUpX = 0.0;
    let outUpY = 1.0;
    let outUpZ = 0.0;
    const rollAngle = this.blendedPose.roll;
    if (Math.abs(rollAngle) > 1e-8) {
      const cosRoll = Math.cos(rollAngle);
      const sinRoll = Math.sin(rollAngle);
      const oneMinusCos = 1.0 - cosRoll;
      outUpZ = dirY * dirZ * oneMinusCos + dirX * sinRoll;
      outUpY = dirY * dirY * oneMinusCos + cosRoll;
      outUpX = dirY * dirX * oneMinusCos - dirZ * sinRoll;
    }

    v[32] = camPosX;
    v[33] = camPosY;
    v[34] = camPosZ;
    v[35] = dirX;
    v[36] = dirY;
    v[37] = dirZ;
    v[38] = outUpX;
    v[39] = outUpY;
    v[40] = outUpZ;

    const halfFovRad = (this.blendedPose.fov * DEG_TO_RAD) * 0.5;
    const tanHalfFov = Math.tan(halfFovRad);
    const effectiveAspect = aspectInput < 1.0 ? 1.7777777777777777 : aspectInput;
    const vertHalfFov = Math.atan(tanHalfFov / effectiveAspect);
    v[41] = (vertHalfFov + vertHalfFov) * RAD_TO_DEG;

    return v;
  }

  getViewArray() {
    return this.viewBuffer;
  }
}

export default CleanPovCameraKernel;
