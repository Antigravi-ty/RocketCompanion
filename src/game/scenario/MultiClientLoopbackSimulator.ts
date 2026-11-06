/**
 * MultiClientLoopbackSimulator.ts
 * Stateful SubController simulating a 6-car (3v3) multiplayer match over in-memory
 * loopback channels without requiring WebRTC or external signaling servers.
 * Registers 5 virtual remote peers (peer_1..peer_5) alongside the local host (car 0),
 * assigns 6 distinct vehicle models, hitboxes, paint finishes, boost visuals, and boost audio,
 * decodes authoritative server frames per peer to acknowledge signals and barrier commands,
 * and injects deterministic binary InputPacketCodec frames at 120Hz.
 */

import {
  CLIENT_COMMAND_TYPES,
  GlobalPayloadCodec,
  MATCH_SIGNALS,
} from '../../network/protocol/GlobalPayloadCodec.ts';
import {
  InputPacketCodec,
  type CarControlsInput,
  type ClientCommandWireItem,
  type InputHistoryEntry,
  type SignalAckWireItem,
} from '../../network/protocol/InputPacketCodec.ts';
import { EstablishedSessionManager } from '../../network/server/EstablishedSessionManager.ts';
import { roundMetric } from './scenarioMetricsPipeline.ts';
import type {
  MultiplayerLoopbackTelemetry,
  VirtualPeerLoadoutSpec,
} from './ScenarioTypes.ts';

export const SIX_CAR_STRESS_LOADOUTS: readonly VirtualPeerLoadoutSpec[] = Object.freeze([
  {
    peerId: 'host',
    playerName: 'Host_Fennec_Octane',
    carIndex: 0,
    team: 0,
    visualId: 'fennec',
    hitboxId: 'hitbox-octane',
    colorSlot: 0,
    paintFinish: 'metallic',
    boostVisual: 'gold-rush',
    boostAudio: 'rush',
  },
  {
    peerId: 'peer_1',
    playerName: 'Peer1_Insidio_Hybrid',
    carIndex: 1,
    team: 1,
    visualId: 'insidio',
    hitboxId: 'hitbox-hybrid',
    colorSlot: 5,
    paintFinish: 'matte',
    boostVisual: 'cartoon',
    boostAudio: 'standard',
  },
  {
    peerId: 'peer_2',
    playerName: 'Peer2_Ryza_Dominus',
    carIndex: 2,
    team: 0,
    visualId: 'ryza',
    hitboxId: 'hitbox-dominus',
    colorSlot: 1,
    paintFinish: 'metallic',
    boostVisual: 'cartoon',
    boostAudio: 'flamethrower',
  },
  {
    peerId: 'peer_3',
    playerName: 'Peer3_Plank_Batmobile',
    carIndex: 3,
    team: 1,
    visualId: 'hitbox-plank',
    hitboxId: 'hitbox-plank',
    colorSlot: 6,
    paintFinish: 'matte',
    boostVisual: 'gold-rush',
    boostAudio: 'plasma',
  },
  {
    peerId: 'peer_4',
    playerName: 'Peer4_Breakout_Blade',
    carIndex: 4,
    team: 0,
    visualId: 'hitbox-breakout',
    hitboxId: 'hitbox-breakout',
    colorSlot: 2,
    paintFinish: 'metallic',
    boostVisual: 'gold-rush',
    boostAudio: 'standard',
  },
  {
    peerId: 'peer_5',
    playerName: 'Peer5_Merc_Heavy',
    carIndex: 5,
    team: 1,
    visualId: 'hitbox-merc',
    hitboxId: 'hitbox-merc',
    colorSlot: 7,
    paintFinish: 'matte',
    boostVisual: 'cartoon',
    boostAudio: 'rush',
  },
]);

