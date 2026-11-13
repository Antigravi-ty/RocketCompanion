import { BaseGameMode, type GameModeRuntimePort } from '../BaseGameMode.ts';
import type { FrameContext } from '../../pipeline/FramePipeline.ts';
import {
  type DynamicCarTakeoverMode,
  type DynamicTrainingShotRef,
  type DynamicTrainingStateSession,
} from '../../../ui-core/config/dynamicTrainingPackTypes.ts';
import { hydrateRLRCFramesFromDynamicSession } from '../../../replay/DynamicTrainingSliceExtractor.ts';
import {
  RLRC_FIXED_DT,
  type RLRCFrame120Hz,
  type RLRCNonPovInterventionMode,
  type RLRCPlayerSlotMeta,
  type RLRCSynthesizedCarControls,
} from '../../../replay/rlrc/RLRCReplayTypes.ts';
import { createRLRCInterveneEnvPort } from '../../../replay/rlrc/runtime/RLRCInterveneEnvPortBuilder.ts';
import { DEFAULT_NEUTRAL_CAR_CONTROLS } from '../../../replay/rlrc/runtime/RLRCInterveneFrameStateBuilder.ts';
import { RLRCInterveneTakeoverSubController } from '../../../replay/rlrc/runtime/RLRCInterveneTakeoverSubController.ts';
import {
  applyOptionalCarSpawnVariationToFrame,
  evaluateDynamicTrainingOutcome,
  type DynamicTrainingOutcome,
} from './DynamicTrainingJudge.ts';
import { SIM_OFFSETS } from '../../../physics/RocketSimConstants.ts';

export interface DynamicTrainingModeCallbacks {
  onPhaseChange?: (
    phase: 'idle' | 'preroll-countdown' | 'intervening' | 'result',
    countdownSec: number
  ) => void;
  onTimerTick?: (remainingTimeoutSec: number) => void;
  onOutcome?: (shotId: string, outcome: DynamicTrainingOutcome) => void;
}

function mapTakeoverModeToRLRC(mode: DynamicCarTakeoverMode): RLRCNonPovInterventionMode {
  switch (mode) {
    case 'disappear':
      return 'disappear';
    case 'model':
      return 'bot-takeover';
    case 'no-input':
      return 'no-input';
    case 'as-previous':
    case 'player':
    default:
      return 'follow-state';
  }
}

export class DynamicTrainingMode extends BaseGameMode<GameModeRuntimePort> {
  public readonly interveneController: RLRCInterveneTakeoverSubController;
  public activeShot: DynamicTrainingShotRef | null = null;
  public activeSession: DynamicTrainingStateSession | null = null;
  public callbacks: DynamicTrainingModeCallbacks = {};

  private hydratedFrames: RLRCFrame120Hz[] = [];
  private hydratedRoster: RLRCPlayerSlotMeta[] = [];
  private elapsedInterveneSeconds = 0;
  private resultSettled = false;

  constructor(runtime: GameModeRuntimePort | null) {
    super('dynamic-training-pack', runtime);
    this.interveneController = new RLRCInterveneTakeoverSubController(
      createRLRCInterveneEnvPort({
        getSession: () =>
          this.hydratedFrames.length > 0
            ? ({
                frames120Hz: this.hydratedFrames,
                roster: this.hydratedRoster,
                bookmarks: [],
              } as never)
            : null,
        getRuntime: () => this.runtime as never,
        getMode: () => null,
      })
    );
  }

  public setCallbacks(callbacks: DynamicTrainingModeCallbacks): void {
    this.callbacks = callbacks;
  }

  public onEnter(): void {
    this.resultSettled = false;
    this.elapsedInterveneSeconds = 0;
  }

  public onLeave(): void {
    this.stopShot();
  }

  public startShot(shot: DynamicTrainingShotRef, session: DynamicTrainingStateSession): boolean {
    const hydrated = hydrateRLRCFramesFromDynamicSession(session);
    if (hydrated.frames120Hz.length === 0) return false;

    const anchorIdx = session.interveneLocalFrameIndex ?? hydrated.frames120Hz.length - 1;
    const baseTargetIdx = Math.max(
      0,
      Math.min(hydrated.frames120Hz.length - 1, anchorIdx + shot.interveneOffsetFrames)
    );
    const targetFrame = hydrated.frames120Hz[baseTargetIdx];
    if (targetFrame && shot.optionalCarSpawnVariation?.enabled) {
      hydrated.frames120Hz[baseTargetIdx] = applyOptionalCarSpawnVariationToFrame({
        frame: targetFrame,
        povSlotIndex: shot.povSlotIndex,
        variation: shot.optionalCarSpawnVariation,
      });
    }

    this.activeShot = shot;
    this.activeSession = session;
    this.hydratedFrames = hydrated.frames120Hz;
    this.hydratedRoster = hydrated.roster;
    this.elapsedInterveneSeconds = 0;
    this.resultSettled = false;

    const r = this.runtime as unknown as {
      playerCarIndex?: number;
      arena?: { playerCarIndex?: number } | null;
    } | null;
    if (r) {
      r.playerCarIndex = shot.povSlotIndex;
      if (r.arena) r.arena.playerCarIndex = shot.povSlotIndex;
    }

    const perSlotModes: Record<number, RLRCNonPovInterventionMode> = {};
    const perSlotModelIds: Record<number, string> = {};
    for (const [slotStr, rule] of Object.entries(shot.perCarTakeover)) {
      const slot = Number(slotStr);
      if (!Number.isFinite(slot)) continue;
      perSlotModes[slot] = mapTakeoverModeToRLRC(rule.mode);
      if (rule.mode === 'model' && rule.modelId) {
        perSlotModelIds[slot] = rule.modelId;
      }
    }

    const cfg = this.interveneController.enterInterveneAtFrame(baseTargetIdx, {
      povSlotIndex: shot.povSlotIndex,
      downCounterSeconds: shot.downCounterSeconds,
      nonPovMode: 'follow-state',
      perSlotModes,
      perSlotModelIds,
    });

    if (!cfg) return false;
    this.callbacks.onPhaseChange?.(
      shot.downCounterSeconds > 0 ? 'preroll-countdown' : 'intervening',
      shot.downCounterSeconds
    );
    this.callbacks.onTimerTick?.(shot.timeoutSeconds);
    return true;
  }

