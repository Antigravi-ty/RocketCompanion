import { LocalClientInputBuffer } from './LocalClientInputBuffer.js';
import { drainAndParseServerPackets, dumpNetworkPacket } from '../diagnostics/PacketDumpDiagnostics.js';
import { createBoostPadEdgeTracker } from '../protocol/GlobalPayloadCodec.js';
import {
  configureClientLobbyDiagnosticProbes,
  modulateReconcilerClockPacing,
  replayAndEvaluateCorrection,
  syncReconcilerTimeline
} from './ReconciliationTimelineHelper.js';
import {
  acknowledgeReconcilerSignal,
  acknowledgeReconcilerServerSignals,
  enqueueReconcilerClientCommand,
  collectPiggybackAcksAndCommands,
  sendReconcilerOutboundInputForTick,
  flushReconcilerPendingControlPackets
} from './ReconcilerControlMessenger.js';
import {
  globalPacingTelemetryRecorder,
  evaluatePacingControllerStep
} from '../../ui-core/stores/pacingTelemetryRecorder.js';
import { isDiagnosticProbeSlot } from '../../physics/RocketSimConstants.js';

export class PredictionReconciler {
  /**
   * @param {import('../../physics/RocketSimPhysicsEngine.js').RocketSimPhysicsEngine} clientSim
   * @param {object} channel
   * @param {object} [options]
   */
  constructor(clientSim, channel, options = {}) {
    this.sim = clientSim;
    this.channel = channel;
    this.options = options;

    this.localCarIndex = options.localCarIndex ?? 0;
    this.capacity = 1024;
    this.mask = this.capacity - 1;

    this.inputHistory = new Array(this.capacity);
    this.clientInputRingBuffer = new LocalClientInputBuffer(256);
    this.redundantHistoryCount = options.redundantHistoryCount ?? (options.enableRedundantBuffer ? 10 : 1);
    this.useBitPacking = options.useBitPacking ?? false;
    this.lastLocalControls = {
      throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false
    };
    this.lastRemoteControls = new Map();
    this.neutralControls = {
      throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false
    };

    this.lastAckedServerTick = -1;
    this.totalCorrections = 0;
    this.skippedCorrections = 0;
    this.hardSnapCount = 0;
    this.maxCorrectionDelta = 0;

    // 3-Tier Reconciliation Tolerance thresholds:
    // Tier 1 (Deadband No-Op): historical delta <= posTolerance / velTolerance / rotTolerance -> skip rollback & resim
    // Tier 2 (Rollback + Resimulate + Micro-Snap): moderate delta above Tier 1 deadband, below hardSnapThreshold
    // Tier 3 (Hard Snap): catastrophic divergence > hardSnapThreshold -> direct hard snap without smoothing
    this.posTolerance = options.posTolerance ?? 0.5;
    this.velTolerance = options.velTolerance ?? 5.0;
    this.rotTolerance = options.rotTolerance ?? 0.015;
    this.ballPosTolerance = options.ballPosTolerance ?? 1.0;
    this.ballVelTolerance = options.ballVelTolerance ?? 10.0;
    this.boostTolerance = options.boostTolerance ?? 1.0;
    this.hardSnapThreshold = options.hardSnapThreshold ?? 500.0;

    this.tickDtMs = 1000.0 / 120.0;
    this.inputBufferTarget = options.inputBufferTarget ?? 3;
    this.catchupThresholdOffset = options.catchupThresholdOffset ?? -2;
    this.skipThresholdOffset = options.skipThresholdOffset ?? 2;
    this.forceTargetAlign = false;
    this.leadTicks = this.calculateLeadTicks();
    this.isTimelineSynchronized = false;

    this.enableSmoothing = options.enableSmoothing ?? false;
    this.visualSmoothingOffset = { x: 0, y: 0, z: 0 };
    this.smoothingDecayRate = 18.0;
    this.enableRedundantInputs = options.enableRedundantInputs ?? false;
    this.redundantHistoryTicks = options.redundantHistoryTicks ?? 12;
    this.shouldSkipLocalStep = false;
    this.interpolator = options.interpolator || null;
    this.clockPacingMode = options.clockPacingMode || 'legacy';
    this.clockPacingPriority = options.clockPacingPriority || 'balanced';
    this.clockPacingParams = options.clockPacingParams ? { ...options.clockPacingParams } : null;
    this.pacingControllerState = { initialized: false };
    this._hasServerReportedBuffer = false;
    this._lastPacingStepStatus = null;

    this.telemetryRecorder = options.telemetryRecorder || globalPacingTelemetryRecorder;
    if (options.resetTelemetryOnStart !== false && this.telemetryRecorder) {
      this.telemetryRecorder.reset();
      this.telemetryRecorder.setSessionMetadata(
        this.clockPacingMode,
        this.clockPacingPriority,
        this.clockPacingParams
      );
    }

    this.lastHardResyncTime = 0;
    this.onHardResync = options.onHardResync || null;

    this._lastProcessedClientTimestamp = 0;
    this.measuredRtt = 0;
    this.lastReceivedPacketRaw = null;
    this.lastParsedPacket = null;
    this.pendingDumpNextPacket = false;
    this._onNextDumpResolve = null;

    this.pendingSignalAcks = new Map();
    this.pendingClientCommands = new Map();
    this.nextClientCommandId = 0;
    this.kickoffMaskUntilTick = -1;
    this.carVisualPresets = new Map();
    this.boostPadEdgeTracker = createBoostPadEdgeTracker();

    // Channel A (Lobby Dual-World) & Channel C (Goal Replay Playback) isolation flags
    this.lobbyDualWorldMode = Boolean(options.lobbyDualWorldMode);
    this.replayPlaybackMode = false;
    this.drainedReplayPackets = [];
    this.isMatchTelemetryActive = options.isMatchTelemetryActive !== undefined
      ? Boolean(options.isMatchTelemetryActive)
      : !this.lobbyDualWorldMode;
    this.lobbyPrevAuthoritativeState = null;
    this.lobbyCurrAuthoritativeState = null;

    this.metrics = {
      clientTick: 0,
      serverTick: 0,
      leadTicks: this.leadTicks,
      rttMs: 0,
      uplinkMs: 0,
      downlinkMs: 0,
      extraUplinkMs: 0,
      extraDownlinkMs: 0,
      extraRttMs: 0,
      smoothRttMs: 0,
      measuredJitterMs: 0,
      inputBufferSize: this.inputBufferTarget,
      effectiveInputBuffer: this.inputBufferTarget,
      targetInputBuffer: this.inputBufferTarget,
      pacingTier: 0,
      physicsRateHz: 120,
      reconcileTier: 1,
      historicalPosDelta: 0,
      totalCorrections: 0,
      skippedCorrections: 0,
      hardSnapCount: 0,
      lastCorrectionDelta: 0,
      maxCorrectionDelta: 0,
      smoothingMagnitude: 0
    };

    this.onMetricsUpdated = null;
    this._metricsListeners = new Set();
  }

