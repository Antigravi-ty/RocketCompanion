/**
 * SignalingEncryptedEnvelopeHandler.ts
 * Stateful SubController for peer metadata, relay routing, pending candidate queues,
 * pairing hold keepalives, and incoming encrypted E2EE signaling envelope dispatching.
 */

import { getManualPairingConfirmationEnabled } from './signalingRelayConfig.ts';
import type { SignalingCryptoSession } from './SignalingCryptoSession.ts';

export interface SignalingPeerMetadata {
  peerId: string;
  name: string;
  role: string;
  allowSpectatorRelay?: boolean;
  pairingCode: string;
  relayId: string;
  requiresBridge?: boolean;
  bridgedFromRelayId?: string;
  confirmed: boolean;
  offerDispatched?: boolean;
  approved?: boolean;
}

export type SignalingCallbackFn = (payload: Record<string, unknown>) => unknown;

export interface SignalingEnvelopeDispatchContext {
  localPeerId: string;
  playerName: string;
  cryptoSession: SignalingCryptoSession | null;
  callbacks: Record<string, SignalingCallbackFn | undefined>;
  getRelayLabel: (relayId: string) => string;
  getPairingCodeForPeer: (peerId: string) => string | null;
  sendEncryptedToPeer: (
    targetPeerId: string,
    payloadObj: Record<string, unknown>,
    preferredRelayId?: string | null
  ) => Promise<boolean>;
  sendCandidate: (targetPeerId: string, candidate: unknown) => Promise<boolean>;
  isCleanedUp: () => boolean;
}

export interface EncryptedSignalingWrapper {
  fromPeerId?: string;
  _brgHop?: number;
  _brgFrom?: string;
  env?: Parameters<SignalingCryptoSession['decryptFromPeer']>[1];
}

export class SignalingEncryptedEnvelopeHandler {
  peerRelayRoutes = new Map<string, string>();
  peerMetadata = new Map<string, SignalingPeerMetadata>();
  pendingCandidatesOut = new Map<string, unknown[]>();
  pairingKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

  registerClientHelloPeer(
    peerId: string,
    senderName: string | undefined,
    role: string | undefined,
    allowSpectatorRelay: boolean | undefined,
    pairingCode: string,
    relayId: string,
    requiresBridge = false,
    bridgedFromRelayId?: string
  ): void {
    const existingMeta = this.peerMetadata.get(peerId);
    if (!existingMeta || !existingMeta.confirmed) {
      this.peerRelayRoutes.set(peerId, relayId);
    }

    this.peerMetadata.set(peerId, {
      peerId,
      name: senderName || 'Player',
      role: role || 'player',
      allowSpectatorRelay: allowSpectatorRelay !== false,
      pairingCode,
      relayId: this.peerRelayRoutes.get(peerId) || relayId,
      requiresBridge: Boolean(requiresBridge || existingMeta?.requiresBridge),
      bridgedFromRelayId: bridgedFromRelayId || existingMeta?.bridgedFromRelayId,
      confirmed: existingMeta?.confirmed || false,
      offerDispatched: existingMeta?.offerDispatched || false,
      approved: existingMeta?.approved || false,
    });
  }

  registerHostHelloAckPeer(
    peerId: string,
    senderName: string | undefined,
    pairingCode: string,
    relayId: string,
    requiresBridge = false,
    bridgedFromRelayId?: string
  ): void {
    this.peerRelayRoutes.set(peerId, relayId);
    this.peerMetadata.set(peerId, {
      peerId,
      name: senderName || 'Host',
      role: 'host',
      pairingCode,
      relayId,
      requiresBridge,
      bridgedFromRelayId,
      confirmed: true,
    });
  }

  queuePendingOutgoingCandidate(targetPeerId: string, candidate: unknown): void {
    const list = this.pendingCandidatesOut.get(targetPeerId) || [];
    list.push(candidate);
    this.pendingCandidatesOut.set(targetPeerId, list);
  }

  startClientPairingKeepAlive(
    hostPeerId: string,
    pairingCode: string,
    hostName: string | undefined,
    ctx: SignalingEnvelopeDispatchContext
  ): void {
    this.stopPairingKeepAlive();
    ctx.callbacks.onPairingHold?.({
      hostPeerId,
      hostName: hostName || 'Host',
      pairingCode,
    });
    this.pairingKeepAliveTimer = setInterval(() => {
      if (ctx.isCleanedUp()) {
        this.stopPairingKeepAlive();
        return;
      }
      ctx
        .sendEncryptedToPeer(hostPeerId, {
          type: 'sig_pairing_ping',
          fromPeerId: ctx.localPeerId,
          timestamp: Date.now(),
        })
        .catch(() => {});
    }, 2000);
  }

  stopPairingKeepAlive(): void {
    if (this.pairingKeepAliveTimer) {
      clearInterval(this.pairingKeepAliveTimer);
      this.pairingKeepAliveTimer = null;
    }
  }

