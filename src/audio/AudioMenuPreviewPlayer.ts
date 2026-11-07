import { audioConfig } from '../ui-core/config/audioConfig';
import { getAudioContext, getMasterAudioInput, subsystemState } from './audioContext.ts';
import { TurtleModemEngineSynth } from './TurtleModemEngineSynth.ts';
import type { VehicleAudioBuffers } from './VehicleAudioManager.ts';
import type { IncidentAudioBuffers } from './IncidentAudioEngine.ts';
import type { StadiumSpatialAudioEngine } from './StadiumSpatialAudioEngine.ts';

export interface PreviewAudioBufferOptions {
  playbackRate?: number;
  loop?: boolean;
  offset?: number;
  maxDurationSec?: number;
}

export interface AudioMenuPreviewHostPort {
  readonly loaded: boolean;
  readonly loading: boolean;
  preload(): Promise<void>;
  readonly stadiumSpatialEngine: StadiumSpatialAudioEngine;
  readonly incidentEngine: { buffers: IncidentAudioBuffers };
  readonly vehicleManager: { buffers: VehicleAudioBuffers };
  readonly signalEngine: { signalBuffers: Map<string, AudioBuffer | null> };
  readonly ballEngine: {
    ballRollingBuffer: AudioBuffer | null;
    ballFlyingBuffer: AudioBuffer | null;
  };
}

const SIGNAL_PREVIEW_KEY_MAP: Record<
  string,
  { bufKey: string; volKey: string; opts?: PreviewAudioBufferOptions }
> = {
  masterVolume: { bufKey: 'match_start_go', volKey: 'matchStartGoVolume' },
  signalVolume: { bufKey: 'match_countdown_321', volKey: 'countdown321Volume' },
  countdown321Volume: { bufKey: 'match_countdown_321', volKey: 'countdown321Volume' },
  matchStartGoVolume: { bufKey: 'match_start_go', volKey: 'matchStartGoVolume' },
  trainingCountdownVolume: { bufKey: 'training_countdown', volKey: 'trainingCountdownVolume' },
  trainingBallExpireVolume: { bufKey: 'training_ball_expire', volKey: 'trainingBallExpireVolume' },
  alert60sVolume: { bufKey: 'match_60_seconds_left', volKey: 'alert60sVolume' },
  alert30sVolume: { bufKey: 'match_30_seconds_left', volKey: 'alert30sVolume' },
  countdown10sVolume: { bufKey: 'match_countdown_10s', volKey: 'countdown10sVolume' },
  overtimeVolume: { bufKey: 'match_entering_overtime', volKey: 'overtimeVolume' },
  endgameVolume: { bufKey: 'endgame', volKey: 'endgameVolume', opts: { maxDurationSec: 2.2 } },
};

export class AudioMenuPreviewPlayer {
  private readonly host: AudioMenuPreviewHostPort;
  _previewGain: GainNode | null = null;
  _previewSource: AudioBufferSourceNode | null = null;
  _previewSynth: TurtleModemEngineSynth | null = null;
  _previewSynthInterval: ReturnType<typeof setInterval> | null = null;
  _previewSynthTimeout: ReturnType<typeof setTimeout> | null = null;
  _previewVariantCounters: Record<string, number> = {};

  constructor(host: AudioMenuPreviewHostPort) {
    this.host = host;
  }

  stopAudioDetailPreview(): void {
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

  private _nextPoolBuffer(
    key: string,
    list: Array<AudioBuffer | null> | null | undefined
  ): AudioBuffer | null {
    if (!Array.isArray(list) || list.length === 0) return null;
    const idx = (this._previewVariantCounters[key] || 0) % list.length;
    this._previewVariantCounters[key] = (idx + 1) % list.length;
    return list[idx] ?? null;
  }

  _playPreviewBuffer(
    buf: AudioBuffer | null | undefined,
    gainMult: number = 1.0,
    options: PreviewAudioBufferOptions = {}
  ): void {
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

      const startOffset = Math.max(
        0,
        Math.min(Math.max(0, (buf.duration || 0) - 0.5), Number(options.offset) || 0)
      );
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
      console.warn('[AudioMenuPreviewPlayer] Failed to play preview buffer:', err);
    }
  }

