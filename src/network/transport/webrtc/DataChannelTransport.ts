/**
 * DataChannelTransport.ts
 * RTCDataChannel binding, message framing, ping/pong transport, and simulated dispatching.
 */

import { InputPacketCodec } from '../../protocol/InputPacketCodec.ts';
import type { NetworkSimulator } from './NetworkSimulator.ts';
import type { CrossTabSignaling } from './CrossTabSignaling.ts';

export interface DataChannelTransportPort {
  simulator: NetworkSimulator;
  signaling: CrossTabSignaling;
  getDataChannel: () => RTCDataChannel | null;
  setDataChannel: (channel: RTCDataChannel | null) => void;
  isChannelOpen: () => boolean;
  isCrossTabActive: () => boolean;
  onWebRTCDataChannelOpen: () => void;
  onWebRTCDataChannelClosed: () => void;
  onLocalColorUpdated: (
    slotId: number,
    hex: string,
    pendingIfClosed?: { slotId: number; hex: string; carIndex: number }
  ) => void;
  onColorChange: (msg: any) => void;
  onDiagnosticFleetToggle: (enabled: boolean, anchorMode: string) => void;
  onPacketDelivered: (data: any) => void;
}

export class DataChannelTransport {
  private readonly port: DataChannelTransportPort;

  constructor(port: DataChannelTransportPort) {
    this.port = port;
  }

  bindDataChannel(dataChannel: RTCDataChannel): void {
    this.port.setDataChannel(dataChannel);
    dataChannel.onopen = () => {
      console.log(
        `[P2PWebRTCChannel] DataChannel "${dataChannel.label}" OPEN! Handshake complete.`
      );
      this.port.onWebRTCDataChannelOpen();
    };

    dataChannel.onclose = () => {
      console.log(`[P2PWebRTCChannel] DataChannel "${dataChannel.label}" CLOSED.`);
      if (this.port.isCrossTabActive()) {
        console.log(
          '[P2PWebRTCChannel] DataChannel closed but Cross-Tab transport is active. Maintaining connection.'
        );
        return;
      }
      this.port.onWebRTCDataChannelClosed();
    };

    dataChannel.onerror = (err) => {
      console.error('[P2PWebRTCChannel] DataChannel error:', err);
    };

    dataChannel.onmessage = (event) => {
      this.handleIncomingMessage(event.data);
    };
  }

