/**
 * src/network/server/activities/FreeplaySpectateStreamController.ts
 * Worker-compatible, zero-DOM Freeplay Authority Frame Stream & State Machine.
 * Unifies Freeplay Live, Post-Goal Celebration / Goal Replay (with Director/POV
 * cameraPose), and FreeplayRewinder into a single 4-channel output stream with
 * strictly monotonic `txSeq`.
 */

import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../../replay/ReplayRingBuffer.ts';
import {
  FREEPLAY_W104_TEMP_SCHEMA_HASH,
  type FreeplayCameraMode,
  type FreeplayFrameBundle,
  type FreeplayGoalReplayMeta,
  type FreeplayPhase,
  type FreeplayPlaybackState,
  type FreeplayRewinderSliceManifest,
  type FreeplayRewinderState,
  type FreeplayRosterCarEntry,
  type FreeplayRosterManifest,
  type FreeplaySignalEvent,
  type FreeplaySignalKind,
  type FreeplayStateFramePayload,
  type FreeplaySubMode,
} from './freeplaySpectateTypes.ts';
import {
  computeFreeplayMetadataHash,
  extractBallFromSnapshot,
  extractBoostPadMaskFromSnapshot,
  extractCarsFromSnapshot,
} from './freeplaySnapshotReader.ts';
import {
  computeFreeplaySpectateCameraPose,
  extractFreeplayGoalReplaySnapshots,
} from './freeplayGoalReplayStreamPipeline.ts';
import {
  DEFAULT_TICKS_PER_SECOND,
  FreeplayRewinderStreamSubController,
  type RewinderAction,
  type RewinderCommandOptions,
  type RewinderStepCallbacks,
} from './FreeplayRewinderStreamSubController.ts';

export const DEFAULT_CELEBRATION_TICKS = 150;

export interface FreeplayStreamConfig {
  arenaPreset?: 'standard' | 'throwback';
  unlimitedBoost?: boolean;
  goalReplayEnabled?: boolean;
  telestratorPermission?: 'host_only' | 'everyone';
  ringBufferCapacityTicks?: number;
  goalReplaySlowMoRate?: number;
}

const DEFAULT_ROSTER_CAR: FreeplayRosterCarEntry = {
  carIndex: 0,
  name: 'Player',
  team: 0,
  visualId: 'octane',
  colorHex: '#3b82f6',
  paintFinish: 'matte',
  decalId: 'none',
  isBot: false,
  roleFlag: 'player',
};

export class FreeplaySpectateStreamController {
  public readonly ringBuffer: ReplayRingBuffer;
  public readonly rewinder = new FreeplayRewinderStreamSubController();
  private txSeq = 0;
  private signalId = 0;
  private subMode: FreeplaySubMode = 'live';
  private phase: FreeplayPhase = 'playing';
  private cameraMode: FreeplayCameraMode = 'player';
  private replayCameraMode: 'director' | 'pov' = 'director';
  private focusedCarIndex = 0;
  private isPaused = false;
  private lastTick = 0;
  private lastTouchTick = -1;
  private lastKickoffTick = 0;
  private celebrationTicksRemaining = 0;
  private pendingGoalMeta: FreeplayGoalReplayMeta | null = null;
  private goalIncidentTick = -1;
  private goalReplayFrames: Float32Array[] = [];
  private goalReplayCursor = 0;
  private goalReplaySlowMoRate = 0.5;
  private lastEmittedMetadataHash = 0;
  private pendingSignals: FreeplaySignalEvent[] = [];
  private lastLiveSnapshot: Float32Array = new Float32Array(448);

  private manifestConfig: Omit<FreeplayRosterManifest, 'metadataHash'> = {
    activityId: 'freeplay',
    arenaPreset: 'standard',
    unlimitedBoost: true,
    goalReplayEnabled: true,
    telestratorPermission: 'host_only',
    cars: [{ ...DEFAULT_ROSTER_CAR }],
  };

