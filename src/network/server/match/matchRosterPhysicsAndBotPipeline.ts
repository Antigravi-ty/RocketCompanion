/**
 * src/network/server/match/matchRosterPhysicsAndBotPipeline.ts
 * Pure data pipelines and narrow-interface helpers for bot loadout rolling,
 * bot fill policy execution, and roster car physics synchronization.
 */

import {
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  KICKOFF_SPAWN_PRESETS,
} from '../../../physics/RocketSimConstants.ts';
import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import {
  encodeVisualIdIndex,
  resolveHitboxIndex,
  packLoadoutSignalParam2,
} from '../../../ui-core/config/vehicleConstants';
import { rollRandomBotLoadout } from '../../../ui-core/config/botsLoadoutConfig';
import {
  MATCH_STATES,
  resolveTeamMatchedColorSlot,
  resolveColorHexForSlot,
  computeNormalizedTeamSpawnSlots,
  type MatchPlayerSlot,
} from './matchLoadoutAndSpawnPipeline.ts';

export function rollTeamBotLoadout(
  botsLoadoutConfig: any,
  players: Iterable<MatchPlayerSlot>,
  team = 0
): Record<string, any> {
  const teamNum = team === 1 ? 1 : 0;
  const usedColorSlots = new Set<number>();
  for (const p of players) {
    if ((p.team === 1 ? 1 : 0) === teamNum && typeof p.colorSlot === 'number') {
      usedColorSlots.add(p.colorSlot);
    }
  }
  return rollRandomBotLoadout(botsLoadoutConfig, teamNum, usedColorSlots);
}

export function buildSpawnPresetCarState(
  spawnSlot: number,
  team: number,
  boostAmount: number
): Float32Array | null {
  const preset = KICKOFF_SPAWN_PRESETS[spawnSlot] || KICKOFF_SPAWN_PRESETS[0];
  const presetCoord = team === 0 ? preset?.team0 : preset?.team1;
  if (!presetCoord) return null;
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
  carState[CAR_STATE_OFFSETS.BOOST] = boostAmount;
  carState[CAR_STATE_OFFSETS.ON_GROUND] = 1;
  carState[CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = 1;
  return carState;
}

export function syncRosterCarsWithPhysicsEngine(params: {
  players: Map<string, MatchPlayerSlot>;
  physicsManager: any;
  sessionManager: any;
  lobbyPhysicsActive: boolean;
}): void {
  const { players, physicsManager, sessionManager, lobbyPhysicsActive } = params;
  if (!physicsManager) return;
  const rosterEntityIds = new Set<number>();
  for (const [sid, p] of players.entries()) {
    if (typeof p.entityId !== 'number' || p.entityId < 0) continue;
    rosterEntityIds.add(p.entityId);
    const session = sessionManager?.getSession?.(sid);
    if (session) session.deferPhysicsRegistration = false;
    const physicsTeam = p.team === 1 ? 1 : 0;
    const hitboxOrVisual = p.hitboxId || p.visualId || 'octane';
    physicsManager.registerCarEntity(p.entityId, physicsTeam, hitboxOrVisual);
    physicsManager.applySignal('HOTSWAP_HITBOX', {
      carIndex: p.entityId,
      hitboxType: hitboxOrVisual,
    });
  }

  if (!lobbyPhysicsActive) {
    for (const activeIdx of Array.from(physicsManager.activeCarIndices as Iterable<number>)) {
      if (!rosterEntityIds.has(activeIdx)) {
        physicsManager.unregisterCarEntity(activeIdx);
      }
    }
    const sim = physicsManager.sim;
    if (sim && typeof sim.removeCar === 'function') {
      for (let slot = 0; slot < 8; slot++) {
        const isActive =
          typeof sim.isCarSlotActive === 'function' ? sim.isCarSlotActive(slot) : false;
        if (isActive && !rosterEntityIds.has(slot)) {
          physicsManager.unregisterCarEntity(slot);
        }
      }
    }
  }
}

export function registerAssignedPlayerWithSessionAndPhysics(params: {
  sessionId: string;
  playerInfo: MatchPlayerSlot;
  state: string;
  lobbyMode: boolean;
  isTrainingMode: boolean;
  matchTick: number;
  sessionManager: any;
  physicsManager: any;
  dispatchSignal: (type: number, frame: number, p1?: number, p2?: number) => any;
}): void {
  const {
    sessionId,
    playerInfo,
    state,
    lobbyMode,
    isTrainingMode,
    matchTick,
    sessionManager,
    physicsManager,
    dispatchSignal,
  } = params;

  const deferLobbyPhysics =
    state === MATCH_STATES.LOBBY && Boolean(lobbyMode || isTrainingMode) && sessionId !== 'host';

  sessionManager?.registerSession(sessionId, {
    role: 'player',
    entityId: playerInfo.entityId,
    team: playerInfo.team,
    visualId: playerInfo.visualId,
    hitboxId: playerInfo.hitboxId,
    deferPhysicsRegistration: deferLobbyPhysics,
    playerName: playerInfo.name,
  });

  if (!deferLobbyPhysics && physicsManager && playerInfo.entityId >= 0) {
    physicsManager.registerCarEntity(playerInfo.entityId, playerInfo.team, playerInfo.hitboxId);
    physicsManager.applySignal('HOTSWAP_HITBOX', {
      carIndex: playerInfo.entityId,
      hitboxType: playerInfo.hitboxId,
    });
    if (typeof physicsManager.sim?.getCarState === 'function') {
      const boostAmount = state === MATCH_STATES.LOBBY || isTrainingMode ? 100.0 : 33.33;
      const carState = buildSpawnPresetCarState(
        playerInfo.spawnSlot,
        playerInfo.team,
        boostAmount
      );
      if (carState) {
        physicsManager.sim.setCarState(playerInfo.entityId, carState);
      }
    }
    if (state === MATCH_STATES.LOBBY && physicsManager.lobbyGhostCoordinator?.lobbyModeActive) {
      physicsManager.syncLobbyGhostMasks?.();
    }
  }

  dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, matchTick, playerInfo.entityId, playerInfo.team);
  dispatchSignal(
    MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
    matchTick,
    playerInfo.entityId,
    packLoadoutSignalParam2(
      playerInfo.visualIndex,
      playerInfo.colorSlot,
      playerInfo.hitboxIndex,
      {
        paintFinish: playerInfo.paintFinish,
        boostVisual: playerInfo.boostVisual,
        boostAudio: playerInfo.boostAudio,
      }
    )
  );
}

