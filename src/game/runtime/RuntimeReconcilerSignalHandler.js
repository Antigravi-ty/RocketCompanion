import { MATCH_SIGNALS, CLIENT_COMMAND_TYPES } from '../../network/protocol/GlobalPayloadCodec.js';
import { FLIP_RESET_SUBTYPES, FLIP_RESET_OBJECT_TYPES } from '../../physics/RocketSimConstants.js';
import { gameAudio } from '../../audio/GameAudioEngineFacade.js';
import { isSignalAudioMutedInGoalReplay } from '../../audio/SignalAudioEngine.js';
import { useAppStore } from '../../ui-core/stores/appStore';
import { hudStore } from '../../ui-core/stores/hudStore';
import { eventStreamStore } from '../../ui-core/stores/eventStreamStore';
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
import { notifyNetworkTelemetryExportAvailable } from '../../ui-core/stores/pacingTelemetryExporter.js';

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
  r._overtimeAudioPlayed = false;
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
  r.goalReplayCameraOverrideActive = false;
}

function resolveParticipantDisplayName(r, carIndex, scoringTeam = 0) {
  const rosterPlayers = Array.isArray(r?._lastRosterSnapshot?.players)
    ? r._lastRosterSnapshot.players
    : Array.isArray(r?._lastRosterSnapshot)
    ? r._lastRosterSnapshot
    : [];
  const found = rosterPlayers.find((p) => p && p.carIndex === carIndex);
  if (found && (found.name || found.username)) {
    return found.name || found.username;
  }
  const peers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
  const peer = peers.find((p) => p && p.carIndex === carIndex);
  if (peer && peer.name) {
    return peer.name;
  }
  if (carIndex === (r?.playerCarIndex ?? 0)) {
    return useAppStore?.getState?.()?.onlineSession?.playerName || 'Player';
  }
  return scoringTeam === 1 ? 'ORANGE' : 'BLUE';
}

function ensureMatchParticipantsInLocalWorld(r, reconciler) {
  if (!r || !r.physics) return;
  const presets = reconciler?.carVisualPresets;
  const peers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
  const activeParticipantMap = new Map();
  const localIdx = typeof r.playerCarIndex === 'number' && r.playerCarIndex >= 0 ? r.playerCarIndex : 0;
  activeParticipantMap.set(localIdx, localIdx % 2);

  if (presets instanceof Map) {
    for (const cIdx of presets.keys()) {
      if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < 6 && !activeParticipantMap.has(cIdx)) {
        activeParticipantMap.set(cIdx, cIdx % 2);
      }
    }
  }
  for (const peer of peers) {
    if (typeof peer?.carIndex === 'number' && peer.carIndex >= 0 && peer.carIndex < 6) {
      activeParticipantMap.set(peer.carIndex, typeof peer.team === 'number' ? peer.team : (peer.carIndex % 2));
    }
  }
  if (r.remotePeerCarMap instanceof Map) {
    for (const cIdx of r.remotePeerCarMap.values()) {
      if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < 6 && !activeParticipantMap.has(cIdx)) {
        activeParticipantMap.set(cIdx, cIdx % 2);
      }
    }
  }

  for (let c = 0; c < 8; c++) {
    if (activeParticipantMap.has(c)) {
      const team = activeParticipantMap.get(c) ?? (c % 2);
      const preset = presets?.get?.(c) || 'octane';
      if (typeof r.physics.addCarAtSlot === 'function') {
        r.physics.addCarAtSlot(c, team, preset);
      } else if (r.physics.numCars <= c) {
        r.physics.addCar(team, preset);
      }
      r.physics.setCarTeam?.(c, team);
      r.physics.setCarCollisionMask?.(c, true, true);
      r.physics.setCarLinearFactorAndGravity?.(c, 1, 1, 1, 1);
      if (r.arena) {
        r.arena.ensureCar?.(c, team, preset);
        if (r.arena.cars?.[c]) {
          r.arena.cars[c].visible = true;
        }
      }
    } else {
      const isSlotActive = typeof r.physics.isCarSlotActive === 'function'
        ? r.physics.isCarSlotActive(c)
        : false;
      if (isSlotActive && typeof r.physics.removeCar === 'function') {
        r.physics.removeCar(c);
      }
      if (r.arena?.cars?.[c]) {
        r.arena.cars[c].visible = false;
      }
    }
  }
}

