export type TelestratorBrushTool = 'solid' | 'dashed' | 'arrow';

export type TelestratorColorId =
  'dark-grey' | 'white' | 'red' | 'yellow' | 'bright-green' | 'dark-green';

export interface TelestratorColorSpec {
  readonly id: TelestratorColorId;
  readonly label: string;
  readonly hex: string;
  readonly numeric: number;
}

export const TELESTRATOR_COLORS: readonly TelestratorColorSpec[] = [
  { id: 'dark-grey', label: 'Dark Grey', hex: '#374151', numeric: 0x374151 },
  { id: 'white', label: 'White', hex: '#f8fafc', numeric: 0xf8fafc },
  { id: 'red', label: 'Red', hex: '#ef4444', numeric: 0xef4444 },
  { id: 'yellow', label: 'Yellow', hex: '#facc15', numeric: 0xfacc15 },
  { id: 'bright-green', label: 'Bright Green', hex: '#4ade80', numeric: 0x4ade80 },
  { id: 'dark-green', label: 'Dark Green', hex: '#15803d', numeric: 0x15803d },
];

export function resolveTelestratorColorNumeric(colorId: TelestratorColorId): number {
  const found = TELESTRATOR_COLORS.find((c) => c.id === colorId);
  return found ? found.numeric : 0xfacc15;
}

export interface TelestratorBrushPreset {
  readonly id: string;
  readonly label: string;
  readonly opacity: number;
  readonly widthRefPx: number;
}

export const TELESTRATOR_REF_VIEWPORT_HEIGHT = 1080;
export const DEFAULT_TELESTRATOR_LINE_WIDTH_REF_PX = 10;
export const DEFAULT_TELESTRATOR_ARROW_LENGTH_REF_PX = 36;
export const DEFAULT_TELESTRATOR_ARROW_WIDTH_REF_PX = 28;

export const DEFAULT_TELESTRATOR_PRESETS: readonly [
  TelestratorBrushPreset,
  TelestratorBrushPreset,
  TelestratorBrushPreset,
] = [
  {
    id: 'preset-100',
    label: '100%',
    opacity: 1.0,
    widthRefPx: DEFAULT_TELESTRATOR_LINE_WIDTH_REF_PX,
  },
  {
    id: 'preset-70',
    label: '70%',
    opacity: 0.7,
    widthRefPx: DEFAULT_TELESTRATOR_LINE_WIDTH_REF_PX,
  },
  {
    id: 'preset-50',
    label: '50%',
    opacity: 0.5,
    widthRefPx: DEFAULT_TELESTRATOR_LINE_WIDTH_REF_PX,
  },
];

export type TelestratorPresetIndex = 0 | 1 | 2;

export interface TelestratorPoint {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

export interface TelestratorVec3 {
  x: number;
  y: number;
  z: number;
}

export interface TelestratorStroke {
  id: string;
  authorId: string;
  strokeSeq: number;
  tool: TelestratorBrushTool;
  colorId: TelestratorColorId;
  presetIndex: TelestratorPresetIndex;
  opacity: number;
  widthRefPx: number;
  arrowLengthRefPx: number;
  arrowWidthRefPx: number;
  camPos: TelestratorVec3;
  camForward: TelestratorVec3;
  camFovDeg: number;
  createdTick: number;
  fadeDurationTicks: number;
  points: TelestratorPoint[];
  hash: number;
}

export interface TelestratorStrokeDebugDump {
  strokeId: string;
  authorId: string;
  strokeSeq: number;
  tool: TelestratorBrushTool;
  presetIndex: TelestratorPresetIndex;
  colorId: TelestratorColorId;
  opacity: number;
  widthRefPx: number;
  arrowLengthRefPx: number;
  arrowWidthRefPx: number;
  rawPoints: TelestratorPoint[];
  simplifiedPoints: TelestratorPoint[];
  renderedPoints: TelestratorPoint[];
  wireBytes: number;
  hash: number;
  camPos: TelestratorVec3;
  camForward: TelestratorVec3;
  camFovDeg: number;
  pointerDiagnostics?: import('./telestratorPointerDiag.ts').TelestratorPointerDiagDump;
}
