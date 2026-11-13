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
  readonly widthPx: number;
}

export const DEFAULT_TELESTRATOR_PRESETS: readonly [
  TelestratorBrushPreset,
  TelestratorBrushPreset,
  TelestratorBrushPreset,
] = [
  { id: 'preset-100', label: '100%', opacity: 1.0, widthPx: 8 },
  { id: 'preset-70', label: '70%', opacity: 0.7, widthPx: 8 },
  { id: 'preset-50', label: '50%', opacity: 0.5, widthPx: 8 },
];

export interface TelestratorPoint {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

export interface TelestratorStroke {
  id: string;
  authorId: string;
  tool: TelestratorBrushTool;
  colorId: TelestratorColorId;
  opacity: number;
  widthPx: number;
  createdTick: number;
  fadeDurationTicks: number;
  points: TelestratorPoint[];
  hash: number;
}
