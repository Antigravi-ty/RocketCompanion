/**
 * MatchLifecycleStepRunner.js
 * Authoritative 120Hz match phase progression, goal celebration, replay slice playback,
 * clock/overtime/possession evaluation, and global frame packet encoding.
 * Extracted from MatchSessionAdmin.js to keep module size < 400 lines.
 */

import { MATCH_SIGNALS, GlobalPayloadCodec } from '../../protocol/GlobalPayloadCodec.js';
import { FLIP_RESET_SUBTYPES, isBallFlipResetEvent } from '../../../physics/RocketSimConstants.js';
import { MATCH_STATES } from './MatchRosterCoordinator.js';
import { ReplayTimelineController } from '../../../replay/ReplayTimelineCore.js';
import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.js';
import {
  interpolateReplaySnapshots,
  encodeReplayDirectorTelemetryIntoState,
} from '../../../replay/ReplayFrameInterpolator.js';
import {
  ExperimentalBotAgent,
  ensureExperimentalEngine,
  DEFAULT_CAR_CONTROLS,
} from '../../../ai/experimental/ExperimentalBotAgent.js';

export const MATCH_TICK_RATE = 120;
export const DEFAULT_MATCH_DURATION_SECONDS = 300;
export const KICKOFF_COUNTDOWN_SECONDS = 3;
export const KICKOFF_TOTAL_TICKS = 480; // 4.0s @ 120Hz (1s buffer + 3s countdown)
export const GOAL_CELEBRATION_TICKS = 360; // 3.0s @ 120Hz
export const GOAL_REPLAY_DURATION_TICKS = 360; // 3.0s @ 120Hz
export const PAUSE_RESUME_COUNTDOWN_TICKS = 600; // 5.0s @ 120Hz
export const DEFAULT_MAX_OVERTIME_SECONDS = 360; // 6 min clock (~7 min wall time with kickoff) before possession tie-breaker

export function applyPendingHitboxSwaps(admin) {
  if (!admin.physicsManager) return;
  for (const p of admin.players.values()) {
    if (p.pendingVisualId && p.entityId >= 0) {
      admin.physicsManager.applySignal('HOTSWAP_HITBOX', {
        carIndex: p.entityId,
        hitboxType: p.pendingVisualId
      });
      p.pendingVisualId = null;
    }
  }
}

export function resolvePossessionWinner(admin) {
  const stats = admin.physicsManager?.getPossessionStats?.();
  if (stats) {
    const blueVal = stats.bluePoints ?? stats.blueFrames ?? 0;
    const orangeVal = stats.orangePoints ?? stats.orangeFrames ?? 0;
    if (blueVal > orangeVal) return 0;
    if (orangeVal > blueVal) return 1;
    if (stats.team === 1) return 0;
    if (stats.team === 2) return 1;
  }
  return 0; // Default Blue tie-break if strictly 0-0 identical possession
}

