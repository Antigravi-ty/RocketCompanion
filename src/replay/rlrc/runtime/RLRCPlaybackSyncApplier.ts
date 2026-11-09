import {
  SIM_OFFSETS, BALL_STATE_OFFSETS, BALL_STATE_STRIDE, CAR_STATE_OFFSETS, CAR_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET, BOOST_PAD_STATE_STRIDE, BOOST_PAD_OFFSETS, EXTENDED_STATE_OFFSETS,
  MAX_CARS, NUM_BOOST_PADS,
} from '../../../physics/RocketSimConstants.ts';
import {
  RLRC_BOOST_PAD_COUNT, RLRC_MAX_PLAYER_SLOTS, RLRC_STATE_FLOATS_PER_FRAME,
  type RLRCBallFrameState120Hz, type RLRCCarFrameState120Hz, type RLRCFrame120Hz,
  type RLRCPlayerSlotMeta, type RLRCQuat, type RLRCSynthesizedCarControls, type RLRCVec3,
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
  ball?: { visible?: boolean } | null;
  indicatorRing?: { visible?: boolean } | null;
  indicatorHeightRing?: { visible?: boolean } | null;
  ballSpeedTrail?: { reset?: () => void } | null;
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
  playerControls?: RLRCSynthesizedCarControls | Record<string, unknown> | null;
  playerThrottle?: number;
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

const NEUTRAL_CTRL: RLRCSynthesizedCarControls = Object.freeze({
  throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false,
});
const TEAM_HEX: readonly [string, string] = ['#38bdf8', '#fb923c'];

export function writeQuaternionBasisToSlice(q: RLRCQuat, d: Float32Array, b: number): void {
  const qx = Number.isFinite(q.x) ? q.x : 0, qy = Number.isFinite(q.y) ? q.y : 0;
  const qz = Number.isFinite(q.z) ? q.z : 0, qw = Number.isFinite(q.w) ? q.w : 1;
  const nSq = qx * qx + qy * qy + qz * qz + qw * qw;
  if (nSq < 1e-8) {
    d[b] = 1; d[b + 1] = 0; d[b + 2] = 0; d[b + 3] = 0; d[b + 4] = 1; d[b + 5] = 0; d[b + 6] = 0; d[b + 7] = 0; d[b + 8] = 1;
    return;
  }
  const k = 1.0 / Math.sqrt(nSq);
  const x = qx * k, y = qy * k, z = qz * k, w = qw * k, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  d[b] = 1 - (yy + zz); d[b + 1] = xy + wz; d[b + 2] = xz - wy;
  d[b + 3] = xy - wz; d[b + 4] = 1 - (xx + zz); d[b + 5] = yz + wx;
  d[b + 6] = xz + wy; d[b + 7] = yz - wx; d[b + 8] = 1 - (xx + yy);
}

function writeVec3(v: RLRCVec3, d: Float32Array, o: number, fz = 0): void {
  d[o] = Number.isFinite(v.x) ? v.x : 0;
  d[o + 1] = Number.isFinite(v.y) ? v.y : 0;
  d[o + 2] = Number.isFinite(v.z) ? v.z : fz;
}

const B_OFF = BALL_STATE_OFFSETS, C_OFF = CAR_STATE_OFFSETS;

export function writeBallFrameToSlice(ball: RLRCBallFrameState120Hz, d: Float32Array): void {
  d.fill(0);
  if (!ball.entityActive) {
    d[B_OFF.POS + 2] = -5000; d[B_OFF.FWD] = d[B_OFF.RIGHT + 1] = d[B_OFF.UP + 2] = 1;
    return;
  }
  const rb = ball.rigidBody;
  writeVec3(rb.position, d, B_OFF.POS, 93.15);
  writeQuaternionBasisToSlice(rb.rotation, d, B_OFF.ROT_MAT);
  if (!rb.sleeping) { writeVec3(rb.linearVelocity, d, B_OFF.VEL); writeVec3(rb.angularVelocity, d, B_OFF.ANG_VEL); }
}

function writeParkedCarSlice(slot: number, d: Float32Array): void {
  d.fill(0);
  d[C_OFF.POS] = -5500; d[C_OFF.POS + 1] = slot * 300; d[C_OFF.POS + 2] = -500;
  d[C_OFF.FWD] = d[C_OFF.RIGHT + 1] = d[C_OFF.UP + 2] = 1;
}

export function writeCarFrameToSlice(car: RLRCCarFrameState120Hz, d: Float32Array): void {
  if (!car.entityActive) { writeParkedCarSlice(car.slotIndex, d); return; }
  d.fill(0);
  const rb = car.rigidBody;
  writeVec3(rb.position, d, C_OFF.POS, 17.01);
  writeQuaternionBasisToSlice(rb.rotation, d, C_OFF.FWD);
  if (!rb.sleeping) { writeVec3(rb.linearVelocity, d, C_OFF.VEL); writeVec3(rb.angularVelocity, d, C_OFF.ANG_VEL); }
  d[C_OFF.BOOST] = Math.max(0, Math.min(100, Number(car.boostAmount) || 0));
  d[C_OFF.ON_GROUND] = car.isOnGround ? 1 : 0;
  d[C_OFF.SUPERSONIC] = car.isSupersonic ? 1 : 0;
  d[C_OFF.HAS_FLIP_OR_JUMP] = car.hasFlipOrJump ? 1 : 0;
  d[C_OFF.IS_BOOSTING] = car.activeFlags.boostActive || car.controls.boost ? 1 : 0;
  d[C_OFF.IS_FLIPPING] = car.activeFlags.dodgeActive ? 1 : 0;
  const steer = (Number(car.controls.steer) || 0) * 0.5235988;
  for (let w = 0; w < 4; w++) {
    const wb = C_OFF.WHEELS + w * 3;
    d[wb] = car.isOnGround ? 18.0 : 35.0; d[wb + 1] = w < 2 ? steer : 0; d[wb + 2] = car.isOnGround ? 1 : 0;
  }
  d[C_OFF.GROUND_NORMAL + 2] = 1;
}

const findCar = (cars: readonly RLRCCarFrameState120Hz[], s: number): RLRCCarFrameState120Hz | null =>
  (s < cars.length && cars[s]?.slotIndex === s ? cars[s] : cars.find((c) => c.slotIndex === s)) || null;

function writeBoostPads(cds: Float32Array | ArrayLike<number> | undefined, buf: Float32Array): void {
  const n = Math.min(RLRC_BOOST_PAD_COUNT, cds?.length || 0);
  for (let i = 0; i < RLRC_BOOST_PAD_COUNT; i++) {
    const off = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
    if (off + 1 >= buf.length) break;
    const cd = i < n ? Math.max(0, Number(cds![i]) || 0) : 0;
    buf[off + BOOST_PAD_OFFSETS.IS_ACTIVE] = cd <= 1e-4 ? 1 : 0;
    buf[off + BOOST_PAD_OFFSETS.COOLDOWN] = cd;
  }
}

export function buildCompactSnapshotFromRLRCFrame(
  frame: RLRCFrame120Hz,
  out: Float32Array = new Float32Array(RLRC_STATE_FLOATS_PER_FRAME)
): Float32Array {
  out.fill(0);
  let maxSlot = 1;
  for (const c of frame.cars) if (c?.entityActive && c.slotIndex >= 0 && c.slotIndex < MAX_CARS) maxSlot = Math.max(maxSlot, c.slotIndex + 1);
  out[SIM_OFFSETS.TICK] = Math.max(16, frame.frameIndex120Hz + 16);
  out[SIM_OFFSETS.NUM_CARS] = maxSlot;
  out[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;
  writeBallFrameToSlice(frame.ball, out.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE));
  for (let s = 0; s < MAX_CARS; s++) {
    const off = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE, slice = out.subarray(off, off + CAR_STATE_STRIDE), cf = findCar(frame.cars, s);
    if (cf) writeCarFrameToSlice(cf, slice); else writeParkedCarSlice(s, slice);
  }
  writeBoostPads(frame.boostPadCooldowns, out);
  out[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] = !frame.ball.entityActive || frame.ball.rigidBody.sleeping ? 1 : 0;
  return out;
}

export class RLRCPlaybackSyncApplier {
  private readonly _roster = new Map<number, RLRCPlayerSlotMeta>();
  private readonly _active = new Uint8Array(MAX_CARS);
  private readonly _ballBuf = new Float32Array(BALL_STATE_STRIDE);
  private readonly _carBuf = new Float32Array(CAR_STATE_STRIDE);
  private _prevBuf: Float32Array | null = null;
  private _currBuf: Float32Array | null = null;
  private _lastBallAct: boolean | null = null;
  private _lastFrame = -1;

  public configureRoster(roster: readonly RLRCPlayerSlotMeta[], rt: RLRCPlaybackRuntimePort | null): void {
    this._roster.clear(); this.resetLifecycleTracking();
    for (const m of roster) if (m.slotIndex >= 0 && m.slotIndex < RLRC_MAX_PLAYER_SLOTS) this._roster.set(m.slotIndex, m);
    const sim = rt?.physics, a = rt?.arena;
    if (sim) for (let s = MAX_CARS - 1; s >= 0; s--) if (sim.isCarSlotActive?.(s)) sim.removeCar?.(s);
    if (a?.cars) for (let s = 0; s < a.cars.length; s++) this._resetCarVis(a, s, false);
    this._syncBallVis(a, true, true); a?.resetBoostPads?.();
  }

  public resetLifecycleTracking(): void {
    this._active.fill(0); this._lastBallAct = null; this._lastFrame = -1;
    this._prevBuf?.fill(0); this._currBuf?.fill(0);
  }

  public getLastAppliedFrameIndex = (): number => this._lastFrame;
  public isSlotCurrentlyActive = (s: number): boolean => s >= 0 && s < MAX_CARS && this._active[s] === 1;

  private _syncBallVis(a: RLRCPlaybackArenaPort | null | undefined, vis: boolean, rst: boolean): void {
    if (!a) return;
    if (a.ball) a.ball.visible = vis;
    if (a.indicatorRing) a.indicatorRing.visible = vis;
    if (a.indicatorHeightRing) a.indicatorHeightRing.visible = vis;
    if (rst) a.ballSpeedTrail?.reset?.();
  }

  private _resetCarVis(a: RLRCPlaybackArenaPort | null | undefined, s: number, vis: boolean, stopDemo = true): void {
    if (!a) return;
    if (a.cars?.[s]) a.cars[s]!.visible = vis;
    if (!vis) a.resetCarBoosts?.(s);
    if (stopDemo) a.carDemolitions?.[s]?.stop?.();
    a.supersonicWheelTrailSystem?.resetCar?.(s);
  }

  private _spawnSlot(s: number, rt: RLRCPlaybackRuntimePort, m: RLRCPlayerSlotMeta | undefined): void {
    const t = m?.team === 1 ? 1 : 0, hb = m?.hitboxId || 'hitbox-octane', vis = m?.visualId || 'fennec', col = m?.primaryColorHex || TEAM_HEX[t];
    rt.physics?.addCarAtSlot?.(s, t, hb); rt.physics?.setCarTeam?.(s, t); rt.physics?.setCarHitbox?.(s, hb);
    const a = rt.arena;
    if (!a) return;
    if (s === 1) void a.ensureOpponent?.();
    a.ensureCar?.(s, t, vis); a.setCarTeam?.(s, t); a.setCarColor?.(s, col);
    a.setCarLoadout?.(s, { name: m?.userName || `Player ${s + 1}`, colorHex: col });
    this._resetCarVis(a, s, true, true);
  }

  private _despawnSlot(s: number, rt: RLRCPlaybackRuntimePort, cf: RLRCCarFrameState120Hz | null): void {
    const sim = rt.physics, off = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE;
    if (sim?.isCarSlotActive?.(s)) sim.removeCar?.(s);
    if (sim?.state && off + CAR_STATE_STRIDE <= sim.state.length) {
      const dst = sim.state.subarray(off, off + CAR_STATE_STRIDE);
      if (cf && this._roster.has(s)) writeCarFrameToSlice(cf, dst); else writeParkedCarSlice(s, dst);
    }
    sim?.setControls?.(s, NEUTRAL_CTRL);
    this._resetCarVis(rt.arena, s, false, false);
  }

  public applyFrame120Hz(frame: RLRCFrame120Hz, rt: RLRCPlaybackRuntimePort | null, opts: RLRCFrameSyncOptions = {}): RLRCFrameSyncSummary {
    let activeSlotMask = 0, spawnedSlotMask = 0, removedSlotMask = 0, activeCarCount = 0;
    if (!rt?.physics) return { frameIndex120Hz: frame.frameIndex120Hz, activeSlotMask, spawnedSlotMask, removedSlotMask, activeCarCount };
    const sim = rt.physics, arena = rt.arena, exMask = opts.excludedSlotMask ?? 0, optPov = opts.activePovSlotIndex;
    const povSlot = typeof optPov === 'number' && optPov >= 0 ? optPov : Math.max(0, rt.playerCarIndex ?? 0);
    if (typeof optPov === 'number' && optPov >= 0) { rt.playerCarIndex = optPov; if (arena) arena.playerCarIndex = optPov; }
    if (rt.keyboard?.ballControlEnabled) rt.keyboard.ballControlEnabled = false;

    const ballAct = Boolean(frame.ball.entityActive), ballChanged = this._lastBallAct !== null && this._lastBallAct !== ballAct;
    this._lastBallAct = ballAct;

    if (opts.syncBall !== false) {
      writeBallFrameToSlice(frame.ball, this._ballBuf);
      sim.setBallState?.(this._ballBuf);
      if (sim.state.length >= SIM_OFFSETS.BALL + BALL_STATE_STRIDE) sim.state.set(this._ballBuf, SIM_OFFSETS.BALL);
      if (sim.state.length > EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING) {
        sim.state[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] = !ballAct || frame.ball.rigidBody.sleeping ? 1 : 0;
      }
      this._syncBallVis(arena, ballAct, !ballAct || ballChanged);
    }

    let maxSlot = Math.max(1, this._roster.size), povCtrl: RLRCSynthesizedCarControls = NEUTRAL_CTRL;
    for (let s = 0; s < RLRC_MAX_PLAYER_SLOTS; s++) {
      if ((exMask & (1 << s)) !== 0) {
        if (sim.isCarSlotActive?.(s)) { activeSlotMask |= 1 << s; activeCarCount++; maxSlot = Math.max(maxSlot, s + 1); }
        continue;
      }
      const cf = findCar(frame.cars, s), wantAct = Boolean(cf?.entityActive);
      const wasAct = this._active[s] === 1 && (sim.isCarSlotActive?.(s) ?? true);

      if (wantAct && !wasAct) {
        this._spawnSlot(s, rt, this._roster.get(s));
        this._active[s] = 1; spawnedSlotMask |= 1 << s;
      } else if (!wantAct && (wasAct || (sim.isCarSlotActive?.(s) ?? false))) {
        this._despawnSlot(s, rt, cf);
        this._active[s] = 0; removedSlotMask |= 1 << s;
      }

      if (wantAct && cf) {
        const ctrl = cf.controls || NEUTRAL_CTRL;
        writeCarFrameToSlice(cf, this._carBuf);
        sim.setCarState?.(s, this._carBuf);
        const off = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE;
        if (sim.state.length >= off + CAR_STATE_STRIDE) sim.state.set(this._carBuf, off);
        sim.setControls?.(s, ctrl);
        if (s === povSlot) povCtrl = ctrl;
        if (arena?.cars?.[s]) arena.cars[s]!.visible = true;
        activeSlotMask |= 1 << s; activeCarCount++; maxSlot = Math.max(maxSlot, s + 1);
      }
    }

    if ((exMask & (1 << povSlot)) === 0) {
      if (rt.playerControls && typeof rt.playerControls === 'object') Object.assign(rt.playerControls, povCtrl);
      else rt.playerControls = { ...povCtrl };
      rt.playerThrottle = Number(povCtrl.throttle) || 0;
    }

    sim.state[SIM_OFFSETS.TICK] = Math.max(16, frame.frameIndex120Hz + 16);
    sim.state[SIM_OFFSETS.NUM_CARS] = maxSlot;
    sim.state[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;
    if (opts.syncBoostPads !== false && frame.boostPadCooldowns) this.applyBoostPadCooldowns(frame.boostPadCooldowns, sim.state);

    const len = sim.state.length;
    if (!this._prevBuf || this._prevBuf.length !== len) { this._prevBuf = new Float32Array(len); this._currBuf = new Float32Array(len); }
    const prev = this._prevBuf, curr = this._currBuf!;
    const canInterp = Boolean(opts.smoothStep) && this._lastFrame >= 0 && Math.abs(frame.frameIndex120Hz - this._lastFrame) <= 4;

    if (canInterp) {
      if (frame.frameIndex120Hz !== this._lastFrame) prev.set(curr);
      curr.set(sim.state);
      if (ballChanged && SIM_OFFSETS.BALL + BALL_STATE_STRIDE <= prev.length) {
        prev.set(curr.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE), SIM_OFFSETS.BALL);
      }
      const changed = spawnedSlotMask | removedSlotMask;
      for (let s = 0; changed !== 0 && s < RLRC_MAX_PLAYER_SLOTS; s++) {
        if ((changed & (1 << s)) !== 0) {
          const off = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE;
          if (off + CAR_STATE_STRIDE <= prev.length) prev.set(curr.subarray(off, off + CAR_STATE_STRIDE), off);
        }
      }
    } else {
      prev.set(sim.state); curr.set(sim.state);
    }

    const interp = rt.interpolator;
    if (interp) {
      interp.prevState.set(prev.subarray(0, Math.min(interp.prevState.length, prev.length)));
      interp.currState.set(curr.subarray(0, Math.min(interp.currState.length, curr.length)));
      if (!canInterp) interp.alpha = 0;
    }
    this._lastFrame = frame.frameIndex120Hz;
    return { frameIndex120Hz: frame.frameIndex120Hz, activeSlotMask, spawnedSlotMask, removedSlotMask, activeCarCount };
  }

  public applyBoostPadCooldowns(cds: Float32Array | ArrayLike<number>, buf: Float32Array): void { writeBoostPads(cds, buf); }
}
