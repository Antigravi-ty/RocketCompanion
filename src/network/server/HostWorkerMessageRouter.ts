import {
  HOST_WORKER_MSG_TYPES,
  createWorkerEnvelope,
  type WorkerEnvelope,
} from '../protocol/HostWorkerProtocol.ts';
import {
  MATCH_STATES,
  type RosterSnapshot,
} from './match/matchLoadoutAndSpawnPipeline.ts';
import {
  releaseDiagnosticFleetIfEnabled,
  routeReplayAndDiagnosticsMessage,
  type WorkerRouterContext,
  type WorkerReplayDiagnosticsPayload,
} from './workerReplayAndDiagnosticsRouter.ts';
import {
  routeTrainingAndPhysicsMessage,
  type WorkerTrainingAndPhysicsPayload,
} from './workerTrainingAndPhysicsRouter.ts';
import type { MatchSessionAdmin } from './match/MatchSessionAdmin.ts';
import type { PhysicsEngineManager } from './PhysicsEngineManager.ts';
import type { EstablishedSessionManager } from './EstablishedSessionManager.ts';
import type { NetworkDataHandler } from './NetworkDataHandler.ts';
import type { AuthoritativePhysicsSimPort } from './authoritativePhysicsStepPipeline.ts';
import type { LobbyGhostConfigOptions } from './LobbyGhostCarCoordinator.ts';
import type { CarControlsInput } from '../protocol/GlobalPayloadCodec.ts';
import type { ClientReliableCommand } from './match/MatchCommandQueueSubController.ts';

export type { WorkerRouterContext };

export interface WorkerRoomStateSummary {
  roomId: string;
  gameMode: string;
  botFillMode: string;
  state: string;
  matchTick: number;
  clockSecondsRemaining: number;
  isOvertime: boolean;
  overtimeSeconds: number;
  blueScore: number;
  orangeScore: number;
  winner: string | number | null;
  winReason: string | number | null;
  lobbyPhysicsActive: boolean;
  ghostConfig: LobbyGhostConfigOptions | null;
  pads: unknown;
  roster: RosterSnapshot;
}

export interface HostWorkerInitOptions {
  roomId?: string;
  gameMode?: string;
  botFillMode?: string;
  externalBotTunnels?: boolean;
  initialState?: Float32Array | number[] | null;
  wasmInitOptions?: { collisionData?: Uint8Array[] | null; isolated?: boolean; [key: string]: unknown };
  hostPlayerName?: string;
  hostVisualId?: string;
  hostHitboxId?: string | null;
  hostColorSlot?: number;
  hostBlueColorSlot?: number | null;
  hostOrangeColorSlot?: number | null;
  hostPaintFinish?: string;
  hostBoostVisual?: string;
  hostBoostAudio?: string;
  isBotMatch?: boolean;
  botPlayerName?: string;
  botVisualId?: string;
  numCars?: number;
  startAsMatch?: boolean;
  lobbyMode?: boolean;
  lobbyOptions?: Record<string, unknown> | null;
  durationSeconds?: number;
  maxOvertimeSeconds?: number;
  skipReplayByDefault?: boolean;
  trainingOptions?: WorkerTrainingAndPhysicsPayload | null;
  resetKickoff?: boolean;
  autoStartLoop?: boolean;
  [key: string]: unknown;
}

export interface WorkerProtocolPayload
  extends WorkerReplayDiagnosticsPayload,
    WorkerTrainingAndPhysicsPayload,
    HostWorkerInitOptions {
  channelId?: string;
  playerName?: string;
  name?: string;
  preferredTeam?: number | null;
  paintFinish?: string;
  boostVisual?: string;
  boostAudio?: string;
  packet?: Uint8Array | ArrayBuffer;
  timestamp?: number;
  targetTick?: number;
  commands?: ClientReliableCommand[];
  command?: ClientReliableCommand;
  commandType?: number;
  acks?: Array<{ signalId: number; signalType?: number }>;
  signalId?: number;
  signalType?: number;
  forceEnterLobby?: boolean;
  ghostCars?: boolean;
  ghostMode?: string;
  hostCarIndex?: number;
  hostInteractsWithBall?: boolean;
  broadcastHostOnly?: boolean;
  ghostOpacity?: number;
  force?: boolean;
  prepareOnly?: boolean;
  entityId?: number;
  controls?: CarControlsInput;
}