  public restartCurrentShot(): boolean {
    if (!this.activeShot || !this.activeSession) return false;
    return this.startShot(this.activeShot, this.activeSession);
  }

  public stopShot(): void {
    if (this.interveneController.phase !== 'viewing' && this.interveneController.phase !== 'idle') {
      this.interveneController.exitInterveneToViewing();
    }
    this.activeShot = null;
    this.activeSession = null;
    this.hydratedFrames = [];
    this.hydratedRoster = [];
    this.elapsedInterveneSeconds = 0;
    this.resultSettled = false;
    this.callbacks.onPhaseChange?.('idle', 0);
  }

  public onResetKickoff(): void {
    void this.restartCurrentShot();
  }

  public override onBeforePhysicsTick(): boolean {
    if (!this.activeShot || this.resultSettled) return false;

    const prevPhase = this.interveneController.phase;
    const prevCountdownSec = this.interveneController.countdownRemainingSeconds;
    const playerControls = this.readPlayerControls();
    const shouldStepPhysics = this.interveneController.stepBeforePhysicsTick(
      playerControls,
      RLRC_FIXED_DT
    );
    const nextPhase = this.interveneController.phase;
    const nextCountdownSec = this.interveneController.countdownRemainingSeconds;

    if (
      nextPhase !== prevPhase ||
      (nextPhase === 'preroll-countdown' && nextCountdownSec !== prevCountdownSec)
    ) {
      this.callbacks.onPhaseChange?.(
        nextPhase === 'preroll-countdown'
          ? 'preroll-countdown'
          : nextPhase === 'intervening'
            ? 'intervening'
            : 'idle',
        nextCountdownSec
      );
    }

    return shouldStepPhysics;
  }

  public override onAfterPhysicsTick(): void {
    if (!this.activeShot || this.resultSettled) return;
    if (this.interveneController.phase !== 'intervening') return;

    this.interveneController.stepAfterPhysicsTick(true);
    this.elapsedInterveneSeconds += RLRC_FIXED_DT;
    const sim = this.runtime?.physics;
    const ballView = sim?.getBallStateView?.();
    const goalState = sim?.state ? Number(sim.state[SIM_OFFSETS.GOAL] ?? 0) : 0;
    const ballY = ballView?.posY ?? (sim?.state ? Number(sim.state[SIM_OFFSETS.BALL + 1] ?? 0) : 0);

    const judge = evaluateDynamicTrainingOutcome({
      elapsedInterveneSeconds: this.elapsedInterveneSeconds,
      timeoutSeconds: this.activeShot.timeoutSeconds,
      goalState,
      ballY,
    });

    this.callbacks.onTimerTick?.(judge.remainingSeconds);
    if (judge.completed && judge.outcome) {
      this.resultSettled = true;
      this.callbacks.onOutcome?.(this.activeShot.id, judge.outcome);
      this.callbacks.onPhaseChange?.('result', 0);
    }
  }

  public update(_context: FrameContext): void {
    // Physics and countdown stepping are driven deterministically at 120Hz via onBeforePhysicsTick/onAfterPhysicsTick.
  }

  private readPlayerControls(): RLRCSynthesizedCarControls {
    const r = this.runtime as unknown as {
      input?: { getPlayerControls?: () => Partial<RLRCSynthesizedCarControls> } | null;
    };
    const raw = r?.input?.getPlayerControls?.();
    if (!raw) return DEFAULT_NEUTRAL_CAR_CONTROLS;
    return {
      throttle: Number(raw.throttle) || 0,
      steer: Number(raw.steer) || 0,
      pitch: Number(raw.pitch) || 0,
      yaw: Number(raw.yaw) || 0,
      roll: Number(raw.roll) || 0,
      jump: Boolean(raw.jump),
      boost: Boolean(raw.boost),
      handbrake: Boolean(raw.handbrake),
    };
  }
}
