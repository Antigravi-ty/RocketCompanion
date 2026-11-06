import { MATCH_SIGNALS } from '../../network/protocol/GlobalPayloadCodec.ts';
import {
  INCIDENT_EVENT_TYPES,
  FLIP_RESET_SUBTYPES,
  FLIP_RESET_OBJECT_TYPES,
} from '../../physics/RocketSimConstants.ts';
import { isSignalAudioMutedInGoalReplay } from '../../audio/SignalAudioEngine.ts';
import {
  useAppStore,
  hudStore,
  useSpatialAudioStore,
  eventStreamStore,
} from '../runtimeUiPort.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { EntityManager } from '../../entities/EntityManager.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import type { PodiumCelebrationController } from '../modes/PodiumCelebrationController.ts';
import type { SimulationStage } from '../pipeline/stages/SimulationStage.ts';
import type { GameAudioSubsystem } from '../subsystems/GameAudioSubsystem.ts';
import type { OnlineRosterSnapshotPayload } from './OnlineRosterSyncCoordinator.ts';

export interface RuntimeSignalPacket {
  signalId?: number;
  signalType: number;
  frameId?: number;
  param1?: number;
  param2?: number;
}

export interface SignalAudioFacadeLike {
  play(soundId: string, volume?: number, cooldownMs?: number): void;
  resetIncidentDebounceState?(): void;
  handleEvent?(event: Record<string, unknown>, camera: unknown): void;
  setCarBoostAudioVariation?(carIndex: number, variation: string): void;
}

export interface RuntimeSignalLatchState {
  readonly seenSignalIds: Set<number>;
  lastPreparedMatchSeq: number;
  hostMatchReplayNotified: boolean;
  overtimeAudioPlayed: boolean;
  lastKickoffTargetFrame: number;
  readonly latchedKickoffSeconds: Set<number>;
  lastKickoffStartedFrame: number;
  lastAlert60Frame: number;
  lastAlert30Frame: number;
}

export interface RuntimeSignalActiveModePort {
  id?: string;
  onPhysicsEvent?(event: Record<string, unknown>): void;
  skipGoalReplay?(): void;
  setReplayCameraMode?(mode: 'director' | 'pov'): void;
  replaySession?: {
    isReplayActive?: boolean;
    replayCameraMode?: 'director' | 'pov' | string;
    replayPovCarIndex?: number | null;
  } | null;
  directorPreview?: {
    isReplayActive?: boolean;
    goalScorerCarIndex?: number;
  } | null;
  rewinderController?: {
    isBlockingLivePhysics?: boolean;
    isScrubbing?: boolean;
  } | null;
  standaloneReplayViewer?: {
    isActive?: boolean;
  } | null;
  isGoalReplayActive?(): boolean;
  goalReplayPhase?: string;
}

export interface RuntimeSignalHostPort {
  readonly arena: ArenaWorld | null;
  readonly physics: RocketSimPhysicsEngine | null;
  readonly entityManager: EntityManager | null;
  readonly options: { gameAudio?: SignalAudioFacadeLike; [key: string]: unknown } | null;
  readonly flipResetVisuals: Map<number, { stopVisual(): void; play?(): void }>;
  readonly match: RuntimeMatchState | null;
  readonly modeManager: {
    setMode?(modeName: string): void;
    getActiveMode?(): RuntimeSignalActiveModePort | null;
  } | null;
  readonly replayTimelineController: ReplayTimelineController | null;
  readonly podiumController: PodiumCelebrationController | null;
  readonly camera: CameraManager | null;
  readonly interpolator: PhysicsStateInterpolator | null;
  readonly simulationStage: SimulationStage | null;
  readonly audioSubsystem: GameAudioSubsystem | null;
  readonly authoritativeServer: AuthoritativeServerHost | null;
  readonly remotePeerCarMap: Map<string, number>;
  playerCarIndex: number;
  replayPovCarIndex?: number | null;
  selectedColorSlot: number | null;
  clientReplayOverflowPaused: boolean;
  _clientGoalIncidentLatched: boolean;
  _localSkipReplayReady: boolean;
  getLastRosterSnapshot(): OnlineRosterSnapshotPayload | null;
  getParticipantTeams(): Map<number, number>;
  syncHostLobbyOngoingNotification(): void;
  isLobbyDualWorldActive(reconciler?: PredictionReconciler | null): boolean;
  despawnDiagnosticTestFleet(): void;
  setLobbyGhostMode(enabled: boolean, options?: { syncServerLobby?: boolean }): Promise<boolean> | boolean;
  setLatestServerRosterState(state: string): void;
  isNetworkTelemetryNotified(): boolean;
  markNetworkTelemetryNotified(notified: boolean): void;
  resetBotKickoffStep(): void;
  isGoalReplayCameraOverrideActive(): boolean;
  acquireGoalReplayCameraOverride?(source?: string): void;
  releaseGoalReplayCameraOverride(source?: string | null): void;
  getFlipResetVisual?(carIdx: number): { play(): void } | null;
  resetAudio?(): void;
  setCarColor(carIndex: number, hexColor: string, persistPreference?: boolean): void;
}

