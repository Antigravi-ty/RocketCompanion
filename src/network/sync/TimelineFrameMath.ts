/**
 * src/network/sync/TimelineFrameMath.ts
 * Rigid-body orthonormal-basis <-> quaternion conversion and dual-frame
 * interpolation helpers for TimelineFrameBuffer (vNext W1-02).
 */

import {
  BALL_STATE_OFFSETS,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  EXTENDED_STATE_OFFSETS,
  GAME_STATE_BUFFER_FLOATS,
  MAX_CARS,
  NUM_BOOST_PADS,
  SIM_OFFSETS,
} from '../../physics/RocketSimConstants.ts';
import type { RLRCQuat, RLRCVec3 } from '../../replay/rlrc/RLRCReplayTypes.ts';
import {
  normalizeQuat,
  quatToBasisVectors,
  slerpShortestArcQuat,
  type RLRCOrthonormalBasis,
} from '../../replay/rlrc/synthesis/RLRCQuaternionTrajectoryInterpolator.ts';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function distSq3(a: Float32Array, aIdx: number, b: Float32Array, bIdx: number): number {
  const dx = b[bIdx] - a[aIdx];
  const dy = b[bIdx + 1] - a[aIdx + 1];
  const dz = b[bIdx + 2] - a[aIdx + 2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Converts a 3x3 orthonormal basis (fwd, right, up) into a unit quaternion.
 * Exact inverse of `quatToBasisVectors` in RLRCQuaternionTrajectoryInterpolator.
 */
export function basisToQuat(fwd: RLRCVec3, right: RLRCVec3, up: RLRCVec3): RLRCQuat {
  const m00 = fwd.x;
  const m10 = fwd.y;
  const m20 = fwd.z;
  const m01 = right.x;
  const m11 = right.y;
  const m21 = right.z;
  const m02 = up.x;
  const m12 = up.y;
  const m22 = up.z;

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return normalizeQuat({
      w: 0.25 / s,
      x: (m21 - m12) * s,
      y: (m02 - m20) * s,
      z: (m10 - m01) * s,
    });
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    return normalizeQuat({
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    });
  }
  if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    return normalizeQuat({
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    });
  }
  const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
  return normalizeQuat({
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
  });
}

function readBasisFromArray(arr: Float32Array, base: number): RLRCOrthonormalBasis {
  return {
    fwd: { x: arr[base], y: arr[base + 1], z: arr[base + 2] },
    right: { x: arr[base + 3], y: arr[base + 4], z: arr[base + 5] },
    up: { x: arr[base + 6], y: arr[base + 7], z: arr[base + 8] },
  };
}

function writeBasisToArray(arr: Float32Array, base: number, basis: RLRCOrthonormalBasis): void {
  arr[base] = basis.fwd.x;
  arr[base + 1] = basis.fwd.y;
  arr[base + 2] = basis.fwd.z;
  arr[base + 3] = basis.right.x;
  arr[base + 4] = basis.right.y;
  arr[base + 5] = basis.right.z;
  arr[base + 6] = basis.up.x;
  arr[base + 7] = basis.up.y;
  arr[base + 8] = basis.up.z;
}

function interpolateRigidBodyInSnapshot(
  a: Float32Array,
  b: Float32Array,
  baseOffset: number,
  alpha: number,
  out: Float32Array,
  maxTeleportDistSq: number
): boolean {
  if (distSq3(a, baseOffset, b, baseOffset) > maxTeleportDistSq) {
    for (let i = 0; i < 18; i++) {
      out[baseOffset + i] = b[baseOffset + i];
    }
    return true;
  }

  // Position (0..2)
  out[baseOffset] = lerp(a[baseOffset], b[baseOffset], alpha);
  out[baseOffset + 1] = lerp(a[baseOffset + 1], b[baseOffset + 1], alpha);
  out[baseOffset + 2] = lerp(a[baseOffset + 2], b[baseOffset + 2], alpha);

  // Rotation matrix (3..11) via Quaternion SLERP
  const basisA = readBasisFromArray(a, baseOffset + 3);
  const basisB = readBasisFromArray(b, baseOffset + 3);
  const qA = basisToQuat(basisA.fwd, basisA.right, basisA.up);
  const qB = basisToQuat(basisB.fwd, basisB.right, basisB.up);
  const qOut = slerpShortestArcQuat(qA, qB, alpha);
  writeBasisToArray(out, baseOffset + 3, quatToBasisVectors(qOut));

  // Linear velocity (12..14) & angular velocity (15..17)
  for (let i = 12; i < 18; i++) {
    out[baseOffset + i] = lerp(a[baseOffset + i], b[baseOffset + i], alpha);
  }
  return false;
}