export interface WorkerProtocolIncomingMessage extends WorkerProtocolPayload {
  type?: string;
  seq?: number;
  payload?: WorkerProtocolPayload | Uint8Array;
}

export interface HostWorkerMessageRouterOptions extends WorkerRouterContext {
  admin?: MatchSessionAdmin | null;
}

export function buildWorkerRoomStateSummary(
  matchManager: MatchSessionAdmin | null | undefined,
  physicsManager: PhysicsEngineManager | null | undefined
): WorkerRoomStateSummary | null {
  if (!matchManager) return null;
  const snap = matchManager.getSnapshot();
  const pads = physicsManager?.sim?.getPads?.() || null;
  return {
    roomId: snap.roomId,
    gameMode: snap.gameMode,
    botFillMode: snap.botFillMode,
    state: snap.state,
    matchTick: snap.matchTick,
    clockSecondsRemaining: snap.clockSecondsRemaining,
    isOvertime: snap.isOvertime,
    overtimeSeconds: snap.overtimeSeconds,
    blueScore: snap.blueScore,
    orangeScore: snap.orangeScore,
    winner: snap.winner,
    winReason: snap.winReason,
    lobbyPhysicsActive: snap.lobbyPhysicsActive,
    ghostConfig: physicsManager?.lobbyGhostCoordinator?.getSnapshotConfig?.() || null,
    pads,
    roster: snap.roster,
  };
}