  setMatchTelemetryActive(enabled, resetRecorder = false) {
    this.isMatchTelemetryActive = Boolean(enabled);
    if (resetRecorder) {
      this.pacingControllerState = { initialized: false };
      if (this.telemetryRecorder) {
        this.telemetryRecorder.reset();
        this.telemetryRecorder.setSessionMetadata(
          this.clockPacingMode,
          this.clockPacingPriority,
          this.clockPacingParams
        );
      }
    }
  }

  setLobbyDualWorldMode(enabled) {
    const next = Boolean(enabled);
    if (this.lobbyDualWorldMode !== next) {
      this.resetTimelineState();
    }
    this.lobbyDualWorldMode = next;
  }

  setReplayPlaybackMode(enabled) {
    const next = Boolean(enabled);
    if (this.replayPlaybackMode !== next && Array.isArray(this.drainedReplayPackets)) {
      this.drainedReplayPackets.length = 0;
    }
    if (this.replayPlaybackMode && !next) {
      this.resetTimelineState();
    }
    this.replayPlaybackMode = next;
  }

  resetTimelineState() {
    this.isTimelineSynchronized = false;
    this._hasServerReportedBuffer = false;
    this.lastAckedServerTick = -1;
    if (this.metrics) {
      this.metrics.serverTick = 0;
    }
    this.lastHardResyncTime = 0;
    this.pacingControllerState = { initialized: false };
    this.boostPadEdgeTracker = createBoostPadEdgeTracker();
    this.inputHistory = new Array(this.capacity);
    this.clientInputRingBuffer?.clear?.();
    this.visualSmoothingOffset = { x: 0, y: 0, z: 0 };
    if (Array.isArray(this.drainedReplayPackets)) {
      this.drainedReplayPackets.length = 0;
    }
  }

