import { audioConfig, registerAudioDiagnosticsProvider } from '../ui-core/config/audioConfig.js';
import { resolvePlayableAnthemDef } from '../ui-core/config/spatialAudioConfig';
import { useSpatialAudioStore } from '../ui-core/stores/spatialAudioStore';
import { getAudioContext, getMasterAudioInput, getAudioSlotPool, registerAudioEngine, subsystemState } from './audioContext.js';
import { StateAudioEngine } from './StateAudioEngine.js';
import { VehicleAudioManager } from './VehicleAudioManager.js';
import { IncidentAudioEngine } from './IncidentAudioEngine.js';
import { SignalAudioEngine } from './SignalAudioEngine.js';
import { UIAudioEngine } from './UIAudioEngine.js';
import { EMotorSynth } from './EMotorSynth.js';
import { loadAudioAssets, applyBoostVariationBuffers, fetchAudioBuffer } from './audioAssetLoader.js';
import { stadiumSpatialAudioEngine } from './StadiumSpatialAudioEngine.js';
import './audioDebug.js';

const BGM_PREVIEW_SAMPLE_URL = '/assets/audio/bgm/Hollywood Principle - Breathing Underwater (Ether Remix).m4a';
const BGM_PREVIEW_FALLBACK_URL = '/assets/audio/bgm/Mike Ault - Flying Forever (feat. Morgan Perry).m4a';

export class GameAudioEngineFacade {
  constructor() {
    this.stateEngine = new StateAudioEngine();
    this.ballEngine = this.stateEngine.ballEmitter;
    this.vehicleManager = new VehicleAudioManager();
    this.incidentEngine = new IncidentAudioEngine(this.vehicleManager);
    this.signalEngine = new SignalAudioEngine();
    this.uiEngine = new UIAudioEngine();
    this.stadiumSpatialEngine = stadiumSpatialAudioEngine;
    this.stadiumSpatialEngine.init();
    this._previewSource = null;
    this._previewGain = null;
    this._previewSynth = null;
    this._previewSynthInterval = null;
    this._previewSynthTimeout = null;
    this._previewVariantCounters = {};
    this._cachedBgmPreviewBuffer = null;

    this.loading = false;
    this.loaded = false;
    this._lastBoostVariationKey = `${audioConfig.get('boostStartVariation')}|${audioConfig.get('boostLoopVariation')}|${audioConfig.get('boostEndVariation')}`;

    registerAudioEngine(this);
    registerAudioDiagnosticsProvider({
      previewBoostVariation: (variationId, phase) => this.previewBoostVariation(variationId, phase),
      previewAudioDetail: (detailKey) => this.previewAudioDetail(detailKey),
      stopAudioDetailPreview: () => this.stopAudioDetailPreview(),
    });

    audioConfig.subscribe(() => {
      const panModel = audioConfig.get('spatialPanningModel') || 'equalpower';
      this.vehicleManager?.updatePanningModel?.(panModel);
      this.ballEngine?.updatePanningModel?.(panModel);
      getAudioSlotPool()?.updatePanningModel?.(panModel);

      const nextBoostKey = `${audioConfig.get('boostStartVariation')}|${audioConfig.get('boostLoopVariation')}|${audioConfig.get('boostEndVariation')}`;
      if (nextBoostKey !== this._lastBoostVariationKey) {
        this._lastBoostVariationKey = nextBoostKey;
        const s = audioConfig.get('boostStartVariation');
        const l = audioConfig.get('boostLoopVariation');
        const e = audioConfig.get('boostEndVariation');
        if (this.vehicleManager) {
          const selfIdx = this.vehicleManager.activeCarIndex ?? 0;
          if (s && s === l && l === e) {
            this.vehicleManager.carBoostVariations.set(selfIdx, String(s));
          } else {
            this.vehicleManager.carBoostVariations.delete(selfIdx);
          }
        }
      }

      if (this.loaded) {
        applyBoostVariationBuffers(this);
      }
    });
  }

