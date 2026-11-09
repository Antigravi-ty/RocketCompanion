import {
  SIM_OFFSETS,
  CAR_STATE_STRIDE,
  CAR_STATE_OFFSETS,
} from '../../physics/RocketSimConstants.ts';
import { RAW_STRIDE, POINT_STRIDE, MAX_STEPS } from './ballTrajectoryGeometryPipeline.ts';

export interface AnomalyPhysicsCarTeamPort {
  readonly _carSpecs?: ReadonlyArray<{ readonly team?: number } | null>;
}

/**
 * High-speed arena surface / seam classification around the ball in Unreal Units (UU).
 * Standard carball arena half-extents:
 * - Sidewall X: +-4096 UU (with corner 45-deg bevel starting near |X| + |Y| > 8064)
 * - Backwall Y: +-5120 UU (goal opening |X| < 893, Z < 642.775)
 * - Floor Z: 0 UU (ball center resting ~93.15 UU)
 * - Ceiling Z: 2044 UU (ball center touching ~1950.85 UU)
 * - Curved ramp / fillet radius on floor-wall and ceiling-wall seams: ~160 - 256 UU
 */
export type TrajectoryArenaSeamRegion =
  | 'floor-sidewall-seam'
  | 'ceiling-sidewall-seam'
  | 'backwall-floor-seam'
  | 'backwall-ceiling-seam'
  | 'corner-curve'
  | 'sidewall-flat'
  | 'backwall-flat'
  | 'floor-flat'
  | 'ceiling-flat'
  | 'goal-mouth-lip'
  | 'mid-air';

export type TrajectoryAnomalyTriggerKind =
  'full-deviation' | 'wasm-seam-resync' | 'full-world-bounce' | 'velocity-step-mismatch';

export interface BallState18Snapshot {
  pos: [number, number, number];
  rotMat: [number, number, number, number, number, number, number, number, number];
  vel: [number, number, number];
  angVel: [number, number, number];
  speedUuPerSec: number;
  angSpeedRadPerSec: number;
}

export interface CarProximitySnapshot {
  carIndex: number;
  team: number;
  pos: [number, number, number];
  vel: [number, number, number];
  centerDistanceUu: number;
  approxSurfaceGapUu: number;
}

export interface TrajectoryPredictedSliceSample {
  sliceIndex: number;
  tickOffset: number;
  pos: [number, number, number];
  vel: [number, number, number];
  angVel: [number, number, number];
}

export interface PredictionSpaceSnapshot {
  spaceId: 'space-a-baseline' | 'space-b-recomputed' | 'prev-tick-expected';
  anchorTick: number;
  anchorUpdateKind: string;
  anchorBallState18: BallState18Snapshot;
  sliceCount: number;
  /** Dense raw slices near the anchor + seam window (up to 64 slices) */
  nearSlices: TrajectoryPredictedSliceSample[];
  /** Strided horizon slices across the full 600-tick trajectory */
  horizonSlices: TrajectoryPredictedSliceSample[];
}

export interface LiveTrajectoryTickRecord {
  tick: number;
  updateKind: string;
  wasIncrementalShift: boolean;
  needFull: boolean;
  carBallHitEvent: boolean;
  worldBounceEvent: boolean;
  seamRegion: TrajectoryArenaSeamRegion;
  closestCarGapUu: number;
  liveBallState18: BallState18Snapshot;
  expectedBeforeStepPos: [number, number, number];
  expectedBeforeStepVel: [number, number, number];
  expectedBeforeStepAngVel: [number, number, number];
  posErrorUu: number;
  velErrorUuPerSec: number;
  angVelErrorRadPerSec: number;
  wasmSlice0PosErrorUu: number;
  wasmSlice0VelErrorUuPerSec: number;
  wasmSlice0AngVelErrorRadPerSec: number;
  tailContinuityErrorUu: number;
}

