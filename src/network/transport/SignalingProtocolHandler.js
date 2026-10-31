/**
 * src/network/transport/SignalingProtocolHandler.js
 * Multi-Relay E2EE Signaling Protocol Coordinator.
 * Orchestrates concurrent Private EMQX, Cloudflare Worker, and Public EMQX transports,
 * 3-way ECDH rendezvous handshakes, AES-256-GCM SDP/ICE encryption, 4-digit SAS pairing codes,
 * manual pairing hold keepalives, and P2P spectator daisy-chain relay routing.
 */

import { WebSocketSignalingClient } from './WebSocketSignalingClient.js';
import { MqttWebSocketClient } from './MqttWebSocketClient.js';
import {
  deriveDeterministicRoomContext,
  signRoomHandshakeFrame,
  verifyRoomHandshakeFrame,
  SignalingCryptoSession,
} from './SignalingCryptoSession.js';
import {
  getSignalingRelays,
  getManualPairingConfirmationEnabled,
  getAllowSpectatorDaisyChain,
} from '../../ui-core/config/signalingConfig.js';

export class SignalingProtocolHandler {
  constructor(options, callbacks = {}) {
    this.roomId = options.roomId;
    this.password = options.password || '';
    this.role = options.role || 'client';
    this.playerName =
      options.playerName && options.playerName !== 'Host'
        ? options.playerName
        : `Player${Math.floor(1000 + Math.random() * 9000)}`;
    this.allowSpectatorRelay = options.allowSpectatorRelay ?? getAllowSpectatorDaisyChain();
    this.callbacks = callbacks;

    this._peerId = options.peerId || `peer_${Math.random().toString(36).slice(2, 9)}`;
    this.roomContext = null;
    this.cryptoSession = null;

    this.transports = new Map();
    this.relayConfigs = new Map();
    this.peerRelayRoutes = new Map();
    this.peerMetadata = new Map();
    this.pendingCandidatesOut = new Map();

    this.activeRelayId = null;
    this.remoteHostPeerId = null;
    this.status = 'idle';

    this._staggerTimers = [];
    this._helloRetryTimer = null;
    this._pairingKeepAliveTimer = null;
    this._reconnectTimer = null;
    this._isCleanedUp = false;
  }

  get peerId() {
    return this._peerId;
  }

  get client() {
    if (this.activeRelayId && this.transports.has(this.activeRelayId)) {
      return this.transports.get(this.activeRelayId);
    }
    for (const transport of this.transports.values()) {
      if (transport.isConnected) return transport;
    }
    return null;
  }

  getPairingCodeForPeer(peerId = null) {
    const targetId = peerId || this.remoteHostPeerId;
    if (!targetId || !this.cryptoSession) return null;
    return this.cryptoSession.getPairingCode(targetId);
  }

  getActiveRelayLabel(peerId = null) {
    const relayId = (peerId && this.peerRelayRoutes.get(peerId)) || this.activeRelayId;
    if (relayId && this.relayConfigs.has(relayId)) {
      return this.relayConfigs.get(relayId).label;
    }
    for (const [id, transport] of this.transports.entries()) {
      if (transport.isConnected && this.relayConfigs.has(id)) {
        return this.relayConfigs.get(id).label;
      }
    }
    return null;
  }

