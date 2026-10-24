/**
 * src/network/multiplayer/HostSessionController.js
 * Headless Multi-Peer Host Session Controller for managing WebRTC P2P hosting,
 * multi-channel negotiation (up to 6 player input channels + N spectator broadcast channels),
 * and two-phase ready barrier coordination.
 */

import { P2PWebRTCChannel } from '../P2PWebRTCChannel.js';

export const DEFAULT_MAX_INPUT_CHANNELS = 6;
export const DEFAULT_MAX_BROADCAST_CHANNELS = 16;

export class HostSessionController {
  /**
   * @param {object} options
   * @param {string} options.roomId
   * @param {string} options.playerName
   * @param {number} [options.colorSlot=3]
   * @param {string} [options.colorHex='#42a5f5']
   * @param {number} [options.maxInputChannels=6]
   * @param {number} [options.maxBroadcastChannels=16]
   * @param {object} callbacks
   */
  constructor(options, callbacks = {}) {
    this.roomId = options.roomId;
    this.playerName = options.playerName;
    this.colorSlot = options.colorSlot ?? 3;
    this.colorHex = options.colorHex ?? '#42a5f5';
    this.maxInputChannels = options.maxInputChannels ?? DEFAULT_MAX_INPUT_CHANNELS;
    this.maxBroadcastChannels = options.maxBroadcastChannels ?? DEFAULT_MAX_BROADCAST_CHANNELS;
    this.callbacks = callbacks;

    this.channel = null; // Primary / default pre-warmed channel for backwards compatibility
    this.peerChannels = new Map(); // peerId -> P2PWebRTCChannel
    this.peerRoles = new Map(); // peerId -> 'player' | 'spectator'
    this.peerReadyStates = new Map(); // peerId -> { ready: boolean, arenaLoaded: boolean }
    this.offerToken = '';
    this.offersSentTime = new Map();
    this._nextPeerSeq = 1;
  }

  /**
   * Creates and binds a new P2PWebRTCChannel for a specific peerId
   * @param {string} peerId
   * @param {string} [peerName='Player']
   * @param {'player'|'spectator'} [preferredRole='player']
   * @returns {P2PWebRTCChannel}
   */
  _createPeerChannel(peerId, peerName = 'Player', preferredRole = 'player') {
    const ch = new P2PWebRTCChannel({
      role: 'host',
      roomId: this.roomId,
      playerName: this.playerName,
      colorSlot: this.colorSlot,
      colorHex: this.colorHex,
      extraLatencyMs: 0,
    });
    ch.peerId = peerId;
    ch.peerName = peerName;

    const currentPlayerCount = this.getInputChannelCount();
    const assignedRole = (preferredRole === 'spectator' || currentPlayerCount >= this.maxInputChannels)
      ? 'spectator'
      : 'player';
    ch.peerRole = assignedRole;

    this.peerChannels.set(peerId, ch);
    this.peerRoles.set(peerId, assignedRole);
    this.peerReadyStates.set(peerId, { ready: false, arenaLoaded: false });

    ch.onConnected = async () => {
      const resolvedName = ch.peerName || peerName || 'Player 2';
      if (this.callbacks.onPeerConnected) {
        const assignedCarIdx = await this.callbacks.onPeerConnected(ch, resolvedName, peerId, assignedRole);
        if (typeof assignedCarIdx === 'number' && assignedCarIdx >= 0) {
          ch.carIndex = assignedCarIdx;
        }
      }
      ch.sendColorChange(this.colorSlot, this.colorHex, 0);
      if (ch.peerColorHex) {
        this.callbacks.onColorChange?.(ch.carIndex ?? 1, ch.peerColorSlot, ch.peerColorHex);
      }
    };

    ch.onDisconnected = () => {
      this.peerReadyStates.delete(peerId);
      this.callbacks.onPeerDisconnected?.(peerId, ch);
    };

    ch.onColorChange = (msg) => {
      const cIdx = msg.carIndex ?? ch.carIndex ?? 1;
      if (msg.slotId !== undefined) {
        ch.peerColorSlot = msg.slotId;
      }
      if (msg.hex !== undefined) {
        ch.peerColorHex = msg.hex;
      }
      this.callbacks.onColorChange?.(cIdx, msg.slotId, msg.hex);
    };

    ch.onIceCandidate = (cand) => {
      this.callbacks.onIceCandidate?.(cand, peerId);
    };

    return ch;
  }

