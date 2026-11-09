import { useReplayToRcsImporterStore } from '../../../game/runtimeUiPort.ts';
import { ReplayHotkeySubController } from '../../ReplayHotkeySubController.ts';
import type {
  ReplayScoreboardModePort,
  ReplayScoreboardRuntimePort,
} from '../../ReplayScoreboardSynchronizer.ts';
import {
  buildRLRCSessionFromParserOutput,
  convertRLReplayBufferToRLRC,
  type RLRCConvertedReplaySession,
} from '../RLReplayToRLRCConverter.ts';
import { RLRC_FIXED_DT, type RLRCPlayerSlotMeta } from '../RLRCReplayTypes.ts';
import { RLRCInterveneTakeoverSubController } from './RLRCInterveneTakeoverSubController.ts';
import {
  RLRCPlaybackAudioEdgeSynthesizer,
  type RLRCPlaybackAudioRuntimePort,
} from './RLRCPlaybackAudioEdgeSynthesizer.ts';
import {
  RLRCPlaybackSyncApplier,
  type RLRCPlaybackRuntimePort,
} from './RLRCPlaybackSyncApplier.ts';
import {
  createRLRCInterveneEnvPort,
  mapUiInterpolationMethod,
  mapUiNonPovMode,
  publishConvertedSessionTelemetry,
  readLiveRuntimePlayerControls,
  syncRLRCNameTagRoster,
} from './RLRCReplaySessionBridgePipeline.ts';
import {
  applyRLRCFrameToSubsystems,
  bindRLRCSessionUiAndHotkeys,
  executeRLRCExportPack,
  executeRLRCFileUpload,
  resetClearedReplayTelemetry,
  resolveSelectedPovSlotState,
  stepRLRCPlaybackCursor,
  triggerRLRCInterveneFromCursor,
} from './RLRCReplayUiAndHudBinder.ts';

const getSt = () => useReplayToRcsImporterStore.getState();
const setTelem: ReturnType<typeof getSt>['updateLiveTelemetry'] = (p) =>
  getSt().updateLiveTelemetry(p);

export class RLRCReplaySessionController {
  private _simPort: ReplayScoreboardRuntimePort | null;
  private _modePort: ReplayScoreboardModePort | null;
  public session: RLRCConvertedReplaySession | null = null;
  public readonly playbackApplier = new RLRCPlaybackSyncApplier();
  public readonly audioEdgeSynthesizer = new RLRCPlaybackAudioEdgeSynthesizer();
  public readonly interveneController: RLRCInterveneTakeoverSubController;
  public readonly hotkeySubController = new ReplayHotkeySubController();
  public cursorFrame120Hz = 0;
  public activePovSlotIndex = 0;
  private _frac = 0;
  private _tick = 0;
  private _hudKey = '';
  private _unsub: (() => void) | null = null;

  public constructor(
    simPort: ReplayScoreboardRuntimePort | null,
    modePort: ReplayScoreboardModePort | null = null
  ) {
    this._simPort = simPort;
    this._modePort = modePort;
    this.interveneController = new RLRCInterveneTakeoverSubController(
      createRLRCInterveneEnvPort({
        getSession: () => this.session,
        getSimPort: () => this._simPort,
        getModePort: () => this._modePort,
      })
    );
  }

  public get runtime(): ReplayScoreboardRuntimePort | null {
    return this._simPort;
  }

  public set runtime(nextPort: ReplayScoreboardRuntimePort | null) {
    this._simPort = nextPort;
  }

  public get mode(): ReplayScoreboardModePort | null {
    return this._modePort;
  }

  public set mode(nextMode: ReplayScoreboardModePort | null) {
    this._modePort = nextMode;
  }

  public get hasLoadedReplay(): boolean {
    return (
      getSt().viewerState !== 'idle' && Boolean(this.session && this.session.frames120Hz.length > 0)
    );
  }

  public get isIntervening(): boolean {
    const v = getSt().viewerState;
    return v === 'intervening' || v === 'preroll-countdown';
  }

  public get isActive(): boolean {
    const state = getSt().viewerState;
    return (
      state !== 'idle' &&
      state !== 'intervening' &&
      Boolean(this.session && this.session.frames120Hz.length > 0)
    );
  }

  public attach(): void {
    this._unsub?.();
    this._unsub = bindRLRCSessionUiAndHotkeys(this.hotkeySubController, this);
  }

  public detach(): void {
    this._unsub?.();
    this._unsub = null;
    this.hotkeySubController.unbind();
  }

