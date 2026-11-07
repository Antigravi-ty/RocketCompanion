import {
  createDefaultHostChannel,
  deliverToHostLoopback,
  type HostLoopbackChannelPort,
} from './HostLoopbackChannel.ts';
import {
  GlobalPayloadCodec,
  MATCH_SIGNALS,
  applyBoostPadEdgeCooldowns,
  type BoostPadEdgeTracker,
  type MatchSignalDescriptor,
  type AcknowledgedCarControlEntry,
} from '../protocol/GlobalPayloadCodec.ts';
import { EstablishedSessionManager } from './EstablishedSessionManager.ts';
import {
  HOST_WORKER_MSG_TYPES,
  createWorkerEnvelope,
  type WorkerEnvelope,
} from '../protocol/HostWorkerProtocol.ts';
import type {
  WorkerRoomStateSummary,
  HostWorkerInitOptions,
} from './HostWorkerMessageRouter.ts';
import { REPLAY_BUFFER_MODES, type ReplayRingBuffer, type ReplayAcknowledgedControlEntry, type ReplaySignalsOrOptionsArg } from '../../replay/ReplayRingBuffer.ts';
import type { HostSimProxyPort, HostSimRestoreStateResult } from './HostSimProxy.ts';
import type { NetworkDataHandler } from './NetworkDataHandler.ts';
import type { MatchSessionAdmin } from './match/MatchSessionAdmin.ts';

export interface HostClientChannelPort extends HostLoopbackChannelPort {
  peerName?: string;
  visualId?: string;
  colorSlot?: number;
  send?(packet: Uint8Array | ArrayBuffer | string): void;
  sendServerState?(packet: Uint8Array | ArrayBuffer | string): void;
  sendClientInput?(packet: Uint8Array | ArrayBuffer | string): void;
  onPacketReceived?: ((packet: Uint8Array | ArrayBuffer | string) => void) | null;
}

export interface HostWorkerEnvelopeMessage {
  type?: string;
  seq?: number;
  payload?: unknown;
  channelId?: string;
  packet?: Uint8Array | ArrayBuffer | string;
  reqId?: number;
  result?: unknown;
}

export interface DecodedHostLoopbackFrame {
  roomStatePhase: string | null;
  hasPhysics: boolean;
  snapshot: Float32Array | null;
  tick: number;
  newReplaySignals: MatchSignalDescriptor[];
  acknowledgedControls: AcknowledgedCarControlEntry[] | null;
}

export interface HostLoopbackPacketConsumerPort {
  lastRoomState: Partial<WorkerRoomStateSummary> | null;
  botTunnelManager?: {
    syncFromRoomState?(state: Partial<WorkerRoomStateSummary> | null): void;
    onServerPhysicsFrame(snapshot: Float32Array, tick: number, state: string): void;
  } | null;
  hostChannel: HostLoopbackChannelPort | null;
  boostPadEdgeTracker: BoostPadEdgeTracker;
  _seenReplaySignalIds: Set<string>;
  cachedSnapshot: Float32Array;
  lastServerTick: number;
  isWorker: boolean;
  hostReplayRingBuffer?: ReplayRingBuffer | null;
}

export interface HostChannelRegistryBridgePort extends HostSimProxyPort, HostLoopbackPacketConsumerPort {
  fallbackManager: MatchSessionAdmin | null;
  routeFallbackEnvelope(
    envelope: WorkerEnvelope,
    onReply: (replyEnv: HostWorkerEnvelopeMessage) => void
  ): void;
}

function resolveRoomStatePhaseFromSignal(signalType: number): string | null {
  if (
    signalType === MATCH_SIGNALS.KICKOFF_START ||
    signalType === MATCH_SIGNALS.ROUND_STARTED ||
    signalType === MATCH_SIGNALS.OVERTIME_START
  ) {
    return 'playing';
  }
  if (
    signalType === MATCH_SIGNALS.KICKOFF_WILL_START ||
    signalType === MATCH_SIGNALS.GOAL_REPLAY_END ||
    signalType === MATCH_SIGNALS.MATCH_STARTED
  ) {
    return 'kickoff';
  }
  if (
    signalType === MATCH_SIGNALS.GOAL_REPLAY_WILL_START ||
    signalType === MATCH_SIGNALS.GOAL_REPLAY_START
  ) {
    return 'replay';
  }
  if (signalType === MATCH_SIGNALS.MATCH_PREPARE) return 'prepare';
  if (signalType === MATCH_SIGNALS.MATCH_ENDED || signalType === MATCH_SIGNALS.PODIUM_START) {
    return 'ended';
  }
  return null;
}

