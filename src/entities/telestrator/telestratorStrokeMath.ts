import * as THREE from 'three';
import {
  TELESTRATOR_REF_VIEWPORT_HEIGHT,
  type TelestratorBrushTool,
  type TelestratorColorId,
  type TelestratorPoint,
  type TelestratorPresetIndex,
} from './telestratorTypes.ts';

export function computeNormalizedScreenWorldWidth(
  widthRefPx: number,
  distanceToCamera: number,
  fovDeg = 60
): number {
  const safeDist = Math.max(80, distanceToCamera);
  const safeFov = Math.max(20, Math.min(140, fovDeg));
  const vFovRad = THREE.MathUtils.degToRad(safeFov);
  const worldHeightAtDist = 2 * Math.tan(vFovRad * 0.5) * safeDist;
  const worldPerRefPx = worldHeightAtDist / TELESTRATOR_REF_VIEWPORT_HEIGHT;
  return Math.max(2, Math.min(400, widthRefPx * worldPerRefPx));
}

function pointSegmentDistSq(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const vz = bz - az;
  const wx = px - ax;
  const wy = py - ay;
  const wz = pz - az;
  const lenSq = vx * vx + vy * vy + vz * vz;
  if (lenSq <= 1e-6) return wx * wx + wy * wy + wz * wz;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy + wz * vz) / lenSq));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  const dz = pz - (az + t * vz);
  return dx * dx + dy * dy + dz * dz;
}

function rdpSimplify(
  points: readonly TelestratorPoint[],
  start: number,
  end: number,
  epsSq: number,
  keep: Uint8Array
): void {
  if (end <= start + 1) return;
  const a = points[start];
  const b = points[end];
  let maxDistSq = -1;
  let maxIdx = -1;
  for (let i = start + 1; i < end; i++) {
    const p = points[i];
    const dSq = pointSegmentDistSq(p.x, p.y, p.z, a.x, a.y, a.z, b.x, b.y, b.z);
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      maxIdx = i;
    }
  }
  if (maxDistSq > epsSq && maxIdx !== -1) {
    keep[maxIdx] = 1;
    rdpSimplify(points, start, maxIdx, epsSq, keep);
    rdpSimplify(points, maxIdx, end, epsSq, keep);
  }
}

export function simplifyAndResampleStroke(
  rawPoints: readonly TelestratorPoint[],
  minSpacing = 24,
  rdpEpsilon = 6
): TelestratorPoint[] {
  if (rawPoints.length <= 2) return rawPoints.map((p) => ({ ...p }));

  const resampled: TelestratorPoint[] = [{ ...rawPoints[0] }];
  const minSpacingSq = minSpacing * minSpacing;
  for (let i = 1; i < rawPoints.length - 1; i++) {
    const prev = resampled[resampled.length - 1];
    const cur = rawPoints[i];
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const dz = cur.z - prev.z;
    if (dx * dx + dy * dy + dz * dz >= minSpacingSq) {
      resampled.push({ ...cur });
    }
  }
  resampled.push({ ...rawPoints[rawPoints.length - 1] });

  if (resampled.length <= 3) return resampled;

  const keep = new Uint8Array(resampled.length);
  keep[0] = 1;
  keep[resampled.length - 1] = 1;
  rdpSimplify(resampled, 0, resampled.length - 1, rdpEpsilon * rdpEpsilon, keep);

  const out: TelestratorPoint[] = [];
  for (let i = 0; i < resampled.length; i++) {
    if (keep[i]) out.push(resampled[i]);
  }
  return out;
}

function catmullRomValue(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export function smoothStrokeCurve(points: readonly TelestratorPoint[]): TelestratorPoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));

  const smoothed: TelestratorPoint[] = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const steps = Math.max(1, Math.min(10, Math.ceil(segDist / 20)));

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const nx = p1.nx + (p2.nx - p1.nx) * t;
      const ny = p1.ny + (p2.ny - p1.ny) * t;
      const nz = p1.nz + (p2.nz - p1.nz) * t;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      smoothed.push({
        x: catmullRomValue(p0.x, p1.x, p2.x, p3.x, t),
        y: catmullRomValue(p0.y, p1.y, p2.y, p3.y, t),
        z: catmullRomValue(p0.z, p1.z, p2.z, p3.z, t),
        nx: nx / nLen,
        ny: ny / nLen,
        nz: nz / nLen,
      });
    }
  }
  smoothed.push({ ...points[n - 1] });
  return smoothed;
}

export function computeStrokeHash(
  tool: TelestratorBrushTool,
  colorId: TelestratorColorId,
  presetIndex: TelestratorPresetIndex,
  opacity: number,
  widthRefPx: number,
  arrowLengthRefPx: number,
  arrowWidthRefPx: number,
  points: readonly TelestratorPoint[]
): number {
  let hash = 0x811c9dc5;
  const mix = (val: number) => {
    hash ^= val | 0;
    hash = Math.imul(hash, 0x01000193);
  };
  for (let i = 0; i < tool.length; i++) mix(tool.charCodeAt(i));
  for (let i = 0; i < colorId.length; i++) mix(colorId.charCodeAt(i));
  mix(presetIndex);
  mix(Math.round(Math.max(0, Math.min(1, opacity)) * 255));
  mix(Math.round(widthRefPx * 10));
  mix(Math.round(arrowLengthRefPx * 10));
  mix(Math.round(arrowWidthRefPx * 10));
  mix(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    mix(Math.round(p.x));
    mix(Math.round(p.y));
    mix(Math.round(p.z));
  }
  return hash >>> 0;
}
