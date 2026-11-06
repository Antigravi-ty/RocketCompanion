import { audioConfig } from '../ui-core/config/audioConfig';
import { getAudioContext, getMasterAudioInput } from './audioContext.ts';
import {
  toAudioCoordinates,
  getUuToMeters,
  listenerManager,
  calculateIncidentDistanceGain,
  isDistanceCulled,
  type AudioAttenuationCategory,
  type SpatialVector3Like,
  type SpatialPositionInput
} from './SpatialAudioSource.ts';

export interface VehicleAudioLoopBuffers {
  boostLoop?: AudioBuffer | null;
  supersonicLoop?: AudioBuffer | null;
}

export interface VehicleAudioStateInput {
  isBoosting?: boolean;
  isSupersonic?: boolean;
  isAlive?: boolean;
  audible?: boolean;
}

export interface VehiclePlayActionOptions {
  volume?: number;
  playbackRate?: number;
  category?: AudioAttenuationCategory | string | null;
  distanceRadiusScale?: number;
}

const BOOST_LOOP_HIBERNATE_GRACE_SEC = 0.16;
const SUPERSONIC_LOOP_HIBERNATE_GRACE_SEC = 0.22;

export class VehicleAudioEmitter {
  _lastDist: number;
  _lastPanX: number | undefined;
  _lastPanY: number | undefined;
  _lastPanZ: number | undefined;
  _lastSelfGain: number | undefined;
  _lastTargetBoostGain: number | undefined;
  _lastTargetSuperGain: number | undefined;
  _boostSilentSinceSec: number;
  _superSilentSinceSec: number;
  _scratchAudioPos: SpatialVector3Like;
  activeSources: Set<AudioBufferSourceNode>;
  audible: boolean;
  boostLoopBuffer: AudioBuffer | null;
  boostLoopGain: GainNode | null;
  boostLoopSource: AudioBufferSourceNode | null;
  carIndex: number;
  context: AudioContext | null;
  destinationNode: AudioNode | null;
  distanceGain: GainNode | null;
  initialized: boolean;
  inputGain: GainNode | null;
  isAlive: boolean;
  isBoosting: boolean;
  isSelf: boolean;
  isSupersonic: boolean;
  panner3D: PannerNode | null;
  position: SpatialVector3Like;
  selfGain: GainNode | null;
  supersonicLoopBuffer: AudioBuffer | null;
  supersonicLoopGain: GainNode | null;
  supersonicLoopSource: AudioBufferSourceNode | null;

  constructor(carIndex: number, context: AudioContext | null = null, destinationNode: AudioNode | null = null) {
    this.carIndex = carIndex;
    this.context = context;
    this.destinationNode = destinationNode;
    this.isSelf = false;
    this.position = { x: 0, y: 0, z: 0 };
    this._scratchAudioPos = { x: 0, y: 0, z: 0 };
    this._lastDist = 0;
    this._boostSilentSinceSec = -1;
    this._superSilentSinceSec = -1;
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

  setSelf(isSelf: boolean): void {
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

  setBuffers({ boostLoop, supersonicLoop }: VehicleAudioLoopBuffers): void {
    if (boostLoop && this.boostLoopBuffer !== boostLoop) {
      this.boostLoopBuffer = boostLoop;
      this._stopBoostLoopSource();
    }
    if (supersonicLoop && this.supersonicLoopBuffer !== supersonicLoop) {
      this.supersonicLoopBuffer = supersonicLoop;
      this._stopSupersonicLoopSource();
    }
    this._startLoops();
  }

  private _ensureBoostLoopStarted(ctx: AudioContext, now: number): void {
    if (!this.boostLoopBuffer || this.boostLoopSource) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => console.warn('[AudioArchitecture] AudioContext resume failed/blocked:', err));
    }
    try {
      const src = ctx.createBufferSource();
      src.buffer = this.boostLoopBuffer;
      src.loop = true;
      if (this.boostLoopGain) src.connect(this.boostLoopGain);
      const offset =
        this.boostLoopBuffer.duration > 0.1 ? Math.random() * (this.boostLoopBuffer.duration * 0.8) : 0;
      src.start(now, offset);
      src.onended = () => {
        if (this.boostLoopSource === src) this.boostLoopSource = null;
      };
      this.boostLoopSource = src;
    } catch (e) {
      console.warn('[PositionalVehicleAudio] Error starting boostLoopSource:', e);
    }
  }

