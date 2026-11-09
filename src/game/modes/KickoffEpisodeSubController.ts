import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import { KICKOFF_SPAWNS } from '../../ui-core/config/trainingDefaults.ts';
import {
  TICKS_PER_DECISION,
  multiDiscreteToOverlayKeys,
  multiDiscreteToKeyString,
} from '../../ai/kickoffEpisodePrimitives.ts';
import {
  KickoffV2SafeTensorsAgent,
  KICKOFF_V1_SETTLE_TICKS,
  preloadKickoffV1BestWeights,
} from '../../ai/KickoffV2SafeTensorsAgent.ts';
import {
  createIsolatedKickoffGhostSim,
  precomputeKickoffGhostTimeline,
  clampKickoffSettledPlayerAndPartnerCars,
  resetKickoffSpawnInPhysics,
  evaluateKickoffPreTickInput,
  stepKickoffAgentControls,
  stepKickoffGhostSimTick,
  scheduleKickoffCountdownSignal,
  detectKickoffPlayerFirstTouch,
  type KickoffGhostPlacement,
  type KickoffSpawnPoint,
  type KickoffCarControls,
} from './kickoffGhostPrecomputePipeline.ts';
import { hudStore, useKickoffTrainingStore } from '../runtimeUiPort.ts';
import { gameAudio } from '../../audio/GameAudioEngineFacade.ts';

export type { KickoffGhostPlacement, KickoffSpawnPoint, KickoffCarControls };
export type KickoffSubMode = 'instant' | 'realistic' | 'easy-learning';
export type KickoffEpisodePhase = 'waiting-for-input' | 'countdown' | 'running' | 'paused-mismatch';

export interface KickoffGhostVisualsPort {
  setGhostPlacement(placement: KickoffGhostPlacement): void;
  setEntityVisibility(showCar: boolean, showBall: boolean): void;
  setVisible(visible: boolean): void;
  resetTrail(): void;
  recordBallTrajectoryPoint(ballView: unknown): void;
  update(
    prevState: Float32Array,
    currState: Float32Array,
    alpha: number,
    dt: number,
    controls: KickoffCarControls
  ): void;
}

export interface KickoffFrameUpdateContext {
  goalScored?: boolean;
  playerCarView?: { boost: number; isBoosting: boolean } | null;
  dt?: number;
}

export interface KickoffEpisodeConfigSnapshot {
  spawnIndex: number;
  subMode: KickoffSubMode;
  ghostPlacement: KickoffGhostPlacement;
  ghostModeEnabled: boolean;
}

export interface KickoffEpisodeConfigPatch {
  spawnIndex?: number;
  subMode?: KickoffSubMode;
  ghostPlacement?: KickoffGhostPlacement;
  ghostModeEnabled?: boolean;
  ghostVisibility?: { showCar: boolean; showBall: boolean };
}

export interface KickoffEpisodeSubControllerDeps {
  getRuntime: () => any;
  getGhostVisuals: () => KickoffGhostVisualsPort | null;
}

const NEUTRAL_CONTROLS: KickoffCarControls = {
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
};

export class KickoffEpisodeSubController {
  private readonly deps: KickoffEpisodeSubControllerDeps;
  private ghostSim: RocketSimPhysicsEngine | null = null;
  private ghostInitPromise: Promise<RocketSimPhysicsEngine> | null = null;
  private ghostPrevState: Float32Array | null = null;
  private ghostCurrState: Float32Array | null = null;
  private readonly ghostAgent = new KickoffV2SafeTensorsAgent({ channelMode: 'keyboard_coupled' });
  private readonly solidAgent = new KickoffV2SafeTensorsAgent({ channelMode: 'keyboard_coupled' });
  private preSettleCar0State: Float32Array | null = null;
  private preSettleCar1State: Float32Array | null = null;

  private spawnIndex = 0;
  private subMode: KickoffSubMode = 'instant';
  private ghostPlacement: KickoffGhostPlacement = 'same';
  private ghostModeEnabled = true;
  private aiTeamSign: 1 | -1 = 1;
  private phase: KickoffEpisodePhase = 'waiting-for-input';
  private episodeTick = 0;
  private countdownTicks = 0;
  private countdownElapsed = 0;
  private readonly latchedSec = new Set<number>();

  private timeline: ReturnType<KickoffV2SafeTensorsAgent['precomputeTimeline']> | null = null;
  private ghostRawCtrl: KickoffCarControls = { ...NEUTRAL_CONTROLS };
  private ghostCtrl: KickoffCarControls = { ...NEUTRAL_CONTROLS };
  private playerTouchedBall = false;
  private playerTouchTick: number | null = null;
  private aiTouchTick: number | null = null;
  private goalResetTicks = 0;
  private readyPromise: Promise<void> | null = null;

