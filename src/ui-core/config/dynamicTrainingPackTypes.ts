export type CarTakeoverMode = 'disappear' | 'as-previous' | 'bot';

export type RcdJudgeOutcome = 'goal' | 'timeout';

export const DYNAMIC_SESSION_CAPTURE_TICKS = 480; // 4 seconds @ 120Hz

export interface DynamicSessionCarSnapshot {
  readonly carIndex: number;
  readonly team: 0 | 1;
  readonly pos: readonly [number, number, number];
  readonly vel: readonly [number, number, number];
  readonly rot: readonly [number, number, number];
  readonly angVel: readonly [number, number, number];
  readonly boost: number;
  readonly lastControls: {
    readonly throttle: number;
    readonly steer: number;
    readonly pitch: number;
    readonly yaw: number;
    readonly roll: number;
    readonly jump: boolean;
    readonly boost: boolean;
    readonly handbrake: boolean;
  };
}

export interface DynamicSessionFrame {
  readonly tick: number;
  readonly ballPos: readonly [number, number, number];
  readonly ballVel: readonly [number, number, number];
  readonly ballAngVel: readonly [number, number, number];
  readonly cars: readonly DynamicSessionCarSnapshot[];
}

export interface StateSession {
  readonly id: string;
  name: string;
  readonly sourceTag: 'captured-from-replay';
  readonly sourceReplayName: string;
  readonly interveneTick: number;
  readonly durationTicks: number;
  readonly frames: readonly DynamicSessionFrame[];
  playerCarIndex: number;
  carTakeoverModes: Record<number, CarTakeoverMode>;
  targetGoalTeam: 0 | 1;
  timeoutSeconds: number;
  readonly createdAt: number;
  updatedAt: number;
}

export interface RCDPack {
  readonly id: string;
  name: string;
  description: string;
  sessionIds: string[];
  readonly createdAt: number;
  updatedAt: number;
}
