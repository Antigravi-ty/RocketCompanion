export const CAR_GROUND_MIN_Z = 17.05;
export const BALL_GROUND_MIN_Z = 93.15;
export const ARENA_MAX_X = 3980;
export const ARENA_MAX_Y = 5020;
export const ARENA_MAX_Z = 1950;

export type StaticTrainingEditSubMode =
  | 'car-heading'
  | 'car-speed'
  | 'ball-speed'
  | 'free-cam';

export interface ShotCarConfig {
  location?: [number, number, number];
  pos?: [number, number, number];
  headingYaw: number;
  headingPitch: number;
  airRoll: number;
  speed: number;
  speedYaw?: number;
  speedPitch?: number;
  speedFollowsHeading?: boolean;
  snapToGround?: boolean;
  unlimitedBoost?: boolean;
  initialBoost: number;
  hasFlip?: boolean;
}

export interface ShotBallConfig {
  location?: [number, number, number];
  pos?: [number, number, number];
  speed: number;
  speedYaw: number;
  speedPitch: number;
  startRotationRoll?: number;
  kickoffState?: boolean;
  randomAngularVelocity?: boolean;
  angularVelocity?: [number, number, number];
}

export interface StaticTrainingShotConfig {
  id?: string;
  name?: string;
  timeoutSeconds?: number;
  car: ShotCarConfig;
  ball: ShotBallConfig;
  editorFreeCam?: {
    location: [number, number, number];
    pitch: number;
    yaw: number;
    roll: number;
    isDefaultOverview?: boolean;
  };
}

export interface BallCamTunerParams {
  distance: number;
  height: number;
  angle: number;
  lateralOffset: number;
}

export interface EditorCameraPose {
  position: [number, number, number];
  lookAt: [number, number, number];
  up: [number, number, number];
}

export interface EditorContinuousDeltaInput {
  heldKeys: ReadonlySet<string>;
  subMode: StaticTrainingEditSubMode;
  dt: number;
  camDirX: number;
  camDirZ: number;
}

export interface EditorContinuousDeltas {
  moveX: number;
  moveY: number;
  moveZ: number;
  rollDelta: number;
  boostDelta: number;
  speedDelta: number;
  hasAnyChange: boolean;
}

export function computeEffectiveBallAngVel(
  ball: Partial<ShotBallConfig>
): [number, number, number] {
  if (!ball.randomAngularVelocity && Array.isArray(ball.angularVelocity)) {
    return [
      Number(ball.angularVelocity[0]) || 0,
      Number(ball.angularVelocity[1]) || 0,
      Number(ball.angularVelocity[2]) || 0,
    ];
  }
  const spd = Math.max(0, Number(ball.speed) || 0);
  const mag = Math.min(5.5, Math.max(2.2, (spd / 1200) * 3.2));
  const yaw = Number(ball.speedYaw) || 0;
  const pitch = Number(ball.speedPitch) || 0;
  return [
    Number((Math.sin(yaw * 1.7 + 0.6) * mag * 0.75).toFixed(3)),
    Number((-Math.cos(yaw * 1.3 - 0.4) * mag * 0.85).toFixed(3)),
    Number((Math.sin(pitch + yaw * 0.9) * mag * 0.65).toFixed(3)),
  ];
}

export function computeLaunchVelocity(
  speed: number,
  yaw: number,
  pitch: number
): [number, number, number] {
  const s = Math.max(0, Number(speed) || 0);
  if (s <= 0.001) return [0, 0, 0];
  const cp = Math.cos(pitch);
  return [
    Math.cos(yaw) * cp * s,
    Math.sin(yaw) * cp * s,
    Math.sin(pitch) * s,
  ];
}

