import { HOST_WORKER_MSG_TYPES as MSG } from '../protocol/HostWorkerProtocol.ts';
import type {
  CsrFollowHostPayload,
  InterveneAuthorizationRequest,
  RoomActivitySwitchPayload,
  SpectatorTimelineCommand,
} from '../protocol/RoomActivityProtocol.ts';
import { RoomActivityOrchestrator as ActivitiesRoomActivityOrchestrator } from './activities/RoomActivityOrchestrator.ts';
import { REPLICATION_MODES } from '../protocol/ReplicationBusProtocol.ts';
import { RoomActivityOrchestrator } from './RoomActivityOrchestrator.ts';
import type { MatchSessionAdmin } from './match/MatchSessionAdmin.ts';
import type { PhysicsEngineManager } from './PhysicsEngineManager.ts';
import type { WorkerReplyFn, WorkerRouterContext } from './workerReplayAndDiagnosticsRouter.ts';

export function routeRoomActivityAndReplicationMessage(
  workerCtx: WorkerRouterContext,
  type: string,
  p: Record<string, any>,
  reply: WorkerReplyFn,
  syncRoomState: () => void
): boolean {
  const { matchManager, physicsManager } = workerCtx as {
    matchManager?: MatchSessionAdmin | null;
    physicsManager?: PhysicsEngineManager | null;
  };

  switch (type) {
    case MSG.ROOM_ACTIVITY_SWITCH: {
      const activityOrchestrator =
        workerCtx.activityOrchestrator ?? new ActivitiesRoomActivityOrchestrator();
      workerCtx.activityOrchestrator = activityOrchestrator;
      const orch = workerCtx.orchestrator ?? new RoomActivityOrchestrator();
      workerCtx.orchestrator = orch;
      if (
        p.replicationMode !== undefined ||
        p.followHostEnabled !== undefined ||
        p.authorityMask !== undefined
      ) {
        const switched = orch.switchActivity(
          {
            activityId: typeof p.activityId === 'string' ? p.activityId : 'freeplay',
            seed: typeof p.seed === 'number' ? p.seed : undefined,
            replicationMode:
              p.replicationMode === REPLICATION_MODES.SPARSE
                ? REPLICATION_MODES.SPARSE
                : p.replicationMode === REPLICATION_MODES.CONTINUOUS
                  ? REPLICATION_MODES.CONTINUOUS
                  : undefined,
            authorityMask:
              p.authorityMask && typeof p.authorityMask === 'object'
                ? (p.authorityMask as Record<string, string>)
                : undefined,
            stateSummary:
              p.stateSummary && typeof p.stateSummary === 'object'
                ? (p.stateSummary as Record<string, unknown>)
                : null,
            followHostEnabled: Boolean(p.followHostEnabled),
          },
          {
            matchManager: matchManager ?? null,
            physicsManager: physicsManager ?? null,
            epoch: orch.getEpoch(),
          }
        );
        reply(MSG.ROOM_ACTIVITY_SWITCH, switched);
        syncRoomState();
      } else {
        const switchPayload = p as unknown as RoomActivitySwitchPayload;
        if (switchPayload.activityId) {
          const summary = activityOrchestrator.switchActivity(
            { matchManager, physicsManager, syncRoomState },
            switchPayload
          );
          reply(MSG.ROOM_ACTIVITY_SWITCH, summary);
        }
      }
      return true;
    }

    case MSG.SPECTATOR_TIMELINE_CMD: {
      const activityOrchestrator =
        workerCtx.activityOrchestrator ?? new ActivitiesRoomActivityOrchestrator();
      workerCtx.activityOrchestrator = activityOrchestrator;
      const cmd = p as unknown as SpectatorTimelineCommand;
      if (cmd.action) {
        const summary = activityOrchestrator.handleSpectatorTimelineCommand(
          { matchManager, physicsManager, syncRoomState },
          cmd
        );
        reply(MSG.SPECTATOR_TIMELINE_CMD, summary);
      }
      return true;
    }

    case MSG.INTERVENE_HANDOFF_CMD: {
      const activityOrchestrator =
        workerCtx.activityOrchestrator ?? new ActivitiesRoomActivityOrchestrator();
      workerCtx.activityOrchestrator = activityOrchestrator;
      const req = p as unknown as InterveneAuthorizationRequest;
      if (req.action) {
        const summary = activityOrchestrator.handleInterveneHandoffRequest(
          { matchManager, physicsManager, syncRoomState },
          req
        );
        reply(MSG.INTERVENE_HANDOFF_CMD, summary);
      }
      return true;
    }

    case MSG.CSR_FOLLOW_HOST_SYNC: {
      const activityOrchestrator =
        workerCtx.activityOrchestrator ?? new ActivitiesRoomActivityOrchestrator();
      workerCtx.activityOrchestrator = activityOrchestrator;
      const csrPatch = p as unknown as Partial<CsrFollowHostPayload>;
      const csrState = activityOrchestrator.updateCsrFollowHostState(csrPatch, {
        matchManager,
        physicsManager,
        syncRoomState,
      });
      reply(MSG.CSR_FOLLOW_HOST_SYNC, csrState);
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
        { matchManager: matchManager ?? null, physicsManager: physicsManager ?? null, epoch: orch.getEpoch() },
        Boolean(p.followHostEnabled),
        typeof p.cameraMode === 'string' ? p.cameraMode : undefined
      );
      reply(MSG.ROOM_CSR_STATE_BROADCAST, csr);
      return true;
    }

    default:
      return false;
  }
}
