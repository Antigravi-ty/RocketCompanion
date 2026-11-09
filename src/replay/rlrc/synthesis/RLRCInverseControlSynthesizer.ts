/**
 * RLRCInverseControlSynthesizer.ts
 * 120Hz timeline slot state-machine and Track 0 control packer for RLRC replays.
 */

import {
  CAR_STATE_OFFSETS,
  CAR_STATE_STRIDE,
  EXTENDED_STATE_OFFSETS,
  SIM_OFFSETS,
} from '../../../physics/RocketSimConstants.ts';
import { packCarControlsToTrack64 } from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_CONTROLS_BYTES_PER_FRAME,
  RLRC_FIXED_DT,
  RLRC_MAX_PLAYER_SLOTS,
  RLRC_STATE_BYTES_PER_FRAME,
  RLRC_STATE_FLOATS_PER_FRAME,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCCarComponentActiveFlags,
  type RLRCCarFrameState120Hz,
  type RLRCFrame120Hz,
  type RLRCSynthesizedCarControls,
} from '../RLRCReplayTypes.ts';
import {
  BOOST_ACCEL_AIR_UU,
  clampUnit,
  computeFrameKinematics,
  distVec3,
  GRAVITY_Z_UU,
  inferBoostStateFromKinematics,
  inferHandbrakeFromKinematics,
  NEUTRAL_ACTIVE_FLAGS,
  NEUTRAL_SYNTHESIZED_CONTROLS,
  synthesizeCarControlsBetweenFrames,
  type FrameKinematicsSample,
  type RLRCControlSynthesisOptions,
  type RLRCLocalCarBasis,
} from './RLRCInverseControlKinematicsPipeline.ts';

export type { RLRCControlSynthesisOptions, RLRCLocalCarBasis };

const JUMP_MIN_HOLD = 3;
const JUMP_MAX_HOLD = 24;
const DJ_PULSE_FRAMES = 18;
const DODGE_MAX_FRAMES = 78;
const DODGE_MIN_FRAMES = 18;
const SECOND_JUMP_BTN_FRAMES = 6;
const FLIP_EXPIRY_SEC = 1.25;
const MAX_PACKED_SLOTS = 8;

function debounceTrack(
  flags: boolean[],
  act: readonly boolean[],
  explicitPulse: readonly boolean[],
  maxGap = 2,
  minRun = 1
): void {
  const n = flags.length;
  for (let i = 1; i + 1 < n; i++) {
    if (!act[i]) continue;
    if (!flags[i] && flags[i - 1] && flags[i + 1]) flags[i] = true;
    else if (
      maxGap >= 2 &&
      i + 2 < n &&
      !flags[i] &&
      !flags[i + 1] &&
      flags[i - 1] &&
      flags[i + 2] &&
      act[i + 1]
    ) {
      flags[i] = true;
      flags[i + 1] = true;
    }
  }
  if (minRun <= 1) {
    for (let i = 1; i + 1 < n; i++) {
      if (flags[i] && !flags[i - 1] && !flags[i + 1] && !explicitPulse[i]) flags[i] = false;
    }
    return;
  }
  let f = 0;
  while (f < n) {
    if (!flags[f]) {
      f++;
      continue;
    }
    let end = f,
      hasExplicit = false;
    while (end < n && flags[end]) {
      if (explicitPulse[end]) hasExplicit = true;
      end++;
    }
    if (!hasExplicit && end - f < minRun) {
      for (let k = f; k < end; k++) flags[k] = false;
    }
    f = end;
  }
}

