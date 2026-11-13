/**
 * src/network/server/activities/ReplayInterveneActivityKernel.ts
 * Replay & Intervene activity kernel: coordinates SpectatorRoomTimelineController
 * (host-authoritative seek/pause/playRate + sparse frozen-frame mode) and
 * InterveneHandoffCoordinator (4-3-2-1-0 role-authorized takeover).
 */

import {
  ACTIVITY_MODE_FLAGS,
  type InterveneAuthorizationRequest,
  type RoomActivitySwitchPayload,
  type SpectatorTimelineCommand,
} from '../../protocol/RoomActivityProtocol.ts';
import type { ActivityKernelContext, ActivityKernelPort } from './ActivityKernelPort.ts';
import { SpectatorRoomTimelineController } from '../spectator/SpectatorRoomTimelineController.ts';
import { InterveneHandoffCoordinator } from '../spectator/InterveneHandoffCoordinator.ts';

export class ReplayInterveneActivityKernel implements ActivityKernelPort {
  readonly activityId = 'replay_intervene' as const;
  readonly timeline = new SpectatorRoomTimelineController();
  readonly handoff = new InterveneHandoffCoordinator();

  get modeFlags(): number {
    const base = ACTIVITY_MODE_FLAGS.SKIP_SCORE_CLOCK;
    return this.timeline.isSparseFrozenMode()
      ? base | ACTIVITY_MODE_FLAGS.SPARSE_FREEZE_MODE
      : base;
  }

  onEnter(ctx: ActivityKernelContext, payload: RoomActivitySwitchPayload): void {
    this.timeline.reset();
    this.handoff.reset(ctx.physicsManager);
    const totalTicks =
      typeof payload.customPayload?.totalTicks === 'number' ? payload.customPayload.totalTicks : 0;
    const cursorTick =
      typeof payload.customPayload?.cursorTick === 'number' ? payload.customPayload.cursorTick : 0;
    this.timeline.applyHostTimelineCommand(
      { action: 'seek', cursorTick, totalTicks },
      ctx.matchManager?.systemControl
    );
  }

  onExit(ctx: ActivityKernelContext): void {
    this.handoff.reset(ctx.physicsManager);
    this.timeline.reset();
    ctx.matchManager?.systemControl.resumePhysicsFromState(null);
  }

  onStepTick(ctx: ActivityKernelContext): void {
    const handoffState = this.handoff.getState();
    if (handoffState.phase === 'countdown') {
      this.handoff.stepCountdownTick(ctx.matchManager?.systemControl, ctx.physicsManager);
      return;
    }
    if (handoffState.phase === 'idle' || handoffState.phase === 'authorized') {
      this.timeline.stepPlaybackTick(ctx.matchManager?.systemControl);
    }
  }

  handleTimelineCommand(ctx: ActivityKernelContext, cmd: SpectatorTimelineCommand): void {
    this.timeline.applyHostTimelineCommand(cmd, ctx.matchManager?.systemControl);
  }

  handleInterveneRequest(ctx: ActivityKernelContext, req: InterveneAuthorizationRequest): void {
    this.handoff.handleRequest(req, ctx.matchManager?.systemControl, ctx.physicsManager);
  }

  getCustomSummary(): Record<string, unknown> {
    return {
      timeline: this.timeline.getState(),
      handoff: this.handoff.getState(),
    };
  }
}
