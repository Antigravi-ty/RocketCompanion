import type { NetworkSimulator, SimulatedPayload } from './NetworkSimulator.ts';
import type { CrossTabSignaling } from './CrossTabSignaling.ts';
import type { PendingColorChangeState } from './dataChannelFramingPipeline.ts';

export type VoidTransportListener = () => void;
export type LocalColorUpdatedListener = (
  slotId: number,
  hex: string,
  pendingIfClosed?: PendingColorChangeState
) => void;
export type ColorChangeMessageListener = (msg: Record<string, unknown>) => void;
export type DiagnosticFleetToggleListener = (enabled: boolean, anchorMode: string) => void;
export type PacketDeliveredListener = (data: SimulatedPayload) => void;
export type ControlPayloadListener = (msg: Record<string, unknown>) => void;

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
  onPacketDelivered?: PacketDeliveredListener | null;
  deliverPacket?: PacketDeliveredListener | null;
}
