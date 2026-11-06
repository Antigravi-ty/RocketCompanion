import { isExperimentalEngineReady } from '../../../ai/experimental/ExperimentalBotAgent.ts';
import { INCIDENT_EVENT_TYPES, MATCH_SIGNALS } from '../../../physics/RocketSimConstants.ts';
import { packLoadoutSignalParam2 } from '../../../ui-core/config/vehicleConstants';
import { clearRetainedMatchReplayOnMatchStart } from '../../../replay/ReplayFileExporter.ts';
import { useExperimentalMultiBotsStore } from '../../runtimeUiPort.ts';
import { PodiumCelebrationController } from '../PodiumCelebrationController.ts';
import {
  hasKickoffBallMoved,
  stepPostGoalBallFreeze,
} from '../shared/goalAndBallTouchPipeline.ts';
import {
  KICKOFF_COUNTDOWN_TICKS,
  POST_GOAL_CELEBRATION_TICKS,
  POST_MATCH_PODIUM_DELAY_TICKS,
  stepKickoffCountdownState,
  stepMatchClockState,
  syncLocalMatchStateToRuntimeAndHud,
} from '../shared/matchClockAndPhasePipeline.ts';
import {
  ExpGoalIncidentMeta,
  ExpSpawnedCarEntry,
  ExpTeamTouchRecord,
  getExpCarDisplayName,
  getExpModeAudio,
  resolveGoalAttribution,
} from './ExperimentalMultiBotsMatchMath.ts';
import { ExperimentalMultiBotsRosterController } from './ExperimentalMultiBotsRosterController.ts';
import { ExperimentalMultiBotsReplayController } from './ExperimentalMultiBotsReplayController.ts';

export class ExperimentalMultiBotsMatchLifecycleController {
  private readonly runtime: any;
  public readonly podiumController: PodiumCelebrationController;

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
  public goalResetTicks = 0;
  public pendingMatchEndAfterReplay = false;
  public pendingOvertimeAfterReplay = false;
  public pendingMatchWinner: 0 | 1 | null = null;
  public lastStepInferenceMs = 0;

  public lastTouchByTeam: Record<0 | 1, ExpTeamTouchRecord | null> = { 0: null, 1: null };
  public prevTouchByTeam: Record<0 | 1, ExpTeamTouchRecord | null> = { 0: null, 1: null };
  public goalIncidentTick = -1;
  public goalScoringTeam: 0 | 1 = 0;
  public goalScorerCarIndex = 0;
  public goalScorerName: string | null = null;
  public goalScorerTouchTick = -1;
  public goalAssistName: string | null = null;
  public goalBallSpeedKph: number | null = null;
  public frozenGoalBallState: Float32Array | null = null;
  public prevBallVelX = 0;
  public prevBallVelY = 0;
  public prevBallVelZ = 0;
  private matchStartToken = 0;

  constructor(runtime: any) {
    this.runtime = runtime;
    this.podiumController = new PodiumCelebrationController(runtime);
    if (runtime && !runtime.podiumController) {
      runtime.podiumController = this.podiumController;
    }
    this.resetPlayTouchAndGoalState();
  }

  resetPlayTouchAndGoalState(): void {
    this.lastTouchByTeam = { 0: null, 1: null };
    this.prevTouchByTeam = { 0: null, 1: null };
    this.goalIncidentTick = -1;
    this.goalScoringTeam = 0;
    this.goalScorerCarIndex = 0;
    this.goalScorerName = null;
    this.goalScorerTouchTick = -1;
    this.goalAssistName = null;
    this.goalBallSpeedKph = null;
    this.frozenGoalBallState = null;
    this.prevBallVelX = 0;
    this.prevBallVelY = 0;
    this.prevBallVelZ = 0;
  }

  getGoalIncidentMeta(): ExpGoalIncidentMeta {
    return {
      goalIncidentTick: this.goalIncidentTick,
      goalScoringTeam: this.goalScoringTeam,
      goalScorerCarIndex: this.goalScorerCarIndex,
      goalScorerName: this.goalScorerName,
      goalScorerTouchTick: this.goalScorerTouchTick,
      goalAssistName: this.goalAssistName,
      goalBallSpeedKph: this.goalBallSpeedKph,
      lastKickoffStartTick: this.lastKickoffStartTick,
    };
  }

