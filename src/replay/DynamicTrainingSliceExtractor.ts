import {
  SIM_OFFSETS,
  BALL_STATE_OFFSETS,
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_OFFSETS,
  EXTENDED_STATE_OFFSETS,
  NUM_BOOST_PADS,
} from '../physics/RocketSimConstants.ts';
import type { ReplayAnnotatedFloat32Frame } from './replayDataPayloadPipeline.ts';
import type { ReplayRosterEntry } from './ReplayViewerRosterResolver.ts';
import {
  DYNAMIC_TRAINING_PREROLL_FRAMES,
  generateDynamicUuid,
  type DynamicTrainingCompactCarFrame,
  type DynamicTrainingCompactFrame,
  type DynamicTrainingRosterSlot,
  type DynamicTrainingStateSession,
} from '../ui-core/config/dynamicTrainingPackTypes.ts';
import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCHitboxId,
  type RLRCPlayerSlotMeta,
  type RLRCTeamIndex,
  type RLRCVisualId,
} from './rlrc/RLRCReplayTypes.ts';

function basisAxesToQuat(
  fx: number,
  fy: number,
  fz: number,
  rx: number,
  ry: number,
  rz: number,
  ux: number,
  uy: number,
  uz: number
): [number, number, number, number] {
  const trace = fx + ry + uz;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return [(rz - uy) * s, (ux - fz) * s, (fy - rx) * s, 0.25 / s];
  }
  if (fx > ry && fx > uz) {
    const s = 2.0 * Math.sqrt(Math.max(1e-8, 1.0 + fx - ry - uz));
    return [0.25 * s, (rx + fy) / s, (ux + fz) / s, (rz - uy) / s];
  }
  if (ry > uz) {
    const s = 2.0 * Math.sqrt(Math.max(1e-8, 1.0 + ry - fx - uz));
    return [(rx + fy) / s, 0.25 * s, (uy + rz) / s, (ux - fz) / s];
  }
  const s = 2.0 * Math.sqrt(Math.max(1e-8, 1.0 + uz - fx - ry));
  return [(ux + fz) / s, (uy + rz) / s, 0.25 * s, (fy - rx) / s];
}

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
  const sortedCars = [...frame.cars].sort((a, c) => a.slotIndex - c.slotIndex);
  return {
    frameIndex: localIndex,
    timeSeconds: frame.timeSeconds,
    ballPos: [b.position.x, b.position.y, b.position.z],
    ballRot: [b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w],
    ballVel: [b.linearVelocity.x, b.linearVelocity.y, b.linearVelocity.z],
    ballAngVel: [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z],
    cars: sortedCars.map(toCompactCar),
    boostPadCooldowns: Array.from(frame.boostPadCooldowns ?? []),
  };
}

