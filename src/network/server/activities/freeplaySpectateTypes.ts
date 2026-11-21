/**
 * src/network/server/activities/freeplaySpectateTypes.ts
 * Wave 1 (W1-04) temporary TypeScript interfaces for the vNext Freeplay
 * Unified Spectate Frame Stream across all 4 transport channels:
 *   Ch1: High-frequency State Stream (live / goal_replay / rewind)
 *   Ch2: Low-frequency Metadata Manifest (RosterManifest + FreeplayModeContext)
 *   Ch3: Reliable Signal / Incident Stream
 *   Ch4: Bulk / Asset Stream (FreeplayRewinderController slice manifest)
 *
 * Wave 2 (`feat/protocol-schema-alignment`) will consolidate these field
 * requirements into the final zero-allocation binary codec.
 */

import { VNEXT_CHANNEL1_SCHEMA_HASH } from '../../protocol/VNextSchemaHash.ts';

export const FREEPLAY_W104_TEMP_SCHEMA_HASH = VNEXT_CHANNEL1_SCHEMA_HASH;

export type FreeplaySubMode = 'live' | 'goal_replay' | 'rewind';

export type FreeplayPlaybackState = 'playing' | 'paused' | 'rewinding';

export type FreeplayPhase = 'playing' | 'goal' | 'replay' | 'countdown' | 'lobby';

export type FreeplayCameraMode = 'player' | 'director' | 'pov';

export type FreeplayRewinderState =
  | 'idle'
  | 'recording'
  | 'stopped'
  | 'rewinding'
  | 'forwarding'
  | 'paused-scrub'
  | 'preroll-countdown';

export type FreeplayRoleFlag = 'player' | 'bot' | 'ghost';

export interface FreeplayCameraPose {
  posX: number;
  posY: number;
  posZ: number;
  lookAtX: number;
  lookAtY: number;
  lookAtZ: number;
  fov: number;
}

export interface FreeplayBallState {
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  angVelX: number;
  angVelY: number;
  angVelZ: number;
  isExpired: boolean;
}

export interface FreeplayCarState {
  carIndex: number;
  team: 0 | 1;
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  boost: number;
  isSupersonic: boolean;
  isBoosting: boolean;
  onGround: boolean;
  isDemolished: boolean;
}

export interface FreeplayGoalReplayMeta {
  replayType: 'goal' | 'expire';
  scoringTeam: 0 | 1;
  scorerCarIndex: number;
  scorerName: string;
  ballSpeedKph: number | null;
}

/**
 * Channel 1: High-frequency Freeplay State Frame.
 * Note: `txSeq` MUST be strictly monotonically increasing across all sub-modes
 * (including `rewinding` and `goal_replay`) so EstablishedSession sliding-window
 * ack trimming remains 100% symmetric.
 */
export interface FreeplayStateFramePayload {
  txSeq: number;
  schemaHash: number;
  metadataHash: number;
  sourceTick: number;
  subMode: FreeplaySubMode;
  playbackState: FreeplayPlaybackState;
  playbackRate: number;
  phase: FreeplayPhase;
  clockSecondsRemaining: number;
  unlimitedBoost: boolean;
  boostPadMask: number;
  focusedCarIndex: number;
  cameraMode: FreeplayCameraMode;
  cameraPose: FreeplayCameraPose | null;
  replayCursorFrame: number;
  replayTotalFrames: number;
  rewinderState: FreeplayRewinderState;
  ball: FreeplayBallState;
  cars: FreeplayCarState[];
  goalReplayMeta: FreeplayGoalReplayMeta | null;
}

export interface FreeplayRosterCarEntry {
  carIndex: number;
  name: string;
  team: 0 | 1;
  visualId: string;
  colorHex: string;
  paintFinish: string;
  decalId: string;
  isBot: boolean;
  roleFlag: FreeplayRoleFlag;
}

/**
 * Channel 2: Low-frequency RosterManifest & Freeplay Room/Mode Context.
 */
export interface FreeplayRosterManifest {
  metadataHash: number;
  activityId: 'freeplay';
  arenaPreset: 'standard' | 'throwback';
  unlimitedBoost: boolean;
  goalReplayEnabled: boolean;
  telestratorPermission: 'host_only' | 'everyone';
  cars: FreeplayRosterCarEntry[];
}

export type FreeplaySignalKind =
  | 'car_ball_hit'
  | 'goal_scored'
  | 'ball_expired'
  | 'goal_replay_start'
  | 'goal_replay_end'
  | 'kickoff_reset'
  | 'flip_reset_gained'
  | 'rewinder_state_change'
  | 'countdown_tick';

/**
 * Channel 3: Reliable Signal / Incident Event.
 */
export interface FreeplaySignalEvent {
  signalId: number;
  txSeq: number;
  sourceTick: number;
  kind: FreeplaySignalKind;
  carIndex?: number;
  team?: 0 | 1;
  ballSpeedKph?: number | null;
  rewinderState?: FreeplayRewinderState;
  countdownSeconds?: number;
}

/**
 * Channel 4: Bulk / Asset Transfer Manifest for FreeplayRewinderController
 * historical slices ("Intervene From Here").
 */
export interface FreeplayRewinderSliceManifest {
  fileHash: string;
  totalFrames: number;
  startTick: number;
  endTick: number;
  cursorFrame: number;
  byteLength: number;
  chunkCount: number;
}

export interface FreeplayFrameBundle {
  stateFrame: FreeplayStateFramePayload;
  signals: FreeplaySignalEvent[];
  manifestChanged: boolean;
  manifest: FreeplayRosterManifest;
}