  recordCarBallTouch(
    carIndex: number,
    tick: number,
    spawnedCars: ReadonlyArray<ExpSpawnedCarEntry>,
    isReplayActive: boolean
  ): void {
    if (isReplayActive || this.isMatchEnded) return;
    if (this.goalIncidentTick >= 0 && tick > this.goalIncidentTick) return;
    const entry = spawnedCars[carIndex];
    if (!entry) return;

    const team: 0 | 1 = entry.team === 1 ? 1 : 0;
    const playerName = getExpCarDisplayName(entry, spawnedCars);
    const prevLast = this.lastTouchByTeam[team];
    if (prevLast && prevLast.carIndex !== carIndex) {
      this.prevTouchByTeam[team] = { ...prevLast };
    }
    this.lastTouchByTeam[team] = { carIndex, team, tick: Math.floor(tick), playerName };
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
    if (r) {
      r._localSkipReplayReady = false;
      r.releaseGoalReplayCameraOverride();
    }

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
    this.goalResetTicks = 0;

    const carCount = rosterCtrl.spawnedCars.length;
    replayCtrl.emitReplaySignal(MATCH_SIGNALS.MATCH_INITIALIZED, configuredDuration, carCount);
    for (const c of rosterCtrl.spawnedCars) {
      replayCtrl.emitReplaySignal(MATCH_SIGNALS.PLAYER_JOINED, c.carIndex, c.team & 0xff);
      const packed = packLoadoutSignalParam2(c.visualId, c.colorSlot, c.hitboxId, {
        paintFinish: c.paintFinish,
        boostVisual: c.boostVisual,
        boostAudio: c.boostAudio,
      });
      replayCtrl.emitReplaySignal(MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED, c.carIndex, packed);
    }
    replayCtrl.emitReplaySignal(MATCH_SIGNALS.MATCH_STARTED, configuredDuration, carCount);

    rosterCtrl.resetMultiCarKickoffSpawns();

    const localTeam: 0 | 1 =
      rosterCtrl.humanPlayerCarIndex >= 0 &&
      rosterCtrl.spawnedCars[rosterCtrl.humanPlayerCarIndex]?.team === 1
        ? 1
        : 0;

    syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
      matchPhase: 'kickoff', kickoffCountdown: 3, localTeam, blueScore: 0, orangeScore: 0,
      remainingSeconds: this.remainingSec, isOvertime: this.isOvertime, overtimeSeconds: 0,
      winner: null, winReason: null, replayScorerName: null, replayScorerTeam: null,
      replayBallSpeedKph: null, replayAssistName: null,
    });

    this.beginKickoffCountdown(replayCtrl);

    store.updateLiveTelemetry({
      matchActive: true, activeCameraCarIndex: targetCamIdx, blueScore: 0, orangeScore: 0,
      remainingSec: this.remainingSec, isOvertime: this.isOvertime,
    });
    rosterCtrl.publishSpawnedCarsTelemetry();
  }

  beginKickoffCountdown(replayCtrl: ExperimentalMultiBotsReplayController): void {
    const r = this.runtime;
    const store = useExperimentalMultiBotsStore.getState();
    const audio = getExpModeAudio(r);

    replayCtrl.replayController?.endReplaySession?.();
    replayCtrl.isReplayActive = false;
    r?.releaseGoalReplayCameraOverride?.();
    this.resetPlayTouchAndGoalState();

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

    store.updateLiveTelemetry({
      kickoffCountdownSec: 3, matchPhase: this.matchPhase,
      isOvertime: this.isOvertime, remainingSec: this.remainingSec,
    });
    syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
      matchPhase: 'kickoff', kickoffCountdown: 3, blueScore: this.blueScore, orangeScore: this.orangeScore,
      isOvertime: this.isOvertime, remainingSeconds: this.remainingSec,
      overtimeSeconds: this.isOvertime ? this.remainingSec : 0,
      replayScorerName: null, replayScorerTeam: null, replayBallSpeedKph: null, replayAssistName: null,
    });

    if (enteringOvertimeNow) audio?.play?.('match_entering_overtime', 1.0, 10000);
    audio?.play?.('match_countdown_321', 1.0);
  }

  finishMatch(
    winnerTeam: 0 | 1,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    const r = this.runtime;
    const store = useExperimentalMultiBotsStore.getState();
    const audio = getExpModeAudio(r);
    const currentTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);

    replayCtrl.emitReplaySignal(MATCH_SIGNALS.MATCH_ENDED, winnerTeam, 0, currentTick);
    replayCtrl.retainMatchReplayAndNotify({
      winnerTeam, blueScore: this.blueScore, orangeScore: this.orangeScore,
      configuredDuration: this.configuredDuration, goalMeta: this.getGoalIncidentMeta(),
      spawnedCars: rosterCtrl.spawnedCars,
    });

    replayCtrl.replayController?.endReplaySession?.();
    replayCtrl.isReplayActive = false;
    this.isMatchEnded = true;
    this.matchWinnerTeam = winnerTeam;
    this.podiumDelayTicks = POST_MATCH_PODIUM_DELAY_TICKS;
    this.isOvertime = false;
    this.goalResetTicks = 0;
    this.pendingMatchEndAfterReplay = false;
    this.matchPhase = winnerTeam === 0 ? 'MATCH END (BLUE WINS)' : 'MATCH END (ORANGE WINS)';

    if (r) {
      r._localSkipReplayReady = false;
      r.releaseGoalReplayCameraOverride();
      r.podiumController = this.podiumController;
    }

    store.updateLiveTelemetry({ matchPhase: this.matchPhase, isOvertime: false });
    syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
      matchPhase: 'ended', kickoffCountdown: 0, blueScore: this.blueScore, orangeScore: this.orangeScore,
      remainingSeconds: this.remainingSec, isOvertime: false, winner: winnerTeam, winReason: 'SCORE',
    });

    r?.resetAudio?.();
    r?.audioSubsystem?.resetAudio?.();
    audio?.play?.('endgame', 1.0);
  }

  enterPodium(replayCtrl: ExperimentalMultiBotsReplayController): void {
    const r = this.runtime;
    const winnerTeam: 0 | 1 = this.matchWinnerTeam ?? (this.blueScore >= this.orangeScore ? 0 : 1);
    const currentTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);

    replayCtrl.emitReplaySignal(MATCH_SIGNALS.PODIUM_START, winnerTeam, 0, currentTick);
    this.podiumDelayTicks = 0;

    r?.resetAudio?.();
    r?.audioSubsystem?.resetAudio?.();
    this.podiumController?.enterPodium?.(winnerTeam, 'SCORE');
    syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
      matchPhase: 'podium', kickoffCountdown: 0, isOvertime: false, winner: winnerTeam, winReason: 'SCORE',
    });
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

  triggerSandboxAction(
    action: string,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    const r = this.runtime;
    const store = useExperimentalMultiBotsStore.getState();
    if (!r?.physics) return;

    switch (action) {
      case 'reset_kickoff': {
        if (replayCtrl.isReplayActive) replayCtrl.endSession(rosterCtrl);
        rosterCtrl.resetMultiCarKickoffSpawns();
        this.beginKickoffCountdown(replayCtrl);
        break;
      }
      case 'score_blue':
      case 'score_orange': {
        const yDir = action === 'score_blue' ? 1 : -1;
        this.countdownTicks = 0;
        this.goalResetTicks = 0;
        this.clockStarted = true;
        if (replayCtrl.isReplayActive) this.completePostGoalOrReplayTransition(rosterCtrl, replayCtrl);
        r.physics.setBallState({ pos: [0, 5050 * yDir, 200], vel: [0, 1200 * yDir, 0], angVel: [0, 0, 0] });
        break;
      }
      case 'force_overtime': {
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
        store.updateLiveTelemetry({ blueScore: tied, orangeScore: tied, remainingSec: 0, isOvertime: true });
        syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
          blueScore: tied, orangeScore: tied, remainingSeconds: 0, isOvertime: true, overtimeSeconds: 0,
        });
        break;
      }
      case 'end_match': {
        if (this.blueScore === this.orangeScore) this.blueScore += 1;
        this.finishMatch(this.blueScore >= this.orangeScore ? 0 : 1, rosterCtrl, replayCtrl);
        break;
      }
      default:
        break;
    }
  }

  stepEndedMatchPodiumDelay(replayCtrl: ExperimentalMultiBotsReplayController): boolean {
    if (this.podiumDelayTicks <= 0) return false;
    if (--this.podiumDelayTicks <= 0) this.enterPodium(replayCtrl);
    return true;
  }

  stepCountdownPhase(currentTick: number, replayCtrl: ExperimentalMultiBotsReplayController): boolean {
    if (this.countdownTicks <= 0) return false;
    const r = this.runtime;
    const store = useExperimentalMultiBotsStore.getState();
    const audio = getExpModeAudio(r);
    const stepRes = stepKickoffCountdownState(this.countdownTicks, this.isOvertime);
    this.countdownTicks = stepRes.nextCountdownTicks;

    if (stepRes.transitionedSecond === 2 || stepRes.transitionedSecond === 1) {
      const sec = stepRes.transitionedSecond;
      this.matchPhase = `kickoff (${sec})`;
      replayCtrl.emitReplaySignal(MATCH_SIGNALS.KICKOFF_WILL_START, this.countdownTicks, sec);
      if (stepRes.audioCue) audio?.play?.(stepRes.audioCue, 1.0);
      store.updateLiveTelemetry({ kickoffCountdownSec: sec, matchPhase: this.matchPhase });
      syncLocalMatchStateToRuntimeAndHud(r?.match?.state, { matchPhase: 'kickoff', kickoffCountdown: sec });
    } else if (stepRes.transitionedSecond === 0) {
      this.matchPhase = this.isOvertime ? 'overtime' : 'playing';
      this.lastKickoffStartTick = currentTick + 1;
      replayCtrl.emitReplaySignal(MATCH_SIGNALS.KICKOFF_START, 0, 0);
      if (stepRes.audioCue) audio?.play?.(stepRes.audioCue, 1.0);
      store.updateLiveTelemetry({ kickoffCountdownSec: 0, matchPhase: this.matchPhase });
      syncLocalMatchStateToRuntimeAndHud(r?.match?.state, { matchPhase: 'playing', kickoffCountdown: 0 });
    }
    return true;
  }

  recordBotStepInference(totalInferenceMs: number): void {
    this.kickoffTick++;
    this.lastStepInferenceMs = totalInferenceMs;
  }

  stepPostGoalFreeze(sim: any, currentTick: number): void {
    this.frozenGoalBallState = stepPostGoalBallFreeze({
      sim,
      goalResetTicks: this.goalResetTicks,
      currentTick,
      goalIncidentTick: this.goalIncidentTick,
      frozenBallState: this.frozenGoalBallState,
    });
  }

  stepPostGoalResetCountdown(
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): boolean {
    if (this.goalResetTicks <= 0) return false;
    if (--this.goalResetTicks <= 0) {
      const store = useExperimentalMultiBotsStore.getState();
      if (!store.disableGoalReplay) {
        const started = replayCtrl.beginGoalReplay(this.getGoalIncidentMeta(), rosterCtrl, () =>
          this.completePostGoalOrReplayTransition(rosterCtrl, replayCtrl)
        );
        if (started) this.matchPhase = 'replay';
      } else {
        replayCtrl.retainGoalReplayBuffer(this.getGoalIncidentMeta(), rosterCtrl.spawnedCars);
        this.completePostGoalOrReplayTransition(rosterCtrl, replayCtrl);
      }
    }
    return true;
  }

  recordGoalScored(
    goalEval: { scoringTeam: 0 | 1; ballSpeedKph: number; ballSpeedUu: number },
    bView: any,
    currentTick: number,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    const r = this.runtime;
    const store = useExperimentalMultiBotsStore.getState();
    const audio = getExpModeAudio(r);
    const scoringTeam = goalEval.scoringTeam;
    this.blueScore += scoringTeam === 0 ? 1 : 0;
    this.orangeScore += scoringTeam === 1 ? 1 : 0;

    const attr = resolveGoalAttribution(
      scoringTeam,
      this.lastTouchByTeam,
      this.prevTouchByTeam,
      rosterCtrl.spawnedCars
    );
    this.goalScorerCarIndex = attr.scorerCarIndex;
    this.goalScorerName = attr.scorerName;
    this.goalScorerTouchTick = attr.scorerTouchTick;
    this.goalAssistName = attr.assistName;
    this.goalIncidentTick = currentTick;
    this.goalScoringTeam = scoringTeam;
    this.goalBallSpeedKph = goalEval.ballSpeedKph;
    this.frozenGoalBallState = null;

    replayCtrl.appendIncident(currentTick, {
      type: INCIDENT_EVENT_TYPES.GOAL_SCORED, tick: currentTick,
      carIndex: this.goalScorerCarIndex, team: scoringTeam,
      posX: bView.posX, posY: bView.posY, posZ: bView.posZ, intensity: goalEval.ballSpeedUu,
    });
    replayCtrl.emitReplaySignal(MATCH_SIGNALS.SCORE_UPDATED, this.blueScore, this.orangeScore, currentTick);
    replayCtrl.appendAudioEvent(currentTick, { cueName: 'sfx_goal_poof', volume: 1.0 });
    audio?.play?.('sfx_goal_poof', 1.0);

    if (this.isOvertime) {
      this.pendingMatchEndAfterReplay = true;
      this.pendingMatchWinner = scoringTeam;
    } else if (this.remainingSec === 0) {
      if (this.blueScore === this.orangeScore) {
        this.pendingOvertimeAfterReplay = true;
      } else {
        this.pendingMatchEndAfterReplay = true;
        this.pendingMatchWinner = this.blueScore > this.orangeScore ? 0 : 1;
      }
    }

    this.goalResetTicks = store.disableGoalReplay ? 140 : POST_GOAL_CELEBRATION_TICKS;
    this.matchPhase = 'GOAL SCORED!';

    store.updateLiveTelemetry({
      blueScore: this.blueScore, orangeScore: this.orangeScore,
      matchPhase: this.matchPhase, isOvertime: this.isOvertime,
    });
    syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
      matchPhase: 'goal', blueScore: this.blueScore, orangeScore: this.orangeScore,
      goalScorerName: this.goalScorerName, goalScoringTeam: scoringTeam,
      goalSpeedKph: goalEval.ballSpeedKph, goalAssistName: this.goalAssistName,
      replayScorerName: this.goalScorerName, replayScorerTeam: scoringTeam,
      replayScorerAnthemId: attr.scorerAnthemId, replayBallSpeedKph: goalEval.ballSpeedKph,
      replayAssistName: this.goalAssistName,
    });
  }

  stepPlayingClock(
    currentTick: number,
    bView: any,
    ballOnGround: boolean,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    replayCtrl: ExperimentalMultiBotsReplayController
  ): void {
    const r = this.runtime;
    const store = useExperimentalMultiBotsStore.getState();
    const audio = getExpModeAudio(r);
    const prevRemSec = this.remainingSec;
    const clockStep = stepMatchClockState({
      clockStarted: this.clockStarted, clockTickAccum: this.clockTickAccum,
      ticksSinceKickoff: this.ticksSinceKickoff, ballMoved: hasKickoffBallMoved(bView),
      ballOnGround, isOvertime: this.isOvertime, remainingSec: this.remainingSec,
      blueScore: this.blueScore, orangeScore: this.orangeScore,
    });

    this.clockStarted = clockStep.clockStarted;
    this.clockTickAccum = clockStep.clockTickAccum;
    this.ticksSinceKickoff = clockStep.ticksSinceKickoff;
    this.remainingSec = clockStep.remainingSec;

    if (clockStep.secondAdvanced) {
      replayCtrl.emitReplaySignal(
        MATCH_SIGNALS.CLOCK_UPDATED_SECONDS, this.remainingSec, this.isOvertime ? 1 : 0, currentTick
      );
      if (clockStep.timeAlertSecond === 60) {
        replayCtrl.emitReplaySignal(MATCH_SIGNALS.TIME_ALERT_60S, 60, 0, currentTick);
      } else if (clockStep.timeAlertSecond === 30) {
        replayCtrl.emitReplaySignal(MATCH_SIGNALS.TIME_ALERT_30S, 30, 0, currentTick);
      } else if (clockStep.timeAlertSecond !== null) {
        replayCtrl.emitReplaySignal(MATCH_SIGNALS.COUNTDOWN_10S, clockStep.timeAlertSecond, 0, currentTick);
      }
      if (clockStep.audioCue) {
        audio?.play?.(clockStep.audioCue, 1.0, clockStep.audioCue === 'match_countdown_10s' ? undefined : 10000);
      }
    }

    if (clockStep.zeroSecondOutcome === 'overtime') {
      this.pendingOvertimeAfterReplay = true;
      rosterCtrl.resetMultiCarKickoffSpawns();
      this.beginKickoffCountdown(replayCtrl);
      return;
    }
    if (clockStep.zeroSecondOutcome === 'blue-wins' || clockStep.zeroSecondOutcome === 'orange-wins') {
      this.finishMatch(clockStep.zeroSecondOutcome === 'blue-wins' ? 0 : 1, rosterCtrl, replayCtrl);
      return;
    }

    const totalInferenceMs = this.lastStepInferenceMs || 0;
    if (this.ticksSinceKickoff % 8 === 0 || this.remainingSec !== prevRemSec) {
      store.updateLiveTelemetry({
        remainingSec: this.remainingSec, isOvertime: this.isOvertime, matchPhase: this.matchPhase,
        lastTotalInferenceMs:
          totalInferenceMs > 0 ? Number(totalInferenceMs.toFixed(3)) : store.lastTotalInferenceMs,
        nextoLoaded: isExperimentalEngineReady('nexto'), nectoLoaded: isExperimentalEngineReady('necto'),
      });
      syncLocalMatchStateToRuntimeAndHud(r?.match?.state, {
        remainingSeconds: this.remainingSec, isOvertime: this.isOvertime,
        overtimeSeconds: this.isOvertime ? this.remainingSec : 0, matchPhase: 'playing',
      });
    }
  }
}

