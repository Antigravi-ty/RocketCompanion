/**
 * ReplayWatchTogetherTypes.ts
 * Wave 1 temporary TypeScript contracts for Replay Watch Together (W1-05).
 * Defines Worker cursor control commands, 1~6 car RosterManifest (Channel 2),
 * and ReplayWatchFrameStreamPacket (Channel 1 + Channel 3 signals).
 *
 * Wave 3 will swap these temporary TS payloads onto the unified binary
 * WorldFrame / RosterManifest / Signal Codec from integration/vnext-core.
 */

export type ReplayWatchPlaybackState =
  | 'idle'
  | 'paused'
  | 'playing'
  | 'rewinding'
  | 'forwarding';

export type ReplayWatchCameraMode = 'car' | 'free' | 'ball';

export type ReplayWatchRoleFlag = 'player' | 'bot' | 'ghost';

export type ReplayWatchDirection = -1 | 0 | 1;

export interface ReplayWatchCameraPose {
  readonly eyeThreeJs: readonly [number, number, number];
  readonly targetThreeJs: readonly [number, number, number];
}

export interface ReplayWatchCarManifestEntry {
  readonly carIndex: number;
  readonly slotKey: number;
  readonly name: string;
  readonly team: 0 | 1;
  readonly roleFlag: ReplayWatchRoleFlag;
  readonly isBot: boolean;
  readonly visualId: string;
  readonly hitboxId: string;
  readonly colorSlot: number;
  readonly colorHex: string;
  readonly paintFinish: string;
  readonly boostVisual: string;
  readonly boostAudio: string;
  readonly decalId: string;
}

export interface ReplayWatchRosterManifest {
  readonly metadataHash: number;
  readonly replayId: string;
  readonly totalFrames: number;
  readonly tickRateHz: number;
  readonly arenaPreset: number;
  readonly telestratorPermission: 'host_only' | 'everyone';
  readonly cars: readonly ReplayWatchCarManifestEntry[];
}

export interface ReplayWatchVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ReplayWatchBallState {
  readonly pos: ReplayWatchVec3;
  readonly vel: ReplayWatchVec3;
  readonly angVel: ReplayWatchVec3;
  readonly fwd: ReplayWatchVec3;
  readonly right: ReplayWatchVec3;
  readonly up: ReplayWatchVec3;
}

export interface ReplayWatchCarFrameState {
  readonly carIndex: number;
  readonly pos: ReplayWatchVec3;
  readonly vel: ReplayWatchVec3;
  readonly angVel: ReplayWatchVec3;
  readonly fwd: ReplayWatchVec3;
  readonly right: ReplayWatchVec3;
  readonly up: ReplayWatchVec3;
  readonly boost: number;
  readonly onGround: boolean;
  readonly supersonic: boolean;
  readonly demoed: boolean;
  readonly isBoosting: boolean;
  readonly isFlipping: boolean;
}

export interface ReplayWatchSignalEvent {
  readonly signalId: number;
  readonly signalType: number;
  readonly frameIndex: number;
  readonly param1: number;
  readonly param2: number;
}

export interface ReplayWatchScoreboardState {
  readonly matchPhase: string;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly remainingSeconds: number;
  readonly isOvertime: boolean;
  readonly overtimeSeconds: number;
}

export interface ReplayWatchFrameStreamPacket {
  readonly txSeq: number;
  readonly metadataHash: number;
  readonly replayFrame: number;
  readonly fractionalFrame: number;
  readonly playbackState: ReplayWatchPlaybackState;
  readonly playbackSpeed: number;
  readonly playbackDirection: ReplayWatchDirection;
  readonly focusedCarIndex: number;
  readonly focusedTeam: 0 | 1 | null;
  readonly cameraMode: ReplayWatchCameraMode;
  readonly cameraPose: ReplayWatchCameraPose | null;
  readonly scoreboard: ReplayWatchScoreboardState;
  readonly ball: ReplayWatchBallState;
  readonly cars: readonly ReplayWatchCarFrameState[];
  readonly boostPadBitmaskLo: number;
  readonly boostPadBitmaskHi: number;
  readonly signals: readonly ReplayWatchSignalEvent[];
}

export type ReplayWatchPlaybackCommand =
  | {
      readonly type: 'load_replay';
      readonly manifest: ReplayWatchRosterManifest;
      readonly initialFrame?: number;
      readonly initialFocusedCarIndex?: number;
      readonly autoPlay?: boolean;
      readonly speed?: number;
    }
  | {
      readonly type: 'play';
      readonly speed?: number;
    }
  | {
      readonly type: 'pause';
    }
  | {
      readonly type: 'rewind';
      readonly speed?: number;
    }
  | {
      readonly type: 'fast_forward';
      readonly speed?: number;
    }
  | {
      readonly type: 'seek';
      readonly frameIndex: number;
    }
  | {
      readonly type: 'set_speed';
      readonly speed: number;
    }
  | {
      readonly type: 'set_focus';
      readonly focusedCarIndex: number;
      readonly cameraMode?: ReplayWatchCameraMode;
      readonly cameraPose?: ReplayWatchCameraPose | null;
    }
  | {
      readonly type: 'unload';
    };

export interface ReplayWatchCursorStatus {
  readonly loaded: boolean;
  readonly replayId: string | null;
  readonly metadataHash: number;
  readonly txSeq: number;
  readonly totalFrames: number;
  readonly currentFrame: number;
  readonly fractionalFrame: number;
  readonly playbackState: ReplayWatchPlaybackState;
  readonly playbackSpeed: number;
  readonly playbackDirection: ReplayWatchDirection;
  readonly focusedCarIndex: number;
  readonly cameraMode: ReplayWatchCameraMode;
}
