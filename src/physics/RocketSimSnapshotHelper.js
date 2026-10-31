/**
 * RocketSimSnapshotHelper.js
 * Event reading, car/ball state mutation, and WASM snapshot serialization helpers
 * for RocketSimPhysicsEngine.
 */

import {
  SIM_OFFSETS,
  MAX_CARS,
  CONTROLS_STRIDE,
  CONTROLS_OFFSETS,
  CAR_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  BALL_STATE_STRIDE,
  NUM_BOOST_PADS,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  PHYSICS_EVENT_TYPES,
  INCIDENT_EVENT_TYPES,
  SURFACE_SUBTYPES
} from './RocketSimConstants.js';

export function writeCarControlsToEngine(engine, carIndex, controls) {
  const buffer = engine.module.HEAPF32.buffer;
  if (!engine.controlsView || engine.controlsView.buffer !== buffer) {
    engine.controlsView = new Float32Array(buffer, engine.controlsPtr, MAX_CARS * CONTROLS_STRIDE);
  }
  const offset = carIndex * CONTROLS_STRIDE;
  const view = engine.controlsView;

  view[offset + CONTROLS_OFFSETS.THROTTLE] = controls.throttle || 0;
  view[offset + CONTROLS_OFFSETS.STEER] = controls.steer || 0;
  view[offset + CONTROLS_OFFSETS.PITCH] = controls.pitch || 0;
  view[offset + CONTROLS_OFFSETS.YAW] = controls.yaw || 0;
  view[offset + CONTROLS_OFFSETS.ROLL] = controls.roll || 0;
  view[offset + CONTROLS_OFFSETS.JUMP] = controls.jump ? 1 : 0;
  view[offset + CONTROLS_OFFSETS.BOOST] = controls.boost ? 1 : 0;
  view[offset + CONTROLS_OFFSETS.HANDBRAKE] = controls.handbrake ? 1 : 0;
}

export function readPhysicsEvents(engine, callback) {
  if (!engine.eventReader) return 0;

  if (engine.module && typeof engine.module._physics_getEventBufferPtr === 'function') {
    const heapBuffer = engine.module.HEAPU8.buffer;
    if (engine.eventReader.buffer !== heapBuffer) {
      engine.eventReader.attach(heapBuffer, engine.eventBufferPtr);
    }
  }

  const wrapCallback = (event) => {
    if (
      event.type === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT &&
      typeof engine.isPointOnGoalBarrier === 'function' &&
      engine.isPointOnGoalBarrier(event.x, event.y, event.z)
    ) {
      event.type = INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT;
      event.subType = SURFACE_SUBTYPES.GOALPOST;
      event.surfaceTag = SURFACE_SUBTYPES.GOALPOST;
      event.isGoalBarrierHit = true;
    } else {
      event.isGoalBarrierHit = false;
    }
    if (callback) callback(event);
  };

  if (engine.eventReader.strideWords === 12) {
    engine.eventReader.ballStateProvider = engine.ballState;
    return engine.eventReader.readEvents((event) => {
      if (event.type === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT || event.type === INCIDENT_EVENT_TYPES.BALL_GOALPOST_HIT) {
        const threshold = (event.surfaceTag === SURFACE_SUBTYPES.FLOOR || event.subType === 1) ? 140.0 : 160.0;
        if (event.normalRelVel < threshold) return;
      }
      if (event.type === INCIDENT_EVENT_TYPES.BOOST_PICKUP || event.type === PHYSICS_EVENT_TYPES.BOOST_PICKUP) {
        const nCars = engine.numCars;
        if (engine.state && nCars > 0 && Number.isFinite(event.x) && Number.isFinite(event.y) && Number.isFinite(event.z)) {
          let bestCarIdx = 0;
          let bestDistSq = Infinity;
          for (let i = 0; i < nCars; i++) {
            if (typeof engine.isCarSlotActive === 'function' && !engine.isCarSlotActive(i)) continue;
            const base = SIM_OFFSETS.CARS + i * CAR_STATE_STRIDE + CAR_STATE_OFFSETS.POS;
            const dx = engine.state[base] - event.x;
            const dy = engine.state[base + 1] - event.y;
            const dz = engine.state[base + 2] - event.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              bestCarIdx = i;
            }
          }
          event.carIndex = bestCarIdx;
        }
      }
      wrapCallback(event);
    });
  }

  return engine.eventReader.readEvents(wrapCallback);
}

