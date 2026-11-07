/**
 * HostSignalingNegotiationSubController.ts
 * Stateful SubController coordinating the host signaling lifecycle:
 * multi-relay E2EE signaling connection, 4-digit SAS pairing approval queue,
 * automatic reconnect on relay drop, relay re-probing, and match-phase relay convergence.
 */

import {
  SignalingProtocolHandler,
  type SignalingPoolHealthSnapshot,
} from './SignalingProtocolHandler.ts';
import type { HostSessionController } from './HostSessionController.ts';
import { testAllSignalingRelays } from './diagnostics/signalingDiagnosticsProbe.ts';
import {
  applyConnectivityMaskToRoomCode,
  getSlotBitForRelayId,
  parseRoomCode,
} from '../../ui-core/config/roomCodeConnectivityCodec.ts';

export interface PendingPairingRequest {
  peerId: string;
  peerName: string;
  pairingCode: string;
  relayId?: string;
  relayLabel: string;
  role: string;
  approve?: () => Promise<void> | void;
  decline?: (reason?: string) => Promise<void> | void;
}

export interface HostSignalingNegotiationCallbacks {
  getRoomId: () => string;
  setRoomId: (roomId: string) => void;
  getPassword: () => string;
  getPlayerName: () => string;
  isHosting: () => boolean;
  getHostController: () => HostSessionController | null;
  updateSessionStatus: (status: Record<string, unknown>) => void;
  onPairingApprovalRequest?: (request: PendingPairingRequest) => void;
}

export class HostSignalingNegotiationSubController {
  signalingHandler: SignalingProtocolHandler | null = null;
  pendingPairingRequests = new Map<string, PendingPairingRequest>();

  approvePendingPeer(
    peerId: string,
    updateSessionStatus: (status: Record<string, unknown>) => void
  ): boolean {
    const req = this.pendingPairingRequests.get(peerId);
    if (!req) return false;
    this.pendingPairingRequests.delete(peerId);
    this.syncPendingPairingStatus(updateSessionStatus);
    void req.approve?.();
    return true;
  }

  declinePendingPeer(
    peerId: string,
    updateSessionStatus: (status: Record<string, unknown>) => void
  ): boolean {
    const req = this.pendingPairingRequests.get(peerId);
    if (!req) return false;
    this.pendingPairingRequests.delete(peerId);
    this.syncPendingPairingStatus(updateSessionStatus);
    void req.decline?.('Host declined the pairing verification request.');
    return true;
  }

  removePendingPeer(
    peerId: string,
    updateSessionStatus: (status: Record<string, unknown>) => void
  ): void {
    if (this.pendingPairingRequests.delete(peerId)) {
      this.syncPendingPairingStatus(updateSessionStatus);
    }
  }

  syncPendingPairingStatus(
    updateSessionStatus: (status: Record<string, unknown>) => void
  ): void {
    const list = Array.from(this.pendingPairingRequests.values()).map((r) => ({
      peerId: r.peerId,
      peerName: r.peerName,
      pairingCode: r.pairingCode,
      relayLabel: r.relayLabel,
      role: r.role,
    }));
    updateSessionStatus({ pendingPairingRequests: list });
  }

