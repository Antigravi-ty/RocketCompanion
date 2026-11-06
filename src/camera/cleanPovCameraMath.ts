/**
 * cleanPovCameraMath.ts
 * Pure mathematical primitives, 16-bit Unreal Rotator (UROT16) quantization,
 * exponential spring filters, swivel smoothing, and Car-Cam / Ball-Cam rotation solvers.
 */

export const UROT_PER_RAD = 10430.378350470453; // 32768 / Math.PI
export const UROT_PER_RAD_F32 = Math.fround(10430.3779296875);
export const DEG_TO_RAD = 0.017453292519943295; // Math.PI / 180
export const RAD_TO_DEG = 57.29577951308232;   // 180 / Math.PI
export const HALF_PI = 1.5707963267948966;
export const MAX_SWIVEL_PITCH_RAD = 1.4835298641951802; // 85 degrees in radians
export const VIEW_BUFFER_FLOATS = 42;

export interface Vec3State { x: number; y: number; z: number; }
export interface EulerAnglesState { pitch: number; yaw: number; roll: number; }

export interface SpringFilter3DState {
  rate: number; maxLagDistance: number; scale: number;
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  initialized: boolean;
}

export interface CameraPoseSnapshot {
  focusX: number; focusY: number; focusZ: number;
  pitch: number; yaw: number; roll: number;
  distance: number; fov: number;
  cameraPosX: number; cameraPosY: number; cameraPosZ: number;
}

export interface PoseTransitionDelta {
  focusX: number; focusY: number; focusZ: number;
  pitch: number; yaw: number; roll: number;
  distance: number; fov: number;
}

export interface AirCarCamRotationInput {
  snapOrientation: boolean;
  carForwardX: number; carForwardY: number; carForwardZ: number;
  carVelX: number; carVelY: number; carVelZ: number;
  angleDeg: number;
  scratchVecA: Vec3State;
  scratchEulerA: EulerAnglesState; scratchEulerB: EulerAnglesState; scratchEulerC: EulerAnglesState;
}

export interface GroundCarCamRotationInput {
  snapOrientation: boolean; dt: number;
  surfaceNormalX: number; surfaceNormalY: number; surfaceNormalZ: number;
  smoothedNormalX: number; smoothedNormalY: number; smoothedNormalZ: number;
  carForwardX: number; carForwardY: number; carForwardZ: number;
  angleDeg: number; stiffness: number;
  scratchTarget: Vec3State; scratchProjected: Vec3State;
  scratchVecA: Vec3State; scratchVecB: Vec3State;
  scratchEulerA: EulerAnglesState; scratchEulerB: EulerAnglesState; scratchEulerC: EulerAnglesState;
}

export function roundToNearestEven(value: number): number {
  const absVal = Math.abs(value);
  if (absVal >= 4503599627370496.0) return value;
  const rounded = absVal + 4503599627370496.0 - 4503599627370496.0;
  return value < 0 ? -rounded : rounded;
}

export function saturateInt32(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value >= 2147483647.0) return 2147483647;
  if (value <= -2147483648.0) return -2147483648;
  return Math.trunc(value) | 0;
}

export function extendInt16(value: number): number {
  return (value << 16) >> 16;
}

export function quantizeAngleRadiansToUrot16(radians: number): number {
  const scaled = Math.fround(Math.fround(radians) * UROT_PER_RAD_F32);
  const intUnits = extendInt16(saturateInt32(Math.trunc(scaled)));
  return intUnits / UROT_PER_RAD;
}

export function radiansToRoundedUrotInt(radians: number): number {
  return saturateInt32(roundToNearestEven(radians * UROT_PER_RAD));
}

