/**
 * dataChannelBinding.ts
 * Pure RTCDataChannel & control RTCDataChannel event listener binding helpers.
 */

import type { SimulatedPayload, NetworkSimulator } from './NetworkSimulator.ts';
import type { CrossTabSignaling } from './CrossTabSignaling.ts';
import type {
  DataChannelTransportEvent,
  PendingColorChangeState,
} from './dataChannelFramingPipeline.ts';

export type VoidTransportListener = () => void;
export type LocalColorUpdatedListener = (
  slotId: number,
  hex: string,
  pendingIfClosed?: PendingColorChangeState
) => void;
export type ColorChangeMessageListener = (msg: Record<string, unknown>) => void;
export type DiagnosticFleetToggleListener = (enabled: boolean, anchorMode: string) => void;
export type VoiceSignalListener = (signal: Record<string, unknown>) => void;
export type PacketDeliveredListener = (data: SimulatedPayload) => void;

export interface DataChannelTransportPort {
  simulator: NetworkSimulator;
  signaling: CrossTabSignaling;
  getDataChannel?: () => RTCDataChannel | null;
  setDataChannel?: (channel: RTCDataChannel | null) => void;
  isChannelOpen?: () => boolean;
  isCrossTabActive?: () => boolean;
  onChannelOpen?: VoidTransportListener | null;
  onChannelClosed?: VoidTransportListener | null;
  onWebRTCDataChannelOpen?: VoidTransportListener | null;
  onWebRTCDataChannelClosed?: VoidTransportListener | null;
  markDataChannelOpen?: VoidTransportListener | null;
  markDataChannelClosed?: VoidTransportListener | null;
  onLocalColorUpdated?: LocalColorUpdatedListener | null;
  updateLocalColor?: LocalColorUpdatedListener | null;
  onColorChange?: ColorChangeMessageListener | null;
  deliverColorChange?: ColorChangeMessageListener | null;
  onDiagnosticFleetToggle?: DiagnosticFleetToggleListener | null;
  deliverDiagnosticFleetToggle?: DiagnosticFleetToggleListener | null;
  onVoiceSignal?: VoiceSignalListener | null;
  deliverVoiceSignal?: VoiceSignalListener | null;
  onSessionKick?: ((reason: string) => void) | null;
  onSessionLeave?: ((reason: string) => void) | null;
  onPacketDelivered?: PacketDeliveredListener | null;
  deliverPacket?: PacketDeliveredListener | null;
}

export interface DataChannelBindingContext {
  setPrimaryChannel: (channel: RTCDataChannel) => void;
  setPrimaryOpen: (open: boolean) => void;
  setControlChannel: (channel: RTCDataChannel) => void;
  setControlOpen: (open: boolean) => void;
  isCrossTabActive: () => boolean;
  pushEvent: (event: DataChannelTransportEvent) => void;
  notifyChannelOpen: () => void;
  notifyChannelClosed: () => void;
  onIncomingMessage: (data: SimulatedPayload) => void;
}

export function bindPrimaryOrControlDataChannel(
  dataChannel: RTCDataChannel,
  ctx: DataChannelBindingContext
): void {
  if (dataChannel.label === 'game_ctrl') {
    bindControlChannel(dataChannel, ctx);
    return;
  }

  ctx.setPrimaryChannel(dataChannel);
  dataChannel.onopen = () => {
    console.log(
      `[P2PWebRTCChannel] DataChannel "${dataChannel.label}" OPEN! Handshake complete.`
    );
    ctx.setPrimaryOpen(true);
    ctx.pushEvent({ type: 'channel_open' });
    ctx.notifyChannelOpen();
  };

  dataChannel.onclose = () => {
    console.log(`[P2PWebRTCChannel] DataChannel "${dataChannel.label}" CLOSED.`);
    ctx.setPrimaryOpen(false);
    if (ctx.isCrossTabActive()) {
      console.log(
        '[P2PWebRTCChannel] DataChannel closed but Cross-Tab transport is active. Maintaining connection.'
      );
      return;
    }
    ctx.pushEvent({ type: 'channel_closed' });
    ctx.notifyChannelClosed();
  };

  dataChannel.onerror = (err) => {
    console.error('[P2PWebRTCChannel] DataChannel error:', err);
  };

  dataChannel.onmessage = (event: MessageEvent<SimulatedPayload>) => {
    ctx.onIncomingMessage(event.data);
  };
}

export function bindControlChannel(
  controlChannel: RTCDataChannel,
  ctx: DataChannelBindingContext
): void {
  ctx.setControlChannel(controlChannel);
  controlChannel.onopen = () => {
    console.log(`[P2PWebRTCChannel] Control DataChannel "${controlChannel.label}" OPEN!`);
    ctx.setControlOpen(true);
    ctx.pushEvent({ type: 'control_channel_open' });
  };
  controlChannel.onclose = () => {
    console.log(`[P2PWebRTCChannel] Control DataChannel "${controlChannel.label}" CLOSED.`);
    ctx.setControlOpen(false);
    ctx.pushEvent({ type: 'control_channel_closed' });
  };
  controlChannel.onerror = (err) => {
    console.error('[P2PWebRTCChannel] Control DataChannel error:', err);
  };
  controlChannel.onmessage = (event: MessageEvent<SimulatedPayload>) => {
    ctx.onIncomingMessage(event.data);
  };
}
