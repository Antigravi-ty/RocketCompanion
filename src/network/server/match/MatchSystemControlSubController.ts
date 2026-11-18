/**
 * src/network/server/match/MatchSystemControlSubController.ts
 * Stateful SubController owning authoritative System Control Mode transitions
 * (SYS_CTRL_STATE_ONLY, SYS_CTRL_INTERVENE_WILL_RESUME, SYS_CTRL_PHYSICS_RESUME),
 * homologous Training / Freeplay ruleset configuration, and server replay timeline stepping.
 */

import { SIM_OFFSETS, SYSTEM_CONTROL_SIGNALS } from '../../../physics/RocketSimConstants.ts';
import { REPLAY_BUFFER_MODES } from '../../../replay/ReplayRingBuffer.ts';
import type { CarControlsInput } from '../../protocol/InputPacketCodec.ts';
import { MATCH_TICK_RATE } from './matchLoadoutAndSpawnPipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';
import type { MatchCommandQueueSubController } from './MatchCommandQueueSubController.ts';
import type { LifecyclePhysicsSnapshotPort } from './matchLifecyclePipeline.ts';

export interface BroadcastAcknowledgedControlEntry {
  carIndex: number;
  controls: CarControlsInput;
}

export interface SystemControlPhysicsManagerPort {
  currentTick: number;
  sim?: {
    setUnlimitedBoost?: (enabled: boolean) => void;
    restoreCompactState?: (
      snapshot: Float32Array | number[],
      opts?: { overrideTick?: number }
    ) => void;
    restoreState?: (snapshot: Float32Array | number[], opts?: { overrideTick?: number }) => void;
    loadCompactState?: (snapshot: Float32Array | number[]) => void;
    loadState?: (snapshot: Float32Array | number[]) => void;
    syncToStateObject?: () => void;
    saveCompactState?: () => Float32Array;
    saveState?: () => Float32Array;
  } | null;
  applySignal: (signal: number | string, payload?: Record<string, unknown>) => void;
  getActiveCarMask?: () => number;
}

export interface SystemControlReplayBufferPort {
  configureMode: (mode: string, capacityTicks?: number | null) => void;
}

export interface MatchSystemControlHostPort {
  readonly domain: MatchDomainState;
  readonly commandQueue: MatchCommandQueueSubController;
  readonly physicsManager: SystemControlPhysicsManagerPort | null | undefined;
  readonly replayBuffer: SystemControlReplayBufferPort | null | undefined;
  encodeFramePacket(physicsSnapshot: LifecyclePhysicsSnapshotPort | null): Uint8Array;
}

export interface TrainingRulesetConfigOptions {
  unlimitedBoost?: boolean;
  disableGoalReset?: boolean;
  goalReplayEnabled?: boolean;
  celebrationTicks?: number;
  fifoDurationSeconds?: number;
}

export type TrainingRulesetOptions = TrainingRulesetConfigOptions;

export class MatchSystemControlSubController {
  readonly host: MatchSystemControlHostPort;
  isStateOnlyMode = false;
  interveneTargetTick = -1;
  interveneCountdownSeconds = 0;
  interveneRemainingTicks = -1;
  lastSystemControlSignal = 0;
  broadcastAcknowledgedControls: BroadcastAcknowledgedControlEntry[] = [];
  systemControlSignalHistory: Array<{
    signalType: number;
    frameId: number;
    param1: number;
    param2: number;
  }> = [];

  constructor(host: MatchSystemControlHostPort) {
    this.host = host;
  }

  private emitSysSignal(sig: number, frameId: number, p1 = 0, p2 = 0, retire: number[] = []): void {
    this.host.commandQueue.retireSignalTypes(retire, true);
    this.lastSystemControlSignal = sig;
    this.systemControlSignalHistory.push({ signalType: sig, frameId, param1: p1, param2: p2 });
    if (this.systemControlSignalHistory.length > 64) this.systemControlSignalHistory.shift();
    this.host.commandQueue.dispatchSignal(sig, frameId, p1, p2);
  }

