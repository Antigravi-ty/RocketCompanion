/**
 * PredictionReconciler.ts
 * Client-side predictive timeline coordinator orchestrating history buffer,
 * visual smoother, telemetry collector, clock pacing, rollback stepper & control messenger.
 */

import {
  PredictionHistoryBuffer, NEUTRAL_CAR_CONTROLS,
  type CarControls, type ReconciliationTolerances,
} from './PredictionHistoryBuffer.ts';
import { VisualErrorSmoother, type Vector3Like } from './VisualErrorSmoother.ts';
import { NetworkTelemetryCollector } from './NetworkTelemetryCollector.ts';
import {
  createInitialReconcilerMetrics, type HandshakeResponsePayload, type LatencyBreakdownResult,
  type PredictionReconcilerOptions, type ReconcilerMetrics, type RosterStatePayload,
  type TelemetryChannelPort, type TelemetryRecorderPort, type TelemetrySimPort, type TopologyPacketPort,
} from './ReconcilerMetricsModel.ts';
import {
  ClientClockPacingController, type ClockPacingInterpolatorPort as InterpolatorPort,
} from './ClientClockPacingController.ts';
import { createBoostPadEdgeTracker } from '../protocol/boostPadBitmaskPipeline.ts';
import type { MatchSignalDescriptor as ServerSignalEntry } from '../protocol/GlobalPayloadCodec.ts';
import {
  ReconcilerControlMessenger, type FlushPendingControlContext,
  type OutboundRedundantInputConfig, type ParsedReconcilerPacket as ParsedServerPacketSnapshot,
} from './ReconcilerControlMessenger.ts';
import {
  ReconcilerRollbackStepper, type ReconcileSessionTarget,
  type ReconcilerHardResyncCallback, type ReconcilerMessageCallback,
  type ReconcilerSignalsCallback, type RollbackStepState,
} from './ReconcilerRollbackStepper.ts';
import {
  applyReconcilerInitialOptions,
  applySessionReconciliationTolerances,
  commitPredictedLocalStep,
  resetReconcilerCorrectionStats,
  resetRollbackSessionTimeline,
  syncSessionMetricsAndEmit,
} from './reconcilerSessionPipeline.ts';
import type { DumpedNetworkPacket } from '../diagnostics/PacketDumpDiagnostics.ts';
import { globalPacingTelemetryRecorder } from '../../game/runtimeUiPort.ts';
import type { PacingControllerParams } from '../../ui-core/config/pacingControllerEvaluator.ts';

export type ReconcilerSimPort = TelemetrySimPort;
export type ReconciliationPacketPort = TopologyPacketPort & Partial<ParsedServerPacketSnapshot>;
export type ReconcilerMetricsCallback = (metrics: ReconcilerMetrics) => void;
export type {
  HandshakeResponsePayload, PredictionReconcilerOptions, RosterStatePayload, ServerSignalEntry,
};

export class PredictionReconciler implements RollbackStepState, FlushPendingControlContext, ReconcileSessionTarget {
  sim: ReconcilerSimPort;
  channel: TelemetryChannelPort | null | undefined;
  options: PredictionReconcilerOptions;
  localCarIndex = 0;
  readonly capacity = 1024;
  readonly mask = 1023;
  readonly tickDtMs = 1000.0 / 120.0;
  readonly historyBuffer = new PredictionHistoryBuffer(1024, 256);
  readonly visualSmoother: VisualErrorSmoother;
  readonly telemetryCollector: NetworkTelemetryCollector;
  readonly pacingController: ClientClockPacingController;
  readonly controlMessenger = new ReconcilerControlMessenger();
  readonly rollbackStepper = new ReconcilerRollbackStepper();
  readonly neutralControls: Readonly<CarControls> = NEUTRAL_CAR_CONTROLS;
  readonly addMetricsListener: (fn: ReconcilerMetricsCallback) => () => void;
  redundantHistoryCount = 1;
  useBitPacking = false;
  lastAckedServerTick = -1;
  lastServerRecordedInputTick = -1;
  totalCorrections = 0;
  skippedCorrections = 0;
  hardSnapCount = 0;
  maxCorrectionDelta = 0;
  posTolerance = 0.5;
  velTolerance = 5.0;
  rotTolerance = 0.015;
  ballPosTolerance = 1.0;
  ballVelTolerance = 10.0;
  boostTolerance = 1.0;
  hardSnapThreshold = 500.0;
  isTimelineSynchronized = false;
  enableRedundantInputs = false;
  redundantHistoryTicks = 12;
  shouldSkipLocalStep = false;
  interpolator: InterpolatorPort | null = null;
  lastHardResyncTime = 0;
  onHardResync: ReconcilerHardResyncCallback | null = null;
  onSignals: ReconcilerSignalsCallback | null = null;
  onRosterUpdate: ReconcilerMessageCallback<RosterStatePayload> | null = null;
  onHandshakeResponse: ReconcilerMessageCallback<HandshakeResponsePayload> | null = null;
  kickoffMaskUntilTick = -1;
  carVisualPresets = new Map<number, string>();
  carNames = new Map<number, string>();
  activeCarMask = 0;
  boostPadEdgeTracker = createBoostPadEdgeTracker();
  lobbyDualWorldMode = false;
  hostLobbyMode = false;
  replayPlaybackMode = false;
  localSkipReplayReady = false;
  lobbyPrevAuthoritativeState: Float32Array | null = null;
  lobbyCurrAuthoritativeState: Float32Array | null = null;
  metrics: ReconcilerMetrics;
  onMetricsUpdated: ReconcilerMetricsCallback | null = null;

