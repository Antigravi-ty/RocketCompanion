/**
 * RLRCTrack0TimelineBatchPacker.ts
 * Batch Track 0 binary packer, in-place synthesized controls writer, and lazy Proxy
 * timeline view over a flat `stateInputTrackBytes` Uint8Array.
 */

import {
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  EXTENDED_STATE_OFFSETS,
  SIM_OFFSETS,
} from '../../../physics/RocketSimConstants.ts';
import { packCarControlsToTrack64 } from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_CONTROLS_BYTES_PER_FRAME,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_BYTES_PER_FRAME,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
} from '../RLRCReplayTypes.ts';
import {
  packRLRCFrameToTrack0Slot,
  unpackRLRCFrameFromTrack0Slot,
} from './RLRCTrack0FrameSlotPacker.ts';

const MAX_PACKED_SLOTS = 8;

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
    if (idx >= 0 && idx < MAX_PACKED_SLOTS) {
      packCarControlsToTrack64(out, idx, { ...car.controls });
    }
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
  const frameCount = Math.floor(stateInputTrackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES);
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
