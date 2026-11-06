/**
 * RocketSimSnapshotSerializer.ts
 * Pure WASM linear-memory snapshot serializer and car/ball state mutator
 * operating over narrowed (wasmModule, memoryViews) interfaces.
 */

import {
  SIM_OFFSETS,
  MAX_CARS,
  CONTROLS_STRIDE,
  CONTROLS_OFFSETS,
  CAR_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  BALL_STATE_STRIDE,
} from './RocketSimConstants.ts';

export interface RocketSimWasmModule {
  HEAPF32: Float32Array;
  _malloc(byteLength: number): number;
  _free?(bytePtr: number): void;
  _physics_addCarAtSlot?(slot: number, team: number, hitboxIndex: number): number;
  _physics_getCarThreeWheels?(carIndex: number): number;
  _physics_setCarThreeWheels?(carIndex: number, enabled: number): number;
  _physics_setBallState?(bytePtr: number): void;
  _physics_setCarState?(carIndex: number, bytePtr: number): void;
  _physics_setCarTeam?(carIndex: number, team: number): number;
  _physics_getStateSnapshotSize?(): number;
  _physics_saveState(bytePtr: number): void;
  _physics_restoreState(bytePtr: number): number;
  _physics_restoreCompactState?(bytePtr: number, floatCount: number): number;
  _physics_getPadInfoPtr(): number;
  _physics_isCarSlotActive?(slot: number): number;
  _physics_getActiveCarMask?(): number;
}

export interface RocketSimSnapshotMemoryViews {
  readonly statePtr: number;
  readonly stateLen: number;
  readonly controlsPtr: number;
  readonly state: Float32Array;
  controlsView: Float32Array | null;
  wasmStatePtr: number;
  wasmStateSize: number;
  cachedSnapshotBuffer: Float32Array | null;
  isCarSlotActive?: (carIndex: number) => boolean;
}

export interface CarControlsInput {
  throttle?: number;
  steer?: number;
  pitch?: number;
  yaw?: number;
  roll?: number;
  jump?: boolean | number;
  boost?: boolean | number;
  handbrake?: boolean | number;
}

export interface Vector3Like {
  0?: number; 1?: number; 2?: number;
  x?: number; y?: number; z?: number;
}

export interface EulerRotationLike extends Vector3Like {
  pitch?: number; yaw?: number; roll?: number;
}

export interface BallStateObjectInput {
  pos?: Vector3Like;
  vel?: Vector3Like;
  angVel?: Vector3Like;
}

export interface CarStateObjectInput {
  pos?: Vector3Like; posX?: number; posY?: number; posZ?: number;
  fwd?: Vector3Like; forward?: Vector3Like; fwdX?: number; fwdY?: number; fwdZ?: number;
  rot?: EulerRotationLike;
  right?: Vector3Like;
  up?: Vector3Like;
  vel?: Vector3Like; velX?: number; velY?: number; velZ?: number;
  angVel?: Vector3Like;
  boost?: number;
  isOnGround?: boolean | number;
  isSupersonic?: boolean | number;
  isDemoed?: boolean | number;
  demoRespawnTimer?: number;
  hasFlipOrJump?: boolean | number;
  flipsRemaining?: number;
  isBoosting?: boolean | number;
  isFlipping?: boolean | number;
}

export interface RestoreSnapshotOptions {
  overrideTick?: number;
  preserveEngineTick?: boolean;
}

export interface ArenaBoostPadDescriptor {
  pos: [number, number, number];
  isBig: boolean;
}

export type NumericBufferLike = ArrayLike<number> & {
  subarray?: (begin: number, end?: number) => ArrayLike<number>;
  slice?: (begin: number, end?: number) => ArrayLike<number>;
};

