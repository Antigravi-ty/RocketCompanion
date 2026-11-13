/**
 * src/physics/wasmReconcilerBridge.ts
 * Zero-copy WASM bridge for rc_physics_sim::reconciler and rc_physics_sim::clock_sync.
 */

import {
  ensureWasmSnapshotBuffer,
  type CarControlsInput,
  type RocketSimSnapshotMemoryViews,
  type RocketSimWasmModule,
} from './RocketSimSnapshotSerializer.ts';

export interface WasmReconcilerModulePort extends RocketSimWasmModule {
  _physics_clearReconcilerHistory?(): void;
  _physics_setReconcilerTickControls?(
    tick: number,
    carIndex: number,
    throttle: number,
    steer: number,
    pitch: number,
    yaw: number,
    roll: number,
    jump: number,
    boost: number,
    handbrake: number
  ): void;
  _physics_setReconcilerRemoteControls?(
    carIndex: number,
    throttle: number,
    steer: number,
    pitch: number,
    yaw: number,
    roll: number,
    jump: number,
    boost: number,
    handbrake: number
  ): void;
  _physics_reconcileRollbackToTick?(
    serverTick: number,
    targetClientTick: number,
    localCarIndex: number,
    kickoffMaskUntilTick: number,
    authoritativeStatePtr: number,
    floatCount: number
  ): number;
  _physics_stepReconcilerRange?(
    fromTick: number,
    toTick: number,
    localCarIndex: number,
    kickoffMaskUntilTick: number,
    silent: number
  ): number;
  _physics_getReconcilerOutcomePtr?(): number;
  _physics_resetClockSync?(): void;
  _physics_pushClockSyncRttSample?(rttMs: number, jitterHintMs: number): void;
  _physics_evaluateClockSyncPacing?(
    clientTick: number,
    serverTick: number,
    inputBufferTarget: number,
    maxLeadTicks: number,
    tickDtMs: number
  ): number;
  _physics_getClockSyncStatePtr?(): number;
}

export interface WasmReconcileOutcome {
  startTick: number;
  endTick: number;
  resimulatedTicks: number;
  restoredFromRingSlot: number;
  preBallPos: [number, number, number];
  postBallPos: [number, number, number];
}

export interface WasmClockSyncState {
  smoothedRttMs: number;
  rttJitterMs: number;
  clockOffsetMs: number;
  leadTicks: number;
  downlinkTicks: number;
  targetDeltaTicks: number;
  pacingRateHz: number;
  driftTicks: number;
  sampleCount: number;
}

export function clearWasmReconcilerHistory(mod: WasmReconcilerModulePort | null): void {
  if (mod && typeof mod._physics_clearReconcilerHistory === 'function') {
    mod._physics_clearReconcilerHistory();
  }
}

export function setWasmReconcilerTickControls(
  mod: WasmReconcilerModulePort | null,
  tick: number,
  carIndex: number,
  controls: Partial<CarControlsInput> | null | undefined
): void {
  if (!mod || typeof mod._physics_setReconcilerTickControls !== 'function' || !controls) return;
  mod._physics_setReconcilerTickControls(
    tick | 0,
    carIndex | 0,
    controls.throttle ?? 0,
    controls.steer ?? 0,
    controls.pitch ?? 0,
    controls.yaw ?? 0,
    controls.roll ?? 0,
    controls.jump ? 1 : 0,
    controls.boost ? 1 : 0,
    controls.handbrake ? 1 : 0
  );
}

export function setWasmReconcilerRemoteControls(
  mod: WasmReconcilerModulePort | null,
  carIndex: number,
  controls: Partial<CarControlsInput> | null | undefined
): void {
  if (!mod || typeof mod._physics_setReconcilerRemoteControls !== 'function' || !controls) return;
  mod._physics_setReconcilerRemoteControls(
    carIndex | 0,
    controls.throttle ?? 0,
    controls.steer ?? 0,
    controls.pitch ?? 0,
    controls.yaw ?? 0,
    controls.roll ?? 0,
    controls.jump ? 1 : 0,
    controls.boost ? 1 : 0,
    controls.handbrake ? 1 : 0
  );
}

