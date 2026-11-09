import {
  useAppStore,
  hudStore,
  useExperimentalMultiBotsStore,
  floatingStore,
  NETWORK_MONITOR_PRESET,
  networkDiagnosticsStore,
  globalHudTransientChannel,
} from '../runtimeUiPort.ts';
import {
  resolveSlotKeyTargetCarEntry,
  type ExpSpawnedCarEntry,
} from '../modes/experimental-multi-bots/ExperimentalMultiBotsMatchMath.ts';
import type { KeyboardMouseController } from '../../input/KeyboardMouseController.ts';
import type { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { RuntimeNetworkManager } from './RuntimeNetworkManager.ts';

export interface ActiveModeReplayPort {
  id?: string;
  isReplayActive?: boolean;
  replayCameraMode?: string;
  replayPovCarIndex?: number | null;
  goalReplayPhase?: string;
  spawnedCars?: ReadonlyArray<ExpSpawnedCarEntry>;
  isGoalReplayActive?(): boolean;
  setReplayCameraMode?(mode: string): void;
  directorPreview?: {
    isReplayActive?: boolean;
  } | null;
  replaySession?: {
    isReplayActive?: boolean;
    replayCameraMode?: string;
    replayPovCarIndex?: number | null;
    replayController?: {
      directorCameraState?: { initialized?: boolean } | null;
    } | null;
  } | null;
  rosterController?: {
    spawnedCars?: ReadonlyArray<ExpSpawnedCarEntry>;
  } | null;
  replayController?: {
    directorCameraState?: { initialized?: boolean } | null;
  } | null;
  goalReplayTimelineController?: {
    sessionState?: { isActive?: boolean } | null;
    togglePause(): void;
  } | null;
  _applyCameraCarIndex?(carIndex: number): void;
  skipGoalReplay?(): void;
}

export interface RuntimeWindowHotkeysHostPort {
  readonly match: RuntimeMatchState | null;
  readonly modeManager: { getActiveMode(): ActiveModeReplayPort | null } | null;
  readonly keyboard: KeyboardMouseController | null;
  readonly replayTimelineController: ReplayTimelineController | null;
  readonly camera: CameraManager | null;
  readonly domEventManager: { syncPausedAndInputState?(): void } | null;
  readonly gameUI: { openMenu(route: string): void; toggleMenu?(): void } | null;
  readonly networkManager: RuntimeNetworkManager | null;
  readonly _lastHudSlotCarMap: Record<number, number> | null;
  replayPovCarIndex: number | null;
  _localSkipReplayReady: boolean;
  isCursorBrowsing: boolean;
  acquireGoalReplayCameraOverride(): void;
  releaseGoalReplayCameraOverride(): void;
}

function isEditableFormElement(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false;
  const elem = el as HTMLElement & { type?: string };
  if (elem.isContentEditable) return true;
  const tag = typeof elem.tagName === 'string' ? elem.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (elem.type || 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color'].includes(type);
  }
  return false;
}

function isNetworkDiagnosticsWindowPresent(): boolean {
  const windows = floatingStore.getSnapshot()?.windows || [];
  return windows.some((w) => w.id === NETWORK_MONITOR_PRESET.id);
}

function isReplayDirectorTunerWindowPresent(): boolean {
  const windows = floatingStore.getSnapshot()?.windows || [];
  return windows.some((w) => w.id === 'replay-director-tuner');
}

/**
 * RuntimeWindowHotkeysController
 * SubController owning global window keydown handling for goal replay skip,
 * replay POV camera slot selection (1-7), replay director pause (P),
 * network diagnostics hotkeys (8/9/0), and menu escape fallback.
 */
export class RuntimeWindowHotkeysController {
  public readonly runtime: RuntimeWindowHotkeysHostPort;

  constructor(runtime: RuntimeWindowHotkeysHostPort) {
    this.runtime = runtime;
  }

  public selectReplayCameraSlot(slotKey: number | null): boolean {
    const runtime = this.runtime;
    if (!runtime) return false;
    const activeMode = runtime.modeManager?.getActiveMode?.();
    const isModeReplayActive = Boolean(
      activeMode?.isGoalReplayActive?.() ||
      activeMode?.directorPreview?.isReplayActive ||
      activeMode?.replaySession?.isReplayActive
    );
    const isGoalReplay =
      runtime.match?.state?.phase === 'replay' ||
      hudStore.getState().matchPhase === 'replay' ||
      isModeReplayActive;

    if (slotKey === 7 || slotKey === 0 || slotKey === null) {
      if (!isGoalReplay) return false;
      runtime.replayPovCarIndex = null;
      runtime.acquireGoalReplayCameraOverride();
      if (runtime.replayTimelineController?.directorCameraState) {
        runtime.replayTimelineController.directorCameraState.initialized = false;
      }
      if (activeMode && isModeReplayActive) {
        activeMode.setReplayCameraMode?.('director');
        if (activeMode.replaySession) {
          activeMode.replaySession.replayCameraMode = 'director';
        }
        const modeReplayCtrl =
          activeMode.replayController ?? activeMode.replaySession?.replayController;
        if (modeReplayCtrl?.directorCameraState) {
          modeReplayCtrl.directorCameraState.initialized = false;
        }
      }
      hudStore.getState().setReplayState?.({ replayCameraMode: 'director' });
      globalHudTransientChannel.setRoster({ focusedSlotKey: null });
      return true;
    }

    if (slotKey >= 1 && slotKey <= 6) {
      let targetCarIdx = runtime._lastHudSlotCarMap?.[slotKey];
      const spawnedCars = activeMode?.rosterController?.spawnedCars;
      if (
        (typeof targetCarIdx !== 'number' || targetCarIdx < 0) &&
        spawnedCars &&
        spawnedCars.length > 0
      ) {
        const entry = resolveSlotKeyTargetCarEntry(
          spawnedCars,
          hudStore.getState().localTeam,
          slotKey
        );
        targetCarIdx = entry ? entry.carIndex : -1;
      }
      if (typeof targetCarIdx !== 'number' || targetCarIdx < 0) {
        return false;
      }

      if (isGoalReplay) {
        runtime.replayPovCarIndex = targetCarIdx;
        runtime.releaseGoalReplayCameraOverride();
        if (activeMode && isModeReplayActive) {
          activeMode.setReplayCameraMode?.('pov');
          if (activeMode.replaySession) {
            activeMode.replaySession.replayCameraMode = 'pov';
            activeMode.replaySession.replayPovCarIndex = targetCarIdx;
          }
          activeMode._applyCameraCarIndex?.(targetCarIdx);
          useExperimentalMultiBotsStore.getState().setActiveCameraCarIndex(targetCarIdx);
        }
        runtime.camera?.setFocusedCarIndex?.(targetCarIdx);
        runtime.camera?.resetView?.();
        hudStore.getState().setReplayState?.({ replayCameraMode: 'pov' });
        globalHudTransientChannel.setRoster({ focusedSlotKey: slotKey });
        return true;
      }

      if (
        runtime.match?.state?.mode === 'exp-multi-bots' &&
        useExperimentalMultiBotsStore.getState().playerParticipation === 'none'
      ) {
        activeMode?._applyCameraCarIndex?.(targetCarIdx);
        useExperimentalMultiBotsStore.getState().setActiveCameraCarIndex(targetCarIdx);
        globalHudTransientChannel.setRoster({ focusedSlotKey: slotKey });
        return true;
      }
    }

    return false;
  }

  public readonly handleKeyDown = (evt: KeyboardEvent): void => {
    if (evt.defaultPrevented) return;
    const runtime = this.runtime;
    const net = runtime?.networkManager;

    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const isOutsideEditableUI =
      !isEditableFormElement(evt.target) && !isEditableFormElement(activeEl);

    const isGoalReplay =
      runtime?.match?.state?.phase === 'replay' ||
      hudStore.getState().matchPhase === 'replay' ||
      Boolean(runtime?.modeManager?.getActiveMode?.()?.isReplayActive);

    const skipReplaySources = runtime?.keyboard?.boundSources?.('skipReplay');
    const hasCustomSkipReplayBinding =
      Array.isArray(skipReplaySources) && skipReplaySources.length > 0;
    const matchesSkipReplayBinding = hasCustomSkipReplayBinding
      ? Boolean(
          runtime?.keyboard?.matches?.('skipReplay', { kind: 'key', code: evt.code }) ||
          (evt.code === 'NumpadEnter' &&
            runtime?.keyboard?.matches?.('skipReplay', { kind: 'key', code: 'Enter' }))
        )
      : evt.code === 'Enter' || evt.code === 'NumpadEnter' || evt.key === 'Enter';

    if (
      isGoalReplay &&
      isOutsideEditableUI &&
      !evt.repeat &&
      !evt.ctrlKey &&
      !evt.metaKey &&
      !evt.altKey &&
      matchesSkipReplayBinding
    ) {
      const isMenuOpen = Boolean(useAppStore?.getState?.()?.isOpen);
      if (!isMenuOpen) {
        evt.preventDefault();
        runtime._localSkipReplayReady = true;
        if (net?.sessionCoordinator.networkReconciler) {
          net.sessionCoordinator.networkReconciler.localSkipReplayReady = true;
          net.sessionCoordinator.networkReconciler.controlMessenger.flushPendingControlPackets(
            net.sessionCoordinator.networkReconciler,
            performance.now()
          );
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

    const isExpSpectatorLive =
      !isGoalReplay &&
      runtime?.match?.state?.mode === 'exp-multi-bots' &&
      useExperimentalMultiBotsStore.getState().playerParticipation === 'none';

    if (
      (isGoalReplay || isExpSpectatorLive) &&
      isOutsideEditableUI &&
      !evt.repeat &&
      !evt.ctrlKey &&
      !evt.metaKey &&
      !evt.altKey &&
      !Boolean(useAppStore?.getState?.()?.isOpen)
    ) {
      let slotNum = -1;
      if (evt.code >= 'Digit0' && evt.code <= 'Digit7') {
        slotNum = Number(evt.code.replace('Digit', ''));
      } else if (evt.code >= 'Numpad0' && evt.code <= 'Numpad7') {
        slotNum = Number(evt.code.replace('Numpad', ''));
      } else if (evt.key >= '0' && evt.key <= '7') {
        slotNum = Number(evt.key);
      }

      if (slotNum === 0 && isNetworkDiagnosticsWindowPresent()) {
        slotNum = -1;
      }

      if (slotNum >= 0 && slotNum <= 7) {
        if (this.selectReplayCameraSlot(slotNum)) {
          evt.preventDefault();
          return;
        }
      }
    }

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
        activeMode?.goalReplayTimelineController?.sessionState?.isActive
      ) {
        evt.preventDefault();
        activeMode.goalReplayTimelineController.togglePause();
        runtime.isCursorBrowsing = true;
        runtime.domEventManager?.syncPausedAndInputState?.();
        return;
      }
    }

    if (isNetworkDiagnosticsWindowPresent() && net) {
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
          if (!net.sessionCoordinator.networkReconciler) {
            net.sessionCoordinator.enableNetworkPrediction(false).then(() => {
              networkDiagnosticsStore.setSession(
                net.sessionCoordinator.networkReconciler,
                net.sessionCoordinator.networkChannel,
                runtime
              );
              networkDiagnosticsStore.toggleBurstDrop();
            });
          } else {
            networkDiagnosticsStore.toggleBurstDrop();
          }
          return;
        }
      }

      if (
        (evt.code === 'Digit9' || evt.code === 'Numpad9' || evt.key === '9') &&
        !evt.repeat &&
        !evt.ctrlKey &&
        !evt.metaKey &&
        !evt.altKey
      ) {
        if (isOutsideEditableUI) {
          evt.preventDefault();
          net.diagnosticsProbe.adjustSimulatedLatency(-1);
          return;
        }
      }

      if (
        (evt.code === 'Digit0' || evt.code === 'Numpad0' || evt.key === '0') &&
        !evt.repeat &&
        !evt.ctrlKey &&
        !evt.metaKey &&
        !evt.altKey
      ) {
        if (isOutsideEditableUI) {
          evt.preventDefault();
          net.diagnosticsProbe.adjustSimulatedLatency(1);
          return;
        }
      }
    }

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
