/**
 * Replaces sample-based engine audio with a real-time Web Audio additive
 * synthesis model simulating high-frequency electric powertrain whine.
 * 
 * Formulas & Parameters:
 * - Speed mapping: 0–2200 uu/s -> 0–100 km/h; 2200–2300 uu/s -> 100–120 km/h
 * - Factor: 0–40 km/h -> 0.0~0.7; 40–120 km/h -> 0.7~1.0
 * - Base fundamental frequency: 70 + factor * 430 Hz (sine wave)
 * - mainSoftNode.gain = 0.03 (fixed, non-configurable)
 * - Harmonic array: [1/3, 2/3, 1/5, 3/5, 1/7, 3/7, 5/7, 1/11, 4/11, 6/11, 9/11]
 * - harmonicMainGain = 0.6 (fixed, non-configurable)
 * - Each harmonic modulated by individual LFO (0.2–1.5 Hz) and depth (0.05–0.20)
 * - harmonicFilter: Lowpass filter dynamic cutoff 1000–2500 Hz
 * - Engine audio volume independently adjustable
 */

import { audioConfig } from '../config/audioConfig.js';

const HARMONIC_RATIOS = [1/3, 2/3, 1/5, 3/5, 1/7, 3/7, 5/7, 1/11, 4/11, 6/11, 9/11];

export class EMotorSynth {
  constructor(context, destinationNode = null) {
    this.context = context;
    this.destination = destinationNode || context.destination;

    // Fixed synth parameters (strictly non-configurable per spec)
    this.HARMONIC_MAIN_GAIN = 0.6;
    this.MAIN_SOFT_GAIN = 0.03;

    // User-adjustable volume (0.0 to 1.0)
    this.engineVolume = 0.8;

    this.active = false;
    this.alive = true;
    this.audible = true;
    this.disposed = false;

    // Master node for this synth instance
    this.outputNode = this.context.createGain();
    this.outputNode.gain.setValueAtTime(0, this.context.currentTime);
    this.outputNode.connect(this.destination);

    // Filter for non-integer harmonics (1000 Hz - 2500 Hz)
    this.harmonicFilter = this.context.createBiquadFilter();
    this.harmonicFilter.type = 'lowpass';
    this.harmonicFilter.frequency.setValueAtTime(1000, this.context.currentTime);
    this.harmonicFilter.Q.setValueAtTime(1.0, this.context.currentTime);

    // Fixed harmonic gain bus
    this.harmonicGainNode = this.context.createGain();
    this.harmonicGainNode.gain.setValueAtTime(this.HARMONIC_MAIN_GAIN, this.context.currentTime);
    this.harmonicGainNode.connect(this.harmonicFilter);
    this.harmonicFilter.connect(this.outputNode);

    // Base fundamental sine oscillator
    this.baseOsc = this.context.createOscillator();
    this.baseOsc.type = 'sine';
    this.baseOsc.frequency.setValueAtTime(70, this.context.currentTime);

    // Fixed main soft node gain
    this.mainSoftNode = this.context.createGain();
    this.mainSoftNode.gain.setValueAtTime(this.MAIN_SOFT_GAIN, this.context.currentTime);
    this.baseOsc.connect(this.mainSoftNode);
    this.mainSoftNode.connect(this.outputNode);

    // Harmonics and individual LFOs
    this.harmonicNodes = [];
    const numHarmonics = HARMONIC_RATIOS.length;

    for (let i = 0; i < numHarmonics; i++) {
      const ratio = HARMONIC_RATIOS[i];
      const osc = this.context.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(70 * (1 + ratio), this.context.currentTime);

      const hGain = this.context.createGain();
      const baseGain = (1 / numHarmonics);
      hGain.gain.setValueAtTime(baseGain, this.context.currentTime);

      // Individual LFO (0.2 Hz - 1.5 Hz) and depth (0.05 - 0.20)
      const lfoRate = 0.2 + (i / (numHarmonics - 1)) * (1.5 - 0.2);
      const lfoDepth = 0.05 + (i / (numHarmonics - 1)) * (0.20 - 0.05);

      const lfo = this.context.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(lfoRate, this.context.currentTime);

      const lfoGain = this.context.createGain();
      lfoGain.gain.setValueAtTime(baseGain * lfoDepth, this.context.currentTime);

      lfo.connect(lfoGain);
      lfoGain.connect(hGain.gain);

      osc.connect(hGain);
      hGain.connect(this.harmonicGainNode);

      try {
        osc.start();
        lfo.start();
      } catch (e) {
        console.warn('[EMotorSynth] Failed to start harmonic oscillator or LFO:', e);
      }

      this.harmonicNodes.push({
        ratio,
        osc,
        hGain,
        lfo,
        lfoGain,
        baseGain,
        lfoDepth
      });
    }

    try {
      this.baseOsc.start();
    } catch (e) {
      console.warn('[EMotorSynth] Failed to start baseOsc:', e);
    }
  }

