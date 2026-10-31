/**
 * src/replay/container/RCReplayBinarySchema.js
 * Native V2 Multi-Track Binary Container constants, header validation,
 * and 64-byte control/incident/signal slot packing and unpacking.
 */

import {
  STATE_BUFFER_FLOATS,
  MAX_CARS,
  INCIDENT_EVENT_TYPES,
  PHYSICS_EVENT_FLAGS,
  SURFACE_SUBTYPES,
  FLIP_RESET_SUBTYPES,
  FLIP_RESET_SUBTYPE_LABELS,
  getFlipResetObjectCode,
  getFlipResetObjectName,
} from '../../physics/RocketSimConstants.js';
import { classifyBallHitSurface } from '../../physics/RocketSimStateViews.js';

export const RC_REPLAY_MAGIC_V2 = 'RCREPLAY';
export const RC_REPLAY_VERSION_V2 = 2;
export const RC_REPLAY_STATE_BYTES = STATE_BUFFER_FLOATS * 4; // 1792 bytes
export const RC_REPLAY_CONTROLS_BYTES = 64; // 64 bytes (8 cars)
export const RC_REPLAY_STATE_INPUT_STRIDE = RC_REPLAY_STATE_BYTES + RC_REPLAY_CONTROLS_BYTES; // 1856 bytes
export const RC_REPLAY_EVENT_STRIDE = 64; // 16 words * 4 bytes

export const MAGIC_BYTES = new Uint8Array([0x52, 0x43, 0x52, 0x45, 0x50, 0x4c, 0x41, 0x59]); // "RCREPLAY"

/**
 * Checks whether a decompressed Uint8Array / ArrayBuffer begins with the V2 "RCREPLAY" magic header.
 */
