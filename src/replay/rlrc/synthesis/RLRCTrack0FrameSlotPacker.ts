/**
 * RLRCTrack0FrameSlotPacker.ts
 * Zero-GC fixed-stride (1856 bytes/frame) Track 0 binary packer,
 * in-place synthesized controls writer, and lazy Proxy timeline view over a flat
 * stateInputTrackBytes Uint8Array.
 */

import {
  BALL_STATE_OFFSETS,
  BOOST_PAD_OFFSETS,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  EXTENDED_STATE_OFFSETS,
  SIM_OFFSETS,
} from '../../../physics/RocketSimConstants.ts';
import { packCarControlsToTrack64 } from '../../container/RCReplayBinarySchema.ts';
import {
  resolveRLRCTrack0FrameByteOffset,
  unpackRLRCFrameFromTrack0Slot,
} from '../container/RLRCTrack0FrameSlotPacker.ts';
import {
  RLRC_BOOST_PAD_COUNT,
  RLRC_CONTROLS_BYTES_PER_FRAME,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_BYTES_PER_FRAME,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCRigidBodySample,
} from '../RLRCReplayTypes.ts';
import { quatToBasisVectors } from './RLRCHermiteSlerpMathPipeline.ts';

const MAX_PACKED_SLOTS = 8;

function writeRigidBodyToStateBuffer(
  dstF32: Float32Array,
  base: number,
  rb: RLRCRigidBodySample
): void {
  const { position, rotation, linearVelocity, angularVelocity } = rb;
  const { fwd, right, up } = quatToBasisVectors(rotation);
  dstF32[base + 0] = position.x;
  dstF32[base + 1] = position.y;
  dstF32[base + 2] = position.z;
  dstF32[base + 3] = fwd.x;
  dstF32[base + 4] = fwd.y;
  dstF32[base + 5] = fwd.z;
  dstF32[base + 6] = right.x;
  dstF32[base + 7] = right.y;
  dstF32[base + 8] = right.z;
  dstF32[base + 9] = up.x;
  dstF32[base + 10] = up.y;
  dstF32[base + 11] = up.z;
  dstF32[base + 12] = linearVelocity.x;
  dstF32[base + 13] = linearVelocity.y;
  dstF32[base + 14] = linearVelocity.z;
  dstF32[base + 15] = angularVelocity.x;
  dstF32[base + 16] = angularVelocity.y;
  dstF32[base + 17] = angularVelocity.z;
}

