/**
 * PredictionReconciler.ts
 * Client-side predictive timeline coordinator orchestrating history buffer,
 * visual smoother, telemetry collector, clock pacing, rollback stepper & control messenger.
 */

import {
  PredictionHistoryBuffer, NEUTRAL_CAR_CONTROLS,
  type CarControls, type LocalClientInputBuffer, type ReconciliationTolerances,
} from './PredictionHistoryBuffer.ts';
import { VisualErrorSmoother, type Vector3Like } from './VisualErrorSmoother.ts';
import { NetworkTelemetryCollector } from './NetworkTelemetryCollector.ts';
import {
  createInitialReconcilerMetrics,
  type HandshakeResponsePayload, type LatencyBreakdownResult, type PredictionReconcilerOptions,
  type ReconcilerMetrics, type RosterStatePayload, type TelemetryChannelPort,
  type TelemetryRecorderPort, type TelemetrySimPort, type TopologyPacketPort,
} from './ReconcilerMetricsModel.ts';
import {
  ClientClockPacingController,
  type ClockPacingInterpolatorPort as InterpolatorPort,
} from './ClientClockPacingController.ts';
import {
  createBoostPadEdgeTracker,
  type MatchSignalDescriptor as ServerSignalEntry,
} from '../protocol/GlobalPayloadCodec.ts';
import {
  ReconcilerControlMessenger,
  type ParsedReconcilerPacket as ParsedServerPacketSnapshot,
} from './ReconcilerControlMessenger.ts';
import { ReconcilerRollbackStepper } from './ReconcilerRollbackStepper.ts';
import type { DumpedNetworkPacket } from '../diagnostics/PacketDumpDiagnostics.ts';
import { globalPacingTelemetryRecorder } from '../../game/runtimeUiPort.ts';
import type { PacingControllerParams } from '../../ui-core/config/pacingControllerEvaluator';

export type ReconcilerSimPort = TelemetrySimPort;
export type ReconciliationPacketPort = TopologyPacketPort & Partial<ParsedServerPacketSnapshot>;
export type { HandshakeResponsePayload, PredictionReconcilerOptions, RosterStatePayload };

export class PredictionReconciler {
  sim: ReconcilerSimPort;
  channel: TelemetryChannelPort | null | undefined;
  options: PredictionReconcilerOptions;
  localCarIndex: number;
  readonly capacity = 1024;
  readonly mask = 1023;
  readonly tickDtMs = 1000.0 / 120.0;
  readonly historyBuffer = new PredictionHistoryBuffer(1024, 256);
  readonly visualSmoother: VisualErrorSmoother;
  readonly telemetryCollector: NetworkTelemetryCollector;
  readonly pacingController: ClientClockPacingController;
  readonly controlMessenger = new ReconcilerControlMessenger();
  readonly rollbackStepper = new ReconcilerRollbackStepper();
  redundantHistoryCount: number;
  useBitPacking: boolean;
  readonly neutralControls: Readonly<CarControls> = NEUTRAL_CAR_CONTROLS;
  lastAckedServerTick = -1;
  lastServerRecordedInputTick: number;
  totalCorrections = 0; skippedCorrections = 0; hardSnapCount = 0; maxCorrectionDelta = 0;
  posTolerance: number; velTolerance: number; rotTolerance: number;
  ballPosTolerance: number; ballVelTolerance: number; boostTolerance: number; hardSnapThreshold: number;
  isTimelineSynchronized = false;
  enableRedundantInputs: boolean;
  redundantHistoryTicks: number;
  shouldSkipLocalStep = false;
  interpolator: InterpolatorPort | null;
  _hasServerReportedBuffer = false;
  lastHardResyncTime = 0;
  onHardResync: (() => void) | null;
  onSignals: ((signals: ServerSignalEntry[], packetServerTick?: number | null) => void) | null = null;
  onRosterUpdate: ((msg: RosterStatePayload) => void) | null = null;
  onHandshakeResponse: ((msg: HandshakeResponsePayload) => void) | null = null;
  _lastProcessedClientTimestamp = 0; _baseMeasuredRtt = 0; measuredRtt = 0;
  lastReceivedPacketRaw: unknown = null;
  lastParsedPacket: ParsedServerPacketSnapshot | null = null;
  kickoffMaskUntilTick = -1;
  carVisualPresets = new Map<number, string>();
  carNames = new Map<number, string>();
  activeCarMask = 0;
  boostPadEdgeTracker = createBoostPadEdgeTracker();
  lobbyDualWorldMode: boolean; hostLobbyMode: boolean;
  replayPlaybackMode = false; localSkipReplayReady = false;
  drainedReplayPackets: ParsedServerPacketSnapshot[] = [];
  lobbyPrevAuthoritativeState: Float32Array | null = null;
  lobbyCurrAuthoritativeState: Float32Array | null = null;
  metrics: ReconcilerMetrics;
  onMetricsUpdated: ((metrics: ReconcilerMetrics) => void) | null = null;

