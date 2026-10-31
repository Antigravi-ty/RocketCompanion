import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.js';
import { CAR_STATE_OFFSETS, CAR_STATE_STRIDE, KICKOFF_SPAWN_PRESETS } from '../../../physics/RocketSimConstants.js';
import {
  CAR_COLOR_SLOTS,
  PLAYER_ROLES,
  PLAYER_ROLE_CODES,
  normalizeVisualId,
  encodeVisualIdIndex,
  decodeVisualIdIndex,
  resolveHitboxIndex,
  decodeHitboxIndex,
  resolveVehicleHitboxId,
  decodePaintFinishIndex,
  decodeBoostVisualIndex,
  decodeBoostAudioIndex,
  packLoadoutSignalParam2,
  unpackLoadoutCommandParam1,
  unpackLoadoutCommandParam2,
  getCarColorSlotById
} from '../../../ui-core/config/vehicleConstants.js';
import {
  buildRosterSnapshot
} from './MatchControlPacketEvaluator.js';

export function broadcastRosterUpdate(admin) {
  if (!admin?.dataHandler || typeof admin.dataHandler.broadcast !== 'function') return;
  if (admin._applyingBotFillPolicy) return;
  try {
    admin.dataHandler.broadcast(JSON.stringify({
      type: 'roster_update',
      roomId: admin.roomId,
      gameMode: admin.gameMode,
      state: admin.state,
      roster: buildRosterSnapshot(admin)
    }));
  } catch (err) {
    console.warn('[MatchRosterCoordinator] Failed to broadcast roster_update:', err);
  }
}

export const MATCH_STATES = Object.freeze({
  LOBBY: 'lobby',
  PREPARE: 'prepare',
  COUNTDOWN: 'countdown',
  KICKOFF: 'kickoff',
  KICKOFF_COUNTDOWN: 'kickoff',
  PLAYING: 'playing',
  GOAL_SCORED: 'goal_scored',
  REPLAY: 'replay',
  GOAL_REPLAY: 'replay',
  PAUSED: 'paused',
  ENDED: 'ended',
  PODIUM: 'podium'
});

export function resolveDefaultColorSlotForTeam(team) {
  return team === 0 ? 3 : 0; // 3 = Sky Blue, 0 = Flame Red
}

export function normalizeRosterSpawnSlots(admin) {
  if (!admin?.players) return;
  const usedSlotsByTeam = [new Set(), new Set()];
  const orderedPlayers = Array.from(admin.players.values())
    .filter((p) => p && typeof p.entityId === 'number' && p.entityId >= 0)
    .sort((a, b) => a.entityId - b.entityId);

  for (const p of orderedPlayers) {
    const teamIdx = p.team === 1 ? 1 : 0;
    const used = usedSlotsByTeam[teamIdx];
    let slot = typeof p.spawnSlot === 'number' && p.spawnSlot >= 0
      ? p.spawnSlot % KICKOFF_SPAWN_PRESETS.length
      : 0;
    if (used.has(slot)) {
      slot = 0;
      while (used.has(slot) && slot < KICKOFF_SPAWN_PRESETS.length) {
        slot++;
      }
      slot = slot % KICKOFF_SPAWN_PRESETS.length;
    }
    used.add(slot);
    p.spawnSlot = slot;
  }
}

