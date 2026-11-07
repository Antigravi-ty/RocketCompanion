/**
 * SpatialAudioBusChain.ts
 * Stereo stadium impulse response synthesis and Web Audio spatial filter + reverb + dry/wet mix bus.
 */

import {
  DEFAULT_SPATIAL_AUDIO_TUNER_CONFIG,
  solveCubicBezier,
  type SpatialAudioTunerConfig,
} from "../ui-core/config/spatialAudioConfig";

export interface SampleOutputPeakResult {
  peak: number;
  valid: boolean;
}

export interface SpatialAudioRuntimeContextSnapshot {
  isOpen: boolean;
  matchMode: string;
  onlineSession: Record<string, unknown> | null;
  matchPhase: string;
  choreographySignal: string | null;
  replayScorerAnthemId: string | null;
  staticTrainingReplayType: string | null;
}

export function evaluateSpatialBezierBlend(
  phase: number,
  cfg: Partial<SpatialAudioTunerConfig>
): number {
  if (cfg.overrideMode === 'manual') {
    return Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0));
  }
  return solveCubicBezier(
    phase,
    Number(cfg.bzX1) || 0.22,
    Number(cfg.bzY1) || 1.0,
    Number(cfg.bzX2) || 1.0,
    Number(cfg.bzY2) || 1.0
  );
}

export function stepSpatialBezierTransition(
  currentLinearPhase: number,
  targetU: number,
  maxDelta: number,
  cfg: Partial<SpatialAudioTunerConfig>
): { linearPhase: number; blend: number } {
  if (cfg.overrideMode === 'manual') {
    return { linearPhase: targetU, blend: targetU };
  }
  let linearPhase = targetU;
  if (Math.abs(targetU - currentLinearPhase) > 1e-4) {
    linearPhase =
      targetU > currentLinearPhase
        ? Math.min(targetU, currentLinearPhase + maxDelta)
        : Math.max(targetU, currentLinearPhase - maxDelta);
  }
  return {
    linearPhase,
    blend: evaluateSpatialBezierBlend(linearPhase, cfg),
  };
}

