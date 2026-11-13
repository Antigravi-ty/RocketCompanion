import type { VoiceAudioDiagnostic } from './IVoiceAudioBridge.ts';

export interface PeerAudioGraphHandles {
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  analyserNode: AnalyserNode | null;
  analyserBuffer: Float32Array<ArrayBuffer> | null;
  hiddenAudioEl: HTMLAudioElement | null;
}

export function createEmptyPeerAudioGraph(): PeerAudioGraphHandles {
  return {
    sourceNode: null,
    gainNode: null,
    analyserNode: null,
    analyserBuffer: null,
    hiddenAudioEl: null,
  };
}

export function sampleAnalyserRms01(
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

export class VoiceMasterOutputBus {
  private readonly getAudioContext: () => AudioContext | null;
  private readonly onDiagnostic?: (diag: VoiceAudioDiagnostic) => void;
  private masterGainNode: GainNode | null = null;
  private outputLimiterNode: DynamicsCompressorNode | null = null;
  private masterVolumePct = 100;
  private outputLimiterEnabled = true;
  private unlockListenerBound = false;

  constructor(
    getAudioContext: () => AudioContext | null,
    onDiagnostic?: (diag: VoiceAudioDiagnostic) => void
  ) {
    this.getAudioContext = getAudioContext;
    this.onDiagnostic = onDiagnostic;
  }

  public isContextRunning(): boolean {
    const ctx = this.getAudioContext();
    return Boolean(ctx && ctx.state === 'running');
  }

  public ensureUnlockedOnGesture(): void {
    const ctx = this.getAudioContext();
    if (!ctx || ctx.state === 'running' || this.unlockListenerBound) return;
    if (typeof window === 'undefined') return;
    this.unlockListenerBound = true;
    const unlock = () => {
      const current = this.getAudioContext();
      if (current && current.state === 'suspended') {
        void current
          .resume()
          .then(() => {
            this.onDiagnostic?.({
              level: 'info',
              code: 'AUDIO_CTX_RESUMED',
              message: 'Voice AudioContext unlocked and running.',
            });
          })
          .catch((err) => {
            console.warn('[VoiceMasterOutputBus] AudioContext resume failed on gesture:', err);
          });
      }
      if (!current || current.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
        this.unlockListenerBound = false;
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  public ensureOutputBus(): { ctx: AudioContext; inputNode: GainNode } | null {
    const ctx = this.getAudioContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') {
      this.onDiagnostic?.({
        level: 'warn',
        code: 'AUDIO_CTX_SUSPENDED',
        message: 'AudioContext suspended; waiting for user interaction to unlock voice playback.',
      });
      void ctx
        .resume()
        .then(() => {
          this.onDiagnostic?.({
            level: 'info',
            code: 'AUDIO_CTX_RESUMED',
            message: 'Voice AudioContext resumed.',
          });
        })
        .catch((err) => {
          console.warn('[VoiceMasterOutputBus] AudioContext resume deferred until gesture:', err);
        });
      this.ensureUnlockedOnGesture();
    }
    if (!this.masterGainNode) {
      this.masterGainNode = ctx.createGain();
      this.masterGainNode.gain.value = this.masterVolumePct / 100;
      this.outputLimiterNode = ctx.createDynamicsCompressor();
      this.outputLimiterNode.threshold.value = -3;
      this.outputLimiterNode.knee.value = 6;
      this.outputLimiterNode.ratio.value = 12;
      this.outputLimiterNode.attack.value = 0.003;
      this.outputLimiterNode.release.value = 0.1;
      this.rewire(ctx);
    }
    return { ctx, inputNode: this.masterGainNode };
  }

  public setMasterVolumePct(volumePct: number): void {
    this.masterVolumePct = volumePct;
    if (this.masterGainNode) {
      this.masterGainNode.gain.value = volumePct / 100;
    }
  }

  public setOutputLimiterEnabled(enabled: boolean): void {
    this.outputLimiterEnabled = enabled;
    const ctx = this.getAudioContext();
    if (ctx) {
      this.rewire(ctx);
    }
  }

  private rewire(ctx: AudioContext): void {
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

  public dispose(): void {
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

export function bindPeerRemoteAudioGraph(
  handles: PeerAudioGraphHandles,
  stream: MediaStream,
  bus: VoiceMasterOutputBus,
  peerVolumePct: number,
  peerMuted: boolean,
  masterVolumePct: number,
  onDiagnostic?: (diag: VoiceAudioDiagnostic) => void,
  peerId?: string
): void {
  cleanupPeerAudioGraph(handles);

  if (typeof Audio !== 'undefined') {
    const audioEl = new Audio();
    audioEl.srcObject = stream;
    audioEl.autoplay = true;
    // Keep muted when WebAudio VoiceMasterOutputBus is active; serves as Chromium WebRTC clock sink.
    audioEl.muted = true;
    handles.hiddenAudioEl = audioEl;
  }

  const output = bus.ensureOutputBus();
  if (output) {
    handles.sourceNode = output.ctx.createMediaStreamSource(stream);
    handles.analyserNode = output.ctx.createAnalyser();
    handles.analyserNode.fftSize = 256;
    handles.analyserBuffer = new Float32Array(handles.analyserNode.fftSize);
    handles.gainNode = output.ctx.createGain();

    handles.sourceNode.connect(handles.analyserNode);
    handles.analyserNode.connect(handles.gainNode);
    handles.gainNode.connect(output.inputNode);
  }

  applyPeerPlaybackGain(handles, bus.isContextRunning(), peerVolumePct, peerMuted, masterVolumePct);

  if (handles.hiddenAudioEl) {
    void handles.hiddenAudioEl.play().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[voiceAudioGraph] Hidden audio sink play() blocked:', msg);
      onDiagnostic?.({
        level: 'warn',
        code: 'AUTOPLAY_BLOCKED',
        message: `Browser autoplay policy blocked remote audio sink: ${msg}`,
        peerId,
      });
    });
  }
}

export function applyPeerPlaybackGain(
  handles: PeerAudioGraphHandles,
  isCtxRunning: boolean,
  peerVolumePct: number,
  peerMuted: boolean,
  masterVolumePct: number
): void {
  const effectiveGain = peerMuted ? 0 : (peerVolumePct / 100) * (masterVolumePct / 100);

  // Route remote audio uniformly through VoiceMasterOutputBus whenever gainNode exists.
  if (handles.gainNode) {
    handles.gainNode.gain.value = peerMuted ? 0 : peerVolumePct / 100;
    if (handles.hiddenAudioEl) {
      handles.hiddenAudioEl.muted = true;
      handles.hiddenAudioEl.volume = 0;
    }
    return;
  }

  // Fallback only if WebAudio AudioContext is unavailable
  if (handles.hiddenAudioEl) {
    handles.hiddenAudioEl.muted = peerMuted || effectiveGain <= 0 || isCtxRunning;
    handles.hiddenAudioEl.volume = Math.max(0, Math.min(1, effectiveGain));
  }
}

export function cleanupPeerAudioGraph(handles: PeerAudioGraphHandles): void {
  try {
    handles.sourceNode?.disconnect();
    handles.gainNode?.disconnect();
    handles.analyserNode?.disconnect();
  } catch {
    // Ignore
  }
  handles.sourceNode = null;
  handles.gainNode = null;
  handles.analyserNode = null;
  handles.analyserBuffer = null;
  if (handles.hiddenAudioEl) {
    try {
      handles.hiddenAudioEl.pause();
      handles.hiddenAudioEl.srcObject = null;
    } catch {
      // Ignore
    }
    handles.hiddenAudioEl = null;
  }
}
