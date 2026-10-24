import { audioConfig } from '../config/audioConfig.js';
import { getAudioContext, getMasterAudioInput } from './audioContext.js';
import {
  toAudioCoordinates,
  getUuToMeters,
  listenerManager,
  calculateIncidentDistanceGain
} from './SpatialAudioSource.js';

export class VehicleAudioEmitter {
  constructor(carIndex, context = null, destinationNode = null) {
    this.carIndex = carIndex;
    this.context = context;
    this.destinationNode = destinationNode;
    this.isSelf = false;
    this.position = { x: 0, y: 0, z: 0 };
    this._scratchAudioPos = { x: 0, y: 0, z: 0 };
    this.initialized = false;

    this.isBoosting = false;
    this.isSupersonic = false;
    this.isAlive = true;
    this.audible = true;

    this.inputGain = null;
    this.panner3D = null;
    this.selfGain = null;
    this.distanceGain = null;
    this.boostLoopSource = null;
    this.boostLoopGain = null;
    this.supersonicLoopSource = null;
    this.supersonicLoopGain = null;
    this.boostLoopBuffer = null;
    this.supersonicLoopBuffer = null;
    this.activeSources = new Set();
    this.init();
  }

  init() {
    if (this.initialized) return;
    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    this.context = ctx;
    const dest = this.destinationNode || getMasterAudioInput();

    this.panner3D = ctx.createPanner();
    const panModel = audioConfig.get('spatialPanningModel') || 'equalpower';
    try {
      this.panner3D.panningModel = panModel;
    } catch (err) {
      console.warn(`[PositionalVehicleAudio] Failed to set panningModel="${panModel}", falling back to "equalpower":`, err);
      this.panner3D.panningModel = 'equalpower';
    }
    this.panner3D.distanceModel = 'inverse';
    this.panner3D.rolloffFactor = 0;
    this.panner3D.coneInnerAngle = 360;
    this.panner3D.coneOuterAngle = 360;
    this.panner3D.channelCount = 1;
    this.panner3D.channelCountMode = 'explicit';
    this.panner3D.channelInterpretation = 'speakers';

    this.distanceGain = ctx.createGain();
    this.distanceGain.gain.setValueAtTime(1.0, ctx.currentTime);
    this.panner3D.connect(this.distanceGain);
    if (dest) this.distanceGain.connect(dest);

    // 2. Direct Self-Vehicle bus for local active player car
    this.selfGain = ctx.createGain();
    this.selfGain.gain.setValueAtTime(1.0, ctx.currentTime);
    if (dest) this.selfGain.connect(dest);

    // 3. Central input node for all vehicle audio sources
    this.inputGain = ctx.createGain();
    this.inputGain.gain.setValueAtTime(1.0, ctx.currentTime);
    if (this.isSelf) {
      this.inputGain.connect(this.selfGain);
    } else {
      this.inputGain.connect(this.panner3D);
    }

    this.boostLoopGain = ctx.createGain();
    this.boostLoopGain.gain.setValueAtTime(0, ctx.currentTime);
    this.boostLoopGain.connect(this.inputGain);

    this.supersonicLoopGain = ctx.createGain();
    this.supersonicLoopGain.gain.setValueAtTime(0, ctx.currentTime);
    this.supersonicLoopGain.connect(this.inputGain);

    this.initialized = true;
    this._startLoops();
  }

  setSelf(isSelf) {
    const val = Boolean(isSelf);
    if (this.isSelf === val) return;
    this.isSelf = val;
    if (!this.inputGain) return;
    try {
      this.inputGain.disconnect();
      if (this.isSelf) {
        if (this.selfGain) this.inputGain.connect(this.selfGain);
      } else {
        if (this.panner3D) this.inputGain.connect(this.panner3D);
      }
    } catch (e) {
      console.warn('[PositionalVehicleAudio] Error reconnecting spatial panner:', e);
    }
  }

