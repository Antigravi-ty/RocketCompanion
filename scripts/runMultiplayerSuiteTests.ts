#!/usr/bin/env node
/**
 * scripts/runMultiplayerSuiteTests.ts
 * Automated test matrix for Multiplayer Suite:
 * 1. Tauri P2P Tunnel / DataChannel routing & UTF-8 control framing
 * 2. Kick & Leave bidirectional signaling
 * 3. WebRTC Voice routing (open | team_only + Lobby all-chat override | off)
 * 4. Multiplayer Training (4 boost modes + GhostBallRelayCoordinator + scoreboard/goal-replay)
 * 5. Spectating & GlobalWorkspaceBroadcast (spectate_state_only vs spectate_mirror, pause ACK/heartbeat)
 * 6. Telestrator 50-stroke stress test (stroke.hash + TelestratorHashAck + HostPermissionSync)
 * 7. MultiClientLoopbackSimulator (Human-takeover Bot + Auto-fill Bot combinations)
 */

import assert from 'node:assert/strict';
import { DataChannelTransport } from '../src/network/transport/webrtc/DataChannelTransport.ts';
import { HostSessionController } from '../src/network/transport/HostSessionController.ts';
import { HostPauseAckController } from '../src/network/transport/HostPauseAckController.ts';
import { ReliableTunnelFramer } from '../src/network/transport/tunnel/ReliableTunnelFramer.ts';
import { PredictionReconciler } from '../src/network/client/PredictionReconciler.ts';
import { NetworkSimulator } from '../src/network/transport/webrtc/NetworkSimulator.ts';
import { CrossTabSignaling } from '../src/network/transport/webrtc/CrossTabSignaling.ts';
import type {
  TunnelPacketPayload,
  TunnelTransport,
} from '../src/network/transport/tunnel/TunnelTransport.ts';
import { WebRtcNativeVoiceBridge } from '../src/audio/voice/WebRtcNativeVoiceBridge.ts';
import { RoomActivityOrchestrator } from '../src/network/server/RoomActivityOrchestrator.ts';
import { ACTIVITY_IDS, REPLICATION_MODES } from '../src/network/protocol/ReplicationBusProtocol.ts';
import {
  GhostBallRelayCoordinator,
  applyTrainingBoostPolicyToSim,
  sanitizeTrainingConfig,
  type MultiplayerTrainingConfig,
} from '../src/network/server/activities/MultiplayerTrainingPolicy.ts';
import {
  clampPauseHeartbeatHz,
  getPauseHeartbeatIntervalMs,
  sanitizeGlobalWorkspaceBroadcast,
} from '../src/network/protocol/GlobalWorkspaceProtocol.ts';
import { useSpectateWorkspaceStore } from '../src/ui-core/stores/spectateWorkspaceStore.ts';
import {
  canLocalDrawInTelestrator,
  useTelestratorStore,
} from '../src/ui-core/stores/telestratorStore.ts';
import { TelestratorManager } from '../src/entities/telestrator/TelestratorManager.ts';
import { CoachAuthorityHandoverController } from '../src/game/runtime/CoachAuthorityHandoverController.ts';
import { AuthorityCameraSyncTracker } from '../src/game/pipeline/stages/AuthorityCameraSyncTracker.ts';
import {
  applyRemoteTelestratorWireBytes,
  canTelestratorDrawNow,
} from '../src/game/subsystems/telestratorOverlayHelpers.ts';
import { computeStrokeHash } from '../src/entities/telestrator/telestratorStrokeMath.ts';
import {
  TELESTRATOR_WIRE_MSG_TYPE,
  decodeHostPermissionSync,
  decodeTelestratorClear,
  decodeTelestratorHashAck,
  decodeTelestratorStroke,
  decodeTelestratorUndo,
  encodeHostPermissionSync,
  encodeTelestratorClear,
  encodeTelestratorHashAck,
  encodeTelestratorStroke,
  encodeTelestratorUndo,
  getTelestratorWireMsgType,
} from '../src/network/protocol/TelestratorWireCodec.ts';
import type {
  TelestratorBrushTool,
  TelestratorColorId,
  TelestratorPoint,
  TelestratorStroke,
} from '../src/entities/telestrator/telestratorTypes.ts';
import {
  MultiClientLoopbackSimulator,
  SIX_CAR_STRESS_LOADOUTS,
} from '../src/game/scenario/MultiClientLoopbackSimulator.ts';
import { NetworkDataHandler } from '../src/network/server/NetworkDataHandler.ts';
import { EstablishedSessionManager } from '../src/network/server/EstablishedSessionManager.ts';
import { InputPacketCodec } from '../src/network/protocol/InputPacketCodec.ts';
import { routeProtocolMessageInWorker } from '../src/network/server/HostWorkerMessageRouter.ts';
import { HOST_WORKER_MSG_TYPES } from '../src/network/protocol/HostWorkerProtocol.ts';
import { createOnlineSessionBridgePort } from '../src/game/runtime/onlineSessionEnvironmentPipeline.ts';
import { MatchDomainState } from '../src/network/server/match/MatchDomainState.ts';
import { MatchCommandQueueSubController } from '../src/network/server/match/MatchCommandQueueSubController.ts';
import { MatchSystemControlSubController } from '../src/network/server/match/MatchSystemControlSubController.ts';
import { encodeMatchGlobalFramePacket } from '../src/network/server/match/matchLifecyclePipeline.ts';
import { applyReplayFrameToEngine } from '../src/replay/ReplayFrameInterpolator.ts';
import {
  FLIP_RESET_SUBTYPES,
  SYSTEM_CONTROL_SIGNALS,
  SIM_OFFSETS,
} from '../src/physics/RocketSimConstants.ts';
import {
  GlobalPayloadCodec,
  MATCH_SIGNALS,
} from '../src/network/protocol/GlobalPayloadCodec.ts';
import { sharedAuthorityCameraSyncTracker } from '../src/game/pipeline/stages/AuthorityCameraSyncTracker.ts';
import {
  resolveModeRosterEntries,
  createResolvedModeRosterBuffer,
} from '../src/game/pipeline/stages/hudRosterResolverPipeline.ts';
import { useReplayViewerStore } from '../src/ui-core/stores/replayViewerStore.ts';
import {
  ReplayOnlineHeartbeatTracker,
  syncReplayFrameToAuthoritativeServer,
  syncReplayWorkspaceToOnlineRoom,
} from '../src/replay/replayOnlineSyncHelper.ts';
import { bindRuntimeUiPort } from '../src/game/runtimeUiPort.ts';
import { MATCH_STATES } from '../src/network/server/match/matchLoadoutAndSpawnPipeline.ts';
import { routeActivityAndInputMessage } from '../src/network/server/workerActivityAndInputRouter.ts';
import {
  stopActiveOnlineOrLoopbackSessionIfNeeded,
  createMatchModeTransitionBridge,
} from '../src/game/runtime/MatchModeTransitionBridge.ts';
import {
  ClientAuthorityPublisher,
  HostBroadcastPublisher,
} from '../src/game/pipeline/stages/HostBroadcastPublisher.ts';
import {
  getKeyboardInputOverlayTelemetry,
  mapRemoteControlsToOverlayKeys,
  updateKeyboardInputOverlayTelemetry,
} from '../src/ui-core/config/keyboardInputOverlayTelemetry.ts';
import { SpectateInterpolationBuffer } from '../src/network/sync/ReplicationStateInterpolator.ts';
import {
  HostInputAuthorityTracker,
  syncPeerWorkspaceSnapshot,
} from '../src/network/transport/hostCrossTabAndAuthority.ts';
import { classifyRoomMessage } from '../src/network/transport/webrtc/webrtcHandshakePipeline.ts';

function runSection(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`[PASS] ${name}`);
    });
}

async function testTunnelAndKickLeaveSignaling(): Promise<void> {
  const sentPackets: Array<{ peerId: string; payload: TunnelPacketPayload; reliable: boolean }> =
    [];
  let hostTransport: DataChannelTransport;
  let clientTransport: DataChannelTransport;
  let dropNextReliableFrame = false;

  const loopbackTunnel: TunnelTransport = {
    mode: 'rust_udp',
    isOpen: true,
    localEndpoint: { addr: '127.0.0.1:49000', isUpnpMapped: false, mode: 'rust_udp' },
    open: async () => ({ addr: '127.0.0.1:49000', isUpnpMapped: false, mode: 'rust_udp' }),
    connectPeer: async () => {},
    sendToPeer: (peerId, payload, reliable = false) => {
      sentPackets.push({ peerId, payload, reliable });
      if (payload instanceof Uint8Array && dropNextReliableFrame) {
        dropNextReliableFrame = false;
        return true; // simulate single UDP frame drop
      }
      if (peerId === 'peer_client_1') {
        clientTransport.handleIncomingMessage(payload);
      } else if (peerId === 'host') {
        hostTransport.handleIncomingMessage(payload);
      }
      return true;
    },
    onPacket: () => {},
    close: async () => {},
  };

  hostTransport = new DataChannelTransport({
    simulator: new NetworkSimulator(),
    signaling: new CrossTabSignaling(),
  });
  clientTransport = new DataChannelTransport({
    simulator: new NetworkSimulator(),
    signaling: new CrossTabSignaling(),
  });

  hostTransport.attachTunnelTransport(loopbackTunnel, 'peer_client_1');
  clientTransport.attachTunnelTransport(loopbackTunnel, 'host');
  assert.equal(hostTransport.hasActiveTunnel(), true);

  // State packet -> unreliable tunnel
  const stateFrame = new Uint8Array([1, 2, 3, 4]);
  assert.equal(hostTransport.send(stateFrame, 1000), true);
  assert.equal(
    sentPackets.some((p) => p.peerId === 'peer_client_1' && !p.reliable),
    true
  );

  // Reliable control -> framed via ReliableTunnelFramer with chunking & loss recovery
  let kickedPayload: Record<string, unknown> | null = null;
  clientTransport.onPeerKick = (msg) => {
    kickedPayload = msg;
  };
  dropNextReliableFrame = true;
  assert.equal(
    hostTransport.sendReliableControl({ type: 'peer_kick', reason: 'test_kick' }, 'peer_kick'),
    true
  );
  //Wait for retransmit loop (25ms interval, 45ms retransmit threshold)
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(kickedPayload?.reason, 'test_kick');

  // Oversized (>2500B) global_workspace_broadcast chunked & reassembled across ReliableTunnelFramer
  let receivedWorkspace: Record<string, unknown> | null = null;
  clientTransport.onGlobalWorkspaceBroadcast = (msg) => {
    receivedWorkspace = msg;
  };
  const manyWindows = Array.from({ length: 60 }, (_, idx) => ({
    id: `floating_window_${idx}`,
    isOpen: idx % 2 === 0,
    isMinimized: idx % 3 === 0,
  }));
  assert.equal(
    hostTransport.sendGlobalWorkspaceBroadcast({
      menuRoute: 'settings/audio',
      openFloatingWindows: manyWindows,
    }),
    true
  );
  assert.equal(receivedWorkspace?.menuRoute, 'settings/audio');
  assert.equal((receivedWorkspace?.openFloatingWindows as unknown[] | undefined)?.length, 60);

  // tunnel_endpoint_advertise must NOT go over tunnel (bootstraps via WebRTC/BroadcastChannel)
  const beforeCount = sentPackets.length;
  hostTransport.sendReliableControl(
    { type: 'tunnel_endpoint_advertise', addr: '127.0.0.1:49000' },
    'tunnel_endpoint_advertise'
  );
  assert.equal(sentPackets.length, beforeCount);

  // Client -> Host peer_leave over ReliableTunnelFramer
  let leftPayload: Record<string, unknown> | null = null;
  hostTransport.onPeerLeave = (msg) => {
    leftPayload = msg;
  };
  assert.equal(
    clientTransport.sendReliableControl(
      { type: 'peer_leave', peerId: 'peer_client_1' },
      'peer_leave'
    ),
    true
  );
  assert.equal(leftPayload?.peerId, 'peer_client_1');

  hostTransport.detachTunnelTransport();
  clientTransport.detachTunnelTransport();
  assert.equal(hostTransport.hasActiveTunnel(), false);
}

async function testVoiceRoutingPolicies(): Promise<void> {
  const bridge = new WebRtcNativeVoiceBridge({
    getAudioContext: () => null,
  });

  bridge.setRoomVoicePolicy('open', 0, false);
  assert.equal(bridge.isPeerVoiceAllowed({ team: 0 }), true);
  assert.equal(bridge.isPeerVoiceAllowed({ team: 1 }), true);

  // team_only in Lobby -> all-chat override allows cross-team
  bridge.setRoomVoicePolicy('team_only', 0, true);
  assert.equal(bridge.isPeerVoiceAllowed({ team: 0 }), true);
  assert.equal(bridge.isPeerVoiceAllowed({ team: 1 }), true);

  // team_only in Match -> cross-team gated
  bridge.setRoomVoicePolicy('team_only', 0, false);
  assert.equal(bridge.isPeerVoiceAllowed({ team: 0 }), true);
  assert.equal(bridge.isPeerVoiceAllowed({ team: 1 }), false);

  // off -> all gated, enableVoice refuses capture with status message
  bridge.setRoomVoicePolicy('off', 0, true);
  assert.equal(bridge.isPeerVoiceAllowed({ team: 0 }), false);
  assert.equal(bridge.isPeerVoiceAllowed({ team: 1 }), false);
  await bridge.enableVoice();
  assert.equal(bridge.isVoiceEnabled(), false);
  assert.ok(bridge.getSnapshot().audioStatusMessage?.includes('disabled'));
}

function testMultiplayerTrainingAndGhostRelay(): void {
  const orchestrator = new RoomActivityOrchestrator(ACTIVITY_IDS.FREEPLAY);
  const ctx = {
    matchManager: {
      domain: { matchTick: 120 },
      lifecycle: { startTrainingMode: () => {} },
    },
    physicsManager: {
      setTrainingBoostConfig: () => {},
    },
    trainingConfig: sanitizeTrainingConfig({
      boostPolicy: 'limit_when_aerial',
      ghostModeEnabled: false,
    }),
  };

  const sw = orchestrator.switchActivity(
    { activityId: ACTIVITY_IDS.MULTIPLAYER_TRAINING },
    ctx as never
  );
  assert.equal(sw.activityId, ACTIVITY_IDS.MULTIPLAYER_TRAINING);
  assert.equal(orchestrator.getActiveActivityId(), ACTIVITY_IDS.MULTIPLAYER_TRAINING);

  const summary = new RoomActivityOrchestrator(ACTIVITY_IDS.MULTIPLAYER_TRAINING);
  const csr = summary.buildCsrBroadcast(ctx as never, false);
  assert.equal((csr.uiSummary as Record<string, unknown>).hideScoreboard, true);
  assert.equal((csr.uiSummary as Record<string, unknown>).boostPolicy, 'limit_when_aerial');

  // Test 4 boost modes with mock sim
  const unlimitedState = new Map<number, boolean>();
  const collectableState = new Map<number, boolean>();
  const groundState = new Map<number, boolean>([
    [0, true],
    [1, false],
    [2, true],
  ]);
  const mockSim = {
    setCarUnlimitedBoost: (idx: number, val: boolean) => unlimitedState.set(idx, val),
    setCarBoostCollectable: (idx: number, val: boolean) => collectableState.set(idx, val),
    getCarStateView: (idx: number) => ({ isOnGround: groundState.get(idx) ?? false }),
  };

  const applyPolicy = (cfg: MultiplayerTrainingConfig) =>
    applyTrainingBoostPolicyToSim(mockSim as never, [0, 1, 2], cfg);

  applyPolicy({ boostPolicy: 'limited', perPlayerBoostOverrides: {}, ghostModeEnabled: false });
  assert.deepEqual([...unlimitedState.values()], [false, false, false]);
  assert.deepEqual([...collectableState.values()], [true, true, true]);

  applyPolicy({
    boostPolicy: 'limit_when_aerial',
    perPlayerBoostOverrides: {},
    ghostModeEnabled: false,
  });
  assert.equal(unlimitedState.get(0), true);
  assert.equal(unlimitedState.get(1), false);
  assert.equal(unlimitedState.get(2), true);

  applyPolicy({ boostPolicy: 'unlimited', perPlayerBoostOverrides: {}, ghostModeEnabled: false });
  assert.deepEqual([...unlimitedState.values()], [true, true, true]);

  applyPolicy({
    boostPolicy: 'custom',
    perPlayerBoostOverrides: { 0: 'limited', 1: 'unlimited' },
    ghostModeEnabled: true,
  });
  assert.equal(unlimitedState.get(0), false);
  assert.equal(unlimitedState.get(1), true);
  assert.equal(unlimitedState.get(2), true); // default limit_when_aerial & onGround=true

  // GhostBallRelayCoordinator
  const relay = new GhostBallRelayCoordinator();
  relay.ingestClientBall({
    ownerPeerId: 'peer_1',
    carIndex: 1,
    pos: [10, 20, 30],
    vel: [1, 2, 3],
    angVel: [0, 0, 0],
    tick: 100,
  });
  relay.ingestClientBall({
    ownerPeerId: 'peer_2',
    carIndex: 2,
    pos: [-10, 20, 30],
    vel: [-1, 2, 3],
    angVel: [0, 0, 0],
    tick: 100,
  });
  relay.ingestClientBall({
    ownerPeerId: 'peer_3',
    carIndex: 3,
    pos: [0, 50, 40],
    vel: [0, 0, 1],
    angVel: [0, 0, 0],
    tick: 100,
  });
  assert.equal(relay.getBallCount(), 3);
  const forPeer1 = relay.buildRelaySnapshot('peer_1');
  assert.equal(forPeer1.length, 2);
  assert.equal(
    forPeer1.some((b) => b.ownerPeerId === 'peer_1'),
    false
  );
  relay.removePeer('peer_2');
  assert.equal(relay.getBallCount(), 2);
}

