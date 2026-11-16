import {
  TELESTRATOR_WIRE_MSG_TYPE,
  decodeTelestratorClear,
  decodeTelestratorStroke,
  encodeHostPermissionSync,
  encodeTelestratorClear,
  encodeTelestratorHashAck,
  getTelestratorWireMsgType,
} from '../protocol/TelestratorWireCodec.ts';
import type { P2PWebRTCChannel } from './P2PWebRTCChannel.ts';

export interface HostTelestratorRelayContext {
  readonly allowClientDrawing: boolean;
  readonly allowedClientIds: ReadonlySet<string>;
  readonly peerChannels: ReadonlyMap<string, P2PWebRTCChannel>;
  readonly onLocalDeliver?: (senderPeerId: string, bytes: Uint8Array) => void;
}

export interface HostTelestratorRelayResult {
  accepted: boolean;
  forwardedCount: number;
  msgType: number | null;
}

export function handleHostInboundTelestratorBytes(
  ctx: HostTelestratorRelayContext,
  senderPeerId: string,
  senderCh: P2PWebRTCChannel,
  bytes: Uint8Array
): HostTelestratorRelayResult {
  const msgType = getTelestratorWireMsgType(bytes);
  if (msgType === null) {
    return { accepted: false, forwardedCount: 0, msgType: null };
  }

  if (
    msgType === TELESTRATOR_WIRE_MSG_TYPE.HOST_PERMISSION_SYNC ||
    msgType === TELESTRATOR_WIRE_MSG_TYPE.STROKE_HASH_ACK
  ) {
    return { accepted: false, forwardedCount: 0, msgType };
  }

  const isAllowed = ctx.allowClientDrawing || ctx.allowedClientIds.has(senderPeerId);
  if (!isAllowed) {
    const syncBytes = encodeHostPermissionSync({
      allowClientDrawing: false,
      strokesVisible: true,
      allowedClientIds: Array.from(ctx.allowedClientIds),
    });
    senderCh.sendTelestratorBytes(syncBytes, true);
    return { accepted: false, forwardedCount: 0, msgType };
  }

  let outboundBytes = bytes;
  if (msgType === TELESTRATOR_WIRE_MSG_TYPE.STROKE_COMMIT) {
    const decoded = decodeTelestratorStroke(bytes);
    if (decoded) {
      const ackBytes = encodeTelestratorHashAck({
        strokeId: decoded.stroke.id,
        hash: decoded.stroke.hash,
        matched: true,
      });
      senderCh.sendTelestratorBytes(ackBytes, true);
    }
  } else if (msgType === TELESTRATOR_WIRE_MSG_TYPE.STROKE_CLEAR) {
    const clearMsg = decodeTelestratorClear(bytes);
    if (clearMsg && clearMsg.scope === 'all') {
      outboundBytes = encodeTelestratorClear({
        scope: 'own',
        authorId: clearMsg.authorId || senderPeerId,
      });
    }
  }

  const reliable = msgType !== TELESTRATOR_WIRE_MSG_TYPE.STROKE_DRAFT;
  let forwardedCount = 0;
  for (const [peerId, otherCh] of ctx.peerChannels.entries()) {
    if (peerId === senderPeerId) continue;
    if ((otherCh.connected || otherCh.isOpen) && otherCh.sendTelestratorBytes(outboundBytes, reliable)) {
      forwardedCount++;
    }
  }

  ctx.onLocalDeliver?.(senderPeerId, outboundBytes);
  return { accepted: true, forwardedCount, msgType };
}
