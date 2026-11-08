import {
  INCIDENT_EVENT_TYPES,
  MATCH_SIGNALS,
  MAX_CARS,
} from '../../../physics/RocketSimConstants.ts';
import type { ReplayRingBuffer } from '../../../replay/ReplayRingBuffer.ts';
import { getNameTagRuntimeState } from '../../runtimeUiPort.ts';
import {
  detectSingleCarBallTouch,
  evaluateGoalScoredFromBallView,
  stepPostGoalBallFreeze,
} from '../shared/goalAndBallTouchPipeline.ts';
import { syncLocalMatchStateToRuntimeAndHud } from '../shared/matchClockAndPhasePipeline.ts';
import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.ts';
import {
  captureRuntimeReplayCarEntries,
  type NormalizedReplayDirectorCarEntry,
  type ReplayCarEntryRuntimePort,
} from '../../../replay/replayDirectorCarRosterPipeline.ts';
import type { GoalReplayRuntimePort } from '../shared/GoalReplaySessionCoordinator.ts';

export interface FreeplayGoalMetadataTargetPort {
  goalScoringTeam: number; goalScorerCarIndex: number; goalScorerName: string;
  goalBallSpeedKph: number | null; previewSpawnedExtraCars: boolean;
  resetGoalMetadata(scoringTeam?: number): void; exitPatternPreview(): boolean;
}

export const POST_GOAL_CELEBRATION_TICKS = 150; // 1.25s @ 120Hz before Goal Replay

export interface FreeplayGoalAndTouchSubControllerDeps {
  getRuntime: () => Record<string, any> | null;
  replayRingBuffer: ReplayRingBuffer;
  directorPreview: FreeplayGoalMetadataTargetPort;
  resolveEffectivePlayerTeam: () => 0 | 1;
  isStandaloneReplayLoaded: () => boolean;
  onAfterFrameRecorded?: () => void;
  onBeginGoalReplay: () => void;
}

/**
 * Stateful SubController owning Freeplay's ball touch tracking, post-goal ball freeze,
 * 448-float ring-buffer snapshot recording, goal-scored evaluation, and 150-tick celebration timer.
 */
export class FreeplayGoalAndTouchSubController {
  private readonly deps: FreeplayGoalAndTouchSubControllerDeps;
  public goalResetTicks = 0;
  public lastKickoffStartTick = 0;
  public lastTouchTick = -1;
  public goalIncidentTick = -1;
  public frozenGoalBallState: Float32Array | null = null;
  public prevBallVelX = 0;
  public prevBallVelY = 0;
  public prevBallVelZ = 0;

  constructor(deps: FreeplayGoalAndTouchSubControllerDeps) {
    this.deps = deps;
  }

  public getEffectiveGoalResetTicks(): number {
    if (this.goalResetTicks > 0) return this.goalResetTicks;
    const r = this.deps.getRuntime();
    if (r?.match?.state?.phase === 'goal' && (r?.authoritativeServer || r?.networkReconciler)) {
      return r?.authoritativeServer?.fallbackManager?.domain?.goalBufferTicks ?? 1;
    }
    return 0;
  }

  public resetPlayTouchAndGoalState(defaultTeam: 0 | 1): void {
    this.lastTouchTick = -1;
    this.goalIncidentTick = -1;
    this.deps.directorPreview?.resetGoalMetadata(defaultTeam);
    this.frozenGoalBallState = null;
    this.prevBallVelX = 0;
    this.prevBallVelY = 0;
    this.prevBallVelZ = 0;
  }

  public recordIncidentEvent(eventTick: number, event: Record<string, any>): void {
    this.deps.replayRingBuffer?.appendIncident(eventTick, event);
    if (event.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT || event.type === 0x01) {
      if (this.goalIncidentTick < 0 || eventTick <= this.goalIncidentTick) {
        this.lastTouchTick = Math.floor(eventTick);
      }
    }
  }

