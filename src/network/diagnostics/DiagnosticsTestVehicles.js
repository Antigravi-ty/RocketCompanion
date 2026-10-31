/**
 * DiagnosticsTestVehicles.js
 * Pure, zero-dependency deterministic control generators and coordinator
 * for the 2 In-Arena Lobby Network Quality Prediction Probes (matching Developer Test Lab):
 *
 * 1. BOOST_PULSE (Car 6 / Slot 6 - Unpredictable Gravity Boost Altitude Loop):
 *    - Standard gravity (gravityScale = 1.0), horizontal XY translation locked (fx=0, fy=0, fz=1).
 *    - Placed inside the arena at (-2500, -400, Z0=500), climbing to Z1=600, falling below 500,
 *      and recovering/holding at 500 for 1.0s (120 ticks) before repeating.
 * 2. QE_ROLL (Car 7 / Slot 7 - Predictable 0G Q/E Roll):
 *    - Zero gravity (gravityScale = 0.0), XYZ translation locked (fx=0, fy=0, fz=0).
 *    - Placed inside the arena at (-2500, 400, 550), alternating Q (+1.0) and E (-1.0) roll every 2.0s (240 ticks).
 */

import {
  ZERO_G_ANCHOR_MODES,
  DIAGNOSTIC_OBSERVATION_TARGETS,
  getProbeAltitudeControllerState,
  configureZeroGVehiclePhysics,
  releaseZeroGVehiclePhysics,
  setLobbyGhostCarIsolation,
  enforceZeroGFleetConstraints,
  sampleDiagnosticFleetTelemetry
} from './ZeroGDiagnosticLab.js';

export {
  ZERO_G_ANCHOR_MODES,
  DIAGNOSTIC_OBSERVATION_TARGETS,
  getProbeAltitudeControllerState,
  configureZeroGVehiclePhysics,
  releaseZeroGVehiclePhysics,
  setLobbyGhostCarIsolation,
  enforceZeroGFleetConstraints,
  sampleDiagnosticFleetTelemetry
};

export const DIAGNOSTIC_VEHICLE_PROFILES = Object.freeze({
  BOOST_PULSE: 'boost_pulse',
  QE_ROLL: 'qe_roll',
  SINE_STEER: 'sine_steer'
});

export const DEFAULT_DIAGNOSTIC_FLEET = Object.freeze([
  Object.freeze({
    carIndex: 6,
    team: 0,
    name: 'Boost',
    profile: DIAGNOSTIC_VEHICLE_PROFILES.BOOST_PULSE,
    label: 'Boost',
    baseAltitudeZ: 500,
    peakAltitudeZ: 600,
    spawnPos: Object.freeze({ x: -2500, y: -400, z: 500 })
  }),
  Object.freeze({
    carIndex: 7,
    team: 1,
    name: 'Roll',
    profile: DIAGNOSTIC_VEHICLE_PROFILES.QE_ROLL,
    label: 'Roll',
    spawnPos: Object.freeze({ x: -2500, y: 400, z: 550 })
  })
]);

/**
 * Generates deterministic 120Hz controls for a diagnostic vehicle profile at `tick`.
 *
 * @param {string} profile - One of DIAGNOSTIC_VEHICLE_PROFILES
 * @param {number} tick - Authoritative 120Hz simulation tick
 * @param {object} [options={}]
 * @returns {object} Standard 8-channel RocketSim CarControls object
 */
