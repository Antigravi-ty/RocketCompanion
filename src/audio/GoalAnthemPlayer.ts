import { type SpatialAudioTunerConfig } from '../ui-core/config/spatialAudioConfig.ts';
import {
  ANTHEM_SPECIFIC_CATEGORIES,
  resolvePlayableAnthemDef,
  type AnthemDef,
} from '../ui-core/config/anthemCatalogConfig.ts';
import { useSpatialAudioStore } from '../game/runtimeUiPort.ts';
import {
  SpatialAudioBusChain,
  evaluateSpatialBezierBlend,
  stepSpatialBezierTransition,
  TAIL_DRAIN_MIN_GUARD_SEC,
  TAIL_DRAIN_SILENCE_THRESHOLD,
  TAIL_DRAIN_SILENCE_HOLD_SEC,
  TAIL_DRAIN_SAFETY_MARGIN_SEC,
  type SpatialAudioRuntimeContextSnapshot,
} from './SpatialAudioBusChain.ts';

export type { SpatialAudioRuntimeContextSnapshot };

export type AnthemPlaybackMode = 'garage-preview' | 'tuner-audition' | 'goal-replay' | 'goal';
export type AnthemPreviewSource = 'garage-preview' | 'tuner-audition';

export interface GoalAnthemDeps {
  ensureAudioGraph(autoResume?: boolean): AudioContext | null;
  getAudioContext(): AudioContext | null;
  getAnthemChain(): SpatialAudioBusChain | null;
  getImpulseBuffer(): AudioBuffer | null;
  getOutputGain(forceActive?: boolean): number;
  isWindowUnfocusedMuted(): boolean;
  getRuntimeContext(): SpatialAudioRuntimeContextSnapshot;
  notifyPlaybackOrDrainStateChanged(): void;
}

const SPECIFIC_CATEGORY_ID_SET = new Set(ANTHEM_SPECIFIC_CATEGORIES.map((c) => c.id));

export class GoalAnthemPlayer {
  private readonly deps: GoalAnthemDeps;

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

  constructor(deps: GoalAnthemDeps) {
    this.deps = deps;
  }

  isActiveOrDraining(): boolean {
    return this.activeMode !== null || this.isTailDraining;
  }

  isGoalSequenceAnthemActive(): boolean {
    const m = this.activeMode,
      d = this.drainingMode;
    return (
      m === 'goal-replay' ||
      m === 'goal' ||
      this.isGoalAnthemLoading ||
      (this.isTailDraining && (d === 'goal-replay' || d === 'goal'))
    );
  }

