import {
  BALL_REST_Z,
  BALL_STATE_STRIDE,
  MATCH_SIGNALS,
  MAX_CARS,
  SIM_OFFSETS,
} from '../../../physics/RocketSimConstants.ts';
import { isDevSyncHostBroadcastingMode } from '../../pipeline/stages/HostBroadcastPublisher.ts';
import {
  evaluateGoalScoredFromBallView,
  type BallStateViewLike,
} from '../shared/goalAndBallTouchPipeline.ts';
import type {
  FreeplayGoalAndTouchRuntimePort,
  FreeplayGoalMetadataTargetPort,
  FreeplayPhysicsEnginePort,
} from './freeplayTouchAndGoalPipeline.ts';
import { runtimeResourceRegistry } from '../../runtime/RuntimeResourceRegistry.ts';

const _lobbyCenterBallResetState = new Float32Array([
  0,
  0,
  BALL_REST_Z,
  1,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
]);

export function handleDisabledOrLobbyGoalLatch(
  scenePort: FreeplayGoalAndTouchRuntimePort,
  sim: FreeplayPhysicsEnginePort,
  bView: BallStateViewLike | null
): boolean {
  const isOnlineLobby = Boolean(
    scenePort.arena?.isLobbyMode || scenePort.networkReconciler?.lobbyDualWorldMode
  );
  if (!scenePort.trainingOptions?.disableGoalReset && !isOnlineLobby) {
    return false;
  }
  if (
    isOnlineLobby &&
    !scenePort.authoritativeServer &&
    scenePort.networkReconciler?.lobbyDualWorldMode
  ) {
    const headerGoalScored = (sim.getHeaderView?.()?.goalScoredFlag ?? 0) !== 0;
    const polledGoalScored = sim.pollGoal ? Number(sim.pollGoal() || 0) !== 0 : false;
    const ballViewGoalScored = evaluateGoalScoredFromBallView(sim, bView).scored;
    if (headerGoalScored || polledGoalScored || ballViewGoalScored) {
      if (sim.resetGoalLatch) sim.resetGoalLatch();
      if (sim.setBallState) {
        sim.setBallState(_lobbyCenterBallResetState);
      }
      const currentTick = Math.floor(sim.getHeaderView?.()?.tickCount ?? 0);
      sim.saveStateSlot?.(currentTick % 256);
      const reconcilerWithHistory = scenePort.networkReconciler as {
        historyBuffer?: { saveTickSnapshot?: (tick: number, sim: unknown) => unknown } | null;
      };
      reconcilerWithHistory.historyBuffer?.saveTickSnapshot?.(currentTick, sim);
      const ballSliceEnd = SIM_OFFSETS.BALL + BALL_STATE_STRIDE;
      if (sim.state && sim.state.length >= ballSliceEnd) {
        const ballSlice = sim.state.subarray(SIM_OFFSETS.BALL, ballSliceEnd);
        if (
          scenePort.interpolator?.prevState &&
          scenePort.interpolator.prevState.length >= ballSliceEnd
        ) {
          scenePort.interpolator.prevState.set(ballSlice, SIM_OFFSETS.BALL);
        }
        if (
          scenePort.interpolator?.currState &&
          scenePort.interpolator.currState.length >= ballSliceEnd
        ) {
          scenePort.interpolator.currState.set(ballSlice, SIM_OFFSETS.BALL);
        }
      }
      if (bView) {
        bView.posX = 0;
        bView.posY = 0;
        bView.posZ = BALL_REST_Z;
        bView.velX = 0;
        bView.velY = 0;
        bView.velZ = 0;
      }
    } else if (sim.resetGoalLatch) {
      sim.resetGoalLatch();
    }
  } else if (sim.resetGoalLatch) {
    sim.resetGoalLatch();
  }
  return true;
}

export interface CleanFreeplayResetOptions {
  standaloneReplayViewer?: {
    hasLoadedReplay?: boolean;
    isActive?: boolean;
    clearReplay(): void;
  } | null;
  isGoalReplayActive: boolean;
  replayController?: { sessionState?: { isActive?: boolean } } | null;
  nameTagTunerController?: { isActive?: boolean; exitTunerArena(): void } | null;
  rewinderController?: {
    isBlockingLivePhysics?: boolean;
    rewinderFrames?: unknown[];
    clearBuffer(): void;
  } | null;
}

export interface StandaloneViewerKickoffResetPort {
  hasLoadedReplay?: boolean;
  isActive?: boolean;
  frames: unknown[];
  takeoverSubController: { targetFrame?: number; cursor?: number };
  _handoffToLiveFreeplay(idx: number): void;
  _applyFrameAtCursor(a: boolean, b: boolean): void;
}

export function resetFreeplayExtraCarsAndArenaToSingleCar(
  scenePort: FreeplayGoalAndTouchRuntimePort | null | undefined
): void {
  const sim = scenePort?.physics;
  if (sim) {
    while ((sim.numCars ?? 1) > 1 && typeof sim.removeCar === 'function') {
      sim.removeCar((sim.numCars ?? 1) - 1);
    }
  }
  const arena = scenePort?.arena;
  if (arena?.cars) {
    if (arena.cars[0]) arena.cars[0].visible = true;
    arena.resetCarBoosts?.(0);
    arena.supersonicWheelTrailSystem?.resetCar?.(0);
    arena.ballSpeedTrail?.reset?.();
    for (let i = Math.max(arena.cars.length, MAX_CARS) - 1; i >= 1; i--) {
      arena.supersonicWheelTrailSystem?.resetCar?.(i);
    }
    for (let i = arena.cars.length - 1; i >= 1; i--) {
      if (arena.resetCarBoosts) arena.resetCarBoosts(i);
      const demo = arena.carDemolitions?.[i];
      if (demo?.stop) demo.stop();
      if (arena.vehicleRegistry?.removeCar) {
        arena.vehicleRegistry.removeCar(i);
      } else if (arena.cars[i]) {
        arena.cars[i]!.visible = false;
      }
    }
    if (arena.lighting?.updateSunIntensities) {
      arena.lighting.updateSunIntensities(1);
    }
  }
  scenePort?.renderer?.renderLists?.dispose?.();
  if (scenePort?.audioSubsystem?.resetAudio) {
    scenePort.audioSubsystem.resetAudio();
  }
}