  initHostSignaling(
    callbacks: HostSignalingNegotiationCallbacks,
    probedMask?: number
  ): void {
    if (!callbacks.isHosting()) return;
    if (this.signalingHandler) {
      this.signalingHandler.cleanup();
      this.signalingHandler = null;
    }

    const roomId = callbacks.getRoomId();
    const parsedHostRoom = parseRoomCode(roomId);
    const effectiveProbedMask =
      typeof probedMask === 'number' && (probedMask & 0x0f) !== 0
        ? probedMask & 0x0f
        : parsedHostRoom?.hostMask || 0x0f;

    this.signalingHandler = new SignalingProtocolHandler(
      {
        roomId,
        password: callbacks.getPassword(),
        role: 'host',
        playerName: callbacks.getPlayerName(),
        allowSpectatorRelay: true,
        probedHostMask: effectiveProbedMask,
      },
      {
        onOpen: ({ relayLabel }) => {
          const liveMask = this.signalingHandler?.relayPool.getConnectedConnectivityMask() || 0;
          const healthSnapshot = this.signalingHandler?.relayPool.getHealthSnapshot();
          callbacks.updateSessionStatus({
            signalingConnected: true,
            signalingHealthLevel: healthSnapshot?.healthLevel || 'healthy',
            roomId: callbacks.getRoomId(),
            activeRelayLabel: relayLabel,
            hostMask: liveMask,
          });
        },
        onRelayHealthChanged: (snapshot: SignalingPoolHealthSnapshot) => {
          callbacks.updateSessionStatus({
            signalingConnected: snapshot.hasAnyConnected,
            signalingHealthLevel: snapshot.healthLevel,
            hostMask: snapshot.connectedMask,
          });
        },
        onClose: () => {
          callbacks.updateSessionStatus({
            signalingConnected: false,
            signalingHealthLevel: 'offline',
          });
          if (callbacks.isHosting()) {
            this.signalingHandler?.scheduleReconnect(3000, () =>
              this.initHostSignaling(callbacks, effectiveProbedMask)
            );
          }
        },
        onError: () => {
          callbacks.updateSessionStatus({
            signalingConnected: false,
            signalingHealthLevel: 'offline',
          });
          if (callbacks.isHosting()) {
            this.signalingHandler?.scheduleReconnect(3000, () =>
              this.initHostSignaling(callbacks, effectiveProbedMask)
            );
          }
        },
        onPairingApprovalRequired: (request: PendingPairingRequest) => {
          this.pendingPairingRequests.set(request.peerId, request);
          this.syncPendingPairingStatus(callbacks.updateSessionStatus);
          callbacks.onPairingApprovalRequest?.(request);
        },
        onPeerJoined: ({ peerId, name, peerName, role, allowSpectatorRelay, pairingCode }) => {
          this.pendingPairingRequests.delete(peerId);
          this.syncPendingPairingStatus(callbacks.updateSessionStatus);
          void callbacks.getHostController()?.dispatchOfferToPeer(
            peerId,
            name || peerName,
            this.signalingHandler,
            role || 'player',
            { allowSpectatorRelay, pairingCode }
          );
        },
        onRoomInfo: ({ participants }) => {
          if (!Array.isArray(participants) || !callbacks.isHosting()) return;
          for (const p of participants) {
            if (p?.peerId && p.peerId !== this.signalingHandler?.peerId) {
              void callbacks.getHostController()?.dispatchOfferToPeer(
                p.peerId,
                p.peerName || p.name,
                this.signalingHandler,
                p.role || 'player'
              );
            }
          }
        },
        onRequestOffer: ({ fromPeerId, name, senderName, role, pairingCode }) => {
          void callbacks.getHostController()?.dispatchOfferToPeer(
            fromPeerId,
            name || senderName,
            this.signalingHandler,
            role || 'player',
            { pairingCode }
          );
        },
        onAnswer: async ({ sdp, fromPeerId, pairingCode }) => {
          try {
            await callbacks.getHostController()?.handleAnswer(sdp, fromPeerId || null, {
              pairingCode,
            });
          } catch (err) {
            console.error('[MultiplayerSessionManager] Error accepting peer answer:', err);
            throw err;
          }
        },
        onCandidate: ({ candidate, fromPeerId }) => {
          callbacks.getHostController()?.handleRemoteCandidate(candidate, fromPeerId || null);
        },
      }
    );

    this.signalingHandler.connect().catch((err) => {
      console.warn(
        '[MultiplayerSessionManager] Signaling connection notice:',
        err?.message || err
      );
      if (callbacks.isHosting()) {
        this.signalingHandler?.scheduleReconnect(3000, () =>
          this.initHostSignaling(callbacks, effectiveProbedMask)
        );
      }
    });
  }

  async reprobeAndRefresh(callbacks: HostSignalingNegotiationCallbacks): Promise<void> {
    if (!callbacks.isHosting()) return;
    let probedMask = 0;
    try {
      const probeResults = await testAllSignalingRelays(4000);
      for (const r of probeResults) {
        if (r.ok) {
          probedMask |= getSlotBitForRelayId(r.id);
        }
      }
    } catch (err) {
      console.warn('[MultiplayerSessionManager] Relay re-probe failed:', err);
    }
    const cleanMask = (probedMask & 0x0f) || 0x0f;
    const nextRoomId = applyConnectivityMaskToRoomCode(callbacks.getRoomId(), cleanMask);
    callbacks.setRoomId(nextRoomId);
    callbacks.updateSessionStatus({
      roomId: nextRoomId,
      hostMask: cleanMask,
    });
    this.initHostSignaling(callbacks, cleanMask);
  }

  notifyMatchStarted(): void {
    this.signalingHandler?.applyMatchPhaseRelayConvergence();
  }

  notifyReturnedToLobby(): void {
    this.signalingHandler?.restoreLobbyRelays();
  }

  cleanup(): void {
    this.pendingPairingRequests.clear();
    if (this.signalingHandler) {
      this.signalingHandler.cleanup();
      this.signalingHandler = null;
    }
  }
}
