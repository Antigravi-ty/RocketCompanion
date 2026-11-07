/**
 * CameraManager.ts
 * Context-free camera controller dispatcher and mode arbitrator.
 */

import * as THREE from 'three';
import { PovCameraController, type PovCameraKernelLike } from './exempt_pov_microkernel/PovCameraController.ts';
import { RearViewCamera } from './RearViewCamera.ts';
import { FreeCameraController, type Vector3TupleOrObject } from './FreeCameraController.ts';
import {
  DirectorCameraController, PodiumCameraController, EditorCameraController,
  type BallCamTunerSettings, type SceneCameraInputState, type StaticTrainingShotEditorConfig,
} from './SceneOverrideCameraControllers.ts';
import {
  CAMERA_MODES, DEFAULT_PODIUM_CAMERA_FOV_DEG, DEFAULT_EDITOR_CAMERA_FOV_DEG,
  isPovFamilyMode, isCarAttachedCameraMode, clampHorizontalFovDeg, convertHorizontalToVerticalFov,
  resolveModeHorizontalFov, applyCanonicalUpAndHorizontalFov, arbitrateFrameCameraMode,
  resolveSnapshotHorizontalFov, buildCameraPoseStateSnapshot,
  type CameraMode, type CameraFovSources, type FreeCamStateSnapshot,
} from './cameraFovAndPosePipeline.ts';
import { getCameraDeterminismHarness } from './CameraDeterminismHarness.ts';
import {
  CAMERA_SOURCE_MODES,
  DEFAULT_CAMERA_SETTINGS,
  type CameraSettingsConfig,
} from '../ui-core/config/cameraDefaults';
import { DEFAULT_REPLAY_DIRECTOR_FOV_DEG } from '../ui-core/config/replayDirectorConfig';

export type { CameraMode, FreeCamStateSnapshot };

export interface CameraControllerContract {
  onActivate?: () => void;
  onDeactivate?: () => void;
  resetView?: () => void;
  resize?: (width: number, height: number) => void;
  handleAction?: (actionId: string, eventData?: unknown) => boolean;
  update?: (
    carObject?: unknown, ballObject?: unknown, dt?: number,
    extraInfo?: unknown, inputState?: SceneCameraInputState | null
  ) => void;
  dispose?: () => void;
  fov?: number;
  ballCam?: boolean;
  toggleBallCam?: () => boolean;
  setPoseThreeJs?: (eyeX: number, eyeY: number, eyeZ: number, targetX: number, targetY: number, targetZ: number) => void;
  syncShotPose?: (
    subMode: string, shot: StaticTrainingShotEditorConfig | null | undefined, ballCamTuner?: BallCamTunerSettings | null
  ) => void;
  resetToDefaultOverview?: () => void;
  setPoseLookAt?: (position: Vector3TupleOrObject, lookAtTarget?: Vector3TupleOrObject) => void;
  syncOrientationVectors?: () => void;
  camPosition?: THREE.Vector3;
  forward?: THREE.Vector3;
  right?: THREE.Vector3;
  yaw?: number;
  pitch?: number;
  onFovChange?: ((newFov: number) => void) | null;
  shouldSuppressRightClickDrag?: (() => boolean) | null;
}

export interface CameraManagerOptions {
  settings?: CameraSettingsConfig;
  [key: string]: unknown;
}

export interface CameraStateSnapshot {
  mode: CameraMode; isPovMode: boolean; isFreeCam: boolean;
  isDirectorOverrideActive: boolean; isEditorOverrideActive: boolean;
  ballCam: boolean; focusedCarIndex: number;
}

export class CameraManager {
  private _sharedCamera: THREE.PerspectiveCamera | null;
  public activeMode: CameraMode = CAMERA_MODES.POV;
  public readonly controllers: Map<CameraMode, CameraControllerContract>;
  public focusedCarIndex = 0;
  public isDirectorOverrideActive = false;
  public isEditorOverrideActive = false;
  public isFreeCam = false;
  public settings: CameraSettingsConfig | null;

