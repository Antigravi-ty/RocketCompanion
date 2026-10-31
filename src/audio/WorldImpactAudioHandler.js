import { audioConfig } from '../ui-core/config/audioConfig.js';
import { getAudioSlotPool } from './audioContext.js';
import { SURFACE_SUBTYPES } from '../physics/RocketSimConstants.js';

export class WorldImpactAudioHandler {
  constructor(buffers = {}) {
    this.buffers = buffers;
    this.lastBallWorldHitTimestamp = 0;
    this.lastGoalpostHitTimestamp = 0;
    this.lastGroundHitSoundIdx = -1;
    this.lastSidewallHitSoundIdx = -1;
    this.lastCrossbarPingIdx = -1;
    this.lastCrossbarPingSmallIdx = -1;
  }

  setBuffers(bufs) {
    this.buffers = bufs;
  }

  handleBallWorldHit(event, camera) {
    if (!event) return;

    if (event.isCrossbar || event.surfaceTag === SURFACE_SUBTYPES.GOALPOST || event.surfaceTag === SURFACE_SUBTYPES.CROSSBAR) {
      this.handleBallGoalpostHit(event, camera);
      return;
    }

    const now = performance.now();
    const cooldownMs = audioConfig.get('incidentCooldownMs');
    if (now - this.lastBallWorldHitTimestamp < cooldownMs) return;

    // Audio shielding against weak rolling buzz
    const floorThreshold = audioConfig.get('ballGroundHitThreshold');
    const wallThreshold = audioConfig.get('ballWallHitThreshold');
    const threshold = (event.surfaceTag === 1 || event.surfaceTag === SURFACE_SUBTYPES.FLOOR) ? floorThreshold : wallThreshold;
    const impactVal = Number.isFinite(event.normalRelVel) ? event.normalRelVel : null;
    if (impactVal !== null && impactVal < threshold) return;

    this.lastBallWorldHitTimestamp = now;
    const pool = getAudioSlotPool();
    if (!pool) return;

    const master = audioConfig.get('masterVolume');
    const layerVol = audioConfig.get('ballCollisionVolume');

    // 1. Floor / Ground pitch: Normal collision using custom 1, 2, 3 (strictly NEVER vehicle-body-04)
    if (event.surfaceTag === 1 || event.surfaceTag === SURFACE_SUBTYPES.FLOOR) {
      const groundList = (this.buffers.groundHit && this.buffers.groundHit.length > 0)
        ? this.buffers.groundHit
        : (this.buffers.ballHit ? this.buffers.ballHit.slice(0, 3) : []);
      if (!groundList || groundList.length === 0) return;
      let idx = Math.floor(Math.random() * groundList.length);
      if (groundList.length > 1 && idx === this.lastGroundHitSoundIdx) {
        idx = (idx + 1) % groundList.length;
      }
      this.lastGroundHitSoundIdx = idx;
      const floorVol = audioConfig.get('ballFloorHitVolume');
      const volume = Math.max(0, Math.min(5.0, floorVol * layerVol * master));
      pool.playBuffer(groundList[idx], { volume, position: event, priority: 3 });
      return;
    }

    // 2. Field Net / Sidewalls / Ceiling / Backboard / Corner 45
    const isNetSurface = (event.surfaceTag === SURFACE_SUBTYPES.SIDE_WALL ||
                          event.surfaceTag === SURFACE_SUBTYPES.CEILING ||
                          event.surfaceTag === SURFACE_SUBTYPES.BACKBOARD ||
                          event.surfaceTag === SURFACE_SUBTYPES.CORNER_45 ||
                          event.surfaceTag === 3 || event.surfaceTag === 2 || event.surfaceTag === 4 || event.surfaceTag === 5);

    if (isNetSurface) {
      const sidewallList = (this.buffers.sidewallHit && this.buffers.sidewallHit.length > 0)
        ? this.buffers.sidewallHit
        : (this.buffers.groundHit && this.buffers.groundHit.length > 0 ? this.buffers.groundHit : this.buffers.ballHit?.slice(0, 3));
      if (sidewallList && sidewallList.length > 0) {
        let netIdx = Math.floor(Math.random() * sidewallList.length);
        if (sidewallList.length > 1 && netIdx === this.lastSidewallHitSoundIdx) {
          netIdx = (netIdx + 1) % sidewallList.length;
        }
        this.lastSidewallHitSoundIdx = netIdx;
        const netVol = audioConfig.get('ballNetHitVolume');
        const netVolume = Math.max(0, Math.min(5.0, netVol * layerVol * master));
        pool.playBuffer(sidewallList[netIdx], { volume: netVolume, position: event, priority: 5 });
      }
      return;
    }

    // 3. Ramps & Transition Curves
    const rampVol = audioConfig.get('ballRampHitVolume');
    const volume = Math.max(0, Math.min(5.0, rampVol * layerVol * master));
    const bufList = (this.buffers.groundHit && this.buffers.groundHit.length > 0)
      ? this.buffers.groundHit
      : (this.buffers.ballHit ? this.buffers.ballHit.slice(0, 3) : this.buffers.sidewallHit);
    if (bufList && bufList.length > 0) {
      const idx = Math.floor(Math.random() * bufList.length);
      pool.playBuffer(bufList[idx], { volume, position: event, priority: 4 });
    }
  }

