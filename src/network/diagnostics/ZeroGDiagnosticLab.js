/**
 * src/network/diagnostics/ZeroGDiagnosticLab.js
 * Pure, Worker-safe controller and telemetry evaluator for the In-Arena 2-Car Prediction Probe Lab
 * and Lobby Ghost Car collision isolation (aligned with Developer Test Lab).
 *
 * Uses native C++ WASM extensions exposed on RocketSimPhysicsEngine:
 * - setCarLinearFactorAndGravity(carIndex, fx, fy, fz, gravityScale)
 * - setCarCollisionMask(carIndex, interactWithBall, interactWithCars)
 */

import { CarStateView } from '../../physics/RocketSimStateViews.js';

export const ZERO_G_ANCHOR_MODES = Object.freeze({
  ZERO_G_LOCKED: '0g_locked',
  Z_HOVER: 'z_hover'
});

export const DIAGNOSTIC_OBSERVATION_TARGETS = Object.freeze({
  PLAYER: 0,
  BOOST_PULSE: 6,
  QE_ROLL: 7
});

const _clientCarView = new CarStateView();
const _serverCarView = new CarStateView();
const _probeClimbState = new Map();

export function getProbeAltitudeControllerState(carIndex = 6) {
  let st = _probeClimbState.get(carIndex);
  if (!st) {
    st = {
      mode: 'CLIMB_TO_PEAK',
      holdTicks: 0,
      posZ: 500,
      velZ: 0,
      shouldBoost: true
    };
    _probeClimbState.set(carIndex, st);
  }
  return st;
}

/**
 * Resolves the underlying RocketSimPhysicsEngine from a direct engine, PhysicsEngineManager, or HostServerWorker.
 * @param {object} target
 * @returns {object|null}
 */
export function resolvePhysicsEngine(target) {
  if (!target) return null;
  if (typeof target.setCarLinearFactorAndGravity === 'function') return target;
  if (target.sim && typeof target.sim.setCarLinearFactorAndGravity === 'function') return target.sim;
  if (target.fallbackSim && typeof target.fallbackSim.setCarLinearFactorAndGravity === 'function') return target.fallbackSim;
  return target.sim || null;
}

/**
 * Configures the 2 in-arena diagnostic benchmark vehicles (X=-2500, Y=-400/+400, Z=500/550)
 * on dedicated slots (Car 6: Gravity Boost Altitude Loop 500->600, Car 7: 0G Q/E Roll Probe)
 * and disables their collision masks against the ball and other vehicles.
 *
 * @param {object} targetSimOrAuthority - RocketSimPhysicsEngine, PhysicsEngineManager, or HostServerWorker
 * @param {Array<object>} fleet - Diagnostic vehicle specifications
 * @param {string} [anchorMode=ZERO_G_ANCHOR_MODES.Z_HOVER]
 */
