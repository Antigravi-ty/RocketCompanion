import * as THREE from 'three';
import {
  TELESTRATOR_COLORS,
  telestratorStore,
  type TelestratorState,
} from '../../ui-core/stores/telestratorStore.ts';
import { floatingStore } from '../../ui-core/stores/floatingStore.ts';
import { useAppStore } from '../../ui-core/stores/appStore.ts';
import {
  computeFnv1aStrokeHash,
  type TelestratorStroke,
} from '../../entities/telestrator/telestratorTypes.ts';
import { raycastArenaSurface } from '../../entities/telestrator/arenaSurfaceRaycaster.ts';
import { TelestratorRibbonRenderer } from '../../entities/telestrator/TelestratorRibbonRenderer.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';

interface TelestratorRuntimeLike {
  arena?: { scene?: THREE.Scene | null } | null;
  scene?: THREE.Scene | null;
  camera?: CameraManager | null;
  renderer?: THREE.WebGLRenderer | null;
  physics?: { tickCount?: number } | null;
  matchPort?: { startExpMultiBots?: () => void } | null;
}

function getActiveRuntime(): TelestratorRuntimeLike | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as { __rcScenarioDriver?: { runtime?: TelestratorRuntimeLike } })
      .__rcScenarioDriver?.runtime ?? null
  );
}

const MIN_POINT_SPACING_SQ = 36; // 6 UU squared

export class DrawingSandboxController {
  private ribbonRenderer: TelestratorRibbonRenderer | null = null;
  private boundDom: HTMLElement | null = null;
  private isPointerDown = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private draftPoints: number[] = [];
  private draftNormals: number[] = [];
  private lastEnterSeq = 0;
  private lastRestoreSeq = 0;
  private unsubscribeStore: (() => void) | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndcVec = new THREE.Vector2();

  public start(): () => void {
    this.unsubscribeStore = telestratorStore.subscribe((state, prev) =>
      this.onStoreChange(state, prev)
    );
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('resize', this.onResize);
    return () => this.dispose();
  }

  private onStoreChange(state: TelestratorState, prev: TelestratorState): void {
    if (state.enterSandboxSeq !== this.lastEnterSeq) {
      this.lastEnterSeq = state.enterSandboxSeq;
      this.handleEnterSandbox();
    }
    if (state.restorePovSeq !== this.lastRestoreSeq) {
      this.lastRestoreSeq = state.restorePovSeq;
      getActiveRuntime()?.camera?.resetPovAngularOffset();
    }
    if (state.strokes !== prev.strokes) {
      this.ensureRenderer()?.syncStrokes(state.strokes as readonly TelestratorStroke[]);
    }
    if (!state.sandboxActive && prev.sandboxActive) {
      this.detachCanvasListeners();
      this.ribbonRenderer?.setActivePreview(null);
      floatingStore.closeWindow('telestrator-toolbar');
    }
  }

  private handleEnterSandbox(): void {
    const rt = getActiveRuntime();
    useAppStore.getState().closeMenu();
    rt?.matchPort?.startExpMultiBots?.();
    this.ensureRenderer();
    this.attachCanvasListeners();
    const snap = floatingStore.getSnapshot();
    const exists = snap.windows.some((w) => w.id === 'telestrator-toolbar');
    if (!exists) {
      floatingStore.spawnWindow({
        id: 'telestrator-toolbar',
        title: 'Telestrator',
        category: 'Telestrator',
        width: 112,
        height: 460,
        position: { x: 20, y: 110 },
        startMinimized: false,
      });
    }
  }

  private ensureRenderer(): TelestratorRibbonRenderer | null {
    const rt = getActiveRuntime();
    const scene = rt?.arena?.scene ?? rt?.scene ?? null;
    if (!this.ribbonRenderer && scene) {
      this.ribbonRenderer = new TelestratorRibbonRenderer(scene);
      this.onResize();
    }
    return this.ribbonRenderer;
  }

