/**
 * VisualErrorSmoother.ts
 * Pure mathematical operators and stateful wrapper for client-side visual error smoothing.
 * Computes post-resimulation spatial discrepancy and decays visual smoothing offsets.
 */

import {
  type PredictionHistoryBuffer,
  type ReconciliationTolerances,
  evaluateHistoricalSnapshotDelta,
} from './PredictionHistoryBuffer.ts';
import {
  saveClientLobbyLocalEntities,
  configureClientLobbyDiagnosticProbes,
  restoreClientLobbyLocalEntities,
  type ReconcilerMetrics,
  type TelemetrySimPort,
  type TopologyPacketPort,
} from './NetworkTelemetryCollector.ts';

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface PreResimPositions {
  cars: Array<Vector3Like | undefined>;
  ball: Vector3Like | null;
}

export interface PostResimDiscrepancyInput {
  numCars: number;
  localCarIndex: number;
  isLobbyDualWorld: boolean;
  hardSnapThreshold: number;
  isTier3HistoricalHardSnap: boolean;
}

export interface PostResimDiscrepancyResult {
  localDelta: number;
  ballDelta: number;
  remoteMaxDelta: number;
  probeMaxDelta: number;
  primaryDelta: number;
  effectiveDelta: number;
  isTier3HardSnap: boolean;
}

export function computeVector3Magnitude(vec: Vector3Like): number {
  return Math.hypot(vec.x, vec.y, vec.z);
}

export function accumulateSmoothingCorrectionOffset(
  currentOffset: Vector3Like,
  prePhysicsPos: Vector3Like | null | undefined,
  postPhysicsPos: Vector3Like | null | undefined,
  maxOffsetMagnitude = 300.0
): { offset: Vector3Like; magnitude: number } {
  if (!prePhysicsPos || !postPhysicsPos) {
    return { offset: { ...currentOffset }, magnitude: computeVector3Magnitude(currentOffset) };
  }
  let x = currentOffset.x + (prePhysicsPos.x - postPhysicsPos.x);
  let y = currentOffset.y + (prePhysicsPos.y - postPhysicsPos.y);
  let z = currentOffset.z + (prePhysicsPos.z - postPhysicsPos.z);
  let mag = Math.hypot(x, y, z);
  if (mag > maxOffsetMagnitude && mag > 0) {
    const scale = maxOffsetMagnitude / mag;
    x *= scale;
    y *= scale;
    z *= scale;
    mag = maxOffsetMagnitude;
  }
  return { offset: { x, y, z }, magnitude: mag };
}

export function stepVisualSmoothingDecay(
  currentOffset: Vector3Like,
  deltaSeconds: number,
  decayRate = 18.0,
  snapZeroEpsilon = 0.01
): { offset: Vector3Like; magnitude: number } {
  if (deltaSeconds <= 0) {
    return { offset: { ...currentOffset }, magnitude: computeVector3Magnitude(currentOffset) };
  }
  const decay = Math.exp(-decayRate * deltaSeconds);
  let x = currentOffset.x * decay;
  let y = currentOffset.y * decay;
  let z = currentOffset.z * decay;
  let mag = Math.hypot(x, y, z);
  if (mag < snapZeroEpsilon) {
    x = 0; y = 0; z = 0; mag = 0;
  }
  return { offset: { x, y, z }, magnitude: mag };
}

export function resolveSmoothedRenderPosition(physicsPos: Vector3Like, smoothingOffset: Vector3Like): Vector3Like {
  return {
    x: physicsPos.x + smoothingOffset.x,
    y: physicsPos.y + smoothingOffset.y,
    z: physicsPos.z + smoothingOffset.z,
  };
}

export function capturePreResimPositions(
  sim: TelemetrySimPort | null | undefined,
  maxCars = 8
): { prePositions: PreResimPositions; hasNaN: boolean; numCars: number } {
  const numCars = Math.min(sim?.numCars ?? 0, maxCars);
  const hasSlotCheck = typeof sim?.isCarSlotActive === 'function';
  const cars = new Array<Vector3Like | undefined>(numCars);
  let hasNaN = false;

  if (sim) {
    for (let c = 0; c < numCars; c++) {
      if (hasSlotCheck && !sim.isCarSlotActive!(c)) continue;
      const carView = sim.getCarStateView(c);
      if (!carView) continue;
      if (Number.isNaN(carView.posX) || Number.isNaN(carView.posY) || Number.isNaN(carView.posZ)) {
        hasNaN = true;
        break;
      }
      cars[c] = { x: carView.posX, y: carView.posY, z: carView.posZ };
    }
  }

  let ball: Vector3Like | null = null;
  if (!hasNaN && typeof sim?.getBallStateView === 'function') {
    const ballView = sim.getBallStateView();
    if (ballView && !Number.isNaN(ballView.posX) && !Number.isNaN(ballView.posY) && !Number.isNaN(ballView.posZ)) {
      ball = { x: ballView.posX, y: ballView.posY, z: ballView.posZ };
    }
  }
  return { prePositions: { cars, ball }, hasNaN, numCars };
}

