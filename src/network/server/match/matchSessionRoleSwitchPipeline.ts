/**
 * src/network/server/match/matchSessionRoleSwitchPipeline.ts
 * Narrow-interface pipeline for player/spectator handshake packet construction,
 * disconnected slot reclamation, session removal, and role/team switching.
 */

import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import {
  PLAYER_ROLE_CODES,
  encodeVisualIdIndex,
  packLoadoutSignalParam2,
} from '../../../ui-core/config/vehicleConstants';
import { KICKOFF_SPAWN_PRESETS } from '../../../physics/RocketSimConstants.ts';
import {
  MATCH_STATES,
  isColorSlotValidForTeam,
  resolveTeamMatchedColorSlot,
  resolveDefaultColorSlotForTeam,
  resolveColorHexForSlot,
  type MatchPlayerSlot,
  type MatchSpectatorSlot,
  type DisconnectedPlayerSlot,
  type NormalizedSlotLoadoutResult,
  type PlayerLoadoutOptions,
  type RosterSnapshot,
} from './matchLoadoutAndSpawnPipeline.ts';
import {
  popReclaimedPlayerSlotCandidate,
  type RosterPhysicsManagerPort,
  type RosterSessionPort,
  type SignalDispatchFn,
} from './matchRosterPhysicsAndBotPipeline.ts';

export interface RoleSwitchDataHandlerPort {
  sendPacket: (sessionId: string, packet: string | Uint8Array) => void;
}

export function resolveCosmeticsPatchForExistingPlayerSlot(
  existing: MatchPlayerSlot,
  resolved: NormalizedSlotLoadoutResult
): Partial<MatchPlayerSlot> {
  const {
    normalizedLoadout, requestedVisual, requestedHitboxIndex, requestedHitboxId,
    requestedPaintFinish, requestedBoostVisual, requestedBoostAudio,
  } = resolved;

  const patch: Partial<MatchPlayerSlot> = {};
  if (normalizedLoadout.visualId !== undefined || normalizedLoadout.visualIndex !== undefined) {
    patch.visualId = requestedVisual;
    patch.visualIndex = encodeVisualIdIndex(requestedVisual);
  }
  if (normalizedLoadout.hitboxId !== undefined || normalizedLoadout.hitboxIndex !== undefined) {
    patch.hitboxId = requestedHitboxId;
    patch.hitboxIndex = requestedHitboxIndex;
  }
  if (typeof normalizedLoadout.colorSlot === 'number') {
    const colorSlot = resolveTeamMatchedColorSlot(
      normalizedLoadout.colorSlot, existing.team, existing.blueColorSlot, existing.orangeColorSlot
    );
    patch.colorSlot = colorSlot;
    if (existing.team === 0) patch.blueColorSlot = colorSlot;
    else if (existing.team === 1) patch.orangeColorSlot = colorSlot;
    patch.colorHex = resolveColorHexForSlot(colorSlot, existing.team);
  }
  if (normalizedLoadout.paintFinish !== undefined) patch.paintFinish = requestedPaintFinish;
  if (normalizedLoadout.boostVisual !== undefined) patch.boostVisual = requestedBoostVisual;
  if (normalizedLoadout.boostAudio !== undefined) patch.boostAudio = requestedBoostAudio;
  if (normalizedLoadout.anthemId !== undefined) patch.anthemId = String(normalizedLoadout.anthemId);
  return patch;
}

