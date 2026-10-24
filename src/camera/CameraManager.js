/**
 * Implements strict architectural decoupling:
 * 1. Context-Free Isolation:
 *    Controllers are independent black boxes. No transform history is preserved or passed.
 *    Mode switching is strictly an instant hard cut with zero cross-controller blending.
 * 2. Exclusive Pipeline Takeover:
 *    Lazy evaluation ensures only the currently active controller computes frame updates.
 *    Exactly one controller outputs to the camera in any render frame.
 * 3. Event Delegation & Encapsulation:
 *    Manager delegates events (e.g. ballCam toggle) to the owning controller.
 *    Controller internal state machines handle transitions internally.
 * 4. Extensible Dispatching:
 *    Pre-configured for POV and Rear View, ready for Free/Orbit/Spectator modes.
 */

import * as THREE from 'three';
import { CameraController } from './exempt_pov_microkernel/index.js';
import { RearViewCamera } from './RearViewCamera.js';
import { FreeCameraController } from './FreeCameraController.js';
import { getCameraDeterminismHarness, CAMERA_SOURCE_MODES } from './CameraDeterminismHarness.js';
import { DEFAULT_CAMERA_SETTINGS } from '../config/cameraDefaults.js';

export const CAMERA_MODES = Object.freeze({
  POV: 'pov',
  OBFUSCATED_POV: 'obfuscatedPov',
  REAR_VIEW: 'rearView',
  FREE: 'free'
});

function isPovFamilyMode(mode) {
  return mode === CAMERA_MODES.POV || mode === CAMERA_MODES.OBFUSCATED_POV;
}

export class CameraManager {
  /**
   * @param {number} aspect - Camera aspect ratio (width / height)
   * @param {object|null} kernel - CameraMicrokernel or RocketSimPhysicsEngine
   * @param {object|null} [options]
   */
  constructor(
    aspect = (typeof window !== 'undefined' ? window.innerWidth / window.innerHeight : 16 / 9),
    kernel = null,
    options = {}
  ) {
    this.settings = options?.settings || { ...DEFAULT_CAMERA_SETTINGS };

    this._sharedCamera = new THREE.PerspectiveCamera(this.settings.fov, aspect, 4, 40000);

    // Registered camera controllers map (4 engines: POV, OBFUSCATED_POV, REAR_VIEW, FREE)
    this.controllers = new Map();

    // 1. POV Camera Controller (Default: Clean JS deobfuscated POV camera)
    const povController = new CameraController(
      aspect,
      kernel,
      this._sharedCamera,
      CAMERA_SOURCE_MODES.CLEAN_JS
    );
    povController.settings = this.settings;
    this.controllers.set(CAMERA_MODES.POV, povController);

    // 2. ObfuscatedPOV Camera Controller (Legacy WASM microkernel POV camera)
    const obfuscatedPovController = new CameraController(
      aspect,
      kernel,
      this._sharedCamera,
      CAMERA_SOURCE_MODES.WASM
    );
    obfuscatedPovController.settings = this.settings;
    this.controllers.set(CAMERA_MODES.OBFUSCATED_POV, obfuscatedPovController);

    // 3. Rear View Camera Controller (Pure JS detached rear view)
    const rearController = new RearViewCamera(aspect, this.settings, this._sharedCamera);
    this.controllers.set(CAMERA_MODES.REAR_VIEW, rearController);

    // 4. Free Camera Controller (Interactive developer spectator fly-cam)
    const freeController = new FreeCameraController(aspect, this.settings, this._sharedCamera);
    this.controllers.set(CAMERA_MODES.FREE, freeController);

    this.isFreeCam = false;

    // Initial active mode (Default: Clean POV)
    this.activeMode = CAMERA_MODES.POV;
  }

  /**
   * Get the primary Three.js camera instance used by the renderer and post-processing
   */
  get camera() {
    return this._sharedCamera;
  }

  /**
   * Get current active mode key ('pov' | 'obfuscatedPov' | 'rearView' | 'free')
   */
  get currentMode() {
    return this.activeMode;
  }

