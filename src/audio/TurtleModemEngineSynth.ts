import {
  getEngineAudioTuningConfig,
  registerEngineAudioRuntimeActions,
  publishEngineAudioTelemetry,
  type EngineAudioPackId,
} from '../ui-core/config/engineAudioConfig.ts';
import { getAudioContext, getMasterAudioInput } from './audioContext.ts';
import { SpatialAudioSource, type SpatialVector3Like } from './SpatialAudioSource.ts';
import {
  TurtleModemGranularVoiceGraph,
  type EngineSynthLodMode,
  type GranularSliceChannel,
} from './TurtleModemGranularVoiceGraph.ts';
import {
  applySmoothedAudioParamValue,
  clampSmoothingDtSec,
  resetAudioParamValueImmediate,
} from './audioParamSmoothingPipeline.ts';
import {
  getResolvedEngineAudioPackAssets,
  loadEngineAudioPackAssets,
  playEngineSynthOneShotBuffer,
  type LoadedEngineAudioPackAssets,
} from './turtleModemSynthAcousticPipeline.ts';
import {
  createEmptyWasmCarAudioCue,
  readWasmCarAudioCue,
  type WasmCarAudioCue,
} from './WasmAudioDirectorBridge.ts';
import type { CarStateView } from '../physics/RocketSimStateViews.ts';

export type { EngineSynthLodMode, GranularSliceChannel };

const OUTPUT_GAIN_DEADBAND = 1e-4;
export const MAX_AUDIBLE_REMOTE_ENGINES = 3;

export class TurtleModemEngineSynth {
  ctx: AudioContext;
  destination: AudioNode;
  outputNode: GainNode;
  lowpassNode: BiquadFilterNode;
  voiceGraph: TurtleModemGranularVoiceGraph;
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
  smoothedOutputGain = 0;
  lastOutputGain = -1;
  lastUpdatePerfMs = 0;
  telemetryPublishCounter = 0;

  constructor(
    ctx: AudioContext,
    destination?: AudioNode,
    options?: { isPrimaryListener?: boolean }
  ) {
    this.ctx = ctx;
    this.destination = destination || ctx.destination;
    const isPrimary = options?.isPrimaryListener ?? true;
    this.isPrimaryListener = isPrimary;
    const cfg = getEngineAudioTuningConfig();
    this.packId = cfg.activePackId || 'turtle_modem';

    this.lowpassNode = ctx.createBiquadFilter();
    this.lowpassNode.type = 'lowpass';
    this.lowpassNode.frequency.value = 18000;
    this.lowpassNode.Q.value = 0.707;
    this.outputNode = ctx.createGain();
    this.outputNode.gain.value = 0;
    this.lowpassNode.connect(this.outputNode);
    this.outputNode.connect(this.destination);
    this.voiceGraph = new TurtleModemGranularVoiceGraph(
      ctx,
      this.lowpassNode,
      isPrimary ? 'primary-full' : 'remote-lod'
    );

    if (isPrimary) {
      registerEngineAudioRuntimeActions({
        triggerBackfireTest: () => this.playEntitySpawnSfx(true),
        triggerEntitySpawnTest: () => this.playEntitySpawnSfx(true),
        triggerZeroSpeedReset: () => this.reset(),
        setManualBenchState: () => {},
      });
    }
    this._ensurePackLoaded(this.packId);
  }

  private _ensurePackLoaded(packId: EngineAudioPackId): void {
    const resolved = getResolvedEngineAudioPackAssets(packId);
    if (resolved) {
      this.assets = resolved;
      if ((this.isPrimaryListener || this.active) && !this.voiceGraph.graphBuilt) {
        this.voiceGraph.build(resolved);
      }
      return;
    }
    if (this.loadingPromise) return;
    this.loadingPromise = loadEngineAudioPackAssets(this.ctx, packId)
      .then((loaded) => {
        this.assets = loaded;
        this.loadingPromise = null;
        if ((this.isPrimaryListener || this.active) && !this.voiceGraph.graphBuilt) {
          this.voiceGraph.build(loaded);
        }
      })
      .catch(() => {
        this.loadingPromise = null;
      });
  }

  start(): void {
    if (this.active) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.active = true;
    this._ensurePackLoaded(this.packId);
  }

  playEntitySpawnSfx(forceAudition = false): void {
    this._ensurePackLoaded(this.packId);
    const buf = this.assets?.entitySpawnBuffer;
    if (!buf || (!forceAudition && (!this.audible || this.dormant))) return;
    playEngineSynthOneShotBuffer(this.ctx, this.destination, buf, this.engineVolume * 0.8, 1.0);
  }