export function syncFreeplayAuthoritativeServerKickoffState(
  scenePort: FreeplayGoalAndTouchRuntimePort | null | undefined
): void {
  const server = scenePort?.authoritativeServer;
  const sim = scenePort?.physics;
  if (!server || !sim || !sim.saveCompactState) return;
  const snap = sim.saveCompactState();
  const curTick = Math.floor((sim.getHeaderView ? sim.getHeaderView()?.tickCount : undefined) ?? 0);
  if (isDevSyncHostBroadcastingMode(Boolean(server))) {
    server.pushBroadcastSignal?.(MATCH_SIGNALS.BALL_RESET, curTick, 0, 0, [
      MATCH_SIGNALS.GOAL_REPLAY_WILL_START,
      MATCH_SIGNALS.GOAL_REPLAY_START,
      MATCH_SIGNALS.GOAL_REPLAY_WILL_END,
    ]);
    return;
  }
  if (server.startTrainingMode) {
    server.startTrainingMode({
      unlimitedBoost: Boolean(sim.isUnlimitedBoost),
      disableGoalReset: Boolean(scenePort?.trainingOptions?.disableGoalReset),
      goalReplayEnabled: true,
      fifoDurationSeconds: 60,
      initialState: Array.from(snap),
      resetKickoff: false,
    });
  }
  if (server.sim?.restoreState) {
    void server.sim.restoreState(snap);
  }
  if (server.clientInputBuffer?.clear) server.clientInputBuffer.clear();
  if (server.lastReceivedControls?.clear) server.lastReceivedControls.clear();
  if (scenePort?.networkReconciler?.syncTimeline) {
    scenePort.networkReconciler.syncTimeline(snap, curTick);
  }
}

export function applyCleanFreeplaySubsystemsReset(
  scenePort: FreeplayGoalAndTouchRuntimePort | null | undefined,
  directorPreview: FreeplayGoalMetadataTargetPort,
  options: CleanFreeplayResetOptions
): void {
  const {
    standaloneReplayViewer,
    isGoalReplayActive,
    replayController,
    nameTagTunerController,
    rewinderController,
  } = options;
  if (standaloneReplayViewer?.hasLoadedReplay || standaloneReplayViewer?.isActive) {
    standaloneReplayViewer.clearReplay();
  }
  if (isGoalReplayActive || replayController?.sessionState?.isActive) {
    directorPreview.exitPatternPreview();
  }
  if (nameTagTunerController?.isActive) nameTagTunerController.exitTunerArena();
  if (
    rewinderController &&
    (rewinderController.isBlockingLivePhysics ||
      (rewinderController.rewinderFrames?.length ?? 0) > 0)
  ) {
    rewinderController.clearBuffer();
  }
  resetFreeplayExtraCarsAndArenaToSingleCar(scenePort);
  directorPreview.previewSpawnedExtraCars = false;
  void runtimeResourceRegistry.disposeScope('replay');
}

export function registerFreeplayRuntimeResources(
  getRuntime: () => FreeplayGoalAndTouchRuntimePort | null | undefined,
  replayRingBuffer: { clear(): void },
  getPreferredTeam: () => 0 | 1
): void {
  runtimeResourceRegistry.register({
    id: 'freeplay:replay-ring-buffer',
    scope: 'replay',
    dispose: () => {
      replayRingBuffer.clear();
    },
  });
  runtimeResourceRegistry.register({
    id: 'physics:wasm-replay-buffer',
    scope: 'replay',
    dispose: () => {
      const runtime = getRuntime();
      runtime?.physics?.clearReplayBuffer?.();
      return runtime?.physics?.reclaimWasmMemoryIfGrown?.(getPreferredTeam()).then(() => undefined);
    },
  });
  runtimeResourceRegistry.register({
    id: 'renderer:render-lists',
    scope: 'replay',
    dispose: () => {
      getRuntime()?.renderer?.renderLists?.dispose?.();
    },
  });
}

export function applyStandaloneViewerKickoffReset(
  standaloneReplayViewer: StandaloneViewerKickoffResetPort | null | undefined,
  onResetPresentation: () => void
): boolean {
  if (!standaloneReplayViewer?.hasLoadedReplay) return false;
  const takeover = standaloneReplayViewer.takeoverSubController;
  const targetIdx = Math.max(
    0,
    Math.min(
      standaloneReplayViewer.frames.length - 1,
      Math.round(takeover.targetFrame || takeover.cursor || 0)
    )
  );
  if (!standaloneReplayViewer.isActive) {
    standaloneReplayViewer._handoffToLiveFreeplay(targetIdx);
  } else {
    standaloneReplayViewer._applyFrameAtCursor(false, false);
  }
  onResetPresentation();
  return true;
}
