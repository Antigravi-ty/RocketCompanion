export type TelestratorBrushType = 'solid' | 'dashed' | 'arrow';

export type TelestratorOpacityPreset = 1.0 | 0.7 | 0.5;

export type TelestratorColorId =
  'dark-grey' | 'white' | 'red' | 'yellow' | 'bright-green' | 'dark-green';

export const TELESTRATOR_COLOR_PALETTE: Record<
  TelestratorColorId,
  { readonly label: string; readonly hex: string }
> = {
  'dark-grey': { label: 'Dark Grey', hex: '#3f3f46' },
  white: { label: 'White', hex: '#ffffff' },
  red: { label: 'Red', hex: '#ef4444' },
  yellow: { label: 'Yellow', hex: '#facc15' },
  'bright-green': { label: 'Bright Green', hex: '#4ade80' },
  'dark-green': { label: 'Dark Green', hex: '#15803d' },
};

export interface TelestratorBrushPreset {
  readonly id: 1 | 2 | 3;
  readonly label: string;
  widthPx: number;
  brushType: TelestratorBrushType;
  colorId: TelestratorColorId;
  opacity: TelestratorOpacityPreset;
}

export const DEFAULT_TELESTRATOR_PRESETS: readonly TelestratorBrushPreset[] = [
  {
    id: 1,
    label: 'Preset 1',
    widthPx: 6,
    brushType: 'solid',
    colorId: 'yellow',
    opacity: 1.0,
  },
  {
    id: 2,
    label: 'Preset 2',
    widthPx: 8,
    brushType: 'arrow',
    colorId: 'red',
    opacity: 1.0,
  },
  {
    id: 3,
    label: 'Preset 3',
    widthPx: 5,
    brushType: 'dashed',
    colorId: 'bright-green',
    opacity: 0.7,
  },
];

export interface TelestratorStroke {
  readonly strokeId: string;
  readonly fnv1aHash: number;
  readonly brushType: TelestratorBrushType;
  readonly colorHex: string;
  readonly opacity: number;
  readonly widthPx: number;
  readonly points: Float32Array;
  readonly normals: Float32Array;
  readonly pointCount: number;
  readonly tick: number;
}

export function computeFnv1aStrokeHash(
  points: Float32Array,
  pointCount: number,
  brushType: TelestratorBrushType,
  colorHex: string,
  opacity: number,
  widthPx: number
): number {
  let hash = 0x811c9dc5;
  const mixByte = (b: number) => {
    hash ^= b & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const mixStr = (s: string) => {
    for (let i = 0; i < s.length; i++) mixByte(s.charCodeAt(i));
  };
  mixStr(brushType);
  mixStr(colorHex);
  mixByte(Math.round(opacity * 100));
  mixByte(Math.round(widthPx));
  const floats = Math.min(points.length, pointCount * 3);
  for (let i = 0; i < floats; i++) {
    const q = Math.round(points[i]);
    mixByte(q);
    mixByte(q >>> 8);
  }
  return hash >>> 0;
}
