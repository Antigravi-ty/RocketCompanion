import {
  DYNAMIC_SESSION_CAPTURE_TICKS,
  type CarTakeoverMode,
  type DynamicSessionFrame,
  type RcdJudgeOutcome,
  type StateSession,
} from '../../ui-core/config/dynamicTrainingPackTypes.ts';

const GOAL_LINE_Z = 5120;

export function captureSessionFromReplay(
  replayFrames: readonly DynamicSessionFrame[],
  interveneTick: number,
  sourceReplayName: string,
  playerCarIndex = 0
): StateSession {
  const startTick = Math.max(0, interveneTick - DYNAMIC_SESSION_CAPTURE_TICKS);
  const captured = replayFrames.filter((f) => f.tick >= startTick && f.tick <= interveneTick);
  const frames =
    captured.length > 0 ? captured : replayFrames.slice(-DYNAMIC_SESSION_CAPTURE_TICKS);

  const takeoverModes: Record<number, CarTakeoverMode> = {};
  const sampleCars = frames[frames.length - 1]?.cars ?? [];
  for (const c of sampleCars) {
    if (c.carIndex !== playerCarIndex) {
      takeoverModes[c.carIndex] = 'as-previous';
    }
  }

  const now = Date.now();
  return {
    id: `rcd-session-${now}-${Math.random().toString(36).slice(2, 7)}`,
    name: `${sourceReplayName || 'Replay'} @ ${interveneTick}`,
    sourceTag: 'captured-from-replay',
    sourceReplayName: sourceReplayName || 'Unknown Replay',
    interveneTick,
    durationTicks: frames.length,
    frames,
    playerCarIndex,
    carTakeoverModes: takeoverModes,
    targetGoalTeam: 0,
    timeoutSeconds: 10,
    createdAt: now,
    updatedAt: now,
  };
}

export function evaluateDynamicTrainingJudge(
  ballZ: number,
  targetGoalTeam: 0 | 1,
  elapsedAfterTakeoverSec: number,
  timeoutSeconds: number
): RcdJudgeOutcome | null {
  if (targetGoalTeam === 0 && ballZ >= GOAL_LINE_Z) return 'goal';
  if (targetGoalTeam === 1 && ballZ <= -GOAL_LINE_Z) return 'goal';
  if (elapsedAfterTakeoverSec >= timeoutSeconds) return 'timeout';
  return null;
}

export interface DynamicTrainingPhysicsPort {
  setBallState(
    pos: readonly [number, number, number],
    vel: readonly [number, number, number],
    angVel: readonly [number, number, number]
  ): void;
  setCarState(
    carIndex: number,
    pos: readonly [number, number, number],
    vel: readonly [number, number, number],
    rot: readonly [number, number, number],
    angVel: readonly [number, number, number],
    boost: number
  ): void;
  parkCarOutOfPlay(carIndex: number): void;
  setCarControls(
    carIndex: number,
    controls: DynamicSessionFrame['cars'][number]['lastControls']
  ): void;
  enableBotForCar(carIndex: number): void;
}

export interface DynamicTrainingCallbacks {
  onCountdownUpdate?: (remainingSec: number) => void;
  onJudgeOutcome?: (outcome: RcdJudgeOutcome | null) => void;
}

export class DynamicTrainingMode {
  private activeSession: StateSession | null = null;
  private countdownCursor = 0;
  private isTakenOver = false;
  private postTakeoverElapsedSec = 0;
  private lastRecordedFrame: DynamicSessionFrame | null = null;
  private callbacks: DynamicTrainingCallbacks;

  constructor(callbacks: DynamicTrainingCallbacks = {}) {
    this.callbacks = callbacks;
  }

  public startSession(session: StateSession): void {
    this.activeSession = session;
    this.countdownCursor = 0;
    this.isTakenOver = false;
    this.postTakeoverElapsedSec = 0;
    this.lastRecordedFrame = session.frames[session.frames.length - 1] ?? null;
    this.callbacks.onJudgeOutcome?.(null);
    this.callbacks.onCountdownUpdate?.(session.frames.length / 120);
  }

  public stepTick(
    dtSec: number,
    ballZ: number,
    physicsPort: DynamicTrainingPhysicsPort
  ): RcdJudgeOutcome | null {
    const session = this.activeSession;
    if (!session) return null;

    if (!this.isTakenOver) {
      const frame = session.frames[this.countdownCursor];
      if (frame) {
        physicsPort.setBallState(frame.ballPos, frame.ballVel, frame.ballAngVel);
        for (const car of frame.cars) {
          physicsPort.setCarState(car.carIndex, car.pos, car.vel, car.rot, car.angVel, car.boost);
          physicsPort.setCarControls(car.carIndex, car.lastControls);
        }
        this.countdownCursor += 1;
        const remaining = Math.max(0, (session.frames.length - this.countdownCursor) / 120);
        this.callbacks.onCountdownUpdate?.(remaining);
        return null;
      }

      // Exact takeover instant: apply per-car takeover modes
      this.isTakenOver = true;
      this.callbacks.onCountdownUpdate?.(0);
      this.applyTakeoverInstant(session, physicsPort);
      return null;
    }

    // Keep 'as-previous' cars holding their last recorded controls after takeover
    if (this.lastRecordedFrame) {
      for (const car of this.lastRecordedFrame.cars) {
        if (car.carIndex === session.playerCarIndex) continue;
        if (session.carTakeoverModes[car.carIndex] === 'as-previous') {
          physicsPort.setCarControls(car.carIndex, car.lastControls);
        }
      }
    }

    this.postTakeoverElapsedSec += dtSec;
    const outcome = evaluateDynamicTrainingJudge(
      ballZ,
      session.targetGoalTeam,
      this.postTakeoverElapsedSec,
      session.timeoutSeconds
    );
    if (outcome) {
      this.callbacks.onJudgeOutcome?.(outcome);
      this.activeSession = null;
    }
    return outcome;
  }

  private applyTakeoverInstant(
    session: StateSession,
    physicsPort: DynamicTrainingPhysicsPort
  ): void {
    const lastFrame = this.lastRecordedFrame;
    if (!lastFrame) return;
    for (const car of lastFrame.cars) {
      if (car.carIndex === session.playerCarIndex) continue;
      const mode: CarTakeoverMode = session.carTakeoverModes[car.carIndex] ?? 'as-previous';
      if (mode === 'disappear') {
        physicsPort.parkCarOutOfPlay(car.carIndex);
      } else if (mode === 'bot') {
        physicsPort.enableBotForCar(car.carIndex);
      } else {
        physicsPort.setCarControls(car.carIndex, car.lastControls);
      }
    }
  }

  public stop(): void {
    this.activeSession = null;
    this.isTakenOver = false;
  }
}