export function runWasmReconcileRollbackToTick(
  mod: WasmReconcilerModulePort | null,
  memoryViews: RocketSimSnapshotMemoryViews,
  serverTick: number,
  targetClientTick: number,
  localCarIndex: number,
  kickoffMaskUntilTick: number,
  authoritativeState?: Float32Array | number[] | null
): boolean {
  if (!mod || typeof mod._physics_reconcileRollbackToTick !== 'function') return false;
  let statePtr = 0;
  let floatCount = 0;
  if (authoritativeState && authoritativeState.length >= 410) {
    floatCount = authoritativeState.length;
    ensureWasmSnapshotBuffer(mod, memoryViews, floatCount);
    statePtr = memoryViews.wasmStatePtr;
    if (statePtr && mod.HEAPF32) {
      mod.HEAPF32.set(authoritativeState, statePtr >> 2);
    }
  }
  return (
    mod._physics_reconcileRollbackToTick(
      serverTick | 0,
      targetClientTick | 0,
      localCarIndex | 0,
      kickoffMaskUntilTick | 0,
      statePtr,
      floatCount
    ) === 1
  );
}

export function stepWasmReconcilerRange(
  mod: WasmReconcilerModulePort | null,
  fromTick: number,
  toTick: number,
  localCarIndex: number,
  kickoffMaskUntilTick: number,
  silent: boolean
): number {
  if (!mod || typeof mod._physics_stepReconcilerRange !== 'function') return fromTick;
  return mod._physics_stepReconcilerRange(
    fromTick | 0,
    toTick | 0,
    localCarIndex | 0,
    kickoffMaskUntilTick | 0,
    silent ? 1 : 0
  );
}

export function readWasmReconcilerOutcome(
  mod: WasmReconcilerModulePort | null
): WasmReconcileOutcome | null {
  if (!mod || typeof mod._physics_getReconcilerOutcomePtr !== 'function' || !mod.HEAPF32) {
    return null;
  }
  const ptr = mod._physics_getReconcilerOutcomePtr();
  if (!ptr) return null;
  const idx = ptr >> 2;
  const f32 = mod.HEAPF32;
  const i32 = new Int32Array(f32.buffer);
  return {
    startTick: i32[idx],
    endTick: i32[idx + 1],
    resimulatedTicks: i32[idx + 2],
    restoredFromRingSlot: i32[idx + 3] >>> 0,
    preBallPos: [f32[idx + 4], f32[idx + 5], f32[idx + 6]],
    postBallPos: [f32[idx + 7], f32[idx + 8], f32[idx + 9]],
  };
}

export function resetWasmClockSync(mod: WasmReconcilerModulePort | null): void {
  if (mod && typeof mod._physics_resetClockSync === 'function') {
    mod._physics_resetClockSync();
  }
}

export function pushWasmClockSyncRttSample(
  mod: WasmReconcilerModulePort | null,
  rttMs: number,
  jitterHintMs = 0
): void {
  if (mod && typeof mod._physics_pushClockSyncRttSample === 'function') {
    mod._physics_pushClockSyncRttSample(rttMs, jitterHintMs);
  }
}

export function evaluateWasmClockSyncPacing(
  mod: WasmReconcilerModulePort | null,
  clientTick: number,
  serverTick: number,
  inputBufferTarget: number,
  maxLeadTicks: number,
  tickDtMs: number
): WasmClockSyncState | null {
  if (
    !mod ||
    typeof mod._physics_evaluateClockSyncPacing !== 'function' ||
    typeof mod._physics_getClockSyncStatePtr !== 'function' ||
    !mod.HEAPF32
  ) {
    return null;
  }
  mod._physics_evaluateClockSyncPacing(
    clientTick | 0,
    serverTick | 0,
    inputBufferTarget | 0,
    maxLeadTicks | 0,
    tickDtMs
  );
  const ptr = mod._physics_getClockSyncStatePtr();
  if (!ptr) return null;
  const idx = ptr >> 2;
  const f32 = mod.HEAPF32;
  const i32 = new Int32Array(f32.buffer);
  return {
    smoothedRttMs: f32[idx],
    rttJitterMs: f32[idx + 1],
    clockOffsetMs: f32[idx + 2],
    leadTicks: i32[idx + 3],
    downlinkTicks: i32[idx + 4],
    targetDeltaTicks: i32[idx + 5],
    pacingRateHz: f32[idx + 6],
    driftTicks: f32[idx + 7],
    sampleCount: i32[idx + 8] >>> 0,
  };
}