export function computeCarLaunchKinematics(
  car: ShotCarConfig,
  currentCarPosZ?: number
): {
  pos: [number, number, number];
  rot: [number, number, number];
  vel: [number, number, number];
  boost: number;
  isOnGround: boolean;
  hasFlipOrJump: boolean;
} {
  const carLoc = car.location || car.pos || [0, -2400, CAR_GROUND_MIN_Z];
  const effSpeedYaw =
    car.speedFollowsHeading !== false ? car.headingYaw : (car.speedYaw ?? car.headingYaw);
  const effSpeedPitch =
    car.speedFollowsHeading !== false
      ? car.snapToGround
        ? 0
        : car.headingPitch
      : (car.speedPitch ?? car.headingPitch);
  const vel = computeLaunchVelocity(car.speed, effSpeedYaw, effSpeedPitch);
  const boost = car.unlimitedBoost
    ? 100
    : Math.max(0, Math.min(100, Number(car.initialBoost) || 0));
  const spawnZ =
    typeof currentCarPosZ === 'number'
      ? currentCarPosZ
      : Math.max(CAR_GROUND_MIN_Z, carLoc[2]);
  const isOnGround = Boolean(car.snapToGround || spawnZ <= CAR_GROUND_MIN_Z + 2);
  const hasFlipOrJump = Boolean(car.snapToGround || car.hasFlip !== false);
  const rot: [number, number, number] = car.snapToGround
    ? [0, car.headingYaw, 0]
    : [car.headingPitch, car.headingYaw, car.airRoll];

  return {
    pos: [carLoc[0], carLoc[1], spawnZ],
    rot,
    vel,
    boost,
    isOnGround,
    hasFlipOrJump,
  };
}

export function computeBallSpinAxisAngle(
  angVel: [number, number, number],
  dt: number
): { axis: [number, number, number]; angle: number } | null {
  const [wx, wy, wz] = angVel;
  const safeDt = Math.min(0.05, dt || 0.016);
  const angSpeed = Math.hypot(wx, wy, wz);
  if (angSpeed <= 1e-4) return null;
  return {
    axis: [wx / angSpeed, wz / angSpeed, wy / angSpeed],
    angle: angSpeed * safeDt,
  };
}

export function computeEditorContinuousDeltas(
  input: EditorContinuousDeltaInput
): EditorContinuousDeltas {
  const { heldKeys, subMode, dt, camDirX, camDirZ } = input;
  const safeDt = Math.min(0.05, dt || 0.016);
  const moveSpeed =
    heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight') ? 1350 : 680;
  const stepDist = moveSpeed * safeDt;

  let camFwdX = 0;
  let camFwdY = 1;
  const len = Math.hypot(camDirX, camDirZ);
  if (len > 1e-4) {
    camFwdX = camDirX / len;
    camFwdY = camDirZ / len;
  }
  const camRightX = -camFwdY;
  const camRightY = camFwdX;

  let moveX = 0;
  let moveY = 0;
  let moveZ = 0;

  if (heldKeys.has('KeyW')) {
    moveX += camFwdX * stepDist;
    moveY += camFwdY * stepDist;
  }
  if (heldKeys.has('KeyS')) {
    moveX -= camFwdX * stepDist;
    moveY -= camFwdY * stepDist;
  }
  if (heldKeys.has('KeyD')) {
    moveX += camRightX * stepDist;
    moveY += camRightY * stepDist;
  }
  if (heldKeys.has('KeyA')) {
    moveX -= camRightX * stepDist;
    moveY -= camRightY * stepDist;
  }
  if (heldKeys.has('Space')) {
    moveZ += stepDist;
  }
  if (heldKeys.has('KeyV')) {
    moveZ -= stepDist;
  }

  let rollDelta = 0;
  if (subMode === 'car-heading') {
    if (heldKeys.has('KeyQ')) rollDelta -= 1.8 * safeDt;
    if (heldKeys.has('KeyE')) rollDelta += 1.8 * safeDt;
  }

  let boostDelta = 0;
  if (subMode === 'car-heading' || subMode === 'car-speed') {
    if (heldKeys.has('KeyO')) boostDelta -= 65 * safeDt;
    if (heldKeys.has('KeyP')) boostDelta += 65 * safeDt;
  }

  let speedDelta = 0;
  if (subMode === 'car-heading' || subMode === 'car-speed' || subMode === 'ball-speed') {
    if (heldKeys.has('BracketLeft')) speedDelta -= 950 * safeDt;
    if (heldKeys.has('BracketRight')) speedDelta += 950 * safeDt;
  }

  const hasAnyChange =
    Math.abs(moveX) >= 1e-4 ||
    Math.abs(moveY) >= 1e-4 ||
    Math.abs(moveZ) >= 1e-4 ||
    Math.abs(rollDelta) >= 1e-4 ||
    Math.abs(boostDelta) >= 1e-4 ||
    Math.abs(speedDelta) >= 1e-4;

  return {
    moveX,
    moveY,
    moveZ,
    rollDelta,
    boostDelta,
    speedDelta,
    hasAnyChange,
  };
}

