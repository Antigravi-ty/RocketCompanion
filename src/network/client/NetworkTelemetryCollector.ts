/**
 * NetworkTelemetryCollector.ts
 * Standalone network telemetry collector, asymmetric latency breakdown solver,
 * clock pacing step evaluator, and client car slot / lobby probe topology synchronizer.
 */

import {
  evaluatePacingControllerStep,
  type PacingControllerState,
  type PacingControllerParams,
  type PacingControllerStepResult,
} from '../../ui-core/config/pacingControllerEvaluator';
import { isDiagnosticProbeSlot } from '../../physics/RocketSimConstants.ts';

const BALL_OFFSET = 4;
const CAR_BASE_OFFSET = 22;
const CAR_STRIDE = 40;

export interface TelemetrySimulatorPort {
  extraUplinkMs?: number; extraDownlinkMs?: number; extraLatencyMs?: number; extraRttMs?: number;
  isLoopback?: boolean; baseMeasuredRttMs?: number; rttMs?: number; measuredRttMs?: number;
  jitterMs?: number; packetLossRate?: number; burstDropEnabled?: boolean;
}

export interface TelemetryChannelPort extends TelemetrySimulatorPort {
  simulator?: TelemetrySimulatorPort;
  sendClientInput?: (packet: Uint8Array, nowMs?: number) => unknown;
  send?: (packet: Uint8Array, nowMs?: number) => unknown;
  receiveClientPackets?: (nowMs?: number) => unknown[];
  receiveServerPackets?: (nowMs?: number) => unknown[];
  inboundQueue?: unknown[];
}

export interface TelemetrySimPort {
  state?: Float32Array;
  numCars: number;
  isCarSlotActive?: (carIndex: number) => boolean;
  setCarLinearFactorAndGravity?: (carIndex: number, lx: number, ly: number, lz: number, gravityScale: number) => void;
  setCarUnlimitedBoost?: (carIndex: number, enabled: boolean) => void;
  setCarCollisionMask?: (carIndex: number, collideWithBall: boolean, collideWithCars: boolean) => void;
  saveCompactState?: () => Float32Array;
  restoreCompactState?: (state: Float32Array, opts?: { preserveEngineTick?: boolean }) => void;
  setBallState?: (state: Float32Array | Record<string, unknown>) => void;
  setCarState?: (carIndex: number, state: Float32Array | Record<string, unknown>) => void;
  getCarStateView: (carIndex: number) => { posX: number; posY: number; posZ: number } | null;
  getBallStateView?: () => { posX: number; posY: number; posZ: number } | null;
  getHeaderView?: () => { tickCount: number };
  setControls?: (carIndex: number, controls: unknown) => void;
  addCarAtSlot?: (carIndex: number, team: number, preset: string) => void;
  addCar: (team: number, preset: string) => void;
  removeCar?: (carIndex: number) => boolean;
  saveStateSlot: (slot: number) => void;
  restoreStateSlot: (slot: number) => void;
  restoreState: (snapshot: Float32Array | number[]) => void;
}

export interface TelemetryRecorderPort {
  count: number;
  reset?: () => void;
  setSessionMetadata?: (mode: string, priority: string, params: PacingControllerParams | null) => void;
  recordTick?: (entry: Record<string, unknown>) => void;
}

export class ReconcilerMetrics {
  [key: string]: number | boolean | unknown;
  clientTick = 0; serverTick = 0; leadTicks: number;
  rttMs = 0; uplinkMs = 0; downlinkMs = 0;
  extraUplinkMs = 0; extraDownlinkMs = 0; extraRttMs = 0;
  smoothRttMs = 0; measuredJitterMs = 0;
  inputBufferSize: number; effectiveInputBuffer: number; targetInputBuffer: number;
  pacingTier = 0; physicsRateHz = 120; reconcileTier = 1;
  historicalPosDelta = 0; totalCorrections = 0; skippedCorrections = 0; hardSnapCount = 0;
  lastCorrectionDelta = 0; maxCorrectionDelta = 0; smoothingMagnitude = 0;
  localCorrectionDelta?: number; ballCorrectionDelta?: number;
  remoteCorrectionDelta?: number; probeCorrectionDelta?: number;
  enableSmoothing?: boolean; rollbackWindow?: number;
  allUserRtt?: unknown; mispredictions?: number;

