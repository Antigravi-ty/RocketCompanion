/**
 * ClientJoinNegotiationSubController.ts
 * Stateful SubController coordinating the client room-join lifecycle:
 * deadline/keepalive watchdog timers, 3-way E2EE rendezvous, 4-digit SAS pairing hold,
 * encrypted offer/answer/ICE negotiation, and downstream spectator relay attachment.
 */

import { SignalingProtocolHandler } from './SignalingProtocolHandler.ts';
import { ClientSessionController } from './ClientSessionController.ts';
import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';
import { getAllowSpectatorDaisyChain } from './signalingRelayConfig.ts';

export interface ClientJoinNegotiationOptions {
  roomId: string;
  password?: string;
  timeoutMs?: number;
  playerName: string;
  colorSlot: number;
  colorHex: string;
}

export interface ClientJoinNegotiationCallbacks {
  onSessionStatusChange: (status: Record<string, any>) => void;
  onJoinServer?: (config: {
    channel: P2PWebRTCChannel;
    playerName: string;
    remotePlayerName: string;
    pairingCode?: string;
  }) => Promise<void> | void;
  onAbortJoin: () => void;
  onUnexpectedDisconnect?: () => void;
}

export class ClientJoinNegotiationSubController {
  clientController: ClientSessionController | null = null;
  signalingHandler: SignalingProtocolHandler | null = null;

  private joinDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private isHeldForPairing = false;
  private lastKeepAliveAt = 0;
  private settled = false;
  private sdpOfferReceived = false;

  get channel(): P2PWebRTCChannel | null {
    return this.clientController?.channel || null;
  }

  private clearJoinTimer(): void {
    if (this.joinDeadlineTimer) {
      clearTimeout(this.joinDeadlineTimer);
      this.joinDeadlineTimer = null;
    }
  }

