/**
 * src/network/webrtc/handshakeSession.js
 * Signaling handshake orchestration, token generation, and room message dispatching.
 */

import { encodeSignalToken, decodeSignalToken } from './SignalTokenCodec.js';

export class HandshakeSession {
  /**
   * @param {object} channel
   */
  constructor(channel) {
    this.channel = channel;
    this.lastProcessedOfferToken = null;
    this.currentAnswerToken = null;
    this._acceptOfferPromise = null;
  }

  async createOfferToken(options = {}) {
    const ch = this.channel;
    ch.role = 'host';
    if (options.hostColorSlot !== undefined) ch.localColorSlot = options.hostColorSlot;
    if (options.hostColorHex !== undefined) ch.localColorHex = options.hostColorHex;
    ch.roomId = options.roomId || ('room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
    ch._initRoomChannel(ch.roomId);

    ch.createPeerConnection();
    let sdp = '';
    if (ch.pc) {
      ch.dataChannel = ch.pc.createDataChannel('game_net', { ordered: false, maxRetransmits: 0 });
      ch.dataChannel.binaryType = 'arraybuffer';
      ch._bindDataChannel(ch.dataChannel);
      sdp = await ch.connection.createOfferDescription();
    }

    const payload = {
      type: 'offer',
      roomId: ch.roomId,
      sdp,
      candidates: ch.localCandidates,
      hostName: ch.playerName,
      hostColorSlot: ch.localColorSlot,
      hostColorHex: ch.localColorHex,
      version: 2
    };

    const token = 'RL_OFFER_' + encodeSignalToken(payload);
    ch.offerToken = token;
    console.log(`[P2PWebRTCChannel] Host offer token created (${token.length} chars). Room: ${ch.roomId}, Color: slot ${ch.localColorSlot} (${ch.localColorHex})`);

    ch.broadcastSignal('room_offer', {
      token,
      roomId: ch.roomId,
      hostName: ch.playerName,
      hostColorSlot: ch.localColorSlot,
      hostColorHex: ch.localColorHex
    });
    return token;
  }

  async acceptOfferAndCreateAnswer(offerToken, options = {}) {
    const ch = this.channel;
    if (this.lastProcessedOfferToken === offerToken && this.currentAnswerToken) {
      return this.currentAnswerToken;
    }
    if (this._acceptOfferPromise) {
      return this._acceptOfferPromise;
    }

    this._acceptOfferPromise = (async () => {
      ch.role = 'client';
      if (options.clientColorSlot !== undefined) ch.localColorSlot = options.clientColorSlot;
      if (options.clientColorHex !== undefined) ch.localColorHex = options.clientColorHex;

      const offerData = decodeSignalToken(offerToken);
      if (!offerData || offerData.type !== 'offer') {
        throw new Error('Invalid offer token: expected offer payload');
      }

      ch.roomId = offerData.roomId || null;
      ch.peerName = offerData.hostName || 'Host';
      if (offerData.hostColorHex) {
        ch.peerColorHex = offerData.hostColorHex;
        ch.peerColorSlot = offerData.hostColorSlot;
      }

      if (ch.roomId) {
        ch._initRoomChannel(ch.roomId);
        ch._sendRoomMessage({
          type: 'cross_tab_join',
          clientName: ch.playerName,
          clientColorSlot: ch.localColorSlot,
          clientColorHex: ch.localColorHex
        });
      }

      ch.connection.options.onDataChannel = (event) => {
        console.log('[P2PWebRTCChannel] Client accepted dataChannel from Host');
        ch.dataChannel = event.channel;
        ch.dataChannel.binaryType = 'arraybuffer';
        ch._bindDataChannel(ch.dataChannel);
      };
      ch.createPeerConnection();

      const sdp = await ch.connection.applyRemoteOfferAndCreateAnswer(offerData);
      const payload = {
        type: 'answer',
        roomId: ch.roomId,
        sdp,
        candidates: ch.localCandidates,
        clientName: ch.playerName,
        clientColorSlot: ch.localColorSlot,
        clientColorHex: ch.localColorHex,
        version: 2
      };

      const token = 'RL_ANSWER_' + encodeSignalToken(payload);
      console.log(`[P2PWebRTCChannel] Client answer token created (${token.length} chars). Candidates: ${ch.localCandidates.length}`);
      ch.broadcastSignal('room_answer', {
        token,
        answerToken: token,
        roomId: ch.roomId,
        clientName: ch.playerName,
        clientColorSlot: ch.localColorSlot,
        clientColorHex: ch.localColorHex
      });

      this.lastProcessedOfferToken = offerToken;
      this.currentAnswerToken = token;
      return token;
    })();

    try {
      return await this._acceptOfferPromise;
    } finally {
      this._acceptOfferPromise = null;
    }
  }

  async acceptAnswerToken(answerToken) {
    const ch = this.channel;
    if (ch.pc && ch.pc.signalingState === 'stable') {
      console.log('[P2PWebRTCChannel] Signaling state is already stable, answer description was already set.');
      return;
    }

    const answerData = decodeSignalToken(answerToken);
    if (!answerData || answerData.type !== 'answer') {
      throw new Error('Invalid answer token: expected answer payload');
    }

    ch.peerName = answerData.clientName || 'Player 2';
    if (answerData.clientColorHex) {
      ch.peerColorHex = answerData.clientColorHex;
      ch.peerColorSlot = answerData.clientColorSlot;
    }
    if (answerData.roomId && !ch.roomId) {
      ch._initRoomChannel(answerData.roomId);
    }

    ch._sendRoomMessage({
      type: 'cross_tab_ack',
      hostName: ch.playerName,
      hostColorSlot: ch.localColorSlot,
      hostColorHex: ch.localColorHex
    });

    if (!ch.pc) return;
    if (ch.pc.signalingState === 'stable') {
      console.log('[P2PWebRTCChannel] Signaling state is already stable, answer description was already set.');
      return;
    }

    console.log(`[P2PWebRTCChannel] Setting remote answer SDP from ${ch.peerName}...`);
    await ch.connection.applyRemoteAnswer(answerData);
    console.log('[P2PWebRTCChannel] Remote answer SDP applied. Signaling state:', ch.pc.signalingState);
  }

  handleRoomMessage(data) {
    const ch = this.channel;
    if (!data) return;

    if (data instanceof Uint8Array || data instanceof ArrayBuffer || typeof data === 'string') {
      ch._handleIncomingMessage(data);
      return;
    }

    if (typeof data !== 'object') return;
    if (data.senderId && data.senderId === ch.peerId) return;

    if (data.type === 'cross_tab_join') {
      if (!ch.isHost || ch.role === 'client') return;
      console.log(`[P2PWebRTCChannel] Host received cross_tab_join from "${data.clientName}" (Color: slot ${data.clientColorSlot} ${data.clientColorHex})`);
      ch.peerName = data.clientName || 'Player 2';
      ch.peerColorSlot = data.clientColorSlot;
      ch.peerColorHex = data.clientColorHex;
      ch.isCrossTab = true;
      ch.transportMode = 'crosstab';
      const wasOpen = ch.isOpen;
      ch.isOpen = true;

      ch._sendRoomMessage({
        type: 'cross_tab_ack',
        senderId: ch.peerId,
        hostName: ch.playerName,
        hostColorSlot: ch.localColorSlot,
        hostColorHex: ch.localColorHex,
        offerToken: ch.offerToken
      });

      if (!wasOpen) queueMicrotask(() => ch.onConnected?.());
      return;
    }

    if (data.type === 'cross_tab_ack') {
      if (ch.isHost || ch.role !== 'client') return;
      console.log(`[P2PWebRTCChannel] Client received cross_tab_ack from Host "${data.hostName}" (Color: slot ${data.hostColorSlot} ${data.hostColorHex})`);
      ch.peerName = data.hostName || 'Host';
      ch.peerColorSlot = data.hostColorSlot;
      ch.peerColorHex = data.hostColorHex;
      ch.isCrossTab = true;
      ch.transportMode = 'crosstab';
      const wasOpen = ch.isOpen;
      ch.isOpen = true;

      if (data.offerToken && !ch.answerToken && !ch.pc?.currentRemoteDescription) {
        this.acceptOfferAndCreateAnswer(data.offerToken).then(ans => {
          ch._sendRoomMessage({
            type: 'room_answer',
            senderId: ch.peerId,
            sdp: ans,
            clientName: ch.playerName
          });
        }).catch(err => {
          console.error('[P2PWebRTCChannel] Failed to accept offer & create answer in room message:', err);
        });
      }

      if (!wasOpen) queueMicrotask(() => ch.onConnected?.());
      return;
    }

    if (data.type === 'room_answer' && ch.isHost && ch.role === 'host' && data.sdp) {
      console.log(`[P2PWebRTCChannel] Host received room_answer via BroadcastChannel from ${data.clientName || 'Client'}`);
      this.acceptAnswerToken(data.sdp).catch(err => {
        console.warn('[P2PWebRTCChannel] Failed to accept room_answer:', err);
      });
      return;
    }

    if (data.type === 'color_change') {
      console.log(`[P2PWebRTCChannel] Received cross-tab color_change: car ${data.carIndex} -> slot ${data.slotId} (${data.hex})`);
      ch.onColorChange?.(data);
      return;
    }

    if (data.type === 'ping') {
      ch._sendPong(data.sendTime);
      return;
    }

    if (data.type === 'pong') {
      ch._handlePong(data.sendTime);
      return;
    }

    if (data.type === 'p2p_packet' && data.buffer) {
      ch._handleIncomingMessage(data.buffer);
    }
  }

  handleBroadcastMessage(msg) {
    const ch = this.channel;
    if (!msg || !msg.type) return;
    if (msg.senderRole === ch.role && msg.senderName === ch.playerName) return;

    if (msg.type === 'ice_candidate' && msg.candidate) {
      if (!msg.roomId || msg.roomId === ch.roomId) {
        ch.addRemoteCandidate(msg.candidate);
      }
    }

    ch.onBroadcastSignal?.(msg);
  }
}
