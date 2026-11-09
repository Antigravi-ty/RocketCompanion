/**
 * RLRCHermiteSlerpResampler.ts
 * Pure 120Hz timeline resampling scheduler and bookmark alignment for RLRC replays,
 * delegating entity lifespan span extraction to RLRCEntityLifeSpanBuilder and
 * rigid-body Hermite/quaternion interpolation to RLRCHermiteSlerpMathPipeline.
 */

import { packRLRCFramesToTrack0Bytes } from '../container/RLRCTrack0TimelineBatchPacker.ts';
import {
  RLRC_BOOST_PAD_COUNT,
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_TICK_RATE,
  type RLRCBallFrameState120Hz,
  type RLRCBookmarkRecord,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCInterpolationMethod,
  type RLRCParserOutput,
  type RLRCResamplerOutput,
  type RLRCSourceNetworkFrame,
} from '../RLRCReplayTypes.ts';
import {
  extractEntityLifeSpans,
  getCarFromNetworkFrame,
  locateKeyframeBracket,
  type RLRCEntitySpan,
  type RLRCKeyframeBracket,
} from './RLRCEntityLifeSpanBuilder.ts';
import {
  clamp,
  interpolateRigidBodyHermiteSlerp,
  lerp,
  SLEEP_RB,
  toRest,
  vLen,
  ZERO_CTRL,
  ZERO_FLAGS,
  type RLRCOrthonormalBasis,
} from './RLRCHermiteSlerpMathPipeline.ts';

export type { RLRCEntitySpan, RLRCKeyframeBracket, RLRCOrthonormalBasis };

const ZERO_BOOST_PAD_COOLDOWNS = new Float32Array(RLRC_BOOST_PAD_COUNT);

export interface RLRCResamplerOptions {
  readonly method?: RLRCInterpolationMethod;
  readonly boostPadCooldownsByFrame120Hz?: readonly Float32Array[];
  readonly maxTeleportDistanceUu?: number;
  readonly deferTrack0Packing?: boolean;
}

export function alignBookmarksTo120Hz(
  bookmarks: readonly RLRCBookmarkRecord[],
  networkFrames: readonly RLRCSourceNetworkFrame[],
  frames120Hz: readonly RLRCFrame120Hz[],
  recordFps = 30
): RLRCBookmarkRecord[] {
  if (frames120Hz.length === 0) return [];
  const startTimeSeconds = frames120Hz[0].timeSeconds;
  const maxFrameIndex = frames120Hz.length - 1;
  const effectiveFps = recordFps > 0 ? recordFps : 30;

  return bookmarks.map((bookmark) => {
    let timeSeconds = bookmark.timeSeconds;
    let nearestNetFrame = networkFrames[0];
    for (const nf of networkFrames) {
      if (
        Math.abs(nf.sourceFrame30Hz - bookmark.sourceFrame30Hz) <
        Math.abs(nearestNetFrame.sourceFrame30Hz - bookmark.sourceFrame30Hz)
      ) {
        nearestNetFrame = nf;
      }
    }
    if (
      nearestNetFrame &&
      (Math.abs(nearestNetFrame.sourceFrame30Hz - bookmark.sourceFrame30Hz) <= 2 ||
        !Number.isFinite(timeSeconds) ||
        timeSeconds <= 0)
    ) {
      timeSeconds = nearestNetFrame.timeSeconds;
    } else if (!Number.isFinite(timeSeconds) || timeSeconds <= 0) {
      timeSeconds = startTimeSeconds + bookmark.sourceFrame30Hz / effectiveFps;
    }
    const frameIndex120Hz = clamp(
      Math.round((timeSeconds - startTimeSeconds) * RLRC_TICK_RATE),
      0,
      maxFrameIndex
    );
    return {
      ...bookmark,
      frameIndex120Hz,
      timeSeconds: frames120Hz[frameIndex120Hz].timeSeconds,
    };
  });
}

