export const VOICE_VOLUME_MIN_PCT = 0;
export const VOICE_VOLUME_MAX_PCT = 250;
export const VOICE_VOLUME_DEFAULT_PCT = 100;

export type VoiceChatMode = 'open' | 'team_only' | 'off';
export type VoiceTeam = 'blue' | 'orange' | null;

export interface VoiceAudioDiagnostic {
  level: 'info' | 'warn' | 'error';
  code:
    | 'AUDIO_CTX_SUSPENDED'
    | 'AUDIO_CTX_RESUMED'
    | 'AUTOPLAY_BLOCKED'
    | 'MIC_PERMISSION_DENIED'
    | 'MIC_CAPTURE_FAILED'
    | 'VOICE_NEGOTIATION_ERROR';
  message: string;
  peerId?: string;
}

export function clampVoiceVolumePct(value: number): number {
  if (!Number.isFinite(value)) return VOICE_VOLUME_DEFAULT_PCT;
  return Math.max(VOICE_VOLUME_MIN_PCT, Math.min(VOICE_VOLUME_MAX_PCT, Math.round(value)));
}

export interface VoiceInputProcessingOptions {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export type VoiceRenegotiationSignal =
  | {
      readonly kind: 'voice_offer';
      readonly sdp: RTCSessionDescriptionInit;
    }
  | {
      readonly kind: 'voice_answer';
      readonly sdp: RTCSessionDescriptionInit;
    }
  | {
      readonly kind: 'voice_identity';
      readonly playerId: string;
      readonly isRegistered: boolean;
      readonly displayName: string;
      readonly team?: VoiceTeam;
    };

export interface IVoicePeerConnectionPort {
  readonly signalingState: RTCSignalingState;
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
  removeTrack(sender: RTCRtpSender): void;
  getSenders(): RTCRtpSender[];
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface VoicePeerAttachmentOptions {
  peerId: string;
  playerId: string;
  displayName: string;
  isRegistered: boolean;
  team?: VoiceTeam;
  pc: IVoicePeerConnectionPort | null;
  sendSignal?: (signal: VoiceRenegotiationSignal) => boolean | void;
  initialVolumePct?: number;
  initialMuted?: boolean;
  isPolite?: boolean;
}

export interface VoicePeerStateSnapshot {
  peerId: string;
  playerId: string;
  displayName: string;
  isRegistered: boolean;
  team: VoiceTeam;
  teamGated: boolean;
  volumePct: number;
  muted: boolean;
  hasRemoteAudio: boolean;
  audioLevel01: number;
}

export interface RoomVoiceContext {
  voiceChatMode: VoiceChatMode;
  activityId: string;
  localTeam: VoiceTeam;
}

export interface VoiceBridgeStateSnapshot {
  enabled: boolean;
  micMuted: boolean;
  voiceChatMode: VoiceChatMode;
  activityId: string;
  localTeam: VoiceTeam;
  masterVoiceVolumePct: number;
  outputLimiterEnabled: boolean;
  inputProcessing: VoiceInputProcessingOptions;
  localMicLevel01: number;
  lastDiagnostic: VoiceAudioDiagnostic | null;
  peers: VoicePeerStateSnapshot[];
}

export function isVoicePeerGatedByRoomPolicy(
  context: RoomVoiceContext,
  peerTeam: VoiceTeam
): boolean {
  if (context.voiceChatMode === 'off') return true;
  if (context.voiceChatMode === 'open') return false;
  // team_only: during lobby (or when teams are unassigned/auto), everyone can talk to everyone
  if (context.activityId === 'lobby' || context.localTeam === null) {
    return false;
  }
  if (peerTeam === null) return false;
  return peerTeam !== context.localTeam;
}

export interface IVoiceAudioBridge {
  enableVoice(): Promise<void>;
  disableVoice(): void;
  isVoiceEnabled(): boolean;
  setMicMuted(muted: boolean): void;
  isMicMuted(): boolean;
  setRoomVoiceContext(context: Partial<RoomVoiceContext>): void;
  setPeerTeam(peerId: string, team: VoiceTeam): void;
  updateInputProcessing(options: Partial<VoiceInputProcessingOptions>): Promise<void>;
  setMasterVoiceVolumePct(volumePct: number): void;
  setOutputLimiterEnabled(enabled: boolean): void;
  setPeerVolumePct(peerOrPlayerId: string, volumePct: number): void;
  setPeerMuted(peerOrPlayerId: string, muted: boolean): void;
  attachPeer(options: VoicePeerAttachmentOptions): void;
  detachPeer(peerId: string): void;
  handleRenegotiationSignal(peerId: string, signal: VoiceRenegotiationSignal): Promise<void>;
  getLocalMicLevel01(): number;
  getPeerAudioLevel01(peerId: string): number;
  getPeers(): VoicePeerStateSnapshot[];
  getSnapshot(): VoiceBridgeStateSnapshot;
  dispose(): void;
}
