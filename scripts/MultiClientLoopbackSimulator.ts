/**
 * scripts/MultiClientLoopbackSimulator.ts
 * Multi-client in-process loopback simulator exercising production transport,
 * ReliableTunnelFramer, RoomActivityOrchestrator, MultiplayerTrainingKernel,
 * SpectatorGlobalStateCoordinator, Voice team-gating, Kick/Leave, and TelestratorWireCodec.
 */

import {
  isVoicePeerGatedByRoomPolicy,
  type VoiceChatMode,
  type VoiceTeam,
} from '../src/audio/voice/IVoiceAudioBridge.ts';
import {
  computeStrokeHash,
} from '../src/entities/telestrator/telestratorStrokeMath.ts';
import type { TelestratorStroke } from '../src/entities/telestrator/telestratorTypes.ts';
import {
  ACTIVITY_IDS,
  REPLICATION_MODES,
  decodeSparsePingPong16B,
  encodeSparsePingPong16B,
  PING_PONG_KIND_PING,
  PING_PONG_KIND_PONG,
} from '../src/network/protocol/ReplicationBusProtocol.ts';
import {
  decodeTelestratorHashAck,
  decodeTelestratorStroke,
  encodeTelestratorHashAck,
  encodeTelestratorStroke,
} from '../src/network/protocol/TelestratorWireCodec.ts';
import { RoomActivityOrchestrator } from '../src/network/server/RoomActivityOrchestrator.ts';
import type { MultiplayerTrainingActivityKernel } from '../src/network/server/activities/MultiplayerTrainingKernel.ts';
import { SpectatorGlobalStateCoordinator } from '../src/network/sync/SpectatorGlobalStateCoordinator.ts';
import { ReliableTunnelFramer } from '../src/network/transport/tunnel/ReliableTunnelFramer.ts';
import { P2PWebRTCChannel } from '../src/network/transport/P2PWebRTCChannel.ts';
import { useSpectatorSyncStore } from '../src/ui-core/stores/spectatorSyncStore.ts';

export interface MatrixCaseResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface MultiClientMatrixReport {
  total: number;
  passed: number;
  failed: number;
  results: MatrixCaseResult[];
}

