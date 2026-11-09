/**
 * RLRCPlaybackSyncApplier.ts
 * Stateful 120Hz physics state, slot lifecycle, and HUD POV slot synchronizer for RLRC Replay playback.
 */

import {
  SIM_OFFSETS,
  BALL_STATE_STRIDE,
  CAR_STATE_STRIDE,
  EXTENDED_STATE_OFFSETS,
  MAX_CARS,
  NUM_BOOST_PADS,
} from '../../../physics/RocketSimConstants.ts';
import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCPlayerSlotMeta,
  type RLRCSynthesizedCarControls,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
import {
  NEUTRAL_RLRC_CAR_CONTROLS,
  computeRLRCTeamSlotKeyMapping,
  findRLRCCarBySlot,
  writeBallFrameToSlice,
  writeBoostPadCooldownsToStateBuffer,
  writeCarFrameToSlice,
  writeParkedCarSlice,
  type RLRCPovSlotResolution,
} from './RLRCFrameStateSliceWriter.ts';

export type { RLRCPovSlotResolution } from './RLRCFrameStateSliceWriter.ts';

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
  _lastHudSlotCarMap?: Record<number, number> | null;
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

const DEFAULT_TEAM_HEX: readonly [string, string] = ['#38bdf8', '#fb923c'];

export class RLRCPlaybackSyncApplier {
  private readonly _rosterBySlot = new Map<number, RLRCPlayerSlotMeta>();
  private _orderedRoster: readonly RLRCPlayerSlotMeta[] = [];
  private _slotKeyToCarIndex: Record<number, number> = {};
  private _carIndexToSlotKey: Record<number, number> = {};
  private readonly _activeSlotFlags = new Uint8Array(MAX_CARS);
  private readonly _scratchBallSlice = new Float32Array(BALL_STATE_STRIDE);
  private readonly _scratchCarSlice = new Float32Array(CAR_STATE_STRIDE);
  private _prevStateBuffer: Float32Array | null = null;
  private _currStateBuffer: Float32Array | null = null;
  private _lastBallActive: boolean | null = null;
  private _lastAppliedFrameIndex = -1;

  public configureRoster(
    roster: readonly RLRCPlayerSlotMeta[],
    runtime: RLRCPlaybackRuntimePort | null
  ): void {
    this._rosterBySlot.clear();
    this._orderedRoster = roster;
    this.resetLifecycleTracking();
    for (const meta of roster) {
      if (meta.slotIndex >= 0 && meta.slotIndex < RLRC_MAX_PLAYER_SLOTS) {
        this._rosterBySlot.set(meta.slotIndex, meta);
      }
    }
    const defaultTeam: RLRCTeamIndex = roster[0]?.team === 1 ? 1 : 0;
    const mapping = computeRLRCTeamSlotKeyMapping(roster, defaultTeam);
    this._slotKeyToCarIndex = mapping.slotKeyToCarIndex;
    this._carIndexToSlotKey = mapping.carIndexToSlotKey;
    if (runtime) runtime._lastHudSlotCarMap = mapping.slotKeyToCarIndex;

    const sim = runtime?.physics;
    const arena = runtime?.arena;
    if (sim) {
      for (let slot = MAX_CARS - 1; slot >= 0; slot--) {
        if (sim.isCarSlotActive?.(slot)) sim.removeCar?.(slot);
      }
    }
    if (arena?.cars) {
      for (let slot = 0; slot < arena.cars.length; slot++) {
        this._resetCarVisibility(arena, slot, false);
      }
    }
    this._syncBallVisibility(arena, true, true);
    arena?.resetBoostPads?.();
  }

