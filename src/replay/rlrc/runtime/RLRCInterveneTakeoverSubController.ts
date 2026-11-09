/**
 * RLRCInterveneTakeoverSubController.ts
 * Continuous static-training-style takeover sub-controller for 120Hz RLRC replays:
 * - Injects 4 seconds (480 frames @ 120Hz) of pre-roll history into ReplayRingBuffer
 * - Hot-swaps POV slot physical hitbox and visual model to the user's current garage preset
 *   with resting-Z ground-penetration protection and aerial flip/double-jump restoration
 * - Supports 3..2..1..GO! Down Counter freeze (zero dead frames recorded into ReplayRingBuffer)
 * - Drives 4 non-POV car modes: 'disappear' | 'no-input' | 'follow-state' | 'bot-takeover'
 * - Unlimited post-takeover duration and instant re-intervene at t0 on pressing G
 */

import { SYSTEM_CONTROL_SIGNALS } from '../../../physics/RocketSimConstants.ts';
import {
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCInterveneLaunchConfig,
  type RLRCNonPovInterventionMode,
  type RLRCSessionPhase,
  type RLRCSynthesizedCarControls,
} from '../RLRCReplayTypes.ts';
import {
  DEFAULT_NEUTRAL_CAR_CONTROLS,
  buildInterveneLaunchConfig,
} from './RLRCInterveneFrameStateBuilder.ts';
import {
  executeIntervenePhysicsStepTick,
  prepareIntervenePrePhysicsControls,
  resetPhysicsAndInterpolatorForShotLaunch,
} from './RLRCInterveneNonPovSyncPipeline.ts';
import {
  injectPrerollHistoryIntoRingBuffer,
  type RLRCPrerollInjectionResult,
} from './RLRCIntervenePrerollInjector.ts';
import {
  applyTargetFrameToPhysicsAndArena,
  deactivateInterveneSlotEntity,
  type RLRCInterveneEnvironmentPort,
} from './RLRCInterveneTargetFrameApplier.ts';

export type * from './RLRCInterveneFrameStateBuilder.ts';
export type * from './RLRCInterveneNonPovSyncPipeline.ts';
export type * from './RLRCIntervenePrerollInjector.ts';

export interface RLRCInterveneStepResult {
  readonly phase: RLRCSessionPhase;
  readonly physicsStepped: boolean;
  readonly currentTick: number;
  readonly countdownRemainingSeconds: number;
  readonly postTakeoverFrameOffset: number;
}

export class RLRCInterveneTakeoverSubController {
  public phase: RLRCSessionPhase = 'viewing';
  public targetFrame120Hz = 0;
  public povSlotIndex = 0;
  public nonPovMode: RLRCNonPovInterventionMode = 'follow-state';
  public downCounterSeconds: 0 | 1 | 2 | 3 = 0;
  public countdownRemainingTicks = 0;
  public countdownRemainingSeconds = 0;
  public prerollInjection: RLRCPrerollInjectionResult | null = null;
  public liveInterventionTick = 1;
  public postTakeoverFrameOffset = 0;
  public lastLaunchConfig: RLRCInterveneLaunchConfig | null = null;

  private readonly env: RLRCInterveneEnvironmentPort;
  private lastBeepSecond = -1;
  private readonly slotActiveTracker = new Uint8Array(RLRC_MAX_PLAYER_SLOTS);
  private readonly latestControlSnapshot = new Map<number, RLRCSynthesizedCarControls>();
  private prevStepStateBuffer: Float32Array | null = null;

  public get _povSlot(): number {
    return this.povSlotIndex;
  }

  public set _povSlot(slot: number) {
    this.povSlotIndex = slot;
  }

  constructor(env: RLRCInterveneEnvironmentPort) {
    this.env = env;
  }

