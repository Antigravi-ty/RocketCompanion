/**
 * ReplayWatchCursorEngine.ts
 * Worker-compatible Replay Watch Together cursor & frame stream engine (W1-05).
 * Drives forward/rewind/fast-forward/pause/seek/speed/focus without main-thread rAF,
 * emitting ReplayWatchFrameStreamPacket with strictly monotonic txSeq.
 */

import {
  BALL_STATE_OFFSETS,
  BOOST_PAD_OFFSETS,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  NUM_BOOST_PADS,
  SIM_OFFSETS,
} from '../../physics/RocketSimConstants.ts';
import { resolveCarEntryFromManifest } from './ReplayWatchRosterManifest.ts';
import type {
  ReplayWatchBallState,
  ReplayWatchCameraMode,
  ReplayWatchCameraPose,
  ReplayWatchCarFrameState,
  ReplayWatchCursorStatus,
  ReplayWatchDirection,
  ReplayWatchFrameStreamPacket,
  ReplayWatchPlaybackCommand,
  ReplayWatchPlaybackState,
  ReplayWatchRosterManifest,
  ReplayWatchScoreboardState,
  ReplayWatchSignalEvent,
  ReplayWatchVec3,
} from './ReplayWatchTogetherTypes.ts';

const MIN_SPEED = 0.05;
const MAX_SPEED = 16.0;

export interface ReplayWatchFrameSource {
  getFrameAt(frameIndex: number): Float32Array | null;
  getSignalsInRange?(startFrame: number, endFrame: number): readonly ReplayWatchSignalEvent[];
  evaluateScoreboardAtFrame?(frameIndex: number): ReplayWatchScoreboardState;
}

const DEFAULT_VEC3: ReplayWatchVec3 = { x: 0, y: 0, z: 0 };

const DEFAULT_BALL_STATE: ReplayWatchBallState = {
  pos: DEFAULT_VEC3,
  vel: DEFAULT_VEC3,
  angVel: DEFAULT_VEC3,
  fwd: { x: 1, y: 0, z: 0 },
  right: { x: 0, y: 1, z: 0 },
  up: { x: 0, y: 0, z: 1 },
};

const DEFAULT_SCOREBOARD: ReplayWatchScoreboardState = {
  matchPhase: 'playing',
  blueScore: 0,
  orangeScore: 0,
  remainingSeconds: 300,
  isOvertime: false,
  overtimeSeconds: 0,
};

function readVec3(buf: Float32Array, offset: number): ReplayWatchVec3 {
  if (offset + 2 >= buf.length) return DEFAULT_VEC3;
  return {
    x: Number(buf[offset]) || 0,
    y: Number(buf[offset + 1]) || 0,
    z: Number(buf[offset + 2]) || 0,
  };
}

function clampSpeed(speed: number | undefined, fallback: number): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
    return fallback;
  }
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));
}

function resolveDirection(state: ReplayWatchPlaybackState): ReplayWatchDirection {
  if (state === 'playing' || state === 'forwarding') return 1;
  if (state === 'rewinding') return -1;
  return 0;
}

export function extractBallStateFromSnapshot(snap: Float32Array | null): ReplayWatchBallState {
  if (!snap || snap.length < SIM_OFFSETS.BALL + 18) return DEFAULT_BALL_STATE;
  const b = SIM_OFFSETS.BALL;
  return {
    pos: readVec3(snap, b + BALL_STATE_OFFSETS.POS),
    vel: readVec3(snap, b + BALL_STATE_OFFSETS.VEL),
    angVel: readVec3(snap, b + BALL_STATE_OFFSETS.ANG_VEL),
    fwd: readVec3(snap, b + BALL_STATE_OFFSETS.FWD),
    right: readVec3(snap, b + BALL_STATE_OFFSETS.RIGHT),
    up: readVec3(snap, b + BALL_STATE_OFFSETS.UP),
  };
}

