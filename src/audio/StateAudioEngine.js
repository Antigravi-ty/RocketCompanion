import { audioConfig } from '../config/audioConfig.js';
import { getAudioContext, getMasterAudioInput } from './audioContext.js';
import { BallAudioEmitter } from './BallAudioEmitter.js';

export class StateAudioEngine {
  constructor() {
    this.ballEmitter = new BallAudioEmitter();
    this.supersonicBuffer = null;
    this.supersonicSource = null;
    this.supersonicGain = null;
    this.supersonicPanner = null;

    this.boostBuffer = null;
    this.boostSource = null;
    this.boostGain = null;
    this.boostPanner = null;

    this.initialized = false;
    this.isPlaying = false;
  }

  get ballRollingBuffer() { return this.ballEmitter?.ballRollingBuffer ?? null; }
  set ballRollingBuffer(val) { if (this.ballEmitter) this.ballEmitter.ballRollingBuffer = val; }

  get ballFlyingBuffer() { return this.ballEmitter?.ballFlyingBuffer ?? null; }
  set ballFlyingBuffer(val) { if (this.ballEmitter) this.ballEmitter.ballFlyingBuffer = val; }

  get rollingSource() { return this.ballEmitter?.rollingSource ?? null; }
  set rollingSource(val) { if (this.ballEmitter) this.ballEmitter.rollingSource = val; }

  get flyingSource() { return this.ballEmitter?.flyingSource ?? null; }
  set flyingSource(val) { if (this.ballEmitter) this.ballEmitter.flyingSource = val; }

  get rollingGain() { return this.ballEmitter?.rollingGain ?? null; }
  set rollingGain(val) { if (this.ballEmitter) this.ballEmitter.rollingGain = val; }

  get flyingGain() { return this.ballEmitter?.flyingGain ?? null; }
  set flyingGain(val) { if (this.ballEmitter) this.ballEmitter.flyingGain = val; }

  get ballPanner() { return this.ballEmitter?.ballPanner ?? null; }
  set ballPanner(val) { if (this.ballEmitter) this.ballEmitter.ballPanner = val; }

  get rollingPanner() { return this.ballEmitter?.ballPanner ?? null; }
  set rollingPanner(val) { if (this.ballEmitter) this.ballEmitter.ballPanner = val; }

  get flyingPanner() { return this.ballEmitter?.ballPanner ?? null; }
  set flyingPanner(val) { if (this.ballEmitter) this.ballEmitter.ballPanner = val; }

  init(buffers = {}) {
    const ctx = getAudioContext();
    const dest = getMasterAudioInput();
    if (!ctx) return;

    this.ballEmitter.init(buffers);

    if (!this.initialized) {
      const hasStereoPanner = typeof ctx.createStereoPanner === "function";
      if (!hasStereoPanner) {
        console.warn('[StateAudioEngine] AudioContext.createStereoPanner is unavailable; connecting supersonic and boost loop gains directly to destination.');
      }
      // Supersonic loop pipeline
      this.supersonicGain = ctx.createGain();
      this.supersonicGain.gain.setValueAtTime(0, ctx.currentTime);
      if (hasStereoPanner) {
        this.supersonicPanner = ctx.createStereoPanner();
        this.supersonicGain.connect(this.supersonicPanner);
        if (dest) this.supersonicPanner.connect(dest);
      } else {
        if (dest) this.supersonicGain.connect(dest);
      }

      // Boost loop pipeline
      this.boostGain = ctx.createGain();
      this.boostGain.gain.setValueAtTime(0, ctx.currentTime);
      if (hasStereoPanner) {
        this.boostPanner = ctx.createStereoPanner();
        this.boostGain.connect(this.boostPanner);
        if (dest) this.boostPanner.connect(dest);
      } else {
        if (dest) this.boostGain.connect(dest);
      }

      this.initialized = true;
    }

    if (buffers.ballRolling) this.ballRollingBuffer = buffers.ballRolling;
    if (buffers.ballFlying) this.ballFlyingBuffer = buffers.ballFlying;
    if (buffers.supersonicLoop || buffers.supersonic) this.supersonicBuffer = buffers.supersonicLoop || buffers.supersonic;
    if (buffers.boostLoop || buffers.boost) this.setBoostLoopBuffer(buffers.boostLoop || buffers.boost);

    this._startLoops();
  }

  setBoostLoopBuffer(newBuf) {
    if (!newBuf || this.boostBuffer === newBuf) return;
    this.boostBuffer = newBuf;
    if (this.boostSource) {
      try {
        this.boostSource.onended = null;
        this.boostSource.stop();
        this.boostSource.disconnect();
      } catch (err) {
        console.warn('[StateAudioEngine] Error stopping previous boostSource:', err);
      }
      this.boostSource = null;
    }
    if (this.initialized) {
      this._startLoops();
    }
  }