export function beginMatchGoalReplay(admin) {
  if (admin.isTrainingMode) {
    admin.resetTrainingPlay();
    return;
  }
  if (admin.skipReplayByDefault) {
    admin.finishGoalReplay();
    return;
  }
  admin.state = MATCH_STATES.REPLAY;
  admin.activeSignals?.delete?.(MATCH_SIGNALS.KICKOFF_WILL_START);
  admin.activeSignals?.delete?.(MATCH_SIGNALS.KICKOFF_START);
  admin.activeSignals?.delete?.(MATCH_SIGNALS.TIME_ALERT_60S);
  admin.activeSignals?.delete?.(MATCH_SIGNALS.TIME_ALERT_30S);
  admin.activeSignals?.delete?.(MATCH_SIGNALS.COUNTDOWN_10S);
  admin.activeSignals?.delete?.(MATCH_SIGNALS.SCORE_UPDATED);
  admin.activeSignals?.delete?.(MATCH_SIGNALS.GOAL_REPLAY_WILL_START);
  admin._activeReplayFrames = extractGoalReplayFrames({
    ringBuffer: admin.replayBuffer,
    engine: admin.physicsManager?.sim || null,
    durationTicks: GOAL_REPLAY_DURATION_TICKS,
    goalIncidentTick: admin.lastGoalIncidentFrame >= 0 ? admin.lastGoalIncidentFrame : null,
    scorerTouchTick: admin.lastScorerTouchFrame >= 0 ? admin.lastScorerTouchFrame : null,
    lookbackSeconds: admin.goalReplayLookbackSeconds ?? 10.0,
    postGoalSeconds: admin.goalReplayPostGoalSeconds ?? 3.0,
    lastKickoffWillStartTick: admin.lastKickoffWillStartFrame ?? -1,
    signalLog: admin.replaySignalLog
  });

  if (!admin._replayController) {
    admin._replayController = new ReplayTimelineController({
      ringBuffer: admin.replayBuffer,
    });
  }
  if (admin._activeReplayFrames.length > 0) {
    admin._replayController.beginReplaySession({
      frames: admin._activeReplayFrames,
      scoringTeam: admin.lastScoringTeam ?? 0,
      scorerCarIndex: admin.lastScorerCarIndex ?? 0,
      carTeamResolver: (carIdx) => {
        for (const p of admin.players.values()) {
          if (p.entityId === carIdx) return p.team ?? (carIdx % 2);
        }
        return carIdx % 2;
      },
    });
    // Integrate dramatic slow-motion curve when enabled to determine authoritative replay tick budget
    if (admin.enableDramaticReplaySlowMo !== false && admin._activeReplayFrames.length > 1) {
      let simCursor = 0;
      let estTicks = 0;
      const maxIndex = admin._activeReplayFrames.length - 1;
      while (simCursor < maxIndex && estTicks < maxIndex * 3) {
        const factor = admin._replayController.computeDramaticSlowMoFactor(simCursor);
        simCursor += Math.max(0.1, factor);
        estTicks++;
      }
      admin.replayTicksRemaining = Math.max(admin._activeReplayFrames.length, estTicks);
    } else {
      admin.replayTicksRemaining = admin._activeReplayFrames.length;
    }
  } else {
    admin.replayTicksRemaining = GOAL_REPLAY_DURATION_TICKS;
  }
  admin._activeReplayCursor = 0;

  if (admin.physicsManager) {
    admin.physicsManager.applySignal(MATCH_SIGNALS.GOAL_REPLAY_START);
  }
  const replayStartMeta =
    ((admin.lastScoringTeam ?? 0) & 0x1) |
    (((admin.lastScorerCarIndex ?? 0) & 0xff) << 1) |
    (((admin.lastGoalBallSpeedKph ?? 100) & 0xffff) << 16);
  admin.dispatchSignal(
    MATCH_SIGNALS.GOAL_REPLAY_START,
    admin.matchTick,
    admin.replayTicksRemaining,
    replayStartMeta
  );
}

export function finishMatchGoalReplay(admin) {
  admin._replayController?.endReplaySession?.();
  admin._activeReplayFrames = null;
  admin._activeReplayCursor = 0;
  if (admin.isTrainingMode) {
    admin.resetTrainingPlay();
    return;
  }
  if (admin.physicsManager) {
    admin.physicsManager.applySignal(MATCH_SIGNALS.GOAL_REPLAY_END);
  }
  admin.dispatchSignal(MATCH_SIGNALS.GOAL_REPLAY_END, admin.matchTick, 0, 0);
  if (admin.pendingMatchEndAfterGoal) {
    const w = admin.pendingMatchWinner ?? (admin.blueScore > admin.orangeScore ? 0 : 1);
    admin.pendingMatchEndAfterGoal = false;
    admin.endMatch(w, 0);
    return;
  }
  admin.dispatchSignal(MATCH_SIGNALS.ROUND_STARTED, admin.matchTick, (admin.blueScore + admin.orangeScore + 1), 0);
  admin.startKickoffSequence(KICKOFF_TOTAL_TICKS);
}

