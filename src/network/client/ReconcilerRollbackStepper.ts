/**
 * ReconcilerRollbackStepper.ts
 * Stateful rollback, timeline synchronization, forward tick stepping,
 * and correction evaluation sub-component for PredictionReconciler.
 */

import type {
  CarControls,
  PredictionHistoryBuffer,
  ReconciliationTolerances,
} from './PredictionHistoryBuffer.ts';
import { capturePreResimPositions, type VisualErrorSmoother } from './VisualErrorSmoother.ts';
import {
  configureClientLobbyDiagnosticProbes,
  restoreClientLobbyLocalEntities,
  saveClientLobbyLocalEntities,
  syncClientCarTopology,
  recordReconcileTelemetryTick,
  type NetworkTelemetryCollector,
} from './NetworkTelemetryCollector.ts';
import type {
  ReconcilerMetrics,
  TelemetryChannelPort,
  TelemetrySimPort,
} from './ReconcilerMetricsModel.ts';
import type {
  ClientClockPacingController,
  ClockPacingInterpolatorPort,
} from './ClientClockPacingController.ts';
import type {
  ParsedReconcilerPacket,
  ReconcilerControlMessenger,
} from './ReconcilerControlMessenger.ts';
import type { BoostPadEdgeTracker, MatchSignalDescriptor } from '../protocol/GlobalPayloadCodec.ts';

export interface RollbackStepperSyncInput {
  sim: TelemetrySimPort;
  historyBuffer: PredictionHistoryBuffer;
  visualSmoother: VisualErrorSmoother;
  metrics: ReconcilerMetrics;
  serverSnapshot: Float32Array | null;
  serverTick: number;
  nowMs: number;
  localCarIndex: number;
  lobbyDualWorldMode: boolean;
  kickoffMaskUntilTick: number;
  leadTicks: number;
  downlinkTicks: number;
  hardSnapCount: number;
  isRedundant: boolean;
  sendOutboundInput: (tick: number, controls: CarControls | null, nowMs: number) => void;
}

export interface RollbackStepperSyncOutput {
  currentClientTick: number;
  lastServerRecordedInputTick: number;
  lastAckedServerTick: number;
  lastHardResyncTime: number;
  hardSnapCount: number;
}

export interface ReconcileStepHost {
  sim: TelemetrySimPort;
  channel: TelemetryChannelPort | null | undefined;
  historyBuffer: PredictionHistoryBuffer;
  visualSmoother: VisualErrorSmoother;
  pacingController: ClientClockPacingController;
  telemetryCollector: NetworkTelemetryCollector;
  controlMessenger: ReconcilerControlMessenger;
  interpolator: ClockPacingInterpolatorPort | null;
  metrics: ReconcilerMetrics;
  boostPadEdgeTracker: BoostPadEdgeTracker;
  localCarIndex: number;
  lobbyDualWorldMode: boolean;
  hostLobbyMode: boolean;
  replayPlaybackMode: boolean;
  kickoffMaskUntilTick: number;
  redundantHistoryCount: number;
  enableRedundantInputs: boolean;
  lastAckedServerTick: number;
  lastServerRecordedInputTick: number;
  _hasServerReportedBuffer: boolean;
  _lastProcessedClientTimestamp: number;
  _baseMeasuredRtt: number;
  measuredRtt: number;
  lastReceivedPacketRaw: unknown;
  lastParsedPacket: ParsedReconcilerPacket | null;
  drainedReplayPackets: ParsedReconcilerPacket[];
  lobbyPrevAuthoritativeState: Float32Array | null;
  lobbyCurrAuthoritativeState: Float32Array | null;
  isTimelineSynchronized: boolean;
  shouldSkipLocalStep: boolean;
  lastHardResyncTime: number;
  activeCarMask: number;
  skippedCorrections: number;
  hardSnapCount: number;
  totalCorrections: number;
  maxCorrectionDelta: number;
  carVisualPresets: Map<number, string>;
  options: { maxRollbackFrames?: number };
  onSignals: ((signals: MatchSignalDescriptor[], packetServerTick?: number | null) => void) | null;
  onRosterUpdate: ((msg: Record<string, unknown>) => void) | null;
  onHandshakeResponse: ((msg: Record<string, unknown>) => void) | null;
  onHardResync: (() => void) | null;
  setLobbyDualWorldMode: (enabled: boolean) => void;
  syncTimeline: (snapshot: Float32Array | null, serverTick: number, nowMs: number) => void;
  sendOutboundInputForTick: (
    tick: number,
    carIndex: number,
    controls: CarControls | null,
    nowMs: number
  ) => void;
  notifyMetricsUpdated: () => void;
  _resolveEffectiveRtt: () => number;
  getReconciliationTolerances: () => ReconciliationTolerances;
}

