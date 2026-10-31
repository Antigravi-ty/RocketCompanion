/**
 * ArenaVehicleAnimator.js
 * Per-frame boost visual emitter propagation.
 */

import { vehicleTunerRuntimeFlags } from '../../ui-core/config/vehicleTunerConfig.js';

/**
 * Propagates boost emitter particles and sound triggers.
 */
export function updateBoostVisuals(cars, carBoosts, currState, throttle, delta, opponentThrottle = 0, activeVisuals = true, controls = null, opponentControls = null, playerCarIndex = 0, headerView = null, currCarView = null, carControlsResolver = null) {
  const header = headerView?.attach(currState);
  const numCars = header ? header.numCars : cars.length;
  const localCarIdx = playerCarIndex ?? 0;
  const maxSlots = Math.max(cars?.length ?? 0, carBoosts?.length ?? 0);

  for (let carIndex = 0; carIndex < maxSlots; carIndex++) {
    if (!cars[carIndex] || carIndex >= numCars || !cars[carIndex].visible) {
      if (carIndex >= numCars || !cars[carIndex]) {
        for (const emitter of carBoosts?.[carIndex] ?? []) {
          emitter?.resetVisual?.();
        }
        continue;
      }
    }
    const carView = currCarView?.attachCar(currState, carIndex);
    const isLocalCar = carIndex === localCarIdx;
    const carCtrl = typeof carControlsResolver === 'function'
      ? carControlsResolver(carIndex)
      : (carIndex === 0 ? controls : opponentControls);
    const forcePreview = isLocalCar && Boolean(vehicleTunerRuntimeFlags.forceBoostPreview);
    const isBoosting = activeVisuals && (forcePreview || (carView && carView.isBoosting) || Boolean(carCtrl?.boost && carView && carView.boost > 0));
    const isAudibleActive = isLocalCar;
    const currentThrottle = isLocalCar ? throttle : (carCtrl?.throttle ?? opponentThrottle);
    for (const emitter of carBoosts[carIndex] ?? []) {
      emitter.setSpatial?.(!isAudibleActive);
      emitter.update?.(isBoosting, activeVisuals && (forcePreview || currentThrottle > 0.01), cars[carIndex].visible, delta, activeVisuals);
    }
  }
}
