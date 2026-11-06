import { useAppStore } from '../runtimeUiPort.ts';
import { audioConfig } from '../../ui-core/config/audioConfig';
import type { CarStateView } from '../../physics/RocketSimStateViews.ts';

/**
 * FramePipeline.ts
 * High-performance 120Hz deterministic execution pipeline, transient FrameContext,
 * and lightweight pipeline stages (InputStage, GameplayModeStage, AudioStage, RenderStage).
 */

export interface PipelineStage {
  name?: string;
  execute(context: FrameContext): void;
}

export class FrameContext {
  public runtime: any;
  public timestamp = 0;
  public dt = 0;
  public isMatchActive = false;
  public goalScored = false;
  public activeCar = 0;
  public activeCarMesh: any = null;
  public playerCarView: CarStateView | null = null;
  public numCarsInArena = 0;
  public isSupersonic = false;
  public curBoost = 0;
  public overrideCarSpeed: number | null = null;
  public hasBlockingOverlay = false;
  public continueOnBlur = false;
  public isHidden = false;
  public shouldSkipGpuRender = false;
  public isSimulationOnly = false;

  constructor(runtime: any) {
    this.runtime = runtime;
    this.reset(0, 0);
  }

  public reset(timestamp: number, dt: number): void {
    this.timestamp = timestamp;
    this.dt = dt;
    this.isMatchActive = false;
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
    this.shouldSkipGpuRender = false;
    this.isSimulationOnly = false;
  }
}

export class InputStage implements PipelineStage {
  public runtime: any;

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;
    r.pollInputs(false);

    const activeCar = r.playerCarIndex;
    const activeCarMesh = r.arena?.cars?.[activeCar];
    const playerCarView = r.interpolator?.getCurrCarStateView(activeCar) ?? null;
    const numCarsInArena = r.interpolator ? r.interpolator.numCars : 0;

    context.activeCar = activeCar;
    context.activeCarMesh = activeCarMesh;
    context.playerCarView = playerCarView;
    context.numCarsInArena = numCarsInArena;
  }
}

export class GameplayModeStage implements PipelineStage {
  public runtime: any;

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;

    const playerCarView = r.interpolator?.getCurrCarStateView(r.playerCarIndex) ?? null;
    context.playerCarView = playerCarView;
    context.isSupersonic = Boolean(playerCarView?.isSupersonic && !playerCarView?.isDemoed);
    context.curBoost = playerCarView?.boost ?? 0;

    r.modeManager?.update?.(context);

    if (r.container && r.container.dataset.gameMode !== r.match.state.mode) {
      r.container.dataset.gameMode = r.match.state.mode;
      if (useAppStore && typeof useAppStore.getState === 'function') {
        useAppStore.getState().setMatchMode(r.match.state.mode);
      }
    }

    if (r.profiler) r.profiler.mark();
  }
}

export class AudioStage implements PipelineStage {
  public runtime: any;

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;

    const continueOnBlur = Boolean(audioConfig.get('continueAudioOnLostFocus'));
    const isHidden =
      typeof document !== 'undefined' && (!document.hasFocus() || document.hidden);
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

    r.audioSubsystem?.update?.(context);

    if (r.profiler) r.profiler.mark();
  }
}

export class RenderStage implements PipelineStage {
  public runtime: any;

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;
    r.renderSubsystem?.update?.(context);
  }
}

export class FramePipeline {
  public runtime: any;
  public context: FrameContext;
  public stages: PipelineStage[] = [];
  public _accumSimTicks = 0;
  public _accumSimDropped = 0;
  public _accumSimStalled = false;

  constructor(runtime: any) {
    this.runtime = runtime;
    this.context = new FrameContext(runtime);
  }

  public addStage(stage: PipelineStage): this {
    this.stages.push(stage);
    return this;
  }

  public executeSimulationOnly(timestamp: number): void {
    const r = this.runtime;
    this.context.timestamp = timestamp;
    this.context.isSimulationOnly = true;

    for (let i = 0; i < Math.min(2, this.stages.length); i++) {
      this.stages[i].execute(this.context);
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
