/**
 * src/network/protocol/VNextWorldFrameCodec.ts
 * Wave 2 (`feat/protocol-schema-alignment`):
 * Channel 1 High-Frequency WorldFrame binary codec (DataView zero-alloc).
 * Unifies Wave 1 field requirements across W1-01..W1-08 and embeds GlobalPayloadCodec.
 */

import {
  GlobalPayloadCodec,
  type DecodedGlobalPayload,
  type GlobalPayloadEncodeInput,
} from './GlobalPayloadCodec.ts';
import { VNEXT_CHANNEL1_SCHEMA_HASH, formatSchemaHashHex } from './VNextSchemaHash.ts';

export type VNextActivityMode =
  | 'match'
  | 'exhibition'
  | 'freeplay'
  | 'replay'
  | 'training'
  | 'sandbox';

export type VNextPlaybackState =
  | 'playing'
  | 'paused'
  | 'rewinding'
  | 'fast_forward'
  | 'seeking'
  | 'ended';

export type VNextFramePhase =
  | 'lobby'
  | 'countdown'
  | 'kickoff'
  | 'playing'
  | 'goal'
  | 'replay'
  | 'overtime'
  | 'podium'
  | 'ended'
  | 'preroll_countdown'
  | 'ready'
  | 'goal_scored'
  | 'result';

export type VNextCameraMode =
  | 'pov'
  | 'wasmPov'
  | 'rearView'
  | 'free'
  | 'director'
  | 'podium'
  | 'editor';

export type VNextFpvAuthorityMode = 'host_only' | 'client_only' | 'fpv_master_slave';

export const VNEXT_FRAME_FLAGS = Object.freeze({
  HAS_FPV_AUTHORITY: 1 << 0,
  HAS_TRAINING_HEADER: 1 << 1,
  HAS_CAMERA_POSE: 1 << 2,
  HAS_GLOBAL_PAYLOAD: 1 << 3,
  IS_OVERTIME: 1 << 4,
  BALL_CAM: 1 << 5,
  IS_GOAL_REPLAY_ACTIVE: 1 << 6,
  DISCONTINUITY: 1 << 7,
  IS_SHOT_LAUNCHED: 1 << 8,
} as const);

const ACTIVITY_MODES: readonly VNextActivityMode[] = [
  'match',
  'exhibition',
  'freeplay',
  'replay',
  'training',
  'sandbox',
];

const PLAYBACK_STATES: readonly VNextPlaybackState[] = [
  'playing',
  'paused',
  'rewinding',
  'fast_forward',
  'seeking',
  'ended',
];

const FRAME_PHASES: readonly VNextFramePhase[] = [
  'lobby',
  'countdown',
  'kickoff',
  'playing',
  'goal',
  'replay',
  'overtime',
  'podium',
  'ended',
  'preroll_countdown',
  'ready',
  'goal_scored',
  'result',
];

const CAMERA_MODES: readonly VNextCameraMode[] = [
  'pov',
  'wasmPov',
  'rearView',
  'free',
  'director',
  'podium',
  'editor',
];

const FPV_AUTHORITY_MODES: readonly VNextFpvAuthorityMode[] = [
  'host_only',
  'client_only',
  'fpv_master_slave',
];

export interface VNextFpvAuthorityHeader {
  authorityEpoch: number;
  activeInputPeerSlot: number;
  authorityMode: VNextFpvAuthorityMode;
}

export interface VNextTrainingFrameHeader {
  shotIndex: number;
  shotResetSeq: number;
  countdownSeconds: number;
  remainingTimeoutSeconds: number;
}

export interface VNextCameraPose {
  eye: readonly [number, number, number];
  target: readonly [number, number, number];
  fovDeg: number;
}

