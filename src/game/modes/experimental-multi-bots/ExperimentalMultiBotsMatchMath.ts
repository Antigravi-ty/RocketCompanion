import { getExperimentalBotPolicyMeta } from '../../../ai/experimental/ExperimentalBotAgent.ts';
import { KICKOFF_SPAWN_PRESETS } from '../../../physics/RocketSimConstants.ts';
import { assignTeamSlotKeys } from '../../../replay/container/RCReplayTimelineParser.ts';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';

export const MAX_GOAL_LOOKBACK_SECONDS = 10.0;
export const SCORER_TOUCH_LOOKBACK_SECONDS = 7.0;

export const KICKOFF_SLOT_PERMUTATIONS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2, 3, 4],
  [1, 0, 3, 2, 4],
  [0, 2, 4, 1, 3],
  [1, 3, 4, 0, 2],
  [2, 3, 4, 0, 1],
];

export interface ExpSpawnedCarEntry {
  carIndex: number;
  keyNumber: number;
  team: 0 | 1;
  teamSlotIndex: number;
  isPlayer: boolean;
  botType: string;
  visualId: string;
  hitboxId: string;
  colorSlot: number;
  colorHex: string;
  colorName: string;
  paintFinish: string;
  boostVisual: string;
  boostAudio: string;
  anthemId: string;
  label: string;
  name?: string;
  agent: any | null;
  [key: string]: unknown;
}

export interface ExpActiveCarRef {
  carIndex: number;
  team: 0 | 1;
}

export interface ExpReplayCarEntry {
  carIndex: number;
  name: string;
  username: string;
  team: 0 | 1;
  isBot: boolean;
  isLocalPlayer: boolean;
  botType?: string | null;
  visualId?: string;
  hitboxId?: string;
  colorSlot?: number;
  colorHex?: string | null;
  paintFinish?: string;
  boostVisual?: string;
  boostAudio?: string;
  anthemId?: string;
}

export interface ExpTeamTouchRecord {
  carIndex: number;
  team: 0 | 1;
  tick: number;
  playerName: string;
}

export interface ExpReplaySignal {
  [key: string]: unknown;
  signalId: number;
  signalType: number;
  frameId: number;
  param1: number;
  param2: number;
}

export interface ExpGoalIncidentMeta {
  goalIncidentTick: number;
  goalScoringTeam: 0 | 1;
  goalScorerCarIndex: number;
  goalScorerName: string | null;
  goalScorerTouchTick: number;
  goalAssistName: string | null;
  goalBallSpeedKph: number | null;
  lastKickoffStartTick: number;
}

export function getExpModeAudio(runtime: any): any {
  return runtime?.options?.gameAudio || gameAudio;
}

export function getExpCarDisplayName(
  entry: Partial<ExpSpawnedCarEntry> | null | undefined,
  spawnedCars: ReadonlyArray<Partial<ExpSpawnedCarEntry>> = []
): string {
  if (!entry) return 'Player';
  if (entry.isPlayer) return 'Player';
  const rawType = String(entry.botType || 'bot');
  const meta = getExperimentalBotPolicyMeta(rawType);
  const baseName =
    meta?.shortName || rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase();
  const sameBotCount = Array.isArray(spawnedCars)
    ? spawnedCars.filter((c) => !c.isPlayer && c.botType === entry.botType).length
    : 1;
  return sameBotCount > 1 ? `${baseName} #${entry.keyNumber}` : baseName;
}

export function buildExpCarEntriesForReplay(
  spawnedCars: ReadonlyArray<ExpSpawnedCarEntry>
): ExpReplayCarEntry[] {
  if (!Array.isArray(spawnedCars) || spawnedCars.length === 0) return [];
  return spawnedCars.map((c) => {
    const displayName = c.name || getExpCarDisplayName(c, spawnedCars);
    const teamNum: 0 | 1 = c.team === 1 ? 1 : 0;
    return {
      carIndex: c.carIndex,
      name: displayName,
      username: displayName,
      team: teamNum,
      isBot: !c.isPlayer,
      isLocalPlayer: Boolean(c.isPlayer),
      botType: c.botType || null,
      visualId: c.visualId || 'octane',
      hitboxId: c.hitboxId || 'hitbox-octane',
      colorSlot: c.colorSlot ?? (teamNum === 0 ? 3 : 0),
      colorHex: c.colorHex || null,
      paintFinish: c.paintFinish || 'metallic',
      boostVisual: c.boostVisual || 'cartoon',
      boostAudio: c.boostAudio || 'standard',
      anthemId: c.anthemId || 'none',
    };
  });
}

export function buildExpRosterForExport(
  spawnedCars: ReadonlyArray<ExpSpawnedCarEntry>
): any[] {
  if (!Array.isArray(spawnedCars)) return [];
  return spawnedCars.map((c) => ({
    carIndex: c.carIndex,
    team: c.team,
    name: c.name || getExpCarDisplayName(c, spawnedCars),
    isPlayer: Boolean(c.isPlayer),
    botType: c.botType || null,
    visualId: c.visualId || 'octane',
    hitboxId: c.hitboxId || 'hitbox-octane',
    colorSlot: c.colorSlot ?? (c.team === 0 ? 3 : 0),
    colorHex: c.colorHex || null,
    paintFinish: c.paintFinish || 'metallic',
    boostVisual: c.boostVisual || 'cartoon',
    boostAudio: c.boostAudio || 'standard',
    anthemId: c.anthemId || 'none',
  }));
}