export interface RosterPlayerEntryLike {
  carIndex?: number;
  entityId?: number;
  name?: string;
  username?: string;
  anthemId?: string;
}

function extractRosterPlayers(
  lastRosterSnapshot: OnlineRosterSnapshotPayload | RosterPlayerEntryLike[] | null | undefined,
): RosterPlayerEntryLike[] {
  if (!lastRosterSnapshot) return [];
  if (Array.isArray(lastRosterSnapshot)) return lastRosterSnapshot;
  return Array.isArray(lastRosterSnapshot.players)
    ? (lastRosterSnapshot.players as RosterPlayerEntryLike[])
    : [];
}

export function resolveParticipantDisplayName(
  lastRosterSnapshot: OnlineRosterSnapshotPayload | RosterPlayerEntryLike[] | null | undefined,
  playerCarIndex: number,
  carIndex: number,
  scoringTeam = 0,
): string {
  const rosterPlayers = extractRosterPlayers(lastRosterSnapshot);
  const found = rosterPlayers.find((p) => p && (p.carIndex === carIndex || p.entityId === carIndex));
  if (found && (found.name || found.username)) return found.name || found.username || 'Player';
  const peers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
  const peer = peers.find((p) => p && p.carIndex === carIndex);
  if (peer && peer.name) return peer.name;
  if (carIndex === playerCarIndex) {
    return useAppStore?.getState?.()?.onlineSession?.playerName || 'Player';
  }
  return scoringTeam === 1 ? 'ORANGE' : 'BLUE';
}

export function resolveParticipantAnthemId(
  lastRosterSnapshot: OnlineRosterSnapshotPayload | RosterPlayerEntryLike[] | null | undefined,
  playerCarIndex: number,
  carIndex: number,
): string | null {
  if (carIndex === playerCarIndex) {
    const localAnthem = useSpatialAudioStore?.getState?.()?.selectedAnthem;
    if (localAnthem) return localAnthem;
  }
  const rosterPlayers = extractRosterPlayers(lastRosterSnapshot);
  const found = rosterPlayers.find((p) => p && (p.carIndex === carIndex || p.entityId === carIndex));
  return found?.anthemId || null;
}

export function isLocalReplayOrRewinderBlockingLivePhysics(
  modeManager: RuntimeSignalHostPort['modeManager'],
): boolean {
  const activeMode = modeManager?.getActiveMode?.();
  return Boolean(
    activeMode?.rewinderController?.isBlockingLivePhysics ||
      activeMode?.standaloneReplayViewer?.isActive,
  );
}