export interface VNextWorldFrameEncodeInput {
  txSeq: number;
  metadataHash: number;
  activityMode: VNextActivityMode;
  playbackState: VNextPlaybackState;
  phase: VNextFramePhase;
  simTick?: number;
  replayFrameIndex?: number;
  replayTotalFrames?: number;
  clockSeconds?: number;
  playbackSpeed?: number;
  blueScore?: number;
  orangeScore?: number;
  focusedCarIndex?: number | null;
  cameraMode?: VNextCameraMode;
  timestampMs?: number;
  isOvertime?: boolean;
  ballCam?: boolean;
  isGoalReplayActive?: boolean;
  discontinuity?: boolean;
  isShotLaunched?: boolean;
  fpvAuthority?: VNextFpvAuthorityHeader | null;
  trainingHeader?: VNextTrainingFrameHeader | null;
  cameraPose?: VNextCameraPose | null;
  globalPayload?: GlobalPayloadEncodeInput | null;
}

export interface DecodedVNextWorldFrame {
  schemaHash: number;
  txSeq: number;
  metadataHash: number;
  activityMode: VNextActivityMode;
  playbackState: VNextPlaybackState;
  phase: VNextFramePhase;
  flags: number;
  simTick: number;
  replayFrameIndex: number;
  replayTotalFrames: number;
  clockSeconds: number;
  playbackSpeed: number;
  blueScore: number;
  orangeScore: number;
  focusedCarIndex: number | null;
  cameraMode: VNextCameraMode;
  timestampMs: number;
  isOvertime: boolean;
  ballCam: boolean;
  isGoalReplayActive: boolean;
  discontinuity: boolean;
  isShotLaunched: boolean;
  fpvAuthority: VNextFpvAuthorityHeader | null;
  trainingHeader: VNextTrainingFrameHeader | null;
  cameraPose: VNextCameraPose | null;
  globalPayload: DecodedGlobalPayload | null;
}

const HEADER_BYTES = 51;
const FPV_AUTHORITY_BYTES = 6;
const TRAINING_HEADER_BYTES = 14;
const CAMERA_POSE_BYTES = 28;

function indexOfOrZero<T extends string>(arr: readonly T[], val: T | undefined): number {
  if (!val) return 0;
  const idx = arr.indexOf(val);
  return idx >= 0 ? idx : 0;
}

export class VNextWorldFrameCodec {
  static encode(input: VNextWorldFrameEncodeInput): Uint8Array {
    let flags = 0;
    if (input.isOvertime) flags |= VNEXT_FRAME_FLAGS.IS_OVERTIME;
    if (input.ballCam) flags |= VNEXT_FRAME_FLAGS.BALL_CAM;
    if (input.isGoalReplayActive) flags |= VNEXT_FRAME_FLAGS.IS_GOAL_REPLAY_ACTIVE;
    if (input.discontinuity) flags |= VNEXT_FRAME_FLAGS.DISCONTINUITY;
    if (input.isShotLaunched) flags |= VNEXT_FRAME_FLAGS.IS_SHOT_LAUNCHED;

    const fpv = input.fpvAuthority ?? null;
    const train = input.trainingHeader ?? null;
    const cam = input.cameraPose ?? null;
    const globalBytes = input.globalPayload ? GlobalPayloadCodec.encode(input.globalPayload) : null;

    if (fpv) flags |= VNEXT_FRAME_FLAGS.HAS_FPV_AUTHORITY;
    if (train) flags |= VNEXT_FRAME_FLAGS.HAS_TRAINING_HEADER;
    if (cam) flags |= VNEXT_FRAME_FLAGS.HAS_CAMERA_POSE;
    if (globalBytes && globalBytes.byteLength > 0) flags |= VNEXT_FRAME_FLAGS.HAS_GLOBAL_PAYLOAD;

    let totalBytes = HEADER_BYTES;
    if (fpv) totalBytes += FPV_AUTHORITY_BYTES;
    if (train) totalBytes += TRAINING_HEADER_BYTES;
    if (cam) totalBytes += CAMERA_POSE_BYTES;
    if (globalBytes && globalBytes.byteLength > 0) totalBytes += globalBytes.byteLength;

    const buf = new ArrayBuffer(totalBytes);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);

