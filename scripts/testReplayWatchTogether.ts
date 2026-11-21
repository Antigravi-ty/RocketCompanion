/**
 * scripts/testReplayWatchTogether.ts
 * Standalone unit & integration test suite for W1-05 (feat/mode-replay-watch-together).
 */

import assert from 'node:assert/strict';
import {
  BALL_STATE_OFFSETS,
  BOOST_PAD_OFFSETS,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  GAME_STATE_BUFFER_FLOATS,
  SIM_OFFSETS,
} from '../src/physics/RocketSimConstants.ts';
import { ACTIVITY_IDS } from '../src/network/protocol/ReplicationBusProtocol.ts';
import { RoomActivityOrchestrator } from '../src/network/server/RoomActivityOrchestrator.ts';
import {
  buildReplayWatchRosterManifest,
  formatMetadataHashHex,
} from '../src/replay/watch-together/ReplayWatchRosterManifest.ts';
import { ReplayWatchCursorEngine } from '../src/replay/watch-together/ReplayWatchCursorEngine.ts';
import type { ReplayRosterEntry } from '../src/replay/ReplayViewerRosterResolver.ts';
import type { ReplayWatchSignalEvent } from '../src/replay/watch-together/ReplayWatchTogetherTypes.ts';

function makeSixCarRoster(): ReplayRosterEntry[] {
  const visuals = ['fennec', 'octane', 'merc', 'dominus', 'breakout', 'takumi'];
  const colors = ['#1e90ff', '#00bfff', '#4169e1', '#ff6600', '#ff4500', '#ffa500'];
  return visuals.map((visualId, i) => ({
    carIndex: i,
    team: i < 3 ? 0 : 1,
    name: `Player_${i + 1}`,
    botType: i === 0 ? null : 'ducky',
    isSelf: i === 0,
    visualId,
    hitboxId: visualId,
    colorSlot: i,
    colorHex: colors[i],
    paintFinish: i % 2 === 0 ? 'metallic' : 'matte',
    boostVisual: 'gold-rush',
    boostAudio: 'rush',
    anthemId: 'none',
    slotKey: i + 1,
  }));
}

function makeSnapshotForFrame(frameIndex: number): Float32Array {
  const buf = new Float32Array(GAME_STATE_BUFFER_FLOATS);
  buf[SIM_OFFSETS.TICK] = frameIndex;
  buf[SIM_OFFSETS.NUM_CARS] = 6;
  buf[SIM_OFFSETS.NUM_PADS] = 34;

  buf[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS] = frameIndex * 10;
  buf[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS + 1] = -frameIndex * 5;
  buf[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.POS + 2] = 93.15;
  buf[SIM_OFFSETS.BALL + BALL_STATE_OFFSETS.VEL] = 1200;

  for (let c = 0; c < 6; c++) {
    const base = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
    buf[base + CAR_STATE_OFFSETS.POS] = c * 100 + frameIndex;
    buf[base + CAR_STATE_OFFSETS.POS + 2] = 17;
    buf[base + CAR_STATE_OFFSETS.BOOST] = 33 + c * 10;
    buf[base + CAR_STATE_OFFSETS.ON_GROUND] = 1;
    buf[base + CAR_STATE_OFFSETS.SUPERSONIC] = c === 2 ? 1 : 0;
  }

  buf[BOOST_PAD_STATES_OFFSET + 0 * BOOST_PAD_STATE_STRIDE + BOOST_PAD_OFFSETS.IS_ACTIVE] = 1;
  buf[BOOST_PAD_STATES_OFFSET + 33 * BOOST_PAD_STATE_STRIDE + BOOST_PAD_OFFSETS.IS_ACTIVE] = 1;
  return buf;
}

