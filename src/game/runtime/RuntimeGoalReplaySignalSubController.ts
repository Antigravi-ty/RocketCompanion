import { MATCH_SIGNALS } from '../../network/protocol/GlobalPayloadCodec.ts';
import { isSignalAudioMutedInGoalReplay } from '../../audio/SignalAudioEngine.ts';
import { hudStore, setNameTagRuntimeState } from '../runtimeUiPort.ts';
import { captureRuntimeReplayCarEntries } from '../../replay/replayDirectorCarRosterPipeline.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import {
  RuntimeParticipantAndCombatSignalSubController,
  resolveParticipantAnthemId,
  resolveParticipantDisplayName,
  type RosterPlayerEntryLike,
  type RuntimeSignalActiveModePort,
  type RuntimeSignalHostPort,
  type RuntimeSignalLatchState,
  type RuntimeSignalPacket,
  type SignalAudioFacadeLike,
} from './RuntimeParticipantAndCombatSignalSubController.ts';

export type {
  RosterPlayerEntryLike,
  RuntimeSignalActiveModePort,
  RuntimeSignalHostPort,
  RuntimeSignalLatchState,
  RuntimeSignalPacket,
  SignalAudioFacadeLike,
};

export function isLocalReplayOrRewinderBlockingLivePhysics(
  modeManager: RuntimeSignalHostPort['modeManager']
): boolean {
  const activeMode = modeManager?.getActiveMode?.();
  return Boolean(
    activeMode?.rewinderController?.isBlockingLivePhysics ||
    activeMode?.standaloneReplayViewer?.isActive
  );
}

export function focusLocalPlayerCarInArenaAndCamera(
  reconciler: PredictionReconciler | null | undefined,
  host: RuntimeSignalHostPort,
  options: { resetView?: boolean; syncInterpolator?: boolean; alwaysAssign?: boolean } = {}
): number {
  const hasLocalCar =
    typeof reconciler?.localCarIndex === 'number' && reconciler.localCarIndex >= 0;
  if (hasLocalCar || options.alwaysAssign) {
    const resolvedIndex = hasLocalCar
      ? reconciler!.localCarIndex
      : typeof host.playerCarIndex === 'number' && host.playerCarIndex >= 0
        ? host.playerCarIndex
        : 0;
    host.playerCarIndex = resolvedIndex;
    if (host.arena) {
      host.arena.playerCarIndex = resolvedIndex;
    }
    host.camera?.setFocusedCarIndex?.(resolvedIndex);
  }
  if (options.resetView) {
    host.camera?.resetView?.();
  }
  if (options.syncInterpolator) {
    host.interpolator?.sync?.();
  }
  return host.playerCarIndex;
}

export function teardownSignalReplayAndPodiumSession(
  host: RuntimeSignalHostPort,
  options: { exitPodium?: boolean; resetCameraIfWasInReplay?: boolean } = {}
): void {
  const wasOverrideActive = Boolean(
    options.resetCameraIfWasInReplay && host.isGoalReplayCameraOverrideActive()
  );
  host.replayPovCarIndex = null;
  host.releaseGoalReplayCameraOverride();
  const serverReplayCtrl = host.authoritativeServer?.fallbackManager?.goalReplay?.replayController;
  if (
    host.replayTimelineController &&
    serverReplayCtrl &&
    serverReplayCtrl !== host.replayTimelineController &&
    serverReplayCtrl.ActiveWindowCount > 0
  ) {
    const existingEntries = host.replayTimelineController.sessionState?.carEntries;
    host.replayTimelineController.copyRetainedReplayFrom(serverReplayCtrl);
    if (
      (!Array.isArray(host.replayTimelineController.sessionState.carEntries) ||
        host.replayTimelineController.sessionState.carEntries.length === 0) &&
      Array.isArray(existingEntries) &&
      existingEntries.length > 0
    ) {
      host.replayTimelineController.sessionState.carEntries = existingEntries;
    }
  }
  host.replayTimelineController?.endReplaySession?.();
  if (options.exitPodium) {
    host.podiumController?.exitPodium?.();
  }
  if (wasOverrideActive) {
    host.camera?.resetView?.();
  }
}

