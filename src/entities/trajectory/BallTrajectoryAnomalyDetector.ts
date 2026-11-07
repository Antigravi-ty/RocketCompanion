import {
  MAX_STEPS,
  RAW_STRIDE,
} from './ballTrajectoryGeometryPipeline.ts';
import {
  type AnomalyPhysicsCarTeamPort,
  type BallState18Snapshot,
  type BallTrajectoryAnomalySummary,
  type LiveTrajectoryTickRecord,
  type TrajectoryAnomalySample,
  type TrajectoryAnomalyTriggerKind,
  classifyArenaSeamRegion,
  computeTailContinuityErrorUu,
  extractBallState18Snapshot,
  extractCarProximitySnapshots,
} from './ballTrajectoryAnomalyPipeline.ts';
import {
  buildCapturedAnomalySample,
  buildTrajectoryAnomalyExportBundle,
  buildTrajectoryAnomalySummary,
} from './BallTrajectoryAnomalySnapshotBuilder.ts';

const MAX_TICK_HISTORY = 90;
const MAX_SAVED_SAMPLES = 24;

function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

export interface RecordTrajectoryTickInput {
  phys: AnomalyPhysicsCarTeamPort | null | undefined;
  statePtr: Float32Array;
  currentTick: number;
  deltaTicks: number;
  lastCarBallHitTick: number;
  updateKind: string;
  needFull: boolean;
  wasIncrementalShift: boolean;
  carBallHitEvent: boolean;
  worldBounceEvent: boolean;
  intentionalReset: boolean;
  deviationThresholdUu: number;
  rawSlices: Float32Array;
  actualSliceCount: number;
}

/**
 * Dual-Space Trajectory Prediction Anomaly Detector & Active Tuner Buffer.
 *
 * Maintains two prediction spaces:
 * 1. Prediction Space A (`spaceA` - Car-Hit / Launch Baseline):
 *    Overwritten on every legitimate `full-car-hit` (or clean `full-initial` when
 *    no anomaly is latched). Stores the full 600-slice raw trajectory buffer and
 *    18-float ball state at the moment of launch / car hit.
 * 2. Prediction Space B (`spaceB` - Anomaly Recomputed Space):
 *    Captured whenever a recomputation (`full-deviation`, `wasm-seam-resync`, or
 *    unexpected non-car-hit recompute) occurs without a Car-Ball Hit.
 */
export class BallTrajectoryAnomalyDetector {
  private spaceATick = -1;
  private spaceAUpdateKind = 'idle';
  private spaceABallState: BallState18Snapshot | null = null;
  private spaceARawSlices = new Float32Array(MAX_STEPS * RAW_STRIDE);
  private spaceASliceCount = 0;

  private prevTick = -1;
  private prevUpdateKind = 'idle';
  private prevBallState: BallState18Snapshot | null = null;
  private prevRawSlices = new Float32Array(MAX_STEPS * RAW_STRIDE);
  private prevSliceCount = 0;
  private prevPredictedPoints = new Float32Array(MAX_STEPS * 3);
  private prevPredictionCount = 0;
  private expectedBeforeStepPos: [number, number, number] = [0, 0, 0];
  private expectedBeforeStepVel: [number, number, number] = [0, 0, 0];
  private expectedBeforeStepAngVel: [number, number, number] = [0, 0, 0];

  private tickHistory: LiveTrajectoryTickRecord[] = [];
  private latchedSample: TrajectoryAnomalySample | null = null;
  private samples: TrajectoryAnomalySample[] = [];
  private sequenceCounter = 0;
  private totalNonCarRecomputes = 0;
  private totalWasmSeamResyncs = 0;

  private onAnomalyCapturedCallback: ((sample: TrajectoryAnomalySample) => void) | null = null;

  public setOnAnomalyCaptured(cb: ((sample: TrajectoryAnomalySample) => void) | null): void {
    this.onAnomalyCapturedCallback = cb;
  }

  public snapshotPreviousTickSlices(
    tick: number,
    updateKind: string,
    statePtr: Float32Array,
    rawSlices: Float32Array,
    sliceCount: number,
    predictedPoints: Float32Array,
    predictionCount: number,
    deltaTicks: number,
  ): void {
    const count = Math.max(0, Math.min(MAX_STEPS, sliceCount));
    const expectedSliceIdx = Math.max(
      0,
      Math.min(Math.max(0, count - 1), Math.max(0, deltaTicks)),
    );
    const expBase = expectedSliceIdx * RAW_STRIDE;
    this.expectedBeforeStepPos = [
      rawSlices[expBase] ?? 0,
      rawSlices[expBase + 1] ?? 0,
      rawSlices[expBase + 2] ?? 0,
    ];
    this.expectedBeforeStepVel = [
      rawSlices[expBase + 3] ?? 0,
      rawSlices[expBase + 4] ?? 0,
      rawSlices[expBase + 5] ?? 0,
    ];
    this.expectedBeforeStepAngVel = [
      rawSlices[expBase + 6] ?? 0,
      rawSlices[expBase + 7] ?? 0,
      rawSlices[expBase + 8] ?? 0,
    ];
    this.prevPredictionCount = Math.max(0, Math.min(MAX_STEPS, predictionCount));
    if (this.prevPredictionCount > 0) {
      this.prevPredictedPoints.set(
        predictedPoints.subarray(0, this.prevPredictionCount * 3),
      );
    }
    if (count <= 0) return;
    this.prevTick = tick;
    this.prevUpdateKind = updateKind;
    this.prevBallState = extractBallState18Snapshot(statePtr);
    this.prevSliceCount = count;
    this.prevRawSlices.set(rawSlices.subarray(0, count * RAW_STRIDE));
  }

