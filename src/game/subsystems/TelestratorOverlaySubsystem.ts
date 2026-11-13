import * as THREE from 'three';
import {
  buildCmfCollisionMeshes,
  disposeCmfCollisionMeshes,
} from '../../entities/telestrator/cmfCollisionMeshBuilder.ts';
import { TelestratorManager } from '../../entities/telestrator/TelestratorManager.ts';
import {
  TelestratorPointerDiagRecorder,
  type TelestratorPointerDiagDump,
} from '../../entities/telestrator/telestratorPointerDiag.ts';
import { raycastScreenToArenaWithDiag } from '../../entities/telestrator/arenaSurfaceRaycaster.ts';
import {
  fetchArenaCollisionMeshes,
  preloadThrowbackCollisionMeshes,
} from '../../physics/RocketSimMeshLoader.ts';
import { useTelestratorStore } from '../runtimeUiPort.ts';
import {
  canTelestratorDrawNow,
  clientPointToNdc,
  collectTelestratorRaycastTargets,
  isTelestratorUiEventTarget,
  shouldTelestratorTakeOverPointer,
  spawnTelestratorToolbarWindow,
  subscribeTelestratorHotkeys,
  subscribeTelestratorStoreSync,
  TelestratorBodyTouchLock,
  verifyTelestratorStrokeWire,
} from './telestratorOverlayHelpers.ts';

