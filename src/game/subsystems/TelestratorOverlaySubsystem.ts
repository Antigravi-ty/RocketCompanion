import * as THREE from 'three';
import { TelestratorManager } from '../../entities/telestrator/TelestratorManager.ts';
import { raycastScreenToArena } from '../../entities/telestrator/arenaSurfaceRaycaster.ts';
import {
  decodeTelestratorHashAck,
  decodeTelestratorStroke,
  encodeTelestratorHashAck,
  encodeTelestratorStroke,
} from '../../network/protocol/TelestratorWireCodec.ts';
import { floatingStore, useTelestratorStore } from '../runtimeUiPort.ts';
import { isEditableEventTarget, subscribeGlobalKeyDown } from '../../input/hotkeyInputGuard.ts';

export interface TelestratorOverlayRuntimePort {
  arena?: {
    scene?: THREE.Scene | null;
  } | null;
  camera?: {
    camera?: THREE.PerspectiveCamera | null;
    isFreeCam?: boolean;
    freeController?: { shouldSuppressDrag?: (() => boolean) | null } | null;
    applyDirectionOffsetDelta?: (deltaYaw: number, deltaPitch: number) => void;
    resetDirectionOffset?: () => void;
    getDirectionOffsetDeg?: () => { yawDeg: number; pitchDeg: number };
  } | null;
  keyboard?: {
    externalMouseSuppressPredicate?: (() => boolean) | null;
  } | null;
}

function isUiEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, [role="button"], [role="switch"], [role="dialog"], [role="tab"], .floating-window, #game-ui-root, .hud-tools'
    )
  );
}

function shouldTakeOverPointer(): boolean {
  const st = useTelestratorStore.getState();
  return st.overlayActive && (st.drawingEnabled || st.directionAdjustActive);
}

export class TelestratorOverlaySubsystem {
  public readonly telestrator: TelestratorManager = new TelestratorManager();
  private readonly runtime: TelestratorOverlayRuntimePort;
  private isActive = false;
  private isDrawingPointerDown = false;
  private isAdjustPointerDown = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private unsubKeyDown: (() => void) | null = null;
  private readonly boundPointerDown: (e: PointerEvent) => void;
  private readonly boundPointerMove: (e: PointerEvent) => void;
  private readonly boundPointerUp: () => void;

  constructor(runtime: TelestratorOverlayRuntimePort) {
    this.runtime = runtime;
    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);