  constructor(leadTicks: number, inputBufferTarget: number) {
    this.leadTicks = leadTicks;
    this.inputBufferSize = inputBufferTarget;
    this.effectiveInputBuffer = inputBufferTarget;
    this.targetInputBuffer = inputBufferTarget;
  }

  applyLatencyBreakdown(breakdown: LatencyBreakdownResult, enableSmoothing: boolean, rollbackWindow: number): void {
    this.rttMs = breakdown.rttMs; this.uplinkMs = breakdown.uplinkMs; this.downlinkMs = breakdown.downlinkMs;
    this.extraUplinkMs = breakdown.extraUplinkMs; this.extraDownlinkMs = breakdown.extraDownlinkMs;
    this.extraRttMs = breakdown.extraRttMs; this.enableSmoothing = enableSmoothing; this.rollbackWindow = rollbackWindow;
  }

  applyPacingStep(stepOut: PacingControllerStepResult, rawServerBuffer: number, hasServerBuf: boolean): void {
    this.effectiveInputBuffer = Math.round(stepOut.effectiveBuffer * 100) / 100;
    this.targetInputBuffer = Math.round(stepOut.activeTarget * 100) / 100;
    this.pacingTier = stepOut.tierState; this.physicsRateHz = stepOut.physicsRateHz;
    this.smoothRttMs = Math.round(stepOut.smoothRttMs * 10) / 10;
    this.measuredJitterMs = Math.round(stepOut.jitterMs * 10) / 10;
    if (!hasServerBuf) this.inputBufferSize = Math.max(-64, Math.min(63, Math.round(rawServerBuffer)));
  }

  applySmoothingToggle(enabled: boolean): void {
    this.enableSmoothing = enabled;
    if (!enabled) this.smoothingMagnitude = 0;
  }

  applyHardSyncState(clientTick: number, serverTick: number, leadTicks: number, hardSnapCount: number): void {
    this.reconcileTier = 3; this.hardSnapCount = hardSnapCount;
    this.clientTick = clientTick; this.serverTick = serverTick; this.leadTicks = leadTicks;
  }

  applyClientPredictionStep(clientTick: number, rttMs: number, leadTicks: number): void {
    this.clientTick = clientTick; this.rttMs = rttMs; this.leadTicks = leadTicks;
  }

  applyServerAck(serverTick: number, rttMs: number): void {
    this.serverTick = serverTick; this.rttMs = rttMs;
  }

  applyTier1Skip(localPosDelta: number, skippedCorrections: number, smoothingMagnitude: number): void {
    this.historicalPosDelta = localPosDelta; this.skippedCorrections = skippedCorrections;
    this.reconcileTier = 1; this.lastCorrectionDelta = localPosDelta;
    this.localCorrectionDelta = localPosDelta || 0; this.ballCorrectionDelta = 0;
    this.remoteCorrectionDelta = 0; this.probeCorrectionDelta = 0;
    this.smoothingMagnitude = smoothingMagnitude;
  }

  applySmootherDiscrepancy(
    discrepancy: { localDelta: number; ballDelta: number; remoteMaxDelta: number; probeMaxDelta: number; isTier3HardSnap: boolean },
    lastCorrectionDelta: number,
    smoothingMagnitude: number
  ): void {
    this.localCorrectionDelta = discrepancy.localDelta; this.ballCorrectionDelta = discrepancy.ballDelta;
    this.remoteCorrectionDelta = discrepancy.remoteMaxDelta; this.probeCorrectionDelta = discrepancy.probeMaxDelta;
    this.reconcileTier = discrepancy.isTier3HardSnap ? 3 : 2;
    this.lastCorrectionDelta = lastCorrectionDelta; this.smoothingMagnitude = smoothingMagnitude;
  }

  applyCorrectionCounters(hardSnapCount?: number, totalCorrections?: number, maxCorrectionDelta?: number): void {
    if (hardSnapCount !== undefined) this.hardSnapCount = hardSnapCount;
    if (totalCorrections !== undefined) this.totalCorrections = totalCorrections;
    if (maxCorrectionDelta !== undefined) this.maxCorrectionDelta = maxCorrectionDelta;
  }

  resetCorrectionStats(): void {
    this.reconcileTier = 1; this.historicalPosDelta = 0; this.totalCorrections = 0;
    this.skippedCorrections = 0; this.hardSnapCount = 0; this.lastCorrectionDelta = 0;
    this.maxCorrectionDelta = 0; this.smoothingMagnitude = 0;
  }
}

