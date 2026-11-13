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
  encodeSparsePingPong16B,
  isSparsePingPong16B,
  type CsrStateBroadcastPayload,
  type ReplicationMode,
  type RoomActivitySwitchPayload,
  type StatePausedAckPayload,
} from '../../protocol/ReplicationBusProtocol.ts';
import {
  parseInboundControlFrame,
  encodeClientInputPayload,
  dispatchOpportunisticPing,
  transmitClonedPayload,
  dispatchDualChannelControlFrame,
  transmitReliableControlFrame,
  type PendingColorChangeState,
  type StructuredClientInputPacket,
  type ClientInputPacketPayload,
  type InboundControlFrame,
  type DataChannelTransportEvent,
} from './dataChannelFramingPipeline.ts';

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

    if (typeof data === 'string') {
      const control = parseInboundControlFrame(data);
      if (control) {
        if (control.kind === 'color_change') {
          const raw = control.raw;
          console.log(
            `[P2PWebRTCChannel] Received remote color_change: car ${String(raw.carIndex)} -> slot ${String(raw.slotId)} (${String(raw.hex)})`
          );
          this.transportEvents.push({ type: 'color_change', payload: raw });
          if (this.onColorChange) {
            this.onColorChange(raw);
          }
          return;
        }
        if (control.kind === 'diagnostic_fleet_toggle') {
          this.transportEvents.push({
            type: 'diagnostic_fleet_toggle',
            enabled: control.enabled,
            anchorMode: control.anchorMode,
          });
          if (this.onDiagnosticFleetToggle) {
            this.onDiagnosticFleetToggle(control.enabled, control.anchorMode);
          }
          return;
        }
        if (
          control.kind === 'room_activity_switch' ||
          control.kind === 'replication_mode_set' ||
          control.kind === 'state_paused_ack' ||
          control.kind === 'room_csr_state_broadcast'
        ) {
          if (control.kind === 'replication_mode_set') {
            const nextMode =
              control.raw.replicationMode === REPLICATION_MODES.SPARSE
                ? REPLICATION_MODES.SPARSE
                : REPLICATION_MODES.CONTINUOUS;
            this.pacer.setMode(nextMode);
          }
          this.transportEvents.push({ type: control.kind, payload: control.raw });
          return;
        }
        if (control.kind === 'ping') {
          const accepted = sim.receivePayload(
            data,
            (delivered) => {
              this.sendPong(control.sendTime);
              this.emitPacket(delivered);
            },
            now
          );
          if (accepted && sim.inboundQueue.length > 0) {
            sim.inboundQueue.pop();
          }
          return;
        }
        if (control.kind === 'pong') {
          const accepted = sim.receivePayload(
            data,
            () => {
              sim.handlePong(control.sendTime);
            },
            now
          );
          if (accepted && sim.inboundQueue.length > 0) {
            sim.inboundQueue.pop();
          }
          return;
        }
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

  sendPong(sendTime: number, nowMs = performance.now()): void {
    const pongMsg = JSON.stringify({ type: 'pong', sendTime });
    this.simulator.scheduleSend(
      pongMsg,
      (clonedPacket) =>
        transmitClonedPayload(
          this.resolveActiveDataChannel(),
          this.signaling.roomBroadcastChannel,
          this.resolveIsChannelOpen() || Boolean(this.signaling.roomBroadcastChannel),
          clonedPacket
        ),
      nowMs
    );
  }

  send(packet: SimulatedPayload, nowMs = performance.now()): boolean {
    const sim = this.simulator;

    if (
      (packet instanceof Uint8Array || packet instanceof ArrayBuffer) &&
      nowMs - sim.lastPingSentTime > sim.pingIntervalMs
    ) {
      sim.lastPingSentTime = nowMs;
      sim.stats.pingsSent++;
      const pingPayload = JSON.stringify({
        type: 'ping',
        sendTime: nowMs,
        rtt: Math.round(sim.rttMs || 0),
      });
      sim.scheduleSend(
        pingPayload,
        (clonedPing) =>
          dispatchOpportunisticPing(
            this.resolveActiveDataChannel(),
            this.signaling.roomBroadcastChannel,
            this.resolveIsChannelOpen() || Boolean(this.signaling.roomBroadcastChannel),
            nowMs,
            sim.rttMs,
            typeof clonedPing === 'string' ? clonedPing : pingPayload
          ),
        nowMs
      );
    }
    return sim.scheduleSend(
      packet,
      (clonedPacket) =>
        transmitClonedPayload(
          this.resolveActiveDataChannel(),
          this.signaling.roomBroadcastChannel,
          this.resolveIsChannelOpen(),
          clonedPacket
        ),
      nowMs
    );
  }

  sendClientInput(packet: ClientInputPacketPayload, nowMs = performance.now()): boolean {
    const sim = this.simulator;
    const buf = encodeClientInputPayload(packet);
    const sent = this.send(buf, nowMs);
    if (nowMs - sim.lastPingSentTime > sim.pingIntervalMs) {
      sim.lastPingSentTime = nowMs;
      sim.stats.pingsSent++;
      this.send(
        JSON.stringify({ type: 'ping', sendTime: nowMs, rtt: Math.round(sim.rttMs) }),
        nowMs
      );
    }
    return sent;
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
    return transmitReliableControlFrame(
      this.controlDataChannel,
      this.resolveActiveDataChannel(),
      this.signaling.roomBroadcastChannel,
      messageObj,
      label
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
    const frame = encodeSparsePingPong16B({ kind, seq, timestampMs, epoch, ackTick });
    return transmitClonedPayload(
      this.resolveActiveDataChannel(),
      this.signaling.roomBroadcastChannel,
      this.resolveIsChannelOpen() || Boolean(this.signaling.roomBroadcastChannel),
      frame
    );
  }

  shouldSendAdaptiveSnapshot(nowMs = performance.now()): boolean {
    const dc = this.resolveActiveDataChannel();
    const buffered = dc ? dc.bufferedAmount : 0;
    const sim = this.simulator;
    this.pacer.updateNetworkHealth(sim.rttMs || 0, sim.packetLossRate || 0, buffered);
    return this.pacer.shouldSendSnapshot(nowMs, buffered);
  }
}
