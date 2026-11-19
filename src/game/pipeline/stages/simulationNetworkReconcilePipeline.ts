import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.ts';
import {
  type ReplayDirectorRosterRuntimePort,
  captureRuntimeReplayCarEntries,
} from '../../../replay/replayDirectorCarRosterPipeline.ts';
import { MATCH_SIGNALS } from '../../../network/protocol/GlobalPayloadCodec.ts';
import type { SpectateInterpolationBuffer } from '../../../network/sync/ReplicationStateInterpolator.ts';
import type { CameraManager } from '../../../camera/CameraManager.ts';
import type { AuthoritativeServerHost } from '../../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../../network/client/PredictionReconciler.ts';
import type { PhysicsStateInterpolator } from '../../../physics/PhysicsStateInterpolator.ts';
import type { RocketSimPhysicsEngine } from '../../../physics/RocketSimPhysicsEngine.ts';
import type { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import type {
  SimulationDrivePolicy,
  SimulationFrameExecutionFlags,
  SimulationMatchStateSnapshot,
} from './simulationFrameClassifierPipeline.ts';

export function hasPhysicsStatePositionNaN(physics: RocketSimPhysicsEngine): boolean {
  const st = physics.state;
  if (!st) return false;
  if (!Number.isFinite(st[4]) || !Number.isFinite(st[5]) || !Number.isFinite(st[6])) {
    return true;
  }
  const nCars = Math.min(physics.numCars || 1, 8);
  for (let c = 0; c < nCars; c++) {
    if (typeof physics.isCarSlotActive === 'function' && !physics.isCarSlotActive(c)) {
      continue;
    }
    const cOff = 22 + c * 40;
    if (
      !Number.isFinite(st[cOff]) ||
      !Number.isFinite(st[cOff + 1]) ||
      !Number.isFinite(st[cOff + 2])
    ) {
      return true;
    }
  }
  return false;
}

function recordClientDiagnosticReplayFrame(
  physics: RocketSimPhysicsEngine,
  maxFrames: number
): { recorded: boolean; overflowPaused: boolean } {
  const curFrames = physics.getReplayFrameCount?.() ?? 0;
  if (curFrames >= maxFrames) {
    physics.setReplayRecordingActive?.(false);
    return { recorded: false, overflowPaused: true };
  }
  if (physics.getReplayRecordingActive?.() !== false) {
    physics.recordReplayFrame?.();
    return { recorded: true, overflowPaused: false };
  }
  return { recorded: false, overflowPaused: false };
}

function shouldFlushReconcilerControls(
  policy: SimulationDrivePolicy,
  matchState: SimulationMatchStateSnapshot,
  flags: SimulationFrameExecutionFlags,
  reconciler: PredictionReconciler
): boolean {
  if (policy.mode === 'client-goal-replay' || policy.mode === 'local-replay-playback') {
    return true;
  }
  if (reconciler.replayPlaybackMode) {
    return true;
  }
  if (flags.isMatchEnded || matchState.paused) {
    return true;
  }
  return matchState.phase === 'prepare';
}

function canRecordLiveDiagnosticTick(
  policy: SimulationDrivePolicy,
  matchState: SimulationMatchStateSnapshot,
  flags: SimulationFrameExecutionFlags
): boolean {
  if (matchState.paused) return false;
  if (flags.isMatchEnded) return false;
  if (flags.isGoalReplay) return false;
  return policy.mode === 'host-authoritative' || policy.mode === 'local-freeplay';
}

function feedStreamedReplayPacket(
  pkt: { stateSnapshot?: Float32Array; serverTick?: number; acknowledgedControls?: unknown },
  replayTimelineController: ReplayTimelineController | null,
  rosterCapturePort: ReplayDirectorRosterRuntimePort,
  matchState: SimulationMatchStateSnapshot
): void {
  if (!replayTimelineController || !pkt.stateSnapshot) return;
  if (!replayTimelineController.sessionState.isActive) {
    const carEntries = captureRuntimeReplayCarEntries(rosterCapturePort, {
      frameBuffer: pkt.stateSnapshot,
      defaultTeam: matchState.scorer ?? 0,
    });
    replayTimelineController.beginReplaySession({
      scoringTeam: matchState.scorer ?? 0,
      scorerCarIndex: matchState.scorerCarIndex ?? 0,
      carEntries,
      isNetworkStreamed: true,
    });
  }
  const recordedReplayTick = Math.floor(
    Number(pkt.stateSnapshot[0]) > 0 ? pkt.stateSnapshot[0] : pkt.serverTick || 0
  );
  replayTimelineController.appendStreamedReplayFrame?.(
    pkt.stateSnapshot,
    recordedReplayTick,
    pkt.acknowledgedControls as never
  );
}

export interface NetworkReconcileStepInput {
  readonly timestamp: number;
  readonly physics: RocketSimPhysicsEngine;
  readonly interpolator: PhysicsStateInterpolator;
  readonly camera: CameraManager | null;
  readonly matchState: SimulationMatchStateSnapshot;
  readonly flags: SimulationFrameExecutionFlags;
  readonly policy: SimulationDrivePolicy;
  readonly reconciler: PredictionReconciler | null;
  readonly server: AuthoritativeServerHost | null;
  readonly replayTimelineController: ReplayTimelineController | null;
  readonly rosterCapturePort: ReplayDirectorRosterRuntimePort;
  readonly diagnosticDumpMaxFrames: number;
  readonly fleetController: {
    enabled: boolean;
    applyToAuthority(serverOrSim: unknown, tick: number): void;
  } | null;
  readonly sessionStateTarget: { clientReplayOverflowPaused?: boolean } | null;
  readonly lastRecordedClientReplayTick: number;
  readonly skipReconciler?: boolean;
  readonly spectateInterpolationBuffer?: SpectateInterpolationBuffer | null;
}

export function stepNetworkReconciliationAndReplayStream(input: NetworkReconcileStepInput): number {
  const {
    timestamp,
    physics,
    interpolator,
    camera,
    matchState,
    flags,
    policy,
    reconciler,
    server,
    replayTimelineController,
    rosterCapturePort,
    diagnosticDumpMaxFrames,
    fleetController,
    sessionStateTarget,
    skipReconciler = false,
    spectateInterpolationBuffer = null,
  } = input;

  let nextRecordedTick = input.lastRecordedClientReplayTick;
  const now = performance.now();

  if (server) {
    if (!skipReconciler && fleetController?.enabled && !server.isWorker) {
      const sTick = Math.floor(server.sim?.getHeaderView?.()?.tickCount ?? 0);
      fleetController.applyToAuthority(server, sTick);
    }
    server.update();
  }

  if (skipReconciler || !reconciler) {
    spectateInterpolationBuffer?.reset();
    if (skipReconciler && reconciler && !server) {
      reconciler.flushPendingControlPackets?.(now);
    }
    const currentTick = Math.floor(physics.getHeaderView().tickCount);
    if (
      sessionStateTarget &&
      canRecordLiveDiagnosticTick(policy, matchState, flags) &&
      currentTick !== nextRecordedTick
    ) {
      const recOut = recordClientDiagnosticReplayFrame(physics, diagnosticDumpMaxFrames);
      sessionStateTarget.clientReplayOverflowPaused = recOut.overflowPaused;
      if (recOut.recorded) {
        nextRecordedTick = currentTick;
      }
    }
    return nextRecordedTick;
  }

  const tickBeforeReconcile = Math.floor(physics.getHeaderView().tickCount);
  reconciler.reconcile(now);
  if (shouldFlushReconcilerControls(policy, matchState, flags, reconciler)) {
    reconciler.flushPendingControlPackets?.(now);
  }
  const tickAfterReconcile = Math.floor(physics.getHeaderView().tickCount);

  const isPureCsrSpectate = Boolean(
    reconciler.spectateMirrorMode &&
    (reconciler.clientInputEnabled === false || reconciler.activeInputPeerId === 'host') &&
    !reconciler.hostLobbyMode
  );
  const useSpectateBuffer =
    (policy.mode === 'client-csr-spectate' || policy.mode === 'client-goal-replay') &&
    isPureCsrSpectate &&
    !reconciler.replayPlaybackMode &&
    Boolean(spectateInterpolationBuffer);

  if (!useSpectateBuffer) {
    spectateInterpolationBuffer?.reset();
  }

  if (useSpectateBuffer && spectateInterpolationBuffer) {
    const lastSignals = (
      reconciler.lastParsedPacket as { signals?: Array<{ signalType?: number }> } | null
    )?.signals;
    const hasResetSignal =
      Array.isArray(lastSignals) &&
      lastSignals.some(
        (s) =>
          s?.signalType === MATCH_SIGNALS.BALL_RESET ||
          s?.signalType === MATCH_SIGNALS.ROUND_STARTED
      );
    if (hasResetSignal) {
      spectateInterpolationBuffer.reset();
    }

    const packets = reconciler.drainedReplayPackets;
    if (Array.isArray(packets) && packets.length > 0) {
      if (policy.shouldFeedReplayTimeline) {
        const lastPkt = packets[packets.length - 1];
        if (
          lastPkt?.stateSnapshot &&
          replayTimelineController &&
          !replayTimelineController.sessionState.isActive
        ) {
          const carEntries = captureRuntimeReplayCarEntries(rosterCapturePort, {
            frameBuffer: lastPkt.stateSnapshot,
            defaultTeam: matchState.scorer ?? 0,
          });
          replayTimelineController.beginReplaySession({
            scoringTeam: matchState.scorer ?? 0,
            scorerCarIndex: matchState.scorerCarIndex ?? 0,
            carEntries,
            isNetworkStreamed: true,
          });
        }
      }
      for (let i = 0; i < packets.length; i++) {
        const pkt = packets[i];
        if (!pkt?.stateSnapshot) continue;
        spectateInterpolationBuffer.pushFrame(pkt.stateSnapshot, pkt.serverTick || 0, now);
        if (policy.shouldFeedReplayTimeline) {
          feedStreamedReplayPacket(pkt, replayTimelineController, rosterCapturePort, matchState);
        }
      }
      packets.length = 0;
    }

    const canSampleToEngine =
      !flags.isLocalReplayControllerStepping && !(server && policy.mode !== 'client-goal-replay');
    if (canSampleToEngine) {
      const sampled = spectateInterpolationBuffer.sample(now);
      if (sampled) {
        if (reconciler.metrics) {
          reconciler.metrics.measuredJitterMs = Math.round(sampled.jitterMs * 10) / 10;
        }
        applyReplayFrameToEngine(physics, sampled.snapshot, interpolator);
        if (!matchState.paused && !flags.isMatchEnded && sessionStateTarget) {
          const recOut = recordClientDiagnosticReplayFrame(physics, diagnosticDumpMaxFrames);
          sessionStateTarget.clientReplayOverflowPaused = recOut.overflowPaused;
        }
      }
    }
    return nextRecordedTick;
  }

  const packets = reconciler.drainedReplayPackets;
  const isReplayStreamMode =
    reconciler.replayPlaybackMode || isPureCsrSpectate || policy.mode === 'client-goal-replay';
  if (isReplayStreamMode && Array.isArray(packets) && packets.length > 0) {
    const s = replayTimelineController?.sessionState;
    const isCustomScrubbing = Boolean(
      s && (s.isScrubbing || s.isPaused || Math.abs((s.playbackSpeed ?? 1.0) - 1.0) > 0.01)
    );
    const startIdx = !reconciler.replayPlaybackMode && isPureCsrSpectate ? packets.length - 1 : 0;
    const canApplyStreamFrame =
      !(isCustomScrubbing && policy.mode === 'client-goal-replay') &&
      !flags.isLocalReplayControllerStepping &&
      !(server && policy.mode !== 'client-goal-replay');

    for (let i = startIdx; i < packets.length; i++) {
      const pkt = packets[i];
      if (!pkt?.stateSnapshot) continue;
      if (policy.shouldFeedReplayTimeline) {
        feedStreamedReplayPacket(pkt, replayTimelineController, rosterCapturePort, matchState);
      }
      if (canApplyStreamFrame) {
        applyReplayFrameToEngine(physics, pkt.stateSnapshot, interpolator);
        if (!matchState.paused && !flags.isMatchEnded && sessionStateTarget) {
          const recOut = recordClientDiagnosticReplayFrame(physics, diagnosticDumpMaxFrames);
          sessionStateTarget.clientReplayOverflowPaused = recOut.overflowPaused;
        }
      }
    }
    packets.length = 0;
    return nextRecordedTick;
  }

  if (policy.mode === 'local-freeplay' && physics.state) {
    if (hasPhysicsStatePositionNaN(physics)) {
      physics.restoreCompactState?.(physics.state, { preserveEngineTick: true });
      interpolator.sync(timestamp);
      camera?.resetView();
    } else {
      interpolator.currState.set(physics.state);
      const needsPrevSnap =
        tickAfterReconcile !== tickBeforeReconcile ||
        (reconciler.metrics.lastCorrectionDelta > 0.05 && !reconciler.enableSmoothing);
      if (needsPrevSnap) {
        interpolator.prevState.set(physics.state);
      }
    }
  }

  if (
    sessionStateTarget &&
    canRecordLiveDiagnosticTick(policy, matchState, flags) &&
    tickAfterReconcile !== nextRecordedTick
  ) {
    const recOut = recordClientDiagnosticReplayFrame(physics, diagnosticDumpMaxFrames);
    sessionStateTarget.clientReplayOverflowPaused = recOut.overflowPaused;
    if (recOut.recorded) {
      nextRecordedTick = tickAfterReconcile;
    }
  }

  return nextRecordedTick;
}