  constructor(deps: KickoffEpisodeSubControllerDeps) {
    this.deps = deps;
  }

  public async ensureGhostEngine(): Promise<RocketSimPhysicsEngine> {
    if (this.ghostSim?.isInitialized) return this.ghostSim;
    if (this.ghostInitPromise) return this.ghostInitPromise;
    this.ghostInitPromise = createIsolatedKickoffGhostSim().then((sim) => {
      this.ghostSim = sim;
      this.ghostPrevState = sim.state.slice();
      this.ghostCurrState = sim.state.slice();
      return sim;
    });
    return this.ghostInitPromise;
  }

  public waitForReady(): Promise<void> {
    return this.readyPromise ?? Promise.resolve();
  }

  public onEnter(initialSpawnIndex = 0): void {
    const r = this.deps.getRuntime();
    this.subMode = 'instant';
    this.ghostPlacement = 'same';
    this.ghostModeEnabled = true;
    this.spawnIndex = initialSpawnIndex;
    this.readyPromise = Promise.all([this.ensureGhostEngine(), preloadKickoffV1BestWeights()]).then(
      () => {
        if (r?.match?.state?.mode === 'kickoff-training') this.selectSpawn(this.spawnIndex);
      }
    );
  }

  public onExit(): void {
    this.countdownTicks = 0;
    this.goalResetTicks = 0;
    this.latchedSec.clear();
  }

  public getConfigSnapshot(): KickoffEpisodeConfigSnapshot {
    return {
      spawnIndex: this.spawnIndex,
      subMode: this.subMode,
      ghostPlacement: this.ghostPlacement,
      ghostModeEnabled: this.ghostModeEnabled,
    };
  }

  public applyConfigPatch(patch: KickoffEpisodeConfigPatch): void {
    if (patch.spawnIndex !== undefined) this.spawnIndex = patch.spawnIndex;
    if (patch.subMode !== undefined) {
      this.subMode =
        patch.subMode === 'realistic' || patch.subMode === 'easy-learning'
          ? patch.subMode
          : 'instant';
    }
    if (patch.ghostPlacement !== undefined) {
      this.ghostPlacement = patch.ghostPlacement === 'opposite' ? 'opposite' : 'same';
    }
    if (patch.ghostModeEnabled !== undefined)
      this.ghostModeEnabled = Boolean(patch.ghostModeEnabled);
    if (patch.ghostVisibility) {
      this.deps
        .getGhostVisuals()
        ?.setEntityVisibility(
          this.ghostModeEnabled && Boolean(patch.ghostVisibility.showCar),
          this.ghostModeEnabled && Boolean(patch.ghostVisibility.showBall)
        );
    }
  }

  public selectSpawn(spawnIndex = this.spawnIndex): void {
    const clamped = Math.max(0, Math.min(4, Math.round(spawnIndex)));
    const store = useKickoffTrainingStore.getState();
    this.ghostPlacement = (store.ghostPlacement || 'same') as KickoffGhostPlacement;
    this.ghostModeEnabled = store.ghostModeEnabled ?? true;
    if (!this.ghostModeEnabled && this.ghostPlacement === 'same' && clamped === 2) return;
    this.spawnIndex = clamped;
    if (store.spawnIndex !== clamped) useKickoffTrainingStore.setState({ spawnIndex: clamped });
    this.resetEpisode(clamped);
  }

  public getOpponentControls(): KickoffCarControls | null {
    return !this.ghostModeEnabled ? this.ghostCtrl : null;
  }

  private _resetPlayerCarToSpawn(spawnIndex: number, settleImmediate = true): void {
    const r = this.deps.getRuntime();
    if (!r?.physics) return;
    const neutral = r.neutralControls || NEUTRAL_CONTROLS;
    this.ghostAgent?.reset?.();
    this.solidAgent?.reset?.();

    const res = resetKickoffSpawnInPhysics({
      physics: r.physics,
      arena: r.arena,
      spawnIndex,
      playerCarIndex: r.playerCarIndex ?? 0,
      selectedHitbox: r.selectedHitbox || 'default',
      neutralControls: neutral,
      ghostModeEnabled: this.ghostModeEnabled,
      ghostPlacement: this.ghostPlacement,
      settleImmediate,
    });
    this.aiTeamSign = res.aiTeamSign;
    this.preSettleCar0State = res.preSettleCar0State;
    this.preSettleCar1State = res.preSettleCar1State;

    r.ballTrajectoryPredictor?.clear?.();
    r.audioSubsystem?.resetAudio?.();
    r.arena?.resetBallTrail?.();
    r.camera?.resetView?.();
    r.interpolator?.sync?.();
  }

  private _syncMatchAndHudPhase(r: any, phase: 'kickoff' | 'playing', countdown: number): void {
    if (r?.match) {
      r.match.state.phase = phase;
      r.match.state.countdown = countdown;
    }
    hudStore.getState().setMatchState({ matchPhase: phase, kickoffCountdown: countdown });
  }

