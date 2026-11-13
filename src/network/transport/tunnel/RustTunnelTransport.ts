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
  TunnelStateListener,
  TunnelStats,
  TunnelTransport,
  UpnpProbeResult,
} from './TunnelTransport.ts';

interface TauriCoreApi {
  invoke?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
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
}

interface RustTunnelStatusResponse {
  sessionId: string;
  open: boolean;
  localPort: number;
  externalIp: string | null;
  externalPort: number | null;
  upnpMapped: boolean;
  peerAddr: string | null;
  bytesSent: number;
  bytesReceived: number;
}

interface RustTunnelPacketEvent {
  sessionId: string;
  fromAddr: string;
  data: number[];
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
  private readonly stateListeners = new Set<TunnelStateListener>();
  private unlistenPacketEvent: (() => void) | null = null;
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

  async open(options: TunnelOpenOptions = {}): Promise<TunnelEndpointDescriptor> {
    if (options.sessionId) {
      this.sessionId = options.sessionId;
    }
    this.setState('opening');

    try {
      if (this.unlistenPacketEvent) {
        this.unlistenPacketEvent();
        this.unlistenPacketEvent = null;
      }

      this.unlistenPacketEvent = await listenTauriEvent<RustTunnelPacketEvent>(
        'rc-tunnel-packet',
        (ev) => {
          if (!ev || ev.sessionId !== this.sessionId) return;
          const bytes = new Uint8Array(ev.data);
          this.packetsReceived += 1;
          this.bytesReceived += bytes.byteLength;
          for (const listener of this.packetListeners) {
            listener(bytes, ev.fromAddr);
          }
        }
      );

      const res = await invokeTauri<RustTunnelEndpointResponse>('tauri_tunnel_open', {
        sessionId: this.sessionId,
        preferredPort: options.preferredPort ?? null,
        enableUpnp: options.enableUpnp ?? true,
      });

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
    const ip = remoteEndpoint.externalIp || remoteEndpoint.localIp;
    const port = remoteEndpoint.externalPort ?? remoteEndpoint.localPort;
    if (!ip || !port) {
      throw new Error('Remote endpoint is missing IP or port for Rust UDP tunnel');
    }
    const target = `${ip}:${port}`;
    this.peerAddr = target;
    await invokeTauri<void>('tauri_tunnel_connect', {
      sessionId: this.sessionId,
      peerAddr: target,
    });
  }

  send(payload: TunnelPacketPayload): boolean {
    if (!this.isOpen) return false;
    const bytes =
      payload instanceof Uint8Array
        ? payload
        : payload instanceof ArrayBuffer
          ? new Uint8Array(payload)
          : this.textEncoder.encode(payload);

    this.packetsSent += 1;
    this.bytesSent += bytes.byteLength;
    void invokeTauri<number>('tauri_tunnel_send', {
      sessionId: this.sessionId,
      data: Array.from(bytes),
      targetAddr: this.peerAddr,
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
    if (this.unlistenPacketEvent) {
      this.unlistenPacketEvent();
      this.unlistenPacketEvent = null;
    }
    try {
      await invokeTauri<void>('tauri_tunnel_close', { sessionId: this.sessionId });
    } catch {
      // Ignore close errors when already torn down
    }
    this.setState('closed');
  }
}
