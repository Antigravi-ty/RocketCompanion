import { audioConfig } from '../config/audioConfig.js';
import { getAudioContext, getMasterAudioInput, getAudioSlotPool, registerAudioEngine, subsystemState } from './audioContext.js';
import { StateAudioEngine } from './StateAudioEngine.js';
import { VehicleAudioManager } from './VehicleAudioManager.js';
import { IncidentAudioEngine } from './IncidentAudioEngine.js';
import { SignalAudioEngine } from './SignalAudioEngine.js';
import { UIAudioEngine } from './UIAudioEngine.js';
import { loadAudioAssets, applyBoostVariationBuffers } from './audioAssetLoader.js';
import './audioDebug.js';

export class GameAudioEngineFacade {
  constructor() {
    this.stateEngine = new StateAudioEngine();
    this.ballEngine = this.stateEngine.ballEmitter;
    this.vehicleManager = new VehicleAudioManager();
    this.incidentEngine = new IncidentAudioEngine(this.vehicleManager);
    this.signalEngine = new SignalAudioEngine();
    this.uiEngine = new UIAudioEngine();
    this._previewSource = null;

    this.loading = false;
    this.loaded = false;

    registerAudioEngine(this);

    audioConfig.subscribe(() => {
      const panModel = audioConfig.get('spatialPanningModel') || 'equalpower';
      this.vehicleManager?.updatePanningModel?.(panModel);
      this.ballEngine?.updatePanningModel?.(panModel);
      getAudioSlotPool()?.updatePanningModel?.(panModel);
      if (this.loaded) {
        applyBoostVariationBuffers(this);
      }
    });
  }

  previewBoostVariation(variationId = 'rush', phase = 'start') {
    const ctx = getAudioContext();
    const dest = getMasterAudioInput() || ctx?.destination;
    if (!ctx || !dest) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => console.warn('[GameAudioEngineFacade] AudioContext resume failed/blocked:', err));
    }
    if (this._previewSource) {
      try {
        this._previewSource.stop();
        this._previewSource.disconnect();
      } catch (err) {
        console.warn('[GameAudioEngineFacade] Error stopping previous previewSource:', err);
      }
      this._previewSource = null;
    }
    const normalizedPhase = phase === 'release' ? 'end' : phase;
    const buf = subsystemState.buffers.get(`boost_${variationId}_${normalizedPhase}`);
    if (!buf) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      const master = audioConfig.get('masterVolume') ?? 1.0;
      const boostVol = audioConfig.get('boostVolume') ?? 0.8;
      const phaseVol = normalizedPhase === 'loop'
        ? (audioConfig.get('boostLoopVolume') ?? 0.8)
        : (audioConfig.get('boostStartStopVolume') ?? 1.0);
      gain.gain.setValueAtTime(Math.max(0.05, Math.min(2.0, master * boostVol * phaseVol)), ctx.currentTime);
      src.connect(gain);
      gain.connect(dest);
      src.start(ctx.currentTime);
      if (normalizedPhase === 'loop') {
        const stopAt = ctx.currentTime + Math.min(1.1, buf.duration || 1.1);
        gain.gain.setValueAtTime(gain.gain.value, Math.max(ctx.currentTime, stopAt - 0.12));
        gain.gain.linearRampToValueAtTime(0.0001, stopAt);
        src.stop(stopAt);
      }
      this._previewSource = src;
      src.onended = () => {
        if (this._previewSource === src) this._previewSource = null;
        try {
          src.disconnect();
          gain.disconnect();
        } catch (err) {
          console.warn('[GameAudioEngineFacade] Error disconnecting previewSource onended:', err);
        }
      };
    } catch (e) {
      console.warn('[GameAudioEngineFacade] Failed to preview boost variation:', e);
    }
  }

  async preload(onProgress = null) {
    if (this.loaded || this.loading || typeof window === "undefined") return;
    this.loading = true;
    try {
      await loadAudioAssets(this, onProgress);
      this.loaded = true;
    } finally {
      this.loading = false;
    }
  }

  handleEvent(event, camera = null) {
    this.incidentEngine.handleEvent(event, camera);
  }

  updateBallAudio(ballViewOrMesh, camera, physics) {
    this.ballEngine.update(ballViewOrMesh, camera, physics);
  }

  updateVehicles(context) {
    this.vehicleManager.update(context);
  }

  updateSupersonic(isSupersonic, isMatchActive = true) {
    const emitter = this.vehicleManager.getEmitter(this.vehicleManager.activeCarIndex);
    if (emitter) {
      if (typeof emitter.updateSupersonic === 'function') {
        emitter.updateSupersonic(isSupersonic, isMatchActive);
      } else {
        emitter.updateState({ isSupersonic, isAlive: true, audible: isMatchActive });
      }
    }
  }

  updateBoost(isBoosting, isMatchActive = true) {
    const emitter = this.vehicleManager.getEmitter(this.vehicleManager.activeCarIndex);
    if (emitter) {
      if (typeof emitter.updateBoost === 'function') {
        emitter.updateBoost(isBoosting, isMatchActive);
      } else {
        emitter.updateState({ isBoosting, isAlive: true, audible: isMatchActive });
      }
    }
  }

  handleSignal(signalType) {
    this.signalEngine.handleSignal(signalType);
  }

  play(key, volMult = 1.0, minInterval = 0) {
    this.signalEngine.play(key, volMult, minInterval);
  }

  playDirect(key, volMult = 1.0, minInterval = 0) {
    this.signalEngine.play(key, volMult, minInterval);
  }

  silenceAll() {
    this.ballEngine.silenceAll();
    this.vehicleManager.silenceAll();
    this.stateEngine.silenceAll();
    const pool = getAudioSlotPool();
    if (pool) pool.silenceAll();
  }

  onFocusRegained() {
    this.silenceAll();
  }

  stopContinuousAudio() {
    this.silenceAll();
  }
}

export const audioEngine = new GameAudioEngineFacade();
export const gameAudioEngine = audioEngine;
export const gameAudio = audioEngine;
