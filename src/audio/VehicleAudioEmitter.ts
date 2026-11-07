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
  _lastDist = 0;
  _lastPanX: number | undefined;
  _lastPanY: number | undefined;
  _lastPanZ: number | undefined;
  _lastSelfGain: number | undefined;
  _lastTargetBoostGain: number | undefined;
  _lastTargetSuperGain: number | undefined;
  _boostSilentSinceSec = -1;
  _superSilentSinceSec = -1;
  _scratchAudioPos: SpatialVector3Like = { x: 0, y: 0, z: 0 };
  activeSources: Set<AudioBufferSourceNode> = new Set();
  audible = true;
  boostLoopBuffer: AudioBuffer | null = null;
  boostLoopGain: GainNode | null = null;
  boostLoopSource: AudioBufferSourceNode | null = null;
  carIndex: number;
  context: AudioContext | null;
  destinationNode: AudioNode | null;
  distanceGain: GainNode | null = null;
  initialized = false;
  inputGain: GainNode | null = null;
  isAlive = true;
  isBoosting = false;
  isSelf = false;
  isSupersonic = false;
  panner3D: PannerNode | null = null;
  position: SpatialVector3Like = { x: 0, y: 0, z: 0 };
  selfGain: GainNode | null = null;
  supersonicLoopBuffer: AudioBuffer | null = null;
  supersonicLoopGain: GainNode | null = null;
  supersonicLoopSource: AudioBufferSourceNode | null = null;

  constructor(carIndex: number, context: AudioContext | null = null, destinationNode: AudioNode | null = null) {
    this.carIndex = carIndex;
    this.context = context;
    this.destinationNode = destinationNode;
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

    this.selfGain = ctx.createGain();
    this.selfGain.gain.setValueAtTime(1.0, ctx.currentTime);
    if (dest) this.selfGain.connect(dest);

    this.inputGain = ctx.createGain();
    this.inputGain.gain.setValueAtTime(1.0, ctx.currentTime);
    this.inputGain.connect(this.isSelf ? this.selfGain : this.panner3D);

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
      const target = this.isSelf ? this.selfGain : this.panner3D;
      if (target) this.inputGain.connect(target);
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

  private _spawnLoopSource(
    ctx: AudioContext,
    now: number,
    buffer: AudioBuffer | null,
    targetGain: GainNode | null,
    onEndedClear: (src: AudioBufferSourceNode) => void
  ): AudioBufferSourceNode | null {
    if (!buffer) return null;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      if (targetGain) src.connect(targetGain);
      const offset = buffer.duration > 0.1 ? Math.random() * (buffer.duration * 0.8) : 0;
      src.start(now, offset);
      src.onended = () => onEndedClear(src);
      return src;
    } catch {
      return null;
    }
  }

  private _teardownLoopSource(src: AudioBufferSourceNode | null): void {
    if (!src) return;
    try { src.onended = null; src.stop(); src.disconnect(); } catch { /* ignore */ }
  }

  private _ensureBoostLoopStarted(ctx: AudioContext, now: number): void {
    if (!this.boostLoopBuffer || this.boostLoopSource) return;
    this.boostLoopSource = this._spawnLoopSource(ctx, now, this.boostLoopBuffer, this.boostLoopGain, (src) => {
      if (this.boostLoopSource === src) this.boostLoopSource = null;
    });
  }

  private _stopBoostLoopSource(): void {
    const src = this.boostLoopSource;
    this.boostLoopSource = null;
    this._teardownLoopSource(src);
  }

  private _ensureSupersonicLoopStarted(ctx: AudioContext, now: number): void {
    if (!this.supersonicLoopBuffer || this.supersonicLoopSource) return;
    this.supersonicLoopSource = this._spawnLoopSource(ctx, now, this.supersonicLoopBuffer, this.supersonicLoopGain, (src) => {
      if (this.supersonicLoopSource === src) this.supersonicLoopSource = null;
    });
  }

  private _stopSupersonicLoopSource(): void {
    const src = this.supersonicLoopSource;
    this.supersonicLoopSource = null;
    this._teardownLoopSource(src);
  }

  _startLoops(): void {
    const ctx = this.context || getAudioContext();
    if (!this.initialized || !ctx || ctx.state === 'closed') return;
    const now = ctx.currentTime;
    const dist = !this.isSelf && listenerManager.hasListener ? this._lastDist : 0;
    if (this.isBoosting && this.isAlive && this.audible && (this.isSelf || !isDistanceCulled(dist, 'boost_other'))) {
      this._ensureBoostLoopStarted(ctx, now);
    }
    if (this.isSupersonic && this.isAlive && this.audible && (this.isSelf || !isDistanceCulled(dist, 'supersonic_other'))) {
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
        const scale = getUuToMeters();
        const px = audioPos.x * scale;
        const py = audioPos.y * scale;
        const pz = audioPos.z * scale;
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
          this._lastDist = Math.hypot(
            audioPos.x - listenerManager.position.x,
            audioPos.y - listenerManager.position.y,
            audioPos.z - listenerManager.position.z
          );
        }
      } catch (e) {
        console.warn('[PositionalVehicleAudio] Error updating 3D panner position:', e);
      }
    } else if (this.isSelf && this.selfGain) {
      this._lastDist = 0;
      const targetSelfGain = audioConfig.get('masterVolume') * audioConfig.get('vehicleSelfVolume');
      if (this._lastSelfGain === undefined || Math.abs(targetSelfGain - this._lastSelfGain) > 1e-4) {
        this._lastSelfGain = targetSelfGain;
        this.selfGain.gain.setValueAtTime(targetSelfGain, now);
      }
    }
  }

  private _stepLoopChannel(
    ctx: AudioContext,
    now: number,
    dist: number,
    active: boolean,
    category: AudioAttenuationCategory,
    settingVol: number,
    master: number,
    selfMult: number,
    gainNode: GainNode | null,
    hasSource: boolean,
    silentSinceSec: number,
    graceSec: number,
    lastTargetGain: number | undefined,
    tauSec: number,
    onStart: () => void,
    onStop: () => void
  ): [number, number | undefined] {
    if (!gainNode) return [silentSinceSec, lastTargetGain];
    const culled = !this.isSelf && listenerManager.hasListener && isDistanceCulled(dist, category);
    const distAtten = this.isSelf ? 1.0 : culled ? 0 : calculateIncidentDistanceGain(dist, category);
    const targetGain = active && this.isAlive && this.audible && !culled ? settingVol * master * selfMult * distAtten : 0;

    let nextSilent = silentSinceSec;
    if (targetGain > 1e-4) {
      nextSilent = -1;
      onStart();
    } else if (hasSource) {
      if (nextSilent < 0) nextSilent = now;
      else if (now - nextSilent >= graceSec) onStop();
    }

    let nextLast = lastTargetGain;
    if (nextLast === undefined || Math.abs(targetGain - nextLast) > 1e-4) {
      nextLast = targetGain;
      try { gainNode.gain.setTargetAtTime(targetGain, now, tauSec); } catch { /* ignore */ }
    }
    return [nextSilent, nextLast];
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

    [this._boostSilentSinceSec, this._lastTargetBoostGain] = this._stepLoopChannel(
      ctx, now, dist, this.isBoosting, 'boost_other',
      audioConfig.get('boostLoopVolume') * audioConfig.get('boostVolume'),
      master, selfMult, this.boostLoopGain, Boolean(this.boostLoopSource),
      this._boostSilentSinceSec, BOOST_LOOP_HIBERNATE_GRACE_SEC, this._lastTargetBoostGain, 0.035,
      () => this._ensureBoostLoopStarted(ctx, now), () => this._stopBoostLoopSource()
    );

    [this._superSilentSinceSec, this._lastTargetSuperGain] = this._stepLoopChannel(
      ctx, now, dist, this.isSupersonic, 'supersonic_other',
      audioConfig.get('supersonicLoopVolume') ?? audioConfig.get('supersonicVolume') ?? 1.0,
      master, selfMult, this.supersonicLoopGain, Boolean(this.supersonicLoopSource),
      this._superSilentSinceSec, SUPERSONIC_LOOP_HIBERNATE_GRACE_SEC, this._lastTargetSuperGain, 0.05,
      () => this._ensureSupersonicLoopStarted(ctx, now), () => this._stopSupersonicLoopSource()
    );
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
      const dist = Math.hypot(
        this.position.x - listenerManager.position.x,
        this.position.y - listenerManager.position.y,
        this.position.z - listenerManager.position.z
      );
      this._lastDist = dist;
      if (isDistanceCulled(dist, category, distanceRadiusScale)) return;
      effectiveVolume = baseVolume * calculateIncidentDistanceGain(dist, category, distanceRadiusScale);
    }
    if (effectiveVolume <= 1e-5 || !this.inputGain) return;

    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.setValueAtTime(playbackRate, now);

      const voiceGain = ctx.createGain();
      voiceGain.gain.setValueAtTime(effectiveVolume, now);

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
