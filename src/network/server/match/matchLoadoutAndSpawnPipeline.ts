/**
 * src/network/server/match/matchLoadoutAndSpawnPipeline.ts
 * Pure data pipelines and constants for server match state, color/loadout resolution,
 * kickoff spawn placement, RTT aggregation, and roster snapshot assembly.
 */

import {
  CAR_STATE_OFFSETS, CAR_STATE_STRIDE, KICKOFF_SPAWN_PRESETS,
} from '../../../physics/RocketSimConstants.ts';
import {
  CAR_COLOR_SLOTS, encodeVisualIdIndex, decodeVisualIdIndex,
  encodeHitboxIdIndex, resolveHitboxIndex, decodeHitboxIndex,
  decodePaintFinishIndex, decodeBoostVisualIndex, decodeBoostAudioIndex,
  getCarColorSlotById, packLoadoutSignalParam2,
  unpackLoadoutCommandParam1, unpackLoadoutCommandParam2,
} from '../../../ui-core/config/vehicleConstants';

export const MATCH_TICK_RATE = 120;
export const DEFAULT_MATCH_DURATION_SECONDS = 300;
export const KICKOFF_COUNTDOWN_SECONDS = 3;
export const KICKOFF_TOTAL_TICKS = 480; // 4.0s @ 120Hz (1s buffer + 3s countdown)
export const GOAL_CELEBRATION_TICKS = 360; // 3.0s @ 120Hz
export const GOAL_REPLAY_DURATION_TICKS = 360; // 3.0s @ 120Hz
export const PAUSE_RESUME_COUNTDOWN_TICKS = 600; // 5.0s @ 120Hz
export const DEFAULT_MAX_OVERTIME_SECONDS = 360; // 6 min clock before possession tie-breaker

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
  PODIUM: 'podium',
});

export type MatchState = (typeof MATCH_STATES)[keyof typeof MATCH_STATES];

export interface PlayerLoadoutOptions {
  visualId?: string | number;
  visualIndex?: number;
  hitboxId?: string | number | null;
  hitboxIndex?: number | null;
  colorSlot?: number | null;
  blueColorSlot?: number | null;
  orangeColorSlot?: number | null;
  paintFinish?: string | number;
  boostVisual?: string | number;
  boostAudio?: string | number;
  anthemId?: string;
}

export type ExtraLoadoutConfig = PlayerLoadoutOptions;

export interface MatchPlayerSlot {
  sessionId: string;
  entityId: number;
  carIndex: number;
  team: number;
  preferredTeam?: number;
  name: string;
  role: string;
  spawnSlot: number;
  visualId: string;
  visualIndex: number;
  hitboxId: string;
  hitboxIndex: number;
  colorSlot: number;
  blueColorSlot: number | null;
  orangeColorSlot: number | null;
  colorHex: string;
  paintFinish: string;
  boostVisual: string;
  boostAudio: string;
  anthemId: string;
  ready: boolean;
  arenaLoaded: boolean;
  isBot: boolean;
  botType?: string;
  pendingVisualId?: string | null;
  pingMs?: number;
}

export interface DisconnectedPlayerSlot extends MatchPlayerSlot {
  disconnectedAtTick: number;
}

export interface MatchSpectatorSlot {
  sessionId: string;
  name: string;
  role: 'spectator';
  ready: boolean;
  arenaLoaded: boolean;
  pingMs?: number;
}

export interface ActiveMatchSignal {
  signalId: number;
  signalType: number;
  frameId: number;
  param1: number;
  param2: number;
  ackedPeers: Set<string>;
  remainingRedundancy: number;
}

export interface ReplaySignalLogEntry {
  signalId: number;
  signalType: number;
  frameId: number;
  param1: number;
  param2: number;
  frameIndex: number;
  recordedAt: number;
}

export interface UserRttSummary {
  players: Array<number | null>;
  spectators: Array<{ id: number; rtt: number }>;
}