export interface TopologyPacketPort {
  serverTick?: number;
  stateSnapshot: Float32Array;
  activeCarMask?: number;
  acknowledgedControls?: Array<{ carIndex: number; controls?: unknown }>;
}

export interface LatencyBreakdownInput {
  channel: TelemetryChannelPort | null | undefined;
  baseMeasuredRtt?: number; measuredRtt?: number;
  hasServerReportedBuffer?: boolean; inputBufferSize?: number;
  inputBufferTarget?: number; tickDtMs?: number;
}

export interface LatencyBreakdownResult {
  rttMs: number; baseRttMs: number; uplinkMs: number; downlinkMs: number;
  extraUplinkMs: number; extraDownlinkMs: number; extraRttMs: number;
}

export interface PacingStepStatus {
  stepOut: PacingControllerStepResult; rawServerBuffer: number;
  stepCatchup: boolean; stepSkip: boolean; nowMs: number;
}

export interface PacingStepModulationInput {
  currentClientTick: number; currentDelta: number; targetDelta: number;
  effectiveRtt: number; nowMs: number;
  channel: TelemetryChannelPort | null | undefined;
  kickoffMaskUntilTick: number; inputBufferTarget: number;
  catchupThresholdOffset: number; skipThresholdOffset: number;
  hasServerReportedBuffer: boolean; reportedInputBufferSize: number | undefined;
  clockPacingMode: string; clockPacingParams: PacingControllerParams | null;
  forceTargetAlign: boolean;
}

export interface PacingStepModulationDecision {
  stepOut: PacingControllerStepResult; rawServerBuffer: number;
  hasServerBuf: boolean; clearForceTargetAlign: boolean;
  interpolatorRateHz: number | null;
  action: 'none' | 'skip' | 'catchup'; desiredClientTick: number;
}

export interface SavedLobbyLocalEntities {
  compactState: Float32Array | null;
}

export interface ReconcileTelemetryTickInput {
  isMatchTelemetryActive: boolean;
  telemetryRecorder: TelemetryRecorderPort | null | undefined;
  nowMs: number; clientTick: number; serverTick: number; effectiveRtt: number;
  isHardResyncSnap: boolean; kickoffMaskUntilTick: number;
  inputBufferTarget: number; leadTicks: number;
  interpolatorPhysicsRate?: number; metrics: ReconcilerMetrics;
  lastPacingStepStatus?: PacingStepStatus | null;
}

export interface TopologySyncInput {
  sim: TelemetrySimPort; packet: TopologyPacketPort;
  maxAckCarIndex: number; localCarIndex: number;
  lobbyDualWorldMode: boolean; hostLobbyMode: boolean; isLoopback: boolean;
  carVisualPresets: Map<number, string>;
}

export interface TopologySyncResult {
  shouldAbortReconcile: boolean; shouldNotifyMetrics: boolean;
  invalidateTimelineSync: boolean; activeCarMask?: number;
}

export function createInitialReconcilerMetrics(
  leadTicks: number,
  inputBufferTarget: number
): ReconcilerMetrics {
  return new ReconcilerMetrics(leadTicks, inputBufferTarget);
}

export function configureClientLobbyDiagnosticProbes(
  sim: TelemetrySimPort | null | undefined
): void {
  if (!sim) return;
  const hasSlot6 = typeof sim.isCarSlotActive === 'function' ? sim.isCarSlotActive(6) : sim.numCars > 6;
  if (hasSlot6) {
    sim.setCarLinearFactorAndGravity?.(6, 0, 0, 1, 1.0);
    sim.setCarUnlimitedBoost?.(6, true);
    sim.setCarCollisionMask?.(6, false, false);
  }
  const hasSlot7 = typeof sim.isCarSlotActive === 'function' ? sim.isCarSlotActive(7) : sim.numCars > 7;
  if (hasSlot7) {
    sim.setCarLinearFactorAndGravity?.(7, 0, 0, 0, 0.0);
    sim.setCarUnlimitedBoost?.(7, true);
    sim.setCarCollisionMask?.(7, false, false);
  }
}

export function saveClientLobbyLocalEntities(
  sim: TelemetrySimPort | null | undefined,
  lobbyDualWorldMode: boolean
): SavedLobbyLocalEntities | null {
  if (!lobbyDualWorldMode || !sim) return null;
  const compactState = typeof sim.saveCompactState === 'function'
    ? sim.saveCompactState()
    : sim.state ? new Float32Array(sim.state) : null;
  return { compactState };
}