export function resampleRLRCReplayTo120Hz(
  parsed: RLRCParserOutput,
  options: RLRCResamplerOptions = {}
): RLRCResamplerOutput {
  const method = options.method ?? 'hermite-clamped';
  const maxTeleportDistanceUu = options.maxTeleportDistanceUu ?? 450;
  const networkFrames = parsed.networkFrames;
  const slotCount = Math.min(
    RLRC_MAX_PLAYER_SLOTS,
    Math.max(parsed.roster.length, networkFrames[0]?.cars.length ?? 0)
  );
  if (networkFrames.length === 0) {
    return {
      header: { ...parsed.header, frameCount120Hz: 0, durationSeconds: 0 },
      roster: parsed.roster,
      bookmarks: [],
      frames120Hz: [],
      stateInputTrackBytes: new Uint8Array(0),
    };
  }

  const startTimeSeconds = networkFrames[0].timeSeconds;
  const endTimeSeconds = networkFrames[networkFrames.length - 1].timeSeconds;
  const durationSeconds = Math.max(0, endTimeSeconds - startTimeSeconds);
  const frameCount120Hz = Math.max(1, Math.round(durationSeconds * RLRC_TICK_RATE) + 1);
  const ballSpans = extractEntityLifeSpans(
    networkFrames,
    'ball',
    parsed.lifeSegments,
    maxTeleportDistanceUu
  );
  const carSpansBySlot = Array.from({ length: slotCount }, (_, slotIndex) =>
    extractEntityLifeSpans(networkFrames, slotIndex, parsed.lifeSegments, maxTeleportDistanceUu)
  );
  const frames120Hz: RLRCFrame120Hz[] = new Array(frameCount120Hz);

  for (let frameIdx = 0, currentNetIdx = 0; frameIdx < frameCount120Hz; frameIdx++) {
    const targetTime = Math.min(endTimeSeconds, startTimeSeconds + frameIdx * RLRC_FIXED_DT);
    while (
      currentNetIdx + 1 < networkFrames.length &&
      networkFrames[currentNetIdx + 1].timeSeconds <= targetTime
    ) {
      currentNetIdx++;
    }
    const nextNetFrame = networkFrames[currentNetIdx + 1] ?? networkFrames[currentNetIdx];
    const nearestNetIdx =
      Math.abs(nextNetFrame.timeSeconds - targetTime) <
      Math.abs(targetTime - networkFrames[currentNetIdx].timeSeconds)
        ? currentNetIdx + 1
        : currentNetIdx;
    const referenceNetFrame = networkFrames[nearestNetIdx];

    const ballBracket = locateKeyframeBracket(
      networkFrames,
      ballSpans,
      targetTime,
      currentNetIdx,
      nearestNetIdx,
      'ball'
    );
    const ballRb0 = ballBracket
      ? networkFrames[ballBracket.k0Idx].ball.rigidBody
      : referenceNetFrame.ball.rigidBody;
    const ballRb1 = ballBracket
      ? networkFrames[ballBracket.k1Idx].ball.rigidBody
      : referenceNetFrame.ball.rigidBody;
    const ball: RLRCBallFrameState120Hz = ballBracket
      ? {
          entityActive: true,
          rigidBody: interpolateRigidBodyHermiteSlerp(
            ballBracket.rest0 ? toRest(ballRb0) : ballRb0,
            ballBracket.rest1 ? toRest(ballRb1) : ballRb1,
            ballBracket.alpha,
            ballBracket.dt,
            method,
            4500
          ),
        }
      : { entityActive: false, rigidBody: referenceNetFrame.ball.rigidBody };

    const cars: RLRCCarFrameState120Hz[] = new Array(slotCount);
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
      const refCar = getCarFromNetworkFrame(referenceNetFrame, slotIndex);
      const carBracket = locateKeyframeBracket(
        networkFrames,
        carSpansBySlot[slotIndex],
        targetTime,
        currentNetIdx,
        nearestNetIdx,
        slotIndex
      );
      if (carBracket && refCar) {
        const car0 = getCarFromNetworkFrame(networkFrames[carBracket.k0Idx], slotIndex) ?? refCar;
        const car1 = getCarFromNetworkFrame(networkFrames[carBracket.k1Idx], slotIndex) ?? refCar;
        const nearestCar = carBracket.alpha < 0.5 ? car0 : car1;
        const rigidBody = interpolateRigidBodyHermiteSlerp(
          carBracket.rest0 ? toRest(car0.rigidBody) : car0.rigidBody,
          carBracket.rest1 ? toRest(car1.rigidBody) : car1.rigidBody,
          carBracket.alpha,
          carBracket.dt,
          method,
          2300
        );
        cars[slotIndex] = {
          slotIndex,
          entityActive: true,
          rigidBody,
          boostAmount: clamp(lerp(car0.boostAmount, car1.boostAmount, carBracket.alpha), 0, 100),
          isOnGround: rigidBody.position.z <= 20.5 || nearestCar.isOnGround,
          isSupersonic: vLen(rigidBody.linearVelocity) >= 2200 || nearestCar.isSupersonic,
          hasFlipOrJump: nearestCar.hasFlipOrJump,
          airTimeSinceJump: lerp(car0.airTimeSinceJump, car1.airTimeSinceJump, carBracket.alpha),
          activeFlags: refCar.activeFlags,
          controls: refCar.controls,
        };
      } else {
        cars[slotIndex] = {
          slotIndex,
          entityActive: false,
          rigidBody: refCar ? refCar.rigidBody : SLEEP_RB,
          boostAmount: 0,
          isOnGround: false,
          isSupersonic: false,
          hasFlipOrJump: false,
          airTimeSinceJump: 0,
          activeFlags: ZERO_FLAGS,
          controls: ZERO_CTRL,
        };
      }
    }

    const sourcePads = options.boostPadCooldownsByFrame120Hz?.[frameIdx];
    const boostPadCooldowns =
      sourcePads && sourcePads.length >= RLRC_BOOST_PAD_COUNT
        ? sourcePads.length === RLRC_BOOST_PAD_COUNT
          ? sourcePads
          : sourcePads.subarray(0, RLRC_BOOST_PAD_COUNT)
        : ZERO_BOOST_PAD_COOLDOWNS;
    const {
      sourceFrame30Hz,
      secondsRemaining,
      isOvertime,
      roundCountdownNumber,
      blueScore,
      orangeScore,
    } = referenceNetFrame;

    frames120Hz[frameIdx] = {
      frameIndex120Hz: frameIdx,
      sourceFrame30Hz,
      timeSeconds: targetTime,
      secondsRemaining,
      isOvertime,
      roundCountdownNumber,
      blueScore,
      orangeScore,
      ball,
      cars,
      boostPadCooldowns,
    };
  }

  return {
    header: {
      ...parsed.header,
      frameCount120Hz,
      durationSeconds,
    },
    roster: parsed.roster,
    bookmarks: alignBookmarksTo120Hz(
      parsed.bookmarks,
      networkFrames,
      frames120Hz,
      parsed.header.recordFps
    ),
    frames120Hz,
    stateInputTrackBytes: options.deferTrack0Packing
      ? new Uint8Array(0)
      : packRLRCFramesToTrack0Bytes(frames120Hz),
  };
}