  constructor(
    aspect: number = typeof window !== 'undefined' ? window.innerWidth / window.innerHeight : 16 / 9,
    kernel: PovCameraKernelLike | null = null,
    options: CameraManagerOptions = {}
  ) {
    this.settings = options?.settings || { ...DEFAULT_CAMERA_SETTINGS };
    const initialVFov = convertHorizontalToVerticalFov(this.settings.fov ?? 110, aspect);
    const cam = new THREE.PerspectiveCamera(initialVFov, aspect, 4, 40000);
    this._sharedCamera = cam;
    this.controllers = new Map<CameraMode, CameraControllerContract>();

    const povCtrl = new PovCameraController(aspect, kernel, cam, CAMERA_SOURCE_MODES.CLEAN_JS);
    povCtrl.settings = this.settings;
    this.controllers.set(CAMERA_MODES.POV, povCtrl);

    const wasmPovCtrl = new PovCameraController(aspect, kernel, cam, CAMERA_SOURCE_MODES.WASM);
    wasmPovCtrl.settings = this.settings;
    this.controllers.set(CAMERA_MODES.WASM_POV, wasmPovCtrl);

    this.controllers.set(CAMERA_MODES.REAR_VIEW, new RearViewCamera(aspect, this.settings, cam));
    this.controllers.set(CAMERA_MODES.FREE, new FreeCameraController(aspect, this.settings, cam));
    this.controllers.set(CAMERA_MODES.DIRECTOR, new DirectorCameraController(cam, DEFAULT_REPLAY_DIRECTOR_FOV_DEG));
    this.controllers.set(CAMERA_MODES.PODIUM, new PodiumCameraController(cam, this, DEFAULT_PODIUM_CAMERA_FOV_DEG));
    this.controllers.set(CAMERA_MODES.EDITOR, new EditorCameraController(cam, DEFAULT_EDITOR_CAMERA_FOV_DEG));
  }

  private getFovSources(): CameraFovSources {
    return {
      activeMode: this.activeMode,
      isFreeCam: this.isFreeCam,
      isDirectorOverrideActive: this.isDirectorOverrideActive,
      isEditorOverrideActive: this.isEditorOverrideActive,
      freeCamFov: this.getFreeCamFov(),
      directorFov: this.getDirectorFov(),
      editorFov: this.getEditorFov(),
      podiumFov: this.getPodiumFov(),
      settings: this.settings,
    };
  }

  resetSharedCameraUpAndFov(): void {
    applyCanonicalUpAndHorizontalFov(this._sharedCamera, resolveModeHorizontalFov(this.getFovSources()));
  }

  applyPovSettings(cameraConfig: Partial<CameraSettingsConfig> | null | undefined): void {
    if (!cameraConfig) return;
    if (!this.settings) this.settings = { ...DEFAULT_CAMERA_SETTINGS };
    Object.assign(this.settings, cameraConfig);
    if (this._sharedCamera && this.isPovMode) {
      const hFov = Number(this.settings.fov) || 110;
      const targetVFov = convertHorizontalToVerticalFov(hFov, this._sharedCamera.aspect || 16 / 9);
      if (Math.abs(this._sharedCamera.fov - targetVFov) > 0.001) {
        this._sharedCamera.fov = targetVFov;
      }
      this._sharedCamera.updateProjectionMatrix();
    }
  }

  updateProjectionMatrix(): void {
    this._sharedCamera?.updateProjectionMatrix();
  }

  setDirectorOverride(active: boolean): void {
    const next = Boolean(active);
    if (this.isDirectorOverrideActive === next) return;
    this.isDirectorOverrideActive = next;
    this.resetSharedCameraUpAndFov();
    if (next && !this.isFreeCam) {
      this.setActiveMode(CAMERA_MODES.DIRECTOR);
    } else if (!next && this.activeMode === CAMERA_MODES.DIRECTOR) {
      this.setActiveMode(this.isFreeCam ? CAMERA_MODES.FREE : this.getPreferredPovMode());
    }
  }

  setDirectorCameraPoseThreeJs(
    eyeX: number, eyeY: number, eyeZ: number, targetX: number, targetY: number, targetZ: number
  ): void {
    this.controllers.get(CAMERA_MODES.DIRECTOR)?.setPoseThreeJs?.(eyeX, eyeY, eyeZ, targetX, targetY, targetZ);
  }

  setDirectorFov(fov: number): void {
    const directorCtrl = this.controllers.get(CAMERA_MODES.DIRECTOR);
    if (directorCtrl && 'fov' in directorCtrl) directorCtrl.fov = fov;
  }

  getDirectorFov(): number {
    return Number(this.controllers.get(CAMERA_MODES.DIRECTOR)?.fov) || DEFAULT_REPLAY_DIRECTOR_FOV_DEG;
  }

  getPodiumFov(): number {
    return Number(this.controllers.get(CAMERA_MODES.PODIUM)?.fov) || DEFAULT_PODIUM_CAMERA_FOV_DEG;
  }

  getEditorFov(): number {
    return Number(this.controllers.get(CAMERA_MODES.EDITOR)?.fov) || DEFAULT_EDITOR_CAMERA_FOV_DEG;
  }

