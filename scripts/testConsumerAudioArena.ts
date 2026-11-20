import assert from 'node:assert/strict';
import { GameAudioSubsystem } from '../src/game/subsystems/GameAudioSubsystem.ts';
import { AudioStage, FrameContext, type FramePipelineRuntimePort } from '../src/game/pipeline/FramePipeline.ts';
import {
  applyRosterManifestToArena,
  type RosterCarRoleFlag,
  type RosterManifest,
  type RosterManifestArenaTarget,
} from '../src/entities/arena/arenaRosterManifestPipeline.ts';

function test(name: string, fn: () => void): void {
  fn();
  console.log(`[PASS] ${name}`);
}

test('GameAudioSubsystem immediately silences all synths and gameAudio when playbackState !== playing', () => {
  let silenceAllCalls = 0;
  let updateBallAudioCalls = 0;
  let updateVehiclesCalls = 0;

  const mockGameAudio = {
    silenceAll: () => {
      silenceAllCalls++;
    },
    updateBallAudio: () => {
      updateBallAudioCalls++;
    },
    updateVehicles: () => {
      updateVehiclesCalls++;
    },
    ballEngine: {
      silenceAll: () => {
        silenceAllCalls++;
      },
    },
    play: () => {},
  };

  let synthSilenceCalls = 0;
  let synthDormant = false;
  let spatialBusEnabled = true;

  const mockRuntime = {
    playerCarIndex: 0,
    options: { gameAudio: mockGameAudio },
    camera: { camera: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } },
    arena: { ball: { position: { x: 0, y: 0, z: 0 } }, cars: [{ visible: true, userData: {} }] },
    match: { state: { mode: 'replay', phase: 'playing', remainingSeconds: 300, overtime: false } },
    interpolator: { numCars: 1, getCurrCarStateView: () => null },
    playerControls: { boost: false },
    openOverlays: new Set<string>(),
    pollInputs: () => false,
    audioSubsystem: null,
    renderSubsystem: null,
    modeManager: null,
    profiler: null,
    keyboard: null,
    container: null,
    lastTimestamp: 0,
  } as unknown as FramePipelineRuntimePort & { options: { gameAudio: typeof mockGameAudio } };

  const subsystem = new GameAudioSubsystem(mockRuntime);
  subsystem.engineSynths = [
    {
      synth: {
        active: true,
        dormant: false,
        setDormant: (d: boolean) => {
          synthDormant = d;
        },
        silence: () => {
          synthSilenceCalls++;
        },
        reset: () => {},
        update: () => {},
      } as never,
      spatialBus: {
        setEnabled: (enabled: boolean) => {
          spatialBusEnabled = enabled;
        },
        setPosition: () => {},
      } as never,
      spatial: false,
      position: { x: 0, y: 0, z: 0 },
      wasDemoed: false,
      prevForwardSpeed: 0,
      dormant: false,
      distanceUU: 0,
    },
  ];

  const ctx = new FrameContext(mockRuntime);
  ctx.isMatchActive = true;
  ctx.numCarsInArena = 1;
  ctx.playbackState = 'paused';

  subsystem.update(ctx);

  assert.equal(silenceAllCalls, 1, 'gameAudio.silenceAll should be called once');
  assert.equal(synthSilenceCalls, 1, 'engine synth.silence should be called once');
  assert.equal(synthDormant, true, 'engine synth should be marked dormant');
  assert.equal(spatialBusEnabled, false, 'spatialBus should be disabled');
  assert.equal(updateBallAudioCalls, 0, 'updateBallAudio must not run while paused');
  assert.equal(updateVehiclesCalls, 0, 'updateVehicles must not run while paused');
  assert.equal(subsystem.lastPlaybackState, 'paused');

  // Verify ended state also silences immediately
  ctx.playbackState = 'ended';
  subsystem.update(ctx);
  assert.equal(silenceAllCalls, 2);
  assert.equal(synthSilenceCalls, 2);
  assert.equal(subsystem.lastPlaybackState, 'ended');

  // Verify transition back to playing resumes normal updates
  ctx.playbackState = 'playing';
  subsystem.update(ctx);
  assert.equal(updateBallAudioCalls, 1, 'updateBallAudio should resume when playing');
  assert.equal(updateVehiclesCalls, 1, 'updateVehicles should resume when playing');
  assert.equal(subsystem.lastPlaybackState, 'playing');
});

test('AudioStage propagates runtime.playbackState into FrameContext', () => {
  let receivedPlaybackState: string | null = null;
  const mockRuntime: FramePipelineRuntimePort = {
    playerCarIndex: 0,
    lastTimestamp: 0,
    container: null,
    openOverlays: new Set(),
    arena: null,
    interpolator: null,
    keyboard: null,
    match: { state: { mode: 'replay', phase: 'playing' } },
    profiler: null,
    modeManager: null,
    audioSubsystem: {
      update: (ctx) => {
        receivedPlaybackState = ctx.playbackState;
      },
    },
    renderSubsystem: null,
    playbackState: 'paused',
    pollInputs: () => false,
  };

  const stage = new AudioStage(mockRuntime);
  const ctx = new FrameContext(mockRuntime);
  stage.execute(ctx);
  assert.equal(receivedPlaybackState, 'paused');

  mockRuntime.playbackState = 'playing';
  stage.execute(ctx);
  assert.equal(receivedPlaybackState, 'playing');
});