  public enterInterveneAtFrame(
    t0FrameIndex: number,
    overrides?: Partial<RLRCInterveneLaunchConfig>
  ): RLRCInterveneLaunchConfig | null {
    const frames = this.env.getFrames120Hz();
    if (!frames || frames.length === 0) return null;

    const clampedT0 = Math.max(0, Math.min(frames.length - 1, Math.round(t0FrameIndex)));
    const targetFrame = frames[clampedT0];
    if (!targetFrame) return null;

    const roster = this.env.getRoster();
    const launchConfig = buildInterveneLaunchConfig({
      targetFrame,
      targetFrame120Hz: clampedT0,
      roster,
      currentPovSlotIndex: this.povSlotIndex,
      currentNonPovMode: this.nonPovMode,
      currentDownCounterSeconds: this.downCounterSeconds,
      overrides,
    });

    this.targetFrame120Hz = clampedT0;
    this.povSlotIndex = launchConfig.povSlotIndex;
    this.nonPovMode = launchConfig.nonPovMode;
    this.downCounterSeconds = launchConfig.downCounterSeconds;
    this.lastLaunchConfig = launchConfig;
    this.postTakeoverFrameOffset = 0;

    this.prerollInjection = injectPrerollHistoryIntoRingBuffer({
      frames120Hz: frames,
      bookmarks: this.env.getBookmarks?.(),
      targetFrame120Hz: clampedT0,
      maxPrerollFrames: launchConfig.prerollHistoryFrames,
      povOverride: {
        povSlotIndex: launchConfig.povSlotIndex,
        playerHitboxId: launchConfig.playerHitboxId,
      },
      ringBuffer: this.env.getRingBuffer?.(),
      goalAndTouch: this.env.getGoalAndTouch?.(),
    });
    this.liveInterventionTick = this.prerollInjection.nextLiveTick;

    const sim = this.env.getPhysics();
    if (sim) {
      applyTargetFrameToPhysicsAndArena({
        frame: targetFrame,
        roster,
        config: launchConfig,
        sim,
        arena: this.env.getArena?.(),
        slotActiveTracker: this.slotActiveTracker,
        rebuildMeshes: true,
      });
    }

    const downCounterSeconds = launchConfig.downCounterSeconds;
    if (downCounterSeconds > 0) {
      this.phase = 'preroll-countdown';
      this.countdownRemainingTicks = downCounterSeconds * 120;
      this.countdownRemainingSeconds = downCounterSeconds;
      this.lastBeepSecond = downCounterSeconds;
      this.env.playSound?.('training_countdown', 1.0, 150);
      this.env.emitSystemSignal?.(
        SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
        this.prerollInjection.finalPrerollTick,
        downCounterSeconds
      );
      this.env.onPhaseChanged?.('preroll-countdown', downCounterSeconds);
    } else {
      this.launchShotNow();
    }
    return launchConfig;
  }

  public reinterveneAtLastTargetFrame(
    overrides?: Partial<RLRCInterveneLaunchConfig>
  ): RLRCInterveneLaunchConfig | null {
    return this.enterInterveneAtFrame(this.targetFrame120Hz, {
      ...this.lastLaunchConfig,
      ...overrides,
    });
  }

  public launchShotNow(): void {
    const targetFrame = this.env.getFrames120Hz()[this.targetFrame120Hz];
    if (!targetFrame || !this.lastLaunchConfig) return;

    this.countdownRemainingTicks = 0;
    this.countdownRemainingSeconds = 0;
    this.lastBeepSecond = -1;
    this.postTakeoverFrameOffset = 0;
    this.phase = 'intervening';

    this.prevStepStateBuffer = resetPhysicsAndInterpolatorForShotLaunch({
      targetFrame,
      roster: this.env.getRoster(),
      config: this.lastLaunchConfig,
      sim: this.env.getPhysics(),
      arena: this.env.getArena?.(),
      slotActiveTracker: this.slotActiveTracker,
      finalPrerollTick: this.prerollInjection?.finalPrerollTick ?? 1,
      prevStepStateBuffer: this.prevStepStateBuffer,
    });

    if (this.nonPovMode === 'bot-takeover') {
      this.env.getBotPort?.()?.resetAllBots?.();
    }

    this.env.playSound?.('match_start_go', 1.0, 150);
    this.env.emitSystemSignal?.(
      SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME,
      this.liveInterventionTick,
      1
    );
    this.env.onPhaseChanged?.('intervening', 0);
  }

  public stepBeforeLivePhysics(
    playerControls: RLRCSynthesizedCarControls = DEFAULT_NEUTRAL_CAR_CONTROLS,
    dt = RLRC_FIXED_DT
  ): void {
    const sim = this.phase === 'intervening' ? this.env.getPhysics() : null;
    if (!sim) return;

    prepareIntervenePrePhysicsControls({
      sim,
      arena: this.env.getArena?.(),
      botPort: this.env.getBotPort?.(),
      frames: this.env.getFrames120Hz(),
      roster: this.env.getRoster(),
      followIdx: this.targetFrame120Hz + this.postTakeoverFrameOffset,
      povSlotIndex: this._povSlot,
      nonPovMode: this.nonPovMode,
      playerControls,
      liveInterventionTick: this.liveInterventionTick,
      dt,
      slotActiveTracker: this.slotActiveTracker,
      latestControlSnapshot: this.latestControlSnapshot,
    });
    this.liveInterventionTick++;
    this.postTakeoverFrameOffset++;
  }

