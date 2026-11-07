import { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import {
  BALL_REST_Z,
  BALL_GROUND_CONTACT_MAX_Z,
} from '../../physics/RocketSimConstants.ts';
import {
  NEUTRAL_CONTROLS,
  MAX_INPUT_BUFFER_TICKS,
  NetworkInputBuffer,
} from './NetworkInputBuffer.ts';
import type { CarControlsInput } from '../protocol/GlobalPayloadCodec.ts';
import {
  LobbyGhostCarCoordinator,
  evaluatePhysicsSignalTransition,
  type LobbyGhostConfigOptions,
  type PhysicsSignalData,
} from './LobbyGhostCarCoordinator.ts';
import {
  syncCarSlotWithSim,
  buildPausedPhysicsStepOutput,
  sampleAuthoritativeCarControlsForTick,
  evaluatePostStepIncidentsAndGoalLatch,
  type AuthoritativePhysicsSimPort,
  type AuthoritativePhysicsStepOutput,
} from './authoritativePhysicsStepPipeline.ts';

export type { PhysicsSignalData };

export interface PhysicsEngineManagerOptions {
  sim?: AuthoritativePhysicsSimPort;
  inputBuffer?: NetworkInputBuffer | null;
  maxBufferTicks?: number;
  onPhysicsOutput?: ((output: AuthoritativePhysicsStepOutput) => void) | null;
  lobbyGhostCoordinator?: LobbyGhostCarCoordinator;
  lobbyGhostOptions?: LobbyGhostConfigOptions;
  isRecordingFullReplay?: boolean;
}

export class PhysicsEngineManager {
  sim: AuthoritativePhysicsSimPort;
  inputBuffer: NetworkInputBuffer | null;
  maxBufferTicks: number;
  onPhysicsOutput: ((output: AuthoritativePhysicsStepOutput) => void) | null;
  activeCarIndices: Set<number>;
  directControls: Map<number, CarControlsInput>;
  lobbyGhostCoordinator: LobbyGhostCarCoordinator;
  isMasked: boolean;
  maskUntilFrame: number;
  private _isPaused: boolean;
  goalLatched: boolean;
  goalScoredAtTick: number;
  frozenBallSnapshot: Float32Array | null;
  isRecordingFullReplay: boolean;
  lastAcknowledgedControls: Map<number, CarControlsInput>;
  jumpSuppressedCarIndices: Set<number>;
  lastBallTouchCarIndex?: number;
  lastBallTouchTick?: number;

  constructor(options: PhysicsEngineManagerOptions = {}) {
    this.sim =
      options.sim || (new RocketSimPhysicsEngine() as unknown as AuthoritativePhysicsSimPort);
    this.inputBuffer = options.inputBuffer || null;
    this.maxBufferTicks = options.maxBufferTicks ?? MAX_INPUT_BUFFER_TICKS;
    this.onPhysicsOutput = options.onPhysicsOutput || null;

    this.activeCarIndices = new Set();
    this.directControls = new Map();
    this.lobbyGhostCoordinator =
      options.lobbyGhostCoordinator || new LobbyGhostCarCoordinator(options.lobbyGhostOptions);

    this.isMasked = false;
    this.maskUntilFrame = -1;
    this._isPaused = false;

    this.goalLatched = false;
    this.goalScoredAtTick = -1;
    this.frozenBallSnapshot = null;
    this.isRecordingFullReplay = Boolean(options.isRecordingFullReplay ?? false);

    this.lastAcknowledgedControls = new Map();
    this.jumpSuppressedCarIndices = new Set();
    if (this.sim?.isInitialized && typeof this.sim.initReplayBuffer === 'function') {
      this.sim.initReplayBuffer();
    }
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  set isPaused(val: boolean) {
    this._isPaused = Boolean(val);
    if (this.inputBuffer) this.inputBuffer.isPaused = this._isPaused;
  }

  async init(): Promise<this> {
    if (!this.sim.isInitialized) await this.sim.init?.();
    this.sim.setPossessionReportingEnabled?.(true);
    this.sim.initReplayBuffer?.();
    return this;
  }

  getPossessionStats(): { team: number; bluePoints: number; orangePoints: number; time: number } {
    if (typeof this.sim?.getPossessionStats === 'function') return this.sim.getPossessionStats();
    return { team: 0, bluePoints: 0, orangePoints: 0, time: 0 };
  }

  setInputBuffer(buffer: NetworkInputBuffer | null): void {
    this.inputBuffer = buffer;
    if (this.inputBuffer) {
      this.inputBuffer.isPaused = this._isPaused;
      this.inputBuffer.setLobbyMode?.(Boolean(this.lobbyGhostCoordinator?.lobbyModeActive));
    }
  }

  setCarCollisionMask(
    carIndex: number,
    interactWithBall = true,
    interactWithCars = true,
    opacity: number | undefined = undefined
  ) {
    return this.lobbyGhostCoordinator.applyCarCollisionMask(
      this.sim,
      carIndex,
      interactWithBall,
      interactWithCars,
      opacity
    );
  }

  setLobbyGhostMode(enabled = true, config: LobbyGhostConfigOptions = {}) {
    this.inputBuffer?.setLobbyMode?.(Boolean(enabled));
    return this.lobbyGhostCoordinator.configureLobbyMode(this.sim, this.activeCarIndices, {
      ...config,
      enabled,
    });
  }

  syncLobbyGhostMasks(): void {
    if (this.lobbyGhostCoordinator.lobbyModeActive) {
      this.lobbyGhostCoordinator.configureLobbyMode(this.sim, this.activeCarIndices, {
        enabled: true,
      });
    }
  }

  restoreSolidCollisions() {
    this.inputBuffer?.setLobbyMode?.(false);
    return this.lobbyGhostCoordinator.restoreSolidCollisions(this.sim, this.activeCarIndices);
  }

  getActiveCarMask(): number {
    if (this.sim && typeof this.sim.getActiveCarMask === 'function') {
      const wasmMask = this.sim.getActiveCarMask();
      if (typeof wasmMask === 'number' && wasmMask > 0) {
        let combined = 0;
        for (const idx of this.activeCarIndices) {
          if (idx >= 0 && idx < 8) combined |= 1 << idx;
        }
        return (combined || wasmMask) & 0xff;
      }
    }
    let mask = 0;
    for (const idx of this.activeCarIndices) {
      if (idx >= 0 && idx < 8) {
        mask |= 1 << idx;
      }
    }
    return mask & 0xff;
  }

  registerCarEntity(carIndex: number, team = 0, config = 'octane'): number {
    const wasActive = this.activeCarIndices.has(carIndex);
    this.activeCarIndices.add(carIndex);
    if (this.inputBuffer) {
      this.inputBuffer.registerCar(carIndex);
    }

    syncCarSlotWithSim(this.sim, carIndex, team, config, wasActive);

    if (!wasActive && this.sim) {
      this.sim.setCarLinearFactorAndGravity?.(carIndex, 1, 1, 1, 1);
      this.setCarCollisionMask(carIndex, true, true, 1.0);
    }

    if (this.lobbyGhostCoordinator.lobbyModeActive) {
      this.syncLobbyGhostMasks();
    }
    return carIndex;
  }

  unregisterCarEntity(carIndex: number): void {
    this.activeCarIndices.delete(carIndex);
    this.directControls.delete(carIndex);
    this.lastAcknowledgedControls.delete(carIndex);
    if (this.inputBuffer) {
      this.inputBuffer.unregisterCar(carIndex);
    }
    if (this.sim && typeof this.sim.removeCar === 'function') {
      this.sim.removeCar(carIndex);
    }
  }

  get currentTick(): number {
    if (!this.sim) return 0;
    if (typeof this.sim.getHeaderView === 'function') {
      const header = this.sim.getHeaderView();
      if (header && typeof header.tickCount === 'number') {
        return Math.floor(header.tickCount);
      }
    }
    return 0;
  }

  set currentTick(val: number) {
    if (this.sim && typeof this.sim.getHeaderView === 'function') {
      try {
        const header = this.sim.getHeaderView();
        if (header && typeof val === 'number' && Number.isFinite(val)) {
          header.tickCount = Math.max(0, Math.floor(val));
        }
      } catch {
        // Read-only view in some mock engines; safe to ignore
      }
    }
  }

  pushInput(carIndex: number, targetTick: number, controls: CarControlsInput): boolean {
    if (!this.activeCarIndices.has(carIndex)) return false;
    if (this.inputBuffer) {
      return this.inputBuffer.pushInput(carIndex, this.currentTick, targetTick, controls);
    }
    this.directControls.set(carIndex, { ...controls });
    return true;
  }

  setDirectCarControls(carIndex: number, controls: CarControlsInput): boolean {
    if (!this.activeCarIndices.has(carIndex)) return false;
    this.directControls.set(carIndex, { ...controls });
    return true;
  }

  pushRedundantInputs(
    carIndex: number,
    inputList: Array<{ tick?: number; targetTick?: number; controls?: CarControlsInput }>
  ): number {
    if (!this.inputBuffer) return 0;
    return this.inputBuffer.pushRedundantInputs(carIndex, this.currentTick, inputList);
  }

  getInputBufferSize(carIndex: number): number {
    if (!this.inputBuffer) return 0;
    return this.inputBuffer.getInputBufferSize(carIndex, this.currentTick);
  }

  setInputMask(isMasked: boolean, untilFrame = -1): void {
    this.isMasked = isMasked;
    this.maskUntilFrame = untilFrame;
  }

  shouldMaskInputs(tick: number): boolean {
    if (this.isPaused) return true;
    if (this.maskUntilFrame >= 0) {
      if (tick < this.maskUntilFrame) return true;
      this.maskUntilFrame = -1;
      this.isMasked = false;
      return false;
    }
    return this.isMasked;
  }

  resetGoalLatch(): void {
    this.goalLatched = false;
    this.goalScoredAtTick = -1;
    this.frozenBallSnapshot = null;
    if (typeof this.sim?.resetGoalLatch === 'function') {
      this.sim.resetGoalLatch();
    }
    if (typeof this.sim?.pollGoal === 'function') {
      this.sim.pollGoal();
    }
  }

  applySignal(signalType: number | string, data: PhysicsSignalData = {}): void {
    const next = evaluatePhysicsSignalTransition(
      signalType,
      data,
      {
        isPaused: this.isPaused,
        isRecordingFullReplay: this.isRecordingFullReplay,
        isMasked: this.isMasked,
        maskUntilFrame: this.maskUntilFrame,
      },
      {
        sim: this.sim,
        lobbyModeActive: Boolean(this.lobbyGhostCoordinator?.lobbyModeActive),
        resetGoalLatch: () => this.resetGoalLatch(),
        restoreSolidCollisions: () => {
          this.restoreSolidCollisions();
        },
        resetKickoff: (seed) => this.resetKickoff(seed),
        resetBallToCenter: () => this.resetBallToCenter(),
        clearInputBuffer: () => {
          this.inputBuffer?.clear();
        },
        setCarCollisionMask: (carIndex, interactWithBall, interactWithCars, opacity) => {
          this.setCarCollisionMask(carIndex, interactWithBall, interactWithCars, opacity);
        },
        setLobbyGhostMode: (enabled, config) => {
          this.setLobbyGhostMode(enabled, config);
        },
      }
    );
    this.isPaused = next.isPaused;
    this.isRecordingFullReplay = next.isRecordingFullReplay;
    this.isMasked = next.isMasked;
    this.maskUntilFrame = next.maskUntilFrame;
  }

  stepAuthoritativeTick(): AuthoritativePhysicsStepOutput {
    if (this.isPaused) {
      const output = buildPausedPhysicsStepOutput({
        sim: this.sim,
        currentTick: this.currentTick,
        activeCarMask: this.getActiveCarMask(),
        activeCarIndices: this.activeCarIndices,
        lastAcknowledgedControls: this.lastAcknowledgedControls,
        lastBallTouchCarIndex: this.lastBallTouchCarIndex,
      });
      this.onPhysicsOutput?.(output);
      return output;
    }

    const tick = this.currentTick;
    const mask = this.shouldMaskInputs(tick);
    const ackList = sampleAuthoritativeCarControlsForTick({
      sim: this.sim,
      tick,
      mask,
      activeCarIndices: this.activeCarIndices,
      directControls: this.directControls,
      inputBuffer: this.inputBuffer,
      lastAcknowledgedControls: this.lastAcknowledgedControls,
      jumpSuppressedCarIndices: this.jumpSuppressedCarIndices,
      lobbyGhostCoordinator: this.lobbyGhostCoordinator,
    });

    const stepEval = evaluatePostStepIncidentsAndGoalLatch({
      sim: this.sim,
      currentTick: this.currentTick,
      isRecordingFullReplay: this.isRecordingFullReplay,
      goalLatched: this.goalLatched,
      goalScoredAtTick: this.goalScoredAtTick,
      frozenBallSnapshot: this.frozenBallSnapshot,
      lastBallTouchCarIndex: this.lastBallTouchCarIndex,
      lastBallTouchTick: this.lastBallTouchTick,
    });
    this.goalLatched = stepEval.goalLatched;
    this.goalScoredAtTick = stepEval.goalScoredAtTick;
    this.frozenBallSnapshot = stepEval.frozenBallSnapshot;
    this.lastBallTouchCarIndex = stepEval.lastBallTouchCarIndex;
    this.lastBallTouchTick = stepEval.lastBallTouchTick;

    const output: AuthoritativePhysicsStepOutput = {
      tick: this.currentTick,
      activeCarMask: this.getActiveCarMask(),
      acknowledgedControls: ackList,
      stateSnapshot:
        typeof this.sim.saveCompactState === 'function'
          ? this.sim.saveCompactState()
          : this.sim.saveState(),
      incidents: stepEval.frameIncidents,
      goalScored: stepEval.goalScored,
      goalTeam: stepEval.goalTeam,
      scorerCarIndex: this.lastBallTouchCarIndex ?? 0,
      scorerTouchTick: this.lastBallTouchTick ?? null,
      kickoffTouched: stepEval.kickoffTouched,
    };

    this.onPhysicsOutput?.(output);
    return output;
  }

  resetBallToCenter(): void {
    this.resetGoalLatch();
    if (typeof this.sim?.setBallState === 'function') {
      this.sim.setBallState(
        new Float32Array([0, 0, BALL_REST_Z, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])
      );
    }
  }

  isBallOnGround(): boolean {
    if (!this.sim) return false;
    if (typeof this.sim.ballOnGround === 'boolean') return this.sim.ballOnGround;
    if (typeof this.sim.getBallOnGround === 'function') return Boolean(this.sim.getBallOnGround());
    const b = this.sim.getBallStateView?.();
    return Boolean(b && typeof b.posZ === 'number' && b.posZ <= BALL_GROUND_CONTACT_MAX_Z);
  }

  resetKickoff(seed = 0): void {
    this.resetGoalLatch();
    for (const [carIdx, ctrl] of this.lastAcknowledgedControls.entries()) {
      if (ctrl?.jump) this.jumpSuppressedCarIndices.add(carIdx);
    }
    for (const [carIdx, ctrl] of this.directControls.entries()) {
      if (ctrl?.jump) this.jumpSuppressedCarIndices.add(carIdx);
      this.directControls.set(carIdx, { ...NEUTRAL_CONTROLS });
    }
    this.lastAcknowledgedControls.clear();
    this.sim.resetKickoff(seed);
    this.inputBuffer?.clear();
  }

  destroy(): void {
    this.resetGoalLatch();
    this.inputBuffer?.clear();
    this.directControls.clear();
    this.activeCarIndices.clear();
    this.lastAcknowledgedControls.clear();
    this.jumpSuppressedCarIndices.clear();
    this.sim?.destroy?.();
  }
}

export default PhysicsEngineManager;