function synthesizeSlotTimeline120Hz(
  frames: readonly RLRCFrame120Hz[],
  slot: number,
  options?: RLRCControlSynthesisOptions
) {
  const n = frames.length;
  const dt = Math.max(1e-4, options?.dtSeconds ?? RLRC_FIXED_DT);
  const radius: 0 | 1 | 2 = options?.smoothWindowRadius ?? 1;

  const act = new Array<boolean>(n).fill(false);
  const kins = new Array<FrameKinematicsSample | null>(n).fill(null);
  const baseCtrl = new Array<RLRCSynthesizedCarControls>(n).fill(NEUTRAL_SYNTHESIZED_CONTROLS);
  const boostTrk = new Array<boolean>(n).fill(false);
  const repBoost = new Array<boolean>(n).fill(false);
  const hbTrk = new Array<boolean>(n).fill(false);
  const repHb = new Array<boolean>(n).fill(false);

  let sinceLand = 999;
  for (let f = 0; f < n; f++) {
    const cur = frames[f].cars[slot];
    if (!cur || !cur.entityActive) {
      sinceLand = 999;
      continue;
    }
    const prv = f > 0 ? frames[f - 1].cars[slot] : null;
    const nxt = f + 1 < n ? frames[f + 1].cars[slot] : null;
    act[f] = true;

    const kin = computeFrameKinematics(prv, cur, nxt, dt);
    kins[f] = kin;
    if (kin.teleported) sinceLand = 999;
    else if (cur.isOnGround) sinceLand = prv?.entityActive && !prv.isOnGround ? 0 : sinceLand + 1;
    else sinceLand = 999;

    const ctrl = synthesizeCarControlsBetweenFrames(prv, cur, nxt, options);
    baseCtrl[f] = ctrl;

    let boostOn = inferBoostStateFromKinematics(prv, cur, nxt, kin, dt);
    const f0 = Math.max(0, f - 2),
      f1 = Math.min(n - 1, f + 2);
    const c0 = frames[f0].cars[slot],
      c1 = frames[f1].cars[slot];
    const drainRate =
      c0?.entityActive && c1?.entityActive && f1 > f0
        ? (c0.boostAmount - c1.boostAmount) / ((f1 - f0) * dt)
        : 0;
    const hasExplicitOrDrain =
      Boolean(cur.activeFlags.boostActive && cur.boostAmount > 0.05) ||
      (drainRate >= 8.5 && drainRate <= 120.0 && c0.boostAmount - c1.boostAmount <= 12.0);

    if (boostOn && cur.activeFlags.boostActive && cur.boostAmount < 99.5) {
      const lo = Math.max(0, f - 18),
        hi = Math.min(n - 1, f + 18);
      const cLo = frames[lo].cars[slot],
        cHi = frames[hi].cars[slot];
      if (
        hi - lo >= 24 &&
        cLo?.entityActive &&
        cHi?.entityActive &&
        Math.abs(cLo.boostAmount - cHi.boostAmount) < 0.05 &&
        kin.nonGravityForwardAccel < 220
      ) {
        boostOn = false;
      }
    }
    boostTrk[f] = boostOn;
    repBoost[f] = hasExplicitOrDrain;
    hbTrk[f] = inferHandbrakeFromKinematics(prv, cur, kin, ctrl.roll, sinceLand);
    repHb[f] = Boolean(cur.controls.handbrake);
  }

  debounceTrack(boostTrk, act, repBoost, 2, 5);
  debounceTrack(hbTrk, act, repHb, 2, 2);

  const jmpTrk = new Array<boolean>(n).fill(false);
  const djTrk = new Array<boolean>(n).fill(false);
  const dgTrk = new Array<boolean>(n).fill(false);
  const jmpBtn = new Array<boolean>(n).fill(false);
  const flipTrk = new Array<boolean>(n).fill(false);
  const airTrk = new Array<number>(n).fill(0);

  let gndStreak = 0,
    jL = false,
    djL = false,
    dgL = false;
  let jRem = 0,
    jTot = 0,
    djRem = 0,
    dgRem = 0,
    dgElap = 0,
    b2Rem = 0;
  let used2 = false,
    airF = 0,
    jmpGnd = false;

  for (let f = 0; f < n; f++) {
    const cur = frames[f].cars[slot],
      kin = kins[f];
    if (!cur || !cur.entityActive || !kin) {
      gndStreak = 0;
      jL = djL = dgL = false;
      jRem = jTot = djRem = dgRem = dgElap = b2Rem = 0;
      used2 = jmpGnd = false;
      airF = 0;
      continue;
    }
    if (kin.teleported || frames[f].roundCountdownNumber > 0) {
      jRem = jTot = djRem = dgRem = dgElap = b2Rem = 0;
      used2 = jmpGnd = false;
      airF = 0;
    }

    const rf = cur.activeFlags;
    if (!rf.jumpActive) jL = false;
    if (!rf.doubleJumpActive) djL = false;
    if (!rf.dodgeActive) dgL = false;

    const jRise = rf.jumpActive && !jL,
      djRise = rf.doubleJumpActive && !djL,
      dgRise = rf.dodgeActive && !dgL;
    const prv = f > 0 ? frames[f - 1].cars[slot] : null;
    const wasGnd = Boolean(prv?.entityActive && prv.isOnGround);

    if (cur.isOnGround) {
      gndStreak = rf.jumpActive ? gndStreak + 1 : 0;
      djRem = dgRem = dgElap = b2Rem = 0;
      used2 = jmpGnd = false;
      airF = 0;

      let lifts = false;
      for (let k = 1; k <= 4 && f + k < n; k++) {
        const fc = frames[f + k].cars[slot],
          fk = kins[f + k];
        if (!fc?.entityActive || !fk || fk.teleported) break;
        if (!fc.isOnGround && (fk.localUpVel > 130 || fk.nonGravityUpAccel > 500)) {
          lifts = true;
          break;
        }
      }
      if (jRise && lifts && kin.basis.up.z > 0.25) {
        jL = true;
        jRem = JUMP_MAX_HOLD;
        jTot = 1;
        jmpGnd = true;
        jmpTrk[f] = jmpBtn[f] = true;
      } else if (jRem > 0 && jTot <= 3 && lifts) {
        jRem--;
        jTot++;
        jmpTrk[f] = jmpBtn[f] = true;
      } else {
        jRem = jTot = 0;
        if (gndStreak > 6 && rf.jumpActive) jL = true;
      }
      flipTrk[f] = true;
      airTrk[f] = 0;
      continue;
    }

    airF++;
    const airSec = airF * dt;
    if (wasGnd && jTot === 0) {
      let pkUp = kin.localUpVel;
      for (let k = 1; k <= 4 && f + k < n; k++) {
        const fk = kins[f + k],
          fc = frames[f + k].cars[slot];
        if (!fc?.entityActive || !fk || fk.teleported || fc.isOnGround) break;
        if (fk.localUpVel > pkUp) pkUp = fk.localUpVel;
      }
      if (
        (rf.jumpActive && gndStreak <= 6) ||
        (kin.basis.up.z > 0.25 &&
          pkUp > 145 &&
          (kin.localUpVel > 110 || kin.nonGravityUpAccel > 520))
      ) {
        jL = rf.jumpActive;
        jRem = JUMP_MAX_HOLD;
        jTot = 0;
        jmpGnd = true;
      }
    } else if (jRise && airF <= 8 && jTot === 0 && !used2) {
      jL = true;
      jRem = Math.max(JUMP_MIN_HOLD, JUMP_MAX_HOLD - airF);
      jTot = 0;
      jmpGnd = true;
    }

    const ball = frames[f].ball;
    const nearBall =
      ball.entityActive && distVec3(cur.rigidBody.position, ball.rigidBody.position) < 205;
    const inWin = !jmpGnd || airSec <= FLIP_EXPIRY_SEC + Math.min(0.2, jTot * dt) + 0.05;

    let trigDg = false,
      trigDj = false;
    if (airF >= 3 && dgRem === 0 && djRem === 0) {
      if (dgRise) {
        trigDg = dgL = true;
      } else if (djRise) {
        trigDj = djL = true;
      } else if (!used2 && inWin && !nearBall) {
        let pkOmg = kin.flipOmegaMag,
          sumOmg = 0,
          cnt = 0;
        for (let k = 1; k <= 8 && f + k < n; k++) {
          const fc = frames[f + k].cars[slot],
            fk = kins[f + k];
          if (!fc?.entityActive || !fk || fk.teleported || fc.isOnGround) break;
          if (fk.flipOmegaMag > pkOmg) pkOmg = fk.flipOmegaMag;
          sumOmg += fk.flipOmegaMag;
          cnt++;
        }
        const meanOmg = cnt > 0 ? sumOmg / cnt : kin.flipOmegaMag;
        const prvVz = prv?.entityActive ? prv.rigidBody.linearVelocity.z : 0;
        const vzDamp =
          Math.abs(prvVz) > 130 &&
          Math.abs(cur.rigidBody.linearVelocity.z) < Math.abs(prvVz) * 0.82;

        if (
          airF >= 4 &&
          kin.angAccelMag > 18.0 &&
          pkOmg >= 3.7 &&
          meanOmg >= 2.6 &&
          (kin.planarAccelMag > 1350 || vzDamp || kin.angAccelMag > 26.0)
        ) {
          trigDg = true;
          dgL = rf.dodgeActive;
        } else if (airF >= 5 && jRem <= 16) {
          const bstUp = boostTrk[f] ? BOOST_ACCEL_AIR_UU * Math.max(0, kin.basis.forward.z) : 0;
          const netUp = kin.nonGravityUpAccel - bstUp;
          const fP = Math.max(0, f - 1),
            fN = Math.min(n - 1, f + 3);
          const kP = kins[fP],
            kN = kins[fN],
            spSec = Math.max(dt, (fN - fP) * dt);
          const upGain =
            kP && kN
              ? kN.localUpVel - kP.localUpVel - (GRAVITY_Z_UU * kin.basis.up.z + bstUp) * spSec
              : 0;
          if (netUp > 1050 && upGain > 155 && pkOmg < 3.4) {
            trigDj = true;
            djL = rf.doubleJumpActive;
          }
        }
      }
    }

    if (trigDg) {
      jRem = 0;
      dgRem = DODGE_MAX_FRAMES;
      dgElap = 0;
      b2Rem = SECOND_JUMP_BTN_FRAMES;
      used2 = true;
      if (f > 0) jmpBtn[f - 1] = false;
    } else if (trigDj) {
      jRem = 0;
      djRem = DJ_PULSE_FRAMES;
      b2Rem = SECOND_JUMP_BTN_FRAMES;
      used2 = true;
      if (f > 0) jmpBtn[f - 1] = false;
    }

    if (dgRem > 0) {
      dgElap++;
      dgRem--;
      dgTrk[f] = true;
      if (!repBoost[f]) boostTrk[f] = false;
      if (dgElap >= DODGE_MIN_FRAMES && kin.flipOmegaMag < 1.0 && !rf.dodgeActive) dgRem = 0;
    } else if (djRem > 0) {
      djRem--;
      djTrk[f] = true;
    } else if (jRem > 0) {
      jTot++;
      jRem--;
      const netUpHold =
        kin.nonGravityUpAccel -
        (boostTrk[f] ? BOOST_ACCEL_AIR_UU * Math.max(0, kin.basis.forward.z) : 0);
      if (jTot <= JUMP_MIN_HOLD || (rf.jumpActive && gndStreak <= 6) || netUpHold > 450)
        jmpTrk[f] = jmpBtn[f] = true;
      else jRem = 0;
    }

    if (b2Rem > 0) {
      b2Rem--;
      jmpBtn[f] = true;
    }
    airTrk[f] = Math.min(FLIP_EXPIRY_SEC, airSec);
    flipTrk[f] = !used2 && inWin;
  }

  debounceTrack(boostTrk, act, repBoost, 2, 5);
  for (let f = 0; f < n; f++) {
    if (!act[f]) continue;
    const c = baseCtrl[f];
    baseCtrl[f] = {
      throttle: c.throttle,
      steer: c.steer,
      pitch: c.pitch,
      yaw: c.yaw,
      roll: c.roll,
      jump: jmpBtn[f],
      boost: boostTrk[f],
      handbrake: hbTrk[f],
    };
  }

  const controls = smoothControlsWindow(baseCtrl, act, radius);
  const activeFlags: RLRCCarComponentActiveFlags[] = new Array(n);
  for (let f = 0; f < n; f++) {
    activeFlags[f] = !act[f]
      ? NEUTRAL_ACTIVE_FLAGS
      : {
          boostActive: boostTrk[f],
          jumpActive: jmpTrk[f],
          doubleJumpActive: djTrk[f],
          dodgeActive: dgTrk[f],
        };
  }
  return { controls, activeFlags, hasFlipOrJump: flipTrk, airTimeSinceJump: airTrk };
}

