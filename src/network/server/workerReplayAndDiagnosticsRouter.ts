import { HOST_WORKER_MSG_TYPES } from '../protocol/HostWorkerProtocol.ts';
import { MATCH_STATES } from './match/matchLoadoutAndSpawnPipeline.ts';
import {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET,
  ZERO_G_ANCHOR_MODES,
  configureZeroGVehiclePhysics,
  releaseZeroGVehiclePhysics,
} from '../diagnostics/DiagnosticsTestVehicles.ts';
import type { WorkerEnvelope } from '../protocol/HostWorkerProtocol.ts';
import type { MatchSessionAdmin } from './match/MatchSessionAdmin.ts';
import type { PhysicsEngineManager } from './PhysicsEngineManager.ts';
import type { EstablishedSessionManager } from './EstablishedSessionManager.ts';
import type { NetworkDataHandler } from './NetworkDataHandler.ts';

export interface WorkerRouterContext {
  sim?: any;
  physicsManager?: PhysicsEngineManager | null;
  sessionManager?: EstablishedSessionManager | null;
  matchManager?: MatchSessionAdmin | null;
  dataHandler?: NetworkDataHandler | null;
  diagnosticsController?: any;
  registerWorkerChannel?: ((channelId: string) => void) | null;
  unregisterWorkerChannel?: ((channelId: string) => void) | null;
  postEnvelope?: ((envelope: WorkerEnvelope, transfer?: Transferable[]) => void) | null;
  emit?: ((msg: any, transfer?: Transferable[]) => void) | null;
}

export type WorkerReplyFn = (
  replyType: string,
  replyPayload: any,
  transfer?: Transferable[]
) => void;

export function releaseDiagnosticFleetIfEnabled(
  workerCtx: WorkerRouterContext,
  matchManager: MatchSessionAdmin | null | undefined,
  physicsManager: PhysicsEngineManager | null | undefined
): void {
  const diagCtrl = workerCtx.diagnosticsController || matchManager?.diagnosticsController;
  if (diagCtrl?.enabled && physicsManager) {
    diagCtrl.enabled = false;
    diagCtrl.releasePhysics(physicsManager);
  }
}

export function handleFullReplayExport(
  sim: any,
  matchManager: MatchSessionAdmin | null | undefined,
  reqId: number,
  reply: WorkerReplyFn
): void {
  const snap = matchManager?.getSnapshot();
  const roster = snap?.roster ?? {
    players: [],
    spectators: [],
    gameMode: '3v3',
    botFillMode: 'no_bots',
    durationSeconds: 300,
    clockSeconds: 300,
    score: { blue: 0, orange: 0 },
  };
  const loadouts = matchManager
    ? matchManager.roster.getMatchRosterMetadata()
    : roster.players || [];
  const meta = {
    blueScore: snap?.blueScore ?? 0,
    orangeScore: snap?.orangeScore ?? 0,
    winner: snap?.winner ?? 0,
    winReason: snap?.winReason ?? 0,
    gameMode: snap?.gameMode || '3v3',
    durationSeconds: snap?.clockDuration ?? 300,
    roster,
    loadouts,
  };
  if (
    sim &&
    typeof sim.extractWasmReplayTracks === 'function' &&
    (sim.getReplayFrameCount?.() ?? 0) > 0
  ) {
    const tracks = sim.extractWasmReplayTracks();
    const transfer: Transferable[] = [];
    if (tracks.stateInputBytes?.buffer) transfer.push(tracks.stateInputBytes.buffer);
    if (tracks.incidentBytes?.buffer) transfer.push(tracks.incidentBytes.buffer);
    if (tracks.signalBytes?.buffer) transfer.push(tracks.signalBytes.buffer);
    reply(
      HOST_WORKER_MSG_TYPES.REPLAY_FULL_EXPORT_DATA,
      {
        reqId,
        frameCount: tracks.frameCount,
        stateStride: tracks.stateStride,
        incidentCount: tracks.incidentCount,
        signalCount: tracks.signalCount,
        stateInputBytes: tracks.stateInputBytes,
        incidentBytes: tracks.incidentBytes,
        signalBytes: tracks.signalBytes,
        ...meta,
      },
      transfer
    );
    return;
  }

  const frames = matchManager?.replayBuffer ? matchManager.replayBuffer.getRecentFrames() : [];
  reply(HOST_WORKER_MSG_TYPES.REPLAY_FULL_EXPORT_DATA, {
    reqId,
    frameCount: frames.length,
    frames,
    signals: matchManager ? matchManager.commandQueue.replaySignalLog.slice() : [],
    ...meta,
  });
}

/**
 * Narrow-waist router for replay export/window requests and network/zero-G diagnostics.
 */
export function routeReplayAndDiagnosticsMessage(
  workerCtx: WorkerRouterContext,
  type: string,
  payload: Record<string, any>,
  seq: number,
  reply: WorkerReplyFn
): boolean {
  const { sim, physicsManager, matchManager } = workerCtx;

  switch (type) {
    case HOST_WORKER_MSG_TYPES.NET_DIAG_CONFIG:
    case 'configureDiagnosticFleet': {
      const isLobby = !matchManager || matchManager.lifecycle.state === MATCH_STATES.LOBBY;
      const enableZeroG = Boolean(payload.enabled) && isLobby;
      const fleet = Array.isArray(payload.fleet) ? payload.fleet : DEFAULT_DIAGNOSTIC_FLEET;
      const anchorMode = payload.anchorMode || ZERO_G_ANCHOR_MODES.Z_HOVER;
      let diagCtrl =
        workerCtx.diagnosticsController || matchManager?.diagnosticsController || null;
      if (!diagCtrl && workerCtx) {
        diagCtrl = new DiagnosticsTestVehicleController(fleet, { anchorMode });
        workerCtx.diagnosticsController = diagCtrl;
      }
      if (diagCtrl) {
        diagCtrl.anchorMode = anchorMode;
        diagCtrl.enabled = enableZeroG;
        if (physicsManager) {
          if (enableZeroG) diagCtrl.configurePhysics(physicsManager, anchorMode);
          else diagCtrl.releasePhysics(physicsManager);
        }
      } else if (physicsManager && sim) {
        if (enableZeroG) configureZeroGVehiclePhysics(physicsManager, fleet, anchorMode);
        else releaseZeroGVehiclePhysics(physicsManager, fleet);
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.NET_IMPAIRMENT_SET: {
      reply(HOST_WORKER_MSG_TYPES.NET_DIAG_METRICS, {
        extraLatencyMs: payload.extraLatencyMs ?? 0,
        jitterMs: payload.jitterMs ?? 0,
        packetLossRate: payload.packetLossRate ?? 0,
      });
      return true;
    }

    case HOST_WORKER_MSG_TYPES.REPLAY_WINDOW_REQUEST: {
      const count = payload.count ?? 360;
      const frames = matchManager?.replayBuffer
        ? matchManager.replayBuffer.getRecentFrames(count)
        : [];
      reply(HOST_WORKER_MSG_TYPES.REPLAY_WINDOW_DATA, {
        reqId: payload.reqId ?? seq,
        frameCount: frames.length,
        wasmFrameCount: sim?.getReplayFrameCount?.() ?? 0,
        frames,
      });
      return true;
    }

    case HOST_WORKER_MSG_TYPES.REPLAY_FULL_EXPORT_REQUEST: {
      handleFullReplayExport(sim, matchManager, payload.reqId ?? seq, reply);
      return true;
    }

    default:
      return false;
  }
}
