/**
 * src/network/server/activities/MultiplayerTrainingKernel.ts
 * MULTIPLAYER_TRAINING ActivityKernel: no score settlement (scoreboard hidden),
 * normal Cinematic Goal Replay, 4-mode Boost Policy, and Ghost Mode Host Relay.
 */

import {
  ACTIVITY_IDS,
  REPLICATION_MODES,
  resolvePacketFlagsForActivity,
  type MultiplayerTrainingBoostPolicy,
  type MultiplayerTrainingConfig,
} from '../../protocol/ReplicationBusProtocol.ts';
import type { ActivityKernelContext, RoomActivityKernel } from './ActivityKernel.ts';
import {
  createDefaultMultiplayerTrainingConfig,
  resolveCarBoostPolicy,
  stepCarTrainingBoost,
} from './TrainingBoostPolicy.ts';
import { TrainingGhostBallRelay, type GhostBallStateSnapshot } from './TrainingGhostBallRelay.ts';

export class MultiplayerTrainingActivityKernel implements RoomActivityKernel {
  readonly id = ACTIVITY_IDS.MULTIPLAYER_TRAINING;
  readonly defaultReplicationMode = REPLICATION_MODES.CONTINUOUS;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.MULTIPLAYER_TRAINING,
    REPLICATION_MODES.CONTINUOUS
  );

  private config: MultiplayerTrainingConfig = createDefaultMultiplayerTrainingConfig();
  readonly ghostBallRelay = new TrainingGhostBallRelay();

  getConfig(): MultiplayerTrainingConfig {
    return {
      ...this.config,
      perPlayerBoost: this.config.perPlayerBoost ? { ...this.config.perPlayerBoost } : {},
    };
  }

  onMount(ctx: ActivityKernelContext): void {
    const incoming = ctx.stateSummary as Partial<MultiplayerTrainingConfig> | null | undefined;
    this.config = createDefaultMultiplayerTrainingConfig(incoming ?? {});
    this.ghostBallRelay.setEnabled(this.config.ghostModeEnabled);
    ctx.matchManager?.lifecycle.startTrainingMode();
  }

  onUnmount(_ctx: ActivityKernelContext): void {
    this.ghostBallRelay.clear();
  }

  evaluateCarBoost(
    playerKey: string,
    prevBoost: number,
    currentBoost: number,
    onGround: boolean,
    pickedUpPadBoost = 0
  ): number {
    const policy = resolveCarBoostPolicy(this.config, playerKey);
    return stepCarTrainingBoost(policy, prevBoost, currentBoost, onGround, pickedUpPadBoost);
  }

  onControlMessage(
    _ctx: ActivityKernelContext,
    type: string,
    payload: Record<string, unknown>
  ): boolean {
    if (type === 'training_config_update') {
      if (typeof payload.boostPolicy === 'string') {
        this.config.boostPolicy = payload.boostPolicy as MultiplayerTrainingBoostPolicy;
      }
      if (payload.perPlayerBoost && typeof payload.perPlayerBoost === 'object') {
        this.config.perPlayerBoost = {
          ...this.config.perPlayerBoost,
          ...(payload.perPlayerBoost as Record<string, MultiplayerTrainingBoostPolicy>),
        };
      }
      if (typeof payload.ghostModeEnabled === 'boolean') {
        this.config.ghostModeEnabled = payload.ghostModeEnabled;
        this.ghostBallRelay.setEnabled(this.config.ghostModeEnabled);
      }
      return true;
    }

    if (type === 'ghost_ball_state' && typeof payload.peerId === 'string') {
      const ball = payload.ball as Omit<GhostBallStateSnapshot, 'ownerPeerId'> | undefined;
      if (ball && Array.isArray(ball.pos) && Array.isArray(ball.vel)) {
        this.ghostBallRelay.submitClientBallState(payload.peerId, ball);
        return true;
      }
    }

    return false;
  }

  getStateSummary(ctx: ActivityKernelContext): Record<string, unknown> {
    return {
      activityId: this.id,
      boostPolicy: this.config.boostPolicy,
      perPlayerBoost: this.config.perPlayerBoost ?? {},
      ghostModeEnabled: this.config.ghostModeEnabled,
      hideScoreboard: this.config.hideScoreboard,
      goalReplayEnabled: this.config.goalReplayEnabled,
      relayBallCount: this.ghostBallRelay.getAllBalls().length,
      matchTick: ctx.matchManager?.domain.matchTick ?? 0,
    };
  }
}