  applyWasmCarCue(cue: WasmCarAudioCue, isAudibleActive = true): void {
    if (!this.active) this.start();
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const resolvedDt = clampSmoothingDtSec(
      this.lastUpdatePerfMs > 0 ? (nowPerf - this.lastUpdatePerfMs) / 1000 : undefined
    );
    this.lastUpdatePerfMs = nowPerf;

    const cfg = getEngineAudioTuningConfig();
    if (cfg.activePackId && cfg.activePackId !== this.packId) {
      this.packId = cfg.activePackId;
      this.voiceGraph.teardown();
      this._ensurePackLoaded(this.packId);
    }
    const desiredLod: EngineSynthLodMode = this.isPrimaryListener ? 'primary-full' : 'remote-lod';
    if (this.voiceGraph.lodMode !== desiredLod) {
      this.voiceGraph.setLodMode(desiredLod, this.assets);
    }

    this.alive = cue.active;
    this.audible = isAudibleActive;
    this.dormant = cue.dormant;
    this.distanceUU = cue.distanceUU;

    const targetGain =
      isAudibleActive && cue.active && !cue.dormant ? Math.max(0, cue.engineGain) : 0;
    const outStep = applySmoothedAudioParamValue(
      this.outputNode.gain,
      this.smoothedOutputGain,
      this.lastOutputGain,
      targetGain,
      resolvedDt,
      0.02,
      OUTPUT_GAIN_DEADBAND
    );
    this.smoothedOutputGain = outStep.smoothed;
    this.lastOutputGain = outStep.written;

    if (this.smoothedOutputGain <= OUTPUT_GAIN_DEADBAND && targetGain <= OUTPUT_GAIN_DEADBAND) {
      this.voiceGraph.silence();
      return;
    }

    if (!this.voiceGraph.graphBuilt || !this.voiceGraph.sliceChannels.length) {
      if (this.assets) this.voiceGraph.build(this.assets);
      if (!this.voiceGraph.graphBuilt) return;
    }

    this.voiceGraph.applyWasmCue(cue, cfg, resolvedDt);

    if (this.isPrimaryListener) {
      this.telemetryPublishCounter = (this.telemetryPublishCounter + 1) % 3;
      if (this.telemetryPublishCounter === 0) {
        publishEngineAudioTelemetry({
          packId: this.packId,
          loaded: this.voiceGraph.graphBuilt,
          loadedSlicesCount: this.voiceGraph.sliceChannels.length,
          currentRPM: cue.engineRpm,
          targetRPM: cue.engineRpm,
          currentGear: cue.gear,
          smoothThrottle: cue.engineLoad,
          isUnderStrain: cue.strain,
          isInOverdrive: cue.overdrive,
          lowerSliceIndex: cue.lowerSliceIdx,
          upperSliceIndex: cue.upperSliceIdx,
          filterCutoffHz: cue.filterCutoffHz,
        });
      }
    }
  }

  private _muteOutput(): void {
    resetAudioParamValueImmediate(this.outputNode?.gain, 0, this.ctx?.currentTime);
    this.smoothedOutputGain = 0;
    this.lastOutputGain = 0;
  }

  setDormant(dormant: boolean): void {
    const next = Boolean(dormant);
    if (this.dormant === next) return;
    this.dormant = next;
    if (this.dormant) {
      this._muteOutput();
      this.voiceGraph.silence();
    }
  }

  setVolume(vol: number): void {
    if (typeof vol === 'number' && Number.isFinite(vol)) {
      this.engineVolume = Math.max(0, Math.min(2.0, vol));
    }
  }

  silence(): void {
    if (this.ctx && this.outputNode) this._muteOutput();
    this.voiceGraph.silence();
  }

  reset(): void {
    this.silence();
  }

