import type { CarControlsInput } from './GlobalPayloadCodec.ts';

export type RosterCarRoleFlag = 'player' | 'bot' | 'ghost';

export type TrainingPackKind = 'static' | 'dynamic' | 'kickoff';

export type TrainingPackPhase =
  'idle' | 'preroll_countdown' | 'ready' | 'playing' | 'goal_scored' | 'result' | 'replay';

export type TrainingBoostPolicyKind = 'limited' | 'limit_when_aerial' | 'unlimited' | 'custom';

export interface TrainingGhostCarReservation {
  carIndex: number;
  roleFlag: 'ghost';
  ghostKind: 'static_trajectory' | 'live_sparring';
  interactWithBall: false;
  interactWithCars: false;
  opacity: number;
  visualId: string;
  team: 0 | 1;
  trajectoryHash?: string;
}

export interface GhostTrajectorySample {
  tick: number;
  pos: [number, number, number];
  rot: [number, number, number];
  vel: [number, number, number];
  boost: number;
  isSupersonic?: boolean;
}

export interface GhostTrajectoryManifest {
  trajectoryId: string;
  trajectoryHash: string;
  carVisualId: string;
  totalTicks: number;
  tickRateHz: number;
  frames: GhostTrajectorySample[];
}

export interface TrainingPackVNextMetadata {
  trainingKind: TrainingPackKind;
  packId: string;
  packName: string;
  shotIndex: number;
  totalShots: number;
  shotName: string;
  shotResetSeq: number;
  boostPolicy: TrainingBoostPolicyKind;
  perCarBoostPolicies?: Record<number, Exclude<TrainingBoostPolicyKind, 'custom'>>;
  ghostModeEnabled: boolean;
  ghostReservations: TrainingGhostCarReservation[];
  ghostTrajectoryHash?: string;
}

export interface TrainingPackVNextFrameHeader {
  trainingPhase: TrainingPackPhase;
  shotIndex: number;
  shotResetSeq: number;
  countdownSeconds: number;
  remainingTimeoutSeconds: number;
  isShotLaunched: boolean;
}

export interface FpvDualAuthorityState {
  authorityEpoch: number;
  activeInputPeerId: string;
  authorityMode: 'host_only' | 'client_only' | 'fpv_master_slave';
  clientInputEnabled: boolean;
  handoverThresholdMs: number;
}

export interface StudentInputProbePayload {
  type: 'student_input_probe';
  peerId: string;
  authorityEpoch: number;
  hasActiveInput: boolean;
  controls?: CarControlsInput;
  clientTimestampMs: number;
}

export const TRAINING_FPV_DUAL_FIELD_MANIFEST = Object.freeze({
  branch: 'feat/mode-training-fpv-dual',
  wave: 'W1-06',
  channel1StateFrameFields: [
    'authorityEpoch: uint32 (FPV Coach-Student fencing epoch)',
    'activeInputPeerIdIndex: uint8 (0 = host/coach, 1..N = student session slot)',
    'authorityMode: uint8 (0=host_only, 1=client_only, 2=fpv_master_slave)',
    'trainingPhase: uint8 (idle/preroll_countdown/ready/playing/goal_scored/result/replay)',
    'shotIndex: uint16',
    'shotResetSeq: uint32',
    'countdownSeconds: float32',
    'remainingTimeoutSeconds: float32',
    'isShotLaunched: bitflag',
  ],
  channel2MetadataManifestFields: [
    'RosterManifestEntry.roleFlag: uint8 (0=player, 1=bot, 2=ghost)',
    'RosterManifestEntry.ghostOpacity: float32 (when roleFlag=ghost)',
    'trainingKind: uint8 (static/dynamic/kickoff)',
    'packId: string',
    'packName: string',
    'shotName: string',
    'totalShots: uint16',
    'boostPolicy: uint8 + perCarBoostPolicies',
    'ghostModeEnabled: boolean',
    'ghostTrajectoryHash: uint32 HEX (references Channel 2/4 GhostTrajectoryManifest)',
  ],
  channel3SignalEvents: [
    'TRAINING_SHOT_RESET (param1=shotIndex, param2=shotResetSeq)',
    'TRAINING_COUNTDOWN_TICK (param1=remainingSeconds)',
    'TRAINING_OUTCOME_SETTLED (param1=outcomeCode, param2=shotIndex)',
    'FPV_AUTHORITY_PREEMPTED (param1=authorityEpoch, param2=activePeerSlot)',
  ],
  channel4BulkAssets: [
    'GhostTrajectoryManifest (static recorded ghost car tick-indexed frames)',
    'DynamicTrainingStateSession slice (RLRC frames for Dynamic Training Pack)',
  ],
} as const);