  async connect(timeoutMs = 8000) {
    this.cleanup();
    this._isCleanedUp = false;
    this.status = 'connecting';

    this.roomContext = await deriveDeterministicRoomContext(this.roomId, this.password);
    this.cryptoSession = new SignalingCryptoSession(this.roomContext, this._peerId);
    await this.cryptoSession.initializeLocalIdentity();

    const relays = getSignalingRelays();
    for (const relay of relays) {
      this.relayConfigs.set(relay.id, relay);
    }

    return new Promise((resolve, reject) => {
      let anyConnected = false;
      let failedCount = 0;
      const totalRelays = relays.length;
      let globalTimeoutHandle = null;

      const settleFirstSuccess = (relayId) => {
        if (anyConnected || this._isCleanedUp) return;
        anyConnected = true;
        if (globalTimeoutHandle) {
          clearTimeout(globalTimeoutHandle);
          globalTimeoutHandle = null;
        }
        if (!this.activeRelayId) {
          this.activeRelayId = relayId;
        }
        this.status = 'connected';
        this.callbacks.onOpen?.({
          relayId,
          relayLabel: this.relayConfigs.get(relayId)?.label || relayId,
          topicHash: this.roomContext.topicHash,
        });
        if (this.role !== 'host') {
          this._startClientHelloLoop();
        }
        resolve();
      };

      const recordRelayFailure = (err) => {
        failedCount++;
        if (!anyConnected && failedCount >= totalRelays) {
          if (globalTimeoutHandle) {
            clearTimeout(globalTimeoutHandle);
            globalTimeoutHandle = null;
          }
          this.status = 'error';
          const finalErr = err instanceof Error ? err : new Error('All signaling relays failed to connect');
          this.callbacks.onError?.(finalErr);
          reject(finalErr);
        }
      };

      if (timeoutMs > 0) {
        globalTimeoutHandle = setTimeout(() => {
          if (!anyConnected && !this._isCleanedUp) {
            this.status = 'error';
            const timeoutErr = new Error(`Signaling connection timed out after ${timeoutMs}ms across all relays`);
            this.callbacks.onError?.(timeoutErr);
            reject(timeoutErr);
          }
        }, timeoutMs);
      }

      for (const relay of relays) {
        const delay = Math.max(0, relay.staggerDelayMs || 0);
        const launchRelay = () => {
          if (this._isCleanedUp) return;
          if (this.role !== 'host' && this.remoteHostPeerId) return;

          const perRelayTimeout = Math.min(timeoutMs || 5000, relay.connectTimeoutMs || 4500);
          const transport = this._createRelayTransport(relay);
          this.transports.set(relay.id, transport);

          transport.on('message', (msg) => {
            this._handleIncomingSignalingFrame(relay.id, msg);
          });

          transport.on('close', () => {
            this._handleRelayClosed(relay.id);
          });

          transport
            .connect(perRelayTimeout)
            .then(() => {
              if (this._isCleanedUp) {
                transport.close();
                return;
              }
              settleFirstSuccess(relay.id);
              if (this.role !== 'host' && !this.remoteHostPeerId) {
                this._sendHelloOnRelay(relay.id);
              }
            })
            .catch((err) => {
              recordRelayFailure(err);
            });
        };

        if (delay === 0) {
          launchRelay();
        } else {
          const timer = setTimeout(launchRelay, delay);
          this._staggerTimers.push(timer);
        }
      }
    });
  }

  _createRelayTransport(relay) {
    if (relay.protocol === 'mqtt') {
      return new MqttWebSocketClient(relay.url, {
        relayId: relay.id,
        relayLabel: relay.label,
        topic: this.roomContext.mqttTopic,
        peerId: this._peerId,
        username: relay.username || '',
        password: relay.password || '',
        keepAliveSeconds: relay.keepAliveSeconds || 30,
      });
    }

    return new WebSocketSignalingClient(relay.url, {
      relayId: relay.id,
      relayLabel: relay.label,
      roomId: this.roomId,
      workerRoomKey: this.roomContext.workerRoomKey,
      role: this.role,
      peerId: this._peerId,
      password: '',
      playerName: this.playerName,
    });
  }

  _handleRelayClosed(relayId) {
    let anyStillOpen = false;
    for (const transport of this.transports.values()) {
      if (transport.isConnected) {
        anyStillOpen = true;
        break;
      }
    }
    if (!anyStillOpen && !this._isCleanedUp) {
      this.status = 'error';
      this.callbacks.onClose?.({ relayId });
    }
  }

  _startClientHelloLoop() {
    this._stopClientHelloLoop();
    this._broadcastClientHello();
    this._helloRetryTimer = setInterval(() => {
      if (this._isCleanedUp || this.remoteHostPeerId) {
        this._stopClientHelloLoop();
        return;
      }
      this._broadcastClientHello();
    }, 1350);
  }

  _stopClientHelloLoop() {
    if (this._helloRetryTimer) {
      clearInterval(this._helloRetryTimer);
      this._helloRetryTimer = null;
    }
  }

