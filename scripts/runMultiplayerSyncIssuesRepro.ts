import { FreeplayGoalAndTouchSubController } from '../src/game/modes/freeplay/FreeplayGoalAndTouchSubController.ts';
import {
  startExpKickoffCountdownState,
  stepExpCountdownPhaseState,
  type ExpMatchLifecycleMutableState,
} from '../src/game/modes/experimental-multi-bots/experimentalMultiBotsLifecyclePipeline.ts';
import {
  broadcastHostFlipResetSignalsIfNeeded,
  collectHostBroadcastControls,
  HostBroadcastPublisher,
} from '../src/game/pipeline/stages/HostBroadcastPublisher.ts';
import { TelemetryStage } from '../src/game/pipeline/stages/TelemetryStage.ts';
import { RuntimeKickoffSignalSubController } from '../src/game/runtime/RuntimeKickoffSignalSubController.ts';
import {
  bindRuntimeUiPort,
  globalHudTransientChannel,
  useAppStore,
} from '../src/game/runtimeUiPort.ts';
import { PredictionReconciler } from '../src/network/client/PredictionReconciler.ts';
import { GlobalPayloadCodec, MATCH_SIGNALS } from '../src/network/protocol/GlobalPayloadCodec.ts';
import { EstablishedSessionManager } from '../src/network/server/EstablishedSessionManager.ts';
import { MatchCommandQueueSubController } from '../src/network/server/match/MatchCommandQueueSubController.ts';
import { MatchDomainState } from '../src/network/server/match/MatchDomainState.ts';
import { MatchSystemControlSubController } from '../src/network/server/match/MatchSystemControlSubController.ts';
import { encodeMatchGlobalFramePacket } from '../src/network/server/match/matchLifecyclePipeline.ts';
import {
  getKeyboardInputOverlayTelemetry,
  mapRemoteControlsToOverlayKeys,
  updateKeyboardInputOverlayTelemetry,
} from '../src/ui-core/config/keyboardInputOverlayTelemetry.ts';
import { useReplayViewerStore } from '../src/ui-core/stores/replayViewerStore.ts';

interface ReproResult {
  id: string;
  title: string;
  reproduced: boolean;
  details: string[];
}

function createHostBroadcaster() {
  const hostSimState = new Float32Array(448);
  hostSimState[0] = 100;
  hostSimState[2] = 2;
  const hostPhysicsManager = {
    currentTick: 100,
    sim: {
      state: hostSimState,
      numCars: 2,
      restoreState: (buf: Float32Array) => {
        hostSimState.set(buf.subarray(0, Math.min(buf.length, hostSimState.length)));
      },
      restoreCompactState: (buf: Float32Array) => {
        hostSimState.set(buf.subarray(0, Math.min(buf.length, hostSimState.length)));
      },
      saveCompactState: () => new Float32Array(hostSimState),
      saveState: () => new Float32Array(hostSimState),
      syncToStateObject: () => {},
    },
    getActiveCarMask: () => 0b11,
    applySignal: () => {},
  };
  const sessionManager = new EstablishedSessionManager();
  sessionManager.registerSession('peer_client_1', {
    entityId: 1,
    role: 'spectator',
    playerName: 'ClientSpectator',
  });
  const domain = new MatchDomainState({ gameMode: 'freeplay' });
  const commandQueue = new MatchCommandQueueSubController({ domain });
  const systemControl = new MatchSystemControlSubController({
    domain,
    commandQueue,
    physicsManager: hostPhysicsManager as never,
    replayBuffer: null as never,
    encodeFramePacket: (snap) =>
      encodeMatchGlobalFramePacket({
        state: domain.state,
        matchTick: domain.matchTick,
        physicsSnapshot: snap as never,
        physicsManager: hostPhysicsManager as never,
        sessionManager: sessionManager as never,
        replayBuffer: null as never,
        commandController: commandQueue,
      }),
  });
  return { hostSimState, hostPhysicsManager, domain, commandQueue, systemControl, sessionManager };
}

