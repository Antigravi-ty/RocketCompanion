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
  EDITOR_HELD_KEY_CODES,
  type BallCamTunerParams,
  type ShotBallConfig,
  type ShotCarConfig,
  type StaticTrainingEditSubMode,
  type StaticTrainingShotConfig,
  computeEditorContinuousDeltas,
  computeContinuousDeltasShotPatch,
  computeDiscreteEditKeyMutation,
  computeMouseDragShotPatch,
} from './ShotGizmoMath.ts';
import {
  computeThreeJsFreeCamPoseFromShot,
  extractShotEditorFreeCamFromSnapshot,
} from './staticTrainingVariationMath.ts';

export interface StaticTrainingEditorCameraPort {
  isFreeCam?: boolean;
  camera?: THREE.Camera | null;
  setEditorOverride?: (enabled: boolean) => void;
  setFreeCam: (enabled: boolean) => void;
  setFreeCamPose?: (
    position: [number, number, number] | number[],
    lookAt: [number, number, number] | number[]
  ) => void;
  getFreeCamStateSnapshot?: () => {
    eyeUnreal: [number, number, number];
    yawUnrealDeg: number;
    pitchUnrealDeg: number;
  } | null;
  syncEditorShotCamera?: (
    subMode: StaticTrainingEditSubMode,
    shot: StaticTrainingShotConfig,
    tuner: BallCamTunerParams
  ) => void;
}

export interface StaticTrainingEditorRuntimePort {
  camera?: StaticTrainingEditorCameraPort | null;
  match?: { state?: { mode?: string } | null } | null;
  releaseGoalReplayCameraOverride: () => void;
}

export interface StaticTrainingEditorReplayControllerPort {
  togglePause: () => boolean;
  sessionState: { isPersistent: boolean };
}

export interface StaticTrainingShotEditorHostCallbacks {
  getRuntime: () => StaticTrainingEditorRuntimePort | null;
  isReplayActive: () => boolean;
  getReplayController: () => StaticTrainingEditorReplayControllerPort;
  isTestingSingleShot: () => boolean;
  isFreeCamTrajectoryTesting: () => boolean;
  getCurrentShotConfig: () => StaticTrainingShotConfig | null;
  reloadCurrentShot: () => void;
  toggleSingleShotTest: () => void;
  toggleFreeCamTrajectoryTest: () => void;
  stopFreeCamTrajectoryTest: () => void;
}

function isModalBlockingInput(): boolean {
  const hasDialog =
    typeof document !== 'undefined' && document.querySelector('[role="dialog"]') !== null;
  const appState = useAppStore.getState();
  return Boolean(hasDialog || (appState.isOpen && !appState.isLivePreviewCollapsed));
}

