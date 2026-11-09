/**
 * HandshakeSession.ts
 * Signaling handshake orchestration, token generation, and room message dispatching.
 */

import { encodeSignalToken, decodeSignalToken } from './SignalTokenCodec.ts';
import type { WebRTCConnection } from './WebRTCConnection.ts';
import type { CrossTabSignaling } from './CrossTabSignaling.ts';
import type { NetworkSimulator } from './NetworkSimulator.ts';

export interface HandshakeMetadataState {
  role: string;
  isHost?: boolean;
  peerId: string | null;
  playerName: string;
  roomId: string | null;
  localColorSlot: number;
  localColorHex: string;
  peerName: string | null;
  peerColorSlot: number | null;
  peerColorHex: string | null;
  offerToken: string;
  answerToken: string;
  isOpen: boolean;
}

export interface HandshakeSessionPort {
  connection: WebRTCConnection;
  signaling: CrossTabSignaling;
  simulator: NetworkSimulator;
  getState: () => HandshakeMetadataState;
  applyHandshakeState: (patch: Partial<HandshakeMetadataState>) => void;
  activateCrossTabTransport: (peerPatch: {
    peerName: string;
    peerColorSlot: number | null;
    peerColorHex: string | null;
  }) => void;
  bindDataChannel: (channel: RTCDataChannel) => void;
  handleIncomingMessage: (data: any) => void;
  sendPong: (sendTime: number) => void;
  onColorChange: (msg: any) => void;
  onBroadcastSignal: (msg: any) => void;
}

export class HandshakeSession {
  private readonly port: HandshakeSessionPort;
  lastProcessedOfferToken: string | null = null;
  currentAnswerToken: string | null = null;
  private acceptOfferPromise: Promise<string> | null = null;

  constructor(port: HandshakeSessionPort) {
    this.port = port;
  }

  async createOfferToken(
    options: { roomId?: string; hostColorSlot?: number; hostColorHex?: string } = {}
  ): Promise<string> {
    const prev = this.port.getState();
    const roomId =
      options.roomId ||
      'room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const localColorSlot = options.hostColorSlot ?? prev.localColorSlot;
    const localColorHex = options.hostColorHex ?? prev.localColorHex;

    this.port.applyHandshakeState({
      role: 'host',
      roomId,
      localColorSlot,
      localColorHex,
    });
    this.port.signaling.initRoomChannel(roomId);

    const pc = this.port.connection.createPeerConnection();
    let sdp = '';
    if (pc) {
      const dc = pc.createDataChannel('game_net', {
        ordered: false,
        maxRetransmits: 0,
      });
      dc.binaryType = 'arraybuffer';
      this.port.bindDataChannel(dc);
      sdp = await this.port.connection.createOfferDescription();
    }

    const state = this.port.getState();
    const payload = {
      type: 'offer',
      roomId: state.roomId,
      sdp,
      candidates: this.port.connection.localCandidates,
      hostName: state.playerName,
      hostColorSlot: state.localColorSlot,
      hostColorHex: state.localColorHex,
      version: 2,
    };

    const token = 'RL_OFFER_' + encodeSignalToken(payload);
    this.port.applyHandshakeState({ offerToken: token });
    console.log(
      `[P2PWebRTCChannel] Host offer token created (${token.length} chars). Room: ${state.roomId}, Color: slot ${state.localColorSlot} (${state.localColorHex})`
    );

    this.port.signaling.broadcastSignal(
      'room_offer',
      {
        token,
        roomId: state.roomId,
        hostName: state.playerName,
        hostColorSlot: state.localColorSlot,
        hostColorHex: state.localColorHex,
      },
      {
        roomId: state.roomId,
        role: state.role,
        playerName: state.playerName,
      }
    );
    return token;
  }