export function routeProtocolMessageInWorker(
  workerCtx: WorkerRouterContext,
  msg: WorkerProtocolIncomingMessage | null | undefined
): boolean {
  if (!msg || typeof msg.type !== 'string') return false;
  const { type, ...rest } = msg;
  const payload: WorkerProtocolPayload =
    msg.payload && typeof msg.payload === 'object' && !(msg.payload instanceof Uint8Array)
      ? { ...rest, ...msg.payload }
      : (rest as WorkerProtocolPayload);
  const seq = msg.seq ?? payload?.reqId ?? 0;
  const { sim, physicsManager, sessionManager, matchManager, dataHandler } = workerCtx;
  const emitRaw: ((msg: Record<string, unknown>, transfer?: Transferable[]) => void) | null =
    workerCtx.emit ||
    (workerCtx.postEnvelope
      ? (envMsg: Record<string, unknown>, transfer?: Transferable[]) =>
          workerCtx.postEnvelope?.(envMsg as unknown as WorkerEnvelope, transfer)
      : null);

  const reply = (replyType: string, replyPayload: unknown, transfer: Transferable[] = []) => {
    if (typeof workerCtx.postEnvelope === 'function') {
      workerCtx.postEnvelope(
        createWorkerEnvelope(replyType, (replyPayload || {}) as Record<string, unknown>, seq),
        transfer
      );
    }
  };
  const syncRoomState = () => {
    if (matchManager) {
      reply(
        HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
        buildWorkerRoomStateSummary(matchManager, physicsManager)
      );
    }
  };

  if (routeReplayAndDiagnosticsMessage(workerCtx, type, payload, seq, reply)) {
    return true;
  }
  if (routeTrainingAndPhysicsMessage(workerCtx, type, payload, syncRoomState, emitRaw)) {
    return true;
  }

  switch (type) {
    case HOST_WORKER_MSG_TYPES.ROOM_CREATE: {
      if (matchManager) {
        if (payload.roomId) matchManager.domain.roomId = payload.roomId;
        if (payload.botFillMode) matchManager.domain.botFillMode = payload.botFillMode;
        if (payload.gameMode) {
          matchManager.roster.setGameMode(payload.gameMode, payload.durationSeconds ?? null);
        }
        if (payload.startAsMatch) matchManager.lifecycle.startMatch(payload.durationSeconds);
        else if (payload.lobbyMode !== false) matchManager.lifecycle.enterLobbyMode(payload);
        else matchManager.lifecycle.startTrainingMode();
        syncRoomState();
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.ROOM_JOIN: {
      const channelId = payload.channelId || payload.sessionId || `peer_${Date.now()}`;
      workerCtx.registerWorkerChannel?.(channelId);
      if (matchManager) {
        matchManager.roster.assignPlayerSlot(
          channelId,
          payload.playerName || 'Player',
          payload.role || 'player',
          payload.preferredTeam ?? null,
          {
            visualId: payload.visualId || 'octane',
            hitboxId: payload.hitboxId || null,
            colorSlot: payload.colorSlot ?? null,
            paintFinish: payload.paintFinish,
            boostVisual: payload.boostVisual,
            boostAudio: payload.boostAudio,
          },
          payload.colorSlot ?? null
        );
        if (
          matchManager.lifecycle.state === MATCH_STATES.LOBBY &&
          physicsManager?.lobbyGhostCoordinator?.lobbyModeActive
        ) {
          physicsManager.syncLobbyGhostMasks();
        }
        syncRoomState();
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.ROOM_LEAVE: {
      const channelId = payload.channelId || payload.sessionId;
      if (channelId) workerCtx.unregisterWorkerChannel?.(channelId);
      syncRoomState();
      return true;
    }

    case HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC: {
      syncRoomState();
      return true;
    }

    case HOST_WORKER_MSG_TYPES.LOCAL_INPUT_FRAME: {
      const channelId = payload.channelId || 'host';
      if (payload.packet && dataHandler) {
        dataHandler.handleIncomingPacket(
          channelId,
          payload.packet,
          payload.timestamp || performance.now()
        );
      } else if (payload.controls && physicsManager) {
        const carIdx = payload.carIndex ?? 0;
        if (typeof payload.targetTick === 'number') {
          physicsManager.pushInput(carIdx, payload.targetTick, payload.controls);
        } else {
          physicsManager.setDirectCarControls(carIdx, payload.controls);
        }
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.RELIABLE_COMMAND: {
      const sessionId = payload.sessionId || payload.channelId || 'host';
      if (matchManager) {
        if (Array.isArray(payload.commands)) {
          matchManager.commandQueue.handleClientCommands(sessionId, payload.commands);
        } else if (payload.command) {
          matchManager.commandQueue.handleClientCommand(sessionId, payload.command);
        } else if (typeof payload.commandType === 'number') {
          matchManager.commandQueue.handleClientCommand(
            sessionId,
            payload as unknown as ClientReliableCommand
          );
        }
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.SIGNAL_ACK: {
      const sessionId = payload.sessionId || payload.channelId || 'host';
      const acks = Array.isArray(payload.acks)
        ? payload.acks
        : typeof payload.signalId === 'number'
          ? [{ signalId: payload.signalId, signalType: payload.signalType }]
          : [];
      if (acks.length > 0) {
        sessionManager?.recordClientSignalAcks?.(sessionId, acks);
        matchManager?.commandQueue.handleClientSignalAcks(sessionId, acks);
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.LOBBY_MODE_SET: {
      if (matchManager) {
        const enabled = payload.enabled !== undefined ? Boolean(payload.enabled) : true;
        if (enabled) {
          if (matchManager.lifecycle.state !== MATCH_STATES.LOBBY || payload.forceEnterLobby) {
            matchManager.lifecycle.enterLobbyMode(payload);
          } else if (physicsManager) {
            physicsManager.setLobbyGhostMode(payload.ghostCars !== false, {
              mode: String(payload.mode || payload.ghostMode || 'ghost_passthrough'),
              hostCarIndex: payload.hostCarIndex ?? 0,
              hostInteractsWithBall: payload.hostInteractsWithBall ?? true,
              broadcastHostOnly: payload.broadcastHostOnly ?? false,
              ghostOpacity: payload.ghostOpacity ?? payload.opacity ?? 0.7,
            });
          }
        } else if (physicsManager) {
          physicsManager.setLobbyGhostMode(false);
        }
        syncRoomState();
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.GHOST_CAR_CONFIG: {
      if (physicsManager) {
        if (typeof payload.carIndex === 'number') {
          physicsManager.setCarCollisionMask(
            payload.carIndex,
            payload.interactWithBall ?? false,
            payload.interactWithCars ?? false,
            payload.opacity
          );
        } else {
          physicsManager.setLobbyGhostMode(payload.enabled ?? true, {
            mode: typeof payload.mode === 'string' ? payload.mode : undefined,
            hostCarIndex: payload.hostCarIndex,
            hostInteractsWithBall: payload.hostInteractsWithBall,
            broadcastHostOnly: payload.broadcastHostOnly,
            ghostOpacity: payload.ghostOpacity ?? payload.opacity,
          });
        }
        syncRoomState();
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.MATCH_START_REQUEST: {
      releaseDiagnosticFleetIfEnabled(workerCtx, matchManager, physicsManager);
      if (matchManager) {
        if (payload.force) matchManager.lifecycle.forceStartMatch(payload.durationSeconds);
        else if (payload.prepareOnly)
          matchManager.lifecycle.initiateMatchPrepare(payload.durationSeconds);
        else matchManager.lifecycle.startMatch(payload.durationSeconds);
        syncRoomState();
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.PODIUM_ENTER: {
      if (matchManager) matchManager.lifecycle.state = MATCH_STATES.PODIUM;
      if (physicsManager && sim) {
        const rawWinner: unknown = matchManager?.lifecycle.winner;
        const winnerTeam =
          rawWinner === 'blue' || rawWinner === 1
            ? 0
            : rawWinner === 'orange' || rawWinner === 2
              ? 1
              : -1;
        for (const cIdx of physicsManager.activeCarIndices) {
          let isWinner = winnerTeam < 0;
          if (!isWinner && matchManager?.roster.players) {
            for (const p of matchManager.roster.players.values()) {
              if (p.entityId === cIdx && p.team === winnerTeam) {
                isWinner = true;
                break;
              }
            }
          }
          sim.setCarLinearFactorAndGravity?.(cIdx, isWinner ? 1 : 0, isWinner ? 1 : 0, 1, 1);
        }
      }
      syncRoomState();
      return true;
    }

    case 'registerChannel':
      if (payload.channelId) workerCtx.registerWorkerChannel?.(payload.channelId);
      return true;

    case 'removeChannel':
      if (payload.channelId) workerCtx.unregisterWorkerChannel?.(payload.channelId);
      return true;

    case 'channel_packet':
    case 'clientInput':
      if (payload.channelId && payload.packet) {
        dataHandler?.handleIncomingPacket(
          payload.channelId,
          payload.packet,
          payload.timestamp || performance.now()
        );
      }
      return true;

    case 'notifyPlayerJoined': {
      const chId =
        payload.channelId || (payload.entityId === 0 ? 'host' : `peer_${payload.entityId}`);
      matchManager?.roster.assignPlayerSlot(
        chId,
        payload.name || `Player ${payload.entityId}`,
        payload.role || 'player',
        typeof payload.entityId === 'number' && payload.entityId >= 0 ? payload.entityId % 2 : null,
        {
          visualId: payload.visualId || 'octane',
          hitboxId: payload.hitboxId || null,
          colorSlot: payload.colorSlot ?? 0,
          paintFinish: payload.paintFinish,
          boostVisual: payload.boostVisual,
          boostAudio: payload.boostAudio,
        },
        payload.colorSlot ?? 0
      );
      return true;
    }

    default:
      return false;
  }
}

export class HostWorkerMessageRouter {
  sim: AuthoritativePhysicsSimPort | null;
  matchManager: MatchSessionAdmin | null;
  physicsManager: PhysicsEngineManager | null;
  sessionManager: EstablishedSessionManager | null;
  dataHandler: NetworkDataHandler | null;
  registerWorkerChannel: ((channelId: string) => void) | null;
  unregisterWorkerChannel: ((channelId: string) => void) | null;
  postEnvelope: ((envelope: WorkerEnvelope, transfer?: Transferable[]) => void) | null;

  constructor(options: HostWorkerMessageRouterOptions = {}) {
    this.sim = options.sim || options.physicsManager?.sim || null;
    this.matchManager = options.matchManager || options.admin || null;
    this.physicsManager =
      options.physicsManager ||
      (this.matchManager?.physicsManager as PhysicsEngineManager | null) ||
      null;
    this.sessionManager =
      options.sessionManager ||
      (this.matchManager?.sessionManager as EstablishedSessionManager | null) ||
      null;
    this.dataHandler = options.dataHandler || null;
    this.registerWorkerChannel = options.registerWorkerChannel || null;
    this.unregisterWorkerChannel = options.unregisterWorkerChannel || null;
    this.postEnvelope = options.postEnvelope || null;
  }

  handleEnvelope(envelope: WorkerEnvelope): boolean {
    return routeProtocolMessageInWorker(
      this,
      envelope as unknown as WorkerProtocolIncomingMessage
    );
  }
}

export default HostWorkerMessageRouter;
