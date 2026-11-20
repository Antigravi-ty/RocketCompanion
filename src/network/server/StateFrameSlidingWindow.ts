/**
 * src/network/server/StateFrameSlidingWindow.ts
 * Wave 1 (W1-01): Channel 1 monotonic txSeq sliding window (default 10 frames)
 * with per-session ack trimming.
 *
 * Trimming MUST compare monotonic `txSeq` rather than `simTick` or `replayFrameIndex`
 * so forward playback, pause, rewind, and seek are 100% symmetric.
 */

export type WorkerBusActivityMode = 'match' | 'freeplay' | 'exhibition' | 'replay';

export type WorkerBusPlaybackState = 'playing' | 'paused' | 'rewinding' | 'seeking';

/** Wave 1 placeholder schemaHash (4-byte HEX) until Wave 2 binary codec alignment. */
export const WAVE1_CHANNEL1_SCHEMA_HASH = 0x57313031; // "W101"

export const DEFAULT_SLIDING_WINDOW_CAPACITY = 10;

export interface WorkerChannel1StateFrame {
  readonly txSeq: number;
  readonly schemaHash: number;
  readonly metadataHash: number;
  readonly activityMode: WorkerBusActivityMode;
  readonly playbackState: WorkerBusPlaybackState;
  readonly phase: string;
  readonly clockSeconds: number;
  readonly simTick: number;
  readonly replayFrameIndex: number;
  readonly focusedCarIndex: number;
  readonly timestampMs: number;
  readonly payloadBytes: Uint8Array;
}

export type WorkerChannel1StateFrameInput = Omit<WorkerChannel1StateFrame, 'txSeq'>;

export interface SessionTrimmedBatch {
  readonly sessionId: string;
  readonly lastAckedTxSeq: number;
  readonly latestTxSeq: number;
  readonly frames: readonly WorkerChannel1StateFrame[];
}

export class StateFrameSlidingWindow {
  readonly maxWindowSize: number;
  private nextTxSeq = 0;
  private readonly frames: WorkerChannel1StateFrame[] = [];

  constructor(maxWindowSize = DEFAULT_SLIDING_WINDOW_CAPACITY) {
    this.maxWindowSize = Math.max(1, Math.floor(maxWindowSize));
  }

  getLatestTxSeq(): number {
    return this.nextTxSeq;
  }

  get size(): number {
    return this.frames.length;
  }

  getLatestFrame(): WorkerChannel1StateFrame | null {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1] : null;
  }

  getWindowFrames(): readonly WorkerChannel1StateFrame[] {
    return this.frames.slice();
  }

  /**
   * Assigns a strictly monotonic `txSeq` and appends the frame to the sliding window.
   * Evicts the oldest frame if the window exceeds `maxWindowSize`.
   */
  pushFrame(input: WorkerChannel1StateFrameInput): WorkerChannel1StateFrame {
    this.nextTxSeq = (this.nextTxSeq + 1) >>> 0;
    if (this.nextTxSeq === 0) {
      this.nextTxSeq = 1;
    }

    const frame: WorkerChannel1StateFrame = {
      ...input,
      txSeq: this.nextTxSeq,
    };

    this.frames.push(frame);
    while (this.frames.length > this.maxWindowSize) {
      this.frames.shift();
    }

    return frame;
  }

  /**
   * Returns all frames currently in the sliding window with `txSeq > lastAckedTxSeq`.
   * - On a healthy connection where the client acked `N - 1`, returns `[frame(N)]` (1-frame delta).
   * - On a lossy connection where the client missed `N - 3 .. N - 1`, returns `[N - 3, N - 2, N - 1, N]`.
   * - Because comparison uses monotonic `txSeq`, rewind (`simTick`/`replayFrameIndex` decreasing)
   *   and seek behave identically to forward playback.
   */
  getUnackedFramesForSession(lastAckedTxSeq: number): WorkerChannel1StateFrame[] {
    const acked = Math.max(0, Math.floor(lastAckedTxSeq));
    if (this.frames.length === 0) return [];

    const out: WorkerChannel1StateFrame[] = [];
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      if (f.txSeq > acked) {
        out.push(f);
      }
    }
    return out;
  }

  /**
   * Globally prunes frames from the front of the window that have been acknowledged
   * by all active sessions (`txSeq <= minAckedTxSeq`).
   * Optionally preserves the most recent frame (`keepLatest = true`) for late-join inspection.
   */
  pruneAckedByAllSessions(minAckedTxSeq: number, keepLatest = false): number {
    const minSeq = Math.max(0, Math.floor(minAckedTxSeq));
    if (minSeq <= 0 || this.frames.length === 0) return 0;

    const minRemaining = keepLatest ? 1 : 0;
    let pruned = 0;
    while (this.frames.length > minRemaining && this.frames[0].txSeq <= minSeq) {
      this.frames.shift();
      pruned += 1;
    }
    return pruned;
  }

  clear(resetSeq = false): void {
    this.frames.length = 0;
    if (resetSeq) {
      this.nextTxSeq = 0;
    }
  }
}
