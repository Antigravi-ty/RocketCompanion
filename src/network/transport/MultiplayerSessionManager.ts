/**
 * MultiplayerSessionManager.ts
 * Unified Headless Multiplayer Session Coordinator.
 * Manages host/client WebRTC lifecycles, multi-relay E2EE signaling negotiation,
 * 4-digit SAS pairing verification, and spectator daisy-chain routing.
 */

import {
  SignalingProtocolHandler,
  type RelayTransportClient,
  type SignalingPoolHealthSnapshot,
} from './SignalingProtocolHandler.ts';
import { HostSessionController } from './HostSessionController.ts';
import type { ClientSessionController } from './ClientSessionController.ts';
import { ClientJoinNegotiationSubController } from './ClientJoinNegotiationSubController.ts';
import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';
import {
  saveActiveHostOffer,
  clearActiveHostOffer,
} from './signalingRelayConfig.ts';
import { testAllSignalingRelays } from './diagnostics/signalingDiagnosticsProbe.ts';
import {
  applyConnectivityMaskToRoomCode,
  generateRandomRoomCode,
  getSlotBitForRelayId,
  parseRoomCode,
} from '../../ui-core/config/roomCodeConnectivityCodec.ts';

const DEFAULT_HOST_COLOR = Object.freeze({ slot: 3, hex: '#42a5f5' });
const DEFAULT_CLIENT_COLOR = Object.freeze({ slot: 0, hex: '#ff7043' });

export interface SessionColorSelection {
  slot: number;
  hex: string;
}

export interface MultiplayerSessionCallbacks {
  onSessionStatusChange?: (status: Record<string, any>) => void;
  onHostServer?: (config: Record<string, any>) => Promise<void> | void;
  onJoinServer?: (config: {
    channel: P2PWebRTCChannel;
    playerName: string;
    remotePlayerName: string;
    pairingCode?: string;
  }) => Promise<void> | void;
  onStopServer?: () => Promise<void> | void;
  onLeaveServer?: () => Promise<void> | void;
  onPeerConnected?: (
    channel: P2PWebRTCChannel,
    peerName: string,
    peerId: string,
    role: string
  ) => Promise<number | void> | number | void;
  onRemovePlayer?: (carIndex: number) => void;
  onColorSelect?: (carIdx: number, slotId: number | null, hex: string | null) => void;
  onPairingApprovalRequest?: (request: any) => void;
  onUnexpectedDisconnect?: () => void;
  resolvePlayerName?: () => string;
  resolveTeamColor?: (assignedTeam: number | null) => SessionColorSelection | null;
}

export class MultiplayerSessionManager {
  callbacks: MultiplayerSessionCallbacks;
  playerName: string;

  isHosting = false;
  roomId = '';
  password = '';
  joinRoomId = '';
  joinPassword = '';

  hostColorSlot: number;
  hostColorHex: string;
  clientColorSlot: number;
  clientColorHex: string;

  hostController: HostSessionController | null = null;
  readonly clientJoinNegotiator = new ClientJoinNegotiationSubController();
  private hostSignalingHandler: SignalingProtocolHandler | null = null;
  pendingPairingRequests = new Map<string, any>();

  constructor(callbacks: MultiplayerSessionCallbacks = {}) {
    this.callbacks = callbacks;
    this.playerName = this._loadPlayerName();

    const hostColor = this._resolvePreferredColor(0, DEFAULT_HOST_COLOR);
    this.hostColorSlot = hostColor.slot;
    this.hostColorHex = hostColor.hex;

    const fallbackClientSlot = this.hostColorSlot === 0 ? 3 : 0;
    const fallbackClientHex =
      fallbackClientSlot === 3 ? DEFAULT_HOST_COLOR.hex : DEFAULT_CLIENT_COLOR.hex;
    const clientColor = this._resolvePreferredColor(null, {
      slot: fallbackClientSlot,
      hex: fallbackClientHex,
    });
    this.clientColorSlot = clientColor.slot;
    this.clientColorHex = clientColor.hex;
  }

  _updateSessionStatus(status: Record<string, any>): void {
    if (typeof this.callbacks.onSessionStatusChange === 'function') {
      try {
        this.callbacks.onSessionStatusChange(status);
      } catch (err) {
        console.warn('[MultiplayerSessionManager] Error in onSessionStatusChange callback:', err);
      }
    }
  }

  _loadPlayerName(): string {
    const resolved = this.callbacks.resolvePlayerName?.()?.trim();
    if (resolved) {
      return resolved.substring(0, 16);
    }
    return `Player${Math.floor(1000 + Math.random() * 9000)}`;
  }

