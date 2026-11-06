/**
 * KickoffEpisodeSubController.ts
 * Stateful sub-controller for KickoffTrainingMode managing the countdown/guided/instant
 * episode state machine and per-tick physics stepping, delegating spawn setup,
 * suspension settling clamping, and dual-world PPO ghost timeline precomputation
 * to kickoffGhostPrecomputePipeline.ts.
 */

import { MATCH_SIGNALS } from '../../physics/RocketSimConstants.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import {
  KICKOFF_SPAWNS,
  TICKS_PER_DECISION,
  controlsToMultiDiscrete,
  multiDiscreteToOverlayKeys,
  multiDiscreteToKeyString,
  areMultiDiscreteActionsEqual,
} from '../../ai/KickoffPPOAgent.ts';
import {
  KickoffV2SafeTensorsAgent,
  KICKOFF_V1_SETTLE_TICKS,
  preloadKickoffV1BestWeights,
} from '../../ai/KickoffV2SafeTensorsAgent.ts';
import {
  createIsolatedKickoffGhostSim,
  precomputeKickoffGhostTimeline,
  clampKickoffSettledCarInPhysics,
  clampKickoffSettledPlayerAndPartnerCars,
  resetKickoffSpawnInPhysics,
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
  throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0,
  jump: false, boost: false, handbrake: false,
};

export class KickoffEpisodeSubController {
  private readonly deps: KickoffEpisodeSubControllerDeps;

  public ghostSim: RocketSimPhysicsEngine | null = null;
  public ghostInitPromise: Promise<RocketSimPhysicsEngine> | null = null;
  public ghostPrevState: Float32Array | null = null;
  public ghostCurrState: Float32Array | null = null;
  public readonly ghostAgent: KickoffV2SafeTensorsAgent;
  public readonly solidAgent: KickoffV2SafeTensorsAgent;
  public preSettleCar0State: Float32Array | null = null;
  public preSettleCar1State: Float32Array | null = null;

  public spawnIndex: number = 0;
  public subMode: KickoffSubMode = 'instant';
  public ghostPlacement: KickoffGhostPlacement = 'same';
  public ghostModeEnabled: boolean = true;
  public aiTeamSign: 1 | -1 = 1;
  public phase: KickoffEpisodePhase = 'waiting-for-input';
  public episodeTick: number = 0;
  public countdownTicksRemaining: number = 0;
  public countdownElapsedTicks: number = 0;
  public readonly latchedCountdownSeconds: Set<number> = new Set();

  public timeline: ReturnType<KickoffV2SafeTensorsAgent['precomputeTimeline']> | null = null;
  public currentGhostRawControls: KickoffCarControls = { ...NEUTRAL_CONTROLS };
  public currentGhostControls: KickoffCarControls = { ...NEUTRAL_CONTROLS };
  public playerTouchedBall: boolean = false;
  public playerTouchTick: number | null = null;
  public aiTouchTick: number | null = null;
  public postTouchResetTimer: number = 0;
  public goalResetTicksRemaining: number = 0;