export class ReconcilerRollbackStepper {
  stepForwardTicks(
    sim: TelemetrySimPort,
    historyBuffer: PredictionHistoryBuffer,
    fromTick: number,
    toTick: number,
    localCarIndex: number,
    kickoffMaskUntilTick: number,
    useSilentStep: boolean,
    isRedundant: boolean,
    nowMs: number,
    sendOutboundInput: (tick: number, controls: CarControls | null, nowMs: number) => void
  ): number {
    const updatedTick = historyBuffer.stepSimulationRange(
      sim,
      fromTick,
      toTick,
      localCarIndex,
      kickoffMaskUntilTick,
      useSilentStep,
      !isRedundant ? (t, ctrl) => sendOutboundInput(t, ctrl, nowMs) : undefined
    );
    if (isRedundant && toTick > fromTick) sendOutboundInput(toTick - 1, null, nowMs);
    return updatedTick;
  }

  executeSyncTimeline(input: RollbackStepperSyncInput): RollbackStepperSyncOutput {
    const {
      sim,
      historyBuffer,
      visualSmoother,
      metrics,
      serverSnapshot,
      serverTick,
      nowMs,
      localCarIndex,
      lobbyDualWorldMode,
      kickoffMaskUntilTick,
      leadTicks,
      downlinkTicks,
      isRedundant,
      sendOutboundInput,
    } = input;

    const savedLobby = saveClientLobbyLocalEntities(sim, lobbyDualWorldMode);
    if (serverSnapshot) sim.restoreState(serverSnapshot);
    if (
      lobbyDualWorldMode ||
      (typeof sim?.isCarSlotActive === 'function' &&
        (sim.isCarSlotActive(6) || sim.isCarSlotActive(7)))
    ) {
      configureClientLobbyDiagnosticProbes(sim);
    }
    historyBuffer.backfillMissingLocalInputs(
      serverTick - 16,
      serverTick,
      localCarIndex,
      kickoffMaskUntilTick
    );
    this.stepForwardTicks(
      sim,
      historyBuffer,
      serverTick,
      serverTick + leadTicks + downlinkTicks,
      localCarIndex,
      kickoffMaskUntilTick,
      true,
      isRedundant,
      nowMs,
      sendOutboundInput
    );
    if (savedLobby) {
      restoreClientLobbyLocalEntities(
        sim,
        lobbyDualWorldMode,
        localCarIndex,
        historyBuffer.lastLocalControls,
        savedLobby
      );
    }
    const currentClientTick = Math.floor(sim.getHeaderView!().tickCount);
    const hardSnapCount = (input.hardSnapCount || 0) + 1;
    visualSmoother.reset();
    sim.saveStateSlot(currentClientTick % 256);
    historyBuffer.saveTickSnapshot(currentClientTick, sim);
    metrics.applyHardSyncState(currentClientTick, serverTick, leadTicks, hardSnapCount);

    return {
      currentClientTick,
      lastServerRecordedInputTick: serverTick - 1,
      lastAckedServerTick: serverTick,
      lastHardResyncTime: nowMs,
      hardSnapCount,
    };
  }

