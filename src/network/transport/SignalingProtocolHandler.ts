/**
 * SignalingProtocolHandler.ts
 * Multi-Relay E2EE Signaling Protocol Coordinator.
 * Orchestrates concurrent relay transports via SignalingMultiRelayTransportPool,
 * 3-way ECDH rendezvous handshakes, AES-256-GCM SDP/ICE encryption, 4-digit SAS pairing codes,
 * manual pairing hold keepalives, and P2P spectator daisy-chain relay routing.
 */

import {
  deriveDeterministicRoomContext,
  SignalingCryptoSession,
  type DeterministicRoomContext,
} from './SignalingCryptoSession.ts';
import {
  getManualPairingConfirmationEnabled,
  getAllowSpectatorDaisyChain,
} from './signalingRelayConfig.ts';
import {
  SignalingEncryptedEnvelopeHandler,
  type SignalingEnvelopeDispatchContext,
  type SignalingPeerMetadata,
} from './SignalingEncryptedEnvelopeHandler.ts';
import {
  SignalingMultiRelayTransportPool,
  type RelayTransportClient,
} from './SignalingMultiRelayTransportPool.ts';
import {
  SessionRelayUsageTracker,
  type SignalingPoolHealthSnapshot,
  type SignalingRelayMatchPolicy,
} from './SignalingRelayLifecyclePolicy.ts';
import {
  getSlotBitForRelayId,
  parseRoomCode,
  resolveSignalingRouteDecision,
} from '../../ui-core/config/roomCodeConnectivityCodec.ts';
import {
  buildHandshakeConfirmPayload,
  buildSignedHelloAckFrame,
  buildSignedHelloFrame,
  verifySignedHelloAckFrame,
  verifySignedHelloFrame,
} from './signalingHandshakeFrames.ts';

export type { RelayTransportClient, SignalingPoolHealthSnapshot, SignalingRelayMatchPolicy };

export interface SignalingProtocolOptions {
  roomId: string;
  password?: string;
  role?: string;
  playerName?: string;
  allowSpectatorRelay?: boolean;
  peerId?: string;
  probedHostMask?: number;
}

export class SignalingProtocolHandler {
  roomId: string;
  password: string;
  role: string;
  playerName: string;
  allowSpectatorRelay: boolean;
  probedHostMask?: number;
  callbacks: Record<string, ((...args: any[]) => any) | undefined>;

  _peerId: string;
  roomContext: DeterministicRoomContext | null = null;
  cryptoSession: SignalingCryptoSession | null = null;

  readonly relayPool = new SignalingMultiRelayTransportPool();
  readonly envelopeHandler = new SignalingEncryptedEnvelopeHandler();
  readonly relayUsageTracker = new SessionRelayUsageTracker();

  remoteHostPeerId: string | null = null;
  status = 'idle';

  _helloRetryTimer: ReturnType<typeof setInterval> | null = null;
  _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  _isCleanedUp = false;

  constructor(
    options: SignalingProtocolOptions,
    callbacks: Record<string, ((...args: any[]) => any) | undefined> = {}
  ) {
    this.roomId = options.roomId;
    this.password = options.password || '';
    this.role = options.role || 'client';
    this.playerName =
      options.playerName && options.playerName !== 'Host'
        ? options.playerName
        : `Player${Math.floor(1000 + Math.random() * 9000)}`;
    this.allowSpectatorRelay = options.allowSpectatorRelay ?? getAllowSpectatorDaisyChain();
    this.probedHostMask = options.probedHostMask;
    this.callbacks = callbacks;
    this._peerId = options.peerId || `peer_${Math.random().toString(36).slice(2, 9)}`;
  }

  get peerId(): string { return this._peerId; }
  get transports(): Map<string, RelayTransportClient> { return this.relayPool.transports; }
  get relayConfigs(): Map<string, any> { return this.relayPool.relayConfigs; }
  get activeRelayId(): string | null { return this.relayPool.activeRelayId; }
  set activeRelayId(val: string | null) { this.relayPool.activeRelayId = val; }
  get peerRelayRoutes(): Map<string, string> { return this.envelopeHandler.peerRelayRoutes; }
  get peerMetadata(): Map<string, SignalingPeerMetadata> { return this.envelopeHandler.peerMetadata; }
  get pendingCandidatesOut(): Map<string, any[]> { return this.envelopeHandler.pendingCandidatesOut; }
  get client(): RelayTransportClient | null { return this.relayPool.activeClient; }

