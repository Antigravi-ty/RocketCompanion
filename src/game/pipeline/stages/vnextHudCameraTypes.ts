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