export function writeCarControls(
  wasmModule: RocketSimWasmModule,
  memoryViews: RocketSimSnapshotMemoryViews,
  carIndex: number,
  controls: CarControlsInput
): void {
  const buffer = wasmModule.HEAPF32.buffer;
  if (!memoryViews.controlsView || memoryViews.controlsView.buffer !== buffer) {
    memoryViews.controlsView = new Float32Array(buffer, memoryViews.controlsPtr, MAX_CARS * CONTROLS_STRIDE);
  }
  const offset = carIndex * CONTROLS_STRIDE;
  const view = memoryViews.controlsView;

  view[offset + CONTROLS_OFFSETS.THROTTLE] = controls.throttle || 0;
  view[offset + CONTROLS_OFFSETS.STEER] = controls.steer || 0;
  view[offset + CONTROLS_OFFSETS.PITCH] = controls.pitch || 0;
  view[offset + CONTROLS_OFFSETS.YAW] = controls.yaw || 0;
  view[offset + CONTROLS_OFFSETS.ROLL] = controls.roll || 0;
  view[offset + CONTROLS_OFFSETS.JUMP] = controls.jump ? 1 : 0;
  view[offset + CONTROLS_OFFSETS.BOOST] = controls.boost ? 1 : 0;
  view[offset + CONTROLS_OFFSETS.HANDBRAKE] = controls.handbrake ? 1 : 0;
}

export function applyBallState(
  wasmModule: RocketSimWasmModule | null | undefined,
  memoryViews: RocketSimSnapshotMemoryViews,
  ballState: number | ArrayLike<number> | BallStateObjectInput | null | undefined
): boolean {
  if (typeof ballState === 'number') {
    if (typeof wasmModule?._physics_setBallState === 'function') {
      wasmModule._physics_setBallState(ballState);
      return true;
    }
    return false;
  }

  const target = memoryViews.state.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE);

  if (ballState && typeof (ballState as ArrayLike<number>).length === 'number') {
    const seq = ballState as ArrayLike<number>;
    const count = Math.min(seq.length, BALL_STATE_STRIDE);
    for (let i = 0; i < count; i++) target[i] = seq[i];
    if (typeof wasmModule?._physics_setBallState === 'function') {
      wasmModule._physics_setBallState(memoryViews.statePtr + SIM_OFFSETS.BALL * 4);
    }
    return true;
  }

  if (ballState && typeof ballState === 'object') {
    const obj = ballState as BallStateObjectInput;
    if (obj.pos) {
      target[0] = Number(obj.pos[0] ?? obj.pos.x ?? 0);
      target[1] = Number(obj.pos[1] ?? obj.pos.y ?? 0);
      target[2] = Number(obj.pos[2] ?? obj.pos.z ?? 93.15);
    }
    if (obj.vel) {
      target[12] = Number(obj.vel[0] ?? obj.vel.x ?? 0);
      target[13] = Number(obj.vel[1] ?? obj.vel.y ?? 0);
      target[14] = Number(obj.vel[2] ?? obj.vel.z ?? 0);
    }
    if (obj.angVel) {
      target[15] = Number(obj.angVel[0] ?? obj.angVel.x ?? 0);
      target[16] = Number(obj.angVel[1] ?? obj.angVel.y ?? 0);
      target[17] = Number(obj.angVel[2] ?? obj.angVel.z ?? 0);
    }
    if (typeof wasmModule?._physics_setBallState === 'function') {
      wasmModule._physics_setBallState(memoryViews.statePtr + SIM_OFFSETS.BALL * 4);
    }
    return true;
  }
  return false;
}