function testSpectatingAndGlobalWorkspace(): void {
  const orchestrator = new RoomActivityOrchestrator(ACTIVITY_IDS.REPLAY);
  assert.equal(orchestrator.getTelestratorPermission(), 'host_only');
  orchestrator.setPauseHeartbeatHz(25);
  assert.equal(orchestrator.getPauseHeartbeatIntervalMs(), getPauseHeartbeatIntervalMs(10));
  assert.equal(clampPauseHeartbeatHz(0), 1);

  const broadcast = orchestrator.buildGlobalWorkspaceBroadcast({
    tick: 420,
    menuRoute: 'settings/audio',
    openFloatingWindows: [{ id: 'telestrator_toolbar', isOpen: true, isMinimized: false }],
    playbackPaused: true,
    pausedAtTick: 420,
  });
  const sanitized = sanitizeGlobalWorkspaceBroadcast(broadcast);
  assert.equal(sanitized.telestratorPermission, 'host_only');
  assert.equal(sanitized.pauseHeartbeatHz, 10);
  assert.equal(sanitized.openFloatingWindows[0].id, 'telestrator_toolbar');

  // STATE_PAUSED_ACK barrier
  orchestrator.setReplicationMode(REPLICATION_MODES.SPARSE);
  assert.equal(orchestrator.hasAllPeersPausedAck(2), false);
  assert.equal(
    orchestrator.recordStatePausedAck({
      epoch: orchestrator.getEpoch(),
      clientSessionId: 'peer_1',
      pausedTick: 420,
    }),
    true
  );
  assert.equal(orchestrator.hasAllPeersPausedAck(2), false);
  assert.equal(
    orchestrator.recordStatePausedAck({
      epoch: orchestrator.getEpoch(),
      clientSessionId: 'peer_2',
      pausedTick: 420,
    }),
    true
  );
  assert.equal(orchestrator.hasAllPeersPausedAck(2), true);

  // Client Spectate Store: spectate_state_only -> spectate_mirror -> exit restore
  let appliedRoute: string | null = 'home';
  let appliedWindows = [{ id: 'local_hud', isOpen: true, isMinimized: false }];
  const captureLocal = () => ({ menuRoute: appliedRoute, windows: appliedWindows });
  const applyWorkspace = (
    route: string | null,
    windows: Array<{ id: string; isOpen: boolean; isMinimized: boolean }>
  ) => {
    appliedRoute = route;
    appliedWindows = windows;
  };

  const store = useSpectateWorkspaceStore.getState();
  store.setSpectateMode('spectate_state_only', captureLocal, applyWorkspace);
  store.setSpectatingActive(true, captureLocal, applyWorkspace);
  assert.equal(useSpectateWorkspaceStore.getState().isReadOnlyLocked, false);
  assert.equal(appliedRoute, 'home');

  useSpectateWorkspaceStore.getState().applyHostWorkspaceBroadcast(sanitized, applyWorkspace);
  assert.equal(appliedRoute, 'home'); // state_only does not mirror UI

  useSpectateWorkspaceStore
    .getState()
    .setSpectateMode('spectate_mirror', captureLocal, applyWorkspace);
  assert.equal(useSpectateWorkspaceStore.getState().isReadOnlyLocked, true);
  assert.equal(appliedRoute, 'settings/audio');
  assert.equal(appliedWindows[0].id, 'telestrator_toolbar');

  useSpectateWorkspaceStore.getState().setSpectatingActive(false, captureLocal, applyWorkspace);
  assert.equal(useSpectateWorkspaceStore.getState().isReadOnlyLocked, false);
  assert.equal(appliedRoute, 'home');
  assert.equal(appliedWindows[0].id, 'local_hud');
}

function testTelestratorStressAndHashAck(): void {
  const tools: TelestratorBrushTool[] = ['solid', 'dashed', 'arrow'];
  const colors: TelestratorColorId[] = ['red', 'yellow', 'bright-green', 'white'];

  for (let i = 0; i < 50; i++) {
    const points: TelestratorPoint[] = [];
    for (let p = 0; p < 20; p++) {
      points.push({
        x: (i * 17 + p * 3) % 4000,
        y: (p * 11) % 5000,
        z: 20 + p,
        nx: 0,
        ny: 0,
        nz: 1,
      });
    }
    const tool = tools[i % tools.length];
    const colorId = colors[i % colors.length];
    const hash = computeStrokeHash(tool, colorId, 0, 0.9, 6, 18, 12, points);
    const stroke: TelestratorStroke = {
      id: `stroke_${i}`,
      authorId: i % 2 === 0 ? 'host' : 'peer_1',
      strokeSeq: i + 1,
      tool,
      colorId,
      presetIndex: 0,
      opacity: 0.9,
      widthRefPx: 6,
      arrowLengthRefPx: 18,
      arrowWidthRefPx: 12,
      camPos: { x: 0, y: -1500, z: 600 },
      camForward: { x: 0, y: 1, z: -0.2 },
      camFovDeg: 90,
      createdTick: 100 + i,
      fadeDurationTicks: 600,
      points,
      hash,
    };

    const wire = encodeTelestratorStroke(stroke, false);
    const decoded = decodeTelestratorStroke(wire);
    assert.ok(decoded, `Stroke ${i} must decode`);
    assert.equal(decoded.stroke.hash, stroke.hash, `Stroke ${i} hash must match`);

    const ackWire = encodeTelestratorHashAck({
      strokeId: stroke.id,
      hash: decoded.stroke.hash,
      matched: decoded.stroke.hash === stroke.hash,
    });
    const ackDecoded = decodeTelestratorHashAck(ackWire);
    assert.ok(ackDecoded?.matched, `Stroke ${i} TelestratorHashAck must be matched=true`);
  }

  const permWire = encodeHostPermissionSync({
    allowClientDrawing: false,
    strokesVisible: true,
    allowedClientIds: ['host'],
  });
  const permDecoded = decodeHostPermissionSync(permWire);
  assert.equal(permDecoded?.allowClientDrawing, false);
  assert.deepEqual(permDecoded?.allowedClientIds, ['host']);
}

async function testMultiClientLoopbackBotMatrix(): Promise<void> {
  const connectedPeers: string[] = [];
  const receivedFrames: Array<{ peerId: string; byteLength: number }> = [];
  let hostStopped = false;

  const mockRuntime = {
    networkManager: {
      isHosting: true,
      sessionCoordinator: {
        hostOnlineServer: async () => {},
        stopOnlineServer: async () => {
          hostStopped = true;
        },
      },
      rosterSyncCoordinator: {
        onRemotePlayerConnected: async (ch: {
          peerId: string;
          onPacketReceived?: ((pkt: Uint8Array | ArrayBuffer | string) => void) | null;
        }) => {
          connectedPeers.push(ch.peerId);
          ch.onPacketReceived = (pkt) => {
            if (pkt instanceof Uint8Array) {
              receivedFrames.push({ peerId: ch.peerId, byteLength: pkt.byteLength });
            }
          };
        },
      },
    },
    physics: {
      numCars: 6,
      isCarSlotActive: () => true,
      getHeaderView: () => ({ tickCount: 10 }),
    },
    arena: {
      cars: SIX_CAR_STRESS_LOADOUTS.map(() => ({ visible: true })),
    },
    authoritativeServer: {
      lastServerTick: 10,
      fallbackManager: { domain: { state: 'playing' } },
    },
  };

  const sim = new MultiClientLoopbackSimulator(mockRuntime);
  await sim.startSixCarLoopbackSession(120);
  assert.equal(sim.isActive(), true);
  assert.equal(connectedPeers.length, 5); // 5 virtual remote peers + 1 host

  // Human-takeover Bot override + Auto-fill replay skip policies
  sim.setPeerControlsOverride('peer_1', { throttle: 1, boost: true, steer: -0.5 });
  sim.setPeerReplaySkipPolicy('peer_1', 'immediate');
  sim.setPeerReplaySkipPolicy('peer_2', 'never');

  sim.stepVirtualPeers(10, 166.67);
  const telemetry = sim.collectTelemetry();
  assert.equal(telemetry.virtualPeersConnected, 5);
  assert.equal(telemetry.activePhysicalCars, 6);
  assert.equal(telemetry.visibleArenaCars, 6);
  assert.equal(telemetry.totalClientInputPacketsSent, 5);
  assert.equal(receivedFrames.length, 5);

  await sim.stop();
  assert.equal(sim.isActive(), false);
  assert.equal(hostStopped, true);

  // Full parameterized roster matrix: 1v1, 1v2, 2v1, 2v2, 2v3, 3v3 (Human-Takeover & Auto-fill Bot)
  const rosterMatrix = [
    { label: '1v1_1h1b', blueHumans: 1, orangeHumans: 0, blueBots: 0, orangeBots: 1 },
    { label: '1v1_2h', blueHumans: 1, orangeHumans: 1, blueBots: 0, orangeBots: 0 },
    { label: '1v2_1h2b', blueHumans: 1, orangeHumans: 0, blueBots: 0, orangeBots: 2 },
    { label: '2v1_2h1b', blueHumans: 2, orangeHumans: 0, blueBots: 0, orangeBots: 1 },
    { label: '2v2_2h2b', blueHumans: 1, orangeHumans: 1, blueBots: 1, orangeBots: 1 },
    { label: '2v2_4h', blueHumans: 2, orangeHumans: 2, blueBots: 0, orangeBots: 0 },
    { label: '2v3_2h3b', blueHumans: 2, orangeHumans: 0, blueBots: 0, orangeBots: 3 },
    { label: '3v3_3h3b', blueHumans: 2, orangeHumans: 1, blueBots: 1, orangeBots: 2 },
    { label: '3v3_6h', blueHumans: 3, orangeHumans: 3, blueBots: 0, orangeBots: 0 },
  ];

  const voiceBridge = new WebRtcNativeVoiceBridge({ getAudioContext: () => null });
  for (const caseSpec of rosterMatrix) {
    const totalCars =
      caseSpec.blueHumans + caseSpec.orangeHumans + caseSpec.blueBots + caseSpec.orangeBots;
    const carIndices = Array.from({ length: totalCars }, (_, i) => i);
    const carUnlimited = new Map<number, boolean>();
    const simPort = {
      setCarUnlimitedBoost: (idx: number, val: boolean) => carUnlimited.set(idx, val),
      setCarBoostCollectable: () => {},
      getCarStateView: (idx: number) => ({ isOnGround: idx % 2 === 0 }),
    };
    applyTrainingBoostPolicyToSim(simPort as never, carIndices, {
      boostPolicy: 'limit_when_aerial',
      perPlayerBoostOverrides: {},
      ghostModeEnabled: false,
    });
    for (const idx of carIndices) {
      assert.equal(
        carUnlimited.get(idx),
        idx % 2 === 0,
        `${caseSpec.label}: car ${idx} limit_when_aerial mismatch`
      );
    }

    // Verify team_only voice gating in Lobby (all-talk) vs Match (team-gated)
    voiceBridge.setRoomVoicePolicy('team_only', 0, true);
    assert.equal(
      voiceBridge.isPeerVoiceAllowed({ team: 1 }),
      true,
      `${caseSpec.label} lobby all-talk`
    );
    voiceBridge.setRoomVoicePolicy('team_only', 0, false);
    assert.equal(
      voiceBridge.isPeerVoiceAllowed({ team: 0 }),
      true,
      `${caseSpec.label} match teammate`
    );
    assert.equal(
      voiceBridge.isPeerVoiceAllowed({ team: 1 }),
      false,
      `${caseSpec.label} match opponent`
    );
  }
}

async function testWebRtcFirstAndTunnelFallbackPath(): Promise<void> {
  const tunnelSent: Uint8Array[] = [];
  const webrtcSent: unknown[] = [];
  const mockTunnel: TunnelTransport = {
    kind: 'rust-upnp-udp',
    sessionId: 'sess_fallback',
    state: 'open',
    isOpen: true,
    open: async () => ({
      kind: 'rust-upnp-udp',
      sessionId: 'sess_fallback',
      localIp: '127.0.0.1',
      localPort: 49001,
      externalIp: null,
      externalPort: null,
      upnpMapped: false,
    }),
    connectToPeer: async () => {},
    connectPeer: async () => {},
    disconnectPeer: async () => {},
    send: () => true,
    sendToPeer: (_peerId, payload) => {
      if (payload instanceof Uint8Array) tunnelSent.push(payload);
      return true;
    },
    sendTyped: () => true,
    sendTypedToPeer: () => true,
    broadcastTyped: () => 1,
    onPacket: () => {},
    onStateChange: () => {},
    onDiagnostic: () => {},
    getStats: () => ({
      kind: 'rust-upnp-udp',
      state: 'open',
      bytesSent: 0,
      bytesReceived: 0,
      packetsSent: 0,
      packetsReceived: 0,
      upnpMapped: false,
      peerCount: 1,
      peerAddr: '127.0.0.1:49001',
    }),
    close: async () => {},
  };

  const fakeDc = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: unknown) => {
      webrtcSent.push(data);
    },
  } as unknown as RTCDataChannel;

  const transport = new DataChannelTransport({
    simulator: new NetworkSimulator(),
    signaling: new CrossTabSignaling(),
    getDataChannel: () => fakeDc,
  });
  transport.attachTunnelTransport(mockTunnel, 'peer_remote');

  // When WebRTC DataChannel is open, transport MUST prefer WebRTC (zero IPC overhead)
  assert.equal(transport.getTransportPath(), 'webrtc');
  assert.equal(transport.send(new Uint8Array([9, 8, 7]), 1000), true);
  assert.equal(webrtcSent.length, 1);
  assert.equal(tunnelSent.length, 0);

  // When WebRTC DataChannel drops, transport MUST automatically downgrade to rust-upnp-udp
  (fakeDc as unknown as { readyState: string }).readyState = 'closed';
  assert.equal(transport.getTransportPath(), 'rust-upnp-udp');
  assert.equal(transport.send(new Uint8Array([6, 5, 4]), 1000), true);
  assert.equal(tunnelSent.length, 1);

  transport.detachTunnelTransport();
  assert.equal(transport.getTransportPath(), 'disconnected');
}

