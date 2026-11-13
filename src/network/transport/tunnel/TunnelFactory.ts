/**
 * src/network/transport/tunnel/TunnelFactory.ts
 * Selects RustTunnelTransport when running inside the Tauri desktop shell,
 * falling back transparently to WebTunnelTransport in standard browsers.
 */

import { isTauriRuntime } from '../../../ui-core/config/tauriLaunchConfigBridge.ts';
import type { P2PWebRTCChannel } from '../P2PWebRTCChannel.ts';
import { RustTunnelTransport, probeRustUpnpGateway } from './RustTunnelTransport.ts';
import type { TunnelTransport, UpnpProbeResult } from './TunnelTransport.ts';
import { WebTunnelTransport, type WebTunnelTransportOptions } from './WebTunnelTransport.ts';

export interface TunnelFactoryOptions {
  sessionId?: string;
  forceWeb?: boolean;
  webChannel?: P2PWebRTCChannel;
  webOptions?: WebTunnelTransportOptions;
}

export function isRustTunnelAvailable(): boolean {
  return isTauriRuntime();
}

export async function probeRustUpnp(): Promise<UpnpProbeResult> {
  if (!isRustTunnelAvailable()) {
    return {
      available: false,
      gatewayAddr: null,
      localIp: null,
      externalIp: null,
      error: 'Rust UPnP probe requires Tauri desktop runtime',
    };
  }
  return probeRustUpnpGateway();
}

export function createTunnelTransport(options: TunnelFactoryOptions = {}): TunnelTransport {
  if (!options.forceWeb && isRustTunnelAvailable()) {
    return new RustTunnelTransport(options.sessionId);
  }
  return new WebTunnelTransport({
    ...options.webOptions,
    sessionId: options.sessionId ?? options.webOptions?.sessionId,
    channel: options.webChannel ?? options.webOptions?.channel,
  });
}