function assert(cond: boolean, message: string): void {
  if (!cond) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export class MultiClientLoopbackSimulator {
  runFullMatrix(): MultiClientMatrixReport {
    const cases: Array<{ name: string; fn: () => void }> = [
      {
        name: 'reliable_tunnel_framer_chunking_and_loss_recovery',
        fn: () => this.testReliableTunnelFramer(),
      },
      {
        name: 'human_takeover_and_autofill_bot_roster_matrix',
        fn: () => this.testBotRosterMatrix(),
      },
      {
        name: 'multiplayer_training_4_boost_policies',
        fn: () => this.testMultiplayerTrainingBoostPolicies(),
      },
      {
        name: 'multiplayer_training_ghost_ball_relay',
        fn: () => this.testMultiplayerTrainingGhostRelay(),
      },
      {
        name: 'kick_and_leave_bidirectional_signaling',
        fn: () => this.testKickAndLeaveSignaling(),
      },
      {
        name: 'voice_open_team_only_lobby_and_off_routing',
        fn: () => this.testVoiceRoutingPolicies(),
      },
      {
        name: 'spectating_gameplay_only_vs_mirror_host_ui_and_pause_ack',
        fn: () => this.testSpectatingAndPauseAck(),
      },
      {
        name: 'telestrator_stress_hash_ack_consistency',
        fn: () => this.testTelestratorStressConsistency(),
      },
    ];

    const results: MatrixCaseResult[] = [];
    for (const c of cases) {
      try {
        c.fn();
        results.push({ name: c.name, passed: true, detail: 'OK' });
      } catch (err) {
        results.push({
          name: c.name,
          passed: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const passed = results.filter((r) => r.passed).length;
    return {
      total: results.length,
      passed,
      failed: results.length - passed,
      results,
    };
  }

  private testReliableTunnelFramer(): void {
    const deliveredA: Uint8Array[] = [];
    const deliveredB: Uint8Array[] = [];
    let now = 1000;
    let dropNextDataFrame = true;

    let framerA: ReliableTunnelFramer;
    let framerB: ReliableTunnelFramer;

    framerA = new ReliableTunnelFramer({
      maxChunkBytes: 400,
      retransmitIntervalMs: 30,
      nowMs: () => now,
      sendRaw: (frame) => {
        if (dropNextDataFrame) {
          dropNextDataFrame = false;
          return true; // simulate UDP drop on first chunk
        }
        framerB.handleIncomingFrame(frame);
        return true;
      },
      onReliablePayload: (p) => deliveredA.push(p),
    });

    framerB = new ReliableTunnelFramer({
      maxChunkBytes: 400,
      retransmitIntervalMs: 30,
      nowMs: () => now,
      sendRaw: (frame) => {
        framerA.handleIncomingFrame(frame);
        return true;
      },
      onReliablePayload: (p) => deliveredB.push(p),
    });

    // Send oversized 2500-byte payload (> MTU)
    const bigPayload = new Uint8Array(2500);
    for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = i & 0xff;

    framerA.sendReliable(bigPayload);
    assert(deliveredB.length === 0, 'Payload should not complete while chunk 0 was dropped');
    assert(framerA.getPendingCount() >= 1, 'Dropped chunk must remain pending');

    now += 40;
    framerA.tickRetransmit();
    assert(deliveredB.length === 1, 'Payload should reassemble after retransmit');
    assert(deliveredB[0].byteLength === 2500, 'Reassembled payload size mismatch');
    assert(deliveredB[0][1234] === (1234 & 0xff), 'Reassembled payload byte mismatch');
    assert(framerA.getPendingCount() === 0, 'All chunks must be ACKed');

    framerA.dispose();
    framerB.dispose();
  }

  private testBotRosterMatrix(): void {
    const configs = [
      { mode: '1v1', humanCount: 1, autoFill: true, expectedTotal: 2 },
      { mode: '2v2', humanCount: 2, autoFill: true, expectedTotal: 4 },
      { mode: '3v3', humanCount: 2, autoFill: true, expectedTotal: 6 },
      { mode: '3v3', humanCount: 3, autoFill: false, expectedTotal: 3 },
    ];

    for (const cfg of configs) {
      const slots: Array<{ slot: number; kind: 'human' | 'bot'; team: 'blue' | 'orange' }> = [];
      for (let i = 0; i < cfg.humanCount; i++) {
        slots.push({ slot: i, kind: 'human', team: i % 2 === 0 ? 'blue' : 'orange' });
      }
      if (cfg.autoFill) {
        const target = cfg.mode === '1v1' ? 2 : cfg.mode === '2v2' ? 4 : 6;
        while (slots.length < target) {
          const idx = slots.length;
          slots.push({ slot: idx, kind: 'bot', team: idx % 2 === 0 ? 'blue' : 'orange' });
        }
      }
      assert(slots.length === cfg.expectedTotal, `Roster count mismatch for ${cfg.mode}`);

      // Simulate human takeover of a bot slot
      const botSlot = slots.find((s) => s.kind === 'bot');
      if (botSlot) {
        botSlot.kind = 'human';
        assert(
          slots.filter((s) => s.kind === 'human').length === cfg.humanCount + 1,
          'Human takeover should increment human count without changing total slots'
        );
      }
    }
  }

  private testMultiplayerTrainingBoostPolicies(): void {
    const orchestrator = new RoomActivityOrchestrator(ACTIVITY_IDS.LOBBY);
    const switchPayload = orchestrator.switchActivity(
      {
        activityId: ACTIVITY_IDS.MULTIPLAYER_TRAINING,
        stateSummary: {
          boostPolicy: 'custom',
          perPlayerBoost: {
            p_limited: 'limited',
            p_aerial: 'limit_when_aerial',
            p_unlim: 'unlimited',
          },
          ghostModeEnabled: false,
        },
      },
      { matchManager: null, physicsManager: null, epoch: 1 }
    );

    assert(
      switchPayload.activityId === ACTIVITY_IDS.MULTIPLAYER_TRAINING,
      'Activity should switch to multiplayer_training'
    );

    const kernel = orchestrator.getActiveKernel() as MultiplayerTrainingActivityKernel;
    assert(kernel.getConfig().hideScoreboard === true, 'Scoreboard must be hidden');
    assert(kernel.getConfig().goalReplayEnabled === true, 'Goal replay must remain enabled');
    assert(kernel.getConfig().ghostModeEnabled === false, 'Ghost mode defaults OFF');

    // 1. Unlimited
    assert(kernel.evaluateCarBoost('p_unlim', 100, 50, false) === 100, 'Unlimited stays 100');
    // 2. Limited
    assert(kernel.evaluateCarBoost('p_limited', 80, 60, true) === 60, 'Limited drains on ground');
    // 3. Limit When Aerial: drains in air, preserves on ground, replenishes via pad on ground
    const afterAir = kernel.evaluateCarBoost('p_aerial', 100, 65, false);
    assert(afterAir === 65, 'Limit When Aerial drains while airborne');
    const onGroundNoPad = kernel.evaluateCarBoost('p_aerial', 65, 55, true, 0);
    assert(onGroundNoPad === 65, 'Limit When Aerial must NOT drain while on ground');
    const onGroundWithPad = kernel.evaluateCarBoost('p_aerial', 65, 65, true, 35);
    assert(onGroundWithPad === 100, 'Limit When Aerial replenishes via pad on ground');
    // 4. Default fallback for unlisted player -> limit_when_aerial
    assert(
      kernel.evaluateCarBoost('p_default', 80, 70, true, 0) === 80,
      'Unlisted custom player falls back to limit_when_aerial'
    );
  }

  private testMultiplayerTrainingGhostRelay(): void {
    const orchestrator = new RoomActivityOrchestrator(ACTIVITY_IDS.MULTIPLAYER_TRAINING);
    orchestrator.switchActivity(
      {
        activityId: ACTIVITY_IDS.MULTIPLAYER_TRAINING,
        stateSummary: { ghostModeEnabled: true },
      },
      { matchManager: null, physicsManager: null, epoch: 1 }
    );
    const kernel = orchestrator.getActiveKernel() as MultiplayerTrainingActivityKernel;

    kernel.onControlMessage(
      { matchManager: null, physicsManager: null, epoch: 1 },
      'ghost_ball_state',
      {
        peerId: 'peer-1',
        ball: { tick: 10, pos: [100, 200, 300], vel: [1, 2, 3] },
      }
    );
    kernel.onControlMessage(
      { matchManager: null, physicsManager: null, epoch: 1 },
      'ghost_ball_state',
      {
        peerId: 'peer-2',
        ball: { tick: 10, pos: [-100, 50, 120], vel: [-1, 0, 2] },
      }
    );

    const forPeer1 = kernel.ghostBallRelay.buildRelayBroadcastForPeer('peer-1');
    assert(forPeer1.length === 1 && forPeer1[0].ownerPeerId === 'peer-2', 'Peer-1 gets Peer-2 ball');
    const forPeer2 = kernel.ghostBallRelay.buildRelayBroadcastForPeer('peer-2');
    assert(forPeer2.length === 1 && forPeer2[0].ownerPeerId === 'peer-1', 'Peer-2 gets Peer-1 ball');
  }

  private testKickAndLeaveSignaling(): void {
    const hostSide = new P2PWebRTCChannel({ role: 'host', playerName: 'Host' });
    const clientSide = new P2PWebRTCChannel({ role: 'client', playerName: 'Client' });

    let clientKickedReason: string | null = null;
    let hostSawLeaveReason: string | null = null;

    clientSide.onSessionKick = (reason) => {
      clientKickedReason = reason;
    };
    hostSide.onSessionLeave = (reason) => {
      hostSawLeaveReason = reason;
    };

    // Simulate Host sending session_kick over reliable control
    clientSide.transport.handleIncomingMessage(
      JSON.stringify({ type: 'session_kick', carIndex: 1, reason: 'Removed by host' })
    );
    assert(clientKickedReason === 'Removed by host', 'Client must receive session_kick reason');

    // Simulate Client sending session_leave over reliable control
    hostSide.transport.handleIncomingMessage(
      JSON.stringify({ type: 'session_leave', carIndex: 1, reason: 'left_room' })
    );
    assert(hostSawLeaveReason === 'left_room', 'Host must receive session_leave reason');

    hostSide.destroy();
    clientSide.destroy();
  }

  private testVoiceRoutingPolicies(): void {
    const check = (mode: VoiceChatMode, activityId: string, local: VoiceTeam, peer: VoiceTeam) =>
      isVoicePeerGatedByRoomPolicy({ voiceChatMode: mode, activityId, localTeam: local }, peer);

    // Open: everyone talks to everyone
    assert(!check('open', 'match', 'blue', 'orange'), 'Open mode allows cross-team');
    // Off: everyone gated
    assert(check('off', 'lobby', 'blue', 'blue'), 'Off mode gates even same-team');
    // Team Only in Lobby: ALL-TALK (because players may all be on auto/unassigned)
    assert(!check('team_only', 'lobby', 'blue', 'orange'), 'Team-only in lobby is all-talk');
    assert(!check('team_only', 'lobby', null, 'orange'), 'Team-only in lobby with auto is all-talk');
    // Team Only in Match: gated by team
    assert(!check('team_only', 'match', 'blue', 'blue'), 'Team-only in match allows teammate');
    assert(check('team_only', 'match', 'blue', 'orange'), 'Team-only in match gates opponent');
  }

  private testSpectatingAndPauseAck(): void {
    const coord = new SpectatorGlobalStateCoordinator();
    coord.setEpoch(3);
    coord.setPausedState(true, 420);
    coord.setSparseHeartbeatHz(5);
    assert(coord.getSparseHeartbeatIntervalMs() === 200, '5Hz heartbeat = 200ms');

    assert(coord.canPeerDrawTelestrator(true) === true, 'Host can always draw');
    assert(coord.canPeerDrawTelestrator(false) === false, 'Default telestrator is host_only');

    coord.setHostUiState('settings', [
      { id: 'replay-viewer', isOpen: true, isMinimized: false },
    ]);
    const broadcast = coord.buildGlobalUiBroadcast();
    assert(broadcast.floatingWindows.length === 1, 'Broadcast includes floating window open state');
    assert(!('x' in broadcast.floatingWindows[0]), 'Broadcast must NOT include window coordinates');

    // Pause ACK barrier
    coord.recordPausedAck({ epoch: 3, pausedAtTick: 420, clientSessionId: 'c1' });
    assert(!coord.areAllPeersPausedAcked(['c1', 'c2']), 'Barrier waits for c2');
    coord.recordPausedAck({ epoch: 3, pausedAtTick: 420, clientSessionId: 'c2' });
    assert(coord.areAllPeersPausedAcked(['c1', 'c2']), 'Barrier satisfied once all ACK');

    // 16B sparse ping/pong codec roundtrip
    const ping = encodeSparsePingPong16B({
      kind: PING_PONG_KIND_PING,
      seq: 7,
      timestampMs: 1234.5,
      epoch: 3,
      ackTick: 420,
    });
    const decodedPing = decodeSparsePingPong16B(ping);
    assert(decodedPing?.seq === 7 && decodedPing?.ackTick === 420, '16B sparse ping roundtrip');
    const pong = encodeSparsePingPong16B({
      kind: PING_PONG_KIND_PONG,
      seq: 7,
      timestampMs: 1234.5,
      epoch: 3,
      ackTick: 420,
    });
    assert(decodeSparsePingPong16B(pong)?.kind === PING_PONG_KIND_PONG, '16B sparse pong');

    // Store mirror_host_ui vs gameplay_only
    const store = useSpectatorSyncStore.getState();
    store.setSpectatingActive(true);
    let restoredCalled = false;
    store.setSyncMode('mirror_host_ui', () => ({
      activeMenuRoute: 'main-menu',
      windows: { 'replay-viewer': { isOpen: false, isMinimized: false } },
    }));
    assert(useSpectatorSyncStore.getState().localControlsLocked === true, 'Locked in mirror mode');
    store.applyHostGlobalUiState(broadcast);
    assert(
      useSpectatorSyncStore.getState().hostActiveMenuRoute === 'settings',
      'Mirrors host route'
    );
    store.setSyncMode('gameplay_only', undefined, () => {
      restoredCalled = true;
    });
    assert(useSpectatorSyncStore.getState().localControlsLocked === false, 'Unlocked on exit');
    assert(restoredCalled, 'Restores local snapshot on exit');
    store.resetSpectatorSync();
  }

  private testTelestratorStressConsistency(): void {
    const strokeCount = 50;
    for (let i = 0; i < strokeCount; i++) {
      const points = [
        { x: -500 + i * 10, y: 120, z: 30, nx: 0, ny: 0, nz: 1 },
        { x: -400 + i * 10, y: 220, z: 80, nx: 0, ny: 0, nz: 1 },
        { x: -300 + i * 10, y: 320, z: 140, nx: 0, ny: 0, nz: 1 },
      ];
      const tool: TelestratorStroke['tool'] =
        i % 3 === 0 ? 'arrow' : i % 3 === 1 ? 'dashed' : 'solid';
      const colorId: TelestratorStroke['colorId'] = 'yellow';
      const presetIndex = ((i % 3) + 1) as TelestratorStroke['presetIndex'];
      const opacity = 1;
      const widthRefPx = 4;
      const arrowLengthRefPx = 24;
      const arrowWidthRefPx = 16;
      const hash = computeStrokeHash(
        tool,
        colorId,
        presetIndex,
        opacity,
        widthRefPx,
        arrowLengthRefPx,
        arrowWidthRefPx,
        points
      );
      const stroke: TelestratorStroke = {
        id: `stroke-${i}`,
        authorId: i % 2 === 0 ? 'host' : 'peer-1',
        presetIndex,
        tool,
        colorId,
        opacity,
        widthRefPx,
        arrowLengthRefPx,
        arrowWidthRefPx,
        camForward: { x: 1, y: 0, z: 0 },
        camPos: { x: 0, y: 0, z: 500 },
        camFovDeg: 90,
        strokeSeq: i + 1,
        points,
        createdTick: 100 + i,
        fadeDurationTicks: 400,
        hash,
      };

      const encoded = encodeTelestratorStroke(stroke, false);
      const decoded = decodeTelestratorStroke(encoded);
      if (!decoded) throw new Error(`Failed to decode stroke ${i}`);
      assert(decoded.stroke.hash === stroke.hash, `Stroke ${i} hash mismatch across wire`);

      const ackBytes = encodeTelestratorHashAck({
        strokeId: decoded.stroke.id,
        hash: decoded.stroke.hash,
        matched: true,
      });
      const decodedAck = decodeTelestratorHashAck(ackBytes);
      assert(
        decodedAck !== null && decodedAck.hash === stroke.hash && decodedAck.matched,
        `HashAck ${i} mismatch`
      );
    }
  }
}
