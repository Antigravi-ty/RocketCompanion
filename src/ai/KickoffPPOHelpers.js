/**
 * KickoffPPOHelpers.js
 * Spawn constants, MultiDiscrete action conversions, and CarJumpAirTimeTracker
 * for KickoffPPOAgent and KickoffTrainingMode.
 */

import {
  KICKOFF_PPO_META,
  getKickoffPPOActorWeights,
  preloadKickoffPPOWeights,
} from './kickoffPPOWeights.js';
import { KICKOFF_SPAWNS } from '../ui-core/config/trainingDefaults.js';

export { preloadKickoffPPOWeights, KICKOFF_SPAWNS };

export const KICKOFF_SETTLE_TICKS = KICKOFF_PPO_META.settleTicks || 30;
export const TICKS_PER_DECISION = KICKOFF_PPO_META.actionRepeat || 4;
export const OBS_V3_DIM = 75;
export const CPP_SPAWN_INDEX_MAP = [0, 2, 4, 3, 1];

export function getSameSidePartnerSpawnIndex(spawnIndex) {
  const idx = Math.max(0, Math.min(4, spawnIndex | 0));
  if (idx === 2) return null;
  return 4 - idx;
}

const JUMP_MIN_TIME = 0.025;
const JUMP_RESET_TIME_PAD = 1.0 / 40.0;
const JUMP_MAX_TIME = 0.2;
const TICK_TIME = 1.0 / 120.0;

export function getActorWeights() {
  return getKickoffPPOActorWeights();
}

export class CarJumpAirTimeTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.isJumping = false;
    this.hasJumped = false;
    this.jumpTime = 0.0;
    this.airTime = 0.0;
    this.lastJumpControl = false;
  }

  stepTick(jumpControlBool, isOnGroundPostTick) {
    const jumpPressed = !!jumpControlBool && !this.lastJumpControl;
    const isOnGround = !!isOnGroundPostTick;

    if (isOnGround && !this.isJumping) {
      if (!(this.hasJumped && this.jumpTime < JUMP_MIN_TIME + JUMP_RESET_TIME_PAD)) {
        this.hasJumped = false;
        this.jumpTime = 0.0;
      }
    }

    if (this.isJumping) {
      this.isJumping = this.jumpTime < JUMP_MIN_TIME || (jumpControlBool && this.jumpTime < JUMP_MAX_TIME);
    } else if (isOnGround && jumpPressed) {
      this.isJumping = true;
      this.jumpTime = 0.0;
    }

    if (this.isJumping) {
      this.hasJumped = true;
    }

    if (this.isJumping || this.hasJumped) {
      this.jumpTime = Math.fround(this.jumpTime + TICK_TIME);
    }

    this.airTime = isOnGround ? 0.0 : Math.fround(this.airTime + TICK_TIME);
    this.lastJumpControl = !!jumpControlBool;
  }

  update(isOnGroundPostTick, jumpControlBool) {
    this.stepTick(jumpControlBool, isOnGroundPostTick);
  }
}

export function makeKickoffRawCarState(sx, sy, outArray = new Float32Array(40)) {
  outArray.fill(0);
  outArray[0] = sx;
  outArray[1] = sy;
  outArray[2] = 17.0;

  if (Math.abs(sx) < 500.0) {
    outArray[3] = 0.0; outArray[4] = 1.0; outArray[5] = 0.0;
    outArray[6] = -1.0; outArray[7] = 0.0; outArray[8] = 0.0;
    outArray[9] = 0.0; outArray[10] = 0.0; outArray[11] = 1.0;
  } else {
    const s2 = Math.fround(Math.SQRT1_2);
    const sgn = sx > 0 ? -1.0 : 1.0;
    outArray[3] = sgn * s2; outArray[4] = s2; outArray[5] = 0.0;
    outArray[6] = -s2; outArray[7] = sgn * s2; outArray[8] = 0.0;
    outArray[9] = 0.0; outArray[10] = 0.0; outArray[11] = 1.0;
  }

  outArray[18] = Math.fround(100.0 / 3.0);
  outArray[19] = 1.0;
  outArray[22] = 1.0;
  return outArray;
}