  constructor(
    clientSim: ReconcilerSimPort | null,
    channel: TelemetryChannelPort | null | undefined,
    opts: PredictionReconcilerOptions = {}
  ) {
    this.sim = clientSim as ReconcilerSimPort;
    this.channel = channel;
    this.options = opts;
    this.visualSmoother = new VisualErrorSmoother(opts.enableSmoothing ?? false, 18.0, 300.0);
    this.pacingController = new ClientClockPacingController(opts);
    const telemetryActive =
      opts.isMatchTelemetryActive !== undefined
        ? Boolean(opts.isMatchTelemetryActive)
        : !opts.lobbyDualWorldMode;
    this.telemetryCollector = new NetworkTelemetryCollector(
      opts.telemetryRecorder || (globalPacingTelemetryRecorder as TelemetryRecorderPort),
      telemetryActive
    );
    this.addMetricsListener = this.telemetryCollector.addListener.bind(this.telemetryCollector);
    applyReconcilerInitialOptions(this, opts);
    this.leadTicks = this.calculateLeadTicks();
    this.metrics = createInitialReconcilerMetrics(
      this.leadTicks,
      this.pacingController.inputBufferTarget
    );
  }

  get leadTicks(): number {
    return this.pacingController.leadTicks;
  }
  set leadTicks(v: number) {
    this.pacingController.leadTicks = v;
  }
  get enableSmoothing(): boolean {
    return this.visualSmoother.enabled;
  }
  set enableSmoothing(value: boolean) {
    this.visualSmoother.setEnabled(value);
  }
  get lastParsedPacket(): ParsedServerPacketSnapshot | null {
    return this.controlMessenger.lastParsedPacket;
  }
  get drainedReplayPackets(): ParsedServerPacketSnapshot[] {
    return this.controlMessenger.drainedReplayPackets;
  }
  get serverTick(): number {
    return this.lastAckedServerTick >= 0 ? this.lastAckedServerTick : (this.metrics?.serverTick ?? 0);
  }

  getOutboundRedundantConfig(): OutboundRedundantInputConfig {
    return {
      redundantHistoryCount: this.redundantHistoryCount,
      enableRedundantInputs: this.enableRedundantInputs,
      redundantHistoryTicks: this.redundantHistoryTicks,
      tickDtMs: this.tickDtMs,
      lastServerRecordedInputTick: this.lastServerRecordedInputTick,
    };
  }

  getReconciliationTolerances(): ReconciliationTolerances {
    return {
      posTolerance: this.posTolerance, velTolerance: this.velTolerance, rotTolerance: this.rotTolerance,
      ballPosTolerance: this.ballPosTolerance, ballVelTolerance: this.ballVelTolerance,
      boostTolerance: this.boostTolerance, hardSnapThreshold: this.hardSnapThreshold,
    };
  }

  setMatchTelemetryActive(enabled: boolean, resetRecorder = false): void {
    this.telemetryCollector.isMatchTelemetryActive = Boolean(enabled);
    if (resetRecorder) this.pacingController.resetTelemetry(this.telemetryCollector);
  }

