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
import type { DirectorPreviewSubController } from './DirectorPreviewSubController.ts';

export const POST_GOAL_CELEBRATION_TICKS = 150; // 1.25s @ 120Hz before Goal Replay

export interface FreeplayGoalAndTouchSubControllerDeps {
  getRuntime: () => Record<string, any> | null;
  replayRingBuffer: ReplayRingBuffer;
  directorPreview: DirectorPreviewSubController;
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
    if (this.goalResetTicks > 0) {
      return this.goalResetTicks;
    }
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
          acknowledgedControls.push({
            carIndex: c,
            controls: { ...(r.playerControls || r.neutralControls) },
          });
        } else {
          const base = c * 8;
          acknowledgedControls.push({
            carIndex: c,
            controls: {
              throttle: view[base + 0] || 0,
              steer: view[base + 1] || 0,
              pitch: view[base + 2] || 0,
              yaw: view[base + 3] || 0,
              roll: view[base + 4] || 0,
              jump: view[base + 5] >= 0.5,
              boost: view[base + 6] >= 0.5,
              handbrake: view[base + 7] >= 0.5,
            },
          });
        }
      }
    } else {
      acknowledgedControls.push({
        carIndex: r.playerCarIndex ?? 0,
        controls: { ...(r.playerControls || r.neutralControls) },
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
      sim,
      goalResetTicks: this.goalResetTicks,
      currentTick,
      goalIncidentTick: this.goalIncidentTick,
      frozenBallState: this.frozenGoalBallState,
    });

    // 4. Advance post-goal celebration countdown -> transition to Goal Replay
    if (this.goalResetTicks > 0) {
      this.goalResetTicks--;
      if (this.goalResetTicks <= 0) {
        this.deps.onBeginGoalReplay();
      }
      return;
    }

    // 5. Check Goal Scored
    const isOnlineLobby = Boolean(
      r.arena?.isLobbyMode || r.networkReconciler?.lobbyDualWorldMode
    );
    if (r.trainingOptions?.disableGoalReset || isOnlineLobby) {
      if (isOnlineLobby && !r.authoritativeServer && r.networkReconciler?.lobbyDualWorldMode) {
        if (evaluateGoalScoredFromBallView(sim, bView).scored) {
          sim.resetGoalLatch?.();
          sim.setBallState?.(
            new Float32Array([0, 0, 93, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])
          );
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
        type: INCIDENT_EVENT_TYPES.GOAL_SCORED,
        tick: currentTick,
        carIndex: dp.goalScorerCarIndex,
        team: scoringTeam,
        posX: bView.posX,
        posY: bView.posY,
        posZ: bView.posZ,
        intensity: ballSpeedUu,
      });
      this.deps.replayRingBuffer.appendSignal(currentTick, {
        signalType: MATCH_SIGNALS.SCORE_UPDATED,
        frameId: currentTick,
        param1: scoringTeam === 0 ? 1 : 0,
        param2: scoringTeam === 1 ? 1 : 0,
      });
      this.deps.replayRingBuffer.appendAudioEvent(currentTick, {
        cueName: 'sfx_goal_poof',
        volume: 1.0,
      });

      const audio = r?.audioSubsystem?.audio || r?.audio;
      audio?.play?.('sfx_goal_poof', 1.0);

      this.goalResetTicks = POST_GOAL_CELEBRATION_TICKS;
      syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
        matchPhase: 'goal',
        localTeam: playerTeam,
        replayScorerName: dp.goalScorerName,
        replayScorerTeam: scoringTeam,
        replayScorerAnthemId: null,
        replayBallSpeedKph: ballSpeedKph,
        replayAssistName: null,
      });
    }
  }
}