export function resetEngineToKickoffSpawn(engine, spawnIndex = 0, options = {}) {
  const {
    carIndex = 0,
    settleTicks = KICKOFF_SETTLE_TICKS,
    hitboxType = 'default',
    recreateArena = false,
  } = options;

  const spawn = KICKOFF_SPAWNS[spawnIndex] || KICKOFF_SPAWNS[0];
  const cppSpawnIdx = CPP_SPAWN_INDEX_MAP[spawnIndex] ?? 0;

  if (!recreateArena && typeof engine.resetKickoffAtSpawn === 'function') {
    if (engine.numCars === 0 && typeof engine.addCar === 'function') {
      engine.addCar(0, hitboxType);
    }
    engine.resetKickoffAtSpawn(cppSpawnIdx, 0);
    const pre0 = new Float32Array(engine.getCarState(carIndex));
    if (settleTicks > 0) {
      engine.resetKickoffAtSpawn(cppSpawnIdx, settleTicks);
      const s0 = new Float32Array(engine.getCarState(carIndex));
      s0[0] = pre0[0];
      s0[1] = pre0[1];
      for (let k = 3; k <= 11; k++) s0[k] = pre0[k];
      for (let k = 12; k <= 17; k++) s0[k] = 0.0;
      engine.setCarState(carIndex, s0);
      engine.clearEvents();
    }
    return;
  }

  if (recreateArena && engine.module && typeof engine.module._physics_createArena === 'function') {
    engine.module._physics_createArena();
    engine.clearEvents();
    engine.addCar(0, hitboxType);
  }

  engine.resetKickoff(-1);
  const preState = makeKickoffRawCarState(spawn.x, spawn.y);
  engine.setCarState(carIndex, preState);
  engine.setControls(carIndex, {
    throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0,
    jump: false, boost: false, handbrake: false
  });

  if (settleTicks > 0) {
    engine.stepSilent(settleTicks);
    const settled = new Float32Array(engine.getCarState(carIndex));
    settled[0] = preState[0];
    settled[1] = preState[1];
    for (let k = 3; k <= 11; k++) settled[k] = preState[k];
    for (let k = 12; k <= 17; k++) settled[k] = 0.0;
    engine.setCarState(carIndex, settled);
    engine.clearEvents();
  }
}

export function multiDiscreteToControls(act) {
  const thrVal = (act[0] | 0) - 1;
  const strVal = (act[1] | 0) - 1;
  const rolVal = (act[2] | 0) - 1;
  return {
    throttle: thrVal,
    pitch: -thrVal,
    steer: strVal,
    yaw: strVal,
    roll: rolVal,
    jump: act[3] === 1,
    boost: act[4] === 1,
    handbrake: act[5] === 1,
  };
}

export function controlsToMultiDiscrete(controls) {
  const thr = Number(controls?.throttle || 0);
  const ptc = Number(controls?.pitch || 0);
  let ch0 = 1;
  if (thr > 0.3 || ptc < -0.3) ch0 = 2;
  else if (thr < -0.3 || ptc > 0.3) ch0 = 0;

  const st = Number(controls?.steer || 0);
  const yw = Number(controls?.yaw || 0);
  let ch1 = 1;
  if (st > 0.3 || yw > 0.3) ch1 = 2;
  else if (st < -0.3 || yw < -0.3) ch1 = 0;

  const rl = Number(controls?.roll || 0);
  let ch2 = 1;
  if (rl > 0.3) ch2 = 2;
  else if (rl < -0.3) ch2 = 0;

  return [ch0, ch1, ch2, controls?.jump ? 1 : 0, controls?.boost ? 1 : 0, controls?.handbrake ? 1 : 0];
}

export function multiDiscreteToOverlayKeys(act) {
  return {
    Shift: act[5] === 1,
    Q: act[2] === 0,
    A: act[1] === 0,
    W: act[0] === 2,
    S: act[0] === 0,
    D: act[1] === 2,
    E: act[2] === 2,
    Boost: act[4] === 1,
    Jump: act[3] === 1,
  };
}

export function multiDiscreteToKeyString(act) {
  const keys = [];
  if (act[5] === 1) keys.push('Shift');
  if (act[2] === 0) keys.push('Q');
  if (act[1] === 0) keys.push('A');
  if (act[0] === 2) keys.push('W');
  else if (act[0] === 0) keys.push('S');
  if (act[1] === 2) keys.push('D');
  if (act[2] === 2) keys.push('E');
  if (act[4] === 1) keys.push('Boost');
  if (act[3] === 1) keys.push('Jump');
  return keys.length > 0 ? keys.join(' + ') : 'None (Coast)';
}

export function areMultiDiscreteActionsEqual(a, b) {
  if (!a || !b || a.length !== 6 || b.length !== 6) return false;
  for (let i = 0; i < 6; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