export function sanitizeCarSliceInPlace(
  carSlice: Float32Array | null | undefined,
  carIndex: number = 0,
  isTrailingSlot: boolean = false
): void {
  if (!carSlice || carSlice.length < 18) return;

  const px = carSlice[CAR_STATE_OFFSETS.POS];
  const py = carSlice[CAR_STATE_OFFSETS.POS + 1];
  const pz = carSlice[CAR_STATE_OFFSETS.POS + 2];
  if (isTrailingSlot) {
    carSlice[CAR_STATE_OFFSETS.POS] = -5500;
    carSlice[CAR_STATE_OFFSETS.POS + 1] = carIndex * 300;
    carSlice[CAR_STATE_OFFSETS.POS + 2] = -500;
    for (let k = CAR_STATE_OFFSETS.VEL; k < CAR_STATE_OFFSETS.ANG_VEL + 3; k++) carSlice[k] = 0;
  } else if (
    !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) ||
    Math.abs(px) > 4200 || Math.abs(py) > 6100 || pz < -50 || pz > 2150
  ) {
    const isOrange = carIndex % 2 === 1;
    carSlice[CAR_STATE_OFFSETS.POS] = (carIndex >> 1) * 300 - 300;
    carSlice[CAR_STATE_OFFSETS.POS + 1] = isOrange ? 4608 : -4608;
    carSlice[CAR_STATE_OFFSETS.POS + 2] = 36;
    for (let k = CAR_STATE_OFFSETS.VEL; k < CAR_STATE_OFFSETS.ANG_VEL + 3; k++) carSlice[k] = 0;
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
  const det = fx * (ry * uz - rz * uy) - fy * (rx * uz - rz * ux) + fz * (rx * uy - ry * ux);

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

export function applyCarState(
  wasmModule: RocketSimWasmModule | null | undefined,
  memoryViews: RocketSimSnapshotMemoryViews,
  carIndex: number,
  carState: number | ArrayLike<number> | CarStateObjectInput | null | undefined
): boolean {
  const offset = SIM_OFFSETS.CARS + carIndex * CAR_STATE_STRIDE;
  if (typeof carState === 'number') {
    if (typeof wasmModule?._physics_setCarState === 'function') {
      wasmModule._physics_setCarState(carIndex, carState);
      return true;
    }
    return false;
  }

  const target = memoryViews.state.subarray(offset, offset + CAR_STATE_STRIDE);

  if (carState && typeof (carState as ArrayLike<number>).length === 'number') {
    const seq = carState as ArrayLike<number>;
    const count = Math.min(seq.length, CAR_STATE_STRIDE);
    for (let i = 0; i < count; i++) target[i] = seq[i];
    sanitizeCarSliceInPlace(target, carIndex, false);
    if (typeof wasmModule?._physics_setCarState === 'function') {
      wasmModule._physics_setCarState(carIndex, memoryViews.statePtr + offset * 4);
    }
    return true;
  }

  if (carState && typeof carState === 'object') {
    const obj = carState as CarStateObjectInput;
    const assertFinite = (val: unknown, name: string): number => {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw new Error(`[RocketSimPhysicsEngine] setCarState non-finite or invalid number for ${name}: ${val}`);
      }
      return val;
    };

    if (obj.pos) {
      target[CAR_STATE_OFFSETS.POS] = assertFinite(obj.pos[0] ?? obj.pos.x ?? 0, 'pos.x');
      target[CAR_STATE_OFFSETS.POS + 1] = assertFinite(obj.pos[1] ?? obj.pos.y ?? 0, 'pos.y');
      target[CAR_STATE_OFFSETS.POS + 2] = assertFinite(obj.pos[2] ?? obj.pos.z ?? 0, 'pos.z');
    } else {
      if ('posX' in obj) target[CAR_STATE_OFFSETS.POS] = assertFinite(obj.posX, 'posX');
      if ('posY' in obj) target[CAR_STATE_OFFSETS.POS + 1] = assertFinite(obj.posY, 'posY');
      if ('posZ' in obj) target[CAR_STATE_OFFSETS.POS + 2] = assertFinite(obj.posZ, 'posZ');
    }

    const fwdVec = obj.fwd || obj.forward;
    if (fwdVec) {
      target[CAR_STATE_OFFSETS.FWD] = assertFinite(fwdVec[0] ?? fwdVec.x ?? 1, 'fwd.x');
      target[CAR_STATE_OFFSETS.FWD + 1] = assertFinite(fwdVec[1] ?? fwdVec.y ?? 0, 'fwd.y');
      target[CAR_STATE_OFFSETS.FWD + 2] = assertFinite(fwdVec[2] ?? fwdVec.z ?? 0, 'fwd.z');
    } else if ('fwdX' in obj || 'fwdY' in obj || 'fwdZ' in obj) {
      if ('fwdX' in obj) target[CAR_STATE_OFFSETS.FWD] = assertFinite(obj.fwdX, 'fwdX');
      if ('fwdY' in obj) target[CAR_STATE_OFFSETS.FWD + 1] = assertFinite(obj.fwdY, 'fwdY');
      if ('fwdZ' in obj) target[CAR_STATE_OFFSETS.FWD + 2] = assertFinite(obj.fwdZ, 'fwdZ');
    } else if (obj.rot) {
      const pitch = assertFinite(obj.rot[0] ?? obj.rot.pitch ?? obj.rot.x ?? 0, 'rot.pitch');
      const yaw = assertFinite(obj.rot[1] ?? obj.rot.yaw ?? obj.rot.y ?? 0, 'rot.yaw');
      const roll = assertFinite(obj.rot[2] ?? obj.rot.roll ?? obj.rot.z ?? 0, 'rot.roll');
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      target[CAR_STATE_OFFSETS.FWD] = cy * cp;
      target[CAR_STATE_OFFSETS.FWD + 1] = sy * cp;
      target[CAR_STATE_OFFSETS.FWD + 2] = sp;
      if (!obj.right) {
        target[CAR_STATE_OFFSETS.RIGHT] = cy * sp * sr - sy * cr;
        target[CAR_STATE_OFFSETS.RIGHT + 1] = sy * sp * sr + cy * cr;
        target[CAR_STATE_OFFSETS.RIGHT + 2] = -cp * sr;
      }
      if (!obj.up) {
        target[CAR_STATE_OFFSETS.UP] = -cy * sp * cr - sy * sr;
        target[CAR_STATE_OFFSETS.UP + 1] = -sy * sp * cr + cy * sr;
        target[CAR_STATE_OFFSETS.UP + 2] = cp * cr;
      }
    }

    if (obj.right) {
      target[CAR_STATE_OFFSETS.RIGHT] = assertFinite(obj.right[0] ?? obj.right.x ?? 0, 'right.x');
      target[CAR_STATE_OFFSETS.RIGHT + 1] = assertFinite(obj.right[1] ?? obj.right.y ?? 1, 'right.y');
      target[CAR_STATE_OFFSETS.RIGHT + 2] = assertFinite(obj.right[2] ?? obj.right.z ?? 0, 'right.z');
    }
    if (obj.up) {
      target[CAR_STATE_OFFSETS.UP] = assertFinite(obj.up[0] ?? obj.up.x ?? 0, 'up.x');
      target[CAR_STATE_OFFSETS.UP + 1] = assertFinite(obj.up[1] ?? obj.up.y ?? 0, 'up.y');
      target[CAR_STATE_OFFSETS.UP + 2] = assertFinite(obj.up[2] ?? obj.up.z ?? 1, 'up.z');
    }
    if (obj.vel) {
      target[CAR_STATE_OFFSETS.VEL] = assertFinite(obj.vel[0] ?? obj.vel.x ?? 0, 'vel.x');
      target[CAR_STATE_OFFSETS.VEL + 1] = assertFinite(obj.vel[1] ?? obj.vel.y ?? 0, 'vel.y');
      target[CAR_STATE_OFFSETS.VEL + 2] = assertFinite(obj.vel[2] ?? obj.vel.z ?? 0, 'vel.z');
    } else {
      if ('velX' in obj) target[CAR_STATE_OFFSETS.VEL] = assertFinite(obj.velX, 'velX');
      if ('velY' in obj) target[CAR_STATE_OFFSETS.VEL + 1] = assertFinite(obj.velY, 'velY');
      if ('velZ' in obj) target[CAR_STATE_OFFSETS.VEL + 2] = assertFinite(obj.velZ, 'velZ');
    }
    if (obj.angVel) {
      target[CAR_STATE_OFFSETS.ANG_VEL] = assertFinite(obj.angVel[0] ?? obj.angVel.x ?? 0, 'angVel.x');
      target[CAR_STATE_OFFSETS.ANG_VEL + 1] = assertFinite(obj.angVel[1] ?? obj.angVel.y ?? 0, 'angVel.y');
      target[CAR_STATE_OFFSETS.ANG_VEL + 2] = assertFinite(obj.angVel[2] ?? obj.angVel.z ?? 0, 'angVel.z');
    }
    if ('boost' in obj) target[CAR_STATE_OFFSETS.BOOST] = assertFinite(obj.boost, 'boost');
    if ('isOnGround' in obj) target[19] = obj.isOnGround ? 1 : 0;
    if ('isSupersonic' in obj) target[20] = obj.isSupersonic ? 1 : 0;
    if ('isDemoed' in obj) {
      target[21] = obj.isDemoed
        ? (typeof obj.demoRespawnTimer === 'number' && obj.demoRespawnTimer > 0 ? obj.demoRespawnTimer : 3.0)
        : 0;
    }
    if ('hasFlipOrJump' in obj) {
      target[22] = typeof obj.flipsRemaining === 'number' ? obj.flipsRemaining : (obj.hasFlipOrJump ? 1 : 0);
    }
    if ('isBoosting' in obj) target[23] = obj.isBoosting ? 1 : 0;
    if ('isFlipping' in obj) target[24] = obj.isFlipping ? 1 : 0;

    sanitizeCarSliceInPlace(target, carIndex, false);
    if (typeof wasmModule?._physics_setCarState === 'function') {
      wasmModule._physics_setCarState(carIndex, memoryViews.statePtr + offset * 4);
    }
    return true;
  }
  return false;
}

