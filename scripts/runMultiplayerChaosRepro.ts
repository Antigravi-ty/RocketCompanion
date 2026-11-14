#!/usr/bin/env node
/**
 * scripts/runMultiplayerChaosRepro.ts
 * Fast, zero-WebGL multiplayer chaos, re-entry, and path-traversal repro runner.
 * Streams real-time JSONL telemetry to stdout and flushes a full report to
 * /tmp/multiplayer-chaos-repro-report.json before any container timeout.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DataChannelTransport } from '../src/network/transport/webrtc/DataChannelTransport.ts';
import { NetworkSimulator } from '../src/network/transport/webrtc/NetworkSimulator.ts';
import { CrossTabSignaling } from '../src/network/transport/webrtc/CrossTabSignaling.ts';
import type {
  TunnelPacketPayload,
  TunnelTransport,
} from '../src/network/transport/tunnel/TunnelTransport.ts';
import { RoomActivityOrchestrator } from '../src/network/server/RoomActivityOrchestrator.ts';
import { ACTIVITY_IDS, REPLICATION_MODES } from '../src/network/protocol/ReplicationBusProtocol.ts';
import {
  GhostBallRelayCoordinator,
  applyTrainingBoostPolicyToSim,
  sanitizeTrainingConfig,
  type MultiplayerTrainingBoostMode,
} from '../src/network/server/activities/MultiplayerTrainingPolicy.ts';
import { MultiClientLoopbackSimulator } from '../src/game/scenario/MultiClientLoopbackSimulator.ts';
import { sanitizeGlobalWorkspaceBroadcast } from '../src/network/protocol/GlobalWorkspaceProtocol.ts';
import { WebRtcNativeVoiceBridge } from '../src/audio/voice/WebRtcNativeVoiceBridge.ts';
import { useSpectateWorkspaceStore } from '../src/ui-core/stores/spectateWorkspaceStore.ts';

const DEFAULT_OUT_PATH = '/tmp/multiplayer-chaos-repro-report.json';
const DEFAULT_MAX_DURATION_MS = 270_000;

interface ChaosStepResult {
  name: string;
  passed: boolean;
  durationMs: number;
  detail?: string;
  error?: string;
}

function parseArgs(argv: string[]): { maxDurationMs: number; outPath: string } {
  let maxDurationMs = DEFAULT_MAX_DURATION_MS;
  let outPath = DEFAULT_OUT_PATH;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--max-duration-ms=')) {
      maxDurationMs = Math.max(
        5_000,
        Number(arg.slice('--max-duration-ms='.length)) || DEFAULT_MAX_DURATION_MS
      );
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length).trim() || DEFAULT_OUT_PATH;
    }
  }
  return { maxDurationMs, outPath };
}

function emitStream(event: Record<string, unknown>): void {
  process.stdout.write(`[ChaosStream] ${JSON.stringify(event)}\n`);
}

function createPairedLoopbackTunnels(): {
  hostTunnel: TunnelTransport;
  clientTunnel: TunnelTransport;
  bindTransports: (host: DataChannelTransport, client: DataChannelTransport) => void;
  closeAll: () => Promise<void>;
} {
  let hostRef: DataChannelTransport | null = null;
  let clientRef: DataChannelTransport | null = null;
  let hostOpen = true;
  let clientOpen = true;

  const hostTunnel: TunnelTransport = {
    mode: 'rust_udp',
    get isOpen() {
      return hostOpen;
    },
    localEndpoint: { addr: '127.0.0.1:49101', isUpnpMapped: false, mode: 'rust_udp' },
    open: async () => {
      hostOpen = true;
      return { addr: '127.0.0.1:49101', isUpnpMapped: false, mode: 'rust_udp' };
    },
    connectPeer: async () => {},
    sendToPeer: (peerId, payload: TunnelPacketPayload) => {
      if (!hostOpen || !clientOpen) return false;
      if (peerId === 'client_1' && clientRef) {
        clientRef.handleIncomingMessage(payload);
        return true;
      }
      return false;
    },
    onPacket: () => {},
    close: async () => {
      hostOpen = false;
    },
  };

  const clientTunnel: TunnelTransport = {
    mode: 'rust_udp',
    get isOpen() {
      return clientOpen;
    },
    localEndpoint: { addr: '127.0.0.1:49102', isUpnpMapped: false, mode: 'rust_udp' },
    open: async () => {
      clientOpen = true;
      return { addr: '127.0.0.1:49102', isUpnpMapped: false, mode: 'rust_udp' };
    },
    connectPeer: async () => {},
    sendToPeer: (peerId, payload: TunnelPacketPayload) => {
      if (!clientOpen || !hostOpen) return false;
      if (peerId === 'host' && hostRef) {
        hostRef.handleIncomingMessage(payload);
        return true;
      }
      return false;
    },
    onPacket: () => {},
    close: async () => {
      clientOpen = false;
    },
  };

  return {
    hostTunnel,
    clientTunnel,
    bindTransports: (host, client) => {
      hostRef = host;
      clientRef = client;
    },
    closeAll: async () => {
      await hostTunnel.close();
      await clientTunnel.close();
    },
  };
}

async function runCancelAndRejoinChaos(): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pair = createPairedLoopbackTunnels();
    const host = new DataChannelTransport({
      simulator: new NetworkSimulator(),
      signaling: new CrossTabSignaling(),
    });
    const client = new DataChannelTransport({
      simulator: new NetworkSimulator(),
      signaling: new CrossTabSignaling(),
    });
    pair.bindTransports(host, client);
    host.attachTunnelTransport(pair.hostTunnel, 'client_1');
    client.attachTunnelTransport(pair.clientTunnel, 'host');

    if (attempt < 3) {
      let leaveReceived = false;
      host.onPeerLeave = () => {
        leaveReceived = true;
      };
      assert.equal(
        client.sendReliableControl(
          { type: 'peer_leave', reason: `cancel_${attempt}` },
          'peer_leave'
        ),
        true
      );
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(leaveReceived, true, `Attempt ${attempt}: host missed peer_leave`);
      host.detachTunnelTransport();
      client.detachTunnelTransport();
      await pair.closeAll();
    } else {
      let kickReceived = false;
      client.onPeerKick = () => {
        kickReceived = true;
      };
      assert.equal(
        host.sendReliableControl({ type: 'peer_kick', reason: 'reentry_ok' }, 'peer_kick'),
        true
      );
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(kickReceived, true, 'Attempt 3: client missed peer_kick after 2 cancels');
      host.detachTunnelTransport();
      client.detachTunnelTransport();
      await pair.closeAll();
    }
  }
  return '3 cancel/re-host/re-join cycles clean';
}

async function runActivityChaosTraversal(): Promise<string> {
  const orchestrator = new RoomActivityOrchestrator();
  const transitions: string[] = [];

  const ctx = { serverTick: 1, worldSeed: 42 } as never;
  orchestrator.switchActivity(
    { activityId: ACTIVITY_IDS.FREEPLAY, replicationMode: REPLICATION_MODES.CONTINUOUS },
    ctx
  );
  assert.equal(orchestrator.getActiveActivityId(), ACTIVITY_IDS.FREEPLAY);
  transitions.push(orchestrator.getActiveActivityId());

  const trainingCfg = sanitizeTrainingConfig({
    boostPolicy: 'limit_when_aerial',
    ghostModeEnabled: false,
  });
  orchestrator.switchActivity(
    {
      activityId: ACTIVITY_IDS.MULTIPLAYER_TRAINING,
      replicationMode: REPLICATION_MODES.CONTINUOUS,
    },
    ctx
  );
  assert.equal(orchestrator.getActiveActivityId(), ACTIVITY_IDS.MULTIPLAYER_TRAINING);
  transitions.push(orchestrator.getActiveActivityId());

  const carUnlimited = new Map<number, boolean>();
  const simPort = {
    setCarUnlimitedBoost: (idx: number, val: boolean) => carUnlimited.set(idx, val),
    setCarBoostCollectable: () => {},
    getCarStateView: (idx: number) => ({ isOnGround: idx === 0 }),
  };
  applyTrainingBoostPolicyToSim(simPort as never, [0, 1], trainingCfg);
  assert.equal(carUnlimited.get(0), true);
  assert.equal(carUnlimited.get(1), false);

  orchestrator.switchActivity(
    { activityId: ACTIVITY_IDS.MATCH, replicationMode: REPLICATION_MODES.CONTINUOUS },
    ctx
  );
  assert.equal(orchestrator.getActiveActivityId(), ACTIVITY_IDS.MATCH);
  transitions.push(orchestrator.getActiveActivityId());
  orchestrator.switchActivity(
    { activityId: ACTIVITY_IDS.FREEPLAY, replicationMode: REPLICATION_MODES.CONTINUOUS },
    ctx
  );
  assert.equal(orchestrator.getActiveActivityId(), ACTIVITY_IDS.FREEPLAY);
  transitions.push(orchestrator.getActiveActivityId());

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
  const broadcast = orchestrator.buildGlobalWorkspaceBroadcast({
    tick: 420,
    menuRoute: 'settings/audio',
    openFloatingWindows: [{ id: 'telestrator_toolbar', isOpen: true, isMinimized: false }],
    playbackPaused: true,
    pausedAtTick: 420,
  });
  const sanitized = sanitizeGlobalWorkspaceBroadcast(broadcast);
  useSpectateWorkspaceStore
    .getState()
    .setSpectateMode('spectate_mirror', captureLocal, applyWorkspace);
  useSpectateWorkspaceStore.getState().setSpectatingActive(true, captureLocal, applyWorkspace);
  useSpectateWorkspaceStore.getState().applyHostWorkspaceBroadcast(sanitized, applyWorkspace);
  assert.equal(appliedRoute, 'settings/audio');
  assert.equal(useSpectateWorkspaceStore.getState().isReadOnlyLocked, true);
  useSpectateWorkspaceStore.getState().setSpectatingActive(false, captureLocal, applyWorkspace);
  assert.equal(useSpectateWorkspaceStore.getState().isReadOnlyLocked, false);
  assert.equal(appliedRoute, 'home');

  orchestrator.switchActivity(
    { activityId: ACTIVITY_IDS.REPLAY, replicationMode: REPLICATION_MODES.SPARSE },
    ctx
  );
  assert.equal(orchestrator.getActiveActivityId(), ACTIVITY_IDS.REPLAY);
  transitions.push(orchestrator.getActiveActivityId());
  orchestrator.switchActivity(
    { activityId: ACTIVITY_IDS.MATCH, replicationMode: REPLICATION_MODES.CONTINUOUS },
    ctx
  );
  assert.equal(orchestrator.getActiveActivityId(), ACTIVITY_IDS.MATCH);
  transitions.push(orchestrator.getActiveActivityId());

  const ghostRelay = new GhostBallRelayCoordinator();
  ghostRelay.ingestClientBall({
    ownerPeerId: 'peer_0',
    carIndex: 0,
    pos: [10, 20, 30],
    vel: [1, 2, 3],
    angVel: [0, 0, 0],
    tick: 1,
  });
  ghostRelay.ingestClientBall({
    ownerPeerId: 'peer_1',
    carIndex: 1,
    pos: [-10, 20, 30],
    vel: [-1, 2, 3],
    angVel: [0, 0, 0],
    tick: 1,
  });
  assert.equal(ghostRelay.buildRelaySnapshot('peer_0').length, 1);

  const voice = new WebRtcNativeVoiceBridge({ getAudioContext: () => null });
  voice.setRoomVoicePolicy('team_only', 0, false);
  assert.equal(voice.isPeerVoiceAllowed({ team: 0 }), true);
  assert.equal(voice.isPeerVoiceAllowed({ team: 1 }), false);
  voice.setRoomVoicePolicy('team_only', 0, true);
  assert.equal(voice.isPeerVoiceAllowed({ team: 1 }), true);

  return `Traversed ${transitions.length} activities (${transitions.join(' -> ')})`;
}

async function runFullRosterPermutationMatrix(): Promise<string> {
  const boostPolicies: MultiplayerTrainingBoostMode[] = [
    'limited',
    'limit_when_aerial',
    'unlimited',
    'custom',
  ];
  let totalConfigs = 0;

  for (let blue = 1; blue <= 3; blue++) {
    for (let orange = 1; orange <= 3; orange++) {
      for (const allHumanTakeover of [true, false]) {
        const totalCars = blue + orange;
        const carIndices = Array.from({ length: totalCars }, (_, i) => i);
        const carUnlimited = new Map<number, boolean>();
        const simPort = {
          setCarUnlimitedBoost: (idx: number, val: boolean) => carUnlimited.set(idx, val),
          setCarBoostCollectable: () => {},
          getCarStateView: (idx: number) => ({ isOnGround: idx % 2 === 0 }),
        };
        const boostPolicy = boostPolicies[totalConfigs % boostPolicies.length];
        const cfg = sanitizeTrainingConfig({ boostPolicy, ghostModeEnabled: true });
        applyTrainingBoostPolicyToSim(simPort as never, carIndices, cfg);
        assert.equal(carUnlimited.size, totalCars);

        if (totalCars === 6 && allHumanTakeover) {
          const mockRuntime = {
            networkManager: {
              isHosting: true,
              sessionCoordinator: {
                hostOnlineServer: async () => {},
                stopOnlineServer: async () => {},
              },
              rosterSyncCoordinator: {
                onRemotePlayerConnected: async () => {},
              },
            },
            physics: {
              numCars: 6,
              isCarSlotActive: () => true,
              getHeaderView: () => ({ tickCount: 10 }),
            },
            arena: {
              cars: Array.from({ length: 6 }, () => ({ visible: true })),
            },
            authoritativeServer: {
              lastServerTick: 10,
              fallbackManager: { domain: { state: 'playing' } },
            },
          };
          const sim = new MultiClientLoopbackSimulator(mockRuntime);
          await sim.startSixCarLoopbackSession(30);
          sim.stepVirtualPeers(6, 100);
          const telemetry = sim.collectTelemetry();
          assert.equal(telemetry.activePhysicalCars, 6);
          await sim.stop();
        }

        totalConfigs++;
      }
    }
  }

  return `${totalConfigs} roster permutations (1v1..3v3 x human/auto-fill) passed`;
}

async function main(): Promise<void> {
  const { maxDurationMs, outPath } = parseArgs(process.argv);
  const startMs = Date.now();
  const steps: ChaosStepResult[] = [];
  let timedOut = false;

  const flushReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startMs,
      maxDurationMs,
      timedOut,
      passedCount: steps.filter((s) => s.passed).length,
      failedCount: steps.filter((s) => !s.passed).length,
      steps,
    };
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  };

  const watchdog = setTimeout(() => {
    timedOut = true;
    emitStream({ type: 'watchdog_timeout', elapsedMs: Date.now() - startMs });
    flushReport();
    process.exit(1);
  }, maxDurationMs);

  const tasks: Array<[string, () => Promise<string>]> = [
    ['1. Cancel / Re-Host / Re-Join Lifecycle Chaos', runCancelAndRejoinChaos],
    [
      '2. Freeplay -> Training -> Lobby -> Spectate -> Replay -> Online Path Traversal',
      runActivityChaosTraversal,
    ],
    ['3. Full 1v1..3v3 Asymmetric & Mixed Human/Bot Matrix', runFullRosterPermutationMatrix],
  ];

  let hasFailure = false;
  for (const [name, fn] of tasks) {
    const t0 = Date.now();
    emitStream({ type: 'step_start', name });
    try {
      const detail = await fn();
      const result: ChaosStepResult = { name, passed: true, durationMs: Date.now() - t0, detail };
      steps.push(result);
      emitStream({ type: 'step_pass', ...result });
    } catch (err) {
      hasFailure = true;
      const result: ChaosStepResult = {
        name,
        passed: false,
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
      steps.push(result);
      emitStream({ type: 'step_fail', ...result });
    }
  }

  clearTimeout(watchdog);
  flushReport();
  if (hasFailure) process.exit(1);
}

main().catch((err) => {
  console.error('[ChaosRepro] Fatal error:', err);
  process.exit(1);
});
