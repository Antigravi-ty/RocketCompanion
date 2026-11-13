import * as THREE from 'three';
import {
  buildStrokeRenderGroup,
  computeStrokeHash,
  simplifyAndResampleStroke,
} from './telestratorStrokeGeometry.ts';
import {
  DEFAULT_TELESTRATOR_ARROW_LENGTH_REF_PX,
  DEFAULT_TELESTRATOR_ARROW_WIDTH_REF_PX,
  type TelestratorBrushTool,
  type TelestratorColorId,
  type TelestratorPoint,
  type TelestratorStroke,
  type TelestratorVec3,
} from './telestratorTypes.ts';

interface ManagedStrokeEntry {
  stroke: TelestratorStroke;
  group: THREE.Group;
}

export interface BeginStrokeOptions {
  authorId?: string;
  tool: TelestratorBrushTool;
  colorId: TelestratorColorId;
  opacity: number;
  widthRefPx: number;
  arrowLengthRefPx?: number;
  arrowWidthRefPx?: number;
  camPos?: TelestratorVec3;
  camForward?: TelestratorVec3;
  camFovDeg?: number;
  createdTick?: number;
  fadeDurationTicks?: number;
}

function disposeThreeGroup(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((obj) => {
    const renderable = obj as THREE.Mesh | THREE.LineSegments;
    if (renderable.geometry) geometries.add(renderable.geometry);
    if (renderable.material) {
      if (Array.isArray(renderable.material)) {
        for (const m of renderable.material) materials.add(m);
      } else {
        materials.add(renderable.material);
      }
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
}

function extractCamForward(camera: THREE.Camera | null): TelestratorVec3 {
  if (!camera) return { x: 0, y: 0, z: -1 };
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  if (dir.lengthSq() < 1e-6) return { x: 0, y: 0, z: -1 };
  dir.normalize();
  return { x: dir.x, y: dir.y, z: dir.z };
}

function extractCamPos(camera: THREE.Camera | null): TelestratorVec3 {
  if (!camera) return { x: 0, y: 1600, z: -3600 };
  const pos = new THREE.Vector3();
  camera.getWorldPosition(pos);
  return { x: pos.x, y: pos.y, z: pos.z };
}

function extractCamFovDeg(camera: THREE.Camera | null): number {
  if (camera && 'fov' in camera && typeof (camera as THREE.PerspectiveCamera).fov === 'number') {
    return (camera as THREE.PerspectiveCamera).fov;
  }
  return 60;
}

export class TelestratorManager {
  public readonly rootGroup: THREE.Group = new THREE.Group();
  private readonly strokes: ManagedStrokeEntry[] = [];
  private lastClearedStrokes: TelestratorStroke[] | null = null;
  private activeDraft: {
    id: string;
    options: Required<
      Pick<
        BeginStrokeOptions,
        | 'tool'
        | 'colorId'
        | 'opacity'
        | 'widthRefPx'
        | 'arrowLengthRefPx'
        | 'arrowWidthRefPx'
        | 'camPos'
        | 'camForward'
        | 'camFovDeg'
      >
    > &
      BeginStrokeOptions;
    points: TelestratorPoint[];
    group: THREE.Group | null;
  } | null = null;
  private strokeSeq = 0;

  constructor(scene?: THREE.Scene | null) {
    this.rootGroup.name = 'TelestratorRoot';
    if (scene) scene.add(this.rootGroup);
  }

  public attachToScene(scene: THREE.Scene): void {
    if (this.rootGroup.parent !== scene) {
      scene.add(this.rootGroup);
    }
  }

  public getStrokeCount(): number {
    return this.strokes.length;
  }

  public hasUndoHistory(): boolean {
    return this.strokes.length > 0 || this.lastClearedStrokes !== null;
  }

  public isPendingClearPurge(): boolean {
    return this.strokes.length === 0 && this.lastClearedStrokes !== null;
  }

  public getAllStrokes(): readonly TelestratorStroke[] {
    return this.strokes.map((e) => e.stroke);
  }

  public beginStroke(
    firstPoint: TelestratorPoint,
    options: BeginStrokeOptions,
    camera: THREE.Camera | null
  ): void {
    this.cancelDraft();
    this.strokeSeq++;
    const camPos = options.camPos ?? extractCamPos(camera);
    const camForward = options.camForward ?? extractCamForward(camera);
    const camFovDeg = options.camFovDeg ?? extractCamFovDeg(camera);
    const arrowLengthRefPx = options.arrowLengthRefPx ?? DEFAULT_TELESTRATOR_ARROW_LENGTH_REF_PX;
    const arrowWidthRefPx = options.arrowWidthRefPx ?? DEFAULT_TELESTRATOR_ARROW_WIDTH_REF_PX;
    this.activeDraft = {
      id: `stroke-${Date.now()}-${this.strokeSeq}`,
      options: {
        ...options,
        arrowLengthRefPx,
        arrowWidthRefPx,
        camPos,
        camForward,
        camFovDeg,
      },
      points: [{ ...firstPoint }],
      group: null,
    };
  }

  public appendDraftPoint(point: TelestratorPoint): boolean {
    if (!this.activeDraft) return false;
    const pts = this.activeDraft.points;
    const last = pts[pts.length - 1];
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    const dz = point.z - last.z;
    if (dx * dx + dy * dy + dz * dz < 144) return false;

    pts.push({ ...point });
    if (this.activeDraft.group) {
      this.rootGroup.remove(this.activeDraft.group);
      disposeThreeGroup(this.activeDraft.group);
    }
    const opts = this.activeDraft.options;
    this.activeDraft.group = buildStrokeRenderGroup(
      pts,
      opts.tool,
      opts.colorId,
      opts.opacity,
      opts.widthRefPx,
      opts.arrowLengthRefPx,
      opts.arrowWidthRefPx,
      opts.camPos,
      opts.camForward,
      opts.camFovDeg
    );
    this.rootGroup.add(this.activeDraft.group);
    return true;
  }

  public endStroke(): TelestratorStroke | null {
    if (!this.activeDraft) return null;
    const draft = this.activeDraft;
    this.activeDraft = null;
    if (draft.group) {
      this.rootGroup.remove(draft.group);
      disposeThreeGroup(draft.group);
    }
    if (draft.points.length < 2) return null;

    const simplified = simplifyAndResampleStroke(draft.points, 24, 6);
    if (simplified.length < 2) return null;

    const opts = draft.options;
    const hash = computeStrokeHash(
      opts.tool,
      opts.colorId,
      opts.opacity,
      opts.widthRefPx,
      simplified
    );

    const stroke: TelestratorStroke = {
      id: draft.id,
      authorId: opts.authorId ?? 'local',
      tool: opts.tool,
      colorId: opts.colorId,
      opacity: opts.opacity,
      widthRefPx: opts.widthRefPx,
      arrowLengthRefPx: opts.arrowLengthRefPx,
      arrowWidthRefPx: opts.arrowWidthRefPx,
      camPos: opts.camPos,
      camForward: opts.camForward,
      camFovDeg: opts.camFovDeg,
      createdTick: opts.createdTick ?? 0,
      fadeDurationTicks: opts.fadeDurationTicks ?? 0,
      points: simplified,
      hash,
    };

    this.lastClearedStrokes = null;
    const group = this.buildEntryGroup(stroke);
    this.rootGroup.add(group);
    this.strokes.push({ stroke, group });
    return stroke;
  }

  public cancelDraft(): void {
    if (!this.activeDraft) return;
    if (this.activeDraft.group) {
      this.rootGroup.remove(this.activeDraft.group);
      disposeThreeGroup(this.activeDraft.group);
    }
    this.activeDraft = null;
  }

  public addRemoteStroke(stroke: TelestratorStroke): void {
    if (this.strokes.some((e) => e.stroke.id === stroke.id)) return;
    const group = this.buildEntryGroup(stroke);
    this.rootGroup.add(group);
    this.strokes.push({ stroke, group });
  }

  public undoLastStroke(): TelestratorStroke | null {
    if (this.strokes.length > 0) {
      const popped = this.strokes.pop()!;
      this.rootGroup.remove(popped.group);
      disposeThreeGroup(popped.group);
      return popped.stroke;
    }
    if (this.lastClearedStrokes && this.lastClearedStrokes.length > 0) {
      const restored = this.lastClearedStrokes;
      this.lastClearedStrokes = null;
      for (const stroke of restored) {
        const group = this.buildEntryGroup(stroke);
        this.rootGroup.add(group);
        this.strokes.push({ stroke, group });
      }
      return restored[restored.length - 1] ?? null;
    }
    return null;
  }

  public clearAll(): void {
    this.cancelDraft();
    if (this.strokes.length === 0) {
      this.lastClearedStrokes = null;
      return;
    }
    const snapshot: TelestratorStroke[] = [];
    for (const entry of this.strokes) {
      snapshot.push(entry.stroke);
      this.rootGroup.remove(entry.group);
      disposeThreeGroup(entry.group);
    }
    this.strokes.length = 0;
    this.lastClearedStrokes = snapshot;
  }

  public updateReplayTick(currentTick: number): void {
    for (const entry of this.strokes) {
      const { createdTick, fadeDurationTicks, opacity } = entry.stroke;
      if (fadeDurationTicks <= 0) {
        entry.group.visible = true;
        continue;
      }
      const age = currentTick - createdTick;
      if (age < 0 || age > fadeDurationTicks) {
        entry.group.visible = false;
        continue;
      }
      entry.group.visible = true;
      const fadeRatio =
        age > fadeDurationTicks * 0.75
          ? Math.max(0, 1 - (age - fadeDurationTicks * 0.75) / (fadeDurationTicks * 0.25))
          : 1;
      const targetOpacity = opacity * fadeRatio;
      entry.group.traverse((obj) => {
        const mat = (obj as THREE.Mesh).material;
        if (mat && !Array.isArray(mat) && 'opacity' in mat) {
          mat.opacity = targetOpacity;
          mat.transparent = targetOpacity < 1;
        }
      });
    }
  }

  private buildEntryGroup(stroke: TelestratorStroke): THREE.Group {
    return buildStrokeRenderGroup(
      stroke.points,
      stroke.tool,
      stroke.colorId,
      stroke.opacity,
      stroke.widthRefPx,
      stroke.arrowLengthRefPx,
      stroke.arrowWidthRefPx,
      stroke.camPos,
      stroke.camForward,
      stroke.camFovDeg
    );
  }

  public dispose(): void {
    this.lastClearedStrokes = null;
    this.cancelDraft();
    while (this.strokes.length > 0) {
      const entry = this.strokes.pop()!;
      this.rootGroup.remove(entry.group);
      disposeThreeGroup(entry.group);
    }
    this.rootGroup.parent?.remove(this.rootGroup);
  }
}
