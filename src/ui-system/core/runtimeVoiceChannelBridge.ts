import { WebRtcNativeVoiceBridge } from '../../audio/voice/WebRtcNativeVoiceBridge.ts';
import { voiceChannelStore } from '../../ui-core/stores/voiceChannelStore.ts';

let bridgeInstance: WebRtcNativeVoiceBridge | null = null;
let unsubscribeStore: (() => void) | null = null;

function getOrCreateBridge(): WebRtcNativeVoiceBridge {
  if (!bridgeInstance) {
    bridgeInstance = new WebRtcNativeVoiceBridge();
  }
  return bridgeInstance;
}

export function ensureVoiceChannelBridge(): () => void {
  if (unsubscribeStore) return () => {};
  const bridge = getOrCreateBridge();

  unsubscribeStore = voiceChannelStore.subscribe((state, prev) => {
    if (state.enabled !== prev.enabled) {
      if (state.enabled) {
        void bridge.enable().then((perm) => {
          voiceChannelStore.getState().setMicPermission(perm);
          if (perm !== 'granted') {
            voiceChannelStore.getState().setEnabled(false);
          }
        });
      } else {
        bridge.disable();
      }
    }

    if (state.noiseSuppression !== prev.noiseSuppression) {
      void bridge.setNoiseSuppression(state.noiseSuppression);
    }

    if (state.peerVolumes !== prev.peerVolumes) {
      for (const [playerId, vol] of Object.entries(state.peerVolumes)) {
        if (prev.peerVolumes[playerId] !== vol) {
          bridge.setPeerVolume(playerId, vol);
        }
      }
    }

    if (state.peerMuted !== prev.peerMuted) {
      for (const [playerId, muted] of Object.entries(state.peerMuted)) {
        if (prev.peerMuted[playerId] !== muted) {
          bridge.setPeerMuted(playerId, muted);
        }
      }
    }
  });

  return () => {
    unsubscribeStore?.();
    unsubscribeStore = null;
    bridgeInstance?.dispose();
    bridgeInstance = null;
  };
}

export function bindVoicePeerConnection(playerId: string, pc: RTCPeerConnection): void {
  const bridge = getOrCreateBridge();
  bridge.attachPeerConnection(playerId, pc);
  const st = voiceChannelStore.getState();
  if (!st.activePeerIds.includes(playerId)) {
    st.setActivePeerIds([...st.activePeerIds, playerId]);
  }
}

export function unbindVoicePeerConnection(playerId: string): void {
  bridgeInstance?.detachPeerConnection(playerId);
  const st = voiceChannelStore.getState();
  if (st.activePeerIds.includes(playerId)) {
    st.setActivePeerIds(st.activePeerIds.filter((id) => id !== playerId));
  }
}
