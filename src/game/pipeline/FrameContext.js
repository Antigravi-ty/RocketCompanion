/**
 * FrameContext.js
 * Encapsulates the per-frame transient execution context across all pipeline stages.
 */

export class FrameContext {
  constructor(runtime) {
    this.runtime = runtime;
    this.reset(0, 0);
  }

  reset(timestamp, dt) {
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
