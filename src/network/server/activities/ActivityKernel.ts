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
import { ExhibitionActivityKernel } from './ExhibitionActivityKernel.ts';

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
    if (ctx.matchManager?.systemControl?.isStateOnlyMode) {
      ctx.matchManager.systemControl.clear();
      ctx.matchManager.domain.applySystemControlState('resume', ctx.matchManager.domain.matchTick);
    }
    autoPullConnectedPeersForMatch(ctx);
    ctx.matchManager?.lifecycle.startMatch(duration);
  }

  onUnmount(ctx: ActivityKernelContext): void {
    const mm = ctx.matchManager;
    if (!mm?.domain?.isDevSyncRoom) return;
    for (const [sid, p] of Array.from(mm.roster.players.entries())) {
      if (sid !== 'host' && !p.isBot) {
        mm.roster.switchPlayerRoleOrTeam?.(sid, 'spectator', -1);
      }
    }
    mm.roster.broadcastRosterUpdate();
  }

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

import { FreeplaySpectateStreamController } from './FreeplaySpectateStreamController.ts';

class FreeplayActivityKernel implements RoomActivityKernel {
  readonly id = ACTIVITY_IDS.FREEPLAY;
  readonly defaultReplicationMode = REPLICATION_MODES.CONTINUOUS;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.FREEPLAY,
    REPLICATION_MODES.CONTINUOUS
  );
  private readonly spectateStream = new FreeplaySpectateStreamController();

  getSpectateStreamController(): FreeplaySpectateStreamController {
    return this.spectateStream;
  }

  onMount(ctx: ActivityKernelContext): void {
    ctx.matchManager?.lifecycle.startTrainingMode();
    if (typeof ctx.stateSummary?.unlimitedBoost === 'boolean') {
      this.spectateStream.setUnlimitedBoost(ctx.stateSummary.unlimitedBoost);
    }
    if (typeof ctx.stateSummary?.goalReplayEnabled === 'boolean') {
      this.spectateStream.setGoalReplayEnabled(ctx.stateSummary.goalReplayEnabled);
    }
    if (
      ctx.stateSummary?.arenaPreset === 'throwback' ||
      ctx.stateSummary?.arenaPreset === 'standard'
    ) {
      this.spectateStream.setArenaPreset(ctx.stateSummary.arenaPreset);
    }
    this.spectateStream.triggerKickoffReset(ctx.matchManager?.domain.matchTick ?? 0);
  }

  onUnmount(ctx: ActivityKernelContext): void {
    this.spectateStream.triggerKickoffReset(ctx.matchManager?.domain.matchTick ?? 0);
  }

  onControlMessage(
    ctx: ActivityKernelContext,
    type: string,
    payload: Record<string, unknown>
  ): boolean {
    const tick = ctx.matchManager?.domain.matchTick ?? 0;
    if (type === 'freeplay_reset_kickoff') {
      this.spectateStream.triggerKickoffReset(tick);
      return true;
    }
    if (type === 'freeplay_expire_ball') {
      return this.spectateStream.triggerManualBallExpire({
        tick,
        scoringTeam: payload.scoringTeam === 1 ? 1 : 0,
        scorerCarIndex: typeof payload.scorerCarIndex === 'number' ? payload.scorerCarIndex : 0,
        ballSpeedKph: typeof payload.ballSpeedKph === 'number' ? payload.ballSpeedKph : null,
      });
    }
    if (type === 'freeplay_goal_scored') {
      this.spectateStream.triggerGoalScored({
        tick,
        scoringTeam: payload.scoringTeam === 1 ? 1 : 0,
        scorerCarIndex: typeof payload.scorerCarIndex === 'number' ? payload.scorerCarIndex : 0,
        scorerName: typeof payload.scorerName === 'string' ? payload.scorerName : 'Player',
        ballSpeedKph: typeof payload.ballSpeedKph === 'number' ? payload.ballSpeedKph : null,
      });
      return true;
    }
    if (type === 'freeplay_skip_goal_replay') {
      return this.spectateStream.skipGoalReplay(tick);
    }
    if (type === 'freeplay_set_unlimited_boost') {
      const enabled = payload.unlimitedBoost !== false;
      this.spectateStream.setUnlimitedBoost(enabled);
      ctx.matchManager?.lifecycle.startTrainingMode({ unlimitedBoost: enabled });
      return true;
    }
    if (type === 'freeplay_set_replay_camera_mode') {
      const mode = payload.cameraMode === 'pov' ? 'pov' : 'director';
      const carIdx =
        typeof payload.focusedCarIndex === 'number' ? payload.focusedCarIndex : undefined;
      this.spectateStream.setReplayCameraMode(mode, carIdx);
      return true;
    }
    if (type === 'freeplay_rewinder_command') {
      const action = payload.action;
      if (
        action === 'start_recording' ||
        action === 'stop_recording' ||
        action === 'begin_scrub' ||
        action === 'pause_scrub' ||
        action === 'seek_frame' ||
        action === 'resume_from_here' ||
        action === 'clear_buffer'
      ) {
        return this.spectateStream.handleRewinderCommand(action, {
          direction: payload.direction === 'forwarding' ? 'forwarding' : 'rewinding',
          frameIndex: typeof payload.frameIndex === 'number' ? payload.frameIndex : undefined,
          scrubRate: typeof payload.scrubRate === 'number' ? payload.scrubRate : undefined,
        });
      }
      return false;
    }
    return false;
  }

  getStateSummary(ctx: ActivityKernelContext): Record<string, unknown> {
    const streamSummary = this.spectateStream.getStateSummary();
    return {
      ...streamSummary,
      unlimitedBoost:
        ctx.matchManager?.domain.trainingUnlimitedBoost ??
        (streamSummary.unlimitedBoost as boolean),
      matchTick: ctx.matchManager?.domain.matchTick ?? (streamSummary.matchTick as number),
    };
  }
}