  _resolvePreferredColor(
    assignedTeam: number | null,
    fallback: SessionColorSelection
  ): SessionColorSelection {
    const custom = this.callbacks.resolveTeamColor?.(assignedTeam);
    if (custom && typeof custom.slot === 'number' && custom.slot >= 0 && custom.hex) {
      return custom;
    }
    return fallback;
  }

  get clientController(): ClientSessionController | null {
    return this.clientJoinNegotiator.clientController;
  }

  set clientController(val: ClientSessionController | null) {
    this.clientJoinNegotiator.clientController = val;
  }

  get signalingHandler(): SignalingProtocolHandler | null {
    return this.hostSignalingHandler || this.clientJoinNegotiator.signalingHandler;
  }

  set signalingHandler(val: SignalingProtocolHandler | null) {
    this.hostSignalingHandler = val;
    if (!val) {
      this.clientJoinNegotiator.signalingHandler = null;
    }
  }

  get hostP2PChannel(): P2PWebRTCChannel | null {
    return this.hostController?.channel || null;
  }

  get clientP2PChannel(): P2PWebRTCChannel | null {
    return this.clientJoinNegotiator.channel;
  }

  get signalingClient(): RelayTransportClient | null {
    return this.signalingHandler?.client || null;
  }

  approvePendingPeer(peerId: string): boolean {
    const req = this.pendingPairingRequests.get(peerId);
    if (!req) return false;
    this.pendingPairingRequests.delete(peerId);
    this._syncPendingPairingStatus();
    req.approve?.();
    return true;
  }

  declinePendingPeer(peerId: string): boolean {
    const req = this.pendingPairingRequests.get(peerId);
    if (!req) return false;
    this.pendingPairingRequests.delete(peerId);
    this._syncPendingPairingStatus();
    req.decline?.('Host declined the pairing verification request.');
    return true;
  }

  _syncPendingPairingStatus(): void {
    const list = Array.from(this.pendingPairingRequests.values()).map((r) => ({
      peerId: r.peerId,
      peerName: r.peerName,
      pairingCode: r.pairingCode,
      relayLabel: r.relayLabel,
      role: r.role,
    }));
    this._updateSessionStatus({ pendingPairingRequests: list });
  }

  async startHosting(
    roomId: string | null = null,
    password = '',
    roomConfig: Record<string, any> = {}
  ): Promise<string> {
    if (this.clientController || this.signalingHandler) {
      await this.leaveSession();
    }
    if (this.hostController) {
      await this.stopHosting();
    }
    const parsedHostRoom = roomId ? parseRoomCode(roomId) : null;
    this.roomId = parsedHostRoom?.canonicalRoomCode || generateRandomRoomCode(0x0f);
    this.password = String(password || '').trim();
    this.isHosting = true;
    this.pendingPairingRequests.clear();

    const hostColor = this._resolvePreferredColor(0, DEFAULT_HOST_COLOR);
    this.hostColorSlot = hostColor.slot;
    this.hostColorHex = hostColor.hex;

    if (this.callbacks.onHostServer) {
      await this.callbacks.onHostServer({
        playerName: this.playerName,
        roomId: this.roomId,
        password: this.password,
        colorSlot: this.hostColorSlot,
        ...roomConfig,
      });
    }

    this.callbacks.onColorSelect?.(0, this.hostColorSlot, this.hostColorHex);

    this.hostController = new HostSessionController(
      {
        roomId: this.roomId,
        playerName: this.playerName,
        colorSlot: this.hostColorSlot,
        colorHex: this.hostColorHex,
      },
      {
        onPeerConnected: async (channel, peerName, peerId, role) => {
          let assignedCarIdx: number | void = undefined;
          if (this.callbacks.onPeerConnected) {
            assignedCarIdx = await this.callbacks.onPeerConnected(channel, peerName, peerId, role);
            if (typeof assignedCarIdx === 'number' && assignedCarIdx >= 0) {
              channel.carIndex = assignedCarIdx;
            }
          }
          const pairingCode =
            channel?.pairingCode ||
            this.signalingHandler?.getPairingCodeForPeer?.(peerId) ||
            undefined;
          this._updateSessionStatus({
            connectedPeers: this.hostController?.getConnectedPeerList?.() || [
              {
                id: peerId || channel.peerId || 'peer-1',
                name: peerName,
                carIndex: assignedCarIdx,
                pingMs: 0,
                pairingCode,
              },
            ],
          });
          return assignedCarIdx;
        },
        onPeerDisconnected: (peerId, channel) => {
          this.pendingPairingRequests.delete(peerId);
          this._syncPendingPairingStatus();
          if (typeof channel?.carIndex === 'number' && channel.carIndex > 0) {
            this.callbacks.onRemovePlayer?.(channel.carIndex);
          }
          this._updateSessionStatus({
            connectedPeers: this.hostController?.getConnectedPeerList?.() || [],
          });
        },
        onColorChange: (carIdx, slotId, hex) => {
          this.callbacks.onColorSelect?.(carIdx, slotId, hex);
        },
        onIceCandidate: (cand, targetPeerId) => {
          if (this.signalingHandler) {
            this.signalingHandler.sendCandidate(targetPeerId || null, cand);
          }
        },
      }
    );

    const offerToken = await this.hostController.initializeChannel();

    if (!this.password) {
      saveActiveHostOffer({
        roomId: this.roomId,
        token: offerToken,
        colorSlot: this.hostColorSlot,
        colorHex: this.hostColorHex,
        playerName: this.playerName,
        timestamp: Date.now(),
      });
    } else {
      clearActiveHostOffer();
    }

    this.initHostSignaling();
    return offerToken;
  }

