/**
 * src/network/protocol/RoomActivityProtocol.ts
 * Protocol types, mode bitflags, and compact binary codecs for hot-swappable
 * room activities, spectator timeline lockstep, intervene handoff, and CSR follow-host.
 */

export type RoomActivityId = 'freeplay' | 'match' | 'replay_intervene' | 'sandbox';

export const ACTIVITY_MODE_FLAGS = Object.freeze({
  NONE: 0,
  SKIP_SCORE_CLOCK: 1 << 0,
  SKIP_TELESTRATOR: 1 << 1,
  CSR_FOLLOW_HOST: 1 << 2,
  SPARSE_FREEZE_MODE: 1 << 3,
  TRAINING_RULESET: 1 << 4,
});

export type SpectatorPlayState = 'playing' | 'paused' | 'scrubbing';

export type InterveneNonPovPolicy = 'disappear' | 'no-input' | 'follow-state' | 'bot-takeover';

export type InterveneHandoffPhase = 'idle' | 'authorized' | 'countdown' | 'active';

export interface RoomActivitySwitchPayload {
  activityId: RoomActivityId;
  seed?: number;
  authorityMask?: number;
  modeFlags?: number;
  unlimitedBoost?: boolean;
  disableGoalReset?: boolean;
  ghostCars?: boolean;
  durationSeconds?: number;
  customPayload?: Record<string, unknown> | null;
}

export interface RoomActivityStateSummary {
  activityId: RoomActivityId;
  modeFlags: number;
  switchSeq: number;
  authorityMask: number;
  sparsePingActive: boolean;
  customPayload: Record<string, unknown> | null;
}

export interface SpectatorTimelineCommand {
  action: 'play' | 'pause' | 'seek' | 'set_rate' | 'step_frame';
  cursorTick?: number;
  playRate?: number;
  totalTicks?: number;
}

export interface SpectatorTimelineState {
  playState: SpectatorPlayState;
  cursorTick: number;
  totalTicks: number;
  playRate: number;
  sparsePingActive: boolean;
  lastUpdatedAtMs: number;
}

export interface InterveneAuthorizationRequest {
  action: 'authorize' | 'begin_countdown' | 'cancel' | 'complete';
  authorizedSessionId?: string;
  targetCarIndex?: number;
  nonPovPolicy?: InterveneNonPovPolicy;
  countdownSeconds?: number;
  cursorTick?: number;
}

export interface InterveneHandoffState {
  phase: InterveneHandoffPhase;
  authorizedSessionId: string | null;
  targetCarIndex: number;
  nonPovPolicy: InterveneNonPovPolicy;
  countdownSeconds: number;
  countdownRemainingTicks: number;
  countdownStepLabel: '4' | '3' | '2' | '1' | '0' | 'idle';
  targetResumeTick: number;
}

export interface CsrFollowHostPayload {
  enabled: boolean;
  hostActivityId: RoomActivityId;
  hostCameraMode: string;
  hostFocusCarIndex: number;
  hostTick: number;
  frameStepMode: boolean;
}

const ACTIVITY_ID_TO_CODE: Readonly<Record<RoomActivityId, number>> = {
  freeplay: 0,
  match: 1,
  replay_intervene: 2,
  sandbox: 3,
};

const CODE_TO_ACTIVITY_ID: Readonly<Record<number, RoomActivityId>> = {
  0: 'freeplay',
  1: 'match',
  2: 'replay_intervene',
  3: 'sandbox',
};

const CAMERA_MODE_TO_CODE: Readonly<Record<string, number>> = {
  ball: 0,
  car: 1,
  free: 2,
  director: 3,
};

const CODE_TO_CAMERA_MODE: Readonly<Record<number, string>> = {
  0: 'ball',
  1: 'car',
  2: 'free',
  3: 'director',
};

export function encodeCsrFollowHostPacket(payload: CsrFollowHostPayload): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  const flags = (payload.enabled ? 1 : 0) | (payload.frameStepMode ? 2 : 0);
  view.setUint8(0, flags);
  view.setUint8(1, ACTIVITY_ID_TO_CODE[payload.hostActivityId] ?? 0);
  view.setUint8(2, CAMERA_MODE_TO_CODE[payload.hostCameraMode] ?? 0);
  view.setInt8(3, payload.hostFocusCarIndex);
  view.setUint32(4, payload.hostTick >>> 0, true);
  return buf;
}

export function decodeCsrFollowHostPacket(bytes: Uint8Array): CsrFollowHostPayload {
  if (bytes.byteLength < 8) {
    return {
      enabled: false,
      hostActivityId: 'freeplay',
      hostCameraMode: 'ball',
      hostFocusCarIndex: 0,
      hostTick: 0,
      frameStepMode: false,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(0);
  const activityCode = view.getUint8(1);
  const camCode = view.getUint8(2);
  const focusCar = view.getInt8(3);
  const hostTick = view.getUint32(4, true);
  return {
    enabled: (flags & 1) !== 0,
    frameStepMode: (flags & 2) !== 0,
    hostActivityId: CODE_TO_ACTIVITY_ID[activityCode] ?? 'freeplay',
    hostCameraMode: CODE_TO_CAMERA_MODE[camCode] ?? 'ball',
    hostFocusCarIndex: focusCar,
    hostTick,
  };
}
