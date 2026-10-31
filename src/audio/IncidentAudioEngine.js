import { audioConfig } from '../ui-core/config/audioConfig.js';
import { getAudioSlotPool } from './audioContext.js';
import {
  INCIDENT_EVENT_TYPES,
  PHYSICS_EVENT_TYPES
} from '../physics/RocketSimConstants.js';
import { WorldImpactAudioHandler } from './WorldImpactAudioHandler.js';

export class IncidentAudioEngine {
  constructor(vehicleManager = null) {
    this.vehicleManager = vehicleManager;
    this.buffers = {
      ballHit: [],
      vehicleAccent: null,
      vehicleDetail: [],
      sidewallHit: [],
      carCollision: null,
      goalpost: null,
      boostCollect: null,
      goalScored: null,
      supersonic: null,
      jump: [],
      doubleJump: [],
      dodge: [],
      reset: null,
      wheelImpact: [],
      groundHit: [],
      crossbarPing: [],
      crossbarPingSmall: [],
      boostStart: null,
      boostRelease: null,
      supersonicEnter: []
    };

    this.lastCarBallHitTimestamp = 0;
    this.lastCarCollisionTimestamp = 0;
    this.lastBallHitSoundIdx = -1;
    this.lastBoostPickupByPad = new Map();

    this.worldImpactHandler = new WorldImpactAudioHandler(this.buffers);
  }

  setBuffers(bufs) {
    Object.assign(this.buffers, bufs);
    this.worldImpactHandler.setBuffers(this.buffers);
  }

