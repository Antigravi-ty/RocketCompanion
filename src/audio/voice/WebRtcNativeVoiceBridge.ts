import type {
  IVoiceAudioBridge,
  VoiceChannelConfig,
  VoiceMicPermissionState,
  VoicePeerAudioState,
} from './voiceTypes.ts';

interface PeerAudioPipeline {
  readonly playerId: string;
  pc: RTCPeerConnection | null;
  senders: RTCRtpSender[];
  remoteStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  compressorNode: DynamicsCompressorNode | null;
  sinkAudioEl: HTMLAudioElement | null;
  volumePercent: number;
  muted: boolean;
}

function clampVolumePercent(pct: number): number {
  if (!Number.isFinite(pct)) return 100;
  return Math.max(0, Math.min(250, Math.round(pct)));
}

export class WebRtcNativeVoiceBridge implements IVoiceAudioBridge {
  private audioCtx: AudioContext | null = null;
  private localStream: MediaStream | null = null;
  private readonly peers = new Map<string, PeerAudioPipeline>();
  private config: VoiceChannelConfig = {
    enabled: false,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  };

  public async enable(): Promise<VoiceMicPermissionState> {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      this.config.enabled = false;
      return 'unavailable';
    }

    // Explicitly request mic access every time the user toggles Voice ON.
    this.stopLocalStream();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: this.config.echoCancellation,
          noiseSuppression: this.config.noiseSuppression,
          autoGainControl: this.config.autoGainControl,
          channelCount: 1,
        },
        video: false,
      });
      this.localStream = stream;
      this.config.enabled = true;
      this.ensureAudioContext();
      this.attachLocalTracksToAllPeers();
      return 'granted';
    } catch {
      this.config.enabled = false;
      return 'denied';
    }
  }

  public disable(): void {
    this.config.enabled = false;
    this.detachLocalTracksFromAllPeers();
    this.stopLocalStream();
  }

  public async setNoiseSuppression(enabled: boolean): Promise<void> {
    this.config.noiseSuppression = enabled;
    if (!this.localStream) return;
    for (const track of this.localStream.getAudioTracks()) {
      try {
        await track.applyConstraints({
          echoCancellation: this.config.echoCancellation,
          noiseSuppression: enabled,
          autoGainControl: this.config.autoGainControl,
        });
      } catch {
        // Ignore constraint errors on devices that do not support live reconfiguration
      }
    }
  }

  public attachPeerConnection(playerId: string, pc: RTCPeerConnection): void {
    const pipeline = this.ensurePeerPipeline(playerId);
    pipeline.pc = pc;
    this.preferOpusCodec(pc);

    pc.addEventListener('track', (ev: RTCTrackEvent) => {
      if (ev.track.kind !== 'audio') return;
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.attachRemoteStream(playerId, stream);
    });

    if (this.config.enabled && this.localStream) {
      this.attachLocalTracksToPeer(pipeline);
    }
  }

  public detachPeerConnection(playerId: string): void {
    const pipeline = this.peers.get(playerId);
    if (!pipeline) return;
    if (pipeline.pc) {
      for (const sender of pipeline.senders) {
        try {
          pipeline.pc.removeTrack(sender);
        } catch {
          // PeerConnection may already be closed
        }
      }
    }
    this.teardownRemoteAudio(pipeline);
    this.peers.delete(playerId);
  }

  public attachRemoteStream(playerId: string, stream: MediaStream): void {
    const pipeline = this.ensurePeerPipeline(playerId);
    this.teardownRemoteAudio(pipeline);
    pipeline.remoteStream = stream;

    const ctx = this.ensureAudioContext();
    if (ctx) {
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 12;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.15;

      gain.gain.value = pipeline.muted ? 0 : pipeline.volumePercent / 100;
      source.connect(gain);
      gain.connect(compressor);
      compressor.connect(ctx.destination);

      pipeline.sourceNode = source;
      pipeline.gainNode = gain;
      pipeline.compressorNode = compressor;
    }

    // Chromium requires a muted HTMLAudioElement sink on remote WebRTC MediaStreams for playback stability
    if (typeof Audio !== 'undefined') {
      const el = new Audio();
      el.srcObject = stream;
      el.muted = true;
      void el.play().catch(() => {});
      pipeline.sinkAudioEl = el;
    }
  }

  public setPeerVolume(playerId: string, volumePercent: number): void {
    const pipeline = this.ensurePeerPipeline(playerId);
    pipeline.volumePercent = clampVolumePercent(volumePercent);
    this.syncPeerGain(pipeline);
  }

  public setPeerMuted(playerId: string, muted: boolean): void {
    const pipeline = this.ensurePeerPipeline(playerId);
    pipeline.muted = muted;
    this.syncPeerGain(pipeline);
  }

  public getPeerStates(): readonly VoicePeerAudioState[] {
    const out: VoicePeerAudioState[] = [];
    for (const p of this.peers.values()) {
      out.push({
        playerId: p.playerId,
        volumePercent: p.volumePercent,
        muted: p.muted,
        hasRemoteAudio: p.remoteStream !== null,
      });
    }
    return out;
  }

  public dispose(): void {
    this.disable();
    for (const playerId of Array.from(this.peers.keys())) {
      this.detachPeerConnection(playerId);
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  private ensureAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.audioCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        this.audioCtx = new Ctor();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  private ensurePeerPipeline(playerId: string): PeerAudioPipeline {
    let p = this.peers.get(playerId);
    if (!p) {
      p = {
        playerId,
        pc: null,
        senders: [],
        remoteStream: null,
        sourceNode: null,
        gainNode: null,
        compressorNode: null,
        sinkAudioEl: null,
        volumePercent: 100,
        muted: false,
      };
      this.peers.set(playerId, p);
    }
    return p;
  }

  private syncPeerGain(pipeline: PeerAudioPipeline): void {
    if (!pipeline.gainNode || !this.audioCtx) return;
    const targetGain = pipeline.muted ? 0 : pipeline.volumePercent / 100;
    pipeline.gainNode.gain.setTargetAtTime(targetGain, this.audioCtx.currentTime, 0.015);
  }

  private attachLocalTracksToAllPeers(): void {
    for (const pipeline of this.peers.values()) {
      this.attachLocalTracksToPeer(pipeline);
    }
  }

  private attachLocalTracksToPeer(pipeline: PeerAudioPipeline): void {
    if (!pipeline.pc || !this.localStream) return;
    this.detachLocalTracksFromPeer(pipeline);
    for (const track of this.localStream.getAudioTracks()) {
      const sender = pipeline.pc.addTrack(track, this.localStream);
      pipeline.senders.push(sender);
    }
  }

  private detachLocalTracksFromAllPeers(): void {
    for (const pipeline of this.peers.values()) {
      this.detachLocalTracksFromPeer(pipeline);
    }
  }

  private detachLocalTracksFromPeer(pipeline: PeerAudioPipeline): void {
    if (pipeline.pc) {
      for (const sender of pipeline.senders) {
        try {
          pipeline.pc.removeTrack(sender);
        } catch {
          // Ignore if already closed
        }
      }
    }
    pipeline.senders = [];
  }

  private stopLocalStream(): void {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      track.stop();
    }
    this.localStream = null;
  }

  private teardownRemoteAudio(pipeline: PeerAudioPipeline): void {
    pipeline.sourceNode?.disconnect();
    pipeline.gainNode?.disconnect();
    pipeline.compressorNode?.disconnect();
    pipeline.sourceNode = null;
    pipeline.gainNode = null;
    pipeline.compressorNode = null;
    if (pipeline.sinkAudioEl) {
      pipeline.sinkAudioEl.srcObject = null;
      pipeline.sinkAudioEl = null;
    }
    pipeline.remoteStream = null;
  }

  private preferOpusCodec(pc: RTCPeerConnection): void {
    if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
    const audioCaps = RTCRtpSender.getCapabilities('audio');
    if (!audioCaps) return;
    const opusCodecs = audioCaps.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
    if (opusCodecs.length === 0) return;
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.receiver?.track?.kind === 'audio' && transceiver.setCodecPreferences) {
        try {
          transceiver.setCodecPreferences(opusCodecs);
        } catch {
          // Ignore unsupported codec preference errors
        }
      }
    }
  }
}
