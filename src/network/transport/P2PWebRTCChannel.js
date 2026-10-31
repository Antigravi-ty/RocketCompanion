/**
 * src/network/P2PWebRTCChannel.js
 * High-Speed Direct Transport & WebRTC Facade Layer.
 * Preserves public facade contracts and delegates to modular sub-layers.
 */

import {
  encodeSignalToken,
  decodeSignalToken
} from './webrtc/SignalTokenCodec.js';
import { NetworkSimulator } from './webrtc/NetworkSimulator.js';
import { CrossTabSignaling } from './webrtc/CrossTabSignaling.js';
import { WebRTCConnection } from './webrtc/WebRTCConnection.js';
import { HandshakeSession } from './webrtc/HandshakeSession.js';
import { DataChannelTransport } from './webrtc/DataChannelTransport.js';

export class P2PWebRTCChannel {
  constructor(options = {}) {
    this.role = options.role ?? 'client';
    this.playerName = options.playerName ?? 'Player';
    this.roomId = options.roomId ?? null;

    this.localColorSlot = options.colorSlot ?? (this.role === 'host' ? 3 : 0);
    this.localColorHex = options.colorHex ?? (this.role === 'host' ? '#42a5f5' : '#ff7043');
    this.peerColorSlot = null;
    this.peerColorHex = null;
    this.peerName = null;

    this.isOpen = false;
    this.isCrossTab = false;
    this.isWebRTC = false;
    this.transportMode = 'none';

    this.dataChannel = null;
    this.offerToken = '';

    this.simulator = new NetworkSimulator(options);
    this.inboundQueue = this.simulator.inboundQueue;
    this.outboundQueue = this.simulator.outboundQueue;
    this.stats = this.simulator.stats;

    this.onConnected = null;
    this.onDisconnected = null;
    this.onPacketReceived = null;
    this.onColorChange = null;
    this.onBroadcastSignal = null;

    this.signaling = new CrossTabSignaling({
      signalingChannelName: options.signalingChannelName ?? 'online_discovery',
      roomId: this.roomId,
      onBroadcastMessage: (msg) => this._handleBroadcastMessage(msg),
      onRoomMessage: (data) => this._handleRoomMessage(data)
    });

    this.connection = new WebRTCConnection({
      onIceCandidate: (cand) => this.onIceCandidate?.(cand),
      onConnectionStateChange: (state) => this._handleConnectionStateChange(state),
      onIceConnectionStateChange: (state) => this._handleIceConnectionStateChange(state),
      broadcastSignal: (typ, payload) => this.broadcastSignal(typ, payload)
    });

    this.handshake = new HandshakeSession(this);
    this.transport = new DataChannelTransport(this);
  }

