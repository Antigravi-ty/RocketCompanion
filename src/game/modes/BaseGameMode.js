export class BaseGameMode {
  constructor(id, runtime) {
    this.id = id;
    this.runtime = runtime;
  }

  onEnter() {}

  /**
   * Evaluates game mode rules during frame execution
   * @param {import('../pipeline/FrameContext.js').FrameContext} context
   */
  update(context) {}

  /**
   * Called when a goal is scored
   */
  onGoal() {}

  /**
   * Resets field state according to mode rules
   */
  onResetKickoff(seed = -1) {}

  onLeave() {}
}