  handleEvent(event, camera = null) {
    if (!event) return;
    const type = event.type;

    switch (type) {
      case INCIDENT_EVENT_TYPES.CAR_BALL_HIT:
      case PHYSICS_EVENT_TYPES.CAR_BALL_HIT:
        this.handleCarBallHit(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.CAR_CAR_BUMP:
      case INCIDENT_EVENT_TYPES.CAR_CAR_COLLISION:
      case PHYSICS_EVENT_TYPES.CAR_CAR_COLLISION:
        this.handleCarCarCollision(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.CAR_CAR_DEMO:
      case PHYSICS_EVENT_TYPES.CAR_DEMO:
        this.handleCarCarDemo(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.BALL_WORLD_HIT:
      case PHYSICS_EVENT_TYPES.BALL_WORLD_HIT:
        this.handleBallWorldHit(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT:
      case PHYSICS_EVENT_TYPES.BALL_GOALPOST_HIT:
        this.handleBallGoalpostHit(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.CAR_JUMP:
      case INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP:
      case INCIDENT_EVENT_TYPES.CAR_DODGE:
      case PHYSICS_EVENT_TYPES.CAR_ACTION:
      case 0x06:
      case 0x07:
      case 0x08:
        if (this.vehicleManager) {
          this.vehicleManager.handleCarEvent(event);
        } else {
          this.handleCarAction(event, camera);
        }
        break;

      case INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case PHYSICS_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case 0x09:
        if (this.vehicleManager) {
          this.vehicleManager.handleCarEvent(event);
        } else {
          this.handleSupersonicEnter(event, camera);
        }
        break;

      case INCIDENT_EVENT_TYPES.BOOST_PICKUP:
      case PHYSICS_EVENT_TYPES.BOOST_PICKUP:
      case 0x0A:
        this.handleBoostPickup(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.CAR_BOOST_START:
      case 0x0C:
        if (this.vehicleManager) {
          this.vehicleManager.handleCarEvent(event);
        } else {
          this.handleBoostStart(event, camera);
        }
        break;

      case INCIDENT_EVENT_TYPES.CAR_BOOST_STOP:
      case 0x0D:
        if (this.vehicleManager) {
          this.vehicleManager.handleCarEvent(event);
        } else {
          this.handleBoostStop(event, camera);
        }
        break;

      case INCIDENT_EVENT_TYPES.GOAL_SCORED:
      case 0x0E:
        this.handleGoalScored(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED:
      case PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED:
      case 0x0F:
        if (this.vehicleManager) {
          this.vehicleManager.handleCarEvent(event);
        } else {
          this.handleFlipReset(event, camera);
        }
        break;

      default:
        break;
    }
  }

  handleCarBallHit(event, camera) {
    const now = performance.now();
    const cooldownMs = audioConfig.get('carBallHitCooldownMs');
    if (now - this.lastCarBallHitTimestamp < cooldownMs) return;

    const threshold = audioConfig.get('carBallHitImpulseThreshold');
    const impulse = Number.isFinite(event.impulse) ? event.impulse : (event.relSpeed ?? 0);
    if (impulse < threshold) return;

    this.lastCarBallHitTimestamp = now;
    const pool = getAudioSlotPool();
    if (!pool) return;

    const ballHitMode = audioConfig.get('carBallSoundMode') || 'vehicle_body';
    let bufferToPlay = null;

    if (ballHitMode === 'vehicle_accent' && this.buffers.vehicleAccent) {
      bufferToPlay = this.buffers.vehicleAccent;
    } else {
      const hitList = this.buffers.ballHit;
      if (!hitList || hitList.length === 0) return;

      let idx = Math.floor(Math.random() * hitList.length);
      if (hitList.length > 1 && idx === this.lastBallHitSoundIdx) {
        idx = (idx + 1) % hitList.length;
      }
      this.lastBallHitSoundIdx = idx;
      bufferToPlay = hitList[idx];
    }

    if (!bufferToPlay) return;

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const hitVol = ballHitMode === 'vehicle_accent'
      ? (audioConfig.get('carBallAccentVolume') ?? 1.0) * (audioConfig.get('carBallHitVolume') ?? 1.0)
      : (audioConfig.get('carBallHitVolume') ?? 1.0);
    const layerVol = audioConfig.get('ballCollisionVolume') ?? 1.0;
    const volume = Math.max(0, Math.min(5.0, hitVol * layerVol * master));

    pool.playBuffer(bufferToPlay, {
      volume,
      position: event,
      priority: 5
    });
  }

  handleCarCarCollision(event, camera) {
    const now = performance.now();
    if (now - this.lastCarCollisionTimestamp < 40) return;
    this.lastCarCollisionTimestamp = now;

    const pool = getAudioSlotPool();
    if (!pool) return;

    const carCarMode = audioConfig.get('carCarSoundMode') || 'vehicle_detail';
    let buf = null;
    if (carCarMode === 'vehicle_detail' && this.buffers.vehicleDetail && this.buffers.vehicleDetail.length > 0) {
      const list = this.buffers.vehicleDetail;
      const idx = Math.floor(Math.random() * list.length);
      buf = list[idx];
    } else {
      buf = this.buffers.carCollision;
    }
    if (!buf) return;

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const carVol = carCarMode === 'vehicle_detail'
      ? (audioConfig.get('carCarCollisionVolume') ?? 1.0)
      : (audioConfig.get('carCarSfxCollisionVolume') ?? 1.0) * (audioConfig.get('carCarCollisionVolume') ?? 1.0);
    const volume = Math.max(0, Math.min(5.0, carVol * master));

    pool.playBuffer(buf, {
      volume,
      position: event,
      priority: 6
    });
  }

  handleCarCarDemo(event, camera) {
    const pool = getAudioSlotPool();
    if (!pool) return;

    const buf = this.buffers.goalScored || this.buffers.carCollision;
    if (!buf) return;

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const demoVol = audioConfig.get('carDemoVolume') ?? audioConfig.get('carCarCollisionVolume') ?? 1.0;
    const volume = Math.max(0, Math.min(5.0, demoVol * master));

    pool.playBuffer(buf, {
      volume,
      position: event,
      playbackRate: 0.85,
      priority: 9
    });
  }

  handleBallWorldHit(event, camera) {
    this.worldImpactHandler.handleBallWorldHit(event, camera);
  }

  handleBallGoalpostHit(event, camera) {
    this.worldImpactHandler.handleBallGoalpostHit(event, camera);
  }

  handleCarAction(event, camera) { this.vehicleManager?.handleCarEvent(event); }
  handleJump(event, camera) { this.vehicleManager?.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_JUMP }); }
  handleDoubleJump(event, camera) { this.vehicleManager?.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP }); }
  handleDodge(event, camera) { this.vehicleManager?.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_DODGE }); }
  handleSupersonicEnter(event, camera) { this.vehicleManager?.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER }); }
  handleBoostStart(event, camera) { this.vehicleManager?.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_BOOST_START }); }
  handleBoostStop(event, camera) { this.vehicleManager?.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.CAR_BOOST_STOP }); }

  handleBoostPickup(event, camera) {
    const pool = getAudioSlotPool();
    if (!pool || !this.buffers.boostCollect) return;

    const now = performance.now();
    const padKey = event.padIndex !== undefined ? event.padIndex : (event.secondaryId ?? -1);
    if (padKey >= 0) {
      const lastPickup = this.lastBoostPickupByPad.get(padKey) || 0;
      if (now - lastPickup < 150) return;
      this.lastBoostPickupByPad.set(padKey, now);
    }

    const master = audioConfig.get('masterVolume');
    const boostVol = audioConfig.get('boostCollectVolume') * audioConfig.get('boostVolume');
    const finalVol = Math.max(0, Math.min(5.0, master * boostVol));

    const hasValidPadPosition = Number.isFinite(event.x) && Number.isFinite(event.y) && Number.isFinite(event.z);

    pool.playBuffer(this.buffers.boostCollect, {
      volume: finalVol,
      position: hasValidPadPosition ? event : null,
      playbackRate: 1.0,
      priority: 4
    });
  }

  handleGoalScored(event, camera) {
    const now = performance.now();
    if (this.lastGoalScoredTimestamp && (now - this.lastGoalScoredTimestamp < 2500)) {
      return;
    }
    this.lastGoalScoredTimestamp = now;

    const pool = getAudioSlotPool();
    if (!pool || !this.buffers.goalScored) return;

    const master = audioConfig.get('masterVolume');
    const goalVol = audioConfig.get('goalScoredVolume');
    const volume = Math.max(0, Math.min(5.0, goalVol * master));

    pool.playBuffer(this.buffers.goalScored, {
      volume,
      position: event,
      priority: 10
    });
  }

  handleFlipReset(event, camera) {
    this.vehicleManager?.handleCarEvent({ ...event, type: INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED });
  }
}