export function createNewPlayerSlotInfo(
  sessionId: string,
  playerName: string,
  preferredTeam: number | null,
  currentPlayers: Iterable<MatchPlayerSlot>,
  resolved: NormalizedSlotLoadoutResult,
  isBotSession: boolean
): MatchPlayerSlot {
  const {
    normalizedLoadout, requestedVisual, requestedHitboxIndex, requestedHitboxId,
    requestedPaintFinish, requestedBoostVisual, requestedBoostAudio, requestedAnthemId,
  } = resolved;

  let team0Count = 0;
  let team1Count = 0;
  const occupiedSlotsTeam0 = new Set<number>();
  const occupiedSlotsTeam1 = new Set<number>();
  const usedEntityIds = new Set<number>();

  for (const p of currentPlayers) {
    usedEntityIds.add(p.entityId);
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
    assignedTeam = team0Count <= team1Count ? 0 : 1;
  }

  let spawnSlot = 0;
  const targetOccupied = assignedTeam === 0 ? occupiedSlotsTeam0 : occupiedSlotsTeam1;
  while (targetOccupied.has(spawnSlot) && spawnSlot < KICKOFF_SPAWN_PRESETS.length) {
    spawnSlot++;
  }

  let assignedEntityId = -1;
  for (let i = 0; i < 6; i++) {
    if (!usedEntityIds.has(i)) {
      assignedEntityId = i;
      break;
    }
  }

  const visualIndex = encodeVisualIdIndex(requestedVisual);
  const blueColorSlot = isColorSlotValidForTeam(normalizedLoadout.blueColorSlot, 0)
    ? normalizedLoadout.blueColorSlot!
    : isColorSlotValidForTeam(normalizedLoadout.colorSlot, 0)
      ? normalizedLoadout.colorSlot!
      : null;
  const orangeColorSlot = isColorSlotValidForTeam(normalizedLoadout.orangeColorSlot, 1)
    ? normalizedLoadout.orangeColorSlot!
    : isColorSlotValidForTeam(normalizedLoadout.colorSlot, 1)
      ? normalizedLoadout.colorSlot!
      : null;
  const colorSlot = resolveTeamMatchedColorSlot(
    normalizedLoadout.colorSlot, assignedTeam, blueColorSlot, orangeColorSlot
  );
  const colorHex = resolveColorHexForSlot(colorSlot, assignedTeam);

  return {
    sessionId, entityId: assignedEntityId, carIndex: assignedEntityId, team: assignedTeam,
    name: playerName, role: 'player', spawnSlot, visualId: requestedVisual, visualIndex,
    hitboxId: requestedHitboxId, hitboxIndex: requestedHitboxIndex, colorSlot,
    blueColorSlot: assignedTeam === 0 ? colorSlot : blueColorSlot,
    orangeColorSlot: assignedTeam === 1 ? colorSlot : orangeColorSlot,
    colorHex, paintFinish: requestedPaintFinish, boostVisual: requestedBoostVisual,
    boostAudio: requestedBoostAudio, anthemId: requestedAnthemId,
    ready: isBotSession || sessionId === 'host',
    arenaLoaded: isBotSession || sessionId === 'host',
    isBot: isBotSession,
  };
}

export function buildPlayerHandshakePacketJson(params: {
  player: MatchPlayerSlot;
  roomId: string;
  gameMode: string;
  botFillMode: string;
  clockDuration: number;
  clockSecondsRemaining: number;
  blueScore: number;
  orangeScore: number;
  matchTick: number;
  state: string;
  roster: RosterSnapshot;
  initialSnapshot?: number[] | null;
}): string {
  const { player } = params;
  return JSON.stringify({
    type: 'handshake_response',
    entityId: player.entityId,
    team: player.team,
    preferredTeam: player.preferredTeam ?? player.team,
    spawnSlot: player.spawnSlot,
    visualId: player.visualId,
    visualIndex: player.visualIndex,
    hitboxId: player.hitboxId,
    hitboxIndex: player.hitboxIndex,
    colorSlot: player.colorSlot,
    colorHex: player.colorHex,
    paintFinish: player.paintFinish,
    boostVisual: player.boostVisual,
    boostAudio: player.boostAudio,
    roomId: params.roomId,
    gameMode: params.gameMode,
    botFillMode: params.botFillMode,
    durationSeconds: params.clockDuration,
    clockSeconds: params.clockSecondsRemaining,
    score: { blue: params.blueScore ?? 0, orange: params.orangeScore ?? 0 },
    matchTick: params.matchTick,
    serverFrame: params.matchTick,
    roster: params.roster,
    state: params.state,
    isHost: false,
    ...(params.initialSnapshot !== undefined ? { initialSnapshot: params.initialSnapshot } : {}),
  });
}