export function decodeHostLoopbackFramePacket(
  packet: Uint8Array | ArrayBuffer,
  boostPadEdgeTracker: BoostPadEdgeTracker,
  seenReplaySignalIds: Set<string>
): DecodedHostLoopbackFrame | null {
  const clientHeader = EstablishedSessionManager.parseClientPacket(packet);
  if (!clientHeader?.globalPayloadSlice) return null;

  const globalPayload = GlobalPayloadCodec.decode(clientHeader.globalPayloadSlice);
  let roomStatePhase: string | null = null;
  const newReplaySignals: MatchSignalDescriptor[] = [];

  if (Array.isArray(globalPayload?.signals)) {
    for (let s = 0; s < globalPayload.signals.length; s++) {
      const sig = globalPayload.signals[s];
      if (!sig) continue;
      const phase = resolveRoomStatePhaseFromSignal(sig.signalType);
      if (phase) roomStatePhase = phase;
      if (
        sig.signalType === MATCH_SIGNALS.CLOCK_UPDATED_SECONDS ||
        sig.signalType === MATCH_SIGNALS.COMMAND_ACK
      ) {
        continue;
      }
      const key = sig.signalId ? `id_${sig.signalId}` : `${sig.signalType}_${sig.frameId}`;
      if (!seenReplaySignalIds.has(key)) {
        seenReplaySignalIds.add(key);
        newReplaySignals.push(sig);
      }
    }
  }

  if (globalPayload?.hasPhysics && globalPayload.physics?.stateSnapshot) {
    const snap = globalPayload.physics.stateSnapshot;
    applyBoostPadEdgeCooldowns(snap, globalPayload.physics.tick, boostPadEdgeTracker);
    return {
      roomStatePhase,
      hasPhysics: true,
      snapshot: snap,
      tick: globalPayload.physics.tick,
      newReplaySignals,
      acknowledgedControls: globalPayload.physics.acknowledgedControls || null,
    };
  }

  return {
    roomStatePhase,
    hasPhysics: false,
    snapshot: null,
    tick: 0,
    newReplaySignals,
    acknowledgedControls: null,
  };
}

export function processHostLoopbackChannelPacket(
  host: HostLoopbackPacketConsumerPort,
  packet: Uint8Array | ArrayBuffer | string | undefined
): void {
  if (!packet) return;
  if (typeof packet === 'string') {
    try {
      const parsed = JSON.parse(packet);
      if (parsed?.type === 'roster_update') {
        host.lastRoomState = {
          ...(host.lastRoomState || {}),
          state: parsed.state || host.lastRoomState?.state || 'lobby',
          roster: parsed.roster || host.lastRoomState?.roster || { players: [], spectators: [] },
        };
        host.botTunnelManager?.syncFromRoomState?.(host.lastRoomState);
      }
    } catch (_e) {}
  }
  if (!deliverToHostLoopback(host.hostChannel, packet)) return;
  if (packet instanceof Uint8Array || packet instanceof ArrayBuffer) {
    try {
      const decoded = decodeHostLoopbackFramePacket(
        packet,
        host.boostPadEdgeTracker,
        host._seenReplaySignalIds
      );
      if (decoded) {
        if (decoded.roomStatePhase) {
          if (!host.lastRoomState) {
            host.lastRoomState = {
              state: decoded.roomStatePhase,
              roster: {
                players: [],
                spectators: [],
                gameMode: '3v3',
                botFillMode: 'no_bots',
                durationSeconds: 300,
                clockSeconds: 300,
                score: { blue: 0, orange: 0 },
              },
            };
          } else {
            host.lastRoomState.state = decoded.roomStatePhase;
          }
        }
        if (decoded.hasPhysics && decoded.snapshot) {
          if (host.cachedSnapshot.length !== decoded.snapshot.length) {
            host.cachedSnapshot = new Float32Array(decoded.snapshot.length);
          }
          host.cachedSnapshot.set(decoded.snapshot);
          host.lastServerTick = decoded.tick;
          if (host.botTunnelManager && host.isWorker) {
            host.botTunnelManager.onServerPhysicsFrame(
              host.cachedSnapshot,
              host.lastServerTick,
              host.lastRoomState?.state || 'playing'
            );
          }
          const isReplaySliceFrame =
            Math.abs((host.cachedSnapshot[302] || 0) - 1337.5) <= 0.01 ||
            host.lastRoomState?.state === 'replay';
          if (!isReplaySliceFrame) {
            host.hostReplayRingBuffer?.recordFrame(
              host.lastServerTick,
              host.cachedSnapshot,
              decoded.newReplaySignals as unknown as ReplaySignalsOrOptionsArg,
              null,
              null,
              decoded.acknowledgedControls as unknown as readonly ReplayAcknowledgedControlEntry[] | null
            );
          }
        }
      }
    } catch (err) {
      console.warn('[HostServerWorker] Failed to decode authoritative frame packet:', err);
    }
  }
}

