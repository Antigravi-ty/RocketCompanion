import { getAudioContext } from '../../audio/audioContext.ts';
import { WebRtcNativeVoiceBridge } from '../../audio/voice/WebRtcNativeVoiceBridge.ts';
import type {
  IVoicePeerConnectionPort,
  VoiceRenegotiationSignal,
} from '../../audio/voice/IVoiceAudioBridge.ts';
import type { P2PWebRTCChannel } from '../../network/transport/P2PWebRTCChannel.ts';
import { useCloudProfileSyncStore } from '../../ui-core/stores/cloudProfileSyncStore.ts';
import { useVoiceChatStore } from '../../ui-core/stores/voiceChatStore.ts';

let voiceBridgeInstance: WebRtcNativeVoiceBridge | null = null;
let telemetryTimerId: ReturnType<typeof setInterval> | null = null;

function resolveLocalPlayerIdentity(
  fallbackId: string,
  fallbackName: string
): {
  playerId: string;
  isRegistered: boolean;
  displayName: string;
} {
  const loggedIn = useCloudProfileSyncStore.getState().loggedInUser;
  if (loggedIn && loggedIn.userId) {
    return {
      playerId: loggedIn.userId,
      isRegistered: true,
      displayName: loggedIn.displayName || loggedIn.alias || loggedIn.username || fallbackName,
    };
  }
  return {
    playerId: fallbackId,
    isRegistered: false,
    displayName: fallbackName,
  };
}

function syncTelemetryToStore(): void {
  if (!voiceBridgeInstance) return;
  const snap = voiceBridgeInstance.getSnapshot();
  useVoiceChatStore.getState().updateLiveTelemetry(snap.localMicLevel01, snap.peers);
}

function ensureTelemetryLoop(): void {
  if (telemetryTimerId !== null) return;
  telemetryTimerId = setInterval(() => {
    if (!voiceBridgeInstance) return;
    const snap = voiceBridgeInstance.getSnapshot();
    if (!snap.enabled && snap.peers.length === 0) {
      if (telemetryTimerId !== null) {
        clearInterval(telemetryTimerId);
        telemetryTimerId = null;
      }
      return;
    }
    useVoiceChatStore.getState().updateLiveTelemetry(snap.localMicLevel01, snap.peers);
  }, 100);
}

export function ensureVoiceRuntimeBridge(): WebRtcNativeVoiceBridge {
  if (voiceBridgeInstance) return voiceBridgeInstance;

  voiceBridgeInstance = new WebRtcNativeVoiceBridge({
    getAudioContext,
    resolvePeerInitialMix: (playerId, isRegistered) => {
      const state = useVoiceChatStore.getState();
      if (isRegistered && playerId) {
        return {
          volumePct: state.registeredPlayerVolumes[playerId],
          muted: state.registeredPlayerMuted[playerId],
        };
      }
      return {
        volumePct: state.sessionPeerVolumes[playerId],
        muted: state.sessionPeerMuted[playerId],
      };
    },
    onStateChanged: (snap) => {
      useVoiceChatStore.getState().updateLiveTelemetry(snap.localMicLevel01, snap.peers);
      if (snap.enabled || snap.peers.length > 0) {
        ensureTelemetryLoop();
      }
    },
  });

  useVoiceChatStore.getState().registerRuntimeBridge({
    enableVoice: async () => {
      await voiceBridgeInstance!.enableVoice();
      ensureTelemetryLoop();
    },
    disableVoice: () => {
      voiceBridgeInstance!.disableVoice();
    },
    setMicMuted: (muted) => {
      voiceBridgeInstance!.setMicMuted(muted);
    },
    updateInputProcessing: async (opts) => {
      await voiceBridgeInstance!.updateInputProcessing(opts);
    },
    setMasterVoiceVolumePct: (volumePct) => {
      voiceBridgeInstance!.setMasterVoiceVolumePct(volumePct);
    },
    setOutputLimiterEnabled: (enabled) => {
      voiceBridgeInstance!.setOutputLimiterEnabled(enabled);
    },
    setPeerVolumePct: (peerOrPlayerId, volumePct) => {
      voiceBridgeInstance!.setPeerVolumePct(peerOrPlayerId, volumePct);
    },
    setPeerMuted: (peerOrPlayerId, muted) => {
      voiceBridgeInstance!.setPeerMuted(peerOrPlayerId, muted);
    },
  });

  return voiceBridgeInstance;
}

export function attachVoiceToPeerChannel(
  channel: P2PWebRTCChannel,
  peerId: string,
  peerName: string
): void {
  const bridge = ensureVoiceRuntimeBridge();
  const resolvedPeerId = peerId || channel.peerId || 'peer-unknown';
  const pc = (channel.connection?.pc ?? null) as unknown as IVoicePeerConnectionPort | null;

  const sendSignal = (signal: VoiceRenegotiationSignal): boolean =>
    channel.sendVoiceSignal(signal as unknown as Record<string, unknown>);

  bridge.attachPeer({
    peerId: resolvedPeerId,
    playerId: channel.playerId || resolvedPeerId,
    displayName: peerName || channel.peerName || 'Player',
    isRegistered: Boolean(channel.isRegisteredPlayerId),
    pc,
    sendSignal,
    isPolite: resolvedPeerId === 'host',
  });

  channel.onVoiceSignal = (rawSignal) => {
    const kind = rawSignal.kind;
    if (kind === 'voice_offer' || kind === 'voice_answer' || kind === 'voice_identity') {
      void bridge.handleRenegotiationSignal(
        resolvedPeerId,
        rawSignal as unknown as VoiceRenegotiationSignal
      );
    }
  };

  const identity = resolveLocalPlayerIdentity(resolvedPeerId, channel.playerName || 'Player');
  sendSignal({
    kind: 'voice_identity',
    playerId: identity.playerId,
    isRegistered: identity.isRegistered,
    displayName: identity.displayName,
  });

  syncTelemetryToStore();
  ensureTelemetryLoop();
}

export function detachVoiceFromPeer(peerId: string): void {
  if (!voiceBridgeInstance || !peerId) return;
  if (peerId === '*') {
    for (const peer of voiceBridgeInstance.getPeers()) {
      voiceBridgeInstance.detachPeer(peer.peerId);
    }
  } else {
    voiceBridgeInstance.detachPeer(peerId);
  }
  syncTelemetryToStore();
}