  private readonly rewinderCallbacks: RewinderStepCallbacks = {
    onStateChange: (next) => {
      this.enqueueSignal('rewinder_state_change', this.lastTick, { rewinderState: next });
    },
    onCountdownTick: (wholeSeconds) => {
      this.enqueueSignal('countdown_tick', this.lastTick, { countdownSeconds: wholeSeconds });
    },
    onEnterSubMode: (subMode, phase) => {
      this.subMode = subMode;
      this.phase = phase;
    },
    onInterveneToLive: (snapshot) => {
      this.lastLiveSnapshot = snapshot;
      this.subMode = 'live';
      this.phase = 'playing';
    },
  };

  constructor(config: FreeplayStreamConfig = {}) {
    const cap = config.ringBufferCapacityTicks ?? 7200;
    this.ringBuffer = new ReplayRingBuffer({
      mode: REPLAY_BUFFER_MODES.COUNTUP_FIFO,
      capacityTicks: cap,
    });
    if (config.arenaPreset) this.manifestConfig.arenaPreset = config.arenaPreset;
    if (typeof config.unlimitedBoost === 'boolean') {
      this.manifestConfig.unlimitedBoost = config.unlimitedBoost;
    }
    if (typeof config.goalReplayEnabled === 'boolean') {
      this.manifestConfig.goalReplayEnabled = config.goalReplayEnabled;
    }
    if (config.telestratorPermission) {
      this.manifestConfig.telestratorPermission = config.telestratorPermission;
    }
    if (typeof config.goalReplaySlowMoRate === 'number' && config.goalReplaySlowMoRate > 0) {
      this.goalReplaySlowMoRate = config.goalReplaySlowMoRate;
    }
  }

  public getTxSeq(): number {
    return this.txSeq;
  }

  public getSubMode(): FreeplaySubMode {
    return this.subMode;
  }

  public getPhase(): FreeplayPhase {
    return this.phase;
  }

  public getRewinderState(): FreeplayRewinderState {
    return this.rewinder.state;
  }

  public getManifest(): FreeplayRosterManifest {
    const metadataHash = computeFreeplayMetadataHash(this.manifestConfig);
    return {
      ...this.manifestConfig,
      cars: this.manifestConfig.cars.map((c) => ({ ...c })),
      metadataHash,
    };
  }

  public updateRoster(cars: ReadonlyArray<FreeplayRosterCarEntry>): void {
    this.manifestConfig.cars =
      cars.length > 0 ? cars.map((c) => ({ ...c })) : [{ ...DEFAULT_ROSTER_CAR }];
  }

  public setUnlimitedBoost(enabled: boolean): void {
    this.manifestConfig.unlimitedBoost = enabled;
  }

  public setGoalReplayEnabled(enabled: boolean): void {
    this.manifestConfig.goalReplayEnabled = enabled;
  }

  public setArenaPreset(preset: 'standard' | 'throwback'): void {
    this.manifestConfig.arenaPreset = preset;
  }

  public setReplayCameraMode(mode: 'director' | 'pov', focusedCarIndex?: number): void {
    this.replayCameraMode = mode;
    if (typeof focusedCarIndex === 'number' && focusedCarIndex >= 0) {
      this.focusedCarIndex = focusedCarIndex;
    }
  }

  public setPaused(paused: boolean): void {
    this.isPaused = paused;
  }

  public recordTouchIncident(tick: number, carIndex = 0): void {
    this.lastTouchTick = Math.floor(tick);
    this.focusedCarIndex = carIndex;
    this.enqueueSignal('car_ball_hit', tick, { carIndex });
  }

  public recordFlipResetIncident(tick: number, carIndex = 0): void {
    this.enqueueSignal('flip_reset_gained', tick, { carIndex });
  }

  public triggerKickoffReset(tick: number): void {
    this.subMode = 'live';
    this.phase = 'playing';
    this.celebrationTicksRemaining = 0;
    this.pendingGoalMeta = null;
    this.goalReplayFrames = [];
    this.goalReplayCursor = 0;
    this.lastTouchTick = -1;
    this.lastKickoffTick = Math.floor(tick);
    this.cameraMode = 'player';
    this.enqueueSignal('kickoff_reset', tick);
  }

