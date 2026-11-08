import { hudStore, useQuickNotificationStore, useReplayToRcsImporterStore } from '../../../game/runtimeUiPort.ts';
import { ReplayHotkeySubController } from '../../ReplayHotkeySubController.ts';
import type { ReplayScoreboardModePort, ReplayScoreboardRuntimePort } from '../../ReplayScoreboardSynchronizer.ts';
import { buildRLRCSessionFromParserOutput, convertRLReplayBufferToRLRC, type RLRCConvertedReplaySession } from '../RLReplayToRLRCConverter.ts';
import { RLRC_FIXED_DT, type RLRCFrame120Hz, type RLRCPlayerSlotMeta, type RLRCTeamIndex } from '../RLRCReplayTypes.ts';
import { RLRCInterveneTakeoverSubController } from './RLRCInterveneTakeoverSubController.ts';
import { RLRCPlaybackSyncApplier, type RLRCPlaybackRuntimePort } from './RLRCPlaybackSyncApplier.ts';
import {
  createRLRCInterveneEnvPort, downloadRcsReplayPack, mapUiInterpolationMethod, mapUiNonPovMode,
  publishConvertedSessionTelemetry, readLiveRuntimePlayerControls, syncRLRCNameTagRoster,
} from './RLRCReplaySessionBridgePipeline.ts';

const CONFLICT_MSG = '[RLRCReplaySessionController] Replay Importer hotkeys (O/P/[/]/G) claimed by another window.';
const _synthGlob = import.meta.glob<Record<string, unknown>>('./RLRCPlaybackAudioEdgeSynthesizer.ts', { eager: true });
type SyncNameTagFn = (r: readonly RLRCPlayerSlotMeta[], pov?: number) => void;
const getSt = () => useReplayToRcsImporterStore.getState();
const setTelem: ReturnType<typeof getSt>['updateLiveTelemetry'] = (p) => getSt().updateLiveTelemetry(p);

function createAudioSynth(): Record<string, unknown> | null {
  const m = _synthGlob['./RLRCPlaybackAudioEdgeSynthesizer.ts'];
  const C = (m?.RLRCPlaybackAudioEdgeSynthesizer ?? m?.default) as (new () => Record<string, unknown>) | undefined;
  if (typeof C === 'function') { try { return new C(); } catch { return null; } }
  return m ?? null;
}

export class RLRCReplaySessionController {
  public runtime: ReplayScoreboardRuntimePort | null;
  public mode: ReplayScoreboardModePort | null;
  public session: RLRCConvertedReplaySession | null = null;
  public cursorFrame120Hz = 0;
  public activePovSlotIndex = 0;
  public readonly playbackApplier = new RLRCPlaybackSyncApplier();
  public readonly interveneController: RLRCInterveneTakeoverSubController;
  public readonly hotkeySubController = new ReplayHotkeySubController();
  public readonly audioEdgeSynthesizer: Record<string, unknown> | null = createAudioSynth();
  private _frac = 0;
  private _tick = 0;
  private _hudKey = '';
  private _unsub: (() => void) | null = null;

  public constructor(runtime: ReplayScoreboardRuntimePort | null, mode: ReplayScoreboardModePort | null = null) {
    this.runtime = runtime;
    this.mode = mode;
    this.interveneController = new RLRCInterveneTakeoverSubController(
      createRLRCInterveneEnvPort({ getSession: () => this.session, getRuntime: () => this.runtime, getMode: () => this.mode })
    );
  }

  public get hasLoadedReplay(): boolean {
    return getSt().viewerState !== 'idle' && Boolean(this.session && this.session.frames120Hz.length > 0);
  }

  public get isIntervening(): boolean {
    const v = getSt().viewerState;
    return v === 'preroll-countdown' || v === 'intervening';
  }

  public get isActive(): boolean {
    const st = getSt();
    return Boolean(st.isWindowOpen && this.session && this.session.frames120Hz.length > 0 && st.viewerState !== 'idle');
  }

