import * as THREE from 'three';
import {
  useStaticTrainingPackStore,
  getActiveEditItemVariable,
  mutateActiveEditItemVariable,
  useStaticTrainingBallCamTunerStore,
  useAppStore,
  hudStore,
  floatingStore,
} from '../../runtimeUiPort.ts';
import { isEditableEventTarget } from '../../../input/hotkeyInputGuard.ts';
import {
  CAR_GROUND_MIN_Z,
  StaticTrainingEditSubMode,
  StaticTrainingShotConfig,
  computeEditorContinuousDeltas,
  applyContinuousDeltasToShotDraft,
  applyMouseDragToShotDraft,
} from './ShotGizmoMath.ts';
import {
  computeThreeJsFreeCamPoseFromShot,
  extractShotEditorFreeCamFromSnapshot,
} from './staticTrainingVariationMath.ts';

export interface StaticTrainingShotEditorHostCallbacks {
  getRuntime: () => any;
  isReplayActive: () => boolean;
  getReplayController: () => any;
  isTestingSingleShot: () => boolean;
  isFreeCamTrajectoryTesting: () => boolean;
  getCurrentShotConfig: () => StaticTrainingShotConfig | null;
  reloadCurrentShot: () => void;
  toggleSingleShotTest: () => void;
  toggleFreeCamTrajectoryTest: () => void;
  stopFreeCamTrajectoryTest: () => void;
}

function hasActiveModalDialogue(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[role="dialog"]') !== null;
}

function isReplayDirectorTunerWindowPresent(): boolean {
  const windows = floatingStore.getSnapshot()?.windows || [];
  return windows.some((w: any) => w.id === 'replay-director-tuner');
}

export class StaticTrainingShotEditor {
  private readonly host: StaticTrainingShotEditorHostCallbacks;

  public readonly heldKeys = new Set<string>();
  public isLeftMouseDragging = false;
  public lastMouseX = 0;
  public lastMouseY = 0;
  public ballSpeedZeroLatch = false;

  private keyDownHandler: ((evt: KeyboardEvent) => void) | null = null;
  private keyUpHandler: ((evt: KeyboardEvent) => void) | null = null;
  private mouseDownHandler: ((evt: MouseEvent) => void) | null = null;
  private mouseMoveHandler: ((evt: MouseEvent) => void) | null = null;
  private mouseUpHandler: ((evt: MouseEvent) => void) | null = null;
  private contextMenuHandler: ((evt: MouseEvent) => void) | null = null;

  constructor(host: StaticTrainingShotEditorHostCallbacks) {
    this.host = host;
  }

  resetInputState(): void {
    this.heldKeys.clear();
    this.isLeftMouseDragging = false;
    this.ballSpeedZeroLatch = false;
  }

