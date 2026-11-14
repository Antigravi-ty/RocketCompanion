import type { TunnelTransport } from '../tunnel/TunnelTransport.ts';
import { ReliableTunnelFramer } from '../tunnel/ReliableTunnelFramer.ts';

export interface TunnelFramerBridgeState {
  tunnel: TunnelTransport | null;
  remotePeerId: string | null;
  framer: ReliableTunnelFramer | null;
  utf8Encoder: TextEncoder;
}

export function createTunnelFramerBridgeState(): TunnelFramerBridgeState {
  return {
    tunnel: null,
    remotePeerId: null,
    framer: null,
    utf8Encoder: new TextEncoder(),
  };
}

export function attachTunnelToBridge(
  state: TunnelFramerBridgeState,
  tunnel: TunnelTransport,
  remotePeerId: string,
  onReliablePayload: (payload: Uint8Array) => void
): void {
  state.framer?.dispose();
  state.tunnel = tunnel;
  state.remotePeerId = remotePeerId;
  state.framer = new ReliableTunnelFramer({
    sendRaw: (frame) => {
      if (!state.tunnel?.isOpen || !state.remotePeerId) return false;
      return state.tunnel.sendToPeer(state.remotePeerId, frame, false);
    },
    onReliablePayload,
  });
}

export function detachTunnelFromBridge(state: TunnelFramerBridgeState): void {
  state.framer?.dispose();
  state.framer = null;
  state.tunnel = null;
  state.remotePeerId = null;
}

export function sendReliableControlViaTunnelBridge(
  state: TunnelFramerBridgeState,
  messageObj: Record<string, unknown>
): boolean {
  if (
    messageObj.type === 'tunnel_endpoint_advertise' ||
    !state.tunnel?.isOpen ||
    !state.remotePeerId
  ) {
    return false;
  }
  const encoded = state.utf8Encoder.encode(JSON.stringify(messageObj));
  if (state.framer && state.framer.sendReliable(encoded)) {
    return true;
  }
  return state.tunnel.sendToPeer(state.remotePeerId, encoded, true);
}

export function tryTransmitViaTunnelBridge(
  state: TunnelFramerBridgeState,
  payload: unknown,
  reliable: boolean
): boolean {
  if (!state.tunnel?.isOpen || !state.remotePeerId) return false;
  if (
    payload instanceof Uint8Array ||
    payload instanceof ArrayBuffer ||
    typeof payload === 'string'
  ) {
    return state.tunnel.sendToPeer(state.remotePeerId, payload, reliable);
  }
  return false;
}

export function resolveActiveTransportPath(
  state: TunnelFramerBridgeState,
  dc: RTCDataChannel | null,
  hasBroadcastFallback: boolean
): 'webrtc' | 'rust-upnp-udp' | 'crosstab' | 'disconnected' {
  if (dc && dc.readyState === 'open') return 'webrtc';
  if (state.tunnel?.isOpen && state.remotePeerId) return 'rust-upnp-udp';
  if (hasBroadcastFallback) return 'crosstab';
  return 'disconnected';
}