export function buildSpectatorHandshakePacketJson(params: {
  roomId: string;
  gameMode: string;
  matchTick: number;
  state: string;
  roster: RosterSnapshot;
}): string {
  return JSON.stringify({
    type: 'handshake_response',
    entityId: -1,
    team: -1,
    role: 'spectator',
    roomId: params.roomId,
    gameMode: params.gameMode,
    matchTick: params.matchTick,
    serverFrame: params.matchTick,
    roster: params.roster,
    state: params.state,
    isHost: false,
  });
}

export function executePlayerSessionRemoval(params: {
  sessionId: string;
  players: Map<string, MatchPlayerSlot>;
  spectators: Map<string, MatchSpectatorSlot>;
  disconnectedPlayerSlots: Map<number, DisconnectedPlayerSlot>;
  matchTick: number;
  shouldRunActiveMatchBotFill: boolean;
  applyingBotFillPolicy: boolean;
  sessionManager: RosterSessionPort | null | undefined;
  physicsManager: RosterPhysicsManagerPort | null | undefined;
  dispatchSignal: SignalDispatchFn;
  onPlayerSessionRemoved: (sessionId: string) => void;
  applyBotFillPolicy: () => void;
  broadcastRosterUpdate: () => void;
}): void {
  const {
    sessionId, players, spectators, disconnectedPlayerSlots, matchTick,
    shouldRunActiveMatchBotFill, applyingBotFillPolicy, sessionManager, physicsManager,
  } = params;

  const player = players.get(sessionId);
  if (player) {
    const entityId = player.entityId;
    const wasHuman = !player.isBot;
    if (wasHuman && entityId >= 0) {
      disconnectedPlayerSlots.set(entityId, { ...player, disconnectedAtTick: matchTick });
    }
    players.delete(sessionId);
    sessionManager?.unregisterSession?.(sessionId);
    if (physicsManager && entityId >= 0) {
      physicsManager.unregisterCarEntity(entityId);
    }
    params.dispatchSignal(MATCH_SIGNALS.PLAYER_LEFT, matchTick, entityId, player.team ?? 0);
    params.onPlayerSessionRemoved(sessionId);
    if (wasHuman && !applyingBotFillPolicy && shouldRunActiveMatchBotFill) {
      params.applyBotFillPolicy();
    }
    params.broadcastRosterUpdate();
    return;
  }

  if (spectators.has(sessionId)) {
    spectators.delete(sessionId);
    sessionManager?.unregisterSession?.(sessionId);
    params.dispatchSignal(MATCH_SIGNALS.PLAYER_LEFT, matchTick, -1, 2);
    params.broadcastRosterUpdate();
  }
}

