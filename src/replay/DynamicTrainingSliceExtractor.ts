import {
  DYNAMIC_TRAINING_PREROLL_FRAMES,
  generateDynamicUuid,
  type DynamicTrainingCompactCarFrame,
  type DynamicTrainingCompactFrame,
  type DynamicTrainingRosterSlot,
  type DynamicTrainingStateSession,
} from '../ui-core/config/dynamicTrainingPackTypes.ts';
import type {
  RLRCFrame120Hz,
  RLRCHitboxId,
  RLRCPlayerSlotMeta,
  RLRCTeamIndex,
  RLRCVisualId,
} from './rlrc/RLRCReplayTypes.ts';

function toCompactCar(car: RLRCFrame120Hz['cars'][number]): DynamicTrainingCompactCarFrame {
  const rb = car.rigidBody;
  const f = car.activeFlags;
  const c = car.controls;
  return {
    slotIndex: car.slotIndex,
    entityActive: car.entityActive,
    ...(car.isDemolished ? { isDemolished: true } : {}),
    pos: [rb.position.x, rb.position.y, rb.position.z],
    rot: [rb.rotation.x, rb.rotation.y, rb.rotation.z, rb.rotation.w],
    vel: [rb.linearVelocity.x, rb.linearVelocity.y, rb.linearVelocity.z],
    angVel: [rb.angularVelocity.x, rb.angularVelocity.y, rb.angularVelocity.z],
    boostAmount: car.boostAmount,
    isOnGround: car.isOnGround,
    isSupersonic: car.isSupersonic,
    hasFlipOrJump: car.hasFlipOrJump,
    airTimeSinceJump: car.airTimeSinceJump,
    activeFlags: [f.boostActive, f.jumpActive, f.doubleJumpActive, f.dodgeActive],
    controls: [c.throttle, c.steer, c.pitch, c.yaw, c.roll, c.jump, c.boost, c.handbrake],
  };
}

function toCompactFrame(frame: RLRCFrame120Hz, localIndex: number): DynamicTrainingCompactFrame {
  const b = frame.ball.rigidBody;
  return {
    frameIndex: localIndex,
    timeSeconds: frame.timeSeconds,
    ballPos: [b.position.x, b.position.y, b.position.z],
    ballRot: [b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w],
    ballVel: [b.linearVelocity.x, b.linearVelocity.y, b.linearVelocity.z],
    ballAngVel: [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z],
    cars: frame.cars.map(toCompactCar),
    boostPadCooldowns: Array.from(frame.boostPadCooldowns ?? []),
  };
}

export function extractDynamicSessionFromRLRCFrames(params: {
  readonly frames120Hz: readonly RLRCFrame120Hz[];
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly targetFrame120Hz: number;
  readonly povSlotIndex: number;
  readonly sourceReplayName: string;
  readonly prerollFrames?: number;
  readonly title?: string;
}): DynamicTrainingStateSession | null {
  const { frames120Hz, roster, targetFrame120Hz, povSlotIndex, sourceReplayName } = params;
  if (!frames120Hz || frames120Hz.length === 0) return null;

  const maxIdx = frames120Hz.length - 1;
  const clampedTarget = Math.max(0, Math.min(maxIdx, Math.round(targetFrame120Hz)));
  const count = Math.max(1, params.prerollFrames ?? DYNAMIC_TRAINING_PREROLL_FRAMES);
  const startIdx = Math.max(0, clampedTarget - count + 1);
  const slice = frames120Hz.slice(startIdx, clampedTarget + 1);
  const now = Date.now();

  const compactRoster: DynamicTrainingRosterSlot[] = roster.map((r) => ({
    slotIndex: r.slotIndex,
    userName: r.userName,
    team: r.team,
    hitboxId: r.hitboxId,
    visualId: r.visualId,
    ...(r.primaryColorHex ? { primaryColorHex: r.primaryColorHex } : {}),
    ...(r.accentColorHex ? { accentColorHex: r.accentColorHex } : {}),
  }));

  const frames = slice.map((f, idx) => toCompactFrame(f, idx));
  const durationSeconds = Number((frames.length / 120).toFixed(2));
  const timeSec = (clampedTarget / 120).toFixed(1);

  return {
    sessionId: generateDynamicUuid(),
    title: params.title?.trim() || `${sourceReplayName} @ ${timeSec}s`,
    createdAt: now,
    updatedAt: now,
    sourceKind: 'replay-capture',
    sourceReplayName,
    sourceFrame120Hz: clampedTarget,
    prerollStartFrame120Hz: startIdx,
    durationSeconds,
    tickRate: 120,
    defaultPovSlotIndex: povSlotIndex,
    roster: compactRoster,
    frames,
  };
}

