/**
 * cleanPovCameraMath.js
 * Pure mathematical primitives, 16-bit Unreal Rotator (UROT16) quantization,
 * exponential spring filters, and Car-Cam air/ground rotation solvers
 * for CleanPovCameraKernel.
 */

export const UROT_PER_RAD = 10430.378350470453; // 32768 / Math.PI
export const UROT_PER_RAD_F32 = Math.fround(10430.3779296875);
export const DEG_TO_RAD = 0.017453292519943295; // Math.PI / 180
export const RAD_TO_DEG = 57.29577951308232;   // 180 / Math.PI
export const HALF_PI = 1.5707963267948966;
export const MAX_SWIVEL_PITCH_RAD = 1.4835298641951802; // 85 degrees in radians
export const VIEW_BUFFER_FLOATS = 42;

export function roundToNearestEven(value) {
  const absVal = Math.abs(value);
  if (absVal >= 4503599627370496.0) return value;
  const rounded = absVal + 4503599627370496.0 - 4503599627370496.0;
  return value < 0 ? -rounded : rounded;
}

export function saturateInt32(value) {
  if (Number.isNaN(value)) return 0;
  if (value >= 2147483647.0) return 2147483647;
  if (value <= -2147483648.0) return -2147483648;
  return Math.trunc(value) | 0;
}

export function extendInt16(value) {
  return (value << 16) >> 16;
}

export function quantizeAngleRadiansToUrot16(radians) {
  const scaled = Math.fround(Math.fround(radians) * UROT_PER_RAD_F32);
  const intUnits = extendInt16(saturateInt32(Math.trunc(scaled)));
  return intUnits / UROT_PER_RAD;
}

export function radiansToRoundedUrotInt(radians) {
  return saturateInt32(roundToNearestEven(radians * UROT_PER_RAD));
}

export function interpolateUrot16Angle(currentRad, targetRad, alphaF32) {
  const currentUrot = radiansToRoundedUrotInt(currentRad);
  const targetUrot = radiansToRoundedUrotInt(targetRad);
  const deltaUrot = extendInt16((targetUrot - currentUrot) | 0);
  const stepUrot = saturateInt32(Math.trunc(Math.fround(alphaF32 * Math.fround(deltaUrot))));
  const nextUrot = extendInt16((currentUrot + stepUrot) | 0);
  return nextUrot / UROT_PER_RAD;
}

