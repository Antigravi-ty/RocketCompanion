/**
 * src/network/client/ClientClockPacingController.ts
 * Stateful Sub-Controller owning client-side clock pacing configuration,
 * latency breakdown / lead-tick / downlink-tick calculation, and step pacing modulation.
 */

import {
  resolveLatencyBreakdown,
  computeLeadTicksFromBreakdown,
  computeDownlinkTicksFromBreakdown,
  evaluatePacingModulationDecision,
  saveClientLobbyLocalEntities,
  restoreClientLobbyLocalEntities,
  type LatencyBreakdownResult,
  type NetworkTelemetryCollector,
  type ReconcilerMetrics,
  type TelemetryChannelPort,
  type TelemetrySimPort,
} from './NetworkTelemetryCollector.ts';
import type { CarControls } from './PredictionHistoryBuffer.ts';
import type { PacingControllerParams } from '../../ui-core/config/pacingControllerEvaluator';

export interface ClockPacingInterpolatorPort {
  physicsRate?: number;
  setPhysicsRate?: (rateHz: number) => void;
  sync?: (nowMs: number) => void;
}

export interface ClientClockPacingControllerOptions {
  clockPacingMode?: string;
  clockPacingPriority?: string;
  clockPacingParams?: PacingControllerParams | null;
  inputBufferTarget?: number;
  catchupThresholdOffset?: number;
  skipThresholdOffset?: number;
  maxLeadTicks?: number;
  tickDtMs?: number;
}

export interface ClientClockPacingStepContext {
  nowMs: number;
  sim: TelemetrySimPort;
  channel: TelemetryChannelPort | null | undefined;
  interpolator: ClockPacingInterpolatorPort | null | undefined;
  telemetryCollector: NetworkTelemetryCollector;
  metrics: ReconcilerMetrics | undefined;
  kickoffMaskUntilTick: number;
  hasServerReportedBuffer: boolean;
  lobbyDualWorldMode: boolean;
  localCarIndex: number;
  lastLocalControls: CarControls;
  stepForwardTicks: (fromTick: number, toTick: number, useSilentStep: boolean, nowMs: number) => number;
}

export class ClientClockPacingController {
  clockPacingMode: string;
  clockPacingPriority: string;
  clockPacingParams: PacingControllerParams | null;
  fractionalTickAccumulator = 0;
  tickDtMs: number;
  inputBufferTarget: number;
  catchupThresholdOffset: number;
  skipThresholdOffset: number;
  maxLeadTicks?: number;
  forceTargetAlign = false;
  leadTicks = 3;

  constructor(options: ClientClockPacingControllerOptions = {}) {
    this.clockPacingMode = options.clockPacingMode || 'legacy';
    this.clockPacingPriority = options.clockPacingPriority || 'balanced';
    this.clockPacingParams = options.clockPacingParams ? { ...options.clockPacingParams } : null;
    this.tickDtMs = options.tickDtMs ?? 1000.0 / 120.0;
    this.inputBufferTarget = options.inputBufferTarget ?? 3;
    this.catchupThresholdOffset = options.catchupThresholdOffset ?? -2;
    this.skipThresholdOffset = options.skipThresholdOffset ?? 2;
    this.maxLeadTicks = options.maxLeadTicks;
  }

  resetTelemetry(telemetryCollector: NetworkTelemetryCollector): void {
    telemetryCollector.reset(
      this.clockPacingMode,
      this.clockPacingPriority,
      this.clockPacingParams
    );
  }

  resolveLatencyBreakdown(
    channel: TelemetryChannelPort | null | undefined,
    baseMeasuredRtt: number,
    measuredRtt: number,
    hasServerReportedBuffer: boolean,
    inputBufferSize: number | undefined
  ): LatencyBreakdownResult {
    return resolveLatencyBreakdown({
      channel,
      baseMeasuredRtt,
      measuredRtt,
      hasServerReportedBuffer,
      inputBufferSize,
      inputBufferTarget: this.inputBufferTarget,
      tickDtMs: this.tickDtMs,
    });
  }