  public resolvePovSlotForHudKey(
    slotKey: number,
    runtime?: RLRCPlaybackRuntimePort | null
  ): RLRCPovSlotResolution | null {
    if (this._orderedRoster.length === 0) return null;
    const clampedKey = Math.max(1, Math.min(6, Math.round(slotKey) || 1)) as 1 | 2 | 3 | 4 | 5 | 6;
    const runtimeSlot = runtime?._lastHudSlotCarMap?.[clampedKey];
    const applierSlot = this._slotKeyToCarIndex[clampedKey];
    const targetSlotIndex =
      typeof runtimeSlot === 'number' && this._rosterBySlot.has(runtimeSlot)
        ? runtimeSlot
        : typeof applierSlot === 'number' && this._rosterBySlot.has(applierSlot)
          ? applierSlot
          : clampedKey - 1;
    const meta = this._rosterBySlot.get(targetSlotIndex) ?? this._orderedRoster[0];
    if (!meta) return null;

    const team: RLRCTeamIndex = meta.team === 1 ? 1 : 0;
    const updated = computeRLRCTeamSlotKeyMapping(this._orderedRoster, team);
    this._slotKeyToCarIndex = updated.slotKeyToCarIndex;
    this._carIndexToSlotKey = updated.carIndexToSlotKey;
    if (runtime) runtime._lastHudSlotCarMap = updated.slotKeyToCarIndex;
    const resolvedSlotKey = Math.max(
      1,
      Math.min(6, updated.carIndexToSlotKey[meta.slotIndex] ?? clampedKey)
    ) as 1 | 2 | 3 | 4 | 5 | 6;

    return {
      slotIndex: meta.slotIndex,
      slotKey: resolvedSlotKey,
      team,
      slotKeyToCarIndex: updated.slotKeyToCarIndex,
      carIndexToSlotKey: updated.carIndexToSlotKey,
    };
  }

  public getSlotKeyForCarIndex(slotIndex: number): 1 | 2 | 3 | 4 | 5 | 6 {
    const mapped = this._carIndexToSlotKey[slotIndex];
    return Math.max(1, Math.min(6, mapped ?? slotIndex + 1)) as 1 | 2 | 3 | 4 | 5 | 6;
  }

  public resetLifecycleTracking(): void {
    this._activeSlotFlags.fill(0);
    this._lastBallActive = null;
    this._lastAppliedFrameIndex = -1;
    this._prevStateBuffer?.fill(0);
    this._currStateBuffer?.fill(0);
  }

  public getLastAppliedFrameIndex = (): number => this._lastAppliedFrameIndex;
  public isSlotCurrentlyActive = (slot: number): boolean =>
    slot >= 0 && slot < MAX_CARS && this._activeSlotFlags[slot] === 1;

  private _syncBallVisibility(
    arena: RLRCPlaybackArenaPort | null | undefined,
    visible: boolean,
    resetTrail: boolean
  ): void {
    if (!arena) return;
    if (arena.ball) arena.ball.visible = visible;
    if (arena.indicatorRing) arena.indicatorRing.visible = visible;
    if (arena.indicatorHeightRing) arena.indicatorHeightRing.visible = visible;
    if (resetTrail) arena.ballSpeedTrail?.reset?.();
  }

  private _resetCarVisibility(
    arena: RLRCPlaybackArenaPort | null | undefined,
    slot: number,
    visible: boolean,
    stopDemolition = true
  ): void {
    if (!arena) return;
    if (arena.cars?.[slot]) arena.cars[slot]!.visible = visible;
    if (!visible) arena.resetCarBoosts?.(slot);
    if (stopDemolition) arena.carDemolitions?.[slot]?.stop?.();
    arena.supersonicWheelTrailSystem?.resetCar?.(slot);
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
    if (!arena) return;
    if (slot === 1) void arena.ensureOpponent?.();
    arena.ensureCar?.(slot, team, visualId);
    arena.setCarTeam?.(slot, team);
    arena.setCarColor?.(slot, colorHex);
    arena.setCarLoadout?.(slot, { name: meta?.userName || `Player ${slot + 1}`, colorHex });
    this._resetCarVisibility(arena, slot, true, true);
  }

