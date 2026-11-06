/**
 * ReplayRingBuffer.ts
 * First-In-First-Out (FIFO) Circular Ring Buffer for 120Hz Replay & Audio Event Recording.
 *
 * Design Specifications:
 * - Positive Count-Up Mode (Free Play / Online Warmup / Training):
 *   Uses a 30-second (30s @ 120Hz = 3,600 ticks, ~6.45 MB) FIFO circular buffer by default
 *   (configurable to 30s / 60s / 90s / 120s). Only the most recent rolling window is kept in FIFO order,
 *   and countdown-specific audio alerts (30s / 10s countdown) are suppressed.
 * - Countdown Match Mode (Standard / Bot / Online Match):
 *   Uses a 14-minute (7 + 7 min = 840s @ 120Hz = 100,800 ticks) capacity buffer
 *   covering a full 5-minute regulation period (up to ~7 min wall-clock with kickoffs/goals)
 *   plus up to 7 minutes of Overtime before Possession tie-breaker resolves the match.
 * - Zero Three.js / DOM dependencies (safe inside Web Workers and Headless Node.js).
 */

import { MATCH_SIGNALS, isIncidentEvent, isSystemControlSignal } from '../physics/RocketSimConstants.ts';

export const CLOCK_MODES = Object.freeze({
  REGULATION_COUNTDOWN: 0,
  OVERTIME_COUNTUP: 1,
  TRAINING_COUNTUP: 2
});

export const REPLAY_TICK_RATE = 120;

/** 30 seconds @ 120Hz = 3,600 ticks (~6.45 MB @ 448 floats/tick) default for positive count-up FIFO mode */
export const COUNTUP_REPLAY_DURATION_SECONDS = 30;
export const COUNTUP_REPLAY_CAPACITY_TICKS = COUNTUP_REPLAY_DURATION_SECONDS * REPLAY_TICK_RATE; // 3,600

/** 7 + 7 = 14 minutes (840 seconds) @ 120Hz = 100,800 ticks for countdown match mode */
export const REGULATION_MAX_WALL_SECONDS = 420; // 7 minutes (5 min clock + kickoffs/celebrations)
export const OVERTIME_MAX_WALL_SECONDS = 420;   // 7 minutes cap before possession tie-breaker
export const COUNTDOWN_REPLAY_DURATION_SECONDS = REGULATION_MAX_WALL_SECONDS + OVERTIME_MAX_WALL_SECONDS; // 840s
export const COUNTDOWN_REPLAY_CAPACITY_TICKS = COUNTDOWN_REPLAY_DURATION_SECONDS * REPLAY_TICK_RATE; // 100,800

/** Compact per-frame float count: Header (4) + Ball (18) + 8 Cars (320) + 34 Boost Pads (68) = 410 floats */
export const COMPACT_SNAPSHOT_FLOATS = 410;
/** Full GameStateBufferPod float count including Possession (6) + 8-Car Extended Jump/AirTime (32) = 448 floats */
export const GAME_STATE_BUFFER_FLOATS = 448;

export const REPLAY_BUFFER_MODES = Object.freeze({
  COUNTUP_FIFO: 'countup_fifo',
  COUNTDOWN_MATCH: 'countdown_match'
});

export interface ReplaySignalEntry {
  [key: string]: unknown;
  signalId?: number;
  signalType?: number;
  type?: number;
  frameId?: number;
  tick?: number;
  param1?: number;
  param2?: number;
  frameIndex?: number;
  synthesized?: boolean;
}

export interface ReplayAudioCue {
  [key: string]: unknown;
  cueId?: string;
  cueName?: string;
  frameId?: number;
  param1?: number;
  blueScore?: number;
  orangeScore?: number;
  remainingSeconds?: number;
  winner?: number;
  winReason?: number;
  volume?: number;
  tick?: number;
}

export interface ReplayCarControlsSnapshot {
  [key: string]: unknown;
  throttle?: number; steer?: number; pitch?: number; yaw?: number; roll?: number;
  jump?: boolean | number; boost?: boolean | number; handbrake?: boolean | number;
}

