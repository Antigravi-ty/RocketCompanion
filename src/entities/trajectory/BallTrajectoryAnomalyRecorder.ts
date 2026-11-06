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
  buildPredictionSpaceSnapshot,
  classifyArenaSeamRegion,
  computeTailContinuityErrorUu,
  extractBallState18Snapshot,
  extractCarProximitySnapshots,
} from './ballTrajectoryAnomalyPipeline.ts';

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
 * Dual-Space Trajectory Prediction Anomaly Recorder & Active Tuner Buffer.
 *
 * Maintains two prediction spaces:
 * 1. Prediction Space A (`spaceA` - Car-Hit / Launch Baseline):
 *    Overwritten on every legitimate `full-car-hit` (or clean `full-initial` when
 *    no anomaly is latched). Stores the full 600-slice raw trajectory buffer and
 *    18-float ball state at the moment of launch / car hit.
 * 2. Prediction Space B (`spaceB` - Anomaly Recomputed Space):
 *    Captured whenever a recomputation (`full-deviation`, `wasm-seam-resync`, or
 *    unexpected non-car-hit recompute) occurs without a Car-Ball Hit.
 *
 * Also maintains a 90-tick rolling ring buffer of live physics states, expected
 * slices, and error vectors so exported JSON bundles contain everything needed
 * to reproduce and diagnose curved-seam or solver discrepancies.
 */
export class BallTrajectoryAnomalyRecorder {
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

  /**
   * Snapshot the current rawSlicesBuffer and expected next-tick slice before WASM overwrites it.
   */
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

  /**
   * Explicitly overwrite Prediction Space A when a car hits the ball or a clean
   * kickoff / ball-control launch begins.
   */
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

