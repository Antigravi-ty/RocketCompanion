import { audioConfig } from '../ui-core/config/audioConfig.js';
import { getAudioContext, getMasterAudioInput } from './audioContext.js';
import {
  toAudioCoordinates,
  getUuToMeters,
  listenerManager,
  calculateIncidentDistanceGain
} from './SpatialAudioSource.js';

export const BALL_AUDIO_CONFIG = Object.freeze({
  FLYING_FADE_OUT_SECONDS: 0.08, // Configurable short fade-out (50ms - 100ms)
  FLYING_DOWNWARD_VZ_THRESHOLD: -25.0, // Downward vertical velocity component threshold in UU/s
  FLYING_MIN_HEIGHT: 25.0, // Minimum height above ground to be considered airborne
  ROLLING_SPEED_THRESHOLD: 25.0, // Minimum surface rolling speed in UU/s
  ROLLING_FADE_OUT_SECONDS: 0.05 // 50ms fast fade out when leaving surface
});

export class BallAudioEmitter {
  constructor(context = null, destinationNode = null) {
    this.context = context;
    this.destinationNode = destinationNode;
    this.position = { x: 0, y: 0, z: 0 };
    this._scratchAudioPos = { x: 0, y: 0, z: 0 };
    this.initialized = false;

    this.ballPanner = null;
    this.rollingGain = null;
    this.rollingSource = null;
    this.flyingGain = null;
    this.flyingSource = null;

    this.ballRollingBuffer = null;
    this.ballFlyingBuffer = null;

    this._wasFallingDownward = false;
    this._wasRolling = false;
    this._lastPos = { x: 0, y: 0, z: 0 };
    this._lastTime = 0;
  }

  init(buffers = {}) {
    if (buffers.ballRolling) this.ballRollingBuffer = buffers.ballRolling;
    if (buffers.ballFlying) this.ballFlyingBuffer = buffers.ballFlying;

    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    this.context = ctx;
    const dest = this.destinationNode || getMasterAudioInput();

    if (!this.initialized) {
      // 3D Spatial Panner dedicated to the ball (follows unified spatialPanningModel)
      this.ballPanner = ctx.createPanner();
      const panModel = audioConfig.get('spatialPanningModel') || 'equalpower';
      try {
        this.ballPanner.panningModel = panModel;
      } catch (err) {
        console.warn(`[BallAudioEmitter] Failed to set panningModel="${panModel}", falling back to "equalpower":`, err);
        this.ballPanner.panningModel = 'equalpower';
      }
      this.ballPanner.distanceModel = 'inverse';
      this.ballPanner.rolloffFactor = 0;
      this.ballPanner.coneInnerAngle = 360;
      this.ballPanner.coneOuterAngle = 360;
      this.ballPanner.channelCount = 1;
      this.ballPanner.channelCountMode = 'explicit';
      this.ballPanner.channelInterpretation = 'speakers';
      if (dest) this.ballPanner.connect(dest);

      // Rolling loop pipeline
      this.rollingGain = ctx.createGain();
      this.rollingGain.gain.setValueAtTime(0, ctx.currentTime);
      this.rollingGain.connect(this.ballPanner);

      // Flying loop pipeline
      this.flyingGain = ctx.createGain();
      this.flyingGain.gain.setValueAtTime(0, ctx.currentTime);
      this.flyingGain.connect(this.ballPanner);

      this.initialized = true;
    }

    this._startLoops();
  }