export interface MatchRosterMetadataEntry {
  carIndex: number;
  entityId: number;
  sessionId: string;
  name: string;
  team: number;
  role: string;
  isBot: boolean;
  visualId: string;
  visualIndex: number;
  hitboxId: string;
  hitboxIndex: number;
  colorSlot: number;
  colorHex: string;
  paintFinish: string;
  boostVisual: string;
  boostAudio: string;
  anthemId: string;
}

export interface RosterSnapshotPlayerEntry {
  sessionId: string; entityId: number; carIndex: number; team: number; preferredTeam: number;
  name: string; spawnSlot: number; visualId: string; visualIndex: number; hitboxId: string;
  hitboxIndex: number; colorSlot: number; colorHex: string | null; paintFinish: string;
  boostVisual: string; boostAudio: string; anthemId: string; isBot: boolean;
  ready: boolean; arenaLoaded: boolean; pingMs: number;
}

export interface RosterSnapshotSpectatorEntry {
  sessionId: string; name: string; role: 'spectator'; pingMs: number;
}

export interface RosterSnapshot {
  players: RosterSnapshotPlayerEntry[];
  spectators: RosterSnapshotSpectatorEntry[];
  gameMode: string;
  botFillMode: string;
  durationSeconds: number;
  clockSeconds: number;
  score: { blue: number; orange: number };
}

export interface RosterSessionEntryPort {
  role?: string;
  entityId: number;
  team?: number;
  playerName?: string;
  rttMs?: number;
  deferPhysicsRegistration?: boolean;
}

export interface RosterSessionManagerPort {
  getSession?: (sessionId: string) => RosterSessionEntryPort | null | undefined;
  getAllSessions?: () => Iterable<RosterSessionEntryPort>;
}

export interface SimSpawnPort {
  setCarState?: (carIndex: number, state: Float32Array) => void;
  setCarTeam?: (carIndex: number, team: number) => void;
}

export interface RosterSnapshotSource {
  players: Map<string, MatchPlayerSlot>;
  spectators: Map<string, MatchSpectatorSlot>;
  sessionManager?: RosterSessionManagerPort | null;
  gameMode: string;
  botFillMode: string;
  clockDuration: number;
  clockSecondsRemaining: number;
  blueScore?: number;
  orangeScore?: number;
}

export function resolveDefaultColorSlotForTeam(team: number): number {
  return team === 0 ? 3 : 0; // 3 = Sky Blue, 0 = Flame Red
}

export function isColorSlotValidForTeam(colorSlot: unknown, team: number): colorSlot is number {
  if (typeof colorSlot !== 'number' || colorSlot < 0 || colorSlot >= CAR_COLOR_SLOTS.length) {
    return false;
  }
  if (team !== 0 && team !== 1) return true;
  const slotObj =
    CAR_COLOR_SLOTS[colorSlot] || CAR_COLOR_SLOTS.find((s: { id: number; team: number }) => s.id === colorSlot);
  return Boolean(slotObj && slotObj.team === team);
}

export function resolveTeamMatchedColorSlot(
  requestedColorSlot: unknown,
  assignedTeam = 0,
  blueColorSlot: number | null = null,
  orangeColorSlot: number | null = null
): number {
  const normalizedTeam = assignedTeam === 1 ? 1 : 0;
  if (isColorSlotValidForTeam(requestedColorSlot, normalizedTeam)) {
    return requestedColorSlot;
  }
  const teamPreferred = normalizedTeam === 0 ? blueColorSlot : orangeColorSlot;
  if (isColorSlotValidForTeam(teamPreferred, normalizedTeam)) {
    return teamPreferred;
  }
  return resolveDefaultColorSlotForTeam(normalizedTeam);
}