export function wrapRadiansPi(radians) {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

export function createSpringFilter(rate, maxLagDistance = 0) {
  return {
    rate,
    maxLagDistance,
    scale: 0,
    posX: 0,
    posY: 0,
    posZ: 0,
    velX: 0,
    velY: 0,
    velZ: 0,
    initialized: false
  };
}

export function createCameraPoseSnapshot() {
  return {
    focusX: 0,
    focusY: 0,
    focusZ: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    distance: 270.0,
    fov: 110.0,
    cameraPosX: 0,
    cameraPosY: 0,
    cameraPosZ: 0
  };
}

export function copyCameraPoseSnapshot(dst, src) {
  dst.focusX = src.focusX;
  dst.focusY = src.focusY;
  dst.focusZ = src.focusZ;
  dst.pitch = src.pitch;
  dst.yaw = src.yaw;
  dst.roll = src.roll;
  dst.distance = src.distance;
  dst.fov = src.fov;
  dst.cameraPosX = src.cameraPosX;
  dst.cameraPosY = src.cameraPosY;
  dst.cameraPosZ = src.cameraPosZ;
}

export function stepSpringFilter3D(kernel, spring, dt) {
  const targetX = kernel.scratchTarget.x;
  const targetY = kernel.scratchTarget.y;
  const targetZ = kernel.scratchTarget.z;

  if (!spring.initialized) {
    spring.initialized = true;
    spring.posX = targetX;
    spring.posY = targetY;
    spring.posZ = targetZ;
    spring.velX = 0.0;
    spring.velY = 0.0;
    spring.velZ = 0.0;
    return;
  }

  const alpha = 1.0 - Math.exp(dt * -spring.rate);
  spring.posX += (targetX - spring.posX) * alpha;
  spring.posY += (targetY - spring.posY) * alpha;
  spring.posZ += (targetZ - spring.posZ) * alpha;

  const diffX = targetX - spring.posX;
  const diffY = targetY - spring.posY;
  const diffZ = targetZ - spring.posZ;
  kernel.scratchVecB.x = diffX;
  kernel.scratchVecB.y = diffY;
  kernel.scratchVecB.z = diffZ;

  if (spring.maxLagDistance > 0.0) {
    const distSq = diffZ * diffZ + diffX * diffX + diffY * diffY;
    if (distSq > spring.maxLagDistance * spring.maxLagDistance) {
      const invDist = distSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(distSq);
      const clampedZ = spring.maxLagDistance * (diffZ * invDist);
      const clampedY = spring.maxLagDistance * (diffY * invDist);
      const clampedX = spring.maxLagDistance * (diffX * invDist);
      kernel.scratchVecB.z = clampedZ;
      kernel.scratchVecB.y = clampedY;
      kernel.scratchVecB.x = clampedX;
      spring.posZ = targetZ - clampedZ;
      spring.posY = targetY - clampedY;
      spring.posX = targetX - clampedX;
    }
  }

  spring.posZ = Math.fround(spring.posZ);
  spring.posY = Math.fround(spring.posY);
  spring.posX = Math.fround(spring.posX);

  const scale = spring.scale;
  spring.velZ = Math.fround(kernel.scratchVecB.z * scale);
  spring.velY = Math.fround(kernel.scratchVecB.y * scale);
  spring.velX = Math.fround(kernel.scratchVecB.x * scale);
}

export function computeAirCarCamRotation(kernel, pose) {
  if (kernel.snapOrientationNextStep) {
    const fwdY = kernel.carForwardY;
    let yawUnits = 16384.0;
    const horizMag = Math.hypot(kernel.carForwardX, kernel.carForwardZ);
    if (horizMag > 1e-9) {
      const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(kernel.carForwardZ, kernel.carForwardX)) * UROT_PER_RAD_F32)));
      yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
    }
    kernel.scratchEulerA.roll = 0.0;
    const forwardYaw = yawUnits / UROT_PER_RAD;
    kernel.scratchEulerA.yaw = forwardYaw;
    const forwardPitch = quantizeAngleRadiansToUrot16(Math.atan2(fwdY, horizMag));
    kernel.scratchEulerA.pitch = forwardPitch;

    const velX = kernel.carVelX;
    const velY = kernel.carVelY;
    const velZ = kernel.carVelZ;
    const speedSq = velZ * velZ + velX * velX + velY * velY;
    let velYaw, velPitch, velRoll, velHorizMag;

    if (speedSq > 1e-8) {
      let vYawUnits = 16384.0;
      velHorizMag = Math.hypot(velX, velZ);
      if (velHorizMag > 1e-9) {
        const rawVUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(velZ, velX)) * UROT_PER_RAD_F32)));
        vYawUnits = extendInt16((1073741824 - (rawVUnits << 16)) >> 16);
      }
      velRoll = 0.0;
      velYaw = vYawUnits / UROT_PER_RAD;
      velPitch = quantizeAngleRadiansToUrot16(Math.atan2(velY, velHorizMag));
      kernel.scratchEulerB.roll = velRoll;
      kernel.scratchEulerB.yaw = velYaw;
      kernel.scratchEulerB.pitch = velPitch;
    } else {
      velRoll = kernel.scratchEulerA.roll;
      velYaw = kernel.scratchEulerA.yaw;
      velPitch = kernel.scratchEulerA.pitch;
      kernel.scratchEulerB.roll = velRoll;
      kernel.scratchEulerB.yaw = velYaw;
      kernel.scratchEulerB.pitch = velPitch;
      velHorizMag = Math.hypot(velX, velZ);
    }

    const speedBlend = Math.min(1.0, velHorizMag / 500.0);
    kernel.scratchEulerC.roll = wrapRadiansPi(wrapRadiansPi(velRoll) * speedBlend);
    const blendedYaw = wrapRadiansPi(wrapRadiansPi(velYaw - forwardYaw) * speedBlend + forwardYaw);
    kernel.scratchEulerC.yaw = blendedYaw;
    kernel.scratchEulerC.pitch = wrapRadiansPi(wrapRadiansPi(velPitch - forwardPitch) * speedBlend + forwardPitch);

    pose.yaw = blendedYaw;
    pose.roll = 0.0;
    pose.pitch = quantizeAngleRadiansToUrot16(kernel.settings.angleDeg * DEG_TO_RAD);
    return;
  }

  const dirX = pose.focusX - pose.cameraPosX;
  const dirY = pose.focusY - pose.cameraPosY;
  const dirZ = pose.focusZ - pose.cameraPosZ;
  kernel.scratchVecA.x = dirX;
  kernel.scratchVecA.y = dirY;
  kernel.scratchVecA.z = dirZ;

  const vxF32 = Math.fround(kernel.carVelX);
  const vyF32 = Math.fround(kernel.carVelY);
  const vzF32 = Math.fround(kernel.carVelZ);
  const vxSqF32 = Math.fround(vxF32 * vxF32);
  const vySqF32 = Math.fround(vyF32 * vyF32);
  const vzSqF32 = Math.fround(vzF32 * vzF32);
  const speedRatio = Math.min(1.0, Math.fround(Math.fround(Math.sqrt(Math.fround(Math.fround(vxSqF32 + vySqF32) + vzSqF32))) / Math.fround(2300.0)));
  const stiffnessFactor = Math.fround(Math.fround(speedRatio * -25.0) + Math.fround(35.0));

  let yawUnits = 16384.0;
  const horizDist = Math.hypot(dirX, dirZ);
  if (horizDist > 1e-9) {
    const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(dirZ, dirX)) * UROT_PER_RAD_F32)));
    yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
  }
  kernel.scratchEulerA.roll = 0.0;
  const targetYaw = yawUnits / UROT_PER_RAD;
  kernel.scratchEulerA.yaw = targetYaw;
  const targetPitch = quantizeAngleRadiansToUrot16(Math.atan2(dirY, horizDist));
  kernel.scratchEulerA.pitch = targetPitch;

  const blendAlphaF32 = Math.fround(Math.min(1.0, stiffnessFactor / 60.0));
  pose.yaw = interpolateUrot16Angle(pose.yaw, targetYaw, blendAlphaF32);
  pose.pitch = interpolateUrot16Angle(pose.pitch, targetPitch, blendAlphaF32);
  pose.roll = interpolateUrot16Angle(pose.roll, 0.0, blendAlphaF32);

  const sinPitch = Math.fround(Math.sin(pose.pitch));
  const cosPitch = Math.fround(Math.cos(pose.pitch));
  const cosYaw = Math.fround(Math.cos(pose.yaw));
  const sinYaw = Math.fround(Math.sin(pose.yaw));

  const lookY = sinPitch;
  const lookZ = Math.fround(cosPitch * cosYaw);
  const lookX = Math.fround(cosPitch * sinYaw);
  kernel.scratchVecA.x = lookX;
  kernel.scratchVecA.y = lookY;
  kernel.scratchVecA.z = lookZ;

  const dotVel = kernel.carVelZ * lookZ + (kernel.carVelX * lookX + kernel.carVelY * lookY);
  if (dotVel < 0.0) {
    const horizSpeedRatio = Math.min(1.0, Math.fround(Math.fround(Math.sqrt(Math.fround(vxSqF32 + vzSqF32))) / Math.fround(2300.0)));
    const dampScaleF32 = Math.fround(1.0 - horizSpeedRatio);
    const pitchUrot = radiansToRoundedUrotInt(pose.pitch);
    const dampedUrot = extendInt16(saturateInt32(Math.trunc(Math.fround(dampScaleF32 * Math.fround(pitchUrot)))));
    pose.pitch = dampedUrot / UROT_PER_RAD;
  }
}