export interface ReplayAcknowledgedControlEntry extends ReplayCarControlsSnapshot {
  carIndex?: number;
  controls?: ReplayCarControlsSnapshot;
}

export interface ReplayRecordedIncident {
  [key: string]: unknown;
  type?: number; subType?: number; frameIndex?: number; tick?: number;
  x?: number; y?: number; z?: number; posX?: number; posY?: number; posZ?: number;
  normalX?: number; normalY?: number; normalZ?: number;
  normX?: number; normY?: number; normZ?: number;
  nx?: number; ny?: number; nz?: number;
  normalRelVel?: number; speed?: number; speedKph?: number; relSpeed?: number;
  impulse?: number; intensity?: number;
  primaryId?: number; secondaryId?: number;
  carIndex?: number; otherCarIndex?: number; car1Index?: number; car2Index?: number;
  car1Team?: number; car2Team?: number; team?: number;
  surfaceTag?: number; actionSubType?: number; isCrossbar?: boolean;
  padIndex?: number; isBig?: boolean; flags?: number;
  customFloat?: number; customInt?: number;
  directionDotNormal?: number; dirDot?: number; impactAngleDeg?: number;
  isInitialTouch?: boolean; isSupersonic?: boolean; isFlipping?: boolean;
  isOnGround?: boolean; isDemo?: boolean;
  resetSubType?: number; resetSubTypeName?: string;
  resetObjectCode?: number; resetObjectType?: string;
  resetTargetCarIndex?: number; resetSurfaceTag?: number; resetWheelCount?: number;
  isBallFlipReset?: boolean;
  carPosX?: number; carPosY?: number; carPosZ?: number;
  ballX?: number; ballY?: number; ballZ?: number;
  ballPosX?: number; ballPosY?: number; ballPosZ?: number;
  carPos?: { x: number; y: number; z: number };
  ballPos?: { x: number; y: number; z: number };
}

export interface ReplayRecordFrameOptions {
  signals?: ReadonlyArray<ReplaySignalEntry | null | undefined> | null;
  audioEvents?: ReadonlyArray<ReplayAudioCue | null | undefined> | null;
  incidents?: ReadonlyArray<ReplayRecordedIncident | null | undefined> | null;
  acknowledgedControls?: ReadonlyArray<ReplayAcknowledgedControlEntry | null | undefined> | null;
}

export type ReplaySignalsOrOptionsArg =
  | ReadonlyArray<ReplaySignalEntry | ReplayAcknowledgedControlEntry | null | undefined>
  | ReplayRecordFrameOptions
  | null;

export interface ReplayRingBufferSlot {
  [key: string]: unknown;
  tick: number;
  snapshot: Float32Array | null;
  signals: ReplaySignalEntry[];
  audioEvents: ReplayAudioCue[];
  incidents: ReplayRecordedIncident[];
  acknowledgedControls: ReplayAcknowledgedControlEntry[];
}

export interface ReplayRingBufferOptions {
  mode?: string;
  isCountUp?: boolean;
  capacityTicks?: number | null;
  snapshotFloatLimit?: number;
  includeSystemControlSignals?: boolean;
}

/**
 * Maps an authoritative match signal to a replay audio cue (if applicable).
 */