  async acceptOfferAndCreateAnswer(
    offerToken: string,
    options: { clientColorSlot?: number; clientColorHex?: string } = {}
  ): Promise<string> {
    if (this.lastProcessedOfferToken === offerToken && this.currentAnswerToken) {
      return this.currentAnswerToken;
    }
    if (this.acceptOfferPromise) {
      return this.acceptOfferPromise;
    }

    this.acceptOfferPromise = (async () => {
      const prev = this.port.getState();
      const offerData = decodeSignalToken(offerToken);
      if (!offerData || offerData.type !== 'offer') {
        throw new Error('Invalid offer token: expected offer payload');
      }

      const roomId = offerData.roomId || null;
      const localColorSlot = options.clientColorSlot ?? prev.localColorSlot;
      const localColorHex = options.clientColorHex ?? prev.localColorHex;

      this.port.applyHandshakeState({
        role: 'client',
        roomId,
        localColorSlot,
        localColorHex,
        peerName: offerData.hostName || 'Host',
        ...(offerData.hostColorHex
          ? {
              peerColorHex: offerData.hostColorHex,
              peerColorSlot: offerData.hostColorSlot ?? null,
            }
          : {}),
      });

      const state = this.port.getState();
      if (roomId) {
        this.port.signaling.initRoomChannel(roomId);
        this.port.signaling.sendRoomMessage(
          {
            type: 'cross_tab_join',
            clientName: state.playerName,
            clientColorSlot: state.localColorSlot,
            clientColorHex: state.localColorHex,
          },
          state.peerId
        );
      }

      this.port.connection.options.onDataChannel = (event) => {
        console.log('[P2PWebRTCChannel] Client accepted dataChannel from Host');
        const dc = event.channel;
        dc.binaryType = 'arraybuffer';
        this.port.bindDataChannel(dc);
      };
      this.port.connection.createPeerConnection();

      const sdp = await this.port.connection.applyRemoteOfferAndCreateAnswer(offerData);
      const payload = {
        type: 'answer',
        roomId: state.roomId,
        sdp,
        candidates: this.port.connection.localCandidates,
        clientName: state.playerName,
        clientColorSlot: state.localColorSlot,
        clientColorHex: state.localColorHex,
        version: 2,
      };

      const token = 'RL_ANSWER_' + encodeSignalToken(payload);
      console.log(
        `[P2PWebRTCChannel] Client answer token created (${token.length} chars). Candidates: ${this.port.connection.localCandidates.length}`
      );
      this.port.signaling.broadcastSignal(
        'room_answer',
        {
          token,
          answerToken: token,
          roomId: state.roomId,
          clientName: state.playerName,
          clientColorSlot: state.localColorSlot,
          clientColorHex: state.localColorHex,
        },
        {
          roomId: state.roomId,
          role: state.role,
          playerName: state.playerName,
        }
      );

      this.lastProcessedOfferToken = offerToken;
      this.currentAnswerToken = token;
      this.port.applyHandshakeState({ answerToken: token });
      return token;
    })();

    try {
      return await this.acceptOfferPromise;
    } finally {
      this.acceptOfferPromise = null;
    }
  }

  async acceptAnswerToken(answerToken: string): Promise<void> {
    const pc = this.port.connection.pc;
    if (pc && pc.signalingState === 'stable') {
      console.log(
        '[P2PWebRTCChannel] Signaling state is already stable, answer description was already set.'
      );
      return;
    }

    const answerData = decodeSignalToken(answerToken);
    if (!answerData || answerData.type !== 'answer') {
      throw new Error('Invalid answer token: expected answer payload');
    }

    const prev = this.port.getState();
    const roomId = prev.roomId || answerData.roomId || null;
    this.port.applyHandshakeState({
      roomId,
      peerName: answerData.clientName || 'Player 2',
      ...(answerData.clientColorHex
        ? {
            peerColorHex: answerData.clientColorHex,
            peerColorSlot: answerData.clientColorSlot ?? null,
          }
        : {}),
    });

    if (answerData.roomId && !prev.roomId) {
      this.port.signaling.initRoomChannel(answerData.roomId);
    }

    const state = this.port.getState();
    this.port.signaling.sendRoomMessage(
      {
        type: 'cross_tab_ack',
        hostName: state.playerName,
        hostColorSlot: state.localColorSlot,
        hostColorHex: state.localColorHex,
      },
      state.peerId
    );

    if (!pc) return;
    if (pc.signalingState === 'stable') {
      console.log(
        '[P2PWebRTCChannel] Signaling state is already stable, answer description was already set.'
      );
      return;
    }

    console.log(`[P2PWebRTCChannel] Setting remote answer SDP from ${state.peerName}...`);
    await this.port.connection.applyRemoteAnswer(answerData);
    console.log(
      '[P2PWebRTCChannel] Remote answer SDP applied. Signaling state:',
      pc.signalingState
    );
  }