export function stepPhysicsEngineWithPadEdgeDetection(engine, ticks = 1) {
  if (!engine?.module) return;

  if (!engine._preStepPadActive || engine._preStepPadActive.length !== NUM_BOOST_PADS) {
    engine._preStepPadActive = new Uint8Array(NUM_BOOST_PADS);
    engine._preStepPadCooldown = new Float32Array(NUM_BOOST_PADS);
  }

  const numSteps = Math.max(1, Math.floor(Number(ticks) || 1));
  const preActive = engine._preStepPadActive;
  const preCooldown = engine._preStepPadCooldown;

  for (let s = 0; s < numSteps; s++) {
    const preSt = engine.state;
    const hasPadSlice =
      preSt && preSt.length >= BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE;

    if (hasPadSlice) {
      for (let p = 0; p < NUM_BOOST_PADS; p++) {
        const base = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
        preActive[p] = preSt[base] >= 0.5 ? 1 : 0;
        preCooldown[p] = preSt[base + 1];
      }
    }

    const writeSeqBefore = engine.eventReader ? engine.eventReader.writeSeq : 0;
    engine.module._physics_step(1);

    const writeSeqAfter = engine.eventReader ? engine.eventReader.writeSeq : 0;
    const u32 = engine.eventReader?.u32View;
    const capacity = engine.eventReader?.capacity || 256;
    const stride = engine.eventReader?.strideWords || 16;
    const scanStart = Math.max(writeSeqBefore, writeSeqAfter - capacity);

    let floorHitThisTick = engine.module._physics_getBallOnGround?.() === 1;
    if (!floorHitThisTick && u32 && writeSeqAfter > scanStart) {
      for (let seq = scanStart; seq < writeSeqAfter; seq++) {
        const slot = seq % capacity;
        const wordOffset = 4 + slot * stride;
        const evType = u32[wordOffset];
        const subType = u32[wordOffset + 12];
        if (
          evType === INCIDENT_EVENT_TYPES.BALL_WORLD_HIT &&
          subType === SURFACE_SUBTYPES.FLOOR
        ) {
          floorHitThisTick = true;
          break;
        }
      }
    }
    engine._ballTouchedFloorInLastStep = Boolean(floorHitThisTick);

    const postSt = engine.state;
    if (!hasPadSlice || !postSt) continue;

    let hasCandidatePickup = false;
    for (let p = 0; p < NUM_BOOST_PADS; p++) {
      const base = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
      const isActive = postSt[base] >= 0.5;
      if (isActive) continue;
      const wasActive = preActive[p] === 1;
      const prevCd = preCooldown[p];
      const currCd = postSt[base + 1];
      if (wasActive || (prevCd > 0 && currCd > prevCd + 0.1)) {
        hasCandidatePickup = true;
        break;
      }
    }

    if (!hasCandidatePickup) continue;

    if (!engine._cachedPads || engine._cachedPadsPreset !== engine.arenaPreset) {
      engine._cachedPads = readArenaPads(engine);
      engine._cachedPadsPreset = engine.arenaPreset;
    }
    const pads = engine._cachedPads;
    const eventTick = Math.max(0, Math.floor(postSt[0] || 0) - 1) >>> 0;

    for (let p = 0; p < NUM_BOOST_PADS; p++) {
      const base = BOOST_PAD_STATES_OFFSET + p * BOOST_PAD_STATE_STRIDE;
      const isActive = postSt[base] >= 0.5;
      if (isActive) continue;

      const wasActive = preActive[p] === 1;
      const prevCd = preCooldown[p];
      const currCd = postSt[base + 1];
      const normalPickup = wasActive && !isActive;
      const sameTickRespawnPickup = !wasActive && !isActive && prevCd > 0 && currCd > prevCd + 0.1;

      if (!normalPickup && !sameTickRespawnPickup) continue;

      let hasNativePickup = false;
      let hasNativeSpawn = false;
      if (u32 && writeSeqAfter > scanStart) {
        for (let seq = scanStart; seq < writeSeqAfter; seq++) {
          const slot = seq % capacity;
          const wordOffset = 4 + slot * stride;
          const evType = u32[wordOffset];
          const secId = (u32[wordOffset + 11] >>> 16) & 0xffff;
          if (secId === p) {
            if (evType === INCIDENT_EVENT_TYPES.BOOST_PICKUP) hasNativePickup = true;
            if (evType === INCIDENT_EVENT_TYPES.BOOST_SPAWN) hasNativeSpawn = true;
          }
        }
      }

      if (hasNativePickup && (!sameTickRespawnPickup || hasNativeSpawn)) continue;

      const padInfo = pads?.[p];
      const padX = padInfo?.pos?.[0] ?? 0;
      const padY = padInfo?.pos?.[1] ?? 0;
      const padZ = padInfo?.pos?.[2] ?? 70;
      const isBig = padInfo ? Boolean(padInfo.isBig) : p < 6;

      if (sameTickRespawnPickup && !hasNativeSpawn) {
        engine.pushSignalEvent(
          INCIDENT_EVENT_TYPES.BOOST_SPAWN,
          eventTick,
          padX,
          padY,
          padZ,
          0,
          0,
          0,
          0xffff,
          p,
          isBig ? 1 : 0,
          0,
          0,
          0
        );
      }

      if (!hasNativePickup) {
        let pickedCarIdx = 0xffff;
        let bestDistSq = Infinity;
        for (let c = 0; c < MAX_CARS; c++) {
          if (typeof engine.isCarSlotActive === 'function' && !engine.isCarSlotActive(c)) continue;
          if (typeof engine.getCarBoostCollectable === 'function' && !engine.getCarBoostCollectable(c)) continue;
          const carBase = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
          if (postSt[carBase + CAR_STATE_OFFSETS.IS_DEMOED] > 0) continue;
          const dx = postSt[carBase + CAR_STATE_OFFSETS.POS] - padX;
          const dy = postSt[carBase + CAR_STATE_OFFSETS.POS + 1] - padY;
          const dz = postSt[carBase + CAR_STATE_OFFSETS.POS + 2] - padZ;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            pickedCarIdx = c;
          }
        }

        engine.pushSignalEvent(
          INCIDENT_EVENT_TYPES.BOOST_PICKUP,
          eventTick,
          padX,
          padY,
          padZ,
          0,
          0,
          0,
          pickedCarIdx,
          p,
          isBig ? 1 : 0,
          0,
          0,
          0
        );
      }
    }
  }
}