  stopAudioDetailPreview() {
    if (this._previewSynthInterval) {
      clearInterval(this._previewSynthInterval);
      this._previewSynthInterval = null;
    }
    if (this._previewSynthTimeout) {
      clearTimeout(this._previewSynthTimeout);
      this._previewSynthTimeout = null;
    }
    if (this._previewSynth) {
      try {
        this._previewSynth.silence();
        this._previewSynth.dispose();
      } catch {
        // ignore
      }
      this._previewSynth = null;
    }
    if (this._previewSource) {
      try {
        this._previewSource.onended = null;
        this._previewSource.stop();
        this._previewSource.disconnect();
      } catch {
        // ignore
      }
      this._previewSource = null;
    }
    if (this._previewGain) {
      try {
        this._previewGain.disconnect();
      } catch {
        // ignore
      }
      this._previewGain = null;
    }
  }

  _nextPoolBuffer(key, list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const idx = (this._previewVariantCounters[key] || 0) % list.length;
    this._previewVariantCounters[key] = (idx + 1) % list.length;
    return list[idx];
  }

  _playPreviewBuffer(buf, gainMult = 1.0, options = {}) {
    const ctx = getAudioContext();
    const dest = getMasterAudioInput() || ctx?.destination;
    if (!ctx || !dest || !buf) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    this.stopAudioDetailPreview();

    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const rate = Number(options.playbackRate) || 1.0;
      src.playbackRate.setValueAtTime(rate, ctx.currentTime);
      if (options.loop) {
        src.loop = true;
      }

      const gain = ctx.createGain();
      const targetGain = Math.max(0, Math.min(5.0, Number(gainMult) || 0));
      gain.gain.setValueAtTime(targetGain, ctx.currentTime);

      src.connect(gain);
      gain.connect(dest);

      const startOffset = Math.max(0, Math.min(Math.max(0, (buf.duration || 0) - 0.5), Number(options.offset) || 0));
      src.start(ctx.currentTime, startOffset);

      if (options.maxDurationSec && options.maxDurationSec > 0) {
        const dur = Number(options.maxDurationSec);
        const stopAt = ctx.currentTime + dur;
        const fadeStart = Math.max(ctx.currentTime, stopAt - 0.15);
        gain.gain.setValueAtTime(targetGain, fadeStart);
        gain.gain.linearRampToValueAtTime(0.0001, stopAt);
        src.stop(stopAt);
      }

      this._previewSource = src;
      this._previewGain = gain;
      src.onended = () => {
        if (this._previewSource === src) {
          this._previewSource = null;
          this._previewGain = null;
        }
        try {
          src.disconnect();
          gain.disconnect();
        } catch {
          // ignore
        }
      };
    } catch (err) {
      console.warn('[GameAudioEngineFacade] Failed to play preview buffer:', err);
    }
  }

  _previewEngineSynth(gainMult) {
    const ctx = getAudioContext();
    const dest = getMasterAudioInput() || ctx?.destination;
    if (!ctx || !dest) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    this.stopAudioDetailPreview();

    try {
      const synth = new EMotorSynth(ctx, dest);
      synth.setVolume(Math.max(0, Math.min(5.0, gainMult)));
      this._previewSynth = synth;
      let step = 0;
      const totalSteps = 22;
      synth.update({ forwardSpeed: 450, alive: true, audible: true });
      this._previewSynthInterval = setInterval(() => {
        step++;
        const progress = Math.min(1, step / totalSteps);
        const speed = progress < 0.75
          ? 450 + (progress / 0.75) * 1750
          : 2200 - ((progress - 0.75) / 0.25) * 900;
        synth.update({ forwardSpeed: speed, alive: true, audible: true });
      }, 50);
      this._previewSynthTimeout = setTimeout(() => {
        this.stopAudioDetailPreview();
      }, 1200);
    } catch (err) {
      console.warn('[GameAudioEngineFacade] Failed to preview EMotorSynth:', err);
    }
  }

  async _previewAnthemSuite() {
    const ctx = getAudioContext();
    if (!ctx) return;
    const store = useSpatialAudioStore.getState();
    const prefId = store.selectedAnthem && store.selectedAnthem !== 'none' ? store.selectedAnthem : 'random';
    const resolved = resolvePlayableAnthemDef(prefId, {
      randomScope: store.randomAnthemScope,
      randomCategory: store.randomAnthemCategory,
    });
    const url = resolved?.file ? `/${resolved.file.replace(/^\//, '')}` : BGM_PREVIEW_FALLBACK_URL;
    const buf = await fetchAudioBuffer(ctx, url, BGM_PREVIEW_FALLBACK_URL);
    if (!buf) return;
    const anthemVol = Number(audioConfig.get('anthemVolume') ?? 1.0);
    this._playPreviewBuffer(buf, anthemVol, { maxDurationSec: 2.2 });
  }

  async _previewBgmSuite() {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (!this._cachedBgmPreviewBuffer) {
      this._cachedBgmPreviewBuffer = await fetchAudioBuffer(
        ctx,
        BGM_PREVIEW_SAMPLE_URL,
        BGM_PREVIEW_FALLBACK_URL
      );
    }
    const buf = this._cachedBgmPreviewBuffer;
    if (!buf) return;
    const bgmBusVol = Number(audioConfig.get('bgmBusVolume') ?? 1.0);
    const offset = buf.duration > 16 ? 12.0 : 0.0;
    this._playPreviewBuffer(buf, bgmBusVol, { offset, maxDurationSec: 2.2 });
  }

  previewAudioDetail(detailKey) {
    if (!detailKey) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    if (detailKey === 'anthemVolume') {
      this._previewAnthemSuite();
      return;
    }
    if (detailKey === 'bgmBusVolume') {
      this._previewBgmSuite();
      return;
    }

    const v = (k) => Number(audioConfig.get(k) ?? 1.0);
    if (detailKey === 'engineVolume' || detailKey === 'vehicleSelfVolume') {
      this._previewEngineSynth(v('engineVolume') * v('vehicleSelfVolume'));
      return;
    }

    if (!this.loaded) {
      if (!this.loading) {
        this.preload()
          .then(() => {
            this.previewAudioDetail(detailKey);
          })
          .catch(() => {});
      }
      return;
    }

    const sig = v('signalVolume');
    const ballBus = v('ballCollisionVolume');
    const selfBus = v('vehicleSelfVolume');
    const boostBus = v('boostVolume');
    const inc = this.incidentEngine?.buffers || {};
    const veh = this.vehicleManager?.buffers || {};
    const sigMap = this.signalEngine?.signalBuffers;

    switch (detailKey) {
      case 'masterVolume':
        this._playPreviewBuffer(sigMap?.get('match_start_go') || subsystemState.buffers.get('match_start_go'), v('matchStartGoVolume') * sig);
        break;
      case 'signalVolume':
        this._playPreviewBuffer(sigMap?.get('match_countdown_321') || subsystemState.buffers.get('match_countdown_321'), v('countdown321Volume') * sig);
        break;
      case 'countdown321Volume':
        this._playPreviewBuffer(sigMap?.get('match_countdown_321') || subsystemState.buffers.get('match_countdown_321'), v('countdown321Volume') * sig);
        break;
      case 'matchStartGoVolume':
        this._playPreviewBuffer(sigMap?.get('match_start_go') || subsystemState.buffers.get('match_start_go'), v('matchStartGoVolume') * sig);
        break;
      case 'trainingCountdownVolume':
        this._playPreviewBuffer(sigMap?.get('training_countdown') || subsystemState.buffers.get('training_countdown'), v('trainingCountdownVolume') * sig);
        break;
      case 'trainingBallExpireVolume':
        this._playPreviewBuffer(sigMap?.get('training_ball_expire') || subsystemState.buffers.get('training_ball_expire'), v('trainingBallExpireVolume') * sig);
        break;
      case 'alert60sVolume':
        this._playPreviewBuffer(sigMap?.get('match_60_seconds_left') || subsystemState.buffers.get('match_60_seconds_left'), v('alert60sVolume') * sig);
        break;
      case 'alert30sVolume':
        this._playPreviewBuffer(sigMap?.get('match_30_seconds_left') || subsystemState.buffers.get('match_30_seconds_left'), v('alert30sVolume') * sig);
        break;
      case 'countdown10sVolume':
        this._playPreviewBuffer(sigMap?.get('match_countdown_10s') || subsystemState.buffers.get('match_countdown_10s'), v('countdown10sVolume') * sig);
        break;
      case 'overtimeVolume':
        this._playPreviewBuffer(sigMap?.get('match_entering_overtime') || subsystemState.buffers.get('match_entering_overtime'), v('overtimeVolume') * sig);
        break;
      case 'endgameVolume':
        this._playPreviewBuffer(sigMap?.get('endgame') || subsystemState.buffers.get('endgame'), v('endgameVolume') * sig, { maxDurationSec: 2.2 });
        break;

      case 'ballCollisionVolume':
      case 'carBallHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('carBallHit', inc.ballHit), v('carBallHitVolume') * ballBus);
        break;
      case 'carBallAccentVolume':
        this._playPreviewBuffer(inc.vehicleAccent || subsystemState.buffers.get('vehicle_accent'), v('carBallAccentVolume') * v('carBallHitVolume') * ballBus);
        break;
      case 'carCarCollisionVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('carCarDetail', inc.vehicleDetail), v('carCarCollisionVolume'));
        break;
      case 'carCarSfxCollisionVolume':
        this._playPreviewBuffer(inc.carCollision || subsystemState.buffers.get('car_collision'), v('carCarSfxCollisionVolume') * v('carCarCollisionVolume'));
        break;
      case 'carDemoVolume':
        this._playPreviewBuffer(inc.goalScored || inc.carCollision, v('carDemoVolume'), { playbackRate: 0.85 });
        break;
      case 'ballFloorHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('ballFloor', inc.groundHit?.length ? inc.groundHit : inc.ballHit?.slice(0, 3)), v('ballFloorHitVolume') * ballBus);
        break;
      case 'ballNetHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('ballNet', inc.sidewallHit), v('ballNetHitVolume') * ballBus);
        break;
      case 'ballRampHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('ballRamp', inc.groundHit?.length ? inc.groundHit : inc.ballHit?.slice(0, 3)), v('ballRampHitVolume') * ballBus);
        break;
      case 'goalpostHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('goalpostLarge', inc.crossbarPing), v('goalpostHitVolume') * ballBus);
        break;
      case 'goalpostSmallHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('goalpostSmall', inc.crossbarPingSmall), v('goalpostSmallHitVolume') * ballBus);
        break;
      case 'boostCollectVolume':
        this._playPreviewBuffer(inc.boostCollect || subsystemState.buffers.get('boost_collect'), v('boostCollectVolume') * boostBus);
        break;
      case 'goalScoredVolume':
        this._playPreviewBuffer(inc.goalScored || subsystemState.buffers.get('sfx_goal_poof'), v('goalScoredVolume'));
        break;
      case 'flipResetVolume':
        this._playPreviewBuffer(veh.reset || inc.reset || subsystemState.buffers.get('reset'), v('flipResetVolume') * selfBus);
        break;
      case 'wheelImpactVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('wheelImpact', veh.wheelImpact?.length ? veh.wheelImpact : inc.wheelImpact), v('wheelImpactVolume') * selfBus);
        break;

      case 'boostVolume':
      case 'boostStartVolume':
        this._playPreviewBuffer(veh.boostStart || subsystemState.buffers.get('boost_start'), boostBus * v('boostStartVolume') * selfBus);
        break;
      case 'boostLoopVolume':
        this._playPreviewBuffer(veh.boostLoop || subsystemState.buffers.get('boost_loop'), boostBus * v('boostLoopVolume') * selfBus, { loop: true, maxDurationSec: 1.2 });
        break;
      case 'boostReleaseVolume':
        this._playPreviewBuffer(veh.boostRelease || subsystemState.buffers.get('boost_release'), boostBus * v('boostReleaseVolume') * selfBus * 0.8);
        break;
      case 'jumpVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('jump', veh.jump), v('jumpVolume') * selfBus);
        break;
      case 'doubleJumpVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('doubleJump', veh.doubleJump), v('doubleJumpVolume') * selfBus);
        break;
      case 'dodgeVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('dodge', veh.dodge), v('dodgeVolume') * selfBus);
        break;
      case 'supersonicEnterVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('supersonicEnter', veh.supersonicEnter), v('supersonicEnterVolume') * selfBus);
        break;
      case 'supersonicLoopVolume':
        this._playPreviewBuffer(veh.supersonicLoop || subsystemState.buffers.get('supersonic_loop'), v('supersonicLoopVolume') * selfBus, { loop: true, maxDurationSec: 1.25 });
        break;
      case 'supersonicStateVolume':
        this._playPreviewBuffer(subsystemState.buffers.get('sfx_state_supersonic') || veh.supersonicLoop, v('supersonicStateVolume') * 0.75, { loop: true, maxDurationSec: 1.25 });
        break;

      case 'ballRollingVolume':
        this._playPreviewBuffer(subsystemState.buffers.get('ballrolling') || this.stateEngine?.ballRollingBuffer, v('ballRollingVolume'), { loop: true, maxDurationSec: 1.25 });
        break;
      case 'ballFlyingVolume':
        this._playPreviewBuffer(subsystemState.buffers.get('ballflying') || this.stateEngine?.ballFlyingBuffer, v('ballFlyingVolume'), { loop: true, maxDurationSec: 1.25 });
        break;
      case 'errorNoBoostVolume':
        this._playPreviewBuffer(subsystemState.buffers.get('sfx_error_no_boost'), v('errorNoBoostVolume') * sig * 0.85);
        break;
      case 'uiClickVolume':
        this._playPreviewBuffer(subsystemState.buffers.get('sfx_error_no_boost'), v('uiClickVolume') * 0.3, { playbackRate: 2.0 });
        break;
      default:
        break;
    }
  }

  previewBoostVariation(variationId = 'rush', phase = 'start') {
    const ctx = getAudioContext();
    const dest = getMasterAudioInput() || ctx?.destination;
    if (!ctx || !dest) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((err) => console.warn('[GameAudioEngineFacade] AudioContext resume failed/blocked:', err));
    }
    this.stopAudioDetailPreview();
    const normalizedPhase = phase === 'release' ? 'end' : phase;
    const buf = subsystemState.buffers.get(`boost_${variationId}_${normalizedPhase}`);
    if (!buf) {
      if (!this.loaded && !this.loading) {
        this.preload().then(() => {
          this.previewBoostVariation(variationId, phase);
        }).catch(() => {});
      }
      return;
    }
    const boostVol = audioConfig.get('boostVolume') ?? 1.0;
    const phaseVol = normalizedPhase === 'loop'
      ? (audioConfig.get('boostLoopVolume') ?? 1.0)
      : normalizedPhase === 'start'
      ? (audioConfig.get('boostStartVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0)
      : (audioConfig.get('boostReleaseVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0);
    this._playPreviewBuffer(buf, boostVol * phaseVol, normalizedPhase === 'loop' ? { loop: true, maxDurationSec: 1.1 } : {});
  }

  async preload(onProgress = null) {
    if (this.loaded || this.loading || typeof window === "undefined") return;
    this.loading = true;
    try {
      this.stadiumSpatialEngine?.prewarm?.();
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

  setCarBoostAudioVariation(carIndex, variationId = null) {
    this.vehicleManager?.setCarBoostAudioVariation?.(carIndex, variationId);
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

  resetIncidentDebounceState() {
    if (this.incidentEngine) {
      this.incidentEngine.lastCarBallHitTimestamp = 0;
      this.incidentEngine.lastCarCollisionTimestamp = 0;
      this.incidentEngine.lastGoalScoredTimestamp = 0;
      this.incidentEngine.lastBoostPickupByPad?.clear?.();
      if (this.incidentEngine.worldImpactHandler) {
        this.incidentEngine.worldImpactHandler.lastGoalpostHitTimestamp = 0;
        this.incidentEngine.worldImpactHandler.lastBallWorldHitTimestamp = 0;
      }
    }
    if (this.vehicleManager) {
      this.vehicleManager._lastFlipResetMsByCar?.clear?.();
    }
  }
}

export const audioEngine = new GameAudioEngineFacade();
export const gameAudioEngine = audioEngine;
export const gameAudio = audioEngine;