export function extractDynamicSessionFromRLRCFrames(params: {
  readonly frames120Hz: readonly RLRCFrame120Hz[];
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly targetFrame120Hz: number;
  readonly originEndFrame120Hz?: number;
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
  const endIdx =
    params.originEndFrame120Hz !== undefined
      ? Math.max(clampedTarget, Math.min(maxIdx, Math.round(params.originEndFrame120Hz)))
      : Math.min(maxIdx, clampedTarget + count);
  const slice = frames120Hz.slice(startIdx, endIdx + 1);
  const now = Date.now();

  const compactRoster: DynamicTrainingRosterSlot[] = [...roster]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((r) => ({
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
    originEndFrame120Hz: endIdx,
    interveneLocalFrameIndex: clampedTarget - startIdx,
    durationSeconds,
    tickRate: 120,
    defaultPovSlotIndex: povSlotIndex,
    roster: compactRoster,
    frames,
  };
}

function createInactiveHydratedCar(slotIndex: number): RLRCCarFrameState120Hz {
  return {
    slotIndex,
    entityActive: false,
    rigidBody: {
      sleeping: true,
      position: { x: 0, y: 0, z: -2000 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    },
    boostAmount: 0,
    isOnGround: false,
    isSupersonic: false,
    hasFlipOrJump: false,
    airTimeSinceJump: 0,
    activeFlags: {
      boostActive: false,
      jumpActive: false,
      doubleJumpActive: false,
      dodgeActive: false,
    },
    controls: {
      throttle: 0,
      steer: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jump: false,
      boost: false,
      handbrake: false,
    },
  };
}

export function hydrateRLRCFramesFromDynamicSession(session: DynamicTrainingStateSession): {
  frames120Hz: RLRCFrame120Hz[];
  roster: RLRCPlayerSlotMeta[];
} {
  const roster: RLRCPlayerSlotMeta[] = [...session.roster]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((r) => ({
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

  const frames120Hz: RLRCFrame120Hz[] = session.frames.map((cf, idx) => {
    const bySlot = new Map<number, DynamicTrainingCompactCarFrame>();
    for (const car of cf.cars) {
      bySlot.set(car.slotIndex, car);
    }
    const maxSlot = Math.max(
      RLRC_MAX_PLAYER_SLOTS - 1,
      ...cf.cars.map((c) => c.slotIndex),
      ...roster.map((r) => r.slotIndex)
    );
    const slotCars: RLRCCarFrameState120Hz[] = Array.from({ length: maxSlot + 1 }, (_, slot) => {
      const car = bySlot.get(slot);
      if (!car) return createInactiveHydratedCar(slot);
      return {
        slotIndex: slot,
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
      };
    });

    return {
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
      cars: slotCars,
      boostPadCooldowns: Float32Array.from(cf.boostPadCooldowns),
    };
  });

  return { frames120Hz, roster };
}

export function extractDynamicSessionFromReplayFrames(params: {
  readonly frames: readonly ReplayAnnotatedFloat32Frame[];
  readonly roster: readonly ReplayRosterEntry[];
  readonly targetFrameIndex: number;
  readonly originEndFrameIndex?: number;
  readonly povCarIndex: number;
  readonly sourceReplayName: string;
  readonly prerollFrames?: number;
  readonly title?: string;
}): DynamicTrainingStateSession | null {
  const { frames, roster, targetFrameIndex, povCarIndex, sourceReplayName } = params;
  if (!frames || frames.length === 0) return null;

  const maxIdx = frames.length - 1;
  const clampedTarget = Math.max(0, Math.min(maxIdx, Math.round(targetFrameIndex)));
  const count = Math.max(1, params.prerollFrames ?? DYNAMIC_TRAINING_PREROLL_FRAMES);
  const startIdx = Math.max(0, clampedTarget - count + 1);
  const endIdx =
    params.originEndFrameIndex !== undefined
      ? Math.max(clampedTarget, Math.min(maxIdx, Math.round(params.originEndFrameIndex)))
      : Math.min(maxIdx, clampedTarget + count);
  const slice = frames.slice(startIdx, endIdx + 1);
  const now = Date.now();

  const carCount = Math.max(
    roster.length,
    Math.min(8, Math.round(Number(slice[0]?.[SIM_OFFSETS.NUM_CARS] ?? 0)))
  );
  const rawRoster: DynamicTrainingRosterSlot[] =
    roster.length > 0
      ? roster.map((r) => ({
          slotIndex: r.carIndex,
          userName: r.name || `Car ${r.carIndex + 1}`,
          team: r.team === 1 ? 1 : 0,
          hitboxId: r.hitboxId || 'hitbox-octane',
          visualId: r.visualId || 'fennec',
          ...(r.colorHex ? { primaryColorHex: r.colorHex } : {}),
        }))
      : Array.from({ length: carCount }, (_, idx) => ({
          slotIndex: idx,
          userName: `Car ${idx + 1}`,
          team: idx < Math.ceil(carCount / 2) ? (0 as const) : (1 as const),
          hitboxId: 'hitbox-octane',
          visualId: 'fennec',
        }));
  const compactRoster = [...rawRoster].sort((a, b) => a.slotIndex - b.slotIndex);

  const compactFrames: DynamicTrainingCompactFrame[] = slice.map((f, localIdx) => {
    const b = SIM_OFFSETS.BALL;
    const ballPos: [number, number, number] = [
      f[b + BALL_STATE_OFFSETS.POS] || 0,
      f[b + BALL_STATE_OFFSETS.POS + 1] || 0,
      f[b + BALL_STATE_OFFSETS.POS + 2] || 93.15,
    ];
    const ballRot = basisAxesToQuat(
      f[b + BALL_STATE_OFFSETS.FWD] ?? 1,
      f[b + BALL_STATE_OFFSETS.FWD + 1] ?? 0,
      f[b + BALL_STATE_OFFSETS.FWD + 2] ?? 0,
      f[b + BALL_STATE_OFFSETS.RIGHT] ?? 0,
      f[b + BALL_STATE_OFFSETS.RIGHT + 1] ?? 1,
      f[b + BALL_STATE_OFFSETS.RIGHT + 2] ?? 0,
      f[b + BALL_STATE_OFFSETS.UP] ?? 0,
      f[b + BALL_STATE_OFFSETS.UP + 1] ?? 0,
      f[b + BALL_STATE_OFFSETS.UP + 2] ?? 1
    );
    const ballVel: [number, number, number] = [
      f[b + BALL_STATE_OFFSETS.VEL] || 0,
      f[b + BALL_STATE_OFFSETS.VEL + 1] || 0,
      f[b + BALL_STATE_OFFSETS.VEL + 2] || 0,
    ];
    const ballAngVel: [number, number, number] = [
      f[b + BALL_STATE_OFFSETS.ANG_VEL] || 0,
      f[b + BALL_STATE_OFFSETS.ANG_VEL + 1] || 0,
      f[b + BALL_STATE_OFFSETS.ANG_VEL + 2] || 0,
    ];

    const cars: DynamicTrainingCompactCarFrame[] = compactRoster.map((r) => {
      const slot = r.slotIndex;
      const cBase = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE;
      const extBase =
        EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_BASE +
        slot * EXTENDED_STATE_OFFSETS.CAR_JUMP_AIR_STRIDE;
      const isDemo = Number(f[cBase + CAR_STATE_OFFSETS.DEMOED] ?? 0) >= 0.5;
      const posZ = Number(f[cBase + CAR_STATE_OFFSETS.POS + 2] ?? -2000);
      const entityActive = posZ > -1000 && !isDemo;
      const isOnGround = Number(f[cBase + CAR_STATE_OFFSETS.ON_GROUND] ?? 0) >= 0.5;
      const isSupersonic = Number(f[cBase + CAR_STATE_OFFSETS.SUPERSONIC] ?? 0) >= 0.5;
      const hasFlipOrJump = Number(f[cBase + CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] ?? 0) >= 0.5;
      const isBoosting = Number(f[cBase + CAR_STATE_OFFSETS.IS_BOOSTING] ?? 0) >= 0.5;
      const isFlipping = Number(f[cBase + CAR_STATE_OFFSETS.IS_FLIPPING] ?? 0) >= 0.5;
      const isJumping =
        extBase + EXTENDED_STATE_OFFSETS.CAR_IS_JUMPING_OFFSET < f.length
          ? Number(f[extBase + EXTENDED_STATE_OFFSETS.CAR_IS_JUMPING_OFFSET] ?? 0) >= 0.5
          : false;
      const airTimeSinceJump =
        extBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_SINCE_JUMP_OFFSET < f.length
          ? Number(f[extBase + EXTENDED_STATE_OFFSETS.CAR_AIR_TIME_SINCE_JUMP_OFFSET] ?? 0)
          : 0;

      const rawCtrl = (f.controls?.[slot] ?? {}) as Record<string, unknown>;
      return {
        slotIndex: slot,
        entityActive,
        ...(isDemo ? { isDemolished: true } : {}),
        pos: [
          f[cBase + CAR_STATE_OFFSETS.POS] || 0,
          f[cBase + CAR_STATE_OFFSETS.POS + 1] || 0,
          posZ,
        ],
        rot: basisAxesToQuat(
          f[cBase + CAR_STATE_OFFSETS.FWD] ?? 1,
          f[cBase + CAR_STATE_OFFSETS.FWD + 1] ?? 0,
          f[cBase + CAR_STATE_OFFSETS.FWD + 2] ?? 0,
          f[cBase + CAR_STATE_OFFSETS.RIGHT] ?? 0,
          f[cBase + CAR_STATE_OFFSETS.RIGHT + 1] ?? 1,
          f[cBase + CAR_STATE_OFFSETS.RIGHT + 2] ?? 0,
          f[cBase + CAR_STATE_OFFSETS.UP] ?? 0,
          f[cBase + CAR_STATE_OFFSETS.UP + 1] ?? 0,
          f[cBase + CAR_STATE_OFFSETS.UP + 2] ?? 1
        ),
        vel: [
          f[cBase + CAR_STATE_OFFSETS.VEL] || 0,
          f[cBase + CAR_STATE_OFFSETS.VEL + 1] || 0,
          f[cBase + CAR_STATE_OFFSETS.VEL + 2] || 0,
        ],
        angVel: [
          f[cBase + CAR_STATE_OFFSETS.ANG_VEL] || 0,
          f[cBase + CAR_STATE_OFFSETS.ANG_VEL + 1] || 0,
          f[cBase + CAR_STATE_OFFSETS.ANG_VEL + 2] || 0,
        ],
        boostAmount: Number(f[cBase + CAR_STATE_OFFSETS.BOOST] ?? 33.33),
        isOnGround,
        isSupersonic,
        hasFlipOrJump,
        airTimeSinceJump,
        activeFlags: [isBoosting, isJumping, false, isFlipping],
        controls: [
          Number(rawCtrl.throttle) || 0,
          Number(rawCtrl.steer) || 0,
          Number(rawCtrl.pitch) || 0,
          Number(rawCtrl.yaw) || 0,
          Number(rawCtrl.roll) || 0,
          Boolean(rawCtrl.jump),
          Boolean(rawCtrl.boost),
          Boolean(rawCtrl.handbrake),
        ],
      };
    });

    const boostPadCooldowns: number[] = new Array(NUM_BOOST_PADS).fill(0);
    for (let p = 0; p < NUM_BOOST_PADS; p++) {
      const padOff = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
      if (padOff + BOOST_PAD_OFFSETS.COOLDOWN < f.length) {
        const isActive = Number(f[padOff + BOOST_PAD_OFFSETS.IS_ACTIVE] ?? 1) >= 0.5;
        const cd = Number(f[padOff + BOOST_PAD_OFFSETS.COOLDOWN] ?? 0);
        boostPadCooldowns[p] = isActive ? 0 : Math.max(0.01, cd);
      }
    }

    return {
      frameIndex: localIdx,
      timeSeconds: Number(((startIdx + localIdx) / 120).toFixed(4)),
      ballPos,
      ballRot,
      ballVel,
      ballAngVel,
      cars,
      boostPadCooldowns,
    };
  });

  const durationSeconds = Number((compactFrames.length / 120).toFixed(2));
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
    originEndFrame120Hz: endIdx,
    interveneLocalFrameIndex: clampedTarget - startIdx,
    durationSeconds,
    tickRate: 120,
    defaultPovSlotIndex: povCarIndex,
    roster: compactRoster,
    frames: compactFrames,
  };
}