  _resolveLatencyBreakdown() {
    const ch = this.channel;
    const extraUplinkMs = Math.max(0, Math.round(Number(ch?.extraUplinkMs ?? ch?.extraLatencyMs ?? 0) || 0));
    const extraDownlinkMs = Math.max(0, Math.round(Number(ch?.extraDownlinkMs ?? ch?.extraLatencyMs ?? 0) || 0));
    const extraRttMs = extraUplinkMs + extraDownlinkMs;

    if (ch?.isLoopback) {
      return {
        rttMs: extraRttMs,
        baseRttMs: 0,
        uplinkMs: extraUplinkMs,
        downlinkMs: extraDownlinkMs,
        extraUplinkMs,
        extraDownlinkMs,
        extraRttMs,
      };
    }

    let baseRttMs = 0;
    if (Number.isFinite(this._baseMeasuredRtt) && this._baseMeasuredRtt > 0) {
      baseRttMs = Math.round(this._baseMeasuredRtt);
    } else if (typeof ch?.baseMeasuredRttMs === 'number' && Number.isFinite(ch.baseMeasuredRttMs) && ch.baseMeasuredRttMs > 0) {
      baseRttMs = Math.round(ch.baseMeasuredRttMs);
    } else if (Number.isFinite(this.measuredRtt) && this.measuredRtt > 0) {
      baseRttMs = Math.max(0, Math.round(this.measuredRtt - extraRttMs));
    } else {
      const chRtt = typeof ch?.rttMs === 'number' && Number.isFinite(ch.rttMs)
        ? ch.rttMs
        : (typeof ch?.measuredRttMs === 'number' && Number.isFinite(ch.measuredRttMs) ? ch.measuredRttMs : 0);
      baseRttMs = Math.max(0, Math.round(chRtt - extraRttMs));
    }

    let bufferAsymmetryMs = 0;
    if (
      this._hasServerReportedBuffer &&
      typeof this.metrics?.inputBufferSize === 'number' &&
      Number.isFinite(this.metrics.inputBufferSize) &&
      baseRttMs > 0
    ) {
      const bufferDeficitTicks = (this.inputBufferTarget ?? 3) - this.metrics.inputBufferSize;
      const maxShift = baseRttMs * 0.5;
      bufferAsymmetryMs = Math.max(-maxShift, Math.min(maxShift, bufferDeficitTicks * this.tickDtMs));
    }

    const baseUplinkMs = Math.max(0, Math.min(baseRttMs, Math.round(baseRttMs * 0.5 + bufferAsymmetryMs)));
    const baseDownlinkMs = Math.max(0, baseRttMs - baseUplinkMs);
    const uplinkMs = baseUplinkMs + extraUplinkMs;
    const downlinkMs = baseDownlinkMs + extraDownlinkMs;
    const rttMs = uplinkMs + downlinkMs;

    return {
      rttMs,
      baseRttMs,
      uplinkMs,
      downlinkMs,
      extraUplinkMs,
      extraDownlinkMs,
      extraRttMs,
    };
  }

  _resolveEffectiveRtt() {
    return this._resolveLatencyBreakdown().rttMs;
  }

  setClockPacingMode(mode) {
    if (mode !== 'csts' && mode !== 'sts' && mode !== 'legacy' && mode !== 'custom') {
      throw new Error(
        `[PredictionReconciler] Unknown clock pacing mode: ${mode}. Expected 'legacy', 'sts', 'csts', or 'custom'.`
      );
    }
    this.clockPacingMode = mode;
    if (mode === 'legacy') {
      this.interpolator?.setPhysicsRate?.(120);
      if (this.metrics) this.metrics.physicsRateHz = 120;
    }
    this.telemetryRecorder?.setSessionMetadata?.(
      this.clockPacingMode,
      this.clockPacingPriority,
      this.clockPacingParams
    );
    this.notifyMetricsUpdated();
  }

  setClockPacingPriority(priority) {
    if (typeof priority === 'string' && priority.length > 0) {
      this.clockPacingPriority = priority;
      this.telemetryRecorder?.setSessionMetadata?.(
        this.clockPacingMode,
        this.clockPacingPriority,
        this.clockPacingParams
      );
      this.notifyMetricsUpdated();
    }
  }

  setClockPacingParams(params) {
    if (params && typeof params === 'object') {
      this.clockPacingParams = { ...(this.clockPacingParams || {}), ...params };
      if (typeof params.targetBufferTicks === 'number' && Number.isFinite(params.targetBufferTicks)) {
        const rounded = Math.max(1, Math.min(12, Math.round(params.targetBufferTicks)));
        if (rounded !== this.inputBufferTarget) {
          this.forceTargetAlign = true;
          this.inputBufferTarget = rounded;
        }
      }
      if (typeof params.deadbandCatchupOffset === 'number' && Number.isFinite(params.deadbandCatchupOffset)) {
        this.catchupThresholdOffset = Math.min(0, Math.round(params.deadbandCatchupOffset));
      }
      if (typeof params.deadbandSkipOffset === 'number' && Number.isFinite(params.deadbandSkipOffset)) {
        this.skipThresholdOffset = Math.max(0, Math.round(params.deadbandSkipOffset));
      }
      const effectiveRtt = this._resolveEffectiveRtt();
      this.leadTicks = this.calculateLeadTicks(effectiveRtt);
      this.metrics.leadTicks = this.leadTicks;
      this.telemetryRecorder?.setSessionMetadata?.(
        this.clockPacingMode,
        this.clockPacingPriority,
        this.clockPacingParams
      );
      this.notifyMetricsUpdated();
    }
  }

  setInputBufferTarget(target) {
    if (typeof target === 'number' && Number.isFinite(target) && target >= 1) {
      const rounded = Math.max(1, Math.min(12, Math.round(target)));
      if (rounded !== this.inputBufferTarget) {
        this.forceTargetAlign = true;
      }
      this.inputBufferTarget = rounded;
      if (this.clockPacingParams) {
        this.clockPacingParams.targetBufferTicks = rounded;
      }
      const effectiveRtt = this._resolveEffectiveRtt();
      this.leadTicks = this.calculateLeadTicks(effectiveRtt);
      this.metrics.leadTicks = this.leadTicks;
      this.notifyMetricsUpdated();
    }
  }