export function toggleGoalReplayCameraViewMode(
  host: RuntimeSignalHostPort,
  scorerCarIdx: number
): void {
  const curMode = hudStore.getState().replayCameraMode === 'pov' ? 'pov' : 'director';
  const nextMode = curMode === 'director' ? 'pov' : 'director';
  const activeMode = host.modeManager?.getActiveMode?.();
  if (typeof activeMode?.setReplayCameraMode === 'function') {
    activeMode.setReplayCameraMode(nextMode);
  } else if (activeMode?.replaySession) {
    activeMode.replaySession.replayCameraMode = nextMode;
  } else if (nextMode === 'pov') {
    host.replayPovCarIndex = scorerCarIdx;
    host.releaseGoalReplayCameraOverride();
    hudStore.getState().setReplayState?.({ replayCameraMode: 'pov' });
  } else {
    host.replayPovCarIndex = null;
    host.acquireGoalReplayCameraOverride?.('goal-replay');
    hudStore.getState().setReplayState?.({ replayCameraMode: 'director' });
  }
}

export function startGoalReplayDirectorSession(
  host: RuntimeSignalHostPort,
  options: { durationTicks: number; scoringTeam: number; scorerCarIndex: number }
): void {
  host.replayPovCarIndex = null;
  host.acquireGoalReplayCameraOverride?.('goal-replay');
  const carEntries = captureRuntimeReplayCarEntries(host, {
    defaultTeam: options.scoringTeam,
  });
  setNameTagRuntimeState({ carEntries });
  host.replayTimelineController?.beginReplaySession?.({
    durationTicks: options.durationTicks,
    scoringTeam: options.scoringTeam,
    scorerCarIndex: options.scorerCarIndex,
    carEntries,
    isNetworkStreamed: true,
  });
}

export function resetGoalReplayIncidentFlags(
  host: RuntimeSignalHostPort,
  clearIncidentLatch = false
): void {
  if (clearIncidentLatch) {
    host._clientGoalIncidentLatched = false;
  }
  host._localSkipReplayReady = false;
}

/**
 * RuntimeGoalReplaySignalSubController
 * Stateful SubController owning goal scoring, goal replay choreography transitions,
 * and delegating combat/contact incident signals to RuntimeParticipantAndCombatSignalSubController.
 */
export class RuntimeGoalReplaySignalSubController {
  public readonly host: RuntimeSignalHostPort;
  public readonly latch: RuntimeSignalLatchState;
  public readonly participantAndCombat: RuntimeParticipantAndCombatSignalSubController;

  constructor(
    host: RuntimeSignalHostPort,
    latch: RuntimeSignalLatchState,
    participantAndCombat = new RuntimeParticipantAndCombatSignalSubController(host)
  ) {
    this.host = host;
    this.latch = latch;
    this.participantAndCombat = participantAndCombat;
  }

  public reset(): void {
    resetGoalReplayIncidentFlags(this.host, true);
    teardownSignalReplayAndPodiumSession(this.host);
  }

  private resolveScorerPresentation(
    scoringTeam: number,
    scorerCarIdx: number
  ): { scorerName: string; scorerAnthemId: string | null } {
    const h = this.host;
    const playerCarIdx = h.playerCarIndex ?? 0;
    const lastRosterSnapshot = h.getLastRosterSnapshot();
    return {
      scorerName: resolveParticipantDisplayName(
        lastRosterSnapshot,
        playerCarIdx,
        scorerCarIdx,
        scoringTeam
      ),
      scorerAnthemId: resolveParticipantAnthemId(lastRosterSnapshot, playerCarIdx, scorerCarIdx),
    };
  }