  public activateMode(): void {
    setTelem({ isWindowOpen: true, hasHotkeyPriority: true });
    if (this.session && this.session.frames120Hz.length > 0) {
      this._hudKey = '';
      this.audioEdgeSynthesizer.reset();
      this._syncRoster(this.session.roster);
      this._applyFrame(this.cursorFrame120Hz, false);
      this._simPort?.camera?.resetView?.();
    }
  }

  public deactivateMode(): void {
    if (this.isIntervening) this.interveneController.exitInterveneToViewing();
    this.audioEdgeSynthesizer.reset();
    setTelem({
      isWindowOpen: false,
      hasHotkeyPriority: false,
      viewerState: this.session ? 'paused' : 'idle',
    });
  }

  public async handleUploadFile(file: File): Promise<void> {
    await executeRLRCFileUpload(
      file,
      (buf, name) => this.loadReplayBuffer(buf, name),
      () => this.session
    );
  }

  public loadReplayBuffer(buffer: ArrayBuffer | Uint8Array, fileName = 'match.replay'): void {
    const interpolationMethod = mapUiInterpolationMethod(getSt().interpolationMethod);
    this._installSession(convertRLReplayBufferToRLRC(buffer, { interpolationMethod }), fileName, 0);
  }

  private _installSession(
    c: RLRCConvertedReplaySession,
    fileName: string,
    initialCursor: number
  ): void {
    this.session = c;
    const clamped = Math.max(0, Math.min(Math.max(0, c.frames120Hz.length - 1), initialCursor));
    this.cursorFrame120Hz = clamped;
    this._frac = clamped;
    this._tick = 0;
    this._hudKey = '';
    this.activePovSlotIndex = c.roster[0]?.slotIndex ?? 0;
    this._syncPov(this.activePovSlotIndex);
    this.audioEdgeSynthesizer.configureSession(
      c,
      this._simPort as unknown as RLRCPlaybackAudioRuntimePort
    );
    this._syncRoster(c.roster);
    this._applyFrame(clamped, false);
    this._simPort?.camera?.resetView?.();
    publishConvertedSessionTelemetry(c, fileName, clamped, this.activePovSlotIndex);
  }

  public async exportRcsReplayPack(): Promise<void> {
    await executeRLRCExportPack(this.session);
  }

  public startPlaying(): void {
    const s = this.session;
    if (!s || s.frames120Hz.length === 0) return;
    if (this.isIntervening) this.returnToReplay();
    if (this.cursorFrame120Hz >= s.frames120Hz.length - 1) {
      this.cursorFrame120Hz = 0;
      this._frac = 0;
      this.audioEdgeSynthesizer.reset();
    }
    this._tick = 0;
    setTelem({ viewerState: 'playing', cursorFrame: this.cursorFrame120Hz });
  }

  public pausePlaying(): void {
    if (!this.session || this.isIntervening) return;
    this._simPort?.audioSubsystem?.resetAudio?.();
    this.audioEdgeSynthesizer.reset();
    setTelem({
      viewerState: 'paused',
      cursorFrame: this.cursorFrame120Hz,
      targetFrame: this.cursorFrame120Hz,
    });
  }

  public beginScrub(direction: 'rewinding' | 'forwarding'): void {
    if (!this.session || this.isIntervening) return;
    this._tick = 0;
    setTelem({ viewerState: direction });
  }

  public pauseScrub(): void {
    const v = getSt().viewerState;
    if (v === 'rewinding' || v === 'forwarding') this.pausePlaying();
  }

  public seekFrame(frameIndex120Hz: number): void {
    const s = this.session;
    if (!s || s.frames120Hz.length === 0) return;
    if (this.isIntervening) {
      this.interveneController.exitInterveneToViewing();
      this._syncRoster(s.roster);
    }
    const clamped = Math.max(0, Math.min(s.frames120Hz.length - 1, Math.round(frameIndex120Hz)));
    this.cursorFrame120Hz = clamped;
    this._frac = clamped;
    this.audioEdgeSynthesizer.reset();
    this._hudKey = '';
    this._applyFrame(clamped, false);
    setTelem({ viewerState: 'paused', cursorFrame: clamped, targetFrame: clamped });
  }

  public selectPovSlot(slotKey: number): void {
    const s = this.session;
    if (!s) return;
    const resolved = resolveSelectedPovSlotState(
      this.playbackApplier,
      s.roster,
      this._simPort as unknown as RLRCPlaybackRuntimePort,
      slotKey
    );
    if (!resolved) return;
    this.activePovSlotIndex = resolved.slot;
    this._syncPov(resolved.slot);
    this._hudKey = '';
    if (!this.isIntervening) this._applyFrame(this.cursorFrame120Hz, false);
    this._simPort?.camera?.resetView?.();
  }