export function applyRosterKickoffSpawns(admin) {
  normalizeRosterSpawnSlots(admin);
  const sim = admin?.physicsManager?.sim;
  if (!sim || typeof sim.setCarState !== 'function') return;

  for (const p of admin.players.values()) {
    if (typeof p.entityId !== 'number' || p.entityId < 0) continue;
    sim.setCarTeam?.(p.entityId, p.team ?? 0);
    const preset = KICKOFF_SPAWN_PRESETS[p.spawnSlot] || KICKOFF_SPAWN_PRESETS[0];
    const presetCoord = p.team === 0 ? preset.team0 : preset.team1;
    if (!presetCoord) continue;

    const cy = Math.cos(presetCoord.yaw);
    const sy = Math.sin(presetCoord.yaw);
    const carState = new Float32Array(CAR_STATE_STRIDE);
    carState[CAR_STATE_OFFSETS.POS] = presetCoord.x;
    carState[CAR_STATE_OFFSETS.POS + 1] = presetCoord.y;
    carState[CAR_STATE_OFFSETS.POS + 2] = presetCoord.z;
    carState[CAR_STATE_OFFSETS.FWD] = cy;
    carState[CAR_STATE_OFFSETS.FWD + 1] = sy;
    carState[CAR_STATE_OFFSETS.FWD + 2] = 0;
    carState[CAR_STATE_OFFSETS.RIGHT] = -sy;
    carState[CAR_STATE_OFFSETS.RIGHT + 1] = cy;
    carState[CAR_STATE_OFFSETS.RIGHT + 2] = 0;
    carState[CAR_STATE_OFFSETS.UP] = 0;
    carState[CAR_STATE_OFFSETS.UP + 1] = 0;
    carState[CAR_STATE_OFFSETS.UP + 2] = 1;
    carState[CAR_STATE_OFFSETS.BOOST] =
      admin.state === MATCH_STATES.LOBBY || admin.isTrainingMode ? 100.0 : 33.33;
    carState[CAR_STATE_OFFSETS.ON_GROUND] = 1;
    carState[CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = 1;
    sim.setCarState(p.entityId, carState);
  }
}

export function resolveColorHexForSlot(colorSlot, team = 0) {
  const slotObj = getCarColorSlotById(colorSlot);
  if (slotObj?.hex) return slotObj.hex;
  return team === 0 ? '#42a5f5' : '#ff7043';
}

export function assignSessionPlayerSlot(
  admin,
  sessionId,
  playerName = 'Player',
  role = 'player',
  preferredTeam = null,
  loadoutOptions = {},
  colorSlotArg = null
) {
  const normalizedLoadout = (typeof loadoutOptions === 'string' || typeof loadoutOptions === 'number')
    ? { visualId: loadoutOptions, colorSlot: colorSlotArg }
    : (loadoutOptions || {});
  const requestedVisual = decodeVisualIdIndex(normalizedLoadout.visualId ?? normalizedLoadout.visualIndex ?? 'octane');
  const requestedHitboxIndex = (normalizedLoadout.hitboxId !== undefined && normalizedLoadout.hitboxId !== null)
    ? resolveHitboxIndex(normalizedLoadout.hitboxId)
    : (normalizedLoadout.hitboxIndex !== undefined && normalizedLoadout.hitboxIndex !== null)
      ? resolveHitboxIndex(normalizedLoadout.hitboxIndex)
      : resolveHitboxIndex(requestedVisual);
  const requestedHitboxId = decodeHitboxIndex(requestedHitboxIndex);
  const requestedPaintFinish = decodePaintFinishIndex(normalizedLoadout.paintFinish ?? 'metallic');
  const requestedBoostVisual = decodeBoostVisualIndex(normalizedLoadout.boostVisual ?? 'cartoon');
  const requestedBoostAudio = decodeBoostAudioIndex(normalizedLoadout.boostAudio ?? 'rush');

  const isBotSession = sessionId === 'bot' || String(sessionId).startsWith('bot_');

  if (admin.players.has(sessionId)) {
    const existing = admin.players.get(sessionId);
    if (playerName && playerName !== 'Player') {
      existing.name = playerName;
      const s = admin.sessionManager?.getSession(sessionId);
      if (s) s.playerName = playerName;
    }
    if (
      !isBotSession &&
      (preferredTeam === 0 || preferredTeam === 1) &&
      existing.team !== preferredTeam &&
      admin.state === MATCH_STATES.LOBBY
    ) {
      const occupiedTargetSlots = new Set();
      for (const [sid, p] of admin.players.entries()) {
        if (sid !== sessionId && p.team === preferredTeam) {
          occupiedTargetSlots.add(p.spawnSlot);
        }
      }
      let nextSpawnSlot = 0;
      while (occupiedTargetSlots.has(nextSpawnSlot) && nextSpawnSlot < KICKOFF_SPAWN_PRESETS.length) {
        nextSpawnSlot++;
      }
      existing.team = preferredTeam;
      existing.spawnSlot = nextSpawnSlot % KICKOFF_SPAWN_PRESETS.length;
      existing.colorHex = resolveColorHexForSlot(existing.colorSlot, existing.team);
      const s = admin.sessionManager?.getSession(sessionId);
      if (s) s.team = preferredTeam;
      if (admin.physicsManager?.sim && typeof existing.entityId === 'number' && existing.entityId >= 0) {
        admin.physicsManager.sim.setCarTeam?.(existing.entityId, preferredTeam);
      }
      normalizeRosterSpawnSlots(admin);
      if (typeof existing.entityId === 'number' && existing.entityId >= 0) {
        admin.dispatchSignal(
          MATCH_SIGNALS.PLAYER_SLOT_UPDATED,
          admin.matchTick,
          existing.entityId,
          existing.team
        );
      }
    }
    if (normalizedLoadout.visualId !== undefined || normalizedLoadout.visualIndex !== undefined) {
      existing.visualId = requestedVisual;
      existing.visualIndex = encodeVisualIdIndex(requestedVisual);
    }
    if (normalizedLoadout.hitboxId !== undefined || normalizedLoadout.hitboxIndex !== undefined) {
      existing.hitboxId = requestedHitboxId;
      existing.hitboxIndex = requestedHitboxIndex;
    }
    if (typeof normalizedLoadout.colorSlot === 'number') {
      existing.colorSlot = normalizedLoadout.colorSlot;
      existing.colorHex = resolveColorHexForSlot(existing.colorSlot, existing.team);
    }
    if (normalizedLoadout.paintFinish !== undefined) {
      existing.paintFinish = requestedPaintFinish;
    }
    if (normalizedLoadout.boostVisual !== undefined) {
      existing.boostVisual = requestedBoostVisual;
    }
    if (normalizedLoadout.boostAudio !== undefined) {
      existing.boostAudio = requestedBoostAudio;
    }
    if (
      !isBotSession &&
      !admin._applyingBotFillPolicy &&
      admin.state !== MATCH_STATES.LOBBY &&
      (admin.botFillMode === 'auto_fill' || admin.botFillMode === 'bots_vs_humans')
    ) {
      admin.applyBotFillPolicy?.();
    }
    broadcastRosterUpdate(admin);
    return existing;
  }
  if (admin.spectators.has(sessionId) && role === 'spectator') {
    const existing = admin.spectators.get(sessionId);
    if (playerName && playerName !== 'Player') existing.name = playerName;
    broadcastRosterUpdate(admin);
    return existing;
  }

  // When a human player joins, clear auto-filled bots first so human players always receive
  // contiguous low entityIds (0, 1, ...) and requested teams before bots refill remaining slots.
  let clearedAutoFillBots = false;
  if (role !== 'spectator' && !isBotSession && !admin._applyingBotFillPolicy) {
    const prevApplying = admin._applyingBotFillPolicy;
    admin._applyingBotFillPolicy = true;
    try {
      for (const [sid, p] of Array.from(admin.players.entries())) {
        if (p.isBot && String(sid).startsWith('bot_fill_')) {
          removeSessionPlayerSlot(admin, sid);
          clearedAutoFillBots = true;
        }
      }
    } finally {
      admin._applyingBotFillPolicy = prevApplying;
    }
  }

  if (role === 'spectator' || admin.players.size >= admin.maxPlayers) {
    admin.spectators.set(sessionId, {
      sessionId,
      name: playerName,
      role: 'spectator',
      ready: true,
      arenaLoaded: true
    });
    admin.sessionManager?.registerSession(sessionId, { role: 'spectator', entityId: -1, playerName });
    admin.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, admin.matchTick, -1, 2);
    return { entityId: -1, team: -1, role: 'spectator', spawnSlot: -1 };
  }

  let team0Count = 0;
  let team1Count = 0;
  const occupiedSlotsTeam0 = new Set();
  const occupiedSlotsTeam1 = new Set();

  for (const p of admin.players.values()) {
    if (p.team === 0) {
      team0Count++;
      occupiedSlotsTeam0.add(p.spawnSlot);
    } else {
      team1Count++;
      occupiedSlotsTeam1.add(p.spawnSlot);
    }
  }

  const maxPerTeam = 5;
  let assignedTeam = preferredTeam;
  if (assignedTeam === 0 && team0Count >= maxPerTeam && team1Count < maxPerTeam) {
    assignedTeam = 1;
  } else if (assignedTeam === 1 && team1Count >= maxPerTeam && team0Count < maxPerTeam) {
    assignedTeam = 0;
  } else if (assignedTeam !== 0 && assignedTeam !== 1) {
    assignedTeam = (team0Count <= team1Count) ? 0 : 1;
  }

  let spawnSlot = 0;
  const targetOccupied = (assignedTeam === 0) ? occupiedSlotsTeam0 : occupiedSlotsTeam1;
  while (targetOccupied.has(spawnSlot) && spawnSlot < KICKOFF_SPAWN_PRESETS.length) {
    spawnSlot++;
  }

  let assignedEntityId = -1;
  const usedEntityIds = new Set(Array.from(admin.players.values()).map((p) => p.entityId));
  for (let i = 0; i < 6; i++) {
    if (!usedEntityIds.has(i)) {
      assignedEntityId = i;
      break;
    }
  }

  const visualIndex = encodeVisualIdIndex(requestedVisual);
  const colorSlot = typeof normalizedLoadout.colorSlot === 'number'
    ? normalizedLoadout.colorSlot
    : resolveDefaultColorSlotForTeam(assignedTeam);
  const colorHex = normalizedLoadout.colorHex || resolveColorHexForSlot(colorSlot, assignedTeam);

  const playerInfo = {
    sessionId,
    entityId: assignedEntityId,
    carIndex: assignedEntityId,
    team: assignedTeam,
    name: playerName,
    role: 'player',
    spawnSlot,
    visualId: requestedVisual,
    visualIndex,
    hitboxId: requestedHitboxId,
    hitboxIndex: requestedHitboxIndex,
    colorSlot,
    colorHex,
    paintFinish: requestedPaintFinish,
    boostVisual: requestedBoostVisual,
    boostAudio: requestedBoostAudio,
    ready: isBotSession || sessionId === 'host',
    arenaLoaded: isBotSession || sessionId === 'host',
    isBot: isBotSession
  };

  const deferLobbyPhysics =
    admin.state === MATCH_STATES.LOBBY &&
    Boolean(admin.lobbyMode || admin.isTrainingMode) &&
    sessionId !== 'host';

  admin.players.set(sessionId, playerInfo);
  admin.sessionManager?.registerSession(sessionId, {
    role: 'player',
    entityId: assignedEntityId,
    team: assignedTeam,
    visualId: requestedVisual,
    hitboxId: requestedHitboxId,
    deferPhysicsRegistration: deferLobbyPhysics,
    playerName
  });

  if (!deferLobbyPhysics && admin.physicsManager && assignedEntityId >= 0) {
    admin.physicsManager.registerCarEntity(assignedEntityId, assignedTeam, requestedHitboxId);
    admin.physicsManager.applySignal('HOTSWAP_HITBOX', {
      carIndex: assignedEntityId,
      hitboxType: requestedHitboxId
    });
    const preset = KICKOFF_SPAWN_PRESETS[spawnSlot] || KICKOFF_SPAWN_PRESETS[0];
    const presetCoord = (assignedTeam === 0) ? preset.team0 : preset.team1;
    if (presetCoord && typeof admin.physicsManager.sim?.getCarState === 'function') {
      const cy = Math.cos(presetCoord.yaw);
      const sy = Math.sin(presetCoord.yaw);
      const carState = new Float32Array(CAR_STATE_STRIDE);
      carState[CAR_STATE_OFFSETS.POS] = presetCoord.x;
      carState[CAR_STATE_OFFSETS.POS + 1] = presetCoord.y;
      carState[CAR_STATE_OFFSETS.POS + 2] = presetCoord.z;
      carState[CAR_STATE_OFFSETS.FWD] = cy;
      carState[CAR_STATE_OFFSETS.FWD + 1] = sy;
      carState[CAR_STATE_OFFSETS.FWD + 2] = 0;
      carState[CAR_STATE_OFFSETS.RIGHT] = -sy;
      carState[CAR_STATE_OFFSETS.RIGHT + 1] = cy;
      carState[CAR_STATE_OFFSETS.RIGHT + 2] = 0;
      carState[CAR_STATE_OFFSETS.UP] = 0;
      carState[CAR_STATE_OFFSETS.UP + 1] = 0;
      carState[CAR_STATE_OFFSETS.UP + 2] = 1;
      carState[CAR_STATE_OFFSETS.BOOST] = (admin.state === MATCH_STATES.LOBBY || admin.isTrainingMode) ? 100.0 : 33.33;
      carState[CAR_STATE_OFFSETS.ON_GROUND] = 1;
      carState[CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = 1;
      admin.physicsManager.sim.setCarState(assignedEntityId, carState);
    }
    if (admin.state === MATCH_STATES.LOBBY && admin.physicsManager.lobbyGhostCoordinator?.lobbyModeActive) {
      admin.physicsManager.syncLobbyGhostMasks?.();
    }
  }

  admin.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, admin.matchTick, assignedEntityId, assignedTeam);
  admin.dispatchSignal(
    MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
    admin.matchTick,
    assignedEntityId,
    packLoadoutSignalParam2(visualIndex, colorSlot, requestedHitboxIndex, {
      paintFinish: requestedPaintFinish,
      boostVisual: requestedBoostVisual,
      boostAudio: requestedBoostAudio
    })
  );

  if (
    (clearedAutoFillBots || (admin.botFillMode === 'auto_fill' || admin.botFillMode === 'bots_vs_humans')) &&
    !isBotSession &&
    !admin._applyingBotFillPolicy &&
    admin.state !== MATCH_STATES.LOBBY
  ) {
    admin.applyBotFillPolicy?.();
  }

  broadcastRosterUpdate(admin);

  if (!admin._applyingBotFillPolicy && admin.autoStartWhenFull && admin.players.size >= admin.maxPlayers && admin.state === MATCH_STATES.LOBBY) {
    admin.initiateMatchPrepare?.();
  }

  return playerInfo;
}

