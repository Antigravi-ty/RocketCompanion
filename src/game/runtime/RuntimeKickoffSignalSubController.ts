import {
  MATCH_SIGNALS,
  CLIENT_COMMAND_TYPES,
} from '../../network/protocol/GlobalPayloadCodec.ts';
import { isSignalAudioMutedInGoalReplay } from '../../audio/SignalAudioEngine.ts';
import { useAppStore, hudStore } from '../runtimeUiPort.ts';
import { dismissHostLobbyOngoingNotification } from './OnlineRosterSyncCoordinator.ts';
import { clearRetainedMatchReplayOnMatchStart } from '../../replay/ReplayFileExporter.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import {
  focusLocalPlayerCarInArenaAndCamera,
  resetGoalReplayIncidentFlags,
  teardownSignalReplayAndPodiumSession,
  type RuntimeSignalHostPort,
  type RuntimeSignalLatchState,
  type RuntimeSignalPacket,
  type SignalAudioFacadeLike,
} from './RuntimeGoalReplaySignalSubController.ts';

export interface KickoffSignalStepContext {
  packetServerTick: number | null;
  currentTick: number;
  isFirstSeenSignalId: boolean;
  hasKickoffStartInBatch: boolean;
  audio: SignalAudioFacadeLike | null | undefined;
}

function exitLobbyDualWorldAndActivateMatchMode(host: RuntimeSignalHostPort): void {
  const arena = host.arena;
  if (arena) {
    arena.isLobbyMode = false;
    arena.isHostLobby = false;
  }
  host.setLobbyGhostMode(false, { syncServerLobby: false });
  host.setLatestServerRosterState('match');
  host.interpolator?.sync?.();
  host.modeManager?.setMode?.('match');
  useAppStore.getState().setMatchMode('match');
}

function preparePhysicsReplayRecordingForMatch(
  host: RuntimeSignalHostPort,
  options: { clearBuffer?: boolean; resetBallTrail?: boolean } = {},
): void {
  const physics = host.physics;
  if (options.clearBuffer) {
    physics?.clearReplayBuffer?.();
    host.clientReplayOverflowPaused = false;
  }
  if (!host.clientReplayOverflowPaused) {
    physics?.setReplayRecordingActive?.(true);
  }
  physics?.resetGoalLatch?.();
  physics?.setSimulationFrozen?.(false);
  physics?.setUnlimitedBoost?.(false);
  if (options.resetBallTrail) {
    host.arena?.resetBallTrail?.();
  }
}

function pushMatchPrepareSignalToPhysicsBuffer(
  host: RuntimeSignalHostPort,
  sig: RuntimeSignalPacket,
  currentTick: number,
): void {
  const physics = host.physics;
  if (physics && typeof physics.pushSignalEvent === 'function') {
    const p1 = Number(sig.param1 || 0) >>> 0;
    const p2 = Number(sig.param2 || 0) >>> 0;
    physics.pushSignalEvent(
      sig.signalType || 0,
      (sig.frameId ?? currentTick) >>> 0,
      Number(sig.param1 || 0),
      Number(sig.param2 || 0),
      0,
      0,
      0,
      0,
      p1 & 0xffff,
      (p1 >>> 16) & 0xffff,
      p2,
      (sig.signalId || 0) >>> 0,
      0,
      0,
    );
  }
}

function isKickoffTransitioningFromReplay(host: RuntimeSignalHostPort): boolean {
  return Boolean(
    host.isGoalReplayCameraOverrideActive() ||
      host.replayTimelineController?.sessionState?.isActive ||
      host.match?.state?.phase === 'replay',
  );
}

function resetCameraViewIfInvalidOrWasInReplay(
  host: RuntimeSignalHostPort,
  wasInReplay: boolean,
): void {
  const camPos = host.camera?.camera?.position;
  if (
    wasInReplay ||
    (camPos &&
      (!Number.isFinite(camPos.x) || !Number.isFinite(camPos.y) || !Number.isFinite(camPos.z)))
  ) {
    host.camera?.resetView?.();
  }
}

/**
 * RuntimeKickoffSignalSubController
 * Stateful SubController owning MATCH_INITIALIZED, MATCH_PREPARE, MATCH_STARTED,
 * KICKOFF_WILL_START, and KICKOFF_START signal transitions and participant slot sync.
 */
