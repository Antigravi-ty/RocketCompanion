/**
 * boostPadSnapshotInterpolationPipeline.ts
 * Explicit discrete/continuous field separation for BoostPad state slots
 * inside 448-float GameStateBufferPod snapshots.
 */

import {
  SIM_OFFSETS,
  NUM_BOOST_PADS,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_OFFSETS,
} from '../physics/RocketSimConstants.ts';

export type BoostPadFieldInterpolationKind = 'discrete-step' | 'monotone-cooldown';

export interface BoostPadFieldDescriptor {
  readonly field: 'isActive' | 'cooldown';
  readonly offset: number;
  readonly kind: BoostPadFieldInterpolationKind;
}

export const BOOST_PAD_DISCRETE_FIELD_OFFSETS = Object.freeze({
  baseOffset: BOOST_PAD_STATES_OFFSET,
  padCount: NUM_BOOST_PADS,
  stride: BOOST_PAD_STATE_STRIDE,
  isActiveOffset: BOOST_PAD_OFFSETS.IS_ACTIVE,
  cooldownOffset: BOOST_PAD_OFFSETS.COOLDOWN,
  cooldownJumpThresholdSec: 0.05,
  fields: Object.freeze([
    Object.freeze({
      field: 'isActive',
      offset: BOOST_PAD_OFFSETS.IS_ACTIVE,
      kind: 'discrete-step',
    }),
    Object.freeze({
      field: 'cooldown',
      offset: BOOST_PAD_OFFSETS.COOLDOWN,
      kind: 'monotone-cooldown',
    }),
  ] as readonly BoostPadFieldDescriptor[]),
});

export function interpolateBoostPadSnapshots(
  prevSnap: Float32Array,
  currSnap: Float32Array,
  out: Float32Array,
  t: number
): void {
  const spec = BOOST_PAD_DISCRETE_FIELD_OFFSETS;
  const rawNumPads = Math.round(currSnap[SIM_OFFSETS.NUM_PADS] || 0);
  const padCount = rawNumPads > 0 ? Math.min(spec.padCount, rawNumPads) : spec.padCount;
  const minLen = spec.baseOffset + padCount * spec.stride;
  if (prevSnap.length < minLen || currSnap.length < minLen || out.length < minLen) return;

  const useCurr = t >= 0.5;
  for (let p = 0; p < padCount; p++) {
    const base = spec.baseOffset + p * spec.stride;
    const activeIdx = base + spec.isActiveOffset;
    const cdIdx = base + spec.cooldownOffset;

    const prevActive = prevSnap[activeIdx] >= 0.5 ? 1 : 0;
    const currActive = currSnap[activeIdx] >= 0.5 ? 1 : 0;
    const outActive = useCurr ? currActive : prevActive;
    out[activeIdx] = outActive;

    if (outActive === 1) {
      out[cdIdx] = 0;
      continue;
    }

    const prevCd = Number.isFinite(prevSnap[cdIdx]) && prevSnap[cdIdx] > 0 ? prevSnap[cdIdx] : 0;
    const currCd = Number.isFinite(currSnap[cdIdx]) && currSnap[cdIdx] > 0 ? currSnap[cdIdx] : 0;
    if (prevActive === 0 && currActive === 0) {
      const jumpedUp = currCd > prevCd + spec.cooldownJumpThresholdSec;
      out[cdIdx] = jumpedUp
        ? useCurr
          ? currCd
          : prevCd
        : Math.max(0, prevCd + (currCd - prevCd) * t);
    } else {
      out[cdIdx] = useCurr ? currCd : prevCd;
    }
  }
}
