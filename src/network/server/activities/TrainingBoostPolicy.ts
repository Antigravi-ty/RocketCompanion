/**
 * src/network/server/activities/TrainingBoostPolicy.ts
 * Pure boost policy resolver and per-tick boost evaluator for MULTIPLAYER_TRAINING.
 */

import type {
  MultiplayerTrainingBoostPolicy,
  MultiplayerTrainingConfig,
} from '../../protocol/ReplicationBusProtocol.ts';

export type ResolvedCarBoostPolicy = 'limited' | 'limit_when_aerial' | 'unlimited';

export function createDefaultMultiplayerTrainingConfig(
  overrides: Partial<MultiplayerTrainingConfig> = {}
): MultiplayerTrainingConfig {
  return {
    boostPolicy: overrides.boostPolicy ?? 'limit_when_aerial',
    perPlayerBoost: overrides.perPlayerBoost ? { ...overrides.perPlayerBoost } : {},
    ghostModeEnabled: overrides.ghostModeEnabled ?? false,
    hideScoreboard: overrides.hideScoreboard ?? true,
    goalReplayEnabled: overrides.goalReplayEnabled ?? true,
  };
}

export function resolveCarBoostPolicy(
  config: MultiplayerTrainingConfig,
  playerKey: string
): ResolvedCarBoostPolicy {
  if (config.boostPolicy === 'custom') {
    const override = config.perPlayerBoost?.[playerKey];
    if (override && override !== 'custom') {
      return override;
    }
    return 'limit_when_aerial';
  }
  return config.boostPolicy;
}

export function stepCarTrainingBoost(
  policy: ResolvedCarBoostPolicy,
  prevBoost: number,
  currentBoost: number,
  onGround: boolean,
  pickedUpPadBoost = 0
): number {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  if (policy === 'unlimited') {
    return 100;
  }
  if (policy === 'limited') {
    return clamp(currentBoost + pickedUpPadBoost);
  }
  // limit_when_aerial:
  // On ground: boost does NOT drain; any boost pad pickup replenishes it up to 100.
  // In air (!onGround): consumes normally from current boost.
  if (onGround) {
    return clamp(Math.max(prevBoost, currentBoost) + pickedUpPadBoost);
  }
  return clamp(currentBoost + pickedUpPadBoost);
}
