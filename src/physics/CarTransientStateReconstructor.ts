/**
 * CarTransientStateReconstructor.ts
 * Reconstructs transient RocketSim::CarState fields (flip torque/time, jump/double-jump/flip flags,
 * boosting hysteresis timer, powerslide ramp, lastControls, and ballHitInfo cooldown ticks)
 * from compact 448-float replay history for deterministic Replay Takeover.
 */

import {
  SIM_OFFSETS,
  CAR_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  MAX_CARS,
} from "./RocketSimConstants.ts";
import {
  restoreWasmSnapshotState,
  writeCarControls,
} from "./RocketSimSnapshotSerializer.ts";

/**
 * Internal core.wasm memory offsets for RocketSim::CarState and car pointer table.
 * Used to deterministically reconstruct transient CarState fields (flip torque/time,
 * jump/double-jump/flip flags, boosting hysteresis timer, powerslide ramp, lastControls,
 * and ballHitInfo cooldown ticks) from compact 448-float replay history without increasing
 * .rcreplay.gz file size.
 */
const WASM_CAR_PTR_TABLE_BYTE_OFFSET = 62768;
const WASM_CAR_STATE_OFFSETS = Object.freeze({
  HAS_JUMPED: 1581,
  HAS_DOUBLE_JUMPED: 1582,
  HAS_FLIPPED: 1583,
  FLIP_REL_TORQUE_X: 1584,
  FLIP_REL_TORQUE_Y: 1588,
  FLIP_REL_TORQUE_Z: 1592,
  JUMP_TIME: 1600,
  FLIP_TIME: 1604,
  IS_FLIPPING: 1608,
  IS_JUMPING: 1609,
  AIR_TIME: 1612,
  AIR_TIME_SINCE_JUMP: 1616,
  IS_BOOSTING: 1628,
  BOOSTING_TIME: 1632,
  IS_SUPERSONIC: 1636,
  SUPERSONIC_TIME: 1640,
  HANDBRAKE_VAL: 1644,
  HAS_WORLD_CONTACT: 1664,
  BALL_HIT_INFO_IS_VALID: 1728,
  BALL_HIT_INFO_TICK_HIT: 1792,
  BALL_HIT_INFO_TICK_EXTRA_IMPULSE: 1800,
  LAST_CONTROLS_THROTTLE: 1808,
  LAST_CONTROLS_STEER: 1812,
  LAST_CONTROLS_PITCH: 1816,
  LAST_CONTROLS_YAW: 1820,
  LAST_CONTROLS_ROLL: 1824,
  LAST_CONTROLS_JUMP: 1828,
  LAST_CONTROLS_BOOST: 1829,
  LAST_CONTROLS_HANDBRAKE: 1830,
});

function computeDodgeRelTorque(pitch, yaw, roll) {
  const dirX = -Number(pitch || 0);
  const dirY = Number(yaw || 0) + Number(roll || 0);
  const mag = Math.hypot(dirX, dirY);
  if (mag < 0.05) {
    return [0, 0, 0];
  }
  const nx = dirX / mag;
  const ny = dirY / mag;
  return [-ny, nx, 0];
}

function extractCarControlsFromFrameList(controlsList, carIndex) {
  if (!Array.isArray(controlsList)) return null;
  for (let i = 0; i < controlsList.length; i++) {
    const item = controlsList[i];
    if (!item) continue;
    const idx = typeof item.carIndex === 'number' ? item.carIndex : i;
    if (idx === carIndex) {
      return item.controls || item;
    }
  }
  return null;
}

/**
 * Reconstructs transient RocketSim::CarState fields for `carIndex` at `targetFrameIndex`
 * by scanning backwards up to `maxLookback` frames in `getFrameSlotAt(f)`.
 */
