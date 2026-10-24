import {
  STANDARD_GOAL_VOLUME_BOX,
  THROWBACK_GOAL_VOLUME_BOX,
} from '../physics/RocketSimConstants.js';

export const DEFAULT_GOAL_VOLUME_TUNER_CONFIG = Object.freeze({
  showHitboxVisual: false,
  standard: {
    enabled: false,
    halfWidthX: STANDARD_GOAL_VOLUME_BOX.halfWidthX,
    minY: STANDARD_GOAL_VOLUME_BOX.minY,
    maxY: STANDARD_GOAL_VOLUME_BOX.maxY,
    minZ: STANDARD_GOAL_VOLUME_BOX.minZ,
    maxZ: STANDARD_GOAL_VOLUME_BOX.maxZ,
  },
  throwback: {
    enabled: true,
    halfWidthX: THROWBACK_GOAL_VOLUME_BOX.halfWidthX,
    minY: THROWBACK_GOAL_VOLUME_BOX.minY,
    maxY: THROWBACK_GOAL_VOLUME_BOX.maxY,
    minZ: THROWBACK_GOAL_VOLUME_BOX.minZ,
    maxZ: THROWBACK_GOAL_VOLUME_BOX.maxZ,
  },
});

export const goalVolumeTunerRuntimeConfig = {
  showHitboxVisual: DEFAULT_GOAL_VOLUME_TUNER_CONFIG.showHitboxVisual,
  standard: { ...DEFAULT_GOAL_VOLUME_TUNER_CONFIG.standard },
  throwback: { ...DEFAULT_GOAL_VOLUME_TUNER_CONFIG.throwback },
};

const goalVolumeListeners = new Set();
const goalVolumeAppliers = new Set();

export function getGoalVolumeTunerConfig() {
  return {
    showHitboxVisual: Boolean(goalVolumeTunerRuntimeConfig.showHitboxVisual),
    standard: { ...goalVolumeTunerRuntimeConfig.standard },
    throwback: { ...goalVolumeTunerRuntimeConfig.throwback },
  };
}

export function getGoalVolumeBoxForPreset(isThrowback = false) {
  const src = isThrowback
    ? goalVolumeTunerRuntimeConfig.throwback
    : goalVolumeTunerRuntimeConfig.standard;
  return {
    enabled: isThrowback ? true : Boolean(src.enabled),
    halfWidthX: Number(src.halfWidthX) || (isThrowback ? THROWBACK_GOAL_VOLUME_BOX.halfWidthX : STANDARD_GOAL_VOLUME_BOX.halfWidthX),
    minY: Number(src.minY) || (isThrowback ? THROWBACK_GOAL_VOLUME_BOX.minY : STANDARD_GOAL_VOLUME_BOX.minY),
    maxY: Number(src.maxY) || (isThrowback ? THROWBACK_GOAL_VOLUME_BOX.maxY : STANDARD_GOAL_VOLUME_BOX.maxY),
    minZ: Number.isFinite(Number(src.minZ)) ? Number(src.minZ) : 0.0,
    maxZ: Number(src.maxZ) || (isThrowback ? THROWBACK_GOAL_VOLUME_BOX.maxZ : STANDARD_GOAL_VOLUME_BOX.maxZ),
  };
}

export function subscribeGoalVolumeTunerConfig(listener) {
  if (typeof listener !== 'function') return () => {};
  goalVolumeListeners.add(listener);
  return () => {
    goalVolumeListeners.delete(listener);
  };
}

export function registerGoalVolumeTunerApplier(applier) {
  if (typeof applier !== 'function') return () => {};
  goalVolumeAppliers.add(applier);
  return () => {
    goalVolumeAppliers.delete(applier);
  };
}

function notifyAll() {
  const snapshot = getGoalVolumeTunerConfig();
  for (const applier of goalVolumeAppliers) {
    try {
      applier(snapshot);
    } catch {
      // ignore applier errors
    }
  }
  for (const listener of goalVolumeListeners) {
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
  return snapshot;
}

export function updateGoalVolumeTunerConfig(patch = {}) {
  if (!patch || typeof patch !== 'object') return getGoalVolumeTunerConfig();
  if (typeof patch.showHitboxVisual === 'boolean') {
    goalVolumeTunerRuntimeConfig.showHitboxVisual = patch.showHitboxVisual;
  }
  if (patch.standard && typeof patch.standard === 'object') {
    Object.assign(goalVolumeTunerRuntimeConfig.standard, patch.standard);
  }
  if (patch.throwback && typeof patch.throwback === 'object') {
    Object.assign(goalVolumeTunerRuntimeConfig.throwback, patch.throwback);
  }
  return notifyAll();
}

export function resetGoalVolumeTunerConfig() {
  goalVolumeTunerRuntimeConfig.showHitboxVisual = DEFAULT_GOAL_VOLUME_TUNER_CONFIG.showHitboxVisual;
  goalVolumeTunerRuntimeConfig.standard = { ...DEFAULT_GOAL_VOLUME_TUNER_CONFIG.standard };
  goalVolumeTunerRuntimeConfig.throwback = { ...DEFAULT_GOAL_VOLUME_TUNER_CONFIG.throwback };
  return notifyAll();
}