export function applyBallStateToEngine(engine, ballState) {
  engine._ballTouchedFloorInLastStep = false;
  if (typeof ballState === 'number') {
    if (typeof engine.module?._physics_setBallState === 'function') {
      engine.module._physics_setBallState(ballState);
      return true;
    }
    return false;
  }

  if (ballState && typeof ballState.length === 'number') {
    const target = engine.getBallState();
    const count = Math.min(ballState.length, BALL_STATE_STRIDE);
    for (let i = 0; i < count; i++) {
      target[i] = ballState[i];
    }
    if (typeof engine.module?._physics_setBallState === 'function') {
      engine.module._physics_setBallState(engine.statePtr + SIM_OFFSETS.BALL * 4);
    }
    return true;
  }

  if (ballState && typeof ballState === 'object') {
    const target = engine.getBallState();
    if (ballState.pos) {
      target[0] = Number(ballState.pos[0] ?? ballState.pos.x ?? 0);
      target[1] = Number(ballState.pos[1] ?? ballState.pos.y ?? 0);
      target[2] = Number(ballState.pos[2] ?? ballState.pos.z ?? 93.15);
    }
    if (ballState.vel) {
      target[12] = Number(ballState.vel[0] ?? ballState.vel.x ?? 0);
      target[13] = Number(ballState.vel[1] ?? ballState.vel.y ?? 0);
      target[14] = Number(ballState.vel[2] ?? ballState.vel.z ?? 0);
    }
    if (ballState.angVel) {
      target[15] = Number(ballState.angVel[0] ?? ballState.angVel.x ?? 0);
      target[16] = Number(ballState.angVel[1] ?? ballState.angVel.y ?? 0);
      target[17] = Number(ballState.angVel[2] ?? ballState.angVel.z ?? 0);
    }
    if (typeof engine.module?._physics_setBallState === 'function') {
      engine.module._physics_setBallState(engine.statePtr + SIM_OFFSETS.BALL * 4);
    }
    return true;
  }
  return false;
}