  private _despawnSlotEntity(
    slot: number,
    runtime: RLRCPlaybackRuntimePort,
    carFrame: RLRCCarFrameState120Hz | null
  ): void {
    const sim = runtime.physics;
    const offset = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
    if (sim?.isCarSlotActive?.(slot)) sim.removeCar?.(slot);
    if (sim?.state && offset + CAR_STATE_STRIDE <= sim.state.length) {
      const dst = sim.state.subarray(offset, offset + CAR_STATE_STRIDE);
      if (carFrame && this._rosterBySlot.has(slot)) writeCarFrameToSlice(carFrame, dst);
      else writeParkedCarSlice(slot, dst);
    }
    sim?.setControls?.(slot, NEUTRAL_RLRC_CAR_CONTROLS);
    this._resetCarVisibility(runtime.arena, slot, false, false);
  }

  public applyFrame120Hz(
    frame: RLRCFrame120Hz,
    runtime: RLRCPlaybackRuntimePort | null,
    options: RLRCFrameSyncOptions = {}
  ): RLRCFrameSyncSummary {
    let activeSlotMask = 0;
    let spawnedSlotMask = 0;
    let removedSlotMask = 0;
    let activeCarCount = 0;
    if (!runtime?.physics) {
      return {
        frameIndex120Hz: frame.frameIndex120Hz,
        activeSlotMask,
        spawnedSlotMask,
        removedSlotMask,
        activeCarCount,
      };
    }

    const sim = runtime.physics;
    const arena = runtime.arena;
    const excludedMask = options.excludedSlotMask ?? 0;
    const explicitPov = options.activePovSlotIndex;
    const povSlot =
      typeof explicitPov === 'number' && explicitPov >= 0
        ? explicitPov
        : Math.max(0, runtime.playerCarIndex ?? 0);
    if (typeof explicitPov === 'number' && explicitPov >= 0) {
      runtime.playerCarIndex = explicitPov;
      if (arena) arena.playerCarIndex = explicitPov;
    }
    if (runtime.keyboard?.ballControlEnabled) runtime.keyboard.ballControlEnabled = false;

    const ballActive = Boolean(frame.ball.entityActive);
    const ballChanged = this._lastBallActive !== null && this._lastBallActive !== ballActive;
    this._lastBallActive = ballActive;

    if (options.syncBall !== false) {
      writeBallFrameToSlice(frame.ball, this._scratchBallSlice);
      sim.setBallState?.(this._scratchBallSlice);
      if (sim.state.length >= SIM_OFFSETS.BALL + BALL_STATE_STRIDE) {
        sim.state.set(this._scratchBallSlice, SIM_OFFSETS.BALL);
      }
      if (sim.state.length > EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING) {
        sim.state[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] =
          (ballActive ? 0 : 2) | (frame.ball.rigidBody.sleeping ? 1 : 0);
      }
      this._syncBallVisibility(arena, ballActive, !ballActive || ballChanged);
    }

    let maxSlot = Math.max(1, this._rosterBySlot.size);
    let povControls: RLRCSynthesizedCarControls = NEUTRAL_RLRC_CAR_CONTROLS;

    for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
      if ((excludedMask & (1 << slot)) !== 0) {
        if (sim.isCarSlotActive?.(slot)) {
          activeSlotMask |= 1 << slot;
          activeCarCount++;
          maxSlot = Math.max(maxSlot, slot + 1);
        }
        continue;
      }

      const carFrame = findRLRCCarBySlot(frame.cars, slot);
      const wantActive = Boolean(carFrame?.entityActive);
      const wasActive = this._activeSlotFlags[slot] === 1 && (sim.isCarSlotActive?.(slot) ?? true);

      if (wantActive && !wasActive) {
        this._spawnSlotEntity(slot, runtime, this._rosterBySlot.get(slot));
        this._activeSlotFlags[slot] = 1;
        spawnedSlotMask |= 1 << slot;
      } else if (!wantActive && (wasActive || (sim.isCarSlotActive?.(slot) ?? false))) {
        this._despawnSlotEntity(slot, runtime, carFrame);
        this._activeSlotFlags[slot] = 0;
        removedSlotMask |= 1 << slot;
      }

      if (wantActive && carFrame) {
        const controls = carFrame.controls || NEUTRAL_RLRC_CAR_CONTROLS;
        writeCarFrameToSlice(carFrame, this._scratchCarSlice);
        sim.setCarState?.(slot, this._scratchCarSlice);
        const offset = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
        if (sim.state.length >= offset + CAR_STATE_STRIDE) {
          sim.state.set(this._scratchCarSlice, offset);
        }
        sim.setControls?.(slot, controls);
        if (slot === povSlot) povControls = controls;
        if (arena?.cars?.[slot]) arena.cars[slot]!.visible = true;
        activeSlotMask |= 1 << slot;
        activeCarCount++;
        maxSlot = Math.max(maxSlot, slot + 1);
      }
    }

