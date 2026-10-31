/**
 * src/network/transport/MultiplayerSessionManager.js
 * Unified Headless Multiplayer Session Coordinator.
 * Manages host/client WebRTC lifecycles, multi-relay E2EE signaling negotiation,
 * 4-digit SAS pairing verification, and spectator daisy-chain routing.
 */

import { SignalingProtocolHandler } from './SignalingProtocolHandler.js';
import { HostSessionController } from './HostSessionController.js';
import { ClientSessionController } from './ClientSessionController.js';
import { CAR_COLOR_SLOTS } from '../../ui-core/config/vehicleConstants.js';
import {
  roomConnectionProgress,
  saveActiveHostOffer,
  clearActiveHostOffer,
  getAllowSpectatorDaisyChain,
} from '../../ui-core/config/signalingConfig.js';
import {
  loadStoredPlayerName,
  getPreferredColorSlot,
} from '../../ui-core/config/vehiclePresets.js';
import { notifyNetworkTelemetryExportAvailable } from '../../ui-core/stores/pacingTelemetryExporter.js';

export class MultiplayerSessionManager {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.playerName = this._loadPlayerName();

    this.isHosting = false;
    this.roomId = '';
    this.password = '';
    this.joinRoomId = '';
    this.joinPassword = '';

    const savedColorSlot = this._loadPreferredColorSlot();
    this.hostColorSlot = savedColorSlot ?? 3;
    this.hostColorHex = CAR_COLOR_SLOTS[this.hostColorSlot]?.hex || '#42a5f5';

    this.clientColorSlot = savedColorSlot ?? (this.hostColorSlot === 0 ? 3 : 0);
    this.clientColorHex = CAR_COLOR_SLOTS[this.clientColorSlot]?.hex || '#ff7043';

