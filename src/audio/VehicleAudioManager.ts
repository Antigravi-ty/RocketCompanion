import { audioConfig } from '../ui-core/config/audioConfig.ts';
import { subsystemState } from './audioContext.ts';
import { isBallFlipResetEvent } from '../physics/RocketSimConstants.ts';
import { type SpatialPositionInput } from './SpatialAudioSource.ts';
import { VehicleAudioEmitter } from './VehicleAudioEmitter.ts';
import { createEmptyWasmCarAudioCue, readWasmCarAudioCue } from './WasmAudioDirectorBridge.ts';

export interface PhysicsImpactAudioEvent extends SpatialPositionInput {
  type?: number | string;
  subType?: number | string;
  actionSubType?: number;
  surfaceTag?: number | string;
  isCrossbar?: boolean;
  normalRelVel?: number;
  impulse?: number;
  speed?: number;
  relSpeed?: number;
  carIndex?: number;
  car1Index?: number;
  car2Index?: number;
  primaryId?: number;
  secondaryId?: number;
  padIndex?: number;
  isBig?: boolean;
  isSupersonic?: boolean;
  carPosX?: number;
  carPosY?: number;
  carPosZ?: number;
}

export const INCIDENT_COOLDOWN_MS = Object.freeze({
  GOAL_SCORED: 2500,
  CAR_CAR_DEMO: 90,
  CAR_CAR_BUMP_PAIR: 65,
  CAR_CAR_BUMP_GLOBAL: 35,
  BOOST_PICKUP_PER_PAD: 150,
  WHEEL_LANDING_PER_CAR: 140,
  BOOST_EDGE_PER_CAR: 45,
  JUMP_ACTION_PER_CAR: 45,
  SUPERSONIC_ENTER_PER_CAR: 250,
  FLIP_RESET_PER_CAR: 500,
});

function calibrateWheelLandingModulation(downwardSpeedUU: number, isSelf: boolean) {
  const x = Math.max(0, Math.min(1, (Math.max(0, Math.abs(downwardSpeedUU)) - 180) / 1350));
  const intensity = x * x * (3 - 2 * x);
  return {
    category: 'wheel_landing' as const,
    volumeGainMultiplier: Math.max(
      0.35,
      Math.min(1.15, (0.45 + 0.6 * intensity) * (isSelf ? 1.0 : 0.88))
    ),
    distanceRadiusScale: Math.max(0.65, Math.min(1.2, 0.7 + 0.45 * intensity)),
    playbackRate: Math.max(0.92, Math.min(1.08, 0.94 + 0.12 * (1.0 - 0.5 * intensity))),
    priority: isSelf ? 4 : 2,
    normalizedIntensity: intensity,
  };
}

export interface VehicleAudioBuffers {
  jump: Array<AudioBuffer | null>;
  doubleJump: Array<AudioBuffer | null>;
  dodge: Array<AudioBuffer | null>;
  boostStart: AudioBuffer | null;
  boostLoop: AudioBuffer | null;
  boostRelease: AudioBuffer | null;
  supersonicEnter: Array<AudioBuffer | null>;
  supersonicLoop: AudioBuffer | null;
  reset: AudioBuffer | null;
  wheelImpact: Array<AudioBuffer | null>;
  carCollision: AudioBuffer | null;
  vehicleDetail: Array<AudioBuffer | null>;
}

export interface VehicleCarStateSnapshot {
  isBoosting?: boolean;
  isSupersonic?: boolean;
  isDemoed?: boolean;
  isOnGround?: boolean;
  velZ?: number;
  airTime?: number;
  getWheelContact?: (wheelIndex: number) => boolean;
}

export interface VehicleLandingTrackingState {
  wasGrounded: boolean;
  peakDownwardSpeedUU: number;
  airborneTicks: number;
}