  public stepAfterPhysicsTick(): void {
    const r = this.deps.getRuntime();
    const sim = r?.physics;
    if (!r || !sim) return;

    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const bView = sim.getBallStateView();
    const cv = sim.getCarStateView(r.playerCarIndex ?? 0);

    // 1. Proximity + impulse touch detection during live play
    if (this.goalResetTicks === 0 && detectSingleCarBallTouch(bView, cv, this)) {
      this.lastTouchTick = currentTick;
    }

    // 2. Record 448-float compact snapshot + active cars' controls into ring buffer
    const numActiveCars = Math.min(MAX_CARS, Math.max(1, sim.numCars || 1));
    const acknowledgedControls: Array<{ carIndex: number; controls: Record<string, any> }> = [];
    if (numActiveCars > 1 && sim.controlsView) {
      const view = sim.controlsView;
      for (let c = 0; c < numActiveCars; c++) {
        if (c === (r.playerCarIndex ?? 0)) {
          acknowledgedControls.push({ carIndex: c, controls: { ...(r.playerControls || r.neutralControls) } });
        } else {
          const base = c * 8;
          acknowledgedControls.push({
            carIndex: c,
            controls: {
              throttle: view[base + 0] || 0, steer: view[base + 1] || 0, pitch: view[base + 2] || 0,
              yaw: view[base + 3] || 0, roll: view[base + 4] || 0, jump: view[base + 5] >= 0.5,
              boost: view[base + 6] >= 0.5, handbrake: view[base + 7] >= 0.5,
            },
          });
        }
      }
    } else {
      acknowledgedControls.push({
        carIndex: r.playerCarIndex ?? 0, controls: { ...(r.playerControls || r.neutralControls) },
      });
    }
    this.deps.replayRingBuffer.recordFrame(currentTick, sim.state, acknowledgedControls);
    this.deps.onAfterFrameRecorded?.();

    // When Loopback AuthoritativeServerHost or PredictionReconciler is attached,
    // goal detection, 150-tick celebration, and Goal Replay are driven by server signals.
    if (r.authoritativeServer || r.networkReconciler) {
      sim.pollGoal?.();
      return;
    }

    // 3. Post-goal 30-frame ball flight & freeze inside goal net (offline fallback only)
    this.frozenGoalBallState = stepPostGoalBallFreeze({
      sim, goalResetTicks: this.goalResetTicks, currentTick,
      goalIncidentTick: this.goalIncidentTick, frozenBallState: this.frozenGoalBallState,
    });

    // 4. Advance post-goal celebration countdown -> transition to Goal Replay
    if (this.goalResetTicks > 0) {
      this.goalResetTicks--;
      if (this.goalResetTicks <= 0) this.deps.onBeginGoalReplay();
      return;
    }

    // 5. Check Goal Scored
    const isOnlineLobby = Boolean(r.arena?.isLobbyMode || r.networkReconciler?.lobbyDualWorldMode);
    if (r.trainingOptions?.disableGoalReset || isOnlineLobby) {
      if (isOnlineLobby && !r.authoritativeServer && r.networkReconciler?.lobbyDualWorldMode) {
        if (evaluateGoalScoredFromBallView(sim, bView).scored) {
          sim.resetGoalLatch?.();
          sim.setBallState?.(new Float32Array([0, 0, 93, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        }
      } else {
        sim.resetGoalLatch?.();
      }
      return;
    }

    const goalEval = evaluateGoalScoredFromBallView(sim, bView);
    if (goalEval.scored && bView) {
      const playerTeam = this.deps.resolveEffectivePlayerTeam();
      const scoringTeam: 0 | 1 = bView.posY >= 0 ? 0 : 1;
      const { ballSpeedUu, ballSpeedKph } = goalEval;

      this.goalIncidentTick = currentTick;
      const dp = this.deps.directorPreview;
      dp.goalScoringTeam = scoringTeam;
      dp.goalScorerCarIndex = r.playerCarIndex ?? 0;
      if (!this.deps.isStandaloneReplayLoaded()) {
        r?.arena?.setCarTeam?.(dp.goalScorerCarIndex, playerTeam);
      }
      const ntEntries = getNameTagRuntimeState()?.carEntries;
      const scorerEntry = Array.isArray(ntEntries)
        ? ntEntries.find((e: any) => e.carIndex === dp.goalScorerCarIndex)
        : null;
      dp.goalScorerName = scorerEntry?.name || scorerEntry?.username || 'Player';
      dp.goalBallSpeedKph = ballSpeedKph;
      this.frozenGoalBallState = null;

      this.deps.replayRingBuffer.appendIncident(currentTick, {
        type: INCIDENT_EVENT_TYPES.GOAL_SCORED, tick: currentTick, carIndex: dp.goalScorerCarIndex,
        team: scoringTeam, posX: bView.posX, posY: bView.posY, posZ: bView.posZ, intensity: ballSpeedUu,
      });
      this.deps.replayRingBuffer.appendSignal(currentTick, {
        signalType: MATCH_SIGNALS.SCORE_UPDATED, frameId: currentTick,
        param1: scoringTeam === 0 ? 1 : 0, param2: scoringTeam === 1 ? 1 : 0,
      });
      this.deps.replayRingBuffer.appendAudioEvent(currentTick, { cueName: 'sfx_goal_poof', volume: 1.0 });

      const audio = r?.audioSubsystem?.audio || r?.audio;
      audio?.play?.('sfx_goal_poof', 1.0);

      this.goalResetTicks = POST_GOAL_CELEBRATION_TICKS;
      syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
        matchPhase: 'goal', localTeam: playerTeam, replayScorerName: dp.goalScorerName,
        replayScorerTeam: scoringTeam, replayScorerAnthemId: null,
        replayBallSpeedKph: ballSpeedKph, replayAssistName: null,
      });
    }
  }

  public resetExtraCarsAndArenaToSingleCar(): void {
    const r = this.deps.getRuntime();
    if (r?.physics) {
      while (r.physics.numCars > 1 && typeof r.physics.removeCar === 'function') {
        r.physics.removeCar(r.physics.numCars - 1);
      }
    }
    if (r?.arena?.cars) {
      if (r.arena.cars[0]) r.arena.cars[0].visible = true;
      for (let i = 1; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) r.arena.cars[i].visible = false;
        r.arena.resetCarBoosts?.(i);
        r.arena.carDemolitions?.[i]?.stop?.();
        r.arena.supersonicWheelTrailSystem?.resetCar?.(i);
      }
      r.arena.lighting?.updateSunIntensities?.(1);
    }
    r?.audioSubsystem?.resetAudio?.();
  }