export class RuntimeKickoffSignalSubController {
  public readonly host: RuntimeSignalHostPort;
  public readonly latch: RuntimeSignalLatchState;

  constructor(host: RuntimeSignalHostPort, latch: RuntimeSignalLatchState) {
    this.host = host;
    this.latch = latch;
  }

  public ensureMatchParticipantsInLocalWorld(reconciler: PredictionReconciler | null): void {
    const h = this.host;
    const physics = h?.physics;
    const arena = h?.arena;
    if (!h || !physics) return;
    const presets = reconciler?.carVisualPresets;
    const peers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
    const activeParticipantMap = new Map<number, number>();
    const localIdx = focusLocalPlayerCarInArenaAndCamera(reconciler, h, { alwaysAssign: true });
    activeParticipantMap.set(localIdx, localIdx % 2);

    if (presets instanceof Map) {
      for (const cIdx of presets.keys()) {
        if (
          typeof cIdx === 'number' &&
          cIdx >= 0 &&
          cIdx < 6 &&
          !activeParticipantMap.has(cIdx)
        ) {
          activeParticipantMap.set(cIdx, cIdx % 2);
        }
      }
    }
    for (const peer of peers) {
      if (typeof peer?.carIndex === 'number' && peer.carIndex >= 0 && peer.carIndex < 6) {
        activeParticipantMap.set(
          peer.carIndex,
          typeof peer.team === 'number' ? peer.team : peer.carIndex % 2,
        );
      }
    }
    if (h.remotePeerCarMap instanceof Map) {
      for (const cIdx of h.remotePeerCarMap.values()) {
        if (
          typeof cIdx === 'number' &&
          cIdx >= 0 &&
          cIdx < 6 &&
          !activeParticipantMap.has(cIdx)
        ) {
          activeParticipantMap.set(cIdx, cIdx % 2);
        }
      }
    }

    for (let c = 0; c < 8; c++) {
      if (activeParticipantMap.has(c)) {
        const team = activeParticipantMap.get(c) ?? c % 2;
        const preset = presets?.get?.(c) || 'octane';
        if (typeof physics.addCarAtSlot === 'function') {
          physics.addCarAtSlot(c, team, preset);
        } else if (physics.numCars <= c) {
          physics.addCar(team, preset);
        }
        physics.setCarTeam?.(c, team);
        physics.setCarCollisionMask?.(c, true, true);
        physics.setCarLinearFactorAndGravity?.(c, 1, 1, 1, 1);
        if (arena) {
          arena.vehicleRegistry.ensureCar(c, team, preset);
          if (arena.cars?.[c]) {
            arena.cars[c].visible = true;
          }
        }
      } else {
        const isSlotActive =
          typeof physics.isCarSlotActive === 'function' ? physics.isCarSlotActive(c) : false;
        if (isSlotActive && typeof physics.removeCar === 'function') {
          physics.removeCar(c);
        }
        if (arena?.cars?.[c]) {
          arena.cars[c].visible = false;
        }
      }
    }
  }

  private resetHostTelemetryAndReplayForNewMatch(reconciler: PredictionReconciler): void {
    const h = this.host;
    dismissHostLobbyOngoingNotification();
    if (h.authoritativeServer) {
      clearRetainedMatchReplayOnMatchStart();
      this.latch.hostMatchReplayNotified = false;
    }
    h.markNetworkTelemetryNotified(false);
    this.latch.overtimeAudioPlayed = false;
    h.despawnDiagnosticTestFleet();
    reconciler.setLobbyDualWorldMode?.(false);
    reconciler.setReplayPlaybackMode?.(false);
    reconciler.setMatchTelemetryActive?.(true, true);
    reconciler.resetTimelineState?.();
  }