export function interpolateUrot16Angle(currentRad: number, targetRad: number, alphaF32: number): number {
  const currentUrot = radiansToRoundedUrotInt(currentRad);
  const targetUrot = radiansToRoundedUrotInt(targetRad);
  const deltaUrot = extendInt16((targetUrot - currentUrot) | 0);
  const stepUrot = saturateInt32(Math.trunc(Math.fround(alphaF32 * Math.fround(deltaUrot))));
  const nextUrot = extendInt16((currentUrot + stepUrot) | 0);
  return nextUrot / UROT_PER_RAD;
}

export function wrapRadiansPi(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

export function createSpringFilter(rate: number, maxLagDistance = 0): SpringFilter3DState {
  return {
    rate, maxLagDistance, scale: 0,
    posX: 0, posY: 0, posZ: 0,
    velX: 0, velY: 0, velZ: 0,
    initialized: false,
  };
}

export function createCameraPoseSnapshot(): CameraPoseSnapshot {
  return {
    focusX: 0, focusY: 0, focusZ: 0,
    pitch: 0, yaw: 0, roll: 0,
    distance: 270.0, fov: 110.0,
    cameraPosX: 0, cameraPosY: 0, cameraPosZ: 0,
  };
}

export function copyCameraPoseSnapshot(dst: CameraPoseSnapshot, src: CameraPoseSnapshot): void {
  dst.focusX = src.focusX; dst.focusY = src.focusY; dst.focusZ = src.focusZ;
  dst.pitch = src.pitch; dst.yaw = src.yaw; dst.roll = src.roll;
  dst.distance = src.distance; dst.fov = src.fov;
  dst.cameraPosX = src.cameraPosX; dst.cameraPosY = src.cameraPosY; dst.cameraPosZ = src.cameraPosZ;
}

export function computeTransitionDelta(
  delta: PoseTransitionDelta, fromPose: CameraPoseSnapshot, toPose: CameraPoseSnapshot
): void {
  delta.focusX = fromPose.focusX - toPose.focusX;
  delta.focusY = fromPose.focusY - toPose.focusY;
  delta.focusZ = fromPose.focusZ - toPose.focusZ;
  delta.pitch = wrapRadiansPi(fromPose.pitch - toPose.pitch);
  delta.yaw = wrapRadiansPi(fromPose.yaw - toPose.yaw);
  delta.roll = wrapRadiansPi(fromPose.roll - toPose.roll);
  delta.distance = fromPose.distance - toPose.distance;
  delta.fov = fromPose.fov - toPose.fov;
}

export function applyQuadraticTransitionBlend(
  pose: CameraPoseSnapshot, delta: PoseTransitionDelta,
  remainingTime: number, totalDuration: number, distanceFirst: boolean
): void {
  if (remainingTime <= 0.0 || totalDuration <= 0.0) return;
  const ratio = Math.max(0.0, Math.min(1.0, remainingTime / totalDuration));
  const weight = ratio * ratio;
  pose.focusX += delta.focusX * weight;
  pose.focusY += delta.focusY * weight;
  pose.focusZ += delta.focusZ * weight;
  if (distanceFirst) {
    pose.distance += delta.distance * weight;
    pose.fov += delta.fov * weight;
    pose.pitch = wrapRadiansPi(pose.pitch + delta.pitch * weight);
    pose.yaw = wrapRadiansPi(pose.yaw + delta.yaw * weight);
    pose.roll = wrapRadiansPi(pose.roll + delta.roll * weight);
  } else {
    pose.pitch = wrapRadiansPi(pose.pitch + delta.pitch * weight);
    pose.yaw = wrapRadiansPi(pose.yaw + delta.yaw * weight);
    pose.roll = wrapRadiansPi(pose.roll + delta.roll * weight);
    pose.distance += delta.distance * weight;
    pose.fov += delta.fov * weight;
  }
}

export function stepSpringFilter3D(
  spring: SpringFilter3DState, target: Vec3State, dt: number, outDiff: Vec3State
): void {
  const targetX = target.x, targetY = target.y, targetZ = target.z;
  if (!spring.initialized) {
    spring.initialized = true;
    spring.posX = targetX; spring.posY = targetY; spring.posZ = targetZ;
    spring.velX = 0.0; spring.velY = 0.0; spring.velZ = 0.0;
    return;
  }

  const alpha = 1.0 - Math.exp(dt * -spring.rate);
  spring.posX += (targetX - spring.posX) * alpha;
  spring.posY += (targetY - spring.posY) * alpha;
  spring.posZ += (targetZ - spring.posZ) * alpha;

  const diffX = targetX - spring.posX;
  const diffY = targetY - spring.posY;
  const diffZ = targetZ - spring.posZ;
  outDiff.x = diffX; outDiff.y = diffY; outDiff.z = diffZ;

  if (spring.maxLagDistance > 0.0) {
    const distSq = diffZ * diffZ + diffX * diffX + diffY * diffY;
    if (distSq > spring.maxLagDistance * spring.maxLagDistance) {
      const invDist = distSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(distSq);
      const clampedZ = spring.maxLagDistance * (diffZ * invDist);
      const clampedY = spring.maxLagDistance * (diffY * invDist);
      const clampedX = spring.maxLagDistance * (diffX * invDist);
      outDiff.z = clampedZ; outDiff.y = clampedY; outDiff.x = clampedX;
      spring.posZ = targetZ - clampedZ;
      spring.posY = targetY - clampedY;
      spring.posX = targetX - clampedX;
    }
  }

  spring.posZ = Math.fround(spring.posZ);
  spring.posY = Math.fround(spring.posY);
  spring.posX = Math.fround(spring.posX);

  const scale = spring.scale;
  spring.velZ = Math.fround(outDiff.z * scale);
  spring.velY = Math.fround(outDiff.y * scale);
  spring.velX = Math.fround(outDiff.x * scale);
}

export function computeBallCamRotation(
  ballPos: Vec3State, pose: CameraPoseSnapshot, angleDeg: number,
  snapOrientation: boolean, dt: number, scratchVecA: Vec3State, scratchEulerA: EulerAnglesState
): void {
  const toBallX = ballPos.x - pose.focusX;
  const toBallY = ballPos.y - pose.focusY;
  const toBallZ = ballPos.z - pose.focusZ;
  const elevToBall = quantizeAngleRadiansToUrot16(Math.atan2(toBallY, Math.hypot(toBallX, toBallZ)));
  pose.focusY += Math.abs(elevToBall * UROT_PER_RAD) * 0.005;

  const lookBallX = ballPos.x - pose.focusX;
  const lookBallY = ballPos.y - pose.focusY;
  const lookBallZ = ballPos.z - pose.focusZ;
  scratchVecA.x = lookBallX; scratchVecA.y = lookBallY; scratchVecA.z = lookBallZ;

  let yawUnits = 16384.0;
  const horizBallDist = Math.hypot(lookBallX, lookBallZ);
  if (horizBallDist > 1e-9) {
    const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(lookBallZ, lookBallX)) * UROT_PER_RAD_F32)));
    yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
  }
  const ballYaw = yawUnits / UROT_PER_RAD;
  scratchEulerA.roll = 0.0; scratchEulerA.yaw = ballYaw;

  const rawBallPitch = quantizeAngleRadiansToUrot16(Math.atan2(lookBallY, horizBallDist));
  const baseAnglePitch = quantizeAngleRadiansToUrot16(angleDeg * DEG_TO_RAD);
  const highAngleFactor = Math.max(0.0, Math.min(1.0, (Math.abs(rawBallPitch * UROT_PER_RAD) - 4000.0) / 4000.0));
  const ballPitch = quantizeAngleRadiansToUrot16(
    (rawBallPitch - baseAnglePitch) * 0.8 * highAngleFactor + baseAnglePitch
  );
  scratchEulerA.pitch = ballPitch;

  if (snapOrientation) {
    pose.roll = scratchEulerA.roll; pose.yaw = scratchEulerA.yaw; pose.pitch = scratchEulerA.pitch;
  } else {
    const ballCamAlpha = 1.0 - Math.exp(dt * -8.59);
    pose.roll = wrapRadiansPi(pose.roll + wrapRadiansPi(0.0 - pose.roll) * ballCamAlpha);
    pose.yaw = wrapRadiansPi(pose.yaw + wrapRadiansPi(ballYaw - pose.yaw) * ballCamAlpha);
    pose.pitch = wrapRadiansPi(pose.pitch + wrapRadiansPi(ballPitch - pose.pitch) * ballCamAlpha);
  }
}

