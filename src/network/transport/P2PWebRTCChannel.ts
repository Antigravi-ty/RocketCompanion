/**
 * P2PWebRTCChannel.ts
 * High-Speed Direct Transport & WebRTC Facade Layer.
 * Coordinates modular sub-layers (NetworkSimulator, CrossTabSignaling, WebRTCConnection,
 * HandshakeSession, and DataChannelTransport) via narrow typed ports.
 */

import { encodeSignalToken, decodeSignalToken } from './webrtc/SignalTokenCodec.ts';
import { NetworkSimulator, type NetworkSimulatorOptions } from './webrtc/NetworkSimulator.ts';
import { CrossTabSignaling } from './webrtc/CrossTabSignaling.ts';
import { WebRTCConnection } from './webrtc/WebRTCConnection.ts';
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
  readonly signaling: CrossTabSignaling;
  readonly connection: WebRTCConnection;
  readonly handshake: HandshakeSession;
  readonly transport: DataChannelTransport;

  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onPacketReceived: ((data: any) => void) | null = null;
  onMessage: ((data: any) => void) | null = null;
  onColorChange: ((msg: any) => void) | null = null;
  onDiagnosticFleetToggle: ((enabled: boolean, anchorMode: string) => void) | null = null;
  onBroadcastSignal: ((msg: any) => void) | null = null;
  onIceCandidate: ((cand: any) => void) | null = null;

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
      onBroadcastMessage: (msg) => this._handleBroadcastMessage(msg),
      onRoomMessage: (data) => this._handleRoomMessage(data),
    });

    this.connection = new WebRTCConnection({
      onIceCandidate: (cand) => this.onIceCandidate?.(cand),
      onConnectionStateChange: (state) => this._handleConnectionStateChange(state),
      onIceConnectionStateChange: (state) => this._handleIceConnectionStateChange(state),
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
      onWebRTCDataChannelOpen: () => {
        this.isWebRTC = true;
        this.isOpen = true;
        this.transportMode = 'webrtc';
        this.onConnected?.();
      },
      onWebRTCDataChannelClosed: () => {
        this.isOpen = false;
        this.onDisconnected?.();
      },
      onLocalColorUpdated: (slotId, hex, pendingIfClosed) => {
        this.localColorSlot = slotId;
        this.localColorHex = hex;
        if (pendingIfClosed) {
          this.pendingColorChange = pendingIfClosed;
        }
      },
      onColorChange: (msg) => this.onColorChange?.(msg),
      onDiagnosticFleetToggle: (enabled, anchorMode) =>
        this.onDiagnosticFleetToggle?.(enabled, anchorMode),
      onPacketDelivered: (delivered) => {
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
      onColorChange: (msg) => this.onColorChange?.(msg),
      onBroadcastSignal: (msg) => this.onBroadcastSignal?.(msg),
    });
  }

  get connected(): boolean {
    return Boolean(this.isOpen || (this.dataChannel && this.dataChannel.readyState === 'open'));
  }
  get extraUplinkMs(): number {
    return this.simulator.extraUplinkMs;
  }
  set extraUplinkMs(v: number) {
    this.simulator.setExtraUplinkLatency(v);
  }
  get extraDownlinkMs(): number {
    return this.simulator.extraDownlinkMs;
  }
  set extraDownlinkMs(v: number) {
    this.simulator.setExtraDownlinkLatency(v);
  }
  get extraLatencyMs(): number {
    return this.simulator.extraLatencyMs;
  }
  set extraLatencyMs(v: number) {
    this.simulator.setExtraLatency(v);
  }
  get jitterMs(): number {
    return this.simulator.jitterMs;
  }
  set jitterMs(v: number) {
    this.simulator.setJitter(v);
  }
  get packetLossRate(): number {
    return this.simulator.packetLossRate;
  }
  set packetLossRate(v: number) {
    this.simulator.setPacketLossRate(v);
  }
  get baseMeasuredRttMs(): number {
    return this.simulator.baseMeasuredRttMs;
  }
  get measuredRttMs(): number {
    return this.simulator.measuredRttMs;
  }
  get measuredJitterMs(): number {
    return this.simulator.measuredJitterMs;
  }
  get rttMs(): number {
    return this.simulator.rttMs;
  }
  set rttMs(val: number) {
    this.simulator.rttMs = val;
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

  _initSignalingChannel(): void {
    this.signaling.initSignalingChannel(this.signaling.signalingChannelName);
  }
  _initRoomChannel(roomId: string | null): void {
    this.roomId = roomId;
    this.signaling.initRoomChannel(roomId);
  }
  _sendRoomMessage(msg: any): void {
    this.signaling.sendRoomMessage(msg, this.peerId);
  }
  _handleRoomMessage(data: any): void {
    this.handshake.handleRoomMessage(data);
  }
  _handleBroadcastMessage(msg: any): void {
    this.handshake.handleBroadcastMessage(msg);
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

  async addIceCandidate(candJson: any): Promise<void> {
    return this.addRemoteCandidate(candJson);
  }
  async addRemoteCandidate(candJson: any): Promise<void> {
    return this.connection.addRemoteCandidate(candJson);
  }
  async flushPendingCandidates(): Promise<void> {
    return this.connection.flushPendingCandidates();
  }
  broadcastSignal(type: string, payload: Record<string, any> = {}): boolean {
    return this.signaling.broadcastSignal(type, payload, {
      roomId: this.roomId,
      role: this.role,
      playerName: this.playerName,
    });
  }

  createPeerConnection(): RTCPeerConnection | null {
    return this.connection.createPeerConnection();
  }
  _waitForIceGathering(timeoutMs = 1200): Promise<void> {
    return this.connection.waitForIceGathering(timeoutMs);
  }
  async createOfferToken(
    options: { roomId?: string; hostColorSlot?: number; hostColorHex?: string } = {}
  ): Promise<string> {
    return this.handshake.createOfferToken(options);
  }
  async createAnswerToken(
    offerToken: string,
    options: { clientColorSlot?: number; clientColorHex?: string } = {}
  ): Promise<string> {
    return this.handshake.acceptOfferAndCreateAnswer(offerToken, options);
  }
  async acceptOfferAndCreateAnswer(
    offerToken: string,
    options: { clientColorSlot?: number; clientColorHex?: string } = {}
  ): Promise<string> {
    return this.handshake.acceptOfferAndCreateAnswer(offerToken, options);
  }
  async acceptAnswerToken(answerToken: string): Promise<void> {
    return this.handshake.acceptAnswerToken(answerToken);
  }

  _bindDataChannel(channel: RTCDataChannel): void {
    this.transport.bindDataChannel(channel);
  }
  _handleIncomingMessage(data: any): void {
    this.transport.handleIncomingMessage(data);
  }
  _sendPong(sendTime: number): void {
    this.transport.sendPong(sendTime);
  }
  _handlePong(sendTime: number): void {
    this.simulator.handlePong(sendTime);
  }
  sendColorChange(slotId: number, hex: string, carIndex: number): void {
    this.transport.sendColorChange(slotId, hex, carIndex);
  }
  sendDiagnosticFleetToggle(enabled: boolean, anchorMode: string): void {
    this.transport.sendDiagnosticFleetToggle(enabled, anchorMode);
  }
  send(packet: any, nowMs = performance.now()): boolean {
    return this.transport.send(packet, nowMs);
  }
  sendClientInput(packet: any, nowMs = performance.now()): boolean {
    return this.transport.sendClientInput(packet, nowMs);
  }
  sendServerState(packet: any, nowMs = performance.now()): boolean {
    return this.transport.send(packet, nowMs);
  }
  receiveServerPackets(nowMs = performance.now()): any[] {
    return this._drainInboundQueue(nowMs);
  }
  receiveClientPackets(nowMs = performance.now()): any[] {
    return this._drainInboundQueue(nowMs);
  }
  _drainInboundQueue(nowMs = performance.now()): any[] {
    return this.simulator.drainInboundQueue(nowMs);
  }

  setExtraUplinkLatency(uplinkMs: number): void {
    this.simulator.setExtraUplinkLatency(uplinkMs);
  }
  setExtraDownlinkLatency(downlinkMs: number): void {
    this.simulator.setExtraDownlinkLatency(downlinkMs);
  }
  setAsymmetricLatency(uplinkMs: number, downlinkMs: number): void {
    this.simulator.setAsymmetricLatency(uplinkMs, downlinkMs);
  }
  setExtraLatency(extraLatencyMs: number): void {
    this.simulator.setExtraLatency(extraLatencyMs);
  }
  setLatency(latencyMs: number): void {
    this.simulator.setLatency(latencyMs);
  }
  setJitter(jitterMs: number): void {
    this.simulator.setJitter(jitterMs);
  }
  setRtt(rttMs: number): void {
    this.simulator.setRtt(rttMs);
  }
  setPacketLossRate(rate: number): void {
    this.simulator.setPacketLossRate(rate);
  }
  setBurstDrop(periodMs?: number, durationMs?: number, enabled?: boolean): void {
    this.simulator.setBurstDrop(periodMs, durationMs, enabled);
  }
  setBurstDropEnabled(enabled: boolean): boolean {
    return this.simulator.setBurstDropEnabled(enabled);
  }
  toggleBurstDrop(forceEnabled?: boolean): boolean {
    return this.simulator.toggleBurstDrop(forceEnabled);
  }
  forceDropNextInput(count = 5): void {
    this.simulator.forceDropNextInput(count);
  }
  dropSinglePacket(): void {
    this.simulator.dropSinglePacket();
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