export function extractCarStatesFromSnapshot(
  snap: Float32Array | null,
  manifest: ReplayWatchRosterManifest
): ReplayWatchCarFrameState[] {
  if (!snap) return [];
  const cars: ReplayWatchCarFrameState[] = [];
  for (let i = 0; i < manifest.cars.length; i++) {
    const carIndex = manifest.cars[i].carIndex;
    const base = SIM_OFFSETS.CARS + carIndex * CAR_STATE_STRIDE;
    if (base + CAR_STATE_OFFSETS.IS_FLIPPING >= snap.length) continue;
    cars.push({
      carIndex,
      pos: readVec3(snap, base + CAR_STATE_OFFSETS.POS),
      vel: readVec3(snap, base + CAR_STATE_OFFSETS.VEL),
      angVel: readVec3(snap, base + CAR_STATE_OFFSETS.ANG_VEL),
      fwd: readVec3(snap, base + CAR_STATE_OFFSETS.FWD),
      right: readVec3(snap, base + CAR_STATE_OFFSETS.RIGHT),
      up: readVec3(snap, base + CAR_STATE_OFFSETS.UP),
      boost: Number(snap[base + CAR_STATE_OFFSETS.BOOST]) || 0,
      onGround: Boolean(snap[base + CAR_STATE_OFFSETS.ON_GROUND]),
      supersonic: Boolean(snap[base + CAR_STATE_OFFSETS.SUPERSONIC]),
      demoed: Boolean(snap[base + CAR_STATE_OFFSETS.DEMOED]),
      isBoosting: Boolean(snap[base + CAR_STATE_OFFSETS.IS_BOOSTING]),
      isFlipping: Boolean(snap[base + CAR_STATE_OFFSETS.IS_FLIPPING]),
    });
  }
  return cars;
}

export function extractBoostPadBitmask(snap: Float32Array | null): { lo: number; hi: number } {
  if (!snap) return { lo: 0, hi: 0 };
  let lo = 0;
  let hi = 0;
  const limit = Math.min(NUM_BOOST_PADS, 34);
  for (let i = 0; i < limit; i++) {
    const offset = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE + BOOST_PAD_OFFSETS.IS_ACTIVE;
    if (offset >= snap.length) break;
    if (Number(snap[offset]) > 0.5) {
      if (i < 32) {
        lo = (lo | (1 << i)) >>> 0;
      } else {
        hi = (hi | (1 << (i - 32))) >>> 0;
      }
    }
  }
  return { lo: lo >>> 0, hi: hi >>> 0 };
}

export class ReplayWatchCursorEngine {
  private source: ReplayWatchFrameSource | null = null;
  private manifest: ReplayWatchRosterManifest | null = null;
  private txSeq = 0;
  private fractionalFrame = 0;
  private lastEmittedFrame = -1;
  private playbackState: ReplayWatchPlaybackState = 'idle';
  private playbackSpeed = 1.0;
  private focusedCarIndex = 0;
  private cameraMode: ReplayWatchCameraMode = 'car';
  private cameraPose: ReplayWatchCameraPose | null = null;
  private readonly emittedSignalIds = new Set<number>();

  public attachSource(source: ReplayWatchFrameSource | null): void {
    this.source = source;
  }

  public getManifest(): ReplayWatchRosterManifest | null {
    return this.manifest;
  }

  public getStatus(): ReplayWatchCursorStatus {
    const totalFrames = this.manifest?.totalFrames ?? 0;
    return {
      loaded: this.manifest !== null && totalFrames > 0,
      replayId: this.manifest?.replayId ?? null,
      metadataHash: this.manifest?.metadataHash ?? 0,
      txSeq: this.txSeq,
      totalFrames,
      currentFrame: this.getClampedFrameIndex(),
      fractionalFrame: this.fractionalFrame,
      playbackState: this.playbackState,
      playbackSpeed: this.playbackSpeed,
      playbackDirection: resolveDirection(this.playbackState),
      focusedCarIndex: this.focusedCarIndex,
      cameraMode: this.cameraMode,
    };
  }

