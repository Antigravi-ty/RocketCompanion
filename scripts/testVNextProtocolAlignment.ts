/**
 * scripts/testVNextProtocolAlignment.ts
 * Wave 2 (`feat/protocol-schema-alignment`) verification suite.
 */

import assert from 'node:assert/strict';
import {
  ACTIVITY_IDS,
  ACTIVITY_DEFAULT_PACKET_FLAGS,
} from '../src/network/protocol/ReplicationBusProtocol.ts';
import {
  VNEXT_CHANNEL1_SCHEMA_HASH,
  VNEXT_CHANNEL2_SCHEMA_HASH,
  formatSchemaHashHex,
} from '../src/network/protocol/VNextSchemaHash.ts';
import { VNextWorldFrameCodec } from '../src/network/protocol/VNextWorldFrameCodec.ts';
import {
  VNextRosterManifestCodec,
  computeRosterMetadataHash,
  type VNextRosterManifestInput,
} from '../src/network/protocol/VNextRosterManifestCodec.ts';

function testExhibitionActivityId(): void {
  assert.equal(ACTIVITY_IDS.EXHIBITION, 'exp-multi-bots');
  assert.ok((ACTIVITY_DEFAULT_PACKET_FLAGS[ACTIVITY_IDS.EXHIBITION] ?? 0) > 0);
}

function testSchemaHashes(): void {
  assert.notEqual(VNEXT_CHANNEL1_SCHEMA_HASH, 0);
  assert.notEqual(VNEXT_CHANNEL2_SCHEMA_HASH, 0);
  assert.notEqual(VNEXT_CHANNEL1_SCHEMA_HASH, VNEXT_CHANNEL2_SCHEMA_HASH);
  assert.match(formatSchemaHashHex(VNEXT_CHANNEL1_SCHEMA_HASH), /^0x[0-9A-F]{8}$/);
  assert.match(formatSchemaHashHex(VNEXT_CHANNEL2_SCHEMA_HASH), /^0x[0-9A-F]{8}$/);
}

function testWorldFrameRoundTripAndSchemaGuard(): void {
  const encoded = VNextWorldFrameCodec.encode({
    txSeq: 42,
    metadataHash: 0xdeadbeef,
    activityMode: 'replay',
    playbackState: 'rewinding',
    phase: 'replay',
    simTick: 1200,
    replayFrameIndex: 850,
    replayTotalFrames: 3600,
    clockSeconds: 123.5,
    playbackSpeed: -2,
    blueScore: 3,
    orangeScore: 2,
    focusedCarIndex: 4,
    cameraMode: 'director',
    timestampMs: 1700000000123,
    isOvertime: false,
    ballCam: true,
    isGoalReplayActive: true,
    discontinuity: false,
    isShotLaunched: true,
    fpvAuthority: {
      authorityEpoch: 7,
      activeInputPeerSlot: 1,
      authorityMode: 'fpv_master_slave',
    },
    trainingHeader: {
      shotIndex: 2,
      shotResetSeq: 9,
      countdownSeconds: 0.5,
      remainingTimeoutSeconds: 8.25,
    },
    cameraPose: {
      eye: [100, 200, 300],
      target: [0, 0, 93],
      fovDeg: 110,
    },
    globalPayload: {
      signals: [{ signalId: 11, signalType: 1, frameId: 850, param1: 4, param2: 0 }],
      allUserRtt: { players: [12, 18, null, 24, null, null], spectators: [{ id: 1, rtt: 30 }] },
    },
  });

  const decoded = VNextWorldFrameCodec.decode(encoded);
  assert.equal(decoded.schemaHash, VNEXT_CHANNEL1_SCHEMA_HASH);
  assert.equal(decoded.txSeq, 42);
  assert.equal(decoded.metadataHash, 0xdeadbeef);
  assert.equal(decoded.activityMode, 'replay');
  assert.equal(decoded.playbackState, 'rewinding');
  assert.equal(decoded.playbackSpeed, -2);
  assert.equal(decoded.focusedCarIndex, 4);
  assert.equal(decoded.cameraMode, 'director');
  assert.equal(decoded.ballCam, true);
  assert.equal(decoded.isGoalReplayActive, true);
  assert.equal(decoded.fpvAuthority?.authorityEpoch, 7);
  assert.equal(decoded.fpvAuthority?.authorityMode, 'fpv_master_slave');
  assert.equal(decoded.trainingHeader?.shotIndex, 2);
  assert.equal(decoded.cameraPose?.fovDeg, 110);
  assert.equal(decoded.globalPayload?.signals.length, 1);
  assert.equal(decoded.globalPayload?.allUserRtt?.players[0], 12);

  const corrupted = new Uint8Array(encoded);
  corrupted[0] ^= 0x01;
  assert.throws(() => VNextWorldFrameCodec.decode(corrupted), /schemaHash mismatch/);
}

