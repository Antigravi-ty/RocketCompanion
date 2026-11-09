/**
 * WebRTCConnection.ts
 * RTCPeerConnection lifecycle, SDP negotiation, and ICE candidate handling.
 */

import {
  injectLoopbackCandidate,
  injectLoopbackIntoSdp,
  ensureValidSdp,
  type IceCandidateDescriptor,
} from './SdpUtils.ts';
import { credentialBundleManager } from '../CredentialBundleManager.ts';

export interface SdpHandshakePayload {
  sdp?: string;
  candidates?: IceCandidateDescriptor[];
}

export interface WebRTCConnectionOptions {
  emitIceCandidate?: ((cand: IceCandidateDescriptor) => void) | null;
  handleConnectionStateChange?: ((state: RTCPeerConnectionState) => void) | null;
  handleIceConnectionStateChange?: ((state: RTCIceConnectionState) => void) | null;
  handleDataChannel?: ((event: RTCDataChannelEvent) => void) | null;
  broadcastSignal?: ((type: string, payload: Record<string, unknown>) => void) | null;
}

export class WebRTCConnection {
  options: WebRTCConnectionOptions;
  pc: RTCPeerConnection | null = null;
  localCandidates: IceCandidateDescriptor[] = [];
  pendingRemoteCandidates: IceCandidateDescriptor[] = [];
  gatheringPromise: Promise<void> | null = null;

  constructor(options: WebRTCConnectionOptions = {}) {
    this.options = options;
  }