function createClientReconciler() {
  const clientState = new Float32Array(448);
  const clientPrevState = new Float32Array(448);
  const clientCurrState = new Float32Array(448);
  const clientPhysics = {
    state: clientState,
    numCars: 2,
    isCarSlotActive: (idx: number) => idx < 2,
    addCarAtSlot: () => {},
    restoreState: (buf: Float32Array) => {
      clientState.set(buf.subarray(0, Math.min(buf.length, clientState.length)));
    },
    saveState: () => new Float32Array(clientState),
    getCarStateView: () => ({
      posX: 0,
      posY: 100,
      posZ: 0,
      velX: 0,
      velY: 0,
      velZ: 0,
      isOnGround: false,
      hasFlipOrJump: false,
      isFlipping: false,
    }),
    setCarState: () => {},
    getCarMaxFlipCount: () => 1,
    getHeaderView: () => ({ tick: clientState[0], tickCount: clientState[0], numCars: 2 }),
  };
  const clientInterpolator = {
    prevState: clientPrevState,
    currState: clientCurrState,
    alpha: 0,
  };
  const clientChannel = {
    inboundQueue: [] as Uint8Array[],
    send: () => {},
    isLoopback: false,
  };
  const reconciler = new PredictionReconciler(clientPhysics as never, clientChannel as never, {
    localCarIndex: 0,
    interpolator: clientInterpolator as never,
  });
  reconciler.setSpectateMirrorMode(true);
  reconciler.setClientInputEnabled(false);
  return { reconciler, clientChannel, clientPhysics };
}

async function reproIssue1UserInputBroadcastAndOverlay(): Promise<ReproResult> {
  const details: string[] = [];
  (useAppStore.getState() as unknown as { onlineSession: Record<string, unknown> }).onlineSession =
    {
      isDevSyncRoom: true,
      isHosting: true,
      activeRoomActivity: 'freeplay',
    };

  const { systemControl, hostSimState, sessionManager } = createHostBroadcaster();
  const publisher = new HostBroadcastPublisher(60);

  const mockPhysics = {
    saveCompactState: () => new Float32Array(hostSimState),
    getHeaderView: () => ({ tickCount: 101 }),
  };

  // Real collection path via collectHostBroadcastControls (as in SimulationStage.ts)
  const playerControls = {
    throttle: 1,
    steer: -0.6,
    pitch: 0,
    yaw: 0,
    roll: -1,
    jump: true,
    boost: true,
    handbrake: false,
  };
  const acknowledgedControls = collectHostBroadcastControls({
    numCars: 1,
    playerCarIdx: 0,
    playerControls,
    activeMode: null,
    botCoordinator: null,
  });

  publisher.publishIfReady({
    timestamp: 1000,
    physics: mockPhysics as never,
    server: systemControl as never,
    isPaused: false,
    acknowledgedControls,
  });

  hostSimState[0] = 102;
  publisher.publishIfReady({
    timestamp: 1020,
    physics: mockPhysics as never,
    server: systemControl as never,
    isPaused: false,
    acknowledgedControls,
  });

  const rawPacket = systemControl.stepStateOnlyFrameIfActive();
  if (!rawPacket) {
    return {
      id: 'issue-1',
      title: 'User Input Broadcast & Keyboard Input Overlay',
      reproduced: true,
      details: ['stepStateOnlyFrameIfActive returned null'],
    };
  }

  const decoded = GlobalPayloadCodec.decode(rawPacket);
  const ackCount = decoded.physics?.acknowledgedControls?.length ?? 0;

  const { reconciler, clientChannel } = createClientReconciler();
  clientChannel.inboundQueue.push(sessionManager.buildClientPacket('peer_client_1', rawPacket));
  reconciler.reconcile(1000);
  const clientAckList = reconciler.lastParsedPacket?.acknowledgedControls ?? [];
  const clientAckCount = clientAckList.length;

  const matched = clientAckList.find((c) => c.carIndex === 0);
  const mappedKeys = mapRemoteControlsToOverlayKeys(matched?.controls ?? null);
  updateKeyboardInputOverlayTelemetry({
    isRemoteSpectating: true,
    ...mappedKeys,
  });
  const telemetry = getKeyboardInputOverlayTelemetry();

  const missingAckControls = ackCount === 0 || clientAckCount === 0;
  const overlayUnupdated =
    !telemetry.isRemoteSpectating ||
    !telemetry.wPressed ||
    !telemetry.aPressed ||
    !telemetry.qPressed ||
    !telemetry.boostPressed ||
    !telemetry.jumpPressed;

  if (missingAckControls) {
    details.push(
      `Host broadcast packet has acknowledgedControls.length=${ackCount}, client lastParsedPacket.acknowledgedControls.length=${clientAckCount}.`
    );
  }
  if (overlayUnupdated) {
    details.push(
      'Client keyboardInputOverlayTelemetry failed to reflect spectated car acknowledgedControls.'
    );
  }

  return {
    id: 'issue-1',
    title: 'User Input Broadcast & Keyboard Input Overlay',
    reproduced: missingAckControls || overlayUnupdated,
    details,
  };
}

