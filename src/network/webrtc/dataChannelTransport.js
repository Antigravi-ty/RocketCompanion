/**
 * src/network/webrtc/dataChannelTransport.js
 * RTCDataChannel binding, message framing, ping/pong transport, and simulated dispatching.
 */

import { InputPacketCodec } from '../InputPacketCodec.js';

export class DataChannelTransport {
  /**
   * @param {object} channel
   */
  constructor(channel) {
    this.channel = channel;
  }

  bindDataChannel(dataChannel) {
    const ch = this.channel;
    dataChannel.onopen = () => {
      console.log(`[P2PWebRTCChannel] DataChannel "${dataChannel.label}" OPEN! Handshake complete.`);
      ch.isWebRTC = true;
      ch.isOpen = true;
      ch.transportMode = 'webrtc';
      ch.onConnected?.();
    };

    dataChannel.onclose = () => {
      console.log(`[P2PWebRTCChannel] DataChannel "${dataChannel.label}" CLOSED.`);
      if (ch.isCrossTab) {
        console.log('[P2PWebRTCChannel] DataChannel closed but Cross-Tab transport is active. Maintaining connection.');
        return;
      }
      ch.isOpen = false;
      ch.onDisconnected?.();
    };

    dataChannel.onerror = (err) => {
      console.error('[P2PWebRTCChannel] DataChannel error:', err);
    };

    dataChannel.onmessage = (event) => {
      this.handleIncomingMessage(event.data);
    };
  }

  handleIncomingMessage(data) {
    const ch = this.channel;
    const now = performance.now();
    ch.stats.packetsReceived++;

    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'color_change') {
          console.log(`[P2PWebRTCChannel] Received remote color_change: car ${msg.carIndex} -> slot ${msg.slotId} (${msg.hex})`);
          ch.onColorChange?.(msg);
          return;
        }
        if (msg.type === 'diagnostic_fleet_toggle') {
          ch.onDiagnosticFleetToggle?.(msg.enabled, msg.anchorMode);
          return;
        }
        if (msg.type === 'ping') {
          this.sendPong(msg.sendTime);
          return;
        }
        if (msg.type === 'pong') {
          ch.simulator.handlePong(msg.sendTime);
          return;
        }
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to parse incoming string message as JSON:', err, data);
      }
    }

    if (! data) return;
    ch.simulator.receivePayload(
      data,
      (delivered) => {
        ch.onPacketReceived?.(delivered);
        ch.onMessage?.(delivered);
      },
      now
    );
  }

  sendPong(sendTime) {
    const ch = this.channel;
    const pongMsg = JSON.stringify({ type: 'pong', sendTime });
    if (ch.dataChannel && ch.dataChannel.readyState === 'open') {
      ch.dataChannel.send(pongMsg);
    } else if (ch.roomBroadcastChannel) {
      ch.roomBroadcastChannel.postMessage({ type: 'pong', sendTime });
    }
  }

  send(packet, nowMs = performance.now()) {
    const ch = this.channel;
    return ch.simulator.scheduleSend(
      packet,
      (clonedPacket) => {
        let dispatched = false;
        if (ch.dataChannel && ch.dataChannel.readyState === 'open') {
          try {
            ch.dataChannel.send(clonedPacket);
            dispatched = true;
          } catch (err) {
            console.warn('[P2PWebRTCChannel] DataChannel send failed:', err);
          }
        }
        if (!dispatched && ch.roomBroadcastChannel && ch.isOpen) {
          try {
            ch.roomBroadcastChannel.postMessage(clonedPacket);
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

  sendClientInput(packet, nowMs = performance.now()) {
    const ch = this.channel;
    let buf = packet;
    if (!(packet instanceof Uint8Array) && !(packet instanceof ArrayBuffer) && typeof packet !== 'string') {
      if (packet.history) {
        buf = InputPacketCodec.encode(packet.carIndex ?? 0, packet.targetTick ?? packet.tick, packet.history);
      } else if (packet.controls) {
        buf = InputPacketCodec.encode(packet.carIndex ?? 0, packet.tick, [{ tick: packet.tick, controls: packet.controls }]);
      }
    }
    const sent = this.send(buf, nowMs);
    if (nowMs - ch.lastPingSentTime > ch.pingIntervalMs) {
      ch.lastPingSentTime = nowMs;
      ch.stats.pingsSent++;
      this.send(JSON.stringify({ type: 'ping', sendTime: nowMs, rtt: Math.round(ch.rttMs) }), nowMs);
    }
    return sent;
  }

  sendColorChange(slotId, hex, carIndex) {
    const ch = this.channel;
    ch.localColorSlot = slotId;
    ch.localColorHex = hex;
    const payload = JSON.stringify({ type: 'color_change', slotId, hex, carIndex });
    if (!ch.isOpen && (!ch.dataChannel || ch.dataChannel.readyState !== 'open') && !ch.roomBroadcastChannel) {
      ch.pendingColorChange = { slotId, hex, carIndex };
    }
    if (ch.dataChannel && ch.dataChannel.readyState === 'open') {
      try {
        ch.dataChannel.send(payload);
        console.log(`[P2PWebRTCChannel] Sent color_change via DataChannel: slot ${slotId} (${hex}) for car ${carIndex}`);
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to send color change via DataChannel:', err);
      }
    }
    if (ch.roomBroadcastChannel) {
      try {
        ch.roomBroadcastChannel.postMessage({ type: 'color_change', slotId, hex, carIndex });
        console.log(`[P2PWebRTCChannel] Sent color_change via RoomChannel: slot ${slotId} (${hex}) for car ${carIndex}`);
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to send color change via RoomChannel:', err);
      }
    }
  }

  sendDiagnosticFleetToggle(enabled, anchorMode) {
    const ch = this.channel;
    const payload = JSON.stringify({ type: 'diagnostic_fleet_toggle', enabled: Boolean(enabled), anchorMode });
    if (ch.dataChannel && ch.dataChannel.readyState === 'open') {
      try {
        ch.dataChannel.send(payload);
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to send diagnostic_fleet_toggle via DataChannel:', err);
      }
    }
    if (ch.roomBroadcastChannel) {
      try {
        ch.roomBroadcastChannel.postMessage({ type: 'diagnostic_fleet_toggle', enabled: Boolean(enabled), anchorMode });
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to send diagnostic_fleet_toggle via RoomChannel:', err);
      }
    }
  }
}
