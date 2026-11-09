import { RAW_STRIDE } from './ballTrajectoryGeometryPipeline.ts';
import {
  type BallState18Snapshot,
  type BallTrajectoryAnomalySummary,
  type CarProximitySnapshot,
  type LiveTrajectoryTickRecord,
  type TrajectoryAnomalySample,
  type TrajectoryAnomalyTriggerKind,
  type TrajectoryArenaSeamRegion,
  buildPredictionSpaceSnapshot,
} from './ballTrajectoryAnomalyPipeline.ts';

function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

export interface AnomalyTickMetricsSummary {
  posErrorUu: number;
  velErrorUuPerSec: number;
  angVelErrorRadPerSec: number;
  wasmSlice0PosErrorUu: number;
  wasmSlice0VelErrorUuPerSec: number;
  wasmSlice0AngVelErrorRadPerSec: number;
  tailContinuityErrorUu: number;
}

export function buildCapturedAnomalySample(params: {
  sequenceNumber: number;
  triggerKind: TrajectoryAnomalyTriggerKind;
  seamRegion: TrajectoryArenaSeamRegion;
  currentTick: number;
  ticksSinceLastCarHit: number;
  closestSurfaceGapUu: number;
  deviationThresholdUu: number;
  updateKind: string;
  liveBall: BallState18Snapshot;
  cars: CarProximitySnapshot[];
  evalMetrics: AnomalyTickMetricsSummary;
  expectedBeforeStepPos: [number, number, number];
  expectedBeforeStepVel: [number, number, number];
  expectedBeforeStepAngVel: [number, number, number];
  spaceATick: number;
  spaceAUpdateKind: string;
  spaceABallState: BallState18Snapshot | null;
  spaceARawSlices: Float32Array;
  spaceASliceCount: number;
  prevTick: number;
  prevUpdateKind: string;
  prevBallState: BallState18Snapshot | null;
  prevRawSlices: Float32Array;
  prevSliceCount: number;
  rawSlices: Float32Array;
  actualSliceCount: number;
  recentTickHistory: LiveTrajectoryTickRecord[];
}): TrajectoryAnomalySample {
  const {
    sequenceNumber,
    triggerKind,
    seamRegion,
    currentTick,
    ticksSinceLastCarHit,
    closestSurfaceGapUu,
    deviationThresholdUu,
    updateKind,
    liveBall,
    cars,
    evalMetrics,
    expectedBeforeStepPos,
    expectedBeforeStepVel,
    expectedBeforeStepAngVel,
    spaceATick,
    spaceAUpdateKind,
    spaceABallState,
    spaceARawSlices,
    spaceASliceCount,
    prevTick,
    prevUpdateKind,
    prevBallState,
    prevRawSlices,
    prevSliceCount,
    rawSlices,
    actualSliceCount,
    recentTickHistory,
  } = params;

  const ticksSinceSpaceAAnchor = spaceATick >= 0 ? Math.max(0, currentTick - spaceATick) : 0;
  const spaceADirectIdx = Math.max(
    0,
    Math.min(Math.max(0, spaceASliceCount - 1), ticksSinceSpaceAAnchor)
  );
  let spaceADirectPosErrorUu = 0;
  let spaceADirectVelErrorUuPerSec = 0;
  let spaceADirectAngVelErrorRadPerSec = 0;
  if (spaceASliceCount > 0 && ticksSinceSpaceAAnchor > 0) {
    const aBase = spaceADirectIdx * RAW_STRIDE;
    spaceADirectPosErrorUu = round4(
      Math.hypot(
        liveBall.pos[0] - (spaceARawSlices[aBase] ?? 0),
        liveBall.pos[1] - (spaceARawSlices[aBase + 1] ?? 0),
        liveBall.pos[2] - (spaceARawSlices[aBase + 2] ?? 0)
      )
    );
    spaceADirectVelErrorUuPerSec = round4(
      Math.hypot(
        liveBall.vel[0] - (spaceARawSlices[aBase + 3] ?? 0),
        liveBall.vel[1] - (spaceARawSlices[aBase + 4] ?? 0),
        liveBall.vel[2] - (spaceARawSlices[aBase + 5] ?? 0)
      )
    );
    spaceADirectAngVelErrorRadPerSec = round4(
      Math.hypot(
        liveBall.angVel[0] - (spaceARawSlices[aBase + 6] ?? 0),
        liveBall.angVel[1] - (spaceARawSlices[aBase + 7] ?? 0),
        liveBall.angVel[2] - (spaceARawSlices[aBase + 8] ?? 0)
      )
    );
  }

  return {
    id: `traj-anomaly-${sequenceNumber}-t${currentTick}`,
    sequenceNumber,
    capturedAtIso: new Date().toISOString(),
    triggerKind,
    seamRegion,
    anomalyTick: currentTick,
    ticksSinceLastCarHit,
    ticksSinceSpaceAAnchor,
    closestCarSurfaceGapUu: closestSurfaceGapUu,
    deviationThresholdUu,
    metrics: {
      posErrorUu: evalMetrics.posErrorUu,
      velErrorUuPerSec: evalMetrics.velErrorUuPerSec,
      angVelErrorRadPerSec: evalMetrics.angVelErrorRadPerSec,
      wasmSlice0PosErrorUu: evalMetrics.wasmSlice0PosErrorUu,
      wasmSlice0VelErrorUuPerSec: evalMetrics.wasmSlice0VelErrorUuPerSec,
      wasmSlice0AngVelErrorRadPerSec: evalMetrics.wasmSlice0AngVelErrorRadPerSec,
      tailContinuityErrorUu: evalMetrics.tailContinuityErrorUu,
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
      spaceATick,
      spaceAUpdateKind,
      spaceABallState ?? liveBall,
      spaceARawSlices,
      spaceASliceCount,
      spaceADirectIdx
    ),
    previousTickSpace: buildPredictionSpaceSnapshot(
      'prev-tick-expected',
      prevTick,
      prevUpdateKind,
      prevBallState ?? liveBall,
      prevRawSlices,
      prevSliceCount,
      0
    ),
    spaceB: buildPredictionSpaceSnapshot(
      'space-b-recomputed',
      currentTick,
      updateKind,
      liveBall,
      rawSlices,
      actualSliceCount,
      0
    ),
    recentTickHistory,
  };
}

