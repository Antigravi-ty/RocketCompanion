import { MATCH_SIGNALS } from '../../../physics/RocketSimConstants.ts';
import { packLoadoutSignalParam2 } from '../../../ui-core/config/vehicleConstants.ts';
import { clearRetainedMatchReplayOnMatchStart } from '../../../replay/ReplayFileExporter.ts';
import { useExperimentalMultiBotsStore } from '../../runtimeUiPort.ts';
import { PodiumCelebrationController } from '../PodiumCelebrationController.ts';
import {
  type BallStateViewLike,
  type GoalScoredEvaluation,
  hasKickoffBallMoved,
} from '../shared/goalAndBallTouchPipeline.ts';
import {
  KICKOFF_COUNTDOWN_TICKS,
  POST_MATCH_PODIUM_DELAY_TICKS,
  stepKickoffCountdownState,
  stepMatchClockState,
  syncLocalMatchStateToRuntimeAndHud,
} from '../shared/matchClockAndPhasePipeline.ts';
import {
  type ExpGoalIncidentMeta,
  type ExpModeRuntimePort,
  type ExpPhysicsEnginePort,
  type ExpSpawnedCarEntry,
  getExpModeAudio,
} from './ExperimentalMultiBotsMatchMath.ts';
import { ExperimentalMultiBotsGoalIncidentTracker } from './ExperimentalMultiBotsGoalIncidentTracker.ts';
import { ExperimentalMultiBotsRosterController } from './ExperimentalMultiBotsRosterController.ts';
import { ExperimentalMultiBotsReplayController } from './ExperimentalMultiBotsReplayController.ts';

export class ExperimentalMultiBotsMatchLifecycleController {
  private readonly runtime: ExpModeRuntimePort | null;
  public readonly podiumController: PodiumCelebrationController;
  public readonly goalTracker: ExperimentalMultiBotsGoalIncidentTracker;

  public countdownTicks = 0;
  public kickoffTick = 0;
  public ticksSinceKickoff = 0;
  public lastKickoffStartTick = 0;
  public clockStarted = false;
  public clockTickAccum = 0;
  public configuredDuration = 300;
  public remainingSec = 300;
  public overtimeSeconds = 0;
  public clockDirection: 'up' | 'down' = 'down';
  public isOvertime = false;
  public isMatchEnded = false;
  public matchWinnerTeam: 0 | 1 = 0;
  public podiumDelayTicks = 0;
  public matchPhase = 'kickoff (3)';
  public blueScore = 0;
  public orangeScore = 0;
  public pendingMatchEndAfterReplay = false;
  public pendingOvertimeAfterReplay = false;
  public pendingMatchWinner: 0 | 1 | null = null;
  public lastStepInferenceMs = 0;
  private matchStartToken = 0;

  constructor(runtime: ExpModeRuntimePort | null) {
    this.runtime = runtime;
    this.podiumController = new PodiumCelebrationController(runtime);
    this.goalTracker = new ExperimentalMultiBotsGoalIncidentTracker(runtime);
    if (runtime && !runtime.podiumController) {
      runtime.podiumController = this.podiumController;
    }
  }

  get goalResetTicks(): number {
    return this.goalTracker.goalResetTicks;
  }
  set goalResetTicks(val: number) {
    this.goalTracker.goalResetTicks = val;
  }

  getGoalIncidentMeta(): ExpGoalIncidentMeta {
    return this.goalTracker.getGoalIncidentMeta(this.lastKickoffStartTick);
  }

  recordCarBallTouch(
    carIndex: number,
    tick: number,
    spawnedCars: ReadonlyArray<ExpSpawnedCarEntry>,
    isReplayActive: boolean
  ): void {
    this.goalTracker.recordCarBallTouch(
      carIndex,
      tick,
      spawnedCars,
      isReplayActive,
      this.isMatchEnded
    );
  }