export function configureZeroGVehiclePhysics(
  targetSimOrAuthority,
  fleet,
  anchorMode = ZERO_G_ANCHOR_MODES.Z_HOVER
) {
  const sim = resolvePhysicsEngine(targetSimOrAuthority);
  if (!sim || !Array.isArray(fleet)) return false;

  for (let i = 0; i < fleet.length; i++) {
    const spec = fleet[i];
    if (typeof targetSimOrAuthority.ensureCar === 'function') {
      targetSimOrAuthority.ensureCar(spec.carIndex, spec.team, 'octane');
    } else if (typeof targetSimOrAuthority.registerCarEntity === 'function') {
      targetSimOrAuthority.registerCarEntity(spec.carIndex, spec.team, 'octane');
    } else if (typeof sim.addCarAtSlot === 'function') {
      const alreadyActive = typeof sim.isCarSlotActive === 'function'
        ? sim.isCarSlotActive(spec.carIndex)
        : false;
      if (!alreadyActive) {
        sim.addCarAtSlot(spec.carIndex, spec.team, 'octane');
      } else {
        sim.setCarTeam?.(spec.carIndex, spec.team);
      }
    } else if (typeof sim.addCar === 'function') {
      while (sim.numCars <= spec.carIndex) {
        sim.addCar(spec.team, 'octane');
      }
    }

    const isBoostAltitudeProbe = spec.profile === 'boost_pulse' || spec.carIndex === 6;
    const pos = spec.spawnPos || {
      x: -2500,
      y: isBoostAltitudeProbe ? -400 : 400,
      z: isBoostAltitudeProbe ? 500 : 550
    };

    if (isBoostAltitudeProbe) {
      _probeClimbState.set(spec.carIndex, {
        mode: 'CLIMB_TO_PEAK',
        holdTicks: 0,
        posZ: pos.z,
        velZ: 0,
        shouldBoost: true
      });
    }

    const initialState = isBoostAltitudeProbe
      ? {
          pos: [pos.x, pos.y, pos.z],
          forward: [0, 0, 1],
          right: [0, 1, 0],
          up: [-1, 0, 0],
          vel: [0, 0, 0],
          angVel: [0, 0, 0],
          boost: 100,
          isOnGround: false
        }
      : {
          pos: [pos.x, pos.y, pos.z],
          forward: [1, 0, 0],
          right: [0, 1, 0],
          up: [0, 0, 1],
          vel: [0, 0, 0],
          angVel: [0, 0, 0],
          boost: 100,
          isOnGround: false
        };

    if (typeof sim.setCarState === 'function') {
      sim.setCarState(spec.carIndex, initialState);
    }

    if (typeof sim.setCarCollisionMask === 'function') {
      sim.setCarCollisionMask(spec.carIndex, false, false);
    }

    if (typeof sim.setCarLinearFactorAndGravity === 'function') {
      if (isBoostAltitudeProbe && anchorMode !== ZERO_G_ANCHOR_MODES.ZERO_G_LOCKED) {
        sim.setCarLinearFactorAndGravity(spec.carIndex, 0, 0, 1, 1.0);
      } else {
        sim.setCarLinearFactorAndGravity(spec.carIndex, 0, 0, 0, 0.0);
      }
    }
  }

  return true;
}

/**
 * Restores standard 3D linear motion, normal gravity, and removes released diagnostic slots.
 *
 * @param {object} targetSimOrAuthority
 * @param {Array<object>} fleet
 */
export function releaseZeroGVehiclePhysics(targetSimOrAuthority, fleet) {
  const sim = resolvePhysicsEngine(targetSimOrAuthority);
  if (!sim || !Array.isArray(fleet)) return false;

  for (let i = 0; i < fleet.length; i++) {
    const spec = fleet[i];
    _probeClimbState.delete(spec.carIndex);
    if (typeof targetSimOrAuthority.unregisterCarEntity === 'function') {
      targetSimOrAuthority.unregisterCarEntity(spec.carIndex);
      continue;
    }
    if (typeof sim.removeCar === 'function') {
      sim.removeCar(spec.carIndex);
    }
  }
  return true;
}

/**
 * Configures Lobby Ghost Car collision isolation on a specific vehicle slot.
 * When `isGhost` is true, the vehicle can drive and fly freely across the stadium
 * without colliding with the ball or other vehicles.
 *
 * @param {object} targetSimOrAuthority
 * @param {number} carIndex
 * @param {boolean} isGhost
 * @param {boolean} [interactWithBallWhenGhost=false]
 */
export function setLobbyGhostCarIsolation(
  targetSimOrAuthority,
  carIndex = 0,
  isGhost = true,
  interactWithBallWhenGhost = false
) {
  const sim = resolvePhysicsEngine(targetSimOrAuthority);
  if (!sim || typeof sim.setCarCollisionMask !== 'function') return false;
  if (isGhost) {
    return sim.setCarCollisionMask(carIndex, Boolean(interactWithBallWhenGhost), false);
  }
  return sim.setCarCollisionMask(carIndex, true, true);
}

/**
 * Maintains boost level at 100 for the Gravity Boost Loop Probe (Car 6 / Slot 6), tracks its
 * Z0=500 -> Z1=600 state machine (matching SubsystemIsolationLabProbesHelper), and keeps
 * Probe B (Car 7 / Slot 7) anchored in-arena at (-2500, 400, 550).
 *
 * @param {object} targetSimOrAuthority
 * @param {Array<object>} fleet
 * @param {string} [anchorMode=ZERO_G_ANCHOR_MODES.Z_HOVER]
 */