export function reconstructCarTransientStateFromHistory(
  getFrameSlotAt,
  targetFrameIndex,
  carIndex,
  maxLookback = 300
) {
  const targetSlot = getFrameSlotAt(targetFrameIndex);
  const targetSnap = targetSlot?.snapshot;
  if (!targetSnap) return null;

  const carBase = SIM_OFFSETS.CARS + carIndex * CAR_STATE_STRIDE;
  const extBase = 416 + carIndex * 4;
  const isOnGround = (targetSnap[carBase + CAR_STATE_OFFSETS.ON_GROUND] || 0) > 0.5;
  const isSupersonic = (targetSnap[carBase + CAR_STATE_OFFSETS.SUPERSONIC] || 0) > 0.5;
  const hasFlipOrJump = (targetSnap[carBase + CAR_STATE_OFFSETS.HAS_FLIP_OR_JUMP] || 0) > 0.5;
  const isBoosting = (targetSnap[carBase + CAR_STATE_OFFSETS.IS_BOOSTING] || 0) > 0.5;
  const isFlipping = (targetSnap[carBase + CAR_STATE_OFFSETS.IS_FLIPPING] || 0) > 0.5;
  const isJumping = (targetSnap[extBase] || 0) > 0.5;
  const airTime = Number(targetSnap[extBase + 1] || 0);
  const jumpTime = Number(targetSnap[extBase + 2] || 0);
  const airTimeSinceJump = Number(targetSnap[extBase + 3] || 0);

  const hasWorldContact = 0;

  const dt = 1 / 120;
  const startLookback = Math.max(0, targetFrameIndex - maxLookback);

  // 1. Find last ground frame (gF) and reconstruct jump / double-jump / flip state
  let lastGroundFrame = targetFrameIndex;
  if (!isOnGround) {
    lastGroundFrame = startLookback;
    for (let f = targetFrameIndex - 1; f >= startLookback; f--) {
      const s = getFrameSlotAt(f)?.snapshot;
      if (s && (s[carBase + CAR_STATE_OFFSETS.ON_GROUND] || 0) > 0.5) {
        lastGroundFrame = f;
        break;
      }
    }
  }

  let hasJumped = 0;
  let hasDoubleJumped = 0;
  let hasFlipped = 0;
  let flipTime = 0;
  let flipRelTorque = [0, 0, 0];

  if (!isOnGround) {
    for (let f = lastGroundFrame + 1; f <= targetFrameIndex; f++) {
      const s = getFrameSlotAt(f)?.snapshot;
      if (!s) continue;
      if ((s[extBase] || 0) > 0.5) {
        hasJumped = 1;
      }
    }
    if (isJumping || jumpTime > 0 || airTimeSinceJump > 0) {
      hasJumped = 1;
    }

    // Detect flip start frame
    let flipStartFrame = -1;
    for (let f = lastGroundFrame + 1; f <= targetFrameIndex; f++) {
      const s = getFrameSlotAt(f)?.snapshot;
      const prevS = getFrameSlotAt(f - 1)?.snapshot;
      const curFlip = s && (s[carBase + CAR_STATE_OFFSETS.IS_FLIPPING] || 0) > 0.5;
      const prevFlip = prevS && (prevS[carBase + CAR_STATE_OFFSETS.IS_FLIPPING] || 0) > 0.5;
      if (curFlip && !prevFlip) {
        flipStartFrame = f;
      }
    }

    if (flipStartFrame >= 0) {
      hasFlipped = 1;
      const elapsedFlipTicks = targetFrameIndex - flipStartFrame + 1;
      flipTime = isFlipping ? Math.min(0.65, elapsedFlipTicks * dt) : 0.65;
      const flipCtrl = extractCarControlsFromFrameList(
        getFrameSlotAt(flipStartFrame)?.controls,
        carIndex
      );
      if (flipCtrl) {
        flipRelTorque = computeDodgeRelTorque(flipCtrl.pitch, flipCtrl.yaw, flipCtrl.roll);
      }
    } else if (isFlipping) {
      hasFlipped = 1;
      const ctrl = extractCarControlsFromFrameList(targetSlot?.controls, carIndex);
      if (ctrl) {
        flipRelTorque = computeDodgeRelTorque(ctrl.pitch, ctrl.yaw, ctrl.roll);
      }
    }

    if (!hasFlipOrJump && !hasFlipped && ( !hasJumped || airTimeSinceJump < 1.25 )) {
      hasDoubleJumped = 1;
    }
  }

  // 2. Reconstruct boostingTime (0.1s minimum boost hysteresis)
  let boostingTime = 0;
  if (isBoosting) {
    let boostStreak = 0;
    for (let f = targetFrameIndex; f >= startLookback; f--) {
      const s = getFrameSlotAt(f)?.snapshot;
      if (s && (s[carBase + CAR_STATE_OFFSETS.IS_BOOSTING] || 0) > 0.5) {
        boostStreak++;
      } else {
        break;
      }
    }
    boostingTime = boostStreak * dt;
  }

  // 3. Reconstruct supersonicTime
  let supersonicTime = 0;
  if (isSupersonic) {
    let ssStreak = 0;
    for (let f = targetFrameIndex; f >= startLookback; f--) {
      const s = getFrameSlotAt(f)?.snapshot;
      if (s && (s[carBase + CAR_STATE_OFFSETS.SUPERSONIC] || 0) > 0.5) {
        ssStreak++;
      } else {
        break;
      }
    }
    supersonicTime = ssStreak * dt;
  }

  // 4. Reconstruct handbrakeVal ([0, 1] ramp: +5.0/s when held, -2.0/s when released; saturates/decays within 60 ticks)
  let handbrakeVal = 0;
  const hbStartFrame = Math.max(startLookback, targetFrameIndex - 60);
  for (let f = hbStartFrame; f <= targetFrameIndex; f++) {
    const slot = getFrameSlotAt(f);
    const ctrl = extractCarControlsFromFrameList(slot?.controls, carIndex);
    if (ctrl?.handbrake) {
      handbrakeVal = Math.min(1.0, handbrakeVal + 5.0 * dt);
    } else {
      handbrakeVal = Math.max(0.0, handbrakeVal - 2.0 * dt);
    }
  }

  // 5. Reconstruct lastControls from targetFrameIndex
  const lastCtrl = extractCarControlsFromFrameList(targetSlot?.controls, carIndex) || {
    throttle: 0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jump: isJumping,
    boost: isBoosting,
    handbrake: false,
  };

  return {
    lastGroundFrame,
    isOnGround,
    isJumping,
    isFlipping,
    isBoosting,
    isSupersonic,
    hasJumped,
    hasDoubleJumped,
    hasFlipped,
    flipRelTorque,
    flipTime,
    jumpTime,
    airTime,
    airTimeSinceJump,
    boostingTime,
    supersonicTime,
    handbrakeVal,
    hasWorldContact,
    lastControls: lastCtrl,
  };
}