export interface VehicleAudioUpdateContext {
  activeCarIndex?: number;
  numCars?: number;
  getCarPos?: ((carIndex: number) => SpatialPositionInput | null | undefined) | null;
  getCarState?: ((carIndex: number) => VehicleCarStateSnapshot | null | undefined) | null;
  isMatchActive?: boolean;
  hasBlockingOverlay?: boolean;
  continueOnBlur?: boolean;
  isHidden?: boolean;
}

export class VehicleAudioManager {
  _cd = new Map<number, number>();
  _lastBoostEdgeMsByCar = this._cd;
  _lastFlipResetMsByCar = this._cd;
  _lastJumpActionMsByCar = this._cd;
  _lastSupersonicEnterMsByCar = this._cd;
  _lastWheelLandingMsByCar = this._cd;
  _landingStateByCar = new Map<number, VehicleLandingTrackingState>();
  activeCarIndex = 0;
  buffers: VehicleAudioBuffers = {
    jump: [],
    doubleJump: [],
    dodge: [],
    boostStart: null,
    boostLoop: null,
    boostRelease: null,
    supersonicEnter: [],
    supersonicLoop: null,
    reset: null,
    wheelImpact: [],
    carCollision: null,
    vehicleDetail: [],
  };
  carBoostVariations = new Map<number, string>();
  emitters = new Map<number, VehicleAudioEmitter>();
  _lastIdx = [-1, -1, -1, -1, -1];

  private _resolveBoost(carIndex: number) {
    const bufs = subsystemState?.buffers;
    const varId = this.carBoostVariations.get(carIndex);
    if (varId && bufs) {
      return {
        boostStart: bufs.get(`boost_${varId}_start`) || this.buffers.boostStart,
        boostLoop: bufs.get(`boost_${varId}_loop`) || this.buffers.boostLoop,
        boostRelease: bufs.get(`boost_${varId}_end`) || this.buffers.boostRelease,
      };
    }
    return this.buffers;
  }

  setCarBoostAudioVariation(carIndex: number, variationId: string | null = null): void {
    if (typeof carIndex !== 'number' || carIndex < 0) return;
    if (variationId?.trim()) this.carBoostVariations.set(carIndex, variationId.trim());
    else this.carBoostVariations.delete(carIndex);
    this.emitters
      .get(carIndex)
      ?.setBuffers(this._resolveBoost(carIndex).boostLoop, this.buffers.supersonicLoop);
  }

  getEmitter(carIndex = 0): VehicleAudioEmitter {
    let em = this.emitters.get(carIndex);
    if (!em) {
      em = new VehicleAudioEmitter(carIndex);
      em.setSelf(carIndex === this.activeCarIndex);
      em.setBuffers(this._resolveBoost(carIndex).boostLoop, this.buffers.supersonicLoop);
      this.emitters.set(carIndex, em);
    }
    return em;
  }

  updatePanningModel(model: PanningModelType | null | undefined): void {
    if (!model) return;
    for (const e of this.emitters.values()) {
      if (e?.panner3D) {
        try {
          e.panner3D.panningModel = model;
        } catch {
          /* ignore */
        }
      }
    }
  }

  setBuffers(bufs: Partial<VehicleAudioBuffers> = {}): void {
    this.buffers = { ...this.buffers, ...bufs };
    for (const [idx, e] of this.emitters.entries()) {
      e.setBuffers(this._resolveBoost(idx).boostLoop, this.buffers.supersonicLoop);
    }
  }

  private _okCd(slot: number, car: number, now: number, ms: number): boolean {
    const key = slot * 64 + car;
    if (now - (this._cd.get(key) ?? -Infinity) < ms) return false;
    this._cd.set(key, now);
    return true;
  }

  private _pick(slot: number, list: Array<AudioBuffer | null>): AudioBuffer | null {
    if (!list.length) return null;
    let idx = Math.floor(Math.random() * list.length);
    if (list.length > 1 && idx === this._lastIdx[slot]) idx = (idx + 1) % list.length;
    this._lastIdx[slot] = idx;
    return list[idx] ?? null;
  }

