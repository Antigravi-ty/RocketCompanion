import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.ts';
import { captureRuntimeReplayCarEntries } from '../../../replay/replayDirectorCarRosterPipeline.ts';
import type { CameraManager } from '../../../camera/CameraManager.ts';
import type { AuthoritativeServerHost } from '../../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../../network/client/PredictionReconciler.ts';
import type { PhysicsStateInterpolator } from '../../../physics/PhysicsStateInterpolator.ts';
import type { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import type { FrameContext, PipelineStage } from '../FramePipeline.ts';
import {
  CarActionEventSynthesizer,
  type CarActionDebounceState,
  type CarActionSynthesizerRuntimePort,
} from './CarActionEventSynthesizer.ts';

export type { CarActionDebounceState };

interface ActiveModeSimulationPort {
  directorPreview?: { isReplayActive?: boolean } | null;
  lifecycleController?: { podiumDelayTicks?: number } | null;
  rewinderController?: {
    isBlockingLivePhysics?: boolean;
    getRewinderState?(): string;
  } | null;
  standaloneReplayViewer?: {
    isActive?: boolean;
    hasLoadedReplay?: boolean;
    getViewerState?(): string;
  } | null;
  rlrcReplaySession?: {
    isActive?: boolean;
    hasLoadedReplay?: boolean;
    getPhase?(): string;
  } | null;
  replayController?: { sessionState?: { isPaused?: boolean } | null } | null;
  replaySession?: {
    replayController?: { sessionState?: { isPaused?: boolean } | null } | null;
  } | null;
  onBeforePhysicsTick?(): boolean | void;
  onStepPhysicsTick?(): boolean | void;
  onAfterPhysicsTick?(): void;
  onPhysicsEvent?(event: unknown): void;
}

export interface SimulationStageRuntimePort extends CarActionSynthesizerRuntimePort {
  interpolator: PhysicsStateInterpolator | null;
  match: { state: { mode: string; phase: string; paused?: boolean; scorer?: number | null; scorerCarIndex?: number | null } } | null;
  camera: CameraManager | null;
  podiumController: { isActive: boolean } | null;
  replayTimelineController: ReplayTimelineController | null;
  modeManager: {
    getActiveMode(): ActiveModeSimulationPort | null;
  } | null;
  networkManager: {
    diagnosticDumpMaxFrames?: number;
    rosterSyncCoordinator?: {
      lastRosterSnapshot?: {
        players?: Array<{
          carIndex?: number;
          entityId?: number;
          team?: number | string;
          [key: string]: unknown;
        }>;
      } | null;
    } | null;
    sessionCoordinator: {
      authoritativeServer: AuthoritativeServerHost | null;
      networkReconciler: PredictionReconciler | null;
      clientReplayOverflowPaused?: boolean;
    };
    diagnosticsProbe: {
      testCarAudioEnabled?: boolean;
      diagnosticsFleetController?: {
        enabled: boolean;
        applyToAuthority(serverOrSim: unknown, tick: number): void;
      } | null;
    };
  } | null;
  profiler: { mark(): void } | null;
  pollInputs(commitPhysicsStep?: boolean): boolean;
}

/**
 * SimulationStage.ts
 * Advances deterministic 120Hz physics accumulator, network reconciliation,
 * and delegates vehicle action debounce & incident synthesis to CarActionEventSynthesizer.
 */
export class SimulationStage implements PipelineStage {
  public runtime: SimulationStageRuntimePort;
  public readonly actionSynthesizer = new CarActionEventSynthesizer();
  private _lastRecordedClientReplayTick = -1;
  private _pendingGoalScored = false;

  constructor(runtime: SimulationStageRuntimePort) {
    this.runtime = runtime;
  }

  public resetActionStates(): void {
    this._pendingGoalScored = false;
    this.actionSynthesizer.reset();
  }

  public resetCarActionStates(): void {
    this.resetActionStates();
  }

  public getCarActionState(carIdx: number): CarActionDebounceState {
    return this.actionSynthesizer.getCarActionState(carIdx);
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;
    if (!r.match || !r.interpolator || !r.physics) return;
    const { timestamp, activeCar } = context;
    const activeMode = r.modeManager?.getActiveMode?.() as ActiveModeSimulationPort | null;
    const net = r.networkManager;
    const session = net?.sessionCoordinator;
    const reconciler = session?.networkReconciler ?? null;
    const server = session?.authoritativeServer ?? null;

    context.isPodiumActive = Boolean(
      r.podiumController?.isActive || r.match.state.phase === 'podium',
    );

    const isExpPodiumDelayActive =
      r.match.state.mode === 'exp-multi-bots' &&
      r.match.state.phase === 'ended' &&
      (activeMode?.lifecycleController?.podiumDelayTicks ?? 0) > 0;
    const isMatchEnded =
      (r.match.state.mode === 'match' || r.match.state.mode === 'exp-multi-bots') &&
      (r.match.state.phase === 'ended' || r.match.state.phase === 'podium') &&
      !isExpPodiumDelayActive;
    const isLocalDirectorPreview = Boolean(activeMode?.directorPreview?.isReplayActive);
    const isGoalReplay =
      isLocalDirectorPreview ||
      ((r.match.state.mode === 'match' ||
        r.match.state.mode === 'exp-multi-bots' ||
        r.match.state.mode === 'freeplay' ||
        r.match.state.mode === 'replay-viewer' ||
        r.match.state.mode === 'static-training-pack') &&
        r.match.state.phase === 'replay');

    const isMinimizedOffline =
      typeof document !== 'undefined' &&
      Boolean(document.hidden) &&
      !reconciler &&
      !server;

    const isLocalReplayControllerStepping = Boolean(
      isLocalDirectorPreview ||
        activeMode?.rewinderController?.isBlockingLivePhysics ||
        activeMode?.standaloneReplayViewer?.isActive ||
        activeMode?.rlrcReplaySession?.isActive,
    );

    if (
      (r.match.state.paused && !isLocalReplayControllerStepping) ||
      isMatchEnded ||
      isGoalReplay ||
      isMinimizedOffline
    ) {
      if (!isGoalReplay && !r.podiumController?.isActive) {
        r.interpolator.sync(timestamp);
      }
    } else {
      r.interpolator.update(
        timestamp,
        () => {
          r.pollInputs();
          if (activeCar >= 0 && !r.playerControls?.jump) {
            this.actionSynthesizer.notifyLocalJumpReleased(activeCar);
          }
          const fleet = net?.diagnosticsProbe?.diagnosticsFleetController;
          if (fleet?.enabled && r.physics && !reconciler) {
            const cTick = Math.floor(r.physics.getHeaderView().tickCount);
            fleet.applyToAuthority(r.physics, cTick);
          }
          const modeName = r.match?.state.mode;
          if (
            modeName === 'freeplay' ||
            modeName === 'replay-viewer' ||
            modeName === 'kickoff-training' ||
            modeName === 'dev-test-lab' ||
            modeName === 'exp-multi-bots' ||
            modeName === 'static-training-pack'
          ) {
            return r.modeManager?.getActiveMode()?.onBeforePhysicsTick?.();
          }
        },
        r.match.state.mode === 'kickoff-training'
          ? () => r.modeManager?.getActiveMode()?.onStepPhysicsTick?.()
          : r.match.state.mode === 'freeplay' ||
              r.match.state.mode === 'replay-viewer' ||
              r.match.state.mode === 'dev-test-lab' ||
              r.match.state.mode === 'exp-multi-bots' ||
              r.match.state.mode === 'static-training-pack'
            ? () => {
                r.physics!.step(1);
                r.modeManager?.getActiveMode()?.onAfterPhysicsTick?.();
                return true;
              }
            : undefined,
      );
    }

    const activeSim = r.physics;
    if (reconciler) {
      context.goalScored = r.match.state.phase === 'goal';
    } else {
      if (activeSim.pollGoal() !== 0) {
        this._pendingGoalScored = true;
      }
      context.goalScored = Boolean(this._pendingGoalScored);
      if (!context.isSimulationOnly) {
        this._pendingGoalScored = false;
      }
    }

    if (reconciler && !isLocalDirectorPreview) {
      const now = performance.now();
      if (server) {
        if (
          net?.diagnosticsProbe?.diagnosticsFleetController?.enabled &&
          !server.isWorker
        ) {
          const sTick = Math.floor(server.sim?.getHeaderView?.()?.tickCount ?? 0);
          net.diagnosticsProbe.diagnosticsFleetController.applyToAuthority(
            server,
            sTick,
          );
        }
        server.update();
      }
      const tickBeforeReconcile = Math.floor(r.physics.getHeaderView().tickCount);
      reconciler.reconcile(now);
      if (
        r.match.state.paused ||
        isMatchEnded ||
        isGoalReplay ||
        reconciler.replayPlaybackMode ||
        r.match.state.phase === 'prepare'
      ) {
        reconciler.flushPendingControlPackets?.(now);
      }
      const tickAfterReconcile = Math.floor(r.physics.getHeaderView().tickCount);
      if (
        r.interpolator &&
        !isGoalReplay &&
        !reconciler.replayPlaybackMode &&
        r.physics?.state
      ) {
        let hadStateNaN = false;
        const st = r.physics.state;
        if (!Number.isFinite(st[4]) || !Number.isFinite(st[5]) || !Number.isFinite(st[6])) {
          hadStateNaN = true;
        }
        const nCars = Math.min(r.physics.numCars || 1, 8);
        for (let c = 0; c < nCars; c++) {
          if (
            typeof r.physics.isCarSlotActive === 'function' &&
            !r.physics.isCarSlotActive(c)
          ) {
            continue;
          }
          const cOff = 22 + c * 40;
          if (
            !Number.isFinite(st[cOff]) ||
            !Number.isFinite(st[cOff + 1]) ||
            !Number.isFinite(st[cOff + 2])
          ) {
            hadStateNaN = true;
            break;
          }
        }
        if (hadStateNaN) {
          r.physics.restoreCompactState?.(st, { preserveEngineTick: true });
          r.interpolator.sync(timestamp);
          r.camera?.resetView?.();
        } else {
          r.interpolator.currState.set(st);
          if (
            tickAfterReconcile !== tickBeforeReconcile ||
            (reconciler.metrics.lastCorrectionDelta > 0.05 &&
              !reconciler.enableSmoothing)
          ) {
            r.interpolator.prevState.set(st);
          }
        }
      }
      if (
        reconciler.replayPlaybackMode &&
        Array.isArray(reconciler.drainedReplayPackets) &&
        reconciler.drainedReplayPackets.length > 0
      ) {
        const ctrl = r.replayTimelineController;
        const s = ctrl?.sessionState;
        const isCustomScrubbing = Boolean(
          s &&
            (s.isScrubbing ||
              s.isPaused ||
              Math.abs((s.playbackSpeed ?? 1.0) - 1.0) > 0.01),
        );
        for (let i = 0; i < reconciler.drainedReplayPackets.length; i++) {
          const pkt = reconciler.drainedReplayPackets[i];
          if (!pkt || !pkt.stateSnapshot) continue;
          if (isGoalReplay && ctrl) {
            if (!ctrl.sessionState.isActive) {
              const carEntries = captureRuntimeReplayCarEntries(r, {
                frameBuffer: pkt.stateSnapshot,
                defaultTeam: r.match?.state?.scorer ?? 0,
              });
              ctrl.beginReplaySession({
                scoringTeam: r.match?.state?.scorer ?? 0,
                scorerCarIndex: r.match?.state?.scorerCarIndex ?? 0,
                carEntries,
                isNetworkStreamed: true,
              });
            }
            const recordedReplayTick = Math.floor(
              Number(pkt.stateSnapshot[0]) > 0 ? pkt.stateSnapshot[0] : (pkt.serverTick || 0),
            );
            ctrl.appendStreamedReplayFrame?.(
              pkt.stateSnapshot,
              recordedReplayTick,
              pkt.acknowledgedControls,
            );
          }
          if (r.physics && (!isCustomScrubbing || !isGoalReplay) && !isLocalReplayControllerStepping) {
            applyReplayFrameToEngine(r.physics, pkt.stateSnapshot, r.interpolator);
            if (!r.match.state.paused && !isMatchEnded && net && session) {
              const maxFrames = net.diagnosticDumpMaxFrames || 36000;
              const curFrames = r.physics.getReplayFrameCount?.() ?? 0;
              if (curFrames >= maxFrames) {
                r.physics.setReplayRecordingActive?.(false);
                session.clientReplayOverflowPaused = true;
              } else if (r.physics.getReplayRecordingActive?.() !== false) {
                r.physics.recordReplayFrame?.();
                session.clientReplayOverflowPaused = false;
              }
            }
          }
        }
        reconciler.drainedReplayPackets.length = 0;
      } else if (
        r.physics &&
        net &&
        session &&
        !r.match.state.paused &&
        !isMatchEnded &&
        !isGoalReplay &&
        !reconciler.replayPlaybackMode &&
        tickAfterReconcile !== this._lastRecordedClientReplayTick
      ) {
        const maxFrames = net.diagnosticDumpMaxFrames || 36000;
        const curFrames = r.physics.getReplayFrameCount?.() ?? 0;
        if (curFrames >= maxFrames) {
          r.physics.setReplayRecordingActive?.(false);
          session.clientReplayOverflowPaused = true;
        } else if (r.physics.getReplayRecordingActive?.() !== false) {
          r.physics.recordReplayFrame?.();
          this._lastRecordedClientReplayTick = tickAfterReconcile;
          session.clientReplayOverflowPaused = false;
        }
      }
    }

    const modeReplayCtrl =
      activeMode?.replayController ?? activeMode?.replaySession?.replayController;
    const isGoalReplayPaused = Boolean(
      isGoalReplay && modeReplayCtrl?.sessionState?.isPaused,
    );
    const isStandaloneViewerPaused = Boolean(
      activeMode?.standaloneReplayViewer?.hasLoadedReplay &&
        activeMode.standaloneReplayViewer.getViewerState?.() === 'paused',
    );
    const isRlrcViewerPaused = Boolean(
      activeMode?.rlrcReplaySession?.hasLoadedReplay &&
        activeMode.rlrcReplaySession.getPhase?.() === 'paused-viewer',
    );
    const isRewinderPausedScrub = Boolean(
      activeMode?.rewinderController &&
        activeMode.rewinderController.getRewinderState?.() === 'paused-scrub',
    );
    const isReplayPaused =
      isGoalReplayPaused ||
      isStandaloneViewerPaused ||
      isRlrcViewerPaused ||
      isRewinderPausedScrub;
    const isMatchPhaseEndedOrPodium =
      r.match.state.phase === 'ended' || r.match.state.phase === 'podium';
    context.isMatchActive =
      !isReplayPaused &&
      !isMatchPhaseEndedOrPodium &&
      (r.match.state.mode === 'freeplay' ||
        r.match.state.mode === 'replay-viewer' ||
        r.match.state.mode === 'kickoff-training' ||
        r.match.state.mode === 'dev-test-lab' ||
        r.match.state.mode === 'exp-multi-bots' ||
        r.match.state.mode === 'static-training-pack' ||
        (!r.match.state.paused &&
          (r.match.state.phase === 'playing' ||
            r.match.state.phase === 'kickoff' ||
            r.match.state.phase === 'goal')));

    this.actionSynthesizer.processRuntimeTickEvents(r, isMatchEnded);

    if (r.profiler && !context.isSimulationOnly) r.profiler.mark();
  }
}
