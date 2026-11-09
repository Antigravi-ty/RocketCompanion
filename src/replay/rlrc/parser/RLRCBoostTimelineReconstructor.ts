/**
 * RLRCBoostTimelineReconstructor.ts
 * Reconstructs continuous 30Hz vehicle boost trajectories by integrating
 * boost consumption (`33.3333%/s` while `boostActive` is true), boost pad pickups
 * (`+100` big / `+12` small), and spawn/kickoff resets (`33.333%`), anchored to
 * discrete server `:ReplicatedBoost` updates.
 */

import { STANDARD_BOOST_PADS_34 } from '../catalog/RLRCBoostPadLocationsTable.ts';
import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCBoostPadPickupEvent,
  type RLRCCarFrameState120Hz,
  type RLRCSourceNetworkFrame,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';

export const RLRC_BOOST_DRAIN_RATE_PCT_PER_SEC = (85 / 255) * 100; // 33.333333333333336%/s
export const RLRC_DEFAULT_SPAWN_BOOST_PCT = (85 / 255) * 100;

export interface RLRCBoostAnchorMapBySlot {
  readonly anchorsBySlot: ReadonlyArray<ReadonlyMap<number, number>>;
  readonly spawnFramesBySlot: ReadonlyArray<ReadonlySet<number>>;
}

