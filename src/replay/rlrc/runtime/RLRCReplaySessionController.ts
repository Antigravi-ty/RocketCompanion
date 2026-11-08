import { hudStore, useQuickNotificationStore, useReplayToRcsImporterStore } from '../../../game/runtimeUiPort.ts';
import { ReplayHotkeySubController } from '../../ReplayHotkeySubController.ts';
import type { ReplayScoreboardModePort, ReplayScoreboardRuntimePort } from '../../ReplayScoreboardSynchronizer.ts';
import { buildRLRCSessionFromParserOutput, convertRLReplayBufferToRLRC, type RLRCConvertedReplaySession } from '../RLReplayToRLRCConverter.ts';
import { RLRC_FIXED_DT, type RLRCFrame120Hz, type RLRCSynthesizedCarControls } from '../RLRCReplayTypes.ts';
import { RLRCInterveneTakeoverSubController } from './RLRCInterveneTakeoverSubController.ts';
import { RLRCPlaybackEventAudioDispatcher } from './RLRCPlaybackEventAudioDispatcher.ts';
import { RLRCPlaybackSyncApplier, type RLRCPlaybackRuntimePort } from './RLRCPlaybackSyncApplier.ts';
import {
  createRLRCInterveneEnvPort, downloadRcsReplayPack, mapUiInterpolationMethod, mapUiNonPovMode,
  publishConvertedSessionTelemetry, readLiveRuntimePlayerControls, syncRLRCNameTagRoster,
} from './RLRCReplaySessionBridgePipeline.ts';

const HOTKEY_CONFLICT_MSG = '[RLRCReplaySessionController] Cannot bind Replay Importer hotkeys (O/P/[/]/G): another replay window claimed hotkey priority first.';

export class RLRCReplaySessionController {
  public runtime: ReplayScoreboardRuntimePort | null;
  public mode: ReplayScoreboardModePort | null;
  public session: RLRCConvertedReplaySession | null = null;
  public cursorFrame120Hz = 0;
  public activePovSlotIndex = 0;
  public readonly playbackApplier = new RLRCPlaybackSyncApplier();
  public readonly audioDispatcher = new RLRCPlaybackEventAudioDispatcher();
  public readonly interveneController: RLRCInterveneTakeoverSubController;
  public readonly hotkeySubController = new ReplayHotkeySubController();
  private _fractionalCursor = 0;
  private _uiSyncTick = 0;
  private _lastHudKey = '';
  private _unsubscribeStore: (() => void) | null = null;

  public constructor(runtime: ReplayScoreboardRuntimePort | null, mode: ReplayScoreboardModePort | null = null) {
    this.runtime = runtime; this.mode = mode;
    this.interveneController = new RLRCInterveneTakeoverSubController(
      createRLRCInterveneEnvPort({ getSession: () => this.session, getRuntime: () => this.runtime, getMode: () => this.mode })
    );
  }

  public get hasLoadedReplay(): boolean {
    return useReplayToRcsImporterStore.getState().viewerState !== 'idle' && Boolean(this.session && this.session.frames120Hz.length > 0);
  }
  public get isIntervening(): boolean {
    const st = useReplayToRcsImporterStore.getState().viewerState;
    return st === 'preroll-countdown' || st === 'intervening';
  }
  public get isActive(): boolean {
    const st = useReplayToRcsImporterStore.getState();
    return Boolean(st.isWindowOpen && this.session && this.session.frames120Hz.length > 0 && st.viewerState !== 'idle');
  }
  public getCarControls(slotIndex: number): RLRCSynthesizedCarControls { return this.playbackApplier.getCarControls(slotIndex); }

  public attach(): void {
    useReplayToRcsImporterStore.getState().setRuntimeHandlers({
      onUploadRLReplayFile: (file: File) => this.handleUploadFile(file),
      onExportRcsReplayPack: () => this.exportRcsReplayPack(),
      onStartPlaying: () => this.startPlaying(), onPausePlaying: () => this.pausePlaying(),
      onSeekFrame: (frameIndex: number) => this.seekFrame(frameIndex),
      onPushBackwardStart: () => this.beginScrub('rewinding'), onPushBackwardStop: () => this.pauseScrub(),
      onPushForwardStart: () => this.beginScrub('forwarding'), onPushForwardStop: () => this.pauseScrub(),
      onResumeFromHere: () => this.resumeFromCursor(), onReturnToReplay: () => this.returnToReplay(),
      onSelectPovSlot: (slotKey: number | null) => this.selectPovSlot(slotKey ?? 1),
      onInterpolationMethodChange: (method) => this.handleInterpolationMethodChange(method),
      onNonPovInterventionModeChange: (mode) => this.handleNonPovModeChange(mode),
      onClearReplay: () => this.clearReplay(),
    });
    this._bindHotkeys(); this._unsubscribeStore?.();
    this._unsubscribeStore = useReplayToRcsImporterStore.subscribe(() => {
      const st = useReplayToRcsImporterStore.getState();
      this.hotkeySubController.checkWindowOpenAndPriority({ isWindowOpen: Boolean(st.isWindowOpen), hasHotkeyPriority: Boolean(st.hasHotkeyPriority) }, HOTKEY_CONFLICT_MSG);
    });
  }

