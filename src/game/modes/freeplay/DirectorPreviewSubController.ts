/**
 * DirectorPreviewSubController.ts
 * Stateful sub-controller for FreeplayMode handling Goal Replay session lifecycle,
 * HUD replay callback bindings, imported RCGR diagnostic pattern preview orchestration,
 * and Reference FreeCam switching.
 */

import { SIM_OFFSETS, MAX_CARS } from '../../../physics/RocketSimConstants.ts';
import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.ts';
import {
  parseDirectorDiagnosticPatternText,
  parseDirectorDiagnosticInput,
} from '../../../replay/ReplayDirectorPatternParser.ts';
import type { ImportedDiagnosticPatternInput } from '../../../replay/ReplayDirectorStatePipeline.ts';
import type { ReplayRingBuffer } from '../../../replay/ReplayRingBuffer.ts';
import type { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
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
  applyReplayControllerFrameAndDirectorCamera,
  beginGoalReplaySession,
  bindGoalReplayHudCallbacks,
  endGoalReplaySession,
  pauseReplayAndEnterReferenceFreeCam,
  stepGoalReplaySessionFrame,
  stepNetworkStreamedGoalReplayFrame,
  syncAndAttachReplayTimelineController,
  type GoalReplayRuntimePort,
} from '../shared/GoalReplaySessionCoordinator.ts';
import type { GoalReplayCarStateViewLike } from '../shared/goalReplayHudPipeline.ts';

const MAX_GOAL_LOOKBACK_SECONDS = 10.0;
const SCORER_TOUCH_LOOKBACK_SECONDS = 7.0;

export type ReplayCameraMode = 'director' | 'pov';

export interface DirectorPreviewCarEntry {
  carIndex: number;
  name: string;
  username: string;
  team: number;
  isBot: boolean;
  isLocalPlayer: boolean;
}
export interface DirectorPatternPreviewOptions {
  fileName?: string;
  autoStartPreview?: boolean;
  startPaused?: boolean;
  restart?: boolean;
}
export interface ReferenceFreeCamOptions { fov?: number; }
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
  playerCarView?: GoalReplayCarStateViewLike | null;
  isSupersonic?: boolean;
  curBoost?: number;
}

export interface DirectorPreviewRuntimePort extends GoalReplayRuntimePort {
  physics?: (NonNullable<GoalReplayRuntimePort['physics']> & {
    numCars: number;
    getBallStateView?: () => { posY: number } | null;
    getHeaderView?: () => { tickCount: number } | null;
    removeCar?: (carIndex: number) => void;
    addCar?: (team: number, preset: string) => number | void;
  }) | null;
  arena?: (NonNullable<GoalReplayRuntimePort['arena']> & {
    carTeams?: ArrayLike<number>;
    carVisual?: string;
    cars?: Array<{ visible: boolean } | null | undefined>;
    setCarTeam?: (carIndex: number, team: number) => void;
    ensureCar?: (carIndex: number, team: number, preset: string) => void;
  }) | null;
  camera?: (NonNullable<GoalReplayRuntimePort['camera']> & {
    getFreeCamStateSnapshot?: () => object | null;
  }) | null;
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
    this.registerPreviewHandlers();
    syncAndAttachReplayTimelineController(replayController, r?.physics, replayRingBuffer, true);
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
    syncAndAttachReplayTimelineController(replayController, sim, replayRingBuffer, false);

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

    const totalFrames = replayController.beginReplaySession({
      scoringTeam: this.goalScoringTeam,
      scorerCarIndex: this.goalScorerCarIndex,
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
      scoringTeam: this.goalScoringTeam,
      scorerCarIndex: this.goalScorerCarIndex,
      initialSnapshot: extractedFrames[0].snapshot,
    });

