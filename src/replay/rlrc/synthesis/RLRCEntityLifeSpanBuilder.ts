/**
 * RLRCEntityLifeSpanBuilder.ts
 * Lifespan segment extraction, ZOH duplicate filtering without mid-air freeze anchors,
 * kinematic teleport detection, and binary-search keyframe bracket lookup for 120Hz RLRC resampling.
 */

import type {
  RLRCCarFrameState120Hz,
  RLRCRigidBodySample,
  RLRCSourceEntityLifeSegment,
  RLRCSourceNetworkFrame,
} from '../RLRCReplayTypes.ts';
import {
  calibrateNetStreamVel,
  clamp,
  isDupRb,
  isRest,
  SLEEP_RB,
  vAdd,
  vDist,
  vScale,
  vSub,
} from './RLRCHermiteSlerpMathPipeline.ts';

export interface RLRCEntitySpan {
  readonly startNetIdx: number;
  readonly endNetIdx: number;
  readonly keyframeIndices: readonly number[];
}

export interface RLRCKeyframeBracket {
  readonly k0Idx: number;
  readonly k1Idx: number;
  readonly alpha: number;
  readonly dt: number;
  readonly rest0: boolean;
  readonly rest1: boolean;
}

export const getCarFromNetworkFrame = (
  networkFrame: RLRCSourceNetworkFrame,
  slotIndex: number
): RLRCCarFrameState120Hz | undefined =>
  networkFrame.cars[slotIndex]?.slotIndex === slotIndex
    ? networkFrame.cars[slotIndex]
    : networkFrame.cars.find((car) => car.slotIndex === slotIndex);

export const getRigidBodyFromNetworkFrame = (
  networkFrame: RLRCSourceNetworkFrame,
  slot: number | 'ball'
): RLRCRigidBodySample =>
  slot === 'ball'
    ? networkFrame.ball.rigidBody
    : (getCarFromNetworkFrame(networkFrame, slot)?.rigidBody ?? SLEEP_RB);

export function isRigidBodyUpdatedInFrame(
  networkFrame: RLRCSourceNetworkFrame,
  slot: number | 'ball'
): boolean | undefined {
  const entity = (
    slot === 'ball' ? networkFrame.ball : getCarFromNetworkFrame(networkFrame, slot)
  ) as { readonly rbUpdated?: boolean } | undefined;
  if (typeof entity?.rbUpdated === 'boolean') return entity.rbUpdated;
  const rigidBody = getRigidBodyFromNetworkFrame(networkFrame, slot) as {
    readonly rbUpdated?: boolean;
  };
  if (typeof rigidBody.rbUpdated === 'boolean') return rigidBody.rbUpdated;
  const frameMasks = networkFrame as {
    readonly ballRbUpdated?: boolean;
    readonly carRbUpdatedMask?: number;
    readonly rbUpdatedMask?: number;
    readonly rbUpdated?: number;
  };
  if (slot === 'ball' && typeof frameMasks.ballRbUpdated === 'boolean') {
    return frameMasks.ballRbUpdated;
  }
  if (typeof slot === 'number' && typeof frameMasks.carRbUpdatedMask === 'number') {
    return ((frameMasks.carRbUpdatedMask >>> slot) & 1) === 1;
  }
  const combinedMask =
    typeof frameMasks.rbUpdatedMask === 'number'
      ? frameMasks.rbUpdatedMask
      : typeof frameMasks.rbUpdated === 'number'
        ? frameMasks.rbUpdated
        : undefined;
  return combinedMask !== undefined
    ? ((combinedMask >>> (slot === 'ball' ? 6 : slot)) & 1) === 1
    : undefined;
}