  async _broadcastClientHello() {
    for (const [relayId, transport] of this.transports.entries()) {
      if (transport.isConnected) {
        await this._sendHelloOnRelay(relayId);
      }
    }
  }

  async _sendHelloOnRelay(relayId) {
    const transport = this.transports.get(relayId);
    if (!transport || !transport.isConnected || !this.cryptoSession) return;

    const ecdhPub = this.cryptoSession.localPublicKeyBase64Url;
    const nonce = this.cryptoSession.localNonce;
    const hmac = await signRoomHandshakeFrame(this.roomContext, [
      'sig_hello',
      this._peerId,
      this.playerName,
      this.role,
      ecdhPub,
      nonce,
    ]);

    transport.send({
      type: 'sig_hello',
      fromPeerId: this._peerId,
      senderName: this.playerName,
      role: this.role,
      allowSpectatorRelay: Boolean(this.allowSpectatorRelay),
      ecdhPub,
      nonce,
      relayId,
      hmac,
      timestamp: Date.now(),
    });
  }

  async _handleIncomingSignalingFrame(relayId, msg) {
    if (!msg || typeof msg !== 'object' || this._isCleanedUp) return;
    if (msg.fromPeerId && msg.fromPeerId === this._peerId) return;

    if (msg.type === 'sig_hello') {
      await this._onReceiveHello(relayId, msg);
      return;
    }

    if (msg.type === 'sig_hello_ack') {
      await this._onReceiveHelloAck(relayId, msg);
      return;
    }

    if (msg.type === 'sig_encrypted') {
      if (msg.targetPeerId && msg.targetPeerId !== this._peerId) return;
      await this._onReceiveEncryptedEnvelope(relayId, msg);
      return;
    }
  }

  async _onReceiveHello(relayId, msg) {
    if (this.role !== 'host' && !this.allowSpectatorRelay) return;
    if (this.role !== 'host' && msg.targetRelayParentId !== this._peerId) return;

    const isValid = await verifyRoomHandshakeFrame(
      this.roomContext,
      ['sig_hello', msg.fromPeerId, msg.senderName, msg.role, msg.ecdhPub, msg.nonce],
      msg.hmac
    );
    if (!isValid) return;

    const session = await this.cryptoSession.establishPeerSession(
      msg.fromPeerId,
      msg.ecdhPub,
      msg.nonce,
      true
    );

    const existingMeta = this.peerMetadata.get(msg.fromPeerId);
    if (!existingMeta || !existingMeta.confirmed) {
      this.peerRelayRoutes.set(msg.fromPeerId, relayId);
    }

    this.peerMetadata.set(msg.fromPeerId, {
      peerId: msg.fromPeerId,
      name: msg.senderName || 'Player',
      role: msg.role || 'player',
      allowSpectatorRelay: msg.allowSpectatorRelay !== false,
      pairingCode: session.pairingCode,
      relayId: this.peerRelayRoutes.get(msg.fromPeerId) || relayId,
      confirmed: existingMeta?.confirmed || false,
      offerDispatched: existingMeta?.offerDispatched || false,
      approved: existingMeta?.approved || false,
    });

    const ecdhPub = this.cryptoSession.localPublicKeyBase64Url;
    const nonce = this.cryptoSession.localNonce;
    const requireManualApproval = getManualPairingConfirmationEnabled();
    const hmac = await signRoomHandshakeFrame(this.roomContext, [
      'sig_hello_ack',
      msg.fromPeerId,
      this._peerId,
      this.playerName,
      ecdhPub,
      nonce,
    ]);

    const transport = this.transports.get(relayId);
    transport?.send({
      type: 'sig_hello_ack',
      targetPeerId: msg.fromPeerId,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      ecdhPub,
      nonce,
      relayId,
      requireManualApproval,
      hmac,
      timestamp: Date.now(),
    });
  }