export function isBinaryRCReplayContainer(bytesOrBuffer) {
  const u8 =
    bytesOrBuffer instanceof Uint8Array
      ? bytesOrBuffer
      : bytesOrBuffer instanceof ArrayBuffer
      ? new Uint8Array(bytesOrBuffer)
      : null;
  if (!u8 || u8.byteLength < 16) return false;
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

/**
 * Packs a single car's controls into 3-byte bitpack + 5-byte signed analog bytes.
 */
export function packCarControlsToTrack64(out64, carIndex, ctrl) {
  if (!ctrl || carIndex < 0 || carIndex >= MAX_CARS) return;
  const thr = Math.max(-31, Math.min(31, Math.round((ctrl.throttle || 0) * 31))) + 31;
  const str = Math.max(-31, Math.min(31, Math.round((ctrl.steer || 0) * 31))) + 31;
  const pit = Math.max(-3, Math.min(3, Math.round((ctrl.pitch || 0) * 3))) + 3;
  const yaw = Math.max(-3, Math.min(3, Math.round((ctrl.yaw || 0) * 3))) + 3;
  const rol = Math.max(-3, Math.min(3, Math.round((ctrl.roll || 0) * 3))) + 3;
  const jmp = ctrl.jump ? 1 : 0;
  const bst = ctrl.boost ? 1 : 0;
  const hnd = ctrl.handbrake ? 1 : 0;

  out64[carIndex * 3 + 0] = (thr & 0x3f) | ((str & 0x30) << 2);
  out64[carIndex * 3 + 1] = (str & 0x0f) | ((pit & 0x07) << 4) | ((yaw & 0x04) << 5);
  out64[carIndex * 3 + 2] = (yaw & 0x03) | ((rol & 0x07) << 2) | (jmp << 5) | (bst << 6) | (hnd << 7);

  const qOff = 24 + carIndex * 5;
  out64[qOff + 0] = Math.max(-127, Math.min(127, Math.round(Math.max(-1, Math.min(1, ctrl.throttle || 0)) * 127))) & 0xff;
  out64[qOff + 1] = Math.max(-127, Math.min(127, Math.round(Math.max(-1, Math.min(1, ctrl.steer || 0)) * 127))) & 0xff;
  out64[qOff + 2] = Math.max(-127, Math.min(127, Math.round(Math.max(-1, Math.min(1, ctrl.pitch || 0)) * 127))) & 0xff;
  out64[qOff + 3] = Math.max(-127, Math.min(127, Math.round(Math.max(-1, Math.min(1, ctrl.yaw || 0)) * 127))) & 0xff;
  out64[qOff + 4] = Math.max(-127, Math.min(127, Math.round(Math.max(-1, Math.min(1, ctrl.roll || 0)) * 127))) & 0xff;
}

/**
 * Unpacks 8 cars' controls from a 64-byte control block.
 */
export function unpackTrack64ToCarControls(bytes64) {
  const result = new Array(MAX_CARS);
  if (!bytes64 || bytes64.byteLength < 24) {
    for (let c = 0; c < MAX_CARS; c++) {
      result[c] = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
    }
    return result;
  }
  const hasQuantized = bytes64.byteLength >= 64;
  const i8 = hasQuantized ? new Int8Array(bytes64.buffer, bytes64.byteOffset, bytes64.byteLength) : null;

  for (let c = 0; c < MAX_CARS; c++) {
    const b0 = bytes64[c * 3 + 0];
    const b1 = bytes64[c * 3 + 1];
    const b2 = bytes64[c * 3 + 2];
    if (b0 === 0 && b1 === 0 && b2 === 0 && (!i8 || (i8[24 + c * 5] === 0 && i8[24 + c * 5 + 1] === 0))) {
      result[c] = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
      continue;
    }
    const jump = Boolean(b2 & (1 << 5));
    const boost = Boolean(b2 & (1 << 6));
    const handbrake = Boolean(b2 & (1 << 7));

    let throttle = ((b0 & 0x3f) - 31) / 31.0;
    let steer = ((((b0 >> 2) & 0x30) | (b1 & 0x0f)) - 31) / 31.0;
    let pitch = (((b1 >> 4) & 0x07) - 3) / 3.0;
    let yaw = ((((b1 >> 5) & 0x04) | (b2 & 0x03)) - 3) / 3.0;
    let roll = (((b2 >> 2) & 0x07) - 3) / 3.0;

    if (i8) {
      const qOff = 24 + c * 5;
      if (i8[qOff] !== 0 || i8[qOff + 1] !== 0 || i8[qOff + 2] !== 0 || i8[qOff + 3] !== 0 || i8[qOff + 4] !== 0) {
        throttle = i8[qOff + 0] / 127.0;
        steer = i8[qOff + 1] / 127.0;
        pitch = i8[qOff + 2] / 127.0;
        yaw = i8[qOff + 3] / 127.0;
        roll = i8[qOff + 4] / 127.0;
      }
    }

    result[c] = { throttle, steer, pitch, yaw, roll, jump, boost, handbrake };
  }
  return result;
}

/**
 * Encodes a JS incident object into a 64-byte PhysicsEvent slot (16 words).
 */
export function encodeIncidentTo64Bytes(inc, targetU8, byteOffset = 0, fallbackFrameIndex = 0) {
  const u32 = new Uint32Array(targetU8.buffer, targetU8.byteOffset + byteOffset, 16);
  const f32 = new Float32Array(targetU8.buffer, targetU8.byteOffset + byteOffset, 16);
  u32.fill(0);

  if (!inc) return;
  const type = Number(inc.type ?? 0) & 0xff;
  u32[0] = type;
  u32[1] = (inc.tick ?? fallbackFrameIndex) >>> 0;
  f32[2] = Number(inc.x ?? inc.posX ?? inc.carPosX ?? 0);
  f32[3] = Number(inc.y ?? inc.posY ?? inc.carPosY ?? 0);
  f32[4] = Number(inc.z ?? inc.posZ ?? inc.carPosZ ?? 0);
  f32[5] = Number(inc.normalX ?? inc.normX ?? inc.ballPosX ?? 0);
  f32[6] = Number(inc.normalY ?? inc.normY ?? inc.ballPosY ?? 0);
  f32[7] = Number(inc.normalZ ?? inc.normZ ?? inc.ballPosZ ?? 0);
  f32[8] = Number(inc.normalRelVel ?? inc.relSpeed ?? 0);
  f32[9] = Number(inc.speed ?? inc.relSpeed ?? inc.intensity ?? 0);
  f32[10] = Number(inc.impulse ?? inc.intensity ?? 0);

  const primaryId = Number(inc.primaryId ?? inc.carIndex ?? inc.car1Index ?? 0) & 0xffff;
  const secondaryId = Number(inc.secondaryId ?? inc.padIndex ?? inc.car2Index ?? inc.team ?? 0) & 0xffff;
  u32[11] = (primaryId | (secondaryId << 16)) >>> 0;
  u32[12] = Number(inc.subType ?? inc.surfaceTag ?? inc.actionSubType ?? (inc.isBig ? 1 : 0)) >>> 0;

  let flags = Number(inc.flags ?? 0) >>> 0;
  if (inc.isInitialTouch) flags |= PHYSICS_EVENT_FLAGS.INITIAL_TOUCH;
  if (inc.isSupersonic) flags |= PHYSICS_EVENT_FLAGS.SUPERSONIC;
  if (inc.isFlipping) flags |= PHYSICS_EVENT_FLAGS.FLIP;
  if (inc.isOnGround) flags |= PHYSICS_EVENT_FLAGS.ON_GROUND;
  u32[13] = flags >>> 0;

  f32[14] = Number(inc.customFloat ?? inc.directionDotNormal ?? 0);
  u32[15] = Number(inc.frameIndex ?? inc.customInt ?? fallbackFrameIndex) >>> 0;
}

/**
 * Decodes a 64-byte PhysicsEvent slot into a rich JS incident object.
 */
export function decodeIncidentFrom64Bytes(sourceU8, byteOffset = 0) {
  const u32 = new Uint32Array(sourceU8.buffer, sourceU8.byteOffset + byteOffset, 16);
  const f32 = new Float32Array(sourceU8.buffer, sourceU8.byteOffset + byteOffset, 16);

  let type = u32[0];
  const tick = u32[1];
  const x = f32[2];
  const y = f32[3];
  const z = f32[4];
  const normalX = f32[5];
  const normalY = f32[6];
  const normalZ = f32[7];
  const normalRelVel = f32[8];
  const speed = f32[9];
  const impulse = f32[10];
  const ids = u32[11];
  const primaryId = ids & 0xffff;
  const secondaryId = (ids >>> 16) & 0xffff;
  let subType = u32[12];
  const flags = u32[13];
  const customFloat = f32[14];
  const customInt = u32[15];

  const carIndex = primaryId === 65535 ? 0 : primaryId;
  let car1Index = carIndex;
  let car2Index = secondaryId;
  let team = secondaryId;
  if (type === INCIDENT_EVENT_TYPES.CAR_CAR_BUMP || type === INCIDENT_EVENT_TYPES.CAR_CAR_DEMO) {
    car2Index = secondaryId === 65535 ? 0 : secondaryId;
    team = 0;
  }

  if (type === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT || type === INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT) {
    if (subType === 0) {
      subType = classifyBallHitSurface(
        x, y, z, normalX, normalY, normalZ,
        type === INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT
      );
    }
    if (subType === SURFACE_SUBTYPES.CROSSBAR || subType === SURFACE_SUBTYPES.GOALPOST) {
      type = INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT;
    }
  }

  const directionDotNormal =
    customFloat > 0 && customFloat <= 1.0
      ? customFloat
      : speed > 1e-4
      ? Math.max(0, Math.min(1, normalRelVel / speed))
      : 0;

  const ev = {
    type,
    tick,
    frameIndex: customInt,
    x,
    y,
    z,
    posX: x,
    posY: y,
    posZ: z,
    normalX,
    normalY,
    normalZ,
    normalRelVel,
    speed,
    relSpeed: speed,
    impulse,
    intensity: impulse || speed,
    primaryId,
    secondaryId,
    carIndex,
    car1Index,
    car2Index,
    team,
    subType,
    surfaceTag: subType,
    actionSubType: subType,
    isCrossbar:
      (type === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT || type === INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT) &&
      subType === SURFACE_SUBTYPES.CROSSBAR,
    padIndex: secondaryId,
    isBig: type === INCIDENT_EVENT_TYPES.BOOST_PICKUP && (subType === 1 || secondaryId < 6),
    flags,
    customFloat,
    customInt,
    directionDotNormal,
    dirDot: directionDotNormal,
    impactAngleDeg: Math.asin(Math.max(0, Math.min(1, directionDotNormal))) * (180 / Math.PI),
    isInitialTouch: (flags & PHYSICS_EVENT_FLAGS.INITIAL_TOUCH) !== 0,
    isSupersonic: (flags & PHYSICS_EVENT_FLAGS.SUPERSONIC) !== 0,
    isFlipping: (flags & PHYSICS_EVENT_FLAGS.FLIP) !== 0,
    isOnGround: (flags & PHYSICS_EVENT_FLAGS.ON_GROUND) !== 0,
    isDemo: type === INCIDENT_EVENT_TYPES.CAR_CAR_DEMO,
    resetSubType: 0,
    resetSubTypeName: 'none',
    resetObjectCode: 0,
    resetObjectType: 'none',
    resetTargetCarIndex: -1,
    resetSurfaceTag: 0,
    resetWheelCount: 0,
    isBallFlipReset: false,
  };

  if (type === INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED) {
    ev.carPosX = x;
    ev.carPosY = y;
    ev.carPosZ = z;
    ev.ballPosX = normalX;
    ev.ballPosY = normalY;
    ev.ballPosZ = normalZ;
    ev.carPos = { x, y, z };
    ev.ballPos = { x: normalX, y: normalY, z: normalZ };
    ev.resetSubType = subType;
    ev.resetSubTypeName = FLIP_RESET_SUBTYPE_LABELS[subType] || 'none';
    ev.resetObjectCode = getFlipResetObjectCode(subType, flags);
    ev.resetObjectType = getFlipResetObjectName(subType, flags);
    const targetCar = (flags >>> 8) & 0xff;
    ev.resetTargetCarIndex = targetCar === 0xff ? -1 : targetCar;
    ev.resetSurfaceTag = (flags >>> 16) & 0xff;
    ev.resetWheelCount = Math.round(customFloat) || 4;
    ev.isBallFlipReset = subType === FLIP_RESET_SUBTYPES.BALL;
  }
  return ev;
}

/**
 * Encodes a JS signal object into a 64-byte PhysicsEvent slot (16 words).
 */
export function encodeSignalTo64Bytes(sig, targetU8, byteOffset = 0, fallbackFrameIndex = 0) {
  const u32 = new Uint32Array(targetU8.buffer, targetU8.byteOffset + byteOffset, 16);
  const f32 = new Float32Array(targetU8.buffer, targetU8.byteOffset + byteOffset, 16);
  u32.fill(0);

  if (!sig) return;
  const signalType = Number(sig.signalType ?? sig.type ?? 0) & 0xff;
  const frameId = Number(sig.frameId ?? sig.tick ?? fallbackFrameIndex) >>> 0;
  const param1 = Number(sig.param1 ?? 0) >>> 0;
  const param2 = Number(sig.param2 ?? sig.subType ?? 0) >>> 0;
  const signalId = Number(sig.signalId ?? sig.flags ?? 0) >>> 0;
  const frameIndex = Number(sig.frameIndex ?? sig.customInt ?? fallbackFrameIndex) >>> 0;

  u32[0] = signalType;
  u32[1] = frameId;
  f32[2] = Number(sig.param1 ?? 0);
  f32[3] = Number(sig.param2 ?? 0);
  u32[11] = param1;
  u32[12] = param2;
  u32[13] = signalId;
  u32[15] = frameIndex;
}

/**
 * Decodes a 64-byte PhysicsEvent slot into a JS signal object.
 */
export function decodeSignalFrom64Bytes(sourceU8, byteOffset = 0) {
  const u32 = new Uint32Array(sourceU8.buffer, sourceU8.byteOffset + byteOffset, 16);
  const signalType = u32[0];
  const frameId = u32[1];
  const param1 = u32[11];
  const param2 = u32[12];
  const signalId = u32[13];
  const frameIndex = u32[15];

  return {
    signalId,
    signalType,
    type: signalType,
    frameId,
    tick: frameId,
    param1,
    param2,
    frameIndex,
  };
}

export function unpackControls64ToCars(bytes64, byteOffset = 0) {
  if (!bytes64) return unpackTrack64ToCarControls(null);
  const slice =
    byteOffset > 0
      ? bytes64.subarray(byteOffset, byteOffset + RC_REPLAY_CONTROLS_BYTES)
      : bytes64;
  return unpackTrack64ToCarControls(slice);
}

export function unpackIncidentTrackToEvents(incidentTrackBytes) {
  if (!incidentTrackBytes || incidentTrackBytes.byteLength < RC_REPLAY_EVENT_STRIDE) return [];
  const count = Math.floor(incidentTrackBytes.byteLength / RC_REPLAY_EVENT_STRIDE);
  const result = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = decodeIncidentFrom64Bytes(incidentTrackBytes, i * RC_REPLAY_EVENT_STRIDE);
  }
  return result;
}

export function unpackSignalTrackToEvents(signalTrackBytes) {
  if (!signalTrackBytes || signalTrackBytes.byteLength < RC_REPLAY_EVENT_STRIDE) return [];
  const count = Math.floor(signalTrackBytes.byteLength / RC_REPLAY_EVENT_STRIDE);
  const result = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = decodeSignalFrom64Bytes(signalTrackBytes, i * RC_REPLAY_EVENT_STRIDE);
  }
  return result;
}
