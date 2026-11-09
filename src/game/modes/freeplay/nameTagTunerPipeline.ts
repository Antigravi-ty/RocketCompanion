import { KICKOFF_SPAWN_PRESETS } from '../../../physics/RocketSimConstants.ts';
import type { NameTagCarEntry, NameTagConfig } from '../../../ui-core/config/nameTagConfig.ts';

export const SIX_CAR_KICKOFF_PERMUTATIONS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 1, 4],
  [0, 2, 3],
  [0, 2, 4],
  [0, 3, 4],
  [1, 2, 3],
  [1, 2, 4],
  [1, 3, 4],
  [2, 3, 4],
];

export const TEAM_BLUE_COLORS = [0x0ea5e9, 0x38bdf8, 0x2563eb] as const;
export const TEAM_ORANGE_COLORS = [0xf97316, 0xfb923c, 0xea580c] as const;
export const OVERVIEW_FREECAM_POSITION: [number, number, number] = [-1950, 720, -2600];
export const OVERVIEW_FREECAM_TARGET: [number, number, number] = [0, 80, 0];

export const NEUTRAL_HOLD_CONTROLS = {
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: true,
} as const;

interface EditableDomTarget {
  isContentEditable?: boolean;
  tagName?: string;
  type?: string;
}

export function isEditableTunerDomTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as EditableDomTarget;
  if (el.isContentEditable) return true;
  const tagName = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (tagName === 'INPUT') {
    const inputType = String(el.type || 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color'].includes(
      inputType
    );
  }
  return false;
}

export function buildNameTagCarEntriesFromConfig(
  config: Readonly<Partial<NameTagConfig>>
): NameTagCarEntry[] {
  const entries: NameTagCarEntry[] = [];
  for (let carIndex = 0; carIndex < 6; carIndex++) {
    const sampleBoost = config.previewBoostAmounts?.[carIndex] ?? 100;
    const sampleClimbing = Boolean(config.previewAerialClimbingFlags?.[carIndex]);
    entries.push({
      carIndex,
      name: config.previewNames?.[carIndex] || `Player ${carIndex + 1}`,
      team: carIndex < 3 ? 0 : 1,
      boostAmount: sampleBoost,
      isDoubleJumpedAndClimbing: sampleClimbing,
    });
  }
  return entries;
}

export interface SixCarKickoffSpawnSpec {
  readonly carIndex: number;
  readonly team: 0 | 1;
  readonly colorHex: number;
  readonly sampleBoost: number;
  readonly carState: Record<string, unknown>;
}

export function buildSixCarKickoffSpawnSpecs(
  permutationIndex: number,
  config: Readonly<Partial<NameTagConfig>>
): SixCarKickoffSpawnSpec[] {
  const slotTriple =
    SIX_CAR_KICKOFF_PERMUTATIONS[permutationIndex % SIX_CAR_KICKOFF_PERMUTATIONS.length];
  const specs: SixCarKickoffSpawnSpec[] = [];

  for (let carIndex = 0; carIndex < 6; carIndex++) {
    const team: 0 | 1 = carIndex < 3 ? 0 : 1;
    const teamSlotIndex = carIndex % 3;
    const presetIndex = slotTriple[teamSlotIndex] ?? teamSlotIndex;
    const preset = KICKOFF_SPAWN_PRESETS[presetIndex] || KICKOFF_SPAWN_PRESETS[0];
    const spawnCoord = team === 0 ? preset.team0 : preset.team1;
    const cosYaw = Math.cos(spawnCoord.yaw);
    const sinYaw = Math.sin(spawnCoord.yaw);
    const sampleBoost = config.previewBoostAmounts?.[carIndex] ?? 100;
    const colorHex =
      team === 0
        ? TEAM_BLUE_COLORS[teamSlotIndex % TEAM_BLUE_COLORS.length]
        : TEAM_ORANGE_COLORS[teamSlotIndex % TEAM_ORANGE_COLORS.length];

    specs.push({
      carIndex,
      team,
      colorHex,
      sampleBoost,
      carState: {
        pos: [spawnCoord.x, spawnCoord.y, spawnCoord.z],
        vel: [0, 0, 0],
        angVel: [0, 0, 0],
        rot: [0, spawnCoord.yaw, 0],
        fwd: [cosYaw, sinYaw, 0],
        right: [-sinYaw, cosYaw, 0],
        up: [0, 0, 1],
        isOnGround: true,
        isSupersonic: false,
        isDemoed: false,
        hasFlipOrJump: true,
        isBoosting: false,
        isFlipping: false,
        boost: sampleBoost,
      },
    });
  }
  return specs;
}