export function enforceZeroGFleetConstraints(
  targetSimOrAuthority,
  fleet,
  anchorMode = ZERO_G_ANCHOR_MODES.Z_HOVER
) {
  const sim = resolvePhysicsEngine(targetSimOrAuthority);
  if (!sim || !sim.state || !Array.isArray(fleet)) return;

  for (let i = 0; i < fleet.length; i++) {
    const spec = fleet[i];
    if (sim.numCars !== undefined && spec.carIndex >= sim.numCars) continue;

    const view = typeof sim.getCarStateView === 'function'
      ? sim.getCarStateView(spec.carIndex)
      : _clientCarView.attachCar(sim.state, spec.carIndex);

    if (!view) continue;

    const isBoostAltitudeProbe = spec.profile === 'boost_pulse' || spec.carIndex === 6;
    if (isBoostAltitudeProbe && anchorMode !== ZERO_G_ANCHOR_MODES.ZERO_G_LOCKED) {
      const targetX = spec.spawnPos?.x ?? -2500;
      const targetY = spec.spawnPos?.y ?? -400;
      const z0 = spec.baseAltitudeZ ?? (spec.spawnPos?.z ?? 500);
      const z1 = spec.peakAltitudeZ ?? 600;
      const tol = 10;
      const targetHoldTicks = 120; // 1.0s @ 120Hz matching SubsystemIsolationLabProbesHelper
      const curZ = view.posZ;
      const curVz = view.velZ;
      const st = getProbeAltitudeControllerState(spec.carIndex);
      st.posZ = curZ;
      st.velZ = curVz;

      // Keep fuel full
      view.boost = 100;

      // Re-align orientation if nose tilts away from straight up (+Z) or drifts horizontally
      if (view.fwdZ < 0.995 || Math.abs(view.posX - targetX) > 5 || Math.abs(view.posY - targetY) > 5) {
        sim.setCarState?.(spec.carIndex, {
          pos: [targetX, targetY, curZ],
          forward: [0, 0, 1],
          right: [0, 1, 0],
          up: [-1, 0, 0],
          vel: [0, 0, curVz],
          angVel: [0, 0, 0],
          boost: 100,
          isOnGround: false
        });
      }

      let shouldBoost = false;
      if (st.mode === 'CLIMB_TO_PEAK' || st.mode === 'CLIMB_Z1') {
        if (curZ < z1) {
          shouldBoost = true;
        } else {
          shouldBoost = false;
          st.mode = 'FALL_BELOW_BASE';
          st.holdTicks = 0;
        }
      } else if (st.mode === 'FALL_BELOW_BASE' || st.mode === 'FALL_Z0') {
        shouldBoost = false;
        if (curZ < z0) {
          st.mode = 'RECOVER_AND_HOLD';
          st.holdTicks = 0;
          shouldBoost = true;
        }
      } else {
        // RECOVER_AND_HOLD: energy-based stopping altitude prediction matching SubsystemIsolationLabProbesHelper
        if (curVz > 0) {
          const coastApexZ = curZ + (curVz * curVz) / (2 * 650.0);
          shouldBoost = coastApexZ < z0;
        } else {
          const predictedZ = curZ + curVz * 0.08;
          shouldBoost = predictedZ < z0;
        }

        if (Math.abs(curZ - z0) <= tol && Math.abs(curVz) <= 45) {
          st.holdTicks++;
          if (st.holdTicks >= targetHoldTicks) {
            sim.setCarState?.(spec.carIndex, {
              pos: [targetX, targetY, z0],
              forward: [0, 0, 1],
              right: [0, 1, 0],
              up: [-1, 0, 0],
              vel: [0, 0, 0],
              angVel: [0, 0, 0],
              boost: 100,
              isOnGround: false
            });
            st.mode = 'CLIMB_TO_PEAK';
            st.holdTicks = 0;
            shouldBoost = true;
          }
        } else if (Math.abs(curZ - z0) > tol * 1.5) {
          st.holdTicks = 0;
        }
      }

      st.shouldBoost = shouldBoost;

      if (!Number.isFinite(curZ) || curZ < 80 || curZ > 1200) {
        sim.setCarState?.(spec.carIndex, {
          pos: [targetX, targetY, z0],
          forward: [0, 0, 1],
          right: [0, 1, 0],
          up: [-1, 0, 0],
          vel: [0, 0, 0],
          angVel: [0, 0, 0],
          boost: 100,
          isOnGround: false
        });
        st.mode = 'CLIMB_TO_PEAK';
        st.holdTicks = 0;
        st.shouldBoost = true;
      }
    } else {
      // Probe B (QE Roll): keep anchored at spawnPos and maintain fuel at 100
      const targetX = spec.spawnPos?.x ?? -2500;
      const targetY = spec.spawnPos?.y ?? 400;
      const targetZ = spec.spawnPos?.z ?? 550;
      if (
        Math.abs(view.posX - targetX) > 5 ||
        Math.abs(view.posY - targetY) > 5 ||
        Math.abs(view.posZ - targetZ) > 5
      ) {
        sim.setCarState?.(spec.carIndex, {
          pos: [targetX, targetY, targetZ],
          forward: [1, 0, 0],
          right: [0, 1, 0],
          up: [0, 0, 1],
          vel: [0, 0, 0],
          angVel: [view.angVelX, view.angVelY, view.angVelZ],
          boost: 100,
          isOnGround: false
        });
      }
      if (view.boost < 80) {
        view.boost = 100;
      }
    }
  }
}