export function bindReconcilerSignals(runtime, reconciler) {
  const r = runtime;
  if (!reconciler) return;

  resetRuntimeReconcilerSignalState(r);

  reconciler.onSignals = (signals, packetServerTick = null) => {
    const audio = r.options.gameAudio || gameAudio;
    let currentTick =
      typeof packetServerTick === 'number' && packetServerTick >= 0
        ? packetServerTick
        : reconciler.lastAckedServerTick >= 0
        ? reconciler.lastAckedServerTick
        : 0;

    const hasKickoffStartInBatch = signals.some(
      (s) => s && s.signalType === MATCH_SIGNALS.KICKOFF_START
    );

    // Pre-scan batch: if this packet transitions out of Lobby into Match Prepare / Started / Kickoff,
    // clear Lobby flags immediately so any PLAYER_JOINED / PLAYER_LOADOUT_UPDATED signals in the same
    // batch are processed with full match visibility and physics registration.
    for (const s of signals) {
      if (
        s &&
        (s.signalType === MATCH_SIGNALS.MATCH_PREPARE ||
          s.signalType === MATCH_SIGNALS.MATCH_STARTED ||
          s.signalType === MATCH_SIGNALS.KICKOFF_WILL_START)
      ) {
        if (r.arena && (r.arena.isLobbyMode || r.arena.isHostLobby)) {
          r.arena.isLobbyMode = false;
          r.arena.isHostLobby = false;
        }
        if (reconciler.lobbyDualWorldMode) {
          reconciler.setLobbyDualWorldMode?.(false);
        }
        break;
      }
    }

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
        if (
          sig.signalType !== MATCH_SIGNALS.MATCH_PREPARE &&
          r.physics &&
          typeof r.physics.pushSignalEvent === 'function'
        ) {
          const p1 = Number(sig.param1 || 0) >>> 0;
          const p2 = Number(sig.param2 || 0) >>> 0;
          const wasmFrameIdx = Math.max(0, (r.physics.getReplayFrameCount?.() ?? 0) - 1);
          r.physics.pushSignalEvent(
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
            wasmFrameIdx >>> 0
          );
        }
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

        case MATCH_SIGNALS.MATCH_INITIALIZED: {
          const durationSec = typeof sig.param2 === 'number' && sig.param2 >= 0 ? sig.param2 : 300;
          if (r.match) {
            r.match.state.durationSeconds = durationSec;
          }
          break;
        }

        case MATCH_SIGNALS.MATCH_PREPARE: {
          const matchSeq = sig.param1 || 1;
          dismissHostLobbyOngoingNotification();
          if (r.authoritativeServer) {
            clearRetainedMatchReplayOnMatchStart();
            r._hostMatchReplayNotified = false;
          }
          r._networkTelemetryNotified = false;
          r._overtimeAudioPlayed = false;
          r.networkManager?.despawnDiagnosticTestFleet?.();
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          reconciler.setMatchTelemetryActive?.(true, true);
          reconciler.resetTimelineState?.();
          if (packetServerTick === null) currentTick = 0;
          r.physics?.resetGoalLatch?.();
          r.physics?.clearReplayBuffer?.();
          r.physics?.setReplayRecordingActive?.(true);
          if (r.physics && typeof r.physics.pushSignalEvent === 'function') {
            const p1 = Number(sig.param1 || 0) >>> 0;
            const p2 = Number(sig.param2 || 0) >>> 0;
            r.physics.pushSignalEvent(
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
              0
            );
          }
          r.clientReplayOverflowPaused = false;
          r.physics?.setSimulationFrozen?.(false);
          r.physics?.setUnlimitedBoost?.(false);
          r._clientGoalIncidentLatched = false;
          r.goalReplayCameraOverrideActive = false;
          r.replayTimelineController?.endReplaySession?.();
          r.arena?.resetBallTrail?.();

          if (r.arena) {
            r.arena.isLobbyMode = false;
            r.arena.isHostLobby = false;
          }
          ensureMatchParticipantsInLocalWorld(r, reconciler);
          r.networkManager?.setLobbyGhostMode?.(false, { syncServerLobby: false });
          r._latestServerRosterState = 'match';
          r.interpolator?.sync?.();
          if (r.match) {
            r.match.state.mode = 'match';
            r.match.state.phase = 'prepare';
            r.match.state.paused = false;
            r.match.state.overtime = false;
          }
          r.modeManager?.setMode?.('match');
          useAppStore.getState().setMatchMode('match');
          hudStore.getState().setMatchState({
            matchPhase: 'prepare',
            kickoffCountdown: 0,
            isOvertime: false,
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
          r._networkTelemetryNotified = false;
          r._overtimeAudioPlayed = false;
          r.networkManager?.despawnDiagnosticTestFleet?.();
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          reconciler.setMatchTelemetryActive?.(true, true);
          reconciler.resetTimelineState?.();
          if (packetServerTick === null) currentTick = 0;
          r.physics?.resetGoalLatch?.();
          r.physics?.clearReplayBuffer?.();
          r.physics?.setReplayRecordingActive?.(true);
          r.clientReplayOverflowPaused = false;
          r.physics?.setSimulationFrozen?.(false);
          r.physics?.setUnlimitedBoost?.(false);
          r._clientGoalIncidentLatched = false;
          r.goalReplayCameraOverrideActive = false;
          r.replayTimelineController?.endReplaySession?.();
          if (r.arena) {
            r.arena.isLobbyMode = false;
            r.arena.isHostLobby = false;
          }
          ensureMatchParticipantsInLocalWorld(r, reconciler);
          r.networkManager?.setLobbyGhostMode?.(false, { syncServerLobby: false });
          r._latestServerRosterState = 'match';
          r.interpolator?.sync?.();
          const durationSec = typeof sig.param1 === 'number' && Number.isFinite(sig.param1) && sig.param1 >= 0
            ? sig.param1
            : 300;
          if (r.match) {
            r.match.state.mode = 'match';
            r.match.state.blueScore = 0;
            r.match.state.orangeScore = 0;
            r.match.state.remainingSeconds = durationSec;
            r.match.state.overtime = false;
            r.match.state.overtimeSeconds = 0;
            r.match.state.winner = null;
          }
          r.modeManager?.setMode?.('match');
          useAppStore.getState().setMatchMode('match');
          hudStore.getState().setMatchState({
            blueScore: 0,
            orangeScore: 0,
            remainingSeconds: durationSec,
            isOvertime: false,
            overtimeSeconds: 0,
            winner: null,
            winReason: null
          });
          break;
        }

        case MATCH_SIGNALS.KICKOFF_WILL_START: {
          if (hasKickoffStartInBatch) {
            break;
          }
          const targetFrame = sig.param1;
          const isOvertimeKickoff = sig.param2 === 1 || Boolean(r.match?.state?.overtime);
          const isNewKickoffPhase = isFirstSeenSignalId || r.lastKickoffTargetFrame !== targetFrame;
          if (!isNewKickoffPhase && r.match?.state?.phase === 'playing') {
            break;
          }
          if (isNewKickoffPhase) {
            const wasInReplay = Boolean(
              r.goalReplayCameraOverrideActive ||
              r.replayTimelineController?.isActive ||
              r.match?.state?.phase === 'replay'
            );
            dismissHostLobbyOngoingNotification();
            r.networkManager?.despawnDiagnosticTestFleet?.();
            reconciler.setLobbyDualWorldMode?.(false);
            reconciler.setReplayPlaybackMode?.(false);
            if (!reconciler.isMatchTelemetryActive) {
              reconciler.setMatchTelemetryActive?.(true, false);
            }
            if (!r.clientReplayOverflowPaused) {
              r.physics?.setReplayRecordingActive?.(true);
            }
            r.physics?.resetGoalLatch?.();
            r.physics?.setSimulationFrozen?.(false);
            r.physics?.setUnlimitedBoost?.(false);
            if (r.arena) {
              r.arena.isLobbyMode = false;
              r.arena.isHostLobby = false;
            }
            ensureMatchParticipantsInLocalWorld(r, reconciler);
            r.networkManager?.setLobbyGhostMode?.(false, { syncServerLobby: false });
            r._latestServerRosterState = 'match';
            r.goalReplayCameraOverrideActive = false;
            r.replayTimelineController?.endReplaySession?.();
            r.podiumController?.exitPodium?.();
            const camPos = r.camera?.camera?.position;
            if (wasInReplay || (camPos && (!Number.isFinite(camPos.x) || !Number.isFinite(camPos.y) || !Number.isFinite(camPos.z)))) {
              r.camera?.resetView?.();
            }
            r.interpolator?.sync?.();
            hudStore.getState().setReplayState?.({
              replayPaused: false,
              replayPersistent: false
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
            r.match?.state?.phase === 'kickoff' &&
            typeof r.match.state.countdown === 'number' &&
            r.match.state.countdown >= 1
              ? r.match.state.countdown
              : 3;
          const displaySec = isNewKickoffPhase ? rawDisplaySec : Math.min(prevSec, rawDisplaySec);

          if (isOvertimeKickoff && !r._overtimeAudioPlayed) {
            r._overtimeAudioPlayed = true;
            if (!isSignalAudioMutedInGoalReplay(r)) {
              audio?.play('match_entering_overtime', 1.0, 10000);
            }
          }

          if (r.match) {
            r.match.state.mode = 'match';
            r.match.state.phase = 'kickoff';
            r.match.state.paused = false;
            r.match.state.countdown = displaySec;
            if (isOvertimeKickoff) {
              r.match.state.overtime = true;
            }
          }
          r.modeManager?.setMode?.('match');
          useAppStore.getState().setMatchMode('match');

          hudStore.getState().setMatchState({
            matchPhase: 'kickoff',
            kickoffCountdown: displaySec,
            ...(isOvertimeKickoff ? { isOvertime: true } : {})
          });

          if (r.lastKickoffTargetFrame !== targetFrame || isFirstSeenSignalId) {
            r.lastKickoffTargetFrame = targetFrame;
            r.latchedKickoffSeconds = new Set();
            r.botKickoffStep = 0;
            reconciler.resetTimelineState?.();
          }

          const muteSignalInReplay = isSignalAudioMutedInGoalReplay(r);
          if (remainingTicks <= 360 && remainingTicks > 240 && !r.latchedKickoffSeconds.has(3)) {
            r.latchedKickoffSeconds.add(3);
            if (!muteSignalInReplay) audio?.play('match_countdown_321', 1.0);
          } else if (remainingTicks <= 240 && remainingTicks > 120 && !r.latchedKickoffSeconds.has(2)) {
            r.latchedKickoffSeconds.add(2);
            if (!muteSignalInReplay) audio?.play('match_countdown_321', 1.0);
          } else if (remainingTicks <= 120 && remainingTicks > 0 && !r.latchedKickoffSeconds.has(1)) {
            r.latchedKickoffSeconds.add(1);
            if (!muteSignalInReplay) audio?.play('match_countdown_321', 1.0);
          }
          break;
        }

        case MATCH_SIGNALS.KICKOFF_START: {
          reconciler.setLobbyDualWorldMode?.(false);
          reconciler.setReplayPlaybackMode?.(false);
          if (!reconciler.isMatchTelemetryActive) {
            reconciler.setMatchTelemetryActive?.(true, false);
          }
          if (!r.clientReplayOverflowPaused) {
            r.physics?.setReplayRecordingActive?.(true);
          }
          r.physics?.resetGoalLatch?.();
          r.physics?.setSimulationFrozen?.(false);
          if (r.goalReplayCameraOverrideActive) {
            r.goalReplayCameraOverrideActive = false;
            r.camera?.resetView?.();
          }
          r.replayTimelineController?.endReplaySession?.();
          hudStore.getState().setReplayState?.({
            replayPaused: false,
            replayPersistent: false
          });
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
          if (isNewKickoffStart && !isSignalAudioMutedInGoalReplay(r)) {
            audio?.play('match_start_go', 1.0);
          }
          break;
        }

        case MATCH_SIGNALS.SCORE_UPDATED: {
          const bScore = sig.param1;
          const oScore = sig.param2;
          const isInitialZeroScore = bScore === 0 && oScore === 0;
          const isScoreChange =
            !isInitialZeroScore &&
            (r.match?.state?.blueScore !== bScore || r.match?.state?.orangeScore !== oScore);

          if (!isInitialZeroScore) {
            r.lastKickoffTargetFrame = -1;
            r.latchedKickoffSeconds?.clear?.();
          }

          if (r.match) {
            if (!isInitialZeroScore && r.match.state.phase !== 'replay') {
              r.match.state.phase = 'goal';
            }
            r.match.state.blueScore = bScore;
            r.match.state.orangeScore = oScore;
          }

          hudStore.getState().setMatchState({
            ...(isInitialZeroScore || r.match?.state?.phase === 'replay' ? {} : { matchPhase: 'goal' }),
            blueScore: bScore,
            orangeScore: oScore
          });

          if (isScoreChange && !isSignalAudioMutedInGoalReplay(r)) {
            audio?.play('sfx_goal_poof', 1.0);
          }
          break;
        }

        case MATCH_SIGNALS.GOAL_REPLAY_WILL_START: {
          r._localSkipReplayReady = false;
          r.lastKickoffTargetFrame = -1;
          r.latchedKickoffSeconds?.clear?.();
          const rawParam1 = sig.param1 ?? 0;
          const scoringTeam = rawParam1 & 0x1;
          const scorerCarIdx = (rawParam1 >>> 8) & 0xff;
          const speedKph = (rawParam1 >>> 16) & 0xffff;
          const scorerName = resolveParticipantDisplayName(r, scorerCarIdx, scoringTeam);
          if (r.match) {
            if (r.match.state.phase !== 'replay') {
              r.match.state.phase = 'goal';
            }
            r.match.state.scorer = scoringTeam;
            r.match.state.scorerCarIndex = scorerCarIdx;
          }
          hudStore.getState().setMatchState({
            ...(r.match?.state?.phase === 'replay' ? {} : { matchPhase: 'goal' }),
            replayScorerName: scorerName,
            replayScorerTeam: scoringTeam,
            replayBallSpeedKph: speedKph > 0 ? speedKph : 100
          });
          break;
        }

        case MATCH_SIGNALS.GOAL_REPLAY_START: {
          r._localSkipReplayReady = false;
          r.lastKickoffTargetFrame = -1;
          r.latchedKickoffSeconds?.clear?.();
          audio?.resetIncidentDebounceState?.();
          reconciler.setReplayPlaybackMode?.(true);
          if (!r.clientReplayOverflowPaused) {
            r.physics?.setReplayRecordingActive?.(true);
          }
          r.physics?.resetGoalLatch?.();
          const replayTicks = sig.param1 > 0 ? sig.param1 : 360;
          const rawMeta = sig.param2 ?? 0;
          const scoringTeam = rawMeta > 0 ? (rawMeta & 0x1) : (r.match?.state?.scorer ?? 0);
          const scorerCarIdx = rawMeta > 0 ? ((rawMeta >>> 1) & 0xff) : (r.match?.state?.scorerCarIndex ?? 0);
          const speedKph = (rawMeta >>> 16) & 0xffff;
          const scorerName = resolveParticipantDisplayName(r, scorerCarIdx, scoringTeam);
          if (r.match) {
            r.match.state.phase = 'replay';
            r.match.state.scorer = scoringTeam;
            r.match.state.scorerCarIndex = scorerCarIdx;
          }
          r.replayTimelineController?.beginReplaySession?.({
            durationTicks: replayTicks,
            scoringTeam,
            scorerCarIndex: scorerCarIdx,
            isNetworkStreamed: true
          });
          hudStore.getState().setMatchState({
            matchPhase: 'replay',
            choreographySignal: 'goal-replay-started',
            replayScorerName: scorerName,
            replayScorerTeam: scoringTeam,
            ...(speedKph > 0 ? { replayBallSpeedKph: speedKph } : {})
          });
          hudStore.getState().setReplayState?.({
            replayCameraMode: 'director',
            replayScorerName: scorerName,
            replayScorerTeam: scoringTeam,
            ...(speedKph > 0 ? { replayBallSpeedKph: speedKph } : {})
          });
          break;
        }

        case MATCH_SIGNALS.GOAL_REPLAY_WILL_END: {
          r.physics?.resetGoalLatch?.();
          hudStore.getState().setChoreographySignal?.('goal-replay-will-end');
          break;
        }

        case MATCH_SIGNALS.GOAL_REPLAY_END:
        case MATCH_SIGNALS.ROUND_STARTED: {
          r._localSkipReplayReady = false;
          reconciler.setReplayPlaybackMode?.(false);
          if (!r.clientReplayOverflowPaused) {
            r.physics?.setReplayRecordingActive?.(true);
          }
          r.physics?.resetGoalLatch?.();
          r.physics?.setSimulationFrozen?.(false);
          r.goalReplayCameraOverrideActive = false;
          r.replayTimelineController?.endReplaySession?.();
          r.camera?.resetView?.();
          r.interpolator?.sync?.();
          if (r.match && r.match.state.phase === 'replay') {
            r.match.state.phase = 'kickoff';
          }
          hudStore.getState().setReplayState?.({
            replayPaused: false,
            replayPersistent: false
          });
          break;
        }

        case MATCH_SIGNALS.FLIP_RESET_GAINED: {
          if (isFirstSeenSignalId) {
            const targetCarIdx = typeof sig.param1 === 'number' && sig.param1 >= 0 ? sig.param1 : r.playerCarIndex;
            const resetSubType = typeof sig.param2 === 'number' && sig.param2 > 0 ? sig.param2 : FLIP_RESET_SUBTYPES.BALL;
            if (resetSubType === FLIP_RESET_SUBTYPES.BALL) {
              const cv = r.physics?.getCarStateView?.(targetCarIdx);
              const st = r.simulationStage?._getCarActionState?.(targetCarIdx);
              const nowMs = performance.now();
              if (!st || (nowMs - (st.lastFlipResetTimeMs || 0)) >= 450) {
                if (st) {
                  st.hasAirJumped = false;
                  st.jumpReleasedSinceSingleJump = true;
                  st.lastFlipResetTick = sig.frameId || 0;
                  st.lastFlipResetTimeMs = nowMs;
                }
                const visual = r.getFlipResetVisual?.(targetCarIdx);
                if (visual) {
                  visual.play();
                }
                audio?.handleEvent?.({
                  type: 0x0F,
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
                  tick: sig.frameId || 0
                }, r.camera);
              }
            }
          }
          break;
        }

        case MATCH_SIGNALS.BALL_RESET: {
          r.physics?.resetGoalLatch?.();
          r.arena?.resetBallTrail?.();
          r.goalReplayCameraOverrideActive = false;
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
          r._localSkipReplayReady = false;
          reconciler.setMatchTelemetryActive?.(false, false);
          reconciler.setKickoffMaskUntilTick?.(-1);
          r.goalReplayCameraOverrideActive = false;
          r.replayTimelineController?.endReplaySession?.();
          r.podiumController?.exitPodium?.();
          resetRuntimeReconcilerSignalState(r);
          break;
        }

        case MATCH_SIGNALS.MATCH_ENDED:
        case MATCH_SIGNALS.PODIUM_START: {
          if (r.arena?.isLobbyMode || r.match?.state?.phase === 'lobby' || reconciler.lobbyDualWorldMode) {
            break;
          }
          r._localSkipReplayReady = false;
          const winningTeam = sig.param1;
          const winReasonCode = sig.param2 || 0;
          const winnerName = winningTeam === 0 ? 'BLUE' : (winningTeam === 1 ? 'ORANGE' : 'DRAW');
          const winReason = WIN_REASON_LABELS[winReasonCode] || 'SCORE';
          const isPodiumStart = sig.signalType === MATCH_SIGNALS.PODIUM_START;
          const targetPhase = isPodiumStart ? 'podium' : 'ended';
          const wasNotEnded = r.match?.state?.phase !== 'ended' && r.match?.state?.phase !== 'podium';

          reconciler.setReplayPlaybackMode?.(false);
          reconciler.setKickoffMaskUntilTick?.(-1);
          r.goalReplayCameraOverrideActive = false;
          r.replayTimelineController?.endReplaySession?.();
          if (isPodiumStart) {
            reconciler.setMatchTelemetryActive?.(false, false);
            r.podiumController?.enterPodium?.(winningTeam, winReason);
          }

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
            const fallbackRoster = r.authoritativeServer?.lastRoomState?.roster?.players || [];
            if (typeof r.authoritativeServer.requestFullReplayExport === 'function') {
              r.authoritativeServer.requestFullReplayExport().then((exportData) => {
                const exportedRoster = Array.isArray(exportData?.loadouts)
                  ? exportData.loadouts
                  : Array.isArray(exportData?.roster?.players)
                    ? exportData.roster.players
                    : Array.isArray(exportData?.roster)
                      ? exportData.roster
                      : fallbackRoster;
                retainCompletedMatchReplayAndNotify({
                  stateInputBytes: exportData?.stateInputBytes || null,
                  incidentBytes: exportData?.incidentBytes || null,
                  signalBytes: exportData?.signalBytes || null,
                  frameCount: exportData?.frameCount || 0,
                  ringBuffer: r.authoritativeServer?.hostReplayRingBuffer || r.physics?.replayRingBuffer,
                  fallbackState: r.authoritativeServer?.cachedSnapshot || r.physics?.state,
                  modeLabel: 'Host Match',
                  gameMode: exportData?.gameMode || '3v3',
                  durationSeconds: exportData?.durationSeconds ?? r.match?.state?.durationSeconds ?? 300,
                  roster: exportedRoster,
                  loadouts: exportedRoster,
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
                  durationSeconds: r.match?.state?.durationSeconds ?? 300,
                  roster: fallbackRoster,
                  loadouts: fallbackRoster,
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
                durationSeconds: r.match?.state?.durationSeconds ?? 300,
                roster: fallbackRoster,
                loadouts: fallbackRoster,
                blueScore,
                orangeScore,
                winnerTeam: winningTeam,
                winReason
              });
            }
          }

          if (!r._networkTelemetryNotified) {
            r._networkTelemetryNotified = true;
            notifyNetworkTelemetryExportAvailable('match-complete', reconciler.telemetryRecorder);
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