function testRosterManifestRoundTripAndHashChange(): void {
  const manifestInput: VNextRosterManifestInput = {
    manifestVersion: 1,
    activityId: ACTIVITY_IDS.EXHIBITION,
    arenaPreset: 'dfh_stadium',
    matchDurationSeconds: 300,
    replayTotalFrames: 0,
    telestratorAllowed: true,
    entries: [
      {
        carIndex: 0,
        slotKey: 1,
        team: 0,
        teamSlotIndex: 0,
        name: 'Coach',
        roleFlag: 'player',
        isBot: false,
        botType: null,
        visualId: 'fennec',
        hitboxId: 'octane',
        colorSlot: 1,
        colorHex: '#2563EB',
        paintFinish: 'matte',
        decalId: 'none',
        boostVisual: 'standard_blue',
        boostAudio: 'standard',
        anthemId: null,
        ghostOpacity: 1,
      },
      {
        carIndex: 5,
        slotKey: 6,
        team: 1,
        teamSlotIndex: 2,
        name: 'GhostSpar',
        roleFlag: 'ghost',
        isBot: true,
        botType: 'rlbot',
        visualId: 'merc',
        hitboxId: 'merc',
        colorSlot: 4,
        colorHex: '#EA580C',
        paintFinish: 'anodized',
        decalId: 'stripes',
        boostVisual: 'standard_orange',
        boostAudio: 'standard',
        anthemId: 'anthem_01',
        ghostOpacity: 0.45,
      },
    ],
    trainingMeta: {
      packId: 'pack-1',
      packName: 'Aerial Redirects',
      shotIndex: 1,
      totalShots: 5,
      shotName: 'Corner Read',
      shotResetSeq: 3,
      boostPolicy: 'unlimited',
      ghostModeEnabled: true,
    },
  };

  const encoded = VNextRosterManifestCodec.encode(manifestInput);
  const decoded = VNextRosterManifestCodec.decode(encoded);
  assert.equal(decoded.activityId, 'exp-multi-bots');
  assert.equal(decoded.entries.length, 2);
  assert.equal(decoded.entries[0].visualId, 'fennec');
  assert.equal(decoded.entries[1].roleFlag, 'ghost');
  assert.ok(Math.abs(decoded.entries[1].ghostOpacity - 0.45) < 0.001);
  assert.equal(decoded.trainingMeta?.packId, 'pack-1');

  const mutatedInput: VNextRosterManifestInput = {
    ...manifestInput,
    entries: [{ ...manifestInput.entries[0], visualId: 'octane' }, manifestInput.entries[1]],
  };
  assert.notEqual(
    computeRosterMetadataHash(manifestInput),
    computeRosterMetadataHash(mutatedInput)
  );

  const corrupted = new Uint8Array(encoded);
  corrupted[1] ^= 0xff;
  assert.throws(() => VNextRosterManifestCodec.decode(corrupted), /schemaHash mismatch/);
}

testExhibitionActivityId();
testSchemaHashes();
testWorldFrameRoundTripAndSchemaGuard();
testRosterManifestRoundTripAndHashChange();
console.log(
  `[testVNextProtocolAlignment] PASS (Ch1=${formatSchemaHashHex(VNEXT_CHANNEL1_SCHEMA_HASH)}, Ch2=${formatSchemaHashHex(VNEXT_CHANNEL2_SCHEMA_HASH)})`
);
