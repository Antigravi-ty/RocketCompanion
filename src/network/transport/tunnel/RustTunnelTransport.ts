/**
 * src/network/transport/tunnel/RustTunnelTransport.ts
 * Native Tauri/Rust UPnP IGD + multi-peer UDP socket TunnelTransport implementation,
 * bridged to main thread or Web Worker via local WebTransport (with loud WebSocket fallback).
 */

import {
  TUNNEL_ENVELOPE_FLAGS,
  decodeBridgeFrame,
  encodeBridgeFrame,
  encodeTunnelEnvelope,
  type TunnelPacketType,
} from '../../protocol/TunnelProtocol.ts';
import { LocalBridgeClient } from './LocalBridgeClient.ts';
import type {
  LocalBridgeMode,
  TunnelDiagnosticListener,
  TunnelDiagnosticWarning,
  TunnelEndpointDescriptor,
  TunnelLifecycleState,
  TunnelOpenOptions,
  TunnelPacketListener,
  TunnelPacketPayload,
  TunnelStateListener,
  TunnelStats,
  TunnelTransport,
  UpnpProbeResult,
} from './TunnelTransport.ts';

interface TauriCoreApi {
  invoke?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

interface WindowWithTauriTunnel extends Window {
  __TAURI__?: {
    core?: TauriCoreApi;
  };
  __TAURI_INTERNALS__?: {
    invoke?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
}

interface RustTunnelEndpointResponse {
  sessionId: string;
  localIp: string;
  localPort: number;
  externalIp: string | null;
  externalPort: number | null;
  upnpMapped: boolean;
  upnpError: string | null;
  permissionDenied: boolean;
  networkWarning: string | null;
  wtUrl: string | null;
  wtCertHash: number[] | null;
  wtError: string | null;
  wsUrl: string;
  authToken: string;
}

interface RustTunnelStatusResponse {
  sessionId: string;
  open: boolean;
  localPort: number;
  externalIp: string | null;
  externalPort: number | null;
  upnpMapped: boolean;
  peerCount: number;
  peerAddr: string | null;
  bytesSent: number;
  bytesReceived: number;
}

function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Tauri runtime unavailable outside browser window'));
  }
  const win = window as WindowWithTauriTunnel;
  if (typeof win.__TAURI__?.core?.invoke === 'function') {
    return win.__TAURI__.core.invoke<T>(cmd, args);
  }
  if (typeof win.__TAURI_INTERNALS__?.invoke === 'function') {
    return win.__TAURI_INTERNALS__.invoke<T>(cmd, args);
  }
  return Promise.reject(new Error(`Tauri invoke unavailable for command: ${cmd}`));
}

export async function probeRustUpnpGateway(): Promise<UpnpProbeResult> {
  try {
    const res = await invokeTauri<UpnpProbeResult>('tauri_upnp_probe');
    if (res.permissionDenied) {
      console.error('[RustTunnelTransport] UPnP blocked by OS Local Network permission:', res.error);
    } else if (res.error) {
      console.warn('[RustTunnelTransport] UPnP probe warning:', res.error);
    }
    if (res.networkWarning) {
      console.warn('[RustTunnelTransport] Network warning:', res.networkWarning);
    }
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[RustTunnelTransport] UPnP probe invoke failed:', msg);
    return {
      available: false,
      gatewayAddr: null,
      localIp: null,
      externalIp: null,
      error: msg,
    };
  }
}

export class RustTunnelTransport implements TunnelTransport {
  readonly kind = 'rust-upnp-udp' as const;
  sessionId: string;
  state: TunnelLifecycleState = 'idle';

  private readonly packetListeners = new Set<TunnelPacketListener>();
  private readonly stateListeners = new Set<TunnelStateListener>();
  private readonly diagnosticListeners = new Set<TunnelDiagnosticListener>();
  private readonly connectedPeers = new Map<string, string>();
  private bridge: LocalBridgeClient | null = null;
  private bridgeMode: LocalBridgeMode = 'webtransport';
  private endpoint: TunnelEndpointDescriptor | null = null;
  private peerAddr: string | null = null;
  private bytesSent = 0;
  private bytesReceived = 0;
  private packetsSent = 0;
  private packetsReceived = 0;
  private readonly textEncoder = new TextEncoder();