function clampBoost(v: number): number {
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

function distXY(a: RLRCVec3, b: RLRCVec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function buildPadPickupGrantsByFrameAndSlot(
  nfs: readonly RLRCSourceNetworkFrame[],
  boostPadEvents: readonly RLRCBoostPadPickupEvent[] | undefined
): Map<number, number[]> {
  const grantsByFrame = new Map<number, number[]>();
  if (!boostPadEvents || boostPadEvents.length === 0 || nfs.length === 0) {
    return grantsByFrame;
  }

  for (let i = 0; i < boostPadEvents.length; i++) {
    const ev = boostPadEvents[i];
    if (ev.pickedUpState !== 'picked-up') continue;
    const fi = ev.sourceFrame30Hz;
    if (fi < 0 || fi >= nfs.length) continue;

    let slot = ev.instigatorSlotIndex;
    if (slot < 0 || slot >= RLRC_MAX_PLAYER_SLOTS) {
      const padSpec =
        ev.padIndex >= 0 && ev.padIndex < STANDARD_BOOST_PADS_34.length
          ? STANDARD_BOOST_PADS_34[ev.padIndex]
          : null;
      if (padSpec) {
        const cars = nfs[fi].cars;
        let bestSlot = -1;
        let bestDist = 420.0;
        for (let s = 0; s < cars.length; s++) {
          const car = cars[s];
          if (!car.entityActive) continue;
          const d = distXY(car.rigidBody.position, padSpec.position);
          if (d < bestDist) {
            bestDist = d;
            bestSlot = s;
          }
        }
        slot = bestSlot;
      }
    }

    if (slot < 0 || slot >= RLRC_MAX_PLAYER_SLOTS) continue;
    let frameGrants = grantsByFrame.get(fi);
    if (!frameGrants) {
      frameGrants = new Array<number>(RLRC_MAX_PLAYER_SLOTS).fill(0);
      grantsByFrame.set(fi, frameGrants);
    }
    const grant = ev.isBigPad ? 100 : 12;
    frameGrants[slot] = Math.min(100, frameGrants[slot] + grant);
  }

  return grantsByFrame;
}

/**
 * Applies continuous edge-integrated boost amounts across all 30Hz source frames in place.
 * Between consecutive server `:ReplicatedBoost` updates (anchors) with no pad pickup or respawn,
 * any small timing drift between integrated drain and server anchor is distributed across active
 * boost frames so the boost curve is C0 continuous and monotonically decreasing during boost burn.
 */
export function reconstructContinuousBoostTimeline30Hz(
  nfs: readonly RLRCSourceNetworkFrame[],
  anchorInfo: RLRCBoostAnchorMapBySlot,
  boostPadEvents?: readonly RLRCBoostPadPickupEvent[]
): void {
  const numFrames = nfs.length;
  if (numFrames === 0) return;

  const grantsByFrame = buildPadPickupGrantsByFrameAndSlot(nfs, boostPadEvents);

  for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
    const anchors = anchorInfo.anchorsBySlot[slot];
    const spawns = anchorInfo.spawnFramesBySlot[slot];
    const values = new Float64Array(numFrames);
    const hardResetAt = new Uint8Array(numFrames);

    let currentBoost = RLRC_DEFAULT_SPAWN_BOOST_PCT;
    let prevActive = false;
    let prevCountdown = -1;

    for (let fi = 0; fi < numFrames; fi++) {
      const nf = nfs[fi];
      const car = nf.cars[slot];
      if (!car || !car.entityActive) {
        values[fi] = 0;
        prevActive = false;
        prevCountdown = nf.roundCountdownNumber;
        continue;
      }

      const dt = Math.max(0, Math.min(0.25, nf.deltaSeconds > 0 ? nf.deltaSeconds : 1 / 30));
      const isKickoffReset =
        nf.roundCountdownNumber > 0 && nf.roundCountdownNumber !== prevCountdown;
      const isSpawn = !prevActive || (spawns?.has(fi) ?? false) || isKickoffReset;

      if (isSpawn) {
        currentBoost = RLRC_DEFAULT_SPAWN_BOOST_PCT;
        hardResetAt[fi] = 1;
      }

      const grant = grantsByFrame.get(fi)?.[slot] ?? 0;
      if (grant > 0) {
        currentBoost = clampBoost(currentBoost + grant);
        hardResetAt[fi] = 1;
      }

      if (car.activeFlags.boostActive && !isSpawn) {
        currentBoost = clampBoost(currentBoost - RLRC_BOOST_DRAIN_RATE_PCT_PER_SEC * dt);
      }

      const anchorVal = anchors?.get(fi);
      if (anchorVal !== undefined) {
        currentBoost = clampBoost(anchorVal);
      }

      values[fi] = currentBoost;
      prevActive = true;
      prevCountdown = nf.roundCountdownNumber;
    }

    // Second pass: smooth residual drift between consecutive ReplicatedBoost anchors
    // when no pad pickup or spawn occurred inside the interval.
    if (anchors && anchors.size >= 2) {
      const anchorFrames = Array.from(anchors.keys()).sort((a, b) => a - b);
      for (let k = 0; k < anchorFrames.length - 1; k++) {
        const f0 = anchorFrames[k];
        const f1 = anchorFrames[k + 1];
        if (f1 - f0 <= 1 || f1 >= numFrames) continue;

        let hasDiscontinuity = false;
        let boostBurnTime = 0;
        for (let fi = f0 + 1; fi <= f1; fi++) {
          const car = nfs[fi].cars[slot];
          if (!car || !car.entityActive || hardResetAt[fi]) {
            hasDiscontinuity = true;
            break;
          }
          if (car.activeFlags.boostActive) {
            const dt = Math.max(
              0,
              Math.min(0.25, nfs[fi].deltaSeconds > 0 ? nfs[fi].deltaSeconds : 1 / 30)
            );
            boostBurnTime += dt;
          }
        }
        if (hasDiscontinuity) continue;

        const v0 = anchors.get(f0)!;
        const v1 = anchors.get(f1)!;
        // If boost was only draining (v1 <= v0 + 0.5) and car boosted during [f0+1, f1],
        // scale the drain rate over this segment so it lands smoothly on v1 at f1.
        if (v1 <= v0 + 0.5 && boostBurnTime > 1e-4) {
          const actualDrop = Math.max(0, v0 - v1);
          const effectiveRate = actualDrop / boostBurnTime;
          // Only apply if effectiveRate is within plausible Rocket League network jitter bounds
          if (effectiveRate <= RLRC_BOOST_DRAIN_RATE_PCT_PER_SEC * 1.8) {
            let acc = v0;
            for (let fi = f0 + 1; fi < f1; fi++) {
              const car = nfs[fi].cars[slot];
              if (car.activeFlags.boostActive) {
                const dt = Math.max(
                  0,
                  Math.min(0.25, nfs[fi].deltaSeconds > 0 ? nfs[fi].deltaSeconds : 1 / 30)
                );
                acc = clampBoost(acc - effectiveRate * dt);
              }
              values[fi] = acc;
            }
          }
        }
      }
    }

    for (let fi = 0; fi < numFrames; fi++) {
      const cars = nfs[fi].cars as RLRCCarFrameState120Hz[];
      const car = cars[slot];
      if (!car) continue;
      const newBoost = car.entityActive ? clampBoost(values[fi]) : 0;
      if (Math.abs(car.boostAmount - newBoost) > 1e-4) {
        cars[slot] = {
          ...car,
          boostAmount: newBoost,
        };
      }
    }
  }
}