export function sanitizeCarSliceInPlace(carSlice, carIndex = 0, isTrailingSlot = false) {
  if (!carSlice || carSlice.length < 18) return;

  const px = carSlice[CAR_STATE_OFFSETS.POS];
  const py = carSlice[CAR_STATE_OFFSETS.POS + 1];
  const pz = carSlice[CAR_STATE_OFFSETS.POS + 2];
  if (isTrailingSlot) {
    carSlice[CAR_STATE_OFFSETS.POS] = -5500;
    carSlice[CAR_STATE_OFFSETS.POS + 1] = carIndex * 300;
    carSlice[CAR_STATE_OFFSETS.POS + 2] = -500;
    for (let k = CAR_STATE_OFFSETS.VEL; k < CAR_STATE_OFFSETS.ANG_VEL + 3; k++) {
      carSlice[k] = 0;
    }
  } else if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !Number.isFinite(pz) ||
    Math.abs(px) > 4200 ||
    Math.abs(py) > 6100 ||
    pz < -50 ||
    pz > 2150
  ) {
    const isOrange = (carIndex % 2) === 1;
    carSlice[CAR_STATE_OFFSETS.POS] = (carIndex >> 1) * 300 - 300;
    carSlice[CAR_STATE_OFFSETS.POS + 1] = isOrange ? 4608 : -4608;
    carSlice[CAR_STATE_OFFSETS.POS + 2] = 36;
    for (let k = CAR_STATE_OFFSETS.VEL; k < CAR_STATE_OFFSETS.ANG_VEL + 3; k++) {
      carSlice[k] = 0;
    }
  } else {
    for (let k = CAR_STATE_OFFSETS.VEL; k < CAR_STATE_OFFSETS.ANG_VEL + 3; k++) {
      if (!Number.isFinite(carSlice[k]) || Math.abs(carSlice[k]) > 1e5) carSlice[k] = 0;
    }
  }

  const fx = carSlice[CAR_STATE_OFFSETS.FWD];
  const fy = carSlice[CAR_STATE_OFFSETS.FWD + 1];
  const fz = carSlice[CAR_STATE_OFFSETS.FWD + 2];
  const rx = carSlice[CAR_STATE_OFFSETS.RIGHT];
  const ry = carSlice[CAR_STATE_OFFSETS.RIGHT + 1];
  const rz = carSlice[CAR_STATE_OFFSETS.RIGHT + 2];
  const ux = carSlice[CAR_STATE_OFFSETS.UP];
  const uy = carSlice[CAR_STATE_OFFSETS.UP + 1];
  const uz = carSlice[CAR_STATE_OFFSETS.UP + 2];

  const fLenSq = fx * fx + fy * fy + fz * fz;
  const rLenSq = rx * rx + ry * ry + rz * rz;
  const uLenSq = ux * ux + uy * uy + uz * uz;
  const det =
    fx * (ry * uz - rz * uy) -
    fy * (rx * uz - rz * ux) +
    fz * (rx * uy - ry * ux);

  if (
    !Number.isFinite(fLenSq) || fLenSq < 0.5 || fLenSq > 2.0 ||
    !Number.isFinite(rLenSq) || rLenSq < 0.5 || rLenSq > 2.0 ||
    !Number.isFinite(uLenSq) || uLenSq < 0.5 || uLenSq > 2.0 ||
    !Number.isFinite(det) || Math.abs(det) < 0.2
  ) {
    carSlice[CAR_STATE_OFFSETS.FWD] = 1;
    carSlice[CAR_STATE_OFFSETS.FWD + 1] = 0;
    carSlice[CAR_STATE_OFFSETS.FWD + 2] = 0;
    carSlice[CAR_STATE_OFFSETS.RIGHT] = 0;
    carSlice[CAR_STATE_OFFSETS.RIGHT + 1] = 1;
    carSlice[CAR_STATE_OFFSETS.RIGHT + 2] = 0;
    carSlice[CAR_STATE_OFFSETS.UP] = 0;
    carSlice[CAR_STATE_OFFSETS.UP + 1] = 0;
    carSlice[CAR_STATE_OFFSETS.UP + 2] = 1;
  }

  for (let k = 18; k < carSlice.length; k++) {
    if (!Number.isFinite(carSlice[k])) carSlice[k] = 0;
  }
}

