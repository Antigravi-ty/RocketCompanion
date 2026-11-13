/**
 * src/network/transport/tunnel/WebTunnelTransport.ts
 * Browser WebRTC DataChannel TunnelTransport adapter wrapping P2PWebRTCChannel.
 */

import {
  TUNNEL_ENVELOPE_FLAGS,
  encodeTunnelEnvelope,
  type TunnelPacketType,
} from '../../protocol/TunnelProtocol.ts';
import { P2PWebRTCChannel, type P2PWebRTCChannelOptions } from '../P2PWebRTCChannel.ts';
import type {
  TunnelEndpointDescriptor,
  TunnelLifecycleState,
  TunnelOpenOptions,
  TunnelPacketListener,
  TunnelPacketPayload,
  TunnelStateListener,
  TunnelStats,
  TunnelTransport,
} from './TunnelTransport.ts';

export interface WebTunnelTransportOptions extends P2PWebRTCChannelOptions {
  channel?: P2PWebRTCChannel;
  sessionId?: string;
}

export class WebTunnelTransport implements TunnelTransport {
  readonly kind = 'web-webrtc' as const;
  sessionId: string;
  state: TunnelLifecycleState = 'idle';

  private channel: P2PWebRTCChannel | null;
  private readonly ownsChannel: boolean;
  private readonly channelOptions: P2PWebRTCChannelOptions;
  private readonly packetListeners = new Set<TunnelPacketListener>();
  private readonly stateListeners = new Set<TunnelStateListener>();
  private bytesSent = 0;
  private bytesReceived = 0;
  private packetsSent = 0;
  private packetsReceived = 0;

  constructor(options: WebTunnelTransportOptions = {}) {
    this.sessionId =
      options.sessionId ||
      `web_tun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.channel = options.channel ?? null;
    this.ownsChannel = !options.channel;
    this.channelOptions = options;
    if (this.channel) {
      this.bindChannelHooks(this.channel);
      if (this.channel.connected) {
        this.state = 'open';
      }
    }
  }

  get isOpen(): boolean {
    return this.state === 'open' || Boolean(this.channel?.connected);
  }

  get underlyingChannel(): P2PWebRTCChannel | null {
    return this.channel;
  }

  private setState(next: TunnelLifecycleState, detail?: string): void {
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next, detail);
    }
  }

  private bindChannelHooks(ch: P2PWebRTCChannel): void {
    const prevConnected = ch.onConnected;
    ch.onConnected = () => {
      if (prevConnected) prevConnected();
      this.setState('open');
    };

    const prevDisconnected = ch.onDisconnected;
    ch.onDisconnected = () => {
      if (prevDisconnected) prevDisconnected();
      this.setState('closed');
    };

    const prevPacket = ch.onPacketReceived;
    ch.onPacketReceived = (payload) => {
      if (prevPacket) prevPacket(payload);
      const byteLen =
        payload instanceof Uint8Array || payload instanceof ArrayBuffer
          ? payload.byteLength
          : typeof payload === 'string'
            ? payload.length
            : 0;
      this.packetsReceived += 1;
      this.bytesReceived += byteLen;
      if (
        payload instanceof Uint8Array ||
        payload instanceof ArrayBuffer ||
        typeof payload === 'string'
      ) {
        for (const listener of this.packetListeners) {
          listener(payload);
        }
      }
    };
  }

  async open(options: TunnelOpenOptions = {}): Promise<TunnelEndpointDescriptor> {
    if (options.sessionId) {
      this.sessionId = options.sessionId;
    }
    this.setState('opening');

    if (!this.channel) {
      this.channel = new P2PWebRTCChannel({
        ...this.channelOptions,
        role: options.role ?? this.channelOptions.role ?? 'host',
        roomId: options.roomId ?? this.channelOptions.roomId ?? null,
        playerName: options.playerName ?? this.channelOptions.playerName ?? 'Player',
      });
      this.bindChannelHooks(this.channel);
    }

    let sdpToken = '';
    if (this.channel.role === 'host') {
      sdpToken = await this.channel.createOfferToken({
        roomId: options.roomId ?? this.channel.roomId ?? undefined,
      });
    }

    if (this.channel.connected) {
      this.setState('open');
    }

    return {
      kind: this.kind,
      sessionId: this.sessionId,
      localIp: null,
      localPort: null,
      externalIp: null,
      externalPort: null,
      upnpMapped: false,
      sdpToken,
    };
  }

  async connectToPeer(remoteEndpoint: TunnelEndpointDescriptor): Promise<void> {
    if (!this.channel) {
      throw new Error('WebTunnelTransport channel is not initialized; call open() first');
    }
    if (!remoteEndpoint.sdpToken) {
      return;
    }
    if (this.channel.role === 'host') {
      await this.channel.acceptAnswerToken(remoteEndpoint.sdpToken);
    } else {
      await this.channel.acceptOfferAndCreateAnswer(remoteEndpoint.sdpToken);
    }
  }

  send(payload: TunnelPacketPayload): boolean {
    if (!this.channel) return false;
    const sent = this.channel.send(payload);
    if (sent) {
      const byteLen =
        payload instanceof Uint8Array || payload instanceof ArrayBuffer
          ? payload.byteLength
          : payload.length;
      this.packetsSent += 1;
      this.bytesSent += byteLen;
    }
    return sent;
  }

  sendTyped(
    packetType: TunnelPacketType | number,
    payload: Uint8Array,
    flags: number = TUNNEL_ENVELOPE_FLAGS.NONE
  ): boolean {
    const envelope = encodeTunnelEnvelope(packetType, payload, flags);
    return this.send(envelope);
  }

  onPacket(listener: TunnelPacketListener): () => void {
    this.packetListeners.add(listener);
    return () => {
      this.packetListeners.delete(listener);
    };
  }

  onStateChange(listener: TunnelStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getStats(): TunnelStats {
    return {
      kind: this.kind,
      state: this.state,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      upnpMapped: false,
      peerAddr: this.channel?.peerName ?? null,
    };
  }

  async close(): Promise<void> {
    if (this.channel && this.ownsChannel) {
      this.channel.destroy();
      this.channel = null;
    }
    this.setState('closed');
  }
}
