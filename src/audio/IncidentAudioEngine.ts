import { audioConfig } from '../ui-core/config/audioConfig.ts';
import { getAudioSlotPool } from './audioContext.ts';
import { INCIDENT_EVENT_TYPES, PHYSICS_EVENT_TYPES } from '../physics/RocketSimConstants.ts';
import {
  WorldImpactAudioHandler,
  type WorldImpactAudioBuffers,
  type PhysicsImpactAudioEvent,
} from './WorldImpactAudioHandler.ts';
import { type VehicleAudioManager } from './VehicleAudioManager.ts';
import {
  INCIDENT_SLOT_PRIORITY,
  INCIDENT_COOLDOWN_MS,
  calibrateCarBallHitModulation,
  calibrateCarBumpModulation,
  calibrateBoostPickupModulation,
} from './IncidentSpatialModulator.ts';

export interface IncidentAudioBuffers extends WorldImpactAudioBuffers {
  ballHit: Array<AudioBuffer | null>;
  vehicleAccent: AudioBuffer | null;
  vehicleDetail: Array<AudioBuffer | null>;
  sidewallHit: Array<AudioBuffer | null>;
  carDemo: Array<AudioBuffer | null>;
  carCollision: AudioBuffer | null;
  goalpost: AudioBuffer | null;
  boostCollect: AudioBuffer | null;
  goalScored: AudioBuffer | null;
  supersonic: AudioBuffer | null;
  jump: Array<AudioBuffer | null>;
  doubleJump: Array<AudioBuffer | null>;
  dodge: Array<AudioBuffer | null>;
  reset: AudioBuffer | null;
  wheelImpact: Array<AudioBuffer | null>;
  groundHit: Array<AudioBuffer | null>;
  crossbarPing: Array<AudioBuffer | null>;
  crossbarPingSmall: Array<AudioBuffer | null>;
  boostStart: AudioBuffer | null;
  boostRelease: AudioBuffer | null;
  supersonicEnter: Array<AudioBuffer | null>;
}

export class IncidentAudioEngine {
  buffers: IncidentAudioBuffers;
  lastBallHitSoundIdx: number;
  lastCarDemoSoundIdx: number;
  lastBoostPickupByPad: Map<number, number>;
  lastCarCollisionByPair: Map<number, number>;
  lastCarDemoByVictim: Map<number, number>;
  lastCarBallHitTimestamp: number;
  lastCarCollisionTimestamp: number;
  lastGoalScoredTimestamp: number;
  vehicleManager: VehicleAudioManager | null;
  worldImpactHandler: WorldImpactAudioHandler;

  constructor(vehicleManager: VehicleAudioManager | null = null) {
    this.vehicleManager = vehicleManager;
    const initialBuffers: IncidentAudioBuffers = {
      ballHit: [],
      vehicleAccent: null,
      vehicleDetail: [],
      sidewallHit: [],
      carDemo: [],
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
      supersonicEnter: [],
    };
    this.buffers = initialBuffers;

    this.lastCarBallHitTimestamp = 0;
    this.lastCarCollisionTimestamp = 0;
    this.lastGoalScoredTimestamp = 0;
    this.lastBallHitSoundIdx = -1;
    this.lastCarDemoSoundIdx = -1;
    this.lastBoostPickupByPad = new Map();
    this.lastCarCollisionByPair = new Map();
    this.lastCarDemoByVictim = new Map();

    this.worldImpactHandler = new WorldImpactAudioHandler(initialBuffers);
  }

  setBuffers(bufs: Partial<IncidentAudioBuffers>): void {
    Object.assign(this.buffers, bufs);
    this.worldImpactHandler.setBuffers(this.buffers);
  }