  public resetEpisode(spawnIndex = this.spawnIndex): void {
    const r = this.deps.getRuntime();
    const ghostVisuals = this.deps.getGhostVisuals();
    const store = useKickoffTrainingStore.getState();
    const neutral = r?.neutralControls || NEUTRAL_CONTROLS;

    this.subMode = (store.subMode || 'instant') as KickoffSubMode;
    this.ghostPlacement = (store.ghostPlacement || 'same') as KickoffGhostPlacement;
    this.ghostModeEnabled = store.ghostModeEnabled ?? true;
    this.episodeTick = 0;
    this.playerTouchedBall = false;
    this.playerTouchTick = null;
    this.goalResetTicks = 0;
    this.ghostRawCtrl = { ...neutral };
    this.ghostCtrl = { ...neutral };

    if (this.ghostSim?.isInitialized && this.ghostPrevState && this.ghostCurrState) {
      const pre = precomputeKickoffGhostTimeline(
        this.ghostSim,
        this.ghostAgent,
        spawnIndex,
        this.ghostPrevState,
        this.ghostCurrState,
        95
      );
      this.timeline = pre.timeline;
      this.aiTouchTick = pre.aiTouchTick;
    }

    ghostVisuals?.setGhostPlacement(this.ghostPlacement);
    ghostVisuals?.setVisible(this.ghostModeEnabled);
    ghostVisuals?.resetTrail();

    const isRealistic = this.subMode === 'realistic';
    const waitTicks = isRealistic ? store.realisticWaitTicks || 480 : 0;
    this.phase = isRealistic ? 'countdown' : 'waiting-for-input';
    this.countdownTicks = waitTicks;
    this.countdownElapsed = 0;
    this.latchedSec.clear();
    this._resetPlayerCarToSpawn(spawnIndex, !isRealistic);
    if (isRealistic) {
      this._syncMatchAndHudPhase(
        r,
        'kickoff',
        scheduleKickoffCountdownSignal(r?.physics, waitTicks)
      );
    } else {
      r?.physics?.setSimulationFrozen?.(true, 0, true);
      this._syncMatchAndHudPhase(r, 'playing', 0);
    }

    const reqAct = this.timeline?.steps?.[0]?.action || [2, 1, 1, 0, 1, 0];
    store.updateLiveState({
      phase: this.phase,
      episodeTick: 0,
      decisionStep: 0,
      countdownRemainingTicks: this.countdownTicks,
      requiredAction: reqAct,
      requiredKeys: multiDiscreteToOverlayKeys(reqAct),
      requiredKeyStr: multiDiscreteToKeyString(reqAct),
      timeline: this.timeline,
      aiTouchTick: this.aiTouchTick,
      playerTouchTick: null,
      lastDeltaTicks: null,
      isInputMatching: true,
    });
  }

  public onBeforePhysicsTick(): boolean {
    const r = this.deps.getRuntime();
    const {
      stepIdx,
      requiredAction,
      requiredKeys,
      requiredKeyStr,
      playerAction,
      playerKeys,
      isMatching,
      isAnyKeyPressed,
    } = evaluateKickoffPreTickInput(
      r.playerControls,
      this.episodeTick,
      TICKS_PER_DECISION,
      this.timeline
    );
    const basePatch = { playerAction, playerKeys, requiredAction, requiredKeys, requiredKeyStr };
    const liveStore = useKickoffTrainingStore.getState();

    if (this.phase === 'countdown') {
      r.physics.setControls(r.playerCarIndex, r.neutralControls);
      if (!this.ghostModeEnabled && r.physics.numCars >= 2)
        r.physics.setControls(1, r.neutralControls);
      liveStore.updateLiveState({
        ...basePatch,
        phase: 'countdown',
        countdownRemainingTicks: this.countdownTicks,
      });
      return true;
    }
    if (this.subMode === 'instant' && this.phase === 'waiting-for-input') {
      if (!isAnyKeyPressed) {
        r.physics.setSimulationFrozen(true, 0, true);
        liveStore.updateLiveState({
          ...basePatch,
          phase: 'waiting-for-input',
          isInputMatching: false,
        });
        return true;
      }
      this.phase = 'running';
      r.physics.setSimulationFrozen(false, 0, false);
      r.physics.setControls(r.playerCarIndex, r.playerControls);
    }
    if (this.subMode === 'easy-learning') {
      if (
        !this.playerTouchedBall &&
        this.timeline &&
        stepIdx < this.timeline.steps.length &&
        !isMatching
      ) {
        this.phase = 'paused-mismatch';
        r.physics.setSimulationFrozen(true, 0, false);
        liveStore.updateLiveState({
          ...basePatch,
          phase: 'paused-mismatch',
          episodeTick: this.episodeTick,
          decisionStep: stepIdx,
          isInputMatching: false,
        });
        return false;
      }
      if (this.phase !== 'running') {
        this.phase = 'running';
        r.physics.setSimulationFrozen(false, 0, false);
      }
    }

    liveStore.updateLiveState({
      ...basePatch,
      phase: this.phase,
      episodeTick: this.episodeTick,
      decisionStep: stepIdx,
      isInputMatching: isMatching,
    });
    return true;
  }