  constructor(deps: KickoffEpisodeSubControllerDeps) {
    this.deps = deps;
    this.ghostAgent = new KickoffV2SafeTensorsAgent({ channelMode: 'keyboard_coupled' });
    this.solidAgent = new KickoffV2SafeTensorsAgent({ channelMode: 'keyboard_coupled' });
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

  public onEnter(initialSpawnIndex: number = 0): void {
    const r = this.deps.getRuntime();
    this.subMode = 'instant';
    this.ghostPlacement = 'same';
    this.ghostModeEnabled = true;
    this.spawnIndex = initialSpawnIndex;

    Promise.all([this.ensureGhostEngine(), preloadKickoffV1BestWeights()]).then(() => {
      if (r?.match?.state?.mode === 'kickoff-training') {
        this.selectSpawn(this.spawnIndex);
      }
    });
  }

  public onExit(): void {
    this.countdownTicksRemaining = 0;
    this.goalResetTicksRemaining = 0;
    this.latchedCountdownSeconds.clear();
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
    if (patch.subMode !== undefined) this.setSubMode(patch.subMode);
    if (patch.ghostPlacement !== undefined) this.setGhostPlacement(patch.ghostPlacement);
    if (patch.ghostModeEnabled !== undefined) this.setGhostModeEnabled(patch.ghostModeEnabled);
    if (patch.ghostVisibility) {
      this.setGhostEntityVisibility(patch.ghostVisibility.showCar, patch.ghostVisibility.showBall);
    }
  }

  public setSubMode(nextSubMode: KickoffSubMode): void {
    this.subMode = nextSubMode === 'realistic' || nextSubMode === 'easy-learning' ? nextSubMode : 'instant';
  }

  public setGhostPlacement(placement: KickoffGhostPlacement): void {
    this.ghostPlacement = placement === 'opposite' ? 'opposite' : 'same';
  }

  public setGhostModeEnabled(enabled: boolean): void {
    this.ghostModeEnabled = Boolean(enabled);
  }

  public setGhostEntityVisibility(showCar: boolean, showBall: boolean): void {
    const gv = this.deps.getGhostVisuals();
    if (!gv) return;
    gv.setEntityVisibility(this.ghostModeEnabled && Boolean(showCar), this.ghostModeEnabled && Boolean(showBall));
  }

  public selectSpawn(spawnIndex: number = this.spawnIndex): void {
    const clamped = Math.max(0, Math.min(4, Math.round(spawnIndex)));
    const store = useKickoffTrainingStore.getState();
    this.ghostPlacement = (store.ghostPlacement || 'same') as KickoffGhostPlacement;
    this.ghostModeEnabled = store.ghostModeEnabled ?? true;

    if (!this.ghostModeEnabled && this.ghostPlacement === 'same' && clamped === 2) return;

    this.spawnIndex = clamped;
    if (store.spawnIndex !== clamped) useKickoffTrainingStore.setState({ spawnIndex: clamped });
    this.resetEpisode(clamped);
  }

  public clampSettledCar(
    carIdx: number, spawn: KickoffSpawnPoint, teamSign: number = 1, preSettleState: Float32Array | null = null
  ): void {
    const r = this.deps.getRuntime();
    if (!r?.physics) return;
    clampKickoffSettledCarInPhysics(r.physics, carIdx, spawn, teamSign, preSettleState);
  }

  public clampSettledPlayerCar(spawn: KickoffSpawnPoint): void {
    const r = this.deps.getRuntime();
    if (!r?.physics) return;
    clampKickoffSettledPlayerAndPartnerCars(
      r.physics, r.playerCarIndex ?? 0, this.spawnIndex, spawn,
      this.ghostModeEnabled, this.ghostPlacement, this.preSettleCar0State, this.preSettleCar1State
    );
  }

  public resetPlayerCarToSpawn(spawnIndex: number, settleImmediate: boolean = true): void {
    const r = this.deps.getRuntime();
    if (!r?.physics) return;

    const neutral = r.neutralControls || NEUTRAL_CONTROLS;
    this.ghostAgent?.reset?.();
    this.solidAgent?.reset?.();

    const resetResult = resetKickoffSpawnInPhysics({
      physics: r.physics, arena: r.arena, spawnIndex,
      playerCarIndex: r.playerCarIndex ?? 0, selectedHitbox: r.selectedHitbox || 'default',
      neutralControls: neutral, ghostModeEnabled: this.ghostModeEnabled,
      ghostPlacement: this.ghostPlacement, settleImmediate,
    });
    this.aiTeamSign = resetResult.aiTeamSign;
    this.preSettleCar0State = resetResult.preSettleCar0State;
    this.preSettleCar1State = resetResult.preSettleCar1State;

    r.botControls = { ...neutral };
    r.ballTrajectoryPredictor?.clear?.();
    r.audioSubsystem?.resetAudio?.();
    r.arena?.resetBallTrail?.();
    r.camera?.resetView?.();
    r.interpolator?.sync?.();
  }

  public resetEpisode(spawnIndex: number = this.spawnIndex): void {
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
    this.postTouchResetTimer = 0;
    this.goalResetTicksRemaining = 0;
    this.currentGhostRawControls = { ...neutral };
    this.currentGhostControls = { ...neutral };
    if (r) r.botControls = { ...neutral };

    if (this.ghostSim?.isInitialized && this.ghostPrevState && this.ghostCurrState) {
      const precomputed = precomputeKickoffGhostTimeline(
        this.ghostSim,
        this.ghostAgent,
        spawnIndex,
        this.ghostPrevState,
        this.ghostCurrState,
        95
      );
      this.timeline = precomputed.timeline;
      this.aiTouchTick = precomputed.aiTouchTick;
    }

    if (ghostVisuals) {
      ghostVisuals.setGhostPlacement(this.ghostPlacement);
      ghostVisuals.setVisible(this.ghostModeEnabled);
      ghostVisuals.resetTrail();
    }

    if (this.subMode === 'realistic') {
      const waitTicks = store.realisticWaitTicks || 480;
      this.phase = 'countdown';
      this.countdownTicksRemaining = waitTicks;
      this.countdownElapsedTicks = 0;
      this.latchedCountdownSeconds.clear();

      this.resetPlayerCarToSpawn(spawnIndex, false);
      r?.physics?.setSimulationFrozen?.(false, 0, true);

      const curTick = Math.floor(r?.physics?.getHeaderView?.()?.tickCount ?? 0);
      const targetTick = curTick + waitTicks;
      r?.physics?.pushSignalEvent?.(
        MATCH_SIGNALS.KICKOFF_WILL_START,
        curTick, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetTick
      );

      const displaySec = Math.min(4, Math.ceil(waitTicks / 120));
      if (r?.match) {
        r.match.state.phase = 'kickoff';
        r.match.state.countdown = displaySec;
      }
      hudStore.getState().setMatchState({ matchPhase: 'kickoff', kickoffCountdown: displaySec });
    } else {
      this.resetPlayerCarToSpawn(spawnIndex, true);
      this.phase = 'waiting-for-input';
      this.countdownTicksRemaining = 0;

      r?.physics?.setSimulationFrozen?.(true, 0, true);

      if (r?.match) {
        r.match.state.phase = 'playing';
        r.match.state.countdown = 0;
      }
      hudStore.getState().setMatchState({ matchPhase: 'playing', kickoffCountdown: 0 });
    }

    const firstStep = this.timeline?.steps?.[0];
    const reqAct = firstStep ? firstStep.action : [2, 1, 1, 0, 1, 0];
    store.updateLiveState({
      phase: this.phase,
      episodeTick: 0,
      decisionStep: 0,
      countdownRemainingTicks: this.countdownTicksRemaining,
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
    const playerAction = controlsToMultiDiscrete(r.playerControls);
    const playerKeys = multiDiscreteToOverlayKeys(playerAction);

    const stepIdx = Math.floor(this.episodeTick / TICKS_PER_DECISION);
    const stepData = this.timeline?.steps?.[stepIdx] || this.timeline?.steps?.[this.timeline.steps.length - 1];
    const requiredAction = stepData ? stepData.action : [1, 1, 1, 0, 0, 0];
    const requiredKeys = stepData ? stepData.keys : multiDiscreteToOverlayKeys(requiredAction);
    const requiredKeyStr = stepData ? stepData.keyStr : multiDiscreteToKeyString(requiredAction);

    const isMatching = areMultiDiscreteActionsEqual(playerAction, requiredAction);
    const isAnyKeyPressed = !areMultiDiscreteActionsEqual(playerAction, [1, 1, 1, 0, 0, 0]);

    if (this.phase === 'countdown') {
      r.physics.setControls(r.playerCarIndex, r.neutralControls);
      if (!this.ghostModeEnabled && r.physics.numCars >= 2) {
        r.physics.setControls(1, r.neutralControls);
      }
      useKickoffTrainingStore.getState().updateLiveState({
        phase: 'countdown',
        countdownRemainingTicks: this.countdownTicksRemaining,
        playerAction, playerKeys, requiredAction, requiredKeys, requiredKeyStr,
      });
      return true;
    }

    if (this.subMode === 'instant' && this.phase === 'waiting-for-input') {
      if (isAnyKeyPressed) {
        this.phase = 'running';
        r.physics.setSimulationFrozen(false, 0, false);
        r.physics.setControls(r.playerCarIndex, r.playerControls);
      } else {
        r.physics.setSimulationFrozen(true, 0, true);
        useKickoffTrainingStore.getState().updateLiveState({
          phase: 'waiting-for-input',
          playerAction, playerKeys, requiredAction, requiredKeys, requiredKeyStr,
          isInputMatching: false,
        });
        return true;
      }
    }

    if (this.subMode === 'easy-learning') {
      const withinGuidedWindow = !this.playerTouchedBall && this.timeline && stepIdx < this.timeline.steps.length;
      if (withinGuidedWindow) {
        if (!isMatching) {
          this.phase = 'paused-mismatch';
          r.physics.setSimulationFrozen(true, 0, false);
          useKickoffTrainingStore.getState().updateLiveState({
            phase: 'paused-mismatch',
            episodeTick: this.episodeTick,
            decisionStep: stepIdx,
            playerAction, playerKeys, requiredAction, requiredKeys, requiredKeyStr,
            isInputMatching: false,
          });
          return false;
        }
        if (this.phase !== 'running') {
          this.phase = 'running';
          r.physics.setSimulationFrozen(false, 0, false);
        }
      } else if (this.phase !== 'running') {
        this.phase = 'running';
        r.physics.setSimulationFrozen(false, 0, false);
      }
    }

    useKickoffTrainingStore.getState().updateLiveState({
      phase: this.phase,
      episodeTick: this.episodeTick,
      decisionStep: stepIdx,
      playerAction, playerKeys, requiredAction, requiredKeys, requiredKeyStr,
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
      this.countdownElapsedTicks++;
      this.countdownTicksRemaining = Math.max(0, this.countdownTicksRemaining - 1);

      if (this.countdownElapsedTicks === KICKOFF_V1_SETTLE_TICKS) {
        const spawn = KICKOFF_SPAWNS[this.spawnIndex] || KICKOFF_SPAWNS[0];
        this.clampSettledPlayerCar(spawn);
        if (this.countdownTicksRemaining > 0) {
          r.physics.setSimulationFrozen(true, 0, true);
        }
      }

      const rem = this.countdownTicksRemaining;
      const displaySec = rem > 0 ? Math.min(4, Math.ceil(rem / 120)) : 0;
      if (r.match && r.match.state.countdown !== displaySec) {
        r.match.state.countdown = displaySec;
        hudStore.getState().setMatchState({
          matchPhase: rem > 0 ? 'kickoff' : 'playing',
          kickoffCountdown: displaySec,
        });
      }

      if (rem <= 360 && rem > 240 && !this.latchedCountdownSeconds.has(3)) {
        this.latchedCountdownSeconds.add(3);
        audio?.play?.('match_countdown_321', 1.0);
      } else if (rem <= 240 && rem > 120 && !this.latchedCountdownSeconds.has(2)) {
        this.latchedCountdownSeconds.add(2);
        audio?.play?.('match_countdown_321', 1.0);
      } else if (rem <= 120 && rem > 0 && !this.latchedCountdownSeconds.has(1)) {
        this.latchedCountdownSeconds.add(1);
        audio?.play?.('match_countdown_321', 1.0);
      }

      if (rem <= 0) {
        this.phase = 'running';
        r.physics.setSimulationFrozen(false, 0, false);
        if (r.match) {
          r.match.state.phase = 'playing';
          r.match.state.countdown = 0;
        }
        hudStore.getState().setMatchState({ matchPhase: 'playing', kickoffCountdown: 0 });
        audio?.play?.('match_start_go', 1.0);
      }
      return true;
    }

    if (this.phase === 'waiting-for-input') {
      r.physics.step(1);
      return true;
    }

    if (!this.ghostModeEnabled && r.physics.numCars >= 2) {
      if (this.episodeTick % TICKS_PER_DECISION === 0) {
        this.currentGhostRawControls = this.solidAgent.actDeterministic(
          r.physics, 1, this.aiTeamSign < 0
        ) as KickoffCarControls;
      }
      this.currentGhostControls = this.solidAgent.sanitizeAndRecordTickControls(
        r.physics, 1, this.currentGhostRawControls
      ) as KickoffCarControls;
      r.physics.setControls(1, this.currentGhostControls);
      r.botControls = this.currentGhostControls;
    }

    r.physics.step(1);

    if (this.ghostModeEnabled && this.ghostSim?.isInitialized && this.ghostPrevState && this.ghostCurrState) {
      if (this.episodeTick % TICKS_PER_DECISION === 0) {
        this.currentGhostRawControls = this.ghostAgent.actDeterministic(
          this.ghostSim, 0, false
        ) as KickoffCarControls;
      }
      this.currentGhostControls = this.ghostAgent.sanitizeAndRecordTickControls(
        this.ghostSim, 0, this.currentGhostRawControls
      ) as KickoffCarControls;
      this.ghostSim.setControls(0, this.currentGhostControls);
      this.ghostPrevState.set(this.ghostCurrState);
      this.ghostSim.stepSilent(1);
      this.ghostCurrState.set(this.ghostSim.state);

      const gBall = this.ghostSim.getBallStateView();
      ghostVisuals?.recordBallTrajectoryPoint(gBall);
    }

    this.episodeTick++;

    if (!this.playerTouchedBall) {
      const pBall = r.physics.getBallStateView();
      const pBallSpeed = Math.hypot(pBall.velX, pBall.velY, pBall.velZ);
      if (pBallSpeed > 1.0) {
        let playerHitIt = true;
        if (!this.ghostModeEnabled && r.physics.numCars >= 2) {
          const pCar = r.physics.getCarStateView(0);
          const distToBall = Math.hypot(pCar.posX - pBall.posX, pCar.posY - pBall.posY, pCar.posZ - pBall.posZ);
          playerHitIt = distToBall <= 235.0;
        }
        if (playerHitIt) {
          this.playerTouchedBall = true;
          this.playerTouchTick = this.episodeTick;
          const deltaTicks = this.aiTouchTick ? this.playerTouchTick - this.aiTouchTick : 0;
          useKickoffTrainingStore.getState().updateLiveState({
            playerTouchTick: this.playerTouchTick,
            lastDeltaTicks: deltaTicks,
          });
        }
      }
    }

    if (this.goalResetTicksRemaining > 0) {
      this.goalResetTicksRemaining--;
      if (this.goalResetTicksRemaining === 0) {
        this.resetEpisode(this.spawnIndex);
      }
    }

    return true;
  }

  public updateFrame(context: KickoffFrameUpdateContext): void {
    const r = this.deps.getRuntime();
    const ghostVisuals = this.deps.getGhostVisuals();
    const { goalScored, playerCarView, dt } = context;

    if (goalScored && this.goalResetTicksRemaining === 0) {
      this.goalResetTicksRemaining = 54;
    }

    if (playerCarView) {
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, false);
    }

    if (this.ghostModeEnabled && ghostVisuals && this.ghostPrevState && this.ghostCurrState) {
      ghostVisuals.update(
        this.ghostPrevState,
        this.ghostCurrState,
        r.interpolator?.alpha ?? 0,
        dt ?? 0.016,
        this.currentGhostControls
      );
    }
  }
}
