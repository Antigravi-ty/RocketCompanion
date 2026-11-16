/**
 * src/network/server/activities/ActivityKernel.ts
 * Hot-swappable Activity Kernel contract and built-in default kernels
 * (match, freeplay, replay, sandbox) for the RoomActivityOrchestrator.
 */

import {
  ACTIVITY_IDS,
  REPLICATION_MODES,
  resolvePacketFlagsForActivity,
  type ActivityId,
  type ReplicationMode,
} from '../../protocol/ReplicationBusProtocol.ts';
import type { MatchSessionAdmin } from '../match/MatchSessionAdmin.ts';
import type { PhysicsEngineManager } from '../PhysicsEngineManager.ts';

export interface ActivityKernelContext {
  matchManager: MatchSessionAdmin | null | undefined;
  physicsManager: PhysicsEngineManager | null | undefined;
  epoch: number;
  seed?: number;
  stateSummary?: Record<string, unknown> | null;
}

export interface RoomActivityKernel {
  readonly id: ActivityId;
  readonly defaultReplicationMode: ReplicationMode;
  readonly defaultPacketFlags: number;
  onMount(ctx: ActivityKernelContext): void;
  onUnmount(ctx: ActivityKernelContext): void;
  onControlMessage?(
    ctx: ActivityKernelContext,
    type: string,
    payload: Record<string, unknown>
  ): boolean;
  getStateSummary(ctx: ActivityKernelContext): Record<string, unknown>;
}

function autoPullConnectedPeersForMatch(ctx: ActivityKernelContext): void {
  const mm = ctx.matchManager;
  if (!mm || ctx.stateSummary?.autoPullConnectedPeers === false) return;
  const { roster, domain } = mm;
  const sessionMgr = mm.sessionManager as
    | { sessions?: Map<string, { sessionId?: string; playerName?: string; name?: string }> }
    | null
    | undefined;

  if (typeof ctx.stateSummary?.gameMode === 'string') {
    const dur =
      typeof ctx.stateSummary?.durationSeconds === 'number'
        ? ctx.stateSummary.durationSeconds
        : null;
    roster.setGameMode(ctx.stateSummary.gameMode, dur);
  }

  const candidateIds = new Map<string, string>();
  if (roster.players.has('host') || sessionMgr?.sessions?.has('host')) {
    candidateIds.set('host', roster.players.get('host')?.name || 'Host');
  }
  for (const [sid, p] of roster.players.entries()) {
    if (!p.isBot) candidateIds.set(sid, p.name || sid);
  }
  for (const [sid, s] of roster.spectators.entries()) {
    if (!candidateIds.has(sid)) candidateIds.set(sid, s.name || sid);
  }
  if (sessionMgr?.sessions) {
    for (const [sid, sess] of sessionMgr.sessions.entries()) {
      if (!candidateIds.has(sid)) {
        candidateIds.set(sid, sess.playerName || sess.name || sid);
      }
    }
  }
  const extraPeers = ctx.stateSummary?.connectedPeers;
  if (Array.isArray(extraPeers)) {
    for (const raw of extraPeers) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (entry.isBot) continue;
      const id = typeof entry.id === 'string' ? entry.id : '';
      if (id && !candidateIds.has(id)) {
        candidateIds.set(id, typeof entry.name === 'string' ? entry.name : id);
      }
    }
  }

  const teamOverrides =
    ctx.stateSummary?.teamAssignments && typeof ctx.stateSummary.teamAssignments === 'object'
      ? (ctx.stateSummary.teamAssignments as Record<string, number>)
      : null;

  let blueCount = 0;
  let orangeCount = 0;
  for (const p of roster.players.values()) {
    if (p.isBot) continue;
    if (p.team === 0) blueCount++;
    else if (p.team === 1) orangeCount++;
  }

  for (const [sid, name] of candidateIds.entries()) {
    if (roster.players.has(sid)) continue;
    const overrideTeam = teamOverrides?.[sid];
    const targetTeam =
      overrideTeam === 0 || overrideTeam === 1
        ? overrideTeam
        : sid === 'host'
          ? 0
          : blueCount <= orangeCount
            ? 0
            : 1;
    if (roster.spectators.has(sid)) {
      roster.switchPlayerRoleOrTeam(sid, 'player', targetTeam);
    } else {
      roster.assignPlayerSlot(sid, name, 'player', targetTeam);
    }
    if (targetTeam === 0) blueCount++;
    else orangeCount++;
  }

  const humanEntries = Array.from(roster.players.entries()).filter(([, p]) => !p.isBot);
  if (
    ctx.stateSummary?.balanceTeams !== false &&
    humanEntries.length >= 2 &&
    (blueCount === 0 || orangeCount === 0)
  ) {
    let nextTeam = 0;
    for (const [sid, p] of humanEntries) {
      const assigned = sid === 'host' ? 0 : nextTeam % 2;
      if (p.team !== assigned) {
        roster.switchPlayerRoleOrTeam(sid, 'player', assigned);
      }
      nextTeam++;
    }
  }

  for (const p of roster.players.values()) {
    if (!p.isBot) {
      p.ready = true;
      p.arenaLoaded = true;
    }
  }
  domain.stateOnlyMode = false;
  roster.broadcastRosterUpdate();
}

