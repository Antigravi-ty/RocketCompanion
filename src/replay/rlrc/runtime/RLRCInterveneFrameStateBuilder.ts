/**
 * RLRCInterveneFrameStateBuilder.ts
 * Pure helper functions for RLRC intervention POV loadout and frame state packing:
 * - User garage vehicle loadout resolution (hitboxId, visualId, team color hex)
 * - Hitbox resting Z ground-penetration protection and quaternion basis axes extraction
 * - 448-float GameStateBuffer packing for 120Hz RLRC replay frames
 */

import {
  SIM_OFFSETS,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  BALL_STATE_OFFSETS,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_OFFSETS,
  EXTENDED_STATE_OFFSETS,
  GAME_STATE_BUFFER_FLOATS,
} from '../../../physics/RocketSimConstants.ts';
import type {
  ReplayAcknowledgedControlEntry,
  ReplayRecordedIncident,
} from '../../ReplayRingBuffer.ts';
import { STORAGE_KEYS, safeStorage } from '../../../ui-core/config/storageHelpers.ts';
import {
  getCarColorSlotById,
  normalizeVisualId,
  resolveVehicleHitboxId,
} from '../../../ui-core/config/vehicleConstants.ts';
import {
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_BOOST_PAD_COUNT,
  type RLRCFrame120Hz,
  type RLRCHitboxId,
  type RLRCQuat,
  type RLRCSynthesizedCarControls,
  type RLRCTeamIndex,
  type RLRCVec3,
  type RLRCVisualId,
} from '../RLRCReplayTypes.ts';

export const RLRC_HITBOX_RESTING_Z: Readonly<Record<RLRCHitboxId, number>> = Object.freeze({
  'hitbox-octane': 17.01,
  'hitbox-hybrid': 17.01,
  'hitbox-psyclops': 17.01,
  'hitbox-dominus': 17.06,
  'hitbox-breakout': 18.34,
  'hitbox-plank': 18.65,
  'hitbox-merc': 18.79,
});

export const DEFAULT_NEUTRAL_CAR_CONTROLS: RLRCSynthesizedCarControls = Object.freeze({
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
});

export interface RLRCUserInterveneLoadout {
  readonly hitboxId: RLRCHitboxId;
  readonly visualId: RLRCVisualId;
  readonly colorHex: string;
  readonly colorSlotId: number;
}

export interface RLRCPovFrameOverride {
  readonly povSlotIndex: number;
  readonly playerHitboxId: RLRCHitboxId;
}

export interface RLRCPrerollRingBufferPort {
  clear?: () => void;
  recordFrame?: (
    tick: number,
    stateSnapshot: Float32Array,
    options?: {
      acknowledgedControls?: ReadonlyArray<
        ReplayAcknowledgedControlEntry | null | undefined
      > | null;
    }
  ) => { snapshot?: Float32Array | null } | null;
  appendIncident?: (tick: number, incident: ReplayRecordedIncident) => boolean | void;
}

export interface RLRCGoalAndTouchTrackerPort {
  goalIncidentTick?: number;
  goalResetTicks?: number;
  frozenGoalBallState?: unknown;
  prevBallVelX?: number;
  prevBallVelY?: number;
  prevBallVelZ?: number;
  lastKickoffStartTick?: number;
  lastTouchTick?: number;
}

export function getHitboxRestingZ(hitboxId: RLRCHitboxId | string | null | undefined): number {
  const key = (hitboxId || 'hitbox-octane') as RLRCHitboxId;
  return RLRC_HITBOX_RESTING_Z[key] ?? 17.01;
}

function readStoredGaragePreset(): string {
  try {
    const raw = safeStorage.get(STORAGE_KEYS.DISPLAY_SETTINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as { vehiclePreset?: string; carVisual?: string };
      return parsed?.vehiclePreset || parsed?.carVisual || 'fennec';
    }
  } catch {
    // Fallback to default preset when storage is unavailable
  }
  return 'fennec';
}

function readStoredColorSlot(assignedTeam: RLRCTeamIndex): number {
  const fallback = assignedTeam === 0 ? 3 : 2;
  try {
    const raw = safeStorage.get(STORAGE_KEYS.COLOR_PREFS);
    if (raw) {
      const parsed = JSON.parse(raw) as { blueOrder?: number[]; orangeOrder?: number[] };
      const slot = assignedTeam === 0 ? parsed?.blueOrder?.[0] : parsed?.orangeOrder?.[0];
      if (typeof slot === 'number' && slot >= 0 && slot <= 5) return slot;
    }
  } catch {
    // Fallback to default team slot when storage is unavailable
  }
  return fallback;
}

export function resolveCurrentUserInterveneLoadout(
  assignedTeam: RLRCTeamIndex = 0,
  overrides?: Partial<RLRCUserInterveneLoadout>
): RLRCUserInterveneLoadout {
  const rawVisual = overrides?.visualId || readStoredGaragePreset();
  const visualId = normalizeVisualId(rawVisual) as RLRCVisualId;
  const hitboxId = (overrides?.hitboxId || resolveVehicleHitboxId(visualId)) as RLRCHitboxId;
  const colorSlotId = overrides?.colorSlotId ?? readStoredColorSlot(assignedTeam);
  const colorHex = overrides?.colorHex || getCarColorSlotById(colorSlotId).hex;
  return { hitboxId, visualId, colorHex, colorSlotId };
}