export interface ShotDraftPatchResult {
  carPatch?: Partial<ShotCarConfig>;
  ballPatch?: Partial<ShotBallConfig>;
  nextBallSpeedZeroLatch: boolean;
}

export interface ShotMouseDragPatchResult {
  carPatch?: Partial<ShotCarConfig>;
  ballPatch?: Partial<ShotBallConfig>;
}

export interface PlayerDrivingControlsInput {
  throttle?: number;
  steer?: number;
  pitch?: number;
  yaw?: number;
  roll?: number;
  jump?: boolean | number;
  boost?: boolean | number;
  handbrake?: boolean | number;
}

export function computeContinuousDeltasShotPatch(
  shot: StaticTrainingShotConfig,
  subMode: StaticTrainingEditSubMode,
  deltas: EditorContinuousDeltas,
  ballSpeedZeroLatch: boolean
): ShotDraftPatchResult {
  let nextLatch = ballSpeedZeroLatch;
  const { moveX, moveY, moveZ, rollDelta, boostDelta, speedDelta } = deltas;

  if (subMode === 'car-heading' || subMode === 'car-speed') {
    const baseLoc = shot.car.location || [0, -2400, CAR_GROUND_MIN_Z];
    const nextX = Math.max(-ARENA_MAX_X, Math.min(ARENA_MAX_X, baseLoc[0] + moveX));
    const nextY = Math.max(-ARENA_MAX_Y, Math.min(ARENA_MAX_Y, baseLoc[1] + moveY));
    let nextZ = baseLoc[2];
    let nextSnapToGround = shot.car.snapToGround;
    if (moveZ > 0) {
      nextSnapToGround = false;
      nextZ = Math.min(ARENA_MAX_Z, baseLoc[2] + moveZ);
    } else if (moveZ < 0) {
      nextZ = Math.max(CAR_GROUND_MIN_Z, baseLoc[2] + moveZ);
    }

    const nextAirRoll =
      rollDelta !== 0 ? Number((shot.car.airRoll + rollDelta).toFixed(4)) : shot.car.airRoll;

    let nextUnlimitedBoost = shot.car.unlimitedBoost;
    let nextInitialBoost = shot.car.initialBoost;
    if (boostDelta !== 0) {
      if (boostDelta < 0 && shot.car.unlimitedBoost) {
        nextUnlimitedBoost = false;
        nextInitialBoost = 100;
      } else if (!shot.car.unlimitedBoost) {
        nextInitialBoost = Math.max(
          0,
          Math.min(100, Number((shot.car.initialBoost + boostDelta).toFixed(2)))
        );
      }
    }

    let nextSpeed = shot.car.speed;
    let nextSpeedYaw = shot.car.speedYaw;
    let nextSpeedPitch = shot.car.speedPitch;
    if (speedDelta !== 0) {
      nextSpeed = Math.max(
        0,
        Math.min(2300, Number((shot.car.speed + speedDelta).toFixed(1)))
      );
      if (shot.car.speedFollowsHeading !== false) {
        nextSpeedYaw = shot.car.headingYaw;
        nextSpeedPitch = nextSnapToGround ? 0 : shot.car.headingPitch;
      }
    }

    return {
      carPatch: {
        location: [nextX, nextY, nextZ],
        snapToGround: nextSnapToGround,
        airRoll: nextAirRoll,
        unlimitedBoost: nextUnlimitedBoost,
        initialBoost: nextInitialBoost,
        speed: nextSpeed,
        speedYaw: nextSpeedYaw,
        speedPitch: nextSpeedPitch,
      },
      nextBallSpeedZeroLatch: nextLatch,
    };
  }

  if (subMode === 'ball-speed') {
    const baseLoc = shot.ball.location || [0, 0, BALL_GROUND_MIN_Z];
    const nextX = Math.max(-ARENA_MAX_X, Math.min(ARENA_MAX_X, baseLoc[0] + moveX));
    const nextY = Math.max(-ARENA_MAX_Y, Math.min(ARENA_MAX_Y, baseLoc[1] + moveY));
    const nextZ =
      moveZ !== 0
        ? Math.max(BALL_GROUND_MIN_Z, Math.min(ARENA_MAX_Z, baseLoc[2] + moveZ))
        : baseLoc[2];

    let nextBallSpeed = shot.ball.speed;
    let nextKickoffState = shot.ball.kickoffState;

    if (speedDelta < 0) {
      if (shot.ball.speed > 0 && !ballSpeedZeroLatch) {
        const computedSpd = Math.max(0, Number((shot.ball.speed + speedDelta).toFixed(1)));
        nextBallSpeed = computedSpd;
        if (computedSpd === 0) {
          nextLatch = true;
        }
      }
    } else if (speedDelta > 0) {
      if (shot.ball.kickoffState) {
        nextKickoffState = false;
        nextBallSpeed = 0;
      } else {
        nextBallSpeed = Math.min(
          4000,
          Number((shot.ball.speed + speedDelta).toFixed(1))
        );
      }
    }

    return {
      ballPatch: {
        location: [nextX, nextY, nextZ],
        speed: nextBallSpeed,
        kickoffState: nextKickoffState,
      },
      nextBallSpeedZeroLatch: nextLatch,
    };
  }

  return { nextBallSpeedZeroLatch: nextLatch };
}

