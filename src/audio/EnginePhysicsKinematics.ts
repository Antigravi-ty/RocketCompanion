import type {
  EngineAudioTuningConfig,
  EngineDriveDirection,
} from '../ui-core/config/engineAudioConfig.ts';

export interface PowertrainKineticState {
  absForwardSpeedUU: number;
  rawForwardAccelUU: number;
  forwardAccelUU: number;
  smoothForwardAccelUU: number;
  isSupersonicTurning: boolean;
  isShiftLocked: boolean;
  isUnderStrain: boolean;
  isBrakingAgainstMotion: boolean;
  isDrifting: boolean;
  isTurningHard: boolean;
  isDeceleratingOnWallOrBevel: boolean;
  isSevereSpeedCollapse: boolean;
}

/**
 * Computes the velocity-coupled RPM baseline for Gear 1 (0 .. maxThrottleSpeedUU)
 * and Gear 2 (maxThrottleSpeedUU .. supersonicSpeedUU), or high-gear deceleration ceiling.
 */
export function computeVelocityCoupledGearRPM(
  cfg: EngineAudioTuningConfig,
  absForwardSpeedUU: number,
  gear: number,
  driveDirection: EngineDriveDirection
): number {
  const v1 = Math.max(200, cfg.maxThrottleSpeedUU);
  const v2 = Math.max(v1 + 100, cfg.supersonicSpeedUU);
  const idle = cfg.idleRPM;
  const land = cfg.upshiftLandingRPM;
  const cutoff = cfg.revLimitCutoffRPM;

  if (gear <= 1) {
    const norm = Math.max(0, Math.min(1.02, absForwardSpeedUU / v1));
    const exponent = driveDirection === 'reverse' ? 0.95 : 0.85;
    return idle + Math.pow(norm, exponent) * (cutoff - idle);
  }

  if (gear === 2) {
    if (driveDirection === 'reverse') {
      const r2Start = v1 * 0.65;
      const norm = Math.max(0, Math.min(1.02, (absForwardSpeedUU - r2Start) / Math.max(100, v1 - r2Start)));
      return land + norm * (cutoff - land);
    }
    if (absForwardSpeedUU >= v1) {
      const norm = Math.max(0, Math.min(1.02, (absForwardSpeedUU - v1) / Math.max(100, v2 - v1)));
      return land + norm * (cutoff - land);
    }
    const downshiftFloorUU = v1 * 0.68;
    const alpha = Math.max(0, Math.min(1, (absForwardSpeedUU - downshiftFloorUU) / Math.max(100, v1 - downshiftFloorUU)));
    return cfg.downshiftTriggerRPM + alpha * (land - cfg.downshiftTriggerRPM);
  }

  const highGearFloorUU = driveDirection === 'reverse' ? v1 * 0.68 : v2 * 0.72;
  const highGearCeilUU = driveDirection === 'reverse' ? v1 : 2300;
  const norm = Math.max(0, Math.min(1, (absForwardSpeedUU - highGearFloorUU) / Math.max(100, highGearCeilUU - highGearFloorUU)));
  return cfg.downshiftTriggerRPM + norm * (cutoff - cfg.downshiftTriggerRPM);
}

/**
 * Evaluates vehicle kinetic telemetry (acceleration, steering, handbrake, supersonic turning, wall-bevel decel)
 * to determine supersonic turn rev-bounce, wall/bevel strain dips, and severe speed collapse.
 */
