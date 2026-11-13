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
  private masterGainNode: GainNode | null = null;
  private outputLimiterNode: DynamicsCompressorNode | null = null;
  private masterVolumePct = 100;
  private outputLimiterEnabled = true;
  private unlockListenerBound = false;

  constructor(getAudioContext: () => AudioContext | null) {
    this.getAudioContext = getAudioContext;
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
        void current.resume().catch(() => {});
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
      void ctx.resume().catch(() => {});
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
  masterVolumePct: number
): void {
  cleanupPeerAudioGraph(handles);

  if (typeof Audio !== 'undefined') {
    const audioEl = new Audio();
    audioEl.srcObject = stream;
    audioEl.autoplay = true;
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
    void handles.hiddenAudioEl.play().catch(() => {});
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
  const useWebAudioBoost = isCtxRunning && effectiveGain > 1.0 && Boolean(handles.gainNode);

  if (handles.hiddenAudioEl) {
    if (useWebAudioBoost) {
      handles.hiddenAudioEl.muted = true;
      handles.hiddenAudioEl.volume = 0;
    } else {
      handles.hiddenAudioEl.muted = peerMuted || effectiveGain <= 0;
      handles.hiddenAudioEl.volume = Math.max(0, Math.min(1, effectiveGain));
    }
  }

  if (handles.gainNode) {
    handles.gainNode.gain.value = useWebAudioBoost ? peerVolumePct / 100 : 0;
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