  createPeerConnection(): RTCPeerConnection | null {
    if (typeof RTCPeerConnection === 'undefined') {
      console.warn(
        '[P2PWebRTCChannel] RTCPeerConnection is not supported in this environment, using direct channel.'
      );
      return null;
    }

    const customTurnServers = credentialBundleManager.getTurnIceServers();
    const config: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.services.mozilla.com:3478' },
        ...customTurnServers,
      ],
      iceCandidatePoolSize: 2,
    };

    this.pc = new RTCPeerConnection(config);
    this.localCandidates = [];
    this.pendingRemoteCandidates = [];

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candJson: IceCandidateDescriptor = event.candidate.toJSON
          ? (event.candidate.toJSON() as IceCandidateDescriptor)
          : {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
            };
        this.localCandidates.push(candJson);

        if (candJson.candidate && candJson.candidate.includes('.local')) {
          const clonedCandStr = candJson.candidate.replace(/\S+\.local/, '127.0.0.1');
          const clonedCand = {
            ...candJson,
            candidate: clonedCandStr,
            address: '127.0.0.1',
            ip: '127.0.0.1',
          };
          this.localCandidates.push(clonedCand);
        }

        this.localCandidates = injectLoopbackCandidate(
          this.localCandidates,
          this.pc?.localDescription?.sdp || ''
        );
        const loopbackCand = this.localCandidates[0];
        if (loopbackCand && this.localCandidates.length === 2) {
          this.options.broadcastSignal?.('ice_candidate', { candidate: loopbackCand });
        }

        const typ =
          candJson.type || (candJson.candidate ? candJson.candidate.split(' ')[7] : 'unknown');
        console.log(
          `[P2PWebRTCChannel] Candidate #${this.localCandidates.length} gathered (type: ${typ})`
        );
        this.options.broadcastSignal?.('ice_candidate', { candidate: candJson });
        if (typeof this.options.emitIceCandidate === 'function') {
          try {
            this.options.emitIceCandidate(candJson);
          } catch (err) {
            console.error('[P2PWebRTCChannel] Error in emitIceCandidate callback:', err);
          }
        }
      } else {
        this.localCandidates = injectLoopbackCandidate(
          this.localCandidates,
          this.pc?.localDescription?.sdp || ''
        );
        console.log(
          `[P2PWebRTCChannel] ICE candidate gathering complete (${this.localCandidates.length} total). Prioritized loopback candidate #0:`,
          this.localCandidates[0]?.candidate
        );
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc) this.options.handleConnectionStateChange?.(this.pc.connectionState);
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc) this.options.handleIceConnectionStateChange?.(this.pc.iceConnectionState);
    };

    if (this.options.handleDataChannel) {
      this.pc.ondatachannel = this.options.handleDataChannel;
    }

    return this.pc;
  }

  waitForIceGathering(timeoutMs = 1200): Promise<void> {
    if (!this.pc || this.pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.pc) {
          this.pc.removeEventListener('icegatheringstatechange', onStateChange);
          this.pc.removeEventListener('icecandidate', onCandidate);
        }
      };
      const onStateChange = () => {
        if (this.pc && this.pc.iceGatheringState === 'complete') {
          cleanup();
          resolve();
        }
      };
      const onCandidate = (event: RTCPeerConnectionIceEvent) => {
        if (!event.candidate) {
          cleanup();
          resolve();
        }
      };
      this.pc!.addEventListener('icegatheringstatechange', onStateChange);
      this.pc!.addEventListener('icecandidate', onCandidate);

      timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
    });
  }

  async addRemoteCandidate(candJson: IceCandidateDescriptor | null | undefined): Promise<void> {
    if (!candJson) return;
    if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
      try {
        const c =
          typeof RTCIceCandidate !== 'undefined'
            ? new RTCIceCandidate(candJson as RTCIceCandidateInit)
            : (candJson as RTCIceCandidateInit);
        await this.pc.addIceCandidate(c);
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to add ICE candidate:', err);
      }
    } else {
      if (!this.pendingRemoteCandidates) this.pendingRemoteCandidates = [];
      this.pendingRemoteCandidates.push(candJson);
    }
  }

  async flushPendingCandidates(): Promise<void> {
    if (!this.pc || !this.pendingRemoteCandidates || this.pendingRemoteCandidates.length === 0) {
      return;
    }
    const queued = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    for (const cand of queued) {
      try {
        const c =
          typeof RTCIceCandidate !== 'undefined'
            ? new RTCIceCandidate(cand as RTCIceCandidateInit)
            : (cand as RTCIceCandidateInit);
        await this.pc.addIceCandidate(c);
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Failed to add queued ICE candidate:', err);
      }
    }
  }

  async createOfferDescription(): Promise<string> {
    if (!this.pc) return '';
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceGathering(1200);

    let sdp = this.pc.localDescription?.sdp || '';
    this.localCandidates = injectLoopbackCandidate(this.localCandidates, sdp);
    const loopbackCand = (this.localCandidates || []).find((c) =>
      (c.candidate || '').includes('127.0.0.1')
    );
    if (loopbackCand && sdp) {
      sdp = injectLoopbackIntoSdp(sdp, loopbackCand);
    }
    return ensureValidSdp(sdp);
  }

  async applyRemoteOfferAndCreateAnswer(offerData: SdpHandshakePayload): Promise<string> {
    if (!this.pc || !offerData?.sdp) return '';

    let remoteSdp = ensureValidSdp(offerData.sdp);
    const remoteLoopback = Array.isArray(offerData.candidates)
      ? offerData.candidates.find((c: IceCandidateDescriptor) =>
          (c?.candidate || c?.address || c?.ip || '').includes('127.0.0.1')
        )
      : null;
    if (remoteLoopback) {
      remoteSdp = injectLoopbackIntoSdp(remoteSdp, remoteLoopback);
    }
    remoteSdp = ensureValidSdp(remoteSdp);

    await this.pc.setRemoteDescription(
      new RTCSessionDescription({
        type: 'offer',
        sdp: remoteSdp,
      })
    );
    await this.flushPendingCandidates();

    if (Array.isArray(offerData.candidates)) {
      const sortedCandidates = [...offerData.candidates].sort((a, b) => {
        const aIs127 = (a?.candidate || a?.address || a?.ip || '').includes('127.0.0.1');
        const bIs127 = (b?.candidate || b?.address || b?.ip || '').includes('127.0.0.1');
        if (aIs127 && !bIs127) return -1;
        if (!aIs127 && bIs127) return 1;
        return 0;
      });
      for (const cand of sortedCandidates) {
        await this.addRemoteCandidate(cand);
      }
    }

    await this.flushPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIceGathering(1200);

    let sdp = this.pc.localDescription?.sdp || '';
    this.localCandidates = injectLoopbackCandidate(this.localCandidates, sdp);
    const loopbackCand = (this.localCandidates || []).find((c) =>
      (c.candidate || '').includes('127.0.0.1')
    );
    if (loopbackCand && sdp) {
      sdp = injectLoopbackIntoSdp(sdp, loopbackCand);
    }
    return ensureValidSdp(sdp);
  }

  async applyRemoteAnswer(answerData: SdpHandshakePayload): Promise<void> {
    if (!this.pc || this.pc.signalingState === 'stable') {
      return;
    }
    if (!answerData?.sdp) return;

    let remoteSdp = ensureValidSdp(answerData.sdp);
    const remoteLoopback = Array.isArray(answerData.candidates)
      ? answerData.candidates.find((c: IceCandidateDescriptor) =>
          (c?.candidate || c?.address || c?.ip || '').includes('127.0.0.1')
        )
      : null;
    if (remoteLoopback) {
      remoteSdp = injectLoopbackIntoSdp(remoteSdp, remoteLoopback);
    }
    remoteSdp = ensureValidSdp(remoteSdp);

    await this.pc.setRemoteDescription(
      new RTCSessionDescription({
        type: 'answer',
        sdp: remoteSdp,
      })
    );
    await this.flushPendingCandidates();

    if (Array.isArray(answerData.candidates)) {
      const sortedCandidates = [...answerData.candidates].sort((a, b) => {
        const aIs127 = (a?.candidate || a?.address || a?.ip || '').includes('127.0.0.1');
        const bIs127 = (b?.candidate || b?.address || b?.ip || '').includes('127.0.0.1');
        if (aIs127 && !bIs127) return -1;
        if (!aIs127 && bIs127) return 1;
        return 0;
      });
      for (const cand of sortedCandidates) {
        await this.addRemoteCandidate(cand);
      }
    }
    await this.flushPendingCandidates();
  }

  destroy(): void {
    if (this.pc) {
      try {
        this.pc.close();
      } catch (err) {
        console.warn('[P2PWebRTCChannel] Error closing peerConnection:', err);
      }
      this.pc = null;
    }
    this.localCandidates = [];
    this.pendingRemoteCandidates = [];
  }
}