  public handleSignal(
    reconciler: PredictionReconciler,
    sig: RuntimeSignalPacket,
    ctx: KickoffSignalStepContext,
  ): { handled: boolean; currentTick: number } {
    const h = this.host;
    const matchState = h.match?.state;
    let { currentTick } = ctx;
    const { packetServerTick, isFirstSeenSignalId, hasKickoffStartInBatch, audio } = ctx;

    switch (sig.signalType) {
      case MATCH_SIGNALS.MATCH_INITIALIZED: {
        const durationSec =
          typeof sig.param2 === 'number' && sig.param2 >= 0 ? sig.param2 : 300;
        if (matchState) {
          matchState.durationSeconds = durationSec;
        }
        return { handled: true, currentTick };
      }

      case MATCH_SIGNALS.MATCH_PREPARE: {
        const matchSeq = sig.param1 || 1;
        this.resetHostTelemetryAndReplayForNewMatch(reconciler);
        if (packetServerTick === null) currentTick = 0;
        preparePhysicsReplayRecordingForMatch(h, { clearBuffer: true, resetBallTrail: true });
        pushMatchPrepareSignalToPhysicsBuffer(h, sig, currentTick);
        resetGoalReplayIncidentFlags(h, true);
        teardownSignalReplayAndPodiumSession(h);
        this.ensureMatchParticipantsInLocalWorld(reconciler);
        exitLobbyDualWorldAndActivateMatchMode(h);
        if (matchState) {
          matchState.mode = 'match';
          matchState.phase = 'prepare';
          matchState.paused = false;
          matchState.overtime = false;
        }
        hudStore.getState().setMatchState({
          matchPhase: 'prepare',
          kickoffCountdown: 0,
          isOvertime: false,
          winner: null,
          winReason: null,
        });

        if (this.latch.lastPreparedMatchSeq !== matchSeq) {
          this.latch.lastPreparedMatchSeq = matchSeq;
          reconciler.controlMessenger.enqueueClientCommand(
            CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK,
            matchSeq,
            1,
          );
        }
        return { handled: true, currentTick };
      }

      case MATCH_SIGNALS.MATCH_STARTED: {
        this.resetHostTelemetryAndReplayForNewMatch(reconciler);
        if (packetServerTick === null) currentTick = 0;
        preparePhysicsReplayRecordingForMatch(h, { clearBuffer: true });
        resetGoalReplayIncidentFlags(h, true);
        teardownSignalReplayAndPodiumSession(h);
        this.ensureMatchParticipantsInLocalWorld(reconciler);
        exitLobbyDualWorldAndActivateMatchMode(h);
        const durationSec =
          typeof sig.param1 === 'number' &&
          Number.isFinite(sig.param1) &&
          sig.param1 >= 0
            ? sig.param1
            : 300;
        if (matchState) {
          matchState.mode = 'match';
          matchState.blueScore = 0;
          matchState.orangeScore = 0;
          matchState.remainingSeconds = durationSec;
          matchState.overtime = false;
          matchState.overtimeSeconds = 0;
          matchState.winner = null;
        }
        hudStore.getState().setMatchState({
          blueScore: 0,
          orangeScore: 0,
          remainingSeconds: durationSec,
          isOvertime: false,
          overtimeSeconds: 0,
          winner: null,
          winReason: null,
        });
        return { handled: true, currentTick };
      }

      case MATCH_SIGNALS.KICKOFF_WILL_START: {
        if (hasKickoffStartInBatch) {
          return { handled: true, currentTick };
        }
        const targetFrame = sig.param1 ?? 0;
        const isOvertimeKickoff = sig.param2 === 1 || Boolean(matchState?.overtime);
        const isNewKickoffPhase =
          isFirstSeenSignalId || this.latch.lastKickoffTargetFrame !== targetFrame;
        if (!isNewKickoffPhase && matchState?.phase === 'playing') {
          return { handled: true, currentTick };
        }
        if (isNewKickoffPhase) {
          const wasInReplay = isKickoffTransitioningFromReplay(h);
          dismissHostLobbyOngoingNotification();
          h.despawnDiagnosticTestFleet();
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          if (!reconciler.telemetryCollector.isMatchTelemetryActive) {
            reconciler.setMatchTelemetryActive?.(true, false);
          }
          preparePhysicsReplayRecordingForMatch(h);
          this.ensureMatchParticipantsInLocalWorld(reconciler);
          teardownSignalReplayAndPodiumSession(h, { exitPodium: true });
          resetCameraViewIfInvalidOrWasInReplay(h, wasInReplay);
          exitLobbyDualWorldAndActivateMatchMode(h);
          hudStore.getState().setReplayState?.({
            replayPaused: false,
            replayPersistent: false,
          });
        } else {
          useAppStore.getState().setMatchMode('match');
        }
        reconciler.setKickoffMaskUntilTick?.(targetFrame);

        const effectiveTick =
          typeof packetServerTick === 'number' && packetServerTick >= 0
            ? packetServerTick
            : typeof sig.frameId === 'number' && isNewKickoffPhase
              ? sig.frameId
              : currentTick;
        const remainingTicks = Math.max(0, targetFrame - effectiveTick);
        const rawDisplaySec = Math.max(1, Math.min(3, Math.ceil(remainingTicks / 120)));
        const prevSec =
          !isNewKickoffPhase &&
          matchState?.phase === 'kickoff' &&
          typeof matchState.countdown === 'number' &&
          matchState.countdown >= 1
            ? matchState.countdown
            : 3;
        const displaySec = isNewKickoffPhase
          ? rawDisplaySec
          : Math.min(prevSec, rawDisplaySec);

        if (matchState) {
          matchState.mode = 'match';
          matchState.phase = 'kickoff';
          matchState.paused = false;
          matchState.countdown = displaySec;
          if (isOvertimeKickoff) {
            matchState.overtime = true;
          }
        }

        hudStore.getState().setMatchState({
          matchPhase: 'kickoff',
          kickoffCountdown: displaySec,
          ...(isOvertimeKickoff ? { isOvertime: true } : {}),
        });

        if (this.latch.lastKickoffTargetFrame !== targetFrame || isFirstSeenSignalId) {
          this.latch.lastKickoffTargetFrame = targetFrame;
          this.latch.latchedKickoffSeconds.clear();
          h.resetBotKickoffStep();
          reconciler.resetTimelineState?.();
        }

        const muteSignalInReplay = isSignalAudioMutedInGoalReplay(h);
        if (isOvertimeKickoff && !this.latch.overtimeAudioPlayed && !muteSignalInReplay) {
          this.latch.overtimeAudioPlayed = true;
          audio?.play('match_entering_overtime', 1.0, 10000);
        }

        if (
          !muteSignalInReplay &&
          remainingTicks <= 360 &&
          remainingTicks > 240 &&
          !this.latch.latchedKickoffSeconds.has(3)
        ) {
          this.latch.latchedKickoffSeconds.add(3);
          audio?.play('match_countdown_321', 1.0);
        } else if (
          !muteSignalInReplay &&
          remainingTicks <= 240 &&
          remainingTicks > 120 &&
          !this.latch.latchedKickoffSeconds.has(2)
        ) {
          this.latch.latchedKickoffSeconds.add(2);
          audio?.play('match_countdown_321', 1.0);
        } else if (
          !muteSignalInReplay &&
          remainingTicks <= 120 &&
          remainingTicks > 0 &&
          !this.latch.latchedKickoffSeconds.has(1)
        ) {
          this.latch.latchedKickoffSeconds.add(1);
          audio?.play('match_countdown_321', 1.0);
        }
        return { handled: true, currentTick };
      }

      case MATCH_SIGNALS.KICKOFF_START: {
        reconciler.setLobbyDualWorldMode?.(false);
        reconciler.setReplayPlaybackMode?.(false);
        if (!reconciler.telemetryCollector.isMatchTelemetryActive) {
          reconciler.setMatchTelemetryActive?.(true, false);
        }
        preparePhysicsReplayRecordingForMatch(h);
        teardownSignalReplayAndPodiumSession(h, {
          exitPodium: true,
          resetCameraIfWasInReplay: true,
        });
        focusLocalPlayerCarInArenaAndCamera(reconciler, h);
        hudStore.getState().setReplayState?.({
          replayPaused: false,
          replayPersistent: false,
        });
        reconciler.setKickoffMaskUntilTick?.(-1);
        h.resetBotKickoffStep();

        const frameId = sig.frameId ?? -1;
        const isNewKickoffStart =
          this.latch.lastKickoffStartedFrame !== frameId || isFirstSeenSignalId;
        this.latch.lastKickoffStartedFrame = frameId;
        this.latch.lastKickoffTargetFrame = -1;
        this.latch.latchedKickoffSeconds.clear();

        if (matchState) {
          matchState.phase = 'playing';
          matchState.countdown = 0;
        }
        hudStore.getState().setMatchState({
          matchPhase: 'playing',
          kickoffCountdown: 0,
        });
        if (isNewKickoffStart && !isSignalAudioMutedInGoalReplay(h)) {
          audio?.play('match_start_go', 1.0);
        }
        return { handled: true, currentTick };
      }

      default:
        return { handled: false, currentTick };
    }
  }
}