  dispose(): void {
    this.active = false;
    this.voiceGraph.teardown();
    this.voiceGraph.disposeEq();
    const now = this.ctx?.currentTime;
    resetAudioParamValueImmediate(this.lowpassNode?.frequency, 18000, now);
    resetAudioParamValueImmediate(this.outputNode?.gain, 0, now);
    this.lastOutputGain = 0;
    try {
      this.lowpassNode.disconnect();
      this.outputNode.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export interface EngineSynthSlotEntry {
  synth: TurtleModemEngineSynth | null;
  spatialBus: SpatialAudioSource | null;
  spatial: boolean;
  position: { x: number; y: number; z: number };
  wasDemoed: boolean;
  dormant?: boolean;
  distanceUU?: number;
}

export interface WasmEngineLodUpdateInput {
  f32: Float32Array;
  u32: Uint32Array;
  cueWordBase: number;
  activeCar: number;
  effectiveNumCars: number;
  isAudibleActive: boolean;
  activeCarMesh: { visible?: boolean; position?: SpatialVector3Like | null } | null | undefined;
  arenaCars:
    | ArrayLike<{ visible?: boolean; position?: SpatialVector3Like | null } | null | undefined>
    | null
    | undefined;
  resolveCarView: (carIndex: number) => CarStateView | null;
}

export class RemoteEngineAudioLodController {
  engineSynths: EngineSynthSlotEntry[] = [];
  private readonly _cueScratch: WasmCarAudioCue = createEmptyWasmCarAudioCue();

  resetAll(activeCar = 0): void {
    for (let i = 0; i < this.engineSynths.length; i++) {
      const e = this.engineSynths[i];
      const prim = i === activeCar;
      e.wasDemoed = false;
      e.dormant = !prim;
      e.distanceUU = 0;
      e.synth?.setDormant?.(!prim);
      e.synth?.reset?.();
      e.spatialBus?.setEnabled?.(false);
      if (prim) e.synth?.playEntitySpawnSfx?.(false);
    }
  }

  countActiveAwakeSynths(): number {
    let c = 0;
    for (const e of this.engineSynths) if (e?.synth?.active && !e.synth.dormant) c++;
    return c;
  }

  applyWasmFrame(inp: WasmEngineLodUpdateInput): void {
    const {
      f32,
      u32,
      cueWordBase,
      activeCar,
      effectiveNumCars,
      isAudibleActive,
      activeCarMesh,
      arenaCars,
      resolveCarView,
    } = inp;
    const ctx = getAudioContext();
    const master = getMasterAudioInput();
    while (this.engineSynths.length < Math.max(2, effectiveNumCars)) {
      const idx = this.engineSynths.length;
      const sp = idx !== activeCar;
      const bus = ctx && master && sp ? new SpatialAudioSource(ctx, master, 'engine_other') : null;
      const synth =
        ctx && master
          ? new TurtleModemEngineSynth(ctx, bus ? bus.input : master, { isPrimaryListener: !sp })
          : null;
      if (synth && sp) synth.setDormant(true);
      this.engineSynths.push({
        synth,
        spatialBus: bus,
        spatial: sp,
        position: { x: 0, y: 0, z: 0 },
        wasDemoed: false,
        dormant: sp,
        distanceUU: 0,
      });
    }

    for (let i = 0; i < this.engineSynths.length; i++) {
      const e = this.engineSynths[i];
      const prim = i === activeCar;
      if (e.synth) e.synth.isPrimaryListener = prim;
      if (i >= effectiveNumCars || !isAudibleActive) {
        e.dormant = !prim;
        e.synth?.setDormant(!prim);
        e.synth?.silence();
        e.spatialBus?.setEnabled(false);
        continue;
      }

      const cue = readWasmCarAudioCue(f32, u32, cueWordBase, i, this._cueScratch);
      e.distanceUU = cue.distanceUU;
      e.dormant = cue.dormant;

      const cv = resolveCarView(i);
      const mp = prim
        ? activeCarMesh?.position
        : arenaCars?.[i]?.visible
          ? arenaCars?.[i]?.position
          : null;
      if (mp) {
        e.position.x = mp.x;
        e.position.y = mp.y;
        e.position.z = mp.z;
      } else if (cv) {
        e.position.x = cv.posX;
        e.position.y = cv.posZ;
        e.position.z = cv.posY;
      }

      const demo = Boolean(cv?.isDemoed);
      if (e.wasDemoed && !demo) {
        e.synth?.playEntitySpawnSfx(false);
      }
      e.wasDemoed = demo;

      e.spatialBus?.setPosition(e.position);
      e.spatialBus?.setEnabled(!prim && cue.active && !cue.dormant && isAudibleActive);
      e.synth?.applyWasmCarCue(cue, isAudibleActive);
    }
  }

  dispose(): void {
    for (const e of this.engineSynths) {
      e.synth?.dispose?.();
      e.spatialBus?.dispose?.();
    }
    this.engineSynths.length = 0;
  }
}
