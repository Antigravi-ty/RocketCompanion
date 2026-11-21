/**
 * scripts/testMatchExhibitionUnified.ts
 * Wave 1 (W1-03) verification for:
 *  1) ACTIVITY_IDS.EXHIBITION ('exp-multi-bots') in ReplicationBusProtocol, ActivityKernel, SyncAuthorityRouter
 *  2) 6-car RosterManifest & deterministic 32-bit metadataHash for Exhibition & Match
 *  3) Shared UnifiedGoalReplayStateMachine & cinematic camera pose output in both Match & Exhibition
 */

import assert from 'node:assert/strict';
import {
  ACTIVITY_IDS,
  ACTIVITY_DEFAULT_PACKET_FLAGS,
  REPLICATION_PACKET_FLAGS,
  REPLICATION_MODES,
  resolvePacketFlagsForActivity,
} from '../src/network/protocol/ReplicationBusProtocol.ts';
import { createDefaultActivityKernelRegistry } from '../src/network/server/activities/ActivityKernel.ts';
import { SyncAuthorityRouter, ENTITY_AUTHORITY_ROLES } from '../src/network/sync/SyncAuthorityRouter.ts';
import {
  buildExhibitionRosterManifest,
  buildMatchRosterManifest,
  type ExhibitionCarInput,
  type MatchPlayerSlotInput,
} from '../src/network/protocol/MatchExhibitionRosterManifest.ts';
import { UnifiedGoalReplayStateMachine } from '../src/replay/UnifiedGoalReplayStateMachine.ts';
import {
  ReplayRingBuffer,
  REPLAY_BUFFER_MODES,
} from '../src/replay/ReplayRingBuffer.ts';
import {
  SIM_OFFSETS,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
} from '../src/physics/RocketSimConstants.ts';
import { MatchGoalReplaySubController } from '../src/network/server/match/MatchGoalReplaySubController.ts';
import { MatchDomainState } from '../src/network/server/match/MatchDomainState.ts';
import { MatchCommandQueueSubController } from '../src/network/server/match/MatchCommandQueueSubController.ts';
import type { ReplayTimelineFrameEntry } from '../src/replay/replayDirectorStateTypes.ts';

function makeSixCarSnapshot(tick: number, ballY: number): Float32Array {
  const len = SIM_OFFSETS.CARS + 6 * CAR_STATE_STRIDE;
  const buf = new Float32Array(len);
  buf[0] = tick;
  buf[SIM_OFFSETS.NUM_CARS] = 6;
  buf[SIM_OFFSETS.BALL + 0] = 0;
  buf[SIM_OFFSETS.BALL + 1] = ballY;
  buf[SIM_OFFSETS.BALL + 2] = 120;
  buf[SIM_OFFSETS.BALL + 3] = 0;
  buf[SIM_OFFSETS.BALL + 4] = 1200;
  buf[SIM_OFFSETS.BALL + 5] = 0;

  for (let i = 0; i < 6; i++) {
    const base = SIM_OFFSETS.CARS + i * CAR_STATE_STRIDE;
    const team = i % 2;
    buf[base + CAR_STATE_OFFSETS.POS + 0] = (i - 2.5) * 400;
    buf[base + CAR_STATE_OFFSETS.POS + 1] = team === 0 ? ballY - 400 : ballY + 400;
    buf[base + CAR_STATE_OFFSETS.POS + 2] = 17;
    buf[base + CAR_STATE_OFFSETS.FWD + 0] = 0;
    buf[base + CAR_STATE_OFFSETS.FWD + 1] = team === 0 ? 1 : -1;
    buf[base + CAR_STATE_OFFSETS.FWD + 2] = 0;
    buf[base + CAR_STATE_OFFSETS.UP + 2] = 1;
    buf[base + CAR_STATE_OFFSETS.BOOST] = 33 + i * 5;
  }
  return buf;
}

