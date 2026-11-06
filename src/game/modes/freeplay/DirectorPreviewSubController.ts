/**
 * DirectorPreviewSubController.ts
 * Stateful sub-controller for FreeplayMode handling Goal Replay session lifecycle,
 * HUD replay callback bindings, imported RCGR diagnostic pattern preview orchestration,
 * and Reference FreeCam switching.
 */

import { SIM_OFFSETS, MAX_CARS } from '../../../physics/RocketSimConstants.ts';
import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.ts';
import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.ts';
import { applyDirectorReplayCamera } from '../../../replay/ReplayDirectorCamera.ts';
import { dispatchReplayFrameEvents } from '../../../replay/ReplayFrameEventDispatcher.ts';
import {
  parseDirectorDiagnosticPatternText,
  parseDirectorDiagnosticInput,
} from '../../../replay/ReplayDirectorPatternParser.ts';
import {
  applyReplayCarEntriesToRuntime,
  captureRuntimeReplayCarEntries,
  type NormalizedReplayDirectorCarEntry,
} from '../../../replay/replayDirectorCarRosterPipeline.ts';
import {
  getActiveReplayTimelineController,
  getLatestRetainedReplayTimelineController,
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
  stepNetworkStreamedGoalReplayFrame,
} from '../shared/GoalReplaySessionCoordinator.ts';
import { DEFAULT_REPLAY_DIRECTOR_FOV_DEG } from '../../../ui-core/config/replayDirectorConfig.ts';

const MAX_GOAL_LOOKBACK_SECONDS = 10.0;
const SCORER_TOUCH_LOOKBACK_SECONDS = 7.0;

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
}

export interface DirectorPreviewStepContext {
  dt?: number;
  activeCar?: number;
  activeCarMesh?: unknown;
  playerCarView?: any;
  isSupersonic?: boolean;
  curBoost?: number;
}

export interface DirectorPreviewSubControllerDeps {
  getRuntime: () => any;
  replayController: any;
  replayRingBuffer: any;
  resolveEffectivePlayerTeam: () => number;
  isStandaloneReplayLoaded: () => boolean;
  isStandaloneReplayActive: () => boolean;
  pauseStandaloneReplay: () => void;
  isNameTagTunerActive: () => boolean;
  onReplaySessionCompleted: () => void;
}

export class DirectorPreviewSubController {
  private readonly deps: DirectorPreviewSubControllerDeps;
  public isReplayActive: boolean = false;
  public replayCameraMode: ReplayCameraMode = 'director';
  public goalScoringTeam: number = 0;
  public goalScorerCarIndex: number = 0;
  public goalScorerName: string = 'Player';
  public goalBallSpeedKph: number | null = null;
  public previewSpawnedExtraCars: boolean = false;
  private savedPrePreviewCar0: NormalizedReplayDirectorCarEntry | null = null;

  constructor(deps: DirectorPreviewSubControllerDeps) {
    this.deps = deps;
    this.goalScoringTeam = deps.resolveEffectivePlayerTeam();
    this.registerPreviewHandlers();
    if (!getActiveReplayTimelineController()) {
      setActiveReplayTimelineController(deps.replayController);
    }
  }

  public registerPreviewHandlers(): void {
    registerReplayDirectorPreviewHandlers({
      onImportPattern: (fileOrText: unknown, options: DirectorPatternPreviewOptions = {}) =>
        this.importDiagnosticPattern(fileOrText, options),
      onStartPreview: (options: DirectorPatternPreviewOptions = {}) =>
        this.startPatternPreview(null, options),
      onExitPreview: () => this.exitPatternPreview(),
      onEnterReferenceFreeCam: (options: ReferenceFreeCamOptions = {}) =>
        this.enterReferenceFreeCamFromHere(options),
      onExitReferenceFreeCam: () => this.exitReferenceFreeCam(),
      onGetLiveCameraState: () =>
        this.deps.getRuntime()?.camera?.getFreeCamStateSnapshot?.() || null,
    });
  }

