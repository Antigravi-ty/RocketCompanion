import { MATCH_SIGNALS, CLIENT_COMMAND_TYPES } from '../../network/GlobalPayloadCodec.js';
import { gameAudio } from '../../audio/GameAudioEngineFacade.js';
import { useAppStore } from '../../stores/appStore';
import { hudStore } from '../../stores/hudStore';
import { eventStreamStore } from '../../stores/eventStreamStore';
import {
  WIN_REASON_LABELS,
  handleRuntimeRosterSignal,
  handleRuntimeClockAndPauseSignal
} from './RuntimeSignalDomainHandlers.js';
import { dismissHostLobbyOngoingNotification } from './RuntimeOnlineRosterSync.js';
import {
  retainCompletedMatchReplayAndNotify,
  clearRetainedMatchReplayOnMatchStart
} from '../../replay/ReplayFileExporter.js';

export function resetRuntimeReconcilerSignalState(runtime) {
  const r = runtime;
  if (!r) return;
  if (r._seenSignalIds instanceof Set) {
    r._seenSignalIds.clear();
  } else {
    r._seenSignalIds = new Set();
  }
  r._lastPreparedMatchSeq = -1;
  r._clientGoalIncidentLatched = false;
  r._hostMatchReplayNotified = false;
  r.lastKickoffTargetFrame = -1;
  if (r.latchedKickoffSeconds instanceof Set) {
    r.latchedKickoffSeconds.clear();
  } else {
    r.latchedKickoffSeconds = new Set();
  }
  r._lastKickoffStartedFrame = -1;
  r._lastAlert60Frame = -1;
  r._lastAlert30Frame = -1;
  r.audioLastRemainingSec = -1;
  r.audioLast10sCountdown = -1;
}

function ensureMatchParticipantsInLocalWorld(r, reconciler) {
  if (!r || !r.physics) return;
  const presets = reconciler?.carVisualPresets;
  const peers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
  let maxCarIdx = r.playerCarIndex ?? 0;
  if (presets instanceof Map) {
    for (const cIdx of presets.keys()) {
      if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < 6 && cIdx > maxCarIdx) {
        maxCarIdx = cIdx;
      }
    }
  }
  for (const peer of peers) {
    if (typeof peer?.carIndex === 'number' && peer.carIndex >= 0 && peer.carIndex < 6 && peer.carIndex > maxCarIdx) {
      maxCarIdx = peer.carIndex;
    }
  }
  if (r.remotePeerCarMap instanceof Map) {
    for (const cIdx of r.remotePeerCarMap.values()) {
      if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < 6 && cIdx > maxCarIdx) {
        maxCarIdx = cIdx;
      }
    }
  }
  while (r.physics.numCars <= maxCarIdx) {
    const nextIdx = r.physics.numCars;
    const team = nextIdx % 2;
    const preset = presets?.get?.(nextIdx) || 'octane';
    r.physics.addCar(team, preset);
  }
  const activeCount = Math.min(6, Math.max(maxCarIdx + 1, r.physics.numCars));
  for (let c = 0; c < activeCount; c++) {
    const team = c % 2;
    r.physics.setCarTeam?.(c, team);
    r.physics.setCarCollisionMask?.(c, true, true);
    r.physics.setCarLinearFactorAndGravity?.(c, 1, 1, 1, 1);
    if (c <= maxCarIdx && r.arena) {
      r.arena.ensureCar?.(c, team, presets?.get?.(c) || 'fennec');
      if (r.arena.cars?.[c]) {
        r.arena.cars[c].visible = true;
      }
    }
  }
}

