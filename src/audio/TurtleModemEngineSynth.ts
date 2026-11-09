import {
  getEngineAudioTuningConfig,
  registerEngineAudioRuntimeActions,
  publishEngineAudioTelemetry,
  type EngineAudioPackId,
  type EngineDriveDirection,
} from '../ui-core/config/engineAudioConfig.ts';
import {
  loadEngineAudioPackAssets,
  getResolvedEngineAudioPackAssets,
  type LoadedEngineAudioPackAssets,
} from './EngineAudioLoopConditioner.ts';
import { EngineAudioEqualizer } from './EngineAudioEqualizer.ts';
import {
  normalizePowertrainTelemetry,
  stepManualBenchKinematics,
  type PowertrainTelemetryInput,
} from './EnginePhysicsKinematics.ts';
import { TurtleModemDrivetrainModel } from './TurtleModemDrivetrainModel.ts';
import {
  TurtleModemGranularVoiceGraph,
  type EngineSynthLodMode,
  type GranularSliceChannel,
} from './TurtleModemGranularVoiceGraph.ts';

export type { PowertrainTelemetryInput, EngineSynthLodMode, GranularSliceChannel };

export interface EngineSynthTelemetryInput extends PowertrainTelemetryInput {
  dormant?: boolean;
  distanceUU?: number;
}

const REMOTE_HIBERNATE_GRACE_SEC = 15.0;

export class TurtleModemEngineSynth {
  ctx: AudioContext;
  destination: AudioNode;
  outputNode: GainNode;
  lowpassNode: BiquadFilterNode;
  equalizer: EngineAudioEqualizer;
  voiceGraph: TurtleModemGranularVoiceGraph;
  drivetrain: TurtleModemDrivetrainModel;

  isPrimaryListener: boolean;
  active = false;
  alive = true;
  audible = true;
  dormant = false;
  distanceUU = 0;
  engineVolume = 0.8;

  packId: EngineAudioPackId = 'turtle_modem';
  assets: LoadedEngineAudioPackAssets | null = null;
  loadingPromise: Promise<void> | null = null;

  lastOutputGain = -1;
  private _inactiveSinceSec = -1;

  lastPopIndex = -1;
  lastBackfireTimeSec = -10;
  backfireCount = 0;
  entitySpawnCount = 0;
  lastEntitySpawnTimeSec = -10;

  manualOverrideActive = false;
  manualThrottle = false;
  manualBoost = false;
  manualReverse = false;
  manualAirborne = false;
  manualSpeedUU = 0;
  lastUpdatePerfMs = 0;
  telemetryPublishCounter = 0;

  constructor(
    ctx: AudioContext,
    destination?: AudioNode,
    options?: { isPrimaryListener?: boolean }
  ) {
    this.ctx = ctx;
    this.destination = destination || ctx.destination;
    this.isPrimaryListener = options?.isPrimaryListener ?? true;

    const cfg = getEngineAudioTuningConfig();
    this.packId = cfg.activePackId || 'turtle_modem';
    this.drivetrain = new TurtleModemDrivetrainModel(cfg.idleRPM);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 18000;
    lp.Q.value = 0.707;
    this.lowpassNode = lp;

    this.equalizer = new EngineAudioEqualizer(this.ctx, lp);
    this.outputNode = this.ctx.createGain();
    this.outputNode.gain.value = 0;
    lp.connect(this.outputNode);
    this.outputNode.connect(this.destination);

    this.voiceGraph = new TurtleModemGranularVoiceGraph(
      this.ctx,
      lp,
      this.equalizer,
      this.isPrimaryListener ? 'primary-full' : 'remote-lod'
    );

    if (this.isPrimaryListener) this._registerRuntimeHooks();
    this._ensurePackLoaded(this.packId);
  }

  get graphBuilt(): boolean {
    return this.voiceGraph.graphBuilt;
  }
  set graphBuilt(val: boolean) {
    if (!val) this.voiceGraph.teardown();
  }
  get sliceChannels(): GranularSliceChannel[] {
    return this.voiceGraph.sliceChannels;
  }
  get idleSource(): AudioBufferSourceNode | null {
    return this.voiceGraph.idleSource;
  }
  get idleGain(): GainNode | null {
    return this.voiceGraph.idleGain;
  }
  get currentRPM(): number {
    return this.drivetrain.currentRPM;
  }
  get currentGear(): number {
    return this.drivetrain.currentGear;
  }
  get isNeutral(): boolean {
    return this.drivetrain.isNeutral;
  }
  get driveDirection(): EngineDriveDirection {
    return this.drivetrain.driveDirection;
  }