  /**
   * Returns count of active or negotiating player input channels (excluding spectators)
   * @returns {number}
   */
  getInputChannelCount() {
    let count = 0;
    for (const [peerId, role] of this.peerRoles.entries()) {
      const ch = this.peerChannels.get(peerId);
      if (ch && role === 'player') {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns all connected peer summaries
   * @returns {Array<{ id: string, name: string, role: string, carIndex?: number, pingMs: number, ready: boolean, arenaLoaded: boolean }>}
   */
  getConnectedPeerList() {
    const list = [];
    for (const [peerId, ch] of this.peerChannels.entries()) {
      if (ch.connected || ch.isOpen) {
        const readyInfo = this.peerReadyStates.get(peerId) || { ready: false, arenaLoaded: false };
        list.push({
          id: peerId,
          name: ch.peerName || 'Player',
          role: this.peerRoles.get(peerId) || 'player',
          carIndex: typeof ch.carIndex === 'number' ? ch.carIndex : undefined,
          pingMs: Math.round(ch.measuredRttMs || ch.rttMs || 0),
          ready: readyInfo.ready,
          arenaLoaded: readyInfo.arenaLoaded
        });
      }
    }
    return list;
  }

  async initializeChannel() {
    this.cleanup();

    const defaultPeerId = 'peer_1';
    this.channel = this._createPeerChannel(defaultPeerId, 'Player 2', 'player');

    this.offerToken = await this.channel.createOfferToken({
      roomId: this.roomId,
      hostColorSlot: this.colorSlot,
      hostColorHex: this.colorHex,
    });

    return this.offerToken;
  }

  async dispatchOfferToPeer(peerId, peerName, signalingClient, role = 'player') {
    if (!peerId || !signalingClient || peerId === signalingClient.peerId) return;
    if (this.peerChannels.size >= this.maxBroadcastChannels && !this.peerChannels.has(peerId)) {
      console.warn(`[HostSessionController] Broadcast channel limit (${this.maxBroadcastChannels}) reached; rejecting peer ${peerId}`);
      return;
    }

    const now = Date.now();
    const lastSent = this.offersSentTime.get(peerId) || 0;
    if (now - lastSent < 2500) {
      return;
    }
    this.offersSentTime.set(peerId, now);

    let targetChannel = this.peerChannels.get(peerId);

    // Reuse pre-warmed default channel if it hasn't been claimed by any specific remote peer yet
    if (!targetChannel) {
      const prewarmed = this.peerChannels.get('peer_1');
      if (
        prewarmed &&
        !prewarmed.connected &&
        !prewarmed.isOpen &&
        (!prewarmed.pc || prewarmed.pc.signalingState === 'have-local-offer')
      ) {
        this.peerChannels.delete('peer_1');
        const prevRole = this.peerRoles.get('peer_1') || role;
        this.peerRoles.delete('peer_1');
        const prevReady = this.peerReadyStates.get('peer_1') || { ready: false, arenaLoaded: false };
        this.peerReadyStates.delete('peer_1');

        prewarmed.peerId = peerId;
        prewarmed.peerName = peerName || 'Player 2';
        this.peerChannels.set(peerId, prewarmed);
        this.peerRoles.set(peerId, prevRole);
        this.peerReadyStates.set(peerId, prevReady);
        targetChannel = prewarmed;
      } else {
        targetChannel = this._createPeerChannel(peerId, peerName || `Player ${++this._nextPeerSeq}`, role);
      }
    }

    let token = targetChannel.offerToken;
    if (!token) {
      token = await targetChannel.createOfferToken({
        roomId: this.roomId,
        hostColorSlot: this.colorSlot,
        hostColorHex: this.colorHex,
      });
      if (!this.offerToken) {
        this.offerToken = token;
      }
    }

    if (token) {
      signalingClient.sendOffer(peerId, token);
    }
  }

  async handleAnswer(sdp, fromPeerId = null) {
    let targetChannel = fromPeerId ? this.peerChannels.get(fromPeerId) : null;
    if (!targetChannel) {
      console.warn(
        `[HostSessionController] handleAnswer: peer channel not found for fromPeerId="${fromPeerId ?? 'null'}"; falling back to first channel awaiting an answer.`
      );
      // Fallback to first channel awaiting an answer
      for (const ch of this.peerChannels.values()) {
        if (!ch.connected && (!ch.pc || ch.pc.signalingState !== 'stable')) {
          targetChannel = ch;
          break;
        }
      }
      if (!targetChannel) {
        console.warn('[HostSessionController] handleAnswer: no pending peerChannel found; falling back to primary this.channel.');
        targetChannel = this.channel;
      }
    }

    if (!targetChannel) {
      throw new Error('[HostSessionController] Cannot handle answer: channel is not initialized');
    }
    return targetChannel.acceptAnswerToken(sdp);
  }

  handleRemoteCandidate(candidate, fromPeerId = null) {
    if (!candidate) return;
    if (fromPeerId && this.peerChannels.has(fromPeerId)) {
      this.peerChannels.get(fromPeerId).addIceCandidate(candidate);
      return;
    }
    console.warn(
      `[HostSessionController] handleRemoteCandidate: peer channel not found for fromPeerId="${fromPeerId ?? 'null'}"; broadcasting ICE candidate to primary and unconnected peer channels as fallback.`
    );
    if (this.channel) {
      this.channel.addIceCandidate(candidate);
    }
    for (const ch of this.peerChannels.values()) {
      if (ch !== this.channel && !ch.connected) {
        ch.addIceCandidate(candidate);
      }
    }
  }

  /**
   * Two-Phase Ready Barrier Step 1: Broadcasts match_prepare to all connected peers
   * @param {object} matchConfig
   */
  broadcastMatchPrepare(matchConfig = {}) {
    const msg = JSON.stringify({
      type: 'match_prepare',
      roomId: this.roomId,
      timestamp: Date.now(),
      ...matchConfig
    });
    for (const [peerId, state] of this.peerReadyStates.entries()) {
      state.arenaLoaded = false;
    }
    for (const ch of this.peerChannels.values()) {
      if (ch.connected || ch.isOpen) {
        ch.send(msg);
      }
    }
  }

  /**
   * Records a peer's Ready or Arena-Loaded ACK and checks if all connected players are ready
   * @param {string} peerId
   * @param {{ ready?: boolean, arenaLoaded?: boolean }} update
   * @returns {{ allReady: boolean, allArenaLoaded: boolean }}
   */
  recordPeerReadyState(peerId, update = {}) {
    const current = this.peerReadyStates.get(peerId) || { ready: false, arenaLoaded: false };
    if (update.ready !== undefined) current.ready = Boolean(update.ready);
    if (update.arenaLoaded !== undefined) current.arenaLoaded = Boolean(update.arenaLoaded);
    this.peerReadyStates.set(peerId, current);

    let allReady = true;
    let allArenaLoaded = true;
    let activePlayerPeers = 0;

    for (const [id, ch] of this.peerChannels.entries()) {
      if ((ch.connected || ch.isOpen) && this.peerRoles.get(id) === 'player') {
        activePlayerPeers++;
        const st = this.peerReadyStates.get(id) || { ready: false, arenaLoaded: false };
        if (!st.ready) allReady = false;
        if (!st.arenaLoaded) allArenaLoaded = false;
      }
    }

    return {
      allReady: activePlayerPeers > 0 && allReady,
      allArenaLoaded: activePlayerPeers > 0 && allArenaLoaded
    };
  }

  cleanup() {
    this.offersSentTime.clear();
    this.peerRoles.clear();
    this.peerReadyStates.clear();
    for (const ch of this.peerChannels.values()) {
      try {
        ch.destroy();
      } catch (err) {
        console.warn('[HostSessionController] Error destroying peer channel:', err);
      }
    }
    this.peerChannels.clear();
    this.channel = null;
    this.offerToken = '';
  }
}
