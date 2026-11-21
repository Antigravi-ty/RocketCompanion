/**
 * scripts/testTimelineFrameBuffer.ts
 * Standalone unit tests for vNext W1-02 TimelineFrameBuffer & TimelineFrameMath.
 * Covers:
 * - Basis <-> Quaternion round-trip & SLERP
 * - 60Hz+ pass-through (zero added latency)
 * - 30Hz & 15Hz arrival-timeline dual-frame interpolation
 * - Forward, slow-motion, pause (no extrapolation/jitter), and rewind (non-monotonic ticks)
 * - txSeq out-of-order/duplicate rejection
 * - Discontinuity & per-entity teleport snapping
 * - Dynamic 60Hz <-> 30Hz cadence switching
 */

import assert from 'node:assert/strict';
import {
  BALL_STATE_OFFSETS,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  GAME_STATE_BUFFER_FLOATS,
  SIM_OFFSETS,
} from '../src/physics/RocketSimConstants.ts';
import { quatToBasisVectors } from '../src/replay/rlrc/synthesis/RLRCQuaternionTrajectoryInterpolator.ts';
import { TimelineFrameBuffer } from '../src/network/sync/TimelineFrameBuffer.ts';
import { basisToQuat } from '../src/network/sync/TimelineFrameMath.ts';

function makeSnapshot(opts: {
  tick: number;
  ballX: number;
  ballY?: number;
  ballZ?: number;
  car0X?: number;
  car0YawRad?: number;
  car0Boost?: number;
  car1X?: number;
  numCars?: number;
}): Float32Array {
  const snap = new Float32Array(GAME_STATE_BUFFER_FLOATS);
  const numCars = opts.numCars ?? 1;
  snap[SIM_OFFSETS.TICK] = opts.tick;
  snap[SIM_OFFSETS.NUM_CARS] = numCars;
  snap[SIM_OFFSETS.NUM_PADS] = 34;

  // Ball position & identity basis
  snap[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS] = opts.ballX;
  snap[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS + 1] = opts.ballY ?? 0;
  snap[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS + 2] = opts.ballZ ?? 93.15;
  snap[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.FWD] = 1;
  snap[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.RIGHT + 1] = 1;
  snap[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.UP + 2] = 1;

  // Car 0
  if (numCars >= 1) {
    const base = SIM_OFFSETS.CARS;
    const yaw = opts.car0YawRad ?? 0;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    snap[base + CAR_STATE_OFFSETS.POS] = opts.car0X ?? 0;
    snap[base + CAR_STATE_OFFSETS.POS + 2] = 17;
    // Rotate around Z by yaw
    snap[base + CAR_STATE_OFFSETS.FWD] = c;
    snap[base + CAR_STATE_OFFSETS.FWD + 1] = s;
    snap[base + CAR_STATE_OFFSETS.RIGHT] = -s;
    snap[base + CAR_STATE_OFFSETS.RIGHT + 1] = c;
    snap[base + CAR_STATE_OFFSETS.UP + 2] = 1;
    snap[base + CAR_STATE_OFFSETS.BOOST] = opts.car0Boost ?? 33;
  }

  // Car 1
  if (numCars >= 2) {
    const base1 = SIM_OFFSETS.CARS + CAR_STATE_STRIDE;
    snap[base1 + CAR_STATE_OFFSETS.POS] = opts.car1X ?? 500;
    snap[base1 + CAR_STATE_OFFSETS.POS + 2] = 17;
    snap[base1 + CAR_STATE_OFFSETS.FWD] = 1;
    snap[base1 + CAR_STATE_OFFSETS.RIGHT + 1] = 1;
    snap[base1 + CAR_STATE_OFFSETS.UP + 2] = 1;
  }

  return snap;
}

