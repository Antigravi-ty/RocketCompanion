/**
 * ballVisualConfig.js
 * Pure ball visual configuration defaults, runtime state, and listener subscription.
 */

export const DEFAULT_BALL_VISUAL_CONFIG = {
  visible: true,
  opacity: 1.0,
  temporaryOpacityOverride: null,
  depthWriteWhenTransparent: false,
  doubleSideWhenTransparent: false,
  wireframe: false,
  indicatorRingOpacity: 0.2,
};

export const ballVisualRuntimeConfig = {
  ...DEFAULT_BALL_VISUAL_CONFIG,
};

const ballVisualListeners = new Set();
const ballVisualObjectAppliers = new Set();

export function getBallVisualConfig() {
  return { ...ballVisualRuntimeConfig };
}

export function subscribeBallVisualConfig(listener) {
  if (typeof listener !== 'function') return () => {};
  ballVisualListeners.add(listener);
  return () => {
    ballVisualListeners.delete(listener);
  };
}

export function registerBallVisualApplier(applier) {
  if (typeof applier !== 'function') return () => {};
  ballVisualObjectAppliers.add(applier);
  return () => {
    ballVisualObjectAppliers.delete(applier);
  };
}

export function updateBallVisualConfig(patch = {}, ballRoot = null, indicatorRings = []) {
  if (patch) {
    Object.assign(ballVisualRuntimeConfig, patch);
  }
  for (const applier of ballVisualObjectAppliers) {
    try {
      applier(ballVisualRuntimeConfig, ballRoot, indicatorRings);
    } catch {
      // ignore applier errors
    }
  }
  const snapshot = { ...ballVisualRuntimeConfig };
  for (const listener of ballVisualListeners) {
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
  return snapshot;
}

export function setTemporaryBallOpacityOverride(opacityOrNull = null, ballRoot = null, indicatorRings = []) {
  const normalized =
    typeof opacityOrNull === 'number' && Number.isFinite(opacityOrNull)
      ? Math.max(0.05, Math.min(1.0, opacityOrNull))
      : null;
  if (ballVisualRuntimeConfig.temporaryOpacityOverride === normalized && !ballRoot) {
    return { ...ballVisualRuntimeConfig };
  }
  return updateBallVisualConfig({ temporaryOpacityOverride: normalized }, ballRoot, indicatorRings);
}