export function packRLRCFrameToTrack0Slot(
  frame: RLRCFrame120Hz,
  targetTrackBytes: Uint8Array,
  frameByteOffset = resolveRLRCTrack0FrameByteOffset(frame.frameIndex120Hz)
): void {
  const dstF32 = new Float32Array(
    targetTrackBytes.buffer,
    targetTrackBytes.byteOffset + frameByteOffset,
    RLRC_STATE_FLOATS_PER_FRAME
  );
  dstF32.fill(0);

  let activeCarCount = 0;
  const carCount = Math.min(RLRC_MAX_PLAYER_SLOTS, frame.cars.length);
  for (let i = 0; i < carCount; i++) {
    if (frame.cars[i]?.entityActive) activeCarCount++;
  }

  dstF32[SIM_OFFSETS.TICK] = frame.frameIndex120Hz;
  dstF32[SIM_OFFSETS.GOAL] = frame.sourceFrame30Hz;
  dstF32[SIM_OFFSETS.NUM_CARS] = activeCarCount;
  dstF32[SIM_OFFSETS.NUM_PADS] = RLRC_BOOST_PAD_COUNT;

  const ballRb = frame.ball.rigidBody;
  writeRigidBodyToStateBuffer(dstF32, SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS, ballRb);

  const ctrlSlice = targetTrackBytes.subarray(
    frameByteOffset + RLRC_STATE_BYTES_PER_FRAME,
    frameByteOffset + RLRC_TRACK0_FRAME_STRIDE_BYTES
  );
  ctrlSlice.fill(0);

  for (let s = 0; s < RLRC_MAX_PLAYER_SLOTS; s++) {
    const car = frame.cars[s];
    const slot =
      car && car.slotIndex >= 0 && car.slotIndex < RLRC_MAX_PLAYER_SLOTS ? car.slotIndex : s;
    const carBase = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
    const jumpAirBase =
      EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_BASE + slot * EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_STRIDE;

    if (car?.rigidBody) {
      writeRigidBodyToStateBuffer(dstF32, carBase + CAR_STATE_OFFSETS.POS, car.rigidBody);
    }

    if (!car || !car.entityActive) {
      dstF32[carBase + CAR_STATE_OFFSETS.DEMOED] = 1;
      dstF32[carBase + CAR_STATE_OFFSETS.GROUND_NORMAL + 2] = 1;
      continue;
    }

    dstF32[carBase + CAR_STATE_OFFSETS.BOOST] = car.boostAmount;
    dstF32[carBase + CAR_STATE_OFFSETS.ON_GROUND] = car.isOnGround ? 1 : 0;
    dstF32[carBase + CAR_STATE_OFFSETS.SUPERSONIC] = car.isSupersonic ? 1 : 0;
    dstF32[carBase + CAR_STATE_OFFSETS.DEMOED] = 0;
    dstF32[carBase + CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = car.hasFlipOrJump ? 1 : 0;
    dstF32[carBase + CAR_STATE_OFFSETS.IS_BOOSTING] =
      car.activeFlags.boostActive || car.controls.boost ? 1 : 0;
    dstF32[carBase + CAR_STATE_OFFSETS.IS_FLIPPING] =
      car.activeFlags.dodgeActive || car.activeFlags.doubleJumpActive ? 1 : 0;
    dstF32[carBase + CAR_STATE_OFFSETS.GROUND_NORMAL + 2] = 1;

    dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_IS_JUMPING_OFFSET] =
      car.activeFlags.jumpActive ? 1 : 0;
    dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_OFFSET] =
      car.activeFlags.doubleJumpActive ? 1 : 0;
    dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_JUMP_TIME_OFFSET] =
      car.activeFlags.dodgeActive ? 1 : 0;
    dstF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_SINCE_JUMP_OFFSET] =
      car.airTimeSinceJump;

    packCarControlsToTrack64(ctrlSlice, slot, {
      throttle: car.controls.throttle,
      steer: car.controls.steer,
      pitch: car.controls.pitch,
      yaw: car.controls.yaw,
      roll: car.controls.roll,
      jump: car.controls.jump,
      boost: car.controls.boost,
      handbrake: car.controls.handbrake,
    });
  }

  for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
    const padBase = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
    const cooldown = frame.boostPadCooldowns[p] ?? 0;
    dstF32[padBase + BOOST_PAD_OFFSETS.IS_ACTIVE] = cooldown <= 1e-4 ? 1 : 0;
    dstF32[padBase + BOOST_PAD_OFFSETS.COOLDOWN] = Math.max(0, cooldown);
  }

  dstF32[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING] =
    (frame.ball.entityActive ? 0 : 2) | (ballRb.sleeping ? 1 : 0);
  dstF32[EXTENDED_STATE_OFFSETS.IS_SIMULATION_FROZEN] = frame.secondsRemaining;
  dstF32[EXTENDED_STATE_OFFSETS.POSSESSION_STATE] =
    (frame.isOvertime ? 1 : 0) | ((frame.roundCountdownNumber & 0xff) << 1);
  dstF32[EXTENDED_STATE_OFFSETS.POSSESSION_BLUE_POINTS] = frame.blueScore;
  dstF32[EXTENDED_STATE_OFFSETS.POSSESSION_ORANGE_POINTS] = frame.orangeScore;
  dstF32[EXTENDED_STATE_OFFSETS.POSSESSION_DURATION] = frame.timeSeconds;
}

export function packRLRCFramesToTrack0Bytes(
  frames120Hz: readonly RLRCFrame120Hz[],
  targetTrackBytes?: Uint8Array
): Uint8Array {
  const requiredBytes = frames120Hz.length * RLRC_TRACK0_FRAME_STRIDE_BYTES;
  const out =
    targetTrackBytes && targetTrackBytes.byteLength >= requiredBytes
      ? targetTrackBytes
      : new Uint8Array(requiredBytes);

  for (let f = 0; f < frames120Hz.length; f++) {
    packRLRCFrameToTrack0Slot(frames120Hz[f], out, f * RLRC_TRACK0_FRAME_STRIDE_BYTES);
  }
  return out;
}

export function packRLRCFrameControlsTo64Bytes(
  cars: readonly RLRCCarFrameState120Hz[],
  targetU8?: Uint8Array,
  off = 0
): Uint8Array {
  const out =
    targetU8 && targetU8.byteLength >= off + RLRC_CONTROLS_BYTES_PER_FRAME
      ? targetU8.subarray(off, off + RLRC_CONTROLS_BYTES_PER_FRAME)
      : new Uint8Array(RLRC_CONTROLS_BYTES_PER_FRAME);
  out.fill(0);
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    if (!car?.entityActive) continue;
    const idx = car.slotIndex >= 0 && car.slotIndex < MAX_PACKED_SLOTS ? car.slotIndex : i;
    if (idx >= 0 && idx < MAX_PACKED_SLOTS) packCarControlsToTrack64(out, idx, { ...car.controls });
  }
  return out;
}