  public detach(): void { this._unsubscribeStore?.(); this._unsubscribeStore = null; this.hotkeySubController.unbind(); }

  public activateMode(): void {
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ isWindowOpen: true, hasHotkeyPriority: true });
    if (this.session && this.session.frames120Hz.length > 0) {
      this.playbackApplier.configureRoster(this.session.roster, this.runtime as unknown as RLRCPlaybackRuntimePort);
      syncRLRCNameTagRoster(this.session.roster, this.activePovSlotIndex);
      this._lastHudKey = '';
      this._applyViewingFrame(this.cursorFrame120Hz, false);
    }
  }

  public deactivateMode(): void {
    if (this.isIntervening) this.interveneController.exitInterveneToViewing();
    this.audioDispatcher.reset();
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ isWindowOpen: false, hasHotkeyPriority: false, viewerState: this.session ? 'paused' : 'idle' });
  }

  public async handleUploadFile(file: File): Promise<void> {
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ isLoadingReplay: true, errorMessage: null });
    try {
      this.loadReplayBuffer(await file.arrayBuffer(), file.name);
      try {
        useQuickNotificationStore.getState().pushNotification({
          id: 'rlrc-replay-loaded', type: 'temporary', tone: 'info', duration: 3200,
          content: `RL Replay Converted (120Hz): ${file.name} (${this.session?.frames120Hz.length ?? 0} frames, ${this.session?.roster.length ?? 0} players)`,
        });
      } catch { /* ignore */ }
    } catch (err) {
      useReplayToRcsImporterStore.getState().updateLiveTelemetry({
        isLoadingReplay: false, errorMessage: `Failed to parse .replay: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  public loadReplayBuffer(buffer: ArrayBuffer | Uint8Array, fileName = 'match.replay'): void {
    const method = mapUiInterpolationMethod(useReplayToRcsImporterStore.getState().interpolationMethod);
    this._installConvertedSession(convertRLReplayBufferToRLRC(buffer, { interpolationMethod: method }), fileName, 0);
  }

  private _installConvertedSession(converted: RLRCConvertedReplaySession, fileName: string, initialCursorFrame: number): void {
    this.session = converted;
    const clampedCursor = Math.max(0, Math.min(Math.max(0, converted.frames120Hz.length - 1), initialCursorFrame));
    this.cursorFrame120Hz = this._fractionalCursor = clampedCursor;
    this.activePovSlotIndex = converted.roster[0]?.slotIndex ?? 0;
    this.audioDispatcher.reset(); this._lastHudKey = '';
    this.playbackApplier.configureRoster(converted.roster, this.runtime as unknown as RLRCPlaybackRuntimePort);
    syncRLRCNameTagRoster(converted.roster, this.activePovSlotIndex);
    this._applyViewingFrame(clampedCursor, false);
    (this.runtime?.camera as { resetView?: () => void } | null)?.resetView?.();
    publishConvertedSessionTelemetry(converted, fileName, clampedCursor, this.activePovSlotIndex);
  }

  public async exportRcsReplayPack(): Promise<void> {
    if (!this.session) return;
    const store = useReplayToRcsImporterStore.getState();
    store.updateLiveTelemetry({ isExportingRcsPack: true });
    try { await downloadRcsReplayPack(this.session, store.loadedFileName); }
    finally { useReplayToRcsImporterStore.getState().updateLiveTelemetry({ isExportingRcsPack: false }); }
  }

  public startPlaying(): void {
    if (!this.session || this.session.frames120Hz.length === 0) return;
    if (this.isIntervening) this.returnToReplay();
    if (this.cursorFrame120Hz >= Math.max(0, this.session.frames120Hz.length - 1)) {
      this.cursorFrame120Hz = this._fractionalCursor = 0; this.audioDispatcher.reset();
    }
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ viewerState: 'playing' });
  }

  public pausePlaying(): void {
    if (!this.session || this.isIntervening) return;
    this.audioDispatcher.reset();
    this.runtime?.audioSubsystem?.resetAudio?.();
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ viewerState: 'paused', cursorFrame: this.cursorFrame120Hz, targetFrame: this.cursorFrame120Hz });
  }

  public beginScrub(direction: 'rewinding' | 'forwarding'): void {
    if (!this.session || this.isIntervening) return;
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ viewerState: direction });
  }

  public pauseScrub(): void {
    const st = useReplayToRcsImporterStore.getState().viewerState;
    if (st === 'rewinding' || st === 'forwarding') this.pausePlaying();
  }

  public seekFrame(frameIndex120Hz: number): void {
    if (!this.session || this.session.frames120Hz.length === 0) return;
    if (this.isIntervening) {
      this.interveneController.exitInterveneToViewing();
      this.playbackApplier.configureRoster(this.session.roster, this.runtime as unknown as RLRCPlaybackRuntimePort);
    }
    const clamped = Math.max(0, Math.min(Math.max(0, this.session.frames120Hz.length - 1), Math.round(frameIndex120Hz)));
    this.cursorFrame120Hz = this._fractionalCursor = clamped;
    this.audioDispatcher.reset(); this._lastHudKey = '';
    this._applyViewingFrame(clamped, false);
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ viewerState: 'paused', cursorFrame: clamped, targetFrame: clamped });
  }

  public selectPovSlot(slotKey: number): void {
    if (!this.session) return;
    const meta = this.session.roster.find((r) => r.slotIndex === Math.max(0, Math.min(5, Math.round(slotKey) - 1))) ?? this.session.roster[0];
    if (!meta) return;
    this.activePovSlotIndex = meta.slotIndex;
    if (this.runtime) {
      this.runtime.playerCarIndex = meta.slotIndex;
      if (this.runtime.arena) this.runtime.arena.playerCarIndex = meta.slotIndex;
    }
    syncRLRCNameTagRoster(this.session.roster, meta.slotIndex);
    this._lastHudKey = '';
    if (!this.isIntervening) this._applyViewingFrame(this.cursorFrame120Hz, false);
    else hudStore.getState().setMatchState({ localTeam: meta.team });
    (this.runtime?.camera as { resetView?: () => void } | null)?.resetView?.();
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ activePovCarIndex: meta.slotIndex, activePovSlotKey: meta.slotIndex + 1, activePovTeam: meta.team });
  }

  public resumeFromCursor(): void {
    if (!this.session || this.session.frames120Hz.length === 0) return;
    const st = useReplayToRcsImporterStore.getState(), nonPovMode = mapUiNonPovMode(st.nonPovInterventionMode);
    this.audioDispatcher.reset();
    if (this.isIntervening) this.interveneController.reinterveneAtLastTargetFrame({ povSlotIndex: this.activePovSlotIndex, nonPovMode, downCounterSeconds: st.downCounterSec });
    else this.interveneController.enterInterveneAtFrame(this.cursorFrame120Hz, { povSlotIndex: this.activePovSlotIndex, nonPovMode, downCounterSeconds: st.downCounterSec });
  }

  public returnToReplay(): void {
    if (!this.session) return;
    const t0Frame = this.interveneController.exitInterveneToViewing();
    this.playbackApplier.configureRoster(this.session.roster, this.runtime as unknown as RLRCPlaybackRuntimePort);
    this.seekFrame(t0Frame);
  }

  public handleInterpolationMethodChange(uiMethod: string): void {
    if (!this.session?.parserOutput) return;
    const updated = buildRLRCSessionFromParserOutput(this.session.parserOutput, { interpolationMethod: mapUiInterpolationMethod(uiMethod) });
    this._installConvertedSession(updated, useReplayToRcsImporterStore.getState().loadedFileName || 'match.replay', this.cursorFrame120Hz);
  }

  public handleNonPovModeChange(uiMode: string): void { this.interveneController.setNonPovMode(mapUiNonPovMode(uiMode)); }

  public clearReplay(): void {
    if (this.isIntervening) this.interveneController.exitInterveneToViewing();
    this.audioDispatcher.reset();
    this.session = null; this.cursorFrame120Hz = this._fractionalCursor = 0; this._lastHudKey = '';
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({
      viewerState: 'idle', loadedFileName: null, totalFrames: 0, cursorFrame: 0, targetFrame: 0,
      incidentMarkers: [], signalMarkers: [], trackDeltaSummary: null, errorMessage: null,
    });
  }

  public onBeforePhysicsTick(): boolean {
    if (!this.isActive) return true;
    this.stepPlaybackTick(RLRC_FIXED_DT);
    return false;
  }

  public stepPlaybackTick(dt = RLRC_FIXED_DT): boolean {
    if (!this.session || this.session.frames120Hz.length === 0) return false;
    const st = useReplayToRcsImporterStore.getState(), state = st.viewerState;
    if (state === 'preroll-countdown' || state === 'intervening') {
      this.interveneController.stepTick(readLiveRuntimePlayerControls(this.runtime, this.activePovSlotIndex), dt);
      return true;
    }
    const maxFrame = Math.max(0, this.session.frames120Hz.length - 1), speed = Math.max(0.01, (Number(st.effectiveFlowPct) || 100) / 100);
    if (state === 'playing' || state === 'forwarding' || state === 'rewinding') {
      const dir = state === 'rewinding' ? -1 : 1, mult = state === 'playing' ? speed : Math.max(1.5, speed * 2);
      this._fractionalCursor = Math.max(0, Math.min(maxFrame, this._fractionalCursor + dir * mult));
      const next = Math.round(this._fractionalCursor);
      if (next !== this.cursorFrame120Hz) {
        this.cursorFrame120Hz = next; this._applyViewingFrame(next, true);
        if (((this._uiSyncTick = (this._uiSyncTick + 1) & 3) === 0) || next >= maxFrame || next <= 0) {
          st.updateLiveTelemetry({ cursorFrame: next, targetFrame: next });
        }
      }
      if ((dir > 0 && next >= maxFrame) || (dir < 0 && next <= 0)) this.pausePlaying();
      return true;
    }
    return false;
  }

  private _applyViewingFrame(frameIndex120Hz: number, smoothStep: boolean): void {
    const frame: RLRCFrame120Hz | undefined = this.session?.frames120Hz[frameIndex120Hz];
    if (!frame) return;
    this.playbackApplier.applyFrame120Hz(frame, this.runtime as unknown as RLRCPlaybackRuntimePort, { smoothStep, activePovSlotIndex: this.activePovSlotIndex });
    const camTransform = (this.runtime?.camera as { camera?: unknown } | null)?.camera ?? this.runtime?.camera;
    this.audioDispatcher.stepFrame(frame, camTransform as Parameters<RLRCPlaybackEventAudioDispatcher['stepFrame']>[1], smoothStep);
    const localTeam = this.session?.roster.find((r) => r.slotIndex === this.activePovSlotIndex)?.team ?? 0;
    const remainingSeconds = Math.max(0, Math.round(frame.secondsRemaining)), kickoffCountdown = Math.max(0, Math.min(3, frame.roundCountdownNumber || 0));
    const matchPhase = kickoffCountdown > 0 ? 'kickoff' : 'playing';
    const hudKey = `${localTeam}:${frame.blueScore}:${frame.orangeScore}:${remainingSeconds}:${frame.isOvertime ? 1 : 0}:${kickoffCountdown}:${matchPhase}`;
    if (hudKey !== this._lastHudKey) {
      this._lastHudKey = hudKey;
      hudStore.getState().setMatchState({ localTeam, blueScore: frame.blueScore, orangeScore: frame.orangeScore, remainingSeconds, isOvertime: frame.isOvertime, kickoffCountdown, matchPhase });
    }
  }

  private _bindHotkeys(): void {
    this.hotkeySubController.bindReplayViewerHotkeys({
      getRuntime: () => this.runtime as Record<string, unknown> | null,
      hasLoadedReplay: () => this.hasLoadedReplay,
      hasFrames: () => Boolean(this.session && this.session.frames120Hz.length > 0),
      getWindowStatus: () => {
        const st = useReplayToRcsImporterStore.getState();
        return { isWindowOpen: Boolean(st.isWindowOpen), hasHotkeyPriority: Boolean(st.hasHotkeyPriority) };
      },
      conflictErrorMessage: HOTKEY_CONFLICT_MSG,
      onSelectPovSlot: (slotKey: number) => this.selectPovSlot(slotKey),
      onStartPlaying: () => this.startPlaying(), onPausePlaying: () => this.pausePlaying(),
      onResumeFromCursor: () => this.resumeFromCursor(), onBeginScrub: (dir) => this.beginScrub(dir), onPauseScrub: () => this.pauseScrub(),
    });
  }
}
