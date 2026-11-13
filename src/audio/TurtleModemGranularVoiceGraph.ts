import type { EngineAudioTuningConfig } from '../ui-core/config/engineAudioConfig.ts';
import type {
  LoadedEngineAudioPackAssets,
  ConditionedEngineSliceBuffers,
} from './turtleModemSynthAcousticPipeline.ts';
import {
  applyAudioRateSmoothedParam,
  resetAudioParamValueImmediate,
} from './audioParamSmoothingPipeline.ts';
import type { WasmCarAudioCue } from './WasmAudioDirectorBridge.ts';

export type EngineSynthLodMode = 'primary-full' | 'remote-lod';
export const REMOTE_ENGINE_LOD_ANCHOR_COUNT = 10;

const FILTER_CUTOFF_DEADBAND_HZ = 5;
const PLAYBACK_RATE_DEADBAND = 1e-3;
const GAIN_DEADBAND = 1e-4;
const SLICE_RATE_SMOOTHING_TAU_SEC = 0.015;

export interface GranularSliceChannel {
  index: number;
  sourceSliceIndex: number;
  meta: ConditionedEngineSliceBuffers['meta'];
  autoNormDb: number;
  onSource: AudioBufferSourceNode;
  offSource: AudioBufferSourceNode | null;
  onGain: GainNode;
  offGain: GainNode | null;
  delayNode: DelayNode | null;
  smoothedOnGain: number;
  smoothedOffGain: number;
  smoothedRate: number;
  smoothedDelay: number;
  lastOnGain: number;
  lastOffGain: number;
  lastRate: number;
  lastDelay: number;
}

export function selectRemoteLodAnchorSlices(
  slices: readonly ConditionedEngineSliceBuffers[],
  targetCount: number = REMOTE_ENGINE_LOD_ANCHOR_COUNT
): Array<{ slice: ConditionedEngineSliceBuffers; sourceIndex: number }> {
  const total = slices.length;
  if (total === 0) return [];
  const count = Math.max(2, Math.min(total, targetCount));
  if (count >= total) return slices.map((slice, idx) => ({ slice, sourceIndex: idx }));
  const selected: Array<{ slice: ConditionedEngineSliceBuffers; sourceIndex: number }> = [];
  let lastIdx = -1;
  for (let k = 0; k < count; k++) {
    const idx = Math.round((k * (total - 1)) / (count - 1));
    if (idx !== lastIdx && slices[idx]) {
      selected.push({ slice: slices[idx], sourceIndex: idx });
      lastIdx = idx;
    }
  }
  return selected;
}

export class TurtleModemGranularVoiceGraph {
  readonly ctx: AudioContext;
  readonly lowpassNode: BiquadFilterNode;
  readonly eqLow: BiquadFilterNode;
  readonly eqMid: BiquadFilterNode;
  readonly eqHigh: BiquadFilterNode;

  lodMode: EngineSynthLodMode;
  graphBuilt = false;
  sliceChannels: GranularSliceChannel[] = [];
  idleSource: AudioBufferSourceNode | null = null;
  idleGain: GainNode | null = null;
  smoothedIdleGain = 0;
  smoothedIdleRate = 1;
  smoothedFilterCutoff = NaN;
  lastIdleGain = -1;
  lastIdleRate = -1;
  lastFilterCutoff = -1;
  private _lastUpdateSec = -1;

  constructor(
    ctx: AudioContext,
    lowpassNode: BiquadFilterNode,
    lodMode: EngineSynthLodMode = 'primary-full'
  ) {
    this.ctx = ctx;
    this.lowpassNode = lowpassNode;
    this.lodMode = lodMode;
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 130;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 520;
    this.eqMid.Q.value = 0.85;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 2400;
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(lowpassNode);
  }

  setLodMode(mode: EngineSynthLodMode, assets: LoadedEngineAudioPackAssets | null): void {
    if (this.lodMode === mode) return;
    const wasBuilt = this.graphBuilt;
    this.teardown();
    this.lodMode = mode;
    if (wasBuilt && assets) this.build(assets);
  }

