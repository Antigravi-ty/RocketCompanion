import { HOST_WORKER_MSG_TYPES as MSG } from '../protocol/HostWorkerProtocol.ts';
import { REPLICATION_MODES } from '../protocol/ReplicationBusProtocol.ts';
import { RoomActivityOrchestrator } from './RoomActivityOrchestrator.ts';
import type { WorkerRouterContext } from './workerReplayAndDiagnosticsRouter.ts';
import type {
  WorkerBusActivityMode,
  WorkerBusPlaybackState,
} from './StateFrameSlidingWindow.ts';
import type { VNextRosterManifestInput } from '../protocol/VNextRosterManifestCodec.ts';

export interface ActivityAndInputPayload {
  activityId?: string;
  seed?: number;
  replicationMode?: string;
  authorityMask?: Record<string, string>;
  stateSummary?: Record<string, unknown> | null;
  followHostEnabled?: boolean;
  clientInputEnabled?: boolean;
  epoch?: number;
  pausedAtTick?: number;
  channelId?: string;
  sessionId?: string;
  cameraMode?: string;
  controlType?: string;
  controlPayload?: Record<string, unknown>;
  activityMode?: WorkerBusActivityMode;
  broadcastHz?: number;
  metadataHash?: number;
  manifest?: VNextRosterManifestInput;
  playbackState?: WorkerBusPlaybackState;
  playbackSpeed?: number;
  totalFrames?: number;
  replayFps?: number;
  seekFrameIndex?: number;
  ackedTxSeq?: number;
}

