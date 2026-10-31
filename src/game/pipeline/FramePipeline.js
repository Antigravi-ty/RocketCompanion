import { FrameContext } from './FrameContext.js';

/**
 * FramePipeline.js
 * High-performance 120Hz deterministic execution pipeline.
 * Executes decoupled pipeline stages sequentially with zero garbage generation.
 */
export class FramePipeline {
  /**
   * @param {object} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    this.context = new FrameContext(runtime);
    this.stages = [];
    this._accumSimTicks = 0;
    this._accumSimDropped = 0;
    this._accumSimStalled = false;
  }

  /**
   * Register a new stage in the execution order
   * @param {{ name: string, execute: (context: FrameContext) => void }} stage
   * @returns {this}
   */
  addStage(stage) {
    this.stages.push(stage);
    return this;
  }

  /**
   * Advance only the 120Hz input & simulation stages when render FPS is throttled below 120Hz.
   * Keeps physics and network reconciliation running at 120Hz decoupled from GPU render rate.
   * @param {number} timestamp
   */
  executeSimulationOnly(timestamp) {
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

  /**
   * Advance one full frame through all registered pipeline stages (simulation + presentation + render).
   * @param {number} timestamp
   */
  execute(timestamp) {
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
