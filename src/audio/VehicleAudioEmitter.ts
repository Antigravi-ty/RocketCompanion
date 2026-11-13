import { audioConfig } from '../ui-core/config/audioConfig.ts';
import { getAudioContext, getAudioSlotPool, getMasterAudioInput } from './audioContext.ts';
import {
  listenerManager,
  toAudioCoordinates,
  getUuToMeters,
  isDistanceCulled,
  type AudioAttenuationCategory,
  type SpatialPositionInput,
  type SpatialVector3Like,
} from './SpatialAudioSource.ts';

function stopSrc(src: AudioBufferSourceNode | null): void {
  if (!src) return;
  try {
    src.onended = null;
    src.stop();
    src.disconnect();
  } catch {
    /* ignore */
  }
}

export class VehicleAudioEmitter {
  activeSources = new Set<AudioBufferSourceNode>();
  audible = true;
  boostLoopBuffer: AudioBuffer | null = null;
  boostLoopGain: GainNode | null = null;
  boostLoopSource: AudioBufferSourceNode | null = null;
  carIndex: number;
  initialized = false;
  inputGain: GainNode | null = null;
  isAlive = true;
  isBoosting = false;
  isSelf = false;
  isSupersonic = false;
  panner3D: PannerNode | null = null;
  position: SpatialVector3Like = { x: 0, y: 0, z: 0 };
  supersonicLoopBuffer: AudioBuffer | null = null;
  supersonicLoopGain: GainNode | null = null;
  supersonicLoopSource: AudioBufferSourceNode | null = null;
  private _dist = 0;

  constructor(carIndex: number) {
    this.carIndex = carIndex;
    this.init();
  }