  syncLatencyBreakdownToMetrics(
    channel: TelemetryChannelPort | null | undefined,
    baseMeasuredRtt: number,
    measuredRtt: number,
    hasServerReportedBuffer: boolean,
    metrics: ReconcilerMetrics,
    enableSmoothing: boolean,
    rollbackWindow: number
  ): LatencyBreakdownResult {
    const breakdown = this.resolveLatencyBreakdown(
      channel,
      baseMeasuredRtt,
      measuredRtt,
      hasServerReportedBuffer,
      metrics?.inputBufferSize
    );
    if (!Number.isFinite(breakdown.rttMs)) {
      throw new Error(`[PredictionReconciler] Channel rttMs is non-finite: ${breakdown.rttMs}`);
    }
    if (channel && !channel.isLoopback && breakdown.rttMs > 0) {
      if (channel.simulator) channel.simulator.rttMs = breakdown.rttMs;
      else channel.rttMs = breakdown.rttMs;
    }
    metrics.applyLatencyBreakdown(breakdown, enableSmoothing, rollbackWindow);
    return breakdown;
  }

  calculateLeadTicks(breakdown: LatencyBreakdownResult, rttMs?: number): number {
    const maxLead =
      this.clockPacingMode === 'legacy'
        ? (this.maxLeadTicks ?? 72)
        : (this.maxLeadTicks ?? 64);
    return computeLeadTicksFromBreakdown(
      breakdown,
      this.inputBufferTarget,
      this.tickDtMs,
      maxLead,
      rttMs
    );
  }

  calculateDownlinkTicks(breakdown: LatencyBreakdownResult, rttMs?: number): number {
    return computeDownlinkTicksFromBreakdown(breakdown, this.tickDtMs, rttMs);
  }

  evaluateTimelineTargets(
    channel: TelemetryChannelPort | null | undefined,
    baseMeasuredRtt: number,
    measuredRtt: number,
    hasServerReportedBuffer: boolean,
    inputBufferSize: number | undefined,
    rttMs?: number
  ): { breakdown: LatencyBreakdownResult; leadTicks: number; downlinkTicks: number } {
    const breakdown = this.resolveLatencyBreakdown(
      channel,
      baseMeasuredRtt,
      measuredRtt,
      hasServerReportedBuffer,
      inputBufferSize
    );
    return {
      breakdown,
      leadTicks: this.calculateLeadTicks(breakdown, rttMs),
      downlinkTicks: this.calculateDownlinkTicks(breakdown, rttMs),
    };
  }

  setClockPacingMode(
    mode: string,
    interpolator: ClockPacingInterpolatorPort | null | undefined,
    metrics: ReconcilerMetrics | undefined,
    telemetryCollector: NetworkTelemetryCollector
  ): void {
    if (mode !== 'csts' && mode !== 'sts' && mode !== 'legacy' && mode !== 'custom') {
      throw new Error(
        `[PredictionReconciler] Unknown clock pacing mode: ${mode}. Expected 'legacy', 'sts', 'csts', or 'custom'.`
      );
    }
    this.clockPacingMode = mode;
    if (mode === 'legacy') {
      interpolator?.setPhysicsRate?.(120);
      if (metrics) metrics.physicsRateHz = 120;
    }
    telemetryCollector.updateSessionMetadata(
      this.clockPacingMode,
      this.clockPacingPriority,
      this.clockPacingParams
    );
  }

  setClockPacingPriority(priority: string, telemetryCollector: NetworkTelemetryCollector): boolean {
    if (typeof priority === 'string' && priority.length > 0) {
      this.clockPacingPriority = priority;
      telemetryCollector.updateSessionMetadata(
        this.clockPacingMode,
        this.clockPacingPriority,
        this.clockPacingParams
      );
      return true;
    }
    return false;
  }

  setClockPacingParams(
    params: PacingControllerParams,
    breakdown: LatencyBreakdownResult,
    metrics: ReconcilerMetrics,
    telemetryCollector: NetworkTelemetryCollector
  ): boolean {
    if (!params || typeof params !== 'object') return false;
    this.clockPacingParams = { ...(this.clockPacingParams || {}), ...params };
    if (typeof params.targetBufferTicks === 'number' && Number.isFinite(params.targetBufferTicks)) {
      const rounded = Math.max(1, Math.min(12, Math.round(params.targetBufferTicks)));
      if (rounded !== this.inputBufferTarget) {
        this.forceTargetAlign = true;
        this.inputBufferTarget = rounded;
      }
    }
    if (
      typeof params.deadbandCatchupOffset === 'number' &&
      Number.isFinite(params.deadbandCatchupOffset)
    ) {
      this.catchupThresholdOffset = Math.min(0, Math.round(params.deadbandCatchupOffset));
    }
    if (
      typeof params.deadbandSkipOffset === 'number' &&
      Number.isFinite(params.deadbandSkipOffset)
    ) {
      this.skipThresholdOffset = Math.max(0, Math.round(params.deadbandSkipOffset));
    }
    this.leadTicks = this.calculateLeadTicks(breakdown, breakdown.rttMs);
    metrics.leadTicks = this.leadTicks;
    telemetryCollector.updateSessionMetadata(
      this.clockPacingMode,
      this.clockPacingPriority,
      this.clockPacingParams
    );
    return true;
  }