  setLobbyDualWorldMode(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.lobbyDualWorldMode !== next) this.resetTimelineState();
    this.lobbyDualWorldMode = next;
  }

  setReplayPlaybackMode(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.replayPlaybackMode !== next) {
      this.localSkipReplayReady = false;
      this.controlMessenger.drainedReplayPackets.length = 0;
    }
    if (this.replayPlaybackMode && !next) this.resetTimelineState();
    this.replayPlaybackMode = next;
  }

  resetTimelineState(): void {
    resetRollbackSessionTimeline(this);
  }

  _resolveLatencyBreakdown(): LatencyBreakdownResult {
    return this.pacingController.resolveLatencyBreakdown(
      this.channel, this.controlMessenger.baseMeasuredRtt, this.controlMessenger.measuredRtt,
      this.controlMessenger.hasServerReportedBuffer, this.metrics?.inputBufferSize
    );
  }

  _resolveEffectiveRtt(): number {
    return this._resolveLatencyBreakdown().rttMs;
  }

  setClockPacingMode(mode: string): void {
    this.pacingController.setClockPacingMode(mode, this.interpolator, this.metrics, this.telemetryCollector);
    this.notifyMetricsUpdated();
  }

  setClockPacingPriority(priority: string): void {
    if (this.pacingController.setClockPacingPriority(priority, this.telemetryCollector)) this.notifyMetricsUpdated();
  }

  setClockPacingParams(params: PacingControllerParams): void {
    if (this.pacingController.setClockPacingParams(params, this._resolveLatencyBreakdown(), this.metrics, this.telemetryCollector)) {
      this.notifyMetricsUpdated();
    }
  }

  setInputBufferTarget(target: number): void {
    if (this.pacingController.setInputBufferTarget(target, this._resolveLatencyBreakdown(), this.metrics)) {
      this.notifyMetricsUpdated();
    }
  }

  setInputBufferThresholds(catchupOffset: number, skipOffset: number): void {
    this.pacingController.setInputBufferThresholds(catchupOffset, skipOffset);
    this.notifyMetricsUpdated();
  }

  setEnableSmoothing(enabled: boolean): void {
    this.visualSmoother.setEnabled(enabled);
    this.metrics.applySmoothingToggle(this.visualSmoother.enabled);
    this.notifyMetricsUpdated();
  }

  setReconciliationTolerances(tolerances: Partial<ReconciliationTolerances> = {}): void {
    applySessionReconciliationTolerances(this, tolerances ?? {});
  }

  notifyMetricsUpdated(): void {
    syncSessionMetricsAndEmit(this);
  }

  calculateLeadTicks(rttMs?: number): number {
    return this.pacingController.calculateLeadTicks(this._resolveLatencyBreakdown(), rttMs);
  }

  setKickoffMaskUntilTick(targetTick: number): void {
    this.kickoffMaskUntilTick = typeof targetTick === 'number' ? targetTick : -1;
  }

  setCarVisualPreset(carIndex: number, visualId: string): void {
    if (typeof carIndex === 'number' && carIndex >= 0 && visualId) this.carVisualPresets.set(carIndex, visualId);
  }

  flushPendingControlPackets(nowMs = performance.now()): void {
    const ts = Number.isFinite(nowMs) ? nowMs : performance.now();
    this.controlMessenger.flushPendingControlPackets(this, ts);
  }

  syncTimeline(serverSnapshot: Float32Array | null, serverTick = 0, nowMs = performance.now()): void {
    const tick = Number.isFinite(serverTick) ? serverTick : 0;
    this.rollbackStepper.syncSessionTimeline(this, serverSnapshot, tick, nowMs);
  }

  sampleAndPredictInput(carIndex: number, controls: CarControls, nowMs = performance.now()): CarControls {
    const { committed, shouldNotifyMetrics } = commitPredictedLocalStep(this, carIndex, controls, nowMs);
    if (shouldNotifyMetrics) this.notifyMetricsUpdated();
    return committed;
  }

  reconcile(nowMs = performance.now()): void {
    const incomingPackets = this.controlMessenger.receiveChannelPackets(this.channel, nowMs);
    if (!incomingPackets || incomingPackets.length === 0) return;
    this.rollbackStepper.reconcileInboundBatch(this, incomingPackets, nowMs);
  }

  updateSmoothing(deltaSeconds: number): Vector3Like {
    const offset = this.visualSmoother.stepDecay(deltaSeconds);
    this.metrics.smoothingMagnitude = this.visualSmoother.getMagnitude();
    return offset;
  }

  dumpPacket(packetOrRaw: unknown = null): DumpedNetworkPacket | null {
    const target = packetOrRaw || this.controlMessenger.lastParsedPacket || this.controlMessenger.lastReceivedPacketRaw;
    return this.controlMessenger.dumpPacket(target as never);
  }

  resetStats(): void {
    resetReconcilerCorrectionStats(this);
  }
}

export default PredictionReconciler;
