/**
 * InputStage.js
 * Polls physical input controllers (gamepad, keyboard) and dispatches to simulation / network reconciler.
 */
export class InputStage {
  constructor(runtime) {
    this.runtime = runtime;
  }

  execute(context) {
    const r = this.runtime;
    r.pollInputs(false);

    // Context metadata resolution
    const activeCar = r.playerCarIndex;
    const activeCarMesh = r.arena?.cars?.[activeCar];
    const playerCarView = r.interpolator?.getCurrCarStateView(activeCar);
    const numCarsInArena = r.interpolator ? r.interpolator.numCars : 0;

    context.activeCar = activeCar;
    context.activeCarMesh = activeCarMesh;
    context.playerCarView = playerCarView;
    context.numCarsInArena = numCarsInArena;
  }
}
