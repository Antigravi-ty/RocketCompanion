/**
 * reconcilerSessionPipeline.ts
 * Pure session state & packet preparation pipeline for PredictionReconciler:
 * session interface contract, timeline reset, tolerance clamping, local step commit,
 * and inbound server packet draining/replay-mode handling.
 */

import type {
  CarControls,
  PredictionHistoryBuffer,
  ReconciliationTolerances,
} from './PredictionHistoryBuffer.ts';
import type { VisualErrorSmoother } from './VisualErrorSmoother.ts';
import type { NetworkTelemetryCollector } from './NetworkTelemetryCollector.ts';
import type {
  HandshakeResponsePayload,
  PredictionReconcilerOptions,
  ReconcilerMetrics,
  RosterStatePayload,
  TelemetryChannelPort,
  TelemetrySimPort,
} from './ReconcilerMetricsModel.ts';
import type {
  ClientClockPacingController,
  ClockPacingInterpolatorPort,
} from './ClientClockPacingController.ts';
import type {
  OutboundRedundantInputConfig,
  ParsedReconcilerPacket,
  ReconcilerControlMessenger,
} from './ReconcilerControlMessenger.ts';
import type { MatchSignalDescriptor } from '../protocol/GlobalPayloadCodec.ts';
import {
  createBoostPadEdgeTracker,
  type BoostPadEdgeTracker,
} from '../protocol/boostPadBitmaskPipeline.ts';
import type { RollbackStepState } from './reconcilerRollbackPipeline.ts';

export type ReconcilerSignalsCallback = (
  signals: MatchSignalDescriptor[],
  packetServerTick?: number | null
) => void;
export type ReconcilerMessageCallback<T = Record<string, unknown>> = (msg: T) => void;
export type ReconcilerHardResyncCallback = () => void;

export interface ReconcileSessionTarget extends RollbackStepState {
  sim: TelemetrySimPort;
  channel: TelemetryChannelPort | null | undefined;
  options: PredictionReconcilerOptions;
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
  useBitPacking: boolean;
  redundantHistoryTicks: number;
  tickDtMs: number;
  neutralControls: Readonly<CarControls>;
  posTolerance: number;
  velTolerance: number;
  rotTolerance: number;
  ballPosTolerance: number;
  ballVelTolerance: number;
  boostTolerance: number;
  hardSnapThreshold: number;
  carVisualPresets: Map<number, string>;
  lobbyPrevAuthoritativeState: Float32Array | null;
  lobbyCurrAuthoritativeState: Float32Array | null;
  onSignals: ReconcilerSignalsCallback | null;
  onRosterUpdate: ReconcilerMessageCallback<RosterStatePayload> | null;
  onHandshakeResponse: ReconcilerMessageCallback<HandshakeResponsePayload> | null;
  onHardResync: ReconcilerHardResyncCallback | null;
  onMetricsUpdated: ((metrics: ReconcilerMetrics) => void) | null;
  setLobbyDualWorldMode(enabled: boolean): void;
  getReconciliationTolerances(): ReconciliationTolerances;
  getOutboundRedundantConfig(): OutboundRedundantInputConfig;
  _resolveEffectiveRtt(): number;
  syncTimeline(serverSnapshot: Float32Array | null, serverTick?: number, nowMs?: number): void;
  notifyMetricsUpdated(): void;
}

