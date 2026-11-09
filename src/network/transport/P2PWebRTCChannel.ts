/**
 * P2PWebRTCChannel.ts
 * High-Speed Direct Transport & WebRTC Facade Layer.
 * Coordinates modular sub-layers (NetworkSimulator, CrossTabSignaling, WebRTCConnection,
 * HandshakeSession, and DataChannelTransport) via narrow typed ports.
 */

import { encodeSignalToken, decodeSignalToken } from './webrtc/SignalTokenCodec.ts';
import {
  NetworkSimulator,
  type NetworkSimulatorOptions,
  type SimulatedPayload,
} from './webrtc/NetworkSimulator.ts';
import { CrossTabSignaling } from './webrtc/CrossTabSignaling.ts';
import { WebRTCConnection } from './webrtc/WebRTCConnection.ts';
import type { IceCandidateDescriptor } from './webrtc/SdpUtils.ts';
import { HandshakeSession, type HandshakeMetadataState } from './webrtc/HandshakeSession.ts';
import { DataChannelTransport } from './webrtc/DataChannelTransport.ts';

export interface P2PWebRTCChannelOptions extends NetworkSimulatorOptions {
  role?: string;
  playerName?: string;
  roomId?: string | null;
  colorSlot?: number;
  colorHex?: string;
  signalingChannelName?: string;
}

export type VoidChannelHook = (() => void) | null;
export type PayloadChannelHook = ((data: SimulatedPayload) => void) | null;
export type JsonChannelHook = ((msg: Record<string, unknown>) => void) | null;
export type FleetToggleChannelHook = ((enabled: boolean, anchorMode: string) => void) | null;
export type IceCandidateChannelHook = ((cand: IceCandidateDescriptor) => void) | null;

export class P2PWebRTCChannel {
  role: string;
  isHost?: boolean;
  peerId: string | null = null;
  peerRole?: string;
  carIndex?: number;
  pairingCode: string | null = null;
  allowSpectatorRelay = true;
  playerName: string;
  roomId: string | null;
  localColorSlot: number;
  localColorHex: string;
  peerColorSlot: number | null = null;
  peerColorHex: string | null = null;
  peerName: string | null = null;
  pendingColorChange?: { slotId: number; hex: string; carIndex: number };

  isOpen = false;
  isCrossTab = false;
  isWebRTC = false;
  transportMode = 'none';

  dataChannel: RTCDataChannel | null = null;
  offerToken = '';
  answerToken = '';

  readonly simulator: NetworkSimulator;
  stats: NetworkSimulator['stats'];
  declare extraRttMs: number;
  declare baseMeasuredRttMs: number;
  declare measuredJitterMs: number;
  declare latencyMs: number;

  readonly signaling: CrossTabSignaling;
  readonly connection: WebRTCConnection;
  readonly handshake: HandshakeSession;
  readonly transport: DataChannelTransport;

  onConnected: VoidChannelHook = null;
  onDisconnected: VoidChannelHook = null;
  onPacketReceived: PayloadChannelHook = null;
  onMessage: PayloadChannelHook = null;
  onColorChange: JsonChannelHook = null;
  onDiagnosticFleetToggle: FleetToggleChannelHook = null;
  onBroadcastSignal: JsonChannelHook = null;
  onIceCandidate: IceCandidateChannelHook = null;

  readonly send: DataChannelTransport['send'];
  readonly sendClientInput: DataChannelTransport['sendClientInput'];
  readonly sendServerState: DataChannelTransport['send'];
  readonly sendColorChange: DataChannelTransport['sendColorChange'];
  readonly sendDiagnosticFleetToggle: DataChannelTransport['sendDiagnosticFleetToggle'];
  readonly receiveServerPackets: NetworkSimulator['drainInboundQueue'];
  readonly receiveClientPackets: NetworkSimulator['drainInboundQueue'];