export function removeSessionPlayerSlot(admin, sessionId) {
  const player = admin.players.get(sessionId);
  if (player) {
    const entityId = player.entityId;
    const wasHuman = !player.isBot;
    if (admin.disconnectedPlayerSlots instanceof Map && wasHuman && entityId >= 0) {
      admin.disconnectedPlayerSlots.set(entityId, {
        ...player,
        disconnectedAtTick: admin.matchTick
      });
    }
    admin.players.delete(sessionId);
    admin.sessionManager?.unregisterSession(sessionId);
    if (admin.physicsManager && entityId >= 0) {
      admin.physicsManager.unregisterCarEntity(entityId);
    }
    admin.dispatchSignal(MATCH_SIGNALS.PLAYER_LEFT, admin.matchTick, entityId, player.team ?? 0);
    admin.skipReplayVotes?.delete(sessionId);
    admin.rematchVotes?.delete(sessionId);
    if (
      wasHuman &&
      !admin._applyingBotFillPolicy &&
      admin.state !== MATCH_STATES.LOBBY &&
      (admin.botFillMode === 'auto_fill' || admin.botFillMode === 'bots_vs_humans')
    ) {
      admin.applyBotFillPolicy?.();
    }
    broadcastRosterUpdate(admin);
    return;
  }
  if (admin.spectators.has(sessionId)) {
    admin.spectators.delete(sessionId);
    admin.sessionManager?.unregisterSession(sessionId);
    admin.dispatchSignal(MATCH_SIGNALS.PLAYER_LEFT, admin.matchTick, -1, 2);
    broadcastRosterUpdate(admin);
  }
}

