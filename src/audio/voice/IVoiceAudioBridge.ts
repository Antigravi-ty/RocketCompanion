export const VOICE_VOLUME_MIN_PCT = 0;
export const VOICE_VOLUME_MAX_PCT = 250;
export const VOICE_VOLUME_DEFAULT_PCT = 100;

export type VoiceChatRoomMode = 'open' | 'team_only' | 'off';

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
      readonly team?: number | null;
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
  team?: number | null;
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
  team: number | null;
  volumePct: number;
  muted: boolean;
  gatedByRoomMode: boolean;
  hasRemoteAudio: boolean;
  audioLevel01: number;
}

export interface VoiceBridgeStateSnapshot {
  enabled: boolean;
  micMuted: boolean;
  roomMode: VoiceChatRoomMode;
  isLobbyPhase: boolean;
  masterVoiceVolumePct: number;
  outputLimiterEnabled: boolean;
  inputProcessing: VoiceInputProcessingOptions;
  localMicLevel01: number;
  audioStatusMessage: string | null;
  peers: VoicePeerStateSnapshot[];
}

export interface IVoiceAudioBridge {
  enableVoice(): Promise<void>;
  disableVoice(): void;
  isVoiceEnabled(): boolean;
  setMicMuted(muted: boolean): void;
  isMicMuted(): boolean;
  setRoomVoicePolicy(mode: VoiceChatRoomMode, localTeam: number | null, isLobbyPhase: boolean): void;
  setPeerTeam(peerId: string, team: number | null): void;
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