  constructor(sessionId?: string) {
    this.sessionId =
      sessionId || `rc_tun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  private setState(next: TunnelLifecycleState, detail?: string): void {
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next, detail);
    }
  }

  private emitWarning(warning: TunnelDiagnosticWarning): void {
    console.warn(`[RustTunnelTransport:${warning.code}] ${warning.message}`, warning.detail ?? '');
    for (const listener of this.diagnosticListeners) {
      listener(warning);
    }
  }

  async open(options: TunnelOpenOptions = {}): Promise<TunnelEndpointDescriptor> {
    if (options.sessionId) {
      this.sessionId = options.sessionId;
    }
    this.setState('opening');

    try {
      const res = await invokeTauri<RustTunnelEndpointResponse>('tauri_tunnel_open', {
        sessionId: this.sessionId,
        preferredPort: options.preferredPort ?? null,
        enableUpnp: options.enableUpnp ?? true,
      });

      const descriptor: TunnelEndpointDescriptor = {
        kind: this.kind,
        sessionId: res.sessionId,
        localIp: res.localIp,
        localPort: res.localPort,
        externalIp: res.externalIp,
        externalPort: res.externalPort,
        upnpMapped: res.upnpMapped,
        upnpError: res.upnpError,
        permissionDenied: res.permissionDenied,
        networkWarning: res.networkWarning,
        wtUrl: res.wtUrl,
        wtCertHash: res.wtCertHash,
        wtError: res.wtError,
        wsUrl: res.wsUrl,
        authToken: res.authToken,
      };

      this.emitEndpointWarnings(descriptor);
      await this.attachLocalBridge(descriptor);
      this.endpoint = descriptor;
      this.setState('open');
      return descriptor;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[RustTunnelTransport] open() failed:', msg);
      this.setState('error', msg);
      throw err;
    }
  }

  async attachToOpenedEndpoint(descriptor: TunnelEndpointDescriptor): Promise<void> {
    this.sessionId = descriptor.sessionId;
    this.endpoint = descriptor;
    this.setState('opening');
    try {
      await this.attachLocalBridge(descriptor);
      this.setState('open');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState('error', msg);
      throw err;
    }
  }

  private emitEndpointWarnings(descriptor: TunnelEndpointDescriptor): void {
    if (descriptor.permissionDenied) {
      this.emitWarning({
        code: 'LOCAL_NETWORK_PERMISSION_DENIED',
        message: 'Local Network permission denied; UPnP discovery blocked by OS.',
        detail: descriptor.upnpError ?? undefined,
      });
    } else if (descriptor.upnpError) {
      this.emitWarning({
        code: 'UPNP_MAPPING_FAILED',
        message: 'UPnP port mapping failed; falling back to UDP hole-punching.',
        detail: descriptor.upnpError,
      });
    }
    if (descriptor.networkWarning) {
      this.emitWarning({
        code: 'WINDOWS_PUBLIC_NETWORK_FIREWALL_RISK',
        message: 'Public network firewall profile detected; P2P UDP may be restricted.',
        detail: descriptor.networkWarning,
      });
    }
  }

  private async attachLocalBridge(descriptor: TunnelEndpointDescriptor): Promise<void> {
    if (this.bridge) {
      this.bridge.close();
      this.bridge = null;
    }
    if (!descriptor.wsUrl) {
      throw new Error('Missing local bridge wsUrl in TunnelEndpointDescriptor');
    }
    const client = new LocalBridgeClient({
      wtUrl: descriptor.wtUrl,
      wtCertHash: descriptor.wtCertHash,
      wtError: descriptor.wtError,
      wsUrl: descriptor.wsUrl,
      onFrame: (frame) => this.handleBridgeFrame(frame),
      onWarning: (warning) => this.emitWarning(warning),
      onClose: (reason) => {
        if (this.state === 'open') {
          this.setState('error', `Local bridge closed: ${reason}`);
        }
      },
    });
    this.bridgeMode = await client.connect();
    this.bridge = client;
  }

  private handleBridgeFrame(frame: Uint8Array): void {
    const decoded = decodeBridgeFrame(frame);
    if (!decoded) return;
    this.packetsReceived += 1;
    this.bytesReceived += decoded.payload.byteLength;
    for (const listener of this.packetListeners) {
      listener(decoded.payload, decoded.peerId);
    }
  }

  async connectToPeer(remoteEndpoint: TunnelEndpointDescriptor): Promise<void> {
    await this.connectPeer('default', remoteEndpoint);
  }

  async connectPeer(peerId: string, remoteEndpoint: TunnelEndpointDescriptor): Promise<void> {
    const ip = remoteEndpoint.externalIp || remoteEndpoint.localIp;
    const port = remoteEndpoint.externalPort ?? remoteEndpoint.localPort;
    if (!ip || !port) {
      throw new Error(`Remote endpoint for peer '${peerId}' is missing IP or port`);
    }
    const target = `${ip}:${port}`;
    this.connectedPeers.set(peerId, target);
    if (!this.peerAddr || peerId === 'default') {
      this.peerAddr = target;
    }
    await invokeTauri<void>('tauri_tunnel_connect_peer', {
      sessionId: this.sessionId,
      peerId,
      peerAddr: target,
    });
  }

  async disconnectPeer(peerId: string): Promise<void> {
    this.connectedPeers.delete(peerId);
    await invokeTauri<void>('tauri_tunnel_disconnect_peer', {
      sessionId: this.sessionId,
      peerId,
    });
  }

  private toBytes(payload: TunnelPacketPayload): Uint8Array {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    return this.textEncoder.encode(payload);
  }

  send(payload: TunnelPacketPayload): boolean {
    return this.sendToPeer('default', payload, false);
  }

  sendToPeer(peerId: string, payload: TunnelPacketPayload, reliable: boolean = false): boolean {
    if (!this.isOpen || !this.bridge) return false;
    const bytes = this.toBytes(payload);
    const frame = encodeBridgeFrame(peerId, bytes);
    const ok = this.bridge.sendFrame(frame, reliable);
    if (ok) {
      this.packetsSent += 1;
      this.bytesSent += bytes.byteLength;
    }
    return ok;
  }

  sendTyped(
    packetType: TunnelPacketType | number,
    payload: Uint8Array,
    flags: number = TUNNEL_ENVELOPE_FLAGS.NONE
  ): boolean {
    return this.sendTypedToPeer('default', packetType, payload, flags);
  }

  sendTypedToPeer(
    peerId: string,
    packetType: TunnelPacketType | number,
    payload: Uint8Array,
    flags: number = TUNNEL_ENVELOPE_FLAGS.NONE
  ): boolean {
    const resolvedFlags = this.endpoint?.upnpMapped
      ? flags | TUNNEL_ENVELOPE_FLAGS.UPNP_ASSISTED
      : flags;
    const envelope = encodeTunnelEnvelope(packetType, payload, resolvedFlags);
    const reliable = (resolvedFlags & TUNNEL_ENVELOPE_FLAGS.RELIABLE) !== 0;
    return this.sendToPeer(peerId, envelope, reliable);
  }

  broadcastTyped(
    packetType: TunnelPacketType | number,
    payload: Uint8Array,
    flags: number = TUNNEL_ENVELOPE_FLAGS.NONE,
    excludePeerId?: string
  ): number {
    if (!this.isOpen || !this.bridge) return 0;
    const resolvedFlags = this.endpoint?.upnpMapped
      ? flags | TUNNEL_ENVELOPE_FLAGS.UPNP_ASSISTED
      : flags;
    const envelope = encodeTunnelEnvelope(packetType, payload, resolvedFlags);
    const reliable = (resolvedFlags & TUNNEL_ENVELOPE_FLAGS.RELIABLE) !== 0;

    if (!excludePeerId) {
      const ok = this.bridge.sendFrame(encodeBridgeFrame('*', envelope), reliable);
      if (ok) {
        const count = this.connectedPeers.size;
        this.packetsSent += count;
        this.bytesSent += envelope.byteLength * count;
        return count;
      }
      return 0;
    }

    let sentCount = 0;
    for (const peerId of this.connectedPeers.keys()) {
      if (peerId === excludePeerId) continue;
      if (this.sendToPeer(peerId, envelope, reliable)) {
        sentCount += 1;
      }
    }
    return sentCount;
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

  onDiagnosticWarning(listener: TunnelDiagnosticListener): () => void {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  async fetchNativeStatus(): Promise<RustTunnelStatusResponse | null> {
    try {
      return await invokeTauri<RustTunnelStatusResponse>('tauri_tunnel_get_status', {
        sessionId: this.sessionId,
      });
    } catch {
      return null;
    }
  }

  getStats(): TunnelStats {
    return {
      kind: this.kind,
      bridgeMode: this.bridgeMode,
      state: this.state,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      upnpMapped: Boolean(this.endpoint?.upnpMapped),
      peerCount: this.connectedPeers.size,
      peerAddr: this.peerAddr,
    };
  }

  async close(): Promise<void> {
    if (this.bridge) {
      this.bridge.close();
      this.bridge = null;
    }
    this.connectedPeers.clear();
    try {
      await invokeTauri<void>('tauri_tunnel_close', { sessionId: this.sessionId });
    } catch {
      // Ignore close errors when already torn down
    }
    this.setState('closed');
  }
}