    let offset = 0;
    view.setUint32(offset, VNEXT_CHANNEL1_SCHEMA_HASH >>> 0, false);
    offset += 4;
    view.setUint32(offset, input.txSeq >>> 0, false);
    offset += 4;
    view.setUint32(offset, input.metadataHash >>> 0, false);
    offset += 4;
    view.setUint8(offset++, indexOfOrZero(ACTIVITY_MODES, input.activityMode));
    view.setUint8(offset++, indexOfOrZero(PLAYBACK_STATES, input.playbackState));
    view.setUint8(offset++, indexOfOrZero(FRAME_PHASES, input.phase));
    view.setUint16(offset, flags & 0xffff, false);
    offset += 2;
    view.setUint32(offset, (input.simTick ?? 0) >>> 0, false);
    offset += 4;
    view.setUint32(offset, (input.replayFrameIndex ?? 0) >>> 0, false);
    offset += 4;
    view.setUint32(offset, (input.replayTotalFrames ?? 0) >>> 0, false);
    offset += 4;
    view.setFloat32(offset, input.clockSeconds ?? 0, false);
    offset += 4;
    view.setFloat32(offset, input.playbackSpeed ?? 1, false);
    offset += 4;
    view.setUint16(offset, (input.blueScore ?? 0) & 0xffff, false);
    offset += 2;
    view.setUint16(offset, (input.orangeScore ?? 0) & 0xffff, false);
    offset += 2;
    const focused = input.focusedCarIndex;
    view.setInt8(offset++, typeof focused === 'number' && focused >= 0 ? focused : -1);
    view.setUint8(offset++, indexOfOrZero(CAMERA_MODES, input.cameraMode));
    view.setFloat64(offset, input.timestampMs ?? 0, false);
    offset += 8;

    if (fpv) {
      view.setUint32(offset, fpv.authorityEpoch >>> 0, false);
      offset += 4;
      view.setUint8(offset++, fpv.activeInputPeerSlot & 0xff);
      view.setUint8(offset++, indexOfOrZero(FPV_AUTHORITY_MODES, fpv.authorityMode));
    }

    if (train) {
      view.setUint16(offset, train.shotIndex & 0xffff, false);
      offset += 2;
      view.setUint32(offset, train.shotResetSeq >>> 0, false);
      offset += 4;
      view.setFloat32(offset, train.countdownSeconds, false);
      offset += 4;
      view.setFloat32(offset, train.remainingTimeoutSeconds, false);
      offset += 4;
    }

    if (cam) {
      view.setFloat32(offset, cam.eye[0], false);
      view.setFloat32(offset + 4, cam.eye[1], false);
      view.setFloat32(offset + 8, cam.eye[2], false);
      view.setFloat32(offset + 12, cam.target[0], false);
      view.setFloat32(offset + 16, cam.target[1], false);
      view.setFloat32(offset + 20, cam.target[2], false);
      view.setFloat32(offset + 24, cam.fovDeg, false);
      offset += CAMERA_POSE_BYTES;
    }

    if (globalBytes && globalBytes.byteLength > 0) {
      u8.set(globalBytes, offset);
    }