async function reproIssue2ExhibitionCountdownIncidentsAndTraining(): Promise<ReproResult> {
  const details: string[] = [];
  (useAppStore.getState() as unknown as { onlineSession: Record<string, unknown> }).onlineSession =
    {
      isDevSyncRoom: true,
      isHosting: true,
      activeRoomActivity: 'exp-multi-bots',
    };
  (useAppStore.getState() as unknown as Record<string, unknown>).setMatchMode = () => {};

  const { systemControl, hostSimState, sessionManager } = createHostBroadcaster();
  // Room has already been running for 400 ticks (> 360) before Exhibition starts
  let currentTick = 400;
  hostSimState[0] = currentTick;
  systemControl.enterStateOnlyMode(new Float32Array(hostSimState), currentTick);

  const expState: ExpMatchLifecycleMutableState = {
    countdownTicks: 0,
    kickoffTick: 0,
    ticksSinceKickoff: 0,
    lastKickoffStartTick: 0,
    clockStarted: false,
    clockTickAccum: 0,
    configuredDuration: 90,
    remainingSec: 90,
    overtimeSeconds: 0,
    clockDirection: 'down',
    isOvertime: false,
    isMatchEnded: false,
    matchWinnerTeam: 0,
    podiumDelayTicks: 0,
    matchPhase: 'lobby',
    blueScore: 0,
    orangeScore: 0,
    pendingMatchEndAfterReplay: false,
    pendingOvertimeAfterReplay: false,
    pendingMatchWinner: null,
    lastStepInferenceMs: 0,
  };

  const simPorts = {
    physics: {
      getHeaderView: () => ({ tickCount: currentTick }),
    },
    releaseGoalReplayCameraOverride: () => {},
    match: {
      state: {
        mode: 'exp-multi-bots',
        phase: 'kickoff',
        countdown: 3,
        blueScore: 0,
        orangeScore: 0,
        remainingSeconds: 90,
        isOvertime: false,
        overtimeSeconds: 0,
      },
    },
  };

  const tracker = {
    goalResetTicks: 0,
    resetPlayTouchAndGoalState: () => {},
    getGoalIncidentMeta: () => ({ scorerCarIndex: -1, assisterCarIndex: -1 }),
    syncKickoffCountdownStart: () => {},
    syncCountdownTransitionHudAndAudio: () => {},
    syncMatchEndHudAndAudio: () => {},
  };

  const replayPort = {
    isReplayActive: false,
    emitReplaySignal: (signalType: number, param1 = 0, param2 = 0) => {
      // Real production forwarding path: ExperimentalMultiBots -> AuthoritativeServerHost
      systemControl.pushBroadcastSignal(signalType, currentTick, param1, param2);
      return { signalType, param1, param2, frameId: currentTick };
    },
    emitClockSecondAndAlertSignals: () => {},
    retainMatchReplayAndNotify: () => {},
  };

  // Wire Client RuntimeKickoffSignalSubController
  const { reconciler, clientChannel } = createClientReconciler();
  const clientMatchState = {
    mode: 'exp-multi-bots',
    phase: 'lobby',
    countdown: 0,
    blueScore: 0,
    orangeScore: 0,
    remainingSeconds: 90,
    isOvertime: false,
    overtimeSeconds: 0,
  };
  const latch = {
    overtimeAudioPlayed: false,
    lastKickoffTargetFrame: -1,
    lastKickoffStartedFrame: -1,
    latchedKickoffSeconds: new Set<number>(),
    hostMatchReplayNotified: false,
  };
  const kickoffPortBase: Record<string, unknown> = {
    match: { state: clientMatchState },
    physics: {
      getHeaderView: () => ({ tickCount: currentTick }),
      syncToStateObject: () => {},
    },
    markNetworkTelemetryNotified: () => {},
    despawnDiagnosticTestFleet: () => {},
    cameraSubsystem: {
      isGoalReplayCameraOverrideActive: () => false,
      releaseGoalReplayCameraOverride: () => {},
    },
    isGoalReplayCameraOverrideActive: () => false,
    releaseGoalReplayCameraOverride: () => {},
    clearPodiumController: () => {},
    endActiveGoalReplaySession: () => {},
    resetBallTrail: () => {},
    focusLocalPlayerCarInArenaAndCamera: () => {},
    resetCameraViewIfInvalid: () => {},
    setLobbyGhostMode: () => {},
  };
  const kickoffCtrl = new RuntimeKickoffSignalSubController(
    new Proxy(kickoffPortBase, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        return () => undefined;
      },
    }) as never,
    latch as never
  );

  const clientObservedSeconds: number[] = [];
  const clientAudioCount = { count: 0 };
  const fakeAudio = {
    play: (key: string) => {
      if (key === 'match_countdown_321') clientAudioCount.count++;
    },
  };

  reconciler.onSignals = (signals, packetServerTick) => {
    for (const sig of signals) {
      kickoffCtrl.handleSignal(reconciler, sig as never, {
        packetServerTick: packetServerTick ?? currentTick,
        currentTick,
        isFirstSeenSignalId: true,
        hasKickoffStartInBatch: signals.some((s) => s.signalType === MATCH_SIGNALS.KICKOFF_START),
        audio: fakeAudio as never,
      });
    }
  };

  // Start kickoff and step 360 ticks through 3 -> 2 -> 1 -> GO
  startExpKickoffCountdownState(expState, simPorts as never, tracker as never, replayPort as never);

  for (let i = 0; i <= 360; i++) {
    if (i > 0) {
      currentTick++;
      hostSimState[0] = currentTick;
      systemControl.enterStateOnlyMode(new Float32Array(hostSimState), currentTick);
      stepExpCountdownPhaseState(
        expState,
        currentTick,
        simPorts as never,
        tracker as never,
        replayPort as never
      );
    }
    const rawPacket = systemControl.stepStateOnlyFrameIfActive();
    if (rawPacket) {
      clientChannel.inboundQueue.push(sessionManager.buildClientPacket('peer_client_1', rawPacket));
      reconciler.reconcile(1000 + i * 8);
    }
    if (clientMatchState.phase === 'kickoff' && clientMatchState.countdown > 0) {
      if (!clientObservedSeconds.includes(clientMatchState.countdown)) {
        clientObservedSeconds.push(clientMatchState.countdown);
      }
    }
  }

  const missingSeconds = [3, 2, 1].filter((s) => !clientObservedSeconds.includes(s));
  if (missingSeconds.length > 0 || clientAudioCount.count < 3) {
    details.push(
      `Real ExperimentalMultiBots -> RuntimeKickoffSignalSubController at tick>=400: clientObservedSeconds=[${clientObservedSeconds.join(',')}], missing=[${missingSeconds.join(',')}], clientAudioCount=${clientAudioCount.count} (param1 remainingTicks vs absolute targetFrame mismatch).`
    );
  }

  return {
    id: 'issue-2',
    title: 'Exhibition Countdown 3-2-1 (Real Pipeline Contract)',
    reproduced: missingSeconds.length > 0 || clientAudioCount.count < 3,
    details,
  };
}