async function testHostPrewarmedPeerRenameAndTunnelEndpoint(): Promise<void> {
  const endpointCallbacks: Array<{ peerId: string; endpoint: Record<string, unknown> }> = [];
  const disconnectedPeers: string[] = [];
  const controller = new HostSessionController(
    { roomId: '9999', playerName: 'HostTest' },
    {
      onRemoteTunnelEndpoint: (endpoint, peerId) => {
        endpointCallbacks.push({ peerId, endpoint });
      },
      onPeerDisconnected: (peerId) => {
        disconnectedPeers.push(peerId);
      },
    }
  );

  // Simulate prewarmed peer_1 channel created by initializeChannel(), then renamed to peer_real_42
  const prewarmed = controller._createPeerChannel('peer_1', 'Player 2', 'player');
  controller.peerChannels.delete('peer_1');
  controller.peerRoles.delete('peer_1');
  controller.peerReadyStates.delete('peer_1');
  prewarmed.peerId = 'peer_real_42';
  controller.peerChannels.set('peer_real_42', prewarmed);
  controller.peerRoles.set('peer_real_42', 'player');
  controller.peerReadyStates.set('peer_real_42', { ready: true, arenaLoaded: true });

  prewarmed.onRemoteTunnelEndpoint?.({ kind: 'rust-upnp-udp', localPort: 50001 });
  assert.equal(endpointCallbacks.length, 1);
  assert.equal(endpointCallbacks[0].peerId, 'peer_real_42');

  prewarmed.onDisconnected?.();
  assert.deepEqual(disconnectedPeers, ['peer_real_42']);
  assert.equal(controller.peerReadyStates.has('peer_real_42'), false);
  controller.cleanup();
}

async function testRoomActivitySwitchWireAndEpochOrdering(): Promise<void> {
  const hostController = new HostSessionController({ roomId: '8888', playerName: 'HostSync' });
  const hostCh = hostController._createPeerChannel('peer_client', 'Client1', 'player');
  const clientTransport = new DataChannelTransport({
    simulator: new NetworkSimulator(),
    signaling: new CrossTabSignaling(),
  });

  // Wire hostCh control/data output directly into clientTransport
  const fakeHostDc = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: unknown) => {
      clientTransport.handleIncomingMessage(data);
    },
    close: () => {},
  } as unknown as RTCDataChannel;
  hostCh.dataChannel = fakeHostDc;
  hostCh.isOpen = true;

  const reconciler = new PredictionReconciler(
    {} as never,
    {
      sendInput: () => true,
      receiveStates: () => [],
      drainTransportEvents: () => clientTransport.drainTransportEvents(),
      measureLatency: () => {},
      rttMs: 0,
    } as never,
    { playerCarIndex: 1 }
  );

  const observed: Array<{ activityId: string; epoch: number }> = [];
  reconciler.onRoomActivitySwitch = (payload) => {
    observed.push({
      activityId: String(payload.activityId),
      epoch: Number(payload.epoch ?? 0),
    });
  };

  assert.equal(
    hostController.broadcastRoomActivitySwitch({ activityId: 'multiplayer_training' }),
    1
  );
  assert.equal(hostController.broadcastRoomActivitySwitch({ activityId: 'replay' }), 1);
  // Inject stale out-of-order epoch 1 after epoch 2 -> must be ignored by PredictionReconciler
  clientTransport.handleIncomingMessage(
    JSON.stringify({ type: 'room_activity_switch', activityId: 'freeplay', epoch: 1 })
  );

  reconciler.reconcile(performance.now());
  assert.deepEqual(observed, [
    { activityId: 'multiplayer_training', epoch: 1 },
    { activityId: 'replay', epoch: 2 },
  ]);
  assert.equal(hostController.activeRoomActivity?.activityId, 'replay');
  hostController.cleanup();
}

async function testReliableTunnelFramerOutOfOrderAndMultiDrop(): Promise<void> {
  const reassembled: Uint8Array[] = [];
  const wireFrames: Uint8Array[] = [];
  let receiverFramer: ReliableTunnelFramer;

  const senderFramer = new ReliableTunnelFramer({
    sendRaw: (frame) => {
      wireFrames.push(new Uint8Array(frame));
      return true;
    },
    onReliablePayload: () => {},
  });
  receiverFramer = new ReliableTunnelFramer({
    sendRaw: (ackFrame) => {
      senderFramer.handleIncomingFrame(ackFrame);
      return true;
    },
    onReliablePayload: (payload) => {
      reassembled.push(payload);
    },
  });

  // Build >3000B payload (multi-chunk)
  const bigPayload = new Uint8Array(3200);
  for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = i % 251;
  assert.equal(senderFramer.sendReliable(bigPayload), true);
  assert.ok(wireFrames.length >= 3, 'Expected multi-chunk framing for 3200B payload');

  // Drop first frame, deliver remaining frames in reverse (out-of-order)
  for (let i = wireFrames.length - 1; i >= 1; i--) {
    receiverFramer.handleIncomingFrame(wireFrames[i]);
  }
  assert.equal(reassembled.length, 0, 'Should not reassemble while chunk 0 is missing');

  // Wait for retransmit of dropped chunk 0 via sender timer
  await new Promise((r) => setTimeout(r, 180));
  for (const frame of wireFrames) {
    receiverFramer.handleIncomingFrame(frame);
  }
  assert.equal(reassembled.length, 1);
  assert.deepEqual(reassembled[0], bigPayload);
  senderFramer.dispose();
  receiverFramer.dispose();
}

async function testPureCsrSyncAllAndDualInputGating(): Promise<void> {
  // 1. HostSessionController.broadcastGlobalWorkspace -> DataChannelTransport + late-join replay
  const hostController = new HostSessionController({ roomId: '7777', playerName: 'HostCSR' });
  const hostCh = hostController._createPeerChannel('peer_csr_1', 'ClientCSR', 'player');
  const clientTransport = new DataChannelTransport({
    simulator: new NetworkSimulator(),
    signaling: new CrossTabSignaling(),
  });
  const receivedBroadcasts: Array<Record<string, unknown>> = [];
  clientTransport.onGlobalWorkspaceBroadcast = (msg) => {
    receivedBroadcasts.push(msg);
  };
  hostCh.dataChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: unknown) => {
      clientTransport.handleIncomingMessage(data);
    },
    close: () => {},
  } as unknown as RTCDataChannel;
  hostCh.isOpen = true;

  const sentCount = hostController.broadcastGlobalWorkspace({
    epoch: 3,
    tick: 120,
    menuRoute: 'dev-under-development',
    openFloatingWindows: [{ id: 'dev-room-sync', isOpen: true, isMinimized: false }],
    telestratorPermission: 'host_only',
    playbackPaused: false,
    pausedAtTick: 0,
    pauseHeartbeatHz: 2,
    clientInputEnabled: false,
    followHostWorkspace: true,
    arenaPreset: 'throwback',
  });
  assert.equal(sentCount, 1);
  assert.equal(receivedBroadcasts.length, 1);
  assert.equal(receivedBroadcasts[0].clientInputEnabled, false);
  assert.equal(receivedBroadcasts[0].followHostWorkspace, true);
  assert.equal(receivedBroadcasts[0].arenaPreset, 'throwback');

  // Late-joining peer must receive activeGlobalWorkspace on onConnected
  const lateTransport = new DataChannelTransport({
    simulator: new NetworkSimulator(),
    signaling: new CrossTabSignaling(),
  });
  const lateBroadcasts: Array<Record<string, unknown>> = [];
  lateTransport.onGlobalWorkspaceBroadcast = (msg) => lateBroadcasts.push(msg);
  const lateCh = hostController._createPeerChannel('peer_csr_2', 'LateClient', 'player');
  lateCh.dataChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (data: unknown) => lateTransport.handleIncomingMessage(data),
    close: () => {},
  } as unknown as RTCDataChannel;
  lateCh.isOpen = true;
  await lateCh.onConnected?.();
  assert.equal(lateBroadcasts.length, 1);
  assert.equal(lateBroadcasts[0].arenaPreset, 'throwback');

  // 2. Client spectateWorkspaceStore auto-mirroring & restore on exit
  const wsStore = useSpectateWorkspaceStore.getState();
  let localRoute: string | null = 'home';
  let localWins = [{ id: 'network-monitor', isOpen: true, isMinimized: false }];
  const sanitized = sanitizeGlobalWorkspaceBroadcast(receivedBroadcasts[0]);
  wsStore.applyHostWorkspaceBroadcast(
    sanitized,
    (route, wins) => {
      localRoute = route;
      localWins = wins;
    },
    () => ({ menuRoute: localRoute, windows: localWins })
  );
  const afterMirror = useSpectateWorkspaceStore.getState();
  assert.equal(afterMirror.isSpectating, true);
  assert.equal(afterMirror.spectateMode, 'spectate_mirror');
  assert.equal(afterMirror.isReadOnlyLocked, true);
  assert.equal(afterMirror.clientInputEnabled, false);
  assert.equal(afterMirror.arenaPreset, 'throwback');
  assert.equal(localRoute, 'dev-under-development');
  assert.equal(localWins[0].id, 'dev-room-sync');

  afterMirror.setSpectatingActive(false, undefined, (route, wins) => {
    localRoute = route;
    localWins = wins;
  });
  assert.equal(localRoute, 'home');
  assert.equal(localWins[0].id, 'network-monitor');
  useSpectateWorkspaceStore.getState().setFollowHostWorkspace(false);
  useSpectateWorkspaceStore.getState().setClientInputEnabled(true);

  // 3. Client PredictionReconciler.sampleAndPredictInput gating
  let simTick = 10;
  const mockSim = {
    getHeaderView: () => ({ tickCount: simTick }),
    saveStateSlot: () => {},
    getStateSnapshot: () => new Float32Array(0),
    getCarSnapshot: () => null,
    getBallSnapshot: () => null,
  };
  const reconciler = new PredictionReconciler(
    mockSim as never,
    {
      sendInput: () => true,
      receiveStates: () => [],
      measureLatency: () => {},
      rttMs: 0,
    } as never,
    { playerCarIndex: 1 }
  );
  reconciler.setClientInputEnabled(false);
  const gatedCtrl = reconciler.sampleAndPredictInput(1, {
    throttle: 1,
    steer: 0.8,
    pitch: -0.5,
    yaw: 0.4,
    roll: 0.2,
    jump: true,
    boost: true,
    handbrake: true,
  });
  assert.equal(gatedCtrl.throttle, 0);
  assert.equal(gatedCtrl.steer, 0);
  assert.equal(gatedCtrl.boost, false);
  assert.equal(gatedCtrl.jump, false);

  simTick = 11;
  reconciler.setClientInputEnabled(true);
  const activeCtrl = reconciler.sampleAndPredictInput(1, {
    throttle: 1,
    steer: -0.5,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jump: false,
    boost: true,
    handbrake: false,
  });
  assert.equal(activeCtrl.throttle, 1);
  assert.equal(activeCtrl.steer, -0.5);
  assert.equal(activeCtrl.boost, true);

  // 4. Server NetworkDataHandler + HostWorkerMessageRouter input gating
  const sessionManager = new EstablishedSessionManager();
  sessionManager.registerSession('host', { entityId: 0, role: 'player', playerName: 'Host' });
  sessionManager.registerSession('peer_csr_1', {
    entityId: 1,
    role: 'player',
    playerName: 'ClientCSR',
  });
  const pushedInputs: Array<{ entityId: number; count: number }> = [];
  const mockPhysics = {
    currentTick: 20,
    pushRedundantInputs: (entityId: number, history: unknown[]) => {
      pushedInputs.push({ entityId, count: history.length });
    },
  };
  const dataHandler = new NetworkDataHandler({
    sessionManager,
    physicsManager: mockPhysics as never,
  });
  const workerReplies: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const workerCtx = {
    dataHandler,
    physicsManager: mockPhysics as never,
    sessionManager,
    postEnvelope: (env: { type: string; payload: Record<string, unknown> }) => {
      workerReplies.push(env);
    },
  };

  routeProtocolMessageInWorker(workerCtx as never, {
    type: HOST_WORKER_MSG_TYPES.SET_CLIENT_INPUT_ENABLED,
    clientInputEnabled: false,
  });
  assert.equal(dataHandler.clientInputEnabled, false);

  const clientPkt = InputPacketCodec.encode(
    1,
    20,
    [
      {
        tick: 20,
        controls: {
          throttle: 1,
          steer: 0.5,
          pitch: 0,
          yaw: 0,
          roll: 0,
          jump: false,
          boost: true,
          handbrake: false,
        },
      },
    ],
    1000
  );
  const hostPkt = InputPacketCodec.encode(
    0,
    20,
    [
      {
        tick: 20,
        controls: {
          throttle: 1,
          steer: 0,
          pitch: 0,
          yaw: 0,
          roll: 0,
          jump: false,
          boost: false,
          handbrake: false,
        },
      },
    ],
    1000
  );
  routeProtocolMessageInWorker(workerCtx as never, {
    type: 'clientInput',
    channelId: 'peer_csr_1',
    packet: clientPkt,
  });
  assert.equal(
    pushedInputs.length,
    0,
    'Remote client input must be ignored when clientInputEnabled=false'
  );

  routeProtocolMessageInWorker(workerCtx as never, {
    type: 'clientInput',
    channelId: 'host',
    packet: hostPkt,
  });
  assert.equal(
    pushedInputs.length,
    1,
    'Host input must still be accepted when clientInputEnabled=false'
  );

  routeProtocolMessageInWorker(workerCtx as never, {
    type: HOST_WORKER_MSG_TYPES.SET_CLIENT_INPUT_ENABLED,
    clientInputEnabled: true,
  });
  routeProtocolMessageInWorker(workerCtx as never, {
    type: 'clientInput',
    channelId: 'peer_csr_1',
    packet: clientPkt,
  });
  assert.equal(
    pushedInputs.length,
    2,
    'Remote client input must resume when clientInputEnabled=true'
  );

  // 5. applyClientRoomActivitySwitch keeps Client in lightweight freeplay CSR shell
  const modeCalls: string[] = [];
  const envPipeline = createOnlineSessionBridgePort(
    {
      match: null,
      trainingOptions: {},
      modeManager: {
        setMode: (m: string) => modeCalls.push(m),
        getActiveMode: () => ({ id: 'freeplay' }),
      },
      podiumController: null,
      replayTimelineController: null,
      isBotMatch: false,
      releaseGoalReplayCameraOverride: () => {},
    } as never,
    () => ({}) as never,
    () => ({}) as never
  );
  envPipeline.applyClientRoomActivitySwitch(reconciler, {
    activityId: 'multiplayer_training',
    arenaPreset: 'throwback',
    clientInputEnabled: false,
  });
  assert.equal(reconciler.replayPlaybackMode, false);
  assert.equal(reconciler.clientInputEnabled, false);
  assert.equal(modeCalls.includes('training'), false);
  assert.equal(modeCalls.includes('static-training-pack'), false);

  envPipeline.applyClientRoomActivitySwitch(reconciler, {
    activityId: 'replay',
  });
  assert.equal(reconciler.replayPlaybackMode, true);
  assert.equal(modeCalls.includes('replay'), false);
  assert.equal(modeCalls.includes('replay-viewer'), false);

  envPipeline.applyClientRoomActivitySwitch(reconciler, {
    activityId: 'match',
    clientInputEnabled: true,
  });
  assert.equal(reconciler.replayPlaybackMode, false);
  assert.equal(reconciler.clientInputEnabled, true);
  assert.equal(modeCalls.includes('match'), false);

  hostController.cleanup();
}