  private loadSimSnapshot(snap?: Float32Array | number[] | null, tick?: number): void {
    const pm = this.host.physicsManager;
    if (!pm) return;
    if (snap && pm.sim) {
      const simAny = pm.sim as unknown as {
        numCars?: number;
        isCarSlotActive?: (idx: number) => boolean;
        addCarAtSlot?: (idx: number, team: number, preset?: string) => void;
        addCar?: (team: number, preset?: string) => void;
        removeCar?: (idx: number) => boolean | void;
      };
      const headerCars =
        snap.length > SIM_OFFSETS.NUM_CARS
          ? Math.min(8, Math.max(0, Math.round(Number(snap[SIM_OFFSETS.NUM_CARS]) || 0)))
          : 0;
      if (headerCars > 0) {
        if (
          typeof simAny.isCarSlotActive === 'function' &&
          typeof simAny.addCarAtSlot === 'function'
        ) {
          for (let c = 0; c < headerCars; c++) {
            if (!simAny.isCarSlotActive(c)) simAny.addCarAtSlot(c, c % 2, 'octane');
          }
          if (typeof simAny.removeCar === 'function') {
            for (let c = headerCars; c < 8; c++) {
              if (simAny.isCarSlotActive(c)) simAny.removeCar(c);
            }
          }
        } else {
          if (typeof simAny.addCar === 'function') {
            while ((simAny.numCars ?? 0) < headerCars) {
              simAny.addCar((simAny.numCars ?? 0) % 2, 'octane');
            }
          }
          if (typeof simAny.removeCar === 'function') {
            while ((simAny.numCars ?? 0) > headerCars && (simAny.numCars ?? 0) > 1) {
              if (!simAny.removeCar((simAny.numCars ?? 1) - 1)) break;
            }
          }
        }
      }
      const opts = typeof tick === 'number' && tick >= 0 ? { overrideTick: tick } : undefined;
      if (typeof pm.sim.restoreCompactState === 'function') pm.sim.restoreCompactState(snap, opts);
      else if (typeof pm.sim.restoreState === 'function') pm.sim.restoreState(snap, opts);
      else if (typeof pm.sim.loadCompactState === 'function') pm.sim.loadCompactState(snap);
      else if (typeof pm.sim.loadState === 'function') pm.sim.loadState(snap);
      pm.sim.syncToStateObject?.();
    }
    if (typeof tick === 'number' && tick >= 0) pm.currentTick = tick;
  }

  configureTrainingRuleset(o: TrainingRulesetConfigOptions = {}): void {
    const { domain, physicsManager, replayBuffer } = this.host;
    domain.applyTrainingRulesetOptions(o);
    if (o.unlimitedBoost !== undefined)
      physicsManager?.sim?.setUnlimitedBoost?.(Boolean(o.unlimitedBoost));
    if (typeof o.fifoDurationSeconds === 'number' && o.fifoDurationSeconds > 0 && replayBuffer) {
      replayBuffer.configureMode(
        REPLAY_BUFFER_MODES.COUNTUP_FIFO,
        Math.round(o.fifoDurationSeconds * MATCH_TICK_RATE)
      );
    }
  }

  pushBroadcastSnapshot(
    snap?: Float32Array | number[] | null,
    cursorTick?: number,
    acknowledgedControls?: BroadcastAcknowledgedControlEntry[] | null
  ): void {
    if (!this.isStateOnlyMode) {
      this.enterStateOnlyMode(snap, cursorTick, acknowledgedControls);
      return;
    }
    const { domain } = this.host;
    this.interveneTargetTick = this.interveneRemainingTicks = -1;
    this.broadcastAcknowledgedControls = Array.isArray(acknowledgedControls)
      ? acknowledgedControls
      : [];
    if (typeof cursorTick === 'number' && Number.isFinite(cursorTick) && cursorTick >= 0) {
      domain.matchTick = Math.floor(cursorTick);
    }
    this.loadSimSnapshot(snap, cursorTick);
  }

  pushBroadcastSignal(
    signalType: number,
    frameId?: number,
    param1 = 0,
    param2 = 0,
    replaceTypes?: number[]
  ): void {
    if (!this.isStateOnlyMode) return;
    if (Array.isArray(replaceTypes) && replaceTypes.length > 0) {
      this.host.commandQueue.retireSignalTypes(replaceTypes, true);
    }
    const targetFrame =
      typeof frameId === 'number' && Number.isFinite(frameId)
        ? Math.floor(frameId)
        : this.host.domain.matchTick;
    this.host.commandQueue.dispatchSignal(signalType, targetFrame, param1, param2);
  }

