import * as THREE from 'three';
import {
  decodeTelestratorHashAck,
  decodeTelestratorStroke,
  encodeTelestratorHashAck,
  encodeTelestratorStroke,
} from '../../network/protocol/TelestratorWireCodec.ts';
import type { TelestratorManager } from '../../entities/telestrator/TelestratorManager.ts';
import type { TelestratorStroke } from '../../entities/telestrator/telestratorTypes.ts';
import { isEditableEventTarget, subscribeGlobalKeyDown } from '../../input/hotkeyInputGuard.ts';
import { floatingStore, useTelestratorStore } from '../runtimeUiPort.ts';

export function isTelestratorUiEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, a, [role="button"], [role="switch"], [role="slider"], [role="dialog"], [role="tab"], .floating-window, .hud-tools, .hig-dual-card'
    )
  );
}

export function canTelestratorDrawNow(
  st: ReturnType<typeof useTelestratorStore.getState>
): boolean {
  if (!st.strokesVisible) return false;
  if (st.isHost) return true;
  if (!st.isCameraSynced) return false;
  return st.allowClientDrawing || st.allowedClientIds.includes(st.localAuthorId);
}

export function shouldTelestratorTakeOverPointer(): boolean {
  const st = useTelestratorStore.getState();
  if (!st.overlayActive) return false;
  const drawReady = st.drawingEnabled && canTelestratorDrawNow(st);
  return drawReady || st.directionAdjustActive;
}

export function clientPointToNdc(clientX: number, clientY: number): { ndcX: number; ndcY: number } {
  const w = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
  const h = typeof window !== 'undefined' ? window.innerHeight || 720 : 720;
  return {
    ndcX: (clientX / w) * 2 - 1,
    ndcY: -(clientY / h) * 2 + 1,
  };
}

export function verifyTelestratorStrokeWire(committed: TelestratorStroke): number {
  const encoded = encodeTelestratorStroke(committed, false);
  const decoded = decodeTelestratorStroke(encoded);
  const ackBytes = encodeTelestratorHashAck({
    strokeId: committed.id,
    hash: committed.hash,
    matched: decoded?.stroke.hash === committed.hash,
  });
  decodeTelestratorHashAck(ackBytes);
  return encoded.byteLength;
}

export function spawnTelestratorToolbarWindow(): void {
  const snap = floatingStore.getSnapshot();
  const exists = snap.windows.some((w) => w.id === 'telestrator-toolbar');
  if (!exists) {
    floatingStore._bound?.spawnWindow?.({
      id: 'telestrator-toolbar',
      title: 'Telestrator',
      category: 'TelestratorToolbar',
      width: 58,
      minWidth: 52,
      height: 540,
      minHeight: 360,
      hideFooter: true,
      contentPadding: { x: 4, y: 2 },
      component: 'TelestratorToolbarFloatingWindow',
      startMinimized: false,
      position: { x: 16, y: 200 },
    });
  }
}

export class TelestratorBodyTouchLock {
  private applied = false;
  private prevTouchAction = '';
  private prevUserSelect = '';

  public sync(shouldLock: boolean): void {
    if (typeof document === 'undefined' || !document.body) return;
    if (shouldLock && !this.applied) {
      this.prevTouchAction = document.body.style.touchAction;
      this.prevUserSelect = document.body.style.userSelect;
      document.body.style.touchAction = 'none';
      document.body.style.userSelect = 'none';
      this.applied = true;
    } else if (!shouldLock && this.applied) {
      document.body.style.touchAction = this.prevTouchAction;
      document.body.style.userSelect = this.prevUserSelect;
      this.applied = false;
    }
  }
}

export function subscribeTelestratorHotkeys(
  onUndo: () => void,
  onClear: () => void,
  hasUndoHistory: (authorId: string) => boolean
): () => void {
  return subscribeGlobalKeyDown((e: KeyboardEvent) => {
    if (!useTelestratorStore.getState().overlayActive) return;
    if (isEditableEventTarget(e)) return;

    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      e.stopPropagation();
      onUndo();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Delete' || e.code === 'Backspace')) {
      const st = useTelestratorStore.getState();
      if (hasUndoHistory(st.localAuthorId)) {
        e.preventDefault();
        e.stopPropagation();
        onClear();
      }
    }
  }, true);
}

export function subscribeTelestratorStoreSync(
  telestrator: TelestratorManager,
  onHideStrokes: () => void
): () => void {
  let prevPresets = useTelestratorStore.getState().presets;
  let prevArrowLen = useTelestratorStore.getState().arrowLengthRefPx;
  let prevArrowW = useTelestratorStore.getState().arrowWidthRefPx;
  let prevVisible = useTelestratorStore.getState().strokesVisible;

  return useTelestratorStore.subscribe((st) => {
    if (st.strokesVisible !== prevVisible) {
      prevVisible = st.strokesVisible;
      telestrator.setStrokesVisible(st.strokesVisible);
      if (!st.strokesVisible) {
        onHideStrokes();
      }
    }
    if (
      st.presets !== prevPresets ||
      st.arrowLengthRefPx !== prevArrowLen ||
      st.arrowWidthRefPx !== prevArrowW
    ) {
      prevPresets = st.presets;
      prevArrowLen = st.arrowLengthRefPx;
      prevArrowW = st.arrowWidthRefPx;
      telestrator.rebuildStrokesForPresets(st.presets, st.arrowLengthRefPx, st.arrowWidthRefPx);
    }
  });
}

export function collectTelestratorRaycastTargets(
  env:
    | {
        isThrowbackStadiumActive?: boolean;
        driftwoodsStadium?: THREE.Group | null;
        throwbackStadium?: THREE.Group | null;
      }
    | null
    | undefined,
  standardCmfMeshes: THREE.Mesh[] | null,
  throwbackCmfMeshes: THREE.Mesh[] | null
): { cmfTargets: THREE.Object3D[]; stadiumTargets: THREE.Object3D[] } {
  const cmfTargets: THREE.Object3D[] = [];
  const stadiumTargets: THREE.Object3D[] = [];
  const isThrowback = Boolean(env?.isThrowbackStadiumActive);
  const activeCmf = isThrowback ? throwbackCmfMeshes : standardCmfMeshes;
  if (activeCmf && activeCmf.length > 0) {
    for (let i = 0; i < activeCmf.length; i++) cmfTargets.push(activeCmf[i]);
  }
  if (env) {
    const activeStadium = isThrowback ? env.throwbackStadium : env.driftwoodsStadium;
    if (activeStadium && activeStadium.visible) {
      stadiumTargets.push(activeStadium);
    }
  }
  return { cmfTargets, stadiumTargets };
}
