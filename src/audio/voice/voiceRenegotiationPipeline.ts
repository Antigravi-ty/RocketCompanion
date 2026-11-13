import type {
  IVoicePeerConnectionPort,
  VoiceRenegotiationSignal,
} from './IVoiceAudioBridge.ts';

export interface VoiceRenegotiationPeerPort {
  pc: IVoicePeerConnectionPort | null;
  sendSignal?: (signal: VoiceRenegotiationSignal) => boolean | void;
  makingOffer: boolean;
  pendingRenegotiation: boolean;
  isPolite: boolean;
}

export async function renegotiateVoicePeer(peer: VoiceRenegotiationPeerPort): Promise<void> {
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
    console.warn('[WebRtcNativeVoiceBridge] Renegotiation offer failed:', err);
  } finally {
    peer.makingOffer = false;
    if (peer.pendingRenegotiation && peer.pc.signalingState === 'stable') {
      peer.pendingRenegotiation = false;
      void renegotiateVoicePeer(peer);
    }
  }
}

export async function handleVoiceOfferAnswerSignal(
  peer: VoiceRenegotiationPeerPort,
  signal: Extract<VoiceRenegotiationSignal, { kind: 'voice_offer' | 'voice_answer' }>
): Promise<void> {
  if (!peer.pc) return;
  if (signal.kind === 'voice_offer') {
    try {
      const offerCollision = peer.makingOffer || peer.pc.signalingState !== 'stable';
      if (offerCollision && !peer.isPolite) {
        return;
      }
      if (offerCollision && peer.isPolite) {
        await peer.pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
      }
      await peer.pc.setRemoteDescription(signal.sdp);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      peer.sendSignal?.({ kind: 'voice_answer', sdp: answer });
    } catch (err) {
      console.warn('[WebRtcNativeVoiceBridge] Handling voice_offer failed:', err);
    }
  } else if (signal.kind === 'voice_answer') {
    try {
      if (peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setRemoteDescription(signal.sdp);
      }
    } catch (err) {
      console.warn('[WebRtcNativeVoiceBridge] Handling voice_answer failed:', err);
    }
  }

  if (peer.pendingRenegotiation && peer.pc.signalingState === 'stable') {
    peer.pendingRenegotiation = false;
    void renegotiateVoicePeer(peer);
  }
}