export function restoreClientLobbyLocalEntities(
  sim: TelemetrySimPort | null | undefined,
  lobbyDualWorldMode: boolean,
  localCarIndex: number,
  lastLocalControls: unknown,
  saved: SavedLobbyLocalEntities | null
): void {
  if (!lobbyDualWorldMode || !sim || !saved) return;
  const localIdx = localCarIndex ?? 1;

  if (saved.compactState && sim.state && sim.state.length >= CAR_BASE_OFFSET + 6 * CAR_STRIDE) {
    const copyEnd = CAR_BASE_OFFSET + 6 * CAR_STRIDE;
    sim.state.subarray(BALL_OFFSET, copyEnd).set(saved.compactState.subarray(BALL_OFFSET, copyEnd));
    if (sim.state.length >= 440 && saved.compactState.length >= 440) {
      sim.state.subarray(416, 416 + 6 * 4).set(saved.compactState.subarray(416, 416 + 6 * 4));
    }
    if (typeof sim.restoreCompactState === 'function') {
      sim.restoreCompactState(sim.state, { preserveEngineTick: true });
    } else {
      sim.setBallState?.(saved.compactState.subarray(BALL_OFFSET, CAR_BASE_OFFSET));
      if (localIdx >= 0 && localIdx < 6) {
        const cOff = CAR_BASE_OFFSET + localIdx * CAR_STRIDE;
        sim.setCarState?.(localIdx, saved.compactState.subarray(cOff, cOff + CAR_STRIDE));
      }
    }
  }

  if (localIdx >= 0 && localIdx < 6 && typeof sim.getCarStateView === 'function') {
    const cv = sim.getCarStateView(localIdx);
    if (cv && (!Number.isFinite(cv.posZ) || cv.posZ < 10.0 || Math.abs(cv.posX) > 4050 || Math.abs(cv.posY) > 5100)) {
      const isOrange = localIdx % 2 === 1;
      const yaw = isOrange ? -0.75 * Math.PI : 0.25 * Math.PI;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      sim.setCarState?.(localIdx, {
        pos: [isOrange ? 2048 : -2048, isOrange ? 2560 : -2560, 17.0],
        forward: [cy, sy, 0], right: [-sy, cy, 0], up: [0, 0, 1],
        vel: [0, 0, 0], angVel: [0, 0, 0],
        boost: 100, isOnGround: true, isDemoed: false, hasFlipOrJump: true,
      });
    }
  }

  if (localIdx >= 0 && lastLocalControls) sim.setControls?.(localIdx, lastLocalControls);
  configureClientLobbyDiagnosticProbes(sim);
}

export function resolveLatencyBreakdown(input: LatencyBreakdownInput): LatencyBreakdownResult {
  const ch = input.channel;
  const sim = ch?.simulator ?? ch;
  const extraUplinkMs = Math.max(0, Math.round(Number(sim?.extraUplinkMs ?? sim?.extraLatencyMs ?? ch?.extraUplinkMs ?? ch?.extraLatencyMs ?? 0) || 0));
  const extraDownlinkMs = Math.max(0, Math.round(Number(sim?.extraDownlinkMs ?? sim?.extraLatencyMs ?? ch?.extraDownlinkMs ?? ch?.extraLatencyMs ?? 0) || 0));
  const extraRttMs = extraUplinkMs + extraDownlinkMs;

  if (ch?.isLoopback || sim?.isLoopback) {
    return {
      rttMs: extraRttMs, baseRttMs: 0, uplinkMs: extraUplinkMs, downlinkMs: extraDownlinkMs,
      extraUplinkMs, extraDownlinkMs, extraRttMs,
    };
  }

  let baseRttMs = 0;
  const simBaseRtt = sim?.baseMeasuredRttMs ?? ch?.baseMeasuredRttMs;
  if (Number.isFinite(input.baseMeasuredRtt) && (input.baseMeasuredRtt as number) > 0) {
    baseRttMs = Math.round(input.baseMeasuredRtt as number);
  } else if (typeof simBaseRtt === 'number' && Number.isFinite(simBaseRtt) && simBaseRtt > 0) {
    baseRttMs = Math.round(simBaseRtt);
  } else if (Number.isFinite(input.measuredRtt) && (input.measuredRtt as number) > 0) {
    baseRttMs = Math.max(0, Math.round((input.measuredRtt as number) - extraRttMs));
  } else {
    const rawRtt = sim?.rttMs ?? ch?.rttMs;
    const rawMeasured = sim?.measuredRttMs ?? ch?.measuredRttMs;
    const chRtt = typeof rawRtt === 'number' && Number.isFinite(rawRtt)
      ? rawRtt
      : typeof rawMeasured === 'number' && Number.isFinite(rawMeasured) ? rawMeasured : 0;
    baseRttMs = Math.max(0, Math.round(chRtt - extraRttMs));
  }

  let bufferAsymmetryMs = 0;
  if (input.hasServerReportedBuffer && typeof input.inputBufferSize === 'number' && Number.isFinite(input.inputBufferSize) && baseRttMs > 0) {
    const bufferDeficitTicks = (input.inputBufferTarget ?? 3) - input.inputBufferSize;
    const maxShift = baseRttMs * 0.5;
    const tickDtMs = input.tickDtMs ?? 1000.0 / 120.0;
    bufferAsymmetryMs = Math.max(-maxShift, Math.min(maxShift, bufferDeficitTicks * tickDtMs));
  }

  const baseUplinkMs = Math.max(0, Math.min(baseRttMs, Math.round(baseRttMs * 0.5 + bufferAsymmetryMs)));
  const baseDownlinkMs = Math.max(0, baseRttMs - baseUplinkMs);
  const uplinkMs = baseUplinkMs + extraUplinkMs;
  const downlinkMs = baseDownlinkMs + extraDownlinkMs;

  return {
    rttMs: uplinkMs + downlinkMs, baseRttMs, uplinkMs, downlinkMs,
    extraUplinkMs, extraDownlinkMs, extraRttMs,
  };
}

