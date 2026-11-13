/**
 * src/network/server/activities/SandboxActivityKernel.ts
 * Developer Sandbox activity kernel supporting custom state broadcast,
 * physics mutators, and experimental mode switching without disconnecting peers.
 */

import {
  ACTIVITY_MODE_FLAGS,
  type RoomActivitySwitchPayload,
} from '../../protocol/RoomActivityProtocol.ts';
import type { ActivityKernelContext, ActivityKernelPort } from './ActivityKernelPort.ts';

export class SandboxActivityKernel implements ActivityKernelPort {
  readonly activityId = 'sandbox' as const;
  readonly modeFlags =
    ACTIVITY_MODE_FLAGS.SKIP_SCORE_CLOCK |
    ACTIVITY_MODE_FLAGS.TRAINING_RULESET |
    ACTIVITY_MODE_FLAGS.CSR_FOLLOW_HOST;

  private customPayload: Record<string, unknown> = {};

  onEnter(ctx: ActivityKernelContext, payload: RoomActivitySwitchPayload): void {
    this.customPayload = { ...(payload.customPayload ?? {}) };
    const { matchManager, physicsManager } = ctx;
    if (matchManager) {
      matchManager.systemControl.resumePhysicsFromState(null);
      matchManager.lifecycle.startTrainingMode({
        unlimitedBoost: payload.unlimitedBoost ?? true,
        disableGoalReset: payload.disableGoalReset ?? true,
        goalReplayEnabled: false,
      });
    }
    physicsManager?.sim?.setUnlimitedBoost?.(payload.unlimitedBoost ?? true);
    if (payload.ghostCars) {
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

  updateSandboxState(patch: Record<string, unknown>): void {
    this.customPayload = { ...this.customPayload, ...patch };
  }

  getCustomSummary(): Record<string, unknown> {
    return { ...this.customPayload };
  }
}