  async executeJoin(
    options: ClientJoinNegotiationOptions,
    callbacks: ClientJoinNegotiationCallbacks
  ): Promise<boolean> {
    const cleanRoomId = (options.roomId || '').trim();
    const joinPassword = String(options.password || '').trim();
    const timeoutMs = options.timeoutMs ?? 10000;
    const allowSpectatorRelay = getAllowSpectatorDaisyChain();

    this.cleanup();
    this.settled = false;
    this.isHeldForPairing = false;
    this.sdpOfferReceived = false;
    this.lastKeepAliveAt = Date.now();

    return new Promise(async (resolve, reject) => {
      const finishSuccess = () => {
        if (this.settled) return;
        this.settled = true;
        this.clearJoinTimer();
        resolve(true);
      };

      const finishFailure = (err: any) => {
        if (this.settled) return;
        this.settled = true;
        this.clearJoinTimer();
        callbacks.onAbortJoin();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const scheduleJoinDeadline = (durationMs = timeoutMs) => {
        this.clearJoinTimer();
        if (durationMs <= 0 || this.settled) return;
        this.joinDeadlineTimer = setTimeout(() => {
          if (this.settled) return;
          if (this.isHeldForPairing) {
            const silenceMs = Date.now() - this.lastKeepAliveAt;
            if (silenceMs < 8000) {
              scheduleJoinDeadline(4000);
              return;
            }
            finishFailure(new Error('Host stopped responding during pairing code confirmation.'));
            return;
          }

          const ch = this.channel;
          if (ch && (ch.connected || ch.isOpen)) {
            finishSuccess();
          } else if (this.sdpOfferReceived) {
            finishFailure(
              new Error(
                'Signaling Connected (SDP/ICE Exchanged) — P2P Blocked by NAT (Symmetric NAT or firewall blocked direct WebRTC DataChannel).'
              )
            );
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
          playerName: options.playerName,
          colorSlot: options.colorSlot,
          colorHex: options.colorHex,
          allowSpectatorRelay,
        },
        {
          onConnected: async (channel, peerName, pairingCode) => {
            const resolvedPairingCode =
              pairingCode || this.signalingHandler?.getPairingCodeForPeer?.() || undefined;
            const activeRelayLabel = this.signalingHandler?.getActiveRelayLabel?.() || undefined;
            callbacks.onSessionStatusChange({
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
            if (callbacks.onJoinServer) {
              await callbacks.onJoinServer({
                channel,
                playerName: options.playerName,
                remotePlayerName: peerName,
                pairingCode: resolvedPairingCode,
              });
            }
            finishSuccess();
          },
          onDisconnected: () => {
            callbacks.onSessionStatusChange({ connectedPeers: [] });
            if (!this.settled) {
              finishFailure(new Error('P2P channel disconnected'));
            } else {
              callbacks.onUnexpectedDisconnect?.();
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
          password: joinPassword,
          role: 'client',
          playerName: options.playerName,
          allowSpectatorRelay,
        },
        {
          onOpen: ({ relayLabel }) => {
            callbacks.onSessionStatusChange({
              signalingConnected: true,
              roomId: cleanRoomId,
              activeRelayLabel: relayLabel,
            });
          },
          onRendezvousEstablished: ({ relayLabel, pairingCode, requireManualApproval }) => {
            this.lastKeepAliveAt = Date.now();
            callbacks.onSessionStatusChange({
              pairingCode,
              activeRelayLabel: relayLabel,
            });
            if (requireManualApproval) {
              this.isHeldForPairing = true;
              scheduleJoinDeadline(6000);
            }
          },
          onPairingHold: () => {
            this.isHeldForPairing = true;
            this.lastKeepAliveAt = Date.now();
            scheduleJoinDeadline(6000);
          },
          onPairingKeepAlive: () => {
            this.lastKeepAliveAt = Date.now();
            if (this.isHeldForPairing) {
              scheduleJoinDeadline(6000);
            }
          },
          onPairingApproved: () => {
            this.isHeldForPairing = false;
            this.lastKeepAliveAt = Date.now();
            scheduleJoinDeadline(timeoutMs);
          },
          onPairingDeclined: ({ reason }) => {
            this.isHeldForPairing = false;
            finishFailure(
              new Error(reason || 'Connection declined by Host during pairing verification.')
            );
          },
          onError: () => {
            if (!this.channel?.connected) {
              callbacks.onSessionStatusChange({ signalingConnected: false });
            }
          },
          onOffer: async ({ sdp, fromPeerId, pairingCode }) => {
            try {
              this.isHeldForPairing = false;
              this.sdpOfferReceived = true;
              scheduleJoinDeadline(Math.max(6000, timeoutMs));
              await this.clientController?.handleOffer(sdp, fromPeerId, this.signalingHandler, {
                pairingCode,
              });
            } catch (err) {
              console.error('[MultiplayerSessionManager] Error handling host offer:', err);
              finishFailure(err);
            }
          },
          onCandidate: ({ candidate }) => {
            this.clientController?.handleRemoteCandidate(candidate);
          },
          onPeerJoined: ({ peerId, name }) => {
            if (this.clientController?.allowSpectatorRelay) {
              this.clientController.acceptDownstreamSpectatorPeer(
                peerId,
                name,
                this.signalingHandler
              );
            }
          },
        }
      );

      try {
        await this.signalingHandler.connect(timeoutMs);
      } catch (sigErr: any) {
        console.warn(
          '[MultiplayerSessionManager] Signaling connection notice:',
          sigErr?.message || sigErr
        );
        const ch = this.channel;
        if (!ch || (!ch.connected && !ch.isOpen)) {
          finishFailure(sigErr);
        }
      }
    });
  }

  cleanup(): void {
    this.settled = true;
    this.isHeldForPairing = false;
    this.clearJoinTimer();
    if (this.signalingHandler) {
      this.signalingHandler.cleanup();
      this.signalingHandler = null;
    }
    if (this.clientController) {
      this.clientController.cleanup();
      this.clientController = null;
    }
  }
}