export function computeDiagnosticVehicleControls(profile, tick, options = {}) {
  const safeTick = Math.max(0, Math.floor(tick || 0));

  switch (profile) {
    case DIAGNOSTIC_VEHICLE_PROFILES.BOOST_PULSE: {
      const z0 = options.baseAltitudeZ ?? 500;
      const z1 = options.peakAltitudeZ ?? 600;
      const st = getProbeAltitudeControllerState(options.carIndex ?? 6);
      const posZ = Number.isFinite(options.posZ) ? options.posZ : st.posZ;
      const velZ = Number.isFinite(options.velZ) ? options.velZ : st.velZ;
      const mode = options.climbMode || st.mode;

      let isBoosting = false;
      if (options.anchorMode === ZERO_G_ANCHOR_MODES.ZERO_G_LOCKED) {
        const periodTicks = options.periodTicks || 60;
        const dutyTicks = options.dutyTicks || 15;
        isBoosting = (safeTick % periodTicks) < dutyTicks;
      } else if (typeof st.shouldBoost === 'boolean') {
        isBoosting = st.shouldBoost;
      } else if (mode === 'CLIMB_TO_PEAK' || mode === 'CLIMB_Z1') {
        isBoosting = posZ < z1;
      } else if (mode === 'FALL_BELOW_BASE' || mode === 'FALL_Z0') {
        isBoosting = false;
      } else {
        // RECOVER_AND_HOLD: energy-based stopping altitude prediction matching SubsystemIsolationLabProbesHelper
        if (velZ > 0) {
          const coastApexZ = posZ + (velZ * velZ) / (2 * 650.0);
          isBoosting = coastApexZ < z0;
        } else {
          const predictedZ = posZ + velZ * 0.08;
          isBoosting = predictedZ < z0;
        }
      }

      return {
        throttle: isBoosting ? 1.0 : 0.0,
        steer: 0.0,
        pitch: 0.0,
        yaw: 0.0,
        roll: 0.0,
        jump: false,
        boost: isBoosting,
        handbrake: false
      };
    }

    case DIAGNOSTIC_VEHICLE_PROFILES.QE_ROLL: {
      const reverseEveryTicks = options.reverseEveryTicks || 240; // Flip Q/E every 2.0s at 120Hz (matches DevTestLab)
      const rollDir = Math.floor(safeTick / reverseEveryTicks) % 2 === 0 ? 1.0 : -1.0;
      return {
        throttle: 0.0,
        steer: 0.0,
        pitch: 0.0,
        yaw: 0.0,
        roll: rollDir,
        jump: false,
        boost: false,
        handbrake: false
      };
    }

    case DIAGNOSTIC_VEHICLE_PROFILES.SINE_STEER: {
      const periodTicks = options.periodTicks || 120; // 1.0s full sine wave at 120Hz
      const angle = (safeTick * 2 * Math.PI) / periodTicks;
      const steerVal = Number(Math.sin(angle).toFixed(4));
      const pitchVal = Number((0.45 * Math.cos(angle * 0.5)).toFixed(4));
      return {
        throttle: options.throttle ?? 0.6,
        steer: steerVal,
        pitch: pitchVal,
        yaw: steerVal,
        roll: 0.0,
        jump: false,
        boost: false,
        handbrake: false
      };
    }

    default:
      console.warn(`[DiagnosticsTestVehicles:Fallback] Unknown profile "${profile}", returning neutral controls.`);
      return {
        throttle: 0.0,
        steer: 0.0,
        pitch: 0.0,
        yaw: 0.0,
        roll: 0.0,
        jump: false,
        boost: false,
        handbrake: false
      };
  }
}

/**
 * Coordinates the deterministic in-arena diagnostic vehicles for network quality inspection.
 */
export class DiagnosticsTestVehicleController {
  constructor(fleet = DEFAULT_DIAGNOSTIC_FLEET, options = {}) {
    this.fleet = fleet;
    this.enabled = false;
    this.anchorMode = options.anchorMode || ZERO_G_ANCHOR_MODES.Z_HOVER;
  }

  /**
   * Locks all diagnostic vehicles into their in-arena 0G / Z-Hover anchors and disables collision masks.
   * @param {object} target - RocketSimPhysicsEngine, PhysicsEngineManager, or HostServerWorker
   * @param {string} [anchorMode=this.anchorMode]
   */
  configurePhysics(target, anchorMode = this.anchorMode) {
    this.anchorMode = anchorMode || ZERO_G_ANCHOR_MODES.Z_HOVER;
    return configureZeroGVehiclePhysics(target, this.fleet, this.anchorMode);
  }

  /**
   * Releases 0G linear factor locks and parks diagnostic vehicle slots on `target`.
   * @param {object} target
   */
  releasePhysics(target) {
    return releaseZeroGVehiclePhysics(target, this.fleet);
  }

  /**
   * Computes a map of `{ carIndex, profile, controls }` for the given tick.
   * @param {number} tick
   * @returns {Array<{carIndex: number, profile: string, controls: object}>}
   */
  stepTick(tick) {
    const outputs = [];
    for (let i = 0; i < this.fleet.length; i++) {
      const spec = this.fleet[i];
      const controls = computeDiagnosticVehicleControls(spec.profile, tick, {
        carIndex: spec.carIndex,
        baseAltitudeZ: spec.baseAltitudeZ ?? 500,
        peakAltitudeZ: spec.peakAltitudeZ ?? 600,
        anchorMode: this.anchorMode
      });
      outputs.push({
        carIndex: spec.carIndex,
        team: spec.team,
        profile: spec.profile,
        controls
      });
    }
    return outputs;
  }

  enforceConstraints(target) {
    if (!target) return;
    enforceZeroGFleetConstraints(target, this.fleet, this.anchorMode);
  }

  /**
   * Applies the diagnostic vehicle controls and 0G/boost constraints to a PhysicsEngineManager,
   * RocketSimPhysicsEngine, or HostServerWorker.
   * @param {object} target
   * @param {number} tick
   */
  applyToAuthority(target, tick) {
    if (!target) return [];
    enforceZeroGFleetConstraints(target, this.fleet, this.anchorMode);
    const batch = this.stepTick(tick);
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (typeof target.setDirectCarControls === 'function') {
        target.setDirectCarControls(item.carIndex, item.controls);
      } else if (typeof target.setCarControls === 'function') {
        target.setCarControls(item.carIndex, item.controls);
      } else if (typeof target.setControls === 'function') {
        target.setControls(item.carIndex, item.controls);
      }
    }
    return batch;
  }
}