function stepServerFilledBots(admin) {
  if (admin.externalBotTunnels) {
    // When externalBotTunnels is enabled (e.g. AuthoritativeServerWorker + BotInferenceWorker),
    // bots push standard InputPacketCodec frames into PhysicsEngineManager.inputBuffer via virtual channels.
    // Ensure directControls does not shadow inputBuffer when queued frames exist, and hold last/neutral
    // controls when inputBuffer is empty (e.g. during kickoff countdown or worker round-trip gap).
    if (admin.physicsManager?.directControls instanceof Map) {
      for (const p of admin.players.values()) {
        if (p?.isBot && typeof p.entityId === 'number' && p.entityId >= 0) {
          if (admin.physicsManager.getInputBufferSize(p.entityId) > 0) {
            admin.physicsManager.directControls.delete(p.entityId);
          } else {
            const last = admin.physicsManager.lastAcknowledgedControls?.get(p.entityId);
            admin.physicsManager.directControls.set(
              p.entityId,
              admin.state === MATCH_STATES.PLAYING && last ? { ...last } : { ...DEFAULT_CAR_CONTROLS }
            );
          }
        }
      }
    }
    return;
  }

  const sim = admin.physicsManager?.sim;
  if (!sim || !sim.state || typeof sim.getBallStateView !== 'function' || typeof sim.getCarStateView !== 'function') return;
  const ball = sim.getBallStateView();
  if (!ball) return;

  if (!(admin._serverBotAgents instanceof Map)) {
    admin._serverBotAgents = new Map();
  }

  // Prune agents for removed bot sessions
  for (const sid of Array.from(admin._serverBotAgents.keys())) {
    if (!admin.players.has(sid)) {
      admin._serverBotAgents.delete(sid);
    }
  }

  const activeCars = [];
  for (const p of admin.players.values()) {
    if (typeof p.entityId === 'number' && p.entityId >= 0 && p.entityId < 8) {
      activeCars.push({
        carIndex: p.entityId,
        team: p.team === 1 ? 1 : p.team === 0 ? 0 : p.entityId % 2,
      });
    }
  }

  const closestCarPerTeam = { 0: -1, 1: -1 };
  const closestDistPerTeam = { 0: Infinity, 1: Infinity };
  if (admin.state === MATCH_STATES.PLAYING) {
    for (let i = 0; i < activeCars.length; i++) {
      const entry = activeCars[i];
      const cv = sim.getCarStateView(entry.carIndex);
      if (!cv || cv.isDemoed) continue;
      const d = Math.hypot(cv.posX - ball.posX, cv.posY - ball.posY);
      if (d < closestDistPerTeam[entry.team]) {
        closestDistPerTeam[entry.team] = d;
        closestCarPerTeam[entry.team] = entry.carIndex;
      }
    }
  }

  const pads = typeof sim.getPads === 'function' ? sim.getPads() : [];

  for (const [sid, p] of admin.players.entries()) {
    if (!p.isBot || typeof p.entityId !== 'number' || p.entityId < 0) continue;
    if (admin.physicsManager.getInputBufferSize(p.entityId) > 0) {
      admin.physicsManager.directControls?.delete?.(p.entityId);
      continue;
    }
    const team = p.team === 1 ? 1 : p.team === 0 ? 0 : p.entityId % 2;
    const botType = p.botType || 'nexto';

    let record = admin._serverBotAgents.get(sid);
    if (!record) {
      const agent = new ExperimentalBotAgent(botType, p.entityId, team);
      ensureExperimentalEngine(botType);
      record = { agent, kickoffStep: 0, staggered: false };
      admin._serverBotAgents.set(sid, record);
    } else {
      record.agent.carIndex = p.entityId;
      record.agent.team = team;
      if (record.agent.botType !== botType) {
        record.agent.setBotType(botType);
      }
    }

    if (admin.state !== MATCH_STATES.PLAYING) {
      record.kickoffStep = 0;
      record.staggered = false;
      record.agent.reset();
      admin.physicsManager.setDirectCarControls(p.entityId, DEFAULT_CAR_CONTROLS);
      continue;
    }

    const isPrimaryKickoffCar = closestCarPerTeam[team] === p.entityId;
    const ko = record.agent.getKickoffControls(sim.state, record.kickoffStep, isPrimaryKickoffCar);
    let ctrl;
    if (ko) {
      ctrl = ko;
      record.agent.overrideControls(ko);
    } else if (record.agent.tickSkipCounter <= 0) {
      ctrl = record.agent.decideSync(sim.state, pads, activeCars);
      record.agent.tickSkipCounter = record.staggered
        ? record.agent.tickSkip - 1
        : (p.entityId % record.agent.tickSkip) + 1;
      record.staggered = true;
    } else {
      record.agent.tickSkipCounter--;
      ctrl = record.agent.action;
    }

    record.kickoffStep++;
    admin.physicsManager.setDirectCarControls(p.entityId, ctrl || DEFAULT_CAR_CONTROLS);
  }
}

