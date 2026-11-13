/**
 * src/network/server/activities/FreeplayActivityKernel.ts
 * Decoupled multiplayer Freeplay activity kernel:
 * - No scoring, no match countdown, no goal freeze
 * - Unlimited boost, FIFO rolling replay buffer, and ghost/solid collision hot-toggle
 */

import {
  ACTIVITY_MODE_FLAGS,
  type RoomActivitySwitchPayload,
} from '../../protocol/RoomActivityProtocol.ts';
import type { ActivityKernelContext, ActivityKernelPort } from './ActivityKernelPort.ts';

export class FreeplayActivityKernel implements ActivityKernelPort {
  readonly activityId = 'freeplay' as const;
  readonly modeFlags = ACTIVITY_MODE_FLAGS.SKIP_SCORE_CLOCK | ACTIVITY_MODE_FLAGS.TRAINING_RULESET;

  private unlimitedBoost = true;
  private disableGoalReset = true;
  private ghostCars = false;

  onEnter(ctx: ActivityKernelContext, payload: RoomActivitySwitchPayload): void {
    this.unlimitedBoost = payload.unlimitedBoost ?? true;
    this.disableGoalReset = payload.disableGoalReset ?? true;
    this.ghostCars = payload.ghostCars ?? false;

    const { matchManager, physicsManager } = ctx;
    if (matchManager) {
      matchManager.systemControl.resumePhysicsFromState(null);
      matchManager.lifecycle.startTrainingMode({
        unlimitedBoost: this.unlimitedBoost,
        disableGoalReset: this.disableGoalReset,
        goalReplayEnabled: false,
      });
    }
    physicsManager?.sim?.setUnlimitedBoost?.(this.unlimitedBoost);
    if (this.ghostCars) {
      physicsManager?.setLobbyGhostMode?.(true);
    } else {
      physicsManager?.setLobbyGhostMode?.(false);
      physicsManager?.restoreSolidCollisions?.();
    }
  }

  onExit(ctx: ActivityKernelContext): void {
    ctx.physicsManager?.setLobbyGhostMode?.(false);
    ctx.physicsManager?.restoreSolidCollisions?.();
  }

  onStepTick(_ctx: ActivityKernelContext): void {}

  setGhostCollisions(ctx: ActivityKernelContext, enabled: boolean): void {
    this.ghostCars = enabled;
    if (enabled) {
      ctx.physicsManager?.setLobbyGhostMode?.(true);
    } else {
      ctx.physicsManager?.setLobbyGhostMode?.(false);
      ctx.physicsManager?.restoreSolidCollisions?.();
    }
  }

  resetBall(ctx: ActivityKernelContext): void {
    ctx.physicsManager?.sim?.setBallState?.({
      pos: [0, 0, 93.15],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
    });
  }

  getCustomSummary(): Record<string, unknown> {
    return {
      unlimitedBoost: this.unlimitedBoost,
      disableGoalReset: this.disableGoalReset,
      ghostCars: this.ghostCars,
    };
  }
}