  private attachCanvasListeners(): void {
    const dom = getActiveRuntime()?.renderer?.domElement ?? null;
    if (!dom || this.boundDom === dom) return;
    this.detachCanvasListeners();
    this.boundDom = dom;
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  private detachCanvasListeners(): void {
    if (!this.boundDom) return;
    this.boundDom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.boundDom = null;
  }

  private onResize = (): void => {
    if (!this.ribbonRenderer || typeof window === 'undefined') return;
    this.ribbonRenderer.setViewportSize(window.innerWidth, window.innerHeight);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const st = telestratorStore.getState();
    if (!st.sandboxActive) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      st.undoStroke();
      return;
    }

    const rt = getActiveRuntime();
    if (e.key >= '1' && e.key <= '6') {
      const slot = Number(e.key) as 1 | 2 | 3 | 4 | 5 | 6;
      st.setActiveCameraSlot(slot);
      if (rt?.camera) {
        rt.camera.isFreeCam = false;
        rt.camera.focusedCarIndex = slot - 1;
        rt.camera.resetPovAngularOffset();
      }
    } else if (e.key === '7') {
      st.setActiveCameraSlot(7);
      if (rt?.camera) {
        rt.camera.isFreeCam = true;
      }
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const st = telestratorStore.getState();
    if (!st.sandboxActive) return;
    this.isPointerDown = true;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    if (st.drawingActive && !st.directionAdjustActive) {
      this.draftPoints = [];
      this.draftNormals = [];
      this.samplePointerHit(e.clientX, e.clientY);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isPointerDown) return;
    const st = telestratorStore.getState();
    if (!st.sandboxActive) return;
    const dx = e.clientX - this.lastPointerX;
    const dy = e.clientY - this.lastPointerY;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;

    if (st.directionAdjustActive) {
      getActiveRuntime()?.camera?.adjustPovAngularOffset(-dx * 0.004, -dy * 0.004);
      return;
    }
    if (st.drawingActive) {
      this.samplePointerHit(e.clientX, e.clientY);
    }
  };

  private onPointerUp = (): void => {
    if (!this.isPointerDown) return;
    this.isPointerDown = false;
    const st = telestratorStore.getState();
    const count = Math.floor(this.draftPoints.length / 3);
    this.ribbonRenderer?.setActivePreview(null);
    if (st.drawingActive && !st.directionAdjustActive && count >= 2) {
      const stroke = this.buildStrokeRecord('stroke-' + Date.now() + '-' + count, count);
      st.pushStroke(stroke);
    }
    this.draftPoints = [];
    this.draftNormals = [];
  };

  private samplePointerHit(clientX: number, clientY: number): void {
    const rt = getActiveRuntime();
    const cam = rt?.camera?.camera ?? null;
    const dom = this.boundDom;
    if (!cam || !dom) return;
    const rect = dom.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.ndcVec.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.ndcVec, cam);
    const hit = raycastArenaSurface(this.raycaster.ray);
    if (!hit) return;

    const len = this.draftPoints.length;
    if (len >= 3) {
      const dx = hit.point.x - this.draftPoints[len - 3];
      const dy = hit.point.y - this.draftPoints[len - 2];
      const dz = hit.point.z - this.draftPoints[len - 1];
      if (dx * dx + dy * dy + dz * dz < MIN_POINT_SPACING_SQ) return;
    }
    this.draftPoints.push(hit.point.x, hit.point.y, hit.point.z);
    this.draftNormals.push(hit.normal.x, hit.normal.y, hit.normal.z);
    const count = Math.floor(this.draftPoints.length / 3);
    if (count >= 2) {
      this.ensureRenderer()?.setActivePreview(this.buildStrokeRecord('preview', count));
    }
  }

  private buildStrokeRecord(strokeId: string, pointCount: number): TelestratorStroke {
    const st = telestratorStore.getState();
    const colorEntry = TELESTRATOR_COLORS.find((c) => c.id === st.colorId) ?? TELESTRATOR_COLORS[3];
    const points = new Float32Array(this.draftPoints);
    const normals = new Float32Array(this.draftNormals);
    return {
      strokeId,
      fnv1aHash: computeFnv1aStrokeHash(
        points,
        pointCount,
        st.brushType,
        colorEntry.hex,
        st.opacity,
        st.widthPx
      ),
      brushType: st.brushType,
      colorHex: colorEntry.hex,
      opacity: st.opacity,
      widthPx: st.widthPx,
      points,
      normals,
      pointCount,
      tick: getActiveRuntime()?.physics?.tickCount ?? 0,
    };
  }

  public dispose(): void {
    this.detachCanvasListeners();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown, { capture: true });
      window.removeEventListener('resize', this.onResize);
    }
    this.ribbonRenderer?.dispose();
    this.ribbonRenderer = null;
  }
}
