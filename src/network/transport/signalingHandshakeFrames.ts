/**
 * signalingHandshakeFrames.ts
 * Pure HMAC-SHA256 authenticated handshake frame builders and verifiers
 * for 3-way ECDH signaling rendezvous (sig_hello, sig_hello_ack, sig_handshake_confirm).
 */

import {
  signRoomHandshakeFrame,
  verifyRoomHandshakeFrame,
  type DeterministicRoomContext,
} from './SignalingCryptoSession.ts';

export interface SignedHelloFrameInput {
  roomContext: DeterministicRoomContext;
  fromPeerId: string;
  senderName: string;
  role: string;
  allowSpectatorRelay: boolean;
  ecdhPub: string;
  nonce: string;
  relayId: string;
}

export interface SignedHelloAckFrameInput {
  roomContext: DeterministicRoomContext;
  targetPeerId: string;
  fromPeerId: string;
  senderName: string;
  ecdhPub: string;
  nonce: string;
  relayId: string;
  requireManualApproval: boolean;
}

export async function buildSignedHelloFrame(
  input: SignedHelloFrameInput
): Promise<Record<string, any>> {
  const hmac = await signRoomHandshakeFrame(input.roomContext, [
    'sig_hello',
    input.fromPeerId,
    input.senderName,
    input.role,
    input.ecdhPub,
    input.nonce,
  ]);

  return {
    type: 'sig_hello',
    fromPeerId: input.fromPeerId,
    senderName: input.senderName,
    role: input.role,
    allowSpectatorRelay: Boolean(input.allowSpectatorRelay),
    ecdhPub: input.ecdhPub,
    nonce: input.nonce,
    relayId: input.relayId,
    hmac,
    timestamp: Date.now(),
  };
}

export async function verifySignedHelloFrame(
  roomContext: DeterministicRoomContext,
  msg: Record<string, any>
): Promise<boolean> {
  return verifyRoomHandshakeFrame(
    roomContext,
    ['sig_hello', msg.fromPeerId, msg.senderName, msg.role, msg.ecdhPub, msg.nonce],
    msg.hmac
  );
}

export async function buildSignedHelloAckFrame(
  input: SignedHelloAckFrameInput
): Promise<Record<string, any>> {
  const hmac = await signRoomHandshakeFrame(input.roomContext, [
    'sig_hello_ack',
    input.targetPeerId,
    input.fromPeerId,
    input.senderName,
    input.ecdhPub,
    input.nonce,
  ]);

  return {
    type: 'sig_hello_ack',
    targetPeerId: input.targetPeerId,
    fromPeerId: input.fromPeerId,
    senderName: input.senderName,
    ecdhPub: input.ecdhPub,
    nonce: input.nonce,
    relayId: input.relayId,
    requireManualApproval: input.requireManualApproval,
    hmac,
    timestamp: Date.now(),
  };
}

export async function verifySignedHelloAckFrame(
  roomContext: DeterministicRoomContext,
  localPeerId: string,
  msg: Record<string, any>
): Promise<boolean> {
  return verifyRoomHandshakeFrame(
    roomContext,
    ['sig_hello_ack', localPeerId, msg.fromPeerId, msg.senderName, msg.ecdhPub, msg.nonce],
    msg.hmac
  );
}

export function buildHandshakeConfirmPayload(
  fromPeerId: string,
  senderName: string,
  role: string,
  allowSpectatorRelay: boolean,
  pairingCode: string,
  relayId: string
): Record<string, any> {
  return {
    type: 'sig_handshake_confirm',
    fromPeerId,
    senderName,
    role,
    allowSpectatorRelay: Boolean(allowSpectatorRelay),
    pairingCode,
    relayId,
    timestamp: Date.now(),
  };
}
