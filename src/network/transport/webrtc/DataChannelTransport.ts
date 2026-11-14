/**
 * DataChannelTransport.ts
 * RTCDataChannel binding, message framing, ping/pong transport, and simulated dispatching.
 */

import type { NetworkSimulator, SimulatedPayload } from './NetworkSimulator.ts';
import type { CrossTabSignaling } from './CrossTabSignaling.ts';
import { AdaptiveReplicationPacer } from './AdaptiveReplicationPacer.ts';
import {
  PING_PONG_KIND_PING,
  PING_PONG_KIND_PONG,
  REPLICATION_MODES,
  decodeSparsePingPong16B,
  isSparsePingPong16B,
  type CsrStateBroadcastPayload,
  type ReplicationMode,
  type RoomActivitySwitchPayload,
  type StatePausedAckPayload,
} from '../../protocol/ReplicationBusProtocol.ts';
import type { TunnelTransport } from '../tunnel/TunnelTransport.ts';
import { ReliableTunnelFramer } from '../tunnel/ReliableTunnelFramer.ts';
import {
  attachTunnelToBridge,
  createTunnelFramerBridgeState,
  detachTunnelFromBridge,
  resolveActiveTransportPath,
  sendReliableControlViaTunnelBridge,
  tryTransmitViaTunnelBridge,
} from './tunnelFramerBridge.ts';
import {
  parseInboundControlFrame,
  dispatchInboundControlFrame,
  transmitClonedPayload,
  dispatchDualChannelControlFrame,
  transmitReliableControlFrame,
  type PendingColorChangeState,
  type StructuredClientInputPacket,
  type ClientInputPacketPayload,
  type InboundControlFrame,
  type DataChannelTransportEvent,
} from './dataChannelFramingPipeline.ts';
import {
  dispatchSimulatedClientInput,
  dispatchSimulatedPacket,
  dispatchSimulatedPong,
  dispatchSparsePingPongFrame,
  evaluateAdaptiveSnapshotReadiness,
  type ProbeTransportContext,
} from './dataChannelProbePipeline.ts';

export type {
  PendingColorChangeState,
  StructuredClientInputPacket,
  ClientInputPacketPayload,
  InboundControlFrame,
  DataChannelTransportEvent,
};

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

export class DataChannelTransport {
  readonly simulator: NetworkSimulator;
  readonly signaling: CrossTabSignaling;
  dataChannel: RTCDataChannel | null = null;
  controlDataChannel: RTCDataChannel | null = null;
  isWebRTCOpen = false;
  isControlChannelOpen = false;
  readonly pacer = new AdaptiveReplicationPacer();
  localColorSlot = 0;
  localColorHex = '#ff7043';
  pendingColorChange: PendingColorChangeState | null = null;

  onChannelOpen: VoidTransportListener | null;
  onChannelClosed: VoidTransportListener | null;
  onLocalColorUpdated: LocalColorUpdatedListener | null;
  onColorChange: ColorChangeMessageListener | null;
  onDiagnosticFleetToggle: DiagnosticFleetToggleListener | null;
  onPacketDelivered: PacketDeliveredListener | null;
  onTunnelEndpointAdvertise: ControlPayloadListener | null = null;
  onPeerKick: ControlPayloadListener | null = null;
  onPeerLeave: ControlPayloadListener | null = null;
  onVoiceSignal: ControlPayloadListener | null = null;
  onGlobalWorkspaceBroadcast: ControlPayloadListener | null = null;

  private readonly tunnelBridge = createTunnelFramerBridgeState();
  private readonly utf8Decoder = new TextDecoder();

  private readonly readExternalChannel: (() => RTCDataChannel | null) | null;
  private readonly writeExternalChannel: ((channel: RTCDataChannel | null) => void) | null;
  private readonly checkExternalOpen: (() => boolean) | null;
  private readonly checkExternalCrossTab: (() => boolean) | null;
  private readonly transportEvents: DataChannelTransportEvent[] = [];

