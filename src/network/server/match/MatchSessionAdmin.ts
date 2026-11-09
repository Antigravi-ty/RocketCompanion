/**
 * src/network/server/match/MatchSessionAdmin.ts
 * Authoritative Match Lifecycle, Roster, Signal & Command Coordinator.
 * Composes explicit MatchDomainState and stateful Sub-Controllers:
 * - roster (MatchRosterSubController: players, spectators, spawn/color slots, bot fill)
 * - lifecycle (MatchPhaseLifecycleSubController: lobby, countdown, kickoff, playing, goal, replay, overtime, podium)
 * - commandQueue (MatchCommandQueueSubController: client command deduplication, votes, signal dispatch & ACKs)
 * - goalReplay (MatchGoalReplaySubController: goal replay slice playback & server-filled bot stepping)
 */

import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../../replay/ReplayRingBuffer.ts';
import {
  DiagnosticsTestVehicleController,
  DEFAULT_DIAGNOSTIC_FLEET,
} from '../../diagnostics/DiagnosticsTestVehicles.ts';
import type { RosterSnapshot } from './matchLoadoutAndSpawnPipeline.ts';
import {
  MatchDomainState,
  type MatchDomainStateOptions,
  type MatchSessionSnapshot,
} from './MatchDomainState.ts';
import {
  MatchRosterSubController,
  type MatchRosterHostPort,
  type RosterDataHandlerPort,
} from './MatchRosterSubController.ts';
import {
  MatchCommandQueueSubController,
  type CommandQueueSessionPort,
} from './MatchCommandQueueSubController.ts';
import {
  MatchGoalReplaySubController,
  type GoalReplayPhysicsManagerPort,
} from './MatchGoalReplaySubController.ts';
import {
  MatchPhaseLifecycleSubController,
  type PhaseLifecyclePhysicsManagerPort,
  type PhaseLifecycleSessionManagerPort,
  type PhaseLifecycleDiagnosticsPort,
} from './MatchPhaseLifecycleSubController.ts';
import {
  MatchSystemControlSubController,
  type TrainingRulesetConfigOptions,
  type SystemControlPhysicsManagerPort,
} from './MatchSystemControlSubController.ts';
import type { RosterPhysicsManagerPort } from './matchRosterPhysicsAndBotPipeline.ts';
import type { LifecyclePhysicsSnapshotPort } from './matchLifecyclePipeline.ts';

export type { MatchSessionSnapshot, TrainingRulesetConfigOptions };

export type AdminPhysicsManagerPort = PhaseLifecyclePhysicsManagerPort &
  RosterPhysicsManagerPort &
  GoalReplayPhysicsManagerPort &
  SystemControlPhysicsManagerPort & {
    setCarCollisionMask?: (
      carIndex: number,
      interactWithBall: boolean,
      interactWithCars: boolean,
      opacity?: number
    ) => unknown;
    lobbyGhostCoordinator?: {
      lobbyModeActive?: boolean;
      getCarGhostState?: (carIndex: number) => Record<string, unknown> | null;
    } | null;
  };

export type AdminSessionManagerPort = PhaseLifecycleSessionManagerPort &
  CommandQueueSessionPort &
  MatchRosterHostPort['sessionManager'];

export interface AdminDataHandlerPort extends RosterDataHandlerPort {
  dispatchFrameToSessions?: (bytes: Uint8Array) => void;
}

export type ClearRetainedReplayCallback = () => void;
export type RetainCompletedReplayCallback = (data: Record<string, unknown>) => void;

export interface MatchSessionAdminOptions extends MatchDomainStateOptions {
  physicsManager?: AdminPhysicsManagerPort | null;
  sessionManager?: AdminSessionManagerPort | null;
  dataHandler?: AdminDataHandlerPort | null;
  diagnosticsController?: PhaseLifecycleDiagnosticsPort | null;
  onClearRetainedReplay?: ClearRetainedReplayCallback | null;
  onRetainCompletedReplay?: RetainCompletedReplayCallback | null;
  replayCapacityTicks?: number;
  goalReplayLookbackSeconds?: number;
  goalReplayPostGoalSeconds?: number;
}

export class MatchSessionAdmin {
  readonly domain: MatchDomainState;

  physicsManager: AdminPhysicsManagerPort | null | undefined;
  sessionManager: AdminSessionManagerPort | null | undefined;
  dataHandler: AdminDataHandlerPort | null;
  diagnosticsController: PhaseLifecycleDiagnosticsPort;
  onClearRetainedReplay: ClearRetainedReplayCallback | null;
  onRetainCompletedReplay: RetainCompletedReplayCallback | null;
  replayBuffer: ReplayRingBuffer;

  readonly roster: MatchRosterSubController;
  readonly commandQueue: MatchCommandQueueSubController;
  readonly goalReplay: MatchGoalReplaySubController;
  readonly systemControl: MatchSystemControlSubController;
  readonly lifecycle: MatchPhaseLifecycleSubController;