export interface TrajectoryAnomalySample {
  id: string;
  sequenceNumber: number;
  capturedAtIso: string;
  triggerKind: TrajectoryAnomalyTriggerKind;
  seamRegion: TrajectoryArenaSeamRegion;
  anomalyTick: number;
  ticksSinceLastCarHit: number;
  ticksSinceSpaceAAnchor: number;
  closestCarSurfaceGapUu: number;
  deviationThresholdUu: number;
  metrics: {
    posErrorUu: number;
    velErrorUuPerSec: number;
    angVelErrorRadPerSec: number;
    wasmSlice0PosErrorUu: number;
    wasmSlice0VelErrorUuPerSec: number;
    wasmSlice0AngVelErrorRadPerSec: number;
    tailContinuityErrorUu: number;
    spaceADirectOffsetIndex: number;
    spaceADirectPosErrorUu: number;
    spaceADirectVelErrorUuPerSec: number;
    spaceADirectAngVelErrorRadPerSec: number;
    posDeltaVec: [number, number, number];
    velDeltaVec: [number, number, number];
    angVelDeltaVec: [number, number, number];
  };
  liveBallAtAnomaly: BallState18Snapshot;
  carsAtAnomaly: CarProximitySnapshot[];
  /**
   * Space A: The prediction space established on the most recent Car-Ball Hit
   * (or initial launch before any non-car-hit anomaly).
   */
  spaceA: PredictionSpaceSnapshot;
  /**
   * Expected trajectory slice window from the immediately preceding tick before
   * the anomaly recomputation occurred.
   */
  previousTickSpace: PredictionSpaceSnapshot;
  /**
   * Space B: The newly recomputed prediction space at the anomaly tick.
   */
  spaceB: PredictionSpaceSnapshot;
  /**
   * Rolling buffer of recent physics ticks leading up to (and including) the anomaly.
   */
  recentTickHistory: LiveTrajectoryTickRecord[];
}

export interface BallTrajectoryAnomalySummary {
  armed: boolean;
  hasLatchedAnomaly: boolean;
  capturedCount: number;
  totalNonCarRecomputes: number;
  totalWasmSeamResyncs: number;
  spaceAAnchorTick: number;
  spaceAUpdateKind: string;
  latestSample: {
    id: string;
    sequenceNumber: number;
    capturedAtIso: string;
    triggerKind: TrajectoryAnomalyTriggerKind;
    seamRegion: TrajectoryArenaSeamRegion;
    anomalyTick: number;
    ticksSinceLastCarHit: number;
    ticksSinceSpaceAAnchor: number;
    closestCarSurfaceGapUu: number;
    posErrorUu: number;
    velErrorUuPerSec: number;
    angVelErrorRadPerSec: number;
    spaceADirectPosErrorUu: number;
    spaceADirectVelErrorUuPerSec: number;
    tailContinuityErrorUu: number;
    livePos: [number, number, number];
    liveVel: [number, number, number];
    liveSpeedUuPerSec: number;
  } | null;
}

function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

function roundVec3(x: number, y: number, z: number): [number, number, number] {
  return [round4(x), round4(y), round4(z)];
}

/**
 * Classify which arena surface or curved seam the ball is currently near.
 * Highlights ceiling-sidewall seam, floor-sidewall seam, corner curve, and backwall seams.
 */
export function classifyArenaSeamRegion(
  posX: number,
  posY: number,
  posZ: number
): TrajectoryArenaSeamRegion {
  const absX = Math.abs(posX);
  const absY = Math.abs(posY);

  const nearFloorCurve = posZ <= 285;
  const nearCeilingCurve = posZ >= 1760;
  const nearSidewallCurve = absX >= 3780;
  const nearBackwallCurve = absY >= 4800;
  const nearCornerBevel = absX + absY >= 7680;
  const nearGoalMouth = absY >= 4920 && absX <= 1050 && posZ <= 780;

  if (nearGoalMouth) {
    return 'goal-mouth-lip';
  }
  if (nearCornerBevel) {
    return 'corner-curve';
  }
  if (nearSidewallCurve && nearCeilingCurve) {
    return 'ceiling-sidewall-seam';
  }
  if (nearSidewallCurve && nearFloorCurve) {
    return 'floor-sidewall-seam';
  }
  if (nearBackwallCurve && nearCeilingCurve) {
    return 'backwall-ceiling-seam';
  }
  if (nearBackwallCurve && nearFloorCurve) {
    return 'backwall-floor-seam';
  }
  if (nearSidewallCurve) {
    return 'sidewall-flat';
  }
  if (nearBackwallCurve) {
    return 'backwall-flat';
  }
  if (posZ <= 140) {
    return 'floor-flat';
  }
  if (posZ >= 1900) {
    return 'ceiling-flat';
  }
  return 'mid-air';
}