export function computeKickoffSpawnPlacement(
  entry: Pick<ExpSpawnedCarEntry, 'team' | 'teamSlotIndex'>,
  permutationSeed: number,
  unlimitedBoost: boolean
): {
  pos: [number, number, number];
  vel: [number, number, number];
  angVel: [number, number, number];
  rot: [number, number, number];
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  isOnGround: boolean;
  isSupersonic: boolean;
  isDemoed: boolean;
  hasFlipOrJump: boolean;
  isBoosting: boolean;
  isFlipping: boolean;
  boost: number;
} {
  const perm =
    KICKOFF_SLOT_PERMUTATIONS[permutationSeed % KICKOFF_SLOT_PERMUTATIONS.length];
  const presetIdx = perm[entry.teamSlotIndex % perm.length] ?? 0;
  const preset = KICKOFF_SPAWN_PRESETS[presetIdx] || KICKOFF_SPAWN_PRESETS[0];
  const coord = entry.team === 0 ? preset.team0 : preset.team1;
  const cy = Math.cos(coord.yaw);
  const sy = Math.sin(coord.yaw);

  return {
    pos: [coord.x, coord.y, coord.z],
    vel: [0, 0, 0],
    angVel: [0, 0, 0],
    rot: [0, coord.yaw, 0],
    fwd: [cy, sy, 0],
    right: [-sy, cy, 0],
    up: [0, 0, 1],
    isOnGround: true,
    isSupersonic: false,
    isDemoed: false,
    hasFlipOrJump: true,
    isBoosting: false,
    isFlipping: false,
    boost: unlimitedBoost ? 100 : 33.33,
  };
}

export function resolveSlotKeyTargetCarEntry(
  spawnedCars: ReadonlyArray<ExpSpawnedCarEntry>,
  localTeam: number,
  keyNum: number
): ExpSpawnedCarEntry | null {
  const isLocalOrange = localTeam === 1;
  const blueCars = spawnedCars.filter((c) => c.team === 0);
  const orangeCars = spawnedCars.filter((c) => c.team === 1);
  const leftCars = isLocalOrange ? orangeCars : blueCars;
  const rightCars = isLocalOrange ? blueCars : orangeCars;
  const { slotKeyToCarIndex } = assignTeamSlotKeys(leftCars, rightCars);
  const mappedCarIdx = slotKeyToCarIndex[keyNum];
  return typeof mappedCarIdx === 'number'
    ? spawnedCars.find((c) => c.carIndex === mappedCarIdx) || null
    : spawnedCars.find((c) => c.keyNumber === keyNum) || null;
}

export function resolveGoalAttribution(
  scoringTeam: 0 | 1,
  lastTouchByTeam: Record<0 | 1, ExpTeamTouchRecord | null>,
  prevTouchByTeam: Record<0 | 1, ExpTeamTouchRecord | null>,
  spawnedCars: ReadonlyArray<ExpSpawnedCarEntry>
): {
  scorerCarIndex: number;
  scorerName: string;
  scorerTouchTick: number;
  assistName: string | null;
  scorerAnthemId: string | null;
} {
  const lastTeamTouch = lastTouchByTeam[scoringTeam];
  const prevTeamTouch = prevTouchByTeam[scoringTeam];

  let scorerCarIndex = 0;
  let scorerName = scoringTeam === 0 ? 'Blue' : 'Orange';
  let scorerTouchTick = -1;

  if (lastTeamTouch) {
    scorerCarIndex = lastTeamTouch.carIndex;
    scorerName = lastTeamTouch.playerName;
    scorerTouchTick = lastTeamTouch.tick;
  } else {
    const fallbackEntry =
      spawnedCars.find((c) => c.team === scoringTeam) || spawnedCars[0];
    scorerCarIndex = fallbackEntry ? fallbackEntry.carIndex : 0;
    scorerName = fallbackEntry
      ? getExpCarDisplayName(fallbackEntry, spawnedCars)
      : scoringTeam === 0
        ? 'Blue'
        : 'Orange';
    scorerTouchTick = -1;
  }

  const scorerEntry = spawnedCars.find((c) => c.carIndex === scorerCarIndex) || null;
  const assistName =
    prevTeamTouch &&
    lastTeamTouch &&
    prevTeamTouch.carIndex !== lastTeamTouch.carIndex &&
    lastTeamTouch.tick - prevTeamTouch.tick <= 720
      ? prevTeamTouch.playerName
      : null;

  return {
    scorerCarIndex,
    scorerName,
    scorerTouchTick,
    assistName,
    scorerAnthemId: scorerEntry?.anthemId || null,
  };
}
