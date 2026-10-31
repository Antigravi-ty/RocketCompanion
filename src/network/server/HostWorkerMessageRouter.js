/**
 * src/network/HostWorkerMessageRouter.js
 * Standardized message envelope router bridging Main Thread (HostServerWorker)
 * and Authoritative Web Worker (AuthoritativeServerWorker / AuthoritativeHostWorker)
 * using the frozen HostWorkerProtocol contract.
 */

import { HOST_WORKER_MSG_TYPES, createWorkerEnvelope } from '../protocol/HostWorkerProtocol.js';
import { MATCH_STATES } from './match/MatchRosterCoordinator.js';
import { buildRosterSnapshot } from './match/MatchControlPacketEvaluator.js';
import {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET,
  ZERO_G_ANCHOR_MODES,
  configureZeroGVehiclePhysics,
  releaseZeroGVehiclePhysics
} from '../diagnostics/DiagnosticsTestVehicles.js';

export { HOST_WORKER_MSG_TYPES, createWorkerEnvelope };

/**
 * Builds a structured cloneable room & match state summary for ROOM_STATE_SYNC.
 * @param {import('./match/MatchSessionAdmin.js').MatchSessionAdmin} matchManager
 * @param {import('./PhysicsEngineManager.js').PhysicsEngineManager} physicsManager
 */
export function buildWorkerRoomStateSummary(matchManager, physicsManager) {
  if (!matchManager) return null;
  const roster = buildRosterSnapshot(matchManager);
  const pads = physicsManager?.sim?.getPads?.() || null;
  return {
    roomId: matchManager.roomId,
    gameMode: matchManager.gameMode,
    botFillMode: matchManager.botFillMode,
    state: matchManager.state,
    matchTick: matchManager.matchTick,
    clockSecondsRemaining: matchManager.clockSecondsRemaining,
    isOvertime: matchManager.isOvertime,
    overtimeSeconds: matchManager.overtimeSeconds,
    blueScore: matchManager.blueScore,
    orangeScore: matchManager.orangeScore,
    winner: matchManager.winner,
    winReason: matchManager.winReason,
    lobbyPhysicsActive: Boolean(matchManager.lobbyPhysicsActive),
    ghostConfig: physicsManager?.lobbyGhostCoordinator?.getSnapshotConfig?.() || null,
    pads,
    roster
  };
}

/**
 * Handles a standardized HOST_WORKER_MSG_TYPES message or worker command inside the
 * Authoritative Worker (or in-memory fallback instance).
 *
 * @param {object} workerCtx
 * @param {import('../../physics/RocketSimPhysicsEngine.js').RocketSimPhysicsEngine} workerCtx.sim
 * @param {import('./PhysicsEngineManager.js').PhysicsEngineManager} workerCtx.physicsManager
 * @param {import('./EstablishedSessionManager.js').EstablishedSessionManager} workerCtx.sessionManager
 * @param {import('./match/MatchSessionAdmin.js').MatchSessionAdmin} workerCtx.matchManager
 * @param {import('./NetworkDataHandler.js').NetworkDataHandler} workerCtx.dataHandler
 * @param {any} [workerCtx.diagnosticsController]
 * @param {(channelId: string) => void} [workerCtx.registerWorkerChannel]
 * @param {(channelId: string) => void} [workerCtx.unregisterWorkerChannel]
 * @param {(envelope: object, transfer?: ArrayBuffer[]) => void} [workerCtx.postEnvelope]
 * @param {(msg: object, transfer?: ArrayBuffer[]) => void} [workerCtx.emit]
 * @param {object} msg - Incoming message or envelope
 * @returns {boolean} True if handled by the protocol router
 */