  build(assets: LoadedEngineAudioPackAssets | null): boolean {
    if (this.graphBuilt || !assets) return this.graphBuilt;
    this.teardown();
    try {
      const now = this.ctx.currentTime;
      const isFull = this.lodMode === 'primary-full';
      const sliceTargetNode: AudioNode = isFull ? this.eqLow : this.lowpassNode;

      const idleSrc = this.ctx.createBufferSource();
      idleSrc.buffer = assets.idleBuffer;
      idleSrc.loop = true;
      const idleGain = this.ctx.createGain();
      idleGain.gain.value = 0;
      idleSrc.connect(idleGain);
      idleGain.connect(sliceTargetNode);
      const idleOffset =
        assets.idleBuffer.duration > 0.05 ? Math.random() * (assets.idleBuffer.duration * 0.8) : 0;
      idleSrc.start(now, idleOffset);

      this.idleSource = idleSrc;
      this.idleGain = idleGain;
      this.smoothedIdleGain = 0;
      this.smoothedIdleRate = 1;
      this.lastIdleGain = 0;
      this.lastIdleRate = 1;

      const sourceEntries = isFull
        ? assets.slices.map((slice, idx) => ({ slice, sourceIndex: idx }))
        : selectRemoteLodAnchorSlices(assets.slices, REMOTE_ENGINE_LOD_ANCHOR_COUNT);

      this.sliceChannels = sourceEntries.map(({ slice, sourceIndex }, idx) => {
        const onSource = this.ctx.createBufferSource();
        onSource.buffer = slice.onBuffer;
        onSource.loop = true;
        const onGain = this.ctx.createGain();
        onGain.gain.value = 0;
        onSource.connect(onGain);
        const onOffset =
          slice.onBuffer.duration > 0.05 ? Math.random() * (slice.onBuffer.duration * 0.8) : 0;
        onSource.start(now, onOffset);

        let offSource: AudioBufferSourceNode | null = null;
        let offGain: GainNode | null = null;
        let delayNode: DelayNode | null = null;

        if (isFull) {
          offSource = this.ctx.createBufferSource();
          offSource.buffer = slice.offBuffer;
          offSource.loop = true;
          offGain = this.ctx.createGain();
          offGain.gain.value = 0;
          offSource.connect(offGain);
          delayNode = this.ctx.createDelay(0.1);
          delayNode.delayTime.value = 0;
          onGain.connect(delayNode);
          offGain.connect(delayNode);
          delayNode.connect(sliceTargetNode);
          const offOffset =
            slice.offBuffer.duration > 0.05 ? Math.random() * (slice.offBuffer.duration * 0.8) : 0;
          offSource.start(now, offOffset);
        } else {
          onGain.connect(sliceTargetNode);
        }

        return {
          index: idx,
          sourceSliceIndex: sourceIndex,
          meta: slice.meta,
          autoNormDb: slice.autoNormDb ?? 0,
          onSource,
          offSource,
          onGain,
          offGain,
          delayNode,
          smoothedOnGain: 0,
          smoothedOffGain: 0,
          smoothedRate: 1,
          smoothedDelay: 0,
          lastOnGain: 0,
          lastOffGain: 0,
          lastRate: 1,
          lastDelay: 0,
        };
      });
      this.graphBuilt = true;
      return true;
    } catch {
      return false;
    }
  }