  setInputBufferThresholds(catchupOffset, skipOffset) {
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
    this.notifyMetricsUpdated();
  }

  addMetricsListener(fn) {
    if (typeof fn === 'function') {
      this._metricsListeners.add(fn);
      return () => this._metricsListeners.delete(fn);
    }
    return () => {};
  }

  setEnableSmoothing(enabled) {
    this.enableSmoothing = Boolean(enabled);
    this.metrics.enableSmoothing = this.enableSmoothing;
    if (!this.enableSmoothing) {
      this.visualSmoothingOffset = { x: 0, y: 0, z: 0 };
      this.metrics.smoothingMagnitude = 0;
    }
    this.notifyMetricsUpdated();
  }

  setReconciliationTolerances(tolerances = {}) {
    if (typeof tolerances.posTolerance === 'number' && Number.isFinite(tolerances.posTolerance) && tolerances.posTolerance >= 0) {
      this.posTolerance = tolerances.posTolerance;
    }
    if (typeof tolerances.velTolerance === 'number' && Number.isFinite(tolerances.velTolerance) && tolerances.velTolerance >= 0) {
      this.velTolerance = tolerances.velTolerance;
    }
    if (typeof tolerances.rotTolerance === 'number' && Number.isFinite(tolerances.rotTolerance) && tolerances.rotTolerance >= 0) {
      this.rotTolerance = tolerances.rotTolerance;
    }
    if (typeof tolerances.ballPosTolerance === 'number' && Number.isFinite(tolerances.ballPosTolerance) && tolerances.ballPosTolerance >= 0) {
      this.ballPosTolerance = tolerances.ballPosTolerance;
    }
    if (typeof tolerances.ballVelTolerance === 'number' && Number.isFinite(tolerances.ballVelTolerance) && tolerances.ballVelTolerance >= 0) {
      this.ballVelTolerance = tolerances.ballVelTolerance;
    }
    if (typeof tolerances.hardSnapThreshold === 'number' && Number.isFinite(tolerances.hardSnapThreshold) && tolerances.hardSnapThreshold > 0) {
      this.hardSnapThreshold = tolerances.hardSnapThreshold;
    }
    this.notifyMetricsUpdated();
  }

  notifyMetricsUpdated() {
    const breakdown = this._resolveLatencyBreakdown();
    const rawRtt = breakdown.rttMs;
    if (!Number.isFinite(rawRtt)) {
      throw new Error(`[PredictionReconciler] Channel rttMs is non-finite: ${rawRtt}`);
    }
    this.metrics.rttMs = rawRtt;
    this.metrics.uplinkMs = breakdown.uplinkMs;
    this.metrics.downlinkMs = breakdown.downlinkMs;
    this.metrics.extraUplinkMs = breakdown.extraUplinkMs;
    this.metrics.extraDownlinkMs = breakdown.extraDownlinkMs;
    this.metrics.extraRttMs = breakdown.extraRttMs;
    this.metrics.enableSmoothing = this.enableSmoothing;
    this.metrics.rollbackWindow = this.inputHistory?.length || 0;
    if (this.onMetricsUpdated) {
      try {
        this.onMetricsUpdated(this.metrics);
      } catch (err) {
        console.error('[PredictionReconciler] Error in onMetricsUpdated callback:', err);
      }
    }
    for (const listener of this._metricsListeners) {
      try {
        listener(this.metrics);
      } catch (err) {
        console.error('[PredictionReconciler] Error in metrics listener:', err);
      }
    }
  }

  get clientReportRate() {
    return 120;
  }

  get serverTick() {
    return this.lastAckedServerTick >= 0 ? this.lastAckedServerTick : (this.metrics?.serverTick ?? 0);
  }

  calculateLeadTicks(rttMs = undefined) {
    const breakdown = this._resolveLatencyBreakdown();
    const uplinkMs = (rttMs === undefined || breakdown.extraUplinkMs !== breakdown.extraDownlinkMs)
      ? breakdown.uplinkMs
      : Math.max(0, rttMs * 0.5);
    if (uplinkMs <= 1 && (rttMs ?? breakdown.rttMs) <= 2) {
      return Math.max(1, this.inputBufferTarget);
    }
    const jitterBufferTicks = this.inputBufferTarget;
    const computed = Math.ceil(uplinkMs / this.tickDtMs) + jitterBufferTicks;
    const maxLead = this.clockPacingMode === 'legacy' ? (this.options.maxLeadTicks ?? 72) : (this.options.maxLeadTicks ?? 64);
    return Math.max(this.inputBufferTarget, Math.min(maxLead, computed));
  }

