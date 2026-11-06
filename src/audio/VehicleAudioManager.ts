import { VehicleAudioEmitter } from './VehicleAudioEmitter.ts';
import { audioConfig } from '../ui-core/config/audioConfig';
import { subsystemState } from './audioContext.ts';
import {
  INCIDENT_EVENT_TYPES,
  PHYSICS_EVENT_TYPES,
  isBallFlipResetEvent
} from '../physics/RocketSimConstants.ts';
import { type SpatialPositionInput } from './SpatialAudioSource.ts';
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
  _lastBoostEdgeMsByCar: Map<number, number>;
  _lastFlipResetMsByCar: Map<number, number> | undefined;
  _lastJumpActionMsByCar: Map<number, number>;
  _lastSupersonicEnterMsByCar: Map<number, number>;
  _lastWheelLandingMsByCar: Map<number, number>;
  _landingStateByCar: Map<number, VehicleLandingTrackingState>;
  activeCarIndex: number;
  buffers: VehicleAudioBuffers;
  carBoostVariations: Map<number, string>;
  emitters: Map<number, VehicleAudioEmitter>;
  lastDodgeSoundIdx: number;
  lastDoubleJumpSoundIdx: number;
  lastJumpSoundIdx: number;
  lastSupersonicEnterSoundIdx: number;
  lastWheelImpactSoundIdx: number;

  constructor() {
    this.emitters = new Map();
    this.carBoostVariations = new Map();
    this._lastBoostEdgeMsByCar = new Map();
    this._lastJumpActionMsByCar = new Map();
    this._lastSupersonicEnterMsByCar = new Map();
    this._lastWheelLandingMsByCar = new Map();
    this._landingStateByCar = new Map();
    this.buffers = {
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

    this.lastJumpSoundIdx = -1;
    this.lastDoubleJumpSoundIdx = -1;
    this.lastDodgeSoundIdx = -1;
    this.lastSupersonicEnterSoundIdx = -1;
    this.lastWheelImpactSoundIdx = -1;
    this.activeCarIndex = 0;
  }

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
      const startBuf = subsystemState.buffers.get(`boost_${varId}_start`) || this.buffers.boostStart;
      const loopBuf = subsystemState.buffers.get(`boost_${varId}_loop`) || this.buffers.boostLoop;
      const releaseBuf = subsystemState.buffers.get(`boost_${varId}_end`) || this.buffers.boostRelease;
      return { boostStart: startBuf, boostLoop: loopBuf, boostRelease: releaseBuf };
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
      emitter.setBuffers({
        boostLoop,
        supersonicLoop: this.buffers.supersonicLoop
      });
    }
  }

  getEmitter(carIndex = 0): VehicleAudioEmitter {
    let emitter = this.emitters.get(carIndex);
    if (!emitter) {
      emitter = new VehicleAudioEmitter(carIndex);
      emitter.setSelf(carIndex === this.activeCarIndex);
      const { boostLoop } = this._resolveBoostBuffersForCar(carIndex);
      emitter.setBuffers({
        boostLoop,
        supersonicLoop: this.buffers.supersonicLoop
      });
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
          console.warn("[VehicleAudioManager] Failed to set panningModel:", err instanceof Error ? err.message : err);
        }
      }
    }
  }

  setBuffers(bufs: Partial<VehicleAudioBuffers> = {}): void {
    Object.assign(this.buffers, bufs);
    for (const [carIndex, emitter] of this.emitters.entries()) {
      const { boostLoop } = this._resolveBoostBuffersForCar(carIndex);
      emitter.setBuffers({
        boostLoop,
        supersonicLoop: this.buffers.supersonicLoop
      });
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

    for (let i = 0; i < totalCars; i++) {
      const emitter = this.getEmitter(i);
      const isSelf = (i === activeCarIndex);
      emitter.setSelf(isSelf);

      if (getCarPos) {
        const pos = getCarPos(i);
        if (pos) emitter.updatePosition(pos);
      }

      const carState = getCarState ? getCarState(i) : null;
      const isBoosting = Boolean(carState?.isBoosting);
      const isSupersonic = Boolean(carState?.isSupersonic);
      const isAlive = !carState?.isDemoed;
      const audible =
        !hasBlockingOverlay && Boolean(isMatchActive) && (!isHidden || Boolean(continueOnBlur));

      emitter.updateState({
        isBoosting,
        isSupersonic,
        isAlive,
        audible
      });

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
    const carIndex = (rawCarIndex === 65535) ? 0 : rawCarIndex;
    const emitter = this.getEmitter(carIndex);
    if (event.carPosX !== undefined && event.carPosY !== undefined && event.carPosZ !== undefined) {
      emitter.updatePosition({ posX: event.carPosX, posY: event.carPosY, posZ: event.carPosZ });
    } else if (event.posX !== undefined || event.x !== undefined) {
      if (
        event.type !== INCIDENT_EVENT_TYPES.BOOST_PICKUP &&
        event.type !== 0x0A &&
        event.type !== INCIDENT_EVENT_TYPES.BOOST_SPAWN &&
        event.type !== 0x0B
      ) {
        emitter.updatePosition(event);
      }
    }

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const master = audioConfig.get('masterVolume') ?? 1.0;
    const selfMult = emitter.isSelf ? (audioConfig.get('vehicleSelfVolume') ?? 1.0) : 1.0;
    const actionSubType = event.actionSubType ?? event.subType ?? 0;

    switch (event.type) {
      case INCIDENT_EVENT_TYPES.CAR_JUMP:
      case 0x06: {
        const prevMs = this._lastJumpActionMsByCar.get(carIndex) || -Infinity;
        if (nowMs - prevMs < INCIDENT_COOLDOWN_MS.JUMP_ACTION_PER_CAR) break;
        this._lastJumpActionMsByCar.set(carIndex, nowMs);

        const vol = (audioConfig.get('jumpVolume') ?? 1.0) * master * selfMult;
        const list = this.buffers.jump;
        if (list && list.length > 0) {
          let idx = Math.floor(Math.random() * list.length);
          if (list.length > 1 && idx === this.lastJumpSoundIdx) idx = (idx + 1) % list.length;
          this.lastJumpSoundIdx = idx;
          emitter.playAction(list[idx], { volume: vol, category: 'jump_dodge_other' });
        } else if (this.buffers.carCollision) {
          emitter.playAction(this.buffers.carCollision, { volume: vol * 0.4, playbackRate: 1.4, category: 'jump_dodge_other' });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP:
      case 0x07: {
        const prevMs = this._lastJumpActionMsByCar.get(carIndex) || -Infinity;
        if (nowMs - prevMs < INCIDENT_COOLDOWN_MS.JUMP_ACTION_PER_CAR) break;
        this._lastJumpActionMsByCar.set(carIndex, nowMs);

        const vol = (audioConfig.get('doubleJumpVolume') ?? 1.0) * master * selfMult;
        const list = this.buffers.doubleJump;
        if (list && list.length > 0) {
          let idx = Math.floor(Math.random() * list.length);
          if (list.length > 1 && idx === this.lastDoubleJumpSoundIdx) idx = (idx + 1) % list.length;
          this.lastDoubleJumpSoundIdx = idx;
          emitter.playAction(list[idx], { volume: vol, category: 'jump_dodge_other' });
        } else if (this.buffers.carCollision) {
          emitter.playAction(this.buffers.carCollision, { volume: vol * 0.4, playbackRate: 1.7, category: 'jump_dodge_other' });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_DODGE:
      case 0x08: {
        const prevMs = this._lastJumpActionMsByCar.get(carIndex) || -Infinity;
        if (nowMs - prevMs < INCIDENT_COOLDOWN_MS.JUMP_ACTION_PER_CAR) break;
        this._lastJumpActionMsByCar.set(carIndex, nowMs);

        const vol = (audioConfig.get('dodgeVolume') ?? 1.0) * master * selfMult;
        const list = this.buffers.dodge;
        if (list && list.length > 0) {
          let idx = Math.floor(Math.random() * list.length);
          if (list.length > 1 && idx === this.lastDodgeSoundIdx) idx = (idx + 1) % list.length;
          this.lastDodgeSoundIdx = idx;
          emitter.playAction(list[idx], { volume: vol, category: 'jump_dodge_other' });
        } else if (this.buffers.carCollision) {
          emitter.playAction(this.buffers.carCollision, { volume: vol * 0.4, playbackRate: 1.2, category: 'jump_dodge_other' });
        }
        break;
      }

      case PHYSICS_EVENT_TYPES.CAR_ACTION: {
        if (actionSubType === 1) {
          this.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_JUMP });
        } else if (actionSubType === 2) {
          this.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP });
        } else if (actionSubType === 3) {
          this.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_DODGE });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_BOOST_START:
      case 0x0C: {
        const prevMs = this._lastBoostEdgeMsByCar.get(carIndex) || -Infinity;
        if (nowMs - prevMs < INCIDENT_COOLDOWN_MS.BOOST_EDGE_PER_CAR) break;
        this._lastBoostEdgeMsByCar.set(carIndex, nowMs);

        const startVol = audioConfig.get('boostStartVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0;
        const vol = (audioConfig.get('boostVolume') ?? 1.0) * startVol * master * selfMult;
        const { boostStart, boostLoop } = this._resolveBoostBuffersForCar(carIndex);
        const buf = boostStart || boostLoop;
        if (buf) {
          emitter.playAction(buf, { volume: vol, category: 'boost_other' });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_BOOST_STOP:
      case 0x0D: {
        const releaseVol = audioConfig.get('boostReleaseVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0;
        const vol = (audioConfig.get('boostVolume') ?? 1.0) * releaseVol * master * selfMult * 0.8;
        const { boostRelease } = this._resolveBoostBuffersForCar(carIndex);
        const buf = boostRelease;
        if (buf) {
          emitter.playAction(buf, { volume: vol, category: 'boost_other', distanceRadiusScale: 0.85 });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case PHYSICS_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case 0x09: {
        const prevMs = this._lastSupersonicEnterMsByCar.get(carIndex) || -Infinity;
        if (nowMs - prevMs < INCIDENT_COOLDOWN_MS.SUPERSONIC_ENTER_PER_CAR) break;
        this._lastSupersonicEnterMsByCar.set(carIndex, nowMs);

        const enterVol = audioConfig.get('supersonicEnterVolume') ?? audioConfig.get('supersonicVolume') ?? 1.0;
        const vol = enterVol * master * selfMult;
        const enterList = this.buffers.supersonicEnter;
        if (enterList && enterList.length > 0) {
          let idx = Math.floor(Math.random() * enterList.length);
          if (enterList.length > 1 && idx === this.lastSupersonicEnterSoundIdx) idx = (idx + 1) % enterList.length;
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
        // Default filter: only play the Flip Reset SFX when detached from the Ball (subType === 1 / 'ball').
        // Other object/surface subtypes (2=car, 3=ceiling, 4=backboard, etc.) can be routed to custom cues here later.
        if (!isBallFlipResetEvent(event)) break;

        if (!this._lastFlipResetMsByCar) this._lastFlipResetMsByCar = new Map();
        const prevMs = this._lastFlipResetMsByCar.get(carIndex) || -Infinity;
        if (nowMs - prevMs < INCIDENT_COOLDOWN_MS.FLIP_RESET_PER_CAR) break;
        this._lastFlipResetMsByCar.set(carIndex, nowMs);

        const vol = (audioConfig.get('flipResetVolume') ?? 1.0) * master * selfMult;
        if (this.buffers.reset) {
          emitter.playAction(this.buffers.reset, { volume: vol, playbackRate: 1.0, category: 'flip_reset_other' });
        } else {
          console.error('[AudioArchitecture] Missing flip reset audio asset (buffers.reset is null or empty)!', {
            carIndex,
            eventType: event.type
          });
        }
        break;
      }

      case 'wheel_impact':
      case 0x12: {
        const prevMs = this._lastWheelLandingMsByCar.get(carIndex) || -Infinity;
        if (nowMs - prevMs < INCIDENT_COOLDOWN_MS.WHEEL_LANDING_PER_CAR) break;
        this._lastWheelLandingMsByCar.set(carIndex, nowMs);

        const downwardSpeed = Math.abs(event.speed ?? event.relSpeed ?? event.normalRelVel ?? event.impulse ?? 500);
        const mod = calibrateWheelLandingModulation(downwardSpeed, emitter.isSelf);
        const vol = (audioConfig.get('wheelImpactVolume') ?? 1.0) * master * selfMult * mod.volumeGainMultiplier;
        const list = this.buffers.wheelImpact;
        if (list && list.length > 0) {
          let idx = Math.floor(Math.random() * list.length);
          if (list.length > 1 && idx === this.lastWheelImpactSoundIdx) idx = (idx + 1) % list.length;
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
