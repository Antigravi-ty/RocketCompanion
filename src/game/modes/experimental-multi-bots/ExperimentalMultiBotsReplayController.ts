import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.ts';
import {
  ReplayRingBuffer,
  REPLAY_BUFFER_MODES,
  COUNTDOWN_REPLAY_CAPACITY_TICKS,
  type ReplayAcknowledgedControlEntry,
  type ReplayAudioCue,
  type ReplayRecordedIncident,
} from '../../../replay/ReplayRingBuffer.ts';
import { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import { retainCompletedMatchReplayAndNotify } from '../../../replay/ReplayFileExporter.ts';
import { MATCH_SIGNALS } from '../../../physics/RocketSimConstants.ts';
import { useExperimentalMultiBotsStore, hudStore } from '../../runtimeUiPort.ts';
import {
  beginGoalReplaySession,
  endGoalReplaySession,
  stepGoalReplaySessionFrame,
} from '../shared/GoalReplaySessionCoordinator.ts';
import {
  type ExpGoalIncidentMeta,
  type ExpModeRuntimePort,
  type ExpReplaySignal,
  type ExpSpawnedCarEntry,
  MAX_GOAL_LOOKBACK_SECONDS,
  SCORER_TOUCH_LOOKBACK_SECONDS,
  buildExpCarEntriesForReplay,
  buildExpRosterForExport,
} from './ExperimentalMultiBotsMatchMath.ts';
import { ExperimentalMultiBotsRosterController } from './ExperimentalMultiBotsRosterController.ts';

export class ExperimentalMultiBotsReplayController {
  private readonly runtime: ExpModeRuntimePort | null;
  public readonly replayRingBuffer: ReplayRingBuffer;
  public readonly replayController: ReplayTimelineController;

  public isReplayActive = false;
  public replayCameraMode: 'director' | 'pov' = 'director';
  public replayPovCarIndex = 0;

  private nextReplaySignalId = 1;
  private readonly pendingFrameSignals: ExpReplaySignal[] = [];

  private activeGoalMeta: ExpGoalIncidentMeta = {
    goalIncidentTick: -1,
    goalScoringTeam: 0,
    goalScorerCarIndex: 0,
    goalScorerName: null,
    goalScorerTouchTick: -1,
    goalAssistName: null,
    goalBallSpeedKph: null,
    lastKickoffStartTick: 0,
  };

  constructor(runtime: ExpModeRuntimePort | null) {
    this.runtime = runtime;
    this.replayRingBuffer = new ReplayRingBuffer({
      mode: REPLAY_BUFFER_MODES.COUNTDOWN_MATCH,
      capacityTicks: COUNTDOWN_REPLAY_CAPACITY_TICKS,
    });
    this.replayController = new ReplayTimelineController({
      engine: runtime?.physics || null,
      ringBuffer: this.replayRingBuffer,
    });
  }

  attachPhysicsIfNeeded(): void {
    const sim = this.runtime?.physics;
    if (sim && this.replayController.engine !== sim) {
      this.replayController.attach(sim, this.replayRingBuffer);
    }
  }

  clearSignalsAndBuffer(): void {
    this.pendingFrameSignals.length = 0;
    this.replayRingBuffer?.clear?.();
  }

  clearPendingSignals(): void {
    this.pendingFrameSignals.length = 0;
  }

  pushSignalToPhysicsEngine(sig: ExpReplaySignal): void {
    const sim = this.runtime?.physics;
    if (!sim || typeof sim.pushSignalEvent !== 'function') return;
    sim.pushSignalEvent(
      sig.signalType,
      0,
      sig.param1 | 0,
      sig.param2 | 0,
      0,
      0,
      sig.frameId,
      sig.param1,
      sig.param2,
      sig.signalId,
      0,
      0,
      0,
      0
    );
  }

  emitReplaySignal(
    signalType: number,
    param1 = 0,
    param2 = 0,
    explicitTick: number | null = null
  ): ExpReplaySignal {
    const sim = this.runtime?.physics;
    if (explicitTick !== null) {
      const targetTick = Math.floor(explicitTick);
      const sig: ExpReplaySignal = {
        signalId: this.nextReplaySignalId++,
        signalType,
        frameId: targetTick,
        param1,
        param2,
      };
      this.pushSignalToPhysicsEngine(sig);
      const slot = this.replayRingBuffer?.findFrameByTick?.(targetTick);
      if (slot) {
        this.replayRingBuffer.appendSignal(targetTick, sig);
      } else {
        this.pendingFrameSignals.push(sig);
      }
      return sig;
    }

    const nextTick = Math.floor(sim?.getHeaderView?.()?.tickCount ?? 0) + 1;
    const sig: ExpReplaySignal = {
      signalId: this.nextReplaySignalId++,
      signalType,
      frameId: nextTick,
      param1,
      param2,
    };
    this.pendingFrameSignals.push(sig);
    return sig;
  }

  flushPendingSignalsAndRecordFrame(
    currentTick: number,
    state: Float32Array,
    acknowledgedControls: ReplayAcknowledgedControlEntry[]
  ): void {
    const pending =
      this.pendingFrameSignals.length > 0 ? this.pendingFrameSignals.slice() : [];
    this.pendingFrameSignals.length = 0;
    for (let s = 0; s < pending.length; s++) {
      pending[s].frameId = currentTick;
      this.pushSignalToPhysicsEngine(pending[s]);
    }
    this.replayRingBuffer.recordFrame(currentTick, state, {
      acknowledgedControls,
      signals: pending,
    });
  }

  appendIncident(tick: number, event: ReplayRecordedIncident): void {
    this.replayRingBuffer?.appendIncident?.(tick, event);
  }

  appendAudioEvent(tick: number, audioEvt: ReplayAudioCue): void {
    this.replayRingBuffer?.appendAudioEvent?.(tick, audioEvt);
  }

  retainGoalReplayBuffer(
    goalMeta: ExpGoalIncidentMeta,
    spawnedCars: ReadonlyArray<ExpSpawnedCarEntry>
  ): number {
    const sim = this.runtime?.physics;
    if (!this.replayRingBuffer || this.replayRingBuffer.size === 0) return 0;
    const currentTick = Math.floor(
      sim?.getHeaderView?.()?.tickCount ??
        this.replayRingBuffer.getNewestFrame?.()?.tick ??
        0
    );
    const goalTick =
      goalMeta.goalIncidentTick > 0 ? goalMeta.goalIncidentTick : currentTick;
    const postGoalTicks = Math.max(0, currentTick - goalTick);
    this.attachPhysicsIfNeeded();

    const extractedFrames = extractGoalReplayFrames({
      ringBuffer: this.replayRingBuffer,
      engine: null,
      goalIncidentTick: goalTick,
      scorerTouchTick: goalMeta.goalScorerTouchTick,
      lookbackSeconds: MAX_GOAL_LOOKBACK_SECONDS,
      touchLookbackSeconds: SCORER_TOUCH_LOOKBACK_SECONDS,
      postGoalTicks,
      lastKickoffWillStartTick: goalMeta.lastKickoffStartTick,
    });
    if (!Array.isArray(extractedFrames) || extractedFrames.length === 0) return 0;
    const carEntries = buildExpCarEntriesForReplay(spawnedCars);
    return this.replayController.retainReplaySessionFrames({
      scoringTeam: goalMeta.goalScoringTeam ?? 0,
      scorerCarIndex: goalMeta.goalScorerCarIndex ?? 0,
      carTeamResolver: (c: number) => {
        const entry = spawnedCars.find((e) => e.carIndex === c);
        return entry ? entry.team : c % 2;
      },
      carEntries,
      frames: extractedFrames,
    });
  }

  retainMatchReplayAndNotify(params: {
    winnerTeam: 0 | 1;
    blueScore: number;
    orangeScore: number;
    configuredDuration: number;
    goalMeta: ExpGoalIncidentMeta;
    spawnedCars: ReadonlyArray<ExpSpawnedCarEntry>;
  }): void {
    const simState = this.runtime?.physics?.state || null;
    if ((!this.replayRingBuffer || this.replayRingBuffer.size === 0) && !simState) return;
    if (
      params.goalMeta.goalIncidentTick > 0 &&
      this.replayRingBuffer &&
      this.replayRingBuffer.size > 0 &&
      (!this.replayController || this.replayController.ActiveWindowCount <= 0)
    ) {
      this.retainGoalReplayBuffer(params.goalMeta, params.spawnedCars);
    }
    const blueCount = params.spawnedCars.filter((c) => c.team === 0).length || 1;
    const orangeCount = params.spawnedCars.filter((c) => c.team === 1).length || 1;
    const roster = buildExpRosterForExport(params.spawnedCars);
    retainCompletedMatchReplayAndNotify({
      ringBuffer: this.replayRingBuffer,
      fallbackState: simState,
      winnerTeam: params.winnerTeam,
      blueScore: params.blueScore,
      orangeScore: params.orangeScore,
      gameMode: `${blueCount}v${orangeCount}`,
      durationSeconds: params.configuredDuration ?? 300,
      roster,
      loadouts: roster,
    });
  }

  beginGoalReplay(
    goalMeta: ExpGoalIncidentMeta,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    onCompleteTransition: () => void
  ): boolean {
    const r = this.runtime;
    const sim = r?.physics;
    const store = useExperimentalMultiBotsStore.getState();
    if (r) {
      r._localSkipReplayReady = false;
    }
    if (!sim || !this.replayRingBuffer || this.replayRingBuffer.size === 0) {
      onCompleteTransition();
      return false;
    }

    this.activeGoalMeta = { ...goalMeta };
    const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
    const goalTick =
      goalMeta.goalIncidentTick > 0 ? goalMeta.goalIncidentTick : currentTick;
    const postGoalTicks = Math.max(0, currentTick - goalTick);
    this.emitReplaySignal(
      MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
      goalMeta.goalScoringTeam ?? 0,
      goalMeta.goalScorerCarIndex ?? 0,
      currentTick
    );

    this.attachPhysicsIfNeeded();

    const extractedFrames = extractGoalReplayFrames({
      ringBuffer: this.replayRingBuffer,
      engine: null,
      goalIncidentTick: goalTick,
      scorerTouchTick: goalMeta.goalScorerTouchTick,
      lookbackSeconds: MAX_GOAL_LOOKBACK_SECONDS,
      touchLookbackSeconds: SCORER_TOUCH_LOOKBACK_SECONDS,
      postGoalTicks,
      lastKickoffWillStartTick: goalMeta.lastKickoffStartTick,
    });

    if (!Array.isArray(extractedFrames) || extractedFrames.length === 0) {
      onCompleteTransition();
      return false;
    }

    const carEntries = buildExpCarEntriesForReplay(rosterCtrl.spawnedCars);
    const totalFrames = this.replayController.beginReplaySession({
      scoringTeam: goalMeta.goalScoringTeam,
      scorerCarIndex: goalMeta.goalScorerCarIndex,
      carTeamResolver: (c: number) => {
        const entry = rosterCtrl.spawnedCars.find((e) => e.carIndex === c);
        return entry ? entry.team : c % 2;
      },
      carEntries,
      frames: extractedFrames,
    });

    if (carEntries.length > 0) {
      this.replayController.sessionState.carEntries = carEntries;
    }

    this.isReplayActive = true;
    this.replayCameraMode = 'director';
    this.replayPovCarIndex = goalMeta.goalScorerCarIndex;

    if (r?.match?.state) {
      r.match.state.phase = 'replay';
    }

    rosterCtrl.applyCameraCarIndex(goalMeta.goalScorerCarIndex);
    store.updateLiveTelemetry({
      matchPhase: 'GOAL REPLAY',
      activeCameraCarIndex: goalMeta.goalScorerCarIndex,
    });

    const scorerCarEntry = rosterCtrl.spawnedCars.find(
      (e) => e.carIndex === goalMeta.goalScorerCarIndex
    );
    const scorerAnthemId = scorerCarEntry?.anthemId || null;

    beginGoalReplaySession(r, this.replayController, {
      cameraMode: 'director',
      source: 'exp-multi-bots-replay',
      initialSnapshot: extractedFrames[0].snapshot,
      totalFrames,
      scoringTeam: goalMeta.goalScoringTeam,
      scorerCarIndex: goalMeta.goalScorerCarIndex,
      scorerName: goalMeta.goalScorerName,
      scorerTeam: goalMeta.goalScoringTeam,
      scorerAnthemId,
      ballSpeedKph: goalMeta.goalBallSpeedKph,
      assistName: goalMeta.goalAssistName,
      choreographySignal: 'goal-replay-started',
      getCameraMode: () => this.replayCameraMode,
      setCameraMode: (nextMode) => {
        this.replayCameraMode = nextMode;
      },
      getScoringTeam: () => this.activeGoalMeta.goalScoringTeam,
      getScorerCarIndex: () => this.activeGoalMeta.goalScorerCarIndex,
      getPovCarIndex: () =>
        typeof this.replayPovCarIndex === 'number'
          ? this.replayPovCarIndex
          : this.activeGoalMeta.goalScorerCarIndex,
      setPovCarIndex: (carIdx) => {
        if (typeof carIdx === 'number') {
          this.replayPovCarIndex = carIdx;
        }
      },
      onApplyPovCarIndex: (carIdx) => {
        this.replayPovCarIndex = rosterCtrl.applyCameraCarIndex(carIdx);
        store.setActiveCameraCarIndex(this.replayPovCarIndex);
      },
    });

    return true;
  }

  endSession(rosterCtrl: ExperimentalMultiBotsRosterController): void {
    const r = this.runtime;
    endGoalReplaySession(r, this.replayController, {
      source: 'exp-multi-bots-replay',
      clearHud: false,
    });
    this.isReplayActive = false;
    if (r) {
      r._localSkipReplayReady = false;
      if (r.match?.state?.phase === 'replay') {
        r.match.state.phase = 'kickoff';
      }
    }
    if (hudStore.getState().matchPhase === 'replay') {
      hudStore.getState().setMatchState({ matchPhase: 'kickoff' });
    }
    const restoreCamIdx = rosterCtrl.resolveDefaultCameraCarIndex();
    rosterCtrl.applyCameraCarIndex(restoreCamIdx);
  }

  stepUpdate(
    context: Record<string, unknown>,
    unlimited: boolean,
    rosterCtrl: ExperimentalMultiBotsRosterController,
    onCompleteTransition: () => void
  ): void {
    const r = this.runtime;
    const povCarIdx =
      this.replayCameraMode === 'pov' && typeof this.replayPovCarIndex === 'number'
        ? this.replayPovCarIndex
        : this.activeGoalMeta.goalScorerCarIndex;
    this.replayPovCarIndex = rosterCtrl.applyCameraCarIndex(povCarIdx);

    stepGoalReplaySessionFrame({
      runtime: r,
      replayController: this.replayController,
      context,
      source: 'exp-multi-bots-replay',
      cameraMode: this.replayCameraMode,
      scoringTeam: this.activeGoalMeta.goalScoringTeam,
      scorerCarIndex: this.activeGoalMeta.goalScorerCarIndex,
      povCarIndex: this.replayPovCarIndex,
      isUnlimitedBoost: unlimited,
      onStepAfterEvents: () => {
        for (const entry of rosterCtrl.spawnedCars) {
          const cv = r?.interpolator?.getCurrCarStateView?.(entry.carIndex);
          if (cv) {
            const fwdSpeed = cv.velX * cv.fwdX + cv.velY * cv.fwdY + cv.velZ * cv.fwdZ;
            rosterCtrl.carControlsMap.set(entry.carIndex, {
              throttle: Math.abs(fwdSpeed) > 25 ? (fwdSpeed > 0 ? 1 : -1) : 0,
              steer: 0,
              pitch: 0,
              yaw: 0,
              roll: 0,
              jump: Boolean(cv.isJumping),
              boost: Boolean(cv.isBoosting),
              handbrake: false,
            });
          }
        }
      },
      onComplete: () => {
        onCompleteTransition();
      },
    });
  }
}