  async _onReceiveHelloAck(relayId, msg) {
    if (this.role === 'host') return;
    if (msg.targetPeerId !== this._peerId) return;

    const isValid = await verifyRoomHandshakeFrame(
      this.roomContext,
      ['sig_hello_ack', this._peerId, msg.fromPeerId, msg.senderName, msg.ecdhPub, msg.nonce],
      msg.hmac
    );
    if (!isValid) return;

    if (this.remoteHostPeerId && this.remoteHostPeerId !== msg.fromPeerId) {
      return;
    }

    const isFirstLock = !this.remoteHostPeerId;
    this.remoteHostPeerId = msg.fromPeerId;
    this.activeRelayId = relayId;
    this.peerRelayRoutes.set(msg.fromPeerId, relayId);
    this._stopClientHelloLoop();

    const session = await this.cryptoSession.establishPeerSession(
      msg.fromPeerId,
      msg.ecdhPub,
      msg.nonce,
      false
    );

    this.peerMetadata.set(msg.fromPeerId, {
      peerId: msg.fromPeerId,
      name: msg.senderName || 'Host',
      role: 'host',
      pairingCode: session.pairingCode,
      relayId,
      confirmed: true,
    });

    if (isFirstLock) {
      this._closeRedundantClientRelays(relayId);
      const relayLabel = this.relayConfigs.get(relayId)?.label || relayId;
      this.callbacks.onRendezvousEstablished?.({
        relayId,
        relayLabel,
        pairingCode: session.pairingCode,
        hostPeerId: msg.fromPeerId,
        hostName: msg.senderName || 'Host',
        requireManualApproval: Boolean(msg.requireManualApproval),
      });
    }

    await this._sendEncryptedToPeer(
      msg.fromPeerId,
      {
        type: 'sig_handshake_confirm',
        fromPeerId: this._peerId,
        senderName: this.playerName,
        role: this.role,
        allowSpectatorRelay: Boolean(this.allowSpectatorRelay),
        pairingCode: session.pairingCode,
        relayId,
        timestamp: Date.now(),
      },
      relayId
    );
  }

  _closeRedundantClientRelays(winningRelayId) {
    for (const [id, transport] of this.transports.entries()) {
      if (id !== winningRelayId) {
        try {
          transport.close();
        } catch (_) {}
        this.transports.delete(id);
      }
    }
  }

  async _onReceiveEncryptedEnvelope(relayId, wrapper) {
    const fromPeerId = wrapper.fromPeerId;
    if (!fromPeerId || !this.cryptoSession?.getPeerSession(fromPeerId)) return;

    let inner;
    try {
      inner = await this.cryptoSession.decryptFromPeer(fromPeerId, wrapper.env);
    } catch (err) {
      console.warn('[SignalingProtocolHandler] Dropped undecryptable signaling frame:', err?.message || err);
      return;
    }

    if (!inner || !inner.type) return;

    if (inner.type === 'sig_handshake_confirm') {
      await this._onReceiveHandshakeConfirm(relayId, fromPeerId, inner);
      return;
    }

    if (inner.type === 'sig_pairing_hold') {
      this._startClientPairingKeepAlive(fromPeerId, inner.pairingCode, inner.hostName);
      return;
    }

    if (inner.type === 'sig_pairing_ping') {
      this.callbacks.onPairingKeepAlive?.({ peerId: fromPeerId, timestamp: Date.now() });
      await this._sendEncryptedToPeer(fromPeerId, {
        type: 'sig_pairing_pong',
        fromPeerId: this._peerId,
        timestamp: Date.now(),
      });
      return;
    }

    if (inner.type === 'sig_pairing_pong') {
      this.callbacks.onPairingKeepAlive?.({ peerId: fromPeerId, timestamp: Date.now() });
      return;
    }

    if (inner.type === 'sig_pairing_approved') {
      this._stopPairingKeepAlive();
      this.callbacks.onPairingApproved?.({
        hostPeerId: fromPeerId,
        pairingCode: inner.pairingCode,
      });
      return;
    }

    if (inner.type === 'sig_pairing_declined') {
      this._stopPairingKeepAlive();
      this.callbacks.onPairingDeclined?.({
        hostPeerId: fromPeerId,
        reason: inner.reason || 'Host declined the connection request.',
      });
      return;
    }

    if (inner.type === 'relay_assignment') {
      this.callbacks.onRelayAssignment?.(inner);
      return;
    }

    if (inner.type === 'request_offer') {
      const meta = this.peerMetadata.get(fromPeerId);
      if (meta && (!getManualPairingConfirmationEnabled() || meta.approved)) {
        this.callbacks.onRequestOffer?.({
          fromPeerId,
          name: inner.name || meta.name,
          senderName: inner.name || meta.name,
          role: meta.role,
          pairingCode: meta.pairingCode,
          relayId,
        });
      }
      return;
    }

    if (inner.type === 'offer') {
      this._stopPairingKeepAlive();
      this.callbacks.onOffer?.({
        ...inner,
        fromPeerId,
        pairingCode: this.getPairingCodeForPeer(fromPeerId),
        relayId,
      });
      return;
    }

    if (inner.type === 'answer') {
      this.callbacks.onAnswer?.({
        ...inner,
        fromPeerId,
        pairingCode: this.getPairingCodeForPeer(fromPeerId),
        relayId,
      });
      return;
    }

    if (inner.type === 'candidate') {
      this.callbacks.onCandidate?.({
        ...inner,
        fromPeerId,
        relayId,
      });
      return;
    }
  }

