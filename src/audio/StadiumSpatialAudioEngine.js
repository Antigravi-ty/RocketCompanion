import { audioConfig } from '../ui-core/config/audioConfig.js';
import { getAudioContext, getMasterAudioInput } from './audioContext.js';
import {
  resolvePlayableAnthemDef,
  solveCubicBezier,
  DEFAULT_SPATIAL_AUDIO_TUNER_CONFIG,
  DEFAULT_BGM_SCENE_CONFIG,
} from '../ui-core/config/spatialAudioConfig';
import {
  useSpatialAudioStore,
  getFilteredBgmTracks,
} from '../ui-core/stores/spatialAudioStore';
import { useHudStore } from '../ui-core/stores/hudStore';
import { useAppStore } from '../ui-core/stores/appStore';
import { useStaticTrainingPackStore } from '../ui-core/stores/staticTrainingPackStore';

/**
 * Generates a stereo stadium impulse response buffer matching spaceaudio/new:
 * - Pre-delay: 25ms
 * - Early reflections at 35ms, 65ms, 110ms, 160ms
 * - Exponential noise decay + 1500Hz low-pass damping on the reverb tail
 */
function buildStadiumImpulseBuffer(ctx, durationSec = 3.0) {
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

/**
 * Encapsulates an independent Web Audio spatial filter + stadium reverb + dry/wet mix chain.
 * Used separately by the Player Anthem bus and the Background Music bus so their opposite
 * spatial polarities never interfere, while sharing identical acoustic parameters from
 * Spatial Audio & Anthem Tuner.
 */
class SpatialAudioBusChain {
  constructor(ctx, destination, impulseBuffer) {
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

    this._lastLpf = -1;
    this._lastHpf = -1;
    this._lastWet = -1;
    this._lastDry = -1;
    this._lastOut = -1;

    // Signal routing: input -> HPF -> LPF -> [dryGain, convolver -> wetGain] -> output -> destination
    this.input.connect(this.hpf);
    this.hpf.connect(this.lpf);
    this.lpf.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.lpf.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.output.connect(destination);
  }

  _setParam(param, value, immediate = false) {
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
  setImpulseBuffer(impulseBuffer) {
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
  resetAndSilence(cfg = DEFAULT_SPATIAL_AUDIO_TUNER_CONFIG) {
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
    blend,
    cfg = DEFAULT_SPATIAL_AUDIO_TUNER_CONFIG,
    outputGain = 1.0,
    immediate = false
  ) {
    const b = Math.max(0, Math.min(1, Number.isFinite(Number(blend)) ? Number(blend) : 0));
    const maxFreq = 20000;
    const rawLpf = Number(cfg.lpfMinFreq);
    const minLpf = Math.max(
      100,
      Math.min(maxFreq, Number.isFinite(rawLpf) ? rawLpf : 3500)
    );
    const rawHpf = Number(cfg.hpfMaxFreq);
    const maxHpf = Math.max(
      20,
      Math.min(5000, Number.isFinite(rawHpf) ? rawHpf : 425)
    );
    const rawWetPct = Number(cfg.wetMaxPct);
    const targetWet = Math.max(
      0,
      Math.min(1, (Number.isFinite(rawWetPct) ? rawWetPct : 69) / 100)
    );
    const rawWetBoost = Number(cfg.wetBoost);
    const wetBoost = Math.max(
      0.1,
      Number.isFinite(rawWetBoost) ? rawWetBoost : 1.35
    );

    const currentLpf = maxFreq * Math.pow(minLpf / maxFreq, b);
    const currentHpf = 20 + b * Math.max(0, maxHpf - 20);
    const currentWet = b * targetWet * wetBoost;
    const currentDry = Math.max(0, 1.0 - b * (targetWet * 0.6));
    const currentOut = Math.max(
      0,
      Math.min(2, Number.isFinite(Number(outputGain)) ? Number(outputGain) : 1.0)
    );

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

export class StadiumSpatialAudioEngine {
  constructor() {
    this.ctx = null;
    this.impulseBuffer = null;
    this.lastImpulseDecaySec = -1;
    this._decayRebuildTimer = null;

    this.anthemChain = null;
    this.bgmChain = null;

    // Player Anthem buffer cache & active source (NO <audio> tag used for Anthems)
    this.anthemBufferCache = new Map();
    this.anthemLoadingPromises = new Map();
    this.activeAnthemSource = null;
    this.activeAnthemMode = null; // 'preview' | 'goal' | null
    this.activeAnthemId = null;
    this._goalAnthemLoading = false;
    this._previewToken = 0;

    // Background Music DOM <audio> element & MediaElementAudioSourceNode
    this.bgmAudioEl = null;
    this.bgmMediaSourceNode = null;
    this.bgmObjectUrl = null;
    this.bgmCurrentTrack = null;

    // BGM Pause & Fade Envelope state
    this._bgmUserPaused = false;
    this._bgmGoalSequenceActive = false;
    this._isWindowUnfocusedMuted = false;
    this.bgmFadeEnvelope = 0.0;

    // Canonical linear phase u in [0, 1] for Anthem and BGM
    this.anthemLinearPhase = 0.0;
    this.anthemBlend = 0.0;
    this.bgmLinearPhase = 1.0;
    this.bgmBlend = 1.0;

    this._lastRafTime = 0;
    this._rafId = null;
    this._lastHudMatchPhase = null;
    this._lastChoreographySignal = null;
    this._initialized = false;
  }

  init() {
    if (this._initialized || typeof window === 'undefined') return;
    this._initialized = true;

    const store = useSpatialAudioStore.getState();
    store.registerRuntimeCallbacks({
      onPreviewAnthem: (anthemId) => this.startAnthemPreview(anthemId),
      onStopPreviewAnthem: () => this.stopAnthemPreview(),
      onSelectBgmTrack: (trackId) => this.playBgmTrackById(trackId),
      onNextBgmTrack: () => this.playNextBgmTrack(1),
      onPrevBgmTrack: () => this.playNextBgmTrack(-1),
      onToggleBgmPlayPause: () => this.toggleBgmPlayPause(),
      onBgmPrefsChanged: () => this.syncBgmPlaybackState(),
      onBgmFilesUploaded: () => this.onBgmFilesUploaded(),
      onTunerConfigChanged: (cfg) => this.onTunerConfigChanged(cfg),
    });

    // Subscribe to hudStore matchPhase & choreographySignal to detect goal-replay-will-start,
    // goal-replay-started, and goal-replay-ended / skip.
    const initialHud = useHudStore.getState();
    this._lastHudMatchPhase = initialHud.matchPhase;
    this._lastChoreographySignal = initialHud.choreographySignal;
    useHudStore.subscribe((state) => {
      const nextPhase = state.matchPhase;
      const prevPhase = this._lastHudMatchPhase;
      const nextSignal = state.choreographySignal;
      const prevSignal = this._lastChoreographySignal;

      if (nextSignal !== prevSignal) {
        this._lastChoreographySignal = nextSignal;
        if (nextSignal === 'goal-replay-will-start' && !this._isTrainingShotExpire()) {
          this._bgmGoalSequenceActive = true;
          this.syncBgmPlaybackState();
        }
      }

      if (nextPhase !== prevPhase) {
        this._lastHudMatchPhase = nextPhase;
        this._handleMatchPhaseTransition(prevPhase, nextPhase);
      }
    });

    // Subscribe to appStore menu open/close, matchMode, and onlineSession changes
    useAppStore.subscribe(() => {
      this.syncBgmPlaybackState();
    });

    // Subscribe to audioConfig changes for live anthemVolume and bgmBusVolume calibration
    audioConfig.subscribe(() => {
      const curStore = useSpatialAudioStore.getState();
      const cfg = curStore.tunerConfig;
      const anthemOutGain = this._getAnthemOutputGain();
      const bgmVolScalar = this._getBgmVolScalar(curStore);
      this.anthemChain?.applyBlend(this.anthemBlend, cfg, anthemOutGain);
      this.bgmChain?.applyBlend(this.bgmBlend, cfg, this.bgmFadeEnvelope * bgmVolScalar);
    });

    this._startTransitionLoop();
  }

  _getAnthemOutputGain(forceActive = false) {
    const isActive = forceActive || this.activeAnthemMode !== null;
    if (!isActive) return 0.0;
    const raw = Number(audioConfig.get('anthemVolume') ?? 1.0);
    return Math.max(0, Math.min(5.0, Number.isFinite(raw) ? raw : 1.0));
  }

  _getBgmVolScalar(store = useSpatialAudioStore.getState()) {
    const baseScalar = Math.max(0, Math.min(1, (Number(store.bgmVolume) ?? 80) / 100));
    const busMult = Number(audioConfig.get('bgmBusVolume') ?? 1.0);
    const safeBusMult = Math.max(0, Math.min(5.0, Number.isFinite(busMult) ? busMult : 1.0));
    return baseScalar * safeBusMult;
  }

  /**
   * Pre-builds the spatial audio graph and stadium impulse buffer silently (with 0 output gain)
   * so opening the Spatial Audio Tuner for the first time never causes a lazy-init audio pop.
   */
  prewarm() {
    try {
      this._ensureAudioGraph(false);
    } catch {
      // ignore prewarm errors before user gesture
    }
  }

  /**
   * Coordinates BGM and Anthem chains when window focus changes and Mute When Unfocused is active.
   * Prevents stale audio buffer bursts or convolver tail pops when returning after long off-screen periods.
   */
  handleWindowFocusChange(hasFocus, continueOnBlur) {
    const shouldMuteUnfocused = !hasFocus && !continueOnBlur;
    if (shouldMuteUnfocused) {
      if (this._isWindowUnfocusedMuted) return;
      this._isWindowUnfocusedMuted = true;
      if (this.activeAnthemMode === 'preview') {
        this.stopAnthemPreview();
      }
      this.bgmFadeEnvelope = 0.0;
      this._lastShouldBeAudible = false;
      const store = useSpatialAudioStore.getState();
      this.bgmChain?.resetAndSilence(store.tunerConfig);
      if (this.bgmAudioEl && !this.bgmAudioEl.paused) {
        this.bgmAudioEl.pause();
      }
    } else if (this._isWindowUnfocusedMuted) {
      this._isWindowUnfocusedMuted = false;
      if (typeof performance !== 'undefined') {
        this._lastRafTime = performance.now();
      }
      this.bgmFadeEnvelope = 0.0;
      const store = useSpatialAudioStore.getState();
      this.bgmChain?.applyBlend(this.bgmBlend, store.tunerConfig, 0.0, true);
      this.syncBgmPlaybackState();
    }
  }

  _isTrainingShotExpire() {
    const matchMode = useAppStore.getState().matchMode;
    if (matchMode === 'static-training-pack') {
      const replayType = useStaticTrainingPackStore.getState().liveTelemetry?.replayType;
      if (replayType === 'expire') {
        return true;
      }
      const scorer = useHudStore.getState().replayScorerName;
      if (scorer === 'SHOT EXPIRED') {
        return true;
      }
    }
    return false;
  }

  _ensureAudioGraph(autoResume = true) {
    const ctx = getAudioContext();
    const masterInput = getMasterAudioInput() || ctx?.destination;
    if (!ctx || !masterInput) return null;

    if (autoResume && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const store = useSpatialAudioStore.getState();
    const cfg = store.tunerConfig;
    const decaySec = Number(cfg.decaySec) || 3.0;
    const bgmVolScalar = this._getBgmVolScalar(store);
    const anthemOutGain = this._getAnthemOutputGain();

    if (!this.ctx || this.ctx !== ctx) {
      this.ctx = ctx;
      this.impulseBuffer = buildStadiumImpulseBuffer(ctx, decaySec);
      this.lastImpulseDecaySec = decaySec;
      this.anthemChain = new SpatialAudioBusChain(ctx, masterInput, this.impulseBuffer);
      this.bgmChain = new SpatialAudioBusChain(ctx, masterInput, this.impulseBuffer);
      this.anthemChain.applyBlend(this.anthemBlend, cfg, anthemOutGain, true);
      this.bgmChain.applyBlend(
        this.bgmBlend,
        cfg,
        this.bgmFadeEnvelope * bgmVolScalar,
        true
      );

      if (this.bgmAudioEl && !this.bgmMediaSourceNode) {
        try {
          this.bgmMediaSourceNode = ctx.createMediaElementSource(this.bgmAudioEl);
          this.bgmMediaSourceNode.connect(this.bgmChain.input);
        } catch (err) {
          console.warn('[StadiumSpatialAudioEngine] MediaElementSource attach failed:', err);
        }
      }
    } else if (Math.abs(decaySec - this.lastImpulseDecaySec) > 0.05) {
      this.lastImpulseDecaySec = decaySec;
      this.impulseBuffer = buildStadiumImpulseBuffer(ctx, decaySec);
      this.anthemChain?.setImpulseBuffer(this.impulseBuffer);
      this.bgmChain?.setImpulseBuffer(this.impulseBuffer);
    }

    if (this.bgmAudioEl && this.bgmChain && !this.bgmMediaSourceNode) {
      try {
        this.bgmMediaSourceNode = ctx.createMediaElementSource(this.bgmAudioEl);
        this.bgmMediaSourceNode.connect(this.bgmChain.input);
      } catch (err) {
        console.warn('[StadiumSpatialAudioEngine] Late MediaElementSource attach failed:', err);
      }
    }

    return ctx;
  }

  onTunerConfigChanged(cfg) {
    if (!this.ctx) {
      this._ensureAudioGraph(false);
    }
    if (!this.ctx) return;

    const decaySec = Number(cfg.decaySec) || 3.0;
    if (Math.abs(decaySec - this.lastImpulseDecaySec) > 0.05) {
      if (this._decayRebuildTimer) {
        clearTimeout(this._decayRebuildTimer);
      }
      this._decayRebuildTimer = setTimeout(() => {
        this._decayRebuildTimer = null;
        if (!this.ctx) return;
        const latestDecay =
          Number(useSpatialAudioStore.getState().tunerConfig.decaySec) || 3.0;
        if (Math.abs(latestDecay - this.lastImpulseDecaySec) > 0.05) {
          this.lastImpulseDecaySec = latestDecay;
          this.impulseBuffer = buildStadiumImpulseBuffer(this.ctx, latestDecay);
          this.anthemChain?.setImpulseBuffer(this.impulseBuffer);
          this.bgmChain?.setImpulseBuffer(this.impulseBuffer);
        }
      }, 100);
    }

    const store = useSpatialAudioStore.getState();
    const bgmVolScalar = this._getBgmVolScalar(store);
    const anthemOutGain = this._getAnthemOutputGain();

    this.anthemBlend =
      cfg.overrideMode === 'manual'
        ? Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0))
        : solveCubicBezier(this.anthemLinearPhase, cfg.bzX1, cfg.bzY1, cfg.bzX2, cfg.bzY2);
    this.bgmBlend =
      cfg.overrideMode === 'manual'
        ? Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0))
        : solveCubicBezier(this.bgmLinearPhase, cfg.bzX1, cfg.bzY1, cfg.bzX2, cfg.bzY2);

    this.anthemChain?.applyBlend(this.anthemBlend, cfg, anthemOutGain);
    this.bgmChain?.applyBlend(this.bgmBlend, cfg, this.bgmFadeEnvelope * bgmVolScalar);
  }

  async _loadAnthemBuffer(anthemDef) {
    const fileUrl = anthemDef?.file ? `/${anthemDef.file.replace(/^\//, '')}` : null;
    if (!fileUrl) return null;
    if (this.anthemBufferCache.has(anthemDef.id)) {
      return this.anthemBufferCache.get(anthemDef.id);
    }
    if (this.anthemLoadingPromises.has(anthemDef.id)) {
      return this.anthemLoadingPromises.get(anthemDef.id);
    }

    const ctx = this._ensureAudioGraph();
    if (!ctx) return null;

    const promise = fetch(fileUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${fileUrl}`);
        return res.arrayBuffer();
      })
      .then((arrayBuf) => ctx.decodeAudioData(arrayBuf))
      .then((audioBuffer) => {
        this.anthemBufferCache.set(anthemDef.id, audioBuffer);
        this.anthemLoadingPromises.delete(anthemDef.id);
        return audioBuffer;
      })
      .catch((err) => {
        console.warn(`[StadiumSpatialAudioEngine] Failed to decode anthem ${anthemDef.id}:`, err);
        this.anthemLoadingPromises.delete(anthemDef.id);
        return null;
      });

    this.anthemLoadingPromises.set(anthemDef.id, promise);
    return promise;
  }

  _stopCurrentAnthemSource() {
    if (this.activeAnthemSource) {
      const src = this.activeAnthemSource;
      this.activeAnthemSource = null;
      src.onended = null;
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore already stopped source
      }
    }
    this.activeAnthemMode = null;
    this.activeAnthemId = null;
    this._goalAnthemLoading = false;
  }

  /**
   * Starts previewing an anthem in the Garage Anthem tab.
   * Clicking the speaker icon again cancels the preview with zero spatial echo/reverb tail.
   */
  async startAnthemPreview(anthemId) {
    const token = ++this._previewToken;
    this._stopCurrentAnthemSource();

    const store = useSpatialAudioStore.getState();
    store.setActiveGoalAnthemId(null);

    // Ensure Background Music is paused while previewing in Garage
    this.syncBgmPlaybackState();

    const resolved = resolvePlayableAnthemDef(anthemId, {
      randomScope: store.randomAnthemScope,
      randomCategory: store.randomAnthemCategory,
    });
    if (!resolved || !resolved.file) {
      store.setPreviewingAnthemId(null);
      this.anthemChain?.resetAndSilence(store.tunerConfig);
      return;
    }

    const ctx = this._ensureAudioGraph();
    if (!ctx || !this.anthemChain) {
      store.setPreviewingAnthemId(null);
      return;
    }

    // Purge any previous reverb tail before starting preview
    this.anthemChain.resetAndSilence(store.tunerConfig);

    const buffer = await this._loadAnthemBuffer(resolved);
    if (token !== this._previewToken || !buffer) {
      if (token === this._previewToken) {
        useSpatialAudioStore.getState().setPreviewingAnthemId(null);
      }
      return;
    }

    // Start preview in normal studio clarity (phase = 0.0) unless overridden by Active Tuner
    const latestCfg = useSpatialAudioStore.getState().tunerConfig;
    this.anthemLinearPhase = 0.0;
    this.anthemBlend = 0.0;
    this.anthemChain.applyBlend(0.0, latestCfg, this._getAnthemOutputGain(true), true);
    useSpatialAudioStore.getState().setAnthemTransitionState(0.0, 0.0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.anthemChain.input);
    this.activeAnthemSource = src;
    this.activeAnthemMode = 'preview';
    this.activeAnthemId = anthemId;

    src.onended = () => {
      if (this.activeAnthemSource === src) {
        this.activeAnthemSource = null;
        this.activeAnthemMode = null;
        this.activeAnthemId = null;
        this.anthemLinearPhase = 0.0;
        this.anthemBlend = 0.0;
        const curStore = useSpatialAudioStore.getState();
        this.anthemChain?.resetAndSilence(curStore.tunerConfig);
        curStore.setAnthemTransitionState(0.0, 0.0);
        curStore.setPreviewingAnthemId(null);
        this.syncBgmPlaybackState();
      }
      try {
        src.disconnect();
      } catch {
        // ignore
      }
    };

    try {
      src.start(ctx.currentTime);
    } catch (err) {
      console.warn('[StadiumSpatialAudioEngine] Failed to start anthem preview source:', err);
      this.anthemChain?.resetAndSilence(latestCfg);
      useSpatialAudioStore.getState().setPreviewingAnthemId(null);
    }
  }

  stopAnthemPreview() {
    this._previewToken++;
    if (this.activeAnthemMode === 'preview') {
      this._stopCurrentAnthemSource();
    }
    const store = useSpatialAudioStore.getState();
    // Immediately cut anthem chain output & clear convolver so stopping preview has NO reverb tail
    if (this.activeAnthemMode === null) {
      this.anthemLinearPhase = 0.0;
      this.anthemBlend = 0.0;
      this.anthemChain?.resetAndSilence(store.tunerConfig);
      store.setAnthemTransitionState(0.0, 0.0);
    }
    if (store.previewingAnthemId !== null) {
      store.setPreviewingAnthemId(null);
    }
    this.syncBgmPlaybackState();
  }

  /**
   * Handles Goal (`goal-replay-will-start`), Goal Replay start (`replay`), and Goal Replay end/skip transitions.
   * - On `goal` phase (`goal-replay-will-start`): immediately activates `_bgmGoalSequenceActive = true`
   *   so Background Music begins its smooth fade-out pause right away.
   * - On `replay` phase (`goal-replay-started`): starts the scorer's Player Anthem.
   * - On leaving `replay` phase (`goal-replay-ended` or skipped): sets `isGoalReplaySkipped = true`
   *   so any ongoing Player Anthem transitions to spatial stadium mode (1.0) and plays to completion.
   * - Background Music only resumes after BOTH Goal Replay has ended AND Player Anthem has finished
   *   (whichever timestamp is later).
   */
  _handleMatchPhaseTransition(prevPhase, nextPhase) {
    const store = useSpatialAudioStore.getState();

    if (nextPhase === 'goal' && prevPhase !== 'goal') {
      if (!this._isTrainingShotExpire()) {
        this._bgmGoalSequenceActive = true;
      }
      this.syncBgmPlaybackState();
      return;
    }

    if (nextPhase === 'replay' && prevPhase !== 'replay') {
      if (this._isTrainingShotExpire()) {
        return;
      }
      this._bgmGoalSequenceActive = true;
      store.setGoalReplaySkipped(false);
      this.startGoalReplayAnthem(store.selectedAnthem);
      this.syncBgmPlaybackState();
    } else if (
      (prevPhase === 'replay' || prevPhase === 'goal') &&
      nextPhase !== 'replay' &&
      nextPhase !== 'goal'
    ) {
      // Goal Replay was skipped or finished: switch ongoing anthem to spatial stadium effect
      // and let it play out until the audio buffer finishes naturally.
      store.setGoalReplaySkipped(true);
      this._refreshGoalSequenceBgmGate();
      this.syncBgmPlaybackState();
    }
  }

  _refreshGoalSequenceBgmGate() {
    if (!this._bgmGoalSequenceActive) return false;
    const currentPhase = useHudStore.getState().matchPhase;
    const isGoalOrReplayPhase =
      (currentPhase === 'goal' || currentPhase === 'replay') &&
      !this._isTrainingShotExpire();
    const isAnthemStillActive =
      this.activeAnthemMode === 'goal' || this._goalAnthemLoading;

    if (!isGoalOrReplayPhase && !isAnthemStillActive) {
      this._bgmGoalSequenceActive = false;
    }
    return this._bgmGoalSequenceActive;
  }

  /**
   * Explicit hook for immediate Goal Replay skip actions (e.g. pressing skip button / voteSkipReplay).
   */
  notifyGoalReplaySkipped() {
    useSpatialAudioStore.getState().setGoalReplaySkipped(true);
    this._refreshGoalSequenceBgmGate();
    this.syncBgmPlaybackState();
  }

  async startGoalReplayAnthem(anthemId = useSpatialAudioStore.getState().selectedAnthem) {
    if (!anthemId || anthemId === 'none') {
      this._goalAnthemLoading = false;
      this._refreshGoalSequenceBgmGate();
      this.syncBgmPlaybackState();
      return;
    }

    const token = ++this._previewToken;
    this._stopCurrentAnthemSource();
    this._goalAnthemLoading = true;

    const store = useSpatialAudioStore.getState();
    store.setPreviewingAnthemId(null);

    const resolved = resolvePlayableAnthemDef(anthemId, {
      randomScope: store.randomAnthemScope,
      randomCategory: store.randomAnthemCategory,
    });
    if (!resolved || !resolved.file) {
      this._goalAnthemLoading = false;
      this._refreshGoalSequenceBgmGate();
      this.syncBgmPlaybackState();
      return;
    }

    const ctx = this._ensureAudioGraph();
    if (!ctx || !this.anthemChain) {
      this._goalAnthemLoading = false;
      this._refreshGoalSequenceBgmGate();
      this.syncBgmPlaybackState();
      return;
    }

    const buffer = await this._loadAnthemBuffer(resolved);
    if (token !== this._previewToken || !buffer) {
      if (token === this._previewToken) {
        this._goalAnthemLoading = false;
        this._refreshGoalSequenceBgmGate();
        this.syncBgmPlaybackState();
      }
      return;
    }

    this._goalAnthemLoading = false;

    // Determine initial phase: if menu is open or replay already skipped, start spatial (1.0); otherwise normal (0.0)
    const isMenuOpen = Boolean(useAppStore.getState().isOpen);
    const isSkipped = Boolean(useSpatialAudioStore.getState().isGoalReplaySkipped);
    const currentPhase = useHudStore.getState().matchPhase;
    const initialTarget = isMenuOpen || isSkipped || currentPhase !== 'replay' ? 1.0 : 0.0;

    this.anthemLinearPhase = initialTarget;
    const cfg = useSpatialAudioStore.getState().tunerConfig;
    this.anthemBlend = solveCubicBezier(
      initialTarget,
      cfg.bzX1,
      cfg.bzY1,
      cfg.bzX2,
      cfg.bzY2
    );
    this.anthemChain.applyBlend(this.anthemBlend, cfg, this._getAnthemOutputGain(true), true);
    useSpatialAudioStore.getState().setAnthemTransitionState(
      this.anthemLinearPhase,
      this.anthemBlend
    );
    useSpatialAudioStore.getState().setActiveGoalAnthemId(resolved.id);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.anthemChain.input);
    this.activeAnthemSource = src;
    this.activeAnthemMode = 'goal';
    this.activeAnthemId = resolved.id;

    src.onended = () => {
      if (this.activeAnthemSource === src) {
        this.activeAnthemSource = null;
        this.activeAnthemMode = null;
        this.activeAnthemId = null;
        useSpatialAudioStore.getState().setActiveGoalAnthemId(null);
        // Check if Goal Replay has also ended; if so, resume BGM with fade-in
        this._refreshGoalSequenceBgmGate();
        this.syncBgmPlaybackState();
      }
      try {
        src.disconnect();
      } catch {
        // ignore
      }
    };

    try {
      src.start(ctx.currentTime);
    } catch (err) {
      console.warn('[StadiumSpatialAudioEngine] Failed to start goal replay anthem:', err);
      this.activeAnthemSource = null;
      this.activeAnthemMode = null;
      this.activeAnthemId = null;
      useSpatialAudioStore.getState().setActiveGoalAnthemId(null);
      this._refreshGoalSequenceBgmGate();
      this.syncBgmPlaybackState();
    }
  }

  // ============================================================================
  // Background Music (<audio> tag + MediaSession + Spatial Polarity + Fade-In/Out)
  // ============================================================================

  _ensureBgmAudioElement() {
    if (typeof document === 'undefined') return null;
    if (!this.bgmAudioEl) {
      const audioEl = document.createElement('audio');
      audioEl.preload = 'auto';
      audioEl.style.display = 'none';
      audioEl.dataset.rcBgmElement = 'true';
      document.body.appendChild(audioEl);

      audioEl.addEventListener('ended', () => {
        this.playNextBgmTrack(1);
      });
      audioEl.addEventListener('play', () => {
        if (this._shouldBgmBeAudible()) {
          useSpatialAudioStore.getState().setBgmPlaybackState({ isPlaying: true });
          this._updateMediaSessionPlaybackState('playing');
        }
      });
      audioEl.addEventListener('pause', () => {
        useSpatialAudioStore.getState().setBgmPlaybackState({ isPlaying: false });
        this._updateMediaSessionPlaybackState('paused');
      });

      this.bgmAudioEl = audioEl;

      const ctx = this._ensureAudioGraph();
      if (ctx && this.bgmChain && !this.bgmMediaSourceNode) {
        try {
          this.bgmMediaSourceNode = ctx.createMediaElementSource(audioEl);
          this.bgmMediaSourceNode.connect(this.bgmChain.input);
        } catch (err) {
          console.warn('[StadiumSpatialAudioEngine] Failed to connect BGM <audio> element:', err);
        }
      }
    }
    return this.bgmAudioEl;
  }

  _setupMediaSession(track) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      if (track && typeof window.MediaMetadata === 'function') {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: track.title,
          artist: track.volume ? `RocketCompanion · Volume ${track.volume}` : 'RocketCompanion BGM',
          album: 'Background Music',
        });
      }
      navigator.mediaSession.setActionHandler('play', () => {
        this._bgmUserPaused = false;
        this.syncBgmPlaybackState();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this._bgmUserPaused = true;
        this.syncBgmPlaybackState();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this._bgmUserPaused = false;
        this.playNextBgmTrack(-1);
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this._bgmUserPaused = false;
        this.playNextBgmTrack(1);
      });
    } catch {
      // Ignore unsupported mediaSession actions
    }
  }

  _updateMediaSessionPlaybackState(state) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // ignore
    }
  }

  /**
   * Maps the current game mode / online room into one of the 4 BGM scene checkboxes:
   * - `freePlay` (default: true)
   * - `singlePlayerTraining` (default: true)
   * - `multiplayerTraining` (default: false)
   * - `match` (default: false)
   */
  _isCurrentSceneAllowedForBgm(store = useSpatialAudioStore.getState(), appState = useAppStore.getState()) {
    const scenes = store.bgmScenes || DEFAULT_BGM_SCENE_CONFIG;
    const matchMode = appState.matchMode;
    const onlineSession = appState.onlineSession;
    const hasOnlineRoom = Boolean(onlineSession?.roomId);

    if (hasOnlineRoom) {
      if (onlineSession?.roomType === 'warmup' && matchMode !== 'match') {
        return Boolean(scenes.multiplayerTraining);
      }
      return Boolean(scenes.match);
    }

    if (matchMode === 'online-warmup') {
      return Boolean(scenes.multiplayerTraining);
    }

    if (matchMode === 'match' || matchMode === 'exp-multi-bots') {
      return Boolean(scenes.match);
    }

    if (
      matchMode === 'kickoff-training' ||
      matchMode === 'static-training-pack' ||
      matchMode === 'dev-test-lab'
    ) {
      return Boolean(scenes.singlePlayerTraining);
    }

    return Boolean(scenes.freePlay);
  }

  /**
   * Determines whether Background Music should currently be audible (target fade = 1.0).
   */
  _shouldBgmBeAudible() {
    if (this._isWindowUnfocusedMuted) {
      return false;
    }

    const store = useSpatialAudioStore.getState();
    if (!store.bgmEnabled) {
      this._bgmUserPaused = false;
      return false;
    }

    if (this._bgmUserPaused) {
      return false;
    }

    const playlist = getFilteredBgmTracks(store);
    if (playlist.length === 0) return false;

    const appState = useAppStore.getState();
    if (!this._isCurrentSceneAllowedForBgm(store, appState)) {
      return false;
    }

    // Pause Background Music whenever the user is in Garage -> Loadout -> Anthem tab or previewing an anthem,
    // regardless of whether Realistic Background Music (spatial BGM) is enabled.
    if (
      Boolean(appState.isOpen) &&
      (store.isGarageAnthemTabActive ||
        this.activeAnthemMode === 'preview' ||
        store.previewingAnthemId !== null)
    ) {
      return false;
    }

    if (this.activeAnthemMode === 'preview' || store.previewingAnthemId !== null) {
      return false;
    }

    // Pause on goal-replay-will-start and keep paused until max(goalReplayEnded, playerAnthemEnded)
    if (this._refreshGoalSequenceBgmGate()) {
      return false;
    }

    return true;
  }

  onBgmFilesUploaded() {
    this._bgmUserPaused = false;
    const store = useSpatialAudioStore.getState();
    const playlist = getFilteredBgmTracks(store);
    if (playlist.length > 0 && store.bgmEnabled && this._shouldBgmBeAudible()) {
      const randomIdx = Math.floor(Math.random() * playlist.length);
      this._loadAndPlayBgmTrack(playlist[randomIdx]);
    } else if (playlist.length > 0 && !this.bgmCurrentTrack) {
      // Pre-select a track so it is ready when enabled
      const randomIdx = Math.floor(Math.random() * playlist.length);
      this.bgmCurrentTrack = playlist[randomIdx];
      store.setBgmPlaybackState({
        currentTrackId: this.bgmCurrentTrack.id,
        currentTrackTitle: this.bgmCurrentTrack.title,
      });
    }
  }

  syncBgmPlaybackState() {
    const store = useSpatialAudioStore.getState();
    const playlist = getFilteredBgmTracks(store);
    const shouldPlay = this._shouldBgmBeAudible();

    if (!shouldPlay) {
      // Reflect paused intent immediately in UI while _startTransitionLoop smoothly
      // ramps bgmFadeEnvelope down to 0.0 and calls bgmAudioEl.pause() upon reaching 0.
      if (store.bgmIsPlaying) {
        store.setBgmPlaybackState({ isPlaying: false });
        this._updateMediaSessionPlaybackState('paused');
      }
      return;
    }

    // Check if current track is still in the filtered playlist
    const currentStillValid =
      this.bgmCurrentTrack && playlist.some((t) => t.id === this.bgmCurrentTrack.id);

    if (!currentStillValid) {
      const nextTrack = playlist[Math.floor(Math.random() * playlist.length)];
      if (nextTrack) {
        this._loadAndPlayBgmTrack(nextTrack);
      }
    } else {
      const audioEl = this._ensureBgmAudioElement();
      if (!audioEl) return;
      this._ensureAudioGraph();
      if (!audioEl.src && this.bgmCurrentTrack?.file) {
        this._loadAndPlayBgmTrack(this.bgmCurrentTrack);
        return;
      }
      if (audioEl.paused) {
        // Start from current fade envelope (0 if stopped) and ramp up smoothly in RAF loop
        if (this.bgmChain) {
          const bgmVolScalar = this._getBgmVolScalar(store);
          this.bgmChain.applyBlend(
            this.bgmBlend,
            store.tunerConfig,
            this.bgmFadeEnvelope * bgmVolScalar
          );
        }
        audioEl
          .play()
          .then(() => {
            useSpatialAudioStore.getState().setBgmPlaybackState({ isPlaying: true });
            this._updateMediaSessionPlaybackState('playing');
          })
          .catch(() => {});
      } else if (!store.bgmIsPlaying) {
        store.setBgmPlaybackState({ isPlaying: true });
        this._updateMediaSessionPlaybackState('playing');
      }
    }
  }

  _loadAndPlayBgmTrack(track) {
    if (!track?.file) return;
    const audioEl = this._ensureBgmAudioElement();
    if (!audioEl) return;

    this._ensureAudioGraph();

    if (this.bgmObjectUrl) {
      URL.revokeObjectURL(this.bgmObjectUrl);
      this.bgmObjectUrl = null;
    }

    this.bgmCurrentTrack = track;
    this.bgmObjectUrl = URL.createObjectURL(track.file);
    audioEl.src = this.bgmObjectUrl;

    const store = useSpatialAudioStore.getState();
    store.setBgmPlaybackState({
      currentTrackId: track.id,
      currentTrackTitle: track.title,
    });

    this._setupMediaSession(track);

    if (this._shouldBgmBeAudible()) {
      if (this.bgmChain) {
        const bgmVolScalar = this._getBgmVolScalar(store);
        this.bgmChain.applyBlend(
          this.bgmBlend,
          store.tunerConfig,
          this.bgmFadeEnvelope * bgmVolScalar
        );
      }
      audioEl
        .play()
        .then(() => {
          useSpatialAudioStore.getState().setBgmPlaybackState({ isPlaying: true });
          this._updateMediaSessionPlaybackState('playing');
        })
        .catch((err) => {
          console.warn('[StadiumSpatialAudioEngine] BGM autoplay blocked until user gesture:', err);
        });
    }
  }

  playBgmTrackById(trackId) {
    this._bgmUserPaused = false;
    const store = useSpatialAudioStore.getState();
    const found = store.bgmTracks.find((t) => t.id === trackId);
    if (found) {
      this._loadAndPlayBgmTrack(found);
    }
  }

  playNextBgmTrack(direction = 1) {
    const store = useSpatialAudioStore.getState();
    const playlist = getFilteredBgmTracks(store);
    if (playlist.length === 0) return;

    if (!this.bgmCurrentTrack) {
      this._loadAndPlayBgmTrack(playlist[0]);
      return;
    }

    const curIdx = playlist.findIndex((t) => t.id === this.bgmCurrentTrack.id);
    if (curIdx < 0) {
      this._loadAndPlayBgmTrack(playlist[0]);
      return;
    }

    const nextIdx = (curIdx + direction + playlist.length) % playlist.length;
    this._loadAndPlayBgmTrack(playlist[nextIdx]);
  }

  toggleBgmPlayPause() {
    const store = useSpatialAudioStore.getState();
    const audioEl = this._ensureBgmAudioElement();
    if (!audioEl) return;
    if (!this.bgmCurrentTrack) {
      this._bgmUserPaused = false;
      this.playNextBgmTrack(1);
      return;
    }
    if (this._bgmUserPaused || audioEl.paused || !store.bgmIsPlaying) {
      this._bgmUserPaused = false;
      this.syncBgmPlaybackState();
    } else {
      this._bgmUserPaused = true;
      this.syncBgmPlaybackState();
    }
  }

  // ============================================================================
  // Continuous Directional Non-Linear Transition & Fade Envelope Loop
  // ============================================================================

  _computeTargetAnthemPhase(cfg) {
    if (cfg.overrideMode === 'normal') return 0.0;
    if (cfg.overrideMode === 'spatial') return 1.0;
    if (cfg.overrideMode === 'manual') {
      return Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0));
    }

    // In Garage preview mode or when no Goal Replay anthem is active, keep Normal (0.0)
    // so stopping a preview never triggers a spatial stadium reverb tail.
    if (this.activeAnthemMode !== 'goal') {
      return 0.0;
    }

    // In Goal Replay mode:
    // - Normal (0.0) while watching Goal Replay with ESC menu closed and replay not skipped
    // - Spatial (1.0) if ESC menu is opened OR if Goal Replay was skipped / ended
    const isMenuOpen = Boolean(useAppStore.getState().isOpen);
    const isReplayPhase = useHudStore.getState().matchPhase === 'replay';
    const isSkipped = Boolean(useSpatialAudioStore.getState().isGoalReplaySkipped);

    if (isMenuOpen || isSkipped || !isReplayPhase) {
      return 1.0;
    }
    return 0.0;
  }

  _computeTargetBgmPhase(cfg) {
    if (cfg.overrideMode === 'normal') return 0.0;
    if (cfg.overrideMode === 'spatial') return 1.0;
    if (cfg.overrideMode === 'manual') {
      return Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0));
    }

    const store = useSpatialAudioStore.getState();
    if (!store.realisticBgmEnabled) {
      return 0.0;
    }

    // Reversed polarity compared to Anthem:
    // - When ESC menu is open (isOpen === true): Normal studio playback (0.0)
    // - When driving (isOpen === false): Spatial stadium acoustics (1.0)
    const isMenuOpen = Boolean(useAppStore.getState().isOpen);
    return isMenuOpen ? 0.0 : 1.0;
  }

  _startTransitionLoop() {
    if (typeof window === 'undefined' || this._rafId !== null) return;
    this._lastRafTime = performance.now();

    const step = (now) => {
      const dt = Math.min(0.1, Math.max(0.0, (now - this._lastRafTime) / 1000));
      this._lastRafTime = now;

      const store = useSpatialAudioStore.getState();
      const cfg = store.tunerConfig;
      const duration = Math.max(0.05, Number(cfg.transitionDurationSec) || 2.0);
      const maxDelta = dt / duration;

      // 1. Update Anthem Linear Phase & Directional Cubic-Bezier Blend
      const targetAnthemU = this._computeTargetAnthemPhase(cfg);
      if (cfg.overrideMode === 'manual') {
        this.anthemLinearPhase = targetAnthemU;
        this.anthemBlend = targetAnthemU;
      } else {
        if (Math.abs(targetAnthemU - this.anthemLinearPhase) > 1e-4) {
          if (targetAnthemU > this.anthemLinearPhase) {
            this.anthemLinearPhase = Math.min(targetAnthemU, this.anthemLinearPhase + maxDelta);
          } else {
            this.anthemLinearPhase = Math.max(targetAnthemU, this.anthemLinearPhase - maxDelta);
          }
        } else {
          this.anthemLinearPhase = targetAnthemU;
        }
        this.anthemBlend = solveCubicBezier(
          this.anthemLinearPhase,
          cfg.bzX1,
          cfg.bzY1,
          cfg.bzX2,
          cfg.bzY2
        );
      }

      if (this.anthemChain) {
        const anthemOutGain = this._getAnthemOutputGain();
        this.anthemChain.applyBlend(this.anthemBlend, cfg, anthemOutGain);
      }
      if (
        Math.abs(store.anthemLinearPhase - this.anthemLinearPhase) > 0.005 ||
        Math.abs(store.anthemBlend - this.anthemBlend) > 0.005
      ) {
        store.setAnthemTransitionState(this.anthemLinearPhase, this.anthemBlend);
      }

      // 2. Update BGM Linear Phase & Directional Cubic-Bezier Blend
      const targetBgmU = this._computeTargetBgmPhase(cfg);
      if (cfg.overrideMode === 'manual') {
        this.bgmLinearPhase = targetBgmU;
        this.bgmBlend = targetBgmU;
      } else {
        if (Math.abs(targetBgmU - this.bgmLinearPhase) > 1e-4) {
          if (targetBgmU > this.bgmLinearPhase) {
            this.bgmLinearPhase = Math.min(targetBgmU, this.bgmLinearPhase + maxDelta);
          } else {
            this.bgmLinearPhase = Math.max(targetBgmU, this.bgmLinearPhase - maxDelta);
          }
        } else {
          this.bgmLinearPhase = targetBgmU;
        }
        this.bgmBlend = solveCubicBezier(
          this.bgmLinearPhase,
          cfg.bzX1,
          cfg.bzY1,
          cfg.bzX2,
          cfg.bzY2
        );
      }

      // 3. Update BGM Play/Pause/Enable/Disable Smooth Fade Envelope (max 3.0s)
      const shouldBeAudible = this._shouldBgmBeAudible();
      if (shouldBeAudible !== this._lastShouldBeAudible) {
        this._lastShouldBeAudible = shouldBeAudible;
        this.syncBgmPlaybackState();
      }
      const targetFade = shouldBeAudible ? 1.0 : 0.0;
      const fadeDuration = Math.max(
        0.1,
        Math.min(3.0, Number(cfg.bgmFadeDurationSec) || 2.0)
      );
      const maxFadeDelta = dt / fadeDuration;

      if (Math.abs(targetFade - this.bgmFadeEnvelope) > 1e-4) {
        if (targetFade > this.bgmFadeEnvelope) {
          this.bgmFadeEnvelope = Math.min(targetFade, this.bgmFadeEnvelope + maxFadeDelta);
        } else {
          this.bgmFadeEnvelope = Math.max(targetFade, this.bgmFadeEnvelope - maxFadeDelta);
        }
      } else {
        this.bgmFadeEnvelope = targetFade;
      }

      // Once fade-out reaches 0.0, actually pause the underlying <audio> element
      if (!shouldBeAudible && this.bgmFadeEnvelope <= 0.001) {
        this.bgmFadeEnvelope = 0.0;
        if (this.bgmAudioEl && !this.bgmAudioEl.paused) {
          this.bgmAudioEl.pause();
        }
      }

      if (this.bgmChain) {
        const bgmVolScalar = this._getBgmVolScalar(store);
        this.bgmChain.applyBlend(
          this.bgmBlend,
          cfg,
          this.bgmFadeEnvelope * bgmVolScalar
        );
      }
      if (
        Math.abs(store.bgmLinearPhase - this.bgmLinearPhase) > 0.005 ||
        Math.abs(store.bgmBlend - this.bgmBlend) > 0.005
      ) {
        store.setBgmTransitionState(this.bgmLinearPhase, this.bgmBlend);
      }

      this._rafId = window.requestAnimationFrame(step);
    };

    this._rafId = window.requestAnimationFrame(step);
  }
}

export const stadiumSpatialAudioEngine = new StadiumSpatialAudioEngine();