import { ReplayWatchCursorEngine } from '../../../replay/watch-together/ReplayWatchCursorEngine.ts';
import type {
  ReplayWatchFrameStreamPacket,
  ReplayWatchPlaybackCommand,
} from '../../../replay/watch-together/ReplayWatchTogetherTypes.ts';

class ReplayActivityKernel implements RoomActivityKernel {
  readonly id = ACTIVITY_IDS.REPLAY;
  readonly defaultReplicationMode = REPLICATION_MODES.SPARSE;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.REPLAY,
    REPLICATION_MODES.SPARSE,
    true
  );
  readonly watchEngine = new ReplayWatchCursorEngine();
  private lastFramePacket: ReplayWatchFrameStreamPacket | null = null;

  onMount(ctx: ActivityKernelContext): void {
    this.lastFramePacket = null;
    ctx.matchManager?.systemControl.enterStateOnlyMode(null, ctx.matchManager.domain.matchTick);
  }

  onUnmount(ctx: ActivityKernelContext): void {
    this.lastFramePacket = null;
    this.watchEngine.applyCommand({ type: 'unload' });
    ctx.matchManager?.systemControl.resumePhysicsFromState(null, ctx.matchManager.domain.matchTick);
  }

  onControlMessage(
    _ctx: ActivityKernelContext,
    type: string,
    payload: Record<string, unknown>
  ): boolean {
    if (type === 'replay_watch_command' && payload.command && typeof payload.command === 'object') {
      this.lastFramePacket = this.watchEngine.applyCommand(
        payload.command as ReplayWatchPlaybackCommand
      );
      return true;
    }
    if (type === 'replay_watch_step') {
      const dtMs = typeof payload.dtMs === 'number' ? payload.dtMs : 0;
      this.lastFramePacket = this.watchEngine.step(dtMs);
      return true;
    }
    return false;
  }

  getStateSummary(ctx: ActivityKernelContext): Record<string, unknown> {
    return {
      activityId: this.id,
      stateOnlyMode: Boolean(ctx.matchManager?.domain.stateOnlyMode),
      matchTick: ctx.matchManager?.domain.matchTick ?? 0,
      replayWatch: this.watchEngine.getStatus(),
      rosterManifest: this.watchEngine.getManifest(),
      lastFramePacket: this.lastFramePacket,
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
  registry.set(ACTIVITY_IDS.EXHIBITION, new ExhibitionActivityKernel());
  registry.set(ACTIVITY_IDS.FREEPLAY, new FreeplayActivityKernel());
  registry.set(ACTIVITY_IDS.MULTIPLAYER_TRAINING, new MultiplayerTrainingActivityKernel());
  registry.set(ACTIVITY_IDS.REPLAY, new ReplayActivityKernel());
  registry.set(ACTIVITY_IDS.SANDBOX, new SandboxActivityKernel());
  return registry;
}