  static speedToKmh(rawSpeed: number): number {
    return Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed * 0.036 : 0;
  }

  private _shouldPlayNow(): boolean {
    return (
      this.active &&
      this.alive &&
      !this.dormant &&
      (this.audible || (this.isPrimaryListener && this.manualOverrideActive)) &&
      this.engineVolume > 1e-4
    );
  }

  private _registerRuntimeHooks(): void {
    registerEngineAudioRuntimeActions({
      triggerBackfireTest: () => this.triggerBackfire(true),
      triggerEntitySpawnTest: () => this.playEntitySpawnSfx(true),
      triggerZeroSpeedReset: () => this.resetToZeroSpeedState(),
      setManualBenchState: (p) => {
        if (p.active !== undefined) this.manualOverrideActive = p.active;
        if (p.throttle !== undefined) this.manualThrottle = p.throttle;
        if (p.boost !== undefined) this.manualBoost = p.boost;
        if (p.reverse !== undefined) this.manualReverse = p.reverse;
        if (p.airborne !== undefined) this.manualAirborne = p.airborne;
      },
    });
  }

  private _buildIfReady(): void {
    if (this.assets && this._shouldPlayNow() && !this.voiceGraph.graphBuilt) {
      this.voiceGraph.build(this.assets);
    }
  }

  private _ensurePackLoaded(packId: EngineAudioPackId): void {
    const resolved = getResolvedEngineAudioPackAssets(packId);
    if (resolved) {
      this.assets = resolved;
      this._buildIfReady();
      return;
    }
    if (this.loadingPromise) return;
    this.loadingPromise = loadEngineAudioPackAssets(this.ctx, packId)
      .then((loaded) => {
        this.assets = loaded;
        this.loadingPromise = null;
        this._buildIfReady();
      })
      .catch(() => {
        this.loadingPromise = null;
      });
  }

  start(): void {
    if (this.active) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.active = true;
    this.lastUpdatePerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._ensurePackLoaded(this.packId);
    this._buildIfReady();
  }

  resetToZeroSpeedState(): void {
    this.drivetrain.resetToZeroSpeedState(getEngineAudioTuningConfig().idleRPM);
  }

