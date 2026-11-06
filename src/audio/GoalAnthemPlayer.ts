/**
 * GoalAnthemPlayer.ts
 * Stateful SubController managing Player Anthem AudioBuffer decoding/caching,
 * Goal Replay celebration playback, Garage/Tuner anthem preview playback,
 * directional Cubic-Bezier phase transitions, and post-playback spatial reverb tail drain.
 */

import {
  solveCubicBezier,
  type SpatialAudioTunerConfig,
} from "../ui-core/config/spatialAudioConfig";
import {
  ANTHEM_SPECIFIC_CATEGORIES,
  resolvePlayableAnthemDef,
  type AnthemDef,
} from "../ui-core/config/anthemCatalogConfig";
import { useSpatialAudioStore } from "../game/runtimeUiPort.ts";
import {
  SpatialAudioBusChain,
  TAIL_DRAIN_MIN_GUARD_SEC,
  TAIL_DRAIN_SILENCE_THRESHOLD,
  TAIL_DRAIN_SILENCE_HOLD_SEC,
  TAIL_DRAIN_SAFETY_MARGIN_SEC,
} from "./SpatialAudioBusChain.ts";

export type AnthemPlaybackMode =
  | 'garage-preview'
  | 'tuner-audition'
  | 'goal-replay'
  | 'goal';

export type AnthemPreviewSource = 'garage-preview' | 'tuner-audition';

export interface SpatialAudioRuntimeContextSnapshot {
  isOpen: boolean;
  matchMode: string;
  onlineSession: Record<string, unknown> | null;
  matchPhase: string;
  choreographySignal: string | null;
  replayScorerAnthemId: string | null;
  staticTrainingReplayType: string | null;
}

export interface GoalAnthemHostPort {
  ensureAudioGraph(autoResume?: boolean): AudioContext | null;
  getAudioContext(): AudioContext | null;
  getAnthemChain(): SpatialAudioBusChain | null;
  getImpulseBuffer(): AudioBuffer | null;
  getOutputGain(forceActive?: boolean): number;
  isWindowUnfocusedMuted(): boolean;
  getRuntimeContext(): SpatialAudioRuntimeContextSnapshot;
  onPlaybackOrDrainStateChanged(): void;
}

const SPECIFIC_CATEGORY_ID_SET = new Set(
  ANTHEM_SPECIFIC_CATEGORIES.map((c) => c.id)
);

export class GoalAnthemPlayer {
  private readonly host: GoalAnthemHostPort;

  readonly bufferCache = new Map<string, AudioBuffer>();
  readonly loadingPromises = new Map<string, Promise<AudioBuffer | null>>();

  activeSource: AudioBufferSourceNode | null = null;
  activeMode: AnthemPlaybackMode | null = null;
  activeAnthemId: string | null = null;
  isGoalAnthemLoading = false;
  previewToken = 0;

  isTailDraining = false;
  drainingMode: AnthemPlaybackMode | null = null;
  drainingAnthemId: string | null = null;
  drainMinTargetPhase = 0.0;
  tailDrainStartCtxTime = 0;
  tailDrainStartPerfMs = 0;
  tailSilentAccumSec = 0;

  linearPhase = 0.0;
  blend = 0.0;

  constructor(host: GoalAnthemHostPort) {
    this.host = host;
  }

  isActiveOrDraining(): boolean {
    return this.activeMode !== null || this.isTailDraining;
  }

  isGoalSequenceAnthemActive(): boolean {
    return (
      this.activeMode === 'goal-replay' ||
      this.activeMode === 'goal' ||
      this.isGoalAnthemLoading ||
      (this.isTailDraining &&
        (this.drainingMode === 'goal-replay' || this.drainingMode === 'goal'))
    );
  }

  isPreviewOrPreviewDrainActive(): boolean {
    return (
      this.activeMode === 'garage-preview' ||
      this.activeMode === 'tuner-audition' ||
      (this.isTailDraining &&
        (this.drainingMode === 'garage-preview' ||
          this.drainingMode === 'tuner-audition'))
    );
  }