export function applyLobbyExistingPlayerTeamSwitch(params: {
  sessionId: string;
  existing: MatchPlayerSlot;
  preferredTeam: number;
  requestedColorSlot?: number | null;
  players: Map<string, MatchPlayerSlot>;
  sessionManager: any;
  physicsManager: any;
  matchTick: number;
  dispatchSignal: (type: number, frame: number, p1?: number, p2?: number) => any;
}): void {
  const {
    sessionId,
    existing,
    preferredTeam,
    requestedColorSlot,
    players,
    sessionManager,
    physicsManager,
    matchTick,
    dispatchSignal,
  } = params;
  const occupiedTargetSlots = new Set<number>();
  for (const [sid, p] of players.entries()) {
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
  existing.colorSlot = resolveTeamMatchedColorSlot(
    requestedColorSlot ?? existing.colorSlot,
    existing.team,
    existing.blueColorSlot,
    existing.orangeColorSlot
  );
  existing.colorHex = resolveColorHexForSlot(existing.colorSlot, existing.team);
  const s = sessionManager?.getSession(sessionId);
  if (s) s.team = preferredTeam;
  if (physicsManager?.sim && typeof existing.entityId === 'number' && existing.entityId >= 0) {
    physicsManager.sim.setCarTeam?.(existing.entityId, preferredTeam);
  }
  computeNormalizedTeamSpawnSlots(players.values());
  if (typeof existing.entityId === 'number' && existing.entityId >= 0) {
    dispatchSignal(
      MATCH_SIGNALS.PLAYER_SLOT_UPDATED,
      matchTick,
      existing.entityId,
      existing.team
    );
  }
}

export function applyInPlacePlayerTeamSwitch(params: {
  sessionId: string;
  currentPlayer: MatchPlayerSlot;
  targetTeam: number;
  players: Map<string, MatchPlayerSlot>;
  state: string;
  isTrainingMode: boolean;
  matchTick: number;
  sessionManager: any;
  physicsManager: any;
  dispatchSignal: (type: number, frame: number, p1?: number, p2?: number) => any;
}): MatchPlayerSlot {
  const {
    sessionId,
    currentPlayer,
    targetTeam,
    players,
    state,
    isTrainingMode,
    matchTick,
    sessionManager,
    physicsManager,
    dispatchSignal,
  } = params;

  const physicsTeam = targetTeam === 1 ? 1 : 0;
  const occupiedTargetSlots = new Set<number>();
  for (const [sid, p] of players.entries()) {
    if (sid !== sessionId && (p.team === 1 ? 1 : 0) === physicsTeam) {
      occupiedTargetSlots.add(p.spawnSlot);
    }
  }
  let spawnSlot = 0;
  while (occupiedTargetSlots.has(spawnSlot) && spawnSlot < KICKOFF_SPAWN_PRESETS.length) {
    spawnSlot++;
  }
  currentPlayer.team = targetTeam;
  currentPlayer.preferredTeam = targetTeam;
  currentPlayer.spawnSlot = spawnSlot;
  if (targetTeam === 0 || targetTeam === 1) {
    const nextColorSlot = resolveTeamMatchedColorSlot(
      null,
      targetTeam,
      currentPlayer.blueColorSlot,
      currentPlayer.orangeColorSlot
    );
    currentPlayer.colorSlot = nextColorSlot;
    currentPlayer.colorHex = resolveColorHexForSlot(nextColorSlot, targetTeam);
  }
  const s = sessionManager?.getSession(sessionId);
  if (s) s.team = targetTeam;

  if (
    state !== MATCH_STATES.LOBBY &&
    physicsManager?.sim &&
    (targetTeam === 0 || targetTeam === 1)
  ) {
    physicsManager.sim.setCarTeam?.(currentPlayer.entityId, targetTeam);
    if (state === MATCH_STATES.KICKOFF && typeof physicsManager.sim.setCarState === 'function') {
      const carState = buildSpawnPresetCarState(
        spawnSlot,
        targetTeam,
        isTrainingMode ? 100.0 : 33.33
      );
      if (carState) {
        physicsManager.sim.setCarState(currentPlayer.entityId, carState);
      }
    }
  }

  dispatchSignal(
    MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
    matchTick,
    currentPlayer.entityId,
    packLoadoutSignalParam2(
      currentPlayer.visualIndex ?? encodeVisualIdIndex(currentPlayer.visualId || 'octane'),
      currentPlayer.colorSlot,
      currentPlayer.hitboxIndex ??
        resolveHitboxIndex(currentPlayer.hitboxId || currentPlayer.visualId || 'octane'),
      {
        paintFinish: currentPlayer.paintFinish || 'metallic',
        boostVisual: currentPlayer.boostVisual || 'cartoon',
        boostAudio: currentPlayer.boostAudio || 'rush',
      }
    )
  );
  return currentPlayer;
}

export function executeBotFillPolicyOnRoster(params: {
  players: Map<string, MatchPlayerSlot>;
  botFillMode: string;
  maxPlayers: number;
  botsLoadoutConfig: any;
  removePlayerSession: (sid: string) => void;
  switchPlayerRoleOrTeam: (sid: string, role: string, team: number) => any;
  assignPlayerSlot: (
    sid: string,
    name: string,
    role: string,
    team: number,
    loadout: any,
    colorSlot: any
  ) => any;
}): void {
  const {
    players,
    botFillMode,
    maxPlayers,
    botsLoadoutConfig,
    removePlayerSession,
    switchPlayerRoleOrTeam,
    assignPlayerSlot,
  } = params;

  const maxPerTeam = Math.max(1, Math.floor(maxPlayers / 2));

  for (const [sid, p] of Array.from(players.entries())) {
    if (p.isBot && String(sid).startsWith('bot_fill_')) {
      removePlayerSession(sid);
    }
  }

  let humanBlue = 0;
  let humanOrange = 0;
  for (const p of players.values()) {
    if (!p.isBot) {
      if (p.team === 0) humanBlue++;
      else if (p.team === 1) humanOrange++;
    }
  }
  for (const [sid, p] of Array.from(players.entries())) {
    if (!p.isBot && (p.team === 2 || (p.team !== 0 && p.team !== 1))) {
      const resolvedTeam =
        botFillMode === 'bots_vs_humans' ? 0 : humanBlue <= humanOrange ? 0 : 1;
      if (resolvedTeam === 0) humanBlue++;
      else humanOrange++;
      switchPlayerRoleOrTeam(sid, 'player', resolvedTeam);
    }
  }

  if (botFillMode === 'no_bots') {
    for (const [sid, p] of Array.from(players.entries())) {
      if (p.isBot && sid !== 'bot') {
        removePlayerSession(sid);
      }
    }
    return;
  }

  if (botFillMode === 'custom') return;

  if (botFillMode === 'bots_vs_humans') {
    for (const [sid, p] of Array.from(players.entries())) {
      if (!p.isBot && p.team !== 0) {
        switchPlayerRoleOrTeam(sid, 'player', 0);
      }
    }
    let orangeCount = 0;
    for (const p of players.values()) {
      if (p.team === 1) orangeCount++;
    }
    let fillSeq = 1;
    while (orangeCount < maxPerTeam && players.size < maxPlayers) {
      const sid = `bot_fill_${fillSeq}`;
      const rolled = rollTeamBotLoadout(botsLoadoutConfig, players.values(), 1);
      assignPlayerSlot(sid, `Nexto #${fillSeq}`, 'player', 1, rolled, rolled.colorSlot);
      fillSeq++;
      orangeCount++;
    }
    return;
  }

  if (botFillMode === 'auto_fill') {
    let blueCount = 0;
    let orangeCount = 0;
    for (const p of players.values()) {
      if (p.team === 0) blueCount++;
      else if (p.team === 1) orangeCount++;
    }
    let fillSeq = 1;
    while (blueCount < maxPerTeam && players.size < maxPlayers) {
      const sid = `bot_fill_${fillSeq}`;
      const rolled = rollTeamBotLoadout(botsLoadoutConfig, players.values(), 0);
      assignPlayerSlot(sid, `Nexto #${fillSeq}`, 'player', 0, rolled, rolled.colorSlot);
      fillSeq++;
      blueCount++;
    }
    while (orangeCount < maxPerTeam && players.size < maxPlayers) {
      const sid = `bot_fill_${fillSeq}`;
      const rolled = rollTeamBotLoadout(botsLoadoutConfig, players.values(), 1);
      assignPlayerSlot(sid, `Nexto #${fillSeq}`, 'player', 1, rolled, rolled.colorSlot);
      fillSeq++;
      orangeCount++;
    }
  }
}

export function popReclaimedPlayerSlotCandidate(
  disconnectedPlayerSlots: Map<number, any>,
  players: Iterable<MatchPlayerSlot>,
  requestedEntityId: number
): { reclaimed: any | null; entityId: number } {
  let reclaimed: any | null = null;
  if (disconnectedPlayerSlots.size > 0) {
    if (
      typeof requestedEntityId === 'number' &&
      requestedEntityId >= 0 &&
      disconnectedPlayerSlots.has(requestedEntityId)
    ) {
      reclaimed = disconnectedPlayerSlots.get(requestedEntityId) || null;
      disconnectedPlayerSlots.delete(requestedEntityId);
    } else {
      const firstEntry = disconnectedPlayerSlots.entries().next().value;
      if (firstEntry) {
        reclaimed = firstEntry[1];
        disconnectedPlayerSlots.delete(firstEntry[0]);
      }
    }
  }
  if (!reclaimed) return { reclaimed: null, entityId: -1 };

  const usedEntityIds = new Set(Array.from(players).map((p) => p.entityId));
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
  return { reclaimed, entityId };
}

