import {
  MATCH_SIGNALS,
  CLIENT_COMMAND_TYPES,
} from '../../network/protocol/GlobalPayloadCodec.ts';
import { isSignalAudioMutedInGoalReplay } from '../../audio/SignalAudioEngine.ts';
import { useAppStore, hudStore } from '../runtimeUiPort.ts';
import { dismissHostLobbyOngoingNotification } from './OnlineRosterSyncCoordinator.ts';
import { clearRetainedMatchReplayOnMatchStart } from '../../replay/ReplayFileExporter.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type {
  RuntimeSignalHostPort,
  RuntimeSignalLatchState,
  RuntimeSignalPacket,
  SignalAudioFacadeLike,
} from './RuntimeGoalReplaySignalSubController.ts';

export interface KickoffSignalStepContext {
  packetServerTick: number | null;
  currentTick: number;
  isFirstSeenSignalId: boolean;
  hasKickoffStartInBatch: boolean;
  audio: SignalAudioFacadeLike | null | undefined;
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
    if (!h || !h.physics) return;
    const presets = reconciler?.carVisualPresets;
    const peers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
    const activeParticipantMap = new Map<number, number>();
    const localIdx =
      typeof reconciler?.localCarIndex === 'number' && reconciler.localCarIndex >= 0
        ? reconciler.localCarIndex
        : typeof h.playerCarIndex === 'number' && h.playerCarIndex >= 0
          ? h.playerCarIndex
          : 0;
    h.playerCarIndex = localIdx;
    if (h.arena) {
      h.arena.playerCarIndex = localIdx;
    }
    h.camera?.setFocusedCarIndex?.(localIdx);
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
        if (typeof h.physics.addCarAtSlot === 'function') {
          h.physics.addCarAtSlot(c, team, preset);
        } else if (h.physics.numCars <= c) {
          h.physics.addCar(team, preset);
        }
        h.physics.setCarTeam?.(c, team);
        h.physics.setCarCollisionMask?.(c, true, true);
        h.physics.setCarLinearFactorAndGravity?.(c, 1, 1, 1, 1);
        if (h.arena) {
          h.arena.ensureCar?.(c, team, preset);
          if (h.arena.cars?.[c]) {
            h.arena.cars[c].visible = true;
          }
        }
      } else {
        const isSlotActive =
          typeof h.physics.isCarSlotActive === 'function'
            ? h.physics.isCarSlotActive(c)
            : false;
        if (isSlotActive && typeof h.physics.removeCar === 'function') {
          h.physics.removeCar(c);
        }
        if (h.arena?.cars?.[c]) {
          h.arena.cars[c].visible = false;
        }
      }
    }
  }

  public handleSignal(
    reconciler: PredictionReconciler,
    sig: RuntimeSignalPacket,
    ctx: KickoffSignalStepContext,
  ): { handled: boolean; currentTick: number } {
    const h = this.host;
    let { currentTick } = ctx;
    const { packetServerTick, isFirstSeenSignalId, hasKickoffStartInBatch, audio } = ctx;

    switch (sig.signalType) {
      case MATCH_SIGNALS.MATCH_INITIALIZED: {
        const durationSec =
          typeof sig.param2 === 'number' && sig.param2 >= 0 ? sig.param2 : 300;
        if (h.match) {
          h.match.state.durationSeconds = durationSec;
        }
        return { handled: true, currentTick };
      }

      case MATCH_SIGNALS.MATCH_PREPARE: {
        const matchSeq = sig.param1 || 1;
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
        if (packetServerTick === null) currentTick = 0;
        h.physics?.resetGoalLatch?.();
        h.physics?.clearReplayBuffer?.();
        h.physics?.setReplayRecordingActive?.(true);
        if (h.physics && typeof h.physics.pushSignalEvent === 'function') {
          const p1 = Number(sig.param1 || 0) >>> 0;
          const p2 = Number(sig.param2 || 0) >>> 0;
          h.physics.pushSignalEvent(
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
        h.clientReplayOverflowPaused = false;
        h.physics?.setSimulationFrozen?.(false);
        h.physics?.setUnlimitedBoost?.(false);
        h._clientGoalIncidentLatched = false;
        h.releaseGoalReplayCameraOverride();
        h.replayTimelineController?.endReplaySession?.();
        h.arena?.resetBallTrail?.();

        if (h.arena) {
          h.arena.isLobbyMode = false;
          h.arena.isHostLobby = false;
        }
        this.ensureMatchParticipantsInLocalWorld(reconciler);
        h.setLobbyGhostMode(false, { syncServerLobby: false });
        h.setLatestServerRosterState('match');
        h.interpolator?.sync?.();
        if (h.match) {
          h.match.state.mode = 'match';
          h.match.state.phase = 'prepare';
          h.match.state.paused = false;
          h.match.state.overtime = false;
        }
        h.modeManager?.setMode?.('match');
        useAppStore.getState().setMatchMode('match');
        hudStore.getState().setMatchState({
          matchPhase: 'prepare',
          kickoffCountdown: 0,
          isOvertime: false,
          winner: null,
          winReason: null,
        });

        if (this.latch.lastPreparedMatchSeq !== matchSeq) {
          this.latch.lastPreparedMatchSeq = matchSeq;
          reconciler.queueClientCommand?.(
            CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK,
            matchSeq,
            1,
          );
        }
        return { handled: true, currentTick };
      }

      case MATCH_SIGNALS.MATCH_STARTED: {
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
        if (packetServerTick === null) currentTick = 0;
        h.physics?.resetGoalLatch?.();
        h.physics?.clearReplayBuffer?.();
        h.physics?.setReplayRecordingActive?.(true);
        h.clientReplayOverflowPaused = false;
        h.physics?.setSimulationFrozen?.(false);
        h.physics?.setUnlimitedBoost?.(false);
        h._clientGoalIncidentLatched = false;
        h.releaseGoalReplayCameraOverride();
        h.replayTimelineController?.endReplaySession?.();
        if (h.arena) {
          h.arena.isLobbyMode = false;
          h.arena.isHostLobby = false;
        }
        this.ensureMatchParticipantsInLocalWorld(reconciler);
        h.setLobbyGhostMode(false, { syncServerLobby: false });
        h.setLatestServerRosterState('match');
        h.interpolator?.sync?.();
        const durationSec =
          typeof sig.param1 === 'number' &&
          Number.isFinite(sig.param1) &&
          sig.param1 >= 0
            ? sig.param1
            : 300;
        if (h.match) {
          h.match.state.mode = 'match';
          h.match.state.blueScore = 0;
          h.match.state.orangeScore = 0;
          h.match.state.remainingSeconds = durationSec;
          h.match.state.overtime = false;
          h.match.state.overtimeSeconds = 0;
          h.match.state.winner = null;
        }
        h.modeManager?.setMode?.('match');
        useAppStore.getState().setMatchMode('match');
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
        const isOvertimeKickoff = sig.param2 === 1 || Boolean(h.match?.state?.overtime);
        const isNewKickoffPhase =
          isFirstSeenSignalId || this.latch.lastKickoffTargetFrame !== targetFrame;
        if (!isNewKickoffPhase && h.match?.state?.phase === 'playing') {
          return { handled: true, currentTick };
        }
        if (isNewKickoffPhase) {
          const wasInReplay = Boolean(
            h.isGoalReplayCameraOverrideActive() ||
              h.replayTimelineController?.sessionState?.isActive ||
              h.match?.state?.phase === 'replay',
          );
          dismissHostLobbyOngoingNotification();
          h.despawnDiagnosticTestFleet();
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          if (!reconciler.telemetryCollector.isMatchTelemetryActive) {
            reconciler.setMatchTelemetryActive?.(true, false);
          }
          if (!h.clientReplayOverflowPaused) {
            h.physics?.setReplayRecordingActive?.(true);
          }
          h.physics?.resetGoalLatch?.();
          h.physics?.setSimulationFrozen?.(false);
          h.physics?.setUnlimitedBoost?.(false);
          if (h.arena) {
            h.arena.isLobbyMode = false;
            h.arena.isHostLobby = false;
          }
          this.ensureMatchParticipantsInLocalWorld(reconciler);
          h.setLobbyGhostMode(false, { syncServerLobby: false });
          h.setLatestServerRosterState('match');
          h.releaseGoalReplayCameraOverride();
          h.replayTimelineController?.endReplaySession?.();
          h.podiumController?.exitPodium?.();
          const camPos = h.camera?.camera?.position;
          if (
            wasInReplay ||
            (camPos &&
              (!Number.isFinite(camPos.x) ||
                !Number.isFinite(camPos.y) ||
                !Number.isFinite(camPos.z)))
          ) {
            h.camera?.resetView?.();
          }
          h.interpolator?.sync?.();
          hudStore.getState().setReplayState?.({
            replayPaused: false,
            replayPersistent: false,
          });
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
          h.match?.state?.phase === 'kickoff' &&
          typeof h.match.state.countdown === 'number' &&
          h.match.state.countdown >= 1
            ? h.match.state.countdown
            : 3;
        const displaySec = isNewKickoffPhase
          ? rawDisplaySec
          : Math.min(prevSec, rawDisplaySec);

        if (h.match) {
          h.match.state.mode = 'match';
          h.match.state.phase = 'kickoff';
          h.match.state.paused = false;
          h.match.state.countdown = displaySec;
          if (isOvertimeKickoff) {
            h.match.state.overtime = true;
          }
        }
        h.modeManager?.setMode?.('match');
        useAppStore.getState().setMatchMode('match');

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
        if (!h.clientReplayOverflowPaused) {
          h.physics?.setReplayRecordingActive?.(true);
        }
        h.physics?.resetGoalLatch?.();
        h.physics?.setSimulationFrozen?.(false);
        if (h.isGoalReplayCameraOverrideActive()) {
          h.releaseGoalReplayCameraOverride();
          h.camera?.resetView?.();
        }
        h.replayTimelineController?.endReplaySession?.();
        if (
          typeof reconciler?.localCarIndex === 'number' &&
          reconciler.localCarIndex >= 0
        ) {
          h.playerCarIndex = reconciler.localCarIndex;
          if (h.arena) h.arena.playerCarIndex = reconciler.localCarIndex;
          h.camera?.setFocusedCarIndex?.(reconciler.localCarIndex);
        }
        hudStore.getState().setReplayState?.({
          replayPaused: false,
          replayPersistent: false,
        });
        h.podiumController?.exitPodium?.();
        reconciler.setKickoffMaskUntilTick?.(-1);
        h.resetBotKickoffStep();

        const frameId = sig.frameId ?? -1;
        const isNewKickoffStart =
          this.latch.lastKickoffStartedFrame !== frameId || isFirstSeenSignalId;
        this.latch.lastKickoffStartedFrame = frameId;
        this.latch.lastKickoffTargetFrame = -1;
        this.latch.latchedKickoffSeconds.clear();

        if (h.match) {
          h.match.state.phase = 'playing';
          h.match.state.countdown = 0;
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
