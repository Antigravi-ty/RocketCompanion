#!/usr/bin/env node
/**
 * scripts/testWorkerAuthorityBus.ts
 * Wave 1 (W1-01) unit tests:
 * 1. StateFrameSlidingWindow: 10-frame capacity, monotonic txSeq, per-session ack trimming,
 *    lossy retransmission, rewind/seek symmetry, and global min-ack pruning.
 * 2. EstablishedSessionManager txSeq ack tracking & monotonic guard (ignoring virtual bots).
 * 3. WorkerAuthorityBus: 4-mode stepping (match/freeplay/exhibition/replay),
 *    real setTimeout timer streaming independent of rAF (immune to 1Hz background throttling),
 *    and replay forward/rewind/pause/seek cursor behavior.
 * 4. Worker router integration (WORKER_BUS_CONFIGURE, WORKER_BUS_REPLAY_CONTROL, WORKER_BUS_TX_SEQ_ACK).
 */

import assert from 'node:assert/strict';
import {
  StateFrameSlidingWindow,
  type SessionTrimmedBatch,
  type WorkerChannel1StateFrame,
} from '../src/network/server/StateFrameSlidingWindow.ts';
import { VNEXT_CHANNEL1_SCHEMA_HASH } from '../src/network/protocol/VNextSchemaHash.ts';
import { EstablishedSessionManager } from '../src/network/server/EstablishedSessionManager.ts';
import { WorkerAuthorityBus } from '../src/network/server/WorkerAuthorityBus.ts';
import { HOST_WORKER_MSG_TYPES as MSG } from '../src/network/protocol/HostWorkerProtocol.ts';
import { routeActivityAndInputMessage } from '../src/network/server/workerActivityAndInputRouter.ts';

function makeDummyBytes(tag: number): Uint8Array {
  return new Uint8Array([0x57, 0x31, tag & 0xff, (tag >> 8) & 0xff]);
}

function testSlidingWindowCapacityAndTrimming(): void {
  const win = new StateFrameSlidingWindow(10);
  assert.equal(win.maxWindowSize, 10);
  assert.equal(win.size, 0);

  for (let i = 1; i <= 15; i++) {
    const f = win.pushFrame({
      schemaHash: VNEXT_CHANNEL1_SCHEMA_HASH,
      metadataHash: 0x12345678,
      activityMode: 'match',
      playbackState: 'playing',
      phase: 'active',
      clockSeconds: 300 - i,
      simTick: i * 2,
      replayFrameIndex: 0,
      focusedCarIndex: 0,
      timestampMs: i * 16,
      payloadBytes: makeDummyBytes(i),
    });
    assert.equal(f.txSeq, i);
  }

  assert.equal(win.size, 10);
  assert.equal(win.getLatestTxSeq(), 15);
  const all = win.getWindowFrames();
  assert.equal(all[0].txSeq, 6);
  assert.equal(all[9].txSeq, 15);

  // Healthy client acked 14 -> gets only 1-frame delta [15]
  const healthy = win.getUnackedFramesForSession(14);
  assert.deepEqual(
    healthy.map((f) => f.txSeq),
    [15]
  );

  // Lossy client acked 11 -> gets [12, 13, 14, 15]
  const lossy = win.getUnackedFramesForSession(11);
  assert.deepEqual(
    lossy.map((f) => f.txSeq),
    [12, 13, 14, 15]
  );

  // Fully caught up client acked 15 -> gets []
  assert.equal(win.getUnackedFramesForSession(15).length, 0);

  // Global prune up to minAckedTxSeq = 13
  const pruned = win.pruneAckedByAllSessions(13, false);
  assert.equal(pruned, 8); // frames 6..13 removed
  assert.deepEqual(
    win.getWindowFrames().map((f) => f.txSeq),
    [14, 15]
  );

  // Rewind & seek symmetry: replayFrameIndex goes backward & jumps, txSeq still strictly increases
  const rewindIndices = [500, 499, 498, 120];
  for (const rIdx of rewindIndices) {
    win.pushFrame({
      schemaHash: VNEXT_CHANNEL1_SCHEMA_HASH,
      metadataHash: 0x12345678,
      activityMode: 'replay',
      playbackState: rIdx === 120 ? 'seeking' : 'rewinding',
      phase: 'replay',
      clockSeconds: 100,
      simTick: rIdx * 2,
      replayFrameIndex: rIdx,
      focusedCarIndex: 2,
      timestampMs: 1000,
      payloadBytes: makeDummyBytes(rIdx),
    });
  }

  assert.equal(win.getLatestTxSeq(), 19);
  const afterRewind = win.getUnackedFramesForSession(17);
  assert.deepEqual(
    afterRewind.map((f) => ({ txSeq: f.txSeq, replayFrameIndex: f.replayFrameIndex })),
    [
      { txSeq: 18, replayFrameIndex: 498 },
      { txSeq: 19, replayFrameIndex: 120 },
    ]
  );
  console.log('[PASS] testSlidingWindowCapacityAndTrimming');
}

