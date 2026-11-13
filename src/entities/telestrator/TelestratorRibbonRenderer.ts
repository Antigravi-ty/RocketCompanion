import * as THREE from 'three';
import type { TelestratorStroke } from './telestratorTypes.ts';

const RIBBON_VERT = `
  attribute vec3 aPrev;
  attribute vec3 aNext;
  attribute float aSide;
  attribute float aArcLen;
  uniform vec2 uResolution;
  uniform float uWidthPx;
  varying float vArcLen;

  void main() {
    vArcLen = aArcLen;
    vec4 clipCur = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 clipPrev = projectionMatrix * modelViewMatrix * vec4(aPrev, 1.0);
    vec4 clipNext = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);

    vec2 ndcCur = clipCur.xy / max(0.0001, clipCur.w);
    vec2 ndcPrev = clipPrev.xy / max(0.0001, clipPrev.w);
    vec2 ndcNext = clipNext.xy / max(0.0001, clipNext.w);

    vec2 dir = ndcNext - ndcPrev;
    float len = length(dir);
    vec2 tangent = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
    vec2 normalScreen = vec2(-tangent.y, tangent.x);

    vec2 offsetNdc = normalScreen * (uWidthPx / uResolution) * aSide;
    clipCur.xy += offsetNdc * clipCur.w;
    gl_Position = clipCur;
  }
`;

const RIBBON_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDashed;
  varying float vArcLen;

  void main() {
    if (uDashed > 0.5) {
      float cycle = mod(vArcLen, 180.0);
      if (cycle > 105.0) discard;
    }
    gl_FragColor = vec4(uColor, uOpacity);
  }