export function computeLeadTicksFromBreakdown(
  breakdown: LatencyBreakdownResult,
  inputBufferTarget: number,
  tickDtMs: number,
  maxLeadTicks: number,
  rttMs?: number
): number {
  const uplinkMs = rttMs === undefined || breakdown.extraUplinkMs !== breakdown.extraDownlinkMs
    ? breakdown.uplinkMs
    : Math.max(0, rttMs * 0.5);
  if (uplinkMs <= 1 && (rttMs ?? breakdown.rttMs) <= 2) return Math.max(1, inputBufferTarget);
  const computed = Math.ceil(uplinkMs / tickDtMs) + inputBufferTarget;
  return Math.max(inputBufferTarget, Math.min(maxLeadTicks, computed));
}

export function computeDownlinkTicksFromBreakdown(
  breakdown: LatencyBreakdownResult,
  tickDtMs: number,
  rttMs?: number
): number {
  const downlinkMs = rttMs === undefined || breakdown.extraUplinkMs !== breakdown.extraDownlinkMs
    ? breakdown.downlinkMs
    : Math.max(0, rttMs * 0.5);
  if (downlinkMs <= 1 && (rttMs ?? breakdown.rttMs) <= 2) return 0;
  return Math.max(1, Math.min(64, Math.ceil(downlinkMs / tickDtMs)));
}