  public syncAuthoritativeServerKickoffState(): void {
    const r = this.deps.getRuntime();
    if (!r?.authoritativeServer || !r?.physics) return;
    const snap = r.physics.saveCompactState();
    const curTick = Math.floor(r.physics.getHeaderView?.()?.tickCount ?? 0);
    r.authoritativeServer.startTrainingMode?.({
      unlimitedBoost: Boolean(r.physics.isUnlimitedBoost),
      disableGoalReset: Boolean(r.trainingOptions?.disableGoalReset),
      goalReplayEnabled: true, fifoDurationSeconds: 60,
      initialState: Array.from(snap), resetKickoff: false,
    });
    void r.authoritativeServer.sim?.restoreState?.(snap);
    r.authoritativeServer.clientInputBuffer?.clear?.();
    r.authoritativeServer.lastReceivedControls?.clear?.();
    r.networkReconciler?.syncTimeline?.(snap, curTick);
  }

  public applyCleanFreeplayReset(options: {
    standaloneReplayViewer?: { hasLoadedReplay?: boolean; isActive?: boolean; clearReplay(): void } | null;
    isGoalReplayActive: boolean;
    replayController?: { sessionState?: { isActive?: boolean } } | null;
    nameTagTunerController?: { isActive?: boolean; exitTunerArena(): void } | null;
    rewinderController?: { isBlockingLivePhysics?: boolean; rewinderFrames?: unknown[]; clearBuffer(): void } | null;
  }): void {
    const { standaloneReplayViewer, isGoalReplayActive, replayController, nameTagTunerController, rewinderController } = options;
    if (standaloneReplayViewer?.hasLoadedReplay || standaloneReplayViewer?.isActive) {
      standaloneReplayViewer.clearReplay();
    }
    if (isGoalReplayActive || replayController?.sessionState?.isActive) {
      this.deps.directorPreview.exitPatternPreview();
    }
    if (nameTagTunerController?.isActive) nameTagTunerController.exitTunerArena();
    if (
      rewinderController &&
      (rewinderController.isBlockingLivePhysics || (rewinderController.rewinderFrames?.length ?? 0) > 0)
    ) {
      rewinderController.clearBuffer();
    }
    this.resetExtraCarsAndArenaToSingleCar();
    this.deps.directorPreview.previewSpawnedExtraCars = false;
  }