export function buildStadiumImpulseBuffer(
  ctx: AudioContext,
  durationSec = 3.0
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const seconds = Math.max(0.4, Math.min(8.0, Number(durationSec) || 3.0));
  const length = Math.floor(sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  const preDelaySamples = Math.floor(0.025 * sampleRate);
  const fadeInSamples = Math.max(1, Math.floor(0.005 * sampleRate));
  const fadeOutSamples = Math.max(1, Math.floor(0.01 * sampleRate));
  const earlyReflections = [
    { delay: Math.floor(0.035 * sampleRate), gain: 0.7 },
    { delay: Math.floor(0.065 * sampleRate), gain: 0.5 },
    { delay: Math.floor(0.11 * sampleRate), gain: 0.35 },
    { delay: Math.floor(0.16 * sampleRate), gain: 0.25 },
  ];

  let lpL = 0;
  let lpR = 0;
  let sumL = 0;
  let sumR = 0;
  const rc = 1.0 / (2.0 * Math.PI * 1500);
  const dt = 1.0 / sampleRate;
  const alpha = dt / (rc + dt);

  for (let i = 0; i < length; i++) {
    if (i < preDelaySamples) {
      left[i] = 0;
      right[i] = 0;
      continue;
    }

    let sampleL = 0;
    let sampleR = 0;
    for (let r = 0; r < earlyReflections.length; r++) {
      const ref = earlyReflections[r];
      if (Math.abs(i - ref.delay) < 5) {
        sampleL += (Math.random() * 2 - 1) * ref.gain;
        sampleR += (Math.random() * 2 - 1) * ref.gain;
      }
    }

    const activeIdx = i - preDelaySamples;
    const activeLen = Math.max(1, length - preDelaySamples);
    const progress = activeIdx / activeLen;
    const env = Math.pow(1 - progress, 3.2);
    const noiseL = (Math.random() * 2 - 1) * env * 0.5;
    const noiseR = (Math.random() * 2 - 1) * env * 0.5;

    lpL = lpL + alpha * (noiseL - lpL);
    lpR = lpR + alpha * (noiseR - lpR);

    let boundaryEnv = 1.0;
    if (activeIdx < fadeInSamples) {
      boundaryEnv = activeIdx / fadeInSamples;
    } else if (length - 1 - i < fadeOutSamples) {
      boundaryEnv = (length - 1 - i) / fadeOutSamples;
    }

    const outL = (sampleL + lpL) * boundaryEnv;
    const outR = (sampleR + lpR) * boundaryEnv;
    left[i] = outL;
    right[i] = outR;
    sumL += outL;
    sumR += outR;
  }

  // Remove any residual DC offset in the active portion of the impulse response
  const activeCount = Math.max(1, length - preDelaySamples);
  const meanL = sumL / activeCount;
  const meanR = sumR / activeCount;
  for (let i = preDelaySamples; i < length; i++) {
    left[i] -= meanL;
    right[i] -= meanR;
  }
  left[length - 1] = 0;
  right[length - 1] = 0;

  return impulse;
}

export const TAIL_DRAIN_MIN_GUARD_SEC = 0.25;
export const TAIL_DRAIN_SILENCE_THRESHOLD = 5e-5;
export const TAIL_DRAIN_SILENCE_HOLD_SEC = 0.35;
export const TAIL_DRAIN_SAFETY_MARGIN_SEC = 0.5;

/**
 * Encapsulates an independent Web Audio spatial filter + stadium reverb + dry/wet mix chain.
 * Used separately by the Player Anthem bus and the Background Music bus so their opposite
 * spatial polarities never interfere, while sharing identical acoustic parameters from
 * Spatial Audio & Anthem Tuner.
 */
export class SpatialAudioBusChain {
  readonly ctx: AudioContext;
  impulseBuffer: AudioBuffer | null;
  readonly input: GainNode;
  readonly hpf: BiquadFilterNode;
  readonly lpf: BiquadFilterNode;
  convolver: ConvolverNode;
  readonly dryGain: GainNode;
  readonly wetGain: GainNode;
  readonly output: GainNode;
  readonly analyser: AnalyserNode | null;
  private readonly _analyserBuffer: Float32Array<ArrayBuffer> | null;
  private _lastLpf = -1;
  private _lastHpf = -1;
  private _lastWet = -1;
  private _lastDry = -1;
  private _lastOut = -1;

  constructor(
    ctx: AudioContext,
    destination: AudioNode,
    impulseBuffer: AudioBuffer | null = null
  ) {
    this.ctx = ctx;
    this.impulseBuffer = impulseBuffer || null;
    this.input = ctx.createGain();
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    // Use 20Hz subsonic floor instead of 0Hz to avoid degenerate biquad pole on unit circle
    this.hpf.frequency.value = 20;
    this.hpf.Q.value = 0.707;

    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 20000;
    this.lpf.Q.value = 0.707;

    this.convolver = ctx.createConvolver();
    if (impulseBuffer) {
      this.convolver.buffer = impulseBuffer;
    }

    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1.0;

    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.0;

    this.output = ctx.createGain();
    // Start silent (0.0) so newly initialized chains never emit transient pops
    this.output.gain.value = 0.0;

    let analyser: AnalyserNode | null = null;
    let analyserBuffer: Float32Array<ArrayBuffer> | null = null;
    if (typeof ctx.createAnalyser === 'function') {
      try {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0;
        analyserBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      } catch {
        analyser = null;
        analyserBuffer = null;
      }
    }
    this.analyser = analyser;
    this._analyserBuffer = analyserBuffer;

    // Signal routing: input -> HPF -> LPF -> [dryGain, convolver -> wetGain] -> output -> destination
    this.input.connect(this.hpf);
    this.hpf.connect(this.lpf);
    this.lpf.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.lpf.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.output);
    if (this.analyser) {
      this.output.connect(this.analyser);
    }
    this.output.connect(destination);
  }

  sampleOutputPeak(): SampleOutputPeakResult {
    if (
      !this.analyser ||
      !this._analyserBuffer ||
      !this.ctx ||
      this.ctx.state !== 'running'
    ) {
      return { peak: 0, valid: false };
    }
    try {
      this.analyser.getFloatTimeDomainData(this._analyserBuffer);
      let peak = 0;
      const buf = this._analyserBuffer;
      const len = buf.length;
      for (let i = 0; i < len; i++) {
        const v = buf[i];
        if (Number.isFinite(v)) {
          const abs = Math.abs(v);
          if (abs > peak) peak = abs;
        }
      }
      return { peak, valid: true };
    } catch {
      return { peak: 0, valid: false };
    }
  }

  private _setParam(param: AudioParam, value: number, immediate = false): void {
    if (!param || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      if (immediate || this.ctx.state !== 'running') {
        param.cancelScheduledValues(now);
        param.setValueAtTime(value, now);
        param.value = value;
      } else {
        param.setTargetAtTime(value, now, 0.015);
      }
    } catch {
      param.value = value;
    }
  }

  /**
   * Web Audio ConvolverNode.buffer cannot be mutated in-place once active;
   * create a fresh ConvolverNode and swap connections cleanly.
   */
  setImpulseBuffer(impulseBuffer: AudioBuffer | null): void {
    if (!impulseBuffer || !this.ctx) return;
    this.impulseBuffer = impulseBuffer;
    try {
      const nextConvolver = this.ctx.createConvolver();
      nextConvolver.buffer = impulseBuffer;
      this.lpf.connect(nextConvolver);
      nextConvolver.connect(this.wetGain);
      if (this.convolver) {
        try {
          this.lpf.disconnect(this.convolver);
        } catch {
          // ignore
        }
        try {
          this.convolver.disconnect();
        } catch {
          // ignore
        }
      }
      this.convolver = nextConvolver;
    } catch (err) {
      console.warn('[SpatialAudioBusChain] Failed to swap convolver impulse buffer:', err);
    }
  }

  /**
   * Immediately zeroes wet/output gains and swaps the ConvolverNode so any
   * accumulated stadium reverb tail is purged with zero echo bleed.
   */
  resetAndSilence(cfg: Partial<SpatialAudioTunerConfig> = DEFAULT_SPATIAL_AUDIO_TUNER_CONFIG): void {
    this._lastLpf = -1;
    this._lastHpf = -1;
    this._lastWet = -1;
    this._lastDry = -1;
    this._lastOut = -1;
    this.applyBlend(0.0, cfg, 0.0, true);
    if (this.impulseBuffer) {
      this.setImpulseBuffer(this.impulseBuffer);
    }
  }

  applyBlend(
    blend: number,
    cfg: Partial<SpatialAudioTunerConfig> = DEFAULT_SPATIAL_AUDIO_TUNER_CONFIG,
    outputGain = 1.0,
    immediate = false
  ): void {
    const b = Math.max(0, Math.min(1, Number.isFinite(Number(blend)) ? Number(blend) : 0));
    const maxFreq = 20000;
    const rawLpf = Number(cfg.lpfMinFreq);
    const minLpf = Math.max(100, Math.min(maxFreq, Number.isFinite(rawLpf) ? rawLpf : 3500));
    const rawHpf = Number(cfg.hpfMaxFreq);
    const maxHpf = Math.max(20, Math.min(5000, Number.isFinite(rawHpf) ? rawHpf : 425));
    const rawWetPct = Number(cfg.wetMaxPct);
    const targetWet = Math.max(0, Math.min(1, (Number.isFinite(rawWetPct) ? rawWetPct : 69) / 100));
    const rawWetBoost = Number(cfg.wetBoost);
    const wetBoost = Math.max(0.1, Number.isFinite(rawWetBoost) ? rawWetBoost : 1.35);

    const currentLpf = maxFreq * Math.pow(minLpf / maxFreq, b);
    const currentHpf = 20 + b * Math.max(0, maxHpf - 20);
    const currentWet = b * targetWet * wetBoost;
    const currentDry = Math.max(0, 1.0 - b * (targetWet * 0.6));
    const currentOut = Math.max(0, Math.min(2, Number.isFinite(Number(outputGain)) ? Number(outputGain) : 1.0));

    if (immediate || Math.abs(currentLpf - this._lastLpf) > 0.05) {
      this._lastLpf = currentLpf;
      this._setParam(this.lpf.frequency, currentLpf, immediate);
    }
    if (immediate || Math.abs(currentHpf - this._lastHpf) > 0.05) {
      this._lastHpf = currentHpf;
      this._setParam(this.hpf.frequency, currentHpf, immediate);
    }
    if (immediate || Math.abs(currentWet - this._lastWet) > 1e-4) {
      this._lastWet = currentWet;
      this._setParam(this.wetGain.gain, currentWet, immediate);
    }
    if (immediate || Math.abs(currentDry - this._lastDry) > 1e-4) {
      this._lastDry = currentDry;
      this._setParam(this.dryGain.gain, currentDry, immediate);
    }
    if (immediate || Math.abs(currentOut - this._lastOut) > 1e-4) {
      this._lastOut = currentOut;
      this._setParam(this.output.gain, currentOut, immediate);
    }
  }
}