export function computeMouseDragShotPatch(
  shot: StaticTrainingShotConfig,
  subMode: StaticTrainingEditSubMode,
  dx: number,
  dy: number,
  sensitivity = 0.0045
): ShotMouseDragPatchResult {
  const clampPitch = (val: number): number =>
    Number(Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, val)).toFixed(4));

  if (subMode === 'car-heading') {
    const nextHeadingYaw = Number((shot.car.headingYaw + dx * sensitivity).toFixed(4));
    const nextHeadingPitch = shot.car.snapToGround
      ? shot.car.headingPitch
      : clampPitch(shot.car.headingPitch - dy * sensitivity);
    const followsHeading = shot.car.speedFollowsHeading !== false;
    return {
      carPatch: {
        headingYaw: nextHeadingYaw,
        headingPitch: nextHeadingPitch,
        ...(followsHeading
          ? { speedYaw: nextHeadingYaw, speedPitch: shot.car.snapToGround ? 0 : nextHeadingPitch }
          : {}),
      },
    };
  }

  if (subMode === 'car-speed') {
    const curSpeedYaw = Number(shot.car.speedYaw ?? shot.car.headingYaw) || 0;
    const curSpeedPitch = Number(shot.car.speedPitch) || 0;
    return {
      carPatch: {
        speedYaw: Number((curSpeedYaw + dx * sensitivity).toFixed(4)),
        speedPitch: clampPitch(curSpeedPitch - dy * sensitivity),
      },
    };
  }

  if (subMode === 'ball-speed') {
    return {
      ballPatch: {
        speedYaw: Number((shot.ball.speedYaw + dx * sensitivity).toFixed(4)),
        speedPitch: clampPitch(shot.ball.speedPitch - dy * sensitivity),
      },
    };
  }

  return {};
}

export function hasPlayerDrivingInput(controls: PlayerDrivingControlsInput | null | undefined): boolean {
  if (!controls) return false;
  return (
    Math.abs(controls.throttle || 0) > 0.05 ||
    Math.abs(controls.steer || 0) > 0.05 ||
    Math.abs(controls.pitch || 0) > 0.05 ||
    Math.abs(controls.yaw || 0) > 0.05 ||
    Math.abs(controls.roll || 0) > 0.05 ||
    Boolean(controls.jump) ||
    Boolean(controls.boost) ||
    Boolean(controls.handbrake)
  );
}
