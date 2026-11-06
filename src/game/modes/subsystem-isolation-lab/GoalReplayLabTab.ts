import { MATCH_SIGNALS } from '../../../physics/RocketSimConstants.ts';
import { REPLAY_BUFFER_MODES, ReplayRingBuffer } from '../../../replay/ReplayRingBuffer.ts';
import { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import { extractGoalReplayFrames, resolveGoalReplayWindowBounds } from '../../../replay/ReplayPlaybackState.ts';
import { useSubsystemIsolationLabStore } from '../../runtimeUiPort.ts';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import { beginGoalReplaySession, endGoalReplaySession, stepGoalReplaySessionFrame } from '../shared/GoalReplaySessionCoordinator.ts';
import type { LabAudioPort, LabFrameUpdateContext, LabTabContext, LabTabController } from './LabTabTypes.ts';
import {
  type GoalReplayBenchScenario, type ReplayExportPayload,
  applyInstantKickoffGoalScenario, applyNormalPlayGoalScenario,
} from './goalReplayScenariosPipeline.ts';
import { GoalReplayPodiumSubController } from './GoalReplayPodiumSubController.ts';

const DEFAULT_OPPONENT_STATE = {
  pos: [1400, 3200, 17.05] as [number, number, number],
  vel: [0, 0, 0] as [number, number, number],
  angVel: [0, 0, 0] as [number, number, number],
  rot: [0, -Math.PI / 2, 0] as [number, number, number],
  boost: 100,
};

export class GoalReplayLabTab implements LabTabController {
  readonly tabId = 'goal-replay' as const;
  private ctx: LabTabContext | null = null;
  private goalReplayRingBuffer: ReplayRingBuffer | null = null;
  private goalReplayTimelineController: ReplayTimelineController | null = null;
  private readonly podiumSubController = new GoalReplayPodiumSubController();
  private goalReplayLastKickoffFrame = 0;
  private goalReplayIncidentFrame = 0;
  private goalReplayPostGoalCountdownTicks = 0;
  private goalReplayScoringTeam = 0;
  private goalReplayPhase = 'live';

  attachToHost(ctx: LabTabContext): void {
    this.ctx = ctx;
  }

  onActivate(ctx: LabTabContext): void {
    this.ctx = ctx;
    this.ensureBenchState();
    this.setupBench();
  }

  onDeactivate(): void {
    this.podiumSubController.exitIfActive();
    if (this.goalReplayTimelineController?.sessionState?.isActive) {
      this.goalReplayTimelineController.endReplaySession();
    }
    this.goalReplayPhase = 'live';
    this.goalReplayPostGoalCountdownTicks = 0;
  }

  isPodiumActive(): boolean {
    return this.podiumSubController.isActive;
  }

  private getAudio(): LabAudioPort | null {
    const runtime = this.ctx?.runtime;
    return runtime?.options?.gameAudio || (gameAudio as unknown as LabAudioPort);
  }

  ensureBenchState(): void {
    const r = this.ctx?.runtime;
    if (!this.goalReplayRingBuffer) {
      this.goalReplayRingBuffer = new ReplayRingBuffer({
        mode: REPLAY_BUFFER_MODES.COUNTDOWN_MATCH,
      });
    }
    if (!this.goalReplayTimelineController) {
      this.goalReplayTimelineController = new ReplayTimelineController({
        engine: r?.physics || null,
        ringBuffer: this.goalReplayRingBuffer,
      });
    } else if (r?.physics && this.goalReplayTimelineController.engine !== r.physics) {
      this.goalReplayTimelineController.attach(r.physics, this.goalReplayRingBuffer);
    }
    if (r) {
      this.podiumSubController.ensureController(r);
      if (!r.replayTimelineController) {
        r.replayTimelineController = this.goalReplayTimelineController;
      }
    }
  }

  setupBench(): void {
    const r = this.ctx?.runtime;
    if (!r?.physics) return;
    const store = useSubsystemIsolationLabStore.getState();

    this.ensureBenchState();
    this.podiumSubController.exitIfActive();
    r.releaseGoalReplayCameraOverride();

    while (r.physics.numCars > 2 && typeof r.physics.removeCar === 'function') {
      r.physics.removeCar(r.physics.numCars - 1);
    }
    while (r.physics.numCars < 2) {
      r.physics.addCar(r.physics.numCars % 2, 'octane');
    }
    void r.arena?.ensureOpponent?.();
    if (r.arena?.cars) {
      if (r.arena.cars[0]) {
        r.arena.cars[0].visible = true;
        r.arena.setCarTeam?.(0, 0);
      }
      if (r.arena.cars[1]) {
        r.arena.cars[1].visible = true;
        r.arena.setCarTeam?.(1, 1);
        r.physics.setCarState(1, DEFAULT_OPPONENT_STATE);
      }
      for (let i = 2; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) r.arena.cars[i].visible = false;
      }
    }

    r.playerCarIndex = 0;
    if (r.arena) r.arena.playerCarIndex = 0;
    r.isBotMatch = false;
    r.physics.setUnlimitedBoost(true);
    r.physics.resetGoalLatch?.();
    r.physics.resetKickoff(0, false);
    r.physics.setCarState(1, DEFAULT_OPPONENT_STATE);
    r.physics.clearEvents?.();
    r.simulationStage?.resetActionStates?.();
    r.arena?.resetAllCarEffects?.();
    r.resetAudio?.();

    this.goalReplayRingBuffer!.configureMode(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    r.physics.clearReplayBuffer?.();
    this.goalReplayTimelineController!.endReplaySession();

    const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
    this.goalReplayLastKickoffFrame = currentTick;
    this.goalReplayIncidentFrame = 0;
    this.goalReplayPostGoalCountdownTicks = 0;
    this.goalReplayScoringTeam = 0;
    this.goalReplayPhase = 'live';

    this.goalReplayRingBuffer!.recordFrame(currentTick, r.physics.state, [
      {
        signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
        frameId: currentTick,
        param1: 0,
        param2: 0,
      },
    ]);

    r.interpolator?.sync?.();

    store.updateLiveTelemetry({
      goalReplayPhase: 'live',
      goalReplayCurrentFrameId: currentTick,
      goalReplayLastKickoffFrameId: currentTick,
      goalReplayIncidentFrameId: 0,
      goalReplayRequestedStartFrameId: currentTick,
      goalReplayEffectiveStartFrameId: currentTick,
      goalReplayEffectiveEndFrameId: currentTick,
      goalReplayClampedByKickoff: false,
      goalReplayPlaybackCursor: 0,
      goalReplayPlaybackTotal: 1,
      goalReplayPaused: false,
      goalReplaySpeed: 1.0,
      goalReplayRecordedBufferCount: this.goalReplayRingBuffer!.size,
      podiumActive: false,
    });
  }

  triggerGoalIncident(scoringTeam = 0): void {
    const r = this.ctx?.runtime;
    if (!r?.physics) return;
    const store = useSubsystemIsolationLabStore.getState();
    const audio = this.getAudio();

    const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
    this.goalReplayIncidentFrame = currentTick;
    this.goalReplayScoringTeam = scoringTeam;

    const postGoalSec = Number.isFinite(store.goalReplayPostGoalSec)
      ? store.goalReplayPostGoalSec
      : 3.0;
    const postGoalTicks = Math.max(0, Math.round(postGoalSec * 120));

    this.goalReplayRingBuffer?.recordFrame(currentTick, r.physics.state, [
      {
        signalType: MATCH_SIGNALS.SCORE_UPDATED,
        frameId: currentTick,
        param1: scoringTeam === 0 ? 1 : 0,
        param2: scoringTeam === 1 ? 1 : 0,
      },
      {
        signalType: MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
        frameId: currentTick,
        param1: postGoalTicks,
        param2: scoringTeam,
      },
    ]);

    const bounds = resolveGoalReplayWindowBounds({
      goalIncidentTick: currentTick,
      lastKickoffWillStartTick: this.goalReplayLastKickoffFrame,
      lookbackSeconds: store.goalReplayLookbackSec,
      postGoalSeconds: postGoalSec,
      ringBuffer: this.goalReplayRingBuffer,
    });

    audio?.play?.('sfx_goal_poof', 1.0);

    if (postGoalTicks > 0) {
      this.goalReplayPhase = 'post-goal-delay';
      this.goalReplayPostGoalCountdownTicks = postGoalTicks;
    } else {
      this.beginPlayback();
    }

    store.updateLiveTelemetry({
      goalReplayPhase: this.goalReplayPhase,
      goalReplayCurrentFrameId: currentTick,
      goalReplayIncidentFrameId: currentTick,
      goalReplayRequestedStartFrameId: bounds.requestedStartFrame,
      goalReplayEffectiveStartFrameId: bounds.effectiveStartFrame,
      goalReplayEffectiveEndFrameId: bounds.effectiveEndFrame,
      goalReplayClampedByKickoff: bounds.clampedByKickoff,
      goalReplayRecordedBufferCount: this.goalReplayRingBuffer?.size || 0,
    });
  }

  beginPlayback(): void {
    const r = this.ctx?.runtime;
    if (!r?.physics) return;
    const store = useSubsystemIsolationLabStore.getState();
    this.ensureBenchState();

    const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
    const incidentTick =
      this.goalReplayIncidentFrame > 0 ? this.goalReplayIncidentFrame : currentTick;

    const bounds = resolveGoalReplayWindowBounds({
      goalIncidentTick: incidentTick,
      lastKickoffWillStartTick: this.goalReplayLastKickoffFrame,
      lookbackSeconds: store.goalReplayLookbackSec,
      postGoalSeconds: store.goalReplayPostGoalSec,
      ringBuffer: this.goalReplayRingBuffer,
    });

    const extracted = extractGoalReplayFrames({
      ringBuffer: this.goalReplayRingBuffer,
      engine: r.physics,
      goalIncidentTick: incidentTick,
      lastKickoffWillStartTick: this.goalReplayLastKickoffFrame,
      lookbackSeconds: store.goalReplayLookbackSec,
      postGoalSeconds: store.goalReplayPostGoalSec,
    });

    const totalFrames = this.goalReplayTimelineController!.beginReplaySession({
      scoringTeam: this.goalReplayScoringTeam || 0,
      frames: extracted,
    });

    this.goalReplayPhase = 'replaying';
    this.goalReplayPostGoalCountdownTicks = 0;
    beginGoalReplaySession(r, this.goalReplayTimelineController, {
      cameraMode: 'director',
      source: 'subsystem-lab-goal-replay',
      syncHud: false,
    });

    store.updateLiveTelemetry({
      goalReplayPhase: 'replaying',
      goalReplayRequestedStartFrameId: bounds.requestedStartFrame,
      goalReplayEffectiveStartFrameId: bounds.effectiveStartFrame,
      goalReplayEffectiveEndFrameId: bounds.effectiveEndFrame,
      goalReplayClampedByKickoff: bounds.clampedByKickoff,
      goalReplayPlaybackCursor: 0,
      goalReplayPlaybackTotal: totalFrames,
      goalReplayPaused: false,
      goalReplaySpeed: 1.0,
    });
  }

  stopPlayback(): void {
    const r = this.ctx?.runtime;
    if (!r?.physics) return;
    const store = useSubsystemIsolationLabStore.getState();

    endGoalReplaySession(r, this.goalReplayTimelineController, {
      source: 'subsystem-lab-goal-replay',
      clearHud: false,
    });
    this.goalReplayPhase = 'live';
    this.goalReplayPostGoalCountdownTicks = 0;

    r.physics.resetGoalLatch?.();
    r.physics.resetKickoff(0, false);
    if (r.physics.numCars > 1) {
      r.physics.setCarState(1, DEFAULT_OPPONENT_STATE);
    }

    const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
    this.goalReplayLastKickoffFrame = currentTick;
    this.goalReplayRingBuffer?.recordFrame(currentTick, r.physics.state, [
      {
        signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
        frameId: currentTick,
        param1: 0,
        param2: 0,
      },
    ]);
    r.interpolator?.sync?.();

    store.updateLiveTelemetry({
      goalReplayPhase: 'live',
      goalReplayCurrentFrameId: currentTick,
      goalReplayLastKickoffFrameId: currentTick,
      goalReplayPaused: false,
      goalReplayRecordedBufferCount: this.goalReplayRingBuffer?.size || 0,
    });
  }

  onPhysicsTick(_dt: number): boolean {
    const r = this.ctx?.runtime;
    const sim = r?.physics;
    if (!sim) return true;

    this.ensureBenchState();
    if (this.podiumSubController.isActive || this.goalReplayPhase === 'replaying') {
      return false;
    }

    if (this.goalReplayPhase === 'live') {
      const bView = sim.getBallStateView();
      const goalScored =
        typeof sim.isBallScored === 'function'
          ? sim.isBallScored(bView)
          : Math.abs(bView.posY) > 5120 + 91.25 &&
            Math.abs(bView.posX) < 892.755 &&
            bView.posZ < 642.775;
      if (goalScored) {
        this.triggerGoalIncident(bView.posY > 0 ? 0 : 1);
      }
    } else if (this.goalReplayPhase === 'post-goal-delay') {
      if (this.goalReplayPostGoalCountdownTicks > 0) {
        this.goalReplayPostGoalCountdownTicks--;
        if (this.goalReplayPostGoalCountdownTicks <= 0) {
          this.beginPlayback();
          return false;
        }
      }
    }
    return true;
  }

  onAfterPhysicsTick(): void {
    const r = this.ctx?.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    const sim = r?.physics;
    if (!sim || store.activeTab !== 'goal-replay') return;
    if (this.goalReplayPhase !== 'live' && this.goalReplayPhase !== 'post-goal-delay') {
      return;
    }

    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount || 0);
    this.goalReplayRingBuffer?.recordFrame(currentTick, sim.state);
    sim.recordReplayFrame?.();

    if (currentTick % 6 === 0) {
      const incidentRef =
        this.goalReplayIncidentFrame > 0 ? this.goalReplayIncidentFrame : currentTick;
      const bounds = resolveGoalReplayWindowBounds({
        goalIncidentTick: incidentRef,
        lastKickoffWillStartTick: this.goalReplayLastKickoffFrame,
        lookbackSeconds: store.goalReplayLookbackSec,
        postGoalSeconds: store.goalReplayPostGoalSec,
        ringBuffer: this.goalReplayRingBuffer,
      });

      store.updateLiveTelemetry({
        goalReplayCurrentFrameId: currentTick,
        goalReplayLastKickoffFrameId: this.goalReplayLastKickoffFrame || 0,
        goalReplayRequestedStartFrameId: bounds.requestedStartFrame,
        goalReplayEffectiveStartFrameId: bounds.effectiveStartFrame,
        goalReplayEffectiveEndFrameId: bounds.effectiveEndFrame,
        goalReplayClampedByKickoff: bounds.clampedByKickoff,
        goalReplayRecordedBufferCount: this.goalReplayRingBuffer?.size || 0,
      });
    }
  }

  onRenderFrame(frameCtx: LabFrameUpdateContext): void {
    this.updatePresentation(frameCtx);
  }

  updatePresentation(context: LabFrameUpdateContext): void {
    const r = this.ctx?.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    const dt = context?.dt ?? 0.016;

    if (this.podiumSubController.update(context)) return;
    if (store.activeTab !== 'goal-replay') return;

    if (
      this.goalReplayPhase === 'replaying' &&
      this.goalReplayTimelineController?.sessionState?.isActive
    ) {
      const stepRes = stepGoalReplaySessionFrame({
        runtime: r,
        replayController: this.goalReplayTimelineController,
        context,
        dt,
        source: 'subsystem-lab-goal-replay',
        cameraMode: 'director',
        scoringTeam: this.goalReplayScoringTeam || 0,
        scorerCarIndex: 0,
        eventDispatchOptions: { isGoalReplay: true },
        syncCarAudioControls: false,
        syncBoostToHud: false,
        emitWillEndSignal: false,
        syncHudProgress: false,
      });

      const s = this.goalReplayTimelineController.sessionState;
      store.updateLiveTelemetry({
        goalReplayPlaybackCursor: stepRes.frameIndex,
        goalReplayPlaybackTotal: stepRes.totalFrames,
        goalReplayPaused: s.isPaused,
        goalReplaySpeed: s.playbackSpeed,
      });

      if (stepRes.isFinished && !s.isPaused) {
        this.getAudio()?.resetIncidentDebounceState?.();
        this.goalReplayTimelineController.seekToIndex(0, r?.interpolator ?? null);
        s.isScrubbing = false;
        this.goalReplayTimelineController.directorCameraState.initialized = false;
      }
    }
  }

  exportReplayBufferAsJson(): ReplayExportPayload {
    this.ensureBenchState();
    return this.podiumSubController.exportReplayBufferAsJson(
      this.ctx?.runtime,
      this.goalReplayRingBuffer
    );
  }

  enterPodiumShowcase(winningTeam = 0): void {
    this.ensureBenchState();
    const entered = this.podiumSubController.enterShowcase(
      this.ctx?.runtime,
      winningTeam,
      this.goalReplayTimelineController,
      this.goalReplayPhase === 'replaying'
    );
    if (entered) this.goalReplayPhase = 'podium';
  }

  exitPodiumShowcase(): void {
    if (this.podiumSubController.exitShowcase(this.ctx?.runtime)) {
      this.goalReplayPhase = 'live';
    }
  }

  triggerScenario(scenario: GoalReplayBenchScenario): void {
    const r = this.ctx?.runtime;
    if (!r?.physics) return;
    const store = useSubsystemIsolationLabStore.getState();
    this.ensureBenchState();

    switch (scenario) {
      case 'instant_kickoff_goal': {
        if (this.goalReplayPhase === 'replaying') this.stopPlayback();
        if (this.podiumSubController.isActive) this.exitPodiumShowcase();
        const currentTick = applyInstantKickoffGoalScenario(
          r.physics,
          this.goalReplayRingBuffer
        );
        this.goalReplayLastKickoffFrame = currentTick;
        r.interpolator?.sync?.();
        store.updateLiveTelemetry({
          goalReplayPhase: 'live',
          goalReplayLastKickoffFrameId: currentTick,
          goalReplayCurrentFrameId: currentTick,
        });
        break;
      }
      case 'normal_play_goal': {
        if (this.goalReplayPhase === 'replaying') this.stopPlayback();
        if (this.podiumSubController.isActive) this.exitPodiumShowcase();
        applyNormalPlayGoalScenario(
          r.physics,
          this.goalReplayRingBuffer,
          this.goalReplayLastKickoffFrame
        );
        r.interpolator?.sync?.();
        break;
      }
      case 'trigger_goal_now':
        this.triggerGoalIncident(0);
        break;
      case 'emit_kickoff_signal': {
        const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
        this.goalReplayLastKickoffFrame = currentTick;
        this.goalReplayRingBuffer!.recordFrame(currentTick, r.physics.state, [
          {
            signalType: MATCH_SIGNALS.KICKOFF_WILL_START,
            frameId: currentTick,
            param1: 0,
            param2: 0,
          },
        ]);
        store.updateLiveTelemetry({
          goalReplayLastKickoffFrameId: currentTick,
          goalReplayCurrentFrameId: currentTick,
          goalReplayRecordedBufferCount: this.goalReplayRingBuffer!.size,
        });
        break;
      }
      case 'start_replay_now':
        if (this.goalReplayIncidentFrame <= 0) {
          this.goalReplayIncidentFrame = Math.floor(
            r.physics.getHeaderView?.()?.tickCount || 0
          );
        }
        this.beginPlayback();
        break;
      case 'stop_replay':
        this.stopPlayback();
        break;
      case 'clear_replay_buffer':
        this.setupBench();
        break;
      case 'export_replay_json':
        this.exportReplayBufferAsJson();
        break;
      default:
        break;
    }
  }

  togglePause(): void {
    if (!this.goalReplayTimelineController) return;
    const paused = this.goalReplayTimelineController.togglePause();
    useSubsystemIsolationLabStore.getState().updateLiveTelemetry({
      goalReplayPaused: paused,
    });
  }

  cycleSpeed(): void {
    if (!this.goalReplayTimelineController) return;
    const speed = this.goalReplayTimelineController.cyclePlaybackSpeed();
    useSubsystemIsolationLabStore.getState().updateLiveTelemetry({
      goalReplaySpeed: speed,
    });
  }

  seekNormalized(progress01: number): void {
    const r = this.ctx?.runtime;
    if (!this.goalReplayTimelineController) return;
    this.goalReplayTimelineController.seekToNormalized(progress01, r?.interpolator);
    useSubsystemIsolationLabStore.getState().updateLiveTelemetry({
      goalReplayPlaybackCursor: this.goalReplayTimelineController.currentFrameIndex,
      goalReplayPlaybackTotal:
        this.goalReplayTimelineController.getTotalRecordedFrames(),
    });
  }
}
