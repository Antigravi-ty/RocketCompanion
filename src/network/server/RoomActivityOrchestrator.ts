/**
 * src/network/server/RoomActivityOrchestrator.ts
 * Host-side dynamic orchestrator for hot-swapping ActivityKernels without
 * disconnecting peers, managing dual-mode replication state, STATE_PAUSED_ACK barriers,
 * and Follow-Host CSR state broadcasts.
 */

import {
  ACTIVITY_IDS,
  REPLICATION_MODES,
  resolvePacketFlagsForActivity,
  type ActivityId,
  type CsrStateBroadcastPayload,
  type ReplicationMode,
  type RoomActivitySwitchPayload,
  type StatePausedAckPayload,
} from '../protocol/ReplicationBusProtocol.ts';
import { SyncAuthorityRouter } from '../sync/SyncAuthorityRouter.ts';
import { ReplicationStateInterpolator } from '../sync/ReplicationStateInterpolator.ts';
import { SpectatorGlobalStateCoordinator } from '../sync/SpectatorGlobalStateCoordinator.ts';
import {
  createDefaultActivityKernelRegistry,
  type ActivityKernelContext,
  type RoomActivityKernel,
} from './activities/ActivityKernel.ts';
import { MultiplayerTrainingActivityKernel } from './activities/MultiplayerTrainingKernel.ts';

export class RoomActivityOrchestrator {
  private readonly kernels: Map<ActivityId, RoomActivityKernel>;
  private activeKernel: RoomActivityKernel;
  private epoch = 0;
  private replicationMode: ReplicationMode = REPLICATION_MODES.CONTINUOUS;
  private activePacketFlags: number;
  private readonly pausedAckSessions = new Set<string>();
  readonly authorityRouter = new SyncAuthorityRouter();
  readonly interpolator = new ReplicationStateInterpolator();
  readonly spectatorCoordinator = new SpectatorGlobalStateCoordinator();

  constructor(initialActivityId: ActivityId = ACTIVITY_IDS.FREEPLAY) {
    this.kernels = createDefaultActivityKernelRegistry();
    this.kernels.set(ACTIVITY_IDS.MULTIPLAYER_TRAINING, new MultiplayerTrainingActivityKernel());
    this.activeKernel =
      this.kernels.get(initialActivityId) ?? this.kernels.get(ACTIVITY_IDS.FREEPLAY)!;
    this.replicationMode = this.activeKernel.defaultReplicationMode;
    this.activePacketFlags = this.activeKernel.defaultPacketFlags;
  }

  registerKernel(kernel: RoomActivityKernel): void {
    this.kernels.set(kernel.id, kernel);
  }

  getActiveActivityId(): ActivityId {
    return this.activeKernel.id;
  }

  getEpoch(): number {
    return this.epoch;
  }

  getReplicationMode(): ReplicationMode {
    return this.replicationMode;
  }

  getActivePacketFlags(): number {
    return this.activePacketFlags;
  }

  getPausedAckCount(): number {
    return this.pausedAckSessions.size;
  }

  switchActivity(
    request: Partial<RoomActivitySwitchPayload>,
    ctx: ActivityKernelContext
  ): RoomActivitySwitchPayload {
    const targetId = request.activityId ?? ACTIVITY_IDS.FREEPLAY;
    const nextKernel = this.kernels.get(targetId) ?? this.kernels.get(ACTIVITY_IDS.SANDBOX)!;

    this.activeKernel.onUnmount({ ...ctx, epoch: this.epoch });

    this.epoch += 1;
    this.pausedAckSessions.clear();
    this.activeKernel = nextKernel;
    this.replicationMode = request.replicationMode ?? nextKernel.defaultReplicationMode;
    const followHost = Boolean(request.followHostEnabled);
    this.activePacketFlags =
      request.packetFlags ??
      resolvePacketFlagsForActivity(targetId, this.replicationMode, followHost);

    this.interpolator.setReplicationMode(this.replicationMode);

    const switchPayload: RoomActivitySwitchPayload = {
      activityId: targetId,
      epoch: this.epoch,
      seed: request.seed,
      replicationMode: this.replicationMode,
      packetFlags: this.activePacketFlags,
      authorityMask: request.authorityMask,
      stateSummary: request.stateSummary ?? null,
      followHostEnabled: followHost,
    };

    this.authorityRouter.applyActivitySwitch(switchPayload);
    this.activeKernel.onMount({
      ...ctx,
      epoch: this.epoch,
      seed: request.seed,
      stateSummary: request.stateSummary ?? null,
    });

    return switchPayload;
  }

  setReplicationMode(mode: ReplicationMode): void {
    this.replicationMode = mode;
    this.activePacketFlags = resolvePacketFlagsForActivity(
      this.activeKernel.id,
      mode,
      this.authorityRouter.isFollowHostEnabled()
    );
    this.interpolator.setReplicationMode(mode);
    if (mode === REPLICATION_MODES.CONTINUOUS) {
      this.pausedAckSessions.clear();
    }
  }

  recordStatePausedAck(ack: StatePausedAckPayload): boolean {
    if (ack.epoch !== this.epoch) {
      return false;
    }
    const key = ack.clientSessionId || 'anonymous';
    this.pausedAckSessions.add(key);
    return true;
  }

  getActiveKernel(): RoomActivityKernel {
    return this.activeKernel;
  }

  handleControlMessage(
    ctx: ActivityKernelContext,
    type: string,
    payload: Record<string, unknown>
  ): boolean {
    if (this.activeKernel.onControlMessage) {
      return this.activeKernel.onControlMessage({ ...ctx, epoch: this.epoch }, type, payload);
    }
    return false;
  }

  buildCsrBroadcast(
    ctx: ActivityKernelContext,
    followHostEnabled: boolean,
    cameraMode?: string,
    extra?: Pick<CsrStateBroadcastPayload, 'spectatorSyncMode' | 'globalUiState'>
  ): CsrStateBroadcastPayload {
    this.authorityRouter.setFollowHostEnabled(followHostEnabled);
    const payload: CsrStateBroadcastPayload = {
      epoch: this.epoch,
      activityId: this.activeKernel.id,
      tick: ctx.matchManager?.domain.matchTick ?? 0,
      followHostEnabled,
      spectatorSyncMode: extra?.spectatorSyncMode,
      cameraMode,
      globalUiState: extra?.globalUiState,
      uiSummary: this.activeKernel.getStateSummary(ctx),
    };
    this.authorityRouter.applyCsrBroadcast(payload);
    return payload;
  }
}