  setInputBufferTarget(
    target: number,
    breakdown: LatencyBreakdownResult,
    metrics: ReconcilerMetrics
  ): boolean {
    if (typeof target === 'number' && Number.isFinite(target) && target >= 1) {
      const rounded = Math.max(1, Math.min(12, Math.round(target)));
      if (rounded !== this.inputBufferTarget) this.forceTargetAlign = true;
      this.inputBufferTarget = rounded;
      if (this.clockPacingParams) this.clockPacingParams.targetBufferTicks = rounded;
      this.leadTicks = this.calculateLeadTicks(breakdown, breakdown.rttMs);
      metrics.leadTicks = this.leadTicks;
      return true;
    }
    return false;
  }

  setInputBufferThresholds(catchupOffset: number, skipOffset: number): void {
    if (typeof catchupOffset === 'number' && Number.isFinite(catchupOffset)) {
      this.catchupThresholdOffset = Math.min(0, Math.round(catchupOffset));
      if (this.clockPacingParams) {
        this.clockPacingParams.deadbandCatchupOffset = this.catchupThresholdOffset;
      }
    }
    if (typeof skipOffset === 'number' && Number.isFinite(skipOffset)) {
      this.skipThresholdOffset = Math.max(0, Math.round(skipOffset));
      if (this.clockPacingParams) {
        this.clockPacingParams.deadbandSkipOffset = this.skipThresholdOffset;
      }
    }
  }

  stepPacing(
    currentClientTick: number,
    currentDelta: number,
    targetDelta: number,
    rttMs: number,
    ctx: ClientClockPacingStepContext
  ): number {
    const decision = evaluatePacingModulationDecision(ctx.telemetryCollector.pacingControllerState, {
      currentClientTick,
      currentDelta,
      targetDelta,
      effectiveRtt: rttMs,
      nowMs: ctx.nowMs,
      channel: ctx.channel,
      kickoffMaskUntilTick: ctx.kickoffMaskUntilTick,
      inputBufferTarget: this.inputBufferTarget,
      catchupThresholdOffset: this.catchupThresholdOffset,
      skipThresholdOffset: this.skipThresholdOffset,
      hasServerReportedBuffer: ctx.hasServerReportedBuffer,
      reportedInputBufferSize: ctx.metrics?.inputBufferSize,
      clockPacingMode: this.clockPacingMode,
      clockPacingParams: this.clockPacingParams,
      forceTargetAlign: this.forceTargetAlign,
    });
    if (decision.clearForceTargetAlign) this.forceTargetAlign = false;
    if (decision.interpolatorRateHz !== null) {
      ctx.interpolator?.setPhysicsRate?.(decision.interpolatorRateHz);
    }

    let updatedClientTick = currentClientTick;
    let stepCatchup = false;
    let stepSkip = false;
    const savedLobbyEntities = saveClientLobbyLocalEntities(ctx.sim, ctx.lobbyDualWorldMode);
    if (decision.action === 'skip') {
      updatedClientTick = decision.desiredClientTick;
      ctx.sim.restoreStateSlot(updatedClientTick % 256);
      stepSkip = true;
    } else if (decision.action === 'catchup') {
      updatedClientTick = ctx.stepForwardTicks(
        currentClientTick,
        decision.desiredClientTick,
        false,
        ctx.nowMs
      );
      stepCatchup = true;
    }
    if (savedLobbyEntities && (stepCatchup || stepSkip)) {
      restoreClientLobbyLocalEntities(
        ctx.sim,
        ctx.lobbyDualWorldMode,
        ctx.localCarIndex,
        ctx.lastLocalControls,
        savedLobbyEntities
      );
    }

    const { stepOut, rawServerBuffer, hasServerBuf } = decision;
    if (ctx.metrics) {
      ctx.metrics.applyPacingStep(stepOut, rawServerBuffer, hasServerBuf);
    }
    ctx.telemetryCollector.lastPacingStepStatus = {
      stepOut,
      rawServerBuffer,
      stepCatchup,
      stepSkip,
      nowMs: ctx.nowMs,
    };
    return updatedClientTick;
  }
}

export default ClientClockPacingController;