export function computeAirCarCamRotation(
  input: AirCarCamRotationInput, pose: CameraPoseSnapshot
): void {
  if (input.snapOrientation) {
    const fwdY = input.carForwardY;
    let yawUnits = 16384.0;
    const horizMag = Math.hypot(input.carForwardX, input.carForwardZ);
    if (horizMag > 1e-9) {
      const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(input.carForwardZ, input.carForwardX)) * UROT_PER_RAD_F32)));
      yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
    }
    const forwardYaw = yawUnits / UROT_PER_RAD;
    const forwardPitch = quantizeAngleRadiansToUrot16(Math.atan2(fwdY, horizMag));
    input.scratchEulerA.roll = 0.0; input.scratchEulerA.yaw = forwardYaw; input.scratchEulerA.pitch = forwardPitch;

    const velX = input.carVelX, velY = input.carVelY, velZ = input.carVelZ;
    const speedSq = velZ * velZ + velX * velX + velY * velY;
    let velYaw: number, velPitch: number, velRoll: number, velHorizMag: number;

    if (speedSq > 1e-8) {
      let vYawUnits = 16384.0;
      velHorizMag = Math.hypot(velX, velZ);
      if (velHorizMag > 1e-9) {
        const rawVUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(velZ, velX)) * UROT_PER_RAD_F32)));
        vYawUnits = extendInt16((1073741824 - (rawVUnits << 16)) >> 16);
      }
      velRoll = 0.0; velYaw = vYawUnits / UROT_PER_RAD;
      velPitch = quantizeAngleRadiansToUrot16(Math.atan2(velY, velHorizMag));
      input.scratchEulerB.roll = velRoll; input.scratchEulerB.yaw = velYaw; input.scratchEulerB.pitch = velPitch;
    } else {
      velRoll = input.scratchEulerA.roll; velYaw = input.scratchEulerA.yaw; velPitch = input.scratchEulerA.pitch;
      input.scratchEulerB.roll = velRoll; input.scratchEulerB.yaw = velYaw; input.scratchEulerB.pitch = velPitch;
      velHorizMag = Math.hypot(velX, velZ);
    }

    const speedBlend = Math.min(1.0, velHorizMag / 500.0);
    input.scratchEulerC.roll = wrapRadiansPi(wrapRadiansPi(velRoll) * speedBlend);
    const blendedYaw = wrapRadiansPi(wrapRadiansPi(velYaw - forwardYaw) * speedBlend + forwardYaw);
    input.scratchEulerC.yaw = blendedYaw;
    input.scratchEulerC.pitch = wrapRadiansPi(wrapRadiansPi(velPitch - forwardPitch) * speedBlend + forwardPitch);

    pose.yaw = blendedYaw; pose.roll = 0.0;
    pose.pitch = quantizeAngleRadiansToUrot16(input.angleDeg * DEG_TO_RAD);
    return;
  }

  const dirX = pose.focusX - pose.cameraPosX;
  const dirY = pose.focusY - pose.cameraPosY;
  const dirZ = pose.focusZ - pose.cameraPosZ;
  input.scratchVecA.x = dirX; input.scratchVecA.y = dirY; input.scratchVecA.z = dirZ;

  const vxF32 = Math.fround(input.carVelX), vyF32 = Math.fround(input.carVelY), vzF32 = Math.fround(input.carVelZ);
  const vxSqF32 = Math.fround(vxF32 * vxF32), vySqF32 = Math.fround(vyF32 * vyF32), vzSqF32 = Math.fround(vzF32 * vzF32);
  const speedRatio = Math.min(1.0, Math.fround(Math.fround(Math.sqrt(Math.fround(Math.fround(vxSqF32 + vySqF32) + vzSqF32))) / Math.fround(2300.0)));
  const stiffnessFactor = Math.fround(Math.fround(speedRatio * -25.0) + Math.fround(35.0));

  let yawUnits = 16384.0;
  const horizDist = Math.hypot(dirX, dirZ);
  if (horizDist > 1e-9) {
    const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(dirZ, dirX)) * UROT_PER_RAD_F32)));
    yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
  }
  const targetYaw = yawUnits / UROT_PER_RAD;
  const targetPitch = quantizeAngleRadiansToUrot16(Math.atan2(dirY, horizDist));
  input.scratchEulerA.roll = 0.0; input.scratchEulerA.yaw = targetYaw; input.scratchEulerA.pitch = targetPitch;

  const blendAlphaF32 = Math.fround(Math.min(1.0, stiffnessFactor / 60.0));
  pose.yaw = interpolateUrot16Angle(pose.yaw, targetYaw, blendAlphaF32);
  pose.pitch = interpolateUrot16Angle(pose.pitch, targetPitch, blendAlphaF32);
  pose.roll = interpolateUrot16Angle(pose.roll, 0.0, blendAlphaF32);

  const sinPitch = Math.fround(Math.sin(pose.pitch));
  const cosPitch = Math.fround(Math.cos(pose.pitch));
  const cosYaw = Math.fround(Math.cos(pose.yaw));
  const sinYaw = Math.fround(Math.sin(pose.yaw));

  const lookY = sinPitch, lookZ = Math.fround(cosPitch * cosYaw), lookX = Math.fround(cosPitch * sinYaw);
  input.scratchVecA.x = lookX; input.scratchVecA.y = lookY; input.scratchVecA.z = lookZ;

  const dotVel = input.carVelZ * lookZ + (input.carVelX * lookX + input.carVelY * lookY);
  if (dotVel < 0.0) {
    const horizSpeedRatio = Math.min(1.0, Math.fround(Math.fround(Math.sqrt(Math.fround(vxSqF32 + vzSqF32))) / Math.fround(2300.0)));
    const dampScaleF32 = Math.fround(1.0 - horizSpeedRatio);
    const pitchUrot = radiansToRoundedUrotInt(pose.pitch);
    const dampedUrot = extendInt16(saturateInt32(Math.trunc(Math.fround(dampScaleF32 * Math.fround(pitchUrot)))));
    pose.pitch = dampedUrot / UROT_PER_RAD;
  }
}

