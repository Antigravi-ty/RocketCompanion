/**
 * RLRCReplaySessionController.ts
 * Top-level runtime session controller for the Developer Sandbox Replay-to-RCS Importer
 * (`replay-to-rcs-importer`), driving .replay -> 120Hz RLRC conversion, 120Hz viewing/scrubbing,
 * POV camera switching (1..6), 4-mode non-POV intervention takeover (G), and binary pack export.
 */

import {
  hudStore,
  useQuickNotificationStore,
  useReplayToRcsImporterStore,
} from '../../../game/runtimeUiPort.ts';
import { ReplayHotkeySubController } from '../../ReplayHotkeySubController.ts';
import type { ReplayScoreboardModePort, ReplayScoreboardRuntimePort } from '../../ReplayScoreboardSynchronizer.ts';
import {
  buildRLRCSessionFromParserOutput,
  convertRLReplayBufferToRLRC,
  type RLRCConvertedReplaySession,
} from '../RLReplayToRLRCConverter.ts';
import {
  RLRC_FIXED_DT,
  type RLRCFrame120Hz,
} from '../RLRCReplayTypes.ts';
import { RLRCInterveneTakeoverSubController } from './RLRCInterveneTakeoverSubController.ts';
import {
  RLRCPlaybackSyncApplier,
  type RLRCPlaybackRuntimePort,
} from './RLRCPlaybackSyncApplier.ts';
import {
  createRLRCInterveneEnvPort,
  downloadRcsReplayPack,
  mapUiInterpolationMethod,
  mapUiNonPovMode,
  publishConvertedSessionTelemetry,
  readLiveRuntimePlayerControls,
  syncRLRCNameTagRoster,
} from './RLRCReplaySessionBridgePipeline.ts';

const IMPORTER_HOTKEY_CONFLICT_MSG =
  '[RLRCReplaySessionController] Cannot bind Replay Importer hotkeys (O/P/[/]/G): another replay window claimed hotkey priority first.';

export class RLRCReplaySessionController {
  public runtime: ReplayScoreboardRuntimePort | null;
  public mode: ReplayScoreboardModePort | null;
  public session: RLRCConvertedReplaySession | null = null;
  public cursorFrame120Hz = 0;
  public activePovSlotIndex = 0;
  public readonly playbackApplier = new RLRCPlaybackSyncApplier();
  public readonly interveneController: RLRCInterveneTakeoverSubController;
  public readonly hotkeySubController = new ReplayHotkeySubController();
  private _fractionalCursor = 0;
  private _unsubscribeStore: (() => void) | null = null;

  public constructor(
    runtime: ReplayScoreboardRuntimePort | null,
    mode: ReplayScoreboardModePort | null = null
  ) {
    this.runtime = runtime;
    this.mode = mode;
    this.interveneController = new RLRCInterveneTakeoverSubController(
      createRLRCInterveneEnvPort({
        getSession: () => this.session,
        getRuntime: () => this.runtime,
        getMode: () => this.mode,
      })
    );
  }

  public get hasLoadedReplay(): boolean {
    const st = useReplayToRcsImporterStore.getState();
    return st.viewerState !== 'idle' && Boolean(this.session && this.session.frames120Hz.length > 0);
  }

  public get isIntervening(): boolean {
    const st = useReplayToRcsImporterStore.getState();
    return st.viewerState === 'preroll-countdown' || st.viewerState === 'intervening';
  }

  public get isActive(): boolean {
    const st = useReplayToRcsImporterStore.getState();
    return Boolean(
      st.isWindowOpen && this.session && this.session.frames120Hz.length > 0 && st.viewerState !== 'idle'
    );
  }

