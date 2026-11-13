/**
 * src/network/transport/tunnel/TunnelDataBridge.ts
 * Bridges TunnelTransport (WebTransport/Rust UDP or WebTunnel) to per-peer channel
 * send/receive hooks, adding ReliableTunnelFramer when running over unreliable UDP.
 */

import { ReliableTunnelFramer } from './ReliableTunnelFramer.ts';
import type { TunnelPacketPayload, TunnelTransport } from './TunnelTransport.ts';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toUint8Array(payload: TunnelPacketPayload): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return textEncoder.encode(payload);
}

export interface TunnelDataBridgeOptions {
  tunnel: TunnelTransport;
  remotePeerId: string;
  onPayload: (payload: Uint8Array | string) => void;
}

export class TunnelDataBridge {
  private readonly tunnel: TunnelTransport;
  private readonly remotePeerId: string;
  private readonly onPayload: (payload: Uint8Array | string) => void;
  private readonly reliableFramer: ReliableTunnelFramer | null;
  private unsubPacket: (() => void) | null = null;
  private disposed = false;

  constructor(options: TunnelDataBridgeOptions) {
    this.tunnel = options.tunnel;
    this.remotePeerId = options.remotePeerId;
    this.onPayload = options.onPayload;

    if (this.tunnel.kind === 'rust-upnp-udp') {
      this.reliableFramer = new ReliableTunnelFramer({
        sendRaw: (frame) => this.tunnel.sendToPeer(this.remotePeerId, frame, true),
        onReliablePayload: (assembled) => this.emitDecodedPayload(assembled),
      });
    } else {
      this.reliableFramer = null;
    }

    this.unsubPacket = this.tunnel.onPacket((payload, fromPeerId) => {
      if (this.disposed) return;
      if (fromPeerId && fromPeerId !== this.remotePeerId) return;

      if (typeof payload === 'string') {
        this.onPayload(payload);
        return;
      }

      const bytes = toUint8Array(payload);
      if (this.reliableFramer && ReliableTunnelFramer.isReliableFrame(bytes)) {
        this.reliableFramer.handleIncomingFrame(bytes);
        return;
      }
      this.emitDecodedPayload(bytes);
    });
  }

  get isOpen(): boolean {
    return !this.disposed && this.tunnel.isOpen;
  }

  send(payload: TunnelPacketPayload, reliable = false): boolean {
    if (this.disposed || !this.tunnel.isOpen) return false;
    if (reliable && this.reliableFramer) {
      return this.reliableFramer.sendReliable(toUint8Array(payload));
    }
    return this.tunnel.sendToPeer(this.remotePeerId, payload, reliable);
  }

  private emitDecodedPayload(bytes: Uint8Array): void {
    // JSON control packets begin with '{' (0x7b)
    if (bytes.byteLength > 0 && bytes[0] === 0x7b) {
      this.onPayload(textDecoder.decode(bytes));
      return;
    }
    this.onPayload(bytes);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.unsubPacket) {
      this.unsubPacket();
      this.unsubPacket = null;
    }
    if (this.reliableFramer) {
      this.reliableFramer.dispose();
    }
  }
}