  get pc() { return this.connection.pc; }
  set pc(val) { this.connection.pc = val; }
  get localCandidates() { return this.connection.localCandidates; }
  set localCandidates(val) { this.connection.localCandidates = val; }
  get broadcastChannel() { return this.signaling.broadcastChannel; }
  set broadcastChannel(val) { this.signaling.broadcastChannel = val; }
  get roomBroadcastChannel() { return this.signaling.roomBroadcastChannel; }
  set roomBroadcastChannel(val) { this.signaling.roomBroadcastChannel = val; }
  get inboundQueue() { return this.simulator.inboundQueue; }
  set inboundQueue(val) { this.simulator.inboundQueue = val; }
  get outboundQueue() { return this.simulator.outboundQueue; }
  set outboundQueue(val) { this.simulator.outboundQueue = val; }
  get connected() { return Boolean(this.isOpen || (this.dataChannel && this.dataChannel.readyState === 'open')); }
  get extraUplinkMs() { return this.simulator.extraUplinkMs; }
  set extraUplinkMs(v) { this.simulator.setExtraUplinkLatency(v); }
  get extraDownlinkMs() { return this.simulator.extraDownlinkMs; }
  set extraDownlinkMs(v) { this.simulator.setExtraDownlinkLatency(v); }
  get extraRttMs() { return this.simulator.extraRttMs; }
  get extraLatencyMs() { return this.simulator.extraLatencyMs; }
  set extraLatencyMs(v) { this.simulator.setExtraLatency(v); }
  get jitterMs() { return this.simulator.jitterMs; }
  set jitterMs(v) { this.simulator.setJitter(v); }
  get packetLossRate() { return this.simulator.packetLossRate; }
  set packetLossRate(v) { this.simulator.setPacketLossRate(v); }
  get baseMeasuredRttMs() { return this.simulator.baseMeasuredRttMs; }
  set baseMeasuredRttMs(v) { this.simulator.baseMeasuredRttMs = v; }
  get measuredRttMs() { return this.simulator.measuredRttMs; }
  set measuredRttMs(v) { this.simulator.measuredRttMs = v; }
  get measuredJitterMs() { return this.simulator.measuredJitterMs; }
  set measuredJitterMs(v) { this.simulator.measuredJitterMs = v; }
  get lastPingSentTime() { return this.simulator.lastPingSentTime; }
  set lastPingSentTime(v) { this.simulator.lastPingSentTime = v; }
  get pingIntervalMs() { return this.simulator.pingIntervalMs; }
  set pingIntervalMs(v) { this.simulator.pingIntervalMs = v; }
  get dropNextPacket() { return this.simulator.dropNextPacket; }
  set dropNextPacket(v) { this.simulator.dropNextPacket = v; }
  get packetsToDrop() { return this.simulator.packetsToDrop; }
  set packetsToDrop(v) { this.simulator.packetsToDrop = v; }
  get latencyMs() { return this.simulator.latencyMs; }
  get rttMs() { return this.simulator.rttMs; }
  set rttMs(val) { this.simulator.rttMs = val; }
  get lastProcessedOfferToken() { return this.handshake.lastProcessedOfferToken; }
  set lastProcessedOfferToken(v) { this.handshake.lastProcessedOfferToken = v; }
  get currentAnswerToken() { return this.handshake.currentAnswerToken; }
  set currentAnswerToken(v) { this.handshake.currentAnswerToken = v; }