export function resolveReplayAudioCueForSignal(
  signal: ReplaySignalEntry | null | undefined,
  _isCountUp = false
): ReplayAudioCue | null {
  if (!signal || typeof signal.signalType !== 'number') return null;

  switch (signal.signalType) {
    case MATCH_SIGNALS.KICKOFF_WILL_START:
      return { cueId: 'match_countdown_321', frameId: signal.frameId, param1: signal.param1 };
    case MATCH_SIGNALS.KICKOFF_START:
      return { cueId: 'match_start_go', frameId: signal.frameId, param1: signal.param1 };
    case MATCH_SIGNALS.SCORE_UPDATED:
      if ((signal.param1 || 0) + (signal.param2 || 0) <= 0) {
        return null;
      }
      return { cueId: 'sfx_goal_poof', frameId: signal.frameId, blueScore: signal.param1, orangeScore: signal.param2 };
    case MATCH_SIGNALS.TIME_ALERT_60S:
      return { cueId: 'match_60_seconds_left', frameId: signal.frameId };
    case MATCH_SIGNALS.TIME_ALERT_30S:
      return { cueId: 'match_30_seconds_left', frameId: signal.frameId };
    case MATCH_SIGNALS.COUNTDOWN_10S:
      return { cueId: 'match_countdown_10s', frameId: signal.frameId, remainingSeconds: signal.param1 };
    case MATCH_SIGNALS.OVERTIME_START:
      return { cueId: 'match_overtime', frameId: signal.frameId };
    case MATCH_SIGNALS.MATCH_ENDED:
      return { cueId: 'match_end_whistle', frameId: signal.frameId, winner: signal.param1, winReason: signal.param2 };
    default:
      return null;
  }
}

export class ReplayRingBuffer {
  mode: string;
  _hasExplicitFloatLimit: boolean;
  snapshotFloatLimit: number;
  capacityTicks: number;
  includeSystemControlSignals: boolean;
  _slots: Array<ReplayRingBufferSlot | undefined>;
  _head: number;
  _size: number;
  _totalRecordedFrames: number;