  public attach(): void {
    getSt().setRuntimeHandlers({
      onUploadRLReplayFile: (f: File) => this.handleUploadFile(f), onExportRcsReplayPack: () => this.exportRcsReplayPack(),
      onStartPlaying: () => this.startPlaying(), onPausePlaying: () => this.pausePlaying(),
      onSeekFrame: (f: number) => this.seekFrame(f), onSelectPovSlot: (k: number | null) => this.selectPovSlot(k ?? 1),
      onPushBackwardStart: () => this.beginScrub('rewinding'), onPushBackwardStop: () => this.pauseScrub(),
      onPushForwardStart: () => this.beginScrub('forwarding'), onPushForwardStop: () => this.pauseScrub(),
      onResumeFromHere: () => this.resumeFromCursor(), onReturnToReplay: () => this.returnToReplay(),
      onInterpolationMethodChange: (m) => this.handleInterpolationMethodChange(m),
      onNonPovInterventionModeChange: (m) => this.handleNonPovModeChange(m), onClearReplay: () => this.clearReplay(),
    });
    const winStat = () => ({ isWindowOpen: Boolean(getSt().isWindowOpen), hasHotkeyPriority: Boolean(getSt().hasHotkeyPriority) });
    this.hotkeySubController.bindReplayViewerHotkeys({
      getRuntime: () => this.runtime as Record<string, unknown> | null,
      hasLoadedReplay: () => this.hasLoadedReplay, hasFrames: () => Boolean(this.session && this.session.frames120Hz.length > 0),
      getWindowStatus: winStat, conflictErrorMessage: CONFLICT_MSG,
      onSelectPovSlot: (k: number) => this.selectPovSlot(k), onStartPlaying: () => this.startPlaying(),
      onPausePlaying: () => this.pausePlaying(), onResumeFromCursor: () => this.resumeFromCursor(),
      onBeginScrub: (dir) => this.beginScrub(dir), onPauseScrub: () => this.pauseScrub(),
    });
    this._unsub?.();
    this._unsub = useReplayToRcsImporterStore.subscribe(() => {
      this.hotkeySubController.checkWindowOpenAndPriority(winStat(), CONFLICT_MSG);
    });
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
      this._resetAudio();
      this._syncRoster(this.session.roster);
      this._applyFrame(this.cursorFrame120Hz, false, null);
      this.runtime?.camera?.resetView?.();
    }
  }

  public deactivateMode(): void {
    if (this.isIntervening) this.interveneController.exitInterveneToViewing();
    this._resetAudio();
    setTelem({ isWindowOpen: false, hasHotkeyPriority: false, viewerState: this.session ? 'paused' : 'idle' });
  }

  public async handleUploadFile(file: File): Promise<void> {
    setTelem({ isLoadingReplay: true, errorMessage: null });
    const notify = useQuickNotificationStore.getState().pushNotification;
    try {
      this.loadReplayBuffer(await file.arrayBuffer(), file.name);
      notify({
        content: `RL Replay Converted (120Hz): ${file.name} (${this.session?.frames120Hz.length ?? 0} frames, ${this.session?.roster.length ?? 0} players).`,
        type: 'temporary', duration: 2800, tone: 'info',
      });
    } catch (err) {
      const errorMessage = `Failed to parse .replay: ${err instanceof Error ? err.message : String(err)}`;
      setTelem({ isLoadingReplay: false, errorMessage });
      notify({ content: errorMessage, type: 'temporary', duration: 3600, tone: 'error' });
    }
  }

  public loadReplayBuffer(buffer: ArrayBuffer | Uint8Array, fileName = 'match.replay'): void {
    const interpolationMethod = mapUiInterpolationMethod(getSt().interpolationMethod);
    this._installSession(convertRLReplayBufferToRLRC(buffer, { interpolationMethod }), fileName, 0);
  }

  private _installSession(c: RLRCConvertedReplaySession, fileName: string, initialCursor: number): void {
    this.session = c;
    const clamped = Math.max(0, Math.min(Math.max(0, c.frames120Hz.length - 1), initialCursor));
    this.cursorFrame120Hz = this._frac = clamped;
    this._tick = 0;
    this._hudKey = '';
    this.activePovSlotIndex = c.roster[0]?.slotIndex ?? 0;
    this._syncPov(this.activePovSlotIndex);
    this._resetAudio();
    this._syncRoster(c.roster);
    this._applyFrame(clamped, false, null);
    this.runtime?.camera?.resetView?.();
    publishConvertedSessionTelemetry(c, fileName, clamped, this.activePovSlotIndex);
  }

  public async exportRcsReplayPack(): Promise<void> {
    if (!this.session) return;
    setTelem({ isExportingRcsPack: true });
    try { await downloadRcsReplayPack(this.session, getSt().loadedFileName); }
    finally { setTelem({ isExportingRcsPack: false }); }
  }

  public startPlaying(): void {
    const s = this.session;
    if (!s || s.frames120Hz.length === 0) return;
    if (this.isIntervening) this.returnToReplay();
    if (this.cursorFrame120Hz >= s.frames120Hz.length - 1) {
      this.cursorFrame120Hz = this._frac = 0;
      this._resetAudio();
    }
    this._tick = 0;
    setTelem({ viewerState: 'playing', cursorFrame: this.cursorFrame120Hz });
  }

  public pausePlaying(): void {
    if (!this.session || this.isIntervening) return;
    this.runtime?.audioSubsystem?.resetAudio?.();
    this._resetAudio();
    setTelem({ viewerState: 'paused', cursorFrame: this.cursorFrame120Hz });
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
    this.cursorFrame120Hz = this._frac = clamped;
    this._resetAudio();
    this._applyFrame(clamped, false, null);
    setTelem({ viewerState: 'paused', cursorFrame: clamped, targetFrame: clamped });
  }

  public selectPovSlot(slotKey: number): void {
    const s = this.session;
    if (!s) return;
    const idx = Math.max(0, Math.min(5, Math.round(slotKey) - 1));
    const meta = s.roster.find((r) => r.slotIndex === idx) ?? s.roster[0];
    if (!meta) return;
    const slot = meta.slotIndex, localTeam: RLRCTeamIndex = meta.team === 1 ? 1 : 0;
    this.activePovSlotIndex = slot;
    this._syncPov(slot);
    (syncRLRCNameTagRoster as SyncNameTagFn)(s.roster, slot);
    this._hudKey = '';
    hudStore.getState().setMatchState({ localTeam });
    if (!this.isIntervening) this._applyFrame(this.cursorFrame120Hz, false, null);
    this.runtime?.camera?.resetView?.();
    setTelem({ activePovCarIndex: slot, activePovSlotKey: slot + 1, activePovTeam: localTeam });
  }

  public resumeFromCursor(): void {
    if (!this.session || this.session.frames120Hz.length === 0) return;
    const st = getSt();
    const opts = { povSlotIndex: this.activePovSlotIndex, nonPovMode: mapUiNonPovMode(st.nonPovInterventionMode), downCounterSeconds: st.downCounterSec };
    if (this.isIntervening) this.interveneController.reinterveneAtLastTargetFrame(opts);
    else this.interveneController.enterInterveneAtFrame(this.cursorFrame120Hz, opts);
  }

  public returnToReplay(): void {
    if (!this.session) return;
    const t0Frame = this.interveneController.exitInterveneToViewing();
    this._syncRoster(this.session.roster);
    this.seekFrame(t0Frame);
    this.runtime?.camera?.resetView?.();
  }

  public handleInterpolationMethodChange(uiMethod: string): void {
    if (!this.session?.parserOutput) return;
    const updated = buildRLRCSessionFromParserOutput(this.session.parserOutput, { interpolationMethod: mapUiInterpolationMethod(uiMethod) });
    this._installSession(updated, getSt().loadedFileName || 'match.replay', this.cursorFrame120Hz);
  }

  public handleNonPovModeChange(uiMode: string): void {
    this.interveneController.setNonPovMode(mapUiNonPovMode(uiMode));
  }

  public clearReplay(): void {
    if (this.isIntervening) this.interveneController.exitInterveneToViewing();
    this.runtime?.audioSubsystem?.resetAudio?.();
    this._resetAudio();
    this.session = null;
    this.cursorFrame120Hz = this._frac = this._tick = 0;
    this._hudKey = '';
    setTelem({
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
    const frames = this.session?.frames120Hz;
    if (!frames || frames.length === 0) return false;
    const st = getSt(), state = st.viewerState;
    if (state === 'preroll-countdown' || state === 'intervening') {
      this.interveneController.stepTick(readLiveRuntimePlayerControls(this.runtime, this.activePovSlotIndex), dt);
      return true;
    }
    const maxF = frames.length - 1, spd = Math.max(0.01, (Number(st.effectiveFlowPct) || 100) / 100);
    if (state === 'playing' || state === 'forwarding' || state === 'rewinding') {
      const dir = state === 'rewinding' ? -1 : 1;
      this._frac = Math.max(0, Math.min(maxF, this._frac + dir * (state === 'playing' ? spd : Math.max(1.5, spd * 2))));
      const next = Math.round(this._frac);
      if (next !== this.cursorFrame120Hz) {
        const prev = frames[this.cursorFrame120Hz] ?? null;
        this.cursorFrame120Hz = next;
        this._applyFrame(next, dir > 0, prev);
        const done = (dir > 0 && next >= maxF) || (dir < 0 && next <= 0);
        if (done || (this._tick = (this._tick + 1) & 3) === 0) setTelem({ cursorFrame: next });
        if (done) this.pausePlaying();
      }
      return true;
    }
    this._applyFrame(this.cursorFrame120Hz, false, null);
    return true;
  }

  private _syncPov(slot: number): void {
    if (!this.runtime) return;
    this.runtime.playerCarIndex = slot;
    if (this.runtime.arena) this.runtime.arena.playerCarIndex = slot;
  }

  private _syncRoster(roster: readonly RLRCPlayerSlotMeta[]): void {
    this.playbackApplier.configureRoster(roster, this.runtime as unknown as RLRCPlaybackRuntimePort);
    (syncRLRCNameTagRoster as SyncNameTagFn)(roster, this.activePovSlotIndex);
  }

  private _applyFrame(idx: number, smoothStep: boolean, prev: RLRCFrame120Hz | null): void {
    const f = this.session?.frames120Hz[idx];
    if (!f) return;
    this.playbackApplier.applyFrame120Hz(f, this.runtime as unknown as RLRCPlaybackRuntimePort, {
      smoothStep, activePovSlotIndex: this.activePovSlotIndex,
    });
    if (smoothStep) this._stepAudio(prev, f);
    this._syncHud(f);
  }

  private _syncHud(f: RLRCFrame120Hz): void {
    const meta = this.session?.roster.find((r) => r.slotIndex === this.activePovSlotIndex) ?? this.session?.roster[0];
    const localTeam: RLRCTeamIndex = meta?.team === 1 ? 1 : 0, isOvertime = Boolean(f.isOvertime);
    const blueScore = Math.max(0, f.blueScore | 0), orangeScore = Math.max(0, f.orangeScore | 0);
    const sec = Math.max(0, Math.round(f.secondsRemaining || 0)), kickoffCountdown = Math.max(0, Math.min(3, f.roundCountdownNumber | 0));
    const remainingSeconds = isOvertime ? 0 : sec, overtimeSeconds = isOvertime ? sec : 0;
    const key = [localTeam, blueScore, orangeScore, remainingSeconds, overtimeSeconds, isOvertime, kickoffCountdown].join('|');
    if (key === this._hudKey) return;
    this._hudKey = key;
    hudStore.getState().setMatchState({
      localTeam, blueScore, orangeScore, remainingSeconds, overtimeSeconds, isOvertime, kickoffCountdown,
      matchPhase: kickoffCountdown > 0 ? 'kickoff' : 'playing',
    });
  }

  private _resetAudio(): void {
    const s = this.audioEdgeSynthesizer;
    const fn = (s?.reset ?? s?.clear ?? s?.resetTracking) as (() => void) | undefined;
    if (typeof fn === 'function') fn.call(s);
  }

  private _stepAudio(prev: RLRCFrame120Hz | null, curr: RLRCFrame120Hz): void {
    const s = this.audioEdgeSynthesizer, rt = this.runtime as Record<string, unknown> | null;
    const fn = (s?.stepFrame120Hz ?? s?.applyFrame120Hz ?? s?.synthesizeFrame120Hz ?? s?.processFrame120Hz ?? s?.step ?? s?.update) as ((...a: unknown[]) => unknown) | undefined;
    if (!s || typeof fn !== 'function') return;
    const sig = Function.prototype.toString.call(fn), p0 = sig.slice(sig.indexOf('(') + 1, sig.indexOf(')')).trim();
    const opts = { frame: curr, currFrame: curr, prevFrame: prev, runtime: rt, activePovSlotIndex: this.activePovSlotIndex, bookmarks: this.session?.bookmarks ?? [] };
    if (p0.startsWith('{')) fn.call(s, opts);
    else if (/^prev/i.test(p0)) fn.call(s, prev, curr, rt, opts);
    else fn.call(s, curr, rt, opts);
  }
}
