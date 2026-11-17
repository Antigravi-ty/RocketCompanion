/**
 * dataChannelControlFraming.ts
 * Pure JSON control-frame parsing and dispatch helpers for DataChannelTransport.
 */

import type { SimulatedPayload } from './NetworkSimulator.ts';

export type InboundControlFrame =
  | { readonly kind: 'color_change'; readonly raw: Record<string, unknown> }
  | {
      readonly kind: 'diagnostic_fleet_toggle';
      readonly enabled: boolean;
      readonly anchorMode: string;
    }
  | { readonly kind: 'room_activity_switch'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'replication_mode_set'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'state_paused_ack'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'room_csr_state_broadcast'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'tunnel_endpoint_advertise'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'peer_kick'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'peer_leave'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'voice_signal'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'global_workspace_broadcast'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'pause_state_sync'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'pause_state_ack'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'presence_ping'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'client_authority_frame'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'camera_state_sync'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'ping'; readonly sendTime: number; readonly rtt: number | null }
  | { readonly kind: 'pong'; readonly sendTime: number };

export type DataChannelTransportEvent =
  | { readonly type: 'channel_open' }
  | { readonly type: 'channel_closed' }
  | { readonly type: 'control_channel_open' }
  | { readonly type: 'control_channel_closed' }
  | { readonly type: 'color_change'; readonly payload: Record<string, unknown> }
  | {
      readonly type: 'diagnostic_fleet_toggle';
      readonly enabled: boolean;
      readonly anchorMode: string;
    }
  | { readonly type: 'room_activity_switch'; readonly payload: Record<string, unknown> }
  | { readonly type: 'replication_mode_set'; readonly payload: Record<string, unknown> }
  | { readonly type: 'state_paused_ack'; readonly payload: Record<string, unknown> }
  | { readonly type: 'room_csr_state_broadcast'; readonly payload: Record<string, unknown> }
  | { readonly type: 'tunnel_endpoint_advertise'; readonly payload: Record<string, unknown> }
  | { readonly type: 'peer_kick'; readonly payload: Record<string, unknown> }
  | { readonly type: 'peer_leave'; readonly payload: Record<string, unknown> }
  | { readonly type: 'voice_signal'; readonly payload: Record<string, unknown> }
  | { readonly type: 'global_workspace_broadcast'; readonly payload: Record<string, unknown> }
  | { readonly type: 'pause_state_sync'; readonly payload: Record<string, unknown> }
  | { readonly type: 'pause_state_ack'; readonly payload: Record<string, unknown> }
  | { readonly type: 'presence_ping'; readonly payload: Record<string, unknown> }
  | { readonly type: 'client_authority_frame'; readonly payload: Record<string, unknown> }
  | { readonly type: 'camera_state_sync'; readonly payload: Record<string, unknown> }
  | { readonly type: 'telestrator_sync'; readonly payload: Uint8Array }
  | { readonly type: 'packet'; readonly payload: SimulatedPayload };

export function parseInboundControlFrame(raw: string): InboundControlFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const msg = parsed as Record<string, unknown>;
    if (msg.type === 'color_change') {
      return { kind: 'color_change', raw: msg };
    }
    if (msg.type === 'diagnostic_fleet_toggle') {
      return {
        kind: 'diagnostic_fleet_toggle',
        enabled: Boolean(msg.enabled),
        anchorMode: typeof msg.anchorMode === 'string' ? msg.anchorMode : '',
      };
    }
    if (msg.type === 'room_activity_switch') {
      return { kind: 'room_activity_switch', raw: msg };
    }
    if (msg.type === 'replication_mode_set') {
      return { kind: 'replication_mode_set', raw: msg };
    }
    if (msg.type === 'state_paused_ack') {
      return { kind: 'state_paused_ack', raw: msg };
    }
    if (msg.type === 'room_csr_state_broadcast') {
      return { kind: 'room_csr_state_broadcast', raw: msg };
    }
    if (msg.type === 'tunnel_endpoint_advertise') {
      return { kind: 'tunnel_endpoint_advertise', raw: msg };
    }
    if (msg.type === 'peer_kick') {
      return { kind: 'peer_kick', raw: msg };
    }
    if (msg.type === 'peer_leave') {
      return { kind: 'peer_leave', raw: msg };
    }
    if (msg.type === 'voice_signal') {
      return { kind: 'voice_signal', raw: msg };
    }
    if (msg.type === 'global_workspace_broadcast') {
      return { kind: 'global_workspace_broadcast', raw: msg };
    }
    if (msg.type === 'pause_state_sync') {
      return { kind: 'pause_state_sync', raw: msg };
    }
    if (msg.type === 'pause_state_ack') {
      return { kind: 'pause_state_ack', raw: msg };
    }
    if (msg.type === 'presence_ping') {
      return { kind: 'presence_ping', raw: msg };
    }
    if (msg.type === 'client_authority_frame') {
      return { kind: 'client_authority_frame', raw: msg };
    }
    if (msg.type === 'camera_state_sync') {
      return { kind: 'camera_state_sync', raw: msg };
    }
    if (msg.type === 'ping') {
      const sendTime = typeof msg.sendTime === 'number' ? msg.sendTime : 0;
      const rtt =
        typeof msg.rtt === 'number' && Number.isFinite(msg.rtt) && msg.rtt > 0 ? msg.rtt : null;
      return { kind: 'ping', sendTime, rtt };
    }
    if (msg.type === 'pong') {
      const sendTime = typeof msg.sendTime === 'number' ? msg.sendTime : 0;
      return { kind: 'pong', sendTime };
    }
  } catch (err) {
    console.warn('[P2PWebRTCChannel] Failed to parse incoming string message as JSON:', err, raw);
  }
  return null;
}