export function executePlayerSessionReclaim(params: {
  sessionId: string;
  requestedEntityId: number;
  preferredTeam: number | null;
  players: Map<string, MatchPlayerSlot>;
  spectators: Map<string, MatchSpectatorSlot>;
  disconnectedPlayerSlots: Map<number, DisconnectedPlayerSlot>;
  matchTick: number;
  sessionManager: RosterSessionPort | null | undefined;
  physicsManager: RosterPhysicsManagerPort | null | undefined;
  assignPlayerSlot: (
    sessionId: string,
    playerName: string,
    role: string,
    preferredTeam?: number | null
  ) => MatchPlayerSlot | MatchSpectatorSlot | null;
  dispatchSignal: SignalDispatchFn;
  broadcastRosterUpdate: () => void;
}): MatchPlayerSlot | MatchSpectatorSlot | null | undefined {
  const {
    sessionId, requestedEntityId, preferredTeam, players, spectators,
    disconnectedPlayerSlots, matchTick, sessionManager, physicsManager,
  } = params;

  if (players.has(sessionId)) return players.get(sessionId);
  const { reclaimed, entityId } = popReclaimedPlayerSlotCandidate(
    disconnectedPlayerSlots, players.values(), requestedEntityId
  );
  if (!reclaimed) return params.assignPlayerSlot(sessionId, 'Player', 'player', preferredTeam);
  if (entityId < 0) {
    return params.assignPlayerSlot(sessionId, reclaimed.name || 'Player', 'spectator');
  }

  if (spectators.has(sessionId)) spectators.delete(sessionId);

  const playerInfo: MatchPlayerSlot = {
    ...reclaimed, sessionId, entityId, carIndex: entityId,
    ready: true, arenaLoaded: true, isBot: false,
  };
  players.set(sessionId, playerInfo);
  sessionManager?.registerSession(sessionId, {
    role: 'player', entityId, team: playerInfo.team,
    visualId: playerInfo.visualId, hitboxId: playerInfo.hitboxId,
    deferPhysicsRegistration: false, playerName: playerInfo.name,
  });

  if (physicsManager) {
    const hitboxOrVisual = playerInfo.hitboxId || playerInfo.visualId || 'octane';
    physicsManager.registerCarEntity(entityId, playerInfo.team, hitboxOrVisual);
    physicsManager.applySignal('HOTSWAP_HITBOX', {
      carIndex: entityId, hitboxType: hitboxOrVisual,
    });
  }

  params.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, matchTick, entityId, playerInfo.team);
  params.dispatchSignal(MATCH_SIGNALS.PLAYER_SLOT_UPDATED, matchTick, entityId, playerInfo.team);
  params.dispatchSignal(
    MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
    matchTick,
    entityId,
    packLoadoutSignalParam2(
      playerInfo.visualIndex ?? playerInfo.visualId,
      playerInfo.colorSlot,
      playerInfo.hitboxIndex ?? playerInfo.hitboxId,
      {
        paintFinish: playerInfo.paintFinish || 'metallic',
        boostVisual: playerInfo.boostVisual || 'cartoon',
        boostAudio: playerInfo.boostAudio || 'rush',
      }
    )
  );
  params.broadcastRosterUpdate();
  return playerInfo;
}

