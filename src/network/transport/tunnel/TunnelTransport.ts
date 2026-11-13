/**
 * src/network/transport/tunnel/TunnelTransport.ts
 * Abstract P2P Tunnel transport contract shared between Rust UPnP/UDP native
 * tunnels (Tauri desktop) and WebRTC DataChannel tunnels (browser fallback).
 */

import type { TunnelPacketType } from '../../protocol/TunnelProtocol.ts';

export type TunnelKind = 'rust-upnp-udp' | 'web-webrtc';
export type LocalBridgeMode = 'webtransport' | 'websocket' | 'webrtc';
export type TunnelLifecycleState = 'idle' | 'opening' | 'open' | 'closed' | 'error';
export type TunnelPacketPayload = Uint8Array | ArrayBuffer | string;

export type TunnelDiagnosticCode =
  | 'LOCAL_NETWORK_PERMISSION_DENIED'
  | 'WINDOWS_PUBLIC_NETWORK_FIREWALL_RISK'
  | 'WEBTRANSPORT_FALLBACK_TO_WEBSOCKET'
  | 'UPNP_MAPPING_FAILED';

export interface TunnelDiagnosticWarning {
  code: TunnelDiagnosticCode;
  message: string;
  detail?: string;
}

export interface UpnpProbeResult {
  available: boolean;
  gatewayAddr: string | null;
  localIp: string | null;
  externalIp: string | null;
  error: string | null;
  permissionDenied?: boolean;
  networkWarning?: string | null;
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
  permissionDenied?: boolean;
  networkWarning?: string | null;
  wtUrl?: string | null;
  wtCertHash?: number[] | null;
  wtError?: string | null;
  wsUrl?: string | null;
  authToken?: string | null;
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
  bridgeMode?: LocalBridgeMode;
  state: TunnelLifecycleState;
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
  upnpMapped: boolean;
  peerCount: number;
  peerAddr: string | null;
}

export type TunnelPacketListener = (payload: TunnelPacketPayload, fromPeerId?: string) => void;
export type TunnelStateListener = (state: TunnelLifecycleState, detail?: string) => void;
export type TunnelDiagnosticListener = (warning: TunnelDiagnosticWarning) => void;

export interface TunnelTransport {
  readonly kind: TunnelKind;
  readonly sessionId: string;
  readonly state: TunnelLifecycleState;
  readonly isOpen: boolean;

  open(options?: TunnelOpenOptions): Promise<TunnelEndpointDescriptor>;
  connectToPeer(remoteEndpoint: TunnelEndpointDescriptor): Promise<void>;
  connectPeer(peerId: string, remoteEndpoint: TunnelEndpointDescriptor): Promise<void>;
  disconnectPeer(peerId: string): Promise<void>;
  send(payload: TunnelPacketPayload): boolean;
  sendToPeer(peerId: string, payload: TunnelPacketPayload, reliable?: boolean): boolean;
  sendTyped(packetType: TunnelPacketType | number, payload: Uint8Array, flags?: number): boolean;
  sendTypedToPeer(
    peerId: string,
    packetType: TunnelPacketType | number,
    payload: Uint8Array,
    flags?: number
  ): boolean;
  broadcastTyped(
    packetType: TunnelPacketType | number,
    payload: Uint8Array,
    flags?: number,
    excludePeerId?: string
  ): number;
  onPacket(listener: TunnelPacketListener): () => void;
  onStateChange(listener: TunnelStateListener): () => void;
  onDiagnosticWarning(listener: TunnelDiagnosticListener): () => void;
  getStats(): TunnelStats;
  close(): Promise<void>;
}

