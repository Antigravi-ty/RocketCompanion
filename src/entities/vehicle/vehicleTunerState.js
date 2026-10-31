import * as THREE from 'three';

const customToonRampCache = new Map();

/**
 * Generates a customizable 1D cel-shading gradient DataTexture for Toon surfaces.
 */
export function buildCustomToonRampTexture(steps = 4, shadowMin = 0.11, highlightMax = 1.0, smooth = false) {
  const clampedSteps = Math.max(2, Math.min(8, Math.round(steps || 4)));
  const minVal = Math.max(0, Math.min(1, Number(shadowMin ?? 0.11)));
  const maxVal = Math.max(minVal, Math.min(1.5, Number(highlightMax ?? 1.0)));
  const isSmooth = Boolean(smooth);
  const key = `${clampedSteps}:${minVal.toFixed(3)}:${maxVal.toFixed(3)}:${isSmooth ? 1 : 0}`;
  if (customToonRampCache.has(key)) {
    return customToonRampCache.get(key);
  }

  const { DataTexture, RedFormat, NearestFilter, LinearFilter } = THREE;
  const data = new Uint8Array(clampedSteps);
  for (let i = 0; i < clampedSteps; i++) {
    const t = clampedSteps === 1 ? 1 : i / (clampedSteps - 1);
    const val = minVal + (maxVal - minVal) * t;
    data[i] = Math.max(0, Math.min(255, Math.round(val * 255)));
  }

  const format = RedFormat ?? 1028;
  const tex = new DataTexture(data, clampedSteps, 1, format);
  tex.name = `CustomToonRamp(${key})`;
  tex.minFilter = isSmooth ? LinearFilter : NearestFilter;
  tex.magFilter = isSmooth ? LinearFilter : NearestFilter;
  tex.needsUpdate = true;
  customToonRampCache.set(key, tex);
  return tex;
}
