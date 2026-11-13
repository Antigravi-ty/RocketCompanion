/**
 * src/network/server/spectator/SpectatorRoomTimelineController.ts
 * Authoritative multiplayer spectator room domain model and host timeline
 * lockstep controller (play, pause, seek, playRate, frame-step, and sparse ping mode).
 */

import type {
  SpectatorPlayState,
  SpectatorTimelineCommand,
  SpectatorTimelineState,
} from '../../protocol/RoomActivityProtocol.ts';
import { MATCH_TICK_RATE } from '../match/matchLoadoutAndSpawnPipeline.ts';

export interface SpectatorTimelineSystemControlPort {
  isStateOnlyMode: boolean;
  enterStateOnlyMode(snap?: Float32Array | number[] | null, cursorTick?: number): void;
  resumePhysicsFromState(snap?: Float32Array | number[] | null, resumeTick?: number): void;
}

export interface SpectatorTimelineReplayLookupPort {
  getSnapshotAtTick?: (tick: number) => Float32Array | null;
  getTotalTicks?: () => number;
}

export class SpectatorRoomTimelineController {
  private playState: SpectatorPlayState = 'paused';
  private cursorTick = 0;
  private totalTicks = 0;
  private playRate = 1;
  private sparsePingActive = true;
  private lastUpdatedAtMs = 0;
  private fractionalCursor = 0;
  private lastSparsePingAtMs = 0;

  getState(): SpectatorTimelineState {
    return {
      playState: this.playState,
      cursorTick: this.cursorTick,
      totalTicks: this.totalTicks,
      playRate: this.playRate,
      sparsePingActive: this.sparsePingActive,
      lastUpdatedAtMs: this.lastUpdatedAtMs,
    };
  }

  isSparseFrozenMode(): boolean {
    return this.sparsePingActive && this.playState !== 'playing';
  }

  shouldEmitSparsePing(nowMs: number, intervalMs = 500): boolean {
    if (!this.isSparseFrozenMode()) return false;
    if (nowMs - this.lastSparsePingAtMs >= intervalMs) {
      this.lastSparsePingAtMs = nowMs;
      return true;
    }
    return false;
  }

  applyHostTimelineCommand(
    cmd: SpectatorTimelineCommand,
    systemControl?: SpectatorTimelineSystemControlPort | null,
    replayLookup?: SpectatorTimelineReplayLookupPort | null
  ): SpectatorTimelineState {
    const nowMs = Date.now();
    this.lastUpdatedAtMs = nowMs;

    if (typeof cmd.totalTicks === 'number' && cmd.totalTicks >= 0) {
      this.totalTicks = Math.floor(cmd.totalTicks);
    } else if (replayLookup?.getTotalTicks) {
      this.totalTicks = Math.max(0, Math.floor(replayLookup.getTotalTicks()));
    }

    if (typeof cmd.playRate === 'number' && Number.isFinite(cmd.playRate)) {
      this.playRate = Math.max(0.1, Math.min(4, cmd.playRate));
    }

    switch (cmd.action) {
      case 'play': {
        this.playState = 'playing';
        this.sparsePingActive = false;
        const snap = replayLookup?.getSnapshotAtTick?.(this.cursorTick) ?? null;
        systemControl?.enterStateOnlyMode(snap, this.cursorTick);
        break;
      }
      case 'pause': {
        this.playState = 'paused';
        this.sparsePingActive = true;
        this.lastSparsePingAtMs = nowMs;
        const snap = replayLookup?.getSnapshotAtTick?.(this.cursorTick) ?? null;
        systemControl?.enterStateOnlyMode(snap, this.cursorTick);
        break;
      }
      case 'seek': {
        const target = this.clampTick(cmd.cursorTick ?? this.cursorTick);
        this.cursorTick = target;
        this.fractionalCursor = target;
        this.playState = 'scrubbing';
        this.sparsePingActive = true;
        this.lastSparsePingAtMs = nowMs;
        const snap = replayLookup?.getSnapshotAtTick?.(target) ?? null;
        systemControl?.enterStateOnlyMode(snap, target);
        break;
      }
      case 'step_frame': {
        const nextTick = this.clampTick(this.cursorTick + 1);
        this.cursorTick = nextTick;
        this.fractionalCursor = nextTick;
        this.playState = 'paused';
        this.sparsePingActive = true;
        this.lastSparsePingAtMs = nowMs;
        const snap = replayLookup?.getSnapshotAtTick?.(nextTick) ?? null;
        systemControl?.enterStateOnlyMode(snap, nextTick);
        break;
      }
      case 'set_rate': {
        break;
      }
    }

    return this.getState();
  }

  stepPlaybackTick(
    systemControl?: SpectatorTimelineSystemControlPort | null,
    replayLookup?: SpectatorTimelineReplayLookupPort | null
  ): SpectatorTimelineState {
    if (this.playState !== 'playing') {
      return this.getState();
    }
    const maxTick = Math.max(0, this.totalTicks - 1);
    const stepDelta = Math.max(0.1, this.playRate) * (MATCH_TICK_RATE / 120);
    this.fractionalCursor = Math.min(maxTick, this.fractionalCursor + stepDelta);
    const nextTick = Math.floor(this.fractionalCursor);
    if (nextTick !== this.cursorTick) {
      this.cursorTick = nextTick;
      const snap = replayLookup?.getSnapshotAtTick?.(nextTick) ?? null;
      systemControl?.enterStateOnlyMode(snap, nextTick);
    }
    if (this.totalTicks > 0 && this.cursorTick >= maxTick) {
      this.playState = 'paused';
      this.sparsePingActive = true;
    }
    this.lastUpdatedAtMs = Date.now();
    return this.getState();
  }

  reset(): void {
    this.playState = 'paused';
    this.cursorTick = 0;
    this.totalTicks = 0;
    this.playRate = 1;
    this.sparsePingActive = true;
    this.fractionalCursor = 0;
    this.lastUpdatedAtMs = 0;
    this.lastSparsePingAtMs = 0;
  }

  private clampTick(tick: number): number {
    const floored = Math.max(0, Math.floor(tick));
    if (this.totalTicks > 0) {
      return Math.min(this.totalTicks - 1, floored);
    }
    return floored;
  }
}
