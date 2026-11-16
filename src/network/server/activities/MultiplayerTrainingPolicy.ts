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

export interface TrainingBallPose {
  pos: [number, number, number];
  vel?: [number, number, number];
  angVel?: [number, number, number];
}

export interface TrainingCarPose {
  carIndex?: number;
  pos: [number, number, number];
  rot?: [number, number, number];
  vel?: [number, number, number];
  angVel?: [number, number, number];
  boost?: number;
  isOnGround?: boolean;
  hasFlipOrJump?: boolean;
}

export interface TrainingShotMetadata {
  trainingPackId?: string;
  packId?: string;
  packName?: string;
  shotIndex?: number;
  totalShots?: number;
  shotName?: string;
  shotDescription?: string;
  shotResetSeq?: number;
}

export interface TrainingShotResetPayload extends TrainingShotMetadata {
  ballPose?: TrainingBallPose;
  ballState?: TrainingBallPose;
  carPose?: TrainingCarPose;
  carState?: TrainingCarPose;
  carPoses?: TrainingCarPose[] | Record<string, TrainingCarPose>;
  applyToAllCars?: boolean;
  resetBoostPads?: boolean;
  [key: string]: unknown;
}

export interface TrainingResetPhysicsPort {
  sim?: {
    setBallState?: (state: Record<string, unknown>) => unknown;
    setCarState?: (carIndex: number, state: Record<string, unknown>) => unknown;
    resetBoostPads?: () => unknown;
  } | null;
  activeCarIndices?: Iterable<number>;
  resetGoalLatch?: () => void;
}

function toVec3(raw: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(raw) || raw.length < 3) return fallback;
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  const z = Number(raw[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback;
  return [x, y, z];
}

export function extractTrainingShotMetadata(
  raw?: Record<string, unknown> | null,
  prev: TrainingShotMetadata = {},
  incrementSeq = false
): TrainingShotMetadata {
  const next: TrainingShotMetadata = { ...prev };
  if (raw && typeof raw === 'object') {
    const packId =
      typeof raw.trainingPackId === 'string'
        ? raw.trainingPackId
        : typeof raw.packId === 'string'
          ? raw.packId
          : undefined;
    if (packId !== undefined) {
      next.trainingPackId = packId;
      next.packId = packId;
    }
    if (typeof raw.packName === 'string') next.packName = raw.packName;
    if (typeof raw.shotIndex === 'number' && Number.isFinite(raw.shotIndex)) {
      next.shotIndex = Math.max(0, Math.floor(raw.shotIndex));
    }
    if (typeof raw.totalShots === 'number' && Number.isFinite(raw.totalShots)) {
      next.totalShots = Math.max(1, Math.floor(raw.totalShots));
    }
    if (typeof raw.shotName === 'string') next.shotName = raw.shotName;
    if (typeof raw.shotDescription === 'string') next.shotDescription = raw.shotDescription;
  }
  if (incrementSeq) {
    next.shotResetSeq = (prev.shotResetSeq ?? 0) + 1;
  }
  return next;
}

function buildSimCarPose(pose: TrainingCarPose): Record<string, unknown> {
  const pos = toVec3(pose.pos, [0, 0, 17]);
  return {
    pos,
    rot: toVec3(pose.rot, [0, 0, 0]),
    vel: toVec3(pose.vel, [0, 0, 0]),
    angVel: toVec3(pose.angVel, [0, 0, 0]),
    boost: typeof pose.boost === 'number' && Number.isFinite(pose.boost) ? pose.boost : 100,
    isOnGround: pose.isOnGround !== undefined ? Boolean(pose.isOnGround) : pos[2] <= 22,
    hasFlipOrJump: pose.hasFlipOrJump !== undefined ? Boolean(pose.hasFlipOrJump) : true,
  };
}

export function applyTrainingShotResetToSim(
  physicsManager: TrainingResetPhysicsPort | null | undefined,
  rawPayload?: Record<string, unknown> | null
): boolean {
  if (!physicsManager?.sim || !rawPayload || typeof rawPayload !== 'object') return false;
  const payload = rawPayload as TrainingShotResetPayload;
  const sim = physicsManager.sim;
  let applied = false;

  const ball = payload.ballPose ?? payload.ballState;
  if (ball && typeof ball === 'object' && Array.isArray(ball.pos)) {
    sim.setBallState?.({
      pos: toVec3(ball.pos, [0, 0, 93]),
      vel: toVec3(ball.vel, [0, 0, 0]),
      angVel: toVec3(ball.angVel, [0, 0, 0]),
    });
    applied = true;
  }

  const singleCar = payload.carPose ?? payload.carState;
  if (singleCar && typeof singleCar === 'object' && Array.isArray(singleCar.pos)) {
    const carState = buildSimCarPose(singleCar);
    if (payload.applyToAllCars && physicsManager.activeCarIndices) {
      for (const idx of physicsManager.activeCarIndices) {
        sim.setCarState?.(idx, carState);
      }
    } else {
      const idx = typeof singleCar.carIndex === 'number' ? singleCar.carIndex : 0;
      sim.setCarState?.(idx, carState);
    }
    applied = true;
  }

  if (Array.isArray(payload.carPoses)) {
    for (let i = 0; i < payload.carPoses.length; i++) {
      const entry = payload.carPoses[i];
      if (!entry || !Array.isArray(entry.pos)) continue;
      const idx = typeof entry.carIndex === 'number' ? entry.carIndex : i;
      sim.setCarState?.(idx, buildSimCarPose(entry));
      applied = true;
    }
  } else if (payload.carPoses && typeof payload.carPoses === 'object') {
    for (const [key, entry] of Object.entries(payload.carPoses)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || !entry || !Array.isArray(entry.pos)) continue;
      sim.setCarState?.(idx, buildSimCarPose(entry));
      applied = true;
    }
  }

  if (applied) {
    physicsManager.resetGoalLatch?.();
    if (payload.resetBoostPads !== false) {
      sim.resetBoostPads?.();
    }
  }
  return applied;
}