export class HostClientChannelRegistry {
  channels: HostClientChannelPort[] = [];
  channelMap = new Map<HostClientChannelPort, string>();
  channelIdToChannel = new Map<string, HostClientChannelPort>();
  nextChannelId = 1;
  hostChannel: HostClientChannelPort;
  pendingRequests = new Map<number, { resolve: (val: unknown) => void }>();
  envelopeListeners = new Set<(envelope: HostWorkerEnvelopeMessage) => void>();
  reqId = 0;

  constructor(
    hostBridge: HostSimProxyPort,
    initialChannel: HostClientChannelPort | null = null
  ) {
    this.hostChannel = initialChannel || createDefaultHostChannel(hostBridge);
    this.channelMap.set(this.hostChannel, 'host');
    this.channelIdToChannel.set('host', this.hostChannel);
  }

  createDefaultHostChannel(hostBridge: HostSimProxyPort): HostClientChannelPort {
    return createDefaultHostChannel(hostBridge);
  }

  addEnvelopeListener(fn: (envelope: HostWorkerEnvelopeMessage) => void): () => void {
    if (typeof fn === 'function') {
      this.envelopeListeners.add(fn);
      return () => this.envelopeListeners.delete(fn);
    }
    return () => {};
  }

  notifyEnvelopeListeners(envelope: HostWorkerEnvelopeMessage): void {
    for (const listener of this.envelopeListeners) {
      try {
        listener(envelope);
      } catch (err) {
        console.warn('[HostServerWorker] Error in envelope listener:', err);
      }
    }
  }

  handleWorkerMessage(
    bridge: HostLoopbackPacketConsumerPort,
    data: HostWorkerEnvelopeMessage | null | undefined
  ): void {
    if (!data) return;
    if (data.type && data.payload !== undefined) {
      if (data.type === HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC) {
        bridge.lastRoomState = data.payload as Partial<WorkerRoomStateSummary>;
        bridge.botTunnelManager?.syncFromRoomState?.(bridge.lastRoomState);
      }
      if (data.seq && this.pendingRequests.has(data.seq)) {
        const req = this.pendingRequests.get(data.seq)!;
        this.pendingRequests.delete(data.seq);
        req.resolve(data.payload);
      }
      this.notifyEnvelopeListeners(data);
    }

    switch (data.type) {
      case 'channel_packet': {
        const { channelId, packet } = data;
        if (channelId === 'host') {
          processHostLoopbackChannelPacket(bridge, packet);
        } else if (channelId && packet !== undefined) {
          const ch = this.channelIdToChannel.get(channelId);
          if (ch) {
            if (typeof ch.send === 'function') ch.send(packet);
            else if (typeof ch.sendServerState === 'function') ch.sendServerState(packet);
          }
        }
        break;
      }
      case 'requestResponse': {
        const { reqId, result } = data;
        if (typeof reqId === 'number' && this.pendingRequests.has(reqId)) {
          const req = this.pendingRequests.get(reqId)!;
          this.pendingRequests.delete(reqId);
          req.resolve(result);
        }
        break;
      }
      default:
        break;
    }
  }