  /**
   * @param {object} [options={}]
   * @param {string} [options.mode='countdown_match'] - 'countup_fifo' (30s default) or 'countdown_match' (14m)
   * @param {number} [options.capacityTicks] - Explicit capacity override in ticks
   * @param {number} [options.snapshotFloatLimit=410] - Max floats stored per frame snapshot
   */
  constructor(options: ReplayRingBufferOptions = {}) {
    const mode = options.mode || (options.isCountUp ? REPLAY_BUFFER_MODES.COUNTUP_FIFO : REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    this.mode = mode;
    this._hasExplicitFloatLimit = typeof options.snapshotFloatLimit === 'number' && options.snapshotFloatLimit > 0;
    this.snapshotFloatLimit = this._hasExplicitFloatLimit ? options.snapshotFloatLimit! : GAME_STATE_BUFFER_FLOATS;
    this.capacityTicks = this._resolveCapacityTicks(mode, options.capacityTicks);
    this.includeSystemControlSignals = Boolean(options.includeSystemControlSignals);

    this._slots = new Array(this.capacityTicks);
    this._head = 0; // Next write index (0 .. capacityTicks - 1)
    this._size = 0; // Number of valid frames currently in buffer (0 .. capacityTicks)
    this._totalRecordedFrames = 0;
  }

  _resolveCapacityTicks(mode: string, explicitCapacity?: number | null): number {
    if (typeof explicitCapacity === 'number' && Number.isFinite(explicitCapacity) && explicitCapacity > 0) {
      return Math.floor(explicitCapacity);
    }
    if (mode === REPLAY_BUFFER_MODES.COUNTUP_FIFO) {
      return COUNTUP_REPLAY_CAPACITY_TICKS;
    }
    if (mode === REPLAY_BUFFER_MODES.COUNTDOWN_MATCH) {
      return COUNTDOWN_REPLAY_CAPACITY_TICKS;
    }
    console.warn(`[ReplayRingBuffer:Fallback] Unknown mode "${mode}", falling back to COUNTDOWN_MATCH capacity (${COUNTDOWN_REPLAY_CAPACITY_TICKS} ticks).`);
    return COUNTDOWN_REPLAY_CAPACITY_TICKS;
  }

  get size(): number {
    return this._size;
  }

  get capacity(): number {
    return this.capacityTicks;
  }

  get totalRecordedFrames(): number {
    return this._totalRecordedFrames;
  }

  get isCountUpMode(): boolean {
    return this.mode === REPLAY_BUFFER_MODES.COUNTUP_FIFO;
  }

  /**
   * Switches the ring buffer mode (e.g., between positive count-up training/warmup and countdown match)
   * and resets the FIFO pointers.
   * @param {string} mode - REPLAY_BUFFER_MODES.COUNTUP_FIFO or REPLAY_BUFFER_MODES.COUNTDOWN_MATCH
   * @param {number} [explicitCapacity]
   */
  configureMode(mode: string, explicitCapacity: number | null = null): void {
    const nextCapacity = this._resolveCapacityTicks(mode, explicitCapacity);
    this.mode = mode;
    if (nextCapacity !== this.capacityTicks) {
      this.capacityTicks = nextCapacity;
      this._slots = new Array(this.capacityTicks);
    }
    this.clear();
  }

  clear(): void {
    this._head = 0;
    this._size = 0;
    this._totalRecordedFrames = 0;
  }

  /**
   * Appends a single authoritative frame into the FIFO circular buffer.
   * When full, overwrites the oldest frame in-place (First-In-First-Out) without reallocating Float32Array.
   *
   * @param {number} tick - Authoritative server tick
   * @param {Float32Array|Array<number>|null} stateSnapshot - Physics state snapshot
   * @param {Array<object>} [signals=[]] - Signals emitted on this tick
   * @param {Array<object>} [audioEvents=null] - Optional explicit audio events on this tick
   * @returns {object} The recorded slot reference
   */
  recordFrame(
    tick: number,
    stateSnapshot: Float32Array | number[] | null | undefined,
    signals: ReplaySignalsOrOptionsArg = [],
    audioEvents: ReadonlyArray<ReplayAudioCue | null | undefined> | null = null,
    incidents: ReadonlyArray<ReplayRecordedIncident | null | undefined> | null = null,
    acknowledgedControls: ReadonlyArray<ReplayAcknowledgedControlEntry | null | undefined> | null = null
  ): ReplayRingBufferSlot {
    let resolvedSignals: ReadonlyArray<ReplaySignalEntry | ReplayAcknowledgedControlEntry | null | undefined> = [];
    if (signals && typeof signals === 'object' && !Array.isArray(signals)) {
      const opts = signals as ReplayRecordFrameOptions;
      resolvedSignals = opts.signals || [];
      audioEvents = opts.audioEvents ?? audioEvents;
      incidents = opts.incidents ?? incidents;
      acknowledgedControls = opts.acknowledgedControls ?? acknowledgedControls;
    } else if (Array.isArray(signals)) {
      resolvedSignals = signals;
    }

    const writeIdx = this._head;
    let slot = this._slots[writeIdx];

    const copyLen = stateSnapshot
      ? Math.min(stateSnapshot.length, this.snapshotFloatLimit)
      : 0;

    if (!slot) {
      slot = {
        tick: 0,
        snapshot: copyLen > 0 ? new Float32Array(copyLen) : null,
        signals: [],
        audioEvents: [],
        incidents: [],
        acknowledgedControls: []
      };
      this._slots[writeIdx] = slot;
    } else if (copyLen > 0) {
      if (!slot.snapshot || slot.snapshot.length !== copyLen) {
        slot.snapshot = new Float32Array(copyLen);
      }
      if (!Array.isArray(slot.incidents)) {
        slot.incidents = [];
      }
      if (!Array.isArray(slot.acknowledgedControls)) {
        slot.acknowledgedControls = [];
      }
    } else {
      slot.snapshot = null;
      if (!Array.isArray(slot.incidents)) {
        slot.incidents = [];
      }
      if (!Array.isArray(slot.acknowledgedControls)) {
        slot.acknowledgedControls = [];
      }
    }

    slot.tick = tick >>> 0;
    if (copyLen > 0 && slot.snapshot && stateSnapshot) {
      if (stateSnapshot instanceof Float32Array) {
        slot.snapshot.set(stateSnapshot.subarray(0, copyLen));
      } else {
        for (let i = 0; i < copyLen; i++) {
          slot.snapshot[i] = stateSnapshot[i];
        }
      }
    }

    slot.signals.length = 0;
    slot.audioEvents.length = 0;
    slot.incidents.length = 0;
    slot.acknowledgedControls.length = 0;

    const isCountUp = this.isCountUpMode;
    if (Array.isArray(resolvedSignals) && resolvedSignals.length > 0) {
      for (let i = 0; i < resolvedSignals.length; i++) {
        const sig = resolvedSignals[i];
        if (!sig || !('signalType' in sig) || typeof sig.signalType !== 'number') continue;
        if (!this.includeSystemControlSignals && isSystemControlSignal(sig.signalType)) continue;
        slot.signals.push({
          signalId: sig.signalId ?? 0,
          signalType: sig.signalType,
          frameId: sig.frameId ?? tick,
          param1: sig.param1 ?? 0,
          param2: sig.param2 ?? 0
        });
        const cue = resolveReplayAudioCueForSignal(sig, isCountUp);
        if (cue) {
          slot.audioEvents.push(cue);
        }
      }
    }

    if (Array.isArray(audioEvents) && audioEvents.length > 0) {
      for (let i = 0; i < audioEvents.length; i++) {
        const cue = audioEvents[i];
        if (cue) {
          slot.audioEvents.push(cue);
        }
      }
    }

    if (Array.isArray(incidents) && incidents.length > 0) {
      for (let i = 0; i < incidents.length; i++) {
        const inc = incidents[i];
        if (inc && isIncidentEvent(inc.type)) {
          slot.incidents.push({ ...inc });
        }
      }
    }

    if (Array.isArray(acknowledgedControls) && acknowledgedControls.length > 0) {
      for (let i = 0; i < acknowledgedControls.length; i++) {
        const entry = acknowledgedControls[i];
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.carIndex === 'number' && entry.controls) {
          slot.acknowledgedControls.push({
            carIndex: entry.carIndex,
            controls: { ...entry.controls }
          });
        } else if ('throttle' in entry || 'steer' in entry || 'boost' in entry || 'jump' in entry) {
          slot.acknowledgedControls.push({
            carIndex: i,
            controls: { ...entry }
          });
        }
      }
    }

    this._head = (writeIdx + 1) % this.capacityTicks;
    if (this._size < this.capacityTicks) {
      this._size++;
    }
    this._totalRecordedFrames++;

    return slot;
  }