  executeReconcileStep(ctx: ReconcileStepHost, nowMs = performance.now()): void {
    const incomingPackets = ctx.controlMessenger.receiveChannelPackets(ctx.channel, nowMs);
    if (!incomingPackets || incomingPackets.length === 0) return;

    const packet = ctx.controlMessenger.drainAndParseServerPackets(
      {
        channel: ctx.channel,
        lobbyDualWorldMode: ctx.lobbyDualWorldMode,
        hostLobbyMode: ctx.hostLobbyMode,
        replayPlaybackMode: ctx.replayPlaybackMode,
        inputBufferTarget: ctx.pacingController.inputBufferTarget,
        metrics: ctx.metrics,
        boostPadEdgeTracker: ctx.boostPadEdgeTracker,
        isTimelineSynchronized: () => ctx.isTimelineSynchronized,
        onSignals: ctx.onSignals,
        onRosterUpdate: ctx.onRosterUpdate,
        onHandshakeResponse: ctx.onHandshakeResponse,
        setLocalCarIndex: (id) => {
          ctx.localCarIndex = id;
        },
        setLobbyDualWorldMode: (en) => ctx.setLobbyDualWorldMode(en),
        setLobbyAuthoritativeSnapshots: (prev, curr) => {
          ctx.lobbyPrevAuthoritativeState = prev;
          ctx.lobbyCurrAuthoritativeState = curr;
        },
        syncTimelineFromHandshake: (snap, frame, ts) => {
          ctx.syncTimeline(snap, frame, ts);
          ctx.interpolator?.sync?.(ts);
        },
      },
      incomingPackets,
      nowMs
    );
    ctx._hasServerReportedBuffer = ctx.controlMessenger.hasServerReportedBuffer;
    ctx.lastServerRecordedInputTick = ctx.controlMessenger.lastServerRecordedInputTick;
    ctx._lastProcessedClientTimestamp = ctx.controlMessenger.lastProcessedClientTimestamp;
    ctx._baseMeasuredRtt = ctx.controlMessenger.baseMeasuredRtt;
    ctx.measuredRtt = ctx.controlMessenger.measuredRtt;
    ctx.lastReceivedPacketRaw = ctx.controlMessenger.lastReceivedPacketRaw;
    ctx.drainedReplayPackets = ctx.controlMessenger.drainedReplayPackets;
    if (!packet) return;

    const serverTick = packet.serverTick;
    if (!ctx.replayPlaybackMode && serverTick <= ctx.lastAckedServerTick && serverTick > 0) return;
    ctx.lastAckedServerTick = serverTick;
    const effectiveRtt = ctx._resolveEffectiveRtt();
    ctx.metrics.applyServerAck(serverTick, effectiveRtt);
    const maxAckCarIndex = ctx.historyBuffer.recordAcknowledgedRemoteControls(
      packet.acknowledgedControls,
      ctx.localCarIndex
    );
    ctx.lastParsedPacket = packet;
    ctx.controlMessenger.recordLatestParsedPacket(packet);

    const lobbySnaps = ctx.controlMessenger.updateLobbyAuthoritativeSnapshots(
      ctx.lobbyDualWorldMode,
      packet,
      ctx.lobbyPrevAuthoritativeState,
      ctx.lobbyCurrAuthoritativeState
    );
    ctx.lobbyPrevAuthoritativeState = lobbySnaps.prev;
    ctx.lobbyCurrAuthoritativeState = lobbySnaps.curr;

    if (ctx.replayPlaybackMode) {
      ctx.notifyMetricsUpdated();
      return;
    }

    const topologyResult = syncClientCarTopology({
      sim: ctx.sim,
      packet,
      maxAckCarIndex,
      localCarIndex: ctx.localCarIndex,
      lobbyDualWorldMode: ctx.lobbyDualWorldMode,
      hostLobbyMode: ctx.hostLobbyMode,
      isLoopback: Boolean(ctx.channel?.isLoopback),
      carVisualPresets: ctx.carVisualPresets,
    });
    if (topologyResult.activeCarMask !== undefined)
      ctx.activeCarMask = topologyResult.activeCarMask;
    if (topologyResult.invalidateTimelineSync) ctx.isTimelineSynchronized = false;
    if (topologyResult.shouldNotifyMetrics) ctx.notifyMetricsUpdated();
    if (topologyResult.shouldAbortReconcile) return;

    const targets = ctx.pacingController.evaluateTimelineTargets(
      ctx.channel,
      ctx._baseMeasuredRtt,
      ctx.measuredRtt,
      ctx._hasServerReportedBuffer,
      ctx.metrics?.inputBufferSize,
      effectiveRtt
    );
    const leadTicks = targets.leadTicks;
    ctx.pacingController.leadTicks = leadTicks;
    ctx.metrics.leadTicks = leadTicks;
    const targetDelta = leadTicks + targets.downlinkTicks;

    let currentClientTick = Math.floor(ctx.sim.getHeaderView!().tickCount);
    const currentDelta = currentClientTick - serverTick;
    const desyncDistance = Math.abs(currentDelta - targetDelta);
    const rollbackDepth = currentClientTick - serverTick;
    const maxRollbackFrames = ctx.options.maxRollbackFrames ?? 180;

    if (
      !ctx.isTimelineSynchronized ||
      rollbackDepth > maxRollbackFrames ||
      rollbackDepth < 0 ||
      desyncDistance > maxRollbackFrames
    ) {
      const wasSync = ctx.isTimelineSynchronized;
      if (nowMs - ctx.lastHardResyncTime > 300 || !wasSync) {
        console.log(
          `[PredictionReconciler] Timeline sync aligned (currentDelta: ${currentDelta}, target: ${targetDelta}, rollbackDepth: ${rollbackDepth}). Snapping timeline to server tick ${serverTick}.`
        );
        ctx.syncTimeline(packet.stateSnapshot, serverTick, nowMs);
        const syncedTick = Math.floor(ctx.sim.getHeaderView!().tickCount);
        const isKickoffMasked =
          ctx.kickoffMaskUntilTick > 0 && syncedTick < ctx.kickoffMaskUntilTick;
        if (ctx.telemetryCollector.isMatchTelemetryActive && wasSync && !isKickoffMasked) {
          recordReconcileTelemetryTick({
            isMatchTelemetryActive: ctx.telemetryCollector.isMatchTelemetryActive,
            telemetryRecorder: ctx.telemetryCollector.recorder,
            nowMs,
            clientTick: syncedTick,
            serverTick,
            effectiveRtt,
            isHardResyncSnap: true,
            kickoffMaskUntilTick: ctx.kickoffMaskUntilTick,
            inputBufferTarget: ctx.pacingController.inputBufferTarget,
            leadTicks,
            interpolatorPhysicsRate: ctx.interpolator?.physicsRate,
            metrics: ctx.metrics,
            lastPacingStepStatus: ctx.telemetryCollector.lastPacingStepStatus,
          });
        }
        if (typeof ctx.onHardResync === 'function') ctx.onHardResync();
      }
      return;
    }

    ctx.shouldSkipLocalStep = false;
    const isRedundant = ctx.redundantHistoryCount > 1 || Boolean(ctx.enableRedundantInputs);
    currentClientTick = ctx.pacingController.stepPacing(
      currentClientTick,
      currentDelta,
      targetDelta,
      effectiveRtt,
      {
        nowMs,
        sim: ctx.sim,
        channel: ctx.channel,
        interpolator: ctx.interpolator,
        telemetryCollector: ctx.telemetryCollector,
        metrics: ctx.metrics,
        kickoffMaskUntilTick: ctx.kickoffMaskUntilTick,
        hasServerReportedBuffer: ctx._hasServerReportedBuffer,
        lobbyDualWorldMode: ctx.lobbyDualWorldMode,
        localCarIndex: ctx.localCarIndex,
        lastLocalControls: ctx.historyBuffer.lastLocalControls,
        stepForwardTicks: (from, to, silent, ts) =>
          this.stepForwardTicks(
            ctx.sim,
            ctx.historyBuffer,
            from,
            to,
            ctx.localCarIndex,
            ctx.kickoffMaskUntilTick,
            silent,
            isRedundant,
            ts,
            (t, ctrl, tMs) => ctx.sendOutboundInputForTick(t, ctx.localCarIndex, ctrl, tMs)
          ),
      }
    );

    const { prePositions, hasNaN, numCars } = capturePreResimPositions(ctx.sim, 8);
    if (hasNaN) {
      console.error(
        '[PredictionReconciler] NaN detected in vehicle coordinates! Forcing full state reset.'
      );
      ctx.syncTimeline(packet.stateSnapshot, serverTick, nowMs);
      if (typeof ctx.onHardResync === 'function') ctx.onHardResync();
      return;
    }

    const updatedCounters = ctx.visualSmoother.executeReplayAndEvaluateCorrection({
      sim: ctx.sim,
      historyBuffer: ctx.historyBuffer,
      packet,
      serverTick,
      currentClientTick,
      prePositions,
      numCars,
      localCarIndex: ctx.localCarIndex,
      lobbyDualWorldMode: ctx.lobbyDualWorldMode,
      kickoffMaskUntilTick: ctx.kickoffMaskUntilTick,
      tolerances: ctx.getReconciliationTolerances(),
      metrics: ctx.metrics,
      skippedCorrections: ctx.skippedCorrections,
      hardSnapCount: ctx.hardSnapCount,
      totalCorrections: ctx.totalCorrections,
      maxCorrectionDelta: ctx.maxCorrectionDelta,
    });
    ctx.skippedCorrections = updatedCounters.skippedCorrections;
    ctx.hardSnapCount = updatedCounters.hardSnapCount;
    ctx.totalCorrections = updatedCounters.totalCorrections;
    ctx.maxCorrectionDelta = updatedCounters.maxCorrectionDelta;

    ctx.metrics.clientTick = currentClientTick;
    if (ctx.telemetryCollector.isMatchTelemetryActive) {
      recordReconcileTelemetryTick({
        isMatchTelemetryActive: ctx.telemetryCollector.isMatchTelemetryActive,
        telemetryRecorder: ctx.telemetryCollector.recorder,
        nowMs,
        clientTick: currentClientTick,
        serverTick,
        effectiveRtt,
        isHardResyncSnap: false,
        kickoffMaskUntilTick: ctx.kickoffMaskUntilTick,
        inputBufferTarget: ctx.pacingController.inputBufferTarget,
        leadTicks,
        interpolatorPhysicsRate: ctx.interpolator?.physicsRate,
        metrics: ctx.metrics,
        lastPacingStepStatus: ctx.telemetryCollector.lastPacingStepStatus,
      });
    }
    ctx.notifyMetricsUpdated();
  }
}