export function bindReconcilerSignals(runtime, reconciler) {
  const r = runtime;
  if (!reconciler) return;

  resetRuntimeReconcilerSignalState(r);

  reconciler.onSignals = (signals) => {
    const audio = r.options.gameAudio || gameAudio;
    const currentTick = reconciler.lastAckedServerTick >= 0 ? reconciler.lastAckedServerTick : (reconciler.serverTick ?? 0);

    for (const sig of signals) {
      if (!sig) continue;

      if (typeof sig.signalId === 'number' && sig.signalId > 0) {
        reconciler.acknowledgeSignal?.(sig.signalId, sig.signalType);
      }

      const isFirstSeenSignalId = !sig.signalId || !r._seenSignalIds.has(sig.signalId);
      if (sig.signalId) {
        r._seenSignalIds.add(sig.signalId);
        if (r._seenSignalIds.size > 512) {
          const oldest = r._seenSignalIds.values().next().value;
          r._seenSignalIds.delete(oldest);
        }
      }

      if (isFirstSeenSignalId) {
        eventStreamStore.addEvent({
          type: (sig.signalType || 0) | 0x80,
          impulse: sig.param1 || 0,
          speed: sig.param2 || 0,
          x: 0,
          y: 0,
          z: 0,
          tick: sig.frameId
        });
      } else if (sig.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START) {
        continue;
      }

      if (handleRuntimeRosterSignal(r, reconciler, sig)) {
        continue;
      }
      if (handleRuntimeClockAndPauseSignal(r, reconciler, sig, currentTick, audio)) {
        continue;
      }

      switch (sig.signalType) {
        case MATCH_SIGNALS.COMMAND_ACK: {
          reconciler.resolveClientCommandAck?.(sig.param1);
          break;
        }

        case MATCH_SIGNALS.MATCH_PREPARE: {
          const matchSeq = sig.param1 || 1;
          dismissHostLobbyOngoingNotification();
          if (r.authoritativeServer) {
            clearRetainedMatchReplayOnMatchStart();
            r._hostMatchReplayNotified = false;
          }
          r.networkManager?.despawnDiagnosticTestFleet?.();
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          reconciler.resetTimelineState?.();
          r.physics?.resetGoalLatch?.();
          r.physics?.setSimulationFrozen?.(false);
          r.physics?.setUnlimitedBoost?.(false);
          r.networkManager?.setLobbyGhostMode?.(false);
          r._clientGoalIncidentLatched = false;
          r.arena?.resetBallTrail?.();

          if (r.arena) {
            r.arena.isLobbyMode = false;
            r.arena.isHostLobby = false;
          }
          ensureMatchParticipantsInLocalWorld(r, reconciler);
          if (r.match) {
            r.match.state.mode = 'match';
            r.match.state.phase = 'prepare';
            r.match.state.paused = false;
          }
          r.modeManager?.setMode?.('match');
          useAppStore.getState().setMatchMode('match');
          hudStore.getState().setMatchState({
            matchPhase: 'prepare',
            kickoffCountdown: 0,
            winner: null,
            winReason: null
          });

          if (r._lastPreparedMatchSeq !== matchSeq) {
            r._lastPreparedMatchSeq = matchSeq;
            reconciler.queueClientCommand?.(CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK, matchSeq, 1);
          }
          break;
        }

        case MATCH_SIGNALS.MATCH_STARTED: {
          dismissHostLobbyOngoingNotification();
          if (r.authoritativeServer) {
            clearRetainedMatchReplayOnMatchStart();
            r._hostMatchReplayNotified = false;
          }
          r.networkManager?.despawnDiagnosticTestFleet?.();
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          if (!reconciler.isTimelineSynchronized) {
            reconciler.resetTimelineState?.();
          }
          r.physics?.resetGoalLatch?.();
          r.physics?.clearReplayBuffer?.();
          r.physics?.setSimulationFrozen?.(false);
          r.physics?.setUnlimitedBoost?.(false);
          r.networkManager?.setLobbyGhostMode?.(false);
          r._clientGoalIncidentLatched = false;
          if (r.arena) {
            r.arena.isLobbyMode = false;
            r.arena.isHostLobby = false;
          }
          ensureMatchParticipantsInLocalWorld(r, reconciler);
          const durationSec = typeof sig.param1 === 'number' && Number.isFinite(sig.param1) && sig.param1 >= 0
            ? sig.param1
            : 300;
          const isImmediateOvertime = durationSec === 0;
          if (r.match) {
            r.match.state.mode = 'match';
            r.match.state.blueScore = 0;
            r.match.state.orangeScore = 0;
            r.match.state.remainingSeconds = durationSec;
            r.match.state.overtime = isImmediateOvertime;
            r.match.state.overtimeSeconds = 0;
            r.match.state.winner = null;
          }
          r.modeManager?.setMode?.('match');
          useAppStore.getState().setMatchMode('match');
          hudStore.getState().setMatchState({
            blueScore: 0,
            orangeScore: 0,
            remainingSeconds: durationSec,
            isOvertime: isImmediateOvertime,
            overtimeSeconds: 0,
            winner: null,
            winReason: null
          });
          break;
        }

        case MATCH_SIGNALS.KICKOFF_WILL_START: {
          dismissHostLobbyOngoingNotification();
          r.networkManager?.despawnDiagnosticTestFleet?.();
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          r.physics?.resetGoalLatch?.();
          r.physics?.setSimulationFrozen?.(false);
          r.physics?.setUnlimitedBoost?.(false);
          r.networkManager?.setLobbyGhostMode?.(false);
          if (r.arena) {
            r.arena.isLobbyMode = false;
            r.arena.isHostLobby = false;
          }
          ensureMatchParticipantsInLocalWorld(r, reconciler);
          r.replayTimelineController?.endReplaySession?.();
          r.podiumController?.exitPodium?.();
          const targetFrame = sig.param1;
          reconciler.setKickoffMaskUntilTick?.(targetFrame);

          const remainingTicks = Math.max(0, targetFrame - currentTick);
          const displaySec = remainingTicks > 0 ? Math.min(3, Math.ceil(remainingTicks / 120)) : 0;

          if (r.match) {
            r.match.state.mode = 'match';
            r.match.state.phase = 'kickoff';
            r.match.state.paused = false;
            r.match.state.countdown = displaySec;
          }
          r.modeManager?.setMode?.('match');
          useAppStore.getState().setMatchMode('match');

          hudStore.getState().setMatchState({
            matchPhase: 'kickoff',
            kickoffCountdown: displaySec
          });

          if (r.lastKickoffTargetFrame !== targetFrame || isFirstSeenSignalId) {
            r.lastKickoffTargetFrame = targetFrame;
            r.latchedKickoffSeconds = new Set();
            r.botKickoffStep = 0;
            if (!reconciler.isTimelineSynchronized) {
              reconciler.resetTimelineState?.();
            }
          }

          if (remainingTicks <= 360 && remainingTicks > 240 && !r.latchedKickoffSeconds.has(3)) {
            r.latchedKickoffSeconds.add(3);
            audio?.play('match_countdown_321', 1.0);
          } else if (remainingTicks <= 240 && remainingTicks > 120 && !r.latchedKickoffSeconds.has(2)) {
            r.latchedKickoffSeconds.add(2);
            audio?.play('match_countdown_321', 1.0);
          } else if (remainingTicks <= 120 && remainingTicks > 0 && !r.latchedKickoffSeconds.has(1)) {
            r.latchedKickoffSeconds.add(1);
            audio?.play('match_countdown_321', 1.0);
          }
          break;
        }

        case MATCH_SIGNALS.KICKOFF_START: {
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          r.physics?.resetGoalLatch?.();
          r.physics?.setSimulationFrozen?.(false);
          r.replayTimelineController?.endReplaySession?.();
          r.podiumController?.exitPodium?.();
          reconciler.setKickoffMaskUntilTick?.(-1);
          r.botKickoffStep = 0;

          const isNewKickoffStart = r._lastKickoffStartedFrame !== sig.frameId || isFirstSeenSignalId;
          r._lastKickoffStartedFrame = sig.frameId;
          r.lastKickoffTargetFrame = -1;
          r.latchedKickoffSeconds?.clear();

          if (r.match) {
            r.match.state.phase = 'playing';
            r.match.state.countdown = 0;
          }
          hudStore.getState().setMatchState({
            matchPhase: 'playing',
            kickoffCountdown: 0
          });
          if (isNewKickoffStart) {
            audio?.play('match_start_go', 1.0);
          }
          break;
        }

        case MATCH_SIGNALS.SCORE_UPDATED: {
          const bScore = sig.param1;
          const oScore = sig.param2;
          const isScoreChange = r.match?.state?.blueScore !== bScore || r.match?.state?.orangeScore !== oScore;

          if (r.match) {
            r.match.state.phase = 'goal';
            r.match.state.blueScore = bScore;
            r.match.state.orangeScore = oScore;
          }

          hudStore.getState().setMatchState({
            matchPhase: 'goal',
            blueScore: bScore,
            orangeScore: oScore
          });

          if (isScoreChange) {
            audio?.play('sfx_goal_poof', 1.0);
          }
          break;
        }

        case MATCH_SIGNALS.GOAL_REPLAY_WILL_START: {
          const scoringTeam = sig.param1 ?? 0;
          if (r.match) {
            r.match.state.phase = 'goal';
            r.match.state.scorer = scoringTeam;
          }
          hudStore.getState().setMatchState({
            matchPhase: 'goal'
          });
          break;
        }

        case MATCH_SIGNALS.GOAL_REPLAY_START: {
          reconciler.setReplayPlaybackMode?.(true);
          r.physics?.resetGoalLatch?.();
          const replayTicks = sig.param1 > 0 ? sig.param1 : 360;
          if (r.match) {
            r.match.state.phase = 'replay';
          }
          r.replayTimelineController?.beginReplaySession?.({
            durationTicks: replayTicks,
            scoringTeam: r.match?.state?.scorer ?? 0
          });
          hudStore.getState().setMatchState({
            matchPhase: 'replay'
          });
          break;
        }

        case MATCH_SIGNALS.GOAL_REPLAY_WILL_END:
        case MATCH_SIGNALS.GOAL_REPLAY_END: {
          if (sig.signalType === MATCH_SIGNALS.GOAL_REPLAY_END) {
            reconciler.setReplayPlaybackMode?.(false);
          }
          r.physics?.resetGoalLatch?.();
          r.physics?.setSimulationFrozen?.(false);
          r.replayTimelineController?.endReplaySession?.();
          if (r.match && r.match.state.phase === 'replay') {
            r.match.state.phase = 'kickoff';
          }
          break;
        }

        case MATCH_SIGNALS.BALL_RESET: {
          r.physics?.resetGoalLatch?.();
          r.arena?.resetBallTrail?.();
          r.replayTimelineController?.endReplaySession?.();
          r.podiumController?.exitPodium?.();
          r.lastKickoffTargetFrame = -1;
          r.latchedKickoffSeconds?.clear();
          reconciler.setKickoffMaskUntilTick?.(-1);
          if (r.match) {
            r.match.state.phase = 'playing';
            r.match.state.countdown = 0;
          }
          hudStore.getState().setMatchState({
            matchPhase: 'playing',
            kickoffCountdown: 0
          });
          break;
        }

        case MATCH_SIGNALS.MATCH_DESTROYED: {
          reconciler.setKickoffMaskUntilTick?.(-1);
          r.replayTimelineController?.endReplaySession?.();
          r.podiumController?.exitPodium?.();
          resetRuntimeReconcilerSignalState(r);
          break;
        }

        case MATCH_SIGNALS.MATCH_ENDED:
        case MATCH_SIGNALS.PODIUM_START: {
          const winningTeam = sig.param1;
          const winReasonCode = sig.param2 || 0;
          const winnerName = winningTeam === 0 ? 'BLUE' : (winningTeam === 1 ? 'ORANGE' : 'DRAW');
          const winReason = WIN_REASON_LABELS[winReasonCode] || 'SCORE';
          const targetPhase = sig.signalType === MATCH_SIGNALS.PODIUM_START ? 'podium' : 'ended';
          const wasNotEnded = r.match?.state?.phase !== 'ended' && r.match?.state?.phase !== 'podium';

          reconciler.setKickoffMaskUntilTick?.(-1);
          r.replayTimelineController?.endReplaySession?.();
          r.podiumController?.enterPodium?.(winningTeam, winReason);

          if (r.match) {
            r.match.state.phase = targetPhase;
            r.match.state.winner = winnerName;
            r.match.state.winReason = winReason;
          }

          hudStore.getState().setMatchState({
            matchPhase: targetPhase,
            winner: winnerName,
            winReason
          });

          if (r.authoritativeServer && !r._hostMatchReplayNotified) {
            r._hostMatchReplayNotified = true;
            const blueScore = r.match?.state?.blueScore ?? hudStore.getState().blueScore ?? 0;
            const orangeScore = r.match?.state?.orangeScore ?? hudStore.getState().orangeScore ?? 0;
            if (typeof r.authoritativeServer.requestFullReplayExport === 'function') {
              r.authoritativeServer.requestFullReplayExport().then((exportData) => {
                retainCompletedMatchReplayAndNotify({
                  stateInputBytes: exportData?.stateInputBytes || null,
                  incidentBytes: exportData?.incidentBytes || null,
                  signalBytes: exportData?.signalBytes || null,
                  frameCount: exportData?.frameCount || 0,
                  ringBuffer: r.authoritativeServer?.hostReplayRingBuffer || r.physics?.replayRingBuffer,
                  fallbackState: r.authoritativeServer?.cachedSnapshot || r.physics?.state,
                  modeLabel: 'Host Match',
                  gameMode: exportData?.gameMode || '3v3',
                  blueScore: exportData?.blueScore ?? blueScore,
                  orangeScore: exportData?.orangeScore ?? orangeScore,
                  winnerTeam: winningTeam,
                  winReason
                });
              }).catch((err) => {
                console.warn(
                  '[RuntimeReconcilerSignalHandler] requestFullReplayExport failed; falling back to local hostReplayRingBuffer / cachedSnapshot:',
                  err
                );
                retainCompletedMatchReplayAndNotify({
                  ringBuffer: r.authoritativeServer?.hostReplayRingBuffer || r.physics?.replayRingBuffer,
                  fallbackState: r.authoritativeServer?.cachedSnapshot || r.physics?.state,
                  modeLabel: 'Host Match',
                  blueScore,
                  orangeScore,
                  winnerTeam: winningTeam,
                  winReason
                });
              });
            } else {
              console.warn(
                '[RuntimeReconcilerSignalHandler] authoritativeServer.requestFullReplayExport is unavailable; falling back to local hostReplayRingBuffer / cachedSnapshot.'
              );
              retainCompletedMatchReplayAndNotify({
                ringBuffer: r.authoritativeServer.hostReplayRingBuffer || r.physics?.replayRingBuffer,
                fallbackState: r.authoritativeServer.cachedSnapshot || r.physics?.state,
                modeLabel: 'Host Match',
                blueScore,
                orangeScore,
                winnerTeam: winningTeam,
                winReason
              });
            }
          }

          if (wasNotEnded) {
            audio?.play('endgame', 1.0);
          }
          break;
        }

        case MATCH_SIGNALS.DEMOLITION: {
          if (isFirstSeenSignalId) {
            audio?.play('sfx_goal_poof', 1.2);
          }
          break;
        }

        default:
          break;
      }
    }
  };
}