function testProtocolAndActivityKernel(): void {
  assert.equal(ACTIVITY_IDS.EXHIBITION, 'exp-multi-bots');
  const flags = ACTIVITY_DEFAULT_PACKET_FLAGS[ACTIVITY_IDS.EXHIBITION];
  assert.ok(flags & REPLICATION_PACKET_FLAGS.STATE_SNAPSHOT);
  assert.ok(flags & REPLICATION_PACKET_FLAGS.CLOCK_AND_SCORE);
  assert.ok(flags & REPLICATION_PACKET_FLAGS.FOLLOW_HOST_CAMERA);

  const resolved = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.EXHIBITION,
    REPLICATION_MODES.CONTINUOUS,
    true
  );
  assert.ok(resolved & REPLICATION_PACKET_FLAGS.FOLLOW_HOST_CAMERA);

  const registry = createDefaultActivityKernelRegistry();
  const kernel = registry.get(ACTIVITY_IDS.EXHIBITION);
  assert.ok(kernel, 'ExhibitionActivityKernel must be registered');
  assert.equal(kernel.id, 'exp-multi-bots');

  const summary = kernel.getStateSummary({
    matchManager: {
      domain: { matchTick: 42 } as never,
      getSnapshot: () => ({
        state: 'PLAYING',
        blueScore: 2,
        orangeScore: 1,
        clockSecondsRemaining: 240,
      }),
    } as never,
  });
  assert.equal(summary.activityId, 'exp-multi-bots');
  assert.equal(summary.isExhibition, true);
  assert.equal(summary.blueScore, 2);

  const router = new SyncAuthorityRouter();
  router.applyActivitySwitch({ activityId: ACTIVITY_IDS.EXHIBITION, epoch: 3 });
  assert.equal(router.getEpoch(), 3);
  assert.equal(router.getEntityAuthority('ball')?.role, ENTITY_AUTHORITY_ROLES.HOST);
}

function testRosterManifestSixCars(): void {
  const visualIds = ['fennec', 'octane', 'dominus', 'merc', 'breakout', 'fennec'];
  const expCars: ExhibitionCarInput[] = visualIds.map((visualId, i) => ({
    carIndex: i,
    keyNumber: i + 1,
    team: i < 3 ? 0 : 1,
    teamSlotIndex: i % 3,
    isPlayer: i === 0,
    botType: i === 0 ? null : 'necto',
    visualId,
    hitboxId: visualId === 'merc' ? 'merc' : 'octane',
    colorSlot: i < 3 ? i + 1 : i + 7,
    colorHex: i < 3 ? `#00${i + 1}0ff` : `#ff${i + 1}000`,
    paintFinish: 'metallic',
    boostVisual: 'standard',
    boostAudio: 'standard',
    name: i === 0 ? 'Player' : `Bot_${i}`,
  }));

  const manifestA = buildExhibitionRosterManifest(expCars, { manifestVersion: 1 });
  assert.equal(manifestA.activityId, ACTIVITY_IDS.EXHIBITION);
  assert.equal(manifestA.mode, 'exp-multi-bots');
  assert.equal(manifestA.totalCars, 6);
  assert.equal(manifestA.entries.length, 6);
  assert.equal(manifestA.entries[0].roleFlag, 'player');
  assert.equal(manifestA.entries[3].roleFlag, 'bot');
  assert.equal(manifestA.entries[3].visualId, 'merc');

  const manifestSame = buildExhibitionRosterManifest(expCars, { manifestVersion: 2 });
  assert.equal(manifestSame.metadataHash, manifestA.metadataHash, 'metadataHash must be deterministic');

  const modifiedCars = expCars.map((c, idx) => (idx === 4 ? { ...c, visualId: 'octane' } : c));
  const manifestChanged = buildExhibitionRosterManifest(modifiedCars, { manifestVersion: 2 });
  assert.notEqual(
    manifestChanged.metadataHash,
    manifestA.metadataHash,
    'metadataHash must change when a car visualId changes'
  );

  const ghostCars = expCars.map((c, idx) =>
    idx === 5 ? { ...c, roleFlag: 'ghost' as const } : c
  );
  const manifestGhost = buildExhibitionRosterManifest(ghostCars);
  assert.equal(manifestGhost.entries[5].roleFlag, 'ghost');
  assert.notEqual(manifestGhost.metadataHash, manifestA.metadataHash);

  const matchSlots: MatchPlayerSlotInput[] = expCars.map((c) => ({
    entityId: c.carIndex,
    team: c.team,
    spawnSlot: c.teamSlotIndex,
    name: String(c.name),
    role: 'player',
    isBot: !c.isPlayer,
    botType: c.botType,
    visualId: String(c.visualId),
    hitboxId: String(c.hitboxId),
    colorSlot: Number(c.colorSlot),
    colorHex: String(c.colorHex),
    paintFinish: String(c.paintFinish),
    boostVisual: String(c.boostVisual),
    boostAudio: String(c.boostAudio),
  }));
  const matchManifest = buildMatchRosterManifest(matchSlots);
  assert.equal(matchManifest.activityId, ACTIVITY_IDS.MATCH);
  assert.equal(matchManifest.totalCars, 6);
  assert.equal(matchManifest.entries[0].keyNumber, 1);
  assert.equal(matchManifest.entries[5].keyNumber, 6);
}

