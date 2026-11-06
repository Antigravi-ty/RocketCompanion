/**
 * src/network/server/match/MatchSystemControlSubController.ts
 * Stateful SubController owning authoritative System Control Mode transitions
 * (SYS_CTRL_STATE_ONLY, SYS_CTRL_INTERVENE_WILL_RESUME, SYS_CTRL_PHYSICS_RESUME)
 * and homologous Training / Freeplay ruleset configuration.
 *
 * Keeps system-level timeline control (Rewinder scrub, Replay seek, Takeover countdown,
 * and live physics resume) decoupled from regulation match phase logic while sharing
 * the exact same authoritative signal & snapshot pipeline across Single Player and Multiplayer.
 */

import { MATCH_SIGNALS, SYSTEM_CONTROL_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import { REPLAY_BUFFER_MODES } from '../../../replay/ReplayRingBuffer.ts';
import { MATCH_STATES, MATCH_TICK_RATE } from './matchLoadoutAndSpawnPipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';
import type { MatchCommandQueueSubController } from './MatchCommandQueueSubController.ts';

export interface MatchSystemControlHostPort {
  readonly domain: MatchDomainState;
  readonly commandQueue: MatchCommandQueueSubController;
  readonly physicsManager: any;
  readonly replayBuffer: any;
  encodeFramePacket(physicsSnapshot: any): Uint8Array;
}

export interface TrainingRulesetConfigOptions {
  unlimitedBoost?: boolean;
  disableGoalReset?: boolean;
  goalReplayEnabled?: boolean;
  celebrationTicks?: number;
  fifoDurationSeconds?: number;
}

export class MatchSystemControlSubController {
  readonly host: MatchSystemControlHostPort;

  isStateOnlyMode = false;
  interveneTargetTick = -1;
  interveneCountdownSeconds = 0;
  interveneRemainingTicks = -1;
  lastSystemControlSignal = 0;
  systemControlSignalHistory: Array<{
    signalType: number;
    frameId: number;
    param1: number;
    param2: number;
  }> = [];

  constructor(host: MatchSystemControlHostPort) {
    this.host = host;
  }

  private recordSignal(signalType: number, frameId: number, param1 = 0, param2 = 0): void {
    this.lastSystemControlSignal = signalType;
    this.systemControlSignalHistory.push({ signalType, frameId, param1, param2 });
    if (this.systemControlSignalHistory.length > 64) {
      this.systemControlSignalHistory.shift();
    }
  }

  configureTrainingRuleset(options: TrainingRulesetConfigOptions = {}): void {
    const { domain, physicsManager, replayBuffer } = this.host;
    if (options.disableGoalReset !== undefined) {
      domain.trainingDisableGoalReset = Boolean(options.disableGoalReset);
    }
    if (options.goalReplayEnabled !== undefined) {
      domain.trainingGoalReplayEnabled = Boolean(options.goalReplayEnabled);
    }
    if (typeof options.celebrationTicks === 'number' && options.celebrationTicks > 0) {
      domain.trainingGoalCelebrationTicks = Math.round(options.celebrationTicks);
    }
    if (options.unlimitedBoost !== undefined) {
      domain.trainingUnlimitedBoost = Boolean(options.unlimitedBoost);
      physicsManager?.sim?.setUnlimitedBoost?.(Boolean(options.unlimitedBoost));
    }
    if (
      typeof options.fifoDurationSeconds === 'number' &&
      options.fifoDurationSeconds > 0 &&
      replayBuffer
    ) {
      replayBuffer.configureMode(
        REPLAY_BUFFER_MODES.COUNTUP_FIFO,
        Math.round(options.fifoDurationSeconds * MATCH_TICK_RATE)
      );
    }
  }

  enterStateOnlyMode(stateSnapshot?: Float32Array | number[] | null, cursorTick?: number): void {
    const { domain, physicsManager, commandQueue } = this.host;
    this.isStateOnlyMode = true;
    this.interveneTargetTick = -1;
    this.interveneRemainingTicks = -1;
    domain.stateOnlyMode = true;
    domain.interveneTargetTick = -1;

    if (physicsManager) {
      if (stateSnapshot && physicsManager.sim) {
        if (typeof physicsManager.sim.loadCompactState === 'function') {
          physicsManager.sim.loadCompactState(stateSnapshot);
        } else if (typeof physicsManager.sim.loadState === 'function') {
          physicsManager.sim.loadState(stateSnapshot);
        }
        physicsManager.sim.syncToStateObject?.();
      }
      if (typeof cursorTick === 'number' && cursorTick >= 0) {
        physicsManager.currentTick = cursorTick;
        domain.matchTick = cursorTick;
      }
      physicsManager.applySignal(SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY, {
        cursorTick: domain.matchTick,
      });
    }

    commandQueue.retireSignalTypes([
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
    ]);
    const cursorParam = typeof cursorTick === 'number' ? cursorTick : domain.matchTick;
    this.recordSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      domain.matchTick,
      cursorParam,
      0
    );
    commandQueue.dispatchSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      domain.matchTick,
      cursorParam,
      0
    );
  }

  beginInterveneCountdown(
    countdownSeconds = 3,
    stateSnapshot?: Float32Array | number[] | null
  ): number {
    const { domain, physicsManager, commandQueue } = this.host;
    const clampedSec = Math.max(0.25, Number.isFinite(countdownSeconds) ? countdownSeconds : 3);
    const ticks = Math.max(1, Math.round(clampedSec * MATCH_TICK_RATE));
    this.isStateOnlyMode = true;
    this.interveneCountdownSeconds = Math.ceil(clampedSec);
    this.interveneRemainingTicks = ticks;
    this.interveneTargetTick = domain.matchTick + ticks;
    domain.stateOnlyMode = true;
    domain.interveneTargetTick = this.interveneTargetTick;

    if (physicsManager) {
      if (stateSnapshot && physicsManager.sim) {
        if (typeof physicsManager.sim.loadCompactState === 'function') {
          physicsManager.sim.loadCompactState(stateSnapshot);
        } else if (typeof physicsManager.sim.loadState === 'function') {
          physicsManager.sim.loadState(stateSnapshot);
        }
        physicsManager.sim.syncToStateObject?.();
      }
      physicsManager.applySignal(SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME, {
        targetResumeTick: this.interveneTargetTick,
        countdownSeconds: this.interveneCountdownSeconds,
      });
    }

    commandQueue.retireSignalTypes([
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
    ]);
    this.recordSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      domain.matchTick,
      this.interveneTargetTick,
      this.interveneCountdownSeconds
    );
    commandQueue.dispatchSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      domain.matchTick,
      this.interveneTargetTick,
      this.interveneCountdownSeconds
    );
    return this.interveneTargetTick;
  }

  resumePhysicsFromState(
    stateSnapshot?: Float32Array | number[] | null,
    resumeTick?: number
  ): void {
    const { domain, physicsManager, commandQueue } = this.host;
    this.isStateOnlyMode = false;
    this.interveneTargetTick = -1;
    this.interveneRemainingTicks = -1;
    domain.stateOnlyMode = false;
    domain.interveneTargetTick = -1;
    if (domain.state === MATCH_STATES.PAUSED || domain.state === MATCH_STATES.REPLAY) {
      domain.state = MATCH_STATES.PLAYING;
    }

    if (physicsManager) {
      if (stateSnapshot && physicsManager.sim) {
        if (typeof physicsManager.sim.loadCompactState === 'function') {
          physicsManager.sim.loadCompactState(stateSnapshot);
        } else if (typeof physicsManager.sim.loadState === 'function') {
          physicsManager.sim.loadState(stateSnapshot);
        }
        physicsManager.sim.syncToStateObject?.();
      }
      if (typeof resumeTick === 'number' && resumeTick >= 0) {
        physicsManager.currentTick = resumeTick;
        domain.matchTick = resumeTick;
      }
      physicsManager.applySignal(SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME, {
        resumeTick: domain.matchTick,
      });
      if (domain.isTrainingMode) {
        physicsManager.sim?.setUnlimitedBoost?.(true);
      }
    }

    commandQueue.retireSignalTypes([
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
    ]);
    this.recordSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
      domain.matchTick,
      domain.matchTick,
      domain.isTrainingMode ? 1 : 0
    );
    commandQueue.dispatchSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
      domain.matchTick,
      domain.matchTick,
      domain.isTrainingMode ? 1 : 0
    );
  }

  stepStateOnlyFrameIfActive(): Uint8Array | null {
    if (!this.isStateOnlyMode) return null;
    const { domain, physicsManager } = this.host;

    if (this.interveneRemainingTicks > 0) {
      this.interveneRemainingTicks--;
      domain.matchTick++;
      if (physicsManager) {
        physicsManager.currentTick = domain.matchTick;
      }
      if (this.interveneRemainingTicks <= 0) {
        this.resumePhysicsFromState(null, domain.matchTick);
        return null;
      }
    }

    const sim = physicsManager?.sim;
    const rawSnap =
      sim && typeof sim.saveCompactState === 'function'
        ? sim.saveCompactState()
        : sim && typeof sim.saveState === 'function'
          ? sim.saveState()
          : null;
    const stateOnlySnapshot = rawSnap
      ? {
          tick: domain.matchTick,
          activeCarMask: physicsManager?.getActiveCarMask?.() || 1,
          stateSnapshot: rawSnap,
          acknowledgedControls: [],
          isReplaySlice: true,
        }
      : null;

    return this.host.encodeFramePacket(stateOnlySnapshot);
  }

  clear(): void {
    this.isStateOnlyMode = false;
    this.interveneTargetTick = -1;
    this.interveneCountdownSeconds = 0;
    this.interveneRemainingTicks = -1;
  }
}
