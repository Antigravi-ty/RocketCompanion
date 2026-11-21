/**
 * src/network/server/activities/freeplaySnapshotReader.ts
 * Pure, zero-DOM snapshot extraction and FNV-1a hash helpers for the
 * vNext Freeplay Unified Spectate Frame Stream.
 */

import {
  BOOST_PAD_STATES_OFFSET,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  NUM_BOOST_PADS,
  SIM_OFFSETS,
} from '../../../physics/RocketSimConstants.ts';
import type {
  FreeplayBallState,
  FreeplayCarState,
  FreeplayRosterCarEntry,
  FreeplayRosterManifest,
} from './freeplaySpectateTypes.ts';

export function computeFnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function computeFreeplayMetadataHash(
  manifest: Omit<FreeplayRosterManifest, 'metadataHash'>
): number {
  const carsSig = manifest.cars
    .map(
      (c) =>
        `${c.carIndex}:${c.name}:${c.team}:${c.visualId}:${c.colorHex}:${c.paintFinish}:${c.decalId}:${c.isBot ? 1 : 0}:${c.roleFlag}`
    )
    .join(';');
  const raw = `${manifest.activityId}|${manifest.arenaPreset}|${manifest.unlimitedBoost ? 1 : 0}|${manifest.goalReplayEnabled ? 1 : 0}|${manifest.telestratorPermission}|${carsSig}`;
  return computeFnv1a32(raw);
}

export function computeRewinderSliceHash(frames: ReadonlyArray<Float32Array>): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const step = Math.max(1, Math.floor(f.length / 16));
    for (let j = 0; j < f.length; j += step) {
      const bits = Math.round(f[j] * 1000) | 0;
      hash ^= bits & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (bits >> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `0x${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function rotationMatrixToQuat(
  fx: number,
  fy: number,
  fz: number,
  rx: number,
  ry: number,
  rz: number,
  ux: number,
  uy: number,
  uz: number
): [number, number, number, number] {
  const m00 = fx;
  const m01 = rx;
  const m02 = ux;
  const m10 = fy;
  const m11 = ry;
  const m12 = uy;
  const m20 = fz;
  const m21 = rz;
  const m22 = uz;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

export function extractBallFromSnapshot(snap: Float32Array, isExpired: boolean): FreeplayBallState {
  const b = SIM_OFFSETS.BALL;
  if (snap.length < b + 18) {
    return {
      posX: 0,
      posY: 0,
      posZ: 93,
      velX: 0,
      velY: 0,
      velZ: 0,
      angVelX: 0,
      angVelY: 0,
      angVelZ: 0,
      isExpired,
    };
  }
  return {
    posX: snap[b] || 0,
    posY: snap[b + 1] || 0,
    posZ: snap[b + 2] || 0,
    velX: snap[b + 12] || 0,
    velY: snap[b + 13] || 0,
    velZ: snap[b + 14] || 0,
    angVelX: snap[b + 15] || 0,
    angVelY: snap[b + 16] || 0,
    angVelZ: snap[b + 17] || 0,
    isExpired,
  };
}

export function extractCarsFromSnapshot(
  snap: Float32Array,
  rosterCars: ReadonlyArray<FreeplayRosterCarEntry>
): FreeplayCarState[] {
  const numCars = Math.min(8, Math.max(0, Math.round(snap[SIM_OFFSETS.NUM_CARS] || 0)));
  const out: FreeplayCarState[] = [];
  for (let i = 0; i < numCars; i++) {
    const base = SIM_OFFSETS.CARS + i * CAR_STATE_STRIDE;
    if (snap.length < base + 24) break;
    const [qx, qy, qz, qw] = rotationMatrixToQuat(
      snap[base + CAR_STATE_OFFSETS.FWD] || 1,
      snap[base + CAR_STATE_OFFSETS.FWD + 1] || 0,
      snap[base + CAR_STATE_OFFSETS.FWD + 2] || 0,
      snap[base + CAR_STATE_OFFSETS.RIGHT] || 0,
      snap[base + CAR_STATE_OFFSETS.RIGHT + 1] || 1,
      snap[base + CAR_STATE_OFFSETS.RIGHT + 2] || 0,
      snap[base + CAR_STATE_OFFSETS.UP] || 0,
      snap[base + CAR_STATE_OFFSETS.UP + 1] || 0,
      snap[base + CAR_STATE_OFFSETS.UP + 2] || 1
    );
    const rosterEntry = rosterCars.find((r) => r.carIndex === i);
    out.push({
      carIndex: i,
      team: rosterEntry?.team ?? 0,
      posX: snap[base + CAR_STATE_OFFSETS.POS] || 0,
      posY: snap[base + CAR_STATE_OFFSETS.POS + 1] || 0,
      posZ: snap[base + CAR_STATE_OFFSETS.POS + 2] || 0,
      velX: snap[base + CAR_STATE_OFFSETS.VEL] || 0,
      velY: snap[base + CAR_STATE_OFFSETS.VEL + 1] || 0,
      velZ: snap[base + CAR_STATE_OFFSETS.VEL + 2] || 0,
      quatX: qx,
      quatY: qy,
      quatZ: qz,
      quatW: qw,
      boost: snap[base + CAR_STATE_OFFSETS.BOOST] || 0,
      isSupersonic: (snap[base + CAR_STATE_OFFSETS.SUPERSONIC] || 0) > 0.5,
      isBoosting: (snap[base + CAR_STATE_OFFSETS.IS_BOOSTING] || 0) > 0.5,
      onGround: (snap[base + CAR_STATE_OFFSETS.ON_GROUND] || 0) > 0.5,
      isDemolished: (snap[base + CAR_STATE_OFFSETS.DEMOED] || 0) > 0.5,
    });
  }
  return out;
}

export function extractBoostPadMaskFromSnapshot(snap: Float32Array): number {
  const numPads = Math.min(NUM_BOOST_PADS, Math.round(snap[SIM_OFFSETS.NUM_PADS] || 0));
  let mask = 0;
  for (let i = 0; i < Math.min(31, numPads); i++) {
    const idx = BOOST_PAD_STATES_OFFSET + i * 2;
    if (idx < snap.length && (snap[idx] || 0) > 0.5) {
      mask |= 1 << i;
    }
  }
  return mask >>> 0;
}