export function extractBallState18Snapshot(statePtr: Float32Array): BallState18Snapshot {
  const b = SIM_OFFSETS.BALL;
  const px = statePtr[b] ?? 0;
  const py = statePtr[b + 1] ?? 0;
  const pz = statePtr[b + 2] ?? 0;
  const vx = statePtr[b + 12] ?? 0;
  const vy = statePtr[b + 13] ?? 0;
  const vz = statePtr[b + 14] ?? 0;
  const wx = statePtr[b + 15] ?? 0;
  const wy = statePtr[b + 16] ?? 0;
  const wz = statePtr[b + 17] ?? 0;

  return {
    pos: roundVec3(px, py, pz),
    rotMat: [
      round4(statePtr[b + 3] ?? 1),
      round4(statePtr[b + 4] ?? 0),
      round4(statePtr[b + 5] ?? 0),
      round4(statePtr[b + 6] ?? 0),
      round4(statePtr[b + 7] ?? 1),
      round4(statePtr[b + 8] ?? 0),
      round4(statePtr[b + 9] ?? 0),
      round4(statePtr[b + 10] ?? 0),
      round4(statePtr[b + 11] ?? 1),
    ],
    vel: roundVec3(vx, vy, vz),
    angVel: roundVec3(wx, wy, wz),
    speedUuPerSec: round4(Math.hypot(vx, vy, vz)),
    angSpeedRadPerSec: round4(Math.hypot(wx, wy, wz)),
  };
}

export function extractCarProximitySnapshots(
  phys: AnomalyPhysicsCarTeamPort | null | undefined,
  statePtr: Float32Array
): { cars: CarProximitySnapshot[]; closestSurfaceGapUu: number } {
  const b = SIM_OFFSETS.BALL;
  const bx = statePtr[b] ?? 0;
  const by = statePtr[b + 1] ?? 0;
  const bz = statePtr[b + 2] ?? 0;

  const numCars = Math.max(0, Math.floor(statePtr[SIM_OFFSETS.NUM_CARS] ?? 0));
  const cars: CarProximitySnapshot[] = [];
  let closestSurfaceGapUu = Number.POSITIVE_INFINITY;

  // Approximate ball radius (93.15 UU) + Octane half-diagonal (~85 UU) = ~178 UU
  const combinedRadiusApprox = 178.0;

  for (let i = 0; i < numCars; i++) {
    const c = SIM_OFFSETS.CARS + i * CAR_STATE_STRIDE;
    const cx = statePtr[c + CAR_STATE_OFFSETS.POS] ?? 0;
    const cy = statePtr[c + CAR_STATE_OFFSETS.POS + 1] ?? 0;
    const cz = statePtr[c + CAR_STATE_OFFSETS.POS + 2] ?? 0;
    const vx = statePtr[c + CAR_STATE_OFFSETS.VEL] ?? 0;
    const vy = statePtr[c + CAR_STATE_OFFSETS.VEL + 1] ?? 0;
    const vz = statePtr[c + CAR_STATE_OFFSETS.VEL + 2] ?? 0;
    const centerDist = Math.hypot(bx - cx, by - cy, bz - cz);
    const gap = Math.max(0, centerDist - combinedRadiusApprox);
    if (gap < closestSurfaceGapUu) {
      closestSurfaceGapUu = gap;
    }
    cars.push({
      carIndex: i,
      team: phys?._carSpecs?.[i]?.team ?? i % 2,
      pos: roundVec3(cx, cy, cz),
      vel: roundVec3(vx, vy, vz),
      centerDistanceUu: round4(centerDist),
      approxSurfaceGapUu: round4(gap),
    });
  }

  return {
    cars,
    closestSurfaceGapUu: Number.isFinite(closestSurfaceGapUu) ? round4(closestSurfaceGapUu) : 99999,
  };
}