interface VirtualPeerChannelState {
  readonly spec: VirtualPeerLoadoutSpec;
  readonly channel: {
    peerId: string;
    peerName: string;
    carIndex: number;
    visualId: string;
    hitboxId: string;
    colorSlot: number;
    paintFinish: string;
    boostVisual: string;
    boostAudio: string;
    measuredRttMs: number;
    rttMs: number;
    onPacketReceived?: ((packet: Uint8Array | ArrayBuffer | string) => void) | null;
    send: (payload: string | Uint8Array | ArrayBuffer) => void;
    close: () => void;
    destroy: () => void;
  };
  readonly recentInputs: InputHistoryEntry[];
  readonly pendingAcks: SignalAckWireItem[];
  readonly pendingCommands: ClientCommandWireItem[];
  readonly seenSignalIds: Set<number>;
  nextCommandId: number;
  lastServerTick: number;
}

export class MultiClientLoopbackSimulator {
  private readonly runtime: any;
  private readonly peers: VirtualPeerChannelState[] = [];
  private readonly distinctSignalNames = new Set<string>();
  private totalClientInputPacketsSent = 0;
  private totalClientInputBytesSent = 0;
  private totalServerFramePacketsReceived = 0;
  private totalServerFrameBytesReceived = 0;
  private totalSignalsDecoded = 0;
  private peakActivePhysicalCars = 0;
  private peakVisibleArenaCars = 0;
  private active = false;

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  public isActive(): boolean {
    return this.active;
  }

  public resetMetrics(): void {
    this.distinctSignalNames.clear();
    this.totalClientInputPacketsSent = 0;
    this.totalClientInputBytesSent = 0;
    this.totalServerFramePacketsReceived = 0;
    this.totalServerFrameBytesReceived = 0;
    this.totalSignalsDecoded = 0;
    this.peakActivePhysicalCars = 0;
    this.peakVisibleArenaCars = 0;
  }

  public async startSixCarLoopbackSession(durationSeconds = 300): Promise<void> {
    this.resetMetrics();
    this.peers.length = 0;

    const hostSpec = SIX_CAR_STRESS_LOADOUTS[0];
    const netMgr = this.runtime?.networkManager;
    if (!netMgr) {
      throw new Error('[MultiClientLoopbackSimulator] runtime.networkManager is unavailable');
    }

    await netMgr.sessionCoordinator.hostOnlineServer({
      playerName: hostSpec.playerName,
      visualId: hostSpec.visualId,
      hitboxId: hostSpec.hitboxId,
      colorSlot: hostSpec.colorSlot,
      paintFinish: hostSpec.paintFinish,
      boostVisual: hostSpec.boostVisual,
      boostAudio: hostSpec.boostAudio,
      gameMode: '3v3',
      botFillMode: 'no_bots',
      durationSeconds,
      lobbyMode: true,
      skipReplayByDefault: false,
      forceFallback: true,
      roomId: 'scenario_6car_stress',
    });

    for (let i = 1; i < SIX_CAR_STRESS_LOADOUTS.length; i++) {
      const spec = SIX_CAR_STRESS_LOADOUTS[i];
      const peerState = this.createVirtualPeerState(spec);
      this.peers.push(peerState);

      await netMgr.rosterSyncCoordinator.onRemotePlayerConnected(
        peerState.channel,
        spec.playerName,
        spec.carIndex,
      );

      const joinHandshake = JSON.stringify({
        type: 'join',
        name: spec.playerName,
        visualId: spec.visualId,
        hitboxId: spec.hitboxId,
        colorSlot: spec.colorSlot,
        paintFinish: spec.paintFinish,
        boostVisual: spec.boostVisual,
        boostAudio: spec.boostAudio,
        preferredTeam: spec.team,
      });
      peerState.channel.onPacketReceived?.(joinHandshake);
    }

    this.active = true;
  }

  public triggerForceStartMatch(durationSeconds = 300): void {
    this.runtime?.networkManager?.forceStartOnlineMatch?.(durationSeconds);
  }

