/**
 * StadiumSpatialAudioEngine.ts
 * Orchestrates Non-Linear Directional Stadium Spatial Audio for Player Goal Anthems
 * and Background Music, bridging UI/game runtime context with Web Audio bus chains.
 */

import { audioConfig } from "../ui-core/config/audioConfig";
import { getAudioContext, getMasterAudioInput } from "./audioContext.ts";
import { type SpatialAudioTunerConfig } from "../ui-core/config/spatialAudioConfig";
import { type AnthemDef } from "../ui-core/config/anthemCatalogConfig";
import { fetchAudioBuffer } from "./audioAssetLoader.ts";
import {
  useSpatialAudioStore,
  useHudStore,
  useAppStore,
  useStaticTrainingPackStore,
} from "../game/runtimeUiPort.ts";
import {
  buildStadiumImpulseBuffer,
  SpatialAudioBusChain,
} from "./SpatialAudioBusChain.ts";
import {
  GoalAnthemPlayer,
  type AnthemPlaybackMode,
  type AnthemPreviewSource,
  type SpatialAudioRuntimeContextSnapshot,
} from "./GoalAnthemPlayer.ts";
import { BackgroundMusicController } from "./BackgroundMusicController.ts";

const BGM_PREVIEW_SAMPLE_URL =
  "/assets/audio/bgm/Hollywood Principle - Breathing Underwater (Ether Remix).m4a";
const BGM_PREVIEW_FALLBACK_URL =
  "/assets/audio/bgm/Mike Ault - Flying Forever (feat. Morgan Perry).m4a";

export type PlaySampleBufferCallback = (
  buffer: AudioBuffer,
  volume: number,
  options?: { offset?: number; maxDurationSec?: number }
) => void;

type FetchAudioBufferFn = (
  ctx: AudioContext,
  url: string,
  fallbackUrl?: string | null
) => Promise<AudioBuffer | null>;

const fetchAudioBufferTyped = fetchAudioBuffer as unknown as FetchAudioBufferFn;
const getAudioContextTyped = getAudioContext as unknown as () => AudioContext | null;
const getMasterAudioInputTyped = getMasterAudioInput as unknown as () => AudioNode | null;

export class StadiumSpatialAudioEngine {
  ctx: AudioContext | null = null;
  impulseBuffer: AudioBuffer | null = null;
  lastImpulseDecaySec = -1;
  private _decayRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  anthemChain: SpatialAudioBusChain | null = null;
  bgmChain: SpatialAudioBusChain | null = null;

  readonly anthemPlayer: GoalAnthemPlayer;
  readonly bgmController: BackgroundMusicController;

  private _cachedBgmPreviewBuffer: AudioBuffer | null = null;
  _isWindowUnfocusedMuted = false;

  runtimeContext: SpatialAudioRuntimeContextSnapshot = {
    isOpen: false,
    matchMode: "freeplay",
    onlineSession: null,
    matchPhase: "playing",
    choreographySignal: null,
    replayScorerAnthemId: null,
    staticTrainingReplayType: null,
  };

  private _lastRafTime = 0;
  private _rafId: number | null = null;
  private _lastHudMatchPhase: string | null = null;
  private _lastChoreographySignal: string | null = null;
  private _initialized = false;

  constructor() {
    this.anthemPlayer = new GoalAnthemPlayer({
      ensureAudioGraph: (autoResume = true) => this._ensureAudioGraph(autoResume),
      getAudioContext: () => this.ctx,
      getAnthemChain: () => this.anthemChain,
      getImpulseBuffer: () => this.impulseBuffer,
      getOutputGain: (forceActive = false) => this._getAnthemOutputGain(forceActive),
      isWindowUnfocusedMuted: () => this._isWindowUnfocusedMuted,
      getRuntimeContext: () => this.runtimeContext,
      onPlaybackOrDrainStateChanged: () => {
        this._refreshGoalSequenceBgmGate();
        this.syncBgmPlaybackState();
      },
    });

    this.bgmController = new BackgroundMusicController({
      ensureAudioGraph: (autoResume = true) => this._ensureAudioGraph(autoResume),
      getBgmChain: () => this.bgmChain,
      getBgmVolScalar: (store) => this._getBgmVolScalar(store),
      isWindowUnfocusedMuted: () => this._isWindowUnfocusedMuted,
      getRuntimeContext: () => this.runtimeContext,
      isPreviewOrPreviewDrainActive: () =>
        this.anthemPlayer.isPreviewOrPreviewDrainActive(),
      refreshGoalSequenceBgmGate: () => this._refreshGoalSequenceBgmGate(),
    });
  }

  get activeAnthemMode(): AnthemPlaybackMode | null {
    return this.anthemPlayer.activeMode;
  }