export function buildEntityKeyframeSpan(
  networkFrames: readonly RLRCSourceNetworkFrame[],
  rawFrameIndices: readonly number[],
  slot: number | 'ball'
): RLRCEntitySpan {
  const keyframeIndices: number[] = [];
  for (let r = 0; r < rawFrameIndices.length; r++) {
    const idx = rawFrameIndices[r];
    const prevKf = keyframeIndices[keyframeIndices.length - 1];
    if (prevKf === undefined) {
      keyframeIndices.push(idx);
      continue;
    }
    const rbPrev = getRigidBodyFromNetworkFrame(networkFrames[prevKf], slot);
    const rbCurr = getRigidBodyFromNetworkFrame(networkFrames[idx], slot);
    const dt = networkFrames[idx].timeSeconds - networkFrames[prevKf].timeSeconds;
    if (dt <= 1e-5) {
      if (!isDupRb(rbPrev, rbCurr)) {
        keyframeIndices[keyframeIndices.length - 1] = idx;
      }
      continue;
    }
    if (!isDupRb(rbPrev, rbCurr)) {
      const immediatePrev = rawFrameIndices[r - 1];
      const holdDt = networkFrames[immediatePrev].timeSeconds - networkFrames[prevKf].timeSeconds;
      const shouldInsertHoldEndAnchor =
        immediatePrev > prevKf &&
        holdDt > 1e-5 &&
        (isRest(rbPrev) || isRigidBodyUpdatedInFrame(networkFrames[immediatePrev], slot) === true);
      if (shouldInsertHoldEndAnchor) {
        keyframeIndices.push(immediatePrev);
      }
      keyframeIndices.push(idx);
    }
  }
  const endNetIdx = rawFrameIndices[rawFrameIndices.length - 1];
  const lastKf = keyframeIndices[keyframeIndices.length - 1];
  if (
    lastKf !== undefined &&
    endNetIdx > lastKf &&
    networkFrames[endNetIdx].timeSeconds > networkFrames[lastKf].timeSeconds + 1e-5
  ) {
    const rbLast = getRigidBodyFromNetworkFrame(networkFrames[lastKf], slot);
    if (isRest(rbLast) || isRigidBodyUpdatedInFrame(networkFrames[endNetIdx], slot) === true) {
      keyframeIndices.push(endNetIdx);
    }
  }
  return {
    startNetIdx: rawFrameIndices[0],
    endNetIdx,
    keyframeIndices,
  };
}

export function extractEntityLifeSpans(
  networkFrames: readonly RLRCSourceNetworkFrame[],
  slot: number | 'ball',
  allLifeSegments: readonly RLRCSourceEntityLifeSegment[],
  maxTeleportDistanceUu = 450
): RLRCEntitySpan[] {
  const slotSegments =
    slot === 'ball' ? [] : allLifeSegments.filter((seg) => seg.slotIndex === slot);
  const spans: RLRCEntitySpan[] = [];
  let rawIndices: number[] = [];
  let currentSegmentKey = -1;
  let lastUpdatedFrameIdx = -1;

  for (let i = 0; i < networkFrames.length; i++) {
    const nf = networkFrames[i];
    const isActive =
      slot === 'ball'
        ? nf.ball.entityActive
        : Boolean(getCarFromNetworkFrame(nf, slot)?.entityActive);
    if (!isActive) {
      if (rawIndices.length > 0) {
        spans.push(buildEntityKeyframeSpan(networkFrames, rawIndices, slot));
        rawIndices = [];
      }
      currentSegmentKey = -1;
      lastUpdatedFrameIdx = -1;
      continue;
    }

    const segIdx = slotSegments.findIndex(
      (seg) => nf.sourceFrame30Hz >= seg.startFrame30Hz && nf.sourceFrame30Hz <= seg.endFrame30Hz
    );
    const segmentKey = segIdx >= 0 ? slotSegments[segIdx].carActorId * 100000 + segIdx : -1;
    const prevRawIdx = rawIndices.length > 0 ? rawIndices[rawIndices.length - 1] : -1;
    const isKickoffReset =
      i > 0 && nf.roundCountdownNumber > 0 && networkFrames[i - 1].roundCountdownNumber === 0;
    const refIdx = lastUpdatedFrameIdx >= 0 ? lastUpdatedFrameIdx : prevRawIdx;
    const currRb = getRigidBodyFromNetworkFrame(nf, slot);

    let teleported = false;
    let kinematicJump = false;
    if (prevRawIdx >= 0 && refIdx >= 0) {
      const refFrame = networkFrames[refIdx];
      const refRb = getRigidBodyFromNetworkFrame(refFrame, slot);
      const dt = clamp(nf.timeSeconds - refFrame.timeSeconds, nf.deltaSeconds || 1 / 30, 0.16);
      const distance = vDist(currRb.position, refRb.position);
      const secantSpeed = distance / Math.max(dt, 1e-4);
      const velRef = calibrateNetStreamVel(refRb.linearVelocity, secantSpeed);
      const velCurr = calibrateNetStreamVel(currRb.linearVelocity, secantSpeed);
      const errForward = vDist(currRb.position, vAdd(refRb.position, vScale(velRef, dt)));
      const errBackward = vDist(refRb.position, vSub(currRb.position, vScale(velCurr, dt)));
      const errMidpoint = vDist(
        currRb.position,
        vAdd(refRb.position, vScale(vAdd(velRef, velCurr), 0.5 * dt))
      );
      const minKinematicError = Math.min(errForward, errBackward, errMidpoint);
      teleported = distance > maxTeleportDistanceUu && minKinematicError > maxTeleportDistanceUu;
      kinematicJump = teleported || (distance > 25 && minKinematicError > 40);
    }

    if (
      prevRawIdx >= 0 &&
      ((slotSegments.length > 0 && segmentKey !== currentSegmentKey) ||
        isKickoffReset ||
        teleported)
    ) {
      if (!kinematicJump) {
        const refRb = getRigidBodyFromNetworkFrame(networkFrames[refIdx], slot);
        const posInRaw = rawIndices.indexOf(refIdx);
        if (posInRaw > 0 && refIdx < i && isDupRb(refRb, currRb) && !isRest(refRb)) {
          spans.push(
            buildEntityKeyframeSpan(networkFrames, rawIndices.slice(0, posInRaw + 1), slot)
          );
          rawIndices = rawIndices.slice(posInRaw);
        } else {
          rawIndices.push(i);
          spans.push(buildEntityKeyframeSpan(networkFrames, rawIndices, slot));
          rawIndices = [];
        }
      } else {
        spans.push(buildEntityKeyframeSpan(networkFrames, rawIndices, slot));
        rawIndices = [];
      }
    }

    if (
      rawIndices.length === 0 ||
      isRigidBodyUpdatedInFrame(nf, slot) === true ||
      (refIdx >= 0 && !isDupRb(getRigidBodyFromNetworkFrame(networkFrames[refIdx], slot), currRb))
    ) {
      lastUpdatedFrameIdx = i;
    }
    rawIndices.push(i);
    currentSegmentKey = segmentKey;
  }

  if (rawIndices.length > 0) {
    spans.push(buildEntityKeyframeSpan(networkFrames, rawIndices, slot));
  }
  return spans;
}

