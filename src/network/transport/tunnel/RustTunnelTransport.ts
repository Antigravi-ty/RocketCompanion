/**
 * src/network/transport/tunnel/RustTunnelTransport.ts
 * Native Tauri/Rust UPnP IGD + UDP socket TunnelTransport implementation.
 */

import {
  TUNNEL_ENVELOPE_FLAGS,
  encodeTunnelEnvelope,
  type TunnelPacketType,
} from '../../protocol/TunnelProtocol.ts';
import type {
  TunnelEndpointDescriptor,
  TunnelLifecycleState,
  TunnelOpenOptions,
  TunnelPacketListener,
  TunnelPacketPayload,
  TunnelPeerReadyListener,
  TunnelStateListener,
  TunnelStats,
  TunnelTransport,
  UpnpProbeResult,
} from './TunnelTransport.ts';

interface TauriChannelInstance<T = unknown> {
  onmessage: (response: T) => void;
}

interface TauriCoreApi {
  invoke?: <T = unknown>(
    cmd: string,
    args?: Record<string, unknown> | Uint8Array | ArrayBuffer,
    options?: { headers?: Record<string, string> }
  ) => Promise<T>;
  Channel?: new <T = unknown>() => TauriChannelInstance<T>;
}

interface TauriEventApi {
  listen?: <T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void
  ) => Promise<() => void>;
}

interface WindowWithTauriTunnel extends Window {
  __TAURI__?: {
    core?: TauriCoreApi;
    event?: TauriEventApi;
  };
  __TAURI_INTERNALS__?: {
    invoke?: <T = unknown>(
      cmd: string,
      args?: Record<string, unknown> | Uint8Array | ArrayBuffer,
      options?: { headers?: Record<string, string> }
    ) => Promise<T>;
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
}

interface RustTunnelStatusResponse {
  sessionId: string;
  open: boolean;
  localPort: number;
  externalIp: string | null;
  externalPort: number | null;
  upnpMapped: boolean;
  peerAddr: string | null;
  peerCount?: number;
  bytesSent: number;
  bytesReceived: number;
}

interface RustTunnelPacketEvent {
  sessionId: string;
  peerId?: string | null;
  fromAddr: string;
  data: number[];
}

interface RustTunnelPeerReadyEvent {
  sessionId: string;
  peerId?: string | null;
  fromAddr: string;
}

function getInvokeFn(): TauriCoreApi['invoke'] | null {
  if (typeof window === 'undefined') return null;
  const win = window as WindowWithTauriTunnel;
  if (typeof win.__TAURI__?.core?.invoke === 'function') {
    return win.__TAURI__.core.invoke.bind(win.__TAURI__.core);
  }
  if (typeof win.__TAURI_INTERNALS__?.invoke === 'function') {
    return win.__TAURI_INTERNALS__.invoke.bind(win.__TAURI_INTERNALS__);
  }
  return null;
}

function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array | ArrayBuffer,
  options?: { headers?: Record<string, string> }
): Promise<T> {
  const fn = getInvokeFn();
  if (!fn) {
    return Promise.reject(new Error(`Tauri invoke unavailable for command: ${cmd}`));
  }
  return fn<T>(cmd, args, options);
}

async function listenTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (typeof window === 'undefined') return () => {};
  const win = window as WindowWithTauriTunnel;
  if (typeof win.__TAURI__?.event?.listen === 'function') {
    return win.__TAURI__.event.listen<T>(eventName, (ev) => handler(ev.payload));
  }
  return () => {};
}