  readonly createOfferToken: HandshakeSession['createOfferToken'];
  readonly createAnswerToken: HandshakeSession['acceptOfferAndCreateAnswer'];
  readonly acceptOfferAndCreateAnswer: HandshakeSession['acceptOfferAndCreateAnswer'];
  readonly acceptAnswerToken: HandshakeSession['acceptAnswerToken'];
  readonly addRemoteCandidate: (
    candJson: IceCandidateDescriptor | RTCIceCandidateInit | Record<string, unknown>
  ) => Promise<void>;
  readonly addIceCandidate: (
    candJson: IceCandidateDescriptor | RTCIceCandidateInit | Record<string, unknown>
  ) => Promise<void>;

  readonly setExtraUplinkLatency: NetworkSimulator['setExtraUplinkLatency'];
  readonly setExtraDownlinkLatency: NetworkSimulator['setExtraDownlinkLatency'];
  readonly setAsymmetricLatency: NetworkSimulator['setAsymmetricLatency'];
  readonly setExtraLatency: NetworkSimulator['setExtraLatency'];
  readonly setLatency: NetworkSimulator['setLatency'];
  readonly setJitter: NetworkSimulator['setJitter'];
  readonly setRtt: NetworkSimulator['setRtt'];
  readonly setPacketLossRate: NetworkSimulator['setPacketLossRate'];
  readonly setBurstDrop: NetworkSimulator['setBurstDrop'];
  readonly setBurstDropEnabled: NetworkSimulator['setBurstDropEnabled'];
  readonly toggleBurstDrop: NetworkSimulator['toggleBurstDrop'];
  readonly forceDropNextInput: NetworkSimulator['forceDropNextInput'];
  readonly dropSinglePacket: NetworkSimulator['dropSinglePacket'];

