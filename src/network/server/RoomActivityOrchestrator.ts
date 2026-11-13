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
import {
  DEFAULT_PAUSE_HEARTBEAT_HZ,
  clampPauseHeartbeatHz,
  getPauseHeartbeatIntervalMs,
  type FloatingWindowSyncEntry,
  type GlobalWorkspaceBroadcastPayload,
  type TelestratorDrawPermission,
} from '../protocol/GlobalWorkspaceProtocol.ts';
import { SyncAuthorityRouter } from '../sync/SyncAuthorityRouter.ts';
import { ReplicationStateInterpolator } from '../sync/ReplicationStateInterpolator.ts';
import {
  createDefaultActivityKernelRegistry,
  type ActivityKernelContext,
  type RoomActivityKernel,
} from './activities/ActivityKernel.ts';

export class RoomActivityOrchestrator {
  private readonly kernels: Map<ActivityId, RoomActivityKernel>;
  private activeKernel: RoomActivityKernel;
  private epoch = 0;
  private replicationMode: ReplicationMode = REPLICATION_MODES.CONTINUOUS;
  private activePacketFlags: number;
  private readonly pausedAckSessions = new Set<string>();
  private telestratorPermission: TelestratorDrawPermission = 'host_only';
  private pauseHeartbeatHz = DEFAULT_PAUSE_HEARTBEAT_HZ;
  readonly authorityRouter = new SyncAuthorityRouter();
  readonly interpolator = new ReplicationStateInterpolator();

  constructor(initialActivityId: ActivityId = ACTIVITY_IDS.FREEPLAY) {
    this.kernels = createDefaultActivityKernelRegistry();
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

  hasAllPeersPausedAck(expectedPeerCount: number): boolean {
    if (expectedPeerCount <= 0) return true;
    return this.pausedAckSessions.size >= expectedPeerCount;
  }

  setTelestratorPermission(permission: TelestratorDrawPermission): void {
    this.telestratorPermission = permission === 'everyone' ? 'everyone' : 'host_only';
  }

  getTelestratorPermission(): TelestratorDrawPermission {
    return this.telestratorPermission;
  }

  setPauseHeartbeatHz(hz: number): void {
    this.pauseHeartbeatHz = clampPauseHeartbeatHz(hz);
  }

  getPauseHeartbeatIntervalMs(): number {
    return getPauseHeartbeatIntervalMs(this.pauseHeartbeatHz);
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

  buildCsrBroadcast(
    ctx: ActivityKernelContext,
    followHostEnabled: boolean,
    cameraMode?: string
  ): CsrStateBroadcastPayload {
    this.authorityRouter.setFollowHostEnabled(followHostEnabled);
    const payload: CsrStateBroadcastPayload = {
      epoch: this.epoch,
      activityId: this.activeKernel.id,
      tick: ctx.matchManager?.domain.matchTick ?? 0,
      followHostEnabled,
      cameraMode,
      uiSummary: this.activeKernel.getStateSummary(ctx),
    };
    this.authorityRouter.applyCsrBroadcast(payload);
    return payload;
  }

  buildGlobalWorkspaceBroadcast(params: {
    tick: number;
    menuRoute: string | null;
    openFloatingWindows: FloatingWindowSyncEntry[];
    playbackPaused: boolean;
    pausedAtTick?: number;
  }): GlobalWorkspaceBroadcastPayload {
    return {
      epoch: this.epoch,
      tick: params.tick,
      menuRoute: params.menuRoute,
      openFloatingWindows: params.openFloatingWindows.map((w) => ({
        id: w.id,
        isOpen: Boolean(w.isOpen),
        isMinimized: Boolean(w.isMinimized),
      })),
      telestratorPermission: this.telestratorPermission,
      playbackPaused: Boolean(params.playbackPaused),
      pausedAtTick: params.pausedAtTick ?? params.tick,
      pauseHeartbeatHz: this.pauseHeartbeatHz,
    };
  }
}
