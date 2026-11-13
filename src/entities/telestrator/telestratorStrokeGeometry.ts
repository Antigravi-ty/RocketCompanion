import * as THREE from 'three';
import {
  computeNormalizedScreenWorldWidth,
  smoothStrokeCurve,
} from './telestratorStrokeMath.ts';
import {
  resolveTelestratorColorNumeric,
  type TelestratorBrushTool,
  type TelestratorColorId,
  type TelestratorPoint,
  type TelestratorVec3,
} from './telestratorTypes.ts';

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

function appendRoundCap(
  positions: number[],
  center: THREE.Vector3,
  tangent: THREE.Vector3,
  sideUnit: THREE.Vector3,
  radius: number,
  isStart: boolean,
  segments = 6
): void {
  if (radius <= 0.05) return;
  const dirSign = isStart ? -1 : 1;
  let prevX = center.x + sideUnit.x * radius;
  let prevY = center.y + sideUnit.y * radius;
  let prevZ = center.z + sideUnit.z * radius;

  for (let s = 1; s <= segments; s++) {
    const angle = (s / segments) * Math.PI;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle) * dirSign;
    const nextX = center.x + (sideUnit.x * cosA + tangent.x * sinA) * radius;
    const nextY = center.y + (sideUnit.y * cosA + tangent.y * sinA) * radius;
    const nextZ = center.z + (sideUnit.z * cosA + tangent.z * sinA) * radius;
    if (isStart) {
      positions.push(center.x, center.y, center.z, nextX, nextY, nextZ, prevX, prevY, prevZ);
    } else {
      positions.push(center.x, center.y, center.z, prevX, prevY, prevZ, nextX, nextY, nextZ);
    }
    prevX = nextX;
    prevY = nextY;
    prevZ = nextZ;
  }
}

function appendRoundJoin(
  positions: number[],
  center: THREE.Vector3,
  normal: THREE.Vector3,
  prevSide: THREE.Vector3,
  nextSide: THREE.Vector3,
  prevTan: THREE.Vector3,
  nextTan: THREE.Vector3,
  radius: number,
  segments = 4
): void {
  const dotTan = prevTan.dot(nextTan);
  if (dotTan > 0.965 || radius <= 0.05) return;
  const cross = new THREE.Vector3().crossVectors(prevTan, nextTan);
  const turnSign = cross.dot(normal) >= 0 ? -1 : 1;
  const startVec = prevSide.clone().multiplyScalar(turnSign).normalize();
  const endVec = nextSide.clone().multiplyScalar(turnSign).normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, startVec.dot(endVec))));
  if (angle < 0.08) return;

  const axis = new THREE.Vector3().crossVectors(startVec, endVec);
  if (axis.lengthSq() < 1e-6) return;
  axis.normalize();

  let prevPt = center.clone().addScaledVector(startVec, radius);
  const rotVec = new THREE.Vector3();
  for (let s = 1; s <= segments; s++) {
    rotVec.copy(startVec).applyAxisAngle(axis, (angle * s) / segments);
    const nextPt = center.clone().addScaledVector(rotVec, radius);
    positions.push(
      center.x,
      center.y,
      center.z,
      prevPt.x,
      prevPt.y,
      prevPt.z,
      nextPt.x,
      nextPt.y,
      nextPt.z
    );
    prevPt = nextPt;
  }
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
  const centers: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const sideUnits: THREE.Vector3[] = [];
  const radii: number[] = [];
  const segTans: THREE.Vector3[] = [];

  for (let i = 0; i < n - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    const t = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    if (t.lengthSq() < 1e-6) t.set(0, 0, 1);
    else t.normalize();
    segTans.push(t);
  }

  const tangent = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const cur = curve[i];
    if (i === 0) {
      tangent.copy(segTans[0]);
    } else if (i === n - 1) {
      tangent.copy(segTans[n - 2]);
    } else {
      tangent.addVectors(segTans[i - 1], segTans[i]);
      if (tangent.lengthSq() < 1e-4) tangent.copy(segTans[i]);
      tangent.normalize();
    }

    const normal = new THREE.Vector3(cur.nx, cur.ny, cur.nz);
    if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
    normal.normalize();

    const dist = Math.hypot(cur.x - camPos.x, cur.y - camPos.y, cur.z - camPos.z);
    const halfWidth = computeNormalizedScreenWorldWidth(widthRefPx, dist, camFovDeg) * 0.5;

    const sideUnit = new THREE.Vector3().crossVectors(tangent, normal);
    if (sideUnit.lengthSq() < 1e-4) sideUnit.set(1, 0, 0);
    sideUnit.normalize();

    const center = new THREE.Vector3(cur.x, cur.y, cur.z).addScaledVector(normal, surfaceOffset);
    centers.push(center);
    normals.push(normal);
    sideUnits.push(sideUnit);
    radii.push(halfWidth);
    leftPts.push(center.clone().addScaledVector(sideUnit, -halfWidth));
    rightPts.push(center.clone().addScaledVector(sideUnit, halfWidth));
  }

  for (let i = 0; i < n - 1; i++) {
    appendQuad(positions, leftPts[i], rightPts[i], leftPts[i + 1], rightPts[i + 1]);
  }

  appendRoundCap(positions, centers[0], segTans[0], sideUnits[0], radii[0], true, 6);
  appendRoundCap(
    positions,
    centers[n - 1],
    segTans[n - 2],
    sideUnits[n - 1],
    radii[n - 1],
    false,
    6
  );

  for (let i = 1; i < n - 1; i++) {
    appendRoundJoin(
      positions,
      centers[i],
      normals[i],
      sideUnits[i - 1],
      sideUnits[i],
      segTans[i - 1],
      segTans[i],
      radii[i],
      4
    );
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
  const sideUnit = new THREE.Vector3();
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

    sideUnit.crossVectors(tangent, normal);
    if (sideUnit.lengthSq() < 1e-4) sideUnit.set(1, 0, 0);
    sideUnit.normalize();
    side.copy(sideUnit).multiplyScalar(halfWidth);

    let localOffset = 0;
    while (localOffset < segLen) {
      const phase = (accumPhase + localOffset) % dashPeriod;
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
        if (phase < 1e-2) {
          appendRoundCap(positions, segStart, tangent, sideUnit, halfWidth, true, 4);
        }
        if (step >= remainDash - 1e-2) {
          appendRoundCap(positions, segEnd, tangent, sideUnit, halfWidth, false, 4);
        }
        localOffset += step;
      } else {
        const remainGap = dashPeriod - phase;
        const step = Math.min(remainGap, segLen - localOffset);
        localOffset += step;
      }
    }
    accumPhase = (accumPhase + segLen) % dashPeriod;
  }

  return positions;
}