export function applyCarStateToEngine(engine, carIndex, carState) {
  const offset = SIM_OFFSETS.CARS + carIndex * CAR_STATE_STRIDE;
  if (typeof carState === 'number') {
    if (typeof engine.module?._physics_setCarState === 'function') {
      engine.module._physics_setCarState(carIndex, carState);
      return true;
    }
    return false;
  }

  if (carState && typeof carState.length === 'number') {
    const target = engine.getCarState(carIndex);
    const count = Math.min(carState.length, CAR_STATE_STRIDE);
    for (let i = 0; i < count; i++) {
      target[i] = carState[i];
    }
    sanitizeCarSliceInPlace(target, carIndex, false);
    if (typeof engine.module?._physics_setCarState === 'function') {
      engine.module._physics_setCarState(carIndex, engine.statePtr + offset * 4);
    }
    return true;
  }

  if (carState && typeof carState === 'object') {
    const target = engine.getCarState(carIndex);
    const assertFinite = (val, name) => {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw new Error(`[RocketSimPhysicsEngine] setCarState non-finite or invalid number for ${name}: ${val}`);
      }
      return val;
    };

    if (carState.pos) {
      target[CAR_STATE_OFFSETS.POS] = assertFinite(carState.pos[0] ?? carState.pos.x ?? 0, 'pos.x');
      target[CAR_STATE_OFFSETS.POS + 1] = assertFinite(carState.pos[1] ?? carState.pos.y ?? 0, 'pos.y');
      target[CAR_STATE_OFFSETS.POS + 2] = assertFinite(carState.pos[2] ?? carState.pos.z ?? 0, 'pos.z');
    } else {
      if ('posX' in carState) target[CAR_STATE_OFFSETS.POS] = assertFinite(carState.posX, 'posX');
      if ('posY' in carState) target[CAR_STATE_OFFSETS.POS + 1] = assertFinite(carState.posY, 'posY');
      if ('posZ' in carState) target[CAR_STATE_OFFSETS.POS + 2] = assertFinite(carState.posZ, 'posZ');
    }
    const fwdVec = carState.fwd || carState.forward;
    if (fwdVec) {
      target[CAR_STATE_OFFSETS.FWD] = assertFinite(fwdVec[0] ?? fwdVec.x ?? 1, 'fwd.x');
      target[CAR_STATE_OFFSETS.FWD + 1] = assertFinite(fwdVec[1] ?? fwdVec.y ?? 0, 'fwd.y');
      target[CAR_STATE_OFFSETS.FWD + 2] = assertFinite(fwdVec[2] ?? fwdVec.z ?? 0, 'fwd.z');
    } else if ('fwdX' in carState || 'fwdY' in carState || 'fwdZ' in carState) {
      if ('fwdX' in carState) target[CAR_STATE_OFFSETS.FWD] = assertFinite(carState.fwdX, 'fwdX');
      if ('fwdY' in carState) target[CAR_STATE_OFFSETS.FWD + 1] = assertFinite(carState.fwdY, 'fwdY');
      if ('fwdZ' in carState) target[CAR_STATE_OFFSETS.FWD + 2] = assertFinite(carState.fwdZ, 'fwdZ');
    } else if (carState.rot) {
      const pitch = assertFinite(carState.rot[0] ?? carState.rot.pitch ?? carState.rot.x ?? 0, 'rot.pitch');
      const yaw = assertFinite(carState.rot[1] ?? carState.rot.yaw ?? carState.rot.y ?? 0, 'rot.yaw');
      const roll = assertFinite(carState.rot[2] ?? carState.rot.roll ?? carState.rot.z ?? 0, 'rot.roll');
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      target[CAR_STATE_OFFSETS.FWD] = cy * cp;
      target[CAR_STATE_OFFSETS.FWD + 1] = sy * cp;
      target[CAR_STATE_OFFSETS.FWD + 2] = sp;
      if (!carState.right) {
        target[CAR_STATE_OFFSETS.RIGHT] = cy * sp * sr - sy * cr;
        target[CAR_STATE_OFFSETS.RIGHT + 1] = sy * sp * sr + cy * cr;
        target[CAR_STATE_OFFSETS.RIGHT + 2] = -cp * sr;
      }
      if (!carState.up) {
        target[CAR_STATE_OFFSETS.UP] = -cy * sp * cr - sy * sr;
        target[CAR_STATE_OFFSETS.UP + 1] = -sy * sp * cr + cy * sr;
        target[CAR_STATE_OFFSETS.UP + 2] = cp * cr;
      }
    }
    if (carState.right) {
      target[CAR_STATE_OFFSETS.RIGHT] = assertFinite(carState.right[0] ?? carState.right.x ?? 0, 'right.x');
      target[CAR_STATE_OFFSETS.RIGHT + 1] = assertFinite(carState.right[1] ?? carState.right.y ?? 1, 'right.y');
      target[CAR_STATE_OFFSETS.RIGHT + 2] = assertFinite(carState.right[2] ?? carState.right.z ?? 0, 'right.z');
    }
    if (carState.up) {
      target[CAR_STATE_OFFSETS.UP] = assertFinite(carState.up[0] ?? carState.up.x ?? 0, 'up.x');
      target[CAR_STATE_OFFSETS.UP + 1] = assertFinite(carState.up[1] ?? carState.up.y ?? 0, 'up.y');
      target[CAR_STATE_OFFSETS.UP + 2] = assertFinite(carState.up[2] ?? carState.up.z ?? 1, 'up.z');
    }
    if (carState.vel) {
      target[CAR_STATE_OFFSETS.VEL] = assertFinite(carState.vel[0] ?? carState.vel.x ?? 0, 'vel.x');
      target[CAR_STATE_OFFSETS.VEL + 1] = assertFinite(carState.vel[1] ?? carState.vel.y ?? 0, 'vel.y');
      target[CAR_STATE_OFFSETS.VEL + 2] = assertFinite(carState.vel[2] ?? carState.vel.z ?? 0, 'vel.z');
    } else {
      if ('velX' in carState) target[CAR_STATE_OFFSETS.VEL] = assertFinite(carState.velX, 'velX');
      if ('velY' in carState) target[CAR_STATE_OFFSETS.VEL + 1] = assertFinite(carState.velY, 'velY');
      if ('velZ' in carState) target[CAR_STATE_OFFSETS.VEL + 2] = assertFinite(carState.velZ, 'velZ');
    }
    if (carState.angVel) {
      target[CAR_STATE_OFFSETS.ANG_VEL] = assertFinite(carState.angVel[0] ?? carState.angVel.x ?? 0, 'angVel.x');
      target[CAR_STATE_OFFSETS.ANG_VEL + 1] = assertFinite(carState.angVel[1] ?? carState.angVel.y ?? 0, 'angVel.y');
      target[CAR_STATE_OFFSETS.ANG_VEL + 2] = assertFinite(carState.angVel[2] ?? carState.angVel.z ?? 0, 'angVel.z');
    }
    if ('boost' in carState) {
      target[CAR_STATE_OFFSETS.BOOST] = assertFinite(carState.boost, 'boost');
    }
    if ('isOnGround' in carState) {
      target[19] = carState.isOnGround ? 1 : 0;
    }
    if ('isSupersonic' in carState) {
      target[20] = carState.isSupersonic ? 1 : 0;
    }
    if ('isDemoed' in carState) {
      target[21] = carState.isDemoed
        ? (typeof carState.demoRespawnTimer === 'number' && carState.demoRespawnTimer > 0 ? carState.demoRespawnTimer : 3.0)
        : 0;
    }
    if ('hasFlipOrJump' in carState) {
      target[22] = typeof carState.flipsRemaining === 'number'
        ? carState.flipsRemaining
        : (carState.hasFlipOrJump ? 1 : 0);
    }
    if ('isBoosting' in carState) {
      target[23] = carState.isBoosting ? 1 : 0;
    }
    if ('isFlipping' in carState) {
      target[24] = carState.isFlipping ? 1 : 0;
    }
    sanitizeCarSliceInPlace(target, carIndex, false);
    if (typeof engine.module?._physics_setCarState === 'function') {
      engine.module._physics_setCarState(carIndex, engine.statePtr + offset * 4);
    }
    return true;
  }
  return false;
}