  async applyRosterAndStartMatch(
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): Promise<void> {
    const r = this.runtime;
    if (!r?.physics) return;
    const token = ++this.matchStartToken;

    clearRetainedMatchReplayOnMatchStart();
    replayCtrl.replayController?.endReplaySession?.();
    this.podiumController?.exitPodium?.();
    replayCtrl.clearSignalsAndBuffer();
    replayCtrl.isReplayActive = false;
    this.isMatchEnded = false;
    this.podiumDelayTicks = 0;
    this.pendingMatchEndAfterReplay = false;
    this.pendingMatchWinner = null;
    r._localSkipReplayReady = false;
    r.releaseGoalReplayCameraOverride();

    await rosterCtrl.preloadNativeModels();
    if (token !== this.matchStartToken || r?.match?.state?.mode !== 'exp-multi-bots') return;

    const targetCamIdx = await rosterCtrl.spawnRosterFromStore();
    if (token !== this.matchStartToken || r?.match?.state?.mode !== 'exp-multi-bots') return;
    const store = useExperimentalMultiBotsStore.getState();

    const configuredDuration =
      typeof store.matchDurationSec === 'number' && Number.isFinite(store.matchDurationSec)
        ? Math.max(0, Math.round(store.matchDurationSec))
        : 300;

    this.configuredDuration = configuredDuration;
    this.blueScore = 0;
    this.orangeScore = 0;
    this.remainingSec = configuredDuration;
    this.isOvertime = false;
    this.pendingOvertimeAfterReplay = configuredDuration === 0;
    this.overtimeSeconds = 0;
    this.clockDirection = configuredDuration === 0 ? 'up' : 'down';
    this.goalTracker.goalResetTicks = 0;

    replayCtrl.emitRosterJoinAndLoadoutSignals(
      configuredDuration,
      rosterCtrl.spawnedCars,
      packLoadoutSignalParam2
    );
    rosterCtrl.resetMultiCarKickoffSpawns();

    const localTeam: 0 | 1 =
      rosterCtrl.humanPlayerCarIndex >= 0 &&
      rosterCtrl.spawnedCars[rosterCtrl.humanPlayerCarIndex]?.team === 1
        ? 1
        : 0;

    this.goalTracker.syncInitialMatchHudAndTelemetry(
      r,
      localTeam,
      this.remainingSec,
      this.isOvertime,
      targetCamIdx
    );
    this.beginKickoffCountdown(replayCtrl);
    rosterCtrl.publishSpawnedCarsTelemetry();
  }

  beginKickoffCountdown(replayCtrl: ExperimentalMultiBotsReplayController): void {
    const r = this.runtime;
    replayCtrl.replayController?.endReplaySession?.();
    replayCtrl.isReplayActive = false;
    r?.releaseGoalReplayCameraOverride?.();
    this.goalTracker.resetPlayTouchAndGoalState();

    const enteringOvertimeNow =
      Boolean(this.pendingOvertimeAfterReplay) ||
      (!this.isOvertime && this.remainingSec === 0 && this.blueScore === this.orangeScore);
    if (enteringOvertimeNow) {
      this.pendingOvertimeAfterReplay = false;
      this.isOvertime = true;
      this.overtimeSeconds = 0;
      this.clockDirection = 'up';
      replayCtrl.emitReplaySignal(MATCH_SIGNALS.OVERTIME_START, 0, 0);
    }

    this.countdownTicks = KICKOFF_COUNTDOWN_TICKS;
    this.kickoffTick = 0;
    this.ticksSinceKickoff = 0;
    this.clockStarted = false;
    this.clockTickAccum = 0;
    this.matchPhase = 'kickoff (3)';
    this.lastKickoffStartTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0) + 1;
    replayCtrl.emitReplaySignal(MATCH_SIGNALS.KICKOFF_WILL_START, KICKOFF_COUNTDOWN_TICKS, 3);