  public overwriteSpaceA(
    tick: number,
    updateKind: string,
    ballState: BallState18Snapshot,
    rawSlices: Float32Array,
    sliceCount: number,
  ): void {
    const count = Math.max(0, Math.min(MAX_STEPS, sliceCount));
    this.spaceATick = tick;
    this.spaceAUpdateKind = updateKind;
    this.spaceABallState = ballState;
    this.spaceASliceCount = count;
    if (count > 0) {
      this.spaceARawSlices.set(rawSlices.subarray(0, count * RAW_STRIDE));
    }
  }

  public recordTick(input: RecordTrajectoryTickInput): TrajectoryAnomalySample | null {
    const {
      phys, statePtr, currentTick, deltaTicks, lastCarBallHitTick,
      updateKind, needFull, wasIncrementalShift, carBallHitEvent,
      worldBounceEvent, intentionalReset, deviationThresholdUu,
      rawSlices, actualSliceCount,
    } = input;

    const liveBall = extractBallState18Snapshot(statePtr);
    const seamRegion = classifyArenaSeamRegion(liveBall.pos[0], liveBall.pos[1], liveBall.pos[2]);
    const { cars, closestSurfaceGapUu } = extractCarProximitySnapshots(phys, statePtr);

    const hasExpected = this.prevPredictionCount > 1 && !intentionalReset;
    const dist3 = (a: [number, number, number], bx: number, by: number, bz: number) =>
      round4(Math.hypot(a[0] - bx, a[1] - by, a[2] - bz));

    const posErrorUu = hasExpected
      ? dist3(liveBall.pos, this.expectedBeforeStepPos[0], this.expectedBeforeStepPos[1], this.expectedBeforeStepPos[2])
      : 0;
    const velErrorUuPerSec = hasExpected
      ? dist3(liveBall.vel, this.expectedBeforeStepVel[0], this.expectedBeforeStepVel[1], this.expectedBeforeStepVel[2])
      : 0;
    const angVelErrorRadPerSec = hasExpected
      ? dist3(liveBall.angVel, this.expectedBeforeStepAngVel[0], this.expectedBeforeStepAngVel[1], this.expectedBeforeStepAngVel[2])
      : 0;

    const wasmSlice0PosErrorUu =
      actualSliceCount > 0 ? dist3(liveBall.pos, rawSlices[0] ?? 0, rawSlices[1] ?? 0, rawSlices[2] ?? 0) : 0;
    const wasmSlice0VelErrorUuPerSec =
      actualSliceCount > 0 ? dist3(liveBall.vel, rawSlices[3] ?? 0, rawSlices[4] ?? 0, rawSlices[5] ?? 0) : 0;
    const wasmSlice0AngVelErrorRadPerSec =
      actualSliceCount > 0 ? dist3(liveBall.angVel, rawSlices[6] ?? 0, rawSlices[7] ?? 0, rawSlices[8] ?? 0) : 0;

    const tailContinuityErrorUu = hasExpected
      ? computeTailContinuityErrorUu(
          this.prevPredictedPoints,
          this.prevPredictionCount,
          rawSlices,
          actualSliceCount,
          deltaTicks,
        )
      : 0;

    const tickRecord: LiveTrajectoryTickRecord = {
      tick: currentTick,
      updateKind,
      wasIncrementalShift,
      needFull,
      carBallHitEvent,
      worldBounceEvent,
      seamRegion,
      closestCarGapUu: closestSurfaceGapUu,
      liveBallState18: liveBall,
      expectedBeforeStepPos: [
        round4(this.expectedBeforeStepPos[0]),
        round4(this.expectedBeforeStepPos[1]),
        round4(this.expectedBeforeStepPos[2]),
      ],
      expectedBeforeStepVel: [
        round4(this.expectedBeforeStepVel[0]),
        round4(this.expectedBeforeStepVel[1]),
        round4(this.expectedBeforeStepVel[2]),
      ],
      expectedBeforeStepAngVel: [
        round4(this.expectedBeforeStepAngVel[0]),
        round4(this.expectedBeforeStepAngVel[1]),
        round4(this.expectedBeforeStepAngVel[2]),
      ],
      posErrorUu,
      velErrorUuPerSec,
      angVelErrorRadPerSec,
      wasmSlice0PosErrorUu,
      wasmSlice0VelErrorUuPerSec,
      wasmSlice0AngVelErrorRadPerSec,
      tailContinuityErrorUu,
    };

    this.tickHistory.push(tickRecord);
    if (this.tickHistory.length > MAX_TICK_HISTORY) {
      this.tickHistory.shift();
    }

    const isCarHitOrLaunch =
      carBallHitEvent ||
      intentionalReset ||
      updateKind === 'full-car-hit' ||
      updateKind === 'full-initial' ||
      this.spaceASliceCount === 0;

    if (isCarHitOrLaunch) {
      this.overwriteSpaceA(currentTick, updateKind, liveBall, rawSlices, actualSliceCount);
      return null;
    }

    const ticksSinceLastCarHit =
      lastCarBallHitTick >= 0 ? Math.max(0, currentTick - lastCarBallHitTick) : 99999;
    const isMultiTickCarFollowThrough =
      closestSurfaceGapUu <= 24.0 ||
      (ticksSinceLastCarHit <= 10 && closestSurfaceGapUu <= 32.0);

    if (isMultiTickCarFollowThrough) {
      this.overwriteSpaceA(
        currentTick,
        'full-car-hit-followthrough',
        liveBall,
        rawSlices,
        actualSliceCount,
      );
      return null;
    }

    const isDeviationRecompute = updateKind === 'full-deviation';
    const isWorldBounceRecompute = updateKind === 'full-world-bounce';
    const isWasmSeamResync =
      updateKind === 'wasm-seam-resync' ||
      (!needFull && !wasIncrementalShift && this.prevPredictionCount > 1);
    const isVelocityStepMismatch =
      hasExpected && velErrorUuPerSec >= 18.0 && closestSurfaceGapUu > 45.0;

    if (isWasmSeamResync) {
      this.totalWasmSeamResyncs += 1;
    }

    const shouldCaptureAnomaly =
      isDeviationRecompute ||
      isWorldBounceRecompute ||
      isVelocityStepMismatch ||
      (isWasmSeamResync && (velErrorUuPerSec >= 0.35 || tailContinuityErrorUu >= 1.5));

    if (!shouldCaptureAnomaly) {
      return null;
    }

    this.totalNonCarRecomputes += 1;

    const triggerKind: TrajectoryAnomalyTriggerKind = isDeviationRecompute
      ? 'full-deviation'
      : isWorldBounceRecompute
        ? 'full-world-bounce'
        : isWasmSeamResync
          ? 'wasm-seam-resync'
          : 'velocity-step-mismatch';

    this.sequenceCounter += 1;
    const sample = buildCapturedAnomalySample({
      sequenceNumber: this.sequenceCounter,
      triggerKind,
      seamRegion,
      currentTick,
      ticksSinceLastCarHit,
      closestSurfaceGapUu,
      deviationThresholdUu,
      updateKind,
      liveBall,
      cars,
      evalMetrics: {
        posErrorUu,
        velErrorUuPerSec,
        angVelErrorRadPerSec,
        wasmSlice0PosErrorUu,
        wasmSlice0VelErrorUuPerSec,
        wasmSlice0AngVelErrorRadPerSec,
        tailContinuityErrorUu,
      },
      expectedBeforeStepPos: this.expectedBeforeStepPos,
      expectedBeforeStepVel: this.expectedBeforeStepVel,
      expectedBeforeStepAngVel: this.expectedBeforeStepAngVel,
      spaceATick: this.spaceATick,
      spaceAUpdateKind: this.spaceAUpdateKind,
      spaceABallState: this.spaceABallState,
      spaceARawSlices: this.spaceARawSlices,
      spaceASliceCount: this.spaceASliceCount,
      prevTick: this.prevTick,
      prevUpdateKind: this.prevUpdateKind,
      prevBallState: this.prevBallState,
      prevRawSlices: this.prevRawSlices,
      prevSliceCount: this.prevSliceCount,
      rawSlices,
      actualSliceCount,
      recentTickHistory: this.tickHistory.slice(),
    });

    this.samples.push(sample);
    if (this.samples.length > MAX_SAVED_SAMPLES) {
      this.samples.shift();
    }

    if (this.latchedSample === null) {
      this.latchedSample = sample;
      this.onAnomalyCapturedCallback?.(sample);
    }

    return sample;
  }

  public getSummary(): BallTrajectoryAnomalySummary {
    return buildTrajectoryAnomalySummary({
      latchedSample: this.latchedSample,
      samples: this.samples,
      totalNonCarRecomputes: this.totalNonCarRecomputes,
      totalWasmSeamResyncs: this.totalWasmSeamResyncs,
      spaceATick: this.spaceATick,
      spaceAUpdateKind: this.spaceAUpdateKind,
    });
  }

  public resetLatchedAnomaly(): void {
    this.latchedSample = null;
  }

  public clearAllSamples(): void {
    this.latchedSample = null;
    this.samples = [];
    this.totalNonCarRecomputes = 0;
    this.totalWasmSeamResyncs = 0;
  }

  public buildExportBundle(includeAllSamples = true): Record<string, unknown> {
    return buildTrajectoryAnomalyExportBundle({
      latchedSample: this.latchedSample,
      samples: this.samples,
      summary: this.getSummary(),
      tickHistory: this.tickHistory,
      includeAllSamples,
    });
  }
}

export { BallTrajectoryAnomalyDetector as BallTrajectoryAnomalyRecorder };