/**
 * Writes reconstructed transient CarState fields directly into core.wasm CarState memory
 * and clears stale ballHitInfo cooldown ticks so rewinding before a shot never suppresses
 * the extra ball-hit impulse.
 */
function verifyWasmCarStatePointerLayout(engine, dv, cPtr, carIndex) {
  const heapByteLength = engine?.module?.HEAPU8?.byteLength || 0;
  if (cPtr <= 0 || cPtr + 1840 > heapByteLength) return false;
  if (carIndex < 0 || carIndex >= MAX_CARS) return false;
  const airTime = dv.getFloat32(cPtr + WASM_CAR_STATE_OFFSETS.AIR_TIME, true);
  const boostingTime = dv.getFloat32(cPtr + WASM_CAR_STATE_OFFSETS.BOOSTING_TIME, true);
  if (!Number.isFinite(airTime) || !Number.isFinite(boostingTime)) return false;
  return true;
}

export function patchWasmCarTransientState(engine, carIndex, reconstructed, resetBallHitInfo = true) {
  if (!engine?.module?.HEAPU8?.buffer || !reconstructed) return false;
  const heapByteLength = engine.module.HEAPU8.byteLength || 0;
  if (WASM_CAR_PTR_TABLE_BYTE_OFFSET + (carIndex + 1) * 4 > heapByteLength) return false;
  const dv = new DataView(engine.module.HEAPU8.buffer);
  const cPtr = dv.getInt32(WASM_CAR_PTR_TABLE_BYTE_OFFSET + carIndex * 4, true);
  if (!cPtr || !verifyWasmCarStatePointerLayout(engine, dv, cPtr, carIndex)) return false;

  const O = WASM_CAR_STATE_OFFSETS;
  dv.setUint8(cPtr + O.HAS_JUMPED, reconstructed.hasJumped ? 1 : 0);
  dv.setUint8(cPtr + O.HAS_DOUBLE_JUMPED, reconstructed.hasDoubleJumped ? 1 : 0);
  dv.setUint8(cPtr + O.HAS_FLIPPED, reconstructed.hasFlipped ? 1 : 0);

  dv.setFloat32(cPtr + O.FLIP_REL_TORQUE_X, reconstructed.flipRelTorque[0] || 0, true);
  dv.setFloat32(cPtr + O.FLIP_REL_TORQUE_Y, reconstructed.flipRelTorque[1] || 0, true);
  dv.setFloat32(cPtr + O.FLIP_REL_TORQUE_Z, reconstructed.flipRelTorque[2] || 0, true);

  dv.setFloat32(cPtr + O.JUMP_TIME, reconstructed.jumpTime || 0, true);
  dv.setFloat32(cPtr + O.FLIP_TIME, reconstructed.flipTime || 0, true);
  dv.setUint8(cPtr + O.IS_FLIPPING, reconstructed.isFlipping ? 1 : 0);
  dv.setUint8(cPtr + O.IS_JUMPING, reconstructed.isJumping ? 1 : 0);
  dv.setFloat32(cPtr + O.AIR_TIME, reconstructed.airTime || 0, true);
  dv.setFloat32(cPtr + O.AIR_TIME_SINCE_JUMP, reconstructed.airTimeSinceJump || 0, true);

  dv.setUint8(cPtr + O.IS_BOOSTING, reconstructed.isBoosting ? 1 : 0);
  dv.setFloat32(cPtr + O.BOOSTING_TIME, reconstructed.boostingTime || 0, true);
  dv.setUint8(cPtr + O.IS_SUPERSONIC, reconstructed.isSupersonic ? 1 : 0);
  dv.setFloat32(cPtr + O.SUPERSONIC_TIME, reconstructed.supersonicTime || 0, true);
  dv.setFloat32(cPtr + O.HANDBRAKE_VAL, reconstructed.handbrakeVal || 0, true);
  dv.setUint8(cPtr + O.HAS_WORLD_CONTACT, reconstructed.hasWorldContact ? 1 : 0);

  // Reset ballHitInfo on initial restore so rewinding across a touch never suppresses the extra impulse
  if (resetBallHitInfo) {
    dv.setUint8(cPtr + O.BALL_HIT_INFO_IS_VALID, 0);
    dv.setBigInt64(cPtr + O.BALL_HIT_INFO_TICK_HIT, -1n, true);
    dv.setBigInt64(cPtr + O.BALL_HIT_INFO_TICK_EXTRA_IMPULSE, -1n, true);
  }

  const lc = reconstructed.lastControls;
  if (lc) {
    dv.setFloat32(cPtr + O.LAST_CONTROLS_THROTTLE, Number(lc.throttle || 0), true);
    dv.setFloat32(cPtr + O.LAST_CONTROLS_STEER, Number(lc.steer || 0), true);
    dv.setFloat32(cPtr + O.LAST_CONTROLS_PITCH, Number(lc.pitch || 0), true);
    dv.setFloat32(cPtr + O.LAST_CONTROLS_YAW, Number(lc.yaw || 0), true);
    dv.setFloat32(cPtr + O.LAST_CONTROLS_ROLL, Number(lc.roll || 0), true);
    dv.setUint8(cPtr + O.LAST_CONTROLS_JUMP, lc.jump ? 1 : 0);
    dv.setUint8(cPtr + O.LAST_CONTROLS_BOOST, lc.boost ? 1 : 0);
    dv.setUint8(cPtr + O.LAST_CONTROLS_HANDBRAKE, lc.handbrake ? 1 : 0);
  }
  return true;
}

