/**
 * sessionTunnelLifecyclePipeline.ts
 * Pure lifecycle helpers for opening, connecting, advertising, and closing
 * the Tauri Rust UDP fallback tunnel on MultiplayerSessionManager.
 */

import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';
import type { HostSessionController } from './HostSessionController.ts';
import type { ClientSessionController } from './ClientSessionController.ts';
import { isRustTunnelAvailable } from './tunnel/TunnelFactory.ts';
import type {
  TunnelEndpointDescriptor,
  TunnelTransport,
} from './tunnel/TunnelTransport.ts';

export interface SessionTunnelState {
  sessionTunnel: TunnelTransport | null;
  localTunnelDescriptor: TunnelEndpointDescriptor | null;
}

export interface SessionTunnelRoutingContext {
  readonly isHosting: boolean;
  readonly hostController: HostSessionController | null;
  readonly clientController: ClientSessionController | null;
}

export function connectRemoteSessionTunnelEndpoint(
  state: SessionTunnelState,
  channel: P2PWebRTCChannel,
  descriptor: TunnelEndpointDescriptor | Record<string, unknown> | null | undefined,
  targetPeerId: string
): void {
  const typed = descriptor as TunnelEndpointDescriptor | undefined;
  if (!typed || typed.kind !== 'rust-upnp-udp') return;
  if (!state.sessionTunnel || !state.sessionTunnel.isOpen) return;
  void state.sessionTunnel
    .connectPeer(targetPeerId, typed)
    .then(() => {
      if (state.sessionTunnel?.isOpen) {
        channel.attachTunnelTransport(state.sessionTunnel, targetPeerId);
      }
    })
    .catch((err) => {
      console.warn(
        `[MultiplayerSessionManager] Failed to connect Rust UDP tunnel to ${targetPeerId}:`,
        err
      );
    });
}

export function bindChannelSessionTunnelExchange(
  state: SessionTunnelState,
  channel: P2PWebRTCChannel,
  remotePeerId: string,
  localPeerId: string
): void {
  channel.onTunnelEndpointAdvertise = (msg) => {
    const targetPeerId = typeof msg.peerId === 'string' && msg.peerId ? msg.peerId : remotePeerId;
    connectRemoteSessionTunnelEndpoint(
      state,
      channel,
      msg.descriptor as TunnelEndpointDescriptor | undefined,
      targetPeerId
    );
  };

  if (state.localTunnelDescriptor && state.sessionTunnel?.isOpen) {
    channel.sendReliableControl(
      {
        type: 'tunnel_endpoint_advertise',
        peerId: localPeerId,
        descriptor: state.localTunnelDescriptor,
      },
      'tunnel_endpoint_advertise'
    );
  }
}

export async function closeManagedSessionTunnel(state: SessionTunnelState): Promise<void> {
  if (state.sessionTunnel) {
    const t = state.sessionTunnel;
    state.sessionTunnel = null;
    state.localTunnelDescriptor = null;
    await t.close().catch(() => undefined);
  }
}

export async function openManagedSessionTunnelIfTauri(
  state: SessionTunnelState,
  createTunnel: (sessionId: string) => TunnelTransport,
  getRoutingContext: () => SessionTunnelRoutingContext,
  role: 'host' | 'client',
  roomId: string,
  playerName: string
): Promise<void> {
  if (!isRustTunnelAvailable()) return;
  await closeManagedSessionTunnel(state);
  const tunnel = createTunnel(`rc_${role}_${roomId}_${Date.now().toString(36)}`);
  try {
    const descriptor = await tunnel.open({
      role,
      roomId,
      playerName,
      enableUpnp: true,
    });
    tunnel.onPacket((payload, fromPeerId) => {
      const ctx = getRoutingContext();
      if (ctx.isHosting && ctx.hostController) {
        const peerCh = fromPeerId ? ctx.hostController.peerChannels.get(fromPeerId) : null;
        if (peerCh) {
          peerCh.transport.handleIncomingMessage(payload);
          return;
        }
        for (const ch of ctx.hostController.peerChannels.values()) {
          ch.transport.handleIncomingMessage(payload);
          break;
        }
      } else if (ctx.clientController?.channel) {
        ctx.clientController.channel.transport.handleIncomingMessage(payload);
      }
    });
    state.sessionTunnel = tunnel;
    state.localTunnelDescriptor = descriptor;
  } catch (err) {
    console.warn('[MultiplayerSessionManager] Failed to open Rust session tunnel:', err);
    await tunnel.close().catch(() => undefined);
  }
}