function buildReplaySkipAckControls(admin) {
  const ackList = [];
  for (const [sid, p] of admin.players.entries()) {
    if (!p || p.role === 'spectator' || typeof p.entityId !== 'number' || p.entityId < 0) continue;
    const isSkipReady = Boolean(p.isBot || admin.skipReplayVotes?.has(sid));
    ackList.push({
      carIndex: p.entityId,
      controls: {
        ...DEFAULT_CAR_CONTROLS,
        jump: isSkipReady,
      },
    });
  }
  return ackList;
}

export function stepMatchSessionFrame(admin) {
  if (admin.state === MATCH_STATES.ENDED || admin.state === MATCH_STATES.PODIUM) {
    if (admin.state === MATCH_STATES.ENDED) {
      if (typeof admin.podiumDelayTicks === 'number' && admin.podiumDelayTicks > 0) {
        admin.podiumDelayTicks--;
        if (admin.podiumDelayTicks <= 0) {
          admin.enterPodiumPhase?.();
        }
      } else {
        admin.enterPodiumPhase?.();
      }
    }
    let podiumSnapshot = null;
    if (admin.physicsManager && !admin.physicsManager.isPaused) {
      podiumSnapshot = admin.physicsManager.stepAuthoritativeTick();
      admin.matchTick = podiumSnapshot.tick;
    } else {
      admin.matchTick++;
    }
    if (admin.sessionManager?.signalBuffer) {
      admin.sessionManager.signalBuffer.pruneExpired(admin.matchTick, admin.sessionManager.sessions?.keys?.());
    }
    if (podiumSnapshot || admin.activeSignals.size > 0 || (admin.sessionManager?.signalBuffer?.entries?.size || 0) > 0) {
      return encodeMatchFramePacket(admin, podiumSnapshot);
    }
    return new Uint8Array(0);
  }

  if (admin.state === MATCH_STATES.PREPARE) {
    if (admin.physicsManager) {
      admin.matchTick = admin.physicsManager.currentTick;
    } else {
      admin.matchTick++;
    }
    admin.prepareTimeoutTicks--;
    if (admin.prepareTimeoutTicks <= 0) {
      admin.startMatch(admin.clockDuration);
    } else {
      return encodeMatchFramePacket(admin, null);
    }
  }

  if (admin.state === MATCH_STATES.COUNTDOWN) {
    if (admin.physicsManager) {
      admin.matchTick = admin.physicsManager.currentTick;
    } else {
      admin.matchTick++;
    }
    admin.startCountdownTicks--;
    if (admin.startCountdownTicks <= 0) {
      admin.initiateMatchPrepare(admin.clockDuration, 120);
    }
    return encodeMatchFramePacket(admin, null);
  }

  if (admin.state === MATCH_STATES.LOBBY) {
    if (admin.lobbyPhysicsActive && admin.physicsManager) {
      if (admin.physicsManager.inputBuffer && !admin.physicsManager.inputBuffer.lobbyMode) {
        admin.physicsManager.inputBuffer.setLobbyMode(true);
      }
      if (admin.diagnosticsController?.enabled) {
        admin.diagnosticsController.applyToAuthority(admin.physicsManager, admin.physicsManager.currentTick);
      }
      const lobbySnapshot = admin.physicsManager.stepAuthoritativeTick();
      admin.matchTick = lobbySnapshot.tick;
      if (lobbySnapshot.goalScored) {
        admin.physicsManager.resetBallToCenter();
      }
      return encodeMatchFramePacket(admin, lobbySnapshot);
    }
    if (admin.activeSignals.size > 0) {
      return encodeMatchFramePacket(admin, null);
    }
    return new Uint8Array(0);
  }

  if (admin.state === MATCH_STATES.PAUSED && admin.willResumeUntilTick > 0) {
    admin.matchTick++;
    if (admin.matchTick >= admin.willResumeUntilTick) {
      admin.setPaused(false);
    }
    return encodeMatchFramePacket(admin, null);
  }

  if (admin.state === MATCH_STATES.GOAL_SCORED) {
    admin.goalBufferTicks--;
    if (admin.goalBufferTicks <= 0) {
      if (admin.isTrainingMode) {
        admin.resetTrainingPlay();
      } else {
        admin.beginGoalReplay();
      }
    }
  }

  if (admin.state === MATCH_STATES.REPLAY) {
    admin.replayTicksRemaining--;
    let replayPhysicsSnapshot = null;
    const replayAckControls = buildReplaySkipAckControls(admin);
    const replayFrames = admin._replayController?.frames || admin._replayController?.activeFrames;
    if (admin._replayController && admin._replayController.isActive && Array.isArray(replayFrames) && replayFrames.length > 0) {
      const useSlowMo = admin.enableDramaticReplaySlowMo !== false;
      const stepRes = admin._replayController.stepPlayback(1 / MATCH_TICK_RATE, null, useSlowMo);
      admin._activeReplayCursor = stepRes.frameIndex;
      const currSnap = stepRes.frame?.snapshot || stepRes.frame;
      const prevSnap = stepRes.prevFrame?.snapshot || stepRes.prevFrame || currSnap;
      if (currSnap) {
        const blendedSnap = interpolateReplaySnapshots(
          prevSnap,
          currSnap,
          stepRes.alpha,
          admin._replayInterpolatedBuffer || null
        );
        admin._replayInterpolatedBuffer = blendedSnap;
        encodeReplayDirectorTelemetryIntoState(
          blendedSnap,
          admin._replayController.directorCameraState,
          stepRes.progress
        );
        replayPhysicsSnapshot = {
          tick: admin.matchTick,
          activeCarMask: admin.physicsManager?.getActiveCarMask?.() || 0,
          stateSnapshot: blendedSnap,
          acknowledgedControls: replayAckControls,
          isReplaySlice: true
        };
      }
    } else if (Array.isArray(admin._activeReplayFrames) && admin._activeReplayCursor < admin._activeReplayFrames.length) {
      const slot = admin._activeReplayFrames[admin._activeReplayCursor++];
      if (slot && slot.snapshot) {
        replayPhysicsSnapshot = {
          tick: admin.matchTick,
          activeCarMask: admin.physicsManager?.getActiveCarMask?.() || 0,
          stateSnapshot: slot.snapshot,
          acknowledgedControls: replayAckControls,
          isReplaySlice: true
        };
      }
    }
    if (admin.replayTicksRemaining === 60) {
      admin.dispatchSignal(MATCH_SIGNALS.GOAL_REPLAY_WILL_END, admin.matchTick, 60, 0);
    }
    if (admin.replayTicksRemaining > 0) {
      return encodeMatchFramePacket(admin, replayPhysicsSnapshot);
    }
    admin.finishGoalReplay();
  }

  let physicsSnapshot = null;
  if (admin.physicsManager) {
    stepServerFilledBots(admin);
    physicsSnapshot = admin.physicsManager.stepAuthoritativeTick();
    admin.matchTick = physicsSnapshot.tick;

    // Broadcast authoritative FLIP_RESET_GAINED (0x0F) incident when native Bullet raycast confirms ball detachment
    if (Array.isArray(physicsSnapshot.incidents) && physicsSnapshot.incidents.length > 0) {
      for (let i = 0; i < physicsSnapshot.incidents.length; i++) {
        const inc = physicsSnapshot.incidents[i];
        if (!inc || inc.type !== 0x0F) continue;
        if (!isBallFlipResetEvent(inc)) continue;
        const carIdx = typeof inc.carIndex === 'number' && inc.carIndex >= 0 ? inc.carIndex : (inc.primaryId ?? 0);
        admin.dispatchSignal(
          0x0F,
          admin.matchTick,
          carIdx,
          inc.subType || FLIP_RESET_SUBTYPES.BALL
        );
      }
    }

    if (physicsSnapshot.goalScored && admin.state === MATCH_STATES.PLAYING) {
      const scoringTeam = physicsSnapshot.goalTeam ?? physicsSnapshot.scoringTeam ?? 0;
      const bv = admin.physicsManager?.sim?.getBallStateView?.();
      const ballSpeedKph = bv
        ? Math.max(1, Math.round(Math.hypot(bv.velX, bv.velY, bv.velZ) * 0.036))
        : 100;
      admin.lastGoalIncidentFrame = admin.matchTick;
      admin.lastScoringTeam = scoringTeam;
      admin.lastScorerCarIndex = physicsSnapshot.scorerCarIndex ?? 0;
      admin.lastScorerTouchFrame = physicsSnapshot.scorerTouchTick ?? -1;
      admin.lastGoalBallSpeedKph = ballSpeedKph;
      admin.activeSignals?.delete?.(MATCH_SIGNALS.KICKOFF_WILL_START);
      admin.activeSignals?.delete?.(MATCH_SIGNALS.KICKOFF_START);
      admin.activeSignals?.delete?.(MATCH_SIGNALS.TIME_ALERT_60S);
      admin.activeSignals?.delete?.(MATCH_SIGNALS.TIME_ALERT_30S);
      admin.activeSignals?.delete?.(MATCH_SIGNALS.COUNTDOWN_10S);
      if (admin.isTrainingMode) {
        admin.state = MATCH_STATES.GOAL_SCORED;
        admin.goalBufferTicks = 120;
        admin.physicsManager.setInputMask(false);
      } else {
        const celebrationTicks = Math.max(1, Math.round((admin.goalReplayPostGoalSeconds ?? 3.0) * 120));
        if (scoringTeam === 0) {
          admin.blueScore++;
        } else {
          admin.orangeScore++;
        }
        admin.dispatchSignal(MATCH_SIGNALS.SCORE_UPDATED, admin.matchTick, admin.blueScore, admin.orangeScore);
        if (!admin.skipReplayByDefault) {
          const goalMetaParam1 =
            (scoringTeam & 0x1) |
            (((admin.lastScorerCarIndex ?? 0) & 0xff) << 8) |
            ((ballSpeedKph & 0xffff) << 16);
          admin.dispatchSignal(
            MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
            admin.matchTick,
            goalMetaParam1,
            admin.matchTick + celebrationTicks
          );
        }

        if (admin.isOvertime) {
          admin.state = MATCH_STATES.GOAL_SCORED;
          admin.goalBufferTicks = celebrationTicks;
          admin.pendingMatchEndAfterGoal = true;
          admin.pendingMatchWinner = scoringTeam;
        } else if (admin.clockSecondsRemaining === 0) {
          if (admin.blueScore === admin.orangeScore) {
            admin.pendingOvertimeAfterGoal = true;
            admin.state = MATCH_STATES.GOAL_SCORED;
            admin.goalBufferTicks = celebrationTicks;
          } else {
            admin.state = MATCH_STATES.GOAL_SCORED;
            admin.goalBufferTicks = celebrationTicks;
            admin.pendingMatchEndAfterGoal = true;
            admin.pendingMatchWinner = admin.blueScore > admin.orangeScore ? 0 : 1;
          }
        } else {
          admin.state = MATCH_STATES.GOAL_SCORED;
          admin.goalBufferTicks = celebrationTicks;
        }
      }
    }
  } else {
    admin.matchTick++;
  }

  if (admin.state === MATCH_STATES.KICKOFF) {
    if (admin.matchTick >= admin.kickoffWillStartAt && admin.kickoffWillStartAt > 0) {
      admin.state = MATCH_STATES.PLAYING;
      admin.kickoffStartedAtTick = admin.matchTick;
      admin.activeSignals.delete(MATCH_SIGNALS.KICKOFF_WILL_START);
      admin.dispatchSignal(MATCH_SIGNALS.KICKOFF_START, admin.matchTick);
      if (admin.physicsManager) {
        admin.physicsManager.applySignal(MATCH_SIGNALS.KICKOFF_START);
      }
      admin.kickoffWillStartAt = -1;
    }
  }

  if (admin.state === MATCH_STATES.PLAYING && !admin.clockStarted) {
    if (
      !admin.physicsManager ||
      physicsSnapshot?.kickoffTouched ||
      (admin.kickoffStartedAtTick >= 0 && admin.matchTick - admin.kickoffStartedAtTick >= 600)
    ) {
      admin.clockStarted = true;
    }
  }

  if (admin.state === MATCH_STATES.PLAYING && admin.clockStarted && (admin.matchTick % 120 === 0)) {
    if (admin.isTrainingMode) {
      admin.clockDirection = 'up';
      admin.trainingSeconds = (admin.trainingSeconds || 0) + 1;
      admin.dispatchSignal(
        MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
        admin.matchTick,
        admin.trainingSeconds,
        2
      );
    } else if (!admin.isOvertime && admin.clockDirection !== 'up') {
      admin.clockDirection = 'down';
      if (admin.clockSecondsRemaining > 0) {
        admin.clockSecondsRemaining--;
        admin.dispatchSignal(
          MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
          admin.matchTick,
          admin.clockSecondsRemaining,
          0
        );
        if (admin.clockSecondsRemaining === 60) {
          admin.dispatchSignal(MATCH_SIGNALS.TIME_ALERT_60S, admin.matchTick, 60, 0);
        } else if (admin.clockSecondsRemaining === 30) {
          admin.dispatchSignal(MATCH_SIGNALS.TIME_ALERT_30S, admin.matchTick, 30, 0);
        } else if (admin.clockSecondsRemaining <= 10 && admin.clockSecondsRemaining >= 1) {
          admin.dispatchSignal(MATCH_SIGNALS.COUNTDOWN_10S, admin.matchTick, admin.clockSecondsRemaining, 0);
        }
      }
    } else {
      admin.clockDirection = 'up';
      admin.overtimeSeconds++;
      admin.dispatchSignal(
        MATCH_SIGNALS.CLOCK_UPDATED_SECONDS,
        admin.matchTick,
        admin.overtimeSeconds,
        1
      );
      if (admin.maxOvertimeSeconds > 0 && admin.overtimeSeconds >= admin.maxOvertimeSeconds) {
        const possessionWinner = admin.resolvePossessionWinner();
        admin.endMatch(possessionWinner, 1);
      }
    }
  }

  if (!admin.isTrainingMode && admin.state === MATCH_STATES.PLAYING && !admin.isOvertime && admin.clockSecondsRemaining === 0) {
    const ballLanded = admin.physicsManager ? admin.physicsManager.isBallOnGround() : true;
    if (ballLanded) {
      if (admin.blueScore === admin.orangeScore) {
        admin.pendingOvertimeAfterGoal = true;
        admin.startKickoffSequence(KICKOFF_TOTAL_TICKS);
        if (physicsSnapshot && admin.physicsManager?.sim) {
          const sim = admin.physicsManager.sim;
          if (typeof sim.saveCompactState === 'function') {
            physicsSnapshot.stateSnapshot = sim.saveCompactState();
          } else if (typeof sim.saveState === 'function') {
            physicsSnapshot.stateSnapshot = sim.saveState();
          }
        }
      } else {
        admin.endMatch(null, 0);
      }
    }
  }

  return encodeMatchFramePacket(admin, physicsSnapshot);
}