  /**
   * Appends a match signal event to the frame matching `tick` (or the newest recorded frame),
   * and resolves corresponding replay audio cue.
   * @param {number} tick
   * @param {object} signal
   */
  appendSignal(tick: number, signal: ReplaySignalEntry | null | undefined): boolean {
    if (!signal || this._size <= 0) return false;
    if (!this.includeSystemControlSignals && isSystemControlSignal(signal.signalType)) return false;
    const targetTick = typeof tick === 'number' && tick > 0 ? (tick >>> 0) : -1;
    let slot = targetTick >= 0 ? this.findFrameByTick(targetTick) : this.getNewestFrame();
    if (!slot || (targetTick >= 0 && Math.abs(slot.tick - targetTick) > 8)) {
      slot = this.getNewestFrame();
    }
    if (!slot) return false;
    if (!Array.isArray(slot.signals)) {
      slot.signals = [];
    }
    const normalizedSignal: ReplaySignalEntry = {
      signalId: signal.signalId ?? 0,
      signalType: signal.signalType,
      frameId: signal.frameId ?? slot.tick,
      param1: signal.param1 ?? 0,
      param2: signal.param2 ?? 0
    };
    slot.signals.push(normalizedSignal);
    const cue = resolveReplayAudioCueForSignal(normalizedSignal, this.isCountUpMode);
    if (cue) {
      if (!Array.isArray(slot.audioEvents)) {
        slot.audioEvents = [];
      }
      slot.audioEvents.push(cue);
    }
    return true;
  }

