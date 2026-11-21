import type {
  GhostTrajectoryManifest,
  GhostTrajectorySample,
  TrainingBoostPolicyKind,
  TrainingGhostCarReservation,
  TrainingPackKind,
  TrainingPackPhase,
  TrainingPackVNextFrameHeader,
  TrainingPackVNextMetadata,
} from '../../network/protocol/trainingFpvDualVNextTypes.ts';

export interface TrainingPackAdapterSnapshotInput {
  trainingKind: TrainingPackKind;
  packId: string;
  packName: string;
  shotIndex: number;
  totalShots: number;
  shotName: string;
  trainingPhase: TrainingPackPhase;
  countdownSeconds: number;
  remainingTimeoutSeconds: number;
  isShotLaunched: boolean;
  boostPolicy?: TrainingBoostPolicyKind;
  perCarBoostPolicies?: Record<number, Exclude<TrainingBoostPolicyKind, 'custom'>>;
  ghostModeEnabled?: boolean;
  ghostReservations?: TrainingGhostCarReservation[];
  ghostTrajectoryHash?: string;
}

export function computeFnv1aHex32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function buildGhostCarReservation(opts: {
  carIndex: number;
  ghostKind: 'static_trajectory' | 'live_sparring';
  visualId?: string;
  team?: 0 | 1;
  opacity?: number;
  trajectoryHash?: string;
}): TrainingGhostCarReservation {
  const rawOpacity =
    typeof opts.opacity === 'number' && Number.isFinite(opts.opacity) ? opts.opacity : 0.45;
  const opacity = Math.max(0.05, Math.min(0.95, rawOpacity));
  return {
    carIndex: Math.max(0, Math.floor(opts.carIndex)),
    roleFlag: 'ghost',
    ghostKind: opts.ghostKind,
    interactWithBall: false,
    interactWithCars: false,
    opacity,
    visualId: opts.visualId || 'octane',
    team: opts.team === 1 ? 1 : 0,
    ...(opts.trajectoryHash ? { trajectoryHash: opts.trajectoryHash } : {}),
  };
}

export function lookupGhostSampleAtTick(
  manifest: GhostTrajectoryManifest | null | undefined,
  tick: number
): GhostTrajectorySample | null {
  const frames = manifest?.frames;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  if (tick <= frames[0].tick) return frames[0];
  const last = frames[frames.length - 1];
  if (tick >= last.tick) return last;

  let lo = 0;
  let hi = frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midTick = frames[mid].tick;
    if (midTick === tick) return frames[mid];
    if (midTick < tick) lo = mid + 1;
    else hi = mid - 1;
  }

  const prev = frames[Math.max(0, hi)];
  const next = frames[Math.min(frames.length - 1, lo)];
  const span = next.tick - prev.tick;
  if (span <= 0) return prev;
  const alpha = (tick - prev.tick) / span;
  const lerp = (a: number, b: number) => a + (b - a) * alpha;
  return {
    tick,
    pos: [
      lerp(prev.pos[0], next.pos[0]),
      lerp(prev.pos[1], next.pos[1]),
      lerp(prev.pos[2], next.pos[2]),
    ],
    rot: [
      lerp(prev.rot[0], next.rot[0]),
      lerp(prev.rot[1], next.rot[1]),
      lerp(prev.rot[2], next.rot[2]),
    ],
    vel: [
      lerp(prev.vel[0], next.vel[0]),
      lerp(prev.vel[1], next.vel[1]),
      lerp(prev.vel[2], next.vel[2]),
    ],
    boost: lerp(prev.boost, next.boost),
    isSupersonic: alpha < 0.5 ? prev.isSupersonic : next.isSupersonic,
  };
}

export class TrainingPackBroadcastAdapter {
  private shotResetSeq = 0;
  private lastMetadata: TrainingPackVNextMetadata | null = null;
  private lastMetadataHash = '0x00000000';
  private activeGhostManifest: GhostTrajectoryManifest | null = null;

  public getShotResetSeq(): number {
    return this.shotResetSeq;
  }

  public getMetadataHash(): string {
    return this.lastMetadataHash;
  }

  public getLastMetadata(): TrainingPackVNextMetadata | null {
    return this.lastMetadata;
  }

  public setGhostTrajectoryManifest(manifest: GhostTrajectoryManifest | null): void {
    this.activeGhostManifest = manifest;
  }

  public sampleGhostAtTick(tick: number): GhostTrajectorySample | null {
    return lookupGhostSampleAtTick(this.activeGhostManifest, tick);
  }

  public beginShotReset(input: TrainingPackAdapterSnapshotInput): {
    metadata: TrainingPackVNextMetadata;
    metadataHash: string;
    metadataChanged: boolean;
    frameHeader: TrainingPackVNextFrameHeader;
  } {
    this.shotResetSeq += 1;
    return this.buildFrameOutput(input);
  }

  public buildFrameOutput(input: TrainingPackAdapterSnapshotInput): {
    metadata: TrainingPackVNextMetadata;
    metadataHash: string;
    metadataChanged: boolean;
    frameHeader: TrainingPackVNextFrameHeader;
  } {
    const metadata: TrainingPackVNextMetadata = {
      trainingKind: input.trainingKind,
      packId: input.packId,
      packName: input.packName,
      shotIndex: Math.max(0, Math.floor(input.shotIndex)),
      totalShots: Math.max(1, Math.floor(input.totalShots)),
      shotName: input.shotName,
      shotResetSeq: this.shotResetSeq,
      boostPolicy: input.boostPolicy ?? 'unlimited',
      ...(input.perCarBoostPolicies ? { perCarBoostPolicies: input.perCarBoostPolicies } : {}),
      ghostModeEnabled: Boolean(input.ghostModeEnabled),
      ghostReservations: input.ghostReservations ?? [],
      ...(input.ghostTrajectoryHash ? { ghostTrajectoryHash: input.ghostTrajectoryHash } : {}),
    };

    const nextHash = computeFnv1aHex32(JSON.stringify(metadata));
    const metadataChanged = nextHash !== this.lastMetadataHash;
    this.lastMetadata = metadata;
    this.lastMetadataHash = nextHash;

    const frameHeader: TrainingPackVNextFrameHeader = {
      trainingPhase: input.trainingPhase,
      shotIndex: metadata.shotIndex,
      shotResetSeq: this.shotResetSeq,
      countdownSeconds: Math.max(0, input.countdownSeconds),
      remainingTimeoutSeconds: Math.max(0, input.remainingTimeoutSeconds),
      isShotLaunched: Boolean(input.isShotLaunched),
    };

    return {
      metadata,
      metadataHash: nextHash,
      metadataChanged,
      frameHeader,
    };
  }

  public reset(): void {
    this.shotResetSeq = 0;
    this.lastMetadata = null;
    this.lastMetadataHash = '0x00000000';
    this.activeGhostManifest = null;
  }
}