  private _previewEngineSynth(gainMult: number): void {
    const ctx = getAudioContext();
    const dest = getMasterAudioInput() || ctx?.destination;
    if (!ctx || !dest) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    this.stopAudioDetailPreview();

    try {
      const synth = new TurtleModemEngineSynth(ctx, dest, { isPrimaryListener: false });
      synth.setVolume(Math.max(0, Math.min(5.0, gainMult)));
      this._previewSynth = synth;
      let step = 0;
      const totalSteps = 28;
      synth.update({
        speedUU: 450,
        forwardSpeedUU: 450,
        throttleInput: 1,
        isOnGround: true,
        alive: true,
        audible: true,
        dt: 0.05,
      });
      this._previewSynthInterval = setInterval(() => {
        step++;
        const progress = Math.min(1, step / totalSteps);
        const isAccel = progress < 0.72;
        const speed = isAccel
          ? 450 + (progress / 0.72) * 1750
          : 2200 - ((progress - 0.72) / 0.28) * 900;
        synth.update({
          speedUU: speed,
          forwardSpeedUU: speed,
          throttleInput: isAccel ? 1 : 0,
          isOnGround: true,
          alive: true,
          audible: true,
          dt: 0.05,
        });
      }, 50);
      this._previewSynthTimeout = setTimeout(() => {
        this.stopAudioDetailPreview();
      }, 1450);
    } catch (err) {
      console.warn('[AudioMenuPreviewPlayer] Failed to preview TurtleModemEngineSynth:', err);
    }
  }

  private async _previewAnthemSuite(): Promise<void> {
    await this.host.stadiumSpatialEngine?.previewAnthemVolumeSample?.((buf, vol, opts) =>
      this._playPreviewBuffer(buf, vol, opts)
    );
  }

  private async _previewBgmSuite(): Promise<void> {
    await this.host.stadiumSpatialEngine?.previewBgmVolumeSample?.((buf, vol, opts) =>
      this._playPreviewBuffer(buf, vol, opts)
    );
  }

