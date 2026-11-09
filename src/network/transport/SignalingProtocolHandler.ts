/**
 * SignalingProtocolHandler.ts
 * Multi-Relay E2EE Signaling Protocol Coordinator.
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
  buildHandshakeConfirmPayload,
  buildSignedHelloAckFrame,
  buildSignedHelloFrame,
  resolveClientHelloDispatchTargets,
  verifySignedHelloAckFrame,
  verifySignedHelloFrame,
} from './signalingHandshakeFrames.ts';

export type {
  RelayTransportClient,
  SignalingPeerMetadata,
  SignalingPoolHealthSnapshot,
  SignalingRelayMatchPolicy,
};

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

  peerId: string;
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
    opts: SignalingProtocolOptions,
    callbacks: Record<string, ((...args: any[]) => any) | undefined> = {}
  ) {
    this.roomId = opts.roomId;
    this.password = opts.password || '';
    this.role = opts.role || 'client';
    this.playerName =
      opts.playerName && opts.playerName !== 'Host'
        ? opts.playerName
        : `Player${Math.floor(1000 + Math.random() * 9000)}`;
    this.allowSpectatorRelay = opts.allowSpectatorRelay ?? getAllowSpectatorDaisyChain();
    this.probedHostMask = opts.probedHostMask;
    this.callbacks = callbacks;
    this._peerId = opts.peerId || `peer_${Math.random().toString(36).slice(2, 9)}`;
    this.peerId = this._peerId;
  }

  get client(): RelayTransportClient | null {
    return this.relayPool.activeClient;
  }

  getPairingCodeForPeer(peerId: string | null = null): string | null {
    const id = peerId || this.remoteHostPeerId;
    return id && this.cryptoSession ? this.cryptoSession.getPairingCode(id) : null;
  }

  getActiveRelayLabel(peerId: string | null = null): string | null {
    const relayId =
      (peerId && this.envelopeHandler.peerRelayRoutes.get(peerId)) || this.relayPool.activeRelayId;
    return this.relayPool.getRelayLabel(relayId);
  }

  private getEnvelopeDispatchContext(): SignalingEnvelopeDispatchContext {
    return {
      localPeerId: this._peerId,
      playerName: this.playerName,
      cryptoSession: this.cryptoSession,
      callbacks: this.callbacks,
      getRelayLabel: (id: string) => this.relayPool.getRelayLabel(id) || id,
      getPairingCodeForPeer: (id: string) => this.getPairingCodeForPeer(id),
      sendEncryptedToPeer: (id, obj, relId) => this._sendEncryptedToPeer(id, obj, relId),
      sendCandidate: (id, cand) => this.sendCandidate(id, cand),
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
        if (this.role !== 'host') this._startClientHelloLoop();
      },
      onRelayConnected: () => {
        if (this.role !== 'host' && !this.remoteHostPeerId) void this._broadcastClientHello();
      },
      onRelayHealthChanged: (snap) => this.callbacks.onRelayHealthChanged?.(snap),
      onFrameReceived: (relayId, msg) => {
        void this._handleIncomingSignalingFrame(relayId, msg);
      },
      onAllRelaysClosed: (relayId) => {
        this.status = 'error';
        this.callbacks.onClose?.({ relayId });
      },
      onAllRelaysFailed: (err) => {
        this.status = 'error';
        this.callbacks.onError?.(err);
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

    const targets = resolveClientHelloDispatchTargets(
      this.roomId,
      connectedIds,
      this.relayPool.getConnectedConnectivityMask(),
      this.relayPool.getBestRelayIdForBridge(connectedIds[0])
    );
    for (const target of targets) {
      await this._sendHelloOnRelay(target.relayId, target.useBridge);
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
    if (useBridge) await this.relayPool.sendBridgeOnRelay(relayId, helloFrame);
    else this.relayPool.sendOnRelay(relayId, helloFrame);
  }

  async _handleIncomingSignalingFrame(
    relayId: string,
    msg: Record<string, unknown> | null | undefined
  ): Promise<void> {
    if (!msg || typeof msg !== 'object' || this._isCleanedUp) return;
    if (msg.fromPeerId && msg.fromPeerId === this._peerId) return;

    if (msg.type === 'sig_hello') {
      await this._onReceiveHello(relayId, msg);
    } else if (msg.type === 'sig_hello_ack') {
      await this._onReceiveHelloAck(relayId, msg);
    } else if (msg.type === 'sig_encrypted') {
      if (msg.targetPeerId && msg.targetPeerId !== this._peerId) return;
      await this.envelopeHandler.handleEncryptedEnvelope(
        relayId,
        msg,
        this.getEnvelopeDispatchContext()
      );
    }
  }

  async _onReceiveHello(relayId: string, msg: Record<string, unknown>): Promise<void> {
    if (this.role !== 'host' && !this.allowSpectatorRelay) return;
    if (this.role !== 'host' && msg.targetRelayParentId !== this._peerId) return;
    if (!this.cryptoSession || !this.roomContext) return;
    if (!(await verifySignedHelloFrame(this.roomContext, msg))) return;

    const isBridgedPeer = Number(msg._brgHop || 0) >= 1;
    const bridgedFromRelayId = msg._brgFrom ? String(msg._brgFrom) : undefined;
    const fromPeerId = String(msg.fromPeerId || '');

    const session = await this.cryptoSession.establishPeerSession(
      fromPeerId,
      String(msg.ecdhPub || ''),
      String(msg.nonce || ''),
      true
    );
    this.relayUsageTracker.recordPeerHandshakeRelay(fromPeerId, relayId);

    this.envelopeHandler.registerClientHelloPeer(
      fromPeerId,
      String(msg.senderName || 'Player'),
      String(msg.role || 'client'),
      Boolean(msg.allowSpectatorRelay),
      session.pairingCode,
      relayId,
      isBridgedPeer,
      bridgedFromRelayId
    );

    const ackFrame = await buildSignedHelloAckFrame({
      roomContext: this.roomContext,
      targetPeerId: fromPeerId,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      ecdhPub: this.cryptoSession.localPublicKeyBase64Url,
      nonce: this.cryptoSession.localNonce,
      relayId,
      requireManualApproval: getManualPairingConfirmationEnabled(),
    });
    if (isBridgedPeer || this.envelopeHandler.peerMetadata.get(fromPeerId)?.requiresBridge) {
      await this.relayPool.sendBridgeOnRelay(relayId, ackFrame);
    } else {
      this.relayPool.sendOnRelay(relayId, ackFrame);
    }
  }

  async _onReceiveHelloAck(relayId: string, msg: Record<string, unknown>): Promise<void> {
    if (this.role === 'host' || msg.targetPeerId !== this._peerId) return;
    if (!this.cryptoSession || !this.roomContext) return;
    if (!(await verifySignedHelloAckFrame(this.roomContext, this._peerId, msg))) return;

    const fromPeerId = String(msg.fromPeerId || '');
    if (this.remoteHostPeerId && this.remoteHostPeerId !== fromPeerId) return;

    const isBridgedHost = Number(msg._brgHop || 0) >= 1;
    const bridgedFromRelayId = msg._brgFrom ? String(msg._brgFrom) : undefined;
    const isFirstLock = !this.remoteHostPeerId;

    this.remoteHostPeerId = fromPeerId;
    this.relayPool.activeRelayId = relayId;
    this._stopClientHelloLoop();

    const session = await this.cryptoSession.establishPeerSession(
      fromPeerId,
      String(msg.ecdhPub || ''),
      String(msg.nonce || ''),
      false
    );
    this.relayUsageTracker.recordPeerHandshakeRelay(fromPeerId, relayId);

    this.envelopeHandler.registerHostHelloAckPeer(
      fromPeerId,
      String(msg.senderName || 'Host'),
      session.pairingCode,
      relayId,
      isBridgedHost,
      bridgedFromRelayId
    );

    if (isFirstLock) {
      if (!this.allowSpectatorRelay) this.relayPool.closeRedundantRelays(relayId);
      const relayLabel = this.relayPool.getRelayLabel(relayId) || relayId;
      this.callbacks.onRendezvousEstablished?.({
        relayId,
        relayLabel,
        pairingCode: session.pairingCode,
        hostPeerId: fromPeerId,
        hostName: String(msg.senderName || 'Host'),
        requireManualApproval: Boolean(msg.requireManualApproval),
      });
    }

    await this._sendEncryptedToPeer(
      fromPeerId,
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

  async _sendEncryptedToPeer(
    targetPeerId: string | null,
    payloadObj: Record<string, unknown>,
    preferredRelayId: string | null = null
  ): Promise<boolean> {
    const resolvedPeerId = targetPeerId || this.remoteHostPeerId;
    if (!resolvedPeerId || !this.cryptoSession?.getPeerSession(resolvedPeerId)) return false;

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
      this.envelopeHandler.peerRelayRoutes.get(resolvedPeerId) ||
      this.relayPool.activeRelayId;

    const peerMeta = this.envelopeHandler.peerMetadata.get(resolvedPeerId);
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
    const target = targetPeerId || this.remoteHostPeerId;
    return this._sendEncryptedToPeer(target, {
      type: 'answer',
      targetPeerId: target,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      sdp: token,
      pairingCode: this.getPairingCodeForPeer(target),
    });
  }

  async sendCandidate(targetPeerId: string | null, candidate: unknown): Promise<boolean> {
    const target = targetPeerId || this.remoteHostPeerId;
    if (!target || !this.cryptoSession?.getPeerSession(target)) {
      if (target) this.envelopeHandler.queuePendingOutgoingCandidate(target, candidate);
      return false;
    }
    return this._sendEncryptedToPeer(target, {
      type: 'candidate',
      targetPeerId: target,
      fromPeerId: this._peerId,
      senderName: this.playerName,
      candidate,
    });
  }

  async sendRelayAssignment(
    targetPeerId: string,
    assignment: Record<string, unknown>
  ): Promise<boolean> {
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