/**
 * Samples live kinematic and angular telemetry for the 3 diagnostic vehicles,
 * optionally comparing client state against an authoritative server state buffer.
 *
 * @param {object} clientSim - Client RocketSimPhysicsEngine
 * @param {Float32Array|null} [serverSnapshot=null] - Optional authoritative snapshot
 * @param {Array<object>} [fleet=[]]
 * @returns {Array<object>}
 */
export function sampleDiagnosticFleetTelemetry(clientSim, serverStateBuffer = null, fleet = []) {
  if (!clientSim || !clientSim.state || !Array.isArray(fleet)) return [];
  const results = [];
  const hasServerStateBuf =
    serverStateBuffer instanceof Float32Array &&
    serverStateBuffer.length === clientSim.state.length;

  for (let i = 0; i < fleet.length; i++) {
    const spec = fleet[i];
    if (clientSim.numCars !== undefined && spec.carIndex >= clientSim.numCars) continue;

    _clientCarView.attachCar(clientSim.state, spec.carIndex);
    const posX = _clientCarView.posX;
    const posY = _clientCarView.posY;
    const posZ = _clientCarView.posZ;
    const angSpeed = Math.hypot(_clientCarView.angVelX, _clientCarView.angVelY, _clientCarView.angVelZ);
    const isBoosting = Boolean(_clientCarView.isBoosting);

    let posDriftUu = 0;
    let angVelErrorRad = 0;
    if (hasServerStateBuf) {
      _serverCarView.attachCar(serverStateBuffer, spec.carIndex);
      posDriftUu = Math.hypot(
        posX - _serverCarView.posX,
        posY - _serverCarView.posY,
        posZ - _serverCarView.posZ
      );
      angVelErrorRad = Math.hypot(
        _clientCarView.angVelX - _serverCarView.angVelX,
        _clientCarView.angVelY - _serverCarView.angVelY,
        _clientCarView.angVelZ - _serverCarView.angVelZ
      );
    } else if (spec.spawnPos) {
      posDriftUu = Math.hypot(posX - spec.spawnPos.x, posY - spec.spawnPos.y);
    }

    results.push({
      carIndex: spec.carIndex,
      profile: spec.profile,
      label: spec.label,
      pos: [Number(posX.toFixed(1)), Number(posY.toFixed(1)), Number(posZ.toFixed(1))],
      angSpeedRad: Number(angSpeed.toFixed(2)),
      isBoosting,
      posDriftUu: Number(posDriftUu.toFixed(2)),
      angVelErrorRad: Number(angVelErrorRad.toFixed(2))
    });
  }

  return results;
}