  public triggerGoalScored(params: {
    tick: number;
    scoringTeam: 0 | 1;
    scorerCarIndex: number;
    scorerName: string;
    ballSpeedKph: number | null;
    celebrationTicks?: number;
  }): void {
    if (this.subMode === 'goal_replay' || this.phase === 'goal') return;
    this.goalIncidentTick = Math.floor(params.tick);
    this.phase = 'goal';
    this.celebrationTicksRemaining = params.celebrationTicks ?? DEFAULT_CELEBRATION_TICKS;
    this.pendingGoalMeta = {
      replayType: 'goal',
      scoringTeam: params.scoringTeam,
      scorerCarIndex: params.scorerCarIndex,
      scorerName: params.scorerName || 'Player',
      ballSpeedKph: params.ballSpeedKph,
    };
    this.focusedCarIndex = params.scorerCarIndex;
    this.enqueueSignal('goal_scored', params.tick, {
      team: params.scoringTeam,
      carIndex: params.scorerCarIndex,
      ballSpeedKph: params.ballSpeedKph,
    });
  }

  public triggerManualBallExpire(params: {
    tick: number;
    scoringTeam: 0 | 1;
    scorerCarIndex?: number;
    ballSpeedKph?: number | null;
    celebrationTicks?: number;
  }): boolean {
    if (this.subMode !== 'live' || this.phase !== 'playing') return false;
    const carIdx = params.scorerCarIndex ?? 0;
    this.goalIncidentTick = Math.floor(params.tick);
    this.phase = 'goal';
    this.celebrationTicksRemaining = params.celebrationTicks ?? DEFAULT_CELEBRATION_TICKS;
    this.pendingGoalMeta = {
      replayType: 'expire',
      scoringTeam: params.scoringTeam,
      scorerCarIndex: carIdx,
      scorerName: 'Player',
      ballSpeedKph: params.ballSpeedKph ?? null,
    };
    this.focusedCarIndex = carIdx;
    this.enqueueSignal('ball_expired', params.tick, {
      team: params.scoringTeam,
      carIndex: carIdx,
      ballSpeedKph: params.ballSpeedKph ?? null,
    });
    return true;
  }

  public skipGoalReplay(tick: number): boolean {
    if (this.subMode !== 'goal_replay' && this.phase !== 'goal') return false;
    this.enqueueSignal('goal_replay_end', tick, {
      team: this.pendingGoalMeta?.scoringTeam,
      carIndex: this.pendingGoalMeta?.scorerCarIndex,
    });
    this.triggerKickoffReset(tick);
    return true;
  }

  public handleRewinderCommand(action: RewinderAction, opts: RewinderCommandOptions = {}): boolean {
    return this.rewinder.handleCommand(action, opts, this.rewinderCallbacks);
  }

  public buildRewinderSliceManifest(chunkSizeBytes = 16384): FreeplayRewinderSliceManifest | null {
    return this.rewinder.buildSliceManifest(chunkSizeBytes);
  }