  private _playOneShotBuffer(buffer: AudioBuffer, gainVal: number, rate = 1.0): void {
    if (gainVal <= 0.001) return;
    try {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      const g = this.ctx.createGain();
      g.gain.value = gainVal;
      src.connect(g);
      g.connect(this.destination);
      src.start(this.ctx.currentTime);
      src.onended = () => {
        try {
          src.disconnect();
          g.disconnect();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* ignore */
    }
  }

  triggerBackfire(forceAudition = false): void {
    const pops = this.assets?.popBuffers;
    if (
      !pops?.length ||
      (!forceAudition && (!this.active || !this.alive || !this.audible || this.dormant))
    )
      return;
    const cfg = getEngineAudioTuningConfig();
    const now = this.ctx.currentTime;
    if (
      !forceAudition &&
      now - this.lastBackfireTimeSec < Math.max(0.15, cfg.backfireCooldownSec ?? 0.65)
    )
      return;
    this.lastBackfireTimeSec = now;

    let idx = 0;
    if (pops.length > 1) {
      do {
        idx = Math.floor(Math.random() * pops.length);
      } while (idx === this.lastPopIndex);
    }
    this.lastPopIndex = idx;
    this.backfireCount += 1;

    const gain = Math.max(
      0,
      Math.min(1.5, cfg.backfireVolume * (forceAudition ? 0.9 : this.engineVolume))
    );
    this._playOneShotBuffer(pops[idx], gain, 0.94 + Math.random() * 0.12);
  }

  playEntitySpawnSfx(forceAudition = false): void {
    const cfg = getEngineAudioTuningConfig();
    if (!forceAudition && (!cfg.entitySpawnSfxEnabled || !this.audible || this.dormant)) return;
    this._ensurePackLoaded(this.packId);
    const spawnBuf = this.assets?.entitySpawnBuffer;
    if (!spawnBuf) return;

    const now = this.ctx.currentTime;
    if (!forceAudition && now - this.lastEntitySpawnTimeSec < 0.15) return;
    this.lastEntitySpawnTimeSec = now;
    this.entitySpawnCount += 1;

    const vol =
      cfg.entitySpawnSfxVolume * (forceAudition ? 0.9 : Math.max(0.35, this.engineVolume));
    this._playOneShotBuffer(spawnBuf, Math.max(0, Math.min(1.5, vol)), 1.0);
    if (this.isPrimaryListener)
      publishEngineAudioTelemetry({ entitySpawnCount: this.entitySpawnCount });
  }

  update(
    speedOrTelemetry: number | EngineSynthTelemetryInput = 0,
    legacyIsAccelerating = false
  ): void {
    if (!this.active) this.start();
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const computedDt =
      this.lastUpdatePerfMs > 0 ? (nowPerf - this.lastUpdatePerfMs) / 1000 : 1 / 60;
    this.lastUpdatePerfMs = nowPerf;

    const norm = normalizePowertrainTelemetry(speedOrTelemetry, legacyIsAccelerating, computedDt);
    let { rawSpeedUU, forwardSpeedUU, throttleInput, isBoosting, isOnGround } = norm;
    const { steerInput, handbrakeInput, surfaceUpZ, dt } = norm;

    if (norm.alive !== undefined) this.alive = norm.alive;
    if (norm.audible !== undefined) this.audible = norm.audible;
    if (norm.dormant !== undefined) this.dormant = norm.dormant;
    if (norm.distanceUU !== undefined) this.distanceUU = norm.distanceUU;

    const desiredLod: EngineSynthLodMode = this.isPrimaryListener ? 'primary-full' : 'remote-lod';
    if (this.voiceGraph.lodMode !== desiredLod) this.voiceGraph.setLodMode(desiredLod, this.assets);

    const cfg = getEngineAudioTuningConfig();
    if (cfg.activePackId && cfg.activePackId !== this.packId) {
      this.packId = cfg.activePackId;
      this.voiceGraph.teardown();
      this._ensurePackLoaded(this.packId);
    }

    if (this.isPrimaryListener && this.manualOverrideActive) {
      const bench = stepManualBenchKinematics(
        cfg,
        this.manualSpeedUU,
        this.manualThrottle,
        this.manualBoost,
        this.manualReverse,
        this.manualAirborne,
        this.drivetrain.driveDirection,
        dt
      );
      this.manualSpeedUU = bench.manualSpeedUU;
      ({ isOnGround, throttleInput, isBoosting, rawSpeedUU, forwardSpeedUU } = bench);
    } else {
      this.manualSpeedUU = rawSpeedUU;
    }

    const res = this.drivetrain.step(
      cfg,
      rawSpeedUU,
      forwardSpeedUU,
      throttleInput,
      isOnGround,
      dt,
      {
        steerInput,
        handbrakeInput,
        isBoosting,
        surfaceUpZ,
      }
    );
    if (res.shouldTriggerBackfire && !this.dormant) this.triggerBackfire(false);
    this._updateAudioGraph(cfg, rawSpeedUU);
  }

  private _updateAudioGraph(
    cfg: ReturnType<typeof getEngineAudioTuningConfig>,
    rawSpeedUU: number
  ): void {
    const now = this.ctx.currentTime;
    const tau = Math.max(0.003, cfg.gainSmoothingTimeMs / 1000);
    const dtModel = this.drivetrain;
    const { currentRPM, smoothThrottle, isUnderStrain } = dtModel;

    const shouldPlay = this._shouldPlayNow();
    const targetMasterGain = shouldPlay
      ? Math.min(1.2, this.engineVolume * 0.42 * (isUnderStrain ? 1.08 : 1.0))
      : 0;
    if (Math.abs(targetMasterGain - this.lastOutputGain) > 1e-4) {
      this.outputNode.gain.setTargetAtTime(targetMasterGain, now, 0.025);
      this.lastOutputGain = targetMasterGain;
    }

    if (!shouldPlay) {
      if (!this.isPrimaryListener || this.dormant) {
        if (this._inactiveSinceSec < 0) this._inactiveSinceSec = now;
        else if (
          this.voiceGraph.graphBuilt &&
          now - this._inactiveSinceSec >= REMOTE_HIBERNATE_GRACE_SEC
        ) {
          this.voiceGraph.teardown();
        }
      }
      if (!this.isPrimaryListener) return;
    } else {
      this._inactiveSinceSec = -1;
    }

    if (!this.voiceGraph.graphBuilt || !this.voiceGraph.sliceChannels.length) {
      if (this.assets && shouldPlay) this.voiceGraph.build(this.assets);
      if (!this.voiceGraph.graphBuilt) return;
    }

    const isStationaryNeutral =
      dtModel.isOnGround &&
      dtModel.driveDirection === 'stopped' &&
      smoothThrottle < 0.01 &&
      currentRPM <= cfg.idleRPM + 15;

    const graphResult = this.voiceGraph.update({
      cfg,
      now,
      tau,
      currentRPM,
      smoothThrottle,
      isUnderStrain,
      isStationaryNeutral,
    });
    if (!graphResult) return;

    if (this.isPrimaryListener) {
      this.telemetryPublishCounter = (this.telemetryPublishCounter + 1) % 3;
      if (this.telemetryPublishCounter === 0) {
        const {
          lowerSliceIndex,
          upperSliceIndex,
          lowerSliceFreqHz,
          upperSliceFreqHz,
          activeEqCompensationDb,
          effectiveIdleGain,
          filterCutoffHz,
        } = graphResult;
        publishEngineAudioTelemetry({
          packId: this.packId,
          loaded: this.voiceGraph.graphBuilt,
          loadedSlicesCount: this.voiceGraph.sliceChannels.length,
          totalSlicesCount: this.assets?.slices.length ?? 40,
          currentRPM,
          targetRPM: dtModel.targetRPM,
          currentGear: dtModel.currentGear,
          isNeutral: dtModel.isNeutral,
          isOnGround: dtModel.isOnGround,
          driveDirection: dtModel.driveDirection,
          speedUU: rawSpeedUU,
          speedKmh: TurtleModemEngineSynth.speedToKmh(rawSpeedUU),
          forwardAccelUU: dtModel.smoothForwardAccelUU,
          airborneRevQuotaRemainingSec: dtModel.airborneThrottleQuotaSec,
          isShiftLocked: dtModel.isShiftLocked,
          isUnderStrain,
          isInOverdrive: dtModel.isInOverdrive,
          isBoosting: dtModel.isBoosting,
          throttleLoad: dtModel.wasAccelerating ? 1 : 0,
          smoothThrottle,
          isRevLimiting: dtModel.revLimiterTimer > 0,
          lowerSliceIndex,
          upperSliceIndex,
          lowerSliceFreqHz,
          upperSliceFreqHz,
          activeEqCompensationDb,
          idleWeight: effectiveIdleGain,
          filterCutoffHz,
          lastBackfireIndex: this.lastPopIndex,
          backfireCount: this.backfireCount,
          entitySpawnCount: this.entitySpawnCount,
        });
      }
    }
  }

  private _muteOutput(tau = 0.025): void {
    this.outputNode.gain.setTargetAtTime(0, this.ctx.currentTime, tau);
    this.lastOutputGain = 0;
  }

  setDormant(dormant: boolean): void {
    const next = Boolean(dormant);
    if (this.dormant === next) return;
    this.dormant = next;
    if (this.dormant) {
      this._muteOutput();
      if (this._inactiveSinceSec < 0) this._inactiveSinceSec = this.ctx.currentTime;
    } else {
      this._inactiveSinceSec = -1;
    }
  }

  setAlive(alive: boolean): void {
    this.alive = Boolean(alive);
    if (!this.alive) this._muteOutput(0.02);
  }

  setAudible(audible: boolean): void {
    this.audible = Boolean(audible);
    if (!this.audible && !(this.isPrimaryListener && this.manualOverrideActive)) this._muteOutput();
  }

  setEngineVolume(vol: number): void {
    if (typeof vol === 'number' && Number.isFinite(vol))
      this.engineVolume = Math.max(0, Math.min(2.0, vol));
  }

  setVolume(vol: number): void {
    this.setEngineVolume(vol);
  }

  silence(): void {
    if (this.ctx && this.outputNode) {
      this.outputNode.gain.cancelScheduledValues(this.ctx.currentTime);
      this._muteOutput(0.02);
    }
  }

  reset(): void {
    this.resetToZeroSpeedState();
    this.silence();
  }

  dispose(): void {
    this.active = false;
    this.voiceGraph.teardown();
    this.equalizer.dispose();
    try {
      this.lowpassNode.disconnect();
      this.outputNode.disconnect();
    } catch {
      /* ignore */
    }
  }
}