  async _onReceiveHandshakeConfirm(relayId, fromPeerId, inner) {
    const meta = this.peerMetadata.get(fromPeerId);
    if (!meta) return;

    this.peerRelayRoutes.set(fromPeerId, relayId);
    meta.relayId = relayId;
    meta.confirmed = true;

    const flushQueued = this.pendingCandidatesOut.get(fromPeerId);

    const dispatchPeerReady = async () => {
      if (meta.offerDispatched) return;
      meta.offerDispatched = true;
      meta.approved = true;
      this.callbacks.onPeerJoined?.({
        peerId: fromPeerId,
        name: meta.name,
        peerName: meta.name,
        role: meta.role,
        allowSpectatorRelay: meta.allowSpectatorRelay,
        pairingCode: meta.pairingCode,
        relayId,
      });
      if (Array.isArray(flushQueued) && flushQueued.length > 0) {
        this.pendingCandidatesOut.delete(fromPeerId);
        for (const cand of flushQueued) {
          await this.sendCandidate(fromPeerId, cand);
        }
      }
    };

    if (!getManualPairingConfirmationEnabled() || meta.approved) {
      await dispatchPeerReady();
      return;
    }

    await this._sendEncryptedToPeer(
      fromPeerId,
      {
        type: 'sig_pairing_hold',
        pairingCode: meta.pairingCode,
        hostName: this.playerName,
        timestamp: Date.now(),
      },
      relayId
    );

    if (typeof this.callbacks.onPairingApprovalRequired === 'function') {
      this.callbacks.onPairingApprovalRequired({
        peerId: fromPeerId,
        peerName: meta.name,
        role: meta.role,
        pairingCode: meta.pairingCode,
        relayId,
        relayLabel: this.relayConfigs.get(relayId)?.label || relayId,
        approve: async () => {
          meta.approved = true;
          await this._sendEncryptedToPeer(
            fromPeerId,
            {
              type: 'sig_pairing_approved',
              pairingCode: meta.pairingCode,
              timestamp: Date.now(),
            },
            relayId
          );
          await dispatchPeerReady();
        },
        decline: async (reason = 'Connection declined by Host') => {
          this.peerMetadata.delete(fromPeerId);
          await this._sendEncryptedToPeer(
            fromPeerId,
            {
              type: 'sig_pairing_declined',
              reason,
              timestamp: Date.now(),
            },
            relayId
          );
        },
      });
    } else {
      await dispatchPeerReady();
    }
  }

