/**
 * rlrcRigidBodyAttributePrimitives.ts
 * Pure attribute decoders, PRI/car slot lookup table, and geometric primitives for RLRC 30Hz
 * network stream rigid-body samples, quaternions, orthonormal basis matrices, and byte properties.
 */

import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCBasis3x3,
  type RLRCCarComponentActiveFlags,
  type RLRCNetStreamExtractorInput,
  type RLRCQuat,
  type RLRCRigidBodySample,
  type RLRCSynthesizedCarControls,
  type RLRCTeamIndex,
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

export interface RLRCDecodedBoostAttribute {
  readonly boostAmount: number;
  readonly grantCount: number | null;
}

export interface RLRCDecodedPickupAttribute {
  readonly instigatorCarActorId: number;
  readonly pickedUp: boolean;
}

export class RLRCNetStreamPriSlotTable {
  public readonly carPriById = new Map<number, number>();
  public readonly lastPriByCarId = new Map<number, number>();
  public readonly playerNameByPriId = new Map<number, string>();
  public readonly playerTeamByPriId = new Map<number, RLRCTeamIndex>();
  public readonly slotByPriId = new Map<number, number>();
  public readonly slotByPlayerName = new Map<string, number>();

  constructor(input: RLRCNetStreamExtractorInput) {
    for (const member of input.roster ?? []) {
      if (member.slotIndex >= 0 && member.slotIndex < RLRC_MAX_PLAYER_SLOTS) {
        this.slotByPlayerName.set(member.userName, member.slotIndex);
        if (member.priActorId >= 0) {
          this.slotByPriId.set(member.priActorId, member.slotIndex);
          this.playerNameByPriId.set(member.priActorId, member.userName);
          this.playerTeamByPriId.set(member.priActorId, member.team);
        }
      }
    }
    for (const [priId, slotIdx] of input.slotByPriActorId?.entries() ?? []) {
      if (slotIdx >= 0 && slotIdx < RLRC_MAX_PLAYER_SLOTS) this.slotByPriId.set(priId, slotIdx);
    }
  }

  public resolveSlotForPri(priId: number, nameHint?: string): number {
    const existingSlot = this.slotByPriId.get(priId);
    if (existingSlot !== undefined) return existingSlot;
    const playerName = nameHint ?? this.playerNameByPriId.get(priId);
    if (!playerName) return -1;
    const byNameSlot = this.slotByPlayerName.get(playerName);
    if (byNameSlot !== undefined) {
      this.slotByPriId.set(priId, byNameSlot);
      return byNameSlot;
    }
    if (this.slotByPlayerName.size >= RLRC_MAX_PLAYER_SLOTS) return -1;
    const nextSlot = this.slotByPlayerName.size;
    this.slotByPlayerName.set(playerName, nextSlot);
    this.slotByPriId.set(priId, nextSlot);
    return nextSlot;
  }

  public resolveSlotForCar(carActorId: number, slots: readonly { carId: number }[]): number {
    const priId = this.carPriById.get(carActorId);
    if (priId !== undefined && this.slotByPriId.has(priId)) return this.slotByPriId.get(priId)!;
    return slots.findIndex((s) => s.carId === carActorId);
  }

  public bindCarPriAndResolveSlot(carActorId: number, priId: number): number {
    this.carPriById.set(carActorId, priId);
    this.lastPriByCarId.set(carActorId, priId);
    return this.resolveSlotForPri(priId);
  }

  public applyPriProperty(
    prop: string,
    actorId: number,
    attr: unknown,
    attrRec: Record<string, unknown> | null,
    actorTypeById: ReadonlyMap<number, string>
  ): boolean {
    if (prop.endsWith(':PlayerName')) {
      const nameVal = attrRec?.String;
      if (typeof nameVal === 'string' && nameVal) {
        this.playerNameByPriId.set(actorId, nameVal);
        this.resolveSlotForPri(actorId, nameVal);
      }
      return true;
    }
    if (prop.endsWith('PlayerReplicationInfo:Team')) {
      const teamType = actorTypeById.get(extractActiveActorId(attr)) ?? '';
      if (teamType.includes('Team0')) this.playerTeamByPriId.set(actorId, 0);
      else if (teamType.includes('Team1')) this.playerTeamByPriId.set(actorId, 1);
      return true;
    }
    return false;
  }
}

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
  return { x: x / length, y: y / length, z: z / length, w: w / length };
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

export function decodeReplicatedBoostAttribute(raw: unknown): RLRCDecodedBoostAttribute | null {
  const o = asRecord(raw);
  const rp = asRecord(o?.ReplicatedBoost) ?? o;
  const b = typeof raw === 'number' ? raw : (rp?.boost_amount ?? rp?.boostAmount ?? o?.Byte);
  if (typeof b !== 'number' || !Number.isFinite(b)) return null;
  const boostAmount = (clampNumber(b, 0, 255) / 255) * 100;
  const g = rp?.grant_count ?? rp?.grantCount;
  return {
    boostAmount,
    grantCount: typeof g === 'number' && Number.isFinite(g) ? Math.trunc(g) : null,
  };
}

export function decodeReplicatedPickupAttribute(raw: unknown): RLRCDecodedPickupAttribute | null {
  const o = asRecord(raw);
  const pk =
    asRecord(o?.PickupNew ?? o?.Pickup ?? o?.NewReplicatedPickupData ?? o?.ReplicatedPickupData) ??
    o;
  if (!pk) return null;
  const pRaw = pk.pickedUp ?? pk.picked_up;
  let pickedUp = false;
  if (typeof pRaw === 'boolean') pickedUp = pRaw;
  else if (typeof pRaw === 'number' && Number.isFinite(pRaw))
    pickedUp = (pRaw & 0xff) !== 0 && (pRaw & 0xff) !== 255;
  else return null;

  let instId = -1;
  const ir = pk.instigator ?? pk.instigator_id ?? pk.instigatorId;
  const io = asRecord(ir);
  if (typeof ir === 'number' && Number.isFinite(ir)) instId = Math.trunc(ir);
  else if (io && io.active !== false && typeof io.actor === 'number') instId = Math.trunc(io.actor);
  return { instigatorCarActorId: instId, pickedUp };
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
