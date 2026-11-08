/**
 * RLRCPlaybackSyncApplier.ts
 * Pure 120Hz state and slot lifecycle synchronizer for RLRC Replay playback.
 */

import {
  SIM_OFFSETS,
  BALL_STATE_OFFSETS,
  BALL_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_OFFSETS,
  EXTENDED_STATE_OFFSETS,
  MAX_CARS,
  NUM_BOOST_PADS,
} from '../../../physics/RocketSimConstants.ts';
import {
  RLRC_BOOST_PAD_COUNT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_FLOATS_PER_FRAME,
  type RLRCBallFrameState120Hz,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCPlayerSlotMeta,
  type RLRCQuat,
  type RLRCSynthesizedCarControls,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export interface RLRCPlaybackPhysicsPort {
  readonly state: Float32Array;
  readonly numCars?: number;
  isCarSlotActive?: (slot: number) => boolean;
  addCarAtSlot?: (slot: number, team: number, hitboxId: string) => number;
  removeCar?: (slot: number) => boolean;
  setCarTeam?: (slot: number, team: number) => boolean;
  setCarHitbox?: (slot: number, hitboxId: string) => boolean;
  setBallState?: (ballSlice: Float32Array) => boolean;
  setCarState?: (slot: number, carSlice: Float32Array) => boolean;
  setControls?: (slot: number, controls: RLRCSynthesizedCarControls) => void;
}

export interface RLRCPlaybackArenaPort {
  playerCarIndex?: number;
  cars?: Array<{ visible?: boolean } | null | undefined>;
  ensureOpponent?: () => Promise<void> | void;
  ensureCar?: (slot: number, team: number, visualId: string) => unknown;
  removeCar?: (slot: number) => boolean;
  setCarTeam?: (slot: number, team: number) => void;
  setCarColor?: (slot: number, colorHex: string) => void;
  setCarLoadout?: (slot: number, loadout: Record<string, unknown>) => void;
  resetCarBoosts?: (slot: number | null) => void;
  resetBoostPads?: () => void;
  carDemolitions?: Array<{ stop?: () => void } | null | undefined>;
  supersonicWheelTrailSystem?: { resetCar?: (slot: number | null) => void } | null;
}

export interface RLRCPlaybackRuntimePort {
  playerCarIndex?: number;
  physics?: RLRCPlaybackPhysicsPort | null;
  arena?: RLRCPlaybackArenaPort | null;
  interpolator?: { prevState: Float32Array; currState: Float32Array; alpha: number } | null;
  keyboard?: { ballControlEnabled?: boolean } | null;
}

export interface RLRCFrameSyncOptions {
  readonly smoothStep?: boolean;
  readonly activePovSlotIndex?: number;
  readonly excludedSlotMask?: number;
  readonly syncBall?: boolean;
  readonly syncBoostPads?: boolean;
}

export interface RLRCFrameSyncSummary {
  readonly frameIndex120Hz: number;
  readonly activeSlotMask: number;
  readonly spawnedSlotMask: number;
  readonly removedSlotMask: number;
  readonly activeCarCount: number;
}

const NEUTRAL_CONTROLS: RLRCSynthesizedCarControls = Object.freeze({
  throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false,
});

const DEFAULT_TEAM_HEX: readonly [string, string] = ['#38bdf8', '#fb923c'];

export function writeQuaternionBasisToSlice(
  q: RLRCQuat,
  target: Float32Array,
  base: number
): void {
  const qx = Number.isFinite(q.x) ? q.x : 0;
  const qy = Number.isFinite(q.y) ? q.y : 0;
  const qz = Number.isFinite(q.z) ? q.z : 0;
  const qw = Number.isFinite(q.w) ? q.w : 1;
  const normSq = qx * qx + qy * qy + qz * qz + qw * qw;
  if (normSq < 1e-8) {
    target[base] = 1; target[base + 1] = 0; target[base + 2] = 0;
    target[base + 3] = 0; target[base + 4] = 1; target[base + 5] = 0;
    target[base + 6] = 0; target[base + 7] = 0; target[base + 8] = 1;
    return;
  }
  const inv = 1.0 / Math.sqrt(normSq);
  const x = qx * inv, y = qy * inv, z = qz * inv, w = qw * inv;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  target[base] = 1 - (yy + zz);
  target[base + 1] = xy + wz;
  target[base + 2] = xz - wy;
  target[base + 3] = xy - wz;
  target[base + 4] = 1 - (xx + zz);
  target[base + 5] = yz + wx;
  target[base + 6] = xz + wy;
  target[base + 7] = yz - wx;
  target[base + 8] = 1 - (xx + yy);
}

function writeVec3(v: RLRCVec3, dst: Float32Array, off: number, fallbackZ = 0): void {
  dst[off] = Number.isFinite(v.x) ? v.x : 0;
  dst[off + 1] = Number.isFinite(v.y) ? v.y : 0;
  dst[off + 2] = Number.isFinite(v.z) ? v.z : fallbackZ;
}

export function writeBallFrameToSlice(
  ball: RLRCBallFrameState120Hz,
  dst18: Float32Array
): void {
  dst18.fill(0);
  if (!ball.entityActive) {
    dst18[BALL_STATE_OFFSETS.POS + 2] = 93.15;
    dst18[BALL_STATE_OFFSETS.FWD] = 1;
    dst18[BALL_STATE_OFFSETS.RIGHT + 1] = 1;
    dst18[BALL_STATE_OFFSETS.UP + 2] = 1;
    return;
  }
  const rb = ball.rigidBody;
  writeVec3(rb.position, dst18, BALL_STATE_OFFSETS.POS, 93.15);
  writeQuaternionBasisToSlice(rb.rotation, dst18, BALL_STATE_OFFSETS.ROT_MAT);
  if (!rb.sleeping) {
    writeVec3(rb.linearVelocity, dst18, BALL_STATE_OFFSETS.VEL, 0);
    writeVec3(rb.angularVelocity, dst18, BALL_STATE_OFFSETS.ANG_VEL, 0);
  }
}

function writeParkedCarSlice(slot: number, dst40: Float32Array): void {
  dst40.fill(0);
  dst40[CAR_STATE_OFFSETS.POS] = -5500;
  dst40[CAR_STATE_OFFSETS.POS + 1] = slot * 300;
  dst40[CAR_STATE_OFFSETS.POS + 2] = -500;
  dst40[CAR_STATE_OFFSETS.FWD] = 1;
  dst40[CAR_STATE_OFFSETS.RIGHT + 1] = 1;
  dst40[CAR_STATE_OFFSETS.UP + 2] = 1;
}

export function writeCarFrameToSlice(
  car: RLRCCarFrameState120Hz,
  dst40: Float32Array
): void {
  if (!car.entityActive) {
    writeParkedCarSlice(car.slotIndex, dst40);
    return;
  }
  dst40.fill(0);
  const rb = car.rigidBody;
  writeVec3(rb.position, dst40, CAR_STATE_OFFSETS.POS, 17.01);
  writeQuaternionBasisToSlice(rb.rotation, dst40, CAR_STATE_OFFSETS.FWD);
  if (!rb.sleeping) {
    writeVec3(rb.linearVelocity, dst40, CAR_STATE_OFFSETS.VEL, 0);
    writeVec3(rb.angularVelocity, dst40, CAR_STATE_OFFSETS.ANG_VEL, 0);
  }
  dst40[CAR_STATE_OFFSETS.BOOST] = Math.max(0, Math.min(100, Number(car.boostAmount) || 0));
  dst40[CAR_STATE_OFFSETS.ON_GROUND] = car.isOnGround ? 1 : 0;
  dst40[CAR_STATE_OFFSETS.SUPERSONIC] = car.isSupersonic ? 1 : 0;
  dst40[CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = car.hasFlipOrJump ? 1 : 0;
  dst40[CAR_STATE_OFFSETS.IS_BOOSTING] =
    car.activeFlags.boostActive || car.controls.boost ? 1 : 0;
  dst40[CAR_STATE_OFFSETS.IS_FLIPPING] = car.activeFlags.dodgeActive ? 1 : 0;

  const steerRad = (Number(car.controls.steer) || 0) * 0.5235988;
  for (let w = 0; w < 4; w++) {
    const wBase = CAR_STATE_OFFSETS.WHEELS + w * 3;
    dst40[wBase] = car.isOnGround ? 18.0 : 35.0;
    dst40[wBase + 1] = w < 2 ? steerRad : 0;
    dst40[wBase + 2] = car.isOnGround ? 1 : 0;
  }
  dst40[CAR_STATE_OFFSETS.GROUND_NORMAL + 2] = 1;
}

export function buildCompactSnapshotFromRLRCFrame(
  frame: RLRCFrame120Hz,
  out: Float32Array = new Float32Array(RLRC_STATE_FLOATS_PER_FRAME)
): Float32Array {
  out.fill(0);
  let maxSlotPlusOne = 1;
  for (let i = 0; i < frame.cars.length; i++) {
    const c = frame.cars[i];
    if (c?.entityActive && c.slotIndex >= 0 && c.slotIndex < MAX_CARS) {
      maxSlotPlusOne = Math.max(maxSlotPlusOne, c.slotIndex + 1);
    }
  }
  out[SIM_OFFSETS.TICK] = Math.max(16, frame.frameIndex120Hz + 16);
  out[SIM_OFFSETS.NUM_CARS] = maxSlotPlusOne;
  out[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;

  writeBallFrameToSlice(
    frame.ball,
    out.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE)
  );

  for (let slot = 0; slot < MAX_CARS; slot++) {
    const carOff = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
    const carSlice = out.subarray(carOff, carOff + CAR_STATE_STRIDE);
    const carFrame =
      slot < frame.cars.length && frame.cars[slot]?.slotIndex === slot
        ? frame.cars[slot]
        : frame.cars.find((c) => c.slotIndex === slot) || null;
    if (carFrame) writeCarFrameToSlice(carFrame, carSlice);
    else writeParkedCarSlice(slot, carSlice);
  }

  const padLen = Math.min(NUM_BOOST_PADS, frame.boostPadCooldowns?.length || 0);
  for (let p = 0; p < NUM_BOOST_PADS; p++) {
    const padOff = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
    const cd = p < padLen ? Math.max(0, frame.boostPadCooldowns[p] || 0) : 0;
    out[padOff + BOOST_PAD_OFFSETS.IS_ACTIVE] = cd <= 1e-4 ? 1 : 0;
    out[padOff + BOOST_PAD_OFFSETS.COOLDOWN] = cd;
  }
  out[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] = frame.ball.rigidBody.sleeping ? 1 : 0;
  return out;
}

export class RLRCPlaybackSyncApplier {
  private readonly _rosterBySlot = new Map<number, RLRCPlayerSlotMeta>();
  private readonly _activeSlotFlags = new Uint8Array(MAX_CARS);
  private readonly _scratchBallSlice = new Float32Array(BALL_STATE_STRIDE);
  private readonly _scratchCarSlice = new Float32Array(CAR_STATE_STRIDE);
  private _lastAppliedFrameIndex = -1;

  public configureRoster(
    roster: readonly RLRCPlayerSlotMeta[],
    runtime: RLRCPlaybackRuntimePort | null
  ): void {
    this._rosterBySlot.clear();
    this._activeSlotFlags.fill(0);
    this._lastAppliedFrameIndex = -1;
    for (const meta of roster) {
      if (meta.slotIndex >= 0 && meta.slotIndex < RLRC_MAX_PLAYER_SLOTS) {
        this._rosterBySlot.set(meta.slotIndex, meta);
      }
    }
    const sim = runtime?.physics;
    const arena = runtime?.arena;
    if (sim) {
      for (let slot = MAX_CARS - 1; slot >= 0; slot--) {
        if (sim.isCarSlotActive?.(slot)) sim.removeCar?.(slot);
      }
    }
    if (arena?.cars) {
      for (let slot = 0; slot < arena.cars.length; slot++) {
        if (arena.cars[slot]) arena.cars[slot]!.visible = false;
        arena.resetCarBoosts?.(slot);
        arena.carDemolitions?.[slot]?.stop?.();
        arena.supersonicWheelTrailSystem?.resetCar?.(slot);
      }
    }
    arena?.resetBoostPads?.();
  }

  public resetLifecycleTracking(): void {
    this._activeSlotFlags.fill(0);
    this._lastAppliedFrameIndex = -1;
  }

  public getLastAppliedFrameIndex(): number {
    return this._lastAppliedFrameIndex;
  }

  public isSlotCurrentlyActive(slotIndex: number): boolean {
    return slotIndex >= 0 && slotIndex < MAX_CARS && this._activeSlotFlags[slotIndex] === 1;
  }

  private _spawnSlotEntity(
    slot: number,
    runtime: RLRCPlaybackRuntimePort,
    meta: RLRCPlayerSlotMeta | undefined
  ): void {
    const team = meta?.team === 1 ? 1 : 0;
    const hitboxId = meta?.hitboxId || 'hitbox-octane';
    const visualId = meta?.visualId || 'fennec';
    const colorHex = meta?.primaryColorHex || DEFAULT_TEAM_HEX[team];

    runtime.physics?.addCarAtSlot?.(slot, team, hitboxId);
    runtime.physics?.setCarTeam?.(slot, team);
    runtime.physics?.setCarHitbox?.(slot, hitboxId);

    const arena = runtime.arena;
    if (arena) {
      if (slot === 1) void arena.ensureOpponent?.();
      arena.ensureCar?.(slot, team, visualId);
      arena.setCarTeam?.(slot, team);
      arena.setCarColor?.(slot, colorHex);
      arena.setCarLoadout?.(slot, { name: meta?.userName || `Player ${slot + 1}`, colorHex });
      if (arena.cars?.[slot]) arena.cars[slot]!.visible = true;
      arena.carDemolitions?.[slot]?.stop?.();
      arena.supersonicWheelTrailSystem?.resetCar?.(slot);
    }
  }

  private _despawnSlotEntity(slot: number, runtime: RLRCPlaybackRuntimePort): void {
    const sim = runtime.physics;
    if (sim?.isCarSlotActive?.(slot)) sim.removeCar?.(slot);
    const offset = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
    if (sim?.state && offset + CAR_STATE_STRIDE <= sim.state.length) {
      writeParkedCarSlice(slot, sim.state.subarray(offset, offset + CAR_STATE_STRIDE));
    }
    sim?.setControls?.(slot, NEUTRAL_CONTROLS);

    const arena = runtime.arena;
    if (arena) {
      if (arena.cars?.[slot]) arena.cars[slot]!.visible = false;
      arena.resetCarBoosts?.(slot);
      arena.carDemolitions?.[slot]?.stop?.();
      arena.supersonicWheelTrailSystem?.resetCar?.(slot);
    }
  }

  public applyFrame120Hz(
    frame: RLRCFrame120Hz,
    runtime: RLRCPlaybackRuntimePort | null,
    options: RLRCFrameSyncOptions = {}
  ): RLRCFrameSyncSummary {
    let activeSlotMask = 0, spawnedSlotMask = 0, removedSlotMask = 0, activeCarCount = 0;
    if (!runtime?.physics) {
      return { frameIndex120Hz: frame.frameIndex120Hz, activeSlotMask, spawnedSlotMask, removedSlotMask, activeCarCount };
    }

    const sim = runtime.physics;
    const arena = runtime.arena;
    const smoothStep = Boolean(options.smoothStep);
    const excludedMask = options.excludedSlotMask ?? 0;

    if (typeof options.activePovSlotIndex === 'number' && options.activePovSlotIndex >= 0) {
      runtime.playerCarIndex = options.activePovSlotIndex;
      if (arena) arena.playerCarIndex = options.activePovSlotIndex;
    }
    if (runtime.keyboard?.ballControlEnabled) runtime.keyboard.ballControlEnabled = false;
    if (smoothStep && runtime.interpolator) {
      runtime.interpolator.prevState.set(runtime.interpolator.currState);
    }

    if (options.syncBall !== false) {
      writeBallFrameToSlice(frame.ball, this._scratchBallSlice);
      sim.setBallState?.(this._scratchBallSlice);
      if (sim.state.length > EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING) {
        sim.state[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] = frame.ball.rigidBody.sleeping ? 1 : 0;
      }
    }

    let maxSlotPlusOne = 1;
    for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
      if ((excludedMask & (1 << slot)) !== 0) {
        if (sim.isCarSlotActive?.(slot)) {
          activeSlotMask |= 1 << slot;
          activeCarCount++;
          maxSlotPlusOne = Math.max(maxSlotPlusOne, slot + 1);
        }
        continue;
      }
      const carFrame =
        slot < frame.cars.length && frame.cars[slot]?.slotIndex === slot
          ? frame.cars[slot]
          : frame.cars.find((c) => c.slotIndex === slot) || null;
      const shouldBeActive = Boolean(carFrame?.entityActive);
      const wasActive = this._activeSlotFlags[slot] === 1 && (sim.isCarSlotActive?.(slot) ?? true);

      if (shouldBeActive && !wasActive) {
        this._spawnSlotEntity(slot, runtime, this._rosterBySlot.get(slot));
        this._activeSlotFlags[slot] = 1;
        spawnedSlotMask |= 1 << slot;
      } else if (!shouldBeActive && (wasActive || (sim.isCarSlotActive?.(slot) ?? false))) {
        this._despawnSlotEntity(slot, runtime);
        this._activeSlotFlags[slot] = 0;
        removedSlotMask |= 1 << slot;
      }

      if (shouldBeActive && carFrame) {
        writeCarFrameToSlice(carFrame, this._scratchCarSlice);
        sim.setCarState?.(slot, this._scratchCarSlice);
        sim.setControls?.(slot, carFrame.controls || NEUTRAL_CONTROLS);
        if (arena?.cars?.[slot]) arena.cars[slot]!.visible = true;
        activeSlotMask |= 1 << slot;
        activeCarCount++;
        maxSlotPlusOne = Math.max(maxSlotPlusOne, slot + 1);
      }
    }

    sim.state[SIM_OFFSETS.TICK] = Math.max(16, frame.frameIndex120Hz + 16);
    sim.state[SIM_OFFSETS.NUM_CARS] = maxSlotPlusOne;
    sim.state[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;

    if (options.syncBoostPads !== false && frame.boostPadCooldowns) {
      this.applyBoostPadCooldowns(frame.boostPadCooldowns, sim.state);
    }
    if (runtime.interpolator) {
      if (!smoothStep || spawnedSlotMask !== 0 || removedSlotMask !== 0) {
        runtime.interpolator.prevState.set(sim.state);
        runtime.interpolator.alpha = 0;
      }
      runtime.interpolator.currState.set(sim.state);
    }
    this._lastAppliedFrameIndex = frame.frameIndex120Hz;
    return { frameIndex120Hz: frame.frameIndex120Hz, activeSlotMask, spawnedSlotMask, removedSlotMask, activeCarCount };
  }

  public applyBoostPadCooldowns(
    cooldowns: Float32Array | ArrayLike<number>,
    stateBuffer: Float32Array
  ): void {
    const count = Math.min(RLRC_BOOST_PAD_COUNT, cooldowns.length);
    for (let i = 0; i < RLRC_BOOST_PAD_COUNT; i++) {
      const padOff = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
      if (padOff + 1 >= stateBuffer.length) break;
      const cd = i < count ? Math.max(0, Number(cooldowns[i]) || 0) : 0;
      stateBuffer[padOff + BOOST_PAD_OFFSETS.IS_ACTIVE] = cd <= 1e-4 ? 1 : 0;
      stateBuffer[padOff + BOOST_PAD_OFFSETS.COOLDOWN] = cd;
    }
  }
}