  constructor(config: DataChannelTransportPort) {
    this.simulator = config.simulator;
    this.signaling = config.signaling;
    this.readExternalChannel = config.getDataChannel ?? null;
    this.writeExternalChannel = config.setDataChannel ?? null;
    this.checkExternalOpen = config.isChannelOpen ?? null;
    this.checkExternalCrossTab = config.isCrossTabActive ?? null;

    this.onChannelOpen =
      config.onChannelOpen ?? config.onWebRTCDataChannelOpen ?? config.markDataChannelOpen ?? null;
    this.onChannelClosed =
      config.onChannelClosed ??
      config.onWebRTCDataChannelClosed ??
      config.markDataChannelClosed ??
      null;
    this.onLocalColorUpdated = config.onLocalColorUpdated ?? config.updateLocalColor ?? null;
    this.onColorChange = config.onColorChange ?? config.deliverColorChange ?? null;
    this.onDiagnosticFleetToggle =
      config.onDiagnosticFleetToggle ?? config.deliverDiagnosticFleetToggle ?? null;
    this.onPacketDelivered = config.onPacketDelivered ?? config.deliverPacket ?? null;
  }

  attachTunnelTransport(tunnel: TunnelTransport, remotePeerId: string): void {
    attachTunnelToBridge(this.tunnelBridge, tunnel, remotePeerId, (payload) =>
      this.handleIncomingMessage(payload)
    );
  }

  detachTunnelTransport(): void {
    detachTunnelFromBridge(this.tunnelBridge);
  }

  getTunnelFramer(): ReliableTunnelFramer | null {
    return this.tunnelBridge.framer;
  }

  hasActiveTunnel(): boolean {
    return Boolean(this.tunnelBridge.tunnel?.isOpen && this.tunnelBridge.remotePeerId);
  }

  drainTransportEvents(): DataChannelTransportEvent[] {
    if (this.transportEvents.length === 0) return [];
    return this.transportEvents.splice(0, this.transportEvents.length);
  }

  private resolveActiveDataChannel(): RTCDataChannel | null {
    if (this.readExternalChannel) {
      return this.readExternalChannel();
    }
    return this.dataChannel;
  }

  private resolveIsChannelOpen(): boolean {
    if (this.checkExternalOpen) {
      return this.checkExternalOpen();
    }
    return this.isWebRTCOpen;
  }

  private resolveIsCrossTabActive(): boolean {
    if (this.checkExternalCrossTab) {
      return this.checkExternalCrossTab();
    }
    return Boolean(this.signaling.roomBroadcastChannel);
  }

  private emitPacket(payload: SimulatedPayload): void {
    this.transportEvents.push({ type: 'packet', payload });
    if (this.onPacketDelivered) {
      this.onPacketDelivered(payload);
    }
  }

  bindDataChannel(dataChannel: RTCDataChannel): void {
    if (dataChannel.label === 'game_ctrl') {
      this.bindControlDataChannel(dataChannel);
      return;
    }
    this.dataChannel = dataChannel;
    if (this.writeExternalChannel) {
      this.writeExternalChannel(dataChannel);
    }
    dataChannel.onopen = () => {
      console.log(
        `[P2PWebRTCChannel] DataChannel "${dataChannel.label}" OPEN! Handshake complete.`
      );
      this.isWebRTCOpen = true;
      this.transportEvents.push({ type: 'channel_open' });
      if (this.onChannelOpen) {
        this.onChannelOpen();
      }
    };

    dataChannel.onclose = () => {
      console.log(`[P2PWebRTCChannel] DataChannel "${dataChannel.label}" CLOSED.`);
      this.isWebRTCOpen = false;
      if (this.resolveIsCrossTabActive()) {
        console.log(
          '[P2PWebRTCChannel] DataChannel closed but Cross-Tab transport is active. Maintaining connection.'
        );
        return;
      }
      this.transportEvents.push({ type: 'channel_closed' });
      if (this.onChannelClosed) {
        this.onChannelClosed();
      }
    };

    dataChannel.onerror = (err) => {
      console.error('[P2PWebRTCChannel] DataChannel error:', err);
    };

    dataChannel.onmessage = (event: MessageEvent<SimulatedPayload>) => {
      this.handleIncomingMessage(event.data);
    };
  }

  bindControlDataChannel(controlChannel: RTCDataChannel): void {
    this.controlDataChannel = controlChannel;
    controlChannel.onopen = () => {
      console.log(`[P2PWebRTCChannel] Control DataChannel "${controlChannel.label}" OPEN!`);
      this.isControlChannelOpen = true;
      this.transportEvents.push({ type: 'control_channel_open' });
    };
    controlChannel.onclose = () => {
      console.log(`[P2PWebRTCChannel] Control DataChannel "${controlChannel.label}" CLOSED.`);
      this.isControlChannelOpen = false;
      this.transportEvents.push({ type: 'control_channel_closed' });
    };
    controlChannel.onerror = (err) => {
      console.error('[P2PWebRTCChannel] Control DataChannel error:', err);
    };
    controlChannel.onmessage = (event: MessageEvent<SimulatedPayload>) => {
      this.handleIncomingMessage(event.data);
    };
  }