  calculateDownlinkTicks(rttMs = undefined) {
    const breakdown = this._resolveLatencyBreakdown();
    const downlinkMs = (rttMs === undefined || breakdown.extraUplinkMs !== breakdown.extraDownlinkMs)
      ? breakdown.downlinkMs
      : Math.max(0, rttMs * 0.5);
    if (downlinkMs <= 1 && (rttMs ?? breakdown.rttMs) <= 2) {
      return 0;
    }
    const maxOneWayTicks = this.clockPacingMode === 'legacy' ? 64 : 64;
    return Math.max(1, Math.min(maxOneWayTicks, Math.ceil(downlinkMs / this.tickDtMs)));
  }

  getPreviousCommittedControls(tick, carIndex = this.localCarIndex) {
    for (let t = tick - 1; t >= Math.max(0, tick - 64); t--) {
      const entry = this.inputHistory[t & this.mask];
      if (entry && entry.tick === t && entry.cars.has(carIndex)) {
        return { ...entry.cars.get(carIndex) };
      }
    }
    if (carIndex === this.localCarIndex) {
      return { ...this.lastLocalControls };
    }
    const remote = this.lastRemoteControls.get(carIndex);
    return { ...(remote?.controls ? remote.controls : (remote || this.neutralControls)) };
  }

  acknowledgeSignal(signalId, signalType, repeatCount = 8) {
    acknowledgeReconcilerSignal(this, signalId, signalType, repeatCount);
  }

  acknowledgeServerSignals(signals) {
    acknowledgeReconcilerServerSignals(this, signals);
  }

  enqueueClientCommand(commandType, param1 = 0, param2 = 0, maxSends = 60) {
    return enqueueReconcilerClientCommand(this, commandType, param1, param2, maxSends);
  }

  queueClientCommand(commandType, param1 = 0, param2 = 0, maxSends = 240) {
    return this.enqueueClientCommand(commandType, param1, param2, maxSends);
  }

  resolveClientCommandAck(commandId) {
    if (typeof commandId !== 'number' || commandId <= 0) return;
    this.pendingClientCommands?.delete(commandId);
  }

  setKickoffMaskUntilTick(targetTick) {
    this.kickoffMaskUntilTick = typeof targetTick === 'number' ? targetTick : -1;
  }

  setCarVisualPreset(carIndex, visualId) {
    if (!this.carVisualPresets) this.carVisualPresets = new Map();
    if (typeof carIndex === 'number' && carIndex >= 0 && visualId) {
      this.carVisualPresets.set(carIndex, visualId);
    }
  }

  _collectPiggybackAcksAndCommands() {
    return collectPiggybackAcksAndCommands(this);
  }

  sendOutboundInputForTick(tick, carIndex = this.localCarIndex, controls = null, nowMs = performance.now()) {
    sendReconcilerOutboundInputForTick(this, tick, carIndex, controls, nowMs);
  }

  flushPendingControlPackets(nowMs = performance.now()) {
    flushReconcilerPendingControlPackets(this, nowMs);
  }

  syncTimeline(serverSnapshot, serverTick = 0, nowMs = performance.now()) {
    syncReconcilerTimeline(this, serverSnapshot, serverTick, nowMs);
  }

  sampleAndPredictInput(carIndex, controls, nowMs = performance.now()) {
    const currentTick = Math.floor(this.sim.getHeaderView().tickCount);
    const isKickoffMasked = this.kickoffMaskUntilTick > 0 && currentTick < this.kickoffMaskUntilTick;
    const effectiveControls = isKickoffMasked ? this.neutralControls : controls;
    const slot = currentTick & this.mask;

    let entry = this.inputHistory[slot];
    if (!entry || entry.tick !== currentTick) {
      entry = { tick: currentTick, cars: new Map() };
      this.inputHistory[slot] = entry;
    }

    let committedControls;
    if (isKickoffMasked) {
      committedControls = { ...this.neutralControls };
      entry.cars.set(carIndex, committedControls);
    } else if (entry.cars.has(carIndex)) {
      committedControls = { ...entry.cars.get(carIndex) };
    } else {
      committedControls = { ...effectiveControls };
      entry.cars.set(carIndex, committedControls);
    }

    if (carIndex === this.localCarIndex) {
      this.lastLocalControls = { ...committedControls };
    }

    this.clientInputRingBuffer.record(currentTick, carIndex, committedControls);
    this.sendOutboundInputForTick(currentTick, carIndex, committedControls, nowMs);

    this.sim.saveStateSlot(currentTick % 256);
    if (typeof this.sim.saveCompactState === 'function') {
      entry.stateSnapshot = this.sim.saveCompactState(entry.stateSnapshot);
    }
    this.metrics.clientTick = currentTick;
    this.metrics.rttMs = this._resolveEffectiveRtt();
    this.metrics.leadTicks = this.leadTicks;
    if (currentTick % 2 === 0) {
      this.notifyMetricsUpdated();
    }

    return committedControls;
  }

