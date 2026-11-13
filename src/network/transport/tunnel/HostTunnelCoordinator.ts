/**
 * src/network/transport/tunnel/HostTunnelCoordinator.ts
 * Shares a single RustTunnelTransport (1 UDP socket + 1 UPnP IGD port mapping)
 * across all connected player and spectator peers in a HostSessionController.
 */

import { RustTunnelTransport } from './RustTunnelTransport.ts';
import type { TunnelEndpointDescriptor } from './TunnelTransport.ts';
import { TunnelPeerBridge, type SharedHostTunnelPort } from './TunnelPeerBridge.ts';

export class HostTunnelCoordinator implements SharedHostTunnelPort {
  readonly sessionId: string;
  private readonly transport: RustTunnelTransport;
  private readonly bridges = new Map<string, TunnelPeerBridge>();
  private readonly addrToPeerId = new Map<string, string>();
  private openPromise: Promise<TunnelEndpointDescriptor> | null = null;
  private endpoint: TunnelEndpointDescriptor | null = null;
  private unlistenPacket: (() => void) | null = null;
  private unlistenReady: (() => void) | null = null;
  private closed = false;

  constructor(roomId: string) {
    this.sessionId = `rc_host_${roomId || 'room'}`;
    this.transport = new RustTunnelTransport(this.sessionId);
  }

  async ensureOpen(): Promise<TunnelEndpointDescriptor> {
    if (this.endpoint) return this.endpoint;
    if (this.openPromise) return this.openPromise;

    this.openPromise = (async () => {
      this.unlistenReady = this.transport.onPeerReady((peerId, fromAddr) => {
        const resolvedId = peerId || this.addrToPeerId.get(fromAddr);
        if (!resolvedId) return;
        this.bridges.get(resolvedId)?.handleHostRoutedReady();
      });

      this.unlistenPacket = this.transport.onPacket((payload, fromAddr, peerId) => {
        const resolvedId = peerId || (fromAddr ? this.addrToPeerId.get(fromAddr) : undefined);
        if (!resolvedId) return;
        const bridge = this.bridges.get(resolvedId);
        if (!bridge) return;
        if (payload instanceof Uint8Array) {
          bridge.handleHostRoutedDatagram(payload);
        } else if (payload instanceof ArrayBuffer) {
          bridge.handleHostRoutedDatagram(new Uint8Array(payload));
        }
      });

      this.endpoint = await this.transport.open({
        sessionId: this.sessionId,
        enableUpnp: true,
        role: 'host',
      });
      return this.endpoint;
    })();

    try {
      return await this.openPromise;
    } finally {
      this.openPromise = null;
    }
  }

  createPeerBridge(peerId: string): TunnelPeerBridge {
    return new TunnelPeerBridge({
      role: 'host',
      sessionId: this.sessionId,
      peerId,
      hostPort: this,
    });
  }

  registerBridge(peerId: string, bridge: TunnelPeerBridge): void {
    this.bridges.set(peerId, bridge);
  }

  unregisterBridge(peerId: string): void {
    this.bridges.delete(peerId);
    for (const [addr, id] of this.addrToPeerId) {
      if (id === peerId) this.addrToPeerId.delete(addr);
    }
  }

  async connectPeer(peerId: string, remoteEndpoint: TunnelEndpointDescriptor): Promise<void> {
    if (this.closed) return;
    await this.ensureOpen();
    if (remoteEndpoint.externalIp && remoteEndpoint.externalPort) {
      this.addrToPeerId.set(`${remoteEndpoint.externalIp}:${remoteEndpoint.externalPort}`, peerId);
    }
    if (remoteEndpoint.localIp && remoteEndpoint.localPort) {
      this.addrToPeerId.set(`${remoteEndpoint.localIp}:${remoteEndpoint.localPort}`, peerId);
    }
    await this.transport.connectPeer(peerId, remoteEndpoint);
  }

  async disconnectPeer(peerId: string): Promise<void> {
    this.unregisterBridge(peerId);
    await this.transport.disconnectPeer(peerId);
  }

  sendToPeer(peerId: string, datagram: Uint8Array): boolean {
    if (this.closed || !this.transport.isOpen) return false;
    return this.transport.sendToPeer(peerId, datagram);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unlistenPacket?.();
    this.unlistenPacket = null;
    this.unlistenReady?.();
    this.unlistenReady = null;
    for (const bridge of this.bridges.values()) {
      void bridge.close();
    }
    this.bridges.clear();
    this.addrToPeerId.clear();
    this.endpoint = null;
    await this.transport.close();
  }
}
