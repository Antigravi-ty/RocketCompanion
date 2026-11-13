/**
 * src/network/transport/tunnel/TunnelPeerBridge.ts
 * Per-peer bridge connecting a P2PWebRTCChannel / DataChannelTransport to either
 * a shared HostTunnelCoordinator (Host) or a dedicated RustTunnelTransport (Client),
 * with TunnelReliabilityLayer framing on top.
 */

import { RustTunnelTransport } from './RustTunnelTransport.ts';
import { TunnelReliabilityLayer, type TunnelAppPayload } from './TunnelReliabilityLayer.ts';
import type { TunnelEndpointDescriptor } from './TunnelTransport.ts';

export interface SharedHostTunnelPort {
  ensureOpen: () => Promise<TunnelEndpointDescriptor>;
  connectPeer: (peerId: string, remoteEndpoint: TunnelEndpointDescriptor) => Promise<void>;
  disconnectPeer: (peerId: string) => Promise<void>;
  sendToPeer: (peerId: string, datagram: Uint8Array) => boolean;
  registerBridge: (peerId: string, bridge: TunnelPeerBridge) => void;
  unregisterBridge: (peerId: string) => void;
}

export interface TunnelPeerBridgeOptions {
  role: 'host' | 'client';
  sessionId: string;
  peerId?: string;
  hostPort?: SharedHostTunnelPort;
  onReady?: () => void;
  onPayload?: (payload: TunnelAppPayload) => void;
}

export class TunnelPeerBridge {
  readonly role: 'host' | 'client';
  readonly sessionId: string;
  readonly peerId: string;
  private readonly hostPort: SharedHostTunnelPort | null;
  private readonly clientTransport: RustTunnelTransport | null;
  private readonly reliability: TunnelReliabilityLayer;

  private ready = false;
  private closed = false;
  private localEndpoint: TunnelEndpointDescriptor | null = null;
  private unlistenClientPacket: (() => void) | null = null;
  private unlistenClientReady: (() => void) | null = null;

  onReady: (() => void) | null;
  onPayload: ((payload: TunnelAppPayload) => void) | null;

  constructor(options: TunnelPeerBridgeOptions) {
    this.role = options.role;
    this.sessionId = options.sessionId;
    this.peerId = options.peerId || `peer_${Math.random().toString(36).slice(2, 8)}`;
    this.hostPort = options.hostPort ?? null;
    this.onReady = options.onReady ?? null;
    this.onPayload = options.onPayload ?? null;

    this.clientTransport =
      this.role === 'client' && !this.hostPort ? new RustTunnelTransport(this.sessionId) : null;

    this.reliability = new TunnelReliabilityLayer(
      (datagram) => this.sendRawDatagram(datagram),
      (payload) => this.onPayload?.(payload)
    );

    if (this.hostPort) {
      this.hostPort.registerBridge(this.peerId, this);
    }
  }

  get isReady(): boolean {
    return this.ready && !this.closed;
  }

  private markReady(): void {
    if (this.ready || this.closed) return;
    this.ready = true;
    this.onReady?.();
  }

  private sendRawDatagram(datagram: Uint8Array): boolean {
    if (this.closed) return false;
    if (this.hostPort) {
      return this.hostPort.sendToPeer(this.peerId, datagram);
    }
    if (this.clientTransport?.isOpen) {
      return this.clientTransport.send(datagram);
    }
    return false;
  }

  async openEndpoint(): Promise<TunnelEndpointDescriptor> {
    if (this.localEndpoint) return this.localEndpoint;
    if (this.hostPort) {
      this.localEndpoint = await this.hostPort.ensureOpen();
      return this.localEndpoint;
    }
    if (!this.clientTransport) {
      throw new Error('TunnelPeerBridge has neither hostPort nor clientTransport');
    }

    this.unlistenClientReady = this.clientTransport.onPeerReady(() => {
      this.markReady();
    });
    this.unlistenClientPacket = this.clientTransport.onPacket((payload) => {
      this.markReady();
      if (payload instanceof Uint8Array) {
        this.reliability.handleInboundDatagram(payload);
      } else if (payload instanceof ArrayBuffer) {
        this.reliability.handleInboundDatagram(new Uint8Array(payload));
      }
    });

    this.localEndpoint = await this.clientTransport.open({
      sessionId: this.sessionId,
      enableUpnp: true,
      role: 'client',
    });
    return this.localEndpoint;
  }

  async connectRemoteEndpoint(remoteEndpoint: TunnelEndpointDescriptor): Promise<void> {
    if (this.closed) return;
    if (!this.localEndpoint) {
      await this.openEndpoint();
    }
    if (this.hostPort) {
      await this.hostPort.connectPeer(this.peerId, remoteEndpoint);
      return;
    }
    if (this.clientTransport) {
      await this.clientTransport.connectToPeer(remoteEndpoint);
    }
  }

  handleHostRoutedReady(): void {
    this.markReady();
  }

  handleHostRoutedDatagram(datagram: Uint8Array): void {
    this.markReady();
    this.reliability.handleInboundDatagram(datagram);
  }

  sendPayload(payload: TunnelAppPayload, reliable: boolean): boolean {
    if (!this.isReady) return false;
    return this.reliability.send(payload, reliable);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.reliability.close();

    if (this.hostPort) {
      this.hostPort.unregisterBridge(this.peerId);
      await this.hostPort.disconnectPeer(this.peerId);
    }

    this.unlistenClientPacket?.();
    this.unlistenClientPacket = null;
    this.unlistenClientReady?.();
    this.unlistenClientReady = null;

    if (this.clientTransport) {
      await this.clientTransport.close();
    }
  }
}