  private createVirtualPeerState(spec: VirtualPeerLoadoutSpec): VirtualPeerChannelState {
    const state: VirtualPeerChannelState = {
      spec,
      recentInputs: [],
      pendingAcks: [],
      pendingCommands: [],
      seenSignalIds: new Set<number>(),
      nextCommandId: 1,
      lastServerTick: 0,
      channel: {
        peerId: spec.peerId,
        peerName: spec.playerName,
        carIndex: spec.carIndex,
        visualId: spec.visualId,
        hitboxId: spec.hitboxId,
        colorSlot: spec.colorSlot,
        paintFinish: spec.paintFinish,
        boostVisual: spec.boostVisual,
        boostAudio: spec.boostAudio,
        measuredRttMs: 10,
        rttMs: 10,
        onPacketReceived: null,
        send: (payload: string | Uint8Array | ArrayBuffer) => {
          this.handleServerPacketToVirtualPeer(state, payload);
        },
        close: () => {},
        destroy: () => {},
      },
    };
    return state;
  }

  private handleServerPacketToVirtualPeer(
    peer: VirtualPeerChannelState,
    payload: string | Uint8Array | ArrayBuffer,
  ): void {
    if (typeof payload === 'string') {
      this.totalServerFramePacketsReceived++;
      this.totalServerFrameBytesReceived += payload.length;
      return;
    }

    const byteLength = payload.byteLength;
    this.totalServerFramePacketsReceived++;
    this.totalServerFrameBytesReceived += byteLength;

    const header = EstablishedSessionManager.parseClientPacket(payload);
    if (!header?.globalPayloadSlice) return;

    const decoded = GlobalPayloadCodec.decode(header.globalPayloadSlice);
    if (!decoded) return;
    if (decoded.physics && typeof decoded.physics.tick === 'number') {
      peer.lastServerTick = decoded.physics.tick;
    }

    if (Array.isArray(decoded.signals) && decoded.signals.length > 0) {
      for (let i = 0; i < decoded.signals.length; i++) {
        const sig = decoded.signals[i];
        if (!sig) continue;
        this.totalSignalsDecoded++;
        if (sig.name) {
          this.distinctSignalNames.add(sig.name);
        }
        if (typeof sig.signalId === 'number' && sig.signalId > 0) {
          if (!peer.seenSignalIds.has(sig.signalId)) {
            peer.seenSignalIds.add(sig.signalId);
            peer.pendingAcks.push({
              signalId: sig.signalId,
              signalType: sig.signalType,
            });
            if (sig.signalType === MATCH_SIGNALS.MATCH_PREPARE) {
              peer.pendingCommands.push({
                commandId: peer.nextCommandId++,
                commandType: CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK,
                param1: 1,
                param2: 0,
              });
            }
          }
        }
      }
    }
  }

  public computeDeterministicPeerControls(
    carIndex: number,
    tick: number,
  ): CarControlsInput {
    const phase = ((tick + carIndex * 37) % 240) / 240;
    const steerWave = Math.sin(phase * Math.PI * 2);
    const shouldBoost = (tick + carIndex * 19) % 40 < 24;
    const shouldHandbrake = (tick + carIndex * 53) % 180 === 0;
    return {
      throttle: 1.0,
      steer: roundMetric(steerWave * 0.45, 3),
      pitch: 0,
      yaw: roundMetric(steerWave * 0.25, 3),
      roll: 0,
      jump: false,
      boost: shouldBoost,
      handbrake: shouldHandbrake,
    };
  }