  /**
   * Appends a physics incident event to the frame matching `tick` (or the newest recorded frame).
   * @param {number} tick
   * @param {object} incident
   */
  appendIncident(tick: number, incident: ReplayRecordedIncident | null | undefined): boolean {
    if (!incident || !isIncidentEvent(incident.type) || this._size <= 0) return false;
    const targetTick = typeof tick === 'number' && tick > 0 ? (tick >>> 0) : -1;
    let slot = targetTick >= 0 ? this.findFrameByTick(targetTick) : this.getNewestFrame();
    if (!slot || (targetTick >= 0 && Math.abs(slot.tick - targetTick) > 8)) {
      slot = this.getNewestFrame();
    }
    if (!slot) return false;
    if (!Array.isArray(slot.incidents)) {
      slot.incidents = [];
    }
    slot.incidents.push({ ...incident });
    return true;
  }

  /**
   * Appends an explicit audio cue to the frame matching `tick` (or the newest recorded frame).
   * @param {number} tick
   * @param {object} cue
   */
  appendAudioEvent(tick: number, cue: ReplayAudioCue | null | undefined): boolean {
    if (!cue || this._size <= 0) return false;
    const targetTick = typeof tick === 'number' && tick > 0 ? (tick >>> 0) : -1;
    let slot = targetTick >= 0 ? this.findFrameByTick(targetTick) : this.getNewestFrame();
    if (!slot || (targetTick >= 0 && Math.abs(slot.tick - targetTick) > 8)) {
      slot = this.getNewestFrame();
    }
    if (!slot) return false;
    slot.audioEvents.push({ ...cue });
    return true;
  }

  /**
   * Returns the physical array index of the oldest frame in the FIFO buffer.
   */
  _oldestPhysicalIndex(): number {
    if (this._size < this.capacityTicks) {
      return 0;
    }
    return this._head;
  }

  /**
   * Retrieves the frame at logical FIFO index (0 = oldest retained frame, size - 1 = newest frame).
   * @param {number} logicalIndex
   * @returns {object|null}
   */
  getFrameAt(logicalIndex: number): ReplayRingBufferSlot | null {
    if (logicalIndex < 0 || logicalIndex >= this._size) {
      return null;
    }
    const physIdx = (this._oldestPhysicalIndex() + logicalIndex) % this.capacityTicks;
    return this._slots[physIdx] || null;
  }

  /**
   * Returns the oldest frame currently retained in the FIFO ring buffer.
   */
  getOldestFrame(): ReplayRingBufferSlot | null {
    return this._size > 0 ? this.getFrameAt(0) : null;
  }

  /**
   * Returns the newest frame currently retained in the FIFO ring buffer.
   */
  getNewestFrame(): ReplayRingBufferSlot | null {
    return this._size > 0 ? this.getFrameAt(this._size - 1) : null;
  }

  /**
   * Retrieves a frame by backward offset from the newest frame (0 = newest frame, size - 1 = oldest frame).
   * Matches the C++ `_physics_getReplayFramePtrByOffset(ticksAgo)` semantics.
   * @param {number} [ticksAgo=0]
   * @returns {object|null}
   */
  getFrameByOffset(ticksAgo = 0): ReplayRingBufferSlot | null {
    if (this._size <= 0) return null;
    const clampedOffset = Math.max(0, Math.min(this._size - 1, Math.floor(ticksAgo)));
    return this.getFrameAt(this._size - 1 - clampedOffset);
  }