function testMultiSessionAckTrimming(): void {
  let fakeNow = 1000;
  const sessionManager = new EstablishedSessionManager(null, () => fakeNow);
  sessionManager.registerSession('peer_good', { entityId: 0, role: 'player' });
  sessionManager.registerSession('peer_lossy', { entityId: 1, role: 'player' });
  sessionManager.registerSession('bot_1', { entityId: 2, role: 'player' });

  const dispatched: SessionTrimmedBatch[] = [];
  const bus = new WorkerAuthorityBus({
    sessionManager,
    activityMode: 'exhibition',
    broadcastHz: 60,
    nowMs: () => fakeNow,
    modeStepper: (_dt, mode) => ({
      payloadBytes: makeDummyBytes(1),
      phase: mode,
      simTick: Math.floor(fakeNow / 8),
    }),
    onDispatchSessionBatch: (batch) => dispatched.push(batch),
  });

  // Initialize start timestamp, then step 10 frames at 60Hz (17ms steps)
  bus.stepAtTimestamp(fakeNow);
  for (let i = 1; i <= 10; i++) {
    fakeNow += 17;
    bus.stepAtTimestamp(fakeNow);
    if (i === 6) {
      bus.recordSessionTxSeqAck('peer_lossy', 6);
    }
    if (i === 9) {
      bus.recordSessionTxSeqAck('peer_good', 9);
      // Out-of-order stale ack must NOT regress lastAckedTxSeq
      bus.recordSessionTxSeqAck('peer_good', 4);
      assert.equal(sessionManager.getSessionLastAckedTxSeq('peer_good'), 9);
    }
  }

  assert.equal(bus.slidingWindow.getLatestTxSeq(), 10);
  assert.equal(sessionManager.getMinHumanAckedTxSeq(), 6);

  // Inspect batches from the 10th frame dispatch (last 2 entries: peer_good & peer_lossy; bot_1 skipped)
  const lastTwo = dispatched.slice(-2);
  assert.equal(lastTwo.length, 2);
  const goodBatch = lastTwo.find((b) => b.sessionId === 'peer_good')!;
  const lossyBatch = lastTwo.find((b) => b.sessionId === 'peer_lossy')!;
  assert.ok(goodBatch && lossyBatch);
  assert.deepEqual(
    goodBatch.frames.map((f) => f.txSeq),
    [10]
  );
  assert.deepEqual(
    lossyBatch.frames.map((f) => f.txSeq),
    [7, 8, 9, 10]
  );

  bus.destroy();
  sessionManager.destroy();
  console.log('[PASS] testMultiSessionAckTrimming');
}

function testReplayModesAndFourActivityStepping(): void {
  let fakeNow = 0;
  const published: WorkerChannel1StateFrame[] = [];
  const bus = new WorkerAuthorityBus({
    activityMode: 'freeplay',
    broadcastHz: 30,
    nowMs: () => fakeNow,
    modeStepper: (_dt, mode, cursor) => ({
      payloadBytes: makeDummyBytes(cursor.currentFrameIndex),
      phase: mode,
      replayFrameIndex: cursor.currentFrameIndex,
    }),
    onFramePublished: (f) => published.push(f),
  });

  // Freeplay at 30Hz: 100ms -> 3 frames
  bus.stepAtTimestamp(0);
  fakeNow = 100;
  const fpCount = bus.stepAtTimestamp(fakeNow);
  assert.equal(fpCount, 3);
  assert.equal(published[published.length - 1].activityMode, 'freeplay');

  // Switch to replay: 600 frames, forward 2x at 60Hz
  bus.setActivityMode('replay');
  bus.setBroadcastHz(60);
  bus.configureReplayCursor({
    totalFrames: 600,
    replayFps: 60,
    playbackSpeed: 2,
    playbackState: 'playing',
    currentFrameIndex: 100,
  });

  fakeNow += 500; // 0.5s * 60fps * 2x = +60 frames -> clamped physics dt is 0.25s max per step
  // Step in two 250ms chunks
  bus.stepAtTimestamp(fakeNow - 250);
  bus.stepAtTimestamp(fakeNow);
  const afterFwd = bus.getReplayCursor().currentFrameIndex;
  assert.ok(afterFwd > 130 && afterFwd <= 165, `Expected forward cursor > 130, got ${afterFwd}`);

  // Rewind at -2x
  const seqBeforeRewind = bus.slidingWindow.getLatestTxSeq();
  bus.configureReplayCursor({ playbackState: 'rewinding', playbackSpeed: 2 });
  fakeNow += 250;
  bus.stepAtTimestamp(fakeNow);
  const afterRewind = bus.getReplayCursor().currentFrameIndex;
  assert.ok(afterRewind < afterFwd, `Expected rewind cursor < ${afterFwd}, got ${afterRewind}`);
  assert.ok(bus.slidingWindow.getLatestTxSeq() > seqBeforeRewind, 'txSeq must increase on rewind');

  // Pause: cursor stays fixed
  bus.configureReplayCursor({ playbackState: 'paused' });
  const pausedIdx = bus.getReplayCursor().currentFrameIndex;
  fakeNow += 200;
  bus.stepAtTimestamp(fakeNow);
  assert.equal(bus.getReplayCursor().currentFrameIndex, pausedIdx);

  // Seek: jumps immediately and publishes a frame with higher txSeq
  const seqBeforeSeek = bus.slidingWindow.getLatestTxSeq();
  bus.configureReplayCursor({ seekFrameIndex: 42 });
  assert.equal(bus.getReplayCursor().currentFrameIndex, 42);
  assert.equal(bus.slidingWindow.getLatestTxSeq(), seqBeforeSeek + 1);

  bus.destroy();
  console.log('[PASS] testReplayModesAndFourActivityStepping');
}