  public attach(): void {
    useReplayToRcsImporterStore.getState().setRuntimeHandlers({
      onUploadRLReplayFile: (file: File) => this.handleUploadFile(file),
      onExportRcsReplayPack: () => this.exportRcsReplayPack(),
      onStartPlaying: () => this.startPlaying(),
      onPausePlaying: () => this.pausePlaying(),
      onSeekFrame: (frameIndex: number) => this.seekFrame(frameIndex),
      onPushBackwardStart: () => this.beginScrub('rewinding'),
      onPushBackwardStop: () => this.pauseScrub(),
      onPushForwardStart: () => this.beginScrub('forwarding'),
      onPushForwardStop: () => this.pauseScrub(),
      onResumeFromHere: () => this.resumeFromCursor(),
      onReturnToReplay: () => this.returnToReplay(),
      onSelectPovSlot: (slotKey: number | null) => this.selectPovSlot(slotKey ?? 1),
      onInterpolationMethodChange: (method) => this.handleInterpolationMethodChange(method),
      onNonPovInterventionModeChange: (mode) => this.handleNonPovModeChange(mode),
      onClearReplay: () => this.clearReplay(),
    });
    this._bindHotkeys();
    this._unsubscribeStore?.();
    this._unsubscribeStore = useReplayToRcsImporterStore.subscribe(() => {
      const st = useReplayToRcsImporterStore.getState();
      this.hotkeySubController.checkWindowOpenAndPriority(
        { isWindowOpen: Boolean(st.isWindowOpen), hasHotkeyPriority: Boolean(st.hasHotkeyPriority) },
        IMPORTER_HOTKEY_CONFLICT_MSG
      );
    });
  }

  public detach(): void {
    this._unsubscribeStore?.();
    this._unsubscribeStore = null;
    this.hotkeySubController.unbind();
  }

  public activateMode(): void {
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({
      isWindowOpen: true,
      hasHotkeyPriority: true,
    });
    if (this.session && this.session.frames120Hz.length > 0) {
      this.playbackApplier.configureRoster(
        this.session.roster,
        this.runtime as unknown as RLRCPlaybackRuntimePort
      );
      this._applyViewingFrame(this.cursorFrame120Hz, false);
    }
  }

  public deactivateMode(): void {
    if (this.isIntervening) this.interveneController.exitInterveneToViewing();
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({
      isWindowOpen: false,
      hasHotkeyPriority: false,
      viewerState: this.session ? 'paused' : 'idle',
    });
  }

  public async handleUploadFile(file: File): Promise<void> {
    const store = useReplayToRcsImporterStore.getState();
    store.updateLiveTelemetry({ isLoadingReplay: true, errorMessage: null });
    try {
      const buffer = await file.arrayBuffer();
      this.loadReplayBuffer(buffer, file.name);
      useQuickNotificationStore.getState().pushNotification({
        title: 'RL Replay Converted (120Hz)',
        message: `${file.name}: ${this.session?.frames120Hz.length ?? 0} frames, ${this.session?.roster.length ?? 0} players.`,
        variant: 'info',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useReplayToRcsImporterStore.getState().updateLiveTelemetry({
        isLoadingReplay: false,
        errorMessage: `Failed to parse .replay: ${msg}`,
      });
    }
  }

  public loadReplayBuffer(buffer: ArrayBuffer | Uint8Array, fileName = 'match.replay'): void {
    const store = useReplayToRcsImporterStore.getState();
    const method = mapUiInterpolationMethod(store.interpolationMethod);
    const converted = convertRLReplayBufferToRLRC(buffer, { interpolationMethod: method });
    this._installConvertedSession(converted, fileName, 0);
  }

  private _installConvertedSession(
    converted: RLRCConvertedReplaySession,
    fileName: string,
    initialCursorFrame: number
  ): void {
    this.session = converted;
    const totalFrames = Math.max(0, converted.frames120Hz.length - 1);
    const clampedCursor = Math.max(0, Math.min(totalFrames, initialCursorFrame));
    this.cursorFrame120Hz = clampedCursor;
    this._fractionalCursor = clampedCursor;
    this.activePovSlotIndex = converted.roster[0]?.slotIndex ?? 0;

    this.playbackApplier.configureRoster(
      converted.roster,
      this.runtime as unknown as RLRCPlaybackRuntimePort
    );
    syncRLRCNameTagRoster(converted.roster);
    this._applyViewingFrame(clampedCursor, false);
    publishConvertedSessionTelemetry(converted, fileName, clampedCursor, this.activePovSlotIndex);
  }

  public async exportRcsReplayPack(): Promise<void> {
    if (!this.session) return;
    const store = useReplayToRcsImporterStore.getState();
    store.updateLiveTelemetry({ isExportingRcsPack: true });
    try {
      await downloadRcsReplayPack(this.session, store.loadedFileName);
    } finally {
      useReplayToRcsImporterStore.getState().updateLiveTelemetry({ isExportingRcsPack: false });
    }
  }

  public startPlaying(): void {
    if (!this.session || this.session.frames120Hz.length === 0) return;
    if (this.isIntervening) this.returnToReplay();
    const maxFrame = Math.max(0, this.session.frames120Hz.length - 1);
    if (this.cursorFrame120Hz >= maxFrame) {
      this.cursorFrame120Hz = 0;
      this._fractionalCursor = 0;
    }
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ viewerState: 'playing' });
  }

