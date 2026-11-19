/**
 * src/network/sync/spectateLookaheadPipeline.ts
 * Pure kinematic lookahead extrapolation, bracket lookup, and cursor state constants
 * for SpectateInterpolationBuffer (>= 5-frame lookahead window).
 */

import {
  BALL_REST_Z,
  BALL_STATE_OFFSETS,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  FIXED_TIMESTEP,
  GRAVITY_Z,
  SIM_OFFSETS,
} from '../../physics/RocketSimConstants.ts';
import { BOOST_PAD_DISCRETE_FIELD_OFFSETS } from '../../replay/boostPadSnapshotInterpolationPipeline.ts';

export type SpectateCursorState = 'empty' | 'buffering' | 'tracking' | 'lookahead' | 'stalled';

export interface BufferedSpectateFrame {
  tick: number;
  arrivalMs: number;
  snapshot: Float32Array;
}

export const SPECTATE_MIN_LOOKAHEAD_FRAMES = 5;
export const SPECTATE_MAX_LOOKAHEAD_FRAMES = 16;
export const SPECTATE_STALL_TIMEOUT_MS = 250;
export const SPECTATE_TICK_MS = 1000 / 120;
export const SPECTATE_MIN_DELAY_TICKS = 2;
export const SPECTATE_MAX_DELAY_TICKS = 10;
const SPECTATE_TELEPORT_DIST_SQ = 900 * 900;

export function isSpectateTeleportJump(a: Float32Array, b: Float32Array): boolean {
  const bdx = b[SIM_OFFSETS.BALL] - a[SIM_OFFSETS.BALL];
  const bdy = b[SIM_OFFSETS.BALL + 1] - a[SIM_OFFSETS.BALL + 1];
  const bdz = b[SIM_OFFSETS.BALL + 2] - a[SIM_OFFSETS.BALL + 2];
  if (bdx * bdx + bdy * bdy + bdz * bdz > SPECTATE_TELEPORT_DIST_SQ) return true;

  const numCars = Math.round(b[SIM_OFFSETS.NUM_CARS] || 0);
  if (numCars > 0) {
    const cdx = b[SIM_OFFSETS.CARS] - a[SIM_OFFSETS.CARS];
    const cdy = b[SIM_OFFSETS.CARS + 1] - a[SIM_OFFSETS.CARS + 1];
    const cdz = b[SIM_OFFSETS.CARS + 2] - a[SIM_OFFSETS.CARS + 2];
    if (cdx * cdx + cdy * cdy + cdz * cdz > SPECTATE_TELEPORT_DIST_SQ) return true;
  }
  return false;
}

export function extrapolateSpectateSnapshot(
  base: Float32Array,
  nextTick: number,
  deltaTicks: number
): Float32Array {
  const out = new Float32Array(base);
  out[SIM_OFFSETS.TICK] = nextTick;
  const dt = Math.max(0, deltaTicks) * FIXED_TIMESTEP;
  if (dt <= 0) return out;

  const bPos = SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS;
  const bVel = SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.VEL;
  const bz = base[bPos + 2];
  const vz = base[bVel + 2];
  out[bPos] = base[bPos] + base[bVel] * dt;
  out[bPos + 1] = base[bPos + 1] + base[bVel + 1] * dt;
  if (bz > BALL_REST_Z + 0.5 || Math.abs(vz) > 1) {
    const nextBz = bz + vz * dt + 0.5 * GRAVITY_Z * dt * dt;
    out[bPos + 2] = Math.max(BALL_REST_Z, nextBz);
    out[bVel + 2] = nextBz <= BALL_REST_Z ? 0 : vz + GRAVITY_Z * dt;
  }

  const numCars = Math.min(8, Math.max(0, Math.round(base[SIM_OFFSETS.NUM_CARS] || 0)));
  for (let c = 0; c < numCars; c++) {
    const carBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
    if (base[carBase + CAR_STATE_OFFSETS.DEMOED] >= 0.5) continue;
    const cPos = carBase + CAR_STATE_OFFSETS.POS;
    const cVel = carBase + CAR_STATE_OFFSETS.VEL;
    out[cPos] = base[cPos] + base[cVel] * dt;
    out[cPos + 1] = base[cPos + 1] + base[cVel + 1] * dt;
    out[cPos + 2] = Math.max(17, base[cPos + 2] + base[cVel + 2] * dt);
  }

  const padBase = BOOST_PAD_DISCRETE_FIELD_OFFSETS.baseOffset;
  const padStride = BOOST_PAD_DISCRETE_FIELD_OFFSETS.stride;
  const padCount = BOOST_PAD_DISCRETE_FIELD_OFFSETS.padCount;
  for (let p = 0; p < padCount; p++) {
    const idx = padBase + p * padStride;
    if (idx + 1 >= out.length) break;
    if (out[idx] < 0.5 && out[idx + 1] > 0) {
      out[idx + 1] = Math.max(0, out[idx + 1] - dt);
    }
  }
  return out;
}