export function evaluatePowertrainKinetics(
  cfg: EngineAudioTuningConfig,
  forwardSpeedUU: number,
  prevForwardSpeedUU: number,
  prevSmoothAccelUU: number,
  throttleInput: number,
  steerInput: number,
  handbrakeInput: boolean,
  isBoosting: boolean,
  isOnGround: boolean,
  surfaceUpZ: number,
  dt: number
): PowertrainKineticState {
  const absForwardSpeedUU = Math.abs(forwardSpeedUU);
  const rawForwardAccelUU = dt > 1e-4 ? (forwardSpeedUU - prevForwardSpeedUU) / dt : 0;
  const clampedRawAccel = Math.max(-6000, Math.min(6000, rawForwardAccelUU));
  const accelAlpha = 1 - Math.exp(-16 * dt);
  const smoothForwardAccelUU = prevSmoothAccelUU + (clampedRawAccel - prevSmoothAccelUU) * accelAlpha;

  const isBrakingAgainstMotion =
    (forwardSpeedUU > cfg.zeroSpeedThresholdUU && throttleInput < -0.05) ||
    (forwardSpeedUU < -cfg.zeroSpeedThresholdUU && throttleInput > 0.05);

  const absSteer = Math.abs(steerInput);
  const isDrifting = isOnGround && Boolean(handbrakeInput) && absForwardSpeedUU > 120;
  const isTurningHard = isOnGround && absSteer >= cfg.shiftLockSteerThreshold && absForwardSpeedUU > 180;

  // Turning while continuously accelerating or boosting on the ground:
  // Locks automatic upshifting (holds current gear) rather than artificially snapping RPM to redline.
  const isTurningUnderPower =
    Boolean(cfg.supersonicTurnRevBounceEnabled) &&
    isOnGround &&
    !isBrakingAgainstMotion &&
    (Math.abs(throttleInput) > 0.05 || isBoosting) &&
    absSteer >= cfg.shiftLockSteerThreshold &&
    absForwardSpeedUU > 180;

  const isSupersonicTurning =
    isTurningUnderPower && isBoosting && absForwardSpeedUU >= cfg.supersonicSpeedUU * 0.96;

  // Shift-lock holds the current gear during handbrake drift or while turning under continuous throttle/boost
  const isShiftLocked = isDrifting || isTurningUnderPower;

  const signedAccelInDriveDir = forwardSpeedUU >= 0 ? smoothForwardAccelUU : -smoothForwardAccelUU;
  const signedRawAccelInDriveDir = forwardSpeedUU >= 0 ? clampedRawAccel : -clampedRawAccel;

  const isDeceleratingOnWallOrBevel =
    isOnGround &&
    Math.abs(throttleInput) > 0.05 &&
    !isBrakingAgainstMotion &&
    signedAccelInDriveDir < cfg.wallDecelDipThresholdUU &&
    signedRawAccelInDriveDir < cfg.wallDecelDipThresholdUU * 0.5 &&
    (surfaceUpZ < 0.95 || absSteer < cfg.shiftLockSteerThreshold);

  const isSevereSpeedCollapse =
    isOnGround &&
    !isBrakingAgainstMotion &&
    signedAccelInDriveDir < -120 &&
    (absForwardSpeedUU < 420 || signedAccelInDriveDir < -850);

  const isUnderStrain =
    isOnGround &&
    Math.abs(throttleInput) > 0.05 &&
    !isBrakingAgainstMotion &&
    (isDrifting || isDeceleratingOnWallOrBevel || surfaceUpZ < 0.75);

  return {
    absForwardSpeedUU,
    rawForwardAccelUU: clampedRawAccel,
    forwardAccelUU: smoothForwardAccelUU,
    smoothForwardAccelUU,
    isSupersonicTurning,
    isShiftLocked,
    isUnderStrain,
    isBrakingAgainstMotion,
    isDrifting,
    isTurningHard,
    isDeceleratingOnWallOrBevel,
    isSevereSpeedCollapse,
  };
}

/**
 * Resolves touchdown gear and initial/target RPM upon landing from airborne state.
 */
export function resolveTouchdownState(
  cfg: EngineAudioTuningConfig,
  absForwardSpeedUU: number,
  currentGear: number,
  currentRPM: number,
  driveDirection: EngineDriveDirection
): { gear: number; currentRPM: number; targetRPM: number; recoveryTimer: number } {
  const v1 = Math.max(200, cfg.maxThrottleSpeedUU);
  const v2 = Math.max(v1 + 100, cfg.supersonicSpeedUU);
  let gear = currentGear;

  if (driveDirection === 'reverse') {
    gear = absForwardSpeedUU >= v1 * 0.96 ? Math.max(2, currentGear) : 1;
  } else if (absForwardSpeedUU < v1 * 0.96) {
    gear = 1;
  } else if (absForwardSpeedUU < v2 * 0.96) {
    gear = 2;
  } else {
    gear = Math.max(3, currentGear);
  }

  const matchedRPM = computeVelocityCoupledGearRPM(cfg, absForwardSpeedUU, gear, driveDirection);
  if (cfg.landingRevRecoveryMode === 'fast-ramp-from-idle') {
    return { gear, currentRPM: cfg.idleRPM, targetRPM: matchedRPM, recoveryTimer: 0.22 };
  }
  return {
    gear,
    currentRPM: currentRPM * 0.35 + matchedRPM * 0.65,
    targetRPM: matchedRPM,
    recoveryTimer: 0.08,
  };
}

/**
 * Computes off-throttle / braking target RPM coupled to vehicle speed so that
 * any virtual overdrive inflation collapses smoothly to speed-relative RPM and reaches idle at 0 speed.
 */
export function computeDecelerationTargetRPM(
  cfg: EngineAudioTuningConfig,
  kinetics: PowertrainKineticState,
  currentGear: number,
  prevTargetRPM: number,
  driveDirection: EngineDriveDirection,
  dt: number
): number {
  if (!cfg.velocityCoupledGearsEnabled) {
    const dropMult = kinetics.isBrakingAgainstMotion ? 2.6 : 1.0;
    return Math.max(cfg.idleRPM, prevTargetRPM - cfg.rpmDropRate * dropMult * dt);
  }

  let speedCoupledRPM = computeVelocityCoupledGearRPM(
    cfg,
    kinetics.absForwardSpeedUU,
    currentGear,
    driveDirection
  );
  if (currentGear <= 1) {
    const v1 = Math.max(200, cfg.maxThrottleSpeedUU);
    const linearNorm = Math.max(0, Math.min(1, kinetics.absForwardSpeedUU / v1));
    const decelCurve = kinetics.isBrakingAgainstMotion ? Math.pow(linearNorm, 1.15) : linearNorm;
    speedCoupledRPM = cfg.idleRPM + decelCurve * (cfg.revLimitCutoffRPM - cfg.idleRPM);
  }
  const decelDropFloor =
    prevTargetRPM - cfg.rpmDropRate * (kinetics.isBrakingAgainstMotion ? 3.5 : 1.25) * dt;
  return Math.max(cfg.idleRPM, Math.min(speedCoupledRPM, decelDropFloor));
}
