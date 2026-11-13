import * as THREE from 'three';
import { buildStrokeRenderGroup } from './telestratorStrokeGeometry.ts';
import {
  computeStrokeHash,
  simplifyAndResampleStroke,
  smoothStrokeCurve,
} from './telestratorStrokeMath.ts';
import {
  DEFAULT_TELESTRATOR_ARROW_LENGTH_REF_PX,
  DEFAULT_TELESTRATOR_ARROW_WIDTH_REF_PX,
  type TelestratorBrushPreset,
  type TelestratorBrushTool,
  type TelestratorColorId,
  type TelestratorPoint,
  type TelestratorPresetIndex,
  type TelestratorStroke,
  type TelestratorStrokeDebugDump,
  type TelestratorVec3,
} from './telestratorTypes.ts';

interface ManagedStrokeEntry {
  stroke: TelestratorStroke;
  rawPoints: TelestratorPoint[];
  renderedPoints: TelestratorPoint[];
  group: THREE.Group;
}

export interface BeginStrokeOptions {
  authorId?: string;
  tool: TelestratorBrushTool;
  colorId: TelestratorColorId;
  presetIndex: TelestratorPresetIndex;
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
  private lastClearedEntries: ManagedStrokeEntry[] | null = null;
  private activeDraft: {
    id: string;
    strokeSeq: number;
    options: Required<
      Pick<
        BeginStrokeOptions,
        | 'tool'
        | 'colorId'
        | 'presetIndex'
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
    rawPoints: TelestratorPoint[];
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

  public setStrokesVisible(visible: boolean): void {
    this.rootGroup.visible = visible;
  }

  public getStrokeCount(): number {
    return this.strokes.length;
  }

  public hasUndoHistory(authorId?: string): boolean {
    if (authorId) {
      return (
        this.strokes.some((e) => e.stroke.authorId === authorId) ||
        (this.lastClearedEntries !== null && this.lastClearedEntries.length > 0)
      );
    }
    return this.strokes.length > 0 || this.lastClearedEntries !== null;
  }

  public isPendingClearPurge(): boolean {
    return this.lastClearedEntries !== null;
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
      strokeSeq: this.strokeSeq,
      options: {
        ...options,
        arrowLengthRefPx,
        arrowWidthRefPx,
        camPos,
        camForward,
        camFovDeg,
      },
      rawPoints: [{ ...firstPoint }],
      points: [{ ...firstPoint }],
      group: null,
    };
  }

  public appendDraftPoint(point: TelestratorPoint): boolean {
    if (!this.activeDraft) return false;
    this.activeDraft.rawPoints.push({ ...point });

    const pts = this.activeDraft.points;
    const last = pts[pts.length - 1];
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    const dz = point.z - last.z;
    if (dx * dx + dy * dy + dz * dz < 144) return false;

    pts.push({ ...point });
    this.rebuildDraftGroup();
    return true;
  }

  public getDraftStrokeSnapshot(): TelestratorStroke | null {
    if (!this.activeDraft || this.activeDraft.points.length < 2) return null;
    const draft = this.activeDraft;
    const opts = draft.options;
    const hash = computeStrokeHash(
      opts.tool,
      opts.colorId,
      opts.presetIndex,
      opts.opacity,
      opts.widthRefPx,
      opts.arrowLengthRefPx,
      opts.arrowWidthRefPx,
      draft.points
    );
    return {
      id: draft.id,
      authorId: opts.authorId ?? 'local',
      strokeSeq: draft.strokeSeq,
      tool: opts.tool,
      colorId: opts.colorId,
      presetIndex: opts.presetIndex,
      opacity: opts.opacity,
      widthRefPx: opts.widthRefPx,
      arrowLengthRefPx: opts.arrowLengthRefPx,
      arrowWidthRefPx: opts.arrowWidthRefPx,
      camPos: opts.camPos,
      camForward: opts.camForward,
      camFovDeg: opts.camFovDeg,
      createdTick: opts.createdTick ?? 0,
      fadeDurationTicks: opts.fadeDurationTicks ?? 0,
      points: draft.points,
      hash,
    };
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
      opts.presetIndex,
      opts.opacity,
      opts.widthRefPx,
      opts.arrowLengthRefPx,
      opts.arrowWidthRefPx,
      simplified
    );

