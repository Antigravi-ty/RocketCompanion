/**
 * vnextGoalReplayCameraConsumer.ts
 * Wave 1 (W1-08) Client Camera Consumer for Broadcaster Goal Replay Cinematic Camera & cameraFocus.
 * Zero local director simulation; directly consumes Broadcaster cameraFocus + cameraPose.
 */
import type {
  VNextCameraMode,
  VNextCameraPose,
  VNextWorldFrameCameraAndHudHeader,
} from '../pipeline/stages/vnextHudCameraTypes.ts';

export const VNEXT_BROADCASTER_DIRECTOR_SOURCE = 'vnext-broadcaster';

export interface BroadcasterCameraPort {
  isFreeCam?: boolean;
  ballCam?: boolean;
  focusedCarIndex?: number;
  directorController?: { fov: number } | null;
  setFreeCam?: (enabled: boolean) => void;
  setFreeCamPose?: (
    position: [number, number, number],
    lookAtTarget?: [number, number, number]
  ) => void;
  setFocusedCarIndex?: (carIndex: number) => void;
  setDirectorCameraPoseThreeJs?: (
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    targetX: number,
    targetY: number,
    targetZ: number
  ) => void;
}

export interface BroadcasterCameraOverridePort {
  acquireGoalReplayCameraOverride(source?: string): void;
  releaseGoalReplayCameraOverride(source?: string | null): void;
}

export interface BroadcasterHudSyncPort {
  setBallCamActive?: (active: boolean) => void;
  setCameraFocusState?: (cameraMode: VNextCameraMode, focusedCarIndex: number) => void;
  setReplayState?: (state: { replayCameraMode?: 'director' | 'pov' }) => void;
}

export interface BroadcasterCameraApplyResult {
  readonly appliedMode: VNextCameraMode;
  readonly directorOverrideActive: boolean;
  readonly appliedPose: boolean;
  readonly focusedCarIndex: number | null;
}

export function isValidCameraPose(pose: VNextCameraPose | null | undefined): pose is VNextCameraPose {
  if (!pose) return false;
  const eye = pose.eyeThreeJs;
  const target = pose.targetThreeJs;
  if (!eye || !target || eye.length < 3 || target.length < 3) return false;
  return (
    Number.isFinite(eye[0]) &&
    Number.isFinite(eye[1]) &&
    Number.isFinite(eye[2]) &&
    Number.isFinite(target[0]) &&
    Number.isFinite(target[1]) &&
    Number.isFinite(target[2])
  );
}

export class VNextGoalReplayCameraConsumer {
  private _isBroadcasterDirectorActive = false;
  private _lastAppliedTxSeq = -1;

  public get isBroadcasterDirectorActive(): boolean {
    return this._isBroadcasterDirectorActive;
  }

  public reset(overridePort?: BroadcasterCameraOverridePort | null): void {
    if (this._isBroadcasterDirectorActive) {
      this._isBroadcasterDirectorActive = false;
      overridePort?.releaseGoalReplayCameraOverride(VNEXT_BROADCASTER_DIRECTOR_SOURCE);
    }
    this._lastAppliedTxSeq = -1;
  }