  public stepTick(
    playerControls: RLRCSynthesizedCarControls = DEFAULT_NEUTRAL_CAR_CONTROLS,
    dt = RLRC_FIXED_DT
  ): RLRCInterveneStepResult {
    if (this.phase === 'preroll-countdown') {
      return this.stepCountdownTick(dt);
    }

    const sim = this.phase === 'intervening' ? this.env.getPhysics() : null;
    if (!sim) {
      return {
        phase: this.phase,
        physicsStepped: false,
        currentTick: this.phase === 'intervening' ? this.liveInterventionTick : 0,
        countdownRemainingSeconds: 0,
        postTakeoverFrameOffset: this.postTakeoverFrameOffset,
      };
    }

    const followIdx = this.targetFrame120Hz + this.postTakeoverFrameOffset;
    const recordedTick = this.liveInterventionTick++;
    this.postTakeoverFrameOffset++;

    this.prevStepStateBuffer = executeIntervenePhysicsStepTick({
      sim,
      arena: this.env.getArena?.(),
      botPort: this.env.getBotPort?.(),
      ringBuffer: this.env.getRingBuffer?.(),
      frames: this.env.getFrames120Hz(),
      roster: this.env.getRoster(),
      followIdx,
      povSlotIndex: this._povSlot,
      nonPovMode: this.nonPovMode,
      playerControls,
      recordedTick,
      dt,
      slotActiveTracker: this.slotActiveTracker,
      latestControlSnapshot: this.latestControlSnapshot,
      prevStepStateBuffer: this.prevStepStateBuffer,
    });

    return {
      phase: 'intervening',
      physicsStepped: true,
      currentTick: recordedTick,
      countdownRemainingSeconds: 0,
      postTakeoverFrameOffset: this.postTakeoverFrameOffset,
    };
  }

  private stepCountdownTick(dt: number): RLRCInterveneStepResult {
    const targetFrame = this.env.getFrames120Hz()[this.targetFrame120Hz];
    if (targetFrame) {
      this.env.getArena?.()?.spinBallInPlace?.(targetFrame.ball.rigidBody.angularVelocity, dt);
    }

    this.countdownRemainingTicks = Math.max(0, this.countdownRemainingTicks - 1);
    if (this.countdownRemainingTicks <= 0) {
      this.launchShotNow();
      return {
        phase: this.phase,
        physicsStepped: false,
        currentTick: this.liveInterventionTick,
        countdownRemainingSeconds: 0,
        postTakeoverFrameOffset: 0,
      };
    }

    const nextSec = Math.max(1, Math.ceil(this.countdownRemainingTicks / 120));
    if (nextSec !== this.countdownRemainingSeconds) {
      this.countdownRemainingSeconds = nextSec;
      if (nextSec !== this.lastBeepSecond) {
        this.lastBeepSecond = nextSec;
        this.env.playSound?.('training_countdown', 1.0, 150);
      }
      this.env.onPhaseChanged?.('preroll-countdown', nextSec);
    }

    return {
      phase: 'preroll-countdown',
      physicsStepped: false,
      currentTick: this.prerollInjection?.finalPrerollTick ?? 1,
      countdownRemainingSeconds: this.countdownRemainingSeconds,
      postTakeoverFrameOffset: 0,
    };
  }

  public setNonPovMode(nonPovMode: RLRCNonPovInterventionMode): void {
    this.nonPovMode = nonPovMode;
    if (this.lastLaunchConfig) {
      this.lastLaunchConfig = { ...this.lastLaunchConfig, nonPovMode };
    }
    if (this.phase === 'intervening' || this.phase === 'preroll-countdown') {
      const sim = this.env.getPhysics();
      const arena = this.env.getArena?.();
      if (nonPovMode === 'disappear' && sim) {
        for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
          if (slot !== this.povSlotIndex) {
            deactivateInterveneSlotEntity(sim, arena, this.slotActiveTracker, slot);
          }
        }
      } else if (nonPovMode === 'bot-takeover') {
        this.env.getBotPort?.()?.resetAllBots?.();
      }
    }
  }

  public exitInterveneToViewing(): number {
    const povMeta = this.env.getRoster().find((r) => r.slotIndex === this.povSlotIndex);
    if (povMeta) {
      this.env
        .getArena?.()
        ?.rebuildSlotVehicle?.(
          povMeta.slotIndex,
          povMeta.team,
          povMeta.hitboxId,
          povMeta.visualId,
          povMeta.primaryColorHex
        );
    }
    this.countdownRemainingTicks = 0;
    this.countdownRemainingSeconds = 0;
    this.lastBeepSecond = -1;
    this.phase = 'viewing';
    this.env.onPhaseChanged?.('viewing', 0);
    return this.targetFrame120Hz;
  }
}