export function applyReconcilerInitialOptions(
  session: ReconcileSessionTarget,
  opts: PredictionReconcilerOptions
): void {
  session.localCarIndex = opts.localCarIndex ?? 0;
  session.redundantHistoryCount =
    opts.redundantHistoryCount ?? (opts.enableRedundantBuffer ? 10 : 1);
  session.useBitPacking = opts.useBitPacking ?? false;
  const initTick = Math.max(-1, Math.floor(session.sim?.getHeaderView?.()?.tickCount || 0) - 1);
  session.lastServerRecordedInputTick = initTick;
  session.controlMessenger.lastServerRecordedInputTick = initTick;
  session.posTolerance = opts.posTolerance ?? 0.5;
  session.velTolerance = opts.velTolerance ?? 5.0;
  session.rotTolerance = opts.rotTolerance ?? 0.015;
  session.ballPosTolerance = opts.ballPosTolerance ?? 1.0;
  session.ballVelTolerance = opts.ballVelTolerance ?? 10.0;
  session.boostTolerance = opts.boostTolerance ?? 1.0;
  session.hardSnapThreshold = opts.hardSnapThreshold ?? 500.0;
  session.enableRedundantInputs = opts.enableRedundantInputs ?? false;
  session.redundantHistoryTicks = opts.redundantHistoryTicks ?? 12;
  session.interpolator = opts.interpolator || null;
  session.lobbyDualWorldMode = Boolean(opts.lobbyDualWorldMode);
  session.hostLobbyMode = Boolean(
    opts.hostLobbyMode ?? (session.channel?.isLoopback && !opts.lobbyDualWorldMode)
  );
  if (opts.resetTelemetryOnStart !== false) {
    session.pacingController.resetTelemetry(session.telemetryCollector);
  }
  session.onHardResync = opts.onHardResync || null;
}

export function resetRollbackSessionTimeline(session: ReconcileSessionTarget): void {
  const initialTick = Math.max(-1, Math.floor(session.sim?.getHeaderView?.()?.tickCount || 0) - 1);
  session.lastAckedServerTick = -1;
  session.lastServerRecordedInputTick = initialTick;
  session.isTimelineSynchronized = false;
  session.shouldSkipLocalStep = false;
  session.lastHardResyncTime = 0;
  session.controlMessenger.resetTimelineCounters(initialTick);
  if (session.metrics) session.metrics.serverTick = 0;
  session.telemetryCollector.pacingControllerState = { initialized: false };
  session.historyBuffer.clear();
  session.visualSmoother.reset();
  session.boostPadEdgeTracker = createBoostPadEdgeTracker();
}

export function syncSessionMetricsAndEmit(session: ReconcileSessionTarget): void {
  session.pacingController.syncLatencyBreakdownToMetrics(
    session.channel,
    session.controlMessenger.baseMeasuredRtt,
    session.controlMessenger.measuredRtt,
    session.controlMessenger.hasServerReportedBuffer,
    session.metrics,
    session.visualSmoother.enabled,
    session.historyBuffer.capacity
  );
  session.telemetryCollector.emitMetrics(session.metrics, session.onMetricsUpdated);
}

export function resetReconcilerCorrectionStats(session: ReconcileSessionTarget): void {
  session.totalCorrections = 0;
  session.skippedCorrections = 0;
  session.hardSnapCount = 0;
  session.maxCorrectionDelta = 0;
  session.visualSmoother.reset();
  session.metrics.resetCorrectionStats();
  session.telemetryCollector.recorder?.reset?.();
}