  /**
   * Finds the recorded frame matching or closest to `targetTick`.
   * @param {number} targetTick
   * @returns {object|null}
   */
  findFrameByTick(targetTick: number): ReplayRingBufferSlot | null {
    if (this._size <= 0) return null;
    let bestSlot: ReplayRingBufferSlot | null = null;
    let bestDiff = Infinity;
    for (let i = this._size - 1; i >= 0; i--) {
      const slot = this.getFrameAt(i);
      if (!slot) continue;
      if (slot.tick === targetTick) return slot;
      const diff = Math.abs(slot.tick - targetTick);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSlot = slot;
      }
    }
    return bestSlot;
  }

  /**
   * Extracts up to `maxFrames` most recent frames in chronological (FIFO) order.
   * Useful for instant Goal Replays (e.g., last 360 ticks = 3.0s) or exporting the 2.5m count-up buffer.
   * @param {number} [maxFrames=this.size]
   * @returns {Array<object>}
   */
  getRecentFrames(maxFrames = this._size): Array<ReplayRingBufferSlot | null> {
    const count = Math.max(0, Math.min(this._size, Math.floor(maxFrames)));
    const startLogical = this._size - count;
    const result: Array<ReplayRingBufferSlot | null> = new Array(count);
    for (let i = 0; i < count; i++) {
      const slot = this.getFrameAt(startLogical + i);
      result[i] = slot ? {
        tick: slot.tick,
        snapshot: slot.snapshot ? new Float32Array(slot.snapshot) : null,
        signals: slot.signals.slice(),
        audioEvents: slot.audioEvents.slice(),
        incidents: Array.isArray(slot.incidents) ? slot.incidents.slice() : [],
        acknowledgedControls: Array.isArray(slot.acknowledgedControls) ? slot.acknowledgedControls.slice() : []
      } : null;
    }
    return result;
  }

  /**
   * Collects all replay audio events recorded within [startTick, endTick].
   * @param {number} startTick
   * @param {number} endTick
   * @returns {Array<object>}
   */
  getAudioEventsInRange(startTick: number, endTick: number): ReplayAudioCue[] {
    const events: ReplayAudioCue[] = [];
    for (let i = 0; i < this._size; i++) {
      const slot = this.getFrameAt(i);
      if (!slot || slot.tick < startTick || slot.tick > endTick) continue;
      for (let j = 0; j < slot.audioEvents.length; j++) {
        events.push({ tick: slot.tick, ...slot.audioEvents[j] });
      }
    }
    return events;
  }

  /**
   * Finds the most recent frame tick <= maxTick where `signalType` was emitted.
   * @param {number} signalType
   * @param {number} [maxTick=Infinity]
   * @returns {number} Frame ID / tick, or -1 if not found
   */
  findLatestSignalTick(signalType: number, maxTick = Infinity): number {
    for (let i = this._size - 1; i >= 0; i--) {
      const slot = this.getFrameAt(i);
      if (!slot || slot.tick > maxTick) continue;
      if (Array.isArray(slot.signals)) {
        for (let j = slot.signals.length - 1; j >= 0; j--) {
          const sig = slot.signals[j];
          if (sig && sig.signalType === signalType) {
            const fId = typeof sig.frameId === 'number' ? sig.frameId : slot.tick;
            if (fId <= maxTick) return fId;
          }
        }
      }
    }
    return -1;
  }

  /**
   * Extracts all recorded frames whose tick falls within [startTick, endTick] in chronological order.
   * @param {number} startTick
   * @param {number} endTick
   * @returns {Array<object>}
   */
  getFramesInTickRange(startTick: number, endTick: number): ReplayRingBufferSlot[] {
    const result: ReplayRingBufferSlot[] = [];
    for (let i = 0; i < this._size; i++) {
      const slot = this.getFrameAt(i);
      if (!slot) continue;
      if (slot.tick >= startTick && slot.tick <= endTick) {
        result.push({
          tick: slot.tick,
          snapshot: slot.snapshot ? new Float32Array(slot.snapshot) : null,
          signals: slot.signals.slice(),
          audioEvents: slot.audioEvents.slice(),
          incidents: Array.isArray(slot.incidents) ? slot.incidents.slice() : [],
          acknowledgedControls: Array.isArray(slot.acknowledgedControls) ? slot.acknowledgedControls.slice() : []
        });
      }
    }
    return result;
  }

  /**
   * Alias for getFramesInTickRange(startTick, endTick).
   * @param {number} startTick
   * @param {number} endTick
   * @returns {Array<object>}
   */
  extractRange(startTick: number, endTick: number): ReplayRingBufferSlot[] {
    return this.getFramesInTickRange(startTick, endTick);
  }
}