  public stepVirtualPeers(tick: number, virtualTimeMs: number): void {
    if (!this.active || this.peers.length === 0) return;

    const serverSimTick =
      this.runtime?.authoritativeServer?.lastServerTick ??
      Math.floor(this.runtime?.physics?.getHeaderView?.()?.tickCount ?? tick);

    for (let i = 0; i < this.peers.length; i++) {
      const peer = this.peers[i];
      const targetTick = Math.max(serverSimTick, peer.lastServerTick) + 2;
      const controls = this.computeDeterministicPeerControls(peer.spec.carIndex, tick);

      peer.recentInputs.unshift({
        tick: targetTick,
        carIndex: peer.spec.carIndex,
        controls,
      });
      if (peer.recentInputs.length > 6) {
        peer.recentInputs.length = 6;
      }

      const acks = peer.pendingAcks.length > 0 ? peer.pendingAcks.splice(0, 8) : [];
      const cmds = peer.pendingCommands.length > 0 ? peer.pendingCommands.splice(0, 4) : [];

      const encodedPacket = InputPacketCodec.encode(
        peer.spec.carIndex,
        targetTick,
        peer.recentInputs,
        virtualTimeMs,
        acks,
        cmds,
      );

      this.totalClientInputPacketsSent++;
      this.totalClientInputBytesSent += encodedPacket.byteLength;
      peer.channel.onPacketReceived?.(encodedPacket);
    }

    this.sampleActiveAndVisibleCarCounts();
  }

  private sampleActiveAndVisibleCarCounts(): { activePhysical: number; visibleArena: number } {
    const r = this.runtime;
    const physics = r?.physics;
    const arena = r?.arena;

    let activePhysical = 0;
    if (physics) {
      for (let i = 0; i < 6; i++) {
        if (typeof physics.isCarSlotActive === 'function') {
          if (physics.isCarSlotActive(i)) activePhysical++;
        } else if (i < (physics.numCars ?? 0)) {
          activePhysical++;
        }
      }
    }

    let visibleArena = 0;
    if (Array.isArray(arena?.cars)) {
      for (let i = 0; i < Math.min(6, arena.cars.length); i++) {
        if (arena.cars[i]?.visible) visibleArena++;
      }
    }

    if (activePhysical > this.peakActivePhysicalCars) {
      this.peakActivePhysicalCars = activePhysical;
    }
    if (visibleArena > this.peakVisibleArenaCars) {
      this.peakVisibleArenaCars = visibleArena;
    }
    return { activePhysical, visibleArena };
  }

  public collectTelemetry(): MultiplayerLoopbackTelemetry {
    const r = this.runtime;
    const reconciler = r?.networkReconciler;
    const current = this.sampleActiveAndVisibleCarCounts();

    return {
      configuredCarCount: SIX_CAR_STRESS_LOADOUTS.length,
      activePhysicalCars: Math.max(current.activePhysical, this.peakActivePhysicalCars),
      visibleArenaCars: Math.max(current.visibleArena, this.peakVisibleArenaCars),
      virtualPeersConnected: this.peers.length,
      totalClientInputPacketsSent: this.totalClientInputPacketsSent,
      totalClientInputBytesSent: this.totalClientInputBytesSent,
      totalServerFramePacketsReceived: this.totalServerFramePacketsReceived,
      totalServerFrameBytesReceived: this.totalServerFrameBytesReceived,
      totalSignalsDecoded: this.totalSignalsDecoded,
      distinctSignalNames: Array.from(this.distinctSignalNames).sort(),
      reconcilerCorrections: reconciler?.totalCorrections ?? 0,
      reconcilerSkippedCorrections: reconciler?.skippedCorrections ?? 0,
      reconcilerHardSnaps: reconciler?.hardSnapCount ?? 0,
      reconcilerMaxCorrectionDelta: roundMetric(reconciler?.maxCorrectionDelta ?? 0, 4),
      loadoutsVerified: [...SIX_CAR_STRESS_LOADOUTS],
    };
  }

  public async stop(): Promise<void> {
    this.active = false;
    this.peers.length = 0;
    if (this.runtime?.networkManager) {
      await this.runtime.networkManager.sessionCoordinator.stopOnlineServer();
    }
  }
}