export function evaluatePostResimDiscrepancy(
  sim: TelemetrySimPort,
  prePositions: PreResimPositions,
  input: PostResimDiscrepancyInput
): PostResimDiscrepancyResult {
  const { numCars, localCarIndex, isLobbyDualWorld, hardSnapThreshold, isTier3HistoricalHardSnap } = input;
  const hasSlotCheck = typeof sim?.isCarSlotActive === 'function';
  const postLocalCar = sim.getCarStateView(localCarIndex);
  const preLocalPos = prePositions.cars[localCarIndex];
  const localDelta = postLocalCar && preLocalPos
    ? Math.hypot(postLocalCar.posX - preLocalPos.x, postLocalCar.posY - preLocalPos.y, postLocalCar.posZ - preLocalPos.z)
    : 0;

  let ballDelta = 0;
  if (prePositions.ball && typeof sim?.getBallStateView === 'function') {
    const postBall = sim.getBallStateView();
    if (postBall && !Number.isNaN(postBall.posX)) {
      ballDelta = Math.hypot(
        postBall.posX - prePositions.ball.x,
        postBall.posY - prePositions.ball.y,
        postBall.posZ - prePositions.ball.z
      );
    }
  }

  let remoteMaxDelta = 0;
  let probeMaxDelta = 0;
  for (let c = 0; c < numCars; c++) {
    if (c === localCarIndex) continue;
    if (hasSlotCheck && !sim.isCarSlotActive!(c)) continue;
    const preRemote = prePositions.cars[c];
    const postRemote = sim.getCarStateView(c);
    if (!preRemote || !postRemote) continue;
    const rDelta = Math.hypot(
      postRemote.posX - preRemote.x,
      postRemote.posY - preRemote.y,
      postRemote.posZ - preRemote.z
    );
    if (c >= 6) {
      if (rDelta > probeMaxDelta) probeMaxDelta = rDelta;
    } else if (rDelta > remoteMaxDelta) {
      remoteMaxDelta = rDelta;
    }
  }

  const primaryDelta = isLobbyDualWorld ? probeMaxDelta : localDelta;
  const isTier3HardSnap = isLobbyDualWorld
    ? isTier3HistoricalHardSnap || probeMaxDelta >= hardSnapThreshold
    : isTier3HistoricalHardSnap || localDelta >= hardSnapThreshold || ballDelta >= hardSnapThreshold;
  const effectiveDelta = isLobbyDualWorld
    ? probeMaxDelta
    : Math.max(localDelta, ballDelta, remoteMaxDelta, probeMaxDelta);

  return { localDelta, ballDelta, remoteMaxDelta, probeMaxDelta, primaryDelta, effectiveDelta, isTier3HardSnap };
}

export class VisualErrorSmoother {
  enabled: boolean;
  decayRate: number;
  maxOffsetMagnitude: number;
  readonly offset: Vector3Like = { x: 0, y: 0, z: 0 };

  constructor(enabled = false, decayRate = 18.0, maxOffsetMagnitude = 300.0) {
    this.enabled = Boolean(enabled);
    this.decayRate = decayRate;
    this.maxOffsetMagnitude = maxOffsetMagnitude;
  }

  reset(): void {
    this.offset.x = 0;
    this.offset.y = 0;
    this.offset.z = 0;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.reset();
  }

  getMagnitude(): number {
    return computeVector3Magnitude(this.offset);
  }

  applyCorrection(
    preLocalPos: Vector3Like | null | undefined,
    postLocalPos: Vector3Like | null | undefined,
    isTier3HardSnap = false,
    isLobbyDualWorld = false
  ): number {
    if (isTier3HardSnap) {
      this.reset();
      return 0;
    }
    if (!this.enabled || isLobbyDualWorld || !preLocalPos || !postLocalPos) {
      return this.getMagnitude();
    }
    const { offset, magnitude } = accumulateSmoothingCorrectionOffset(
      this.offset, preLocalPos, postLocalPos, this.maxOffsetMagnitude
    );
    this.offset.x = offset.x;
    this.offset.y = offset.y;
    this.offset.z = offset.z;
    return magnitude;
  }

  stepDecay(deltaSeconds: number): Vector3Like {
    if (!this.enabled) return this.offset;
    const { offset } = stepVisualSmoothingDecay(this.offset, deltaSeconds, this.decayRate);
    this.offset.x = offset.x;
    this.offset.y = offset.y;
    this.offset.z = offset.z;
    return this.offset;
  }

  applyPostResimDiscrepancy(
    sim: TelemetrySimPort,
    prePositions: PreResimPositions,
    input: PostResimDiscrepancyInput,
    metrics: ReconcilerMetrics
  ): PostResimDiscrepancyResult {
    const discrepancy = evaluatePostResimDiscrepancy(sim, prePositions, input);
    if (discrepancy.isTier3HardSnap) this.reset();

    let lastCorrectionDelta = discrepancy.primaryDelta;
    if (discrepancy.effectiveDelta > 0.05) {
      lastCorrectionDelta = discrepancy.effectiveDelta;
      if (this.enabled && !discrepancy.isTier3HardSnap && !input.isLobbyDualWorld) {
        const postLocalCar = sim.getCarStateView(input.localCarIndex);
        this.applyCorrection(
          prePositions.cars[input.localCarIndex],
          postLocalCar ? { x: postLocalCar.posX, y: postLocalCar.posY, z: postLocalCar.posZ } : undefined,
          discrepancy.isTier3HardSnap,
          input.isLobbyDualWorld
        );
      }
    }
    metrics.applySmootherDiscrepancy(discrepancy, lastCorrectionDelta, this.getMagnitude());
    return discrepancy;
  }