function assertClose(actual: number, expected: number, eps: number, msg: string): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg}: expected ${expected} +/- ${eps}, got ${actual}`
  );
}

function testBasisToQuatRoundTrip(): void {
  const angles = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI - 0.01];
  for (const yaw of angles) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const fwd = { x: c, y: s, z: 0 };
    const right = { x: -s, y: c, z: 0 };
    const up = { x: 0, y: 0, z: 1 };
    const q = basisToQuat(fwd, right, up);
    const back = quatToBasisVectors(q);
    assertClose(back.fwd.x, fwd.x, 1e-5, `fwd.x yaw=${yaw}`);
    assertClose(back.fwd.y, fwd.y, 1e-5, `fwd.y yaw=${yaw}`);
    assertClose(back.right.x, right.x, 1e-5, `right.x yaw=${yaw}`);
    assertClose(back.right.y, right.y, 1e-5, `right.y yaw=${yaw}`);
    assertClose(back.up.z, up.z, 1e-5, `up.z yaw=${yaw}`);
  }
}

function test60HzPassthrough(): void {
  const buf = new TimelineFrameBuffer();
  assert.equal(buf.sample(1000), null, 'Empty buffer must return null');

  buf.pushFrame(makeSnapshot({ tick: 10, ballX: 100 }), { txSeq: 1, arrivalMs: 1000 });
  const s1 = buf.sample(1000);
  assert.ok(s1);
  assert.equal(s1.mode, 'hold');
  assert.equal(s1.snapshot[SIM_OFFSETS.BALL], 100);

  // 60Hz arrivals (~16.67ms)
  buf.pushFrame(makeSnapshot({ tick: 12, ballX: 140 }), { txSeq: 2, arrivalMs: 1016.67 });
  buf.pushFrame(makeSnapshot({ tick: 14, ballX: 180 }), { txSeq: 3, arrivalMs: 1033.33 });

  const s3 = buf.sample(1033.33);
  assert.ok(s3);
  assert.equal(s3.mode, 'passthrough');
  assert.equal(s3.alpha, 1);
  assert.equal(s3.serverTick, 14);
  assert.equal(s3.snapshot[SIM_OFFSETS.BALL], 180);
  assert.equal(s3.interpolationDelayMs, 0);
}

function test30HzForwardAndSlerp(): void {
  const buf = new TimelineFrameBuffer({ jitterMarginMs: 8 });
  // Push 30Hz frames (dt = 33.33ms) -> delay = clamp(33.33 + 8, 25, 120) = 41.33ms
  buf.pushFrame(makeSnapshot({ tick: 100, ballX: 0, car0X: 0, car0YawRad: 0, car0Boost: 20 }), {
    txSeq: 1,
    arrivalMs: 1000,
  });
  buf.pushFrame(
    makeSnapshot({
      tick: 104,
      ballX: 100,
      car0X: 200,
      car0YawRad: Math.PI / 2,
      car0Boost: 80,
    }),
    { txSeq: 2, arrivalMs: 1033.33 }
  );
  buf.pushFrame(
    makeSnapshot({
      tick: 108,
      ballX: 200,
      car0X: 400,
      car0YawRad: Math.PI,
      car0Boost: 100,
    }),
    { txSeq: 3, arrivalMs: 1066.67 }
  );

  // Midpoint between frame 1 (1000) and frame 2 (1033.33) is renderTimeMs = 1016.665
  // With delay ~41.333ms, nowMs = 1016.665 + 41.333 = 1058.0
  const s = buf.sample(1058);
  assert.ok(s);
  assert.equal(s.mode, 'interpolated');
  assertClose(s.alpha, 0.5, 0.02, '30Hz midpoint alpha');
  assertClose(s.snapshot[SIM_OFFSETS.BALL], 50, 2.0, '30Hz midpoint ballX');
  assertClose(
    s.snapshot[SIM_OFFSETS.CARS + CAR_STATE_OFFSETS.POS],
    100,
    4.0,
    '30Hz midpoint car0X'
  );
  assertClose(
    s.snapshot[SIM_OFFSETS.CARS + CAR_STATE_OFFSETS.BOOST],
    50,
    2.0,
    '30Hz midpoint boost'
  );

  // Car0 yaw halfway between 0 and PI/2 should be PI/4 (fwd.x = cos(PI/4), fwd.y = sin(PI/4))
  const expectedCos = Math.cos(Math.PI / 4);
  assertClose(
    s.snapshot[SIM_OFFSETS.CARS + CAR_STATE_OFFSETS.FWD],
    expectedCos,
    0.03,
    '30Hz SLERP fwd.x'
  );
  assertClose(
    s.snapshot[SIM_OFFSETS.CARS + CAR_STATE_OFFSETS.FWD + 1],
    expectedCos,
    0.03,
    '30Hz SLERP fwd.y'
  );
}

function test15HzLowRateInterpolation(): void {
  const buf = new TimelineFrameBuffer({ jitterMarginMs: 8 });
  // 15Hz arrivals (dt = 66.67ms) -> delay = 74.67ms
  buf.pushFrame(makeSnapshot({ tick: 10, ballX: 0 }), { txSeq: 1, arrivalMs: 1000 });
  buf.pushFrame(makeSnapshot({ tick: 18, ballX: 300 }), { txSeq: 2, arrivalMs: 1066.67 });
  buf.pushFrame(makeSnapshot({ tick: 26, ballX: 600 }), { txSeq: 3, arrivalMs: 1133.33 });

  // Target midpoint between frame 1 and 2: renderTime = 1033.335 => nowMs = 1033.335 + 74.67 = 1108
  const s = buf.sample(1108);
  assert.ok(s);
  assert.equal(s.mode, 'interpolated');
  assertClose(s.alpha, 0.5, 0.02, '15Hz midpoint alpha');
  assertClose(s.snapshot[SIM_OFFSETS.BALL], 150, 5.0, '15Hz midpoint ballX');
}

function testRewindNonMonotonicTicks(): void {
  const buf = new TimelineFrameBuffer({ jitterMarginMs: 8 });
  // Rewind at 30Hz: ticks decrease 200 -> 196 -> 192, ballX goes 400 -> 300 -> 200
  buf.pushFrame(makeSnapshot({ tick: 200, ballX: 400 }), {
    txSeq: 10,
    playbackState: 'rewinding',
    arrivalMs: 2000,
  });
  buf.pushFrame(makeSnapshot({ tick: 196, ballX: 300 }), {
    txSeq: 11,
    playbackState: 'rewinding',
    arrivalMs: 2033.33,
  });
  buf.pushFrame(makeSnapshot({ tick: 192, ballX: 200 }), {
    txSeq: 12,
    playbackState: 'rewinding',
    arrivalMs: 2066.67,
  });

  // Sample midpoint between frame 10 (400) and frame 11 (300)
  const s1 = buf.sample(2058);
  assert.ok(s1);
  assert.equal(s1.mode, 'interpolated');
  assert.equal(s1.playbackState, 'rewinding');
  assertClose(s1.snapshot[SIM_OFFSETS.BALL], 350, 2.0, 'Rewind ballX midpoint 1');

  // Sample midpoint between frame 11 (300) and frame 12 (200)
  const s2 = buf.sample(2091.33);
  assert.ok(s2);
  assert.equal(s2.mode, 'interpolated');
  assertClose(s2.snapshot[SIM_OFFSETS.BALL], 250, 2.0, 'Rewind ballX midpoint 2');
  assert.equal(buf.getStats().bufferedFrames, 3, 'Rewind must not clear buffer');
}

function testSlowMoAndPauseZeroExtrapolation(): void {
  const buf = new TimelineFrameBuffer({ jitterMarginMs: 8 });
  // 0.25x slow-mo at 30Hz
  buf.pushFrame(makeSnapshot({ tick: 50, ballX: 100 }), {
    txSeq: 1,
    playbackState: 'playing',
    arrivalMs: 3000,
  });
  buf.pushFrame(makeSnapshot({ tick: 51, ballX: 110 }), {
    txSeq: 2,
    playbackState: 'playing',
    arrivalMs: 3033.33,
  });
  buf.pushFrame(makeSnapshot({ tick: 51, ballX: 110 }), {
    txSeq: 3,
    playbackState: 'paused',
    arrivalMs: 3066.67,
  });

  // Way after latest arrival (pause hold): must hold at 110 with zero extrapolation
  const sHold1 = buf.sample(3500);
  const sHold2 = buf.sample(4500);
  assert.ok(sHold1 && sHold2);
  assert.equal(sHold1.mode, 'hold');
  assert.equal(sHold2.mode, 'hold');
  assert.equal(sHold1.playbackState, 'paused');
  assert.equal(sHold1.snapshot[SIM_OFFSETS.BALL], 110);
  assert.equal(sHold2.snapshot[SIM_OFFSETS.BALL], 110);
}

function testTxSeqOutOfOrderAndDiscontinuity(): void {
  const buf = new TimelineFrameBuffer({ mode: 'interpolate', minInterpolationDelayMs: 30 });
  assert.equal(
    buf.pushFrame(makeSnapshot({ tick: 10, ballX: 10 }), { txSeq: 5, arrivalMs: 1000 }),
    true
  );
  assert.equal(
    buf.pushFrame(makeSnapshot({ tick: 11, ballX: 20 }), { txSeq: 6, arrivalMs: 1033 }),
    true
  );
  // Duplicate & older txSeq must be rejected
  assert.equal(
    buf.pushFrame(makeSnapshot({ tick: 11, ballX: 999 }), { txSeq: 6, arrivalMs: 1040 }),
    false
  );
  assert.equal(
    buf.pushFrame(makeSnapshot({ tick: 9, ballX: 999 }), { txSeq: 4, arrivalMs: 1045 }),
    false
  );
  assert.equal(buf.getStats().droppedOutOfOrder, 2);

  // Discontinuity (e.g. kickoff reset) must snap instead of blending
  buf.pushFrame(makeSnapshot({ tick: 12, ballX: 0 }), {
    txSeq: 7,
    discontinuity: true,
    arrivalMs: 1066,
  });
  const sDisc = buf.sample(1080); // renderTime = 1080 - 30 = 1050 (between 1033 and 1066)
  assert.ok(sDisc);
  assert.equal(sDisc.mode, 'hold');
  assert.equal(sDisc.snapshot[SIM_OFFSETS.BALL], 0, 'Discontinuity must snap to post-reset frame');
}

function testPerEntityTeleportSnap(): void {
  const buf = new TimelineFrameBuffer({
    mode: 'interpolate',
    minInterpolationDelayMs: 30,
    jitterMarginMs: 0,
    maxTeleportDistanceUu: 450,
  });
  // Car 0 teleports > 450 uu (demo respawn), Car 1 moves normally by 100 uu
  buf.pushFrame(makeSnapshot({ tick: 10, ballX: 0, car0X: -2000, car1X: 500, numCars: 2 }), {
    txSeq: 1,
    arrivalMs: 1000,
  });
  buf.pushFrame(makeSnapshot({ tick: 12, ballX: 100, car0X: 2000, car1X: 600, numCars: 2 }), {
    txSeq: 2,
    arrivalMs: 1033,
  });

  // renderTime = 1049.5 - 33 = 1016.5 (alpha = 0.5)
  const s = buf.sample(1049.5);
  assert.ok(s);
  assert.equal(s.mode, 'interpolated');
  assertClose(s.snapshot[SIM_OFFSETS.BALL], 50, 1.0, 'Ball still interpolates');
  assert.equal(s.snapshot[SIM_OFFSETS.CARS + CAR_STATE_OFFSETS.POS], 2000, 'Teleported car0 snaps');
  assertClose(
    s.snapshot[SIM_OFFSETS.CARS + CAR_STATE_STRIDE + CAR_STATE_OFFSETS.POS],
    550,
    1.0,
    'Non-teleported car1 still interpolates'
  );
  assert.equal(buf.getStats().teleportSnaps, 1);
}

function testDynamicRateSwitch(): void {
  const buf = new TimelineFrameBuffer();
  let t = 1000;
  // Start at 60Hz
  for (let i = 1; i <= 5; i++) {
    buf.pushFrame(makeSnapshot({ tick: i, ballX: i * 10 }), { txSeq: i, arrivalMs: t });
    t += 16.67;
  }
  assert.equal(buf.sample(t)?.mode, 'passthrough', 'Should be passthrough at 60Hz');

  // Switch to 30Hz for several frames
  for (let i = 6; i <= 15; i++) {
    buf.pushFrame(makeSnapshot({ tick: i, ballX: i * 10 }), { txSeq: i, arrivalMs: t });
    t += 33.33;
  }
  const s30 = buf.sample(t - 15);
  assert.equal(s30?.mode, 'interpolated', 'Should engage interpolation after switching to 30Hz');

  // Switch back to 60Hz
  for (let i = 16; i <= 30; i++) {
    buf.pushFrame(makeSnapshot({ tick: i, ballX: i * 10 }), { txSeq: i, arrivalMs: t });
    t += 16.67;
  }
  assert.equal(buf.sample(t)?.mode, 'passthrough', 'Should return to passthrough at 60Hz');
}

function main(): void {
  testBasisToQuatRoundTrip();
  test60HzPassthrough();
  test30HzForwardAndSlerp();
  test15HzLowRateInterpolation();
  testRewindNonMonotonicTicks();
  testSlowMoAndPauseZeroExtrapolation();
  testTxSeqOutOfOrderAndDiscontinuity();
  testPerEntityTeleportSnap();
  testDynamicRateSwitch();
  console.log('[testTimelineFrameBuffer] ALL 9 UNIT TESTS PASSED');
}

main();
