import { MATCH_SIGNALS } from '../../network/protocol/GlobalPayloadCodec.ts';
import {
  CAR_COLOR_SLOTS,
  unpackLoadoutSignalParam2,
} from '../../ui-core/config/vehicleConstants';
import { gameAudio } from '../../audio/GameAudioEngineFacade.ts';
import { isSignalAudioMutedInGoalReplay } from '../../audio/SignalAudioEngine.ts';
import {
  hudStore,
  notifyNetworkTelemetryExportAvailable,
} from '../runtimeUiPort.ts';
import { retainCompletedMatchReplayAndNotify } from '../../replay/ReplayFileExporter.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import {
  RuntimeGoalReplaySignalSubController,
  resolveParticipantDisplayName,
  resolveParticipantAnthemId,
  type RuntimeSignalPacket,
  type SignalAudioFacadeLike,
  type RuntimeSignalLatchState,
  type RuntimeSignalHostPort,
} from './RuntimeGoalReplaySignalSubController.ts';

export const WIN_REASON_LABELS: Readonly<Record<number, string>> = Object.freeze({
  0: 'SCORE',
  1: 'POSSESSION',
  2: 'FORFEIT',
});

interface ReplayExportDataLike {
  loadouts?: Array<Record<string, unknown>>;
  roster?: { players?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  stateInputBytes?: Uint8Array | null;
  incidentBytes?: Uint8Array | null;
  signalBytes?: Uint8Array | null;
  gameMode?: string;
  durationSeconds?: number;
  blueScore?: number;
  orangeScore?: number;
}

/**
 * RuntimeSignalDomainSubController
 * Stateful SubController owning player roster/loadout signals, match clock/pause/overtime
 * state synchronization, and match lifecycle/endgame/podium transitions.
 */
export class RuntimeSignalDomainSubController {
  public readonly host: RuntimeSignalHostPort;
  public readonly latch: RuntimeSignalLatchState;
  public readonly goalReplaySubController: RuntimeGoalReplaySignalSubController;

  constructor(host: RuntimeSignalHostPort, latch: RuntimeSignalLatchState) {
    this.host = host;
    this.latch = latch;
    this.goalReplaySubController = new RuntimeGoalReplaySignalSubController(host, latch);
  }

  public reset(): void {
    this.goalReplaySubController.reset();
  }

  private retainHostMatchReplayAfterEnd(winningTeam: number, winReasonCode: number): void {
    const h = this.host;
    if (!h.authoritativeServer || this.latch.hostMatchReplayNotified) return;
    this.latch.hostMatchReplayNotified = true;
    const blueScore = h.match?.state?.blueScore ?? hudStore.getState().blueScore ?? 0;
    const orangeScore = h.match?.state?.orangeScore ?? hudStore.getState().orangeScore ?? 0;
    const serverRoomRoster = (
      h.authoritativeServer as unknown as {
        lastRoomState?: { roster?: { players?: Array<Record<string, unknown>> } };
      }
    ).lastRoomState?.roster?.players;
    const fallbackRoster = serverRoomRoster || [];
    const notifyFallback = () => {
      retainCompletedMatchReplayAndNotify({
        ringBuffer: h.authoritativeServer?.hostReplayRingBuffer,
        fallbackState: h.authoritativeServer?.cachedSnapshot || h.physics?.state,
        mode: 'Host Match',
        durationSeconds: h.match?.state?.durationSeconds ?? 300,
        roster: fallbackRoster,
        loadouts: fallbackRoster,
        blueScore,
        orangeScore,
        winnerTeam: winningTeam,
        winReason: winReasonCode,
      });
    };
    h.authoritativeServer
      .requestFullReplayExport()
      .then((exportData: ReplayExportDataLike | null) => {
        const exportedRoster = Array.isArray(exportData?.loadouts)
          ? exportData.loadouts
          : !Array.isArray(exportData?.roster) && Array.isArray(exportData?.roster?.players)
            ? exportData.roster.players
            : Array.isArray(exportData?.roster)
              ? exportData.roster
              : fallbackRoster;
        retainCompletedMatchReplayAndNotify({
          stateInputBytes: exportData?.stateInputBytes || undefined,
          incidentBytes: exportData?.incidentBytes || undefined,
          signalBytes: exportData?.signalBytes || undefined,
          ringBuffer: h.authoritativeServer?.hostReplayRingBuffer,
          fallbackState: h.authoritativeServer?.cachedSnapshot || h.physics?.state,
          mode: 'Host Match',
          gameMode: exportData?.gameMode || '3v3',
          durationSeconds: exportData?.durationSeconds ?? h.match?.state?.durationSeconds ?? 300,
          roster: exportedRoster,
          loadouts: exportedRoster,
          blueScore: exportData?.blueScore ?? blueScore,
          orangeScore: exportData?.orangeScore ?? orangeScore,
          winnerTeam: winningTeam,
          winReason: winReasonCode,
        });
      })
      .catch((err: unknown) => {
        console.warn(
          '[RuntimeSignalDomainSubController] requestFullReplayExport failed; falling back:',
          err,
        );
        notifyFallback();
      });
  }