export function evaluatePacingModulationDecision(
  pacingState: PacingControllerState,
  input: PacingStepModulationInput
): PacingStepModulationDecision {
  const {
    currentClientTick, currentDelta, targetDelta, effectiveRtt, nowMs, channel: ch,
    kickoffMaskUntilTick, inputBufferTarget, catchupThresholdOffset, skipThresholdOffset,
    hasServerReportedBuffer, reportedInputBufferSize, clockPacingMode, clockPacingParams, forceTargetAlign,
  } = input;

  const sim = ch?.simulator ?? ch;
  const serverTick = currentClientTick - currentDelta;
  const targetClientTick = serverTick + targetDelta;
  const isUnimpairedLoopback = Boolean(
    (ch?.isLoopback || sim?.isLoopback) &&
      !((sim?.extraRttMs ?? ch?.extraRttMs ?? ((sim?.extraLatencyMs ?? ch?.extraLatencyMs ?? 0) * 2)) > 0) &&
      !((sim?.jitterMs ?? ch?.jitterMs ?? 0) > 0) && !((sim?.packetLossRate ?? ch?.packetLossRate ?? 0) > 0) && !(sim?.burstDropEnabled ?? ch?.burstDropEnabled)
  );
  const isKickoffMasked = kickoffMaskUntilTick > 0 && currentClientTick < kickoffMaskUntilTick;
  const impliedBufferFromTimeline = inputBufferTarget + (currentDelta - targetDelta);
  const hasServerBuf = Boolean(hasServerReportedBuffer) &&
    typeof reportedInputBufferSize === 'number' && Number.isFinite(reportedInputBufferSize) && serverTick > 4;
  let rawServerBuffer = hasServerBuf ? reportedInputBufferSize : impliedBufferFromTimeline;

  if (isUnimpairedLoopback) rawServerBuffer = inputBufferTarget;
  else if (isKickoffMasked) rawServerBuffer = Math.max(rawServerBuffer, inputBufferTarget);

  const params: PacingControllerParams = clockPacingParams || {
    targetBufferTicks: inputBufferTarget ?? 3,
    deadbandCatchupOffset: catchupThresholdOffset ?? -2,
    deadbandSkipOffset: skipThresholdOffset ?? 2,
    rateStepMode: clockPacingMode === 'sts' ? 'discrete_2tier' : 'continuous_pd',
    tier1Hz: 1.0, tier2Hz: 3.0, tier1EnterError: 1.0, tier1ExitError: 0.4,
    tier2EnterError: 2.5, tier2ExitError: 1.3, minDwellTicks: 18,
    kpHzPerTick: 0.85, kdHzPerTickVel: 0.35, maxAdjustHz: 6.0, inFlightCompGain: 0.85,
    rttEwmaAlpha: 0.12, bufferEwmaAlpha: 0.25,
    enableAdaptiveJitterBoost: clockPacingMode === 'csts' || clockPacingMode === 'custom',
    adaptiveJitterGain: 1.25, maxAdaptiveBoostTicks: 4.0,
    enableHardResync: true, hardResyncThresholdTicks: 10, hardResyncCooldownMs: 1000,
  };

  const rawStepOut = evaluatePacingControllerStep(
    pacingState,
    { nowMs, rawRttMs: effectiveRtt, rawServerBuffer, packetArrived: true },
    clockPacingMode || 'legacy',
    params
  );

  const stepOut: PacingControllerStepResult = isUnimpairedLoopback
    ? {
        ...rawStepOut,
        physicsRateHz: 120.0,
        tierState: 0,
        tierSwitched: false,
        requestHardResync: false,
        requestStepCatchup: false,
        requestStepSkip: false,
      }
    : rawStepOut;

  let action: 'none' | 'skip' | 'catchup' = 'none';
  let desiredClientTick = currentClientTick;
  let interpolatorRateHz: number | null = null;
  let clearForceTargetAlign = false;

  if (forceTargetAlign) {
    clearForceTargetAlign = true;
    if (currentDelta > targetDelta) {
      desiredClientTick = Math.max(serverTick, targetClientTick);
      action = 'skip';
    } else if (currentDelta < targetDelta) {
      desiredClientTick = targetClientTick;
      action = 'catchup';
    }
  } else if (clockPacingMode === 'legacy') {
    interpolatorRateHz = 120;
    if (currentDelta > targetDelta + skipThresholdOffset) {
      desiredClientTick = Math.max(serverTick, targetClientTick);
      action = 'skip';
    } else if (currentDelta < targetDelta + catchupThresholdOffset) {
      desiredClientTick = targetClientTick;
      action = 'catchup';
    }
  } else {
    interpolatorRateHz = stepOut.physicsRateHz;
    const adaptiveBoostRounded = Math.max(0, Math.round((stepOut.activeTarget || inputBufferTarget) - inputBufferTarget));
    const boostedTargetClientTick = targetClientTick + adaptiveBoostRounded;

    if (stepOut.requestHardResync) {
      const targetDiff = currentClientTick - boostedTargetClientTick;
      if (targetDiff > 0) {
        desiredClientTick = Math.max(serverTick, boostedTargetClientTick);
        action = 'skip';
      } else if (targetDiff < 0) {
        desiredClientTick = boostedTargetClientTick;
        action = 'catchup';
      }
    } else if (stepOut.requestStepCatchup || currentDelta <= 0) {
      desiredClientTick = boostedTargetClientTick;
      action = 'catchup';
    } else if (stepOut.requestStepSkip) {
      desiredClientTick = Math.max(serverTick, boostedTargetClientTick);
      action = 'skip';
    }
  }

  return {
    stepOut, rawServerBuffer, hasServerBuf, clearForceTargetAlign,
    interpolatorRateHz, action, desiredClientTick,
  };
}