function smoothControlsWindow(
  raw: readonly RLRCSynthesizedCarControls[],
  act: readonly boolean[],
  radius: 0 | 1 | 2
): RLRCSynthesizedCarControls[] {
  if (radius === 0 || raw.length <= 2) return [...raw];
  const n = raw.length;
  const out: RLRCSynthesizedCarControls[] = new Array(n);

  for (let i = 0; i < n; i++) {
    if (!act[i]) {
      out[i] = NEUTRAL_SYNTHESIZED_CONTROLS;
      continue;
    }
    let sT = 0,
      sS = 0,
      sP = 0,
      sY = 0,
      sR = 0,
      wSum = 0;
    for (let d = -radius; d <= radius; d++) {
      const idx = i + d;
      if (idx < 0 || idx >= n || !act[idx]) continue;
      const w = radius + 1 - Math.abs(d),
        c = raw[idx];
      sT += c.throttle * w;
      sS += c.steer * w;
      sP += c.pitch * w;
      sY += c.yaw * w;
      sR += c.roll * w;
      wSum += w;
    }
    const b = raw[i];
    out[i] =
      wSum <= 0
        ? b
        : {
            throttle: clampUnit(sT / wSum),
            steer: clampUnit(sS / wSum),
            pitch: clampUnit(sP / wSum),
            yaw: clampUnit(sY / wSum),
            roll: clampUnit(sR / wSum),
            jump: b.jump,
            boost: b.boost,
            handbrake: b.handbrake,
          };
  }
  return out;
}