function testRosterManifestAndMetadataHash(): void {
  const roster = makeSixCarRoster();
  const manifestA = buildReplayWatchRosterManifest({
    replayId: 'match-3v3-01.rcreplay',
    totalFrames: 600,
    tickRateHz: 120,
    resolvedRoster: roster,
    roleOverrides: { 5: 'ghost' },
    decalOverrides: { 0: 'stripes' },
  });

  assert.equal(manifestA.cars.length, 6);
  assert.equal(manifestA.cars[0].visualId, 'fennec');
  assert.equal(manifestA.cars[3].visualId, 'dominus');
  assert.equal(manifestA.cars[3].team, 1);
  assert.equal(manifestA.cars[5].roleFlag, 'ghost');
  assert.equal(manifestA.cars[0].decalId, 'stripes');
  assert.match(formatMetadataHashHex(manifestA.metadataHash), /^0x[0-9A-F]{8}$/);

  const modifiedRoster = makeSixCarRoster();
  modifiedRoster[3].visualId = 'fennec';
  const manifestB = buildReplayWatchRosterManifest({
    replayId: 'match-3v3-01.rcreplay',
    totalFrames: 600,
    tickRateHz: 120,
    resolvedRoster: modifiedRoster,
  });

  assert.notEqual(
    manifestA.metadataHash,
    manifestB.metadataHash,
    'Changing car 4 visualId must invalidate metadataHash'
  );
}

function testCursorForwardRewindSpeedPauseSeek(): void {
  const totalFrames = 240;
  const frames = Array.from({ length: totalFrames }, (_, i) => makeSnapshotForFrame(i));
  const signals: ReplayWatchSignalEvent[] = [
    { signalId: 101, signalType: 1, frameIndex: 10, param1: 0, param2: 0 },
    { signalId: 102, signalType: 2, frameIndex: 120, param1: 1, param2: 0 },
  ];

  const manifest = buildReplayWatchRosterManifest({
    replayId: 'test-watch.rcreplay',
    totalFrames,
    tickRateHz: 120,
    resolvedRoster: makeSixCarRoster(),
  });

  const engine = new ReplayWatchCursorEngine();
  engine.attachSource({
    getFrameAt: (idx) => frames[idx] ?? null,
    getSignalsInRange: (s, e) => signals.filter((sig) => sig.frameIndex >= s && sig.frameIndex <= e),
    evaluateScoreboardAtFrame: (idx) => ({
      matchPhase: idx >= 120 ? 'overtime' : 'playing',
      blueScore: idx >= 120 ? 1 : 0,
      orangeScore: 0,
      remainingSeconds: Math.max(0, 300 - Math.floor(idx / 120)),
      isOvertime: idx >= 120,
      overtimeSeconds: idx >= 120 ? Math.floor((idx - 120) / 120) : 0,
    }),
  });

  const loadPkt = engine.applyCommand({
    type: 'load_replay',
    manifest,
    initialFrame: 0,
    initialFocusedCarIndex: 0,
    autoPlay: false,
  });
  assert.ok(loadPkt);
  assert.equal(loadPkt.txSeq, 1);
  assert.equal(loadPkt.playbackState, 'paused');
  assert.equal(loadPkt.cars.length, 6);
  assert.equal(loadPkt.boostPadBitmaskLo, 1);
  assert.equal(loadPkt.boostPadBitmaskHi, 2);

  // Play forward at 1.0x for 100ms -> 12 frames @ 120Hz
  const playPkt = engine.applyCommand({ type: 'play', speed: 1.0 });
  assert.ok(playPkt);
  assert.equal(playPkt.playbackState, 'playing');
  const step1 = engine.step(100);
  assert.ok(step1);
  assert.equal(step1.replayFrame, 12);
  assert.equal(step1.playbackDirection, 1);
  assert.equal(step1.signals.length, 1);
  assert.equal(step1.signals[0].signalId, 101);
  assert.ok(step1.txSeq > playPkt.txSeq);

  // Switch focus across 1~6 cars: car 4 (index 3, orange team) must stay team 1
  const focusPkt = engine.applyCommand({ type: 'set_focus', focusedCarIndex: 3, cameraMode: 'car' });
  assert.ok(focusPkt);
  assert.equal(focusPkt.focusedCarIndex, 3);
  assert.equal(focusPkt.focusedTeam, 1);

  // Slow-mo 0.25x for 200ms -> 6 frames @ 120Hz -> frame 18
  engine.applyCommand({ type: 'set_speed', speed: 0.25 });
  const slowStep = engine.step(200);
  assert.ok(slowStep);
  assert.equal(slowStep.replayFrame, 18);

  // Rewind at 2.0x for 50ms -> -12 frames -> frame 6; txSeq must still strictly increase!
  const rewindCmdPkt = engine.applyCommand({ type: 'rewind', speed: 2.0 });
  assert.ok(rewindCmdPkt);
  const rewindStep = engine.step(50);
  assert.ok(rewindStep);
  assert.equal(rewindStep.replayFrame, 6);
  assert.equal(rewindStep.playbackDirection, -1);
  assert.equal(rewindStep.playbackState, 'rewinding');
  assert.ok(rewindStep.txSeq > rewindCmdPkt.txSeq);

  // Rewind past 0 auto-pauses at frame 0
  const rewindEnd = engine.step(500);
  assert.ok(rewindEnd);
  assert.equal(rewindEnd.replayFrame, 0);
  assert.equal(rewindEnd.playbackState, 'paused');

  // Seek to frame 120 -> scoreboard overtime + signal 102
  const seekPkt = engine.applyCommand({ type: 'seek', frameIndex: 120 });
  assert.ok(seekPkt);
  assert.equal(seekPkt.replayFrame, 120);
  assert.equal(seekPkt.scoreboard.isOvertime, true);
  assert.equal(seekPkt.scoreboard.blueScore, 1);
  assert.equal(seekPkt.signals.length, 1);
  assert.equal(seekPkt.signals[0].signalId, 102);

  // Pause & step -> frame stays 120, txSeq increments, playbackState remains paused
  const pausePkt = engine.applyCommand({ type: 'pause' });
  assert.ok(pausePkt);
  const pausedStep = engine.step(50);
  assert.ok(pausedStep);
  assert.equal(pausedStep.replayFrame, 120);
  assert.equal(pausedStep.playbackState, 'paused');
  assert.ok(pausedStep.txSeq > pausePkt.txSeq);

  // Play to end -> auto-pauses at totalFrames - 1
  engine.applyCommand({ type: 'play', speed: 2.0 });
  const endStep = engine.step(5000);
  assert.ok(endStep);
  assert.equal(endStep.replayFrame, totalFrames - 1);
  assert.equal(endStep.playbackState, 'paused');
}