  public handleRosterSignal(reconciler: PredictionReconciler, sig: RuntimeSignalPacket): boolean {
    const h = this.host;
    const isLobbyDualWorld = h.isLobbyDualWorldActive(reconciler);
    const participantTeams = h.getParticipantTeams();
    switch (sig.signalType) {
      case MATCH_SIGNALS.PLAYER_JOINED:
      case MATCH_SIGNALS.PLAYER_SLOT_UPDATED: {
        const carIdx = sig.param1 ?? -1;
        const team = (sig.param2 ?? 0) & 0xff;
        if (typeof carIdx === 'number' && carIdx >= 0 && carIdx < 8) {
          if (team === 0 || team === 1) participantTeams.set(carIdx, team);
          if (isLobbyDualWorld && carIdx !== h.playerCarIndex) {
            if (h.arena?.cars?.[carIdx]) h.arena.cars[carIdx].visible = false;
            h.syncHostLobbyOngoingNotification();
            return true;
          }
          const preset = reconciler.carVisualPresets?.get(carIdx) || 'fennec';
          if (h.physics) {
            h.physics.addCarAtSlot(carIdx, team, preset);
            h.physics.setCarTeam?.(carIdx, team);
          }
          if (h.arena) {
            h.arena.ensureCar(carIdx, team, 'fennec');
            h.arena.setCarTeam?.(carIdx, team);
            if (h.arena.cars[carIdx]) {
              h.arena.cars[carIdx].visible = isLobbyDualWorld ? carIdx === h.playerCarIndex : true;
            }
          }
          if (preset) h.physics?.setCarHitbox?.(carIdx, preset);
        }
        h.syncHostLobbyOngoingNotification();
        return true;
      }

      case MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED: {
        const carIdx = sig.param1 ?? -1;
        const {
          visualId,
          hitboxId,
          colorSlot: colorSlotId,
          paintFinish,
          boostVisual,
          boostAudio,
        } = unpackLoadoutSignalParam2(sig.param2 ?? 0);

        if (typeof carIdx === 'number' && carIdx >= 0 && carIdx < 8) {
          reconciler.setCarVisualPreset?.(carIdx, visualId);
          if (isLobbyDualWorld && carIdx !== h.playerCarIndex) {
            if (h.arena?.cars?.[carIdx]) h.arena.cars[carIdx].visible = false;
            return true;
          }
          if (h.arena && !h.arena.cars[carIdx]) h.arena.ensureCar(carIdx, carIdx % 2, 'fennec');
          const currentConfig = h.entityManager?.getVehicle?.(carIdx);
          if (currentConfig?.visual !== visualId || currentConfig?.hitbox !== hitboxId) {
            if (h.entityManager) {
              h.entityManager.hotSwapVehicle(carIdx, { visual: visualId, hitbox: hitboxId });
            } else {
              h.arena?.swapCarVisual?.(carIdx, visualId);
              h.physics?.setCarHitbox?.(carIdx, hitboxId);
            }
          } else {
            h.physics?.setCarHitbox?.(carIdx, hitboxId);
          }

          let colorHex: string | null = null;
          if (colorSlotId >= 0 && colorSlotId < CAR_COLOR_SLOTS.length) {
            const slotObj =
              CAR_COLOR_SLOTS[colorSlotId] || CAR_COLOR_SLOTS.find((s) => s.id === colorSlotId);
            if (slotObj) {
              colorHex = slotObj.hex;
              h.arena?.setCarColor?.(carIdx, slotObj.hex);
              if (carIdx === h.playerCarIndex) h.selectedColorSlot = slotObj.id;
            }
          }
          h.arena?.setCarLoadout?.(carIdx, {
            colorHex: colorHex || undefined,
            paintFinish,
            boostVisual,
            boostAudio,
          });
          const audioEngine = h.options?.gameAudio || gameAudio;
          audioEngine?.setCarBoostAudioVariation?.(carIdx, boostAudio || 'rush');
        }
        return true;
      }

      case MATCH_SIGNALS.PLAYER_LEFT: {
        const leftCarIndex = sig.param1 ?? -1;
        if (leftCarIndex >= 0 && leftCarIndex < 65535) participantTeams.delete(leftCarIndex);
        if (leftCarIndex >= 0 && leftCarIndex < 65535 && leftCarIndex !== h.playerCarIndex) {
          h.physics?.removeCar(leftCarIndex);
          h.arena?.removeCar(leftCarIndex);
          if (h.flipResetVisuals.has(leftCarIndex)) {
            h.flipResetVisuals.get(leftCarIndex)?.stopVisual();
            h.flipResetVisuals.delete(leftCarIndex);
          }
        }
        h.syncHostLobbyOngoingNotification();
        return true;
      }

      default:
        return false;
    }
  }

