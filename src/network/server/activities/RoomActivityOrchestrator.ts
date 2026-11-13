/**
 * src/network/server/activities/RoomActivityOrchestrator.ts
 * Host Room Orchestrator managing hot-swappable ActivityKernels (Freeplay, Match,
 * Replay & Intervene, Sandbox) and CSR Follow-Host broadcast state without
 * disconnecting peer sessions.
 */

import {
  ACTIVITY_MODE_FLAGS,
  type CsrFollowHostPayload,
  type InterveneAuthorizationRequest,
  type RoomActivityId,
  type RoomActivityStateSummary,
  type RoomActivitySwitchPayload,
  type SpectatorTimelineCommand,
} from '../../protocol/RoomActivityProtocol.ts';
import type { ActivityKernelContext, ActivityKernelPort } from './ActivityKernelPort.ts';
import { FreeplayActivityKernel } from './FreeplayActivityKernel.ts';
import { MatchActivityKernel } from './MatchActivityKernel.ts';
import { ReplayInterveneActivityKernel } from './ReplayInterveneActivityKernel.ts';
import { SandboxActivityKernel } from './SandboxActivityKernel.ts';

export class RoomActivityOrchestrator {
  readonly freeplayKernel = new FreeplayActivityKernel();
  readonly matchKernel = new MatchActivityKernel();
  readonly replayInterveneKernel = new ReplayInterveneActivityKernel();
  readonly sandboxKernel = new SandboxActivityKernel();

  private activeKernel: ActivityKernelPort;
  private switchSeq = 0;
  private authorityMask = 0xff;
  private csrFollowHost: CsrFollowHostPayload = {
    enabled: false,
    hostActivityId: 'freeplay',
    hostCameraMode: 'ball',
    hostFocusCarIndex: 0,
    hostTick: 0,
    frameStepMode: false,
  };

  constructor(initialActivity: RoomActivityId = 'freeplay') {
    this.activeKernel = this.resolveKernel(initialActivity);
    this.csrFollowHost.hostActivityId = initialActivity;
  }

  getActiveActivityId(): RoomActivityId {
    return this.activeKernel.activityId;
  }

  getSummary(): RoomActivityStateSummary {
    const csrFlag = this.csrFollowHost.enabled ? ACTIVITY_MODE_FLAGS.CSR_FOLLOW_HOST : 0;
    const sparsePingActive =
      this.activeKernel.activityId === 'replay_intervene' &&
      this.replayInterveneKernel.timeline.isSparseFrozenMode();
    return {
      activityId: this.activeKernel.activityId,
      modeFlags: this.activeKernel.modeFlags | csrFlag,
      switchSeq: this.switchSeq,
      authorityMask: this.authorityMask,
      sparsePingActive,
      customPayload: this.activeKernel.getCustomSummary(),
    };
  }

  getCsrFollowHostState(): CsrFollowHostPayload {
    return { ...this.csrFollowHost };
  }

  switchActivity(
    ctx: ActivityKernelContext,
    payload: RoomActivitySwitchPayload
  ): RoomActivityStateSummary {
    const nextKernel = this.resolveKernel(payload.activityId);
    if (nextKernel !== this.activeKernel) {
      this.activeKernel.onExit(ctx);
      this.activeKernel = nextKernel;
    }
    this.switchSeq += 1;
    if (typeof payload.authorityMask === 'number') {
      this.authorityMask = payload.authorityMask & 0xff;
    }
    this.csrFollowHost = {
      ...this.csrFollowHost,
      hostActivityId: nextKernel.activityId,
    };
    this.activeKernel.onEnter(ctx, payload);
    ctx.syncRoomState();
    return this.getSummary();
  }

  handleSpectatorTimelineCommand(
    ctx: ActivityKernelContext,
    cmd: SpectatorTimelineCommand
  ): RoomActivityStateSummary {
    if (this.activeKernel !== this.replayInterveneKernel) {
      this.switchActivity(ctx, { activityId: 'replay_intervene' });
    }
    this.replayInterveneKernel.handleTimelineCommand(ctx, cmd);
    ctx.syncRoomState();
    return this.getSummary();
  }

  handleInterveneHandoffRequest(
    ctx: ActivityKernelContext,
    req: InterveneAuthorizationRequest
  ): RoomActivityStateSummary {
    if (this.activeKernel !== this.replayInterveneKernel) {
      this.switchActivity(ctx, { activityId: 'replay_intervene' });
    }
    this.replayInterveneKernel.handleInterveneRequest(ctx, req);
    ctx.syncRoomState();
    return this.getSummary();
  }

  updateCsrFollowHostState(
    patch: Partial<CsrFollowHostPayload>,
    ctx?: ActivityKernelContext
  ): CsrFollowHostPayload {
    this.csrFollowHost = {
      ...this.csrFollowHost,
      ...patch,
      hostActivityId: patch.hostActivityId ?? this.activeKernel.activityId,
    };
    ctx?.syncRoomState();
    return this.getCsrFollowHostState();
  }

  stepTick(ctx: ActivityKernelContext): void {
    this.activeKernel.onStepTick(ctx);
    const tick = ctx.physicsManager?.currentTick ?? 0;
    this.csrFollowHost.hostTick = tick;
  }

  private resolveKernel(activityId: RoomActivityId): ActivityKernelPort {
    switch (activityId) {
      case 'match':
        return this.matchKernel;
      case 'replay_intervene':
        return this.replayInterveneKernel;
      case 'sandbox':
        return this.sandboxKernel;
      case 'freeplay':
      default:
        return this.freeplayKernel;
    }
  }
}