  initHostSignaling(probedMask?: number): void {
    if (!this.isHosting) return;
    if (this.hostSignalingHandler) {
      this.hostSignalingHandler.cleanup();
      this.hostSignalingHandler = null;
    }
    const parsedHostRoom = parseRoomCode(this.roomId);
    const effectiveProbedMask =
      typeof probedMask === 'number' && (probedMask & 0x0f) !== 0
        ? probedMask & 0x0f
        : parsedHostRoom?.hostMask || 0x0f;

    this.hostSignalingHandler = new SignalingProtocolHandler(
      {
        roomId: this.roomId,
        password: this.password,
        role: 'host',
        playerName: this.playerName,
        allowSpectatorRelay: true,
        probedHostMask: effectiveProbedMask,
      },
      {
        onOpen: ({ relayLabel }) => {
          const liveMask = this.hostSignalingHandler?.relayPool.getConnectedConnectivityMask() || 0;
          const healthSnapshot = this.hostSignalingHandler?.relayPool.getHealthSnapshot();
          this._updateSessionStatus({
            signalingConnected: true,
            signalingHealthLevel: healthSnapshot?.healthLevel || 'healthy',
            roomId: this.roomId,
            activeRelayLabel: relayLabel,
            hostMask: liveMask,
          });
        },
        onRelayHealthChanged: (snapshot: SignalingPoolHealthSnapshot) => {
          this._updateSessionStatus({
            signalingConnected: snapshot.hasAnyConnected,
            signalingHealthLevel: snapshot.healthLevel,
            hostMask: snapshot.connectedMask,
          });
        },
        onClose: () => {
          this._updateSessionStatus({
            signalingConnected: false,
            signalingHealthLevel: 'offline',
          });
          if (this.isHosting) {
            this.hostSignalingHandler?.scheduleReconnect(3000, () =>
              this.initHostSignaling(effectiveProbedMask)
            );
          }
        },
        onError: () => {
          this._updateSessionStatus({
            signalingConnected: false,
            signalingHealthLevel: 'offline',
          });
          if (this.isHosting) {
            this.hostSignalingHandler?.scheduleReconnect(3000, () =>
              this.initHostSignaling(effectiveProbedMask)
            );
          }
        },
        onPairingApprovalRequired: (request) => {
          this.pendingPairingRequests.set(request.peerId, request);
          this._syncPendingPairingStatus();
          this.callbacks.onPairingApprovalRequest?.(request);
        },
        onPeerJoined: ({ peerId, name, peerName, role, allowSpectatorRelay, pairingCode }) => {
          this.pendingPairingRequests.delete(peerId);
          this._syncPendingPairingStatus();
          this.hostController?.dispatchOfferToPeer(
            peerId,
            name || peerName,
            this.hostSignalingHandler,
            role || 'player',
            { allowSpectatorRelay, pairingCode }
          );
        },
        onRoomInfo: ({ participants }) => {
          if (!Array.isArray(participants) || !this.isHosting) return;
          for (const p of participants) {
            if (p?.peerId && p.peerId !== this.hostSignalingHandler?.peerId) {
              this.hostController?.dispatchOfferToPeer(
                p.peerId,
                p.peerName || p.name,
                this.hostSignalingHandler,
                p.role || 'player'
              );
            }
          }
        },
        onRequestOffer: ({ fromPeerId, name, senderName, role, pairingCode }) => {
          this.hostController?.dispatchOfferToPeer(
            fromPeerId,
            name || senderName,
            this.hostSignalingHandler,
            role || 'player',
            { pairingCode }
          );
        },
        onAnswer: async ({ sdp, fromPeerId, pairingCode }) => {
          try {
            await this.hostController?.handleAnswer(sdp, fromPeerId || null, { pairingCode });
          } catch (err) {
            console.error('[MultiplayerSessionManager] Error accepting peer answer:', err);
            throw err;
          }
        },
        onCandidate: ({ candidate, fromPeerId }) => {
          this.hostController?.handleRemoteCandidate(candidate, fromPeerId || null);
        },
      }
    );

    this.hostSignalingHandler.connect().catch((err) => {
      console.warn(
        '[MultiplayerSessionManager] Signaling connection notice:',
        err?.message || err
      );
      if (this.isHosting) {
        this.hostSignalingHandler?.scheduleReconnect(3000, () =>
          this.initHostSignaling(effectiveProbedMask)
        );
      }
    });
  }

