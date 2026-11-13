/**
 * src/network/server/activities/MultiplayerTrainingPolicy.ts
 * Boost policy resolver & Host Relay multi-ball coordinator for MULTIPLAYER_TRAINING.
 */

import type { AuthoritativePhysicsSimPort } from '../authoritativePhysicsStepPipeline.ts';

export type PerPlayerBoostPolicy = 'limited' | 'limit_when_aerial' | 'unlimited';
export type TrainingBoostPolicy = PerPlayerBoostPolicy | 'custom';

export interface MultiplayerTrainingConfig {
  boostPolicy: TrainingBoostPolicy;
  perPlayerBoostOverrides: Record<number, PerPlayerBoostPolicy>;
  ghostModeEnabled: boolean;
}

export const DEFAULT_MULTIPLAYER_TRAINING_CONFIG: MultiplayerTrainingConfig = Object.freeze({
  boostPolicy: 'limit_when_aerial',
  perPlayerBoostOverrides: {},
  ghostModeEnabled: false,
});

export function sanitizeTrainingConfig(
  raw?: Partial<MultiplayerTrainingConfig> | Record<string, unknown> | null
): MultiplayerTrainingConfig {
  if (!raw || typeof raw !== 'object') {
    return {
      boostPolicy: DEFAULT_MULTIPLAYER_TRAINING_CONFIG.boostPolicy,
      perPlayerBoostOverrides: {},
      ghostModeEnabled: DEFAULT_MULTIPLAYER_TRAINING_CONFIG.ghostModeEnabled,
    };
  }
  const src = raw as Record<string, unknown>;
  const policy = src.boostPolicy;
  const boostPolicy: TrainingBoostPolicy =
    policy === 'limited' ||
    policy === 'limit_when_aerial' ||
    policy === 'unlimited' ||
    policy === 'custom'
      ? policy
      : 'limit_when_aerial';

  const overrides: Record<number, PerPlayerBoostPolicy> = {};
  if (src.perPlayerBoostOverrides && typeof src.perPlayerBoostOverrides === 'object') {
    for (const [k, v] of Object.entries(src.perPlayerBoostOverrides as Record<string, unknown>)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0 || idx > 15) continue;
      if (v === 'limited' || v === 'limit_when_aerial' || v === 'unlimited') {
        overrides[idx] = v;
      }
    }
  }

  return {
    boostPolicy,
    perPlayerBoostOverrides: overrides,
    ghostModeEnabled: Boolean(src.ghostModeEnabled ?? false),
  };
}

export function resolveCarBoostPolicy(
  config: MultiplayerTrainingConfig,
  carIndex: number
): PerPlayerBoostPolicy {
  if (config.boostPolicy === 'custom') {
    return config.perPlayerBoostOverrides[carIndex] ?? 'limit_when_aerial';
  }
  return config.boostPolicy;
}

export interface TrainingSimBoostPort extends AuthoritativePhysicsSimPort {
  getCarStateView?: (carIndex: number) => { isOnGround?: boolean } | null;
}

export function applyTrainingBoostPolicyToSim(
  sim: TrainingSimBoostPort | null | undefined,
  activeCarIndices: Iterable<number>,
  config: MultiplayerTrainingConfig
): void {
  if (!sim || typeof sim.setCarUnlimitedBoost !== 'function') return;
  for (const carIndex of activeCarIndices) {
    const policy = resolveCarBoostPolicy(config, carIndex);
    sim.setCarBoostCollectable?.(carIndex, true);
    if (policy === 'unlimited') {
      sim.setCarUnlimitedBoost(carIndex, true);
    } else if (policy === 'limited') {
      sim.setCarUnlimitedBoost(carIndex, false);
    } else {
      const onGround = Boolean(sim.getCarStateView?.(carIndex)?.isOnGround);
      sim.setCarUnlimitedBoost(carIndex, onGround);
    }
  }
}

export interface GhostBallSample {
  ownerPeerId: string;
  carIndex: number;
  pos: [number, number, number];
  vel: [number, number, number];
  angVel: [number, number, number];
  tick: number;
}

export class GhostBallRelayCoordinator {
  private readonly ballsByPeer = new Map<string, GhostBallSample>();

  ingestClientBall(sample: GhostBallSample): void {
    if (!sample.ownerPeerId) return;
    this.ballsByPeer.set(sample.ownerPeerId, {
      ...sample,
      pos: [sample.pos[0], sample.pos[1], sample.pos[2]],
      vel: [sample.vel[0], sample.vel[1], sample.vel[2]],
      angVel: [sample.angVel[0], sample.angVel[1], sample.angVel[2]],
    });
  }

  removePeer(peerId: string): void {
    this.ballsByPeer.delete(peerId);
  }

  buildRelaySnapshot(excludePeerId?: string): GhostBallSample[] {
    const out: GhostBallSample[] = [];
    for (const [peerId, sample] of this.ballsByPeer.entries()) {
      if (excludePeerId && peerId === excludePeerId) continue;
      out.push(sample);
    }
    return out;
  }

  getBallCount(): number {
    return this.ballsByPeer.size;
  }

  clear(): void {
    this.ballsByPeer.clear();
  }
}
