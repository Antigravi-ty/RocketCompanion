/**
 * src/network/server/match/MatchGoalReplaySubController.ts
 * Stateful SubController owning post-goal replay slice extraction/playback,
 * dramatic slow-motion timeline stepping, and server-filled bot inference agents.
 */

import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.ts';
import {
  interpolateReplaySnapshots,
  encodeReplayDirectorTelemetryIntoState,
} from '../../../replay/ReplayFrameInterpolator.ts';
import { normalizeReplayDirectorCarEntry } from '../../../replay/replayDirectorCarRosterPipeline.ts';
import {
  ExperimentalBotAgent,
  ensureExperimentalEngine,
  DEFAULT_CAR_CONTROLS,
} from '../../../ai/experimental/ExperimentalBotAgent.ts';
import {
  MATCH_STATES,
  MATCH_TICK_RATE,
  GOAL_REPLAY_DURATION_TICKS,
  KICKOFF_TOTAL_TICKS,
} from './matchLoadoutAndSpawnPipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';
import type { MatchCommandQueueSubController } from './MatchCommandQueueSubController.ts';

export interface ServerBotAgentRecord {
  agent: any;
  kickoffStep: number;
  staggered: boolean;
}

export interface MatchGoalReplayLifecycleActionsPort {
  resetTrainingPlay(): void;
  startKickoffSequence(countdownTicks?: number): void;
  endMatch(forcedWinner?: number | null, winReason?: number): void;
}

export interface MatchGoalReplayHostPort {
  readonly domain: MatchDomainState;
  readonly commandQueue: MatchCommandQueueSubController;
  readonly actions: MatchGoalReplayLifecycleActionsPort;
  readonly replayBuffer: any;
  readonly physicsManager: any;
}

export interface MatchGoalReplayOptions {
  goalReplayLookbackSeconds?: number;
  goalReplayPostGoalSeconds?: number;
  enableDramaticReplaySlowMo?: boolean;
}

const REPLAY_START_RETIRE_SIGNAL_TYPES = [
  MATCH_SIGNALS.KICKOFF_WILL_START,
  MATCH_SIGNALS.KICKOFF_START,
  MATCH_SIGNALS.TIME_ALERT_60S,
  MATCH_SIGNALS.TIME_ALERT_30S,
  MATCH_SIGNALS.COUNTDOWN_10S,
  MATCH_SIGNALS.SCORE_UPDATED,
  MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
];

export class MatchGoalReplaySubController {
  readonly host: MatchGoalReplayHostPort;
  replayController: ReplayTimelineController | null = null;
  activeReplayFrames: any[] | null = null;
  activeReplayCursor = 0;
  replayInterpolatedBuffer: Float32Array | null = null;
  replayTicksRemaining = -1;
  lastGoalIncidentFrame = -1;
  lastScoringTeam = 0;
  lastScorerCarIndex = 0;
  lastScorerTouchFrame = -1;
  lastGoalBallSpeedKph = 100;
  goalReplayLookbackSeconds: number;
  goalReplayPostGoalSeconds: number;
  enableDramaticReplaySlowMo: boolean;
  serverBotAgents = new Map<string, ServerBotAgentRecord>();

  constructor(host: MatchGoalReplayHostPort, options: MatchGoalReplayOptions = {}) {
    this.host = host;
    this.goalReplayLookbackSeconds = options.goalReplayLookbackSeconds ?? 10.0;
    this.goalReplayPostGoalSeconds = options.goalReplayPostGoalSeconds ?? 3.0;
    this.enableDramaticReplaySlowMo = options.enableDramaticReplaySlowMo ?? true;
  }

  recordGoalIncident(
    matchTick: number,
    scoringTeam: number,
    scorerCarIndex: number,
    scorerTouchTick: number,
    ballSpeedKph: number
  ): void {
    this.lastGoalIncidentFrame = matchTick;
    this.lastScoringTeam = scoringTeam;
    this.lastScorerCarIndex = scorerCarIndex;
    this.lastScorerTouchFrame = scorerTouchTick;
    this.lastGoalBallSpeedKph = ballSpeedKph;
  }