  private handleScoreUpdated(
    sig: RuntimeSignalPacket,
    audio: SignalAudioFacadeLike | null | undefined
  ): void {
    const h = this.host;
    const matchState = h.match?.state;
    const bScore = sig.param1 ?? 0;
    const oScore = sig.param2 ?? 0;
    const isInitialZeroScore = bScore === 0 && oScore === 0;
    const isScoreChange =
      !isInitialZeroScore &&
      (matchState?.blueScore !== bScore || matchState?.orangeScore !== oScore);

    if (!isInitialZeroScore) {
      this.latch.lastKickoffTargetFrame = -1;
      this.latch.latchedKickoffSeconds.clear();
    }
    if (matchState) {
      if (!isInitialZeroScore && matchState.phase !== 'replay') matchState.phase = 'goal';
      matchState.blueScore = bScore;
      matchState.orangeScore = oScore;
    }
    hudStore.getState().setMatchState({
      ...(isInitialZeroScore || matchState?.phase === 'replay' ? {} : { matchPhase: 'goal' }),
      blueScore: bScore,
      orangeScore: oScore,
    });
    if (isScoreChange && !isSignalAudioMutedInGoalReplay(h)) {
      audio?.play('sfx_goal_poof', 1.0);
    }
  }

  private handleGoalReplayWillStart(sig: RuntimeSignalPacket): void {
    const h = this.host;
    const matchState = h.match?.state;
    resetGoalReplayIncidentFlags(h);
    this.latch.lastKickoffTargetFrame = -1;
    this.latch.latchedKickoffSeconds.clear();
    const rawParam1 = sig.param1 ?? 0;
    const scoringTeam = rawParam1 & 0x1;
    const scorerCarIdx = (rawParam1 >>> 8) & 0xff;
    const speedKph = (rawParam1 >>> 16) & 0xffff;
    const { scorerName, scorerAnthemId } = this.resolveScorerPresentation(
      scoringTeam,
      scorerCarIdx
    );
    if (matchState) {
      if (matchState.phase !== 'replay') matchState.phase = 'goal';
      matchState.scorer = scoringTeam;
      matchState.scorerCarIndex = scorerCarIdx;
    }
    hudStore.getState().setMatchState({
      ...(matchState?.phase === 'replay' ? {} : { matchPhase: 'goal' }),
      replayScorerName: scorerName,
      replayScorerTeam: scoringTeam,
      replayScorerAnthemId: scorerAnthemId,
      replayBallSpeedKph: speedKph > 0 ? speedKph : 100,
    });
  }

  private handleGoalReplayStart(
    reconciler: PredictionReconciler,
    sig: RuntimeSignalPacket,
    audio: SignalAudioFacadeLike | null | undefined
  ): void {
    const h = this.host;
    const matchState = h.match?.state;
    const physics = h.physics;
    resetGoalReplayIncidentFlags(h);
    this.latch.lastKickoffTargetFrame = -1;
    this.latch.latchedKickoffSeconds.clear();
    audio?.resetIncidentDebounceState?.();
    reconciler.setReplayPlaybackMode?.(true);
    if (!h.clientReplayOverflowPaused) physics?.setReplayRecordingActive?.(true);
    physics?.resetGoalLatch?.();
    const replayTicks = (sig.param1 ?? 0) > 0 ? sig.param1! : 360;
    const rawMeta = sig.param2 ?? 0;
    const scoringTeam = rawMeta > 0 ? rawMeta & 0x1 : (matchState?.scorer ?? 0);
    const scorerCarIdx = rawMeta > 0 ? (rawMeta >>> 1) & 0xff : (matchState?.scorerCarIndex ?? 0);
    const speedKph = (rawMeta >>> 16) & 0xffff;
    const { scorerName, scorerAnthemId } = this.resolveScorerPresentation(
      scoringTeam,
      scorerCarIdx
    );
    if (matchState) {
      matchState.phase = 'replay';
      matchState.scorer = scoringTeam;
      matchState.scorerCarIndex = scorerCarIdx;
    }
    startGoalReplayDirectorSession(h, {
      durationTicks: replayTicks,
      scoringTeam,
      scorerCarIndex: scorerCarIdx,
    });
    hudStore.getState().setMatchState({
      matchPhase: 'replay',
      choreographySignal: 'goal-replay-started',
      replayScorerName: scorerName,
      replayScorerTeam: scoringTeam,
      replayScorerAnthemId: scorerAnthemId,
      ...(speedKph > 0 ? { replayBallSpeedKph: speedKph } : {}),
    });
    hudStore.getState().setReplayState?.({
      replayCameraMode: 'director',
      replayScorerName: scorerName,
      replayScorerTeam: scoringTeam,
      ...(speedKph > 0 ? { replayBallSpeedKph: speedKph } : {}),
      onReplaySkip: () => {
        const activeMode = h.modeManager?.getActiveMode?.();
        if (typeof activeMode?.skipGoalReplay === 'function') {
          activeMode.skipGoalReplay();
        }
      },
      onReplayToggleCamera: () => {
        toggleGoalReplayCameraViewMode(h, scorerCarIdx);
      },
    });
  }