  handleIncomingMessage(data: SimulatedPayload | null | undefined): void {
    const sim = this.simulator;
    const now = performance.now();
    sim.stats.packetsReceived++;

    if (data instanceof Uint8Array && ReliableTunnelFramer.isReliableFrame(data)) {
      if (this.tunnelBridge.framer) {
        this.tunnelBridge.framer.handleIncomingFrame(data);
      }
      return;
    }

    if (isSparsePingPong16B(data)) {
      const frame = decodeSparsePingPong16B(data);
      if (frame) {
        if (frame.kind === PING_PONG_KIND_PING) {
          this.sendSparsePingPong16B(
            PING_PONG_KIND_PONG,
            frame.seq,
            frame.timestampMs,
            frame.epoch,
            frame.ackTick
          );
        } else {
          sim.handlePong(frame.timestampMs);
        }
        return;
      }
    }

    let maybeString: string | null = typeof data === 'string' ? data : null;
    if (!maybeString && data instanceof Uint8Array && data.byteLength > 0 && data[0] === 0x7b) {
      maybeString = this.utf8Decoder.decode(data);
    }

    if (maybeString !== null && data != null) {
      const control = parseInboundControlFrame(maybeString);
      if (control) {
        dispatchInboundControlFrame(control, {
          rawData: data,
          nowMs: now,
          pushEvent: (ev) => this.transportEvents.push(ev),
          setReplicationMode: (isSparse) =>
            this.pacer.setMode(isSparse ? REPLICATION_MODES.SPARSE : REPLICATION_MODES.CONTINUOUS),
          onColorChange: this.onColorChange,
          onDiagnosticFleetToggle: this.onDiagnosticFleetToggle,
          onTunnelEndpointAdvertise: this.onTunnelEndpointAdvertise,
          onPeerKick: this.onPeerKick,
          onPeerLeave: this.onPeerLeave,
          onVoiceSignal: this.onVoiceSignal,
          onGlobalWorkspaceBroadcast: this.onGlobalWorkspaceBroadcast,
          receiveSimulatorPayload: (payload, onDelivered, ts) =>
            sim.receivePayload(payload, onDelivered, ts),
          popInboundQueue: () => {
            if (sim.inboundQueue.length > 0) sim.inboundQueue.pop();
          },
          sendPong: (sendTime) => this.sendPong(sendTime),
          handlePong: (sendTime) => sim.handlePong(sendTime),
          emitPacket: (delivered) => this.emitPacket(delivered),
        });
        return;
      }
    }

    if (!data) return;
    sim.receivePayload(
      data,
      (delivered) => {
        this.emitPacket(delivered);
      },
      now
    );
  }

  private transmitViaTunnelOrDataChannel(
    payload: SimulatedPayload,
    allowBroadcastFallback: boolean,
    reliable = false
  ): boolean {
    const dc = this.resolveActiveDataChannel();
    if (dc?.readyState !== 'open' && tryTransmitViaTunnelBridge(this.tunnelBridge, payload, reliable)) {
      return true;
    }
    return transmitClonedPayload(
      dc,
      this.signaling.roomBroadcastChannel,
      allowBroadcastFallback,
      payload
    );
  }

  getTransportPath(): 'webrtc' | 'rust-upnp-udp' | 'crosstab' | 'disconnected' {
    return resolveActiveTransportPath(
      this.tunnelBridge,
      this.resolveActiveDataChannel(),
      this.resolveIsCrossTabActive() || Boolean(this.signaling.roomBroadcastChannel)
    );
  }

  private getProbeContext(): ProbeTransportContext {
    return {
      simulator: this.simulator,
      pacer: this.pacer,
      tunnelBridge: this.tunnelBridge,
      activeDataChannel: this.resolveActiveDataChannel(),
      roomBroadcastChannel: this.signaling.roomBroadcastChannel,
      isChannelOpen: this.resolveIsChannelOpen(),
      transmitViaTunnelOrDataChannel: (payload, allowBroadcastFallback, reliable = false) =>
        this.transmitViaTunnelOrDataChannel(payload, allowBroadcastFallback, reliable),
    };
  }