    if ((excludedMask & (1 << povSlot)) === 0) {
      if (runtime.playerControls && typeof runtime.playerControls === 'object') {
        Object.assign(runtime.playerControls, povControls);
      } else {
        runtime.playerControls = { ...povControls };
      }
      runtime.playerThrottle = Number(povControls.throttle) || 0;
    }

    sim.state[SIM_OFFSETS.TICK] = Math.max(16, frame.frameIndex120Hz + 16);
    sim.state[SIM_OFFSETS.NUM_CARS] = maxSlot;
    sim.state[SIM_OFFSETS.NUM_PADS] = NUM_BOOST_PADS;
    if (options.syncBoostPads !== false && frame.boostPadCooldowns) {
      this.applyBoostPadCooldowns(frame.boostPadCooldowns, sim.state);
    }

    const stateLength = sim.state.length;
    if (!this._prevStateBuffer || this._prevStateBuffer.length !== stateLength) {
      this._prevStateBuffer = new Float32Array(stateLength);
      this._currStateBuffer = new Float32Array(stateLength);
    }
    const prev = this._prevStateBuffer;
    const curr = this._currStateBuffer!;
    const canInterpolate =
      Boolean(options.smoothStep) &&
      this._lastAppliedFrameIndex >= 0 &&
      Math.abs(frame.frameIndex120Hz - this._lastAppliedFrameIndex) <= 4;

    if (canInterpolate) {
      if (frame.frameIndex120Hz !== this._lastAppliedFrameIndex) prev.set(curr);
      curr.set(sim.state);
      if (ballChanged && SIM_OFFSETS.BALL + BALL_STATE_STRIDE <= prev.length) {
        prev.set(
          curr.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE),
          SIM_OFFSETS.BALL
        );
      }
      const changedMask = spawnedSlotMask | removedSlotMask;
      for (let slot = 0; changedMask !== 0 && slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
        if ((changedMask & (1 << slot)) !== 0) {
          const offset = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
          if (offset + CAR_STATE_STRIDE <= prev.length) {
            prev.set(curr.subarray(offset, offset + CAR_STATE_STRIDE), offset);
          }
        }
      }
    } else {
      prev.set(sim.state);
      curr.set(sim.state);
    }

    const interpolator = runtime.interpolator;
    if (interpolator) {
      interpolator.prevState.set(
        prev.subarray(0, Math.min(interpolator.prevState.length, prev.length))
      );
      interpolator.currState.set(
        curr.subarray(0, Math.min(interpolator.currState.length, curr.length))
      );
      if (!canInterpolate) interpolator.alpha = 0;
    }

    this._lastAppliedFrameIndex = frame.frameIndex120Hz;
    return {
      frameIndex120Hz: frame.frameIndex120Hz,
      activeSlotMask,
      spawnedSlotMask,
      removedSlotMask,
      activeCarCount,
    };
  }

  public applyBoostPadCooldowns(
    cooldowns: Float32Array | ArrayLike<number>,
    stateBuffer: Float32Array
  ): void {
    writeBoostPadCooldownsToStateBuffer(cooldowns, stateBuffer);
  }
}
