import {
  applyReplayFrameToEngine,
  interpolateReplaySnapshots,
} from '../../../replay/ReplayFrameInterpolator.ts';
import { SIM_OFFSETS } from '../../../physics/RocketSimConstants.ts';
import type { CarControlsInput } from '../../../network/protocol/InputPacketCodec.ts';
import type {
  SpectateInterpolationBuffer,
  SpectateInterpolationSample,
} from '../../../network/sync/ReplicationStateInterpolator.ts';
import type { PhysicsStateInterpolator } from '../../../physics/PhysicsStateInterpolator.ts';
import type { RocketSimPhysicsEngine } from '../../../physics/RocketSimPhysicsEngine.ts';

export interface SpectateLookaheadState {
  hasReceivedFrame: boolean;
  lookaheadTicksActive: number;
  lastLookaheadMs: number;
  lastAppliedTick: number;
  lastSampledTick: number;
  lastAcknowledgedControls: Array<{ carIndex: number; controls: CarControlsInput }> | null;
  convergenceScratch: Float32Array | null;
}

const SPECTATE_LOOKAHEAD_MAX_TICKS = 180;
const SPECTATE_CONVERGENCE_DIST_SQ = 1800 * 1800;
const SPECTATE_CONVERGENCE_ALPHA = 0.3;
const SPECTATE_CONVERGENCE_BEHIND_ALPHA = 0.2;
const SPECTATE_TICK_MS = 1000 / 120;

const spectateLookaheadByBuffer = new WeakMap<
  SpectateInterpolationBuffer,
  SpectateLookaheadState
>();

export function getSpectateLookaheadState(
  buffer: SpectateInterpolationBuffer
): SpectateLookaheadState {
  let state = spectateLookaheadByBuffer.get(buffer);
  if (!state) {
    state = {
      hasReceivedFrame: false,
      lookaheadTicksActive: 0,
      lastLookaheadMs: 0,
      lastAppliedTick: 0,
      lastSampledTick: 0,
      lastAcknowledgedControls: null,
      convergenceScratch: null,
    };
    spectateLookaheadByBuffer.set(buffer, state);
  }
  return state;
}

export function resetSpectateLookaheadState(
  buffer: SpectateInterpolationBuffer | null | undefined
): void {
  if (!buffer) return;
  const state = spectateLookaheadByBuffer.get(buffer);
  if (!state) return;
  state.hasReceivedFrame = false;
  state.lookaheadTicksActive = 0;
  state.lastLookaheadMs = 0;
  state.lastAppliedTick = 0;
  state.lastSampledTick = 0;
  state.lastAcknowledgedControls = null;
}

function isBallDeltaWithinConvergenceThreshold(a: Float32Array, b: Float32Array): boolean {
  const dx = b[SIM_OFFSETS.BALL] - a[SIM_OFFSETS.BALL];
  const dy = b[SIM_OFFSETS.BALL + 1] - a[SIM_OFFSETS.BALL + 1];
  const dz = b[SIM_OFFSETS.BALL + 2] - a[SIM_OFFSETS.BALL + 2];
  return dx * dx + dy * dy + dz * dz <= SPECTATE_CONVERGENCE_DIST_SQ;
}

function getCurrentEngineTick(physics: RocketSimPhysicsEngine): number {
  return Math.floor(physics.getHeaderView?.()?.tickCount ?? physics.state?.[SIM_OFFSETS.TICK] ?? 0);
}

function enforceMonotonicTick(
  physics: RocketSimPhysicsEngine,
  interpolator: PhysicsStateInterpolator,
  targetTick: number
): void {
  if (!physics.state || targetTick <= 0) return;
  physics.state[SIM_OFFSETS.TICK] = targetTick;
  interpolator.currState[SIM_OFFSETS.TICK] = targetTick;
  if (interpolator.prevState[SIM_OFFSETS.TICK] > targetTick) {
    interpolator.prevState[SIM_OFFSETS.TICK] = targetTick;
  }
}