function testOrchestratorKernelIntegration(): void {
  const orchestrator = new RoomActivityOrchestrator(ACTIVITY_IDS.REPLAY);
  const manifest = buildReplayWatchRosterManifest({
    replayId: 'kernel-test.rcreplay',
    totalFrames: 100,
    resolvedRoster: makeSixCarRoster(),
  });

  const ctx = { matchManager: null, physicsManager: null, epoch: 1 };
  const handledLoad = orchestrator.handleControlMessage(
    'replay_watch_command',
    {
      command: {
        type: 'load_replay',
        manifest,
        autoPlay: true,
        speed: 1.0,
      },
    },
    ctx
  );
  assert.equal(handledLoad, true);

  const handledStep = orchestrator.handleControlMessage('replay_watch_step', { dtMs: 50 }, ctx);
  assert.equal(handledStep, true);

  const csr = orchestrator.buildCsrBroadcast(ctx, true);
  const summary = csr.uiSummary as {
    activityId: string;
    replayWatch: { loaded: boolean; currentFrame: number; playbackState: string };
    lastFramePacket: { txSeq: number; replayFrame: number };
  };
  assert.equal(summary.activityId, ACTIVITY_IDS.REPLAY);
  assert.equal(summary.replayWatch.loaded, true);
  assert.equal(summary.replayWatch.currentFrame, 6);
  assert.equal(summary.lastFramePacket.replayFrame, 6);
  assert.ok(summary.lastFramePacket.txSeq >= 2);
}

testRosterManifestAndMetadataHash();
testCursorForwardRewindSpeedPauseSeek();
testOrchestratorKernelIntegration();
console.log('[W1-05] All Replay Watch Together unit & integration tests PASSED.');
