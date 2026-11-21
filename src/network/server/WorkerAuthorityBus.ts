/**
 * src/network/server/WorkerAuthorityBus.ts
 * Wave 1 (W1-01): Unified Web Worker Authority Bus for Match, Freeplay, Exhibition, and Replay.
 *
 * - Runs on a Worker-local timer loop (`setTimeout`) completely decoupled from main-thread
 *   `requestAnimationFrame`, eliminating 1Hz background-tab throttling.
 * - Pushes Channel 1 state frames into a 10-frame monotonic `txSeq` sliding window.
 * - Trims frames per session using `EstablishedSessionManager` `lastAckedTxSeq`.
 */

import type { EstablishedSessionManager } from './EstablishedSessionManager.ts';
import type { NetworkDataHandler } from './NetworkDataHandler.ts';
import type { MatchSessionAdmin } from './match/MatchSessionAdmin.ts';
import type { PhysicsEngineManager } from './PhysicsEngineManager.ts';
import { VNEXT_CHANNEL1_SCHEMA_HASH } from '../protocol/VNextSchemaHash.ts';
import { VNextWorldFrameCodec, type VNextFramePhase } from '../protocol/VNextWorldFrameCodec.ts';
import {
  DEFAULT_SLIDING_WINDOW_CAPACITY,
  StateFrameSlidingWindow,
  type SessionTrimmedBatch,
  type WorkerBusActivityMode,
  type WorkerBusPlaybackState,
  type WorkerChannel1StateFrame,
} from './StateFrameSlidingWindow.ts';

export const SUPPORTED_BROADCAST_HZ = Object.freeze([15, 30, 60, 120] as const);

export interface ReplayCursorState {
  playbackState: WorkerBusPlaybackState;
  playbackSpeed: number;
  currentFrameIndex: number;
  totalFrames: number;
  replayFps: number;
}

export interface WorkerBusStepOutput {
  payloadBytes: Uint8Array;
  simTick?: number;
  replayFrameIndex?: number;
  phase?: string;
  clockSeconds?: number;
  focusedCarIndex?: number;
  metadataHash?: number;
}

export type WorkerBusModeStepper = (
  dtSeconds: number,
  mode: WorkerBusActivityMode,
  replayCursor: Readonly<ReplayCursorState>
) => WorkerBusStepOutput | null;

export interface WorkerAuthorityBusOptions {
  matchManager?: MatchSessionAdmin | null;
  sessionManager?: EstablishedSessionManager | null;
  physicsManager?: PhysicsEngineManager | null;
  dataHandler?: NetworkDataHandler | null;
  activityMode?: WorkerBusActivityMode;
  broadcastHz?: number;
  fixedPhysicsHz?: number;
  windowCapacity?: number;
  schemaHash?: number;
  metadataHash?: number;
  nowMs?: () => number;
  modeStepper?: WorkerBusModeStepper | null;
  onDispatchSessionBatch?: ((batch: SessionTrimmedBatch) => void) | null;
  onFramePublished?: ((frame: WorkerChannel1StateFrame) => void) | null;
}

export class WorkerAuthorityBus {
  matchManager: MatchSessionAdmin | null;
  sessionManager: EstablishedSessionManager | null;
  physicsManager: PhysicsEngineManager | null;
  dataHandler: NetworkDataHandler | null;

  readonly slidingWindow: StateFrameSlidingWindow;
  private activityMode: WorkerBusActivityMode;
  private broadcastHz: number;
  private readonly fixedTimestepSec: number;
  private schemaHash: number;
  private metadataHash: number;
  private readonly nowMs: () => number;

  private modeStepper: WorkerBusModeStepper | null;
  private onDispatchSessionBatch: ((batch: SessionTrimmedBatch) => void) | null;
  private onFramePublished: ((frame: WorkerChannel1StateFrame) => void) | null;

  private replayCursor: ReplayCursorState = {
    playbackState: 'paused',
    playbackSpeed: 1,
    currentFrameIndex: 0,
    totalFrames: 0,
    replayFps: 60,
  };
  private replayFrameAccumulator = 0;