    const stroke: TelestratorStroke = {
      id: draft.id,
      authorId: opts.authorId ?? 'local',
      strokeSeq: draft.strokeSeq,
      tool: opts.tool,
      colorId: opts.colorId,
      presetIndex: opts.presetIndex,
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

    this.disposeClearedSnapshot();
    const renderedPoints = smoothStrokeCurve(stroke.points);
    const group = this.buildEntryGroup(stroke, renderedPoints);
    this.rootGroup.add(group);
    this.strokes.push({
      stroke,
      rawPoints: draft.rawPoints,
      renderedPoints,
      group,
    });
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

  public addOrReplaceRemoteStroke(stroke: TelestratorStroke): void {
    const existingIdx = this.strokes.findIndex((e) => e.stroke.id === stroke.id);
    const renderedPoints = smoothStrokeCurve(stroke.points);
    const group = this.buildEntryGroup(stroke, renderedPoints);
    this.rootGroup.add(group);
    if (existingIdx >= 0) {
      const prev = this.strokes[existingIdx];
      this.rootGroup.remove(prev.group);
      disposeThreeGroup(prev.group);
      this.strokes[existingIdx] = { stroke, rawPoints: [], renderedPoints, group };
    } else {
      this.strokes.push({ stroke, rawPoints: [], renderedPoints, group });
    }
  }

  public rebuildStrokesForPresets(
    presets: readonly [TelestratorBrushPreset, TelestratorBrushPreset, TelestratorBrushPreset],
    arrowLengthRefPx: number,
    arrowWidthRefPx: number
  ): void {
    for (let i = 0; i < this.strokes.length; i++) {
      const entry = this.strokes[i];
      const s = entry.stroke;
      const preset = presets[s.presetIndex] ?? presets[0];
      const nextOpacity = preset.opacity;
      const nextWidth = preset.widthRefPx;
      const nextArrowLen = s.tool === 'arrow' ? arrowLengthRefPx : s.arrowLengthRefPx;
      const nextArrowW = s.tool === 'arrow' ? arrowWidthRefPx : s.arrowWidthRefPx;

      if (
        s.opacity === nextOpacity &&
        s.widthRefPx === nextWidth &&
        s.arrowLengthRefPx === nextArrowLen &&
        s.arrowWidthRefPx === nextArrowW
      ) {
        continue;
      }

      s.opacity = nextOpacity;
      s.widthRefPx = nextWidth;
      s.arrowLengthRefPx = nextArrowLen;
      s.arrowWidthRefPx = nextArrowW;
      s.hash = computeStrokeHash(
        s.tool,
        s.colorId,
        s.presetIndex,
        s.opacity,
        s.widthRefPx,
        s.arrowLengthRefPx,
        s.arrowWidthRefPx,
        s.points
      );

      this.rootGroup.remove(entry.group);
      disposeThreeGroup(entry.group);
      entry.group = this.buildEntryGroup(s, entry.renderedPoints);
      this.rootGroup.add(entry.group);
    }

    if (this.activeDraft) {
      const opts = this.activeDraft.options;
      const preset = presets[opts.presetIndex] ?? presets[0];
      opts.opacity = preset.opacity;
      opts.widthRefPx = preset.widthRefPx;
      opts.arrowLengthRefPx = arrowLengthRefPx;
      opts.arrowWidthRefPx = arrowWidthRefPx;
      this.rebuildDraftGroup();
    }
  }

  public undoOwnStroke(authorId = 'local'): TelestratorStroke | null {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].stroke.authorId === authorId) {
        const [removed] = this.strokes.splice(i, 1);
        this.rootGroup.remove(removed.group);
        disposeThreeGroup(removed.group);
        return removed.stroke;
      }
    }
    if (this.lastClearedEntries && this.lastClearedEntries.length > 0) {
      const restored = this.lastClearedEntries;
      this.lastClearedEntries = null;
      let lastRestored: TelestratorStroke | null = null;
      for (const entry of restored) {
        if (entry.stroke.authorId !== authorId) continue;
        const group = this.buildEntryGroup(entry.stroke, entry.renderedPoints);
        this.rootGroup.add(group);
        this.strokes.push({ ...entry, group });
        lastRestored = entry.stroke;
      }
      return lastRestored;
    }
    return null;
  }

  public clearStrokesByScope(scope: 'own' | 'all', authorId = 'local'): void {
    this.cancelDraft();
    if (scope === 'all') {
      this.disposeClearedSnapshot();
      for (const entry of this.strokes) {
        this.rootGroup.remove(entry.group);
        disposeThreeGroup(entry.group);
      }
      this.strokes.length = 0;
      return;
    }

    const ownEntries: ManagedStrokeEntry[] = [];
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].stroke.authorId === authorId) {
        const [removed] = this.strokes.splice(i, 1);
        this.rootGroup.remove(removed.group);
        disposeThreeGroup(removed.group);
        ownEntries.unshift(removed);
      }
    }
    if (ownEntries.length > 0) {
      this.lastClearedEntries = ownEntries;
    } else {
      this.lastClearedEntries = null;
    }
  }

  public getLastStrokeDebugDump(wireBytes = 0): TelestratorStrokeDebugDump | null {
    const entry = this.strokes[this.strokes.length - 1];
    if (!entry) return null;
    const s = entry.stroke;
    return {
      strokeId: s.id,
      authorId: s.authorId,
      strokeSeq: s.strokeSeq,
      tool: s.tool,
      presetIndex: s.presetIndex,
      colorId: s.colorId,
      opacity: s.opacity,
      widthRefPx: s.widthRefPx,
      arrowLengthRefPx: s.arrowLengthRefPx,
      arrowWidthRefPx: s.arrowWidthRefPx,
      rawPoints: entry.rawPoints.map((p) => ({ ...p })),
      simplifiedPoints: s.points.map((p) => ({ ...p })),
      renderedPoints: entry.renderedPoints.map((p) => ({ ...p })),
      wireBytes,
      hash: s.hash,
      camPos: { ...s.camPos },
      camForward: { ...s.camForward },
      camFovDeg: s.camFovDeg,
    };
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

  private rebuildDraftGroup(): void {
    if (!this.activeDraft) return;
    if (this.activeDraft.group) {
      this.rootGroup.remove(this.activeDraft.group);
      disposeThreeGroup(this.activeDraft.group);
    }
    const opts = this.activeDraft.options;
    this.activeDraft.group = buildStrokeRenderGroup(
      this.activeDraft.points,
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
  }

  private buildEntryGroup(
    stroke: TelestratorStroke,
    renderedPoints?: readonly TelestratorPoint[]
  ): THREE.Group {
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
      stroke.camFovDeg,
      renderedPoints
    );
  }

  private disposeClearedSnapshot(): void {
    if (!this.lastClearedEntries) return;
    for (const entry of this.lastClearedEntries) {
      disposeThreeGroup(entry.group);
    }
    this.lastClearedEntries = null;
  }

  public dispose(): void {
    this.disposeClearedSnapshot();
    this.cancelDraft();
    while (this.strokes.length > 0) {
      const entry = this.strokes.pop()!;
      this.rootGroup.remove(entry.group);
      disposeThreeGroup(entry.group);
    }
    this.rootGroup.parent?.remove(this.rootGroup);
  }
}
