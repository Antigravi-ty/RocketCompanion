import { create } from 'zustand';
import type { VoiceMicPermissionState } from '../../audio/voice/voiceTypes.ts';

export interface VoiceChannelState {
  enabled: boolean;
  noiseSuppression: boolean;
  micPermission: VoiceMicPermissionState;
  peerVolumes: Record<string, number>;
  peerMuted: Record<string, boolean>;
  activePeerIds: readonly string[];

  setEnabled: (enabled: boolean) => void;
  setNoiseSuppression: (enabled: boolean) => void;
  setMicPermission: (perm: VoiceMicPermissionState) => void;
  setPeerVolume: (playerId: string, volumePercent: number) => void;
  setPeerMuted: (playerId: string, muted: boolean) => void;
  setActivePeerIds: (peerIds: readonly string[]) => void;
}

export const voiceChannelStore = create<VoiceChannelState>((set) => ({
  enabled: false,
  noiseSuppression: true,
  micPermission: 'prompt',
  peerVolumes: {},
  peerMuted: {},
  activePeerIds: [],

  setEnabled: (enabled) => set({ enabled }),
  setNoiseSuppression: (noiseSuppression) => set({ noiseSuppression }),
  setMicPermission: (micPermission) => set({ micPermission }),
  setPeerVolume: (playerId, volumePercent) =>
    set((s) => ({
      peerVolumes: {
        ...s.peerVolumes,
        [playerId]: Math.max(0, Math.min(250, Math.round(volumePercent))),
      },
    })),
  setPeerMuted: (playerId, muted) =>
    set((s) => ({
      peerMuted: {
        ...s.peerMuted,
        [playerId]: muted,
      },
    })),
  setActivePeerIds: (activePeerIds) => set({ activePeerIds }),
}));

export function useVoiceChannelStore<T>(selector: (state: VoiceChannelState) => T): T {
  return voiceChannelStore(selector);
}