    useTelestratorStore.getState().setRuntimeHandlers({
      onUndo: () => this.undoLastStroke(),
      onClear: () => this.clearStrokes(),
      onRestoreDirectionOffset: () => this.restoreDirectionOffset(),
      onActivateOverlay: () => this.activate(),
      onDeactivateOverlay: () => this.deactivate(),
    });
  }

  public activate(): void {
    if (this.isActive) return;
    this.isActive = true;

    const r = this.runtime;
    if (r.arena?.scene) {
      this.telestrator.attachToScene(r.arena.scene);
    }
    if (r.camera?.freeController) {
      r.camera.freeController.shouldSuppressDrag = shouldTakeOverPointer;
    }
    if (r.keyboard) {
      r.keyboard.externalMouseSuppressPredicate = shouldTakeOverPointer;
    }

    const store = useTelestratorStore.getState();
    store.setIsFreeCam(Boolean(r.camera?.isFreeCam));
    this.syncStrokeStoreState();
    this.spawnToolbarWindow();
    this.bindInputListeners();
  }

  public deactivate(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.isDrawingPointerDown = false;
    this.isAdjustPointerDown = false;
    this.telestrator.cancelDraft();
    this.unbindInputListeners();

    const r = this.runtime;
    if (r.camera?.freeController?.shouldSuppressDrag === shouldTakeOverPointer) {
      r.camera.freeController.shouldSuppressDrag = null;
    }
    if (r.keyboard?.externalMouseSuppressPredicate === shouldTakeOverPointer) {
      r.keyboard.externalMouseSuppressPredicate = null;
    }
    this.restoreDirectionOffset();
  }

  public update(): void {
    const store = useTelestratorStore.getState();
    if (!store.overlayActive) {
      if (this.isActive) this.deactivate();
      return;
    }
    if (!this.isActive) {
      this.activate();
    }
    const r = this.runtime;
    if (r.arena?.scene) {
      this.telestrator.attachToScene(r.arena.scene);
    }
    store.setIsFreeCam(Boolean(r.camera?.isFreeCam));
    const deg = r.camera?.getDirectionOffsetDeg?.();
    if (deg) {
      if (
        deg.yawDeg !== store.directionOffsetYawDeg ||
        deg.pitchDeg !== store.directionOffsetPitchDeg
      ) {
        store.setDirectionOffsetDeg(deg.yawDeg, deg.pitchDeg);
      }
    }
  }

  private spawnToolbarWindow(): void {
    const snap = floatingStore.getSnapshot();
    const exists = snap.windows.some((w) => w.id === 'telestrator-toolbar');
    if (!exists) {
      floatingStore._bound?.spawnWindow?.({
        id: 'telestrator-toolbar',
        title: 'Telestrator',
        category: 'TelestratorToolbar',
        width: 72,
        minWidth: 64,
        height: 540,
        minHeight: 360,
        hideFooter: true,
        component: 'TelestratorToolbarFloatingWindow',
        startMinimized: false,
        position: { x: 16, y: 240 },
      });
    }
  }

  private restoreDirectionOffset(): void {
    this.runtime.camera?.resetDirectionOffset?.();
    useTelestratorStore.getState().setDirectionOffsetDeg(0, 0);
  }

  private undoLastStroke(): void {
    this.telestrator.undoLastStroke();
    this.syncStrokeStoreState();
  }

  private clearStrokes(): void {
    this.telestrator.clearAll();
    this.syncStrokeStoreState();
  }

  private syncStrokeStoreState(): void {
    useTelestratorStore
      .getState()
      .setStrokeSyncState(
        this.telestrator.getStrokeCount(),
        this.telestrator.hasUndoHistory(),
        this.telestrator.isPendingClearPurge()
      );
  }

  private bindInputListeners(): void {
    this.unbindInputListeners();
    if (typeof window === 'undefined') return;

    this.unsubKeyDown = subscribeGlobalKeyDown((e: KeyboardEvent) => {
      if (!useTelestratorStore.getState().overlayActive) return;
      if (isEditableEventTarget(e)) return;

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        e.stopPropagation();
        this.undoLastStroke();
        return;
      }

      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.code === 'Delete' || e.code === 'Backspace')
      ) {
        if (this.telestrator.hasUndoHistory()) {
          e.preventDefault();
          e.stopPropagation();
          this.clearStrokes();
        }
      }
    }, true);

    window.addEventListener('pointerdown', this.boundPointerDown);
    window.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('pointerup', this.boundPointerUp);
  }

  private unbindInputListeners(): void {
    this.unsubKeyDown?.();
    this.unsubKeyDown = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.boundPointerDown);
      window.removeEventListener('pointermove', this.boundPointerMove);
      window.removeEventListener('pointerup', this.boundPointerUp);
    }
  }

  private pointerToNdc(e: PointerEvent): { ndcX: number; ndcY: number } {
    const w = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
    const h = typeof window !== 'undefined' ? window.innerHeight || 720 : 720;
    return {
      ndcX: (e.clientX / w) * 2 - 1,
      ndcY: -(e.clientY / h) * 2 + 1,
    };
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0 || isUiEventTarget(e.target)) return;
    const st = useTelestratorStore.getState();
    if (!st.overlayActive) return;

    if (st.directionAdjustActive && !st.isFreeCam) {
      this.isAdjustPointerDown = true;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      return;
    }

    if (!st.drawingEnabled) return;
    const cam = this.runtime.camera?.camera;
    if (!cam) return;

    const { ndcX, ndcY } = this.pointerToNdc(e);
    const hit = raycastScreenToArena(ndcX, ndcY, cam);
    if (!hit) return;

    const preset = st.presets[st.activePresetIndex] ?? st.presets[0];
    this.isDrawingPointerDown = true;
    this.telestrator.beginStroke(
      {
        x: hit.point.x,
        y: hit.point.y,
        z: hit.point.z,
        nx: hit.normal.x,
        ny: hit.normal.y,
        nz: hit.normal.z,
      },
      {
        tool: st.activeTool,
        colorId: st.activeColorId,
        opacity: preset.opacity,
        widthUnits: preset.widthUnits,
        arrowLength: st.arrowLength,
        arrowWidth: st.arrowWidth,
      },
      cam
    );
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.isAdjustPointerDown) {
      const dx = e.clientX - this.lastPointerX;
      const dy = e.clientY - this.lastPointerY;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.runtime.camera?.applyDirectionOffsetDelta?.(-dx * 0.004, -dy * 0.004);
      const deg = this.runtime.camera?.getDirectionOffsetDeg?.();
      if (deg) useTelestratorStore.getState().setDirectionOffsetDeg(deg.yawDeg, deg.pitchDeg);
      return;
    }

    if (!this.isDrawingPointerDown) return;
    const cam = this.runtime.camera?.camera;
    if (!cam) return;
    const { ndcX, ndcY } = this.pointerToNdc(e);
    const hit = raycastScreenToArena(ndcX, ndcY, cam);
    if (!hit) return;
    this.telestrator.appendDraftPoint({
      x: hit.point.x,
      y: hit.point.y,
      z: hit.point.z,
      nx: hit.normal.x,
      ny: hit.normal.y,
      nz: hit.normal.z,
    });
  }

  private handlePointerUp(): void {
    this.isAdjustPointerDown = false;
    if (!this.isDrawingPointerDown) return;
    this.isDrawingPointerDown = false;
    const committed = this.telestrator.endStroke();
    if (committed) {
      const encoded = encodeTelestratorStroke(committed);
      const decoded = decodeTelestratorStroke(encoded);
      const ackBytes = encodeTelestratorHashAck({
        strokeId: committed.id,
        hash: committed.hash,
        matched: decoded?.hash === committed.hash,
      });
      decodeTelestratorHashAck(ackBytes);
      this.syncStrokeStoreState();
    }
  }

  public dispose(): void {
    this.deactivate();
    this.telestrator.dispose();
  }
}