export function reclaimDisconnectedPlayerSlot(admin, sessionId, requestedEntityId = -1, preferredTeam = null) {
  if (!admin) return null;
  if (admin.players.has(sessionId)) {
    return admin.players.get(sessionId);
  }
  const disconnectedMap = admin.disconnectedPlayerSlots instanceof Map ? admin.disconnectedPlayerSlots : null;
  let reclaimed = null;
  if (disconnectedMap && disconnectedMap.size > 0) {
    if (typeof requestedEntityId === 'number' && requestedEntityId >= 0 && disconnectedMap.has(requestedEntityId)) {
      reclaimed = disconnectedMap.get(requestedEntityId);
      disconnectedMap.delete(requestedEntityId);
    } else {
      const firstEntry = disconnectedMap.entries().next().value;
      if (firstEntry) {
        reclaimed = firstEntry[1];
        disconnectedMap.delete(firstEntry[0]);
      }
    }
  }

  if (!reclaimed) {
    return assignSessionPlayerSlot(admin, sessionId, 'Player', 'player', preferredTeam);
  }

  const usedEntityIds = new Set(Array.from(admin.players.values()).map((p) => p.entityId));
  let entityId = reclaimed.entityId;
  if (usedEntityIds.has(entityId) || entityId < 0 || entityId >= 6) {
    entityId = -1;
    for (let i = 0; i < 6; i++) {
      if (!usedEntityIds.has(i)) {
        entityId = i;
        break;
      }
    }
  }
  if (entityId < 0) {
    return assignSessionPlayerSlot(admin, sessionId, reclaimed.name || 'Player', 'spectator');
  }

  if (admin.spectators.has(sessionId)) {
    admin.spectators.delete(sessionId);
  }

  const playerInfo = {
    ...reclaimed,
    sessionId,
    entityId,
    carIndex: entityId,
    ready: true,
    arenaLoaded: true,
    isBot: false
  };
  admin.players.set(sessionId, playerInfo);
  admin.sessionManager?.registerSession(sessionId, {
    role: 'player',
    entityId,
    team: playerInfo.team,
    visualId: playerInfo.visualId,
    hitboxId: playerInfo.hitboxId,
    deferPhysicsRegistration: false,
    playerName: playerInfo.name
  });

  if (admin.physicsManager) {
    admin.physicsManager.registerCarEntity(entityId, playerInfo.team, playerInfo.hitboxId || playerInfo.visualId || 'octane');
    admin.physicsManager.applySignal('HOTSWAP_HITBOX', {
      carIndex: entityId,
      hitboxType: playerInfo.hitboxId || playerInfo.visualId || 'octane'
    });
  }

  admin.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, admin.matchTick, entityId, playerInfo.team);
  admin.dispatchSignal(MATCH_SIGNALS.PLAYER_SLOT_UPDATED, admin.matchTick, entityId, playerInfo.team);
  admin.dispatchSignal(
    MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
    admin.matchTick,
    entityId,
    packLoadoutSignalParam2(playerInfo.visualIndex ?? playerInfo.visualId, playerInfo.colorSlot, playerInfo.hitboxIndex ?? playerInfo.hitboxId, {
      paintFinish: playerInfo.paintFinish || 'metallic',
      boostVisual: playerInfo.boostVisual || 'cartoon',
      boostAudio: playerInfo.boostAudio || 'rush'
    })
  );
  broadcastRosterUpdate(admin);
  return playerInfo;
}