function isReplayDirectorTunerWindowPresent(): boolean {
  const windows = floatingStore.getSnapshot()?.windows || [];
  return windows.some((w: { id?: string }) => w.id === 'replay-director-tuner');
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

  private applyShotPatch(
    draft: StaticTrainingShotConfig,
    patch: { carPatch?: Partial<ShotCarConfig>; ballPatch?: Partial<ShotBallConfig> }
  ): void {
    if (patch.carPatch) draft.car = { ...draft.car, ...patch.carPatch };
    if (patch.ballPatch) draft.ball = { ...draft.ball, ...patch.ballPatch };
  }

  resetInputState(): void {
    this.heldKeys.clear();
    this.isLeftMouseDragging = false;
    this.ballSpeedZeroLatch = false;
  }

  applyEditSubModeCamera(subMode: StaticTrainingEditSubMode): void {
    const r = this.host.getRuntime();
    if (!r?.camera) return;

    if (subMode !== 'free-cam' && this.host.isFreeCamTrajectoryTesting()) {
      this.host.stopFreeCamTrajectoryTest();
    }

    if (this.host.isTestingSingleShot()) {
      r.camera.setEditorOverride?.(false);
      r.releaseGoalReplayCameraOverride();
      if (r.camera.isFreeCam) r.camera.setFreeCam(false);
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
      return;
    }

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
      r.camera.syncEditorShotCamera?.(subMode, shot, useStaticTrainingBallCamTunerStore.getState());
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
      r.camera.syncEditorShotCamera?.(subMode, shot, useStaticTrainingBallCamTunerStore.getState());
    }

    if (isModalBlockingInput()) {
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
      const res = computeContinuousDeltasShotPatch(draft, subMode, deltas, this.ballSpeedZeroLatch);
      this.applyShotPatch(draft, res);
      this.ballSpeedZeroLatch = res.nextBallSpeedZeroLatch;
    });
  }

  private tryMirrorOrReloadHotkey(evt: KeyboardEvent, store: any): boolean {
    const code = evt.code;
    if ((code === 'KeyR' || evt.key === 'r' || evt.key === 'R') && !evt.repeat) {
      evt.preventDefault();
      this.host.reloadCurrentShot();
      return true;
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
      return true;
    }
    return false;
  }

  private handleKeyDown(evt: KeyboardEvent): void {
    const r = this.host.getRuntime();
    if (r?.match?.state?.mode !== 'static-training-pack' || isEditableEventTarget(evt)) return;

    const store = useStaticTrainingPackStore.getState();
    const code = evt.code;

    if (this.host.isReplayActive() && (code === 'KeyP' || evt.key === 'p' || evt.key === 'P')) {
      if (isReplayDirectorTunerWindowPresent() && !evt.repeat) {
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
      this.tryMirrorOrReloadHotkey(evt, store);
      return;
    }

    if (store.sessionMode === 'play') {
      if (this.tryMirrorOrReloadHotkey(evt, store)) return;
      if ((code === 'BracketLeft' || evt.key === '[' || code === 'Digit9') && !evt.repeat) {
        evt.preventDefault();
        store.prevShot();
      } else if ((code === 'BracketRight' || evt.key === ']' || code === 'Digit0') && !evt.repeat) {
        evt.preventDefault();
        store.nextShot();
      }
      return;
    }

    if (store.sessionMode !== 'edit' || isModalBlockingInput()) return;

    if ((code === 'Digit9' || code === 'Digit0') && !evt.repeat) {
      evt.preventDefault();
      store.cycleEditSubMode(code === 'Digit9' ? -1 : 1);
      return;
    }

    if (code === 'ArrowUp' || code === 'ArrowDown') {
      evt.preventDefault();
      if (!store.isEditingItem) store.enterItemEditMode(store.currentShotIndex);
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
    if ((code === 'KeyF' || evt.key === 'f' || evt.key === 'F') && !evt.shiftKey && !evt.repeat) {
      evt.preventDefault();
      useStaticTrainingBallCamTunerStore.getState().switchLateralSide();
      return;
    }
    if (subMode === 'free-cam') return;

    if (!store.isEditingItem) store.enterItemEditMode(store.currentShotIndex);
    if (EDITOR_HELD_KEY_CODES.has(code)) evt.preventDefault();
    this.heldKeys.add(code);

    if (!evt.repeat) {
      if (code === 'BracketLeft' && subMode === 'ball-speed') {
        this.ballSpeedZeroLatch = false;
      }
      const discrete = computeDiscreteEditKeyMutation(code, subMode, getActiveEditItemVariable());
      if (discrete) {
        mutateActiveEditItemVariable((draft: StaticTrainingShotConfig) => {
          this.applyShotPatch(draft, discrete);
        });
        if (discrete.removeHeldKey) this.heldKeys.delete(discrete.removeHeldKey);
        if (discrete.setBallSpeedZeroLatch !== undefined) {
          this.ballSpeedZeroLatch = discrete.setBallSpeedZeroLatch;
        }
      }
    }
  }

  bindSessionEvents(): void {
    if (typeof window === 'undefined') return;
    this.unbindSessionEvents();

    this.keyDownHandler = (evt: KeyboardEvent) => this.handleKeyDown(evt);
    this.keyUpHandler = (evt: KeyboardEvent) => {
      this.heldKeys.delete(evt.code);
      if (evt.code === 'BracketLeft') this.ballSpeedZeroLatch = false;
    };

    this.mouseDownHandler = (evt: MouseEvent) => {
      const r = this.host.getRuntime();
      if (r?.match?.state?.mode !== 'static-training-pack') return;
      const store = useStaticTrainingPackStore.getState();
      if (
        store.sessionMode !== 'edit' ||
        this.host.isTestingSingleShot() ||
        isModalBlockingInput()
      ) {
        return;
      }

      const targetEl = evt.target as HTMLElement | null;
      if (
        targetEl?.closest?.(
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
        if (!store.isEditingItem) store.enterItemEditMode(store.currentShotIndex);
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
        this.applyShotPatch(draft, computeMouseDragShotPatch(draft, subMode, dx, dy, 0.0045));
      });
    };

    this.mouseUpHandler = (evt: MouseEvent) => {
      if (evt.button === 0) this.isLeftMouseDragging = false;
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
    if (this.keyDownHandler) window.removeEventListener('keydown', this.keyDownHandler, true);
    if (this.keyUpHandler) window.removeEventListener('keyup', this.keyUpHandler, true);
    if (this.mouseDownHandler) window.removeEventListener('mousedown', this.mouseDownHandler);
    if (this.mouseMoveHandler) window.removeEventListener('mousemove', this.mouseMoveHandler);
    if (this.mouseUpHandler) window.removeEventListener('mouseup', this.mouseUpHandler);
    if (this.contextMenuHandler) window.removeEventListener('contextmenu', this.contextMenuHandler);
    this.keyDownHandler = null;
    this.keyUpHandler = null;
    this.mouseDownHandler = null;
    this.mouseMoveHandler = null;
    this.mouseUpHandler = null;
    this.contextMenuHandler = null;
  }
}