  /**
   * Get currently active camera controller instance
   */
  get activeController() {
    return this.controllers.get(this.activeMode);
  }

  /**
   * Resolve preferred POV mode ('pov' vs 'obfuscatedPov') from the determinism harness toggle
   */
  getPreferredPovMode() {
    const harness = getCameraDeterminismHarness();
    return harness.activeSource === CAMERA_SOURCE_MODES.WASM
      ? CAMERA_MODES.OBFUSCATED_POV
      : CAMERA_MODES.POV;
  }

  /**
   * Atomic Instant Hard Switch between camera modes.
   * Context-free: does not transfer transforms from previous controller.
   * @param {string} newMode
   */
  setActiveMode(newMode) {
    if (this.activeMode === newMode) return;
    if (!this.controllers.has(newMode)) {
      console.warn(`[CameraManager] Unknown camera mode: ${newMode}`);
      return;
    }

    const prevMode = this.activeMode;
    const prevController = this.controllers.get(prevMode);
    if (prevMode === CAMERA_MODES.FREE && prevController && typeof prevController.onDeactivate === 'function') {
      prevController.onDeactivate();
    }

    this.activeMode = newMode;

    // Keep harness activeSource synchronized if caller explicitly switched between POV and OBFUSCATED_POV
    const harness = getCameraDeterminismHarness();
    if (newMode === CAMERA_MODES.POV && harness.activeSource !== CAMERA_SOURCE_MODES.CLEAN_JS) {
      harness.setActiveSource(CAMERA_SOURCE_MODES.CLEAN_JS);
    } else if (newMode === CAMERA_MODES.OBFUSCATED_POV && harness.activeSource !== CAMERA_SOURCE_MODES.WASM) {
      harness.setActiveSource(CAMERA_SOURCE_MODES.WASM);
    }

    const activated = this.controllers.get(newMode);
    if (newMode === CAMERA_MODES.FREE && typeof activated.onActivate === 'function') {
      activated.onActivate();
    } else if (isPovFamilyMode(prevMode) && isPovFamilyMode(newMode)) {
      // Switching directly between POV and ObfuscatedPOV keeps continuous lockstep state without resetting smoothing
      return;
    } else if (typeof activated.resetView === 'function') {
      activated.resetView();
    }
  }

  /**
   * Free Camera status query
   */
  get freeCam() {
    return this.isFreeCam;
  }

  /**
   * Set Free Camera mode enabled / disabled
   * @param {boolean} enabled
   */
  setFreeCam(enabled) {
    const shouldEnable = Boolean(enabled);
    if (this.isFreeCam === shouldEnable) return;
    this.isFreeCam = shouldEnable;
    if (this.isFreeCam) {
      this.setActiveMode(CAMERA_MODES.FREE);
    } else {
      this.setActiveMode(this.getPreferredPovMode());
    }
  }

  /**
   * Toggle Free Camera state
   * @returns {boolean}
   */
  toggleFreeCam() {
    this.setFreeCam(!this.isFreeCam);
    return this.isFreeCam;
  }

  /**
   * Set Free Camera FOV
   * @param {number} fov
   */
  setFreeCamFov(fov) {
    const free = this.controllers.get(CAMERA_MODES.FREE);
    if (free) {
      free.fov = fov;
    }
  }

  /**
   * Get Free Camera FOV
   * @returns {number}
   */
  getFreeCamFov() {
    const free = this.controllers.get(CAMERA_MODES.FREE);
    return free ? free.fov : 80;
  }

  /**
   * Reset Free Camera coordinates to default overview position
   */
  resetFreeCamOverview() {
    const free = this.controllers.get(CAMERA_MODES.FREE);
    if (free && typeof free.resetToDefaultOverview === 'function') {
      free.resetToDefaultOverview();
    }
  }

  /**
   * Enable Free Camera and set its position + look-at target
   */
  setFreeCamPose(position, lookAtTarget = [0, 80, 0]) {
    this.setFreeCam(true);
    const free = this.controllers.get(CAMERA_MODES.FREE);
    if (free && typeof free.setPoseLookAt === 'function') {
      free.setPoseLookAt(position, lookAtTarget);
    }
  }