  _startClientPairingKeepAlive(hostPeerId, pairingCode, hostName) {
    this._stopPairingKeepAlive();
    this.callbacks.onPairingHold?.({
      hostPeerId,
      hostName: hostName || 'Host',
      pairingCode,
    });
    this._pairingKeepAliveTimer = setInterval(() => {
      if (this._isCleanedUp) {
        this._stopPairingKeepAlive();
        return;
      }
      this._sendEncryptedToPeer(hostPeerId, {
        type: 'sig_pairing_ping',
        fromPeerId: this._peerId,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 2000);
  }

  _stopPairingKeepAlive() {
    if (this._pairingKeepAliveTimer) {
      clearInterval(this._pairingKeepAliveTimer);
      this._pairingKeepAliveTimer = null;
    }
  }

  async _sendEncryptedToPeer(targetPeerId, payloadObj, preferredRelayId = null) {
    const resolvedPeerId = targetPeerId || this.remoteHostPeerId;
    if (!resolvedPeerId || !this.cryptoSession?.getPeerSession(resolvedPeerId)) {
      return false;
    }

    const env = await this.cryptoSession.encryptForPeer(resolvedPeerId, payloadObj);
    const wrapper = {
      type: 'sig_encrypted',
      fromPeerId: this._peerId,
      targetPeerId: resolvedPeerId,
      env,
      timestamp: Date.now(),
    };

    const routeRelayId =
      preferredRelayId ||
      this.peerRelayRoutes.get(resolvedPeerId) ||
      this.activeRelayId;

    if (routeRelayId && this.transports.has(routeRelayId)) {
      const transport = this.transports.get(routeRelayId);
      if (transport.isConnected) {
        return transport.send(wrapper, 1);
      }
    }

    let sentAny = false;
    for (const transport of this.transports.values()) {
      if (transport.isConnected) {
        if (transport.send(wrapper, 1)) {
          sentAny = true;
        }
      }
    }
    return sentAny;
  }

  scheduleReconnect(delayMs = 3000, reconnectFn) {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (typeof reconnectFn === 'function') reconnectFn();
    }, delayMs);
  }

  async send(data) {
    if (!data) return false;
    const targetPeerId = data.targetPeerId || this.remoteHostPeerId;
    if (targetPeerId && this.cryptoSession?.getPeerSession(targetPeerId)) {
      return this._sendEncryptedToPeer(targetPeerId, data);
    }
    return false;
  }

  async sendOffer(peerId, token) {
    return this._sendEncryptedToPeer(peerId, {
      type: 'offer',
      targetPeerId: peerId,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      sdp: token,
      pairingCode: this.getPairingCodeForPeer(peerId),
    });
  }

  async sendAnswer(token, targetPeerId = null) {
    const resolvedTarget = targetPeerId || this.remoteHostPeerId;
    return this._sendEncryptedToPeer(resolvedTarget, {
      type: 'answer',
      targetPeerId: resolvedTarget,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      sdp: token,
      pairingCode: this.getPairingCodeForPeer(resolvedTarget),
    });
  }

  async sendCandidate(targetPeerId, candidate) {
    const resolvedTarget = targetPeerId || this.remoteHostPeerId;
    if (!resolvedTarget || !this.cryptoSession?.getPeerSession(resolvedTarget)) {
      if (resolvedTarget) {
        const list = this.pendingCandidatesOut.get(resolvedTarget) || [];
        list.push(candidate);
        this.pendingCandidatesOut.set(resolvedTarget, list);
      }
      return false;
    }
    return this._sendEncryptedToPeer(resolvedTarget, {
      type: 'candidate',
      targetPeerId: resolvedTarget,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      candidate,
    });
  }

  async sendRelayAssignment(targetPeerId, assignment) {
    return this._sendEncryptedToPeer(targetPeerId, {
      type: 'relay_assignment',
      targetPeerId,
      fromPeerId: this._peerId,
      assignment,
    });
  }

  cleanup() {
    this._isCleanedUp = true;
    this._stopClientHelloLoop();
    this._stopPairingKeepAlive();
    for (const timer of this._staggerTimers) {
      clearTimeout(timer);
    }
    this._staggerTimers.length = 0;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    for (const transport of this.transports.values()) {
      try {
        transport.close();
      } catch (_) {}
    }
    this.transports.clear();
    this.peerRelayRoutes.clear();
    this.peerMetadata.clear();
    this.pendingCandidatesOut.clear();
    if (this.cryptoSession) {
      this.cryptoSession.destroy();
      this.cryptoSession = null;
    }
    this.activeRelayId = null;
    this.remoteHostPeerId = null;
    this.status = 'idle';
  }
}