  setBuffers({ boostLoop, supersonicLoop }) {
    if (boostLoop && this.boostLoopBuffer !== boostLoop) {
      this.boostLoopBuffer = boostLoop;
      if (this.boostLoopSource) {
        try {
          this.boostLoopSource.onended = null;
          this.boostLoopSource.stop();
          this.boostLoopSource.disconnect();
        } catch (err) {
          console.warn('[PositionalVehicleAudio] Error stopping previous boostLoopSource:', err);
        }
        this.boostLoopSource = null;
      }
    }
    if (supersonicLoop && this.supersonicLoopBuffer !== supersonicLoop) {
      this.supersonicLoopBuffer = supersonicLoop;
      if (this.supersonicLoopSource) {
        try {
          this.supersonicLoopSource.onended = null;
          this.supersonicLoopSource.stop();
          this.supersonicLoopSource.disconnect();
        } catch (err) {
          console.warn('[PositionalVehicleAudio] Error stopping previous supersonicLoopSource:', err);
        }
        this.supersonicLoopSource = null;
      }
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

    if (this.boostLoopBuffer && !this.boostLoopSource) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = this.boostLoopBuffer;
        src.loop = true;
        src.connect(this.boostLoopGain);
        src.start(now);
        src.onended = () => { if (this.boostLoopSource === src) this.boostLoopSource = null; };
        this.boostLoopSource = src;
      } catch (e) {
        console.warn('[PositionalVehicleAudio] Error starting boostLoopSource:', e);
      }
    }

