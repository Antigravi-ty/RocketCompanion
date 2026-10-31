/**
 * MatchCommandCoordinator.js
 * Pure coordinator for authoritative match signals, piggybacked ACK retirement,
 * Category 3 (0xC0..0xFF) reliable client commands, two-phase arena-loaded barrier,
 * and voting (skip replay, rematch, forfeit).
 *
 * Extracted from MatchSessionAdmin.js to keep session lifecycle and command/handshake
 * handling cleanly decoupled.
 */

import { MATCH_SIGNALS, CLIENT_COMMAND_TYPES } from '../../protocol/GlobalPayloadCodec.js';
import {
  MATCH_STATES,
  reclaimDisconnectedPlayerSlot,
  updatePlayerLoadout,
  switchPlayerRoleOrTeam,
  broadcastRosterUpdate,
} from './MatchRosterCoordinator.js';
import { packLoadoutSignalParam2 } from '../../../ui-core/config/vehicleConstants.js';

export function getExpectedAckPeerIds(admin) {
  const peers = new Set();
  for (const [sid, p] of admin.players.entries()) {
    if (!p.isBot) {
      peers.add(sid);
    }
  }
  for (const sid of admin.spectators.keys()) {
    peers.add(sid);
  }
  return peers;
}

const ENTITY_SCOPED_SIGNALS = new Set([
  MATCH_SIGNALS.PLAYER_JOINED,
  MATCH_SIGNALS.PLAYER_LEFT,
  MATCH_SIGNALS.PLAYER_SLOT_UPDATED,
  MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
  MATCH_SIGNALS.DEMOLITION,
]);

const NON_REPLAY_WIRE_SIGNALS = new Set([
  MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
  MATCH_SIGNALS.COMMAND_ACK,
]);

export function dispatchMatchSignal(admin, signalType, frameId, param1 = 0, param2 = 0) {
  if (
    (admin.isOvertime || admin.clockDirection === 'up') &&
    (signalType === MATCH_SIGNALS.TIME_ALERT_60S ||
      signalType === MATCH_SIGNALS.TIME_ALERT_30S ||
      signalType === MATCH_SIGNALS.COUNTDOWN_10S)
  ) {
    return null;
  }

  const sharedNext = Math.max(admin.nextSignalId || 0, admin.sessionManager?.signalBuffer?.nextSignalId || 0);
  admin.nextSignalId = (sharedNext % 65535) + 1;
  if (admin.sessionManager?.signalBuffer) {
    admin.sessionManager.signalBuffer.nextSignalId = admin.nextSignalId;
  }
  const isPersistentKickoff = signalType === MATCH_SIGNALS.KICKOFF_WILL_START;
  const signalObj = {
    signalId: admin.nextSignalId,
    signalType,
    frameId,
    param1,
    param2,
    ackedPeers: new Set(),
    remainingRedundancy: isPersistentKickoff ? 480 : 180
  };

  if (!NON_REPLAY_WIRE_SIGNALS.has(signalType)) {
    const wasmFrameIndex = admin.physicsManager?.sim?.getReplayFrameCount?.() ?? admin.replayBuffer?.size ?? 0;
    const logEntry = {
      signalId: signalObj.signalId,
      signalType,
      frameId,
      param1,
      param2,
      frameIndex: wasmFrameIndex,
      recordedAt: Date.now()
    };
    admin.replaySignalLog.push(logEntry);
    const maxSignalLog = admin.replayBuffer?.capacity || 18000;
    if (admin.replaySignalLog.length > maxSignalLog) {
      admin.replaySignalLog.shift();
    }
    if (Array.isArray(admin._currentFrameSignals)) {
      admin._currentFrameSignals.push(logEntry);
    }
    // Single-shot authoritative injection into WASM Track C (Signal Timeline)
    if (admin.physicsManager?.sim && typeof admin.physicsManager.sim.pushSignalEvent === 'function') {
      const p1 = Number(param1 || 0) >>> 0;
      const p2 = Number(param2 || 0) >>> 0;
      admin.physicsManager.sim.pushSignalEvent(
        signalType,
        frameId >>> 0,
        Number(param1 || 0),
        Number(param2 || 0),
        0,
        0,
        0,
        0,
        p1 & 0xffff,
        (p1 >>> 16) & 0xffff,
        p2,
        signalObj.signalId >>> 0,
        0,
        wasmFrameIndex >>> 0
      );
    }
  }

  const mapKey = signalType === MATCH_SIGNALS.COMMAND_ACK
    ? `ack_${param1}_${param2}`
    : ENTITY_SCOPED_SIGNALS.has(signalType)
      ? `sig_${signalType}_ent_${param1}`
      : signalType;
  admin.activeSignals.set(mapKey, signalObj);
  return signalObj;
}

