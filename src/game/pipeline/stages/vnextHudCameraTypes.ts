/**
 * vnextHudCameraTypes.ts
 * Wave 1 (W1-08) temporary TS interfaces for HUD 1~6 and Client Goal Replay Camera consumers.
 * Wave 2 (feat/protocol-schema-alignment) will align these fields with the binary Channel 1/2 codecs.
 */

export type VNextRosterRoleFlag = 'player' | 'bot' | 'ghost';

export interface VNextRosterEntry {
  readonly carIndex: number;
  readonly name: string;
  readonly team: 0 | 1;
  readonly roleFlag: VNextRosterRoleFlag;
  readonly isBot: boolean;
  readonly isLocalPlayer?: boolean;
  readonly slotKey?: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface VNextRosterManifest {
  readonly metadataHash: number;
  readonly matchMode: string;
  readonly isSpectatorSession?: boolean;
  readonly entries: readonly VNextRosterEntry[];
}

export type VNextCameraMode =
  | 'pov'
  | 'wasmPov'
  | 'rearView'
  | 'free'
  | 'director'
  | 'podium'
  | 'editor';

export interface VNextCameraPose {
  readonly eyeThreeJs: readonly [number, number, number];
  readonly targetThreeJs: readonly [number, number, number];
  readonly fovDeg?: number;
}

export interface VNextCameraFocusState {
  readonly focusedCarIndex: number | null;
  readonly cameraMode: VNextCameraMode;
  readonly ballCam: boolean;
  readonly isGoalReplayActive: boolean;
  readonly replayCameraMode?: 'director' | 'pov';
}

export interface VNextCarHudTelemetry {
  readonly carIndex: number;
  readonly boostAmount: number;
  readonly isDemolished: boolean;
  readonly demoRespawnRemainingSec: number;
  readonly demolishedAtMs?: number;
  readonly replaySkipReady?: boolean;
}

export interface VNextWorldFrameCameraAndHudHeader {
  readonly txSeq: number;
  readonly metadataHash: number;
  readonly phase: string;
  readonly playbackState: 'playing' | 'paused' | 'rewinding' | 'ended';
  readonly clockSeconds: number;
  readonly isOvertime: boolean;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly cameraFocus: VNextCameraFocusState;
  readonly cameraPose?: VNextCameraPose | null;
  readonly choreographySignal?: string;
  readonly carTelemetry?: ReadonlyArray<VNextCarHudTelemetry>;
}

import type { DecodedVNextWorldFrame } from '../../../network/protocol/VNextWorldFrameCodec.ts';
import type { VNextRosterManifest as CodecRosterManifest } from '../../../network/protocol/VNextRosterManifestCodec.ts';

export function fromCodecRosterManifest(
  manifest: CodecRosterManifest,
  isSpectatorSession = false
): VNextRosterManifest {
  return {
    metadataHash: manifest.metadataHash,
    matchMode: manifest.activityId,
    isSpectatorSession,
    entries: manifest.entries.map((e) => ({
      carIndex: e.carIndex,
      name: e.name,
      team: e.team,
      roleFlag: e.roleFlag,
      isBot: e.isBot,
      slotKey: (e.slotKey >= 1 && e.slotKey <= 6 ? e.slotKey : undefined) as
        | 1
        | 2
        | 3
        | 4
        | 5
        | 6
        | undefined,
    })),
  };
}

export function fromDecodedWorldFrameToHudHeader(
  frame: DecodedVNextWorldFrame
): VNextWorldFrameCameraAndHudHeader {
  const playbackState =
    frame.playbackState === 'fast_forward' || frame.playbackState === 'seeking'
      ? 'playing'
      : frame.playbackState;
  return {
    txSeq: frame.txSeq,
    metadataHash: frame.metadataHash,
    phase: frame.phase,
    playbackState,
    clockSeconds: frame.clockSeconds,
    isOvertime: frame.isOvertime,
    blueScore: frame.blueScore,
    orangeScore: frame.orangeScore,
    cameraFocus: {
      focusedCarIndex: frame.focusedCarIndex,
      cameraMode: frame.cameraMode,
      ballCam: frame.ballCam,
      isGoalReplayActive: frame.isGoalReplayActive,
      replayCameraMode: frame.cameraMode === 'director' ? 'director' : 'pov',
    },
    cameraPose: frame.cameraPose
      ? {
          eyeThreeJs: frame.cameraPose.eye,
          targetThreeJs: frame.cameraPose.target,
          fovDeg: frame.cameraPose.fovDeg,
        }
      : null,
  };
}