  async handleEncryptedEnvelope(
    relayId: string,
    wrapper: EncryptedSignalingWrapper,
    ctx: SignalingEnvelopeDispatchContext
  ): Promise<void> {
    const fromPeerId = wrapper.fromPeerId;
    if (!fromPeerId || !wrapper.env || !ctx.cryptoSession?.getPeerSession(fromPeerId)) return;

    const existingMeta = this.peerMetadata.get(fromPeerId);
    if (existingMeta && Number(wrapper._brgHop || 0) >= 1) {
      existingMeta.requiresBridge = true;
      if (wrapper._brgFrom) {
        existingMeta.bridgedFromRelayId = String(wrapper._brgFrom);
      }
    }

    let inner: Record<string, unknown> & {
      type?: string;
      pairingCode?: string;
      hostName?: string;
      reason?: string;
      name?: string;
    };
    try {
      inner = await ctx.cryptoSession.decryptFromPeer(fromPeerId, wrapper.env);
    } catch (err: unknown) {
      console.warn(
        '[SignalingProtocolHandler] Dropped undecryptable signaling frame:',
        err instanceof Error ? err.message : err
      );
      return;
    }

    if (!inner || !inner.type) return;

    if (inner.type === 'sig_handshake_confirm') {
      await this.handleHandshakeConfirm(relayId, fromPeerId, ctx);
      return;
    }

    if (inner.type === 'sig_pairing_hold') {
      this.startClientPairingKeepAlive(
        fromPeerId,
        String(inner.pairingCode || ''),
        inner.hostName,
        ctx
      );
      return;
    }

    if (inner.type === 'sig_pairing_ping') {
      ctx.callbacks.onPairingKeepAlive?.({ peerId: fromPeerId, timestamp: Date.now() });
      await ctx.sendEncryptedToPeer(fromPeerId, {
        type: 'sig_pairing_pong',
        fromPeerId: ctx.localPeerId,
        timestamp: Date.now(),
      });
      return;
    }

    if (inner.type === 'sig_pairing_pong') {
      ctx.callbacks.onPairingKeepAlive?.({ peerId: fromPeerId, timestamp: Date.now() });
      return;
    }

    if (inner.type === 'sig_pairing_approved') {
      this.stopPairingKeepAlive();
      ctx.callbacks.onPairingApproved?.({
        hostPeerId: fromPeerId,
        pairingCode: inner.pairingCode,
      });
      return;
    }

    if (inner.type === 'sig_pairing_declined') {
      this.stopPairingKeepAlive();
      ctx.callbacks.onPairingDeclined?.({
        hostPeerId: fromPeerId,
        reason: inner.reason || 'Host declined the connection request.',
      });
      return;
    }

    if (inner.type === 'relay_assignment') {
      ctx.callbacks.onRelayAssignment?.(inner);
      return;
    }

    if (inner.type === 'request_offer') {
      const meta = this.peerMetadata.get(fromPeerId);
      if (meta && (!getManualPairingConfirmationEnabled() || meta.approved)) {
        ctx.callbacks.onRequestOffer?.({
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
      this.stopPairingKeepAlive();
      ctx.callbacks.onOffer?.({
        ...inner,
        fromPeerId,
        pairingCode: ctx.getPairingCodeForPeer(fromPeerId),
        relayId,
      });
      return;
    }

    if (inner.type === 'answer') {
      ctx.callbacks.onAnswer?.({
        ...inner,
        fromPeerId,
        pairingCode: ctx.getPairingCodeForPeer(fromPeerId),
        relayId,
      });
      return;
    }

    if (inner.type === 'candidate') {
      ctx.callbacks.onCandidate?.({
        ...inner,
        fromPeerId,
        relayId,
      });
      return;
    }
  }

  async handleHandshakeConfirm(
    relayId: string,
    fromPeerId: string,
    ctx: SignalingEnvelopeDispatchContext
  ): Promise<void> {
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
      ctx.callbacks.onPeerJoined?.({
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
          await ctx.sendCandidate(fromPeerId, cand);
        }
      }
    };

    if (!getManualPairingConfirmationEnabled() || meta.approved) {
      await dispatchPeerReady();
      return;
    }

    await ctx.sendEncryptedToPeer(
      fromPeerId,
      {
        type: 'sig_pairing_hold',
        pairingCode: meta.pairingCode,
        hostName: ctx.playerName,
        timestamp: Date.now(),
      },
      relayId
    );

    if (typeof ctx.callbacks.onPairingApprovalRequired === 'function') {
      ctx.callbacks.onPairingApprovalRequired({
        peerId: fromPeerId,
        peerName: meta.name,
        role: meta.role,
        pairingCode: meta.pairingCode,
        relayId,
        relayLabel: ctx.getRelayLabel(relayId),
        approve: async () => {
          meta.approved = true;
          await ctx.sendEncryptedToPeer(
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
          await ctx.sendEncryptedToPeer(
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

  reset(): void {
    this.stopPairingKeepAlive();
    this.peerRelayRoutes.clear();
    this.peerMetadata.clear();
    this.pendingCandidatesOut.clear();
  }
}