export interface InboundControlDispatchContext {
  readonly rawData: SimulatedPayload;
  readonly nowMs: number;
  readonly pushEvent: (event: DataChannelTransportEvent) => void;
  readonly setReplicationMode: (isSparse: boolean) => void;
  readonly onColorChange: ((raw: Record<string, unknown>) => void) | null;
  readonly onDiagnosticFleetToggle: ((enabled: boolean, anchorMode: string) => void) | null;
  readonly onTunnelEndpointAdvertise: ((raw: Record<string, unknown>) => void) | null;
  readonly onPeerKick: ((raw: Record<string, unknown>) => void) | null;
  readonly onPeerLeave: ((raw: Record<string, unknown>) => void) | null;
  readonly onVoiceSignal: ((raw: Record<string, unknown>) => void) | null;
  readonly onGlobalWorkspaceBroadcast?: ((raw: Record<string, unknown>) => void) | null;
  readonly onPauseStateSync?: ((raw: Record<string, unknown>) => void) | null;
  readonly onPauseStateAck?: ((raw: Record<string, unknown>) => void) | null;
  readonly onPresencePing?: ((raw: Record<string, unknown>) => void) | null;
  readonly onClientAuthorityFrame?: ((raw: Record<string, unknown>) => void) | null;
  readonly onCameraStateSync?: ((raw: Record<string, unknown>) => void) | null;
  readonly receiveSimulatorPayload: (
    data: SimulatedPayload,
    onDelivered: (delivered: SimulatedPayload) => void,
    nowMs: number
  ) => boolean;
  readonly popInboundQueue: () => void;
  readonly sendPong: (sendTime: number) => void;
  readonly handlePong: (sendTime: number) => void;
  readonly emitPacket: (delivered: SimulatedPayload) => void;
}

export function dispatchInboundControlFrame(
  control: InboundControlFrame,
  ctx: InboundControlDispatchContext
): boolean {
  switch (control.kind) {
    case 'color_change': {
      const raw = control.raw;
      console.log(
        `[P2PWebRTCChannel] Received remote color_change: car ${String(raw.carIndex)} -> slot ${String(raw.slotId)} (${String(raw.hex)})`
      );
      ctx.pushEvent({ type: 'color_change', payload: raw });
      ctx.onColorChange?.(raw);
      return true;
    }
    case 'diagnostic_fleet_toggle':
      ctx.pushEvent({
        type: 'diagnostic_fleet_toggle',
        enabled: control.enabled,
        anchorMode: control.anchorMode,
      });
      ctx.onDiagnosticFleetToggle?.(control.enabled, control.anchorMode);
      return true;
    case 'tunnel_endpoint_advertise':
      ctx.pushEvent({ type: 'tunnel_endpoint_advertise', payload: control.raw });
      ctx.onTunnelEndpointAdvertise?.(control.raw);
      return true;
    case 'peer_kick':
      ctx.pushEvent({ type: 'peer_kick', payload: control.raw });
      ctx.onPeerKick?.(control.raw);
      return true;
    case 'peer_leave':
      ctx.pushEvent({ type: 'peer_leave', payload: control.raw });
      ctx.onPeerLeave?.(control.raw);
      return true;
    case 'voice_signal':
      ctx.pushEvent({ type: 'voice_signal', payload: control.raw });
      ctx.onVoiceSignal?.(control.raw);
      return true;
    case 'global_workspace_broadcast':
      ctx.pushEvent({ type: 'global_workspace_broadcast', payload: control.raw });
      ctx.onGlobalWorkspaceBroadcast?.(control.raw);
      return true;
    case 'pause_state_sync':
      ctx.pushEvent({ type: 'pause_state_sync', payload: control.raw });
      ctx.onPauseStateSync?.(control.raw);
      return true;
    case 'pause_state_ack':
      ctx.pushEvent({ type: 'pause_state_ack', payload: control.raw });
      ctx.onPauseStateAck?.(control.raw);
      return true;
    case 'presence_ping':
      ctx.pushEvent({ type: 'presence_ping', payload: control.raw });
      ctx.onPresencePing?.(control.raw);
      return true;
    case 'client_authority_frame':
      ctx.pushEvent({ type: 'client_authority_frame', payload: control.raw });
      ctx.onClientAuthorityFrame?.(control.raw);
      return true;
    case 'camera_state_sync':
      ctx.pushEvent({ type: 'camera_state_sync', payload: control.raw });
      ctx.onCameraStateSync?.(control.raw);
      return true;
    case 'room_activity_switch':
    case 'replication_mode_set':
    case 'state_paused_ack':
    case 'room_csr_state_broadcast':
      if (control.kind === 'replication_mode_set') {
        ctx.setReplicationMode(control.raw.replicationMode === 'SPARSE');
      }
      ctx.pushEvent({ type: control.kind, payload: control.raw });
      return true;
    case 'ping': {
      const accepted = ctx.receiveSimulatorPayload(
        ctx.rawData,
        (delivered) => {
          ctx.sendPong(control.sendTime);
          ctx.emitPacket(delivered);
        },
        ctx.nowMs
      );
      if (accepted) ctx.popInboundQueue();
      return true;
    }
    case 'pong': {
      const accepted = ctx.receiveSimulatorPayload(
        ctx.rawData,
        () => ctx.handlePong(control.sendTime),
        ctx.nowMs
      );
      if (accepted) ctx.popInboundQueue();
      return true;
    }
  }
}
