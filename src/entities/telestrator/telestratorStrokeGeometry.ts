import * as THREE from 'three';
import {
  resolveTelestratorColorNumeric,
  TELESTRATOR_REF_VIEWPORT_HEIGHT,
  type TelestratorBrushTool,
  type TelestratorColorId,
  type TelestratorPoint,
  type TelestratorVec3,
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

function smoothStrokeCurve(points: readonly TelestratorPoint[]): TelestratorPoint[] {
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
  opacity: number,
  widthRefPx: number,
  points: readonly TelestratorPoint[]
): number {
  let hash = 0x811c9dc5;
  const mix = (val: number) => {
    hash ^= val | 0;
    hash = Math.imul(hash, 0x01000193);
  };
  for (let i = 0; i < tool.length; i++) mix(tool.charCodeAt(i));
  for (let i = 0; i < colorId.length; i++) mix(colorId.charCodeAt(i));
  mix(Math.round(opacity * 100));
  mix(Math.round(widthRefPx * 10));
  mix(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    mix(Math.round(p.x));
    mix(Math.round(p.y));
    mix(Math.round(p.z));
  }
  return hash >>> 0;
}

function appendQuad(
  positions: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3
): void {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  positions.push(b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
}

function buildContinuousRibbonPositions(
  curve: readonly TelestratorPoint[],
  widthRefPx: number,
  camPos: TelestratorVec3,
  camFovDeg: number,
  surfaceOffset: number
): number[] {
  const positions: number[] = [];
  const n = curve.length;
  if (n < 2) return positions;

  const leftPts: THREE.Vector3[] = [];
  const rightPts: THREE.Vector3[] = [];
  const tangent = new THREE.Vector3();
  const prevTan = new THREE.Vector3();
  const nextTan = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const side = new THREE.Vector3();
  const center = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const cur = curve[i];
    if (i === 0) {
      tangent.set(curve[1].x - cur.x, curve[1].y - cur.y, curve[1].z - cur.z);
    } else if (i === n - 1) {
      tangent.set(cur.x - curve[n - 2].x, cur.y - curve[n - 2].y, cur.z - curve[n - 2].z);
    } else {
      prevTan
        .set(cur.x - curve[i - 1].x, cur.y - curve[i - 1].y, cur.z - curve[i - 1].z)
        .normalize();
      nextTan
        .set(curve[i + 1].x - cur.x, curve[i + 1].y - cur.y, curve[i + 1].z - cur.z)
        .normalize();
      tangent.addVectors(prevTan, nextTan);
      if (tangent.lengthSq() < 1e-4) tangent.copy(nextTan);
    }
    if (tangent.lengthSq() < 1e-6) tangent.set(0, 0, 1);
    tangent.normalize();

    normal.set(cur.nx, cur.ny, cur.nz);
    if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
    normal.normalize();

    const dist = Math.hypot(cur.x - camPos.x, cur.y - camPos.y, cur.z - camPos.z);
    const halfWidth = computeNormalizedScreenWorldWidth(widthRefPx, dist, camFovDeg) * 0.5;

    side.crossVectors(tangent, normal);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().multiplyScalar(halfWidth);

    center.set(cur.x, cur.y, cur.z).addScaledVector(normal, surfaceOffset);
    leftPts.push(center.clone().sub(side));
    rightPts.push(center.clone().add(side));
  }

  for (let i = 0; i < n - 1; i++) {
    appendQuad(positions, leftPts[i], rightPts[i], leftPts[i + 1], rightPts[i + 1]);
  }
  return positions;
}

function buildDashedRibbonPositions(
  curve: readonly TelestratorPoint[],
  widthRefPx: number,
  camPos: TelestratorVec3,
  camFovDeg: number,
  surfaceOffset: number
): number[] {
  const positions: number[] = [];
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const segStart = new THREE.Vector3();
  const segEnd = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const side = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();

  let accumPhase = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const pt0 = curve[i];
    const pt1 = curve[i + 1];
    p0.set(pt0.x, pt0.y, pt0.z);
    p1.set(pt1.x, pt1.y, pt1.z);
    tangent.subVectors(p1, p0);
    const segLen = tangent.length();
    if (segLen < 0.5) continue;
    tangent.divideScalar(segLen);

    const midDist = Math.hypot(
      (pt0.x + pt1.x) * 0.5 - camPos.x,
      (pt0.y + pt1.y) * 0.5 - camPos.y,
      (pt0.z + pt1.z) * 0.5 - camPos.z
    );
    const halfWidth = computeNormalizedScreenWorldWidth(widthRefPx, midDist, camFovDeg) * 0.5;
    const dashLen = Math.max(halfWidth * 4.2, 24);
    const gapLen = Math.max(halfWidth * 2.8, 16);
    const dashPeriod = dashLen + gapLen;

    normal.set(pt0.nx + pt1.nx, pt0.ny + pt1.ny, pt0.nz + pt1.nz);
    if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
    normal.normalize();

    side.crossVectors(tangent, normal);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().multiplyScalar(halfWidth);

    let localOffset = 0;
    while (localOffset < segLen) {
      const phase = accumPhase % dashPeriod;
      if (phase < dashLen) {
        const remainDash = dashLen - phase;
        const step = Math.min(remainDash, segLen - localOffset);
        const t0 = localOffset / segLen;
        const t1 = (localOffset + step) / segLen;
        segStart.lerpVectors(p0, p1, t0).addScaledVector(normal, surfaceOffset);
        segEnd.lerpVectors(p0, p1, t1).addScaledVector(normal, surfaceOffset);
        a.copy(segStart).sub(side);
        b.copy(segStart).add(side);
        c.copy(segEnd).sub(side);
        d.copy(segEnd).add(side);
        appendQuad(positions, a, b, c, d);
        localOffset += step;
        accumPhase += step;
      } else {
        const remainGap = dashPeriod - phase;
        const step = Math.min(remainGap, segLen - localOffset);
        localOffset += step;
        accumPhase += step;
      }
    }
  }

  return positions;
}