    return u8;
  }

  static decode(
    input: ArrayBuffer | Uint8Array | DataView | null | undefined
  ): DecodedVNextWorldFrame {
    if (!input) {
      throw new Error('[VNextWorldFrameCodec] Empty buffer');
    }
    const view =
      input instanceof DataView
        ? input
        : input instanceof Uint8Array
          ? new DataView(input.buffer, input.byteOffset, input.byteLength)
          : new DataView(input);

    if (view.byteLength < HEADER_BYTES) {
      throw new Error(`[VNextWorldFrameCodec] Truncated frame: ${view.byteLength} < ${HEADER_BYTES}`);
    }

    const schemaHash = view.getUint32(0, false);
    if (schemaHash !== VNEXT_CHANNEL1_SCHEMA_HASH) {
      throw new Error(
        `[VNextWorldFrameCodec] schemaHash mismatch: got ${formatSchemaHashHex(schemaHash)}, expected ${formatSchemaHashHex(VNEXT_CHANNEL1_SCHEMA_HASH)}`
      );
    }

    let offset = 4;
    const txSeq = view.getUint32(offset, false);
    offset += 4;
    const metadataHash = view.getUint32(offset, false);
    offset += 4;
    const activityMode = ACTIVITY_MODES[view.getUint8(offset++)] ?? 'match';
    const playbackState = PLAYBACK_STATES[view.getUint8(offset++)] ?? 'playing';
    const phase = FRAME_PHASES[view.getUint8(offset++)] ?? 'playing';
    const flags = view.getUint16(offset, false);
    offset += 2;
    const simTick = view.getUint32(offset, false);
    offset += 4;
    const replayFrameIndex = view.getUint32(offset, false);
    offset += 4;
    const replayTotalFrames = view.getUint32(offset, false);
    offset += 4;
    const clockSeconds = view.getFloat32(offset, false);
    offset += 4;
    const playbackSpeed = view.getFloat32(offset, false);
    offset += 4;
    const blueScore = view.getUint16(offset, false);
    offset += 2;
    const orangeScore = view.getUint16(offset, false);
    offset += 2;
    const rawFocused = view.getInt8(offset++);
    const focusedCarIndex = rawFocused >= 0 ? rawFocused : null;
    const cameraMode = CAMERA_MODES[view.getUint8(offset++)] ?? 'pov';
    const timestampMs = view.getFloat64(offset, false);
    offset += 8;

    let fpvAuthority: VNextFpvAuthorityHeader | null = null;
    if (flags & VNEXT_FRAME_FLAGS.HAS_FPV_AUTHORITY) {
      const authorityEpoch = view.getUint32(offset, false);
      offset += 4;
      const activeInputPeerSlot = view.getUint8(offset++);
      const authorityMode = FPV_AUTHORITY_MODES[view.getUint8(offset++)] ?? 'host_only';
      fpvAuthority = { authorityEpoch, activeInputPeerSlot, authorityMode };
    }

    let trainingHeader: VNextTrainingFrameHeader | null = null;
    if (flags & VNEXT_FRAME_FLAGS.HAS_TRAINING_HEADER) {
      const shotIndex = view.getUint16(offset, false);
      offset += 2;
      const shotResetSeq = view.getUint32(offset, false);
      offset += 4;
      const countdownSeconds = view.getFloat32(offset, false);
      offset += 4;
      const remainingTimeoutSeconds = view.getFloat32(offset, false);
      offset += 4;
      trainingHeader = { shotIndex, shotResetSeq, countdownSeconds, remainingTimeoutSeconds };
    }

    let cameraPose: VNextCameraPose | null = null;
    if (flags & VNEXT_FRAME_FLAGS.HAS_CAMERA_POSE) {
      cameraPose = {
        eye: [
          view.getFloat32(offset, false),
          view.getFloat32(offset + 4, false),
          view.getFloat32(offset + 8, false),
        ],
        target: [
          view.getFloat32(offset + 12, false),
          view.getFloat32(offset + 16, false),
          view.getFloat32(offset + 20, false),
        ],
        fovDeg: view.getFloat32(offset + 24, false),
      };
      offset += CAMERA_POSE_BYTES;
    }

    const globalPayload =
      flags & VNEXT_FRAME_FLAGS.HAS_GLOBAL_PAYLOAD
        ? GlobalPayloadCodec.decode(view, offset)
        : null;

    return {
      schemaHash,
      txSeq,
      metadataHash,
      activityMode,
      playbackState,
      phase,
      flags,
      simTick,
      replayFrameIndex,
      replayTotalFrames,
      clockSeconds,
      playbackSpeed,
      blueScore,
      orangeScore,
      focusedCarIndex,
      cameraMode,
      timestampMs,
      isOvertime: Boolean(flags & VNEXT_FRAME_FLAGS.IS_OVERTIME),
      ballCam: Boolean(flags & VNEXT_FRAME_FLAGS.BALL_CAM),
      isGoalReplayActive: Boolean(flags & VNEXT_FRAME_FLAGS.IS_GOAL_REPLAY_ACTIVE),
      discontinuity: Boolean(flags & VNEXT_FRAME_FLAGS.DISCONTINUITY),
      isShotLaunched: Boolean(flags & VNEXT_FRAME_FLAGS.IS_SHOT_LAUNCHED),
      fpvAuthority,
      trainingHeader,
      cameraPose,
      globalPayload,
    };
  }
}
