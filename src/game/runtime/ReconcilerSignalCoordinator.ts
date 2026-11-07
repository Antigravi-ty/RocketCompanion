import {
  MATCH_SIGNALS,
  isSystemControlSignal,
} from '../../network/protocol/GlobalPayloadCodec.ts';
import { gameAudio } from '../../audio/GameAudioEngineFacade.ts';
import { eventStreamStore } from '../runtimeUiPort.ts';
import { RuntimeSignalDomainSubController } from './RuntimeSignalDomainSubController.ts';
import type {
  RuntimeSignalHostPort,
  RuntimeSignalLatchState,
  RuntimeSignalPacket,
} from './RuntimeGoalReplaySignalSubController.ts';
import { RuntimeKickoffSignalSubController } from './RuntimeKickoffSignalSubController.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';

/**
 * Domain state object owning signal deduplication and kickoff/alert frame latches.
 */
export class SignalLatchState implements RuntimeSignalLatchState {
  public readonly seenSignalIds = new Set<number>();
  public lastPreparedMatchSeq = -1;
  public hostMatchReplayNotified = false;
  public overtimeAudioPlayed = false;
  public lastKickoffTargetFrame = -1;
  public readonly latchedKickoffSeconds = new Set<number>();
  public lastKickoffStartedFrame = -1;
  public lastAlert60Frame = -1;
  public lastAlert30Frame = -1;

  public resetForKickoff(): void {
    this.lastKickoffTargetFrame = -1;
    this.latchedKickoffSeconds.clear();
    this.lastKickoffStartedFrame = -1;
  }

  public resetForMatchPrepare(matchSeq = -1): void {
    this.lastPreparedMatchSeq = matchSeq;
    this.hostMatchReplayNotified = false;
    this.overtimeAudioPlayed = false;
    this.resetForKickoff();
    this.lastAlert60Frame = -1;
    this.lastAlert30Frame = -1;
  }

  public resetAll(): void {
    this.seenSignalIds.clear();
    this.resetForMatchPrepare(-1);
  }

  public recordSignalId(signalId?: number): boolean {
    const isFirstSeen = !signalId || !this.seenSignalIds.has(signalId);
    if (signalId) {
      this.seenSignalIds.add(signalId);
      if (this.seenSignalIds.size > 512) {
        const oldest = this.seenSignalIds.values().next().value;
        if (oldest !== undefined) {
          this.seenSignalIds.delete(oldest);
        }
      }
    }
    return isFirstSeen;
  }
}

/**
 * ReconcilerSignalCoordinator
 * Stateful SubController owning network reconciler signal deduplication, kickoff latch,
 * alert frame state, and domain signal routing under RuntimeNetworkManager.
 */
export class ReconcilerSignalCoordinator {
  public readonly host: RuntimeSignalHostPort;
  public readonly latch = new SignalLatchState();
  public readonly domainSubController: RuntimeSignalDomainSubController;
  public readonly kickoffSubController: RuntimeKickoffSignalSubController;

  constructor(host: RuntimeSignalHostPort) {
    this.host = host;
    this.domainSubController = new RuntimeSignalDomainSubController(host, this.latch);
    this.kickoffSubController = new RuntimeKickoffSignalSubController(host, this.latch);
  }

  public get lastKickoffTargetFrame(): number {
    return this.latch.lastKickoffTargetFrame;
  }

  public set lastKickoffTargetFrame(value: number) {
    this.latch.lastKickoffTargetFrame = value;
  }

  public get latchedKickoffSeconds(): Set<number> {
    return this.latch.latchedKickoffSeconds;
  }

  public resetSignalState(): void {
    this.latch.resetAll();

    const h = this.host;
    if (!h) return;
    h._clientGoalIncidentLatched = false;
    h._localSkipReplayReady = false;
    if (h.audioSubsystem) {
      h.audioSubsystem.lastRemainingSec = -1;
      h.audioSubsystem.last10sCountdown = -1;
    }
    h.releaseGoalReplayCameraOverride?.();
  }