  private readonly _cueScratch = createEmptyWasmCarAudioCue();

  applyWasmFrame(
    f32: Float32Array,
    u32: Uint32Array,
    cueWordBase: number,
    activeCarIndex: number,
    effectiveNumCars: number,
    audible: boolean,
    getCarPos?: ((carIndex: number) => SpatialPositionInput | null | undefined) | null
  ): void {
    this.activeCarIndex = activeCarIndex;
    const total = Math.max(1, effectiveNumCars);
    for (let i = 0; i < total; i++) {
      const em = this.getEmitter(i);
      em.setSelf(i === activeCarIndex);
      const pos = getCarPos?.(i);
      if (pos) em.updatePosition(pos);
      const cue = readWasmCarAudioCue(f32, u32, cueWordBase, i, this._cueScratch);
      em.applyWasmState(cue.boostGain, cue.boostPitch, cue.supersonicGain, cue.active, audible);
    }
  }

  update(ctx: VehicleAudioUpdateContext): void {
    const active = ctx.activeCarIndex ?? 0;
    this.activeCarIndex = active;
    const audible =
      !ctx.hasBlockingOverlay &&
      Boolean(ctx.isMatchActive ?? true) &&
      (!ctx.isHidden || Boolean(ctx.continueOnBlur));
    const total = Math.max(1, ctx.numCars ?? 1);

    for (let i = 0; i < total; i++) {
      const em = this.getEmitter(i);
      em.setSelf(i === active);
      const pos = ctx.getCarPos?.(i);
      if (pos) em.updatePosition(pos);
      const st = ctx.getCarState?.(i);
      const alive = !st?.isDemoed;
      em.updateState(Boolean(st?.isBoosting), Boolean(st?.isSupersonic), alive, audible);

      if (st && alive && audible) {
        const grounded = Boolean(
          st.isOnGround ||
          st.getWheelContact?.(0) ||
          st.getWheelContact?.(1) ||
          st.getWheelContact?.(2) ||
          st.getWheelContact?.(3)
        );
        let ls = this._landingStateByCar.get(i);
        if (!ls) {
          ls = { wasGrounded: grounded, peakDownwardSpeedUU: 0, airborneTicks: 0 };
          this._landingStateByCar.set(i, ls);
        }
        if (!grounded) {
          ls.wasGrounded = false;
          ls.airborneTicks++;
          ls.peakDownwardSpeedUU = Math.max(ls.peakDownwardSpeedUU, -(st.velZ ?? 0));
        } else {
          if (!ls.wasGrounded && ls.airborneTicks >= 6 && ls.peakDownwardSpeedUU >= 220) {
            this.handleCarEvent({
              type: 'wheel_impact',
              carIndex: i,
              speed: ls.peakDownwardSpeedUU,
            });
          }
          ls.wasGrounded = true;
          ls.peakDownwardSpeedUU = 0;
          ls.airborneTicks = 0;
        }
      }
    }
  }