  setEditorOverride(active: boolean): void {
    const next = Boolean(active);
    if (this.isEditorOverrideActive === next) return;
    this.isEditorOverrideActive = next;
    this.resetSharedCameraUpAndFov();
    if (next && !this.isFreeCam) {
      this.setActiveMode(CAMERA_MODES.EDITOR);
    } else if (!next && this.activeMode === CAMERA_MODES.EDITOR) {
      this.setActiveMode(this.isFreeCam ? CAMERA_MODES.FREE : this.getPreferredPovMode());
    }
  }

  syncEditorShotCamera(
    subMode: string,
    shot: StaticTrainingShotEditorConfig | null | undefined,
    ballCamTuner: BallCamTunerSettings | null = null
  ): void {
    this.controllers.get(CAMERA_MODES.EDITOR)?.syncShotPose?.(subMode, shot, ballCamTuner);
  }

  get camera(): THREE.PerspectiveCamera | null {
    return this._sharedCamera;
  }

  get currentMode(): CameraMode {
    return this.activeMode;
  }

  get isPovMode(): boolean {
    return isCarAttachedCameraMode({
      activeMode: this.activeMode,
      isFreeCam: this.isFreeCam,
      isDirectorOverrideActive: this.isDirectorOverrideActive,
      isEditorOverrideActive: this.isEditorOverrideActive,
    });
  }

  setFocusedCarIndex(carIndex: number): void {
    const parsedIndex = Number(carIndex);
    if (Number.isFinite(parsedIndex) && parsedIndex >= 0) {
      this.focusedCarIndex = Math.round(parsedIndex);
    }
  }

  getFocusedCarIndex(): number {
    return this.focusedCarIndex;
  }

  getCameraState(): CameraStateSnapshot {
    return {
      mode: this.activeMode,
      isPovMode: this.isPovMode,
      isFreeCam: this.isFreeCam,
      isDirectorOverrideActive: this.isDirectorOverrideActive,
      isEditorOverrideActive: this.isEditorOverrideActive,
      ballCam: this.ballCam,
      focusedCarIndex: this.focusedCarIndex,
    };
  }

  get activeController(): CameraControllerContract | undefined {
    return this.controllers.get(this.activeMode);
  }

  getPreferredPovMode(): CameraMode {
    return getCameraDeterminismHarness().activeSource === CAMERA_SOURCE_MODES.WASM
      ? CAMERA_MODES.WASM_POV
      : CAMERA_MODES.POV;
  }

  setActiveMode(newMode: CameraMode): void {
    if (this.activeMode === newMode) return;
    if (!this.controllers.has(newMode)) {
      console.warn(`[CameraManager] Unknown camera mode: ${newMode}`);
      return;
    }

    const prevMode = this.activeMode;
    this.controllers.get(prevMode)?.onDeactivate?.();
    this.activeMode = newMode;
    this.resetSharedCameraUpAndFov();

    const harness = getCameraDeterminismHarness();
    if (newMode === CAMERA_MODES.POV && harness.activeSource !== CAMERA_SOURCE_MODES.CLEAN_JS) {
      harness.setActiveSource(CAMERA_SOURCE_MODES.CLEAN_JS);
    } else if (newMode === CAMERA_MODES.WASM_POV && harness.activeSource !== CAMERA_SOURCE_MODES.WASM) {
      harness.setActiveSource(CAMERA_SOURCE_MODES.WASM);
    }

    const activated = this.controllers.get(newMode);
    if (activated && typeof activated.onActivate === 'function') {
      activated.onActivate();
    } else if (isPovFamilyMode(prevMode) && isPovFamilyMode(newMode)) {
      return;
    } else if (activated && typeof activated.resetView === 'function') {
      activated.resetView();
    }
  }

  get freeCam(): boolean {
    return this.isFreeCam;
  }

  setFreeCam(enabled: boolean): void {
    const shouldEnable = Boolean(enabled);
    if (this.isFreeCam === shouldEnable) return;
    this.isFreeCam = shouldEnable;
    if (this.isFreeCam) {
      this.setActiveMode(CAMERA_MODES.FREE);
    } else if (this.isDirectorOverrideActive) {
      this.setActiveMode(CAMERA_MODES.DIRECTOR);
    } else {
      this.setActiveMode(this.getPreferredPovMode());
    }
  }

  toggleFreeCam(): boolean {
    this.setFreeCam(!this.isFreeCam);
    return this.isFreeCam;
  }