  private handleGoalReplayEndOrRoundStart(reconciler: PredictionReconciler): void {
    const h = this.host;
    const matchState = h.match?.state;
    const physics = h.physics;
    resetGoalReplayIncidentFlags(h);
    reconciler.setReplayPlaybackMode?.(false);
    if (!h.clientReplayOverflowPaused) physics?.setReplayRecordingActive?.(true);
    physics?.resetGoalLatch?.();
    physics?.setSimulationFrozen?.(false);
    teardownSignalReplayAndPodiumSession(h);
    const activeMode = h.modeManager?.getActiveMode?.();
    if (activeMode?.directorPreview?.isReplayActive) {
      activeMode.directorPreview.isReplayActive = false;
    }
    focusLocalPlayerCarInArenaAndCamera(reconciler, h, { resetView: true, syncInterpolator: true });
    h.latchJumpSuppression?.();
    const isFreeplayMode = matchState?.mode === 'freeplay';
    const nextPhase = isFreeplayMode ? 'playing' : 'kickoff';
    if (
      matchState &&
      (matchState.phase === 'replay' || (isFreeplayMode && matchState.phase === 'goal'))
    ) {
      matchState.phase = nextPhase;
    }
    if (
      hudStore.getState().matchPhase === 'replay' ||
      (isFreeplayMode && hudStore.getState().matchPhase === 'goal')
    ) {
      hudStore.getState().setMatchState({
        matchPhase: nextPhase,
        ...(isFreeplayMode
          ? {
              replayScorerName: null,
              replayScorerTeam: null,
              replayBallSpeedKph: null,
              replayAssistName: null,
            }
          : {}),
      });
    }
    hudStore.getState().setReplayState?.({ replayPaused: false, replayPersistent: false });
  }

  public handleSignal(
    reconciler: PredictionReconciler,
    sig: RuntimeSignalPacket,
    isFirstSeenSignalId: boolean,
    audio: SignalAudioFacadeLike | null | undefined
  ): boolean {
    if (this.participantAndCombat.handleCombatIncidentSignal(sig, isFirstSeenSignalId, audio)) {
      return true;
    }
    switch (sig.signalType) {
      case MATCH_SIGNALS.SCORE_UPDATED:
        this.handleScoreUpdated(sig, audio);
        return true;
      case MATCH_SIGNALS.GOAL_REPLAY_WILL_START:
        this.handleGoalReplayWillStart(sig);
        return true;
      case MATCH_SIGNALS.GOAL_REPLAY_START:
        this.handleGoalReplayStart(reconciler, sig, audio);
        return true;
      case MATCH_SIGNALS.GOAL_REPLAY_WILL_END:
        this.host.physics?.resetGoalLatch?.();
        hudStore.getState().setChoreographySignal?.('goal-replay-will-end');
        return true;
      case MATCH_SIGNALS.GOAL_REPLAY_END:
      case MATCH_SIGNALS.ROUND_STARTED:
      case MATCH_SIGNALS.BALL_RESET:
        this.handleGoalReplayEndOrRoundStart(reconciler);
        return true;
      default:
        return false;
    }
  }
}