`;

export class TelestratorRibbonRenderer {
  public readonly group = new THREE.Group();
  private readonly scene: THREE.Scene | null;
  private readonly strokeMeshes = new Map<string, THREE.Group>();
  private previewGroup: THREE.Group | null = null;
  private readonly resolution = new THREE.Vector2(1280, 720);

  constructor(scene: THREE.Scene | null) {
    this.scene = scene;
    this.group.name = 'TelestratorRibbons';
    if (this.scene) this.scene.add(this.group);
  }

  public setViewportSize(width: number, height: number): void {
    if (width > 0 && height > 0) this.resolution.set(width, height);
  }

  public syncStrokes(strokes: readonly TelestratorStroke[]): void {
    const activeIds = new Set(strokes.map((s) => s.strokeId));
    for (const [id, meshGroup] of this.strokeMeshes.entries()) {
      if (!activeIds.has(id)) {
        this._disposeGroup(meshGroup);
        this.group.remove(meshGroup);
        this.strokeMeshes.delete(id);
      }
    }
    for (const stroke of strokes) {
      if (!this.strokeMeshes.has(stroke.strokeId)) {
        const built = this._buildStrokeGroup(stroke);
        if (built) {
          this.strokeMeshes.set(stroke.strokeId, built);
          this.group.add(built);
        }
      }
    }
  }

  public setActivePreview(stroke: TelestratorStroke | null): void {
    if (this.previewGroup) {
      this._disposeGroup(this.previewGroup);
      this.group.remove(this.previewGroup);
      this.previewGroup = null;
    }
    if (stroke && stroke.pointCount >= 2) {
      this.previewGroup = this._buildStrokeGroup(stroke);
      if (this.previewGroup) this.group.add(this.previewGroup);
    }
  }

  private _buildStrokeGroup(stroke: TelestratorStroke): THREE.Group | null {
    const n = stroke.pointCount;
    if (n < 2) return null;

    const vertCount = n * 2;
    const positions = new Float32Array(vertCount * 3);
    const prevs = new Float32Array(vertCount * 3);
    const nexts = new Float32Array(vertCount * 3);
    const sides = new Float32Array(vertCount);
    const arcLens = new Float32Array(vertCount);
    const indices = new Uint16Array((n - 1) * 6);

    let accumDist = 0;
    for (let i = 0; i < n; i++) {
      const ix = stroke.points[i * 3 + 0];
      const iy = stroke.points[i * 3 + 1];
      const iz = stroke.points[i * 3 + 2];
      if (i > 0) {
        const dx = ix - stroke.points[(i - 1) * 3 + 0];
        const dy = iy - stroke.points[(i - 1) * 3 + 1];
        const dz = iz - stroke.points[(i - 1) * 3 + 2];
        accumDist += Math.hypot(dx, dy, dz);
      }
      const pIdx = Math.max(0, i - 1);
      const nIdx = Math.min(n - 1, i + 1);
      for (let side = 0; side < 2; side++) {
        const v = i * 2 + side;
        positions[v * 3 + 0] = ix;
        positions[v * 3 + 1] = iy;
        positions[v * 3 + 2] = iz;
        prevs[v * 3 + 0] = stroke.points[pIdx * 3 + 0];
        prevs[v * 3 + 1] = stroke.points[pIdx * 3 + 1];
        prevs[v * 3 + 2] = stroke.points[pIdx * 3 + 2];
        nexts[v * 3 + 0] = stroke.points[nIdx * 3 + 0];
        nexts[v * 3 + 1] = stroke.points[nIdx * 3 + 1];
        nexts[v * 3 + 2] = stroke.points[nIdx * 3 + 2];
        sides[v] = side === 0 ? -1 : 1;
        arcLens[v] = accumDist;
      }
      if (i < n - 1) {
        const b = i * 2;
        const t = i * 6;
        indices[t + 0] = b;
        indices[t + 1] = b + 1;
        indices[t + 2] = b + 2;
        indices[t + 3] = b + 1;
        indices[t + 4] = b + 3;
        indices[t + 5] = b + 2;
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aPrev', new THREE.BufferAttribute(prevs, 3));
    geom.setAttribute('aNext', new THREE.BufferAttribute(nexts, 3));
    geom.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    geom.setAttribute('aArcLen', new THREE.BufferAttribute(arcLens, 1));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uResolution: { value: this.resolution },
        uWidthPx: { value: stroke.widthPx },
        uColor: { value: new THREE.Color(stroke.colorHex) },
        uOpacity: { value: stroke.opacity },
        uDashed: { value: stroke.brushType === 'dashed' ? 1.0 : 0.0 },
      },
    });

    const container = new THREE.Group();
    const ribbon = new THREE.Mesh(geom, mat);
    ribbon.frustumCulled = false;
    ribbon.renderOrder = 15;
    container.add(ribbon);

    if (stroke.brushType === 'arrow') {
      const tip = new THREE.Vector3(
        stroke.points[(n - 1) * 3 + 0],
        stroke.points[(n - 1) * 3 + 1],
        stroke.points[(n - 1) * 3 + 2]
      );
      const prev = new THREE.Vector3(
        stroke.points[(n - 2) * 3 + 0],
        stroke.points[(n - 2) * 3 + 1],
        stroke.points[(n - 2) * 3 + 2]
      );
      const norm = new THREE.Vector3(
        stroke.normals[(n - 1) * 3 + 0],
        stroke.normals[(n - 1) * 3 + 1],
        stroke.normals[(n - 1) * 3 + 2]
      ).normalize();
      const tangent = tip.clone().sub(prev).normalize();
      const sideVec = new THREE.Vector3().crossVectors(norm, tangent).normalize();
      const headLen = Math.max(85, stroke.widthPx * 14);
      const headHalfW = headLen * 0.55;
      const baseCenter = tip.clone().addScaledVector(tangent, -headLen);
      const pLeft = baseCenter.clone().addScaledVector(sideVec, headHalfW);
      const pRight = baseCenter.clone().addScaledVector(sideVec, -headHalfW);
      const arrowGeom = new THREE.BufferGeometry();
      arrowGeom.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [tip.x, tip.y, tip.z, pLeft.x, pLeft.y, pLeft.z, pRight.x, pRight.y, pRight.z],
          3
        )
      );
      const arrowMat = new THREE.MeshBasicMaterial({
        color: stroke.colorHex,
        transparent: true,
        opacity: stroke.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const arrowMesh = new THREE.Mesh(arrowGeom, arrowMat);
      arrowMesh.renderOrder = 16;
      container.add(arrowMesh);
    }

    return container;
  }

  private _disposeGroup(group: THREE.Group): void {
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material?.dispose();
      }
    });
  }

  public dispose(): void {
    for (const g of this.strokeMeshes.values()) this._disposeGroup(g);
    this.strokeMeshes.clear();
    if (this.previewGroup) {
      this._disposeGroup(this.previewGroup);
      this.previewGroup = null;
    }
    if (this.scene) this.scene.remove(this.group);
  }
}