class MatchActivityKernel implements RoomActivityKernel {
  readonly id = ACTIVITY_IDS.MATCH;
  readonly defaultReplicationMode = REPLICATION_MODES.CONTINUOUS;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.MATCH,
    REPLICATION_MODES.CONTINUOUS
  );

  onMount(ctx: ActivityKernelContext): void {
    const duration =
      typeof ctx.stateSummary?.durationSeconds === 'number'
        ? ctx.stateSummary.durationSeconds
        : undefined;
    autoPullConnectedPeersForMatch(ctx);
    ctx.matchManager?.lifecycle.startMatch(duration);
  }

  onUnmount(_ctx: ActivityKernelContext): void {}

  getStateSummary(ctx: ActivityKernelContext): Record<string, unknown> {
    const snap = ctx.matchManager?.getSnapshot();
    return {
      activityId: this.id,
      state: snap?.state ?? 'KICKOFF',
      blueScore: snap?.blueScore ?? 0,
      orangeScore: snap?.orangeScore ?? 0,
      clockSecondsRemaining: snap?.clockSecondsRemaining ?? 0,
    };
  }
}

class FreeplayActivityKernel implements RoomActivityKernel {
  readonly id = ACTIVITY_IDS.FREEPLAY;
  readonly defaultReplicationMode = REPLICATION_MODES.CONTINUOUS;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.FREEPLAY,
    REPLICATION_MODES.CONTINUOUS
  );

  onMount(ctx: ActivityKernelContext): void {
    ctx.matchManager?.lifecycle.startTrainingMode();
  }

  onUnmount(_ctx: ActivityKernelContext): void {}

  getStateSummary(ctx: ActivityKernelContext): Record<string, unknown> {
    return {
      activityId: this.id,
      unlimitedBoost: ctx.matchManager?.domain.trainingUnlimitedBoost ?? true,
      matchTick: ctx.matchManager?.domain.matchTick ?? 0,
    };
  }
}

class ReplayActivityKernel implements RoomActivityKernel {
  readonly id = ACTIVITY_IDS.REPLAY;
  readonly defaultReplicationMode = REPLICATION_MODES.SPARSE;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.REPLAY,
    REPLICATION_MODES.SPARSE,
    true
  );

  onMount(ctx: ActivityKernelContext): void {
    ctx.matchManager?.systemControl.enterStateOnlyMode(null, ctx.matchManager.domain.matchTick);
  }

  onUnmount(ctx: ActivityKernelContext): void {
    ctx.matchManager?.systemControl.resumePhysicsFromState(null, ctx.matchManager.domain.matchTick);
  }

  getStateSummary(ctx: ActivityKernelContext): Record<string, unknown> {
    return {
      activityId: this.id,
      stateOnlyMode: Boolean(ctx.matchManager?.domain.stateOnlyMode),
      matchTick: ctx.matchManager?.domain.matchTick ?? 0,
    };
  }
}

class SandboxActivityKernel implements RoomActivityKernel {
  readonly id = ACTIVITY_IDS.SANDBOX;
  readonly defaultReplicationMode = REPLICATION_MODES.CONTINUOUS;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.SANDBOX,
    REPLICATION_MODES.CONTINUOUS
  );
  private customSummary: Record<string, unknown> = {};

  onMount(ctx: ActivityKernelContext): void {
    this.customSummary = ctx.stateSummary ? { ...ctx.stateSummary } : {};
  }

  onUnmount(_ctx: ActivityKernelContext): void {
    this.customSummary = {};
  }

  onControlMessage(
    _ctx: ActivityKernelContext,
    _type: string,
    payload: Record<string, unknown>
  ): boolean {
    if (payload.stateSummary && typeof payload.stateSummary === 'object') {
      this.customSummary = {
        ...this.customSummary,
        ...(payload.stateSummary as Record<string, unknown>),
      };
      return true;
    }
    return false;
  }

  getStateSummary(_ctx: ActivityKernelContext): Record<string, unknown> {
    return {
      activityId: this.id,
      ...this.customSummary,
    };
  }
}

