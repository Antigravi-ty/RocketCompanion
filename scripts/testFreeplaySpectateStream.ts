/**
 * scripts/testFreeplaySpectateStream.ts
 * Wave 1 (W1-04) unit & integration tests for FreeplaySpectateStreamController
 * and FreeplayActivityKernel.
 *
 * Run with: node --experimental-strip-types scripts/testFreeplaySpectateStream.ts
 */

import assert from 'node:assert/strict';
import {
  BOOST_PAD_STATES_OFFSET,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  SIM_OFFSETS,
} from '../src/physics/RocketSimConstants.ts';
import { ACTIVITY_IDS } from '../src/network/protocol/ReplicationBusProtocol.ts';
import { createDefaultActivityKernelRegistry } from '../src/network/server/activities/ActivityKernel.ts';
import { FreeplaySpectateStreamController } from '../src/network/server/activities/FreeplaySpectateStreamController.ts';
import { FREEPLAY_W104_TEMP_SCHEMA_HASH } from '../src/network/server/activities/freeplaySpectateTypes.ts';

function makeSnapshot(tick: number, ballPosY = 0, carPosX = 0): Float32Array {
  const snap = new Float32Array(448);
  snap[SIM_OFFSETS.TICK] = tick;
  snap[SIM_OFFSETS.NUM_CARS] = 1;
  snap[SIM_OFFSETS.NUM_PADS] = 34;

  // Ball
  snap[SIM_OFFSETS.BALL] = 100;
  snap[SIM_OFFSETS.BALL + 1] = ballPosY;
  snap[SIM_OFFSETS.BALL + 2] = 93;
  snap[SIM_OFFSETS.BALL + 12] = 500;

  // Car 0
  const c0 = SIM_OFFSETS.CARS;
  snap[c0 + CAR_STATE_OFFSETS.POS] = carPosX;
  snap[c0 + CAR_STATE_OFFSETS.POS + 1] = -1000;
  snap[c0 + CAR_STATE_OFFSETS.POS + 2] = 17;
  snap[c0 + CAR_STATE_OFFSETS.FWD] = 1;
  snap[c0 + CAR_STATE_OFFSETS.RIGHT + 1] = 1;
  snap[c0 + CAR_STATE_OFFSETS.UP + 2] = 1;
  snap[c0 + CAR_STATE_OFFSETS.BOOST] = 100;
  snap[c0 + CAR_STATE_OFFSETS.ON_GROUND] = 1;

  // Boost pad 0 & 3 active
  snap[BOOST_PAD_STATES_OFFSET] = 1;
  snap[BOOST_PAD_STATES_OFFSET + 3 * 2] = 1;
  return snap;
}

function testLiveFreeplayStream(): void {
  const ctrl = new FreeplaySpectateStreamController({ unlimitedBoost: true });
  const b1 = ctrl.stepAndProduceFrame(makeSnapshot(100, 250, 50));
  assert.equal(b1.stateFrame.txSeq, 1);
  assert.equal(b1.stateFrame.schemaHash, FREEPLAY_W104_TEMP_SCHEMA_HASH);
  assert.equal(b1.stateFrame.subMode, 'live');
  assert.equal(b1.stateFrame.playbackState, 'playing');
  assert.equal(b1.stateFrame.playbackRate, 1.0);
  assert.equal(b1.stateFrame.phase, 'playing');
  assert.equal(b1.stateFrame.unlimitedBoost, true);
  assert.equal(b1.stateFrame.boostPadMask & 0b1001, 0b1001);
  assert.equal(b1.stateFrame.ball.posY, 250);
  assert.equal(b1.stateFrame.cars.length, 1);
  assert.equal(b1.stateFrame.cars[0].posX, 50);
  assert.equal(b1.manifestChanged, true);

  const b2 = ctrl.stepAndProduceFrame(makeSnapshot(101, 260, 60));
  assert.equal(b2.stateFrame.txSeq, 2);
  assert.equal(b2.manifestChanged, false);

  ctrl.setUnlimitedBoost(false);
  const b3 = ctrl.stepAndProduceFrame(makeSnapshot(102, 270, 70));
  assert.equal(b3.stateFrame.txSeq, 3);
  assert.equal(b3.manifestChanged, true);
  assert.equal(b3.manifest.unlimitedBoost, false);
}

function testGoalReplayAndSkip(): void {
  const ctrl = new FreeplaySpectateStreamController({ goalReplaySlowMoRate: 0.5 });
  for (let t = 1; t <= 30; t++) {
    ctrl.stepAndProduceFrame(makeSnapshot(t, t * 10, t * 2));
  }
  ctrl.recordTouchIncident(25, 0);
  ctrl.triggerGoalScored({
    tick: 30,
    scoringTeam: 0,
    scorerCarIndex: 0,
    scorerName: 'Tester',
    ballSpeedKph: 112.5,
    celebrationTicks: 2,
  });

  const c1 = ctrl.stepAndProduceFrame(makeSnapshot(31, 5200, 0));
  assert.equal(c1.stateFrame.phase, 'goal');
  assert.ok(c1.signals.some((s) => s.kind === 'goal_scored'));

  // Celebration finishes -> enters goal_replay
  const r1 = ctrl.stepAndProduceFrame(makeSnapshot(32, 5200, 0));
  assert.equal(r1.stateFrame.subMode, 'goal_replay');
  assert.equal(r1.stateFrame.phase, 'replay');
  assert.equal(r1.stateFrame.playbackState, 'playing');
  assert.equal(r1.stateFrame.playbackRate, 0.5);
  assert.ok(r1.stateFrame.cameraPose !== null);
  assert.equal(r1.stateFrame.goalReplayMeta?.scorerName, 'Tester');
  assert.ok(r1.stateFrame.replayTotalFrames > 0);
  assert.ok(r1.signals.some((s) => s.kind === 'goal_replay_start'));

  // Skip replay -> returns to live
  const skipped = ctrl.skipGoalReplay(33);
  assert.equal(skipped, true);
  const liveAfter = ctrl.stepAndProduceFrame(makeSnapshot(34, 0, 0));
  assert.equal(liveAfter.stateFrame.subMode, 'live');
  assert.equal(liveAfter.stateFrame.phase, 'playing');
  assert.equal(liveAfter.stateFrame.goalReplayMeta, null);
}

