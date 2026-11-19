#!/usr/bin/env node
/**
 * scripts/env/generateReplayFixture.ts
 *
 * Generates a deterministic 3v3 V2 binary `.rcreplay` fixture using the repository's own
 * RCReplayBinaryEncoder so E2E suites (repro:dev-broadcast-v2/v3, repro:dev-extra-routes)
 * can run out-of-the-box without requiring an external proprietary replay file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  SIM_OFFSETS,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  BALL_STATE_OFFSETS,
  PHYSICS_TICK_RATE,
} from '../../src/physics/RocketSimConstants.ts';
import {
  RC_REPLAY_STATE_BYTES,
  RC_REPLAY_STATE_INPUT_STRIDE,
} from '../../src/replay/container/RCReplayBinarySchema.ts';
import { serializeRCReplayBinaryContainer } from '../../src/replay/container/RCReplayBinaryEncoder.ts';

export const DEFAULT_REPLAY_FIXTURE_PATH = '/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay';

export function generate3v3ReplayFixture(outPath = DEFAULT_REPLAY_FIXTURE_PATH): string {
  const frameCount = 360; // 3 seconds at 120Hz
  const stateInputBytes = new Uint8Array(frameCount * RC_REPLAY_STATE_INPUT_STRIDE);

  const roster = [
    { carIndex: 0, name: 'AlphaStriker', team: 0, carBody: 'octane' },
    { carIndex: 1, name: 'BluePlaymaker', team: 0, carBody: 'fennec' },
    { carIndex: 2, name: 'BlueAnchor', team: 0, carBody: 'dominus' },
    { carIndex: 3, name: 'OrangeViper', team: 1, carBody: 'octane' },
    { carIndex: 4, name: 'OrangeShadow', team: 1, carBody: 'fennec' },
    { carIndex: 5, name: 'OrangeKeeper', team: 1, carBody: 'breakout' },
  ];

  for (let f = 0; f < frameCount; f++) {
    const byteOffset = f * RC_REPLAY_STATE_INPUT_STRIDE;
    const f32 = new Float32Array(
      stateInputBytes.buffer,
      byteOffset,
      RC_REPLAY_STATE_BYTES / Float32Array.BYTES_PER_ELEMENT
    );
    const t = f / PHYSICS_TICK_RATE;

    f32[SIM_OFFSETS.TICK] = 1200 + f;
    f32[SIM_OFFSETS.GOAL] = 0;
    f32[SIM_OFFSETS.NUM_CARS] = 6;
    f32[SIM_OFFSETS.NUM_PADS] = 34;

    // Ball moving smoothly in center arena
    const ballOff = SIM_OFFSETS.BALL;
    f32[ballOff + BALL_STATE_OFFSETS.POS + 0] = Math.sin(t * 1.8) * 600;
    f32[ballOff + BALL_STATE_OFFSETS.POS + 1] = Math.cos(t * 1.4) * 900;
    f32[ballOff + BALL_STATE_OFFSETS.POS + 2] = 93.15 + Math.abs(Math.sin(t * 2.5)) * 180;
    // Identity rotation matrix for ball
    f32[ballOff + BALL_STATE_OFFSETS.FWD + 0] = 1;
    f32[ballOff + BALL_STATE_OFFSETS.RIGHT + 1] = 1;
    f32[ballOff + BALL_STATE_OFFSETS.UP + 2] = 1;
    f32[ballOff + BALL_STATE_OFFSETS.VEL + 0] = Math.cos(t * 1.8) * 600 * 1.8;
    f32[ballOff + BALL_STATE_OFFSETS.VEL + 1] = -Math.sin(t * 1.4) * 900 * 1.4;

    for (let c = 0; c < 6; c++) {
      const carBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      const teamSign = c < 3 ? -1 : 1;
      const laneOffset = ((c % 3) - 1) * 750;
      const phase = t * 1.5 + c * 0.7;

      f32[carBase + CAR_STATE_OFFSETS.POS + 0] = laneOffset + Math.sin(phase) * 180;
      f32[carBase + CAR_STATE_OFFSETS.POS + 1] = teamSign * (1400 - Math.cos(phase) * 500);
      f32[carBase + CAR_STATE_OFFSETS.POS + 2] = 17.01;

      // Identity orientation facing Y
      f32[carBase + CAR_STATE_OFFSETS.FWD + 1] = c < 3 ? 1 : -1;
      f32[carBase + CAR_STATE_OFFSETS.RIGHT + 0] = c < 3 ? 1 : -1;
      f32[carBase + CAR_STATE_OFFSETS.UP + 2] = 1;

      f32[carBase + CAR_STATE_OFFSETS.VEL + 0] = Math.cos(phase) * 270;
      f32[carBase + CAR_STATE_OFFSETS.VEL + 1] = teamSign * Math.sin(phase) * 750;
      f32[carBase + CAR_STATE_OFFSETS.BOOST] = 35 + ((c * 11) % 60);
      f32[carBase + CAR_STATE_OFFSETS.ON_GROUND] = 1;
      f32[carBase + CAR_STATE_OFFSETS.GROUND_NORMAL + 2] = 1;
    }
  }

  const rawContainer = serializeRCReplayBinaryContainer({
    mode: 'match',
    arenaPreset: 0,
    tickRate: PHYSICS_TICK_RATE,
    durationSeconds: 300,
    winner: 'blue',
    blueScore: 1,
    orangeScore: 0,
    roster,
    stateInputBytes,
  });

  const gzBytes = gzipSync(rawContainer);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, gzBytes);
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || DEFAULT_REPLAY_FIXTURE_PATH;
  const out = generate3v3ReplayFixture(target);
  console.log(`[ReplayFixture] Generated 3v3 .rcreplay fixture at ${out} (${fs.statSync(out).size} bytes)`);
}
