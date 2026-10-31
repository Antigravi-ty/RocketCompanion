/**
 * src/network/webrtc/crossTabSignaling.js
 * BroadcastChannel signaling layer for cross-tab discovery and 120Hz native local data exchange.
 */

export class CrossTabSignaling {
  /**
   * @param {object} [options]
   * @param {string} [options.signalingChannelName='online_discovery']
   * @param {string} [options.roomId]
   * @param {Function} [options.onBroadcastMessage]
   * @param {Function} [options.onRoomMessage]
   */
  constructor(options = {}) {
    this.signalingChannelName = options.signalingChannelName || 'online_discovery';
    this.roomId = options.roomId || null;
    this.onBroadcastMessage = options.onBroadcastMessage || null;
    this.onRoomMessage = options.onRoomMessage || null;

    this.broadcastChannel = null;
    this.roomBroadcastChannel = null;

    this.initSignalingChannel(this.signalingChannelName);
    if (this.roomId) {
      this.initRoomChannel(this.roomId);
    }
  }

  initSignalingChannel(channelName) {
    if (typeof BroadcastChannel === 'undefined' || !channelName) return;
    this.signalingChannelName = channelName;
    try {
      if (this.broadcastChannel) {
        this.broadcastChannel.close();
      }
      this.broadcastChannel = new BroadcastChannel(channelName);
      if (typeof this.broadcastChannel.unref === 'function') this.broadcastChannel.unref();
      this.broadcastChannel.onmessage = (e) => {
        this.onBroadcastMessage?.(e.data);
      };
    } catch (err) {
      console.warn('[P2PWebRTCChannel] BroadcastChannel unavailable:', err);
    }
  }

  initRoomChannel(roomId) {
    if (!roomId || typeof BroadcastChannel === 'undefined') return;
    const targetName = 'p2p_room_' + roomId;
    if (this.roomBroadcastChannel && this.roomBroadcastChannel.name === targetName) {
      return;
    }
    try {
      if (this.roomBroadcastChannel) {
        this.roomBroadcastChannel.close();
      }
      this.roomId = roomId;
      this.roomBroadcastChannel = new BroadcastChannel(targetName);
      this.roomBroadcastChannel.onmessage = (e) => {
        this.onRoomMessage?.(e.data);
      };
      console.log(`[P2PWebRTCChannel] Room BroadcastChannel attached: p2p_room_${roomId}`);
    } catch (err) {
      console.warn('[P2PWebRTCChannel] Could not create room BroadcastChannel:', err);
    }
  }

  sendRoomMessage(msg, peerId = null) {
    if (this.roomBroadcastChannel) {
      try {
        const payload = typeof msg === 'object' && msg !== null && !(msg instanceof Uint8Array) && !(msg instanceof ArrayBuffer)
          ? { ...(peerId ? { senderId: peerId } : {}), ...msg }
          : msg;
        this.roomBroadcastChannel.postMessage(payload);
        return true;
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to post room message:', err);
      }
    }
    return false;
  }

  broadcastSignal(type, payload = {}, context = {}) {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type,
          roomId: context.roomId || this.roomId,
          senderRole: context.role || 'client',
          senderName: context.playerName || 'Player',
          timestamp: Date.now(),
          ...payload
        });
        return true;
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to post message to broadcast channel:', err);
      }
    }
    return false;
  }

  closeRoomChannel() {
    if (this.roomBroadcastChannel) {
      try { this.roomBroadcastChannel.close(); } catch (err) {
        console.warn('[P2PWebRTCChannel] Error closing roomBroadcastChannel:', err);
      }
      this.roomBroadcastChannel = null;
    }
  }

  destroy() {
    this.closeRoomChannel();
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch (err) {
        console.warn('[P2PWebRTCChannel] Error closing broadcastChannel:', err);
      }
      this.broadcastChannel = null;
    }
  }
}
