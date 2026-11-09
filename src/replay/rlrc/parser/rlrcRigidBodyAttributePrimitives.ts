/**
 * rlrcRigidBodyAttributePrimitives.ts
 * Pure attribute decoders and geometric primitives for RLRC 30Hz network stream
 * rigid-body samples, quaternions, orthonormal basis matrices, and replicated byte properties.
 */

import {
  type RLRCBasis3x3,
  type RLRCCarComponentActiveFlags,
  type RLRCQuat,
  type RLRCRigidBodySample,
  type RLRCSynthesizedCarControls,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export const RLRC_DEFAULT_SPAWN_BOOST = 33.333;
export const RLRC_DEFAULT_BALL_REST_Z = 93.15;
export const RLRC_SUPERSONIC_SPEED_UU_S = 2200;
export const RLRC_FLIP_EXPIRATION_SECONDS = 1.25;

export const ZERO_VEC3: RLRCVec3 = { x: 0, y: 0, z: 0 };
export const IDENTITY_QUAT: RLRCQuat = { x: 0, y: 0, z: 0, w: 1 };

export const DEFAULT_CAR_RB: RLRCRigidBodySample = {
  sleeping: true,
  position: ZERO_VEC3,
  rotation: IDENTITY_QUAT,
  linearVelocity: ZERO_VEC3,
  angularVelocity: ZERO_VEC3,
  rbUpdated: false,
};

export const DEFAULT_BALL_RB: RLRCRigidBodySample = {
  ...DEFAULT_CAR_RB,
  position: { x: 0, y: 0, z: RLRC_DEFAULT_BALL_REST_Z },
};

export const DEFAULT_ACTIVE_FLAGS: RLRCCarComponentActiveFlags = {
  boostActive: false,
  jumpActive: false,
  doubleJumpActive: false,
  dodgeActive: false,
};

export const NEUTRAL_CONTROLS: RLRCSynthesizedCarControls = {
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
};

export function toFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function clampNumber(value: number, minVal: number, maxVal: number): number {
  return Math.max(minVal, Math.min(maxVal, value));
}

export function extractVec3(raw: unknown, fallback: RLRCVec3 = ZERO_VEC3): RLRCVec3 {
  const record = asRecord(raw);
  if (!record) return fallback;
  return {
    x: toFiniteNumber(record.x ?? record.X, fallback.x),
    y: toFiniteNumber(record.y ?? record.Y, fallback.y),
    z: toFiniteNumber(record.z ?? record.Z, fallback.z),
  };
}

export function normalizeQuat(raw: unknown): RLRCQuat {
  const record = asRecord(raw);
  if (!record) return IDENTITY_QUAT;
  const x = toFiniteNumber(record.x ?? record.X);
  const y = toFiniteNumber(record.y ?? record.Y);
  const z = toFiniteNumber(record.z ?? record.Z);
  const w = toFiniteNumber(record.w ?? record.W, 1);
  const length = Math.hypot(x, y, z, w);
  if (length < 1e-6) return IDENTITY_QUAT;
  return {
    x: x / length,
    y: y / length,
    z: z / length,
    w: w / length,
  };
}

export function quatToBasis3x3({ x, y, z, w }: RLRCQuat): RLRCBasis3x3 {
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return {
    fwd: { x: 1 - 2 * (yy + zz), y: 2 * (xy + wz), z: 2 * (xz - wy) },
    right: { x: 2 * (xy - wz), y: 1 - 2 * (xx + zz), z: 2 * (yz + wx) },
    up: { x: 2 * (xz + wy), y: 2 * (yz - wx), z: 1 - 2 * (xx + yy) },
  };
}

export function extractRigidBodySample(raw: unknown): RLRCRigidBodySample | null {
  const outer = asRecord(raw);
  const rigidBody = asRecord(outer?.RigidBody) ?? outer;
  const location = rigidBody?.location ?? rigidBody?.position ?? rigidBody?.pos;
  if (!rigidBody || !location) return null;

  const sleeping = Boolean(rigidBody.sleeping ?? rigidBody.bSleeping);
  const linearVelRaw = rigidBody.linear_velocity ?? rigidBody.linearVelocity;
  const angularVelRaw = rigidBody.angular_velocity ?? rigidBody.angularVelocity;

  return {
    sleeping,
    position: extractVec3(location),
    rotation: normalizeQuat(rigidBody.rotation ?? rigidBody.quat),
    linearVelocity: sleeping || !linearVelRaw ? ZERO_VEC3 : extractVec3(linearVelRaw),
    angularVelocity: sleeping || !angularVelRaw ? ZERO_VEC3 : extractVec3(angularVelRaw),
  };
}

export function normalizeReplicatedBoostAmount(raw: unknown): number | null {
  const outer = asRecord(raw);
  const boostObj = asRecord(outer?.ReplicatedBoost) ?? outer;
  const byteVal =
    typeof raw === 'number'
      ? raw
      : (boostObj?.boost_amount ?? boostObj?.boostAmount ?? outer?.Byte);
  if (typeof byteVal !== 'number' || !Number.isFinite(byteVal)) return null;
  return (clampNumber(byteVal, 0, 255) / 255) * 100;
}

export function decodeReplicatedAxisByte(raw: unknown): number | null {
  const byteVal = typeof raw === 'number' ? raw : toFiniteNumber(asRecord(raw)?.Byte, Number.NaN);
  if (!Number.isFinite(byteVal)) return null;
  if (byteVal === 128) return 0;
  return clampNumber((clampNumber(byteVal, 0, 255) - 128) / 127, -1, 1);
}

export function isComponentActiveByte(raw: unknown): boolean | null {
  const byteVal = typeof raw === 'number' ? raw : toFiniteNumber(asRecord(raw)?.Byte, Number.NaN);
  if (!Number.isFinite(byteVal)) return null;
  return (Math.trunc(byteVal) & 1) === 1;
}

export function extractActiveActorId(raw: unknown): number {
  const outer = asRecord(raw);
  const activeActor = asRecord(outer?.ActiveActor) ?? outer;
  if (!activeActor || activeActor.active === false) return -1;
  return Math.trunc(toFiniteNumber(activeActor.actor, -1));
}

export function createSpawnBallRigidBody(initialLocation?: RLRCVec3): RLRCRigidBodySample {
  const isDefaultCenter =
    !initialLocation ||
    (Math.abs(initialLocation.x) < 2 &&
      Math.abs(initialLocation.y) < 2 &&
      Math.abs(initialLocation.z - 93) < 2.5);
  return {
    ...DEFAULT_BALL_RB,
    position: isDefaultCenter
      ? DEFAULT_BALL_RB.position
      : {
          x: initialLocation.x,
          y: initialLocation.y,
          z: initialLocation.z > 0 ? initialLocation.z : RLRC_DEFAULT_BALL_REST_Z,
        },
    rbUpdated: true,
  };
}