  public bindReconcilerSignals(reconciler: PredictionReconciler | null): void {
    const h = this.host;
    if (!reconciler) return;

    this.resetSignalState();

    reconciler.onSignals = (
      signals: Array<RuntimeSignalPacket | null | undefined>,
      packetServerTick: number | null = null,
    ) => {
      const audio = h.options?.gameAudio || gameAudio;
      let currentTick =
        typeof packetServerTick === 'number' && packetServerTick >= 0
          ? packetServerTick
          : reconciler.lastAckedServerTick >= 0
            ? reconciler.lastAckedServerTick
            : 0;

      const hasKickoffStartInBatch = signals.some(
        (s) => s && s.signalType === MATCH_SIGNALS.KICKOFF_START,
      );

      for (const s of signals) {
        if (
          s &&
          (s.signalType === MATCH_SIGNALS.MATCH_PREPARE ||
            s.signalType === MATCH_SIGNALS.MATCH_STARTED ||
            s.signalType === MATCH_SIGNALS.KICKOFF_WILL_START)
        ) {
          if (h.arena && (h.arena.isLobbyMode || h.arena.isHostLobby)) {
            h.arena.isLobbyMode = false;
            h.arena.isHostLobby = false;
          }
          if (reconciler.lobbyDualWorldMode) {
            reconciler.setLobbyDualWorldMode?.(false);
          }
          reconciler.hostLobbyMode = false;
          break;
        }
      }

      for (const sig of signals) {
        if (!sig) continue;

        if (typeof sig.signalId === 'number' && sig.signalId > 0) {
          reconciler.controlMessenger.acknowledgeSignal(sig.signalId, sig.signalType);
        }

        const isFirstSeenSignalId = this.latch.recordSignalId(sig.signalId);

        if (isFirstSeenSignalId) {
          const rawSignalType = sig.signalType || 0;
          if (rawSignalType >= 0x80) {
            eventStreamStore.addEvent({
              type: rawSignalType | 0x80,
              impulse: sig.param1 || 0,
              speed: sig.param2 || 0,
              x: 0,
              y: 0,
              z: 0,
              tick: sig.frameId,
            });
            if (
              rawSignalType !== MATCH_SIGNALS.MATCH_PREPARE &&
              !isSystemControlSignal(rawSignalType) &&
              h.physics &&
              typeof h.physics.pushSignalEvent === 'function'
            ) {
              const p1 = Number(sig.param1 || 0) >>> 0;
              const p2 = Number(sig.param2 || 0) >>> 0;
              const wasmFrameIdx = Math.max(0, (h.physics.getReplayFrameCount?.() ?? 0) - 1);
              h.physics.pushSignalEvent(
                rawSignalType,
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
                wasmFrameIdx >>> 0,
              );
            }
          }
        } else if (sig.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START) {
          continue;
        }

        if (this.domainSubController.handleRosterSignal(reconciler, sig)) {
          continue;
        }
        if (
          this.domainSubController.handleClockAndPauseSignal(sig, currentTick, audio, reconciler)
        ) {
          continue;
        }

        if (sig.signalType === MATCH_SIGNALS.COMMAND_ACK) {
          reconciler.controlMessenger.resolveClientCommandAck(sig.param1 ?? 0);
          continue;
        }

        const kickoffStep = this.kickoffSubController.handleSignal(reconciler, sig, {
          packetServerTick,
          currentTick,
          isFirstSeenSignalId,
          hasKickoffStartInBatch,
          audio,
        });
        currentTick = kickoffStep.currentTick;
        if (kickoffStep.handled) {
          continue;
        }

        this.domainSubController.handleGoalReplayAndEndgameSignal(
          reconciler,
          sig,
          isFirstSeenSignalId,
          audio,
          () => this.resetSignalState(),
        );
      }
    };
  }
}
