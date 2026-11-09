/**
 * CrossTabSignaling.ts
 * BroadcastChannel signaling layer for cross-tab discovery and 120Hz native local data exchange.
 */

export interface CrossTabSignalingHandler {
  handleBroadcastMessage(data: Record<string, unknown>): void;
  handleRoomMessage(data: Record<string, unknown> | Uint8Array | ArrayBuffer | string): void;
}

export interface CrossTabSignalingOptions {
  signalingChannelName?: string;
  roomId?: string | null;
  handler?: CrossTabSignalingHandler | null;
}

export interface BroadcastSignalContext {
  roomId?: string | null;
  role?: string;
  playerName?: string;
}

export class CrossTabSignaling {
  signalingChannelName: string;
  roomId: string | null;
  handler: CrossTabSignalingHandler | null;
  broadcastChannel: BroadcastChannel | null = null;
  roomBroadcastChannel: BroadcastChannel | null = null;

  constructor(options: CrossTabSignalingOptions = {}) {
    this.signalingChannelName = options.signalingChannelName || 'online_discovery';
    this.roomId = options.roomId || null;
    this.handler = options.handler || null;

    this.initSignalingChannel(this.signalingChannelName);
    if (this.roomId) {
      this.initRoomChannel(this.roomId);
    }
  }

  initSignalingChannel(channelName: string): void {
    if (typeof BroadcastChannel === 'undefined' || !channelName) return;
    this.signalingChannelName = channelName;
    try {
      if (this.broadcastChannel) {
        this.broadcastChannel.close();
      }
      this.broadcastChannel = new BroadcastChannel(channelName);
      const unrefFn = (this.broadcastChannel as BroadcastChannel & { unref?: () => void }).unref;
      if (typeof unrefFn === 'function') {
        unrefFn.call(this.broadcastChannel);
      }
      this.broadcastChannel.onmessage = (e) => {
        this.handler?.handleBroadcastMessage(e.data);
      };
    } catch (err) {
      console.warn('[P2PWebRTCChannel] BroadcastChannel unavailable:', err);
    }
  }

  initRoomChannel(roomId: string | null): void {
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
        this.handler?.handleRoomMessage(e.data);
      };
      console.log(`[P2PWebRTCChannel] Room BroadcastChannel attached: p2p_room_${roomId}`);
    } catch (err) {
      console.warn('[P2PWebRTCChannel] Could not create room BroadcastChannel:', err);
    }
  }

  sendRoomMessage(
    msg: Record<string, unknown> | Uint8Array | ArrayBuffer | string,
    peerId: string | null = null
  ): boolean {
    if (this.roomBroadcastChannel) {
      try {
        const payload =
          typeof msg === 'object' &&
          msg !== null &&
          !(msg instanceof Uint8Array) &&
          !(msg instanceof ArrayBuffer)
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

  broadcastSignal(
    type: string,
    payload: Record<string, unknown> = {},
    context: BroadcastSignalContext = {}
  ): boolean {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type,
          roomId: context.roomId || this.roomId,
          senderRole: context.role || 'client',
          senderName: context.playerName || 'Player',
          timestamp: Date.now(),
          ...payload,
        });
        return true;
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to post message to broadcast channel:', err);
      }
    }
    return false;
  }

  closeRoomChannel(): void {
    if (this.roomBroadcastChannel) {
      try {
        this.roomBroadcastChannel.close();
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Error closing roomBroadcastChannel:', err);
      }
      this.roomBroadcastChannel = null;
    }
  }

  destroy(): void {
    this.closeRoomChannel();
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Error closing broadcastChannel:', err);
      }
      this.broadcastChannel = null;
    }
  }
}