  constructor(
    clientSim: ReconcilerSimPort | null,
    channel: TelemetryChannelPort | null | undefined,
    opts: PredictionReconcilerOptions = {}
  ) {
    this.sim = clientSim as ReconcilerSimPort;
    this.channel = channel;
    this.options = opts;
    this.localCarIndex = opts.localCarIndex ?? 0;
    this.visualSmoother = new VisualErrorSmoother(opts.enableSmoothing ?? false, 18.0, 300.0);
    this.pacingController = new ClientClockPacingController(opts);
    this.redundantHistoryCount = opts.redundantHistoryCount ?? (opts.enableRedundantBuffer ? 10 : 1);
    this.useBitPacking = opts.useBitPacking ?? false;
    this.lastServerRecordedInputTick = Math.max(-1, Math.floor(this.sim?.getHeaderView?.()?.tickCount || 0) - 1);
    this.posTolerance = opts.posTolerance ?? 0.5; this.velTolerance = opts.velTolerance ?? 5.0;
    this.rotTolerance = opts.rotTolerance ?? 0.015; this.ballPosTolerance = opts.ballPosTolerance ?? 1.0;
    this.ballVelTolerance = opts.ballVelTolerance ?? 10.0; this.boostTolerance = opts.boostTolerance ?? 1.0;
    this.hardSnapThreshold = opts.hardSnapThreshold ?? 500.0;
    this.enableRedundantInputs = opts.enableRedundantInputs ?? false;
    this.redundantHistoryTicks = opts.redundantHistoryTicks ?? 12; this.interpolator = opts.interpolator || null;
    this.lobbyDualWorldMode = Boolean(opts.lobbyDualWorldMode);
    this.hostLobbyMode = Boolean(opts.hostLobbyMode ?? (this.channel?.isLoopback && !opts.lobbyDualWorldMode));
    const telemetryActive = opts.isMatchTelemetryActive !== undefined ? Boolean(opts.isMatchTelemetryActive) : !this.lobbyDualWorldMode;
    this.telemetryCollector = new NetworkTelemetryCollector(
      opts.telemetryRecorder || (globalPacingTelemetryRecorder as TelemetryRecorderPort), telemetryActive
    );
    if (opts.resetTelemetryOnStart !== false) this.pacingController.resetTelemetry(this.telemetryCollector);
    this.onHardResync = opts.onHardResync || null;
    this.leadTicks = this.calculateLeadTicks();
    this.metrics = createInitialReconcilerMetrics(this.leadTicks, this.pacingController.inputBufferTarget);
  }

