/**
 * MultiplayerSessionManager.ts
 * Unified Headless Multiplayer Session Coordinator.
 * Manages host/client WebRTC lifecycles, multi-relay E2EE signaling negotiation,
 * 4-digit SAS pairing verification, and spectator daisy-chain routing.
 */

import type { SignalingProtocolHandler } from './SignalingProtocolHandler.ts';
import { HostSessionController } from './HostSessionController.ts';
import type { ClientSessionController } from './ClientSessionController.ts';
import { ClientJoinNegotiationSubController } from './ClientJoinNegotiationSubController.ts';
import {
  HostSignalingNegotiationSubController,
  type HostSignalingNegotiationCallbacks,
  type PendingPairingRequest,
} from './HostSignalingNegotiationSubController.ts';
import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';
import { saveActiveHostOffer, clearActiveHostOffer } from './signalingRelayConfig.ts';
import {
  generateRandomRoomCode,
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
  onPairingApprovalRequest?: (request: PendingPairingRequest) => void;
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
  readonly hostSignalingNegotiator = new HostSignalingNegotiationSubController();
  readonly clientJoinNegotiator = new ClientJoinNegotiationSubController();

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

  private getHostSignalingCallbacks(): HostSignalingNegotiationCallbacks {
    return {
      getRoomId: () => this.roomId,
      setRoomId: (roomId) => {
        this.roomId = roomId;
      },
      getPassword: () => this.password,
      getPlayerName: () => this.playerName,
      isHosting: () => this.isHosting,
      getHostController: () => this.hostController,
      updateSessionStatus: (status) => this._updateSessionStatus(status),
      onPairingApprovalRequest: this.callbacks.onPairingApprovalRequest,
    };
  }

  get clientController(): ClientSessionController | null {
    return this.clientJoinNegotiator.clientController;
  }

  get signalingHandler(): SignalingProtocolHandler | null {
    return (
      this.hostSignalingNegotiator.signalingHandler || this.clientJoinNegotiator.signalingHandler
    );
  }

  get localPeerId(): string | null {
    return this.signalingHandler?.peerId || null;
  }

  approvePendingPeer(peerId: string): boolean {
    return this.hostSignalingNegotiator.approvePendingPeer(peerId, (status) =>
      this._updateSessionStatus(status)
    );
  }

  declinePendingPeer(peerId: string): boolean {
    return this.hostSignalingNegotiator.declinePendingPeer(peerId, (status) =>
      this._updateSessionStatus(status)
    );
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
    this.hostSignalingNegotiator.pendingPairingRequests.clear();

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
          this.hostSignalingNegotiator.removePendingPeer(peerId, (status) =>
            this._updateSessionStatus(status)
          );
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
            void this.signalingHandler.sendCandidate(targetPeerId || null, cand);
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
    this.hostSignalingNegotiator.initHostSignaling(this.getHostSignalingCallbacks(), probedMask);
  }

  async reprobeAndRefreshHostSignaling(): Promise<void> {
    return this.hostSignalingNegotiator.reprobeAndRefresh(this.getHostSignalingCallbacks());
  }

  notifyMatchStarted(): void {
    this.hostSignalingNegotiator.notifyMatchStarted();
  }

  notifyReturnedToLobby(): void {
    this.hostSignalingNegotiator.notifyReturnedToLobby();
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
    this.hostSignalingNegotiator.cleanup();
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
    this.clientJoinNegotiator.cleanup();
    this.hostSignalingNegotiator.cleanup();
    if (this.callbacks.onLeaveServer) {
      await this.callbacks.onLeaveServer();
    }
  }
}

export default MultiplayerSessionManager;
