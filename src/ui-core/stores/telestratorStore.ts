import { create } from 'zustand';
import {
  DEFAULT_TELESTRATOR_PRESETS,
  type TelestratorBrushPreset,
  type TelestratorBrushTool,
  type TelestratorColorId,
} from '../../entities/telestrator/telestratorTypes';

export type TelestratorPresetIndex = 0 | 1 | 2;

export interface TelestratorRuntimeHandlers {
  onUndo?: () => void;
  onClear?: () => void;
  onRestoreDirectionOffset?: () => void;
  onSelectCameraSlot?: (slot: number) => void;
  onToggleDropStems?: (enabled: boolean) => void;
  onStartDrawingSandbox?: () => void;
}

export interface TelestratorState {
  isDrawingSandboxActive: boolean;
  drawingEnabled: boolean;
  directionAdjustActive: boolean;
  directionOffsetYawDeg: number;
  directionOffsetPitchDeg: number;
  activeTool: TelestratorBrushTool;
  activeColorId: TelestratorColorId;
  activePresetIndex: TelestratorPresetIndex;
  presets: [TelestratorBrushPreset, TelestratorBrushPreset, TelestratorBrushPreset];
  dropStemsEnabled: boolean;
  strokeCount: number;
  activeCameraSlot: number;
  runtimeHandlers: TelestratorRuntimeHandlers;

  setDrawingSandboxActive: (active: boolean) => void;
  setDrawingEnabled: (enabled: boolean) => void;
  setDirectionAdjustActive: (active: boolean) => void;
  setDirectionOffsetDeg: (yawDeg: number, pitchDeg: number) => void;
  setActiveTool: (tool: TelestratorBrushTool) => void;
  setActiveColorId: (colorId: TelestratorColorId) => void;
  setActivePresetIndex: (index: TelestratorPresetIndex) => void;
  updatePreset: (
    index: TelestratorPresetIndex,
    patch: Partial<Pick<TelestratorBrushPreset, 'opacity' | 'widthPx'>>
  ) => void;
  setDropStemsEnabled: (enabled: boolean) => void;
  setStrokeCount: (count: number) => void;
  setActiveCameraSlot: (slot: number) => void;
  setRuntimeHandlers: (handlers: TelestratorRuntimeHandlers) => void;
  triggerUndo: () => void;
  triggerClear: () => void;
  triggerRestoreDirectionOffset: () => void;
  triggerSelectCameraSlot: (slot: number) => void;
}

export const useTelestratorStore = create<TelestratorState>((set, get) => ({
  isDrawingSandboxActive: false,
  drawingEnabled: true,
  directionAdjustActive: false,
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
  dropStemsEnabled: true,
  strokeCount: 0,
  activeCameraSlot: 7,
  runtimeHandlers: {},

  setDrawingSandboxActive: (active) => set({ isDrawingSandboxActive: Boolean(active) }),

  setDrawingEnabled: (enabled) => {
    const next = Boolean(enabled);
    set({
      drawingEnabled: next,
      directionAdjustActive: next ? false : get().directionAdjustActive,
    });
  },

  setDirectionAdjustActive: (active) => {
    const next = Boolean(active);
    set({
      directionAdjustActive: next,
      drawingEnabled: next ? false : true,
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
          ? Math.max(0.1, Math.min(1, patch.opacity))
          : target.opacity,
      widthPx:
        typeof patch.widthPx === 'number'
          ? Math.max(2, Math.min(32, Math.round(patch.widthPx)))
          : target.widthPx,
    };
    set({ presets: next });
  },

  setDropStemsEnabled: (enabled) => {
    const next = Boolean(enabled);
    set({ dropStemsEnabled: next });
    get().runtimeHandlers.onToggleDropStems?.(next);
  },

  setStrokeCount: (count) => set({ strokeCount: Math.max(0, count) }),
  setActiveCameraSlot: (slot) => set({ activeCameraSlot: slot }),
  setRuntimeHandlers: (handlers) =>
    set((s) => ({ runtimeHandlers: { ...s.runtimeHandlers, ...handlers } })),

  triggerUndo: () => get().runtimeHandlers.onUndo?.(),
  triggerClear: () => get().runtimeHandlers.onClear?.(),
  triggerRestoreDirectionOffset: () => get().runtimeHandlers.onRestoreDirectionOffset?.(),
  triggerSelectCameraSlot: (slot) => get().runtimeHandlers.onSelectCameraSlot?.(slot),
}));