export function applySpectateSampleOrLookahead(params: {
  buffer: SpectateInterpolationBuffer;
  sampled: SpectateInterpolationSample | null;
  shouldRunLookahead: boolean;
  now: number;
  physics: RocketSimPhysicsEngine;
  interpolator: PhysicsStateInterpolator;
}): boolean {
  const { buffer, sampled, shouldRunLookahead, now, physics, interpolator } = params;
  const state = getSpectateLookaheadState(buffer);

  if (sampled && !sampled.isDuplicateFrame && !(shouldRunLookahead && sampled.isLookahead)) {
    const sampledNumCars = Math.round(sampled.snapshot[SIM_OFFSETS.NUM_CARS] || 0);
    const currentNumCars = Math.round(physics.getHeaderView?.()?.numCars ?? 0);
    const isSessionOrSeekReset =
      state.hasReceivedFrame &&
      ((sampledNumCars > 0 && currentNumCars > 0 && sampledNumCars !== currentNumCars) ||
        (state.lastSampledTick > 0 &&
          sampled.renderTick > 0 &&
          sampled.renderTick + 12 < state.lastSampledTick));

    if (isSessionOrSeekReset) {
      resetSpectateLookaheadState(buffer);
    }

    const rawSampledTick =
      sampled.renderTick > 0
        ? Math.max(16, Math.round(sampled.renderTick))
        : Math.max(16, Math.round(sampled.snapshot[SIM_OFFSETS.TICK] || 0));

    // Reject strictly stale out-of-order samples whose renderTick regressed slightly behind an earlier sample.
    if (
      state.hasReceivedFrame &&
      state.lastSampledTick > 0 &&
      sampled.renderTick > 0 &&
      sampled.renderTick + 0.5 < state.lastSampledTick
    ) {
      return false;
    }

    const currentEngineTick = getCurrentEngineTick(physics);
    const monotonicFloor = state.hasReceivedFrame
      ? Math.max(currentEngineTick, state.lastAppliedTick)
      : 0;
    const monotonicTick = state.hasReceivedFrame
      ? Math.max(16, monotonicFloor, rawSampledTick)
      : Math.max(16, rawSampledTick);

    state.hasReceivedFrame = true;
    state.lastLookaheadMs = now;
    if (sampled.renderTick > 0) {
      state.lastSampledTick = Math.max(state.lastSampledTick, sampled.renderTick);
    }

    if (
      shouldRunLookahead &&
      state.lookaheadTicksActive > 0 &&
      physics.state &&
      isBallDeltaWithinConvergenceThreshold(physics.state, sampled.snapshot)
    ) {
      const alpha =
        rawSampledTick < monotonicFloor
          ? SPECTATE_CONVERGENCE_BEHIND_ALPHA
          : SPECTATE_CONVERGENCE_ALPHA;
      const converged = interpolateReplaySnapshots(
        physics.state,
        sampled.snapshot,
        alpha,
        state.convergenceScratch
      );
      if (converged) {
        converged[SIM_OFFSETS.TICK] = monotonicTick;
        state.convergenceScratch = converged;
        applyReplayFrameToEngine(physics, converged, interpolator);
      } else {
        applyReplayFrameToEngine(physics, sampled.snapshot, interpolator);
      }
      if (rawSampledTick >= monotonicFloor) {
        state.lookaheadTicksActive =
          state.lookaheadTicksActive <= 4 ? 0 : Math.floor(state.lookaheadTicksActive * 0.5);
      } else {
        state.lookaheadTicksActive = Math.max(0, state.lookaheadTicksActive - 4);
      }
    } else {
      state.lookaheadTicksActive = 0;
      applyReplayFrameToEngine(physics, sampled.snapshot, interpolator);
    }

    enforceMonotonicTick(physics, interpolator, monotonicTick);
    state.lastAppliedTick = monotonicTick;
    return true;
  }

  if (
    shouldRunLookahead &&
    state.hasReceivedFrame &&
    state.lookaheadTicksActive < SPECTATE_LOOKAHEAD_MAX_TICKS
  ) {
    const dtMs =
      state.lastLookaheadMs > 0
        ? Math.max(0, Math.min(50, now - state.lastLookaheadMs))
        : SPECTATE_TICK_MS;
    state.lastLookaheadMs = now;
    const ticksToStep = Math.max(1, Math.min(4, Math.round(dtMs / SPECTATE_TICK_MS)));
    const prevTick = Math.max(16, getCurrentEngineTick(physics), state.lastAppliedTick);
    if (state.lastAcknowledgedControls && typeof physics.setCarControls === 'function') {
      for (let i = 0; i < state.lastAcknowledgedControls.length; i++) {
        const entry = state.lastAcknowledgedControls[i];
        if (entry && entry.carIndex >= 0 && entry.controls) {
          physics.setCarControls(entry.carIndex, entry.controls);
        }
      }
    }
    for (let t = 0; t < ticksToStep; t++) {
      physics.step(1);
    }
    if (physics.state) {
      const nextTick = Math.max(physics.state[SIM_OFFSETS.TICK], prevTick + ticksToStep);
      physics.state[SIM_OFFSETS.TICK] = nextTick;
      interpolator.prevState.set(interpolator.currState);
      interpolator.currState.set(physics.state);
      interpolator.alpha = 1;
      state.lastAppliedTick = nextTick;
    }
    state.lookaheadTicksActive = Math.min(
      SPECTATE_LOOKAHEAD_MAX_TICKS,
      state.lookaheadTicksActive + ticksToStep
    );
    return true;
  }

  if (sampled) {
    if (
      shouldRunLookahead &&
      state.hasReceivedFrame &&
      state.lookaheadTicksActive >= SPECTATE_LOOKAHEAD_MAX_TICKS
    ) {
      return false;
    }
    const rawSampledTick =
      sampled.renderTick > 0
        ? Math.max(16, Math.round(sampled.renderTick))
        : Math.max(16, Math.round(sampled.snapshot[SIM_OFFSETS.TICK] || 0));
    const currentEngineTick = getCurrentEngineTick(physics);
    const monotonicTick = state.hasReceivedFrame
      ? Math.max(16, currentEngineTick, state.lastAppliedTick, rawSampledTick)
      : Math.max(16, rawSampledTick);

    state.hasReceivedFrame = true;
    state.lookaheadTicksActive = 0;
    state.lastLookaheadMs = now;
    if (sampled.renderTick > 0) {
      state.lastSampledTick = Math.max(state.lastSampledTick, sampled.renderTick);
    }
    applyReplayFrameToEngine(physics, sampled.snapshot, interpolator);
    enforceMonotonicTick(physics, interpolator, monotonicTick);
    state.lastAppliedTick = monotonicTick;
    return true;
  }

  return false;
}
