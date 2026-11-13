import type {
  IVoicePeerConnectionPort,
  VoiceAudioDiagnostic,
  VoiceRenegotiationSignal,
} from './IVoiceAudioBridge.ts';

export interface VoiceNegotiablePeer {
  peerId: string;
  pc: IVoicePeerConnectionPort | null;
  sendSignal?: (signal: VoiceRenegotiationSignal) => boolean | void;
  makingOffer: boolean;
  pendingRenegotiation: boolean;
  isPolite: boolean;
}

export async function renegotiateVoicePeer(
  peer: VoiceNegotiablePeer,
  onDiagnostic: (diag: VoiceAudioDiagnostic) => void
): Promise<void> {
  if (!peer.pc || !peer.sendSignal) return;
  if (peer.makingOffer || peer.pc.signalingState !== 'stable') {
    peer.pendingRenegotiation = true;
    return;
  }
  peer.pendingRenegotiation = false;
  peer.makingOffer = true;
  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    peer.sendSignal({ kind: 'voice_offer', sdp: offer });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[WebRtcNativeVoiceBridge] Renegotiation offer failed:', msg);
    onDiagnostic({
      level: 'warn',
      code: 'VOICE_NEGOTIATION_ERROR',
      message: `Voice offer renegotiation failed: ${msg}`,
      peerId: peer.peerId,
    });
  } finally {
    peer.makingOffer = false;
    if (peer.pendingRenegotiation && peer.pc.signalingState === 'stable') {
      peer.pendingRenegotiation = false;
      void renegotiateVoicePeer(peer, onDiagnostic);
    }
  }
}

export async function handleVoiceOfferSignal(
  peer: VoiceNegotiablePeer,
  sdp: RTCSessionDescriptionInit,
  onDiagnostic: (diag: VoiceAudioDiagnostic) => void
): Promise<void> {
  if (!peer.pc) return;
  try {
    const offerCollision = peer.makingOffer || peer.pc.signalingState !== 'stable';
    if (offerCollision && !peer.isPolite) {
      return;
    }
    if (offerCollision && peer.isPolite) {
      await peer.pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
    }
    await peer.pc.setRemoteDescription(sdp);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    peer.sendSignal?.({ kind: 'voice_answer', sdp: answer });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[WebRtcNativeVoiceBridge] Handling voice_offer failed:', msg);
    onDiagnostic({
      level: 'warn',
      code: 'VOICE_NEGOTIATION_ERROR',
      message: `Voice offer handling failed: ${msg}`,
      peerId: peer.peerId,
    });
  }
}

export async function handleVoiceAnswerSignal(
  peer: VoiceNegotiablePeer,
  sdp: RTCSessionDescriptionInit,
  onDiagnostic: (diag: VoiceAudioDiagnostic) => void
): Promise<void> {
  if (!peer.pc) return;
  try {
    if (peer.pc.signalingState === 'have-local-offer') {
      await peer.pc.setRemoteDescription(sdp);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[WebRtcNativeVoiceBridge] Handling voice_answer failed:', msg);
    onDiagnostic({
      level: 'warn',
      code: 'VOICE_NEGOTIATION_ERROR',
      message: `Voice answer handling failed: ${msg}`,
      peerId: peer.peerId,
    });
  }
}