async function testWorkerTimerStreamingWithoutRaf(): Promise<void> {
  // Verify real setTimeout Worker loop streams at ~60Hz even with no rAF
  const sessionManager = new EstablishedSessionManager(null);
  sessionManager.registerSession('client_1', { entityId: 0, role: 'player' });

  const receivedTxSeqs: number[] = [];
  const bus = new WorkerAuthorityBus({
    sessionManager,
    activityMode: 'freeplay',
    broadcastHz: 60,
    modeStepper: () => ({ payloadBytes: makeDummyBytes(7), phase: 'freeplay' }),
    onDispatchSessionBatch: (batch) => {
      for (const f of batch.frames) {
        receivedTxSeqs.push(f.txSeq);
      }
      if (batch.frames.length > 0) {
        bus.recordSessionTxSeqAck(batch.sessionId, batch.latestTxSeq);
      }
    },
  });

  bus.start(2);
  await new Promise((resolve) => setTimeout(resolve, 140));
  bus.stop();

  assert.ok(
    receivedTxSeqs.length >= 5,
    `Expected >= 5 timer-driven frames in 140ms at 60Hz, got ${receivedTxSeqs.length}`
  );
  // Strictly monotonic txSeq with 1-frame delta per tick because client acked each batch
  for (let i = 1; i < receivedTxSeqs.length; i++) {
    assert.equal(receivedTxSeqs[i], receivedTxSeqs[i - 1] + 1);
  }

  bus.destroy();
  sessionManager.destroy();
  console.log('[PASS] testWorkerTimerStreamingWithoutRaf');
}

function testWorkerRouterIntegration(): void {
  const sessionManager = new EstablishedSessionManager(null);
  sessionManager.registerSession('peer_a', { entityId: 0, role: 'player' });
  const bus = new WorkerAuthorityBus({ sessionManager, activityMode: 'match', broadcastHz: 60 });

  const replies: Array<{ type: string; payload: unknown }> = [];
  const ctx = {
    sessionManager,
    authorityBus: bus,
  };
  const reply = (type: string, payload: unknown) => replies.push({ type, payload });
  const syncRoom = () => {};

  assert.equal(
    routeActivityAndInputMessage(
      ctx,
      MSG.WORKER_BUS_CONFIGURE,
      { activityMode: 'exhibition', broadcastHz: 30, metadataHash: 0xabcdef01 },
      reply,
      syncRoom
    ),
    true
  );
  assert.equal(bus.getActivityMode(), 'exhibition');
  assert.equal(bus.getBroadcastHz(), 30);

  assert.equal(
    routeActivityAndInputMessage(
      ctx,
      MSG.WORKER_BUS_REPLAY_CONTROL,
      { totalFrames: 300, playbackState: 'rewinding', playbackSpeed: 1.5, seekFrameIndex: 150 },
      reply,
      syncRoom
    ),
    true
  );
  assert.equal(bus.getReplayCursor().currentFrameIndex, 150);

  assert.equal(
    routeActivityAndInputMessage(
      ctx,
      MSG.WORKER_BUS_TX_SEQ_ACK,
      { channelId: 'peer_a', ackedTxSeq: 12 },
      reply,
      syncRoom
    ),
    true
  );
  assert.equal(sessionManager.getSessionLastAckedTxSeq('peer_a'), 12);

  bus.destroy();
  sessionManager.destroy();
  console.log('[PASS] testWorkerRouterIntegration');
}

async function main(): Promise<void> {
  testSlidingWindowCapacityAndTrimming();
  testMultiSessionAckTrimming();
  testReplayModesAndFourActivityStepping();
  await testWorkerTimerStreamingWithoutRaf();
  testWorkerRouterIntegration();
  console.log('ALL W1-01 WORKER AUTHORITY BUS TESTS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
