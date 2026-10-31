import { useAppStore } from '../../ui-core/stores/appStore';
import { hudStore } from '../../ui-core/stores/hudStore';
import { useExperimentalMultiBotsStore } from '../../ui-core/stores/experimentalMultiBotsStore';
import { floatingStore } from '../../ui-core/stores/floatingStore';
import { NETWORK_MONITOR_PRESET } from '../../ui-core/stores/floatingPresets';
import { networkDiagnosticsStore } from '../../ui-core/stores/networkDiagnosticsStore';
import { globalHudTransientChannel } from '../../ui-core/stores/hudTransientChannel';

function isEditableFormElement(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color'].includes(type);
  }
  return false;
}

function isNetworkDiagnosticsWindowPresent() {
  const windows = floatingStore.getSnapshot()?.windows || [];
  return windows.some((w) => w.id === NETWORK_MONITOR_PRESET.id);
}

function isReplayDirectorTunerWindowPresent() {
  const windows = floatingStore.getSnapshot()?.windows || [];
  return windows.some((w) => w.id === 'replay-director-tuner');
}

export function selectRuntimeReplayCameraSlot(runtime, slotKey) {
  if (!runtime) return false;
  const activeMode = runtime.modeManager?.getActiveMode?.();

  // Slot 7 (or 0 / null): switch back to Director camera
  if (slotKey === 7 || slotKey === 0 || slotKey === null) {
    runtime.replayPovCarIndex = null;
    runtime.goalReplayCameraOverrideActive = true;
    if (runtime.replayTimelineController?.directorCameraState) {
      runtime.replayTimelineController.directorCameraState.initialized = false;
    }
    if (activeMode && activeMode.isReplayActive) {
      activeMode.replayCameraMode = 'director';
      if (activeMode.replayController?.directorCameraState) {
        activeMode.replayController.directorCameraState.initialized = false;
      }
    }
    hudStore.getState().setReplayState?.({ replayCameraMode: 'director' });
    globalHudTransientChannel.setRoster({ focusedSlotKey: null });
    return true;
  }

  if (slotKey >= 1 && slotKey <= 6) {
    let targetCarIdx = runtime._lastHudSlotCarMap?.[slotKey];
    if (typeof targetCarIdx !== 'number' || targetCarIdx < 0) {
      return false;
    }
    runtime.replayPovCarIndex = targetCarIdx;
    runtime.goalReplayCameraOverrideActive = false;
    if (activeMode && activeMode.isReplayActive) {
      activeMode.replayCameraMode = 'pov';
      activeMode.replayPovCarIndex = targetCarIdx;
      activeMode._applyCameraCarIndex?.(targetCarIdx);
      useExperimentalMultiBotsStore.getState().setActiveCameraCarIndex(targetCarIdx);
    }
    runtime.camera?.setFocusedCarIndex?.(targetCarIdx);
    runtime.camera?.resetView?.();
    hudStore.getState().setReplayState?.({ replayCameraMode: 'pov' });
    globalHudTransientChannel.setRoster({ focusedSlotKey: slotKey });
    return true;
  }

  return false;
}

