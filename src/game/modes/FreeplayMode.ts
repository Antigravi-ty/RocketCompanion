import { BaseGameMode, type GameModePhysicsEvent, type GameModeRuntimePort } from './BaseGameMode.ts';
import { isIncidentEvent } from '../../physics/RocketSimConstants.ts';
import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../replay/ReplayRingBuffer.ts';
import { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import type { ImportedDiagnosticPatternInput } from '../../replay/ReplayDirectorStatePipeline.ts';
import { DirectorPreviewSubController, type DirectorPatternPreviewOptions, type DirectorPreviewStepContext, type ReferenceFreeCamOptions } from './freeplay/DirectorPreviewSubController.ts';
import { FreeplayGoalAndTouchSubController } from './freeplay/FreeplayGoalAndTouchSubController.ts';
import { endGoalReplaySession } from './shared/GoalReplaySessionCoordinator.ts';
import { getActiveReplayTimelineController, setActiveReplayTimelineController, setNameTagRuntimeState, hudStore } from '../runtimeUiPort.ts';
import { getPreferredFreeplayTeam } from '../../ui-core/config/vehiclePresets';
import { StandaloneReplayViewerController } from '../../replay/StandaloneReplayViewerController.ts';
import { RLRCReplaySessionController } from '../../replay/rlrc/runtime/RLRCReplaySessionController.ts';
import type { ReplayScoreboardRuntimePort } from '../../replay/ReplayScoreboardSynchronizer.ts';
import { FreeplayRewinderController, type FreeplayRewinderRuntimePort } from '../../replay/FreeplayRewinderController.ts';
import { retainCompletedMatchReplayAndNotify, type RetainedMatchReplay } from '../../replay/ReplayFileExporter.ts';
import { captureRuntimeReplayCarEntries, type ReplayCarEntryRuntimePort } from '../../replay/replayDirectorCarRosterPipeline.ts';
import { NameTagTunerArenaController, type NameTagTunerRuntimeHost } from './NameTagTunerArenaController.ts';

export const DEFAULT_FREEPLAY_REPLAY_DURATION_SECONDS = 60;
export type FreeplayRuntimePort = GameModeRuntimePort & ReplayScoreboardRuntimePort & FreeplayRewinderRuntimePort & NameTagTunerRuntimeHost;
export class FreeplayMode extends BaseGameMode<FreeplayRuntimePort> {
  public readonly replayRingBuffer: ReplayRingBuffer;
  public readonly replayController: ReplayTimelineController;
  public readonly standaloneReplayViewer: StandaloneReplayViewerController;
  public readonly rlrcReplaySession: RLRCReplaySessionController;
  public readonly rewinderController: FreeplayRewinderController;
  public readonly nameTagTunerController: NameTagTunerArenaController;
  public readonly directorPreview: DirectorPreviewSubController;
  public readonly goalAndTouch: FreeplayGoalAndTouchSubController;

  constructor(runtime: FreeplayRuntimePort | null) {
    super('freeplay', runtime);
    const cfgSec = Number(runtime?.trainingOptions?.freeplayReplayDurationSeconds);
    const replaySec = Number.isFinite(cfgSec) && cfgSec >= 10 ? cfgSec : DEFAULT_FREEPLAY_REPLAY_DURATION_SECONDS;
    this.replayRingBuffer = new ReplayRingBuffer({ mode: REPLAY_BUFFER_MODES.COUNTUP_FIFO, capacityTicks: Math.round(replaySec * 120) });
    this.replayController = new ReplayTimelineController({ engine: runtime?.physics || null, ringBuffer: this.replayRingBuffer });
    this.standaloneReplayViewer = new StandaloneReplayViewerController(this.runtime, this);
    this.standaloneReplayViewer.attach();
    this.rlrcReplaySession = new RLRCReplaySessionController(this.runtime, this);
    this.rlrcReplaySession.attach();
    this.rewinderController = new FreeplayRewinderController(this.runtime, this);
    this.rewinderController.attach();
    this.nameTagTunerController = new NameTagTunerArenaController(this.runtime);
    this.nameTagTunerController.attach();
    this.directorPreview = new DirectorPreviewSubController({
      getRuntime: () => this.runtime, replayController: this.replayController, replayRingBuffer: this.replayRingBuffer,
      resolveEffectivePlayerTeam: () => this._resolveEffectivePlayerTeam(),
      isStandaloneReplayLoaded: () => this._hasExtReplay(), isStandaloneReplayActive: () => this._isExtReplayActive(),
      pauseStandaloneReplay: () => { this.standaloneReplayViewer?.pausePlaying?.(); this.rlrcReplaySession?.pausePlaying?.(); },
      isNameTagTunerActive: () => Boolean(this.nameTagTunerController?.isActive),
      onReplaySessionCompleted: () => { this.goalAndTouch.goalResetTicks = 0; this.onResetKickoff(); },
    });
    this.goalAndTouch = new FreeplayGoalAndTouchSubController({
      getRuntime: () => this.runtime, replayRingBuffer: this.replayRingBuffer, directorPreview: this.directorPreview,
      resolveEffectivePlayerTeam: () => this._resolveEffectivePlayerTeam(), isStandaloneReplayLoaded: () => this._hasExtReplay(),
      onAfterFrameRecorded: () => this.rewinderController?.onAfterPhysicsTick?.(), onBeginGoalReplay: () => this._beginGoalReplay(),
    });
    this.goalAndTouch.goalResetTicks = 0;
    this.goalAndTouch.lastKickoffStartTick = 0;
    this._resetPlayTouchAndGoalState();
    if (!getActiveReplayTimelineController()) setActiveReplayTimelineController(this.replayController);
  }

  private _hasExtReplay(): boolean { return Boolean(this.standaloneReplayViewer?.hasLoadedReplay || this.rlrcReplaySession?.hasLoadedReplay); }
  private _isExtReplayActive(): boolean { return Boolean(this.standaloneReplayViewer?.isActive || this.rlrcReplaySession?.isActive); }

  public isGoalReplayActive(): boolean {
    return Boolean(this.directorPreview?.isReplayActive || (this.runtime?.match?.state?.phase === 'replay' && this.runtime?.networkReconciler && this.replayController?.sessionState?.isActive));
  }

  public setReplayCameraMode(val: string): void {
    const nextMode = val === 'pov' ? 'pov' : 'director', r = this.runtime;
    if (this.directorPreview) this.directorPreview.replayCameraMode = nextMode;
    if (r?.match?.state?.phase === 'replay' && r?.networkReconciler) {
      r.replayPovCarIndex = nextMode === 'pov' ? (typeof r.replayPovCarIndex === 'number' && r.replayPovCarIndex >= 0 ? r.replayPovCarIndex : (this.directorPreview?.goalScorerCarIndex ?? 0)) : null;
    }
  }

  private _resolveEffectivePlayerTeam(): 0 | 1 {
    if (this.rlrcReplaySession?.hasLoadedReplay && this.rlrcReplaySession.session) {
      return this.rlrcReplaySession.session.roster.find((r) => r.slotIndex === this.rlrcReplaySession.activePovSlotIndex)?.team === 1 ? 1 : 0;
    }
    return this.standaloneReplayViewer?.hasLoadedReplay ? (this.standaloneReplayViewer.rosterSubController.activePovTeam === 1 ? 1 : 0) : getPreferredFreeplayTeam();
  }

  public override getCarControls(carIdx: number): Record<string, unknown> | null {
    return this.rlrcReplaySession?.isActive && !this.rlrcReplaySession.isIntervening
      ? (this.rlrcReplaySession.getCarControls(carIdx) as unknown as Record<string, unknown>)
      : null;
  }

  private _syncPlayerPreferredFreeplayTeam(options: { resetPlayerCarIndex?: boolean; restoreLoadout?: boolean } = {}): 0 | 1 {
    const freeplayTeam = getPreferredFreeplayTeam();
    if (!this._hasExtReplay()) this.syncPlayerTeamAndFreeplayLoadout(freeplayTeam, options);
    return freeplayTeam;
  }

  public _resetPlayTouchAndGoalState(): void {
    this.goalAndTouch?.resetPlayTouchAndGoalState(this._resolveEffectivePlayerTeam());
  }

  public override onEnter(): void {
    const r = this.runtime, ext = this._hasExtReplay();
    const freeplayTeam = this._syncPlayerPreferredFreeplayTeam({ restoreLoadout: Boolean(!ext && !r?.arena?.isLobbyMode && r?.match?.state?.phase !== 'lobby') });
    if (r?.keyboard) r.keyboard.ballControlEnabled = !ext;
    for (const ctrl of [this.standaloneReplayViewer, this.rlrcReplaySession, this.rewinderController]) { ctrl.runtime = r; ctrl.mode = this; ctrl.attach(); }
    this.nameTagTunerController.runtime = r; this.nameTagTunerController.attach();
    this.directorPreview.onEnter(freeplayTeam);
    this.goalAndTouch.goalResetTicks = 0;
    this.replayRingBuffer?.clear?.();
    this._resetPlayTouchAndGoalState();
    this.goalAndTouch.lastKickoffStartTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);
    const targetPhase = r?.arena?.isLobbyMode || r?.match?.state?.phase === 'lobby' ? 'lobby' : 'playing';
    if (r?.match?.state) r.match.state.phase = targetPhase;
    hudStore.getState().setMatchState({ matchPhase: targetPhase, localTeam: freeplayTeam, replayScorerName: null, replayScorerTeam: null, replayBallSpeedKph: null, replayAssistName: null });
  }

  public override onLeave(): void {
    if (this.runtime?.keyboard) this.runtime.keyboard.ballControlEnabled = false;
    for (const ctrl of [this.standaloneReplayViewer, this.rlrcReplaySession, this.rewinderController, this.nameTagTunerController]) ctrl.detach();
    this.directorPreview.onExit(); this.replayRingBuffer?.clear?.(); this.goalAndTouch.goalResetTicks = 0;
  }

  public override onPhysicsEvent(event: GameModePhysicsEvent | null | undefined): void {
    if (!event || !isIncidentEvent(event.type ?? -1) || this.isGoalReplayActive() || this._isExtReplayActive() || this.rewinderController?.isBlockingLivePhysics) return;
    const curTick = Math.floor(this.runtime?.physics?.getHeaderView?.()?.tickCount ?? 0);
    this.goalAndTouch.recordIncidentEvent(typeof event.tick === 'number' && event.tick > 0 ? event.tick : curTick, event);
    this.rewinderController?.onPhysicsEvent?.(event);
  }

  public override onBeforePhysicsTick(): boolean {
    this.nameTagTunerController?.onBeforePhysicsTick?.();
    if (this.rewinderController && !this.rewinderController.onBeforePhysicsTick()) return false;
    if (this.isGoalReplayActive()) return false;
    if (this.rlrcReplaySession && !this.rlrcReplaySession.onBeforePhysicsTick()) return false;
    if (this.standaloneReplayViewer && !this.standaloneReplayViewer.onBeforePhysicsTick()) return false;
    return true;
  }

  public override onAfterPhysicsTick(): void {
    if (!this.runtime?.physics || this.isGoalReplayActive() || this._isExtReplayActive() || this.rewinderController?.isBlockingLivePhysics) return;
    this.goalAndTouch.stepAfterPhysicsTick();
  }

  private _beginGoalReplay(): void {
    const gt = this.goalAndTouch, dp = this.directorPreview;
    dp.beginGoalReplay({
      goalIncidentTick: gt.goalIncidentTick, lastTouchTick: gt.lastTouchTick, lastKickoffStartTick: gt.lastKickoffStartTick,
      scoringTeam: dp.goalScoringTeam, scorerCarIndex: dp.goalScorerCarIndex, scorerName: dp.goalScorerName, ballSpeedKph: dp.goalBallSpeedKph,
    });
  }

  public _bindReplayHudState(totalFrames: number): void { this.directorPreview.bindReplayHudState(totalFrames); }
  public override async importDirectorDiagnosticPattern(fileOrInput: unknown, options: DirectorPatternPreviewOptions = {}): Promise<ImportedDiagnosticPatternInput | null> { return this.directorPreview.importDiagnosticPattern(fileOrInput, options); }
  public override startDirectorPatternPreview(parsedPattern: ImportedDiagnosticPatternInput | null = null, options: DirectorPatternPreviewOptions = {}): boolean { return this.directorPreview.startPatternPreview(parsedPattern, options); }
  public override enterDirectorReferenceFreeCamFromHere(options: ReferenceFreeCamOptions = {}): boolean { return this.directorPreview.enterReferenceFreeCamFromHere(options); }
  public override exitDirectorReferenceFreeCam(): boolean { return this.directorPreview.exitReferenceFreeCam(); }
  public override exitDirectorPatternPreview(): boolean { return this.directorPreview.exitPatternPreview(); }

  public override skipGoalReplay(): void {
    if (!this.isGoalReplayActive() && this.goalAndTouch.getEffectiveGoalResetTicks() <= 0) return;
    if (this.runtime?.networkReconciler && !this.directorPreview.isReplayActive) { this.runtime.networkManager?.voteSkipReplay?.(); this.onResetKickoff(); return; }
    this.goalAndTouch.goalResetTicks = 0; this.directorPreview.completeReplaySession();
  }

  public override exportRecentHighlightReplay(durationSeconds = DEFAULT_FREEPLAY_REPLAY_DURATION_SECONDS, suppressNotification = false): RetainedMatchReplay | null {
    const recentSlots = this.replayRingBuffer.getRecentFrames(Math.max(120, Math.round(durationSeconds * 120))).filter((slot): slot is NonNullable<typeof slot> => Boolean(slot?.snapshot));
    if (recentSlots.length === 0) return null;
    const roster = captureRuntimeReplayCarEntries(this.runtime as unknown as ReplayCarEntryRuntimePort, { frameBuffer: recentSlots[0].snapshot, defaultTeam: this._resolveEffectivePlayerTeam() });
    return retainCompletedMatchReplayAndNotify({ frames: recentSlots, mode: 'freeplay_highlight', gameMode: 'freeplay', durationSeconds: Number((recentSlots.length / 120).toFixed(2)), roster, suppressNotification });
  }

  public override update(context: DirectorPreviewStepContext): void {
    const r = this.runtime, activeCarIdx = context.activeCar ?? r?.playerCarIndex ?? 0;
    const isExtActive = Boolean(this.standaloneReplayViewer?.isActive || this.rlrcReplaySession?.isActive || this.rlrcReplaySession?.isIntervening || this.rewinderController?.isBlockingLivePhysics);
    const isUnlimited = isExtActive ? false : (r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ?? Boolean(r?.physics?.isUnlimitedBoost ?? r?.trainingOptions?.boostOption === 'unlimited'));
    if (this.directorPreview.step(context, isUnlimited)) return;
    if (context.playerCarView) hudStore.getState().setBoost(context.playerCarView.boost, Boolean(context.playerCarView.isBoosting), isUnlimited);
  }

  public override resetToCleanFreeplay(): void {
    const r = this.runtime;
    this.id = 'freeplay';
    this.goalAndTouch.applyCleanFreeplayReset({
      standaloneReplayViewer: this.standaloneReplayViewer, isGoalReplayActive: this.isGoalReplayActive(),
      replayController: this.replayController, nameTagTunerController: this.nameTagTunerController, rewinderController: this.rewinderController,
    });
    setNameTagRuntimeState({ isMultiplayerOrMultiCarMode: false, carEntries: [] });
    if (r) {
      endGoalReplaySession(r, null, { resetHudFlags: false });
      const pref = getPreferredFreeplayTeam();
      const playerTeam = this.syncPlayerTeamAndFreeplayLoadout(pref, { resetPlayerCarIndex: true, restoreLoadout: true }) ?? pref;
      hudStore.getState().setMatchState({ localTeam: playerTeam });
      if (r.keyboard) r.keyboard.ballControlEnabled = true;
    }
  }

  public override onResetKickoff(seed: number = -1): void {
    const r = this.runtime;
    if (this.directorPreview?.isReplayActive) this.directorPreview.onExit();
    if (r?.networkReconciler?.replayPlaybackMode || this.replayController?.sessionState?.isActive) {
      r?.networkReconciler?.setReplayPlaybackMode?.(false);
      endGoalReplaySession(r, this.replayController, { clearHud: false });
    }
    this.rewinderController?.onResetKickoff?.();
    this.goalAndTouch.goalResetTicks = 0;
    this._resetPlayTouchAndGoalState();
    if (this.goalAndTouch.tryApplyStandaloneViewerKickoffReset(this.standaloneReplayViewer, () => this.resetKickoffPresentationAndAudio({ resetCamera: true, resetBots: false }))) {
      if (r?.match?.state) r.match.state.phase = 'playing';
      hudStore.getState().setMatchState({ matchPhase: 'playing', replayScorerName: null, replayScorerTeam: null, replayBallSpeedKph: null, replayAssistName: null });
      return;
    }
    const freeplayTeam = this._syncPlayerPreferredFreeplayTeam();
    r?.physics?.setUnlimitedBoost?.(r?.trainingOptions?.boostOption === 'unlimited');
    r?.inputPoller?.latchJumpSuppression?.();
    if (r) { if (r.neutralControls) r.playerControls = { ...r.neutralControls }; r.playerThrottle = 0; }
    if (this.nameTagTunerController?.isActive) { this.nameTagTunerController._spawnSixKickoffCars(); this.nameTagTunerController._syncCarEntriesFromConfig(); }
    else r?.physics?.resetKickoff?.(seed);
    this.goalAndTouch.syncAuthoritativeServerKickoffState();
    this.resetKickoffPresentationAndAudio({ resetCamera: !this.nameTagTunerController?.isActive || !r?.camera?.isFreeCam, resetBots: false });
    this.goalAndTouch.lastKickoffStartTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);
    if (r?.match?.state) r.match.state.phase = 'playing';
    hudStore.getState().setMatchState({ matchPhase: 'playing', localTeam: freeplayTeam, replayScorerName: null, replayScorerTeam: null, replayBallSpeedKph: null, replayAssistName: null });
  }
}
