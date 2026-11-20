export interface ActiveModeSimulationPort {
  directorPreview?: { isReplayActive?: boolean } | null;
  lifecycleController?: { podiumDelayTicks?: number } | null;
  rewinderController?: {
    isBlockingLivePhysics?: boolean;
    getRewinderState?(): string;
  } | null;
  standaloneReplayViewer?: {
    isActive?: boolean;
    hasLoadedReplay?: boolean;
    isIntervening?: boolean;
    getViewerState?(): string;
  } | null;
  rlrcReplaySession?: {
    isActive?: boolean;
    hasLoadedReplay?: boolean;
    isIntervening?: boolean;
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

export interface SimulationMatchStateSnapshot {
  mode: string;
  phase: string;
  paused?: boolean;
  scorer?: number | null;
  scorerCarIndex?: number | null;
}

export interface SimulationFrameExecutionFlags {
  readonly isPodiumActive: boolean;
  readonly isMatchEnded: boolean;
  readonly isLocalDirectorPreview: boolean;
  readonly isGoalReplay: boolean;
  readonly isMinimizedOffline: boolean;
  readonly isLocalReplayControllerStepping: boolean;
  readonly isReplayPaused: boolean;
  readonly shouldHoldAccumulator: boolean;
  readonly isMatchActive: boolean;
  readonly shouldSynthesizeTickEvents: boolean;
}

export function evaluateSimulationFrameFlags(params: {
  readonly matchState: SimulationMatchStateSnapshot;
  readonly activeMode: ActiveModeSimulationPort | null;
  readonly isPodiumControllerActive: boolean;
  readonly hasReconciler: boolean;
  readonly hasServer: boolean;
}): SimulationFrameExecutionFlags {
  const { matchState, activeMode, isPodiumControllerActive, hasReconciler, hasServer } = params;
  const { mode, phase, paused } = matchState;

  const isPodiumActive = Boolean(isPodiumControllerActive || phase === 'podium');
  const isExpPodiumDelayActive =
    mode === 'exp-multi-bots' &&
    phase === 'ended' &&
    (activeMode?.lifecycleController?.podiumDelayTicks ?? 0) > 0;
  const isMatchEnded =
    (mode === 'match' || mode === 'exp-multi-bots') &&
    (phase === 'ended' || phase === 'podium') &&
    !isExpPodiumDelayActive;
  const isLocalDirectorPreview = Boolean(activeMode?.directorPreview?.isReplayActive);
  const isGoalReplay =
    isLocalDirectorPreview ||
    ((mode === 'match' ||
      mode === 'exp-multi-bots' ||
      mode === 'freeplay' ||
      mode === 'replay-viewer' ||
      mode === 'static-training-pack') &&
      phase === 'replay');

  const isMinimizedOffline =
    typeof document !== 'undefined' && Boolean(document.hidden) && !hasReconciler && !hasServer;

  const isLocalReplayControllerStepping = Boolean(
    isLocalDirectorPreview ||
    activeMode?.rewinderController?.isBlockingLivePhysics ||
    activeMode?.standaloneReplayViewer?.isActive ||
    activeMode?.rlrcReplaySession?.isActive
  );

  const shouldHoldAccumulator =
    Boolean(paused && !isLocalReplayControllerStepping) ||
    isMatchEnded ||
    isGoalReplay ||
    isMinimizedOffline;

  const modeReplayCtrl =
    activeMode?.replayController ?? activeMode?.replaySession?.replayController;
  const isGoalReplayPaused = Boolean(isGoalReplay && modeReplayCtrl?.sessionState?.isPaused);
  const isStandaloneViewerPaused = Boolean(
    activeMode?.standaloneReplayViewer?.hasLoadedReplay &&
    activeMode.standaloneReplayViewer.getViewerState?.() === 'paused'
  );
  const isRlrcViewerPaused = Boolean(
    activeMode?.rlrcReplaySession?.hasLoadedReplay &&
    activeMode.rlrcReplaySession.getPhase?.() === 'paused-viewer'
  );
  const isRewinderPausedScrub = Boolean(
    activeMode?.rewinderController &&
    activeMode.rewinderController.getRewinderState?.() === 'paused-scrub'
  );
  const isReplayPaused =
    isGoalReplayPaused || isStandaloneViewerPaused || isRlrcViewerPaused || isRewinderPausedScrub;
  const isMatchPhaseEndedOrPodium = phase === 'ended' || phase === 'podium';
  const isMatchActive =
    !isReplayPaused &&
    !isMatchPhaseEndedOrPodium &&
    (mode === 'freeplay' ||
      mode === 'replay-viewer' ||
      mode === 'kickoff-training' ||
      mode === 'dev-test-lab' ||
      mode === 'exp-multi-bots' ||
      mode === 'static-training-pack' ||
      (!paused && (phase === 'playing' || phase === 'kickoff' || phase === 'goal')));

  const isStandaloneViewerPassive = Boolean(
    activeMode?.standaloneReplayViewer?.isActive && !activeMode.standaloneReplayViewer.isIntervening
  );
  const isRlrcSessionPassive = Boolean(
    activeMode?.rlrcReplaySession?.isActive && !activeMode.rlrcReplaySession.isIntervening
  );
  const shouldSynthesizeTickEvents = !isStandaloneViewerPassive && !isRlrcSessionPassive;

  return {
    isPodiumActive,
    isMatchEnded,
    isLocalDirectorPreview,
    isGoalReplay,
    isMinimizedOffline,
    isLocalReplayControllerStepping,
    isReplayPaused,
    shouldHoldAccumulator,
    isMatchActive,
    shouldSynthesizeTickEvents,
  };
}

export type SimulationDriveMode =
  | 'local-freeplay'
  | 'host-authoritative'
  | 'host-goal-replay'
  | 'client-csr-spectate'
  | 'client-goal-replay'
  | 'local-replay-playback';

export interface SimulationDrivePolicy {
  readonly mode: SimulationDriveMode;
  readonly shouldStepLocalPhysics: boolean;
  readonly shouldHoldAccumulator: boolean;
  readonly shouldBroadcastSnapshot: boolean;
  readonly shouldRunLookahead: boolean;
  readonly shouldFeedReplayTimeline: boolean;
}

export interface SimulationDriveClassificationInput {
  readonly flags: SimulationFrameExecutionFlags;
  readonly hasServer: boolean;
  readonly isBroadcastingHost: boolean;
  readonly hasReconciler: boolean;
  readonly isPureCsrClient: boolean;
  readonly isClientInputAuthority: boolean;
  readonly isReconcilerReplayPlayback: boolean;
  readonly remoteHasAuthority: boolean;
  readonly isSpectatePaused: boolean;
}

function resolveSimulationDriveMode(
  input: SimulationDriveClassificationInput
): SimulationDriveMode {
  const {
    flags,
    hasServer,
    hasReconciler,
    isPureCsrClient,
    isClientInputAuthority,
    isReconcilerReplayPlayback,
  } = input;

  if (flags.isLocalReplayControllerStepping && !flags.isLocalDirectorPreview) {
    return 'local-replay-playback';
  }
  if (hasServer) {
    return flags.isGoalReplay ? 'host-goal-replay' : 'host-authoritative';
  }
  if (flags.isLocalDirectorPreview) {
    return 'local-replay-playback';
  }
  if (hasReconciler) {
    if (isClientInputAuthority) {
      return flags.isGoalReplay ? 'client-goal-replay' : 'local-freeplay';
    }
    if (isReconcilerReplayPlayback) {
      return 'local-replay-playback';
    }
    if (flags.isGoalReplay) {
      return 'client-goal-replay';
    }
    if (isPureCsrClient) {
      return 'client-csr-spectate';
    }
    return 'local-freeplay';
  }
  return flags.isGoalReplay ? 'local-replay-playback' : 'local-freeplay';
}

export function classifySimulationDrivePolicy(
  input: SimulationDriveClassificationInput
): SimulationDrivePolicy {
  const mode = resolveSimulationDriveMode(input);
  const { flags, isBroadcastingHost, hasReconciler, isClientInputAuthority, remoteHasAuthority } =
    input;

  switch (mode) {
    case 'host-goal-replay':
      return {
        mode,
        shouldStepLocalPhysics: false,
        shouldHoldAccumulator: true,
        shouldBroadcastSnapshot: isBroadcastingHost && !remoteHasAuthority,
        shouldRunLookahead: false,
        shouldFeedReplayTimeline: false,
      };
    case 'host-authoritative': {
      const hold = flags.shouldHoldAccumulator || remoteHasAuthority;
      return {
        mode,
        shouldStepLocalPhysics: !hold,
        shouldHoldAccumulator: hold,
        shouldBroadcastSnapshot: isBroadcastingHost && !remoteHasAuthority,
        shouldRunLookahead: false,
        shouldFeedReplayTimeline: false,
      };
    }
    case 'client-goal-replay':
      return {
        mode,
        shouldStepLocalPhysics: false,
        shouldHoldAccumulator: true,
        shouldBroadcastSnapshot: false,
        shouldRunLookahead: false,
        shouldFeedReplayTimeline: true,
      };
    case 'client-csr-spectate': {
      const isSpectateHalted =
        input.isSpectatePaused ||
        flags.shouldHoldAccumulator ||
        flags.isReplayPaused ||
        flags.isMatchEnded ||
        flags.isGoalReplay;
      return {
        mode,
        shouldStepLocalPhysics: false,
        shouldHoldAccumulator: true,
        shouldBroadcastSnapshot: false,
        shouldRunLookahead: !isSpectateHalted,
        shouldFeedReplayTimeline: false,
      };
    }
    case 'local-replay-playback':
      return {
        mode,
        shouldStepLocalPhysics: !flags.shouldHoldAccumulator,
        shouldHoldAccumulator: flags.shouldHoldAccumulator,
        shouldBroadcastSnapshot: false,
        shouldRunLookahead: false,
        shouldFeedReplayTimeline: Boolean(hasReconciler && flags.isGoalReplay),
      };
    case 'local-freeplay': {
      const clientAuthorityActive =
        isClientInputAuthority &&
        !input.isSpectatePaused &&
        !flags.isReplayPaused &&
        !flags.isGoalReplay &&
        !flags.isMatchEnded;
      const hold = flags.shouldHoldAccumulator && !clientAuthorityActive;
      return {
        mode,
        shouldStepLocalPhysics: !hold,
        shouldHoldAccumulator: hold,
        shouldBroadcastSnapshot: false,
        shouldRunLookahead: false,
        shouldFeedReplayTimeline: false,
      };
    }
  }
}
