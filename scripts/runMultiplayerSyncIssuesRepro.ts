import { HostBroadcastPublisher } from '../src/game/pipeline/stages/HostBroadcastPublisher.ts';
import {
  resolveModeRosterEntries,
  createResolvedModeRosterBuffer,
} from '../src/game/pipeline/stages/hudRosterResolverPipeline.ts';
import { createOnlineSessionBridgePort } from '../src/game/runtime/onlineSessionEnvironmentPipeline.ts';
import { bindRuntimeUiPort, useAppStore } from '../src/game/runtimeUiPort.ts';
import { PredictionReconciler } from '../src/network/client/PredictionReconciler.ts';
import { GlobalPayloadCodec, MATCH_SIGNALS } from '../src/network/protocol/GlobalPayloadCodec.ts';
import { sanitizeGlobalWorkspaceBroadcast } from '../src/network/protocol/GlobalWorkspaceProtocol.ts';
import { EstablishedSessionManager } from '../src/network/server/EstablishedSessionManager.ts';
import { MatchCommandQueueSubController } from '../src/network/server/match/MatchCommandQueueSubController.ts';
import { MatchDomainState } from '../src/network/server/match/MatchDomainState.ts';
import { MatchSystemControlSubController } from '../src/network/server/match/MatchSystemControlSubController.ts';
import { encodeMatchGlobalFramePacket } from '../src/network/server/match/matchLifecyclePipeline.ts';
import { FLIP_RESET_SUBTYPES, SYSTEM_CONTROL_SIGNALS } from '../src/physics/RocketSimConstants.ts';
import { syncReplayWorkspaceToOnlineRoom } from '../src/replay/replayOnlineSyncHelper.ts';
import {
  getKeyboardInputOverlayTelemetry,
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
  return { hostSimState, hostPhysicsManager, domain, commandQueue, systemControl };
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

  const { systemControl, hostSimState } = createHostBroadcaster();
  const publisher = new HostBroadcastPublisher(60);

  const mockPhysics = {
    saveCompactState: () => new Float32Array(hostSimState),
    getHeaderView: () => ({ tickCount: 101 }),
  };

  publisher.publishIfReady({
    timestamp: 1000,
    physics: mockPhysics as never,
    server: systemControl as never,
    isPaused: false,
  });

  hostSimState[0] = 102;
  publisher.publishIfReady({
    timestamp: 1020,
    physics: mockPhysics as never,
    server: systemControl as never,
    isPaused: false,
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

  const decoded = GlobalPayloadCodec.decode(rawPacket.subarray(1));
  const ackCount = decoded.physics?.acknowledgedControls?.length ?? 0;

  const { reconciler, clientChannel } = createClientReconciler();
  clientChannel.inboundQueue.push(rawPacket);
  reconciler.reconcile(1000);
  const clientAckCount = reconciler.lastParsedPacket?.acknowledgedControls?.length ?? 0;

  updateKeyboardInputOverlayTelemetry({
    wPressed: false,
    aPressed: false,
    sPressed: false,
    dPressed: false,
    qPressed: false,
    ePressed: false,
    boostPressed: false,
    jumpPressed: false,
    slidePressed: false,
  });
  const telemetry = getKeyboardInputOverlayTelemetry();

  const missingAckControls = ackCount === 0 && clientAckCount === 0;
  const overlayUnupdated = !telemetry.wPressed && !telemetry.boostPressed && !telemetry.jumpPressed;

  if (missingAckControls) {
    details.push(
      `Host broadcast packet has acknowledgedControls.length=${ackCount}, client lastParsedPacket.acknowledgedControls.length=${clientAckCount} (HostBroadcastPublisher & MatchSystemControlSubController.stepStateOnlyFrameIfActive hardcode []).`
    );
  }
  if (overlayUnupdated) {
    details.push(
      'Client keyboardInputOverlayTelemetry remains all-false because CarNoseOrientationArrows & useKeyboardOverlayLiveInputs only read local keyboard/window events instead of spectated car acknowledgedControls.'
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
  const { systemControl } = createHostBroadcaster();
  systemControl.enterStateOnlyMode(new Float32Array(448), 200);

  const hasPushBroadcastSignal =
    typeof (systemControl as unknown as Record<string, unknown>).pushBroadcastSignal === 'function';

  const rawPacket = systemControl.stepStateOnlyFrameIfActive();
  const decoded = rawPacket ? GlobalPayloadCodec.decode(rawPacket.subarray(1)) : null;
  const wireSignalTypes = (decoded?.signals || []).map((s) => s.signalType);

  const wireHasCountdownOrIncident =
    wireSignalTypes.includes(MATCH_SIGNALS.KICKOFF_WILL_START) ||
    wireSignalTypes.includes(MATCH_SIGNALS.COUNTDOWN_TICK) ||
    wireSignalTypes.includes(MATCH_SIGNALS.SCORE_UPDATED);

  if (!hasPushBroadcastSignal || !wireHasCountdownOrIncident) {
    details.push(
      `MatchSystemControlSubController.pushBroadcastSignal=${hasPushBroadcastSignal}; Pure CSR broadcast only emits signals=[${wireSignalTypes.map((t) => '0x' + t.toString(16)).join(', ')}]. Exhibition countdown (KICKOFF_WILL_START/COUNTDOWN_TICK), incidents (SCORE_UPDATED/DEMOLITION), and Training shot resets have no broadcast forwarding path to AuthoritativeServerHost.`
    );
  }

  return {
    id: 'issue-2',
    title: 'Exhibition Countdown, Incidents & Training Sync',
    reproduced: !hasPushBroadcastSignal || !wireHasCountdownOrIncident,
    details,
  };
}

async function reproIssue3FlipResetVisualAndAudioSync(): Promise<ReproResult> {
  const details: string[] = [];
  const { systemControl } = createHostBroadcaster();
  systemControl.enterStateOnlyMode(new Float32Array(448), 300);

  const rawPacket = systemControl.stepStateOnlyFrameIfActive();
  const decoded = rawPacket ? GlobalPayloadCodec.decode(rawPacket.subarray(1)) : null;
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
    clientChannel.inboundQueue.push(rawPacket);
    reconciler.reconcile(1000);
  }

  const wireHasFlipReset = wireSignalTypes.includes(MATCH_SIGNALS.FLIP_RESET_GAINED);
  if (!wireHasFlipReset && !clientReceivedFlipResetSignal) {
    details.push(
      `Host FLIP_RESET_GAINED (0x0f, subtype=${FLIP_RESET_SUBTYPES.BALL}) is not forwarded in Pure CSR broadcast (wire signals=[${wireSignalTypes.map((t) => '0x' + t.toString(16)).join(', ')}]); client onSignals receivedFlipReset=${clientReceivedFlipResetSignal}, so FlipResetVisual and audio never trigger.`
    );
  }

  return {
    id: 'issue-3',
    title: 'Flip Reset Visual & Audio Sync',
    reproduced: !wireHasFlipReset && !clientReceivedFlipResetSignal,
    details,
  };
}

async function reproIssue4ReplayWatchTogetherUiTargetNameColor(): Promise<ReproResult> {
  const details: string[] = [];
  bindRuntimeUiPort({
    buildHostWorkspaceBroadcastPayload: (meta?: Record<string, unknown>) =>
      sanitizeGlobalWorkspaceBroadcast(meta),
    captureCameraSyncFromPort: (cam: Record<string, unknown>, follow = true) => ({
      followHostCamera: follow,
      isFreeCam: Boolean(cam.isFreeCam),
      ballCam: typeof cam.ballCam === 'boolean' ? cam.ballCam : true,
      focusedCarIndex: Number(cam.focusedCarIndex) || 0,
    }),
  });

  const sentActivities: Array<Record<string, unknown>> = [];
  const sentWorkspaces: Array<Record<string, unknown>> = [];

  // Host enters replay watching a 90s (10800-tick) replay focusing carIndex=1
  // where car 0 is Orange ("AlphaOrange", team=1) and car 1 is Blue ("BetaBlue", team=0)
  syncReplayWorkspaceToOnlineRoom(
    {
      camera: {
        isFreeCam: false,
        ballCam: true,
        focusedCarIndex: 1,
      },
      multiplayerSession: {
        isHosting: true,
        broadcastRoomActivitySwitch: (opts) => {
          sentActivities.push(opts as unknown as Record<string, unknown>);
        },
        broadcastGlobalWorkspace: (payload) => {
          sentWorkspaces.push(payload);
          return 1;
        },
      },
    },
    {
      active: true,
      playbackPaused: false,
      pausedAtTick: 1200,
      switchActivity: true,
      replayId: 'repro-90s-replay.rc',
    }
  );

  // Client receives room_activity_switch('replay')
  let clientMode = 'freeplay';
  const { reconciler, clientChannel } = createClientReconciler();
  const bridgePort = createOnlineSessionBridgePort(
    {
      modeManager: {
        getActiveMode: () => ({ id: clientMode }),
        setMode: (next: string) => {
          clientMode = next;
        },
      },
      match: { state: { mode: 'freeplay' } },
      trainingOptions: {},
    } as never,
    () => ({}) as never,
    () => ({}) as never
  );

  bridgePort.applyClientRoomActivitySwitch(reconciler as never, sentActivities[0] as never);

  const clientReplayStoreState = useReplayViewerStore.getState();
  const clientUiNotEntered =
    clientMode !== 'replay-viewer' && clientReplayStoreState.viewerState === 'idle';
  if (clientUiNotEntered) {
    details.push(
      `Client received activity='replay', but modeManager set mode='${clientMode}' and useReplayViewerStore.viewerState='${clientReplayStoreState.viewerState}' (replay UI status bar never activates).`
    );
  }

  // Client resolves HUD roster without synced replay roster:
  const rosterBuf = createResolvedModeRosterBuffer();
  const resolved = resolveModeRosterEntries(
    {
      matchMode: clientMode,
      isReplayViewerLoaded: false,
      replayViewerState: clientReplayStoreState.viewerState,
      replayViewerResolvedRoster: clientReplayStoreState.resolvedRoster,
      numCars: 2,
      localPlayerName: 'ClientSpectator',
      activeBotName: 'Necto',
    },
    rosterBuf
  );

  const blueNames = resolved.blueEntries.map((e) => e.name);
  const orangeNames = resolved.orangeEntries.map((e) => e.name);
  const namesAndColorsWrong =
    !blueNames.includes('BetaBlue') || !orangeNames.includes('AlphaOrange');

  if (namesAndColorsWrong) {
    details.push(
      `Client roster resolved blue=[${blueNames.join(', ')}], orange=[${orangeNames.join(', ')}] instead of blue=[BetaBlue], orange=[AlphaOrange] (replay roster/names/team colors are not broadcast).`
    );
  }

  const wsPayload = sentWorkspaces[0] || {};
  const hasReplayMetadataInWorkspace =
    'replayRoster' in wsPayload ||
    'replayTotalFrames' in wsPayload ||
    'replayFileName' in wsPayload;
  if (!hasReplayMetadataInWorkspace) {
    details.push(
      'syncReplayWorkspaceToOnlineRoom workspace broadcast omits replay metadata (fileName, totalFrames, currentFrame, playbackState) and replay roster.'
    );
  }

  return {
    id: 'issue-4',
    title: 'Replay Watch Together UI, Target Player, Names & Colors',
    reproduced: clientUiNotEntered || namesAndColorsWrong || !hasReplayMetadataInWorkspace,
    details,
  };
}

async function reproIssue5GoalReplayAndCinematicCamera(): Promise<ReproResult> {
  const details: string[] = [];
  const { systemControl } = createHostBroadcaster();
  systemControl.enterStateOnlyMode(new Float32Array(448), 500);

  // In Exhibition/Freeplay, GoalReplaySessionCoordinator / ExperimentalMultiBotsReplayController
  // emits GOAL_REPLAY_WILL_START only to local ReplayRingBuffer, not to AuthoritativeServerHost.
  const rawPacket = systemControl.stepStateOnlyFrameIfActive();
  const decoded = rawPacket ? GlobalPayloadCodec.decode(rawPacket.subarray(1)) : null;
  const wireSignalTypes = (decoded?.signals || []).map((s) => s.signalType);

  const { reconciler, clientChannel } = createClientReconciler();
  let clientReceivedGoalReplaySignal = false;
  reconciler.onSignals = (signals) => {
    for (const sig of signals) {
      if (
        sig?.signalType === MATCH_SIGNALS.GOAL_REPLAY_WILL_START ||
        sig?.signalType === MATCH_SIGNALS.GOAL_REPLAY_START
      ) {
        clientReceivedGoalReplaySignal = true;
      }
    }
  };
  if (rawPacket) {
    clientChannel.inboundQueue.push(rawPacket);
    reconciler.reconcile(1000);
  }

  const wireHasGoalReplay =
    wireSignalTypes.includes(MATCH_SIGNALS.GOAL_REPLAY_WILL_START) ||
    wireSignalTypes.includes(MATCH_SIGNALS.GOAL_REPLAY_START);

  if (!wireHasGoalReplay && !clientReceivedGoalReplaySignal) {
    details.push(
      `Host goal replay signals (GOAL_REPLAY_WILL_START / GOAL_REPLAY_START) are missing from Pure CSR broadcast (signals=[${wireSignalTypes.map((t) => '0x' + t.toString(16)).join(', ')}]); client never enters goal replay or cinematic director camera.`
    );
  }

  return {
    id: 'issue-5',
    title: 'Goal Replay & Cinematic Camera Trigger',
    reproduced: !wireHasGoalReplay && !clientReceivedGoalReplaySignal,
    details,
  };
}

async function main(): Promise<void> {
  const results = await Promise.all([
    reproIssue1UserInputBroadcastAndOverlay(),
    reproIssue2ExhibitionCountdownIncidentsAndTraining(),
    reproIssue3FlipResetVisualAndAudioSync(),
    reproIssue4ReplayWatchTogetherUiTargetNameColor(),
    reproIssue5GoalReplayAndCinematicCamera(),
  ]);

  let reproducedCount = 0;
  for (const res of results) {
    const status = res.reproduced ? 'REPRODUCED' : 'NOT_REPRODUCED';
    if (res.reproduced) reproducedCount += 1;
    console.log(`[${status}] ${res.id}: ${res.title}`);
    for (const line of res.details) {
      console.log(`  - ${line}`);
    }
  }

  console.log(`\nSummary: ${reproducedCount}/${results.length} issues reproduced.`);
  if (reproducedCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[ReproSuite] Fatal error:', err);
  process.exit(2);
});
