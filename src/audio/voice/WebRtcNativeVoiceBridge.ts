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
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  analyserNode: AnalyserNode | null;
  analyserBuffer: Float32Array<ArrayBuffer> | null;
  hiddenAudioEl: HTMLAudioElement | null;
  onTrackListener: ((event: Event) => void) | null;
  onNegotiationListener: (() => void) | null;
  makingOffer: boolean;
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

function sampleAnalyserRms01(
  analyser: AnalyserNode | null,
  buffer: Float32Array<ArrayBuffer> | null
): number {
  if (!analyser || !buffer) return 0;
  try {
    analyser.getFloatTimeDomainData(buffer);
    let sumSq = 0;
    for (let i = 0; i < buffer.length; i++) {
      const s = buffer[i];
      if (Number.isFinite(s)) sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, buffer.length));
    return Math.max(0, Math.min(1, rms * 3.5));
  } catch {
    return 0;
  }
}

export class WebRtcNativeVoiceBridge implements IVoiceAudioBridge {
  private readonly getAudioContext: () => AudioContext | null;
  private readonly resolvePeerInitialMix?: WebRtcNativeVoiceBridgeOptions['resolvePeerInitialMix'];
  private readonly onStateChanged?: WebRtcNativeVoiceBridgeOptions['onStateChanged'];

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

  private masterGainNode: GainNode | null = null;
  private outputLimiterNode: DynamicsCompressorNode | null = null;
  private readonly peers = new Map<string, AttachedVoicePeer>();

  constructor(options: WebRtcNativeVoiceBridgeOptions) {
    this.getAudioContext = options.getAudioContext;
    this.resolvePeerInitialMix = options.resolvePeerInitialMix;
    this.onStateChanged = options.onStateChanged;
  }

  private ensureOutputBus(): { ctx: AudioContext; inputNode: GainNode } | null {
    const ctx = this.getAudioContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    if (!this.masterGainNode) {
      this.masterGainNode = ctx.createGain();
      this.masterGainNode.gain.value = this.masterVoiceVolumePct / 100;
      this.outputLimiterNode = ctx.createDynamicsCompressor();
      this.outputLimiterNode.threshold.value = -3;
      this.outputLimiterNode.knee.value = 6;
      this.outputLimiterNode.ratio.value = 12;
      this.outputLimiterNode.attack.value = 0.003;
      this.outputLimiterNode.release.value = 0.1;
      this.rewireOutputBus(ctx);
    }
    return { ctx, inputNode: this.masterGainNode };
  }

  private rewireOutputBus(ctx: AudioContext): void {
    if (!this.masterGainNode) return;
    try {
      this.masterGainNode.disconnect();
      this.outputLimiterNode?.disconnect();
    } catch {
      // Ignore disconnect errors when graph is not yet wired
    }
    if (this.outputLimiterEnabled && this.outputLimiterNode) {
      this.masterGainNode.connect(this.outputLimiterNode);
      this.outputLimiterNode.connect(ctx.destination);
    } else {
      this.masterGainNode.connect(ctx.destination);
    }
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
    if (this.masterGainNode) {
      this.masterGainNode.gain.value = this.masterVoiceVolumePct / 100;
    }
    this.emitStateChanged();
  }

  setOutputLimiterEnabled(enabled: boolean): void {
    this.outputLimiterEnabled = Boolean(enabled);
    const ctx = this.getAudioContext();
    if (ctx) {
      this.rewireOutputBus(ctx);
    }
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
    if (!peer.gainNode) return;
    peer.gainNode.gain.value = peer.muted ? 0 : peer.volumePct / 100;
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
      sourceNode: null,
      gainNode: null,
      analyserNode: null,
      analyserBuffer: null,
      hiddenAudioEl: null,
      onTrackListener: null,
      onNegotiationListener: null,
      makingOffer: false,
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
    this.cleanupPeerAudioGraph(peer);
    peer.remoteStream = stream;

    if (typeof Audio !== 'undefined') {
      const audioEl = new Audio();
      audioEl.srcObject = stream;
      audioEl.muted = true;
      audioEl.autoplay = true;
      void audioEl.play().catch(() => {});
      peer.hiddenAudioEl = audioEl;
    }

    const bus = this.ensureOutputBus();
    if (bus) {
      peer.sourceNode = bus.ctx.createMediaStreamSource(stream);
      peer.gainNode = bus.ctx.createGain();
      peer.analyserNode = bus.ctx.createAnalyser();
      peer.analyserNode.fftSize = 256;
      peer.analyserBuffer = new Float32Array(peer.analyserNode.fftSize);
      this.applyPeerGain(peer);

      peer.sourceNode.connect(peer.gainNode);
      peer.gainNode.connect(peer.analyserNode);
      peer.analyserNode.connect(bus.inputNode);
    }
    this.emitStateChanged();
  }

  private cleanupPeerAudioGraph(peer: AttachedVoicePeer): void {
    try {
      peer.sourceNode?.disconnect();
      peer.gainNode?.disconnect();
      peer.analyserNode?.disconnect();
    } catch {
      // Ignore
    }
    peer.sourceNode = null;
    peer.gainNode = null;
    peer.analyserNode = null;
    peer.analyserBuffer = null;
    peer.remoteStream = null;
    if (peer.hiddenAudioEl) {
      try {
        peer.hiddenAudioEl.pause();
        peer.hiddenAudioEl.srcObject = null;
      } catch {
        // Ignore
      }
      peer.hiddenAudioEl = null;
    }
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
    if (!peer.pc || !peer.sendSignal || peer.makingOffer) return;
    if (peer.pc.signalingState !== 'stable') return;
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      peer.sendSignal({ kind: 'voice_offer', sdp: offer });
    } catch (err) {
      console.warn('[WebRtcNativeVoiceBridge] Renegotiation offer failed:', err);
    } finally {
      peer.makingOffer = false;
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
  }

  getLocalMicLevel01(): number {
    if (!this.enabled || this.micMuted) return 0;
    return sampleAnalyserRms01(this.localMicAnalyser, this.localMicBuffer);
  }

  getPeerAudioLevel01(peerId: string): number {
    const peer = this.peers.get(peerId);
    if (!peer || peer.muted) return 0;
    return sampleAnalyserRms01(peer.analyserNode, peer.analyserBuffer);
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
        audioLevel01: peer.muted ? 0 : sampleAnalyserRms01(peer.analyserNode, peer.analyserBuffer),
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
    try {
      this.masterGainNode?.disconnect();
      this.outputLimiterNode?.disconnect();
    } catch {
      // Ignore
    }
    this.masterGainNode = null;
    this.outputLimiterNode = null;
  }
}
