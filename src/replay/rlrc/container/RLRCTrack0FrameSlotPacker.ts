/**
 * RLRCTrack0FrameSlotPacker.ts
 * Zero-GC fixed-stride (1856 bytes/frame) packer and unpacker between RLRCFrame120Hz
 * and Track 0 (448-float physics state + 64-byte synthesized controls).
 */

import {
  BALL_STATE_OFFSETS as B_OFF,
  BOOST_PAD_OFFSETS as P_OFF,
  BOOST_PAD_STATE_STRIDE as P_STRIDE,
  BOOST_PAD_STATES_OFFSET as P_BASE,
  CAR_STATE_OFFSETS as C_OFF,
  CAR_STATE_STRIDE as C_STRIDE,
  EXTENDED_STATE_OFFSETS as EXT,
  SIM_OFFSETS as SIM,
} from '../../../physics/RocketSimConstants.ts';
import {
  packCarControlsToTrack64,
  unpackTrack64ToCarControls,
  type ReplayCarControlState,
} from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_BOOST_PAD_COUNT,
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_BYTES_PER_FRAME,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCBallFrameState120Hz,
  type RLRCCarComponentActiveFlags,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCQuat,
  type RLRCRigidBodySample,
  type RLRCSynthesizedCarControls,
} from '../RLRCReplayTypes.ts';

export function resolveRLRCTrack0FrameByteOffset(frameIndex120Hz: number): number {
  return Math.max(0, Math.trunc(frameIndex120Hz)) * RLRC_TRACK0_FRAME_STRIDE_BYTES;
}

function writeQuatBasisToStateBuffer(q: RLRCQuat, dstF32: Float32Array, fwdOffset: number): void {
  const { x, y, z, w } = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  dstF32[fwdOffset + 0] = 1 - (yy + zz);
  dstF32[fwdOffset + 1] = xy + wz;
  dstF32[fwdOffset + 2] = xz - wy;
  dstF32[fwdOffset + 3] = xy - wz;
  dstF32[fwdOffset + 4] = 1 - (xx + zz);
  dstF32[fwdOffset + 5] = yz + wx;
  dstF32[fwdOffset + 6] = xz + wy;
  dstF32[fwdOffset + 7] = yz - wx;
  dstF32[fwdOffset + 8] = 1 - (xx + yy);
}

function writeRigidBodyToStateBuffer(
  dstF32: Float32Array,
  posOffset: number,
  rotOffset: number,
  rb: RLRCRigidBodySample
): void {
  dstF32[posOffset + 0] = rb.position.x;
  dstF32[posOffset + 1] = rb.position.y;
  dstF32[posOffset + 2] = rb.position.z;
  writeQuatBasisToStateBuffer(rb.rotation, dstF32, rotOffset);
  dstF32[posOffset + 12] = rb.linearVelocity.x;
  dstF32[posOffset + 13] = rb.linearVelocity.y;
  dstF32[posOffset + 14] = rb.linearVelocity.z;
  dstF32[posOffset + 15] = rb.angularVelocity.x;
  dstF32[posOffset + 16] = rb.angularVelocity.y;
  dstF32[posOffset + 17] = rb.angularVelocity.z;
}

function readQuatFromBasisInStateBuffer(srcF32: Float32Array, fwdOffset: number): RLRCQuat {
  const m00 = srcF32[fwdOffset + 0];
  const m10 = srcF32[fwdOffset + 1];
  const m20 = srcF32[fwdOffset + 2];
  const m01 = srcF32[fwdOffset + 3];
  const m11 = srcF32[fwdOffset + 4];
  const m21 = srcF32[fwdOffset + 5];
  const m02 = srcF32[fwdOffset + 6];
  const m12 = srcF32[fwdOffset + 7];
  const m22 = srcF32[fwdOffset + 8];

  const trace = m00 + m11 + m22;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 1;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }

  const len = Math.hypot(x, y, z, w);
  if (len <= 1e-8) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: x / len, y: y / len, z: z / len, w: w / len };
}