export function readRawSliceSample(
  rawSlices: Float32Array,
  sliceIndex: number,
  tickOffset: number
): TrajectoryPredictedSliceSample {
  const base = sliceIndex * RAW_STRIDE;
  return {
    sliceIndex,
    tickOffset,
    pos: roundVec3(rawSlices[base] ?? 0, rawSlices[base + 1] ?? 0, rawSlices[base + 2] ?? 0),
    vel: roundVec3(rawSlices[base + 3] ?? 0, rawSlices[base + 4] ?? 0, rawSlices[base + 5] ?? 0),
    angVel: roundVec3(rawSlices[base + 6] ?? 0, rawSlices[base + 7] ?? 0, rawSlices[base + 8] ?? 0),
  };
}

export function buildPredictionSpaceSnapshot(
  spaceId: PredictionSpaceSnapshot['spaceId'],
  anchorTick: number,
  anchorUpdateKind: string,
  anchorBallState18: BallState18Snapshot,
  rawSlices: Float32Array,
  sliceCount: number,
  focusSliceIndex = 0
): PredictionSpaceSnapshot {
  const clampedCount = Math.max(0, Math.min(MAX_STEPS, sliceCount));
  const nearSlices: TrajectoryPredictedSliceSample[] = [];
  const horizonSlices: TrajectoryPredictedSliceSample[] = [];

  const windowStart = Math.max(0, Math.min(clampedCount - 1, focusSliceIndex - 8));
  const windowEnd = Math.min(clampedCount, windowStart + 40);

  for (let i = 0; i < Math.min(24, clampedCount); i++) {
    nearSlices.push(readRawSliceSample(rawSlices, i, i + 1));
  }
  for (let i = windowStart; i < windowEnd; i++) {
    if (i >= 24) {
      nearSlices.push(readRawSliceSample(rawSlices, i, i + 1));
    }
  }

  const stride = 12;
  for (let i = 0; i < clampedCount; i += stride) {
    horizonSlices.push(readRawSliceSample(rawSlices, i, i + 1));
  }
  if (clampedCount > 0 && (clampedCount - 1) % stride !== 0) {
    horizonSlices.push(readRawSliceSample(rawSlices, clampedCount - 1, clampedCount));
  }

  return {
    spaceId,
    anchorTick,
    anchorUpdateKind,
    anchorBallState18,
    sliceCount: clampedCount,
    nearSlices,
    horizonSlices,
  };
}

export function computeTailContinuityErrorUu(
  prevPoints: Float32Array,
  prevPredictionCount: number,
  rawSlices: Float32Array,
  actualCount: number,
  deltaTicks: number
): number {
  if (prevPredictionCount <= deltaTicks || actualCount <= prevPredictionCount - deltaTicks) {
    return 0;
  }
  const checkRawIdx = prevPredictionCount - 1 - deltaTicks;
  const checkPrevIdx = prevPredictionCount - 1;
  const rawBase = checkRawIdx * RAW_STRIDE;
  const prevBase = checkPrevIdx * POINT_STRIDE;

  // Note: prevPoints stores Three.js coords: [px, pz, py]
  const prevRawX = prevPoints[prevBase] ?? 0;
  const prevRawY = prevPoints[prevBase + 2] ?? 0;
  const prevRawZ = prevPoints[prevBase + 1] ?? 0;

  const dx = (rawSlices[rawBase] ?? 0) - prevRawX;
  const dy = (rawSlices[rawBase + 1] ?? 0) - prevRawY;
  const dz = (rawSlices[rawBase + 2] ?? 0) - prevRawZ;
  return round4(Math.hypot(dx, dy, dz));
}