  constructor(options: P2PWebRTCChannelOptions = {}) {
    this.role = options.role ?? 'client';
    this.playerName = options.playerName ?? 'Player';
    this.roomId = options.roomId ?? null;

    this.localColorSlot = options.colorSlot ?? (this.role === 'host' ? 3 : 0);
    this.localColorHex = options.colorHex ?? (this.role === 'host' ? '#42a5f5' : '#ff7043');

    this.simulator = new NetworkSimulator(options);
    this.stats = this.simulator.stats;

    this.signaling = new CrossTabSignaling({
      signalingChannelName: options.signalingChannelName ?? 'online_discovery',
      roomId: this.roomId,
    });

    this.connection = new WebRTCConnection({
      emitIceCandidate: (cand) => this.onIceCandidate?.(cand),
      handleConnectionStateChange: (state) => this._handleConnectionStateChange(state),
      handleIceConnectionStateChange: (state) => this._handleIceConnectionStateChange(state),
      broadcastSignal: (typ, payload) => this.broadcastSignal(typ, payload),
    });

    this.transport = new DataChannelTransport({
      simulator: this.simulator,
      signaling: this.signaling,
      getDataChannel: () => this.dataChannel,
      setDataChannel: (dc) => {
        this.dataChannel = dc;
      },
      isChannelOpen: () => this.isOpen,
      isCrossTabActive: () => this.isCrossTab,
      markDataChannelOpen: () => {
        this.isWebRTC = true;
        this.isOpen = true;
        this.transportMode = 'webrtc';
        this.onConnected?.();
      },
      markDataChannelClosed: () => {
        this.isOpen = false;
        this.onDisconnected?.();
      },
      updateLocalColor: (slotId, hex, pendingIfClosed) => {
        this.localColorSlot = slotId;
        this.localColorHex = hex;
        if (pendingIfClosed) {
          this.pendingColorChange = pendingIfClosed;
        }
      },
      deliverColorChange: (msg) => this.onColorChange?.(msg),
      deliverDiagnosticFleetToggle: (enabled, anchorMode) =>
        this.onDiagnosticFleetToggle?.(enabled, anchorMode),
      deliverPacket: (delivered) => {
        this.onPacketReceived?.(delivered);
        this.onMessage?.(delivered);
      },
    });

    this.handshake = new HandshakeSession({
      connection: this.connection,
      signaling: this.signaling,
      simulator: this.simulator,
      getState: (): HandshakeMetadataState => ({
        role: this.role,
        isHost: this.isHost,
        peerId: this.peerId,
        playerName: this.playerName,
        roomId: this.roomId,
        localColorSlot: this.localColorSlot,
        localColorHex: this.localColorHex,
        peerName: this.peerName,
        peerColorSlot: this.peerColorSlot,
        peerColorHex: this.peerColorHex,
        offerToken: this.offerToken,
        answerToken: this.answerToken,
        isOpen: this.isOpen,
      }),
      applyHandshakeState: (patch) => {
        if (patch.role !== undefined) this.role = patch.role;
        if (patch.roomId !== undefined) this.roomId = patch.roomId;
        if (patch.localColorSlot !== undefined) this.localColorSlot = patch.localColorSlot;
        if (patch.localColorHex !== undefined) this.localColorHex = patch.localColorHex;
        if (patch.peerName !== undefined) this.peerName = patch.peerName;
        if (patch.peerColorSlot !== undefined) this.peerColorSlot = patch.peerColorSlot;
        if (patch.peerColorHex !== undefined) this.peerColorHex = patch.peerColorHex;
        if (patch.offerToken !== undefined) this.offerToken = patch.offerToken;
        if (patch.answerToken !== undefined) this.answerToken = patch.answerToken;
      },
      activateCrossTabTransport: (peerPatch) => {
        this.peerName = peerPatch.peerName;
        this.peerColorSlot = peerPatch.peerColorSlot;
        this.peerColorHex = peerPatch.peerColorHex;
        this.isCrossTab = true;
        this.transportMode = 'crosstab';
        const wasOpen = this.isOpen;
        this.isOpen = true;
        if (!wasOpen) {
          queueMicrotask(() => this.onConnected?.());
        }
      },
      bindDataChannel: (channel) => this.transport.bindDataChannel(channel),
      handleIncomingMessage: (data) => this.transport.handleIncomingMessage(data),
      sendPong: (sendTime) => this.transport.sendPong(sendTime),
      deliverColorChange: (msg) => this.onColorChange?.(msg),
      deliverBroadcastSignal: (msg) => this.onBroadcastSignal?.(msg),
    });

    this.signaling.handler = this.handshake;

    this.send = this.transport.send.bind(this.transport);
    this.sendClientInput = this.transport.sendClientInput.bind(this.transport);
    this.sendServerState = this.transport.send.bind(this.transport);
    this.sendColorChange = this.transport.sendColorChange.bind(this.transport);
    this.sendDiagnosticFleetToggle = this.transport.sendDiagnosticFleetToggle.bind(this.transport);
    this.receiveServerPackets = this.simulator.drainInboundQueue.bind(this.simulator);
    this.receiveClientPackets = this.simulator.drainInboundQueue.bind(this.simulator);

    this.createOfferToken = this.handshake.createOfferToken.bind(this.handshake);
    this.createAnswerToken = this.handshake.acceptOfferAndCreateAnswer.bind(this.handshake);
    this.acceptOfferAndCreateAnswer = this.handshake.acceptOfferAndCreateAnswer.bind(
      this.handshake
    );
    this.acceptAnswerToken = this.handshake.acceptAnswerToken.bind(this.handshake);

    const addCand = (
      candJson: IceCandidateDescriptor | RTCIceCandidateInit | Record<string, unknown>
    ) => this.connection.addRemoteCandidate(candJson as IceCandidateDescriptor);
    this.addRemoteCandidate = addCand;
    this.addIceCandidate = addCand;

    this.setExtraUplinkLatency = this.simulator.setExtraUplinkLatency.bind(this.simulator);
    this.setExtraDownlinkLatency = this.simulator.setExtraDownlinkLatency.bind(this.simulator);
    this.setAsymmetricLatency = this.simulator.setAsymmetricLatency.bind(this.simulator);
    this.setExtraLatency = this.simulator.setExtraLatency.bind(this.simulator);
    this.setLatency = this.simulator.setLatency.bind(this.simulator);
    this.setJitter = this.simulator.setJitter.bind(this.simulator);
    this.setRtt = this.simulator.setRtt.bind(this.simulator);
    this.setPacketLossRate = this.simulator.setPacketLossRate.bind(this.simulator);
    this.setBurstDrop = this.simulator.setBurstDrop.bind(this.simulator);
    this.setBurstDropEnabled = this.simulator.setBurstDropEnabled.bind(this.simulator);
    this.toggleBurstDrop = this.simulator.toggleBurstDrop.bind(this.simulator);
    this.forceDropNextInput = this.simulator.forceDropNextInput.bind(this.simulator);
    this.dropSinglePacket = this.simulator.dropSinglePacket.bind(this.simulator);
  }