export function hydrateRLRCFramesFromDynamicSession(session: DynamicTrainingStateSession): {
  frames120Hz: RLRCFrame120Hz[];
  roster: RLRCPlayerSlotMeta[];
} {
  const roster: RLRCPlayerSlotMeta[] = session.roster.map((r) => ({
    slotIndex: r.slotIndex,
    userName: r.userName,
    team: r.team as RLRCTeamIndex,
    priActorId: r.slotIndex + 1,
    bodyProductId: 23,
    hitboxId: (r.hitboxId || 'hitbox-octane') as RLRCHitboxId,
    visualId: (r.visualId || 'fennec') as RLRCVisualId,
    ...(r.primaryColorHex ? { primaryColorHex: r.primaryColorHex } : {}),
    ...(r.accentColorHex ? { accentColorHex: r.accentColorHex } : {}),
  }));

  const frames120Hz: RLRCFrame120Hz[] = session.frames.map((cf, idx) => ({
    frameIndex120Hz: idx,
    sourceFrame30Hz: Math.floor(idx / 4),
    timeSeconds: cf.timeSeconds,
    secondsRemaining: 300,
    isOvertime: false,
    roundCountdownNumber: 0,
    blueScore: 0,
    orangeScore: 0,
    ball: {
      entityActive: true,
      rigidBody: {
        sleeping: false,
        position: { x: cf.ballPos[0], y: cf.ballPos[1], z: cf.ballPos[2] },
        rotation: { x: cf.ballRot[0], y: cf.ballRot[1], z: cf.ballRot[2], w: cf.ballRot[3] },
        linearVelocity: { x: cf.ballVel[0], y: cf.ballVel[1], z: cf.ballVel[2] },
        angularVelocity: { x: cf.ballAngVel[0], y: cf.ballAngVel[1], z: cf.ballAngVel[2] },
      },
    },
    cars: cf.cars.map((car) => ({
      slotIndex: car.slotIndex,
      entityActive: car.entityActive,
      ...(car.isDemolished ? { isDemolished: true } : {}),
      rigidBody: {
        sleeping: false,
        position: { x: car.pos[0], y: car.pos[1], z: car.pos[2] },
        rotation: { x: car.rot[0], y: car.rot[1], z: car.rot[2], w: car.rot[3] },
        linearVelocity: { x: car.vel[0], y: car.vel[1], z: car.vel[2] },
        angularVelocity: { x: car.angVel[0], y: car.angVel[1], z: car.angVel[2] },
      },
      boostAmount: car.boostAmount,
      isOnGround: car.isOnGround,
      isSupersonic: car.isSupersonic,
      hasFlipOrJump: car.hasFlipOrJump,
      airTimeSinceJump: car.airTimeSinceJump,
      activeFlags: {
        boostActive: car.activeFlags[0],
        jumpActive: car.activeFlags[1],
        doubleJumpActive: car.activeFlags[2],
        dodgeActive: car.activeFlags[3],
      },
      controls: {
        throttle: car.controls[0],
        steer: car.controls[1],
        pitch: car.controls[2],
        yaw: car.controls[3],
        roll: car.controls[4],
        jump: car.controls[5],
        boost: car.controls[6],
        handbrake: car.controls[7],
      },
    })),
    boostPadCooldowns: Float32Array.from(cf.boostPadCooldowns),
  }));

  return { frames120Hz, roster };
}
