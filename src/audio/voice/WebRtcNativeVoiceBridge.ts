import {
  clampVoiceVolumePct,
  VOICE_VOLUME_DEFAULT_PCT,
  type IVoiceAudioBridge,
  type IVoicePeerConnectionPort,
  type VoiceBridgeStateSnapshot,
  type VoiceInputProcessingOptions,
  type VoicePeerAttachmentOptions,
  type VoicePeerStateSnapshot,
  type VoiceRenegotiationSignal,
} from './IVoiceAudioBridge.ts';
import {
  applyPeerPlaybackGain,
  bindPeerRemoteAudioGraph,
  cleanupPeerAudioGraph,
  createEmptyPeerAudioGraph,
  sampleAnalyserRms01,
  VoiceMasterOutputBus,
  type PeerAudioGraphHandles,
} from './voiceAudioGraph.ts';

interface AttachedVoicePeer {
  peerId: string;
  playerId: string;
  displayName: string;
  isRegistered: boolean;
  pc: IVoicePeerConnectionPort | null;
  sendSignal?: (signal: VoiceRenegotiationSignal) => boolean | void;
  volumePct: number;
  muted: boolean;
  sender: RTCRtpSender | null;
  remoteStream: MediaStream | null;
  audioGraph: PeerAudioGraphHandles;
  onTrackListener: ((event: Event) => void) | null;
  onNegotiationListener: (() => void) | null;
  makingOffer: boolean;
  pendingRenegotiation: boolean;
  isPolite: boolean;
}

export interface WebRtcNativeVoiceBridgeOptions {
  getAudioContext: () => AudioContext | null;
  resolvePeerInitialMix?: (
    playerId: string,
    isRegistered: boolean
  ) => { volumePct?: number; muted?: boolean } | null;
  onStateChanged?: (snapshot: VoiceBridgeStateSnapshot) => void;
}

export class WebRtcNativeVoiceBridge implements IVoiceAudioBridge {
  private readonly getAudioContext: () => AudioContext | null;
  private readonly resolvePeerInitialMix?: WebRtcNativeVoiceBridgeOptions['resolvePeerInitialMix'];
  private readonly onStateChanged?: WebRtcNativeVoiceBridgeOptions['onStateChanged'];
  private readonly outputBus: VoiceMasterOutputBus;

  private enabled = false;
  private micMuted = false;
  private masterVoiceVolumePct = VOICE_VOLUME_DEFAULT_PCT;
  private outputLimiterEnabled = true;
  private inputProcessing: VoiceInputProcessingOptions = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  private localStream: MediaStream | null = null;
  private localMicSource: MediaStreamAudioSourceNode | null = null;
  private localMicAnalyser: AnalyserNode | null = null;
  private localMicBuffer: Float32Array<ArrayBuffer> | null = null;

  private readonly peers = new Map<string, AttachedVoicePeer>();

  constructor(options: WebRtcNativeVoiceBridgeOptions) {
    this.getAudioContext = options.getAudioContext;
    this.resolvePeerInitialMix = options.resolvePeerInitialMix;
    this.onStateChanged = options.onStateChanged;
    this.outputBus = new VoiceMasterOutputBus(options.getAudioContext);
  }

