import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.ts';
import { captureRuntimeReplayCarEntries } from '../../../replay/replayDirectorCarRosterPipeline.ts';
import { INCIDENT_EVENT_TYPES } from '../../../physics/RocketSimConstants.ts';
import type { FrameContext, PipelineStage } from '../FramePipeline.ts';
import {
  CarActionEventSynthesizer,
  type CarActionDebounceState,
} from './CarActionEventSynthesizer.ts';

export type { CarActionDebounceState };

/**
 * SimulationStage.ts
 * Advances deterministic 120Hz physics accumulator, network reconciliation,
 * and delegates vehicle action debounce & incident synthesis to CarActionEventSynthesizer.
 */
export class SimulationStage implements PipelineStage {
  public runtime: any;
  public readonly actionSynthesizer = new CarActionEventSynthesizer();
  private _lastRecordedClientReplayTick = -1;
  private _pendingGoalScored = false;

  constructor(runtime: any) {
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
    const { timestamp } = context;
    const activeMode = r.modeManager?.getActiveMode?.();

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
      !r.networkReconciler &&
      !r.authoritativeServer;

    const isLocalReplayControllerStepping = Boolean(
      isLocalDirectorPreview ||
        activeMode?.rewinderController?.isBlockingLivePhysics ||
        activeMode?.standaloneReplayViewer?.isActive,
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
          if (r.playerCarIndex >= 0 && !r.playerControls?.jump) {
            this.actionSynthesizer.notifyLocalJumpReleased(r.playerCarIndex);
          }
          const fleet = r.networkManager?.diagnosticsProbe?.diagnosticsFleetController;
          if (fleet?.enabled && r.physics && !r.networkReconciler) {
            const cTick = Math.floor(r.physics.getHeaderView().tickCount);
            fleet.applyToAuthority(r.physics, cTick);
          }
          if (
            r.match.state.mode === 'freeplay' ||
            r.match.state.mode === 'replay-viewer' ||
            r.match.state.mode === 'kickoff-training' ||
            r.match.state.mode === 'dev-test-lab' ||
            r.match.state.mode === 'exp-multi-bots' ||
            r.match.state.mode === 'static-training-pack'
          ) {
            return r.modeManager.getActiveMode()?.onBeforePhysicsTick?.();
          }
        },
        r.match.state.mode === 'kickoff-training'
          ? () => r.modeManager.getActiveMode()?.onStepPhysicsTick?.()
          : r.match.state.mode === 'freeplay' ||
              r.match.state.mode === 'replay-viewer' ||
              r.match.state.mode === 'dev-test-lab' ||
              r.match.state.mode === 'exp-multi-bots' ||
              r.match.state.mode === 'static-training-pack'
            ? () => {
                r.physics.step(1);
                r.modeManager.getActiveMode()?.onAfterPhysicsTick?.();
                return true;
              }
            : undefined,
      );
    }

    const activeSim = r.physics;
    if (r.networkReconciler) {
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

    if (r.networkReconciler && !isLocalDirectorPreview) {
      const now = performance.now();
      const net = r.networkManager;
      if (r.authoritativeServer) {
        if (
          net?.diagnosticsProbe?.diagnosticsFleetController?.enabled &&
          !r.authoritativeServer.isWorker
        ) {
          const sTick = Math.floor(r.authoritativeServer.sim?.getHeaderView?.()?.tickCount ?? 0);
          net.diagnosticsProbe.diagnosticsFleetController.applyToAuthority(
            r.authoritativeServer,
            sTick,
          );
        }
        r.authoritativeServer.update(now);
      }
      const tickBeforeReconcile = Math.floor(r.physics.getHeaderView().tickCount);
      r.networkReconciler.reconcile(now);
      if (
        r.match.state.paused ||
        isMatchEnded ||
        isGoalReplay ||
        r.networkReconciler.replayPlaybackMode ||
        r.match.state.phase === 'prepare'
      ) {
        r.networkReconciler.flushPendingControlPackets?.(now);
      }
      const tickAfterReconcile = Math.floor(r.physics.getHeaderView().tickCount);
      if (
        r.interpolator &&
        !isGoalReplay &&
        !r.networkReconciler.replayPlaybackMode &&
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
            (r.networkReconciler.metrics.lastCorrectionDelta > 0.05 &&
              !r.networkReconciler.enableSmoothing)
          ) {
            r.interpolator.prevState.set(st);
          }
        }
      }
      if (
        r.networkReconciler.replayPlaybackMode &&
        Array.isArray(r.networkReconciler.drainedReplayPackets) &&
        r.networkReconciler.drainedReplayPackets.length > 0
      ) {
        const ctrl = r.replayTimelineController;
        const s = ctrl?.sessionState;
        const isCustomScrubbing = Boolean(
          s &&
            (s.isScrubbing ||
              s.isPaused ||
              Math.abs((s.playbackSpeed ?? 1.0) - 1.0) > 0.01),
        );
        for (let i = 0; i < r.networkReconciler.drainedReplayPackets.length; i++) {
          const pkt = r.networkReconciler.drainedReplayPackets[i];
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
            if (!r.match.state.paused && !isMatchEnded && net) {
              const maxFrames = net.diagnosticDumpMaxFrames || 36000;
              const curFrames = r.physics.getReplayFrameCount?.() ?? 0;
              if (curFrames >= maxFrames) {
                r.physics.setReplayRecordingActive?.(false);
                net.sessionCoordinator.clientReplayOverflowPaused = true;
              } else if (r.physics.getReplayRecordingActive?.() !== false) {
                r.physics.recordReplayFrame?.();
                net.sessionCoordinator.clientReplayOverflowPaused = false;
              }
            }
          }
        }
        r.networkReconciler.drainedReplayPackets.length = 0;
      } else if (
        r.physics &&
        net &&
        !r.match.state.paused &&
        !isMatchEnded &&
        !isGoalReplay &&
        !r.networkReconciler.replayPlaybackMode &&
        tickAfterReconcile !== this._lastRecordedClientReplayTick
      ) {
        const maxFrames = net.diagnosticDumpMaxFrames || 36000;
        const curFrames = r.physics.getReplayFrameCount?.() ?? 0;
        if (curFrames >= maxFrames) {
          r.physics.setReplayRecordingActive?.(false);
          net.sessionCoordinator.clientReplayOverflowPaused = true;
        } else if (r.physics.getReplayRecordingActive?.() !== false) {
          r.physics.recordReplayFrame?.();
          this._lastRecordedClientReplayTick = tickAfterReconcile;
          net.sessionCoordinator.clientReplayOverflowPaused = false;
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
    const isRewinderPausedScrub = Boolean(
      activeMode?.rewinderController &&
        activeMode.rewinderController.getRewinderState?.() === 'paused-scrub',
    );
    const isReplayPaused =
      isGoalReplayPaused || isStandaloneViewerPaused || isRewinderPausedScrub;
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

    if (r.physics) {
      const ballPosY = Math.abs(r.physics.getBallStateView?.()?.posY || 0);
      if (ballPosY < 5000 && r.match.state.phase !== 'goal') {
        r._clientGoalIncidentLatched = false;
      }

      const activeMode = r.modeManager?.getActiveMode?.();
      const isReplayViewerPassivePlayback = Boolean(
        activeMode?.standaloneReplayViewer?.isActive &&
          !activeMode?.standaloneReplayViewer?.isIntervening
      );

      if (!isReplayViewerPassivePlayback) {
        this.actionSynthesizer.processTickEvents({
          physics: r.physics,
          playerCarIndex: r.playerCarIndex ?? 0,
          playerControls: r.playerControls,
        networkReconciler: r.networkReconciler,
        testCarAudioEnabled: Boolean(r.networkManager?.diagnosticsProbe?.testCarAudioEnabled),
        isMatchEnded,
        matchPhase: r.match.state.phase,
        clientGoalIncidentLatched: Boolean(r._clientGoalIncidentLatched),
        camera: r.camera,
        arena: r.arena,
        onGoalIncidentLatched: () => {
          r._clientGoalIncidentLatched = true;
        },
        onModePhysicsEvent: (event) => {
          if (event?.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT) {
            r.ballTrajectoryPredictor?.notifyCarBallHit?.(event.tick);
          }
          r.modeManager?.getActiveMode()?.onPhysicsEvent?.(event);
        },
        onPlayFlipResetVisual: (carIdx) => {
          const visual = r.getFlipResetVisual?.(carIdx);
          if (visual) {
            visual.play();
          }
        },
        });
      }
    }

    if (r.profiler && !context.isSimulationOnly) r.profiler.mark();
  }
}