export function ensureWasmSnapshotBuffer(engine, size) {
  if (!engine.wasmStatePtr || engine.wasmStateSize < size) {
    if (engine.wasmStatePtr && engine.module && typeof engine.module._free === 'function') {
      engine.module._free(engine.wasmStatePtr);
    }
    engine.wasmStatePtr = engine.module._malloc(size * 4);
    engine.wasmStateSize = size;
    engine.cachedSnapshotBuffer = new Float32Array(size);
  }
}

export function saveWasmSnapshotState(engine, targetBuffer = null) {
  const size = engine.getStateSnapshotSize();
  ensureWasmSnapshotBuffer(engine, size);

  engine.module._physics_saveState(engine.wasmStatePtr);

  const offset = engine.wasmStatePtr >> 2;
  const wasmSlice = engine.module.HEAPF32.subarray(offset, offset + size);

  if (targetBuffer) {
    targetBuffer.set(wasmSlice);
    return targetBuffer;
  }

  const buf = new Float32Array(size);
  buf.set(wasmSlice);
  return buf;
}

export function saveCompactStateSnapshot(engine, targetBuffer = null) {
  const src = engine.state;
  const len = src.length; // 448 floats (1,792 bytes)
  const out = (targetBuffer && targetBuffer.length >= len)
    ? targetBuffer
    : new Float32Array(len);
  out.set(src);
  return out;
}

export function setCarTeamInWasm(engine, carIndex, team) {
  if (!engine?.module || carIndex < 0 || carIndex >= MAX_CARS) return false;
  if (typeof engine.module._physics_setCarTeam === 'function') {
    return engine.module._physics_setCarTeam(carIndex, team ? 1 : 0) === 1;
  }
  return false;
}

