import { BaseGameMode } from './BaseGameMode.ts';
import { isIncidentEvent } from '../../physics/RocketSimConstants.ts';
import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../replay/ReplayRingBuffer.ts';
import { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import {
  DirectorPreviewSubController,
  type DirectorPreviewStepContext,
} from './freeplay/DirectorPreviewSubController.ts';
import { FreeplayGoalAndTouchSubController } from './freeplay/FreeplayGoalAndTouchSubController.ts';
import {
  getActiveReplayTimelineController,
  setActiveReplayTimelineController,
  setNameTagRuntimeState,
  hudStore,
  useAppStore,
} from '../runtimeUiPort.ts';
import {
  getPreferredColorHex,
  getPreferredFreeplayTeam,
} from '../../ui-core/config/vehiclePresets';
import { StandaloneReplayViewerController } from '../../replay/StandaloneReplayViewerController.ts';
import { FreeplayRewinderController } from '../../replay/FreeplayRewinderController.ts';
import {
  retainCompletedMatchReplayAndNotify,
  type RetainedMatchReplay,
} from '../../replay/ReplayFileExporter.ts';
import { NameTagTunerArenaController } from './NameTagTunerArenaController.ts';

export const DEFAULT_FREEPLAY_REPLAY_DURATION_SECONDS = 30;

/**
 * FreeplayMode.ts
 * Casual practice mode: supports 448-float Goal Replay with Director Camera,
 * Pause & Persistent (P key) timeline scrubbing, incident audio replay,
 * unlimited boost support, free ball controls, Standalone Replay Viewer, and Rewinder Configurator.
 */
export class FreeplayMode extends BaseGameMode {
  public readonly replayRingBuffer: ReplayRingBuffer;
  public readonly replayController: ReplayTimelineController;
  public readonly standaloneReplayViewer: StandaloneReplayViewerController;
  public readonly rewinderController: FreeplayRewinderController;
  public readonly nameTagTunerController: NameTagTunerArenaController;
  public readonly directorPreview: DirectorPreviewSubController;
  public readonly goalAndTouch: FreeplayGoalAndTouchSubController;

  constructor(runtime: Record<string, any> | null) {
    super('freeplay', runtime);

    const configuredSeconds = Number(runtime?.trainingOptions?.freeplayReplayDurationSeconds);
    const replayDurationSeconds =
      Number.isFinite(configuredSeconds) && configuredSeconds >= 10
        ? configuredSeconds
        : DEFAULT_FREEPLAY_REPLAY_DURATION_SECONDS;

    this.replayRingBuffer = new ReplayRingBuffer({
      mode: REPLAY_BUFFER_MODES.COUNTUP_FIFO,
      capacityTicks: Math.round(replayDurationSeconds * 120),
    });
    this.replayController = new ReplayTimelineController({
      engine: runtime?.physics || null,
      ringBuffer: this.replayRingBuffer,
    });
    this.standaloneReplayViewer = new StandaloneReplayViewerController(runtime, this);
    this.standaloneReplayViewer.attach();
    this.rewinderController = new FreeplayRewinderController(runtime, this);
    this.rewinderController.attach();
    this.nameTagTunerController = new NameTagTunerArenaController(runtime as any);
    this.nameTagTunerController.attach();
    this.directorPreview = new DirectorPreviewSubController({
      getRuntime: () => this.runtime,
      replayController: this.replayController,
      replayRingBuffer: this.replayRingBuffer,
      resolveEffectivePlayerTeam: () => this._resolveEffectivePlayerTeam(),
      isStandaloneReplayLoaded: () => Boolean(this.standaloneReplayViewer?.hasLoadedReplay),
      isStandaloneReplayActive: () => Boolean(this.standaloneReplayViewer?.isActive),
      pauseStandaloneReplay: () => this.standaloneReplayViewer?.pausePlaying?.(),
      isNameTagTunerActive: () => Boolean(this.nameTagTunerController?.isActive),
      onReplaySessionCompleted: () => {
        this.goalAndTouch.goalResetTicks = 0;
        this.onResetKickoff();
      },
    });
    this.goalAndTouch = new FreeplayGoalAndTouchSubController({
      getRuntime: () => this.runtime,
      replayRingBuffer: this.replayRingBuffer,
      directorPreview: this.directorPreview,
      resolveEffectivePlayerTeam: () => this._resolveEffectivePlayerTeam(),
      isStandaloneReplayLoaded: () => Boolean(this.standaloneReplayViewer?.hasLoadedReplay),
      onAfterFrameRecorded: () => this.rewinderController?.onAfterPhysicsTick?.(),
      onBeginGoalReplay: () => this._beginGoalReplay(),
    });

    this.goalAndTouch.goalResetTicks = 0;
    this.goalAndTouch.lastKickoffStartTick = 0;
    this._resetPlayTouchAndGoalState();
    if (!getActiveReplayTimelineController()) {
      setActiveReplayTimelineController(this.replayController);
    }
  }

  public isGoalReplayActive(): boolean {
    return Boolean(
      this.directorPreview?.isReplayActive ||
        (this.runtime?.match?.state?.phase === 'replay' &&
          this.runtime?.networkReconciler &&
          this.replayController?.sessionState?.isActive)
    );
  }

  public setReplayCameraMode(val: string): void {
    const nextMode = val === 'pov' ? 'pov' : 'director';
    if (this.directorPreview) {
      this.directorPreview.replayCameraMode = nextMode;
    }
    const r = this.runtime;
    if (r?.match?.state?.phase === 'replay' && r?.networkReconciler) {
      if (nextMode === 'pov') {
        if (typeof r.replayPovCarIndex !== 'number' || r.replayPovCarIndex < 0) {
          r.replayPovCarIndex = this.directorPreview?.goalScorerCarIndex ?? 0;
        }
      } else {
        r.replayPovCarIndex = null;
      }
    }
  }

  private _resolveEffectivePlayerTeam(): 0 | 1 {
    if (this.standaloneReplayViewer?.hasLoadedReplay) {
      return this.standaloneReplayViewer.rosterSubController.activePovTeam === 1 ? 1 : 0;
    }
    return getPreferredFreeplayTeam();
  }

  private _syncPlayerPreferredFreeplayTeam(): 0 | 1 {
    const r = this.runtime;
    const freeplayTeam = getPreferredFreeplayTeam();
    if (!this.standaloneReplayViewer?.hasLoadedReplay && r) {
      const playerIdx = r.playerCarIndex ?? 0;
      if (r.teamAssignment) {
        r.teamAssignment.playerTeam = freeplayTeam;
        r.teamAssignment.opponentTeam = freeplayTeam === 0 ? 1 : 0;
      }
      r.physics?.setCarTeam?.(playerIdx, freeplayTeam);
      r.arena?.setCarTeam?.(playerIdx, freeplayTeam);
    }
    return freeplayTeam;
  }

  public _resetPlayTouchAndGoalState(): void {
    const defaultTeam = this._resolveEffectivePlayerTeam();
    this.goalAndTouch?.resetPlayTouchAndGoalState(defaultTeam);
  }

  public override onEnter(): void {
    const r = this.runtime;
    const freeplayTeam = this._syncPlayerPreferredFreeplayTeam();
    if (
      !this.standaloneReplayViewer?.hasLoadedReplay &&
      !r?.arena?.isLobbyMode &&
      r?.match?.state?.phase !== 'lobby'
    ) {
      r?.restoreLocalPlayerFreeplayLoadout?.(0);
    }
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = !this.standaloneReplayViewer?.hasLoadedReplay;
    }
    this.standaloneReplayViewer.runtime = r;
    this.standaloneReplayViewer.mode = this;
    this.standaloneReplayViewer.attach();
    this.rewinderController.runtime = r;
    this.rewinderController.mode = this;
    this.rewinderController.attach();
    this.nameTagTunerController.runtime = r as any;
    this.nameTagTunerController.attach();
    if (r && !r.replayTimelineController) {
      r.replayTimelineController = this.replayController;
    }
    this.directorPreview.onEnter(freeplayTeam);
    this.goalAndTouch.goalResetTicks = 0;
    this.replayRingBuffer?.clear?.();
    this._resetPlayTouchAndGoalState();
    this.goalAndTouch.lastKickoffStartTick = Math.floor(
      r?.physics?.getHeaderView?.()?.tickCount ?? 0
    );
    const isLobbyPhase = Boolean(r?.arena?.isLobbyMode || r?.match?.state?.phase === 'lobby');
    const targetPhase = isLobbyPhase ? 'lobby' : 'playing';
    if (r?.match?.state) {
      r.match.state.phase = targetPhase;
    }
    hudStore.getState().setMatchState({
      matchPhase: targetPhase,
      localTeam: freeplayTeam,
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
  }

  public override onLeave(): void {
    const r = this.runtime;
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }
    this.standaloneReplayViewer.detach();
    this.rewinderController.detach();
    this.nameTagTunerController.detach();
    this.directorPreview.onExit();
    this.replayRingBuffer?.clear?.();
    this.goalAndTouch.goalResetTicks = 0;
  }

  public onPhysicsEvent(event: Record<string, any> | null | undefined): void {
    if (
      !event ||
      !isIncidentEvent(event.type) ||
      this.isGoalReplayActive() ||
      this.standaloneReplayViewer?.isActive ||
      this.rewinderController?.isBlockingLivePhysics
    ) {
      return;
    }
    const currentTick = Math.floor(this.runtime?.physics?.getHeaderView?.()?.tickCount ?? 0);
    const eventTick = typeof event.tick === 'number' && event.tick > 0 ? event.tick : currentTick;

    this.goalAndTouch.recordIncidentEvent(eventTick, event);
    this.rewinderController?.onPhysicsEvent?.(event);
  }

  public onBeforePhysicsTick(): boolean {
    this.nameTagTunerController?.onBeforePhysicsTick?.();
    if (this.rewinderController && !this.rewinderController.onBeforePhysicsTick()) {
      return false;
    }
    if (this.isGoalReplayActive()) return false;
    if (this.standaloneReplayViewer && !this.standaloneReplayViewer.onBeforePhysicsTick()) {
      return false;
    }
    return true;
  }

  public onAfterPhysicsTick(): void {
    const r = this.runtime;
    const sim = r?.physics;
    if (
      !sim ||
      this.isGoalReplayActive() ||
      this.standaloneReplayViewer?.isActive ||
      this.rewinderController?.isBlockingLivePhysics
    ) {
      return;
    }
    this.goalAndTouch.stepAfterPhysicsTick();
  }

  private _beginGoalReplay(): void {
    this.directorPreview.beginGoalReplay({
      goalIncidentTick: this.goalAndTouch.goalIncidentTick,
      lastTouchTick: this.goalAndTouch.lastTouchTick,
      lastKickoffStartTick: this.goalAndTouch.lastKickoffStartTick,
      scoringTeam: this.directorPreview.goalScoringTeam,
      scorerCarIndex: this.directorPreview.goalScorerCarIndex,
      scorerName: this.directorPreview.goalScorerName,
      ballSpeedKph: this.directorPreview.goalBallSpeedKph,
    });
  }

  public _bindReplayHudState(totalFrames: number): void {
    this.directorPreview.bindReplayHudState(totalFrames);
  }

  public async importDirectorDiagnosticPattern(
    fileOrInput: unknown,
    options: Record<string, unknown> = {}
  ): Promise<boolean> {
    return this.directorPreview.importDiagnosticPattern(fileOrInput, options);
  }

  public startDirectorPatternPreview(
    parsedPattern: Record<string, any> | null = null,
    options: Record<string, any> = {}
  ): boolean {
    return this.directorPreview.startPatternPreview(parsedPattern, options);
  }

  public enterDirectorReferenceFreeCamFromHere(options: Record<string, any> = {}): boolean {
    return this.directorPreview.enterReferenceFreeCamFromHere(options);
  }

  public exitDirectorReferenceFreeCam(): boolean {
    return this.directorPreview.exitReferenceFreeCam();
  }

  public exitDirectorPatternPreview(): boolean {
    return this.directorPreview.exitPatternPreview();
  }

  private _completePostGoalOrReplayTransition(): void {
    this.goalAndTouch.goalResetTicks = 0;
    this.directorPreview.completeReplaySession();
  }

  public skipGoalReplay(): void {
    if (!this.isGoalReplayActive() && this.goalAndTouch.getEffectiveGoalResetTicks() <= 0) return;
    const r = this.runtime;
    if (r?.networkReconciler && !this.directorPreview.isReplayActive) {
      r.networkManager?.voteSkipReplay?.();
      this.onResetKickoff();
      return;
    }
    this._completePostGoalOrReplayTransition();
  }

  public exportRecentHighlightReplay(
    durationSeconds = DEFAULT_FREEPLAY_REPLAY_DURATION_SECONDS,
    suppressNotification = false
  ): RetainedMatchReplay | null {
    const maxFrames = Math.max(120, Math.round(durationSeconds * 120));
    const recentSlots = this.replayRingBuffer
      .getRecentFrames(maxFrames)
      .filter((slot): slot is NonNullable<typeof slot> => Boolean(slot?.snapshot));
    if (recentSlots.length === 0) return null;
    return retainCompletedMatchReplayAndNotify({
      frames: recentSlots,
      mode: 'freeplay_highlight',
      gameMode: 'freeplay',
      durationSeconds: Number((recentSlots.length / 120).toFixed(2)),
      suppressNotification,
    });
  }

  public override update(context: DirectorPreviewStepContext & Record<string, any>): void {
    const r = this.runtime;
    const activeCarIdx = context.activeCar ?? r?.playerCarIndex ?? 0;
    const isScrubOrViewerActive =
      Boolean(this.standaloneReplayViewer?.isActive) ||
      Boolean(this.rewinderController?.isBlockingLivePhysics);
    const isUnlimited = isScrubOrViewerActive
      ? false
      : (r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ??
          Boolean(
            r?.physics?.isUnlimitedBoost ?? r?.trainingOptions?.boostOption === 'unlimited'
          ));

    if (this.directorPreview.step(context, isUnlimited)) {
      return;
    }

    if (r?.isGoalReplayCameraOverrideActive?.()) {
      r.releaseGoalReplayCameraOverride();
      r.camera?.resetView?.();
    }

    const { playerCarView } = context;
    if (playerCarView) {
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, isUnlimited);
    }
  }

  public resetToCleanFreeplay(): void {
    const r = this.runtime;
    this.id = 'freeplay';

    if (this.standaloneReplayViewer?.hasLoadedReplay || this.standaloneReplayViewer?.isActive) {
      this.standaloneReplayViewer.clearReplay();
    }
    if (this.isGoalReplayActive() || this.replayController?.sessionState?.isActive) {
      this.directorPreview.exitPatternPreview();
    }
    if (this.nameTagTunerController?.isActive) {
      this.nameTagTunerController.exitTunerArena();
    }
    if (
      this.rewinderController &&
      (this.rewinderController.isBlockingLivePhysics ||
        (this.rewinderController.rewinderFrames?.length ?? 0) > 0)
    ) {
      this.rewinderController.clearBuffer();
    }

    if (r?.physics) {
      while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
        r.physics.removeCar(r.physics.numCars - 1);
      }
    }
    if (r?.arena?.cars) {
      if (r.arena.cars[0]) r.arena.cars[0].visible = true;
      for (let i = 1; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) {
          r.arena.cars[i].visible = false;
        }
        r.arena.resetCarBoosts?.(i);
        r.arena.carDemolitions?.[i]?.stop?.();
        r.arena.supersonicWheelTrailSystem?.resetCar?.(i);
      }
      r.arena.lighting?.updateSunIntensities?.(1);
    }
    r?.audioSubsystem?.resetAudio?.();
    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: false,
      carEntries: [],
    });
    if (this.directorPreview) {
      this.directorPreview.previewSpawnedExtraCars = false;
    }

    if (r) {
      r.playerCarIndex = 0;
      if (r.arena) {
        r.arena.playerCarIndex = 0;
      }
      r.releaseGoalReplayCameraOverride();
      const playerTeam = this._syncPlayerPreferredFreeplayTeam();
      hudStore.getState().setMatchState({ localTeam: playerTeam });
      if (typeof r.restoreLocalPlayerFreeplayLoadout === 'function') {
        r.restoreLocalPlayerFreeplayLoadout(0);
      } else {
        const appState = useAppStore?.getState?.();
        const targetCar = appState?.activeCar || r.selectedPreset;
        if (targetCar) {
          r.changePlayerVehicle?.(targetCar);
        }
        r.setCarColor?.(0, getPreferredColorHex(null, playerTeam), false);
        r.syncPlayerMaterialsLoadout?.();
      }
      if (r.keyboard) {
        r.keyboard.ballControlEnabled = true;
      }
    }
  }

  public override onResetKickoff(seed: number = -1): void {
    const r = this.runtime;
    if (this.directorPreview?.isReplayActive) {
      this.directorPreview.onExit();
    }
    if (r?.networkReconciler?.replayPlaybackMode || r?.replayTimelineController?.sessionState?.isActive) {
      r.networkReconciler?.setReplayPlaybackMode?.(false);
      r.replayTimelineController?.endReplaySession?.();
      r.replayPovCarIndex = null;
      r.releaseGoalReplayCameraOverride?.();
      hudStore.getState().setReplayState?.({ replayPaused: false, replayPersistent: false });
    }
    this.rewinderController?.onResetKickoff?.();
    this.goalAndTouch.goalResetTicks = 0;
    this._resetPlayTouchAndGoalState();
    r?.ballTrajectoryPredictor?.clear?.();

    if (this.standaloneReplayViewer?.hasLoadedReplay) {
      const takeover = this.standaloneReplayViewer.takeoverSubController;
      const targetIdx = Math.max(
        0,
        Math.min(
          this.standaloneReplayViewer.frames.length - 1,
          Math.round(takeover.targetFrame || takeover.cursor || 0)
        )
      );
      if (!this.standaloneReplayViewer.isActive) {
        this.standaloneReplayViewer._handoffToLiveFreeplay(targetIdx);
      } else {
        this.standaloneReplayViewer._applyFrameAtCursor(false, false);
      }
      r?.audioSubsystem?.resetAudio?.();
      r?.interpolator?.sync?.();
      r?.arena?.resetBallTrail?.();
      r?.camera?.resetView?.();
      if (r?.match?.state) {
        r.match.state.phase = 'playing';
      }
      hudStore.getState().setMatchState({
        matchPhase: 'playing',
        replayScorerName: null,
        replayScorerTeam: null,
        replayBallSpeedKph: null,
        replayAssistName: null,
      });
      return;
    }

    const freeplayTeam = this._syncPlayerPreferredFreeplayTeam();
    const isTrainingUnlimited = r?.trainingOptions?.boostOption === 'unlimited';
    r?.physics?.setUnlimitedBoost?.(isTrainingUnlimited);
    r?.inputPoller?.latchJumpSuppression?.();
    if (r) {
      r.playerControls = { ...r.neutralControls };
      r.playerThrottle = 0;
    }
    if (this.nameTagTunerController?.isActive) {
      this.nameTagTunerController._spawnSixKickoffCars();
      this.nameTagTunerController._syncCarEntriesFromConfig();
    } else {
      r?.physics?.resetKickoff?.(seed);
    }
    if (r?.authoritativeServer && r?.physics) {
      const snap = r.physics.saveCompactState();
      const curTick = Math.floor(r.physics.getHeaderView?.()?.tickCount ?? 0);
      r.authoritativeServer.startTrainingMode?.({
        unlimitedBoost: Boolean(r.physics.isUnlimitedBoost),
        disableGoalReset: Boolean(r.trainingOptions?.disableGoalReset),
        goalReplayEnabled: true,
        fifoDurationSeconds: 30,
        initialState: Array.from(snap),
        resetKickoff: false,
      });
      void r.authoritativeServer.sim?.restoreState?.(snap);
      r.authoritativeServer.clientInputBuffer?.clear?.();
      r.authoritativeServer.lastReceivedControls?.clear?.();
      r.networkReconciler?.syncTimeline?.(snap, curTick);
    }
    r?.audioSubsystem?.resetAudio?.();
    r?.interpolator?.sync?.();
    r?.arena?.resetBallTrail?.();
    if (!this.nameTagTunerController?.isActive || !r?.camera?.isFreeCam) {
      r?.camera?.resetView?.();
    }
    this.goalAndTouch.lastKickoffStartTick = Math.floor(
      r?.physics?.getHeaderView?.()?.tickCount ?? 0
    );
    if (r?.match?.state) {
      r.match.state.phase = 'playing';
    }
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      localTeam: freeplayTeam,
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
  }
}