  private running = false;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private lastTickMs = -1;
  private physicsAccumulatorSec = 0;
  private broadcastAccumulatorMs = 0;
  private latestStepOutput: WorkerBusStepOutput | null = null;
  private publishedFrameCount = 0;

  constructor(options: WorkerAuthorityBusOptions = {}) {
    this.matchManager = options.matchManager ?? null;
    this.sessionManager = options.sessionManager ?? null;
    this.physicsManager = options.physicsManager ?? null;
    this.dataHandler = options.dataHandler ?? null;

    this.slidingWindow = new StateFrameSlidingWindow(
      options.windowCapacity ?? DEFAULT_SLIDING_WINDOW_CAPACITY
    );
    this.activityMode = options.activityMode ?? 'match';
    this.broadcastHz = this.clampBroadcastHz(options.broadcastHz ?? 60);
    const physicsHz = Math.max(30, Math.min(240, options.fixedPhysicsHz ?? 120));
    this.fixedTimestepSec = 1.0 / physicsHz;
    this.schemaHash = options.schemaHash ?? VNEXT_CHANNEL1_SCHEMA_HASH;
    this.metadataHash = options.metadataHash ?? 0;
    this.nowMs =
      options.nowMs ??
      (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.modeStepper = options.modeStepper ?? null;
    this.onDispatchSessionBatch = options.onDispatchSessionBatch ?? null;
    this.onFramePublished = options.onFramePublished ?? null;
  }

  private clampBroadcastHz(hz: number): number {
    if (!Number.isFinite(hz) || hz <= 0) return 60;
    return Math.max(1, Math.min(120, Math.round(hz)));
  }

  get isRunning(): boolean {
    return this.running;
  }

  getActivityMode(): WorkerBusActivityMode {
    return this.activityMode;
  }

  getBroadcastHz(): number {
    return this.broadcastHz;
  }

  getPublishedFrameCount(): number {
    return this.publishedFrameCount;
  }

  getReplayCursor(): Readonly<ReplayCursorState> {
    return { ...this.replayCursor };
  }

  setActivityMode(mode: WorkerBusActivityMode): void {
    this.activityMode = mode;
    this.physicsAccumulatorSec = 0;
    this.broadcastAccumulatorMs = 0;
  }

  setBroadcastHz(hz: number): void {
    this.broadcastHz = this.clampBroadcastHz(hz);
  }

  setMetadataHash(hash: number): void {
    this.metadataHash = hash >>> 0;
  }

  setModeStepper(stepper: WorkerBusModeStepper | null): void {
    this.modeStepper = stepper;
  }

  setDispatchSessionBatchHandler(handler: ((batch: SessionTrimmedBatch) => void) | null): void {
    this.onDispatchSessionBatch = handler;
  }

  configureReplayCursor(partial: Partial<ReplayCursorState> & { seekFrameIndex?: number }): void {
    if (partial.totalFrames !== undefined) {
      this.replayCursor.totalFrames = Math.max(0, Math.floor(partial.totalFrames));
    }
    if (partial.replayFps !== undefined && partial.replayFps > 0) {
      this.replayCursor.replayFps = partial.replayFps;
    }
    if (partial.playbackSpeed !== undefined && Number.isFinite(partial.playbackSpeed)) {
      this.replayCursor.playbackSpeed = partial.playbackSpeed;
    }
    if (partial.playbackState !== undefined) {
      this.replayCursor.playbackState = partial.playbackState;
    }
    if (partial.seekFrameIndex !== undefined) {
      const maxIdx = Math.max(0, this.replayCursor.totalFrames - 1);
      this.replayCursor.currentFrameIndex = Math.max(
        0,
        Math.min(maxIdx, Math.floor(partial.seekFrameIndex))
      );
      this.replayFrameAccumulator = 0;
      this.publishCurrentState(this.nowMs());
    } else if (partial.currentFrameIndex !== undefined) {
      const maxIdx = Math.max(0, this.replayCursor.totalFrames - 1);
      this.replayCursor.currentFrameIndex = Math.max(
        0,
        Math.min(maxIdx, Math.floor(partial.currentFrameIndex))
      );
    }
  }

  recordSessionTxSeqAck(sessionId: string, ackedTxSeq: number): number {
    if (!this.sessionManager) return 0;
    return this.sessionManager.recordClientTxSeqAck(sessionId, ackedTxSeq);
  }

  start(pollIntervalMs = 2): void {
    if (this.running) return;
    this.running = true;
    this.lastTickMs = this.nowMs();
    this.physicsAccumulatorSec = 0;
    this.broadcastAccumulatorMs = 0;

    const interval = Math.max(1, Math.min(50, Math.floor(pollIntervalMs)));
    const tickLoop = () => {
      if (!this.running) return;
      const now = this.nowMs();
      this.stepAtTimestamp(now);
      if (this.running) {
        this.timerHandle = setTimeout(tickLoop, interval);
      }
    };

    this.timerHandle = setTimeout(tickLoop, 0);
  }

  stop(): void {
    this.running = false;
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  stepWithElapsedMs(elapsedMs: number): number {
    const base = this.lastTickMs >= 0 ? this.lastTickMs : this.nowMs();
    return this.stepAtTimestamp(base + Math.max(0, elapsedMs));
  }

  stepAtTimestamp(nowMs: number): number {
    if (this.lastTickMs < 0) {
      this.lastTickMs = nowMs;
      return 0;
    }

    const rawDeltaMs = Math.max(0, nowMs - this.lastTickMs);
    this.lastTickMs = nowMs;
    const clampedSec = Math.min(rawDeltaMs / 1000.0, 0.25);

    this.physicsAccumulatorSec += clampedSec;
    while (this.physicsAccumulatorSec >= this.fixedTimestepSec) {
      this.physicsAccumulatorSec -= this.fixedTimestepSec;
      this.stepSingleModeTick(this.fixedTimestepSec);
    }

    const broadcastIntervalMs = 1000.0 / this.broadcastHz;
    this.broadcastAccumulatorMs += rawDeltaMs;
    let publishedThisCall = 0;

    while (this.broadcastAccumulatorMs + 1e-4 >= broadcastIntervalMs) {
      this.broadcastAccumulatorMs = Math.max(0, this.broadcastAccumulatorMs - broadcastIntervalMs);
      if (this.publishCurrentState(nowMs)) {
        publishedThisCall += 1;
      }
    }

    return publishedThisCall;
  }

  private stepSingleModeTick(dtSeconds: number): void {
    if (this.activityMode === 'replay') {
      this.advanceReplayCursor(dtSeconds);
    }

    if (this.modeStepper) {
      const out = this.modeStepper(dtSeconds, this.activityMode, this.getReplayCursor());
      if (out) {
        this.latestStepOutput = out;
        return;
      }
    }

    if (this.matchManager) {
      const bytes = this.matchManager.lifecycle.stepFrame();
      if (bytes && bytes.length > 0) {
        this.latestStepOutput = {
          payloadBytes: bytes,
          simTick: this.physicsManager?.currentTick ?? this.matchManager.lifecycle.matchTick,
          phase: this.matchManager.lifecycle.state,
          clockSeconds: this.matchManager.domain.clockSecondsRemaining,
        };
      }
    }
  }

  private advanceReplayCursor(dtSeconds: number): void {
    const { playbackState, playbackSpeed, totalFrames, replayFps } = this.replayCursor;
    if (totalFrames <= 0 || playbackState === 'paused') return;

    const effectiveSpeed =
      playbackState === 'rewinding' ? -Math.abs(playbackSpeed || 1) : playbackSpeed || 1;
    this.replayFrameAccumulator += dtSeconds * replayFps * effectiveSpeed;

    const wholeDelta =
      this.replayFrameAccumulator >= 0
        ? Math.floor(this.replayFrameAccumulator)
        : Math.ceil(this.replayFrameAccumulator);

    if (wholeDelta !== 0) {
      this.replayFrameAccumulator -= wholeDelta;
      const nextIdx = this.replayCursor.currentFrameIndex + wholeDelta;
      this.replayCursor.currentFrameIndex = Math.max(0, Math.min(totalFrames - 1, nextIdx));
    }
  }

  publishCurrentState(timestampMs = this.nowMs()): WorkerChannel1StateFrame | null {
    const stepOut = this.latestStepOutput;
    if (!stepOut?.payloadBytes?.length && !this.modeStepper && !this.matchManager) {
      return null;
    }

    const playbackState: WorkerBusPlaybackState =
      this.activityMode === 'replay' ? this.replayCursor.playbackState : 'playing';
    const phase = stepOut?.phase ?? this.matchManager?.lifecycle.state ?? 'playing';
    const clockSeconds = stepOut?.clockSeconds ?? this.matchManager?.domain.clockSecondsRemaining ?? 0;
    const simTick = stepOut?.simTick ?? this.physicsManager?.currentTick ?? 0;
    const replayFrameIndex =
      stepOut?.replayFrameIndex ??
      (this.activityMode === 'replay' ? this.replayCursor.currentFrameIndex : 0);
    const focusedCarIndex = stepOut?.focusedCarIndex ?? 0;
    const metadataHash = stepOut?.metadataHash ?? this.metadataHash;

    const payloadBytes =
      stepOut?.payloadBytes && stepOut.payloadBytes.length > 0
        ? stepOut.payloadBytes
        : VNextWorldFrameCodec.encode({
            txSeq: this.slidingWindow.getLatestTxSeq() + 1,
            metadataHash,
            activityMode: this.activityMode,
            playbackState,
            phase: phase as VNextFramePhase,
            simTick,
            replayFrameIndex,
            replayTotalFrames: this.replayCursor.totalFrames,
            clockSeconds,
            playbackSpeed: this.replayCursor.playbackSpeed,
            focusedCarIndex,
            timestampMs,
          });

    const frame = this.slidingWindow.pushFrame({
      schemaHash: this.schemaHash,
      metadataHash,
      activityMode: this.activityMode,
      playbackState,
      phase,
      clockSeconds,
      simTick,
      replayFrameIndex,
      focusedCarIndex,
      timestampMs,
      payloadBytes,
    });

    this.publishedFrameCount += 1;
    this.onFramePublished?.(frame);
    this.dispatchWindowToSessions();
    return frame;
  }

  dispatchWindowToSessions(): SessionTrimmedBatch[] {
    const batches: SessionTrimmedBatch[] = [];
    if (!this.sessionManager) return batches;

    const sessions = this.sessionManager.getAllSessions();
    const latestTxSeq = this.slidingWindow.getLatestTxSeq();

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      if (s.sessionId === 'bot' || s.sessionId.startsWith('bot_')) continue;
      const ch = this.dataHandler?.channels.get(s.sessionId);
      if (ch?.isVirtualBot) continue;

      const frames = this.slidingWindow.getUnackedFramesForSession(s.lastAckedTxSeq);
      const batch: SessionTrimmedBatch = {
        sessionId: s.sessionId,
        lastAckedTxSeq: s.lastAckedTxSeq,
        latestTxSeq,
        frames,
      };
      batches.push(batch);
      this.onDispatchSessionBatch?.(batch);

      if (this.dataHandler && frames.length > 0 && !this.onDispatchSessionBatch) {
        const latest = frames[frames.length - 1];
        if (latest.payloadBytes.length > 0) {
          this.dataHandler.dispatchFrameToSessions(latest.payloadBytes);
        }
      }
    }

    return batches;
  }

  destroy(): void {
    this.stop();
    this.slidingWindow.clear(true);
    this.latestStepOutput = null;
    this.publishedFrameCount = 0;
    this.lastTickMs = -1;
  }
}