function readRigidBodyFromStateBuffer(
  srcF32: Float32Array,
  posOffset: number,
  rotOffset: number,
  sleeping: boolean
): RLRCRigidBodySample {
  return {
    sleeping,
    position: {
      x: srcF32[posOffset + 0],
      y: srcF32[posOffset + 1],
      z: srcF32[posOffset + 2],
    },
    rotation: readQuatFromBasisInStateBuffer(srcF32, rotOffset),
    linearVelocity: {
      x: srcF32[posOffset + 12],
      y: srcF32[posOffset + 13],
      z: srcF32[posOffset + 14],
    },
    angularVelocity: {
      x: srcF32[posOffset + 15],
      y: srcF32[posOffset + 16],
      z: srcF32[posOffset + 17],
    },
  };
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

  dstF32[SIM.TICK] = frame.frameIndex120Hz;
  dstF32[SIM.GOAL] = frame.sourceFrame30Hz;
  dstF32[SIM.NUM_CARS] = activeCarCount;
  dstF32[SIM.NUM_PADS] = RLRC_BOOST_PAD_COUNT;

  const ballBase = SIM.BALL;
  const ballRb = frame.ball.rigidBody;
  writeRigidBodyToStateBuffer(dstF32, ballBase + B_OFF.POS, ballBase + B_OFF.ROT_MAT, ballRb);

  const ctrlSlice = targetTrackBytes.subarray(
    frameByteOffset + RLRC_STATE_BYTES_PER_FRAME,
    frameByteOffset + RLRC_TRACK0_FRAME_STRIDE_BYTES
  );
  ctrlSlice.fill(0);

  for (let s = 0; s < RLRC_MAX_PLAYER_SLOTS; s++) {
    const car = frame.cars[s];
    const slot =
      car && car.slotIndex >= 0 && car.slotIndex < RLRC_MAX_PLAYER_SLOTS ? car.slotIndex : s;
    const carBase = SIM.CARS + slot * C_STRIDE;
    const jumpAirBase = EXT.CAR_JUMP_AIR_BASE + slot * EXT.CAR_JUMP_AIR_STRIDE;

    if (car?.rigidBody) {
      writeRigidBodyToStateBuffer(dstF32, carBase + C_OFF.POS, carBase + C_OFF.FWD, car.rigidBody);
    }

    if (!car || !car.entityActive) {
      dstF32[carBase + C_OFF.DEMOED] = 1;
      dstF32[carBase + C_OFF.GROUND_NORMAL + 2] = 1;
      continue;
    }

    const fl = car.activeFlags;
    dstF32[carBase + C_OFF.BOOST] = car.boostAmount;
    dstF32[carBase + C_OFF.ON_GROUND] = car.isOnGround ? 1 : 0;
    dstF32[carBase + C_OFF.SUPERSONIC] = car.isSupersonic ? 1 : 0;
    dstF32[carBase + C_OFF.DEMOED] = 0;
    dstF32[carBase + C_OFF.HAS_FLIP_OR_JUMP] = car.hasFlipOrJump ? 1 : 0;
    dstF32[carBase + C_OFF.IS_BOOSTING] = fl.boostActive || car.controls.boost ? 1 : 0;
    dstF32[carBase + C_OFF.IS_FLIPPING] = fl.dodgeActive || fl.doubleJumpActive ? 1 : 0;
    dstF32[carBase + C_OFF.GROUND_NORMAL + 2] = 1;

    dstF32[jumpAirBase + EXT.CAR_IS_JUMPING_OFFSET] = fl.jumpActive ? 1 : 0;
    dstF32[jumpAirBase + EXT.CAR_AIR_TIME_OFFSET] = fl.doubleJumpActive ? 1 : 0;
    dstF32[jumpAirBase + EXT.CAR_JUMP_TIME_OFFSET] = fl.dodgeActive ? 1 : 0;
    dstF32[jumpAirBase + EXT.CAR_AIR_TIME_SINCE_JUMP_OFFSET] = car.airTimeSinceJump;

    packCarControlsToTrack64(ctrlSlice, slot, { ...car.controls });
  }

  for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
    const padBase = P_BASE + p * P_STRIDE;
    const cooldown = frame.boostPadCooldowns[p] ?? 0;
    dstF32[padBase + P_OFF.IS_ACTIVE] = cooldown <= 1e-4 ? 1 : 0;
    dstF32[padBase + P_OFF.COOLDOWN] = Math.max(0, cooldown);
  }

  dstF32[EXT.IS_BALL_SLEEPING] = (frame.ball.entityActive ? 0 : 2) | (ballRb.sleeping ? 1 : 0);
  dstF32[EXT.IS_SIMULATION_FROZEN] = frame.secondsRemaining;
  dstF32[EXT.POSSESSION_STATE] =
    (frame.isOvertime ? 1 : 0) | ((frame.roundCountdownNumber & 0xff) << 1);
  dstF32[EXT.POSSESSION_BLUE_POINTS] = frame.blueScore;
  dstF32[EXT.POSSESSION_ORANGE_POINTS] = frame.orangeScore;
  dstF32[EXT.POSSESSION_DURATION] = frame.timeSeconds;
}

