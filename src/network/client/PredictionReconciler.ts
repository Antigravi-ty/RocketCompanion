/**
 * PredictionReconciler.ts
 * Client-side predictive timeline coordinator orchestrating:
 * 1. PredictionHistoryBuffer (input ring buffer & historical snapshot delta evaluator)
 * 2. VisualErrorSmoother (post-resimulation discrepancy & exponential visual decay)
 * 3. NetworkTelemetryCollector (latency breakdown, topology sync & telemetry)
 * 4. ClientClockPacingController (stateful clock pacing & lead/downlink tick sub-controller)
 */
import {
  PredictionHistoryBuffer, NEUTRAL_CAR_CONTROLS,
  type CarControls, type ReconciliationTolerances,
} from './PredictionHistoryBuffer.ts';
import {
  VisualErrorSmoother, capturePreResimPositions, type PreResimPositions, type Vector3Like,
} from './VisualErrorSmoother.ts';
import {
  NetworkTelemetryCollector, createInitialReconcilerMetrics, configureClientLobbyDiagnosticProbes,
  saveClientLobbyLocalEntities, restoreClientLobbyLocalEntities,
  syncClientCarTopology, recordReconcileTelemetryTick,
  type LatencyBreakdownResult,
} from './NetworkTelemetryCollector.ts';
import { ClientClockPacingController } from './ClientClockPacingController.ts';
import { createBoostPadEdgeTracker } from '../protocol/GlobalPayloadCodec.ts';
import { ReconcilerControlMessenger } from './ReconcilerControlMessenger.ts';
import { globalPacingTelemetryRecorder } from '../../game/runtimeUiPort.ts';
import type { PacingControllerParams } from '../../ui-core/config/pacingControllerEvaluator';

export interface PredictionReconcilerOptions {
  localCarIndex?: number;
  redundantHistoryCount?: number;
  enableRedundantBuffer?: boolean;
  useBitPacking?: boolean;
  posTolerance?: number;
  velTolerance?: number;
  rotTolerance?: number;
  ballPosTolerance?: number;
  ballVelTolerance?: number;
  boostTolerance?: number;
  hardSnapThreshold?: number;
  inputBufferTarget?: number;
  catchupThresholdOffset?: number;
  skipThresholdOffset?: number;
  maxLeadTicks?: number;
  maxRollbackFrames?: number;
  enableSmoothing?: boolean;
  enableRedundantInputs?: boolean;
  redundantHistoryTicks?: number;
  interpolator?: any;
  clockPacingMode?: string;
  clockPacingPriority?: string;
  clockPacingParams?: PacingControllerParams | null;
  telemetryRecorder?: any;
  resetTelemetryOnStart?: boolean;
  onHardResync?: (() => void) | null;
  lobbyDualWorldMode?: boolean;
  hostLobbyMode?: boolean;
  isMatchTelemetryActive?: boolean;
}

export class PredictionReconciler {
  sim: any;
  channel: any;
  options: PredictionReconcilerOptions;
  localCarIndex: number;
  readonly capacity = 1024;
  readonly mask = 1023;
  readonly historyBuffer: PredictionHistoryBuffer;
  readonly visualSmoother: VisualErrorSmoother;
  readonly telemetryCollector: NetworkTelemetryCollector;
  readonly pacingController: ClientClockPacingController;
  readonly controlMessenger = new ReconcilerControlMessenger();
  redundantHistoryCount: number;
  useBitPacking: boolean;
  readonly neutralControls: Readonly<CarControls> = NEUTRAL_CAR_CONTROLS;
  lastAckedServerTick = -1;
  lastServerRecordedInputTick: number;
  totalCorrections = 0;
  skippedCorrections = 0;
  hardSnapCount = 0;
  maxCorrectionDelta = 0;
  posTolerance: number;
  velTolerance: number;
  rotTolerance: number;
  ballPosTolerance: number;
  ballVelTolerance: number;
  boostTolerance: number;
  hardSnapThreshold: number;
  isTimelineSynchronized = false;
  enableRedundantInputs: boolean;
  redundantHistoryTicks: number;
  shouldSkipLocalStep = false;
  interpolator: any;
  _hasServerReportedBuffer = false;
  lastHardResyncTime = 0;
  onHardResync: (() => void) | null;
  onSignals: ((signals: any[], packetServerTick?: number | null) => void) | null = null;
  onRosterUpdate: ((msg: any) => void) | null = null;
  onHandshakeResponse: ((msg: any) => void) | null = null;
  _lastProcessedClientTimestamp = 0;
  _baseMeasuredRtt = 0;
  measuredRtt = 0;
  lastReceivedPacketRaw: any = null;
  lastParsedPacket: any = null;
  pendingDumpNextPacket = false;
  _onNextDumpResolve: ((dumped: any) => void) | null = null;
  kickoffMaskUntilTick = -1;
  carVisualPresets = new Map<number, string>();
  carNames = new Map<number, string>();
  activeCarMask = 0;
  boostPadEdgeTracker = createBoostPadEdgeTracker();
  lobbyDualWorldMode: boolean;
  hostLobbyMode: boolean;
  replayPlaybackMode = false;
  localSkipReplayReady = false;
  drainedReplayPackets: any[] = [];
  lobbyPrevAuthoritativeState: Float32Array | null = null;
  lobbyCurrAuthoritativeState: Float32Array | null = null;
  metrics: Record<string, any>;
  onMetricsUpdated: ((metrics: any) => void) | null = null;