async function testTelestratorFullLinkSyncAndPermissions(): Promise<void> {
  // 1. Binary codec round-trip for Undo & Clear
  const undoBytes = encodeTelestratorUndo({ authorId: 'peer_a', strokeId: 's_123' });
  assert.equal(getTelestratorWireMsgType(undoBytes), TELESTRATOR_WIRE_MSG_TYPE.STROKE_UNDO);
  const decodedUndo = decodeTelestratorUndo(undoBytes);
  assert.equal(decodedUndo?.authorId, 'peer_a');
  assert.equal(decodedUndo?.strokeId, 's_123');

  const clearBytes = encodeTelestratorClear({ scope: 'all', authorId: 'host' });
  assert.equal(getTelestratorWireMsgType(clearBytes), TELESTRATOR_WIRE_MSG_TYPE.STROKE_CLEAR);
  const decodedClear = decodeTelestratorClear(clearBytes);
  assert.equal(decodedClear?.scope, 'all');
  assert.equal(decodedClear?.authorId, 'host');

  // 2. Dual-store linkage & isCameraSynced gate fix
  useTelestratorStore.getState().setHostRole(false, 'peer_a');
  useTelestratorStore.getState().setIsCameraSynced(false);
  useTelestratorStore.getState().setAllowClientDrawing(false);
  assert.equal(canTelestratorDrawNow(useTelestratorStore.getState()), false);
  assert.equal(canLocalDrawInTelestrator(useTelestratorStore.getState()), false);

  useSpectateWorkspaceStore.getState().applyHostWorkspaceBroadcast(
    sanitizeGlobalWorkspaceBroadcast({
      epoch: 2,
      tick: 100,
      menuRoute: null,
      openFloatingWindows: [],
      telestratorPermission: 'everyone',
      clientInputEnabled: false,
      followHostWorkspace: false,
      arenaPreset: 'standard',
    })
  );
  assert.equal(useSpectateWorkspaceStore.getState().telestratorPermission, 'everyone');
  assert.equal(useTelestratorStore.getState().allowClientDrawing, true);
  assert.equal(useTelestratorStore.getState().isCameraSynced, true);
  assert.equal(canTelestratorDrawNow(useTelestratorStore.getState()), true);
  assert.equal(canLocalDrawInTelestrator(useTelestratorStore.getState()), true);

  // 3. Full P2P 0x05 transport loop: HostSessionController + 2 Clients (peer_a, peer_b)
  const hostManager = new TelestratorManager();
  const peerAManager = new TelestratorManager();
  const peerBManager = new TelestratorManager();

  const hostController = new HostSessionController(
    { roomId: 'room-tele-1', playerName: 'Host' },
    {
      onTelestratorBytes: (_peerId, bytes) => {
        applyRemoteTelestratorWireBytes(hostManager, bytes, () => {});
      },
    }
  );

  const hostChA = hostController._createPeerChannel('peer_a', 'Alice', 'player');
  const hostChB = hostController._createPeerChannel('peer_b', 'Bob', 'spectator');
  const clientTransportA = new DataChannelTransport({
    simulator: new NetworkSimulator({}),
    signaling: new CrossTabSignaling({ roomId: 'room-tele-1' }),
  });
  const clientTransportB = new DataChannelTransport({
    simulator: new NetworkSimulator({}),
    signaling: new CrossTabSignaling({ roomId: 'room-tele-1' }),
  });

  const wirePair = (hostCh: typeof hostChA, clientT: DataChannelTransport) => {
    const dcToClient = {
      readyState: 'open',
      send: (payload: unknown) => clientT.handleIncomingMessage(payload as never),
      close: () => {},
    } as unknown as RTCDataChannel;
    const dcToHost = {
      readyState: 'open',
      send: (payload: unknown) => hostCh.transport.handleIncomingMessage(payload as never),
      close: () => {},
    } as unknown as RTCDataChannel;
    hostCh.dataChannel = dcToClient;
    hostCh.isOpen = true;
    clientT.dataChannel = dcToHost;
    clientT.isWebRTCOpen = true;
  };
  wirePair(hostChA, clientTransportA);
  wirePair(hostChB, clientTransportB);

  const clientAAcks: Array<{ strokeId: string; matched: boolean }> = [];
  const clientAPermSyncs: boolean[] = [];
  clientTransportA.onTelestratorBytes = (bytes) => {
    const t = getTelestratorWireMsgType(bytes);
    if (t === TELESTRATOR_WIRE_MSG_TYPE.STROKE_HASH_ACK) {
      const ack = decodeTelestratorHashAck(bytes);
      if (ack) clientAAcks.push({ strokeId: ack.strokeId, matched: ack.matched });
    } else if (t === TELESTRATOR_WIRE_MSG_TYPE.HOST_PERMISSION_SYNC) {
      const sync = decodeHostPermissionSync(bytes);
      if (sync) clientAPermSyncs.push(sync.allowClientDrawing);
    }
    applyRemoteTelestratorWireBytes(peerAManager, bytes, () => {});
  };
  clientTransportB.onTelestratorBytes = (bytes) => {
    applyRemoteTelestratorWireBytes(peerBManager, bytes, () => {});
  };

  const makeStroke = (id: string, authorId: string, seq: number): TelestratorStroke => {
    const pts: TelestratorPoint[] = [
      { x: 0, y: 100, z: 20, nx: 0, ny: 0, nz: 1 },
      { x: 200, y: 300, z: 20, nx: 0, ny: 0, nz: 1 },
    ];
    const hash = computeStrokeHash('solid', 'yellow', 0, 0.9, 10, 20, 12, pts);
    return {
      id,
      authorId,
      strokeSeq: seq,
      tool: 'solid',
      colorId: 'yellow',
      presetIndex: 0,
      opacity: 0.9,
      widthRefPx: 10,
      arrowLengthRefPx: 20,
      arrowWidthRefPx: 12,
      camPos: { x: 0, y: -1500, z: 400 },
      camForward: { x: 0, y: 1, z: -0.2 },
      camFovDeg: 90,
      createdTick: 100,
      fadeDurationTicks: 0,
      points: pts,
      hash,
    };
  };

  // 3a. When host_only, Peer A stroke must be blocked & rejected with HOST_PERMISSION_SYNC
  hostController.broadcastGlobalWorkspace({
    epoch: 1,
    tick: 10,
    menuRoute: null,
    openFloatingWindows: [],
    telestratorPermission: 'host_only',
  });
  const blockedStroke = makeStroke('stroke_blocked', 'peer_a', 1);
  assert.equal(
    clientTransportA.sendTelestratorBytes(encodeTelestratorStroke(blockedStroke, false), true),
    true
  );
  assert.equal(hostManager.getStrokeCount(), 0, 'Host must reject client stroke under host_only');
  assert.equal(peerBManager.getStrokeCount(), 0, 'Peer B must not receive rejected client stroke');
  assert.deepEqual(clientAPermSyncs, [false], 'Peer A must receive HOST_PERMISSION_SYNC(false)');

  // 3b. Switch to everyone: Peer A draft + commit -> Host + Peer B receive + Peer A gets STROKE_HASH_ACK
  hostController.broadcastGlobalWorkspace({
    epoch: 2,
    tick: 20,
    menuRoute: null,
    openFloatingWindows: [],
    telestratorPermission: 'everyone',
  });
  const aliceStroke = makeStroke('stroke_alice_1', 'peer_a', 2);
  peerAManager.addOrReplaceRemoteStroke(aliceStroke);
  clientTransportA.sendTelestratorBytes(encodeTelestratorStroke(aliceStroke, true), false);
  assert.equal(hostManager.getStrokeCount(), 1, 'Host must apply Peer A draft');
  assert.equal(peerBManager.getStrokeCount(), 1, 'Peer B must receive relayed Peer A draft');

  clientTransportA.sendTelestratorBytes(encodeTelestratorStroke(aliceStroke, false), true);
  assert.equal(hostManager.getStrokeCount(), 1, 'Host must replace draft with committed stroke');
  assert.equal(peerBManager.getStrokeCount(), 1, 'Peer B must replace draft with committed stroke');
  assert.equal(clientAAcks.length, 1);
  assert.equal(clientAAcks[0].strokeId, 'stroke_alice_1');
  assert.equal(clientAAcks[0].matched, true);

  // 3c. Peer A undo -> Host & Peer B both remove stroke
  peerAManager.undoOwnStroke('peer_a');
  clientTransportA.sendTelestratorBytes(
    encodeTelestratorUndo({ authorId: 'peer_a', strokeId: 'stroke_alice_1' }),
    true
  );
  assert.equal(hostManager.getStrokeCount(), 0, 'Host must undo Peer A stroke');
  assert.equal(peerBManager.getStrokeCount(), 0, 'Peer B must undo Peer A stroke');

  // 3d. Host draws + Peer A draws -> Peer A tries scope:'all' clear -> Host downgrades to scope:'own'
  const hostStroke = makeStroke('stroke_host_1', 'host', 1);
  hostManager.addOrReplaceRemoteStroke(hostStroke);
  hostController.broadcastTelestratorBytes(encodeTelestratorStroke(hostStroke, false), true);
  assert.equal(peerAManager.getStrokeCount(), 1);
  assert.equal(peerBManager.getStrokeCount(), 1);

  const aliceStroke2 = makeStroke('stroke_alice_2', 'peer_a', 3);
  peerAManager.addOrReplaceRemoteStroke(aliceStroke2);
  clientTransportA.sendTelestratorBytes(encodeTelestratorStroke(aliceStroke2, false), true);
  assert.equal(hostManager.getStrokeCount(), 2);
  assert.equal(peerBManager.getStrokeCount(), 2);

  clientTransportA.sendTelestratorBytes(
    encodeTelestratorClear({ scope: 'all', authorId: 'peer_a' }),
    true
  );
  assert.equal(
    hostManager.getStrokeCount(),
    1,
    'Client clear(all) must only clear own strokes on Host'
  );
  assert.equal(
    peerBManager.getStrokeCount(),
    1,
    'Client clear(all) must only clear own strokes on Peer B'
  );
  assert.equal(hostManager.getAllStrokes()[0].id, 'stroke_host_1');

  // 3e. Host clear(all) clears everything
  hostManager.clearStrokesByScope('all', 'host');
  hostController.broadcastTelestratorBytes(
    encodeTelestratorClear({ scope: 'all', authorId: 'host' }),
    true
  );
  assert.equal(peerAManager.getStrokeCount(), 0);
  assert.equal(peerBManager.getStrokeCount(), 0);

  hostManager.dispose();
  peerAManager.dispose();
  peerBManager.dispose();
  clientTransportA.signaling.destroy();
  clientTransportB.signaling.destroy();
  hostController.cleanup();
}

