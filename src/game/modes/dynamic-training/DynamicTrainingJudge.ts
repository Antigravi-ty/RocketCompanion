import type { DynamicTrainingCarSpawnVariation } from '../../../ui-core/config/dynamicTrainingPackTypes.ts';
import type { RLRCFrame120Hz } from '../../../replay/rlrc/RLRCReplayTypes.ts';

export type DynamicTrainingOutcome = 'goal' | 'timeout';

export interface DynamicTrainingJudgeResult {
  readonly completed: boolean;
  readonly outcome: DynamicTrainingOutcome | null;
  readonly scoringTeam: 0 | 1 | null;
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
}

const GOAL_Y_THRESHOLD = 5120 + 92.75;

export function evaluateDynamicTrainingOutcome(params: {
  readonly elapsedInterveneSeconds: number;
  readonly timeoutSeconds: number;
  readonly goalState: number;
  readonly ballY: number;
}): DynamicTrainingJudgeResult {
  const { elapsedInterveneSeconds, timeoutSeconds, goalState, ballY } = params;
  const clampedTimeout = Math.max(1, Math.min(60, timeoutSeconds || 10));
  const remainingSeconds = Math.max(0, clampedTimeout - elapsedInterveneSeconds);

  if (goalState === 1 || ballY >= GOAL_Y_THRESHOLD) {
    return {
      completed: true,
      outcome: 'goal',
      scoringTeam: 0,
      elapsedSeconds: elapsedInterveneSeconds,
      remainingSeconds,
    };
  }
  if (goalState === 2 || ballY <= -GOAL_Y_THRESHOLD) {
    return {
      completed: true,
      outcome: 'goal',
      scoringTeam: 1,
      elapsedSeconds: elapsedInterveneSeconds,
      remainingSeconds,
    };
  }
  if (elapsedInterveneSeconds >= clampedTimeout) {
    return {
      completed: true,
      outcome: 'timeout',
      scoringTeam: null,
      elapsedSeconds: elapsedInterveneSeconds,
      remainingSeconds: 0,
    };
  }

  return {
    completed: false,
    outcome: null,
    scoringTeam: null,
    elapsedSeconds: elapsedInterveneSeconds,
    remainingSeconds,
  };
}

export function applyOptionalCarSpawnVariationToFrame(params: {
  readonly frame: RLRCFrame120Hz;
  readonly povSlotIndex: number;
  readonly variation?: DynamicTrainingCarSpawnVariation;
}): RLRCFrame120Hz {
  const { frame, povSlotIndex, variation } = params;
  if (!variation || !variation.enabled) return frame;

  const posJitter = Math.max(0, variation.posJitterUu || 0);
  const yawJitter = Math.max(0, variation.yawJitterRad || 0);
  if (posJitter <= 0 && yawJitter <= 0) return frame;

  const dx = (Math.random() * 2 - 1) * posJitter;
  const dy = (Math.random() * 2 - 1) * posJitter;
  const dYaw = (Math.random() * 2 - 1) * yawJitter;
  const halfYaw = dYaw * 0.5;
  const sinH = Math.sin(halfYaw);
  const cosH = Math.cos(halfYaw);

  const nextCars = frame.cars.map((car) => {
    if (car.slotIndex !== povSlotIndex) return car;
    const q = car.rigidBody.rotation;
    return {
      ...car,
      rigidBody: {
        ...car.rigidBody,
        position: {
          x: car.rigidBody.position.x + dx,
          y: car.rigidBody.position.y + dy,
          z: car.rigidBody.position.z,
        },
        rotation: {
          x: cosH * q.x - sinH * q.y,
          y: cosH * q.y + sinH * q.x,
          z: cosH * q.z + sinH * q.w,
          w: cosH * q.w - sinH * q.z,
        },
      },
    };
  });

  return {
    ...frame,
    cars: nextCars,
  };
}