  handleRoomMessage(data: any): void {
    if (!data) return;

    if (data instanceof Uint8Array || data instanceof ArrayBuffer || typeof data === 'string') {
      this.port.handleIncomingMessage(data);
      return;
    }

    if (typeof data !== 'object') return;
    const state = this.port.getState();
    if (data.senderId && data.senderId === state.peerId) return;

    if (data.type === 'cross_tab_join') {
      if (!state.isHost || state.role === 'client') return;
      console.log(
        `[P2PWebRTCChannel] Host received cross_tab_join from "${data.clientName}" (Color: slot ${data.clientColorSlot} ${data.clientColorHex})`
      );
      this.port.activateCrossTabTransport({
        peerName: data.clientName || 'Player 2',
        peerColorSlot: data.clientColorSlot ?? null,
        peerColorHex: data.clientColorHex ?? null,
      });

      const updated = this.port.getState();
      this.port.signaling.sendRoomMessage(
        {
          type: 'cross_tab_ack',
          senderId: updated.peerId,
          hostName: updated.playerName,
          hostColorSlot: updated.localColorSlot,
          hostColorHex: updated.localColorHex,
          offerToken: updated.offerToken,
        },
        updated.peerId
      );
      return;
    }

    if (data.type === 'cross_tab_ack') {
      if (state.isHost || state.role !== 'client') return;
      console.log(
        `[P2PWebRTCChannel] Client received cross_tab_ack from Host "${data.hostName}" (Color: slot ${data.hostColorSlot} ${data.hostColorHex})`
      );
      this.port.activateCrossTabTransport({
        peerName: data.hostName || 'Host',
        peerColorSlot: data.hostColorSlot ?? null,
        peerColorHex: data.hostColorHex ?? null,
      });

      const updated = this.port.getState();
      const pc = this.port.connection.pc;
      if (data.offerToken && !updated.answerToken && !pc?.currentRemoteDescription) {
        this.acceptOfferAndCreateAnswer(data.offerToken)
          .then((ans) => {
            const latest = this.port.getState();
            this.port.signaling.sendRoomMessage(
              {
                type: 'room_answer',
                senderId: latest.peerId,
                sdp: ans,
                clientName: latest.playerName,
              },
              latest.peerId
            );
          })
          .catch((err) => {
            console.error(
              '[P2PWebRTCChannel] Failed to accept offer & create answer in room message:',
              err
            );
          });
      }
      return;
    }

    if (data.type === 'room_answer' && state.isHost && state.role === 'host' && data.sdp) {
      console.log(
        `[P2PWebRTCChannel] Host received room_answer via BroadcastChannel from ${data.clientName || 'Client'}`
      );
      this.acceptAnswerToken(data.sdp).catch((err) => {
        console.warn('[P2PWebRTCChannel] Failed to accept room_answer:', err);
      });
      return;
    }

    if (data.type === 'color_change') {
      console.log(
        `[P2PWebRTCChannel] Received cross-tab color_change: car ${data.carIndex} -> slot ${data.slotId} (${data.hex})`
      );
      this.port.onColorChange(data);
      return;
    }

    if (data.type === 'ping') {
      this.port.sendPong(data.sendTime);
      return;
    }

    if (data.type === 'pong') {
      this.port.simulator.handlePong(data.sendTime);
      return;
    }

    if (data.type === 'p2p_packet' && data.buffer) {
      this.port.handleIncomingMessage(data.buffer);
    }
  }

  handleBroadcastMessage(msg: any): void {
    if (!msg || !msg.type) return;
    const state = this.port.getState();
    if (msg.senderRole === state.role && msg.senderName === state.playerName) return;

    if (msg.type === 'ice_candidate' && msg.candidate) {
      if (!msg.roomId || msg.roomId === state.roomId) {
        void this.port.connection.addRemoteCandidate(msg.candidate);
      }
    }

    this.port.onBroadcastSignal(msg);
  }
}
