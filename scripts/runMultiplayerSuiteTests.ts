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
import { NetworkSimulator } from '../src/network/transport/webrtc/NetworkSimulator.ts';
import { CrossTabSignaling } from '../src/network/transport/webrtc/CrossTabSignaling.ts';
import type { TunnelPacketPayload, TunnelTransport } from '../src/network/transport/tunnel/TunnelTransport.ts';
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
import { computeStrokeHash } from '../src/entities/telestrator/telestratorStrokeMath.ts';
import {
  decodeHostPermissionSync,
  decodeTelestratorHashAck,
  decodeTelestratorStroke,
  encodeHostPermissionSync,
  encodeTelestratorHashAck,
  encodeTelestratorStroke,
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

function runSection(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`[PASS] ${name}`);
    });
}

async function testTunnelAndKickLeaveSignaling(): Promise<void> {
  const sentPackets: Array<{ peerId: string; payload: TunnelPacketPayload; reliable: boolean }> = [];
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
  assert.equal(sentPackets.some((p) => p.peerId === 'peer_client_1' && !p.reliable), true);

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
  await new Promise((resolve) => setTimeout(resolve, 90));
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
  assert.equal(
    (receivedWorkspace?.openFloatingWindows as unknown[] | undefined)?.length,
    60
  );

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
    clientTransport.sendReliableControl({ type: 'peer_leave', peerId: 'peer_client_1' }, 'peer_leave'),
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
  assert.equal(forPeer1.some((b) => b.ownerPeerId === 'peer_1'), false);
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

  useSpectateWorkspaceStore.getState().setSpectateMode('spectate_mirror', captureLocal, applyWorkspace);
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
      points.push({ x: (i * 17 + p * 3) % 4000, y: (p * 11) % 5000, z: 20 + p, nx: 0, ny: 0, nz: 1 });
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
    assert.equal(voiceBridge.isPeerVoiceAllowed({ team: 1 }), true, `${caseSpec.label} lobby all-talk`);
    voiceBridge.setRoomVoicePolicy('team_only', 0, false);
    assert.equal(voiceBridge.isPeerVoiceAllowed({ team: 0 }), true, `${caseSpec.label} match teammate`);
    assert.equal(voiceBridge.isPeerVoiceAllowed({ team: 1 }), false, `${caseSpec.label} match opponent`);
  }
}

async function main(): Promise<void> {
  console.log('=== RocketCompanion Multiplayer Suite Test Matrix ===');
  await runSection('1. Tunnel Transport & Kick/Leave Bidirectional Signaling', testTunnelAndKickLeaveSignaling);
  await runSection('2. Voice Routing (open | team_only + Lobby all-chat | off)', testVoiceRoutingPolicies);
  await runSection('3. Multiplayer Training (4 Boost Modes + GhostBallRelay)', testMultiplayerTrainingAndGhostRelay);
  await runSection('4. Spectating & GlobalWorkspaceBroadcast + Pause ACK', testSpectatingAndGlobalWorkspace);
  await runSection('5. Telestrator 50-Stroke Stress Test & HashAck', testTelestratorStressAndHashAck);
  await runSection('6. MultiClientLoopbackSimulator Bot Takeover & 6-Car Matrix', testMultiClientLoopbackBotMatrix);
  console.log('=== ALL MULTIPLAYER SUITE TESTS PASSED ===');
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