  public tryApplyStandaloneViewerKickoffReset(
    standaloneReplayViewer: {
      hasLoadedReplay?: boolean; isActive?: boolean; frames: unknown[];
      takeoverSubController: { targetFrame?: number; cursor?: number };
      _handoffToLiveFreeplay(idx: number): void; _applyFrameAtCursor(a: boolean, b: boolean): void;
    } | null | undefined,
    onResetPresentation: () => void
  ): boolean {
    if (!standaloneReplayViewer?.hasLoadedReplay) return false;
    const takeover = standaloneReplayViewer.takeoverSubController;
    const targetIdx = Math.max(
      0,
      Math.min(standaloneReplayViewer.frames.length - 1, Math.round(takeover.targetFrame || takeover.cursor || 0))
    );
    if (!standaloneReplayViewer.isActive) {
      standaloneReplayViewer._handoffToLiveFreeplay(targetIdx);
    } else {
      standaloneReplayViewer._applyFrameAtCursor(false, false);
    }
    onResetPresentation();
    return true;
  }
}

export function prepareFreeplayGoalReplaySessionData(params: {
  runtime: GoalReplayRuntimePort | null | undefined;
  ringBuffer: ReplayRingBuffer;
  playerTeam: number;
  isStandaloneReplayLoaded: boolean;
  explicitCarEntries?: unknown[] | null;
  incident: {
    goalIncidentTick: number; lastTouchTick: number; lastKickoffStartTick: number;
    scoringTeam?: number; scorerCarIndex: number; scorerName: string; ballSpeedKph: number | null;
  };
  currentTick: number;
  ballPosY?: number;
}): {
  scoringTeam: number; scorerCarIndex: number; scorerName: string; ballSpeedKph: number | null;
  extractedFrames: ReturnType<typeof extractGoalReplayFrames>;
  carEntries: NormalizedReplayDirectorCarEntry[];
} | null {
  const { runtime, ringBuffer, playerTeam, isStandaloneReplayLoaded, explicitCarEntries, incident, currentTick, ballPosY } = params;
  const scoringTeam =
    incident.scoringTeam === 0 || incident.scoringTeam === 1
      ? incident.scoringTeam
      : typeof ballPosY === 'number' && Math.abs(ballPosY) > 100
        ? (ballPosY >= 0 ? 0 : 1)
        : playerTeam;
  const scorerCarIndex = incident.scorerCarIndex;
  const scorerName = incident.scorerName || 'Player';
  const goalTick = incident.goalIncidentTick > 0 ? incident.goalIncidentTick : currentTick;
  const extractedFrames = extractGoalReplayFrames({
    ringBuffer, engine: null, goalIncidentTick: goalTick, scorerTouchTick: incident.lastTouchTick,
    lookbackSeconds: 10.0, touchLookbackSeconds: 7.0, postGoalTicks: Math.max(0, currentTick - goalTick),
    lastKickoffWillStartTick: incident.lastKickoffStartTick,
  });
  if (!Array.isArray(extractedFrames) || extractedFrames.length === 0) return null;

  const resolvedPlayerTeam: 0 | 1 = playerTeam === 1 ? 1 : 0;
  const capturedEntries = captureRuntimeReplayCarEntries(runtime as unknown as ReplayCarEntryRuntimePort, {
    frameBuffer: extractedFrames[0].snapshot,
    explicitEntries: (explicitCarEntries as NormalizedReplayDirectorCarEntry[] | undefined) ?? undefined,
    defaultTeam: resolvedPlayerTeam,
  });
  const carEntries = capturedEntries.map((c) =>
    c.carIndex === scorerCarIndex
      ? {
          ...c, name: c.name || scorerName, username: c.username || scorerName,
          team: isStandaloneReplayLoaded ? c.team : resolvedPlayerTeam,
        }
      : c
  );
  return { scoringTeam, scorerCarIndex, scorerName, ballSpeedKph: incident.ballSpeedKph, extractedFrames, carEntries };
}