  /**
   * Inspect the current tick's live ball state and WASM prediction result, update
   * the rolling 90-tick ring buffer, overwrite Space A on car hits, or capture
   * Space B when a non-car-hit recomputation occurs.
   */
  public recordTick(input: RecordTrajectoryTickInput): TrajectoryAnomalySample | null {
    const {
      phys,
      statePtr,
      currentTick,
      deltaTicks,
      lastCarBallHitTick,
      updateKind,
      needFull,
      wasIncrementalShift,
      carBallHitEvent,
      worldBounceEvent,
      intentionalReset,
      deviationThresholdUu,
      rawSlices,
      actualSliceCount,
    } = input;
    const expectedBeforeStepPos = this.expectedBeforeStepPos;
    const expectedBeforeStepVel = this.expectedBeforeStepVel;
    const expectedBeforeStepAngVel = this.expectedBeforeStepAngVel;
    const prevPredictedPoints = this.prevPredictedPoints;
    const prevPredictionCount = this.prevPredictionCount;

    const liveBall = extractBallState18Snapshot(statePtr);
    const seamRegion = classifyArenaSeamRegion(
      liveBall.pos[0],
      liveBall.pos[1],
      liveBall.pos[2],
    );
    const { cars, closestSurfaceGapUu } = extractCarProximitySnapshots(phys, statePtr);

    const hasExpected = prevPredictionCount > 1 && !intentionalReset;
    const posErrorUu = hasExpected
      ? round4(
          Math.hypot(
            liveBall.pos[0] - expectedBeforeStepPos[0],
            liveBall.pos[1] - expectedBeforeStepPos[1],
            liveBall.pos[2] - expectedBeforeStepPos[2],
          ),
        )
      : 0;
    const velErrorUuPerSec = hasExpected
      ? round4(
          Math.hypot(
            liveBall.vel[0] - expectedBeforeStepVel[0],
            liveBall.vel[1] - expectedBeforeStepVel[1],
            liveBall.vel[2] - expectedBeforeStepVel[2],
          ),
        )
      : 0;
    const angVelErrorRadPerSec = hasExpected
      ? round4(
          Math.hypot(
            liveBall.angVel[0] - expectedBeforeStepAngVel[0],
            liveBall.angVel[1] - expectedBeforeStepAngVel[1],
            liveBall.angVel[2] - expectedBeforeStepAngVel[2],
          ),
        )
      : 0;

    const wasmSlice0PosErrorUu =
      actualSliceCount > 0
        ? round4(
            Math.hypot(
              liveBall.pos[0] - (rawSlices[0] ?? 0),
              liveBall.pos[1] - (rawSlices[1] ?? 0),
              liveBall.pos[2] - (rawSlices[2] ?? 0),
            ),
          )
        : 0;
    const wasmSlice0VelErrorUuPerSec =
      actualSliceCount > 0
        ? round4(
            Math.hypot(
              liveBall.vel[0] - (rawSlices[3] ?? 0),
              liveBall.vel[1] - (rawSlices[4] ?? 0),
              liveBall.vel[2] - (rawSlices[5] ?? 0),
            ),
          )
        : 0;
    const wasmSlice0AngVelErrorRadPerSec =
      actualSliceCount > 0
        ? round4(
            Math.hypot(
              liveBall.angVel[0] - (rawSlices[6] ?? 0),
              liveBall.angVel[1] - (rawSlices[7] ?? 0),
              liveBall.angVel[2] - (rawSlices[8] ?? 0),
            ),
          )
        : 0;

    const tailContinuityErrorUu = hasExpected
      ? computeTailContinuityErrorUu(
          prevPredictedPoints,
          prevPredictionCount,
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
        round4(expectedBeforeStepPos[0]),
        round4(expectedBeforeStepPos[1]),
        round4(expectedBeforeStepPos[2]),
      ],
      expectedBeforeStepVel: [
        round4(expectedBeforeStepVel[0]),
        round4(expectedBeforeStepVel[1]),
        round4(expectedBeforeStepVel[2]),
      ],
      expectedBeforeStepAngVel: [
        round4(expectedBeforeStepAngVel[0]),
        round4(expectedBeforeStepAngVel[1]),
        round4(expectedBeforeStepAngVel[2]),
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

    // 1. If this tick is a car-ball hit or intentional reset / initial launch,
    // overwrite Prediction Space A (unless an anomaly is currently latched, in which
    // case we still keep the latched sample intact and update live Space A for the next arm).
    const isCarHitOrLaunch =
      carBallHitEvent ||
      intentionalReset ||
      updateKind === 'full-car-hit' ||
      updateKind === 'full-initial' ||
      this.spaceASliceCount === 0;

    if (isCarHitOrLaunch) {
      this.overwriteSpaceA(
        currentTick,
        updateKind,
        liveBall,
        rawSlices,
        actualSliceCount,
      );
      return null;
    }

    // Ignore multi-tick car-ball contact follow-through (e.g. pinches/dribbles within
    // the 8-tick WASM impact cooldown when a car is physically touching the ball).
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

    // 2. Detect non-car-hit recomputation or seam resync!
    const isDeviationRecompute = updateKind === 'full-deviation';
    const isWorldBounceRecompute = updateKind === 'full-world-bounce';
    const isWasmSeamResync =
      updateKind === 'wasm-seam-resync' ||
      (!needFull && !wasIncrementalShift && prevPredictionCount > 1);
    const isVelocityStepMismatch =
      hasExpected &&
      velErrorUuPerSec >= 18.0 &&
      closestSurfaceGapUu > 45.0;

    if (isWasmSeamResync) {
      this.totalWasmSeamResyncs += 1;
    }

    // Determine if this event warrants capturing an anomaly sample:
    // - Always capture `full-deviation`, `full-world-bounce`, or `velocity-step-mismatch`
    // - Capture `wasm-seam-resync` when there is a meaningful velocity/tail jump
    //   (`velErrorUuPerSec >= 0.35` or `tailContinuityErrorUu >= 1.5`)
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

    const ticksSinceSpaceAAnchor =
      this.spaceATick >= 0 ? Math.max(0, currentTick - this.spaceATick) : 0;

    // Compare live ball at anomaly directly against Prediction Space A at the corresponding tick offset
    const spaceADirectIdx = Math.max(
      0,
      Math.min(Math.max(0, this.spaceASliceCount - 1), ticksSinceSpaceAAnchor),
    );
    let spaceADirectPosErrorUu = 0;
    let spaceADirectVelErrorUuPerSec = 0;
    let spaceADirectAngVelErrorRadPerSec = 0;
    if (this.spaceASliceCount > 0 && ticksSinceSpaceAAnchor > 0) {
      const aBase = spaceADirectIdx * RAW_STRIDE;
      spaceADirectPosErrorUu = round4(
        Math.hypot(
          liveBall.pos[0] - (this.spaceARawSlices[aBase] ?? 0),
          liveBall.pos[1] - (this.spaceARawSlices[aBase + 1] ?? 0),
          liveBall.pos[2] - (this.spaceARawSlices[aBase + 2] ?? 0),
        ),
      );
      spaceADirectVelErrorUuPerSec = round4(
        Math.hypot(
          liveBall.vel[0] - (this.spaceARawSlices[aBase + 3] ?? 0),
          liveBall.vel[1] - (this.spaceARawSlices[aBase + 4] ?? 0),
          liveBall.vel[2] - (this.spaceARawSlices[aBase + 5] ?? 0),
        ),
      );
      spaceADirectAngVelErrorRadPerSec = round4(
        Math.hypot(
          liveBall.angVel[0] - (this.spaceARawSlices[aBase + 6] ?? 0),
          liveBall.angVel[1] - (this.spaceARawSlices[aBase + 7] ?? 0),
          liveBall.angVel[2] - (this.spaceARawSlices[aBase + 8] ?? 0),
        ),
      );
    }

    this.sequenceCounter += 1;
    const sample: TrajectoryAnomalySample = {
      id: `traj-anomaly-${this.sequenceCounter}-t${currentTick}`,
      sequenceNumber: this.sequenceCounter,
      capturedAtIso: new Date().toISOString(),
      triggerKind,
      seamRegion,
      anomalyTick: currentTick,
      ticksSinceLastCarHit,
      ticksSinceSpaceAAnchor,
      closestCarSurfaceGapUu: closestSurfaceGapUu,
      deviationThresholdUu,
      metrics: {
        posErrorUu,
        velErrorUuPerSec,
        angVelErrorRadPerSec,
        wasmSlice0PosErrorUu,
        wasmSlice0VelErrorUuPerSec,
        wasmSlice0AngVelErrorRadPerSec,
        tailContinuityErrorUu,
        spaceADirectOffsetIndex: spaceADirectIdx,
        spaceADirectPosErrorUu,
        spaceADirectVelErrorUuPerSec,
        spaceADirectAngVelErrorRadPerSec,
        posDeltaVec: [
          round4(liveBall.pos[0] - expectedBeforeStepPos[0]),
          round4(liveBall.pos[1] - expectedBeforeStepPos[1]),
          round4(liveBall.pos[2] - expectedBeforeStepPos[2]),
        ],
        velDeltaVec: [
          round4(liveBall.vel[0] - expectedBeforeStepVel[0]),
          round4(liveBall.vel[1] - expectedBeforeStepVel[1]),
          round4(liveBall.vel[2] - expectedBeforeStepVel[2]),
        ],
        angVelDeltaVec: [
          round4(liveBall.angVel[0] - expectedBeforeStepAngVel[0]),
          round4(liveBall.angVel[1] - expectedBeforeStepAngVel[1]),
          round4(liveBall.angVel[2] - expectedBeforeStepAngVel[2]),
        ],
      },
      liveBallAtAnomaly: liveBall,
      carsAtAnomaly: cars,
      spaceA: buildPredictionSpaceSnapshot(
        'space-a-baseline',
        this.spaceATick,
        this.spaceAUpdateKind,
        this.spaceABallState ?? liveBall,
        this.spaceARawSlices,
        this.spaceASliceCount,
        spaceADirectIdx,
      ),
      previousTickSpace: buildPredictionSpaceSnapshot(
        'prev-tick-expected',
        this.prevTick,
        this.prevUpdateKind,
        this.prevBallState ?? liveBall,
        this.prevRawSlices,
        this.prevSliceCount,
        0,
      ),
      spaceB: buildPredictionSpaceSnapshot(
        'space-b-recomputed',
        currentTick,
        updateKind,
        liveBall,
        rawSlices,
        actualSliceCount,
        0,
      ),
      recentTickHistory: this.tickHistory.slice(),
    };

    this.samples.push(sample);
    if (this.samples.length > MAX_SAVED_SAMPLES) {
      this.samples.shift();
    }

    const wasPreviouslyUnlatched = this.latchedSample === null;
    if (wasPreviouslyUnlatched) {
      this.latchedSample = sample;
      this.onAnomalyCapturedCallback?.(sample);
    }

    return sample;
  }

  public getSummary(): BallTrajectoryAnomalySummary {
    const active = this.latchedSample ?? this.samples[this.samples.length - 1] ?? null;
    return {
      armed: this.latchedSample === null,
      hasLatchedAnomaly: this.latchedSample !== null,
      capturedCount: this.samples.length,
      totalNonCarRecomputes: this.totalNonCarRecomputes,
      totalWasmSeamResyncs: this.totalWasmSeamResyncs,
      spaceAAnchorTick: this.spaceATick,
      spaceAUpdateKind: this.spaceAUpdateKind,
      latestSample: active
        ? {
            id: active.id,
            sequenceNumber: active.sequenceNumber,
            capturedAtIso: active.capturedAtIso,
            triggerKind: active.triggerKind,
            seamRegion: active.seamRegion,
            anomalyTick: active.anomalyTick,
            ticksSinceLastCarHit: active.ticksSinceLastCarHit,
            ticksSinceSpaceAAnchor: active.ticksSinceSpaceAAnchor,
            closestCarSurfaceGapUu: active.closestCarSurfaceGapUu,
            posErrorUu: active.metrics.posErrorUu,
            velErrorUuPerSec: active.metrics.velErrorUuPerSec,
            angVelErrorRadPerSec: active.metrics.angVelErrorRadPerSec,
            spaceADirectPosErrorUu: active.metrics.spaceADirectPosErrorUu,
            spaceADirectVelErrorUuPerSec: active.metrics.spaceADirectVelErrorUuPerSec,
            tailContinuityErrorUu: active.metrics.tailContinuityErrorUu,
            livePos: active.liveBallAtAnomaly.pos,
            liveVel: active.liveBallAtAnomaly.vel,
            liveSpeedUuPerSec: active.liveBallAtAnomaly.speedUuPerSec,
          }
        : null,
    };
  }

  /**
   * Reset the latched anomaly so the recorder arms itself for the next event.
   */
  public resetLatchedAnomaly(): void {
    this.latchedSample = null;
  }

  /**
   * Clear all saved samples and reset counters.
   */
  public clearAllSamples(): void {
    this.latchedSample = null;
    this.samples = [];
    this.totalNonCarRecomputes = 0;
    this.totalWasmSeamResyncs = 0;
  }

  public buildExportBundle(includeAllSamples = true): Record<string, unknown> {
    const primary = this.latchedSample ?? this.samples[this.samples.length - 1] ?? null;
    return {
      schema: 'rocket-companion.ball-trajectory-anomaly-debug.v1',
      exportedAtIso: new Date().toISOString(),
      summary: this.getSummary(),
      latchedSample: primary,
      samples: includeAllSamples ? this.samples : primary ? [primary] : [],
      currentRollingTickHistory: this.tickHistory,
    };
  }
}

export interface TrajectoryAnomalyUiBridgeTunerStore {
  publishTelemetry(telemetry: unknown): void;
  getNotifyAnomalyAlerts?(): boolean;
  registerAnomalyHandlers?(
    handlers: {
      exportJson: (includeAll?: boolean) => void;
      copyJson: (includeAll?: boolean) => Promise<boolean>;
      resetAndArmNext: () => void;
      clearSamples: () => void;
    } | null,
  ): void;
}

export function bindBallTrajectoryAnomalyUiBridge(
  recorder: BallTrajectoryAnomalyRecorder,
  tunerStore: TrajectoryAnomalyUiBridgeTunerStore,
  pushNotification?: (config: Record<string, unknown>) => unknown,
  dismissNotification?: (id: string) => unknown,
): void {
  const notifId = 'traj-anomaly-captured';

  const exportJson = (includeAll = true): void => {
    const bundle = recorder.buildExportBundle(includeAll);
    const json = JSON.stringify(bundle, null, 2);
    if (typeof document === 'undefined') return;
    const summary = recorder.getSummary();
    const tag = summary.latestSample
      ? `${summary.latestSample.seamRegion}-t${summary.latestSample.anomalyTick}`
      : `samples-${summary.capturedCount}`;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ball-trajectory-anomaly-${tag}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyJson = async (includeAll = true): Promise<boolean> => {
    const bundle = recorder.buildExportBundle(includeAll);
    const json = JSON.stringify(bundle, null, 2);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(json);
      return true;
    }
    return false;
  };

  const resetAndArmNext = (): void => {
    recorder.resetLatchedAnomaly();
    dismissNotification?.(notifId);
    tunerStore.publishTelemetry({ anomalySummary: recorder.getSummary() });
  };

  const clearSamples = (): void => {
    recorder.clearAllSamples();
    dismissNotification?.(notifId);
    tunerStore.publishTelemetry({ anomalySummary: recorder.getSummary() });
  };

  tunerStore.registerAnomalyHandlers?.({
    exportJson,
    copyJson,
    resetAndArmNext,
    clearSamples,
  });

  recorder.setOnAnomalyCaptured((sample) => {
    tunerStore.publishTelemetry({ anomalySummary: recorder.getSummary() });
    if (tunerStore.getNotifyAnomalyAlerts?.() === false) return;
    pushNotification?.({
      id: notifId,
      type: 'persistent',
      tone: 'warning',
      icon: 'alert-triangle',
      duration: 12000,
      content: `Trajectory Anomaly #${sample.sequenceNumber} [${sample.triggerKind}] @ ${sample.seamRegion} (posErr ${sample.metrics.posErrorUu.toFixed(2)} UU, dVel ${sample.metrics.velErrorUuPerSec.toFixed(1)} UU/s)`,
      buttons: [
        {
          label: 'Export JSON',
          color: 'emerald',
          onClick: () => {
            exportJson(true);
          },
        },
        {
          label: 'Reset & Arm Next',
          color: 'amber',
          onClick: () => {
            resetAndArmNext();
          },
        },
      ],
    });
  });
}