  async reprobeAndRefreshHostSignaling(): Promise<void> {
    if (!this.isHosting) return;
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
    this.roomId = applyConnectivityMaskToRoomCode(this.roomId, cleanMask);
    this._updateSessionStatus({
      roomId: this.roomId,
      hostMask: cleanMask,
    });
    this.initHostSignaling(cleanMask);
  }

  notifyMatchStarted(): void {
    this.hostSignalingHandler?.applyMatchPhaseRelayConvergence();
  }

  notifyReturnedToLobby(): void {
    this.hostSignalingHandler?.restoreLobbyRelays();
  }

  async joinRoom(roomId: string, password = '', timeoutMs = 10000): Promise<boolean> {
    const parsedJoinRoom = parseRoomCode(roomId);
    const cleanRoomId = parsedJoinRoom?.canonicalRoomCode || (roomId || '').trim().toLowerCase();
    if (!cleanRoomId) {
      throw new Error('[MultiplayerSessionManager] Room ID is required to join');
    }

    if (this.clientController || this.signalingHandler) {
      await this.leaveSession();
    }
    if (this.hostController) {
      await this.stopHosting();
    }

    this.joinRoomId = cleanRoomId;
    this.joinPassword = String(password || '').trim();
    const fallbackClientSlot = this.hostColorSlot === 0 ? 3 : 0;
    const fallbackClientHex =
      fallbackClientSlot === 3 ? DEFAULT_HOST_COLOR.hex : DEFAULT_CLIENT_COLOR.hex;
    const clientColor = this._resolvePreferredColor(null, {
      slot: fallbackClientSlot,
      hex: fallbackClientHex,
    });
    this.clientColorSlot = clientColor.slot;
    this.clientColorHex = clientColor.hex;

    return this.clientJoinNegotiator.executeJoin(
      {
        roomId: cleanRoomId,
        password: this.joinPassword,
        timeoutMs,
        playerName: this.playerName,
        colorSlot: this.clientColorSlot,
        colorHex: this.clientColorHex,
      },
      {
        onSessionStatusChange: (status) => this._updateSessionStatus(status),
        onJoinServer: this.callbacks.onJoinServer,
        onAbortJoin: () => {
          void this.leaveSession();
        },
        onUnexpectedDisconnect: this.callbacks.onUnexpectedDisconnect,
      }
    );
  }

  async stopHosting(): Promise<void> {
    this.isHosting = false;
    this.pendingPairingRequests.clear();
    if (this.hostSignalingHandler) {
      this.hostSignalingHandler.cleanup();
      this.hostSignalingHandler = null;
    }
    if (this.hostController) {
      this.hostController.cleanup();
      this.hostController = null;
    }
    clearActiveHostOffer();
    if (this.callbacks.onStopServer) {
      await this.callbacks.onStopServer();
    }
  }

  async leaveSession(): Promise<void> {
    this.pendingPairingRequests.clear();
    this.clientJoinNegotiator.cleanup();
    if (this.hostSignalingHandler) {
      this.hostSignalingHandler.cleanup();
      this.hostSignalingHandler = null;
    }
    if (this.callbacks.onLeaveServer) {
      await this.callbacks.onLeaveServer();
    }
  }

  reconnectSignaling(): void {
    if (this.signalingHandler) {
      this.signalingHandler.connect().catch((err) => {
        console.warn('[MultiplayerSessionManager] Reconnect error:', err);
      });
    }
  }
}

export default MultiplayerSessionManager;