export function computeGroundCarCamRotation(
  input: GroundCarCamRotationInput, pose: CameraPoseSnapshot
): { smoothedNormalX: number; smoothedNormalY: number; smoothedNormalZ: number } {
  const blendAlpha = 1.0 - Math.exp(input.dt * -10.46);
  let nx = input.smoothedNormalX + (input.surfaceNormalX - input.smoothedNormalX) * blendAlpha;
  let ny = input.smoothedNormalY + (input.surfaceNormalY - input.smoothedNormalY) * blendAlpha;
  let nz = input.smoothedNormalZ + (input.surfaceNormalZ - input.smoothedNormalZ) * blendAlpha;
  const nLenSq = nz * nz + nx * nx + ny * ny;
  const invNLen = nLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(nLenSq);
  nx *= invNLen; ny *= invNLen; nz *= invNLen;

  const c1Z = nx * input.carForwardY - ny * input.carForwardX;
  const c1Y = nz * input.carForwardX - nx * input.carForwardZ;
  const c1X = ny * input.carForwardZ - nz * input.carForwardY;
  input.scratchTarget.x = c1X; input.scratchTarget.y = c1Y; input.scratchTarget.z = c1Z;

  const projZ = c1X * ny - c1Y * nx;
  const projY = c1Z * nx - c1X * nz;
  const projX = c1Y * nz - c1Z * ny;
  input.scratchProjected.x = projX; input.scratchProjected.y = projY; input.scratchProjected.z = projZ;

  const elevAngle = Math.atan2(projY, Math.hypot(projX, projZ));
  const slopeBlend = Math.min(1.0, Math.abs(elevAngle * UROT_PER_RAD) / 48000.0);

  let targetNormalX = nx, targetNormalY = ny, targetNormalZ = nz;
  if (elevAngle > 0.0) {
    targetNormalX = -nx; targetNormalY = -ny; targetNormalZ = -nz;
    input.scratchVecB.x = targetNormalX; input.scratchVecB.y = targetNormalY; input.scratchVecB.z = targetNormalZ;
  }

  const blendedDirZ = projZ + (targetNormalZ - projZ) * slopeBlend;
  const blendedDirY = projY + (targetNormalY - projY) * slopeBlend;
  const blendedDirX = projX + (targetNormalX - projX) * slopeBlend;
  input.scratchVecA.x = blendedDirX; input.scratchVecA.y = blendedDirY; input.scratchVecA.z = blendedDirZ;

  let yawUnits = 16384.0;
  const horizLen = Math.hypot(blendedDirX, blendedDirZ);
  if (horizLen > 1e-9) {
    const rawUnits = saturateInt32(Math.trunc(Math.fround(Math.fround(Math.atan2(blendedDirZ, blendedDirX)) * UROT_PER_RAD_F32)));
    yawUnits = extendInt16((1073741824 - (rawUnits << 16)) >> 16);
  }
  const baseYaw = yawUnits / UROT_PER_RAD;
  input.scratchEulerA.roll = 0.0; input.scratchEulerA.yaw = baseYaw;

  const basePitchRaw = quantizeAngleRadiansToUrot16(Math.atan2(blendedDirY, horizLen));
  const maxPitchRoom = HALF_PI - basePitchRaw;
  const settingPitchRad = quantizeAngleRadiansToUrot16(input.angleDeg * DEG_TO_RAD);
  const clampedOffsetPitch = settingPitchRad > maxPitchRoom ? maxPitchRoom : settingPitchRad;
  const basePitch = quantizeAngleRadiansToUrot16(basePitchRaw + clampedOffsetPitch);
  input.scratchEulerA.pitch = basePitch;

  if (input.snapOrientation) {
    pose.roll = input.scratchEulerA.roll; pose.yaw = input.scratchEulerA.yaw; pose.pitch = input.scratchEulerA.pitch;
    return { smoothedNormalX: nx, smoothedNormalY: ny, smoothedNormalZ: nz };
  }

  const stiffness = input.stiffness;
  const stiffnessScale = stiffness * 2.427 + 1.0;

  let fastYaw: number, fastPitch: number, fastRoll: number;
  if (stiffness < 1.0) {
    const fastAlphaF32 = Math.fround(1.0 - Math.exp(input.dt * (stiffnessScale * -13.39)));
    fastYaw = interpolateUrot16Angle(pose.yaw, baseYaw, fastAlphaF32);
    fastPitch = interpolateUrot16Angle(pose.pitch, basePitch, fastAlphaF32);
    fastRoll = interpolateUrot16Angle(pose.roll, 0.0, fastAlphaF32);
    input.scratchEulerB.yaw = fastYaw; input.scratchEulerB.pitch = fastPitch; input.scratchEulerB.roll = fastRoll;
  } else {
    fastRoll = input.scratchEulerA.roll; fastYaw = input.scratchEulerA.yaw; fastPitch = input.scratchEulerA.pitch;
    input.scratchEulerB.roll = fastRoll; input.scratchEulerB.yaw = fastYaw; input.scratchEulerB.pitch = fastPitch;
  }

  const slowAlphaF32 = Math.fround(1.0 - Math.exp(input.dt * (stiffnessScale * -2.03)));
  const slowYaw = interpolateUrot16Angle(pose.yaw, baseYaw, slowAlphaF32);
  const slowPitch = interpolateUrot16Angle(pose.pitch, basePitch, slowAlphaF32);
  const slowRoll = interpolateUrot16Angle(pose.roll, 0.0, slowAlphaF32);
  input.scratchEulerC.yaw = slowYaw; input.scratchEulerC.pitch = slowPitch; input.scratchEulerC.roll = slowRoll;

  const wallBlendF32 = Math.fround(1.0 - Math.abs(ny));
  pose.yaw = interpolateUrot16Angle(fastYaw, slowYaw, wallBlendF32);
  pose.pitch = interpolateUrot16Angle(fastPitch, slowPitch, wallBlendF32);
  pose.roll = interpolateUrot16Angle(fastRoll, slowRoll, wallBlendF32);
  return { smoothedNormalX: nx, smoothedNormalY: ny, smoothedNormalZ: nz };
}