  executeReplayAndEvaluateCorrection(params: {
    sim: TelemetrySimPort;
    historyBuffer: PredictionHistoryBuffer;
    packet: TopologyPacketPort;
    serverTick: number;
    currentClientTick: number;
    prePositions: PreResimPositions;
    numCars: number;
    localCarIndex: number;
    lobbyDualWorldMode: boolean;
    kickoffMaskUntilTick: number;
    tolerances: ReconciliationTolerances;
    metrics: ReconcilerMetrics;
    skippedCorrections: number;
    hardSnapCount: number;
    totalCorrections: number;
    maxCorrectionDelta: number;
  }): {
    skippedCorrections: number;
    hardSnapCount: number;
    totalCorrections: number;
    maxCorrectionDelta: number;
  } {
    const {
      sim, historyBuffer, packet, serverTick, currentClientTick,
      prePositions, numCars, localCarIndex, lobbyDualWorldMode,
      kickoffMaskUntilTick, tolerances, metrics,
    } = params;
    let { skippedCorrections, hardSnapCount, totalCorrections, maxCorrectionDelta } = params;

    sim.saveStateSlot?.(currentClientTick % 256);
    historyBuffer.saveTickSnapshot(currentClientTick, sim);
    const histSnap = historyBuffer.getTickSnapshot(serverTick);
    const evalResult = evaluateHistoricalSnapshotDelta(packet.stateSnapshot, histSnap, {
      numCars,
      localCarIndex,
      isLobbyDualWorld: lobbyDualWorldMode,
      tolerances,
      isCarSlotActive: typeof sim?.isCarSlotActive === 'function' ? (c: number) => sim.isCarSlotActive!(c) : undefined,
    });
    if (evalResult.canCompare) {
      if (evalResult.withinTier1) {
        skippedCorrections = (skippedCorrections || 0) + 1;
        metrics.applyTier1Skip(evalResult.localPosDelta, skippedCorrections, this.getMagnitude());
        return { skippedCorrections, hardSnapCount, totalCorrections, maxCorrectionDelta };
      }
      metrics.historicalPosDelta = evalResult.localPosDelta;
    }
    const isTier3HistoricalHardSnap = Boolean(evalResult.canCompare && evalResult.exceedsHardSnap);
    const savedLobbyEntities = saveClientLobbyLocalEntities(sim, lobbyDualWorldMode);
    if (serverTick < currentClientTick && currentClientTick - serverTick < 256) {
      sim.restoreStateSlot?.(serverTick % 256);
    }
    sim.restoreState(packet.stateSnapshot);
    if (lobbyDualWorldMode || (typeof sim?.isCarSlotActive === 'function' && (sim.isCarSlotActive(6) || sim.isCarSlotActive(7)))) {
      configureClientLobbyDiagnosticProbes(sim);
    }
    historyBuffer.backfillMissingLocalInputs(serverTick - 16, serverTick, localCarIndex, kickoffMaskUntilTick);
    historyBuffer.resimulateSilentRange(sim, serverTick, currentClientTick, numCars, localCarIndex, kickoffMaskUntilTick);
    if (savedLobbyEntities) {
      restoreClientLobbyLocalEntities(sim, lobbyDualWorldMode, localCarIndex, historyBuffer.lastLocalControls, savedLobbyEntities);
    }
    sim.saveStateSlot(currentClientTick % 256);
    historyBuffer.saveTickSnapshot(currentClientTick, sim);
    const discrepancy = this.applyPostResimDiscrepancy(
      sim,
      prePositions,
      { numCars, localCarIndex, isLobbyDualWorld: lobbyDualWorldMode, hardSnapThreshold: tolerances.hardSnapThreshold ?? 500.0, isTier3HistoricalHardSnap },
      metrics
    );
    let nextHardSnap: number | undefined;
    let nextTotal: number | undefined;
    let nextMaxDelta: number | undefined;
    if (discrepancy.isTier3HardSnap) {
      hardSnapCount = (hardSnapCount || 0) + 1;
      nextHardSnap = hardSnapCount;
    }
    if (discrepancy.effectiveDelta > 0.05) {
      totalCorrections++;
      nextTotal = totalCorrections;
      if (discrepancy.effectiveDelta > maxCorrectionDelta) {
        maxCorrectionDelta = discrepancy.effectiveDelta;
        nextMaxDelta = discrepancy.effectiveDelta;
      }
    }
    metrics.applyCorrectionCounters(nextHardSnap, nextTotal, nextMaxDelta);
    return { skippedCorrections, hardSnapCount, totalCorrections, maxCorrectionDelta };
  }
}
