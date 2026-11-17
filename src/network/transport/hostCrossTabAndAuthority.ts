import type { InputAuthorityMode } from '../protocol/GlobalWorkspaceProtocol.ts';
import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';
import { CrossTabSignaling } from './webrtc/CrossTabSignaling.ts';

export interface ClientAuthorityFrameSnapshot {
  authorityEpoch: number;
  tick: number;
  peerId: string;
  snapshot: Float32Array;
  receivedAtMs: number;
}

export class HostInputAuthorityTracker {
  authorityEpoch = 0;
  activeInputPeerId = 'host';
  authorityMode: InputAuthorityMode = 'fpv_master_slave';
  latestFrame: ClientAuthorityFrameSnapshot | null = null;

  setAuthority(
    enabled: boolean,
    targetPeerId = 'any',
    mode?: InputAuthorityMode
  ): {
    authorityEpoch: number;
    activeInputPeerId: string;
    authorityMode: InputAuthorityMode;
    clientInputEnabled: boolean;
  } {
    this.authorityEpoch += 1;
    this.activeInputPeerId = enabled ? targetPeerId || 'any' : 'host';
    if (mode === 'explicit' || mode === 'fpv_master_slave') {
      this.authorityMode = mode;
    }
    if (!enabled) {
      this.latestFrame = null;
    }
    return {
      authorityEpoch: this.authorityEpoch,
      activeInputPeerId: this.activeInputPeerId,
      authorityMode: this.authorityMode,
      clientInputEnabled: enabled,
    };
  }

  ingestFrame(peerId: string, raw: Record<string, unknown>, nowMs = performance.now()): boolean {
    if (this.activeInputPeerId === 'host') return false;
    if (this.activeInputPeerId !== 'any' && this.activeInputPeerId !== peerId) return false;
    const epoch = typeof raw.authorityEpoch === 'number' ? Math.round(raw.authorityEpoch) : -1;
    if (epoch !== this.authorityEpoch) return false;
    if (!Array.isArray(raw.snapshot) || raw.snapshot.length < 22) return false;
    this.latestFrame = {
      authorityEpoch: epoch,
      tick: typeof raw.tick === 'number' && Number.isFinite(raw.tick) ? Math.floor(raw.tick) : 0,
      peerId,
      snapshot: new Float32Array(raw.snapshot as number[]),
      receivedAtMs: nowMs,
    };
    return true;
  }

  consumeLatestFrame(): ClientAuthorityFrameSnapshot | null {
    const frame = this.latestFrame;
    this.latestFrame = null;
    return frame;
  }

  reset(): void {
    this.authorityEpoch = 0;
    this.activeInputPeerId = 'host';
    this.authorityMode = 'fpv_master_slave';
    this.latestFrame = null;
  }
}

export interface HostCrossTabDiscoveryPort {
  readonly roomId: string;
  readonly playerName: string;
  readonly colorSlot: number;
  readonly colorHex: string;
  readonly offerToken: string;
  readonly peerChannels: Map<string, P2PWebRTCChannel>;
  readonly peerRoles: Map<string, string>;
  readonly peerReadyStates: Map<string, { ready: boolean; arenaLoaded: boolean }>;
  createPeerChannel: (peerId: string, peerName: string, role: string) => P2PWebRTCChannel;
}

export function promotePrewarmedPeerChannel(
  peerChannels: Map<string, P2PWebRTCChannel>,
  peerRoles: Map<string, string>,
  peerReadyStates: Map<string, { ready: boolean; arenaLoaded: boolean }>,
  peerId: string,
  peerName: string,
  roleOverride?: string,
  metadata?: { pairingCode?: string; allowSpectatorRelay?: boolean },
  requireHaveLocalOffer = false
): P2PWebRTCChannel | null {
  const prewarmed = peerChannels.get('peer_1');
  if (!prewarmed || prewarmed.connected || prewarmed.isOpen) return null;
  if (
    requireHaveLocalOffer &&
    prewarmed.connection.pc &&
    prewarmed.connection.pc.signalingState !== 'have-local-offer'
  ) {
    return null;
  }
  peerChannels.delete('peer_1');
  const prevRole = roleOverride || peerRoles.get('peer_1') || 'player';
  peerRoles.delete('peer_1');
  const prevReady = peerReadyStates.get('peer_1') || { ready: false, arenaLoaded: false };
  peerReadyStates.delete('peer_1');
  prewarmed.peerId = peerId;
  prewarmed.peerName = peerName;
  if (metadata?.pairingCode !== undefined) {
    prewarmed.pairingCode = metadata.pairingCode || null;
  }
  if (metadata?.allowSpectatorRelay !== undefined) {
    prewarmed.allowSpectatorRelay = metadata.allowSpectatorRelay !== false;
  }
  peerChannels.set(peerId, prewarmed);
  peerRoles.set(peerId, prevRole);
  peerReadyStates.set(peerId, prevReady);
  return prewarmed;
}