  async enableVoice(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this environment.');
    }
    this.stopLocalStream();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: this.inputProcessing.echoCancellation,
        noiseSuppression: this.inputProcessing.noiseSuppression,
        autoGainControl: this.inputProcessing.autoGainControl,
      },
      video: false,
    });

    this.localStream = stream;
    this.enabled = true;
    for (const track of stream.getAudioTracks()) {
      track.enabled = !this.micMuted;
    }

    const ctx = this.getAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      this.localMicSource = ctx.createMediaStreamSource(stream);
      this.localMicAnalyser = ctx.createAnalyser();
      this.localMicAnalyser.fftSize = 256;
      this.localMicBuffer = new Float32Array(this.localMicAnalyser.fftSize);
      this.localMicSource.connect(this.localMicAnalyser);
    }

    for (const peer of this.peers.values()) {
      await this.syncLocalTrackToPeer(peer);
    }
    this.emitStateChanged();
  }

  disableVoice(): void {
    this.enabled = false;
    this.stopLocalStream();
    for (const peer of this.peers.values()) {
      if (peer.pc && peer.sender) {
        try {
          peer.pc.removeTrack(peer.sender);
        } catch {
          // Ignore removeTrack errors if peer connection already closed
        }
        peer.sender = null;
        void this.renegotiatePeer(peer);
      }
    }
    this.emitStateChanged();
  }

  private stopLocalStream(): void {
    try {
      this.localMicSource?.disconnect();
    } catch {
      // Ignore
    }
    this.localMicSource = null;
    this.localMicAnalyser = null;
    this.localMicBuffer = null;
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
      this.localStream = null;
    }
  }

  isVoiceEnabled(): boolean {
    return this.enabled;
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = Boolean(muted);
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !this.micMuted;
      }
    }
    this.emitStateChanged();
  }

  isMicMuted(): boolean {
    return this.micMuted;
  }

  async updateInputProcessing(options: Partial<VoiceInputProcessingOptions>): Promise<void> {
    this.inputProcessing = { ...this.inputProcessing, ...options };
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        if (typeof track.applyConstraints === 'function') {
          try {
            await track.applyConstraints({
              echoCancellation: this.inputProcessing.echoCancellation,
              noiseSuppression: this.inputProcessing.noiseSuppression,
              autoGainControl: this.inputProcessing.autoGainControl,
            });
          } catch (err) {
            console.warn('[WebRtcNativeVoiceBridge] applyConstraints failed:', err);
          }
        }
      }
    }
    this.emitStateChanged();
  }

  setMasterVoiceVolumePct(volumePct: number): void {
    this.masterVoiceVolumePct = clampVoiceVolumePct(volumePct);
    this.outputBus.setMasterVolumePct(this.masterVoiceVolumePct);
    for (const peer of this.peers.values()) {
      this.applyPeerGain(peer);
    }
    this.emitStateChanged();
  }

  setOutputLimiterEnabled(enabled: boolean): void {
    this.outputLimiterEnabled = Boolean(enabled);
    this.outputBus.setOutputLimiterEnabled(this.outputLimiterEnabled);
    this.emitStateChanged();
  }

  setPeerVolumePct(peerOrPlayerId: string, volumePct: number): void {
    const clamped = clampVoiceVolumePct(volumePct);
    for (const peer of this.peers.values()) {
      if (peer.peerId === peerOrPlayerId || peer.playerId === peerOrPlayerId) {
        peer.volumePct = clamped;
        this.applyPeerGain(peer);
      }
    }
    this.emitStateChanged();
  }

  setPeerMuted(peerOrPlayerId: string, muted: boolean): void {
    const nextMuted = Boolean(muted);
    for (const peer of this.peers.values()) {
      if (peer.peerId === peerOrPlayerId || peer.playerId === peerOrPlayerId) {
        peer.muted = nextMuted;
        this.applyPeerGain(peer);
      }
    }
    this.emitStateChanged();
  }

  private applyPeerGain(peer: AttachedVoicePeer): void {
    applyPeerPlaybackGain(
      peer.audioGraph,
      this.outputBus.isContextRunning(),
      peer.volumePct,
      peer.muted,
      this.masterVoiceVolumePct
    );
  }

  attachPeer(options: VoicePeerAttachmentOptions): void {
    const existing = this.peers.get(options.peerId);
    if (existing) {
      this.detachPeer(options.peerId);
    }

    const savedMix = this.resolvePeerInitialMix?.(options.playerId, options.isRegistered);
    const initialVol = clampVoiceVolumePct(
      options.initialVolumePct ?? savedMix?.volumePct ?? VOICE_VOLUME_DEFAULT_PCT
    );
    const initialMuted = Boolean(options.initialMuted ?? savedMix?.muted ?? false);

    const peer: AttachedVoicePeer = {
      peerId: options.peerId,
      playerId: options.playerId,
      displayName: options.displayName,
      isRegistered: options.isRegistered,
      pc: options.pc,
      sendSignal: options.sendSignal,
      volumePct: initialVol,
      muted: initialMuted,
      sender: null,
      remoteStream: null,
      audioGraph: createEmptyPeerAudioGraph(),
      onTrackListener: null,
      onNegotiationListener: null,
      makingOffer: false,
      pendingRenegotiation: false,
      isPolite: options.isPolite ?? options.peerId === 'host',
    };

    if (peer.pc) {
      const onTrack = (ev: Event) => {
        const trackEvent = ev as RTCTrackEvent;
        if (trackEvent.track?.kind !== 'audio') return;
        const stream =
          trackEvent.streams && trackEvent.streams[0]
            ? trackEvent.streams[0]
            : new MediaStream([trackEvent.track]);
        this.bindRemoteStream(peer, stream);
      };
      const onNegotiation = () => {
        if (this.enabled && peer.sendSignal) {
          void this.renegotiatePeer(peer);
        }
      };
      peer.onTrackListener = onTrack;
      peer.onNegotiationListener = onNegotiation;
      peer.pc.addEventListener('track', onTrack);
      peer.pc.addEventListener('negotiationneeded', onNegotiation);
    }

    this.peers.set(options.peerId, peer);
    if (this.enabled && this.localStream) {
      void this.syncLocalTrackToPeer(peer);
    }
    this.emitStateChanged();
  }

  detachPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (peer.pc) {
      if (peer.onTrackListener) peer.pc.removeEventListener('track', peer.onTrackListener);
      if (peer.onNegotiationListener) {
        peer.pc.removeEventListener('negotiationneeded', peer.onNegotiationListener);
      }
      if (peer.sender) {
        try {
          peer.pc.removeTrack(peer.sender);
        } catch {
          // Ignore
        }
      }
    }
    this.cleanupPeerAudioGraph(peer);
    this.peers.delete(peerId);
    this.emitStateChanged();
  }

  private bindRemoteStream(peer: AttachedVoicePeer, stream: MediaStream): void {
    peer.remoteStream = stream;
    bindPeerRemoteAudioGraph(
      peer.audioGraph,
      stream,
      this.outputBus,
      peer.volumePct,
      peer.muted,
      this.masterVoiceVolumePct
    );
    this.emitStateChanged();
  }

  private cleanupPeerAudioGraph(peer: AttachedVoicePeer): void {
    cleanupPeerAudioGraph(peer.audioGraph);
    peer.remoteStream = null;
  }

  private async syncLocalTrackToPeer(peer: AttachedVoicePeer): Promise<void> {
    if (!peer.pc || !this.localStream) return;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    if (peer.sender && typeof peer.sender.replaceTrack === 'function') {
      await peer.sender.replaceTrack(audioTrack);
      return;
    }
    peer.sender = peer.pc.addTrack(audioTrack, this.localStream);
    await this.renegotiatePeer(peer);
  }

  private async renegotiatePeer(peer: AttachedVoicePeer): Promise<void> {
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
        void this.renegotiatePeer(peer);
      }
    }
  }

  async handleRenegotiationSignal(peerId: string, signal: VoiceRenegotiationSignal): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    if (signal.kind === 'voice_identity') {
      peer.playerId = signal.playerId || peer.peerId;
      peer.isRegistered = Boolean(signal.isRegistered);
      peer.displayName = signal.displayName || peer.displayName;
      const savedMix = this.resolvePeerInitialMix?.(peer.playerId, peer.isRegistered);
      if (savedMix) {
        if (typeof savedMix.volumePct === 'number') {
          peer.volumePct = clampVoiceVolumePct(savedMix.volumePct);
        }
        if (typeof savedMix.muted === 'boolean') {
          peer.muted = savedMix.muted;
        }
        this.applyPeerGain(peer);
      }
      this.emitStateChanged();
      return;
    }

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
      void this.renegotiatePeer(peer);
    }
  }

  getLocalMicLevel01(): number {
    if (!this.enabled || this.micMuted) return 0;
    return sampleAnalyserRms01(this.localMicAnalyser, this.localMicBuffer);
  }

  getPeerAudioLevel01(peerId: string): number {
    const peer = this.peers.get(peerId);
    if (!peer || peer.muted) return 0;
    return sampleAnalyserRms01(peer.audioGraph.analyserNode, peer.audioGraph.analyserBuffer);
  }

  getPeers(): VoicePeerStateSnapshot[] {
    const list: VoicePeerStateSnapshot[] = [];
    for (const peer of this.peers.values()) {
      list.push({
        peerId: peer.peerId,
        playerId: peer.playerId,
        displayName: peer.displayName,
        isRegistered: peer.isRegistered,
        volumePct: peer.volumePct,
        muted: peer.muted,
        hasRemoteAudio: Boolean(peer.remoteStream),
        audioLevel01: peer.muted
          ? 0
          : sampleAnalyserRms01(peer.audioGraph.analyserNode, peer.audioGraph.analyserBuffer),
      });
    }
    return list;
  }

  getSnapshot(): VoiceBridgeStateSnapshot {
    return {
      enabled: this.enabled,
      micMuted: this.micMuted,
      masterVoiceVolumePct: this.masterVoiceVolumePct,
      outputLimiterEnabled: this.outputLimiterEnabled,
      inputProcessing: { ...this.inputProcessing },
      localMicLevel01: this.getLocalMicLevel01(),
      peers: this.getPeers(),
    };
  }

  private emitStateChanged(): void {
    this.onStateChanged?.(this.getSnapshot());
  }

  dispose(): void {
    this.disableVoice();
    for (const peerId of [...this.peers.keys()]) {
      this.detachPeer(peerId);
    }
    this.outputBus.dispose();
  }
}