export function focusLocalPlayerCarInArenaAndCamera(
  reconciler: PredictionReconciler | null | undefined,
  host: RuntimeSignalHostPort,
  options: { resetView?: boolean; syncInterpolator?: boolean; alwaysAssign?: boolean } = {},
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
  options: { exitPodium?: boolean; resetCameraIfWasInReplay?: boolean } = {},
): void {
  const wasOverrideActive = Boolean(
    options.resetCameraIfWasInReplay && host.isGoalReplayCameraOverrideActive(),
  );
  host.replayPovCarIndex = null;
  host.releaseGoalReplayCameraOverride();
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
  scorerCarIdx: number,
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
  options: { durationTicks: number; scoringTeam: number; scorerCarIndex: number },
): void {
  host.replayPovCarIndex = null;
  host.acquireGoalReplayCameraOverride?.('goal-replay');
  host.replayTimelineController?.beginReplaySession?.({
    durationTicks: options.durationTicks,
    scoringTeam: options.scoringTeam,
    scorerCarIndex: options.scorerCarIndex,
    isNetworkStreamed: true,
  });
}

export function resetGoalReplayIncidentFlags(
  host: RuntimeSignalHostPort,
  clearIncidentLatch = false,
): void {
  if (clearIncidentLatch) {
    host._clientGoalIncidentLatched = false;
  }
  host._localSkipReplayReady = false;
}

/**
 * RuntimeGoalReplaySignalSubController
 * Stateful SubController owning goal scoring, goal replay choreography transitions,
 * and combat/contact audio-visual incident effects (flip-reset & demolition).
 */
export class RuntimeGoalReplaySignalSubController {
  public readonly host: RuntimeSignalHostPort;
  public readonly latch: RuntimeSignalLatchState;

  constructor(host: RuntimeSignalHostPort, latch: RuntimeSignalLatchState) {
    this.host = host;
    this.latch = latch;
  }

  public reset(): void {
    resetGoalReplayIncidentFlags(this.host, true);
    teardownSignalReplayAndPodiumSession(this.host);
  }

  private resolveScorerPresentation(
    scoringTeam: number,
    scorerCarIdx: number,
  ): { scorerName: string; scorerAnthemId: string | null } {
    const h = this.host;
    const playerCarIdx = h.playerCarIndex ?? 0;
    const lastRosterSnapshot = h.getLastRosterSnapshot();
    return {
      scorerName: resolveParticipantDisplayName(lastRosterSnapshot, playerCarIdx, scorerCarIdx, scoringTeam),
      scorerAnthemId: resolveParticipantAnthemId(lastRosterSnapshot, playerCarIdx, scorerCarIdx),
    };
  }

  private handleScoreUpdated(
    sig: RuntimeSignalPacket,
    audio: SignalAudioFacadeLike | null | undefined,
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
    const { scorerName, scorerAnthemId } = this.resolveScorerPresentation(scoringTeam, scorerCarIdx);
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
    audio: SignalAudioFacadeLike | null | undefined,
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
    const scorerCarIdx =
      rawMeta > 0 ? (rawMeta >>> 1) & 0xff : (matchState?.scorerCarIndex ?? 0);
    const speedKph = (rawMeta >>> 16) & 0xffff;
    const { scorerName, scorerAnthemId } = this.resolveScorerPresentation(scoringTeam, scorerCarIdx);
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
    const isFreeplayMode = matchState?.mode === 'freeplay';
    const nextPhase = isFreeplayMode ? 'playing' : 'kickoff';
    if (matchState && (matchState.phase === 'replay' || (isFreeplayMode && matchState.phase === 'goal'))) {
      matchState.phase = nextPhase;
    }
    if (hudStore.getState().matchPhase === 'replay' || (isFreeplayMode && hudStore.getState().matchPhase === 'goal')) {
      hudStore.getState().setMatchState({
        matchPhase: nextPhase,
        ...(isFreeplayMode
          ? { replayScorerName: null, replayScorerTeam: null, replayBallSpeedKph: null, replayAssistName: null }
          : {}),
      });
    }
    hudStore.getState().setReplayState?.({ replayPaused: false, replayPersistent: false });
  }