export function resolveHostCrossTabPeerChannel(
  port: HostCrossTabDiscoveryPort,
  peerId: string,
  peerName: string
): P2PWebRTCChannel | null {
  const existing = port.peerChannels.get(peerId);
  if (existing) {
    return existing.connected || existing.isOpen ? null : existing;
  }
  return (
    promotePrewarmedPeerChannel(
      port.peerChannels,
      port.peerRoles,
      port.peerReadyStates,
      peerId,
      peerName
    ) ?? port.createPeerChannel(peerId, peerName, 'player')
  );
}

export function createHostCrossTabDiscovery(port: HostCrossTabDiscoveryPort): CrossTabSignaling {
  const discovery = new CrossTabSignaling({ roomId: port.roomId });
  let fallbackSeq = 0;
  discovery.subscribeRoom((data) => {
    if (
      !data ||
      typeof data !== 'object' ||
      data instanceof Uint8Array ||
      data instanceof ArrayBuffer
    ) {
      return;
    }
    const msg = data as Record<string, unknown>;
    if (msg.type !== 'cross_tab_join') return;
    const rawPeerId =
      typeof msg.clientPeerId === 'string' && msg.clientPeerId
        ? msg.clientPeerId
        : typeof msg.senderId === 'string' && msg.senderId
          ? msg.senderId
          : `crosstab_${++fallbackSeq}`;
    const clientName =
      typeof msg.clientName === 'string' && msg.clientName ? msg.clientName : 'Player 2';
    const targetChannel = resolveHostCrossTabPeerChannel(port, rawPeerId, clientName);
    if (!targetChannel) return;
    const subRoomId = `${port.roomId}_peer_${rawPeerId}`;
    discovery.sendRoomMessage(
      {
        type: 'cross_tab_ack',
        targetPeerId: rawPeerId,
        subRoomId,
        hostName: port.playerName,
        hostColorSlot: port.colorSlot,
        hostColorHex: port.colorHex,
        offerToken: targetChannel.offerToken || port.offerToken,
      },
      'host'
    );
    targetChannel.initRoomChannel(subRoomId);
    targetChannel.handshake.activateCrossTabSession({
      peerName: clientName,
      peerColorSlot: typeof msg.clientColorSlot === 'number' ? msg.clientColorSlot : null,
      peerColorHex: typeof msg.clientColorHex === 'string' ? msg.clientColorHex : null,
    });
  });
  return discovery;
}

export function syncPeerWorkspaceSnapshot(
  ch: P2PWebRTCChannel,
  getWorkspace: () => Record<string, unknown> | null,
  getActivity: () => { activityId: string; epoch: number; [key: string]: unknown } | null
): void {
  if (!ch.isOpen) return;
  const act = getActivity();
  if (act && act.activityId !== 'freeplay') {
    ch.sendRoomActivitySwitch(act);
  }
  const ws = getWorkspace();
  if (ws) {
    ch.sendGlobalWorkspaceBroadcast(ws);
  }
}

export function scheduleLateJoinWorkspaceSync(
  ch: P2PWebRTCChannel,
  getWorkspace: () => Record<string, unknown> | null,
  getActivity: () => { activityId: string; epoch: number; [key: string]: unknown } | null
): void {
  const push = () => syncPeerWorkspaceSnapshot(ch, getWorkspace, getActivity);
  if (typeof setTimeout === 'function') {
    setTimeout(push, 60);
    setTimeout(push, 250);
  }
}