export interface TelestratorOverlayRuntimePort {
  arena?: {
    scene?: THREE.Scene | null;
    environment?: {
      isThrowbackStadiumActive?: boolean;
      driftwoodsStadium?: THREE.Group | null;
      throwbackStadium?: THREE.Group | null;
    } | null;
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

export class TelestratorOverlaySubsystem {
  public readonly telestrator: TelestratorManager = new TelestratorManager();
  private readonly runtime: TelestratorOverlayRuntimePort;
  private readonly pointerDiag = new TelestratorPointerDiagRecorder();
  private isActive = false;
  private isDrawingPointerDown = false;
  private isAdjustPointerDown = false;
  private activePointerId: number | null = null;
  private pendingMove: {
    clientX: number;
    clientY: number;
    pointerType: string;
    pointerId: number;
    button: number;
  } | null = null;
  private readonly touchLock = new TelestratorBodyTouchLock();
  private lastPointerX = 0;
  private lastPointerY = 0;
  private lastWireBytes = 0;
  private unsubKeyDown: (() => void) | null = null;
  private unsubStore: (() => void) | null = null;
  private standardCmfMeshes: THREE.Mesh[] | null = null;
  private throwbackCmfMeshes: THREE.Mesh[] | null = null;
  private loadingStandardCmf = false;
  private loadingThrowbackCmf = false;
  private readonly boundPointerDown: (e: PointerEvent) => void;
  private readonly boundPointerMove: (e: PointerEvent) => void;
  private readonly boundPointerUp: (e: PointerEvent) => void;
  private readonly boundPointerCancel: (e: PointerEvent) => void;

  constructor(runtime: TelestratorOverlayRuntimePort) {
    this.runtime = runtime;
    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
    this.boundPointerCancel = this.handlePointerCancel.bind(this);

    useTelestratorStore.getState().setRuntimeHandlers({
      onUndo: () => this.undoLastStroke(),
      onClear: () => this.clearStrokes(),
      onRestoreDirectionOffset: () => this.restoreDirectionOffset(),
      onActivateOverlay: () => this.activate(),
      onDeactivateOverlay: () => this.deactivate(),
      onDumpLastStroke: () => {
        const dump = this.telestrator.getLastStrokeDebugDump(this.lastWireBytes);
        if (!dump) return null;
        return { ...dump, pointerDiagnostics: this.getPointerDiagnostics() };
      },
    });

    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__rcTelestratorDiag = {
        getDump: () => this.getPointerDiagnostics(),
        probeAt: (x: number, y: number) => this.probeScreenPoint(x, y),
      };
    }
  }

  public activate(): void {
    if (this.isActive) return;
    this.isActive = true;

    const r = this.runtime;
    if (r.arena?.scene) {
      this.telestrator.attachToScene(r.arena.scene);
    }
    if (r.camera?.freeController) {
      r.camera.freeController.shouldSuppressDrag = shouldTelestratorTakeOverPointer;
    }
    if (r.keyboard) {
      r.keyboard.externalMouseSuppressPredicate = shouldTelestratorTakeOverPointer;
    }

    const store = useTelestratorStore.getState();
    store.setIsFreeCam(Boolean(r.camera?.isFreeCam));
    this.telestrator.setStrokesVisible(store.strokesVisible);
    this.syncStrokeStoreState();
    this.ensureCmfMeshesLoaded();
    spawnTelestratorToolbarWindow();
    this.bindStoreSubscription();
    this.bindInputListeners();
    this.touchLock.sync(shouldTelestratorTakeOverPointer());
  }

  public deactivate(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.isDrawingPointerDown = false;
    this.isAdjustPointerDown = false;
    this.activePointerId = null;
    this.pendingMove = null;
    this.telestrator.cancelDraft();
    this.unbindStoreSubscription();
    this.unbindInputListeners();
    this.touchLock.sync(false);

    const r = this.runtime;
    if (r.camera?.freeController?.shouldSuppressDrag === shouldTelestratorTakeOverPointer) {
      r.camera.freeController.shouldSuppressDrag = null;
    }
    if (r.keyboard?.externalMouseSuppressPredicate === shouldTelestratorTakeOverPointer) {
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
    this.touchLock.sync(shouldTelestratorTakeOverPointer());
    this.flushPendingMove();
    const r = this.runtime;
    if (r.arena?.scene) {
      this.telestrator.attachToScene(r.arena.scene);
    }
    store.setIsFreeCam(Boolean(r.camera?.isFreeCam));
    this.ensureCmfMeshesLoaded();
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

  private ensureCmfMeshesLoaded(): void {
    const isThrowback = Boolean(this.runtime.arena?.environment?.isThrowbackStadiumActive);
    if (isThrowback) {
      if (this.throwbackCmfMeshes || this.loadingThrowbackCmf) return;
      this.loadingThrowbackCmf = true;
      void preloadThrowbackCollisionMeshes()
        .then((chunks) => {
          this.throwbackCmfMeshes = buildCmfCollisionMeshes(chunks, true);
        })
        .catch(() => {})
        .finally(() => {
          this.loadingThrowbackCmf = false;
        });
      return;
    }
    if (this.standardCmfMeshes || this.loadingStandardCmf) return;
    this.loadingStandardCmf = true;
    void fetchArenaCollisionMeshes()
      .then((chunks) => {
        this.standardCmfMeshes = buildCmfCollisionMeshes(chunks, false);
      })
      .catch(() => {})
      .finally(() => {
        this.loadingStandardCmf = false;
      });
  }

  private bindStoreSubscription(): void {
    this.unbindStoreSubscription();
    this.unsubStore = subscribeTelestratorStoreSync(this.telestrator, () => {
      this.isDrawingPointerDown = false;
      this.telestrator.cancelDraft();
    });
  }

  private unbindStoreSubscription(): void {
    this.unsubStore?.();
    this.unsubStore = null;
  }

  private getRaycastTargets() {
    return collectTelestratorRaycastTargets(
      this.runtime.arena?.environment,
      this.standardCmfMeshes,
      this.throwbackCmfMeshes
    );
  }

  private restoreDirectionOffset(): void {
    this.runtime.camera?.resetDirectionOffset?.();
    useTelestratorStore.getState().setDirectionOffsetDeg(0, 0);
  }

  private undoLastStroke(): void {
    const st = useTelestratorStore.getState();
    this.telestrator.undoOwnStroke(st.localAuthorId);
    this.syncStrokeStoreState();
  }

  private clearStrokes(): void {
    const st = useTelestratorStore.getState();
    const scope = st.isHost && st.pendingClearPurge ? 'all' : 'own';
    this.telestrator.clearStrokesByScope(scope, st.localAuthorId);
    this.syncStrokeStoreState();
  }

  private syncStrokeStoreState(): void {
    const st = useTelestratorStore.getState();
    useTelestratorStore
      .getState()
      .setStrokeSyncState(
        this.telestrator.getStrokeCount(),
        this.telestrator.hasUndoHistory(st.localAuthorId),
        this.telestrator.isPendingClearPurge()
      );
  }

  private bindInputListeners(): void {
    this.unbindInputListeners();
    if (typeof window === 'undefined') return;

    this.unsubKeyDown = subscribeTelestratorHotkeys(
      () => this.undoLastStroke(),
      () => this.clearStrokes(),
      (authorId) => this.telestrator.hasUndoHistory(authorId)
    );

    window.addEventListener('pointerdown', this.boundPointerDown);
    window.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('pointerup', this.boundPointerUp);
    window.addEventListener('pointercancel', this.boundPointerCancel);
  }

  private unbindInputListeners(): void {
    this.unsubKeyDown?.();
    this.unsubKeyDown = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.boundPointerDown);
      window.removeEventListener('pointermove', this.boundPointerMove);
      window.removeEventListener('pointerup', this.boundPointerUp);
      window.removeEventListener('pointercancel', this.boundPointerCancel);
    }
  }

  public getPointerDiagnostics(): TelestratorPointerDiagDump {
    return this.pointerDiag.getDump();
  }

  public probeScreenPoint(clientX: number, clientY: number) {
    const cam = this.runtime.camera?.camera;
    if (!cam) return { hit: null, diag: null };
    const { ndcX, ndcY } = clientPointToNdc(clientX, clientY);
    const { hit, diag } = raycastScreenToArenaWithDiag(ndcX, ndcY, cam, this.getRaycastTargets());
    this.pointerDiag.record(
      'hover',
      hit ? 'ok' : 'no-hit',
      { clientX, clientY, pointerType: 'probe', pointerId: -1, button: 0 },
      hit,
      diag
    );
    return {
      hit: hit
        ? {
            point: hit.point.toArray(),
            normal: hit.normal.toArray(),
            distance: hit.distance,
          }
        : null,
      diag,
    };
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.isPrimary === false) {
      this.pointerDiag.record('down', 'non-primary-pointer', e);
      return;
    }
    if (this.activePointerId !== null) {
      this.pointerDiag.record('down', 'pointer-already-active', e);
      return;
    }
    if ((e.pointerType === 'mouse' && e.button !== 0) || isTelestratorUiEventTarget(e.target)) {
      this.pointerDiag.record('down', 'blocked-button-or-ui', e);
      return;
    }
    const st = useTelestratorStore.getState();
    if (!st.overlayActive) {
      this.pointerDiag.record('down', 'overlay-inactive', e);
      return;
    }

    if (st.directionAdjustActive && !st.isFreeCam) {
      this.activePointerId = e.pointerId;
      this.isAdjustPointerDown = true;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.pointerDiag.record('down', 'direction-adjust', e);
      return;
    }

    if (!st.drawingEnabled || !canTelestratorDrawNow(st)) {
      this.pointerDiag.record('down', 'drawing-disabled-or-cannot-draw', e);
      return;
    }
    const cam = this.runtime.camera?.camera;
    if (!cam) {
      this.pointerDiag.record('down', 'no-camera', e);
      return;
    }

    if (e.cancelable) e.preventDefault();
    const { ndcX, ndcY } = clientPointToNdc(e.clientX, e.clientY);
    const { hit, diag } = raycastScreenToArenaWithDiag(ndcX, ndcY, cam, this.getRaycastTargets());
    if (!hit) {
      this.pointerDiag.record('down', 'no-hit', e, null, diag);
      return;
    }

    const preset = st.presets[st.activePresetIndex] ?? st.presets[0];
    this.activePointerId = e.pointerId;
    this.isDrawingPointerDown = true;
    this.pendingMove = null;
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
        authorId: st.localAuthorId,
        tool: st.activeTool,
        colorId: st.activeColorId,
        presetIndex: st.activePresetIndex,
        opacity: preset.opacity,
        widthRefPx: preset.widthRefPx,
        arrowLengthRefPx: st.arrowLengthRefPx,
        arrowWidthRefPx: st.arrowWidthRefPx,
      },
      cam
    );
    this.pointerDiag.record('down', 'ok', e, hit, diag);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

    if (this.isAdjustPointerDown) {
      if (e.cancelable) e.preventDefault();
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
    if (e.cancelable) e.preventDefault();
    this.pendingMove = {
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType,
      pointerId: e.pointerId,
      button: e.button,
    };
  }

  private flushPendingMove(): void {
    const move = this.pendingMove;
    if (!move) return;
    this.pendingMove = null;
    if (!this.isDrawingPointerDown) return;
    const cam = this.runtime.camera?.camera;
    if (!cam) return;
    const { ndcX, ndcY } = clientPointToNdc(move.clientX, move.clientY);
    const { hit, diag } = raycastScreenToArenaWithDiag(ndcX, ndcY, cam, this.getRaycastTargets());
    this.pointerDiag.record('move', hit ? 'ok' : 'no-hit', move, hit, diag);
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

  private handlePointerUp(e: PointerEvent): void {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    this.isAdjustPointerDown = false;
    if (!this.isDrawingPointerDown) return;
    this.flushPendingMove();
    this.isDrawingPointerDown = false;
    const committed = this.telestrator.endStroke();
    this.pointerDiag.record('up', committed ? 'committed' : 'too-short', e);
    if (committed) {
      this.lastWireBytes = verifyTelestratorStrokeWire(committed);
      this.syncStrokeStoreState();
    }
  }

  private handlePointerCancel(e: PointerEvent): void {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.pointerDiag.record('cancel', 'pointer-cancelled', e);
    this.activePointerId = null;
    this.pendingMove = null;
    this.isAdjustPointerDown = false;
    if (!this.isDrawingPointerDown) return;
    this.isDrawingPointerDown = false;
    const committed = this.telestrator.endStroke();
    if (committed) {
      this.syncStrokeStoreState();
    }
  }

  public dispose(): void {
    this.deactivate();
    this.telestrator.dispose();
    if (this.standardCmfMeshes) {
      disposeCmfCollisionMeshes(this.standardCmfMeshes);
      this.standardCmfMeshes = null;
    }
    if (this.throwbackCmfMeshes) {
      disposeCmfCollisionMeshes(this.throwbackCmfMeshes);
      this.throwbackCmfMeshes = null;
    }
  }
}
