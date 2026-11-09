import { PodiumCelebrationController } from '../PodiumCelebrationController.ts';
import type { ReplayRingBuffer } from '../../../replay/ReplayRingBuffer.ts';
import type { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import { hudStore, useSubsystemIsolationLabStore } from '../../runtimeUiPort.ts';
import type { LabFrameUpdateContext, LabRuntimePort } from './LabTabTypes.ts';
import {
  type ReplayExportPayload,
  buildMatchReplayExportPayload,
} from './goalReplayScenariosPipeline.ts';

export class GoalReplayPodiumSubController {
  public podiumController: PodiumCelebrationController | null = null;

  get isActive(): boolean {
    return Boolean(this.podiumController?.isActive);
  }

  ensureController(runtime: LabRuntimePort | null | undefined): PodiumCelebrationController | null {
    if (!this.podiumController && runtime) {
      this.podiumController = runtime.podiumController || new PodiumCelebrationController(runtime);
      runtime.podiumController = this.podiumController;
    }
    return this.podiumController;
  }

  exitIfActive(): void {
    if (this.podiumController?.isActive) {
      this.podiumController.exitPodium();
    }
  }

  update(context: LabFrameUpdateContext): boolean {
    if (!this.podiumController?.isActive) return false;
    this.podiumController.update(context);
    return true;
  }

  enterShowcase(
    runtime: LabRuntimePort | null | undefined,
    winningTeam = 0,
    timelineController?: ReplayTimelineController | null,
    isReplaying = false
  ): boolean {
    if (!runtime?.physics) return false;
    const store = useSubsystemIsolationLabStore.getState();

    this.ensureController(runtime);
    if (isReplaying) {
      timelineController?.endReplaySession?.();
    }
    runtime.releaseGoalReplayCameraOverride();

    while (runtime.physics.numCars < 2) {
      runtime.physics.addCar(runtime.physics.numCars % 2, 'octane');
    }
    void runtime.arena?.ensureOpponent?.();
    if (runtime.arena?.cars) {
      if (runtime.arena.cars[0]) runtime.arena.cars[0].visible = true;
      if (runtime.arena.cars[1]) runtime.arena.cars[1].visible = true;
    }

    runtime.isBotMatch = true;
    this.podiumController!.enterPodium(winningTeam, 'DEV_TEST_PODIUM');

    store.updateLiveTelemetry({
      goalReplayPhase: 'podium',
      podiumActive: true,
      podiumWinningTeam: winningTeam,
    });
    hudStore.getState().setMatchState({
      matchPhase: 'podium',
      winner: winningTeam === 1 ? 'ORANGE' : winningTeam === 2 ? 'DRAW' : 'BLUE',
    });
    return true;
  }

  exitShowcase(runtime: LabRuntimePort | null | undefined): boolean {
    if (!runtime?.physics) return false;
    const store = useSubsystemIsolationLabStore.getState();

    this.exitIfActive();
    runtime.isBotMatch = false;

    runtime.physics.resetGoalLatch?.();
    runtime.physics.resetKickoff(0, false);
    runtime.interpolator?.sync?.();

    store.updateLiveTelemetry({
      goalReplayPhase: 'live',
      podiumActive: false,
    });
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
    });
    return true;
  }

  exportReplayBufferAsJson(
    runtime: LabRuntimePort | null | undefined,
    fallbackRingBuffer: ReplayRingBuffer | null
  ): ReplayExportPayload {
    const ringBuffer = runtime?.authoritativeServer?.matchAdmin?.replayBuffer || fallbackRingBuffer;
    const wasmFramesCount = runtime?.physics?.getReplayFrameCount?.() || 0;
    const store = useSubsystemIsolationLabStore.getState();
    const payload = buildMatchReplayExportPayload(ringBuffer, wasmFramesCount, store);

    if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rlcleanwasm-replay-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    return payload;
  }
}

const DEFAULT_OPPONENT_STATE = {
  pos: [1400, 3200, 17.05] as [number, number, number],
  vel: [0, 0, 0] as [number, number, number],
  angVel: [0, 0, 0] as [number, number, number],
  rot: [0, -Math.PI / 2, 0] as [number, number, number],
  boost: 100,
};

export function resetGoalReplayBenchArenaAndPhysics(r: LabRuntimePort | null | undefined): number {
  if (!r?.physics) return 0;
  r.releaseGoalReplayCameraOverride();
  while (r.physics.numCars > 2 && typeof r.physics.removeCar === 'function') {
    r.physics.removeCar(r.physics.numCars - 1);
  }
  while (r.physics.numCars < 2) {
    r.physics.addCar(r.physics.numCars % 2, 'octane');
  }
  void r.arena?.ensureOpponent?.();
  if (r.arena?.cars) {
    if (r.arena.cars[0]) {
      r.arena.cars[0].visible = true;
      r.arena.setCarTeam?.(0, 0);
    }
    if (r.arena.cars[1]) {
      r.arena.cars[1].visible = true;
      r.arena.setCarTeam?.(1, 1);
      r.physics.setCarState(1, DEFAULT_OPPONENT_STATE);
    }
    for (let i = 2; i < r.arena.cars.length; i++) {
      if (r.arena.cars[i]) r.arena.cars[i].visible = false;
    }
  }
  r.playerCarIndex = 0;
  if (r.arena) r.arena.playerCarIndex = 0;
  r.isBotMatch = false;
  r.physics.setUnlimitedBoost(true);
  r.physics.resetGoalLatch?.();
  r.physics.resetKickoff(0, false);
  r.physics.setCarState(1, DEFAULT_OPPONENT_STATE);
  r.physics.clearEvents?.();
  r.simulationStage?.resetActionStates?.();
  r.arena?.resetAllCarEffects?.();
  r.resetAudio?.();
  r.physics.clearReplayBuffer?.();
  return Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
}

export function resetGoalReplayLiveKickoff(r: LabRuntimePort | null | undefined): number {
  if (!r?.physics) return 0;
  r.physics.resetGoalLatch?.();
  r.physics.resetKickoff(0, false);
  if (r.physics.numCars > 1) {
    r.physics.setCarState(1, DEFAULT_OPPONENT_STATE);
  }
  return Math.floor(r.physics.getHeaderView?.()?.tickCount || 0);
}