    this.goalTracker.syncKickoffCountdownStart(
      r,
      this.matchPhase,
      this.blueScore,
      this.orangeScore,
      this.isOvertime,
      this.remainingSec,
      enteringOvertimeNow
    );
  }

  finishMatch(
    winnerTeam: 0 | 1,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    const r = this.runtime;
    const currentTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);

    replayCtrl.emitReplaySignal(MATCH_SIGNALS.MATCH_ENDED, winnerTeam, 0, currentTick);
    replayCtrl.retainMatchReplayAndNotify({
      winnerTeam,
      blueScore: this.blueScore,
      orangeScore: this.orangeScore,
      configuredDuration: this.configuredDuration,
      goalMeta: this.getGoalIncidentMeta(),
      spawnedCars: rosterCtrl.spawnedCars,
    });

    replayCtrl.replayController?.endReplaySession?.();
    replayCtrl.isReplayActive = false;
    this.isMatchEnded = true;
    this.matchWinnerTeam = winnerTeam;
    this.podiumDelayTicks = POST_MATCH_PODIUM_DELAY_TICKS;
    this.isOvertime = false;
    this.goalTracker.goalResetTicks = 0;
    this.pendingMatchEndAfterReplay = false;
    this.matchPhase = winnerTeam === 0 ? 'MATCH END (BLUE WINS)' : 'MATCH END (ORANGE WINS)';

    if (r) {
      r._localSkipReplayReady = false;
      r.releaseGoalReplayCameraOverride();
      r.podiumController = this.podiumController;
    }

    this.goalTracker.syncMatchEndHudAndAudio(
      r,
      this.matchPhase,
      this.blueScore,
      this.orangeScore,
      this.remainingSec,
      winnerTeam
    );
  }

  enterPodium(replayCtrl: ExperimentalMultiBotsReplayController): void {
    const r = this.runtime;
    const winnerTeam: 0 | 1 = this.matchWinnerTeam ?? (this.blueScore >= this.orangeScore ? 0 : 1);
    const currentTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);

    replayCtrl.emitReplaySignal(MATCH_SIGNALS.PODIUM_START, winnerTeam, 0, currentTick);
    this.podiumDelayTicks = 0;
    this.goalTracker.syncPodiumEntryHudAndAudio(r, this.podiumController, winnerTeam);
  }

  completePostGoalOrReplayTransition(
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    replayCtrl.endSession(rosterCtrl);
    if (this.pendingMatchEndAfterReplay) {
      const winner: 0 | 1 = this.pendingMatchWinner ?? (this.blueScore >= this.orangeScore ? 0 : 1);
      this.finishMatch(winner, rosterCtrl, replayCtrl);
      return;
    }
    rosterCtrl.resetMultiCarKickoffSpawns();
    this.beginKickoffCountdown(replayCtrl);
  }

  prepareDirectGoalShot(
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    this.countdownTicks = 0;
    this.clockStarted = true;
    if (replayCtrl.isReplayActive) this.completePostGoalOrReplayTransition(rosterCtrl, replayCtrl);
  }

  forceOvertimeReset(
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    if (replayCtrl.isReplayActive) replayCtrl.endSession(rosterCtrl);
    const tied = Math.max(this.blueScore, this.orangeScore, 1);
    this.blueScore = tied;
    this.orangeScore = tied;
    this.remainingSec = 0;
    this.isOvertime = false;
    this.pendingOvertimeAfterReplay = true;
    this.overtimeSeconds = 0;
    this.clockDirection = 'up';
    replayCtrl.emitReplaySignal(MATCH_SIGNALS.SCORE_UPDATED, tied, tied);
    rosterCtrl.resetMultiCarKickoffSpawns();
    this.beginKickoffCountdown(replayCtrl);
    useExperimentalMultiBotsStore.getState().updateLiveTelemetry({
      blueScore: tied,
      orangeScore: tied,
      remainingSec: 0,
      isOvertime: true,
    });
    syncLocalMatchStateToRuntimeAndHud(this.runtime?.match?.state, {
      blueScore: tied,
      orangeScore: tied,
      remainingSeconds: 0,
      isOvertime: true,
      overtimeSeconds: 0,
    });
  }

  forceEndMatchNow(
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    if (this.blueScore === this.orangeScore) this.blueScore += 1;
    this.finishMatch(this.blueScore >= this.orangeScore ? 0 : 1, rosterCtrl, replayCtrl);
  }

  triggerSandboxAction(
    action: string,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    this.goalTracker.executeSandboxAction(action, this, rosterCtrl, replayCtrl);
  }

  stepEndedMatchPodiumDelay(
    replayCtrl: ExperimentalMultiBotsReplayController,
    onDelayStep?: () => void
  ): boolean {
    if (this.podiumDelayTicks <= 0) return false;
    onDelayStep?.();
    if (--this.podiumDelayTicks <= 0) this.enterPodium(replayCtrl);
    return true;
  }

  stepCountdownPhase(
    currentTick: number,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): boolean {
    if (this.countdownTicks <= 0) return false;
    const stepRes = stepKickoffCountdownState(this.countdownTicks, this.isOvertime);
    this.countdownTicks = stepRes.nextCountdownTicks;

    if (stepRes.transitionedSecond === 2 || stepRes.transitionedSecond === 1) {
      const sec = stepRes.transitionedSecond;
      this.matchPhase = `kickoff (${sec})`;
      replayCtrl.emitReplaySignal(MATCH_SIGNALS.KICKOFF_WILL_START, this.countdownTicks, sec);
      this.goalTracker.syncCountdownTransitionHudAndAudio(
        this.runtime,
        sec,
        this.matchPhase,
        stepRes.audioCue
      );
    } else if (stepRes.transitionedSecond === 0) {
      this.matchPhase = this.isOvertime ? 'overtime' : 'playing';
      this.lastKickoffStartTick = currentTick + 1;
      replayCtrl.emitReplaySignal(MATCH_SIGNALS.KICKOFF_START, 0, 0);
      this.goalTracker.syncCountdownTransitionHudAndAudio(
        this.runtime,
        0,
        this.matchPhase,
        stepRes.audioCue
      );
    }
    return true;
  }

  recordBotStepInference(totalInferenceMs: number): void {
    this.kickoffTick++;
    this.lastStepInferenceMs = totalInferenceMs;
  }

  stepPostGoalFreeze(sim: ExpPhysicsEnginePort, currentTick: number): void {
    this.goalTracker.stepPostGoalFreeze(sim, currentTick);
  }

  stepPlayingClock(
    currentTick: number,
    bView: BallStateViewLike | null | undefined,
    ballOnGround: boolean,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    const r = this.runtime;
    const prevRemSec = this.remainingSec;
    const clockStep = stepMatchClockState({
      clockStarted: this.clockStarted,
      clockTickAccum: this.clockTickAccum,
      ticksSinceKickoff: this.ticksSinceKickoff,
      ballMoved: hasKickoffBallMoved(bView),
      ballOnGround,
      isOvertime: this.isOvertime,
      remainingSec: this.remainingSec,
      blueScore: this.blueScore,
      orangeScore: this.orangeScore,
    });

    this.clockStarted = clockStep.clockStarted;
    this.clockTickAccum = clockStep.clockTickAccum;
    this.ticksSinceKickoff = clockStep.ticksSinceKickoff;
    this.remainingSec = clockStep.remainingSec;

    if (clockStep.secondAdvanced) {
      replayCtrl.emitClockSecondAndAlertSignals(
        currentTick,
        this.remainingSec,
        this.isOvertime,
        clockStep.timeAlertSecond
      );
      if (clockStep.audioCue) {
        getExpModeAudio(r)?.play?.(
          clockStep.audioCue,
          1.0,
          clockStep.audioCue === 'match_countdown_10s' ? undefined : 10000
        );
      }
    }

    if (clockStep.zeroSecondOutcome === 'overtime') {
      this.pendingOvertimeAfterReplay = true;
      rosterCtrl.resetMultiCarKickoffSpawns();
      this.beginKickoffCountdown(replayCtrl);
      return;
    }
    if (
      clockStep.zeroSecondOutcome === 'blue-wins' ||
      clockStep.zeroSecondOutcome === 'orange-wins'
    ) {
      this.finishMatch(clockStep.zeroSecondOutcome === 'blue-wins' ? 0 : 1, rosterCtrl, replayCtrl);
      return;
    }

    if (this.ticksSinceKickoff % 8 === 0 || this.remainingSec !== prevRemSec) {
      this.goalTracker.syncPeriodicPlayingTelemetry(
        r,
        this.remainingSec,
        this.isOvertime,
        this.matchPhase,
        this.lastStepInferenceMs || 0
      );
    }
  }

  stepPostFrameLifecycle(
    currentTick: number,
    bView: BallStateViewLike | null | undefined,
    ballOnGround: boolean,
    goalEval: GoalScoredEvaluation,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    const handledReset = this.goalTracker.stepPostGoalResetCountdown(
      this.lastKickoffStartTick,
      rosterCtrl,
      replayCtrl,
      () => this.completePostGoalOrReplayTransition(rosterCtrl, replayCtrl),
      () => {
        this.matchPhase = 'replay';
      }
    );
    if (handledReset) return;
    if (goalEval.scored && bView) {
      const outcome = this.goalTracker.recordGoalScored(
        goalEval,
        bView,
        currentTick,
        {
          blueScore: this.blueScore,
          orangeScore: this.orangeScore,
          isOvertime: this.isOvertime,
          remainingSec: this.remainingSec,
          lastKickoffStartTick: this.lastKickoffStartTick,
        },
        rosterCtrl,
        replayCtrl
      );
      this.blueScore = outcome.blueScore;
      this.orangeScore = outcome.orangeScore;
      this.matchPhase = outcome.matchPhase;
      if (outcome.pendingMatchEndAfterReplay) {
        this.pendingMatchEndAfterReplay = true;
        this.pendingMatchWinner = outcome.pendingMatchWinner;
      }
      if (outcome.pendingOvertimeAfterReplay) {
        this.pendingOvertimeAfterReplay = true;
      }
      return;
    }
    this.stepPlayingClock(currentTick, bView, ballOnGround, rosterCtrl, replayCtrl);
  }
}