  get clientInputRingBuffer(): LocalClientInputBuffer { return this.historyBuffer.clientInputRingBuffer; }
  get leadTicks(): number { return this.pacingController.leadTicks; }
  set leadTicks(v: number) { this.pacingController.leadTicks = v; }
  get enableSmoothing(): boolean { return this.visualSmoother.enabled; }
  set enableSmoothing(value: boolean) { this.visualSmoother.setEnabled(value); }
  get serverTick(): number { return this.lastAckedServerTick >= 0 ? this.lastAckedServerTick : (this.metrics?.serverTick ?? 0); }

  getPreviousCommittedControls(tick: number, carIndex = this.localCarIndex): CarControls { return this.historyBuffer.getPreviousCommittedControls(tick, carIndex, this.localCarIndex); }

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
      this.drainedReplayPackets.length = 0;
    }
    if (this.replayPlaybackMode && !next) this.resetTimelineState();
    this.replayPlaybackMode = next;
  }

  resetTimelineState(): void {
    this.isTimelineSynchronized = false; this._hasServerReportedBuffer = false; this.lastAckedServerTick = -1;
    this.lastServerRecordedInputTick = Math.max(-1, Math.floor(this.sim?.getHeaderView?.()?.tickCount || 0) - 1);
    if (this.metrics) this.metrics.serverTick = 0;
    this.lastHardResyncTime = 0; this.telemetryCollector.pacingControllerState = { initialized: false };
    this.boostPadEdgeTracker = createBoostPadEdgeTracker();
    this.historyBuffer.clear(); this.visualSmoother.reset(); this.drainedReplayPackets.length = 0;
  }

  _resolveLatencyBreakdown(): LatencyBreakdownResult { return this.pacingController.resolveLatencyBreakdown(this.channel, this._baseMeasuredRtt, this.measuredRtt, this._hasServerReportedBuffer, this.metrics?.inputBufferSize); }

  _resolveEffectiveRtt(): number { return this._resolveLatencyBreakdown().rttMs; }

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

  addMetricsListener(fn: (metrics: ReconcilerMetrics) => void): () => void { return this.telemetryCollector.addListener(fn); }

  setEnableSmoothing(enabled: boolean): void {
    this.visualSmoother.setEnabled(enabled);
    this.metrics.applySmoothingToggle(this.visualSmoother.enabled);
    this.notifyMetricsUpdated();
  }

  setReconciliationTolerances(tolerances: Partial<ReconciliationTolerances> = {}): void {
    const nonNeg = (v: number | undefined, cur: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : cur);
    this.posTolerance = nonNeg(tolerances.posTolerance, this.posTolerance);
    this.velTolerance = nonNeg(tolerances.velTolerance, this.velTolerance);
    this.rotTolerance = nonNeg(tolerances.rotTolerance, this.rotTolerance);
    this.ballPosTolerance = nonNeg(tolerances.ballPosTolerance, this.ballPosTolerance);
    this.ballVelTolerance = nonNeg(tolerances.ballVelTolerance, this.ballVelTolerance);
    if (typeof tolerances.hardSnapThreshold === 'number' && Number.isFinite(tolerances.hardSnapThreshold) && tolerances.hardSnapThreshold > 0) {
      this.hardSnapThreshold = tolerances.hardSnapThreshold;
    }
    this.notifyMetricsUpdated();
  }

  notifyMetricsUpdated(): void {
    this.pacingController.syncLatencyBreakdownToMetrics(
      this.channel, this._baseMeasuredRtt, this.measuredRtt,
      this._hasServerReportedBuffer, this.metrics,
      this.visualSmoother.enabled, this.historyBuffer.capacity
    );
    this.telemetryCollector.emitMetrics(this.metrics, this.onMetricsUpdated);
  }

  calculateLeadTicks(rttMs?: number): number { return this.pacingController.calculateLeadTicks(this._resolveLatencyBreakdown(), rttMs); }

  acknowledgeSignal(signalId: number, signalType: number, repeatCount = 8): void { this.controlMessenger.acknowledgeSignal(signalId, signalType, repeatCount); }
  queueClientCommand(commandType: number, param1 = 0, param2 = 0, maxSends = 240): number { return this.controlMessenger.enqueueClientCommand(commandType, param1, param2, maxSends); }

  resolveClientCommandAck(commandId: number): void { this.controlMessenger.resolveClientCommandAck(commandId); }
  setKickoffMaskUntilTick(targetTick: number): void { this.kickoffMaskUntilTick = typeof targetTick === 'number' ? targetTick : -1; }
  setCarVisualPreset(carIndex: number, visualId: string): void {
    if (typeof carIndex === 'number' && carIndex >= 0 && visualId) this.carVisualPresets.set(carIndex, visualId);
  }

  sendOutboundInputForTick(tick: number, carIndex = this.localCarIndex, controls: CarControls | null = null, nowMs = performance.now()): void { this.controlMessenger.sendOutboundInputForTick(this, tick, carIndex, controls, nowMs); }
  flushPendingControlPackets(nowMs = performance.now()): void { this.controlMessenger.flushPendingControlPackets(this, nowMs); }

  syncTimeline(serverSnapshot: Float32Array | null, serverTick = 0, nowMs = performance.now()): void {
    const targets = this.pacingController.evaluateTimelineTargets(
      this.channel, this._baseMeasuredRtt, this.measuredRtt,
      this._hasServerReportedBuffer, this.metrics?.inputBufferSize, this._resolveEffectiveRtt()
    );
    this.leadTicks = targets.leadTicks;
    const syncOut = this.rollbackStepper.executeSyncTimeline({
      sim: this.sim, historyBuffer: this.historyBuffer, visualSmoother: this.visualSmoother,
      metrics: this.metrics, serverSnapshot, serverTick, nowMs, localCarIndex: this.localCarIndex,
      lobbyDualWorldMode: this.lobbyDualWorldMode, kickoffMaskUntilTick: this.kickoffMaskUntilTick,
      leadTicks: this.leadTicks, downlinkTicks: targets.downlinkTicks, hardSnapCount: this.hardSnapCount,
      isRedundant: this.redundantHistoryCount > 1 || Boolean(this.enableRedundantInputs),
      sendOutboundInput: (t, ctrl, ts) => this.sendOutboundInputForTick(t, this.localCarIndex, ctrl, ts),
    });
    this.lastServerRecordedInputTick = syncOut.lastServerRecordedInputTick;
    this.lastAckedServerTick = syncOut.lastAckedServerTick;
    this.isTimelineSynchronized = true; this.shouldSkipLocalStep = false;
    this.lastHardResyncTime = syncOut.lastHardResyncTime; this.hardSnapCount = syncOut.hardSnapCount;
    this.notifyMetricsUpdated();
  }

  sampleAndPredictInput(carIndex: number, controls: CarControls, nowMs = performance.now()): CarControls { return this.controlMessenger.sampleAndCommitLocalStep(this, carIndex, controls, nowMs); }

  reconcile(nowMs = performance.now()): void { this.rollbackStepper.executeReconcileStep(this, nowMs); }
  updateSmoothing(deltaSeconds: number): Vector3Like { return this.visualSmoother.stepDecay(deltaSeconds); }
  triggerDumpNextPacket(): Promise<DumpedNetworkPacket | null> { return this.controlMessenger.triggerDumpNextPacket(); }
  dumpPacket(packetOrRaw: unknown = null): DumpedNetworkPacket | null { return this.controlMessenger.dumpPacket((packetOrRaw || this.lastParsedPacket || this.lastReceivedPacketRaw) as never); }
  resetStats(): void {
    this.totalCorrections = 0; this.skippedCorrections = 0;
    this.hardSnapCount = 0; this.maxCorrectionDelta = 0;
    this.visualSmoother.reset(); this.metrics.resetCorrectionStats();
    this.telemetryCollector.recorder?.reset?.();
  }
}

export default PredictionReconciler;