  _startLoops() {
    const ctx = getAudioContext();
    if (!this.initialized || !ctx || ctx.state === "closed") return;
    if (ctx.state === "suspended") {
      ctx.resume().catch((err) => console.warn('[AudioArchitecture] AudioContext resume failed/blocked:', err));
    }
    const now = ctx.currentTime;

    if (this.ballEmitter && typeof this.ballEmitter._startLoops === "function") {
      this.ballEmitter._startLoops();
    }

    if (this.supersonicBuffer && !this.supersonicSource) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = this.supersonicBuffer;
        src.loop = true;
        src.connect(this.supersonicGain);
        src.start(now);
        src.onended = () => { if (this.supersonicSource === src) this.supersonicSource = null; };
        this.supersonicSource = src;
      } catch (e) {
        console.warn('[VehicleBoostLoopAudio] Error starting supersonicSource:', e);
      }
    }

    if (this.boostBuffer && !this.boostSource) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = this.boostBuffer;
        src.loop = true;
        src.connect(this.boostGain);
        src.start(now);
        src.onended = () => { if (this.boostSource === src) this.boostSource = null; };
        this.boostSource = src;
      } catch (e) {
        console.warn('[VehicleBoostLoopAudio] Error starting boostSource:', e);
      }
    }

    this.isPlaying = Boolean(
      (this.rollingSource || !this.ballRollingBuffer) &&
      (this.flyingSource || !this.ballFlyingBuffer) &&
      (this.supersonicSource || !this.supersonicBuffer) &&
      (this.boostSource || !this.boostBuffer) &&
      (this.rollingSource || this.flyingSource || this.supersonicSource || this.boostSource)
    );
  }

  silenceAll() {
    this.ballEmitter.silenceAll();
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    try {
      if (this.supersonicGain) {
        this.supersonicGain.gain.cancelScheduledValues(now);
        this.supersonicGain.gain.setValueAtTime(0, now);
      }
      if (this.boostGain) {
        this.boostGain.gain.cancelScheduledValues(now);
        this.boostGain.gain.setValueAtTime(0, now);
      }
      this._lastSupersonicTargetGain = 0;
      this._lastBoostTargetGain = 0;
    } catch (e) {
      console.warn('[VehicleBoostLoopAudio] Error silencing boostGain:', e);
    }
  }

  updateBallAudio(ballViewOrMesh, camera, physics) {
    if (!this.initialized) return;
    this.ballEmitter.update(ballViewOrMesh, camera, physics);
  }

  updateSupersonic(isSupersonic, isMatchActive = true) {
    if (!this.initialized) return;
    if (this.supersonicBuffer && !this.supersonicSource) this._startLoops();
    const ctx = getAudioContext();
    if (!ctx || !this.supersonicGain) return;

    const now = ctx.currentTime;
    const master = audioConfig.get('masterVolume');
    const supersonicVol = audioConfig.get('supersonicVolume');
    const targetGain = (isSupersonic && isMatchActive) ? Math.max(0, Math.min(5.0, supersonicVol * master * 0.75)) : 0;

    if (this._lastSupersonicTargetGain === undefined || Math.abs(targetGain - this._lastSupersonicTargetGain) > 1e-4) {
      this._lastSupersonicTargetGain = targetGain;
      try {
        this.supersonicGain.gain.setTargetAtTime(targetGain, now, 0.05);
      } catch (e) {
        console.warn('[VehicleBoostLoopAudio] Error ramping supersonicGain:', e);
      }
    }
  }

  updateBoost(isBoosting, isMatchActive = true) {
    if (!this.initialized) return;
    if (this.boostBuffer && !this.boostSource) this._startLoops();
    const ctx = getAudioContext();
    if (!ctx || !this.boostGain) return;

    const now = ctx.currentTime;
    const master = audioConfig.get('masterVolume') ?? 1.0;
    const boostVol = audioConfig.get('boostLoopVolume') ?? audioConfig.get('boostVolume') ?? 0.8;
    const shouldPlay = Boolean(isBoosting && isMatchActive);
    const targetGain = shouldPlay ? Math.max(0, Math.min(5.0, boostVol * master)) : 0;

    if (this._lastBoostTargetGain === undefined || Math.abs(targetGain - this._lastBoostTargetGain) > 1e-4) {
      this._lastBoostTargetGain = targetGain;
      try {
        this.boostGain.gain.cancelScheduledValues(now);
        this.boostGain.gain.setValueAtTime(targetGain, now);
      } catch (e) {
        console.warn('[VehicleAudioEmitter] Error setting boost gain value:', e);
      }
    }
  }
}
