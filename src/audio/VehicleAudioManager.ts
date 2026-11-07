import { VehicleAudioEmitter } from './VehicleAudioEmitter.ts';
import { audioConfig } from '../ui-core/config/audioConfig';
import { subsystemState } from './audioContext.ts';
import {
  INCIDENT_EVENT_TYPES,
  PHYSICS_EVENT_TYPES,
  isBallFlipResetEvent
} from '../physics/RocketSimConstants.ts';
import { type AudioAttenuationCategory, type SpatialPositionInput } from './SpatialAudioSource.ts';
import { type PhysicsImpactAudioEvent } from './WorldImpactAudioHandler.ts';
import {
  INCIDENT_COOLDOWN_MS,
  calibrateWheelLandingModulation,
} from './IncidentSpatialModulator.ts';

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
  _lastBoostEdgeMsByCar: Map<number, number> = new Map();
  _lastFlipResetMsByCar: Map<number, number> | undefined;
  _lastJumpActionMsByCar: Map<number, number> = new Map();
  _lastSupersonicEnterMsByCar: Map<number, number> = new Map();
  _lastWheelLandingMsByCar: Map<number, number> = new Map();
  _landingStateByCar: Map<number, VehicleLandingTrackingState> = new Map();
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
    vehicleDetail: []
  };
  carBoostVariations: Map<number, string> = new Map();
  emitters: Map<number, VehicleAudioEmitter> = new Map();
  lastDodgeSoundIdx = -1;
  lastDoubleJumpSoundIdx = -1;
  lastJumpSoundIdx = -1;
  lastSupersonicEnterSoundIdx = -1;
  lastWheelImpactSoundIdx = -1;

  _resolveBoostBuffersForCar(carIndex: number): {
    boostStart: AudioBuffer | null;
    boostLoop: AudioBuffer | null;
    boostRelease: AudioBuffer | null;
  } {
    if (carIndex === this.activeCarIndex) {
      const startVar = audioConfig.get('boostStartVariation');
      const loopVar = audioConfig.get('boostLoopVariation');
      const endVar = audioConfig.get('boostEndVariation');
      const hasCustomPhaseMix = Boolean(startVar && loopVar && endVar && (startVar !== loopVar || loopVar !== endVar));
      if (hasCustomPhaseMix && subsystemState?.buffers) {
        return {
          boostStart: subsystemState.buffers.get(`boost_${startVar}_start`) || this.buffers.boostStart,
          boostLoop: subsystemState.buffers.get(`boost_${loopVar}_loop`) || this.buffers.boostLoop,
          boostRelease: subsystemState.buffers.get(`boost_${endVar}_end`) || this.buffers.boostRelease,
        };
      }
    }
    const varId = this.carBoostVariations.get(carIndex);
    if (varId && subsystemState?.buffers) {
      return {
        boostStart: subsystemState.buffers.get(`boost_${varId}_start`) || this.buffers.boostStart,
        boostLoop: subsystemState.buffers.get(`boost_${varId}_loop`) || this.buffers.boostLoop,
        boostRelease: subsystemState.buffers.get(`boost_${varId}_end`) || this.buffers.boostRelease,
      };
    }
    return {
      boostStart: this.buffers.boostStart,
      boostLoop: this.buffers.boostLoop,
      boostRelease: this.buffers.boostRelease
    };
  }

  setCarBoostAudioVariation(carIndex: number, variationId: string | null = null): void {
    if (typeof carIndex !== 'number' || carIndex < 0) return;
    if (typeof variationId === 'string' && variationId.trim()) {
      this.carBoostVariations.set(carIndex, variationId.trim());
    } else {
      this.carBoostVariations.delete(carIndex);
    }
    const emitter = this.emitters.get(carIndex);
    if (emitter) {
      const { boostLoop } = this._resolveBoostBuffersForCar(carIndex);
      emitter.setBuffers({ boostLoop, supersonicLoop: this.buffers.supersonicLoop });
    }
  }

  getEmitter(carIndex = 0): VehicleAudioEmitter {
    let emitter = this.emitters.get(carIndex);
    if (!emitter) {
      emitter = new VehicleAudioEmitter(carIndex);
      emitter.setSelf(carIndex === this.activeCarIndex);
      const { boostLoop } = this._resolveBoostBuffersForCar(carIndex);
      emitter.setBuffers({ boostLoop, supersonicLoop: this.buffers.supersonicLoop });
      this.emitters.set(carIndex, emitter);
    }
    return emitter;
  }

  updatePanningModel(model: PanningModelType | null | undefined): void {
    if (!model) return;
    for (const emitter of this.emitters.values()) {
      if (emitter && emitter.panner3D) {
        try {
          emitter.panner3D.panningModel = model;
        } catch (err) {
          console.warn('[VehicleAudioManager] Failed to set panningModel:', err instanceof Error ? err.message : err);
        }
      }
    }
  }

  setBuffers(bufs: Partial<VehicleAudioBuffers> = {}): void {
    Object.assign(this.buffers, bufs);
    for (const [carIndex, emitter] of this.emitters.entries()) {
      const { boostLoop } = this._resolveBoostBuffersForCar(carIndex);
      emitter.setBuffers({ boostLoop, supersonicLoop: this.buffers.supersonicLoop });
    }
  }

  private _checkCarCooldown(map: Map<number, number>, carIndex: number, nowMs: number, cooldownMs: number): boolean {
    const prevMs = map.get(carIndex) || -Infinity;
    if (nowMs - prevMs < cooldownMs) return false;
    map.set(carIndex, nowMs);
    return true;
  }

  private _pickNonRepeatingIndex(length: number, lastIdx: number): number {
    let idx = Math.floor(Math.random() * length);
    if (length > 1 && idx === lastIdx) idx = (idx + 1) % length;
    return idx;
  }

  private _playJumpFamilyAction(
    emitter: VehicleAudioEmitter,
    carIndex: number,
    nowMs: number,
    vol: number,
    list: Array<AudioBuffer | null>,
    lastIdxKey: 'lastJumpSoundIdx' | 'lastDoubleJumpSoundIdx' | 'lastDodgeSoundIdx',
    fallbackRate: number,
    category: AudioAttenuationCategory = 'jump_dodge_other'
  ): void {
    if (!this._checkCarCooldown(this._lastJumpActionMsByCar, carIndex, nowMs, INCIDENT_COOLDOWN_MS.JUMP_ACTION_PER_CAR)) {
      return;
    }
    if (list && list.length > 0) {
      const idx = this._pickNonRepeatingIndex(list.length, this[lastIdxKey]);
      this[lastIdxKey] = idx;
      emitter.playAction(list[idx], { volume: vol, category });
    } else if (this.buffers.carCollision) {
      emitter.playAction(this.buffers.carCollision, { volume: vol * 0.4, playbackRate: fallbackRate, category });
    }
  }

  update({
    activeCarIndex = 0,
    numCars = 1,
    getCarPos = null,
    getCarState = null,
    isMatchActive = true,
    hasBlockingOverlay = false,
    continueOnBlur = false,
    isHidden = false
  }: VehicleAudioUpdateContext): void {
    this.activeCarIndex = activeCarIndex;
    const totalCars = Math.max(1, numCars);
    const audible = !hasBlockingOverlay && Boolean(isMatchActive) && (!isHidden || Boolean(continueOnBlur));

    for (let i = 0; i < totalCars; i++) {
      const emitter = this.getEmitter(i);
      emitter.setSelf(i === activeCarIndex);

      if (getCarPos) {
        const pos = getCarPos(i);
        if (pos) emitter.updatePosition(pos);
      }

      const carState = getCarState ? getCarState(i) : null;
      const isBoosting = Boolean(carState?.isBoosting);
      const isSupersonic = Boolean(carState?.isSupersonic);
      const isAlive = !carState?.isDemoed;

      emitter.updateState({ isBoosting, isSupersonic, isAlive, audible });

      if (carState && isAlive && audible) {
        const isGroundedNow = Boolean(
          carState.isOnGround ||
          (typeof carState.getWheelContact === 'function' &&
            (carState.getWheelContact(0) ||
              carState.getWheelContact(1) ||
              carState.getWheelContact(2) ||
              carState.getWheelContact(3)))
        );
        let landingSt = this._landingStateByCar.get(i);
        if (!landingSt) {
          landingSt = { wasGrounded: isGroundedNow, peakDownwardSpeedUU: 0, airborneTicks: 0 };
          this._landingStateByCar.set(i, landingSt);
        }
        if (!isGroundedNow) {
          landingSt.wasGrounded = false;
          landingSt.airborneTicks++;
          const downwardVel = Math.max(0, -(carState.velZ ?? 0));
          if (downwardVel > landingSt.peakDownwardSpeedUU) {
            landingSt.peakDownwardSpeedUU = downwardVel;
          }
        } else {
          if (!landingSt.wasGrounded && landingSt.airborneTicks >= 6 && landingSt.peakDownwardSpeedUU >= 220) {
            this.handleCarEvent({
              type: 'wheel_impact',
              carIndex: i,
              speed: landingSt.peakDownwardSpeedUU,
            });
          }
          landingSt.wasGrounded = true;
          landingSt.peakDownwardSpeedUU = 0;
          landingSt.airborneTicks = 0;
        }
      }
    }
  }

  handleCarEvent(event: PhysicsImpactAudioEvent | null | undefined): void {
    if (!event) return;
    const rawCarIndex = event.carIndex ?? event.primaryId ?? 0;
    const carIndex = rawCarIndex === 65535 ? 0 : rawCarIndex;
    const emitter = this.getEmitter(carIndex);
    if (event.carPosX !== undefined && event.carPosY !== undefined && event.carPosZ !== undefined) {
      emitter.updatePosition({ posX: event.carPosX, posY: event.carPosY, posZ: event.carPosZ });
    } else if (
      (event.posX !== undefined || event.x !== undefined) &&
      event.type !== INCIDENT_EVENT_TYPES.BOOST_PICKUP &&
      event.type !== 0x0A &&
      event.type !== INCIDENT_EVENT_TYPES.BOOST_SPAWN &&
      event.type !== 0x0B
    ) {
      emitter.updatePosition(event);
    }

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const master = audioConfig.get('masterVolume') ?? 1.0;
    const selfMult = emitter.isSelf ? (audioConfig.get('vehicleSelfVolume') ?? 1.0) : 1.0;
    const actionSubType = event.actionSubType ?? event.subType ?? 0;

    switch (event.type) {
      case INCIDENT_EVENT_TYPES.CAR_JUMP:
      case 0x06: {
        const vol = (audioConfig.get('jumpVolume') ?? 1.0) * master * selfMult;
        this._playJumpFamilyAction(emitter, carIndex, nowMs, vol, this.buffers.jump, 'lastJumpSoundIdx', 1.4);
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP:
      case 0x07: {
        const vol = (audioConfig.get('doubleJumpVolume') ?? 1.0) * master * selfMult;
        this._playJumpFamilyAction(emitter, carIndex, nowMs, vol, this.buffers.doubleJump, 'lastDoubleJumpSoundIdx', 1.7);
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_DODGE:
      case 0x08: {
        const vol = (audioConfig.get('dodgeVolume') ?? 1.0) * master * selfMult;
        this._playJumpFamilyAction(emitter, carIndex, nowMs, vol, this.buffers.dodge, 'lastDodgeSoundIdx', 1.2);
        break;
      }

      case PHYSICS_EVENT_TYPES.CAR_ACTION: {
        const subMap: Record<number, number> = {
          1: INCIDENT_EVENT_TYPES.CAR_JUMP,
          2: INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP,
          3: INCIDENT_EVENT_TYPES.CAR_DODGE,
        };
        if (subMap[actionSubType as number]) this.handleCarEvent({ ...event, type: subMap[actionSubType as number] });
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_BOOST_START:
      case 0x0C: {
        if (!this._checkCarCooldown(this._lastBoostEdgeMsByCar, carIndex, nowMs, INCIDENT_COOLDOWN_MS.BOOST_EDGE_PER_CAR)) break;
        const startVol = audioConfig.get('boostStartVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0;
        const vol = (audioConfig.get('boostVolume') ?? 1.0) * startVol * master * selfMult;
        const { boostStart, boostLoop } = this._resolveBoostBuffersForCar(carIndex);
        const buf = boostStart || boostLoop;
        if (buf) emitter.playAction(buf, { volume: vol, category: 'boost_other' });
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_BOOST_STOP:
      case 0x0D: {
        const releaseVol = audioConfig.get('boostReleaseVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0;
        const vol = (audioConfig.get('boostVolume') ?? 1.0) * releaseVol * master * selfMult * 0.8;
        const { boostRelease } = this._resolveBoostBuffersForCar(carIndex);
        if (boostRelease) emitter.playAction(boostRelease, { volume: vol, category: 'boost_other', distanceRadiusScale: 0.85 });
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case PHYSICS_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case 0x09: {
        if (!this._checkCarCooldown(this._lastSupersonicEnterMsByCar, carIndex, nowMs, INCIDENT_COOLDOWN_MS.SUPERSONIC_ENTER_PER_CAR)) break;
        const enterVol = audioConfig.get('supersonicEnterVolume') ?? audioConfig.get('supersonicVolume') ?? 1.0;
        const vol = enterVol * master * selfMult;
        const enterList = this.buffers.supersonicEnter;
        if (enterList && enterList.length > 0) {
          const idx = this._pickNonRepeatingIndex(enterList.length, this.lastSupersonicEnterSoundIdx);
          this.lastSupersonicEnterSoundIdx = idx;
          emitter.playAction(enterList[idx], { volume: vol, category: 'supersonic_other' });
        } else if (this.buffers.supersonicLoop) {
          emitter.playAction(this.buffers.supersonicLoop, { volume: vol, playbackRate: 1.1, category: 'supersonic_other' });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED:
      case PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED:
      case 0x0F: {
        if (!isBallFlipResetEvent(event)) break;
        if (!this._lastFlipResetMsByCar) this._lastFlipResetMsByCar = new Map();
        if (!this._checkCarCooldown(this._lastFlipResetMsByCar, carIndex, nowMs, INCIDENT_COOLDOWN_MS.FLIP_RESET_PER_CAR)) break;
        const vol = (audioConfig.get('flipResetVolume') ?? 1.0) * master * selfMult;
        if (this.buffers.reset) {
          emitter.playAction(this.buffers.reset, { volume: vol, playbackRate: 1.0, category: 'flip_reset_other' });
        } else {
          console.error('[AudioArchitecture] Missing flip reset audio asset (buffers.reset is null or empty)!', { carIndex, eventType: event.type });
        }
        break;
      }

      case 'wheel_impact':
      case 0x12: {
        if (!this._checkCarCooldown(this._lastWheelLandingMsByCar, carIndex, nowMs, INCIDENT_COOLDOWN_MS.WHEEL_LANDING_PER_CAR)) break;
        const downwardSpeed = Math.abs(event.speed ?? event.relSpeed ?? event.normalRelVel ?? event.impulse ?? 500);
        const mod = calibrateWheelLandingModulation(downwardSpeed, emitter.isSelf);
        const vol = (audioConfig.get('wheelImpactVolume') ?? 1.0) * master * selfMult * mod.volumeGainMultiplier;
        const list = this.buffers.wheelImpact;
        if (list && list.length > 0) {
          const idx = this._pickNonRepeatingIndex(list.length, this.lastWheelImpactSoundIdx);
          this.lastWheelImpactSoundIdx = idx;
          emitter.playAction(list[idx], {
            volume: vol,
            playbackRate: mod.playbackRate,
            category: mod.category,
            distanceRadiusScale: mod.distanceRadiusScale,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  silenceAll() {
    for (const emitter of this.emitters.values()) {
      emitter.silenceAll();
    }
  }
}
