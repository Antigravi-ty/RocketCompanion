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

import {
  SIM_OFFSETS,
  SYSTEM_CONTROL_SIGNALS,
} from '../../../physics/RocketSimConstants.ts';
import type { ReplayAcknowledgedControlEntry } from '../../ReplayRingBuffer.ts';
import {
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_PREROLL_HISTORY_FRAMES,
  type RLRCFrame120Hz,
  type RLRCInterveneLaunchConfig,
  type RLRCNonPovInterventionMode,
  type RLRCPlayerSlotMeta,
  type RLRCSessionPhase,
  type RLRCSynthesizedCarControls,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
import {
  DEFAULT_NEUTRAL_CAR_CONTROLS,
  injectPrerollHistoryIntoRingBuffer,
  resolveCurrentUserInterveneLoadout,
  type RLRCPrerollInjectionResult,
} from './RLRCInterveneFrameStateBuilder.ts';
import {
  applyTargetFrameToPhysicsAndArena,
  deactivateInterveneSlotEntity,
  stepNonPovCarsBeforePhysics,
  syncFollowStateNonPovAfterStep,
  type RLRCInterveneEnvironmentPort,
} from './RLRCInterveneNonPovSyncPipeline.ts';

export type * from './RLRCInterveneFrameStateBuilder.ts';
export type * from './RLRCInterveneNonPovSyncPipeline.ts';

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
  private slotActiveTracker = new Uint8Array(RLRC_MAX_PLAYER_SLOTS);
  private latestControlSnapshot = new Map<number, RLRCSynthesizedCarControls>();

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
    const povSlotIndex = this.resolveValidPovSlotIndex(
      targetFrame,
      roster,
      overrides?.povSlotIndex ?? this.povSlotIndex
    );
    const povMeta = roster.find((r) => r.slotIndex === povSlotIndex);
    const povTeam: RLRCTeamIndex = povMeta?.team ?? (povSlotIndex < 3 ? 0 : 1);
    const userLoadout = resolveCurrentUserInterveneLoadout(povTeam, {
      hitboxId: overrides?.playerHitboxId,
      visualId: overrides?.playerVisualId,
      colorHex: overrides?.playerColorHex,
    });

    const nonPovMode = overrides?.nonPovMode ?? this.nonPovMode;
    const downCounterSeconds = overrides?.downCounterSeconds ?? this.downCounterSeconds;
    const prerollHistoryFrames = overrides?.prerollHistoryFrames ?? RLRC_PREROLL_HISTORY_FRAMES;

    const launchConfig: RLRCInterveneLaunchConfig = {
      targetFrame120Hz: clampedT0,
      povSlotIndex,
      playerHitboxId: userLoadout.hitboxId,
      playerVisualId: userLoadout.visualId,
      playerColorHex: userLoadout.colorHex,
      downCounterSeconds,
      nonPovMode,
      prerollHistoryFrames,
    };

    this.targetFrame120Hz = clampedT0;
    this.povSlotIndex = povSlotIndex;
    this.nonPovMode = nonPovMode;
    this.downCounterSeconds = downCounterSeconds;
    this.lastLaunchConfig = launchConfig;
    this.postTakeoverFrameOffset = 0;

    this.prerollInjection = injectPrerollHistoryIntoRingBuffer({
      frames120Hz: frames,
      bookmarks: this.env.getBookmarks?.(),
      targetFrame120Hz: clampedT0,
      maxPrerollFrames: prerollHistoryFrames,
      povOverride: { povSlotIndex, playerHitboxId: userLoadout.hitboxId },
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

    const sim = this.env.getPhysics();
    const arena = this.env.getArena?.();
    if (sim) {
      applyTargetFrameToPhysicsAndArena({
        frame: targetFrame,
        roster: this.env.getRoster(),
        config: this.lastLaunchConfig,
        sim,
        arena,
        slotActiveTracker: this.slotActiveTracker,
        rebuildMeshes: false,
      });
      sim.clearEvents?.();
      sim.resetGoalLatch?.();
      if (sim.state) {
        sim.state[SIM_OFFSETS.TICK] = this.prerollInjection?.finalPrerollTick ?? 1;
        sim.state[SIM_OFFSETS.GOAL] = 0;
        arena?.syncInterpolatorToState?.(sim.state);
      }
    }

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

  public stepTick(
    playerControls: RLRCSynthesizedCarControls = DEFAULT_NEUTRAL_CAR_CONTROLS,
    dt = RLRC_FIXED_DT
  ): RLRCInterveneStepResult {
    if (this.phase === 'preroll-countdown') {
      const targetFrame = this.env.getFrames120Hz()[this.targetFrame120Hz];
      if (targetFrame) {
        this.env
          .getArena?.()
          ?.spinBallInPlace?.(targetFrame.ball.rigidBody.angularVelocity, dt);
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

    this.latestControlSnapshot.clear();
    sim.setCarControls?.(this.povSlotIndex, playerControls);
    this.latestControlSnapshot.set(this.povSlotIndex, playerControls);

    const frames = this.env.getFrames120Hz();
    const roster = this.env.getRoster();
    const arena = this.env.getArena?.();
    const followIdx = this.targetFrame120Hz + this.postTakeoverFrameOffset;

    stepNonPovCarsBeforePhysics({
      sim,
      arena,
      botPort: this.env.getBotPort?.(),
      roster,
      followFrame: followIdx >= 0 && followIdx < frames.length ? frames[followIdx] : null,
      povSlotIndex: this.povSlotIndex,
      nonPovMode: this.nonPovMode,
      slotActiveTracker: this.slotActiveTracker,
      latestControlSnapshot: this.latestControlSnapshot,
      dt,
    });

    sim.step?.(dt, playerControls);

    if (this.nonPovMode === 'follow-state') {
      const nextIdx = followIdx + 1;
      syncFollowStateNonPovAfterStep({
        sim,
        arena,
        roster,
        nextFrame: nextIdx >= 0 && nextIdx < frames.length ? frames[nextIdx] : null,
        povSlotIndex: this.povSlotIndex,
        slotActiveTracker: this.slotActiveTracker,
      });
    }

    const recordedTick = this.liveInterventionTick++;
    this.postTakeoverFrameOffset++;

    if (sim.state) {
      sim.state[SIM_OFFSETS.TICK] = recordedTick;
      const acknowledgedControls = this.collectLiveAcknowledgedControls();
      const slot = this.env
        .getRingBuffer?.()
        ?.recordFrame?.(recordedTick, sim.state, { acknowledgedControls });
      if (slot?.snapshot) slot.snapshot[SIM_OFFSETS.TICK] = recordedTick;
    }

    return {
      phase: 'intervening',
      physicsStepped: true,
      currentTick: recordedTick,
      countdownRemainingSeconds: 0,
      postTakeoverFrameOffset: this.postTakeoverFrameOffset,
    };
  }

  public setNonPovMode(mode: RLRCNonPovInterventionMode): void {
    this.nonPovMode = mode;
    if (this.lastLaunchConfig) {
      this.lastLaunchConfig = { ...this.lastLaunchConfig, nonPovMode: mode };
    }
    if (this.phase === 'intervening' || this.phase === 'preroll-countdown') {
      const sim = this.env.getPhysics();
      const arena = this.env.getArena?.();
      if (mode === 'disappear' && sim) {
        for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
          if (slot !== this.povSlotIndex) {
            deactivateInterveneSlotEntity(sim, arena, this.slotActiveTracker, slot);
          }
        }
      } else if (mode === 'bot-takeover') {
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

  private resolveValidPovSlotIndex(
    frame: RLRCFrame120Hz,
    roster: readonly RLRCPlayerSlotMeta[],
    preferredSlot: number
  ): number {
    const clamped = Math.max(0, Math.min(RLRC_MAX_PLAYER_SLOTS - 1, Math.round(preferredSlot)));
    if (frame.cars[clamped]?.entityActive) return clamped;
    for (let i = 0; i < frame.cars.length; i++) {
      if (frame.cars[i]?.entityActive) return i;
    }
    return roster[0]?.slotIndex ?? clamped;
  }

  private collectLiveAcknowledgedControls(): ReplayAcknowledgedControlEntry[] {
    const entries: ReplayAcknowledgedControlEntry[] = [];
    for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
      const ctrl = this.latestControlSnapshot.get(slot) ?? DEFAULT_NEUTRAL_CAR_CONTROLS;
      entries.push({ carIndex: slot, controls: { ...ctrl } });
    }
    return entries;
  }
}