export function clampCarPositionZForHitbox(
  pos: RLRCVec3,
  isOnGround: boolean,
  hitboxId: RLRCHitboxId
): RLRCVec3 {
  const restZ = getHitboxRestingZ(hitboxId);
  if ((isOnGround || pos.z < restZ + 2.5) && pos.z < restZ) {
    return { x: pos.x, y: pos.y, z: restZ };
  }
  return pos;
}

export function quatToBasisAxes(q: RLRCQuat): {
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
} {
  const { x, y, z, w } = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return {
    fwd: [1 - (yy + zz), xy + wz, xz - wy],
    right: [xy - wz, 1 - (xx + zz), yz + wx],
    up: [xz + wy, yz - wx, 1 - (xx + yy)],
  };
}

function writeKinematicsBlock(
  buf: Float32Array,
  base: number,
  pos: RLRCVec3,
  rot: RLRCQuat,
  vel: RLRCVec3,
  angVel: RLRCVec3
): void {
  const axes = quatToBasisAxes(rot);
  buf[base] = pos.x;
  buf[base + 1] = pos.y;
  buf[base + 2] = pos.z;
  buf.set(axes.fwd, base + 3);
  buf.set(axes.right, base + 6);
  buf.set(axes.up, base + 9);
  buf[base + 12] = vel.x;
  buf[base + 13] = vel.y;
  buf[base + 14] = vel.z;
  buf[base + 15] = angVel.x;
  buf[base + 16] = angVel.y;
  buf[base + 17] = angVel.z;
}

export function packRLRCFrameToGameStateBuffer(
  frame: RLRCFrame120Hz,
  tick: number,
  outBuffer?: Float32Array,
  povOverride?: RLRCPovFrameOverride
): Float32Array {
  const buf =
    outBuffer && outBuffer.length >= GAME_STATE_BUFFER_FLOATS
      ? outBuffer
      : new Float32Array(GAME_STATE_BUFFER_FLOATS);
  buf.fill(0);
  buf[SIM_OFFSETS.TICK] = tick;
  buf[SIM_OFFSETS.NUM_CARS] = RLRC_MAX_PLAYER_SLOTS;
  buf[SIM_OFFSETS.NUM_PADS] = RLRC_BOOST_PAD_COUNT;

  const bRb = frame.ball.rigidBody;
  writeKinematicsBlock(
    buf,
    SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS,
    bRb.position,
    bRb.rotation,
    bRb.linearVelocity,
    bRb.angularVelocity
  );

  for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
    const car = frame.cars[slot];
    const cBase = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
    const extBase =
      EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_BASE + slot * EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_STRIDE;

    if (!car || !car.entityActive) {
      buf[cBase + CAR_STATE_OFFSETS.POS + 2] = -5000;
      buf[cBase + CAR_STATE_OFFSETS.FWD] = 1;
      buf[cBase + CAR_STATE_OFFSETS.RIGHT + 1] = 1;
      buf[cBase + CAR_STATE_OFFSETS.UP + 2] = 1;
      buf[cBase + CAR_STATE_OFFSETS.DEMOED] = 1;
      continue;
    }

    const rb = car.rigidBody;
    const pos =
      povOverride && povOverride.povSlotIndex === slot
        ? clampCarPositionZForHitbox(rb.position, car.isOnGround, povOverride.playerHitboxId)
        : rb.position;
    writeKinematicsBlock(buf, cBase, pos, rb.rotation, rb.linearVelocity, rb.angularVelocity);

    buf[cBase + CAR_STATE_OFFSETS.BOOST] = car.boostAmount;
    buf[cBase + CAR_STATE_OFFSETS.ON_GROUND] = car.isOnGround ? 1 : 0;
    buf[cBase + CAR_STATE_OFFSETS.SUPERSONIC] = car.isSupersonic ? 1 : 0;
    buf[cBase + CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = car.hasFlipOrJump ? 1 : 0;
    buf[cBase + CAR_STATE_OFFSETS.IS_BOOSTING] =
      car.activeFlags.boostActive || car.controls.boost ? 1 : 0;
    buf[cBase + CAR_STATE_OFFSETS.IS_FLIPPING] =
      car.activeFlags.dodgeActive || car.activeFlags.doubleJumpActive ? 1 : 0;

    const wContact = car.isOnGround ? 1 : 0;
    buf.fill(wContact, cBase + CAR_STATE_OFFSETS.WHEELS, cBase + CAR_STATE_OFFSETS.WHEELS + 4);
    buf[cBase + CAR_STATE_OFFSETS.GROUND_NORMAL + 2] = 1;

    const airTime = car.isOnGround ? 0 : Math.max(0, car.airTimeSinceJump);
    buf[extBase + EXTENDED_STATE_OFFSETS.CAR_IS_JUMPING_OFFSET] = car.activeFlags.jumpActive
      ? 1
      : 0;
    buf[extBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_OFFSET] = airTime;
    buf[extBase + EXTENDED_STATE_OFFSETS.CAR_JUMP_TIME_OFFSET] = car.activeFlags.jumpActive
      ? Math.min(0.2, Math.max(RLRC_FIXED_DT, airTime))
      : 0;
    buf[extBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_SINCE_JUMP_OFFSET] = airTime;
  }

  const padCooldowns = frame.boostPadCooldowns;
  for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
    const pBase = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
    const cd = padCooldowns && p < padCooldowns.length ? Math.max(0, padCooldowns[p]) : 0;
    buf[pBase + BOOST_PAD_OFFSETS.IS_ACTIVE] = cd <= 0.0001 ? 1 : 0;
    buf[pBase + BOOST_PAD_OFFSETS.COOLDOWN] = cd;
  }

  buf[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] = bRb.sleeping ? 1 : 0;
  return buf;
}