export function unpackRLRCFrameFromTrack0Slot(
  sourceTrackBytes: Uint8Array,
  frameIndex120Hz: number
): RLRCFrame120Hz {
  const frameByteOffset = resolveRLRCTrack0FrameByteOffset(frameIndex120Hz);
  const srcF32 = new Float32Array(
    sourceTrackBytes.buffer,
    sourceTrackBytes.byteOffset + frameByteOffset,
    RLRC_STATE_FLOATS_PER_FRAME
  );
  const ctrlSlice = sourceTrackBytes.subarray(
    frameByteOffset + RLRC_STATE_BYTES_PER_FRAME,
    frameByteOffset + RLRC_TRACK0_FRAME_STRIDE_BYTES
  );
  const unpackedControls: ReplayCarControlState[] = unpackTrack64ToCarControls(ctrlSlice);

  const ballBase = SIM.BALL;
  const ballFlags = Math.round(srcF32[EXT.IS_BALL_SLEEPING]);
  const ball: RLRCBallFrameState120Hz = {
    entityActive: (ballFlags & 2) === 0,
    rigidBody: readRigidBodyFromStateBuffer(
      srcF32,
      ballBase + B_OFF.POS,
      ballBase + B_OFF.ROT_MAT,
      (ballFlags & 1) !== 0
    ),
  };

  const cars: RLRCCarFrameState120Hz[] = new Array(RLRC_MAX_PLAYER_SLOTS);
  for (let s = 0; s < RLRC_MAX_PLAYER_SLOTS; s++) {
    const carBase = SIM.CARS + s * C_STRIDE;
    const jumpAirBase = EXT.CAR_JUMP_AIR_BASE + s * EXT.CAR_JUMP_AIR_STRIDE;
    const rawCtrl = unpackedControls[s];
    const controls: RLRCSynthesizedCarControls = {
      throttle: rawCtrl ? rawCtrl.throttle : 0,
      steer: rawCtrl ? rawCtrl.steer : 0,
      pitch: rawCtrl ? rawCtrl.pitch : 0,
      yaw: rawCtrl ? rawCtrl.yaw : 0,
      roll: rawCtrl ? rawCtrl.roll : 0,
      jump: rawCtrl ? rawCtrl.jump : false,
      boost: rawCtrl ? rawCtrl.boost : false,
      handbrake: rawCtrl ? rawCtrl.handbrake : false,
    };
    const activeFlags: RLRCCarComponentActiveFlags = {
      boostActive: srcF32[carBase + C_OFF.IS_BOOSTING] >= 0.5,
      jumpActive: srcF32[jumpAirBase + EXT.CAR_IS_JUMPING_OFFSET] >= 0.5,
      doubleJumpActive: srcF32[jumpAirBase + EXT.CAR_AIR_TIME_OFFSET] >= 0.5,
      dodgeActive: srcF32[jumpAirBase + EXT.CAR_JUMP_TIME_OFFSET] >= 0.5,
    };
    cars[s] = {
      slotIndex: s,
      entityActive: srcF32[carBase + C_OFF.DEMOED] < 0.5,
      rigidBody: readRigidBodyFromStateBuffer(
        srcF32,
        carBase + C_OFF.POS,
        carBase + C_OFF.FWD,
        false
      ),
      boostAmount: srcF32[carBase + C_OFF.BOOST],
      isOnGround: srcF32[carBase + C_OFF.ON_GROUND] >= 0.5,
      isSupersonic: srcF32[carBase + C_OFF.SUPERSONIC] >= 0.5,
      hasFlipOrJump: srcF32[carBase + C_OFF.HAS_FLIP_OR_JUMP] >= 0.5,
      airTimeSinceJump: srcF32[jumpAirBase + EXT.CAR_AIR_TIME_SINCE_JUMP_OFFSET],
      activeFlags,
      controls,
    };
  }

  const boostPadCooldowns = new Float32Array(RLRC_BOOST_PAD_COUNT);
  for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
    boostPadCooldowns[p] = srcF32[P_BASE + p * P_STRIDE + P_OFF.COOLDOWN];
  }

  const packedMatchFlags = Math.round(srcF32[EXT.POSSESSION_STATE]);
  const storedTime = srcF32[EXT.POSSESSION_DURATION];

  return {
    frameIndex120Hz,
    sourceFrame30Hz: Math.round(srcF32[SIM.GOAL]),
    timeSeconds: storedTime > 0 ? storedTime : frameIndex120Hz * RLRC_FIXED_DT,
    secondsRemaining: Math.round(srcF32[EXT.IS_SIMULATION_FROZEN]),
    isOvertime: (packedMatchFlags & 1) !== 0,
    roundCountdownNumber: (packedMatchFlags >>> 1) & 0xff,
    blueScore: Math.round(srcF32[EXT.POSSESSION_BLUE_POINTS]),
    orangeScore: Math.round(srcF32[EXT.POSSESSION_ORANGE_POINTS]),
    ball,
    cars,
    boostPadCooldowns,
  };
}