export function ensureWasmSnapshotBuffer(
  wasmModule: RocketSimWasmModule,
  memoryViews: RocketSimSnapshotMemoryViews,
  size: number
): void {
  if (!memoryViews.wasmStatePtr || memoryViews.wasmStateSize < size) {
    if (memoryViews.wasmStatePtr && wasmModule && typeof wasmModule._free === 'function') {
      wasmModule._free(memoryViews.wasmStatePtr);
    }
    Object.assign(memoryViews, {
      wasmStatePtr: wasmModule._malloc(size * 4),
      wasmStateSize: size,
      cachedSnapshotBuffer: new Float32Array(size),
    });
  }
}

export function saveWasmSnapshotState(
  wasmModule: RocketSimWasmModule,
  memoryViews: RocketSimSnapshotMemoryViews,
  targetBuffer: Float32Array | null = null
): Float32Array {
  const size = typeof wasmModule._physics_getStateSnapshotSize === 'function'
    ? wasmModule._physics_getStateSnapshotSize()
    : 4201;
  ensureWasmSnapshotBuffer(wasmModule, memoryViews, size);

  wasmModule._physics_saveState(memoryViews.wasmStatePtr);

  const offset = memoryViews.wasmStatePtr >> 2;
  const wasmSlice = wasmModule.HEAPF32.subarray(offset, offset + size);

  if (targetBuffer) {
    targetBuffer.set(wasmSlice);
    return targetBuffer;
  }

  const buf = new Float32Array(size);
  buf.set(wasmSlice);
  return buf;
}

