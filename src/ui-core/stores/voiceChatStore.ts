import { create } from 'zustand';
import {
  clampVoiceChatVolumePct,
  loadVoiceChatPrefs,
  saveVoiceChatPrefs,
  type VoiceChatPrefsSnapshot,
  type VoiceChatRoomMode,
} from '../config/voiceChatConfig';

export type VoicePermissionState = 'idle' | 'requesting' | 'granted' | 'denied';

export interface VoicePeerHudItem {
  peerId: string;
  playerId: string;
  displayName: string;
  isRegistered: boolean;
  team?: number | null;
  volumePct: number;
  muted: boolean;
  gatedByRoomMode?: boolean;
  hasRemoteAudio: boolean;
  audioLevel01: number;
}

export interface VoiceRuntimeBridgeCallbacks {
  enableVoice: () => Promise<void>;
  disableVoice: () => void;
  setMicMuted: (muted: boolean) => void;
  setRoomVoicePolicy: (
    mode: VoiceChatRoomMode,
    localTeam: number | null,
    isLobbyPhase: boolean
  ) => void;
  updateInputProcessing: (opts: {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  }) => Promise<void>;
  setMasterVoiceVolumePct: (volumePct: number) => void;
  setOutputLimiterEnabled: (enabled: boolean) => void;
  setPeerVolumePct: (peerOrPlayerId: string, volumePct: number) => void;
  setPeerMuted: (peerOrPlayerId: string, muted: boolean) => void;
}

export interface VoiceChatStoreState extends VoiceChatPrefsSnapshot {
  enabled: boolean;
  roomVoiceMode: VoiceChatRoomMode;
  localTeam: number | null;
  isLobbyPhase: boolean;
  permissionState: VoicePermissionState;
  permissionError: string | null;
  audioStatusMessage: string | null;
  localMicLevel01: number;
  peers: VoicePeerHudItem[];
  sessionPeerVolumes: Record<string, number>;
  sessionPeerMuted: Record<string, boolean>;
  runtimeBridge: VoiceRuntimeBridgeCallbacks | null;

  registerRuntimeBridge: (bridge: VoiceRuntimeBridgeCallbacks | null) => void;
  setVoiceEnabled: (enabled: boolean) => Promise<void>;
  setMicMuted: (muted: boolean) => void;
  setRoomVoicePolicy: (
    mode: VoiceChatRoomMode,
    localTeam?: number | null,
    isLobbyPhase?: boolean
  ) => void;
  updateInputProcessing: (patch: {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  }) => Promise<void>;
  setMasterVoiceVolumePct: (volumePct: number) => void;
  setOutputLimiterEnabled: (enabled: boolean) => void;
  setPlayerVolumePct: (
    peerId: string,
    playerId: string,
    isRegistered: boolean,
    volumePct: number
  ) => void;
  setPlayerMuted: (
    peerId: string,
    playerId: string,
    isRegistered: boolean,
    muted: boolean
  ) => void;
  updateLiveTelemetry: (
    localMicLevel01: number,
    peers: VoicePeerHudItem[],
    audioStatusMessage?: string | null
  ) => void;
  applySyncedPrefs: (prefs: Partial<VoiceChatPrefsSnapshot>) => void;
}

const initialPrefs = loadVoiceChatPrefs();

function persistPrefsFromState(state: VoiceChatStoreState): void {
  saveVoiceChatPrefs({
    micMuted: state.micMuted,
    echoCancellation: state.echoCancellation,
    noiseSuppression: state.noiseSuppression,
    autoGainControl: state.autoGainControl,
    masterVoiceVolumePct: state.masterVoiceVolumePct,
    outputLimiterEnabled: state.outputLimiterEnabled,
    registeredPlayerVolumes: state.registeredPlayerVolumes,
    registeredPlayerMuted: state.registeredPlayerMuted,
  });
}

