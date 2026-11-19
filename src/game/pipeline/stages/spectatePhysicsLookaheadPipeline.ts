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
  lastAcknowledgedControls: Array<{ carIndex: number; controls: CarControlsInput }> | null;
  convergenceScratch: Float32Array | null;
}

const SPECTATE_LOOKAHEAD_MAX_TICKS = 30;
const SPECTATE_CONVERGENCE_DIST_SQ = 900 * 900;
const SPECTATE_CONVERGENCE_ALPHA = 0.45;
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
  state.lastAcknowledgedControls = null;
}

function isBallDeltaWithinConvergenceThreshold(a: Float32Array, b: Float32Array): boolean {
  const dx = b[SIM_OFFSETS.BALL] - a[SIM_OFFSETS.BALL];
  const dy = b[SIM_OFFSETS.BALL + 1] - a[SIM_OFFSETS.BALL + 1];
  const dz = b[SIM_OFFSETS.BALL + 2] - a[SIM_OFFSETS.BALL + 2];
  return dx * dx + dy * dy + dz * dz <= SPECTATE_CONVERGENCE_DIST_SQ;
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

  if (sampled && !sampled.isDuplicateFrame) {
    state.hasReceivedFrame = true;
    state.lastLookaheadMs = now;
    if (
      shouldRunLookahead &&
      state.lookaheadTicksActive > 0 &&
      physics.state &&
      isBallDeltaWithinConvergenceThreshold(physics.state, sampled.snapshot)
    ) {
      const converged = interpolateReplaySnapshots(
        physics.state,
        sampled.snapshot,
        SPECTATE_CONVERGENCE_ALPHA,
        state.convergenceScratch
      );
      if (converged) {
        state.convergenceScratch = converged;
        applyReplayFrameToEngine(physics, converged, interpolator);
      } else {
        applyReplayFrameToEngine(physics, sampled.snapshot, interpolator);
      }
      state.lookaheadTicksActive = Math.max(0, state.lookaheadTicksActive - 2);
    } else {
      state.lookaheadTicksActive = 0;
      applyReplayFrameToEngine(physics, sampled.snapshot, interpolator);
    }
    if (physics.state && sampled.renderTick > 0) {
      const targetTick = Math.max(16, Math.round(sampled.renderTick));
      physics.state[SIM_OFFSETS.TICK] = targetTick;
      interpolator.currState[SIM_OFFSETS.TICK] = targetTick;
    }
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
    const prevTick = Math.floor(
      physics.getHeaderView?.()?.tickCount ?? physics.state?.[SIM_OFFSETS.TICK] ?? 16
    );
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
    }
    state.lookaheadTicksActive = Math.min(
      SPECTATE_LOOKAHEAD_MAX_TICKS,
      state.lookaheadTicksActive + ticksToStep
    );
    return true;
  }

  if (sampled) {
    state.hasReceivedFrame = true;
    state.lookaheadTicksActive = 0;
    state.lastLookaheadMs = now;
    applyReplayFrameToEngine(physics, sampled.snapshot, interpolator);
    return true;
  }

  return false;
}