/**
 * Interpolates two RocketSim Float32Array state snapshots into `out`.
 * Uses linear interpolation for positions/velocities/boost/wheels and
 * shortest-arc quaternion SLERP for ball and car orientations.
 * Returns `true` if any entity exceeded `maxTeleportDistSq` and snapped.
 */
export function interpolateSnapshotPair(
  a: Float32Array,
  b: Float32Array,
  alpha: number,
  out: Float32Array,
  maxTeleportDistSq: number
): boolean {
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const pickB = t >= 0.5 ? b : a;
  let snapped = false;

  // Header
  out[SIM_OFFSETS.TICK] = lerp(a[SIM_OFFSETS.TICK], b[SIM_OFFSETS.TICK], t);
  out[SIM_OFFSETS.GOAL] = pickB[SIM_OFFSETS.GOAL];
  const numCars = Math.min(MAX_CARS, Math.max(0, Math.round(b[SIM_OFFSETS.NUM_CARS] || 0)));
  out[SIM_OFFSETS.NUM_CARS] = numCars;
  out[SIM_OFFSETS.NUM_PADS] = b[SIM_OFFSETS.NUM_PADS];

  // Ball
  if (
    interpolateRigidBodyInSnapshot(
      a,
      b,
      SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS,
      t,
      out,
      maxTeleportDistSq
    )
  ) {
    snapped = true;
  }

  // Cars
  const numCarsA = Math.round(a[SIM_OFFSETS.NUM_CARS] || 0);
  for (let c = 0; c < numCars; c++) {
    const carBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
    if (c >= numCarsA) {
      for (let i = 0; i < CAR_STATE_STRIDE; i++) {
        out[carBase + i] = b[carBase + i];
      }
      snapped = true;
      continue;
    }

    const demoedA = a[carBase + CAR_STATE_OFFSETS.DEMOED] > 0.5;
    const demoedB = b[carBase + CAR_STATE_OFFSETS.DEMOED] > 0.5;
    if (demoedA !== demoedB) {
      for (let i = 0; i < CAR_STATE_STRIDE; i++) {
        out[carBase + i] = b[carBase + i];
      }
      snapped = true;
      continue;
    }

    if (interpolateRigidBodyInSnapshot(a, b, carBase, t, out, maxTeleportDistSq)) {
      for (let i = 18; i < CAR_STATE_STRIDE; i++) {
        out[carBase + i] = b[carBase + i];
      }
      snapped = true;
      continue;
    }

    // Boost (18)
    out[carBase + CAR_STATE_OFFSETS.BOOST] = lerp(
      a[carBase + CAR_STATE_OFFSETS.BOOST],
      b[carBase + CAR_STATE_OFFSETS.BOOST],
      t
    );
    // Discrete flags (19..24)
    for (let i = CAR_STATE_OFFSETS.ON_GROUND; i <= CAR_STATE_OFFSETS.IS_FLIPPING; i++) {
      out[carBase + i] = pickB[carBase + i];
    }
    // Wheels (25..36) & ground normal (37..39)
    for (let i = CAR_STATE_OFFSETS.WHEELS; i < CAR_STATE_STRIDE; i++) {
      out[carBase + i] = lerp(a[carBase + i], b[carBase + i], t);
    }
  }

  // Boost pads (discrete active state, continuous cooldown)
  const numPads = Math.min(
    NUM_BOOST_PADS,
    Math.max(0, Math.round(b[SIM_OFFSETS.NUM_PADS] || NUM_BOOST_PADS))
  );
  for (let p = 0; p < numPads; p++) {
    const padBase = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
    out[padBase] = pickB[padBase];
    out[padBase + 1] = lerp(a[padBase + 1], b[padBase + 1], t);
  }

  // Extended state tail (410..447)
  const extStart = EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING;
  const maxLen = Math.min(GAME_STATE_BUFFER_FLOATS, b.length, out.length);
  for (let i = extStart; i < maxLen; i++) {
    out[i] = pickB[i];
  }

  return snapped;
}