  get activeAnthemId(): string | null {
    return this.anthemPlayer.activeAnthemId;
  }

  get anthemBlend(): number {
    return this.anthemPlayer.blend;
  }

  init(): void {
    if (this._initialized || typeof window === 'undefined') return;
    this._initialized = true;

    const store = useSpatialAudioStore.getState();
    store.registerRuntimeCallbacks({
      onPreviewAnthem: (anthemId: string, source?: AnthemPreviewSource) =>
        this.startAnthemPreview(anthemId, source),
      onStopPreviewAnthem: () => this.stopAnthemPreview(),
      onSelectBgmTrack: (trackId: string) => this.playBgmTrackById(trackId),
      onNextBgmTrack: () => this.playNextBgmTrack(1),
      onPrevBgmTrack: () => this.playNextBgmTrack(-1),
      onToggleBgmPlayPause: () => this.toggleBgmPlayPause(),
      onBgmPrefsChanged: () => this.syncBgmPlaybackState(),
      onBgmFilesUploaded: () => this.onBgmFilesUploaded(),
      onTunerConfigChanged: (cfg: SpatialAudioTunerConfig) =>
        this.onTunerConfigChanged(cfg),
    });

    const syncFromPort = () => {
      const appState = useAppStore.getState() || {};
      const hudState = useHudStore.getState() || {};
      const trainingState = useStaticTrainingPackStore.getState() || {};
      this.updateRuntimeContext({
        isOpen: Boolean(appState.isOpen ?? appState.isMenuOpen),
        matchMode: appState.matchMode || "freeplay",
        onlineSession: appState.onlineSession || null,
        matchPhase: hudState.matchPhase || "playing",
        choreographySignal: hudState.choreographySignal || null,
        replayScorerAnthemId: hudState.replayScorerAnthemId || null,
        staticTrainingReplayType:
          trainingState.liveTelemetry?.replayType ?? trainingState.replayType ?? null,
      });
    };

    syncFromPort();
    useHudStore.subscribe(() => syncFromPort());
    useAppStore.subscribe(() => syncFromPort());
    useStaticTrainingPackStore.subscribe(() => syncFromPort());

    audioConfig.subscribe(() => {
      const curStore = useSpatialAudioStore.getState();
      const cfg = curStore.tunerConfig;
      const anthemOutGain = this._getAnthemOutputGain();
      const bgmVolScalar = this._getBgmVolScalar(curStore);
      this.anthemChain?.applyBlend(this.anthemBlend, cfg, anthemOutGain);
      this.bgmController.applyCurrentChainBlend(cfg, bgmVolScalar);
    });

    this._startTransitionLoop();
  }

  updateRuntimeContext(
    partial: Partial<SpatialAudioRuntimeContextSnapshot> = {}
  ): void {
    const prevContext = this.runtimeContext;
    const nextContext: SpatialAudioRuntimeContextSnapshot = {
      ...prevContext,
      ...partial,
    };
    this.runtimeContext = nextContext;

    const nextSignal = nextContext.choreographySignal;
    const prevSignal = this._lastChoreographySignal;
    if (nextSignal !== prevSignal) {
      this._lastChoreographySignal = nextSignal;
      if (
        nextSignal === "goal-replay-will-start" &&
        !this._isTrainingShotExpire()
      ) {
        this.bgmController.goalSequenceActive = true;
        this.syncBgmPlaybackState();
      }
    }

    const nextPhase = nextContext.matchPhase;
    const prevPhase = this._lastHudMatchPhase;
    if (nextPhase !== prevPhase) {
      this._lastHudMatchPhase = nextPhase;
      if (prevPhase !== null) {
        this._handleMatchPhaseTransition(prevPhase, nextPhase);
      }
    }

    if (
      prevContext.isOpen !== nextContext.isOpen ||
      prevContext.matchMode !== nextContext.matchMode ||
      prevContext.onlineSession !== nextContext.onlineSession
    ) {
      this.syncBgmPlaybackState();
    }
  }

  _getAnthemOutputGain(forceActive = false): number {
    const isActive = forceActive || this.anthemPlayer.isActiveOrDraining();
    if (!isActive) return 0.0;
    const raw = Number(audioConfig.get('anthemVolume') ?? 1.0);
    return Math.max(0, Math.min(5.0, Number.isFinite(raw) ? raw : 1.0));
  }

  _getBgmVolScalar(store = useSpatialAudioStore.getState()): number {
    const baseScalar = Math.max(
      0,
      Math.min(1, (Number(store.bgmVolume) ?? 80) / 100)
    );
    const busMult = Number(audioConfig.get('bgmBusVolume') ?? 1.0);
    const safeBusMult = Math.max(
      0,
      Math.min(5.0, Number.isFinite(busMult) ? busMult : 1.0)
    );
    return baseScalar * safeBusMult;
  }