  enterStateOnlyMode(
    snap?: Float32Array | number[] | null,
    cursorTick?: number,
    acknowledgedControls?: BroadcastAcknowledgedControlEntry[] | null
  ): void {
    const { domain, physicsManager } = this.host;
    this.isStateOnlyMode = true;
    this.interveneTargetTick = this.interveneRemainingTicks = -1;
    this.broadcastAcknowledgedControls = Array.isArray(acknowledgedControls)
      ? acknowledgedControls
      : [];
    domain.applySystemControlState('state_only', cursorTick);
    this.loadSimSnapshot(snap, cursorTick);
    physicsManager?.applySignal(SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY, {
      cursorTick: domain.matchTick,
    });
    this.emitSysSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
      domain.matchTick,
      typeof cursorTick === 'number' ? cursorTick : domain.matchTick,
      0,
      [
        SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
        SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
      ]
    );
  }

  beginInterveneCountdown(sec = 3, snap?: Float32Array | number[] | null): number {
    const { domain, physicsManager } = this.host;
    const clampedSec = Math.max(0.25, Number.isFinite(sec) ? sec : 3);
    const ticks = Math.max(1, Math.round(clampedSec * MATCH_TICK_RATE));
    this.isStateOnlyMode = true;
    this.interveneCountdownSeconds = Math.ceil(clampedSec);
    this.interveneRemainingTicks = ticks;
    this.interveneTargetTick = domain.applySystemControlState('intervene', ticks);
    this.loadSimSnapshot(snap, domain.matchTick);
    physicsManager?.applySignal(SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME, {
      targetResumeTick: this.interveneTargetTick,
      countdownSeconds: this.interveneCountdownSeconds,
    });
    this.emitSysSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      domain.matchTick,
      this.interveneTargetTick,
      this.interveneCountdownSeconds,
      [SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY, SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME]
    );
    return this.interveneTargetTick;
  }

  resumePhysicsFromState(snap?: Float32Array | number[] | null, resumeTick?: number): void {
    const { domain, physicsManager } = this.host;
    this.isStateOnlyMode = false;
    this.interveneTargetTick = this.interveneRemainingTicks = -1;
    domain.applySystemControlState('resume', resumeTick);
    this.loadSimSnapshot(snap, resumeTick);
    physicsManager?.applySignal(SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME, {
      resumeTick: domain.matchTick,
    });
    if (domain.isTrainingMode) physicsManager?.sim?.setUnlimitedBoost?.(true);
    this.emitSysSignal(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
      domain.matchTick,
      domain.matchTick,
      domain.isTrainingMode ? 1 : 0,
      [
        SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
        SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
      ]
    );
  }

  stepStateOnlyFrameIfActive(): Uint8Array | null {
    if (!this.isStateOnlyMode) return null;
    const { domain, physicsManager } = this.host;
    if (this.interveneRemainingTicks > 0) {
      this.interveneRemainingTicks--;
      domain.matchTick += 1;
      if (physicsManager) physicsManager.currentTick = domain.matchTick;
      if (this.interveneRemainingTicks <= 0) {
        this.resumePhysicsFromState(null, domain.matchTick);
        return null;
      }
    }
    const sim = physicsManager?.sim;
    const rawSnap = sim?.saveCompactState
      ? sim.saveCompactState()
      : sim?.saveState
        ? sim.saveState()
        : null;
    const snapCarCount =
      rawSnap && rawSnap.length > SIM_OFFSETS.NUM_CARS
        ? Math.min(8, Math.max(0, Math.round(Number(rawSnap[SIM_OFFSETS.NUM_CARS]) || 0)))
        : 0;
    const stateOnlyCarMask =
      snapCarCount > 0
        ? ((1 << snapCarCount) - 1) & 0xff
        : physicsManager?.getActiveCarMask?.() || 1;
    return this.host.encodeFramePacket(
      rawSnap
        ? {
            activeCarMask: stateOnlyCarMask,
            stateSnapshot: rawSnap,
            acknowledgedControls: this.broadcastAcknowledgedControls,
            isReplaySlice: true,
          }
        : null
    );
  }

  clear(): void {
    this.isStateOnlyMode = false;
    this.interveneTargetTick = this.interveneRemainingTicks = -1;
    this.interveneCountdownSeconds = 0;
    this.broadcastAcknowledgedControls = [];
  }
}
