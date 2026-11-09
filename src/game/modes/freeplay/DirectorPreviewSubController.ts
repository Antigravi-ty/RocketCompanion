import type { ImportedDiagnosticPatternInput } from '../../../replay/ReplayDirectorStatePipeline.ts';
import type { ReplayRingBuffer } from '../../../replay/ReplayRingBuffer.ts';
import type { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import type { NormalizedReplayDirectorCarEntry } from '../../../replay/replayDirectorCarRosterPipeline.ts';
import {
  getActiveReplayTimelineController,
  setActiveReplayTimelineController,
  registerReplayDirectorPreviewHandlers,
  getNameTagRuntimeState,
  setNameTagRuntimeState,
  hudStore,
  useAppStore,
} from '../../runtimeUiPort.ts';
import {
  beginGoalReplaySession,
  bindGoalReplayHudCallbacks,
  endGoalReplaySession,
  stepGoalReplaySessionFrame,
  type GoalReplayRuntimePort,
} from '../shared/GoalReplaySessionCoordinator.ts';
import { stepNetworkStreamedGoalReplayFrame } from '../shared/networkStreamedGoalReplayCoordinator.ts';
import {
  pauseReplayAndEnterReferenceFreeCam,
  prepareDirectorPatternPreviewRoster,
  prepareFreeplayGoalReplaySessionData,
  resolveImportedDiagnosticPatternInput,
  restoreSingleCarAfterPreview,
  syncAndAttachReplayTimelineController,
} from './directorPreviewPipeline.ts';
import {
  applyReplayControllerFrameAndDirectorCamera,
  type GoalReplayCarStateViewLike,
} from '../shared/goalReplayHudPipeline.ts';

export type ReplayCameraMode = 'director' | 'pov';
export type DirectorPreviewCarEntry = NormalizedReplayDirectorCarEntry;

export interface DirectorPatternPreviewOptions {
  fileName?: string;
  autoStartPreview?: boolean;
  startPaused?: boolean;
  restart?: boolean;
}
export interface ReferenceFreeCamOptions {
  fov?: number;
}
export interface GoalReplayIncidentInput {
  goalIncidentTick: number;
  lastTouchTick: number;
  lastKickoffStartTick: number;
  scoringTeam?: number;
  scorerCarIndex: number;
  scorerName: string;
  ballSpeedKph: number | null;
  replayType?: 'goal' | 'expire';
}
export interface DirectorPreviewStepContext {
  dt?: number;
  activeCar?: number;
  activeCarMesh?: unknown;
  playerCarView?: GoalReplayCarStateViewLike | null;
  isSupersonic?: boolean;
  curBoost?: number;
}

export interface DirectorPreviewRuntimePort extends GoalReplayRuntimePort {
  physics?:
    | (NonNullable<GoalReplayRuntimePort['physics']> & {
        numCars: number;
        getBallStateView?: () => { posY: number } | null;
        getHeaderView?: () => { tickCount: number } | null;
        removeCar?: (carIndex: number) => void;
        addCar?: (team: number, preset: string) => number | void;
      })
    | null;
  arena?:
    | (NonNullable<GoalReplayRuntimePort['arena']> & {
        carTeams?: ArrayLike<number>;
        carVisual?: string;
        cars?: Array<{ visible: boolean } | null | undefined>;
        setCarTeam?: (carIndex: number, team: number) => void;
        ensureCar?: (carIndex: number, team: number, preset: string) => void;
      })
    | null;
  camera?:
    | (NonNullable<GoalReplayRuntimePort['camera']> & {
        getFreeCamStateSnapshot?: () => object | null;
      })
    | null;
  keyboard?: { ballControlEnabled?: boolean } | null;
  match?: {
    state?: { mode?: string; phase?: string; scorer?: number; scorerCarIndex?: number } | null;
  } | null;
  modeManager?: { setMode?: (modeId: string) => void } | null;
}

export interface DirectorPreviewSubControllerDeps {
  getRuntime: () => DirectorPreviewRuntimePort | null;
  replayController: ReplayTimelineController;
  replayRingBuffer: ReplayRingBuffer;
  resolveEffectivePlayerTeam: () => number;
  isStandaloneReplayLoaded: () => boolean;
  isStandaloneReplayActive: () => boolean;
  pauseStandaloneReplay: () => void;
  isNameTagTunerActive: () => boolean;
  notifyReplaySessionCompleted: () => void;
}

export class DirectorPreviewSubController {
  private readonly deps: DirectorPreviewSubControllerDeps;
  public isReplayActive = false;
  public replayCameraMode: ReplayCameraMode = 'director';
  public goalScoringTeam = 0;
  public goalScorerCarIndex = 0;
  public goalScorerName = 'Player';
  public goalBallSpeedKph: number | null = null;
  public previewSpawnedExtraCars = false;
  private savedCar0: NormalizedReplayDirectorCarEntry | null = null;

  constructor(deps: DirectorPreviewSubControllerDeps) {
    this.deps = deps;
    this.goalScoringTeam = deps.resolveEffectivePlayerTeam();
    this.registerPreviewHandlers();
    if (!getActiveReplayTimelineController())
      setActiveReplayTimelineController(deps.replayController);
  }

  public registerPreviewHandlers(): void {
    const handleImport = (f: unknown, opt: DirectorPatternPreviewOptions = {}) =>
      this.importDiagnosticPattern(f, opt);
    const handleStart = (opt: DirectorPatternPreviewOptions = {}) =>
      this.startPatternPreview(null, opt);
    const handleExit = () => this.exitPatternPreview();
    const handleEnterRef = (opt: ReferenceFreeCamOptions = {}) =>
      this.enterReferenceFreeCamFromHere(opt);
    const handleExitRef = () => this.exitReferenceFreeCam();
    const handleGetLiveCam = () =>
      this.deps.getRuntime()?.camera?.getFreeCamStateSnapshot?.() || null;
    registerReplayDirectorPreviewHandlers({
      onImportPattern: handleImport,
      onStartPreview: handleStart,
      onExitPreview: handleExit,
      onEnterReferenceFreeCam: handleEnterRef,
      onExitReferenceFreeCam: handleExitRef,
      onGetLiveCameraState: handleGetLiveCam,
    });
  }

  public resetGoalMetadata(scoringTeam = this.deps.resolveEffectivePlayerTeam()): void {
    this.setGoalMetadata({
      scoringTeam,
      scorerCarIndex: 0,
      scorerName: 'Player',
      ballSpeedKph: null,
    });
  }

  public setGoalMetadata(meta: {
    scoringTeam: number;
    scorerCarIndex: number;
    scorerName: string;
    ballSpeedKph: number | null;
  }): void {
    this.goalScoringTeam = meta.scoringTeam;
    this.goalScorerCarIndex = meta.scorerCarIndex;
    this.goalScorerName = meta.scorerName;
    this.goalBallSpeedKph = meta.ballSpeedKph;
  }

  public onEnter(freeplayTeam: number): void {
    const { replayController, replayRingBuffer } = this.deps;
    this.registerPreviewHandlers();
    syncAndAttachReplayTimelineController(
      replayController,
      this.deps.getRuntime()?.physics,
      replayRingBuffer,
      true
    );
    setActiveReplayTimelineController(replayController);
    this.isReplayActive = false;
    this.resetGoalMetadata(freeplayTeam);
  }

  public onExit(): void {
    const r = this.deps.getRuntime();
    this.deps.replayController?.endReplaySession?.();
    this.isReplayActive = false;
    r?.releaseGoalReplayCameraOverride?.();
    r?.ballTrajectoryPredictor?.releaseTemporarySuppression?.();
    hudStore.getState().setReplayState({ replayPaused: false, replayPersistent: false });
  }

  public beginGoalReplay(incident: GoalReplayIncidentInput): void {
    const r = this.deps.getRuntime();
    const sim = r?.physics;
    const { replayRingBuffer, replayController } = this.deps;
    if (!sim || !replayRingBuffer || replayRingBuffer.size === 0)
      return this.completeReplaySession();

    const playerTeam = this.deps.resolveEffectivePlayerTeam();
    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    syncAndAttachReplayTimelineController(replayController, sim, replayRingBuffer, false);

    const prepared = prepareFreeplayGoalReplaySessionData({
      runtime: r,
      ringBuffer: replayRingBuffer,
      playerTeam,
      isStandaloneReplayLoaded: this.deps.isStandaloneReplayLoaded(),
      explicitCarEntries: this.deps.isNameTagTunerActive()
        ? getNameTagRuntimeState()?.carEntries
        : undefined,
      incident,
      currentTick,
      ballPosY: sim.getBallStateView?.()?.posY,
    });
    if (!prepared) return this.completeReplaySession();

    this.goalScoringTeam = prepared.scoringTeam;
    this.goalScorerCarIndex = prepared.scorerCarIndex;
    this.goalScorerName = prepared.scorerName;
    this.goalBallSpeedKph = prepared.ballSpeedKph;
    if (!this.deps.isStandaloneReplayLoaded())
      r?.arena?.setCarTeam?.(this.goalScorerCarIndex, playerTeam);

    const isExpireReplay = incident.replayType === 'expire';
    const totalFrames = replayController.beginReplaySession({
      scoringTeam: this.goalScoringTeam,
      scorerCarIndex: this.goalScorerCarIndex,
      carEntries: prepared.carEntries,
      carTeamResolver: (carIdx: number) =>
        carIdx === this.goalScorerCarIndex
          ? playerTeam
          : (r?.arena?.carTeams?.[carIdx] ?? carIdx % 2),
      frames: prepared.extractedFrames,
      disableSlowMo: isExpireReplay,
      watchAllTouches: isExpireReplay,
    });

    this.isReplayActive = true;
    this.replayCameraMode = 'director';
    if (r?.match?.state) r.match.state.phase = 'replay';
    if (r?.keyboard) r.keyboard.ballControlEnabled = false;

    beginGoalReplaySession(r, replayController, {
      cameraMode: 'director',
      source: 'freeplay-goal-replay',
      syncHud: false,
      scoringTeam: this.goalScoringTeam,
      scorerCarIndex: this.goalScorerCarIndex,
      initialSnapshot: prepared.extractedFrames[0].snapshot,
    });

    setNameTagRuntimeState({ carEntries: prepared.carEntries });
    replayController.sessionState.carEntries = prepared.carEntries;
    this.bindReplayHudState(totalFrames);
  }

  public bindReplayHudState(totalFrames: number): void {
    hudStore.getState().setMatchState({
      matchPhase: 'replay',
      replayScorerName: this.goalScorerName,
      replayScorerTeam: this.goalScoringTeam,
      replayBallSpeedKph: this.goalBallSpeedKph,
      replayAssistName: null,
    });
    bindGoalReplayHudCallbacks({
      runtime: this.deps.getRuntime(),
      replayController: this.deps.replayController,
      source: 'freeplay-goal-replay',
      totalFrames,
      scorerName: this.goalScorerName,
      scorerTeam: this.goalScoringTeam,
      ballSpeedKph: this.goalBallSpeedKph,
      assistName: null,
      getCameraMode: () => this.replayCameraMode || 'director',
      setCameraMode: (nextMode) => {
        this.replayCameraMode = nextMode;
      },
      getScoringTeam: () => this.goalScoringTeam ?? 0,
      getScorerCarIndex: () => this.goalScorerCarIndex ?? 0,
    });
  }

  public async importDiagnosticPattern(
    fileOrInput: unknown,
    options: DirectorPatternPreviewOptions = {}
  ): Promise<ImportedDiagnosticPatternInput | null> {
    const parsed = await resolveImportedDiagnosticPatternInput(fileOrInput, options.fileName);
    if (!parsed) return null;
    if (options.autoStartPreview !== false) this.startPatternPreview(parsed, options);
    else this.deps.replayController.loadImportedDiagnosticPattern(parsed, options);
    return parsed;
  }

  public startPatternPreview(
    parsedPattern: ImportedDiagnosticPatternInput | null = null,
    options: DirectorPatternPreviewOptions = {}
  ): boolean {
    const r = this.deps.getRuntime();
    if (!r) return false;
    const { replayController, replayRingBuffer } = this.deps;

    const appState = useAppStore.getState();
    if (appState.isOpen) appState.closeMenu();
    if (r.match?.state && r.match.state.mode !== 'freeplay') {
      r.match.state.mode = 'freeplay';
      r.match.state.phase = 'playing';
      appState.setMatchMode?.('freeplay');
      r.modeManager?.setMode?.('freeplay');
    }
    if (this.deps.isStandaloneReplayActive()) this.deps.pauseStandaloneReplay();

    syncAndAttachReplayTimelineController(
      replayController,
      r.physics,
      replayRingBuffer,
      !parsedPattern
    );
    if (parsedPattern) replayController.loadImportedDiagnosticPattern(parsedPattern, options);

    const totalFrames = replayController.ActiveWindowCount;
    if (totalFrames <= 0) return false;

    const roster = prepareDirectorPatternPreviewRoster(
      r,
      replayController,
      this.savedCar0,
      this.goalScorerName
    );
    this.savedCar0 = roster.savedPrePreviewCar0;
    this.previewSpawnedExtraCars = true;
    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: roster.numCars > 1,
      carEntries: roster.effectiveCarEntries,
    });
    this.goalScoringTeam = roster.scoringTeam;
    this.goalScorerCarIndex = roster.scorerCarIndex;
    this.goalScorerName = roster.scorerName;
    this.goalBallSpeedKph = null;
    this.isReplayActive = true;
    this.replayCameraMode = 'director';

    replayController.startPreviewSession({
      loop: true,
      startPaused: Boolean(options.startPaused),
      restart: Boolean(options.restart),
    });

    if (r.match?.state) r.match.state.phase = 'replay';
    if (r.keyboard) r.keyboard.ballControlEnabled = false;
    r.acquireGoalReplayCameraOverride?.('freeplay-goal-replay');
    r.ballTrajectoryPredictor?.acquireTemporarySuppression?.('freeplay-goal-replay');

    applyReplayControllerFrameAndDirectorCamera(
      r,
      replayController,
      this.goalScoringTeam,
      this.goalScorerCarIndex
    );
    this.bindReplayHudState(totalFrames);
    return true;
  }

  public enterReferenceFreeCamFromHere(opt: ReferenceFreeCamOptions = {}): boolean {
    const r = this.deps.getRuntime();
    if (!r) return false;
    const { replayController } = this.deps;
    const saved =
      (getActiveReplayTimelineController() || replayController)?.sessionState?.cursorFloat ?? 0;
    let seekCursorFloat: number | null = null;
    if (!this.isReplayActive || !replayController.sessionState.isActive) {
      if (!this.startPatternPreview(null, { startPaused: true, restart: false })) return false;
      seekCursorFloat = saved;
    }
    return pauseReplayAndEnterReferenceFreeCam(r, replayController, {
      seekCursorFloat,
      fov: opt.fov,
    });
  }

  public exitReferenceFreeCam(): boolean {
    const r = this.deps.getRuntime();
    const { replayController } = this.deps;
    useAppStore.getState().setFreeCam(false);
    if (this.isReplayActive && replayController.sessionState.isActive && r) {
      r.acquireGoalReplayCameraOverride?.('freeplay-goal-replay');
      applyReplayControllerFrameAndDirectorCamera(
        r,
        replayController,
        this.goalScoringTeam,
        this.goalScorerCarIndex,
        {
          snapshot: null,
          refreshDirectorPose: true,
        }
      );
    }
    return true;
  }

  public exitPatternPreview(): boolean {
    if (!this.isReplayActive && !this.deps.replayController?.sessionState?.isActive) return false;
    if (useAppStore.getState().isFreeCam) useAppStore.getState().setFreeCam(false);
    this.completeReplaySession();
    return true;
  }

  public completeReplaySession(): void {
    const r = this.deps.getRuntime();
    endGoalReplaySession(r, this.deps.replayController, {
      source: 'freeplay-goal-replay',
      clearHud: false,
    });
    this.isReplayActive = false;

    if (
      this.previewSpawnedExtraCars &&
      !this.deps.isNameTagTunerActive() &&
      !this.deps.isStandaloneReplayLoaded()
    ) {
      restoreSingleCarAfterPreview(r, this.savedCar0);
      setNameTagRuntimeState({ isMultiplayerOrMultiCarMode: false });
      this.previewSpawnedExtraCars = false;
      this.savedCar0 = null;
    }

    if (r) {
      if (r.keyboard)
        r.keyboard.ballControlEnabled =
          !this.deps.isNameTagTunerActive() && !this.deps.isStandaloneReplayLoaded();
      if (r.match?.state) r.match.state.phase = 'playing';
    }

    hudStore.getState().setReplayState({ replayPaused: false, replayPersistent: false });
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
    this.deps.notifyReplaySessionCompleted();
  }

  public step(context: DirectorPreviewStepContext, isUnlimitedBoost: boolean): boolean {
    const r = this.deps.getRuntime();
    const { replayController } = this.deps;

    if (r?.match?.state?.phase === 'replay' && r?.networkReconciler && !this.isReplayActive) {
      stepNetworkStreamedGoalReplayFrame({
        runtime: r,
        replayController,
        context,
        isUnlimitedBoost,
        getCameraMode: () => this.replayCameraMode || 'director',
        setCameraMode: (m) => {
          this.replayCameraMode = m;
        },
        getScoringTeam: () => this.goalScoringTeam ?? 0,
        setScoringTeam: (t) => {
          this.goalScoringTeam = t;
        },
        getScorerCarIndex: () => this.goalScorerCarIndex ?? 0,
        setScorerCarIndex: (idx) => {
          this.goalScorerCarIndex = idx;
        },
      });
      return true;
    }

    const sState = replayController.sessionState;
    if (this.isReplayActive && sState.isActive) {
      const stepRes = stepGoalReplaySessionFrame({
        runtime: r,
        replayController,
        context,
        dt: context.dt ?? 0.016,
        source: 'freeplay-goal-replay',
        cameraMode: this.replayCameraMode || 'director',
        scoringTeam: this.goalScoringTeam ?? 0,
        scorerCarIndex: this.goalScorerCarIndex ?? 0,
        povCarIndex: this.goalScorerCarIndex ?? 0,
        isUnlimitedBoost,
        syncCarAudioControls: true,
        syncBoostToHud: true,
        emitWillEndSignal: true,
        syncHudProgress: true,
      });
      if (stepRes.isFinished && !sState.isPaused && !sState.isPersistent)
        this.completeReplaySession();
      return true;
    }

    if (this.isReplayActive && !sState.isActive) this.completeReplaySession();
    else if (r?.isGoalReplayCameraOverrideActive?.()) {
      r.releaseGoalReplayCameraOverride?.();
      r.camera?.resetView?.();
    }
    return false;
  }
}
