import type { EngineAudioTuningConfig } from '../ui-core/config/engineAudioConfig.ts';
import type {
  LoadedEngineAudioPackAssets,
  ConditionedEngineSliceBuffers,
} from './EngineAudioLoopConditioner.ts';
import {
  EngineAudioEqualizer,
  evaluateSliceLoudnessCompensation,
} from './EngineAudioEqualizer.ts';

export type EngineSynthLodMode = 'primary-full' | 'remote-lod';

export const REMOTE_ENGINE_LOD_ANCHOR_COUNT = 10;

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
  lastOnGain: number;
  lastOffGain: number;
  lastRate: number;
  lastDelay: number;
}

export interface GranularGraphUpdateInput {
  cfg: EngineAudioTuningConfig;
  now: number;
  tau: number;
  currentRPM: number;
  smoothThrottle: number;
  isUnderStrain: boolean;
  isStationaryNeutral: boolean;
}

export interface GranularGraphUpdateResult {
  lowerSliceIndex: number;
  upperSliceIndex: number;
  lowerSliceFreqHz: number;
  upperSliceFreqHz: number;
  activeEqCompensationDb: number;
  effectiveIdleGain: number;
  filterCutoffHz: number;
}

/**
 * Selects a decimated set of RPM anchor slices for remote/non-primary vehicles,
 * always preserving the lowest (idle) and highest (redline) harmonic slices.
 */