    const ntState = getNameTagRuntimeState();
    const scorerName = this.goalScorerName || 'Player';
    const resolvedPlayerTeam = playerTeam === 1 ? 1 : 0;
    const nextEntries: DirectorPreviewCarEntry[] =
      !Array.isArray(ntState.carEntries) || ntState.carEntries.length === 0
        ? [{
            carIndex: this.goalScorerCarIndex,
            name: scorerName,
            username: scorerName,
            team: resolvedPlayerTeam,
            isBot: false,
            isLocalPlayer: true,
          }]
        : this.deps.isStandaloneReplayLoaded()
          ? (ntState.carEntries as DirectorPreviewCarEntry[]).map((c) => ({ ...c }))
          : (ntState.carEntries as DirectorPreviewCarEntry[]).map((c) =>
              c.carIndex === this.goalScorerCarIndex ? { ...c, team: resolvedPlayerTeam } : { ...c }
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
  ): Promise<ImportedDiagnosticPatternInput | null> {
    const candidate = fileOrInput as ImportedDiagnosticPatternInput | null;
    const parsed =
      candidate && typeof candidate === 'object' && Array.isArray(candidate.activeFrames)
        ? candidate
        : typeof fileOrInput === 'string'
          ? parseDirectorDiagnosticPatternText(fileOrInput, options.fileName)
          : await parseDirectorDiagnosticInput(
              fileOrInput as File | Blob | ArrayBuffer | Uint8Array | string | ImportedDiagnosticPatternInput,
              options.fileName
            );
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

    const sim = r.physics;
    syncAndAttachReplayTimelineController(replayController, sim, replayRingBuffer, !parsedPattern);
    if (parsedPattern) replayController.loadImportedDiagnosticPattern(parsedPattern, options);

    const totalFrames = replayController.ActiveWindowCount;
    if (totalFrames <= 0) return false;

    const firstSnap = replayController.getFrameBufferByIndex(0);
    const numCars = Math.min(MAX_CARS, Math.max(1, Math.round(firstSnap?.[SIM_OFFSETS.NUM_CARS] || 1)));
    const sState = replayController.sessionState;
    const importedEntries = (sState.importedCarEntries || sState.carEntries) as
      | Array<Partial<Omit<DirectorPreviewCarEntry, 'team'>> & { team?: number | string }>
      | undefined;
    const effectiveCarEntries: DirectorPreviewCarEntry[] =
      Array.isArray(importedEntries) && importedEntries.length > 0
        ? importedEntries.map((c, idx) => {
            const label = c.name || c.username || `Car ${idx}`;
            const teamNum = c.team === 'orange' || c.team === 1 ? 1 : c.team === 'blue' || c.team === 0 ? 0 : idx % 2 === 0 ? 0 : 1;
            return {
              carIndex: typeof c.carIndex === 'number' ? c.carIndex : idx,
              name: label,
              username: label,
              team: teamNum,
              isBot: Boolean(c.isBot),
              isLocalPlayer: idx === (r.playerCarIndex ?? 0),
            };
          })
        : Array.from({ length: numCars }, (_, idx) => {
            const label = idx === 0 ? 'Player' : `Bot ${idx}`;
            return { carIndex: idx, name: label, username: label, team: idx % 2 === 0 ? 0 : 1, isBot: idx > 0, isLocalPlayer: idx === 0 };
          });

    if (numCars > 1) {
      if (sim) {
        while (sim.numCars > numCars && typeof sim.removeCar === 'function') {
          sim.removeCar(sim.numCars - 1);
        }
        while (sim.numCars < numCars && typeof sim.addCar === 'function') {
          const cIdx = sim.numCars;
          const entry = effectiveCarEntries.find((e) => e.carIndex === cIdx);
          sim.addCar(entry ? entry.team : cIdx % 2, 'octane');
        }
      }
      if (r.arena) {
        for (let cIdx = 0; cIdx < numCars; cIdx++) {
          const entry = effectiveCarEntries.find((e) => e.carIndex === cIdx);
          r.arena.ensureCar?.(cIdx, entry ? entry.team : cIdx % 2, r.arena.carVisual || 'fennec');
        }
      }
      this.previewSpawnedExtraCars = true;
    }

    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: numCars > 1,
      carEntries: effectiveCarEntries,
    });
    sState.carEntries = effectiveCarEntries;

    this.goalScoringTeam = sState.scoringTeam ?? 0;
    this.goalScorerCarIndex = sState.scorerCarIndex ?? 0;
    const scorerEntry = effectiveCarEntries.find((e) => e.carIndex === this.goalScorerCarIndex);
    this.goalScorerName = sState.isImportedPreview
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

  public enterReferenceFreeCamFromHere(options: ReferenceFreeCamOptions = {}): boolean {
    const r = this.deps.getRuntime();
    if (!r) return false;
    const { replayController } = this.deps;
    const activeCtrl = getActiveReplayTimelineController() || replayController;
    const savedCursorFloat =
      activeCtrl?.sessionState?.cursorFloat ?? replayController.sessionState.cursorFloat ?? 0;

    let seekCursorFloat: number | null = null;
    if (!this.isReplayActive || !replayController.sessionState.isActive) {
      if (!this.startPatternPreview(null, { startPaused: true, restart: false })) return false;
      seekCursorFloat = savedCursorFloat;
    }
    return pauseReplayAndEnterReferenceFreeCam(r, replayController, {
      seekCursorFloat,
      fov: options.fov,
    });
  }

  public exitReferenceFreeCam(): boolean {
    const r = this.deps.getRuntime();
    const { replayController } = this.deps;
    useAppStore.getState().setFreeCam(false);
    if (this.isReplayActive && replayController.sessionState.isActive && r) {
      r.acquireGoalReplayCameraOverride?.();
      applyReplayControllerFrameAndDirectorCamera(
        r,
        replayController,
        this.goalScoringTeam,
        this.goalScorerCarIndex,
        { snapshot: null, refreshDirectorPose: true }
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
      if (r?.physics) {
        while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
          r.physics.removeCar(r.physics.numCars - 1);
        }
      }
      if (r?.arena?.cars) {
        for (let i = 1; i < r.arena.cars.length; i++) {
          if (r.arena.cars[i]) r.arena.cars[i]!.visible = false;
        }
      }
      setNameTagRuntimeState({ isMultiplayerOrMultiCarMode: false });
      this.previewSpawnedExtraCars = false;
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

    if (r?.match?.state?.phase === 'replay' && r?.networkReconciler && !this.isReplayActive) {
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
      if (stepRes.isFinished && !sState.isPaused && !sState.isPersistent) {
        this.completeReplaySession();
      }
      return true;
    }

    if (this.isReplayActive && !sState.isActive) {
      this.completeReplaySession();
    } else if (r?.isGoalReplayCameraOverrideActive?.()) {
      r.releaseGoalReplayCameraOverride?.();
      r.camera?.resetView?.();
    }
    return false;
  }
}
