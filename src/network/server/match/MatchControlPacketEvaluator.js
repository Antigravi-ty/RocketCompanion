import { CLIENT_COMMAND_TYPES } from '../../protocol/GlobalPayloadCodec.js';

/**
 * src/network/MatchControlPacketEvaluator.js
 * Handshake response assembly, RTT telemetry collection, and JSON control packet evaluation
 * for MatchSessionAdmin / MatchRosterCoordinator.
 */

export function collectSessionUserRtt(sessionManager) {
  const playersRtt = [null, null, null, null, null, null];
  const spectatorsRtt = [];

  if (!sessionManager) {
    return { players: playersRtt, spectators: spectatorsRtt };
  }

  const sessions = sessionManager.getAllSessions();
  for (const session of sessions) {
    if (session.role === 'player' && session.entityId >= 0 && session.entityId < 6) {
      playersRtt[session.entityId] = Math.round(session.rttMs || 0);
    } else if (session.role === 'spectator') {
      spectatorsRtt.push({
        id: spectatorsRtt.length,
        rtt: Math.round(session.rttMs || 0)
      });
    }
  }

  return {
    players: playersRtt,
    spectators: spectatorsRtt
  };
}

export function buildRosterSnapshot(admin) {
  const players = [];
  for (const p of admin.players.values()) {
    players.push({
      sessionId: p.sessionId,
      entityId: p.entityId,
      carIndex: p.entityId,
      team: p.team,
      name: p.name,
      spawnSlot: p.spawnSlot,
      visualId: p.visualId,
      visualIndex: p.visualIndex,
      hitboxId: p.hitboxId,
      hitboxIndex: p.hitboxIndex,
      colorSlot: p.colorSlot,
      colorHex: p.colorHex || null,
      paintFinish: p.paintFinish || 'metallic',
      boostVisual: p.boostVisual || 'cartoon',
      boostAudio: p.boostAudio || 'rush',
      isBot: Boolean(p.isBot),
      ready: Boolean(p.ready),
      arenaLoaded: Boolean(p.arenaLoaded)
    });
  }
  const spectators = [];
  for (const s of admin.spectators.values()) {
    spectators.push({
      sessionId: s.sessionId,
      name: s.name,
      role: 'spectator'
    });
  }
  return { players, spectators };
}

export function evaluateControlPacket(admin, channelId, packetType, packetData, updatePlayerLoadoutFn) {
  if (!packetData) return null;
  const type = packetData.type || packetType;

  if (type === 'join' || type === 'join_training' || type === 'token' || type === 'handshake_request') {
    const playerName = packetData.playerName || packetData.clientName || 'Player';
    const role = packetData.role || 'player';
    const preferredTeam = packetData.preferredTeam ?? null;
    const playerInfo = admin.assignPlayerSlot(channelId, playerName, role, preferredTeam, {
      visualId: packetData.visualId || packetData.carVisual || 'fennec',
      hitboxId: packetData.hitboxId || packetData.carHitbox || null,
      colorSlot: packetData.colorSlot,
      paintFinish: packetData.paintFinish,
      boostVisual: packetData.boostVisual,
      boostAudio: packetData.boostAudio
    });

    if (admin.dataHandler) {
      const sim = admin.physicsManager?.sim;
      const rawSnap = sim?.saveCompactState ? sim.saveCompactState() : sim?.saveState?.();
      const initialSnap = rawSnap ? Array.from(rawSnap) : null;
      admin.dataHandler.sendPacket(channelId, JSON.stringify({
        type: 'handshake_response',
        entityId: playerInfo.entityId,
        team: playerInfo.team,
        spawnSlot: playerInfo.spawnSlot,
        visualId: playerInfo.visualId,
        visualIndex: playerInfo.visualIndex,
        hitboxId: playerInfo.hitboxId,
        hitboxIndex: playerInfo.hitboxIndex,
        colorSlot: playerInfo.colorSlot,
        colorHex: playerInfo.colorHex,
        paintFinish: playerInfo.paintFinish || 'metallic',
        boostVisual: playerInfo.boostVisual || 'cartoon',
        boostAudio: playerInfo.boostAudio || 'rush',
        roomId: admin.roomId,
        gameMode: admin.gameMode,
        matchTick: admin.matchTick,
        serverFrame: admin.matchTick,
        initialSnapshot: initialSnap,
        roster: buildRosterSnapshot(admin),
        state: admin.state,
        isHost: false
      }));
    }
    return playerInfo;
  }

  if (type === 'color_change' || type === 'loadout_change') {
    if (
      packetData.visualId !== undefined ||
      packetData.slotId !== undefined ||
      packetData.hitboxId !== undefined ||
      packetData.paintFinish !== undefined ||
      packetData.boostVisual !== undefined ||
      packetData.boostAudio !== undefined
    ) {
      const extraLoadout = {
        paintFinish: packetData.paintFinish,
        boostVisual: packetData.boostVisual,
        boostAudio: packetData.boostAudio
      };
      if (typeof updatePlayerLoadoutFn === 'function') {
        updatePlayerLoadoutFn(
          admin,
          channelId,
          packetData.visualId ?? 'fennec',
          packetData.slotId,
          packetData.hitboxId ?? null,
          extraLoadout
        );
      } else {
        admin.updatePlayerLoadout?.(
          channelId,
          packetData.visualId ?? 'fennec',
          packetData.slotId,
          packetData.hitboxId ?? null,
          extraLoadout
        );
      }
    }
    if (admin.dataHandler) {
      admin.dataHandler.broadcast(JSON.stringify(packetData), (id) => id !== channelId);
    }
    return null;
  }

  if (type === 'client_command' && typeof packetData.commandType === 'number') {
    admin.handleClientCommand?.(channelId, packetData);
    return null;
  }

  if (type === 'match_ready_ack') {
    admin.handleClientCommand?.(channelId, {
      commandId: packetData.commandId ?? 0,
      commandType: CLIENT_COMMAND_TYPES.CMD_READY_ACK,
      param1: packetData.ready === false ? 0 : 1,
      param2: 0
    });
    return null;
  }

  if (type === 'arena_loaded_ack') {
    admin.handleClientCommand?.(channelId, {
      commandId: packetData.commandId ?? 0,
      commandType: CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK,
      param1: packetData.matchSequence ?? 0,
      param2: 0
    });
    return null;
  }

  if (type === 'ping') {
    if (typeof packetData.rtt === 'number') {
      const session = admin.sessionManager?.getSession(channelId);
      if (session) {
        session.updateRtt(packetData.rtt);
      }
    }
    if (admin.dataHandler) {
      admin.dataHandler.sendPacket(channelId, JSON.stringify({
        type: 'pong',
        sendTime: packetData.sendTime || Date.now(),
        serverTime: Date.now()
      }));
    }
    return null;
  }

  if (type === 'leave') {
    admin.removePlayerSession(channelId);
    return null;
  }

  return null;
}
