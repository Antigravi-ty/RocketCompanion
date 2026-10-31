/**
 * RenderStage.js
 * Executes post-processing, BoostBloom occlusion, and final WebGL composer output.
 */
export class RenderStage {
  constructor(runtime) {
    this.runtime = runtime;
  }

  execute(context) {
    const r = this.runtime;
    r.renderSubsystem?.update?.(context);
  }
}