  resolveAnthemDefinition(anthemId: string | null | undefined): AnthemDef | null {
    const store = useSpatialAudioStore.getState();
    const trimmed = typeof anthemId === 'string' ? anthemId.trim() : '';
    if (trimmed && SPECIFIC_CATEGORY_ID_SET.has(trimmed)) {
      return resolvePlayableAnthemDef('random', {
        randomScope: 'specific',
        randomCategory: trimmed,
      });
    }
    return resolvePlayableAnthemDef(anthemId, {
      randomScope: store.randomAnthemScope,
      randomCategory: store.randomAnthemCategory,
    });
  }

  async loadAnthemBuffer(
    anthemDef: AnthemDef | null | undefined
  ): Promise<AudioBuffer | null> {
    const fileUrl = anthemDef?.file ? `/${anthemDef.file.replace(/^\//, '')}` : null;
    if (!fileUrl || !anthemDef) return null;

    const cached = this.bufferCache.get(anthemDef.id);
    if (cached) return cached;

    const existingPromise = this.loadingPromises.get(anthemDef.id);
    if (existingPromise) return existingPromise;

    const ctx = this.host.ensureAudioGraph();
    if (!ctx) return null;

    const promise = fetch(fileUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${fileUrl}`);
        return res.arrayBuffer();
      })
      .then((arrayBuf) => ctx.decodeAudioData(arrayBuf))
      .then((audioBuffer) => {
        this.bufferCache.set(anthemDef.id, audioBuffer);
        this.loadingPromises.delete(anthemDef.id);
        return audioBuffer;
      })
      .catch((err) => {
        console.warn(`[GoalAnthemPlayer] Failed to decode anthem ${anthemDef.id}:`, err);
        this.loadingPromises.delete(anthemDef.id);
        return null;
      });

    this.loadingPromises.set(anthemDef.id, promise);
    return promise;
  }

  stopCurrentSource(): void {
    if (this.activeSource) {
      const src = this.activeSource;
      this.activeSource = null;
      src.onended = null;
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore already stopped source
      }
    }
    this.activeMode = null;
    this.activeAnthemId = null;
    this.isGoalAnthemLoading = false;
  }

  cancelTailDrain(): void {
    this.isTailDraining = false;
    this.drainingMode = null;
    this.drainingAnthemId = null;
    this.drainMinTargetPhase = 0.0;
    this.tailDrainStartCtxTime = 0;
    this.tailDrainStartPerfMs = 0;
    this.tailSilentAccumSec = 0;
  }

  /**
   * Transitions the Anthem bus into post-playback reverb tail drain mode after the dry
   * AudioBufferSourceNode finishes or is paused while spatial stadium effects are active.
   * Keeps the Anthem bus output open until the convolver tail has decayed to zero.
   */
  beginTailDrain(
    mode: AnthemPlaybackMode | null,
    anthemId: string | null = null
  ): void {
    const store = useSpatialAudioStore.getState();
    const cfg = store.tunerConfig || {};
    const targetPhase = this.computeTargetPhase(cfg, mode);
    const anthemChain = this.host.getAnthemChain();
    const hasSpatialEffect =
      !this.host.isWindowUnfocusedMuted() &&
      Boolean(anthemChain) &&
      this.host.getOutputGain(true) > 1e-4 &&
      Number(cfg.wetMaxPct) > 0 &&
      (this.blend > 1e-4 || targetPhase > 1e-4);

    if (!hasSpatialEffect) {
      this.completeTailDrain();
      return;
    }

    const ctx = this.host.getAudioContext();
    this.isTailDraining = true;
    this.drainingMode = mode;
    this.drainingAnthemId = anthemId;
    this.drainMinTargetPhase = Math.max(this.linearPhase, targetPhase);
    this.tailDrainStartCtxTime = ctx ? ctx.currentTime : 0;
    this.tailDrainStartPerfMs =
      typeof performance !== 'undefined' ? performance.now() : 0;
    this.tailSilentAccumSec = 0;

    if (anthemId && store.activeGoalAnthemId !== anthemId) {
      store.setActiveGoalAnthemId(anthemId);
    }
    this.host.onPlaybackOrDrainStateChanged();
  }

  completeTailDrain(): void {
    this.cancelTailDrain();
    const store = useSpatialAudioStore.getState();
    if (this.activeMode === null) {
      this.linearPhase = 0.0;
      this.blend = 0.0;
      this.host.getAnthemChain()?.resetAndSilence(store.tunerConfig);
      store.setAnthemTransitionState(0.0, 0.0);
      if (store.activeGoalAnthemId !== null) {
        store.setActiveGoalAnthemId(null);
      }
    }
    this.host.onPlaybackOrDrainStateChanged();
  }

  updateTailDrain(
    dt: number,
    now: number,
    cfg: Partial<SpatialAudioTunerConfig>,
    targetAnthemU: number
  ): void {
    if (!this.isTailDraining) return;
    const anthemChain = this.host.getAnthemChain();
    if (!anthemChain || this.host.isWindowUnfocusedMuted()) {
      this.completeTailDrain();
      return;
    }

    const impulseBuffer = this.host.getImpulseBuffer();
    const decaySec = Math.max(
      0.4,
      Number(impulseBuffer?.duration) || Number(cfg.decaySec) || 3.0
    );
    const maxCeilingSec = decaySec + TAIL_DRAIN_SAFETY_MARGIN_SEC;
    const ctx = this.host.getAudioContext();
    const ctxElapsed =
      ctx && ctx.state === 'running'
        ? Math.max(0, ctx.currentTime - this.tailDrainStartCtxTime)
        : -1;
    const wallElapsed = Math.max(0, (now - this.tailDrainStartPerfMs) / 1000);
    const elapsedSec = ctxElapsed >= 0 ? ctxElapsed : wallElapsed;

    if (elapsedSec >= maxCeilingSec) {
      this.completeTailDrain();
      return;
    }

    const isTransitioningUp = targetAnthemU > this.linearPhase + 1e-3;
    if (elapsedSec < TAIL_DRAIN_MIN_GUARD_SEC || isTransitioningUp) {
      this.tailSilentAccumSec = 0;
      return;
    }

    const { peak, valid } = anthemChain.sampleOutputPeak();
    if (valid) {
      if (peak <= TAIL_DRAIN_SILENCE_THRESHOLD) {
        this.tailSilentAccumSec += dt;
        if (this.tailSilentAccumSec >= TAIL_DRAIN_SILENCE_HOLD_SEC) {
          this.completeTailDrain();
        }
      } else {
        this.tailSilentAccumSec = 0;
      }
    }
  }

  computeTargetPhase(
    cfg: Partial<SpatialAudioTunerConfig> = {},
    modeOverride: AnthemPlaybackMode | null = null
  ): number {
    if (cfg.overrideMode === 'normal') return 0.0;
    if (cfg.overrideMode === 'spatial') return 1.0;
    if (cfg.overrideMode === 'manual') {
      return Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0));
    }

    const effectiveMode =
      modeOverride ||
      this.activeMode ||
      (this.isTailDraining ? this.drainingMode : null);

    if (effectiveMode === 'garage-preview') {
      const store = useSpatialAudioStore.getState();
      if (store.isGarageAnthemTabActive) {
        return this.isTailDraining ? this.drainMinTargetPhase : 0.0;
      }
      const target = 1.0;
      if (this.isTailDraining) {
        this.drainMinTargetPhase = Math.max(this.drainMinTargetPhase, target);
        return this.drainMinTargetPhase;
      }
      return target;
    }

    if (
      effectiveMode === 'tuner-audition' ||
      effectiveMode === 'goal-replay' ||
      effectiveMode === 'goal'
    ) {
      const store = useSpatialAudioStore.getState();
      const ctx = this.host.getRuntimeContext();
      const isMenuOpen = Boolean(ctx?.isOpen);
      const isReplayPhase = ctx?.matchPhase === 'replay';
      const isSkipped = Boolean(store.isGoalReplaySkipped);

      const target = isMenuOpen || isSkipped || !isReplayPhase ? 1.0 : 0.0;
      if (this.isTailDraining) {
        this.drainMinTargetPhase = Math.max(this.drainMinTargetPhase, target);
        return this.drainMinTargetPhase;
      }
      return target;
    }

    return 0.0;
  }

  applyTunerConfig(cfg: Partial<SpatialAudioTunerConfig>): void {
    this.blend =
      cfg.overrideMode === 'manual'
        ? Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0))
        : solveCubicBezier(
            this.linearPhase,
            Number(cfg.bzX1) || 0.22,
            Number(cfg.bzY1) || 1.0,
            Number(cfg.bzX2) || 1.0,
            Number(cfg.bzY2) || 1.0
          );
    this.host
      .getAnthemChain()
      ?.applyBlend(this.blend, cfg, this.host.getOutputGain());
  }

  stepTransition(
    dt: number,
    now: number,
    maxDelta: number,
    cfg: Partial<SpatialAudioTunerConfig>
  ): void {
    const store = useSpatialAudioStore.getState();
    const targetAnthemU = this.computeTargetPhase(cfg);

    if (cfg.overrideMode === 'manual') {
      this.linearPhase = targetAnthemU;
      this.blend = targetAnthemU;
    } else {
      if (Math.abs(targetAnthemU - this.linearPhase) > 1e-4) {
        if (targetAnthemU > this.linearPhase) {
          this.linearPhase = Math.min(targetAnthemU, this.linearPhase + maxDelta);
        } else {
          this.linearPhase = Math.max(targetAnthemU, this.linearPhase - maxDelta);
        }
      } else {
        this.linearPhase = targetAnthemU;
      }
      this.blend = solveCubicBezier(
        this.linearPhase,
        Number(cfg.bzX1) || 0.22,
        Number(cfg.bzY1) || 1.0,
        Number(cfg.bzX2) || 1.0,
        Number(cfg.bzY2) || 1.0
      );
    }

    const anthemChain = this.host.getAnthemChain();
    if (anthemChain) {
      const anthemOutGain = this.host.getOutputGain();
      anthemChain.applyBlend(this.blend, cfg, anthemOutGain);
    }

    if (this.isTailDraining) {
      this.updateTailDrain(dt, now, cfg, targetAnthemU);
    }

    if (
      Math.abs(store.anthemLinearPhase - this.linearPhase) > 0.005 ||
      Math.abs(store.anthemBlend - this.blend) > 0.005
    ) {
      store.setAnthemTransitionState(this.linearPhase, this.blend);
    }
  }

  /**
   * Starts previewing an anthem in the Garage Anthem tab ('garage-preview')
   * or auditioning in the Spatial Audio Tuner ('tuner-audition').
   */
  async startPreview(
    anthemId: string,
    source: AnthemPreviewSource = 'garage-preview'
  ): Promise<void> {
    const previewMode: AnthemPlaybackMode =
      source === 'tuner-audition' ? 'tuner-audition' : 'garage-preview';
    const token = ++this.previewToken;
    this.cancelTailDrain();
    this.stopCurrentSource();

    const store = useSpatialAudioStore.getState();
    store.setActiveGoalAnthemId(null);

    this.host.onPlaybackOrDrainStateChanged();

    const resolved = this.resolveAnthemDefinition(anthemId);
    if (!resolved || !resolved.file) {
      store.setPreviewingAnthemId(null);
      this.host.getAnthemChain()?.resetAndSilence(store.tunerConfig);
      return;
    }

    const ctx = this.host.ensureAudioGraph();
    const anthemChain = this.host.getAnthemChain();
    if (!ctx || !anthemChain) {
      store.setPreviewingAnthemId(null);
      return;
    }

    anthemChain.resetAndSilence(store.tunerConfig);

    const buffer = await this.loadAnthemBuffer(resolved);
    if (token !== this.previewToken || !buffer) {
      if (token === this.previewToken) {
        useSpatialAudioStore.getState().setPreviewingAnthemId(null);
      }
      return;
    }

    const latestCfg = useSpatialAudioStore.getState().tunerConfig || {};
    const initialPhase = this.computeTargetPhase(latestCfg, previewMode);
    this.linearPhase = initialPhase;
    this.blend =
      latestCfg.overrideMode === 'manual'
        ? initialPhase
        : solveCubicBezier(
            initialPhase,
            Number(latestCfg.bzX1) || 0.22,
            Number(latestCfg.bzY1) || 1.0,
            Number(latestCfg.bzX2) || 1.0,
            Number(latestCfg.bzY2) || 1.0
          );
    anthemChain.applyBlend(
      this.blend,
      latestCfg,
      this.host.getOutputGain(true),
      true
    );
    useSpatialAudioStore
      .getState()
      .setAnthemTransitionState(this.linearPhase, this.blend);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(anthemChain.input);
    this.activeSource = src;
    this.activeMode = previewMode;
    this.activeAnthemId = anthemId;

    src.onended = () => {
      if (this.activeSource === src) {
        const finishedId = this.activeAnthemId || resolved.id;
        const finishedMode = this.activeMode || previewMode;
        this.activeSource = null;
        this.activeMode = null;
        this.activeAnthemId = null;
        useSpatialAudioStore.getState().setPreviewingAnthemId(null);
        this.beginTailDrain(finishedMode, finishedId);
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
      console.warn('[GoalAnthemPlayer] Failed to start anthem preview source:', err);
      this.host.getAnthemChain()?.resetAndSilence(latestCfg);
      useSpatialAudioStore.getState().setPreviewingAnthemId(null);
    }
  }

  stopPreview(): void {
    this.previewToken++;
    const store = useSpatialAudioStore.getState();
    if (store.previewingAnthemId !== null) {
      store.setPreviewingAnthemId(null);
    }
    if (
      this.activeMode === 'garage-preview' ||
      this.activeMode === 'tuner-audition'
    ) {
      const stoppedId = this.activeAnthemId;
      const stoppedMode = this.activeMode;
      this.stopCurrentSource();
      this.beginTailDrain(stoppedMode, stoppedId);
      return;
    }
    if (this.activeMode === null && !this.isTailDraining) {
      this.linearPhase = 0.0;
      this.blend = 0.0;
      this.host.getAnthemChain()?.resetAndSilence(store.tunerConfig);
      store.setAnthemTransitionState(0.0, 0.0);
    }
    this.host.onPlaybackOrDrainStateChanged();
  }

  async startGoalReplayAnthem(
    anthemId: string | null = useSpatialAudioStore.getState().selectedAnthem
  ): Promise<void> {
    if (!anthemId || anthemId === 'none') {
      this.isGoalAnthemLoading = false;
      this.host.onPlaybackOrDrainStateChanged();
      return;
    }

    const token = ++this.previewToken;
    this.cancelTailDrain();
    this.stopCurrentSource();
    this.isGoalAnthemLoading = true;

    const store = useSpatialAudioStore.getState();
    store.setPreviewingAnthemId(null);

    const resolved = this.resolveAnthemDefinition(anthemId);
    if (!resolved || !resolved.file) {
      this.isGoalAnthemLoading = false;
      this.host.onPlaybackOrDrainStateChanged();
      return;
    }

    const ctx = this.host.ensureAudioGraph();
    const anthemChain = this.host.getAnthemChain();
    if (!ctx || !anthemChain) {
      this.isGoalAnthemLoading = false;
      this.host.onPlaybackOrDrainStateChanged();
      return;
    }

    const buffer = await this.loadAnthemBuffer(resolved);
    if (token !== this.previewToken || !buffer) {
      if (token === this.previewToken) {
        this.isGoalAnthemLoading = false;
        this.host.onPlaybackOrDrainStateChanged();
      }
      return;
    }

    this.isGoalAnthemLoading = false;

    const cfg = useSpatialAudioStore.getState().tunerConfig || {};
    anthemChain.resetAndSilence(cfg);

    const initialTarget = this.computeTargetPhase(cfg, 'goal-replay');
    this.linearPhase = initialTarget;
    this.blend =
      cfg.overrideMode === 'manual'
        ? initialTarget
        : solveCubicBezier(
            initialTarget,
            Number(cfg.bzX1) || 0.22,
            Number(cfg.bzY1) || 1.0,
            Number(cfg.bzX2) || 1.0,
            Number(cfg.bzY2) || 1.0
          );
    anthemChain.applyBlend(
      this.blend,
      cfg,
      this.host.getOutputGain(true),
      true
    );
    useSpatialAudioStore
      .getState()
      .setAnthemTransitionState(this.linearPhase, this.blend);
    useSpatialAudioStore.getState().setActiveGoalAnthemId(resolved.id);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(anthemChain.input);
    this.activeSource = src;
    this.activeMode = 'goal-replay';
    this.activeAnthemId = resolved.id;

    src.onended = () => {
      if (this.activeSource === src) {
        const finishedId = this.activeAnthemId || resolved.id;
        this.activeSource = null;
        this.activeMode = null;
        this.activeAnthemId = null;
        this.beginTailDrain('goal-replay', finishedId);
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
      console.warn('[GoalAnthemPlayer] Failed to start goal replay anthem:', err);
      this.activeSource = null;
      this.activeMode = null;
      this.activeAnthemId = null;
      useSpatialAudioStore.getState().setActiveGoalAnthemId(null);
      this.host.onPlaybackOrDrainStateChanged();
    }
  }
}
