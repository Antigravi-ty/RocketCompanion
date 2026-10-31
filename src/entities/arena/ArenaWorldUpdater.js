/**
 * ArenaWorldUpdater.js
 * 120Hz physics state interpolation and visual tick coordinator for the arena world.
 */

import { unrealToThreeCoords, interpolatePhysicsTransform } from './ArenaMath.js';
import { updateCarSuspensionAndSteering } from '../VehicleSuspensionSystem.js';
import { updateBoostVisuals } from './ArenaVehicleAnimator.js';
import { updateVehicleBrakeLamps } from '../vehicle/vehicleWheelsAndLamps.js';
import { updateSkyboxFrame } from './ArenaSky.js';
import { updateBallGoalEffect } from '../BallVisual.js';

export function updateArenaFrame(arena, prevState, currState, alpha, delta = 0, throttle = 0, controls, opponentControls, activeVisuals = true, carControlsResolver = null) {
  let actualDelta = delta;
  let actualThrottle = throttle;
  if (actualDelta > 0.1 && actualThrottle > 0 && actualThrottle < 0.05) {
    actualDelta = throttle;
    actualThrottle = delta;
  }

  const header = arena._headerView.attach(currState);
  const currBall = arena._currBallView.attach(currState);
  const prevBall = arena._prevBallView.attach(prevState);
  interpolatePhysicsTransform(arena.ball, prevBall, currBall, alpha, undefined, arena.pA, arena.pB, arena.qA, arena.qB);
  unrealToThreeCoords(arena.ballVelocity, currBall.velX, currBall.velY, currBall.velZ);
  arena.ballSpeedTrail?.update(arena.ball.position, arena.ballVelocity, actualDelta);

  const ballPos = arena.ball.position;
  updateBallGoalEffect(arena.ball, Boolean(arena.isThrowbackStadiumActive), actualDelta);
  arena.driftwoodsManager?.updateBallProximity?.(ballPos, arena.ballVelocity, actualDelta);
  arena.goalBarrierVisual?.update?.(actualDelta);
  arena.indicatorRing.position.set(ballPos.x, 2, ballPos.z);
  arena.indicatorHeightRing.position.set(ballPos.x, 2, ballPos.z);
  const height = Math.max(0, ballPos.y - arena.ballRadius);
  const scale = 0.86 - 0.68 * Math.min(1, height / 1600);
  arena.indicatorHeightRing.scale.set(scale, scale, 1);

  const maxCars = Math.max(arena.cars.length, Math.min(8, header.numCars || 0));
  for (let carIndex = 0; carIndex < maxCars; carIndex++) {
    if (carIndex >= header.numCars) {
      if (arena.cars[carIndex]) {
        arena.cars[carIndex].visible = false;
        arena.carDemolitions[carIndex]?.update(actualDelta, false, arena.cars[carIndex].position, false);
      }
      if (arena.carBoosts?.[carIndex]) {
        for (const emitter of arena.carBoosts[carIndex]) {
          emitter?.resetVisual?.();
        }
      }
      continue;
    }

    const currCar = arena._currCarView.attachCar(currState, carIndex);
    const prevCar = arena._prevCarView.attachCar(prevState, carIndex);

    // Check if this slot is parked in the off-arena inactive staging zone or is a zeroed sparse slot
    const isZeroedSlot = (currCar.fwdX * currCar.fwdX + currCar.fwdY * currCar.fwdY + currCar.fwdZ * currCar.fwdZ) < 0.01;
    const isParkedInactive = isZeroedSlot || (currCar.posX < -5000 && currCar.posZ < -200);
    if (isParkedInactive) {
      if (arena.cars[carIndex]) {
        arena.cars[carIndex].visible = false;
        arena.carDemolitions[carIndex]?.update(actualDelta, false, arena.cars[carIndex].position, false);
      }
      if (arena.carBoosts?.[carIndex]) {
        for (const emitter of arena.carBoosts[carIndex]) {
          emitter?.resetVisual?.();
        }
      }
      continue;
    }

    if (!arena.cars[carIndex] && typeof arena.ensureCar === 'function') {
      const defaultTeam = carIndex === 6 ? 0 : (carIndex === 7 ? 1 : (carIndex % 2));
      arena.ensureCar(carIndex, defaultTeam, arena.carVisual || "fennec");
    }
    if (!arena.cars[carIndex]) continue;

    const isLocalCar = carIndex === (arena.playerCarIndex ?? 0);
    if (arena.isLobbyMode) {
      const isLobbyDiagCar = carIndex === 6 || carIndex === 7;
      if (!isLocalCar && !isLobbyDiagCar) {
        if (arena.cars[carIndex]) {
          arena.cars[carIndex].visible = false;
        }
        continue;
      }
    }

    const carControls = typeof carControlsResolver === 'function'
      ? carControlsResolver(carIndex)
      : (carIndex === 0 ? controls : opponentControls);
    const carThrottle = isLocalCar ? actualThrottle : (carControls?.throttle ?? 0);

    const isRespawning = prevCar.isDemoed && !currCar.isDemoed;
    interpolatePhysicsTransform(
      arena.cars[carIndex],
      isRespawning ? currCar : prevCar,
      currCar,
      alpha,
      undefined,
      arena.pA,
      arena.pB,
      arena.qA,
      arena.qB
    );

    const isAlive = !currCar.isDemoed;
    arena.carDemolitions[carIndex]?.update(actualDelta, !isAlive, arena.cars[carIndex].position, activeVisuals);
    arena.cars[carIndex].visible = isAlive;

    const forwardSpeed = currCar.forwardSpeed ?? 0;
    const isOnGround = Boolean(currCar.isOnGround);
    const isPowersliding = Boolean(carControls?.handbrake);
    updateVehicleBrakeLamps(
      arena.cars[carIndex],
      arena.vehiclePresets[carIndex],
      forwardSpeed,
      carThrottle,
      isOnGround,
      isPowersliding,
      actualDelta
    );

    updateCarSuspensionAndSteering(
      arena.carWheels[carIndex],
      arena.carWheelSpecs[carIndex],
      arena.carSuspension[carIndex],
      arena.wheelSpin[carIndex],
      currCar,
      arena.vehiclePresets[carIndex],
      actualDelta,
      carThrottle
    );
  }

  arena.lighting.updateSunIntensities(header.numCars);
  arena.lighting.updateShadows(arena.cars, arena.ball, arena.camera);
  updateSkyboxFrame(actualDelta, arena.lighting?._shadowDir);
  arena.boostPadSystem?.update(currState, undefined, actualDelta, arena.camera);
  arena.nameTagSystem?.update(arena, header.numCars, arena.camera);
  arena.respawnGhostPreview?.update?.(currState, actualDelta);
  updateBoostVisuals(
    arena.cars,
    arena.carBoosts,
    currState,
    actualThrottle,
    actualDelta,
    opponentControls?.throttle ?? 0,
    activeVisuals,
    controls,
    opponentControls,
    arena.playerCarIndex,
    arena._headerView,
    arena._currCarView,
    carControlsResolver
  );
}
