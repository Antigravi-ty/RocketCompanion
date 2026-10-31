/**
 * src/network/transport/ClientSessionController.js
 * Headless Client Session Controller for managing WebRTC P2P client joining,
 * encrypted offer handling, and downstream P2P spectator daisy-chaining.
 */

import { P2PWebRTCChannel } from './P2PWebRTCChannel.js';
import {
  loadActiveHostOffer,
  getAllowSpectatorDaisyChain,
} from '../../ui-core/config/signalingConfig.js';
import {
  CommittedFrameDaisyChainBuffer,
  DEFAULT_COMMITTED_ROLLBACK_WINDOW_MS,
} from './SpectatorDaisyChainCoordinator.js';

export class ClientSessionController {
  constructor(options, callbacks = {}) {
    this.roomId = options.roomId;
    this.playerName = options.playerName;
    this.colorSlot = options.colorSlot ?? 0;
    this.colorHex = options.colorHex ?? '#ff7043';
    this.allowSpectatorRelay = options.allowSpectatorRelay ?? getAllowSpectatorDaisyChain();
    this.callbacks = callbacks;

    this.channel = null;
    this.pairingCode = null;
    this.answerToken = '';
    this._isProcessingOffer = false;

    this.downstreamSpectatorChannels = new Map();
    this.committedDaisyChainBuffer = new CommittedFrameDaisyChainBuffer(
      options.rollbackCommitWindowMs ?? DEFAULT_COMMITTED_ROLLBACK_WINDOW_MS
    );
  }

  async initializeChannel() {
    this.cleanup();

    this.channel = new P2PWebRTCChannel({
      role: 'client',
      roomId: this.roomId,
      playerName: this.playerName,
      colorSlot: this.colorSlot,
      colorHex: this.colorHex,
      extraLatencyMs: 0,
    });

    this.channel._initRoomChannel(this.roomId);

    this.channel.onConnected = async () => {
      const peerName = this.channel.peerName || 'Host';
      if (this.callbacks.onConnected) {
        await this.callbacks.onConnected(this.channel, peerName, this.pairingCode);
      }
    };

    this.channel.onDisconnected = () => {
      this.callbacks.onDisconnected?.();
    };

    this.channel.onIceCandidate = (cand) => {
      this.callbacks.onIceCandidate?.(cand);
    };

    this.channel._sendRoomMessage({
      type: 'cross_tab_join',
      clientName: this.playerName,
      clientColorSlot: this.colorSlot,
      clientColorHex: this.colorHex,
    });

    this._checkLocalStorageOffer();

    return this.channel;
  }

  _checkLocalStorageOffer() {
    try {
      const hostInfo = loadActiveHostOffer();
      if (hostInfo && hostInfo.roomId === this.roomId && hostInfo.token) {
        this.channel.acceptOfferAndCreateAnswer(hostInfo.token, {
          clientColorSlot: this.colorSlot,
          clientColorHex: this.colorHex,
        }).then((answer) => {
          this.answerToken = answer;
          this.channel._sendRoomMessage({
            type: 'room_answer',
            sdp: answer,
            roomId: this.roomId,
            clientName: this.playerName,
          });
        }).catch((err) => {
          console.warn('[ClientSessionController] Failed to ingest local active host offer:', err);
        });
      }
    } catch (e) {
      console.warn('[ClientSessionController] Error checking local active host:', e);
    }
  }

  async handleOffer(sdp, fromPeerId, signalingClient, metadata = {}) {
    if (this.channel?.isOpen) return;
    if (this._isProcessingOffer) return;

    this._isProcessingOffer = true;
    try {
      if (metadata.pairingCode) {
        this.pairingCode = metadata.pairingCode;
        if (this.channel) {
          this.channel.pairingCode = metadata.pairingCode;
        }
      }

      if (this.channel?.connected && this.answerToken) {
        signalingClient?.sendAnswer(this.answerToken, fromPeerId || null);
        return;
      }

      const answer = await this.channel.acceptOfferAndCreateAnswer(sdp, {
        clientColorSlot: this.colorSlot,
        clientColorHex: this.colorHex,
      });

      signalingClient?.sendAnswer(answer, fromPeerId || null);
      this.answerToken = answer;
    } catch (err) {
      console.error('[ClientSessionController] Failed to accept host offer:', err);
      throw err;
    } finally {
      this._isProcessingOffer = false;
    }
  }

