import * as THREE from 'three';
import {
  resolveTelestratorColorNumeric,
  type TelestratorBrushTool,
  type TelestratorColorId,
  type TelestratorPoint,
} from './telestratorTypes.ts';

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
  minSpacing = 28,
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

export function computeStrokeHash(
  tool: TelestratorBrushTool,
  colorId: TelestratorColorId,
  opacity: number,
  widthPx: number,
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
  mix(Math.round(widthPx));
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

function buildRibbonMesh(
  points: readonly TelestratorPoint[],
  tool: TelestratorBrushTool,
  worldWidth: number,
  colorHex: number,
  opacity: number
): THREE.Mesh | null {
  if (points.length < 2) return null;

  const positions: number[] = [];
  const halfWidth = Math.max(4, worldWidth * 0.5);
  const surfaceOffset = 3.5;

  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const side = new THREE.Vector3();
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();

  let accumDist = 0;
  const dashPeriod = Math.max(worldWidth * 3.2, 70);
  const dashFill = dashPeriod * 0.58;

  const endIndex = points.length - 1;
  for (let i = 0; i < endIndex; i++) {
    const pt0 = points[i];
    const pt1 = points[i + 1];
    p0.set(pt0.x, pt0.y, pt0.z);
    p1.set(pt1.x, pt1.y, pt1.z);
    tangent.subVectors(p1, p0);
    const segLen = tangent.length();
    if (segLen < 0.5) continue;
    tangent.divideScalar(segLen);

    if (tool === 'dashed') {
      const midDist = accumDist + segLen * 0.5;
      accumDist += segLen;
      if (midDist % dashPeriod > dashFill) continue;
    } else {
      accumDist += segLen;
    }

    normal.set(pt0.nx + pt1.nx, pt0.ny + pt1.ny, pt0.nz + pt1.nz);
    if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
    normal.normalize();

    side.crossVectors(tangent, normal);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().multiplyScalar(halfWidth);

    p0.addScaledVector(normal, surfaceOffset);
    p1.addScaledVector(normal, surfaceOffset);

    a.copy(p0).sub(side);
    b.copy(p0).add(side);
    c.copy(p1).sub(side);
    d.copy(p1).add(side);
    appendQuad(positions, a, b, c, d);
  }

  if (tool === 'arrow' && points.length >= 2) {
    const tail = points[points.length - 2];
    const tip = points[points.length - 1];
    p0.set(tail.x, tail.y, tail.z);
    p1.set(tip.x, tip.y, tip.z);
    tangent.subVectors(p1, p0);
    if (tangent.lengthSq() > 0.25) {
      tangent.normalize();
      normal.set(tip.nx, tip.ny, tip.nz);
      if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
      normal.normalize();

      const headLen = Math.max(worldWidth * 2.8, 70);
      const headHalfW = Math.max(worldWidth * 1.45, 36);
      side.crossVectors(tangent, normal).normalize().multiplyScalar(headHalfW);

      const baseCenter = p1.clone().addScaledVector(normal, surfaceOffset + 0.5);
      const tipPoint = baseCenter.clone().addScaledVector(tangent, headLen * 0.45);
      const backCenter = baseCenter.clone().addScaledVector(tangent, -headLen * 0.55);
      const leftCorner = backCenter.clone().sub(side);
      const rightCorner = backCenter.clone().add(side);

      positions.push(
        leftCorner.x,
        leftCorner.y,
        leftCorner.z,
        rightCorner.x,
        rightCorner.y,
        rightCorner.z,
        tipPoint.x,
        tipPoint.y,
        tipPoint.z
      );
    }
  }

  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: opacity >= 1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10;
  return mesh;
}

function buildDropStemsGroup(
  points: readonly TelestratorPoint[],
  colorHex: number,
  opacity: number
): THREE.Group | null {
  const aerialPoints: TelestratorPoint[] = [];
  for (let i = 0; i < points.length; i += 2) {
    if (points[i].y > 24) aerialPoints.push(points[i]);
  }
  const last = points[points.length - 1];
  if (last && last.y > 24 && aerialPoints[aerialPoints.length - 1] !== last) {
    aerialPoints.push(last);
  }
  if (aerialPoints.length === 0) return null;

  const group = new THREE.Group();
  const linePositions: number[] = [];
  for (let i = 0; i < aerialPoints.length; i++) {
    const p = aerialPoints[i];
    linePositions.push(p.x, p.y, p.z, p.x, 1.5, p.z);
  }

  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  const lineMat = new THREE.LineDashedMaterial({
    color: colorHex,
    transparent: true,
    opacity: opacity * 0.55,
    dashSize: 24,
    gapSize: 18,
  });
  const lines = new THREE.LineSegments(lineGeom, lineMat);
  lines.computeLineDistances();
  lines.renderOrder = 8;
  group.add(lines);

  const ringGeom = new THREE.RingGeometry(14, 22, 20);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: opacity * 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const step = Math.max(1, Math.floor(aerialPoints.length / 6));
  for (let i = 0; i < aerialPoints.length; i += step) {
    const p = aerialPoints[i];
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.position.set(p.x, 2, p.z);
    ring.renderOrder = 8;
    group.add(ring);
  }

  return group;
}

export function buildStrokeRenderGroup(
  points: readonly TelestratorPoint[],
  tool: TelestratorBrushTool,
  colorId: TelestratorColorId,
  opacity: number,
  worldWidth: number,
  dropStemsEnabled: boolean
): THREE.Group {
  const group = new THREE.Group();
  const colorHex = resolveTelestratorColorNumeric(colorId);
  const ribbon = buildRibbonMesh(points, tool, worldWidth, colorHex, opacity);
  if (ribbon) group.add(ribbon);

  if (dropStemsEnabled) {
    const stems = buildDropStemsGroup(points, colorHex, opacity);
    if (stems) group.add(stems);
  }

  return group;
}