export function encodeMatchFramePacket(admin, physicsSnapshot) {
  const isReplayOrPaused =
    admin.state === MATCH_STATES.REPLAY ||
    Boolean(physicsSnapshot?.isReplaySlice) ||
    (admin.state === MATCH_STATES.PAUSED && (!admin._currentFrameSignals || admin._currentFrameSignals.length === 0));

  if (
    admin.replayBuffer &&
    !isReplayOrPaused &&
    (physicsSnapshot || (admin._currentFrameSignals && admin._currentFrameSignals.length > 0))
  ) {
    admin.replayBuffer.recordFrame(
      admin.matchTick,
      physicsSnapshot ? physicsSnapshot.stateSnapshot : null,
      admin._currentFrameSignals,
      null,
      physicsSnapshot ? physicsSnapshot.incidents : null,
      physicsSnapshot ? physicsSnapshot.acknowledgedControls : null
    );
    admin._currentFrameSignals.length = 0;
  } else if (admin._currentFrameSignals && admin._currentFrameSignals.length > 0) {
    admin._currentFrameSignals.length = 0;
  }

  let allUserRttData = null;
  if (admin.matchTick - admin.lastRttBroadcastTick >= admin.rttIntervalTicks) {
    admin.lastRttBroadcastTick = admin.matchTick;
    allUserRttData = admin.collectAllUserRtt();
  }

  const signalsList = Array.from(admin.activeSignals.values());

  const globalPayloadBytes = GlobalPayloadCodec.encode({
    physics: physicsSnapshot ? {
      tick: admin.matchTick,
      activeCarMask: physicsSnapshot.activeCarMask ?? admin.physicsManager?.getActiveCarMask?.(),
      stateSnapshot: physicsSnapshot.stateSnapshot,
      acknowledgedControls: physicsSnapshot.acknowledgedControls
    } : null,
    signals: signalsList,
    allUserRtt: allUserRttData
  });

  for (const [sKey, sObj] of admin.activeSignals.entries()) {
    if (sObj.signalType !== MATCH_SIGNALS.KICKOFF_WILL_START) {
      if (typeof sObj.remainingRedundancy === 'number') {
        sObj.remainingRedundancy--;
        if (sObj.remainingRedundancy <= 0) {
          admin.activeSignals.delete(sKey);
        }
      } else {
        admin.activeSignals.delete(sKey);
      }
    }
  }

  return globalPayloadBytes;
}