  /**
   * Event Delegation: Delegate input action to the appropriate controller.
   * @param {string} actionId
   * @param {any} [eventData]
   */
  handleAction(actionId, eventData = null) {
    if (actionId === 'ballCam') {
      return this.toggleBallCam();
    }
    const current = this.activeController;
    if (typeof current?.handleAction === 'function') {
      return current.handleAction(actionId, eventData);
    }
    return false;
  }

  /**
   * Ball Cam status query (delegated to POV controller)
   */
  get ballCam() {
    return this.controllers.get(CAMERA_MODES.POV)?.ballCam ?? false;
  }

  /**
   * Ball Cam status mutation (synchronized across both POV and ObfuscatedPOV controllers)
   */
  set ballCam(value) {
    const nextVal = Boolean(value);
    const pov = this.controllers.get(CAMERA_MODES.POV);
    const obfPov = this.controllers.get(CAMERA_MODES.OBFUSCATED_POV);
    if (pov) pov.ballCam = nextVal;
    if (obfPov) obfPov.ballCam = nextVal;
  }

  /**
   * Toggle Ball Cam state on both POV and ObfuscatedPOV controllers
   * @returns {boolean} New ballCam state
   */
  toggleBallCam() {
    const pov = this.controllers.get(CAMERA_MODES.POV);
    const obfPov = this.controllers.get(CAMERA_MODES.OBFUSCATED_POV);
    const nextVal = pov ? pov.toggleBallCam() : false;
    if (obfPov) obfPov.ballCam = nextVal;
    return nextVal;
  }

  /**
   * Reset view across POV, ObfuscatedPOV, and active controller
   */
  resetView() {
    const pov = this.controllers.get(CAMERA_MODES.POV);
    const obfPov = this.controllers.get(CAMERA_MODES.OBFUSCATED_POV);
    if (typeof pov?.resetView === 'function') {
      pov.resetView();
    }
    if (typeof obfPov?.resetView === 'function') {
      obfPov.resetView();
    }
    const current = this.activeController;
    if (current && current !== pov && current !== obfPov && typeof current.resetView === 'function') {
      current.resetView();
    }
  }

  /**
   * Viewport resize delegation
   */
  resize(width, height) {
    for (const controller of this.controllers.values()) {
      if (typeof controller.resize === 'function') {
        controller.resize(width, height);
      }
    }
    if (this._sharedCamera && height > 0) {
      this._sharedCamera.aspect = width / height;
      this._sharedCamera.updateProjectionMatrix();
    }
  }

  /**
   * Frame Step: Exclusive pipeline takeover with lazy evaluation.
   *
   * @param {object} carObject - 3D vehicle object
   * @param {object} ballObject - 3D ball object
   * @param {number} dt - Delta time
   * @param {object} [extraInfo] - Vehicle physical telemetry
   * @param {object} [inputState] - Optional input queries ({ isRearViewHeld })
   */
  update(carObject, ballObject, dt = 0, extraInfo = null, inputState = null) {
    // 1. Route active mode based on input state, freeCam flag, and preferred POV engine ('pov' vs 'obfuscatedPov')
    if (this.isFreeCam) {
      this.setActiveMode(CAMERA_MODES.FREE);
    } else if (inputState?.isRearViewHeld) {
      this.setActiveMode(CAMERA_MODES.REAR_VIEW);
    } else {
      this.setActiveMode(this.getPreferredPovMode());
    }

    // 2. Exclusive Execution: Active controller calculates its pipeline
    // (When in POV or OBFUSCATED_POV, CameraDeterminismHarness compares both in background)
    const controller = this.activeController;
    if (controller && typeof controller.update === 'function') {
      controller.update(carObject, ballObject, dt, extraInfo);
    }
  }

  dispose() {
    this.destroy();
  }

  destroy() {
    for (const controller of this.controllers.values()) {
      if (typeof controller.dispose === 'function') {
        controller.dispose();
      }
    }
    this.controllers.clear();
    this._sharedCamera = null;
    this.settings = null;
  }
}