  applyEditSubModeCamera(subMode: StaticTrainingEditSubMode): void {
    const r = this.host.getRuntime();
    if (!r?.camera) return;

    const testingSingle = this.host.isTestingSingleShot();

    if (subMode !== 'free-cam' && this.host.isFreeCamTrajectoryTesting()) {
      this.host.stopFreeCamTrajectoryTest();
    }

    if (testingSingle) {
      r.camera.setEditorOverride?.(false);
      r.releaseGoalReplayCameraOverride();
      if (r.camera.isFreeCam) {
        r.camera.setFreeCam(false);
      }
      return;
    }

    if (subMode === 'free-cam') {
      r.camera.setEditorOverride?.(false);
      r.releaseGoalReplayCameraOverride();
      const shot = this.host.getCurrentShotConfig();
      const freePose = shot ? computeThreeJsFreeCamPoseFromShot(shot) : null;
      if (freePose && typeof r.camera.setFreeCamPose === 'function') {
        r.camera.setFreeCamPose(freePose.position, freePose.lookAt);
      } else {
        r.camera.setFreeCam(true);
      }
    } else {
      if (r.camera.isFreeCam) {
        const store = useStaticTrainingPackStore.getState();
        if (store.isEditingItem && typeof r.camera.getFreeCamStateSnapshot === 'function') {
          const snap = r.camera.getFreeCamStateSnapshot();
          if (snap && Array.isArray(snap.eyeUnreal)) {
            mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
              draft.editorFreeCam = extractShotEditorFreeCamFromSnapshot(snap);
            });
          }
        }
        r.camera.setFreeCam(false);
      }
      r.camera.setEditorOverride?.(true);
      const shot = this.host.getCurrentShotConfig();
      if (shot) {
        r.camera.syncEditorShotCamera?.(
          subMode,
          shot,
          useStaticTrainingBallCamTunerStore.getState()
        );
      }
    }
  }

  updateCameraAndContinuousInputs(dt: number): void {
    const r = this.host.getRuntime();
    const store = useStaticTrainingPackStore.getState();
    if (store.sessionMode !== 'edit' || this.host.isTestingSingleShot()) return;

    const subMode = store.editSubMode as StaticTrainingEditSubMode;
    const shot = this.host.getCurrentShotConfig();
    if (!shot) return;

    if (subMode !== 'free-cam' && r?.camera) {
      r.camera.setEditorOverride?.(true);
      r.camera.syncEditorShotCamera?.(
        subMode,
        shot,
        useStaticTrainingBallCamTunerStore.getState()
      );
    }

    const appState = useAppStore.getState();
    const isModalBlocking =
      hasActiveModalDialogue() ||
      (appState.isOpen && !appState.isLivePreviewCollapsed);
    if (isModalBlocking) {
      if (this.heldKeys.size > 0) this.heldKeys.clear();
      return;
    }
    if (subMode === 'free-cam' || this.heldKeys.size === 0) return;

    let camDirX = 0;
    let camDirZ = 1;
    if (r?.camera?.camera) {
      const dir = new THREE.Vector3();
      r.camera.camera.getWorldDirection(dir);
      camDirX = dir.x;
      camDirZ = dir.z;
    }

    const deltas = computeEditorContinuousDeltas({
      heldKeys: this.heldKeys,
      subMode,
      dt,
      camDirX,
      camDirZ,
    });
    if (!deltas.hasAnyChange) return;

    mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
      const res = applyContinuousDeltasToShotDraft(
        draft,
        subMode,
        deltas,
        this.ballSpeedZeroLatch
      );
      this.ballSpeedZeroLatch = res.nextBallSpeedZeroLatch;
    });
  }

  bindSessionEvents(): void {
    if (typeof window === 'undefined') return;
    this.unbindSessionEvents();

    const isInputFocused = (evt: Event) => isEditableEventTarget(evt);

    this.keyDownHandler = (evt: KeyboardEvent) => {
      const r = this.host.getRuntime();
      if (r?.match?.state?.mode !== 'static-training-pack') return;
      if (isInputFocused(evt)) return;

      const store = useStaticTrainingPackStore.getState();
      const code = evt.code;

      if (this.host.isReplayActive() && (code === 'KeyP' || evt.key === 'p' || evt.key === 'P')) {
        if (!isReplayDirectorTunerWindowPresent()) {
          return;
        }
        if (!evt.repeat) {
          evt.preventDefault();
          const replayCtrl = this.host.getReplayController();
          const paused = replayCtrl.togglePause();
          hudStore.getState().setReplayState({
            replayPaused: paused,
            replayPersistent: replayCtrl.sessionState.isPersistent,
          });
        }
        return;
      }

      if (store.sessionMode === 'edit' && this.host.isTestingSingleShot()) {
        if ((code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && !evt.repeat) {
          evt.preventDefault();
          this.host.toggleSingleShotTest();
          return;
        }
        if ((code === 'KeyR' || evt.key === 'r' || evt.key === 'R') && !evt.repeat) {
          evt.preventDefault();
          this.host.reloadCurrentShot();
          return;
        }
        if ((code === 'KeyF' || evt.key === 'f' || evt.key === 'F') && !evt.repeat) {
          const enableFToMirror =
            store.variationToggles?.enableFToMirror !== false &&
            useAppStore.getState().gameplay?.enableFToMirror !== false;
          if (enableFToMirror) {
            evt.preventDefault();
            store.setShotMirrored?.(!store.isShotMirrored);
            this.host.reloadCurrentShot();
          }
          return;
        }
        return;
      }

      if (store.sessionMode === 'play') {
        if ((code === 'KeyR' || evt.key === 'r' || evt.key === 'R') && !evt.repeat) {
          evt.preventDefault();
          this.host.reloadCurrentShot();
          return;
        }
        if ((code === 'KeyF' || evt.key === 'f' || evt.key === 'F') && !evt.repeat) {
          const enableFToMirror =
            store.variationToggles?.enableFToMirror !== false &&
            useAppStore.getState().gameplay?.enableFToMirror !== false;
          if (enableFToMirror) {
            evt.preventDefault();
            store.setShotMirrored?.(!store.isShotMirrored);
            this.host.reloadCurrentShot();
          }
          return;
        }
        if ((code === 'BracketLeft' || evt.key === '[' || code === 'Digit9') && !evt.repeat) {
          evt.preventDefault();
          store.prevShot();
          return;
        }
        if ((code === 'BracketRight' || evt.key === ']' || code === 'Digit0') && !evt.repeat) {
          evt.preventDefault();
          store.nextShot();
          return;
        }
        return;
      }

      if (store.sessionMode === 'edit') {
        const appState = useAppStore.getState();
        const isModalBlocking =
          hasActiveModalDialogue() ||
          (appState.isOpen && !appState.isLivePreviewCollapsed);
        if (isModalBlocking) return;

        if (code === 'Digit9' && !evt.repeat) {
          evt.preventDefault();
          store.cycleEditSubMode(-1);
          return;
        }
        if (code === 'Digit0' && !evt.repeat) {
          evt.preventDefault();
          store.cycleEditSubMode(1);
          return;
        }

        if (code === 'ArrowUp' || code === 'ArrowDown') {
          evt.preventDefault();
          if (!store.isEditingItem) {
            store.enterItemEditMode(store.currentShotIndex);
          }
          const delta = code === 'ArrowUp' ? 1 : -1;
          mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
            const cur = Math.round(Number(draft.timeoutSeconds) || 10);
            draft.timeoutSeconds = Math.max(1, Math.min(60, cur + delta));
          });
          return;
        }

        const subMode = store.editSubMode as StaticTrainingEditSubMode;

        if ((code === 'KeyT' || evt.key === 't' || evt.key === 'T') && !evt.repeat) {
          evt.preventDefault();
          this.host.toggleFreeCamTrajectoryTest();
          return;
        }
        if ((code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && !evt.repeat) {
          evt.preventDefault();
          this.host.toggleSingleShotTest();
          return;
        }
        if (
          (code === 'KeyF' || evt.key === 'f' || evt.key === 'F') &&
          !evt.shiftKey &&
          !evt.repeat
        ) {
          evt.preventDefault();
          useStaticTrainingBallCamTunerStore.getState().switchLateralSide();
          return;
        }

        if (subMode === 'free-cam') {
          return;
        }

        if (!store.isEditingItem) {
          store.enterItemEditMode(store.currentShotIndex);
        }

        if (
          code === 'Space' ||
          code === 'KeyV' ||
          code === 'KeyW' ||
          code === 'KeyA' ||
          code === 'KeyS' ||
          code === 'KeyD' ||
          code === 'KeyQ' ||
          code === 'KeyE' ||
          code === 'KeyO' ||
          code === 'KeyP' ||
          code === 'BracketLeft' ||
          code === 'BracketRight' ||
          code === 'Backslash'
        ) {
          evt.preventDefault();
        }

        this.heldKeys.add(code);

        if (code === 'Backslash' && !evt.repeat) {
          mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
            if (subMode === 'car-heading' || subMode === 'car-speed') {
              draft.car.speed = 0;
            } else if (subMode === 'ball-speed') {
              draft.ball.speed = 0;
              draft.ball.kickoffState = false;
            }
          });
        }

        if (code === 'KeyV' && !evt.repeat && (subMode === 'car-heading' || subMode === 'car-speed')) {
          const item = getActiveEditItemVariable();
          if (item && item.car.location[2] <= CAR_GROUND_MIN_Z + 1.5 && !item.car.snapToGround) {
            mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
              draft.car.location![2] = CAR_GROUND_MIN_Z;
              draft.car.snapToGround = true;
              draft.car.headingPitch = 0;
              draft.car.airRoll = 0;
              if (draft.car.speedFollowsHeading !== false) {
                draft.car.speedPitch = 0;
              }
            });
          }
        }

        if (code === 'KeyP' && !evt.repeat && (subMode === 'car-heading' || subMode === 'car-speed')) {
          const item = getActiveEditItemVariable();
          if (item && item.car.initialBoost >= 100 && !item.car.unlimitedBoost) {
            mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
              draft.car.initialBoost = 100;
              draft.car.unlimitedBoost = true;
            });
            this.heldKeys.delete('KeyP');
          }
        }

        if (code === 'KeyO' && !evt.repeat && (subMode === 'car-heading' || subMode === 'car-speed')) {
          const item = getActiveEditItemVariable();
          if (item && item.car.unlimitedBoost) {
            mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
              draft.car.unlimitedBoost = false;
              draft.car.initialBoost = 100;
            });
          }
        }

        if (code === 'BracketLeft' && !evt.repeat && subMode === 'ball-speed') {
          this.ballSpeedZeroLatch = false;
          const item = getActiveEditItemVariable();
          if (item && item.ball.speed === 0 && !item.ball.kickoffState) {
            mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
              draft.ball.kickoffState = true;
            });
            this.ballSpeedZeroLatch = true;
          }
        }

        if (code === 'BracketRight' && !evt.repeat && subMode === 'ball-speed') {
          const item = getActiveEditItemVariable();
          if (item && item.ball.kickoffState) {
            mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
              draft.ball.kickoffState = false;
              draft.ball.speed = 0;
            });
            this.heldKeys.delete('BracketRight');
          }
        }
      }
    };

    this.keyUpHandler = (evt: KeyboardEvent) => {
      this.heldKeys.delete(evt.code);
      if (evt.code === 'BracketLeft') {
        this.ballSpeedZeroLatch = false;
      }
    };

    this.mouseDownHandler = (evt: MouseEvent) => {
      const r = this.host.getRuntime();
      if (r?.match?.state?.mode !== 'static-training-pack') return;
      const store = useStaticTrainingPackStore.getState();
      if (store.sessionMode !== 'edit' || this.host.isTestingSingleShot()) return;

      const appState = useAppStore.getState();
      const isModalBlocking =
        hasActiveModalDialogue() ||
        (appState.isOpen && !appState.isLivePreviewCollapsed);
      if (isModalBlocking) return;

      const targetEl = evt.target as HTMLElement | null;
      if (
        targetEl &&
        typeof targetEl.closest === 'function' &&
        targetEl.closest(
          '[data-panel="container"], [data-ui-element="edge-inspector-drawer"], [data-ui-element="floating-window"], [data-ui-interactive="true"], [role="dialog"], button, input, select, textarea, [style*="pointer-events: auto"]'
        )
      ) {
        return;
      }

      if (evt.button === 2) {
        evt.preventDefault();
        store.cycleEditSubMode(1);
        return;
      }

      if (evt.button === 0 && store.editSubMode !== 'free-cam') {
        if (!store.isEditingItem) {
          store.enterItemEditMode(store.currentShotIndex);
        }
        this.isLeftMouseDragging = true;
        this.lastMouseX = evt.clientX;
        this.lastMouseY = evt.clientY;
      }
    };

    this.mouseMoveHandler = (evt: MouseEvent) => {
      if (!this.isLeftMouseDragging) return;
      const store = useStaticTrainingPackStore.getState();
      if (
        store.sessionMode !== 'edit' ||
        store.editSubMode === 'free-cam' ||
        this.host.isTestingSingleShot()
      ) {
        this.isLeftMouseDragging = false;
        return;
      }

      const dx = evt.clientX - this.lastMouseX;
      const dy = evt.clientY - this.lastMouseY;
      this.lastMouseX = evt.clientX;
      this.lastMouseY = evt.clientY;

      if (dx === 0 && dy === 0) return;
      const subMode = store.editSubMode as StaticTrainingEditSubMode;

      mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
        applyMouseDragToShotDraft(draft, subMode, dx, dy, 0.0045);
      });
    };

    this.mouseUpHandler = (evt: MouseEvent) => {
      if (evt.button === 0) {
        this.isLeftMouseDragging = false;
      }
    };

    this.contextMenuHandler = (evt: MouseEvent) => {
      const r = this.host.getRuntime();
      if (r?.match?.state?.mode === 'static-training-pack') {
        const store = useStaticTrainingPackStore.getState();
        if (store.sessionMode === 'edit' && !this.host.isTestingSingleShot()) {
          evt.preventDefault();
        }
      }
    };

    window.addEventListener('keydown', this.keyDownHandler, true);
    window.addEventListener('keyup', this.keyUpHandler, true);
    window.addEventListener('mousedown', this.mouseDownHandler);
    window.addEventListener('mousemove', this.mouseMoveHandler);
    window.addEventListener('mouseup', this.mouseUpHandler);
    window.addEventListener('contextmenu', this.contextMenuHandler);
  }

  unbindSessionEvents(): void {
    if (typeof window === 'undefined') return;
    if (this.keyDownHandler) {
      window.removeEventListener('keydown', this.keyDownHandler, true);
      this.keyDownHandler = null;
    }
    if (this.keyUpHandler) {
      window.removeEventListener('keyup', this.keyUpHandler, true);
      this.keyUpHandler = null;
    }
    if (this.mouseDownHandler) {
      window.removeEventListener('mousedown', this.mouseDownHandler);
      this.mouseDownHandler = null;
    }
    if (this.mouseMoveHandler) {
      window.removeEventListener('mousemove', this.mouseMoveHandler);
      this.mouseMoveHandler = null;
    }
    if (this.mouseUpHandler) {
      window.removeEventListener('mouseup', this.mouseUpHandler);
      this.mouseUpHandler = null;
    }
    if (this.contextMenuHandler) {
      window.removeEventListener('contextmenu', this.contextMenuHandler);
      this.contextMenuHandler = null;
    }
  }
}