export function applySessionReconciliationTolerances(
  session: ReconcileSessionTarget,
  tolerances: Partial<ReconciliationTolerances> = {}
): void {
  const nonNeg = (v: number | undefined, cur: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : cur;
  session.posTolerance = nonNeg(tolerances.posTolerance, session.posTolerance);
  session.velTolerance = nonNeg(tolerances.velTolerance, session.velTolerance);
  session.rotTolerance = nonNeg(tolerances.rotTolerance, session.rotTolerance);
  session.ballPosTolerance = nonNeg(tolerances.ballPosTolerance, session.ballPosTolerance);
  session.ballVelTolerance = nonNeg(tolerances.ballVelTolerance, session.ballVelTolerance);
  if (
    typeof tolerances.hardSnapThreshold === 'number' &&
    Number.isFinite(tolerances.hardSnapThreshold) &&
    tolerances.hardSnapThreshold > 0
  ) {
    session.hardSnapThreshold = tolerances.hardSnapThreshold;
  }
  session.notifyMetricsUpdated();
}

export function commitPredictedLocalStep(
  session: ReconcileSessionTarget,
  carIndex: number,
  controls: CarControls,
  nowMs = performance.now()
): { committed: CarControls; shouldNotifyMetrics: boolean } {
  const { sim, channel, historyBuffer, controlMessenger, localCarIndex, metrics } = session;
  const currentTick = Math.floor(sim.getHeaderView!().tickCount);
  const isKickoffMasked =
    session.kickoffMaskUntilTick > 0 && currentTick < session.kickoffMaskUntilTick;
  const committed = isKickoffMasked
    ? historyBuffer.setCarControls(currentTick, carIndex, session.neutralControls)
    : historyBuffer.getCarControls(currentTick, carIndex) ||
      historyBuffer.setCarControls(currentTick, carIndex, controls);
  if (carIndex === localCarIndex) historyBuffer.lastLocalControls = { ...committed };
  historyBuffer.clientInputRingBuffer.record(currentTick, carIndex, committed);
  controlMessenger.sendOutboundInputForTick(
    channel,
    historyBuffer,
    session.getOutboundRedundantConfig(),
    localCarIndex,
    currentTick,
    carIndex,
    committed,
    nowMs
  );
  sim.saveStateSlot(currentTick % 256);
  historyBuffer.saveTickSnapshot(currentTick, sim);
  metrics.applyClientPredictionStep(
    currentTick,
    session._resolveEffectiveRtt(),
    session.pacingController.leadTicks
  );
  return { committed, shouldNotifyMetrics: currentTick % 2 === 0 };
}

export function drainAndPrepareInboundSessionPacket(
  session: ReconcileSessionTarget,
  incomingPackets: unknown[],
  nowMs: number
): { packet: ParsedReconcilerPacket; effectiveRtt: number } | null {
  const packet = session.controlMessenger.drainAndParseServerPackets(
    {
      channel: session.channel,
      lobbyDualWorldMode: session.lobbyDualWorldMode,
      hostLobbyMode: session.hostLobbyMode,
      replayPlaybackMode: session.replayPlaybackMode,
      inputBufferTarget: session.pacingController.inputBufferTarget,
      metrics: session.metrics,
      boostPadEdgeTracker: session.boostPadEdgeTracker,
      isTimelineSynchronized: () => session.isTimelineSynchronized,
      onSignals: session.onSignals,
      onRosterUpdate: session.onRosterUpdate,
      onHandshakeResponse: session.onHandshakeResponse,
      setLocalCarIndex: (id) => {
        session.localCarIndex = id;
      },
      setLobbyDualWorldMode: (en) => session.setLobbyDualWorldMode(en),
      setLobbyAuthoritativeSnapshots: (prev, curr) => {
        session.lobbyPrevAuthoritativeState = prev;
        session.lobbyCurrAuthoritativeState = curr;
      },
      syncTimelineFromHandshake: (snap, frame, ts) => {
        session.syncTimeline(snap, frame, ts);
        session.interpolator?.sync?.(ts);
      },
    },
    incomingPackets,
    nowMs
  );
  session.lastServerRecordedInputTick = session.controlMessenger.lastServerRecordedInputTick;
  if (!packet) return null;

  const serverTick = packet.serverTick;
  if (!session.replayPlaybackMode && serverTick <= session.lastAckedServerTick && serverTick > 0) {
    return null;
  }

  session.controlMessenger.recordLatestParsedPacket(packet);
  const lobbySnaps = session.controlMessenger.updateLobbyAuthoritativeSnapshots(
    session.lobbyDualWorldMode,
    packet,
    session.lobbyPrevAuthoritativeState,
    session.lobbyCurrAuthoritativeState
  );
  session.lobbyPrevAuthoritativeState = lobbySnaps.prev;
  session.lobbyCurrAuthoritativeState = lobbySnaps.curr;

  const effectiveRtt = session._resolveEffectiveRtt();
  if (session.replayPlaybackMode) {
    session.lastAckedServerTick = serverTick;
    session.metrics.applyServerAck(serverTick, effectiveRtt);
    session.historyBuffer.recordAcknowledgedRemoteControls(
      packet.acknowledgedControls,
      session.localCarIndex
    );
    session.notifyMetricsUpdated();
    return null;
  }

  return { packet, effectiveRtt };
}