export function synthesizeControlsForTimeline120Hz(
  frames: readonly RLRCFrame120Hz[],
  options?: RLRCControlSynthesisOptions
): RLRCFrame120Hz[] {
  if (!frames.length) return [];
  const tls = Array.from({ length: RLRC_MAX_PLAYER_SLOTS }, (_, s) =>
    synthesizeSlotTimeline120Hz(frames, s, options)
  );
  const n = frames.length;
  for (let f = 0; f < n; f++) {
    const cars = frames[f].cars as RLRCCarFrameState120Hz[];
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const s = car.slotIndex >= 0 && car.slotIndex < RLRC_MAX_PLAYER_SLOTS ? car.slotIndex : i;
      if (!car.entityActive || s < 0 || s >= RLRC_MAX_PLAYER_SLOTS) {
        cars[i] = {
          ...car,
          activeFlags: NEUTRAL_ACTIVE_FLAGS,
          controls: NEUTRAL_SYNTHESIZED_CONTROLS,
        };
      } else {
        const tl = tls[s];
        cars[i] = {
          ...car,
          hasFlipOrJump: tl.hasFlipOrJump[f],
          airTimeSinceJump: tl.airTimeSinceJump[f],
          activeFlags: tl.activeFlags[f],
          controls: tl.controls[f],
        };
      }
    }
  }
  return frames as RLRCFrame120Hz[];
}