export function buildTrajectoryAnomalySummary(params: {
  latchedSample: TrajectoryAnomalySample | null;
  samples: TrajectoryAnomalySample[];
  totalNonCarRecomputes: number;
  totalWasmSeamResyncs: number;
  spaceATick: number;
  spaceAUpdateKind: string;
}): BallTrajectoryAnomalySummary {
  const {
    latchedSample,
    samples,
    totalNonCarRecomputes,
    totalWasmSeamResyncs,
    spaceATick,
    spaceAUpdateKind,
  } = params;
  const active = latchedSample ?? samples[samples.length - 1] ?? null;
  return {
    armed: latchedSample === null,
    hasLatchedAnomaly: latchedSample !== null,
    capturedCount: samples.length,
    totalNonCarRecomputes,
    totalWasmSeamResyncs,
    spaceAAnchorTick: spaceATick,
    spaceAUpdateKind,
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

export function buildTrajectoryAnomalyExportBundle(params: {
  latchedSample: TrajectoryAnomalySample | null;
  samples: TrajectoryAnomalySample[];
  summary: BallTrajectoryAnomalySummary;
  tickHistory: LiveTrajectoryTickRecord[];
  includeAllSamples: boolean;
}): Record<string, unknown> {
  const { latchedSample, samples, summary, tickHistory, includeAllSamples } = params;
  const primary = latchedSample ?? samples[samples.length - 1] ?? null;
  return {
    schema: 'rocket-companion.ball-trajectory-anomaly-debug.v1',
    exportedAtIso: new Date().toISOString(),
    summary,
    latchedSample: primary,
    samples: includeAllSamples ? samples : primary ? [primary] : [],
    currentRollingTickHistory: tickHistory,
  };
}

export interface TrajectoryAnomalyUiBridgeRecorderPort {
  buildExportBundle(includeAllSamples?: boolean): Record<string, unknown>;
  getSummary(): BallTrajectoryAnomalySummary;
  resetLatchedAnomaly(): void;
  clearAllSamples(): void;
  setOnAnomalyCaptured(cb: ((sample: TrajectoryAnomalySample) => void) | null): void;
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
    } | null
  ): void;
}

export function bindBallTrajectoryAnomalyUiBridge(
  recorder: TrajectoryAnomalyUiBridgeRecorderPort,
  tunerStore: TrajectoryAnomalyUiBridgeTunerStore,
  pushNotification?: (config: Record<string, unknown>) => unknown,
  dismissNotification?: (id: string) => unknown
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
        { label: 'Export JSON', color: 'emerald', onClick: () => exportJson(true) },
        { label: 'Reset & Arm Next', color: 'amber', onClick: () => resetAndArmNext() },
      ],
    });
  });
}