  reconcile(nowMs = performance.now()) {
    let incomingPackets = null;
    if (typeof this.channel?.receiveClientPackets === 'function') {
      incomingPackets = this.channel.receiveClientPackets(nowMs);
    } else if (typeof this.channel?.receiveServerPackets === 'function') {
      incomingPackets = this.channel.receiveServerPackets(nowMs);
    } else if (Array.isArray(this.channel?.inboundQueue)) {
      incomingPackets = this.channel.inboundQueue.splice(0);
    }
    if (!incomingPackets || incomingPackets.length === 0) return;

    const packet = drainAndParseServerPackets(this, incomingPackets, nowMs);
    if (!packet) return;

    const serverTick = packet.serverTick;
    // Allow non-increasing ticks during Replay Playback or after a timeline reset
    if (!this.replayPlaybackMode && serverTick <= this.lastAckedServerTick && serverTick > 0) return;
    this.lastAckedServerTick = serverTick;
    this.metrics.serverTick = serverTick;
    const effectiveRtt = this._resolveEffectiveRtt();
    this.metrics.rttMs = effectiveRtt;

    let maxAckCarIndex = 0;
    if (packet.acknowledgedControls && Array.isArray(packet.acknowledgedControls)) {
      for (const item of packet.acknowledgedControls) {
        if (!item) continue;
        const carIdx = typeof item.carIndex === 'number' ? item.carIndex : -1;
        if (carIdx > maxAckCarIndex) {
          maxAckCarIndex = carIdx;
        }
        const ctrl = item.controls || item;
        if (carIdx >= 0 && carIdx !== this.localCarIndex) {
          this.lastRemoteControls.set(carIdx, { ...ctrl });
        }
      }
    }

    this.lastParsedPacket = packet;
    if (this.pendingDumpNextPacket) {
      this.pendingDumpNextPacket = false;
      const dumped = this.dumpPacket(packet);
      if (typeof this._onNextDumpResolve === 'function') {
        this._onNextDumpResolve(dumped);
        this._onNextDumpResolve = null;
      }
    }

    // Channel A: Lobby Dual-World Mode -> Capture authoritative snapshot for Ghost World rendering,
    // while continuing reconciliation on shared Diagnostic Test Vehicles (Car 6 & Car 7).
    if (this.lobbyDualWorldMode) {
      if (packet.stateSnapshot && packet.stateSnapshot.length >= 410) {
        if (!this.lobbyCurrAuthoritativeState || this.lobbyCurrAuthoritativeState.length !== packet.stateSnapshot.length) {
          this.lobbyPrevAuthoritativeState = new Float32Array(packet.stateSnapshot);
          this.lobbyCurrAuthoritativeState = new Float32Array(packet.stateSnapshot);
        } else {
          this.lobbyPrevAuthoritativeState.set(this.lobbyCurrAuthoritativeState);
          this.lobbyCurrAuthoritativeState.set(packet.stateSnapshot);
        }
      }
    }

    // Channel C: Goal Replay Playback Mode -> Pure render playback without predictive rollback
    if (this.replayPlaybackMode) {
      this.notifyMetricsUpdated();
      return;
    }

    const snapCarCount = packet.stateSnapshot && packet.stateSnapshot.length > 2
      ? Math.round(packet.stateSnapshot[2] || 0)
      : 0;
    const serverCarCount = Math.min(
      8,
      Math.max(
        1,
        snapCarCount,
        maxAckCarIndex + 1,
        packet.acknowledgedControls?.length || 1,
        this.localCarIndex + 1
      )
    );

    const serverHasLobbyProbes =
      typeof packet.activeCarMask !== 'number' ||
      packet.activeCarMask === 0 ||
      (packet.activeCarMask & 0xC0) !== 0;

    if (
      !this.lobbyDualWorldMode &&
      typeof packet.activeCarMask === 'number' &&
      (packet.activeCarMask & 0xC0) !== 0
    ) {
      this.notifyMetricsUpdated();
      return;
    }

    let topologyChanged = false;
    if (
      typeof this.sim.addCarAtSlot === 'function' &&
      typeof this.sim.isCarSlotActive === 'function' &&
      typeof packet.activeCarMask === 'number' &&
      packet.activeCarMask > 0
    ) {
      let targetMask = packet.activeCarMask & 0xFF;
      if (this.lobbyDualWorldMode) {
        const diagMask = (packet.activeCarMask & 0xC0) || 0xC0;
        const localBit = (this.localCarIndex >= 0 && this.localCarIndex < 8) ? (1 << this.localCarIndex) : 0;
        targetMask = diagMask | localBit;
      } else if (this.localCarIndex >= 0 && this.localCarIndex < 8) {
        targetMask |= (1 << this.localCarIndex);
      }
      for (let c = 0; c < 8; c++) {
        const shouldBeActive = (targetMask & (1 << c)) !== 0;
        const isActive = this.sim.isCarSlotActive(c);
        if (shouldBeActive && !isActive) {
          const preset = this.carVisualPresets.get(c) || (isDiagnosticProbeSlot(c) ? 'fennec' : 'octane');
          const defaultTeam = c === 6 ? 0 : (c === 7 ? 1 : (c % 2));
          this.sim.addCarAtSlot(c, defaultTeam, preset);
          topologyChanged = true;
        } else if (!shouldBeActive && isActive && c !== this.localCarIndex) {
          this.sim.removeCar?.(c);
          topologyChanged = true;
        }
      }
      this.activeCarMask = targetMask;
    } else {
      while (this.sim.numCars < serverCarCount) {
        const nextCarIdx = this.sim.numCars;
        const preset = this.carVisualPresets.get(nextCarIdx) || 'octane';
        this.sim.addCar(nextCarIdx % 2, preset);
        topologyChanged = true;
      }
      if (!this.lobbyDualWorldMode && typeof this.sim.removeCar === 'function') {
        while (this.sim.numCars > serverCarCount && this.sim.numCars > 1) {
          if (!this.sim.removeCar(this.sim.numCars - 1)) break;
          topologyChanged = true;
        }
      }
    }
    if (this.lobbyDualWorldMode) {
      configureClientLobbyDiagnosticProbes(this.sim);
      if (!serverHasLobbyProbes) {
        this.isTimelineSynchronized = false;
        this.notifyMetricsUpdated();
        return;
      }
    }
    if (topologyChanged) {
      this.isTimelineSynchronized = false;
    }

    this.leadTicks = this.calculateLeadTicks(effectiveRtt);
    this.metrics.leadTicks = this.leadTicks;
    const oneWayTicks = this.calculateDownlinkTicks(effectiveRtt);
    const targetDelta = this.leadTicks + oneWayTicks;

    let currentClientTick = Math.floor(this.sim.getHeaderView().tickCount);
    const currentDelta = currentClientTick - serverTick;
    const desyncDistance = Math.abs(currentDelta - targetDelta);
    const rollbackDepth = currentClientTick - serverTick;
    const maxRollbackFrames = this.options.maxRollbackFrames ?? 180;

    const shouldHardResync = !this.isTimelineSynchronized ||
      (rollbackDepth > maxRollbackFrames) ||
      (rollbackDepth < 0) ||
      (desyncDistance > maxRollbackFrames);

    if (shouldHardResync) {
      const wasAlreadySynchronized = this.isTimelineSynchronized;
      const timeSinceLastSnap = nowMs - this.lastHardResyncTime;
      if (timeSinceLastSnap > 300 || !wasAlreadySynchronized) {
        console.log(`[PredictionReconciler] Timeline sync aligned (currentDelta: ${currentDelta}, target: ${targetDelta}, rollbackDepth: ${rollbackDepth}). Snapping timeline to server tick ${serverTick}.`);
        this.syncTimeline(packet.stateSnapshot, serverTick, nowMs);
        const syncedClientTick = Math.floor(this.sim.getHeaderView().tickCount);
        const isKickoffMasked = this.kickoffMaskUntilTick > 0 && syncedClientTick < this.kickoffMaskUntilTick;
        if (this.isMatchTelemetryActive && wasAlreadySynchronized && !isKickoffMasked) {
          this.telemetryRecorder?.recordTick?.({
            nowMs,
            clientTick: syncedClientTick,
            serverTick,
            rawRttMs: effectiveRtt,
            smoothRttMs: this.metrics.smoothRttMs || effectiveRtt,
            jitterMs: this.metrics.measuredJitterMs || 0,
            serverBuffer: this.inputBufferTarget,
            effectiveBuffer: this.inputBufferTarget,
            targetBuffer: this.inputBufferTarget,
            physicsRateHz: this.interpolator?.physicsRate ?? 120,
            leadTicks: this.leadTicks,
            posErrorUu: this.metrics.lastCorrectionDelta || 0,
            localPosErrorUu: this.metrics.localCorrectionDelta || 0,
            ballPosErrorUu: this.metrics.ballCorrectionDelta || 0,
            remotePosErrorUu: this.metrics.remoteCorrectionDelta || 0,
            probePosErrorUu: this.metrics.probeCorrectionDelta || 0,
            reconcileTier: 3,
            tierState: 0,
            packetArrived: true,
            hardResync: true,
            tier3Snap: true,
            stepCatchup: false,
            stepSkip: false,
            tierSwitched: false,
            isKickoffMasked,
          });
        }
        if (typeof this.onHardResync === 'function') {
          this.onHardResync();
        }
      }
      return;
    }

    currentClientTick = modulateReconcilerClockPacing(this, currentClientTick, currentDelta, targetDelta, nowMs);

    const numCars = Math.min(this.sim.numCars, 8);
    const prePositions = [];
    let hasNaN = false;
    for (let c = 0; c < numCars; c++) {
      if (typeof this.sim.isCarSlotActive === 'function' && !this.sim.isCarSlotActive(c)) {
        prePositions[c] = { x: 0, y: 0, z: 0 };
        continue;
      }
      const car = this.sim.getCarStateView(c);
      if (Number.isNaN(car.posX) || Number.isNaN(car.posY) || Number.isNaN(car.posZ)) {
        hasNaN = true;
        break;
      }
      prePositions[c] = { x: car.posX, y: car.posY, z: car.posZ };
    }
    const bv = typeof this.sim.getBallStateView === 'function' ? this.sim.getBallStateView() : null;
    prePositions.ball = bv ? { x: bv.posX, y: bv.posY, z: bv.posZ } : null;

    if (hasNaN) {
      console.error('[PredictionReconciler] NaN detected in vehicle coordinates! Forcing full state reset.');
      this.syncTimeline(packet.stateSnapshot, serverTick, nowMs);
      if (typeof this.onHardResync === 'function') this.onHardResync();
      return;
    }

    replayAndEvaluateCorrection(this, packet, serverTick, currentClientTick, prePositions, numCars);
    this.metrics.clientTick = currentClientTick;

    if (this.isMatchTelemetryActive) {
      const pacingStatus = this._lastPacingStepStatus;
      const stepOut = pacingStatus?.stepOut;
      const isKickoffMasked = this.kickoffMaskUntilTick > 0 && currentClientTick < this.kickoffMaskUntilTick;
      const reportedPosError = this.metrics.lastCorrectionDelta || 0;
      const recTier = this.metrics.reconcileTier || 1;
      this.telemetryRecorder?.recordTick?.({
        nowMs,
        clientTick: currentClientTick,
        serverTick,
        rawRttMs: effectiveRtt,
        smoothRttMs: stepOut?.smoothRttMs ?? effectiveRtt,
        jitterMs: stepOut?.jitterMs ?? 0,
        serverBuffer: pacingStatus?.rawServerBuffer ?? (this.metrics.inputBufferSize ?? this.inputBufferTarget),
        effectiveBuffer: stepOut?.effectiveBuffer ?? (this.metrics.effectiveInputBuffer ?? this.inputBufferTarget),
        targetBuffer: stepOut?.activeTarget ?? (this.metrics.targetInputBuffer ?? this.inputBufferTarget),
        physicsRateHz: stepOut?.physicsRateHz ?? (this.interpolator?.physicsRate ?? 120),
        leadTicks: this.leadTicks,
        posErrorUu: reportedPosError,
        localPosErrorUu: this.metrics.localCorrectionDelta || 0,
        ballPosErrorUu: this.metrics.ballCorrectionDelta || 0,
        remotePosErrorUu: this.metrics.remoteCorrectionDelta || 0,
        probePosErrorUu: this.metrics.probeCorrectionDelta || 0,
        reconcileTier: recTier,
        tierState: stepOut?.tierState ?? 0,
        packetArrived: true,
        hardResync: Boolean(stepOut?.requestHardResync),
        tier3Snap: Boolean(recTier === 3),
        stepCatchup: Boolean(pacingStatus?.stepCatchup),
        stepSkip: Boolean(pacingStatus?.stepSkip),
        tierSwitched: Boolean(stepOut?.tierSwitched),
        isKickoffMasked,
      });
    }

    this.notifyMetricsUpdated();
  }

