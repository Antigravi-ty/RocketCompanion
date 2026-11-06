/**
 * ReplayHotkeySubController.ts
 * Stateful hotkey subscription and window priority conflict guard SubController
 * shared by StandaloneReplayViewerController and FreeplayRewinderController.
 */

import {
  isGlobalHotkeyBlockedByUi,
  subscribeGlobalKeyDown,
  subscribeGlobalKeyUp,
} from '../input/hotkeyInputGuard.ts';

export interface ReplayViewerHotkeyBindings {
  getRuntime: () => Record<string, any> | null;
  hasLoadedReplay: () => boolean;
  hasFrames: () => boolean;
  getWindowStatus: () => { isWindowOpen: boolean; hasHotkeyPriority: boolean };
  conflictErrorMessage: string;
  onSelectPovSlot: (slotKey: number) => void;
  onStartPlaying: () => void;
  onPausePlaying: () => void;
  onResumeFromCursor: () => void;
  onBeginScrub: (direction: 'rewinding' | 'forwarding') => void;
  onPauseScrub: () => void;
}

export interface FreeplayRewinderHotkeyBindings {
  getRuntime: () => Record<string, any> | null;
  getWindowStatus: () => { isWindowOpen: boolean; hasHotkeyPriority: boolean };
  conflictErrorMessage: string;
  onStartNewRecording: () => void;
  onStopRecording: () => void;
  onResumeFromCursor: () => void;
  onBeginScrub: (direction: 'rewinding' | 'forwarding') => void;
  onPauseScrub: () => void;
}

export class ReplayHotkeySubController {
  private _keyDownHandler: ((evt: KeyboardEvent) => void) | null = null;
  private _keyUpHandler: ((evt: KeyboardEvent) => void) | null = null;
  private _unsubKeyDown: (() => void) | null = null;
  private _unsubKeyUp: (() => void) | null = null;
  private _loggedHotkeyConflict = false;

  public checkWindowOpenAndPriority(
    status: { isWindowOpen: boolean; hasHotkeyPriority: boolean },
    conflictErrorMessage: string
  ): boolean {
    if (!status.isWindowOpen) {
      this._loggedHotkeyConflict = false;
      return false;
    }
    if (!status.hasHotkeyPriority) {
      if (!this._loggedHotkeyConflict) {
        this._loggedHotkeyConflict = true;
        console.error(conflictErrorMessage);
      }
      return false;
    }
    this._loggedHotkeyConflict = false;
    return true;
  }