  sendPong(sendTime: number, nowMs = performance.now()): void {
    dispatchSimulatedPong(this.getProbeContext(), sendTime, nowMs);
  }

  send(packet: SimulatedPayload, nowMs = performance.now()): boolean {
    return dispatchSimulatedPacket(this.getProbeContext(), packet, nowMs);
  }

  sendClientInput(packet: ClientInputPacketPayload, nowMs = performance.now()): boolean {
    return dispatchSimulatedClientInput(this.getProbeContext(), packet, nowMs);
  }

  sendColorChange(slotId: number, hex: string, carIndex: number): void {
    const dc = this.resolveActiveDataChannel();
    const roomChannel = this.signaling.roomBroadcastChannel;
    const isClosed =
      !this.resolveIsChannelOpen() && (!dc || dc.readyState !== 'open') && !roomChannel;
    const pending = isClosed ? { slotId, hex, carIndex } : undefined;
    this.localColorSlot = slotId;
    this.localColorHex = hex;
    if (pending) {
      this.pendingColorChange = pending;
    }
    if (this.onLocalColorUpdated) {
      this.onLocalColorUpdated(slotId, hex, pending);
    }
    dispatchDualChannelControlFrame(
      dc,
      roomChannel,
      { type: 'color_change', slotId, hex, carIndex },
      'color_change',
      `slot ${slotId} (${hex}) for car ${carIndex}`
    );
  }

  sendDiagnosticFleetToggle(enabled: boolean, anchorMode: string | null): void {
    dispatchDualChannelControlFrame(
      this.resolveActiveDataChannel(),
      this.signaling.roomBroadcastChannel,
      {
        type: 'diagnostic_fleet_toggle',
        enabled: Boolean(enabled),
        anchorMode,
      },
      'diagnostic_fleet_toggle'
    );
  }

  sendReliableControl(messageObj: Record<string, unknown>, label = 'reliable_control'): boolean {
    const dc = this.resolveActiveDataChannel();
    const webrtcOpen =
      this.controlDataChannel?.readyState === 'open' || dc?.readyState === 'open';
    if (!webrtcOpen && sendReliableControlViaTunnelBridge(this.tunnelBridge, messageObj)) {
      return true;
    }
    return transmitReliableControlFrame(
      this.controlDataChannel,
      dc,
      this.signaling.roomBroadcastChannel,
      messageObj,
      label
    );
  }

  sendVoiceSignal(signal: Record<string, unknown>): boolean {
    return this.sendReliableControl({ type: 'voice_signal', ...signal }, 'voice_signal');
  }

  sendGlobalWorkspaceBroadcast(payload: Record<string, unknown>): boolean {
    return this.sendReliableControl(
      { type: 'global_workspace_broadcast', ...payload },
      'global_workspace_broadcast'
    );
  }

  sendRoomActivitySwitch(payload: RoomActivitySwitchPayload): boolean {
    if (payload.replicationMode) {
      this.pacer.setMode(payload.replicationMode);
    }
    return this.sendReliableControl(
      { type: 'room_activity_switch', ...payload },
      'room_activity_switch'
    );
  }

  sendStatePausedAck(payload: StatePausedAckPayload): boolean {
    return this.sendReliableControl({ type: 'state_paused_ack', ...payload }, 'state_paused_ack');
  }

  sendCsrStateBroadcast(payload: CsrStateBroadcastPayload): boolean {
    return this.sendReliableControl(
      { type: 'room_csr_state_broadcast', ...payload },
      'room_csr_state_broadcast'
    );
  }

  setReplicationMode(mode: ReplicationMode, epoch = 0): boolean {
    this.pacer.setMode(mode);
    return this.sendReliableControl(
      { type: 'replication_mode_set', replicationMode: mode, epoch },
      'replication_mode_set'
    );
  }

  sendSparsePingPong16B(
    kind: typeof PING_PONG_KIND_PING | typeof PING_PONG_KIND_PONG,
    seq: number,
    timestampMs = performance.now(),
    epoch = 0,
    ackTick = 0
  ): boolean {
    return dispatchSparsePingPongFrame(
      this.getProbeContext(),
      kind,
      seq,
      timestampMs,
      epoch,
      ackTick
    );
  }

  shouldSendAdaptiveSnapshot(nowMs = performance.now()): boolean {
    return evaluateAdaptiveSnapshotReadiness(this.getProbeContext(), nowMs);
  }
}