function testManualBallExpire(): void {
  const ctrl = new FreeplaySpectateStreamController();
  for (let t = 1; t <= 10; t++) {
    ctrl.stepAndProduceFrame(makeSnapshot(t, t * 5, 0));
  }
  const ok = ctrl.triggerManualBallExpire({
    tick: 10,
    scoringTeam: 1,
    scorerCarIndex: 0,
    celebrationTicks: 1,
  });
  assert.equal(ok, true);
  const f1 = ctrl.stepAndProduceFrame(makeSnapshot(11, 50, 0));
  assert.equal(f1.stateFrame.subMode, 'goal_replay');
  assert.equal(f1.stateFrame.goalReplayMeta?.replayType, 'expire');
}

function testRewindMonotonicTxSeqAndPreroll(): void {
  const ctrl = new FreeplaySpectateStreamController();
  assert.equal(ctrl.handleRewinderCommand('start_recording'), true);
  for (let t = 10; t < 30; t++) {
    ctrl.stepAndProduceFrame(makeSnapshot(t, t * 3, t));
  }
  assert.equal(ctrl.handleRewinderCommand('stop_recording'), true);

  // Channel 4 slice manifest
  const manifest = ctrl.buildRewinderSliceManifest(4096);
  assert.ok(manifest !== null);
  assert.equal(manifest.totalFrames, 20);
  assert.equal(manifest.startTick, 10);
  assert.equal(manifest.endTick, 29);
  assert.ok(manifest.fileHash.startsWith('0x'));

  // Begin rewinding: sourceTick & cursorFrame decrease, txSeq MUST increase!
  assert.equal(
    ctrl.handleRewinderCommand('begin_scrub', { direction: 'rewinding', scrubRate: 2 }),
    true
  );
  const rw1 = ctrl.stepAndProduceFrame();
  const rw2 = ctrl.stepAndProduceFrame();
  assert.equal(rw1.stateFrame.subMode, 'rewind');
  assert.equal(rw1.stateFrame.playbackState, 'rewinding');
  assert.equal(rw1.stateFrame.playbackRate, -2);
  assert.ok(
    rw2.stateFrame.txSeq > rw1.stateFrame.txSeq,
    'txSeq must strictly increase during rewind'
  );
  assert.ok(
    rw2.stateFrame.sourceTick < rw1.stateFrame.sourceTick,
    'sourceTick must decrease during rewind'
  );

  // Pause scrub -> playbackState === 'paused' (triggers client silenceAll)
  assert.equal(ctrl.handleRewinderCommand('pause_scrub'), true);
  const p1 = ctrl.stepAndProduceFrame();
  assert.equal(p1.stateFrame.playbackState, 'paused');
  assert.equal(p1.stateFrame.playbackRate, 0);
  assert.ok(p1.stateFrame.txSeq > rw2.stateFrame.txSeq);

  // Preroll countdown -> live
  assert.equal(ctrl.handleRewinderCommand('resume_from_here'), true);
  let lastBundle = ctrl.stepAndProduceFrame();
  assert.equal(lastBundle.stateFrame.phase, 'countdown');
  assert.equal(lastBundle.stateFrame.playbackState, 'paused');
  for (let i = 0; i < 365; i++) {
    lastBundle = ctrl.stepAndProduceFrame();
  }
  assert.equal(lastBundle.stateFrame.subMode, 'live');
  assert.equal(lastBundle.stateFrame.phase, 'playing');
  assert.equal(lastBundle.stateFrame.playbackState, 'playing');
}

function testFreeplayActivityKernel(): void {
  const registry = createDefaultActivityKernelRegistry();
  const kernel = registry.get(ACTIVITY_IDS.FREEPLAY);
  assert.ok(kernel, 'FreeplayActivityKernel must exist');

  let trainingStarted = false;
  const ctx = {
    matchManager: {
      domain: { trainingUnlimitedBoost: true, matchTick: 42 },
      lifecycle: {
        startTrainingMode: (opts?: { unlimitedBoost?: boolean }) => {
          trainingStarted = true;
          if (typeof opts?.unlimitedBoost === 'boolean') {
            ctx.matchManager.domain.trainingUnlimitedBoost = opts.unlimitedBoost;
          }
        },
      },
    } as never,
    physicsManager: null,
    epoch: 1,
    stateSummary: { unlimitedBoost: false },
  };

  kernel.onMount(ctx);
  assert.equal(trainingStarted, true);
  const handled = kernel.onControlMessage?.(ctx, 'freeplay_set_unlimited_boost', {
    unlimitedBoost: true,
  });
  assert.equal(handled, true);
  const summary = kernel.getStateSummary(ctx);
  assert.equal(summary.activityId, 'freeplay');
  assert.equal(summary.unlimitedBoost, true);
  assert.equal(summary.subMode, 'live');
}

testLiveFreeplayStream();
testGoalReplayAndSkip();
testManualBallExpire();
testRewindMonotonicTxSeqAndPreroll();
testFreeplayActivityKernel();

console.log('[testFreeplaySpectateStream] All 5 test suites passed.');