export function updatePlayerLoadout(
  admin,
  sessionId,
  visualIdOrPackedParam1,
  colorSlotOrPackedParam2 = null,
  explicitHitbox = null,
  extraLoadout = null
) {
  const player = admin.players.get(sessionId);
  if (!player) return null;

  const unpacked = unpackLoadoutCommandParam1(visualIdOrPackedParam1);
  const visualId = unpacked.visualId;
  const visualIndex = unpacked.visualIndex;
  const hitboxIndex = (explicitHitbox !== null && explicitHitbox !== undefined)
    ? resolveHitboxIndex(explicitHitbox)
    : unpacked.hitboxIndex;
  const hitboxId = decodeHitboxIndex(hitboxIndex);

  let nextColorSlot = player.colorSlot;
  let nextPaintFinish = player.paintFinish || 'metallic';
  let nextBoostVisual = player.boostVisual || 'cartoon';
  let nextBoostAudio = player.boostAudio || 'rush';

  if (typeof colorSlotOrPackedParam2 === 'number') {
    const unpackedParam2 = unpackLoadoutCommandParam2(colorSlotOrPackedParam2);
    if (unpackedParam2.colorSlot >= 0 && unpackedParam2.colorSlot < CAR_COLOR_SLOTS.length) {
      nextColorSlot = unpackedParam2.colorSlot;
    } else {
      console.warn(`[MatchRosterCoordinator:Fallback] Out-of-range colorSlot ${unpackedParam2.colorSlot} for session "${sessionId}", keeping slot ${player.colorSlot}.`);
    }
    if (unpackedParam2.hasExtendedCosmetics) {
      nextPaintFinish = unpackedParam2.paintFinish;
      nextBoostVisual = unpackedParam2.boostVisual;
      nextBoostAudio = unpackedParam2.boostAudio;
    }
  }
  if (extraLoadout && typeof extraLoadout === 'object') {
    if (extraLoadout.paintFinish !== undefined) {
      nextPaintFinish = decodePaintFinishIndex(extraLoadout.paintFinish);
    }
    if (extraLoadout.boostVisual !== undefined) {
      nextBoostVisual = decodeBoostVisualIndex(extraLoadout.boostVisual);
    }
    if (extraLoadout.boostAudio !== undefined) {
      nextBoostAudio = decodeBoostAudioIndex(extraLoadout.boostAudio);
    }
  }

  player.visualId = visualId;
  player.visualIndex = visualIndex;
  player.hitboxId = hitboxId;
  player.hitboxIndex = hitboxIndex;
  player.colorSlot = nextColorSlot;
  player.colorHex = resolveColorHexForSlot(nextColorSlot, player.team);
  player.paintFinish = nextPaintFinish;
  player.boostVisual = nextBoostVisual;
  player.boostAudio = nextBoostAudio;

  const canHotSwapNow =
    admin.state === MATCH_STATES.LOBBY ||
    admin.state === MATCH_STATES.PREPARE ||
    admin.state === MATCH_STATES.KICKOFF ||
    admin.isTrainingMode;

  if (canHotSwapNow && admin.physicsManager && player.entityId >= 0) {
    admin.physicsManager.applySignal('HOTSWAP_HITBOX', {
      carIndex: player.entityId,
      hitboxType: hitboxId
    });
    player.pendingVisualId = null;
  } else {
    player.pendingVisualId = hitboxId;
  }

  const packedLoadout = packLoadoutSignalParam2(visualIndex, nextColorSlot, hitboxIndex, {
    paintFinish: nextPaintFinish,
    boostVisual: nextBoostVisual,
    boostAudio: nextBoostAudio
  });
  admin.dispatchSignal(
    MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
    admin.matchTick,
    player.entityId,
    packedLoadout
  );
  broadcastRosterUpdate(admin);

  return player;
}