  isPreviewOrPreviewDrainActive(): boolean {
    const m = this.activeMode,
      d = this.drainingMode;
    return (
      m === 'garage-preview' ||
      m === 'tuner-audition' ||
      (this.isTailDraining && (d === 'garage-preview' || d === 'tuner-audition'))
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

  async loadAnthemBuffer(anthemDef: AnthemDef | null | undefined): Promise<AudioBuffer | null> {
    const fileUrl = anthemDef?.file ? `/${anthemDef.file.replace(/^\//, '')}` : null;
    if (!fileUrl || !anthemDef) return null;

    const cached = this.bufferCache.get(anthemDef.id);
    if (cached) return cached;

    const existing = this.loadingPromises.get(anthemDef.id);
    if (existing) return existing;

    const ctx = this.deps.ensureAudioGraph();
    if (!ctx) return null;

    const promise = fetch(fileUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => ctx.decodeAudioData(buf))
      .then((audioBuf) => {
        this.bufferCache.set(anthemDef.id, audioBuf);
        this.loadingPromises.delete(anthemDef.id);
        return audioBuf;
      })
      .catch(() => {
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
        /* ignore */
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

  private _resetPhaseAndChain(): void {
    const store = useSpatialAudioStore.getState();
    this.linearPhase = 0.0;
    this.blend = 0.0;
    this.deps.getAnthemChain()?.resetAndSilence(store.tunerConfig);
    store.setAnthemTransitionState(0.0, 0.0);
  }

  beginTailDrain(mode: AnthemPlaybackMode | null, anthemId: string | null = null): void {
    const store = useSpatialAudioStore.getState();
    const cfg = store.tunerConfig || {};
    const targetPhase = this.computeTargetPhase(cfg, mode);
    const hasSpatial =
      !this.deps.isWindowUnfocusedMuted() &&
      Boolean(this.deps.getAnthemChain()) &&
      this.deps.getOutputGain(true) > 1e-4 &&
      Number(cfg.wetMaxPct) > 0 &&
      (this.blend > 1e-4 || targetPhase > 1e-4);

    if (!hasSpatial) {
      this.completeTailDrain();
      return;
    }

    const ctx = this.deps.getAudioContext();
    this.isTailDraining = true;
    this.drainingMode = mode;
    this.drainingAnthemId = anthemId;
    this.drainMinTargetPhase = Math.max(this.linearPhase, targetPhase);
    this.tailDrainStartCtxTime = ctx ? ctx.currentTime : 0;
    this.tailDrainStartPerfMs = typeof performance !== 'undefined' ? performance.now() : 0;
    this.tailSilentAccumSec = 0;

    if (anthemId && store.activeGoalAnthemId !== anthemId) store.setActiveGoalAnthemId(anthemId);
    this.deps.notifyPlaybackOrDrainStateChanged();
  }

  completeTailDrain(): void {
    this.cancelTailDrain();
    const store = useSpatialAudioStore.getState();
    if (this.activeMode === null) {
      this._resetPhaseAndChain();
      if (store.activeGoalAnthemId !== null) store.setActiveGoalAnthemId(null);
    }
    this.deps.notifyPlaybackOrDrainStateChanged();
  }

  updateTailDrain(
    dt: number,
    now: number,
    cfg: Partial<SpatialAudioTunerConfig>,
    targetAnthemU: number
  ): void {
    if (!this.isTailDraining) return;
    const anthemChain = this.deps.getAnthemChain();
    if (!anthemChain || this.deps.isWindowUnfocusedMuted()) {
      this.completeTailDrain();
      return;
    }

    const decaySec = Math.max(
      0.4,
      Number(this.deps.getImpulseBuffer()?.duration) || Number(cfg.decaySec) || 3.0
    );
    const ctx = this.deps.getAudioContext();
    const ctxElapsed =
      ctx?.state === 'running' ? Math.max(0, ctx.currentTime - this.tailDrainStartCtxTime) : -1;
    const elapsedSec =
      ctxElapsed >= 0 ? ctxElapsed : Math.max(0, (now - this.tailDrainStartPerfMs) / 1000);

    if (elapsedSec >= decaySec + TAIL_DRAIN_SAFETY_MARGIN_SEC) {
      this.completeTailDrain();
      return;
    }
    if (elapsedSec < TAIL_DRAIN_MIN_GUARD_SEC || targetAnthemU > this.linearPhase + 1e-3) {
      this.tailSilentAccumSec = 0;
      return;
    }

    const { peak, valid } = anthemChain.sampleOutputPeak();
    if (valid) {
      if (peak <= TAIL_DRAIN_SILENCE_THRESHOLD) {
        this.tailSilentAccumSec += dt;
        if (this.tailSilentAccumSec >= TAIL_DRAIN_SILENCE_HOLD_SEC) this.completeTailDrain();
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
    if (cfg.overrideMode === 'manual')
      return Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0));

    const mode =
      modeOverride || this.activeMode || (this.isTailDraining ? this.drainingMode : null);
    const store = useSpatialAudioStore.getState();

    if (mode === 'garage-preview') {
      if (store.isGarageAnthemTabActive)
        return this.isTailDraining ? this.drainMinTargetPhase : 0.0;
      if (this.isTailDraining)
        return (this.drainMinTargetPhase = Math.max(this.drainMinTargetPhase, 1.0));
      return 1.0;
    }

    if (mode === 'tuner-audition' || mode === 'goal-replay' || mode === 'goal') {
      const ctx = this.deps.getRuntimeContext();
      const target =
        Boolean(ctx?.isOpen) || Boolean(store.isGoalReplaySkipped) || ctx?.matchPhase !== 'replay'
          ? 1.0
          : 0.0;
      if (this.isTailDraining)
        return (this.drainMinTargetPhase = Math.max(this.drainMinTargetPhase, target));
      return target;
    }

    return 0.0;
  }

  applyTunerConfig(cfg: Partial<SpatialAudioTunerConfig>): void {
    this.blend = evaluateSpatialBezierBlend(this.linearPhase, cfg);
    this.deps.getAnthemChain()?.applyBlend(this.blend, cfg, this.deps.getOutputGain());
  }

  stepTransition(
    dt: number,
    now: number,
    maxDelta: number,
    cfg: Partial<SpatialAudioTunerConfig>
  ): void {
    const store = useSpatialAudioStore.getState();
    const targetAnthemU = this.computeTargetPhase(cfg);
    const next = stepSpatialBezierTransition(this.linearPhase, targetAnthemU, maxDelta, cfg);
    this.linearPhase = next.linearPhase;
    this.blend = next.blend;

    this.deps.getAnthemChain()?.applyBlend(this.blend, cfg, this.deps.getOutputGain());
    if (this.isTailDraining) this.updateTailDrain(dt, now, cfg, targetAnthemU);

    if (
      Math.abs(store.anthemLinearPhase - this.linearPhase) > 0.005 ||
      Math.abs(store.anthemBlend - this.blend) > 0.005
    ) {
      store.setAnthemTransitionState(this.linearPhase, this.blend);
    }
  }

  private _primeChainAndMountSource(
    ctx: AudioContext,
    anthemChain: SpatialAudioBusChain,
    buffer: AudioBuffer,
    mode: AnthemPlaybackMode,
    anthemId: string,
    onEndedExtra?: () => void
  ): boolean {
    const store = useSpatialAudioStore.getState();
    const cfg = store.tunerConfig || {};
    anthemChain.resetAndSilence(cfg);

    this.linearPhase = this.computeTargetPhase(cfg, mode);
    this.blend = evaluateSpatialBezierBlend(this.linearPhase, cfg);
    anthemChain.applyBlend(this.blend, cfg, this.deps.getOutputGain(true), true);
    store.setAnthemTransitionState(this.linearPhase, this.blend);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(anthemChain.input);
    this.activeSource = src;
    this.activeMode = mode;
    this.activeAnthemId = anthemId;

    src.onended = () => {
      if (this.activeSource === src) {
        const finishedId = this.activeAnthemId || anthemId;
        const finishedMode = this.activeMode || mode;
        this.activeSource = null;
        this.activeMode = null;
        this.activeAnthemId = null;
        onEndedExtra?.();
        this.beginTailDrain(finishedMode, finishedId);
      }
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
    };

    try {
      src.start(ctx.currentTime);
      return true;
    } catch (err) {
      console.warn(`[GoalAnthemPlayer] Failed to start anthem source (${mode}):`, err);
      this.activeSource = null;
      this.activeMode = null;
      this.activeAnthemId = null;
      return false;
    }
  }

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
    this.deps.notifyPlaybackOrDrainStateChanged();

    const resolved = this.resolveAnthemDefinition(anthemId);
    const ctx = resolved?.file ? this.deps.ensureAudioGraph() : null;
    const anthemChain = this.deps.getAnthemChain();
    if (!resolved?.file || !ctx || !anthemChain) {
      store.setPreviewingAnthemId(null);
      anthemChain?.resetAndSilence(store.tunerConfig);
      return;
    }

    anthemChain.resetAndSilence(store.tunerConfig);
    const buffer = await this.loadAnthemBuffer(resolved);
    if (token !== this.previewToken || !buffer) {
      if (token === this.previewToken) useSpatialAudioStore.getState().setPreviewingAnthemId(null);
      return;
    }

    const clearPreview = () => useSpatialAudioStore.getState().setPreviewingAnthemId(null);
    if (
      !this._primeChainAndMountSource(ctx, anthemChain, buffer, previewMode, anthemId, clearPreview)
    ) {
      this.deps
        .getAnthemChain()
        ?.resetAndSilence(useSpatialAudioStore.getState().tunerConfig || {});
      clearPreview();
    }
  }

  stopPreview(): void {
    this.previewToken++;
    const store = useSpatialAudioStore.getState();
    if (store.previewingAnthemId !== null) store.setPreviewingAnthemId(null);
    if (this.activeMode === 'garage-preview' || this.activeMode === 'tuner-audition') {
      const stoppedId = this.activeAnthemId,
        stoppedMode = this.activeMode;
      this.stopCurrentSource();
      this.beginTailDrain(stoppedMode, stoppedId);
      return;
    }
    if (this.activeMode === null && !this.isTailDraining) this._resetPhaseAndChain();
    this.deps.notifyPlaybackOrDrainStateChanged();
  }

  async startGoalReplayAnthem(
    anthemId: string | null = useSpatialAudioStore.getState().selectedAnthem
  ): Promise<void> {
    if (!anthemId || anthemId === 'none') {
      this.isGoalAnthemLoading = false;
      this.deps.notifyPlaybackOrDrainStateChanged();
      return;
    }

    const token = ++this.previewToken;
    this.cancelTailDrain();
    this.stopCurrentSource();
    this.isGoalAnthemLoading = true;
    useSpatialAudioStore.getState().setPreviewingAnthemId(null);

    const resolved = this.resolveAnthemDefinition(anthemId);
    const ctx = resolved?.file ? this.deps.ensureAudioGraph() : null;
    const anthemChain = this.deps.getAnthemChain();
    if (!resolved?.file || !ctx || !anthemChain) {
      this.isGoalAnthemLoading = false;
      this.deps.notifyPlaybackOrDrainStateChanged();
      return;
    }

    const buffer = await this.loadAnthemBuffer(resolved);
    if (token !== this.previewToken || !buffer) {
      if (token === this.previewToken) {
        this.isGoalAnthemLoading = false;
        this.deps.notifyPlaybackOrDrainStateChanged();
      }
      return;
    }

    this.isGoalAnthemLoading = false;
    useSpatialAudioStore.getState().setActiveGoalAnthemId(resolved.id);

    if (!this._primeChainAndMountSource(ctx, anthemChain, buffer, 'goal-replay', resolved.id)) {
      useSpatialAudioStore.getState().setActiveGoalAnthemId(null);
      this.deps.notifyPlaybackOrDrainStateChanged();
    }
  }
}