  public stepAndProduceFrame(liveSnapshot?: Float32Array | null): FreeplayFrameBundle {
    if (liveSnapshot && liveSnapshot.length >= 22) {
      this.lastLiveSnapshot = new Float32Array(liveSnapshot);
      this.lastTick = Math.floor(liveSnapshot[0] || this.lastTick + 1);
      if (this.subMode === 'live') {
        this.ringBuffer.recordFrame(this.lastTick, liveSnapshot);
        this.rewinder.recordLiveSnapshot(liveSnapshot);
      }
    } else if (this.subMode === 'live' && !this.isPaused) {
      this.lastTick += 1;
      this.lastLiveSnapshot[0] = this.lastTick;
      this.ringBuffer.recordFrame(this.lastTick, this.lastLiveSnapshot);
      this.rewinder.recordLiveSnapshot(this.lastLiveSnapshot);
    }

    this.advanceStateMachine();

    const activeSnap = this.resolveActiveSnapshot();
    const sourceTick = Math.floor(activeSnap[0] || this.lastTick);
    const playbackState = this.resolvePlaybackState();
    const playbackRate = this.resolvePlaybackRate(playbackState);
    const manifest = this.getManifest();
    const manifestChanged = manifest.metadataHash !== this.lastEmittedMetadataHash;
    this.lastEmittedMetadataHash = manifest.metadataHash;

    this.txSeq += 1;
    const isExpired = this.phase === 'goal' && this.pendingGoalMeta?.replayType === 'expire';
    const ball = extractBallFromSnapshot(activeSnap, isExpired);
    const cars = extractCarsFromSnapshot(activeSnap, manifest.cars);
    const boostPadMask = extractBoostPadMaskFromSnapshot(activeSnap);
    const cameraPose = computeFreeplaySpectateCameraPose({
      subMode: this.subMode,
      replayCameraMode: this.replayCameraMode,
      focusedCarIndex: this.focusedCarIndex,
      ball,
      cars,
    });

    const stateFrame: FreeplayStateFramePayload = {
      txSeq: this.txSeq,
      schemaHash: FREEPLAY_W104_TEMP_SCHEMA_HASH,
      metadataHash: manifest.metadataHash,
      sourceTick,
      subMode: this.subMode,
      playbackState,
      playbackRate,
      phase: this.phase,
      clockSecondsRemaining: this.computeClockSecondsRemaining(),
      unlimitedBoost: manifest.unlimitedBoost,
      boostPadMask,
      focusedCarIndex: this.focusedCarIndex,
      cameraMode: this.subMode === 'goal_replay' ? this.replayCameraMode : this.cameraMode,
      cameraPose,
      replayCursorFrame: this.resolveReplayCursorFrame(),
      replayTotalFrames: this.resolveReplayTotalFrames(),
      rewinderState: this.rewinder.state,
      ball,
      cars,
      goalReplayMeta: this.pendingGoalMeta ? { ...this.pendingGoalMeta } : null,
    };

    const signals = this.pendingSignals.splice(0, this.pendingSignals.length);
    return { stateFrame, signals, manifestChanged, manifest };
  }

  public getStateSummary(): Record<string, unknown> {
    const manifest = this.getManifest();
    const playbackState = this.resolvePlaybackState();
    return {
      activityId: 'freeplay',
      subMode: this.subMode,
      phase: this.phase,
      playbackState,
      playbackRate: this.resolvePlaybackRate(playbackState),
      txSeq: this.txSeq,
      metadataHash: manifest.metadataHash,
      unlimitedBoost: manifest.unlimitedBoost,
      goalReplayEnabled: manifest.goalReplayEnabled,
      rewinderState: this.rewinder.state,
      replayCursorFrame: this.resolveReplayCursorFrame(),
      replayTotalFrames: this.resolveReplayTotalFrames(),
      focusedCarIndex: this.focusedCarIndex,
      matchTick: this.lastTick,
    };
  }

  private enqueueSignal(
    kind: FreeplaySignalKind,
    sourceTick: number,
    extra: Partial<Omit<FreeplaySignalEvent, 'signalId' | 'txSeq' | 'sourceTick' | 'kind'>> = {}
  ): void {
    this.signalId += 1;
    this.pendingSignals.push({
      signalId: this.signalId,
      txSeq: this.txSeq + 1,
      sourceTick: Math.floor(sourceTick),
      kind,
      ...extra,
    });
  }