async function testReplayWatchTogetherAndCameraSync(): Promise<void> {
  bindRuntimeUiPort({
    buildHostWorkspaceBroadcastPayload: (meta?: Record<string, unknown>) =>
      sanitizeGlobalWorkspaceBroadcast(meta),
    captureCameraSyncFromPort: (cam: Record<string, unknown>, follow = true) => {
      const snap =
        cam.isFreeCam && typeof cam.getFreeCamStateSnapshot === 'function'
          ? (cam.getFreeCamStateSnapshot() as {
              eyeThreeJs?: [number, number, number];
              targetThreeJs?: [number, number, number];
            })
          : null;
      return {
        followHostCamera: follow,
        isFreeCam: Boolean(cam.isFreeCam),
        ballCam: typeof cam.ballCam === 'boolean' ? cam.ballCam : true,
        focusedCarIndex: Number(cam.focusedCarIndex) || 0,
        ...(snap?.eyeThreeJs ? { freeCamPosition: snap.eyeThreeJs } : {}),
        ...(snap?.targetThreeJs ? { freeCamLookAt: snap.targetThreeJs } : {}),
      };
    },
  });

  // 1. Setup real MatchSessionAdmin (Pure CSR state-only replay broadcaster)
  const hostSimState = new Float32Array(448);
  const hostPhysicsManager = {
    currentTick: 0,
    sim: {
      state: hostSimState,
      numCars: 2,
      restoreState: (buf: Float32Array) => {
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
  sessionManager.registerSession('peer_replay_1', {
    entityId: 1,
    role: 'player',
    playerName: 'ReplayViewer',
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
  const host = { systemControl };

  // Client PredictionReconciler + lightweight physics/interpolator target
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
  const clientReconciler = new PredictionReconciler(
    clientPhysics as never,
    clientChannel as never,
    {
      localCarIndex: 1,
      interpolator: clientInterpolator as never,
    }
  );
  clientReconciler.onSignals = (signals) => {
    for (const s of signals) {
      if (s?.signalType === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY) {
        clientReconciler.setReplayPlaybackMode(true);
      } else if (s?.signalType === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME) {
        clientReconciler.setReplayPlaybackMode(false);
      }
    }
  };
  clientReconciler.setClientInputEnabled(false);

  // 2. Inject Replay frames via syncReplayFrameToAuthoritativeServer -> enterStateOnlyMode
  const makeReplayFrame = (
    frameIdx: number,
    ballX: number,
    ballY: number,
    ballZ: number,
    car0X: number
  ): Float32Array => {
    const snap = new Float32Array(448);
    snap[SIM_OFFSETS.TICK] = frameIdx;
    snap[SIM_OFFSETS.NUM_CARS] = 2;
    snap[SIM_OFFSETS.BALL + 0] = ballX;
    snap[SIM_OFFSETS.BALL + 1] = ballY;
    snap[SIM_OFFSETS.BALL + 2] = ballZ;
    snap[SIM_OFFSETS.CARS + 0] = car0X;
    snap[SIM_OFFSETS.CARS + 1] = -1200;
    snap[SIM_OFFSETS.CARS + 2] = 17;
    return snap;
  };

  const replayFrames = [
    makeReplayFrame(10, 120.5, -450.25, 310.75, -200.5),
    makeReplayFrame(11, 145.25, -420.5, 340.125, -185.25),
    makeReplayFrame(12, 170.0, -390.75, 365.5, -170.0),
  ];

  // Test very first frame: SYS_CTRL_STATE_ONLY + stateSnapshot in the same packet
  for (let i = 0; i < replayFrames.length; i++) {
    const srcSnap = replayFrames[i];
    syncReplayFrameToAuthoritativeServer(
      {
        physics: {
          saveCompactState: () => srcSnap,
          getHeaderView: () => ({ tickCount: srcSnap[0] }),
        },
        authoritativeServer: {
          enterStateOnlyMode: (snap, tick) => host.systemControl.enterStateOnlyMode(snap, tick),
        },
      },
      srcSnap[0]
    );

    const frameBytes = host.systemControl.stepStateOnlyFrameIfActive();
    assert.ok(frameBytes && frameBytes.byteLength > 0, `Frame ${i} must emit state-only packet`);
    const tailoredBytes = sessionManager.buildClientPacket('peer_replay_1', frameBytes);
    assert.ok(
      tailoredBytes && tailoredBytes.byteLength > 0,
      `Frame ${i} must build tailored client packet`
    );

    clientChannel.inboundQueue.push(tailoredBytes);
    clientReconciler.reconcile(1000 + i * 8.333);

    assert.equal(
      clientReconciler.replayPlaybackMode,
      true,
      'Client must enter replayPlaybackMode on first SYS_CTRL_STATE_ONLY'
    );
    assert.ok(
      clientReconciler.drainedReplayPackets.length > 0,
      `Frame ${i} must be pushed to drainedReplayPackets`
    );

    const pkt =
      clientReconciler.drainedReplayPackets[clientReconciler.drainedReplayPackets.length - 1];
    assert.ok(pkt?.stateSnapshot, 'Packet must include stateSnapshot');
    applyReplayFrameToEngine(clientPhysics, pkt.stateSnapshot, clientInterpolator);
    clientReconciler.drainedReplayPackets.length = 0;

    const ballErrX = Math.abs(
      clientInterpolator.currState[SIM_OFFSETS.BALL + 0] - srcSnap[SIM_OFFSETS.BALL + 0]
    );
    const ballErrY = Math.abs(
      clientInterpolator.currState[SIM_OFFSETS.BALL + 1] - srcSnap[SIM_OFFSETS.BALL + 1]
    );
    const ballErrZ = Math.abs(
      clientInterpolator.currState[SIM_OFFSETS.BALL + 2] - srcSnap[SIM_OFFSETS.BALL + 2]
    );
    const car0ErrX = Math.abs(
      clientInterpolator.currState[SIM_OFFSETS.CARS + 0] - srcSnap[SIM_OFFSETS.CARS + 0]
    );
    assert.ok(
      ballErrX < 1e-3 && ballErrY < 1e-3 && ballErrZ < 1e-3,
      `Replay CSR ball sync error must be < 1e-3 (got ${ballErrX}, ${ballErrY}, ${ballErrZ})`
    );
    assert.ok(car0ErrX < 1e-3, `Replay CSR car sync error must be < 1e-3 (got ${car0ErrX})`);
  }

  // 3. Test Pause / Seek / Camera Sync over GlobalWorkspaceBroadcast + P2P DataChannelTransport
  const roomId = 'room-replay-sync-1';
  const hostController = new HostSessionController({
    roomId,
    playerName: 'Host',
  });
  const hostCh = hostController._createPeerChannel('peer_replay_1', 'ReplayViewer', 'spectator');
  const clientTransport = new DataChannelTransport({
    simulator: new NetworkSimulator({}),
    signaling: new CrossTabSignaling({ roomId }),
  });
  const dcToClient = {
    readyState: 'open',
    send: (payload: unknown) => clientTransport.handleIncomingMessage(payload as never),
    close: () => {},
  } as unknown as RTCDataChannel;
  const dcToHost = {
    readyState: 'open',
    send: (payload: unknown) => hostCh.transport.handleIncomingMessage(payload as never),
    close: () => {},
  } as unknown as RTCDataChannel;
  hostCh.dataChannel = dcToClient;
  hostCh.isOpen = true;
  clientTransport.dataChannel = dcToHost;
  clientTransport.isWebRTCOpen = true;

  const clientReceivedWorkspaces: Array<Record<string, unknown>> = [];
  const clientCamera = {
    isFreeCam: false,
    ballCam: true,
    focusedCarIndex: 0,
    freeCamPos: null as [number, number, number] | null,
    freeCamLook: null as [number, number, number] | null,
    setFreeCam(en: boolean) {
      this.isFreeCam = en;
    },
    setFocusedCarIndex(idx: number) {
      this.focusedCarIndex = idx;
    },
    setFreeCamPose(pos: [number, number, number], look: [number, number, number] = [0, 80, 0]) {
      this.isFreeCam = true;
      this.freeCamPos = pos;
      this.freeCamLook = look;
    },
  };
  clientTransport.onGlobalWorkspaceBroadcast = (msg) => {
    clientReceivedWorkspaces.push(msg);
    const payload = sanitizeGlobalWorkspaceBroadcast(msg);
    useSpectateWorkspaceStore.getState().applyHostWorkspaceBroadcast(payload);
    const camSync = payload.cameraSync;
    if (camSync && camSync.followHostCamera) {
      if (camSync.isFreeCam && camSync.freeCamPosition && camSync.freeCamLookAt) {
        clientCamera.setFreeCamPose(camSync.freeCamPosition, camSync.freeCamLookAt);
      } else {
        clientCamera.setFreeCam(Boolean(camSync.isFreeCam));
        clientCamera.setFocusedCarIndex(camSync.focusedCarIndex);
        clientCamera.ballCam = camSync.ballCam;
      }
    }
  };

  const activitySwitches: Array<Record<string, unknown>> = [];
  const hostCamera = {
    isFreeCam: false,
    ballCam: false,
    focusedCarIndex: 2,
    getFreeCamStateSnapshot: () => ({
      eyeThreeJs: [100, 220, -450] as [number, number, number],
      targetThreeJs: [0, 80, 0] as [number, number, number],
    }),
  };
  const mockHostRuntime = {
    camera: hostCamera,
    multiplayerSession: {
      isHosting: true,
      broadcastRoomActivitySwitch: (opts: Record<string, unknown>) => {
        activitySwitches.push(opts);
      },
      broadcastGlobalWorkspace: (payload: Record<string, unknown>) =>
        hostController.broadcastGlobalWorkspace(payload),
    },
  };

  syncReplayWorkspaceToOnlineRoom(mockHostRuntime, {
    active: true,
    playbackPaused: true,
    pausedAtTick: 42,
    switchActivity: true,
    replayId: 'test-match.RCReplay',
  });

  assert.equal(activitySwitches.length, 1);
  assert.equal(activitySwitches[0].activityId, 'replay');
  assert.equal(clientReceivedWorkspaces.length, 1);
  const ws = useSpectateWorkspaceStore.getState();
  assert.equal(ws.playbackPaused, true);
  assert.equal(ws.pausedAtTick, 42);
  assert.equal(ws.followHostCamera, true);
  assert.equal(clientCamera.isFreeCam, false);
  assert.equal(clientCamera.focusedCarIndex, 2);
  assert.equal(clientCamera.ballCam, false);

  // 4. Test FreeCam pose sync & ReplayOnlineHeartbeatTracker immediate sync on camera change
  const tracker = new ReplayOnlineHeartbeatTracker();
  const sent1 = tracker.maybeSync(
    mockHostRuntime,
    { playbackPaused: true, pausedAtTick: 42, pauseHeartbeatHz: 2 },
    1000
  );
  assert.equal(sent1, true, 'First heartbeat must emit');
  const sentThrottled = tracker.maybeSync(
    mockHostRuntime,
    { playbackPaused: true, pausedAtTick: 42, pauseHeartbeatHz: 2 },
    1100
  );
  assert.equal(sentThrottled, false, 'Heartbeat within 500ms without camera change must throttle');

  hostCamera.isFreeCam = true;
  const sentOnCamChange = tracker.maybeSync(
    mockHostRuntime,
    { playbackPaused: true, pausedAtTick: 42, pauseHeartbeatHz: 2 },
    1120
  );
  assert.equal(
    sentOnCamChange,
    true,
    'Camera mode change must bypass throttle and sync immediately'
  );
  assert.equal(clientCamera.isFreeCam, true);
  assert.deepEqual(clientCamera.freeCamPos, [100, 220, -450]);
  assert.deepEqual(clientCamera.freeCamLook, [0, 80, 0]);

  clientTransport.signaling.destroy();
  hostController.cleanup();
}

async function testCustomTrainingPackAndRoomMatchAutoPull(): Promise<void> {
  // Part A: Custom Training Pack (training_shot_reset + stateSummary metadata + Client no-RCDPack sync + input toggle)
  let lastBallState: Record<string, unknown> | null = null;
  const lastCarStates = new Map<number, Record<string, unknown>>();
  let goalLatchResets = 0;
  let boostPadResets = 0;
  const unlimitedBoostByCar = new Map<number, boolean>();

  const mockSim = {
    setBallState: (s: Record<string, unknown>) => {
      lastBallState = s;
    },
    setCarState: (carIdx: number, s: Record<string, unknown>) => {
      lastCarStates.set(carIdx, s);
    },
    resetBoostPads: () => {
      boostPadResets++;
    },
    setUnlimitedBoost: () => {},
    setCarUnlimitedBoost: (carIdx: number, enabled: boolean) => {
      unlimitedBoostByCar.set(carIdx, enabled);
    },
    setCarBoostCollectable: () => {},
    getCarStateView: () => ({ isOnGround: true }),
    resetKickoff: () => {},
    saveCompactState: () => new Float32Array(16),
    restoreState: () => {},
  };

  const activeCars = new Set<number>([0, 1]);
  const mockPhysicsManager = {
    sim: mockSim,
    activeCarIndices: activeCars,
    currentTick: 100,
    isPaused: false,
    inputBuffer: { setLobbyMode: () => {} },
    resetGoalLatch: () => {
      goalLatchResets++;
    },
    resetKickoff: () => {},
    setInputMask: () => {},
    restoreSolidCollisions: () => {},
    applySignal: () => {},
    registerCarEntity: (idx: number) => {
      activeCars.add(idx);
    },
    unregisterCarEntity: (idx: number) => {
      activeCars.delete(idx);
    },
    setTrainingBoostConfig: (cfg: MultiplayerTrainingConfig | null) => {
      if (cfg) {
        applyTrainingBoostPolicyToSim(mockSim, activeCars, cfg);
      }
    },
  };

  const sessionManager = new EstablishedSessionManager(null);
  sessionManager.registerSession('host', { entityId: 0, playerName: 'CoachHost' });
  sessionManager.registerSession('peer_client_1', { entityId: 1, playerName: 'Trainee1' });
  sessionManager.registerSession('peer_client_2', { entityId: 2, playerName: 'Trainee2' });

  const domain = new MatchDomainState({
    roomId: 'room-step4-1',
    gameMode: '2v2',
    botFillMode: 'no_bots',
  });
  let nextEntityId = 0;
  const matchManager = {
    domain,
    sessionManager,
    getSnapshot: () =>
      domain.buildSessionSnapshot(domain.buildRosterEnvelope(sessionManager).roster),
    roster: {
      players: domain.players,
      spectators: domain.spectators,
      setGameMode: (gm: string, dur?: number | null) => {
        domain.applyRosterPolicyConfig({ gameMode: gm, durationSeconds: dur });
      },
      assignPlayerSlot: (sid: string, name: string, role = 'player', team = 0) => {
        if (role === 'spectator') {
          domain.spectators.set(sid, {
            sessionId: sid,
            name,
            role: 'spectator',
            pingMs: 0,
          } as never);
          return null;
        }
        const slot = {
          sessionId: sid,
          entityId: nextEntityId++,
          team,
          preferredTeam: team,
          name,
          role: 'player',
          spawnSlot: nextEntityId - 1,
          visualId: 'octane',
          visualIndex: 0,
          hitboxId: 'hitbox-octane',
          hitboxIndex: 0,
          colorSlot: 0,
          isBot: false,
          ready: false,
          arenaLoaded: false,
        };
        domain.players.set(sid, slot as never);
        return slot;
      },
      switchPlayerRoleOrTeam: (sid: string, role: string, team: number) => {
        if (role === 'player') {
          domain.spectators.delete(sid);
          const existing = domain.players.get(sid);
          if (existing) {
            existing.team = team;
            existing.role = 'player';
          } else {
            matchManager.roster.assignPlayerSlot(sid, sid, 'player', team);
          }
        }
      },
      broadcastRosterUpdate: () => {},
    },
    lifecycle: {
      get state() {
        return domain.state;
      },
      startTrainingMode: (opts: Record<string, unknown> = {}) => {
        domain.applyLobbyOrTrainingTransition('training_start', opts);
      },
      startMatch: (dur?: number) => {
        domain.resetForMatchStart(dur);
        domain.beginKickoffPhase(360);
      },
    },
  };
  matchManager.roster.assignPlayerSlot('host', 'CoachHost', 'player', 0);
  // Simulate peer_client_1 initially in CSR spectator state and peer_client_2 only in sessionManager
  matchManager.roster.assignPlayerSlot('peer_client_1', 'Trainee1', 'spectator', 0);

  let serverClientInputEnabled = false;
  const mockDataHandler = {
    setClientInputEnabled: (enabled: boolean) => {
      serverClientInputEnabled = enabled;
    },
  };

  const workerCtx: Record<string, unknown> = {
    matchManager,
    physicsManager: mockPhysicsManager,
    dataHandler: mockDataHandler,
    orchestrator: new RoomActivityOrchestrator(),
  };

  const workerReplies: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const reply = (t: string, p: unknown) => {
    workerReplies.push({ type: t, payload: (p ?? {}) as Record<string, unknown> });
  };

  // 1. Switch to multiplayer_training with pack metadata (no local .RCDPack on client)
  routeActivityAndInputMessage(
    workerCtx as never,
    HOST_WORKER_MSG_TYPES.ROOM_ACTIVITY_SWITCH,
    {
      activityId: ACTIVITY_IDS.MULTIPLAYER_TRAINING,
      clientInputEnabled: false,
      stateSummary: {
        trainingPackId: 'aerial-pack-01',
        packName: 'Aerial Redirects',
        shotIndex: 0,
        totalShots: 4,
        shotName: 'Backboard Read',
        boostPolicy: 'unlimited',
        ballPose: { pos: [0, 2000, 600], vel: [0, -300, 100] },
        carPose: { carIndex: 0, pos: [0, -1500, 17], boost: 100 },
      },
    },
    reply,
    () => {}
  );

  assert.equal(serverClientInputEnabled, false, 'Coach mode starts with client input gated');
  assert.deepEqual((lastBallState as unknown as { pos: number[] })?.pos, [0, 2000, 600]);
  assert.equal(unlimitedBoostByCar.get(0), true);

  // 2. Dispatch training_shot_reset via ACTIVITY_CONTROL
  routeActivityAndInputMessage(
    workerCtx as never,
    HOST_WORKER_MSG_TYPES.ACTIVITY_CONTROL,
    {
      controlType: 'training_shot_reset',
      controlPayload: {
        shotIndex: 1,
        shotName: 'Double Tap',
        ballPose: { pos: [120, 3200, 900], vel: [0, 100, 250], angVel: [0, 0, 1] },
        carPose: { carIndex: 1, pos: [-400, -900, 17], rot: [0, 1.57, 0], boost: 85 },
      },
    },
    reply,
    () => {}
  );

  const actReply = workerReplies.find((r) => r.type === HOST_WORKER_MSG_TYPES.ACTIVITY_CONTROL);
  assert.ok(actReply, 'ACTIVITY_CONTROL reply must be emitted');
  assert.equal(actReply.payload.handled, true);
  const csrSummary = (actReply.payload.csr as { uiSummary: Record<string, unknown> }).uiSummary;
  assert.equal(csrSummary.trainingPackId, 'aerial-pack-01');
  assert.equal(csrSummary.packName, 'Aerial Redirects');
  assert.equal(csrSummary.shotIndex, 1);
  assert.equal(csrSummary.shotName, 'Double Tap');
  assert.equal(csrSummary.shotResetSeq, 1);
  assert.deepEqual((lastBallState as unknown as { pos: number[] })?.pos, [120, 3200, 900]);
  assert.deepEqual((lastCarStates.get(1) as { pos: number[] })?.pos, [-400, -900, 17]);
  assert.ok(goalLatchResets >= 2, 'training_shot_reset must reset goal latch');
  assert.ok(boostPadResets >= 2, 'training_shot_reset must reset boost pads');

  // 3. Client receives ROOM_ACTIVITY_SWITCH without any local .RCDPack file
  const mockOnlineSession: Record<string, unknown> = { activeRoomActivity: 'freeplay' };
  bindRuntimeUiPort({
    useAppStore: {
      getState: () => ({
        onlineSession: mockOnlineSession,
        setOnlineSession: (patch: Record<string, unknown>) => {
          Object.assign(mockOnlineSession, patch);
        },
        updateUnderDevelopment: () => {},
      }),
    } as never,
  });

  const reconciler = new PredictionReconciler(null as never, { clientCarIndex: 1 });
  let clientModeSet: string | null = null;
  const bridgePort = createOnlineSessionBridgePort({
    modeManager: {
      getActiveMode: () => ({ id: clientModeSet ?? 'freeplay' }),
      setMode: (m: string) => {
        clientModeSet = m;
      },
    } as never,
    onShowNetworkHUD: () => {},
  });

  bridgePort.applyClientRoomActivitySwitch(reconciler, {
    activityId: 'multiplayer_training',
    trainingPackId: 'aerial-pack-01',
    config: {
      packName: 'Aerial Redirects',
      shotIndex: 1,
      totalShots: 4,
      shotName: 'Double Tap',
      shotResetSeq: 1,
      clientInputEnabled: true,
    },
  });

  assert.equal(reconciler.clientInputEnabled, true, 'Host toggle unlocks client training input');
  assert.equal(mockOnlineSession.activeRoomActivity, 'multiplayer_training');
  const trainingSummary = mockOnlineSession.trainingPackSummary as Record<string, unknown>;
  assert.equal(trainingSummary?.packName, 'Aerial Redirects');
  assert.equal(trainingSummary?.shotName, 'Double Tap');
  assert.equal(trainingSummary?.shotIndex, 1);

  // Part B: Room Match Auto-Pull (connected P2P peers -> Blue/Orange teams + ready/arenaLoaded + KICKOFF)
  const hostController = new HostSessionController('room-step4-match');
  hostController.peerChannels.set('peer_client_1', {
    connected: true,
    isOpen: true,
    destroy: () => {},
  } as never);
  hostController.peerRoles.set('peer_client_1', 'player');
  hostController.peerChannels.set('peer_client_2', {
    connected: true,
    isOpen: true,
    destroy: () => {},
  } as never);
  hostController.peerRoles.set('peer_client_2', 'player');

  // Initially neither peer is ready/arenaLoaded
  assert.equal(hostController.recordPeerReadyState('peer_client_1', {}).allArenaLoaded, false);

  routeActivityAndInputMessage(
    workerCtx as never,
    HOST_WORKER_MSG_TYPES.ROOM_ACTIVITY_SWITCH,
    {
      activityId: ACTIVITY_IDS.MATCH,
      stateSummary: {
        autoPullConnectedPeers: true,
        durationSeconds: 180,
      },
    },
    reply,
    () => {}
  );

  // Verify all connected P2P peers were auto-pulled into matchManager.roster.players
  assert.equal(
    matchManager.roster.players.size,
    3,
    'Host + 2 P2P peers must all be in match roster'
  );
  const pHost = matchManager.roster.players.get('host');
  const p1 = matchManager.roster.players.get('peer_client_1');
  const p2 = matchManager.roster.players.get('peer_client_2');
  assert.ok(pHost && p1 && p2, 'All 3 sessions must have player slots');
  assert.equal(pHost.ready && pHost.arenaLoaded, true);
  assert.equal(
    p1.ready && p1.arenaLoaded,
    true,
    'peer_client_1 must be auto-marked ready & arenaLoaded'
  );
  assert.equal(
    p2.ready && p2.arenaLoaded,
    true,
    'peer_client_2 must be auto-marked ready & arenaLoaded'
  );

  const blueTeamCount = [pHost, p1, p2].filter((p) => p.team === 0).length;
  const orangeTeamCount = [pHost, p1, p2].filter((p) => p.team === 1).length;
  assert.ok(
    blueTeamCount >= 1 && orangeTeamCount >= 1,
    'Auto-pulled peers must be split across Blue & Orange'
  );
  assert.equal(
    matchManager.lifecycle.state,
    MATCH_STATES.KICKOFF,
    'Match must immediately enter KICKOFF'
  );
  assert.equal(serverClientInputEnabled, true, 'Match switch must enable client input by default');

  // Verify Client stays in lightweight CSR shell (not BotMatchMode) and unlocks input on match switch
  clientModeSet = null;
  bridgePort.applyClientRoomActivitySwitch(reconciler, {
    activityId: 'match',
    config: { autoPullConnectedPeers: true },
  });
  assert.equal(clientModeSet, null, 'Client must stay in lightweight freeplay CSR shell on match');
  assert.equal(reconciler.clientInputEnabled, true, 'Client input must be enabled in match');
  assert.equal(mockOnlineSession.activeRoomActivity, 'match');

  hostController.cleanup();
}

async function main(): Promise<void> {
  console.log('=== RocketCompanion Multiplayer Suite Test Matrix ===');
  await runSection(
    '1. Tunnel Transport & Kick/Leave Bidirectional Signaling',
    testTunnelAndKickLeaveSignaling
  );
  await runSection(
    '2. Voice Routing (open | team_only + Lobby all-chat | off)',
    testVoiceRoutingPolicies
  );
  await runSection(
    '3. Multiplayer Training (4 Boost Modes + GhostBallRelay)',
    testMultiplayerTrainingAndGhostRelay
  );
  await runSection(
    '4. Spectating & GlobalWorkspaceBroadcast + Pause ACK',
    testSpectatingAndGlobalWorkspace
  );
  await runSection(
    '5. Telestrator 50-Stroke Stress Test & HashAck',
    testTelestratorStressAndHashAck
  );
  await runSection(
    '6. MultiClientLoopbackSimulator Bot Takeover & 6-Car Matrix',
    testMultiClientLoopbackBotMatrix
  );
  await runSection(
    '7. WebRTC-First & Rust UDP Tunnel Automatic Fallback',
    testWebRtcFirstAndTunnelFallbackPath
  );
  await runSection(
    '8. Host Prewarmed Peer Rename & Tunnel Endpoint Routing',
    testHostPrewarmedPeerRenameAndTunnelEndpoint
  );
  await runSection(
    '9. ROOM_ACTIVITY_SWITCH Wire Delivery & Epoch Ordering',
    testRoomActivitySwitchWireAndEpochOrdering
  );
  await runSection(
    '10. ReliableTunnelFramer Multi-Chunk Out-of-Order & Loss Recovery',
    testReliableTunnelFramerOutOfOrderAndMultiDrop
  );
  await runSection(
    '11. Pure CSR Sync All, Dual-End Input Gating & Workspace Broadcast',
    testPureCsrSyncAllAndDualInputGating
  );
  await runSection(
    '12. Telestrator (0x05) Full-Link Sync, Dual-Store Linkage & Permission Gating',
    testTelestratorFullLinkSyncAndPermissions
  );
  await runSection(
    '13. Replay Watch Together (Pure CSR Frame Injection, Pause/Seek & Camera Sync)',
    testReplayWatchTogetherAndCameraSync
  );
  await runSection(
    '14. Custom Training Pack (training_shot_reset + Metadata Sync) & Room Match Auto-Pull',
    testCustomTrainingPackAndRoomMatchAutoPull
  );
  await runSection(
    '15. Dev Sync Room Lifecycle Preservation on Mode Switch & Client Spectate Default',
    testDevSyncRoomLifecyclePreservationAndSpectateDefault
  );
  await runSection(
    '16. SpectateInterpolationBuffer (Reverse-Delay Jitter Buffer & Sub-Tick Interpolation)',
    testSpectateInterpolationBufferReverseDelay
  );
  await runSection(
    '17. Reliable Pause/Resume ACK, 100ms Retry, Timeout & 1-2Hz Presence Heartbeat',
    testReliablePauseAckAndHeartbeat
  );
  await runSection(
    '18. Multi-Client CrossTab Isolation & Late-Join Workspace Sync',
    testMultiClientCrossTabIsolationAndWorkspaceSync
  );
  await runSection(
    '19. Authority Handover & FPV Master/Slave Epoch Fencing',
    testAuthorityHandoverAndFpvMasterSlave
  );
  await runSection(
    '20. CoachAuthorityHandoverController (Preemption, Handbrake & 300ms Idle Handover)',
    testCoachAuthorityHandoverController
  );
  await runSection(
    '21. AuthorityCameraSyncTracker (Edge-Triggered Camera Sync & Non-Override)',
    testAuthorityCameraSyncTracker
  );
  await runSection(
    '22. Pure CSR acknowledgedControls Broadcast, Coach Handover Multi-Client Input & KeyboardInputOverlay Remote Mapping',
    testPureCsrAcknowledgedControlsAndCoachMultiClientInput
  );
  await runSection(
    '23. Pure CSR pushBroadcastSignal (Countdown, Score, Flip Reset, Ball Reset, Goal Replay & Director Signal)',
    testPureCsrPushBroadcastSignalsAndGoalReplay
  );
  await runSection(
    '24. Replay Watch Together Metadata, Roster Names/Colors & Edge-Triggered CameraSync Non-Override',
    testReplayWatchTogetherMetadataRosterAndEdgeCameraSync
  );
  console.log('=== ALL MULTIPLAYER SUITE TESTS PASSED ===');
}

async function testDevSyncRoomLifecyclePreservationAndSpectateDefault(): Promise<void> {
  const mockOnlineSession: Record<string, unknown> = {
    isHosting: true,
    isDevSyncRoom: true,
    roomId: '4576',
  };
  const mockUseAppStore = {
    getState: () => ({
      onlineSession: mockOnlineSession,
      matchMode: 'freeplay',
      setOnlineSession: (patch: Record<string, unknown>) => {
        Object.assign(mockOnlineSession, patch);
      },
      setMatchMode: () => {},
      openMenu: () => {},
    }),
    setState: () => {},
  };
  bindRuntimeUiPort({ useAppStore: mockUseAppStore as never });

  let stopHostingCalls = 0;
  let stopOnlineServerCalls = 0;

  const mockDomain = {
    multiplayerSession: {
      isHosting: true,
      clientController: null,
      signalingHandler: null,
      stopHosting: async () => {
        stopHostingCalls++;
      },
      leaveSession: async () => {},
    },
    networkManager: {
      sessionCoordinator: {
        authoritativeServer: {},
        networkChannel: {},
        networkReconciler: {},
        cleanupOnlineSession: () => {},
        stopOnlineServer: async () => {
          stopOnlineServerCalls++;
        },
      },
      diagnosticsProbe: {
        diagnosticsFleetController: { enabled: false },
        lobbyGhostMode: false,
        toggleDiagnosticTestFleet: async () => {},
        configureLobbyGhostMode: () => {},
      },
    },
    botCoordinator: {
      isBotMatch: false,
      leaveBotMatch: () => {},
    },
    match: {
      state: { mode: 'freeplay', countdown: 0 },
      leave: () => {},
      start: () => {},
    },
    modeManager: {
      activeMode: { id: 'freeplay' },
      setMode: () => {},
      modes: new Map(),
    },
    domEventManager: {
      syncPausedAndInputState: () => {},
      handleOverlayChange: () => {},
    },
    trainingOptions: { boostOption: 'unlimited' },
    physics: { setUnlimitedBoost: () => {} },
    resetKickoff: () => {},
  } as unknown as Parameters<typeof createMatchModeTransitionBridge>[0];

  stopActiveOnlineOrLoopbackSessionIfNeeded(mockDomain);
  createMatchModeTransitionBridge(mockDomain).returnToFreeplay(true);

  assert.equal(
    stopHostingCalls,
    0,
    'Dev Sync Room must not call stopHosting on mode switch/freeplay'
  );
  assert.equal(
    stopOnlineServerCalls,
    0,
    'Dev Sync Room must not call stopOnlineServer on mode switch/freeplay'
  );

  mockOnlineSession.isDevSyncRoom = false;
  stopActiveOnlineOrLoopbackSessionIfNeeded(mockDomain);
  assert.equal(stopHostingCalls, 1, 'Standard room should call stopHosting on mode switch');
  assert.equal(
    stopOnlineServerCalls,
    1,
    'Standard room should call stopOnlineServer on mode switch'
  );
}

async function testSpectateInterpolationBufferReverseDelay(): Promise<void> {
  const makeSnap = (tick: number, numCars: number, ballX: number, car0X: number): Float32Array => {
    const snap = new Float32Array(448);
    snap[SIM_OFFSETS.TICK] = tick;
    snap[SIM_OFFSETS.NUM_CARS] = numCars;
    snap[SIM_OFFSETS.BALL] = ballX;
    snap[SIM_OFFSETS.BALL + 2] = 93;
    snap[SIM_OFFSETS.CARS] = car0X;
    snap[SIM_OFFSETS.CARS + 2] = 17;
    // Unit forward/right/up basis for car0
    snap[SIM_OFFSETS.CARS + 3] = 1;
    snap[SIM_OFFSETS.CARS + 7] = 1;
    snap[SIM_OFFSETS.CARS + 11] = 1;
    return snap;
  };

  const buf = new SpectateInterpolationBuffer(32);
  const TICK_MS = 1000 / 120;

  // 1. Steady 60Hz broadcast (2 ticks per packet) with 0 jitter -> interpDelayTicks == 2
  for (let i = 0; i < 6; i++) {
    const tick = 100 + i * 2;
    buf.pushFrame(makeSnap(tick, 1, i * 20, i * 10), tick, 1000 + i * 2 * TICK_MS);
  }
  let stats = buf.getStats();
  assert.equal(stats.interpDelayTicks, 2, 'Zero-jitter stream should clamp interpDelayTicks to 2');

  // Sample at midpoint between tick 108 and 110 (renderTick should start at 110 - 2 = 108, advance +1 tick after 1*TICK_MS)
  const s1 = buf.sample(1000 + 10 * TICK_MS);
  assert.ok(s1, 'Should produce sample');
  const s2 = buf.sample(1000 + 11 * TICK_MS);
  assert.ok(s2, 'Should produce interpolated sample on intermediate 120Hz render frame');
  assert.equal(s2.wasInterpolated, true, 'Intermediate frame should be interpolated');
  assert.ok(
    s2.snapshot[SIM_OFFSETS.BALL] > 80 && s2.snapshot[SIM_OFFSETS.BALL] < 100,
    `Ball X should interpolate between 80 and 100, got ${s2.snapshot[SIM_OFFSETS.BALL]}`
  );
  assert.ok(
    s2.snapshot[SIM_OFFSETS.CARS] > 40 && s2.snapshot[SIM_OFFSETS.CARS] < 50,
    `Car0 X should interpolate between 40 and 50, got ${s2.snapshot[SIM_OFFSETS.CARS]}`
  );

  // 2. Simulated 15ms-20ms arrival jitter -> interpDelayTicks should increase dynamically (4..10)
  for (let i = 6; i < 20; i++) {
    const tick = 100 + i * 2;
    const jitterOffset = i % 2 === 0 ? 18 : -14;
    buf.pushFrame(makeSnap(tick, 1, i * 20, i * 10), tick, 1000 + i * 2 * TICK_MS + jitterOffset);
  }
  stats = buf.getStats();
  assert.ok(
    stats.interpDelayTicks >= 4 && stats.interpDelayTicks <= 10,
    `Jittery stream should raise interpDelayTicks into [4,10], got ${stats.interpDelayTicks} (jitterMs=${stats.jitterMs})`
  );

  // 3. Mode switch (car count 1 -> 6) should reset buffer cleanly without interpolating across topologies
  buf.pushFrame(makeSnap(140, 6, 0, -256), 140, 2000);
  stats = buf.getStats();
  assert.equal(stats.bufferedFrames, 1, 'Car count change should reset buffer to new mode frame');
  const sMode = buf.sample(2000);
  assert.ok(sMode);
  assert.equal(Math.round(sMode.snapshot[SIM_OFFSETS.NUM_CARS]), 6);

  // 4. Teleport (>900 uu) should snap to target frame instead of lerping through the arena
  buf.pushFrame(makeSnap(142, 6, 2000, -256), 142, 2000 + 2 * TICK_MS);
  buf.pushFrame(makeSnap(144, 6, 2010, -256), 144, 2000 + 4 * TICK_MS);
  const sTeleport = buf.sample(2000 + 3 * TICK_MS);
  assert.ok(sTeleport);
  assert.ok(
    sTeleport.snapshot[SIM_OFFSETS.BALL] === 0 || sTeleport.snapshot[SIM_OFFSETS.BALL] >= 2000,
    `Teleport should snap instead of mid-arena lerp, got ballX=${sTeleport.snapshot[SIM_OFFSETS.BALL]}`
  );
}

async function testReliablePauseAckAndHeartbeat(): Promise<void> {
  // 1. HostPauseAckController state machine: awaitingPauseAck -> 100ms retry -> pausedIdle -> 2Hz presence_ping -> resume
  const ctrl = new HostPauseAckController();
  assert.equal(ctrl.state, 'playing');
  assert.equal(ctrl.shouldStreamPhysicsSnapshots(), true);

  const sync1 = ctrl.setPausedState({
    paused: true,
    pausedAtTick: 420,
    heartbeatHz: 2,
    connectedPeerIds: ['peer_a', 'peer_b'],
    nowMs: 1000,
  });
  assert.ok(sync1);
  assert.equal(sync1.pauseSeq, 1);
  assert.equal(sync1.paused, true);
  assert.equal(sync1.pausedAtTick, 420);
  assert.equal(ctrl.state, 'awaitingPauseAck');
  assert.equal(ctrl.shouldStreamPhysicsSnapshots(), false);
  assert.equal(ctrl.unackedPeers.size, 2);

  // At +50ms: no retry yet (< 100ms)
  const retried: Array<{ peerId: string; pauseSeq: number }> = [];
  const pings: Array<{ pauseSeq: number; pausedAtTick: number }> = [];
  const timeouts: string[][] = [];
  ctrl.tick(1050, {
    sendPauseStateSyncToPeer: (peerId, p) => retried.push({ peerId, pauseSeq: p.pauseSeq }),
    broadcastPresencePing: (p) =>
      pings.push({ pauseSeq: p.pauseSeq, pausedAtTick: p.pausedAtTick }),
    onPauseAckTimeout: (ids) => timeouts.push(ids),
  });
  assert.equal(retried.length, 0);

  // At +100ms: retries PAUSE_STATE_SYNC to both un-ACKed peers
  ctrl.tick(1100, {
    sendPauseStateSyncToPeer: (peerId, p) => retried.push({ peerId, pauseSeq: p.pauseSeq }),
    broadcastPresencePing: (p) =>
      pings.push({ pauseSeq: p.pauseSeq, pausedAtTick: p.pausedAtTick }),
    onPauseAckTimeout: (ids) => timeouts.push(ids),
  });
  assert.equal(retried.length, 2);

  // peer_a ACKs -> still awaiting peer_b
  assert.equal(
    ctrl.handlePauseAck({ pauseSeq: 1, paused: true, pausedAtTick: 420, peerId: 'peer_a' }, 1120),
    true
  );
  assert.equal(ctrl.state, 'awaitingPauseAck');
  assert.equal(ctrl.unackedPeers.size, 1);

  // Stale pauseSeq=0 ACK is ignored
  assert.equal(
    ctrl.handlePauseAck({ pauseSeq: 0, paused: true, pausedAtTick: 420, peerId: 'peer_b' }, 1130),
    false
  );

  // peer_b ACKs -> transitions to pausedIdle
  assert.equal(
    ctrl.handlePauseAck({ pauseSeq: 1, paused: true, pausedAtTick: 420, peerId: 'peer_b' }, 1150),
    true
  );
  assert.equal(ctrl.state, 'pausedIdle');
  assert.equal(ctrl.unackedPeers.size, 0);
  assert.equal(ctrl.shouldStreamPhysicsSnapshots(), false);

  // In pausedIdle at 2Hz (500ms interval): +200ms -> no ping; +500ms -> 1 presence_ping
  ctrl.tick(1350, {
    sendPauseStateSyncToPeer: () => {},
    broadcastPresencePing: (p) =>
      pings.push({ pauseSeq: p.pauseSeq, pausedAtTick: p.pausedAtTick }),
  });
  assert.equal(pings.length, 0);
  ctrl.tick(1650, {
    sendPauseStateSyncToPeer: () => {},
    broadcastPresencePing: (p) =>
      pings.push({ pauseSeq: p.pauseSeq, pausedAtTick: p.pausedAtTick }),
  });
  assert.equal(pings.length, 1);
  assert.equal(pings[0].pauseSeq, 1);
  assert.equal(pings[0].pausedAtTick, 420);

  // Resume -> increments pauseSeq, transitions to playing, resumes physics stream
  const resumeSync = ctrl.setPausedState({
    paused: false,
    pausedAtTick: 420,
    connectedPeerIds: ['peer_a', 'peer_b'],
    nowMs: 1700,
  });
  assert.ok(resumeSync);
  assert.equal(resumeSync.pauseSeq, 2);
  assert.equal(resumeSync.paused, false);
  assert.equal(ctrl.state, 'playing');
  assert.equal(ctrl.shouldStreamPhysicsSnapshots(), true);

  // Dead peer timeout after maxRetryMs (5000ms) transitions to pausedIdle and fires callback
  ctrl.setPausedState({
    paused: true,
    pausedAtTick: 500,
    connectedPeerIds: ['dead_peer'],
    nowMs: 2000,
  });
  ctrl.tick(7000, {
    sendPauseStateSyncToPeer: () => {},
    broadcastPresencePing: () => {},
    onPauseAckTimeout: (ids) => timeouts.push(ids),
  });
  assert.equal(timeouts.length, 1);
  assert.deepEqual(timeouts[0], ['dead_peer']);
  assert.equal(ctrl.state, 'pausedIdle');

  // 2. PredictionReconciler.sendPauseAck + HostSessionController round-trip over DataChannelTransport
  const hostCtrl = new HostSessionController({ roomId: 'room-pause-ack-1', playerName: 'Host' });
  const peerCh = hostCtrl._createPeerChannel('peer_pause_1', 'Client1', 'spectator');
  peerCh.dataChannel = {
    readyState: 'open',
    send: () => {},
    close: () => {},
  } as unknown as RTCDataChannel;

  const clientTransport = new DataChannelTransport({
    simulator: new NetworkSimulator(),
    signaling: new CrossTabSignaling(),
  });
  // Wire peerCh <-> clientTransport via reliable control JSON
  peerCh.transport.sendReliableControl = (msg: Record<string, unknown>) => {
    clientTransport.handleIncomingMessage(JSON.stringify(msg));
    return true;
  };
  clientTransport.sendReliableControl = (msg: Record<string, unknown>) => {
    peerCh.transport.handleIncomingMessage(JSON.stringify(msg));
    return true;
  };

  const clientReconciler = new PredictionReconciler(
    {
      numCars: 1,
      getCarStateView: () => ({ posX: 0, posY: 0, posZ: 17 }),
      saveStateSlot: () => {},
      restoreStateSlot: () => {},
      restoreState: () => {},
      addCar: () => {},
    },
    { clientCarIndex: 0 }
  );
  clientReconciler.channel = {
    peerId: 'peer_pause_1',
    drainTransportEvents: () => clientTransport.drainTransportEvents(),
    sendPauseStateAck: (payload: Record<string, unknown>) =>
      clientTransport.sendPauseStateAck(payload),
    receiveServerPackets: () => [],
  };

  let receivedSyncOnClient = false;
  clientReconciler.onPauseStateSync = () => {
    receivedSyncOnClient = true;
  };

  hostCtrl.broadcastGlobalWorkspace({
    playbackPaused: true,
    pausedAtTick: 777,
    pauseHeartbeatHz: 2,
  });
  assert.equal(hostCtrl.pauseAckController.state, 'awaitingPauseAck');

  // Client reconciles -> receives pause_state_sync -> automatically sends pause_state_ack back
  clientReconciler.reconcile(performance.now());
  assert.equal(receivedSyncOnClient, true);
  assert.equal(clientReconciler.lastPauseSeq, 1);
  assert.equal(
    hostCtrl.pauseAckController.state,
    'pausedIdle',
    'Host should transition to pausedIdle after receiving client PAUSE_STATE_ACK'
  );
  hostCtrl.cleanup();
}

function testMultiClientCrossTabIsolationAndWorkspaceSync(): void {
  const client1State = {
    role: 'client',
    roomId: '0608',
    peerId: 'client_1',
    playerName: 'Client1',
    localColorSlot: 0,
    localColorHex: '#38bdf8',
    peerName: 'Host',
    peerColorSlot: 0,
    peerColorHex: '#38bdf8',
    offerToken: null,
    answerToken: null,
    isOpen: false,
  };
  const client2State = {
    ...client1State,
    peerId: 'client_2',
    playerName: 'Client2',
  };

  // cross_tab_ack targeted at client_2 must be ignored by client_1 and accepted by client_2 with dedicated subRoomId
  const ackForClient2 = {
    type: 'cross_tab_ack',
    targetPeerId: 'client_2',
    subRoomId: '0608_peer_client_2',
    hostName: 'Host',
    hostColorSlot: 0,
    hostColorHex: '#38bdf8',
    offerToken: 'offer_abc',
  };
  assert.equal(classifyRoomMessage(ackForClient2, client1State, false).action, 'ignore');
  const res2 = classifyRoomMessage(ackForClient2, client2State, false);
  assert.equal(res2.action, 'cross_tab_ack');
  if (res2.action === 'cross_tab_ack') {
    assert.equal(res2.subRoomId, '0608_peer_client_2');
    assert.equal(res2.offerTokenToAccept, 'offer_abc');
  }

  // Late-join workspace sync delivers active workspace + activity to the newly connected peer channel
  const sentWorkspace: Record<string, unknown>[] = [];
  const sentActivities: Record<string, unknown>[] = [];
  const mockCh = {
    isOpen: true,
    sendGlobalWorkspaceBroadcast: (p: Record<string, unknown>) => {
      sentWorkspace.push(p);
      return true;
    },
    sendRoomActivitySwitch: (p: Record<string, unknown>) => {
      sentActivities.push(p);
      return true;
    },
  } as unknown as Parameters<typeof syncPeerWorkspaceSnapshot>[0];

  syncPeerWorkspaceSnapshot(
    mockCh,
    () => ({
      matchMode: 'static-training-pack',
      followHostWorkspace: true,
      playbackPaused: true,
      pausedAtTick: 120,
    }),
    () => ({ activityId: 'multiplayer_training', epoch: 3 })
  );
  assert.equal(sentWorkspace.length, 1);
  assert.equal(sentWorkspace[0]?.matchMode, 'static-training-pack');
  assert.equal(sentActivities.length, 1);
  assert.equal(sentActivities[0]?.activityId, 'multiplayer_training');
}

function testAuthorityHandoverAndFpvMasterSlave(): void {
  const tracker = new HostInputAuthorityTracker();
  assert.equal(tracker.activeInputPeerId, 'host');
  assert.equal(tracker.authorityEpoch, 0);

  // Handover to any client (epoch increments to 1)
  const grant = tracker.setAuthority(true, 'any', 'fpv_master_slave');
  assert.equal(grant.authorityEpoch, 1);
  assert.equal(grant.activeInputPeerId, 'any');
  assert.equal(grant.clientInputEnabled, true);

  // Stale epoch (0) is rejected; current epoch (1) is ingested and consumed
  const snap = Array.from({ length: 24 }, (_, i) => i + 1);
  assert.equal(
    tracker.ingestFrame('client_1', { authorityEpoch: 0, tick: 50, snapshot: snap }),
    false
  );
  assert.equal(
    tracker.ingestFrame('client_1', { authorityEpoch: 1, tick: 51, snapshot: snap }),
    true
  );
  const consumed = tracker.consumeLatestFrame();
  assert.ok(consumed);
  assert.equal(consumed.tick, 51);
  assert.equal(consumed.peerId, 'client_1');
  assert.equal(tracker.consumeLatestFrame(), null);

  // FPV Master/Slave host reclaim increments epoch to 2 and drops late client frames from epoch 1
  const reclaim = tracker.setAuthority(false, 'host');
  assert.equal(reclaim.authorityEpoch, 2);
  assert.equal(reclaim.activeInputPeerId, 'host');
  assert.equal(reclaim.clientInputEnabled, false);
  assert.equal(
    tracker.ingestFrame('client_1', { authorityEpoch: 1, tick: 52, snapshot: snap }),
    false
  );
}

function testCoachAuthorityHandoverController(): void {
  const ctrl = new CoachAuthorityHandoverController();
  ctrl.configure({
    clientInputEnabled: true,
    targetPeerId: 'peer_student',
    authorityMode: 'fpv_master_slave',
    idleHandoverMs: 300,
  });
  assert.equal(ctrl.activeInputPeerId, 'peer_student');
  assert.equal(ctrl.authorityEpoch, 1);

  // Neutral input leaves student in control
  const s1 = ctrl.step({
    nowMs: 1000,
    controls: { throttle: 0, steer: 0, jump: false, boost: false, handbrake: false },
    hasTargetPeer: true,
  });
  assert.equal(s1.changed, false);
  assert.equal(s1.activeInputPeerId, 'peer_student');

  // Host presses handbrake -> immediate reclaim!
  const s2 = ctrl.step({
    nowMs: 1050,
    controls: { throttle: 0, steer: 0, jump: false, boost: false, handbrake: true },
    hasTargetPeer: true,
  });
  assert.equal(s2.changed, true);
  assert.equal(s2.action, 'reclaim_to_host');
  assert.equal(s2.activeInputPeerId, 'host');
  assert.equal(s2.authorityEpoch, 2);
  assert.equal(ctrl.isEpochValid(1), false);
  assert.equal(ctrl.isEpochValid(2), true);

  // Host releases input: 200ms idle -> still Host
  const s3 = ctrl.step({
    nowMs: 1250,
    controls: { throttle: 0, steer: 0, jump: false, boost: false, handbrake: false },
    hasTargetPeer: true,
  });
  assert.equal(s3.changed, false);
  assert.equal(s3.activeInputPeerId, 'host');

  // Host stays idle >= 300ms (1050 + 300 = 1350) -> auto-handover back to student!
  const s4 = ctrl.step({
    nowMs: 1360,
    controls: { throttle: 0, steer: 0, jump: false, boost: false, handbrake: false },
    hasTargetPeer: true,
  });
  assert.equal(s4.changed, true);
  assert.equal(s4.action, 'grant_to_client');
  assert.equal(s4.activeInputPeerId, 'peer_student');
  assert.equal(s4.authorityEpoch, 3);
}

function testAuthorityCameraSyncTracker(): void {
  const hostTracker = new AuthorityCameraSyncTracker();
  const clientTracker = new AuthorityCameraSyncTracker();

  const hostCam = { isFreeCam: false, ballCam: true, focusedCarIndex: 0 };
  const clientCam = { isFreeCam: false, ballCam: true, focusedCarIndex: 0 };

  // Initial poll records baseline without emitting
  assert.equal(hostTracker.pollLocalCameraChange(hostCam, 0, 'host'), null);

  // Host switches Ball Cam -> Car Cam
  hostCam.ballCam = false;
  const ev1 = hostTracker.pollLocalCameraChange(hostCam, 0, 'host');
  assert.ok(ev1);
  assert.equal(ev1.cameraSyncSeq, 1);
  assert.equal(ev1.cameraSync.ballCam, false);

  // Client receives ev1 -> applies
  assert.equal(
    clientTracker.shouldApplyIncomingCameraSync({
      cameraSync: ev1.cameraSync,
      isLocalAuthority: false,
      incomingEpoch: 0,
    }),
    true
  );
  clientCam.ballCam = ev1.cameraSync.ballCam;

  // Client switches locally to Ball Cam while Host does not touch camera
  clientCam.ballCam = true;
  // Host sends periodic workspace broadcast with same seq=1 -> Client MUST NOT be overridden!
  assert.equal(
    clientTracker.shouldApplyIncomingCameraSync({
      cameraSync: ev1.cameraSync,
      isLocalAuthority: false,
      incomingEpoch: 0,
    }),
    false
  );
  assert.equal(clientCam.ballCam, true);

  // Host switches Car Cam -> Ball Cam (seq=2) -> Client follows!
  hostCam.ballCam = true;
  const ev2 = hostTracker.pollLocalCameraChange(hostCam, 0, 'host');
  assert.ok(ev2);
  assert.equal(ev2.cameraSyncSeq, 2);
  assert.equal(
    clientTracker.shouldApplyIncomingCameraSync({
      cameraSync: ev2.cameraSync,
      isLocalAuthority: false,
      incomingEpoch: 0,
    }),
    true
  );

  // Authority transfers to Client (epoch=1). Client switches Ball Cam -> Car Cam -> Host follows!
  const clientStart = clientTracker.pollLocalCameraChange(clientCam, 1, 'client_1');
  assert.equal(clientStart, null); // baseline already synced
  clientCam.ballCam = false;
  const ev3 = clientTracker.pollLocalCameraChange(clientCam, 1, 'client_1');
  assert.ok(ev3);
  assert.equal(
    hostTracker.shouldApplyIncomingCameraSync({
      cameraSync: ev3.cameraSync,
      isLocalAuthority: false,
      incomingEpoch: 1,
    }),
    true
  );
}

function testPureCsrAcknowledgedControlsAndCoachMultiClientInput(): void {
  // 1. Host -> Client Pure CSR acknowledgedControls -> KeyboardInputOverlay mapping
  const hostSimState = new Float32Array(448);
  hostSimState[0] = 500;
  hostSimState[2] = 2;
  const hostPhysicsManager = {
    currentTick: 500,
    sim: {
      state: hostSimState,
      numCars: 2,
      restoreCompactState: (buf: Float32Array) => {
        hostSimState.set(buf.subarray(0, Math.min(buf.length, hostSimState.length)));
      },
      saveCompactState: () => new Float32Array(hostSimState),
      syncToStateObject: () => {},
    },
    getActiveCarMask: () => 0b11,
    applySignal: () => {},
  };
  const sessionManager = new EstablishedSessionManager();
  sessionManager.registerSession('peer_bravo', {
    entityId: 1,
    role: 'spectator',
    playerName: 'ClientBravo',
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

  const mockOnlineSession = {
    isDevSyncRoom: true,
    isHosting: true,
    activeRoomActivity: 'freeplay',
  };
  bindRuntimeUiPort({
    useAppStore: { getState: () => ({ onlineSession: mockOnlineSession }) } as never,
  });

  const hostPublisher = new HostBroadcastPublisher(60);
  const mockHostPhysics = {
    saveCompactState: () => new Float32Array(hostSimState),
    getHeaderView: () => ({ tickCount: hostSimState[0] }),
  };

  hostPublisher.publishIfReady({
    timestamp: 1000,
    physics: mockHostPhysics as never,
    server: systemControl as never,
    isPaused: false,
    acknowledgedControls: [
      {
        carIndex: 0,
        controls: {
          throttle: 1,
          steer: -0.6,
          pitch: 0,
          yaw: 0,
          roll: -1,
          jump: true,
          boost: true,
          handbrake: false,
        },
      },
      {
        carIndex: 1,
        controls: {
          throttle: -1,
          steer: 0.8,
          pitch: 0,
          yaw: 0,
          roll: 0,
          jump: false,
          boost: false,
          handbrake: true,
        },
      },
    ],
  });

  const rawPacket = systemControl.stepStateOnlyFrameIfActive();
  assert.ok(rawPacket, 'Host Pure CSR stepStateOnlyFrameIfActive must produce packet');

  const bravoState = new Float32Array(448);
  const bravoPhysics = {
    state: bravoState,
    numCars: 2,
    isCarSlotActive: (idx: number) => idx < 2,
    addCarAtSlot: () => {},
    restoreState: (buf: Float32Array) => {
      bravoState.set(buf.subarray(0, Math.min(buf.length, bravoState.length)));
    },
    saveState: () => new Float32Array(bravoState),
    getCarStateView: () => ({
      posX: 0,
      posY: 0,
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
    getHeaderView: () => ({ tick: bravoState[0], tickCount: bravoState[0], numCars: 2 }),
  };
  const bravoChannel = { inboundQueue: [] as Uint8Array[], send: () => {}, isLoopback: false };
  const bravoReconciler = new PredictionReconciler(bravoPhysics as never, bravoChannel as never, {
    localCarIndex: 0,
    interpolator: {
      prevState: new Float32Array(448),
      currState: new Float32Array(448),
      alpha: 0,
    } as never,
  });
  bravoReconciler.setSpectateMirrorMode(true);
  bravoReconciler.setClientInputEnabled(false);

  bravoChannel.inboundQueue.push(sessionManager.buildClientPacket('peer_bravo', rawPacket));
  bravoReconciler.reconcile(1000);

  const bravoAck = bravoReconciler.lastParsedPacket?.acknowledgedControls ?? [];
  assert.equal(bravoAck.length, 2);

  const car0Keys = mapRemoteControlsToOverlayKeys(
    bravoAck.find((c) => c.carIndex === 0)?.controls
  );
  assert.equal(car0Keys.wPressed, true);
  assert.equal(car0Keys.aPressed, true);
  assert.equal(car0Keys.qPressed, true);
  assert.equal(car0Keys.boostPressed, true);
  assert.equal(car0Keys.jumpPressed, true);

  const car1Keys = mapRemoteControlsToOverlayKeys(
    bravoAck.find((c) => c.carIndex === 1)?.controls
  );
  assert.equal(car1Keys.sPressed, true);
  assert.equal(car1Keys.dPressed, true);
  assert.equal(car1Keys.slidePressed, true);

  updateKeyboardInputOverlayTelemetry({ isRemoteSpectating: true, ...car0Keys });
  assert.equal(getKeyboardInputOverlayTelemetry().isRemoteSpectating, true);
  assert.equal(getKeyboardInputOverlayTelemetry().wPressed, true);

  // 2. Coach Handover Multi-Client Input: Client Alpha -> Coach (Host) -> Client Bravo
  const sentFrames: Record<string, unknown>[] = [];
  const alphaPublisher = new ClientAuthorityPublisher(60);
  const alphaSnap = new Float32Array(448);
  alphaSnap[0] = 520;
  alphaSnap[2] = 2;
  const alphaSent = alphaPublisher.publishIfReady({
    timestamp: 2000,
    physics: {
      saveCompactState: () => alphaSnap,
      getHeaderView: () => ({ tickCount: 520 }),
    } as never,
    channel: {
      peerId: 'peer_alpha',
      sendClientAuthorityFrame: (payload) => {
        sentFrames.push(payload);
        return true;
      },
    },
    authorityEpoch: 1,
    acknowledgedControls: [
      {
        carIndex: 0,
        controls: {
          throttle: 1,
          steer: 0,
          pitch: -0.5,
          yaw: 0,
          roll: 0.8,
          jump: false,
          boost: true,
          handbrake: true,
        },
      },
    ],
  });
  assert.equal(alphaSent, true);
  assert.equal(sentFrames.length, 1);

  const authorityTracker = new HostInputAuthorityTracker();
  authorityTracker.setAuthority(true, 'peer_alpha', 'fpv_master_slave');
  assert.equal(authorityTracker.ingestFrame('peer_alpha', sentFrames[0], 2005), true);

  // Coach (Host) sees Client Alpha's inputs via latestAcknowledgedControls
  const coachKeys = mapRemoteControlsToOverlayKeys(
    authorityTracker.latestAcknowledgedControls?.find((c) => c.carIndex === 0)?.controls
  );
  assert.equal(coachKeys.wPressed, true);
  assert.equal(coachKeys.ePressed, true);
  assert.equal(coachKeys.boostPressed, true);
  assert.equal(coachKeys.slidePressed, true);

  // Coach forwards Client Alpha's snapshot + acknowledgedControls to Pure CSR broadcast for Client Bravo
  const pending = authorityTracker.consumePendingFrames();
  assert.equal(pending.length, 1);
  systemControl.pushBroadcastSnapshot(
    pending[0].snapshot,
    pending[0].tick,
    pending[0].acknowledgedControls
  );
  const relayPacket = systemControl.stepStateOnlyFrameIfActive();
  assert.ok(relayPacket);

  bravoChannel.inboundQueue.push(sessionManager.buildClientPacket('peer_bravo', relayPacket));
  bravoReconciler.reconcile(2010);
  const bravoRelayedAck = bravoReconciler.lastParsedPacket?.acknowledgedControls ?? [];
  const bravoRelayedKeys = mapRemoteControlsToOverlayKeys(
    bravoRelayedAck.find((c) => c.carIndex === 0)?.controls
  );
  assert.equal(bravoRelayedKeys.wPressed, true);
  assert.equal(bravoRelayedKeys.ePressed, true);
  assert.equal(bravoRelayedKeys.boostPressed, true);
  assert.equal(bravoRelayedKeys.slidePressed, true);
}

async function testPureCsrPushBroadcastSignalsAndGoalReplay(): Promise<void> {
  const hostState = new Float32Array(448);
  hostState[0] = 500;
  hostState[2] = 2;
  const hostPhysicsManager = {
    currentTick: 500,
    sim: {
      state: hostState,
      numCars: 2,
      restoreState: (buf: Float32Array) => hostState.set(buf.subarray(0, hostState.length)),
      restoreCompactState: (buf: Float32Array) => hostState.set(buf.subarray(0, hostState.length)),
      saveCompactState: () => new Float32Array(hostState),
      saveState: () => new Float32Array(hostState),
      syncToStateObject: () => {},
    },
    getActiveCarMask: () => 0b11,
    applySignal: () => {},
  };
  const sessionManager = new EstablishedSessionManager();
  sessionManager.registerSession('peer_csr_1', {
    entityId: 1,
    role: 'spectator',
    playerName: 'Spectator1',
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

  systemControl.enterStateOnlyMode(hostState, 500);
  systemControl.pushBroadcastSignal(MATCH_SIGNALS.KICKOFF_WILL_START, 500, 180, 3);
  systemControl.pushBroadcastSignal(MATCH_SIGNALS.SCORE_UPDATED, 500, 2, 1);
  systemControl.pushBroadcastSignal(
    MATCH_SIGNALS.FLIP_RESET_GAINED,
    500,
    0,
    FLIP_RESET_SUBTYPES.BALL
  );
  systemControl.pushBroadcastSignal(MATCH_SIGNALS.GOAL_REPLAY_WILL_START, 500, 0, 1);
  systemControl.pushBroadcastSignal(MATCH_SIGNALS.GOAL_REPLAY_START, 500, 360, 0b10);

  const rawPkt = systemControl.stepStateOnlyFrameIfActive();
  assert.ok(rawPkt);
  const decoded = GlobalPayloadCodec.decode(rawPkt);
  const types = (decoded.signals || []).map((s) => s.signalType);
  assert.ok(types.includes(MATCH_SIGNALS.KICKOFF_WILL_START));
  assert.ok(types.includes(MATCH_SIGNALS.SCORE_UPDATED));
  assert.ok(types.includes(MATCH_SIGNALS.FLIP_RESET_GAINED));
  assert.ok(types.includes(MATCH_SIGNALS.GOAL_REPLAY_WILL_START));
  assert.ok(types.includes(MATCH_SIGNALS.GOAL_REPLAY_START));

  const clientState = new Float32Array(448);
  const clientChannel = { inboundQueue: [] as Uint8Array[], send: () => {}, isLoopback: false };
  const reconciler = new PredictionReconciler(
    {
      state: clientState,
      numCars: 2,
      isCarSlotActive: (idx: number) => idx < 2,
      addCarAtSlot: () => {},
      restoreState: (buf: Float32Array) => clientState.set(buf.subarray(0, clientState.length)),
      saveState: () => new Float32Array(clientState),
      getCarStateView: () => ({
        posX: 0,
        posY: 0,
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
    } as never,
    clientChannel as never,
    {
      localCarIndex: 0,
      interpolator: { prevState: new Float32Array(448), currState: new Float32Array(448), alpha: 0 } as never,
    }
  );
  reconciler.setSpectateMirrorMode(true);
  reconciler.setClientInputEnabled(false);
  const seenSignals: number[] = [];
  reconciler.onSignals = (sigs) => {
    for (const s of sigs) seenSignals.push(s.signalType);
  };
  clientChannel.inboundQueue.push(sessionManager.buildClientPacket('peer_csr_1', rawPkt));
  reconciler.reconcile(1000);

  assert.ok(seenSignals.includes(MATCH_SIGNALS.KICKOFF_WILL_START));
  assert.ok(seenSignals.includes(MATCH_SIGNALS.SCORE_UPDATED));
  assert.ok(seenSignals.includes(MATCH_SIGNALS.FLIP_RESET_GAINED));
  assert.ok(seenSignals.includes(MATCH_SIGNALS.GOAL_REPLAY_WILL_START));
  assert.ok(seenSignals.includes(MATCH_SIGNALS.GOAL_REPLAY_START));

  // Verify GOAL_REPLAY_END retires GOAL_REPLAY_START/WILL_START
  systemControl.pushBroadcastSignal(MATCH_SIGNALS.GOAL_REPLAY_END, 501, 0, 0, [
    MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
    MATCH_SIGNALS.GOAL_REPLAY_START,
    MATCH_SIGNALS.GOAL_REPLAY_WILL_END,
  ]);
  const endPkt = systemControl.stepStateOnlyFrameIfActive();
  assert.ok(endPkt);
  const decodedEnd = GlobalPayloadCodec.decode(endPkt);
  const endTypes = (decodedEnd.signals || []).map((s) => s.signalType);
  assert.ok(endTypes.includes(MATCH_SIGNALS.GOAL_REPLAY_END));
  assert.ok(!endTypes.includes(MATCH_SIGNALS.GOAL_REPLAY_START));
}

async function testReplayWatchTogetherMetadataRosterAndEdgeCameraSync(): Promise<void> {
  bindRuntimeUiPort({
    useReplayViewerStore: useReplayViewerStore as never,
    buildHostWorkspaceBroadcastPayload: (meta?: Record<string, unknown>) =>
      sanitizeGlobalWorkspaceBroadcast(meta),
    captureCameraSyncFromPort: (cam: Record<string, unknown>, follow = true) => ({
      followHostCamera: follow,
      isFreeCam: Boolean(cam.isFreeCam),
      ballCam: typeof cam.ballCam === 'boolean' ? cam.ballCam : true,
      focusedCarIndex: Number(cam.focusedCarIndex) || 0,
    }),
  });

  sharedAuthorityCameraSyncTracker.reset();
  const sentActivities: Array<Record<string, unknown>> = [];
  const sentWorkspaces: Array<Record<string, unknown>> = [];
  const hostCam = { isFreeCam: false, ballCam: true, focusedCarIndex: 1 };
  const hostRuntime = {
    camera: hostCam,
    multiplayerSession: {
      isHosting: true,
      broadcastRoomActivitySwitch: (opts: Record<string, unknown>) => sentActivities.push(opts),
      broadcastGlobalWorkspace: (payload: Record<string, unknown>) => {
        sentWorkspaces.push(payload);
        return 1;
      },
    },
  };

  syncReplayWorkspaceToOnlineRoom(hostRuntime as never, {
    active: true,
    playbackPaused: false,
    pausedAtTick: 1200,
    switchActivity: true,
    replayId: 'match-90s.rc',
    replaySync: {
      fileName: 'match-90s.rc',
      totalFrames: 10800,
      currentFrame: 1200,
      playbackState: 'playing',
      focusedCarIndex: 1,
      roster: [
        { carIndex: 0, name: 'AlphaOrange', team: 1 },
        { carIndex: 1, name: 'BetaBlue', team: 0 },
      ],
    },
  });

  const ws0 = sentWorkspaces[0] as {
    cameraSync?: { cameraSyncSeq?: number };
    replaySync?: { fileName?: string; totalFrames?: number; roster?: Array<{ name: string }> };
  };
  assert.equal(ws0.replaySync?.fileName, 'match-90s.rc');
  assert.equal(ws0.replaySync?.totalFrames, 10800);
  assert.equal(ws0.replaySync?.roster?.length, 2);
  const seq0 = ws0.cameraSync?.cameraSyncSeq ?? 0;
  assert.ok(seq0 >= 1);

  // Periodic heartbeat without camera change MUST NOT increment cameraSyncSeq (edge-triggered non-override)
  const hb = new ReplayOnlineHeartbeatTracker();
  assert.equal(hb.maybeSync(hostRuntime as never, { playbackPaused: false, pausedAtTick: 1200 }, 1000), true);
  const ws1 = sentWorkspaces[1] as { cameraSync?: { cameraSyncSeq?: number } };
  assert.equal(ws1.cameraSync?.cameraSyncSeq, seq0);

  // Camera change MUST increment cameraSyncSeq
  hostCam.focusedCarIndex = 0;
  assert.equal(hb.maybeSync(hostRuntime as never, { playbackPaused: false, pausedAtTick: 1260 }, 1100), true);
  const ws2 = sentWorkspaces[2] as { cameraSync?: { cameraSyncSeq?: number } };
  assert.ok((ws2.cameraSync?.cameraSyncSeq ?? 0) > seq0);

  // Client applies activity switch -> useReplayViewerStore & hudRosterResolverPipeline resolve exact names/teams
  const bridgePort = createOnlineSessionBridgePort(
    {
      modeManager: { getActiveMode: () => ({ id: 'freeplay' }), setMode: () => {} },
      match: { state: { mode: 'freeplay' } },
      trainingOptions: {},
    } as never,
    () => ({}) as never,
    () => ({}) as never
  );
  const clientReconciler = {
    setReplayPlaybackMode: () => {},
    setSpectateMirrorMode: () => {},
    setClientInputEnabled: () => {},
  };
  bridgePort.applyClientRoomActivitySwitch(clientReconciler as never, sentActivities[0] as never);
  const rv = useReplayViewerStore.getState();
  assert.equal(rv.viewerState, 'playing');
  assert.equal(rv.loadedFileName, 'match-90s.rc');
  const resolved = resolveModeRosterEntries(
    {
      matchMode: 'freeplay',
      isReplayViewerLoaded: false,
      replayViewerState: rv.viewerState,
      replayViewerResolvedRoster: rv.resolvedRoster,
      numCars: 2,
    },
    createResolvedModeRosterBuffer()
  );
  assert.deepEqual(
    resolved.blueEntries.map((e) => e.name),
    ['BetaBlue']
  );
  assert.deepEqual(
    resolved.orangeEntries.map((e) => e.name),
    ['AlphaOrange']
  );
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
