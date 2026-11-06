import * as THREE from 'three';
import { hudStore, useReferenceOverlayStore } from '../runtimeUiPort.ts';
import { getDesiredRespawnPose } from '../../physics/RocketSimConstants.ts';
import { applyRespawnPoseToObject3D } from '../../entities/arena/RespawnGhostPreview.ts';
import type { FrameContext } from '../pipeline/FramePipeline.ts';

export interface FrameCameraMetadata {
  obsTargetIdx: number;
  cameraMode: string;
  isPovCamera: boolean;
  isGoalReplayActive: boolean;
}

export interface CameraDynamicsState {
  onGround: boolean;
  groundNormal: THREE.Vector3;
  velocity: THREE.Vector3;
  supersonic: boolean;
  lookX: number;
  lookY: number;
  carView?: any;
}

export interface CameraInputState {
  isRearViewHeld: boolean;
  podiumController: any;
}

/**
 * GameCameraSubsystem.ts
 * Encapsulates camera dynamics tracking, rear view input detection,
 * ball camera target follow, and HUD arrow orientation.
 */
export class GameCameraSubsystem {
  public runtime: any;
  public scratchGroundNormal: THREE.Vector3 | null = new THREE.Vector3(0, 0, 0);
  public scratchVelocity: THREE.Vector3 | null = new THREE.Vector3(0, 0, 0);
  public respawnCameraProxy: { position: THREE.Vector3; quaternion: THREE.Quaternion } | null = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  };
  private _goalReplayCameraOverrideActive = false;
  private readonly _goalReplayCameraOverrideSources = new Set<string>();
  private readonly _basisFwd = new THREE.Vector3();
  private readonly _basisRight = new THREE.Vector3();
  private readonly _basisUp = new THREE.Vector3(0, 1, 0);
  private readonly _basisMatrix = new THREE.Matrix4();

  public cameraDynamics: CameraDynamicsState | null;
  public cameraInputState: CameraInputState;

  constructor(runtime: any) {
    this.runtime = runtime;

    this.cameraDynamics = {
      onGround: false,
      groundNormal: this.scratchGroundNormal!,
      velocity: this.scratchVelocity!,
      supersonic: false,
      lookX: 0,
      lookY: 0,
    };

    this.cameraInputState = {
      isRearViewHeld: false,
      podiumController: null,
    };
  }

  public isGoalReplayCameraOverrideActive(): boolean {
    return Boolean(this._goalReplayCameraOverrideActive);
  }

  public setGoalReplayCameraOverrideState(val: boolean): void {
    const next = Boolean(val);
    const prev = this._goalReplayCameraOverrideActive;
    if (!next) {
      this._goalReplayCameraOverrideSources.clear();
    }
    this._goalReplayCameraOverrideActive = next;
    this.runtime?.camera?.setDirectorOverride?.(next);
    if (prev && !next) {
      this.runtime?.camera?.camera?.up?.set?.(0, 1, 0);
    }
  }

  public acquireGoalReplayCameraOverride(source = 'default'): void {
    if (source) {
      this._goalReplayCameraOverrideSources.add(source);
    }
    this.setGoalReplayCameraOverrideState(true);
  }

  public releaseGoalReplayCameraOverride(source: string | null = null): void {
    if (source) {
      this._goalReplayCameraOverrideSources.delete(source);
      if (this._goalReplayCameraOverrideSources.size > 0) {
        return;
      }
    }
    this.setGoalReplayCameraOverrideState(false);
  }

  private _hasActiveGoalReplaySession(): boolean {
    const r = this.runtime;
    if (!r) return false;
    const activeMode = r.modeManager?.getActiveMode?.();
    return Boolean(
      r.match?.state?.phase === 'replay' ||
        hudStore.getState().matchPhase === 'replay' ||
        activeMode?.isGoalReplayActive?.() ||
        activeMode?.directorPreview?.isReplayActive ||
        activeMode?.replaySession?.isReplayActive ||
        activeMode?.goalReplayPhase === 'replaying' ||
        activeMode?.replayController?.sessionState?.isActive ||
        activeMode?.replaySession?.replayController?.sessionState?.isActive ||
        activeMode?.goalReplayTimelineController?.sessionState?.isActive ||
        r.replayTimelineController?.sessionState?.isActive,
    );
  }

  private _reconcileSceneCameraOverrides(): void {
    const r = this.runtime;
    if (!r) return;
    const activeMode = r.modeManager?.getActiveMode?.();
    const hasActiveReplaySession = this._hasActiveGoalReplaySession();
    if (!hasActiveReplaySession) {
      if (this.isGoalReplayCameraOverrideActive()) {
        this.releaseGoalReplayCameraOverride();
      }
      r.ballTrajectoryPredictor?.releaseTemporarySuppression?.();
    }
    const isStaticTrainingEditMode =
      (r.match?.state?.mode === 'static-training-pack' ||
        r.match?.state?.mode === 'static-training') &&
      !activeMode?.isTestingSingleShot &&
      Boolean(r.camera?.isEditorOverrideActive);
    if (!isStaticTrainingEditMode && r.camera?.isEditorOverrideActive) {
      r.camera.setEditorOverride?.(false);
    }
  }

  public resolveFrameCameraMetadata(context?: Partial<FrameContext> | null): FrameCameraMetadata {
    const r = this.runtime;
    const activeCar = context?.activeCar ?? r?.playerCarIndex ?? 0;
    const isReplayPhase = this._hasActiveGoalReplaySession();
    const isDirectorOverride = this.isGoalReplayCameraOverrideActive();
    const isReplayPov =
      isReplayPhase &&
      !isDirectorOverride &&
      typeof r?.replayPovCarIndex === 'number' &&
      r.replayPovCarIndex >= 0;

    const diagTarget = r?.networkManager?.diagnosticsProbe?.diagnosticObservationTarget ?? 0;
    const obsTargetIdx = isReplayPov
      ? r.replayPovCarIndex
      : diagTarget > 0 && r.arena?.cars?.[diagTarget]?.visible
        ? diagTarget
        : activeCar;

    let cameraMode = r?.camera?.currentMode || 'pov';
    if (r?.camera?.isFreeCam) {
      cameraMode = 'free';
    } else if (r?.podiumController?.isActive) {
      cameraMode = 'podium';
    } else if (r?.camera?.isEditorOverrideActive) {
      cameraMode = 'editor';
    } else if (isDirectorOverride) {
      cameraMode = 'director';
    }

    const isPovCamera =
      cameraMode === 'pov' || cameraMode === 'wasmPov' || cameraMode === 'rearView';

    return {
      obsTargetIdx,
      cameraMode,
      isPovCamera,
      isGoalReplayActive: Boolean(isReplayPhase || isDirectorOverride),
    };
  }

  public update(context: FrameContext): void {
    const r = this.runtime;
    if (!r?.camera || !this.cameraDynamics || !this.scratchGroundNormal || !this.scratchVelocity) {
      return;
    }
    const { dt, activeCar, activeCarMesh, playerCarView } = context;

    this._reconcileSceneCameraOverrides();

    const { obsTargetIdx } = this.resolveFrameCameraMetadata(context);
    const targetMesh = obsTargetIdx !== activeCar ? r.arena?.cars?.[obsTargetIdx] : activeCarMesh;
    const targetView =
      obsTargetIdx !== activeCar
        ? r.interpolator?.getCurrCarStateView(obsTargetIdx)
        : playerCarView;

    r.camera.setFocusedCarIndex?.(obsTargetIdx);

    let effectiveCarObject = targetMesh;
    const isLocalTarget = obsTargetIdx === activeCar;
    const selectedRespawnSlot = targetView?.demoSpawnSelection ?? -1;

    if (targetView) {
      if (targetView.isDemoed) {
        if (
          isLocalTarget &&
          selectedRespawnSlot >= 0 &&
          selectedRespawnSlot <= 3 &&
          this.respawnCameraProxy
        ) {
          const team = r.arena?.carTeams?.[obsTargetIdx] ?? obsTargetIdx % 2;
          const pose = getDesiredRespawnPose(team, selectedRespawnSlot);
          if (pose) {
            applyRespawnPoseToObject3D(
              this.respawnCameraProxy,
              pose,
              this._basisFwd,
              this._basisRight,
              this._basisUp,
              this._basisMatrix,
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
          this.cameraDynamics.onGround = targetView.isOnGround;
          this.cameraDynamics.supersonic = false;
          this.cameraDynamics.carView = targetView;
          this.scratchGroundNormal.set(
            targetView.groundNormalX,
            targetView.groundNormalZ,
            targetView.groundNormalY,
          );
          this.scratchVelocity.set(0, 0, 0);
          this.cameraDynamics.velocity = this.scratchVelocity;
        }
      } else {
        this.cameraDynamics.onGround = targetView.isOnGround;
        this.cameraDynamics.supersonic = targetView.isSupersonic;
        this.cameraDynamics.carView = targetView;
        this.scratchGroundNormal.set(
          targetView.groundNormalX,
          targetView.groundNormalZ,
          targetView.groundNormalY,
        );
        this.scratchVelocity.set(targetView.velX, targetView.velZ, targetView.velY);
        this.cameraDynamics.velocity = this.scratchVelocity;
      }
    }

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
    this.cameraInputState.podiumController = r.podiumController || null;

    r.camera.update(
      effectiveCarObject,
      r.arena?.ball,
      dt ?? 0.016,
      this.cameraDynamics,
      this.cameraInputState,
    );

    const activeCameraMode = r.camera.currentMode || (r.camera.isFreeCam ? 'free' : 'pov');
    const isPovCamera = Boolean(r.camera.isPovMode);
    if (r.arena) {
      r.arena.cameraMode = activeCameraMode;
      r.arena.isPovCamera = isPovCamera;
      r.arena.focusedCarIndex = obsTargetIdx;
    }

    if (isPovCamera && r.arena?.ball && effectiveCarObject) {
      r.arena.updateBallLocatorArrow(
        r.camera.ballCam,
        obsTargetIdx,
        r.arena.ball,
        effectiveCarObject,
      );
    }

    const hud = hudStore.getState();
    hud.setBallCamActive(r.camera.ballCam);
    hud.setCameraFocusState(activeCameraMode, obsTargetIdx);
  }

  public dispose(): void {
    this.scratchGroundNormal = null;
    this.scratchVelocity = null;
    this.respawnCameraProxy = null;
    this.cameraDynamics = null;
  }
}