  private advanceStateMachine(): void {
    if (this.subMode === 'live' && this.phase === 'goal') {
      if (this.celebrationTicksRemaining > 0) this.celebrationTicksRemaining -= 1;
      if (this.celebrationTicksRemaining <= 0) {
        if (this.manifestConfig.goalReplayEnabled && this.beginGoalReplayFromBuffer()) return;
        this.triggerKickoffReset(this.lastTick);
      }
      return;
    }
    if (this.subMode === 'goal_replay') {
      if (!this.isPaused && this.goalReplayFrames.length > 0) {
        this.goalReplayCursor += this.goalReplaySlowMoRate;
        if (this.goalReplayCursor >= this.goalReplayFrames.length - 1) {
          this.enqueueSignal('goal_replay_end', this.lastTick, {
            team: this.pendingGoalMeta?.scoringTeam,
            carIndex: this.pendingGoalMeta?.scorerCarIndex,
          });
          this.triggerKickoffReset(this.lastTick);
        }
      }
      return;
    }
    if (this.subMode === 'rewind') {
      this.rewinder.step(this.rewinderCallbacks);
    }
  }

  private beginGoalReplayFromBuffer(): boolean {
    const frames = extractFreeplayGoalReplaySnapshots({
      ringBuffer: this.ringBuffer,
      replayType: this.pendingGoalMeta?.replayType === 'expire' ? 'expire' : 'goal',
      goalIncidentTick: this.goalIncidentTick,
      lastTouchTick: this.lastTouchTick,
      lastKickoffTick: this.lastKickoffTick,
      currentTick: this.lastTick,
    });
    if (frames.length === 0) return false;
    this.goalReplayFrames = frames;
    this.goalReplayCursor = 0;
    this.subMode = 'goal_replay';
    this.phase = 'replay';
    this.cameraMode = this.replayCameraMode;
    this.enqueueSignal('goal_replay_start', this.lastTick, {
      team: this.pendingGoalMeta?.scoringTeam,
      carIndex: this.pendingGoalMeta?.scorerCarIndex,
      ballSpeedKph: this.pendingGoalMeta?.ballSpeedKph ?? null,
    });
    return true;
  }

  private resolveActiveSnapshot(): Float32Array {
    if (this.subMode === 'goal_replay' && this.goalReplayFrames.length > 0) {
      const idx = Math.max(
        0,
        Math.min(this.goalReplayFrames.length - 1, Math.round(this.goalReplayCursor))
      );
      return this.goalReplayFrames[idx];
    }
    if (this.subMode === 'rewind') {
      return this.rewinder.getActiveSnapshot() ?? this.lastLiveSnapshot;
    }
    return this.lastLiveSnapshot;
  }

  private resolvePlaybackState(): FreeplayPlaybackState {
    if (this.isPaused) return 'paused';
    if (this.subMode === 'rewind') return this.rewinder.resolvePlaybackState();
    return 'playing';
  }

  private resolvePlaybackRate(playbackState: FreeplayPlaybackState): number {
    if (playbackState === 'paused') return 0;
    if (playbackState === 'rewinding') return -this.rewinder.scrubRate;
    if (this.subMode === 'goal_replay') return this.goalReplaySlowMoRate;
    if (this.subMode === 'rewind' && this.rewinder.state === 'forwarding') {
      return this.rewinder.scrubRate;
    }
    return 1.0;
  }

  private computeClockSecondsRemaining(): number {
    if (this.subMode === 'rewind') return this.rewinder.computeClockSecondsRemaining();
    if (this.subMode === 'goal_replay' && this.goalReplayFrames.length > 0) {
      const remFrames = Math.max(0, this.goalReplayFrames.length - 1 - this.goalReplayCursor);
      return Number(
        (remFrames / (DEFAULT_TICKS_PER_SECOND * Math.max(0.1, this.goalReplaySlowMoRate))).toFixed(
          2
        )
      );
    }
    return 0;
  }

  private resolveReplayCursorFrame(): number {
    if (this.subMode === 'goal_replay') return Math.round(this.goalReplayCursor);
    if (this.subMode === 'rewind') return Math.round(this.rewinder.cursor);
    return -1;
  }

  private resolveReplayTotalFrames(): number {
    if (this.subMode === 'goal_replay') return this.goalReplayFrames.length;
    if (this.subMode === 'rewind') return this.rewinder.frames.length;
    return 0;
  }
}
