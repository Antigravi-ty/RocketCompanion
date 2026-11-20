import type * as THREE from 'three';
import { getSpectateHostMatchMode, useAppStore } from '../runtimeUiPort.ts';
import { audioConfig } from '../../ui-core/config/audioConfig.ts';
import type { CarStateView } from '../../physics/RocketSimStateViews.ts';

/**
 * FramePipeline.ts
 * High-performance 120Hz deterministic execution pipeline, transient FrameContext,
 * and lightweight pipeline stages (InputStage, GameplayModeStage, AudioStage, RenderStage).
 */

export type VNextPlaybackState = 'playing' | 'paused' | 'ended';

export type ActiveCarMeshPort = THREE.Object3D & {
  group?: THREE.Object3D;
  visible?: boolean;
};

export interface FramePipelineRuntimePort {
  playerCarIndex: number;
  lastTimestamp: number;
  container: HTMLElement | null;
  openOverlays: Set<string>;
  arena: { cars?: Array<ActiveCarMeshPort | null | undefined> } | null;
  interpolator: {
    numCars: number;
    lastTicks?: number;
    lastDropped?: number;
    lastStalled?: boolean;
    getCurrCarStateView(carIndex: number): CarStateView | null;
  } | null;
  keyboard: { enabled?: boolean } | null;
  match: { state: { mode: string; phase?: string; playbackState?: VNextPlaybackState } } | null;
  profiler: { frameStart(): void; mark(): void } | null;
  modeManager: {
    update(context: FrameContext): void;
    getActiveMode?(): { isGoalReplayActive?(): boolean } | null;
  } | null;
  audioSubsystem: { update(context: FrameContext): void } | null;
  renderSubsystem: { update(context: FrameContext): void } | null;
  telestratorOverlay?: { update?(): void } | null;
  networkReconciler?: {
    spectateMirrorMode?: boolean;
    playbackState?: VNextPlaybackState;
  } | null;
  playbackState?: VNextPlaybackState;
  pollInputs(commitPhysicsStep?: boolean): boolean;
}

export interface PipelineStage {
  name?: string;
  execute(context: FrameContext): void;
}

export class FrameContext {
  public runtime: FramePipelineRuntimePort;
  public timestamp = 0;
  public dt = 0;
  public isMatchActive = false;
  public isInputEnabled = true;
  public isPodiumActive = false;
  public isGoalReplayActive = false;
  public hasActiveFlipResetBloom = false;
  public cameraVelocity: THREE.Vector3 | null = null;
  public goalScored = false;
  public activeCar = 0;
  public activeCarMesh: ActiveCarMeshPort | null = null;
  public playerCarView: CarStateView | null = null;
  public numCarsInArena = 0;
  public isSupersonic = false;
  public curBoost = 0;
  public overrideCarSpeed: number | null = null;
  public hasBlockingOverlay = false;
  public continueOnBlur = false;
  public isHidden = false;
  public playbackState: VNextPlaybackState = 'playing';
  public shouldSkipGpuRender = false;
  public isSimulationOnly = false;

  constructor(runtime: FramePipelineRuntimePort) {
    this.runtime = runtime;
    this.reset(0, 0);
  }

  public reset(timestamp: number, dt: number): void {
    this.timestamp = timestamp;
    this.dt = dt;
    this.isMatchActive = false;
    this.isInputEnabled = true;
    this.isPodiumActive = false;
    this.isGoalReplayActive = false;
    this.hasActiveFlipResetBloom = false;
    this.cameraVelocity = null;
    this.goalScored = false;
    this.activeCar = 0;
    this.activeCarMesh = null;
    this.playerCarView = null;
    this.numCarsInArena = 0;
    this.isSupersonic = false;
    this.curBoost = 0;
    this.overrideCarSpeed = null;
    this.hasBlockingOverlay = false;
    this.continueOnBlur = false;
    this.isHidden = false;
    this.playbackState = 'playing';
    this.shouldSkipGpuRender = false;
    this.isSimulationOnly = false;
  }
}

export class InputStage implements PipelineStage {
  public runtime: FramePipelineRuntimePort;

  constructor(runtime: FramePipelineRuntimePort) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;
    r.pollInputs(false);

    const activeCar = r.playerCarIndex;
    const activeCarMesh = (r.arena?.cars?.[activeCar] as ActiveCarMeshPort | undefined) ?? null;
    const playerCarView = r.interpolator?.getCurrCarStateView(activeCar) ?? null;
    const numCarsInArena = r.interpolator ? r.interpolator.numCars : 0;

    context.activeCar = activeCar;
    context.activeCarMesh = activeCarMesh;
    context.playerCarView = playerCarView;
    context.numCarsInArena = numCarsInArena;
    context.isInputEnabled = Boolean(r.keyboard?.enabled);
  }
}

export class GameplayModeStage implements PipelineStage {
  public runtime: FramePipelineRuntimePort;

  constructor(runtime: FramePipelineRuntimePort) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;

