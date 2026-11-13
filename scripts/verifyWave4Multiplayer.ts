/**
 * scripts/verifyWave4Multiplayer.ts
 * Deterministic verification suite for Wave 4:
 * - RoomActivityOrchestrator hot-swapping (freeplay -> match -> replay_intervene -> sandbox -> freeplay)
 * - SpectatorRoomTimelineController lockstep & sparse frozen-frame ping mode
 * - InterveneHandoffCoordinator 4-3-2-1-0 countdown & non-POV policy
 * - CsrFollowHost binary codec, store, and QuickNotification bridge
 */

import assert from 'node:assert/strict';
import {
  ACTIVITY_MODE_FLAGS,
  decodeCsrFollowHostPacket,
  encodeCsrFollowHostPacket,
} from '../src/network/protocol/RoomActivityProtocol.ts';
import { HOST_WORKER_MSG_TYPES as MSG } from '../src/network/protocol/HostWorkerProtocol.ts';
import { routeProtocolMessageInWorker } from '../src/network/server/HostWorkerMessageRouter.ts';
import { RoomActivityOrchestrator } from '../src/network/server/activities/RoomActivityOrchestrator.ts';
import { useCsrFollowHostStore } from '../src/ui-core/stores/csrFollowHostStore.ts';
import { useQuickNotificationStore } from '../src/ui-core/stores/quickNotificationStore.ts';
import {
  applyIncomingCsrFollowHostPayload,
  buildTakeoverHudPayloadFromHandoff,
  clearCsrFollowHostBridge,
} from '../src/ui-system/core/csrFollowHostBridge.ts';
import type { WorkerRouterContext } from '../src/network/server/workerReplayAndDiagnosticsRouter.ts';
import type { InterveneHandoffState } from '../src/network/protocol/RoomActivityProtocol.ts';

