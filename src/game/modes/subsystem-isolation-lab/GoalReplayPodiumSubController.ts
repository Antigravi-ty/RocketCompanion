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

  ensureController(
    sceneTarget: LabRuntimePort | null | undefined
  ): PodiumCelebrationController | null {
    if (!this.podiumController && sceneTarget) {
      this.podiumController =
        sceneTarget.podiumController || new PodiumCelebrationController(sceneTarget);
      sceneTarget.podiumController = this.podiumController;
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
    sceneTarget: LabRuntimePort | null | undefined,
    winningTeam = 0,
    timelineController?: ReplayTimelineController | null,
    isReplaying = false
  ): boolean {
    const sim = sceneTarget?.physics;
    if (!sim || !sceneTarget) return false;
    const store = useSubsystemIsolationLabStore.getState();

    this.ensureController(sceneTarget);
    if (isReplaying) {
      timelineController?.endReplaySession?.();
    }
    sceneTarget.releaseGoalReplayCameraOverride();

    while (sim.numCars < 2) {
      sim.addCar(sim.numCars % 2, 'octane');
    }
    const arena = sceneTarget.arena;
    void arena?.ensureOpponent?.();
    if (arena?.cars) {
      if (arena.cars[0]) arena.cars[0].visible = true;
      if (arena.cars[1]) arena.cars[1].visible = true;
    }

    sceneTarget.isBotMatch = true;
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

  exitShowcase(sceneTarget: LabRuntimePort | null | undefined): boolean {
    const sim = sceneTarget?.physics;
    if (!sim || !sceneTarget) return false;
    const store = useSubsystemIsolationLabStore.getState();

    this.exitIfActive();
    sceneTarget.isBotMatch = false;

    sim.resetGoalLatch?.();
    sim.resetKickoff(0, false);
    sceneTarget.interpolator?.sync?.();

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
    sceneTarget: LabRuntimePort | null | undefined,
    fallbackRingBuffer: ReplayRingBuffer | null
  ): ReplayExportPayload {
    const ringBuffer =
      sceneTarget?.authoritativeServer?.matchAdmin?.replayBuffer || fallbackRingBuffer;
    const wasmFramesCount = sceneTarget?.physics?.getReplayFrameCount?.() || 0;
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

export function resetGoalReplayBenchArenaAndPhysics(
  sceneTarget: LabRuntimePort | null | undefined
): number {
  const sim = sceneTarget?.physics;
  if (!sim || !sceneTarget) return 0;
  sceneTarget.releaseGoalReplayCameraOverride();
  while (sim.numCars > 2 && typeof sim.removeCar === 'function') {
    sim.removeCar(sim.numCars - 1);
  }
  while (sim.numCars < 2) {
    sim.addCar(sim.numCars % 2, 'octane');
  }
  const arena = sceneTarget.arena;
  void arena?.ensureOpponent?.();
  if (arena?.cars) {
    if (arena.cars[0]) {
      arena.cars[0].visible = true;
      arena.setCarTeam?.(0, 0);
    }
    if (arena.cars[1]) {
      arena.cars[1].visible = true;
      arena.setCarTeam?.(1, 1);
      sim.setCarState(1, DEFAULT_OPPONENT_STATE);
    }
    for (let i = 2; i < arena.cars.length; i++) {
      if (arena.cars[i]) arena.cars[i].visible = false;
    }
  }
  sceneTarget.playerCarIndex = 0;
  if (arena) arena.playerCarIndex = 0;
  sceneTarget.isBotMatch = false;
  sim.setUnlimitedBoost(true);
  sim.resetGoalLatch?.();
  sim.resetKickoff(0, false);
  sim.setCarState(1, DEFAULT_OPPONENT_STATE);
  sim.clearEvents?.();
  sceneTarget.simulationStage?.resetActionStates?.();
  arena?.resetAllCarEffects?.();
  sceneTarget.resetAudio?.();
  sim.clearReplayBuffer?.();
  return Math.floor(sim.getHeaderView?.()?.tickCount || 0);
}

export function resetGoalReplayLiveKickoff(sceneTarget: LabRuntimePort | null | undefined): number {
  const sim = sceneTarget?.physics;
  if (!sim) return 0;
  sim.resetGoalLatch?.();
  sim.resetKickoff(0, false);
  if (sim.numCars > 1) {
    sim.setCarState(1, DEFAULT_OPPONENT_STATE);
  }
  return Math.floor(sim.getHeaderView?.()?.tickCount || 0);
}
