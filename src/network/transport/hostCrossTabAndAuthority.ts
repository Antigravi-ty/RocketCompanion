import type { CarControlsInput } from '../protocol/InputPacketCodec.ts';
import type { InputAuthorityMode } from '../protocol/GlobalWorkspaceProtocol.ts';
import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';
import { CrossTabSignaling } from './webrtc/CrossTabSignaling.ts';

export interface ClientAuthorityFrameSnapshot {
  authorityEpoch: number;
  tick: number;
  peerId: string;
  snapshot: Float32Array;
  acknowledgedControls?: Array<{ carIndex: number; controls: CarControlsInput }>;
  receivedAtMs: number;
}

function sanitizeAckControls(
  raw: unknown
): Array<{ carIndex: number; controls: CarControlsInput }> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Array<{ carIndex: number; controls: CarControlsInput }> = [];
  for (let i = 0; i < raw.length && i < 8; i++) {
    const item = raw[i] as { carIndex?: unknown; controls?: unknown } | null | undefined;
    if (!item || typeof item !== 'object' || !item.controls || typeof item.controls !== 'object') {
      continue;
    }
    const carIndex =
      typeof item.carIndex === 'number' && Number.isFinite(item.carIndex)
        ? Math.max(0, Math.min(7, Math.floor(item.carIndex)))
        : 0;
    const c = item.controls as Record<string, unknown>;
    out.push({
      carIndex,
      controls: {
        throttle: typeof c.throttle === 'number' ? c.throttle : 0,
        steer: typeof c.steer === 'number' ? c.steer : 0,
        pitch: typeof c.pitch === 'number' ? c.pitch : 0,
        yaw: typeof c.yaw === 'number' ? c.yaw : 0,
        roll: typeof c.roll === 'number' ? c.roll : 0,
        jump: Boolean(c.jump),
        boost: Boolean(c.boost),
        handbrake: Boolean(c.handbrake),
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

export class HostInputAuthorityTracker {
  authorityEpoch = 0;
  activeInputPeerId = 'host';
  clientInputEnabled = false;
  authorityMode: InputAuthorityMode = 'fpv_master_slave';
  latestFrame: ClientAuthorityFrameSnapshot | null = null;
  latestAcknowledgedControls: Array<{ carIndex: number; controls: CarControlsInput }> | null = null;
  pendingFrames: ClientAuthorityFrameSnapshot[] = [];
  lastStudentInputAtMs = 0;
  lastStudentPeerId = '';
  lastStudentHasActiveInput = false;

  recordStudentInputProbe(
    peerId: string,
    hasActiveInput: boolean,
    nowMs = performance.now()
  ): void {
    this.lastStudentPeerId = peerId;
    this.lastStudentHasActiveInput = Boolean(hasActiveInput);
    if (this.lastStudentHasActiveInput) {
      this.lastStudentInputAtMs = nowMs;
    }
  }

  hasRecentStudentInput(nowMs = performance.now(), maxAgeMs = 250): boolean {
    if (!this.lastStudentHasActiveInput || this.lastStudentInputAtMs <= 0) return false;
    return nowMs - this.lastStudentInputAtMs <= maxAgeMs;
  }

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
    this.clientInputEnabled = Boolean(enabled);
    this.activeInputPeerId = enabled && targetPeerId !== 'host' ? targetPeerId || 'any' : 'host';
    if (mode === 'explicit' || mode === 'fpv_master_slave') {
      this.authorityMode = mode;
    }
    return {
      authorityEpoch: this.authorityEpoch,
      activeInputPeerId: this.activeInputPeerId,
      authorityMode: this.authorityMode,
      clientInputEnabled: this.clientInputEnabled,
    };
  }

  syncFromHandover(state: {
    authorityEpoch: number;
    activeInputPeerId: string;
    authorityMode: InputAuthorityMode;
    clientInputEnabled: boolean;
  }): void {
    this.authorityEpoch = state.authorityEpoch;
    this.activeInputPeerId = state.activeInputPeerId;
    this.authorityMode = state.authorityMode;
    this.clientInputEnabled = state.clientInputEnabled;
  }

  ingestFrame(peerId: string, raw: Record<string, unknown>, nowMs = performance.now()): boolean {
    if (this.activeInputPeerId === 'host') return false;
    if (this.activeInputPeerId !== 'any' && this.activeInputPeerId !== peerId) return false;
    const epoch = typeof raw.authorityEpoch === 'number' ? Math.round(raw.authorityEpoch) : -1;
    if (epoch !== this.authorityEpoch) return false;
    if (!Array.isArray(raw.snapshot) || raw.snapshot.length < 22) return false;
    const acknowledgedControls = sanitizeAckControls(raw.acknowledgedControls);
    const frame: ClientAuthorityFrameSnapshot = {
      authorityEpoch: epoch,
      tick: typeof raw.tick === 'number' && Number.isFinite(raw.tick) ? Math.floor(raw.tick) : 0,
      peerId,
      snapshot: new Float32Array(raw.snapshot as number[]),
      acknowledgedControls,
      receivedAtMs: nowMs,
    };
    this.latestFrame = frame;
    this.latestAcknowledgedControls = acknowledgedControls ?? null;
    this.pendingFrames.push(frame);
    if (this.pendingFrames.length > 32) {
      this.pendingFrames.shift();
    }
    return true;
  }

  consumeLatestFrame(): ClientAuthorityFrameSnapshot | null {
    const frame = this.latestFrame;
    this.latestFrame = null;
    this.pendingFrames.length = 0;
    return frame;
  }

  consumePendingFrames(): ClientAuthorityFrameSnapshot[] {
    if (this.pendingFrames.length === 0) return [];
    const out = this.pendingFrames.slice();
    this.pendingFrames.length = 0;
    this.latestFrame = null;
    return out;
  }

  reset(): void {
    this.authorityEpoch = 0;
    this.activeInputPeerId = 'host';
    this.clientInputEnabled = false;
    this.authorityMode = 'fpv_master_slave';
    this.latestFrame = null;
    this.latestAcknowledgedControls = null;
    this.pendingFrames.length = 0;
    this.lastStudentInputAtMs = 0;
    this.lastStudentPeerId = '';
    this.lastStudentHasActiveInput = false;
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

export function relayHostInboundCameraStateSync(params: {
  inputAuthority: HostInputAuthorityTracker;
  sourceChannel: P2PWebRTCChannel;
  activePeerId: string;
  raw: Record<string, unknown>;
  peerChannels: Map<string, P2PWebRTCChannel>;
  onDeliver?: (raw: Record<string, unknown>, peerId: string) => void;
}): void {
  const { inputAuthority, sourceChannel, activePeerId, raw, peerChannels, onDeliver } = params;
  const epoch = typeof raw.authorityEpoch === 'number' ? Math.round(raw.authorityEpoch) : -1;
  if (inputAuthority.activeInputPeerId === 'host') return;
  if (
    inputAuthority.activeInputPeerId !== 'any' &&
    inputAuthority.activeInputPeerId !== activePeerId
  ) {
    return;
  }
  if (epoch !== inputAuthority.authorityEpoch) return;
  onDeliver?.(raw, activePeerId);
  for (const other of peerChannels.values()) {
    if (other !== sourceChannel && other.isOpen) {
      other.sendCameraStateSync(raw);
    }
  }
}

export function broadcastHostCameraStateSync(
  peerChannels: Map<string, P2PWebRTCChannel>,
  payload: Record<string, unknown>
): number {
  let sentCount = 0;
  for (const ch of peerChannels.values()) {
    if (ch.isOpen && ch.sendCameraStateSync(payload)) {
      sentCount++;
    }
  }
  return sentCount;
}

export function finalizeLateJoinPeerSync(params: {
  ch: P2PWebRTCChannel;
  activePeerId: string;
  colorSlot: number;
  colorHex: string;
  onColorChange?: (carIdx: number, slotId: number | null, hex: string | null) => void;
  getWorkspace: () => Record<string, unknown> | null;
  getActivity: () => { activityId: string; epoch: number; [key: string]: unknown } | null;
  onPausePeerConnected: () => Record<string, unknown> | null;
}): void {
  const {
    ch,
    colorSlot,
    colorHex,
    onColorChange,
    getWorkspace,
    getActivity,
    onPausePeerConnected,
  } = params;
  ch.sendColorChange(colorSlot, colorHex, 0);
  if (ch.peerColorHex) {
    onColorChange?.(ch.carIndex ?? 1, ch.peerColorSlot, ch.peerColorHex);
  }
  syncPeerWorkspaceSnapshot(ch, getWorkspace, getActivity);
  const pauseSync = onPausePeerConnected();
  if (pauseSync) {
    ch.sendPauseStateSync(pauseSync);
  }
  scheduleLateJoinWorkspaceSync(ch, getWorkspace, getActivity);
}

export function bindHostPeerCameraAndRelayHandlers(params: {
  ch: P2PWebRTCChannel;
  fallbackPeerId: string;
  inputAuthority: HostInputAuthorityTracker;
  peerChannels: Map<string, P2PWebRTCChannel>;
  onDeliverCamera?: (raw: Record<string, unknown>, peerId: string) => void;
  onColorChange?: (carIdx: number, slotId: number | null, hex: string | null) => void;
}): void {
  const { ch, fallbackPeerId, inputAuthority, peerChannels, onDeliverCamera, onColorChange } =
    params;
  ch.onClientAuthorityFrame = (raw) => {
    inputAuthority.ingestFrame(ch.peerId || fallbackPeerId, raw);
  };
  ch.onCameraStateSync = (raw) => {
    relayHostInboundCameraStateSync({
      inputAuthority,
      sourceChannel: ch,
      activePeerId: ch.peerId || fallbackPeerId,
      raw,
      peerChannels,
      onDeliver: onDeliverCamera,
    });
  };
  ch.onColorChange = (msg: { carIndex?: number; slotId: number | null; hex: string | null }) => {
    const cIdx = msg.carIndex ?? ch.carIndex ?? 1;
    if (msg.slotId !== undefined) ch.peerColorSlot = msg.slotId;
    if (msg.hex !== undefined) ch.peerColorHex = msg.hex;
    onColorChange?.(cIdx, msg.slotId, msg.hex);
  };
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
