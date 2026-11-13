/**
 * src/network/transport/tunnel/TunnelTransport.ts
 * Abstract P2P Tunnel transport contract shared between Rust UPnP/UDP native
 * tunnels (Tauri desktop) and WebRTC DataChannel tunnels (browser fallback).
 */

import type { TunnelPacketType } from '../../protocol/TunnelProtocol.ts';

export type TunnelKind = 'rust-upnp-udp' | 'web-webrtc';
export type TunnelLifecycleState = 'idle' | 'opening' | 'open' | 'closed' | 'error';
export type TunnelPacketPayload = Uint8Array | ArrayBuffer | string;

export interface UpnpProbeResult {
  available: boolean;
  gatewayAddr: string | null;
  localIp: string | null;
  externalIp: string | null;
  error: string | null;
}

export interface TunnelEndpointDescriptor {
  kind: TunnelKind;
  sessionId: string;
  localIp: string | null;
  localPort: number | null;
  externalIp: string | null;
  externalPort: number | null;
  upnpMapped: boolean;
  upnpError?: string | null;
  sdpToken?: string;
}

export interface TunnelOpenOptions {
  sessionId?: string;
  preferredPort?: number;
  enableUpnp?: boolean;
  role?: 'host' | 'client';
  roomId?: string | null;
  playerName?: string;
}

export interface TunnelStats {
  kind: TunnelKind;
  state: TunnelLifecycleState;
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
  upnpMapped: boolean;
  peerAddr: string | null;
}

export type TunnelPacketListener = (
  payload: TunnelPacketPayload,
  fromAddr?: string,
  peerId?: string
) => void;
export type TunnelStateListener = (state: TunnelLifecycleState, detail?: string) => void;
export type TunnelPeerReadyListener = (peerId: string | undefined, fromAddr: string) => void;

export interface TunnelTransport {
  readonly kind: TunnelKind;
  readonly sessionId: string;
  readonly state: TunnelLifecycleState;
  readonly isOpen: boolean;

  open(options?: TunnelOpenOptions): Promise<TunnelEndpointDescriptor>;
  connectToPeer(remoteEndpoint: TunnelEndpointDescriptor): Promise<void>;
  connectPeer?(peerId: string, remoteEndpoint: TunnelEndpointDescriptor): Promise<void>;
  disconnectPeer?(peerId: string): Promise<void>;
  send(payload: TunnelPacketPayload): boolean;
  sendToPeer?(peerId: string, payload: TunnelPacketPayload): boolean;
  sendTyped(packetType: TunnelPacketType | number, payload: Uint8Array, flags?: number): boolean;
  onPacket(listener: TunnelPacketListener): () => void;
  onPeerReady?(listener: TunnelPeerReadyListener): () => void;
  onStateChange(listener: TunnelStateListener): () => void;
  getStats(): TunnelStats;
  close(): Promise<void>;
}