import {
  GhostBallRelayCoordinator,
  applyTrainingShotResetToSim,
  extractTrainingShotMetadata,
  sanitizeTrainingConfig,
  type GhostBallSample,
  type MultiplayerTrainingConfig,
  type TrainingResetPhysicsPort,
  type TrainingShotMetadata,
} from './MultiplayerTrainingPolicy.ts';

class MultiplayerTrainingActivityKernel implements RoomActivityKernel {
  readonly id = ACTIVITY_IDS.MULTIPLAYER_TRAINING;
  readonly defaultReplicationMode = REPLICATION_MODES.CONTINUOUS;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.MULTIPLAYER_TRAINING,
    REPLICATION_MODES.CONTINUOUS
  );
  private config: MultiplayerTrainingConfig = sanitizeTrainingConfig(null);
  private shotMetadata: TrainingShotMetadata = {};
  private readonly ghostRelay = new GhostBallRelayCoordinator();

  onMount(ctx: ActivityKernelContext): void {
    this.config = sanitizeTrainingConfig(ctx.stateSummary);
    this.shotMetadata = extractTrainingShotMetadata(ctx.stateSummary);
    this.ghostRelay.clear();
    ctx.matchManager?.lifecycle.startTrainingMode({ unlimitedBoost: false });
    ctx.physicsManager?.setTrainingBoostConfig(this.config);
    if (ctx.stateSummary) {
      applyTrainingShotResetToSim(
        ctx.physicsManager as TrainingResetPhysicsPort | null | undefined,
        ctx.stateSummary
      );
    }
  }

  onUnmount(ctx: ActivityKernelContext): void {
    ctx.physicsManager?.setTrainingBoostConfig(null);
    this.ghostRelay.clear();
    this.shotMetadata = {};
  }

  onControlMessage(
    ctx: ActivityKernelContext,
    type: string,
    payload: Record<string, unknown>
  ): boolean {
    if (type === 'training_config_update') {
      this.config = sanitizeTrainingConfig(payload);
      ctx.physicsManager?.setTrainingBoostConfig(this.config);
      return true;
    }
    if (type === 'training_shot_reset') {
      this.shotMetadata = extractTrainingShotMetadata(payload, this.shotMetadata, true);
      applyTrainingShotResetToSim(
        ctx.physicsManager as TrainingResetPhysicsPort | null | undefined,
        payload
      );
      return true;
    }
    if (type === 'training_state_summary_update') {
      this.shotMetadata = extractTrainingShotMetadata(payload, this.shotMetadata);
      return true;
    }
    if (type === 'ghost_ball_report') {
      if (!this.config.ghostModeEnabled) return false;
      const sample = payload.ball as GhostBallSample | undefined;
      if (sample && typeof sample.ownerPeerId === 'string') {
        this.ghostRelay.ingestClientBall(sample);
        return true;
      }
      return false;
    }
    return false;
  }

  getStateSummary(ctx: ActivityKernelContext): Record<string, unknown> {
    return {
      activityId: this.id,
      hideScoreboard: true,
      boostPolicy: this.config.boostPolicy,
      perPlayerBoostOverrides: { ...this.config.perPlayerBoostOverrides },
      ghostModeEnabled: this.config.ghostModeEnabled,
      ghostBalls: this.config.ghostModeEnabled ? this.ghostRelay.buildRelaySnapshot() : [],
      matchTick: ctx.matchManager?.domain.matchTick ?? 0,
      ...this.shotMetadata,
    };
  }
}

export function createDefaultActivityKernelRegistry(): Map<ActivityId, RoomActivityKernel> {
  const registry = new Map<ActivityId, RoomActivityKernel>();
  registry.set(ACTIVITY_IDS.MATCH, new MatchActivityKernel());
  registry.set(ACTIVITY_IDS.FREEPLAY, new FreeplayActivityKernel());
  registry.set(ACTIVITY_IDS.MULTIPLAYER_TRAINING, new MultiplayerTrainingActivityKernel());
  registry.set(ACTIVITY_IDS.REPLAY, new ReplayActivityKernel());
  registry.set(ACTIVITY_IDS.SANDBOX, new SandboxActivityKernel());
  return registry;
}
