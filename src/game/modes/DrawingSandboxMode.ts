import * as THREE from 'three';
import { BaseGameMode, type GameModeRuntimePort } from './BaseGameMode.ts';
import type { FrameContext } from '../pipeline/FramePipeline.ts';
import { TelestratorManager } from '../../entities/telestrator/TelestratorManager.ts';
import { raycastScreenToArena } from '../../entities/telestrator/arenaSurfaceRaycaster.ts';
import {
  decodeTelestratorHashAck,
  decodeTelestratorStroke,
  encodeTelestratorHashAck,
  encodeTelestratorStroke,
} from '../../network/protocol/TelestratorWireCodec.ts';
import {
  spawnSixKickoffCarsInScene,
  type NameTagTunerRuntimeHost,
} from './freeplay/nameTagTunerPipeline.ts';
import {
  floatingStore,
  globalHudTransientChannel,
  hudStore,
  useAppStore,
  useTelestratorStore,
} from '../runtimeUiPort.ts';
import { isEditableEventTarget, subscribeGlobalKeyDown } from '../../input/hotkeyInputGuard.ts';

export interface DrawingSandboxRuntimePort extends GameModeRuntimePort {
  keyboard?: {
    ballControlEnabled?: boolean;
  } | null;
  modeManager?: {
    setMode?: (mode: string) => void;
  } | null;
  camera?: {
    camera?: THREE.PerspectiveCamera | null;
    freeController?: { shouldSuppressDrag?: (() => boolean) | null } | null;
    setFreeCam: (enabled: boolean) => void;
    setFreeCamPose?: (pos: [number, number, number], target: [number, number, number]) => void;
    setFocusedCarIndex?: (carIndex: number) => void;
    applyDirectionOffsetDelta?: (deltaYaw: number, deltaPitch: number) => void;
    resetDirectionOffset?: () => void;
    getDirectionOffsetDeg?: () => { yawDeg: number; pitchDeg: number };
    cycleCameraView?: (carCount?: number) => { isFreeCam: boolean; focusedCarIndex: number };
  } | null;
  arena?: {
    scene?: THREE.Scene | null;
    focusedCarIndex?: number;
    isFreeCam?: boolean;
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

export class DrawingSandboxMode extends BaseGameMode<DrawingSandboxRuntimePort | null> {
  public readonly telestrator: TelestratorManager = new TelestratorManager();
  private isDrawingPointerDown = false;
  private isAdjustPointerDown = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private unsubKeyDown: (() => void) | null = null;
  private readonly boundPointerDown: (e: PointerEvent) => void;
  private readonly boundPointerMove: (e: PointerEvent) => void;
  private readonly boundPointerUp: () => void;

  constructor(runtime: DrawingSandboxRuntimePort | null) {
    super('drawing-sandbox', runtime);
    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);

    useTelestratorStore.getState().setRuntimeHandlers({
      onStartDrawingSandbox: () => this.activateDrawingSandboxMode(),
    });
  }

  private activateDrawingSandboxMode(): void {
    if (this.runtime?.match?.state) {
      this.runtime.match.state.mode = 'drawing-sandbox';
    }
    useAppStore.getState().setMatchMode?.('drawing-sandbox');
    this.runtime?.modeManager?.setMode?.('drawing-sandbox');
  }

  onEnter(): void {
    const r = this.runtime;
    if (!r) return;

    if (r.match?.state) {
      r.match.state.mode = 'drawing-sandbox';
    }
    useAppStore.getState().setMatchMode?.('drawing-sandbox');

    if (r.arena?.scene) {
      this.telestrator.attachToScene(r.arena.scene);
    }

    if (r.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }

    spawnSixKickoffCarsInScene(r as unknown as NameTagTunerRuntimeHost, 0, {});
    this.syncHudRoster();
    this.selectCameraSlot(7);

    if (r.camera?.freeController) {
      r.camera.freeController.shouldSuppressDrag = () => {
        const st = useTelestratorStore.getState();
        return st.drawingEnabled || st.directionAdjustActive;
      };
    }

    const store = useTelestratorStore.getState();
    store.setDrawingSandboxActive(true);
    store.setDrawingEnabled(true);
    store.setDirectionOffsetDeg(0, 0);
    store.setDropStemsEnabled(store.dropStemsEnabled);
    store.setStrokeCount(this.telestrator.getStrokeCount());
    store.setRuntimeHandlers({
      onUndo: () => this.undoLastStroke(),
      onClear: () => this.clearStrokes(),
      onRestoreDirectionOffset: () => this.restoreDirectionOffset(),
      onSelectCameraSlot: (slot: number) => this.selectCameraSlot(slot),
      onToggleDropStems: (enabled: boolean) => this.telestrator.setDropStemsEnabled(enabled),
      onStartDrawingSandbox: () => this.activateDrawingSandboxMode(),
    });

    this.spawnToolbarWindow();
    this.bindInputListeners();
  }

  onLeave(): void {
    this.unbindInputListeners();
    this.telestrator.dispose();
    const r = this.runtime;
    if (r?.camera?.freeController) {
      r.camera.freeController.shouldSuppressDrag = null;
    }
    r?.camera?.resetDirectionOffset?.();
    r?.camera?.setFocusedCarIndex?.(0);
    const store = useTelestratorStore.getState();
    store.setDrawingSandboxActive(false);
    store.setDirectionOffsetDeg(0, 0);
    store.setStrokeCount(0);
    floatingStore.closeWindow('telestrator-toolbar');
  }

  update(context: FrameContext): void {
    const r = this.runtime;
    if (!r) return;
    r.physics?.step?.(context.dt ?? 1 / 60);
    r.interpolator?.sync?.();
    this.telestrator.updateReplayTick(0);
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
        position: { x: 16, y: 280 },
      });
    }
  }

  private syncHudRoster(): void {
    const leftPlayers = [0, 1, 2].map((i) => ({
      carIndex: i,
      slotKey: i + 1,
      name: `Blue ${i + 1}`,
      team: 0 as const,
      boost: 33,
      exists: true,
    }));
    const rightPlayers = [3, 4, 5].map((i) => ({
      carIndex: i,
      slotKey: i + 1,
      name: `Orange ${i - 2}`,
      team: 1 as const,
      boost: 33,
      exists: true,
    }));
    globalHudTransientChannel.setRoster({
      leftPlayers,
      rightPlayers,
      focusedSlotKey: null,
    });
  }

  private selectCameraSlot(slot: number): void {
    const r = this.runtime;
    if (!r?.camera) return;

    this.restoreDirectionOffset();
    useTelestratorStore.getState().setActiveCameraSlot(slot);

    if (slot >= 1 && slot <= 6) {
      const carIdx = slot - 1;
      r.camera.setFreeCam?.(false);
      r.camera.setFocusedCarIndex?.(carIdx);
      if (r.arena) {
        r.arena.focusedCarIndex = carIdx;
        r.arena.isFreeCam = false;
      }
      hudStore.getState().setCameraFocusState('pov', carIdx);
      globalHudTransientChannel.setRoster({ focusedSlotKey: slot });
      return;
    }

    r.camera.setFreeCam?.(true);
    r.camera.setFreeCamPose?.([0, 1600, -3600], [0, 80, 0]);
    if (r.arena) r.arena.isFreeCam = true;
    hudStore.getState().setCameraFocusState('free', 0);
    globalHudTransientChannel.setRoster({ focusedSlotKey: null });
  }

  private restoreDirectionOffset(): void {
    this.runtime?.camera?.resetDirectionOffset?.();
    useTelestratorStore.getState().setDirectionOffsetDeg(0, 0);
  }

  private undoLastStroke(): void {
    this.telestrator.undoLastStroke();
    useTelestratorStore.getState().setStrokeCount(this.telestrator.getStrokeCount());
  }

  private clearStrokes(): void {
    this.telestrator.clearAll();
    useTelestratorStore.getState().setStrokeCount(0);
  }

  private bindInputListeners(): void {
    this.unbindInputListeners();
    if (typeof window === 'undefined') return;

    this.unsubKeyDown = subscribeGlobalKeyDown((e: KeyboardEvent) => {
      if (isEditableEventTarget(e)) return;

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        e.stopPropagation();
        this.undoLastStroke();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.code >= 'Digit1' && e.code <= 'Digit7') {
        e.preventDefault();
        e.stopPropagation();
        const slot = Number(e.code.replace('Digit', ''));
        this.selectCameraSlot(slot);
        return;
      }

      if (e.code === 'KeyC') {
        e.preventDefault();
        e.stopPropagation();
        const result = this.runtime?.camera?.cycleCameraView?.(6);
        if (result) {
          useTelestratorStore.getState().setDirectionOffsetDeg(0, 0);
          const slot = result.isFreeCam ? 7 : result.focusedCarIndex + 1;
          useTelestratorStore.getState().setActiveCameraSlot(slot);
          globalHudTransientChannel.setRoster({
            focusedSlotKey: result.isFreeCam ? null : slot,
          });
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

  private pointerToNdc(e: PointerEvent): { ndcX: number; ndcY: number; height: number } {
    const w = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
    const h = typeof window !== 'undefined' ? window.innerHeight || 720 : 720;
    return {
      ndcX: (e.clientX / w) * 2 - 1,
      ndcY: -(e.clientY / h) * 2 + 1,
      height: h,
    };
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0 || isUiEventTarget(e.target)) return;
    const st = useTelestratorStore.getState();

    if (st.directionAdjustActive) {
      this.isAdjustPointerDown = true;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      return;
    }

    if (!st.drawingEnabled) return;
    const cam = this.runtime?.camera?.camera;
    if (!cam) return;

    const { ndcX, ndcY, height } = this.pointerToNdc(e);
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
        widthPx: preset.widthPx,
      },
      cam,
      height
    );
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.isAdjustPointerDown) {
      const dx = e.clientX - this.lastPointerX;
      const dy = e.clientY - this.lastPointerY;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.runtime?.camera?.applyDirectionOffsetDelta?.(-dx * 0.004, -dy * 0.004);
      const deg = this.runtime?.camera?.getDirectionOffsetDeg?.();
      if (deg) useTelestratorStore.getState().setDirectionOffsetDeg(deg.yawDeg, deg.pitchDeg);
      return;
    }

    if (!this.isDrawingPointerDown) return;
    const cam = this.runtime?.camera?.camera;
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
      useTelestratorStore.getState().setStrokeCount(this.telestrator.getStrokeCount());
    }
  }
}
