/**
 * src/network/PhysicsEngineManager.js
 * Physics Engine Layer Orchestrator and Signal Processor.
 *
 * Architectural Highlights:
 * 1. Signal-Driven Physics Orchestration:
 *    Processes session signals dispatched from MatchSessionAdmin (Kickoff resets,
 *    Ball resets, Dynamic input masking, Simulation freeze, Hitbox hot swap,
 *    and idempotent Post-Goal Latch resets on Goal Replay Start / Kickoff Will Start).
 * 2. Post-Goal 30-Frame Ball Flight & Freeze:
 *    Upon detecting a goal, allows the ball to continue flying for 30 ticks (0.25s @ 120Hz)
 *    before freezing it in place inside the goal net, suppressing duplicate goal incidents
 *    until idempotently cleared by GOAL_REPLAY_START or KICKOFF_WILL_START.
 */

import { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.js';
import {
  BALL_REST_Z,
  BALL_GROUND_CONTACT_MAX_Z,
} from '../../physics/RocketSimConstants.js';
import { NEUTRAL_CONTROLS, MAX_INPUT_BUFFER_TICKS } from './NetworkInputBuffer.js';
import { MATCH_SIGNALS } from '../protocol/GlobalPayloadCodec.js';
import { LobbyGhostCarCoordinator } from './LobbyGhostCarCoordinator.js';
import {
  applyPodiumFormationToEngine,
  releasePodiumLocksOnEngine
} from '../../replay/PodiumPhysicsHelper.js';

export const POST_GOAL_FREEZE_DELAY_TICKS = 30;

export class PhysicsEngineManager {
  constructor(options = {}) {
    this.sim = options.sim || new RocketSimPhysicsEngine();
    this.inputBuffer = options.inputBuffer || null;
    this.maxBufferTicks = options.maxBufferTicks ?? MAX_INPUT_BUFFER_TICKS;
    this.onPhysicsOutput = options.onPhysicsOutput || null;

    this.activeCarIndices = new Set();
    this.directControls = new Map();
    this.lobbyGhostCoordinator = options.lobbyGhostCoordinator || new LobbyGhostCarCoordinator(options.lobbyGhostOptions);

    this.isMasked = false;
    this.maskUntilFrame = -1;
    this._isPaused = false;

    this.goalLatched = false;
    this.goalScoredAtTick = -1;
    this.frozenBallSnapshot = null;
    this.isRecordingFullReplay = Boolean(options.isRecordingFullReplay ?? false);

    this.lastAcknowledgedControls = new Map();
    if (this.sim?.isInitialized && typeof this.sim.initReplayBuffer === 'function') {
      this.sim.initReplayBuffer();
    }
  }

  get isPaused() {
    return this._isPaused;
  }

  set isPaused(val) {
    this._isPaused = Boolean(val);
    if (this.inputBuffer) {
      this.inputBuffer.isPaused = this._isPaused;
    }
  }

  async init() {
    if (!this.sim.isInitialized) {
      await this.sim.init();
    }
    this.sim.setPossessionReportingEnabled?.(true);
    this.sim.initReplayBuffer?.();
    return this;
  }

  getPossessionStats() {
    if (typeof this.sim?.getPossessionStats === 'function') {
      return this.sim.getPossessionStats();
    }
    return { team: 0, bluePoints: 0, orangePoints: 0, time: 0 };
  }

  setInputBuffer(buffer) {
    this.inputBuffer = buffer;
    if (this.inputBuffer) {
      this.inputBuffer.isPaused = this._isPaused;
      this.inputBuffer.setLobbyMode?.(Boolean(this.lobbyGhostCoordinator?.lobbyModeActive));
    }
  }

  setCarCollisionMask(carIndex, interactWithBall = true, interactWithCars = true, opacity = undefined) {
    return this.lobbyGhostCoordinator.applyCarCollisionMask(this.sim, carIndex, interactWithBall, interactWithCars, opacity);
  }

  setLobbyGhostMode(enabled = true, config = {}) {
    this.inputBuffer?.setLobbyMode?.(Boolean(enabled));
    return this.lobbyGhostCoordinator.configureLobbyMode(this.sim, this.activeCarIndices, { ...config, enabled });
  }

  syncLobbyGhostMasks() {
    if (this.lobbyGhostCoordinator.lobbyModeActive) {
      this.lobbyGhostCoordinator.configureLobbyMode(this.sim, this.activeCarIndices, { enabled: true });
    }
  }

  restoreSolidCollisions() {
    this.inputBuffer?.setLobbyMode?.(false);
    return this.lobbyGhostCoordinator.restoreSolidCollisions(this.sim, this.activeCarIndices);
  }

  getActiveCarMask() {
    if (this.sim && typeof this.sim.getActiveCarMask === 'function') {
      const wasmMask = this.sim.getActiveCarMask();
      if (typeof wasmMask === 'number' && wasmMask > 0) {
        let combined = 0;
        for (const idx of this.activeCarIndices) {
          if (idx >= 0 && idx < 8) combined |= (1 << idx);
        }
        return (combined || wasmMask) & 0xFF;
      }
    }
    let mask = 0;
    for (const idx of this.activeCarIndices) {
      if (idx >= 0 && idx < 8) {
        mask |= (1 << idx);
      }
    }
    return mask & 0xFF;
  }

  registerCarEntity(carIndex, team = 0, config = 'octane') {
    const wasActive = this.activeCarIndices.has(carIndex);
    this.activeCarIndices.add(carIndex);
    if (this.inputBuffer) {
      this.inputBuffer.registerCar(carIndex);
    }

    if (this.sim) {
      if (typeof this.sim.addCarAtSlot === 'function') {
        const slotAlreadyActive = typeof this.sim.isCarSlotActive === 'function'
          ? this.sim.isCarSlotActive(carIndex)
          : wasActive;
        if (!slotAlreadyActive) {
          this.sim.addCarAtSlot(carIndex, team, config || 'default');
        } else {
          if (config && typeof this.sim.setCarHitbox === 'function') {
            this.sim.setCarHitbox(carIndex, config);
          }
          if (typeof this.sim.setCarTeam === 'function') {
            this.sim.setCarTeam(carIndex, team);
          }
        }
      } else if (this.sim.numCars <= carIndex) {
        if (typeof this.sim.addCar === 'function') {
          while (this.sim.numCars <= carIndex) {
            const nextIdx = this.sim.numCars;
            const t = nextIdx === carIndex ? team : (nextIdx === 0 ? 0 : (nextIdx % 2));
            this.sim.addCar(t, config || 'default');
          }
        } else if (typeof this.sim.configureCars === 'function') {
          this.sim.configureCars('custom', false, 0);
        }
      } else if (config && typeof this.sim.setCarHitbox === 'function') {
        this.sim.setCarHitbox(carIndex, config);
      }

      if (typeof this.sim.setCarTeam === 'function') {
        this.sim.setCarTeam(carIndex, team);
      }
    }

    if (!wasActive && this.sim) {
      this.sim.setCarLinearFactorAndGravity?.(carIndex, 1, 1, 1, 1);
      this.setCarCollisionMask(carIndex, true, true, 1.0);
    }

    if (this.lobbyGhostCoordinator.lobbyModeActive) {
      this.syncLobbyGhostMasks();
    }
    return carIndex;
  }

  unregisterCarEntity(carIndex) {
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

  get currentTick() {
    if (!this.sim) return 0;
    if (typeof this.sim.getHeaderView === 'function') {
      const header = this.sim.getHeaderView();
      if (header && typeof header.tickCount === 'number') {
        return Math.floor(header.tickCount);
      }
    }
    return 0;
  }

  pushInput(carIndex, targetTick, controls) {
    if (!this.activeCarIndices.has(carIndex)) return false;
    if (this.inputBuffer) {
      return this.inputBuffer.pushInput(carIndex, this.currentTick, targetTick, controls);
    }
    this.directControls.set(carIndex, { ...controls });
    return true;
  }

  setDirectCarControls(carIndex, controls) {
    if (!this.activeCarIndices.has(carIndex)) return false;
    this.directControls.set(carIndex, { ...controls });
    return true;
  }

  pushRedundantInputs(carIndex, inputList) {
    if (!this.inputBuffer) return 0;
    return this.inputBuffer.pushRedundantInputs(carIndex, this.currentTick, inputList);
  }

  getInputBufferSize(carIndex) {
    if (!this.inputBuffer) return 0;
    return this.inputBuffer.getInputBufferSize(carIndex, this.currentTick);
  }

  setInputMask(isMasked, untilFrame = -1) {
    this.isMasked = isMasked;
    this.maskUntilFrame = untilFrame;
  }

  shouldMaskInputs(tick) {
    if (this.isPaused) return true;
    if (this.maskUntilFrame >= 0) {
      if (tick < this.maskUntilFrame) return true;
      this.maskUntilFrame = -1;
      this.isMasked = false;
      return false;
    }
    return this.isMasked;
  }

  resetGoalLatch() {
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

  applySignal(signalType, data = {}) {
    switch (signalType) {
      case MATCH_SIGNALS.MATCH_STARTED:
      case MATCH_SIGNALS.KICKOFF_WILL_START:
        this.resetGoalLatch();
        this.isRecordingFullReplay = true;
        this.sim?.setReplayRecordingActive?.(true);
        releasePodiumLocksOnEngine(this.sim);
        if (this.lobbyGhostCoordinator.lobbyModeActive) {
          this.restoreSolidCollisions();
        }
        if (signalType === MATCH_SIGNALS.MATCH_STARTED) {
          this.sim?.clearReplayBuffer?.();
        }
        this.sim?.setSimulationFrozen?.(false, 0, false);
        if (signalType === MATCH_SIGNALS.KICKOFF_WILL_START) {
          this.setInputMask(true, data.kickoffWillStartAt ?? data.param1 ?? data.untilFrame ?? -1);
        }
        break;

      case 'KICKOFF_RESET':
      case MATCH_SIGNALS.KICKOFF_START:
        this.resetGoalLatch();
        this.isRecordingFullReplay = true;
        this.sim?.setReplayRecordingActive?.(true);
        releasePodiumLocksOnEngine(this.sim);
        if (this.lobbyGhostCoordinator.lobbyModeActive) {
          this.restoreSolidCollisions();
        }
        this.sim?.setSimulationFrozen?.(false, 0, false);
        this.setInputMask(false);
        if (signalType === 'KICKOFF_RESET' || data.forceReset) {
          this.resetKickoff(data.seed || 0);
        }
        break;

      case MATCH_SIGNALS.PODIUM_START:
        this.isPaused = false;
        this.isRecordingFullReplay = false;
        this.sim?.setReplayRecordingActive?.(false);
        this.setInputMask(false);
        applyPodiumFormationToEngine(this.sim, data.winner ?? data.param1 ?? 0);
        break;

      case MATCH_SIGNALS.GOAL_REPLAY_WILL_START:
      case MATCH_SIGNALS.MATCH_WILL_RESUME:
        break;

      case MATCH_SIGNALS.GOAL_REPLAY_START:
        this.resetGoalLatch();
        this.isRecordingFullReplay = false;
        this.sim?.setReplayRecordingActive?.(false);
        this.sim?.setSimulationFrozen?.(true, 0, true);
        break;

      case MATCH_SIGNALS.GOAL_REPLAY_END:
        this.resetGoalLatch();
        this.isRecordingFullReplay = true;
        this.sim?.setReplayRecordingActive?.(true);
        this.sim?.setSimulationFrozen?.(false, 0, false);
        break;

      case MATCH_SIGNALS.MATCH_PAUSED:
      case 'PAUSE_SIMULATION': {
        const paused = signalType === MATCH_SIGNALS.MATCH_PAUSED ? true : Boolean(data.paused);
        this.isPaused = paused;
        this.sim?.setSimulationFrozen?.(paused, 0, paused);
        break;
      }

      case MATCH_SIGNALS.MATCH_RESUMED:
        this.isPaused = false;
        this.sim?.setSimulationFrozen?.(false, 0, false);
        break;

      case 'BALL_RESET':
      case MATCH_SIGNALS.BALL_RESET:
        this.resetGoalLatch();
        this.resetBallToCenter();
        break;

      case 'INPUT_MASK':
        this.setInputMask(Boolean(data.masked), data.untilFrame ?? -1);
        break;

      case 'GHOST_CAR_CONFIG':
        if (typeof data.carIndex === 'number') {
          this.setCarCollisionMask(data.carIndex, data.interactWithBall ?? false, data.interactWithCars ?? false, data.opacity);
        } else {
          this.setLobbyGhostMode(data.enabled ?? true, data);
        }
        break;

      case MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED:
      case 'HOTSWAP_HITBOX':
        if (typeof data.carIndex === 'number' && data.hitboxType) {
          this.sim?.setCarHitbox?.(data.carIndex, data.hitboxType);
        }
        break;

      default:
        break;
    }
  }

  stepAuthoritativeTick() {
    if (this.isPaused) {
      const ackList = [];
      for (const carIndex of this.activeCarIndices) {
        const last = this.lastAcknowledgedControls.get(carIndex);
        ackList.push({ carIndex, controls: last ? { ...last } : { ...NEUTRAL_CONTROLS } });
      }
      const output = {
        tick: this.currentTick,
        activeCarMask: this.getActiveCarMask(),
        acknowledgedControls: ackList,
        stateSnapshot: this.sim
          ? (typeof this.sim.saveCompactState === 'function' ? this.sim.saveCompactState() : this.sim.saveState())
          : null,
        incidents: [],
        goalScored: false,
        goalTeam: -1,
        scorerCarIndex: this.lastBallTouchCarIndex ?? 0,
        kickoffTouched: false
      };
      this.onPhysicsOutput?.(output);
      return output;
    }

    const tick = this.currentTick;
    const mask = this.shouldMaskInputs(tick);
    const ackList = [];

    for (const carIndex of this.activeCarIndices) {
      const isLobbyRemoteMasked = this.lobbyGhostCoordinator.shouldMaskRemoteLobbyInput(carIndex);
      let effectiveControls = null;

      if (this.directControls.has(carIndex)) {
        const direct = this.directControls.get(carIndex);
        effectiveControls = (mask || isLobbyRemoteMasked) ? { ...NEUTRAL_CONTROLS } : { ...direct };
      } else if (mask || isLobbyRemoteMasked) {
        effectiveControls = { ...NEUTRAL_CONTROLS };
      } else if (this.inputBuffer) {
        const last = this.lastAcknowledgedControls.get(carIndex);
        effectiveControls = this.inputBuffer.getControlsForTick(carIndex, tick, last);
      } else {
        const last = this.lastAcknowledgedControls.get(carIndex);
        effectiveControls = last ? { ...last } : { ...NEUTRAL_CONTROLS };
      }

      if (typeof this.sim.setControls === 'function') {
        this.sim.setControls(carIndex, effectiveControls);
      } else if (typeof this.sim.setCarControls === 'function') {
        this.sim.setCarControls(carIndex, effectiveControls);
      }
      this.lastAcknowledgedControls.set(carIndex, effectiveControls);
      ackList.push({ carIndex, controls: effectiveControls });
    }

    if (this.inputBuffer) {
      this.inputBuffer.pruneOlderThan(tick);
    }

    let goalScored = false;
    let goalTeam = -1;
    let kickoffTouched = false;
    const frameIncidents = [];

    if (!this.isPaused) {
      this.sim.step(1);
      if (typeof this.sim.readEvents === 'function') {
        this.sim.readEvents((ev) => {
          if (!ev || ev.type <= 0 || ev.type > 0x3F) return;
          const copy = { ...ev };
          frameIncidents.push(copy);
          if (copy.type === 0x01) {
            const cIdx = typeof copy.carIndex === 'number' && copy.carIndex >= 0
              ? copy.carIndex
              : (typeof copy.primaryId === 'number' && copy.primaryId >= 0 && copy.primaryId < 8 ? copy.primaryId : -1);
            if (cIdx >= 0) {
              this.lastBallTouchCarIndex = cIdx;
              this.lastBallTouchTick = typeof copy.tick === 'number' && copy.tick > 0 ? copy.tick : this.currentTick;
            }
          }
        });
      }
      if (this.isRecordingFullReplay) {
        this.sim.recordReplayFrame?.();
      }
      const newTickAfterStep = this.currentTick;

      if (!this.goalLatched) {
        if (typeof this.sim?.getHeaderView === 'function') {
          const g = this.sim.getHeaderView()?.goalScoredFlag || 0;
          if (g !== 0) {
            goalScored = true;
            goalTeam = g === 1 ? 0 : 1;
          }
        } else if (typeof this.sim?.pollGoal === 'function') {
          const g = this.sim.pollGoal();
          if (g !== 0) {
            goalScored = true;
            goalTeam = g === 1 ? 0 : 1;
          }
        }
        if (!goalScored && typeof this.sim?.getBallStateView === 'function') {
          const b = this.sim.getBallStateView();
          const scored = typeof this.sim.isBallScored === 'function'
            ? this.sim.isBallScored(b)
            : (Math.abs(b.posY) > 5120 + 91.25 && Math.abs(b.posX) < 892.755 && b.posZ < 642.775);
          if (scored) {
            goalScored = true;
            goalTeam = b.posY > 0 ? 0 : 1;
          }
        }

        if (goalScored) {
          this.goalLatched = true;
          this.goalScoredAtTick = newTickAfterStep;
          this.frozenBallSnapshot = null;
          if (!frameIncidents.some((inc) => inc && inc.type === 0x0E)) {
            const b = typeof this.sim?.getBallStateView === 'function' ? this.sim.getBallStateView() : null;
            frameIncidents.push({
              type: 0x0E,
              tick: newTickAfterStep,
              carIndex: this.lastBallTouchCarIndex ?? 0,
              team: goalTeam,
              x: b ? b.posX : 0,
              y: b ? b.posY : (goalTeam === 0 ? 5120 : -5120),
              z: b ? b.posZ : 250,
            });
          }
        }
      } else if (this.goalScoredAtTick >= 0 && newTickAfterStep >= this.goalScoredAtTick + POST_GOAL_FREEZE_DELAY_TICKS) {
        if (!this.frozenBallSnapshot && typeof this.sim?.getBallState === 'function') {
          const currentBall = new Float32Array(this.sim.getBallState());
          for (let i = 12; i < 18; i++) currentBall[i] = 0;
          this.frozenBallSnapshot = currentBall;
        }
        if (this.frozenBallSnapshot && typeof this.sim?.setBallState === 'function') {
          this.sim.setBallState(this.frozenBallSnapshot);
        }
      }

      if (typeof this.sim?.getBallStateView === 'function') {
        const b = this.sim.getBallStateView();
        kickoffTouched = Math.abs(b.posX) + Math.abs(b.posY) > 1.0 || Math.hypot(b.velX, b.velY) > 1.0;
      }
    }

    const output = {
      tick: this.currentTick,
      activeCarMask: this.getActiveCarMask(),
      acknowledgedControls: ackList,
      stateSnapshot: typeof this.sim.saveCompactState === 'function'
        ? this.sim.saveCompactState()
        : this.sim.saveState(),
      incidents: frameIncidents,
      goalScored,
      goalTeam,
      scorerCarIndex: this.lastBallTouchCarIndex ?? 0,
      scorerTouchTick: this.lastBallTouchTick ?? null,
      kickoffTouched
    };

    this.onPhysicsOutput?.(output);
    return output;
  }

  resetBallToCenter() {
    this.resetGoalLatch();
    if (typeof this.sim?.setBallState === 'function') {
      this.sim.setBallState(new Float32Array([0, 0, BALL_REST_Z, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    }
  }

  isBallOnGround() {
    if (!this.sim) return false;
    if (typeof this.sim.ballOnGround === 'boolean') return this.sim.ballOnGround;
    if (typeof this.sim.getBallOnGround === 'function') return Boolean(this.sim.getBallOnGround());
    const b = this.sim.getBallStateView?.();
    return Boolean(b && typeof b.posZ === 'number' && b.posZ <= BALL_GROUND_CONTACT_MAX_Z);
  }

  resetKickoff(seed = 0) {
    this.resetGoalLatch();
    this.sim.resetKickoff(seed);
    this.inputBuffer?.clear();
    for (const carIdx of this.directControls.keys()) {
      this.directControls.set(carIdx, { ...NEUTRAL_CONTROLS });
    }
  }

  destroy() {
    this.resetGoalLatch();
    this.inputBuffer?.clear();
    this.directControls.clear();
    this.activeCarIndices.clear();
    this.lastAcknowledgedControls.clear();
    this.sim?.destroy?.();
  }
}

export default PhysicsEngineManager;