  public applyFrame(
    frame: VNextWorldFrameCameraAndHudHeader,
    camera: BroadcasterCameraPort | null | undefined,
    overridePort: BroadcasterCameraOverridePort | null | undefined,
    hud?: BroadcasterHudSyncPort | null
  ): BroadcasterCameraApplyResult {
    const { cameraFocus, cameraPose, txSeq } = frame;
    if (typeof txSeq === 'number' && txSeq < this._lastAppliedTxSeq) {
      return {
        appliedMode: cameraFocus.cameraMode,
        directorOverrideActive: this._isBroadcasterDirectorActive,
        appliedPose: false,
        focusedCarIndex: cameraFocus.focusedCarIndex,
      };
    }
    if (typeof txSeq === 'number') {
      this._lastAppliedTxSeq = txSeq;
    }

    const isDirectorGoalReplay =
      Boolean(cameraFocus.isGoalReplayActive) && cameraFocus.cameraMode === 'director';
    let appliedPose = false;

    if (isDirectorGoalReplay) {
      if (!this._isBroadcasterDirectorActive) {
        this._isBroadcasterDirectorActive = true;
        overridePort?.acquireGoalReplayCameraOverride(VNEXT_BROADCASTER_DIRECTOR_SOURCE);
      }
      if (camera?.isFreeCam) {
        camera.setFreeCam?.(false);
      }
      if (isValidCameraPose(cameraPose)) {
        if (
          typeof cameraPose.fovDeg === 'number' &&
          Number.isFinite(cameraPose.fovDeg) &&
          camera?.directorController
        ) {
          camera.directorController.fov = cameraPose.fovDeg;
        }
        const [ex, ey, ez] = cameraPose.eyeThreeJs;
        const [tx, ty, tz] = cameraPose.targetThreeJs;
        camera?.setDirectorCameraPoseThreeJs?.(ex, ey, ez, tx, ty, tz);
        appliedPose = true;
      }
    } else {
      if (this._isBroadcasterDirectorActive) {
        this._isBroadcasterDirectorActive = false;
        overridePort?.releaseGoalReplayCameraOverride(VNEXT_BROADCASTER_DIRECTOR_SOURCE);
      }

      if (cameraFocus.cameraMode === 'free') {
        if (isValidCameraPose(cameraPose)) {
          camera?.setFreeCamPose?.(
            [cameraPose.eyeThreeJs[0], cameraPose.eyeThreeJs[1], cameraPose.eyeThreeJs[2]],
            [cameraPose.targetThreeJs[0], cameraPose.targetThreeJs[1], cameraPose.targetThreeJs[2]]
          );
          appliedPose = true;
        } else {
          camera?.setFreeCam?.(true);
        }
      } else {
        if (camera?.isFreeCam) {
          camera.setFreeCam?.(false);
        }
        if (
          typeof cameraFocus.focusedCarIndex === 'number' &&
          Number.isFinite(cameraFocus.focusedCarIndex) &&
          cameraFocus.focusedCarIndex >= 0
        ) {
          camera?.setFocusedCarIndex?.(Math.round(cameraFocus.focusedCarIndex));
        }
        if (camera && typeof cameraFocus.ballCam === 'boolean') {
          camera.ballCam = cameraFocus.ballCam;
        }
      }
    }

    if (hud) {
      const hudFocusIdx =
        typeof cameraFocus.focusedCarIndex === 'number' && cameraFocus.focusedCarIndex >= 0
          ? Math.round(cameraFocus.focusedCarIndex)
          : 0;
      if (
        cameraFocus.cameraMode === 'pov' ||
        cameraFocus.cameraMode === 'wasmPov' ||
        cameraFocus.cameraMode === 'rearView' ||
        cameraFocus.cameraMode === 'free' ||
        cameraFocus.cameraMode === 'director' ||
        cameraFocus.cameraMode === 'podium'
      ) {
        hud.setCameraFocusState?.(cameraFocus.cameraMode, hudFocusIdx);
      }
      if (typeof cameraFocus.ballCam === 'boolean') {
        hud.setBallCamActive?.(cameraFocus.ballCam);
      }
      if (cameraFocus.isGoalReplayActive) {
        const replayMode: 'director' | 'pov' = isDirectorGoalReplay ? 'director' : 'pov';
        hud.setReplayState?.({ replayCameraMode: replayMode });
      }
    }

    return {
      appliedMode: cameraFocus.cameraMode,
      directorOverrideActive: this._isBroadcasterDirectorActive,
      appliedPose,
      focusedCarIndex: cameraFocus.focusedCarIndex,
    };
  }
}