    this.hostController = null;
    this.clientController = null;
    this.signalingHandler = null;
    this.pendingPairingRequests = new Map();
  }

  _updateSessionStatus(status) {
    if (typeof this.callbacks.onSessionStatusChange === 'function') {
      try {
        this.callbacks.onSessionStatusChange(status);
      } catch (err) {
        console.warn('[MultiplayerSessionManager] Error in onSessionStatusChange callback:', err);
      }
    }
  }

  _loadPlayerName() {
    return loadStoredPlayerName().substring(0, 16);
  }

  _loadPreferredColorSlot() {
    const idx = getPreferredColorSlot();
    return idx >= 0 && idx < CAR_COLOR_SLOTS.length ? idx : null;
  }

  get hostP2PChannel() {
    return this.hostController?.channel || null;
  }

  get clientP2PChannel() {
    return this.clientController?.channel || null;
  }

  get signalingClient() {
    return this.signalingHandler?.client || null;
  }

  approvePendingPeer(peerId) {
    const req = this.pendingPairingRequests.get(peerId);
    if (!req) return false;
    this.pendingPairingRequests.delete(peerId);
    this._syncPendingPairingStatus();
    req.approve?.();
    return true;
  }

  declinePendingPeer(peerId) {
    const req = this.pendingPairingRequests.get(peerId);
    if (!req) return false;
    this.pendingPairingRequests.delete(peerId);
    this._syncPendingPairingStatus();
    req.decline?.('Host declined the pairing verification request.');
    return true;
  }

  _syncPendingPairingStatus() {
    const list = Array.from(this.pendingPairingRequests.values()).map((r) => ({
      peerId: r.peerId,
      peerName: r.peerName,
      pairingCode: r.pairingCode,
      relayLabel: r.relayLabel,
      role: r.role,
    }));
    this._updateSessionStatus({ pendingPairingRequests: list });
  }

  async startHosting(roomId = null, password = '', roomConfig = {}) {
    if (this.clientController || this.signalingHandler) {
      await this.leaveSession();
    }
    if (this.hostController) {
      await this.stopHosting();
    }
    this.roomId = (roomId || String(Math.floor(1000 + Math.random() * 9000))).trim();
    this.password = String(password || '').trim();
    this.isHosting = true;
    this.pendingPairingRequests.clear();

    roomConnectionProgress.startHost();
    roomConnectionProgress.advance('worker_init', 'Initializing Authoritative Server Worker');

    if (this.callbacks.onHostServer) {
      await this.callbacks.onHostServer({
        playerName: this.playerName,
        roomId: this.roomId,
        password: this.password,
        ...roomConfig,
      });
    }

    roomConnectionProgress.advance('physics_ready', 'Configuring Arena & Physics');
    this.callbacks.onColorSelect?.(0, this.hostColorSlot, this.hostColorHex);

    this.hostController = new HostSessionController(
      {
        roomId: this.roomId,
        playerName: this.playerName,
        colorSlot: this.hostColorSlot,
        colorHex: this.hostColorHex,
      },
      {
        onPeerConnected: async (channel, peerName, peerId, role) => {
          let assignedCarIdx;
          if (this.callbacks.onPeerConnected) {
            assignedCarIdx = await this.callbacks.onPeerConnected(channel, peerName, peerId, role);
            if (typeof assignedCarIdx === 'number' && assignedCarIdx >= 0) {
              channel.carIndex = assignedCarIdx;
            }
          }
          const pairingCode = channel?.pairingCode || this.signalingHandler?.getPairingCodeForPeer?.(peerId) || undefined;
          this._updateSessionStatus({
            connectedPeers: this.hostController?.getConnectedPeerList?.() || [
              {
                id: peerId || channel.peerId || 'peer-1',
                name: peerName,
                carIndex: assignedCarIdx,
                pingMs: 0,
                pairingCode,
              },
            ],
          });
          return assignedCarIdx;
        },
        onPeerDisconnected: (peerId, channel) => {
          this.pendingPairingRequests.delete(peerId);
          this._syncPendingPairingStatus();
          if (typeof channel?.carIndex === 'number' && channel.carIndex > 0) {
            this.callbacks.onRemovePlayer?.(channel.carIndex);
          }
          this._updateSessionStatus({
            connectedPeers: this.hostController?.getConnectedPeerList?.() || [],
          });
        },
        onColorChange: (carIdx, slotId, hex) => {
          this.callbacks.onColorSelect?.(carIdx, slotId, hex);
        },
        onIceCandidate: (cand, targetPeerId) => {
          if (this.signalingHandler) {
            this.signalingHandler.sendCandidate(targetPeerId || null, cand);
          }
        },
      }
    );

    const offerToken = await this.hostController.initializeChannel();

    if (!this.password) {
      saveActiveHostOffer({
        roomId: this.roomId,
        token: offerToken,
        colorSlot: this.hostColorSlot,
        colorHex: this.hostColorHex,
        playerName: this.playerName,
        timestamp: Date.now(),
      });
    } else {
      clearActiveHostOffer();
    }

    roomConnectionProgress.advance('signaling_connect', 'Binding Multi-Relay E2EE Signaling');
    this.initHostSignaling();
    roomConnectionProgress.complete('Room Active. Ready for Players');
    return offerToken;
  }

  initHostSignaling() {
    if (!this.isHosting) return;
    this.signalingHandler = new SignalingProtocolHandler(
      {
        roomId: this.roomId,
        password: this.password,
        role: 'host',
        playerName: this.playerName,
        allowSpectatorRelay: true,
      },
      {
        onOpen: ({ relayLabel }) => {
          roomConnectionProgress.setActiveRelay(relayLabel);
          this._updateSessionStatus({
            signalingConnected: true,
            roomId: this.roomId,
            activeRelayLabel: relayLabel,
          });
        },
        onClose: () => {
          if (this.isHosting) {
            this.signalingHandler.scheduleReconnect(3000, () => this.initHostSignaling());
          }
        },
        onError: () => {
          this._updateSessionStatus({ signalingConnected: false });
          if (this.isHosting) {
            this.signalingHandler?.scheduleReconnect(3000, () => this.initHostSignaling());
          }
        },
        onPairingApprovalRequired: (request) => {
          this.pendingPairingRequests.set(request.peerId, request);
          this._syncPendingPairingStatus();
          this.callbacks.onPairingApprovalRequest?.(request);
        },
        onPeerJoined: ({ peerId, name, peerName, role, allowSpectatorRelay, pairingCode }) => {
          this.pendingPairingRequests.delete(peerId);
          this._syncPendingPairingStatus();
          this.hostController?.dispatchOfferToPeer(
            peerId,
            name || peerName,
            this.signalingHandler,
            role || 'player',
            { allowSpectatorRelay, pairingCode }
          );
        },
        onRoomInfo: ({ participants }) => {
          if (!Array.isArray(participants) || !this.isHosting) return;
          for (const p of participants) {
            if (p?.peerId && p.peerId !== this.signalingHandler?.peerId) {
              this.hostController?.dispatchOfferToPeer(
                p.peerId,
                p.peerName || p.name,
                this.signalingHandler,
                p.role || 'player'
              );
            }
          }
        },
        onRequestOffer: ({ fromPeerId, name, senderName, role, pairingCode }) => {
          this.hostController?.dispatchOfferToPeer(
            fromPeerId,
            name || senderName,
            this.signalingHandler,
            role || 'player',
            { pairingCode }
          );
        },
        onAnswer: async ({ sdp, fromPeerId, pairingCode }) => {
          try {
            await this.hostController?.handleAnswer(sdp, fromPeerId || null, { pairingCode });
          } catch (err) {
            console.error('[MultiplayerSessionManager] Error accepting peer answer:', err);
            throw err;
          }
        },
        onCandidate: ({ candidate, fromPeerId }) => {
          this.hostController?.handleRemoteCandidate(candidate, fromPeerId || null);
        },
      }
    );

    this.signalingHandler.connect().catch((err) => {
      console.warn('[MultiplayerSessionManager] Signaling connection notice:', err?.message || err);
      if (this.isHosting) {
        this.signalingHandler?.scheduleReconnect(3000, () => this.initHostSignaling());
      }
    });
  }

  async joinRoom(roomId, password = '', timeoutMs = 10000) {
    const cleanRoomId = (roomId || '').trim();
    if (!cleanRoomId) {
      throw new Error('[MultiplayerSessionManager] Room ID is required to join');
    }

    if (this.clientController || this.signalingHandler) {
      await this.leaveSession();
    }
    if (this.hostController) {
      await this.stopHosting();
    }

    this.joinRoomId = cleanRoomId;
    this.joinPassword = String(password || '').trim();

    roomConnectionProgress.startJoin();
    roomConnectionProgress.advance('signaling_connect', 'Connecting to Multi-Relay Signaling');

    return new Promise(async (resolve, reject) => {
      let settled = false;
      let timer = null;
      let isHeldForPairing = false;
      let lastKeepAliveAt = Date.now();

      const clearJoinTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const finishSuccess = () => {
        if (settled) return;
        settled = true;
        clearJoinTimer();
        resolve(true);
      };

      const finishFailure = (err) => {
        if (settled) return;
        settled = true;
        clearJoinTimer();
        roomConnectionProgress.fail(err);
        this.leaveSession?.();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const scheduleJoinDeadline = (durationMs = timeoutMs) => {
        clearJoinTimer();
        if (durationMs <= 0 || settled) return;
        timer = setTimeout(() => {
          if (settled) return;
          if (isHeldForPairing) {
            const silenceMs = Date.now() - lastKeepAliveAt;
            if (silenceMs < 8000) {
              scheduleJoinDeadline(4000);
              return;
            }
            finishFailure(new Error('Host stopped responding during pairing code confirmation.'));
            return;
          }

          const ch = this.clientP2PChannel;
          if (ch && (ch.connected || ch.isOpen)) {
            finishSuccess();
          } else if (this.signalingHandler?.status === 'connected') {
            finishFailure(
              new Error(
                `Connected to signaling relay, but room "${cleanRoomId}" (or matching password) did not respond within ${Math.round(timeoutMs / 1000)}s.`
              )
            );
          } else {
            finishFailure(
              new Error(
                `Join room connection timed out after ${Math.round(timeoutMs / 1000)}s (All signaling relays unreachable)`
              )
            );
          }
        }, durationMs);
      };

      scheduleJoinDeadline(timeoutMs);

      this.clientController = new ClientSessionController(
        {
          roomId: cleanRoomId,
          playerName: this.playerName,
          colorSlot: this.clientColorSlot,
          colorHex: this.clientColorHex,
          allowSpectatorRelay: getAllowSpectatorDaisyChain(),
        },
        {
          onConnected: async (channel, peerName, pairingCode) => {
            roomConnectionProgress.advance('state_sync', 'Synchronizing Game Timeline & State');
            const resolvedPairingCode = pairingCode || this.signalingHandler?.getPairingCodeForPeer?.() || undefined;
            const activeRelayLabel = this.signalingHandler?.getActiveRelayLabel?.() || undefined;
            this._updateSessionStatus({
              signalingConnected: true,
              pairingCode: resolvedPairingCode,
              activeRelayLabel,
              connectedPeers: [
                {
                  id: 'host',
                  name: peerName,
                  pingMs: 0,
                  pairingCode: resolvedPairingCode,
                },
              ],
            });
            if (this.callbacks.onJoinServer) {
              await this.callbacks.onJoinServer({
                channel,
                playerName: this.playerName,
                remotePlayerName: peerName,
                pairingCode: resolvedPairingCode,
              });
            }
            roomConnectionProgress.complete('Connected. Entering Arena');
            finishSuccess();
          },
          onDisconnected: () => {
            this._updateSessionStatus({ connectedPeers: [] });
            if (!settled) {
              finishFailure(new Error('P2P channel disconnected'));
            } else {
              notifyNetworkTelemetryExportAvailable('disconnected');
            }
          },
          onIceCandidate: (cand) => {
            if (this.signalingHandler) {
              this.signalingHandler.sendCandidate(null, cand);
            }
          },
        }
      );

      try {
        await this.clientController.initializeChannel();
      } catch (e) {
        console.error('[MultiplayerSessionManager] Failed to initialize client channel:', e);
        return finishFailure(e);
      }

      this.signalingHandler = new SignalingProtocolHandler(
        {
          roomId: cleanRoomId,
          password: this.joinPassword,
          role: 'client',
          playerName: this.playerName,
          allowSpectatorRelay: getAllowSpectatorDaisyChain(),
        },
        {
          onOpen: ({ relayLabel }) => {
            roomConnectionProgress.setActiveRelay(relayLabel);
            this._updateSessionStatus({
              signalingConnected: true,
              roomId: cleanRoomId,
              activeRelayLabel: relayLabel,
            });
            roomConnectionProgress.advance(
              'find_room',
              `Connected via ${relayLabel}. Performing 3-Way E2EE Handshake...`
            );
          },
          onRendezvousEstablished: ({ relayLabel, pairingCode, hostName, requireManualApproval }) => {
            lastKeepAliveAt = Date.now();
            roomConnectionProgress.setActiveRelay(relayLabel, pairingCode);
            this._updateSessionStatus({
              pairingCode,
              activeRelayLabel: relayLabel,
            });
            if (requireManualApproval) {
              isHeldForPairing = true;
              roomConnectionProgress.setPairingHold(
                true,
                pairingCode,
                `Verify Pairing Code [${pairingCode}] — Waiting for ${hostName} to Accept...`
              );
              scheduleJoinDeadline(6000);
            } else {
              roomConnectionProgress.advance(
                'find_room',
                `Verified ${hostName} via ${relayLabel} (Pair Code: ${pairingCode})`
              );
            }
          },
          onPairingHold: ({ hostName, pairingCode }) => {
            isHeldForPairing = true;
            lastKeepAliveAt = Date.now();
            roomConnectionProgress.setPairingHold(
              true,
              pairingCode,
              `Verify Pairing Code [${pairingCode}] — Waiting for ${hostName} to Accept...`
            );
            scheduleJoinDeadline(6000);
          },
          onPairingKeepAlive: () => {
            lastKeepAliveAt = Date.now();
            if (isHeldForPairing) {
              scheduleJoinDeadline(6000);
            }
          },
          onPairingApproved: ({ pairingCode }) => {
            isHeldForPairing = false;
            lastKeepAliveAt = Date.now();
            roomConnectionProgress.setPairingHold(
              false,
              pairingCode,
              `Host Approved Pairing [${pairingCode}]. Negotiating P2P...`
            );
            scheduleJoinDeadline(timeoutMs);
          },
          onPairingDeclined: ({ reason }) => {
            isHeldForPairing = false;
            finishFailure(new Error(reason || 'Connection declined by Host during pairing verification.'));
          },
          onError: () => {
            if (!this.clientP2PChannel?.connected) {
              this._updateSessionStatus({ signalingConnected: false });
            }
          },
          onOffer: async ({ sdp, fromPeerId, pairingCode }) => {
            try {
              isHeldForPairing = false;
              roomConnectionProgress.setPairingHold(false, pairingCode);
              roomConnectionProgress.advance(
                'webrtc_offer',
                `Decrypting Host Offer & Creating Answer${pairingCode ? ` [Code: ${pairingCode}]` : ''}`
              );
              scheduleJoinDeadline(Math.max(6000, timeoutMs));
              await this.clientController.handleOffer(sdp, fromPeerId, this.signalingHandler, {
                pairingCode,
              });
            } catch (err) {
              console.error('[MultiplayerSessionManager] Error handling host offer:', err);
              finishFailure(err);
            }
          },
          onCandidate: ({ candidate }) => {
            roomConnectionProgress.advance('ice_exchange', 'Exchanging Encrypted ICE & Establishing P2P');
            this.clientController.handleRemoteCandidate(candidate);
          },
          onPeerJoined: ({ peerId, name }) => {
            if (this.clientController?.allowSpectatorRelay) {
              this.clientController.acceptDownstreamSpectatorPeer(peerId, name, this.signalingHandler);
            }
          },
        }
      );

      try {
        await this.signalingHandler.connect(timeoutMs);
      } catch (sigErr) {
        console.warn('[MultiplayerSessionManager] Signaling connection notice:', sigErr?.message || sigErr);
        const ch = this.clientP2PChannel;
        if (!ch || (!ch.connected && !ch.isOpen)) {
          finishFailure(sigErr);
        }
      }
    });
  }

  async stopHosting() {
    this.isHosting = false;
    this.pendingPairingRequests.clear();
    if (this.signalingHandler) {
      this.signalingHandler.cleanup();
      this.signalingHandler = null;
    }
    if (this.hostController) {
      this.hostController.cleanup();
      this.hostController = null;
    }
    clearActiveHostOffer();
    if (this.callbacks.onStopServer) {
      await this.callbacks.onStopServer();
    }
  }

  async leaveSession() {
    this.pendingPairingRequests.clear();
    if (this.signalingHandler) {
      this.signalingHandler.cleanup();
      this.signalingHandler = null;
    }
    if (this.clientController) {
      this.clientController.cleanup();
      this.clientController = null;
    }
    if (this.callbacks.onLeaveServer) {
      await this.callbacks.onLeaveServer();
    }
  }

  reconnectSignaling() {
    if (this.signalingHandler) {
      this.signalingHandler.connect().catch((err) => {
        console.warn('[MultiplayerSessionManager] Reconnect error:', err);
      });
    }
  }
}

export default MultiplayerSessionManager;