  private getClampedFrameIndex(): number {
    const total = this.manifest?.totalFrames ?? 0;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(total - 1, Math.round(this.fractionalFrame)));
  }

  private clampCursor(frameIndex: number): number {
    const total = this.manifest?.totalFrames ?? 0;
    if (total <= 0) return 0;
    if (!Number.isFinite(frameIndex)) return 0;
    return Math.max(0, Math.min(total - 1, frameIndex));
  }

  public applyCommand(cmd: ReplayWatchPlaybackCommand): ReplayWatchFrameStreamPacket | null {
    switch (cmd.type) {
      case 'load_replay': {
        this.manifest = cmd.manifest;
        this.emittedSignalIds.clear();
        this.fractionalFrame = this.clampCursor(cmd.initialFrame ?? 0);
        this.lastEmittedFrame = Math.round(this.fractionalFrame);
        this.playbackSpeed = clampSpeed(cmd.speed, 1.0);
        this.playbackState = cmd.autoPlay ? 'playing' : 'paused';
        const defaultCar = cmd.manifest.cars[0]?.carIndex ?? 0;
        this.focusedCarIndex =
          typeof cmd.initialFocusedCarIndex === 'number'
            ? cmd.initialFocusedCarIndex
            : defaultCar;
        this.cameraMode = 'car';
        this.cameraPose = null;
        return this.buildPacket(this.getClampedFrameIndex(), []);
      }

      case 'unload': {
        this.manifest = null;
        this.fractionalFrame = 0;
        this.lastEmittedFrame = -1;
        this.playbackState = 'idle';
        this.playbackSpeed = 1.0;
        this.focusedCarIndex = 0;
        this.cameraMode = 'car';
        this.cameraPose = null;
        this.emittedSignalIds.clear();
        return null;
      }

      case 'play': {
        if (!this.manifest) return null;
        if (typeof cmd.speed === 'number') {
          this.playbackSpeed = clampSpeed(cmd.speed, this.playbackSpeed);
        }
        const total = this.manifest.totalFrames;
        if (total > 0 && Math.round(this.fractionalFrame) >= total - 1) {
          this.fractionalFrame = 0;
          this.emittedSignalIds.clear();
          this.lastEmittedFrame = -1;
        }
        this.playbackState = 'playing';
        return this.buildPacket(this.getClampedFrameIndex(), []);
      }

      case 'pause': {
        if (!this.manifest) return null;
        this.playbackState = 'paused';
        this.fractionalFrame = this.getClampedFrameIndex();
        return this.buildPacket(this.getClampedFrameIndex(), []);
      }

      case 'rewind': {
        if (!this.manifest) return null;
        if (typeof cmd.speed === 'number') {
          this.playbackSpeed = clampSpeed(cmd.speed, this.playbackSpeed);
        }
        this.playbackState = 'rewinding';
        return this.buildPacket(this.getClampedFrameIndex(), []);
      }

      case 'fast_forward': {
        if (!this.manifest) return null;
        if (typeof cmd.speed === 'number') {
          this.playbackSpeed = clampSpeed(cmd.speed, this.playbackSpeed);
        }
        this.playbackState = 'forwarding';
        return this.buildPacket(this.getClampedFrameIndex(), []);
      }

      case 'seek': {
        if (!this.manifest) return null;
        const target = Math.round(this.clampCursor(cmd.frameIndex));
        this.fractionalFrame = target;
        this.lastEmittedFrame = target;
        this.emittedSignalIds.clear();
        const signals = this.collectSignals(target, target);
        return this.buildPacket(target, signals);
      }

      case 'set_speed': {
        this.playbackSpeed = clampSpeed(cmd.speed, this.playbackSpeed);
        if (!this.manifest) return null;
        return this.buildPacket(this.getClampedFrameIndex(), []);
      }

      case 'set_focus': {
        this.focusedCarIndex = Math.trunc(cmd.focusedCarIndex);
        if (cmd.cameraMode) {
          this.cameraMode = cmd.cameraMode;
        }
        if (cmd.cameraPose !== undefined) {
          this.cameraPose = cmd.cameraPose;
        }
        if (!this.manifest) return null;
        return this.buildPacket(this.getClampedFrameIndex(), []);
      }
    }
  }

  public step(dtMs: number): ReplayWatchFrameStreamPacket | null {
    if (!this.manifest || this.manifest.totalFrames <= 0 || this.playbackState === 'idle') {
      return null;
    }

    const total = this.manifest.totalFrames;
    const prevFrame = this.getClampedFrameIndex();
    const direction = resolveDirection(this.playbackState);

    if (direction !== 0 && Number.isFinite(dtMs) && dtMs > 0) {
      const deltaFrames = (direction * this.playbackSpeed * dtMs * this.manifest.tickRateHz) / 1000;
      const nextFractional = this.fractionalFrame + deltaFrames;
      if (direction > 0 && nextFractional >= total - 1) {
        this.fractionalFrame = total - 1;
        this.playbackState = 'paused';
      } else if (direction < 0 && nextFractional <= 0) {
        this.fractionalFrame = 0;
        this.playbackState = 'paused';
      } else {
        this.fractionalFrame = nextFractional;
      }
    }

    const currentFrame = this.getClampedFrameIndex();
    let signals: ReplayWatchSignalEvent[] = [];
    if (direction > 0 && currentFrame > prevFrame) {
      signals = this.collectSignals(prevFrame + 1, currentFrame);
    } else if (direction < 0 && currentFrame < prevFrame) {
      this.emittedSignalIds.clear();
    }

    this.lastEmittedFrame = currentFrame;
    return this.buildPacket(currentFrame, signals);
  }

  private collectSignals(startFrame: number, endFrame: number): ReplayWatchSignalEvent[] {
    if (!this.source?.getSignalsInRange || endFrame < startFrame) return [];
    const raw = this.source.getSignalsInRange(startFrame, endFrame);
    const result: ReplayWatchSignalEvent[] = [];
    for (let i = 0; i < raw.length; i++) {
      const sig = raw[i];
      if (!this.emittedSignalIds.has(sig.signalId)) {
        this.emittedSignalIds.add(sig.signalId);
        result.push(sig);
      }
    }
    return result;
  }

  private buildPacket(
    frameIndex: number,
    signals: readonly ReplayWatchSignalEvent[]
  ): ReplayWatchFrameStreamPacket {
    const manifest = this.manifest!;
    this.txSeq += 1;
    const snap = this.source?.getFrameAt(frameIndex) ?? null;
    const padBits = extractBoostPadBitmask(snap);
    const focusedEntry = resolveCarEntryFromManifest(manifest, this.focusedCarIndex);
    const scoreboard =
      this.source?.evaluateScoreboardAtFrame?.(frameIndex) ?? DEFAULT_SCOREBOARD;

    return {
      txSeq: this.txSeq,
      metadataHash: manifest.metadataHash,
      replayFrame: frameIndex,
      fractionalFrame: this.fractionalFrame,
      playbackState: this.playbackState,
      playbackSpeed: this.playbackSpeed,
      playbackDirection: resolveDirection(this.playbackState),
      focusedCarIndex: this.focusedCarIndex,
      focusedTeam: focusedEntry ? focusedEntry.team : null,
      cameraMode: this.cameraMode,
      cameraPose: this.cameraPose,
      scoreboard,
      ball: extractBallStateFromSnapshot(snap),
      cars: extractCarStatesFromSnapshot(snap, manifest),
      boostPadBitmaskLo: padBits.lo,
      boostPadBitmaskHi: padBits.hi,
      signals,
    };
  }
}
