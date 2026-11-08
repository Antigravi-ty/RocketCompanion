import {
  SIM_OFFSETS, BALL_STATE_OFFSETS, BALL_STATE_STRIDE, CAR_STATE_OFFSETS, CAR_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET, BOOST_PAD_STATE_STRIDE, BOOST_PAD_OFFSETS, EXTENDED_STATE_OFFSETS, MAX_CARS, NUM_BOOST_PADS,
} from '../../../physics/RocketSimConstants.ts';
import {
  RLRC_BOOST_PAD_COUNT, RLRC_MAX_PLAYER_SLOTS, RLRC_STATE_FLOATS_PER_FRAME,
  type RLRCBallFrameState120Hz, type RLRCCarFrameState120Hz, type RLRCFrame120Hz,
  type RLRCPlayerSlotMeta, type RLRCQuat, type RLRCSynthesizedCarControls, type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export interface RLRCPlaybackPhysicsPort {
  readonly state: Float32Array; readonly numCars?: number;
  isCarSlotActive?: (slot: number) => boolean; addCarAtSlot?: (slot: number, team: number, hitboxId: string) => number;
  removeCar?: (slot: number) => boolean; setCarTeam?: (slot: number, team: number) => boolean;
  setCarHitbox?: (slot: number, hitboxId: string) => boolean; setBallState?: (ballSlice: Float32Array) => boolean;
  setCarState?: (slot: number, carSlice: Float32Array) => boolean; setControls?: (slot: number, controls: RLRCSynthesizedCarControls) => void;
}
export interface RLRCPlaybackArenaPort {
  playerCarIndex?: number; ball?: { visible?: boolean } | null;
  indicatorRing?: { visible?: boolean } | null; indicatorHeightRing?: { visible?: boolean } | null;
  cars?: Array<{ visible?: boolean } | null | undefined>;
  ensureOpponent?: () => Promise<void> | void; ensureCar?: (slot: number, team: number, visualId: string) => unknown;
  removeCar?: (slot: number) => boolean; setCarTeam?: (slot: number, team: number) => void;
  setCarColor?: (slot: number, colorHex: string) => void; setCarLoadout?: (slot: number, loadout: Record<string, unknown>) => void;
  resetCarBoosts?: (slot: number | null) => void; resetBoostPads?: () => void;
  carDemolitions?: Array<{ stop?: () => void } | null | undefined>;
  supersonicWheelTrailSystem?: { resetCar?: (slot: number | null) => void } | null;
}
export interface RLRCPlaybackRuntimePort {
  playerCarIndex?: number; playerControls?: RLRCSynthesizedCarControls; playerThrottle?: number;
  physics?: RLRCPlaybackPhysicsPort | null; arena?: RLRCPlaybackArenaPort | null;
  interpolator?: { prevState: Float32Array; currState: Float32Array; alpha: number } | null;
  keyboard?: { ballControlEnabled?: boolean } | null;
}
export interface RLRCFrameSyncOptions {
  readonly smoothStep?: boolean; readonly activePovSlotIndex?: number;
  readonly excludedSlotMask?: number; readonly syncBall?: boolean; readonly syncBoostPads?: boolean;
}
export interface RLRCFrameSyncSummary {
  readonly frameIndex120Hz: number; readonly activeSlotMask: number;
  readonly spawnedSlotMask: number; readonly removedSlotMask: number; readonly activeCarCount: number;
}

const NEUTRAL_CTRL: RLRCSynthesizedCarControls = Object.freeze({ throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false });
const TEAM_HEX: readonly [string, string] = ['#38bdf8', '#fb923c'];
const num = (v: number, fb = 0): number => (Number.isFinite(v) ? v : fb);
const wrV3 = (v: RLRCVec3, dst: Float32Array, off: number, fbZ = 0): void => {
  dst[off] = num(v.x); dst[off + 1] = num(v.y); dst[off + 2] = num(v.z, fbZ);
};
const findCar = (cars: readonly RLRCCarFrameState120Hz[], s: number): RLRCCarFrameState120Hz | null =>
  (s < cars.length && cars[s]?.slotIndex === s ? cars[s] : cars.find((c) => c.slotIndex === s)) || null;

export function writeQuaternionBasisToSlice(q: RLRCQuat, dst: Float32Array, b: number): void {
  const qx = num(q.x), qy = num(q.y), qz = num(q.z), qw = num(q.w, 1), nSq = qx * qx + qy * qy + qz * qz + qw * qw;
  if (nSq < 1e-8) {
    dst[b] = dst[b + 4] = dst[b + 8] = 1; dst[b + 1] = dst[b + 2] = dst[b + 3] = dst[b + 5] = dst[b + 6] = dst[b + 7] = 0;
    return;
  }
  const inv = 1 / Math.sqrt(nSq), x = qx * inv, y = qy * inv, z = qz * inv, w = qw * inv, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  dst[b] = 1 - (yy + zz); dst[b + 1] = xy + wz; dst[b + 2] = xz - wy;
  dst[b + 3] = xy - wz; dst[b + 4] = 1 - (xx + zz); dst[b + 5] = yz + wx;
  dst[b + 6] = xz + wy; dst[b + 7] = yz - wx; dst[b + 8] = 1 - (xx + yy);
}

export function writeBallFrameToSlice(ball: RLRCBallFrameState120Hz, dst18: Float32Array): void {
  dst18.fill(0);
  const rb = ball.rigidBody;
  wrV3(rb.position, dst18, BALL_STATE_OFFSETS.POS, 93.15);
  writeQuaternionBasisToSlice(rb.rotation, dst18, BALL_STATE_OFFSETS.ROT_MAT);
  if (ball.entityActive && !rb.sleeping) {
    wrV3(rb.linearVelocity, dst18, BALL_STATE_OFFSETS.VEL);
    wrV3(rb.angularVelocity, dst18, BALL_STATE_OFFSETS.ANG_VEL);
  }
}

const wrParked = (s: number, dst40: Float32Array): void => {
  dst40.fill(0);
  dst40[CAR_STATE_OFFSETS.POS] = -5500; dst40[CAR_STATE_OFFSETS.POS + 1] = s * 300; dst40[CAR_STATE_OFFSETS.POS + 2] = -500;
  dst40[CAR_STATE_OFFSETS.FWD] = dst40[CAR_STATE_OFFSETS.RIGHT + 1] = dst40[CAR_STATE_OFFSETS.UP + 2] = 1;
};

export function writeCarFrameToSlice(car: RLRCCarFrameState120Hz, dst40: Float32Array): void {
  const rb = car.rigidBody, p = rb.position;
  if (!car.entityActive) {
    if (Math.hypot(p.x, p.y) > 1.0) {
      dst40.fill(0); wrV3(p, dst40, CAR_STATE_OFFSETS.POS, 17.01);
      writeQuaternionBasisToSlice(rb.rotation, dst40, CAR_STATE_OFFSETS.FWD);
      dst40[CAR_STATE_OFFSETS.DEMOED] = dst40[CAR_STATE_OFFSETS.GROUND_NORMAL + 2] = 1;
    } else wrParked(car.slotIndex, dst40);
    return;
  }
  dst40.fill(0);
  wrV3(p, dst40, CAR_STATE_OFFSETS.POS, 17.01);
  writeQuaternionBasisToSlice(rb.rotation, dst40, CAR_STATE_OFFSETS.FWD);
  if (!rb.sleeping) {
    wrV3(rb.linearVelocity, dst40, CAR_STATE_OFFSETS.VEL);
    wrV3(rb.angularVelocity, dst40, CAR_STATE_OFFSETS.ANG_VEL);
  }
  dst40[CAR_STATE_OFFSETS.BOOST] = Math.max(0, Math.min(100, Number(car.boostAmount) || 0));
  dst40[CAR_STATE_OFFSETS.ON_GROUND] = car.isOnGround ? 1 : 0;
  dst40[CAR_STATE_OFFSETS.SUPERSONIC] = car.isSupersonic ? 1 : 0;
  dst40[CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = car.hasFlipOrJump ? 1 : 0;
  dst40[CAR_STATE_OFFSETS.IS_BOOSTING] = car.activeFlags.boostActive || car.controls.boost ? 1 : 0;
  dst40[CAR_STATE_OFFSETS.IS_FLIPPING] = car.activeFlags.dodgeActive ? 1 : 0;
  const stRad = (Number(car.controls.steer) || 0) * 0.5235988;
  for (let w = 0; w < 4; w++) {
    const wb = CAR_STATE_OFFSETS.WHEELS + w * 3;
    dst40[wb] = car.isOnGround ? 18.0 : 35.0; dst40[wb + 1] = w < 2 ? stRad : 0; dst40[wb + 2] = car.isOnGround ? 1 : 0;
  }
  dst40[CAR_STATE_OFFSETS.GROUND_NORMAL + 2] = 1;
}

export function buildCompactSnapshotFromRLRCFrame(frame: RLRCFrame120Hz, out: Float32Array = new Float32Array(RLRC_STATE_FLOATS_PER_FRAME)): Float32Array {
  out.fill(0);
  let maxS = 1;
  for (const c of frame.cars) if (c && c.slotIndex >= 0 && c.slotIndex < MAX_CARS) maxS = Math.max(maxS, c.slotIndex + 1);
  out[SIM_OFFSETS.TICK] = Math.max(16, frame.frameIndex120Hz + 16);
  out[SIM_OFFSETS.NUM_CARS] = maxS; out[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;
  writeBallFrameToSlice(frame.ball, out.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE));
  for (let s = 0; s < MAX_CARS; s++) {
    const off = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE, sl = out.subarray(off, off + CAR_STATE_STRIDE), cf = findCar(frame.cars, s);
    if (cf) writeCarFrameToSlice(cf, sl); else wrParked(s, sl);
  }
  const padLen = Math.min(NUM_BOOST_PADS, frame.boostPadCooldowns?.length || 0);
  for (let p = 0; p < NUM_BOOST_PADS; p++) {
    const po = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE, cd = p < padLen ? Math.max(0, frame.boostPadCooldowns[p] || 0) : 0;
    out[po + BOOST_PAD_OFFSETS.IS_ACTIVE] = cd <= 1e-4 ? 1 : 0; out[po + BOOST_PAD_OFFSETS.COOLDOWN] = cd;
  }
  out[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] = !frame.ball.entityActive || frame.ball.rigidBody.sleeping ? 1 : 0;
  return out;
}

export class RLRCPlaybackSyncApplier {
  private readonly _r = new Map<number, RLRCPlayerSlotMeta>();
  private readonly _act = new Uint8Array(MAX_CARS);
  private readonly _mesh = new Uint8Array(MAX_CARS);
  private readonly _ctrl: RLRCSynthesizedCarControls[] = Array.from({ length: MAX_CARS }, () => NEUTRAL_CTRL);
  private readonly _sBall = new Float32Array(BALL_STATE_STRIDE);
  private readonly _sCar = new Float32Array(CAR_STATE_STRIDE);
  private _lastF = -1;
  private _bAct = true;

  public configureRoster(roster: readonly RLRCPlayerSlotMeta[], runtime: RLRCPlaybackRuntimePort | null): void {
    this._r.clear(); this.resetLifecycleTracking(); this._bAct = true;
    for (const m of roster) if (m.slotIndex >= 0 && m.slotIndex < RLRC_MAX_PLAYER_SLOTS) this._r.set(m.slotIndex, m);
    const sim = runtime?.physics, ar = runtime?.arena;
    if (sim) for (let s = MAX_CARS - 1; s >= 0; s--) if (sim.isCarSlotActive?.(s)) sim.removeCar?.(s);
    if (ar?.cars) {
      for (let s = 0; s < ar.cars.length; s++) {
        if (ar.cars[s]) ar.cars[s]!.visible = false;
        ar.resetCarBoosts?.(s); ar.carDemolitions?.[s]?.stop?.(); ar.supersonicWheelTrailSystem?.resetCar?.(s);
      }
    }
    if (ar?.ball) ar.ball.visible = true;
    ar?.resetBoostPads?.();
  }

  public resetLifecycleTracking(): void {
    this._act.fill(0); this._mesh.fill(0); this._ctrl.fill(NEUTRAL_CTRL); this._lastF = -1;
  }

  public getLastAppliedFrameIndex(): number { return this._lastF; }
  public isSlotCurrentlyActive(s: number): boolean { return s >= 0 && s < MAX_CARS && this._act[s] === 1; }
  public getCarControls(s: number): RLRCSynthesizedCarControls { return (s >= 0 && s < MAX_CARS ? this._ctrl[s] : null) ?? NEUTRAL_CTRL; }

  private _spawnSlot(s: number, rt: RLRCPlaybackRuntimePort, meta: RLRCPlayerSlotMeta | undefined): void {
    const tm = meta?.team === 1 ? 1 : 0, hb = meta?.hitboxId || 'hitbox-octane', vis = meta?.visualId || 'fennec', hex = meta?.primaryColorHex || TEAM_HEX[tm];
    rt.physics?.addCarAtSlot?.(s, tm, hb); rt.physics?.setCarTeam?.(s, tm); rt.physics?.setCarHitbox?.(s, hb);
    const ar = rt.arena;
    if (!ar) return;
    if (this._mesh[s] === 0 || !ar.cars?.[s]) {
      if (s === 1) void ar.ensureOpponent?.();
      ar.ensureCar?.(s, tm, vis); ar.setCarTeam?.(s, tm); ar.setCarColor?.(s, hex);
      ar.setCarLoadout?.(s, { name: meta?.userName || `Player ${s + 1}`, colorHex: hex });
      this._mesh[s] = 1;
    }
    if (ar.cars?.[s]) ar.cars[s]!.visible = true;
    ar.carDemolitions?.[s]?.stop?.(); ar.supersonicWheelTrailSystem?.resetCar?.(s);
  }

  private _despawnSlot(s: number, rt: RLRCPlaybackRuntimePort, cf: RLRCCarFrameState120Hz | null): void {
    const sim = rt.physics, off = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE, ar = rt.arena;
    if (sim?.isCarSlotActive?.(s)) sim.removeCar?.(s);
    if (sim?.state && off + CAR_STATE_STRIDE <= sim.state.length) {
      const dst = sim.state.subarray(off, off + CAR_STATE_STRIDE);
      if (cf && this._r.has(s)) writeCarFrameToSlice(cf, dst); else wrParked(s, dst);
    }
    sim?.setControls?.(s, NEUTRAL_CTRL); this._ctrl[s] = NEUTRAL_CTRL;
    if (ar) {
      if (ar.cars?.[s]) ar.cars[s]!.visible = false;
      ar.resetCarBoosts?.(s); ar.supersonicWheelTrailSystem?.resetCar?.(s);
    }
  }

  public applyFrame120Hz(frame: RLRCFrame120Hz, runtime: RLRCPlaybackRuntimePort | null, options: RLRCFrameSyncOptions = {}): RLRCFrameSyncSummary {
    let activeSlotMask = 0, spawnedSlotMask = 0, removedSlotMask = 0, activeCarCount = 0;
    if (!runtime?.physics) return { frameIndex120Hz: frame.frameIndex120Hz, activeSlotMask, spawnedSlotMask, removedSlotMask, activeCarCount };
    const sim = runtime.physics, ar = runtime.arena, sm = Boolean(options.smoothStep), exMask = options.excludedSlotMask ?? 0;
    const pov = typeof options.activePovSlotIndex === 'number' && options.activePovSlotIndex >= 0 ? options.activePovSlotIndex : (runtime.playerCarIndex ?? 0);
    runtime.playerCarIndex = pov; if (ar) ar.playerCarIndex = pov;
    if (runtime.keyboard?.ballControlEnabled) runtime.keyboard.ballControlEnabled = false;
    if (sm && runtime.interpolator) runtime.interpolator.prevState.set(runtime.interpolator.currState);

    const bNow = Boolean(frame.ball.entityActive), bResp = bNow && !this._bAct;
    this._bAct = bNow;
    if (options.syncBall !== false) {
      writeBallFrameToSlice(frame.ball, this._sBall);
      sim.setBallState?.(this._sBall);
      if (sim.state.length > EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING) sim.state[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] = !bNow || frame.ball.rigidBody.sleeping ? 1 : 0;
      if (ar?.ball) ar.ball.visible = bNow;
      if (ar?.indicatorRing) ar.indicatorRing.visible = bNow;
      if (ar?.indicatorHeightRing && !bNow) ar.indicatorHeightRing.visible = false;
    }

    let maxS = Math.max(1, this._r.size);
    for (let s = 0; s < RLRC_MAX_PLAYER_SLOTS; s++) {
      if ((exMask & (1 << s)) !== 0) {
        if (sim.isCarSlotActive?.(s)) { activeSlotMask |= 1 << s; activeCarCount++; maxS = Math.max(maxS, s + 1); }
        continue;
      }
      const cf = findCar(frame.cars, s), on = Boolean(cf?.entityActive), wasOn = this._act[s] === 1 && (sim.isCarSlotActive?.(s) ?? true);
      if (on && !wasOn) { this._spawnSlot(s, runtime, this._r.get(s)); this._act[s] = 1; spawnedSlotMask |= 1 << s; }
      else if (!on && (wasOn || (sim.isCarSlotActive?.(s) ?? false))) { this._despawnSlot(s, runtime, cf); this._act[s] = 0; removedSlotMask |= 1 << s; }
      else if (!on && cf && this._r.has(s)) {
        const off = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE;
        if (off + CAR_STATE_STRIDE <= sim.state.length) writeCarFrameToSlice(cf, sim.state.subarray(off, off + CAR_STATE_STRIDE));
      }
      if (on && cf) {
        const ctrl = cf.controls || NEUTRAL_CTRL;
        writeCarFrameToSlice(cf, this._sCar); sim.setCarState?.(s, this._sCar); sim.setControls?.(s, ctrl);
        this._ctrl[s] = ctrl;
        if (ar?.cars?.[s]) ar.cars[s]!.visible = true;
        activeSlotMask |= 1 << s; activeCarCount++; maxS = Math.max(maxS, s + 1);
      }
    }

    const pCtrl = this._ctrl[pov] ?? NEUTRAL_CTRL;
    runtime.playerControls = { ...pCtrl }; runtime.playerThrottle = pCtrl.throttle;
    sim.state[SIM_OFFSETS.TICK] = Math.max(16, frame.frameIndex120Hz + 16);
    sim.state[SIM_OFFSETS.NUM_CARS] = maxS; sim.state[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;

    if (options.syncBoostPads !== false && frame.boostPadCooldowns) this.applyBoostPadCooldowns(frame.boostPadCooldowns, sim.state);
    if (runtime.interpolator) {
      if (!sm) { runtime.interpolator.prevState.set(sim.state); runtime.interpolator.alpha = 0; }
      else {
        if (bResp) runtime.interpolator.prevState.set(sim.state.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE), SIM_OFFSETS.BALL);
        const chg = spawnedSlotMask | removedSlotMask;
        for (let s = 0; chg !== 0 && s < RLRC_MAX_PLAYER_SLOTS; s++) if ((chg & (1 << s)) !== 0) {
          const off = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE;
          runtime.interpolator.prevState.set(sim.state.subarray(off, off + CAR_STATE_STRIDE), off);
        }
      }
      runtime.interpolator.currState.set(sim.state);
    }
    this._lastF = frame.frameIndex120Hz;
    return { frameIndex120Hz: frame.frameIndex120Hz, activeSlotMask, spawnedSlotMask, removedSlotMask, activeCarCount };
  }

  public applyBoostPadCooldowns(cooldowns: Float32Array | ArrayLike<number>, stateBuffer: Float32Array): void {
    const n = Math.min(RLRC_BOOST_PAD_COUNT, cooldowns.length);
    for (let i = 0; i < RLRC_BOOST_PAD_COUNT; i++) {
      const po = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
      if (po + 1 >= stateBuffer.length) break;
      const cd = i < n ? Math.max(0, Number(cooldowns[i]) || 0) : 0;
      stateBuffer[po + BOOST_PAD_OFFSETS.IS_ACTIVE] = cd <= 1e-4 ? 1 : 0; stateBuffer[po + BOOST_PAD_OFFSETS.COOLDOWN] = cd;
    }
  }
}