export function fillSpectateLookaheadWindow(
  frames: readonly BufferedSpectateFrame[],
  lookaheadFrames: BufferedSpectateFrame[],
  targetWindowFrames: number,
  ticksPerFrame: number,
  nowMs: number
): void {
  if (frames.length < 2) return;
  const step = Math.max(1, Math.min(8, Math.round(ticksPerFrame)));
  while (lookaheadFrames.length < targetWindowFrames) {
    const anchor =
      lookaheadFrames.length > 0
        ? lookaheadFrames[lookaheadFrames.length - 1]
        : frames[frames.length - 1];
    const nextTick = anchor.tick + step;
    const extrapolated = extrapolateSpectateSnapshot(anchor.snapshot, nextTick, step);
    lookaheadFrames.push({ tick: nextTick, arrivalMs: nowMs, snapshot: extrapolated });
  }
}

export function findSpectateBracketFrames(
  frames: readonly BufferedSpectateFrame[],
  lookaheadFrames: readonly BufferedSpectateFrame[],
  tick: number
): { s0: BufferedSpectateFrame; s1: BufferedSpectateFrame } | null {
  const authLen = frames.length;
  if (authLen === 0) return null;
  if (tick <= frames[authLen - 1].tick) {
    for (let i = 1; i < authLen; i++) {
      if (frames[i].tick >= tick) {
        return { s0: frames[i - 1], s1: frames[i] };
      }
    }
    return null;
  }
  if (lookaheadFrames.length === 0) return null;
  let prev = frames[authLen - 1];
  for (let i = 0; i < lookaheadFrames.length; i++) {
    const curr = lookaheadFrames[i];
    if (curr.tick >= tick) {
      return { s0: prev, s1: curr };
    }
    prev = curr;
  }
  return null;
}

export function upsertSpectateLookaheadFrame(
  lookaheadFrames: BufferedSpectateFrame[],
  snapshot: Float32Array,
  tick: number,
  latestHostTick: number,
  nowMs: number
): boolean {
  if (!snapshot || snapshot.length < SIM_OFFSETS.CARS) return false;
  const resolvedTick = Math.round(tick);
  if (!Number.isFinite(resolvedTick) || resolvedTick <= latestHostTick) return false;
  const copy = new Float32Array(snapshot);
  copy[SIM_OFFSETS.TICK] = resolvedTick;
  const len = lookaheadFrames.length;
  if (len === 0 || resolvedTick > lookaheadFrames[len - 1].tick) {
    lookaheadFrames.push({ tick: resolvedTick, arrivalMs: nowMs, snapshot: copy });
  } else {
    for (let i = len - 1; i >= 0; i--) {
      if (lookaheadFrames[i].tick === resolvedTick) {
        lookaheadFrames[i] = { tick: resolvedTick, arrivalMs: nowMs, snapshot: copy };
        break;
      }
      if (lookaheadFrames[i].tick < resolvedTick) {
        lookaheadFrames.splice(i + 1, 0, { tick: resolvedTick, arrivalMs: nowMs, snapshot: copy });
        break;
      }
      if (i === 0) {
        lookaheadFrames.unshift({ tick: resolvedTick, arrivalMs: nowMs, snapshot: copy });
      }
    }
  }
  if (lookaheadFrames.length > SPECTATE_MAX_LOOKAHEAD_FRAMES) {
    lookaheadFrames.length = SPECTATE_MAX_LOOKAHEAD_FRAMES;
  }
  return true;
}