/**
 * Performs a high-precision compact state restore at `targetFrameIndex` using
 * 1-tick suspension/friction warmup + historical CarState reconstruction.
 */
export function reconstructAndRestoreReplayFrame(
  engine,
  getFrameSlotAt,
  targetFrameIndex,
  restoreOptions = {}
) {
  if (!engine || typeof getFrameSlotAt !== 'function') return false;
  const targetSlot = getFrameSlotAt(targetFrameIndex);
  const targetSnap = targetSlot?.snapshot;
  if (!targetSnap) return false;

  const numCars = Math.min(
    MAX_CARS,
    Math.max(1, Math.round(targetSnap[SIM_OFFSETS.NUM_CARS] || engine.numCars || 1))
  );

  const reconstructedByCar = new Map();
  for (let c = 0; c < numCars; c++) {
    if (typeof engine.isCarSlotActive === 'function' && !engine.isCarSlotActive(c)) continue;
    const rec = reconstructCarTransientStateFromHistory(getFrameSlotAt, targetFrameIndex, c, 300);
    if (rec) {
      reconstructedByCar.set(c, rec);
    }
  }

  // 1-Tick btVehicleRL suspension & wheel friction warmup:
  // Place each car at its last ground-contact frame (gF - 1) and step 1 silent tick to gF
  // so Bullet's btVehicleRL populates wheel raycasts and m_longFriction / m_latFriction caches.
  let warmedFullSnap: Float32Array | null = null;
  if (targetFrameIndex > 0 && typeof engine.stepSilent === 'function') {
    const warmupSnap = new Float32Array(targetSnap);
    for (const [c, rec] of reconstructedByCar.entries()) {
      const warmupIdx = Math.max(0, (rec.lastGroundFrame || targetFrameIndex) - 1);
      const warmupSlot = getFrameSlotAt(warmupIdx);
      const nextWarmupSlot = getFrameSlotAt(warmupIdx + 1) || warmupSlot;
      if (warmupSlot?.snapshot) {
        const cBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
        warmupSnap.subarray(cBase, cBase + CAR_STATE_STRIDE).set(
          warmupSlot.snapshot.subarray(cBase, cBase + CAR_STATE_STRIDE)
        );
        const eBase = 416 + c * 4;
        if (warmupSlot.snapshot.length >= eBase + 4 && warmupSnap.length >= eBase + 4) {
          warmupSnap.subarray(eBase, eBase + 4).set(
            warmupSlot.snapshot.subarray(eBase, eBase + 4)
          );
        }
      }
      const preRec = reconstructCarTransientStateFromHistory(getFrameSlotAt, warmupIdx, c, 180);
      const stepCtrl = extractCarControlsFromFrameList(nextWarmupSlot?.controls, c);
      if (stepCtrl) {
        writeCarControls(engine.module, engine, c, stepCtrl);
      }
      if (preRec) {
        rec._warmupPreRec = preRec;
      }
    }

    // Move ball high above the arena during the 1-tick vehicle warmup so it cannot collide
    warmupSnap[SIM_OFFSETS.BALL + 2] = 1900;
    warmupSnap[SIM_OFFSETS.BALL + 12] = 0;
    warmupSnap[SIM_OFFSETS.BALL + 13] = 0;
    warmupSnap[SIM_OFFSETS.BALL + 14] = 0;

    restoreWasmSnapshotState(engine.module, engine, warmupSnap, restoreOptions);
    for (const [c, rec] of reconstructedByCar.entries()) {
      if (rec._warmupPreRec) {
        patchWasmCarTransientState(engine, c, rec._warmupPreRec);
        delete rec._warmupPreRec;
      }
    }
    engine.stepSilent(1);
    engine.clearEvents?.();
    if (typeof engine.saveState === 'function') {
      warmedFullSnap = engine.saveState();
    }
  }

  // Restore exact targetFrameIndex compact state and patch reconstructed CarState fields
  const ok = restoreWasmSnapshotState(engine.module, engine, targetSnap, restoreOptions);
  const desiredEngineTick = Math.floor(engine.state?.[SIM_OFFSETS.TICK] || 0);
  for (const [c, rec] of reconstructedByCar.entries()) {
    patchWasmCarTransientState(engine, c, rec);
  }

  if (warmedFullSnap && warmedFullSnap.length >= 4233 && typeof engine.saveState === 'function') {
    const currentFullSnap = engine.saveState();
    for (const [c, rec] of reconstructedByCar.entries()) {
      const wheelStart = 169 + c * 508 + 124; // 293 + c * 508 (384 floats per car for 4 wheels)
      if (wheelStart + 384 <= currentFullSnap.length) {
        if (rec.isOnGround) {
          currentFullSnap.subarray(wheelStart, wheelStart + 384).set(
            warmedFullSnap.subarray(wheelStart, warmedFullSnap.length >= wheelStart + 384 ? wheelStart + 384 : warmedFullSnap.length)
          );
        } else {
          for (let w = 0; w < 4; w++) {
            const wOff = wheelStart + w * 96;
            currentFullSnap[wOff + 84] = warmedFullSnap[wOff + 84];
            currentFullSnap[wOff + 85] = warmedFullSnap[wOff + 85];
          }
        }
      }
    }
    restoreWasmSnapshotState(engine.module, engine, currentFullSnap);
    if (engine.state && Number.isFinite(desiredEngineTick)) {
      engine.state[SIM_OFFSETS.TICK] = desiredEngineTick;
    }
    for (const [c, rec] of reconstructedByCar.entries()) {
      patchWasmCarTransientState(engine, c, rec);
    }
  }
  return ok;
}