export function createRuntimeWindowKeyDownHandler(runtime) {
  return (evt) => {
    if (evt.defaultPrevented) return;

    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const isOutsideEditableUI =
      !isEditableFormElement(evt.target) &&
      !isEditableFormElement(activeEl);

    const isGoalReplay =
      runtime?.match?.state?.phase === 'replay' ||
      hudStore.getState().matchPhase === 'replay' ||
      Boolean(runtime?.modeManager?.getActiveMode?.()?.isReplayActive);

    // Hotkey Enter: Vote / trigger Skip Replay during Goal Replay
    if (
      isGoalReplay &&
      isOutsideEditableUI &&
      !evt.repeat &&
      !evt.ctrlKey &&
      !evt.metaKey &&
      !evt.altKey &&
      (evt.code === 'Enter' || evt.code === 'NumpadEnter' || evt.key === 'Enter')
    ) {
      const isMenuOpen = Boolean(useAppStore?.getState?.()?.isOpen);
      if (!isMenuOpen) {
        evt.preventDefault();
        runtime._localSkipReplayReady = true;
        if (runtime.networkReconciler) {
          runtime.networkReconciler.localSkipReplayReady = true;
          runtime.networkReconciler.flushPendingControlPackets?.(performance.now());
        } else {
          const skipFn = hudStore.getState().onReplaySkip;
          const activeMode = runtime?.modeManager?.getActiveMode?.();
          if (typeof skipFn === 'function') {
            skipFn();
          } else if (typeof activeMode?.skipGoalReplay === 'function') {
            activeMode.skipGoalReplay();
          }
        }
        return;
      }
    }

    // Hotkeys 1-6 (switch player POV) and 7 (switch back to Director camera) during Goal Replay
    if (
      isGoalReplay &&
      isOutsideEditableUI &&
      !evt.repeat &&
      !evt.ctrlKey &&
      !evt.metaKey &&
      !evt.altKey
    ) {
      let slotNum = -1;
      if (evt.code >= 'Digit1' && evt.code <= 'Digit7') {
        slotNum = Number(evt.code.replace('Digit', ''));
      } else if (evt.code >= 'Numpad1' && evt.code <= 'Numpad7') {
        slotNum = Number(evt.code.replace('Numpad', ''));
      } else if (evt.key >= '1' && evt.key <= '7') {
        slotNum = Number(evt.key);
      }

      if (slotNum >= 1 && slotNum <= 7) {
        if (selectRuntimeReplayCameraSlot(runtime, slotNum)) {
          evt.preventDefault();
          return;
        }
      }
    }

    // Hotkey P: Pause & Persistent Goal Replay (ONLY allowed when Replay Director Camera & Slow-Mo Tuner floating window is enabled)
    if (
      evt.code === 'KeyP' &&
      !evt.repeat &&
      !evt.ctrlKey &&
      !evt.metaKey &&
      !evt.altKey &&
      isOutsideEditableUI &&
      isReplayDirectorTunerWindowPresent()
    ) {
      const isOnlineSession = Boolean(useAppStore?.getState?.()?.onlineSession?.roomId);
      const isMenuOpen = Boolean(useAppStore?.getState?.()?.isOpen);

      if (!isOnlineSession && !isMenuOpen && isGoalReplay) {
        const togglePause = hudStore.getState().onReplayTogglePause;
        if (typeof togglePause === 'function') {
          evt.preventDefault();
          togglePause();
          runtime.isCursorBrowsing = true;
          runtime.domEventManager?.syncPausedAndInputState?.();
          return;
        }
      }

      const activeMode = runtime?.modeManager?.getActiveMode?.();
      if (
        !isOnlineSession &&
        !isMenuOpen &&
        activeMode?.goalReplayPhase === 'replaying' &&
        activeMode?.goalReplayTimelineController?.isActive
      ) {
        evt.preventDefault();
        activeMode.goalReplayTimelineController.togglePause();
        runtime.isCursorBrowsing = true;
        runtime.domEventManager?.syncPausedAndInputState?.();
        return;
      }
    }

    if (isNetworkDiagnosticsWindowPresent()) {
      // Hotkey 8: Intermittent burst packet drop toggle (when Network Diagnostics window exists)
      if (
        (evt.code === 'Digit8' || evt.code === 'Numpad8' || evt.key === '8') &&
        !evt.repeat &&
        !evt.ctrlKey &&
        !evt.metaKey &&
        !evt.altKey &&
        !evt.shiftKey
      ) {
        if (isOutsideEditableUI) {
          evt.preventDefault();
          if (!runtime.networkReconciler) {
            runtime.enableNetworkPrediction(false).then(() => {
              networkDiagnosticsStore.setSession(runtime.networkReconciler, runtime.networkChannel, runtime);
              networkDiagnosticsStore.toggleBurstDrop();
            });
          } else {
            networkDiagnosticsStore.toggleBurstDrop();
          }
          return;
        }
      }

      // Hotkey 9: Simulated latency decrease (by configured adjustStepMs, default -50ms)
      if (
        (evt.code === 'Digit9' || evt.code === 'Numpad9' || evt.key === '9') &&
        !evt.repeat &&
        !evt.ctrlKey &&
        !evt.metaKey &&
        !evt.altKey
      ) {
        if (isOutsideEditableUI) {
          evt.preventDefault();
          runtime.adjustSimulatedLatency(-1);
          return;
        }
      }

      // Hotkey 0: Simulated latency increase (by configured adjustStepMs, default +50ms)
      if (
        (evt.code === 'Digit0' || evt.code === 'Numpad0' || evt.key === '0') &&
        !evt.repeat &&
        !evt.ctrlKey &&
        !evt.metaKey &&
        !evt.altKey
      ) {
        if (isOutsideEditableUI) {
          evt.preventDefault();
          runtime.adjustSimulatedLatency(1);
          return;
        }
      }
    }

    // Escape key: defer to GameUIRoot when modern UI store is active so ESC steps back one level at a time
    if (evt.code === 'Escape') {
      if (typeof useAppStore?.getState === 'function') {
        return;
      }
      if (isOutsideEditableUI) {
        evt.preventDefault();
        if (runtime.gameUI) {
          runtime.gameUI.openMenu('main-menu');
        }
        return;
      }
    }
  };
}