  prewarm(): void {
    try {
      this._ensureAudioGraph(false);
    } catch {
      // ignore prewarm errors before user gesture
    }
  }

  handleWindowFocusChange(hasFocus: boolean, continueOnBlur: boolean): void {
    const shouldMuteUnfocused = !hasFocus && !continueOnBlur;
    if (shouldMuteUnfocused) {
      if (this._isWindowUnfocusedMuted) return;
      this._isWindowUnfocusedMuted = true;
      if (
        this.activeAnthemMode === 'garage-preview' ||
        this.activeAnthemMode === 'tuner-audition'
      ) {
        this.stopAnthemPreview();
      }
      if (this.anthemPlayer.isTailDraining) {
        this.anthemPlayer.completeTailDrain();
      }
      const store = useSpatialAudioStore.getState();
      this.bgmController.handleFocusChanged(true, store.tunerConfig);
    } else if (this._isWindowUnfocusedMuted) {
      this._isWindowUnfocusedMuted = false;
      if (typeof performance !== 'undefined') {
        this._lastRafTime = performance.now();
      }
      const store = useSpatialAudioStore.getState();
      this.bgmController.handleFocusChanged(false, store.tunerConfig);
    }
  }

  _isTrainingShotExpire(): boolean {
    if (this.runtimeContext.matchMode === 'static-training-pack') {
      return this.runtimeContext.staticTrainingReplayType === 'expire';
    }
    return false;
  }