async function reproIssue3FlipResetVisualAndAudioSync(): Promise<ReproResult> {
  const details: string[] = [];
  (useAppStore.getState() as unknown as { onlineSession: Record<string, unknown> }).onlineSession =
    {
      isDevSyncRoom: true,
      isHosting: true,
      activeRoomActivity: 'freeplay',
    };

  const { systemControl, sessionManager } = createHostBroadcaster();
  systemControl.enterStateOnlyMode(new Float32Array(448), 300);
  broadcastHostFlipResetSignalsIfNeeded(
    systemControl as never,
    { flipResetVisualCarIndices: [0] },
    300
  );

  const rawPacket = systemControl.stepStateOnlyFrameIfActive();
  const decoded = rawPacket ? GlobalPayloadCodec.decode(rawPacket) : null;
  const wireSignalTypes = (decoded?.signals || []).map((s) => s.signalType);

  const { reconciler, clientChannel } = createClientReconciler();
  let clientReceivedFlipResetSignal = false;
  reconciler.onSignals = (signals) => {
    for (const sig of signals) {
      if (sig?.signalType === MATCH_SIGNALS.FLIP_RESET_GAINED) {
        clientReceivedFlipResetSignal = true;
      }
    }
  };
  if (rawPacket) {
    clientChannel.inboundQueue.push(sessionManager.buildClientPacket('peer_client_1', rawPacket));
    reconciler.reconcile(1000);
  }

  const wireHasFlipReset = wireSignalTypes.includes(MATCH_SIGNALS.FLIP_RESET_GAINED);
  if (!wireHasFlipReset || !clientReceivedFlipResetSignal) {
    details.push(
      `Host FLIP_RESET_GAINED (0x0f) wireHasFlipReset=${wireHasFlipReset}, client onSignals receivedFlipReset=${clientReceivedFlipResetSignal}.`
    );
  }

  return {
    id: 'issue-3',
    title: 'Flip Reset Visual & Audio Sync',
    reproduced: !wireHasFlipReset || !clientReceivedFlipResetSignal,
    details,
  };
}