export type RocketSimSnapshotContext = RocketSimSnapshotMemoryViews & {
  readonly module?: RocketSimWasmModule | null;
};

export function saveCompactStateSnapshot(
  ctxOrWasm: Pick<RocketSimSnapshotMemoryViews, 'state'> | RocketSimWasmModule,
  targetBufferOrViews: Float32Array | Pick<RocketSimSnapshotMemoryViews, 'state'> | null = null,
  maybeTargetBuffer: Float32Array | null = null
): Float32Array {
  const isTwoArgContext =
    ctxOrWasm &&
    'state' in ctxOrWasm &&
    !(targetBufferOrViews && 'state' in targetBufferOrViews && !(targetBufferOrViews instanceof Float32Array));
  const memoryViews = isTwoArgContext
    ? (ctxOrWasm as Pick<RocketSimSnapshotMemoryViews, 'state'>)
    : (targetBufferOrViews as Pick<RocketSimSnapshotMemoryViews, 'state'>);
  const targetBuffer = isTwoArgContext
    ? (targetBufferOrViews as Float32Array | null)
    : maybeTargetBuffer;
  const src = memoryViews.state;
  const len = src.length;
  const out = targetBuffer && targetBuffer.length >= len ? targetBuffer : new Float32Array(len);
  out.set(src);
  return out;
}