test('applyRosterManifestToArena rebuilds 1-6 cars, colors, NameTags, ghost materials, and respects metadataHash', () => {
  const cars: Array<{ visible: boolean; userData: Record<string, unknown> } | null> = [];
  const vehiclePresets: Array<string | null> = [];
  const carColors: Array<number | null | undefined> = [];
  const ghostStates = new Map<number, { isGhost: boolean; opacity: number }>();
  const loadouts = new Map<number, Record<string, unknown>>();
  let renderTreeChangedCount = 0;
  let capturedNameTagPatch: Record<string, unknown> | null = null;

  const arenaTarget: RosterManifestArenaTarget = {
    vehiclePreset: 'fennec',
    carRoleFlags: [] as RosterCarRoleFlag[],
    lastRosterMetadataHash: null,
    markRenderTreeChanged: () => {
      renderTreeChangedCount++;
    },
    vehicleRegistry: {
      cars: cars as never,
      vehiclePresets,
      carColors,
      carLoaders: { teamColors: [0x3b82f6, 0xf97316] },
      loadout: {
        applySlotPaintOrColor: (slot: number, fallbackColor: number) => {
          carColors[slot] = carColors[slot] ?? fallbackColor;
        },
      },
      ensureCar: (carIndex: number, _teamIndex?: number | null, visualOrOptions?: unknown) => {
        if (!cars[carIndex]) {
          cars[carIndex] = { visible: true, userData: {} };
        }
        vehiclePresets[carIndex] = String(visualOrOptions || 'fennec');
        return cars[carIndex] as never;
      },
      setCarLoadout: (carIndex: number, loadout?: Record<string, unknown> | null) => {
        loadouts.set(carIndex, { ...(loadout || {}) });
      },
      setCarGhostOpacity: (carIndex: number, isGhost = true, opacity = 0.7) => {
        ghostStates.set(carIndex, { isGhost, opacity });
        return true;
      },
    },
  };

  const manifest3v3: RosterManifest = {
    metadataHash: 0x8f3a19c4,
    focusedCarIndex: 2,
    cars: [
      { carIndex: 0, name: 'Alice', team: 0, visualId: 'fennec', colorHex: '#112233', roleFlag: 'player', isLocalPlayer: true },
      { carIndex: 1, name: 'Bob', team: 0, visualId: 'octane', roleFlag: 'player' },
      { carIndex: 2, name: 'GhostCoach', team: 0, visualId: 'dominus', roleFlag: 'ghost', ghostOpacity: 0.45 },
      { carIndex: 3, name: 'Bot1', team: 1, visualId: 'merc', colorHex: '#ff6600', roleFlag: 'bot', isBot: true },
      { carIndex: 4, name: 'Bot2', team: 1, visualId: 'breakout', roleFlag: 'bot', isBot: true },
      { carIndex: 5, name: 'Bot3', team: 1, visualId: 'octane', roleFlag: 'bot', isBot: true },
    ],
  };

  const res1 = applyRosterManifestToArena(arenaTarget, manifest3v3, {
    onUpdateNameTags: (carEntries, meta) => {
      capturedNameTagPatch = { carEntries, ...meta };
    },
  });
  assert.equal(res1.applied, true);
  assert.equal(res1.skippedByHash, false);
  assert.equal(res1.activeCarCount, 6);
  assert.deepEqual(res1.rebuiltSlots, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(res1.ghostSlots, [2]);
  assert.equal(vehiclePresets[0], 'fennec');
  assert.equal(vehiclePresets[2], 'dominus');
  assert.equal(vehiclePresets[3], 'merc');
  assert.equal(cars[2]?.userData.isGhost, true);
  assert.equal(cars[2]?.userData.roleFlag, 'ghost');
  assert.deepEqual(ghostStates.get(2), { isGhost: true, opacity: 0.45 });
  assert.deepEqual(ghostStates.get(0), { isGhost: false, opacity: 1.0 });
  assert.equal(arenaTarget.carRoleFlags[2], 'ghost');
  assert.equal(renderTreeChangedCount, 1);

  assert.ok(capturedNameTagPatch);
  assert.equal((capturedNameTagPatch as Record<string, unknown>).isMultiplayerOrMultiCarMode, true);
  assert.equal((capturedNameTagPatch as Record<string, unknown>).focusedCarIndex, 2);
  const ntEntries = (capturedNameTagPatch as { carEntries: Array<{ carIndex: number; name: string; team: number }> }).carEntries;
  assert.equal(ntEntries.length, 6);
  assert.equal(ntEntries[3].name, 'Bot1');
  assert.equal(ntEntries[3].team, 1);

  // Same metadataHash should short-circuit
  const resSameHash = applyRosterManifestToArena(arenaTarget, manifest3v3);
  assert.equal(resSameHash.applied, false);
  assert.equal(resSameHash.skippedByHash, true);
  assert.equal(renderTreeChangedCount, 1);

  // New metadataHash shrinks to 2 cars and converts slot 2 -> hidden, slot 0 -> ghost
  const manifestShrink: RosterManifest = {
    metadataHash: 0x12345678,
    cars: [
      { carIndex: 0, name: 'Alice', team: 0, visualId: 'octane', roleFlag: 'ghost' },
      { carIndex: 3, name: 'Bot1', team: 1, visualId: 'merc', roleFlag: 'player' },
    ],
  };

  const res2 = applyRosterManifestToArena(arenaTarget, manifestShrink);
  assert.equal(res2.applied, true);
  assert.equal(res2.activeCarCount, 2);
  assert.deepEqual(res2.rebuiltSlots, [0]);
  assert.deepEqual(res2.ghostSlots, [0]);
  assert.equal(cars[0]?.visible, true);
  assert.equal(cars[1]?.visible, false);
  assert.equal(cars[2]?.visible, false);
  assert.equal(cars[3]?.visible, true);
  assert.equal(cars[0]?.userData.isGhost, true);
});