export function packRLRCFrameControlsTo64Bytes(
  cars: readonly RLRCCarFrameState120Hz[],
  targetU8?: Uint8Array,
  off = 0
): Uint8Array {
  const out =
    targetU8 && targetU8.byteLength >= off + RLRC_CONTROLS_BYTES_PER_FRAME
      ? targetU8.subarray(off, off + RLRC_CONTROLS_BYTES_PER_FRAME)
      : new Uint8Array(RLRC_CONTROLS_BYTES_PER_FRAME);
  out.fill(0);
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    if (!car?.entityActive) continue;
    const idx = car.slotIndex >= 0 && car.slotIndex < MAX_PACKED_SLOTS ? car.slotIndex : i;
    if (idx >= 0 && idx < MAX_PACKED_SLOTS) packCarControlsToTrack64(out, idx, { ...car.controls });
  }
  return out;
}

export function writeSynthesizedControlsToTrack0Buffer(
  frames: readonly RLRCFrame120Hz[],
  trackBytes: Uint8Array
): void {
  const maxF = Math.min(
    frames.length,
    Math.floor(trackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES)
  );
  const {
    CAR_JUMP_AIR_BASE: j0,
    CAR_JUMP_AIR_STRIDE: jS,
    CAR_IS_JUMPING_OFFSET: oJ,
    CAR_AIR_TIME_OFFSET: oDj,
    CAR_JUMP_TIME_OFFSET: oDg,
    CAR_AIR_TIME_SINCE_JUMP_OFFSET: oAt,
  } = EXTENDED_STATE_OFFSETS;
  const { HAS_FLIP_OR_JUMP: oFlp, IS_BOOSTING: oBst, IS_FLIPPING: oFl } = CAR_STATE_OFFSETS;
  for (let f = 0; f < maxF; f++) {
    const off = f * RLRC_TRACK0_FRAME_STRIDE_BYTES;
    const dst = new Float32Array(
      trackBytes.buffer,
      trackBytes.byteOffset + off,
      RLRC_STATE_FLOATS_PER_FRAME
    );
    const cars = frames[f].cars;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) continue;
      const slot = car.slotIndex >= 0 && car.slotIndex < RLRC_MAX_PLAYER_SLOTS ? car.slotIndex : i;
      if (slot < 0 || slot >= RLRC_MAX_PLAYER_SLOTS) continue;
      const cB = SIM_OFFSETS.CARS + slot * CAR_STATE_STRIDE,
        jB = j0 + slot * jS,
        act = car.entityActive,
        fl = car.activeFlags;
      dst[cB + oFlp] = act && car.hasFlipOrJump ? 1 : 0;
      dst[cB + oBst] = act && (fl.boostActive || car.controls.boost) ? 1 : 0;
      dst[cB + oFl] = act && (fl.dodgeActive || fl.doubleJumpActive) ? 1 : 0;
      dst[jB + oJ] = act && fl.jumpActive ? 1 : 0;
      dst[jB + oDj] = act && fl.doubleJumpActive ? 1 : 0;
      dst[jB + oDg] = act && fl.dodgeActive ? 1 : 0;
      dst[jB + oAt] = act ? car.airTimeSinceJump : 0;
    }
    packRLRCFrameControlsTo64Bytes(cars, trackBytes, off + RLRC_STATE_BYTES_PER_FRAME);
  }
}
