/**
 * BackgroundMusicController.ts
 * Stateful SubController managing the hidden <audio> element, MediaSession integration,
 * scene gating, playlist navigation, directional Cubic-Bezier spatial blend,
 * and smooth BGM fade-in/out orchestration.
 */

import {
  DEFAULT_BGM_SCENE_CONFIG,
  type SpatialAudioTunerConfig,
} from '../ui-core/config/spatialAudioConfig.ts';
import {
  useSpatialAudioStore,
  getFilteredBgmTracks,
  type SpatialAudioStorePortState,
} from '../game/runtimeUiPort.ts';
import {
  SpatialAudioBusChain,
  evaluateSpatialBezierBlend,
  stepSpatialBezierTransition,
  type SpatialAudioRuntimeContextSnapshot,
} from './SpatialAudioBusChain.ts';

export interface BgmTrackEntry {
  id: string;
  title: string;
  volume?: string;
  file?: Blob | File;
}

export interface BackgroundMusicHostPort {
  ensureAudioGraph(autoResume?: boolean): AudioContext | null;
  getBgmChain(): SpatialAudioBusChain | null;
  getBgmVolScalar(store?: SpatialAudioStorePortState): number;
  isWindowUnfocusedMuted(): boolean;
  getRuntimeContext(): SpatialAudioRuntimeContextSnapshot;
  isPreviewOrPreviewDrainActive(): boolean;
  refreshGoalSequenceBgmGate(): boolean;
}

export class BackgroundMusicController {
  private readonly host: BackgroundMusicHostPort;

  audioEl: HTMLAudioElement | null = null;
  mediaSourceNode: MediaElementAudioSourceNode | null = null;
  objectUrl: string | null = null;
  currentTrack: BgmTrackEntry | null = null;

  userPaused = false;
  goalSequenceActive = false;
  fadeEnvelope = 0.0;
  linearPhase = 1.0;
  blend = 1.0;
  lastShouldBeAudible: boolean | undefined = undefined;

  constructor(host: BackgroundMusicHostPort) {
    this.host = host;
  }

  attachToBusChain(ctx: AudioContext, bgmChain: SpatialAudioBusChain | null): void {
    if (this.audioEl && bgmChain && !this.mediaSourceNode) {
      try {
        this.mediaSourceNode = ctx.createMediaElementSource(this.audioEl);
        this.mediaSourceNode.connect(bgmChain.input);
      } catch (err) {
        console.warn('[BackgroundMusicController] MediaElementSource attach failed:', err);
      }
    }
  }

  ensureAudioElement(): HTMLAudioElement | null {
    if (typeof document === 'undefined') return null;
    if (!this.audioEl) {
      const audioEl = document.createElement('audio');
      audioEl.preload = 'auto';
      audioEl.style.display = 'none';
      audioEl.dataset.rcBgmElement = 'true';
      document.body.appendChild(audioEl);

      audioEl.addEventListener('ended', () => {
        this.playNextTrack(1);
      });
      audioEl.addEventListener('play', () => {
        if (this.shouldBeAudible()) {
          useSpatialAudioStore.getState().setBgmPlaybackState({ isPlaying: true });
          this.updateMediaSessionPlaybackState('playing');
        }
      });
      audioEl.addEventListener('pause', () => {
        useSpatialAudioStore.getState().setBgmPlaybackState({ isPlaying: false });
        this.updateMediaSessionPlaybackState('paused');
      });

      this.audioEl = audioEl;

      const ctx = this.host.ensureAudioGraph();
      const bgmChain = this.host.getBgmChain();
      if (ctx && bgmChain) {
        this.attachToBusChain(ctx, bgmChain);
      }
    }
    return this.audioEl;
  }