export function stepSwivelOffsets(
  swivelYaw: number, swivelPitch: number, dt: number,
  lookXInput: number, lookYInput: number, swivelSpeedInput: number, invertSwivelInput: number
): { swivelYaw: number; swivelPitch: number } {
  if (dt <= 0.0) return { swivelYaw, swivelPitch };
  const dtF32 = Math.fround(dt);
  const safeSwivelSpeed = Number.isFinite(swivelSpeedInput) ? Math.max(1.0, Math.min(10.0, swivelSpeedInput)) : 4.0;
  const fastSwivelRate = safeSwivelSpeed * 3.0;

  const currPitchUrot = radiansToRoundedUrotInt(swivelPitch);
  const safeLookY = Number.isFinite(lookYInput) ? Math.max(-1.0, Math.min(1.0, lookYInput)) : 0.0;
  const signedLookY = invertSwivelInput !== 0.0 ? safeLookY : -safeLookY;
  const targetPitchUrot = saturateInt32(Math.trunc(Math.fround(Math.fround(signedLookY * 1.0471975511965976) * UROT_PER_RAD_F32)));
  const pitchRate = Math.abs(targetPitchUrot) < Math.abs(currPitchUrot) ? fastSwivelRate : safeSwivelSpeed;
  const pitchAlpha = Math.min(1.0, Math.fround(dtF32 * Math.fround(pitchRate)));
  const nextPitchUrot = saturateInt32(Math.fround(currPitchUrot + Math.fround((targetPitchUrot - currPitchUrot) * pitchAlpha)));
  const nextPitch = nextPitchUrot / UROT_PER_RAD;

  const currYawUrot = radiansToRoundedUrotInt(swivelYaw);
  const safeLookX = Number.isFinite(lookXInput) ? Math.max(-1.0, Math.min(1.0, lookXInput)) : 0.0;
  const targetYawUrot = saturateInt32(Math.trunc(Math.fround(Math.fround(safeLookX * -2.2689280275926285) * UROT_PER_RAD_F32)));
  const yawRate = Math.abs(targetYawUrot) < Math.abs(currYawUrot) ? fastSwivelRate : safeSwivelSpeed;
  const yawAlpha = Math.min(1.0, Math.fround(dtF32 * Math.fround(yawRate)));
  const nextYawUrot = saturateInt32(Math.fround(currYawUrot + Math.fround((targetYawUrot - currYawUrot) * yawAlpha)));
  return { swivelYaw: nextYawUrot / UROT_PER_RAD, swivelPitch: nextPitch };
}

