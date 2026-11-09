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
  deliverPairingApprovalRequest?: (request: PendingPairingRequest) => void;
}

export class HostSignalingNegotiationSubController {
  signalingHandler: SignalingProtocolHandler | null = null;
  pendingPairingRequests = new Map<string, PendingPairingRequest>();
  private activeCallbacks: HostSignalingNegotiationCallbacks | null = null;
  private activeProbedMask = 0x0f;

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

  syncPendingPairingStatus(updateSessionStatus: (status: Record<string, unknown>) => void): void {
    const list = Array.from(this.pendingPairingRequests.values()).map((r) => ({
      peerId: r.peerId,
      peerName: r.peerName,
      pairingCode: r.pairingCode,
      relayLabel: r.relayLabel,
      role: r.role,
    }));
    updateSessionStatus({ pendingPairingRequests: list });
  }

  private handleSignalingOpen = ({ relayLabel }: { relayLabel: string }): void => {
    const callbacks = this.activeCallbacks;
    if (!callbacks) return;
    const liveMask = this.signalingHandler?.relayPool.getConnectedConnectivityMask() || 0;
    const healthSnapshot = this.signalingHandler?.relayPool.getHealthSnapshot();
    callbacks.updateSessionStatus({
      signalingConnected: true,
      signalingHealthLevel: healthSnapshot?.healthLevel || 'healthy',
      roomId: callbacks.getRoomId(),
      activeRelayLabel: relayLabel,
      hostMask: liveMask,
    });
  };

  private handleRelayHealthChanged = (snapshot: SignalingPoolHealthSnapshot): void => {
    this.activeCallbacks?.updateSessionStatus({
      signalingConnected: snapshot.hasAnyConnected,
      signalingHealthLevel: snapshot.healthLevel,
      hostMask: snapshot.connectedMask,
    });
  };

  private handleSignalingDisconnected = (): void => {
    const callbacks = this.activeCallbacks;
    if (!callbacks) return;
    callbacks.updateSessionStatus({
      signalingConnected: false,
      signalingHealthLevel: 'offline',
    });
    if (callbacks.isHosting()) {
      const mask = this.activeProbedMask;
      this.signalingHandler?.scheduleReconnect(3000, () => this.initHostSignaling(callbacks, mask));
    }
  };

  private handlePairingApprovalRequired = (request: PendingPairingRequest): void => {
    const callbacks = this.activeCallbacks;
    if (!callbacks) return;
    this.pendingPairingRequests.set(request.peerId, request);
    this.syncPendingPairingStatus(callbacks.updateSessionStatus);
    callbacks.deliverPairingApprovalRequest?.(request);
  };

  private handlePeerJoined = ({
    peerId,
    name,
    peerName,
    role,
    allowSpectatorRelay,
    pairingCode,
  }: {
    peerId: string;
    name?: string;
    peerName?: string;
    role?: string;
    allowSpectatorRelay?: boolean;
    pairingCode?: string;
  }): void => {
    const callbacks = this.activeCallbacks;
    if (!callbacks) return;
    this.pendingPairingRequests.delete(peerId);
    this.syncPendingPairingStatus(callbacks.updateSessionStatus);
    void callbacks
      .getHostController()
      ?.dispatchOfferToPeer(peerId, name || peerName, this.signalingHandler, role || 'player', {
        allowSpectatorRelay,
        pairingCode,
      });
  };

  private handleRoomInfo = ({
    participants,
  }: {
    participants?: Array<{ peerId?: string; peerName?: string; name?: string; role?: string }>;
  }): void => {
    const callbacks = this.activeCallbacks;
    if (!callbacks || !Array.isArray(participants) || !callbacks.isHosting()) return;
    for (const p of participants) {
      if (p?.peerId && p.peerId !== this.signalingHandler?.peerId) {
        void callbacks
          .getHostController()
          ?.dispatchOfferToPeer(
            p.peerId,
            p.peerName || p.name,
            this.signalingHandler,
            p.role || 'player'
          );
      }
    }
  };

  private handleRequestOffer = ({
    fromPeerId,
    name,
    senderName,
    role,
    pairingCode,
  }: {
    fromPeerId: string;
    name?: string;
    senderName?: string;
    role?: string;
    pairingCode?: string;
  }): void => {
    void this.activeCallbacks
      ?.getHostController()
      ?.dispatchOfferToPeer(
        fromPeerId,
        name || senderName,
        this.signalingHandler,
        role || 'player',
        { pairingCode }
      );
  };

  private handleAnswer = async ({
    sdp,
    fromPeerId,
    pairingCode,
  }: {
    sdp: string;
    fromPeerId?: string;
    pairingCode?: string;
  }): Promise<void> => {
    try {
      await this.activeCallbacks?.getHostController()?.handleAnswer(sdp, fromPeerId || null, {
        pairingCode,
      });
    } catch (err) {
      console.error('[MultiplayerSessionManager] Error accepting peer answer:', err);
      throw err;
    }
  };

  private handleCandidate = ({
    candidate,
    fromPeerId,
  }: {
    candidate: RTCIceCandidateInit | Record<string, unknown>;
    fromPeerId?: string;
  }): void => {
    this.activeCallbacks?.getHostController()?.handleRemoteCandidate(candidate, fromPeerId || null);
  };

  initHostSignaling(callbacks: HostSignalingNegotiationCallbacks, probedMask?: number): void {
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

    this.activeCallbacks = callbacks;
    this.activeProbedMask = effectiveProbedMask;

    const signalingCallbacks = {
      handleOpen: this.handleSignalingOpen,
      handleRelayHealthChanged: this.handleRelayHealthChanged,
      handleClose: this.handleSignalingDisconnected,
      handleError: this.handleSignalingDisconnected,
      handlePairingApprovalRequired: this.handlePairingApprovalRequired,
      handlePeerJoined: this.handlePeerJoined,
      handleRoomInfo: this.handleRoomInfo,
      handleRequestOffer: this.handleRequestOffer,
      handleAnswer: this.handleAnswer,
      handleCandidate: this.handleCandidate,
    };

    this.signalingHandler = new SignalingProtocolHandler(
      {
        roomId,
        password: callbacks.getPassword(),
        role: 'host',
        playerName: callbacks.getPlayerName(),
        allowSpectatorRelay: true,
        probedHostMask: effectiveProbedMask,
      },
      signalingCallbacks
    );

    this.signalingHandler.connect().catch((err) => {
      console.warn('[MultiplayerSessionManager] Signaling connection notice:', err?.message || err);
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
    const cleanMask = probedMask & 0x0f || 0x0f;
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
    this.signalingHandler?.relayPool.restoreLobbyRelays();
  }

  cleanup(): void {
    this.activeCallbacks = null;
    this.pendingPairingRequests.clear();
    if (this.signalingHandler) {
      this.signalingHandler.cleanup();
      this.signalingHandler = null;
    }
  }
}