    if (this.supersonicLoopBuffer && !this.supersonicLoopSource) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = this.supersonicLoopBuffer;
        src.loop = true;
        src.connect(this.supersonicLoopGain);
        src.start(now);
        src.onended = () => { if (this.supersonicLoopSource === src) this.supersonicLoopSource = null; };
        this.supersonicLoopSource = src;
      } catch (e) {
        console.warn('[PositionalVehicleAudio] Error starting supersonicLoopSource:', e);
      }
    }
  }

  updatePosition(pos) {
    if (!pos) return;
    const audioPos = toAudioCoordinates(this._scratchAudioPos, pos);
    if (!audioPos) return;

    this.position.x = audioPos.x;
    this.position.y = audioPos.y;
    this.position.z = audioPos.z;

    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    if (!this.isSelf && this.panner3D) {
      try {
        const px = audioPos.x * getUuToMeters();
        const py = audioPos.y * getUuToMeters();
        const pz = audioPos.z * getUuToMeters();
        if (
          this._lastPanX === undefined ||
          Math.abs(px - this._lastPanX) > 1e-4 ||
          Math.abs(py - this._lastPanY) > 1e-4 ||
          Math.abs(pz - this._lastPanZ) > 1e-4
        ) {
          this._lastPanX = px;
          this._lastPanY = py;
          this._lastPanZ = pz;
          if (this.panner3D.positionX) {
            this.panner3D.positionX.setValueAtTime(px, now);
            this.panner3D.positionY.setValueAtTime(py, now);
            this.panner3D.positionZ.setValueAtTime(pz, now);
          } else if (typeof this.panner3D.setPosition === 'function') {
            this.panner3D.setPosition(px, py, pz);
          }
        }

        if (listenerManager.hasListener && this.distanceGain) {
          const dx = audioPos.x - listenerManager.position.x;
          const dy = audioPos.y - listenerManager.position.y;
          const dz = audioPos.z - listenerManager.position.z;
          const dist = Math.hypot(dx, dy, dz);
          const atten = calculateIncidentDistanceGain(dist);
          if (this._lastDistAtten === undefined || Math.abs(atten - this._lastDistAtten) > 1e-4) {
            this._lastDistAtten = atten;
            this.distanceGain.gain.setValueAtTime(atten, now);
          }
        }
      } catch (e) {
        console.warn('[PositionalVehicleAudio] Error setting distanceGain attenuation:', e);
      }
    } else if (this.isSelf && this.selfGain) {
      const master = audioConfig.get('masterVolume');
      const selfVol = audioConfig.get('vehicleSelfVolume');
      const targetSelfGain = master * selfVol;
      if (this._lastSelfGain === undefined || Math.abs(targetSelfGain - this._lastSelfGain) > 1e-4) {
        this._lastSelfGain = targetSelfGain;
        this.selfGain.gain.setValueAtTime(targetSelfGain, now);
      }
    }
  }

  updateState({ isBoosting, isSupersonic, isAlive, audible } = {}) {
    if (isBoosting !== undefined) this.isBoosting = Boolean(isBoosting);
    if (isSupersonic !== undefined) this.isSupersonic = Boolean(isSupersonic);
    if (isAlive !== undefined) this.isAlive = Boolean(isAlive);
    if (audible !== undefined) this.audible = Boolean(audible);

    if (!this.initialized) return;
    if ((this.boostLoopBuffer && !this.boostLoopSource) || (this.supersonicLoopBuffer && !this.supersonicLoopSource)) {
      this._startLoops();
    }
    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const master = audioConfig.get('masterVolume');
    const selfMult = this.isSelf ? audioConfig.get('vehicleSelfVolume') : 1.0;

    if (this.boostLoopGain) {
      const boostSettingVol = audioConfig.get('boostLoopVolume') * audioConfig.get('boostVolume');
      const targetBoostGain = (this.isBoosting && this.isAlive && this.audible) ? (boostSettingVol * master * selfMult) : 0;
      if (this._lastTargetBoostGain === undefined || Math.abs(targetBoostGain - this._lastTargetBoostGain) > 1e-4) {
        this._lastTargetBoostGain = targetBoostGain;
        try {
          this.boostLoopGain.gain.setTargetAtTime(targetBoostGain, now, 0.035);
        } catch (e) {
          console.warn('[PositionalVehicleAudio] Error ramping boostLoopGain:', e);
        }
      }
    }

    if (this.supersonicLoopGain) {
      const superSettingVol = audioConfig.get('supersonicVolume');
      const targetSuperGain = (this.isSupersonic && this.isAlive && this.audible) ? (superSettingVol * master * selfMult) : 0;
      if (this._lastTargetSuperGain === undefined || Math.abs(targetSuperGain - this._lastTargetSuperGain) > 1e-4) {
        this._lastTargetSuperGain = targetSuperGain;
        try {
          this.supersonicLoopGain.gain.setTargetAtTime(targetSuperGain, now, 0.05);
        } catch (e) {
          console.warn('[PositionalVehicleAudio] Error ramping supersonicLoopGain:', e);
        }
      }
    }
  }

  updateBoost(isBoosting, audible = true, isAlive = true) {
    this.updateState({ isBoosting, audible, isAlive });
  }

  updateSupersonic(isSupersonic, audible = true, isAlive = true) {
    this.updateState({ isSupersonic, audible, isAlive });
  }

  playAction(buffer, options = {}) {
    if (!buffer) return;
    const ctx = this.context || getAudioContext();
    if (!ctx || ctx.state === 'closed') return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => console.warn('[AudioArchitecture] AudioContext resume failed/blocked:', err));
    }
    const now = ctx.currentTime;
    const baseVolume = options.volume ?? 1.0;
    const playbackRate = options.playbackRate ?? 1.0;

    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.setValueAtTime(playbackRate, now);

      const voiceGain = ctx.createGain();
      voiceGain.gain.setValueAtTime(baseVolume, now);

      src.connect(voiceGain);
      voiceGain.connect(this.inputGain);

      src.start(now);
      this.activeSources.add(src);
      src.onended = () => {
        this.activeSources.delete(src);
        try {
          src.disconnect();
          voiceGain.disconnect();
        } catch (e) {
          console.warn('[PositionalVehicleAudio] Error disconnecting voice nodes onended:', e);
        }
      };
    } catch (e) {
      console.warn('[PositionalVehicleAudio] Error starting playAction source:', e);
    }
  }

  silenceAll() {
    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    this._lastTargetBoostGain = 0;
    this._lastTargetSuperGain = 0;
    try {
      if (this.boostLoopGain) {
        this.boostLoopGain.gain.cancelScheduledValues(now);
        this.boostLoopGain.gain.setValueAtTime(0, now);
      }
      if (this.supersonicLoopGain) {
        this.supersonicLoopGain.gain.cancelScheduledValues(now);
        this.supersonicLoopGain.gain.setValueAtTime(0, now);
      }
      for (const src of this.activeSources) {
        try { src.stop(now); src.disconnect(); } catch (e) {
          console.warn('[PositionalVehicleAudio] Error stopping active source on silenceAll:', e);
        }
      }
      this.activeSources.clear();
    } catch (e) {
      console.warn('[PositionalVehicleAudio] Error in silenceAll:', e);
    }
  }

  dispose() {
    this.silenceAll();
    try {
      if (this.boostLoopSource) { this.boostLoopSource.stop(); this.boostLoopSource.disconnect(); }
      if (this.supersonicLoopSource) { this.supersonicLoopSource.stop(); this.supersonicLoopSource.disconnect(); }
      this.inputGain?.disconnect();
      this.panner3D?.disconnect();
      this.distanceGain?.disconnect();
      this.selfGain?.disconnect();
    } catch (e) {
      console.warn('[PositionalVehicleAudio] Error disconnecting nodes on dispose:', e);
    }
  }
}