  handleRemoteCandidate(candidate) {
    if (candidate && this.channel) {
      this.channel.addIceCandidate(candidate);
    }
  }

  async acceptDownstreamSpectatorPeer(spectatorPeerId, spectatorName, signalingClient) {
    if (!this.allowSpectatorRelay || !spectatorPeerId || !signalingClient) return null;
    let specChannel = this.downstreamSpectatorChannels.get(spectatorPeerId);
    if (!specChannel) {
      specChannel = new P2PWebRTCChannel({
        role: 'host',
        roomId: this.roomId,
        playerName: this.playerName,
        colorSlot: this.colorSlot,
        colorHex: this.colorHex,
      });
      specChannel.peerId = spectatorPeerId;
      specChannel.peerName = spectatorName || 'Spectator';
      specChannel.peerRole = 'spectator';
      specChannel.onDisconnected = () => {
        this.downstreamSpectatorChannels.delete(spectatorPeerId);
      };
      specChannel.onIceCandidate = (cand) => {
        signalingClient.sendCandidate(spectatorPeerId, cand);
      };
      this.downstreamSpectatorChannels.set(spectatorPeerId, specChannel);
    }

    const offerToken = await specChannel.createOfferToken({
      roomId: this.roomId,
      hostColorSlot: this.colorSlot,
      hostColorHex: this.colorHex,
    });
    if (offerToken) {
      await signalingClient.sendOffer(spectatorPeerId, offerToken);
    }
    return specChannel;
  }

  forwardCommittedSnapshotToSpectators(packetBuffer, serverTick = 0, nowMs = performance.now()) {
    if (!this.allowSpectatorRelay || this.downstreamSpectatorChannels.size === 0) return;
    this.committedDaisyChainBuffer.enqueueVerifiedSnapshot(packetBuffer, serverTick, nowMs);
    const committedList = this.committedDaisyChainBuffer.drainCommittedSnapshots(nowMs);
    if (committedList.length === 0) return;

    for (const item of committedList) {
      for (const specChannel of this.downstreamSpectatorChannels.values()) {
        if (specChannel.connected || specChannel.isOpen) {
          specChannel.send(item.packetBuffer, nowMs);
        }
      }
    }
  }

  sendReadyAck(ready = true) {
    if (this.channel && (this.channel.connected || this.channel.isOpen)) {
      this.channel.send(JSON.stringify({
        type: 'match_ready_ack',
        ready: Boolean(ready),
        playerName: this.playerName,
        timestamp: Date.now(),
      }));
    }
  }

  sendArenaLoadedAck(matchSeq = 0) {
    if (this.channel && (this.channel.connected || this.channel.isOpen)) {
      this.channel.send(JSON.stringify({
        type: 'arena_loaded_ack',
        ready: true,
        matchSeq,
        playerName: this.playerName,
        timestamp: Date.now(),
      }));
    }
  }

  cleanup() {
    this._isProcessingOffer = false;
    this.pairingCode = null;
    this.committedDaisyChainBuffer.clear();
    for (const specChannel of this.downstreamSpectatorChannels.values()) {
      try {
        specChannel.destroy();
      } catch (_) {}
    }
    this.downstreamSpectatorChannels.clear();
    if (this.channel) {
      try {
        this.channel.destroy();
      } catch (err) {
        console.warn('[ClientSessionController] Error destroying channel:', err);
      }
      this.channel = null;
    }
    this.answerToken = '';
  }
}
