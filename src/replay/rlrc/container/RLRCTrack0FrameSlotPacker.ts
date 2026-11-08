/**
 * RLRCTrack0FrameSlotPacker.ts
 * Zero-GC fixed-stride (1856 bytes/frame) packer and unpacker between RLRCFrame120Hz
 * and Track 0 (448-float physics state + 64-byte synthesized controls).
 */

import {
  SIM_OFFSETS,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  BALL_STATE_OFFSETS,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_OFFSETS,
  EXTENDED_STATE_OFFSETS,
} from '../../../physics/RocketSimConstants.ts';
import {
  packCarControlsToTrack64,
  unpackTrack64ToCarControls,
  type ReplayCarControlState,
} from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_BOOST_PAD_COUNT,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_STATE_BYTES_PER_FRAME,
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

function writeQuatBasisToStateBuffer(
  q: RLRCQuat,
  dstF32: Float32Array,
  fwdOffset: number,
): void {
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

function readQuatFromBasisInStateBuffer(
  srcF32: Float32Array,
  fwdOffset: number,
): RLRCQuat {
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

export function packRLRCFrameToTrack0Slot(
  frame: RLRCFrame120Hz,
  targetTrackBytes: Uint8Array,
  frameByteOffset = 0,
): void {
  const dstF32 = new Float32Array(
    targetTrackBytes.buffer,
    targetTrackBytes.byteOffset + frameByteOffset,
    RLRC_STATE_FLOATS_PER_FRAME,
  );
  dstF32.fill(0);

  let activeCarCount = 0;
  const carCount = Math.min(RLRC_MAX_PLAYER_SLOTS, frame.cars.length);
  for (let i = 0; i < carCount; i++) {
    if (frame.cars[i].entityActive) activeCarCount++;
  }

  dstF32[SIM_OFFSETS.TICK] = frame.frameIndex120Hz;
  dstF32[SIM_OFFSETS.GOAL] = frame.sourceFrame30Hz;
  dstF32[SIM_OFFSETS.NUM_CARS] = activeCarCount;
  dstF32[SIM_OFFSETS.NUM_PADS] = RLRC_BOOST_PAD_COUNT;

  const ballBase = SIM_OFFSETS.BALL;
  const ballRb = frame.ball.rigidBody;
  dstF32[ballBase + BALL_STATE_OFFSETS.POS + 0] = ballRb.position.x;
  dstF32[ballBase + BALL_STATE_OFFSETS.POS + 1] = ballRb.position.y;
  dstF32[ballBase + BALL_STATE_OFFSETS.POS + 2] = ballRb.position.z;
  writeQuatBasisToStateBuffer(ballRb.rotation, dstF32, ballBase + BALL_STATE_OFFSETS.ROT_MAT);
  dstF32[ballBase + BALL_STATE_OFFSETS.VEL + 0] = ballRb.linearVelocity.x;
  dstF32[ballBase + BALL_STATE_OFFSETS.VEL + 1] = ballRb.linearVelocity.y;
  dstF32[ballBase + BALL_STATE_OFFSETS.VEL + 2] = ballRb.linearVelocity.z;
  dstF32[ballBase + BALL_STATE_OFFSETS.ANG_VEL + 0] = ballRb.angularVelocity.x;
  dstF32[ballBase + BALL_STATE_OFFSETS.ANG_VEL + 1] = ballRb.angularVelocity.y;
  dstF32[ballBase + BALL_STATE_OFFSETS.ANG_VEL + 2] = ballRb.angularVelocity.z;

  const ctrlSlice = targetTrackBytes.subarray(
    frameByteOffset + RLRC_STATE_BYTES_PER_FRAME,
    frameByteOffset + RLRC_TRACK0_FRAME_STRIDE_BYTES,
  );
  ctrlSlice.fill(0);

  for (let s = 0; s < RLRC_MAX_PLAYER_SLOTS; s++) {
    const car = frame.cars[s];
    const carBase = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE;
    const jumpAirBase =
      EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_BASE + s * EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_STRIDE;

    if (!car || !car.entityActive) {
      dstF32[carBase + CAR_STATE_OFFSETS.DEMOED] = 1;
      continue;
    }

    const rb = car.rigidBody;
    dstF32[carBase + CAR_STATE_OFFSETS.POS + 0] = rb.position.x;
    dstF32[carBase + CAR_STATE_OFFSETS.POS + 1] = rb.position.y;
    dstF32[carBase + CAR_STATE_OFFSETS.POS + 2] = rb.position.z;
    writeQuatBasisToStateBuffer(rb.rotation, dstF32, carBase + CAR_STATE_OFFSETS.FWD);
    dstF32[carBase + CAR_STATE_OFFSETS.VEL + 0] = rb.linearVelocity.x;
    dstF32[carBase + CAR_STATE_OFFSETS.VEL + 1] = rb.linearVelocity.y;
    dstF32[carBase + CAR_STATE_OFFSETS.VEL + 2] = rb.linearVelocity.z;
    dstF32[carBase + CAR_STATE_OFFSETS.ANG_VEL + 0] = rb.angularVelocity.x;
    dstF32[carBase + CAR_STATE_OFFSETS.ANG_VEL + 1] = rb.angularVelocity.y;
    dstF32[carBase + CAR_STATE_OFFSETS.ANG_VEL + 2] = rb.angularVelocity.z;
    dstF32[carBase + CAR_STATE_OFFSETS.BOOST] = car.boostAmount;
    dstF32[carBase + CAR_STATE_OFFSETS.ON_GROUND] = car.isOnGround ? 1 : 0;
    dstF32[carBase + CAR_STATE_OFFSETS.SUPERSONIC] = car.isSupersonic ? 1 : 0;
    dstF32[carBase + CAR_STATE_OFFSETS.DEMOED] = 0;
    dstF32[carBase + CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] = car.hasFlipOrJump ? 1 : 0;
    dstF32[carBase + CAR_STATE_OFFSETS.IS_BOOSTING] = car.activeFlags.boostActive ? 1 : 0;
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

    packCarControlsToTrack64(ctrlSlice, s, {
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

export function unpackRLRCFrameFromTrack0Slot(
  sourceTrackBytes: Uint8Array,
  frameIndex120Hz: number,
): RLRCFrame120Hz {
  const frameByteOffset = resolveRLRCTrack0FrameByteOffset(frameIndex120Hz);
  const srcF32 = new Float32Array(
    sourceTrackBytes.buffer,
    sourceTrackBytes.byteOffset + frameByteOffset,
    RLRC_STATE_FLOATS_PER_FRAME,
  );
  const ctrlSlice = sourceTrackBytes.subarray(
    frameByteOffset + RLRC_STATE_BYTES_PER_FRAME,
    frameByteOffset + RLRC_TRACK0_FRAME_STRIDE_BYTES,
  );
  const unpackedControls: ReplayCarControlState[] = unpackTrack64ToCarControls(ctrlSlice);

  const ballBase = SIM_OFFSETS.BALL;
  const ballFlags = Math.round(srcF32[EXTENDED_STATE_OFFSETS.IS_BALL_SLEEPING]);
  const ball: RLRCBallFrameState120Hz = {
    entityActive: (ballFlags & 2) === 0,
    rigidBody: {
      sleeping: (ballFlags & 1) !== 0,
      position: {
        x: srcF32[ballBase + BALL_STATE_OFFSETS.POS + 0],
        y: srcF32[ballBase + BALL_STATE_OFFSETS.POS + 1],
        z: srcF32[ballBase + BALL_STATE_OFFSETS.POS + 2],
      },
      rotation: readQuatFromBasisInStateBuffer(srcF32, ballBase + BALL_STATE_OFFSETS.ROT_MAT),
      linearVelocity: {
        x: srcF32[ballBase + BALL_STATE_OFFSETS.VEL + 0],
        y: srcF32[ballBase + BALL_STATE_OFFSETS.VEL + 1],
        z: srcF32[ballBase + BALL_STATE_OFFSETS.VEL + 2],
      },
      angularVelocity: {
        x: srcF32[ballBase + BALL_STATE_OFFSETS.ANG_VEL + 0],
        y: srcF32[ballBase + BALL_STATE_OFFSETS.ANG_VEL + 1],
        z: srcF32[ballBase + BALL_STATE_OFFSETS.ANG_VEL + 2],
      },
    },
  };

  const cars: RLRCCarFrameState120Hz[] = new Array(RLRC_MAX_PLAYER_SLOTS);
  for (let s = 0; s < RLRC_MAX_PLAYER_SLOTS; s++) {
    const carBase = SIM_OFFSETS.CARS + s * CAR_STATE_STRIDE;
    const jumpAirBase =
      EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_BASE + s * EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_STRIDE;
    const entityActive = srcF32[carBase + CAR_STATE_OFFSETS.DEMOED] < 0.5;
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
      boostActive: srcF32[carBase + CAR_STATE_OFFSETS.IS_BOOSTING] >= 0.5,
      jumpActive: srcF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_IS_JUMPING_OFFSET] >= 0.5,
      doubleJumpActive: srcF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_OFFSET] >= 0.5,
      dodgeActive: srcF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_JUMP_TIME_OFFSET] >= 0.5,
    };
    const rigidBody: RLRCRigidBodySample = {
      sleeping: false,
      position: {
        x: srcF32[carBase + CAR_STATE_OFFSETS.POS + 0],
        y: srcF32[carBase + CAR_STATE_OFFSETS.POS + 1],
        z: srcF32[carBase + CAR_STATE_OFFSETS.POS + 2],
      },
      rotation: readQuatFromBasisInStateBuffer(srcF32, carBase + CAR_STATE_OFFSETS.FWD),
      linearVelocity: {
        x: srcF32[carBase + CAR_STATE_OFFSETS.VEL + 0],
        y: srcF32[carBase + CAR_STATE_OFFSETS.VEL + 1],
        z: srcF32[carBase + CAR_STATE_OFFSETS.VEL + 2],
      },
      angularVelocity: {
        x: srcF32[carBase + CAR_STATE_OFFSETS.ANG_VEL + 0],
        y: srcF32[carBase + CAR_STATE_OFFSETS.ANG_VEL + 1],
        z: srcF32[carBase + CAR_STATE_OFFSETS.ANG_VEL + 2],
      },
    };
    cars[s] = {
      slotIndex: s,
      entityActive,
      rigidBody,
      boostAmount: srcF32[carBase + CAR_STATE_OFFSETS.BOOST],
      isOnGround: srcF32[carBase + CAR_STATE_OFFSETS.ON_GROUND] >= 0.5,
      isSupersonic: srcF32[carBase + CAR_STATE_OFFSETS.SUPERSONIC] >= 0.5,
      hasFlipOrJump: srcF32[carBase + CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] >= 0.5,
      airTimeSinceJump: srcF32[jumpAirBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_SINCE_JUMP_OFFSET],
      activeFlags,
      controls,
    };
  }

  const boostPadCooldowns = new Float32Array(RLRC_BOOST_PAD_COUNT);
  for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
    const padBase = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
    boostPadCooldowns[p] = srcF32[padBase + BOOST_PAD_OFFSETS.COOLDOWN];
  }

  const packedMatchFlags = Math.round(srcF32[EXTENDED_STATE_OFFSETS.POSSESSION_STATE]);
  const storedTime = srcF32[EXTENDED_STATE_OFFSETS.POSSESSION_DURATION];

  return {
    frameIndex120Hz,
    sourceFrame30Hz: Math.round(srcF32[SIM_OFFSETS.GOAL]),
    timeSeconds: storedTime > 0 ? storedTime : frameIndex120Hz * RLRC_FIXED_DT,
    secondsRemaining: Math.round(srcF32[EXTENDED_STATE_OFFSETS.IS_SIMULATION_FROZEN]),
    isOvertime: (packedMatchFlags & 1) !== 0,
    roundCountdownNumber: (packedMatchFlags >>> 1) & 0xff,
    blueScore: Math.round(srcF32[EXTENDED_STATE_OFFSETS.POSSESSION_BLUE_POINTS]),
    orangeScore: Math.round(srcF32[EXTENDED_STATE_OFFSETS.POSSESSION_ORANGE_POINTS]),
    ball,
    cars,
    boostPadCooldowns,
  };
}