  handleEvent(event: PhysicsImpactAudioEvent | null | undefined, camera: unknown = null): void {
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
        this.worldImpactHandler.handleBallWorldHit(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT:
      case PHYSICS_EVENT_TYPES.BALL_GOALPOST_HIT:
        this.worldImpactHandler.handleBallGoalpostHit(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.CAR_JUMP:
      case INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP:
      case INCIDENT_EVENT_TYPES.CAR_DODGE:
      case PHYSICS_EVENT_TYPES.CAR_ACTION:
      case 0x06:
      case 0x07:
      case 0x08:
      case INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case PHYSICS_EVENT_TYPES.CAR_SUPERSONIC_ENTER:
      case 0x09:
      case INCIDENT_EVENT_TYPES.CAR_BOOST_START:
      case 0x0c:
      case INCIDENT_EVENT_TYPES.CAR_BOOST_STOP:
      case 0x0d:
      case INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED:
      case PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED:
      case 0x0f:
      case 'wheel_impact':
      case 0x12:
        this.vehicleManager?.handleCarEvent(event);
        break;

      case INCIDENT_EVENT_TYPES.BOOST_PICKUP:
      case PHYSICS_EVENT_TYPES.BOOST_PICKUP:
      case 0x0a:
        this.handleBoostPickup(event, camera);
        break;

      case INCIDENT_EVENT_TYPES.GOAL_SCORED:
      case 0x0e:
        this.handleGoalScored(event, camera);
        break;

      default:
        break;
    }
  }

  handleCarBallHit(event: PhysicsImpactAudioEvent, _camera: unknown = null): void {
    const now = performance.now();
    const cooldownMs = audioConfig.get('carBallHitCooldownMs');
    if (now - this.lastCarBallHitTimestamp < cooldownMs) return;

    const threshold = audioConfig.get('carBallHitImpulseThreshold');
    const impulse = Number.isFinite(event.impulse)
      ? (event.impulse as number)
      : (event.relSpeed ?? 0);
    if (impulse < threshold) return;

    this.lastCarBallHitTimestamp = now;
    const pool = getAudioSlotPool();
    if (!pool) return;

    const ballHitMode = audioConfig.get('carBallSoundMode') || 'vehicle_body';
    let bufferToPlay: AudioBuffer | null = null;

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

    const activeCarIndex = this.vehicleManager?.activeCarIndex ?? 0;
    const mod = calibrateCarBallHitModulation(event, activeCarIndex, threshold);

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const hitVol =
      ballHitMode === 'vehicle_accent'
        ? (audioConfig.get('carBallAccentVolume') ?? 1.0) *
          (audioConfig.get('carBallHitVolume') ?? 1.0)
        : (audioConfig.get('carBallHitVolume') ?? 1.0);
    const layerVol = audioConfig.get('ballCollisionVolume') ?? 1.0;
    const volume = Math.max(
      0,
      Math.min(5.0, hitVol * layerVol * master * mod.volumeGainMultiplier)
    );

    pool.playBuffer(bufferToPlay, {
      volume,
      position: event,
      category: mod.category,
      distanceRadiusScale: mod.distanceRadiusScale,
      playbackRate: mod.playbackRate,
      priority: mod.priority,
    });
  }

  handleCarCarCollision(event: PhysicsImpactAudioEvent, _camera: unknown = null): void {
    const now = performance.now();
    if (now - this.lastCarCollisionTimestamp < INCIDENT_COOLDOWN_MS.CAR_CAR_BUMP_GLOBAL) return;

    const c1 = event.car1Index ?? event.carIndex ?? event.primaryId ?? 0;
    const c2 = event.car2Index ?? event.secondaryId ?? 0;
    const pairKey = (Math.min(c1, c2) & 0xff) | ((Math.max(c1, c2) & 0xff) << 8);
    const lastPairMs = this.lastCarCollisionByPair.get(pairKey) || 0;
    if (now - lastPairMs < INCIDENT_COOLDOWN_MS.CAR_CAR_BUMP_PAIR) return;

    this.lastCarCollisionTimestamp = now;
    this.lastCarCollisionByPair.set(pairKey, now);

    const pool = getAudioSlotPool();
    if (!pool) return;

    const carCarMode = audioConfig.get('carCarSoundMode') || 'vehicle_detail';
    let buf: AudioBuffer | null = null;
    if (
      carCarMode === 'vehicle_detail' &&
      this.buffers.vehicleDetail &&
      this.buffers.vehicleDetail.length > 0
    ) {
      const list = this.buffers.vehicleDetail;
      const idx = Math.floor(Math.random() * list.length);
      buf = list[idx];
    } else {
      buf = this.buffers.carCollision;
    }
    if (!buf) return;

    const activeCarIndex = this.vehicleManager?.activeCarIndex ?? 0;
    const mod = calibrateCarBumpModulation(event, activeCarIndex);

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const carVol =
      carCarMode === 'vehicle_detail'
        ? (audioConfig.get('carCarCollisionVolume') ?? 1.0)
        : (audioConfig.get('carCarSfxCollisionVolume') ?? 1.0) *
          (audioConfig.get('carCarCollisionVolume') ?? 1.0);
    const volume = Math.max(0, Math.min(5.0, carVol * master * mod.volumeGainMultiplier));

    pool.playBuffer(buf, {
      volume,
      position: event,
      category: mod.category,
      distanceRadiusScale: mod.distanceRadiusScale,
      playbackRate: mod.playbackRate,
      priority: mod.priority,
    });
  }

  handleCarCarDemo(event: PhysicsImpactAudioEvent, _camera: unknown = null): void {
    const now = performance.now();
    const victimKey =
      event.car2Index ?? event.secondaryId ?? event.carIndex ?? event.primaryId ?? -1;
    if (victimKey >= 0) {
      const lastDemoMs = this.lastCarDemoByVictim.get(victimKey) || 0;
      if (now - lastDemoMs < INCIDENT_COOLDOWN_MS.CAR_CAR_DEMO) return;
      this.lastCarDemoByVictim.set(victimKey, now);
    }

    const pool = getAudioSlotPool();
    if (!pool) return;

    let buf: AudioBuffer | null = null;
    const demoList = this.buffers.carDemo;
    if (Array.isArray(demoList) && demoList.length > 0) {
      let idx = Math.floor(Math.random() * demoList.length);
      if (demoList.length > 1 && idx === this.lastCarDemoSoundIdx) {
        idx = (idx + 1 + Math.floor(Math.random() * (demoList.length - 1))) % demoList.length;
      }
      this.lastCarDemoSoundIdx = idx;
      buf = demoList[idx];
    } else {
      buf = this.buffers.carCollision;
    }
    if (!buf) return;

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const demoVol =
      audioConfig.get('carDemoVolume') ?? audioConfig.get('carCarCollisionVolume') ?? 1.0;
    const volume = Math.max(0, Math.min(5.0, demoVol * master));

    pool.playBuffer(buf, {
      volume,
      position: event,
      category: 'demolish',
      playbackRate: 1.0,
      priority: INCIDENT_SLOT_PRIORITY.DEMOLISH,
    });
  }

  handleBoostPickup(event: PhysicsImpactAudioEvent, _camera: unknown = null): void {
    const pool = getAudioSlotPool();
    if (!pool || !this.buffers.boostCollect) return;

    const now = performance.now();
    const padKey = event.padIndex !== undefined ? event.padIndex : (event.secondaryId ?? -1);
    if (padKey >= 0) {
      const lastPickup = this.lastBoostPickupByPad.get(padKey) || 0;
      if (now - lastPickup < INCIDENT_COOLDOWN_MS.BOOST_PICKUP_PER_PAD) return;
      this.lastBoostPickupByPad.set(padKey, now);
    }

    const activeCarIndex = this.vehicleManager?.activeCarIndex ?? 0;
    const mod = calibrateBoostPickupModulation(event, activeCarIndex);

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const boostVol =
      (audioConfig.get('boostCollectVolume') ?? 1.0) * (audioConfig.get('boostVolume') ?? 1.0);
    const selfMult = mod.isSelfPickup ? (audioConfig.get('vehicleSelfVolume') ?? 1.0) : 1.0;
    const finalVol = Math.max(
      0,
      Math.min(5.0, master * boostVol * selfMult * mod.volumeGainMultiplier)
    );

    const hasValidPadPosition =
      (Number.isFinite(event.x) && Number.isFinite(event.y) && Number.isFinite(event.z)) ||
      (Number.isFinite(event.posX) && Number.isFinite(event.posY) && Number.isFinite(event.posZ));

    // Self pickup plays non-attenuated 2D stereo tactile feedback; remote car pickup plays 3D spatialized with hard cull
    pool.playBuffer(this.buffers.boostCollect, {
      volume: finalVol,
      position: !mod.isSelfPickup && hasValidPadPosition ? event : null,
      category: mod.category,
      distanceRadiusScale: mod.distanceRadiusScale,
      playbackRate: mod.playbackRate,
      priority: mod.priority,
    });
  }

  handleGoalScored(event: PhysicsImpactAudioEvent, _camera: unknown = null): void {
    const now = performance.now();
    if (
      this.lastGoalScoredTimestamp &&
      now - this.lastGoalScoredTimestamp < INCIDENT_COOLDOWN_MS.GOAL_SCORED
    ) {
      return;
    }
    this.lastGoalScoredTimestamp = now;

    const pool = getAudioSlotPool();
    if (!pool || !this.buffers.goalScored) return;

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const goalVol = audioConfig.get('goalScoredVolume') ?? 1.0;
    const volume = Math.max(0, Math.min(5.0, goalVol * master));

    pool.playBuffer(this.buffers.goalScored, {
      volume,
      position: event,
      category: 'goal_explosion',
      priority: INCIDENT_SLOT_PRIORITY.GOAL_EXPLOSION,
    });
  }
}