export function restoreWasmSnapshotState(engine, buffer, options = {}) {
  if (!buffer) return false;
  const size = buffer.length;
  const fullSnapSize = typeof engine.getStateSnapshotSize === 'function'
    ? engine.getStateSnapshotSize()
    : 4201;

  // Compact 448-float GameStateBufferPod fast-path (used by WebRTC, PredictionReconciler & Replay RingBuffer)
  if (size <= engine.stateLen && size < fullSnapSize) {
    const currentEngineTick = Math.floor(engine.state?.[SIM_OFFSETS.TICK] || 0);
    const preservedActiveCars = new Map();
    if (typeof engine.isCarSlotActive === 'function' && engine.state) {
      for (let c = 0; c < MAX_CARS; c++) {
        if (!engine.isCarSlotActive(c)) continue;
        const carOff = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
        if (carOff + CAR_STATE_STRIDE > size || carOff + CAR_STATE_STRIDE > engine.state.length) continue;
        const bufPx = buffer[carOff];
        const bufPy = buffer[carOff + 1];
        const bufPz = buffer[carOff + 2];
        const bufIsStagingOrInvalid =
          !Number.isFinite(bufPx) ||
          !Number.isFinite(bufPy) ||
          !Number.isFinite(bufPz) ||
          bufPx <= -5000 ||
          bufPz < -100;
        if (bufIsStagingOrInvalid) {
          const curPx = engine.state[carOff];
          const curPy = engine.state[carOff + 1];
          const curPz = engine.state[carOff + 2];
          if (
            Number.isFinite(curPx) &&
            Number.isFinite(curPy) &&
            Number.isFinite(curPz) &&
            Math.abs(curPx) <= 4200 &&
            Math.abs(curPy) <= 6100 &&
            curPz >= -50 &&
            curPz <= 2150
          ) {
            preservedActiveCars.set(c, engine.state.slice(carOff, carOff + CAR_STATE_STRIDE));
          }
        }
      }
    }

    const copyLen = Math.min(size, engine.state.length);
    engine.state.subarray(0, copyLen).set(
      buffer.subarray ? buffer.subarray(0, copyLen) : buffer.slice(0, copyLen)
    );
    for (const [c, savedSlice] of preservedActiveCars.entries()) {
      const carOff = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      engine.state.subarray(carOff, carOff + CAR_STATE_STRIDE).set(savedSlice);
    }
    if (typeof options?.overrideTick === 'number' && Number.isFinite(options.overrideTick)) {
      engine.state[SIM_OFFSETS.TICK] = Math.max(16, Math.floor(options.overrideTick));
    } else if (options?.preserveEngineTick) {
      engine.state[SIM_OFFSETS.TICK] = Math.max(16, currentEngineTick);
    }

    // Sanitize ball (0..2 pos, 3..11 rotMat, 12..14 vel, 15..17 angVel) and all car slots before restoring into Bullet WASM
    const ballOff = SIM_OFFSETS.BALL;
    const bPx = engine.state[ballOff];
    const bPy = engine.state[ballOff + 1];
    const bPz = engine.state[ballOff + 2];
    if (
      !Number.isFinite(bPx) ||
      !Number.isFinite(bPy) ||
      !Number.isFinite(bPz) ||
      Math.abs(bPx) > 4200 ||
      Math.abs(bPy) > 6100 ||
      bPz < -50 ||
      bPz > 2150
    ) {
      engine.state[ballOff] = 0;
      engine.state[ballOff + 1] = 0;
      engine.state[ballOff + 2] = 93.15;
      engine.state[ballOff + 3] = 1;
      engine.state[ballOff + 4] = 0;
      engine.state[ballOff + 5] = 0;
      engine.state[ballOff + 6] = 0;
      engine.state[ballOff + 7] = 1;
      engine.state[ballOff + 8] = 0;
      engine.state[ballOff + 9] = 0;
      engine.state[ballOff + 10] = 0;
      engine.state[ballOff + 11] = 1;
      for (let k = 12; k < BALL_STATE_STRIDE; k++) engine.state[ballOff + k] = 0;
    } else {
      const bR0Sq =
        engine.state[ballOff + 3] * engine.state[ballOff + 3] +
        engine.state[ballOff + 4] * engine.state[ballOff + 4] +
        engine.state[ballOff + 5] * engine.state[ballOff + 5];
      if (!Number.isFinite(bR0Sq) || bR0Sq < 0.25 || bR0Sq > 2.5) {
        engine.state[ballOff + 3] = 1;
        engine.state[ballOff + 4] = 0;
        engine.state[ballOff + 5] = 0;
        engine.state[ballOff + 6] = 0;
        engine.state[ballOff + 7] = 1;
        engine.state[ballOff + 8] = 0;
        engine.state[ballOff + 9] = 0;
        engine.state[ballOff + 10] = 0;
        engine.state[ballOff + 11] = 1;
      }
      for (let k = 12; k < BALL_STATE_STRIDE; k++) {
        if (!Number.isFinite(engine.state[ballOff + k]) || Math.abs(engine.state[ballOff + k]) > 1e5) {
          engine.state[ballOff + k] = 0;
        }
      }
    }

    const bufferNumCars = Math.min(
      MAX_CARS,
      Math.max(1, Math.round(buffer[SIM_OFFSETS.NUM_CARS] || engine.numCars || 1))
    );
    const totalSlotsToSanitize = Math.min(MAX_CARS, Math.max(engine.numCars || 1, bufferNumCars));
    const dirTelemetryOff = SIM_OFFSETS.CARS + 7 * CAR_STATE_STRIDE;
    const hasEmbeddedDirectorTelemetry =
      bufferNumCars <= 7 &&
      dirTelemetryOff + 10 <= buffer.length &&
      Math.abs(buffer[dirTelemetryOff] - 1337.5) <= 0.01;
    const savedDirectorTelemetry = hasEmbeddedDirectorTelemetry
      ? buffer.slice(dirTelemetryOff, Math.min(buffer.length, dirTelemetryOff + 12))
      : null;

    for (let c = 0; c < totalSlotsToSanitize; c++) {
      if (c === 7 && hasEmbeddedDirectorTelemetry) continue;
      const carOff = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      if (carOff + CAR_STATE_STRIDE <= engine.state.length) {
        const carSlice = engine.state.subarray(carOff, carOff + CAR_STATE_STRIDE);
        const isSlotInactive = typeof engine.isCarSlotActive === 'function'
          ? !engine.isCarSlotActive(c)
          : (c >= bufferNumCars);
        sanitizeCarSliceInPlace(carSlice, c, isSlotInactive);
      }
    }

    if (typeof engine.module?._physics_restoreCompactState === 'function') {
      const ok = engine.module._physics_restoreCompactState(engine.statePtr, copyLen) === 1;
      if (savedDirectorTelemetry && dirTelemetryOff + savedDirectorTelemetry.length <= engine.state.length) {
        engine.state.subarray(dirTelemetryOff, dirTelemetryOff + savedDirectorTelemetry.length).set(savedDirectorTelemetry);
      }
      return ok;
    }
    if (savedDirectorTelemetry && dirTelemetryOff + savedDirectorTelemetry.length <= engine.state.length) {
      engine.state.subarray(dirTelemetryOff, dirTelemetryOff + savedDirectorTelemetry.length).set(savedDirectorTelemetry);
    }
    return true;
  }

  ensureWasmSnapshotBuffer(engine, size);

  const offset = engine.wasmStatePtr >> 2;
  engine.module.HEAPF32.subarray(offset, offset + size).set(buffer);
  const res = engine.module._physics_restoreState(engine.wasmStatePtr);
  return res === 1;
}