  init(): void {
    const ctx = getAudioContext();
    const dest = getMasterAudioInput();
    if (this.initialized || !ctx || !dest) return;
    const p = ctx.createPanner();
    try {
      p.panningModel = audioConfig.get('spatialPanningModel') || 'equalpower';
    } catch {
      p.panningModel = 'equalpower';
    }
    p.rolloffFactor = 0;
    p.connect(dest);
    this.panner3D = p;
    const mk = (v: number, out: AudioNode): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(out);
      return g;
    };
    this.inputGain = mk(1.0, this.isSelf ? dest : p);
    this.boostLoopGain = mk(0, this.inputGain);
    this.supersonicLoopGain = mk(0, this.inputGain);
    this.initialized = true;
  }

  setSelf(isSelf: boolean): void {
    const val = Boolean(isSelf);
    if (this.isSelf === val) return;
    this.isSelf = val;
    const dest = getMasterAudioInput();
    if (!this.inputGain || !dest) return;
    try {
      this.inputGain.disconnect();
      this.inputGain.connect(this.isSelf ? dest : this.panner3D || dest);
    } catch {
      /* ignore */
    }
  }

  setBuffers(boostLoop: AudioBuffer | null, supersonicLoop: AudioBuffer | null): void {
    if (boostLoop && this.boostLoopBuffer !== boostLoop) {
      this.boostLoopBuffer = boostLoop;
      stopSrc(this.boostLoopSource);
      this.boostLoopSource = null;
    }
    if (supersonicLoop && this.supersonicLoopBuffer !== supersonicLoop) {
      this.supersonicLoopBuffer = supersonicLoop;
      stopSrc(this.supersonicLoopSource);
      this.supersonicLoopSource = null;
    }
    this._startLoops();
  }

  private _spawn(buf: AudioBuffer | null, gain: GainNode | null, clear: () => void) {
    const ctx = getAudioContext();
    if (!ctx || !buf || !gain) return null;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start(ctx.currentTime, buf.duration > 0.1 ? Math.random() * buf.duration * 0.8 : 0);
      src.onended = clear;
      return src;
    } catch {
      return null;
    }
  }

  _startLoops(): void {
    if (!this.initialized || !this.isAlive || !this.audible) return;
    const d = !this.isSelf && listenerManager.hasListener ? this._dist : 0;
    if (
      this.isBoosting &&
      !this.boostLoopSource &&
      (this.isSelf || !isDistanceCulled(d, 'boost_other'))
    ) {
      this.boostLoopSource = this._spawn(this.boostLoopBuffer, this.boostLoopGain, () => {
        this.boostLoopSource = null;
      });
    }
    if (
      this.isSupersonic &&
      !this.supersonicLoopSource &&
      (this.isSelf || !isDistanceCulled(d, 'supersonic_other'))
    ) {
      this.supersonicLoopSource = this._spawn(
        this.supersonicLoopBuffer,
        this.supersonicLoopGain,
        () => {
          this.supersonicLoopSource = null;
        }
      );
    }
  }

  updatePosition(pos: SpatialPositionInput | null | undefined): void {
    const p = toAudioCoordinates(this.position, pos);
    if (!p) return;
    if (!this.isSelf && this.panner3D) {
      const s = getUuToMeters();
      if (this.panner3D.positionX) {
        this.panner3D.positionX.value = p.x * s;
        this.panner3D.positionY.value = p.y * s;
        this.panner3D.positionZ.value = p.z * s;
      } else {
        this.panner3D.setPosition?.(p.x * s, p.y * s, p.z * s);
      }
      this._dist = listenerManager.hasListener
        ? Math.hypot(
            p.x - listenerManager.position.x,
            p.y - listenerManager.position.y,
            p.z - listenerManager.position.z
          )
        : 0;
    } else {
      this._dist = 0;
    }
  }

  updateState(
    isBoosting: boolean,
    isSupersonic: boolean,
    isAlive: boolean,
    audible: boolean
  ): void {
    const base =
      audioConfig.get('masterVolume') * (this.isSelf ? audioConfig.get('vehicleSelfVolume') : 1.0);
    const bGain = isBoosting
      ? audioConfig.get('boostLoopVolume') * audioConfig.get('boostVolume') * base
      : 0;
    const sGain = isSupersonic ? (audioConfig.get('supersonicLoopVolume') ?? 1.0) * base : 0;
    this.applyWasmState(bGain, 1.0, sGain, isAlive, audible);
  }

  applyWasmState(
    boostGain: number,
    boostPitch: number,
    supersonicGain: number,
    isAlive: boolean,
    audible: boolean
  ): void {
    if (!this.initialized) this.init();
    this.isAlive = isAlive;
    this.audible = audible;
    const bGain = isAlive && audible ? Math.max(0, boostGain) : 0;
    const sGain = isAlive && audible ? Math.max(0, supersonicGain) : 0;
    this.isBoosting = bGain > 1e-4;
    this.isSupersonic = sGain > 1e-4;
    if (this.isBoosting || this.isSupersonic) this._startLoops();
    if (!this.isBoosting && this.boostLoopSource) {
      stopSrc(this.boostLoopSource);
      this.boostLoopSource = null;
    }
    if (!this.isSupersonic && this.supersonicLoopSource) {
      stopSrc(this.supersonicLoopSource);
      this.supersonicLoopSource = null;
    }
    if (this.boostLoopGain) this.boostLoopGain.gain.value = bGain;
    if (this.boostLoopSource?.playbackRate && this.isBoosting) {
      const pitch = Math.max(0.5, Math.min(2.0, boostPitch || 1.0));
      if (Math.abs(this.boostLoopSource.playbackRate.value - pitch) > 1e-3) {
        this.boostLoopSource.playbackRate.value = pitch;
      }
    }
    if (this.supersonicLoopGain) this.supersonicLoopGain.gain.value = sGain;
  }

  playAction(
    buf: AudioBuffer | null,
    volume = 1.0,
    playbackRate = 1.0,
    category: AudioAttenuationCategory | string = 'jump_dodge_other',
    distanceRadiusScale = 1.0
  ): void {
    if (!buf) return;
    getAudioSlotPool()?.playBuffer(buf, {
      volume,
      playbackRate,
      position: this.isSelf ? null : { ...this.position, isAudioCoords: true },
      category,
      distanceRadiusScale,
    });
  }

  silenceAll(): void {
    stopSrc(this.boostLoopSource);
    stopSrc(this.supersonicLoopSource);
    this.boostLoopSource = null;
    this.supersonicLoopSource = null;
    if (this.boostLoopGain) this.boostLoopGain.gain.value = 0;
    if (this.supersonicLoopGain) this.supersonicLoopGain.gain.value = 0;
    for (const s of this.activeSources) stopSrc(s);
    this.activeSources.clear();
  }
}