export function selectRemoteLodAnchorSlices(
  slices: readonly ConditionedEngineSliceBuffers[],
  targetCount: number = REMOTE_ENGINE_LOD_ANCHOR_COUNT
): Array<{ slice: ConditionedEngineSliceBuffers; sourceIndex: number }> {
  const total = slices.length;
  if (total === 0) return [];
  const count = Math.max(2, Math.min(total, targetCount));
  if (count >= total) {
    return slices.map((slice, idx) => ({ slice, sourceIndex: idx }));
  }

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

/**
 * Manages the Web Audio granular harmonic oscillator bank for TurtleModemEngineSynth.
 * Supports two LOD tiers:
 * - 'primary-full': 40 dual-buffer (on + reversed-off) slices + 40 phase-decorrelation delays + 3-band EQ
 * - 'remote-lod': 10 single-buffer RPM anchor slices + 1 idle loop routed directly into the lowpass filter,
 *   reducing active AudioBufferSourceNodes per remote car from 81 to 11 (and 0 when hibernated).
 */
export class TurtleModemGranularVoiceGraph {
  readonly ctx: AudioContext;
  readonly lowpassNode: BiquadFilterNode;
  readonly equalizer: EngineAudioEqualizer;

  lodMode: EngineSynthLodMode;
  graphBuilt: boolean = false;
  sliceChannels: GranularSliceChannel[] = [];

  idleSource: AudioBufferSourceNode | null = null;
  idleGain: GainNode | null = null;
  lastIdleGain: number = -1;
  lastIdleRate: number = -1;
  lastFilterCutoff: number = -1;

  constructor(
    ctx: AudioContext,
    lowpassNode: BiquadFilterNode,
    equalizer: EngineAudioEqualizer,
    lodMode: EngineSynthLodMode = 'primary-full'
  ) {
    this.ctx = ctx;
    this.lowpassNode = lowpassNode;
    this.equalizer = equalizer;
    this.lodMode = lodMode;
  }

  setLodMode(mode: EngineSynthLodMode, assets: LoadedEngineAudioPackAssets | null): void {
    if (this.lodMode === mode) return;
    const wasBuilt = this.graphBuilt;
    this.teardown();
    this.lodMode = mode;
    if (wasBuilt && assets) {
      this.build(assets);
    }
  }

  build(assets: LoadedEngineAudioPackAssets | null): boolean {
    if (this.graphBuilt || !assets) return this.graphBuilt;
    this.teardown();

    try {
      const now = this.ctx.currentTime;
      const isFull = this.lodMode === 'primary-full';
      const sliceTargetNode: AudioNode = isFull ? this.equalizer.input : this.lowpassNode;

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
          // Remote LOD: connect onGain directly to lowpassNode (0 offSource, 0 DelayNode, 0 3-band EQ overhead)
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
          lastOnGain: 0,
          lastOffGain: 0,
          lastRate: 1,
          lastDelay: 0,
        };
      });

      this.graphBuilt = true;
      return true;
    } catch (err) {
      console.warn('[TurtleModemGranularVoiceGraph] Failed building granular graph:', err);
      return false;
    }
  }

  teardown(): void {
    try {
      this.idleSource?.stop();
      this.idleSource?.disconnect();
      this.idleGain?.disconnect();
    } catch {
      /* ignore */
    }
    this.idleSource = null;
    this.idleGain = null;
    this.lastIdleGain = -1;
    this.lastIdleRate = -1;

    for (const ch of this.sliceChannels) {
      try {
        ch.onSource.stop();
        ch.onSource.disconnect();
      } catch {
        /* ignore */
      }
      try {
        ch.offSource?.stop();
        ch.offSource?.disconnect();
      } catch {
        /* ignore */
      }
      try {
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

  update(input: GranularGraphUpdateInput): GranularGraphUpdateResult | null {
    if (!this.graphBuilt || this.sliceChannels.length === 0) return null;

    const { cfg, now, tau, currentRPM, smoothThrottle, isUnderStrain, isStationaryNeutral } = input;
    const isFull = this.lodMode === 'primary-full';

    if (isFull) {
      this.equalizer.update(cfg, now, tau);
    }

    const strainCutoffOffset = isUnderStrain ? -1800 : 0;
    const rawCutoff =
      cfg.decelMode === 'reverse-filter'
        ? 900 + smoothThrottle * 17100 + (currentRPM / cfg.redlineRPM) * 2000 + strainCutoffOffset
        : 2200 + smoothThrottle * 15800 + strainCutoffOffset;
    const filterCutoff = Math.max(800, Math.min(20000, rawCutoff));
    if (Math.abs(filterCutoff - this.lastFilterCutoff) > 5) {
      this.lowpassNode.frequency.setTargetAtTime(filterCutoff, now, tau);
      this.lastFilterCutoff = filterCutoff;
    }

    const idleWeight =
      currentRPM < 1450 ? Math.max(0, Math.min(1, 1.0 - (currentRPM - cfg.idleRPM) / 550)) : 0;
    const idleVolMult = Math.max(0, Math.min(2.0, cfg.idleVolume ?? 1.0));
    const effectiveIdleGain = idleWeight * idleVolMult;
    const idleRate = Math.max(0.5, Math.min(2.0, currentRPM / cfg.idleRPM));

    if (this.idleSource && Math.abs(idleRate - this.lastIdleRate) > 1e-3) {
      this.idleSource.playbackRate.setTargetAtTime(idleRate, now, tau);
      this.lastIdleRate = idleRate;
    }
    if (this.idleGain && Math.abs(effectiveIdleGain - this.lastIdleGain) > 1e-4) {
      this.idleGain.gain.setTargetAtTime(effectiveIdleGain, now, tau);
      this.lastIdleGain = effectiveIdleGain;
    }

    const count = this.sliceChannels.length;
    let lowerIdx = 0;
    for (let i = 0; i < count - 1; i++) {
      if (currentRPM >= this.sliceChannels[i].meta.rpm) lowerIdx = i;
      else break;
    }
    const upperIdx = Math.min(count - 1, lowerIdx + 1);
    const lowerMeta = this.sliceChannels[lowerIdx].meta;
    const upperMeta = this.sliceChannels[upperIdx].meta;

    const rpmSpan = upperMeta.rpm - lowerMeta.rpm;
    const mixAlpha =
      upperIdx !== lowerIdx && rpmSpan > 1e-3
        ? Math.max(0, Math.min(1, (currentRPM - lowerMeta.rpm) / rpmSpan))
        : 0;
    const wLower =
      cfg.crossfadeCurveType === 'equal-sine' ? Math.cos(mixAlpha * 0.5 * Math.PI) : 1.0 - mixAlpha;
    const wUpper =
      cfg.crossfadeCurveType === 'equal-sine' ? Math.sin(mixAlpha * 0.5 * Math.PI) : mixAlpha;

    const rpmEngagement = Math.max(0, Math.min(1, (currentRPM - cfg.idleRPM) / 160));
    const sliceEngagement = isStationaryNeutral
      ? 0
      : Math.max(rpmEngagement, Math.min(1, smoothThrottle * 2.5));
    const slicesMasterGain = (1.0 - idleWeight * 0.65) * sliceEngagement;

    const minFreq = this.sliceChannels[0].meta.freq;
    const maxFreq = this.sliceChannels[count - 1].meta.freq;
    const targetFreq =
      minFreq +
      ((currentRPM - cfg.idleRPM) / Math.max(1, cfg.redlineRPM - cfg.idleRPM)) *
        (maxFreq - minFreq);

    let activeEqCompensationDb = 0;
    const minRateClamp = isFull ? 0.7 : 0.65;
    const maxRateClamp = isFull ? 1.4 : 1.45;

    for (let i = 0; i < count; i++) {
      const ch = this.sliceChannels[i];
      let sliceWeight = 0;
      if (i === lowerIdx) sliceWeight += wLower;
      if (i === upperIdx && upperIdx !== lowerIdx) sliceWeight += wUpper;
      sliceWeight *= slicesMasterGain;

      let eqGain = 1.0;
      if (sliceWeight > 1e-4) {
        const comp = evaluateSliceLoudnessCompensation(
          cfg,
          ch.meta.freq,
          ch.autoNormDb,
          minFreq,
          maxFreq
        );
        eqGain = comp.linearGain;
        if (i === lowerIdx) {
          activeEqCompensationDb += comp.totalDb * (1 - mixAlpha);
        } else if (i === upperIdx && upperIdx !== lowerIdx) {
          activeEqCompensationDb += comp.totalDb * mixAlpha;
        }
      }
      const compensatedWeight = sliceWeight * eqGain;

      const useDualReverseOff = isFull && ch.offGain !== null && cfg.decelMode === 'reverse-filter';
      const targetOnGain = useDualReverseOff
        ? compensatedWeight * smoothThrottle
        : compensatedWeight * (0.42 + 0.58 * smoothThrottle);
      const targetOffGain = useDualReverseOff
        ? compensatedWeight * (1.0 - smoothThrottle) * 0.72
        : 0;

      if (compensatedWeight <= 1e-4 && ch.lastOnGain <= 1e-4 && ch.lastOffGain <= 1e-4) continue;

      if (compensatedWeight > 1e-4) {
        const rawRate = targetFreq / Math.max(15, ch.meta.freq);
        const clampedRate = Math.max(
          minRateClamp,
          Math.min(maxRateClamp, Number.isFinite(rawRate) ? rawRate : 1.0)
        );
        if (Math.abs(clampedRate - ch.lastRate) > 1e-3) {
          ch.onSource.playbackRate.setTargetAtTime(clampedRate, now, 0.015);
          ch.offSource?.playbackRate.setTargetAtTime(clampedRate, now, 0.015);
          ch.lastRate = clampedRate;
        }
      }
      if (Math.abs(targetOnGain - ch.lastOnGain) > 1e-4) {
        ch.onGain.gain.setTargetAtTime(targetOnGain, now, tau);
        ch.lastOnGain = targetOnGain;
      }
      if (ch.offGain && Math.abs(targetOffGain - ch.lastOffGain) > 1e-4) {
        ch.offGain.gain.setTargetAtTime(targetOffGain, now, tau);
        ch.lastOffGain = targetOffGain;
      }
      if (ch.delayNode) {
        const targetDelay =
          i === upperIdx && upperIdx !== lowerIdx ? cfg.decorrelationDelayMs / 1000 : 0;
        if (Math.abs(targetDelay - ch.lastDelay) > 1e-4) {
          ch.delayNode.delayTime.setTargetAtTime(targetDelay, now, 0.04);
          ch.lastDelay = targetDelay;
        }
      }
    }

    return {
      lowerSliceIndex: this.sliceChannels[lowerIdx].sourceSliceIndex,
      upperSliceIndex: this.sliceChannels[upperIdx].sourceSliceIndex,
      lowerSliceFreqHz: lowerMeta.freq,
      upperSliceFreqHz: upperMeta.freq,
      activeEqCompensationDb,
      effectiveIdleGain,
      filterCutoffHz: filterCutoff,
    };
  }
}