  getPairingCodeForPeer(peerId: string | null = null): string | null {
    const targetId = peerId || this.remoteHostPeerId;
    return targetId && this.cryptoSession ? this.cryptoSession.getPairingCode(targetId) : null;
  }

  getActiveRelayLabel(peerId: string | null = null): string | null {
    const relayId = (peerId && this.peerRelayRoutes.get(peerId)) || this.relayPool.activeRelayId;
    return this.relayPool.getRelayLabel(relayId);
  }

  private getEnvelopeDispatchContext(): SignalingEnvelopeDispatchContext {
    return {
      localPeerId: this._peerId,
      playerName: this.playerName,
      cryptoSession: this.cryptoSession,
      callbacks: this.callbacks,
      getRelayLabel: (relayId: string) => this.relayPool.getRelayLabel(relayId) || relayId,
      getPairingCodeForPeer: (peerId: string) => this.getPairingCodeForPeer(peerId),
      sendEncryptedToPeer: (targetPeerId, payloadObj, preferredRelayId) =>
        this._sendEncryptedToPeer(targetPeerId, payloadObj, preferredRelayId),
      sendCandidate: (targetPeerId, candidate) => this.sendCandidate(targetPeerId, candidate),
      isCleanedUp: () => this._isCleanedUp,
    };
  }

  async connect(timeoutMs = 8000): Promise<void> {
    this.cleanup();
    this._isCleanedUp = false;
    this.status = 'connecting';

    this.roomContext = await deriveDeterministicRoomContext(this.roomId, this.password);
    this.cryptoSession = new SignalingCryptoSession(this.roomContext, this._peerId);
    await this.cryptoSession.initializeLocalIdentity();

    return this.relayPool.connectStaggered(timeoutMs, {
      role: this.role,
      peerId: this._peerId,
      roomId: this.roomId,
      playerName: this.playerName,
      roomContext: this.roomContext,
      allowedMask: this.probedHostMask,
      isSkipLaunch: () =>
        this._isCleanedUp ||
        (this.role !== 'host' && !this.allowSpectatorRelay && Boolean(this.remoteHostPeerId)),
      onFirstRelayOpen: ({ relayId, relayLabel, topicHash }) => {
        this.status = 'connected';
        this.callbacks.onOpen?.({ relayId, relayLabel, topicHash });
        if (this.role !== 'host') {
          this._startClientHelloLoop();
        }
      },
      onRelayConnected: () => {
        if (this.role !== 'host' && !this.remoteHostPeerId) {
          void this._broadcastClientHello();
        }
      },
      onRelayHealthChanged: (snapshot) => {
        this.callbacks.onRelayHealthChanged?.(snapshot);
      },
      onFrameReceived: (relayId, msg) => {
        void this._handleIncomingSignalingFrame(relayId, msg);
      },
      onAllRelaysClosed: (relayId) => {
        this.status = 'error';
        this.callbacks.onClose?.({ relayId });
      },
      onAllRelaysFailed: (finalErr) => {
        this.status = 'error';
        this.callbacks.onError?.(finalErr);
      },
    });
  }

  _startClientHelloLoop(): void {
    this._stopClientHelloLoop();
    void this._broadcastClientHello();
    this._helloRetryTimer = setInterval(() => {
      if (this._isCleanedUp || this.remoteHostPeerId) {
        this._stopClientHelloLoop();
        return;
      }
      void this._broadcastClientHello();
    }, 1350);
  }

  _stopClientHelloLoop(): void {
    if (this._helloRetryTimer) {
      clearInterval(this._helloRetryTimer);
      this._helloRetryTimer = null;
    }
  }

  async _broadcastClientHello(): Promise<void> {
    const connectedIds = this.relayPool.getConnectedRelayIds();
    if (connectedIds.length === 0) return;

    const parsedRoom = parseRoomCode(this.roomId);
    const hostMask = parsedRoom ? parsedRoom.hostMask : 0x0f;
    const clientMask = this.relayPool.getConnectedConnectivityMask();
    const route = resolveSignalingRouteDecision(hostMask, clientMask);

    if (route.routeType === 'direct-shared') {
      for (const relayId of connectedIds) {
        const bit = getSlotBitForRelayId(relayId);
        if (bit === 0 || (route.sharedMask & bit) !== 0) {
          await this._sendHelloOnRelay(relayId, false);
        }
      }
      return;
    }

    // Isolated island (sharedMask === 0): dispatch via Edge Function / bridge channel
    const bestBridgeRelay = this.relayPool.getBestRelayIdForBridge(connectedIds[0]);
    if (bestBridgeRelay) {
      await this._sendHelloOnRelay(bestBridgeRelay, true);
    }
  }