  get connected(): boolean {
    return Boolean(this.isOpen || (this.dataChannel && this.dataChannel.readyState === 'open'));
  }

  get rttMs(): number {
    return this.simulator.rttMs;
  }

  get measuredRttMs(): number {
    return this.simulator.measuredRttMs;
  }

  get extraUplinkMs(): number {
    return this.simulator.extraUplinkMs;
  }

  get extraDownlinkMs(): number {
    return this.simulator.extraDownlinkMs;
  }

  get extraLatencyMs(): number {
    return this.simulator.extraLatencyMs;
  }

  get jitterMs(): number {
    return this.simulator.jitterMs;
  }

  get packetLossRate(): number {
    return this.simulator.packetLossRate;
  }

  setColor(slotId: number, hex: string): void {
    this.localColorSlot = slotId;
    this.localColorHex = hex;
  }

  updateOfferTokenColor(slotId: number, hex: string): string {
    this.setColor(slotId, hex);
    if (this.offerToken) {
      try {
        const data = decodeSignalToken(this.offerToken);
        data.hostColorSlot = slotId;
        data.hostColorHex = hex;
        this.offerToken = 'RL_OFFER_' + encodeSignalToken(data);
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to update offer token color:', err);
      }
    }
    this.sendColorChange(slotId, hex, 0);
    return this.offerToken;
  }

  initRoomChannel(roomId: string | null): void {
    this.roomId = roomId;
    this.signaling.initRoomChannel(roomId);
  }

  sendRoomMessage(msg: Record<string, unknown>): boolean {
    return this.signaling.sendRoomMessage(msg, this.peerId);
  }

  _handleConnectionStateChange(state: RTCPeerConnectionState): void {
    console.log(`[P2PWebRTCChannel] Connection State: ${state}`);
    if (state === 'connected') {
      this.isWebRTC = true;
      this.isOpen = true;
      this.transportMode = 'webrtc';
    } else if (state === 'failed') {
      if (this.isCrossTab) {
        console.log(
          '[P2PWebRTCChannel] WebRTC connection failed, but local Cross-Tab transport is ACTIVE (120Hz). Connection maintained.'
        );
        return;
      }
      const wasOpen = this.isOpen;
      this.isOpen = false;
      if (wasOpen) this.onDisconnected?.();
    }
  }

  _handleIceConnectionStateChange(state: RTCIceConnectionState): void {
    console.log(`[P2PWebRTCChannel] ICE Connection State: ${state}`);
    if (state === 'failed') {
      if (this.isCrossTab) {
        console.log(
          '[P2PWebRTCChannel] WebRTC ICE failed, but local Cross-Tab transport is ACTIVE (120Hz). Connection maintained.'
        );
        return;
      }
      const wasOpen = this.isOpen;
      this.isOpen = false;
      if (wasOpen) this.onDisconnected?.();
    }
  }

  broadcastSignal(type: string, payload: Record<string, unknown> = {}): boolean {
    return this.signaling.broadcastSignal(type, payload, {
      roomId: this.roomId,
      role: this.role,
      playerName: this.playerName,
    });
  }

  reset(): void {
    this.simulator.reset();
    this.stats = this.simulator.stats;
  }

  destroy(): void {
    this.reset();
    try {
      this.dataChannel?.close();
    } catch (err) {
      console.warn('[P2PWebRTCChannel] Error closing dataChannel:', err);
    }
    this.connection.destroy();
    this.signaling.destroy();
    this.dataChannel = null;
    this.isOpen = false;
    this.isCrossTab = false;
    this.isWebRTC = false;
  }
}

export default P2PWebRTCChannel;
