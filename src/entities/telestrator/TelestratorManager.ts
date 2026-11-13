import * as THREE from 'three';
import {
  buildStrokeRenderGroup,
  computeStrokeHash,
  simplifyAndResampleStroke,
} from './telestratorStrokeGeometry.ts';
import type {
  TelestratorBrushTool,
  TelestratorColorId,
  TelestratorPoint,
  TelestratorStroke,
} from './telestratorTypes.ts';

interface ManagedStrokeEntry {
  stroke: TelestratorStroke;
  worldWidth: number;
  group: THREE.Group;
}

export interface BeginStrokeOptions {
  authorId?: string;
  tool: TelestratorBrushTool;
  colorId: TelestratorColorId;
  opacity: number;
  widthPx: number;
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

export function computeScreenRelativeWorldWidth(
  widthPx: number,
  distanceToCamera: number,
  camera: THREE.Camera | null,
  viewportHeightPx = 1080
): number {
  const safeDist = Math.max(100, distanceToCamera);
  const vFovDeg = camera instanceof THREE.PerspectiveCamera ? camera.fov : 60;
  const vFovRad = THREE.MathUtils.degToRad(vFovDeg);
  const worldHeightAtDist = 2 * Math.tan(vFovRad * 0.5) * safeDist;
  const safeViewportH = Math.max(240, viewportHeightPx);
  const worldPerPx = worldHeightAtDist / safeViewportH;
  return Math.max(10, Math.min(180, widthPx * worldPerPx));
}

export class TelestratorManager {
  public readonly rootGroup: THREE.Group = new THREE.Group();
  private readonly strokes: ManagedStrokeEntry[] = [];
  private activeDraft: {
    id: string;
    options: BeginStrokeOptions;
    points: TelestratorPoint[];
    worldWidth: number;
    group: THREE.Group | null;
  } | null = null;
  private dropStemsEnabled = true;
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

  public setDropStemsEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.dropStemsEnabled === next) return;
    this.dropStemsEnabled = next;
    for (const entry of this.strokes) {
      this.rebuildEntryGroup(entry);
    }
  }

  public getStrokeCount(): number {
    return this.strokes.length;
  }

  public getAllStrokes(): readonly TelestratorStroke[] {
    return this.strokes.map((e) => e.stroke);
  }

  public beginStroke(
    firstPoint: TelestratorPoint,
    options: BeginStrokeOptions,
    camera: THREE.Camera | null,
    viewportHeightPx: number
  ): void {
    this.cancelDraft();
    const camPos = camera ? camera.position : new THREE.Vector3(0, 1600, -3600);
    const dist = Math.hypot(
      firstPoint.x - camPos.x,
      firstPoint.y - camPos.y,
      firstPoint.z - camPos.z
    );
    const worldWidth = computeScreenRelativeWorldWidth(
      options.widthPx,
      dist,
      camera,
      viewportHeightPx
    );
    this.strokeSeq++;
    this.activeDraft = {
      id: `stroke-${Date.now()}-${this.strokeSeq}`,
      options: { ...options },
      points: [{ ...firstPoint }],
      worldWidth,
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
    this.activeDraft.group = buildStrokeRenderGroup(
      pts,
      this.activeDraft.options.tool,
      this.activeDraft.options.colorId,
      this.activeDraft.options.opacity,
      this.activeDraft.worldWidth,
      this.dropStemsEnabled
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

    const simplified = simplifyAndResampleStroke(draft.points, 28, 6);
    if (simplified.length < 2) return null;

    const hash = computeStrokeHash(
      draft.options.tool,
      draft.options.colorId,
      draft.options.opacity,
      draft.options.widthPx,
      simplified
    );

    const stroke: TelestratorStroke = {
      id: draft.id,
      authorId: draft.options.authorId ?? 'local',
      tool: draft.options.tool,
      colorId: draft.options.colorId,
      opacity: draft.options.opacity,
      widthPx: draft.options.widthPx,
      createdTick: draft.options.createdTick ?? 0,
      fadeDurationTicks: draft.options.fadeDurationTicks ?? 0,
      points: simplified,
      hash,
    };

    const group = buildStrokeRenderGroup(
      stroke.points,
      stroke.tool,
      stroke.colorId,
      stroke.opacity,
      draft.worldWidth,
      this.dropStemsEnabled
    );
    this.rootGroup.add(group);
    this.strokes.push({ stroke, worldWidth: draft.worldWidth, group });
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

  public addRemoteStroke(
    stroke: TelestratorStroke,
    camera: THREE.Camera | null,
    viewportHeightPx = 1080
  ): void {
    if (this.strokes.some((e) => e.stroke.id === stroke.id)) return;
    const anchor = stroke.points[0];
    const camPos = camera ? camera.position : new THREE.Vector3(0, 1600, -3600);
    const dist = anchor
      ? Math.hypot(anchor.x - camPos.x, anchor.y - camPos.y, anchor.z - camPos.z)
      : 2000;
    const worldWidth = computeScreenRelativeWorldWidth(
      stroke.widthPx,
      dist,
      camera,
      viewportHeightPx
    );
    const group = buildStrokeRenderGroup(
      stroke.points,
      stroke.tool,
      stroke.colorId,
      stroke.opacity,
      worldWidth,
      this.dropStemsEnabled
    );
    this.rootGroup.add(group);
    this.strokes.push({ stroke, worldWidth, group });
  }

  public undoLastStroke(): TelestratorStroke | null {
    const popped = this.strokes.pop();
    if (!popped) return null;
    this.rootGroup.remove(popped.group);
    disposeThreeGroup(popped.group);
    return popped.stroke;
  }

  public clearAll(): void {
    this.cancelDraft();
    while (this.strokes.length > 0) {
      const entry = this.strokes.pop()!;
      this.rootGroup.remove(entry.group);
      disposeThreeGroup(entry.group);
    }
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

  private rebuildEntryGroup(entry: ManagedStrokeEntry): void {
    this.rootGroup.remove(entry.group);
    disposeThreeGroup(entry.group);
    entry.group = buildStrokeRenderGroup(
      entry.stroke.points,
      entry.stroke.tool,
      entry.stroke.colorId,
      entry.stroke.opacity,
      entry.worldWidth,
      this.dropStemsEnabled
    );
    this.rootGroup.add(entry.group);
  }

  public dispose(): void {
    this.clearAll();
    this.rootGroup.parent?.remove(this.rootGroup);
  }
}
