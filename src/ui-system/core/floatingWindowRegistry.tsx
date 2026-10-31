import React from 'react';
import { type FloatingWindowItem } from '../../ui-core/stores/floatingStore';
import { type FloatingWindowRenderContext } from '../../ui-core/navigation/FloatingWindowManager';
import { dialogue } from '../../ui-core/compounds/dialogue/dialogueStore';
import {
  FLOATING_WINDOW_OPACITY_PRESET,
  SUBSYSTEM_ISOLATION_LAB_PRESET,
  EXPERIMENTAL_MULTI_BOTS_PRESET,
  KICKOFF_TRAINING_PRESET,
  REPLAY_VIEWER_PRESET,
  NAME_TAG_TUNER_PRESET,
  REPLAY_DIRECTOR_TUNER_PRESET,
  REWINDER_CONFIGURATOR_PRESET,
} from '../../ui-core/stores/floatingPresets';
import { useAppStore } from '../../ui-core/stores/appStore';
import { useReplayViewerStore } from '../../ui-core/stores/replayViewerStore';
import { useNameTagTunerStore } from '../../ui-core/stores/nameTagTunerStore';
import { useRewinderStore } from '../../ui-core/stores/rewinderStore';
import {
  getActiveReplayTimelineController,
  exitActiveReplayDirectorPreview,
} from '../../ui-core/config/replayDirectorConfig.js';
import {
  FLOATING_WINDOW_DESCRIPTORS,
  renderFloatingWindowPanel,
} from '../../ui-core/panels/floatingWindowRegistry';

export const renderFloatingWindowContent = (
  item: FloatingWindowItem,
  ctx: FloatingWindowRenderContext
): React.ReactNode => {
  const baseId = FLOATING_WINDOW_DESCRIPTORS[item.id]
    ? item.id
    : Object.keys(FLOATING_WINDOW_DESCRIPTORS).find((k) => item.id.startsWith(`${k}-`));
  if (!baseId) return null;
  const descriptor = FLOATING_WINDOW_DESCRIPTORS[baseId];
  const content = renderFloatingWindowPanel(baseId, {
    isLight: ctx.isLight,
  });
  if (!content) return null;
  if (descriptor.category === 'user') {
    return content;
  }
  return (
    <div className="p-3.5 flex flex-col gap-2.5">
      {content}
    </div>
  );
};

export const handleFloatingStackCloseWindow = (
  win: FloatingWindowItem,
  defaultClose: () => void
): void => {
  if (win.id === FLOATING_WINDOW_OPACITY_PRESET.id) {
    dialogue.show({
      tone: 'info',
      title: 'CONFIRM CLOSE',
      content:
        'Are you sure you want to close Floating Window Opacity?\nYou can restore it at any time from Settings > Advanced.',
      buttons: [
        {
          label: 'Confirm',
          variant: 'primary',
          onClick: () => {
            defaultClose();
          },
        },
        {
          label: 'Cancel',
          variant: 'outline',
        },
      ],
    });
    return;
  }
  if (win.id === SUBSYSTEM_ISOLATION_LAB_PRESET.id) {
    defaultClose();
    const uiState = useAppStore.getState();
    if (uiState.matchMode === 'dev-test-lab') {
      uiState.bridge.onReturnToFreeplay?.();
    }
    return;
  }
  if (
    win.id === EXPERIMENTAL_MULTI_BOTS_PRESET.id ||
    win.id === 'experimental-multi-bots'
  ) {
    defaultClose();
    const uiState = useAppStore.getState();
    if (uiState.matchMode === 'exp-multi-bots') {
      uiState.bridge.onReturnToFreeplay?.();
    }
    return;
  }
  if (win.id === REPLAY_VIEWER_PRESET.id) {
    defaultClose();
    const uiState = useAppStore.getState();
    const rvState = useReplayViewerStore.getState();
    if (
      uiState.matchMode === 'replay-viewer' ||
      (rvState.loadedFileName && rvState.totalFrames > 0) ||
      rvState.viewerState !== 'idle'
    ) {
      uiState.bridge.onReturnToFreeplay?.();
    }
    return;
  }
  if (win.id === KICKOFF_TRAINING_PRESET.id) {
    defaultClose();
    const uiState = useAppStore.getState();
    if (uiState.matchMode === 'kickoff-training') {
      uiState.bridge.onReturnToFreeplay?.();
    }
    return;
  }
  if (win.id === NAME_TAG_TUNER_PRESET.id) {
    defaultClose();
    const ntState = useNameTagTunerStore.getState();
    if (ntState.isTunerArenaActive) {
      ntState.exitTunerArena();
    }
    return;
  }
  if (win.id === REPLAY_DIRECTOR_TUNER_PRESET.id) {
    defaultClose();
    const ctrl = getActiveReplayTimelineController();
    if (ctrl?.isActive && (ctrl?.isImportedPreview || ctrl?.isPersistent)) {
      exitActiveReplayDirectorPreview();
    }
    return;
  }
  if (win.id === REWINDER_CONFIGURATOR_PRESET.id) {
    defaultClose();
    const rwState = useRewinderStore.getState();
    if (
      rwState.rewinderState === 'paused-scrub' ||
      rwState.rewinderState === 'rewinding' ||
      rwState.rewinderState === 'forwarding' ||
      rwState.rewinderState === 'preroll-countdown'
    ) {
      rwState.runtimeHandlers.onRewinderClearBuffer?.();
    }
    return;
  }
  defaultClose();
};
