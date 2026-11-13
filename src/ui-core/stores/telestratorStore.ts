import { create } from 'zustand';
import {
  DEFAULT_TELESTRATOR_ARROW_LENGTH_REF_PX,
  DEFAULT_TELESTRATOR_ARROW_WIDTH_REF_PX,
  DEFAULT_TELESTRATOR_PRESETS,
  type TelestratorBrushPreset,
  type TelestratorBrushTool,
  type TelestratorColorId,
  type TelestratorPresetIndex,
  type TelestratorStrokeDebugDump,
} from '../../entities/telestrator/telestratorTypes';

export interface TelestratorRuntimeHandlers {
  onUndo?: () => void;
  onClear?: () => void;
  onRestoreDirectionOffset?: () => void;
  onActivateOverlay?: () => void;
  onDeactivateOverlay?: () => void;
  onDumpLastStroke?: () => TelestratorStrokeDebugDump | null;
}

export interface TelestratorState {
  overlayActive: boolean;
  drawingEnabled: boolean;
  strokesVisible: boolean;
  directionAdjustActive: boolean;
  isFreeCam: boolean;
  directionOffsetYawDeg: number;
  directionOffsetPitchDeg: number;
  activeTool: TelestratorBrushTool;
  activeColorId: TelestratorColorId;
  activePresetIndex: TelestratorPresetIndex;
  presets: [TelestratorBrushPreset, TelestratorBrushPreset, TelestratorBrushPreset];
  arrowLengthRefPx: number;
  arrowWidthRefPx: number;
  strokeCount: number;
  hasUndoHistory: boolean;
  pendingClearPurge: boolean;
  settingsOpen: boolean;
  isHost: boolean;
  localAuthorId: string;
  isCameraSynced: boolean;
  allowClientDrawing: boolean;
  allowedClientIds: string[];
  lastStrokeSummary: string | null;
  runtimeHandlers: TelestratorRuntimeHandlers;

  setOverlayActive: (active: boolean) => void;
  setDrawingEnabled: (enabled: boolean) => void;
  setStrokesVisible: (visible: boolean) => void;
  setDirectionAdjustActive: (active: boolean) => void;
  setIsFreeCam: (isFreeCam: boolean) => void;
  setDirectionOffsetDeg: (yawDeg: number, pitchDeg: number) => void;
  setActiveTool: (tool: TelestratorBrushTool) => void;
  setActiveColorId: (colorId: TelestratorColorId) => void;
  setActivePresetIndex: (index: TelestratorPresetIndex) => void;
  updatePreset: (
    index: TelestratorPresetIndex,
    patch: Partial<Pick<TelestratorBrushPreset, 'opacity' | 'widthRefPx'>>
  ) => void;
  setArrowSize: (lengthRefPx: number, widthRefPx: number) => void;
  setStrokeSyncState: (
    strokeCount: number,
    hasUndoHistory: boolean,
    pendingClearPurge: boolean
  ) => void;
  setSettingsOpen: (open: boolean) => void;
  setHostRole: (isHost: boolean, localAuthorId?: string) => void;
  setIsCameraSynced: (synced: boolean) => void;
  setAllowClientDrawing: (allow: boolean) => void;
  setClientDrawPermission: (playerId: string, allowed: boolean) => void;
  setAllowedClientIds: (ids: string[]) => void;
  setRuntimeHandlers: (handlers: TelestratorRuntimeHandlers) => void;
  triggerUndo: () => void;
  triggerClear: () => void;
  triggerRestoreDirectionOffset: () => void;
  triggerDumpLastStroke: () => TelestratorStrokeDebugDump | null;
}

export function canLocalDrawInTelestrator(s: TelestratorState): boolean {
  if (!s.strokesVisible) return false;
  if (s.isHost) return true;
  if (!s.isCameraSynced) return false;
  return s.allowClientDrawing || s.allowedClientIds.includes(s.localAuthorId);
}