    const playerCarView = r.interpolator?.getCurrCarStateView(r.playerCarIndex) ?? null;
    context.playerCarView = playerCarView;
    context.isSupersonic = Boolean(playerCarView?.isSupersonic && !playerCarView?.isDemoed);
    context.curBoost = playerCarView?.boost ?? 0;

    r.modeManager?.update?.(context);

    const online = useAppStore?.getState?.()?.onlineSession;
    const isSpectatingFollow = Boolean(
      online?.isDevSyncRoom && !online?.isHosting && r.networkReconciler?.spectateMirrorMode
    );
    if (isSpectatingFollow && r.match) {
      const wsHostMode = getSpectateHostMatchMode();
      const targetMode = wsHostMode || useAppStore.getState().matchMode;
      if (targetMode && targetMode !== 'online-warmup' && r.match.state.mode !== targetMode) {
        r.match.state.mode = targetMode;
      }
      if (wsHostMode && useAppStore.getState().matchMode !== wsHostMode) {
        useAppStore.getState().setMatchMode(wsHostMode);
      }
    }
    if (r.container && r.match && r.container.dataset.gameMode !== r.match.state.mode) {
      r.container.dataset.gameMode = r.match.state.mode;
      if (!isSpectatingFollow && useAppStore && typeof useAppStore.getState === 'function') {
        useAppStore.getState().setMatchMode(r.match.state.mode);
      }
    }

    if (r.profiler) r.profiler.mark();
  }
}

export class AudioStage implements PipelineStage {
  public runtime: FramePipelineRuntimePort;

  constructor(runtime: FramePipelineRuntimePort) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;

    const continueOnBlur = Boolean(audioConfig.get('continueAudioOnLostFocus'));
    const isHidden = typeof document !== 'undefined' && (!document.hasFocus() || document.hidden);
    let hasBlockingOverlay = false;
    if (r.openOverlays && r.openOverlays.size > 0) {
      for (const n of r.openOverlays) {
        if (n !== 'trajectory') {
          hasBlockingOverlay = true;
          break;
        }
      }
    }

    context.continueOnBlur = continueOnBlur;
    context.isHidden = isHidden;
    context.hasBlockingOverlay = hasBlockingOverlay;
    const rawPlaybackState =
      r.playbackState ?? r.networkReconciler?.playbackState ?? r.match?.state?.playbackState;
    if (rawPlaybackState === 'paused' || rawPlaybackState === 'ended') {
      context.playbackState = rawPlaybackState;
    } else if (rawPlaybackState === 'playing') {
      context.playbackState = 'playing';
    }

    r.audioSubsystem?.update?.(context);

    if (r.profiler) r.profiler.mark();
  }
}

export class RenderStage implements PipelineStage {
  public runtime: FramePipelineRuntimePort;

  constructor(runtime: FramePipelineRuntimePort) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;
    r.telestratorOverlay?.update?.();
    r.renderSubsystem?.update?.(context);
  }
}

export class FramePipeline {
  public runtime: FramePipelineRuntimePort;
  public context: FrameContext;
  public stages: PipelineStage[] = [];
  public _accumSimTicks = 0;
  public _accumSimDropped = 0;
  public _accumSimStalled = false;

  constructor(runtime: FramePipelineRuntimePort) {
    this.runtime = runtime;
    this.context = new FrameContext(runtime);
  }

  public addStage(stage: PipelineStage): this {
    this.stages.push(stage);
    return this;
  }

  public executeSimulationOnly(timestamp: number): void {
    const r = this.runtime;
    const dt = Math.min(Math.max(0, (timestamp - r.lastTimestamp) / 1000), 0.1);
    r.lastTimestamp = timestamp;
    this.context.timestamp = timestamp;
    this.context.dt = dt;
    this.context.isSimulationOnly = true;

    for (let i = 0; i < Math.min(2, this.stages.length); i++) {
      this.stages[i].execute(this.context);
    }
    const activeMode = r.modeManager?.getActiveMode?.();
    if (
      (activeMode?.isGoalReplayActive?.() || r.match?.state?.phase === 'replay') &&
      this.stages.length > 2
    ) {
      this.stages[2].execute(this.context);
    }

    this._accumSimTicks += r.interpolator?.lastTicks ?? 0;
    this._accumSimDropped += r.interpolator?.lastDropped ?? 0;
    if (r.interpolator?.lastStalled) {
      this._accumSimStalled = true;
    }
    this.context.isSimulationOnly = false;
  }

  public execute(timestamp: number): boolean {
    const r = this.runtime;
    if (r.profiler) r.profiler.frameStart();

    const dt = Math.min((timestamp - r.lastTimestamp) / 1000, 0.1);
    r.lastTimestamp = timestamp;

    this.context.reset(timestamp, dt);

    for (let i = 0; i < this.stages.length; i++) {
      this.stages[i].execute(this.context);
    }

    this._accumSimTicks = 0;
    this._accumSimDropped = 0;
    this._accumSimStalled = false;

    return !this.context.shouldSkipGpuRender;
  }
}