  handleIncomingMessage(data: any): void {
    const sim = this.port.simulator;
    const now = performance.now();
    sim.stats.packetsReceived++;

    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'color_change') {
          console.log(
            `[P2PWebRTCChannel] Received remote color_change: car ${msg.carIndex} -> slot ${msg.slotId} (${msg.hex})`
          );
          this.port.onColorChange(msg);
          return;
        }
        if (msg.type === 'diagnostic_fleet_toggle') {
          this.port.onDiagnosticFleetToggle(msg.enabled, msg.anchorMode);
          return;
        }
        if (msg.type === 'ping') {
          this.sendPong(msg.sendTime);
          if (typeof msg.rtt === 'number' && Number.isFinite(msg.rtt) && msg.rtt > 0) {
            sim.measuredRttMs = msg.rtt;
            sim.baseMeasuredRttMs = Math.max(0, msg.rtt - (sim.extraRttMs || 0));
            sim.rttMs = msg.rtt;
          }
          this.port.onPacketDelivered(data);
          return;
        }
        if (msg.type === 'pong') {
          sim.handlePong(msg.sendTime);
          return;
        }
      } catch (err) {
        console.warn(
          '[P2PWebRTCChannel] Failed to parse incoming string message as JSON:',
          err,
          data
        );
      }
    }

    if (!data) return;
    sim.receivePayload(
      data,
      (delivered) => {
        this.port.onPacketDelivered(delivered);
      },
      now
    );
  }

  sendPong(sendTime: number): void {
    const dc = this.port.getDataChannel();
    const roomChannel = this.port.signaling.roomBroadcastChannel;
    const pongMsg = JSON.stringify({ type: 'pong', sendTime });
    if (dc && dc.readyState === 'open') {
      dc.send(pongMsg);
    } else if (roomChannel) {
      roomChannel.postMessage({ type: 'pong', sendTime });
    }
  }

  send(packet: any, nowMs = performance.now()): boolean {
    const sim = this.port.simulator;
    const dc = this.port.getDataChannel();
    const roomChannel = this.port.signaling.roomBroadcastChannel;
    const isOpen = this.port.isChannelOpen();

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
      if (dc && dc.readyState === 'open') {
        try {
          dc.send(pingPayload);
        } catch (_err) {
          // Ignore ping error
        }
      } else if (roomChannel && isOpen) {
        try {
          roomChannel.postMessage(pingPayload);
        } catch (_err) {
          // Ignore ping error
        }
      }
    }
    return sim.scheduleSend(
      packet,
      (clonedPacket) => {
        let dispatched = false;
        const activeDc = this.port.getDataChannel();
        const activeRoomChannel = this.port.signaling.roomBroadcastChannel;
        if (activeDc && activeDc.readyState === 'open') {
          try {
            activeDc.send(clonedPacket);
            dispatched = true;
          } catch (err) {
            console.warn('[P2PWebRTCChannel] DataChannel send failed:', err);
          }
        }
        if (!dispatched && activeRoomChannel && this.port.isChannelOpen()) {
          try {
            activeRoomChannel.postMessage(clonedPacket);
            dispatched = true;
          } catch (err) {
            console.warn('[P2PWebRTCChannel] RoomChannel send failed:', err);
          }
        }
        return dispatched;
      },
      nowMs
    );
  }

  sendClientInput(packet: any, nowMs = performance.now()): boolean {
    const sim = this.port.simulator;
    let buf = packet;
    if (
      !(packet instanceof Uint8Array) &&
      !(packet instanceof ArrayBuffer) &&
      typeof packet !== 'string'
    ) {
      if (packet.history) {
        buf = InputPacketCodec.encode(
          packet.carIndex ?? 0,
          packet.targetTick ?? packet.tick,
          packet.history
        );
      } else if (packet.controls) {
        buf = InputPacketCodec.encode(packet.carIndex ?? 0, packet.tick, [
          { tick: packet.tick, controls: packet.controls },
        ]);
      }
    }
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
    const dc = this.port.getDataChannel();
    const roomChannel = this.port.signaling.roomBroadcastChannel;
    const isClosed =
      !this.port.isChannelOpen() && (!dc || dc.readyState !== 'open') && !roomChannel;
    this.port.onLocalColorUpdated(slotId, hex, isClosed ? { slotId, hex, carIndex } : undefined);
    const payload = JSON.stringify({ type: 'color_change', slotId, hex, carIndex });
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(payload);
        console.log(
          `[P2PWebRTCChannel] Sent color_change via DataChannel: slot ${slotId} (${hex}) for car ${carIndex}`
        );
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to send color change via DataChannel:', err);
      }
    }
    if (roomChannel) {
      try {
        roomChannel.postMessage({ type: 'color_change', slotId, hex, carIndex });
        console.log(
          `[P2PWebRTCChannel] Sent color_change via RoomChannel: slot ${slotId} (${hex}) for car ${carIndex}`
        );
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to send color change via RoomChannel:', err);
      }
    }
  }

  sendDiagnosticFleetToggle(enabled: boolean, anchorMode: string): void {
    const dc = this.port.getDataChannel();
    const roomChannel = this.port.signaling.roomBroadcastChannel;
    const payload = JSON.stringify({
      type: 'diagnostic_fleet_toggle',
      enabled: Boolean(enabled),
      anchorMode,
    });
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(payload);
      } catch (err) {
        console.warn(
          '[P2PWebRTCChannel] Failed to send diagnostic_fleet_toggle via DataChannel:',
          err
        );
      }
    }
    if (roomChannel) {
      try {
        roomChannel.postMessage({
          type: 'diagnostic_fleet_toggle',
          enabled: Boolean(enabled),
          anchorMode,
        });
      } catch (err) {
        console.warn(
          '[P2PWebRTCChannel] Failed to send diagnostic_fleet_toggle via RoomChannel:',
          err
        );
      }
    }
  }
}