  private handleFlipResetGained(
    sig: RuntimeSignalPacket,
    isFirstSeenSignalId: boolean,
    audio: SignalAudioFacadeLike | null | undefined,
  ): void {
    if (!isFirstSeenSignalId) return;
    const h = this.host;
    const physics = h.physics;
    const targetCarIdx =
      typeof sig.param1 === 'number' && sig.param1 >= 0 ? sig.param1 : h.playerCarIndex;
    const resetSubType =
      typeof sig.param2 === 'number' && sig.param2 > 0 ? sig.param2 : FLIP_RESET_SUBTYPES.BALL;
    if (resetSubType !== FLIP_RESET_SUBTYPES.BALL) return;

    const cv = physics?.getCarStateView?.(targetCarIdx);
    const st = h.simulationStage?.getCarActionState?.(targetCarIdx);
    const nowMs = performance.now();
    const signalTick = sig.frameId || 0;
    const tickDelta =
      signalTick > 0 && st && st.lastFlipResetTick > 0
        ? Math.abs(signalTick - st.lastFlipResetTick)
        : Infinity;
    const timeDeltaMs = st ? nowMs - (st.lastFlipResetTimeMs || 0) : Infinity;
    if (tickDelta < 60 || timeDeltaMs < 450) return;

    if (cv && !cv.isOnGround && !cv.hasFlipOrJump) {
      const maxFlips = Math.max(1, physics?.getCarMaxFlipCount?.(targetCarIdx) ?? 1);
      physics?.setCarState?.(targetCarIdx, { hasFlipOrJump: true, flipsRemaining: maxFlips });
    }
    if (st) {
      if (!cv?.isFlipping) st.hasAirJumped = false;
      st.jumpReleasedSinceSingleJump = true;
      st.lastFlipResetTick = signalTick;
      st.lastFlipResetTimeMs = nowMs;
    }
    const flipResetEvt = {
      type: 0x0f,
      subType: FLIP_RESET_SUBTYPES.BALL,
      resetSubType: FLIP_RESET_SUBTYPES.BALL,
      resetObjectCode: FLIP_RESET_OBJECT_TYPES.BALL,
      resetObjectType: 'ball',
      isBallFlipReset: true,
      carIndex: targetCarIdx,
      primaryId: targetCarIdx,
      x: cv?.posX ?? 0,
      y: cv?.posY ?? 0,
      z: cv?.posZ ?? 0,
      speed: Math.hypot(cv?.velX ?? 0, cv?.velY ?? 0, cv?.velZ ?? 0),
      impulse: 0,
      tick: signalTick,
    };
    eventStreamStore.addEvent(flipResetEvt);
    h.modeManager?.getActiveMode?.()?.onPhysicsEvent?.(flipResetEvt);
    h.getFlipResetVisual?.(targetCarIdx)?.play();
    audio?.handleEvent?.(flipResetEvt, h.camera);
  }

  private handleDemolition(
    sig: RuntimeSignalPacket,
    isFirstSeenSignalId: boolean,
    audio: SignalAudioFacadeLike | null | undefined,
  ): void {
    if (!isFirstSeenSignalId) return;
    const h = this.host;
    const carIndex =
      typeof sig.param1 === 'number' && sig.param1 >= 0 ? sig.param1 : h.playerCarIndex;
    const cv = h.physics?.getCarStateView?.(carIndex);
    audio?.handleEvent?.(
      {
        type: INCIDENT_EVENT_TYPES.CAR_CAR_DEMO,
        carIndex,
        primaryId: carIndex,
        x: cv?.posX ?? 0,
        y: cv?.posY ?? 0,
        z: cv?.posZ ?? 0,
      },
      h.camera,
    );
  }

  public handleSignal(
    reconciler: PredictionReconciler,
    sig: RuntimeSignalPacket,
    isFirstSeenSignalId: boolean,
    audio: SignalAudioFacadeLike | null | undefined,
  ): boolean {
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
      case MATCH_SIGNALS.FLIP_RESET_GAINED:
        this.handleFlipResetGained(sig, isFirstSeenSignalId, audio);
        return true;
      case MATCH_SIGNALS.DEMOLITION:
        this.handleDemolition(sig, isFirstSeenSignalId, audio);
        return true;
      default:
        return false;
    }
  }
}
