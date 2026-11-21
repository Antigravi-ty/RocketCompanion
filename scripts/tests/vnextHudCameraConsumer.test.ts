import test from 'node:test';
import assert from 'node:assert/strict';
import { createHudTransientFrameBuffer } from '../../src/game/pipeline/stages/hudTransientFramePipeline.ts';
import { buildHudFrameFromRosterManifest } from '../../src/game/pipeline/stages/vnextHudRosterConsumer.ts';
import {
  VNextGoalReplayCameraConsumer,
  type BroadcasterCameraPort,
  type BroadcasterCameraOverridePort,
  type BroadcasterHudSyncPort,
} from '../../src/game/subsystems/vnextGoalReplayCameraConsumer.ts';
import type {
  VNextRosterManifest,
  VNextWorldFrameCameraAndHudHeader,
} from '../../src/game/pipeline/stages/vnextHudCameraTypes.ts';

function create3v3Manifest(isSpectatorSession = true): VNextRosterManifest {
  return {
    metadataHash: 0x1234abcd,
    matchMode: 'replay',
    isSpectatorSession,
    entries: [
      { carIndex: 0, name: 'BlueOne', team: 0, roleFlag: 'player', isBot: false },
      { carIndex: 1, name: 'BlueTwo', team: 0, roleFlag: 'bot', isBot: true },
      { carIndex: 2, name: 'BlueThree', team: 0, roleFlag: 'bot', isBot: true },
      { carIndex: 3, name: 'OrangeOne', team: 1, roleFlag: 'player', isBot: false },
      { carIndex: 4, name: 'OrangeTwo', team: 1, roleFlag: 'bot', isBot: true },
      { carIndex: 5, name: 'OrangeThree', team: 1, roleFlag: 'bot', isBot: true },
    ],
  };
}

function createBaseFrameHeader(
  overrides: Partial<VNextWorldFrameCameraAndHudHeader> = {}
): VNextWorldFrameCameraAndHudHeader {
  return {
    txSeq: 1,
    metadataHash: 0x1234abcd,
    phase: 'playing',
    playbackState: 'playing',
    clockSeconds: 250,
    isOvertime: false,
    blueScore: 1,
    orangeScore: 0,
    cameraFocus: {
      focusedCarIndex: 0,
      cameraMode: 'pov',
      ballCam: true,
      isGoalReplayActive: false,
    },
    cameraPose: null,
    ...overrides,
  };
}

test('HUD 1~6 keeps Blue on left (1..3) and Orange on right (4..6) regardless of cameraFocus', () => {
  const manifest = create3v3Manifest(true);
  const buffer = createHudTransientFrameBuffer();

  for (let carIdx = 0; carIdx < 6; carIdx++) {
    const frame = createBaseFrameHeader({
      txSeq: carIdx + 1,
      cameraFocus: {
        focusedCarIndex: carIdx,
        cameraMode: 'pov',
        ballCam: true,
        isGoalReplayActive: false,
      },
    });
    const payload = buildHudFrameFromRosterManifest(manifest, frame, null, null, buffer);

    assert.equal(payload.localTeam, 0, 'Spectator HUD must not flip teams');
    assert.equal(payload.rosterPatch.viewMode, 'spectator');
    assert.equal(payload.rosterPatch.focusedSlotKey, carIdx + 1);
    assert.equal(payload.rosterPatch.leftPlayers[0].name, 'BlueOne');
    assert.equal(payload.rosterPatch.leftPlayers[1].name, 'BlueTwo');
    assert.equal(payload.rosterPatch.leftPlayers[2].name, 'BlueThree');
    assert.equal(payload.rosterPatch.rightPlayers[0].name, 'OrangeOne');
    assert.equal(payload.rosterPatch.rightPlayers[1].name, 'OrangeTwo');
    assert.equal(payload.rosterPatch.rightPlayers[2].name, 'OrangeThree');

    const allSlots = [
      ...payload.rosterPatch.leftPlayers.slice(0, 3),
      ...payload.rosterPatch.rightPlayers.slice(0, 3),
    ];
    for (const s of allSlots) {
      assert.equal(
        s.isFocusedPov,
        s.carIndex === carIdx,
        `Slot ${s.slotKey} focus mismatch for carIndex=${carIdx}`
      );
    }
  }
});