  setColor(slotId, hex) { this.localColorSlot = slotId; this.localColorHex = hex; }
  updateOfferTokenColor(slotId, hex) {
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

  _initSignalingChannel() { this.signaling.initSignalingChannel(this.signaling.signalingChannelName); }
  _initRoomChannel(roomId) { this.roomId = roomId; this.signaling.initRoomChannel(roomId); }
  _sendRoomMessage(msg) { this.signaling.sendRoomMessage(msg, this.peerId); }
  _handleRoomMessage(data) { this.handshake.handleRoomMessage(data); }
  _handleBroadcastMessage(msg) { this.handshake.handleBroadcastMessage(msg); }

  _handleConnectionStateChange(state) {
    console.log(`[P2PWebRTCChannel] Connection State: ${state}`);
    if (state === 'connected') {
      this.isWebRTC = true; this.isOpen = true; this.transportMode = 'webrtc';
    } else if (state === 'failed') {
      if (this.isCrossTab) {
        console.log('[P2PWebRTCChannel] WebRTC connection failed, but local Cross-Tab transport is ACTIVE (120Hz). Connection maintained.');
        return;
      }
      const wasOpen = this.isOpen;
      this.isOpen = false;
      if (wasOpen) this.onDisconnected?.();
    }
  }

  _handleIceConnectionStateChange(state) {
    console.log(`[P2PWebRTCChannel] ICE Connection State: ${state}`);
    if (state === 'failed') {
      if (this.isCrossTab) {
        console.log('[P2PWebRTCChannel] WebRTC ICE failed, but local Cross-Tab transport is ACTIVE (120Hz). Connection maintained.');
        return;
      }
      const wasOpen = this.isOpen;
      this.isOpen = false;
      if (wasOpen) this.onDisconnected?.();
    }
  }

  async addIceCandidate(candJson) { return this.addRemoteCandidate(candJson); }
  async addRemoteCandidate(candJson) { return this.connection.addRemoteCandidate(candJson); }
  async flushPendingCandidates() { return this.connection.flushPendingCandidates(); }
  broadcastSignal(type, payload = {}) {
    return this.signaling.broadcastSignal(type, payload, { roomId: this.roomId, role: this.role, playerName: this.playerName });
  }

  createPeerConnection() { return this.connection.createPeerConnection(); }
  _waitForIceGathering(timeoutMs = 1200) { return this.connection.waitForIceGathering(timeoutMs); }
  async createOfferToken(options = {}) { return this.handshake.createOfferToken(options); }
  async createAnswerToken(offerToken, options = {}) { return this.handshake.acceptOfferAndCreateAnswer(offerToken, options); }
  async acceptOfferAndCreateAnswer(offerToken, options = {}) { return this.handshake.acceptOfferAndCreateAnswer(offerToken, options); }
  async acceptAnswerToken(answerToken) { return this.handshake.acceptAnswerToken(answerToken); }

  _bindDataChannel(channel) { this.transport.bindDataChannel(channel); }
  _handleIncomingMessage(data) { this.transport.handleIncomingMessage(data); }
  _sendPong(sendTime) { this.transport.sendPong(sendTime); }
  _handlePong(sendTime) { this.simulator.handlePong(sendTime); }
  sendColorChange(slotId, hex, carIndex) { this.transport.sendColorChange(slotId, hex, carIndex); }
  sendDiagnosticFleetToggle(enabled, anchorMode) { this.transport.sendDiagnosticFleetToggle(enabled, anchorMode); }
  send(packet, nowMs = performance.now()) { return this.transport.send(packet, nowMs); }
  sendClientInput(packet, nowMs = performance.now()) { return this.transport.sendClientInput(packet, nowMs); }
  sendServerState(packet, nowMs = performance.now()) { return this.transport.send(packet, nowMs); }
  receiveServerPackets(nowMs = performance.now()) { return this._drainInboundQueue(nowMs); }
  receiveClientPackets(nowMs = performance.now()) { return this._drainInboundQueue(nowMs); }
  _drainInboundQueue(nowMs = performance.now()) { return this.simulator.drainInboundQueue(nowMs); }

  setExtraUplinkLatency(uplinkMs) { this.simulator.setExtraUplinkLatency(uplinkMs); }
  setExtraDownlinkLatency(downlinkMs) { this.simulator.setExtraDownlinkLatency(downlinkMs); }
  setAsymmetricLatency(uplinkMs, downlinkMs) { this.simulator.setAsymmetricLatency(uplinkMs, downlinkMs); }
  setExtraLatency(extraLatencyMs) { this.simulator.setExtraLatency(extraLatencyMs); }
  setLatency(latencyMs) { this.simulator.setLatency(latencyMs); }
  setJitter(jitterMs) { this.simulator.setJitter(jitterMs); }
  setRtt(rttMs) { this.simulator.setRtt(rttMs); }
  setPacketLossRate(rate) { this.simulator.setPacketLossRate(rate); }
  setBurstDrop(periodMs, durationMs, enabled) { this.simulator.setBurstDrop(periodMs, durationMs, enabled); }
  setBurstDropEnabled(enabled) { return this.simulator.setBurstDropEnabled(enabled); }
  toggleBurstDrop(forceEnabled) { return this.simulator.toggleBurstDrop(forceEnabled); }
  forceDropNextInput(count = 5) { this.simulator.forceDropNextInput(count); }
  dropSinglePacket() { this.simulator.dropSinglePacket(); }

  reset() {
    this.simulator.reset();
    this.inboundQueue = this.simulator.inboundQueue;
    this.outboundQueue = this.simulator.outboundQueue;
    this.stats = this.simulator.stats;
  }

  destroy() {
    this.reset();
    try { this.dataChannel?.close(); } catch (err) { console.warn('[P2PWebRTCChannel] Error closing dataChannel:', err); }
    this.connection.destroy();
    this.signaling.destroy();
    this.dataChannel = null;
    this.isOpen = false;
    this.isCrossTab = false;
    this.isWebRTC = false;
  }
}

export default P2PWebRTCChannel;
