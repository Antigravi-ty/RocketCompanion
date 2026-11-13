export type VoiceMicPermissionState = 'prompt' | 'granted' | 'denied' | 'unavailable';

export interface VoiceChannelConfig {
  enabled: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface VoicePeerAudioState {
  readonly playerId: string;
  volumePercent: number; // 0 .. 250
  muted: boolean;
  hasRemoteAudio: boolean;
}

export interface IVoiceAudioBridge {
  enable(): Promise<VoiceMicPermissionState>;
  disable(): void;
  setNoiseSuppression(enabled: boolean): Promise<void>;
  attachPeerConnection(playerId: string, pc: RTCPeerConnection): void;
  detachPeerConnection(playerId: string): void;
  attachRemoteStream(playerId: string, stream: MediaStream): void;
  setPeerVolume(playerId: string, volumePercent: number): void;
  setPeerMuted(playerId: string, muted: boolean): void;
  getPeerStates(): readonly VoicePeerAudioState[];
  dispose(): void;
}