export function executePlayerRoleOrTeamSwitch(params: {
  sessionId: string;
  targetRole: string | number;
  targetTeam: number;
  players: Map<string, MatchPlayerSlot>;
  spectators: Map<string, MatchSpectatorSlot>;
  matchTick: number;
  state: string;
  shouldRunActiveMatchBotFill: boolean;
  dataHandler: RoleSwitchDataHandlerPort | null | undefined;
  isApplyingBotFillPolicy: () => boolean;
  setApplyingBotFillPolicy: (value: boolean) => void;
  removePlayerSession: (sessionId: string) => void;
  assignPlayerSlot: (
    sessionId: string,
    playerName: string,
    role: string,
    preferredTeam: number | null,
    loadoutOptions: PlayerLoadoutOptions
  ) => MatchPlayerSlot | MatchSpectatorSlot | null;
  applyInPlaceTeamSwitch: (currentPlayer: MatchPlayerSlot, targetTeam: number) => MatchPlayerSlot;
  applyBotFillPolicy: () => void;
  buildHandshakePacketJson: (player: MatchPlayerSlot | null) => string;
  broadcastRosterUpdate: () => void;
  dispatchSignal: SignalDispatchFn;
}): MatchPlayerSlot | MatchSpectatorSlot | null {
  const {
    sessionId, targetRole, targetTeam, players, spectators, matchTick, state,
    shouldRunActiveMatchBotFill, dataHandler,
  } = params;

  const currentPlayer = players.get(sessionId);
  const currentSpec = spectators.get(sessionId);
  const playerName = currentPlayer?.name || currentSpec?.name || 'Player';
  const visualId = currentPlayer?.visualId || 'fennec';
  const hitboxId = currentPlayer?.hitboxId || visualId;
  const colorSlot = currentPlayer?.colorSlot ?? resolveDefaultColorSlotForTeam(targetTeam);
  const paintFinish = currentPlayer?.paintFinish || 'metallic';
  const boostVisual = currentPlayer?.boostVisual || 'cartoon';
  const boostAudio = currentPlayer?.boostAudio || 'rush';

  if (targetRole === 'spectator' || targetRole === 2) {
    if (currentPlayer) params.removePlayerSession(sessionId);
    const specSlot = params.assignPlayerSlot(sessionId, playerName, 'spectator', null, {
      visualId, hitboxId, colorSlot, paintFinish, boostVisual, boostAudio,
    });
    params.dispatchSignal(
      MATCH_SIGNALS.PLAYER_SLOT_UPDATED, matchTick, 65535, PLAYER_ROLE_CODES.SPECTATOR
    );
    if (dataHandler && sessionId && sessionId !== 'host') {
      dataHandler.sendPacket(sessionId, params.buildHandshakePacketJson(null));
    }
    return specSlot;
  }

  const maxPerTeam = 5;
  let teamCount = 0;
  let targetTeamAutoFillBotSid: string | null = null;
  if (targetTeam === 0 || targetTeam === 1) {
    for (const [sid, p] of players.entries()) {
      if (sid !== sessionId && p.team === targetTeam) {
        teamCount++;
        if (p.isBot && String(sid).startsWith('bot_fill_') && !targetTeamAutoFillBotSid) {
          targetTeamAutoFillBotSid = sid;
        }
      }
    }
    if (teamCount >= maxPerTeam && targetTeamAutoFillBotSid && !params.isApplyingBotFillPolicy()) {
      const prevApplying = params.isApplyingBotFillPolicy();
      params.setApplyingBotFillPolicy(true);
      try {
        params.removePlayerSession(targetTeamAutoFillBotSid);
        teamCount--;
      } finally {
        params.setApplyingBotFillPolicy(prevApplying);
      }
    }
    if (teamCount >= maxPerTeam) return currentPlayer || currentSpec || null;
  }

  if (currentPlayer && currentPlayer.team === targetTeam) return currentPlayer;

  let updated: MatchPlayerSlot | MatchSpectatorSlot | null = null;
  const hadValidEntitySlot = Boolean(
    currentPlayer && typeof currentPlayer.entityId === 'number' && currentPlayer.entityId >= 0
  );
  if (hadValidEntitySlot && currentPlayer) {
    updated = params.applyInPlaceTeamSwitch(currentPlayer, targetTeam);
    params.broadcastRosterUpdate();
  } else {
    const prevApplying = params.isApplyingBotFillPolicy();
    params.setApplyingBotFillPolicy(true);
    try {
      if (currentSpec) params.removePlayerSession(sessionId);
      updated = params.assignPlayerSlot(sessionId, playerName, 'player', targetTeam, {
        visualId, hitboxId,
        colorSlot: resolveDefaultColorSlotForTeam(targetTeam === 1 ? 1 : 0),
        paintFinish, boostVisual, boostAudio,
      });
    } finally {
      params.setApplyingBotFillPolicy(prevApplying);
    }
  }

  if (!params.isApplyingBotFillPolicy() && shouldRunActiveMatchBotFill) {
    params.applyBotFillPolicy();
  }

  if (updated && 'entityId' in updated && updated.entityId >= 0) {
    if (state !== MATCH_STATES.LOBBY || !hadValidEntitySlot) {
      params.dispatchSignal(
        MATCH_SIGNALS.PLAYER_SLOT_UPDATED, matchTick, updated.entityId, updated.team === 1 ? 1 : 0
      );
    }
    if (!hadValidEntitySlot && dataHandler && sessionId && sessionId !== 'host') {
      dataHandler.sendPacket(sessionId, params.buildHandshakePacketJson(updated));
    }
  }
  return updated;
}