export function syncClientCarTopology(input: TopologySyncInput): TopologySyncResult {
  const { sim, packet, maxAckCarIndex, localCarIndex, lobbyDualWorldMode, hostLobbyMode, isLoopback, carVisualPresets } = input;
  const snapCarCount = packet.stateSnapshot && packet.stateSnapshot.length > 2 ? Math.round(packet.stateSnapshot[2] || 0) : 0;
  const serverCarCount = Math.min(8, Math.max(1, snapCarCount, maxAckCarIndex + 1, packet.acknowledgedControls?.length || 1, localCarIndex + 1));
  const serverHasLobbyProbes = typeof packet.activeCarMask !== 'number' || packet.activeCarMask === 0 || (packet.activeCarMask & 0xc0) !== 0;

  if (!lobbyDualWorldMode && !hostLobbyMode && !isLoopback && typeof packet.activeCarMask === 'number' && (packet.activeCarMask & 0xc0) !== 0) {
    return { shouldAbortReconcile: true, shouldNotifyMetrics: true, invalidateTimelineSync: false };
  }

  let topologyChanged = false;
  let activeCarMask: number | undefined;

  if (typeof sim.addCarAtSlot === 'function' && typeof sim.isCarSlotActive === 'function' && typeof packet.activeCarMask === 'number' && packet.activeCarMask > 0) {
    let targetMask = packet.activeCarMask & 0xff;
    if (lobbyDualWorldMode) {
      const diagMask = packet.activeCarMask & 0xc0 || 0xc0;
      const localBit = localCarIndex >= 0 && localCarIndex < 8 ? 1 << localCarIndex : 0;
      targetMask = diagMask | localBit;
    } else if (localCarIndex >= 0 && localCarIndex < 8) {
      targetMask |= 1 << localCarIndex;
    }
    for (let c = 0; c < 8; c++) {
      const shouldBeActive = (targetMask & (1 << c)) !== 0;
      const isActive = sim.isCarSlotActive(c);
      if (shouldBeActive && !isActive) {
        const preset = carVisualPresets.get(c) || (isDiagnosticProbeSlot(c) ? 'fennec' : 'octane');
        const defaultTeam = c === 6 ? 0 : c === 7 ? 1 : c % 2;
        sim.addCarAtSlot(c, defaultTeam, preset);
        topologyChanged = true;
      } else if (!shouldBeActive && isActive && c !== localCarIndex) {
        sim.removeCar?.(c);
        topologyChanged = true;
      }
    }
    activeCarMask = targetMask;
  } else {
    while (sim.numCars < serverCarCount) {
      const nextCarIdx = sim.numCars;
      const preset = carVisualPresets.get(nextCarIdx) || 'octane';
      sim.addCar(nextCarIdx % 2, preset);
      topologyChanged = true;
    }
    if (!lobbyDualWorldMode && typeof sim.removeCar === 'function') {
      while (sim.numCars > serverCarCount && sim.numCars > 1) {
        if (!sim.removeCar(sim.numCars - 1)) break;
        topologyChanged = true;
      }
    }
  }

  if (lobbyDualWorldMode) {
    configureClientLobbyDiagnosticProbes(sim);
    if (!serverHasLobbyProbes) {
      return { shouldAbortReconcile: true, shouldNotifyMetrics: true, invalidateTimelineSync: true, activeCarMask };
    }
  } else if (typeof packet.activeCarMask === 'number' && (packet.activeCarMask & 0xc0) !== 0) {
    configureClientLobbyDiagnosticProbes(sim);
  }

  return { shouldAbortReconcile: false, shouldNotifyMetrics: false, invalidateTimelineSync: topologyChanged, activeCarMask };
}