  updateSmoothing(deltaSeconds) {
    if (!this.enableSmoothing || deltaSeconds <= 0) {
      this.visualSmoothingOffset.x = 0;
      this.visualSmoothingOffset.y = 0;
      this.visualSmoothingOffset.z = 0;
      return this.visualSmoothingOffset;
    }

    const decay = Math.exp(-this.smoothingDecayRate * deltaSeconds);
    this.visualSmoothingOffset.x *= decay;
    this.visualSmoothingOffset.y *= decay;
    this.visualSmoothingOffset.z *= decay;

    if (Math.abs(this.visualSmoothingOffset.x) < 0.001) this.visualSmoothingOffset.x = 0;
    if (Math.abs(this.visualSmoothingOffset.y) < 0.001) this.visualSmoothingOffset.y = 0;
    if (Math.abs(this.visualSmoothingOffset.z) < 0.001) this.visualSmoothingOffset.z = 0;

    return this.visualSmoothingOffset;
  }

  triggerDumpNextPacket() {
    this.pendingDumpNextPacket = true;
    return new Promise((resolve) => {
      this._onNextDumpResolve = resolve;
    });
  }

  dumpPacket(packetOrRaw = null) {
    const item = packetOrRaw || this.lastParsedPacket || this.lastReceivedPacketRaw;
    return dumpNetworkPacket(item);
  }

  resetStats() {
    this.totalCorrections = 0;
    this.skippedCorrections = 0;
    this.hardSnapCount = 0;
    this.maxCorrectionDelta = 0;
    this.visualSmoothingOffset = { x: 0, y: 0, z: 0 };
    this.metrics.reconcileTier = 1;
    this.metrics.historicalPosDelta = 0;
    this.metrics.totalCorrections = 0;
    this.metrics.skippedCorrections = 0;
    this.metrics.hardSnapCount = 0;
    this.metrics.lastCorrectionDelta = 0;
    this.metrics.maxCorrectionDelta = 0;
    this.metrics.smoothingMagnitude = 0;
    this.telemetryRecorder?.reset?.();
  }
}

export default PredictionReconciler;