function buildCameraFacingArrowheadMesh(
  curve: readonly TelestratorPoint[],
  camPos: TelestratorVec3,
  camForward: TelestratorVec3,
  camFovDeg: number,
  arrowLengthRefPx: number,
  arrowWidthRefPx: number,
  colorHex: number,
  opacity: number
): THREE.Mesh | null {
  if (curve.length < 2) return null;

  const tipPt = curve[curve.length - 1];
  let tailPt = curve[curve.length - 2];
  for (let i = curve.length - 2; i >= 0; i--) {
    const cand = curve[i];
    const d = Math.hypot(tipPt.x - cand.x, tipPt.y - cand.y, tipPt.z - cand.z);
    tailPt = cand;
    if (d >= 35) break;
  }

  const tipDist = Math.hypot(tipPt.x - camPos.x, tipPt.y - camPos.y, tipPt.z - camPos.z);
  const worldArrowLength = computeNormalizedScreenWorldWidth(arrowLengthRefPx, tipDist, camFovDeg);
  const worldArrowWidth = computeNormalizedScreenWorldWidth(arrowWidthRefPx, tipDist, camFovDeg);

  const viewNormal = new THREE.Vector3(-camForward.x, -camForward.y, -camForward.z);
  if (viewNormal.lengthSq() < 1e-4) viewNormal.set(0, 0, 1);
  viewNormal.normalize();

  const rawDir = new THREE.Vector3(tipPt.x - tailPt.x, tipPt.y - tailPt.y, tipPt.z - tailPt.z);
  const dot = rawDir.dot(viewNormal);
  const projDir = rawDir.addScaledVector(viewNormal, -dot);
  if (projDir.lengthSq() < 1e-4) {
    projDir.set(0, 1, 0);
    projDir.addScaledVector(viewNormal, -projDir.dot(viewNormal));
    if (projDir.lengthSq() < 1e-4) projDir.set(1, 0, 0);
  }
  projDir.normalize();

  const side = new THREE.Vector3().crossVectors(projDir, viewNormal);
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize().multiplyScalar(Math.max(4, worldArrowWidth * 0.5));

  const safeLen = Math.max(8, worldArrowLength);
  const baseCenter = new THREE.Vector3(tipPt.x, tipPt.y, tipPt.z).addScaledVector(viewNormal, 8);
  const tipVertex = baseCenter.clone().addScaledVector(projDir, safeLen * 0.45);
  const backCenter = baseCenter.clone().addScaledVector(projDir, -safeLen * 0.55);
  const leftCorner = backCenter.clone().sub(side);
  const rightCorner = backCenter.clone().add(side);

  const positions = [
    leftCorner.x,
    leftCorner.y,
    leftCorner.z,
    rightCorner.x,
    rightCorner.y,
    rightCorner.z,
    tipVertex.x,
    tipVertex.y,
    tipVertex.z,
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 105;
  return mesh;
}

export function buildStrokeRenderGroup(
  points: readonly TelestratorPoint[],
  tool: TelestratorBrushTool,
  colorId: TelestratorColorId,
  opacity: number,
  widthRefPx: number,
  arrowLengthRefPx: number,
  arrowWidthRefPx: number,
  camPos: TelestratorVec3,
  camForward: TelestratorVec3,
  camFovDeg: number
): THREE.Group {
  const group = new THREE.Group();
  if (points.length < 2) return group;

  const colorHex = resolveTelestratorColorNumeric(colorId);
  const curve = smoothStrokeCurve(points);
  const surfaceOffset = 3.5;

  const positions =
    tool === 'dashed'
      ? buildDashedRibbonPositions(curve, widthRefPx, camPos, camFovDeg, surfaceOffset)
      : buildContinuousRibbonPositions(curve, widthRefPx, camPos, camFovDeg, surfaceOffset);

  if (positions.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: opacity < 1,
      opacity,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });

    const ribbonMesh = new THREE.Mesh(geometry, material);
    ribbonMesh.renderOrder = 100;
    group.add(ribbonMesh);
  }

  if (tool === 'arrow') {
    const arrowMesh = buildCameraFacingArrowheadMesh(
      curve,
      camPos,
      camForward,
      camFovDeg,
      arrowLengthRefPx,
      arrowWidthRefPx,
      colorHex,
      opacity
    );
    if (arrowMesh) group.add(arrowMesh);
  }

  return group;
}