  handleCarEvent(event: PhysicsImpactAudioEvent | null | undefined): void {
    if (!event) return;
    const t = event.type;
    if (t === 0x05 || t === 'car_action') {
      const sub = Number(event.actionSubType ?? event.subType ?? 0);
      if (sub >= 1 && sub <= 3) this.handleCarEvent({ ...event, type: 0x05 + sub });
      return;
    }
    const rawCar = event.carIndex ?? event.primaryId ?? 0;
    const car = rawCar === 65535 ? 0 : rawCar;
    const em = this.getEmitter(car);
    if (event.carPosX !== undefined && event.carPosY !== undefined && event.carPosZ !== undefined) {
      em.updatePosition({ posX: event.carPosX, posY: event.carPosY, posZ: event.carPosZ });
    } else if (event.posX !== undefined || event.x !== undefined) {
      em.updatePosition(event);
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const base =
      (audioConfig.get('masterVolume') ?? 1.0) *
      (em.isSelf ? (audioConfig.get('vehicleSelfVolume') ?? 1.0) : 1.0);
    const cd = INCIDENT_COOLDOWN_MS;

    if (
      t === 0x06 ||
      t === 'car_jump' ||
      t === 0x07 ||
      t === 'car_double_jump' ||
      t === 0x08 ||
      t === 'car_dodge'
    ) {
      const k = t === 0x08 || t === 'car_dodge' ? 2 : t === 0x07 || t === 'car_double_jump' ? 1 : 0;
      if (!this._okCd(k, car, now, cd.JUMP_ACTION_PER_CAR)) return;
      const list =
        k === 2 ? this.buffers.dodge : k === 1 ? this.buffers.doubleJump : this.buffers.jump;
      const vol =
        (audioConfig.get(k === 2 ? 'dodgeVolume' : k === 1 ? 'doubleJumpVolume' : 'jumpVolume') ??
          1.0) * base;
      const buf = this._pick(k, list);
      if (buf) em.playAction(buf, vol, 1.0, 'jump_dodge_other');
      else
        em.playAction(
          this.buffers.carCollision,
          vol * 0.4,
          k === 2 ? 1.2 : k === 1 ? 1.7 : 1.4,
          'jump_dodge_other'
        );
    } else if (t === 0x0c || t === 'car_boost_start') {
      if (!this._okCd(3, car, now, cd.BOOST_EDGE_PER_CAR)) return;
      const { boostStart, boostLoop } = this._resolveBoost(car);
      const v =
        audioConfig.get('boostStartVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0;
      em.playAction(
        boostStart || boostLoop,
        (audioConfig.get('boostVolume') ?? 1.0) * v * base,
        1.0,
        'boost_other'
      );
    } else if (t === 0x0d || t === 'car_boost_stop') {
      const { boostRelease } = this._resolveBoost(car);
      const v =
        audioConfig.get('boostReleaseVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0;
      em.playAction(
        boostRelease,
        (audioConfig.get('boostVolume') ?? 1.0) * v * base * 0.8,
        1.0,
        'boost_other',
        0.85
      );
    } else if (t === 0x09 || t === 'car_supersonic_enter') {
      if (!this._okCd(4, car, now, cd.SUPERSONIC_ENTER_PER_CAR)) return;
      const vol =
        (audioConfig.get('supersonicEnterVolume') ?? audioConfig.get('supersonicVolume') ?? 1.0) *
        base;
      const buf = this._pick(3, this.buffers.supersonicEnter);
      em.playAction(buf || this.buffers.supersonicLoop, vol, buf ? 1.0 : 1.1, 'supersonic_other');
    } else if (t === 0x0f || t === 'flip_reset_gained') {
      if (isBallFlipResetEvent(event) && this._okCd(5, car, now, cd.FLIP_RESET_PER_CAR)) {
        em.playAction(
          this.buffers.reset,
          (audioConfig.get('flipResetVolume') ?? 1.0) * base,
          1.0,
          'flip_reset_other'
        );
      }
    } else if ((t === 0x12 || t === 'wheel_impact') && this.buffers.wheelImpact.length > 0) {
      if (!this._okCd(6, car, now, cd.WHEEL_LANDING_PER_CAR)) return;
      const spd = Math.abs(
        event.speed ?? event.relSpeed ?? event.normalRelVel ?? event.impulse ?? 500
      );
      const mod = calibrateWheelLandingModulation(spd, em.isSelf);
      em.playAction(
        this._pick(4, this.buffers.wheelImpact),
        (audioConfig.get('wheelImpactVolume') ?? 1.0) * base * mod.volumeGainMultiplier,
        mod.playbackRate,
        mod.category,
        mod.distanceRadiusScale
      );
    }
  }

  silenceAll(): void {
    for (const emitter of this.emitters.values()) emitter.silenceAll();
  }
}