  /**
   * Convert Unreal Units/sec to simulated km/h
   */
  static speedToKmh(uuSpeed) {
    const s = Math.abs(uuSpeed);
    if (s <= 2200) {
      return (s / 2200) * 100;
    } else {
      return 100 + ((Math.min(s, 2300) - 2200) / 100) * 20;
    }
  }

  /**
   * Convert km/h to normalized pitch/frequency factor [0, 1]
   */
  static kmhToFactor(kmh) {
    const k = Math.max(0, Math.min(120, kmh));
    if (k <= 40) {
      return (k / 40) * 0.7;
    } else {
      return 0.7 + ((k - 40) / 80) * 0.3;
    }
  }

  setVolume(vol) {
    if (Number.isFinite(vol)) {
      this.engineVolume = Math.max(0, Math.min(1, vol));
      if (this.active && this.alive && this.audible) {
        const now = this.context.currentTime;
        this.outputNode.gain.cancelScheduledValues(now);
        this.outputNode.gain.linearRampToValueAtTime(this.engineVolume, now + 0.05);
      }
    }
  }

  update(params = {}) {
    if (this.disposed || !this.context) return;
    if (this.context.state !== 'running') {
      this.active = false;
      const continueOnBlur = typeof audioConfig !== 'undefined' && audioConfig?.get ? audioConfig.get('continueAudioOnLostFocus') : false;
      const isHidden = typeof document !== 'undefined' ? (document.hidden && !continueOnBlur) : false;
      if (params.audible !== false && !isHidden && (this.context.state === 'suspended' || this.context.state === 'interrupted')) {
        this.context.resume().catch((err) => {
          console.warn('[EMotorSynth] AudioContext resume failed/blocked:', err);
        });
      }
      return;
    }

    const rawSpeed = params.forwardSpeed !== undefined ? params.forwardSpeed : (params.speed || 0);
    this.alive = params.alive !== false;
    const continueOnBlur = typeof audioConfig !== 'undefined' && audioConfig?.get ? audioConfig.get('continueAudioOnLostFocus') : false;
    const isHidden = typeof document !== 'undefined' ? (document.hidden && !continueOnBlur) : false;
    this.audible = params.audible !== false && !isHidden;

    const shouldPlay = this.alive && this.audible;
    const now = this.context.currentTime;

    if (!shouldPlay) {
      if (this.active) {
        this.outputNode.gain.cancelScheduledValues(now);
        this.outputNode.gain.linearRampToValueAtTime(0, now + 0.08);
        this.active = false;
      }
      return;
    }

    if (!this.active) {
      this.outputNode.gain.cancelScheduledValues(now);
      this.outputNode.gain.setValueAtTime(0, now);
      this.outputNode.gain.linearRampToValueAtTime(this.engineVolume, now + 0.08);
      this.active = true;
    }

    // Compute frequencies
    const kmh = EMotorSynth.speedToKmh(rawSpeed);
    const factor = EMotorSynth.kmhToFactor(kmh);
    const baseFreq = 70 + factor * 430;
    const cutoffFreq = 1000 + factor * 1500;

    if (this._lastBaseFreq === undefined || Math.abs(baseFreq - this._lastBaseFreq) > 0.05) {
      this._lastBaseFreq = baseFreq;
      // Apply smooth frequency transitions
      this.baseOsc.frequency.setTargetAtTime(baseFreq, now, 0.03);
      this.harmonicFilter.frequency.setTargetAtTime(cutoffFreq, now, 0.03);

      for (const harmonicNode of this.harmonicNodes) {
        const hFreq = baseFreq * (1 + harmonicNode.ratio);
        harmonicNode.osc.frequency.setTargetAtTime(hFreq, now, 0.03);
      }
    }
  }

  silence() {
    if (this.context && this.outputNode) {
      const now = this.context.currentTime;
      this.outputNode.gain.cancelScheduledValues(now);
      this.outputNode.gain.setValueAtTime(0, now);
    }
    this.active = false;
    this._lastBaseFreq = undefined;
  }

  reset() {
    this.silence();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.silence();

    try {
      this.baseOsc.stop();
      this.baseOsc.disconnect();
      this.mainSoftNode.disconnect();
      this.harmonicGainNode.disconnect();
      this.harmonicFilter.disconnect();
      this.outputNode.disconnect();

      for (const harmonicNode of this.harmonicNodes) {
        harmonicNode.osc.stop();
        harmonicNode.lfo.stop();
        harmonicNode.osc.disconnect();
        harmonicNode.lfo.disconnect();
        harmonicNode.lfoGain.disconnect();
        harmonicNode.hGain.disconnect();
      }
    } catch (e) {
      console.warn('[EMotorSynth] Error stopping/disconnecting synth nodes on dispose:', e);
    }
  }
}