export function locateKeyframeBracket(
  networkFrames: readonly RLRCSourceNetworkFrame[],
  spans: readonly RLRCEntitySpan[],
  targetTimeSeconds: number,
  currentNetIdx: number,
  nearestNetIdx: number,
  slot: number | 'ball'
): RLRCKeyframeBracket | null {
  let span =
    spans.find(
      (s) =>
        nearestNetIdx >= s.startNetIdx &&
        nearestNetIdx <= s.endNetIdx &&
        targetTimeSeconds >= networkFrames[s.startNetIdx].timeSeconds &&
        targetTimeSeconds <= networkFrames[s.endNetIdx].timeSeconds
    ) ??
    spans.find(
      (s) =>
        targetTimeSeconds >= networkFrames[s.startNetIdx].timeSeconds - 1e-4 &&
        targetTimeSeconds <= networkFrames[s.endNetIdx].timeSeconds + 1e-4
    ) ??
    spans.find((s) => nearestNetIdx >= s.startNetIdx && nearestNetIdx <= s.endNetIdx);

  if (!span) {
    const prevSpan = spans.find((s) => s.endNetIdx === currentNetIdx);
    const nextSpan = spans.find((s) => s.startNetIdx === currentNetIdx + 1);
    if (prevSpan && (nextSpan || nearestNetIdx === currentNetIdx)) {
      span = prevSpan;
    } else if (nextSpan && nearestNetIdx === currentNetIdx + 1) {
      span = nextSpan;
    }
  }
  if (!span || span.keyframeIndices.length === 0) return null;

  const kf = span.keyframeIndices;
  const lastKf = kf[kf.length - 1];
  if (kf.length === 1 || targetTimeSeconds <= networkFrames[kf[0]].timeSeconds) {
    return { k0Idx: kf[0], k1Idx: kf[0], alpha: 0, dt: 0, rest0: false, rest1: false };
  }
  if (targetTimeSeconds >= networkFrames[lastKf].timeSeconds) {
    return { k0Idx: lastKf, k1Idx: lastKf, alpha: 0, dt: 0, rest0: false, rest1: false };
  }

  let lo = 0;
  let hi = kf.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (networkFrames[kf[mid]].timeSeconds <= targetTimeSeconds) lo = mid;
    else hi = mid;
  }

  const k0Idx = kf[lo];
  const k1Idx = kf[hi];
  const t0 = networkFrames[k0Idx].timeSeconds;
  const dt = networkFrames[k1Idx].timeSeconds - t0;
  const rb0 = getRigidBodyFromNetworkFrame(networkFrames[k0Idx], slot);
  const rb1 = getRigidBodyFromNetworkFrame(networkFrames[k1Idx], slot);
  return {
    k0Idx,
    k1Idx,
    alpha: dt > 1e-6 ? clamp((targetTimeSeconds - t0) / dt, 0, 1) : 0,
    dt,
    rest0: lo > 0 && isDupRb(getRigidBodyFromNetworkFrame(networkFrames[kf[lo - 1]], slot), rb0),
    rest1:
      hi + 1 < kf.length &&
      isDupRb(rb1, getRigidBodyFromNetworkFrame(networkFrames[kf[hi + 1]], slot)),
  };
}