export const useTelestratorStore = create<TelestratorState>((set, get) => ({
  overlayActive: false,
  drawingEnabled: false,
  strokesVisible: true,
  directionAdjustActive: false,
  isFreeCam: false,
  directionOffsetYawDeg: 0,
  directionOffsetPitchDeg: 0,
  activeTool: 'solid',
  activeColorId: 'yellow',
  activePresetIndex: 0,
  presets: [
    { ...DEFAULT_TELESTRATOR_PRESETS[0] },
    { ...DEFAULT_TELESTRATOR_PRESETS[1] },
    { ...DEFAULT_TELESTRATOR_PRESETS[2] },
  ],
  arrowLengthRefPx: DEFAULT_TELESTRATOR_ARROW_LENGTH_REF_PX,
  arrowWidthRefPx: DEFAULT_TELESTRATOR_ARROW_WIDTH_REF_PX,
  strokeCount: 0,
  hasUndoHistory: false,
  pendingClearPurge: false,
  settingsOpen: false,
  isHost: true,
  localAuthorId: 'local',
  isCameraSynced: true,
  allowClientDrawing: false,
  allowedClientIds: [],
  lastStrokeSummary: null,
  runtimeHandlers: {},

  setOverlayActive: (active) => {
    const next = Boolean(active);
    const prev = get().overlayActive;
    set({
      overlayActive: next,
      drawingEnabled: false,
      directionAdjustActive: false,
      settingsOpen: next ? get().settingsOpen : false,
    });
    if (next && !prev) {
      get().runtimeHandlers.onActivateOverlay?.();
    } else if (!next && prev) {
      get().runtimeHandlers.onDeactivateOverlay?.();
    }
  },

  setDrawingEnabled: (enabled) => {
    const st = get();
    const next = Boolean(enabled) && canLocalDrawInTelestrator(st);
    set({
      drawingEnabled: next,
      directionAdjustActive: next ? false : st.directionAdjustActive,
    });
  },

  setStrokesVisible: (visible) => {
    const next = Boolean(visible);
    set((s) => ({
      strokesVisible: next,
      drawingEnabled: next ? s.drawingEnabled : false,
    }));
  },

  setDirectionAdjustActive: (active) => {
    const next = Boolean(active);
    if (next && get().isFreeCam) return;
    set({
      directionAdjustActive: next,
      drawingEnabled: next ? false : get().drawingEnabled,
    });
  },

  setIsFreeCam: (isFreeCam) => {
    const next = Boolean(isFreeCam);
    if (get().isFreeCam === next) return;
    set({
      isFreeCam: next,
      directionAdjustActive: next ? false : get().directionAdjustActive,
      directionOffsetYawDeg: next ? 0 : get().directionOffsetYawDeg,
      directionOffsetPitchDeg: next ? 0 : get().directionOffsetPitchDeg,
    });
  },

  setDirectionOffsetDeg: (yawDeg, pitchDeg) =>
    set({
      directionOffsetYawDeg: Math.round(yawDeg),
      directionOffsetPitchDeg: Math.round(pitchDeg),
    }),

  setActiveTool: (tool) => set({ activeTool: tool }),
  setActiveColorId: (colorId) => set({ activeColorId: colorId }),
  setActivePresetIndex: (index) => set({ activePresetIndex: index }),

  updatePreset: (index, patch) => {
    const prev = get().presets;
    const next: [TelestratorBrushPreset, TelestratorBrushPreset, TelestratorBrushPreset] = [
      { ...prev[0] },
      { ...prev[1] },
      { ...prev[2] },
    ];
    const target = next[index];
    next[index] = {
      ...target,
      opacity:
        typeof patch.opacity === 'number'
          ? Math.max(0.05, Math.min(1, patch.opacity))
          : target.opacity,
      widthRefPx:
        typeof patch.widthRefPx === 'number'
          ? Math.max(3, Math.min(48, Math.round(patch.widthRefPx)))
          : target.widthRefPx,
    };
    set({ presets: next });
  },

  setArrowSize: (lengthRefPx, widthRefPx) =>
    set({
      arrowLengthRefPx: Math.max(12, Math.min(120, Math.round(lengthRefPx))),
      arrowWidthRefPx: Math.max(10, Math.min(100, Math.round(widthRefPx))),
    }),

  setStrokeSyncState: (strokeCount, hasUndoHistory, pendingClearPurge) =>
    set({
      strokeCount: Math.max(0, strokeCount),
      hasUndoHistory: Boolean(hasUndoHistory),
      pendingClearPurge: Boolean(pendingClearPurge),
    }),

  setSettingsOpen: (open) => set({ settingsOpen: Boolean(open) }),

  setHostRole: (isHost, localAuthorId) =>
    set((s) => {
      const nextState = {
        ...s,
        isHost: Boolean(isHost),
        localAuthorId: localAuthorId ?? s.localAuthorId,
      };
      return {
        isHost: nextState.isHost,
        localAuthorId: nextState.localAuthorId,
        drawingEnabled: canLocalDrawInTelestrator(nextState) ? s.drawingEnabled : false,
      };
    }),

  setIsCameraSynced: (synced) =>
    set((s) => {
      const nextState = { ...s, isCameraSynced: Boolean(synced) };
      return {
        isCameraSynced: nextState.isCameraSynced,
        drawingEnabled: canLocalDrawInTelestrator(nextState) ? s.drawingEnabled : false,
      };
    }),

  setAllowClientDrawing: (allow) =>
    set((s) => {
      const nextState = { ...s, allowClientDrawing: Boolean(allow) };
      return {
        allowClientDrawing: nextState.allowClientDrawing,
        drawingEnabled: canLocalDrawInTelestrator(nextState) ? s.drawingEnabled : false,
      };
    }),

  setClientDrawPermission: (playerId, allowed) =>
    set((s) => {
      const nextIds = new Set(s.allowedClientIds);
      if (allowed) nextIds.add(playerId);
      else nextIds.delete(playerId);
      const allowedClientIds = Array.from(nextIds);
      const nextState = { ...s, allowedClientIds };
      return {
        allowedClientIds,
        drawingEnabled: canLocalDrawInTelestrator(nextState) ? s.drawingEnabled : false,
      };
    }),

  setAllowedClientIds: (ids) =>
    set((s) => {
      const allowedClientIds = Array.from(new Set(ids));
      const nextState = { ...s, allowedClientIds };
      return {
        allowedClientIds,
        drawingEnabled: canLocalDrawInTelestrator(nextState) ? s.drawingEnabled : false,
      };
    }),

  setRuntimeHandlers: (handlers) =>
    set((s) => ({ runtimeHandlers: { ...s.runtimeHandlers, ...handlers } })),

  triggerUndo: () => get().runtimeHandlers.onUndo?.(),
  triggerClear: () => get().runtimeHandlers.onClear?.(),
  triggerRestoreDirectionOffset: () => get().runtimeHandlers.onRestoreDirectionOffset?.(),

  triggerDumpLastStroke: () => {
    const dump = get().runtimeHandlers.onDumpLastStroke?.() ?? null;
    if (!dump) {
      set({ lastStrokeSummary: 'No stroke recorded' });
      return null;
    }
    const summary = `Raw: ${dump.rawPoints.length} -> Simp: ${dump.simplifiedPoints.length} -> Rend: ${dump.renderedPoints.length} | ${dump.wireBytes} B`;
    set({ lastStrokeSummary: summary });
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
    }
    return dump;
  },
}));
