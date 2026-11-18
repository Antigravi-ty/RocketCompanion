import type { WorkspaceCameraSyncPayload } from '../../../network/protocol/GlobalWorkspaceProtocol.ts';
import { captureCameraSyncFromPort } from '../../runtimeUiPort.ts';

export interface AuthorityCameraPort {
  isFreeCam?: boolean;
  ballCam?: boolean;
  focusedCarIndex?: number;
  setFreeCam?: (enabled: boolean) => void;
  setFreeCamPose?: (
    position: [number, number, number],
    lookAtTarget?: [number, number, number]
  ) => void;
  setFocusedCarIndex?: (carIndex: number) => void;
  getFreeCamStateSnapshot?: () => {
    eyeThreeJs?: [number, number, number];
    targetThreeJs?: [number, number, number];
  } | null;
}

export interface CameraSyncEmission {
  readonly type: 'camera_state_sync';
  readonly authorityEpoch: number;
  readonly cameraSyncSeq: number;
  readonly peerId: string;
  readonly cameraSync: WorkspaceCameraSyncPayload;
}

export class AuthorityCameraSyncTracker {
  private lastLocalCameraKey: string | null = null;
  private localSeq = 0;
  private lastAppliedEpoch = -1;
  private lastAppliedSeq = -1;
  private lastAppliedKey: string | null = null;

  public reset(): void {
    this.lastLocalCameraKey = null;
    this.localSeq = 0;
    this.lastAppliedEpoch = -1;
    this.lastAppliedSeq = -1;
    this.lastAppliedKey = null;
  }

  public getCurrentSeq(): number {
    return this.localSeq;
  }

  public bumpLocalSeq(): number {
    this.localSeq += 1;
    return this.localSeq;
  }

  public computeCameraKey(
    camera:
      | { isFreeCam?: boolean; ballCam?: boolean; focusedCarIndex?: number }
      | null
      | undefined
  ): string {
    if (!camera) return '';
    const isFree = Boolean(camera.isFreeCam);
    const ballCam = typeof camera.ballCam === 'boolean' ? camera.ballCam : true;
    const focused =
      typeof camera.focusedCarIndex === 'number' && Number.isFinite(camera.focusedCarIndex)
        ? Math.max(0, Math.round(camera.focusedCarIndex))
        : 0;
    return `${isFree ? 1 : 0}:${ballCam ? 1 : 0}:${focused}`;
  }

  public pollLocalCameraChange(
    camera: AuthorityCameraPort | null | undefined,
    authorityEpoch: number,
    localPeerId: string
  ): CameraSyncEmission | null {
    const key = this.computeCameraKey(camera);
    if (!key) return null;
    if (this.lastLocalCameraKey === null) {
      this.lastLocalCameraKey = key;
      return null;
    }
    if (key === this.lastLocalCameraKey) {
      return null;
    }
    this.lastLocalCameraKey = key;
    this.localSeq += 1;
    const snap = captureCameraSyncFromPort(camera, true) as
      | WorkspaceCameraSyncPayload
      | undefined;
    const baseSnap: WorkspaceCameraSyncPayload = snap ?? {
      followHostCamera: true,
      isFreeCam: Boolean(camera?.isFreeCam),
      ballCam: typeof camera?.ballCam === 'boolean' ? camera.ballCam : true,
      focusedCarIndex:
        typeof camera?.focusedCarIndex === 'number' && Number.isFinite(camera.focusedCarIndex)
          ? Math.max(0, Math.round(camera.focusedCarIndex))
          : 0,
    };
    return {
      type: 'camera_state_sync',
      authorityEpoch,
      cameraSyncSeq: this.localSeq,
      peerId: localPeerId,
      cameraSync: {
        ...baseSnap,
        cameraSyncSeq: this.localSeq,
        authorityEpoch,
        authorityPeerId: localPeerId,
      },
    };
  }

  public shouldApplyIncomingCameraSync(params: {
    cameraSync: WorkspaceCameraSyncPayload | null | undefined;
    isLocalAuthority: boolean;
    incomingEpoch?: number;
  }): boolean {
    const { cameraSync, isLocalAuthority, incomingEpoch } = params;
    if (isLocalAuthority || !cameraSync || cameraSync.followHostCamera === false) {
      return false;
    }
    const seq =
      typeof cameraSync.cameraSyncSeq === 'number' && Number.isFinite(cameraSync.cameraSyncSeq)
        ? Math.round(cameraSync.cameraSyncSeq)
        : -1;
    const epoch =
      typeof cameraSync.authorityEpoch === 'number' && Number.isFinite(cameraSync.authorityEpoch)
        ? Math.round(cameraSync.authorityEpoch)
        : typeof incomingEpoch === 'number' && Number.isFinite(incomingEpoch)
          ? Math.round(incomingEpoch)
          : 0;

    if (seq >= 0) {
      if (epoch < this.lastAppliedEpoch) return false;
      if (epoch === this.lastAppliedEpoch && seq <= this.lastAppliedSeq) return false;
      this.lastAppliedEpoch = epoch;
      this.lastAppliedSeq = seq;
      const incomingKey = this.computeCameraKey(cameraSync);
      if (incomingKey) {
        this.lastLocalCameraKey = incomingKey;
        this.lastAppliedKey = incomingKey;
      }
      return true;
    }

    const incomingKey = this.computeCameraKey(cameraSync);
    if (!incomingKey || incomingKey === this.lastAppliedKey) {
      return false;
    }
    this.lastAppliedKey = incomingKey;
    this.lastLocalCameraKey = incomingKey;
    return true;
  }
}

export const sharedAuthorityCameraSyncTracker = new AuthorityCameraSyncTracker();