export function setCarTeamInWasm(
  wasmModule: RocketSimWasmModule | null | undefined,
  carIndex: number,
  team: number,
  hitboxIndex = 0,
  memoryViews?: Pick<RocketSimSnapshotMemoryViews, 'state' | 'statePtr'> | null
): boolean {
  if (!wasmModule || carIndex < 0 || carIndex >= MAX_CARS) return false;
  const normalizedTeam = team ? 1 : 0;
  if (typeof wasmModule._physics_setCarTeam === 'function') {
    return wasmModule._physics_setCarTeam(carIndex, normalizedTeam) === 1;
  }
  if (typeof wasmModule._physics_addCarAtSlot === 'function') {
    const offset = SIM_OFFSETS.CARS + carIndex * CAR_STATE_STRIDE;
    const savedSlice =
      memoryViews?.state && offset + CAR_STATE_STRIDE <= memoryViews.state.length
        ? memoryViews.state.slice(offset, offset + CAR_STATE_STRIDE)
        : null;
    const savedThreeWheels = wasmModule._physics_getCarThreeWheels?.(carIndex) === 1;
    const addedIdx = wasmModule._physics_addCarAtSlot(carIndex, normalizedTeam, hitboxIndex);
    if (addedIdx !== carIndex) return false;
    if (savedThreeWheels) {
      wasmModule._physics_setCarThreeWheels?.(carIndex, 1);
    }
    if (savedSlice && memoryViews?.state) {
      memoryViews.state.subarray(offset, offset + CAR_STATE_STRIDE).set(savedSlice);
      wasmModule._physics_setCarState?.(carIndex, memoryViews.statePtr + offset * 4);
    }
    return true;
  }
  return false;
}

function isCarSlotActiveInMemory(
  wasmModule: RocketSimWasmModule,
  memoryViews: RocketSimSnapshotMemoryViews,
  carIndex: number,
  fallbackNumCars: number
): boolean {
  const slot = Number(carIndex) | 0;
  if (slot < 0 || slot >= MAX_CARS) return false;
  if (typeof memoryViews.isCarSlotActive === 'function') return memoryViews.isCarSlotActive(slot);
  if (typeof wasmModule._physics_isCarSlotActive === 'function') return wasmModule._physics_isCarSlotActive(slot) === 1;
  if (typeof wasmModule._physics_getActiveCarMask === 'function') {
    return ((wasmModule._physics_getActiveCarMask() & 0xff) & (1 << slot)) !== 0;
  }
  return slot < fallbackNumCars;
}