  previewAudioDetail(detailKey: string): void {
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

    const v = (k: string): number => Number(audioConfig.get(k) ?? 1.0);
    if (detailKey === 'engineVolume' || detailKey === 'vehicleSelfVolume') {
      this._previewEngineSynth(v('engineVolume') * v('vehicleSelfVolume'));
      return;
    }

    if (!this.host.loaded) {
      if (!this.host.loading) {
        this.host
          .preload()
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
    const inc = this.host.incidentEngine?.buffers;
    const veh = this.host.vehicleManager?.buffers;
    const sigMap = this.host.signalEngine?.signalBuffers;

    const sigSpec = SIGNAL_PREVIEW_KEY_MAP[detailKey];
    if (sigSpec) {
      const buf = sigMap?.get(sigSpec.bufKey) || subsystemState.buffers.get(sigSpec.bufKey);
      this._playPreviewBuffer(buf, v(sigSpec.volKey) * sig, sigSpec.opts);
      return;
    }

    switch (detailKey) {
      case 'ballCollisionVolume':
      case 'carBallHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('carBallHit', inc?.ballHit), v('carBallHitVolume') * ballBus);
        break;
      case 'carBallAccentVolume':
        this._playPreviewBuffer(inc?.vehicleAccent || subsystemState.buffers.get('vehicle_accent'), v('carBallAccentVolume') * v('carBallHitVolume') * ballBus);
        break;
      case 'carCarCollisionVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('carCarDetail', inc?.vehicleDetail), v('carCarCollisionVolume'));
        break;
      case 'carCarSfxCollisionVolume':
        this._playPreviewBuffer(inc?.carCollision || subsystemState.buffers.get('car_collision'), v('carCarSfxCollisionVolume') * v('carCarCollisionVolume'));
        break;
      case 'carDemoVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('carDemo', inc?.carDemo) || inc?.carCollision, v('carDemoVolume'));
        break;
      case 'ballFloorHitVolume':
      case 'ballRampHitVolume': {
        const poolKey = detailKey === 'ballFloorHitVolume' ? 'ballFloor' : 'ballRamp';
        const list = inc?.groundHit?.length ? inc.groundHit : inc?.ballHit?.slice(0, 3);
        this._playPreviewBuffer(this._nextPoolBuffer(poolKey, list), v(detailKey) * ballBus);
        break;
      }
      case 'ballNetHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('ballNet', inc?.sidewallHit), v('ballNetHitVolume') * ballBus);
        break;
      case 'goalpostHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('goalpostLarge', inc?.crossbarPing), v('goalpostHitVolume') * ballBus);
        break;
      case 'goalpostSmallHitVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('goalpostSmall', inc?.crossbarPingSmall), v('goalpostSmallHitVolume') * ballBus);
        break;
      case 'boostCollectVolume':
        this._playPreviewBuffer(inc?.boostCollect || subsystemState.buffers.get('boost_collect'), v('boostCollectVolume') * boostBus);
        break;
      case 'goalScoredVolume':
        this._playPreviewBuffer(inc?.goalScored || subsystemState.buffers.get('sfx_goal_poof'), v('goalScoredVolume'));
        break;
      case 'flipResetVolume':
        this._playPreviewBuffer(veh?.reset || inc?.reset || subsystemState.buffers.get('reset'), v('flipResetVolume') * selfBus);
        break;
      case 'wheelImpactVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('wheelImpact', veh?.wheelImpact?.length ? veh.wheelImpact : inc?.wheelImpact), v('wheelImpactVolume') * selfBus);
        break;
      case 'boostVolume':
      case 'boostStartVolume':
        this._playPreviewBuffer(veh?.boostStart || subsystemState.buffers.get('boost_start'), boostBus * v('boostStartVolume') * selfBus);
        break;
      case 'boostLoopVolume':
        this._playPreviewBuffer(veh?.boostLoop || subsystemState.buffers.get('boost_loop'), boostBus * v('boostLoopVolume') * selfBus, { loop: true, maxDurationSec: 1.2 });
        break;
      case 'boostReleaseVolume':
        this._playPreviewBuffer(veh?.boostRelease || subsystemState.buffers.get('boost_release'), boostBus * v('boostReleaseVolume') * selfBus * 0.8);
        break;
      case 'jumpVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('jump', veh?.jump), v('jumpVolume') * selfBus);
        break;
      case 'doubleJumpVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('doubleJump', veh?.doubleJump), v('doubleJumpVolume') * selfBus);
        break;
      case 'dodgeVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('dodge', veh?.dodge), v('dodgeVolume') * selfBus);
        break;
      case 'supersonicEnterVolume':
        this._playPreviewBuffer(this._nextPoolBuffer('supersonicEnter', veh?.supersonicEnter), v('supersonicEnterVolume') * selfBus);
        break;
      case 'supersonicLoopVolume':
        this._playPreviewBuffer(veh?.supersonicLoop || subsystemState.buffers.get('supersonic_loop'), v('supersonicLoopVolume') * selfBus, { loop: true, maxDurationSec: 1.25 });
        break;
      case 'supersonicStateVolume':
        this._playPreviewBuffer(subsystemState.buffers.get('sfx_state_supersonic') || veh?.supersonicLoop, v('supersonicStateVolume') * 0.75, { loop: true, maxDurationSec: 1.25 });
        break;
      case 'ballRollingVolume':
        this._playPreviewBuffer(subsystemState.buffers.get('ballrolling') || this.host.ballEngine?.ballRollingBuffer, v('ballRollingVolume'), { loop: true, maxDurationSec: 1.25 });
        break;
      case 'ballFlyingVolume':
        this._playPreviewBuffer(subsystemState.buffers.get('ballflying') || this.host.ballEngine?.ballFlyingBuffer, v('ballFlyingVolume'), { loop: true, maxDurationSec: 1.25 });
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

  previewBoostVariation(variationId = 'rush', phase = 'start'): void {
    const ctx = getAudioContext();
    const dest = getMasterAudioInput() || ctx?.destination;
    if (!ctx || !dest) return;
    if (ctx.state === 'suspended') {
      ctx
        .resume()
        .catch((err) =>
          console.warn('[AudioMenuPreviewPlayer] AudioContext resume failed/blocked:', err)
        );
    }
    this.stopAudioDetailPreview();
    const normalizedPhase = phase === 'release' ? 'end' : phase;
    const buf = subsystemState.buffers.get(`boost_${variationId}_${normalizedPhase}`);
    if (!buf) {
      if (!this.host.loaded && !this.host.loading) {
        this.host
          .preload()
          .then(() => {
            this.previewBoostVariation(variationId, phase);
          })
          .catch(() => {});
      }
      return;
    }
    const boostVol = audioConfig.get('boostVolume') ?? 1.0;
    const phaseVol =
      normalizedPhase === 'loop'
        ? (audioConfig.get('boostLoopVolume') ?? 1.0)
        : normalizedPhase === 'start'
          ? (audioConfig.get('boostStartVolume') ?? audioConfig.get('boostStartStopVolume') ?? 1.0)
          : (audioConfig.get('boostReleaseVolume') ??
            audioConfig.get('boostStartStopVolume') ??
            1.0);
    this._playPreviewBuffer(
      buf,
      boostVol * phaseVol,
      normalizedPhase === 'loop' ? { loop: true, maxDurationSec: 1.1 } : {}
    );
  }
}