  async _sendHelloOnRelay(relayId: string, useBridge = false): Promise<void> {
    if (!this.cryptoSession || !this.roomContext) return;

    const helloFrame = await buildSignedHelloFrame({
      roomContext: this.roomContext,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      role: this.role,
      allowSpectatorRelay: Boolean(this.allowSpectatorRelay),
      ecdhPub: this.cryptoSession.localPublicKeyBase64Url,
      nonce: this.cryptoSession.localNonce,
      relayId,
    });

    if (useBridge) {
      await this.relayPool.sendBridgeOnRelay(relayId, helloFrame);
    } else {
      this.relayPool.sendOnRelay(relayId, helloFrame);
    }
  }

  async _handleIncomingSignalingFrame(relayId: string, msg: any): Promise<void> {
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

  async _onReceiveHello(relayId: string, msg: any): Promise<void> {
    if (this.role !== 'host' && !this.allowSpectatorRelay) return;
    if (this.role !== 'host' && msg.targetRelayParentId !== this._peerId) return;
    if (!this.cryptoSession || !this.roomContext) return;

    if (!(await verifySignedHelloFrame(this.roomContext, msg))) return;

    const isBridgedPeer = Number(msg._brgHop || 0) >= 1;
    const bridgedFromRelayId = msg._brgFrom ? String(msg._brgFrom) : undefined;

    const session = await this.cryptoSession.establishPeerSession(
      msg.fromPeerId,
      msg.ecdhPub,
      msg.nonce,
      true
    );

    this.relayUsageTracker.recordPeerHandshakeRelay(msg.fromPeerId, relayId);

    this.envelopeHandler.registerClientHelloPeer(
      msg.fromPeerId,
      msg.senderName,
      msg.role,
      msg.allowSpectatorRelay,
      session.pairingCode,
      relayId,
      isBridgedPeer,
      bridgedFromRelayId
    );

    const ackFrame = await buildSignedHelloAckFrame({
      roomContext: this.roomContext,
      targetPeerId: msg.fromPeerId,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      ecdhPub: this.cryptoSession.localPublicKeyBase64Url,
      nonce: this.cryptoSession.localNonce,
      relayId,
      requireManualApproval: getManualPairingConfirmationEnabled(),
    });

    const peerMeta = this.peerMetadata.get(msg.fromPeerId);
    if (isBridgedPeer || peerMeta?.requiresBridge) {
      await this.relayPool.sendBridgeOnRelay(relayId, ackFrame);
    } else {
      this.relayPool.sendOnRelay(relayId, ackFrame);
    }
  }

  async _onReceiveHelloAck(relayId: string, msg: any): Promise<void> {
    if (this.role === 'host') return;
    if (msg.targetPeerId !== this._peerId) return;
    if (!this.cryptoSession || !this.roomContext) return;

    if (!(await verifySignedHelloAckFrame(this.roomContext, this._peerId, msg))) return;

    if (this.remoteHostPeerId && this.remoteHostPeerId !== msg.fromPeerId) {
      return;
    }

    const isBridgedHost = Number(msg._brgHop || 0) >= 1;
    const bridgedFromRelayId = msg._brgFrom ? String(msg._brgFrom) : undefined;

    const isFirstLock = !this.remoteHostPeerId;
    this.remoteHostPeerId = msg.fromPeerId;
    this.relayPool.activeRelayId = relayId;
    this._stopClientHelloLoop();

    const session = await this.cryptoSession.establishPeerSession(
      msg.fromPeerId,
      msg.ecdhPub,
      msg.nonce,
      false
    );

    this.relayUsageTracker.recordPeerHandshakeRelay(msg.fromPeerId, relayId);

    this.envelopeHandler.registerHostHelloAckPeer(
      msg.fromPeerId,
      msg.senderName,
      session.pairingCode,
      relayId,
      isBridgedHost,
      bridgedFromRelayId
    );

    if (isFirstLock) {
      if (!this.allowSpectatorRelay) {
        this.relayPool.closeRedundantRelays(relayId);
      }
      const relayLabel = this.relayPool.getRelayLabel(relayId) || relayId;
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
      buildHandshakeConfirmPayload(
        this._peerId,
        this.playerName,
        this.role,
        Boolean(this.allowSpectatorRelay),
        session.pairingCode,
        relayId
      ),
      relayId
    );
  }

  async _onReceiveEncryptedEnvelope(relayId: string, wrapper: any): Promise<void> {
    return this.envelopeHandler.handleEncryptedEnvelope(relayId, wrapper, this.getEnvelopeDispatchContext());
  }

  async _onReceiveHandshakeConfirm(relayId: string, fromPeerId: string): Promise<void> {
    return this.envelopeHandler.handleHandshakeConfirm(relayId, fromPeerId, this.getEnvelopeDispatchContext());
  }

  _startClientPairingKeepAlive(hostPeerId: string, pairingCode: string, hostName?: string): void {
    this.envelopeHandler.startClientPairingKeepAlive(hostPeerId, pairingCode, hostName, this.getEnvelopeDispatchContext());
  }

  _stopPairingKeepAlive(): void { this.envelopeHandler.stopPairingKeepAlive(); }

  async _sendEncryptedToPeer(
    targetPeerId: string | null,
    payloadObj: Record<string, any>,
    preferredRelayId: string | null = null
  ): Promise<boolean> {
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
      preferredRelayId || this.peerRelayRoutes.get(resolvedPeerId) || this.relayPool.activeRelayId;

    const peerMeta = this.peerMetadata.get(resolvedPeerId);
    if (peerMeta?.requiresBridge && routeRelayId) {
      return this.relayPool.sendBridgeOnRelay(routeRelayId, wrapper);
    }

    return this.relayPool.sendRoutedFrame(wrapper, routeRelayId, 1);
  }

  scheduleReconnect(delayMs = 3000, reconnectFn?: () => void): void {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (typeof reconnectFn === 'function') reconnectFn();
    }, delayMs);
  }

  async send(data: any): Promise<boolean> {
    if (!data) return false;
    const targetPeerId = data.targetPeerId || this.remoteHostPeerId;
    if (targetPeerId && this.cryptoSession?.getPeerSession(targetPeerId)) {
      return this._sendEncryptedToPeer(targetPeerId, data);
    }
    return false;
  }

  async sendOffer(peerId: string, token: string): Promise<boolean> {
    return this._sendEncryptedToPeer(peerId, {
      type: 'offer',
      targetPeerId: peerId,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      sdp: token,
      pairingCode: this.getPairingCodeForPeer(peerId),
    });
  }

  async sendAnswer(token: string, targetPeerId: string | null = null): Promise<boolean> {
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

  async sendCandidate(targetPeerId: string | null, candidate: any): Promise<boolean> {
    const resolvedTarget = targetPeerId || this.remoteHostPeerId;
    if (!resolvedTarget || !this.cryptoSession?.getPeerSession(resolvedTarget)) {
      if (resolvedTarget) {
        this.envelopeHandler.queuePendingOutgoingCandidate(resolvedTarget, candidate);
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

  async sendRelayAssignment(targetPeerId: string, assignment: any): Promise<boolean> {
    return this._sendEncryptedToPeer(targetPeerId, {
      type: 'relay_assignment',
      targetPeerId,
      fromPeerId: this._peerId,
      assignment,
    });
  }

  applyMatchPhaseRelayConvergence(policy?: SignalingRelayMatchPolicy): void {
    this.relayPool.applyMatchPhaseRelayConvergence(
      this.relayUsageTracker.getActiveRelayIds(),
      policy
    );
  }

  restoreLobbyRelays(): void {
    this.relayPool.restoreLobbyRelays();
  }

  cleanup(): void {
    this._isCleanedUp = true;
    this._stopClientHelloLoop();
    this.relayUsageTracker.clear();
    this.envelopeHandler.reset();
    this.relayPool.cleanup();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this.cryptoSession) {
      this.cryptoSession.destroy();
      this.cryptoSession = null;
    }
    this.remoteHostPeerId = null;
    this.status = 'idle';
  }
}