  public resetGoalMetadata(scoringTeam: number = this.deps.resolveEffectivePlayerTeam()): void {
    this.goalScoringTeam = scoringTeam;
    this.goalScorerCarIndex = 0;
    this.goalScorerName = 'Player';
    this.goalBallSpeedKph = null;
  }

  public onEnter(freeplayTeam: number): void {
    const r = this.deps.getRuntime();
    const { replayController, replayRingBuffer } = this.deps;
    if (r?.physics && replayController.engine !== r.physics) {
      replayController.attach(r.physics, replayRingBuffer);
    }
    this.registerPreviewHandlers();
    const latestRetainedCtrl =
      getLatestRetainedReplayTimelineController() || getActiveReplayTimelineController();
    if (
      latestRetainedCtrl &&
      latestRetainedCtrl !== replayController &&
      latestRetainedCtrl.ActiveWindowCount > 0 &&
      ((latestRetainedCtrl.sessionState?.retainedReplaySeq || 0) > (replayController.sessionState.retainedReplaySeq || 0) ||
        replayController.ActiveWindowCount <= 0)
    ) {
      replayController.copyRetainedReplayFrom(latestRetainedCtrl);
    }
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
    if (!sim || !replayRingBuffer || replayRingBuffer.size === 0) {
      this.completeReplaySession();
      return;
    }

    const playerTeam = this.deps.resolveEffectivePlayerTeam();
    const bView = sim.getBallStateView?.();
    const resolvedScoringTeam =
      incident.scoringTeam === 0 || incident.scoringTeam === 1
        ? incident.scoringTeam
        : bView && typeof bView.posY === 'number' && Math.abs(bView.posY) > 100
          ? (bView.posY >= 0 ? 0 : 1)
          : playerTeam;
    this.goalScoringTeam = resolvedScoringTeam;
    this.goalScorerCarIndex = incident.scorerCarIndex;
    this.goalScorerName = incident.scorerName || 'Player';
    this.goalBallSpeedKph = incident.ballSpeedKph;

    if (!this.deps.isStandaloneReplayLoaded()) {
      r?.arena?.setCarTeam?.(this.goalScorerCarIndex, playerTeam);
    }

    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const goalTick = incident.goalIncidentTick > 0 ? incident.goalIncidentTick : currentTick;
    const postGoalTicks = Math.max(0, currentTick - goalTick);

    if (replayController.engine !== sim) {
      replayController.attach(sim, replayRingBuffer);
    }

    const extractedFrames = extractGoalReplayFrames({
      ringBuffer: replayRingBuffer,
      engine: null,
      goalIncidentTick: goalTick,
      scorerTouchTick: incident.lastTouchTick,
      lookbackSeconds: MAX_GOAL_LOOKBACK_SECONDS,
      touchLookbackSeconds: SCORER_TOUCH_LOOKBACK_SECONDS,
      postGoalTicks,
      lastKickoffWillStartTick: incident.lastKickoffStartTick,
    });

    if (!Array.isArray(extractedFrames) || extractedFrames.length === 0) {
      this.completeReplaySession();
      return;
    }

    const firstSnap = extractedFrames[0].snapshot;
    const ntState = getNameTagRuntimeState();
    const scorerName = this.goalScorerName || 'Player';
    const resolvedPlayerTeam: 0 | 1 = playerTeam === 1 ? 1 : 0;
    const capturedEntries = captureRuntimeReplayCarEntries(r, {
      frameBuffer: firstSnap,
      explicitEntries: ntState?.carEntries,
      defaultTeam: resolvedPlayerTeam,
    });
    const nextEntries: DirectorPreviewCarEntry[] = capturedEntries.map((c) =>
      c.carIndex === this.goalScorerCarIndex
        ? {
            ...c,
            name: c.name || scorerName,
            username: c.username || scorerName,
            team: this.deps.isStandaloneReplayLoaded() ? c.team : resolvedPlayerTeam,
          }
        : c
    );

    const totalFrames = replayController.beginReplaySession({
      scoringTeam: this.goalScoringTeam,
      scorerCarIndex: this.goalScorerCarIndex,
      carEntries: nextEntries,
      carTeamResolver: (carIdx: number) =>
        carIdx === this.goalScorerCarIndex
          ? playerTeam
          : (r?.arena?.carTeams?.[carIdx] ?? carIdx % 2),
      frames: extractedFrames,
    });

    this.isReplayActive = true;
    this.replayCameraMode = 'director';

    if (r?.match?.state) r.match.state.phase = 'replay';
    if (r?.keyboard) r.keyboard.ballControlEnabled = false;

    beginGoalReplaySession(r, replayController, {
      cameraMode: 'director',
      source: 'freeplay-goal-replay',
      syncHud: false,
    });

    applyReplayFrameToEngine(sim, firstSnap, r.interpolator, firstSnap, 1.0);
    applyDirectorReplayCamera(
      r.camera, r.interpolator, 0, this.goalScoringTeam, 0.016,
      this.goalScorerCarIndex, replayController.directorCameraState
    );

    setNameTagRuntimeState({ carEntries: nextEntries });
    replayController.sessionState.carEntries = nextEntries;

    this.bindReplayHudState(totalFrames);
  }