  public resumeFromCursor(): void {
    triggerRLRCInterveneFromCursor(
      this.session,
      this.cursorFrame120Hz,
      this.activePovSlotIndex,
      this.isIntervening,
      this.audioEdgeSynthesizer,
      this.interveneController
    );
  }

  public returnToReplay(): void {
    if (!this.session) return;
    const t0Frame = this.interveneController.exitInterveneToViewing();
    this._syncRoster(this.session.roster);
    this.seekFrame(t0Frame);
    this._simPort?.camera?.resetView?.();
  }

  public handleInterpolationMethodChange(uiMethod: string): void {
    if (!this.session?.parserOutput) return;
    const updated = buildRLRCSessionFromParserOutput(this.session.parserOutput, {
      interpolationMethod: mapUiInterpolationMethod(uiMethod),
    });
    this._installSession(updated, getSt().loadedFileName || 'match.replay', this.cursorFrame120Hz);
  }

  public handleNonPovModeChange(uiMode: string): void {
    this.interveneController.setNonPovMode(mapUiNonPovMode(uiMode));
  }

  public clearReplay(): void {
    if (this.isIntervening) this.interveneController.exitInterveneToViewing();
    this._simPort?.audioSubsystem?.resetAudio?.();
    this.audioEdgeSynthesizer.reset();
    this.session = null;
    this.cursorFrame120Hz = 0;
    this._frac = 0;
    this._tick = 0;
    this._hudKey = '';
    resetClearedReplayTelemetry();
  }

  public getViewerState(): string {
    return getSt().viewerState;
  }

  public getPhase(): string {
    return this.isActive && getSt().viewerState === 'paused'
      ? 'paused-viewer'
      : getSt().viewerState;
  }

  public onBeforePhysicsTick(dt = RLRC_FIXED_DT): boolean {
    if (!this.hasLoadedReplay) return true;
    if (getSt().viewerState === 'intervening') {
      if (this._simPort?.keyboard) this._simPort.keyboard.ballControlEnabled = false;
      this.interveneController.stepBeforeLivePhysics(
        readLiveRuntimePlayerControls(this._simPort, this.activePovSlotIndex),
        dt
      );
      return true;
    }
    if (!this.isActive) return true;
    this.stepPlaybackTick(dt);
    return false;
  }

  public stepPlaybackTick(dt = RLRC_FIXED_DT): boolean {
    const frames = this.session?.frames120Hz;
    if (!frames || frames.length === 0) return false;
    const st = getSt();
    const state = st.viewerState;
    if (state === 'preroll-countdown' || state === 'intervening') {
      this.interveneController.stepTick(
        readLiveRuntimePlayerControls(this._simPort, this.activePovSlotIndex),
        dt
      );
      return true;
    }
    const res = stepRLRCPlaybackCursor({
      state,
      effectiveFlowPct: st.effectiveFlowPct,
      maxF: frames.length - 1,
      prevFrac: this._frac,
      prevCursor: this.cursorFrame120Hz,
      prevTick: this._tick,
      applyFrame: (idx, sm) => this._applyFrame(idx, sm),
      pausePlaying: () => this.pausePlaying(),
    });
    this._frac = res.frac;
    this.cursorFrame120Hz = res.cursorFrame120Hz;
    this._tick = res.tick;
    return res.stepped;
  }

  private _syncPov(slot: number): void {
    if (!this._simPort) return;
    this._simPort.playerCarIndex = slot;
    if (this._simPort.arena) this._simPort.arena.playerCarIndex = slot;
  }

  private _syncRoster(roster: readonly RLRCPlayerSlotMeta[]): void {
    this.playbackApplier.configureRoster(
      roster,
      this._simPort as unknown as RLRCPlaybackRuntimePort
    );
    syncRLRCNameTagRoster(roster, this.activePovSlotIndex);
  }

  private _applyFrame(idx: number, smoothStep: boolean): void {
    this._hudKey = applyRLRCFrameToSubsystems({
      session: this.session,
      idx,
      smoothStep,
      activePovSlotIndex: this.activePovSlotIndex,
      simPort: this._simPort,
      playbackApplier: this.playbackApplier,
      audioEdgeSynthesizer: this.audioEdgeSynthesizer,
      prevHudKey: this._hudKey,
    });
  }
}
