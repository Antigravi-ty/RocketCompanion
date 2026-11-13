import { create } from 'zustand';

export type TelestratorBrushKind = 'solid' | 'dashed' | 'arrow';
export type TelestratorOpacityLevel = 1.0 | 0.7 | 0.5;
export type TelestratorColorKey =
  | 'dark-grey'
  | 'white'
  | 'red'
  | 'yellow'
  | 'bright-green'
  | 'dark-green';

export const TELESTRATOR_COLORS: readonly {
  readonly id: TelestratorColorKey;
  readonly label: string;
  readonly hex: string;
}[] = [
  { id: 'dark-grey', label: 'Dark Grey', hex: '#3f3f46' },
  { id: 'white', label: 'White', hex: '#ffffff' },
  { id: 'red', label: 'Red', hex: '#ef4444' },
  { id: 'yellow', label: 'Yellow', hex: '#facc15' },
  { id: 'bright-green', label: 'Bright Green', hex: '#4ade80' },
  { id: 'dark-green', label: 'Dark Green', hex: '#15803d' },
];

export interface TelestratorPresetConfig {
  readonly id: 1 | 2 | 3;
  readonly label: string;
  widthPx: number;
  brushType: TelestratorBrushKind;
  colorId: TelestratorColorKey;
  opacity: TelestratorOpacityLevel;
}

export interface TelestratorStrokeRecord {
  readonly strokeId: string;
  readonly fnv1aHash: number;
  readonly brushType: TelestratorBrushKind;
  readonly colorHex: string;
  readonly opacity: number;
  readonly widthPx: number;
  readonly points: Float32Array;
  readonly normals: Float32Array;
  readonly pointCount: number;
  readonly tick: number;
}

export interface TelestratorState {
  sandboxActive: boolean;
  drawingActive: boolean;
  directionAdjustActive: boolean;
  activeCameraSlot: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  activePresetId: 1 | 2 | 3;
  brushType: TelestratorBrushKind;
  colorId: TelestratorColorKey;
  opacity: TelestratorOpacityLevel;
  widthPx: number;
  presets: readonly TelestratorPresetConfig[];
  strokes: readonly TelestratorStrokeRecord[];
  restorePovSeq: number;
  enterSandboxSeq: number;

  enterDrawingSandbox: () => void;
  exitDrawingSandbox: () => void;
  setDrawingActive: (active: boolean) => void;
  setDirectionAdjustActive: (active: boolean) => void;
  setActiveCameraSlot: (slot: 1 | 2 | 3 | 4 | 5 | 6 | 7) => void;
  selectPreset: (id: 1 | 2 | 3) => void;
  updatePresetWidth: (id: 1 | 2 | 3, widthPx: number) => void;
  setBrushType: (brushType: TelestratorBrushKind) => void;
  setColorId: (colorId: TelestratorColorKey) => void;
  setOpacity: (opacity: TelestratorOpacityLevel) => void;
  pushStroke: (stroke: TelestratorStrokeRecord) => void;
  undoStroke: () => void;
  clearStrokes: () => void;
  triggerRestorePov: () => void;
}

const INITIAL_PRESETS: readonly TelestratorPresetConfig[] = [
  { id: 1, label: 'P1', widthPx: 6, brushType: 'solid', colorId: 'yellow', opacity: 1.0 },
  { id: 2, label: 'P2', widthPx: 8, brushType: 'arrow', colorId: 'red', opacity: 1.0 },
  { id: 3, label: 'P3', widthPx: 5, brushType: 'dashed', colorId: 'bright-green', opacity: 0.7 },
];

export const telestratorStore = create<TelestratorState>((set) => ({
  sandboxActive: false,
  drawingActive: true,
  directionAdjustActive: false,
  activeCameraSlot: 1,
  activePresetId: 1,
  brushType: 'solid',
  colorId: 'yellow',
  opacity: 1.0,
  widthPx: 6,
  presets: INITIAL_PRESETS,
  strokes: [],
  restorePovSeq: 0,
  enterSandboxSeq: 0,

  enterDrawingSandbox: () =>
    set((s) => ({
      sandboxActive: true,
      drawingActive: true,
      directionAdjustActive: false,
      activeCameraSlot: 1,
      enterSandboxSeq: s.enterSandboxSeq + 1,
    })),

  exitDrawingSandbox: () =>
    set({
      sandboxActive: false,
      drawingActive: false,
      directionAdjustActive: false,
    }),

  setDrawingActive: (active) =>
    set({
      drawingActive: active,
      directionAdjustActive: active ? false : false,
    }),

  setDirectionAdjustActive: (active) =>
    set({
      directionAdjustActive: active,
      drawingActive: active ? false : true,
    }),

  setActiveCameraSlot: (slot) =>
    set((s) => ({
      activeCameraSlot: slot,
      restorePovSeq: slot <= 6 ? s.restorePovSeq + 1 : s.restorePovSeq,
    })),

  selectPreset: (id) =>
    set((s) => {
      const p = s.presets.find((item) => item.id === id) || s.presets[0];
      return {
        activePresetId: id,
        brushType: p.brushType,
        colorId: p.colorId,
        opacity: p.opacity,
        widthPx: p.widthPx,
      };
    }),

  updatePresetWidth: (id, widthPx) =>
    set((s) => {
      const clamped = Math.max(2, Math.min(24, widthPx));
      const nextPresets = s.presets.map((p) => (p.id === id ? { ...p, widthPx: clamped } : p));
      return {
        presets: nextPresets,
        widthPx: s.activePresetId === id ? clamped : s.widthPx,
      };
    }),

  setBrushType: (brushType) => set({ brushType }),
  setColorId: (colorId) => set({ colorId }),
  setOpacity: (opacity) => set({ opacity }),

  pushStroke: (stroke) => set((s) => ({ strokes: [...s.strokes, stroke] })),
  undoStroke: () => set((s) => ({ strokes: s.strokes.slice(0, -1) })),
  clearStrokes: () => set({ strokes: [] }),
  triggerRestorePov: () => set((s) => ({ restorePovSeq: s.restorePovSeq + 1 })),
}));

export function useTelestratorStore<T>(selector: (state: TelestratorState) => T): T {
  return telestratorStore(selector);
}
