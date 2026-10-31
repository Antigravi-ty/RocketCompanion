import { BaseGameMode } from './BaseGameMode.js';
import { hudStore } from '../../ui-core/stores/hudStore';
import { useAppStore } from '../../ui-core/stores/appStore';
import { audioConfig } from '../../ui-core/config/audioConfig.js';
import { ReplayTimelineController } from '../../replay/ReplayTimelineCore.js';
import {
  applyReplayFrameToEngine,
  decodeReplayDirectorTelemetryFromState,
} from '../../replay/ReplayFrameInterpolator.js';
import { applyDirectorReplayCamera } from '../../replay/ReplayDirectorCamera.js';
import { PodiumCelebrationController } from './PodiumCelebrationController.js';

/**
 * BotMatchMode.js
 * Competitive match mode with authoritative match rules, 256MB WASM Replay Timeline Scrubbing,
 * Goal Replay highlight camera, and Post-Match Podium Showcase celebrations.
 */
export class BotMatchMode extends BaseGameMode {
  constructor(runtime) {
    super('match', runtime);
    this.replayController = new ReplayTimelineController({ engine: runtime?.physics || null });
    this.podiumController = new PodiumCelebrationController(runtime);
    this.replayCameraMode = 'director';
    this.replayPovCarIndex = null;
    if (runtime) {
      runtime.replayTimelineController = this.replayController;
      runtime.podiumController = this.podiumController;
    }
  }

