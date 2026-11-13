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
  type HostSignalingNegotiationContext,
  type PendingPairingRequest,
} from './HostSignalingNegotiationSubController.ts';
import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';
import { saveActiveHostOffer, clearActiveHostOffer } from './signalingRelayConfig.ts';
import {
  generateRandomRoomCode,
  parseRoomCode,
} from '../../ui-core/config/roomCodeConnectivityCodec.ts';
import { NETWORK_PROTOCOL_VERSION_TAG } from '../protocol/TunnelProtocol.ts';
import {
  createTunnelTransport,
  isRustTunnelAvailable,
  probeRustUpnp,
} from './tunnel/TunnelFactory.ts';
import type {
  TunnelEndpointDescriptor,
  TunnelKind,
  TunnelStats,
  TunnelTransport,
  UpnpProbeResult,
} from './tunnel/TunnelTransport.ts';

const DEFAULT_HOST_COLOR = Object.freeze({ slot: 3, hex: '#42a5f5' });
const DEFAULT_CLIENT_COLOR = Object.freeze({ slot: 0, hex: '#ff7043' });

export interface SessionColorSelection {
  slot: number;
  hex: string;
}

export interface MultiplayerSessionCallbacks {
  onSessionStatusChange?: (status: Record<string, unknown>) => void;
  onHostServer?: (config: Record<string, unknown>) => Promise<void> | void;
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
  sessionTunnel: TunnelTransport | null = null;
  localTunnelDescriptor: TunnelEndpointDescriptor | null = null;

  constructor(callbacks: MultiplayerSessionCallbacks = {}) {
    this.callbacks = callbacks;
    const nameResolver = callbacks.resolvePlayerName;
    const resolvedName = typeof nameResolver === 'function' ? nameResolver().trim() : '';
    this.playerName = resolvedName
      ? resolvedName.substring(0, 16)
      : `Player${Math.floor(1000 + Math.random() * 9000)}`;

    const hostColor = this.resolvePreferredColor(0, DEFAULT_HOST_COLOR);
    this.hostColorSlot = hostColor.slot;
    this.hostColorHex = hostColor.hex;

    const clientColor = this.resolveClientColorSelection();
    this.clientColorSlot = clientColor.slot;
    this.clientColorHex = clientColor.hex;
  }

  private readonly updateSessionStatus = (status: Record<string, unknown>): void => {
    const fn = this.callbacks.onSessionStatusChange;
    if (typeof fn === 'function') {
      try {
        fn(status);
      } catch (err) {
        console.warn('[MultiplayerSessionManager] Error in onSessionStatusChange callback:', err);
      }
    }
  };

  private resolvePreferredColor(
    assignedTeam: number | null,
    fallback: SessionColorSelection
  ): SessionColorSelection {
    const resolver = this.callbacks.resolveTeamColor;
    const custom = typeof resolver === 'function' ? resolver(assignedTeam) : null;
    return custom && typeof custom.slot === 'number' && custom.slot >= 0 && custom.hex
      ? custom
      : fallback;
  }

  private resolveClientColorSelection(): SessionColorSelection {
    const fallbackSlot = this.hostColorSlot === 0 ? 3 : 0;
    const fallbackHex = fallbackSlot === 3 ? DEFAULT_HOST_COLOR.hex : DEFAULT_CLIENT_COLOR.hex;
    return this.resolvePreferredColor(null, { slot: fallbackSlot, hex: fallbackHex });
  }