  teardown(): void {
    const now = this.ctx?.currentTime;
    resetAudioParamValueImmediate(this.idleSource?.playbackRate, 1, now);
    resetAudioParamValueImmediate(this.idleGain?.gain, 0, now);
    try {
      this.idleSource?.stop();
      this.idleSource?.disconnect();
      this.idleGain?.disconnect();
    } catch {
      /* ignore */
    }
    this.idleSource = null;
    this.idleGain = null;
    this.smoothedIdleGain = 0;
    this.smoothedIdleRate = 1;
    this.smoothedFilterCutoff = NaN;
    this.lastIdleGain = -1;
    this.lastIdleRate = -1;
    this.lastFilterCutoff = -1;
    this._lastUpdateSec = -1;

    for (const ch of this.sliceChannels) {
      resetAudioParamValueImmediate(ch.onSource?.playbackRate, 1, now);
      resetAudioParamValueImmediate(ch.offSource?.playbackRate, 1, now);
      resetAudioParamValueImmediate(ch.onGain?.gain, 0, now);
      resetAudioParamValueImmediate(ch.offGain?.gain, 0, now);
      resetAudioParamValueImmediate(ch.delayNode?.delayTime, 0, now);
      try {
        ch.onSource.stop();
        ch.onSource.disconnect();
        ch.offSource?.stop();
        ch.offSource?.disconnect();
        ch.onGain.disconnect();
        ch.offGain?.disconnect();
        ch.delayNode?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sliceChannels = [];
    this.graphBuilt = false;
  }

  disposeEq(): void {
    try {
      this.eqLow.disconnect();
      this.eqMid.disconnect();
      this.eqHigh.disconnect();
    } catch {
      /* ignore */
    }
  }

  silence(): void {
    if (!this.graphBuilt) return;
    const now = this.ctx?.currentTime;
    this.smoothedIdleGain = 0;
    if (this.idleGain && this.lastIdleGain !== 0) {
      resetAudioParamValueImmediate(this.idleGain.gain, 0, now);
      this.lastIdleGain = 0;
    }
    for (let i = 0; i < this.sliceChannels.length; i++) {
      const ch = this.sliceChannels[i];
      ch.smoothedOnGain = 0;
      ch.smoothedOffGain = 0;
      if (ch.lastOnGain !== 0) {
        resetAudioParamValueImmediate(ch.onGain.gain, 0, now);
        ch.lastOnGain = 0;
      }
      if (ch.offGain && ch.lastOffGain !== 0) {
        resetAudioParamValueImmediate(ch.offGain.gain, 0, now);
        ch.lastOffGain = 0;
      }
    }
  }

  applyWasmCue(cue: WasmCarAudioCue, cfg: EngineAudioTuningConfig, _dtSec?: number): void {
    if (!this.graphBuilt || this.sliceChannels.length === 0) return;
    const now = this.ctx.currentTime;
    this._lastUpdateSec = now;
    const tau = Math.max(0.004, Math.min(0.15, (cfg.gainSmoothingTimeMs ?? 15) / 1000));
    const isFull = this.lodMode === 'primary-full';

    if (isFull) {
      const eqL = Math.max(-18, Math.min(18, cfg.timbreLowShelfDb || 0));
      const eqM = Math.max(-18, Math.min(18, cfg.timbreMidPeakDb || 0));
      const eqH = Math.max(-18, Math.min(18, cfg.timbreHighShelfDb || 0));
      if (Math.abs(this.eqLow.gain.value - eqL) > 0.01) this.eqLow.gain.value = eqL;
      if (Math.abs(this.eqMid.gain.value - eqM) > 0.01) this.eqMid.gain.value = eqM;
      if (Math.abs(this.eqHigh.gain.value - eqH) > 0.01) this.eqHigh.gain.value = eqH;
    }

    const cutoff = Math.max(800, Math.min(20000, cue.filterCutoffHz || 18000));
    this.lastFilterCutoff = applyAudioRateSmoothedParam(
      this.lowpassNode.frequency,
      now,
      this.lastFilterCutoff < 0 ? NaN : this.lastFilterCutoff,
      cutoff,
      tau,
      FILTER_CUTOFF_DEADBAND_HZ
    );
    this.smoothedFilterCutoff = this.lastFilterCutoff;

    if (this.idleSource) {
      this.lastIdleRate = applyAudioRateSmoothedParam(
        this.idleSource.playbackRate,
        now,
        this.lastIdleRate < 0 ? NaN : this.lastIdleRate,
        cue.enginePitch,
        tau,
        PLAYBACK_RATE_DEADBAND
      );
      this.smoothedIdleRate = this.lastIdleRate;
    }
    if (this.idleGain) {
      this.lastIdleGain = applyAudioRateSmoothedParam(
        this.idleGain.gain,
        now,
        this.lastIdleGain < 0 ? NaN : this.lastIdleGain,
        cue.idleGain,
        tau,
        GAIN_DEADBAND
      );
      this.smoothedIdleGain = this.lastIdleGain;
    }

    const count = this.sliceChannels.length;
    let mappedLower = cue.lowerSliceIdx;
    let mappedUpper = cue.upperSliceIdx;
    if (!isFull) {
      let bestLowDist = Infinity;
      let bestUpDist = Infinity;
      for (let i = 0; i < count; i++) {
        const srcIdx = this.sliceChannels[i].sourceSliceIndex;
        const dLow = Math.abs(srcIdx - cue.lowerSliceIdx);
        if (dLow < bestLowDist) {
          bestLowDist = dLow;
          mappedLower = srcIdx;
        }
        const dUp = Math.abs(srcIdx - cue.upperSliceIdx);
        if (dUp < bestUpDist) {
          bestUpDist = dUp;
          mappedUpper = srcIdx;
        }
      }
    }

    const useDualReverseOff = isFull && cfg.decelMode === 'reverse-filter';
    const throttle = Math.max(0, Math.min(1, cue.engineLoad));
    const onRatio = useDualReverseOff ? throttle : 0.42 + 0.58 * throttle;
    const offRatio = useDualReverseOff ? (1.0 - throttle) * 0.72 : 0;

    for (let i = 0; i < count; i++) {
      const ch = this.sliceChannels[i];
      const srcIdx = ch.sourceSliceIndex;
      let sliceWeight = 0;
      let targetRate = 1.0;

      if (srcIdx === mappedLower) {
        sliceWeight += cue.lowerSliceGain;
        targetRate = cue.lowerSliceRate;
      }
      if (srcIdx === mappedUpper && mappedUpper !== mappedLower) {
        sliceWeight += cue.upperSliceGain;
        targetRate = cue.upperSliceRate;
      } else if (srcIdx === mappedUpper && mappedUpper === mappedLower) {
        sliceWeight += cue.upperSliceGain;
      }

      const targetOnGain = sliceWeight * onRatio;
      const targetOffGain = sliceWeight * offRatio;
      const wasSilent = ch.lastOnGain <= GAIN_DEADBAND && ch.lastOffGain <= GAIN_DEADBAND;

      if (sliceWeight <= GAIN_DEADBAND && wasSilent) {
        continue;
      }

      if (sliceWeight > GAIN_DEADBAND) {
        if (wasSilent) {
          resetAudioParamValueImmediate(ch.onSource.playbackRate, targetRate, now);
          if (ch.offSource) {
            resetAudioParamValueImmediate(ch.offSource.playbackRate, targetRate, now);
          }
          ch.lastRate = targetRate;
          ch.smoothedRate = targetRate;
        } else {
          const nextRate = applyAudioRateSmoothedParam(
            ch.onSource.playbackRate,
            now,
            ch.lastRate,
            targetRate,
            SLICE_RATE_SMOOTHING_TAU_SEC,
            PLAYBACK_RATE_DEADBAND
          );
          if (nextRate !== ch.lastRate && ch.offSource) {
            applyAudioRateSmoothedParam(
              ch.offSource.playbackRate,
              now,
              ch.lastRate,
              targetRate,
              SLICE_RATE_SMOOTHING_TAU_SEC,
              PLAYBACK_RATE_DEADBAND
            );
          }
          ch.lastRate = nextRate;
          ch.smoothedRate = nextRate;
        }
      }

      ch.lastOnGain = applyAudioRateSmoothedParam(
        ch.onGain.gain,
        now,
        ch.lastOnGain,
        targetOnGain,
        tau,
        GAIN_DEADBAND
      );
      ch.smoothedOnGain = ch.lastOnGain;

      if (ch.offGain) {
        ch.lastOffGain = applyAudioRateSmoothedParam(
          ch.offGain.gain,
          now,
          ch.lastOffGain,
          targetOffGain,
          tau,
          GAIN_DEADBAND
        );
        ch.smoothedOffGain = ch.lastOffGain;
      }
    }
  }
}
