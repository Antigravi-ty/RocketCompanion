export const UU_TO_METERS = 0.01;

export const SPATIAL_CONFIG = {
  distanceUnitScale: 0.01,
  minDistance: 400,
  maxDistance: 13000,
  minGainFloor: 0.15,
  panningModel: 'equalpower', // 'equalpower' | 'HRTF'
  distanceModel: 'smoothstep', // 'smoothstep' | 'inverse' | 'linear' | 'exponential'
  rolloffFactor: 1.0,
  rampTime: 0.025
};

export function getUuToMeters() {
  return SPATIAL_CONFIG.distanceUnitScale;
}

export function applySpatialConfigPatch(patch, onPanningModelChange = null) {
  if (!patch || typeof patch !== 'object') return;
  if (Number.isFinite(patch.distanceUnitScale) && patch.distanceUnitScale > 0) {
    SPATIAL_CONFIG.distanceUnitScale = patch.distanceUnitScale;
  }
  if (Number.isFinite(patch.rolloffMinDistance) && patch.rolloffMinDistance >= 0) {
    SPATIAL_CONFIG.minDistance = patch.rolloffMinDistance;
  }
  if (Number.isFinite(patch.rolloffMaxDistance) && patch.rolloffMaxDistance > SPATIAL_CONFIG.minDistance) {
    SPATIAL_CONFIG.maxDistance = patch.rolloffMaxDistance;
  }
  if (Number.isFinite(patch.minAudibleGainFloor) && patch.minAudibleGainFloor >= 0) {
    SPATIAL_CONFIG.minGainFloor = Math.max(0, Math.min(1.0, patch.minAudibleGainFloor));
  }
  if (patch.spatialPanningModel === 'equalpower' || patch.spatialPanningModel === 'HRTF') {
    SPATIAL_CONFIG.panningModel = patch.spatialPanningModel;
    if (typeof onPanningModelChange === 'function') {
      onPanningModelChange(SPATIAL_CONFIG.panningModel);
    }
  }
  if (typeof patch.distanceModel === 'string') {
    SPATIAL_CONFIG.distanceModel = patch.distanceModel;
  }
}

export const SPATIAL_AUDIO_CONFIG = {
  get MIN_DISTANCE() { return SPATIAL_CONFIG.minDistance; },
  get MAX_DISTANCE() { return SPATIAL_CONFIG.maxDistance; },
  get MAX_GAIN() { return 1.0; },
  get RAMP_TIME() { return SPATIAL_CONFIG.rampTime; }
};

export const INCIDENT_SPATIAL_CONFIG = {
  get MIN_DISTANCE() { return SPATIAL_CONFIG.minDistance; },
  get MAX_DISTANCE() { return SPATIAL_CONFIG.maxDistance; },
  get MIN_GAIN() { return SPATIAL_CONFIG.minGainFloor; }
};

/**
 * Calculates distance gain attenuation for discrete physics incidents across RocketSim arena.
 * Supports configurable models: smoothstep (Cubic Hermite), inverse (physics), linear, exponential.
 * @param {number} distance - Distance in Unreal Units
 * @returns {number} Attenuated gain factor [minGainFloor, 1.0]
 */
export function calculateIncidentDistanceGain(distance) {
  if (!Number.isFinite(distance)) return 1.0;
  const { minDistance, maxDistance, minGainFloor, distanceModel } = SPATIAL_CONFIG;
  if (distance <= minDistance) return 1.0;
  if (distance >= maxDistance) return minGainFloor;

  const t = Math.max(0, Math.min(1, (distance - minDistance) / (maxDistance - minDistance)));

  if (distanceModel === 'linear') {
    return Math.max(minGainFloor, 1.0 - t * (1.0 - minGainFloor));
  } else if (distanceModel === 'inverse') {
    const ref = minDistance;
    const gain = ref / (ref + (distance - ref));
    return Math.max(minGainFloor, gain);
  } else if (distanceModel === 'exponential') {
    const gain = Math.pow(Math.max(0.001, minGainFloor), t);
    return Math.max(minGainFloor, gain);
  } else {
    // Default smoothstep (Cubic Hermite)
    const smooth = 1.0 - t * t * (3.0 - 2.0 * t);
    return minGainFloor + (1.0 - minGainFloor) * smooth;
  }
}

/**
 * Coordinate mapping: RocketSim Unreal Units (X: width, Y: length, Z: up)
 * -> Three.js & Web Audio API (X: width, Y: up, Z: length)
 */
export function toAudioCoordinates(out, pos) {
  if (!pos) return null;
  if (pos.isVector3 || pos.isAudioCoords) {
    out.x = pos.x ?? 0;
    out.y = pos.y ?? 0;
    out.z = pos.z ?? 0;
    return out;
  }
  if (Number.isFinite(pos.posX) && Number.isFinite(pos.posY) && Number.isFinite(pos.posZ)) {
    out.x = pos.posX;
    out.y = pos.posZ;
    out.z = pos.posY;
    return out;
  }
  if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
    out.x = pos.x;
    out.y = pos.z;
    out.z = pos.y;
    return out;
  }
  return null;
}

export function calculateDistanceGain(distance) {
  if (!Number.isFinite(distance)) return 0;
  return calculateIncidentDistanceGain(distance);
}