export function recordReconcileTelemetryTick(input: ReconcileTelemetryTickInput): void {
  if (!input.isMatchTelemetryActive || !input.telemetryRecorder) return;
  const {
    telemetryRecorder, nowMs, clientTick, serverTick, effectiveRtt, isHardResyncSnap,
    kickoffMaskUntilTick, inputBufferTarget, leadTicks, interpolatorPhysicsRate, metrics, lastPacingStepStatus,
  } = input;

  const isKickoffMasked = kickoffMaskUntilTick > 0 && clientTick < kickoffMaskUntilTick;
  if (isHardResyncSnap) {
    if (isKickoffMasked) return;
    telemetryRecorder.recordTick?.({
      nowMs, clientTick, serverTick,
      rawRttMs: effectiveRtt, smoothRttMs: metrics.smoothRttMs || effectiveRtt, jitterMs: metrics.measuredJitterMs || 0,
      serverBuffer: inputBufferTarget, effectiveBuffer: inputBufferTarget, targetBuffer: inputBufferTarget,
      physicsRateHz: interpolatorPhysicsRate ?? 120, leadTicks,
      posErrorUu: metrics.lastCorrectionDelta || 0, localPosErrorUu: metrics.localCorrectionDelta || 0,
      ballPosErrorUu: metrics.ballCorrectionDelta || 0, remotePosErrorUu: metrics.remoteCorrectionDelta || 0,
      probePosErrorUu: metrics.probeCorrectionDelta || 0,
      reconcileTier: 3, tierState: 0, packetArrived: true, hardResync: true, tier3Snap: true,
      stepCatchup: false, stepSkip: false, tierSwitched: false, isKickoffMasked,
    });
    return;
  }

  const stepOut = lastPacingStepStatus?.stepOut;
  const recTier = metrics.reconcileTier || 1;
  telemetryRecorder.recordTick?.({
    nowMs, clientTick, serverTick, rawRttMs: effectiveRtt,
    smoothRttMs: stepOut?.smoothRttMs ?? effectiveRtt, jitterMs: stepOut?.jitterMs ?? 0,
    serverBuffer: lastPacingStepStatus?.rawServerBuffer ?? (metrics.inputBufferSize ?? inputBufferTarget),
    effectiveBuffer: stepOut?.effectiveBuffer ?? (metrics.effectiveInputBuffer ?? inputBufferTarget),
    targetBuffer: stepOut?.activeTarget ?? (metrics.targetInputBuffer ?? inputBufferTarget),
    physicsRateHz: stepOut?.physicsRateHz ?? (interpolatorPhysicsRate ?? 120), leadTicks,
    posErrorUu: metrics.lastCorrectionDelta || 0, localPosErrorUu: metrics.localCorrectionDelta || 0,
    ballPosErrorUu: metrics.ballCorrectionDelta || 0, remotePosErrorUu: metrics.remoteCorrectionDelta || 0,
    probePosErrorUu: metrics.probeCorrectionDelta || 0, reconcileTier: recTier,
    tierState: stepOut?.tierState ?? 0, packetArrived: true,
    hardResync: Boolean(stepOut?.requestHardResync), tier3Snap: Boolean(recTier === 3),
    stepCatchup: Boolean(lastPacingStepStatus?.stepCatchup),
    stepSkip: Boolean(lastPacingStepStatus?.stepSkip),
    tierSwitched: Boolean(stepOut?.tierSwitched), isKickoffMasked,
  });
}

export class NetworkTelemetryCollector {
  recorder: TelemetryRecorderPort | null | undefined;
  isMatchTelemetryActive: boolean;
  pacingControllerState: PacingControllerState = { initialized: false };
  lastPacingStepStatus: PacingStepStatus | null = null;
  private readonly listeners = new Set<(metrics: ReconcilerMetrics) => void>();

  constructor(recorder: TelemetryRecorderPort | null | undefined, isMatchTelemetryActive = true) {
    this.recorder = recorder;
    this.isMatchTelemetryActive = Boolean(isMatchTelemetryActive);
  }

  reset(mode: string, priority: string, params: PacingControllerParams | null): void {
    this.pacingControllerState = { initialized: false };
    this.lastPacingStepStatus = null;
    if (this.recorder) {
      this.recorder.reset?.();
      this.recorder.setSessionMetadata?.(mode, priority, params);
    }
  }

  updateSessionMetadata(mode: string, priority: string, params: PacingControllerParams | null): void {
    this.recorder?.setSessionMetadata?.(mode, priority, params);
  }

  addListener(fn: (metrics: ReconcilerMetrics) => void): () => void {
    if (typeof fn === 'function') {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    return () => {};
  }

  emitMetrics(
    metrics: ReconcilerMetrics,
    onMetricsUpdated?: ((metrics: ReconcilerMetrics) => void) | null
  ): void {
    if (onMetricsUpdated) {
      try { onMetricsUpdated(metrics); } catch (err) {
        console.error('[PredictionReconciler] Error in onMetricsUpdated callback:', err);
      }
    }
    for (const listener of this.listeners) {
      try { listener(metrics); } catch (err) {
        console.error('[PredictionReconciler] Error in metrics listener:', err);
      }
    }
  }
}