  public pausePlaying(): void {
    if (!this.session || this.isIntervening) return;
    this.runtime?.audioSubsystem?.resetAudio?.();
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({ viewerState: 'paused' });
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
      this.playbackApplier.configureRoster(
        this.session.roster,
        this.runtime as unknown as RLRCPlaybackRuntimePort
      );
    }
    const maxFrame = Math.max(0, this.session.frames120Hz.length - 1);
    const clamped = Math.max(0, Math.min(maxFrame, Math.round(frameIndex120Hz)));
    this.cursorFrame120Hz = clamped;
    this._fractionalCursor = clamped;
    this._applyViewingFrame(clamped, false);
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({
      viewerState: 'paused',
      cursorFrame: clamped,
      targetFrame: clamped,
    });
  }

  public selectPovSlot(slotKey: number): void {
    if (!this.session) return;
    const desiredIdx = Math.max(0, Math.min(5, Math.round(slotKey) - 1));
    const meta = this.session.roster.find((r) => r.slotIndex === desiredIdx) ?? this.session.roster[0];
    if (!meta) return;
    this.activePovSlotIndex = meta.slotIndex;
    if (this.runtime) {
      this.runtime.playerCarIndex = meta.slotIndex;
      if (this.runtime.arena) this.runtime.arena.playerCarIndex = meta.slotIndex;
    }
    if (!this.isIntervening) this._applyViewingFrame(this.cursorFrame120Hz, false);
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({
      activePovCarIndex: meta.slotIndex,
      activePovSlotKey: meta.slotIndex + 1,
      activePovTeam: meta.team,
    });
  }

  public resumeFromCursor(): void {
    if (!this.session || this.session.frames120Hz.length === 0) return;
    const st = useReplayToRcsImporterStore.getState();
    const nonPovMode = mapUiNonPovMode(st.nonPovInterventionMode);
    if (this.isIntervening) {
      this.interveneController.reinterveneAtLastTargetFrame({
        povSlotIndex: this.activePovSlotIndex,
        nonPovMode,
        downCounterSeconds: st.downCounterSec,
      });
      return;
    }
    this.interveneController.enterInterveneAtFrame(this.cursorFrame120Hz, {
      povSlotIndex: this.activePovSlotIndex,
      nonPovMode,
      downCounterSeconds: st.downCounterSec,
    });
  }

  public returnToReplay(): void {
    if (!this.session) return;
    const t0Frame = this.interveneController.exitInterveneToViewing();
    this.playbackApplier.configureRoster(
      this.session.roster,
      this.runtime as unknown as RLRCPlaybackRuntimePort
    );
    this.seekFrame(t0Frame);
  }

  public handleInterpolationMethodChange(uiMethod: string): void {
    if (!this.session?.parserOutput) return;
    const method = mapUiInterpolationMethod(uiMethod);
    const updated = buildRLRCSessionFromParserOutput(this.session.parserOutput, {
      interpolationMethod: method,
    });
    const fileName = useReplayToRcsImporterStore.getState().loadedFileName || 'match.replay';
    this._installConvertedSession(updated, fileName, this.cursorFrame120Hz);
  }

  public handleNonPovModeChange(uiMode: string): void {
    this.interveneController.setNonPovMode(mapUiNonPovMode(uiMode));
  }

  public clearReplay(): void {
    if (this.isIntervening) this.interveneController.exitInterveneToViewing();
    this.session = null;
    this.cursorFrame120Hz = 0;
    this._fractionalCursor = 0;
    useReplayToRcsImporterStore.getState().updateLiveTelemetry({
      viewerState: 'idle',
      loadedFileName: null,
      totalFrames: 0,
      cursorFrame: 0,
      targetFrame: 0,
      incidentMarkers: [],
      signalMarkers: [],
      trackDeltaSummary: null,
      errorMessage: null,
    });
  }

  public onBeforePhysicsTick(): boolean {
    if (!this.isActive) return true;
    this.stepPlaybackTick(RLRC_FIXED_DT);
    return false;
  }

  public stepPlaybackTick(dt = RLRC_FIXED_DT): boolean {
    if (!this.session || this.session.frames120Hz.length === 0) return false;
    const st = useReplayToRcsImporterStore.getState();
    const state = st.viewerState;

    if (state === 'preroll-countdown' || state === 'intervening') {
      this.interveneController.stepTick(
        readLiveRuntimePlayerControls(this.runtime, this.activePovSlotIndex),
        dt
      );
      return true;
    }

    const maxFrame = Math.max(0, this.session.frames120Hz.length - 1);
    const speedScale = Math.max(0.01, (Number(st.effectiveFlowPct) || 100) / 100);

    if (state === 'playing' || state === 'forwarding' || state === 'rewinding') {
      const dir = state === 'rewinding' ? -1 : 1;
      const mult = state === 'playing' ? speedScale : Math.max(1.5, speedScale * 2);
      this._fractionalCursor = Math.max(0, Math.min(maxFrame, this._fractionalCursor + dir * mult));
      const nextFrame = Math.round(this._fractionalCursor);
      if (nextFrame !== this.cursorFrame120Hz) {
        this.cursorFrame120Hz = nextFrame;
        this._applyViewingFrame(nextFrame, true);
        st.updateLiveTelemetry({ cursorFrame: nextFrame });
      }
      if ((dir > 0 && nextFrame >= maxFrame) || (dir < 0 && nextFrame <= 0)) {
        this.pausePlaying();
      }
      return true;
    }

    this._applyViewingFrame(this.cursorFrame120Hz, false);
    return true;
  }

  private _applyViewingFrame(frameIndex120Hz: number, smoothStep: boolean): void {
    const frame: RLRCFrame120Hz | undefined = this.session?.frames120Hz[frameIndex120Hz];
    if (!frame) return;
    this.playbackApplier.applyFrame120Hz(frame, this.runtime as unknown as RLRCPlaybackRuntimePort, {
      smoothStep,
      activePovSlotIndex: this.activePovSlotIndex,
    });
    hudStore.getState().setMatchState({
      scoreBlue: frame.blueScore,
      scoreOrange: frame.orangeScore,
      timeRemaining: frame.secondsRemaining,
      isOvertime: frame.isOvertime,
    });
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
      conflictErrorMessage: IMPORTER_HOTKEY_CONFLICT_MSG,
      onSelectPovSlot: (slotKey: number) => this.selectPovSlot(slotKey),
      onStartPlaying: () => this.startPlaying(),
      onPausePlaying: () => this.pausePlaying(),
      onResumeFromCursor: () => this.resumeFromCursor(),
      onBeginScrub: (dir) => this.beginScrub(dir),
      onPauseScrub: () => this.pauseScrub(),
    });
  }
}
