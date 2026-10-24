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

export function applyBallStateToEngine(engine, ballState) {
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
      target[21] = carState.isDemoed ? 1 : 0;
    }
    if ('hasFlipOrJump' in carState) {
      target[22] = carState.hasFlipOrJump ? 1 : 0;
    }
    if ('isBoosting' in carState) {
      target[23] = carState.isBoosting ? 1 : 0;
    }
    if ('isFlipping' in carState) {
      target[24] = carState.isFlipping ? 1 : 0;
    }
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
  if (targetBuffer && targetBuffer.length >= len) {
    targetBuffer.set(src);
    return targetBuffer;
  }
  const out = new Float32Array(len);
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
    const copyLen = Math.min(size, engine.state.length);
    engine.state.subarray(0, copyLen).set(
      buffer.subarray ? buffer.subarray(0, copyLen) : buffer.slice(0, copyLen)
    );
    if (typeof options?.overrideTick === 'number' && Number.isFinite(options.overrideTick)) {
      engine.state[SIM_OFFSETS.TICK] = Math.max(16, Math.floor(options.overrideTick));
    } else if (options?.preserveEngineTick) {
      engine.state[SIM_OFFSETS.TICK] = Math.max(16, currentEngineTick);
    }

    if (typeof engine.module?._physics_restoreCompactState === 'function') {
      const ok = engine.module._physics_restoreCompactState(engine.statePtr, copyLen) === 1;
      if (
        ok &&
        typeof engine.module._physics_saveState === 'function' &&
        typeof engine.module._physics_restoreState === 'function'
      ) {
        ensureWasmSnapshotBuffer(engine, fullSnapSize);
        engine.module._physics_saveState(engine.wasmStatePtr);
        const wOffset = engine.wasmStatePtr >> 2;
        const u32 = engine.module.HEAPU32;
        const f32 = engine.module.HEAPF32;
        const restoredTick = Math.floor(engine.state[SIM_OFFSETS.TICK] || 0);
        const numCars = Math.min(
          MAX_CARS,
          Math.max(1, Math.round(buffer[SIM_OFFSETS.NUM_CARS] || engine.numCars || 1))
        );

        // Clear ArenaSnapshotPod.lastBallWorldHitTick (uint64 at words 5..6) if it exceeds restoredTick
        if (u32[wOffset + 5] >= restoredTick || u32[wOffset + 6] > 0) {
          u32[wOffset + 5] = 0;
          u32[wOffset + 6] = 0;
        }

        for (let c = 0; c < numCars; c++) {
          const carOff = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
          const extOff = 416 + c * 4;
          if (carOff + 24 >= copyLen) break;

          const onGround = buffer[carOff + 19] >= 0.5;
          const hasFlipOrJump = buffer[carOff + 22] >= 0.5;
          const isFlipping = buffer[carOff + 24] >= 0.5;
          const isJumping = extOff < copyLen ? buffer[extOff + 0] >= 0.5 : false;
          const airTimeSinceJump = extOff + 3 < copyLen ? buffer[extOff + 3] : 0;

          let hasJumped = 0;
          let hasDoubleJumped = 0;
          let hasFlipped = 0;
          if (!onGround) {
            if (hasFlipOrJump) {
              hasJumped = (isJumping || airTimeSinceJump > 0) ? 1 : 0;
              hasDoubleJumped = 0;
              hasFlipped = 0;
            } else {
              hasJumped = 1;
              if (isFlipping) {
                hasFlipped = 1;
                hasDoubleJumped = 0;
              } else {
                hasDoubleJumped = 1;
                hasFlipped = 0;
              }
            }
          }
          const carSnapBase = wOffset + 169 + c * 504;
          if (carSnapBase + 88 <= wOffset + fullSnapSize) {
            const wheel3Contact = u32[carSnapBase + 35] & 0xff;
            u32[carSnapBase + 35] =
              wheel3Contact |
              (hasJumped << 8) |
              (hasDoubleJumped << 16) |
              (hasFlipped << 24);
            if (!isFlipping) {
              f32[carSnapBase + 41] = 0;
            }
            // Clear stale car.state.ballHitInfo (words 71..87 of CarSnapshotPod) so restored compact
            // snapshots never retain a future tickCountWhenHit from another timeline.
            for (let w = 71; w <= 87; w++) {
              u32[carSnapBase + w] = 0;
            }
          }
        }
        engine.module._physics_restoreState(engine.wasmStatePtr);
      }
      engine.clearEvents?.();
      return ok;
    }
    return true;
  }

  ensureWasmSnapshotBuffer(engine, size);

  const offset = engine.wasmStatePtr >> 2;
  engine.module.HEAPF32.subarray(offset, offset + size).set(buffer);
  const res = engine.module._physics_restoreState(engine.wasmStatePtr);
  engine.clearEvents?.();
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