export function resolveColorHexForSlot(colorSlot: unknown, team = 0): string {
  const normalizedTeam = team === 1 ? 1 : 0;
  if (isColorSlotValidForTeam(colorSlot, normalizedTeam)) {
    const slotObj = getCarColorSlotById(colorSlot);
    if (slotObj?.hex) return slotObj.hex;
  }
  const fallbackSlot = resolveDefaultColorSlotForTeam(normalizedTeam);
  return (
    getCarColorSlotById(fallbackSlot)?.hex || (normalizedTeam === 0 ? '#42a5f5' : '#ff7043')
  );
}

export interface NormalizedSlotLoadoutResult {
  normalizedLoadout: PlayerLoadoutOptions;
  requestedVisual: string;
  visualIndex: number;
  requestedHitboxId: string;
  requestedHitboxIndex: number;
  requestedPaintFinish: string;
  requestedBoostVisual: string;
  requestedBoostAudio: string;
  requestedAnthemId: string;
}

export function resolveNormalizedSlotLoadout(
  loadoutOptions: PlayerLoadoutOptions | string | number = {},
  colorSlotArg: number | null = null,
  isBotSession = false
): NormalizedSlotLoadoutResult {
  const normalizedLoadout: PlayerLoadoutOptions =
    typeof loadoutOptions === 'string' || typeof loadoutOptions === 'number'
      ? { visualId: loadoutOptions, colorSlot: colorSlotArg }
      : loadoutOptions || {};
  const requestedVisual = decodeVisualIdIndex(
    normalizedLoadout.visualId ?? normalizedLoadout.visualIndex ?? 'octane'
  );
  const requestedHitboxIndex =
    normalizedLoadout.hitboxId !== undefined && normalizedLoadout.hitboxId !== null
      ? resolveHitboxIndex(normalizedLoadout.hitboxId)
      : normalizedLoadout.hitboxIndex !== undefined && normalizedLoadout.hitboxIndex !== null
        ? resolveHitboxIndex(normalizedLoadout.hitboxIndex)
        : resolveHitboxIndex(requestedVisual);
  const requestedHitboxId = decodeHitboxIndex(requestedHitboxIndex);
  const requestedPaintFinish = decodePaintFinishIndex(normalizedLoadout.paintFinish ?? 'metallic');
  const requestedBoostVisual = decodeBoostVisualIndex(normalizedLoadout.boostVisual ?? 'cartoon');
  const requestedBoostAudio = decodeBoostAudioIndex(normalizedLoadout.boostAudio ?? 'standard');
  const requestedAnthemId =
    normalizedLoadout.anthemId || (isBotSession ? 'TrainStation' : 'random');

  return {
    normalizedLoadout,
    requestedVisual,
    visualIndex: encodeVisualIdIndex(requestedVisual),
    requestedHitboxId,
    requestedHitboxIndex,
    requestedPaintFinish,
    requestedBoostVisual,
    requestedBoostAudio,
    requestedAnthemId,
  };
}