async function reproIssue4ReplayWatchTogetherUiTargetNameColor(): Promise<ReproResult> {
  const details: string[] = [];
  // Simulate Client receiving Replay Watch Together while local matchMode is still 'freeplay'
  // and no local .rcreplay file is loaded in standaloneReplayViewer / rlrcReplaySession.
  (useAppStore.getState() as unknown as { onlineSession: Record<string, unknown> }).onlineSession =
    {
      isDevSyncRoom: true,
      isHosting: false,
      activeRoomActivity: 'replay',
    };

  useReplayViewerStore.setState({
    viewerState: 'playing',
    loadedFileName: 'repro-3v3.rcreplay',
    totalFrames: 10800,
    cursorFrame: 1200,
    activePovCarIndex: 3,
    resolvedRoster: [
      { carIndex: 0, name: 'Player 1', team: 0 },
      { carIndex: 1, name: 'Nexto #2', team: 0 },
      { carIndex: 2, name: 'Nexto #3', team: 0 },
      { carIndex: 3, name: 'Player 4', team: 1 },
      { carIndex: 4, name: 'Nexto #5', team: 1 },
      { carIndex: 5, name: 'Nexto #6', team: 1 },
    ],
  });

  let capturedRoster: {
    leftPlayers?: Array<{ name?: string }>;
    rightPlayers?: Array<{ name?: string }>;
    entries?: Array<{ name?: string }>;
  } | null = null;
  bindRuntimeUiPort({
    useReplayViewerStore: useReplayViewerStore as never,
    globalHudTransientChannel: {
      ...globalHudTransientChannel,
      setRoster: (val: unknown) => {
        capturedRoster = val as typeof capturedRoster;
      },
      setMiniMap: () => {},
    } as never,
  });

  const mockRuntime = {
    match: { state: { mode: 'freeplay', phase: 'playing' } },
    physics: {
      numCars: 6,
      getHeaderView: () => ({ numCars: 6 }),
      getCarStateView: () => ({ boostAmount: 33, isDemolished: false }),
    },
    playerCarIndex: 0,
    modeManager: {
      modes: new Map(),
      getActiveMode: () => null,
    },
  };

  const telemetryStage = new TelemetryStage(mockRuntime as never);
  (
    telemetryStage as unknown as {
      _syncEdgeRosterHud: (ctx: Record<string, unknown>, hudState: Record<string, unknown>) => void;
    }
  )._syncEdgeRosterHud({}, { matchPhase: 'playing' });

  const allEntries = [
    ...(capturedRoster?.leftPlayers ?? []),
    ...(capturedRoster?.rightPlayers ?? []),
    ...(capturedRoster?.entries ?? []),
  ].filter((e) => (e as { exists?: boolean }).exists !== false);
  const entryCount = allEntries.length;
  const hasSyncedNames =
    entryCount === 6 && allEntries.some((e) => e.name === 'Nexto #2');

  if (!hasSyncedNames) {
    details.push(
      `TelemetryStage._syncEdgeRosterHud() with matchMode='freeplay' & activeRoomActivity='replay' produced roster entries=${entryCount} (early return before isClientSyncedReplay).`
    );
  }

  return {
    id: 'issue-4',
    title: 'Replay Watch Together Client Roster (TelemetryStage)',
    reproduced: !hasSyncedNames,
    details,
  };
}