export function restoreWasmSnapshotState(
  wasmModule: RocketSimWasmModule,
  memoryViews: RocketSimSnapshotMemoryViews,
  buffer: NumericBufferLike | null | undefined,
  options: RestoreSnapshotOptions = {}
): boolean {
  if (!buffer) return false;
  const size = buffer.length;
  const fullSnapSize = typeof wasmModule._physics_getStateSnapshotSize === 'function'
    ? wasmModule._physics_getStateSnapshotSize()
    : 4201;

  const state = memoryViews.state;
  const currentNumCars = Math.max(0, Math.round(state?.[SIM_OFFSETS.NUM_CARS] || 0));

  // Compact 448-float GameStateBufferPod fast-path (used by WebRTC, PredictionReconciler & Replay RingBuffer)
  if (size <= memoryViews.stateLen && size < fullSnapSize) {
    const currentEngineTick = Math.floor(state?.[SIM_OFFSETS.TICK] || 0);
    const preservedActiveCars = new Map<number, Float32Array>();
    if (state) {
      for (let c = 0; c < MAX_CARS; c++) {
        if (!isCarSlotActiveInMemory(wasmModule, memoryViews, c, currentNumCars)) continue;
        const carOff = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
        if (carOff + CAR_STATE_STRIDE > size || carOff + CAR_STATE_STRIDE > state.length) continue;
        const bufPx = buffer[carOff], bufPy = buffer[carOff + 1], bufPz = buffer[carOff + 2];
        const bufIsStagingOrInvalid =
          !Number.isFinite(bufPx) || !Number.isFinite(bufPy) || !Number.isFinite(bufPz) ||
          bufPx <= -5000 || bufPz < -100;
        if (bufIsStagingOrInvalid) {
          const curPx = state[carOff], curPy = state[carOff + 1], curPz = state[carOff + 2];
          if (
            Number.isFinite(curPx) && Number.isFinite(curPy) && Number.isFinite(curPz) &&
            Math.abs(curPx) <= 4200 && Math.abs(curPy) <= 6100 && curPz >= -50 && curPz <= 2150
          ) {
            preservedActiveCars.set(c, state.slice(carOff, carOff + CAR_STATE_STRIDE));
          }
        }
      }
    }

    const copyLen = Math.min(size, state.length);
    const sourceSlice = buffer.subarray
      ? buffer.subarray(0, copyLen)
      : buffer.slice
        ? buffer.slice(0, copyLen)
        : Array.from(buffer).slice(0, copyLen);
    state.subarray(0, copyLen).set(sourceSlice);
    for (const [c, savedSlice] of preservedActiveCars.entries()) {
      const carOff = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      state.subarray(carOff, carOff + CAR_STATE_STRIDE).set(savedSlice);
    }
    if (typeof options?.overrideTick === 'number' && Number.isFinite(options.overrideTick)) {
      state[SIM_OFFSETS.TICK] = Math.max(16, Math.floor(options.overrideTick));
    } else if (options?.preserveEngineTick) {
      state[SIM_OFFSETS.TICK] = Math.max(16, currentEngineTick);
    }

    const ballOff = SIM_OFFSETS.BALL;
    const bPx = state[ballOff], bPy = state[ballOff + 1], bPz = state[ballOff + 2];
    if (
      !Number.isFinite(bPx) || !Number.isFinite(bPy) || !Number.isFinite(bPz) ||
      Math.abs(bPx) > 4200 || Math.abs(bPy) > 6100 || bPz < -50 || bPz > 2150
    ) {
      state[ballOff] = 0; state[ballOff + 1] = 0; state[ballOff + 2] = 93.15;
      state[ballOff + 3] = 1; state[ballOff + 4] = 0; state[ballOff + 5] = 0;
      state[ballOff + 6] = 0; state[ballOff + 7] = 1; state[ballOff + 8] = 0;
      state[ballOff + 9] = 0; state[ballOff + 10] = 0; state[ballOff + 11] = 1;
      for (let k = 12; k < BALL_STATE_STRIDE; k++) state[ballOff + k] = 0;
    } else {
      const bR0Sq =
        state[ballOff + 3] * state[ballOff + 3] +
        state[ballOff + 4] * state[ballOff + 4] +
        state[ballOff + 5] * state[ballOff + 5];
      if (!Number.isFinite(bR0Sq) || bR0Sq < 0.25 || bR0Sq > 2.5) {
        state[ballOff + 3] = 1; state[ballOff + 4] = 0; state[ballOff + 5] = 0;
        state[ballOff + 6] = 0; state[ballOff + 7] = 1; state[ballOff + 8] = 0;
        state[ballOff + 9] = 0; state[ballOff + 10] = 0; state[ballOff + 11] = 1;
      }
      for (let k = 12; k < BALL_STATE_STRIDE; k++) {
        if (!Number.isFinite(state[ballOff + k]) || Math.abs(state[ballOff + k]) > 1e5) {
          state[ballOff + k] = 0;
        }
      }
    }

    const bufferNumCars = Math.min(MAX_CARS, Math.max(1, Math.round(buffer[SIM_OFFSETS.NUM_CARS] || currentNumCars || 1)));
    const totalSlotsToSanitize = Math.min(MAX_CARS, Math.max(currentNumCars || 1, bufferNumCars));
    const dirTelemetryOff = SIM_OFFSETS.CARS + 7 * CAR_STATE_STRIDE;
    const hasEmbeddedDirectorTelemetry =
      bufferNumCars <= 7 && dirTelemetryOff + 10 <= buffer.length && Math.abs(buffer[dirTelemetryOff] - 1337.5) <= 0.01;
    const endTelemetryOff = Math.min(buffer.length, dirTelemetryOff + 27);
    const savedDirectorTelemetry = hasEmbeddedDirectorTelemetry
      ? (buffer.slice
          ? buffer.slice(dirTelemetryOff, endTelemetryOff)
          : buffer.subarray
            ? buffer.subarray(dirTelemetryOff, endTelemetryOff)
            : Array.from(buffer).slice(dirTelemetryOff, endTelemetryOff))
      : null;

    for (let c = 0; c < totalSlotsToSanitize; c++) {
      if (c === 7 && hasEmbeddedDirectorTelemetry) continue;
      const carOff = SIM_OFFSETS.CARS + c * CAR_STATE_STRIDE;
      if (carOff + CAR_STATE_STRIDE <= state.length) {
        const carSlice = state.subarray(carOff, carOff + CAR_STATE_STRIDE);
        const isSlotInactive = !isCarSlotActiveInMemory(wasmModule, memoryViews, c, bufferNumCars);
        sanitizeCarSliceInPlace(carSlice, c, isSlotInactive);
      }
    }

    if (typeof wasmModule?._physics_restoreCompactState === 'function') {
      const ok = wasmModule._physics_restoreCompactState(memoryViews.statePtr, copyLen) === 1;
      if (savedDirectorTelemetry && dirTelemetryOff + savedDirectorTelemetry.length <= state.length) {
        state.subarray(dirTelemetryOff, dirTelemetryOff + savedDirectorTelemetry.length).set(savedDirectorTelemetry);
      }
      return ok;
    }
    if (savedDirectorTelemetry && dirTelemetryOff + savedDirectorTelemetry.length <= state.length) {
      state.subarray(dirTelemetryOff, dirTelemetryOff + savedDirectorTelemetry.length).set(savedDirectorTelemetry);
    }
    return true;
  }

  ensureWasmSnapshotBuffer(wasmModule, memoryViews, size);

  const offset = memoryViews.wasmStatePtr >> 2;
  wasmModule.HEAPF32.subarray(offset, offset + size).set(buffer);
  const res = wasmModule._physics_restoreState(memoryViews.wasmStatePtr);
  return res === 1;
}

export function readArenaPads(
  wasmModule: RocketSimWasmModule,
  memoryViews: Pick<RocketSimSnapshotMemoryViews, 'state'>
): ArenaBoostPadDescriptor[] {
  const numPads = Math.max(0, Math.round(memoryViews.state?.[SIM_OFFSETS.NUM_PADS] || 0));
  const padPtr = wasmModule._physics_getPadInfoPtr();
  const padView = new Float32Array(wasmModule.HEAPF32.buffer, padPtr, numPads * 4);

  return Array.from({ length: numPads }, (_, idx) => ({
    pos: [padView[idx * 4], padView[idx * 4 + 1], padView[idx * 4 + 2]],
    isBig: padView[idx * 4 + 3] === 1,
  }));
}