  constructor(clientSim: any, channel: any, options: PredictionReconcilerOptions = {}) {
    this.sim = clientSim;
    this.channel = channel;
    this.options = options;
    this.localCarIndex = options.localCarIndex ?? 0;
    this.historyBuffer = new PredictionHistoryBuffer(this.capacity, 256);
    this.visualSmoother = new VisualErrorSmoother(options.enableSmoothing ?? false, 18.0, 300.0);
    this.pacingController = new ClientClockPacingController({
      clockPacingMode: options.clockPacingMode,
      clockPacingPriority: options.clockPacingPriority,
      clockPacingParams: options.clockPacingParams,
      inputBufferTarget: options.inputBufferTarget,
      catchupThresholdOffset: options.catchupThresholdOffset,
      skipThresholdOffset: options.skipThresholdOffset,
      maxLeadTicks: options.maxLeadTicks,
    });
    this.redundantHistoryCount = options.redundantHistoryCount ?? (options.enableRedundantBuffer ? 10 : 1);
    this.useBitPacking = options.useBitPacking ?? false;
    const initialSimTick = Math.floor(this.sim?.getHeaderView?.()?.tickCount || 0);
    this.lastServerRecordedInputTick = Math.max(-1, initialSimTick - 1);
    this.posTolerance = options.posTolerance ?? 0.5;
    this.velTolerance = options.velTolerance ?? 5.0;
    this.rotTolerance = options.rotTolerance ?? 0.015;
    this.ballPosTolerance = options.ballPosTolerance ?? 1.0;
    this.ballVelTolerance = options.ballVelTolerance ?? 10.0;
    this.boostTolerance = options.boostTolerance ?? 1.0;
    this.hardSnapThreshold = options.hardSnapThreshold ?? 500.0;
    this.enableRedundantInputs = options.enableRedundantInputs ?? false;
    this.redundantHistoryTicks = options.redundantHistoryTicks ?? 12;
    this.interpolator = options.interpolator || null;
    this.lobbyDualWorldMode = Boolean(options.lobbyDualWorldMode);
    this.hostLobbyMode = Boolean(options.hostLobbyMode ?? (this.channel?.isLoopback && !options.lobbyDualWorldMode));
    const initialTelemetryActive = options.isMatchTelemetryActive !== undefined
      ? Boolean(options.isMatchTelemetryActive) : !this.lobbyDualWorldMode;
    this.telemetryCollector = new NetworkTelemetryCollector(
      options.telemetryRecorder || globalPacingTelemetryRecorder, initialTelemetryActive
    );
    if (options.resetTelemetryOnStart !== false) {
      this.telemetryCollector.reset(
        this.pacingController.clockPacingMode,
        this.pacingController.clockPacingPriority,
        this.pacingController.clockPacingParams,
      );
    }
    this.onHardResync = options.onHardResync || null;
    this.leadTicks = this.calculateLeadTicks();
    this.metrics = createInitialReconcilerMetrics(this.leadTicks, this.pacingController.inputBufferTarget);
  }
  get leadTicks(): number { return this.pacingController.leadTicks; }
  set leadTicks(v: number) { this.pacingController.leadTicks = v; }
  get enableSmoothing(): boolean { return this.visualSmoother.enabled; }
  set enableSmoothing(value: boolean) { this.visualSmoother.setEnabled(value); }
  get serverTick(): number { return this.lastAckedServerTick >= 0 ? this.lastAckedServerTick : (this.metrics?.serverTick ?? 0); }
  private getReconciliationTolerances(): ReconciliationTolerances {
    return {
      posTolerance: this.posTolerance, velTolerance: this.velTolerance, rotTolerance: this.rotTolerance,
      ballPosTolerance: this.ballPosTolerance, ballVelTolerance: this.ballVelTolerance,
      boostTolerance: this.boostTolerance, hardSnapThreshold: this.hardSnapThreshold,
    };
  }
  setMatchTelemetryActive(enabled: boolean, resetRecorder = false): void {
    this.telemetryCollector.isMatchTelemetryActive = Boolean(enabled);
    if (resetRecorder) {
      this.telemetryCollector.reset(
        this.pacingController.clockPacingMode,
        this.pacingController.clockPacingPriority,
        this.pacingController.clockPacingParams,
      );
    }
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
      if (Array.isArray(this.drainedReplayPackets)) this.drainedReplayPackets.length = 0;
    }
    if (this.replayPlaybackMode && !next) this.resetTimelineState();
    this.replayPlaybackMode = next;
  }
  resetTimelineState(): void {
    this.isTimelineSynchronized = false;
    this._hasServerReportedBuffer = false;
    this.lastAckedServerTick = -1;
    const currentSimTick = Math.floor(this.sim?.getHeaderView?.()?.tickCount || 0);
    this.lastServerRecordedInputTick = Math.max(-1, currentSimTick - 1);
    if (this.metrics) this.metrics.serverTick = 0;
    this.lastHardResyncTime = 0;
    this.telemetryCollector.pacingControllerState = { initialized: false };
    this.boostPadEdgeTracker = createBoostPadEdgeTracker();
    this.historyBuffer.clear();
    this.visualSmoother.reset();
    if (Array.isArray(this.drainedReplayPackets)) this.drainedReplayPackets.length = 0;
  }
  _resolveLatencyBreakdown(): LatencyBreakdownResult {
    return this.pacingController.resolveLatencyBreakdown(
      this.channel, this._baseMeasuredRtt, this.measuredRtt,
      this._hasServerReportedBuffer, this.metrics?.inputBufferSize
    );
  }
  _resolveEffectiveRtt(): number { return this._resolveLatencyBreakdown().rttMs; }
  setClockPacingMode(mode: string): void {
    this.pacingController.setClockPacingMode(mode, this.interpolator, this.metrics, this.telemetryCollector);
    this.notifyMetricsUpdated();
  }
  setClockPacingPriority(priority: string): void {
    if (this.pacingController.setClockPacingPriority(priority, this.telemetryCollector)) {
      this.notifyMetricsUpdated();
    }
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
  addMetricsListener(fn: (metrics: any) => void): () => void { return this.telemetryCollector.addListener(fn); }
  setEnableSmoothing(enabled: boolean): void {
    this.visualSmoother.setEnabled(enabled);
    this.metrics.enableSmoothing = this.visualSmoother.enabled;
    if (!this.visualSmoother.enabled) this.metrics.smoothingMagnitude = 0;
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
  calculateLeadTicks(rttMs?: number): number {
    return this.pacingController.calculateLeadTicks(this._resolveLatencyBreakdown(), rttMs);
  }
  calculateDownlinkTicks(rttMs?: number): number {
    return this.pacingController.calculateDownlinkTicks(this._resolveLatencyBreakdown(), rttMs);
  }
  getPreviousCommittedControls(tick: number, carIndex = this.localCarIndex): CarControls {
    return this.historyBuffer.getPreviousCommittedControls(tick, carIndex, this.localCarIndex);
  }
  acknowledgeSignal(signalId: number, signalType: number, repeatCount = 8): void {
    this.controlMessenger.acknowledgeSignal(signalId, signalType, repeatCount);
  }
  acknowledgeServerSignals(signals: any[]): void { this.controlMessenger.acknowledgeServerSignals(signals); }
  enqueueClientCommand(commandType: number, param1 = 0, param2 = 0, maxSends = 60): number {
    return this.controlMessenger.enqueueClientCommand(commandType, param1, param2, maxSends);
  }
  queueClientCommand(commandType: number, param1 = 0, param2 = 0, maxSends = 240): number {
    return this.enqueueClientCommand(commandType, param1, param2, maxSends);
  }
  resolveClientCommandAck(commandId: number): void { this.controlMessenger.resolveClientCommandAck(commandId); }
  setKickoffMaskUntilTick(targetTick: number): void {
    this.kickoffMaskUntilTick = typeof targetTick === 'number' ? targetTick : -1;
  }
  setCarVisualPreset(carIndex: number, visualId: string): void {
    if (typeof carIndex === 'number' && carIndex >= 0 && visualId) this.carVisualPresets.set(carIndex, visualId);
  }
  _collectPiggybackAcksAndCommands(): { acks: any[]; commands: any[] } {
    return this.controlMessenger.collectPiggybackAcksAndCommands();
  }
  sendOutboundInputForTick(tick: number, carIndex = this.localCarIndex, controls: CarControls | null = null, nowMs = performance.now()): void {
    this.controlMessenger.sendOutboundInputForTick(
      {
        channel: this.channel,
        localCarIndex: this.localCarIndex,
        redundantHistoryCount: this.redundantHistoryCount,
        enableRedundantInputs: this.enableRedundantInputs,
        redundantHistoryTicks: this.redundantHistoryTicks,
        tickDtMs: this.pacingController.tickDtMs,
        lastServerRecordedInputTick: this.lastServerRecordedInputTick,
        clientInputRingBuffer: this.historyBuffer.clientInputRingBuffer,
        getPreviousCommittedControls: (t, cIdx) => this.getPreviousCommittedControls(t, cIdx),
      },
      tick,
      carIndex,
      controls,
      nowMs,
    );
  }
  flushPendingControlPackets(nowMs = performance.now()): void {
    this.controlMessenger.flushPendingControlPackets(this, nowMs);
  }
  private stepForwardTicks(fromTick: number, toTick: number, useSilentStep: boolean, nowMs = performance.now()): number {
    const isRedundant = this.redundantHistoryCount > 1 || Boolean(this.enableRedundantInputs);
    const updatedTick = this.historyBuffer.stepSimulationRange(
      this.sim, fromTick, toTick, this.localCarIndex, this.kickoffMaskUntilTick, useSilentStep,
      !isRedundant ? (t, ctrl) => this.sendOutboundInputForTick(t, this.localCarIndex, ctrl, nowMs) : undefined
    );
    if (isRedundant && toTick > fromTick) this.sendOutboundInputForTick(toTick - 1, this.localCarIndex, null, nowMs);
    return updatedTick;
  }

  syncTimeline(serverSnapshot: Float32Array | null, serverTick = 0, nowMs = performance.now()): void {
    const savedLobbyEntities = saveClientLobbyLocalEntities(this.sim, this.lobbyDualWorldMode);
    if (serverSnapshot) this.sim.restoreState(serverSnapshot);
    if (this.lobbyDualWorldMode || (typeof this.sim?.isCarSlotActive === 'function' && (this.sim.isCarSlotActive(6) || this.sim.isCarSlotActive(7)))) {
      configureClientLobbyDiagnosticProbes(this.sim);
    }
    this.lastServerRecordedInputTick = serverTick - 1;
    const effectiveRtt = this._resolveEffectiveRtt();
    this.leadTicks = this.calculateLeadTicks(effectiveRtt);
    const targetDelta = this.leadTicks + this.calculateDownlinkTicks(effectiveRtt);
    this.historyBuffer.backfillMissingLocalInputs(serverTick - 16, serverTick, this.localCarIndex, this.kickoffMaskUntilTick);
    this.stepForwardTicks(serverTick, serverTick + targetDelta, true, nowMs);
    if (savedLobbyEntities) {
      restoreClientLobbyLocalEntities(this.sim, this.lobbyDualWorldMode, this.localCarIndex, this.historyBuffer.lastLocalControls, savedLobbyEntities);
    }
    const currentClientTick = Math.floor(this.sim.getHeaderView().tickCount);
    this.lastAckedServerTick = serverTick;
    this.isTimelineSynchronized = true;
    this.shouldSkipLocalStep = false;
    this.lastHardResyncTime = nowMs;
    this.hardSnapCount = (this.hardSnapCount || 0) + 1;
    this.visualSmoother.reset();
    this.sim.saveStateSlot(currentClientTick % 256);
    this.historyBuffer.saveTickSnapshot(currentClientTick, this.sim);
    this.metrics.reconcileTier = 3;
    this.metrics.hardSnapCount = this.hardSnapCount;
    this.metrics.clientTick = currentClientTick;
    this.metrics.serverTick = serverTick;
    this.metrics.leadTicks = this.leadTicks;
    this.notifyMetricsUpdated();
  }

  sampleAndPredictInput(carIndex: number, controls: CarControls, nowMs = performance.now()): CarControls {
    const currentTick = Math.floor(this.sim.getHeaderView().tickCount);
    const isKickoffMasked = this.kickoffMaskUntilTick > 0 && currentTick < this.kickoffMaskUntilTick;
    const existing = this.historyBuffer.getCarControls(currentTick, carIndex);
    const committedControls = isKickoffMasked
      ? this.historyBuffer.setCarControls(currentTick, carIndex, this.neutralControls)
      : existing || this.historyBuffer.setCarControls(currentTick, carIndex, controls);
    if (carIndex === this.localCarIndex) this.historyBuffer.lastLocalControls = { ...committedControls };
    this.historyBuffer.clientInputRingBuffer.record(currentTick, carIndex, committedControls);
    this.sendOutboundInputForTick(currentTick, carIndex, committedControls, nowMs);
    this.sim.saveStateSlot(currentTick % 256);
    this.historyBuffer.saveTickSnapshot(currentTick, this.sim);
    this.metrics.clientTick = currentTick;
    this.metrics.rttMs = this._resolveEffectiveRtt();
    this.metrics.leadTicks = this.leadTicks;
    if (currentTick % 2 === 0) this.notifyMetricsUpdated();
    return committedControls;
  }

  private modulateClockPacing(currentClientTick: number, currentDelta: number, targetDelta: number, nowMs: number): number {
    this.shouldSkipLocalStep = false;
    return this.pacingController.stepPacing(
      currentClientTick, currentDelta, targetDelta, this._resolveEffectiveRtt(),
      {
        nowMs, sim: this.sim, channel: this.channel, interpolator: this.interpolator,
        telemetryCollector: this.telemetryCollector, metrics: this.metrics,
        kickoffMaskUntilTick: this.kickoffMaskUntilTick, hasServerReportedBuffer: this._hasServerReportedBuffer,
        lobbyDualWorldMode: this.lobbyDualWorldMode, localCarIndex: this.localCarIndex,
        lastLocalControls: this.historyBuffer.lastLocalControls,
        stepForwardTicks: (from, to, silent, ts) => this.stepForwardTicks(from, to, silent, ts),
      }
    );
  }

  private replayAndEvaluateCorrection(
    packet: any, serverTick: number, currentClientTick: number, prePositions: PreResimPositions, numCars: number
  ): void {
    const updatedStats = this.visualSmoother.executeReplayAndEvaluateCorrection({
      sim: this.sim, historyBuffer: this.historyBuffer, packet, serverTick, currentClientTick,
      prePositions, numCars, localCarIndex: this.localCarIndex, lobbyDualWorldMode: this.lobbyDualWorldMode,
      kickoffMaskUntilTick: this.kickoffMaskUntilTick, tolerances: this.getReconciliationTolerances(),
      metrics: this.metrics, skippedCorrections: this.skippedCorrections, hardSnapCount: this.hardSnapCount,
      totalCorrections: this.totalCorrections, maxCorrectionDelta: this.maxCorrectionDelta,
    });
    this.skippedCorrections = updatedStats.skippedCorrections;
    this.hardSnapCount = updatedStats.hardSnapCount;
    this.totalCorrections = updatedStats.totalCorrections;
    this.maxCorrectionDelta = updatedStats.maxCorrectionDelta;
  }

  reconcile(nowMs = performance.now()): void {
    const incomingPackets = this.controlMessenger.receiveChannelPackets(this.channel, nowMs);
    if (!incomingPackets || incomingPackets.length === 0) return;
    const packet = this.controlMessenger.drainAndParseServerPackets({
      channel: this.channel, lobbyDualWorldMode: this.lobbyDualWorldMode, hostLobbyMode: this.hostLobbyMode,
      replayPlaybackMode: this.replayPlaybackMode, inputBufferTarget: this.pacingController.inputBufferTarget,
      metrics: this.metrics, boostPadEdgeTracker: this.boostPadEdgeTracker,
      isTimelineSynchronized: () => this.isTimelineSynchronized,
      onSignals: this.onSignals, onRosterUpdate: this.onRosterUpdate, onHandshakeResponse: this.onHandshakeResponse,
      setLocalCarIndex: (id) => { this.localCarIndex = id; },
      setLobbyDualWorldMode: (en) => this.setLobbyDualWorldMode(en),
      setLobbyAuthoritativeSnapshots: (prev, curr) => { this.lobbyPrevAuthoritativeState = prev; this.lobbyCurrAuthoritativeState = curr; },
      syncTimelineFromHandshake: (snap, frame, ts) => { this.syncTimeline(snap, frame, ts); this.interpolator?.sync?.(ts); },
    }, incomingPackets, nowMs);
    this._hasServerReportedBuffer = this.controlMessenger.hasServerReportedBuffer;
    this.lastServerRecordedInputTick = this.controlMessenger.lastServerRecordedInputTick;
    this._lastProcessedClientTimestamp = this.controlMessenger.lastProcessedClientTimestamp;
    this._baseMeasuredRtt = this.controlMessenger.baseMeasuredRtt;
    this.measuredRtt = this.controlMessenger.measuredRtt;
    this.lastReceivedPacketRaw = this.controlMessenger.lastReceivedPacketRaw;
    this.drainedReplayPackets = this.controlMessenger.drainedReplayPackets;
    if (!packet) return;
    const serverTick = packet.serverTick;
    if (!this.replayPlaybackMode && serverTick <= this.lastAckedServerTick && serverTick > 0) return;
    this.lastAckedServerTick = serverTick;
    this.metrics.serverTick = serverTick;
    const effectiveRtt = this._resolveEffectiveRtt();
    this.metrics.rttMs = effectiveRtt;
    const maxAckCarIndex = this.historyBuffer.recordAcknowledgedRemoteControls(packet.acknowledgedControls, this.localCarIndex);
    this.lastParsedPacket = packet;
    this.controlMessenger.recordLatestParsedPacket(packet);
    if (this.lobbyDualWorldMode && packet.stateSnapshot && packet.stateSnapshot.length >= 410) {
      if (!this.lobbyCurrAuthoritativeState || this.lobbyCurrAuthoritativeState.length !== packet.stateSnapshot.length) {
        this.lobbyPrevAuthoritativeState = new Float32Array(packet.stateSnapshot);
        this.lobbyCurrAuthoritativeState = new Float32Array(packet.stateSnapshot);
      } else {
        this.lobbyPrevAuthoritativeState!.set(this.lobbyCurrAuthoritativeState);
        this.lobbyCurrAuthoritativeState.set(packet.stateSnapshot);
      }
    }
    if (this.replayPlaybackMode) {
      this.notifyMetricsUpdated();
      return;
    }
    const topologyResult = syncClientCarTopology({
      sim: this.sim, packet, maxAckCarIndex, localCarIndex: this.localCarIndex,
      lobbyDualWorldMode: this.lobbyDualWorldMode, hostLobbyMode: this.hostLobbyMode,
      isLoopback: Boolean(this.channel?.isLoopback), carVisualPresets: this.carVisualPresets,
    });
    if (topologyResult.activeCarMask !== undefined) this.activeCarMask = topologyResult.activeCarMask;
    if (topologyResult.invalidateTimelineSync) this.isTimelineSynchronized = false;
    if (topologyResult.shouldNotifyMetrics) this.notifyMetricsUpdated();
    if (topologyResult.shouldAbortReconcile) return;
    this.leadTicks = this.calculateLeadTicks(effectiveRtt);
    this.metrics.leadTicks = this.leadTicks;
    const targetDelta = this.leadTicks + this.calculateDownlinkTicks(effectiveRtt);
    let currentClientTick = Math.floor(this.sim.getHeaderView().tickCount);
    const currentDelta = currentClientTick - serverTick;
    const desyncDistance = Math.abs(currentDelta - targetDelta);
    const rollbackDepth = currentClientTick - serverTick;
    const maxRollbackFrames = this.options.maxRollbackFrames ?? 180;
    if (!this.isTimelineSynchronized || rollbackDepth > maxRollbackFrames || rollbackDepth < 0 || desyncDistance > maxRollbackFrames) {
      const wasAlreadySynchronized = this.isTimelineSynchronized;
      if (nowMs - this.lastHardResyncTime > 300 || !wasAlreadySynchronized) {
        console.log(
          `[PredictionReconciler] Timeline sync aligned (currentDelta: ${currentDelta}, target: ${targetDelta}, rollbackDepth: ${rollbackDepth}). Snapping timeline to server tick ${serverTick}.`
        );
        this.syncTimeline(packet.stateSnapshot, serverTick, nowMs);
        const syncedClientTick = Math.floor(this.sim.getHeaderView().tickCount);
        const isKickoffMasked = this.kickoffMaskUntilTick > 0 && syncedClientTick < this.kickoffMaskUntilTick;
        if (this.telemetryCollector.isMatchTelemetryActive && wasAlreadySynchronized && !isKickoffMasked) {
          recordReconcileTelemetryTick({
            isMatchTelemetryActive: this.telemetryCollector.isMatchTelemetryActive,
            telemetryRecorder: this.telemetryCollector.recorder,
            nowMs, clientTick: syncedClientTick, serverTick, effectiveRtt, isHardResyncSnap: true,
            kickoffMaskUntilTick: this.kickoffMaskUntilTick, inputBufferTarget: this.pacingController.inputBufferTarget,
            leadTicks: this.leadTicks, interpolatorPhysicsRate: this.interpolator?.physicsRate,
            metrics: this.metrics, lastPacingStepStatus: this.telemetryCollector.lastPacingStepStatus,
          });
        }
        if (typeof this.onHardResync === 'function') this.onHardResync();
      }
      return;
    }
    currentClientTick = this.modulateClockPacing(currentClientTick, currentDelta, targetDelta, nowMs);
    const { prePositions, hasNaN, numCars } = capturePreResimPositions(this.sim, 8);
    if (hasNaN) {
      console.error('[PredictionReconciler] NaN detected in vehicle coordinates! Forcing full state reset.');
      this.syncTimeline(packet.stateSnapshot, serverTick, nowMs);
      if (typeof this.onHardResync === 'function') this.onHardResync();
      return;
    }
    this.replayAndEvaluateCorrection(packet, serverTick, currentClientTick, prePositions, numCars);
    this.metrics.clientTick = currentClientTick;
    if (this.telemetryCollector.isMatchTelemetryActive) {
      recordReconcileTelemetryTick({
        isMatchTelemetryActive: this.telemetryCollector.isMatchTelemetryActive,
        telemetryRecorder: this.telemetryCollector.recorder,
        nowMs, clientTick: currentClientTick, serverTick, effectiveRtt, isHardResyncSnap: false,
        kickoffMaskUntilTick: this.kickoffMaskUntilTick, inputBufferTarget: this.pacingController.inputBufferTarget,
        leadTicks: this.leadTicks, interpolatorPhysicsRate: this.interpolator?.physicsRate,
        metrics: this.metrics, lastPacingStepStatus: this.telemetryCollector.lastPacingStepStatus,
      });
    }
    this.notifyMetricsUpdated();
  }
  updateSmoothing(deltaSeconds: number): Vector3Like { return this.visualSmoother.stepDecay(deltaSeconds); }
  triggerDumpNextPacket(): Promise<any> { return this.controlMessenger.triggerDumpNextPacket(); }
  dumpPacket(packetOrRaw: any = null): any { return this.controlMessenger.dumpPacket(packetOrRaw || this.lastParsedPacket || this.lastReceivedPacketRaw); }
  resetStats(): void {
    this.totalCorrections = 0;
    this.skippedCorrections = 0;
    this.hardSnapCount = 0;
    this.maxCorrectionDelta = 0;
    this.visualSmoother.reset();
    this.metrics.reconcileTier = 1;
    this.metrics.historicalPosDelta = 0;
    this.metrics.totalCorrections = 0;
    this.metrics.skippedCorrections = 0;
    this.metrics.hardSnapCount = 0;
    this.metrics.lastCorrectionDelta = 0;
    this.metrics.maxCorrectionDelta = 0;
    this.metrics.smoothingMagnitude = 0;
    this.telemetryCollector.recorder?.reset?.();
  }
}

export default PredictionReconciler;