function buildCameraFacingArrowheadMesh(
  curve: readonly TelestratorPoint[],
  camPos: TelestratorVec3,
  camFovDeg: number,
  arrowLengthRefPx: number,
  arrowWidthRefPx: number,
  colorHex: number,
  opacity: number
): THREE.Mesh | null {
  if (curve.length < 2) return null;

  const tipPt = curve[curve.length - 1];
  const tipDist = Math.hypot(tipPt.x - camPos.x, tipPt.y - camPos.y, tipPt.z - camPos.z);

  // Billboard normal points directly toward camera to eliminate edge perspective skew
  const viewNormal = new THREE.Vector3(
    camPos.x - tipPt.x,
    camPos.y - tipPt.y,
    camPos.z - tipPt.z
  );
  if (viewNormal.lengthSq() < 1e-4) viewNormal.set(0, 0, 1);
  viewNormal.normalize();

  // Accumulate view-plane projected arc length (~28px at tipDist) for stable direction
  const targetArcWorld = computeNormalizedScreenWorldWidth(28, tipDist, camFovDeg);
  const projDir = new THREE.Vector3();
  const segVec = new THREE.Vector3();
  let accumArc = 0;
  for (let i = curve.length - 2; i >= 0; i--) {
    const a = curve[i];
    const b = curve[i + 1];
    segVec.set(b.x - a.x, b.y - a.y, b.z - a.z);
    segVec.addScaledVector(viewNormal, -segVec.dot(viewNormal));
    const segLen = segVec.length();
    if (segLen > 1e-3) {
      projDir.add(segVec);
      accumArc += segLen;
      if (accumArc >= targetArcWorld) break;
    }
  }

  if (projDir.lengthSq() < 1e-4) {
    projDir.set(0, 1, 0);
    projDir.addScaledVector(viewNormal, -projDir.dot(viewNormal));
    if (projDir.lengthSq() < 1e-4) projDir.set(1, 0, 0);
  }
  projDir.normalize();

  const worldArrowLength = computeNormalizedScreenWorldWidth(arrowLengthRefPx, tipDist, camFovDeg);
  const worldArrowWidth = computeNormalizedScreenWorldWidth(arrowWidthRefPx, tipDist, camFovDeg);

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
  mesh.renderOrder = 1055;
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
  _camForward: TelestratorVec3,
  camFovDeg: number,
  precomputedCurve?: readonly TelestratorPoint[]
): THREE.Group {
  const group = new THREE.Group();
  if (points.length < 2) return group;

  const colorHex = resolveTelestratorColorNumeric(colorId);
  const curve = precomputedCurve ?? smoothStrokeCurve(points);
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
    ribbonMesh.renderOrder = 1050;
    group.add(ribbonMesh);
  }

  if (tool === 'arrow') {
    const arrowMesh = buildCameraFacingArrowheadMesh(
      curve,
      camPos,
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