  public bindReplayViewerHotkeys(bindings: ReplayViewerHotkeyBindings): void {
    if (typeof window === 'undefined') return;
    this.unbind();

    this._keyDownHandler = (evt: KeyboardEvent) => {
      const runtime = bindings.getRuntime();
      const activeMode = runtime?.match?.state?.mode;
      if (activeMode !== 'freeplay' && activeMode !== 'replay-viewer') return;
      if (isGlobalHotkeyBlockedByUi(evt, runtime)) return;

      const noMods = !evt.ctrlKey && !evt.shiftKey && !evt.altKey && !evt.metaKey;
      if (bindings.hasLoadedReplay() && noMods) {
        let keyNum = -1;
        if (evt.code >= 'Digit1' && evt.code <= 'Digit6') {
          keyNum = Number(evt.code.replace('Digit', ''));
        } else if (evt.code >= 'Numpad1' && evt.code <= 'Numpad6') {
          keyNum = Number(evt.code.replace('Numpad', ''));
        }
        if (keyNum >= 1 && keyNum <= 6) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          if (!evt.repeat) bindings.onSelectPovSlot(keyNum);
          return;
        }
      }

      const isOpen = this.checkWindowOpenAndPriority(
        bindings.getWindowStatus(),
        bindings.conflictErrorMessage
      );
      if (!isOpen || !bindings.hasFrames()) return;

      if ((evt.code === 'KeyO' || evt.key === 'o' || evt.key === 'O') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          bindings.onStartPlaying();
        }
        return;
      }
      if ((evt.code === 'KeyP' || evt.key === 'p' || evt.key === 'P') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          bindings.onPausePlaying();
        }
        return;
      }
      if ((evt.code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && noMods) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          bindings.onResumeFromCursor();
        }
        return;
      }
      if (evt.code === 'BracketLeft' || evt.key === '[') {
        evt.preventDefault();
        if (!evt.repeat) bindings.onBeginScrub('rewinding');
        return;
      }
      if (evt.code === 'BracketRight' || evt.key === ']') {
        evt.preventDefault();
        if (!evt.repeat) bindings.onBeginScrub('forwarding');
      }
    };

    this._keyUpHandler = (evt: KeyboardEvent) => {
      const runtime = bindings.getRuntime();
      const activeMode = runtime?.match?.state?.mode;
      if (activeMode !== 'freeplay' && activeMode !== 'replay-viewer') return;
      const isOpen = this.checkWindowOpenAndPriority(
        bindings.getWindowStatus(),
        bindings.conflictErrorMessage
      );
      if (!isOpen || !bindings.hasFrames()) return;
      if (
        evt.code === 'BracketLeft' ||
        evt.key === '[' ||
        evt.code === 'BracketRight' ||
        evt.key === ']'
      ) {
        evt.preventDefault();
        bindings.onPauseScrub();
      }
    };

    this._unsubKeyDown = subscribeGlobalKeyDown(this._keyDownHandler, true);
    this._unsubKeyUp = subscribeGlobalKeyUp(this._keyUpHandler, true);
  }

  public bindFreeplayRewinderHotkeys(bindings: FreeplayRewinderHotkeyBindings): void {
    if (typeof window === 'undefined') return;
    this.unbind();

    this._keyDownHandler = (evt: KeyboardEvent) => {
      const runtime = bindings.getRuntime();
      if (isGlobalHotkeyBlockedByUi(evt, runtime)) return;
      if (
        !this.checkWindowOpenAndPriority(
          bindings.getWindowStatus(),
          bindings.conflictErrorMessage
        )
      ) {
        return;
      }

      const noMods = !evt.ctrlKey && !evt.shiftKey && !evt.altKey && !evt.metaKey;
      const isRecordKey = (evt.code === 'KeyO' || evt.key === 'o' || evt.key === 'O') && noMods;
      const isStopKey = (evt.code === 'KeyP' || evt.key === 'p' || evt.key === 'P') && noMods;
      const isResumeKey = (evt.code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && noMods;
      const isRewindKey = evt.code === 'BracketLeft' || evt.key === '[';
      const isForwardKey = evt.code === 'BracketRight' || evt.key === ']';

      if (!isRecordKey && !isStopKey && !isResumeKey && !isRewindKey && !isForwardKey) return;

      const currentMode = runtime?.match?.state?.mode || 'freeplay';
      if (currentMode === 'dev-test-lab') return;
      if (currentMode !== 'freeplay') return;

      if (isRecordKey) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          bindings.onStartNewRecording();
        }
        return;
      }
      if (isStopKey) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          bindings.onStopRecording();
        }
        return;
      }
      if (isResumeKey) {
        if (!evt.repeat) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          bindings.onResumeFromCursor();
        }
        return;
      }
      if (isRewindKey) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        if (!evt.repeat) bindings.onBeginScrub('rewinding');
        return;
      }
      if (isForwardKey) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        if (!evt.repeat) bindings.onBeginScrub('forwarding');
      }
    };

    this._keyUpHandler = (evt: KeyboardEvent) => {
      const runtime = bindings.getRuntime();
      if (runtime?.match?.state?.mode !== 'freeplay') return;
      if (
        !this.checkWindowOpenAndPriority(
          bindings.getWindowStatus(),
          bindings.conflictErrorMessage
        )
      ) {
        return;
      }
      if (
        evt.code === 'BracketLeft' ||
        evt.key === '[' ||
        evt.code === 'BracketRight' ||
        evt.key === ']'
      ) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        bindings.onPauseScrub();
      }
    };

    this._unsubKeyDown = subscribeGlobalKeyDown(this._keyDownHandler, true);
    this._unsubKeyUp = subscribeGlobalKeyUp(this._keyUpHandler, true);
  }

  public unbind(): void {
    this._unsubKeyDown?.();
    this._unsubKeyDown = null;
    this._keyDownHandler = null;
    this._unsubKeyUp?.();
    this._unsubKeyUp = null;
    this._keyUpHandler = null;
  }
}