export function handleClientSignalAcks(admin, sessionId, acks = []) {
  if (!Array.isArray(acks) || acks.length === 0) return;
  const expectedPeers = getExpectedAckPeerIds(admin);

  for (let i = 0; i < acks.length; i++) {
    const ack = acks[i];
    if (!ack || typeof ack.signalId !== 'number') continue;

    for (const [key, sObj] of admin.activeSignals.entries()) {
      if (sObj.signalId === ack.signalId && (!ack.signalType || sObj.signalType === ack.signalType)) {
        sObj.ackedPeers.add(sessionId);
        // KICKOFF_WILL_START remains active during the kickoff window or until all peers ACK
        if (sObj.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START) {
          let allAcked = expectedPeers.size > 0;
          for (const pid of expectedPeers) {
            if (!sObj.ackedPeers.has(pid)) {
              allAcked = false;
              break;
            }
          }
          if (allAcked) {
            admin.activeSignals.delete(key);
          }
        }
      }
    }
  }
}

export function initiateMatchPrepare(admin, durationSeconds = null, timeoutTicks = 240) {
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    admin.clockDuration = durationSeconds;
  }
  admin.matchSequence = ((admin.matchSequence || 0) + 1) & 0xFFFF;
  admin.state = MATCH_STATES.PREPARE;
  admin.prepareTimeoutTicks = timeoutTicks;

  if (admin.physicsManager) {
    admin.physicsManager.resetKickoff(0);
    admin.applyRosterKickoffSpawns?.();
    admin.physicsManager.setInputMask?.(true);
    admin.matchTick = admin.physicsManager.currentTick;
  }

  let allBotsOrHostReady = true;
  for (const [sid, p] of admin.players.entries()) {
    if (p.isBot || sid === 'host') {
      p.arenaLoaded = true;
    } else {
      p.arenaLoaded = false;
      allBotsOrHostReady = false;
    }
  }

  admin.dispatchSignal(
    MATCH_SIGNALS.MATCH_PREPARE,
    admin.matchTick,
    admin.matchSequence,
    admin.clockDuration
  );

  for (const p of admin.players.values()) {
    if (typeof p.entityId === 'number' && p.entityId >= 0) {
      admin.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, admin.matchTick, p.entityId, p.team ?? 0);
      admin.dispatchSignal(
        MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
        admin.matchTick,
        p.entityId,
        packLoadoutSignalParam2(
          p.visualIndex ?? p.visualId ?? 'octane',
          p.colorSlot ?? 0,
          p.hitboxIndex ?? p.hitboxId ?? 'hitbox-octane',
          {
            paintFinish: p.paintFinish || 'metallic',
            boostVisual: p.boostVisual || 'cartoon',
            boostAudio: p.boostAudio || 'rush'
          }
        )
      );
    }
  }

  if (allBotsOrHostReady) {
    admin.startMatch(admin.clockDuration);
  }
}

export function checkArenaLoadedBarrier(admin) {
  if (admin.state !== MATCH_STATES.PREPARE) return false;
  for (const p of admin.players.values()) {
    if (!p.isBot && !p.arenaLoaded) {
      return false;
    }
  }
  admin.startMatch(admin.clockDuration);
  return true;
}

export function checkSkipReplayVotes(admin) {
  if (admin.state !== MATCH_STATES.REPLAY && admin.state !== MATCH_STATES.GOAL_SCORED) return;
  let humanCount = 0;
  let votedCount = 0;
  for (const [sid, p] of admin.players.entries()) {
    if (!p.isBot && p.role !== 'spectator') {
      humanCount++;
      if (admin.skipReplayVotes.has(sid)) {
        votedCount++;
      }
    }
  }
  const allHumansVoted = humanCount > 0 && votedCount >= humanCount;
  const spectatorSkippedAllBotMatch = humanCount === 0 && admin.skipReplayVotes.size > 0;
  if (allHumansVoted || spectatorSkippedAllBotMatch) {
    if (admin.state === MATCH_STATES.REPLAY) {
      admin.finishGoalReplay();
    } else if (admin.state === MATCH_STATES.GOAL_SCORED && admin.goalBufferTicks > 35) {
      // Ensure at least 30 ticks of post-goal ball flight complete before skipping
      admin.goalBufferTicks = Math.min(admin.goalBufferTicks, 35);
    }
  }
}

export function checkRematchReady(admin) {
  if (admin.state !== MATCH_STATES.ENDED && admin.state !== MATCH_STATES.PODIUM) return;
  let humanCount = 0;
  let votedCount = 0;
  for (const [sid, p] of admin.players.entries()) {
    if (!p.isBot) {
      humanCount++;
      if (admin.rematchVotes.has(sid)) {
        votedCount++;
      }
    }
  }
  if (humanCount > 0 && votedCount >= humanCount) {
    admin.startMatch(admin.clockDuration);
  }
}