  public handleClockAndPauseSignal(
    sig: RuntimeSignalPacket,
    currentTick: number,
    audio: SignalAudioFacadeLike | null | undefined,
    reconciler?: PredictionReconciler | null,
  ): boolean {
    const h = this.host;
    const muteSignalAudio = isSignalAudioMutedInGoalReplay(h);
    switch (sig.signalType) {
      case MATCH_SIGNALS.SYS_CTRL_STATE_ONLY: {
        const activeMode = h.modeManager?.getActiveMode?.() as any;
        const isLocalControllerActive = Boolean(
          activeMode?.rewinderController?.isBlockingLivePhysics ||
            activeMode?.standaloneReplayViewer?.isActive
        );
        reconciler?.setReplayPlaybackMode?.(true);
        if (!isLocalControllerActive) {
          h.physics?.setSimulationFrozen?.(true, 0, true);
          if (h.match) h.match.state.paused = true;
        }
        return true;
      }
      case MATCH_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME: {
        const activeMode = h.modeManager?.getActiveMode?.() as any;
        const isLocalControllerActive = Boolean(
          activeMode?.rewinderController?.isBlockingLivePhysics ||
            activeMode?.standaloneReplayViewer?.isActive
        );
        const targetTick = sig.param1 ?? currentTick;
        const countdownSec =
          sig.param2 && sig.param2 > 0
            ? sig.param2
            : Math.max(1, Math.ceil(Math.max(0, targetTick - currentTick) / 120));
        reconciler?.setReplayPlaybackMode?.(true);
        reconciler?.setKickoffMaskUntilTick?.(targetTick);
        if (!isLocalControllerActive) {
          h.physics?.setSimulationFrozen?.(true, 0, true);
          if (h.match) {
            h.match.state.paused = true;
            h.match.state.countdown = countdownSec;
          }
        } else if (h.match) {
          h.match.state.countdown = countdownSec;
        }
        hudStore.getState().setMatchState({ kickoffCountdown: countdownSec });
        return true;
      }
      case MATCH_SIGNALS.SYS_CTRL_PHYSICS_RESUME: {
        reconciler?.setReplayPlaybackMode?.(false);
        reconciler?.setKickoffMaskUntilTick?.(-1);
        h.physics?.setSimulationFrozen?.(false, 0, false);
        if (sig.param2 === 1) {
          h.physics?.setUnlimitedBoost?.(true);
        }
        if (h.match) {
          h.match.state.paused = false;
          h.match.state.countdown = 0;
          if (h.match.state.phase === 'paused' || h.match.state.phase === 'replay') {
            h.match.state.phase = 'playing';
          }
        }
        hudStore.getState().setMatchState({
          isPaused: false,
          kickoffCountdown: 0,
          matchPhase: h.match?.state?.phase || 'playing',
        });
        return true;
      }
      case MATCH_SIGNALS.TIME_ALERT_60S: {
        const frameId = sig.frameId ?? -1;
        if (this.latch.lastAlert60Frame !== frameId) {
          this.latch.lastAlert60Frame = frameId;
          if (!muteSignalAudio) audio?.play('match_60_seconds_left', 1.0, 10000);
        }
        return true;
      }
      case MATCH_SIGNALS.TIME_ALERT_30S: {
        const frameId = sig.frameId ?? -1;
        if (this.latch.lastAlert30Frame !== frameId) {
          this.latch.lastAlert30Frame = frameId;
          if (!muteSignalAudio) audio?.play('match_30_seconds_left', 1.0, 10000);
        }
        return true;
      }
      case MATCH_SIGNALS.COUNTDOWN_10S: {
        const sec = sig.param1 ?? 0;
        if (sec >= 1 && sec <= 10 && h.audioSubsystem?.last10sCountdown !== sec) {
          if (h.audioSubsystem) h.audioSubsystem.last10sCountdown = sec;
          if (!muteSignalAudio) audio?.play('match_countdown_10s', 1.0);
        }
        return true;
      }
      case MATCH_SIGNALS.CLOCK_UPDATED_SECONDS: {
        const seconds = sig.param1 ?? 0;
        const isOt = (sig.param2 || 0) === 1;
        if (
          !isOt &&
          h.match?.state?.overtime &&
          (h.match?.state?.phase === 'kickoff' || seconds === 0)
        ) {
          return true;
        }
        const remSec = isOt ? 0 : seconds;
        const otSec = isOt ? seconds : 0;
        if (h.match) {
          h.match.state.remainingSeconds = remSec;
          h.match.state.overtime = isOt;
          h.match.state.overtimeSeconds = otSec;
        }
        hudStore
          .getState()
          .setMatchState({ remainingSeconds: remSec, isOvertime: isOt, overtimeSeconds: otSec });
        return true;
      }
      case MATCH_SIGNALS.MATCH_PAUSED: {
        if (h.match) h.match.state.paused = true;
        hudStore.getState().setMatchState({ isPaused: true, matchPhase: 'paused' });
        return true;
      }
      case MATCH_SIGNALS.MATCH_WILL_RESUME: {
        const remTicks = Math.max(0, (sig.param1 ?? 0) - currentTick);
        hudStore
          .getState()
          .setMatchState({ isPaused: true, kickoffCountdown: Math.ceil(remTicks / 120) });
        return true;
      }
      case MATCH_SIGNALS.MATCH_RESUMED: {
        if (h.match) {
          h.match.state.paused = false;
          if (h.match.state.phase === 'paused') h.match.state.phase = 'playing';
        }
        hudStore.getState().setMatchState({
          isPaused: false,
          matchPhase: h.match?.state?.phase || 'playing',
          kickoffCountdown: 0,
        });
        return true;
      }
      case MATCH_SIGNALS.OVERTIME_START: {
        if (h.match) {
          h.match.state.overtime = true;
          h.match.state.overtimeSeconds = 0;
        }
        hudStore.getState().setMatchState({ isOvertime: true, overtimeSeconds: 0 });
        if (!this.latch.overtimeAudioPlayed && !muteSignalAudio) {
          this.latch.overtimeAudioPlayed = true;
          audio?.play('match_entering_overtime', 1.0, 10000);
        }
        return true;
      }
      default:
        return false;
    }
  }