  public bindReplayHudState(totalFrames: number): void {
    const r = this.deps.getRuntime();
    const { replayController } = this.deps;

    hudStore.getState().setMatchState({
      matchPhase: 'replay',
      replayScorerName: this.goalScorerName,
      replayScorerTeam: this.goalScoringTeam,
      replayBallSpeedKph: this.goalBallSpeedKph,
      replayAssistName: null,
    });

    bindGoalReplayHudCallbacks({
      runtime: r,
      replayController,
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
  ): Promise<any> {
    const candidate = fileOrInput as { activeFrames?: unknown[] } | null;
    const parsed =
      candidate && typeof candidate === 'object' && Array.isArray(candidate.activeFrames)
        ? candidate
        : typeof fileOrInput === 'string'
          ? parseDirectorDiagnosticPatternText(fileOrInput, options.fileName)
          : await parseDirectorDiagnosticInput(fileOrInput as any, options.fileName);
    if (!parsed || !Array.isArray(parsed.activeFrames) || parsed.activeFrames.length === 0) {
      return null;
    }
    if (options.autoStartPreview !== false) {
      this.startPatternPreview(parsed, options);
    } else {
      this.deps.replayController.loadImportedDiagnosticPattern(parsed, options);
    }
    return parsed;
  }

  public startPatternPreview(
    parsedPattern: any = null,
    options: DirectorPatternPreviewOptions = {}
  ): boolean {
    const r = this.deps.getRuntime();
    if (!r) return false;
    const { replayController, replayRingBuffer } = this.deps;

    const appState = useAppStore.getState();
    if (appState.isOpen) appState.closeMenu();

    const activeCtrl = getActiveReplayTimelineController();

    if (r.match?.state && r.match.state.mode !== 'freeplay') {
      r.match.state.mode = 'freeplay';
      r.match.state.phase = 'playing';
      appState.setMatchMode?.('freeplay');
      r.modeManager?.setMode?.('freeplay');
    }

    if (this.deps.isStandaloneReplayActive()) {
      this.deps.pauseStandaloneReplay();
    }

    const sim = r.physics;
    if (sim && replayController.engine !== sim) {
      replayController.attach(sim, replayRingBuffer);
    }

    if (parsedPattern) {
      replayController.loadImportedDiagnosticPattern(parsedPattern, options);
    } else {
      const sourceCtrl = getLatestRetainedReplayTimelineController() || activeCtrl;
      if (
        sourceCtrl &&
        sourceCtrl !== replayController &&
        sourceCtrl.ActiveWindowCount > 0 &&
        ((sourceCtrl.sessionState?.retainedReplaySeq || 0) > (replayController.sessionState.retainedReplaySeq || 0) ||
          replayController.ActiveWindowCount <= 0)
      ) {
        replayController.copyRetainedReplayFrom(sourceCtrl);
      }
    }

    const totalFrames = replayController.ActiveWindowCount;
    if (totalFrames <= 0) return false;

    const firstSnap = replayController.getFrameBufferByIndex(0);
    const numCars = Math.min(MAX_CARS, Math.max(1, Math.round(firstSnap?.[SIM_OFFSETS.NUM_CARS] || 1)));

    if (!this.savedPrePreviewCar0) {
      this.savedPrePreviewCar0 = captureRuntimeReplayCarEntries(r, { numCars: 1 })[0] || null;
    }

    const importedEntries =
      replayController.sessionState.importedCarEntries &&
      replayController.sessionState.importedCarEntries.length > 0
        ? replayController.sessionState.importedCarEntries
        : replayController.sessionState.carEntries;
    const effectiveCarEntries: DirectorPreviewCarEntry[] = applyReplayCarEntriesToRuntime(
      r,
      importedEntries,
      numCars,
      firstSnap
    );
    this.previewSpawnedExtraCars = true;

    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: numCars > 1,
      carEntries: effectiveCarEntries,
    });
    replayController.sessionState.carEntries = effectiveCarEntries;

    this.goalScoringTeam = replayController.sessionState.scoringTeam ?? 0;
    this.goalScorerCarIndex = replayController.sessionState.scorerCarIndex ?? 0;
    const scorerEntry = effectiveCarEntries.find((e) => e.carIndex === this.goalScorerCarIndex);
    this.goalScorerName = replayController.sessionState.isImportedPreview
      ? scorerEntry?.name || scorerEntry?.username || 'RCGR Preview'
      : this.goalScorerName || scorerEntry?.name || 'Player';
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
    r.acquireGoalReplayCameraOverride('freeplay-goal-replay');
    r.ballTrajectoryPredictor?.acquireTemporarySuppression?.('freeplay-goal-replay');

    const curSnap =
      replayController.getFrameBufferByIndex(replayController.sessionState.currentFrameIndex) || firstSnap;
    if (curSnap && sim) {
      applyReplayFrameToEngine(sim, curSnap, r.interpolator, curSnap, 1.0);
    }
    applyDirectorReplayCamera(
      r.camera, r.interpolator, replayController.progress, this.goalScoringTeam,
      0.016, this.goalScorerCarIndex, replayController.directorCameraState
    );

    this.bindReplayHudState(totalFrames);
    return true;
  }