export function readArenaPads(engine) {
  const numPads = engine.getHeaderView().numPads;
  const padPtr = engine.module._physics_getPadInfoPtr();
  const padView = new Float32Array(engine.module.HEAPF32.buffer, padPtr, numPads * 4);

  return Array.from({ length: numPads }, (_, idx) => ({
    pos: [padView[idx * 4], padView[idx * 4 + 1], padView[idx * 4 + 2]],
    isBig: padView[idx * 4 + 3] === 1
  }));
}

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

  // 4. Reconstruct handbrakeVal ([0, 1] ramp: +5.0/s when held, -2.0/s when released)
  let handbrakeVal = 0;
  for (let f = startLookback; f <= targetFrameIndex; f++) {
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
export function patchWasmCarTransientState(engine, carIndex, reconstructed, resetBallHitInfo = true) {
  if (!engine?.module?.HEAPU8?.buffer || !reconstructed) return false;
  const dv = new DataView(engine.module.HEAPU8.buffer);
  const cPtr = dv.getInt32(WASM_CAR_PTR_TABLE_BYTE_OFFSET + carIndex * 4, true);
  if (!cPtr) return false;

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
  let warmedFullSnap = null;
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
        writeCarControlsToEngine(engine, c, stepCtrl);
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

    restoreWasmSnapshotState(engine, warmupSnap, restoreOptions);
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
  const ok = restoreWasmSnapshotState(engine, targetSnap, restoreOptions);
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
    restoreWasmSnapshotState(engine, currentFullSnap);
    if (engine.state && Number.isFinite(desiredEngineTick)) {
      engine.state[SIM_OFFSETS.TICK] = desiredEngineTick;
    }
    for (const [c, rec] of reconstructedByCar.entries()) {
      patchWasmCarTransientState(engine, c, rec);
    }
  }
  return ok;
}