export function computeGroundCarCamRotation(kernel, dt, pose) {
  const blendAlpha = 1.0 - Math.exp(dt * -10.46);
  let nx = kernel.smoothedNormalX + (kernel.surfaceNormalX - kernel.smoothedNormalX) * blendAlpha;
  let ny = kernel.smoothedNormalY + (kernel.surfaceNormalY - kernel.smoothedNormalY) * blendAlpha;
  let nz = kernel.smoothedNormalZ + (kernel.surfaceNormalZ - kernel.smoothedNormalZ) * blendAlpha;
  const nLenSq = nz * nz + nx * nx + ny * ny;
  const invNLen = nLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(nLenSq);
  nx *= invNLen;
  ny *= invNLen;
  nz *= invNLen;
  kernel.smoothedNormalX = nx;
  kernel.smoothedNormalY = ny;
  kernel.smoothedNormalZ = nz;

  const c1Z = nx * kernel.carForwardY - ny * kernel.carForwardX;
  const c1Y = nz * kernel.carForwardX - nx * kernel.carForwardZ;
  const c1X = ny * kernel.carForwardZ - nz * kernel.carForwardY;
  kernel.scratchTarget.x = c1X;
  kernel.scratchTarget.y = c1Y;
  kernel.scratchTarget.z = c1Z;

  const projZ = c1X * ny - c1Y * nx;
  const projY = c1Z * nx - c1X * nz;
  const projX = c1Y * nz - c1Z * ny;
  kernel.scratchProjected.x = projX;
  kernel.scratchProjected.y = projY;
  kernel.scratchProjected.z = projZ;

  const elevAngle = Math.atan2(projY, Math.hypot(projX, projZ));
  const slopeBlend = Math.min(1.0, Math.abs(elevAngle * UROT_PER_RAD) / 48000.0);

  let targetNormalX = nx;
  let targetNormalY = ny;
  let targetNormalZ = nz;
  if (elevAngle > 0.0) {
    targetNormalX = -nx;
    targetNormalY = -ny;
    targetNormalZ = -nz;
    kernel.scratchVecB.x = targetNormalX;
    kernel.scratchVecB.y = targetNormalY;
    kernel.scratchVecB.z = targetNormalZ;
  }

  const blendedDirZ = projZ + (targetNormalZ - projZ) * slopeBlend;
  const blendedDirY = projY + (targetNormalY - projY) * slopeBlend;
  const blendedDirX = projX + (targetNormalX - projX) * slopeBlend;
  kernel.scratchVecA.x = blendedDirX;
  kernel.scratchVecA.y = blendedDirY;
  kernel.scratchVecA.z = blendedDirZ;

  let yawUnits = 16384.0;
  const horizLen = Math.hypot(blendedDirX, blendedDirZ);
  if (horizLen > 1e-9) {
    const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(blendedDirZ, blendedDirX)) * UROT_PER_RAD_F32)));
    yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
  }
  kernel.scratchEulerA.roll = 0.0;
  const baseYaw = yawUnits / UROT_PER_RAD;
  kernel.scratchEulerA.yaw = baseYaw;

  const basePitchRaw = quantizeAngleRadiansToUrot16(Math.atan2(blendedDirY, horizLen));
  const maxPitchRoom = HALF_PI - basePitchRaw;
  const settingPitchRad = quantizeAngleRadiansToUrot16(kernel.settings.angleDeg * DEG_TO_RAD);
  const clampedOffsetPitch = settingPitchRad > maxPitchRoom ? maxPitchRoom : settingPitchRad;
  const basePitch = quantizeAngleRadiansToUrot16(basePitchRaw + clampedOffsetPitch);
  kernel.scratchEulerA.pitch = basePitch;

  if (kernel.snapOrientationNextStep) {
    pose.roll = kernel.scratchEulerA.roll;
    pose.yaw = kernel.scratchEulerA.yaw;
    pose.pitch = kernel.scratchEulerA.pitch;
    return;
  }

  const stiffness = kernel.settings.stiffness;
  const stiffnessScale = stiffness * 2.427 + 1.0;

  let fastYaw, fastPitch, fastRoll;
  if (stiffness < 1.0) {
    const fastAlphaF32 = Math.fround(1.0 - Math.exp(dt * (stiffnessScale * -13.39)));
    fastYaw = interpolateUrot16Angle(pose.yaw, baseYaw, fastAlphaF32);
    fastPitch = interpolateUrot16Angle(pose.pitch, basePitch, fastAlphaF32);
    fastRoll = interpolateUrot16Angle(pose.roll, 0.0, fastAlphaF32);
    kernel.scratchEulerB.yaw = fastYaw;
    kernel.scratchEulerB.pitch = fastPitch;
    kernel.scratchEulerB.roll = fastRoll;
  } else {
    fastRoll = kernel.scratchEulerA.roll;
    fastYaw = kernel.scratchEulerA.yaw;
    fastPitch = kernel.scratchEulerA.pitch;
    kernel.scratchEulerB.roll = fastRoll;
    kernel.scratchEulerB.yaw = fastYaw;
    kernel.scratchEulerB.pitch = fastPitch;
  }

  const slowAlphaF32 = Math.fround(1.0 - Math.exp(dt * (stiffnessScale * -2.03)));
  const slowYaw = interpolateUrot16Angle(pose.yaw, baseYaw, slowAlphaF32);
  const slowPitch = interpolateUrot16Angle(pose.pitch, basePitch, slowAlphaF32);
  const slowRoll = interpolateUrot16Angle(pose.roll, 0.0, slowAlphaF32);
  kernel.scratchEulerC.yaw = slowYaw;
  kernel.scratchEulerC.pitch = slowPitch;
  kernel.scratchEulerC.roll = slowRoll;

  const wallBlendF32 = Math.fround(1.0 - Math.abs(ny));
  pose.yaw = interpolateUrot16Angle(fastYaw, slowYaw, wallBlendF32);
  pose.pitch = interpolateUrot16Angle(fastPitch, slowPitch, wallBlendF32);
  pose.roll = interpolateUrot16Angle(fastRoll, slowRoll, wallBlendF32);
}