export function writeSynthesizedControlsToTrack0Buffer(
  frames: readonly RLRCFrame120Hz[],
  trackBytes: Uint8Array
): void {
  const maxF = Math.min(
    frames.length,
    Math.floor(trackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES)
  );
  const {
    CAR_JUMP_AIR_BASE: j0,
    CAR_JUMP_AIR_STRIDE: jS,
    CAR_IS_JUMPING_OFFSET: oJ,
    CAR_AIR_TIME_OFFSET: oDj,
    CAR_JUMP_TIME_OFFSET: oDg,
    CAR_AIR_TIME_SINCE_JUMP_OFFSET: oAt,
  } = EXTENDED_STATE_OFFSETS;
  const { HAS_FLIP_OR_JUMP: oFlp, IS_BOOSTING: oBst, IS_FLIPPING: oFl } = CAR_STATE_OFFSETS;

  for (let f = 0; f < maxF; f++) {
    const off = f * RLRC_TRACK0_FRAME_STRIDE_BYTES;
    const dst = new Float32Array(
      trackBytes.buffer,
      trackBytes.byteOffset + off,
      RLRC_STATE_FLOATS_PER_FRAME
    );
    const cars = frames[f].cars;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) continue;
      const slot = car.slotIndex >= 0 && car.slotIndex < RLRC_MAX_PLAYER_SLOTS ? car.slotIndex : i;
      if (slot < 0 || slot >= RLRC_MAX_PLAYER_SLOTS) continue;
      const cB = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
      const jB = j0 + slot * jS;
      const act = car.entityActive;
      const fl = car.activeFlags;
      dst[cB + oFlp] = act && car.hasFlipOrJump ? 1 : 0;
      dst[cB + oBst] = act && (fl.boostActive || car.controls.boost) ? 1 : 0;
      dst[cB + oFl] = act && (fl.dodgeActive || fl.doubleJumpActive) ? 1 : 0;
      dst[jB + oJ] = act && fl.jumpActive ? 1 : 0;
      dst[jB + oDj] = act && fl.doubleJumpActive ? 1 : 0;
      dst[jB + oDg] = act && fl.dodgeActive ? 1 : 0;
      dst[jB + oAt] = act ? car.airTimeSinceJump : 0;
    }
    packRLRCFrameControlsTo64Bytes(cars, trackBytes, off + RLRC_STATE_BYTES_PER_FRAME);
  }
}

/**
 * Creates a lightweight array-like view over `stateInputTrackBytes` that unpacks
 * `RLRCFrame120Hz` on demand with a bounded ring cache, eliminating the need to keep
 * 36,000+ deep JS frame object graphs in heap memory after conversion.
 */
export function createLazyTrack0FramesView(
  stateInputTrackBytes: Uint8Array,
  cacheSize = 16
): readonly RLRCFrame120Hz[] {
  const frameCount = Math.floor(
    stateInputTrackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES
  );
  if (frameCount <= 0) return [];

  const ringIndices = new Int32Array(cacheSize).fill(-1);
  const ringFrames: Array<RLRCFrame120Hz | undefined> = new Array(cacheSize);
  let ringCursor = 0;

  const getFrameAt = (index: number): RLRCFrame120Hz | undefined => {
    if (index < 0 || index >= frameCount) return undefined;
    for (let i = 0; i < cacheSize; i++) {
      if (ringIndices[i] === index && ringFrames[i] !== undefined) {
        return ringFrames[i];
      }
    }
    const unpacked = unpackRLRCFrameFromTrack0Slot(stateInputTrackBytes, index);
    ringIndices[ringCursor] = index;
    ringFrames[ringCursor] = unpacked;
    ringCursor = (ringCursor + 1) % cacheSize;
    return unpacked;
  };

  const target: RLRCFrame120Hz[] = [];
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'length') return frameCount;
      if (typeof prop === 'string') {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0 && idx < frameCount) {
          return getFrameAt(idx);
        }
      }
      if (prop === Symbol.iterator) {
        return function* () {
          for (let i = 0; i < frameCount; i++) {
            yield getFrameAt(i)!;
          }
        };
      }
      return Reflect.get(obj, prop, receiver);
    },
    has(obj, prop) {
      if (typeof prop === 'string') {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0 && idx < frameCount) return true;
      }
      return Reflect.has(obj, prop);
    },
  });
}