  setFreeCamFov(fov: number): void {
    const safeHFov = clampHorizontalFovDeg(fov, DEFAULT_REPLAY_DIRECTOR_FOV_DEG);
    const free = this.controllers.get(CAMERA_MODES.FREE);
    if (free) free.fov = safeHFov;
    const director = this.controllers.get(CAMERA_MODES.DIRECTOR);
    if (director) director.fov = safeHFov;
    if (
      this._sharedCamera &&
      (this.activeMode === CAMERA_MODES.FREE ||
        this.activeMode === CAMERA_MODES.DIRECTOR ||
        this.isFreeCam ||
        this.isDirectorOverrideActive)
    ) {
      applyCanonicalUpAndHorizontalFov(this._sharedCamera, safeHFov);
    }
  }

  getFreeCamFov(): number {
    const free = this.controllers.get(CAMERA_MODES.FREE);
    return free && typeof free.fov === 'number' ? free.fov : DEFAULT_REPLAY_DIRECTOR_FOV_DEG;
  }

  resetFreeCamOverview(): void {
    this.controllers.get(CAMERA_MODES.FREE)?.resetToDefaultOverview?.();
  }

  setFreeCamPose(position: Vector3TupleOrObject, lookAtTarget: Vector3TupleOrObject = [0, 80, 0]): void {
    this.setFreeCam(true);
    this.controllers.get(CAMERA_MODES.FREE)?.setPoseLookAt?.(position, lookAtTarget);
  }

  getFreeCamStateSnapshot(): FreeCamStateSnapshot | null {
    const free = this.controllers.get(CAMERA_MODES.FREE);
    const activeHFov = resolveSnapshotHorizontalFov(this._sharedCamera, this.getFovSources());
    return buildCameraPoseStateSnapshot(this._sharedCamera, free, this.isFreeCam, activeHFov);
  }

  handleAction(actionId: string, eventData: unknown = null): boolean {
    if (actionId === 'ballCam') return this.toggleBallCam();
    return this.activeController?.handleAction?.(actionId, eventData) ?? false;
  }

  get ballCam(): boolean {
    return this.controllers.get(CAMERA_MODES.POV)?.ballCam ?? false;
  }

  set ballCam(value: boolean) {
    const nextVal = Boolean(value);
    const pov = this.controllers.get(CAMERA_MODES.POV);
    const obfPov = this.controllers.get(CAMERA_MODES.WASM_POV);
    if (pov) pov.ballCam = nextVal;
    if (obfPov) obfPov.ballCam = nextVal;
  }

  toggleBallCam(): boolean {
    const pov = this.controllers.get(CAMERA_MODES.POV);
    const obfPov = this.controllers.get(CAMERA_MODES.WASM_POV);
    const nextVal = pov && typeof pov.toggleBallCam === 'function' ? pov.toggleBallCam() : false;
    if (obfPov) obfPov.ballCam = nextVal;
    return nextVal;
  }

  resetView(): void {
    const pov = this.controllers.get(CAMERA_MODES.POV);
    const obfPov = this.controllers.get(CAMERA_MODES.WASM_POV);
    pov?.resetView?.();
    obfPov?.resetView?.();
    const current = this.activeController;
    if (current && current !== pov && current !== obfPov) {
      current.resetView?.();
    }
  }

  resize(width: number, height: number): void {
    for (const controller of this.controllers.values()) {
      controller.resize?.(width, height);
    }
    if (this._sharedCamera && height > 0) {
      this._sharedCamera.aspect = width / height;
      this._sharedCamera.updateProjectionMatrix();
    }
  }

  update(
    carObject: unknown,
    ballObject: unknown,
    dt = 0,
    extraInfo: unknown = null,
    inputState: { podiumController?: { isActive?: boolean }; isRearViewHeld?: boolean } | null = null
  ): void {
    const desiredMode = arbitrateFrameCameraMode({
      isFreeCam: this.isFreeCam,
      isPodiumActive: Boolean(inputState?.podiumController?.isActive),
      isEditorOverrideActive: this.isEditorOverrideActive,
      isDirectorOverrideActive: this.isDirectorOverrideActive,
      isRearViewHeld: Boolean(inputState?.isRearViewHeld),
      preferredPovMode: this.getPreferredPovMode(),
    });
    this.setActiveMode(desiredMode);

    if (
      (isPovFamilyMode(this.activeMode) || this.activeMode === CAMERA_MODES.REAR_VIEW) &&
      (!carObject || !ballObject)
    ) {
      return;
    }

    this.activeController?.update?.(carObject, ballObject, dt, extraInfo, inputState);
  }

  dispose(): void {
    this.destroy();
  }

  destroy(): void {
    for (const controller of this.controllers.values()) {
      controller.dispose?.();
    }
    this.controllers.clear();
    this._sharedCamera = null;
    this.settings = null;
  }
}
