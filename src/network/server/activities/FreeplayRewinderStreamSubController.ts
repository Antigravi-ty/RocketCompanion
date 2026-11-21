/**
 * src/network/server/activities/FreeplayRewinderStreamSubController.ts
 * Functional domain sub-controller for Freeplay Rewinder stream state:
 * recording, rewinding/forwarding scrub, paused-scrub, 3-2-1 preroll-countdown,
 * and Channel 4 historical slice manifest generation.
 */

import type {
  FreeplayPhase,
  FreeplayPlaybackState,
  FreeplayRewinderSliceManifest,
  FreeplayRewinderState,
  FreeplaySubMode,
} from './freeplaySpectateTypes.ts';
import { computeRewinderSliceHash } from './freeplaySnapshotReader.ts';

export const DEFAULT_PREROLL_SECONDS = 3;
export const DEFAULT_TICKS_PER_SECOND = 120;

export type RewinderAction =
  | 'start_recording'
  | 'stop_recording'
  | 'begin_scrub'
  | 'pause_scrub'
  | 'seek_frame'
  | 'resume_from_here'
  | 'clear_buffer';

export interface RewinderCommandOptions {
  direction?: 'rewinding' | 'forwarding';
  frameIndex?: number;
  scrubRate?: number;
}

export interface RewinderStepCallbacks {
  onStateChange: (next: FreeplayRewinderState) => void;
  onCountdownTick: (wholeSeconds: number) => void;
  onEnterSubMode: (subMode: FreeplaySubMode, phase: FreeplayPhase) => void;
  onInterveneToLive: (snapshot: Float32Array) => void;
}

export class FreeplayRewinderStreamSubController {
  public state: FreeplayRewinderState = 'idle';
  public frames: Float32Array[] = [];
  public cursor = 0;
  public scrubRate = 1.0;
  public countdownTicksRemaining = 0;
  private lastCountdownWholeSec = -1;

  public recordLiveSnapshot(snapshot: Float32Array): void {
    if (this.state === 'recording') {
      this.frames.push(new Float32Array(snapshot));
    }
  }

  public handleCommand(
    action: RewinderAction,
    opts: RewinderCommandOptions,
    cb: RewinderStepCallbacks
  ): boolean {
    if (action === 'start_recording') {
      this.frames = [];
      this.cursor = 0;
      cb.onEnterSubMode('live', 'playing');
      this.transitionState('recording', cb);
      return true;
    }
    if (action === 'stop_recording') {
      this.cursor = Math.max(0, this.frames.length - 1);
      this.transitionState('stopped', cb);
      return true;
    }
    if (action === 'clear_buffer') {
      this.frames = [];
      this.cursor = 0;
      cb.onEnterSubMode('live', 'playing');
      this.transitionState('idle', cb);
      return true;
    }
    if (this.frames.length === 0) return false;

    if (action === 'begin_scrub') {
      const dir = opts.direction === 'forwarding' ? 'forwarding' : 'rewinding';
      this.scrubRate = Math.max(0.25, opts.scrubRate ?? 1.0);
      cb.onEnterSubMode('rewind', 'replay');
      this.transitionState(dir, cb);
      return true;
    }
    if (action === 'pause_scrub') {
      cb.onEnterSubMode('rewind', 'replay');
      this.transitionState('paused-scrub', cb);
      return true;
    }
    if (action === 'seek_frame') {
      const idx = Math.max(
        0,
        Math.min(this.frames.length - 1, Math.round(opts.frameIndex ?? this.cursor))
      );
      this.cursor = idx;
      cb.onEnterSubMode('rewind', 'replay');
      this.transitionState('paused-scrub', cb);
      return true;
    }
    if (action === 'resume_from_here') {
      cb.onEnterSubMode('rewind', 'countdown');
      this.countdownTicksRemaining = DEFAULT_PREROLL_SECONDS * DEFAULT_TICKS_PER_SECOND;
      this.lastCountdownWholeSec = DEFAULT_PREROLL_SECONDS + 1;
      this.transitionState('preroll-countdown', cb);
      return true;
    }
    return false;
  }

  public step(cb: RewinderStepCallbacks): void {
    if (this.frames.length === 0) return;
    if (this.state === 'rewinding') {
      this.cursor = Math.max(0, this.cursor - this.scrubRate);
      return;
    }
    if (this.state === 'forwarding') {
      this.cursor = Math.min(this.frames.length - 1, this.cursor + this.scrubRate);
      return;
    }
    if (this.state === 'preroll-countdown') {
      this.countdownTicksRemaining = Math.max(0, this.countdownTicksRemaining - 1);
      const wholeSec = Math.ceil(this.countdownTicksRemaining / DEFAULT_TICKS_PER_SECOND);
      if (wholeSec < this.lastCountdownWholeSec && wholeSec >= 0) {
        this.lastCountdownWholeSec = wholeSec;
        cb.onCountdownTick(wholeSec);
      }
      if (this.countdownTicksRemaining <= 0) {
        const idx = Math.max(0, Math.min(this.frames.length - 1, Math.round(this.cursor)));
        cb.onInterveneToLive(new Float32Array(this.frames[idx]));
        this.transitionState('stopped', cb);
      }
    }
  }

  public getActiveSnapshot(): Float32Array | null {
    if (this.frames.length === 0) return null;
    const idx = Math.max(0, Math.min(this.frames.length - 1, Math.round(this.cursor)));
    return this.frames[idx];
  }

  public resolvePlaybackState(): FreeplayPlaybackState {
    if (this.state === 'rewinding') return 'rewinding';
    if (this.state === 'forwarding') return 'playing';
    return 'paused';
  }

  public computeClockSecondsRemaining(): number {
    if (this.state === 'preroll-countdown') {
      return Number((this.countdownTicksRemaining / DEFAULT_TICKS_PER_SECOND).toFixed(2));
    }
    return 0;
  }

  public buildSliceManifest(chunkSizeBytes = 16384): FreeplayRewinderSliceManifest | null {
    if (this.frames.length === 0) return null;
    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    const byteLength = this.frames.reduce((acc, f) => acc + f.byteLength, 0);
    return {
      fileHash: computeRewinderSliceHash(this.frames),
      totalFrames: this.frames.length,
      startTick: Math.floor(first[0] || 0),
      endTick: Math.floor(last[0] || 0),
      cursorFrame: Math.round(this.cursor),
      byteLength,
      chunkCount: Math.max(1, Math.ceil(byteLength / Math.max(1024, chunkSizeBytes))),
    };
  }

  private transitionState(next: FreeplayRewinderState, cb: RewinderStepCallbacks): void {
    if (this.state === next) return;
    this.state = next;
    cb.onStateChange(next);
  }
}
