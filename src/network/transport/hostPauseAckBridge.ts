/**
 * hostPauseAckBridge.ts
 * Pure helper functions for HostSessionController's Pause/Resume ACK loop,
 * presence ping keepalive, and GlobalWorkspaceBroadcast pause state synchronization.
 */

import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';
import type { HostPauseAckController } from './HostPauseAckController.ts';
import {
  sanitizeGlobalWorkspaceBroadcast,
  type GlobalWorkspaceBroadcastPayload,
} from '../protocol/GlobalWorkspaceProtocol.ts';

export interface HostSessionOptions {
  roomId: string;
  playerName: string;
  colorSlot?: number;
  colorHex?: string;
  maxInputChannels?: number;
  maxBroadcastChannels?: number;
}

export interface HostSignalingPort {
  peerId?: string;
  sendOffer: (targetPeerId: string, offerToken: string) => unknown;
  sendRelayAssignment?: (targetPeerId: string, relayPlan: unknown) => Promise<unknown>;
}

export interface HostSessionCallbacks {
  onPeerConnected?: (
    ch: P2PWebRTCChannel,
    resolvedName: string,
    peerId: string,
    assignedRole: string
  ) => Promise<number | void> | number | void;
  onPeerDisconnected?: (peerId: string, ch: P2PWebRTCChannel) => void;
  onColorChange?: (carIdx: number, slotId: number | null, hex: string | null) => void;
  onIceCandidate?: (cand: RTCIceCandidateInit | Record<string, unknown>, peerId: string) => void;
  getLocalTunnelDescriptor?: () => Record<string, unknown> | null;
  onRemoteTunnelEndpoint?: (endpoint: Record<string, unknown>, peerId: string) => void;
  onTelestratorBytes?: (peerId: string, bytes: Uint8Array) => void;
  onCameraStateSync?: (raw: Record<string, unknown>, peerId: string) => void;
  onPauseAckTimeout?: (unackedPeerIds: string[]) => void;
}

export interface ConnectedPeerSummary {
  id: string;
  name: string;
  role: string;
  carIndex?: number;
  pingMs: number;
  pairingCode?: string;
  allowSpectatorRelay: boolean;
  ready: boolean;
  arenaLoaded: boolean;
}

export function buildConnectedPeerSummaryList(
  peerChannels: Map<string, P2PWebRTCChannel>,
  peerRoles: Map<string, string>,
  peerReadyStates: Map<string, { ready: boolean; arenaLoaded: boolean }>,
  peerPairingCodes: Map<string, string>
): ConnectedPeerSummary[] {
  const list: ConnectedPeerSummary[] = [];
  for (const [peerId, ch] of peerChannels.entries()) {
    if (ch.connected || ch.isOpen) {
      const readyInfo = peerReadyStates.get(peerId) || { ready: false, arenaLoaded: false };
      list.push({
        id: peerId,
        name: ch.peerName || 'Player',
        role: peerRoles.get(peerId) || 'player',
        carIndex: typeof ch.carIndex === 'number' ? ch.carIndex : undefined,
        pingMs: Math.round(ch.measuredRttMs || ch.rttMs || 0),
        pairingCode: ch.pairingCode || peerPairingCodes.get(peerId) || undefined,
        allowSpectatorRelay: Boolean(ch.allowSpectatorRelay),
        ready: readyInfo.ready,
        arenaLoaded: readyInfo.arenaLoaded,
      });
    }
  }
  return list;
}

export function stepHostPauseAckLoop(
  peerChannels: Map<string, P2PWebRTCChannel>,
  pauseAckController: HostPauseAckController,
  nowMs: number,
  onPauseAckTimeout?: (unackedPeerIds: string[]) => void
): void {
  pauseAckController.tick(nowMs, {
    sendPauseStateSyncToPeer: (peerId, payload) => {
      const ch = peerChannels.get(peerId);
      if (ch && (ch.connected || ch.isOpen)) {
        ch.sendPauseStateSync(payload as unknown as Record<string, unknown>);
      }
    },
    broadcastPresencePing: (payload) => {
      for (const ch of peerChannels.values()) {
        if (ch.connected || ch.isOpen) {
          ch.sendPresencePing(payload as unknown as Record<string, unknown>);
        }
      }
    },
    onPauseAckTimeout: (unackedPeerIds) => {
      console.warn(
        `[HostSessionController] Pause ACK timed out for peers: ${unackedPeerIds.join(', ')}`
      );
      onPauseAckTimeout?.(unackedPeerIds);
    },
  });
}

export function broadcastHostWorkspaceWithPauseSync(
  peerChannels: Map<string, P2PWebRTCChannel>,
  pauseAckController: HostPauseAckController,
  connectedPeerIds: string[],
  payload: GlobalWorkspaceBroadcastPayload | Record<string, unknown>
): { normalized: GlobalWorkspaceBroadcastPayload; sentCount: number } {
  const normalized = sanitizeGlobalWorkspaceBroadcast(payload);
  const pauseSync = pauseAckController.setPausedState({
    paused: normalized.playbackPaused,
    pausedAtTick: normalized.pausedAtTick,
    epoch: normalized.epoch,
    heartbeatHz: normalized.pauseHeartbeatHz,
    connectedPeerIds,
  });
  normalized.pauseSeq = pauseAckController.pauseSeq;
  let sentCount = 0;
  for (const ch of peerChannels.values()) {
    if (ch.connected || ch.isOpen) {
      if (ch.sendGlobalWorkspaceBroadcast(normalized as unknown as Record<string, unknown>)) {
        sentCount++;
      }
      if (pauseSync) {
        ch.sendPauseStateSync(pauseSync as unknown as Record<string, unknown>);
      }
    }
  }
  return { normalized, sentCount };
}