export const useVoiceChatStore = create<VoiceChatStoreState>((set, get) => ({
  ...initialPrefs,
  enabled: false,
  roomVoiceMode: 'open',
  localTeam: null,
  isLobbyPhase: true,
  permissionState: 'idle',
  permissionError: null,
  audioStatusMessage: null,
  localMicLevel01: 0,
  peers: [],
  sessionPeerVolumes: {},
  sessionPeerMuted: {},
  runtimeBridge: null,

  registerRuntimeBridge: (bridge) => {
    set({ runtimeBridge: bridge });
    if (bridge) {
      const s = get();
      bridge.setMicMuted(s.micMuted);
      bridge.setMasterVoiceVolumePct(s.masterVoiceVolumePct);
      bridge.setOutputLimiterEnabled(s.outputLimiterEnabled);
      bridge.setRoomVoicePolicy(s.roomVoiceMode, s.localTeam, s.isLobbyPhase);
      void bridge.updateInputProcessing({
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseSuppression,
        autoGainControl: s.autoGainControl,
      });
    }
  },

  setVoiceEnabled: async (enabled) => {
    const bridge = get().runtimeBridge;
    if (!enabled) {
      bridge?.disableVoice();
      set({
        enabled: false,
        permissionState: 'idle',
        permissionError: null,
        localMicLevel01: 0,
      });
      return;
    }

    set({ permissionState: 'requesting', permissionError: null });
    try {
      if (bridge) {
        await bridge.enableVoice();
      } else if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: get().echoCancellation,
            noiseSuppression: get().noiseSuppression,
            autoGainControl: get().autoGainControl,
          },
          video: false,
        });
        for (const track of stream.getTracks()) {
          track.stop();
        }
      } else {
        throw new Error('Microphone capture is not supported in this environment.');
      }
      set({
        enabled: true,
        permissionState: 'granted',
        permissionError: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Microphone permission denied.';
      set({
        enabled: false,
        permissionState: 'denied',
        permissionError: msg,
        localMicLevel01: 0,
      });
    }
  },

  setMicMuted: (muted) => {
    const nextMuted = Boolean(muted);
    get().runtimeBridge?.setMicMuted(nextMuted);
    set((s) => {
      const next = { ...s, micMuted: nextMuted };
      persistPrefsFromState(next);
      return { micMuted: nextMuted };
    });
  },

  setRoomVoicePolicy: (mode, localTeam, isLobbyPhase) => {
    const prev = get();
    const resolvedTeam = localTeam !== undefined ? localTeam : prev.localTeam;
    const resolvedLobby = isLobbyPhase !== undefined ? Boolean(isLobbyPhase) : prev.isLobbyPhase;
    prev.runtimeBridge?.setRoomVoicePolicy(mode, resolvedTeam, resolvedLobby);
    set({
      roomVoiceMode: mode,
      localTeam: resolvedTeam,
      isLobbyPhase: resolvedLobby,
    });
  },

  updateInputProcessing: async (patch) => {
    set((s) => {
      const next: VoiceChatStoreState = {
        ...s,
        echoCancellation: patch.echoCancellation ?? s.echoCancellation,
        noiseSuppression: patch.noiseSuppression ?? s.noiseSuppression,
        autoGainControl: patch.autoGainControl ?? s.autoGainControl,
      };
      persistPrefsFromState(next);
      return {
        echoCancellation: next.echoCancellation,
        noiseSuppression: next.noiseSuppression,
        autoGainControl: next.autoGainControl,
      };
    });
    const bridge = get().runtimeBridge;
    if (bridge) {
      await bridge.updateInputProcessing(patch);
    }
  },

  setMasterVoiceVolumePct: (volumePct) => {
    const clamped = clampVoiceChatVolumePct(volumePct);
    get().runtimeBridge?.setMasterVoiceVolumePct(clamped);
    set((s) => {
      const next = { ...s, masterVoiceVolumePct: clamped };
      persistPrefsFromState(next);
      return { masterVoiceVolumePct: clamped };
    });
  },

  setOutputLimiterEnabled: (enabled) => {
    const nextEnabled = Boolean(enabled);
    get().runtimeBridge?.setOutputLimiterEnabled(nextEnabled);
    set((s) => {
      const next = { ...s, outputLimiterEnabled: nextEnabled };
      persistPrefsFromState(next);
      return { outputLimiterEnabled: nextEnabled };
    });
  },

  setPlayerVolumePct: (peerId, playerId, isRegistered, volumePct) => {
    const clamped = clampVoiceChatVolumePct(volumePct);
    get().runtimeBridge?.setPeerVolumePct(peerId || playerId, clamped);
    set((s) => {
      const nextPeers = s.peers.map((p) =>
        p.peerId === peerId || p.playerId === playerId ? { ...p, volumePct: clamped } : p
      );
      if (isRegistered && playerId) {
        const nextReg = { ...s.registeredPlayerVolumes, [playerId]: clamped };
        const nextState = { ...s, registeredPlayerVolumes: nextReg, peers: nextPeers };
        persistPrefsFromState(nextState);
        return { registeredPlayerVolumes: nextReg, peers: nextPeers };
      }
      const key = playerId || peerId;
      return {
        sessionPeerVolumes: { ...s.sessionPeerVolumes, [key]: clamped },
        peers: nextPeers,
      };
    });
  },

  setPlayerMuted: (peerId, playerId, isRegistered, muted) => {
    const nextMuted = Boolean(muted);
    get().runtimeBridge?.setPeerMuted(peerId || playerId, nextMuted);
    set((s) => {
      const nextPeers = s.peers.map((p) =>
        p.peerId === peerId || p.playerId === playerId ? { ...p, muted: nextMuted } : p
      );
      if (isRegistered && playerId) {
        const nextReg = { ...s.registeredPlayerMuted, [playerId]: nextMuted };
        const nextState = { ...s, registeredPlayerMuted: nextReg, peers: nextPeers };
        persistPrefsFromState(nextState);
        return { registeredPlayerMuted: nextReg, peers: nextPeers };
      }
      const key = playerId || peerId;
      return {
        sessionPeerMuted: { ...s.sessionPeerMuted, [key]: nextMuted },
        peers: nextPeers,
      };
    });
  },

  updateLiveTelemetry: (localMicLevel01, peers, audioStatusMessage) => {
    set((s) => ({
      localMicLevel01,
      peers,
      audioStatusMessage:
        audioStatusMessage !== undefined ? audioStatusMessage : s.audioStatusMessage,
    }));
  },

  applySyncedPrefs: (prefs) => {
    set((s) => {
      const merged = {
        micMuted: prefs.micMuted ?? s.micMuted,
        echoCancellation: prefs.echoCancellation ?? s.echoCancellation,
        noiseSuppression: prefs.noiseSuppression ?? s.noiseSuppression,
        autoGainControl: prefs.autoGainControl ?? s.autoGainControl,
        masterVoiceVolumePct: clampVoiceChatVolumePct(
          prefs.masterVoiceVolumePct ?? s.masterVoiceVolumePct
        ),
        outputLimiterEnabled: prefs.outputLimiterEnabled ?? s.outputLimiterEnabled,
        registeredPlayerVolumes: prefs.registeredPlayerVolumes ?? s.registeredPlayerVolumes,
        registeredPlayerMuted: prefs.registeredPlayerMuted ?? s.registeredPlayerMuted,
      };
      saveVoiceChatPrefs(merged);
      const bridge = s.runtimeBridge;
      if (bridge) {
        bridge.setMicMuted(merged.micMuted);
        bridge.setMasterVoiceVolumePct(merged.masterVoiceVolumePct);
        bridge.setOutputLimiterEnabled(merged.outputLimiterEnabled);
        void bridge.updateInputProcessing({
          echoCancellation: merged.echoCancellation,
          noiseSuppression: merged.noiseSuppression,
          autoGainControl: merged.autoGainControl,
        });
      }
      return merged;
    });
  },
}));