  sendEnvelope(
    bridge: HostChannelRegistryBridgePort,
    type: string,
    payload: HostWorkerInitOptions & { replayCapacityTicks?: number | null } = {},
    transfer: Transferable[] = [],
    seqOverride: number | null = null
  ): WorkerEnvelope {
    if (type === HOST_WORKER_MSG_TYPES.MATCH_START_REQUEST) {
      bridge.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
      bridge.hostReplayRingBuffer?.clear();
      bridge._seenReplaySignalIds?.clear();
    } else if (type === HOST_WORKER_MSG_TYPES.ROOM_CREATE) {
      bridge.hostReplayRingBuffer?.configureMode?.(
        payload.startAsMatch ? REPLAY_BUFFER_MODES.COUNTDOWN_MATCH : REPLAY_BUFFER_MODES.COUNTUP_FIFO,
        payload.replayCapacityTicks || null
      );
      bridge.hostReplayRingBuffer?.clear();
      bridge._seenReplaySignalIds?.clear();
    }
    const seq = seqOverride ?? ++this.reqId;
    const envelope = createWorkerEnvelope(type, payload, seq);
    if (bridge.isWorker && bridge.worker) {
      bridge.worker.postMessage(envelope, transfer);
    } else {
      bridge.routeFallbackEnvelope(envelope, (replyEnv) => this.handleWorkerMessage(bridge, replyEnv));
    }
    return envelope;
  }

  sendRequest(
    postCommand: (type: string, data: Record<string, unknown>) => void,
    type: string,
    data: Record<string, unknown> = {}
  ): Promise<HostSimRestoreStateResult> {
    return new Promise((resolve) => {
      const reqId = ++this.reqId;
      this.pendingRequests.set(reqId, {
        resolve: (val) => resolve((val || {}) as HostSimRestoreStateResult),
      });
      postCommand(type, { reqId, ...data });
    });
  }

  addClientChannel(
    channel: HostClientChannelPort | null | undefined,
    overrideId: string | null,
    isWorker: boolean,
    worker: Worker | null,
    postCommand: (type: string, data: Record<string, unknown>) => void,
    fallbackDataHandler: NetworkDataHandler | null
  ): string | null {
    if (!channel) return null;
    if (this.channelMap.has(channel)) return this.channelMap.get(channel)!;
    const channelId = overrideId || `peer_${this.nextChannelId++}`;
    this.channels.push(channel);
    this.channelMap.set(channel, channelId);
    this.channelIdToChannel.set(channelId, channel);

    const origPacketReceived = channel.onPacketReceived;
    channel.onPacketReceived = (packet: Uint8Array | ArrayBuffer | string) => {
      origPacketReceived?.(packet);
      if (isWorker && worker) {
        postCommand('channel_packet', { channelId, packet });
      } else if (fallbackDataHandler && packet instanceof Uint8Array) {
        fallbackDataHandler.handleIncomingPacket(channelId, packet, performance.now());
      } else if (fallbackDataHandler && packet instanceof ArrayBuffer) {
        fallbackDataHandler.handleIncomingPacket(
          channelId,
          new Uint8Array(packet),
          performance.now()
        );
      }
    };

    if (isWorker && worker) {
      postCommand('registerChannel', {
        channelId,
        playerName: channel.peerName || 'Player',
        visualId: channel.visualId || 'octane',
        colorSlot: channel.colorSlot ?? 0,
      });
    } else if (fallbackDataHandler) {
      fallbackDataHandler.registerChannel(channelId, {
        send: (pkt) => {
          if (typeof channel.send === 'function') channel.send(pkt);
        },
      });
    }
    return channelId;
  }

  removeClientChannel(
    channel: HostClientChannelPort,
    isWorker: boolean,
    worker: Worker | null,
    postCommand: (type: string, data: Record<string, unknown>) => void,
    fallbackDataHandler: NetworkDataHandler | null,
    fallbackManager: MatchSessionAdmin | null
  ): void {
    const channelId = this.channelMap.get(channel);
    if (!channelId) return;
    const idx = this.channels.indexOf(channel);
    if (idx !== -1) this.channels.splice(idx, 1);
    this.channelMap.delete(channel);
    this.channelIdToChannel.delete(channelId);

    if (isWorker && worker) {
      postCommand('removeChannel', { channelId });
    } else if (fallbackDataHandler) {
      fallbackDataHandler.unregisterChannel(channelId);
      fallbackManager?.removePlayerSession(channelId);
    }
  }

  destroy(): void {
    this.channels = [];
    this.channelMap.clear();
    this.channelIdToChannel.clear();
    this.pendingRequests.clear();
    this.envelopeListeners.clear();
  }
}