  public handleGoalReplayAndEndgameSignal(
    reconciler: PredictionReconciler,
    sig: RuntimeSignalPacket,
    isFirstSeenSignalId: boolean,
    audio: SignalAudioFacadeLike | null | undefined,
    onResetSignalState?: () => void,
  ): boolean {
    if (this.goalReplaySubController.handleSignal(reconciler, sig, isFirstSeenSignalId, audio)) {
      return true;
    }

    const h = this.host;
    switch (sig.signalType) {
      case MATCH_SIGNALS.BALL_RESET: {
        h.physics?.resetGoalLatch?.();
        h.arena?.resetBallTrail?.();
        h.releaseGoalReplayCameraOverride();
        h.replayTimelineController?.endReplaySession?.();
        h.podiumController?.exitPodium?.();
        this.latch.lastKickoffTargetFrame = -1;
        this.latch.latchedKickoffSeconds.clear();
        reconciler.setKickoffMaskUntilTick?.(-1);
        if (h.match) {
          h.match.state.phase = 'playing';
          h.match.state.countdown = 0;
        }
        hudStore.getState().setMatchState({ matchPhase: 'playing', kickoffCountdown: 0 });
        return true;
      }

      case MATCH_SIGNALS.MATCH_DESTROYED: {
        h._localSkipReplayReady = false;
        reconciler.setMatchTelemetryActive?.(false, false);
        reconciler.setKickoffMaskUntilTick?.(-1);
        h.releaseGoalReplayCameraOverride();
        h.replayTimelineController?.endReplaySession?.();
        h.podiumController?.exitPodium?.();
        onResetSignalState?.();
        return true;
      }

      case MATCH_SIGNALS.MATCH_ENDED:
      case MATCH_SIGNALS.PODIUM_START: {
        if (
          h.arena?.isLobbyMode ||
          h.match?.state?.phase === 'lobby' ||
          reconciler.lobbyDualWorldMode
        ) {
          return true;
        }
        h._localSkipReplayReady = false;
        const winningTeam = sig.param1 ?? 0;
        const winReasonCode = sig.param2 || 0;
        const winnerName = winningTeam === 0 ? 'BLUE' : winningTeam === 1 ? 'ORANGE' : 'DRAW';
        const winReason = WIN_REASON_LABELS[winReasonCode] || 'SCORE';
        const isPodiumStart = sig.signalType === MATCH_SIGNALS.PODIUM_START;
        const targetPhase = isPodiumStart ? 'podium' : 'ended';
        const wasNotEnded =
          h.match?.state?.phase !== 'ended' && h.match?.state?.phase !== 'podium';

        reconciler.setReplayPlaybackMode?.(false);
        reconciler.setKickoffMaskUntilTick?.(-1);
        h.releaseGoalReplayCameraOverride();
        h.replayTimelineController?.endReplaySession?.();
        if (typeof reconciler?.localCarIndex === 'number' && reconciler.localCarIndex >= 0) {
          h.playerCarIndex = reconciler.localCarIndex;
          if (h.arena) h.arena.playerCarIndex = reconciler.localCarIndex;
          h.camera?.setFocusedCarIndex?.(reconciler.localCarIndex);
        }
        if (isPodiumStart) {
          reconciler.setMatchTelemetryActive?.(false, false);
          h.podiumController?.enterPodium?.(winningTeam, winReason);
        }
        if (h.match) {
          h.match.state.phase = targetPhase;
          h.match.state.winner = winnerName;
          h.match.state.winReason = winReason;
        }
        hudStore
          .getState()
          .setMatchState({ matchPhase: targetPhase, winner: winnerName, winReason });
        this.retainHostMatchReplayAfterEnd(winningTeam, winReasonCode);
        if (!h.isNetworkTelemetryNotified()) {
          h.markNetworkTelemetryNotified(true);
          notifyNetworkTelemetryExportAvailable(
            'match-complete',
            reconciler.telemetryCollector.recorder,
          );
        }
        h.resetAudio?.();
        h.audioSubsystem?.resetAudio?.();
        if (wasNotEnded) audio?.play('endgame', 1.0);
        return true;
      }

      default:
        return false;
    }
  }
}