  constructor(options: MatchSessionAdminOptions = {}) {
    this.domain = new MatchDomainState(options);

    this.physicsManager = options.physicsManager;
    this.sessionManager = options.sessionManager;
    this.dataHandler = options.dataHandler || null;
    this.diagnosticsController =
      options.diagnosticsController ||
      (new DiagnosticsTestVehicleController(
        DEFAULT_DIAGNOSTIC_FLEET
      ) as unknown as PhaseLifecycleDiagnosticsPort);
    this.onClearRetainedReplay = options.onClearRetainedReplay || null;
    this.onRetainCompletedReplay = options.onRetainCompletedReplay || null;

    this.replayBuffer = new ReplayRingBuffer({
      mode: this.domain.isTrainingMode
        ? REPLAY_BUFFER_MODES.COUNTUP_FIFO
        : REPLAY_BUFFER_MODES.COUNTDOWN_MATCH,
      capacityTicks: options.replayCapacityTicks,
    });

    const bindAdminPort = <T extends Record<string, unknown>>(port: T): T & this => {
      const bound = Object.create(this) as T & this;
      for (const [k, v] of Object.entries(port)) {
        (bound as Record<string, unknown>)[k] = v;
      }
      return bound;
    };

    const removeSessionVotes = (sid: string): void => {
      this.commandQueue.removeSessionVotes(sid);
    };
    const triggerLobbyAutoStart = (): void => {
      this.lifecycle.initiateMatchPrepare();
    };

    this.roster = new MatchRosterSubController(
      bindAdminPort({
        domain: this.domain,
        dispatchSignal: (t: number, f: number, p1?: number, p2?: number) =>
          this.commandQueue.dispatchSignal(t, f, p1, p2),
        onPlayerSessionRemoved: removeSessionVotes,
        onLobbyAutoStartTriggered: triggerLobbyAutoStart,
      })
    );

    this.commandQueue = new MatchCommandQueueSubController(
      bindAdminPort({
        domain: this.domain,
        roster: this.roster,
        actions: {
          initiateMatchPrepare: (dur?: number | null, timeout?: number) =>
            this.lifecycle.initiateMatchPrepare(dur, timeout),
          checkArenaLoadedBarrier: () => this.lifecycle.checkArenaLoadedBarrier(),
          startMatch: (dur?: number | null) => this.lifecycle.startMatch(dur),
          finishGoalReplay: () => this.goalReplay.finishGoalReplay(),
          setPaused: (pause: boolean) => this.lifecycle.setPaused(pause),
          requestResumeWithCountdown: (sec?: number) =>
            this.lifecycle.requestResumeWithCountdown(sec),
          endMatch: (w?: number | null, r?: number) => this.lifecycle.endMatch(w, r),
          enterStateOnlyMode: (snap?: Float32Array | number[] | null, tick?: number) =>
            this.systemControl.enterStateOnlyMode(snap, tick),
          beginInterveneCountdown: (sec?: number, snap?: Float32Array | number[] | null) =>
            this.systemControl.beginInterveneCountdown(sec, snap),
          resumePhysicsFromState: (snap?: Float32Array | number[] | null, tick?: number) =>
            this.systemControl.resumePhysicsFromState(snap, tick),
        },
      })
    );

    this.goalReplay = new MatchGoalReplaySubController(
      bindAdminPort({
        domain: this.domain,
        commandQueue: this.commandQueue,
        actions: {
          resetTrainingPlay: () => this.lifecycle.resetTrainingPlay(),
          startKickoffSequence: (ticks?: number) => this.lifecycle.startKickoffSequence(ticks),
          endMatch: (w?: number | null, r?: number) => this.lifecycle.endMatch(w, r),
        },
      }),
      {
        goalReplayLookbackSeconds: options.goalReplayLookbackSeconds,
        goalReplayPostGoalSeconds: options.goalReplayPostGoalSeconds,
      }
    );

    this.systemControl = new MatchSystemControlSubController(
      bindAdminPort({
        domain: this.domain,
        commandQueue: this.commandQueue,
        encodeFramePacket: (snap: LifecyclePhysicsSnapshotPort | null) =>
          this.lifecycle.encodeFramePacket(snap),
      })
    );

    this.lifecycle = new MatchPhaseLifecycleSubController(
      bindAdminPort({
        domain: this.domain,
        roster: this.roster,
        commandQueue: this.commandQueue,
        goalReplay: this.goalReplay,
        systemControl: this.systemControl,
      }) as unknown as ConstructorParameters<typeof MatchPhaseLifecycleSubController>[0]
    );
  }

  getSnapshot(): MatchSessionSnapshot {
    return this.domain.buildSessionSnapshot(this.roster.buildRosterSnapshot());
  }

  buildRosterSnapshot(): RosterSnapshot {
    return this.roster.buildRosterSnapshot();
  }

  removePlayerSession(sessionId: string): void {
    this.roster.removePlayerSession(sessionId);
  }

  destroy(): void {
    this.commandQueue.dispatchSignal(MATCH_SIGNALS.MATCH_DESTROYED, this.domain.matchTick, 0, 0);
    if (this.dataHandler && typeof this.dataHandler.dispatchFrameToSessions === 'function') {
      try {
        const finalBytes = this.lifecycle.encodeFramePacket(null);
        if (finalBytes && finalBytes.length > 0) {
          this.dataHandler.dispatchFrameToSessions(finalBytes);
        }
      } catch (err) {
        console.warn('[MatchSessionAdmin] Failed to flush MATCH_DESTROYED packet on destroy:', err);
      }
    }
    this.roster.clear();
    this.commandQueue.clear();
    this.goalReplay.clear();
    this.systemControl.clear();
    this.replayBuffer?.clear();
  }
}