function testUnifiedGoalReplayStateMachine(): void {
  const frames: ReplayTimelineFrameEntry[] = [];
  for (let i = 0; i < 30; i++) {
    frames.push({
      tick: 100 + i,
      snapshot: makeSixCarSnapshot(100 + i, 3800 + i * 48),
      signals: [],
      incidents: [],
      audioEvents: [],
    });
  }

  const sm = new UnifiedGoalReplayStateMachine();
  const initial = sm.begin({
    frames,
    scoringTeam: 0,
    scorerCarIndex: 0,
    scorerName: 'Player',
    ballSpeedKph: 112,
    cameraMode: 'director',
  });
  assert.ok(initial);
  assert.equal(initial.phase, 'active');
  assert.equal(initial.playbackState, 'playing');
  assert.equal(initial.cameraPose.mode, 'director');
  assert.ok(initial.cameraPose.eye.every((v) => Number.isFinite(v)));
  assert.ok(initial.cameraPose.target.every((v) => Number.isFinite(v)));

  const stepped = sm.step(1 / 60);
  assert.ok(stepped);
  assert.ok(stepped.frameIndex >= 1);
  assert.ok(stepped.progress > 0);
  assert.equal(stepped.cameraPose.mode, 'director');

  sm.setCameraMode('pov', 3);
  const povStep = sm.step(1 / 60);
  assert.ok(povStep);
  assert.equal(povStep.cameraPose.mode, 'pov');
  assert.equal(povStep.cameraPose.focusedCarIndex, 3);

  sm.setPaused(true);
  assert.equal(sm.getLatestOutput()?.playbackState, 'paused');
  sm.end();
  assert.equal(sm.phase, 'idle');

  const ring = new ReplayRingBuffer({ mode: REPLAY_BUFFER_MODES.COUNTDOWN_MATCH, capacityTicks: 120 });
  for (const f of frames) {
    ring.recordFrame(f.tick, f.snapshot!, { acknowledgedControls: [], signals: [] });
  }

  // Verify MatchGoalReplaySubController integration
  const domain = new MatchDomainState();
  domain.matchTick = 129;
  const cmdQueue = new MatchCommandQueueSubController({
    domain,
    sessionManager: null,
    physicsManager: null,
    dataHandler: null,
    replayBuffer: ring,
  } as never);

  const matchReplayCtrl = new MatchGoalReplaySubController({
    domain,
    commandQueue: cmdQueue,
    actions: {
      resetTrainingPlay: () => {},
      startKickoffSequence: () => {},
      endMatch: () => {},
    },
    replayBuffer: ring,
    physicsManager: {
      sim: { state: { ball: {} }, boostPads: [] },
      applySignal: () => {},
      getActiveCarMask: () => 0b111111,
      setDirectCarControls: () => {},
    },
  });
  matchReplayCtrl.recordGoalIncident(129, 0, 2, 120, 108);
  matchReplayCtrl.beginGoalReplay();
  const tickRes = matchReplayCtrl.stepReplayTick();
  assert.equal(tickRes.finished, false);
  const matchOut = matchReplayCtrl.getGoalReplayFrameOutput();
  assert.ok(matchOut);
  assert.equal(matchOut.phase, 'active');
  assert.equal(matchOut.scoringTeam, 0);
  assert.equal(matchOut.cameraPose.mode, 'director');
  assert.ok(matchOut.cameraPose.eye.every((v) => Number.isFinite(v)));
}

testProtocolAndActivityKernel();
testRosterManifestSixCars();
testUnifiedGoalReplayStateMachine();
console.log('[testMatchExhibitionUnified] PASS');