function runWave4Verification(): void {
  const codecSample = {
    enabled: true,
    hostActivityId: 'replay_intervene' as const,
    hostCameraMode: 'director',
    hostFocusCarIndex: 2,
    hostTick: 14400,
    frameStepMode: true,
  };
  const encoded = encodeCsrFollowHostPacket(codecSample);
  assert.equal(encoded.byteLength, 8, 'CSR follow-host packet must be 8 bytes');
  const decoded = decodeCsrFollowHostPacket(encoded);
  assert.deepEqual(decoded, codecSample, 'CSR follow-host packet roundtrip must match');

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let unlimitedBoost = false;
  let ghostMode = false;
  let solidRestoredCount = 0;
  let stateOnlyCount = 0;
  let resumeCount = 0;
  let trainingStartCount = 0;
  let matchStartCount = 0;
  const carMasks = new Map<number, { ball: boolean; cars: boolean; opacity: number }>();

  const mockMatchManager = {
    getSnapshot: () => ({
      roomId: 'wave4_room',
      gameMode: '2v2',
      botFillMode: 'no_bots',
      state: 'playing',
      matchTick: 120,
      clockDuration: 300,
      clockSecondsRemaining: 299,
      isOvertime: false,
      overtimeSeconds: 0,
      blueScore: 0,
      orangeScore: 0,
      winner: null,
      winReason: 0,
      lobbyPhysicsActive: false,
      roster: { players: [], spectators: [] },
    }),
    lifecycle: {
      startTrainingMode: () => {
        trainingStartCount += 1;
      },
      startMatch: () => {
        matchStartCount += 1;
      },
    },
    systemControl: {
      isStateOnlyMode: false,
      enterStateOnlyMode: () => {
        stateOnlyCount += 1;
        mockMatchManager.systemControl.isStateOnlyMode = true;
      },
      beginInterveneCountdown: (sec = 4) => 120 + sec * 120,
      resumePhysicsFromState: () => {
        resumeCount += 1;
        mockMatchManager.systemControl.isStateOnlyMode = false;
      },
    },
  };

  const mockPhysicsManager = {
    currentTick: 120,
    sim: {
      setUnlimitedBoost: (v: boolean) => {
        unlimitedBoost = v;
      },
      setBallState: () => {},
    },
    setLobbyGhostMode: (v: boolean) => {
      ghostMode = v;
    },
    restoreSolidCollisions: () => {
      solidRestoredCount += 1;
    },
    getActiveCarMask: () => 0b11,
    setCarCollisionMask: (
      carIndex: number,
      interactWithBall: boolean,
      interactWithCars: boolean,
      opacity = 1
    ) => {
      carMasks.set(carIndex, { ball: interactWithBall, cars: interactWithCars, opacity });
    },
  };

  const orchestrator = new RoomActivityOrchestrator('freeplay');
  const ctx = {
    matchManager: mockMatchManager,
    physicsManager: mockPhysicsManager,
    activityOrchestrator: orchestrator,
    postEnvelope: (env: { type: string; payload: Record<string, unknown> }) => {
      events.push({ type: env.type, payload: env.payload });
    },
  } as unknown as WorkerRouterContext;

  assert.equal(
    routeProtocolMessageInWorker(ctx, {
      type: MSG.ROOM_ACTIVITY_SWITCH,
      payload: { activityId: 'freeplay', unlimitedBoost: true, ghostCars: true },
    }),
    true
  );
  assert.equal(orchestrator.getActiveActivityId(), 'freeplay');
  assert.equal(unlimitedBoost, true);
  assert.equal(ghostMode, true);
  assert.equal(trainingStartCount, 1);

  assert.equal(
    routeProtocolMessageInWorker(ctx, {
      type: MSG.ROOM_ACTIVITY_SWITCH,
      payload: { activityId: 'match', durationSeconds: 300 },
    }),
    true
  );
  assert.equal(orchestrator.getActiveActivityId(), 'match');
  assert.equal(unlimitedBoost, false);
  assert.equal(ghostMode, false);
  assert.equal(matchStartCount, 1);

  assert.equal(
    routeProtocolMessageInWorker(ctx, {
      type: MSG.SPECTATOR_TIMELINE_CMD,
      payload: { action: 'seek', cursorTick: 240, totalTicks: 600 },
    }),
    true
  );
  assert.equal(orchestrator.getActiveActivityId(), 'replay_intervene');
  assert.equal(stateOnlyCount >= 1, true);
  assert.equal(
    (orchestrator.getSummary().modeFlags & ACTIVITY_MODE_FLAGS.SPARSE_FREEZE_MODE) !== 0,
    true
  );
  const t0 = Date.now() + 1000;
  assert.equal(orchestrator.replayInterveneKernel.timeline.shouldEmitSparsePing(t0, 500), true);
  assert.equal(
    orchestrator.replayInterveneKernel.timeline.shouldEmitSparsePing(t0 + 200, 500),
    false
  );
  assert.equal(
    orchestrator.replayInterveneKernel.timeline.shouldEmitSparsePing(t0 + 600, 500),
    true
  );

  routeProtocolMessageInWorker(ctx, {
    type: MSG.INTERVENE_HANDOFF_CMD,
    payload: {
      action: 'begin_countdown',
      authorizedSessionId: 'trainee_1',
      targetCarIndex: 1,
      nonPovPolicy: 'disappear',
      countdownSeconds: 4,
    },
  });
  let handoff = orchestrator.replayInterveneKernel.handoff.getState();
  assert.equal(handoff.phase, 'countdown');
  assert.equal(handoff.countdownStepLabel, '4');
  assert.equal(
    orchestrator.replayInterveneKernel.handoff.isSessionAuthorizedForCar('trainee_1', 1),
    true
  );
  assert.equal(
    orchestrator.replayInterveneKernel.handoff.isSessionAuthorizedForCar('other_peer', 1),
    false
  );

  for (let i = 0; i < 4 * 120; i++) {
    orchestrator.stepTick({
      matchManager: mockMatchManager as never,
      physicsManager: mockPhysicsManager as never,
      syncRoomState: () => {},
    });
  }
  handoff = orchestrator.replayInterveneKernel.handoff.getState();
  assert.equal(handoff.phase, 'active');
  assert.equal(handoff.countdownStepLabel, '0');
  assert.deepEqual(carMasks.get(0), { ball: false, cars: false, opacity: 0 });
  assert.deepEqual(carMasks.get(1), { ball: true, cars: true, opacity: 1 });
  assert.equal(resumeCount >= 1, true);

  const hudActive = buildTakeoverHudPayloadFromHandoff(handoff as InterveneHandoffState, 'orange');
  assert.equal(hudActive?.mainText, 'GO');
  assert.equal(hudActive?.teamSide, 'orange');

  assert.equal(
    routeProtocolMessageInWorker(ctx, {
      type: MSG.ROOM_ACTIVITY_SWITCH,
      payload: { activityId: 'sandbox', customPayload: { labName: 'kickoff_step' } },
    }),
    true
  );
  assert.equal(orchestrator.getActiveActivityId(), 'sandbox');
  assert.equal(solidRestoredCount >= 1, true);

  applyIncomingCsrFollowHostPayload(
    {
      enabled: true,
      hostActivityId: 'sandbox',
      hostCameraMode: 'free',
      hostFocusCarIndex: 0,
      hostTick: 321,
      frameStepMode: true,
    },
    true
  );
  const csrStore = useCsrFollowHostStore.getState();
  assert.equal(csrStore.isConnectedAsClient, true);
  assert.equal(csrStore.hostActivityId, 'sandbox');
  assert.equal(csrStore.frameStepMode, true);

  const notifState = useQuickNotificationStore.getState();
  const matchesCsr = (n: { id?: string; collapseKey?: string } | null | undefined) =>
    n?.id === 'csr-follow-host' || n?.collapseKey === 'csr-follow-host';
  const hasCsrNotif =
    matchesCsr(notifState.activeNotification) ||
    matchesCsr(notifState.activeOngoingTask) ||
    notifState.ongoingTasks.some(matchesCsr) ||
    notifState.unreadStack.some(matchesCsr);
  assert.equal(hasCsrNotif, true, 'CSR follow-host notification must be registered');

  clearCsrFollowHostBridge();
  assert.equal(useCsrFollowHostStore.getState().isConnectedAsClient, false);

  console.log(
    `[PASS] Wave 4 Multiplayer Verification: ${events.length} worker envelopes verified.`
  );
}

runWave4Verification();