  public enterReferenceFreeCamFromHere(options: ReferenceFreeCamOptions = {}): boolean {
    const r = this.deps.getRuntime();
    if (!r) return false;
    const { replayController } = this.deps;

    const activeCtrl = getActiveReplayTimelineController() || replayController;
    const savedCursorFloat =
      activeCtrl?.sessionState?.cursorFloat ?? replayController?.sessionState?.cursorFloat ?? 0;

    if (!this.isReplayActive || !replayController.sessionState.isActive) {
      const started = this.startPatternPreview(null, { startPaused: true, restart: false });
      if (!started) return false;
      replayController.seekToIndex(savedCursorFloat, r.interpolator);
    }

    replayController.setPaused(true);
    hudStore.getState().setReplayState({
      replayPaused: true,
      replayPersistent: true,
      replayProgress: replayController.progress,
      replayFrameIndex: replayController.sessionState.currentFrameIndex,
    });

    const snap = replayController.getCurrentFrameDiagnosticSnapshot();
    const eyeThreeJs = snap?.cameraPose?.dampedEyeThreeJs || [0, 420, -3600];
    const targetThreeJs = snap?.cameraPose?.dampedTargetThreeJs || [0, 120, 0];

    const currentSharedFov =
      Number(r.camera?.getDirectorFov?.()) ||
      Number(r.camera?.getFreeCamFov?.()) ||
      Number(useAppStore.getState().freeCamFov) ||
      DEFAULT_REPLAY_DIRECTOR_FOV_DEG;
    const desiredFov = Number(options.fov) || currentSharedFov;

    if (r.camera) {
      r.camera.setFreeCamFov?.(desiredFov);
      r.camera.setFreeCamPose?.(eyeThreeJs, targetThreeJs);
    }
    useAppStore.setState({ isFreeCam: true, freeCamFov: desiredFov });
    return true;
  }