  private buildHostSignalingContext(): HostSignalingNegotiationContext {
    return {
      roomId: this.roomId,
      password: this.password,
      playerName: this.playerName,
      hostController: this.hostController,
      isHosting: () => this.isHosting,
      setRoomId: (roomId) => {
        this.roomId = roomId;
      },
      updateSessionStatus: this.updateSessionStatus,
      deliverPairingApprovalRequest: this.callbacks.onPairingApprovalRequest,
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
    const handler = this.signalingHandler;
    return handler ? handler.peerId : null;
  }

  approvePendingPeer(peerId: string): boolean {
    if (!this.isHosting) return false;
    return this.hostSignalingNegotiator.approvePendingPeer(peerId, this.updateSessionStatus);
  }

  declinePendingPeer(peerId: string): boolean {
    if (!this.isHosting) return false;
    return this.hostSignalingNegotiator.declinePendingPeer(peerId, this.updateSessionStatus);
  }

  private bindChannelTunnelExchange(channel: P2PWebRTCChannel, remotePeerId: string): void {
    channel.onTunnelEndpointAdvertise = (msg) => {
      const descriptor = msg.descriptor as TunnelEndpointDescriptor | undefined;
      if (!descriptor || descriptor.kind !== 'rust-upnp-udp') return;
      if (!this.sessionTunnel || !this.sessionTunnel.isOpen) return;
      const targetPeerId =
        typeof msg.peerId === 'string' && msg.peerId ? msg.peerId : remotePeerId;
      void this.sessionTunnel
        .connectPeer(targetPeerId, descriptor)
        .then(() => {
          if (this.sessionTunnel?.isOpen) {
            channel.attachTunnelTransport(this.sessionTunnel, targetPeerId);
          }
        })
        .catch((err) => {
          console.warn(
            `[MultiplayerSessionManager] Failed to connect Rust UDP tunnel to ${targetPeerId}:`,
            err
          );
        });
    };

    if (this.localTunnelDescriptor && this.sessionTunnel?.isOpen) {
      channel.sendReliableControl(
        {
          type: 'tunnel_endpoint_advertise',
          peerId: this.localPeerId || (this.isHosting ? 'host' : 'client'),
          descriptor: this.localTunnelDescriptor,
        },
        'tunnel_endpoint_advertise'
      );
    }
  }

  private async openSessionTunnelIfTauri(role: 'host' | 'client', roomId: string): Promise<void> {
    if (!isRustTunnelAvailable()) return;
    await this.closeSessionTunnel();
    const tunnel = this.createSessionTunnel(`rc_${role}_${roomId}_${Date.now().toString(36)}`);
    try {
      const descriptor = await tunnel.open({
        role,
        roomId,
        playerName: this.playerName,
        enableUpnp: true,
      });
      tunnel.onPacket((payload, fromPeerId) => {
        if (this.isHosting && this.hostController) {
          const peerCh = fromPeerId ? this.hostController.peerChannels.get(fromPeerId) : null;
          if (peerCh) {
            peerCh.transport.handleIncomingMessage(payload);
            return;
          }
          for (const ch of this.hostController.peerChannels.values()) {
            ch.transport.handleIncomingMessage(payload);
            break;
          }
        } else if (this.clientController?.channel) {
          this.clientController.channel.transport.handleIncomingMessage(payload);
        }
      });
      this.sessionTunnel = tunnel;
      this.localTunnelDescriptor = descriptor;
    } catch (err) {
      console.warn('[MultiplayerSessionManager] Failed to open Rust session tunnel:', err);
      await tunnel.close().catch(() => undefined);
    }
  }

  private async closeSessionTunnel(): Promise<void> {
    if (this.sessionTunnel) {
      const t = this.sessionTunnel;
      this.sessionTunnel = null;
      this.localTunnelDescriptor = null;
      await t.close().catch(() => undefined);
    }
  }

  private handleHostPeerConnected = async (
    channel: P2PWebRTCChannel,
    peerName: string,
    peerId: string,
    role: string
  ): Promise<number | void> => {
    this.bindChannelTunnelExchange(channel, peerId);
    channel.onPeerLeave = () => {
      console.info(`[MultiplayerSessionManager] Peer ${peerId} (${peerName}) left gracefully.`);
      channel.destroy();
      this.hostController?.peerChannels.delete(peerId);
      this.handleHostPeerDisconnected(peerId, channel);
    };
    let assignedCarIdx: number | void = undefined;
    if (this.callbacks.onPeerConnected) {
      assignedCarIdx = await this.callbacks.onPeerConnected(channel, peerName, peerId, role);
      if (typeof assignedCarIdx === 'number' && assignedCarIdx >= 0) {
        channel.carIndex = assignedCarIdx;
      }
    }
    const handler = this.signalingHandler;
    const pairingCode =
      channel.pairingCode || (handler ? handler.getPairingCodeForPeer(peerId) : null) || undefined;
    const peerList = this.hostController
      ? this.hostController.getConnectedPeerList()
      : [
          {
            id: peerId || channel.peerId || 'peer-1',
            name: peerName,
            carIndex: assignedCarIdx,
            pingMs: 0,
            pairingCode,
          },
        ];
    this.updateSessionStatus({ connectedPeers: peerList });
    return assignedCarIdx;
  };

  private handleHostPeerDisconnected = (peerId: string, channel: P2PWebRTCChannel): void => {
    channel.detachTunnelTransport();
    if (this.sessionTunnel?.isOpen) {
      void this.sessionTunnel.disconnectPeer(peerId).catch(() => undefined);
    }
    this.hostSignalingNegotiator.removePendingPeer(peerId, this.updateSessionStatus);
    if (
      typeof channel.carIndex === 'number' &&
      channel.carIndex > 0 &&
      this.callbacks.onRemovePlayer
    ) {
      this.callbacks.onRemovePlayer(channel.carIndex);
    }
    this.updateSessionStatus({
      connectedPeers: this.hostController ? this.hostController.getConnectedPeerList() : [],
    });
  };

  async startHosting(
    roomId: string | null = null,
    password = '',
    roomConfig: Record<string, unknown> = {}
  ): Promise<string> {
    if (this.clientController || this.signalingHandler) await this.leaveSession();
    if (this.hostController) await this.stopHosting();

    const parsedHostRoom = roomId ? parseRoomCode(roomId) : null;
    this.roomId = parsedHostRoom ? parsedHostRoom.canonicalRoomCode : generateRandomRoomCode(0x0f);
    this.password = String(password || '').trim();
    this.isHosting = true;
    this.hostSignalingNegotiator.pendingPairingRequests.clear();

    const hostColor = this.resolvePreferredColor(0, DEFAULT_HOST_COLOR);
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
    if (this.callbacks.onColorSelect) {
      this.callbacks.onColorSelect(0, this.hostColorSlot, this.hostColorHex);
    }

    this.hostController = new HostSessionController(
      {
        roomId: this.roomId,
        playerName: this.playerName,
        colorSlot: this.hostColorSlot,
        colorHex: this.hostColorHex,
      },
      {
        onPeerConnected: this.handleHostPeerConnected,
        onPeerDisconnected: this.handleHostPeerDisconnected,
        onColorChange: (carIdx, slotId, hex) => {
          if (this.callbacks.onColorSelect) this.callbacks.onColorSelect(carIdx, slotId, hex);
        },
        onIceCandidate: (cand, targetPeerId) => {
          const handler = this.signalingHandler;
          if (handler) void handler.sendCandidate(targetPeerId || null, cand);
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

    this.hostSignalingNegotiator.initHostSignaling(this.buildHostSignalingContext());
    void this.openSessionTunnelIfTauri('host', this.roomId);
    return offerToken;
  }

  async reprobeAndRefreshHostSignaling(): Promise<void> {
    if (!this.isHosting) return;
    await this.hostSignalingNegotiator.reprobeAndRefresh(this.buildHostSignalingContext());
  }

  notifyMatchStarted(): void {
    if (!this.isHosting) return;
    this.hostSignalingNegotiator.notifyMatchStarted();
  }

  notifyReturnedToLobby(): void {
    if (!this.isHosting) return;
    this.hostSignalingNegotiator.notifyReturnedToLobby();
  }

  async joinRoom(roomId: string, password = '', timeoutMs = 10000): Promise<boolean> {
    const parsedJoinRoom = parseRoomCode(roomId);
    const cleanRoomId = parsedJoinRoom
      ? parsedJoinRoom.canonicalRoomCode
      : (roomId || '').trim().toLowerCase();
    if (!cleanRoomId) {
      throw new Error('[MultiplayerSessionManager] Room ID is required to join');
    }

    if (this.clientController || this.signalingHandler) await this.leaveSession();
    if (this.hostController) await this.stopHosting();

    this.joinRoomId = cleanRoomId;
    this.joinPassword = String(password || '').trim();
    const clientColor = this.resolveClientColorSelection();
    this.clientColorSlot = clientColor.slot;
    this.clientColorHex = clientColor.hex;

    await this.openSessionTunnelIfTauri('client', cleanRoomId);

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
        updateSessionStatus: this.updateSessionStatus,
        joinServer: async (cfg) => {
          this.bindChannelTunnelExchange(cfg.channel, 'host');
          cfg.channel.onPeerKick = (msg) => {
            console.warn('[MultiplayerSessionManager] Kicked from room by host:', msg);
            this.updateSessionStatus({
              connected: false,
              kickedReason: typeof msg.reason === 'string' ? msg.reason : 'kicked_by_host',
            });
            void this.leaveSession().then(() => {
              this.callbacks.onUnexpectedDisconnect?.();
            });
          };
          if (this.callbacks.onJoinServer) {
            await this.callbacks.onJoinServer(cfg);
          }
        },
        abortJoin: () => {
          void this.leaveSession();
        },
        notifyUnexpectedDisconnect: this.callbacks.onUnexpectedDisconnect,
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
    await this.closeSessionTunnel();
    clearActiveHostOffer();
    if (this.callbacks.onStopServer) await this.callbacks.onStopServer();
  }

  async leaveSession(): Promise<void> {
    const activeChannel = this.clientController?.channel;
    if (activeChannel) {
      activeChannel.sendReliableControl(
        {
          type: 'peer_leave',
          peerId: this.localPeerId || 'client',
          carIndex: activeChannel.carIndex,
          reason: 'user_leave',
        },
        'peer_leave'
      );
      activeChannel.detachTunnelTransport();
    }
    this.clientJoinNegotiator.cleanup();
    this.hostSignalingNegotiator.cleanup();
    await this.closeSessionTunnel();
    if (this.callbacks.onLeaveServer) await this.callbacks.onLeaveServer();
  }

  getProtocolVersion(): string {
    return NETWORK_PROTOCOL_VERSION_TAG;
  }

  getPreferredTunnelKind(): TunnelKind {
    return isRustTunnelAvailable() ? 'rust-upnp-udp' : 'web-webrtc';
  }

  getActiveTunnelStats(): TunnelStats | null {
    return this.sessionTunnel ? this.sessionTunnel.getStats() : null;
  }

  probeLocalUpnp(): Promise<UpnpProbeResult> {
    return probeRustUpnp();
  }

  createSessionTunnel(sessionId?: string, webChannel?: P2PWebRTCChannel): TunnelTransport {
    return createTunnelTransport({ sessionId, webChannel });
  }
}