  buildReplaySkipAckControls(): Array<{ carIndex: number; controls: any }> {
    const { domain, commandQueue } = this.host;
    const ackList: Array<{ carIndex: number; controls: any }> = [];
    for (const [sid, p] of domain.players.entries()) {
      if (!p || p.role === 'spectator' || typeof p.entityId !== 'number' || p.entityId < 0) {
        continue;
      }
      const isSkipReady = Boolean(p.isBot || commandQueue.skipReplayVotes.has(sid));
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

  beginGoalReplay(): void {
    const { domain, commandQueue, actions, replayBuffer, physicsManager } = this.host;
    if (domain.isTrainingMode && !domain.trainingGoalReplayEnabled) {
      actions.resetTrainingPlay();
      return;
    }
    if (!domain.isTrainingMode && domain.skipReplayByDefault) {
      this.finishGoalReplay();
      return;
    }
    domain.state = MATCH_STATES.REPLAY;
    commandQueue.retireSignalTypes(REPLAY_START_RETIRE_SIGNAL_TYPES);
    this.activeReplayFrames = extractGoalReplayFrames({
      ringBuffer: replayBuffer,
      engine: physicsManager?.sim || null,
      durationTicks: GOAL_REPLAY_DURATION_TICKS,
      goalIncidentTick: this.lastGoalIncidentFrame >= 0 ? this.lastGoalIncidentFrame : null,
      scorerTouchTick: this.lastScorerTouchFrame >= 0 ? this.lastScorerTouchFrame : undefined,
      lookbackSeconds: this.goalReplayLookbackSeconds ?? 10.0,
      postGoalSeconds: this.goalReplayPostGoalSeconds ?? 3.0,
      lastKickoffWillStartTick: domain.lastKickoffWillStartFrame ?? -1,
      signalLog: commandQueue.replaySignalLog,
    });

    if (!this.replayController) {
      this.replayController = new ReplayTimelineController({
        ringBuffer: replayBuffer,
      });
    }
    if (this.activeReplayFrames && this.activeReplayFrames.length > 0) {
      const carEntries = Array.from(domain.players.values())
        .filter((p) => p && p.role !== 'spectator' && typeof p.entityId === 'number' && p.entityId >= 0)
        .sort((a, b) => a.entityId - b.entityId)
        .map((p) =>
          normalizeReplayDirectorCarEntry(
            {
              carIndex: p.entityId,
              name: p.name,
              username: p.name,
              team: p.team ?? p.entityId % 2,
              isBot: Boolean(p.isBot),
              isLocalPlayer: !p.isBot && p.entityId === 0,
              botType: p.botType || null,
              visualId: p.visualId,
              hitboxId: p.hitboxId,
              colorSlot: p.colorSlot,
              colorHex: p.colorHex,
              paintFinish: p.paintFinish,
              boostVisual: p.boostVisual,
              boostAudio: p.boostAudio,
              anthemId: p.anthemId,
            },
            p.entityId,
            p.team ?? p.entityId % 2
          )
        );
      this.replayController.beginReplaySession({
        frames: this.activeReplayFrames,
        scoringTeam: this.lastScoringTeam ?? 0,
        scorerCarIndex: this.lastScorerCarIndex ?? 0,
        carEntries,
        carTeamResolver: (carIdx: number) => {
          for (const p of domain.players.values()) {
            if (p.entityId === carIdx) return p.team ?? carIdx % 2;
          }
          return carIdx % 2;
        },
      });
      if (this.enableDramaticReplaySlowMo !== false && this.activeReplayFrames.length > 1) {
        let simCursor = 0;
        let estTicks = 0;
        const maxIndex = this.activeReplayFrames.length - 1;
        while (simCursor < maxIndex && estTicks < maxIndex * 3) {
          const factor = this.replayController.computeDramaticSlowMoFactor(simCursor);
          simCursor += Math.max(0.1, factor);
          estTicks++;
        }
        this.replayTicksRemaining = Math.max(this.activeReplayFrames.length, estTicks);
      } else {
        this.replayTicksRemaining = this.activeReplayFrames.length;
      }
    } else {
      this.replayTicksRemaining = GOAL_REPLAY_DURATION_TICKS;
    }
    this.activeReplayCursor = 0;

    if (physicsManager) {
      physicsManager.applySignal(MATCH_SIGNALS.GOAL_REPLAY_START);
    }
    const replayStartMeta =
      ((this.lastScoringTeam ?? 0) & 0x1) |
      (((this.lastScorerCarIndex ?? 0) & 0xff) << 1) |
      (((this.lastGoalBallSpeedKph ?? 100) & 0xffff) << 16);
    commandQueue.dispatchSignal(
      MATCH_SIGNALS.GOAL_REPLAY_START,
      domain.matchTick,
      this.replayTicksRemaining,
      replayStartMeta
    );
  }

  finishGoalReplay(): void {
    const { domain, commandQueue, actions, physicsManager } = this.host;
    this.replayController?.endReplaySession?.();
    this.activeReplayFrames = null;
    this.activeReplayCursor = 0;
    if (domain.isTrainingMode) {
      if (physicsManager) {
        physicsManager.applySignal(MATCH_SIGNALS.GOAL_REPLAY_END);
      }
      commandQueue.dispatchSignal(MATCH_SIGNALS.GOAL_REPLAY_END, domain.matchTick, 0, 0);
      actions.resetTrainingPlay();
      return;
    }
    if (physicsManager) {
      physicsManager.applySignal(MATCH_SIGNALS.GOAL_REPLAY_END);
    }
    commandQueue.dispatchSignal(MATCH_SIGNALS.GOAL_REPLAY_END, domain.matchTick, 0, 0);
    const pendingEnd = domain.consumePendingMatchEndAfterGoal();
    if (pendingEnd.shouldEnd) {
      const w = pendingEnd.winner ?? (domain.blueScore > domain.orangeScore ? 0 : 1);
      actions.endMatch(w, 0);
      return;
    }
    commandQueue.dispatchSignal(
      MATCH_SIGNALS.ROUND_STARTED,
      domain.matchTick,
      domain.blueScore + domain.orangeScore + 1,
      0
    );
    actions.startKickoffSequence(KICKOFF_TOTAL_TICKS);
  }

  stepReplayTick(): { finished: boolean; replayPhysicsSnapshot: any | null } {
    const { domain, physicsManager } = this.host;
    this.replayTicksRemaining--;
    let replayPhysicsSnapshot: any | null = null;
    const replayAckControls = this.buildReplaySkipAckControls();
    const replayFrames =
      this.replayController?.frames || this.replayController?.sessionState?.activeFrames;
    if (
      this.replayController &&
      this.replayController.sessionState.isActive &&
      Array.isArray(replayFrames) &&
      replayFrames.length > 0
    ) {
      const useSlowMo = this.enableDramaticReplaySlowMo !== false;
      const stepRes = this.replayController.stepPlayback(1 / MATCH_TICK_RATE, null, useSlowMo);
      this.activeReplayCursor = stepRes.frameIndex;
      const currSnap = (stepRes.frame as any)?.snapshot || stepRes.frame;
      const prevSnap = (stepRes.prevFrame as any)?.snapshot || stepRes.prevFrame || currSnap;
      if (currSnap) {
        const blendedSnap = interpolateReplaySnapshots(
          prevSnap,
          currSnap,
          stepRes.alpha,
          (this.replayInterpolatedBuffer as any) || null
        );
        this.replayInterpolatedBuffer = blendedSnap;
        encodeReplayDirectorTelemetryIntoState(
          blendedSnap,
          this.replayController.directorCameraState,
          stepRes.progress
        );
        replayPhysicsSnapshot = {
          tick: domain.matchTick,
          activeCarMask: physicsManager?.getActiveCarMask?.() || 0,
          stateSnapshot: blendedSnap,
          acknowledgedControls: replayAckControls,
          isReplaySlice: true,
        };
      }
    } else if (
      Array.isArray(this.activeReplayFrames) &&
      this.activeReplayCursor < this.activeReplayFrames.length
    ) {
      const sliceFrame = this.activeReplayFrames[this.activeReplayCursor];
      this.activeReplayCursor++;
      const snap = sliceFrame?.snapshot || sliceFrame;
      if (snap) {
        const total = Math.max(1, this.activeReplayFrames.length - 1);
        const progress = Math.min(1, Math.max(0, (this.activeReplayCursor - 1) / total));
        const outSnap = new Float32Array(snap.length);
        outSnap.set(snap);
        encodeReplayDirectorTelemetryIntoState(
          outSnap,
          this.replayController?.directorCameraState || null,
          progress
        );
        replayPhysicsSnapshot = {
          tick: domain.matchTick,
          activeCarMask: physicsManager?.getActiveCarMask?.() || 0,
          stateSnapshot: outSnap,
          acknowledgedControls: replayAckControls,
          isReplaySlice: true,
        };
      }
    }

    const controllerDone = this.replayController && !this.replayController.sessionState.isActive;
    if (this.replayTicksRemaining <= 0 || controllerDone) {
      this.finishGoalReplay();
      return { finished: true, replayPhysicsSnapshot };
    }
    return { finished: false, replayPhysicsSnapshot };
  }

  stepServerFilledBots(): void {
    const { domain, physicsManager } = this.host;
    if (!physicsManager || !physicsManager.sim) return;
    if (
      domain.state !== MATCH_STATES.PLAYING &&
      domain.state !== MATCH_STATES.KICKOFF &&
      domain.state !== MATCH_STATES.GOAL_SCORED
    ) {
      return;
    }

    let hasFilledBots = false;
    for (const [sid, p] of domain.players.entries()) {
      if (!p.isBot) continue;
      if (domain.externalBotTunnels && sid === 'bot') continue;
      if (typeof p.entityId === 'number' && p.entityId >= 0) {
        hasFilledBots = true;
        break;
      }
    }
    if (!hasFilledBots) return;

    ensureExperimentalEngine('nexto');

    const sim = physicsManager.sim;
    sim.syncToStateObject?.();
    if (!sim.state?.ball) return;

    if (domain.state === MATCH_STATES.KICKOFF) {
      for (const rec of this.serverBotAgents.values()) {
        rec.kickoffStep = 0;
        rec.agent?.reset?.();
      }
      for (const [sid, p] of domain.players.entries()) {
        if (!p.isBot) continue;
        if (domain.externalBotTunnels && sid === 'bot') continue;
        if (typeof p.entityId === 'number' && p.entityId >= 0) {
          physicsManager.setDirectCarControls(p.entityId, DEFAULT_CAR_CONTROLS);
        }
      }
      return;
    }

    const pads = sim.boostPads || [];
    const activeCars: any[] = [];
    for (const p of domain.players.values()) {
      if (typeof p.entityId === 'number' && p.entityId >= 0) {
        activeCars.push({
          carIndex: p.entityId,
          team: p.team === 1 ? 1 : 0,
        });
      }
    }

    for (const [sid, p] of domain.players.entries()) {
      if (!p.isBot || typeof p.entityId !== 'number' || p.entityId < 0) continue;
      if (domain.externalBotTunnels && sid === 'bot') continue;

      let record = this.serverBotAgents.get(sid);
      const botTeam = p.team === 1 ? 1 : 0;
      const requestedBotType = p.botType || 'nexto';
      if (
        !record ||
        record.agent.carIndex !== p.entityId ||
        record.agent.team !== botTeam ||
        record.agent.botType !== requestedBotType
      ) {
        ensureExperimentalEngine(requestedBotType);
        record = {
          agent: new ExperimentalBotAgent(requestedBotType, p.entityId, botTeam),
          kickoffStep: 0,
          staggered: false,
        };
        this.serverBotAgents.set(sid, record);
      }

      if (!record.agent.ready) {
        physicsManager.setDirectCarControls(p.entityId, DEFAULT_CAR_CONTROLS);
        continue;
      }

      let ctrl: any;
      if (record.kickoffStep < 24) {
        const ko = {
          ...DEFAULT_CAR_CONTROLS,
          throttle: 1.0,
          boost: true,
        };
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
      physicsManager.setDirectCarControls(p.entityId, ctrl || DEFAULT_CAR_CONTROLS);
    }
  }

  resetForMatchStart(): void {
    this.lastGoalIncidentFrame = -1;
    this.replayTicksRemaining = -1;
    this.activeReplayFrames = null;
    this.activeReplayCursor = 0;
  }

  clear(): void {
    this.replayController?.endReplaySession?.();
    this.activeReplayFrames = null;
    this.activeReplayCursor = 0;
    this.serverBotAgents.clear();
  }
}
