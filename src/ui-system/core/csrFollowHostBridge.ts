import {
  pushQuickNotification,
  dismissQuickNotification,
} from '../../ui-core/stores/quickNotificationStore.ts';
import { useCsrFollowHostStore } from '../../ui-core/stores/csrFollowHostStore.ts';
import type { TakeoverHudPayload } from '../../ui-core/hud/takeoverCountdownDefaults.ts';
import type {
  CsrFollowHostPayload,
  InterveneHandoffState,
} from '../../network/protocol/RoomActivityProtocol.ts';

const CSR_NOTIFICATION_COLLAPSE_KEY = 'csr-follow-host';
const CSR_NOTIFICATION_NAMESPACE = 'multiplayer-csr';

let activeCsrNotificationId: string | null = null;

export function syncCsrFollowHostNotification(): string | null {
  const state = useCsrFollowHostStore.getState();
  if (!state.isConnectedAsClient) {
    if (activeCsrNotificationId) {
      dismissQuickNotification(activeCsrNotificationId);
      activeCsrNotificationId = null;
    }
    return null;
  }

  const label = state.followHostEnabled ? 'Following Host (CSR)' : 'Follow Host (CSR)';
  const modeSuffix = state.frameStepMode ? ' [Frame-Step]' : '';
  const content = `${label} - ${state.hostActivityId}${modeSuffix}`;

  const id = pushQuickNotification({
    id: CSR_NOTIFICATION_COLLAPSE_KEY,
    collapseKey: CSR_NOTIFICATION_COLLAPSE_KEY,
    sourceNamespace: CSR_NOTIFICATION_NAMESPACE,
    collapseStrategy: 'ALWAYS_REPLACE',
    type: 'background',
    duration: 0,
    tone: state.followHostEnabled ? 'info' : 'none',
    icon: 'monitor',
    content,
    buttons: [
      {
        key: 'toggle-csr-follow',
        label: state.followHostEnabled ? 'Leave Follow' : 'Follow Host',
        format: 'text-only',
        color: state.followHostEnabled ? 'amber' : 'sky',
        dismissOnClick: false,
        onClick: () => {
          useCsrFollowHostStore.getState().toggleFollowHost();
          syncCsrFollowHostNotification();
        },
      },
    ],
  });
  activeCsrNotificationId = id;
  return id;
}

export function applyIncomingCsrFollowHostPayload(
  payload: CsrFollowHostPayload,
  connectedAsClient = true
): void {
  const store = useCsrFollowHostStore.getState();
  store.setConnectedAsClient(connectedAsClient);
  store.syncHostBroadcastState({
    hostActivityId: payload.hostActivityId,
    hostCameraMode: payload.hostCameraMode,
    hostFocusCarIndex: payload.hostFocusCarIndex,
    hostTick: payload.hostTick,
    frameStepMode: payload.frameStepMode,
  });
  syncCsrFollowHostNotification();
}

export function clearCsrFollowHostBridge(): void {
  useCsrFollowHostStore.getState().reset();
  if (activeCsrNotificationId) {
    dismissQuickNotification(activeCsrNotificationId);
    activeCsrNotificationId = null;
  }
}

export function buildTakeoverHudPayloadFromHandoff(
  handoff: InterveneHandoffState,
  teamSide: 'blue' | 'orange' = 'blue'
): TakeoverHudPayload | null {
  if (handoff.phase === 'idle' || handoff.phase === 'authorized') {
    return null;
  }
  if (handoff.phase === 'active' || handoff.countdownStepLabel === '0') {
    return {
      topText: 'Takeover active',
      mainText: 'GO',
      subText: handoff.authorizedSessionId ? `Driver: ${handoff.authorizedSessionId}` : undefined,
      teamSide,
      triggerKey: `active-${handoff.targetResumeTick}`,
    };
  }
  return {
    topText: 'Takeover in...',
    mainText: handoff.countdownStepLabel,
    subText: handoff.authorizedSessionId
      ? `Target Car #${handoff.targetCarIndex} (${handoff.nonPovPolicy})`
      : undefined,
    teamSide,
    triggerKey: `step-${handoff.countdownStepLabel}`,
  };
}