  _ensureControllers() {
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

  update(context) {
    const r = this.runtime;
    const { playerCarView, dt } = context;
    this._ensureControllers();

    const phase = r.match?.state?.phase || 'playing';

    // 1. Evaluate pause state
    const continueOnBlur = audioConfig.get('continueAudioOnLostFocus');
    const isHidden = typeof document !== 'undefined' && (!document.hasFocus() || document.hidden);
    const shouldPauseOnHidden = !continueOnBlur && isHidden;
    const blockingOverlays = Array.from(r.openOverlays).filter(n => n !== 'trajectory');
    const hasBlockingOverlay = blockingOverlays.length > 0;
    const isTrajectoryOnly = r.openOverlays.has('trajectory') && !hasBlockingOverlay;

    const isMenuOpen = useAppStore ? useAppStore.getState().isOpen : false;
    const isOnlineSession = Boolean(useAppStore?.getState?.()?.onlineSession?.roomId);
    const shouldPauseMatch = !isOnlineSession &&
      ((r.isCursorBrowsing && !isTrajectoryOnly) || hasBlockingOverlay || shouldPauseOnHidden || r.isBotPaused || isMenuOpen);

    if (!isOnlineSession && shouldPauseMatch !== r.match.state.paused) {
      r.match.state.paused = shouldPauseMatch;
      if (r.authoritativeServer) {
        r.authoritativeServer.pauseMatch(shouldPauseMatch);
      }
    }

    // 2. Handle Goal Replay timeline progression & scrubbing or Post-Match Podium physics
    if (phase === 'replay') {
      if (!this.replayController.isActive) {
        this.replayController.beginReplaySession({
          scoringTeam: r.match?.state?.scorer ?? 0,
          isNetworkStreamed: Boolean(r.networkReconciler)
        });
        this.replayCameraMode = 'director';
        this.replayPovCarIndex = null;
        r.replayPovCarIndex = null;
        hudStore.getState().setReplayState?.({
          replayCameraMode: 'director',
          onReplaySelectPovCar: (carIdx) => {
            if (typeof carIdx === 'number' && carIdx >= 0) {
              this.replayCameraMode = 'pov';
              this.replayPovCarIndex = carIdx;
              r.replayPovCarIndex = carIdx;
              r.goalReplayCameraOverrideActive = false;
              r.playerCarIndex = carIdx;
              if (r.arena) r.arena.playerCarIndex = carIdx;
              r.camera?.setFocusedCarIndex?.(carIdx);
              r.camera?.resetView?.();
              hudStore.getState().setReplayState?.({ replayCameraMode: 'pov' });
            } else {
              this.replayCameraMode = 'director';
              this.replayPovCarIndex = null;
              r.replayPovCarIndex = null;
              r.goalReplayCameraOverrideActive = true;
              if (this.replayController?.directorCameraState) {
                this.replayController.directorCameraState.initialized = false;
              }
              hudStore.getState().setReplayState?.({ replayCameraMode: 'director' });
            }
          },
          onReplayToggleCameraMode: () => {
            if (this.replayCameraMode === 'director') {
              const targetIdx =
                typeof this.replayPovCarIndex === 'number'
                  ? this.replayPovCarIndex
                  : (this.replayController.scorerCarIndex ?? 0);
              this.replayCameraMode = 'pov';
              this.replayPovCarIndex = targetIdx;
              r.replayPovCarIndex = targetIdx;
              r.goalReplayCameraOverrideActive = false;
              r.playerCarIndex = targetIdx;
              if (r.arena) r.arena.playerCarIndex = targetIdx;
              r.camera?.setFocusedCarIndex?.(targetIdx);
              r.camera?.resetView?.();
            } else {
              this.replayCameraMode = 'director';
              r.replayPovCarIndex = null;
              r.goalReplayCameraOverrideActive = true;
              if (this.replayController?.directorCameraState) {
                this.replayController.directorCameraState.initialized = false;
              }
            }
            hudStore.getState().setReplayState?.({ replayCameraMode: this.replayCameraMode });
          },
        });
      }
      if (typeof r.replayPovCarIndex === 'number' && r.replayPovCarIndex >= 0) {
        this.replayCameraMode = 'pov';
        this.replayPovCarIndex = r.replayPovCarIndex;
      } else if (r.goalReplayCameraOverrideActive && this.replayCameraMode === 'pov' && r.replayPovCarIndex === null) {
        this.replayCameraMode = 'director';
        this.replayPovCarIndex = null;
      }
      const isCustomScrubbing =
        this.replayController.isScrubbing ||
        this.replayController.isPaused ||
        Math.abs(this.replayController.playbackSpeed - 1.0) > 0.01;
      const stepRes = this.replayController.stepPlayback(
        dt ?? (1 / 120),
        r.interpolator,
        isCustomScrubbing
      );
      let effectiveProgress = stepRes.progress;
      if (!isCustomScrubbing && r.networkReconciler?.lastParsedPacket?.stateSnapshot) {
        const netSnap = r.networkReconciler.lastParsedPacket.stateSnapshot;
        applyReplayFrameToEngine(
          r.physics,
          netSnap,
          r.interpolator
        );
        const embedded = decodeReplayDirectorTelemetryFromState(netSnap);
        if (embedded && typeof embedded.progress === 'number') {
          effectiveProgress = embedded.progress;
        }
      }
      if (this.replayCameraMode === 'pov' && typeof this.replayPovCarIndex === 'number') {
        r.goalReplayCameraOverrideActive = false;
        const povIdx = this.replayPovCarIndex;
        r.replayPovCarIndex = povIdx;
        r.playerCarIndex = povIdx;
        if (r.arena) r.arena.playerCarIndex = povIdx;
        const activeReplayCarView = r.interpolator?.getCurrCarStateView?.(povIdx);
        context.activeCar = povIdx;
        context.activeCarMesh = r.arena?.cars?.[povIdx];
        if (activeReplayCarView) {
          context.playerCarView = activeReplayCarView;
          context.isSupersonic = Boolean(activeReplayCarView.isSupersonic && !activeReplayCarView.isDemoed);
          context.curBoost = activeReplayCarView.boost ?? 0;
        }
      } else {
        r.goalReplayCameraOverrideActive = true;
        applyDirectorReplayCamera(
          r.camera,
          r.interpolator,
          effectiveProgress,
          this.replayController.scoringTeam,
          dt ?? 0.016,
          this.replayController.scorerCarIndex ?? 0,
          this.replayController.directorCameraState
        );
      }
      hudStore.getState().setReplayState?.({
        replayProgress: effectiveProgress,
        replayFrameIndex: stepRes.frameIndex,
        replayTotalFrames: stepRes.totalFrames,
        replayPaused: this.replayController.isPaused,
        replayPersistent: this.replayController.isPersistent,
        replayCameraMode: this.replayCameraMode,
        replaySpeed: this.replayController.playbackSpeed
      });
    } else if (this.replayController.isActive || r.goalReplayCameraOverrideActive) {
      this.replayController.endReplaySession();
      this.replayCameraMode = 'director';
      this.replayPovCarIndex = null;
      r.goalReplayCameraOverrideActive = false;
      const localCarIdx =
        typeof r?.reconciler?.localCarIndex === 'number' && r.reconciler.localCarIndex >= 0
          ? r.reconciler.localCarIndex
          : 0;
      r.playerCarIndex = localCarIdx;
      if (r.arena) r.arena.playerCarIndex = localCarIdx;
      r.camera?.resetView?.();
      r.interpolator?.sync?.();
      hudStore.getState().setReplayState?.({
        replayPaused: false,
        replayPersistent: false,
        replayCameraMode: 'director',
        onReplaySelectPovCar: null
      });
    }

    if (phase === 'podium') {
      this.podiumController.update(context);
      this.podiumController.updateCamera(r.camera, dt ?? 0.016);
    } else if (this.podiumController.isActive && phase !== 'ended') {
      this.podiumController.exitPodium();
    }

    // 3. Sync match state to HUD (score, time, countdown, phase)
    if (!r.networkReconciler) {
      hudStore.getState().setMatchState({
        blueScore: r.match.state.blueScore,
        orangeScore: r.match.state.orangeScore,
        remainingSeconds: Math.ceil(r.match.state.remainingSeconds),
        isOvertime: Boolean(r.match.state.overtime),
        overtimeSeconds: Math.floor(r.match.state.overtimeSeconds || 0),
        kickoffCountdown: r.match.state.phase === 'kickoff' ? Math.ceil(r.match.state.countdown) : 0,
        matchPhase: r.match.state.phase
      });
    }

    if (playerCarView) {
      const activeCarIdx = context.activeCar ?? r?.playerCarIndex ?? 0;
      const isUnlimited = r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ?? false;
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, isUnlimited);
    }
  }

  onLeave() {
    if (this.runtime) {
      this.runtime.goalReplayCameraOverrideActive = false;
    }
    this.replayController?.endReplaySession?.();
    this.podiumController?.exitPodium?.();
  }

  onResetKickoff(seed = -1) {
    const r = this.runtime;
    if (r) {
      r.goalReplayCameraOverrideActive = false;
    }
    this.replayController?.endReplaySession?.();
    this.podiumController?.exitPodium?.();
    r.ballTrajectoryPredictor?.clear?.();
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
      const sSnap = r.authoritativeServer ? r.authoritativeServer.sim.saveCompactState() : r.physics.saveCompactState();
      const sTick = r.authoritativeServer ? Math.floor(r.authoritativeServer.sim.getHeaderView().tickCount) : 0;
      r.networkReconciler.syncTimeline(sSnap, sTick);
    }

    for (const v of r.flipResetVisuals.values()) v.update(0, false);

    r.arena?.resetBallTrail?.();
    r.camera?.resetView?.();
    r.interpolator?.sync?.();
  }
}