test('HUD 1~6 clears focus in Goal Replay director mode and excludes ghost cars', () => {
  const manifest: VNextRosterManifest = {
    metadataHash: 0xfeedface,
    matchMode: 'match',
    isSpectatorSession: false,
    entries: [
      { carIndex: 0, name: 'HostPlayer', team: 0, roleFlag: 'player', isBot: false, isLocalPlayer: true },
      { carIndex: 1, name: 'BotOrange', team: 1, roleFlag: 'bot', isBot: true },
      { carIndex: 2, name: 'TrainingGhost', team: 0, roleFlag: 'ghost', isBot: false },
    ],
  };
  const buffer = createHudTransientFrameBuffer();
  const directorFrame = createBaseFrameHeader({
    phase: 'replay',
    cameraFocus: {
      focusedCarIndex: 0,
      cameraMode: 'director',
      ballCam: true,
      isGoalReplayActive: true,
      replayCameraMode: 'director',
    },
  });

  const payload = buildHudFrameFromRosterManifest(manifest, directorFrame, null, null, buffer);
  assert.equal(payload.rosterPatch.viewMode, 'goal-replay');
  assert.equal(payload.rosterPatch.focusedSlotKey, null);
  assert.equal(payload.rosterPatch.leftPlayers[0].exists, true);
  assert.equal(payload.rosterPatch.leftPlayers[0].isFocusedPov, false);
  assert.equal(payload.rosterPatch.leftPlayers[1].exists, false, 'Ghost car must be excluded from 1~6 HUD');
  assert.equal(payload.rosterPatch.rightPlayers[0].exists, true);
  assert.equal(payload.rosterPatch.rightPlayers[0].slotKey, 4);
});

test('Client Goal Replay camera consumer applies Broadcaster director pose and transitions back to POV', () => {
  const consumer = new VNextGoalReplayCameraConsumer();
  const directorPoses: Array<number[]> = [];
  const overrides: string[] = [];
  let released = false;
  let hudFocus: { mode: string; car: number } | null = null;
  let hudReplayMode: string | undefined;

  const camera: BroadcasterCameraPort = {
    isFreeCam: false,
    ballCam: true,
    focusedCarIndex: 0,
    directorController: { fov: 70 },
    setFreeCam: (enabled) => {
      camera.isFreeCam = enabled;
    },
    setFocusedCarIndex: (idx) => {
      camera.focusedCarIndex = idx;
    },
    setDirectorCameraPoseThreeJs: (ex, ey, ez, tx, ty, tz) => {
      directorPoses.push([ex, ey, ez, tx, ty, tz]);
    },
  };

  const overridePort: BroadcasterCameraOverridePort = {
    acquireGoalReplayCameraOverride: (source = 'default') => {
      overrides.push(source);
    },
    releaseGoalReplayCameraOverride: () => {
      released = true;
    },
  };

  const hudPort: BroadcasterHudSyncPort = {
    setCameraFocusState: (mode, car) => {
      hudFocus = { mode, car };
    },
    setReplayState: (s) => {
      hudReplayMode = s.replayCameraMode;
    },
  };

  const replayFrame = createBaseFrameHeader({
    txSeq: 10,
    phase: 'replay',
    cameraFocus: {
      focusedCarIndex: 2,
      cameraMode: 'director',
      ballCam: true,
      isGoalReplayActive: true,
      replayCameraMode: 'director',
    },
    cameraPose: {
      eyeThreeJs: [100, 450, -3200],
      targetThreeJs: [0, 110, 500],
      fovDeg: 82,
    },
  });

  const res1 = consumer.applyFrame(replayFrame, camera, overridePort, hudPort);
  assert.equal(res1.directorOverrideActive, true);
  assert.equal(res1.appliedPose, true);
  assert.deepEqual(overrides, ['vnext-broadcaster']);
  assert.equal(camera.directorController?.fov, 82);
  assert.deepEqual(directorPoses[0], [100, 450, -3200, 0, 110, 500]);
  assert.equal(hudReplayMode, 'director');

  const povFrame = createBaseFrameHeader({
    txSeq: 11,
    phase: 'playing',
    cameraFocus: {
      focusedCarIndex: 4,
      cameraMode: 'pov',
      ballCam: false,
      isGoalReplayActive: false,
    },
    cameraPose: null,
  });

  const res2 = consumer.applyFrame(povFrame, camera, overridePort, hudPort);
  assert.equal(res2.directorOverrideActive, false);
  assert.equal(released, true);
  assert.equal(camera.focusedCarIndex, 4);
  assert.equal(camera.ballCam, false);
  assert.deepEqual(hudFocus, { mode: 'pov', car: 4 });
});