async function reproIssue5GoalReplayAndCinematicCamera(): Promise<ReproResult> {
  const details: string[] = [];
  (useAppStore.getState() as unknown as { onlineSession: Record<string, unknown> }).onlineSession =
    {
      isDevSyncRoom: true,
      isHosting: true,
      activeRoomActivity: 'freeplay',
    };

  const { systemControl } = createHostBroadcaster();
  let beginGoalReplayCalled = false;
  let pollGoalCalls = 0;

  const mockRuntime = {
    authoritativeServer: systemControl,
    networkReconciler: null,
    playerCarIndex: 0,
    playerControls: {},
    arena: { isLobbyMode: false },
    physics: {
      state: new Float32Array(448),
      getHeaderView: () => ({ tickCount: 500 }),
      getBallStateView: () => ({
        posX: 0,
        posY: 5600,
        posZ: 150,
        velX: 0,
        velY: 2000,
        velZ: 0,
        angVelX: 0,
        angVelY: 0,
        angVelZ: 0,
      }),
      getCarStateView: () => ({
        posX: 0,
        posY: 4000,
        posZ: 17,
        velX: 0,
        velY: 1500,
        velZ: 0,
      }),
      pollGoal: () => {
        pollGoalCalls++;
        return 1;
      },
      resetGoalLatch: () => {},
    },
  };

  const goalAndTouch = new FreeplayGoalAndTouchSubController({
    getRuntime: () => mockRuntime as never,
    replayRingBuffer: {
      recordFrame: () => {},
      appendIncident: () => {},
    } as never,
    directorPreview: {
      resetGoalMetadata: () => {},
      setGoalScorerMetadata: () => {},
    } as never,
    resolveEffectivePlayerTeam: () => 0,
    isGoalReplaySkipEnabled: () => false,
    isFreeplayGoalReplayEnabled: () => true,
    isStandaloneReplayLoaded: () => false,
    onBeginGoalReplay: () => {
      beginGoalReplayCalled = true;
    },
  });

  goalAndTouch.stepAfterPhysicsTick();

  const triggeredGoalReset = goalAndTouch.goalResetTicks > 0 || beginGoalReplayCalled;
  if (!triggeredGoalReset) {
    details.push(
      `Broadcasting Host FreeplayGoalAndTouchSubController.stepAfterPhysicsTick() with ball posY=5600 & authoritativeServer!=null: goalResetTicks=${goalAndTouch.goalResetTicks}, pollGoalCalls=${pollGoalCalls}, beginGoalReplayCalled=${beginGoalReplayCalled} (early return swallowed goal).`
    );
  }

  return {
    id: 'issue-5',
    title: 'Freeplay Goal Replay on Dev Sync Broadcasting Host',
    reproduced: !triggeredGoalReset,
    details,
  };
}

async function main() {
  const results = [
    await reproIssue1UserInputBroadcastAndOverlay(),
    await reproIssue2ExhibitionCountdownIncidentsAndTraining(),
    await reproIssue3FlipResetVisualAndAudioSync(),
    await reproIssue4ReplayWatchTogetherUiTargetNameColor(),
    await reproIssue5GoalReplayAndCinematicCamera(),
  ];

  let reproducedCount = 0;
  for (const r of results) {
    if (r.reproduced) reproducedCount++;
    console.log(`[${r.reproduced ? 'REPRODUCED' : 'NOT_REPRODUCED'}] ${r.id}: ${r.title}`);
    for (const d of r.details) {
      console.log(`  - ${d}`);
    }
  }
  console.log(`\nSummary: ${reproducedCount}/${results.length} issues reproduced.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
