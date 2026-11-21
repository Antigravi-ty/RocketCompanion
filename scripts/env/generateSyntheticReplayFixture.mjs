#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const DEFAULT_SYNTHETIC_REPLAY_PATH = '/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay';
const STATE_BUFFER_FLOATS = 448;
const NUM_CARS = 6;
const NUM_PADS = 34;

export function generateSynthetic3v3ReplayFixture(
  outPath = DEFAULT_SYNTHETIC_REPLAY_PATH,
  frameCount = 360
) {
  const roster = [
    { carIndex: 0, name: 'BlueAlpha', team: 0, isPlayer: true },
    { carIndex: 1, name: 'BlueBravo', team: 0, isPlayer: false },
    { carIndex: 2, name: 'BlueCharlie', team: 0, isPlayer: false },
    { carIndex: 3, name: 'OrangeDelta', team: 1, isPlayer: false },
    { carIndex: 4, name: 'OrangeEcho', team: 1, isPlayer: false },
    { carIndex: 5, name: 'OrangeFoxtrot', team: 1, isPlayer: false },
  ];

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const snap = new Array(STATE_BUFFER_FLOATS).fill(0);
    snap[0] = 100 + i; // TICK
    snap[1] = 0; // GOAL
    snap[2] = NUM_CARS;
    snap[3] = NUM_PADS;

    // Ball: oscillating gently near midfield
    const t = i / 120;
    snap[4] = Math.sin(t * 2.0) * 600;
    snap[5] = Math.cos(t * 1.5) * 400;
    snap[6] = 93.15 + Math.abs(Math.sin(t * 3.0)) * 80;
    // Ball rotation identity
    snap[7] = 1;
    snap[11] = 1;
    snap[15] = 1;
    // Ball velocity
    snap[16] = Math.cos(t * 2.0) * 1200;
    snap[17] = -Math.sin(t * 1.5) * 600;
    snap[18] = 0;

    // 6 cars (3 Blue, 3 Orange)
    for (let c = 0; c < NUM_CARS; c++) {
      const base = 22 + c * 40;
      const isBlue = c < 3;
      const lane = (c % 3) - 1;
      const dir = isBlue ? 1 : -1;
      snap[base + 0] = (isBlue ? -1200 : 1200) + dir * Math.sin(t * 1.8 + c) * 350;
      snap[base + 1] = lane * 700 + Math.cos(t * 1.2 + c) * 120;
      snap[base + 2] = 17.05;
      // FWD, RIGHT, UP
      snap[base + 3] = dir;
      snap[base + 7] = dir;
      snap[base + 11] = 1;
      // VEL
      snap[base + 12] = dir * 600;
      snap[base + 13] = 0;
      snap[base + 14] = 0;
      // BOOST & ON_GROUND
      snap[base + 18] = 33 + ((i + c * 11) % 67);
      snap[base + 19] = 1;
    }

    // 34 boost pads active
    for (let p = 0; p < NUM_PADS; p++) {
      const padBase = 342 + p * 2;
      snap[padBase] = 1;
      snap[padBase + 1] = 0;
    }

    frames.push(snap);
  }

  const payload = {
    magic: 'RCREPLAY',
    version: 2,
    mode: 'exhibition',
    arenaPreset: 0,
    winner: 'blue',
    blueScore: 1,
    orangeScore: 0,
    durationSeconds: 300,
    roster,
    loadouts: roster,
    createdAtIso: new Date().toISOString(),
    frames,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  fs.writeFileSync(outPath, gz);
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || DEFAULT_SYNTHETIC_REPLAY_PATH;
  const out = generateSynthetic3v3ReplayFixture(target);
  console.log(`[SyntheticReplayFixture] Generated 3v3 .rcreplay fixture at: ${out}`);
}
