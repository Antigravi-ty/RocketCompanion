/**
 * src/network/server/activities/MatchActivityKernel.ts
 * Pure Match activity kernel delegating countdown, kickoff, scoring, overtime,
 * goal replay, and podium lifecycle to MatchSessionAdmin without freeplay flags.
 */

import {
  ACTIVITY_MODE_FLAGS,
  type RoomActivitySwitchPayload,
} from '../../protocol/RoomActivityProtocol.ts';
import type { ActivityKernelContext, ActivityKernelPort } from './ActivityKernelPort.ts';

export class MatchActivityKernel implements ActivityKernelPort {
  readonly activityId = 'match' as const;
  readonly modeFlags = ACTIVITY_MODE_FLAGS.SKIP_TELESTRATOR;

  private durationSeconds = 300;

  onEnter(ctx: ActivityKernelContext, payload: RoomActivitySwitchPayload): void {
    this.durationSeconds = payload.durationSeconds ?? 300;
    const { matchManager, physicsManager } = ctx;
    physicsManager?.setLobbyGhostMode?.(false);
    physicsManager?.restoreSolidCollisions?.();
    physicsManager?.sim?.setUnlimitedBoost?.(false);
    if (matchManager) {
      matchManager.systemControl.resumePhysicsFromState(null);
      matchManager.lifecycle.startMatch(this.durationSeconds);
    }
  }

  onExit(_ctx: ActivityKernelContext): void {}

  onStepTick(_ctx: ActivityKernelContext): void {}

  getCustomSummary(): Record<string, unknown> {
    return {
      durationSeconds: this.durationSeconds,
    };
  }
}