  handleBallGoalpostHit(event, camera) {
    const now = performance.now();
    const cooldownMs = audioConfig.get('goalpostHitCooldownMs');
    if (now - this.lastGoalpostHitTimestamp < cooldownMs) return;

    const threshold = audioConfig.get('goalpostHitThreshold');
    const impactVal = Math.abs(event.normalRelVel || event.impulse || event.speed || 0);
    if (impactVal < threshold) return;

    this.lastGoalpostHitTimestamp = now;
    const pool = getAudioSlotPool();
    if (!pool) return;

    // Check ball speed against impact threshold
    const ballSpeed = Math.abs(event.speed || event.relSpeed || event.normalRelVel || impactVal);
    // Hard collision threshold: ball speed >= 1400 uu/s uses loud ping pool; softer impacts use small ping pool
    const isPingLarge = ballSpeed >= 1400;

    let bufList = isPingLarge ? this.buffers.crossbarPing : this.buffers.crossbarPingSmall;
    if (!bufList || bufList.length === 0) {
      bufList = this.buffers.crossbarPing || this.buffers.crossbarPingSmall;
    }

    let postBuf = null;
    if (bufList && bufList.length > 0) {
      const lastIdx = isPingLarge ? this.lastCrossbarPingIdx : this.lastCrossbarPingSmallIdx;
      let idx = Math.floor(Math.random() * bufList.length);
      if (bufList.length > 1 && idx === lastIdx) {
        idx = (lastIdx + 1 + Math.floor(Math.random() * (bufList.length - 1))) % bufList.length;
      }
      if (isPingLarge) {
        this.lastCrossbarPingIdx = idx;
      } else {
        this.lastCrossbarPingSmallIdx = idx;
      }
      postBuf = bufList[idx];
    } else {
      postBuf = this.buffers.goalpost || (this.buffers.ballHit && this.buffers.ballHit[3]) || null;
    }
    if (!postBuf) return;

    const master = audioConfig.get('masterVolume') ?? 1.0;
    const postVol = isPingLarge
      ? (audioConfig.get('goalpostHitVolume') ?? 1.0)
      : (audioConfig.get('goalpostSmallHitVolume') ?? audioConfig.get('goalpostHitVolume') ?? 1.0);
    const layerVol = audioConfig.get('ballCollisionVolume') ?? 1.0;
    const volume = Math.max(0, Math.min(5.0, postVol * layerVol * master));

    pool.playBuffer(postBuf, {
      volume,
      position: event,
      playbackRate: 1.0,
      priority: 8
    });
  }
}