  _startLoops() {
    const ctx = this.context || getAudioContext();
    if (!this.initialized || !ctx || ctx.state === 'closed') return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => console.warn('[AudioArchitecture] AudioContext resume failed/blocked:', err));
    }
    const now = ctx.currentTime;

    if (this.ballRollingBuffer && !this.rollingSource) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = this.ballRollingBuffer;
        src.loop = true;
        src.connect(this.rollingGain);
        src.start(now);
        src.onended = () => { if (this.rollingSource === src) this.rollingSource = null; };
        this.rollingSource = src;
      } catch (e) {
        console.warn('[BallAudioEmitter] Error starting rollingSource:', e);
      }
    }

    if (this.ballFlyingBuffer && !this.flyingSource) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = this.ballFlyingBuffer;
        src.loop = true;
        src.connect(this.flyingGain);
        src.start(now);
        src.onended = () => { if (this.flyingSource === src) this.flyingSource = null; };
        this.flyingSource = src;
      } catch (e) {
        console.warn('[BallAudioEmitter] Error starting flyingSource:', e);
      }
    }
  }

  silenceAll() {
    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    try {
      if (this.rollingGain) {
        this.rollingGain.gain.cancelScheduledValues(now);
        this.rollingGain.gain.setValueAtTime(0, now);
      }
      if (this.flyingGain) {
        this.flyingGain.gain.cancelScheduledValues(now);
        this.flyingGain.gain.setValueAtTime(0, now);
      }
    } catch (e) {
      console.warn('[BallAudioEmitter] Error silencing flyingGain on silenceAll:', e);
    }
    this._wasFallingDownward = false;
    this._wasRolling = false;
    this._lastTargetRollingGain = 0;
    this._lastTargetFlyingGain = 0;
  }

  updatePanningModel(model) {
    if (this.ballPanner && model) {
      try { this.ballPanner.panningModel = model; } catch (err) { console.warn("[BallAudioEmitter] Failed to set panningModel:", err?.message || err); }
    }
  }

  update(ballMeshOrView, camera, physics) {
    if (!this.initialized) return;
    if ((this.ballRollingBuffer && !this.rollingSource) || (this.ballFlyingBuffer && !this.flyingSource)) {
      this._startLoops();
    }
    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    if (!ballMeshOrView) {
      this.silenceAll();
      return;
    }

    // 1. Position extraction: Map to RocketSim coords (px: width, py: length, pz: height)
    let px = 0, py = 0, pz = 93.15;
    if (ballMeshOrView.position) {
      px = ballMeshOrView.position.x;
      py = ballMeshOrView.position.z;
      pz = ballMeshOrView.position.y;
    } else if (Number.isFinite(ballMeshOrView.posX) && Number.isFinite(ballMeshOrView.posY) && Number.isFinite(ballMeshOrView.posZ)) {
      px = ballMeshOrView.posX;
      py = ballMeshOrView.posY;
      pz = ballMeshOrView.posZ;
    } else if (physics?.ballState) {
      px = physics.ballState.posX ?? 0;
      py = physics.ballState.posY ?? 0;
      pz = physics.ballState.posZ ?? 93.15;
    }

    // 2. Velocity extraction (Live from physics engine)
    let vx = 0, vy = 0, vz = 0;
    if (physics?.ballState) {
      vx = physics.ballState.velX ?? 0;
      vy = physics.ballState.velY ?? 0;
      vz = physics.ballState.velZ ?? 0;
    } else if (ballMeshOrView.velX !== undefined) {
      vx = ballMeshOrView.velX;
      vy = ballMeshOrView.velY;
      vz = ballMeshOrView.velZ;
    } else if (ballMeshOrView.velocity) {
      vx = ballMeshOrView.velocity.x ?? 0;
      vy = ballMeshOrView.velocity.z ?? 0;
      vz = ballMeshOrView.velocity.y ?? 0;
    } else if (this._lastTime > 0) {
      const dt = Math.max(0.001, now - this._lastTime);
      vx = (px - this._lastPos.x) / dt;
      vy = (py - this._lastPos.y) / dt;
      vz = (pz - this._lastPos.z) / dt;
    }
    this._lastPos.x = px;
    this._lastPos.y = py;
    this._lastPos.z = pz;
    this._lastTime = now;

    // 3. Update spatial panner position in real time
    if (!this._scratchBallPosInput) {
      this._scratchBallPosInput = { posX: 0, posY: 0, posZ: 0 };
    }
    this._scratchBallPosInput.posX = px;
    this._scratchBallPosInput.posY = py;
    this._scratchBallPosInput.posZ = pz;
    const audioPos = toAudioCoordinates(this._scratchAudioPos, this._scratchBallPosInput);
    let distAtten = 1.0;
    if (audioPos && listenerManager.hasListener) {
      const dx = audioPos.x - listenerManager.position.x;
      const dy = audioPos.y - listenerManager.position.y;
      const dz = audioPos.z - listenerManager.position.z;
      const dist = Math.hypot(dx, dy, dz);
      distAtten = calculateIncidentDistanceGain(dist);

      if (this.ballPanner) {
        const panX = audioPos.x * getUuToMeters();
        const panY = audioPos.y * getUuToMeters();
        const panZ = audioPos.z * getUuToMeters();
        if (
          this._lastPanX === undefined ||
          Math.abs(panX - this._lastPanX) > 1e-4 ||
          Math.abs(panY - this._lastPanY) > 1e-4 ||
          Math.abs(panZ - this._lastPanZ) > 1e-4
        ) {
          this._lastPanX = panX;
          this._lastPanY = panY;
          this._lastPanZ = panZ;
          if (this.ballPanner.positionX) {
            this.ballPanner.positionX.setValueAtTime(panX, now);
            this.ballPanner.positionY.setValueAtTime(panY, now);
            this.ballPanner.positionZ.setValueAtTime(panZ, now);
          } else if (typeof this.ballPanner.setPosition === 'function') {
            this.ballPanner.setPosition(panX, panY, panZ);
          }
        }
      }
    }

    const master = audioConfig.get('masterVolume');
    const rollingSettingVol = audioConfig.get('ballRollingVolume');
    const flyingSettingVol = audioConfig.get('ballFlyingVolume');

    // 4. Surface contact detection (floor: 93.15, ceiling: 2048, sidewalls: +-4096, endwalls: +-5120)
    const isOnGround = physics ? (Boolean(physics.ballOnGround) || (typeof physics.getBallOnGround === 'function' && physics.getBallOnGround())) : false;
    const heightAboveFloor = pz - 93.15;
    const isNearFloor = heightAboveFloor <= 15.0;
    const isNearCeiling = pz >= (2048 - 93.15 - 20.0);
    const isNearSideWall = Math.abs(px) >= (4096 - 93.15 - 20.0);
    const isNearEndWall = Math.abs(py) >= (5120 - 93.15 - 20.0);
    const isContactingSurface = isOnGround || isNearFloor || isNearCeiling || isNearSideWall || isNearEndWall;

    const totalSpeed = Math.hypot(vx, vy, vz);
    const surfaceSpeed = Math.hypot(vx, vy);

    // 5. Rolling audio logic:
    let targetRollingGain = 0;
    if (isContactingSurface && (totalSpeed > BALL_AUDIO_CONFIG.ROLLING_SPEED_THRESHOLD || surfaceSpeed > BALL_AUDIO_CONFIG.ROLLING_SPEED_THRESHOLD)) {
      const speedFactor = Math.min(1.0, Math.max(0.1, totalSpeed / 1800.0));
      targetRollingGain = rollingSettingVol * master * distAtten * speedFactor;
      if (this.rollingSource && this.rollingSource.playbackRate) {
        const rate = 0.85 + 0.35 * Math.min(1.0, totalSpeed / 2000.0);
        if (this._lastRollingRate === undefined || Math.abs(rate - this._lastRollingRate) > 1e-3) {
          this._lastRollingRate = rate;
          this.rollingSource.playbackRate.setValueAtTime(rate, now);
        }
      }
    }

    try {
      if (this.rollingGain) {
        if (targetRollingGain > 0) {
          if (this._lastTargetRollingGain === undefined || Math.abs(targetRollingGain - this._lastTargetRollingGain) > 1e-3) {
            this._lastTargetRollingGain = targetRollingGain;
            this.rollingGain.gain.setTargetAtTime(targetRollingGain, now, 0.04);
          }
        } else if (this._wasRolling) {
          this._lastTargetRollingGain = 0;
          this.rollingGain.gain.cancelScheduledValues(now);
          this.rollingGain.gain.setValueAtTime(this.rollingGain.gain.value, now);
          this.rollingGain.gain.linearRampToValueAtTime(0, now + BALL_AUDIO_CONFIG.ROLLING_FADE_OUT_SECONDS);
        } else if (this._lastTargetRollingGain !== 0) {
          this._lastTargetRollingGain = 0;
          this.rollingGain.gain.setTargetAtTime(0, now, 0.04);
        }
      }
    } catch (e) {
      console.warn('[BallAudioEmitter] Error scheduling rolling gain transition:', e);
    }
    this._wasRolling = targetRollingGain > 0;

    // 6. Flying (downward aerial fall) audio logic:
    const isAirborne = !isContactingSurface && heightAboveFloor > BALL_AUDIO_CONFIG.FLYING_MIN_HEIGHT;
    const isFallingDownward = isAirborne && (vz < BALL_AUDIO_CONFIG.FLYING_DOWNWARD_VZ_THRESHOLD);

    try {
      if (this.flyingGain) {
        if (isFallingDownward) {
          const fallSpeedFactor = Math.min(1.0, Math.max(0.15, Math.abs(vz) / 1400.0));
          const targetFlyingGain = flyingSettingVol * master * distAtten * fallSpeedFactor;
          if (this._lastTargetFlyingGain === undefined || Math.abs(targetFlyingGain - this._lastTargetFlyingGain) > 1e-3) {
            this._lastTargetFlyingGain = targetFlyingGain;
            this.flyingGain.gain.cancelScheduledValues(now);
            this.flyingGain.gain.setTargetAtTime(targetFlyingGain, now, 0.04);
          }
          if (this.flyingSource && this.flyingSource.playbackRate) {
            const rate = 0.9 + 0.3 * Math.min(1.0, Math.abs(vz) / 2000.0);
            if (this._lastFlyingRate === undefined || Math.abs(rate - this._lastFlyingRate) > 1e-3) {
              this._lastFlyingRate = rate;
              this.flyingSource.playbackRate.setValueAtTime(rate, now);
            }
          }
        } else if (this._wasFallingDownward && !isFallingDownward) {
          this._lastTargetFlyingGain = 0;
          this.flyingGain.gain.cancelScheduledValues(now);
          this.flyingGain.gain.setValueAtTime(this.flyingGain.gain.value, now);
          this.flyingGain.gain.linearRampToValueAtTime(0, now + BALL_AUDIO_CONFIG.FLYING_FADE_OUT_SECONDS);
        } else if (!isFallingDownward && this.flyingGain.gain.value > 0.001 && this._lastTargetFlyingGain !== 0) {
          this._lastTargetFlyingGain = 0;
          this.flyingGain.gain.cancelScheduledValues(now);
          this.flyingGain.gain.linearRampToValueAtTime(0, now + BALL_AUDIO_CONFIG.FLYING_FADE_OUT_SECONDS);
        }
      }
    } catch (e) {
      console.warn('[BallAudioEmitter] Error scheduling flying gain transition:', e);
    }
    this._wasFallingDownward = isFallingDownward;
  }
}