export function routeProtocolMessageInWorker(workerCtx, msg) {
  if (!msg || typeof msg.type !== 'string') return false;
  const { type, ...rest } = msg;
  const payload = (msg.payload && typeof msg.payload === 'object' && !(msg.payload instanceof Uint8Array))
    ? { ...rest, ...msg.payload }
    : (msg.payload !== undefined ? msg.payload : rest);
  const seq = msg.seq ?? payload?.reqId ?? 0;
  const { sim, physicsManager, sessionManager, matchManager, dataHandler } = workerCtx;
  const emitRaw = workerCtx.emit || workerCtx.postEnvelope;

  const reply = (replyType, replyPayload, transfer = []) => {
    if (typeof workerCtx.postEnvelope === 'function') {
      workerCtx.postEnvelope(createWorkerEnvelope(replyType, replyPayload, seq), transfer);
    }
  };

  switch (type) {
    case HOST_WORKER_MSG_TYPES.ROOM_CREATE: {
      if (matchManager) {
        if (payload.roomId) matchManager.roomId = payload.roomId;
        if (payload.botFillMode) matchManager.botFillMode = payload.botFillMode;
        if (payload.gameMode) {
          matchManager.setGameMode(payload.gameMode, payload.durationSeconds ?? null);
        }
        if (payload.startAsMatch) {
          matchManager.startMatch(payload.durationSeconds);
        } else if (payload.lobbyMode !== false) {
          matchManager.enterLobbyMode(payload);
        } else {
          matchManager.startTrainingMode();
        }
        reply(
          HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
          buildWorkerRoomStateSummary(matchManager, physicsManager)
        );
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.ROOM_JOIN: {
      const channelId = payload.channelId || payload.sessionId || `peer_${Date.now()}`;
      workerCtx.registerWorkerChannel?.(channelId);
      if (matchManager) {
        matchManager.assignPlayerSlot(
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
            boostAudio: payload.boostAudio
          },
          payload.colorSlot ?? null
        );
        if (matchManager.state === MATCH_STATES.LOBBY && physicsManager?.lobbyGhostCoordinator?.lobbyModeActive) {
          physicsManager.syncLobbyGhostMasks();
        }
        reply(
          HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
          buildWorkerRoomStateSummary(matchManager, physicsManager)
        );
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.ROOM_LEAVE: {
      const channelId = payload.channelId || payload.sessionId;
      if (channelId) {
        workerCtx.unregisterWorkerChannel?.(channelId);
      }
      if (matchManager) {
        reply(
          HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
          buildWorkerRoomStateSummary(matchManager, physicsManager)
        );
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC: {
      if (matchManager) {
        reply(
          HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
          buildWorkerRoomStateSummary(matchManager, physicsManager)
        );
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.LOCAL_INPUT_FRAME: {
      const channelId = payload.channelId || 'host';
      if (payload.packet && dataHandler) {
        dataHandler.handleIncomingPacket(channelId, payload.packet, payload.timestamp || performance.now());
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
          matchManager.handleClientCommands(sessionId, payload.commands);
        } else if (payload.command) {
          matchManager.handleClientCommand(sessionId, payload.command);
        } else if (typeof payload.commandType === 'number') {
          matchManager.handleClientCommand(sessionId, payload);
        }
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.SIGNAL_ACK: {
      const sessionId = payload.sessionId || payload.channelId || 'host';
      const acks = Array.isArray(payload.acks)
        ? payload.acks
        : (typeof payload.signalId === 'number' ? [{ signalId: payload.signalId, signalType: payload.signalType }] : []);
      if (acks.length > 0) {
        sessionManager?.recordClientSignalAcks?.(sessionId, acks);
        matchManager?.handleClientSignalAcks?.(sessionId, acks);
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.LOBBY_MODE_SET: {
      if (matchManager) {
        const enabled = payload.enabled !== undefined ? Boolean(payload.enabled) : true;
        if (enabled) {
          if (matchManager.state !== MATCH_STATES.LOBBY || payload.forceEnterLobby) {
            matchManager.enterLobbyMode(payload);
          } else if (physicsManager) {
            physicsManager.setLobbyGhostMode(payload.ghostCars !== false, {
              mode: payload.mode || payload.ghostMode || 'ghost_passthrough',
              hostCarIndex: payload.hostCarIndex ?? 0,
              hostInteractsWithBall: payload.hostInteractsWithBall ?? true,
              broadcastHostOnly: payload.broadcastHostOnly ?? false,
              ghostOpacity: payload.ghostOpacity ?? payload.opacity ?? 0.70,
              ...payload
            });
          }
        } else if (physicsManager) {
          physicsManager.setLobbyGhostMode(false);
        }
        reply(
          HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
          buildWorkerRoomStateSummary(matchManager, physicsManager)
        );
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
          physicsManager.setLobbyGhostMode(payload.enabled ?? true, payload);
        }
        if (matchManager) {
          reply(
            HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
            buildWorkerRoomStateSummary(matchManager, physicsManager)
          );
        }
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.MATCH_START_REQUEST: {
      if (workerCtx.diagnosticsController?.enabled && physicsManager) {
        workerCtx.diagnosticsController.enabled = false;
        workerCtx.diagnosticsController.releasePhysics(physicsManager);
      }
      if (matchManager) {
        if (payload.force) {
          matchManager.forceStartMatch(payload.durationSeconds);
        } else if (payload.prepareOnly) {
          matchManager.initiateMatchPrepare(payload.durationSeconds);
        } else {
          matchManager.startMatch(payload.durationSeconds);
        }
        reply(
          HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
          buildWorkerRoomStateSummary(matchManager, physicsManager)
        );
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.PODIUM_ENTER: {
      if (matchManager) {
        matchManager.state = MATCH_STATES.PODIUM;
      }
      if (physicsManager && sim) {
        const winnerTeam = matchManager?.winner === 'blue' ? 0 : (matchManager?.winner === 'orange' ? 1 : -1);
        for (const cIdx of physicsManager.activeCarIndices) {
          let isWinner = winnerTeam < 0;
          if (!isWinner && matchManager?.players) {
            for (const p of matchManager.players.values()) {
              if (p.entityId === cIdx && p.team === winnerTeam) {
                isWinner = true;
                break;
              }
            }
          }
          if (isWinner) {
            sim.setCarLinearFactorAndGravity?.(cIdx, 1, 1, 1, 1);
          } else {
            sim.setCarLinearFactorAndGravity?.(cIdx, 0, 0, 1, 1);
          }
        }
      }
      if (matchManager) {
        reply(
          HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC,
          buildWorkerRoomStateSummary(matchManager, physicsManager)
        );
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.NET_DIAG_CONFIG:
    case 'configureDiagnosticFleet': {
      const isLobby = !matchManager || matchManager.state === MATCH_STATES.LOBBY;
      const enableZeroG = Boolean(payload.enabled) && isLobby;
      const fleet = Array.isArray(payload.fleet) ? payload.fleet : DEFAULT_DIAGNOSTIC_FLEET;
      const anchorMode = payload.anchorMode || ZERO_G_ANCHOR_MODES.Z_HOVER;
      let diagCtrl = workerCtx.diagnosticsController || matchManager?.diagnosticsController || null;
      if (!diagCtrl && workerCtx) {
        diagCtrl = new DiagnosticsTestVehicleController(fleet, { anchorMode });
        workerCtx.diagnosticsController = diagCtrl;
      }
      if (diagCtrl) {
        diagCtrl.anchorMode = anchorMode;
        diagCtrl.enabled = enableZeroG;
        if (physicsManager) {
          if (enableZeroG) {
            diagCtrl.configurePhysics(physicsManager, anchorMode);
          } else {
            diagCtrl.releasePhysics(physicsManager);
          }
        }
      } else if (physicsManager && sim) {
        if (enableZeroG) {
          configureZeroGVehiclePhysics(physicsManager, fleet, anchorMode);
        } else {
          releaseZeroGVehiclePhysics(physicsManager, fleet);
        }
      }
      return true;
    }

    case HOST_WORKER_MSG_TYPES.NET_IMPAIRMENT_SET: {
      reply(HOST_WORKER_MSG_TYPES.NET_DIAG_METRICS, {
        extraLatencyMs: payload.extraLatencyMs ?? 0,
        jitterMs: payload.jitterMs ?? 0,
        packetLossRate: payload.packetLossRate ?? 0
      });
      return true;
    }

    case HOST_WORKER_MSG_TYPES.REPLAY_WINDOW_REQUEST: {
      const count = payload.count ?? 360;
      const frames = matchManager?.replayBuffer
        ? matchManager.replayBuffer.getRecentFrames(count)
        : [];
      const wasmFrameCount = sim?.getReplayFrameCount?.() ?? 0;
      reply(HOST_WORKER_MSG_TYPES.REPLAY_WINDOW_DATA, {
        reqId: payload.reqId ?? seq,
        frameCount: frames.length,
        wasmFrameCount,
        frames
      });
      return true;
    }

    case HOST_WORKER_MSG_TYPES.REPLAY_FULL_EXPORT_REQUEST: {
      const roster = matchManager ? buildRosterSnapshot(matchManager) : [];
      const loadouts = matchManager?.getMatchRosterMetadata ? matchManager.getMatchRosterMetadata() : (roster?.players || []);
      if (sim && typeof sim.extractWasmReplayTracks === 'function' && (sim.getReplayFrameCount?.() ?? 0) > 0) {
        const tracks = sim.extractWasmReplayTracks();
        const transfer = [];
        if (tracks.stateInputBytes?.buffer) transfer.push(tracks.stateInputBytes.buffer);
        if (tracks.incidentBytes?.buffer) transfer.push(tracks.incidentBytes.buffer);
        if (tracks.signalBytes?.buffer) transfer.push(tracks.signalBytes.buffer);
        reply(
          HOST_WORKER_MSG_TYPES.REPLAY_FULL_EXPORT_DATA,
          {
            reqId: payload.reqId ?? seq,
            frameCount: tracks.frameCount,
            stateStride: tracks.stateStride,
            incidentCount: tracks.incidentCount,
            signalCount: tracks.signalCount,
            stateInputBytes: tracks.stateInputBytes,
            incidentBytes: tracks.incidentBytes,
            signalBytes: tracks.signalBytes,
            blueScore: matchManager?.blueScore ?? 0,
            orangeScore: matchManager?.orangeScore ?? 0,
            winner: matchManager?.winner ?? 0,
            winReason: matchManager?.winReason ?? 0,
            gameMode: matchManager?.gameMode || '3v3',
            durationSeconds: matchManager?.clockDuration ?? 300,
            roster,
            loadouts
          },
          transfer
        );
        return true;
      }

      const frames = matchManager?.replayBuffer ? matchManager.replayBuffer.getRecentFrames() : [];
      reply(HOST_WORKER_MSG_TYPES.REPLAY_FULL_EXPORT_DATA, {
        reqId: payload.reqId ?? seq,
        frameCount: frames.length,
        frames,
        signals: matchManager?.replaySignalLog ? matchManager.replaySignalLog.slice() : [],
        blueScore: matchManager?.blueScore ?? 0,
        orangeScore: matchManager?.orangeScore ?? 0,
        winner: matchManager?.winner ?? 0,
        winReason: matchManager?.winReason ?? 0,
        gameMode: matchManager?.gameMode || '3v3',
        durationSeconds: matchManager?.clockDuration ?? 300,
        roster,
        loadouts
      });
      return true;
    }

    case 'registerChannel': {
      workerCtx.registerWorkerChannel?.(payload.channelId);
      return true;
    }

    case 'removeChannel': {
      workerCtx.unregisterWorkerChannel?.(payload.channelId);
      return true;
    }

    case 'channel_packet':
    case 'clientInput': {
      if (dataHandler) {
        dataHandler.handleIncomingPacket(payload.channelId, payload.packet, payload.timestamp || performance.now());
      }
      return true;
    }

    case 'notifyPlayerJoined': {
      const {
        entityId,
        name,
        role,
        channelId,
        visualId,
        colorSlot,
        hitboxId,
        paintFinish,
        boostVisual,
        boostAudio
      } = payload;
      const chId = channelId || (entityId === 0 ? 'host' : `peer_${entityId}`);
      matchManager?.assignPlayerSlot(
        chId,
        name || `Player ${entityId}`,
        role || 'player',
        typeof entityId === 'number' && entityId >= 0 ? entityId % 2 : null,
        {
          visualId: visualId || 'octane',
          hitboxId: hitboxId || null,
          colorSlot: colorSlot ?? 0,
          paintFinish,
          boostVisual,
          boostAudio
        },
        colorSlot ?? 0
      );
      return true;
    }

    case 'ensureCar': {
      physicsManager?.registerCarEntity(payload.carIndex, payload.team ?? (payload.carIndex % 2), payload.visualId || 'octane');
      return true;
    }

    case 'removeCar': {
      const targetCarIdx = payload.carIndex;
      if (matchManager && typeof targetCarIdx === 'number') {
        for (const [sid, p] of Array.from(matchManager.players.entries())) {
          if (p.entityId === targetCarIdx && sid !== 'host') {
            matchManager.removePlayerSession(sid);
          }
        }
      }
      physicsManager?.unregisterCarEntity(targetCarIdx);
      return true;
    }

    case 'setCarControls': {
      physicsManager?.setDirectCarControls(payload.carIndex, payload.controls);
      return true;
    }

    case 'setCarState': {
      sim?.setCarState?.(payload.carIndex, payload.state || payload.stateObj);
      return true;
    }

    case 'setCarCollisionMask':
    case 'setGhostCarConfig': {
      physicsManager?.setCarCollisionMask(
        payload.carIndex,
        Boolean(payload.interactWithBall),
        Boolean(payload.interactWithCars),
        payload.opacity
      );
      return true;
    }

    case 'setLobbyMode': {
      if (matchManager) {
        if (payload.enabled !== false) {
          matchManager.enterLobbyMode(payload);
        } else {
          physicsManager?.setLobbyGhostMode(false);
        }
      }
      return true;
    }

    case 'setCarLinearFactorAndGravity': {
      sim?.setCarLinearFactorAndGravity?.(
        payload.carIndex,
        payload.fx ?? 1,
        payload.fy ?? 1,
        payload.fz ?? 1,
        payload.gravityScale ?? 1
      );
      return true;
    }

    case 'setArenaMutators': {
      sim?.setArenaMutators?.(payload.mutators || payload);
      return true;
    }

    case 'resetGoalLatch': {
      physicsManager?.resetGoalLatch();
      return true;
    }

    case 'pauseMatch': {
      matchManager?.setPaused(Boolean(payload.paused));
      return true;
    }

    case 'startTrainingMode': {
      matchManager?.startTrainingMode();
      return true;
    }

    case 'startMatch': {
      const diagCtrl = workerCtx.diagnosticsController || matchManager?.diagnosticsController;
      if (diagCtrl?.enabled && physicsManager) {
        diagCtrl.enabled = false;
        diagCtrl.releasePhysics(physicsManager);
      }
      matchManager?.startMatch(payload?.durationSeconds);
      return true;
    }

    case 'forceStartMatch': {
      const diagCtrl = workerCtx.diagnosticsController || matchManager?.diagnosticsController;
      if (diagCtrl?.enabled && physicsManager) {
        diagCtrl.enabled = false;
        diagCtrl.releasePhysics(physicsManager);
      }
      matchManager?.forceStartMatch(payload?.durationSeconds);
      return true;
    }

    case 'initiateMatchPrepare': {
      const diagCtrl = workerCtx.diagnosticsController || matchManager?.diagnosticsController;
      if (diagCtrl?.enabled && physicsManager) {
        diagCtrl.enabled = false;
        diagCtrl.releasePhysics(physicsManager);
      }
      matchManager?.initiateMatchPrepare(payload?.durationSeconds);
      return true;
    }

    case 'setGameMode': {
      if (payload?.gameMode) matchManager?.setGameMode(payload.gameMode, payload.durationSeconds);
      return true;
    }

    case 'setBotFillMode': {
      if (payload?.botFillMode) matchManager?.setBotFillMode(payload.botFillMode);
      return true;
    }

    case 'addBotPlayer': {
      matchManager?.addBotPlayer(payload?.team ?? 1, payload?.botName ?? null, payload?.visualId || 'octane');
      return true;
    }

    case 'setLoadout': {
      matchManager?.updatePlayerLoadout(
        payload.sessionId || 'host',
        payload.visualId || 'octane',
        payload.colorSlot ?? 0,
        payload.hitboxId ?? null,
        payload.extraLoadout ?? null
      );
      return true;
    }

    case 'switchRoleTeam': {
      matchManager?.switchPlayerRoleOrTeam(payload.sessionId || 'host', payload.role || 'player', payload.team ?? 0);
      return true;
    }

    case 'setSkipReplayByDefault': {
      if (matchManager) matchManager.skipReplayByDefault = Boolean(payload.enabled);
      return true;
    }

    case 'setUnlimitedBoost': {
      sim?.setUnlimitedBoost(Boolean(payload.enabled));
      return true;
    }

    case 'setCarUnlimitedBoost': {
      sim?.setCarUnlimitedBoost?.(Number(payload.carIndex) || 0, Boolean(payload.enabled));
      return true;
    }

    case 'setCarBoostCollectable': {
      sim?.setCarBoostCollectable?.(Number(payload.carIndex) || 0, Boolean(payload.collectable));
      return true;
    }

    case 'setCarBoostRecharge': {
      sim?.setCarBoostRecharge?.(
        Number(payload.carIndex) || 0,
        Boolean(payload.enabled),
        Number(payload.rechargePerSecond ?? 10.0),
        Number(payload.rechargeDelay ?? 0.25)
      );
      return true;
    }

    case 'resetKickoff': {
      physicsManager?.resetKickoff(payload.seed || 0);
      return true;
    }

    case 'restoreState': {
      const { state, reqId } = payload;
      if (sim && state) sim.restoreState(state);
      const snap = sim ? (sim.saveCompactState ? sim.saveCompactState() : sim.saveState()) : null;
      const tickCount = sim ? Math.floor(sim.getHeaderView().tickCount) : 0;
      emitRaw?.({ type: 'requestResponse', reqId, result: { snapshot: snap, tickCount } });
      return true;
    }

    case 'saveState': {
      const { reqId } = payload;
      const snap = sim ? (sim.saveCompactState ? sim.saveCompactState() : sim.saveState()) : null;
      const tickCount = sim ? Math.floor(sim.getHeaderView().tickCount) : 0;
      emitRaw?.({ type: 'requestResponse', reqId, result: { snapshot: snap, tickCount } });
      return true;
    }

    default:
      return false;
  }
}

export class HostWorkerMessageRouter {
  constructor(options = {}) {
    this.sim = options.sim || options.admin?.sim || options.physicsManager?.sim || null;
    this.matchManager = options.matchManager || options.admin || null;
    this.physicsManager = options.physicsManager || this.matchManager?.physicsManager || null;
    this.sessionManager = options.sessionManager || this.matchManager?.sessionManager || null;
    this.dataHandler = options.dataHandler || null;
    this.registerWorkerChannel = options.registerWorkerChannel || null;
    this.unregisterWorkerChannel = options.unregisterWorkerChannel || null;
    this.postEnvelope = options.postEnvelope || null;
  }

  handleEnvelope(envelope) {
    return routeProtocolMessageInWorker(this, envelope);
  }
}

export default HostWorkerMessageRouter;