export function extractCarBasisFromQuaternion(
  qx: number, qy: number, qz: number, qw: number
): { upX: number; upY: number; upZ: number; rightX: number; rightY: number; rightZ: number; fwdX: number; fwdY: number; fwdZ: number } {
  const rawUpX = 2.0 * (qx * qy - qw * qz), rawUpY = qw * qw - qx * qx + qy * qy - qz * qz, rawUpZ = 2.0 * (qy * qz + qw * qx);
  const upLenSq = rawUpZ * rawUpZ + rawUpX * rawUpX + rawUpY * rawUpY;
  const invUpLen = upLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(upLenSq);

  const rawRightX = 2.0 * (qx * qz + qw * qy), rawRightY = 2.0 * (qy * qz - qw * qx), rawRightZ = qw * qw - qx * qx - qy * qy + qz * qz;
  const rightLenSq = rawRightZ * rawRightZ + rawRightX * rawRightX + rawRightY * rawRightY;
  const invRightLen = rightLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(rightLenSq);

  const rawFwdX = qw * qw + qx * qx - qy * qy - qz * qz, rawFwdY = 2.0 * (qx * qy + qw * qz), rawFwdZ = 2.0 * (qx * qz - qw * qy);
  const fwdLenSq = rawFwdZ * rawFwdZ + rawFwdX * rawFwdX + rawFwdY * rawFwdY;
  const invFwdLen = fwdLenSq === 0.0 ? 1.0 : 1.0 / Math.sqrt(fwdLenSq);

  return {
    upX: rawUpX * invUpLen, upY: rawUpY * invUpLen, upZ: rawUpZ * invUpLen,
    rightX: rawRightX * invRightLen, rightY: rawRightY * invRightLen, rightZ: rawRightZ * invRightLen,
    fwdX: rawFwdX * invFwdLen, fwdY: rawFwdY * invFwdLen, fwdZ: rawFwdZ * invFwdLen,
  };
}