  private _stopBoostLoopSource(): void {
    if (!this.boostLoopSource) return;
    const src = this.boostLoopSource;
    this.boostLoopSource = null;
    try {
      src.onended = null;
      src.stop();
      src.disconnect();
    } catch {
      /* ignore already stopped source */
    }
  }

  private _ensureSupersonicLoopStarted(ctx: AudioContext, now: number): void {
    if (!this.supersonicLoopBuffer || this.supersonicLoopSource) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => console.warn('[AudioArchitecture] AudioContext resume failed/blocked:', err));
    }
    try {
      const src = ctx.createBufferSource();
      src.buffer = this.supersonicLoopBuffer;
      src.loop = true;
      if (this.supersonicLoopGain) src.connect(this.supersonicLoopGain);
      const offset =
        this.supersonicLoopBuffer.duration > 0.1
          ? Math.random() * (this.supersonicLoopBuffer.duration * 0.8)
          : 0;
      src.start(now, offset);
      src.onended = () => {
        if (this.supersonicLoopSource === src) this.supersonicLoopSource = null;
      };
      this.supersonicLoopSource = src;
    } catch (e) {
      console.warn('[PositionalVehicleAudio] Error starting supersonicLoopSource:', e);
    }
  }

  private _stopSupersonicLoopSource(): void {
    if (!this.supersonicLoopSource) return;
    const src = this.supersonicLoopSource;
    this.supersonicLoopSource = null;
    try {
      src.onended = null;
      src.stop();
      src.disconnect();
    } catch {
      /* ignore already stopped source */
    }
  }

  _startLoops(): void {
    const ctx = this.context || getAudioContext();
    if (!this.initialized || !ctx || ctx.state === 'closed') return;
    const now = ctx.currentTime;
    const dist = !this.isSelf && listenerManager.hasListener ? this._lastDist : 0;

    if (
      this.isBoosting &&
      this.isAlive &&
      this.audible &&
      (this.isSelf || !isDistanceCulled(dist, 'boost_other'))
    ) {
      this._ensureBoostLoopStarted(ctx, now);
    }
    if (
      this.isSupersonic &&
      this.isAlive &&
      this.audible &&
      (this.isSelf || !isDistanceCulled(dist, 'supersonic_other'))
    ) {
      this._ensureSupersonicLoopStarted(ctx, now);
    }
  }

  updatePosition(pos: SpatialPositionInput | null | undefined): void {
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
          this._lastPanY === undefined ||
          this._lastPanZ === undefined ||
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

        if (listenerManager.hasListener) {
          const dx = audioPos.x - listenerManager.position.x;
          const dy = audioPos.y - listenerManager.position.y;
          const dz = audioPos.z - listenerManager.position.z;
          this._lastDist = Math.hypot(dx, dy, dz);
        }
      } catch (e) {
        console.warn('[PositionalVehicleAudio] Error updating 3D panner position:', e);
      }
    } else if (this.isSelf && this.selfGain) {
      this._lastDist = 0;
      const master = audioConfig.get('masterVolume');
      const selfVol = audioConfig.get('vehicleSelfVolume');
      const targetSelfGain = master * selfVol;
      if (this._lastSelfGain === undefined || Math.abs(targetSelfGain - this._lastSelfGain) > 1e-4) {
        this._lastSelfGain = targetSelfGain;
        this.selfGain.gain.setValueAtTime(targetSelfGain, now);
      }
    }
  }

  updateState({ isBoosting, isSupersonic, isAlive, audible }: VehicleAudioStateInput = {}): void {
    if (isBoosting !== undefined) this.isBoosting = Boolean(isBoosting);
    if (isSupersonic !== undefined) this.isSupersonic = Boolean(isSupersonic);
    if (isAlive !== undefined) this.isAlive = Boolean(isAlive);
    if (audible !== undefined) this.audible = Boolean(audible);

    if (!this.initialized) return;
    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const master = audioConfig.get('masterVolume');
    const selfMult = this.isSelf ? audioConfig.get('vehicleSelfVolume') : 1.0;
    const dist = !this.isSelf && listenerManager.hasListener ? this._lastDist : 0;

    if (this.boostLoopGain) {
      const boostCulled =
        !this.isSelf && listenerManager.hasListener && isDistanceCulled(dist, 'boost_other');
      const boostDistAtten = this.isSelf
        ? 1.0
        : boostCulled
          ? 0
          : calculateIncidentDistanceGain(dist, 'boost_other');
      const boostSettingVol = audioConfig.get('boostLoopVolume') * audioConfig.get('boostVolume');
      const targetBoostGain =
        this.isBoosting && this.isAlive && this.audible && !boostCulled
          ? boostSettingVol * master * selfMult * boostDistAtten
          : 0;

      if (targetBoostGain > 1e-4) {
        this._boostSilentSinceSec = -1;
        this._ensureBoostLoopStarted(ctx, now);
      } else if (this.boostLoopSource) {
        if (this._boostSilentSinceSec < 0) {
          this._boostSilentSinceSec = now;
        } else if (now - this._boostSilentSinceSec >= BOOST_LOOP_HIBERNATE_GRACE_SEC) {
          this._stopBoostLoopSource();
        }
      }

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
      const superCulled =
        !this.isSelf && listenerManager.hasListener && isDistanceCulled(dist, 'supersonic_other');
      const superDistAtten = this.isSelf
        ? 1.0
        : superCulled
          ? 0
          : calculateIncidentDistanceGain(dist, 'supersonic_other');
      const superSettingVol = audioConfig.get('supersonicLoopVolume') ?? audioConfig.get('supersonicVolume') ?? 1.0;
      const targetSuperGain =
        this.isSupersonic && this.isAlive && this.audible && !superCulled
          ? superSettingVol * master * selfMult * superDistAtten
          : 0;

      if (targetSuperGain > 1e-4) {
        this._superSilentSinceSec = -1;
        this._ensureSupersonicLoopStarted(ctx, now);
      } else if (this.supersonicLoopSource) {
        if (this._superSilentSinceSec < 0) {
          this._superSilentSinceSec = now;
        } else if (now - this._superSilentSinceSec >= SUPERSONIC_LOOP_HIBERNATE_GRACE_SEC) {
          this._stopSupersonicLoopSource();
        }
      }

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

  updateBoost(isBoosting: boolean, audible = true, isAlive = true): void {
    this.updateState({ isBoosting, audible, isAlive });
  }

  updateSupersonic(isSupersonic: boolean, audible = true, isAlive = true): void {
    this.updateState({ isSupersonic, audible, isAlive });
  }

  playAction(buffer: AudioBuffer | null, options: VehiclePlayActionOptions = {}): void {
    if (!buffer) return;
    const ctx = this.context || getAudioContext();
    if (!ctx || ctx.state === 'closed') return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => console.warn('[AudioArchitecture] AudioContext resume failed/blocked:', err));
    }
    const now = ctx.currentTime;
    const baseVolume = options.volume ?? 1.0;
    const playbackRate = options.playbackRate ?? 1.0;
    const category = options.category ?? 'jump_dodge_other';
    const distanceRadiusScale = options.distanceRadiusScale ?? 1.0;

    let effectiveVolume = baseVolume;
    if (!this.isSelf && listenerManager.hasListener) {
      const dx = this.position.x - listenerManager.position.x;
      const dy = this.position.y - listenerManager.position.y;
      const dz = this.position.z - listenerManager.position.z;
      const dist = Math.hypot(dx, dy, dz);
      this._lastDist = dist;
      if (isDistanceCulled(dist, category, distanceRadiusScale)) {
        return;
      }
      effectiveVolume = baseVolume * calculateIncidentDistanceGain(dist, category, distanceRadiusScale);
    }
    if (effectiveVolume <= 1e-5) return;

    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.setValueAtTime(playbackRate, now);

      const voiceGain = ctx.createGain();
      voiceGain.gain.setValueAtTime(effectiveVolume, now);

      if (!this.inputGain) return;
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
    this._boostSilentSinceSec = -1;
    this._superSilentSinceSec = -1;
    try {
      this._stopBoostLoopSource();
      this._stopSupersonicLoopSource();
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
      this.inputGain?.disconnect();
      this.panner3D?.disconnect();
      this.distanceGain?.disconnect();
      this.selfGain?.disconnect();
    } catch (e) {
      console.warn('[PositionalVehicleAudio] Error disconnecting nodes on dispose:', e);
    }
  }
}
