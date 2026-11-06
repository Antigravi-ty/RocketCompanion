import { BaseGameMode } from './BaseGameMode.ts';
import { hudStore, useAppStore } from '../runtimeUiPort.ts';
import { audioConfig } from '../../ui-core/config/audioConfig';
import { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import { decodeReplayDirectorTelemetryFromState } from '../../replay/ReplayFrameInterpolator.ts';
import { captureRuntimeReplayCarEntries } from '../../replay/replayDirectorCarRosterPipeline.ts';
import { PodiumCelebrationController } from './PodiumCelebrationController.ts';
import {
  beginGoalReplaySession,
  endGoalReplaySession,
  stepGoalReplaySessionFrame,
  type GoalReplayCameraMode,
} from './shared/GoalReplaySessionCoordinator.ts';
import type { FrameContext } from '../pipeline/FramePipeline.ts';

/**
 * BotMatchMode.ts
 * Competitive match mode with authoritative match rules, 256MB WASM Replay Timeline Scrubbing,
 * Goal Replay highlight camera, and Post-Match Podium Showcase celebrations.
 */
export class BotMatchMode extends BaseGameMode {
  public replayController: ReplayTimelineController;
  public podiumController: PodiumCelebrationController;
  public replayCameraMode: GoalReplayCameraMode = 'director';
  public replayPovCarIndex: number | null = null;

  constructor(runtime: any) {
    super('match', runtime);
    this.replayController = new ReplayTimelineController({ engine: runtime?.physics || null });
    this.podiumController = new PodiumCelebrationController(runtime);
    if (runtime) {
      runtime.replayTimelineController = this.replayController;
      runtime.podiumController = this.podiumController;
    }
  }

  private _ensureControllers(): void {
    const r = this.runtime;
    if (!r) return;
    if (r.physics && this.replayController.engine !== r.physics) {
      this.replayController.attach(r.physics);
    }
    if (!r.replayTimelineController) {
      r.replayTimelineController = this.replayController;
    }
    if (!r.podiumController) {
      r.podiumController = this.podiumController;
    }
  }

  public override update(context: FrameContext | any): void {
    const r = this.runtime;
    const { playerCarView, dt } = context;
    this._ensureControllers();

    const phase = r.match?.state?.phase || 'playing';

    const continueOnBlur = audioConfig.get('continueAudioOnLostFocus');
    const isHidden =
      typeof document !== 'undefined' && (!document.hasFocus() || document.hidden);
    const shouldPauseOnHidden = !continueOnBlur && isHidden;
    const blockingOverlays = Array.from(r.openOverlays as Set<string>).filter(
      (n) => n !== 'trajectory',
    );
    const hasBlockingOverlay = blockingOverlays.length > 0;
    const isTrajectoryOnly = r.openOverlays.has('trajectory') && !hasBlockingOverlay;

    const isMenuOpen = useAppStore ? useAppStore.getState().isOpen : false;
    const isOnlineSession = Boolean(useAppStore?.getState?.()?.onlineSession?.roomId);
    const shouldPauseMatch =
      !isOnlineSession &&
      ((r.isCursorBrowsing && !isTrajectoryOnly) ||
        hasBlockingOverlay ||
        shouldPauseOnHidden ||
        r.isBotPaused ||
        isMenuOpen);

    if (!isOnlineSession && shouldPauseMatch !== r.match.state.paused) {
      r.match.state.paused = shouldPauseMatch;
      if (r.authoritativeServer) {
        r.authoritativeServer.pauseMatch(shouldPauseMatch);
      }
    }

    if (phase === 'replay') {
      if (!this.replayController.sessionState.isActive) {
        const scoringTeam = r.match?.state?.scorer ?? 0;
        const scorerCarIndex = r.match?.state?.scorerCarIndex ?? 0;
        const carEntries = captureRuntimeReplayCarEntries(r, {
          defaultTeam: scoringTeam,
        });
        const totalFrames = this.replayController.beginReplaySession({
          scoringTeam,
          scorerCarIndex,
          carEntries,
          isNetworkStreamed: Boolean(r.networkReconciler),
        });
        this.replayCameraMode = 'director';
        this.replayPovCarIndex = null;
        r.replayPovCarIndex = null;
        beginGoalReplaySession(r, this.replayController, {
          cameraMode: 'director',
          source: 'bot-match-goal-replay',
          syncHud: true,
          totalFrames,
          getCameraMode: () => this.replayCameraMode || 'director',
          setCameraMode: (nextMode) => {
            this.replayCameraMode = nextMode;
          },
          getScoringTeam: () => this.replayController.sessionState.scoringTeam ?? 0,
          getScorerCarIndex: () => this.replayController.sessionState.scorerCarIndex ?? 0,
          getPovCarIndex: () => this.replayPovCarIndex,
          setPovCarIndex: (carIdx) => {
            this.replayPovCarIndex = carIdx;
          },
        });
      }
      if (typeof r.replayPovCarIndex === 'number' && r.replayPovCarIndex >= 0) {
        this.replayCameraMode = 'pov';
        this.replayPovCarIndex = r.replayPovCarIndex;
      } else if (
        r.isGoalReplayCameraOverrideActive() &&
        this.replayCameraMode === 'pov' &&
        r.replayPovCarIndex === null
      ) {
        this.replayCameraMode = 'director';
        this.replayPovCarIndex = null;
      }
      const s = this.replayController.sessionState;
      const isCustomScrubbing =
        s.isScrubbing ||
        s.isPaused ||
        Math.abs(s.playbackSpeed - 1.0) > 0.01;
      const networkStreamSnapshot = !isCustomScrubbing
        ? (r.networkReconciler?.lastParsedPacket?.stateSnapshot ?? null)
        : null;
      const embedded = networkStreamSnapshot
        ? decodeReplayDirectorTelemetryFromState(networkStreamSnapshot)
        : null;
      stepGoalReplaySessionFrame({
        runtime: r,
        replayController: this.replayController,
        context,
        dt: dt ?? 1 / 120,
        source: 'bot-match-goal-replay',
        cameraMode: this.replayCameraMode || 'director',
        scoringTeam: s.scoringTeam ?? 0,
        scorerCarIndex: s.scorerCarIndex ?? 0,
        povCarIndex:
          this.replayCameraMode === 'pov' && typeof this.replayPovCarIndex === 'number'
            ? this.replayPovCarIndex
            : null,
        applyToEngine: isCustomScrubbing,
        dispatchEvents: false,
        syncCarAudioControls: false,
        syncBoostToHud: false,
        emitWillEndSignal: false,
        syncHudProgress: true,
        networkStreamSnapshot,
        overrideProgress:
          embedded && typeof embedded.progress === 'number' ? embedded.progress : null,
      });
    } else if (this.replayController.sessionState.isActive || r.isGoalReplayCameraOverrideActive()) {
      endGoalReplaySession(r, this.replayController, {
        source: 'bot-match-goal-replay',
        clearHud: true,
      });
      this.replayCameraMode = 'director';
      this.replayPovCarIndex = null;
      const localCarIdx =
        typeof r?.networkReconciler?.localCarIndex === 'number' &&
        r.networkReconciler.localCarIndex >= 0
          ? r.networkReconciler.localCarIndex
          : typeof r?.reconciler?.localCarIndex === 'number' && r.reconciler.localCarIndex >= 0
            ? r.reconciler.localCarIndex
            : 0;
      r.playerCarIndex = localCarIdx;
      if (r.arena) r.arena.playerCarIndex = localCarIdx;
      r.camera?.setFocusedCarIndex?.(localCarIdx);
      r.camera?.resetView?.();
      r.interpolator?.sync?.();
    }

    if (phase === 'podium') {
      this.podiumController.update(context);
    } else if (this.podiumController.isActive && phase !== 'ended') {
      this.podiumController.exitPodium();
    }

    if (playerCarView) {
      const activeCarIdx = context.activeCar ?? r?.playerCarIndex ?? 0;
      const isUnlimited = r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ?? false;
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, isUnlimited);
    }
  }

  public override onLeave(): void {
    const r = this.runtime;
    endGoalReplaySession(r, this.replayController, { clearHud: false });
    this.replayCameraMode = 'director';
    this.replayPovCarIndex = null;
    if (r) {
      const localCarIdx =
        typeof r.networkReconciler?.localCarIndex === 'number' &&
        r.networkReconciler.localCarIndex >= 0
          ? r.networkReconciler.localCarIndex
          : typeof r.reconciler?.localCarIndex === 'number' && r.reconciler.localCarIndex >= 0
            ? r.reconciler.localCarIndex
            : r.playerCarIndex ?? 0;
      r.playerCarIndex = localCarIdx;
      if (r.arena) r.arena.playerCarIndex = localCarIdx;
      r.camera?.setFocusedCarIndex?.(localCarIdx);
    }
    this.podiumController?.exitPodium?.();
  }

  public override onResetKickoff(seed = -1): void {
    const r = this.runtime;
    endGoalReplaySession(r, this.replayController, { clearHud: false });
    this.podiumController?.exitPodium?.();
    r.ballTrajectoryPredictor?.clear?.();
    r.inputPoller?.latchJumpSuppression?.();
    r.playerControls = { ...r.neutralControls };
    r.playerThrottle = 0;
    r.physics?.resetKickoff?.(seed);
    r.audioSubsystem?.resetAudio?.();
    r.resetBotState?.();

    if (r.authoritativeServer) {
      r.authoritativeServer.sim?.resetKickoff?.(seed);
      r.authoritativeServer.sim?.pollGoal?.();
      r.authoritativeServer.clientInputBuffer?.clear?.();
      r.authoritativeServer.lastReceivedControls?.clear?.();
    }
    if (r.networkReconciler) {
      const sSnap = r.authoritativeServer
        ? r.authoritativeServer.sim.saveCompactState()
        : r.physics.saveCompactState();
      const sTick = r.authoritativeServer
        ? Math.floor(r.authoritativeServer.sim.getHeaderView().tickCount)
        : 0;
      r.networkReconciler.syncTimeline(sSnap, sTick);
    }

    for (const v of r.flipResetVisuals.values()) v.update(0, false);

    r.arena?.resetBallTrail?.();
    r.camera?.resetView?.();
    r.interpolator?.sync?.();
  }
}