export function handleClientCommand(admin, sessionId, cmd) {
  const commandId = cmd.commandId ?? 0;
  const commandType = cmd.commandType;
  const param1 = cmd.param1 ?? 0;
  const param2 = cmd.param2 ?? 0;

  // Always emit COMMAND_ACK so client can retire its pending command queue
  if (commandId > 0) {
    admin.dispatchSignal(MATCH_SIGNALS.COMMAND_ACK, admin.matchTick, commandId, commandType);
  }

  let seenSet = admin.processedClientCommands.get(sessionId);
  if (!seenSet) {
    seenSet = new Set();
    admin.processedClientCommands.set(sessionId, seenSet);
  }
  if (commandId > 0 && seenSet.has(commandId)) {
    return; // Idempotent deduplication on Server
  }
  if (commandId > 0) {
    seenSet.add(commandId);
    if (seenSet.size > 256) {
      const first = seenSet.values().next().value;
      seenSet.delete(first);
    }
  }

  switch (commandType) {
    case CLIENT_COMMAND_TYPES.CMD_READY_ACK: {
      const player = admin.players.get(sessionId);
      if (player) {
        player.ready = param1 !== 0;
        broadcastRosterUpdate(admin);
      }
      if (admin.state === MATCH_STATES.LOBBY && admin.players.size >= admin.maxPlayers) {
        let allReady = true;
        for (const p of admin.players.values()) {
          if (!p.isBot && !p.ready) {
            allReady = false;
            break;
          }
        }
        if (allReady) {
          admin.initiateMatchPrepare();
        }
      } else if (admin.state === MATCH_STATES.ENDED || admin.state === MATCH_STATES.PODIUM) {
        if (param1 !== 0) {
          admin.rematchVotes.add(sessionId);
          checkRematchReady(admin);
        } else {
          admin.rematchVotes.delete(sessionId);
        }
      }
      break;
    }

    case CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK: {
      const player = admin.players.get(sessionId);
      if (player) {
        player.arenaLoaded = true;
        broadcastRosterUpdate(admin);
      }
      admin.checkArenaLoadedBarrier();
      break;
    }

    case CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT: {
      updatePlayerLoadout(admin, sessionId, param1, param2);
      break;
    }

    case CLIENT_COMMAND_TYPES.CMD_SWITCH_ROLE_TEAM: {
      const targetRole = (param1 === 1 || param1 === 2) ? 'spectator' : 'player';
      const targetTeam = param2 === 1 ? 1 : 0;
      switchPlayerRoleOrTeam(admin, sessionId, targetRole, targetTeam);
      break;
    }

    case CLIENT_COMMAND_TYPES.CMD_VOTE_SKIP_REPLAY: {
      if (param1 !== 0) {
        admin.skipReplayVotes.add(sessionId);
        checkSkipReplayVotes(admin);
      }
      break;
    }

    case CLIENT_COMMAND_TYPES.CMD_VOTE_REMATCH: {
      if (param1 !== 0) {
        admin.rematchVotes.add(sessionId);
      } else {
        admin.rematchVotes.delete(sessionId);
      }
      checkRematchReady(admin);
      break;
    }

    case CLIENT_COMMAND_TYPES.CMD_REQUEST_PAUSE: {
      const wantPause = param1 !== 0;
      if (wantPause && admin.state === MATCH_STATES.PLAYING) {
        admin.setPaused(true);
      } else if (!wantPause && admin.state === MATCH_STATES.PAUSED) {
        admin.requestResumeWithCountdown(5);
      }
      break;
    }

    case CLIENT_COMMAND_TYPES.CMD_VOTE_FORFEIT: {
      const player = admin.players.get(sessionId);
      if (player && (admin.state === MATCH_STATES.PLAYING || admin.state === MATCH_STATES.KICKOFF)) {
        admin.forfeitVotes.add(sessionId);
        const winningTeam = player.team === 0 ? 1 : 0;
        admin.dispatchSignal(MATCH_SIGNALS.FORFEIT_VOTE, admin.matchTick, player.entityId, winningTeam);
        admin.endMatch(winningTeam, 2);
      }
      break;
    }

    case CLIENT_COMMAND_TYPES.CMD_REJOIN_CLAIM: {
      const claimEntityId = (typeof param1 === 'number' && param1 < 6) ? param1 : -1;
      const preferredTeam = (param2 === 0 || param2 === 1) ? param2 : null;
      reclaimDisconnectedPlayerSlot(admin, sessionId, claimEntityId, preferredTeam);
      break;
    }

    default:
      break;
  }
}

export function handleClientCommands(admin, sessionId, commands = []) {
  if (!Array.isArray(commands) || commands.length === 0) return;
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (!cmd || typeof cmd.commandType !== 'number') continue;
    handleClientCommand(admin, sessionId, cmd);
  }
}