  public step(): boolean {
    const r = this.deps.getRuntime();
    const ghostVisuals = this.deps.getGhostVisuals();
    const audio = r.options?.gameAudio || gameAudio;

    if (this.phase === 'countdown') {
      r.physics.step(1);
      this.countdownElapsed++;
      const rem = (this.countdownTicks = Math.max(0, this.countdownTicks - 1));

      if (this.countdownElapsed === KICKOFF_V1_SETTLE_TICKS && r.physics) {
        clampKickoffSettledPlayerAndPartnerCars(
          r.physics,
          r.playerCarIndex ?? 0,
          this.spawnIndex,
          KICKOFF_SPAWNS[this.spawnIndex] || KICKOFF_SPAWNS[0],
          this.ghostModeEnabled,
          this.ghostPlacement,
          this.preSettleCar0State,
          this.preSettleCar1State
        );
        if (rem > 0) r.physics.setSimulationFrozen(true, 0, true);
      }

      const displaySec = rem > 0 ? Math.min(4, Math.ceil(rem / 120)) : 0;
      if (r.match && r.match.state.countdown !== displaySec) {
        this._syncMatchAndHudPhase(r, rem > 0 ? 'kickoff' : 'playing', displaySec);
      }

      const sec = Math.ceil(rem / 120);
      if (rem > 0 && sec <= 3 && !this.latchedSec.has(sec)) {
        this.latchedSec.add(sec);
        audio?.play?.('match_countdown_321', 1.0);
      }

      if (rem <= 0) {
        this.phase = 'running';
        r.physics.setSimulationFrozen(false, 0, false);
        this._syncMatchAndHudPhase(r, 'playing', 0);
        audio?.play?.('match_start_go', 1.0);
      }
      return true;
    }

    if (this.phase === 'waiting-for-input') {
      r.physics.step(1);
      return true;
    }

    if (!this.ghostModeEnabled && r.physics.numCars >= 2) {
      const solidStep = stepKickoffAgentControls(
        this.solidAgent,
        r.physics,
        1,
        this.aiTeamSign < 0,
        this.episodeTick,
        TICKS_PER_DECISION,
        this.ghostRawCtrl
      );
      this.ghostRawCtrl = solidStep.rawControls;
      this.ghostCtrl = solidStep.sanitizedControls;
    }

    r.physics.step(1);

    if (
      this.ghostModeEnabled &&
      this.ghostSim?.isInitialized &&
      this.ghostPrevState &&
      this.ghostCurrState
    ) {
      const ghostStep = stepKickoffGhostSimTick(
        this.ghostSim,
        this.ghostAgent,
        this.episodeTick,
        TICKS_PER_DECISION,
        this.ghostRawCtrl,
        this.ghostPrevState,
        this.ghostCurrState
      );
      this.ghostRawCtrl = ghostStep.rawControls;
      this.ghostCtrl = ghostStep.sanitizedControls;
      ghostVisuals?.recordBallTrajectoryPoint(ghostStep.ballView);
    }

    this.episodeTick++;

    if (
      !this.playerTouchedBall &&
      detectKickoffPlayerFirstTouch(r.physics, this.ghostModeEnabled)
    ) {
      this.playerTouchedBall = true;
      this.playerTouchTick = this.episodeTick;
      useKickoffTrainingStore.getState().updateLiveState({
        playerTouchTick: this.playerTouchTick,
        lastDeltaTicks: this.aiTouchTick ? this.playerTouchTick - this.aiTouchTick : 0,
      });
    }

    if (this.goalResetTicks > 0 && --this.goalResetTicks === 0) {
      this.resetEpisode(this.spawnIndex);
    }
    return true;
  }

  public updateFrame(context: KickoffFrameUpdateContext): void {
    const r = this.deps.getRuntime();
    const ghostVisuals = this.deps.getGhostVisuals();
    const { goalScored, playerCarView, dt } = context;

    if (goalScored && this.goalResetTicks === 0) this.goalResetTicks = 54;
    if (playerCarView)
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, false);
    if (this.ghostModeEnabled && ghostVisuals && this.ghostPrevState && this.ghostCurrState) {
      ghostVisuals.update(
        this.ghostPrevState,
        this.ghostCurrState,
        r.interpolator?.alpha ?? 0,
        dt ?? 0.016,
        this.ghostCtrl
      );
    }
  }
}