export function packCameraViewBufferOutput(
  v: Float64Array, blendedPose: CameraPoseSnapshot, aspectInput: number
): { camPosX: number; camPosY: number; camPosZ: number } {
  const sinFinalPitch = Math.fround(Math.sin(blendedPose.pitch)), cosFinalPitch = Math.fround(Math.cos(blendedPose.pitch));
  const dirY = sinFinalPitch;
  const dirZ = Math.fround(Math.fround(Math.cos(blendedPose.yaw)) * cosFinalPitch);
  const dirX = Math.fround(Math.fround(Math.sin(blendedPose.yaw)) * cosFinalPitch);

  const finalDistF32 = Math.fround(blendedPose.distance);
  const camPosZ = Math.fround(blendedPose.focusZ - Math.fround(dirZ * finalDistF32));
  const camPosX = Math.fround(blendedPose.focusX - Math.fround(dirX * finalDistF32));
  const rawCamY = Math.fround(blendedPose.focusY - Math.fround(sinFinalPitch * finalDistF32));
  const camPosY = rawCamY < 10.0 ? 10.0 : rawCamY;

  let outUpX = 0.0, outUpY = 1.0, outUpZ = 0.0;
  const rollAngle = blendedPose.roll;
  if (Math.abs(rollAngle) > 1e-8) {
    const cosRoll = Math.cos(rollAngle), sinRoll = Math.sin(rollAngle), oneMinusCos = 1.0 - cosRoll;
    outUpZ = dirY * dirZ * oneMinusCos + dirX * sinRoll;
    outUpY = dirY * dirY * oneMinusCos + cosRoll;
    outUpX = dirY * dirX * oneMinusCos - dirZ * sinRoll;
  }

  v[32] = camPosX; v[33] = camPosY; v[34] = camPosZ;
  v[35] = dirX; v[36] = dirY; v[37] = dirZ;
  v[38] = outUpX; v[39] = outUpY; v[40] = outUpZ;

  const halfFovRad = (blendedPose.fov * DEG_TO_RAD) * 0.5;
  const effectiveAspect = aspectInput < 1.0 ? 1.7777777777777777 : aspectInput;
  const vertHalfFov = Math.atan(Math.tan(halfFovRad) / effectiveAspect);
  v[41] = (vertHalfFov + vertHalfFov) * RAD_TO_DEG;

  return { camPosX, camPosY, camPosZ };
}
