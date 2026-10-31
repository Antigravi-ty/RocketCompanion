import { VehicleAudioEmitter } from './VehicleAudioEmitter.js';
import { audioConfig } from '../ui-core/config/audioConfig.js';
import { subsystemState } from './audioContext.js';
import {
  INCIDENT_EVENT_TYPES,
  PHYSICS_EVENT_TYPES,
  isBallFlipResetEvent
} from '../physics/RocketSimConstants.js';

export class VehicleAudioManager {
  constructor() {
    this.emitters = new Map();
    this.carBoostVariations = new Map();
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

  _resolveBoostBuffersForCar(carIndex) {
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

  setCarBoostAudioVariation(carIndex, variationId = null) {
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

  getEmitter(carIndex = 0) {
    if (!this.emitters.has(carIndex)) {
      const emitter = new VehicleAudioEmitter(carIndex);
      emitter.setSelf(carIndex === this.activeCarIndex);
      const { boostLoop } = this._resolveBoostBuffersForCar(carIndex);
      emitter.setBuffers({
        boostLoop,
        supersonicLoop: this.buffers.supersonicLoop
      });
      this.emitters.set(carIndex, emitter);
    }
    return this.emitters.get(carIndex);
  }

  updatePanningModel(model) {
    if (!model) return;
    for (const emitter of this.emitters.values()) {
      if (emitter && emitter.panner3D) {
        try { emitter.panner3D.panningModel = model; } catch (err) { console.warn("[VehicleAudioManager] Failed to set panningModel:", err?.message || err); }
      }
    }
  }

  setBuffers(bufs = {}) {
    Object.assign(this.buffers, bufs);
    for (const [carIndex, emitter] of this.emitters.entries()) {
      const { boostLoop } = this._resolveBoostBuffersForCar(carIndex);
      emitter.setBuffers({
        boostLoop,
        supersonicLoop: this.buffers.supersonicLoop
      });
    }
  }

  update({ activeCarIndex = 0, numCars = 1, getCarPos = null, getCarState = null, isMatchActive = true, hasBlockingOverlay = false, continueOnBlur = false, isHidden = false }) {
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
    }
  }

  handleCarEvent(event) {
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

    const master = audioConfig.get('masterVolume');
    const selfMult = emitter.isSelf ? audioConfig.get('vehicleSelfVolume') : 1.0;
    const actionSubType = event.actionSubType ?? event.subType ?? 0;

    switch (event.type) {
      case INCIDENT_EVENT_TYPES.CAR_JUMP:
      case 0x06: {
        const vol = audioConfig.get('jumpVolume') * master * selfMult;
        const list = this.buffers.jump;
        if (list && list.length > 0) {
          let idx = Math.floor(Math.random() * list.length);
          if (list.length > 1 && idx === this.lastJumpSoundIdx) idx = (idx + 1) % list.length;
          this.lastJumpSoundIdx = idx;
          emitter.playAction(list[idx], { volume: vol });
        } else if (this.buffers.carCollision) {
          emitter.playAction(this.buffers.carCollision, { volume: vol * 0.4, playbackRate: 1.4 });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP:
      case 0x07: {
        const vol = audioConfig.get('doubleJumpVolume') * master * selfMult;
        const list = this.buffers.doubleJump;
        if (list && list.length > 0) {
          let idx = Math.floor(Math.random() * list.length);
          if (list.length > 1 && idx === this.lastDoubleJumpSoundIdx) idx = (idx + 1) % list.length;
          this.lastDoubleJumpSoundIdx = idx;
          emitter.playAction(list[idx], { volume: vol });
        } else if (this.buffers.carCollision) {
          emitter.playAction(this.buffers.carCollision, { volume: vol * 0.4, playbackRate: 1.7 });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_DODGE:
      case 0x08: {
        const vol = audioConfig.get('dodgeVolume') * master * selfMult;
        const list = this.buffers.dodge;
        if (list && list.length > 0) {
          let idx = Math.floor(Math.random() * list.length);
          if (list.length > 1 && idx === this.lastDodgeSoundIdx) idx = (idx + 1) % list.length;
          this.lastDodgeSoundIdx = idx;
          emitter.playAction(list[idx], { volume: vol });
        } else if (this.buffers.carCollision) {
          emitter.playAction(this.buffers.carCollision, { volume: vol * 0.4, playbackRate: 1.2 });
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
        const startVol = audioConfig.get('boostStartVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0;
        const vol = (audioConfig.get('boostVolume') ?? 1.0) * startVol * master * selfMult;
        const { boostStart, boostLoop } = this._resolveBoostBuffersForCar(carIndex);
        const buf = boostStart || boostLoop;
        if (buf) {
          emitter.playAction(buf, { volume: vol });
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
          emitter.playAction(buf, { volume: vol });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case PHYSICS_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case 0x09: {
        const enterVol = audioConfig.get('supersonicEnterVolume') ?? audioConfig.get('supersonicVolume') ?? 1.0;
        const vol = enterVol * master * selfMult;
        const enterList = this.buffers.supersonicEnter;
        if (enterList && enterList.length > 0) {
          let idx = Math.floor(Math.random() * enterList.length);
          if (enterList.length > 1 && idx === this.lastSupersonicEnterSoundIdx) idx = (idx + 1) % enterList.length;
          this.lastSupersonicEnterSoundIdx = idx;
          emitter.playAction(enterList[idx], { volume: vol });
        } else if (this.buffers.supersonicLoop) {
          emitter.playAction(this.buffers.supersonicLoop, { volume: vol, playbackRate: 1.1 });
        }
        break;
      }

      case INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED:
      case PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED:
      case 0x0F: {
        // Default filter: only play the Flip Reset SFX when detached from the Ball (subType === 1 / 'ball').
        // Other object/surface subtypes (2=car, 3=ceiling, 4=backboard, etc.) can be routed to custom cues here later.
        if (!isBallFlipResetEvent(event)) break;

        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!this._lastFlipResetMsByCar) this._lastFlipResetMsByCar = new Map();
        const prevMs = this._lastFlipResetMsByCar.get(carIndex) || -Infinity;
        if (nowMs - prevMs < 500) break;
        this._lastFlipResetMsByCar.set(carIndex, nowMs);

        const vol = (audioConfig.get('flipResetVolume') ?? 1.0) * master * selfMult;
        if (this.buffers.reset) {
          emitter.playAction(this.buffers.reset, { volume: vol, playbackRate: 1.0 });
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
        const vol = (audioConfig.get('wheelImpactVolume') ?? 1.0) * master * selfMult;
        const list = this.buffers.wheelImpact;
        if (list && list.length > 0) {
          let idx = Math.floor(Math.random() * list.length);
          if (list.length > 1 && idx === this.lastWheelImpactSoundIdx) idx = (idx + 1) % list.length;
          this.lastWheelImpactSoundIdx = idx;
          emitter.playAction(list[idx], { volume: vol });
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