export function resolveUpdatedPlayerLoadout(
  player: MatchPlayerSlot,
  sessionId: string,
  visualIdOrPackedParam1: string | number,
  colorSlotOrPackedParam2: number | null = null,
  explicitHitbox: string | number | null = null,
  extraLoadout: Record<string, string | number | undefined> | null = null
): { patch: Partial<MatchPlayerSlot>; packedLoadout: number } {
  const unpacked = unpackLoadoutCommandParam1(visualIdOrPackedParam1);
  const visualId = unpacked.visualId;
  const visualIndex = unpacked.visualIndex;
  const hitboxIndex =
    explicitHitbox !== null && explicitHitbox !== undefined
      ? resolveHitboxIndex(explicitHitbox)
      : unpacked.hitboxIndex;
  const hitboxId = decodeHitboxIndex(hitboxIndex);

  let nextColorSlot = player.colorSlot;
  let nextBlueColorSlot = player.blueColorSlot;
  let nextOrangeColorSlot = player.orangeColorSlot;
  let nextPaintFinish = player.paintFinish || 'metallic';
  let nextBoostVisual = player.boostVisual || 'cartoon';
  let nextBoostAudio = player.boostAudio || 'rush';

  if (typeof colorSlotOrPackedParam2 === 'number') {
    const unpackedParam2 = unpackLoadoutCommandParam2(colorSlotOrPackedParam2);
    if (unpackedParam2.colorSlot >= 0 && unpackedParam2.colorSlot < CAR_COLOR_SLOTS.length) {
      if (isColorSlotValidForTeam(unpackedParam2.colorSlot, player.team)) {
        nextColorSlot = unpackedParam2.colorSlot;
        if (player.team === 0) nextBlueColorSlot = nextColorSlot;
        else if (player.team === 1) nextOrangeColorSlot = nextColorSlot;
      } else {
        nextColorSlot = resolveTeamMatchedColorSlot(
          unpackedParam2.colorSlot,
          player.team,
          nextBlueColorSlot,
          nextOrangeColorSlot
        );
      }
    } else {
      console.warn(
        `[MatchRosterSubController] Out-of-range colorSlot ${unpackedParam2.colorSlot} for session "${sessionId}", keeping slot ${player.colorSlot}.`
      );
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

  const patch: Partial<MatchPlayerSlot> = {
    visualId,
    visualIndex,
    hitboxId,
    hitboxIndex,
    colorSlot: nextColorSlot,
    blueColorSlot: nextBlueColorSlot,
    orangeColorSlot: nextOrangeColorSlot,
    colorHex: resolveColorHexForSlot(nextColorSlot, player.team),
    paintFinish: nextPaintFinish,
    boostVisual: nextBoostVisual,
    boostAudio: nextBoostAudio,
  };

  return {
    patch,
    packedLoadout: packLoadoutSignalParam2(visualIndex, nextColorSlot, hitboxIndex, {
      paintFinish: nextPaintFinish,
      boostVisual: nextBoostVisual,
      boostAudio: nextBoostAudio,
    }),
  };
}

export function computeNormalizedTeamSpawnSlots(players: Iterable<MatchPlayerSlot>): void {
  const usedSlotsByTeam: [Set<number>, Set<number>] = [new Set(), new Set()];
  const orderedPlayers = Array.from(players)
    .filter((p) => p && typeof p.entityId === 'number' && p.entityId >= 0)
    .sort((a, b) => a.entityId - b.entityId);

  for (const p of orderedPlayers) {
    const teamIdx = p.team === 1 ? 1 : 0;
    const used = usedSlotsByTeam[teamIdx];
    let slot =
      typeof p.spawnSlot === 'number' && p.spawnSlot >= 0
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

export function buildKickoffCarStateArray(
  presetCoord: { x: number; y: number; z: number; yaw: number },
  boostAmount: number
): Float32Array {
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

export function applyKickoffSpawnsToSim(
  sim: SimSpawnPort | null | undefined,
  activeCarIndices: Set<number> | null | undefined,
  players: Iterable<MatchPlayerSlot>,
  boostAmount: number
): void {
  computeNormalizedTeamSpawnSlots(players);
  if (!sim || typeof sim.setCarState !== 'function') return;

  for (const p of players) {
    if (typeof p.entityId !== 'number' || p.entityId < 0) continue;
    if (
      activeCarIndices instanceof Set &&
      activeCarIndices.size > 0 &&
      !activeCarIndices.has(p.entityId)
    ) {
      continue;
    }
    sim.setCarTeam?.(p.entityId, p.team ?? 0);
    const preset = KICKOFF_SPAWN_PRESETS[p.spawnSlot] || KICKOFF_SPAWN_PRESETS[0];
    const presetCoord = p.team === 0 ? preset.team0 : preset.team1;
    if (!presetCoord) continue;
    const carState = buildKickoffCarStateArray(presetCoord, boostAmount);
    sim.setCarState(p.entityId, carState);
  }
}

export function collectSessionUserRtt(
  sessionManager: RosterSessionManagerPort | null | undefined
): UserRttSummary {
  const playersRtt: Array<number | null> = [null, null, null, null, null, null];
  const spectatorsRtt: Array<{ id: number; rtt: number }> = [];

  if (!sessionManager || typeof sessionManager.getAllSessions !== 'function') {
    return { players: playersRtt, spectators: spectatorsRtt };
  }

  const sessions = sessionManager.getAllSessions();
  for (const session of sessions) {
    if (session.role === 'player' && session.entityId >= 0 && session.entityId < 6) {
      playersRtt[session.entityId] = Math.round(session.rttMs || 0);
    } else if (session.role === 'spectator') {
      spectatorsRtt.push({
        id: spectatorsRtt.length,
        rtt: Math.round(session.rttMs || 0),
      });
    }
  }

  return { players: playersRtt, spectators: spectatorsRtt };
}

export function buildMatchRosterMetadata(
  players: Iterable<MatchPlayerSlot>
): MatchRosterMetadataEntry[] {
  const roster: MatchRosterMetadataEntry[] = [];
  for (const p of players) {
    roster.push({
      carIndex: p.entityId,
      entityId: p.entityId,
      sessionId: p.sessionId,
      name: p.name || `Car ${p.entityId}`,
      team: p.team ?? 0,
      role: p.role || 'player',
      isBot: Boolean(p.isBot),
      visualId: p.visualId || 'octane',
      visualIndex: p.visualIndex ?? encodeVisualIdIndex(p.visualId || 'octane'),
      hitboxId: p.hitboxId || 'hitbox-octane',
      hitboxIndex: p.hitboxIndex ?? encodeHitboxIdIndex(p.hitboxId || 'hitbox-octane'),
      colorSlot: p.colorSlot ?? (p.team === 0 ? 3 : 0),
      colorHex: p.colorHex || (p.team === 0 ? '#42a5f5' : '#ff7043'),
      paintFinish: p.paintFinish || 'metallic',
      boostVisual: p.boostVisual || 'cartoon',
      boostAudio: p.boostAudio || 'standard',
      anthemId: p.anthemId || 'none',
    });
  }
  return roster;
}

export function buildRosterSnapshot(source: RosterSnapshotSource): RosterSnapshot {
  const players: RosterSnapshotPlayerEntry[] = [];
  for (const p of source.players.values()) {
    const sess = source.sessionManager?.getSession?.(p.sessionId);
    const pingMs = p.isBot ? 0 : Math.round(sess?.rttMs ?? p.pingMs ?? 0);
    players.push({
      sessionId: p.sessionId,
      entityId: p.entityId,
      carIndex: p.entityId,
      team: p.team,
      preferredTeam: p.preferredTeam ?? p.team,
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
      boostAudio: p.boostAudio || 'standard',
      anthemId: p.anthemId || 'none',
      isBot: Boolean(p.isBot),
      ready: Boolean(p.ready),
      arenaLoaded: Boolean(p.arenaLoaded),
      pingMs,
    });
  }
  const spectators: RosterSnapshotSpectatorEntry[] = [];
  for (const s of source.spectators.values()) {
    const sess = source.sessionManager?.getSession?.(s.sessionId);
    spectators.push({
      sessionId: s.sessionId,
      name: s.name,
      role: 'spectator',
      pingMs: Math.round(sess?.rttMs ?? s.pingMs ?? 0),
    });
  }
  return {
    players,
    spectators,
    gameMode: source.gameMode,
    botFillMode: source.botFillMode,
    durationSeconds: source.clockDuration,
    clockSeconds: source.clockSecondsRemaining,
    score: {
      blue: source.blueScore ?? 0,
      orange: source.orangeScore ?? 0,
    },
  };
}