export async function probeRustUpnpGateway(): Promise<UpnpProbeResult> {
  try {
    return await invokeTauri<UpnpProbeResult>('tauri_upnp_probe');
  } catch (err) {
    return {
      available: false,
      gatewayAddr: null,
      localIp: null,
      externalIp: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export class RustTunnelTransport implements TunnelTransport {
  readonly kind = 'rust-upnp-udp' as const;
  sessionId: string;
  state: TunnelLifecycleState = 'idle';

  private readonly packetListeners = new Set<TunnelPacketListener>();
  private readonly peerReadyListeners = new Set<TunnelPeerReadyListener>();
  private readonly stateListeners = new Set<TunnelStateListener>();
  private unlistenPacketEvent: (() => void) | null = null;
  private unlistenPeerReadyEvent: (() => void) | null = null;
  private rxBinaryChannelActive = false;
  private rawSendSupported = true;
  private endpoint: TunnelEndpointDescriptor | null = null;
  private peerAddr: string | null = null;
  private bytesSent = 0;
  private bytesReceived = 0;
  private packetsSent = 0;
  private packetsReceived = 0;
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();

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

  private dispatchInboundPacket(bytes: Uint8Array, fromAddr: string, peerId?: string): void {
    this.packetsReceived += 1;
    this.bytesReceived += bytes.byteLength;
    for (const listener of this.packetListeners) {
      listener(bytes, fromAddr, peerId);
    }
  }

  private handleBinaryChannelFrame(raw: ArrayBuffer | Uint8Array): void {
    const view = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (view.byteLength < 2) return;
    const pidLen = view[0];
    const addrLen = view[1];
    const headerEnd = 2 + pidLen + addrLen;
    if (view.byteLength < headerEnd) return;
    const peerId = pidLen > 0 ? this.textDecoder.decode(view.subarray(2, 2 + pidLen)) : undefined;
    const fromAddr =
      addrLen > 0 ? this.textDecoder.decode(view.subarray(2 + pidLen, headerEnd)) : '';
    const payload = view.subarray(headerEnd);
    this.dispatchInboundPacket(payload, fromAddr, peerId);
  }

  async open(options: TunnelOpenOptions = {}): Promise<TunnelEndpointDescriptor> {
    if (options.sessionId) {
      this.sessionId = options.sessionId;
    }
    this.setState('opening');

    try {
      this.unlistenPacketEvent?.();
      this.unlistenPacketEvent = null;
      this.unlistenPeerReadyEvent?.();
      this.unlistenPeerReadyEvent = null;
      this.rxBinaryChannelActive = false;

      this.unlistenPeerReadyEvent = await listenTauriEvent<RustTunnelPeerReadyEvent>(
        'rc-tunnel-peer-ready',
        (ev) => {
          if (!ev || ev.sessionId !== this.sessionId) return;
          for (const listener of this.peerReadyListeners) {
            listener(ev.peerId ?? undefined, ev.fromAddr);
          }
        }
      );

      this.unlistenPacketEvent = await listenTauriEvent<RustTunnelPacketEvent>(
        'rc-tunnel-packet',
        (ev) => {
          if (!ev || ev.sessionId !== this.sessionId || this.rxBinaryChannelActive) return;
          const bytes = new Uint8Array(ev.data);
          this.dispatchInboundPacket(bytes, ev.fromAddr, ev.peerId ?? undefined);
        }
      );

      const res = await invokeTauri<RustTunnelEndpointResponse>('tauri_tunnel_open', {
        sessionId: this.sessionId,
        preferredPort: options.preferredPort ?? null,
        enableUpnp: options.enableUpnp ?? true,
      });

      const win = typeof window !== 'undefined' ? (window as WindowWithTauriTunnel) : null;
      const ChannelCtor = win?.__TAURI__?.core?.Channel;
      if (typeof ChannelCtor === 'function') {
        try {
          const ch = new ChannelCtor<ArrayBuffer | Uint8Array>();
          ch.onmessage = (frame) => {
            if (frame instanceof ArrayBuffer || frame instanceof Uint8Array) {
              this.handleBinaryChannelFrame(frame);
            }
          };
          await invokeTauri<void>('tauri_tunnel_attach_rx_channel', {
            sessionId: this.sessionId,
            onPacket: ch,
          });
          this.rxBinaryChannelActive = true;
        } catch {
          this.rxBinaryChannelActive = false;
        }
      }

      this.endpoint = {
        kind: this.kind,
        sessionId: res.sessionId,
        localIp: res.localIp,
        localPort: res.localPort,
        externalIp: res.externalIp,
        externalPort: res.externalPort,
        upnpMapped: res.upnpMapped,
        upnpError: res.upnpError,
      };
      this.setState('open');
      return this.endpoint;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState('error', msg);
      throw err;
    }
  }

  async connectToPeer(remoteEndpoint: TunnelEndpointDescriptor): Promise<void> {
    await this.connectPeerInternal(undefined, remoteEndpoint);
  }

  async connectPeer(peerId: string, remoteEndpoint: TunnelEndpointDescriptor): Promise<void> {
    await this.connectPeerInternal(peerId, remoteEndpoint);
  }

  private async connectPeerInternal(
    peerId: string | undefined,
    remoteEndpoint: TunnelEndpointDescriptor
  ): Promise<void> {
    const extIp = remoteEndpoint.externalIp;
    const extPort = remoteEndpoint.externalPort;
    const locIp = remoteEndpoint.localIp;
    const locPort = remoteEndpoint.localPort;

    const primaryIp = extIp || locIp;
    const primaryPort = extPort ?? locPort;
    if (!primaryIp || !primaryPort) {
      throw new Error('Remote endpoint is missing IP or port for Rust UDP tunnel');
    }
    const target = `${primaryIp}:${primaryPort}`;
    const fallback =
      locIp && locPort && `${locIp}:${locPort}` !== target ? `${locIp}:${locPort}` : null;
    if (!peerId) {
      this.peerAddr = target;
    }
    await invokeTauri<void>('tauri_tunnel_connect', {
      sessionId: this.sessionId,
      peerAddr: target,
      peerId: peerId ?? null,
      fallbackAddr: fallback,
    });
  }

  async disconnectPeer(peerId: string): Promise<void> {
    try {
      await invokeTauri<void>('tauri_tunnel_disconnect_peer', {
        sessionId: this.sessionId,
        peerId,
      });
    } catch {
      // Ignore disconnect errors during teardown
    }
  }

  send(payload: TunnelPacketPayload): boolean {
    return this.sendInternal(payload, undefined);
  }

  sendToPeer(peerId: string, payload: TunnelPacketPayload): boolean {
    return this.sendInternal(payload, peerId);
  }

  private sendInternal(payload: TunnelPacketPayload, peerId?: string): boolean {
    if (!this.isOpen) return false;
    const bytes =
      payload instanceof Uint8Array
        ? payload
        : payload instanceof ArrayBuffer
          ? new Uint8Array(payload)
          : this.textEncoder.encode(payload);

    this.packetsSent += 1;
    this.bytesSent += bytes.byteLength;

    if (this.rawSendSupported) {
      const headers: Record<string, string> = { 'x-session-id': this.sessionId };
      if (peerId) headers['x-peer-id'] = peerId;
      else if (this.peerAddr) headers['x-target-addr'] = this.peerAddr;

      void invokeTauri<number>('tauri_tunnel_send_raw', bytes, { headers }).catch(() => {
        this.rawSendSupported = false;
        void invokeTauri<number>('tauri_tunnel_send', {
          sessionId: this.sessionId,
          data: Array.from(bytes),
          targetAddr: peerId ? null : this.peerAddr,
          peerId: peerId ?? null,
        }).catch((err) => {
          console.warn('[RustTunnelTransport] send fallback failed:', err);
        });
      });
      return true;
    }

    void invokeTauri<number>('tauri_tunnel_send', {
      sessionId: this.sessionId,
      data: Array.from(bytes),
      targetAddr: peerId ? null : this.peerAddr,
      peerId: peerId ?? null,
    }).catch((err) => {
      console.warn('[RustTunnelTransport] send failed:', err);
    });
    return true;
  }

  sendTyped(
    packetType: TunnelPacketType | number,
    payload: Uint8Array,
    flags: number = TUNNEL_ENVELOPE_FLAGS.NONE
  ): boolean {
    const resolvedFlags = this.endpoint?.upnpMapped
      ? flags | TUNNEL_ENVELOPE_FLAGS.UPNP_ASSISTED
      : flags;
    const envelope = encodeTunnelEnvelope(packetType, payload, resolvedFlags);
    return this.send(envelope);
  }

  onPacket(listener: TunnelPacketListener): () => void {
    this.packetListeners.add(listener);
    return () => {
      this.packetListeners.delete(listener);
    };
  }

  onPeerReady(listener: TunnelPeerReadyListener): () => void {
    this.peerReadyListeners.add(listener);
    return () => {
      this.peerReadyListeners.delete(listener);
    };
  }

  onStateChange(listener: TunnelStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
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
      state: this.state,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      upnpMapped: Boolean(this.endpoint?.upnpMapped),
      peerAddr: this.peerAddr,
    };
  }

  async close(): Promise<void> {
    this.unlistenPacketEvent?.();
    this.unlistenPacketEvent = null;
    this.unlistenPeerReadyEvent?.();
    this.unlistenPeerReadyEvent = null;
    this.rxBinaryChannelActive = false;
    try {
      await invokeTauri<void>('tauri_tunnel_close', { sessionId: this.sessionId });
    } catch {
      // Ignore close errors when already torn down
    }
    this.setState('closed');
  }
}