  public exitReferenceFreeCam(): boolean {
    const r = this.deps.getRuntime();
    const { replayController } = this.deps;
    useAppStore.getState().setFreeCam(false);
    if (this.isReplayActive && replayController.sessionState.isActive && r) {
      r.acquireGoalReplayCameraOverride();
      replayController.refreshCurrentFrameDirectorPose();
      applyDirectorReplayCamera(
        r.camera, r.interpolator, replayController.progress, this.goalScoringTeam,
        0.016, this.goalScorerCarIndex, replayController.directorCameraState
      );
    }
    return true;
  }

  public exitPatternPreview(): boolean {
    if (!this.isReplayActive && !this.deps.replayController?.sessionState?.isActive) return false;
    if (useAppStore.getState().isFreeCam) {
      useAppStore.getState().setFreeCam(false);
    }
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
      if (this.savedPrePreviewCar0 && r) {
        applyReplayCarEntriesToRuntime(r, [this.savedPrePreviewCar0], 1);
      } else {
        if (r?.physics) {
          while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
            r.physics.removeCar(r.physics.numCars - 1);
          }
        }
        if (r?.arena?.cars) {
          for (let i = 1; i < r.arena.cars.length; i++) {
            if (r.arena.cars[i]) r.arena.cars[i].visible = false;
          }
        }
      }
      setNameTagRuntimeState({ isMultiplayerOrMultiCarMode: false });
      this.previewSpawnedExtraCars = false;
      this.savedPrePreviewCar0 = null;
    }

    if (r) {
      if (r.keyboard) {
        r.keyboard.ballControlEnabled =
          !this.deps.isNameTagTunerActive() && !this.deps.isStandaloneReplayLoaded();
      }
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

    this.deps.onReplaySessionCompleted();
  }

  public step(context: DirectorPreviewStepContext, isUnlimitedBoost: boolean): boolean {
    const r = this.deps.getRuntime();
    const { replayController } = this.deps;

    const isNetworkReplayPhase = Boolean(
      r?.match?.state?.phase === 'replay' && r?.networkReconciler
    );
    if (isNetworkReplayPhase && !this.isReplayActive) {
      stepNetworkStreamedGoalReplayFrame({
        runtime: r,
        replayController,
        context,
        isUnlimitedBoost,
        getCameraMode: () => this.replayCameraMode || 'director',
        setCameraMode: (nextMode) => {
          this.replayCameraMode = nextMode;
        },
        getScoringTeam: () => this.goalScoringTeam ?? 0,
        setScoringTeam: (team) => {
          this.goalScoringTeam = team;
        },
        getScorerCarIndex: () => this.goalScorerCarIndex ?? 0,
        setScorerCarIndex: (carIndex) => {
          this.goalScorerCarIndex = carIndex;
        },
      });
      return true;
    }

    if (this.isReplayActive && replayController.sessionState.isActive) {
      const dt = context.dt ?? 0.016;
      const stepRes = stepGoalReplaySessionFrame({
        runtime: r,
        replayController,
        context,
        dt,
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

      if (
        stepRes.isFinished &&
        !replayController.sessionState.isPaused &&
        !replayController.sessionState.isPersistent
      ) {
        this.completeReplaySession();
      }
      return true;
    }

    if (this.isReplayActive && !replayController.sessionState.isActive) {
      this.completeReplaySession();
    } else if (r?.isGoalReplayCameraOverrideActive?.()) {
      r.releaseGoalReplayCameraOverride();
      r.camera?.resetView?.();
    }

    return false;
  }
}