export function routeActivityAndInputMessage(
  workerCtx: WorkerRouterContext,
  type: string,
  p: ActivityAndInputPayload,
  reply: (replyType: string, replyPayload: unknown, transfer?: Transferable[]) => void,
  syncRoomState: () => void
): boolean {
  const { matchManager, physicsManager, dataHandler } = workerCtx;

  switch (type) {
    case MSG.ROOM_ACTIVITY_SWITCH: {
      const orch = workerCtx.orchestrator ?? new RoomActivityOrchestrator();
      workerCtx.orchestrator = orch;
      const targetActivity = typeof p.activityId === 'string' ? p.activityId : 'freeplay';
      const switched = orch.switchActivity(
        {
          activityId: targetActivity,
          seed: typeof p.seed === 'number' ? p.seed : undefined,
          replicationMode:
            p.replicationMode === REPLICATION_MODES.SPARSE
              ? REPLICATION_MODES.SPARSE
              : p.replicationMode === REPLICATION_MODES.CONTINUOUS
                ? REPLICATION_MODES.CONTINUOUS
                : undefined,
          authorityMask:
            p.authorityMask && typeof p.authorityMask === 'object' ? p.authorityMask : undefined,
          stateSummary:
            p.stateSummary && typeof p.stateSummary === 'object' ? p.stateSummary : null,
          followHostEnabled: Boolean(p.followHostEnabled),
        },
        {
          matchManager,
          physicsManager,
          epoch: orch.getEpoch(),
        }
      );
      reply(MSG.ROOM_ACTIVITY_SWITCH, switched);
      if (typeof p.clientInputEnabled === 'boolean') {
        dataHandler?.setClientInputEnabled?.(p.clientInputEnabled);
      } else if (targetActivity === 'match') {
        const summaryInput = p.stateSummary?.clientInputEnabled;
        dataHandler?.setClientInputEnabled?.(summaryInput !== false);
      }
      syncRoomState();
      return true;
    }

    case MSG.ACTIVITY_CONTROL: {
      const orch = workerCtx.orchestrator ?? new RoomActivityOrchestrator();
      workerCtx.orchestrator = orch;
      const controlType = typeof p.controlType === 'string' ? p.controlType : '';
      const controlPayload =
        p.controlPayload && typeof p.controlPayload === 'object' ? p.controlPayload : {};
      const handled = controlType
        ? orch.handleControlMessage(controlType, controlPayload, {
            matchManager,
            physicsManager,
            epoch: orch.getEpoch(),
          })
        : false;
      reply(MSG.ACTIVITY_CONTROL, {
        handled,
        controlType,
        activityId: orch.getActiveActivityId(),
        csr: orch.buildCsrBroadcast(
          { matchManager, physicsManager, epoch: orch.getEpoch() },
          Boolean(p.followHostEnabled)
        ),
      });
      syncRoomState();
      return true;
    }

    case MSG.SET_CLIENT_INPUT_ENABLED: {
      const enabled = Boolean(p.clientInputEnabled);
      dataHandler?.setClientInputEnabled?.(enabled);
      reply(MSG.SET_CLIENT_INPUT_ENABLED, { clientInputEnabled: enabled });
      return true;
    }

    case MSG.REPLICATION_MODE_SET: {
      const orch = workerCtx.orchestrator ?? new RoomActivityOrchestrator();
      workerCtx.orchestrator = orch;
      const mode =
        p.replicationMode === REPLICATION_MODES.SPARSE
          ? REPLICATION_MODES.SPARSE
          : REPLICATION_MODES.CONTINUOUS;
      orch.setReplicationMode(mode);
      reply(MSG.REPLICATION_MODE_SET, {
        replicationMode: mode,
        epoch: orch.getEpoch(),
        packetFlags: orch.getActivePacketFlags(),
      });
      return true;
    }

    case MSG.STATE_PAUSED_ACK: {
      const orch = workerCtx.orchestrator;
      if (orch) {
        const accepted = orch.recordStatePausedAck({
          epoch: typeof p.epoch === 'number' ? p.epoch : orch.getEpoch(),
          pausedAtTick: typeof p.pausedAtTick === 'number' ? p.pausedAtTick : 0,
          clientSessionId: p.channelId || p.sessionId,
        });
        reply(MSG.STATE_PAUSED_ACK, {
          accepted,
          epoch: orch.getEpoch(),
          pausedAckCount: orch.getPausedAckCount(),
        });
      }
      return true;
    }

    case MSG.ROOM_CSR_STATE_BROADCAST: {
      const orch = workerCtx.orchestrator ?? new RoomActivityOrchestrator();
      workerCtx.orchestrator = orch;
      const csr = orch.buildCsrBroadcast(
        { matchManager, physicsManager, epoch: orch.getEpoch() },
        Boolean(p.followHostEnabled),
        typeof p.cameraMode === 'string' ? p.cameraMode : undefined
      );
      reply(MSG.ROOM_CSR_STATE_BROADCAST, csr);
      return true;
    }

    case MSG.WORKER_BUS_CONFIGURE: {
      const bus = workerCtx.authorityBus;
      if (bus) {
        if (p.activityMode) bus.setActivityMode(p.activityMode);
        if (typeof p.broadcastHz === 'number') bus.setBroadcastHz(p.broadcastHz);
        if (typeof p.metadataHash === 'number') bus.setMetadataHash(p.metadataHash);
        reply(MSG.WORKER_BUS_CONFIGURE, {
          activityMode: bus.getActivityMode(),
          broadcastHz: bus.getBroadcastHz(),
          latestTxSeq: bus.slidingWindow.getLatestTxSeq(),
        });
      }
      return true;
    }

    case MSG.WORKER_BUS_REPLAY_CONTROL: {
      const bus = workerCtx.authorityBus;
      if (bus) {
        bus.configureReplayCursor({
          playbackState: p.playbackState,
          playbackSpeed: p.playbackSpeed,
          totalFrames: p.totalFrames,
          replayFps: p.replayFps,
          seekFrameIndex: p.seekFrameIndex,
        });
        reply(MSG.WORKER_BUS_REPLAY_CONTROL, bus.getReplayCursor());
      }
      return true;
    }

    case MSG.WORKER_BUS_TX_SEQ_ACK: {
      const chId = p.channelId || p.sessionId;
      const ackSeq = typeof p.ackedTxSeq === 'number' ? p.ackedTxSeq : 0;
      let recorded = 0;
      if (chId && ackSeq > 0) {
        if (workerCtx.authorityBus) {
          recorded = workerCtx.authorityBus.recordSessionTxSeqAck(chId, ackSeq);
        } else if (workerCtx.sessionManager) {
          recorded = workerCtx.sessionManager.recordClientTxSeqAck(chId, ackSeq);
        }
      }
      reply(MSG.WORKER_BUS_TX_SEQ_ACK, { channelId: chId, ackedTxSeq: recorded });
      return true;
    }

    case 'set_roster_manifest': {
      const bus = workerCtx.authorityBus;
      if (bus && p.manifest) {
        const metadataHash = bus.setRosterManifest(p.manifest);
        bus.broadcastRosterManifestToSessions();
        reply('set_roster_manifest', { metadataHash });
      }
      return true;
    }

    default:
      return false;
  }
}