  setupMediaSession(track: BgmTrackEntry | null): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      if (track && typeof window !== 'undefined' && typeof window.MediaMetadata === 'function') {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: track.title,
          artist: track.volume ? `RocketCompanion · Volume ${track.volume}` : 'RocketCompanion BGM',
          album: 'Background Music',
        });
      }
      navigator.mediaSession.setActionHandler('play', () => {
        this.userPaused = false;
        this.syncPlaybackState();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.userPaused = true;
        this.syncPlaybackState();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this.userPaused = false;
        this.playNextTrack(-1);
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this.userPaused = false;
        this.playNextTrack(1);
      });
    } catch {
      // Ignore unsupported mediaSession actions
    }
  }

  updateMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // ignore
    }
  }

  isCurrentSceneAllowed(
    store: Partial<SpatialAudioStorePortState> = useSpatialAudioStore.getState(),
    appState: Partial<SpatialAudioRuntimeContextSnapshot> = this.host.getRuntimeContext()
  ): boolean {
    const scenes = store.bgmScenes || DEFAULT_BGM_SCENE_CONFIG;
    const matchMode = appState.matchMode;
    const onlineSession = appState.onlineSession as {
      roomId?: string | null;
      roomType?: string | null;
    } | null;
    const hasOnlineRoom = Boolean(onlineSession?.roomId);

    if (hasOnlineRoom) {
      if (onlineSession?.roomType === 'warmup' && matchMode !== 'match') {
        return Boolean(scenes.multiplayerTraining);
      }
      return Boolean(scenes.match);
    }

    if (matchMode === 'online-warmup') {
      return Boolean(scenes.multiplayerTraining);
    }

    if (matchMode === 'match' || matchMode === 'exp-multi-bots') {
      return Boolean(scenes.match);
    }

    if (
      matchMode === 'kickoff-training' ||
      matchMode === 'static-training-pack' ||
      matchMode === 'dev-test-lab'
    ) {
      return Boolean(scenes.singlePlayerTraining);
    }

    return Boolean(scenes.freePlay);
  }

  shouldBeAudible(): boolean {
    if (this.host.isWindowUnfocusedMuted()) {
      return false;
    }

    const store = useSpatialAudioStore.getState();
    if (!store.bgmEnabled) {
      this.userPaused = false;
      return false;
    }

    if (this.userPaused) {
      return false;
    }

    const playlist = getFilteredBgmTracks(store) as BgmTrackEntry[];
    if (playlist.length === 0) return false;

    const appState = this.host.getRuntimeContext();
    if (!this.isCurrentSceneAllowed(store, appState)) {
      return false;
    }

    const isPreviewing =
      this.host.isPreviewOrPreviewDrainActive() || store.previewingAnthemId !== null;

    if (Boolean(appState.isOpen) && (store.isGarageAnthemTabActive || isPreviewing)) {
      return false;
    }

    if (isPreviewing || this.host.refreshGoalSequenceBgmGate()) {
      return false;
    }

    return true;
  }

  handleFocusChanged(muted: boolean, cfg: Partial<SpatialAudioTunerConfig>): void {
    this.fadeEnvelope = 0.0;
    if (muted) {
      this.lastShouldBeAudible = false;
      this.host.getBgmChain()?.resetAndSilence(cfg);
      if (this.audioEl && !this.audioEl.paused) {
        this.audioEl.pause();
      }
    } else {
      this.host.getBgmChain()?.applyBlend(this.blend, cfg, 0.0, true);
      this.syncPlaybackState();
    }
  }

  applyCurrentChainBlend(
    cfg: Partial<SpatialAudioTunerConfig>,
    bgmVolScalar: number,
    immediate = false
  ): void {
    this.host
      .getBgmChain()
      ?.applyBlend(this.blend, cfg, this.fadeEnvelope * bgmVolScalar, immediate);
  }

  updateGoalSequenceGate(isGoalOrReplayPhase: boolean, isAnthemStillActive: boolean): boolean {
    if (!this.goalSequenceActive) return false;
    if (!isGoalOrReplayPhase && !isAnthemStillActive) {
      this.goalSequenceActive = false;
    }
    return this.goalSequenceActive;
  }

  onFilesUploaded(): void {
    this.userPaused = false;
    const store = useSpatialAudioStore.getState();
    const playlist = getFilteredBgmTracks(store) as BgmTrackEntry[];
    if (playlist.length > 0 && store.bgmEnabled && this.shouldBeAudible()) {
      const randomIdx = Math.floor(Math.random() * playlist.length);
      this.loadAndPlayTrack(playlist[randomIdx]);
    } else if (playlist.length > 0 && !this.currentTrack) {
      const randomIdx = Math.floor(Math.random() * playlist.length);
      this.currentTrack = playlist[randomIdx];
      store.setBgmPlaybackState({
        currentTrackId: this.currentTrack.id,
        currentTrackTitle: this.currentTrack.title,
      });
    }
  }

  syncPlaybackState(): void {
    const store = useSpatialAudioStore.getState();
    const playlist = getFilteredBgmTracks(store) as BgmTrackEntry[];
    const shouldPlay = this.shouldBeAudible();

    if (!shouldPlay) {
      if (store.bgmIsPlaying) {
        store.setBgmPlaybackState({ isPlaying: false });
        this.updateMediaSessionPlaybackState('paused');
      }
      return;
    }

    const currentStillValid =
      this.currentTrack && playlist.some((t) => t.id === this.currentTrack?.id);

    if (!currentStillValid) {
      const nextTrack = playlist[Math.floor(Math.random() * playlist.length)];
      if (nextTrack) {
        this.loadAndPlayTrack(nextTrack);
      }
    } else {
      const audioEl = this.ensureAudioElement();
      if (!audioEl) return;
      this.host.ensureAudioGraph();
      if (!audioEl.src && this.currentTrack?.file) {
        this.loadAndPlayTrack(this.currentTrack);
        return;
      }
      if (audioEl.paused) {
        const bgmChain = this.host.getBgmChain();
        if (bgmChain) {
          const bgmVolScalar = this.host.getBgmVolScalar(store);
          bgmChain.applyBlend(this.blend, store.tunerConfig, this.fadeEnvelope * bgmVolScalar);
        }
        audioEl
          .play()
          .then(() => {
            useSpatialAudioStore.getState().setBgmPlaybackState({ isPlaying: true });
            this.updateMediaSessionPlaybackState('playing');
          })
          .catch(() => {});
      } else if (!store.bgmIsPlaying) {
        store.setBgmPlaybackState({ isPlaying: true });
        this.updateMediaSessionPlaybackState('playing');
      }
    }
  }

  loadAndPlayTrack(track: BgmTrackEntry | null | undefined): void {
    if (!track?.file) return;
    const audioEl = this.ensureAudioElement();
    if (!audioEl) return;

    this.host.ensureAudioGraph();

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    this.currentTrack = track;
    this.objectUrl = URL.createObjectURL(track.file);
    audioEl.src = this.objectUrl;

    const store = useSpatialAudioStore.getState();
    store.setBgmPlaybackState({
      currentTrackId: track.id,
      currentTrackTitle: track.title,
    });

    this.setupMediaSession(track);

    if (this.shouldBeAudible()) {
      const bgmChain = this.host.getBgmChain();
      if (bgmChain) {
        const bgmVolScalar = this.host.getBgmVolScalar(store);
        bgmChain.applyBlend(this.blend, store.tunerConfig, this.fadeEnvelope * bgmVolScalar);
      }
      audioEl
        .play()
        .then(() => {
          useSpatialAudioStore.getState().setBgmPlaybackState({ isPlaying: true });
          this.updateMediaSessionPlaybackState('playing');
        })
        .catch((err) => {
          console.warn('[BackgroundMusicController] BGM autoplay blocked until user gesture:', err);
        });
    }
  }

  playTrackById(trackId: string): void {
    this.userPaused = false;
    const store = useSpatialAudioStore.getState();
    const tracks = (store.bgmTracks || []) as BgmTrackEntry[];
    const found = tracks.find((t) => t.id === trackId);
    if (found) {
      this.loadAndPlayTrack(found);
    }
  }

  playNextTrack(direction = 1): void {
    const store = useSpatialAudioStore.getState();
    const playlist = getFilteredBgmTracks(store) as BgmTrackEntry[];
    if (playlist.length === 0) return;

    if (!this.currentTrack) {
      this.loadAndPlayTrack(playlist[0]);
      return;
    }

    const curIdx = playlist.findIndex((t) => t.id === this.currentTrack?.id);
    if (curIdx < 0) {
      this.loadAndPlayTrack(playlist[0]);
      return;
    }

    const nextIdx = (curIdx + direction + playlist.length) % playlist.length;
    this.loadAndPlayTrack(playlist[nextIdx]);
  }

  togglePlayPause(): void {
    const store = useSpatialAudioStore.getState();
    const audioEl = this.ensureAudioElement();
    if (!audioEl) return;
    if (!this.currentTrack) {
      this.userPaused = false;
      this.playNextTrack(1);
      return;
    }
    this.userPaused = !(this.userPaused || audioEl.paused || !store.bgmIsPlaying);
    this.syncPlaybackState();
  }

  computeTargetPhase(cfg: Partial<SpatialAudioTunerConfig>): number {
    if (cfg.overrideMode === 'normal') return 0.0;
    if (cfg.overrideMode === 'spatial') return 1.0;
    if (cfg.overrideMode === 'manual') {
      return Math.max(0, Math.min(1, Number(cfg.manualBlend) || 0));
    }

    const store = useSpatialAudioStore.getState();
    if (!store.realisticBgmEnabled) {
      return 0.0;
    }

    return Boolean(this.host.getRuntimeContext()?.isOpen) ? 0.0 : 1.0;
  }

  applyTunerConfig(cfg: Partial<SpatialAudioTunerConfig>, bgmVolScalar: number): void {
    this.blend = evaluateSpatialBezierBlend(this.linearPhase, cfg);
    this.host.getBgmChain()?.applyBlend(this.blend, cfg, this.fadeEnvelope * bgmVolScalar);
  }

  stepTransition(
    dt: number,
    maxDelta: number,
    cfg: Partial<SpatialAudioTunerConfig>,
    bgmVolScalar: number
  ): void {
    const store = useSpatialAudioStore.getState();
    const targetBgmU = this.computeTargetPhase(cfg);
    const next = stepSpatialBezierTransition(this.linearPhase, targetBgmU, maxDelta, cfg);
    this.linearPhase = next.linearPhase;
    this.blend = next.blend;

    const shouldBeAudible = this.shouldBeAudible();
    if (shouldBeAudible !== this.lastShouldBeAudible) {
      this.lastShouldBeAudible = shouldBeAudible;
      this.syncPlaybackState();
    }
    const targetFade = shouldBeAudible ? 1.0 : 0.0;
    const fadeDuration = Math.max(0.1, Math.min(3.0, Number(cfg.bgmFadeDurationSec) || 2.0));
    const maxFadeDelta = dt / fadeDuration;

    if (Math.abs(targetFade - this.fadeEnvelope) > 1e-4) {
      this.fadeEnvelope =
        targetFade > this.fadeEnvelope
          ? Math.min(targetFade, this.fadeEnvelope + maxFadeDelta)
          : Math.max(targetFade, this.fadeEnvelope - maxFadeDelta);
    } else {
      this.fadeEnvelope = targetFade;
    }

    if (!shouldBeAudible && this.fadeEnvelope <= 0.001) {
      this.fadeEnvelope = 0.0;
      if (this.audioEl && !this.audioEl.paused) {
        this.audioEl.pause();
      }
    }

    this.host.getBgmChain()?.applyBlend(this.blend, cfg, this.fadeEnvelope * bgmVolScalar);

    if (
      Math.abs(store.bgmLinearPhase - this.linearPhase) > 0.005 ||
      Math.abs(store.bgmBlend - this.blend) > 0.005
    ) {
      store.setBgmTransitionState(this.linearPhase, this.blend);
    }
  }
}
