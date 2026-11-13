import { audioConfig } from '../ui-core/config/audioConfig.ts';
import { getAudioContext, getMasterAudioInput } from './audioContext.ts';
import type { BallAudioBuffers } from './audioAssetLoader.ts';
import type { WasmBallAudioTarget } from './WasmAudioDirectorBridge.ts';

export class BallAudioEmitter implements WasmBallAudioTarget {
  initialized = false;
  context: AudioContext | null = null;
  destinationNode: AudioNode | null = null;
  ballRollingBuffer: AudioBuffer | null = null;
  ballFlyingBuffer: AudioBuffer | null = null;
  rollingSource: AudioBufferSourceNode | null = null;
  flyingSource: AudioBufferSourceNode | null = null;
  rollingGain: GainNode | null = null;
  flyingGain: GainNode | null = null;
  ballPanner: PannerNode | null = null;
  position = { x: 0, y: 0, z: 0 };
  _lastPanX: number | undefined;
  _lastPanY: number | undefined;
  _lastPanZ: number | undefined;
  _lastTargetRollingGain: number | undefined;
  _smoothedRollingGain = 0;
  _lastWrittenRollingGain: number | undefined;
  _smoothedRollingRate = 1.0;
  _lastRollingRate: number | undefined;
  _lastTargetFlyingGain: number | undefined;
  _smoothedFlyingGain = 0;
  _lastWrittenFlyingGain: number | undefined;
  _smoothedFlyingRate = 1.0;
  _lastFlyingRate: number | undefined;
  _wasRolling = false;
  _wasFallingDownward = false;

  init(buffers: BallAudioBuffers = {}): void {
    if (buffers.ballRolling) this.ballRollingBuffer = buffers.ballRolling;
    if (buffers.ballFlying) this.ballFlyingBuffer = buffers.ballFlying;

    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    this.context = ctx;
    const dest = this.destinationNode || getMasterAudioInput();

    if (!this.initialized) {
      const panner = ctx.createPanner();
      const panModel = audioConfig.get('spatialPanningModel') || 'equalpower';
      try {
        panner.panningModel = panModel;
      } catch {
        panner.panningModel = 'equalpower';
      }
      panner.distanceModel = 'inverse';
      panner.rolloffFactor = 0;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.channelCount = 1;
      panner.channelCountMode = 'explicit';
      panner.channelInterpretation = 'speakers';
      if (dest) panner.connect(dest);
      this.ballPanner = panner;

      this.rollingGain = ctx.createGain();
      this.rollingGain.gain.value = 0;
      this.rollingGain.connect(panner);

      this.flyingGain = ctx.createGain();
      this.flyingGain.gain.value = 0;
      this.flyingGain.connect(panner);

      this.initialized = true;
    }

    this._startLoops();
  }

  _startLoops(): void {
    const ctx = this.context || getAudioContext();
    if (!this.initialized || !ctx || ctx.state === 'closed') return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;

    if (this.ballRollingBuffer && !this.rollingSource && this.rollingGain) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = this.ballRollingBuffer;
        src.loop = true;
        src.connect(this.rollingGain);
        src.start(now);
        src.onended = () => {
          if (this.rollingSource === src) this.rollingSource = null;
        };
        this.rollingSource = src;
      } catch {
        /* ignore */
      }
    }

    if (this.ballFlyingBuffer && !this.flyingSource && this.flyingGain) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = this.ballFlyingBuffer;
        src.loop = true;
        src.connect(this.flyingGain);
        src.start(now);
        src.onended = () => {
          if (this.flyingSource === src) this.flyingSource = null;
        };
        this.flyingSource = src;
      } catch {
        /* ignore */
      }
    }
  }

  silenceAll(): void {
    const ctx = this.context || getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    try {
      if (this.rollingGain) {
        this.rollingGain.gain.cancelScheduledValues(now);
        this.rollingGain.gain.value = 0;
      }
      if (this.flyingGain) {
        this.flyingGain.gain.cancelScheduledValues(now);
        this.flyingGain.gain.value = 0;
      }
    } catch {
      /* ignore */
    }
    this._wasRolling = false;
    this._wasFallingDownward = false;
    this._smoothedRollingGain = 0;
    this._smoothedFlyingGain = 0;
    this._lastTargetRollingGain = 0;
    this._lastTargetFlyingGain = 0;
    this._lastWrittenRollingGain = 0;
    this._lastWrittenFlyingGain = 0;
  }

  updatePanningModel(model: PanningModelType | null | undefined): void {
    if (this.ballPanner && model) {
      try {
        this.ballPanner.panningModel = model;
      } catch {
        this.ballPanner.panningModel = 'equalpower';
      }
    }
  }

  update(_ballViewOrMesh?: unknown, _camera?: unknown, _physics?: unknown): void {
    /* Driven by WASM rc_audio_director via applyWasmBallCueToEmitter */
  }
}
