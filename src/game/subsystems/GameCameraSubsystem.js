import * as THREE from 'three';
import { hudStore } from '../../ui-core/stores/hudStore';
import { useReferenceOverlayStore } from '../../ui-core/stores/referenceOverlayStore';
import { getDesiredRespawnPose } from '../../physics/RocketSimConstants.js';
import { applyRespawnPoseToObject3D } from '../../entities/arena/RespawnGhostPreview.js';

/**
 * GameCameraSubsystem.js
 * Encapsulates camera dynamics tracking, rear view input detection,
 * ball camera target follow, and HUD arrow orientation.
 */
export class GameCameraSubsystem {
  /**
   * @param {object} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    this.scratchGroundNormal = new THREE.Vector3(0, 0, 0);
    this.scratchVelocity = new THREE.Vector3(0, 0, 0);
    this.respawnCameraProxy = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion()
    };
    this._basisFwd = new THREE.Vector3();
    this._basisRight = new THREE.Vector3();
    this._basisUp = new THREE.Vector3(0, 1, 0);
    this._basisMatrix = new THREE.Matrix4();

    this.cameraDynamics = {
      onGround: false,
      groundNormal: this.scratchGroundNormal,
      velocity: this.scratchVelocity,
      supersonic: false,
      lookX: 0,
      lookY: 0
    };

    this.cameraInputState = {
      isRearViewHeld: false
    };
  }

  update(context) {
    const r = this.runtime;
    const { dt, activeCar, activeCarMesh, playerCarView } = context;

    if (r?.podiumController?.isActive && !r?.camera?.isFreeCam) {
      if (r.arena) {
        r.arena.cameraMode = 'podium';
        r.arena.isPovCamera = false;
      }
      hudStore.getState().setCameraFocusState('podium', activeCar ?? 0);
      r.podiumController.updateCamera(r.camera, dt ?? 0.016);
      return;
    }

    if (r?.goalReplayCameraOverrideActive && !r?.camera?.isFreeCam) {
      if (r.arena) {
        r.arena.cameraMode = 'director';
        r.arena.isPovCamera = false;
      }
      hudStore.getState().setCameraFocusState('director', activeCar ?? 0);
      return;
    }

    const isReplayPov =
      (r?.match?.state?.phase === 'replay' || hudStore.getState().matchPhase === 'replay') &&
      !r?.goalReplayCameraOverrideActive &&
      typeof r?.replayPovCarIndex === 'number' &&
      r.replayPovCarIndex >= 0;

    const obsTargetIdx = isReplayPov
      ? r.replayPovCarIndex
      : (
          typeof r.diagnosticObservationTarget === 'number' &&
          r.diagnosticObservationTarget > 0 &&
          r.arena?.cars?.[r.diagnosticObservationTarget]?.visible
        )
      ? r.diagnosticObservationTarget
      : activeCar;

    const targetMesh = obsTargetIdx !== activeCar ? r.arena?.cars?.[obsTargetIdx] : activeCarMesh;
    const targetView = obsTargetIdx !== activeCar
      ? r.interpolator?.getCurrCarStateView(obsTargetIdx)
      : playerCarView;

    if (!r.camera || !targetView) return;

    r.camera.setFocusedCarIndex?.(obsTargetIdx);

    let effectiveCarObject = targetMesh;
    const isLocalTarget = obsTargetIdx === activeCar;
    const selectedRespawnSlot = targetView.demoSpawnSelection;

    if (targetView.isDemoed) {
      if (isLocalTarget && selectedRespawnSlot >= 0 && selectedRespawnSlot <= 3) {
        const team = r.arena?.carTeams?.[obsTargetIdx] ?? (obsTargetIdx % 2);
        const pose = getDesiredRespawnPose(team, selectedRespawnSlot);
        if (pose) {
          applyRespawnPoseToObject3D(
            this.respawnCameraProxy,
            pose,
            this._basisFwd,
            this._basisRight,
            this._basisUp,
            this._basisMatrix
          );
          effectiveCarObject = this.respawnCameraProxy;
        }
        this.cameraDynamics.onGround = true;
        this.cameraDynamics.supersonic = false;
        this.cameraDynamics.carView = targetView;
        this.scratchGroundNormal.set(0, 1, 0);
        this.scratchVelocity.set(0, 0, 0);
        this.cameraDynamics.velocity = this.scratchVelocity;
      } else {
        // Stay at the exact demolition moment when no Left/Right respawn selection input was given
        this.cameraDynamics.onGround = targetView.isOnGround;
        this.cameraDynamics.supersonic = false;
        this.cameraDynamics.carView = targetView;
        this.scratchGroundNormal.set(
          targetView.groundNormalX,
          targetView.groundNormalZ,
          targetView.groundNormalY
        );
        this.scratchVelocity.set(0, 0, 0);
        this.cameraDynamics.velocity = this.scratchVelocity;
      }
    } else {
      // 1. Calculate vehicle dynamic forces & orientation
      this.cameraDynamics.onGround = targetView.isOnGround;
      this.cameraDynamics.supersonic = targetView.isSupersonic;
      this.cameraDynamics.carView = targetView;
      this.scratchGroundNormal.set(
        targetView.groundNormalX,
        targetView.groundNormalZ,
        targetView.groundNormalY
      );
      this.scratchVelocity.set(
        targetView.velX,
        targetView.velZ,
        targetView.velY
      );
      this.cameraDynamics.velocity = this.scratchVelocity;
    }

    // 2. Poll Rear View & Look X/Y (including developer simulated overrides)
    const refOverlayState = useReferenceOverlayStore?.getState?.();
    const overrideLookX = refOverlayState?.cameraLookXOverride ?? 0;
    const overrideLookY = refOverlayState?.cameraLookYOverride ?? 0;
    const overrideRearView = Boolean(refOverlayState?.rearViewOverride);

    if (Math.abs(overrideLookX) > 1e-4 || Math.abs(overrideLookY) > 1e-4) {
      this.cameraDynamics.lookX = Math.max(-1, Math.min(1, overrideLookX));
      this.cameraDynamics.lookY = Math.max(-1, Math.min(1, overrideLookY));
    }

    const isRearViewHeld =
      overrideRearView ||
      ((r.keyboard?.held?.('rearView') || r.gamepad?.pressed?.('rearView')) ?? false);
    this.cameraInputState.isRearViewHeld = isRearViewHeld;

    // 3. Advance camera orientation & position
    if (effectiveCarObject && r.arena?.ball) {
      r.camera.update(effectiveCarObject, r.arena.ball, dt, this.cameraDynamics, this.cameraInputState);
    }

    const activeCameraMode = r.camera.currentMode || (r.camera.isFreeCam ? 'free' : 'pov');
    const isPovCamera = Boolean(r.camera.isPovMode);
    if (r.arena) {
      r.arena.cameraMode = activeCameraMode;
      r.arena.isPovCamera = isPovCamera;
      r.arena.focusedCarIndex = obsTargetIdx;
    }

    // 4. Update Ball Locator HUD Arrow
    if (r.arena?.ball) {
      r.arena.updateBallLocatorArrow(r.camera.ballCam, obsTargetIdx, r.arena.ball, effectiveCarObject);
    }

    // 5. Sync Ball Cam & Camera Focus state to HUD Store
    const hud = hudStore.getState();
    hud.setBallCamActive(r.camera.ballCam);
    hud.setCameraFocusState(activeCameraMode, obsTargetIdx);
  }

  dispose() {
    this.scratchGroundNormal = null;
    this.scratchVelocity = null;
    this.respawnCameraProxy = null;
    this.cameraDynamics = null;
  }
}