  _ensureAudioGraph(autoResume = true): AudioContext | null {
    const ctx = getAudioContextTyped();
    const masterInput = getMasterAudioInputTyped() || ctx?.destination || null;
    if (!ctx || !masterInput) return null;

    if (autoResume && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const store = useSpatialAudioStore.getState();
    const cfg = store.tunerConfig || {};
    const decaySec = Number(cfg.decaySec) || 3.0;
    const bgmVolScalar = this._getBgmVolScalar(store);
    const anthemOutGain = this._getAnthemOutputGain();

    if (!this.ctx || this.ctx !== ctx) {
      this.ctx = ctx;
      this.impulseBuffer = buildStadiumImpulseBuffer(ctx, decaySec);
      this.lastImpulseDecaySec = decaySec;
      this.anthemChain = new SpatialAudioBusChain(
        ctx,
        masterInput,
        this.impulseBuffer
      );
      this.bgmChain = new SpatialAudioBusChain(
        ctx,
        masterInput,
        this.impulseBuffer
      );
      this.anthemChain.applyBlend(this.anthemBlend, cfg, anthemOutGain, true);
      this.bgmController.applyCurrentChainBlend(cfg, bgmVolScalar, true);
      this.bgmController.attachToBusChain(ctx, this.bgmChain);
    } else if (Math.abs(decaySec - this.lastImpulseDecaySec) > 0.05) {
      this.lastImpulseDecaySec = decaySec;
      this.impulseBuffer = buildStadiumImpulseBuffer(ctx, decaySec);
      this.anthemChain?.setImpulseBuffer(this.impulseBuffer);
      this.bgmChain?.setImpulseBuffer(this.impulseBuffer);
    }

    this.bgmController.attachToBusChain(ctx, this.bgmChain);
    return ctx;
  }

  onTunerConfigChanged(cfg: Partial<SpatialAudioTunerConfig>): void {
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
          Number(useSpatialAudioStore.getState().tunerConfig?.decaySec) || 3.0;
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

    this.anthemPlayer.applyTunerConfig(cfg);
    this.bgmController.applyTunerConfig(cfg, bgmVolScalar);
  }

  // ============================================================================
  // Player Anthem & BGM Delegation
  // ============================================================================

  _loadAnthemBuffer(anthemDef: AnthemDef | null | undefined): Promise<AudioBuffer | null> {
    return this.anthemPlayer.loadAnthemBuffer(anthemDef);
  }

  startAnthemPreview(
    anthemId: string,
    source: AnthemPreviewSource = 'garage-preview'
  ): Promise<void> {
    return this.anthemPlayer.startPreview(anthemId, source);
  }

  stopAnthemPreview(): void {
    this.anthemPlayer.stopPreview();
  }

  startGoalReplayAnthem(anthemId?: string | null): Promise<void> {
    return this.anthemPlayer.startGoalReplayAnthem(anthemId);
  }

  async previewAnthemVolumeSample(playBufferFn: PlaySampleBufferCallback): Promise<void> {
    const ctx = getAudioContextTyped();
    if (!ctx || typeof playBufferFn !== 'function') return;
    const store = useSpatialAudioStore.getState();
    const prefId =
      store.selectedAnthem && store.selectedAnthem !== 'none'
        ? store.selectedAnthem
        : 'random';
    const resolved = this.anthemPlayer.resolveAnthemDefinition(prefId);
    let buf = resolved ? await this.anthemPlayer.loadAnthemBuffer(resolved) : null;
    if (!buf) {
      const url = resolved?.file
        ? `/${resolved.file.replace(/^\//, '')}`
        : BGM_PREVIEW_FALLBACK_URL;
      buf = await fetchAudioBufferTyped(ctx, url, BGM_PREVIEW_FALLBACK_URL);
    }
    if (!buf) return;
    const anthemVol = Number(audioConfig.get('anthemVolume') ?? 1.0);
    playBufferFn(buf, anthemVol, { maxDurationSec: 2.2 });
  }

  async previewBgmVolumeSample(playBufferFn: PlaySampleBufferCallback): Promise<void> {
    const ctx = getAudioContextTyped();
    if (!ctx || typeof playBufferFn !== 'function') return;
    if (!this._cachedBgmPreviewBuffer) {
      this._cachedBgmPreviewBuffer = await fetchAudioBufferTyped(
        ctx,
        BGM_PREVIEW_SAMPLE_URL,
        BGM_PREVIEW_FALLBACK_URL
      );
    }
    const buf = this._cachedBgmPreviewBuffer;
    if (!buf) return;
    const bgmBusVol = Number(audioConfig.get('bgmBusVolume') ?? 1.0);
    const offset = buf.duration > 16 ? 12.0 : 0.0;
    playBufferFn(buf, bgmBusVol, { offset, maxDurationSec: 2.2 });
  }

  private _handleMatchPhaseTransition(prevPhase: string, nextPhase: string): void {
    const store = useSpatialAudioStore.getState();

    if (nextPhase === 'goal' && prevPhase !== 'goal') {
      if (!this._isTrainingShotExpire()) {
        this.bgmController.goalSequenceActive = true;
      }
      this.syncBgmPlaybackState();
      return;
    }

    if (nextPhase === 'replay' && prevPhase !== 'replay') {
      if (this._isTrainingShotExpire()) {
        return;
      }
      this.bgmController.goalSequenceActive = true;
      store.setGoalReplaySkipped(false);
      const scorerAnthemId = this.runtimeContext.replayScorerAnthemId;
      this.startGoalReplayAnthem(scorerAnthemId || store.selectedAnthem);
      this.syncBgmPlaybackState();
    } else if (
      (prevPhase === 'replay' || prevPhase === 'goal') &&
      nextPhase !== 'replay' &&
      nextPhase !== 'goal'
    ) {
      store.setGoalReplaySkipped(true);
      this._refreshGoalSequenceBgmGate();
      this.syncBgmPlaybackState();
    }
  }

  _refreshGoalSequenceBgmGate(): boolean {
    const currentPhase = this.runtimeContext.matchPhase;
    const isGoalOrReplayPhase =
      (currentPhase === 'goal' || currentPhase === 'replay') &&
      !this._isTrainingShotExpire();
    const isAnthemStillActive = this.anthemPlayer.isGoalSequenceAnthemActive();
    return this.bgmController.updateGoalSequenceGate(isGoalOrReplayPhase, isAnthemStillActive);
  }

  notifyGoalReplaySkipped(): void {
    useSpatialAudioStore.getState().setGoalReplaySkipped(true);
    this._refreshGoalSequenceBgmGate();
    this.syncBgmPlaybackState();
  }

  onBgmFilesUploaded(): void {
    this.bgmController.onFilesUploaded();
  }

  syncBgmPlaybackState(): void {
    this.bgmController.syncPlaybackState();
  }

  playBgmTrackById(trackId: string): void {
    this.bgmController.playTrackById(trackId);
  }

  playNextBgmTrack(direction = 1): void {
    this.bgmController.playNextTrack(direction);
  }

  toggleBgmPlayPause(): void {
    this.bgmController.togglePlayPause();
  }

  private _startTransitionLoop(): void {
    if (typeof window === 'undefined' || this._rafId !== null) return;
    this._lastRafTime = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.1, Math.max(0.0, (now - this._lastRafTime) / 1000));
      this._lastRafTime = now;

      const store = useSpatialAudioStore.getState();
      const cfg = store.tunerConfig || {};
      const duration = Math.max(0.05, Number(cfg.transitionDurationSec) || 2.0);
      const maxDelta = dt / duration;

      this.anthemPlayer.stepTransition(dt, now, maxDelta, cfg);
      this.bgmController.stepTransition(
        dt,
        maxDelta,
        cfg,
        this._getBgmVolScalar(store)
      );

      this._rafId = window.requestAnimationFrame(step);
    };

    this._rafId = window.requestAnimationFrame(step);
  }
}

export const stadiumSpatialAudioEngine = new StadiumSpatialAudioEngine();