export function switchPlayerRoleOrTeam(admin, sessionId, targetRole, targetTeam = 0) {
  const currentPlayer = admin.players.get(sessionId);
  const currentSpec = admin.spectators.get(sessionId);
  const playerName = currentPlayer?.name || currentSpec?.name || 'Player';
  const visualId = currentPlayer?.visualId || 'fennec';
  const hitboxId = currentPlayer?.hitboxId || visualId;
  const colorSlot = currentPlayer?.colorSlot ?? resolveDefaultColorSlotForTeam(targetTeam);
  const paintFinish = currentPlayer?.paintFinish || 'metallic';
  const boostVisual = currentPlayer?.boostVisual || 'cartoon';
  const boostAudio = currentPlayer?.boostAudio || 'rush';

  if (targetRole === 'spectator' || targetRole === 2) {
    if (currentPlayer) {
      removeSessionPlayerSlot(admin, sessionId);
    }
    const specSlot = assignSessionPlayerSlot(admin, sessionId, playerName, 'spectator', null, {
      visualId,
      hitboxId,
      colorSlot,
      paintFinish,
      boostVisual,
      boostAudio
    });
    admin.dispatchSignal(
      MATCH_SIGNALS.PLAYER_SLOT_UPDATED,
      admin.matchTick,
      65535,
      PLAYER_ROLE_CODES.SPECTATOR
    );
    if (admin.dataHandler && sessionId && sessionId !== 'host') {
      admin.dataHandler.sendPacket(sessionId, JSON.stringify({
        type: 'handshake_response',
        entityId: -1,
        team: -1,
        role: 'spectator',
        roomId: admin.roomId,
        gameMode: admin.gameMode,
        matchTick: admin.matchTick,
        serverFrame: admin.matchTick,
        roster: buildRosterSnapshot(admin),
        state: admin.state,
        isHost: false
      }));
    }
    return specSlot;
  }

  const maxPerTeam = 5;
  let teamCount = 0;
  let targetTeamAutoFillBotSid = null;
  for (const [sid, p] of admin.players.entries()) {
    if (sid !== sessionId && p.team === targetTeam) {
      teamCount++;
      if (p.isBot && String(sid).startsWith('bot_fill_') && !targetTeamAutoFillBotSid) {
        targetTeamAutoFillBotSid = sid;
      }
    }
  }
  if (teamCount >= maxPerTeam && targetTeamAutoFillBotSid && !admin._applyingBotFillPolicy) {
    const prevApplying = admin._applyingBotFillPolicy;
    admin._applyingBotFillPolicy = true;
    try {
      removeSessionPlayerSlot(admin, targetTeamAutoFillBotSid);
      teamCount--;
    } finally {
      admin._applyingBotFillPolicy = prevApplying;
    }
  }
  if (teamCount >= maxPerTeam) {
    console.warn(`[MatchRosterCoordinator] Team ${targetTeam} is full (${teamCount}/${maxPerTeam}); keeping session "${sessionId}" in current slot.`);
    return currentPlayer || currentSpec || null;
  }

  if (currentPlayer && currentPlayer.team === targetTeam) {
    return currentPlayer;
  }

  let updated;
  if (currentPlayer && typeof currentPlayer.entityId === 'number' && currentPlayer.entityId >= 0) {
    const occupiedTargetSlots = new Set();
    for (const [sid, p] of admin.players.entries()) {
      if (sid !== sessionId && p.team === targetTeam) {
        occupiedTargetSlots.add(p.spawnSlot);
      }
    }
    let spawnSlot = 0;
    while (occupiedTargetSlots.has(spawnSlot) && spawnSlot < KICKOFF_SPAWN_PRESETS.length) {
      spawnSlot++;
    }
    const nextColorSlot = resolveDefaultColorSlotForTeam(targetTeam);
    currentPlayer.team = targetTeam;
    currentPlayer.spawnSlot = spawnSlot;
    currentPlayer.colorSlot = nextColorSlot;
    currentPlayer.colorHex = resolveColorHexForSlot(nextColorSlot, targetTeam);
    const s = admin.sessionManager?.getSession(sessionId);
    if (s) s.team = targetTeam;
    if (admin.physicsManager?.sim) {
      admin.physicsManager.sim.setCarTeam?.(currentPlayer.entityId, targetTeam);
      if (admin.state === MATCH_STATES.LOBBY || admin.state === MATCH_STATES.KICKOFF) {
        const preset = KICKOFF_SPAWN_PRESETS[spawnSlot] || KICKOFF_SPAWN_PRESETS[0];
        const presetCoord = targetTeam === 0 ? preset.team0 : preset.team1;
        if (presetCoord && typeof admin.physicsManager.sim.setCarState === 'function') {
          const cy = Math.cos(presetCoord.yaw);
          const sy = Math.sin(presetCoord.yaw);
          const carState = new Float32Array(CAR_STATE_STRIDE);
          carState[CAR_STATE_OFFSETS.POS] = presetCoord.x;
          carState[CAR_STATE_OFFSETS.POS + 1] = presetCoord.y;
          carState[CAR_STATE_OFFSETS.POS + 2] = presetCoord.z;
          carState[CAR_STATE_OFFSETS.FWD] = cy;
          carState[CAR_STATE_OFFSETS.FWD + 1] = sy;
          carState[CAR_STATE_OFFSETS.FWD + 2] = 0;
          carState[CAR_STATE_OFFSETS.RIGHT] = -sy;
          carState[CAR_STATE_OFFSETS.RIGHT + 1] = cy;
          carState[CAR_STATE_OFFSETS.RIGHT + 2] = 0;
          carState[CAR_STATE_OFFSETS.UP] = 0;
          carState[CAR_STATE_OFFSETS.UP + 1] = 0;
          carState[CAR_STATE_OFFSETS.UP + 2] = 1;
          carState[CAR_STATE_OFFSETS.BOOST] =
            admin.state === MATCH_STATES.LOBBY || admin.isTrainingMode ? 100.0 : 33.33;
          carState[CAR_STATE_OFFSETS.ON_GROUND] = 1;
          carState[CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = 1;
          admin.physicsManager.sim.setCarState(currentPlayer.entityId, carState);
        }
      }
    }
    admin.dispatchSignal(
      MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
      admin.matchTick,
      currentPlayer.entityId,
      packLoadoutSignalParam2(
        currentPlayer.visualIndex ?? encodeVisualIdIndex(currentPlayer.visualId || 'octane'),
        currentPlayer.colorSlot,
        currentPlayer.hitboxIndex ?? resolveHitboxIndex(currentPlayer.hitboxId || currentPlayer.visualId || 'octane'),
        {
          paintFinish: currentPlayer.paintFinish || 'metallic',
          boostVisual: currentPlayer.boostVisual || 'cartoon',
          boostAudio: currentPlayer.boostAudio || 'rush'
        }
      )
    );
    broadcastRosterUpdate(admin);
    updated = currentPlayer;
  } else {
    const prevApplying = admin._applyingBotFillPolicy;
    admin._applyingBotFillPolicy = true;
    try {
      if (currentSpec) {
        removeSessionPlayerSlot(admin, sessionId);
      }
      updated = assignSessionPlayerSlot(admin, sessionId, playerName, 'player', targetTeam, {
        visualId,
        hitboxId,
        colorSlot: resolveDefaultColorSlotForTeam(targetTeam),
        paintFinish,
        boostVisual,
        boostAudio
      });
    } finally {
      admin._applyingBotFillPolicy = prevApplying;
    }
  }

  if (
    !admin._applyingBotFillPolicy &&
    admin.state !== MATCH_STATES.LOBBY &&
    (admin.botFillMode === 'auto_fill' || admin.botFillMode === 'bots_vs_humans')
  ) {
    admin.applyBotFillPolicy?.();
  }

  if (updated && updated.entityId >= 0) {
    admin.dispatchSignal(
      MATCH_SIGNALS.PLAYER_SLOT_UPDATED,
      admin.matchTick,
      updated.entityId,
      updated.team
    );
    if (admin.dataHandler && sessionId && sessionId !== 'host') {
      admin.dataHandler.sendPacket(sessionId, JSON.stringify({
        type: 'handshake_response',
        entityId: updated.entityId,
        team: updated.team,
        spawnSlot: updated.spawnSlot,
        visualId: updated.visualId,
        visualIndex: updated.visualIndex,
        hitboxId: updated.hitboxId,
        hitboxIndex: updated.hitboxIndex,
        colorSlot: updated.colorSlot,
        colorHex: updated.colorHex,
        paintFinish: updated.paintFinish,
        boostVisual: updated.boostVisual,
        boostAudio: updated.boostAudio,
        roomId: admin.roomId,
        gameMode: admin.gameMode,
        matchTick: admin.matchTick,
        serverFrame: admin.matchTick,
        roster: buildRosterSnapshot(admin),
        state: admin.state,
        isHost: false
      }));
    }
  }
  return updated;
}
